import { describe, expect, it } from 'vitest'
import { planProject, type LocalEntry, type RemoteEntry } from '../../src/main/sync-plan'

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
