import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { Bar } from '../src/ui/bits'

const touch = (x: number, y: number) => ({
  nativeEvent: { locationX: x, locationY: y, pageX: x, pageY: y }
})

test('horizontal fader drags keep the responder; vertical scrolling yields without changing volume', () => {
  const onChange = jest.fn()
  const onCommit = jest.fn()
  let tree: TestRenderer.ReactTestRenderer
  act(() => {
    tree = TestRenderer.create(<Bar value={0.7} color="yellow" onChange={onChange} onCommit={onCommit} />)
  })
  const bar = tree!.root.findAll(node => typeof node.props.onResponderGrant === 'function')[0].props
  bar.onLayout({ nativeEvent: { layout: { width: 100 } } })
  bar.onResponderGrant(touch(70, 20))
  bar.onResponderMove(touch(40, 21))
  expect(onChange).toHaveBeenLastCalledWith(0.4)
  expect(bar.onResponderTerminationRequest()).toBe(false)
  bar.onResponderRelease(touch(40, 21))
  expect(onCommit).toHaveBeenLastCalledWith(0.4)
  expect(bar.onResponderTerminationRequest()).toBe(true)

  onChange.mockClear()
  onCommit.mockClear()
  bar.onResponderGrant(touch(70, 20))
  bar.onResponderMove(touch(71, 40))
  expect(bar.onResponderTerminationRequest()).toBe(true)
  bar.onResponderTerminate()
  expect(onChange).not.toHaveBeenCalled()
  expect(onCommit).not.toHaveBeenCalled()
  act(() => tree!.unmount())
})
