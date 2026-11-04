import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import * as RN from 'react-native'
import { GlassHeader, HeaderAction } from '@singz/ui/native'

afterEach(() => jest.restoreAllMocks())

test('narrow headers keep one fixed bar and truncate long titles while actions remain usable', async () => {
  jest.spyOn(RN, 'useWindowDimensions').mockReturnValue({ width: 375, height: 667, scale: 2, fontScale: 2 })
  const onShare = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<GlassHeader testID="review-header" title="Очень длинное название мелодии для тренировки" onBack={() => {}} trailing={<>
      <HeaderAction label="Поделиться" onPress={onShare}><RN.Text>↑</RN.Text></HeaderAction>
      <HeaderAction label="Закрыть" onPress={() => {}}><RN.Text>×</RN.Text></HeaderAction>
    </>} />)
  })
  const surface = tree.root.findAllByType(RN.View).find(node => node.props.testID === 'review-header')!
  expect(RN.StyleSheet.flatten(surface.props.style).height).toBe(62)
  const title = tree.root.findAllByType(RN.Text).find(node => node.props.accessibilityRole === 'header')!
  expect(title.props.numberOfLines).toBe(1)
  expect(title.props.ellipsizeMode).toBe('tail')
  expect(RN.StyleSheet.flatten(title.props.style).fontSize).toBe(17)
  expect(title.props.maxFontSizeMultiplier).toBeLessThanOrEqual(1.3)
  await ReactTestRenderer.act(() => tree.root.findAllByType(HeaderAction)[1].props.onPress())
  expect(onShare).toHaveBeenCalledTimes(1)
  await ReactTestRenderer.act(() => tree.unmount())
})
