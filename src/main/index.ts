import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, shell, systemPreferences } from 'electron'
import { loadWindowState, trackWindowState } from './window-state'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { LyricsProgress, SeparationProgress } from '../shared/types'
import { searchCandidates } from './lrclib'
import { preciseCapable } from './align-mms'
import { Transcriber } from './lyrics'
import { ModelManager } from './models'
import {
  deleteProject,
  getStorage,
  importProject,
  listProjects,
  migrateProjects,
  migrateProjectToV2,
  projectsRoot,
  renameProject,
  saveProject,
  setProjectsRoot
} from './projects'
import { gdriveConfigured, gdriveSignedIn, gdriveSignIn, gdriveSignOut, gdriveSync } from './gdrive'
import { readSettings } from './settings'
import { hashFile, writeInputWav } from './separation'
import type { ModelsProgress, ProjectSettings } from '../shared/types'
import { allowRoot, isAllowed, stemsRoot } from './media'
import { registerSource, registerTrack } from './source'
import { log, logEntries, saveLog } from './log'
import { clearDirty, dirtyDirs, dirtySeq, dirtyState, isDirty, markProjectDirty, onDirty } from './sync-dirty'
import { replaySyncLog, syncLog } from './sync-log'
import { SyncScheduler } from './sync-scheduler'
import { logHardwareInfo } from './hwinfo'
import { installUpdate, startUpdater, updateState } from './updater'
import { cleanupObsoleteModels, dmlFlagPath, modelsDir, packDir, trtrtxFlagPath } from './models'
import { Separator } from './separation'
import { cancelBeatsMl, registerBeatsIpc } from './beats-ml'

// Test hook: fake microphone input so E2E drivers can exercise pitch matching.
if (process.env.SINGZ_FAKE_MIC) {
  app.commandLine.appendSwitch('use-fake-device-for-media-capture')
  app.commandLine.appendSwitch('use-fake-ui-for-media-capture')
}

// Test hook: automated runs are silent — Chromium mutes the audio device
// while the graph (analysers, sinkId, timing) behaves exactly as audible.
if (process.env.SINGZ_MUTE) {
  app.commandLine.appendSwitch('mute-audio')
}

// Test hook: isolate userData — concurrent E2E drivers (or a driver next to
// a dev instance) sharing the default "Electron" profile crash each other's
// renderers. Shared caches (models, GPU pack) stay in appData/SingZ.
if (process.env.SINGZ_USERDATA_DIR) {
  app.setPath('userData', resolve(process.env.SINGZ_USERDATA_DIR))
}

const separator = new Separator()
const transcriber = new Transcriber()
const modelManager = new ModelManager()

/** Every window hears about Drive: progress while a sync runs, and the state
 *  the badges read. One helper, because three copies of this loop drifted. */
function sendGdrive(channel: 'gdrive:progress' | 'gdrive:state', payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * The one thing that decides when to push. Nothing else in the app calls
 * gdriveSync: triggers mark the library dirty (sync-dirty.ts) and this
 * coalesces, retries and reports.
 */
const scheduler = new SyncScheduler({
  run: (onProgress) => gdriveSync({ onProgress, dirtyDirs: dirtyDirs() }),
  enabled: () => gdriveConfigured() && gdriveSignedIn(),
  dirty: {
    seq: dirtySeq,
    isDirty,
    count: () => (dirtyState().allSeq > 0 ? -1 : dirtyDirs().length),
    clear: clearDirty,
    remark: (dirs) => {
      for (const dir of dirs) markProjectDirty(dir, 'outside the library root')
    }
  },
  lastSync: () => readSettings().gdriveLastSync ?? null,
  now: () => Date.now(),
  // unref: a pending push must never be the reason the app stays alive
  timer: (ms, fn) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return () => clearTimeout(t)
  },
  onStatus: (s) => {
    if (s.phase === 'retrying') {
      syncLog('run', `retrying in ${Math.max(1, Math.round(((s.runAt ?? 0) - Date.now()) / 1000))}s — ${s.lastError}`)
    }
    if (s.phase === 'blocked') syncLog('error', `waiting for you: ${s.lastError}`)
    sendGdrive('gdrive:state', s)
  },
  onProgress: (msg, frac) => sendGdrive('gdrive:progress', { msg, frac }),
  debounceMs: process.env.SINGZ_SYNC_DEBOUNCE_MS ? Number(process.env.SINGZ_SYNC_DEBOUNCE_MS) : undefined
})

