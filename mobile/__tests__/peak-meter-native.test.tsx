import React from 'react'
import { AppState } from 'react-native'
import renderer, { act } from 'react-test-renderer'

jest.mock('@shopify/react-native-skia', () => {
  const React = require('react')
  const { View } = require('react-native')
  const wrap = (name: string) => Object.assign((props: any) => React.createElement(View, props, props.children), { displayName: name })
  return { Canvas: wrap('Canvas'), Group: wrap('Group'), RoundedRect: wrap('Rect'), BlurMask: wrap('Blur') }
})
jest.mock('react-native-reanimated', () => {
  const React = require('react')
  const frames: any[] = []
  return {
    useSharedValue: (value: any) => React.useRef({ value }).current,
    useDerivedValue: (read: () => unknown) => ({ get value() { return read() } }),
    useReducedMotion: () => false,
    useFrameCallback: () => { const frame = React.useMemo(() => ({ setActive: jest.fn() }), []); frames.push(frame); return frame },
    __frames: frames,
  }
})
import { Canvas, RoundedRect } from '@shopify/react-native-skia'
import { PeakMeter } from '@singz/ui/native/meter'

describe('native meter first layout', () => {
  let stateDescriptor: PropertyDescriptor | undefined
  beforeEach(() => { stateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState'); Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true, writable: true }) })
  afterEach(() => { jest.restoreAllMocks(); if (stateDescriptor) Object.defineProperty(AppState, 'currentState', stateDescriptor) })
  it('mounts idle bricks before any JS layout callback and tracks animated sheet width on the UI thread', () => {
    let tree!: renderer.ReactTestRenderer
    act(() => { tree = renderer.create(<PeakMeter db={-Infinity} testID="song-output-full-meter" />) })
    const canvas = tree.root.findByType(Canvas)
    expect(canvas.props.style.width).toBe('100%')
    expect(canvas.props.onSize.value.width).toBe(0)
    const rectangles = tree.root.findAllByType(RoundedRect)
    expect(rectangles.length).toBe(123)
    const idle = rectangles[0]
    canvas.props.onSize.value = { width: 240, height: 16 }
    expect(idle.props.width.value).toBeCloseTo((240 - 2 * 39) / 40)
    canvas.props.onSize.value = { width: 320, height: 16 }
    expect(idle.props.width.value).toBeCloseTo((320 - 2 * 39) / 40)
    expect(tree.root.findByProps({ testID: 'song-output-full-meter' })).toBeTruthy()
    act(() => tree.unmount())
  })
  it('starts a constant first reading and stops its frame callback and AppState observer on unmount', () => {
    const remove = jest.fn()
    const listener = jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove })
    const frames = require('react-native-reanimated').__frames
    let tree!: renderer.ReactTestRenderer
    act(() => { tree = renderer.create(<PeakMeter db={-44} />) })
    const frame = frames[frames.length - 1]
    expect(frame.setActive).toHaveBeenLastCalledWith(true)
    act(() => tree.unmount())
    expect(frame.setActive).toHaveBeenLastCalledWith(false)
    expect(remove).toHaveBeenCalledTimes(1)
    listener.mockRestore()
  })
})
