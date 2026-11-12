'use strict'
const watchdog = require('../shared/watchdog.cjs').arm('box-smoke')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { _electron } = require('playwright-core')

const root = path.resolve(__dirname, '../..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-box-smoke-'))
const userData = path.join(scratch, 'user-data')
const library = path.join(scratch, 'library')
const models = path.join(scratch, 'models')
const pack = path.join(scratch, 'pack')
for (const dir of [userData, library, models, pack]) fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ projectsRoot: library, language: 'en' }, null, 2), { mode: 0o600 })
fs.writeFileSync(path.join(userData, 'box-state.json'), JSON.stringify({ version: 1, preferences: { setupComplete: true, safeAreaPercent: 0, language: 'en' }, queue: [] }), { mode: 0o600 })

function silentWav(seconds = 30) {
  const rate = 48000
  const frames = seconds * rate
  const bytes = Buffer.alloc(44 + frames * 4)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(2, 22)
  bytes.writeUInt32LE(rate, 24)
  bytes.writeUInt32LE(rate * 4, 28)
  bytes.writeUInt16LE(4, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(frames * 4, 40)
  return bytes
}

const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex')
const lyricLines = [
  { start: 0.25, end: 2.25, text: 'Silent fixture line one', words: [{ w: 'Silent', s: 0.25, e: 0.75 }, { w: 'fixture', s: 0.8, e: 1.35 }, { w: 'line', s: 1.4, e: 1.8 }, { w: 'one', s: 1.85, e: 2.25 }] },
  { start: 2.5, end: 4.75, text: 'Silent fixture line two', words: [{ w: 'Silent', s: 2.5, e: 3 }, { w: 'fixture', s: 3.05, e: 3.6 }, { w: 'line', s: 3.65, e: 4.1 }, { w: 'two', s: 4.15, e: 4.75 }] }
]

async function makeProject(name, savedAt, pc) {
  const dir = path.join(library, name)
  const stems = path.join(dir, 'stems')
  fs.mkdirSync(stems, { recursive: true })
  const { wavToFlac } = await import(pathToFileURL(path.join(root, 'src/main/flac.ts')).href)
  const stemHashes = {}
  for (const stem of ['vocals', 'drums', 'bass', 'other']) {
    const wav = path.join(stems, `${stem}.wav`)
    const flac = path.join(stems, `${stem}.flac`)
    fs.writeFileSync(wav, silentWav())
    const encoded = await wavToFlac(wav, flac)
    if (!encoded.ok) throw new Error(encoded.error)
    fs.unlinkSync(wav)
    const bytes = fs.readFileSync(flac)
    stemHashes[`${stem}.flac`] = { md5: md5(bytes), size: bytes.length, mtimeMs: fs.statSync(flac).mtimeMs }
  }
  const lyricBytes = Buffer.from(JSON.stringify({ source: 'edited', aligned: true, lines: lyricLines }))
  fs.writeFileSync(path.join(dir, 'lyrics.json'), lyricBytes)
  const doc = {
    version: 2,
    name,
    songFile: 'original-not-present.wav',
    savedAt,
    settings: {
      transpose: 0,
      tempo: 1,
      masterVolume: 1,
      key: { pc, minor: true, detVersion: 2 },
      beat: { beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5], bpm: 120, beatsPerBar: 4, downbeat: 0, source: 'manual', detVersion: 23 },
      tracks: {}
    },
    stemHashes,
    lyricsHash: { md5: md5(lyricBytes), size: lyricBytes.length, mtimeMs: fs.statSync(path.join(dir, 'lyrics.json')).mtimeMs }
  }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(doc, null, 2))
  return dir
}

function check(condition, message) {
  console.log(`${condition ? 'ok' : 'FAIL'} ${message}`)
  if (!condition) throw new Error(message)
}

