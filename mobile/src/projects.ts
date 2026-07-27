import { NativeModules } from 'react-native'
import { decodeAudioData, type AudioBuffer } from 'react-native-audio-api'
import type { LyricsDoc, ProjectDoc } from './model'
import { STEM_ORDER_ALL } from './model'

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
}

const Folder = NativeModules.FolderAccess as FolderAccessApi

export const getRoot = (): Promise<RootInfo> => Folder.getRoot()
export const pickFolder = (): Promise<RootInfo | null> => Folder.pickFolder()
export const clearRoot = (): Promise<RootInfo> => Folder.clearRoot()

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

export interface LoadedProject {
  name: string
  doc: ProjectDoc
  lyrics: LyricsDoc | null
  stems: { id: string; buffer: AudioBuffer }[]
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
  const ids = STEM_ORDER_ALL.filter((s) => entry.stems[s])
  const stems: { id: string; buffer: AudioBuffer }[] = []
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    onStep(`Fetching ${id} · ${i + 1}/${ids.length}`, i / ids.length)
    await crumb?.(`fetching ${id}`)
    const path = await Folder.localFile(entry.dir, `stems/${id}.${entry.stems[id]}`)
    onStep(`Decoding ${id} · ${i + 1}/${ids.length}`, (i + 0.5) / ids.length)
    await crumb?.(`decoding ${id}`)
    stems.push({ id, buffer: await decodeAudioData(path, sampleRate) })
  }
  onStep('Lyrics…', 0.98)
  await crumb?.('lyrics')
  let lyrics: LyricsDoc | null = null
  if (entry.hasLyrics) {
    onStep('Fetching lyrics…', 0.99)
    try {
      lyrics = JSON.parse(await Folder.readText(entry.dir, 'lyrics.json')) as LyricsDoc
    } catch {
      lyrics = null
    }
  }
  return { name: entry.doc.name ?? entry.dir, doc: entry.doc, lyrics, stems }
}
