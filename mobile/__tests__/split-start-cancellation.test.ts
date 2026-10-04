import { startProjectSplit } from '../src/split/flow'
import { localProjectFile, readProjectText } from '../src/projects'
import { ensureSplitModel } from '../src/analysis/models'
import { splitVitals, startSplit } from '../src/split/service'

jest.mock('../src/projects', () => ({ readProjectText: jest.fn(), localProjectFile: jest.fn() }))
jest.mock('../src/analysis/models', () => ({ ensureSplitModel: jest.fn(), splitCapability: jest.fn() }))
jest.mock('../src/split/service', () => ({ splitVitals: jest.fn(), startSplit: jest.fn() }))
jest.mock('../src/split/adopt', () => ({ adoptSplit: jest.fn() }))
jest.mock('../src/log', () => ({ log: jest.fn(), appInfo: jest.fn() }))

beforeEach(() => {
  jest.resetAllMocks()
  jest.mocked(readProjectText).mockResolvedValue(JSON.stringify({ songFile: 'song.mp3' }))
  jest.mocked(localProjectFile).mockResolvedValue('/song.mp3')
  jest.mocked(ensureSplitModel).mockResolvedValue('/model.onnx')
  jest.mocked(splitVitals).mockResolvedValue(null)
  jest.mocked(startSplit).mockResolvedValue(undefined)
})

test('a current preparation hands its resolved files to native exactly once', async () => {
  await startProjectSplit('Song', { resume: true, isCurrent: () => true })
  expect(startSplit).toHaveBeenCalledTimes(1)
  expect(startSplit).toHaveBeenCalledWith(expect.objectContaining({
    srcPath: '/song.mp3', modelPath: '/model.onnx', projectDir: 'Song', resume: true
  }))
})

test('an already cancelled preparation never starts reading or fetching', async () => {
  await expect(startProjectSplit('Song', { isCurrent: () => false })).rejects.toThrow('cancelled')
  expect(readProjectText).not.toHaveBeenCalled()
  expect(ensureSplitModel).not.toHaveBeenCalled()
  expect(startSplit).not.toHaveBeenCalled()
})

test.each(['document', 'source', 'model', 'vitals'])('cancellation while awaiting %s prevents late native start', async stage => {
  let current = true
  let unblock!: () => void
  let reached!: () => void
  const held = new Promise<void>(resolve => { unblock = resolve })
  const entered = new Promise<void>(resolve => { reached = resolve })
  const wait = async (): Promise<void> => { reached(); await held }
  if (stage === 'document') jest.mocked(readProjectText).mockImplementation(async () => {
    await wait(); return JSON.stringify({ songFile: 'song.mp3' })
  })
  if (stage === 'source') jest.mocked(localProjectFile).mockImplementation(async () => {
    await wait(); return '/song.mp3'
  })
  if (stage === 'model') jest.mocked(ensureSplitModel).mockImplementation(async () => {
    await wait(); return '/model.onnx'
  })
  if (stage === 'vitals') jest.mocked(splitVitals).mockImplementation(async () => {
    await wait(); return null
  })
  const start = startProjectSplit('Song', { isCurrent: () => current })
  const result = expect(start).rejects.toThrow('cancelled')
  await entered
  current = false
  unblock()
  await result
  expect(startSplit).not.toHaveBeenCalled()
})
