'use strict'
// Catalog metadata e2e: artist/title split, header-read time, artist ordering,
// letter rail by remote keys, distinct state badges. Needs no audio engine.
// CATALOG_COUNT=500 adds synthetic songs and prints timing/memory numbers.
// CATALOG_SHOTS=<dir> saves screenshots.
const watchdog = require('../shared/watchdog.cjs').arm('box-catalog-metadata')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { _electron } = require('playwright-core')

const root = path.resolve(__dirname, '../..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-box-catalog-'))
const userData = path.join(scratch, 'user-data')
const library = path.join(scratch, 'library')
const template = path.join(scratch, 'template')
for (const dir of [userData, library, template, path.join(scratch, 'models'), path.join(scratch, 'pack')]) fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ projectsRoot: library, language: 'en' }), { mode: 0o600 })
fs.writeFileSync(path.join(userData, 'box-state.json'), JSON.stringify({ version: 1, preferences: { setupComplete: true, safeAreaPercent: 0, language: 'en' }, queue: [] }), { mode: 0o600 })

const COUNT = Number(process.env.CATALOG_COUNT || 0)
const SHOTS = process.env.CATALOG_SHOTS || ''
const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex')
function silentWav(seconds) {
  const rate = 48000
  const frames = Math.round(seconds * rate)
  const bytes = Buffer.alloc(44 + frames * 4)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 4, 40)
  return bytes
}
const check = (condition, message) => {
  console.log(`${condition ? 'ok' : 'FAIL'} ${message}`)
  if (!condition) throw new Error(message)
}

async function buildTemplate(seconds) {
  const { wavToFlac } = await import(pathToFileURL(path.join(root, 'src/main/flac.ts')).href)
  const dir = path.join(template, String(seconds))
  fs.mkdirSync(dir, { recursive: true })
  for (const stem of ['vocals', 'drums', 'bass', 'other']) {
    const wav = path.join(dir, `${stem}.wav`)
    fs.writeFileSync(wav, silentWav(seconds))
    const encoded = await wavToFlac(wav, path.join(dir, `${stem}.flac`))
    if (!encoded.ok) throw new Error(encoded.error)
    fs.unlinkSync(wav)
  }
  return dir
}

const lyrics = Buffer.from(JSON.stringify({ source: 'edited', aligned: true, lines: [{ start: 0, end: 1, text: 'Line', words: [] }] }))
function makeProject(name, savedAt, { seconds = 30, stems = true, withLyrics = true, truncate = false } = {}) {
  const dir = path.join(library, name.replace(/[/:]/g, '_'))
  fs.mkdirSync(path.join(dir, 'stems'), { recursive: true })
  const stemHashes = {}
  if (stems) {
    for (const stem of ['vocals', 'drums', 'bass', 'other']) {
      const target = path.join(dir, 'stems', `${stem}.flac`)
      fs.copyFileSync(path.join(templates[seconds], `${stem}.flac`), target)
      const bytes = fs.readFileSync(target)
      stemHashes[`${stem}.flac`] = { md5: md5(bytes), size: bytes.length, mtimeMs: fs.statSync(target).mtimeMs }
      if (truncate && stem === 'bass') fs.truncateSync(target, 100)
    }
  }
  if (!stems || truncate) fs.writeFileSync(path.join(dir, 'original-not-present.wav'), silentWav(1)) // keeps an unprepared/damaged project listed
  if (withLyrics) fs.writeFileSync(path.join(dir, 'lyrics.json'), lyrics)
  const doc = {
    version: 2, name, songFile: 'original-not-present.wav', savedAt,
    settings: { transpose: 0, tempo: 1, masterVolume: 1, key: { pc: 9, minor: true, detVersion: 2 }, tracks: {} },
    stemHashes
  }
  if (withLyrics) doc.lyricsHash = { md5: md5(lyrics), size: lyrics.length, mtimeMs: fs.statSync(path.join(dir, 'lyrics.json')).mtimeMs }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(doc, null, 2))
}

