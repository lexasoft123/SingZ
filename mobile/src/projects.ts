import { NativeModules } from 'react-native'
import { decodeAudioData, type AudioBuffer } from 'react-native-audio-api'
// static on purpose: CatalogScreen already loads gdrive at startup, and a
// dynamic import() here is the one thing jest cannot execute
import { driveLocalFile, driveReadText } from './gdrive'
import type { LyricsDoc, ProjectDoc } from './model'
import { isCurrent } from './current'
import { fmtBytes, fmtMs, log } from './log'
import { customTracks, STEM_ORDER_ALL } from './model'
import { mobileMetronomePersistence } from './playback/metronome-persistence'
import type { MetronomeProjectRef } from './playback/metronome-persistence'
import {
  GRAPH_DOCUMENT_FORMAT,
  MAX_GRAPH_DOCUMENT_TEXT_BYTES,
  parseGraphDocument,
  type ParsedGraphDocument
} from './gen/graph-document'
import { md5Text, utf8TextByteLength } from './md5'

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
  statFile(project: string, file: string): Promise<{ md5: string; size: number; mtimeMs: number }>
  cacheUsage(): Promise<CacheUsage[]>
  clearCache(project: string): Promise<boolean>
}

/** What one project's downloaded files occupy on this phone. */
export interface CacheUsage {
  project: string
  bytes: number
  files: number
  /** Size of each file present, by project-relative path — what the ✓ reads. */
  sizes?: Record<string, number>
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
  /** Every file this song is made of, by project-relative path → size, as
   *  project.json states it. The download rule and the ✓ read this same list. */
  expect?: Record<string, number>
  /** What the whole song costs to download — the "☁ 95 MB" line. */
  bytes: number
  hasLyrics: boolean
  /** Where the files live — a picked/local folder or the Google Drive API. */
  source?: 'folder' | 'gdrive'
  /** Exact persistence authority supplied by the catalog owning this entry. */
  metronomeRef?: MetronomeProjectRef
}

/**
 * Return only a persistence authority that the catalog actually proved.
 *
 * A non-Drive entry without `metronomeRef` may be a phone Documents project,
 * an exported project, or a picked-folder project. Its directory name cannot
 * distinguish those roots, so treating it as phone-local can overwrite a
 * same-named Documents project. Older/direct load paths therefore remain
 * playable but metronome persistence fails closed until their catalog stamps
 * the explicit source/root identity.
 */
/**
 * Below this level a lane is silence, not audio.
 *
 * The desktop's audibleStems rule, and the reason a song with no guitar does
 * not get a guitar row in the mixer. Legacy measures sampled RMS against it;
 * the native player has no decoded audio in JS and measures the core's peak
 * envelope against the same number, which hides strictly less because peak
 * is never below RMS.
 */
export const SILENT_LANE_LEVEL = 0.004

/**
 * The only lanes the silence rule may hide.
 *
 * The splitter always returns six stems, and a song with no guitar gets a
 * guitar lane of silence — but a vocals lane that happens to be silent is a
 * song with no singing, which the singer still gets to see and unmute. The
 * desktop's audibleStems rule is scoped this way and both phone backends
 * follow it, or the same song shows different lanes on different devices.
 */
export const HIDEABLE_LANE_IDS: readonly string[] = ['guitar', 'piano']

export function metronomeRefForEntry(
  entry: Pick<ProjectEntry, 'dir' | 'metronomeRef' | 'source'>
): MetronomeProjectRef {
  if (entry.metronomeRef) return entry.metronomeRef
  if (entry.source === 'gdrive') return { source: 'gdrive', dir: entry.dir }
  const reason =
    `Project ${entry.dir} has no explicit phone or picked-folder persistence identity.` +
    ' Metronome changes will remain read-only for this load.'
  log('metronome', reason, 'warn')
  return { source: 'readonly', dir: entry.dir, reason }
}

/**
 * Does this phone hold the whole song? The same ladder the natives run on open
 * (`isCurrent`), minus the hashing: every file the project names, present at
 * its stated size — per file, never a byte total, because a sum lets a leftover
 * stem stand in for a missing one, and that is exactly how a song came to sit
 * in the library ticked and then download itself. Folder libraries answer for
 * themselves; the native walked them already.
 */