// a mark from anywhere (a save, the aligner, an import) wakes it
onDirty(() => scheduler.notifyDirty())

function createWindow(): void {
  const st = loadWindowState({ width: 1240, height: 820 })
  const win = new BrowserWindow({
    width: st.width,
    height: st.height,
    ...(st.x !== undefined && st.y !== undefined ? { x: st.x, y: st.y } : {}),
    minWidth: 940,
    minHeight: 600,
    show: false,
    ...(process.platform === 'darwin'
      ? {
          backgroundColor: '#12100d',
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 18, y: 17 }
        }
      : process.platform === 'win32'
        ? {
            // Fully frameless + transparent so the renderer can draw rounded
            // corners (Windows 10 never rounds native frames). Window buttons
            // are ours, wired over IPC.
            frame: false,
            transparent: true,
            backgroundColor: '#00000000'
          }
        : { backgroundColor: '#12100d' }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  trackWindowState(win)
  win.on('maximize', () => win.webContents.send('win:maximized', true))
  win.on('unmaximize', () => win.webContents.send('win:maximized', false))
  win.on('ready-to-show', () => {
    if (st.maximized) win.maximize()
    win.show()
  })
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
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize-toggle', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle('win:is-maximized', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false)
  ipcMain.handle('update:state', () => updateState())
  ipcMain.on('update:install', () => installUpdate())

  ipcMain.handle('splitter:mode', async () => {
    try {
      const j = JSON.parse(await readFile(dmlFlagPath(), 'utf8')) as { reason?: string }
      return { mode: 'cpu', reason: j.reason }
    } catch {
      return { mode: 'auto' }
    }
  })
  ipcMain.handle('splitter:set-mode', async (_e, mode: string) => {
    try {
      if (mode === 'cpu') {
        const chosen = JSON.stringify(
          { at: new Date().toISOString(), reason: 'chosen in the model manager' },
          null,
          2
        )
        await writeFile(dmlFlagPath(), chosen, 'utf8')
        // CPU-only means no GPU engine at all — the trtrtx rung too.
        await writeFile(trtrtxFlagPath(), chosen, 'utf8')
        log('splitter', 'engine set to CPU only (model manager)')
      } else {
        await rm(dmlFlagPath(), { force: true })
        await rm(trtrtxFlagPath(), { force: true })
        log('splitter', 'GPU re-enabled (model manager)')
      }
      void separator.check(true)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('source:register', (_e, raw: string) => registerSource(String(raw)))

  ipcMain.handle('track:register', (_e, raw: string) => registerTrack(String(raw)))

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

  // ML beat/downbeat analysis (Beat This! runner inside the splitter pack)
  registerBeatsIpc()

  ipcMain.handle(
    'lyrics:get',
    async (e, raw: string, durationSec: number, allowDownload: boolean, prefer: string) => {
      const full = resolve(String(raw))
      if (!isAllowed(full)) return { ok: false, error: 'File is not registered.' }
      const send = (p: LyricsProgress): void => {
        if (!e.sender.isDestroyed()) e.sender.send('lyrics:progress', p)
      }
      const res = await transcriber.resolve(
        full,
        Number(durationSec) || 0,
        Boolean(allowDownload),
        prefer === 'whisper' || prefer === 'align' || prefer === 'precise' ? prefer : 'auto',
        send
      )
      // Aligning rewrites a project's lyrics.json outside the save flow —
      // push it so Drive-synced phones get the new timing without waiting
      // for the next manual save (md5-diffed: uploads just the one file).
      return res
    }
  )

  ipcMain.handle('lyrics:align-caps', async () => ({ precise: await preciseCapable() }))

  ipcMain.handle(
    'lyrics:search',
    (_e, query: { artist?: string; title?: string; free?: string }, durationSec: number) =>
      searchCandidates(
        {
          artist: query?.artist ? String(query.artist) : undefined,
          title: query?.title ? String(query.title) : undefined,
          free: query?.free ? String(query.free) : undefined
        },
        Number(durationSec) || 0
      )
  )

  ipcMain.handle('lyrics:apply', (_e, raw: string, id: number, durationSec: number) => {
    const full = resolve(String(raw))
    if (!isAllowed(full)) return { ok: false, error: 'File is not registered.' }
    return transcriber.applyById(full, Number(id), Number(durationSec) || 0)
  })

  ipcMain.handle('lyrics:cancel', () => transcriber.cancel())

  ipcMain.handle('models:status', async () =>
    modelManager.status(await separator.hasFastSplitter())
  )

  ipcMain.handle('models:download', async (e, ids?: string[]) => {
    const send = (p: ModelsProgress): void => {
      if (!e.sender.isDestroyed()) e.sender.send('models:progress', p)
    }
    const result = await modelManager.downloadModels(
      await separator.hasFastSplitter(),
      send,
      Array.isArray(ids) && ids.length > 0 ? (ids as ModelsProgress['id'][]) : undefined
    )
    if (result.ok) void separator.check(true) // pick up freshly downloaded engines/weights
    return result
  })

  ipcMain.handle('models:cancel', () => modelManager.cancel())

  ipcMain.handle(
    'separation:provide-input',
    async (_e, raw: string, ch0: Float32Array, ch1: Float32Array) => {
      const full = resolve(String(raw))
      if (!isAllowed(full)) return
      const outDir = join(stemsRoot(), await hashFile(full))
      await writeInputWav(outDir, ch0, ch1)
    }
  )

  ipcMain.handle('project:save', async (_e, raw: string, name: string, settings: ProjectSettings) => {
    const full = resolve(String(raw))
    if (!isAllowed(full)) return { ok: false, error: 'File is not registered.' }
    const res = await saveProject(full, String(name), settings)
    // signed-in Drive users get their library pushed after every save
    // A quiet skip here cost a real debugging session: the save "worked" but
    // phones kept the old project — surface the signed-out state instead.
    if (res.ok && gdriveConfigured() && !gdriveSignedIn()) {
      return { ...res, driveSignedOut: true }
    }
    return res
  })

  ipcMain.handle('gdrive:status', () => ({
    configured: gdriveConfigured(),
    signedIn: gdriveConfigured() && gdriveSignedIn(),
    lastSync: readSettings().gdriveLastSync ?? null,
    sync: scheduler.status(),
    dirtyDirs: dirtyDirs()
  }))
  ipcMain.handle('gdrive:signin', async () => {
    const res = await gdriveSignIn()
    // the scheduler arms nothing while signed out; this is where a session that
    // started that way gets its launch reconcile and its sweep
    if (res.ok) scheduler.start()
    return res
  })
  ipcMain.handle('gdrive:signout', () => {
    gdriveSignOut()
    return { ok: true }
  })
  ipcMain.handle('gdrive:sync', () => scheduler.syncNow())

  ipcMain.handle('projects:list', () => listProjects())

  ipcMain.handle('project:rename', async (_e, raw: string, newName: string) => {
    const full = resolve(String(raw))
    if (!isAllowed(full)) return { ok: false, error: 'File is not registered.' }
    return renameProject(full, String(newName))
  })

  ipcMain.handle('project:import', async (_e, raw: string, mode: string) => {
    const full = resolve(String(raw))
    if (!isAllowed(full)) return { ok: false, error: 'File is not registered.' }
    return importProject(full, mode === 'move' ? 'move' : 'copy')
  })

  // No isAllowed gate here, unlike its neighbours: those act on the song the
  // renderer has open, while this acts on any card in the catalog — including
  // projects this session never opened, which are in no allowlist. Being
  // inside the library root and holding a project.json is the gate, and
  // deleteProject checks both.
  ipcMain.handle('project:delete', async (_e, raw: string) => deleteProject(resolve(String(raw))))

  ipcMain.handle('project:upgrade', async (_e, raw: string) => {
    const dir = resolve(String(raw))
    if (!isAllowed(dir)) return { ok: false, error: 'Folder is not registered.' }
    return migrateProjectToV2(dir)
  })

  ipcMain.handle('projects:storage', () => getStorage())

  ipcMain.handle('projects:set-root', async (_e, raw: unknown) => {
    const res = await setProjectsRoot(typeof raw === 'string' && raw ? resolve(raw) : null)
    if (res.ok) allowRoot(res.root)
    return res
  })

  ipcMain.handle('projects:choose-root', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const picked = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0], {
      title: 'Choose where SingZ keeps your projects',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true }
    const res = await setProjectsRoot(picked.filePaths[0])
    if (res.ok) allowRoot(res.root)
    return res
  })

  ipcMain.handle('app:version', () => (app.isPackaged ? app.getVersion() : 'dev'))

  ipcMain.handle('mic:ask', async () => {
    if (process.platform !== 'darwin') return true
    try {
      return await systemPreferences.askForMediaAccess('microphone')
    } catch {
      return false
    }
  })

  ipcMain.handle('stems:reveal', (_e, raw: string) => {
    const full = resolve(String(raw))
    if (isAllowed(full)) shell.showItemInFolder(full)
  })

  ipcMain.handle('open-external', (_e, raw: string) => {
    const url = new URL(String(raw))
    if (url.protocol === 'https:') void shell.openExternal(url.toString())
  })

  ipcMain.handle('log:all', () => logEntries())

  ipcMain.handle('log:save', (_e, path?: string) =>
    saveLog(typeof path === 'string' && path ? path : undefined)
  )
}

app.whenReady().then(async () => {
  log(
    'app',
    `SingZ ${app.isPackaged ? app.getVersion() : 'dev'} on ${process.platform}-${process.arch}` +
      ` — electron ${process.versions.electron}`
  )
  log('app', `userData: ${app.getPath('userData')}`)
  log('app', `models: ${modelsDir()} · pack: ${packDir()}`)
  logHardwareInfo()
  startUpdater((st) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('update:state', st)
    }
  })
  // macOS keeps its menu (⌘-shortcuts live there); elsewhere it's just noise
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  await migrateProjects()
  await cleanupObsoleteModels()
  allowRoot(stemsRoot())
  allowRoot(projectsRoot())
  registerIpc()
  createWindow()

  // Signed-in libraries reconcile on launch, not only after saves: analysis
  // The scheduler owns every automatic push from here: the launch reconcile
  // (a sync killed mid-run self-heals next start), the debounce that turns a
  // song-open burst into one run, backoff when Drive is unreachable, and a
  // periodic sweep for anything no writer thought to mark.
  // SINGZ_NO_SYNC keeps E2E runs off a dev machine's real Drive entirely;
  // SINGZ_NO_LAUNCH_SYNC is the older, narrower opt-out.
  // what previous sessions pushed, in the same dialog as everything else
  replaySyncLog()
  if (!process.env.SINGZ_NO_SYNC && !process.env.SINGZ_NO_LAUNCH_SYNC) scheduler.start()
  // Back from sleep: whatever backoff is armed was sized for a network that is
  // probably now fine, and waiting 30 minutes to find out is the wrong answer.
  powerMonitor.on('resume', () => scheduler.notifyWake())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  scheduler.stop()
  separator.cancel()
  transcriber.cancel()
  cancelBeatsMl()
})

app.on('window-all-closed', () => {
  separator.cancel()
  transcriber.cancel()
  cancelBeatsMl()
  if (process.platform !== 'darwin') app.quit()
})