const templates = {}
let app = null
;(async () => {
  templates[30] = await buildTemplate(30)
  templates[318] = await buildTemplate(318)
  const fixtures = [
    ['Pink Floyd - Wish You Were Here', { seconds: 318 }],
    ['Cat Stevens — Father and Son', {}],
    ['Édith Piaf – La Vie en rose', {}],
    ['ABBA - Waterloo', {}],
    ['Donaukinder', {}],
    ['Pink Floyd - Time', { stems: false }],
    ['Queen - Needs Lyrics', { withLyrics: false }],
    ['Queen - Damaged Stem', { truncate: true }]
  ]
  fixtures.forEach(([name, options], index) => makeProject(name, `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, options))
  const pool = ['Adele', 'Beck', 'Cher', 'Dido', 'Elton John', 'Fleetwood Mac', 'Genesis', 'Hozier', 'INXS', 'Journey', 'Kiss', 'Lorde', 'Muse', 'Nirvana', 'Oasis', 'Prince', 'Radiohead', 'Sting', 'Toto', 'U2', 'Van Halen', 'Weezer', 'Yes', 'ZZ Top']
  for (let i = 0; i < Math.max(0, COUNT - fixtures.length); i++) {
    makeProject(`${pool[i % pool.length]} - Synthetic Song ${String(i).padStart(3, '0')}`, `2025-06-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`.replace(/T00:00:/, `T0${Math.floor(i / 60) % 10}:00:`))
  }
  const expected = Math.max(COUNT, fixtures.length)
  const started = Date.now()
  app = await watchdog.run('launch built Box', 90, () => _electron.launch({
    executablePath: require('electron'),
    args: [path.join(root, 'out/main/index.js'), '--box'],
    env: { ...process.env, SINGZ_SURFACE: 'desktop', SINGZ_USERDATA_DIR: userData, SINGZ_MODELS_DIR: path.join(scratch, 'models'), SINGZ_PACK_DIR: path.join(scratch, 'pack'), SINGZ_NO_SYNC: '1', SINGZ_NO_SYSTEM_ENGINES: '1', SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_LANG: 'en' }
  }))
  const page = await app.firstWindow()
  await page.waitForSelector('[data-app="singz-box"]', { timeout: 60000 })
  await page.waitForFunction(count => document.querySelectorAll('.box-song-row').length === count, expected, { timeout: 120000 })
  const listed = Date.now() - started
  // every ready, inspected row has its time (header read) — no song was opened
  await page.waitForFunction(() => {
    const rows = Array.from(document.querySelectorAll('.box-song-row'))
    return rows.length > 0 && rows.every(row => row.querySelector('.state-badge') !== null || row.querySelector('.box-time').textContent !== '—') &&
      document.querySelectorAll('.box-song-row .box-time').length === rows.length
  }, null, { timeout: 30000, polling: 100 }).catch(async error => {
    console.log(await page.$$eval('.box-song-row', els => els.map(el => el.innerText.replace(/\n/g, ' | '))))
    throw error
  })
  const inspected = Date.now() - started

  const rows = await page.$$eval('.box-song-row', els => els.map(el => ({
    artist: el.querySelector('.box-artist').textContent, title: el.querySelector('.box-song-title').textContent,
    time: el.querySelector('.box-time').textContent, state: el.querySelector('.state-badge')?.getAttribute('data-state') ?? null
  })))
  const named = rows.slice(0, 11)
  console.log(JSON.stringify(named))
  check(rows[0].artist === 'ABBA' && rows[0].title === 'Waterloo', 'sorted Artist first: ABBA leads')
  const byTitle = title => rows.find(row => row.title === title)
  check(byTitle('Wish You Were Here').artist === 'Pink Floyd' && byTitle('Father and Son').artist === 'Cat Stevens', 'artist and title are shown in separate cells')
  check(byTitle('Donaukinder').artist === '—' && rows[rows.length - 1].artist === '—', 'no separator: artist is "—", title is the name, unknown artist sorts last')
  check(rows.findIndex(row => row.artist === 'Édith Piaf') < rows.findIndex(row => row.artist === 'Pink Floyd') && rows.findIndex(row => row.artist === 'Édith Piaf') > rows.findIndex(row => row.artist === 'Cat Stevens'), 'accented artist collates with its base letter')
  check(byTitle('Wish You Were Here').time === '5:18' && byTitle('Waterloo').time === '0:30', 'time comes from the stem header without opening the song')
  check(byTitle('Time').state === 'prepare' && byTitle('Needs Lyrics').state === 'lyrics' && byTitle('Damaged Stem').state === 'repair' && byTitle('Waterloo').state === null, 'distinct states: prepare / lyrics / repair / none')
  check(byTitle('Time').time === '—', 'a song without stems keeps an unknown time')
  const glyphs = await page.$$eval('.state-badge', els => els.map(el => `${el.getAttribute('data-state')}:${el.textContent}`))
  console.log(glyphs.join(' | '))
  check(glyphs.every(text => text.split(':')[1].length > 2), 'badges carry visible text, not only a glyph')
  check(await page.locator('.box-source .pill, .box-source button').count() === 0, 'source row has no duplicate account button')
  check(!(await page.locator('.box-source').textContent()).includes('Prepared in Desktop'), 'source line has no jargon')

  // remote-only letter jump
  await page.locator('.box-song-row').first().focus()
  const rail = await page.$$eval('.box-letter-rail button', els => els.map(el => el.textContent))
  console.log('rail', rail.join(''))
  check(rail[0] === 'A' && rail[rail.length - 1] === '—', 'letter rail lists present letters, unknown last')
  await page.keyboard.press('ArrowRight')
  check(await page.evaluate(() => document.activeElement?.closest('.box-letter-rail') !== null && document.activeElement.dataset.current === 'true'), 'Right enters the rail on the current letter')
  await page.keyboard.press('ArrowDown')
  const letter = await page.evaluate(() => document.activeElement.dataset.letter)
  await page.keyboard.press('Enter')
  const landed = await page.evaluate(() => {
    const row = document.activeElement
    return { row: row?.classList.contains('box-song-row'), artist: row?.querySelector('.box-artist')?.textContent, index: Number(row?.dataset.catalogIndex) }
  })
  check(landed.row && landed.artist[0].normalize('NFD')[0].toUpperCase() === letter, `OK jumps to the first artist under ${letter} (${landed.artist})`)
  const previous = rows[landed.index - 1]
  check(!previous || previous.artist[0].normalize('NFD')[0].toUpperCase() !== letter, 'the jump lands on the first row of that letter')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowLeft')
  check(await page.evaluate(() => document.activeElement?.classList.contains('box-song-row')), 'Left leaves the rail back to a row')
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.locator('.box-song-row').first().focus()
    await page.screenshot({ path: path.join(SHOTS, 'catalog-top.png') })
    await page.locator('.box-song-row', { hasText: 'Needs Lyrics' }).focus()
    await page.screenshot({ path: path.join(SHOTS, 'catalog-states.png') })
    await page.locator('.box-song-row').first().focus()
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown')
    await page.screenshot({ path: path.join(SHOTS, 'catalog-rail.png') })
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter')
    await page.waitForSelector('[data-surface="details"]')
    await page.screenshot({ path: path.join(SHOTS, 'details.png') })
  }

  const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map(m => ({ type: m.type, rssKb: m.memory.workingSetSize })))
  const heap = await page.evaluate(() => performance.memory ? performance.memory.usedJSHeapSize : null)
  const { readAudioDurationSec } = await import(pathToFileURL(path.join(root, 'src/main/audio-header-duration.ts')).href)
  const stems = fs.readdirSync(library).flatMap(name => ['vocals', 'drums', 'bass', 'other'].map(stem => path.join(library, name, 'stems', `${stem}.flac`))).filter(file => fs.existsSync(file))
  const t0 = process.hrtime.bigint()
  await Promise.all(stems.map(file => readAudioDurationSec(file)))
  const headerMs = Number(process.hrtime.bigint() - t0) / 1e6
  console.log('PERF', JSON.stringify({
    songs: rows.length, listedMs: listed, allInspectedMs: inspected, headerReads: stems.length, headerReadMs: Math.round(headerMs * 10) / 10,
    processRssMb: metrics.map(m => `${m.type}:${Math.round(m.rssKb / 1024)}`), rendererJsHeapMb: heap === null ? null : Math.round(heap / 1048576)
  }))
  console.log('BOX CATALOG METADATA CHECKS PASSED')
})().catch(error => {
  console.error('BOX CATALOG METADATA ERROR', error)
  process.exitCode = 1
}).finally(async () => {
  if (app) await app.close().catch(() => undefined)
  watchdog.disarm()
  fs.rmSync(scratch, { recursive: true, force: true })
})
