import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import type { BoxRetainedProjectDescriptor, BoxRetainedProjectMedia } from '../../shared/box-contract'
import { STEMS_6, type DesktopPlaybackLaneConfig, type DesktopPlaybackPrepareConfig } from '../../shared/types'
import { describeProject } from '../project-state'

const SMALL_FILE_BYTES = 4 * 1024 * 1024

export interface ValidateBoxRetainedProjectRequest {
  dir: string
  songPath: string
  libraryRoot: string
  driveProjectsRoot: string
  config: DesktopPlaybackPrepareConfig
  lanes: DesktopPlaybackLaneConfig[]
  expected?: BoxRetainedProjectDescriptor
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(path)
  const info = await stat(canonical)
  if (!info.isDirectory()) throw new Error(`${label} is not a directory.`)
  return canonical
}

async function canonicalFile(root: string, path: string, label: string): Promise<string> {
  const canonical = await realpath(path)
  if (!inside(root, canonical)) throw new Error(`${label} escapes the retained project.`)
  const info = await stat(canonical)
  if (!info.isFile()) throw new Error(`${label} is not a file.`)
  return canonical
}

async function readSmallJson(root: string, path: string, label: string, required: boolean): Promise<{ hash: string; value: unknown } | null> {
  let canonical: string
  try { canonical = await canonicalFile(root, path, label) }
  catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const before = await stat(canonical)
  if (before.size > SMALL_FILE_BYTES) throw new Error(`${label} is too large for retained identity.`)
  const bytes = await readFile(canonical)
  const after = await stat(canonical)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size)
    throw new Error(`${label} changed while it was validated.`)
  if (bytes.length > SMALL_FILE_BYTES) throw new Error(`${label} is too large for retained identity.`)
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) }
  catch { throw new Error(`${label} is corrupt.`) }
  return { hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, value }
}

function media(id: string, path: string, info: { size: number; mtimeMs: number }): BoxRetainedProjectMedia {
  return { id, path, size: String(info.size), mtimeMs: info.mtimeMs }
}

export function retainedLaneControls(lanes: DesktopPlaybackLaneConfig[]): DesktopPlaybackLaneConfig[] {
  return lanes.map(lane => ({ id: lane.id, path: lane.path, gain: lane.gain, muted: lane.muted, solo: lane.solo }))
}

