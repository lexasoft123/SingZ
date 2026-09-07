import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import {
  DesktopProjectGraphLoadError,
  loadDesktopProjectGraph
} from '../../src/renderer/src/audio/desktop-project-graph'
import { GRAPH_NODE_TYPES } from '../../src/shared/graph-document'
import type { ProjectGraphReadResult } from '../../src/shared/types'

const graphText = JSON.stringify({
  format: 1,
  engine: 'singz-dsp',
  opaqueEnvelope: { preserve: ['layout', 7] },
  nodes: [{
    id: '1',
    type: GRAPH_NODE_TYPES.gain,
    typeVersion: 1,
    execution: 'builtin',
    unavailable: 'silence',
    ports: {
      inputs: [{ id: 'in', channels: 2 }],
      outputs: [{ id: 'out', channels: 2 }]
    },
    parameters: { gain: 0.5 },
    opaqueNode: { x: 10 }
  }],
  connections: []
})

const payload: ProjectGraphReadResult = {
  ok: true,
  graph: {
    hash: { format: 1, md5: '0'.repeat(32), size: graphText.length, mtimeMs: 1 },
    text: graphText
  }
}

describe('desktop project graph load integration', () => {
  it('consumes one verified IPC payload and preserves opaque JS data', async () => {
    const read = vi.fn(async () => payload)
    const loaded = await loadDesktopProjectGraph(read, () => true)
    expect(read).toHaveBeenCalledTimes(1)
    expect(loaded.accepted).toBe(true)
    if (!loaded.accepted || !loaded.graphDocument) return
    expect(loaded.graphDocument.kind).toBe('known')
    expect(loaded.graphDocument.raw.opaqueEnvelope).toEqual({ preserve: ['layout', 7] })
    expect(loaded.graphDocument.nodes[0].raw.opaqueNode).toEqual({ x: 10 })
  })

  it('drops a stale song result before adopting either its graph or failure', async () => {
    let current = true
    let finish!: (value: ProjectGraphReadResult) => void
    const pending = new Promise<ProjectGraphReadResult>((resolve) => { finish = resolve })
    const loading = loadDesktopProjectGraph(() => pending, () => current)
    current = false
    finish({ ok: false, code: 'mismatch', error: 'old song changed' })
    await expect(loading).resolves.toEqual({ accepted: false })
  })

  it.each(['missing', 'mismatch', 'unsupported'] as const)(
    'fails closed for a referenced %s graph',
    async (code) => {
      await expect(loadDesktopProjectGraph(
        async () => ({ ok: false, code, error: `${code} graph` }),
        () => true
      )).rejects.toMatchObject<Partial<DesktopProjectGraphLoadError>>({ code })
    }
  )

  it('wires the accepted graph through App, engine state, and every native rebuild', () => {
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
    const engine = readFileSync('src/renderer/src/audio/engine.ts', 'utf8')
    const facade = readFileSync('src/renderer/src/audio/desktop-native-playback.ts', 'utf8')
    const loadPath = app.slice(app.indexOf('const loadPath:'), app.indexOf('const loadFile ='))
    expect(loadPath).toContain("import('./audio/desktop-project-graph')")
    expect(loadPath.match(/readProjectGraph\(reg\.path\)/g)).toHaveLength(1)
    expect(loadPath.indexOf("import('./audio/desktop-project-graph')")).toBeLessThan(
      loadPath.indexOf('readProjectGraph(reg.path)')
    )
    expect(loadPath).toContain(
      'if (seq !== loadSeq.current || !songLoadRequests.current.isAccepted(request))'
    )
    expect(loadPath).toContain('seq === loadSeq.current && songLoadRequests.current.isAccepted(request)')
    expect(loadPath.match(/\{ graphDocument \}/g)?.length).toBeGreaterThanOrEqual(2)
    expect(engine).toContain('graphDocument: this.graphDocument')
    expect(facade).toContain('projectGraphDocumentForNative(request.graphDocument)')
  })
})
