'use strict'
// Run by drive_sync_tests::two_desktops_roundtrip. The Rust test owns one
// Python Drive fixture; this Node runner invokes both real sync entry points.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { arm } = require('../shared/watchdog.cjs')
const watchdog = arm('two desktops, one Drive', { totalMinutes: 2, idleMinutes: 1 })
const base = process.env.SINGZ_CROSS_BASE
const url = process.env.SINGZ_CROSS_URL
const root = path.join(base, 'library')
const config = { clientId: 'fixture-client', clientSecret: 'fixture-secret', authBase: url, apiBase: url, uploadBase: url }
process.env.SINGZ_GDRIVE_CONFIG = JSON.stringify(config)
process.env.SINGZ_UNIT_USERDATA = path.join(base, 'electron')
fs.mkdirSync(process.env.SINGZ_UNIT_USERDATA)

// Share only the fixture's OAuth tokens, exactly as a one-time import does.
// Electron settings/ledger and native preferences/ledger stay disjoint.
const session = JSON.parse(fs.readFileSync(path.join(base, 'preferences/gdrive/session.json')))
session.tokens.expiresAt = 0
fs.writeFileSync(path.join(base, 'preferences/gdrive/session.json'), JSON.stringify(session))
fs.writeFileSync(path.join(process.env.SINGZ_UNIT_USERDATA, 'settings.json'), JSON.stringify({ gdrive: session.tokens }))
const Module = require('node:module')
const load = Module._load
Module._load = function (id, ...args) {
  if (id === 'electron') return {
    app: { getPath: () => process.env.SINGZ_UNIT_USERDATA, getVersion: () => 'test', getName: () => 'SingZ', getPreferredSystemLanguages: () => ['en'] },
    shell: {}, ipcMain: {}, BrowserWindow: { getAllWindows: () => [] }, net: { fetch: global.fetch }, dialog: {}
  }
  return load.call(this, id, ...args)
}

