import React from 'react'
import ReactTestRenderer, { act } from 'react-test-renderer'
import { AppState, type AppStateStatus } from 'react-native'
import { ScreenScrim } from '../src/ui/ScreenBackground'

const mockRedraw = jest.fn()
let mockFocused = true
const mockChildListeners = new Set<() => void>()
const mockParentListeners = new Set<() => void>()
const mockParent = {
  addListener: (_event: string, listener: () => void) => { mockParentListeners.add(listener); return () => mockParentListeners.delete(listener) },
  getParent: () => undefined
}
const mockNavigation = {
  addListener: (_event: string, listener: () => void) => { mockChildListeners.add(listener); return () => mockChildListeners.delete(listener) },
  getParent: () => mockParent
}
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockFocused, useNavigation: () => mockNavigation }))
jest.mock('@shopify/react-native-skia', () => {
  const R = require('react'), V = require('react-native').View
  return {
    Canvas: R.forwardRef((props: any, ref: any) => { R.useImperativeHandle(ref, () => ({ redraw: mockRedraw })); return R.createElement(V, props, props.children) }),
    Rect: V, LinearGradient: () => null, vec: (x: number, y: number) => ({ x, y }), useCanvasRef: () => R.useRef(null)
  }
})
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers() })
test('redraws visible fades after focus, parent transitions and foregrounding, and releases listeners', async () => {
  jest.useFakeTimers()
  mockFocused = true; mockRedraw.mockClear(); mockChildListeners.clear(); mockParentListeners.clear()
  let appState: ((state: AppStateStatus) => void) | undefined
  const remove = jest.fn()
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => { appState = listener; return { remove } })
  let tree!: ReactTestRenderer.ReactTestRenderer
  const view = () => <ScreenScrim edge="top" style={{ height: 140 }} />
  await act(() => { tree = ReactTestRenderer.create(view()) })
  await act(() => jest.advanceTimersByTime(20))
  expect(mockRedraw).toHaveBeenCalledTimes(1)
  await act(() => { for (const listener of mockParentListeners) listener(); jest.advanceTimersByTime(20) })
  expect(mockRedraw).toHaveBeenCalledTimes(2)
  await act(() => { appState?.('active'); jest.advanceTimersByTime(20) })
  expect(mockRedraw).toHaveBeenCalledTimes(3)
  mockFocused = false
  await act(() => tree.update(view()))
  expect(mockChildListeners.size + mockParentListeners.size).toBe(0)
  expect(remove).toHaveBeenCalled()
  await act(() => { for (const listener of mockParentListeners) listener(); jest.advanceTimersByTime(20) })
  expect(mockRedraw).toHaveBeenCalledTimes(3)
  mockFocused = true
  await act(() => tree.update(view()))
  // Leaving before the next paint must cancel the outstanding redraw too.
  await act(() => tree.unmount())
  await act(() => jest.advanceTimersByTime(20))
  expect(mockRedraw).toHaveBeenCalledTimes(3)
  expect(mockChildListeners.size + mockParentListeners.size).toBe(0)
})
