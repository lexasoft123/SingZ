import { app } from 'electron'
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fsyncDirectorySync, writeAllSync } from './atomic-file'
import { log } from './log'

/**
 * Which remote project folders THIS install provably published THIS library
 * into — the only folders the reconcile may ever trash.
 *
 * Every SingZ install shares one OAuth client, so drive.file does not limit a
 * listing to "folders this computer made": a fresh profile, a library switch or
 * a second desktop sees every desktop's projects. A name ("no local folder
 * called that") cannot tell a song deleted here from a song this library never
 * had, and neither can "we once meant to upload there". So there are two sets:
 *
 *   pending  folders this install STARTED publishing into but did not prove
 *            its own (a pre-existing folder paired by name). Never deletion
 *            authority, and never promoted later: current bytes matching the
 *            library prove nothing about who wrote them, so a pending folder
 *            stays on Drive for good. That is the fail-safe direction.
 *   owned    deletion authority. Granted only for a folder this install
 *            positively created, a phone song it verifiably took in, or a
 *            folder whose complete roster — nested folders included — is,
 *            right after one publishing run's uploads all succeeded, made
 *            only of members that same run wrote (gdrive.ts, provenRoster).
 *            Those member ids are recorded with the grant.
 *
 * The record is bound to the signed-in Google account (Drive's permissionId),
 * the SingZ root folder and the library root — its real path AND its physical
 * identity (device, inode, birth time). A different library at the same path
 * (replaced, restored from backup, another volume mounted there) or another
 * account starts with no authority. Nothing is ever seeded by name: an install
 * upgrading from before this record existed owns nothing until it publishes,
 * so a local delete made before the upgrade simply does not propagate.
 *
 * The native app keeps the same proof (its publication lineage) in its own
 * store; neither trashes a folder the other made for a library it never had.
 */

interface RootIdentity {
  dev: string
  ino: string
  birthtimeNs: string
}

interface Binding {
  account: string
  singzId: string
  root: string
  identity: RootIdentity
  owned: string[]
  pending: string[]
  /** For owned folders proven by a publishing run: the member ids it wrote. */
  proofs?: Record<string, string[]>
}

interface LineageFile {
  format: 2
  bindings: Record<string, Binding>
}

const fileName = 'drive-lineage.json'
const lineageFile = (): string => join(app.getPath('userData'), fileName)
const empty = (): LineageFile => ({ format: 2, bindings: {} })

function load(): LineageFile {
  let text: string
  try {
    text = readFileSync(lineageFile(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
    throw error // unreadable: never guess — the sync stops rather than forget
  }
  try {
    const parsed = JSON.parse(text) as LineageFile
    if (parsed?.format === 2 && parsed.bindings && typeof parsed.bindings === 'object' && !Array.isArray(parsed.bindings)) {
      return parsed
    }
  } catch {
    /* torn or foreign — handled below */
  }
  // Starting over is fail-safe: an empty record trashes nothing.
  log('gdrive', `${fileName} is not readable — starting a new record; no remote folder will be trashed until it is relearned`, 'warn')
  return empty()
}

/** temp + fsync + rename + directory fsync: a crash leaves the old record or
 *  the new one, never half of either, and a failed write leaves no temp. */
function save(next: LineageFile): void {
  const path = lineageFile()
  const tmp = `${path}.${process.pid}.tmp`
  try {
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeAllSync(fd, Buffer.from(JSON.stringify(next)))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  fsyncDirectorySync(dirname(path))
}

/** The library root as a physical directory, or null where the filesystem
 *  gives no stable identity (no inode) — then nothing is ever owned. */
function identify(root: string): { real: string; identity: RootIdentity | null } {
  const real = realpathSync(root)
  const info = statSync(real, { bigint: true })
  if (!info.isDirectory()) throw new Error(`${root} is not a library folder`)
  const identity = info.ino > 0n
    ? { dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs) }
    : null
  return { real, identity }
}

const sameIdentity = (a: RootIdentity | undefined, b: RootIdentity | null): boolean =>
  !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : []

export interface DriveLineage {
  /** Deletion authority: this install provably published this folder. */
  owns(folderId: string): boolean
  /** Durable before it returns: publishing into a folder we do not own. */
  intend(folderId: string): void
  /** Durable before it returns: positively created, adopted, or proven by a
   *  publishing run (then with the member ids that run wrote). */
  grant(folderId: string, writtenMembers?: string[]): void
  forget(folderIds: Iterable<string>): void
  /** Throws if the library root is no longer the directory this was bound to. */
  assertBound(): void
}

/** No authority at all: nothing is owned, nothing is recorded. For a run that
 *  could not tell which Google account it is signed in as. */
export const inertLineage = (): DriveLineage => ({
  owns: () => false,
  intend: () => {},
  grant: () => {},
  forget: () => {},
  assertBound: () => {}
})

export function driveLineage(account: string, singzId: string, libraryRoot: string): DriveLineage {
  if (!account || !singzId) throw new Error('Drive lineage needs an account and a SingZ folder')
  const { real, identity } = identify(libraryRoot)
  if (!identity) {
    // No proof is possible here, so no authority: the sync still publishes,
    // but claims and removes nothing.
    log('gdrive', `${real} has no stable directory identity — deleted projects will not be removed from Drive`, 'warn')
    return inertLineage()
  }
  const key = JSON.stringify([account, singzId, real])
  const stored = load().bindings[key]
  const bound = sameIdentity(stored?.identity, identity)
  if (stored && !bound) {
    log('gdrive', `the library at ${real} is not the one Drive sync last saw there — no remote folder will be trashed until this one publishes`, 'warn')
  }
  const owned = new Set(bound ? ids(stored!.owned) : [])
  const pending = new Set(bound ? ids(stored!.pending) : [])
  const proofs = new Map<string, string[]>()
  for (const [id, members] of Object.entries(bound && stored!.proofs && typeof stored!.proofs === 'object' ? stored!.proofs : {})) {
    if (owned.has(id)) proofs.set(id, ids(members))
  }
  const persist = (): void => {
    if (!identity) return
    const file = load()
    file.bindings[key] = { account, singzId, root: real, identity, owned: [...owned].sort(), pending: [...pending].sort(),
      proofs: Object.fromEntries([...proofs].sort(([a], [b]) => (a < b ? -1 : 1))) }
    save(file)
  }
  const assertBound = (): void => {
    if (!sameIdentity(identity ?? undefined, identify(libraryRoot).identity) || realpathSync(libraryRoot) !== real) {
      throw new Error('The library folder changed during sync — nothing was removed from Drive')
    }
  }
  return {
    owns: (id) => !!identity && owned.has(id),
    intend(id) {
      if (!id || owned.has(id) || pending.has(id)) return
      pending.add(id)
      persist()
    },
    grant(id, writtenMembers) {
      if (!id || !identity || (owned.has(id) && !pending.has(id) && !writtenMembers)) return
      assertBound()
      owned.add(id)
      pending.delete(id)
      if (writtenMembers) proofs.set(id, [...writtenMembers].sort())
      persist()
    },
    forget(folderIds) {
      let changed = false
      for (const id of folderIds) changed = [owned.delete(id), pending.delete(id), proofs.delete(id)].some(Boolean) || changed
      if (changed) persist()
    },
    assertBound
  }
}
