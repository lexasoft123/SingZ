'use strict'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const STEMS = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano']
const TYPES = {
  source: '73696e677a2d64737000000000000001', map: '73696e677a2d64737000000000000002',
  gain: '73696e677a2d64737000000000000003', mix: '73696e677a2d64737000000000000004',
  cue: '73696e677a2d64737000000000000007', limiter: '73696e677a2d6473700000000000000b',
  output: '73696e677a2d6473700000000000000c'
}
const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex')
const sha256 = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
const stamp = file => { const bytes = fs.readFileSync(file); return { md5: md5(bytes), size: bytes.length, mtimeMs: fs.statSync(file).mtimeMs } }

async function silentFlac(seconds = 180) {
  const imported = require('libflacjs/dist/libflac.js')
  const Flac = imported.default || imported
  if (!Flac.isReady()) await new Promise(resolve => Flac.on('ready', resolve))
  const rate = 48000, channels = 2, frames = seconds * rate
  const encoder = Flac.create_libflac_encoder(rate, channels, 16, 5, frames, true)
  assert.notEqual(encoder, 0, 'FLAC encoder is available')
  const chunks = []
  const initialized = Flac.init_encoder_stream(encoder, chunk => chunks.push(Buffer.from(chunk)))
  const zeros = new Int32Array(4096 * channels)
  try {
    assert.equal(initialized, 0, 'FLAC encoder initializes')
    for (let frame = 0; frame < frames; frame += 4096) {
      const count = Math.min(4096, frames - frame)
      const block = count === 4096 ? zeros : new Int32Array(count * channels)
      assert.ok(Flac.FLAC__stream_encoder_process_interleaved(encoder, block, count), `FLAC encode frame ${frame}`)
    }
    assert.ok(Flac.FLAC__stream_encoder_finish(encoder), 'FLAC finish succeeds')
  } finally {
    Flac.FLAC__stream_encoder_delete(encoder)
  }
  const bytes = Buffer.concat(chunks)
  assert.ok(bytes.length > 42 && bytes.length < 1024 * 1024, `silent FLAC stays small: ${bytes.length}`)
  return bytes
}

function graphDocument() {
  const nodes = [], connections = []
  let serial = 0
  const node = (type, execution, inputs, outputs, binding, parameters = {}, extra = {}) => {
    const id = String(++serial)
    nodes.push({ id, type, typeVersion: 1, execution, unavailable: 'silence',
      ports: { inputs: inputs.map(([id, channels]) => ({ id, channels })), outputs: outputs.map(([id, channels]) => ({ id, channels })) },
      parameters, ...(binding ? { binding } : {}), ...extra })
    return id
  }
  const link = (from, fromPort, to, toPort) => connections.push({ from: { node: from, port: fromPort }, to: { node: to, port: toPort } })
  const laneMix = node(TYPES.mix, 'builtin', STEMS.map(id => [`lane:${id}`, 2]), [['out', 2]])
  for (const lane of STEMS) {
    const source = node(TYPES.source, 'native', [], [['out', 2]], { kind: 'project-lane', laneId: lane })
    const map = node(TYPES.map, 'builtin', [['in', 2]], [['out', 2]], { kind: 'project-lane', laneId: lane })
    const gain = node(TYPES.gain, 'builtin', [['in', 2]], [['out', 2]], { kind: 'project-lane', laneId: lane }, { gain: 1 })
    link(source, 'out', map, 'in'); link(map, 'out', gain, 'in'); link(gain, 'out', laneMix, `lane:${lane}`)
  }
  const master = node(TYPES.gain, 'builtin', [['in', 2]], [['out', 2]], { kind: 'song-master' }, { gain: 0 })
  const marker = node(TYPES.gain, 'builtin', [['in', 2]], [['out', 2]], null, { gain: 1 }, { opaqueLayout: { x: 42 } })
  const cue = node(TYPES.cue, 'native', [], [['out', 1]], { kind: 'reference-cues' })
  const cueMap = node(TYPES.map, 'builtin', [['in', 1]], [['out', 2]], { kind: 'reference-map' })
  const cueGain = node(TYPES.gain, 'builtin', [['in', 2]], [['out', 2]], { kind: 'reference-gain' }, { gain: 0 })
  const finalMix = node(TYPES.mix, 'builtin', [['song', 2], ['reference', 2]], [['out', 2]])
  const outputGain = node(TYPES.gain, 'builtin', [['in', 2]], [['out', 2]], { kind: 'output-gain' }, { gain: 0 })
  const limiter = node(TYPES.limiter, 'builtin', [['in', 2]], [['out', 2]], null, { ceiling: 0.891250938 })
  const output = node(TYPES.output, 'native', [['in', 2]], [], { kind: 'project-output' })
  link(laneMix, 'out', master, 'in'); link(master, 'out', marker, 'in'); link(marker, 'out', finalMix, 'song')
  link(cue, 'out', cueMap, 'in'); link(cueMap, 'out', cueGain, 'in'); link(cueGain, 'out', finalMix, 'reference')
  link(finalMix, 'out', outputGain, 'in'); link(outputGain, 'out', limiter, 'in'); link(limiter, 'out', output, 'in')
  assert.equal(nodes.length, 28)
  return { format: 1, engine: 'singz-dsp', nodes, connections }
}

async function createProject(dir) {
  const stemDir = path.join(dir, 'stems')
  fs.mkdirSync(stemDir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); fs.chmodSync(stemDir, 0o700)
  const flac = await silentFlac()
  const stemHashes = {}
  for (const id of STEMS) {
    const file = path.join(stemDir, `${id}.flac`)
    fs.writeFileSync(file, flac, { mode: 0o600 }); stemHashes[`${id}.flac`] = stamp(file)
  }
  const lines = Array.from({ length: 36 }, (_, index) => {
    const start = index * 5, end = start + 5
    return { start, end, text: `Retained fixture line ${index + 1}`,
      words: ['Retained', 'fixture', 'line', String(index + 1)].map((w, word) => ({ w, s: start + word * 1.25, e: start + word * 1.25 + 1 })) }
  })
  fs.writeFileSync(path.join(dir, 'lyrics.json'), JSON.stringify({ source: 'edited', aligned: true, lines }), { mode: 0o600 })
  const graph = graphDocument()
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify(graph), { mode: 0o600 })
  const doc = {
    version: 2, name: 'Retained fixture', songFile: 'original-not-present.wav', savedAt: '2026-01-01T00:00:00.000Z',
    settings: { transpose: 0, tempo: 1, masterVolume: 0, tracks: {} }, stemHashes,
    lyricsHash: stamp(path.join(dir, 'lyrics.json')), graphHash: { format: 1, ...stamp(path.join(dir, 'graph.json')) }
  }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(doc, null, 2), { mode: 0o600 })
  assert.equal(fs.existsSync(path.join(dir, doc.songFile)), false)
  return { dir, name: doc.name, songPath: path.join(dir, doc.songFile), graph, lines, graphSha: sha256(fs.readFileSync(path.join(dir, 'graph.json'))) }
}

function mutateLyrics(dir) {
  const file = path.join(dir, 'lyrics.json'), cached = JSON.parse(fs.readFileSync(file, 'utf8'))
  cached.lines[0].text = 'Changed valid retained lyric'
  cached.lines[0].words[0].w = 'Changed'
  fs.writeFileSync(file, JSON.stringify(cached), { mode: 0o600 })
}

module.exports = { createProject, mutateLyrics }
