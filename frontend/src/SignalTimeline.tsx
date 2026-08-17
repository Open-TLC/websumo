import { useEffect, useRef } from 'react'
import type { OcJoin, OcController } from './ws'

// Live signal-state timeline (rolling Gantt). One row per OC signal group; each
// row shows the group's state history (green/red/amber) scrolling right→left,
// "now" at the right edge. This is the "signal-state timeline / phase history"
// from OC_SIGNAL_VIZ_METHODS.md — the canonical live view of signal operation,
// built purely from the group.status stream we already relay (no OC changes).

const WINDOW_MS = 90_000      // rolling window shown
const ROW_H = 13              // px per group row
const LABEL_W = 40            // left gutter for G-labels
const HEAD_H = 18             // top strip for the time axis / phase

function stateColor(s: string | undefined): string {
  switch (s) {
    case 'G': case 'g': return '#1ed250'
    case 'r': case 'R': return '#c0392b'
    case 'y': case 'Y': return '#e6c800'
    default:            return '#3a3a52'   // unknown/off
  }
}

type Transition = { t: number; state: string }

export function SignalTimeline({ join, groups, controller }:
  { join: OcJoin; groups: Record<string, string>; controller?: OcController | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // per-group state-change history, keyed by group name
  const historyRef = useRef<Map<string, Transition[]>>(new Map())
  const groupsRef = useRef(groups)
  groupsRef.current = groups

  const key = join.subject_key ?? ''
  const names = join.groups
    ? Object.keys(join.groups).sort(
        (a, b) => (join.groups![a].control_number ?? 0) - (join.groups![b].control_number ?? 0))
    : []

  // record a transition whenever a group's state changes
  useEffect(() => {
    const now = performance.now()
    for (const name of names) {
      const g = join.groups![name]
      const cur = groups[`${key}.${g.links[0]}`] ?? '?'
      const hist = historyRef.current.get(name) ?? []
      const last = hist[hist.length - 1]
      if (!last || last.state !== cur) {
        hist.push({ t: now, state: cur })
        // keep one transition before the window plus everything inside it
        const cutoff = now - WINDOW_MS
        let firstInside = hist.findIndex((tr) => tr.t >= cutoff)
        if (firstInside > 1) hist.splice(0, firstInside - 1)
        historyRef.current.set(name, hist)
      }
    }
  }, [groups, join, key, names])

  // continuous redraw so the window scrolls smoothly between messages
  useEffect(() => {
    let raf = 0
    const draw = () => {
      const canvas = canvasRef.current
      if (canvas) {
        const dpr = window.devicePixelRatio || 1
        const cssW = canvas.clientWidth
        const cssH = HEAD_H + names.length * ROW_H
        if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
          canvas.width = cssW * dpr; canvas.height = cssH * dpr
          canvas.style.height = `${cssH}px`
        }
        const ctx = canvas.getContext('2d')!
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, cssW, cssH)

        const now = performance.now()
        const t0 = now - WINDOW_MS
        const plotW = cssW - LABEL_W
        const xOf = (t: number) => LABEL_W + Math.max(0, Math.min(plotW, ((t - t0) / WINDOW_MS) * plotW))

        // time gridlines every 15 s
        ctx.font = '9px ui-monospace, monospace'
        ctx.textBaseline = 'top'
        for (let s = 0; s <= WINDOW_MS / 1000; s += 15) {
          const x = xOf(t0 + s * 1000)
          ctx.strokeStyle = 'rgba(255,255,255,0.06)'
          ctx.beginPath(); ctx.moveTo(x, HEAD_H); ctx.lineTo(x, cssH); ctx.stroke()
          ctx.fillStyle = '#556'
          ctx.fillText(`-${Math.round(WINDOW_MS / 1000 - s)}s`, x + 2, 2)
        }
        // phase label at the "now" edge
        if (controller?.phase) {
          ctx.fillStyle = '#8ab4ff'
          ctx.textAlign = 'right'
          ctx.fillText(controller.phase, cssW - 3, 2)
          ctx.textAlign = 'left'
        }

        // group rows
        names.forEach((name, i) => {
          const y = HEAD_H + i * ROW_H
          const g = join.groups![name]
          const hist = historyRef.current.get(name) ?? []
          // segments between consecutive transitions + a final segment to "now"
          for (let k = 0; k < hist.length; k++) {
            const seg = hist[k]
            const segEnd = k + 1 < hist.length ? hist[k + 1].t : now
            if (segEnd < t0) continue
            const x1 = xOf(seg.t), x2 = xOf(segEnd)
            ctx.fillStyle = stateColor(seg.state)
            ctx.fillRect(x1, y + 1, Math.max(1, x2 - x1), ROW_H - 2)
          }
          // label
          ctx.fillStyle = '#c7d6ea'
          ctx.font = '9px ui-monospace, monospace'
          ctx.fillText(`G${g.control_number}`, 3, y + 2)
        })
        // "now" edge
        ctx.strokeStyle = 'rgba(138,180,255,0.5)'
        ctx.beginPath(); ctx.moveTo(cssW - 0.5, HEAD_H); ctx.lineTo(cssW - 0.5, cssH); ctx.stroke()
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [names, join, controller])

  if (!join.enabled || names.length === 0) return null

  return (
    <div style={{
      position: 'absolute', bottom: 12, left: 214, right: 12, zIndex: 14,
      background: 'rgba(10,10,28,0.92)', border: '1px solid #2a2a4a',
      borderRadius: 6, padding: '6px 8px',
    }}>
      <div style={{
        color: '#8ab4ff', fontWeight: 700, letterSpacing: 1, fontSize: 10,
        fontFamily: 'ui-monospace, monospace', marginBottom: 2,
      }}>
        SIGNAL STATE TIMELINE · last {WINDOW_MS / 1000}s
      </div>
      <canvas ref={canvasRef} style={{ width: '100%', display: 'block' }} />
    </div>
  )
}
