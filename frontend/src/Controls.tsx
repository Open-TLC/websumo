interface Props {
  scenarios: string[]
  scenario: string
  simState: 'idle' | 'running' | 'paused' | 'ended'
  simTime: number
  speed: number
  basemap: boolean
  onScenarioChange: (s: string) => void
  onLoad: () => void
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onReset: () => void
  onSpeedChange: (v: number) => void
  onBasemapToggle: () => void
}

const btn = (label: string, onClick: () => void, disabled = false, accent = false) => (
  <button
    onClick={onClick}
    disabled={disabled}
    style={{
      padding: '6px 14px',
      border: 'none',
      borderRadius: 4,
      cursor: disabled ? 'default' : 'pointer',
      background: accent ? '#6060c0' : '#2a2a4a',
      color: disabled ? '#666' : '#dde',
      fontWeight: accent ? 600 : 400,
    }}
  >
    {label}
  </button>
)

export function Controls({
  scenarios, scenario, simState, simTime, speed, basemap,
  onScenarioChange, onLoad, onStart, onPause, onResume, onStop, onReset, onSpeedChange, onBasemapToggle,
}: Props) {
  const idle = simState === 'idle'
  const running = simState === 'running'
  const paused = simState === 'paused'
  const ended = simState === 'ended'
  const active = running || paused

  const mm = Math.floor(simTime / 60).toString().padStart(2, '0')
  const ss = Math.floor(simTime % 60).toString().padStart(2, '0')

  return (
    <div style={{
      position: 'absolute', top: 12, left: 12, zIndex: 10,
      background: 'rgba(10,10,28,0.97)', borderRadius: 8, padding: '12px 16px',
      display: 'flex', flexDirection: 'column', gap: 10, minWidth: 260,
      border: '1px solid #5a5aaa', backdropFilter: 'blur(4px)',
      boxShadow: '0 2px 16px rgba(0,0,0,0.8)',
    }}>
      {/* Title + basemap toggle */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#aac', letterSpacing: 1 }}>
          WebSUMO
        </div>
        <button
          onClick={onBasemapToggle}
          title="Toggle OSM basemap"
          style={{
            padding: '3px 10px', border: `1px solid ${basemap ? '#5a8aff' : '#3a3a6a'}`,
            borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
            background: basemap ? '#1a2a4a' : '#1a1a30',
            color: basemap ? '#8ab4ff' : '#667',
          }}
        >
          {basemap ? 'OSM' : 'BLK'}
        </button>
      </div>

      {/* Scenario selector */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select
          value={scenario}
          onChange={(e) => onScenarioChange(e.target.value)}
          disabled={active}
          style={{
            flex: 1, padding: '5px 8px', borderRadius: 4,
            background: '#1a1a30', border: '1px solid #3a3a6a', color: '#dde',
          }}
        >
          {scenarios.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        {btn('Load', onLoad, active || !scenario)}
      </div>

      {/* Playback controls */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {btn('▶ Start', onStart, !idle && !ended, true)}
        {running && btn('⏸ Pause', onPause)}
        {paused && btn('▶ Resume', onResume)}
        {active && btn('■ Stop', onStop)}
        {!idle && btn('↺ Reset', onReset)}
      </div>

      {/* Speed */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: '#99a', width: 42 }}>
          {speed.toFixed(1)}×
        </span>
        <input
          type="range" min={0.1} max={10} step={0.1}
          value={speed}
          onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
          disabled={!active}
          style={{ flex: 1 }}
        />
      </div>

      {/* Sim time */}
      <div style={{ fontSize: 13, color: '#99b', fontVariantNumeric: 'tabular-nums' }}>
        {active || ended
          ? `T = ${mm}:${ss} (${simTime.toFixed(1)} s)`
          : 'Not running'}
      </div>
    </div>
  )
}
