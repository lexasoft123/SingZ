import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoxRoutingState, BoxStorageSnapshot } from '../../src/shared/box-contract'
import type { DesktopAudioHostDevice } from '../../src/shared/types'
import { box as en } from '../../src/shared/i18n/en/box'
import { box as ru } from '../../src/shared/i18n/ru/box'
import { box as zh } from '../../src/shared/i18n/zh-CN/box'
import { boxSettings as enSettings } from '../../src/shared/i18n/en/box-settings'
import { boxSettings as ruSettings } from '../../src/shared/i18n/ru/box-settings'
import { boxSettings as zhSettings } from '../../src/shared/i18n/zh-CN/box-settings'
import { journeyEnglish, journeyRussian, journeyChinese } from '../../src/renderer/src/box/journeys/i18n'
import { collectionEnglish, collectionRussian, collectionChinese } from '../../src/renderer/src/box/collection/i18n'
import { DiagnosticsPage } from '../../src/renderer/src/box/journeys/DiagnosticsPage'
import { phonesStatus, storageStatus, type JourneyAudioInventory } from '../../src/renderer/src/box/journeys/format'
import { Settings } from '../../src/renderer/src/box/Settings'
import { SongDetails } from '../../src/renderer/src/box/SongDetails'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { setLocale } from '../../src/shared/i18n'

const root = resolve(__dirname, '../..')
const source = (file: string): string => readFileSync(resolve(root, file), 'utf8')
const values = (...dictionaries: Array<Record<string, string>>): Array<[string, string]> =>
  dictionaries.flatMap(dictionary => Object.entries(dictionary))

// One name per concept: Songs (library), Google Drive (account), Audio & microphones (sound page), Vocals.
const RETIRED: Record<string, RegExp> = {
  en: /catalog|collection|\bprojects?\b|SingZ library|sound settings|lead vocal|desktop singz|prepared (local )?stems?|prepared in|FLOW 8|\bPCM\b|nominal/i,
  ru: /каталог|коллекц|проект|библиотека singz|настройки звука|ведущий вокал|desktop singz|FLOW 8|номинальн/i,
  'zh-CN': /曲库|收藏|项目|声音设置|主唱|desktop singz|FLOW 8|标称/i
}
const sets = {
  en: [en, enSettings, journeyEnglish, collectionEnglish],
  ru: [ru, ruSettings, journeyRussian, collectionRussian],
  'zh-CN': [zh, zhSettings, journeyChinese, collectionChinese]
} as unknown as Record<string, Array<Record<string, string>>>

afterEach(() => setLocale('en'))

