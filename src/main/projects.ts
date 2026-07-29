import { app } from 'electron'
import { existsSync, readdirSync } from 'node:fs'
import { access, cp, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, sep } from 'node:path'
import {
  STEMS,
  STEMS_6,
  type CloudRoot,
  type ImportResult,
  type ProjectInfo,
  type ProjectListItem,
  type ProjectSettings,
  type StemName6
} from '../shared/types'
import { wavToFlac } from './flac'
import { log } from './log'
import { allowRoot, stemsRoot } from './media'
import { hashFile } from './separation'
import { readSettings, writeSettings } from './settings'

/**
 * User-visible project library: ~/Documents/SingZ/<song name>/ by default,
 * relocatable (settings.json) into a cloud-synced folder — iCloud Drive /
 * Google Drive / OneDrive are plain folders to us; their apps do the syncing.
 */
export function projectsRoot(): string {
  const custom = readSettings().projectsRoot
  if (custom && existsSync(custom)) return custom
  return join(app.getPath('documents'), 'SingZ')
}

/**
 * Does this project folder sit inside the library root? Copied, shared and
 * other-machine folders open fine from anywhere, but they are not ours to
 * reorganise: they save and rename where they are until the user imports them.
 */
export function inLibrary(dir: string): boolean {
  const root = projectsRoot()
  return dir === root || dir.startsWith(root + sep)
}

