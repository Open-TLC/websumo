interface Props {
  scenarios: string[]
  scenario: string
  simState: 'idle' | 'running' | 'paused' | 'ended'
  simTime: number
  speed: number
  maxRate: number | null   // machine's achievable ×RT ceiling, or null when idle
  trafficScale: number
  duration: number
  basemap: boolean
  ldmOn: boolean
  pedsOn: boolean
  logUnread: number
  genVtypes: string[]
  genVtype: string
  onGenVtypeChange: (v: string) => void
  onToggleLog: () => void
  onScenarioChange: (s: string) => void
  onDurationChange: (d: number) => void
  onLoad: () => void
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onReset: () => void
  onSpeedChange: (v: number) => void
  onTrafficScaleChange: (v: number) => void
  onBasemapToggle: () => void
  onLdmToggle: () => void
  onPedsToggle: () => void
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

// Speed slider is logarithmic over ×-real-time: 1× (real time) up to a high
// aspirational max — the machine's true ceiling is enforced by the red clamp.
const SPD_MIN = 1
const SPD_MAX = 500
const posToSpeed = (p: number) => SPD_MIN * Math.pow(SPD_MAX / SPD_MIN, p / 1000)
const speedToPos = (s: number) =>
  1000 * Math.log(Math.max(SPD_MIN, s) / SPD_MIN) / Math.log(SPD_MAX / SPD_MIN)
const fmtSpeed = (s: number) => (s < 10 ? s.toFixed(1) : Math.round(s).toString())

const DURATIONS = [
  { label: '1 h',  value: 3600 },
  { label: '4 h',  value: 14400 },
  { label: '8 h',  value: 28800 },
  { label: '24 h', value: 86400 },
]

export function Controls({
  scenarios, scenario, simState, simTime, speed, maxRate, trafficScale, duration, basemap, ldmOn, pedsOn,
  logUnread, genVtypes, genVtype, onGenVtypeChange, onToggleLog,
  onScenarioChange, onDurationChange, onLoad, onStart, onPause, onResume, onStop, onReset,
  onSpeedChange, onTrafficScaleChange, onBasemapToggle, onLdmToggle, onPedsToggle,
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
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={onToggleLog}
            title="Simulation log"
            style={{
              position: 'relative',
              padding: '3px 10px', border: `1px solid ${logUnread > 0 ? '#ffb056' : '#3a3a6a'}`,
              borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
              background: '#1a1a30',
              color: logUnread > 0 ? '#ffb056' : '#667',
            }}
          >
            LOG
            {logUnread > 0 && (
              <span style={{
                position: 'absolute', top: -7, right: -7,
                background: '#c04040', color: '#fff', borderRadius: 8,
                fontSize: 9, fontWeight: 700, padding: '1px 5px', minWidth: 8,
              }}>
                {logUnread > 99 ? '99+' : logUnread}
              </span>
            )}
          </button>
          <button
            onClick={onLdmToggle}
            title="V2X shared Local Dynamic Map — perception overlay"
            style={{
              padding: '3px 10px', border: `1px solid ${ldmOn ? '#40c05a' : '#3a3a6a'}`,
              borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
              background: ldmOn ? '#12301a' : '#1a1a30',
              color: ldmOn ? '#5ad07a' : '#667',
            }}
          >
            LDM
          </button>
          <button
            onClick={onPedsToggle}
            title="Pedestrian footpaths (walk graph)"
            style={{
              padding: '3px 10px', border: `1px solid ${pedsOn ? '#c8a15a' : '#3a3a6a'}`,
              borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
              background: pedsOn ? '#2a2214' : '#1a1a30',
              color: pedsOn ? '#e0b96a' : '#667',
            }}
          >
            PED
          </button>
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

      {/* Simulation duration */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#778', width: 52 }}>Length</span>
        <select
          value={duration}
          onChange={(e) => onDurationChange(parseInt(e.target.value, 10))}
          disabled={active}
          style={{
            flex: 1, padding: '5px 8px', borderRadius: 4,
            background: '#1a1a30', border: '1px solid #3a3a6a', color: '#dde',
          }}
        >
          {DURATIONS.map((d) => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>
      </div>

      {/* Playback controls */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {btn('▶ Start', onStart, !idle && !ended, true)}
        {running && btn('⏸ Pause', onPause)}
        {paused && btn('▶ Resume', onResume)}
        {active && btn('■ Stop', onStop)}
        {!idle && btn('↺ Reset', onReset)}
      </div>

      {/* Speed — ×-real-time, logarithmic; red + clamped when the machine
          can't sustain the requested rate */}
      {(() => {
        const limited = maxRate != null && active && speed > maxRate * 1.1
        const shown = limited ? maxRate! : speed
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: '#778', width: 52 }}>Speed</span>
            <span style={{
              fontSize: 12, width: 46, textAlign: 'right',
              color: limited ? '#ff7a7a' : '#99a',
            }}>
              {fmtSpeed(shown)}×
            </span>
            <input
              type="range" min={0} max={1000} step={1}
              value={speedToPos(shown)}
              onChange={(e) => onSpeedChange(posToSpeed(parseInt(e.target.value, 10)))}
              style={{ flex: 1, accentColor: limited ? '#e05050' : undefined }}
              title={limited ? `machine ceiling ~${fmtSpeed(maxRate!)}× real-time` : `${fmtSpeed(shown)}× real time`}
            />
          </div>
        )
      })()}

      {/* Traffic scale */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: '#778', width: 52 }}>Traffic</span>
        <span style={{ fontSize: 12, color: '#99a', width: 34, textAlign: 'right' }}>
          {trafficScale.toFixed(1)}×
        </span>
        <input
          type="range" min={0} max={5} step={0.1}
          value={trafficScale}
          onChange={(e) => onTrafficScaleChange(parseFloat(e.target.value))}
          style={{ flex: 1 }}
        />
      </div>

      {/* Generator vehicle type — click a green entry marker to inject */}
      {genVtypes.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: '#778', width: 52 }}>Inject</span>
          <select
            value={genVtype}
            onChange={(e) => onGenVtypeChange(e.target.value)}
            style={{
              flex: 1, padding: '5px 8px', borderRadius: 4,
              background: '#1a1a30', border: '1px solid #3a3a6a', color: '#dde',
            }}
          >
            {genVtypes.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
          <span style={{ fontSize: 10, color: active ? '#5c8' : '#667' }} title="Click a green marker at an entry to inject">
            {active ? '● click entry' : 'start sim'}
          </span>
        </div>
      )}

      {/* Sim time */}
      <div style={{ fontSize: 13, color: '#99b', fontVariantNumeric: 'tabular-nums' }}>
        {active || ended
          ? `T = ${mm}:${ss} (${simTime.toFixed(1)} s)`
          : 'Not running'}
      </div>
    </div>
  )
}
