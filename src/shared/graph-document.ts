/**
 * Portable SingZ DSP graph document contract.
 *
 * This module deliberately has no Node, DOM, React Native, or native-runtime
 * dependencies. `mobile/scripts/sync-graph-document.js` materializes the same
 * source under mobile/src/gen so desktop and phone readers cannot drift.
 *
 * Format 1 is a control-domain document. It does not contain audio buffers,
 * project file paths, device identifiers, or a compiled zdsp graph.
 */

export const GRAPH_DOCUMENT_FORMAT = 1 as const
export const GRAPH_DOCUMENT_ENGINE = 'singz-dsp' as const
export const MAX_GRAPH_NODES = 256
export const MAX_NATIVE_GRAPH_NODES = 128
export const MAX_NATIVE_GRAPH_CONNECTIONS = 256
export const MAX_NATIVE_GRAPH_PORTS_PER_NODE = 16
export const MAX_NATIVE_GRAPH_PARAMETERS_PER_NODE = 64
export const MAX_GRAPH_ADAPTER_STATE_BYTES_PER_NODE = 1024 * 1024
export const MAX_GRAPH_ADAPTER_STATE_BYTES_PER_DOCUMENT = 8 * 1024 * 1024

// Eight MiB of decoded state expands to at most 10.67 MiB of base64. Leave a
// bounded amount for topology and unknown metadata while still rejecting an
// unbounded JSON string before JSON.parse allocates its object graph.
export const MAX_GRAPH_DOCUMENT_TEXT_BYTES = 12 * 1024 * 1024

/** Stable persistence type IDs mirrored by native/playback graph materializer. */
export const GRAPH_NODE_TYPES = Object.freeze({
  projectLaneSource: '73696e677a2d64737000000000000001',
  channelMap: '73696e677a2d64737000000000000002',
  gain: '73696e677a2d64737000000000000003',
  mix: '73696e677a2d64737000000000000004',
  trainingDuck: '73696e677a2d64737000000000000005',
  signalsmithTimePitch: '73696e677a2d64737000000000000006',
  cueSource: '73696e677a2d64737000000000000007',
  peakRms: '73696e677a2d64737000000000000008',
  tap: '73696e677a2d64737000000000000009',
  oscillator: '73696e677a2d6473700000000000000a',
  safetyLimiter: '73696e677a2d6473700000000000000b',
  physicalOutput: '73696e677a2d6473700000000000000c',
  externalAdapter: '73696e677a2d6473700000000000000d',
} as const)

export const NATIVE_GRAPH_AVAILABLE_TYPE_IDS = Object.freeze([
  GRAPH_NODE_TYPES.projectLaneSource,
  GRAPH_NODE_TYPES.channelMap,
  GRAPH_NODE_TYPES.gain,
  GRAPH_NODE_TYPES.mix,
  GRAPH_NODE_TYPES.trainingDuck,
  GRAPH_NODE_TYPES.signalsmithTimePitch,
  GRAPH_NODE_TYPES.cueSource,
  GRAPH_NODE_TYPES.peakRms,
  GRAPH_NODE_TYPES.tap,
  GRAPH_NODE_TYPES.oscillator,
  GRAPH_NODE_TYPES.safetyLimiter,
  GRAPH_NODE_TYPES.physicalOutput,
] as const)

/** Exact node count of the in-memory legacy/default document. Product
 * eligibility uses the same arithmetic as native synthesis so a legal lane
 * count cannot become a surprise graph-cap failure after output handoff. */
export function synthesizedNativeGraphNodeCount(input: {
  laneCount: number
  trainingLaneCount: number
  hasReference: boolean
  needsTimePitch: boolean
}): number {
  const { laneCount, trainingLaneCount, hasReference, needsTimePitch } = input
  if (!Number.isSafeInteger(laneCount) || laneCount < 0 ||
      !Number.isSafeInteger(trainingLaneCount) || trainingLaneCount < 0 ||
      trainingLaneCount > laneCount) return Number.POSITIVE_INFINITY
  // source + map + gain per lane, scheduled gain per selected training lane,
  // song mix/master + limiter/device, optional Signalsmith, and the five-node
  // cue/map/gain/output-mix/output-gain reference branch.
  return laneCount * 3 + trainingLaneCount + 4 +
    (needsTimePitch ? 1 : 0) + (hasReference ? 5 : 0)
}

