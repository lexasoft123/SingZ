import { NativeModules } from 'react-native'
import {
  DRIVE_FOLDER,
  driveAdoptionReady,
  driveAvailable,
  driveChildren,
  driveCreateFolder,
  driveEnsureRoot,
  driveFolderNamed,
  driveKeepText,
  driveListMovedIn,
  driveListProjects,
  driveMeta,
  drivePatch,
  driveSignedIn,
  driveUploadSession,
  PUBLISH_ID_KEY,
  PUBLISH_STATE_KEY,
  STAGING_FOLDER,
  STATE_PUBLISHED,
  STATE_UPLOADING,
  type DriveNode
} from './gdrive'
import { t } from './i18n'
import { fmtBytes, log } from './log'
import { STEM_ORDER_ALL, type ProjectDoc } from './model'
import { mutateProjectDocument } from './project-document'
import { dropRecord, recordFor, records, type MoveRecord } from './publish-record'

/**
 * Moving a song from "This phone" into the Google Drive library (Phase 6,
 * docs/PHONE-STANDALONE.md).
 *
 * The song is assembled in a staging folder OUTSIDE the SingZ root, one
 * verified file at a time, and moved into the library by a single request
 * only once every byte is there — so the library never holds half a song: no
 * desktop takes it in and no phone lists it. The folder is tagged with this
 * move's id (appProperties), which is how an interrupted move finds its own
 * work again whatever its name has become: a desktop renames it on adoption
 * when its own library already uses the name.
 *
 * The phone lets go of its copy only after the move-in: its stems become the
 * Drive song's downloaded copy (no second download), its texts seed the
 * offline cache, and the "This phone" folder goes. Killed at any step before
 * that, the song is still on the phone, and moving it again resumes — files
 * Drive already holds byte for byte are not sent twice. Once the folder is in
 * the library the phone never writes to it again: a desktop may already own it.
 */

interface MoveNative {
  statFile(project: string, relPath: string): Promise<{ md5: string; size: number; mtimeMs: number }>
  readText(project: string, file: string): Promise<string>
  /** Stream a project file to an upload URL (PUT); stems never cross the bridge. */
  uploadFile(
    project: string,
    relPath: string,
    url: string,
    contentType: string
  ): Promise<{ status: number; body: string }>
  /** Hand the project's stems to the Drive cache under `cacheProject`, then
   *  delete the "This phone" folder. Re-runnable: a retry moves what is left. */
  moveProjectToCache(project: string, cacheProject: string): Promise<boolean>
}
const Folder = NativeModules.FolderAccess as MoveNative

export type MoveStage = 'checking' | 'uploading' | 'finishing'

export interface MoveProgress {
  stage: MoveStage
  /** Bytes Drive holds of this song so far, and the song's whole size. */
  done: number
  total: number
  /** The file on its way, project-relative. */
  file?: string
}

export type MoveBlockReason = 'unconfigured' | 'signed-out' | 'update-desktop' | 'not-split'

/** A move that cannot start, for a reason the singer can do something about. */
export class MoveBlocked extends Error {
  constructor(
    readonly reason: MoveBlockReason,
    message: string
  ) {
    super(message)
  }
}

/** The singer stopped it. Nothing is lost: the song is still on the phone. */
export class MoveCancelled extends Error {}

interface OutFile {
  rel: string
  md5: string
  size: number
  mime: string
  /** Small texts are kept for the offline cache at the song's new address. */
  text?: string
}

function mimeOf(rel: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(rel)?.[1]?.toLowerCase() ?? ''
  switch (ext) {
    case 'json':
      return 'application/json'
    case 'flac':
      return 'audio/flac'
    case 'mp3':
      return 'audio/mpeg'
    case 'm4a':
    case 'aac':
      return 'audio/mp4'
    case 'ogg':
    case 'oga':
    case 'opus':
      return 'audio/ogg'
    case 'aif':
    case 'aiff':
      return 'audio/aiff'
    default:
      return 'audio/wav'
  }
}

