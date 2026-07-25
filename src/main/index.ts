import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import type { RegisterResult, SeparationProgress } from '../shared/types'
import { allowFile, allowRoot, isAllowed, stemsRoot } from './media'
import { Separator } from './separation'

const AUDIO_EXT = new Set([
  '.mp3',
  '.wav',
  '.flac',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.aif',
  '.aiff'
])

const separator = new Separator()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#12100d',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 17 } }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('source:register', async (_e, raw: string): Promise<RegisterResult> => {
    try {
      const full = resolve(String(raw))
      const ext = extname(full).toLowerCase()
      if (!AUDIO_EXT.has(ext)) {
        return { ok: false, error: `Can't use ${ext || 'that file'} — drop an MP3, WAV, FLAC or M4A.` }
      }
      const info = await stat(full)
      if (!info.isFile()) return { ok: false, error: 'That is not a file.' }
      allowFile(full)
      return { ok: true, path: full, name: basename(full, ext), size: info.size }
    } catch {
      return { ok: false, error: 'Could not read that file.' }
    }
  })

  // Audio bytes travel over IPC (fetch() from a file:// page can't reach
  // custom protocols, so a URL-based approach breaks in production builds).
  ipcMain.handle('media:read', async (_e, raw: string): Promise<ArrayBuffer> => {
    const full = resolve(String(raw))
    if (!isAllowed(full)) throw new Error('File is not registered.')
    const buf = await readFile(full)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  })

  ipcMain.handle('engine:check', (_e, force?: boolean) => separator.check(Boolean(force)))

  ipcMain.handle('separation:start', async (e, raw: string) => {
    const full = resolve(String(raw))
    if (!isAllowed(full)) return { ok: false, error: 'File is not registered.' }
    const send = (p: SeparationProgress): void => {
      if (!e.sender.isDestroyed()) e.sender.send('separation:progress', p)
    }
    return separator.separate(full, send)
  })

  ipcMain.handle('separation:cancel', () => separator.cancel())

  ipcMain.handle('stems:reveal', (_e, raw: string) => {
    const full = resolve(String(raw))
    if (isAllowed(full)) shell.showItemInFolder(full)
  })

  ipcMain.handle('open-external', (_e, raw: string) => {
    const url = new URL(String(raw))
    if (url.protocol === 'https:') void shell.openExternal(url.toString())
  })
}

app.whenReady().then(() => {
  allowRoot(stemsRoot())
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => separator.cancel())

app.on('window-all-closed', () => {
  separator.cancel()
  if (process.platform !== 'darwin') app.quit()
})
