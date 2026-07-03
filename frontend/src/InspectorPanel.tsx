import type { ReactNode } from 'react'
import type { InspectBlock } from './ws'

export type Selected = {
  kind: 'vehicle' | 'tls'
  id: string
  // static TLS programs from the network GeoJSON: {programId: [[duration, state], ...]}
  tlsPrograms?: Record<string, [number, string][]>
}

interface Props {
  selected: Selected
  live: InspectBlock | null
  simTime: number
  simActive: boolean
  onClose: () => void
}

const row = (label: string, value: ReactNode, key?: string) => (
  <div key={key ?? label} style={{ display: 'flex', gap: 8, lineHeight: 1.6 }}>
    <span style={{ color: '#778', width: 110, flexShrink: 0 }}>{label}</span>
    <span style={{ color: '#ccd', wordBreak: 'break-all' }}>{value}</span>
  </div>
)

function stateColor(c: string): string {
  if (c === 'G' || c === 'g') return '#1ed250'
  if (c === 'r' || c === 'R') return '#dc1e1e'
  if (c === 'y' || c === 'Y') return '#e6c800'
  return '#888'
}

const StateString = ({ s }: { s: string }) => (
  <span style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: 1 }}>
    {s.split('').map((c, i) => (
      <span key={i} style={{ color: stateColor(c) }}>{c}</span>
    ))}
  </span>
)

function VehicleBody({ live }: { live: InspectBlock }) {
  const l = live as Record<string, any>
  return (
    <>
      {row('type', `${l.type} (${l.vclass})`)}
      {row('speed', `${l.speed} m/s (allowed ${l.allowedSpeed})`)}
      {row('accel', `${l.accel} m/s²`)}
      {row('lane', `${l.lane} @ ${l.lanePos} m`)}
      {row('route', l.route)}
      {row('edges', `${(l.routeEdges ?? []).join(' → ')} [${l.routeIndex}]`)}
      {row('departed', `${l.departure} s (delay ${l.departDelay} s)`)}
      {row('waiting', `${l.waiting} s (total ${l.accumWaiting} s)`)}
      {row('time loss', `${l.timeLoss} s`)}
      {row('odometer', `${l.distance} m`)}
      {row('leader', l.leader ? `${l.leader[0]} (gap ${l.leader[1]} m)` : '—')}
      {l.nextTLS
        ? <div style={{ display: 'flex', gap: 8, lineHeight: 1.6 }}>
            <span style={{ color: '#778', width: 110, flexShrink: 0 }}>next signal</span>
            <span style={{ color: '#ccd' }}>
              {l.nextTLS[1]} m, <StateString s={l.nextTLS[2]} />
            </span>
          </div>
        : row('next signal', '—')}
      {row('speedFactor', l.speedFactor)}
      {row('size', `${l.length} × ${l.width} m (minGap ${l.minGap})`)}
    </>
  )
}

function TlsBody({ selected, live, simTime }: {
  selected: Selected; live: InspectBlock | null; simTime: number
}) {
  const l = live as Record<string, any> | null
  // live phases when running; static program table otherwise
  const staticProgs = selected.tlsPrograms ?? {}
  const program = l?.program ?? Object.keys(staticProgs)[0]
  const phases: [number, string][] = l?.phases ?? staticProgs[program] ?? []
  const current = l?.phase ?? -1
  const countdown = l ? Math.max(0, l.nextSwitch - simTime) : null

  return (
    <>
      {row('program', program ?? '—')}
      {l && row('state', <StateString s={l.state} />, 'state')}
      {l && row('next switch', `in ${countdown?.toFixed(0)} s (t=${l.nextSwitch})`)}
      {l && row('phase spent', `${l.spent} s`)}
      <div style={{ color: '#667', fontSize: 10, letterSpacing: 1, margin: '8px 0 2px' }}>
        {l ? 'PROGRAM (live)' : 'PROGRAM (from network file)'}
      </div>
      <table style={{ borderCollapse: 'collapse', fontFamily: 'ui-monospace, monospace' }}>
        <tbody>
          {phases.map(([dur, state], i) => (
            <tr key={i} style={{
              background: i === current ? 'rgba(0,240,255,0.12)' : 'transparent',
            }}>
              <td style={{ color: i === current ? '#0ff' : '#667', padding: '0 8px 0 2px' }}>
                {i === current ? '▶' : ''} {i}
              </td>
              <td style={{ color: '#99a', padding: '0 10px 0 0', textAlign: 'right' }}>{dur} s</td>
              <td><StateString s={state} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

export function InspectorPanel({ selected, live, simTime, simActive, onClose }: Props) {
  const gone = live?.gone === true
  return (
    <div style={{
      position: 'absolute', top: 12, right: 12, zIndex: 20,
      width: 360, maxWidth: '42vw', maxHeight: '70vh',
      background: 'rgba(10,10,28,0.97)', borderRadius: 8,
      border: '1px solid #5a5aaa', backdropFilter: 'blur(4px)',
      boxShadow: '0 2px 16px rgba(0,0,0,0.8)',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderBottom: '1px solid #2a2a4a',
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#aac', letterSpacing: 1 }}>
          {selected.kind === 'vehicle' ? 'VEHICLE' : 'TRAFFIC LIGHT'}
          <span style={{ color: '#667', fontWeight: 400, marginLeft: 8 }}>{selected.id}</span>
        </div>
        <button
          onClick={onClose}
          style={{
            border: 'none', background: 'transparent', color: '#778',
            cursor: 'pointer', fontSize: 16, padding: '0 4px',
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 14px 12px', fontSize: 11 }}>
        {gone && (
          <div style={{ color: '#ffb056', fontStyle: 'italic' }}>
            Element left the simulation.
          </div>
        )}
        {!gone && selected.kind === 'vehicle' && (
          live
            ? <VehicleBody live={live} />
            : <div style={{ color: '#667', fontStyle: 'italic' }}>
                {simActive ? 'Waiting for data…' : 'No simulation running.'}
              </div>
        )}
        {!gone && selected.kind === 'tls' && (
          <TlsBody selected={selected} live={live} simTime={simTime} />
        )}
      </div>
    </div>
  )
}
