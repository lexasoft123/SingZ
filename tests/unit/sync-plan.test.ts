import { describe, expect, it } from 'vitest'
import {
  adoptionName,
  isPublished,
  plainName,
  planProject,
  stableJson,
  type LocalEntry,
  type RemoteEntry
} from '../../src/main/sync-plan'

const localDoc: LocalEntry = {
  name: 'project.json', path: '/library/Song/project.json', mime: 'application/json', md5: 'a', size: 2
}
const remoteGraph: RemoteEntry = {
  id: 'graph-1', name: 'graph.json', mimeType: 'application/json', md5Checksum: 'b', size: '2'
}
const remote = { folderId: 'p', stemsId: 's', top: [remoteGraph], stems: [] }

describe('planProject', () => {
  it('trashes an unreferenced graph.json only when the local document was readable', () => {
    // A readable project.json that no longer names graph.json makes Drive's
    // copy stale. An UNREADABLE one (mid-write on a cloud folder, permissions)
    // says nothing about the reference, and the graph must be left alone.
    const local = { dir: 'Song', top: [localDoc], stems: [] }
    expect(planProject({ ...local, docReadable: true }, remote).trash.map((t) => t.entry.name))
      .toEqual(['graph.json'])
    expect(planProject(local, remote).trash.map((t) => t.entry.name)).toEqual(['graph.json'])
    expect(planProject({ ...local, docReadable: false }, remote).trash).toEqual([])
  })
})

describe('adopting a song a phone moved to Drive', () => {
  it('keeps the name when it is free, and never collides — case folded, as APFS and NTFS do', () => {
    expect(adoptionName('Sixteen Tons', ['Song One'])).toBe('Sixteen Tons')
    expect(adoptionName('Sixteen Tons', ['sixteen tons'])).toBe('Sixteen Tons (phone)')
    expect(adoptionName('Sixteen Tons', ['Sixteen Tons', 'Sixteen Tons (phone)'])).toBe('Sixteen Tons (phone 2)')
  })

  it('a Drive name is the phone\'s word, not a safe path segment', () => {
    expect(adoptionName('AC/DC: Back in Black', [])).toBe('AC DC Back in Black')
    expect(adoptionName('..', [])).toBe('Song from phone')
    expect(adoptionName('.hidden', [])).toBe('hidden')
    expect(adoptionName('   ', [])).toBe('Song from phone')
  })

  it('only a published folder is adoptable — adopted and untagged ones are ordinary folders', () => {
    expect(isPublished({ appProperties: { singzState: 'published' } })).toBe(true)
    expect(isPublished({ appProperties: { singzState: 'adopted' } })).toBe(false)
    expect(isPublished({ appProperties: { singzState: 'uploading' } })).toBe(false)
    expect(isPublished({})).toBe(false)
  })

  it('plainName refuses anything that could leave the folder', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'nul\u0000']) expect(plainName(bad)).toBe(false)
    expect(plainName('vocals.flac')).toBe(true)
  })

  it('stableJson sees the same content in any key order, and a real change as a change', () => {
    const a = { 'vocals.flac': { md5: 'x', size: 1, mtimeMs: 5 }, 'bass.flac': { md5: 'y', size: 2, mtimeMs: 6 } }
    const b = { 'bass.flac': { size: 2, md5: 'y', mtimeMs: 6 }, 'vocals.flac': { mtimeMs: 5, md5: 'x', size: 1 } }
    expect(stableJson(a)).toBe(stableJson(b))
    expect(stableJson(a)).not.toBe(stableJson({ ...b, 'bass.flac': { md5: 'y', size: 3, mtimeMs: 6 } }))
    expect(stableJson(null)).toBe('null')
  })
})
