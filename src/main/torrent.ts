import { app, BrowserWindow, ipcMain, session } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  RUTRACKER_ACCOUNT_SCRIPT,
  RUTRACKER_METADATA_BODY,
  RUTRACKER_ORIGIN,
  RUTRACKER_SEARCH_SCRIPT,
  ruTrackerSearchURL,
  validTorrentRequest,
  type TorrentRequest,
  type TorrentResult
} from '../shared/torrent'
import { allowFile } from './media'
import { log } from './log'

interface Addon {
  sourceStamp: string
  request(root: string, op: string, release: string, index: number, bytes?: Buffer): Promise<string>
  shutdown(root: string): void
}
let addon: Addon | null = null
let siteWindow: BrowserWindow | null = null
let serial: Promise<unknown> = Promise.resolve()
const require = createRequire(import.meta.url)
const partition = 'persist:singz-rutracker'
function root(): string {
  return join(app.getPath('userData'), 'torrent-downloads')
}
function native(): Addon {
  if (addon) return addon
  const path = app.isPackaged
    ? join(process.resourcesPath, 'engines', 'singz-torrent.node')
    : join(
        app.getAppPath(),
        'vendor',
        'torrent',
        process.platform + '-' + process.arch,
        'singz-torrent.node'
      )
  if (!existsSync(path))
    throw new Error(
      'Torrent engine is not installed. Build it with scripts/vendor-torrent.py and scripts/build-torrent-addon.cjs.'
    )
  const candidate = require(path) as Addon
  if (!app.isPackaged) {
    const expected = createHash('sha256')
      .update(readFileSync(join(app.getAppPath(), 'native/torrent/torrent_engine.cpp')))
      .digest('hex')
    if (candidate.sourceStamp !== expected)
      throw new Error(
        'The torrent addon is stale. Rebuild it with scripts/build-torrent-addon.cjs.'
      )
  }
  addon = candidate
  return candidate
}
function trusted(url: string): boolean {
  try {
    const u = new URL(url)
    return u.origin === RUTRACKER_ORIGIN
  } catch {
    return false
  }
}
function createSite(visible = false, parent?: BrowserWindow): BrowserWindow {
  const win = new BrowserWindow({
    width: 900,
    height: 740,
    show: visible,
    autoHideMenuBar: true,
    title: 'Sign in to RuTracker',
    ...(parent ? { parent, modal: true } : {}),
    webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!trusted(url)) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (!trusted(url)) event.preventDefault()
  })
  return win
}
async function load(win: BrowserWindow, url: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      win.loadURL(url),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          if (!win.isDestroyed()) win.webContents.stop()
          reject(new Error('Could not reach RuTracker. Check your connection and try again.'))
        }, 40000)
      })
    ])
  } catch {
    throw new Error('Could not load RuTracker. Check your connection and try again.')
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  if (!trusted(win.webContents.getURL()))
    throw new Error('RuTracker redirected to another site. The request was stopped.')
}
async function page(url: string, script: string): Promise<unknown> {
  // One hidden site browser preserves its real cookies and DOM encoding.
  if (!siteWindow || siteWindow.isDestroyed()) siteWindow = createSite()
  await load(siteWindow, url)
  return siteWindow.webContents.executeJavaScript(script)
}
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = serial.then(work, work)
  serial = next.catch(() => {})
  return next
}
async function connect(parent?: BrowserWindow): Promise<{ connected: boolean }> {
  const win = createSite(true, parent)
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (connected: boolean): void => {
      if (done) return
      done = true
      if (!win.isDestroyed()) win.close()
      resolve({ connected })
    }
    win.on('closed', () => finish(false))
    win.webContents.on('did-finish-load', () => {
      void win.webContents
        .executeJavaScript(RUTRACKER_ACCOUNT_SCRIPT)
        .then((connected) => {
          if (connected === true) finish(true)
        })
        .catch(() => {})
    })
    void load(win, RUTRACKER_ORIGIN + '/forum/login.php').catch((error) => {
      if (done) return
      done = true
      if (!win.isDestroyed()) win.close()
      reject(error)
    })
  })
}

async function metadata(release: string): Promise<Buffer> {
  const script =
    '(async()=>{const topic=' + JSON.stringify(release) + ';' + RUTRACKER_METADATA_BODY + '})()'
  const base64 = await enqueue(() => page(RUTRACKER_ORIGIN + '/forum/index.php', script))
  if (typeof base64 !== 'string' || base64.length > 24 * 1024 * 1024)
    throw new Error('Invalid torrent metadata.')
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > 16 * 1024 * 1024 || bytes[0] !== 100)
    throw new Error('Invalid torrent metadata.')
  return bytes
}

async function request(input: TorrentRequest, parent?: BrowserWindow): Promise<TorrentResult> {
  try {
    if (input.op === 'connect') return { ok: true, data: await enqueue(() => connect(parent)) }
    if (input.op === 'account') {
      const cookies = await session
        .fromPartition(partition)
        .cookies.get({ url: RUTRACKER_ORIGIN + '/forum/' })
      return {
        ok: true,
        data: {
          connected: cookies.some((cookie) => cookie.name === 'bb_data' && cookie.value.length > 0)
        }
      }
    }
    if (input.op === 'logout') {
      await enqueue(async () => {
        if (siteWindow && !siteWindow.isDestroyed()) siteWindow.close()
        siteWindow = null
        await session
          .fromPartition(partition)
          .clearStorageData({ storages: ['cookies', 'localstorage'] })
      })
      return { ok: true, data: { connected: false } }
    }
    if (input.op === 'search')
      return JSON.parse(
        String(
          await enqueue(() =>
            page(ruTrackerSearchURL(input.query, input.offset), RUTRACKER_SEARCH_SCRIPT)
          )
        )
      ) as TorrentResult
    const op = input.op === 'files' ? 'inspect' : input.op
    const release = 'release' in input ? input.release : ''
    const index = 'index' in input ? input.index : -1
    const bytes = input.op === 'files' ? await metadata(input.release) : undefined
    const result = JSON.parse(
      await native().request(root(), op, release, index, bytes)
    ) as TorrentResult
    if (result.ok && input.op === 'consume') {
      const file = result.data as { path: string }
      allowFile(file.path)
    }
    if (['start', 'pause', 'resume', 'cancel', 'consume'].includes(input.op))
      log(
        'torrent',
        input.op + (result.ok ? ' completed' : ' failed'),
        result.ok ? 'info' : 'error'
      )
    return result
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Torrent operation failed' }
  }
}
export function registerTorrent(): void {
  // Cancel browser-triggered downloads. Metadata is fetched explicitly above;
  // all song payloads belong to the C++ job, never Electron's Downloads folder.
  const siteSession = session.fromPartition(partition)
  siteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  siteSession.setPermissionCheckHandler(() => false)
  siteSession.setDevicePermissionHandler(() => false)
  siteSession.on('will-download', (event) => event.preventDefault())
  ipcMain.handle('torrent:request', (event, input: unknown) => {
    if (!validTorrentRequest(input)) return { ok: false, error: 'Invalid torrent request' }
    return request(input, BrowserWindow.fromWebContents(event.sender) ?? undefined)
  })
}
export function shutdownTorrent(): void {
  if (siteWindow && !siteWindow.isDestroyed()) siteWindow.close()
  addon?.shutdown(root())
}
