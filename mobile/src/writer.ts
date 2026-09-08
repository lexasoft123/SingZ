import { NativeModules } from 'react-native'
import type { LyricLine, ProjectDoc, ProjectSettings } from './model'
import { log } from './log'
import { mutateProjectDocument } from './project-document'
import {
  GRAPH_DOCUMENT_FORMAT,
  MAX_GRAPH_DOCUMENT_TEXT_BYTES,
  parseGraphDocument,
  serializeGraphDocument
} from './gen/graph-document'

/**
 * The phone's project writer (Phase 1, docs/PHONE-STANDALONE.md): a
 * phone-added song becomes an ordinary project folder in the "This phone"
 * library — the same folder shape desktop saveProject produces, so the
 * desktop's own reader (and, in Phase 5+, adoption) accepts it verbatim.
 *
 * The desktop contract, mirrored deliberately:
 *  - the original audio is KEPT as `song.<ext>` — desktop listProjects skips
 *    a project whose songFile is missing;
 *  - until the split exists, the original also plays as a custom lane at
 *    `stems/custom-original.<ext>` (customTracks() validates that shape);
 *    the split phase removes the lane when six real stems land;
 *  - stemHashes carries md5+size+mtimeMs for every stems/ file and
 *    lyricsHash for lyrics.json — the doc names every file it is made of;
 *  - project.json is written LAST, so a killed add never leaves a doc
 *    naming files that are not there.
 */

/** What the system picker hands back: the app's own copy of the chosen file. */
export interface PickedFile {
  path: string
  name: string
  size: number
}

interface WriterNative {
  pickAudioFile(): Promise<PickedFile | null>
  ensureProjectDir(name: string): Promise<{ dir: string; path: string }>
  writeText(project: string, file: string, text: string): Promise<boolean>
  moveIntoProject(project: string, relPath: string, srcPath: string): Promise<string>
  copyIntoProject(project: string, relPath: string, srcPath: string): Promise<string>
  statFile(
    project: string,
    relPath: string
  ): Promise<{ md5: string; size: number; mtimeMs: number }>
  deleteProject(project: string): Promise<boolean>
  readMediaTags(
    path: string
  ): Promise<{ artist?: string; title?: string; album?: string; durationMs?: number }>
}

const Folder = NativeModules.FolderAccess as WriterNative

export const pickAudioFile = (): ReturnType<WriterNative['pickAudioFile']> =>
  Folder.pickAudioFile()
export const readMediaTags = (path: string): ReturnType<WriterNative['readMediaTags']> =>
  Folder.readMediaTags(path)
export const deleteProject = (project: string): Promise<boolean> =>
  Folder.deleteProject(project)

/** Lowercased extension of a picked file, defaulting like the desktop's copy. */
function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name)
  return m ? `.${m[1].toLowerCase()}` : ''
}

export interface CreateProjectInput {
  /** The picked import copy (native `pickAudioFile` result). */
  srcPath: string
  /** Original filename — names the project and the song file's extension. */
  fileName: string
  /** Display name for the project (usually the confirmed title). */
  name: string
  durationSec: number
  lyrics?: { lines: LyricLine[]; credit?: string } | null
}

export interface CreatedProject {
  dir: string
  doc: ProjectDoc
}

/**
 * Materialize a phone-added song as a project folder. Files first, doc last —
 * and the analysis keep-rule does not apply here by construction: a fresh add
 * HAS no beat or melody yet, so settings simply omit them.
 */
