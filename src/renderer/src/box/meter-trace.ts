import type { BoxMeterTrace } from '../../../shared/box-audio'

const LIMIT = 512
const ms = (ns: string): number => Number(BigInt(ns)) / 1e6
export type MeterTraceRecord = {
  id: number; channel: number; generation: string; host: BoxMeterTrace; sourceIndex: number
  requestMs: number; receiveMs: number; paintMs: number | null
  hostMinusRendererMs: number; clockUncertaintyMs: number
  nativeToHostMs: number; nativeClockUncertaintyMs: number
  receiveHostNs: string; paintHostNs: string | null
  captureToReceiveMs: number | null; captureToPaintMs: number | null
}
/** Created only with the developer flag. No PCM, bounded history, no trace timer. */
export class BoxMeterTraceLog {
  private next = 0
  private rows: MeterTraceRecord[] = []
  private readings = new Map<number, number>()
  readonly hook = {
    records: (): MeterTraceRecord[] => structuredClone(this.rows),
    clear: (): void => { this.rows = []; this.readings.clear() }
  }
  constructor() {
    if (typeof window !== 'undefined') (window as TraceWindow).__singzBoxMeterTrace = this.hook
  }
  receive(host: BoxMeterTrace, generation: string, channels: number[], requestMs: number, receiveMs: number): void {
    const start = ms(host.hostReceiveNs), end = ms(host.hostSendNs), read = ms(host.hostReadNs)
    // NTP midpoint estimate, with the measured round-trip bound exposed to CDP.
    const offset = ((start - requestMs) + (end - receiveMs)) / 2
    const uncertainty = Math.max(0, (receiveMs - requestMs - (end - start)) / 2)
    // Calibrate native steady_clock against the bracketing Node host clock.
    const nativeOffset = (start + read) / 2 - ms(host.readNs)
    this.readings.clear()
    for (let index = 0; index < Math.min(channels.length, host.points.length, 64); index++) {
      const source = host.points[index], id = ++this.next
      this.rows.push({ id, channel: channels[index], generation, host, sourceIndex: index,
        requestMs, receiveMs, paintMs: null, hostMinusRendererMs: offset, clockUncertaintyMs: uncertainty,
        nativeToHostMs: nativeOffset, nativeClockUncertaintyMs: Math.max(0, (read - start) / 2),
        receiveHostNs: String(BigInt(Math.round((receiveMs + offset) * 1e6))), paintHostNs: null,
        captureToReceiveMs: source.matched ? receiveMs + offset - (ms(source.sampleHostTimeNs) + nativeOffset) : null,
        captureToPaintMs: null })
      this.readings.set(channels[index], id)
    }
    if (this.rows.length > LIMIT) this.rows.splice(0, this.rows.length - LIMIT)
  }
  reading(channel: number): number | undefined { return this.readings.get(channel) }
  paint = (id: number, frameTimeMs: number): void => {
    const row = this.rows.find(row => row.id === id)
    if (!row || row.paintMs !== null) return
    row.paintMs = frameTimeMs
    row.paintHostNs = String(BigInt(Math.round((frameTimeMs + row.hostMinusRendererMs) * 1e6)))
    if (row.host.points[row.sourceIndex].matched)
      row.captureToPaintMs = frameTimeMs + row.hostMinusRendererMs - (ms(row.host.points[row.sourceIndex].sampleHostTimeNs) + row.nativeToHostMs)
  }
  dispose(): void {
    if (typeof window !== 'undefined' && (window as TraceWindow).__singzBoxMeterTrace === this.hook)
      delete (window as TraceWindow).__singzBoxMeterTrace
    this.rows = []; this.readings.clear()
  }
}
type TraceWindow = Window & { __singzBoxMeterTrace?: BoxMeterTraceLog['hook'] }
