import { useCallback, useEffect, useRef, useState } from 'react'
import { Controls } from './Controls'
import { InspectorPanel, type Selected } from './InspectorPanel'
import { LogPanel, type LogEntry } from './LogPanel'
import { MapView, type MapViewHandle } from './MapView'
import { OCPanel } from './OCPanel'
import { SimSocket, type InspectBlock, type FcdGraph, type Ldm, type OcJoin } from './ws'

type SimState = 'idle' | 'running' | 'paused' | 'ended'

export default function App() {
  const [scenarios, setScenarios] = useState<string[]>([])
  const [scenario, setScenario] = useState('')
  const [networkGeoJSON, setNetworkGeoJSON] = useState<GeoJSON.FeatureCollection | null>(null)
  const [simState, setSimState] = useState<SimState>('idle')
  const [simTime, setSimTime] = useState(0)
  const [speed, setSpeed] = useState(1)          // ×-real-time (RT-aligned)
  const [maxRate, setMaxRate] = useState<number | null>(null)  // machine ceiling ×RT
  const [trafficScale, setTrafficScale] = useState(1.0)
  const [duration, setDuration] = useState(28800)   // default 8 h
  const [basemap, setBasemap] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [logUnread, setLogUnread] = useState(0)
  const [logEntries, setLogEntries] = useState<LogEntry[]>([])
  const [startupLines, setStartupLines] = useState<string[]>([])
  const [selected, setSelected] = useState<Selected | null>(null)
  const [inspectLive, setInspectLive] = useState<InspectBlock | null>(null)
  const [fcdGraph, setFcdGraph] = useState<FcdGraph | null>(null)  // V2X: selected car's ego graph
  const [ldm, setLdm] = useState<Ldm | null>(null)                 // V2X: fused shared LDM
  const [ldmOn, setLdmOn] = useState(false)                        // V2X: LDM overlay toggle
  const [genVtypes, setGenVtypes] = useState<string[]>([])   // vTypes offered by the loaded network
  const [genVtype, setGenVtype] = useState('')               // currently selected injection vType
  const [ocJoin, setOcJoin] = useState<OcJoin | null>(null)  // OC display mode: group↔link join
  const [ocGroups, setOcGroups] = useState<Record<string, string>>({})  // "<key>.<sigIdx>" → substate

  const mapRef    = useRef<MapViewHandle>(null)
  const sockRef   = useRef<SimSocket>(new SimSocket())
  const logOpenRef = useRef(false)
  logOpenRef.current = logOpen
  const selectedRef = useRef<Selected | null>(null)
  selectedRef.current = selected
  const genVtypeRef = useRef('')
  genVtypeRef.current = genVtype
  const simStateRef = useRef<SimState>('idle')
  simStateRef.current = simState
  // speed/traffic can be tuned before Start; read at Start and applied from t=0
  const speedRef = useRef(1.0)
  speedRef.current = speed
  const trafficScaleRef = useRef(1.0)
  trafficScaleRef.current = trafficScale
  // a select sent right after Start can beat the adapter's NATS subscription
  // and be dropped — re-send once the first state message proves it's up
  const resendSelectRef = useRef(false)
  // OC display mode: accumulate per-signal-index substates across frames
  const ocGroupsRef = useRef<Record<string, string>>({})

  useEffect(() => {
    fetch('/api/scenarios')
      .then((r) => r.json())
      .then((list: string[]) => {
        setScenarios(list)
        // default to fi.helsinki.269 when present, else the first scenario
        if (list.length > 0) setScenario(list.find((s) => s.includes('269')) ?? list[0])
      })
      .catch(console.error)
  }, [])

  // OC display mode: fetch the group↔link join once. `enabled:false` (OC mode
  // off) leaves everything null and the OC overlay/panel simply don't render.
  useEffect(() => {
    fetch('/api/oc/join')
      .then((r) => r.json())
      .then((j: OcJoin) => {
        if (j.enabled) {
          setOcJoin(j)
          mapRef.current?.setOcJoin(j)
        }
      })
      .catch(() => {})
  }, [])

  const handleLoad = useCallback(() => {
    if (!scenario) return
    fetch(`/api/network/${encodeURIComponent(scenario)}`)
      .then((r) => r.json())
      .then((gj: GeoJSON.FeatureCollection) => {
        setNetworkGeoJSON(gj)
        setSpeed(1)
        setTrafficScale(1.0)
        // vType options for the generator selector = union of all generator markers
        const vts = Array.from(new Set(
          gj.features
            .filter((f) => f.properties?.type === 'generator')
            .flatMap((f) => (f.properties!.vtypes as string[]) ?? [])
        )).sort()
        setGenVtypes(vts)
        setGenVtype((cur) => (cur && vts.includes(cur) ? cur : vts[0] ?? ''))
        mapRef.current?.fitNetwork(gj)
      })
      .catch(console.error)
  }, [scenario])

  const handleGenerate = useCallback((edge: string, lane: number, vtypes: string[]) => {
    // spawning needs a running adapter; ignore clicks while idle/ended
    if (simStateRef.current !== 'running' && simStateRef.current !== 'paused') return
    // inject the selected vType if this lane accepts it, else its first accepted one
    const vtype = vtypes.includes(genVtypeRef.current) ? genVtypeRef.current : vtypes[0]
    if (vtype) sockRef.current.send('spawn', { edge, lane, vtype })
  }, [])

  const handleStart = useCallback(async () => {
    if (!scenario) return
    try {
      const res = await fetch('/api/adapter/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // pass the pre-Start slider values so the adapter applies them from t=0
        body: JSON.stringify({ scenario, end: duration, scale: trafficScaleRef.current, speed: speedRef.current }),
      })
      if (!res.ok) {
        const err = await res.json()
        alert(err.detail ?? 'Failed to start adapter')
        return
      }

      const sock = sockRef.current
      sock.onStep = (vehicles, tls, detectors, persons, t, mr) => {
        setSimTime(t)
        if (mr != null) setMaxRate(mr)
        mapRef.current?.updateStep(vehicles, tls, detectors, persons, t)
        if (resendSelectRef.current) {
          resendSelectRef.current = false
          const sel = selectedRef.current
          if (sel) sock.send('select', { kind: sel.kind, id: sel.id, client: 'web' })
        }
      }
      sock.onEnd = () => {
        setSimState('ended')
        sock.close()
      }
      sock.onLog = (t, events) => {
        setLogEntries((prev) => [...prev, ...events.map((e) => ({ t, ...e }))].slice(-500))
        if (!logOpenRef.current) setLogUnread((u) => u + events.length)
      }
      sock.onInspect = (block) => setInspectLive(block)
      sock.onFcd = (graph) => {
        // keep only the currently-selected floating car's graph (avoids re-render spam)
        const vid = String(graph['@id'] ?? '').replace(/^veh:/, '')
        if (selectedRef.current?.kind === 'vehicle' && selectedRef.current.id === vid) {
          setFcdGraph(graph)
          mapRef.current?.setFcd(graph)   // draw its links on the map
        }
      }
      sock.onLdm = (l) => {
        setLdm(l)                 // for the stats chip
        mapRef.current?.setLdm(l) // for the map overlay
      }
      // OC display mode: accumulate per-signal-index substate; push a fresh
      // object each time so both the panel (state) and the map (deck triggers)
      // see a new identity.
      sock.onOcGroup = (key, sigIdx, sub) => {
        ocGroupsRef.current = { ...ocGroupsRef.current, [`${key}.${sigIdx}`]: sub }
        setOcGroups(ocGroupsRef.current)
        mapRef.current?.setOcGroups(ocGroupsRef.current)
      }
      sock.connect(scenario)

      setSimState('running')
      setSimTime(0)
      setMaxRate(null)
      setLogEntries([])
      setLogUnread(0)
      setStartupLines([])
      setInspectLive(null)
      // vehicles are per-run; a TLS selection stays valid across runs
      setSelected((sel) => {
        if (sel?.kind === 'vehicle') {
          mapRef.current?.setFcd(null)
          mapRef.current?.setSelected(null, null)
          return null
        }
        if (sel) resendSelectRef.current = true
        return sel
      })
    } catch (e) {
      console.error(e)
      alert(`Failed to start: ${e}`)
    }
  }, [scenario, duration])

  const handlePause = useCallback(() => {
    sockRef.current.send('pause')
    setSimState('paused')
  }, [])

  const handleResume = useCallback(() => {
    sockRef.current.send('resume')
    setSimState('running')
  }, [])

  const clearSelection = useCallback(() => {
    setSelected((sel) => {
      if (sel?.kind === 'vehicle') {
        mapRef.current?.setSelected(null, null)
        return null
      }
      return sel   // TLS selection survives; live section goes static
    })
    setInspectLive(null)
  }, [])

  const handleStop = useCallback(async () => {
    sockRef.current.send('stop')
    sockRef.current.close()
    await fetch('/api/adapter/stop', { method: 'POST' }).catch(() => {})
    setSimState('idle')
    setSimTime(0)
    setSpeed(1)
    setTrafficScale(1.0)
    setMaxRate(null)
    mapRef.current?.updateStep([], {}, {}, [], 0)
    setLdm(null)
    mapRef.current?.setLdm(null)
    clearSelection()
  }, [clearSelection])

  const handleReset = useCallback(async () => {
    sockRef.current.close()
    await fetch('/api/adapter/stop', { method: 'POST' }).catch(() => {})
    setSimState('idle')
    setSimTime(0)
    setSpeed(1)
    setTrafficScale(1.0)
    setMaxRate(null)
    mapRef.current?.updateStep([], {}, {}, [], 0)
    setLdm(null)
    mapRef.current?.setLdm(null)
    clearSelection()
  }, [clearSelection])

  const handleSpeedChange = useCallback((v: number) => {
    setSpeed(v)
    sockRef.current.send('speed', { v })
  }, [])

  const handleTrafficScaleChange = useCallback((v: number) => {
    setTrafficScale(v)
    sockRef.current.send('scale', { v })
  }, [])

  const handleBasemapToggle = useCallback(() => {
    const next = !basemap
    setBasemap(next)
    mapRef.current?.setBasemap(next)
  }, [basemap])

  const handleLdmToggle = useCallback(() => {
    setLdmOn((on) => {
      const next = !on
      mapRef.current?.setLdmOn(next)
      return next
    })
  }, [])

  const handleDeselect = useCallback(() => {
    setSelected(null)
    setInspectLive(null)
    setFcdGraph(null)
    mapRef.current?.setFcd(null)
    mapRef.current?.setSelected(null, null)
    sockRef.current.send('select', {})
  }, [])

  const handlePick = useCallback((kind: 'vehicle' | 'tls', id: string, props: Record<string, unknown>) => {
    const sel: Selected = { kind, id }
    if (kind === 'tls' && typeof props.tls_programs === 'string') {
      try { sel.tlsPrograms = JSON.parse(props.tls_programs) } catch { /* ignore */ }
    }
    setSelected(sel)
    setInspectLive(null)
    setFcdGraph(null)          // cleared until this car's ego graph arrives
    mapRef.current?.setFcd(null)
    setLogOpen(false)          // inspector and log share the right side
    mapRef.current?.setSelected(kind, id)
    sockRef.current.send('select', { kind, id, client: 'web' })
  }, [])

  const handleToggleLog = useCallback(() => {
    setLogOpen((open) => {
      if (!open) handleDeselect()   // inspector and log share the right side
      return !open
    })
    setLogUnread(0)
  }, [handleDeselect])

  // keep the stderr tail fresh while the panel is open — the log file is
  // (re)written outside the UI's control (Load check, adapter start), so
  // polling is the only reliable way to reflect it
  useEffect(() => {
    if (!logOpen || !scenario) return
    const fetchLines = () => {
      fetch(`/api/adapter/log/${encodeURIComponent(scenario)}`)
        .then((r) => r.json())
        .then((d: { lines: string[] }) => setStartupLines(d.lines ?? []))
        .catch(() => {})
    }
    fetchLines()
    const id = setInterval(fetchLines, 3000)
    return () => clearInterval(id)
  }, [logOpen, scenario])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <MapView
        ref={mapRef}
        networkGeoJSON={networkGeoJSON}
        onPick={handlePick}
        onPickAway={handleDeselect}
        onGenerate={handleGenerate}
      />
      <Controls
        scenarios={scenarios}
        scenario={scenario}
        simState={simState}
        simTime={simTime}
        speed={speed}
        maxRate={maxRate}
        trafficScale={trafficScale}
        duration={duration}
        basemap={basemap}
        ldmOn={ldmOn}
        logUnread={logUnread}
        genVtypes={genVtypes}
        genVtype={genVtype}
        onGenVtypeChange={setGenVtype}
        onToggleLog={handleToggleLog}
        onScenarioChange={setScenario}
        onDurationChange={setDuration}
        onLoad={handleLoad}
        onStart={handleStart}
        onPause={handlePause}
        onResume={handleResume}
        onStop={handleStop}
        onReset={handleReset}
        onSpeedChange={handleSpeedChange}
        onTrafficScaleChange={handleTrafficScaleChange}
        onBasemapToggle={handleBasemapToggle}
        onLdmToggle={handleLdmToggle}
      />
      <LogPanel
        open={logOpen}
        startupLines={startupLines}
        entries={logEntries}
        onClose={handleToggleLog}
      />
      {selected && !logOpen && (
        <InspectorPanel
          selected={selected}
          live={inspectLive}
          fcdGraph={fcdGraph}
          simTime={simTime}
          simActive={simState === 'running' || simState === 'paused'}
          onClose={handleDeselect}
        />
      )}
      {ocJoin?.enabled && <OCPanel join={ocJoin} groups={ocGroups} />}
      {ldmOn && ldm && (
        <div style={{
          position: 'absolute', bottom: 12, left: 12, zIndex: 15,
          background: 'rgba(10,10,28,0.92)', border: '1px solid #2a2a4a',
          borderRadius: 6, padding: '8px 12px', fontSize: 11, color: '#9db4d0',
          fontFamily: 'ui-monospace, monospace', lineHeight: 1.6,
        }}>
          <div style={{ color: '#8ab4ff', fontWeight: 700, letterSpacing: 1, marginBottom: 2 }}>
            SHARED LDM {selected?.kind === 'vehicle' ? '· probe view' : '· coverage'}
          </div>
          <div>{ldm.observers.length} connected {ldm.observers.length === 1 ? 'car' : 'cars'} · {ldm.objects.length} perceived · {ldm.objects.filter((o) => o.confirmed).length} confirmed</div>
          <div style={{ color: '#667', marginTop: 2 }}>
            {selected?.kind === 'vehicle'
              ? '◉ cyan = this car sees · ◉ magenta = only others see'
              : '◉ green = confirmed (≥2) · ◉ amber = single-source'}
          </div>
        </div>
      )}
    </div>
  )
}
