import { dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { constants, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { copyFile, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { desktopAudioProcess } from './audio-process'
import { isAllowed } from './media'
import { log } from './log'

interface ExportSession {
  owner: number
  folder: string
  job?: string
  cancelled: boolean
  abort: AbortController | null
  removeDestroyed: () => void
}

/** The UI passes files and format; every audio operation belongs to zcore. */
export function registerStemExport(): void {
  const sessions = new Map<string, ExportSession>()
  const finish = (token: string): void => {
    const session = sessions.get(token)
    if (!session) return
    sessions.delete(token)
    session.cancelled = true
    session.abort?.abort()
    session.removeDestroyed()
    if (session.job) void desktopAudioProcess.call('binding', 'cancelAudioExport', [session.job]).catch(() => {})
  }
  ipcMain.handle('stems:export-begin', async (event) => {
    try {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      if (result.canceled || !result.filePaths[0] || event.sender.isDestroyed()) return { ok: false }
      const token = randomUUID()
      const sender = event.sender
      const destroyed = (): void => finish(token)
      sessions.set(token, {
        owner: sender.id,
        folder: result.filePaths[0],
        cancelled: false,
        abort: null,
        removeDestroyed: () => sender.removeListener('destroyed', destroyed)
      })
      sender.once('destroyed', destroyed)
      return { ok: true, token }
    } catch (error) { return { ok: false, error: String(error) } }
  })
  ipcMain.handle('stems:export-end', (event, token: string) => {
    if (sessions.get(token)?.owner === event.sender.id) finish(token)
  })
  ipcMain.handle('stems:export-write', async (event, token: string, name: string, format: 'wav' | 'flac' | 'mp3', sourcePath: string | string[]) => {
    let scratch: string | undefined
    const sources: Awaited<ReturnType<typeof open>>[] = []
    let session: ExportSession | undefined
    let job = ''
    try {
      const candidate = sessions.get(token)
      if (!candidate || candidate.owner !== event.sender.id || candidate.job || candidate.cancelled)
        throw new Error('Export session unavailable')
      session = candidate
      const paths = Array.isArray(sourcePath) ? sourcePath : [sourcePath]
      if (!['wav', 'flac', 'mp3'].includes(format) || !paths.length || paths.length > 64 ||
          paths.some(path => typeof path !== 'string' || !isAllowed(path)))
        throw new Error('Invalid export source or format')
      const safeName = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'track'
      const outputPath = join(session.folder, `${safeName}.${format}`)
      job = session.job = randomUUID()
      const abort = session.abort = new AbortController()
      const active = (): boolean => sessions.get(token) === session && !session!.cancelled && session!.job === job
      scratch = await mkdtemp(join(tmpdir(), 'singz-export-'))
      const staging = join(scratch, `track.${format}`)
      for (const sourcePath of paths) {
        if (!active()) throw new Error('Export cancelled')
        try {
          sources.push(await open(sourcePath, 'r'))
        } catch (error) {
          // Auto-save may compact a legacy stem while the export dialog is open.
          const compact = sourcePath.replace(/\.wav$/i, '.flac')
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' ||
              !/[\\/]stems[\\/](vocals|drums|bass|other|guitar|piano)\.wav$/i.test(sourcePath) ||
              !isAllowed(compact)) throw error
          sources.push(await open(compact, 'r'))
        }
      }
      // Snapshot the already authorized, opened descriptors into private files.
      // File descriptor integers are process-local; forwarding them would open
      // unrelated files in the helper. Stream snapshots to keep memory bounded.
      const snapshots: string[] = []
      for (const [index, source] of sources.entries()) {
        if (!active()) throw new Error('Export cancelled')
        const snapshot = join(scratch, `source-${index}`)
        await pipeline(
          source.createReadStream({ autoClose: false }),
          createWriteStream(snapshot, { flags: 'wx' }),
          { signal: abort.signal }
        )
        snapshots.push(snapshot)
      }
      if (!active()) throw new Error('Export cancelled')
      const result = await desktopAudioProcess.call<{ ok: boolean; error?: string }>('export', 'paths', [snapshots, staging, format, job])
      if (!result.ok) throw new Error(result.error || 'Audio export failed')
      if (!active()) throw new Error('Export cancelled')
      // Exclusive creation preserves anything already in the chosen folder.
      await copyFile(staging, outputPath, constants.COPYFILE_EXCL)
      if (!active()) {
        await rm(outputPath, { force: true }).catch(() => {})
        throw new Error('Export cancelled')
      }
      log('export', `track exported: ${outputPath}`)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: session?.cancelled ? 'Export cancelled' : String(error) }
    } finally {
      if (session?.job === job) session.job = undefined
      if (session) session.abort = null
      await Promise.all(sources.map(source => source.close().catch(() => {})))
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {})
    }
  })
}
