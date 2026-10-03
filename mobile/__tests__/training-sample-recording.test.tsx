import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import { NativeModules, Share, Platform } from 'react-native'
import { useTrainingSampleRecording } from '../src/training/use-sample-recording'
jest.mock('../src/log', () => ({ log: jest.fn(), currentLogSessionId: () => 'test-session' }))
import { log } from '../src/log'
function Harness({ active }: { active: boolean }) { return <>{useTrainingSampleRecording(active)}</> }
const button = (tree: Renderer.ReactTestRenderer, label: string) => tree.root.findAll(n =>
  n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function' &&
  n.findAll(t => t.children.some(c => typeof c === 'string' && c === label)).length > 0)[0]
let tree: Renderer.ReactTestRenderer
beforeEach(() => {
  jest.useFakeTimers()
  Platform.OS = 'ios'
  NativeModules.AudioInputSession = {
    armCarSample: jest.fn(async (_filename: string) => undefined),
    finishCarSample: jest.fn(async () => {
      const filename = NativeModules.AudioInputSession.armCarSample.mock.calls.at(-1)[0]
      return { filename, url: `file:///${filename}`, seconds: 30, sampleRate: 24000 }
    })
  }
})
afterEach(async () => { await act(async () => tree?.unmount()); jest.useRealTimers() })
test('explicit opt-in records across rerenders, stops at 30 seconds, then shares manually', async () => {
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction })
  await act(async () => { tree = Renderer.create(<Harness active />) })
  expect(NativeModules.AudioInputSession.armCarSample).not.toHaveBeenCalled()
  await act(async () => button(tree, 'Record training sample (30 seconds)').props.onPress())
  await act(async () => tree.update(<Harness active />))
  expect(NativeModules.AudioInputSession.finishCarSample).not.toHaveBeenCalled()
  await act(async () => jest.advanceTimersByTime(30000))
  expect(NativeModules.AudioInputSession.finishCarSample).toHaveBeenCalledTimes(1)
  expect(share).not.toHaveBeenCalled()
  await act(async () => button(tree, 'Share training WAV').props.onPress())
  const filename = NativeModules.AudioInputSession.armCarSample.mock.calls[0][0]
  expect(filename).toMatch(/^SingZ-microphone-.*-session-test-session-take-\d+\.wav$/)
  expect(share).toHaveBeenCalledWith({ url: `file:///${filename}` })
  expect(log).toHaveBeenCalledWith('training-recording', expect.stringContaining(`started · ${filename}`))
  expect(log).toHaveBeenCalledWith('training-recording', expect.stringContaining(`saved · ${filename}`))
  share.mockRestore()
})
test('ending training finalizes once and preserves the share control', async () => {
  await act(async () => { tree = Renderer.create(<Harness active />) })
  await act(async () => button(tree, 'Record training sample (30 seconds)').props.onPress())
  await act(async () => tree.update(<Harness active={false} />))
  await act(async () => jest.advanceTimersByTime(30000))
  expect(NativeModules.AudioInputSession.finishCarSample).toHaveBeenCalledTimes(1)
  expect(button(tree, 'Share training WAV')).toBeTruthy()
})
test('an arm completing after exit is finalized without starting the recording timer', async () => {
  let resolve!: () => void
  NativeModules.AudioInputSession.armCarSample.mockImplementation(() => new Promise<void>(r => { resolve = r }))
  await act(async () => { tree = Renderer.create(<Harness active />) })
  act(() => { void button(tree, 'Record training sample (30 seconds)').props.onPress() })
  await act(async () => tree.update(<Harness active={false} />))
  await act(async () => resolve())
  expect(NativeModules.AudioInputSession.finishCarSample).toHaveBeenCalledTimes(1)
})

test('successive recordings in one session have distinct filenames and share the latest take', async () => {
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction })
  await act(async () => { tree = Renderer.create(<Harness active />) })
  await act(async () => button(tree, 'Record training sample (30 seconds)').props.onPress())
  await act(async () => button(tree, 'Stop recording').props.onPress())
  const first = NativeModules.AudioInputSession.armCarSample.mock.calls[0][0]
  await act(async () => button(tree, 'Record training sample (30 seconds)').props.onPress())
  await act(async () => button(tree, 'Stop recording').props.onPress())
  const second = NativeModules.AudioInputSession.armCarSample.mock.calls[1][0]
  expect(second).not.toBe(first)
  await act(async () => button(tree, 'Share training WAV').props.onPress())
  expect(share).toHaveBeenCalledWith({ url: `file:///${second}` })
  expect(log).toHaveBeenCalledWith('training-recording', expect.stringContaining(`saved · ${first}`))
  expect(log).toHaveBeenCalledWith('training-recording', expect.stringContaining(`saved · ${second}`))
  share.mockRestore()
})


test('Android records named WAVs and shares through its FileProvider bridge', async () => {
  Platform.OS = 'android'
  NativeModules.AudioInput = {
    armCarSample: jest.fn(async (_filename: string) => undefined),
    finishCarSample: jest.fn(async () => {
      const filename = NativeModules.AudioInput.armCarSample.mock.calls.at(-1)[0]
      return { filename, url: `file:///cache/${filename}`, seconds: 30, sampleRate: 48000 }
    }),
    shareCarSample: jest.fn(async () => undefined)
  }
  const share = jest.spyOn(Share, 'share')
  await act(async () => { tree = Renderer.create(<Harness active />) })
  await act(async () => button(tree, 'Record training sample (30 seconds)').props.onPress())
  await act(async () => button(tree, 'Stop recording').props.onPress())
  await act(async () => button(tree, 'Share training WAV').props.onPress())
  const filename = NativeModules.AudioInput.armCarSample.mock.calls[0][0]
  expect(NativeModules.AudioInput.shareCarSample).toHaveBeenCalledWith(`file:///cache/${filename}`)
  expect(share).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledWith('training-recording', expect.stringContaining(`saved · ${filename}`))
  share.mockRestore()
})
