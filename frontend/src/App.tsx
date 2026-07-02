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
  const [trafficScale, setTrafficScale] = useState(1.0)
  const [duration, setDuration] = useState(3600)
  const [basemap, setBasemap] = useState(false)

  const mapRef    = useRef<MapViewHandle>(null)
  const sockRef   = useRef<SimSocket>(new SimSocket())

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
      const res = await fetch('/api/adapter/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario, end: duration }),
      })
      if (!res.ok) {
        const err = await res.json()
        alert(err.detail ?? 'Failed to start adapter')
        return
      }

      const sock = sockRef.current
      sock.onStep = (vehicles, tls, detectors, t) => {
        setSimTime(t)
        mapRef.current?.updateStep(vehicles, tls, detectors, t)
      }
      sock.onEnd = () => {
        setSimState('ended')
        sock.close()
      }
      sock.connect(scenario)

      setSimState('running')
      setSimTime(0)
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

  const handleStop = useCallback(async () => {
    sockRef.current.send('stop')
    sockRef.current.close()
    await fetch('/api/adapter/stop', { method: 'POST' }).catch(() => {})
    setSimState('idle')
    setSimTime(0)
    setSpeed(1.0)
    setTrafficScale(1.0)
    mapRef.current?.updateStep([], {}, {}, 0)
  }, [])

  const handleReset = useCallback(async () => {
    sockRef.current.close()
    await fetch('/api/adapter/stop', { method: 'POST' }).catch(() => {})
    setSimState('idle')
    setSimTime(0)
    setSpeed(1.0)
    setTrafficScale(1.0)
    mapRef.current?.updateStep([], {}, {}, 0)
  }, [])

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
        duration={duration}
        basemap={basemap}
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
      />
    </div>
  )
}
