import { NativeModules } from 'react-native'
import { log } from '../log'
import { filesOfProject } from '../current'
import { STEM_ORDER_ALL, type ProjectDoc } from '../model'
import { readProjectText } from '../projects'
import {
  DRIVE_FOLDER,
  driveChildren,
  driveFolderNamed,
  driveLocalFile,
  drivePatch,
  driveReadText,
  type DriveNode
} from '../gdrive'

/**
 * A song split from the Drive tab is split the ordinary way — the split
 * service, its job, and adoptSplit are all phone-documents-root code with no
 * Drive awareness anywhere, and that is deliberate rather than a gap to
 * close: this brings the song HOME first, the same way a phone singer would,
 * rather than teaching the split pipeline a second, Drive-aware way to write
 * stems. Once pulled, `startProjectSplit`/`finishSplit` run completely
 * unmodified; the song is an ordinary "This phone" song from that point on,
 * and the existing "Add all local songs to Google Drive" offer is what
 * sends it back up — the same one door every other move already goes
 * through, not a second, hidden path.
 *
 * What counts as this song's AUDIO is decided by `filesOfProject`, the
 * same rule the listing and the download ✓ already use: the six stems
 * (never true here — canSplit refuses a song that has any), a
 * custom-original lane for a phone-added song that was moved before it was
 * split, or the source track itself for a song with no lane at all. One
 * rule, reused, rather than a third reimplementation of "what is this
 * unsplit song's audio". A phone-added song's doc ALSO names its source
 * track separately (songFile/songHash, stated at creation regardless of the
 * lane) — filesOfProject rightly ignores it, since nothing needs it to
 * PLAY the song, but startProjectSplit reads the source to split from that
 * exact field unconditionally, so materialize() fetches it too when it is
 * not already the one file above. See materialize()'s own comment.
 *
 * Verified before trusted, in both directions: the pulled copy is hashed
 * against the doc BEFORE project.json is written locally, and Drive is only
 * ever trashed (never hard-deleted — recoverable in the account's own Trash)
 * AFTER that local copy is confirmed. A crash between the two leaves the
 * song doubly safe rather than doubly gone: still in Drive, already on the
 * phone. project.json is written LAST, as everywhere else in this codebase,
 * which is what makes a retry resumable — `ensureProjectDir` disambiguates
 * a name only once project.json exists there, so calling it again before
 * that point returns the SAME folder rather than a duplicate.
 */

interface PullNative {
  ensureProjectDir(name: string): Promise<{ dir: string; path: string }>
  copyIntoProject(project: string, relPath: string, srcPath: string): Promise<boolean>
  writeText(project: string, file: string, text: string): Promise<boolean>
  statFile(
    project: string,
    relPath: string
  ): Promise<{ md5: string; size: number; mtimeMs: number }>
}
const Folder = NativeModules.FolderAccess as PullNative

const isSplit = (doc: ProjectDoc): boolean =>
  STEM_ORDER_ALL.some((id) => doc.stemHashes?.[`${id}.flac`] || doc.stemHashes?.[`${id}.wav`])

/** Is there already a phone-local folder named `dir` whose audio matches
 *  this pull, from an earlier attempt that got as far as writing
 *  project.json but not as far as trashing the Drive copy? A local folder
 *  that exists for some OTHER reason (an unrelated song sharing the name)
 *  reads as "no match" here and is left alone — the fresh pull below then
 *  lands in a freshly disambiguated folder instead, same as any other name
 *  collision on this phone. */
async function alreadyPulled(dir: string, wanted: { path: string; md5: string }): Promise<boolean> {
  try {
    const local = JSON.parse(await readProjectText(dir, 'project.json')) as ProjectDoc
    return filesOfProject(local).some((f) => f.path === wanted.path && f.md5 === wanted.md5)
  } catch {
    return false
  }
}

async function driveProjectFolder(dir: string): Promise<DriveNode | null> {
  const rootId = (await driveFolderNamed('SingZ'))?.id
  if (!rootId) return null
  const kids = await driveChildren(rootId)
  return kids.find((f) => f.mimeType === DRIVE_FOLDER && f.name === dir) ?? null
}

/** Fetch one Drive file into the local project and verify it landed intact.
 *  `dir` is the Drive-side name the file is fetched FROM; `localDir` is
 *  where it is placed, which can differ on a name collision. */
async function fetchVerified(
  dir: string,
  localDir: string,
  file: { path: string; md5: string; size: number }
): Promise<void> {
  const cachedPath = await driveLocalFile(dir, file.path, file.md5, file.size)
  await Folder.copyIntoProject(localDir, file.path, cachedPath)
  const placed = await Folder.statFile(localDir, file.path)
  if (placed.md5 !== file.md5 || placed.size !== file.size) {
    throw new Error(`${dir}: arrived on this phone damaged — try again`)
  }
}