/** One move job at a time. The look at launch and an "Add all" begun during
 *  it would otherwise both finish the same cut-off song — two natives handing
 *  the same stems to the cache, one failing on files the other already took,
 *  and a song that left the phone reported as one that stayed. */
let jobs: Promise<unknown> = Promise.resolve()
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = jobs.then(job, job)
  jobs = run.catch(() => undefined)
  return run
}

/** Did a move of this song start and not finish? Its record stands until the
 *  phone has let go of the song — what "Add all" resumes, and what
 *  finishCompletedMoves finishes. */
export async function moveInProgress(dir: string): Promise<boolean> {
  return (await records())[dir] !== undefined
}


const sameHash = (
  h: { md5: string; size: number } | undefined,
  st: { md5: string; size: number } | undefined
): boolean => !!h && !!st && h.md5 === st.md5 && h.size === st.size

/**
 * Every file the song is made of, in upload order — stems, the song file,
 * lyrics, graph, and project.json LAST — each with the md5 Drive must end up
 * holding. The doc has to state the files exactly as they are: a desktop
 * takes a song in only when every hash in it matches, and by then this phone
 * has let go of its own copy. So a doc that has drifted from its files is
 * brought up to date first, through the same queue every writer uses.
 */
async function manifestOf(dir: string, refreshed = false): Promise<OutFile[]> {
  const docText = await Folder.readText(dir, 'project.json')
  const doc = JSON.parse(docText) as ProjectDoc
  const stemNames = Object.keys(doc.stemHashes ?? {}).sort()
  const split = STEM_ORDER_ALL.some((id) => doc.stemHashes?.[`${id}.flac`] || doc.stemHashes?.[`${id}.wav`])
  if (!split) {
    throw new MoveBlocked('not-split', t('phone.library.notSplitForMove'))
  }
  const stat = (rel: string): ReturnType<MoveNative['statFile']> => Folder.statFile(dir, rel)
  const stems = await Promise.all(stemNames.map(async (name) => ({ name, st: await stat(`stems/${name}`) })))
  const song = await stat(doc.songFile)
  const lyrics = doc.lyricsHash ? await stat('lyrics.json') : undefined
  const graph = doc.graphHash ? await stat('graph.json') : undefined
  const drifted =
    stems.some(({ name, st }) => !sameHash(doc.stemHashes?.[name], st)) ||
    (doc.lyricsHash !== undefined && !sameHash(doc.lyricsHash, lyrics)) ||
    (doc.graphHash !== undefined && !sameHash(doc.graphHash, graph))
  if (drifted) {
    if (refreshed) throw new Error(`${dir}: its files keep changing — try again in a moment`)
    await mutateProjectDocument(dir, async (current) => {
      const next: ProjectDoc = { ...current }
      const hashes: NonNullable<ProjectDoc['stemHashes']> = {}
      for (const name of Object.keys(current.stemHashes ?? {})) hashes[name] = await stat(`stems/${name}`)
      next.stemHashes = hashes
      if (current.lyricsHash) next.lyricsHash = await stat('lyrics.json')
      if (current.graphHash) next.graphHash = { format: current.graphHash.format, ...(await stat('graph.json')) }
      return next
    })
    log('publish', `${dir}: project.json brought up to date with its files before moving`)
    return manifestOf(dir, true)
  }

  const out: OutFile[] = stems.map(({ name, st }) => ({
    rel: `stems/${name}`,
    md5: st.md5,
    size: st.size,
    mime: mimeOf(name)
  }))
  out.push({ rel: doc.songFile, md5: song.md5, size: song.size, mime: mimeOf(doc.songFile) })
  if (lyrics) {
    out.push({ rel: 'lyrics.json', ...lyrics, mime: 'application/json', text: await Folder.readText(dir, 'lyrics.json') })
  }
  if (graph) {
    out.push({ rel: 'graph.json', ...graph, mime: 'application/json', text: await Folder.readText(dir, 'graph.json') })
  }
  const docStat = await stat('project.json')
  out.push({ rel: 'project.json', md5: docStat.md5, size: docStat.size, mime: 'application/json', text: docText })
  return out
}

