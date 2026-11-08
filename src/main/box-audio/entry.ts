import { app } from 'electron'
import { join } from 'node:path'
import { CaptureOwner, loadBoxAudioHostBinding, type NativeCaptureBinding } from '../capture'
import { startBoxAudioHost } from './server'
import type { BoxAudioHostAuthority } from './profile'

interface NativeBoxRouting {
  boxRoutingInitialize(path: string): { ok: boolean; error?: string }
  boxRoutingRequest(json: string): string
  boxRoutingPoll(): void
  boxRoutingCapabilities(): unknown
  boxRoutingShutdown(): void
}
export async function runBoxAudioHost(authority: BoxAudioHostAuthority): Promise<void> {
  await app.whenReady()
  const socketPath = process.env.SINGZ_BOX_AUDIO_SOCKET
  if (!socketPath) throw new Error('Box audio host requires SINGZ_BOX_AUDIO_SOCKET')
  let binding: NativeCaptureBinding | undefined
  let routing: NativeBoxRouting | undefined
  const initialize = (): NativeCaptureBinding => {
    if (binding) return binding
    const candidate = loadBoxAudioHostBinding(authority)
    const control = candidate as unknown as NativeBoxRouting
    if (typeof control.boxRoutingInitialize !== 'function') throw new Error('Native Box routing unavailable')
    const initialized = control.boxRoutingInitialize(join(app.getPath('userData'), 'routing.json'))
    if (!initialized.ok) throw new Error(initialized.error ?? 'Native Box routing initialization failed')
    routing = control
    return binding = candidate
  }
  // Acquire the socket before loading/opening native devices, so a second
  // executable cannot create a competing physical owner before it is rejected.
  const owner = new CaptureOwner(undefined, initialize)
  let poll: ReturnType<typeof setInterval> | undefined
  const host = await startBoxAudioHost(socketPath, {
    owner: owner as unknown as Record<string, unknown>, binding: {},
    routingRequest: json => { initialize(); return routing!.boxRoutingRequest(json) },
    routingCapabilities: () => { initialize(); return routing!.boxRoutingCapabilities() },
    shutdown: () => { clearInterval(poll); owner.stop(); routing?.boxRoutingShutdown() }
  })
  try {
    initialize()
    poll = setInterval(() => routing!.boxRoutingPoll(), 25)
  } catch (error) { await host.close(); throw error }
  let stopping = false
  const stop = (): void => { if (stopping) return; stopping = true; void host.close().finally(() => app.exit(0)) }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  app.on('before-quit', event => { if (!stopping) { event.preventDefault(); stop() } })
}
