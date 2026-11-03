import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import * as RN from 'react-native'
import { TransportDock } from '@singz/ui/native'
import { defaultTrainingPreferences } from '../src/gen/training-lib'
import { initialTrainingState, mobileTrainingReducer } from '../src/training/state'
import { TrainingSessionView } from '../src/ui/TrainingScreen'
import { TrainingLessonOverview } from '../src/ui/TrainingLessonOverview'

afterEach(() => jest.restoreAllMocks())
function session(exercise: 'melody' | 'interval') {
  let state = initialTrainingState(defaultTrainingPreferences())
  state = mobileTrainingReducer(state, { type: 'choose-exercise', exercise })
  state = mobileTrainingReducer(state, { type: 'change-setup', patch: { melodyLength: 7, length: 1 } })
  state = mobileTrainingReducer(state, { type: 'start', seed: 'small-melody-layout' })
  state = mobileTrainingReducer(state, { type: 'activate' })
  return mobileTrainingReducer(state, { type: 'cue-complete' })
}

test('compact phone melodies scroll one intrinsic column containing the full grid and controls', async () => {
  jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 375, height: 667, scale: 2, fontScale: 1 })
  const onBegin = jest.fn(), onSkip = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(<TrainingSessionView state={session('melody')} liveMidi={null} activeTarget={2} onBegin={onBegin} onSkipSingleNote={onSkip} onIdentify={jest.fn()} onNext={jest.fn()} onExit={jest.fn()} />) })
  await ReactTestRenderer.act(() => tree.root.findByProps({ testID: 'training-practice-body' }).props.onLayout({ nativeEvent: { layout: { height: 450 } } }))
  const scroll = tree.root.findByProps({ testID: 'training-melody-body-scroll' })
  expect(tree.root.findAllByType(RN.ScrollView)).toHaveLength(1)
  for (let index = 0; index < 7; index++) expect(scroll.findByProps({ testID: `melody-note-${index}` })).toBeTruthy()
  expect(scroll.findByType(TrainingLessonOverview).props.activeTarget).toBe(2)
  const overviewStyle = RN.StyleSheet.flatten(scroll.findByProps({ testID: 'training-lesson-overview' }).props.style)
  expect(overviewStyle.flex).toBe(0)
  expect(overviewStyle.flexShrink).toBe(0)
  expect(overviewStyle.justifyContent).toBe('flex-start')
  expect(RN.StyleSheet.flatten(scroll.props.contentContainerStyle).flexGrow ?? 0).toBe(0)
  const transport = scroll.findByType(TransportDock)
  await ReactTestRenderer.act(() => { transport.props.left.onPress(); transport.props.right.onPress() })
  expect(onBegin).toHaveBeenCalledTimes(1)
  expect(onSkip).toHaveBeenCalledTimes(1)
  expect(tree.root.findByProps({ testID: 'training-swipe-surface' })).toBeTruthy()
  await ReactTestRenderer.act(() => tree.unmount())
})

test.each([{ exercise: 'melody' as const, width: 844, height: 390 }, { exercise: 'interval' as const, width: 375, height: 667 }])('$exercise width$width keeps separate lesson and detector columns', async ({ exercise, width, height }) => {
  jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width, height, scale: 2, fontScale: 1 })
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(<TrainingSessionView state={session(exercise)} liveMidi={null} activeTarget={0} onBegin={jest.fn()} onIdentify={jest.fn()} onNext={jest.fn()} onExit={jest.fn()} />) })
  expect(tree.root.findAllByProps({ testID: 'training-melody-body-scroll' })).toHaveLength(0)
  expect(tree.root.findAllByType(RN.ScrollView)).toHaveLength(2)
  expect(tree.root.findByType(TrainingLessonOverview).props.activeTarget).toBe(0)
  await ReactTestRenderer.act(() => tree.unmount())
})
