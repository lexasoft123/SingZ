import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { defaultTrainingPreferences } from '../src/gen/training-lib'
import { initialTrainingState, mobileTrainingReducer, type MobileTrainingState } from '../src/training/state'
import { TrainingSessionView } from '../src/ui/TrainingScreen'

function feedbackState(length: number): MobileTrainingState {
  let state = initialTrainingState(defaultTrainingPreferences())
  state = mobileTrainingReducer(state, {
    type: 'change-setup',
    patch: { length, exercise: 'note', taskMode: 'identify' }
  })
  state = mobileTrainingReducer(state, { type: 'start', seed: `view-${length}` })
  state = mobileTrainingReducer(state, { type: 'activate' })
  state = mobileTrainingReducer(state, { type: 'cue-complete' })
  const prompt = state.session!.prompts[0]
  return mobileTrainingReducer(state, {
    type: 'record',
    result: {
      response: 'identify',
      promptId: prompt.id,
      answer: { kind: 'note', pitchClass: prompt.targets[0].pitchClass },
      completedAt: 1
    }
  })
}

function nodeText(node: ReactTestRenderer.ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : nodeText(child)).join('')
}

test.each([
  { length: 2, counter: '1 / 2', action: 'Next exercise' },
  { length: 1, counter: '1 / 1', action: 'See summary' }
])('feedback renders the answered prompt for a $length-prompt session', async ({ length, counter, action }) => {
  const onNext = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <TrainingSessionView
        state={feedbackState(length)}
        liveMidi={null}
        activeTarget={0}
        onBegin={jest.fn()}
        onIdentify={jest.fn()}
        onNext={onNext}
        onExit={jest.fn()}
      />
    )
  })
  expect(nodeText(tree.root)).toContain(counter)
  expect(nodeText(tree.root)).toContain('Correct')
  expect(nodeText(tree.root)).toContain(action)
  const actionButton = tree.root.findAll((node) =>
    node.props.accessibilityRole === 'button' &&
    typeof node.props.onPress === 'function' &&
    nodeText(node) === action
  )[0]
  await ReactTestRenderer.act(() => actionButton.props.onPress())
  expect(onNext).toHaveBeenCalledTimes(1)
})

test('melody grid keeps completed dots yellow and never marks playback as sung', async () => {
  let state = initialTrainingState(defaultTrainingPreferences())
  state = mobileTrainingReducer(state, { type: 'choose-exercise', exercise: 'melody' })
  state = mobileTrainingReducer(state, { type: 'change-setup', patch: { melodyLength: 7, length: 1 } })
  state = mobileTrainingReducer(state, { type: 'start', seed: 'melody-view' })
  const render = (phase: 'cue' | 'respond') => <TrainingSessionView state={{ ...state, phase }} liveMidi={null} activeTarget={2} onBegin={jest.fn()} onIdentify={jest.fn()} onNext={jest.fn()} onExit={jest.fn()} />
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(render('respond')) })
  expect(tree.root.findByProps({ testID: 'melody-grid' })).toBeTruthy()
  expect(tree.root.findByProps({ testID: 'melody-note-0' }).props.accessibilityLabel).toContain('locked')
  expect(tree.root.findByProps({ testID: 'melody-note-1' }).props.accessibilityLabel).toContain('locked')
  expect(tree.root.findByProps({ testID: 'melody-note-2' }).props.accessibilityLabel.toLowerCase()).toContain('current target')
  await ReactTestRenderer.act(() => { tree.update(render('cue')) })
  expect(tree.root.findByProps({ testID: 'melody-note-0' }).props.accessibilityLabel).not.toContain('locked')
  expect(tree.root.findByProps({ testID: 'melody-note-1' }).props.accessibilityLabel).not.toContain('locked')
  await ReactTestRenderer.act(() => tree.unmount())
})
