import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Platform, ScrollView, StyleSheet, Text } from 'react-native'
// Exercise fit-to-content behavior on a supported iOS version.
const version = Object.getOwnPropertyDescriptor(Platform, 'Version')
Object.defineProperty(Platform, 'Version', { configurable: true, value: '26.5' })
const { Sheet, SheetScrollView } = require('../src/ui/bits') as typeof import('../src/ui/bits')
afterAll(() => { if (version) Object.defineProperty(Platform, 'Version', version) })

test('the fixed shared sheet header is accounted for without hiding scrollable content', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<Sheet title="A long translated sheet heading" fitContent onClose={() => undefined}>
      <SheetScrollView><Text>Last setting remains reachable by scrolling</Text></SheetScrollView>
    </Sheet>)
  })
  const viewport = () => tree.root.findByType(ScrollView)
  await ReactTestRenderer.act(() => viewport().props.onContentSizeChange(320, 10000))
  const initial = StyleSheet.flatten(viewport().props.style).height
  await ReactTestRenderer.act(() => tree.root.findByProps({ testID: 'sheet-header' }).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 62 } } }))
  expect(StyleSheet.flatten(viewport().props.style).height).toBe(initial - 62)
  expect(tree.root.findAllByType(Text).some(node => node.props.children === 'Last setting remains reachable by scrolling')).toBe(true)
  await ReactTestRenderer.act(() => tree.unmount())
})
