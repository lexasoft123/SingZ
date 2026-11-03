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
    jest.useRealTimers()
    jest.resetModules()
  })

  async function freshTransport(): Promise<typeof import('../src/lyrics/lrclib')> {
    jest.resetModules() // downUntil is module state — each test gets a cold one
    const { NativeModules } = require('react-native')
    NativeModules.AudioRouteInfo = {
      getTextPref: async () => null,
      setTextPref: jest.fn(async () => {})
    }
    return require('../src/lyrics/lrclib')
  }

  it('404 is a miss — a final verdict', async () => {
    global.fetch = jest.fn(async () => ({ status: 404, ok: false })) as unknown as typeof fetch
    const t = await freshTransport()
    await expect(t.lookupLyrics({ title: 'Nothing', durationSec: 100 })).resolves.toBe('miss')
    const entries = await require('../src/log').logEntries()
    expect(
      entries.some(
        (e: { line: string; level: string }) => e.line.includes('HTTP 404') && e.level === 'info'
      )
    ).toBe(true)
    expect(entries.some((e: { line: string }) => e.line.includes('Lookup no match'))).toBe(true)
  })

  it('a 5xx is down, and the TTL short-circuits the next call', async () => {
    const mock = jest.fn(async () => ({ status: 503, ok: false }))
    global.fetch = mock as unknown as typeof fetch
    const t = await freshTransport()
    await expect(t.lookupLyrics({ title: 'Nothing', durationSec: 100 })).resolves.toBe('down')
    const callsAfterFirst = mock.mock.calls.length
    await expect(t.lookupLyrics({ title: 'Nothing', durationSec: 100 })).resolves.toBe('down')
    expect(mock.mock.calls.length).toBe(callsAfterFirst) // TTL answered, no new requests
    const entries = await require('../src/log').logEntries()
    expect(
      entries.some(
        (e: { line: string; level: string }) => e.line.includes('HTTP 503') && e.level === 'warn'
      )
    ).toBe(true)
    expect(
      entries.some(
        (e: { line: string }) => e.line.includes('skipped') && e.line.includes('after HTTP 503')
      )
    ).toBe(true)
    const { NativeModules } = require('react-native')
    const writes = NativeModules.AudioRouteInfo.setTextPref.mock.calls
    expect(
      writes.some(
        ([key, value]: [string, string]) =>
          key === 'singz.log.current.v1' && value.includes('HTTP 503')
      )
    ).toBe(true)
  })

  it('an explicit retry reaches the recovered service immediately instead of reusing its down verdict', async () => {
    const mock = jest
      .fn()
      .mockResolvedValueOnce({ status: 503, ok: false })
      .mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => [
          {
            id: 1,
            trackName: 'Recovered Song',
            artistName: 'Artist',
            duration: 100,
            syncedLyrics: '[00:00.00]Recovered lyrics'
          }
        ]
      })
    global.fetch = mock as unknown as typeof fetch
    const t = await freshTransport()
    const meta = { title: 'Recovered Song', durationSec: 100 }
    await expect(t.lookupLyrics(meta)).resolves.toBe('down')
    await expect(t.lookupLyrics(meta)).resolves.toBe('down')
    expect(mock).toHaveBeenCalledTimes(1)
    const retry = await t.lookupLyrics(meta, { retry: true })
    expect(typeof retry).toBe('object')
    expect(mock).toHaveBeenCalledTimes(2)
    const entries = await require('../src/log').logEntries()
    expect(
      entries.some((e: { line: string }) =>
        e.line.includes('manual retry: clearing cooldown after HTTP 503')
      )
    ).toBe(true)
    expect(entries.some((e: { line: string }) => e.line.includes('Lookup found'))).toBe(true)
  })

  it('manual variant search and selection each retry after a previous failure', async () => {
    const mock = jest.fn().mockResolvedValue({ status: 503, ok: false })
    global.fetch = mock as unknown as typeof fetch
    const t = await freshTransport()
    await t.lookupLyrics({ title: 'Nothing', durationSec: 100 })
    expect(mock).toHaveBeenCalledTimes(1)
    await t.searchCandidates({ free: 'Nothing' }, 100)
    expect(mock).toHaveBeenCalledTimes(2)
    await t.lyricsById(1, 100)
    expect(mock).toHaveBeenCalledTimes(3)
  })

  it('bot-check HTML with status 200 is down too', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => 'text/html' },
      json: async () => {
        throw new Error('not json')
      }
    })) as unknown as typeof fetch
    const t = await freshTransport()
    await expect(t.lookupLyrics({ title: 'Nothing', durationSec: 100 })).resolves.toBe('down')
    const entries = await require('../src/log').logEntries()
    expect(
      entries.some((e: { line: string }) =>
        e.line.includes('invalid JSON response (content-type text/html)')
      )
    ).toBe(true)
  })

  it('records a network rejection with its available native error detail', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('Network request failed')
    }) as unknown as typeof fetch
    const t = await freshTransport()
    await expect(t.lookupLyrics({ title: 'Nothing', durationSec: 100 })).resolves.toBe('down')
    const entries = await require('../src/log').logEntries()
    expect(
      entries.some(
        (e: { line: string; level: string }) =>
          e.line.includes('network failure: TypeError: Network request failed') &&
          e.level === 'warn'
      )
    ).toBe(true)
  })

  it('records a real abort deadline distinctly from a network rejection', async () => {
    jest.useFakeTimers()
    global.fetch = jest.fn(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    ) as unknown as typeof fetch
    const t = await freshTransport()
    const lookup = t.lookupLyrics({ title: 'Nothing', durationSec: 100 })
    await jest.advanceTimersByTimeAsync(10_000)
    await expect(lookup).resolves.toBe('down')
    const entries = await require('../src/log').logEntries()
    expect(
      entries.some(
        (e: { line: string; level: string }) =>
          e.line.includes('timeout after 10000ms') && e.level === 'warn'
      )
    ).toBe(true)
  })
})