/**
 * The name a song can have in the library: the same cleanup the desktop's
 * adoptionName applies (src/main/sync-plan.ts), so a desktop taking the song
 * in finds nothing to rename. A rename there would leave this phone's
 * downloaded copy filed under the old name — the Drive tab would call the song
 * not downloaded, and the next open would fetch every stem again. The two are
 * held equal by the roundtrip suite.
 */
export function libraryName(name: string): string {
  return (
    name
      .replace(/[\u0000-\u001f/\\:*?"<>|]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s.]+/, '')
      .trim() || 'Song from phone'
  )
}

/** The library name for the moved song: the phone's own folder name, cleaned
 *  as above, unless the library already uses it (case-insensitively —
 *  desktops fold case), or it would shadow one of the two folders SingZ
 *  itself finds by name. */
function freeName(dir: string, rootKids: DriveNode[]): string {
  const base = libraryName(dir)
  const used = new Set(
    [...rootKids.filter((f) => f.mimeType === DRIVE_FOLDER).map((f) => f.name), 'SingZ', STAGING_FOLDER].map((n) =>
      n.toLowerCase()
    )
  )
  if (!used.has(base.toLowerCase())) return base
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base} (phone)` : `${base} (phone ${n})`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * Upload into this move's staging folder, skipping what an earlier attempt
 * already delivered, and clearing out anything the song no longer has (a
 * stem compacted to FLAC since the last attempt) — the folder must hold
 * exactly the song when it moves in.
 */
async function stage(
  dir: string,
  record: MoveRecord,
  files: OutFile[],
  opts: MoveOptions
): Promise<{ folder: DriveNode; staging: DriveNode }> {
  const total = files.reduce((n, f) => n + f.size, 0)
  const staging = (await driveFolderNamed(STAGING_FOLDER)) ?? (await driveCreateFolder(STAGING_FOLDER, null))
  const folder =
    (await driveChildren(staging.id)).find(
      (f) => f.mimeType === DRIVE_FOLDER && f.appProperties?.[PUBLISH_ID_KEY] === record.id
    ) ??
    (await driveCreateFolder(`upload-${record.id}`, staging.id, {
      [PUBLISH_ID_KEY]: record.id,
      [PUBLISH_STATE_KEY]: STATE_UPLOADING
    }))
  const top = await driveChildren(folder.id)
  const stemsDir =
    top.find((f) => f.name === 'stems' && f.mimeType === DRIVE_FOLDER) ?? (await driveCreateFolder('stems', folder.id))
  const stems = await driveChildren(stemsDir.id)

  const wanted = new Set(files.map((f) => f.rel))
  for (const f of [...top.map((r) => ({ r, rel: r.name })), ...stems.map((r) => ({ r, rel: `stems/${r.name}` }))]) {
    if (f.r.mimeType === DRIVE_FOLDER || wanted.has(f.rel)) continue
    await drivePatch(f.r.id, { trashed: true })
  }

  let done = 0
  for (const f of files) {
    if (opts.cancelled?.()) throw new MoveCancelled(t('phone.library.stoppedSongStill'))
    const inStems = f.rel.startsWith('stems/')
    const name = inStems ? f.rel.slice('stems/'.length) : f.rel
    const there = (inStems ? stems : top).find((r) => r.name === name && r.mimeType !== DRIVE_FOLDER)
    if (there && there.md5Checksum === f.md5 && Number(there.size) === f.size) {
      done += f.size
      opts.onProgress?.({ stage: 'uploading', done, total })
      continue // an earlier attempt already delivered these exact bytes
    }
    opts.onProgress?.({ stage: 'uploading', done, total, file: f.rel })
    const session = await driveUploadSession(name, inStems ? stemsDir.id : folder.id, there?.id)
    const res = await Folder.uploadFile(dir, f.rel, session, f.mime)
    if (res.status < 200 || res.status >= 300) throw new Error(`Drive refused ${f.rel} (${res.status})`)
    let id = there?.id
    try {
      id = (JSON.parse(res.body) as { id?: string }).id ?? id
    } catch {
      // a body we cannot read changes nothing when the file already had an id
    }
    if (!id) throw new Error(`Drive did not say where ${f.rel} went`)
    // What Drive now holds must be what this phone has: a connection cut short
    // can still end in a plausible response, and the phone is about to delete
    // the only other copy.
    const meta = await driveMeta(id)
    if (meta.md5Checksum !== f.md5 || Number(meta.size) !== f.size) {
      throw new Error(`${f.rel} arrived on Drive damaged — try again`)
    }
    done += f.size
    opts.onProgress?.({ stage: 'uploading', done, total })
  }
  return { folder, staging }
}

export interface MoveOptions {
  onProgress?: (p: MoveProgress) => void
  /** Checked between files: a stem mid-upload is allowed to finish. */
  cancelled?: () => boolean
}

/**
 * Move one "This phone" song into the Drive library. Resolves to the name it
 * now has there (which is also where its downloaded copy lives).
 */
export async function moveToDrive(dir: string, opts: MoveOptions = {}): Promise<{ name: string; bytes: number }> {
  if (!driveAvailable()) throw new MoveBlocked('unconfigured', 'Google Drive is not set up in this build.')
  if (!(await driveSignedIn())) {
    throw new MoveBlocked('signed-out', t('phone.library.signInFirstForMove'))
  }
  opts.onProgress?.({ stage: 'checking', done: 0, total: 0 })

  const already = await finishIfMovedIn(dir)
  if (already) return { name: already, bytes: 0 }

  const files = await manifestOf(dir)
  const total = files.reduce((n, f) => n + f.size, 0)
  const rootId = await driveEnsureRoot()
  if (!(await driveAdoptionReady(await driveChildren(rootId)))) {
    throw new MoveBlocked('update-desktop', t('phone.library.updateDesktopForMove'))
  }
  const record = await recordFor(dir)
  const started = Date.now()
  log('publish', `${dir}: moving ${files.length} files (${fmtBytes(total)}) to Google Drive`)
  const { folder, staging } = await stage(dir, record, files, opts)
  if (opts.cancelled?.()) throw new MoveCancelled(t('phone.library.stoppedSongStill'))
  // Re-listed: another phone or a desktop may have used the name meanwhile.
  const name = freeName(dir, await driveChildren(rootId))
  const target = await drivePatch(
    folder.id,
    { name, appProperties: { [PUBLISH_STATE_KEY]: STATE_PUBLISHED } },
    { add: rootId, remove: staging.id }
  )
  log('publish', `${dir}: in the Drive library as "${target.name}" (${Math.round((Date.now() - started) / 1000)} s)`)

  opts.onProgress?.({ stage: 'finishing', done: total, total })
  for (const f of files) {
    if (f.text !== undefined) await driveKeepText(target.name, f.rel, f.text)
  }
  const doc = JSON.parse(files.find((f) => f.rel === 'project.json')!.text!) as ProjectDoc
  return finish(dir, target, { doc, ...(await folderRows(target)) }, total)
}

/** A song folder's own Drive listing: its files, and its stems'. */
async function folderRows(folder: DriveNode): Promise<{ top: DriveNode[]; stems: DriveNode[] }> {
  const top = await driveChildren(folder.id)
  const stemsDir = top.find((f) => f.name === 'stems' && f.mimeType === DRIVE_FOLDER)
  return { top, stems: stemsDir ? await driveChildren(stemsDir.id) : [] }
}

/**
 * The phone's half of a move whose Drive half is done — the folder this song
 * went up into is in the library, published or already adopted. Resolves to
 * its library name once the phone has let go; null when there is nothing to
 * finish (no record, not moved in yet, or a record belonging to another song,
 * which is dropped). The finish may itself have been cut short, the stems
 * partly in the Drive cache already, so nothing here may insist on reading the
 * song's files again — and Drive is never written: the folder may already be
 * a desktop's.
 */
async function finishIfMovedIn(
  dir: string,
  rootKids?: DriveNode[],
  dropStale = true,
  busy?: (dir: string) => boolean
): Promise<string | null> {
  const earlier = (await records())[dir]
  if (!earlier) return null
  let kids = rootKids
  if (!kids) {
    const rootId = (await driveFolderNamed('SingZ'))?.id
    kids = rootId ? await driveChildren(rootId) : []
  }
  const target = kids.find((f) => f.mimeType === DRIVE_FOLDER && f.appProperties?.[PUBLISH_ID_KEY] === earlier.id)
  if (!target) return null
  const same = await sameSong(dir, target)
  if (!same) {
    // The record outlived the song it was made for, and a new song took the
    // name: letting go here would delete a song that never went up. Only a
    // move the singer started drops it; a look on its own cannot be sure it
    // read the right folder (see finishCompletedMoves).
    if (dropStale) {
      log('publish', `${dir}: an old move's record did not match this song — dropped`, 'warn')
      await dropRecord(dir)
    }
    return null
  }
  log('publish', `${dir}: already in the Drive library as "${target.name}" — finishing on the phone`)
  for (const rel of ['project.json', 'lyrics.json', 'graph.json']) {
    const text = await Folder.readText(dir, rel).catch(() => undefined)
    if (text !== undefined) await driveKeepText(target.name, rel, text)
  }
  // Asked last, just before the phone folder goes: a song opened in the
  // player meanwhile (or being analysed) keeps its folder and its record,
  // and the next look finishes it.
  if (busy?.(dir)) {
    log('publish', `${dir}: in use — it finishes moving once it is closed`)
    return null
  }
  await finish(dir, target, same, 0)
  return target.name
}

