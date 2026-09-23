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
  /** App-private tags — phone publishing's state lives here. */
  appProperties?: Record<string, string>
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
  /** project.json, lyrics.json, and the explicitly referenced graph.json. */
  top: LocalEntry[]
  /** Everything in stems/, the singer's own tracks included. */
  stems: LocalEntry[]
  /** False when project.json could not be read here: the graph reference is
   * then unknown, and Drive's graph.json must be left alone rather than
   * trashed as unreferenced. */
  docReadable?: boolean
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
  trash: { entry: RemoteEntry; where: 'top' | 'stems' }[]
  /** Ids for the rows the catalog will carry; missing until an upload returns one. */
  rows: { name: string; size: string; md5Checksum: string; id?: string }[]
}

export function planProject(local: ProjectSnapshot, remote: RemoteProject): ProjectPlan {
  const steps: UploadStep[] = []
  let unchanged = 0
  const trash: ProjectPlan['trash'] = []

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
    // Arbitrary top-level files belong to the singer. graph.json is the one
    // managed top-level payload: removing its reference makes its old Drive
    // copy stale, while every other unknown file must remain untouched.
    if (where === 'stems') {
      trash.push(...orphans(new Set(mine.map((f) => f.name)), theirs).map((entry) => ({ entry, where })))
    }
    else if (local.docReadable !== false && !mine.some((f) => f.name === 'graph.json')) {
      trash.push(...theirs.filter((f) => f.name === 'graph.json').map((entry) => ({ entry, where })))
    }
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

/**
 * Phone publishing (Phase 6, docs/PHONE-STANDALONE.md). A phone moves a song
 * into the library by uploading it into a staging folder OUTSIDE the SingZ
 * root, verifying every file, and only then moving the finished folder in —
 * so the root never holds half a song. The folder carries two app-private
 * tags (appProperties: one OAuth client serves every platform, so the
 * phones' tags are the desktop's to read):
 *
 *   singzPublish  the phone's id for this move — how an interrupted move
 *                 finds its own folder again, before and after adoption
 *   singzState    'uploading' in staging, 'published' once in the root,
 *                 'adopted' once a desktop has taken it into its library
 *
 * Only 'published' may be adopted, and only 'published' is spared by the
 * reconcile. An 'adopted' folder with no local counterpart is a song the
 * desktop deleted, and is trashed like any other — so deleting an adopted
 * song on the computer can never bring it back from the phone's tag.
 */
export const PUBLISH_ID_KEY = 'singzPublish'
export const PUBLISH_STATE_KEY = 'singzState'
export const STATE_PUBLISHED = 'published'
export const STATE_ADOPTED = 'adopted'

/** What catalog.json advertises. Phones move songs only into a library whose
 *  desktop says it adopts them: an older desktop would trash the folder as an
 *  orphan on its next sync. The catalog stays format 2 — phones reject any
 *  other number and would fall back to walking every folder. */
export const CATALOG_CAPABILITIES = { adopt: 1 } as const

export const isPublished = (f: { appProperties?: Record<string, string> }): boolean =>
  f.appProperties?.[PUBLISH_STATE_KEY] === STATE_PUBLISHED

/**
 * The local folder name for an adopted song. The phone already cleaned it,
 * but a Drive name is the phone's word, not a fact about this filesystem —
 * and it must not collide, case-insensitively (APFS and NTFS both fold case),
 * with a project here or another folder on Drive: the sync pairs local and
 * remote folders BY NAME, so a collision would push the desktop's song into
 * the phone's folder. A taken name gets " (phone)", then " (phone 2)"…
 */
export function adoptionName(remoteName: string, taken: Iterable<string>): string {
  const base =
    remoteName
      .replace(/[\u0000-\u001f/\\:*?"<>|]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .trim() || 'Song from phone'
  const used = new Set([...taken].map((n) => n.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base} (phone)` : `${base} (phone ${n})`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

/** A name a Drive listing may hand us that is safe as ONE path segment. */
export const plainName = (name: string): boolean =>
  !!name && name !== '.' && name !== '..' && !/[/\\\u0000]/.test(name)

/** JSON with every object's keys sorted — for "is this the same content?"
 *  about documents other writers produced. The stem hashes come back from a
 *  directory walk in whatever order the filesystem lists them, so comparing
 *  plain JSON.stringify output rewrote (and re-uploaded) any doc another
 *  device had written, the first time this desktop synced it, for key order
 *  alone. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  )
}
