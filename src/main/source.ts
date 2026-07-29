import { stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { RegisterResult } from '../shared/types'
import { allowFile, allowRoot } from './media'
import { detectProject } from './projects'

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

/**
 * Make a dropped/picked song readable and describe the project around it.
 *
 * A project folder does not have to sit under the configured library root —
 * copied, shared and other-machine folders open from anywhere — so when one is
 * detected the whole folder is allowlisted, not just the song. Its stems,
 * lyrics and the FLAC files a later v2 upgrade writes all live there, and
 * media:read rejects anything unregistered.
 */
export async function registerSource(raw: string): Promise<RegisterResult> {
  try {
    const full = resolve(String(raw))
    const ext = extname(full).toLowerCase()
    if (!AUDIO_EXT.has(ext)) {
      return { ok: false, error: `Can't use ${ext || 'that file'} — drop an MP3, WAV, FLAC or M4A.` }
    }
    const info = await stat(full)
    if (!info.isFile()) return { ok: false, error: 'That is not a file.' }
    allowFile(full)
    const project = await detectProject(full)
    if (project) allowRoot(project.dir)
    return {
      ok: true,
      path: full,
      name: project?.name ?? basename(full, ext),
      size: info.size,
      project: project ?? undefined
    }
  } catch {
    return { ok: false, error: 'Could not read that file.' }
  }
}