/**
 * A song is on this phone OR in the Drive library, never both. A move stopped
 * after its song reached the library but before the phone let go — the app
 * killed in those few seconds — is finished here, with no upload at all.
 * Called when the phone library is shown; best effort, and offline it simply
 * waits for next time. A move stopped EARLIER needs nothing: its song never
 * reached the library (staging is outside it), so it is still just a song on
 * this phone, and moving it again resumes where it stopped.
 */
export function finishCompletedMoves(busy?: (dir: string) => boolean): Promise<string[]> {
  return oneAtATime(() => finishCompletedMovesNow(busy))
}

async function finishCompletedMovesNow(busy?: (dir: string) => boolean): Promise<string[]> {
  const pending = Object.keys(await records())
  if (pending.length === 0 || !driveAvailable() || !(await driveSignedIn())) return []
  const rootId = (await driveFolderNamed('SingZ'))?.id
  if (!rootId) return []
  const kids = await driveChildren(rootId)
  const finished: string[] = []
  for (const dir of pending) {
    try {
      // never drops a record: a doc it cannot read (a picked folder still the
      // root at launch) says nothing about whether this song went up
      if (await finishIfMovedIn(dir, kids, false, busy)) finished.push(dir)
    } catch (e) {
      log('publish', `${dir}: could not finish its move yet — ${String(e)}`, 'warn')
    }
  }
  return finished
}