export async function validateBoxRetainedProject(request: ValidateBoxRetainedProjectRequest): Promise<BoxRetainedProjectDescriptor> {
  if (!request.dir || !request.songPath || request.lanes.length < 1 || request.lanes.length > 16)
    throw new Error('A retained project and its exact lanes are required.')
  const roots = await Promise.all([request.libraryRoot, request.driveProjectsRoot].map(async root => {
    try { return await canonicalDirectory(root, 'Retained library root') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }))
  const dir = await canonicalDirectory(request.dir, 'Retained project')
  if (!roots.some(root => root !== null && inside(root, dir))) throw new Error('The retained project is outside the configured libraries.')

  const metadata = await readSmallJson(dir, join(dir, 'project.json'), 'Project metadata', true)
  const meta = metadata!.value as Record<string, unknown>
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || typeof meta.songFile !== 'string' ||
      !meta.songFile || basename(meta.songFile) !== meta.songFile || typeof meta.name !== 'string' ||
      !meta.name.trim() || meta.name.length > 512 || !meta.settings || typeof meta.settings !== 'object' || Array.isArray(meta.settings))
    throw new Error('Project metadata is corrupt.')
  const songPath = join(dir, meta.songFile)
  try {
    const canonicalSong = await canonicalFile(dir, songPath, 'Project source')
    const requestedSong = await realpath(request.songPath)
    if (canonicalSong !== requestedSong) throw new Error('The retained project source does not match its metadata.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (join(await realpath(request.dir), basename(request.songPath)) !== songPath)
      throw new Error('The retained project source does not match its metadata.')
  }

  const stemDir = join(dir, 'stems')
  const canonicalStemDir = await canonicalDirectory(stemDir, 'Project stems')
  if (!inside(dir, canonicalStemDir)) throw new Error('The project stems escape the retained project.')
  const present: Record<string, number> = {}
  for (const entry of await readdir(canonicalStemDir, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    const path = await canonicalFile(canonicalStemDir, join(canonicalStemDir, entry.name), 'Project stem')
    present[entry.name] = (await stat(path)).size
  }
  const facts = describeProject(meta as Parameters<typeof describeProject>[0], present)
  if (!facts.playable || facts.missing.length || facts.damaged.length) throw new Error('The retained project has missing or damaged stems.')

  const expected: { id: string; path: string }[] = []
  for (const id of STEMS_6) {
    const format = facts.stems[id]
    if (format) expected.push({ id, path: join(canonicalStemDir, `${id}.${format}`) })
  }
  const settings = meta.settings as { custom?: unknown }
  if (settings.custom !== undefined && !Array.isArray(settings.custom)) throw new Error('Project custom tracks are corrupt.')
  for (const value of settings.custom ?? []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Project custom tracks are corrupt.')
    const track = value as { id?: unknown; file?: unknown }
    if (typeof track.id !== 'string' || !track.id || track.id.length > 96 || typeof track.file !== 'string' || !track.file || track.file.includes('\0'))
      throw new Error('Project custom tracks are corrupt.')
    expected.push({ id: track.id, path: isAbsolute(track.file) ? track.file : resolve(dir, track.file) })
  }
  if (expected.length !== request.lanes.length || new Set(expected.map(lane => lane.id)).size !== expected.length ||
      new Set(request.lanes.map(lane => lane.id)).size !== request.lanes.length)
    throw new Error('The prepared lanes do not match the retained project.')

  const mediaLanes: BoxRetainedProjectMedia[] = []
  for (const lane of expected) {
    const path = await canonicalFile(dir, lane.path, 'Project lane')
    const actual = request.lanes.find(candidate => candidate.id === lane.id)
    if (!actual || !isAbsolute(actual.path)) throw new Error('The prepared lanes do not match the retained project.')
    if (await realpath(actual.path) !== path) throw new Error('The prepared lanes do not match the retained project.')
    mediaLanes.push(media(lane.id, path, await stat(path)))
  }

  const [lyrics, graph] = await Promise.all([
    readSmallJson(dir, join(dir, 'lyrics.json'), 'Project lyrics', false),
    readSmallJson(dir, join(dir, 'graph.json'), 'Project graph', false)
  ])
  const stableMedia = mediaLanes.map(row => ({ id: row.id, path: row.path.slice(dir.length + 1) }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const metadataHash = `sha256:${createHash('sha256').update(JSON.stringify({ songFile: meta.songFile, media: stableMedia })).digest('hex')}`
  const config = { ...request.config }
  delete config.retainedProject
  const descriptor: BoxRetainedProjectDescriptor = {
    version: 1,
    project: { dir, songPath, name: meta.name, metadataHash,
      lyricsHash: lyrics?.hash ?? null, graphHash: graph?.hash ?? null, media: mediaLanes },
    config,
    lanes: retainedLaneControls(request.lanes)
  }
  if (request.expected) {
    const previous = request.expected.project
    const mediaBefore = [...previous.media].sort((a, b) => a.id.localeCompare(b.id))
    const mediaAfter = [...mediaLanes].sort((a, b) => a.id.localeCompare(b.id))
    if (previous.dir !== dir || previous.songPath !== songPath || previous.metadataHash !== metadataHash ||
        previous.lyricsHash !== descriptor.project.lyricsHash || previous.graphHash !== descriptor.project.graphHash ||
        JSON.stringify(mediaBefore) !== JSON.stringify(mediaAfter)) throw new Error('The retained project changed on disk.')
  }
  return descriptor
}