/** Cloud-synced folders present on this machine (each proposes a SingZ subfolder). */
export function listCloudRoots(): CloudRoot[] {
  const home = app.getPath('home')
  const candidates: { label: string; base: string }[] = [
    { label: 'iCloud Drive', base: join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs') },
    { label: 'iCloud Drive', base: join(home, 'iCloudDrive') },
    { label: 'OneDrive', base: process.env.OneDrive ?? join(home, 'OneDrive') },
    { label: 'Google Drive', base: 'G:/My Drive' },
    { label: 'Google Drive', base: join(home, 'Google Drive') }
  ]
  // Modern Google Drive on macOS mounts under ~/Library/CloudStorage/GoogleDrive-<account>/
  try {
    const cloudStorage = join(home, 'Library', 'CloudStorage')
    for (const entry of readdirSync(cloudStorage)) {
      if (entry.startsWith('GoogleDrive-')) {
        candidates.push({ label: 'Google Drive', base: join(cloudStorage, entry, 'My Drive') })
      }
    }
  } catch {
    // no CloudStorage dir (non-mac or none mounted)
  }
  const seen = new Set<string>()
  const out: CloudRoot[] = []
  for (const c of candidates) {
    if (!existsSync(c.base) || seen.has(c.label)) continue
    seen.add(c.label)
    out.push({ label: c.label, path: join(c.base, 'SingZ') })
  }
  return out
}

export function getStorage(): { root: string; isDefault: boolean; cloud: CloudRoot[] } {
  const root = projectsRoot()
  return {
    root,
    isDefault: root === join(app.getPath('documents'), 'SingZ'),
    cloud: listCloudRoots()
  }
}

/**
 * Move the library to a new folder (null = back to Documents/SingZ).
 * Existing projects are copied (never deleted) so a half-synced cloud folder
 * can't lose anything; collisions keep whatever the target already has.
 */
export async function setProjectsRoot(
  path: string | null
): Promise<{ ok: true; root: string; copied: number } | { ok: false; error: string }> {
  try {
    const oldRoot = projectsRoot()
    const newRoot = path ?? join(app.getPath('documents'), 'SingZ')
    if (newRoot === oldRoot) return { ok: true, root: newRoot, copied: 0 }
    await mkdir(newRoot, { recursive: true })
    let copied = 0
    if (existsSync(oldRoot)) {
      for (const entry of await readdir(oldRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const src = join(oldRoot, entry.name)
        const dst = join(newRoot, entry.name)
        if (!(await exists(join(src, 'project.json'))) || (await exists(dst))) continue
        await cp(src, dst, { recursive: true })
        copied++
        log('app', `project copied to new library: ${entry.name}`)
      }
    }
    writeSettings({ projectsRoot: path ?? undefined })
    log('app', `project library is now ${newRoot}${copied ? ` (${copied} copied over)` : ''}`)
    return { ok: true, root: newRoot, copied }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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
    // strip only real audio extensions — "Mr. Crowley" must keep its second half
    .replace(/\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aif|aiff)$/i, '')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return cleaned || 'Untitled song'
}

interface ProjectFile {
  /** 1 = WAV stems (pre-0.7), 2 = FLAC stems (~4x smaller, cloud-friendly). */
  version: 1 | 2
  name: string
  songFile: string
  savedAt: string
  settings: ProjectSettings
}

/** Resolve a stem on disk: FLAC (v2) wins over WAV (v1) when both exist. */
async function stemFile(dir: string, stem: string): Promise<string | null> {
  const flac = join(dir, 'stems', `${stem}.flac`)
  if (await exists(flac)) return flac
  const wav = join(dir, 'stems', `${stem}.wav`)
  return (await exists(wav)) ? wav : null
}

/**
 * Convert every WAV stem to FLAC; the WAVs are deleted only after each
 * conversion verified (encoder writes .part then renames), so an interrupted
 * run leaves a playable project. Returns true when the project ends up
 * all-FLAC.
 */
async function convertStemsToFlac(dir: string): Promise<boolean> {
  let allFlac = true
  for (const s of STEMS_6) {
    const wav = join(dir, 'stems', `${s}.wav`)
    const flac = join(dir, 'stems', `${s}.flac`)
    if (!(await exists(wav))) continue
    if (!(await exists(flac))) {
      const res = await wavToFlac(wav, flac)
      if (!res.ok) {
        log('app', `stem ${s}: FLAC conversion failed — keeping WAV (${res.error})`, 'warn')
        allFlac = false
        continue
      }
      log('app', `stem ${s}: ${(res.bytes / 1e6).toFixed(1)} MB as FLAC`)
    }
    await rm(wav, { force: true })
  }
  return allFlac
}

/**
 * Upgrade a saved project to v2 (FLAC stems) in place. Safe to call on any
 * project: v2 and stemless projects return immediately.
 */
export async function migrateProjectToV2(
  dir: string
): Promise<{ ok: true; converted: boolean } | { ok: false; error: string }> {
  try {
    const meta = await readMeta(dir)
    if (!meta) return { ok: false, error: 'not a project folder' }
    if (meta.version >= 2) return { ok: true, converted: false }
    const hadWavs = await exists(join(dir, 'stems', 'vocals.wav'))
    const allFlac = await convertStemsToFlac(dir)
    if (!allFlac) return { ok: false, error: 'some stems could not be converted' }
    meta.version = 2
    await writeFile(join(dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
    if (hadWavs) log('app', `project upgraded to compact stems: ${dir}`)
    return { ok: true, converted: hadWavs }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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
      const found = new Set<string>()
      for (const s of STEMS_6) {
        if ((await stemFile(dir, s)) !== null) found.add(s)
      }
      projects.push({
        dir,
        name: meta.name ?? entry.name,
        songPath,
        savedAt: meta.savedAt ?? '',
        // playable = the core four exist; guitar/piano may be silent-hidden
        hasStems: STEMS.every((s) => found.has(s)),
        stemCount: found.size,
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
      const p = await stemFile(dir, s)
      if (p) stems[s] = p
    }
    const coreThere = STEMS.every((s) => Boolean(stems[s]))
    return {
      dir,
      name: meta.name ?? basename(dir),
      formatVersion: meta.version ?? 1,
      settings: meta.settings ?? { transpose: 0, tracks: {} },
      stems: coreThere ? stems : undefined,
      hasLyrics: await exists(join(dir, 'lyrics.json')),
      inLibrary: inLibrary(dir)
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
): Promise<
  { ok: true; dir: string; songPath: string; inLibrary: boolean } | { ok: false; error: string }
> {
  try {
    // A song already inside a project folder saves in place, wherever that
    // folder lives — saving a shared or cloud project must never fork a second
    // copy into the library. Only a loose song gets a new folder made for it.
    const own = dirname(songPath)
    const inPlace = await exists(join(own, 'project.json'))
    const dir = inPlace ? own : join(projectsRoot(), safeName(name))
    await mkdir(join(dir, 'stems'), { recursive: true })

    // in place, the opened song IS the project's song — keep its filename
    const songFile = inPlace ? basename(songPath) : `song${extname(songPath).toLowerCase()}`
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
      // an existing FLAC already carries this stem — don't resurrect the WAV
      if ((await exists(src)) && !(await exists(dst)) && !(await stemFile(dir, s))) {
        await copyFile(src, dst)
      }
    }

    // v2 on-disk format: stems live as FLAC (the splitter cache stays WAV)
    const allFlac = await convertStemsToFlac(dir)

    // lyrics from the hash cache (project-local lyrics stay as they are)
    const cachedLyrics = join(stemsRoot(), await hashFile(songPath), 'lyrics.json')
    const projLyrics = join(dir, 'lyrics.json')
    if ((await exists(cachedLyrics)) && !(await exists(projLyrics))) {
      await copyFile(cachedLyrics, projLyrics)
    }

    const meta: ProjectFile = {
      version: allFlac ? 2 : 1,
      name: safeName(name),
      songFile,
      savedAt: new Date().toISOString(),
      settings
    }
    await writeFile(join(dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
    log('app', `project saved: ${dir}`)
    return { ok: true, dir, songPath: songDest, inLibrary: inLibrary(dir) }
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
    // rename where the project lives (for a library project that is the root
    // itself) — renaming must never double as a move out of a shared folder
    const newDir = join(dirname(oldDir), name)
    if (newDir !== oldDir && (await exists(newDir))) {
      return { ok: false, error: `A project called “${name}” already exists.` }
    }
    if (newDir !== oldDir) await rename(oldDir, newDir)
    // the folder just moved — outside the library that lands on an unregistered
    // path, and every stem read after this would be refused
    allowRoot(newDir)
    meta.name = name
    await writeFile(join(newDir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
    const stems: Partial<Record<StemName6, string>> = {}
    for (const s of STEMS_6) {
      const p = await stemFile(newDir, s)
      if (p) stems[s] = p
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

/**
 * Bring a project opened from outside the library into it. 'copy' leaves the
 * original folder untouched (the safe default for a shared or cloud folder
 * someone else also uses); 'move' relocates it.
 */
export async function importProject(
  songPath: string,
  mode: 'copy' | 'move'
): Promise<ImportResult> {
  try {
    const src = dirname(songPath)
    const meta = await readMeta(src)
    if (!meta) return { ok: false, error: 'This song is not a saved project yet.' }
    if (inLibrary(src)) return { ok: false, error: 'This project is already in your library.' }

    const name = safeName(meta.name ?? basename(src))
    const dst = join(projectsRoot(), name)
    if (await exists(dst)) {
      return { ok: false, error: `A project called “${name}” is already in your library.` }
    }
    await mkdir(projectsRoot(), { recursive: true })

    if (mode === 'move') {
      try {
        await rename(src, dst)
      } catch (err) {
        // iCloud, a network share or a USB stick is a different volume, where
        // rename() can't reach — copy over, then drop the original.
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
        await cp(src, dst, { recursive: true })
        await rm(src, { recursive: true, force: true })
      }
    } else {
      await cp(src, dst, { recursive: true })
    }

    allowRoot(dst)
    const stems: Partial<Record<StemName6, string>> = {}
    for (const s of STEMS_6) {
      const p = await stemFile(dst, s)
      if (p) stems[s] = p
    }
    const coreThere = STEMS.every((s) => Boolean(stems[s]))
    log('app', `project ${mode === 'move' ? 'moved' : 'copied'} into the library: ${src} → ${dst}`)
    return {
      ok: true,
      dir: dst,
      songPath: join(dst, meta.songFile),
      stems: coreThere ? stems : undefined,
      moved: mode === 'move'
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
