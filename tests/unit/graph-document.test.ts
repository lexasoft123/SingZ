import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import cases from '../shared/graph-document-cases.json'
import {
  GraphDocumentError,
  MAX_GRAPH_ADAPTER_STATE_BYTES_PER_DOCUMENT,
  MAX_GRAPH_ADAPTER_STATE_BYTES_PER_NODE,
  MAX_GRAPH_DOCUMENT_TEXT_BYTES,
  MAX_GRAPH_NODES,
  MAX_NATIVE_GRAPH_NODES,
  graphStateSha256,
  migrateGraphDocument,
  parseGraphDocument,
  projectGraphDocumentForNative,
  synthesizedNativeGraphNodeCount,
  serializeGraphDocument,
} from '../../src/shared/graph-document'

type MutableJson = Record<string, any>

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function setPath(root: MutableJson, path: Array<string | number>, value: unknown): void {
  let cursor: any = root
  for (let i = 0; i < path.length - 1; i++) cursor = cursor[path[i]]
  cursor[path[path.length - 1]] = value
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof GraphDocumentError ? error.code : String(error)
  }
}

function emptyNode(id: number): MutableJson {
  return {
    id: String(id),
    type: '11111111111111111111111111111111',
    typeVersion: 1,
    execution: 'builtin',
    unavailable: 'silence',
    ports: { inputs: [], outputs: [] },
    parameters: {},
  }
}

function stateNode(id: number, data: string, bytes: number, sha256: string): MutableJson {
  return {
    ...emptyNode(id),
    adapterState: { encoding: 'base64', data, bytes, sha256 },
  }
}

