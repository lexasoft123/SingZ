import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { access, cp, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import {
  STEMS,
  STEMS_6,
  type CloudRoot,
  type CustomTrack,
  type ImportResult,
  type ProjectInfo,
  type ProjectListItem,
  type ProjectSettings,
  type StemName6
} from '../shared/types'
import { wavToFlac } from './flac'
import { log } from './log'
import { describeProject } from './project-state'
import { markLibraryDirty, markProjectDirty, withDirty } from './sync-dirty'
import { allowRoot, stemsRoot } from './media'
import { hashFile } from './separation'
import { readSettings, writeSettings } from './settings'
import { AUDIO_EXT } from './source'

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
    // the sync's whole scope moved; nothing about the old marks still applies
    markLibraryDirty('library moved')
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
      markLibraryDirty('legacy library migrated')
      log('app', `moved project library ${legacy} → ${projectsRoot()}`)
      return
    }
    // both exist: move over what doesn't collide, leave the rest in place
    for (const entry of await readdir(legacy, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dest = join(projectsRoot(), entry.name)
      if (await exists(dest)) continue
      await rename(join(legacy, entry.name), dest)
      markProjectDirty(dest, 'legacy library migrated')
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

/**
 * One writer at a time per project folder.
 *
 * Saving a project runs for seconds (six stems through the FLAC encoder), and
 * renaming it moves the folder out from under whatever else is mid-write. Let
 * those two interleave and the library grows a project nobody asked for: the
 * save's `mkdir` recreates the folder the rename just moved away, and the rest
 * of the save fills the ghost with a fresh copy of the stems from the splitter
 * cache. Queued rather than refused — every one of these operations is
 * something the singer asked for, and they all still happen, in order.
 */
const projectWriters = new Map<string, Promise<unknown>>()

function withProjectLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const queue = projectWriters.get(dir) ?? Promise.resolve()
  // the tail runs whether the one before it resolved or threw — a failed save
  // must not wedge every later write to that folder
  const run = queue.then(fn, fn)
  const tail = run.catch(() => undefined)
  projectWriters.set(dir, tail)
  void tail.then(() => {
    if (projectWriters.get(dir) === tail) projectWriters.delete(dir)
  })
  return run
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
  /** md5 of every file in stems/ — Drive sync diffs from these instead of
   *  reading stem bytes (hashing an evicted iCloud stem downloads it all). */
  stemHashes?: Record<string, StemHash>
  /** The same for lyrics.json, so this doc states every file the project is
   *  made of and the catalog needs one checksum per project, not three. */
  lyricsHash?: StemHash
}

export interface StemHash {
  md5: string
  size: number
  /** mtime closes the same-size trap (a re-split WAV is byte-for-byte the
   *  same length); iCloud eviction round-trips keep modification times. */
  mtimeMs: number
}

/**
 * Current hashes of everything in stems/, reusing `prev` entries whose size
 * and mtime still match — those files are never opened. New or changed stems
 * are hashed here, freshly written by the splitter or an import, so the read
 * is warm and local.
 */
export async function refreshStemHashes(
  dir: string,
  prev: Record<string, StemHash> | undefined
): Promise<Record<string, StemHash>> {
  const out: Record<string, StemHash> = {}
  for (const e of await readdir(join(dir, 'stems'), { withFileTypes: true })) {
    if (!e.isFile() || !AUDIO_EXT.has(extname(e.name).toLowerCase())) continue
    const path = join(dir, 'stems', e.name)
    const st = await stat(path)
    const old = prev?.[e.name]
    // Tolerance, not equality: iCloud rehydration rewrites mtime with sub-ms
    // truncation (measured ~300 ns drift on the first evict/materialize
    // round-trip; dataless files keep it exact). A real write moves mtime by
    // far more, and the size check stands on its own for length changes.
    if (old && old.size === st.size && Math.abs(old.mtimeMs - st.mtimeMs) < 2) {
      out[e.name] = old
      continue
    }
    const bytes = await readFile(path)
    out[e.name] = {
      md5: createHash('md5').update(bytes).digest('hex'),
      size: st.size,
      mtimeMs: st.mtimeMs
    }
  }
  return out
}

/**
 * The same fingerprint for one file beside the stems — lyrics.json. Reuses
 * `prev` on an unchanged size and mtime (same tolerance as the stems), and
 * answers undefined when the file is not there at all.
 */
export async function refreshFileHash(
  path: string,
  prev: StemHash | undefined
): Promise<StemHash | undefined> {
  let st
  try {
    st = await stat(path)
  } catch {
    return undefined
  }
  if (prev && prev.size === st.size && Math.abs(prev.mtimeMs - st.mtimeMs) < 2) return prev
  const bytes = await readFile(path)
  return { md5: createHash('md5').update(bytes).digest('hex'), size: st.size, mtimeMs: st.mtimeMs }
}

/** Every file in stems/, by name → size. The one disk read behind both the
 *  library listing and the open path; an unreadable folder is simply empty. */
export async function stemsPresent(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  try {
    for (const e of await readdir(join(dir, 'stems'), { withFileTypes: true })) {
      if (!e.isFile()) continue
      try {
        out[e.name] = (await stat(join(dir, 'stems', e.name))).size
      } catch {
        /* vanished between the listing and the stat */
      }
    }
  } catch {
    /* no stems/ at all — a project mid-import, or one that never had them */
  }
  return out
}

/** Resolve a stem on disk: FLAC (v2) wins over WAV (v1) when both exist. */
async function stemFile(dir: string, stem: string): Promise<string | null> {
  const flac = join(dir, 'stems', `${stem}.flac`)
  if (await exists(flac)) return flac
  const wav = join(dir, 'stems', `${stem}.wav`)
  return (await exists(wav)) ? wav : null
}

/**
 * Custom tracks live in `stems/` under this prefix: that folder is what Drive
 * sync uploads and what the phones fetch, and the prefix keeps a track called
 * "vocals" from ever being mistaken for the stem of that name.
 */
const CUSTOM_PREFIX = 'custom-'

/**
 * File-name stem for a custom track. Ids come from project.json, which people
 * do hand-edit, so this both slugifies and confines the result to one path
 * segment — a `../` in there would write outside the project folder.
 */
function customBase(id: string, index: number): string {
  const slug = String(id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^custom-/, '')
  return `${CUSTOM_PREFIX}${slug || index + 1}`
}

/**
 * project.json → memory: project-relative files become absolute paths, and
 * entries whose file is not there (pruned stems/, a half-synced cloud folder,
 * a hand-edited path pointing outside the project) are dropped rather than
 * handed to a renderer that would fail to decode them.
 */
async function resolveCustom(
  dir: string,
  list: CustomTrack[] | undefined
): Promise<CustomTrack[] | undefined> {
  if (!Array.isArray(list) || list.length === 0) return undefined
  const out: CustomTrack[] = []
  const root = resolve(dir)
  for (const t of list) {
    if (!t || typeof t.file !== 'string' || typeof t.id !== 'string') continue
    const abs = resolve(root, t.file)
    if (!abs.startsWith(root + sep)) continue
    if (!(await exists(abs))) {
      log('app', `custom track "${t.label ?? t.id}" is missing from ${dir} — dropped`, 'warn')
      continue
    }
    out.push({ id: t.id, label: t.label ?? t.id, color: t.color, file: abs })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Memory → project.json: copy each custom track into the project's stems/
 * folder (files already there stay put) and return the project-relative
 * entries to store. Custom tracks keep their original format — an MP3 is
 * already small, and re-encoding someone's own recording buys nothing.
 *
 * A source file that vanished between adding and saving is dropped with a
 * warning: the rest of the project is still worth saving.
 */
async function storeCustomTracks(
  dir: string,
  list: CustomTrack[] | undefined
): Promise<CustomTrack[] | undefined> {
  const entries = Array.isArray(list) ? list : []
  const stemsDir = join(dir, 'stems')
  const out: CustomTrack[] = []
  const used = new Set<string>()
  for (let i = 0; i < entries.length; i++) {
    const t = entries[i]
    if (!t || typeof t.file !== 'string') continue
    const src = resolve(t.file)
    if (!(await exists(src))) {
      log('app', `custom track "${t.label ?? t.id}": ${src} is gone — not saved`, 'warn')
      continue
    }
    let name = `${customBase(t.id, i)}${extname(src).toLowerCase()}`
    for (let n = 2; used.has(name); n++) {
      name = `${customBase(t.id, i)}-${n}${extname(src).toLowerCase()}`
    }
    used.add(name)
    const dst = join(stemsDir, name)
    if (src !== dst) {
      await copyFile(src, dst)
      log('app', `custom track "${t.label ?? t.id}" copied into the project as stems/${name}`)
    }
    out.push({ id: t.id, label: t.label ?? t.id, color: t.color, file: join('stems', name) })
  }
  // Tracks the singer removed leave their copy behind; it would keep syncing
  // to Drive and reappear in nobody's mix. Only our own prefix is touched,
  // and only inside this project — the file the user picked is elsewhere.
  try {
    const keep = new Set(out.map((t) => basename(t.file)))
    for (const entry of await readdir(stemsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(CUSTOM_PREFIX) || keep.has(entry.name)) continue
      await rm(join(stemsDir, entry.name), { force: true })
      log('app', `removed custom track file stems/${entry.name} (no longer in the project)`)
    }
  } catch {
    // no stems folder yet — nothing to prune
  }
  return out.length > 0 ? out : undefined
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
    // repacking every stem takes seconds, and it runs unasked in the
    // background on open — a rename must wait for it, not move the folder
    // mid-conversion
    return await withProjectLock(dir, async () => {
      const meta = await readMeta(dir)
      if (!meta) return { ok: false as const, error: 'not a project folder' }
      if (meta.version >= 2) return { ok: true as const, converted: false }
      const hadWavs = await exists(join(dir, 'stems', 'vocals.wav'))
      const allFlac = await convertStemsToFlac(dir)
      if (!allFlac) return { ok: false as const, error: 'some stems could not be converted' }
      meta.version = 2
      // the WAVs it just deleted are still what stemHashes names — leave that in
      // and project.json describes files that no longer exist (and a phone
      // reading it would ask Drive for them)
      meta.stemHashes = await refreshStemHashes(dir, undefined)
      await writeFile(join(dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
      // every stem is a different file now — Drive is holding the WAVs
      markProjectDirty(dir, 'upgraded to compact stems')
      if (hadWavs) log('app', `project upgraded to compact stems: ${dir}`)
      return { ok: true as const, converted: hadWavs }
    })
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

/** The project's own files (song, project.json, lyrics) — stems are counted
 *  separately from the listing stemsPresent already did. */
async function topBytes(dir: string): Promise<number> {
  let total = 0
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue
      try {
        total += (await stat(join(dir, e.name))).size
      } catch {
        /* vanished between the listing and the stat */
      }
    }
  } catch {
    /* unreadable — the size is a courtesy, not the point */
  }
  return total
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
      const present = await stemsPresent(dir)
      const facts = describeProject(meta, present)
      if (facts.damaged.length || facts.missing.length) {
        log(
          'app',
          `${entry.name}: ${[...facts.missing.map((f) => `${f} missing`), ...facts.damaged.map((f) => `${f} the wrong size`)].join(', ')}`,
          'warn'
        )
      }
      projects.push({
        dir,
        name: meta.name ?? entry.name,
        songPath,
        savedAt: meta.savedAt ?? '',
        // playable = the core four exist; guitar/piano may be silent-hidden
        hasStems: facts.playable,
        stemCount: Object.keys(facts.stems).length,
        hasLyrics: await exists(join(dir, 'lyrics.json')),
        // what deleting it would free — stats only, so an evicted iCloud stem
        // is measured, never downloaded
        bytes: Object.values(present).reduce((a, b) => a + b, 0) + (await topBytes(dir))
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
    const facts = describeProject(meta, await stemsPresent(dir))
    const stems: Partial<Record<StemName6, string>> = {}
    for (const s of STEMS_6) {
      const format = facts.stems[s]
      if (format) stems[s] = join(dir, 'stems', `${s}.${format}`)
    }
    const coreThere = facts.playable
    const settings = meta.settings ?? { transpose: 0, tracks: {} }
    return {
      dir,
      name: meta.name ?? basename(dir),
      formatVersion: meta.version ?? 1,
      settings: { ...settings, custom: await resolveCustom(dir, settings.custom) },
      stems: coreThere ? stems : undefined,
      // named here so a truncated stem is reported as itself, rather than as
      // the decoder's "Could not decode that audio file" two layers later
      damaged: facts.damaged.length ? facts.damaged : undefined,
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
  | { ok: true; dir: string; songPath: string; inLibrary: boolean; custom?: CustomTrack[] }
  | { ok: false; error: string }
> {
  // Claimed before the first await, so a save asked for first is the one that
  // runs first — and everything this save decides (does the song still exist,
  // is it already in a project) is decided INSIDE the lock, where a rename
  // cannot have moved the answer since.
  const own = dirname(songPath)
  try {
    return await withProjectLock(own, async () => {
      // The song this save is of has to still be there. A save whose source
      // vanished while it waited (its project renamed, the file deleted) would
      // otherwise read as "loose song" below and fork a second copy of the
      // project into the library, built out of the splitter cache.
      if (!(await exists(songPath))) {
        return {
          ok: false as const,
          error: 'That song is no longer where it was — reopen it and save again.'
        }
      }
      // A song already inside a project folder saves in place, wherever that
      // folder lives — saving a shared or cloud project must never fork a second
      // copy into the library. Only a loose song gets a new folder made for it.
      const inPlace = await exists(join(own, 'project.json'))
      const dir = inPlace ? own : join(projectsRoot(), safeName(name))
      return await withDirty(dir, 'save', async () => {
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

        // The singer's own tracks land in stems/ too (Drive syncs that folder),
        // keeping whatever format they came in.
        const stored = await storeCustomTracks(dir, settings.custom)

        // lyrics from the hash cache (project-local lyrics stay as they are)
        const cachedLyrics = join(stemsRoot(), await hashFile(songPath), 'lyrics.json')
        const projLyrics = join(dir, 'lyrics.json')
        if ((await exists(cachedLyrics)) && !(await exists(projLyrics))) {
          await copyFile(cachedLyrics, projLyrics)
        }

        // hashes carry over from the previous save — a settings-only save reads
        // no stem bytes; whatever this save (re)wrote gets hashed while it is
        // still warm and local
        const prevMeta = await readMeta(dir)
        const meta: ProjectFile = {
          version: allFlac ? 2 : 1,
          name: safeName(name),
          songFile,
          savedAt: new Date().toISOString(),
          // project.json keeps custom tracks project-relative so the folder stays
          // portable; the renderer gets absolute paths back below.
          settings: { ...settings, custom: stored },
          stemHashes: await refreshStemHashes(dir, prevMeta?.stemHashes),
          lyricsHash: await refreshFileHash(join(dir, 'lyrics.json'), prevMeta?.lyricsHash)
        }
        await writeFile(join(dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
        log('app', `project saved: ${dir}`)
        return {
          ok: true as const,
          dir,
          songPath: songDest,
          inLibrary: inLibrary(dir),
          custom: await resolveCustom(dir, stored)
        }
      })
    })
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
      custom?: CustomTrack[]
    }
  | { ok: false; error: string }
> {
  try {
    const oldDir = dirname(songPath)
    // waits for a save of this project to finish rather than moving the folder
    // out from under it — see withProjectLock
    return await withProjectLock(oldDir, async () => {
      const meta = await readMeta(oldDir)
      if (!meta) return { ok: false as const, error: 'This song is not a saved project yet.' }
      const name = safeName(newName)
      // rename where the project lives (for a library project that is the root
      // itself) — renaming must never double as a move out of a shared folder
      const newDir = join(dirname(oldDir), name)
      if (newDir !== oldDir && (await exists(newDir))) {
        return { ok: false as const, error: `A project called “${name}” already exists.` }
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
      // both ends: the old folder is what Drive must stop carrying, the new one
      // is what it must start with
      markProjectDirty(oldDir, 'rename')
      markProjectDirty(newDir, 'rename')
      log('app', `project renamed: ${oldDir} → ${newDir}`)
      return {
        ok: true as const,
        name,
        dir: newDir,
        songPath: join(newDir, meta.songFile),
        stems: coreThere ? stems : undefined,
        custom: await resolveCustom(newDir, meta.settings?.custom)
      }
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Delete a project from the library, folder and all.
 *
 * There is no undo — the confirmation in the catalog is the whole gate — so
 * this is deliberately narrow about what it will erase: a folder inside the
 * library root, that is not the root itself, that holds a project.json. A path
 * that fails any of those is a bug or a stale card, not a project, and rm -rf
 * is not the place to find out. The Drive copy is not touched here: the next
 * sync sees a project folder the library no longer has and trashes it there,
 * which is the same path a rename already takes and keeps Drive's 30-day
 * trash as the one place a deleted song can still be recovered from.
 */
export async function deleteProject(
  dir: string
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  try {
    const target = resolve(dir)
    if (!inLibrary(target) || target === projectsRoot()) {
      return { ok: false, error: 'That folder is not a project in your library.' }
    }
    return await withProjectLock(target, async () => {
      // read the name before the folder goes: the caller says what it deleted
      const meta = await readMeta(target)
      if (!meta) return { ok: false as const, error: 'That folder is not a saved project.' }
      const name = meta.name ?? basename(target)
      await rm(target, { recursive: true, force: true })
      // Drive is still carrying it — the reconcile trashes remote folders the
      // library no longer has, so the phones stop listing it too
      markProjectDirty(target, 'deleted')
      log('app', `project deleted: ${target}`)
      return { ok: true as const, name }
    })
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
    // copying or moving the folder while a save is filling it would carry a
    // half-written project into the library — take a number
    return await withProjectLock(src, async () => {
      const meta = await readMeta(src)
      if (!meta) return { ok: false as const, error: 'This song is not a saved project yet.' }
      if (inLibrary(src)) return { ok: false as const, error: 'This project is already in your library.' }

      const name = safeName(meta.name ?? basename(src))
      const dst = join(projectsRoot(), name)
      if (await exists(dst)) {
        return { ok: false as const, error: `A project called “${name}” is already in your library.` }
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
      markProjectDirty(dst, 'imported into the library')
      log('app', `project ${mode === 'move' ? 'moved' : 'copied'} into the library: ${src} → ${dst}`)
      return {
        ok: true as const,
        dir: dst,
        songPath: join(dst, meta.songFile),
        stems: coreThere ? stems : undefined,
        custom: await resolveCustom(dst, meta.settings?.custom),
        moved: mode === 'move'
      }
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
