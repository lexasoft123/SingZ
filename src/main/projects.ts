import { app } from 'electron'
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { STEMS, type ProjectInfo, type ProjectSettings, type StemName } from '../shared/types'
import { stemsRoot } from './media'
import { hashFile } from './separation'

/** User-visible project library: ~/Music/SingZ/<song name>/ */
export function projectsRoot(): string {
  return join(app.getPath('music'), 'SingZ')
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function safeName(name: string): string {
  const cleaned = name
    .replace(/\.[^.]+$/, '')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return cleaned || 'Untitled song'
}

interface ProjectFile {
  version: 1
  name: string
  songFile: string
  savedAt: string
  settings: ProjectSettings
}

/** If the song sits inside a project folder, describe what that project has. */
export async function detectProject(songPath: string): Promise<ProjectInfo | null> {
  const dir = dirname(songPath)
  const metaPath = join(dir, 'project.json')
  if (!(await exists(metaPath))) return null
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as ProjectFile
    const stems = {} as Record<StemName, string>
    let allStems = true
    for (const s of STEMS) {
      const p = join(dir, 'stems', `${s}.wav`)
      if (await exists(p)) stems[s] = p
      else allStems = false
    }
    return {
      dir,
      name: meta.name ?? basename(dir),
      settings: meta.settings ?? { transpose: 0, tracks: {} },
      stems: allStems ? stems : undefined,
      hasLyrics: await exists(join(dir, 'lyrics.json'))
    }
  } catch {
    return null
  }
}

/** Project-local lyrics file, when the song lives inside a project. */
export async function projectLyricsPath(songPath: string): Promise<string | null> {
  const dir = dirname(songPath)
  return (await exists(join(dir, 'project.json'))) ? join(dir, 'lyrics.json') : null
}

export async function saveProject(
  songPath: string,
  name: string,
  settings: ProjectSettings
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  try {
    const dir = join(projectsRoot(), safeName(name))
    await mkdir(join(dir, 'stems'), { recursive: true })

    const songFile = `song${extname(songPath).toLowerCase()}`
    const songDest = join(dir, songFile)
    if (songDest !== songPath && !(await exists(songDest))) {
      await copyFile(songPath, songDest)
    }

    // processed stems from the hash cache (if the song has been split)
    const cacheDir = join(stemsRoot(), await hashFile(songPath), 'htdemucs')
    for (const s of STEMS) {
      const src = join(cacheDir, `${s}.wav`)
      const dst = join(dir, 'stems', `${s}.wav`)
      if ((await exists(src)) && !(await exists(dst))) await copyFile(src, dst)
    }

    // lyrics from the hash cache (project-local lyrics stay as they are)
    const cachedLyrics = join(stemsRoot(), await hashFile(songPath), 'lyrics.json')
    const projLyrics = join(dir, 'lyrics.json')
    if ((await exists(cachedLyrics)) && !(await exists(projLyrics))) {
      await copyFile(cachedLyrics, projLyrics)
    }

    const meta: ProjectFile = {
      version: 1,
      name: safeName(name),
      songFile,
      savedAt: new Date().toISOString(),
      settings
    }
    await writeFile(join(dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
    return { ok: true, dir }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