export function isDownloaded(entry: ProjectEntry, have?: CacheUsage): boolean {
  if (entry.source !== 'gdrive') {
    // A song with no stems is either freshly added on this phone or waiting to
    // be split — its audio is the lane the doc names, and it is right here.
    // The natives only ever probe the six stem names, so they disagree about
    // this case (iOS said "not downloaded", Android said "local, nothing to
    // fetch") and the library painted a download glyph on a song that had
    // nothing to download.
    if (Object.keys(entry.stems ?? {}).length === 0) return true
    return entry.cached
  }
  const want = Object.entries(entry.expect ?? {})
  if (want.length === 0) return false
  return want.every(([path, size]) => isCurrent({ size: have?.sizes?.[path] ?? -1 }, { size }))
}

const Folder = NativeModules.FolderAccess as FolderAccessApi

export const getRoot = (): Promise<RootInfo> => Folder.getRoot()
export const pickFolder = (): Promise<RootInfo | null> => Folder.pickFolder()
export const clearRoot = (): Promise<RootInfo> => Folder.clearRoot()

/** Downloaded songs on this phone — older builds have no such native method. */
export const cacheUsage = (): Promise<CacheUsage[]> =>
  Folder.cacheUsage ? Folder.cacheUsage().catch(() => []) : Promise.resolve([])

/** Delete one project's downloaded files ('' = all of them). Nothing else to
 *  forget: what the phone has is answered by the files, so removing them is
 *  the whole of it. */
export const clearCache = (project = ''): Promise<boolean> => Folder.clearCache(project)

/** One small text member of a local/phone project (project.json, lyrics.json). */
export const readProjectText = (project: string, file: string): Promise<string> =>
  Folder.readText(project, file)

/** Absolute path to a readable copy of a local/phone project file. */
export const localProjectFile = (project: string, file: string): Promise<string> =>
  Folder.localFile(project, file)

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

export interface NativePlaybackLaneView {
  readonly id: string
  readonly label: string
  readonly color: string
  /** True for an added/original project lane rather than a split stem. */
  readonly custom: boolean
  readonly totalFrames: number
}

/**
 * Count-in presentation facts exposed by a playback owner.
 *
 * Beat dots require exact local-meter/cue facts. A backend that only knows
 * truthful pre-roll time must use `time`; the UI must never infer dots by
 * evenly dividing that interval or applying a song-wide beats-per-bar value.
 */
export type PlaybackCountInStatus =
  | { readonly kind: 'beats'; readonly total: number; readonly done: number; readonly perBar: number }
  | { readonly kind: 'time'; readonly remainingSeconds: number }

export interface NativePlaybackViewState {
  readonly phase: 'prepared' | 'starting' | 'playing' | 'paused' | 'stopping' | 'stopped' | 'error'
  readonly generation: number
  /** Listener-facing signed project time; negative values are count-in. */
  readonly positionSec: number
  /** Render-head signed project time before presentation latency. */
  readonly renderedPositionSec: number
  readonly durationSec: number
  readonly displayLatencySec: number
  readonly audibleFrames: number
  readonly countInStatus: PlaybackCountInStatus | null
  readonly regionState: { start: number; end: number; loop: boolean } | null
  readonly terminalReason: string
  readonly error: string | null
  /** Wall-clock stamp of the telemetry behind the two positions, whether the
   * transport was advancing then, and its rate. The player's clock no longer
   * reads these on a native build that answers `positionNow()`; they remain
   * the fallback projection for a build older than that method, where the
   * position still arrives on the telemetry poll and is projected forward
   * between polls so the sweep glides instead of stepping. */
  readonly telemetryAtMs?: number
  readonly advancing?: boolean
  readonly playbackRate?: number
}

/**
 * What the player's clock reads, as often as it likes.
 *
 * `renderedSec` is the render head — the signed project time the core had
 * rendered up to, advanced by how long ago it said so — untrimmed and before
 * presentation latency, exactly the legacy engine's `audioPosition`. While a
 * song is SOUNDING, what the singer hears is that minus the latency and the
 * trim, which the backend subtracts once; while the transport is stopped or
 * counting in it is the shown position itself, which is what `preRoll` below
 * and `playing` are for. `live` says whether this came from the synchronous
 * native read (`positionNow`) or, on an older native build, from the last
 * polled telemetry projected by wall time.
 */
export interface NativePlaybackClock {
  readonly renderedSec: number
  readonly playing: boolean
  /** The transport is counting the singer in: `renderedSec` is the landing,
   *  held, and no output-latency correction belongs on it (see the backend's
   *  `position`). */
  readonly preRoll: boolean
  readonly live: boolean
  readonly countIn: PlaybackCountInStatus | null
}

