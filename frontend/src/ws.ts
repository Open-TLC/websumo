export type Vehicle = [string, number, number, number, number, number, string]
// [id, lon, lat, angleDeg, lengthM, widthM, vclass]

export type Person = [string, number, number, number, number]
// [id, lon, lat, angleDeg, speed]

export type LogEvent = { type: string; text: string; lane?: string }

export type InspectBlock = Record<string, unknown> & { kind: string; id: string; gone?: boolean }

// V2X experiment: a floating-car egocentric JSON-LD graph (@id = "veh:<vid>")
export type FcdGraph = Record<string, unknown> & { '@id': string }

// V2X: one object in the fused shared Local Dynamic Map
export type LdmObject = {
  '@id': string
  onLane: string | null
  lon: number | null
  lat: number | null
  speed: number | null
  observedBy: string[]
  sources: number
  confirmed: boolean
  isProbe: boolean
}
export type Ldm = Record<string, unknown> & {
  '@id': string
  t: number
  observers: string[]
  objects: LdmObject[]
}

export class SimSocket {
  private ws: WebSocket | null = null
  onStep: ((vehicles: Vehicle[], tls: Record<string, string>, detectors: Record<string, boolean>, persons: Person[], t: number, maxRate?: number) => void) | null = null
  onEnd: (() => void) | null = null
  onLog: ((t: number, events: LogEvent[]) => void) | null = null
  onInspect: ((block: InspectBlock) => void) | null = null
  onFcd: ((graph: FcdGraph) => void) | null = null
  onLdm: ((ldm: Ldm) => void) | null = null

  connect(scenario: string): void {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.ws = new WebSocket(`${proto}//${window.location.host}/api/ws/${scenario}`)
    this.ws.onmessage = (e) => {
      const d = JSON.parse(e.data)
      if (d.type === 'end') {
        this.onEnd?.()
      } else if (d.type === 'log') {
        this.onLog?.(d.t ?? 0, d.events ?? [])
      } else if (d.type === 'inspect') {
        this.onInspect?.(d.inspect)
      } else if (d.type === 'fcd') {
        this.onFcd?.(d.graph)
      } else if (d.type === 'ldm') {
        this.onLdm?.(d.ldm)
      } else {
        this.onStep?.(d.vehicles ?? [], d.tls ?? {}, d.detectors ?? {}, d.persons ?? [], d.t ?? 0, d.maxRate)
        if (d.inspect) this.onInspect?.(d.inspect)
      }
    }
    this.ws.onerror = (e) => console.error('WS error', e)
    this.ws.onopen = () => {
      for (const m of this.pending) this.ws?.send(m)
      this.pending = []
    }
  }

  private pending: string[] = []

  send(cmd: string, data: Record<string, unknown> = {}): void {
    const msg = JSON.stringify({ cmd, ...data })
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(msg)
    else if (this.ws?.readyState === WebSocket.CONNECTING) this.pending.push(msg)
  }

  close(): void {
    this.ws?.close()
    this.ws = null
  }
}
