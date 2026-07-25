import { app } from 'electron'
import { access, copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import {
  STEMS,
  STEMS_6,
  type ProjectInfo,
  type ProjectListItem,
  type ProjectSettings,
  type StemName6
} from '../shared/types'
import { log } from './log'
import { stemsRoot } from './media'
import { hashFile } from './separation'

/** User-visible project library: ~/Documents/SingZ/<song name>/ */
export function projectsRoot(): string {
  return join(app.getPath('documents'), 'SingZ')
}

/** Projects lived in ~/Music/SingZ before 0.2.4 — move them over once. */
export async function migrateProjects(): Promise<void> {
  const legacy = join(app.getPath('music'), 'SingZ')
  if (!(await exists(legacy))) return
  try {
    if (!(await exists(projectsRoot()))) {
      await rename(legacy, projectsRoot())
      log('app', `moved project library ${legacy} → ${projectsRoot()}`)
      return
    }
    // both exist: move over what doesn't collide, leave the rest in place
    for (const entry of await readdir(legacy, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dest = join(projectsRoot(), entry.name)
      if (await exists(dest)) continue
      await rename(join(legacy, entry.name), dest)
      log('app', `moved project "${entry.name}" to ${projectsRoot()}`)
    }
  } catch (err) {
    log('app', `project migration failed: ${err instanceof Error ? err.message : String(err)}`, 'warn')
  }
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

async function readMeta(dir: string): Promise<ProjectFile | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')) as ProjectFile
  } catch {
    return null
  }
}

/** Saved projects, newest first — the in-app library the Open screen shows. */
export async function listProjects(): Promise<{ root: string; projects: ProjectListItem[] }> {
  const root = projectsRoot()
  const projects: ProjectListItem[] = []
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      const meta = await readMeta(dir)
      if (!meta) continue
      const songPath = join(dir, meta.songFile)
      if (!(await exists(songPath))) continue
      let hasStems = true
      for (const s of STEMS) {
        if (!(await exists(join(dir, 'stems', `${s}.wav`)))) hasStems = false
      }
      projects.push({
        dir,
        name: meta.name ?? entry.name,
        songPath,
        savedAt: meta.savedAt ?? '',
        hasStems,
        hasLyrics: await exists(join(dir, 'lyrics.json'))
      })
    }
  } catch {
    // no library yet
  }
  projects.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
  return { root, projects }
}

/** If the song sits inside a project folder, describe what that project has. */
export async function detectProject(songPath: string): Promise<ProjectInfo | null> {
  const dir = dirname(songPath)
  const metaPath = join(dir, 'project.json')
  if (!(await exists(metaPath))) return null
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as ProjectFile
    const stems: Partial<Record<StemName6, string>> = {}
    for (const s of STEMS_6) {
      const p = join(dir, 'stems', `${s}.wav`)
      if (await exists(p)) stems[s] = p
    }
    const coreThere = STEMS.every((s) => Boolean(stems[s]))
    return {
      dir,
      name: meta.name ?? basename(dir),
      settings: meta.settings ?? { transpose: 0, tracks: {} },
      stems: coreThere ? stems : undefined,
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
): Promise<{ ok: true; dir: string; songPath: string } | { ok: false; error: string }> {
  try {
    const dir = join(projectsRoot(), safeName(name))
    await mkdir(join(dir, 'stems'), { recursive: true })

    const songFile = `song${extname(songPath).toLowerCase()}`
    const songDest = join(dir, songFile)
    if (songDest !== songPath && !(await exists(songDest))) {
      await copyFile(songPath, songDest)
    }

    // processed stems from the hash cache (if the song has been split);
    // the six-stem split wins when both exist — it is a superset
    const hashDir = join(stemsRoot(), await hashFile(songPath))
    const sixDir = join(hashDir, 'htdemucs_6s')
    const useSix = await exists(join(sixDir, 'vocals.wav'))
    const cacheDir = useSix ? sixDir : join(hashDir, 'htdemucs')
    for (const s of useSix ? STEMS_6 : STEMS) {
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
    log('app', `project saved: ${dir}`)
    return { ok: true, dir, songPath: songDest }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Rename a saved project: folder, metadata and (via the folder) every file
 * path in it. Only valid when the song lives inside a project folder.
 */
export async function renameProject(
  songPath: string,
  newName: string
): Promise<
  | {
      ok: true
      name: string
      dir: string
      songPath: string
      stems?: Partial<Record<StemName6, string>>
    }
  | { ok: false; error: string }
> {
  try {
    const oldDir = dirname(songPath)
    const meta = await readMeta(oldDir)
    if (!meta) return { ok: false, error: 'This song is not a saved project yet.' }
    const name = safeName(newName)
    const newDir = join(projectsRoot(), name)
    if (newDir !== oldDir && (await exists(newDir))) {
      return { ok: false, error: `A project called “${name}” already exists.` }
    }
    if (newDir !== oldDir) await rename(oldDir, newDir)
    meta.name = name
    await writeFile(join(newDir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
    const stems: Partial<Record<StemName6, string>> = {}
    for (const s of STEMS_6) {
      const p = join(newDir, 'stems', `${s}.wav`)
      if (await exists(p)) stems[s] = p
    }
    const coreThere = STEMS.every((s) => Boolean(stems[s]))
    log('app', `project renamed: ${oldDir} → ${newDir}`)
    return {
      ok: true,
      name,
      dir: newDir,
      songPath: join(newDir, meta.songFile),
      stems: coreThere ? stems : undefined
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
