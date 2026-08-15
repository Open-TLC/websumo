import type { OcJoin } from './ws'

// Minimal Open Controller panel: lists each OC signal group with its live
// substate (coloured dot), the SUMO signal indices it controls, and its
// min/max green from the controller config. This is the P1 "group inspector"
// as an always-on list rather than click-to-inspect (see
// docs/OC_ELEMENTS_DISPLAY_PLAN.md P1). Shown only in --opencontroller mode.

function dotColor(sub: string | undefined): string {
  switch (sub) {
    case 'G': case 'g': return '#1ed250'
    case 'r': case 'R': return '#dc1e1e'
    case 'y': case 'Y': return '#e6c800'
    default:            return '#8c8c8c'
  }
}

export function OCPanel({ join, groups }: { join: OcJoin; groups: Record<string, string> }) {
  if (!join.enabled || !join.groups) return null
  const key = join.subject_key ?? ''
  // order groups by their OC control number
  const names = Object.keys(join.groups).sort(
    (a, b) => (join.groups![a].control_number ?? 0) - (join.groups![b].control_number ?? 0))

  return (
    <div style={{
      position: 'absolute', top: 12, left: 12, zIndex: 15,
      background: 'rgba(10,10,28,0.92)', border: '1px solid #2a2a4a',
      borderRadius: 6, padding: '8px 10px', fontSize: 11, color: '#9db4d0',
      fontFamily: 'ui-monospace, monospace', lineHeight: 1.5, minWidth: 190,
      maxHeight: '70vh', overflowY: 'auto',
    }}>
      <div style={{ color: '#8ab4ff', fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>
        OPEN CONTROLLER · {join.controller}
      </div>
      <div style={{ color: '#667', marginBottom: 6, fontSize: 10 }}>
        {join.tls_id} · {names.length} groups
      </div>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {names.map((name) => {
            const g = join.groups![name]
            // a group's live state = the substate of its first controlled link
            const sub = groups[`${key}.${g.links[0]}`]
            const minG = g.timing?.min_green as number | undefined
            const maxG = g.timing?.max_green as number | undefined
            return (
              <tr key={name}>
                <td style={{ paddingRight: 6 }}>
                  <span style={{
                    display: 'inline-block', width: 9, height: 9, borderRadius: '50%',
                    background: dotColor(sub), boxShadow: `0 0 4px ${dotColor(sub)}`,
                  }} />
                </td>
                <td style={{ paddingRight: 8, color: '#c7d6ea', fontWeight: 700 }}>
                  G{g.control_number}
                </td>
                <td style={{ paddingRight: 8, color: '#778' }}>
                  link{g.links.length > 1 ? 's' : ''} {g.links.join(',')}
                </td>
                <td style={{ color: '#667', fontSize: 10 }}>
                  {minG != null ? `${minG}–${maxG ?? '∞'}s` : ''}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