/** A song's identity by its audio: the md5s of every stem its doc names. A
 *  phone copy of a Drive song — a folder copied in from a computer — has the
 *  same, and moving it would only make a "(phone)" duplicate. */
export function stemSignature(doc: ProjectDoc | null | undefined): string {
  return Object.values(doc?.stemHashes ?? {})
    .map((h) => h.md5)
    .sort()
    .join(',')
}

export interface BatchProgress {
  /** Which song, from 0, of how many. */
  index: number
  count: number
  dir: string
  /** Bytes of the whole batch Drive holds so far, of the batch's size. */
  done: number
  total: number
}

export interface BatchResult {
  moved: { dir: string; name: string }[]
  /** Songs passed over, each with why — the batch went on without them. */
  skipped: { dir: string; reason: string }[]
  /** Why the batch ended before its last song, if it did. `blockReason` is
   *  the stable MoveBlocked reason behind a 'blocked' stop (never present
   *  otherwise) — the display side reads THIS to tell "signed out" apart
   *  from "update the desktop", never the (translated) message text. */
  stopped?: { reason: 'cancelled' | 'blocked' | 'failed'; message: string; blockReason?: MoveBlockReason }
}

/**
 * Every song the singer asked to move, one after another ("Add all local
 * songs to Google Drive"). Stops for what would stop every song — the singer
 * pressing Stop, an older desktop, signed out, or two songs failing in a row
 * (offline, most likely) — and passes over what belongs to one song alone: a
 * song busy splitting or being analysed, one not split, one whose own move
 * fails. Whatever does not move stays on the phone, where the offer finds it
 * again.
 */
