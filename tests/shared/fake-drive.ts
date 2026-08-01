import { createHash } from 'node:crypto'

/**
 * Google Drive v3, faked, as a pure function of a store — no server, no fetch.
 *
 * One implementation for both roots: the desktop suite drives it over node http
 * (fake-drive-http.ts) and the mobile suite swaps it in for globalThis.fetch
 * (fake-drive-fetch.ts). Two divergent fakes is how a format change on one side
 * broke no test on the other, and how a batched query could be answered with one
 * folder's children and still look green.
 *
 * It covers exactly what SingZ asks Drive for, and the awkward parts on purpose:
 * multi-clause parent queries, paging, field projection, trashing, and a store
 * that can report metadata the bytes disagree with.
 */

export const FOLDER = 'application/vnd.google-apps.folder'

export interface FakeFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  bytes?: Buffer
  trashed?: boolean
  /** What the LISTING reports, when it must disagree with the bytes served —
   *  a stale index, a file rewritten between the listing and the download. */
  md5Override?: string
  sizeOverride?: string
}

export interface Fault {
  /** Matched against "METHOD /path" — the request to break. */
  match: RegExp
  status: number
  /** How many times to fire (default 1); Infinity for "always". */
  times?: number
}

export interface FakeDriveStore {
  files: Map<string, FakeFile>
  sessions: Map<string, string>
  nextId: number
  /** Every request served, "METHOD /path?decoded-query" — the traffic a
   *  refresh really needs is an assertion, not a guess. */
  hits: string[]
  faults: Fault[]
  /** Force paging with three files instead of a thousand. */
  pageSizeCap?: number
  /** Where upload sessions point back to (the http adapter sets its own). */
  baseUrl: string
}

export interface FakeResponse {
  status: number
  headers: Record<string, string>
  body: Buffer | string
}

export function newStore(init?: Partial<FakeDriveStore>): FakeDriveStore {
  return {
    files: new Map(),
    sessions: new Map(),
    nextId: 1,
    hits: [],
    faults: [],
    baseUrl: 'http://drive.test',
    ...init
  }
}

export const resetHits = (store: FakeDriveStore): void => {
  store.hits.length = 0
}

/** Seed a file directly (fixtures, and "someone changed Drive behind our back"). */
export function putFile(store: FakeDriveStore, f: Omit<FakeFile, 'id'> & { id?: string }): FakeFile {
  const id = f.id ?? `fake${store.nextId++}`
  const file: FakeFile = { ...f, id }
  store.files.set(id, file)
  return file
}

const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex')

const listedMd5 = (f: FakeFile): string | undefined =>
  f.md5Override ?? (f.bytes ? md5(f.bytes) : undefined)

const listedSize = (f: FakeFile): string | undefined =>
  f.sizeOverride ?? (f.bytes ? String(f.bytes.length) : undefined)

/**
 * The q parser. Drive's grammar is bigger than this; what matters is that every
 * shape SingZ sends is understood exactly, and that an unknown one is loud
 * rather than quietly ignored (a silently-dropped clause returns too many files,
 * which is the kind of green test that hides a bug).
 */
interface Query {
  parents: string[]
  name?: string
  mimeType?: string
  trashed: boolean
}

