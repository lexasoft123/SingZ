import cases from '../../tests/shared/graph-document-cases.json';
import mobilePackage from '../package.json';
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
  serializeGraphDocument,
  synthesizedNativeGraphNodeCount,
} from '../src/gen/graph-document';

type MutableJson = Record<string, any>;

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function setPath(root: MutableJson, path: Array<string | number>, value: unknown): void {
  let cursor: any = root;
  for (let i = 0; i < path.length - 1; i++) cursor = cursor[path[i]];
  cursor[path[path.length - 1]] = value;
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof GraphDocumentError ? error.code : String(error);
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
  };
}

function stateNode(id: number, data: string, bytes: number, sha256: string): MutableJson {
  return {
    ...emptyNode(id),
    adapterState: { encoding: 'base64', data, bytes, sha256 },
  };
}

describe('generated mobile graph document contract', () => {
  test('materializes the authoritative source during a clean mobile install', () => {
    expect(mobilePackage.scripts.postinstall).toContain('node scripts/sync-graph-document.js');
  });

  test('shares placeholder, canonicalization, unknown-field, and opaque-state behavior', () => {
    const parsed = parseGraphDocument(JSON.stringify(cases.base), {
      availableTypeIds: cases.knownTypeIds,
    });
    expect(parsed.nodes.map(node => node.disposition)).toEqual(cases.expect.dispositions);
    expect(parsed.nodes[2].reason).toBe('unavailable-type');
    expect(parsed.nodes[2].raw).toEqual(cases.base.nodes[2]);

    const equivalent = parseGraphDocument(JSON.stringify(cases.canonicalEquivalent), {
      availableTypeIds: cases.knownTypeIds,
    });
    const canonical = serializeGraphDocument(parsed);
    expect(canonical).toBe(serializeGraphDocument(equivalent));
    const value = JSON.parse(canonical);
    expect(value.nodes.map((node: MutableJson) => node.id)).toEqual(cases.expect.canonicalNodeIds);
    expect(value.nodes[0].ports.outputs.map((port: MutableJson) => port.id)).toEqual(
      cases.expect.canonicalSourceOutputPorts,
    );
    expect(value.futureEnvelope).toEqual(cases.base.futureEnvelope);
    expect(value.nodes[1].unknownNodeField).toEqual(cases.base.nodes[2].unknownNodeField);
    expect(value.nodes[1].adapterState.data).toBe(cases.expect.opaqueStateBase64);
  });

  test('keeps known and future migrations pure', () => {
    const known = parseGraphDocument(JSON.stringify(cases.base), {
      availableTypeIds: cases.knownTypeIds,
    });
    const before = JSON.stringify(known.raw);
    const migrated = migrateGraphDocument(known, { availableTypeIds: cases.knownTypeIds });
    expect(migrated).not.toBe(known);
    expect(JSON.stringify(known.raw)).toBe(before);
    expect(serializeGraphDocument(migrated)).toBe(serializeGraphDocument(known));

    const future = parseGraphDocument(JSON.stringify(cases.future));
    const futureMigrated = migrateGraphDocument(future);
    expect(future.kind).toBe('future');
    expect(future.nodes).toEqual([]);
    expect(futureMigrated.kind).toBe('future');
    expect(futureMigrated.raw).toEqual(future.raw);
    expect((futureMigrated.raw.opaqueEnvelope as MutableJson).arrayOrder).toEqual([4, 2, 3, 1]);
  });

  test('retains an unknown __proto__ field as inert envelope data', () => {
    const canonical = serializeGraphDocument(parseGraphDocument(JSON.stringify(cases.base)));
    const source = canonical.slice(0, -1) + ',"__proto__":{"retained":"yes"}}';
    const parsed = parseGraphDocument(source);
    expect(Object.prototype.hasOwnProperty.call(parsed.raw, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(parsed.raw)).toBe(Object.prototype);
    const serialized = JSON.parse(serializeGraphDocument(parsed));
    expect(Object.prototype.hasOwnProperty.call(serialized, '__proto__')).toBe(true);
    expect(serialized.__proto__).toEqual({ retained: 'yes' });
  });

  for (const fixture of cases.invalidMutations) {
    test(`matches the shared rejection: ${fixture.name}`, () => {
      const document = copy(cases.base) as MutableJson;
      setPath(document, fixture.path, fixture.value);
      expect(errorCode(() => parseGraphDocument(JSON.stringify(document)))).toBe(fixture.code);
    });
  }

  test('matches SHA-256 and all format resource caps', () => {
    expect(graphStateSha256(new Uint8Array([104, 101, 108, 108, 111]))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );

    const tooMany = {
      format: 1,
      engine: 'singz-dsp',
      nodes: Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, index) => emptyNode(index)),
      connections: [],
    };
    expect(errorCode(() => parseGraphDocument(JSON.stringify(tooMany)))).toBe('too-many-nodes');

    const tooLargeNode = {
      format: 1,
      engine: 'singz-dsp',
      nodes: [stateNode(1, '', MAX_GRAPH_ADAPTER_STATE_BYTES_PER_NODE + 1, '0'.repeat(64))],
      connections: [],
    };
    expect(errorCode(() => parseGraphDocument(JSON.stringify(tooLargeNode)))).toBe(
      'node-state-too-large',
    );

    const bytesPerNode = 950 * 1024;
    const bytes = Buffer.alloc(bytesPerNode);
    const data = bytes.toString('base64');
    const sha256 = graphStateSha256(bytes);
    const count = Math.floor(MAX_GRAPH_ADAPTER_STATE_BYTES_PER_DOCUMENT / bytesPerNode) + 1;
    const tooLargeDocument = {
      format: 1,
      engine: 'singz-dsp',
      nodes: Array.from({ length: count }, (_, index) =>
        stateNode(index, data, bytesPerNode, sha256)),
      connections: [],
    };
    expect(errorCode(() => parseGraphDocument(JSON.stringify(tooLargeDocument)))).toBe(
      'document-state-too-large',
    );
    expect(errorCode(() =>
      parseGraphDocument(' '.repeat(MAX_GRAPH_DOCUMENT_TEXT_BYTES + 1)),
    )).toBe('document-too-large');
  });

  test('admits the complete 16-lane training/reference/time-pitch default', () => {
    expect(synthesizedNativeGraphNodeCount({
      laneCount: 16,
      trainingLaneCount: 16,
      hasReference: true,
      needsTimePitch: true,
    })).toBe(74);
    expect(MAX_NATIVE_GRAPH_NODES).toBe(128);
  });
});
