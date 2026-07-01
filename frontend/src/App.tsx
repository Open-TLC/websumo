import { useCallback, useEffect, useRef, useState } from 'react'
import { Controls } from './Controls'
import { MapView, type MapViewHandle } from './MapView'
import { SimSocket } from './ws'

type SimState = 'idle' | 'running' | 'paused' | 'ended'

export default function App() {
  const [scenarios, setScenarios] = useState<string[]>([])
  const [scenario, setScenario] = useState('')
  const [networkGeoJSON, setNetworkGeoJSON] = useState<GeoJSON.FeatureCollection | null>(null)
  const [simState, setSimState] = useState<SimState>('idle')
  const [simTime, setSimTime] = useState(0)
  const [speed, setSpeed] = useState(1.0)
  const [basemap, setBasemap] = useState(false)

  const mapRef = useRef<MapViewHandle>(null)
  const socketRef = useRef<SimSocket>(new SimSocket())
  const sessionIdRef = useRef<string | null>(null)

  // Fetch scenario list on mount
  useEffect(() => {
    fetch('/api/scenarios')
      .then((r) => r.json())
      .then((list: string[]) => {
        setScenarios(list)
        if (list.length > 0) setScenario(list[0])
      })
      .catch(console.error)
  }, [])

  const handleLoad = useCallback(() => {
    if (!scenario) return
    fetch(`/api/network/${encodeURIComponent(scenario)}`)
      .then((r) => r.json())
      .then((gj: GeoJSON.FeatureCollection) => {
        setNetworkGeoJSON(gj)
        mapRef.current?.fitNetwork(gj)
      })
      .catch(console.error)
  }, [scenario])

  const handleStart = useCallback(async () => {
    if (!scenario) return
    try {
      const res = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario }),
      })
      if (!res.ok) {
        const err = await res.json()
        alert(err.detail ?? 'Failed to start session')
        return
      }
      const { session_id } = await res.json()
      sessionIdRef.current = session_id

      const sock = socketRef.current
      sock.onStep = (vehicles, tls, t) => {
        setSimTime(t)
        mapRef.current?.updateStep(vehicles, tls, t)
      }
      sock.onEnd = () => {
        setSimState('ended')
        sock.close()
      }
      sock.connect(session_id)
      setSimState('running')
      setSimTime(0)
    } catch (e) {
      console.error(e)
    }
  }, [scenario])

  const handlePause = useCallback(() => {
    socketRef.current.send({ cmd: 'pause' })
    setSimState('paused')
  }, [])

  const handleResume = useCallback(() => {
    socketRef.current.send({ cmd: 'resume' })
    setSimState('running')
  }, [])

  const handleStop = useCallback(async () => {
    socketRef.current.send({ cmd: 'stop' })
    socketRef.current.close()
    await fetch('/api/session/stop', { method: 'POST' }).catch(() => {})
    setSimState('idle')
    setSimTime(0)
    mapRef.current?.updateStep([], {}, 0)
  }, [])

  const handleReset = useCallback(async () => {
    socketRef.current.close()
    await fetch('/api/session/stop', { method: 'POST' }).catch(() => {})
    setSimState('idle')
    setSimTime(0)
    mapRef.current?.updateStep([], {}, 0)
  }, [])

  const handleSpeedChange = useCallback((v: number) => {
    setSpeed(v)
    socketRef.current.send({ cmd: 'speed', v })
  }, [])

  const handleBasemapToggle = useCallback(() => {
    const next = !basemap
    setBasemap(next)
    mapRef.current?.setBasemap(next)
  }, [basemap])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <MapView ref={mapRef} networkGeoJSON={networkGeoJSON} />
      <Controls
        scenarios={scenarios}
        scenario={scenario}
        simState={simState}
        simTime={simTime}
        speed={speed}
        basemap={basemap}
        onScenarioChange={setScenario}
        onLoad={handleLoad}
        onStart={handleStart}
        onPause={handlePause}
        onResume={handleResume}
        onStop={handleStop}
        onReset={handleReset}
        onSpeedChange={handleSpeedChange}
        onBasemapToggle={handleBasemapToggle}
      />
    </div>
  )
}
