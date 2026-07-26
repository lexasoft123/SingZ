import { app, net } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '../shared/types'
import { log } from './log'

const RELEASES_LATEST = 'https://api.github.com/repos/lexasoft123/SingZ/releases/latest'
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

let current: UpdateState = { state: 'none' }
let notify: (s: UpdateState) => void = () => {}

function set(s: UpdateState): void {
  current = s
  notify(s)
}

export function updateState(): UpdateState {
  return current
}

function appVersion(): string {
  return process.env.SINGZ_FAKE_VERSION ?? app.getVersion()
}

function newer(tag: string, base: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const [a, b] = [parse(tag), parse(base)]
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

/** macOS/Linux: unsigned builds can't self-install — offer the download instead. */
async function checkViaGithub(): Promise<void> {
  set({ state: 'checking' })
  try {
    const res = await net.fetch(RELEASES_LATEST, {
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const rel = (await res.json()) as { tag_name?: string; html_url?: string }
    const tag = rel.tag_name ?? ''
    if (tag && newer(tag, appVersion())) {
      log('updater', `update available: ${tag} (running ${appVersion()})`)
      set({ state: 'available', version: tag.replace(/^v/, ''), url: rel.html_url ?? 'https://github.com/lexasoft123/SingZ/releases/latest' })
    } else {
      log('updater', `up to date (${appVersion()}, latest ${tag || 'unknown'})`)
      set({ state: 'none' })
    }
  } catch (err) {
    log('updater', `check failed: ${String(err)}`, 'warn')
    set({ state: 'error', message: String(err) })
  }
}

/** Windows: full electron-updater flow — download in background, install on restart. */
let updaterWired = false

function checkViaElectronUpdater(): void {
  const { autoUpdater } = electronUpdater
  if (updaterWired) {
    void autoUpdater.checkForUpdates().catch(() => {})
    return
  }
  updaterWired = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    log('updater', `update available: ${info.version} — downloading`)
    set({ state: 'downloading', version: info.version, percent: 0 })
  })
  autoUpdater.on('download-progress', (p) =>
    set({ state: 'downloading', version: '', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => {
    log('updater', `update ${info.version} downloaded — restart to install`)
    set({ state: 'ready', version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    log('updater', `up to date (${app.getVersion()})`)
    set({ state: 'none' })
  })
  autoUpdater.on('error', (err) => {
    log('updater', `updater error: ${String(err)}`, 'warn')
    set({ state: 'error', message: String(err) })
  })
  void autoUpdater.checkForUpdates().catch(() => {})
}

export function installUpdate(): void {
  if (process.platform === 'win32' && current.state === 'ready') {
    electronUpdater.autoUpdater.quitAndInstall()
  }
}

export function startUpdater(onState: (s: UpdateState) => void): void {
  notify = onState
  const testMode = Boolean(process.env.SINGZ_TEST_UPDATER)
  if (!app.isPackaged && !testMode) return
  const check = (): void => {
    if (process.platform === 'win32' && !testMode) checkViaElectronUpdater()
    else void checkViaGithub()
  }
  setTimeout(check, 3000)
  setInterval(check, CHECK_EVERY_MS)
}
