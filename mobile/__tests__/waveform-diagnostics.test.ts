import { waveformReadyMessage } from '../src/waveform-diagnostics'

describe('waveform availability diagnostics', () => {
  it('reports cached project coverage without inventing a measured duration', () => {
    expect(waveformReadyMessage('project', 6, 6)).toBe('project envelope ready · 6/6 lanes')
    expect(waveformReadyMessage('project', 2, 7)).toBe('project envelope ready · 2/7 lanes')
    expect(waveformReadyMessage('project', 6, 6)).not.toMatch(/measured|0 ms/)
  })
  it('labels native response latency as availability even when all returned lanes were seeded', () => {
    expect(waveformReadyMessage('native', 6, 6, 128.6)).toBe('envelope ready · 6/6 lanes · available after 129 ms')
    expect(waveformReadyMessage('native', 1, 6, -10)).toBe('envelope ready · 1/6 lanes · available after 0 ms')
  })
})