export interface BatchOptions {
  onProgress?: (p: BatchProgress) => void
  onMoved?: (dir: string, name: string) => void
  cancelled?: () => boolean
  busy?: (dir: string) => boolean
}

export function moveAllToDrive(dirs: string[], opts: BatchOptions = {}): Promise<BatchResult> {
  return oneAtATime(() => moveAllNow(dirs, opts))
}

async function moveAllNow(dirs: string[], opts: BatchOptions): Promise<BatchResult> {
  const sizes = await Promise.all(dirs.map((d) => moveSize(d).catch(() => 0)))
  const total = sizes.reduce((n, b) => n + b, 0)
  const out: BatchResult = { moved: [], skipped: [] }
  // A song with a move record may have reached the library already — its OWN
  // folder there then has its stems, and it must be finished, not taken for a
  // copy (moveToDrive's resume decides).
  const midMove = await records()
  // What the library already holds, by audio: a copy of one of those is not
  // sent up again. Offline this is simply empty — the uploads say so.
  const inDrive = new Set<string>()
  try {
    for (const e of await driveListProjects()) {
      const sig = stemSignature(e.doc)
      if (sig) inDrive.add(sig)
    }
  } catch {
    // no listing, no duplicates known
  }
  let base = 0
  let shown = 0
  let failedInARow = 0
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]
    if (opts.cancelled?.()) {
      out.stopped = { reason: 'cancelled', message: t('phone.library.stoppedRestStill') }
      break
    }
    // never backwards: a doc brought up to date mid-move can differ from the
    // size measured before the batch began
    const report = (done: number): void => {
      shown = Math.max(shown, Math.min(total, base + done))
      opts.onProgress?.({ index: i, count: dirs.length, dir, done: shown, total })
    }
    report(0)
    let doc: ProjectDoc | null = null
    try {
      doc = JSON.parse(await Folder.readText(dir, 'project.json')) as ProjectDoc
    } catch {
      doc = null
    }
    const sig = stemSignature(doc)
    if (!doc) {
      // deleted while the batch was running: nothing to move, nothing wrong
    } else if (opts.busy?.(dir)) {
      out.skipped.push({ dir, reason: t('phone.library.skipInUse') })
    } else if (sig && inDrive.has(sig) && !midMove[dir]) {
      out.skipped.push({ dir, reason: t('phone.library.skipAlreadyInDrive') })
    } else {
      try {
        const res = await moveToDrive(dir, {
          cancelled: opts.cancelled,
          onProgress: (p) => {
            if (p.stage === 'uploading') report(p.done)
          }
        })
        out.moved.push({ dir, name: res.name })
        if (sig) inDrive.add(sig) // a second phone copy of it is a duplicate now
        opts.onMoved?.(dir, res.name)
        failedInARow = 0
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (e instanceof MoveCancelled) {
          out.stopped = { reason: 'cancelled', message }
          break
        }
        if (e instanceof MoveBlocked && e.reason !== 'not-split') {
          out.stopped = { reason: 'blocked', message, blockReason: e.reason }
          break
        }
        out.skipped.push({ dir, reason: inWords(message) })
        log('publish', `${dir}: passed over — ${message}`, 'warn')
        if (!(e instanceof MoveBlocked) && ++failedInARow >= 2) {
          out.stopped = { reason: 'failed', message }
          break
        }
      }
    }
    base += sizes[i]
    report(0)
  }
  return out
}

