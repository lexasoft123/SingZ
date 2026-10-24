import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import { AppState, Text, type AppStateStatus } from 'react-native'
import { useLibraryRefresh } from '../src/ui/useLibraryRefresh'

let listeners: Set<(state: AppStateStatus) => void>
let screen: Renderer.ReactTestRenderer
const refresh = jest.fn<Promise<void>, [boolean?]>()

function Shelf({ visible = true, drive = true }: { visible?: boolean; drive?: boolean }) {
  useLibraryRefresh(visible, drive, refresh)
  return <Text>Existing song</Text>
}

beforeEach(() => {
  jest.useFakeTimers()
  listeners = new Set()
  refresh.mockReset().mockResolvedValue(undefined)
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    listeners.add(listener)
    return { remove: () => { listeners.delete(listener) } }
  })
})
afterEach(async () => {
  if (screen!) await act(() => screen.unmount())
  jest.restoreAllMocks()
  jest.useRealTimers()
})
const state = async (next: AppStateStatus) => {
  await act(() => { for (const listener of listeners) listener(next) })
}

test('shows existing songs while the initial forced Drive refresh is pending', async () => {
  let finish!: () => void
  refresh.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  await act(() => { screen = Renderer.create(<Shelf />) })
  expect(refresh).toHaveBeenCalledWith(true)
  expect(screen.root.findByType(Text).props.children).toBe('Existing song')
  await act(() => { jest.advanceTimersByTime(60_000) })
  expect(refresh).toHaveBeenCalledTimes(1)
  await act(() => { finish() })
  await act(() => { jest.advanceTimersByTime(60_000) })
  expect(refresh).toHaveBeenCalledTimes(2)
})

test('refreshes on foreground even within the five-minute listing TTL', async () => {
  await act(() => { screen = Renderer.create(<Shelf />) })
  await state('background')
  await act(() => { jest.advanceTimersByTime(60_000) })
  expect(refresh).toHaveBeenCalledTimes(1)
  await state('active')
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(refresh.mock.calls).toEqual([[true], [true]])
  await state('active')
  expect(refresh).toHaveBeenCalledTimes(2)
})

test('polls only the visible Drive shelf and releases listeners on leaving it', async () => {
  await act(() => { screen = Renderer.create(<Shelf visible={false} />) })
  expect(refresh).not.toHaveBeenCalled()
  await act(() => { screen.update(<Shelf />) })
  await act(() => { jest.advanceTimersByTime(60_000) })
  expect(refresh).toHaveBeenCalledTimes(2)
  await act(() => { screen.update(<Shelf visible={false} />) })
  await state('background')
  await state('active')
  await act(() => { jest.advanceTimersByTime(120_000) })
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(listeners.size).toBe(0)
  await act(() => { screen.update(<Shelf drive={false} />) })
  expect(refresh).toHaveBeenLastCalledWith(false)
  await act(() => { jest.advanceTimersByTime(120_000) })
  expect(refresh).toHaveBeenCalledTimes(3)
})

// Local reads do not need a foreground network connection. iOS can still be
// inactive at the first focus, and this path intentionally has no listener.
test('loads the local shelf when mounted during an inactive transition', async () => {
  const current = AppState.currentState
  AppState.currentState = 'inactive'
  try {
    await act(() => { screen = Renderer.create(<Shelf drive={false} />) })
    expect(refresh).toHaveBeenCalledWith(false)
  } finally {
    AppState.currentState = current
  }
})
