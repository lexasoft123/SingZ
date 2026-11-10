'use strict'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http')
function wav(seconds = 12, frequency = 220, rightFrequency = frequency, musical = false) {
  const rate = 48000, count = Math.round(seconds * rate), bytes = Buffer.alloc(44 + count * 4)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28); bytes.writeUInt16LE(4, 32)
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(count * 4, 40)
  let noise = 17
  for (let i = 0; i < count; i++) {
    const t = i / rate, envelope = Math.min(1, t / 0.03, (seconds - t) / 0.03)
    noise = (Math.imul(noise, 1664525) + 1013904223) | 0
    for (let channel = 0; channel < 2; channel++) {
      const f = channel ? rightFrequency : frequency
      let sample = Math.sin(2 * Math.PI * f * t) * 0.12
      if (musical) sample += Math.sin(2 * Math.PI * (f * [1, 1.125, 1.25, 1.5][Math.floor(t / 1.5) % 4]) * t) * 0.12 + Math.sin(2 * Math.PI * 110 * t) * 0.05 + (noise / 2147483648) * Math.exp(-((t * 2) % 1) * 30) * 0.12
      bytes.writeInt16LE(Math.round(sample * envelope * 32767), 44 + i * 4 + channel * 2)
    }
  }
  return bytes
}
const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex')
const lyrics = () => Array.from({ length: 6 }, (_, i) => {
  const start = 0.5 + i * 1.7
  return { start, end: start + 1.4, text: `Linux fixture line ${i + 1}`, words: [{ w: 'Linux', s: start, e: start + 0.4 }, { w: 'fixture', s: start + 0.45, e: start + 0.9 }, { w: `line ${i + 1}`, s: start + 0.95, e: start + 1.4 }] }
})
async function stemProject(dir, name = 'Linux stems only', seconds = 12) {
  fs.mkdirSync(path.join(dir, 'stems'), { recursive: true })
  const { pathToFileURL } = require('node:url')
  const { wavToFlac } = await import(pathToFileURL(path.resolve(__dirname, '../../../src/main/flac.ts')).href)
  const stemHashes = {}
  for (const [index, stem] of ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'].entries()) {
    const bytes = wav(seconds, 220 + index * 55, 330 + index * 55)
    fs.writeFileSync(path.join(dir, 'stems', stem + '.wav'), bytes)
    const flacPath = path.join(dir, 'stems', stem + '.flac')
    const encoded = await wavToFlac(path.join(dir, 'stems', stem + '.wav'), flacPath)
    if (!encoded.ok) throw new Error(encoded.error)
    fs.unlinkSync(path.join(dir, 'stems', stem + '.wav'))
    const encodedBytes = fs.readFileSync(flacPath)
    stemHashes[stem + '.flac'] = { md5: md5(encodedBytes), size: encodedBytes.length, mtimeMs: fs.statSync(flacPath).mtimeMs }
  }
  const lyricBytes = Buffer.from(JSON.stringify({ source: 'edited', aligned: true, lines: lyrics() }))
  fs.writeFileSync(path.join(dir, 'lyrics.json'), lyricBytes)
  const doc = { version: 2, name, songFile: 'original.wav', savedAt: new Date().toISOString(), settings: { transpose: 0, tracks: {} }, stemHashes, lyricsHash: { md5: md5(lyricBytes), size: lyricBytes.length, mtimeMs: fs.statSync(path.join(dir, 'lyrics.json')).mtimeMs } }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(doc))
  return { dir, doc, entry: path.join(dir, doc.songFile) }
}
async function driveServer(project, scratch, projectRoot) {
  // CI pins Node 24; its native type stripping loads this pure shared fixture.
  const { pathToFileURL } = require('node:url')
  const { newStore, putFile, serveRequest, FOLDER } = await import(pathToFileURL(path.join(projectRoot, 'tests/shared/fake-drive.ts')).href)
  const store = newStore(), state = { approved: false, deviceRequests: 0, refreshRequests: [], writes: [] }
  const root = putFile(store, { name: 'SingZ', mimeType: FOLDER, parents: [] })
  const folder = putFile(store, { name: project.doc.name, mimeType: FOLDER, parents: [root.id] })
  const stems = putFile(store, { name: 'stems', mimeType: FOLDER, parents: [folder.id] })
  for (const name of ['project.json', 'lyrics.json']) putFile(store, { name, mimeType: 'application/json', parents: [folder.id], bytes: fs.readFileSync(path.join(project.dir, name)) })
  for (const name of fs.readdirSync(path.join(project.dir, 'stems'))) putFile(store, { name, mimeType: 'audio/flac', parents: [stems.id], bytes: fs.readFileSync(path.join(project.dir, 'stems', name)) })
  let base
  const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks), u = new URL(req.url, base)
    if (u.pathname === '/device/code') { state.deviceRequests++; return json(res, 200, { device_code: 'private-fixture-device-code', user_code: 'SING-Z123', verification_url: base + '/verify', expires_in: 600, interval: 1 }) }
    if (u.pathname === '/token') {
      const fields = Object.fromEntries(new URLSearchParams(body.toString()))
      if (fields.grant_type === 'refresh_token') {
        state.refreshRequests.push({ clientId: fields.client_id, clientSecret: fields.client_secret })
        if (fields.client_id !== 'linux-e2e-tv' || fields.client_secret !== 'fixture-secret') return json(res, 400, { error: 'invalid_client' })
      } else if (!state.approved) return json(res, 400, { error: 'authorization_pending' })
      return json(res, 200, { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: fields.grant_type === 'refresh_token' ? 3600 : 15, scope: 'https://www.googleapis.com/auth/drive.file' })
    }
    if (req.method !== 'GET') { state.writes.push(req.method + ' ' + u.pathname); return json(res, 403, { error: 'reader must not mutate Drive' }) }
    const response = serveRequest(store, req.method, req.url, body, Object.fromEntries(Object.entries(req.headers).filter(([,v]) => typeof v === 'string')))
    res.writeHead(response.status, response.headers)
    if (u.searchParams.get('alt') === 'media' && Buffer.isBuffer(response.body) && response.body.length > 100000) {
      for (let offset = 0; offset < response.body.length && !res.destroyed; offset += 65536) { res.write(response.body.subarray(offset, offset + 65536)); await new Promise(resolve => setTimeout(resolve, 20)) }
      res.end()
    } else res.end(response.body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`; store.baseUrl = base
  return { base, state, store, approve: () => { state.approved = true }, close: () => new Promise(resolve => server.close(resolve)), config: { clientId: 'unused-desktop', clientSecret: 'unused', tvClientId: 'linux-e2e-tv', tvClientSecret: 'fixture-secret', apiBase: base, authBase: base, uploadBase: base } }
}
module.exports = { wav, lyrics, stemProject, driveServer, md5 }