const MAX_U64 = 18_446_744_073_709_551_615n
const NODE_ID = /^(?:0|[1-9][0-9]*)$/
const TYPE_ID = /^[0-9a-f]{32}$/
const SHA256 = /^[0-9a-f]{64}$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const STABLE_NAME = /^[^\u0000-\u001f\u007f]{1,128}$/

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export interface JsonObject {
  [key: string]: JsonValue
}

export type GraphUnavailablePolicy = 'bypass' | 'silence'
export type GraphDocumentKind = 'known' | 'future'
export type GraphNodeDisposition = 'available' | 'placeholder'

export interface ParsedGraphNode {
  readonly disposition: GraphNodeDisposition
  readonly reason?: 'unavailable-type'
  /** The complete source node, including every field this reader does not know. */
  readonly raw: Readonly<JsonObject>
}

export interface ParsedGraphDocument {
  readonly kind: GraphDocumentKind
  readonly format: number
  /** Complete source envelope. It is deeply frozen and never migrated in place. */
  readonly raw: Readonly<JsonObject>
  /** Empty for a future envelope whose node schema this reader cannot interpret. */
  readonly nodes: readonly ParsedGraphNode[]
}

export interface ParseGraphDocumentOptions {
  /**
   * Type factories present in this runtime. Omit when only validating the wire
   * contract. When supplied, every other valid node is an opaque placeholder.
   */
  readonly availableTypeIds?: Iterable<string>
}

export interface NativeGraphDocumentProjection {
  readonly format: typeof GRAPH_DOCUMENT_FORMAT
  readonly engine: typeof GRAPH_DOCUMENT_ENGINE
  readonly nodes: readonly {
    readonly id: string
    readonly type: string
    readonly typeVersion: number
    readonly execution: string
    readonly unavailable: GraphUnavailablePolicy
    readonly ports: {
      readonly inputs: readonly { readonly id: string; readonly channels: number }[]
      readonly outputs: readonly { readonly id: string; readonly channels: number }[]
    }
    readonly parameters: Readonly<Record<string, number>>
    readonly binding?: { readonly kind: string; readonly laneId?: string }
  }[]
  readonly connections: readonly {
    readonly from: { readonly node: string; readonly port: string }
    readonly to: { readonly node: string; readonly port: string }
  }[]
}

export class GraphDocumentError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'GraphDocumentError'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new GraphDocumentError(code, message)
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function defineJson(object: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
}

function utf8Bytes(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes++
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else {
        bytes += 3
      }
    } else bytes += 3
    if (bytes > MAX_GRAPH_DOCUMENT_TEXT_BYTES) return bytes
  }
  return bytes
}

function cloneJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T
  if (isObject(value)) {
    const out: JsonObject = {}
    for (const [key, child] of Object.entries(value)) {
      // Defining rather than assigning retains an unknown field literally
      // named "__proto__" without letting it mutate the clone's prototype.
      defineJson(out, key, cloneJson(child))
    }
    return out as T
  }
  return value
}

function deepFreeze<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child)
  } else if (isObject(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return Object.freeze(value)
}

function nodeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !NODE_ID.test(value)) {
    fail('invalid-node-id', `${label} must be a canonical unsigned decimal string`)
  }
  if (BigInt(value) > MAX_U64) fail('invalid-node-id', `${label} exceeds uint64`)
  return value
}

function stableName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !STABLE_NAME.test(value)) {
    fail('invalid-stable-name', `${label} must be a non-empty stable string`)
  }
  return value
}

function validatePortList(value: unknown, label: string): Set<string> {
  if (!Array.isArray(value)) fail('invalid-ports', `${label} must be an array`)
  const ids = new Set<string>()
  for (let i = 0; i < value.length; i++) {
    const port = value[i]
    if (!isObject(port)) fail('invalid-ports', `${label}[${i}] must be an object`)
    const id = stableName(port.id, `${label}[${i}].id`)
    if (ids.has(id)) fail('invalid-ports', `${label} repeats port ${id}`)
    ids.add(id)
    if (!integer(port.channels, 1, 64)) {
      fail('invalid-ports', `${label}[${i}].channels must be an integer from 1 to 64`)
    }
  }
  return ids
}