/** Fetch, place and verify everything a split needs to run on this song once
 *  it is local: its audio (filesOfProject's one file — a custom-original
 *  lane, or the source track for a doc with no stems at all), its lyrics if
 *  it has any, AND ITS SOURCE TRACK, even when that is a SECOND file beyond
 *  the audio above.
 *
 *  That second file matters for exactly one shape: a song added on the
 *  phone and later moved to Drive carries BOTH a custom-original lane (its
 *  audio, per filesOfProject, and the only thing a singer ever plays before
 *  a split) AND songHash for song.<ext> (writer.ts states it unconditionally
 *  at creation). filesOfProject rightly leaves song.<ext> out — nothing
 *  downloads it to PLAY the song — but startProjectSplit reads the source to
 *  split from `localProjectFile(project, doc.songFile)` UNCONDITIONALLY, the
 *  same songFile every doc names, custom-original lane or not. Without this,
 *  a pull would "succeed" and the split would fail the moment it started,
 *  against a project.json that names a file nothing ever fetched.
 *
 *  Resolves to the local folder the pull landed in — `dir` unless an
 *  unrelated local song already had that name. */
async function materialize(dir: string, doc: ProjectDoc, audio: { path: string; md5: string; size: number }): Promise<string> {
  const { dir: localDir } = await Folder.ensureProjectDir(dir)
  await fetchVerified(dir, localDir, audio)
  if (doc.songHash && doc.songFile && doc.songFile !== audio.path) {
    await fetchVerified(dir, localDir, { path: doc.songFile, md5: doc.songHash.md5, size: doc.songHash.size })
  }
  if (doc.lyricsHash) {
    await fetchVerified(dir, localDir, { path: 'lyrics.json', md5: doc.lyricsHash.md5, size: doc.lyricsHash.size })
  }
  // Written LAST: this is the line a resumed pull looks for. Before it,
  // ensureProjectDir(dir) above returns the SAME folder on a retry; after
  // it, alreadyPulled() recognises this attempt instead of repeating it.
  await Folder.writeText(
    localDir,
    'project.json',
    JSON.stringify({ ...doc, savedAt: new Date().toISOString() }, null, 2)
  )
  log('split', `${dir}: pulled from Drive to ${localDir} for splitting`)
  return localDir
}

/**
 * Brings a Drive-only, unsplit song onto this phone so it can be split like
 * any other. Resolves to the LOCAL folder name once done — usually `dir`
 * unchanged, but disambiguated if this phone already has an unrelated song
 * by that name. Safe to call again after any interruption; each call picks
 * up wherever the last one got to rather than repeating finished work.
 */
export async function pullFromDrive(dir: string): Promise<{ dir: string }> {
  const doc = JSON.parse(await driveReadText(dir, 'project.json')) as ProjectDoc
  if (isSplit(doc)) {
    // canSplit already refuses this in the UI; a caller that got here
    // anyway is a bug worth a clear message, not a silent no-op.
    throw new Error(`${dir}: already has its six stems — nothing to pull for a split`)
  }
  const wanted = filesOfProject(doc)
  if (wanted.length !== 1) {
    throw new Error(`${dir}: expected exactly one file to split from, found ${wanted.length}`)
  }
  const [audio] = wanted

  const localDir = (await alreadyPulled(dir, audio)) ? dir : await materialize(dir, doc, audio)

  // Re-checked right here, not trusted from the materialize/alreadyPulled
  // call above: the UI's own guard is what is meant to stop a concurrent
  // delete from ever reaching this song while it is 'pulling' (see
  // confirmDelete in CatalogScreen.tsx), but this is the line that actually
  // decides whether Drive loses its copy, so it does not take that guard's
  // word for it. A delete that got here anyway — through a path this UI
  // does not know about, or a bug in that guard — must stop the retirement,
  // not carry on and turn "gone from the phone" into "gone from everywhere".
  const stillHere = await Folder.statFile(localDir, audio.path).then(
    () => true,
    () => false
  )
  if (!stillHere) {
    throw new Error(`${dir}: no longer on this phone — Google Drive's copy was kept`)
  }

  // The Drive copy is trashed under ITS OWN name always — a collision that
  // disambiguated the LOCAL folder never touches what this song was called
  // on Drive, which is what driveProjectFolder is asked to find.
  const folder = await driveProjectFolder(dir)
  if (folder) {
    await drivePatch(folder.id, { trashed: true })
    log('split', `${dir}: retired from Google Drive — now on this phone only`)
  } else {
    // Already gone from Drive by some other route (the web UI, another
    // device) — nothing to retire, and worth a line, since every other
    // branch here says what it did or did not do.
    log('split', `${dir}: no Drive folder left to retire — already gone`)
  }
  return { dir: localDir }
}
