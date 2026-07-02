import { useCallback, useEffect, useRef, useState } from 'react'
import { Controls } from './Controls'
import { MapView, type MapViewHandle } from './MapView'
import { SimNats } from './ws'

type SimState = 'idle' | 'running' | 'paused' | 'ended'

export default function App() {
  const [scenarios, setScenarios] = useState<string[]>([])
  const [scenario, setScenario] = useState('')
  const [networkGeoJSON, setNetworkGeoJSON] = useState<GeoJSON.FeatureCollection | null>(null)
  const [simState, setSimState] = useState<SimState>('idle')
  const [simTime, setSimTime] = useState(0)
  const [speed, setSpeed] = useState(1.0)
  const [trafficScale, setTrafficScale] = useState(1.0)
  const [basemap, setBasemap] = useState(false)

  const mapRef    = useRef<MapViewHandle>(null)
  const natsRef   = useRef<SimNats>(new SimNats())

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
        setSpeed(1.0)
        setTrafficScale(1.0)
        mapRef.current?.fitNetwork(gj)
      })
      .catch(console.error)
  }, [scenario])

  const handleStart = useCallback(async () => {
    if (!scenario) return
    try {
      // start the libsumo adapter process via FastAPI
      const res = await fetch('/api/adapter/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario }),
      })
      if (!res.ok) {
        const err = await res.json()
        alert(err.detail ?? 'Failed to start adapter')
        return
      }

      // connect browser directly to NATS via WebSocket
      const nats = natsRef.current
      nats.onStep = (vehicles, tls, t) => {
        setSimTime(t)
        mapRef.current?.updateStep(vehicles, tls, t)
      }
      nats.onEnd = () => {
        setSimState('ended')
        nats.close()
      }
      await nats.connect(scenario)

      setSimState('running')
      setSimTime(0)
    } catch (e) {
      console.error(e)
    }
  }, [scenario])

  const handlePause = useCallback(() => {
    natsRef.current.publish('pause')
    setSimState('paused')
  }, [])

  const handleResume = useCallback(() => {
    natsRef.current.publish('resume')
    setSimState('running')
  }, [])

  const handleStop = useCallback(async () => {
    natsRef.current.publish('stop')
    await natsRef.current.close()
    await fetch('/api/adapter/stop', { method: 'POST' }).catch(() => {})
    setSimState('idle')
    setSimTime(0)
    setSpeed(1.0)
    setTrafficScale(1.0)
    mapRef.current?.updateStep([], {}, 0)
  }, [])

  const handleReset = useCallback(async () => {
    await natsRef.current.close()
    await fetch('/api/adapter/stop', { method: 'POST' }).catch(() => {})
    setSimState('idle')
    setSimTime(0)
    setSpeed(1.0)
    setTrafficScale(1.0)
    mapRef.current?.updateStep([], {}, 0)
  }, [])

  const handleSpeedChange = useCallback((v: number) => {
    setSpeed(v)
    natsRef.current.publish('speed', { v })
  }, [])

  const handleTrafficScaleChange = useCallback((v: number) => {
    setTrafficScale(v)
    natsRef.current.publish('scale', { v })
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
        trafficScale={trafficScale}
        basemap={basemap}
        onScenarioChange={setScenario}
        onLoad={handleLoad}
        onStart={handleStart}
        onPause={handlePause}
        onResume={handleResume}
        onStop={handleStop}
        onReset={handleReset}
        onSpeedChange={handleSpeedChange}
        onTrafficScaleChange={handleTrafficScaleChange}
        onBasemapToggle={handleBasemapToggle}
      />
    </div>
  )
}
