import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type {
  BoxRetainedPlaybackRecovery,
  BoxRetainedPlaybackRestore,
  BoxRetainedPlaybackSnapshot,
  BoxRetainedProjectDescriptor
} from '../../shared/box-contract'
import { commandableRetainedPlayback, retainedPlaybackSnapshot } from '../../shared/box-retained-playback'
import {
  GRAPH_DOCUMENT_FORMAT,
  MAX_GRAPH_DOCUMENT_TEXT_BYTES,
  parseGraphDocument
} from '../../shared/graph-document'
import { parseStrictLyricsCache } from '../../shared/strict-lyrics'
import {
  STEMS_6,
  type CustomTrack,
  type DesktopPlaybackPrepareConfig,
  type LyricLine,
  type ProjectGraphHash,
  type ProjectGraphPayload,
  type ProjectInfo,
  type ProjectListItem,
  type ProjectSettings,
  type StemName6
} from '../../shared/types'
import { describeProject } from '../project-state'
import { validateBoxRetainedProject } from './retained-project'

const SMALL_FILE_BYTES = 4 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 4096

type Expected = { epoch: string; generation: string }
type SnapshotReader = () => Promise<BoxRetainedPlaybackSnapshot>

export interface RestoreBoxRetainedPlaybackOptions {
  libraryRoot: string
  driveProjectsRoot: string
  snapshot: SnapshotReader
}

type StableFile = {
  path: string
  bytes: Buffer
  text: string
  before: Stats
}

type ProjectMetadata = {
  version?: unknown
  name?: unknown
  songFile?: unknown
  savedAt?: unknown
  settings?: ProjectSettings
  stemHashes?: Record<string, { size: number; md5: string; mtimeMs: number }>
  graphHash?: unknown
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

function validExpected(value: unknown): value is Expected {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.every(key => key === 'epoch' || key === 'generation')) return false
  const expected = value as Record<string, unknown>
  return typeof expected.epoch === 'string' && expected.epoch.length > 0 && expected.epoch.length <= 128 &&
    typeof expected.generation === 'string' && /^[1-9][0-9]{0,19}$/.test(expected.generation)
}

function stale(): Error {
  return new Error('Retained playback changed. Refresh before restoring the song.')
}

async function canonicalFile(root: string, path: string, label: string): Promise<string> {
  const canonical = await realpath(path)
  if (!inside(root, canonical)) throw new Error(`${label} escapes the retained project.`)
  const info = await stat(canonical)
  if (!info.isFile()) throw new Error(`${label} is not a file.`)
  return canonical
}

