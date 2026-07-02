import { connect, StringCodec } from 'nats.ws'
import type { NatsConnection } from 'nats.ws'

export type Vehicle = [string, number, number, number, number, number, string]
// [id, lon, lat, angleDeg, lengthM, widthM, vclass]

export class SimNats {
  private nc: NatsConnection | null = null
  private scenario: string = ''
  onStep: ((vehicles: Vehicle[], tls: Record<string, string>, t: number) => void) | null = null
  onEnd: (() => void) | null = null

  async connect(scenario: string, natsUrl = `ws://${window.location.hostname}:9222`): Promise<void> {
    this.scenario = scenario
    this.nc = await connect({ servers: natsUrl })
    const sc = StringCodec()

    const stateSub = this.nc.subscribe(`sim.${scenario}.state`)
    const endSub   = this.nc.subscribe(`sim.${scenario}.end`)

    // state messages → onStep
    ;(async () => {
      for await (const msg of stateSub) {
        const d = JSON.parse(sc.decode(msg.data))
        this.onStep?.(d.vehicles ?? [], d.tls ?? {}, d.t ?? 0)
      }
    })()

    // end message → onEnd
    ;(async () => {
      for await (const _ of endSub) {
        this.onEnd?.()
        break
      }
    })()
  }

  publish(cmd: string, data: Record<string, unknown> = {}): void {
    if (!this.nc || !this.scenario) return
    const sc = StringCodec()
    this.nc.publish(
      `sim.${this.scenario}.cmd.${cmd}`,
      sc.encode(JSON.stringify(data)),
    )
  }

  async close(): Promise<void> {
    const nc = this.nc
    this.nc = null
    this.scenario = ''
    try {
      await nc?.drain()
    } catch {
      // ignore drain errors on forced close
    }
  }
}