async function main() {
  // Bundle the real TypeScript module for Node; only Electron's OS shell is
  // stubbed. No planner, hash maintenance, adoption or HTTP path is mocked.
  const bundle = path.join(base, 'electron-sync.cjs')
  await require('esbuild').build({
    stdin: { contents: "export { gdriveSync } from './src/main/gdrive'; export { saveProject, saveProjectSongVolume } from './src/main/projects'", resolveDir: path.resolve(__dirname, '../..'), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: bundle, logLevel: 'silent',
    plugins: [{ name: 'vite-raw-text', setup(build) {
      build.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw-text' }))
      build.onLoad({ filter: /.*/, namespace: 'raw-text' }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'text' }))
    } }]
  })
  const electron = require(bundle)
  const state = async () => (await fetch(`${url}/state`)).json()
  const bytes = file => Buffer.from(file.contentBase64, 'base64')
  const active = async () => (await state()).files.filter(f => !f.trashed)
  const catalog = async () => bytes((await active()).find(f => f.name === 'catalog.json'))
  const control = async body => {
    const response = await fetch(`${url}/control`, { method: 'POST', body: JSON.stringify(body) })
    assert.equal(response.status, 200)
  }
  const uploads = rows => rows.filter(r => r.method === 'PUT' && r.path.startsWith('/upload-session/'))
  const sync = async (writer, assertRetired = false) => watchdog.run(`${writer} full sync`, 30, async () => {
    const before = (await state()).requests.length
    if (writer === 'electron') {
      const report = await electron.gdriveSync({ root })
      assert.equal(report.ok, true, JSON.stringify(report))
    } else {
      const run = spawnSync(process.env.SINGZ_CROSS_BINARY,
        ['--exact', 'drive_sync_tests::cross_writer_native_step', '--ignored', '--nocapture'],
        { env: { ...process.env, SINGZ_CROSS_ASSERT_RETIRED: assertRetired ? '1' : '' }, encoding: 'utf8', timeout: 30000 })
      assert.equal(run.status, 0, run.stdout + run.stderr)
    }
    return uploads((await state()).requests.slice(before))
  })
  // Include the two optional top-level catalog members in both writer orders.
  const graph = Buffer.from(JSON.stringify(require('../shared/graph-document-cases.json').base))
  const graphDir = path.join(root, 'Project-000')
  fs.writeFileSync(path.join(graphDir, 'graph.json'), graph)
  const graphDoc = JSON.parse(fs.readFileSync(path.join(graphDir, 'project.json')))
  graphDoc.graphHash = { format: 1, md5: require('node:crypto').createHash('md5').update(graph).digest('hex'),
    size: graph.length, mtimeMs: fs.statSync(path.join(graphDir, 'graph.json')).mtimeMs }
  fs.writeFileSync(path.join(graphDir, 'project.json'), JSON.stringify(graphDoc))
  const sourceDir = path.join(root, 'Source')
  fs.mkdirSync(path.join(sourceDir, 'stems'), { recursive: true })
  fs.copyFileSync(path.join(graphDir, 'original.wav'), path.join(sourceDir, 'song.wav'))
  fs.writeFileSync(path.join(sourceDir, 'project.json'), JSON.stringify({ version: 2, name: 'Source',
    songFile: 'song.wav', settings: { custom: [] }, stemHashes: {} }))
  const firstWriter = process.env.SINGZ_CROSS_FIRST
  const secondWriter = firstWriter === 'native' ? 'electron' : 'native'
  await sync(firstWriter)
  let first = await catalog()
  const rows = JSON.parse(first).projects
  assert.ok(rows.find(p => p.dir === 'Project-000').files.some(f => f.name === 'graph.json'))
  assert.ok(rows.find(p => p.dir === 'Source').files.some(f => f.name === 'song.wav'))
  // Two complete alternating rounds are the maximum convergence budget.
  await sync(secondWriter)
  // Native-first cold projects need Electron's first local hash backfill; round two must be byte-stable.
  if (firstWriter === 'electron') assert.deepEqual(await catalog(), first, `${secondWriter} rewrote ${firstWriter} catalog bytes`)
  else first = await catalog()
  assert.equal((await sync(firstWriter)).length, 0, `${firstWriter} uploaded in round two`)
  assert.deepEqual(await catalog(), first, 'catalog changed in round two')
  assert.equal((await sync(secondWriter)).length, 0, `${secondWriter} uploaded in round two`)
  assert.deepEqual(await catalog(), first, 'catalog changed in round two')
  for (const writer of ['electron', 'native', 'electron', 'native']) {
    assert.equal((await sync(writer)).length, 0, `${writer} uploaded after convergence`)
    assert.deepEqual(await catalog(), first, 'catalog changed after convergence')
  }
  const ledger = path.join(base, 'preferences/sync.json')
  const beforeLedger = fs.existsSync(ledger) ? fs.readFileSync(ledger) : null
  assert.deepEqual(await electron.saveProjectSongVolume(path.join(root, 'Project-000/original.wav'), 0.375), { ok: true })
  assert.deepEqual(fs.existsSync(ledger) ? fs.readFileSync(ledger) : null, beforeLedger,
    'Electron save touched native ledger')
  assert.ok((await sync('native')).length > 0, 'clean native ledger hid Electron edit')
  const files = await active()
  const folder = files.find(f => f.name === 'Project-000')
  const doc = JSON.parse(bytes(files.find(f => f.name === 'project.json' && f.parents.includes(folder.id))))
  assert.equal(doc.settings.masterVolume, 0.375)
  await sync('electron')
  assert.equal((await sync('native')).length, 0)

  // Persist through native's actual optimistic document writer, then let
  // Electron's diff discover it without sharing either desktop's ledger.
  const edit = spawnSync(process.env.SINGZ_CROSS_BINARY,
    ['--exact', 'drive_sync_tests::cross_writer_native_step', '--ignored', '--nocapture'],
    { env: { ...process.env, SINGZ_CROSS_NATIVE_EDIT: '1' }, encoding: 'utf8', timeout: 30000 })
  assert.equal(edit.status, 0, edit.stdout + edit.stderr)
  assert.ok((await sync('electron')).length > 0, 'Electron missed native edit')
  const edited = await active()
  assert.equal(JSON.parse(bytes(edited.find(f => f.name === 'project.json' && f.parents.includes(folder.id)))).settings.masterVolume, 0.625)
  await sync('native')
  assert.equal((await sync('electron')).length, 0)

  // Publish exactly the phone protocol's atomic root move state, then let
  // each desktop be the first adopter once. The other must retain its files.
  for (const [index, adopter] of ['native', 'electron'].entries()) {
    const singz = (await active()).find(f => f.name === 'SingZ')
    const name = `Phone-${index}`
    const audio = Buffer.from('phone source bytes')
    const phoneDoc = Buffer.from(JSON.stringify({ version: 1, name, songFile: 'song.mp3', settings: { custom: [] } }))
    await control({ files: [
      { id: `phone-${index}`, name, mimeType: 'application/vnd.google-apps.folder', parents: [singz.id], appProperties: { singzState: 'published', singzPublish: `publish-${index}` } },
      { id: `phone-doc-${index}`, name: 'project.json', parents: [`phone-${index}`], contentBase64: phoneDoc.toString('base64') },
      { id: `phone-audio-${index}`, name: 'song.mp3', parents: [`phone-${index}`], contentBase64: audio.toString('base64') }
    ] })
    await sync(adopter)
    await sync(adopter === 'native' ? 'electron' : 'native')
    const current = await active()
    assert.ok(current.some(f => f.id === `phone-${index}`), 'phone folder was trashed')
    const retainedAudio = current.find(f => f.id === `phone-audio-${index}`)
    assert.deepEqual(retainedAudio.parents, [`phone-${index}`])
    assert.deepEqual(bytes(retainedAudio), audio)
    assert.ok(JSON.parse(await catalog()).projects.some(p => p.dir === name))
  }
  await sync('electron')
  await sync('native')
  const settled = await catalog()
  for (const writer of ['electron', 'native']) {
    assert.equal((await sync(writer)).length, 0, `${writer} rewrote adopted phone project`)
    assert.deepEqual(await catalog(), settled)
  }
  const retainedCustom = path.join(root, 'Project-001/stems/custom-recovery.mp3')
  fs.writeFileSync(retainedCustom, 'native retained recovery custom')
  const emptyPath = path.join(root, 'Project-001/project.json')
  const emptyDoc = JSON.parse(fs.readFileSync(emptyPath))
  emptyDoc.settings = { ...emptyDoc.settings, nativeEmptyTracks: true, nativeOriginalDisabled: true, custom: [] }
  emptyDoc.savedAt = new Date().toISOString()
  emptyDoc.stemHashes = {}
  delete emptyDoc.lyricsHash
  fs.writeFileSync(emptyPath, JSON.stringify(emptyDoc))
  // Let the real native writer capture recovery content, with the realistic
  // empty stemHashes document; the receipt must remain local to this desktop.
  const markEmpty = spawnSync(process.env.SINGZ_CROSS_BINARY,
    ['--exact', 'drive_sync_tests::cross_writer_native_step', '--ignored', '--nocapture'],
    { env: { ...process.env, SINGZ_CROSS_NATIVE_EMPTY: '1' }, encoding: 'utf8', timeout: 30000 })
  assert.equal(markEmpty.status, 0, markEmpty.stdout + markEmpty.stderr)
  const inventoriedEmpty = JSON.parse(fs.readFileSync(emptyPath))
  assert.ok(inventoriedEmpty.nativeRecoveryInventory['stems/vocals.wav'])
  assert.ok(inventoriedEmpty.nativeRecoveryInventory['original.wav'])
  assert.deepEqual(inventoriedEmpty.stemHashes, {})
  fs.writeFileSync(emptyPath, JSON.stringify(inventoriedEmpty).replace('"nativeEmptyTracks":true',
    '"nativeEmptyTracks":true,"numberSpelling":1.0,"large":123456789012345678901234567890'))
  const retainedStem = path.join(root, 'Project-001/stems/vocals.wav')
  const retainedBytes = fs.readFileSync(retainedStem)
  await sync('native')
  const emptyFolder = (await active()).find(f => f.name === 'Project-001')
  const members = async () => (await active()).filter(f => f.parents.includes(emptyFolder.id))
  assert.deepEqual((await members()).map(f => f.name).sort(), ['lyrics.json', 'project.json'])
  const nativeEmptyText = bytes((await members()).find(f => f.name === 'project.json')).toString()
  assert.equal(JSON.parse(nativeEmptyText).nativeRecoveryInventory, undefined)
  fs.utimesSync(retainedStem, new Date(), new Date())
  const emptyUploads = await sync('electron')
  assert.equal(emptyUploads.length, 0, 'Electron rewrote the native empty publication')
  assert.equal(bytes((await members()).find(f => f.name === 'project.json')).toString(), nativeEmptyText)
  assert.deepEqual((await members()).map(f => f.name).sort(), ['lyrics.json', 'project.json'], 'Electron resurrected retained native audio')
  assert.deepEqual(fs.readFileSync(retainedStem), retainedBytes)
  assert.equal(fs.readFileSync(retainedCustom).toString(), 'native retained recovery custom')
  await sync('native')
  for (const writer of ['electron', 'native']) assert.equal((await sync(writer)).length, 0)
  // Regression A: native's empty publication must not swallow an Electron
  // custom-track save, including when native retains recovery media locally.
  const returned = path.join(base, 'returned.mp3')
  fs.writeFileSync(returned, 'new Electron custom track')
  const saved = await electron.saveProject(path.join(root, 'Project-001/original.wav'), 'Project-001',
    { transpose: 0, tracks: {}, custom: [{ id: 'custom-returned', label: 'Returned', color: '#ffffff', file: returned }] })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const savedCustom = JSON.parse(fs.readFileSync(emptyPath))
  assert.equal(savedCustom.settings.nativeEmptyTracks, undefined)
  assert.equal(savedCustom.settings.nativeOriginalDisabled, true, 'Electron reenabled the retired original')
  assert.equal(savedCustom.nativeRecoveryInventory, undefined)
  assert.equal(fs.readFileSync(retainedCustom).toString(), 'native retained recovery custom')
  await sync('electron')
  const returnedMembers = await members()
  const returnedStems = returnedMembers.find(f => f.name === 'stems')
  assert.ok(returnedStems, 'Electron did not restore the stems folder')
  const returnedTrack = (await active()).find(f => f.parents.includes(returnedStems.id) && f.name === 'custom-returned.mp3')
  assert.ok(returnedTrack, 'Electron custom track was lost after native empty publication')
  assert.equal(bytes(returnedTrack).toString(), 'new Electron custom track')
  const beforeClose = await state()
  const journals = path.join(base, 'preferences/gdrive/empty-transactions')
  const journalFiles = fs.readdirSync(journals).map(dir => path.join(journals, dir, 'journal.json'))
  const emptyJournal = journalFiles.find(file => JSON.parse(fs.readFileSync(file)).project === 'Project-001')
  assert.equal(JSON.parse(fs.readFileSync(emptyJournal)).phase, 'committed')
  // A matching document alone cannot close the journal while any audio is missing.
  await control({ files: [{ ...returnedTrack, trashed: true }] })
  const incomplete = await state()
  const refused = spawnSync(process.env.SINGZ_CROSS_BINARY,
    ['--exact', 'drive_sync_tests::cross_writer_native_step', '--ignored', '--nocapture'],
    { env: process.env, encoding: 'utf8', timeout: 30000 })
  assert.equal(refused.status, 101, refused.stdout + refused.stderr)
  assert.match(refused.stderr, /Ordinary audio roster differs from declared generation/)
  assert.equal(JSON.parse(fs.readFileSync(emptyJournal)).phase, 'committed')
  const refusedState = await state()
  assert.deepEqual(refusedState.files, incomplete.files, 'incomplete publication caused remote mutation')
  await control({ files: [returnedTrack] })
  await sync('native', true)
  assert.equal(JSON.parse(fs.readFileSync(emptyJournal)).phase, 'superseded', 'native did not close the empty journal')
  const afterClose = await state()
  assert.deepEqual(afterClose.files.filter(f => f.trashed).map(f => f.id).sort(),
    beforeClose.files.filter(f => f.trashed).map(f => f.id).sort(), 'native trashed a file while closing the empty journal')
  assert.deepEqual(bytes((await active()).find(f => f.id === returnedTrack.id)), bytes(returnedTrack))
  const afterNative = await members()
  assert.ok(!afterNative.some(f => f.name === 'original.wav'), 'native uploaded the retired original')
  assert.equal(JSON.parse(bytes(afterNative.find(f => f.name === 'project.json'))).settings.nativeOriginalDisabled, true)
  for (const writer of ['electron', 'native']) assert.equal((await sync(writer)).length, 0)
  // Both processes really used the imported refresh token without revocation.
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, 'preferences/gdrive/session.json'))).tokens.refresh,
    JSON.parse(fs.readFileSync(path.join(process.env.SINGZ_UNIT_USERDATA, 'settings.json'))).gdrive.refresh)
  assert.ok((await state()).oauth.refreshes >= 2, 'both apps must refresh the imported token independently')
  console.log('C-43: stable bytes, convergence, clean-ledger edit, phone adopters and empty arrangement passed')
}
main().then(() => watchdog.disarm(), error => { console.error(error); process.exitCode = 1; watchdog.disarm() })