export type NativePlaybackStartOutcome =
  | { readonly kind: 'started' }
  | { readonly kind: 'fallback'; readonly project: LoadedProject }
  | { readonly kind: 'failed'; readonly error: string }

export type NativePlaybackTrainingSpec =
  | { readonly mode: 'period'; readonly periodSec: number; readonly stems: readonly string[] }
  | {
      readonly mode: 'windows'
      readonly windows: readonly { readonly s: number; readonly e: number }[]
      readonly stems: readonly string[]
    }

/** Narrow native product contract. It is deliberately not shaped like
 * MultitrackEngine: unsupported parity operations therefore cannot compile
 * against the mobile DSP session and cannot be accidentally exposed
 * in the UI. */
export interface NativePlaybackHandle {
  readonly kind: 'ios-native' | 'android-native'
  readonly lanes: readonly NativePlaybackLaneView[]
  readonly transportControls: true
  /** Generation-bound scalar controls are implemented by the shared
   * NativePlaybackSession on both mobile platforms. They ramp through zdsp's
   * bounded parameter queue; no per-platform mixer graph is allowed here. */
  readonly mixerControls: true
  snapshot(): NativePlaybackViewState
  /** The clock, read synchronously: the render head now, whether the
   * transport is moving, and the count-in in progress. Cheap enough to call
   * from every render and every ticker tick — that is the point of it. */
  clock(): NativePlaybackClock
  /** Whether a structural change (cue, training, pitch/tempo) would be
   * landed on the running stream as a seam rather than as a stop/unload/
   * prepare/open/start rebuild — true only on a core that can swap and while
   * the song is playing or paused on a running stream. The player's
   * capabilities use it: a seam refuses no seek, a rebuild refuses every
   * one for seconds. */
  swapsInPlace(): boolean
  subscribe(listener: () => void): () => void
  /** The singer's per-route latency correction, in seconds. The count-in
   * dots are derived from the same audible frame the lyric sweep uses, and
   * that frame carries only the latency the OS reports — which is short on
   * Bluetooth and CarPlay by exactly the amount this trim exists to add. */
  setDisplayTrim(seconds: number): void
  /** Per-lane amplitude envelope for the seek bar, or null when this build
   * cannot produce one. Cached under the prepared generation by the owner. */
  lanePeaks(): Promise<{
    readonly bucketCount: number
    readonly lanes: readonly {
      readonly id: string
      readonly peaksValid: boolean
      readonly peaks: readonly number[]
    }[]
  } | null>
  start(): Promise<NativePlaybackStartOutcome>
  pause(): Promise<void>
  seek(seconds: number): Promise<void>
  setLoop(startSeconds: number, endSeconds: number): Promise<void>
  clearLoop(): Promise<void>
  reanchorTransport(): Promise<void>
  setLaneControl(
    id: string,
    gain: number,
    muted: boolean,
    solo: boolean
  ): Promise<void>
  setMasterGain(gain: number): Promise<void>
  /** Generation-bound one-shot through the prepared native reference branch. */
  previewClick(accent?: boolean): Promise<void>
  /** Tempo/transpose rebuilds the prepared whole-song processor at the exact
   * signed render position; it is never a callback-time reconfiguration. */
  setPitchTempo(semitones: number, rate: number): Promise<void>
  /** A new schedule is a structural native graph rebuild; arming/disarming an
   * already prepared schedule is a generation-bound scalar command. */
  setTraining(spec: NativePlaybackTrainingSpec | null): Promise<void>
  stop(reason?: string): Promise<void>
  unload(reason?: string): Promise<void>
}

