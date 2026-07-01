export type Vehicle = [string, number, number] // [id, lon, lat]

export interface SimMessage {
  t?: number
  vehicles?: Vehicle[]
  tls?: Record<string, string>  // tls_id → phase string e.g. "GGrrGGrr"
  type?: 'end'
}

export class SimSocket {
  private ws: WebSocket | null = null
  onStep: ((vehicles: Vehicle[], tls: Record<string, string>, t: number) => void) | null = null
  onEnd: (() => void) | null = null
  onError: ((e: Event) => void) | null = null

  connect(sessionId: string): void {
    this.ws = new WebSocket(`/ws/${sessionId}`)
    this.ws.onmessage = (e) => {
      const msg: SimMessage = JSON.parse(e.data)
      if (msg.type === 'end') {
        this.onEnd?.()
      } else if (msg.vehicles !== undefined) {
        this.onStep?.(msg.vehicles, msg.tls ?? {}, msg.t ?? 0)
      }
    }
    this.ws.onerror = (e) => this.onError?.(e)
  }

  send(cmd: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd))
    }
  }

  close(): void {
    this.ws?.close()
    this.ws = null
  }
}
