import type { JourneyPage } from './types'

/** Visibility belongs to the parent because the Hub remains mounted on other routes. */
export function journeyActivity(active: boolean, page: JourneyPage) {
  return {
    platform: active && ['home', 'setup', 'network', 'system', 'privacy'].includes(page),
    audio: active && ['home', 'setup', 'diagnostics'].includes(page),
    drive: active && ['home', 'setup', 'privacy'].includes(page),
    phones: active && ['home', 'phones', 'privacy'].includes(page),
    storage: active && ['home', 'storage', 'privacy'].includes(page),
    diagnostics: active && page === 'diagnostics',
    clock: active && ['network', 'phones', 'privacy'].includes(page)
  }
}

/** The collection owner settles downloads and invalidates remote rows before readback. */
export async function signOutAndReadInventory<T extends { signedIn: boolean }>(
  signOut: (() => Promise<boolean>) | undefined,
  readStatus: () => Promise<T>
): Promise<{ complete: boolean; status: T }> {
  const signedOut = signOut ? await signOut() : false
  const status = await readStatus()
  return { complete: signedOut && !status.signedIn, status }
}