/** Why a song was passed over, as the singer reads it: a dropped connection
 *  in plain words (each platform's networking says it its own way), anything
 *  else as the move said it. The Log keeps the original. */
function inWords(message: string): string {
  return /network request failed|timed out|timeout|offline|could not connect|failed to connect|unable to resolve host|connection (was )?(lost|reset|refused|abort)|stalled/i.test(
    message
  )
    ? t('phone.library.connectionDroppedSkip')
    : message
}

/**
 * Is the song in this phone folder the one that moved into `target`? Asked of
 * the doc's own stem hashes against Drive's listing — never of the files, some
 * of which an interrupted finish may already have handed to the cache. A new
 * song under a reused name has other stems (or only its unsplit original,
 * which never goes to Drive), so it cannot match. Resolves to the doc and the
 * folder's listing when it is the same song, null when not.
 */
async function sameSong(
  dir: string,
  target: DriveNode
): Promise<{ doc: ProjectDoc; top: DriveNode[]; stems: DriveNode[] } | null> {
  let doc: ProjectDoc
  try {
    doc = JSON.parse(await Folder.readText(dir, 'project.json')) as ProjectDoc
  } catch {
    return null
  }
  const mine = Object.entries(doc.stemHashes ?? {})
  if (mine.length === 0) return null
  const { top, stems } = await folderRows(target)
  const theirs = new Map(stems.map((f) => [f.name, f]))
  const same = mine.every(([name, h]) => {
    const f = theirs.get(name)
    return !!f && f.md5Checksum === h.md5 && Number(f.size) === h.size
  })
  return same ? { doc, top, stems } : null
}

/** What moving this song sends: every file the doc names, and the song file,
 *  which the doc has no hash for — the confirm states the real cost. */
export async function moveSize(dir: string): Promise<number> {
  const doc = JSON.parse(await Folder.readText(dir, 'project.json')) as ProjectDoc
  let bytes = Object.values(doc.stemHashes ?? {}).reduce((n, h) => n + h.size, 0)
  bytes += (doc.lyricsHash?.size ?? 0) + (doc.graphHash?.size ?? 0)
  for (const rel of [doc.songFile, 'project.json']) {
    try {
      bytes += (await Folder.statFile(dir, rel)).size
    } catch {
      // an unreadable song file fails the move itself, with its own message
    }
  }
  return bytes
}

/** The phone's half: the song joins the saved Drive listing FIRST (see
 *  driveListMovedIn — offline, that is the only place it will be named),
 *  then its stems become the Drive song's downloaded copy and the "This
 *  phone" folder goes. Re-runnable — the native moves what is left. */
async function finish(
  dir: string,
  target: DriveNode,
  song: { doc: ProjectDoc; top: DriveNode[]; stems: DriveNode[] },
  bytes: number
): Promise<{ name: string; bytes: number }> {
  await driveListMovedIn(target.name, song.doc, song.top, song.stems)
  await Folder.moveProjectToCache(dir, target.name)
  await dropRecord(dir)
  log('publish', `${dir}: moved — it plays from the Drive library now, already downloaded`)
  return { name: target.name, bytes }
}

/**
 * A song deleted from the phone mid-move takes its unfinished upload with it
 * — but never a folder that already moved into the library: that is a song
 * on Drive now, possibly already a desktop's. Best effort; offline, the
 * staging folder simply stays (outside the library, where nothing lists it).
 */
export async function abandonMove(dir: string): Promise<void> {
  const record = (await records())[dir]
  if (!record) return
  await dropRecord(dir)
  try {
    const staging = await driveFolderNamed(STAGING_FOLDER)
    if (!staging) return
    const mine = (await driveChildren(staging.id)).find(
      (f) => f.mimeType === DRIVE_FOLDER && f.appProperties?.[PUBLISH_ID_KEY] === record.id
    )
    if (mine) await drivePatch(mine.id, { trashed: true })
  } catch (e) {
    log('publish', `${dir}: could not clear its unfinished upload — ${String(e)}`, 'warn')
  }
}