function validateBinding(value: unknown, label: string): void {
  if (value === undefined) return
  if (!isObject(value)) fail('invalid-binding', `${label} must be an object`)
  const kind = stableName(value.kind, `${label}.kind`)
  if (kind === 'project-lane') stableName(value.laneId, `${label}.laneId`)
  else if (value.laneId !== undefined) stableName(value.laneId, `${label}.laneId`)
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count))
}

/** Small platform-neutral SHA-256 used only for bounded opaque adapter state. */
export function graphStateSha256(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  const high = Math.floor(bitLength / 0x1_0000_0000)
  const low = bitLength >>> 0
  view.setUint32(paddedLength - 8, high, false)
  view.setUint32(paddedLength - 4, low, false)

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19
  const w = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7
    for (let i = 0; i < 64; i++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const t1 = (h + s1 + choice + K[i] + w[i]) >>> 0
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('')
}

function sextet(char: string): number {
  const code = char.charCodeAt(0)
  if (code >= 65 && code <= 90) return code - 65
  if (code >= 97 && code <= 122) return code - 71
  if (code >= 48 && code <= 57) return code + 4
  return char === '+' ? 62 : 63
}

function decodeBase64(value: string, label: string): Uint8Array {
  if (!BASE64.test(value)) fail('invalid-adapter-state', `${label}.data is not canonical base64`)
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const bytes = value.length === 0 ? 0 : (value.length / 4) * 3 - padding
  if (bytes > MAX_GRAPH_ADAPTER_STATE_BYTES_PER_NODE) {
    fail('node-state-too-large', `${label} exceeds the per-node state cap`)
  }
  if (padding === 2 && (sextet(value[value.length - 3]) & 0x0f) !== 0) {
    fail('invalid-adapter-state', `${label}.data has non-zero base64 pad bits`)
  }
  if (padding === 1 && (sextet(value[value.length - 2]) & 0x03) !== 0) {
    fail('invalid-adapter-state', `${label}.data has non-zero base64 pad bits`)
  }
  const out = new Uint8Array(bytes)
  let at = 0
  for (let i = 0; i < value.length; i += 4) {
    const a = sextet(value[i])
    const b = sextet(value[i + 1])
    const c = value[i + 2] === '=' ? 0 : sextet(value[i + 2])
    const d = value[i + 3] === '=' ? 0 : sextet(value[i + 3])
    if (at < bytes) out[at++] = (a << 2) | (b >>> 4)
    if (at < bytes) out[at++] = ((b & 0x0f) << 4) | (c >>> 2)
    if (at < bytes) out[at++] = ((c & 0x03) << 6) | d
  }
  return out
}

function validateState(value: unknown, label: string): number {
  if (value === undefined) return 0
  if (!isObject(value)) fail('invalid-adapter-state', `${label} must be an object`)
  if (value.encoding !== 'base64') {
    fail('invalid-adapter-state', `${label}.encoding must be base64`)
  }
  if (!integer(value.bytes, 0, MAX_GRAPH_ADAPTER_STATE_BYTES_PER_NODE)) {
    const code = typeof value.bytes === 'number' && value.bytes > MAX_GRAPH_ADAPTER_STATE_BYTES_PER_NODE
      ? 'node-state-too-large'
      : 'invalid-adapter-state'
    fail(code, `${label}.bytes is invalid`)
  }
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    fail('invalid-adapter-state', `${label}.sha256 must be lowercase SHA-256`)
  }
  if (typeof value.data !== 'string') {
    fail('invalid-adapter-state', `${label}.data must be a base64 string`)
  }
  const bytes = decodeBase64(value.data, label)
  if (bytes.length !== value.bytes) {
    fail('invalid-adapter-state', `${label}.bytes does not match decoded data`)
  }
  if (graphStateSha256(bytes) !== value.sha256) {
    fail('invalid-adapter-state', `${label}.sha256 does not match decoded data`)
  }
  return bytes.length
}

