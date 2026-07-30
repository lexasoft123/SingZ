import { NativeModules } from 'react-native'
import { decodeAudioData, type AudioBuffer } from 'react-native-audio-api'
import type { LyricsDoc, ProjectDoc } from './model'
import { customTracks, STEM_ORDER_ALL } from './model'

/**
 * Bridge to the FolderAccess native module: the library root is either the
 * app's Documents folder (drop projects in via Finder/Files) or a picked
 * folder such as iCloud Drive/SingZ, and file reads transparently wait for
 * iCloud to download dataless items.
 */
interface FolderAccessApi {
  pickFolder(): Promise<RootInfo | null>
  getRoot(): Promise<RootInfo>
  clearRoot(): Promise<RootInfo>
  listProjects(): Promise<NativeProject[]>
  readText(project: string, file: string): Promise<string>
  localFile(project: string, file: string): Promise<string>
  cacheUsage(): Promise<CacheUsage[]>
  clearCache(project: string): Promise<boolean>
}

/** What one project's downloaded files occupy on this phone. */
export interface CacheUsage {
  project: string
  bytes: number
  files: number
}

export interface RootInfo {
  kind: 'picked' | 'documents'
  path: string
  name: string
}

interface NativeProject {
  dir: string
  meta: string
  stems: Record<string, 'flac' | 'wav'>
  cached: boolean
  bytes: number
  hasLyrics: boolean
}

export interface ProjectEntry {
  dir: string
  doc: ProjectDoc
  /** Per-stem on-disk format — v2 projects say flac, pre-conversion ones wav. */
  stems: Record<string, 'flac' | 'wav'>
  /** Every stem is materialized on this device (no iCloud download needed). */
  cached: boolean
  /** Total bytes of materialized stems (0 while everything is still in the cloud). */
  bytes: number
  hasLyrics: boolean
  /** Where the files live — a picked/local folder or the Google Drive API. */
  source?: 'folder' | 'gdrive'
}

const Folder = NativeModules.FolderAccess as FolderAccessApi

export const getRoot = (): Promise<RootInfo> => Folder.getRoot()
export const pickFolder = (): Promise<RootInfo | null> => Folder.pickFolder()
export const clearRoot = (): Promise<RootInfo> => Folder.clearRoot()

/** Downloaded songs on this phone — older builds have no such native method. */
export const cacheUsage = (): Promise<CacheUsage[]> =>
  Folder.cacheUsage ? Folder.cacheUsage().catch(() => []) : Promise.resolve([])

/**
 * Delete one project's downloaded files ('' = all of them), and forget the
 * hashes that go with them so the next open fetches rather than trusting a
 * file that is no longer there.
 */
export async function clearCache(project = ''): Promise<void> {
  await Folder.clearCache(project)
  const { driveForgetCached } = await import('./gdrive')
  await driveForgetCached(project)
}

export async function listProjects(): Promise<ProjectEntry[]> {
  const raw = await Folder.listProjects()
  const out: ProjectEntry[] = []
  for (const p of raw) {
    try {
      out.push({
        dir: p.dir,
        doc: JSON.parse(p.meta) as ProjectDoc,
        stems: p.stems,
        cached: p.cached === true,
        bytes: typeof p.bytes === 'number' ? p.bytes : 0,
        hasLyrics: p.hasLyrics
      })
    } catch {
      // unreadable project.json — skip the folder
    }
  }
  out.sort((a, b) => ((a.doc.savedAt ?? '') < (b.doc.savedAt ?? '') ? 1 : -1))
  return out
}

/**
 * One playable lane. Split stems get their name and color from TRACK_META;
 * tracks the singer added carry their own (the desktop saved them), and are
 * flagged so the UI can say so.
 */
export interface LoadedLane {
  id: string
  buffer: AudioBuffer
  label?: string
  color?: string
  custom?: boolean
}

export interface LoadedProject {
  name: string
  doc: ProjectDoc
  lyrics: LyricsDoc | null
  /** Stems first, in display order, then the tracks the singer added. */
  stems: LoadedLane[]
}

/** Decoded size of a stem set — float32 per channel, no compression in RAM. */
export function decodedBytes(stems: { buffer: AudioBuffer }[]): number {
  return stems.reduce((n, s) => n + s.buffer.length * s.buffer.numberOfChannels * 4, 0)
}

/**
 * Ceiling for one project's decoded stems. Six stems at 48 kHz stereo cost
 * ~138 MB per minute of song, so this is a ~9-minute song — past that the
 * phone is heading for a per-process-limit kill, and dying silently mid-load
 * is worse than saying so.
 */
export const MAX_DECODED_BYTES = 1_250_000_000

