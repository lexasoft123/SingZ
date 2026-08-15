import { NativeModules } from 'react-native'
import type { LyricLine, ProjectDoc, ProjectSettings } from './model'
import { log } from './log'

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

/** Re-write lyrics.json + its hash + the doc (Find-lyrics retry). The CALLER
 *  re-reads project.json from disk (readText) and hands the string in —
 *  results merge into what is on disk, never into UI state; this function
 *  trusts that contract. */
export async function writeLyrics(
  dir: string,
  currentDocJson: string,
  lyrics: { lines: LyricLine[]; credit?: string }
): Promise<ProjectDoc> {
  const doc = JSON.parse(currentDocJson) as ProjectDoc
  const lyricsDoc = { source: 'lrclib' as const, credit: lyrics.credit, lines: lyrics.lines }
  await Folder.writeText(dir, 'lyrics.json', JSON.stringify(lyricsDoc, null, 2))
  const next: ProjectDoc = {
    ...doc,
    savedAt: new Date().toISOString(),
    lyricsHash: await Folder.statFile(dir, 'lyrics.json')
  }
  await Folder.writeText(dir, 'project.json', JSON.stringify(next, null, 2))
  return next
}