describe('Box copy: one name per concept, no engineering text', () => {
  for (const [locale, pattern] of Object.entries(RETIRED)) {
    it(`${locale}: no retired name or engineering term in any Box string`, () => {
      const hits = values(...sets[locale]).filter(([, text]) => pattern.test(text)).map(([key, text]) => `${key}: ${text}`)
      expect(hits).toEqual([])
    })
  }

  it('uses the chosen names in every locale and every occurrence', () => {
    const expected = {
      en: { songs: 'Songs', drive: 'Google Drive', audio: 'Audio & microphones', vocals: 'Vocals', menu: 'Menu' },
      ru: { songs: 'Песни', drive: 'Google Drive', audio: 'Звук и микрофоны', vocals: 'Вокал', menu: 'Меню' },
      'zh-CN': { songs: '歌曲', drive: 'Google Drive', audio: '音频和麦克风', vocals: '人声', menu: '菜单' }
    }
    for (const [locale, names] of Object.entries(expected)) {
      const [box, settings, journey] = sets[locale]
      expect(box['box.navigation.catalog'], locale).toBe(names.songs)
      expect(box['box.catalog.title'], locale).toBe(names.songs)
      expect(box['box.navigation.account'], locale).toBe(names.drive)
      expect(box['box.account.title'], locale).toBe(names.drive)
      expect(journey['journey.setup.account'], locale).toBe(names.drive)
      expect(settings['box.settings.title'], locale).toBe(names.audio)
      expect(journey['journey.home.audio'], locale).toBe(names.audio)
      expect(journey['journey.setup.audio'], locale).toBe(names.audio)
      expect(box['box.mix.lead'], locale).toBe(names.vocals)
      expect(box['box.hints.navigation'], locale).toBe(names.menu)
    }
  })

  it('uses the natural follow-up wording', () => {
    expect(ruSettings['box.settings.defaultOutput']).toBe('Системный выход по умолчанию')
    expect(zh['box.details.readyBody']).toContain('点击“演唱”即可立即播放')
    expect(en['box.details.noPreparation'].endsWith('Box plays those songs.')).toBe(true)
    expect(ru['box.details.noPreparation'].endsWith('Box воспроизводит эти песни.')).toBe(true)
    expect(zh['box.details.noPreparation'].endsWith('Box 播放准备好的歌曲。')).toBe(true)
  })

  it('has no keys for the retired song-list concepts', () => {
    for (const dictionary of [en, ru, zh] as Array<Record<string, string>>) {
      expect('box.catalog.library' in dictionary).toBe(false)
      expect('box.player.savedStems' in dictionary).toBe(false)
    }
  })

  it('keeps text-based e2e selectors aligned with canonical copy', () => {
    expect(source('tests/e2e/box-smoke.cjs')).toContain(`page.getByText('${en['box.details.sourceMissing']}')`)
    expect(source('tests/e2e/box-cjm-smoke.cjs')).toContain(`{ name: '${journeyEnglish['journey.privacy.connect']}', exact: true }`)
  })

  it('unit text keeps number and unit together (no double space)', () => {
    for (const text of [journeyEnglish['journey.expires'], journeyRussian['journey.expires'], en['box.player.countdownSeconds'], ru['box.player.countdownSeconds']]) {
      expect(text).not.toMatch(/ {2}|  |  |  |  /)
    }
  })
})

describe('Song details artist subtitle', () => {
  it('uses Artist unknown instead of a table-cell dash', async () => {
    await prepareBoxLocale('en')
    const html = renderToStaticMarkup(createElement(SongDetails, {
      entry: { id: 'local:/p', name: 'Donaukinder', local: { dir: '/p', songPath: '/p/s.flac', name: 'Donaukinder' }, remoteId: null, unavailable: false },
      inspection: { readiness: 'ready', project: { stems: { vocals: 'v.flac' }, hasLyrics: true, settings: {} }, message: null },
      metadata: null, transpose: 0, queued: false, busy: false, error: null, actionError: null, download: null,
      onBack: vi.fn(), onSing: vi.fn(), onPrepare: vi.fn(), onVerify: vi.fn(), onCancelDownload: vi.fn(), onToggleQueue: vi.fn()
    } as never))
    expect(html).toContain('<div class="detail-identity"><p aria-label="Artist unknown">Artist unknown</p><h1>Donaukinder</h1></div>')
  })
})