async function readStableFile(
  root: string,
  path: string,
  label: string,
  maximumBytes: number
): Promise<StableFile> {
  const canonical = await canonicalFile(root, path, label)
  const before = await stat(canonical)
  if (before.size > maximumBytes) throw new Error(`${label} is too large for retained recovery.`)
  const bytes = await readFile(canonical)
  const after = await stat(canonical)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || bytes.length !== before.size || bytes.length > maximumBytes) {
    throw new Error(`${label} changed during retained recovery.`)
  }
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${label} is not valid UTF-8.`)
  return { path: canonical, bytes, text, before }
}

async function assertStableFile(file: StableFile, label: string): Promise<void> {
  const canonical = await realpath(file.path)
  const current = await stat(canonical)
  if (canonical !== file.path || !current.isFile() || current.dev !== file.before.dev ||
      current.ino !== file.before.ino || current.size !== file.before.size ||
      current.mtimeMs !== file.before.mtimeMs) {
    throw new Error(`${label} changed during retained recovery.`)
  }
}

function parseJson(file: StableFile, label: string): unknown {
  try {
    return JSON.parse(file.text)
  } catch {
    throw new Error(`${label} is corrupt.`)
  }
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function commandableRecovery(snapshot: BoxRetainedPlaybackSnapshot, expected: Expected): BoxRetainedPlaybackRecovery {
  if (snapshot.epoch !== expected.epoch || snapshot.playback?.generation !== expected.generation) throw stale()
  const recovery = snapshot.recovery
  if (!recovery || recovery.generation !== expected.generation || recovery.status.generation !== expected.generation) {
    throw new Error('Retained playback recovery is unavailable; use explicit Stop.')
  }
  const status = recovery.status
  if (snapshot.playback.state !== status.state || snapshot.playback.transportState !== status.transportState) throw stale()
  if (!commandableRetainedPlayback(status)) {
    throw new Error('Retained native playback is not a commandable opened transport; use explicit Stop.')
  }
  return recovery
}

async function freshRecovery(reader: SnapshotReader, expected: Expected): Promise<BoxRetainedPlaybackRecovery> {
  const snapshot = retainedPlaybackSnapshot(await reader())
  return commandableRecovery(snapshot, expected)
}

function configBinding(config: DesktopPlaybackPrepareConfig): string {
  const binding = JSON.parse(JSON.stringify(config)) as Record<string, unknown>
  delete binding.masterGain
  delete binding.initialTransport
  const playback = binding.playback
  if (playback && typeof playback === 'object' && !Array.isArray(playback)) {
    const transport = (playback as Record<string, unknown>).transport
    if (transport && typeof transport === 'object' && !Array.isArray(transport)) {
      delete (transport as Record<string, unknown>).playbackRate
      delete (transport as Record<string, unknown>).transposeSemitones
    }
  }
  return JSON.stringify(binding)
}

function assertSameBinding(validated: BoxRetainedProjectDescriptor, current: BoxRetainedProjectDescriptor): void {
  const sameLanes = validated.lanes.length === current.lanes.length && validated.lanes.every((lane, index) => {
    const other = current.lanes[index]
    return lane.id === other.id && lane.path === other.path
  })
  if (validated.version !== current.version || JSON.stringify(validated.project) !== JSON.stringify(current.project) ||
      configBinding(validated.config) !== configBinding(current.config) || !sameLanes) throw stale()
}

function graphHash(value: unknown): ProjectGraphHash {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Project graph reference is corrupt.')
  const raw = value as Record<string, unknown>
  if (raw.format !== GRAPH_DOCUMENT_FORMAT || typeof raw.md5 !== 'string' || !/^[a-f0-9]{32}$/.test(raw.md5) ||
      !Number.isSafeInteger(raw.size) || (raw.size as number) < 0 || (raw.size as number) > MAX_GRAPH_DOCUMENT_TEXT_BYTES ||
      typeof raw.mtimeMs !== 'number' || !Number.isFinite(raw.mtimeMs) || raw.mtimeMs < 0) {
    throw new Error('Project graph reference is unsupported or corrupt.')
  }
  return { format: raw.format, md5: raw.md5, size: raw.size as number, mtimeMs: raw.mtimeMs }
}

async function readGraph(
  descriptor: BoxRetainedProjectDescriptor,
  metadata: ProjectMetadata
): Promise<{ payload: ProjectGraphPayload | null; file: StableFile | null }> {
  if (metadata.graphHash === undefined) return { payload: null, file: null }
  const hash = graphHash(metadata.graphHash)
  const file = await readStableFile(
    descriptor.project.dir,
    join(descriptor.project.dir, 'graph.json'),
    'Project graph',
    MAX_GRAPH_DOCUMENT_TEXT_BYTES
  )
  if (file.bytes.length !== hash.size || createHash('md5').update(file.bytes).digest('hex') !== hash.md5 ||
      descriptor.project.graphHash !== sha256(file.bytes)) {
    throw new Error('Project graph does not match its retained identity.')
  }
  const parsed = parseGraphDocument(file.text)
  if (parsed.kind !== 'known' || parsed.format !== hash.format) throw new Error('Project graph format is unsupported.')
  return { payload: { hash, text: file.text }, file }
}

async function projectInventory(dir: string): Promise<{ bytes: number; present: Record<string, number> }> {
  const stemDir = await realpath(join(dir, 'stems'))
  if (!inside(dir, stemDir) || !(await stat(stemDir)).isDirectory()) throw new Error('Project stems escape the retained project.')
  let bytes = 0
  const addBytes = (size: number): void => {
    if (!Number.isSafeInteger(bytes + size)) throw new Error('Retained project size is unstable.')
    bytes += size
  }
  const top = await readdir(dir, { withFileTypes: true })
  if (top.length > MAX_DIRECTORY_ENTRIES) throw new Error('Retained project has too many files.')
  for (const entry of top) {
    if (!entry.isFile()) continue
    addBytes((await stat(join(dir, entry.name))).size)
  }
  const present: Record<string, number> = {}
  const entries = await readdir(stemDir, { withFileTypes: true })
  if (entries.length > MAX_DIRECTORY_ENTRIES) throw new Error('Retained project has too many stem files.')
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    const path = await canonicalFile(stemDir, join(stemDir, entry.name), 'Project stem')
    const size = (await stat(path)).size
    present[entry.name] = size
    addBytes(size)
  }
  return { bytes, present }
}

async function sourceMissing(descriptor: BoxRetainedProjectDescriptor): Promise<boolean> {
  try {
    await canonicalFile(descriptor.project.dir, descriptor.project.songPath, 'Project source')
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

async function inConfiguredLibrary(root: string, dir: string): Promise<boolean> {
  try {
    return inside(await realpath(root), dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function projectSettings(metadata: ProjectMetadata, descriptor: BoxRetainedProjectDescriptor): ProjectSettings {
  const settings = { ...(metadata.settings as ProjectSettings) }
  if (settings.custom !== undefined) {
    const custom: CustomTrack[] = settings.custom.map(track => {
      const media = descriptor.project.media.find(candidate => candidate.id === track.id)
      if (!media) throw new Error('Project custom tracks are corrupt.')
      return { id: track.id, label: track.label ?? track.id, color: track.color, file: media.path }
    })
    settings.custom = custom.length > 0 ? custom : undefined
  }
  return settings
}

function projectDtos(
  metadata: ProjectMetadata,
  descriptor: BoxRetainedProjectDescriptor,
  graph: ProjectGraphPayload | null,
  missingSource: boolean,
  bytes: number,
  present: Record<string, number>,
  inLibrary: boolean
): { item: ProjectListItem; project: ProjectInfo } {
  const facts = describeProject(metadata, present)
  if (!facts.playable || facts.missing.length > 0 || facts.damaged.length > 0) throw stale()
  const stems: Partial<Record<StemName6, string>> = {}
  for (const id of STEMS_6) {
    if (!facts.stems[id]) continue
    const media = descriptor.project.media.find(candidate => candidate.id === id)
    if (!media) throw stale()
    stems[id] = media.path
  }
  const settings = projectSettings(metadata, descriptor)
  const item: ProjectListItem = {
    dir: descriptor.project.dir,
    name: descriptor.project.name,
    songPath: descriptor.project.songPath,
    savedAt: typeof metadata.savedAt === 'string' ? metadata.savedAt : '',
    hasStems: facts.playable,
    stemCount: Object.keys(facts.stems).length,
    hasLyrics: true,
    bytes
  }
  const project: ProjectInfo = {
    dir: item.dir,
    name: item.name,
    sourceMissing: missingSource,
    formatVersion: typeof metadata.version === 'number' ? metadata.version : 1,
    settings,
    graphHash: graph?.hash,
    stems,
    hasLyrics: true,
    inLibrary
  }
  return { item, project }
}

export async function restoreBoxRetainedPlayback(
  expected: Expected,
  options: RestoreBoxRetainedPlaybackOptions
): Promise<BoxRetainedPlaybackRestore> {
  if (!validExpected(expected)) throw new Error('Invalid retained song identity.')
  const initial = await freshRecovery(options.snapshot, expected)
  const request = {
    dir: initial.descriptor.project.dir,
    songPath: initial.descriptor.project.songPath,
    libraryRoot: options.libraryRoot,
    driveProjectsRoot: options.driveProjectsRoot,
    config: initial.descriptor.config,
    lanes: initial.descriptor.lanes,
    expected: initial.descriptor
  }
  const validated = await validateBoxRetainedProject(request)
  const directory = await stat(validated.project.dir)
  const [projectFile, lyricsFile] = await Promise.all([
    readStableFile(validated.project.dir, join(validated.project.dir, 'project.json'), 'Project metadata', SMALL_FILE_BYTES),
    readStableFile(validated.project.dir, join(validated.project.dir, 'lyrics.json'), 'Project lyrics', SMALL_FILE_BYTES)
  ])
  if (validated.project.lyricsHash !== sha256(lyricsFile.bytes)) throw new Error('Project lyrics do not match their retained identity.')
  const metadataValue = parseJson(projectFile, 'Project metadata')
  if (!metadataValue || typeof metadataValue !== 'object' || Array.isArray(metadataValue)) {
    throw new Error('Project metadata is corrupt.')
  }
  const metadata = metadataValue as ProjectMetadata
  const lyricsValue = parseStrictLyricsCache(parseJson(lyricsFile, 'Project lyrics'))
  if (!lyricsValue) throw new Error('Project lyrics are missing, empty, or corrupt.')
  const lyrics: LyricLine[] = lyricsValue.lines
  const graph = await readGraph(validated, metadata)
  const [missingSource, inventory, inLibrary] = await Promise.all([
    sourceMissing(validated),
    projectInventory(validated.project.dir),
    inConfiguredLibrary(options.libraryRoot, validated.project.dir)
  ])
  const { item, project } = projectDtos(
    metadata, validated, graph.payload, missingSource, inventory.bytes, inventory.present, inLibrary
  )

  const revalidated = await validateBoxRetainedProject({ ...request, expected: validated })
  await Promise.all([
    assertStableFile(projectFile, 'Project metadata'),
    assertStableFile(lyricsFile, 'Project lyrics'),
    ...(graph.file ? [assertStableFile(graph.file, 'Project graph')] : [])
  ])
  const currentDirectory = await stat(revalidated.project.dir)
  if (currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino) throw stale()

  const current = await freshRecovery(options.snapshot, expected)
  assertSameBinding(revalidated, current.descriptor)
  return { epoch: expected.epoch, recovery: current, item, project, lyrics, graph: graph.payload }
}