const env = {
  ...process.env,
  SINGZ_SURFACE: 'desktop',
  SINGZ_USERDATA_DIR: userData,
  SINGZ_MODELS_DIR: models,
  SINGZ_PACK_DIR: pack,
  SINGZ_NO_SYNC: '1',
  SINGZ_NO_SYSTEM_ENGINES: '1',
  SINGZ_MUTE: '1',
  SINGZ_E2E_HIDDEN: '1',
  SINGZ_LANG: 'en'
}
const packaged = process.env.E2E_PACKAGED ? path.resolve(process.env.E2E_PACKAGED) : null
let app = null

;(async () => {
  const projectA = await makeProject('Fixture A', '2026-01-02T00:00:00.000Z', 9)
  const projectB = await makeProject('Fixture B', '2026-01-01T00:00:00.000Z', 2)
  check(!fs.existsSync(path.join(projectA, 'original-not-present.wav')), 'fixture has stems but no original recording')
  app = await watchdog.run('launch built Box', 90, () => _electron.launch(packaged
    ? { executablePath: packaged, args: [], env }
    : { executablePath: require('electron'), args: [path.join(root, 'out/main/index.js'), '--box'], env }))
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForSelector('[data-app="singz-box"]', { timeout: 60000 })
  await page.waitForSelector('[data-project-dir]', { timeout: 30000 })
  const headers = await page.locator('.box-list-heading [role="columnheader"]').allTextContents()
  check(headers.slice(0, 6).join('|') === 'Artist|Song|Key|BPM|Vocal range|Time', 'catalog keeps artist-first compact columns')
  check(await page.locator('.box-song-row').count() === 2, 'real isolated catalog lists both projects')
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.box-song-row .box-time')).every(cell => cell.textContent === '0:30'), null, { timeout: 30000 })
  check(true, 'catalog shows each song time (30 s fixture) from the stem headers before any song is opened')

  await watchdog.run('catalog Settings returns without opening a song', 60, async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.waitForSelector('[data-journey-page="home"]')
    await page.locator('[data-focus="journey-audio"]').focus()
    await page.keyboard.press('ArrowDown')
    const remoteFocus = await page.evaluate(() => {
      const previous = document.querySelector('[data-focus="journey-audio"]')
      const current = document.activeElement
      return {
        moved: current !== previous && current?.matches('.journey-row'),
        immediate: [previous, current].every(element => getComputedStyle(element).transitionDuration.split(',').every(value => parseFloat(value) === 0)),
        transitions: [previous, current].flatMap(element => element.getAnimations()).filter(animation => animation instanceof CSSTransition).length
      }
    })
    check(remoteFocus.moved, 'remote arrow moves Settings focus on keydown')
    check(remoteFocus.immediate && remoteFocus.transitions === 0, 'old and new TV focus settle immediately without desktop colour/glow transitions')
    await page.locator('[data-focus="journey-audio"]').click()
    await page.waitForSelector('[data-settings-back]')
    await page.locator('[data-settings-back]').click()
    await page.waitForSelector('[data-settings-back]', { state: 'hidden' })
    await page.keyboard.press('Escape')
    await page.locator('.box-song-row').first().waitFor()
    check(await page.locator('.box-song-row').count() === 2, 'Settings Back returns to the real catalog')
  })

  await watchdog.run('add both songs to the queue', 60, async () => {
    await page.locator('.box-song-row', { hasText: 'Fixture A' }).click()
    await page.getByRole('button', { name: 'Add to queue' }).click()
    await page.getByRole('button', { name: '← Catalog' }).click()
    await page.locator('.box-song-row', { hasText: 'Fixture B' }).click()
    await page.getByRole('button', { name: 'Add to queue' }).click()
    await page.getByRole('button', { name: '← Catalog' }).click()
  })

  await watchdog.run('preview Sing starts A without its original', 90, async () => {
    await page.locator('.box-song-row', { hasText: 'Fixture A' }).click()
    await page.getByText('The original recording is absent. The prepared stems will be used instead.').waitFor()
    await page.getByRole('button', { name: 'Sing', exact: true }).click()
    await page.waitForSelector('.box-player[data-active-song]', { timeout: 60000 })
    check(await page.locator('.box-player').getAttribute('data-playing') === 'true', 'preview Sing starts the verified song')
    check((await page.locator('.player-lyrics').textContent()).includes('Silent fixture line one'), 'real cached project lyrics render')
  })

  await watchdog.run('play, pause and seek with the real transport', 90, async () => {
    await page.waitForFunction(() => Number(document.querySelector('.box-player').dataset.position) > 0.25, null, { timeout: 30000 })
    check(await page.locator('.box-player').getAttribute('data-playing') === 'true', 'native/shared engine enters playback')
    await page.locator('[data-control="play"]').click()
    await page.waitForFunction(() => document.querySelector('.box-player').dataset.playing === 'false')
    const pausedAt = Number(await page.locator('.box-player').getAttribute('data-position'))
    await page.waitForTimeout(350)
    const parkedAt = Number(await page.locator('.box-player').getAttribute('data-position'))
    check(Math.abs(parkedAt - pausedAt) < 0.15, 'pause parks the transport clock')
    await page.locator('[data-control="forward5"]').click()
    check(Number(await page.locator('.box-player').getAttribute('data-position')) >= 4.5, 'seek moves the real project position')
    await page.locator('[data-control="play"]').click()
    await page.waitForFunction(() => document.querySelector('.box-player').dataset.playing === 'true')
  })

  await watchdog.run('Settings preserves active playback and its generation', 90, async () => {
    const before = await page.evaluate(() => window.singz.desktopPlaybackStatus())
    check(before.state === 'running' && before.transportState === 'playing', 'Settings journey starts with playing, running playback')
    check(typeof before.generation === 'string' && before.generation.length > 0, 'playback status exposes a generation string')
    check(typeof before.audibleProjectFrame === 'string' && before.audibleProjectFrame.length > 0, 'playback status exposes an audible project frame string')
    const audibleBefore = BigInt(before.audibleProjectFrame)

    if (await page.locator('.box-player').getAttribute('data-controls') === 'hidden') {
      await page.keyboard.press('ArrowDown')
    }
    await page.waitForSelector('.box-player[data-controls="visible"]')
    await page.locator('[data-control="settings"]').click()
    await page.waitForSelector('[data-journey-page="home"]')
    await page.locator('[data-focus="journey-audio"]').click()
    await page.waitForSelector('[data-settings-back]')
    const outputs = page.locator('[data-settings-output]')
    await outputs.first().waitFor()
    const outputUids = await outputs.evaluateAll(buttons => buttons.map(button => button.getAttribute('data-settings-output')))
    check(outputUids.length > 0 && outputUids.every(uid => typeof uid === 'string' && uid.length > 0), 'Settings settles on real output inventory with raw UIDs')
    if (process.platform === 'darwin') {
      await page.getByText('Output changes are unavailable on this device.', { exact: true }).waitFor()
      await page.waitForFunction(() => {
        const apply = document.querySelector('[data-settings-apply]')
        return apply && (apply.disabled === true || apply.getAttribute('aria-disabled') === 'true')
      })
      check(await page.locator('[data-settings-apply]').isDisabled(), 'macOS Settings is read-only and disables Apply')
    }

    await page.waitForFunction(() => {
      const refresh = document.querySelector('[data-settings-refresh]')
      return refresh && !refresh.disabled
    })
    const realInputs = page.locator('[data-settings-input][data-remote-focus]')
    if ((await realInputs.count()) > 0) {
      await outputs.first().focus()
      await page.keyboard.press('ArrowRight')
      check(await page.evaluate(() => document.activeElement?.matches('[data-settings-input][data-remote-focus]') === true), 'ArrowRight moves real output focus to a readonly input')
    } else {
      console.log('SKIP readonly input remote check: inventory has no inputs')
    }

    await page.waitForTimeout(350)
    const after = await page.evaluate(() => window.singz.desktopPlaybackStatus())
    check(after.state === 'running' && after.transportState === 'playing', 'Settings leaves playback playing and running')
    check(after.generation === before.generation, 'Settings preserves the playback generation')
    check(typeof after.audibleProjectFrame === 'string' && BigInt(after.audibleProjectFrame) > audibleBefore, 'audible project frames advance while Settings is open')

    await page.locator('[data-settings-back]').click()
    await page.waitForSelector('[data-settings-back]', { state: 'hidden' })
    await page.keyboard.press('Escape')
    await page.waitForSelector('.box-player[data-active-song][data-playing="true"]')
    check(await page.locator('.box-player').getAttribute('data-playing') === 'true', 'Settings Back returns to the playing Player')
  })

  await watchdog.run('queue changes preserve current playback and selection asks', 90, async () => {
    await page.locator('[data-control="queue"]').click()
    await page.waitForSelector('.queue-main')
    check(await page.locator('.queue-row').count() === 2, 'queue contains both explicitly added songs')
    await page.locator('.queue-row', { hasText: 'Fixture B' }).focus()
    await page.getByRole('button', { name: 'Move up', exact: true }).click()
    check((await page.locator('.queue-row').first().textContent()).includes('Fixture B'), 'reorder changes only queue order')
    await page.locator('[data-queue-toggle]').click()
    await page.waitForTimeout(250)
    await page.locator('[data-queue-toggle]').click()
    const currentDir = await page.locator('.queue-current strong').textContent()
    await page.locator('.queue-row', { hasText: 'Fixture A' }).focus()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    check((await page.locator('.queue-current strong').textContent()) === currentDir, 'removing the active queue entry does not change its song')
    await page.locator('.queue-row', { hasText: 'Fixture B' }).click()
    await page.getByRole('button', { name: 'Keep current song' }).waitFor()
    await page.getByRole('button', { name: 'Keep current song' }).click()
    check((await page.locator('.queue-current strong').textContent()) === 'Fixture A', 'cancelling a switch preserves current song')
    await page.locator('.queue-row', { hasText: 'Fixture B' }).click()
    await page.getByRole('button', { name: 'Switch song', exact: true }).click()
    await page.waitForSelector('.box-player[data-active-song]', { timeout: 60000 })
    check(await page.locator('.box-player').getAttribute('data-playing') === 'false', 'confirmed replacement opens paused')
    check(Number(await page.locator('.box-player').getAttribute('data-position')) === 0, 'confirmed replacement starts at zero')
    await page.locator('[data-control="queue"]').click()
    check(await page.locator('.queue-row').count() === 1, 'opening never consumes the selected queue entry')
    await page.locator('[data-queue-return]').click()
  })

  await watchdog.run('mixer entry is opaque and bounded at 4K', 90, async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(3840, 2160))
    await page.locator('[data-control="play"]').click()
    await page.waitForFunction(() => document.querySelector('.box-player').dataset.playing === 'true')
    await page.locator('[data-control="mix"]').click()
    await page.waitForFunction(() => {
      const scrim = document.querySelector('.modal-scrim')
      const card = document.querySelector('.box-mixer-card')
      return scrim && card && getComputedStyle(scrim).opacity === '1' && getComputedStyle(card).opacity === '1'
    })
    const bounds = await page.evaluate(() => {
      const tv = document.querySelector('.box-tv').getBoundingClientRect()
      const card = document.querySelector('.box-mixer-card').getBoundingClientRect()
      return { tv: { left: tv.left, top: tv.top, right: tv.right, bottom: tv.bottom }, card: { left: card.left, top: card.top, right: card.right, bottom: card.bottom } }
    })
    check(bounds.card.left >= bounds.tv.left && bounds.card.top >= bounds.tv.top && bounds.card.right <= bounds.tv.right && bounds.card.bottom <= bounds.tv.bottom, 'mixer card is inside the 4K TV frame')

    const pauseRule = await page.addStyleTag({ content: 'body.modal-open .box-tv * { animation-play-state: paused !important; }' })
    try {
      await page.getByRole('button', { name: 'Back to lyrics' }).click()
      await page.locator('[data-control="mix"]').click()
      await page.waitForTimeout(400)
      const negative = await page.evaluate(() => ({
        scrim: Number(getComputedStyle(document.querySelector('.modal-scrim')).opacity),
        card: Number(getComputedStyle(document.querySelector('.box-mixer-card')).opacity)
      }))
      check(negative.scrim < 1 && negative.card < 1, 'negative control: paused entry animations keep mixer invisible')
    } finally {
      await pauseRule.evaluate(element => element.remove())
    }
    await page.getByRole('button', { name: 'Back to lyrics' }).click()
    await page.locator('[data-control="mix"]').click()
    await page.waitForFunction(() => {
      const scrim = document.querySelector('.modal-scrim')
      const card = document.querySelector('.box-mixer-card')
      return scrim && card && getComputedStyle(scrim).opacity === '1' && getComputedStyle(card).opacity === '1'
    })
    check(await page.locator('.box-player').getAttribute('data-playing') === 'true', 'playback continues through mixer entry transitions')
    await page.getByRole('button', { name: 'Back to lyrics' }).click()
  })

  await watchdog.run('mix mutates and persists the shared engine settings', 90, async () => {
    await page.locator('[data-control="mix"]').click()
    await page.waitForSelector('.box-mixer')
    const vocals = page.locator('[data-mix-level="vocals"]')
    await vocals.focus()
    await page.keyboard.press('ArrowLeft')
    await page.getByRole('button', { name: 'Lead vocal mute' }).click()
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-mix-level="vocals"]')
      return input && Number(input.value) < 0
    })
    await page.waitForTimeout(1200)
    const saved = JSON.parse(fs.readFileSync(path.join(projectB, 'project.json'), 'utf8'))
    check(saved.settings.tracks.vocals.muted === true, 'stem mute persists through the existing project API')
    check(saved.settings.tracks.vocals.volume < 1, 'absolute stem level persists without a stale gain restore')
    await page.getByRole('button', { name: 'Back to lyrics' }).click()
    await page.waitForSelector('.box-mixer', { state: 'hidden' })
    if (await page.locator('.box-player').getAttribute('data-playing') === 'true') await page.locator('[data-control="play"]').click()
    await page.waitForSelector('.box-player[data-playing="false"]')
  })

  await watchdog.run('full wake chord only reveals controls', 90, async () => {
    await page.locator('[data-control="play"]').click()
    await page.waitForSelector('.box-player[data-playing="true"]')
    await page.waitForSelector('.box-player[data-controls="hidden"]', { timeout: 15000 })
    await page.keyboard.down('Enter')
    await page.waitForSelector('.box-player[data-controls="visible"]')
    await page.keyboard.down('Enter')
    await page.keyboard.down('ArrowDown')
    check(await page.locator('.box-player').getAttribute('data-playing') === 'true', 'held wake and repeats do not pause or navigate')
    await page.keyboard.up('ArrowDown')
    await page.keyboard.up('Enter')
    await page.keyboard.press('Enter')
    check(await page.locator('.box-player').getAttribute('data-playing') === 'false', 'a later distinct OK press acts normally')
  })

  await watchdog.run('mouse click reveals controls; brand and song stay visible', 60, async () => {
    await page.locator('[data-control="play"]').click()
    await page.waitForSelector('.box-player[data-playing="true"]')
    await page.waitForSelector('.box-player[data-controls="hidden"]', { timeout: 15000 })
    check(await page.locator('.player-header .box-logo').isVisible() && await page.locator('.player-song strong').isVisible(), 'logo and song name stay visible while controls are hidden')
    check(!await page.locator('.player-header-actions').isVisible(), 'header buttons hide with the controls')
    await page.locator('.player-wake').click()
    await page.waitForSelector('.box-player[data-controls="visible"]')
    check(await page.locator('.box-player').getAttribute('data-playing') === 'true', 'the waking click does not pause or seek')
    await page.locator('[data-control="play"]').click()
    await page.waitForSelector('.box-player[data-playing="false"]')
  })

  await watchdog.run('fixed UHD frame scales uniformly', 60, async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(3840, 2160))
    await page.waitForFunction(() => Math.abs(document.querySelector('.box-tv').getBoundingClientRect().width - 3840) < 1)
    const uhd = await page.locator('.box-tv').boundingBox()
    check(Math.round(uhd.width) === 3840 && Math.round(uhd.height) === 2160, 'TV canvas is exactly 3840×2160 at 4K')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 576))
    await page.waitForFunction(() => Math.abs(document.querySelector('.box-tv').getBoundingClientRect().width - 1024) < 1)
    const preview = await page.evaluate(() => ({
      width: document.querySelector('.box-tv').getBoundingClientRect().width,
      height: document.querySelector('.box-tv').getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight
    }))
    check(Math.round(preview.width) === 1024 && Math.round(preview.height) === 576 && !preview.overflow, 'smaller preview preserves 16:9 without page overflow')
  })

  await watchdog.run('normal close flushes accepted settings before restart', 120, async () => {
    await page.locator('[data-control="mix"]').click()
    await page.getByRole('button', { name: 'Stems', exact: true }).click()
    await page.getByRole('button', { name: 'Drums mute' }).click()
    console.log('close: requesting graceful Electron close')
    await app.close()
    app = null
    console.log('close: Electron close completed')
    const saved = JSON.parse(fs.readFileSync(path.join(projectB, 'project.json'), 'utf8'))
    check(saved.settings.tracks.drums.muted === true, 'immediate normal close persists the final accepted stem mute')

    app = await _electron.launch(packaged
      ? { executablePath: packaged, args: [], env }
      : { executablePath: require('electron'), args: [path.join(root, 'out/main/index.js'), '--box'], env })
    const reopened = await app.firstWindow()
    console.log('close: relaunched first window')
    await reopened.waitForSelector('[data-project-dir]', { timeout: 60000 })
    await reopened.locator('.box-song-row', { hasText: 'Fixture B' }).click()
    await reopened.getByRole('button', { name: 'Sing', exact: true }).click()
    await reopened.waitForSelector('.box-player[data-active-song]', { timeout: 60000 })
    await reopened.locator('[data-control="mix"]').click()
    await reopened.getByRole('button', { name: 'Stems', exact: true }).click()
    check(await reopened.getByRole('button', { name: 'Drums mute' }).getAttribute('aria-pressed') === 'true', 'reopened player restores the close-flushed mix')
  })

  console.log('ALL BOX SMOKE CHECKS PASSED')
})().catch(async error => {
  console.error('BOX SMOKE DRIVER ERROR', error)
  if (app) {
    const failed = await app.firstWindow().catch(() => null)
    if (failed) console.error('BOX SMOKE STATE', await failed.evaluate(() => ({
      hidden: document.hidden,
      player: document.querySelector('.box-player')?.getAttribute('data-playing'),
      position: document.querySelector('.box-player')?.getAttribute('data-position'),
      controls: document.querySelector('.box-player')?.getAttribute('data-controls')
    })).catch(() => null))
  }
  process.exitCode = 1
}).finally(async () => {
  if (app) await app.close().catch(() => undefined)
  watchdog.disarm()
  fs.rmSync(scratch, { recursive: true, force: true })
})