describe('Diagnostics owns revisions and sample-rate detail', () => {
  it('renders the details on Diagnostics, not in the singer Settings views', () => {
    const device: DesktopAudioHostDevice = {
      uid: 'alsa:flow', label: 'FLOW 8', defaultInput: true, defaultOutput: true,
      inputChannels: 2, outputChannels: 2, inputChannelLabels: [], outputChannelLabels: [],
      nominalSampleRate: 48000, direction: 'duplex', accessMode: 'shared', transport: 'usb',
      monitoringSuitability: 'low-latency', sampleRateRanges: [{ minimumHz: 44100, maximumHz: 48000 }],
      bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 128, fundamentalFrames: 1 }
    }
    const audioInventory: JourneyAudioInventory = {
      ok: true, platform: 'linux', provider: 'alsa', defaultInputUid: device.uid, defaultOutputUid: device.uid, devices: [device]
    }
    const routing = {
      version: 1,
      inventory: { devices: [{ uid: 'alsa:mic', name: 'Mic input', inputChannels: 2, outputChannels: 0, rate: 96000 }] },
      snapshot: { restoration: { desiredGeneration: '7', activeGeneration: '5' } }
    } as unknown as BoxRoutingState
    const noop = vi.fn()
    const html = renderToStaticMarkup(createElement(DiagnosticsPage, {
      diagnostics: { appVersion: '1', platform: 'linux', arch: 'arm64', audio: null },
      routing, audioInventory, loading: false, error: null,
      onRefresh: noop, onAudio: noop, onSetup: noop, onBack: noop
    }))
    expect(enSettings['box.settings.routing.revisions']).toBe('Saved revision {saved} · Active revision {active}')
    expect(html).toContain('Saved revision 7 · Active revision 5')
    expect(html).toContain('Sample rate')
    expect(html).toContain('Also supports')
    expect(html).toContain('44.1 kHz – 48 kHz')
    expect(html).toContain('96 kHz')
    expect(html).toContain('data-diagnostics-device="alsa:mic"')
    expect(html).toContain('<dl class="journey-metrics journey-diagnostic-rates">')
    const css = source('src/renderer/src/box/journeys/journeys.css')
    expect(css).toMatch(/\.journey-diagnostic-rates\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
    expect(css).toMatch(/\.journey-diagnostic-rates dt\s*\{[^}]*font-size: var\(--box-meta-size\)/)
    expect(css).toMatch(/\.journey-diagnostic-rates dd\s*\{[^}]*font-size: var\(--box-row-size\)/)

    const settings = renderToStaticMarkup(createElement(Settings, {
      inventory: audioInventory, loading: false, error: null, currentOutputUid: null,
      playbackActive: false, onRefresh: noop, onApplyOutput: vi.fn(async () => undefined), onBack: noop
    }))
    for (const detail of ['Sample rate', 'Also supports', '48 kHz', '96 kHz', 'Saved revision']) expect(settings).not.toContain(detail)
    expect(source('src/renderer/src/box/RoutingSettings.tsx')).not.toContain('box.settings.routing.revisions')
    expect(source('src/renderer/src/box/journeys/useDiagnostics.ts')).toContain('api.routingSnapshot()')
    const hub = source('src/renderer/src/box/journeys/JourneyHub.tsx')
    expect(hub).toContain('routing={diagnostics.routing}')
    expect(hub).toContain('audioInventory={inventory.audio}')
  })
})

describe('Settings status uses words for empty values and locale plurals for phones', () => {
  const cases: Array<[string, 'en' | 'ru' | 'zh-CN', number, string]> = [
    ['en 0', 'en', 0, 'None paired'], ['en 1', 'en', 1, '1 phone'], ['en 2', 'en', 2, '2 phones'],
    ['ru 0', 'ru', 0, 'Нет подключённых'], ['ru 1', 'ru', 1, '1 телефон'], ['ru 2', 'ru', 2, '2 телефона'],
    ['ru 5', 'ru', 5, '5 телефонов'], ['ru 21', 'ru', 21, '21 телефон'], ['ru 22', 'ru', 22, '22 телефона'],
    ['zh 0', 'zh-CN', 0, '没有已配对手机'], ['zh 3', 'zh-CN', 3, '3部手机']
  ]
  it.each(cases)('%s', async (_name, locale, count, expected) => {
    await prepareBoxLocale(locale)
    expect(phonesStatus(count)).toBe(expected)
  })

  it('zero storage is Nothing saved in every locale', async () => {
    for (const [locale, expected] of [['en', 'Nothing saved'], ['ru', 'Ничего не сохранено'], ['zh-CN', '尚未保存']] as const) {
      await prepareBoxLocale(locale)
      expect(storageStatus({ cacheBytes: 0 } as BoxStorageSnapshot)).toBe(expected)
    }
  })

  it('negative control: the old phone status was the bare count', () => {
    expect(phonesStatus(0)).not.toBe('0')
  })
})
