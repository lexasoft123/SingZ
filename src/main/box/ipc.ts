import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { BoxControllerHub } from './controller'
import { BoxPhoneService } from './phone'
import { BoxPlatformService } from './platform'
import { BoxStateService } from './state'
import { BoxStorageService } from './storage'
import type { BoxPreferences, BoxQueueRef, BoxResult } from '../../shared/box-contract'

export type BoxBackend = ReturnType<typeof registerBoxIpc> extends infer T ? Exclude<T, null> : never
type BoxIpcOptions = {
  userDataDir: string
  appVersion: string
  rendererURL: string
  socketPath?: string
  audioInputs: () => unknown
  audioHost: () => unknown
}
type Handler = (event: IpcMainInvokeEvent, args: unknown[]) => unknown | Promise<unknown>
const failure = (error: string, code: string): BoxResult<never> => ({ ok: false, error, code })

export function registerBoxIpc(options: BoxIpcOptions) {
  if (process.env.SINGZ_SURFACE !== 'box') return null
  const controller = new BoxControllerHub()
  const state = new BoxStateService(options.userDataDir)
  const storage = new BoxStorageService(options.userDataDir, controller)
  const platform = new BoxPlatformService({ socketPath: options.socketPath, currentVersion: options.appVersion })
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
  const routes: Record<string, Handler> = {
    'box:state-get': () => state.getState(),
    'box:preferences-set': (_event, [value]) => state.setPreferences(value as Partial<BoxPreferences>),
    'box:queue-save': (_event, [value]) => state.saveQueue(value as BoxQueueRef[]),
    'box:platform-snapshot': () => platform.snapshot(),
    'box:platform-command': (_event, [value]) => platform.command(value),
    'box:storage-snapshot': () => storage.snapshot(),
    'box:cache-remove': (_event, [value]) => storage.removeCachedProject(value as string),
    'box:diagnostics': () => ({
      ok: true,
      value: {
        appVersion: options.appVersion,
        platform: process.platform,
        arch: process.arch,
        audio: { inputs: options.audioInputs(), host: options.audioHost() }
      }
    }),
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