interface ValidatedNode {
  id: string
  type: string
  inputs: Set<string>
  outputs: Set<string>
  raw: JsonObject
}

function validateNode(value: unknown, index: number): ValidatedNode {
  const label = `nodes[${index}]`
  if (!isObject(value)) fail('invalid-node', `${label} must be an object`)
  const id = nodeId(value.id, `${label}.id`)
  if (typeof value.type !== 'string' || !TYPE_ID.test(value.type)) {
    fail('invalid-type-id', `${label}.type must be a lowercase 128-bit hex id`)
  }
  if (!integer(value.typeVersion, 1, 0xffff_ffff)) {
    fail('invalid-type-version', `${label}.typeVersion must be a positive uint32`)
  }
  stableName(value.execution, `${label}.execution`)
  if (value.unavailable !== 'bypass' && value.unavailable !== 'silence') {
    fail('invalid-unavailable-policy', `${label}.unavailable must be bypass or silence`)
  }
  if (!isObject(value.ports)) fail('invalid-ports', `${label}.ports must be an object`)
  const inputs = validatePortList(value.ports.inputs, `${label}.ports.inputs`)
  const outputs = validatePortList(value.ports.outputs, `${label}.ports.outputs`)
  if (!isObject(value.parameters)) fail('invalid-parameter', `${label}.parameters must be an object`)
  for (const [parameter, normalized] of Object.entries(value.parameters)) {
    stableName(parameter, `${label}.parameters key`)
    if (typeof normalized !== 'number' || !Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
      fail('invalid-parameter', `${label}.parameters.${parameter} must be finite and normalized`)
    }
  }
  validateBinding(value.binding, `${label}.binding`)
  return { id, type: value.type, inputs, outputs, raw: value }
}

function validateConnection(
  value: unknown,
  index: number,
  nodes: ReadonlyMap<string, ValidatedNode>,
): string {
  const label = `connections[${index}]`
  if (!isObject(value) || !isObject(value.from) || !isObject(value.to)) {
    fail('invalid-connection', `${label} must contain from/to endpoints`)
  }
  const fromNode = nodeId(value.from.node, `${label}.from.node`)
  const toNode = nodeId(value.to.node, `${label}.to.node`)
  const fromPort = stableName(value.from.port, `${label}.from.port`)
  const toPort = stableName(value.to.port, `${label}.to.port`)
  if (!nodes.get(fromNode)?.outputs.has(fromPort)) {
    fail('invalid-connection', `${label} references a missing output port`)
  }
  if (!nodes.get(toNode)?.inputs.has(toPort)) {
    fail('invalid-connection', `${label} references a missing input port`)
  }
  return `${fromNode}\u0000${fromPort}\u0000${toNode}\u0000${toPort}`
}

function availableTypes(options: ParseGraphDocumentOptions): Set<string> | undefined {
  if (!options.availableTypeIds) return undefined
  const out = new Set<string>()
  for (const type of options.availableTypeIds) {
    if (!TYPE_ID.test(type)) fail('invalid-available-type', `invalid available type id ${type}`)
    out.add(type)
  }
  return out
}

