import { realpath } from 'node:fs/promises'
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { BoxControllerHub } from './controller'
import { BoxPhoneService } from './phone'
import { BoxPlatformService } from './platform'
import { BoxRoutingService } from './routing'
import { BoxStateService } from './state'
import { BoxStorageService } from './storage'
import type { BoxPreferences, BoxQueueRef, BoxResult, BoxRetainedPlaybackRestore, BoxRetainedPlaybackSnapshot, BoxCecStatus } from '../../shared/box-contract'
import type { BoxMicrophoneSelectionEdit, BoxMicrophoneSelectionResult, BoxMicrophoneSnapshot } from '../../shared/box-audio'
import { retainedPlaybackSnapshot } from '../../shared/box-retained-playback'

export type BoxBackend = ReturnType<typeof registerBoxIpc> extends infer T ? Exclude<T, null> : never
type BoxIpcOptions = {
  userDataDir: string
  appVersion: string
  rendererURL: string
  socketPath?: string
  microphones?: { snapshot(): Promise<BoxMicrophoneSnapshot>; setSelection(edit: BoxMicrophoneSelectionEdit): Promise<BoxMicrophoneSelectionResult> }
  audioInputs: () => unknown
  audioHost: () => unknown
  cecStatus?: () => BoxCecStatus
  retainedPlaybackSnapshot?: () => Promise<BoxRetainedPlaybackSnapshot>
  stopRetainedPlayback?: (expected: { epoch: string; generation: string }) => Promise<BoxRetainedPlaybackSnapshot>
  restoreRetainedPlayback?: (expected: { epoch: string; generation: string }) => Promise<BoxRetainedPlaybackRestore>
  routingRequest?: (json: string) => Promise<string>
  routingReconcile?: () => Promise<unknown>
  log?: (message: string) => void
}
type Handler = (event: IpcMainInvokeEvent, args: unknown[]) => unknown | Promise<unknown>
const failure = (error: string, code: string): BoxResult<never> => ({ ok: false, error, code })

const retainedCacheRemovalGuard = async (
  dir: string,
  readSnapshot: () => Promise<BoxRetainedPlaybackSnapshot>
): Promise<BoxResult<null>> => {
  try {
    const snapshot = retainedPlaybackSnapshot(await readSnapshot())
    if (!snapshot.playback || snapshot.playback.state === 'unloaded') return { ok: true, value: null }
    const retainedDir = snapshot.recovery?.descriptor.project.dir
    if (!retainedDir) return failure('Independent audio has no valid recovery identity.', 'unavailable')
    const [cacheDir, playbackDir] = await Promise.all([realpath(dir), realpath(retainedDir)])
    if (cacheDir === playbackDir) return failure('The cached project is active in independent audio.', 'project-active')
    return { ok: true, value: null }
  } catch {
    return failure('Independent audio state is unavailable; cached project was not removed.', 'unavailable')
  }
}