describe('portable graph document format 1', () => {
  it('validates the shared graph and marks unavailable factories as opaque placeholders', () => {
    const parsed = parseGraphDocument(JSON.stringify(cases.base), {
      availableTypeIds: cases.knownTypeIds,
    })
    expect(parsed.kind).toBe('known')
    expect(parsed.nodes.map(node => node.disposition)).toEqual(cases.expect.dispositions)
    expect(parsed.nodes[2].reason).toBe('unavailable-type')
    expect(parsed.nodes[2].raw).toEqual(cases.base.nodes[2])
    expect(Object.isFrozen(parsed.raw)).toBe(true)
    expect(Object.isFrozen(parsed.nodes[2].raw)).toBe(true)
  })

  it('canonicalizes known topology while retaining unknown data and opaque state text', () => {
    const first = parseGraphDocument(JSON.stringify(cases.base), {
      availableTypeIds: cases.knownTypeIds,
    })
    const second = parseGraphDocument(JSON.stringify(cases.canonicalEquivalent), {
      availableTypeIds: cases.knownTypeIds,
    })
    const canonical = serializeGraphDocument(first)
    expect(canonical).toBe(serializeGraphDocument(second))

    const value = JSON.parse(canonical)
    expect(value.nodes.map((node: MutableJson) => node.id)).toEqual(cases.expect.canonicalNodeIds)
    expect(value.nodes[0].ports.outputs.map((port: MutableJson) => port.id)).toEqual(
      cases.expect.canonicalSourceOutputPorts,
    )
    expect(value.connections.map((connection: MutableJson) =>
      `${connection.from.node}:${connection.from.port}>${connection.to.node}:${connection.to.port}`,
    )).toEqual(cases.expect.canonicalConnections)
    expect(value.futureEnvelope).toEqual(cases.base.futureEnvelope)
    expect(value.nodes[1].unknownNodeField).toEqual(cases.base.nodes[2].unknownNodeField)
    expect(value.nodes[1].adapterState.data).toBe(cases.expect.opaqueStateBase64)
    expect(value.nodes[1].adapterState.vendorStateVersion).toBe(91)
  })

  it('keeps migration pure for known documents', () => {
    const source = parseGraphDocument(JSON.stringify(cases.base), {
      availableTypeIds: cases.knownTypeIds,
    })
    const before = JSON.stringify(source.raw)
    const migrated = migrateGraphDocument(source, { availableTypeIds: cases.knownTypeIds })
    expect(migrated).not.toBe(source)
    expect(JSON.stringify(source.raw)).toBe(before)
    expect(serializeGraphDocument(migrated)).toBe(serializeGraphDocument(source))
    expect(Object.fromEntries(migrated.nodes.map(node => [
      String(node.raw.id),
      node.disposition,
    ]))).toEqual(cases.expect.dispositionByNodeId)
  })

  it('retains an unknown __proto__ field as data without prototype mutation', () => {
    const canonical = serializeGraphDocument(parseGraphDocument(JSON.stringify(cases.base)))
    const source = canonical.slice(0, -1) + ',"__proto__":{"retained":"yes"}}'
    const parsed = parseGraphDocument(source)
    expect(Object.prototype.hasOwnProperty.call(parsed.raw, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(parsed.raw)).toBe(Object.prototype)
    const serialized = JSON.parse(serializeGraphDocument(parsed))
    expect(Object.prototype.hasOwnProperty.call(serialized, '__proto__')).toBe(true)
    expect(serialized.__proto__).toEqual({ retained: 'yes' })
  })

  it('projects only bounded compilation fields while opaque data stays outside native', () => {
    const parsed = parseGraphDocument(JSON.stringify(cases.base), {
      availableTypeIds: cases.knownTypeIds,
    })
    const projection = projectGraphDocumentForNative(parsed)
    expect(projection?.format).toBe(1)
    expect(projection?.nodes[2]).toEqual({
      id: '20',
      type: '22222222222222222222222222222222',
      typeVersion: 7,
      execution: 'plugin-bridge-vendor-x',
      unavailable: 'bypass',
      ports: {
        inputs: [{ id: 'in', channels: 2 }],
        outputs: [{ id: 'out', channels: 2 }],
      },
      parameters: { 'vendor.depth': 0.25 },
    })
    expect(projection?.nodes[2]).not.toHaveProperty('adapterState')
    expect(projection?.nodes[2]).not.toHaveProperty('unknownNodeField')
    expect(parsed.nodes[2].raw).toHaveProperty('adapterState')
    expect(parsed.nodes[2].raw).toHaveProperty('unknownNodeField')
  })

  it('carries a future envelope without interpreting or downgrading it', () => {
    const source = parseGraphDocument(JSON.stringify(cases.future), {
      availableTypeIds: cases.knownTypeIds,
    })
    expect(source.kind).toBe('future')
    expect(source.format).toBe(9)
    expect(source.nodes).toEqual([])
    const migrated = migrateGraphDocument(source, { availableTypeIds: [] })
    expect(migrated.kind).toBe('future')
    expect(migrated.format).toBe(9)
    expect(migrated.raw).toEqual(source.raw)
    expect((migrated.raw.opaqueEnvelope as MutableJson).arrayOrder).toEqual([4, 2, 3, 1])
    expect(projectGraphDocumentForNative(source)).toBeUndefined()
  })

  for (const fixture of cases.invalidMutations) {
    it(`rejects ${fixture.name}`, () => {
      const document = copy(cases.base) as MutableJson
      setPath(document, fixture.path, fixture.value)
      expect(errorCode(() => parseGraphDocument(JSON.stringify(document)))).toBe(fixture.code)
    })
  }

  it('uses a platform-neutral SHA-256 implementation over decoded state bytes', () => {
    expect(graphStateSha256(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(graphStateSha256(new Uint8Array([104, 101, 108, 108, 111]))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
    // Inputs past one 64-byte block take the multi-block and padding paths
    // that the short vectors above never touch; node's digest is the oracle.
    for (const length of [55, 56, 63, 64, 65, 119, 120, 200, 1000]) {
      const bytes = new Uint8Array(length)
      for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) & 0xff
      expect(graphStateSha256(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'))
    }
  })

  it('enforces the 256-node cap before compiling a topology', () => {
    const document = {
      format: 1,
      engine: 'singz-dsp',
      nodes: Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, index) => emptyNode(index)),
      connections: [],
    }
    expect(errorCode(() => parseGraphDocument(JSON.stringify(document)))).toBe('too-many-nodes')
  })

  it('rejects portable documents that exceed the smaller native compiler caps before prepare', () => {
    const nodes = Array.from({ length: MAX_NATIVE_GRAPH_NODES + 1 }, (_, index) =>
      emptyNode(index + 1))
    const parsed = parseGraphDocument(JSON.stringify({
      format: 1,
      engine: 'singz-dsp',
      nodes,
      connections: [],
    }))
    expect(errorCode(() => projectGraphDocumentForNative(parsed))).toBe(
      'native-topology-limit',
    )

    const tooManyPorts = emptyNode(1)
    tooManyPorts.ports.inputs = Array.from({ length: 17 }, (_, index) => ({
      id: `in-${index}`,
      channels: 2,
    }))
    const portDocument = parseGraphDocument(JSON.stringify({
      format: 1,
      engine: 'singz-dsp',
      nodes: [tooManyPorts],
      connections: [],
    }))
    expect(errorCode(() => projectGraphDocumentForNative(portDocument))).toBe(
      'native-node-limit',
    )

    const zeroId = parseGraphDocument(JSON.stringify({
      format: 1,
      engine: 'singz-dsp',
      nodes: [emptyNode(0)],
      connections: [],
    }))
    expect(errorCode(() => projectGraphDocumentForNative(zeroId))).toBe('native-node-id')
  })

  it('fits the complete 16-lane default graph while keeping custom projection bounded', () => {
    const nodes = synthesizedNativeGraphNodeCount({
      laneCount: 16,
      trainingLaneCount: 16,
      hasReference: true,
      needsTimePitch: true,
    })
    expect(nodes).toBe(74)
    expect(nodes).toBeLessThanOrEqual(MAX_NATIVE_GRAPH_NODES)
    expect(MAX_NATIVE_GRAPH_NODES).toBe(128)
  })

  it('enforces the one-MiB per-node state cap before base64 allocation', () => {
    const document = {
      format: 1,
      engine: 'singz-dsp',
      nodes: [stateNode(
        1,
        '',
        MAX_GRAPH_ADAPTER_STATE_BYTES_PER_NODE + 1,
        '0'.repeat(64),
      )],
      connections: [],
    }
    expect(errorCode(() => parseGraphDocument(JSON.stringify(document)))).toBe(
      'node-state-too-large',
    )
  })

  it('enforces the eight-MiB aggregate decoded-state cap', () => {
    const bytesPerNode = 950 * 1024
    const bytes = Buffer.alloc(bytesPerNode)
    const data = bytes.toString('base64')
    const sha256 = graphStateSha256(bytes)
    const count = Math.floor(MAX_GRAPH_ADAPTER_STATE_BYTES_PER_DOCUMENT / bytesPerNode) + 1
    const document = {
      format: 1,
      engine: 'singz-dsp',
      nodes: Array.from({ length: count }, (_, index) =>
        stateNode(index, data, bytesPerNode, sha256)),
      connections: [],
    }
    expect(errorCode(() => parseGraphDocument(JSON.stringify(document)))).toBe(
      'document-state-too-large',
    )
  })

  it('bounds encoded JSON before parsing', () => {
    expect(errorCode(() => parseGraphDocument(' '.repeat(MAX_GRAPH_DOCUMENT_TEXT_BYTES + 1)))).toBe(
      'document-too-large',
    )
  })
})