export async function createProject(input: CreateProjectInput): Promise<CreatedProject> {
  const { dir } = await Folder.ensureProjectDir(input.name)
  const ext = extOf(input.fileName) || '.mp3'
  const songFile = `song${ext}`
  const laneFile = `stems/custom-original${ext}`

  // The original audio, twice by design: song.<ext> is the desktop contract
  // (listProjects skips a project whose songFile is missing), and the
  // stems/custom-original copy is what plays before a split exists. Copy
  // first (the import still stands if it dies), then move the import into
  // the lane slot; the doc naming both comes last.
  await Folder.copyIntoProject(dir, songFile, input.srcPath)
  await Folder.moveIntoProject(dir, laneFile, input.srcPath)

  if (input.lyrics && input.lyrics.lines.length > 0) {
    const lyricsDoc = {
      source: 'lrclib' as const,
      credit: input.lyrics.credit,
      lines: input.lyrics.lines
    }
    await Folder.writeText(dir, 'lyrics.json', JSON.stringify(lyricsDoc, null, 2))
  }

  const settings: ProjectSettings = {
    transpose: 0,
    tracks: {},
    custom: [
      {
        id: 'custom-original',
        label: 'Original',
        color: '#d08f2c',
        file: laneFile
      }
    ]
  }

  const stemHashes: NonNullable<ProjectDoc['stemHashes']> = {
    [`custom-original${ext}`]: await Folder.statFile(dir, laneFile)
  }
  const lyricsHash =
    input.lyrics && input.lyrics.lines.length > 0
      ? await Folder.statFile(dir, 'lyrics.json')
      : undefined

  const doc: ProjectDoc = {
    version: 1,
    name: dir,
    songFile,
    savedAt: new Date().toISOString(),
    settings,
    stemHashes,
    ...(lyricsHash ? { lyricsHash } : {})
  }
  await Folder.writeText(dir, 'project.json', JSON.stringify(doc, null, 2))
  log('song', `added on this phone: ${dir} (${songFile}, ${input.durationSec.toFixed(0)}s)`)
  return { dir, doc }
}

/** Re-write lyrics.json + its hash + the doc (Find-lyrics retry). The shared
 * project transaction re-reads after any competing analysis/metronome write. */
export async function writeLyrics(
  dir: string,
  lyrics: { lines: LyricLine[]; credit?: string }
): Promise<ProjectDoc> {
  const lyricsDoc = { source: 'lrclib' as const, credit: lyrics.credit, lines: lyrics.lines }
  await Folder.writeText(dir, 'lyrics.json', JSON.stringify(lyricsDoc, null, 2))
  const lyricsHash = await Folder.statFile(dir, 'lyrics.json')
  const next = await mutateProjectDocument(dir, (doc) => ({
    ...doc,
    savedAt: new Date().toISOString(),
    lyricsHash
  }))
  if (!next) throw new Error('Lyrics project update was not written.')
  return next
}

/** Cache the seek bar's envelope in the project, against the stems it was
 * measured from.
 *
 * Goes through the same document queue as every other writer, so a waveform
 * landing while analysis or lyrics are being written cannot clobber either —
 * this is a strictly additive field on whatever the doc says at the time. */
export async function writeProjectWaveform(
  dir: string,
  waveforms: Record<string, { md5: string; peaks: number[] }>
): Promise<ProjectDoc | null> {
  if (Object.keys(waveforms).length === 0) return null
  return mutateProjectDocument(dir, async (doc) => ({
    ...doc,
    savedAt: new Date().toISOString(),
    waveforms: { ...(doc.waveforms ?? {}), ...waveforms },
  }))
}

/** Explicit portable-graph transaction: canonical graph.json first, native
 * stat/hash second, project.json last. The shared project-document queue spans
 * the whole callback, so analysis, lyrics, and metronome writers cannot land
 * between the graph bytes and their reference. */
export async function writeProjectGraph(dir: string, source: string): Promise<ProjectDoc> {
  let sourceBytes = 0
  for (const char of source) {
    const cp = char.codePointAt(0) ?? 0
    sourceBytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4
  }
  if (sourceBytes > MAX_GRAPH_DOCUMENT_TEXT_BYTES) {
    throw new Error('Graph document exceeds the portable graph size limit.')
  }
  const parsed = parseGraphDocument(source)
  if (parsed.kind !== 'known' || parsed.format !== GRAPH_DOCUMENT_FORMAT) {
    throw new Error(`Graph document format ${parsed.format} is not writable by this app.`)
  }
  const canonical = serializeGraphDocument(parsed)
  const next = await mutateProjectDocument(dir, async (doc) => {
    const written = await Folder.writeText(dir, 'graph.json', canonical)
    if (!written) throw new Error('Graph document was not written.')
    const hash = await Folder.statFile(dir, 'graph.json')
    return { ...doc, savedAt: new Date().toISOString(), graphHash: { format: parsed.format, ...hash } }
  })
  if (!next) throw new Error('Graph project update was not written.')
  return next
}