export interface LoadedProject {
  name: string
  /** The project folder this was loaded from — absent for the bundled
   *  sample. What an analysis result names, so the player can tell its own
   *  song's grid from a neighbour's. */
  dir?: string
  /** Which library the dir belongs to — a dir name is unique only WITHIN a
   *  library (the phone's own "Foo" and the desktop's cloud-folder "Foo"
   *  share the name), and only the phone's own library is ever analysed.
   *  Set by the catalog, which knows the mode. */
  library?: 'phone' | 'folder' | 'gdrive'
  doc: ProjectDoc
  /** Verified portable control graph. Absent means this is a legacy fixed-graph project. */
  graph?: ParsedGraphDocument
  lyrics: LyricsDoc | null
  /** Stems first, in display order, then the tracks the singer added. */
  stems: LoadedLane[]
  /** Present only for the experimental mobile DSP backend. Native
   * decoded owners live below the bridge; `stems` stays empty so JS cannot
   * retain a second RNAudioAPI PCM copy. */
  nativePlayback?: NativePlaybackHandle
  /** Exact source/root identity used to load and persist metronome state. */
  metronomeRef?: MetronomeProjectRef
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

function validGraphRef(value: unknown): value is NonNullable<ProjectDoc['graphHash']> {
  if (!value || typeof value !== 'object') return false
  const h = value as Record<string, unknown>
  return (
    Number.isSafeInteger(h.format) &&
    (h.format as number) > 0 &&
    typeof h.md5 === 'string' &&
    /^[a-f0-9]{32}$/.test(h.md5) &&
    Number.isSafeInteger(h.size) &&
    (h.size as number) >= 0 &&
    Number.isFinite(h.mtimeMs) &&
    (h.mtimeMs as number) >= 0
  )
}

/** Resolve only the exact payload project.json names. A stray graph.json is
 * ignored; missing, mismatched, invalid, and future graphs fail closed rather
 * than silently switching this project to the legacy fixed composition. */
export async function loadProjectGraph(entry: ProjectEntry, doc: ProjectDoc): Promise<ParsedGraphDocument | undefined> {
  const ref = doc.graphHash
  if (ref === undefined) return undefined
  if (!validGraphRef(ref)) throw new Error('project.json has an invalid graphHash')
  if (ref.size > MAX_GRAPH_DOCUMENT_TEXT_BYTES) throw new Error('graph.json exceeds the portable graph size limit')
  if (ref.format > GRAPH_DOCUMENT_FORMAT) {
    throw new Error(`graph.json format ${ref.format} is newer than this app supports`)
  }
  let text: string
  if (entry.source === 'gdrive') {
    text = await driveReadText(entry.dir, 'graph.json', ref.md5, ref.size)
  } else {
    text = await Folder.readText(entry.dir, 'graph.json')
  }
  // Verify the bytes actually returned to JS. A separate stat/hash followed
  // by read was a TOCTOU window: replacing graph.json between those calls
  // made the unbound second body authoritative.
  if (utf8TextByteLength(text) !== ref.size || md5Text(text) !== ref.md5) {
    throw new Error('graph.json does not match graphHash')
  }
  const parsed = parseGraphDocument(text)
  if (parsed.kind !== 'known' || parsed.format !== ref.format) {
    throw new Error(`graph.json is not a valid format-${ref.format} graph`)
  }
  return parsed
}

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
  const fetchFile = (file: string, md5?: string, size?: number): Promise<string> =>
    gdrive ? driveLocalFile(entry.dir, file, md5, size) : Folder.localFile(entry.dir, file)
  const readText = (file: string, md5?: string): Promise<string> =>
    gdrive ? driveReadText(entry.dir, file, md5) : Folder.readText(entry.dir, file)

  // A Drive listing's doc is a summary — the catalog manifest carries no
  // player state (beat grid, mixer, transpose). The real project.json rides
  // with the song; driveReadText keeps a copy, so a song opened once still
  // opens offline with everything. Falling back to the summary means a
  // never-opened song with no signal plays, just without those settings.
  let doc = entry.doc
  if (gdrive) {
    await crumb?.('fetching project.json')
    try {
      doc = JSON.parse(await readText('project.json')) as ProjectDoc
    } catch {
      doc = entry.doc
    }
  }
  // Resolve the one sanitized metronome state before any player sees this
  // document. Local projects are re-read inside the resolver; Drive projects
  // merge their account/project-scoped phone override over the remote doc.
  const metronomeRef = metronomeRefForEntry(entry)
  doc = await mobileMetronomePersistence.resolve(metronomeRef, doc)
  await crumb?.('graph')
  const graph = await loadProjectGraph(entry, doc)

