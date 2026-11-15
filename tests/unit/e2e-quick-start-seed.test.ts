import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const { seedQuickStartInMain, QUICK_START_KEY } = createRequire(import.meta.url)('../e2e/mac/quiet-launch.cjs') as {
  seedQuickStartInMain: (electron: unknown, key: string) => Promise<void>
  QUICK_START_KEY: string
}

/** A page whose localStorage the injected script really runs against, with the load/reload events of a BrowserWindow. */
function fakeWindow(initial: Record<string, string>, url = 'file:///app/index.html', startLoading = false) {
  const storage = new Map(Object.entries(initial))
  const events = new EventEmitter()
  let loading = startLoading
  const wc = {
    reloads: 0,
    getURL: () => url,
    isLoading: () => loading,
    once: (name: string, fn: () => void) => { events.once(name, fn) },
    reload() { wc.reloads++; loading = true; setTimeout(() => { events.emit('did-finish-load'); loading = false }, 5) }, // isLoading() is still true inside the event, as in Electron
    async executeJavaScript(code: string) {
      const localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) } }
      return new Function('localStorage', `return ${code}`)(localStorage)
    }
  }
  return { webContents: wc, storage }
}
const electron = (...windows: unknown[]) => ({ app: {}, BrowserWindow: { getAllWindows: () => windows } })

describe('e2e drivers: first-run quick-start seeding (quiet-launch)', () => {
  it('seeds the app flag on a fresh profile and reloads once, resolving after the reload', async () => {
    const w = fakeWindow({})
    await seedQuickStartInMain(electron(w), QUICK_START_KEY)
    expect(w.storage.get('singz.quick-start.v1')).toBe('seen')
    expect(w.webContents.reloads).toBe(1)
  })
  it('a window still loading is seeded from the load event even though isLoading() reads true inside it', async () => {
    const w = fakeWindow({}, 'file:///app/index.html', true)
    const run = seedQuickStartInMain(electron(w), QUICK_START_KEY)
    setTimeout(() => w.webContents.reload(), 10) // the initial load completing
    await run
    expect(w.storage.get('singz.quick-start.v1')).toBe('seen')
  })
  it('negative control: an already-seen profile is left alone (no reload)', async () => {
    const w = fakeWindow({ 'singz.quick-start.v1': 'seen' })
    await seedQuickStartInMain(electron(w), QUICK_START_KEY)
    expect(w.webContents.reloads).toBe(0)
  })
  it('does not write to a blank page (wrong origin) and waits for the app page to load', async () => {
    const w = fakeWindow({}, 'about:blank')
    const run = seedQuickStartInMain(electron(w), QUICK_START_KEY)
    await new Promise((r) => setTimeout(r, 20))
    expect(w.storage.size).toBe(0)
    ;(w.webContents as { getURL: () => string }).getURL = () => 'file:///app/index.html'
    // the app page finishes loading: the helper retries and seeds
    ;(w.webContents as { reload: () => void }).reload()
    await run
    expect(w.storage.get('singz.quick-start.v1')).toBe('seen')
  })
})
