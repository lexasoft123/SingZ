import { dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { constants } from 'node:fs'
import { copyFile, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadCaptureBinding, type NativeCaptureBinding } from './capture'
import { isAllowed } from './media'
import { log } from './log'

/** The UI passes files and format; every audio operation belongs to zcore. */
export function registerStemExport(): void {
  const sessions = new Map<string, { owner: number; folder: string; job?: string; binding?: NativeCaptureBinding }>()
  const finish = (token: string): void => {
    const session = sessions.get(token)
    if (session?.job) session.binding?.cancelAudioExport?.(session.job)
    sessions.delete(token)
  }
  ipcMain.handle('stems:export-begin', async (event) => {
    try {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      if (result.canceled || !result.filePaths[0]) return { ok: false }
      const token = randomUUID()
      sessions.set(token, { owner: event.sender.id, folder: result.filePaths[0] })
      event.sender.once('destroyed', () => finish(token))
      return { ok: true, token }
    } catch (error) { return { ok: false, error: String(error) } }
  })
  ipcMain.handle('stems:export-end', (event, token: string) => {
    if (sessions.get(token)?.owner === event.sender.id) finish(token)
  })
  ipcMain.handle('stems:export-write', async (event, token: string, name: string, format: 'wav' | 'flac' | 'mp3', sourcePath: string | string[]) => {
    let scratch: string | undefined
    const sources: Awaited<ReturnType<typeof open>>[] = []
    let destination: Awaited<ReturnType<typeof open>> | undefined
    let session: ReturnType<typeof sessions.get>
    try {
      const candidate = sessions.get(token)
      if (!candidate || candidate.owner !== event.sender.id || candidate.job) throw new Error('Export session unavailable')
      session = candidate
      const paths = Array.isArray(sourcePath) ? sourcePath : [sourcePath]
      if (!['wav', 'flac', 'mp3'].includes(format) || !paths.length || paths.length > 64 || paths.some(path => typeof path !== 'string' || !isAllowed(path))) throw new Error('Invalid export source or format')
      const binding = loadCaptureBinding()
      if (!binding.exportAudio || !binding.cancelAudioExport) throw new Error('Native audio export is unavailable; rebuild the audio core')
      const safeName = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'track'
      const outputPath = join(session.folder, `${safeName}.${format}`)
      session.job = randomUUID()
      session.binding = binding
      scratch = await mkdtemp(join(tmpdir(), 'singz-export-'))
      const staging = join(scratch, `track.${format}`)
      for (const sourcePath of paths) {
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
      destination = await open(staging, 'wx')
      if (!sessions.has(token)) throw new Error('Export cancelled')
      const result = await binding.exportAudio(Array.isArray(sourcePath) ? sources.map(source => source.fd) : sources[0].fd, destination.fd, format, session.job)
      if (!result.ok) throw new Error(result.error)
      if (!sessions.has(token)) throw new Error('Export cancelled')
      await destination.close(); destination = undefined
      // Exclusive creation preserves anything already in the chosen folder.
      await copyFile(staging, outputPath, constants.COPYFILE_EXCL)
      log('export', `track exported: ${outputPath}`)
      return { ok: true }
    } catch (error) { return { ok: false, error: String(error) } }
    finally {
      if (session) { session.job = undefined; session.binding = undefined }
      await Promise.all(sources.map(source => source.close().catch(() => {})))
      await destination?.close().catch(() => {})
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {})
    }
  })
}
