import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { VOICE_MONITOR_GAIN_DEFAULT_DB, VOICE_MONITOR_GAIN_MAX_DB, VOICE_MONITOR_GAIN_MIN_DB, clampMonitorGainDb } from '../../src/shared/voice-monitor-gain'
import { MONITOR_GAIN_DEFAULT_DB, monitorDbToFader, monitorFaderToDb } from '../../src/renderer/src/audio/voice-take'

const read = (p: string): string => readFileSync(resolve(__dirname, '../..', p), 'utf8')

describe('monitor gain range is one constant across every layer', () => {
  it('is -60..+36 with a -6 dB first-use default inside it', () => {
    expect([VOICE_MONITOR_GAIN_MIN_DB, VOICE_MONITOR_GAIN_MAX_DB]).toEqual([-60, 36])
    expect(VOICE_MONITOR_GAIN_DEFAULT_DB).toBe(-6)
    expect(clampMonitorGainDb(99)).toBe(36)
    expect(clampMonitorGainDb(-99)).toBe(-60)
  })
  it('renderer mapping and default follow it', () => {
    expect(MONITOR_GAIN_DEFAULT_DB).toBe(VOICE_MONITOR_GAIN_DEFAULT_DB)
    expect(monitorFaderToDb(100)).toBe(VOICE_MONITOR_GAIN_MAX_DB)
    expect(monitorFaderToDb(0)).toBe(VOICE_MONITOR_GAIN_MIN_DB)
  })
  it('the main process clamps through the shared helper, with no literal range left', () => {
    const main = read('src/main/voice-monitor.ts')
    expect(main).toMatch(/clampMonitorGainDb/)
    expect(main).not.toMatch(/Math\.min\(12/)
  })
  it('the native header, host and bridge use one constexpr pair equal to the TS constants', () => {
    const header = read('native/playback/voice_monitor.h')
    expect(header).toContain(`kVoiceMonitorGainMinDb = ${VOICE_MONITOR_GAIN_MIN_DB}.0f`)
    expect(header).toContain(`kVoiceMonitorGainMaxDb = ${VOICE_MONITOR_GAIN_MAX_DB}.0f`)
    for (const f of ['native/playback/voice_monitor.cpp', 'native/electron/voice_monitor_bridge.cpp']) {
      const src = read(f)
      expect(src, f).toContain('kVoiceMonitorGainMaxDb')
      expect(src, f).not.toMatch(/clamp\(gain,\s*-60\.0f?,\s*12\.0f?\)/)
    }
  })
})
