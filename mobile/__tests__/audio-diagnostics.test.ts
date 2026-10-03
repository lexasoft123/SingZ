import { detectedToneDelayMs } from '../src/training/diagnostics'

describe('acoustic pitch probe', () => {
  test('measures arrival against the scheduled engine time', () => {
    expect(detectedToneDelayMs(69, 440, 0.92, 1450, 1000)).toBe(450)
  })
  test('rejects an octave error, weak confidence and stale detection', () => {
    expect(detectedToneDelayMs(69, 220, 0.99, 1450, 1000)).toBeNull()
    expect(detectedToneDelayMs(69, 440, 0.5, 1450, 1000)).toBeNull()
    expect(detectedToneDelayMs(69, 440, 0.99, 950, 1000)).toBeNull()
    expect(detectedToneDelayMs(69, 440, 0.99, 4000, 1000)).toBeNull()
  })
  test('missing or nonfinite evidence cannot produce a pass', () => {
    expect(detectedToneDelayMs(69, NaN, 0.99, 1450, 1000)).toBeNull()
    expect(detectedToneDelayMs(69, 440, NaN, 1450, 1000)).toBeNull()
    expect(detectedToneDelayMs(69, 440, 0.99, null, 1000)).toBeNull()
    expect(detectedToneDelayMs(69, 440, 0.99, Infinity, 1000)).toBeNull()
  })
})

import { PitchDiagnosticWindow } from '../src/training/diagnostics'

test('real training summaries count every frame and octave jumps, then flush the tail', () => {
  const window = new PitchDiagnosticWindow()
  const frame = { frequency: 220, clarity: 0.9, rms: 0.1, sampleRate: 48000,
    resetCount: '2', timestampQuality: 'hardware', discontinuityReason: 'none' }
  window.add(frame, 0)
  window.add({ ...frame, frequency: 440 }, 40)
  window.add({ ...frame, frequency: 0, clarity: 0.2 }, 140)
  const report = window.flush()
  expect(report).toContain('3 blocks · 2 pitched/2 confidence')
  expect(report).toContain('octave jumps 1')
  expect(report).toContain('max delivery gap 100 ms')
  expect(report).toContain('resets 2')
  expect(window.flush()).toBeNull()
  window.add(frame, 200)
  expect(window.flush()).toContain('1 blocks')
})

test('harmonic correction counts include every frame and reset between reports', () => {
  const window = new PitchDiagnosticWindow()
  const frame = { frequency: 196, clarity: 0.9, rms: 0.1, sampleRate: 16000,
    resetCount: '0', timestampQuality: 'hardware', discontinuityReason: 'none' }
  window.add({ ...frame, harmonicCorrected: true }, 0)
  window.add(frame, 20)
  window.add({ ...frame, harmonicCorrected: true }, 40)
  expect(window.flush()).toContain('harmonic corrections 2')
  window.add(frame, 60)
  expect(window.flush()).toContain('harmonic corrections 0')
})
