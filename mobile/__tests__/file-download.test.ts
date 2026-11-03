import { downloadFile, type FileDownloadNative, type FileProgress } from '../src/file-download'
const request = { project: 'Donaukinder', file: 'stems/custom-backing.mp3', url: 'https://drive.test/file', md5: 'abc', bytes: 1000 }
const fail = (code: string) => Object.assign(new Error(code), { code })
const saved = { path: '/saved/audio', downloaded: true }
function harness() {
  const native: jest.Mocked<Required<FileDownloadNative>> = {
    fetchToCache: jest.fn<ReturnType<Required<FileDownloadNative>["fetchToCache"]>, Parameters<Required<FileDownloadNative>["fetchToCache"]>>(async () => { throw fail('cacheMiss') }),
    fetchToCacheTracked: jest.fn<ReturnType<Required<FileDownloadNative>["fetchToCacheTracked"]>, Parameters<Required<FileDownloadNative>["fetchToCacheTracked"]>>(async () => saved),
    driveFetchProgress: jest.fn<ReturnType<Required<FileDownloadNative>["driveFetchProgress"]>, Parameters<Required<FileDownloadNative>["driveFetchProgress"]>>(async () => ({ got: 0, total: 1000 })),
    cancelDriveFetch: jest.fn<ReturnType<Required<FileDownloadNative>["cancelDriveFetch"]>, Parameters<Required<FileDownloadNative>["cancelDriveFetch"]>>(async () => true)
  }
  return { native, authorize: jest.fn(async (_renew: boolean) => 'Bearer token') }
}
beforeEach(() => jest.useFakeTimers())
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers() })

test('serves verified cached audio offline without authorization', async () => {
  const { native, authorize } = harness()
  native.fetchToCache.mockResolvedValueOnce({ ...saved, downloaded: false })
  expect(await downloadFile(native, request, authorize)).toEqual({ ...saved, downloaded: false })
  expect(authorize).not.toHaveBeenCalled()
  expect(native.fetchToCacheTracked).not.toHaveBeenCalled()
  expect(jest.getTimerCount()).toBe(0)
})
test.each(['fetch', 'http408', 'http429', 'http503', 'integrity'])('retries only the failed file (%s)', async code => {
  const { native, authorize } = harness()
  native.fetchToCacheTracked.mockRejectedValueOnce(fail(code))
  const progress: FileProgress[] = []
  const result = downloadFile(native, request, authorize, { onProgress: p => progress.push(p) })
  await jest.advanceTimersByTimeAsync(1100)
  expect(await result).toEqual(saved)
  expect(native.fetchToCacheTracked).toHaveBeenCalledTimes(2)
  expect(progress.some(p => p.phase === 'retrying' && p.attempt === 2)).toBe(true)
  expect(native.fetchToCache).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
})
test.each(['http403', 'http404', 'cacheWrite', 'auth'])('stops on permanent failure (%s)', async code => {
  const { native, authorize } = harness()
  native.fetchToCacheTracked.mockRejectedValueOnce(fail(code))
  await expect(downloadFile(native, request, authorize)).rejects.toMatchObject({ code })
  expect(native.fetchToCacheTracked).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
})
test('renews authorization after a 401', async () => {
  const { native, authorize } = harness()
  native.fetchToCacheTracked.mockRejectedValueOnce(fail('http401'))
  const result = downloadFile(native, request, authorize)
  await jest.advanceTimersByTimeAsync(1100)
  await result
  expect(authorize.mock.calls.map(([renew]) => renew)).toEqual([false, true])
})
test('reports bytes within a file and the verification phase', async () => {
  const { native, authorize } = harness()
  let finish!: (v: typeof saved) => void
  native.fetchToCacheTracked.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  native.driveFetchProgress.mockResolvedValueOnce({ got: 400, total: 1000 })
  native.driveFetchProgress.mockResolvedValueOnce({ got: 1000, total: 1000, verifying: true })
  const progress: FileProgress[] = []
  const result = downloadFile(native, request, authorize, { onProgress: p => progress.push(p) })
  await jest.advanceTimersByTimeAsync(650)
  expect(progress.some(p => p.phase === 'downloading' && p.got === 400)).toBe(true)
  expect(progress.some(p => p.phase === 'verifying' && p.got === 1000)).toBe(true)
  finish(saved)
  await result
  expect(jest.getTimerCount()).toBe(0)
})
test('bounds a stalled connection to three attempts', async () => {
  const { native, authorize } = harness()
  native.fetchToCacheTracked.mockImplementation(() => new Promise(() => {}))
  const result = downloadFile(native, request, authorize).catch(e => e)
  await jest.advanceTimersByTimeAsync(80_000)
  expect(await result).toMatchObject({ code: 'timeout' })
  expect(native.fetchToCacheTracked).toHaveBeenCalledTimes(3)
  expect(native.cancelDriveFetch).toHaveBeenCalledTimes(3)
  expect(jest.getTimerCount()).toBe(0)
})
test('cancels pending authorization without starting a late native transfer', async () => {
  const { native } = harness()
  let finish!: (auth: string) => void
  const authorize = jest.fn(() => new Promise<string>(resolve => { finish = resolve }))
  const controller = new AbortController()
  const result = downloadFile(native, request, authorize, { signal: controller.signal }).catch(e => e)
  await jest.advanceTimersByTimeAsync(100)
  controller.abort()
  expect(await result).toMatchObject({ code: 'cancelled' })
  finish('Bearer late-token')
  await jest.advanceTimersByTimeAsync(100)
  expect(native.fetchToCacheTracked).not.toHaveBeenCalled()
})
test('cancel addresses only its own native request and stops retries', async () => {
  const { native, authorize } = harness()
  native.fetchToCacheTracked.mockImplementation(() => new Promise(() => {}))
  const firstController = new AbortController()
  const otherController = new AbortController()
  const first = downloadFile(native, request, authorize, { signal: firstController.signal }).catch(e => e)
  const second = downloadFile(native, { ...request, file: 'stems/drums.flac' }, authorize, { signal: otherController.signal }).catch(e => e)
  await jest.advanceTimersByTimeAsync(100)
  const firstId = native.fetchToCacheTracked.mock.calls[0][6]
  const secondId = native.fetchToCacheTracked.mock.calls[1][6]
  firstController.abort()
  expect(await first).toMatchObject({ code: 'cancelled' })
  expect(firstId).not.toBe(secondId)
  expect(native.cancelDriveFetch.mock.calls).toEqual([[firstId]])
  otherController.abort()
  await second
  expect(native.fetchToCacheTracked).toHaveBeenCalledTimes(2)
  expect(jest.getTimerCount()).toBe(0)
})
