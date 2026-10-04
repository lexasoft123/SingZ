import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { MobileTrainingPersistence } from '../src/training/persistence'
import { TrainingDashboard } from '../src/ui/TrainingDashboard'

function text(node: ReactTestRenderer.ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : text(child)).join('')
}
function button(tree: ReactTestRenderer.ReactTestRenderer, label: string) {
  return tree.root.findAll(node => node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function' && text(node).includes(label))[0]
}

test('first visit selects a program, starts its real next lesson, and exposes all free exercises', async () => {
  const saved = new Map<string, string>()
  const store = new MobileTrainingPersistence({ get: async key => saved.get(key) ?? null, set: async (key, value) => { saved.set(key, value) } })
  await store.load()
  const onLesson = jest.fn()
  const onChoose = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => { tree = ReactTestRenderer.create(<TrainingDashboard store={store} onLesson={onLesson} onProgress={jest.fn()} onChoose={onChoose} />) })
  expect(text(tree.root)).toContain('Choose a program level.')
  await ReactTestRenderer.act(async () => { button(tree, 'Foundation').props.onPress(); await store.flush() })
  expect(text(tree.root)).toContain('Day 1 of 7')
  expect(text(tree.root)).not.toContain('streak')
  await ReactTestRenderer.act(() => button(tree, 'Start today’s lesson').props.onPress())
  expect(onLesson).toHaveBeenCalledWith({ exercise: 'note', mode: 'imitate' }, 0)
  await ReactTestRenderer.act(() => button(tree, 'Full path').props.onPress())
  expect(text(tree.root)).toContain('Major third')
  expect(text(tree.root)).toContain('0 / 7 days practiced')
  await ReactTestRenderer.act(() => button(tree, 'Full path').props.onPress())
  await ReactTestRenderer.act(() => button(tree, 'See all').props.onPress())
  await ReactTestRenderer.act(() => button(tree, 'Full scales').props.onPress())
  expect(onChoose).toHaveBeenCalledWith('scale')
  const restored = new MobileTrainingPersistence({ get: async key => saved.get(key) ?? null, set: async () => undefined })
  await restored.load()
  expect(restored.program?.level).toBe('foundation')
  await ReactTestRenderer.act(() => tree.unmount())
})
