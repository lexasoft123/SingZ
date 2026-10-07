import { encodeTrainingPcm, renderTrainingPcm } from '../src/training/native-cues'
jest.mock('../src/playback/native', () => ({ nativeTrainingOutput: () => undefined }))
const mockRelease = jest.fn()
const mockSources: any[] = [], mockGains: any[] = []
jest.mock('react-native-audio-api', () => ({
  OfflineAudioContext: jest.fn(() => ({
    destination: {},
    createBufferSource: () => {
      const source = { buffer: null, playbackRate: { value: 1 }, connect: jest.fn(), disconnect: jest.fn(), start: jest.fn(), stop: jest.fn() }
      mockSources.push(source); return source
    },
    createGain: () => {
      const gain = { connect: jest.fn(), disconnect: jest.fn(), gain: { setValueAtTime: jest.fn(), linearRampToValueAtTime: jest.fn() } }
      mockGains.push(gain); return gain
    },
    startRendering: () => Promise.resolve({ buffer: { release: mockRelease }, getChannelData: () => new Float32Array([0, .5, -.5, 1]) })
  }))
}))
beforeEach(() => { mockSources.length = 0; mockGains.length = 0; mockRelease.mockClear() })
it('transfers float PCM exactly without boxing samples into a native array', () => {
  const input = new Float32Array([0, .5, -.5, .123456789, 1e-20])
  expect(Buffer.from(encodeTrainingPcm(input), 'base64')).toEqual(Buffer.from(input.buffer))
})
it('retains sampled attack and release and releases all rendered native PCM pins', async () => {
  const payload = await renderTrainingPcm([{ notes: [48], articulation: 'together', durationSeconds: 1 }] as any, 'piano', () => ({ duration: 3 } as any), [1])
  expect(mockSources[0].playbackRate.value).toBe(1)
  expect(mockGains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(.6, .008)
  expect(mockGains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 1)
  expect(mockSources[0].stop).toHaveBeenCalledWith(1)
  expect(mockSources[0].buffer).toBeNull()
  expect(mockSources[0].disconnect).toHaveBeenCalled()
  expect(Buffer.from(payload, 'base64').length).toBe(16)
  expect(mockRelease).toHaveBeenCalledTimes(1)
})
it('rejects an unbounded phrase before allocating offline audio', async () => {
  await expect(renderTrainingPcm([{ notes: [48], articulation: 'together', durationSeconds: 121 }] as any, 'piano', () => ({ duration: 3 } as any), [])).rejects.toThrow('Invalid training phrase')
})
