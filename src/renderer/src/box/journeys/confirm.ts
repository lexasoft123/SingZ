import type { Confirmation } from './model'
import type { PlatformCommand } from './usePlatform'

export interface JourneyConfirmationServices {
  removeCache(dir: string, requireIdle: boolean): Promise<unknown>
  revokePhone(sessionId: string): Promise<unknown>
  revokeAllPhones(): Promise<unknown>
  signOut(): Promise<unknown>
  runPlatform(command: PlatformCommand): Promise<boolean>
  /** Re-read the Hub's own authoritative views after a reset. */
  refreshAfterReset(): Promise<unknown>
  /** Tell the collection owner that local downloads changed outside it. */
  onLibraryChanged(): void
  /** Tell the collection owner to re-read Drive authorization. */
  onAccountChanged?(): void
}

/** Runs the owner-approved operation; a successful factory reset invalidates the collection owner too. */
export async function runJourneyConfirmation(confirmation: Confirmation, services: JourneyConfirmationServices): Promise<void> {
  switch (confirmation.kind) {
    case 'remove-cache': await services.removeCache(confirmation.dir, confirmation.requireIdle); return
    case 'phone-revoke': await services.revokePhone(confirmation.sessionId); return
    case 'phone-stop': await services.revokeAllPhones(); return
    case 'drive-signout': await services.signOut(); return
    case 'update-install': await services.runPlatform('update-install'); return
    case 'rollback': await services.runPlatform('rollback'); return
    case 'reboot': await services.runPlatform('reboot'); return
    case 'wifi-switch': await services.runPlatform('wifi-start'); return
    case 'factory-reset': {
      if (!await services.runPlatform('reset')) return
      // Reset erases preferences and downloads below the collection owner's caches.
      services.onLibraryChanged()
      services.onAccountChanged?.()
      await services.refreshAfterReset()
    }
  }
}
