import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import * as RN from 'react-native'
import { TransportDock } from '@singz/ui/native'
import { defaultTrainingPreferences } from '../src/gen/training-lib'
import { initialTrainingState, mobileTrainingReducer } from '../src/training/state'
import { SingleNoteSetup, TrainingSessionView } from '../src/ui/TrainingScreen'
import { trainingBodyLayout } from '../src/ui/layout'
import { TrainingLessonOverview } from '../src/ui/TrainingLessonOverview'

afterEach(() => jest.restoreAllMocks())

test('fold, unfold and portrait resizing retain the current lesson and transport callbacks', async () => {
  const dimensions = jest.spyOn(RN, 'useWindowDimensions')
  let state = initialTrainingState(defaultTrainingPreferences())
  state = mobileTrainingReducer(state, { type: 'change-setup', patch: { exercise: 'interval', taskMode: 'imitate', length: 6 } })
  state = mobileTrainingReducer(state, { type: 'start', seed: 'resize' })
  state = mobileTrainingReducer(state, { type: 'activate' })
  state = mobileTrainingReducer(state, { type: 'cue-complete' })
  const onBegin = jest.fn()
  const onPause = jest.fn()
  const onSkip = jest.fn()
  const render = () => <TrainingSessionView state={state} liveMidi={null} activeTarget={1}
    onBegin={onBegin} onPause={onPause} onSkipSingleNote={onSkip} onIdentify={jest.fn()}
    onNext={jest.fn()} onExit={jest.fn()} onBackToSong={null} />
  dimensions.mockReturnValue({ width: 430, height: 932, scale: 2, fontScale: 1 })
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(render()) })
  const lesson = tree.root.findByType(TrainingLessonOverview)
  const transport = tree.root.findByType(TransportDock)
  await ReactTestRenderer.act(() => tree.root.findByProps({ testID: 'training-practice-body' }).props.onLayout({ nativeEvent: { layout: { height: 450 } } }))
  expect(lesson.props.compact).toBe(true)
  for (const [width, height] of [[932, 656], [656, 932], [820, 420], [430, 932]]) {
    dimensions.mockReturnValue({ width, height, scale: 2, fontScale: 1 })
    await ReactTestRenderer.act(() => tree.update(render()))
    expect(tree.root.findByType(TrainingLessonOverview)).toBe(lesson)
    expect(lesson.props.activeTarget).toBe(1)
    expect(tree.root.findByType(TransportDock)).toBe(transport)
    expect(transport.props.left.onPress).toBe(onBegin)
    expect(transport.props.right.onPress).toBe(onSkip)
  }
  expect(onBegin).not.toHaveBeenCalled()
  expect(onPause).not.toHaveBeenCalled()
  expect(onSkip).not.toHaveBeenCalled()
  await ReactTestRenderer.act(() => tree.unmount())
})

test('an open setup editor survives resizing with sound settings and start still available', async () => {
  const dimensions = jest.spyOn(RN, 'useWindowDimensions')
  const onStart = jest.fn()
  const render = () => <SingleNoteSetup setup={initialTrainingState(defaultTrainingPreferences()).setup}
    error={null} referenceVolume={0.65} pitchWindowCents={10} testingReferenceTone={false}
    onReferenceVolumeChange={jest.fn()} onPitchWindowChange={jest.fn()} onTestReferenceTone={jest.fn()}
    onChange={jest.fn()} onStart={onStart} onBack={jest.fn()} />
  dimensions.mockReturnValue({ width: 430, height: 932, scale: 2, fontScale: 1 })
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(render()) })
  const rangeRow = tree.root.findAll(node => node.props.label === 'Voice range' && typeof node.props.onPress === 'function')[0]
  await ReactTestRenderer.act(() => rangeRow.props.onPress())
  dimensions.mockReturnValue({ width: 932, height: 656, scale: 2, fontScale: 1 })
  await ReactTestRenderer.act(() => tree.update(render()))
  expect(tree.root.findAll(node => node.props.label === 'Voice range')[0].props.expanded).toBe(true)
  expect(tree.root.findAllByProps({ accessibilityLabel: 'Reference sound volume' }).length).toBeGreaterThan(0)
  const start = tree.root.findAll(node => node.props.label === 'Start practice' && typeof node.props.onPress === 'function')[0]
  await ReactTestRenderer.act(() => start.props.onPress())
  expect(onStart).toHaveBeenCalledTimes(1)
  await ReactTestRenderer.act(() => tree.unmount())
})

test('training density uses the remaining body height, including header and tabs', () => {
  expect(trainingBodyLayout(450, false).compact).toBe(true)
  expect(trainingBodyLayout(700, false).compact).toBe(false)
  expect(trainingBodyLayout(450, true).compact).toBe(false)
  expect(trainingBodyLayout(700, false, 1.3).compact).toBe(true)
})
