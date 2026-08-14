/**
 * The phone half of the LRCLIB parity guard: the SAME fixture
 * tests/shared/lrc-fixture.json that desktop vitest asserts, parsed here
 * through the analysis bundle — the two platforms cannot drift in parsing
 * or word timing without one side going red. Plus the transport's
 * miss-vs-down semantics over a mocked fetch (a 'down' must never read as
 * a final verdict — the 2026-07-30 outage lesson).
 */
import { fixTagEncoding, metaFromFilename, parseLrc } from '../src/gen/analysis-lib'
import fixture from '../../tests/shared/lrc-fixture.json'

describe('parseLrc — shared fixture through the bundle', () => {
  it('reproduces tests/shared/lrc-fixture.json exactly', () => {
    expect(parseLrc(fixture.lrc, fixture.duration)).toEqual(fixture.lines)
  })
})

describe('bundled tag/meta helpers', () => {
  it('fixTagEncoding repairs CP1251 soup without TextDecoder', () => {
    expect(fixTagEncoding('Àðèÿ')).toBe('Ария')
    expect(fixTagEncoding('Motörhead')).toBe('Motörhead')
  })
  it('metaFromFilename strips numbering and brackets', () => {
    expect(metaFromFilename('08. Sixteen Tons [Am +2st].mp3').title).toBe('Sixteen Tons')
  })
})

describe('mobile transport — miss vs down', () => {
  const realFetch = global.fetch

  afterEach(() => {
    global.fetch = realFetch
    jest.resetModules()
  })

  async function freshTransport(): Promise<typeof import('../src/lyrics/lrclib')> {
    jest.resetModules() // downUntil is module state — each test gets a cold one
    return require('../src/lyrics/lrclib')
  }

  it('404 is a miss — a final verdict', async () => {
    global.fetch = jest.fn(async () => ({ status: 404, ok: false })) as unknown as typeof fetch
    const t = await freshTransport()
    await expect(
      t.lookupLyrics({ title: 'Nothing', durationSec: 100 })
    ).resolves.toBe('miss')
  })

  it('a 5xx is down, and the TTL short-circuits the next call', async () => {
    const mock = jest.fn(async () => ({ status: 503, ok: false }))
    global.fetch = mock as unknown as typeof fetch
    const t = await freshTransport()
    await expect(t.lookupLyrics({ title: 'Nothing', durationSec: 100 })).resolves.toBe('down')
    const callsAfterFirst = mock.mock.calls.length
    await expect(t.lookupLyrics({ title: 'Nothing', durationSec: 100 })).resolves.toBe('down')
    expect(mock.mock.calls.length).toBe(callsAfterFirst) // TTL answered, no new requests
  })

  it('bot-check HTML with status 200 is down too', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => {
        throw new Error('not json')
      }
    })) as unknown as typeof fetch
    const t = await freshTransport()
    await expect(t.lookupLyrics({ title: 'Nothing', durationSec: 100 })).resolves.toBe('down')
  })
})