/** Parse, bound, and validate a portable graph without mutating its source. */
export function parseGraphDocument(
  source: string,
  options: ParseGraphDocumentOptions = {},
): ParsedGraphDocument {
  if (utf8Bytes(source) > MAX_GRAPH_DOCUMENT_TEXT_BYTES) {
    fail('document-too-large', 'graph document exceeds the encoded text cap')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(source)
  } catch {
    fail('invalid-json', 'graph document is not valid JSON')
  }
  if (!isObject(decoded) || !integer(decoded.format, 1, 0xffff_ffff)) {
    fail('invalid-envelope', 'graph document needs a positive integer format')
  }
  const raw = cloneJson(decoded)
  if (decoded.format > GRAPH_DOCUMENT_FORMAT) {
    return deepFreeze({
      kind: 'future',
      format: decoded.format,
      raw,
      nodes: [],
    } as unknown as JsonValue) as unknown as ParsedGraphDocument
  }
  if (decoded.format !== GRAPH_DOCUMENT_FORMAT || decoded.engine !== GRAPH_DOCUMENT_ENGINE) {
    fail('invalid-envelope', `unsupported graph envelope ${String(decoded.format)}`)
  }
  if (!Array.isArray(decoded.nodes) || !Array.isArray(decoded.connections)) {
    fail('invalid-envelope', 'format 1 requires nodes and connections arrays')
  }
  if (decoded.nodes.length > MAX_GRAPH_NODES) {
    fail('too-many-nodes', `graph exceeds the ${MAX_GRAPH_NODES}-node cap`)
  }
  const validated = new Map<string, ValidatedNode>()
  let stateBytes = 0
  for (let i = 0; i < decoded.nodes.length; i++) {
    const node = validateNode(decoded.nodes[i], i)
    if (validated.has(node.id)) fail('duplicate-node-id', `duplicate node id ${node.id}`)
    validated.set(node.id, node)
    stateBytes += validateState(node.raw.adapterState, `nodes[${i}].adapterState`)
    if (stateBytes > MAX_GRAPH_ADAPTER_STATE_BYTES_PER_DOCUMENT) {
      fail('document-state-too-large', 'graph exceeds the aggregate adapter-state cap')
    }
  }
  const connections = new Set<string>()
  for (let i = 0; i < decoded.connections.length; i++) {
    const key = validateConnection(decoded.connections[i], i, validated)
    if (connections.has(key)) fail('duplicate-connection', `duplicate connection at index ${i}`)
    connections.add(key)
  }
  const factories = availableTypes(options)
  const rawNodes = raw.nodes as JsonValue[]
  const nodes: ParsedGraphNode[] = [...validated.values()].map((node, index) => {
    const available = factories === undefined || factories.has(node.type)
    return {
      disposition: available ? 'available' : 'placeholder',
      ...(available ? {} : { reason: 'unavailable-type' as const }),
      raw: rawNodes[index] as JsonObject,
    }
  })
  return deepFreeze({
    kind: 'known',
    format: GRAPH_DOCUMENT_FORMAT,
    raw,
    nodes,
  } as unknown as JsonValue) as unknown as ParsedGraphDocument
}

