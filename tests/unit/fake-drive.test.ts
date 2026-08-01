/**
 * The fake Drive is load-bearing for both roots now, so its awkward corners are
 * pinned here. Every case below is one that, if the fake got it wrong, would
 * make a sync test green while the real thing misbehaved — a batched query
 * answered with one folder's children being the sharpest of them.
 */
import { describe, expect, it } from 'vitest'
import {
  FOLDER,
  newStore,
  parseQuery,
  putFile,
  serveRequest,
  treeOf,
  type FakeDriveStore
} from '../shared/fake-drive'

const get = (store: FakeDriveStore, url: string): { status: number; data: Record<string, never> } => {
  const res = serveRequest(store, 'GET', url)
  return { status: res.status, data: JSON.parse(String(res.body)) }
}

const files = (store: FakeDriveStore, url: string): { id: string; name: string; parents?: string[] }[] =>
  (get(store, url).data as unknown as { files: { id: string; name: string; parents?: string[] }[] }).files

function library(): { store: FakeDriveStore; a: string; b: string } {
  const store = newStore()
  const a = putFile(store, { name: 'Song A', mimeType: FOLDER, parents: ['ROOT'] }).id
  const b = putFile(store, { name: 'Song B', mimeType: FOLDER, parents: ['ROOT'] }).id
  putFile(store, { name: 'project.json', mimeType: 'application/json', parents: [a], bytes: Buffer.from('{"a":1}') })
  putFile(store, { name: 'project.json', mimeType: 'application/json', parents: [b], bytes: Buffer.from('{"b":2}') })
  return { store, a, b }
}

describe('the q parser', () => {
  it('reads every clause SingZ sends', () => {
    expect(parseQuery("'X' in parents and trashed=false")).toEqual({ parents: ['X'], trashed: false })
    expect(parseQuery("name='SingZ' and mimeType='" + FOLDER + "' and trashed=false")).toEqual({
      parents: [],
      name: 'SingZ',
      mimeType: FOLDER,
      trashed: false
    })
    expect(parseQuery("('A' in parents or 'B' in parents) and trashed=false").parents).toEqual(['A', 'B'])
  })

  it('refuses a clause it does not understand rather than ignoring it', () => {
    // silently dropping a filter returns MORE files, which reads as a passing
    // test right up until the real Drive returns fewer
    expect(() => parseQuery("modifiedTime > '2026-01-01'")).toThrow(/unsupported/)
  })
})

describe('listing', () => {
  it('answers a batched parents query with every folder asked for', () => {
    const { store, a, b } = library()
    const got = files(store, `/drive/v3/files?q=('${a}' in parents or '${b}' in parents) and trashed=false`)
    expect(got).toHaveLength(2)
  })

  it('returns parents only when the projection asks for them', () => {
    const { store, a } = library()
    expect(files(store, `/drive/v3/files?q='${a}' in parents`)[0].parents).toBeUndefined()
    const withParents = files(
      store,
      `/drive/v3/files?q='${a}' in parents&fields=nextPageToken,files(id,name,parents)`
    )
    expect(withParents[0].parents).toEqual([a])
  })

  it('pages, and the pages join back into the whole list', () => {
    const store = newStore({ pageSizeCap: 2 })
    for (let i = 0; i < 5; i++) {
      putFile(store, { name: `stem${i}.flac`, mimeType: 'audio/flac', parents: ['S'], bytes: Buffer.from(`f${i}`) })
    }
    const seen: string[] = []
    let token = ''
    let pages = 0
    do {
      const data = get(store, `/drive/v3/files?q='S' in parents&pageSize=1000${token ? `&pageToken=${token}` : ''}`)
        .data as unknown as { files: { name: string }[]; nextPageToken?: string }
      seen.push(...data.files.map((f) => f.name))
      token = data.nextPageToken ?? ''
      pages++
    } while (token)
    expect(pages).toBe(3)
    expect(seen).toHaveLength(5)
  })

  it('hides trashed files, and shows them when asked', () => {
    const { store, a } = library()
    const doc = files(store, `/drive/v3/files?q='${a}' in parents`)[0]
    serveRequest(store, 'PATCH', `/drive/v3/files/${doc.id}`, Buffer.from('{"trashed":true}'))
    expect(files(store, `/drive/v3/files?q='${a}' in parents and trashed=false`)).toHaveLength(0)
    expect(files(store, `/drive/v3/files?q='${a}' in parents and trashed=true`)).toHaveLength(1)
  })
})

describe('files', () => {
  it('deletes for real, unlike trashing', () => {
    const { store, a } = library()
    const doc = files(store, `/drive/v3/files?q='${a}' in parents`)[0]
    expect(serveRequest(store, 'DELETE', `/drive/v3/files/${doc.id}`).status).toBe(204)
    expect(store.files.has(doc.id)).toBe(false)
    expect(serveRequest(store, 'DELETE', `/drive/v3/files/${doc.id}`).status).toBe(404)
  })

  it('can report metadata its bytes disagree with, and forgets the lie on upload', () => {
    const store = newStore()
    const f = putFile(store, {
      name: 'vocals.flac',
      mimeType: 'audio/flac',
      parents: ['S'],
      bytes: Buffer.from('real bytes'),
      md5Override: 'a-stale-checksum'
    })
    expect(files(store, `/drive/v3/files?q='S' in parents&fields=files(id,md5Checksum)`)[0]).toMatchObject({
      md5Checksum: 'a-stale-checksum'
    })
    expect(String(serveRequest(store, 'GET', `/drive/v3/files/${f.id}?alt=media`).body)).toBe('real bytes')

    const init = serveRequest(store, 'PATCH', `/upload/drive/v3/files/${f.id}?uploadType=resumable`, Buffer.from('{}'))
    const session = init.headers.Location.split('/').pop()
    serveRequest(store, 'PUT', `/upload-session/${session}`, Buffer.from('new bytes'))
    expect(store.files.get(f.id)?.md5Override).toBeUndefined()
  })

  it('fires an injected fault the stated number of times, then heals', () => {
    const { store, a } = library()
    store.faults.push({ match: /^GET \/drive\/v3\/files$/, status: 500, times: 2 })
    expect(get(store, `/drive/v3/files?q='${a}' in parents`).status).toBe(500)
    expect(get(store, `/drive/v3/files?q='${a}' in parents`).status).toBe(500)
    expect(get(store, `/drive/v3/files?q='${a}' in parents`).status).toBe(200)
  })

  it('walks itself into a path map for byte-level assertions', () => {
    const { store, a } = library()
    const stems = putFile(store, { name: 'stems', mimeType: FOLDER, parents: [a] }).id
    putFile(store, { name: 'vocals.flac', mimeType: 'audio/flac', parents: [stems], bytes: Buffer.from('v') })
    const tree = treeOf(store, 'ROOT')
    expect([...tree.keys()].sort()).toEqual([
      'Song A/project.json',
      'Song A/stems/vocals.flac',
      'Song B/project.json'
    ])
  })
})
