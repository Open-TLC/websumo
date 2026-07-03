import { useEffect, useRef } from 'react'

export type LogEntry = { t: number; type: string; text: string; lane?: string }

interface Props {
  open: boolean
  startupLines: string[]
  entries: LogEntry[]
  onClose: () => void
}

const EVENT_COLORS: Record<string, string> = {
  collision: '#ff6b6b',
  teleport: '#ffb056',
  emergency: '#ffe066',
}

const EVENT_ICONS: Record<string, string> = {
  collision: '✕',
  teleport: '⇢',
  emergency: '⚠',
}

export function LogPanel({ open, startupLines, entries, onClose }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length, startupLines.length, open])

  if (!open) return null

  const fmt = (t: number) => {
    const mm = Math.floor(t / 60).toString().padStart(2, '0')
    const ss = Math.floor(t % 60).toString().padStart(2, '0')
    return `${mm}:${ss}`
  }

  return (
    <div style={{
      position: 'absolute', top: 12, right: 12, bottom: 12, zIndex: 20,
      width: 420, maxWidth: '45vw',
      background: 'rgba(10,10,28,0.97)', borderRadius: 8,
      border: '1px solid #5a5aaa', backdropFilter: 'blur(4px)',
      boxShadow: '0 2px 16px rgba(0,0,0,0.8)',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderBottom: '1px solid #2a2a4a',
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#aac', letterSpacing: 1 }}>
          SIMULATION LOG
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

      <div ref={bodyRef} style={{
        flex: 1, overflowY: 'auto', padding: '8px 14px',
        fontFamily: 'ui-monospace, monospace', fontSize: 11, lineHeight: 1.5,
      }}>
        {startupLines.length > 0 && (
          <>
            <div style={{ color: '#667', fontSize: 10, letterSpacing: 1, margin: '4px 0' }}>
              — STARTUP (SUMO stderr) —
            </div>
            {startupLines.map((line, i) => (
              <div key={`s${i}`} style={{ color: '#9a8f6a', whiteSpace: 'pre-wrap' }}>
                {line}
              </div>
            ))}
          </>
        )}

        {entries.length > 0 && (
          <div style={{ color: '#667', fontSize: 10, letterSpacing: 1, margin: '8px 0 4px' }}>
            — EVENTS (live) —
          </div>
        )}
        {entries.map((e, i) => (
          <div key={`e${i}`} style={{ color: EVENT_COLORS[e.type] ?? '#99b' }}>
            <span style={{ color: '#667', fontVariantNumeric: 'tabular-nums' }}>
              {fmt(e.t)}{' '}
            </span>
            {EVENT_ICONS[e.type] ?? '·'} {e.type} {e.text}
            {e.lane ? <span style={{ color: '#667' }}> @ {e.lane}</span> : null}
          </div>
        ))}

        {startupLines.length === 0 && entries.length === 0 && (
          <div style={{ color: '#667', fontStyle: 'italic', marginTop: 8 }}>
            No log messages yet.
          </div>
        )}
      </div>
    </div>
  )
}
