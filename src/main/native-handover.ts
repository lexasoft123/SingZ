import { app, ipcMain, shell } from 'electron'
import { nativeOfferKey, type NativeHandoverReport, type NativeOffer } from '../shared/native-handover'
import { log } from './log'
import { writeNativeHandover } from './native-handover-file'
import { readSettings, writeSettings } from './settings'
import { nativeOfferNow, nativeOfferActive, onNativeOfferChange } from './updater'

/** Offer state with the user's dismissal applied. */
export function visibleNativeOffer(): NativeOffer {
  const offer = nativeOfferNow()
  if (!offer.available) return offer
  return readSettings().nativeOfferDismissed === nativeOfferKey(offer) ? { available: false } : offer
}

export type NativeOfferOpenResult = { ok: true } | { ok: false; error: string }

/** IPC. The state query always answers (no offer when disabled, so the renderer
 * needs no special case); the dismiss and open handlers exist only when the offer
 * is enabled on the desktop surface, never in Box or in a default build. */
export function registerNativeHandover(enabled: boolean, broadcast: (offer: NativeOffer) => void): void {
  ipcMain.handle('native-offer:state', () => (enabled ? visibleNativeOffer() : { available: false }))
  if (!enabled) return
  onNativeOfferChange(() => broadcast(visibleNativeOffer()))
  ipcMain.handle('native-offer:dismiss', () => {
    const offer = nativeOfferNow()
    if (offer.available) writeSettings({ nativeOfferDismissed: nativeOfferKey(offer) })
    broadcast(visibleNativeOffer())
    return { ok: true }
  })
  // The export is written first, then the download opens. If the export fails the
  // download still opens: native then imports defaults, which is the documented
  // result for a missing file, and the singer is not blocked on a preference file.
  ipcMain.handle('native-offer:open', async (_event, report: NativeHandoverReport): Promise<NativeOfferOpenResult> => {
    const offer = nativeOfferNow()
    if (!offer.available || !nativeOfferActive()) return { ok: false, error: 'No native build is on offer.' }
    const written = writeNativeHandover(app.getPath('userData'), report ?? {})
    if (!written.ok) log('handover', `export not written: ${written.error}`, 'warn')
    try {
      await shell.openExternal(offer.url)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('handover', `native download did not open: ${message}`, 'warn')
      return { ok: false, error: message }
    }
    return { ok: true }
  })
}
