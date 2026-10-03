import { failureCount, recordFailure } from '../src/split/flow'
import { getStoredText, setStoredText } from '../src/latency'
import { log } from '../src/log'

jest.mock('../src/latency', () => ({ getStoredText: jest.fn(), setStoredText: jest.fn() }))
jest.mock('../src/log', () => ({ log: jest.fn(), appInfo: jest.fn() }))

let saved: string | null
beforeEach(() => {
  jest.clearAllMocks()
  saved = null
  jest.mocked(getStoredText).mockImplementation(async () => saved)
  jest.mocked(setStoredText).mockImplementation(async (_key, value) => { saved = value })
})

test('a recovered native exit reason reaches the shareable log only once per run', async () => {
  const error = 'Android stopped the split during load-model: native crash'
  expect(await recordFailure('/song.mp3', 1000, error)).toBe(1)
  expect(log).toHaveBeenCalledWith('split', `failure 1 for /song.mp3 — ${error}`)
  expect(await recordFailure('/song.mp3', 1000, error)).toBe(1)
  expect(log).toHaveBeenCalledTimes(1)
  expect(await failureCount('/song.mp3')).toBe(1)
})

test('delayed exit history enriches an interrupted run without counting it twice', async () => {
  expect(await recordFailure('/song.mp3', 1000, 'The split was interrupted')).toBe(1)
  const reason = 'Android stopped the split during load-model: low memory'
  expect(await recordFailure('/song.mp3', 1000, reason)).toBe(1)
  expect(await recordFailure('/song.mp3', 1000, reason)).toBe(1)
  expect(log).toHaveBeenCalledTimes(2)
  expect(log).toHaveBeenLastCalledWith('split', `failure 1 for /song.mp3 — ${reason}`)
})

test('another attempt counts once and another song starts its own count', async () => {
  await recordFailure('/song.mp3', 1000, 'interrupted')
  expect(await recordFailure('/song.mp3', 2000, 'interrupted')).toBe(2)
  expect(await recordFailure('/song.mp3', 2000, 'interrupted')).toBe(2)
  expect(await recordFailure('/other.mp3', 2000, 'interrupted')).toBe(1)
  expect(log).toHaveBeenCalledTimes(3)
})
