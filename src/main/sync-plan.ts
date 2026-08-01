/**
 * What a sync should do, decided without touching Drive or the disk.
 *
 * The rule is the same one the phones run, pointed the other way: compare what
 * is here against what is there, per file, and act only on the differences.
 * The old shortcut asked a different question — "does this project's
 * fingerprint match the catalog I wrote last time?" — which is a record of past
 * actions, not a fact about Drive, so anything that changed on Drive stayed
 * invisible forever. Keeping the decisions here, pure, is what makes that
 * difference testable rather than a matter of reading the sync loop carefully.
 */

export interface RemoteEntry {
  id: string
  name: string
  mimeType?: string
  md5Checksum?: string
  size?: string
  parents?: string[]
}

export interface LocalEntry {
  name: string
  md5: string
  size: number
  /** Absolute path, for the uploader. */
  path: string
  mime: string
}

/** Drive's q language, one clause per folder: children of many folders in one
 *  request. Chunked because a q string cannot grow forever. */
export function parentsQuery(ids: string[]): string {
  return `(${ids.map((id) => `'${id}' in parents`).join(' or ')}) and trashed=false`
}

export const PARENTS_PER_QUERY = 50

export function chunkParents(ids: string[], per = PARENTS_PER_QUERY): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += per) out.push(ids.slice(i, i + per))
  return out
}

/** Which local files Drive does not already hold, byte for byte. */
export function planSync(
  local: { name: string; md5: string }[],
  remote: { name: string; md5Checksum?: string }[]
): { upload: string[]; unchanged: string[] } {
  const remoteByName = new Map(remote.map((f) => [f.name, f.md5Checksum]))
  const upload: string[] = []
  const unchanged: string[] = []
  for (const f of local) {
    if (remoteByName.get(f.name) === f.md5) unchanged.push(f.name)
    else upload.push(f.name)
  }
  return { upload, unchanged }
}

/** Remote files with no local counterpart: a lane a re-split dropped, a custom
 *  track the singer removed. Left behind they keep appearing on phones. */
export function orphans(localNames: Set<string>, remote: RemoteEntry[]): RemoteEntry[] {
  return remote.filter((f) => !localNames.has(f.name))
}

export interface ProjectSnapshot {
  dir: string
  /** project.json and lyrics.json. */
  top: LocalEntry[]
  /** Everything in stems/, the singer's own tracks included. */
  stems: LocalEntry[]
}

export interface RemoteProject {
  folderId?: string
  stemsId?: string
  top: RemoteEntry[]
  stems: RemoteEntry[]
}

export interface UploadStep {
  name: string
  where: 'top' | 'stems'
  path: string
  mime: string
  existingId?: string
}

export interface ProjectPlan {
  dir: string
  upload: UploadStep[]
  unchanged: number
  /** Orphan FILES — folders are reconciled at library level. */
  trash: RemoteEntry[]
  /** Ids for the rows the catalog will carry; missing until an upload returns one. */
  rows: { name: string; size: string; md5Checksum: string; id?: string }[]
}

export function planProject(local: ProjectSnapshot, remote: RemoteProject): ProjectPlan {
  const steps: UploadStep[] = []
  let unchanged = 0
  const trash: RemoteEntry[] = []

  for (const [where, mine, theirs] of [
    ['top', local.top, remote.top],
    ['stems', local.stems, remote.stems]
  ] as const) {
    const plan = planSync(mine, theirs)
    unchanged += plan.unchanged.length
    for (const name of plan.upload) {
      const f = mine.find((x) => x.name === name)
      if (!f) continue
      steps.push({
        name,
        where,
        path: f.path,
        mime: f.mime,
        existingId: theirs.find((r) => r.name === name)?.id
      })
    }
    // top-level orphans are left alone: song.mp3 and anything else a singer
    // keeps beside the project are not ours to tidy. Only stems/ is ours.
    if (where === 'stems') trash.push(...orphans(new Set(mine.map((f) => f.name)), theirs))
  }

  return {
    dir: local.dir,
    upload: steps,
    unchanged,
    trash,
    rows: local.top.map((f) => ({
      name: f.name,
      size: String(f.size),
      md5Checksum: f.md5,
      id: remote.top.find((r) => r.name === f.name)?.id
    }))
  }
}

/** Remote project folders the library no longer has — renamed or deleted here. */
export function orphanFolders(rootChildren: RemoteEntry[], localDirs: Set<string>, folderMime: string): RemoteEntry[] {
  return rootChildren.filter((f) => f.mimeType === folderMime && !localDirs.has(f.name))
}

/** mtime is compared with tolerance, not equality: iCloud rehydration rewrites
 *  it with sub-ms truncation (~300 ns measured on the first evict/materialize
 *  round-trip). A real write moves it by far more, and size stands on its own. */
export const MTIME_TOLERANCE_MS = 2

export function isFresh(
  prev: { size: number; mtimeMs: number } | undefined,
  st: { size: number; mtimeMs: number }
): boolean {
  return !!prev && prev.size === st.size && Math.abs(prev.mtimeMs - st.mtimeMs) < MTIME_TOLERANCE_MS
}