export function parseQuery(q: string): Query {
  const out: Query = { parents: [], trashed: false }
  let rest = q
  // ('a' in parents or 'b' in parents) — or a single bare clause
  for (const m of q.matchAll(/'([^']+)' in parents/g)) out.parents.push(m[1])
  rest = rest.replace(/\(?\s*'[^']+' in parents(\s+or\s+'[^']+' in parents)*\s*\)?/g, ' ')
  // Drive escapes quotes and backslashes inside a q literal ("Don't" → "Don\\'t");
  // a parser that stops at the first quote makes an escaping bug look fine here
  // and 400 in production.
  const name = /name\s*=\s*'((?:\\.|[^'\\])*)'/.exec(rest)
  if (name) {
    out.name = name[1].replace(/\\(.)/g, '$1')
    rest = rest.replace(name[0], ' ')
  }
  const mime = /mimeType\s*=\s*'([^']*)'/.exec(rest)
  if (mime) {
    out.mimeType = mime[1]
    rest = rest.replace(mime[0], ' ')
  }
  const trashed = /trashed\s*=\s*(true|false)/.exec(rest)
  if (trashed) {
    out.trashed = trashed[1] === 'true'
    rest = rest.replace(trashed[0], ' ')
  }
  const leftover = rest.replace(/\band\b|\bor\b|[()\s]/g, '')
  if (leftover) throw new Error(`fake-drive: unsupported q clause ${JSON.stringify(leftover)}`)
  return out
}

/** files(id,name,...) projection — `parents` only arrives when it was asked for,
 *  exactly like Drive, which is what makes a batched listing groupable. */
function project(f: FakeFile, fields: string | null): Record<string, unknown> {
  const inner = /files\(([^)]*)\)/.exec(fields ?? '')
  const want = inner ? new Set(inner[1].split(',').map((s) => s.trim())) : null
  const full: Record<string, unknown> = {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: listedSize(f),
    md5Checksum: listedMd5(f),
    parents: f.parents
  }
  if (!want) {
    delete full.parents // Drive's default projection is id,name,mimeType only
    return full
  }
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(full)) if (want.has(k)) out[k] = full[k]
  return out
}

const json = (status: number, data: unknown): FakeResponse => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data)
})

function faultFor(store: FakeDriveStore, method: string, path: string): number | null {
  const line = `${method} ${path}`
  for (const f of store.faults) {
    if (!f.match.test(line)) continue
    if (f.times === undefined) f.times = 1
    if (f.times <= 0) continue
    f.times -= 1
    return f.status
  }
  return null
}

/**
 * Serve one request. `url` may be absolute or path-only; `body` is the raw
 * request bytes. Every branch mirrors the real API's shape closely enough that
 * the app cannot tell the difference — including the resumable upload's
 * Location round-trip and 404s for missing media.
 */