  const ids = STEM_ORDER_ALL.filter(s => entry.stems[s])
  const added = customTracks(doc?.settings)
  const total = ids.length + added.length
  const stems: LoadedLane[] = []
  const source = gdrive ? 'Drive' : 'the folder'
  // Written BEFORE the work, so a song that never finishes still says which
  // one it was. A decode that runs out of memory takes the process with it,
  // and a log that only records successes is silent about exactly the opens
  // worth reading about.
  log(
    'song',
    `opening ${doc?.name ?? entry.dir} from ${source} · ${total} lanes` +
      ` (${ids.map(s => entry.stems[s]).join(', ')})`
  )
  const openedAt = Date.now()
  const spent: string[] = []
  const tooBig = (bytes: number): never => {
    log(
      'song',
      `refused ${entry.dir} — ${fmtBytes(bytes)} of decoded audio projected, ` +
        `over the ${fmtBytes(MAX_DECODED_BYTES)} budget`,
      'error'
    )
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
    const want = doc?.stemHashes?.[`${id}.${entry.stems[id]}`]
    const path = await fetchFile(`stems/${id}.${entry.stems[id]}`, want?.md5, want?.size)
    onStep(`Decoding ${id} · ${i + 1}/${total}`, (i + 0.5) / total)
    await crumb?.(`decoding ${id}`)
    // file:// matters: audio-api's Android RELEASE builds treat bare strings
    // as APK asset names ("Could not read asset bytes"); the scheme routes
    // them to the file decoder and is stripped on every other platform.
    const t0 = Date.now()
    stems.push({
      id,
      buffer: await decodeAudioData(`file://${path}`, sampleRate)
    })
    spent.push(`${id} ${fmtMs(Date.now() - t0)}`)
    // Stems are all the same length, so one decoded stem projects the whole
    // set. Bail on the projection rather than on the total: refusing after
    // six stems are already resident is refusing too late.
    const projected = (decodedBytes(stems) / stems.length) * ids.length
    if (projected > MAX_DECODED_BYTES) tooBig(projected)
  }
  // Guitar/piano lanes only appear when the song actually has them — the
  // desktop's audibleStems rule (sampled RMS < SILENT_LANE_LEVEL), ported so a
  // phone-split six-stem project shows the same lanes the desktop would.
  // Dropped buffers are released on the spot: the GC-is-too-late rule.
  for (let i = stems.length - 1; i >= 0; i--) {
    const lane = stems[i]
    if (!HIDEABLE_LANE_IDS.includes(lane.id)) continue
    const data = lane.buffer.getChannelData(0)
    let energy = 0
    let n = 0
    const step = Math.max(1, Math.floor(data.length / 200000))
    for (let j = 0; j < data.length; j += step) {
      energy += data[j] * data[j]
      n++
    }
    if (Math.sqrt(energy / Math.max(1, n)) < SILENT_LANE_LEVEL) {
      log('song', `${lane.id} lane is silent — hidden`)
      releaseStems([lane])
      stems.splice(i, 1)
    }
  }
  // Tracks the singer added on the desktop. They can be any length, so there
  // is nothing to project from — each one is checked against the budget as it
  // lands. A declared lane is part of the project, not an optional decoration:
  // silently skipping one makes the mixer claim that it is playing the saved
  // arrangement while audio is missing. Loading is therefore all-or-fail.
  for (let i = 0; i < added.length; i++) {
    const t = added[i]
    const at = ids.length + i
    onStep(`Fetching ${t.label} · ${at + 1}/${total}`, at / total)
    await crumb?.(`fetching ${t.id}`)
    try {
      const wantTrack = doc?.stemHashes?.[t.file.slice('stems/'.length)]
      const path = await fetchFile(t.file, wantTrack?.md5, wantTrack?.size)
      onStep(`Decoding ${t.label} · ${at + 1}/${total}`, (at + 0.5) / total)
      await crumb?.(`decoding ${t.id}`)
      const buffer = await decodeAudioData(`file://${path}`, sampleRate)
      stems.push({
        id: t.id,
        buffer,
        label: t.label,
        color: t.color,
        custom: true
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      log('song', `could not load added track "${t.label}" — ${detail}`, 'error')
      releaseStems(stems)
      stems.length = 0
      throw new Error(
        `Could not load the added track "${t.label}". The song was not opened because ` +
          `every saved lane must be available. ${detail}`
      )
    }
    if (decodedBytes(stems) > MAX_DECODED_BYTES) tooBig(decodedBytes(stems))
  }
  log(
    'song',
    `opened ${doc.name ?? entry.dir} — ${stems.length} lanes from ${source} in ` +
      `${fmtMs(Date.now() - openedAt)} · ${fmtBytes(decodedBytes(stems))} decoded · ` +
      `decode ${spent.join(', ')}`
  )
  onStep('Lyrics…', 0.98)
  await crumb?.('lyrics')
  let lyrics: LyricsDoc | null = null
  if (entry.hasLyrics) {
    onStep('Fetching lyrics…', 0.99)
    try {
      lyrics = JSON.parse(await readText('lyrics.json', doc?.lyricsHash?.md5)) as LyricsDoc
    } catch {
      lyrics = null
    }
  }
  return { name: doc.name ?? entry.dir, dir: entry.dir, doc, graph, lyrics, stems, metronomeRef }
}