export function registerBoxIpc(options: BoxIpcOptions) {
  if (process.env.SINGZ_SURFACE !== 'box') return null
  const controller = new BoxControllerHub()
  const state = new BoxStateService(options.userDataDir, options.log)
  const storage = new BoxStorageService(options.userDataDir, controller, options.retainedPlaybackSnapshot
    ? (dir) => retainedCacheRemovalGuard(dir, options.retainedPlaybackSnapshot!)
    : undefined)
  const platform = new BoxPlatformService({ socketPath: options.socketPath, currentVersion: options.appVersion })
  const routing = new BoxRoutingService(options.routingRequest, options.routingReconcile)
  const phone = new BoxPhoneService({ controller })
  let attached: WebContents | null = null
  let disposed = false
  const normalizeUrl = (raw: string): string | null => {
    try {
      const url = new URL(raw)
      url.hash = ''
      return url.toString()
    } catch {
      return null
    }
  }
  const expectedRendererUrl = normalizeUrl(options.rendererURL)
  const clearSender = (): void => controller.setCommandSender(null)
  const enableSender = (sender: WebContents): void => {
    controller.setCommandSender((envelope) => {
      if (attached === sender && !sender.isDestroyed()) sender.send('box:controller-command', envelope)
    })
  }
  const attachRenderer = (sender: WebContents): void => {
    if (disposed) return
    attached = sender
    clearSender()
    sender.once('destroyed', () => {
      if (attached !== sender) return
      attached = null
      clearSender()
    })
    sender.on('render-process-gone', () => {
      if (attached === sender) clearSender()
    })
    sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (attached === sender && isMainFrame) clearSender()
    })
  }
  const trust = (event: IpcMainInvokeEvent): boolean => {
    try {
      const sender = event.sender
      const frame = event.senderFrame
      return attached === sender && !sender.isDestroyed() && frame !== null && frame === sender.mainFrame &&
        expectedRendererUrl !== null && normalizeUrl(frame.url) === expectedRendererUrl
    } catch {
      return false
    }
  }
  const retainedResult = async <T>(operation: () => Promise<T>): Promise<BoxResult<T>> => {
    try { return { ok: true, value: await operation() } }
    catch (error) { return failure(error instanceof Error ? error.message.slice(0, 2000) : 'Audio state is uncertain. Refresh before retrying.', 'audio-state') }
  }
  const routes: Record<string, Handler> = {
    'box:retained-playback-snapshot': async () => options.retainedPlaybackSnapshot
      ? retainedResult(options.retainedPlaybackSnapshot) : failure('Independent audio is not configured.', 'unavailable'),
    'box:retained-playback-stop': async (_event, [expected]) => {
      if (!options.stopRetainedPlayback) return failure('Independent audio is not configured.', 'unavailable')
      if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).some(key => !['epoch', 'generation'].includes(key))) return failure('Invalid retained song identity.', 'invalid-command')
      const value = expected as { epoch: string; generation: string }
      if (typeof value.epoch !== 'string' || !value.epoch || value.epoch.length > 128 || typeof value.generation !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.generation)) return failure('Invalid retained song identity.', 'invalid-command')
      return retainedResult(() => options.stopRetainedPlayback!(value))
    },
    'box:retained-playback-restore': async (_event, [expected]) => {
      if (!options.restoreRetainedPlayback) return failure('Independent audio is not configured.', 'unavailable')
      if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).some(key => !['epoch', 'generation'].includes(key))) return failure('Invalid retained song identity.', 'invalid-command')
      const value = expected as { epoch: string; generation: string }
      if (typeof value.epoch !== 'string' || !value.epoch || value.epoch.length > 128 || typeof value.generation !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.generation)) return failure('Invalid retained song identity.', 'invalid-command')
      return retainedResult(() => options.restoreRetainedPlayback!(value))
    },
    'box:microphones': () => options.microphones ? retainedResult(() => options.microphones!.snapshot()) : failure('Microphone analysis unavailable.', 'unavailable'),
    'box:microphone-selection-set': (_event, [edit]) => options.microphones ? retainedResult(() => options.microphones!.setSelection(edit as BoxMicrophoneSelectionEdit)) : failure('Microphone analysis unavailable.', 'unavailable'),
    'box:routing-snapshot': () => routing.snapshot(),
    'box:routing-edit': (_event, [value]) => routing.edit(value),
    'box:state-get': () => state.getState(),
    'box:preferences-set': (_event, [value]) => state.setPreferences(value as Partial<BoxPreferences>),
    'box:queue-save': (_event, [value]) => state.saveQueue(value as BoxQueueRef[]),
    'box:platform-snapshot': () => platform.snapshot(),
    'box:platform-command': (_event, [value]) => platform.command(value),
    'box:storage-snapshot': () => storage.snapshot(),
    'box:cache-remove': (_event, [value]) => storage.removeCachedProject(value as string),
    'box:diagnostics': async () => {
      const inventories = await Promise.allSettled([
        Promise.resolve().then(options.audioInputs), Promise.resolve().then(options.audioHost)
      ])
      const [inputs, host] = inventories.map(result => result.status === 'fulfilled' ? result.value
        : { ok: false, error: 'Audio service is unavailable.' })
      return {
        ok: true,
        value: {
          appVersion: options.appVersion,
          platform: process.platform,
          arch: process.arch,
          audio: { inputs, host },
          cec: options.cecStatus?.()
        }
      }
    },
    'box:phone-start': () => phone.start(),
    'box:phone-state': () => ({ ok: true, value: phone.state() }),
    'box:phone-approve': (_event, [value]) => phone.approve(value as string),
    'box:phone-deny': (_event, [value]) => phone.deny(value as string),
    'box:phone-revoke': (_event, [value]) => phone.revoke(value as string),
    'box:phone-stop': () => phone.stop(),
    'box:controller-publish': (event, [value]) => {
      const result = controller.publish(value)
      if (result.ok) enableSender(event.sender)
      return result
    },
    'box:controller-respond': (_event, [id, result]) => controller.respond(id, result),
    'box:controller-active': (_event, [id]) => ({
      ok: true,
      value: typeof id === 'string' ? controller.isCommandActive(id) : false
    })
  }
  for (const [channel, handler] of Object.entries(routes)) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (disposed || !trust(event)) return failure('Box IPC is unavailable for this renderer.', 'unauthorized')
      try {
        return await handler(event, args)
      } catch {
        return failure('The Box operation failed.', 'operation-failed')
      }
    })
  }
  return {
    controller,
    state,
    storage,
    platform,
    phone,
    attachRenderer,
    dispose: async (): Promise<void> => {
      if (disposed) return
      disposed = true
      for (const channel of Object.keys(routes)) ipcMain.removeHandler(channel)
      clearSender()
      await phone.stop()
      controller.dispose()
    }
  }
}