export function serveRequest(
  store: FakeDriveStore,
  method: string,
  url: string,
  body: Buffer = Buffer.alloc(0),
  headers: Record<string, string> = {}
): FakeResponse {
  const u = new URL(url, 'http://drive.test')
  const path = u.pathname
  store.hits.push(`${method} ${path}${decodeURIComponent(u.search)}`)

  const fault = faultFor(store, method, path)
  if (fault !== null) return json(fault, { error: { code: fault, message: 'injected fault' } })

  if (path === '/oauth2/v4/token' || path === '/token') {
    return json(200, { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600 })
  }

  // headless consent: bounce straight back with a code, so the whole sign-in
  // flow (browser round-trip included) runs with no human
  if (path === '/o/oauth2/v2/auth') {
    const redirect = u.searchParams.get('redirect_uri') ?? ''
    return { status: 302, headers: { Location: `${redirect}?code=fake-code` }, body: '' }
  }

  if (path === '/drive/v3/files' && method === 'GET') {
    let q: Query
    try {
      q = parseQuery(u.searchParams.get('q') ?? '')
    } catch (err) {
      return json(400, { error: { message: String(err) } })
    }
    let list = [...store.files.values()].filter((f) => Boolean(f.trashed) === q.trashed)
    if (q.parents.length) list = list.filter((f) => q.parents.some((p) => f.parents.includes(p)))
    if (q.name !== undefined) list = list.filter((f) => f.name === q.name)
    if (q.mimeType !== undefined) list = list.filter((f) => f.mimeType === q.mimeType)
    list.sort((a, b) => (a.id < b.id ? -1 : 1)) // stable order, so paging is deterministic

    const asked = Number(u.searchParams.get('pageSize') ?? 100) || 100
    const size = Math.min(asked, store.pageSizeCap ?? asked)
    const from = Number(u.searchParams.get('pageToken') ?? 0)
    const page = list.slice(from, from + size)
    const next = from + size < list.length ? String(from + size) : undefined
    return json(200, {
      files: page.map((f) => project(f, u.searchParams.get('fields'))),
      ...(next ? { nextPageToken: next } : {})
    })
  }

  const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(path)
  if (one && method === 'PATCH') {
    const f = store.files.get(one[1])
    if (!f) return json(404, { error: 'not found' })
    const meta = JSON.parse(body.toString() || '{}') as { trashed?: boolean; name?: string }
    if (typeof meta.trashed === 'boolean') f.trashed = meta.trashed
    if (typeof meta.name === 'string') f.name = meta.name
    return json(200, { id: f.id })
  }
  if (one && method === 'DELETE') {
    if (!store.files.has(one[1])) return json(404, { error: 'not found' })
    store.files.delete(one[1])
    return { status: 204, headers: {}, body: '' }
  }
  if (one && method === 'GET' && u.searchParams.get('alt') === 'media') {
    const f = store.files.get(one[1])
    if (!f?.bytes) return json(404, { error: 'not found' })
    return {
      status: 200,
      headers: { 'Content-Type': f.mimeType, 'Content-Length': String(f.bytes.length) },
      body: f.bytes
    }
  }

  if (path === '/drive/v3/files' && method === 'POST') {
    const meta = JSON.parse(body.toString() || '{}') as {
      name: string
      mimeType?: string
      parents?: string[]
    }
    const f = putFile(store, {
      name: meta.name,
      mimeType: meta.mimeType ?? 'application/octet-stream',
      parents: meta.parents ?? []
    })
    return json(200, { id: f.id })
  }

  const uploadNew = path === '/upload/drive/v3/files' && method === 'POST'
  const uploadPatch = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(path)
  if ((uploadNew || (uploadPatch && method === 'PATCH')) && u.searchParams.get('uploadType') === 'resumable') {
    let id: string
    if (uploadNew) {
      const meta = JSON.parse(body.toString() || '{}') as { name: string; parents?: string[] }
      id = putFile(store, {
        name: meta.name,
        mimeType: 'application/octet-stream',
        parents: meta.parents ?? []
      }).id
    } else {
      id = (uploadPatch as RegExpExecArray)[1]
      if (!store.files.has(id)) return json(404, { error: 'not found' })
    }
    const sess = `sess${store.nextId++}`
    store.sessions.set(sess, id)
    return { status: 200, headers: { Location: `${store.baseUrl}/upload-session/${sess}` }, body: '' }
  }

  const sessMatch = /^\/upload-session\/([^/]+)$/.exec(path)
  if (sessMatch && method === 'PUT') {
    const id = store.sessions.get(sessMatch[1])
    if (!id) return json(404, { error: 'no session' })
    const f = store.files.get(id)
    if (!f) return json(404, { error: 'no file' })
    f.bytes = body
    // a fresh upload is the truth again — any override described the old bytes
    delete f.md5Override
    delete f.sizeOverride
    f.mimeType = headers['content-type'] ?? f.mimeType
    return json(200, { id: f.id })
  }

  return json(404, { error: `unhandled ${method} ${path}` })
}

/** Walk the store as a path→file map, for byte-level assertions. */
export function treeOf(store: FakeDriveStore, rootId: string): Map<string, FakeFile> {
  const out = new Map<string, FakeFile>()
  const walk = (parent: string, prefix: string): void => {
    for (const f of store.files.values()) {
      if (f.trashed || !f.parents.includes(parent)) continue
      const path = prefix ? `${prefix}/${f.name}` : f.name
      if (f.mimeType === FOLDER) walk(f.id, path)
      else out.set(path, f)
    }
  }
  walk(rootId, '')
  return out
}