function compareNodeId(left: string, right: string): number {
  const a = BigInt(left)
  const b = BigInt(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((child) => canonicalValue(child))
  if (!isObject(value)) return value
  const out: JsonObject = {}
  for (const key of Object.keys(value).sort()) defineJson(out, key, canonicalValue(value[key]))
  return out
}

function canonicalNode(value: JsonValue): JsonValue {
  const out = canonicalValue(value)
  if (!isObject(out) || !isObject(out.ports)) return out
  for (const direction of ['inputs', 'outputs'] as const) {
    const ports = out.ports[direction]
    if (Array.isArray(ports)) {
      out.ports[direction] = [...ports].sort((left, right) => {
        const a = isObject(left) && typeof left.id === 'string' ? left.id : ''
        const b = isObject(right) && typeof right.id === 'string' ? right.id : ''
        return compareText(a, b)
      })
    }
  }
  return out
}

function connectionKey(value: JsonValue): [string, string, string, string] {
  if (!isObject(value) || !isObject(value.from) || !isObject(value.to)) return ['', '', '', '']
  return [
    String(value.from.node ?? ''),
    String(value.from.port ?? ''),
    String(value.to.node ?? ''),
    String(value.to.port ?? ''),
  ]
}

function compareConnection(left: JsonValue, right: JsonValue): number {
  const a = connectionKey(left)
  const b = connectionKey(right)
  const source = compareNodeId(a[0], b[0])
  if (source !== 0) return source
  const sourcePort = compareText(a[1], b[1])
  if (sourcePort !== 0) return sourcePort
  const destination = compareNodeId(a[2], b[2])
  return destination !== 0 ? destination : compareText(a[3], b[3])
}

/** Canonical JSON used for byte-stable hashing. It never appends a newline. */
export function serializeGraphDocument(document: ParsedGraphDocument): string {
  const root = canonicalValue(cloneJson(document.raw as JsonObject)) as JsonObject
  if (document.kind === 'known') {
    const nodes = root.nodes as JsonValue[]
    root.nodes = nodes
      .map((node) => canonicalNode(node))
      .sort((left, right) => compareNodeId(String((left as JsonObject).id), String((right as JsonObject).id)))
    const connections = root.connections as JsonValue[]
    root.connections = connections
      .map((connection) => canonicalValue(connection))
      .sort(compareConnection)
  }
  return JSON.stringify(root)
}

/**
 * Format-1 currently has no historical transforms. This explicit pure API is
 * the migration seam: it returns a new frozen graph, never mutates the source,
 * and carries a future envelope unchanged instead of attempting a downgrade.
 */
export function migrateGraphDocument(
  document: ParsedGraphDocument,
  options: ParseGraphDocumentOptions = {},
): ParsedGraphDocument {
  return parseGraphDocument(serializeGraphDocument(document), options)
}

/**
 * Produce the strict, bounded compilation projection consumed by native
 * bridges. Unknown fields and opaque adapter state intentionally remain in
 * `document.raw`; dropping them from this DTO prevents an older native target
 * from accidentally interpreting data it must only round-trip. Future
 * envelopes return undefined and therefore stay on the non-native path.
 */
export function projectGraphDocumentForNative(
  document: ParsedGraphDocument,
): NativeGraphDocumentProjection | undefined {
  if (document.kind !== 'known') return undefined
  const root = document.raw as JsonObject
  const nodes = root.nodes as JsonValue[]
  const connections = root.connections as JsonValue[]
  if (nodes.length === 0 || nodes.length > MAX_NATIVE_GRAPH_NODES ||
      connections.length > MAX_NATIVE_GRAPH_CONNECTIONS) {
    fail('native-topology-limit', 'graph exceeds the native topology cap')
  }
  for (const raw of nodes) {
    const value = raw as JsonObject
    const ports = value.ports as JsonObject
    if (value.id === '0') {
      fail('native-node-id', 'native graph node IDs must be non-zero')
    }
    if ((ports.inputs as JsonValue[]).length > MAX_NATIVE_GRAPH_PORTS_PER_NODE ||
        (ports.outputs as JsonValue[]).length > MAX_NATIVE_GRAPH_PORTS_PER_NODE ||
        Object.keys(value.parameters as JsonObject).length >
          MAX_NATIVE_GRAPH_PARAMETERS_PER_NODE) {
      fail('native-node-limit', `graph node ${String(value.id)} exceeds a native processor cap`)
    }
  }
  return {
    format: GRAPH_DOCUMENT_FORMAT,
    engine: GRAPH_DOCUMENT_ENGINE,
    nodes: nodes.map((raw) => {
      const value = raw as JsonObject
      const ports = value.ports as JsonObject
      const parameters = value.parameters as JsonObject
      const sourceBinding = value.binding as JsonObject | undefined
      return {
        id: value.id as string,
        type: value.type as string,
        typeVersion: value.typeVersion as number,
        execution: value.execution as string,
        unavailable: value.unavailable as GraphUnavailablePolicy,
        ports: {
          inputs: (ports.inputs as JsonValue[]).map((portValue) => {
            const port = portValue as JsonObject
            return { id: port.id as string, channels: port.channels as number }
          }),
          outputs: (ports.outputs as JsonValue[]).map((portValue) => {
            const port = portValue as JsonObject
            return { id: port.id as string, channels: port.channels as number }
          }),
        },
        parameters: Object.fromEntries(
          Object.entries(parameters).map(([id, normalized]) => [id, normalized as number]),
        ),
        ...(sourceBinding
          ? {
              binding: {
                kind: sourceBinding.kind as string,
                ...(typeof sourceBinding.laneId === 'string'
                  ? { laneId: sourceBinding.laneId }
                  : {}),
              },
            }
          : {}),
      }
    }),
    connections: connections.map((raw) => {
      const value = raw as JsonObject
      const from = value.from as JsonObject
      const to = value.to as JsonObject
      return {
        from: { node: from.node as string, port: from.port as string },
        to: { node: to.node as string, port: to.port as string },
      }
    }),
  }
}
