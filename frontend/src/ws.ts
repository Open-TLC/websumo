export type Vehicle = [string, number, number, number, number, number, string]
// [id, lon, lat, angleDeg, lengthM, widthM, vclass]

export class SimSocket {
  private ws: WebSocket | null = null
  onStep: ((vehicles: Vehicle[], tls: Record<string, string>, detectors: Record<string, boolean>, t: number) => void) | null = null
  onEnd: (() => void) | null = null

  connect(scenario: string): void {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.ws = new WebSocket(`${proto}//${window.location.host}/api/ws/${scenario}`)
    this.ws.onmessage = (e) => {
      const d = JSON.parse(e.data)
      if (d.type === 'end') {
        this.onEnd?.()
      } else {
        this.onStep?.(d.vehicles ?? [], d.tls ?? {}, d.detectors ?? {}, d.t ?? 0)
      }
    }
    this.ws.onerror = (e) => console.error('WS error', e)
  }

  send(cmd: string, data: Record<string, unknown> = {}): void {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ cmd, ...data }))
  }

  close(): void {
    this.ws?.close()
    this.ws = null
  }
}
