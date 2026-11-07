import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseDesktopPlaybackLaneConfigs } from '../../src/main/lane-measure-cache'
import type { DesktopPlaybackLaneConfig } from '../../src/shared/types'
import { functionBody } from '../shared/native-playback-bridge-sources'

const addon = readFileSync('native/electron/playback_addon_bridge.cpp', 'utf8')

const lane = (): DesktopPlaybackLaneConfig => ({
  id: 'vocals',
  path: '/allowed/vocals.flac',
  gain: 0.8,
  muted: false,
  solo: true
})

describe('desktop playback renderer lane sanitization', () => {
  it('constructs fresh scalar-only lane objects', () => {
    const input = [lane()]
    const parsed = parseDesktopPlaybackLaneConfigs(input)
    expect(parsed).toEqual(input)
    expect(parsed?.[0]).not.toBe(input[0])
  })

  it.each([
    ['sourceKey', { sourceKey: `measure:${'0'.repeat(64)}` }],
    ['waveform', { waveform: { version: 1, policy: 'singz.native.streaming-envelope.rms96-v1', contentKey: 'measure:fake', peaks: [] } }],
    ['unknown', { unknown: true }]
  ])('refuses renderer-supplied %s fields', (_name, extra) => {
    expect(parseDesktopPlaybackLaneConfigs([{ ...lane(), ...extra }])).toBeNull()
  })

  it('refuses missing and malformed scalar fields', () => {
    expect(parseDesktopPlaybackLaneConfigs([{ ...lane(), gain: Number.NaN }])).toBeNull()
    expect(parseDesktopPlaybackLaneConfigs([{ ...lane(), muted: 0 }])).toBeNull()
    expect(parseDesktopPlaybackLaneConfigs([{ id: 'missing-required-fields' }])).toBeNull()
  })
})

describe('desktop N-API waveform seed parsing', () => {
  it('allows trusted lane fields and only the four seed scalars', () => {
    const lanes = functionBody(addon, 'bool parseLanes(')
    const seed = functionBody(addon, 'bool parseWaveformSeed(')
    expect(lanes).toContain('{"id", "path", "gain", "muted", "solo", "sourceKey", "waveform"}')
    expect(seed).toContain('{"version", "policy", "contentKey", "peaks"}')
    expect(lanes).toContain('parseWaveformSeed(env, waveformValue, sourceKey, &seed)')
  })

  it('checks version, policy, matching measure identity, and exact bounded RMS96 values', () => {
    const seed = functionBody(addon, 'bool parseWaveformSeed(')
    expect(seed).toContain('validMeasureWaveformKey(sourceKey)')
    expect(seed).toContain('kNativePlaybackWaveformSeedVersion')
    expect(seed).toContain('seed.policy != kNativePlaybackWaveformSeedPolicy')
    expect(seed).toContain('seed.contentKey != sourceKey')
    expect(seed).toContain('count != kNativePlaybackLaneSummaryBuckets')
    expect(seed).toContain('!std::isfinite(peak) || peak < 0.0 || peak > 1.0')
  })

  it('falls back to path identity unless a complete valid pair reaches the core', () => {
    const lanes = functionBody(addon, 'bool parseLanes(')
    expect(lanes).toContain('lane.sourceKey = path;')
    expect(lanes).toContain('lane.sourceKey = std::move(sourceKey);')
    expect(lanes).toContain('lane.waveform = std::move(seed);')
  })
})

describe('desktop trusted seed prepare wiring', () => {
  it('sanitizes before authorization and seeds only authorized lanes behind a fresh caller fence', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    const handler = main.slice(
      main.indexOf("'audio-host:playback-prepare'"),
      main.indexOf("'audio-host:playback-open'")
    )
    const sanitized = handler.indexOf('parseDesktopPlaybackLaneConfigs(rawLanes)')
    const authorized = handler.indexOf('!isAllowed(lane.path)', sanitized)
    const seeded = handler.indexOf('laneMeasureCache.seedPlaybackLanes(authorized)', authorized)
    const fenced = handler.indexOf('if (!callerIsCurrent())', seeded)
    const prepare = handler.indexOf('captureOwner.preparePlayback', fenced)
    expect(sanitized).toBeGreaterThanOrEqual(0)
    expect(authorized).toBeGreaterThan(sanitized)
    expect(seeded).toBeGreaterThan(authorized)
    expect(fenced).toBeGreaterThan(seeded)
    expect(prepare).toBeGreaterThan(fenced)
  })
})
