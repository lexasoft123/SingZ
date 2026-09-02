import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import cases from '../shared/graph-document-cases.json'
import {
  readProjectGraph,
  saveProject,
  withProjectDocumentTransaction,
  writeProjectGraph
} from '../../src/main/projects'
import { writeSettings } from '../../src/main/settings'

async function seed(extra: Record<string, unknown> = {}): Promise<{ dir: string; song: string }> {
  const root = await mkdtemp(join(tmpdir(), 'singz-graph-project-'))
  writeSettings({ projectsRoot: root })
  const dir = join(root, 'Song')
  await mkdir(join(dir, 'stems'), { recursive: true })
  const song = join(dir, 'song.mp3')
  await writeFile(song, 'audio')
  await writeFile(join(dir, 'stems', 'vocals.flac'), 'stem')
  await writeFile(
    join(dir, 'project.json'),
    JSON.stringify({
      futureTop: { preserve: ['byte', 'shape'] },
      version: 2,
      name: 'Song',
      songFile: 'song.mp3',
      savedAt: 'before',
      settings: { transpose: 0, tracks: {}, futureSetting: { keep: true } },
      ...extra
    })
  )
  return { dir, song }
}

describe('portable project graph persistence', () => {
  it('writes graph bytes first, binds their exact hash, and reads the verified canonical document', async () => {
    const { dir, song } = await seed()
    const written = await writeProjectGraph(song, JSON.stringify(cases.base))
    expect(written.ok).toBe(true)
    if (!written.ok) return
    const bytes = await readFile(join(dir, 'graph.json'))
    expect(written.graph.hash.md5).toBe(createHash('md5').update(bytes).digest('hex'))
    expect(written.graph.hash.size).toBe(bytes.length)
    await expect(access(join(dir, 'graph.json.part'))).rejects.toThrow()
    await expect(access(join(dir, 'project.json.part'))).rejects.toThrow()
    const read = await readProjectGraph(song)
    expect(read).toEqual({ ok: true, graph: written.graph })
  })

  it('serializes stale hash maintenance behind graph writes and preserves the new reference', async () => {
    const { dir, song } = await seed()
    let enterFirst!: () => void
    let releaseFirst!: () => void
    const entered = new Promise<void>((resolve) => { enterFirst = resolve })
    const release = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = withProjectDocumentTransaction(dir, async (meta, replace) => {
      enterFirst()
      await release
      meta.savedAt = 'first transaction'
      await replace(meta)
    })
    await entered

    // Queue the explicit graph edit first, then model Drive's hash backfill.
    // The second transaction must re-read after the graph edit, rather than
    // writing the document snapshot that existed before it entered the queue.
    const graphWrite = writeProjectGraph(song, JSON.stringify(cases.base))
    let graphSeenByBackfill = false
    const backfill = withProjectDocumentTransaction(dir, async (meta, replace) => {
      graphSeenByBackfill = meta.graphHash !== undefined
      meta.stemHashes = {
        'vocals.flac': { md5: '0123456789abcdef0123456789abcdef', size: 4, mtimeMs: 1 }
      }
      await replace(meta)
    })

    releaseFirst()
    const [, written] = await Promise.all([first, graphWrite, backfill])
    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(graphSeenByBackfill).toBe(true)
    const finalDoc = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(finalDoc.graphHash).toEqual(written.graph.hash)
    expect(finalDoc.stemHashes['vocals.flac'].md5).toBe('0123456789abcdef0123456789abcdef')
  })

  it('never adopts a stray graph and rejects a referenced graph whose bytes changed', async () => {
    const { dir, song } = await seed()
    await writeFile(join(dir, 'graph.json'), JSON.stringify(cases.base))
    expect(await readProjectGraph(song)).toEqual({ ok: true, graph: null })
    const written = await writeProjectGraph(song, JSON.stringify(cases.base))
    expect(written.ok).toBe(true)
    await writeFile(join(dir, 'graph.json'), '{}')
    expect(await readProjectGraph(song)).toMatchObject({ ok: false, code: 'mismatch' })
  })

  it('preserves opaque project/settings fields and future graph references across ordinary saves', async () => {
    const future = JSON.stringify(cases.future)
    const hash = {
      format: 9,
      md5: createHash('md5').update(future).digest('hex'),
      size: Buffer.byteLength(future),
      mtimeMs: 1
    }
    const { dir, song } = await seed({ graphHash: hash })
    await writeFile(join(dir, 'graph.json'), future)
    expect(await readProjectGraph(song)).toMatchObject({ ok: false, code: 'unsupported' })
    await saveProject(song, 'Song', { transpose: 3, tracks: {} })
    const doc = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(doc.graphHash).toEqual(hash)
    expect(doc.futureTop).toEqual({ preserve: ['byte', 'shape'] })
    expect(doc.settings.futureSetting).toEqual({ keep: true })
  })
})
