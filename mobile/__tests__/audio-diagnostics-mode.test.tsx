import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { NativeModules, Platform, Switch } from 'react-native'
import { AudioDiagnosticsScreen } from '../src/ui/AudioDiagnosticsScreen'
import type { MultitrackEngine } from '../src/engine'

jest.mock('../src/training/mic', () => ({
  TrainingMicrophone: class {
    stop = jest.fn(async () => undefined)
    isRequestingPermission = () => false
  }
}))

const engine = { cancelTrainingCues: jest.fn() } as unknown as MultitrackEngine
const originalOS = Platform.OS
const originalModule = NativeModules.AudioInputSession

afterEach(() => {
  Platform.OS = originalOS
  NativeModules.AudioInputSession = originalModule
})

test.each(['crepe-tiny', 'crepe-tiny-long-context'])(
  'restores %s and saves the opposite mode for training', async (savedMode) => {
    Platform.OS = 'ios'
    const setPitchDetector = jest.fn(async (name: string) => name)
    NativeModules.AudioInputSession = {
      getPitchDetector: jest.fn(async () => savedMode), setPitchDetector
    }
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<AudioDiagnosticsScreen engine={engine} active onBack={jest.fn()} />)
    })
    const toggle = tree.root.findByType(Switch)
    const enabled = savedMode === 'crepe-tiny-long-context'
    expect(toggle.props.value).toBe(enabled)
    expect(toggle.props.disabled).toBe(false)
    await ReactTestRenderer.act(async () => { await toggle.props.onValueChange(!enabled) })
    expect(setPitchDetector).toHaveBeenCalledWith(enabled ? 'crepe-tiny' : 'crepe-tiny-long-context')
    expect(tree.root.findByType(Switch).props.value).toBe(!enabled)
    await ReactTestRenderer.act(async () => { tree.unmount() })
  }
)

test('does not display an experimental CREPE switch for YIN', async () => {
  Platform.OS = 'ios'
  NativeModules.AudioInputSession = { getPitchDetector: jest.fn(async () => 'yin') }
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<AudioDiagnosticsScreen engine={engine} active onBack={jest.fn()} />)
  })
  expect(tree.root.findAllByType(Switch)).toHaveLength(0)
  await ReactTestRenderer.act(async () => { tree.unmount() })
})