/**
 * Free the stems. Dropping references is not enough: Hermes sees a small
 * wrapper over hundreds of megabytes of native PCM and collects whenever it
 * likes, so back-to-back songs stack whole stem sets (measured ~1 GB still
 * resident after close) until the phone jetsam-kills the app mid-decode.
 * release() (audio-api patch 4) hands the PCM back on the spot. Always
 * unload the engine first — a source node still pointing at the buffer must
 * not outlive its samples.
 */
export function releaseProject(p: LoadedProject | null): void {
  if (!p) return
  releaseStems(p.stems)
  p.stems = []
}

/** @see releaseProject — same release hook, for a half-built stem list. */
export function releaseStems(stems: { buffer: AudioBuffer }[]): void {
  for (const s of stems) {
    const host = (s.buffer as unknown as { buffer?: { release?: () => void } }).buffer
    try {
      host?.release?.()
    } catch {
      // unpatched audio-api — GC remains the only path
    }
  }
}

/**
 * Pull a project into memory: stems download (if in iCloud) into the app
 * cache, then decode natively — FLAC (v2) and WAV (v1) both play.
 */
export async function loadProject(
  entry: ProjectEntry,
  sampleRate: number,
  onStep: (msg: string, frac: number) => void,
  crumb?: (note: string) => Promise<void>
): Promise<LoadedProject> {
  const gdrive = entry.source === 'gdrive'
  const fetchFile = (file: string): Promise<string> =>
    gdrive
      ? import('./gdrive').then((g) => g.driveLocalFile(entry.dir, file))
      : Folder.localFile(entry.dir, file)
  const readText = (file: string): Promise<string> =>
    gdrive
      ? import('./gdrive').then((g) => g.driveReadText(entry.dir, file))
      : Folder.readText(entry.dir, file)

  const ids = STEM_ORDER_ALL.filter((s) => entry.stems[s])
  const added = customTracks(entry.doc?.settings)
  const total = ids.length + added.length
  const stems: LoadedLane[] = []
  const tooBig = (bytes: number): never => {
    releaseStems(stems)
    stems.length = 0
    throw new Error(
      `This song needs about ${(bytes / 1e9).toFixed(1)} GB of memory to play — too long ` +
        'for this phone. Try a shorter song, or split it up on the computer.'
    )
  }
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    onStep(`Fetching ${id} · ${i + 1}/${total}`, i / total)
    await crumb?.(`fetching ${id}`)
    const path = await fetchFile(`stems/${id}.${entry.stems[id]}`)
    onStep(`Decoding ${id} · ${i + 1}/${total}`, (i + 0.5) / total)
    await crumb?.(`decoding ${id}`)
    // file:// matters: audio-api's Android RELEASE builds treat bare strings
    // as APK asset names ("Could not read asset bytes"); the scheme routes
    // them to the file decoder and is stripped on every other platform.
    stems.push({ id, buffer: await decodeAudioData(`file://${path}`, sampleRate) })
    // Stems are all the same length, so one decoded stem projects the whole
    // set. Bail on the projection rather than on the total: refusing after
    // six stems are already resident is refusing too late.
    const projected = (decodedBytes(stems) / stems.length) * ids.length
    if (projected > MAX_DECODED_BYTES) tooBig(projected)
  }
  // Tracks the singer added on the desktop. They can be any length, so there
  // is nothing to project from — each one is checked against the budget as it
  // lands, and a track this phone cannot fetch or decode is skipped rather
  // than allowed to sink a song whose stems are all there.
  for (let i = 0; i < added.length; i++) {
    const t = added[i]
    const at = ids.length + i
    onStep(`Fetching ${t.label} · ${at + 1}/${total}`, at / total)
    await crumb?.(`fetching ${t.id}`)
    try {
      const path = await fetchFile(t.file)
      onStep(`Decoding ${t.label} · ${at + 1}/${total}`, (at + 0.5) / total)
      await crumb?.(`decoding ${t.id}`)
      const buffer = await decodeAudioData(`file://${path}`, sampleRate)
      stems.push({ id: t.id, buffer, label: t.label, color: t.color, custom: true })
    } catch (err) {
      console.warn(`SingZ: added track "${t.label}" skipped — ${String(err)}`)
      continue
    }
    if (decodedBytes(stems) > MAX_DECODED_BYTES) tooBig(decodedBytes(stems))
  }
  onStep('Lyrics…', 0.98)
  await crumb?.('lyrics')
  let lyrics: LyricsDoc | null = null
  if (entry.hasLyrics) {
    onStep('Fetching lyrics…', 0.99)
    try {
      lyrics = JSON.parse(await readText('lyrics.json')) as LyricsDoc
    } catch {
      lyrics = null
    }
  }
  return { name: entry.doc.name ?? entry.dir, doc: entry.doc, lyrics, stems }
}
