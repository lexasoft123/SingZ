import { NativeModules } from 'react-native'
import { dismissTabModals, tabModalListeners } from '../src/ui/tab-modal-dismissal'

function navigation() {
  const routes = [{ key: 'player', name: 'Player' }, { key: 'settings', name: 'Settings' }, { key: 'log', name: 'Log' }]
  return {
    getRootState: () => ({ type: 'tab', index: 0, routes: [{ name: 'songs', state: { type: 'stack', key: 'songs-stack', index: routes.length - 1, routes } }] }) as any,
    dispatch: jest.fn(() => { routes.pop() })
  }
}

test('waits for each native dismissal, preserving the loaded player', async () => {
  const nav = navigation()
  let done = false
  const result = dismissTabModals(nav).then(ok => { done = ok })
  expect(nav.dispatch).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  expect(done).toBe(false)
  tabModalListeners.transitionEnd({ target: 'log', data: { closing: false } })
  expect(nav.dispatch).toHaveBeenCalledTimes(1)
  tabModalListeners.transitionEnd({ target: 'log', data: { closing: true } })
  await Promise.resolve()
  expect(nav.dispatch).toHaveBeenCalledTimes(2)
  tabModalListeners.transitionEnd({ target: 'settings', data: { closing: true } })
  await result
  expect(done).toBe(true)
  expect(nav.getRootState().routes[0].state.routes.map((r: any) => r.name)).toEqual(['Player'])
  expect(nav.dispatch).toHaveBeenCalledWith(expect.objectContaining({ target: 'songs-stack', type: 'POP' }))
})

test('retains the current tab if native dismissal never completes', async () => {
  jest.useFakeTimers()
  try {
    const result = dismissTabModals(navigation())
    jest.advanceTimersByTime(5000)
    expect(await result).toBe(false)
  } finally { jest.useRealTimers() }
})


test('coalesces repeated requests and accepts the revealed native controller acknowledgement', async () => {
  const nav = navigation()
  const first = dismissTabModals(nav)
  expect(dismissTabModals(nav)).toBe(first)
  tabModalListeners.transitionEnd({ target: 'settings', data: { closing: false } })
  await Promise.resolve()
  tabModalListeners.transitionEnd({ target: 'player', data: { closing: false } })
  expect(await first).toBe(true)
  expect(nav.dispatch).toHaveBeenCalledTimes(2)
})



test('uses UIKit acknowledgement when Fabric no longer sends sheet transition events', async () => {
  const wait = jest.fn(async (_count: number) => true)
  const previous = NativeModules.FolderAccess
  NativeModules.FolderAccess = { waitForNavigationModals: wait }
  try {
    const nav = navigation()
    expect(await dismissTabModals(nav)).toBe(true)
    expect(wait.mock.calls).toEqual([[1], [0]])
    expect(nav.dispatch).toHaveBeenCalledTimes(2)
  } finally { NativeModules.FolderAccess = previous }
})


test('an initial release-notes route is not counted as a native presentation', async () => {
  const wait = jest.fn(async (_count: number) => true)
  const previous = NativeModules.FolderAccess
  NativeModules.FolderAccess = { waitForNavigationModals: wait }
  const routes = [{ name: 'WhatsNew', key: 'initial' }, { name: 'Log', key: 'log' }]
  try {
    expect(await dismissTabModals({
      getRootState: () => ({ type: 'stack', key: 'stack', index: routes.length - 1, routes }) as any,
      dispatch: () => { routes.pop() }
    })).toBe(true)
    expect(wait).toHaveBeenCalledWith(0)
  } finally { NativeModules.FolderAccess = previous }
})
