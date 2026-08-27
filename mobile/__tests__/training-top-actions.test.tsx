import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet } from 'react-native'
import { defaultTrainingPreferences } from '../src/gen/training-lib'
import { initialTrainingState, mobileTrainingReducer } from '../src/training/state'
import { TrainingHeader, TrainingSessionView } from '../src/ui/TrainingScreen'

function nativeAction(tree: ReactTestRenderer.ReactTestRenderer, label: string): ReactTestRenderer.ReactTestInstance {
  return tree.root.findAll((node) =>
    node.props.accessibilityRole === 'button' &&
    node.props.accessibilityLabel === label &&
    typeof node.props.onPress === 'function' &&
    typeof node.props.style === 'function'
  )[0]
}

function nodeText(node: ReactTestRenderer.ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : nodeText(child)).join('')
}

test('setup and summary Back use an elevated 48dp native hit surface', async () => {
  const onBack = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<TrainingHeader title="Set up the session" onBack={onBack} />)
  })
  const back = nativeAction(tree, 'Back')
  expect(nodeText(back)).toBe('‹')
  expect(nodeText(tree.root)).toContain('Set up the session')
  expect(back.props.collapsable).toBe(false)
  expect(back.props.hitSlop).toBe(10)
  const style = StyleSheet.flatten(back.props.style({ pressed: false }))
  expect(style.minHeight).toBeGreaterThanOrEqual(48)
  expect(style.zIndex).toBeGreaterThan(0)
  expect(style.elevation).toBeGreaterThan(0)
  await ReactTestRenderer.act(() => back.props.onPress())
  expect(onBack).toHaveBeenCalledTimes(1)
})

test('session End uses the same native hit surface and handler', async () => {
  let state = initialTrainingState(defaultTrainingPreferences())
  state = mobileTrainingReducer(state, { type: 'start', seed: 'top-action' })
  const onExit = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <TrainingSessionView
        state={state}
        liveMidi={null}
        activeTarget={0}
        onBegin={jest.fn()}
        onIdentify={jest.fn()}
        onNext={jest.fn()}
        onExit={onExit}
        onBackToSong={null}
      />
    )
  })
  const end = nativeAction(tree, 'End session')
  expect(nodeText(end)).toBe('‹')
  expect(end.props.hitSlop).toBe(10)
  expect(StyleSheet.flatten(end.props.style({ pressed: false })).minHeight).toBeGreaterThanOrEqual(48)
  await ReactTestRenderer.act(() => end.props.onPress())
  expect(onExit).toHaveBeenCalledTimes(1)
})
