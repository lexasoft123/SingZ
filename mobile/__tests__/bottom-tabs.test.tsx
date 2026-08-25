import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import BottomTabs from '../src/ui/BottomTabs'

test('bottom navigation exposes persistent Songs and Train tabs', async () => {
  const onChange = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
        <BottomTabs active="songs" onChange={onChange} />
      </SafeAreaProvider>
    )
  })
  const tabs = tree.root.findAll((node) => node.props.accessibilityRole === 'tab')
  expect([...new Set(tabs.map((tab) => tab.props.accessibilityLabel))]).toEqual(['Songs', 'Train'])
  expect(tabs.find((tab) => tab.props.accessibilityLabel === 'Songs')?.props.accessibilityState).toEqual({ selected: true })
  const train = tabs.find((tab) => tab.props.accessibilityLabel === 'Train' && typeof tab.props.onPress === 'function')!
  await ReactTestRenderer.act(() => train.props.onPress())
  expect(onChange).toHaveBeenCalledWith('training')
})
