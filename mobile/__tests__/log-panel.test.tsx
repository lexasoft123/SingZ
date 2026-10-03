import React from 'react'
import ReactTestRenderer, { act } from 'react-test-renderer'
import { Share } from 'react-native'
import LogPanel from '../src/ui/LogPanel'
import { logSessionEntries } from '../src/log'

jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }))

let mockLive: ((entry: unknown) => void) | null = null
jest.mock('../src/log', () => ({
  LOG_MAX_ENTRIES: 400,
  fmtTime: () => '12:00:00',
  formatLog: (entries: { line: string }[]) => entries.map(e => e.line).join('\n'),
  logEntries: jest.fn(async () => [{ t: 1, level: 'info', source: 'app', line: 'current-only' }]),
  logSessions: jest.fn(async () => [
    { id: 'current', startedAt: 2000, lines: 1, current: true },
    { id: 'past', startedAt: 1000, lines: 1, current: false }
  ]),
  logSessionEntries: jest.fn(async () => [{ t: 1, level: 'info', source: 'app', line: 'past-only' }]),
  clearLog: jest.fn(async () => undefined),
  onLogLine: jest.fn(fn => { mockLive = fn; return () => { mockLive = null } })
}))
const text = (node: ReactTestRenderer.ReactTestInstance): string => node.children.map(c =>
  typeof c === 'string' ? c : text(c)).join('')
const button = (tree: ReactTestRenderer.ReactTestRenderer, label: string) => tree.root.findAll(n =>
  n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function' &&
  (n.props.accessibilityLabel === label || text(n) === label))[0]
const pastOption = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findAll(n =>
  n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function' &&
  n.props.accessibilityState?.selected === false && !n.props.accessibilityLabel)[0]

test('selecting history isolates it from live lines and Share exports only the selected session', async () => {
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction })
  let tree!: ReactTestRenderer.ReactTestRenderer
  await act(async () => { tree = ReactTestRenderer.create(<LogPanel onClose={() => undefined} />) })
  expect(text(tree.root)).toContain('current-only')
  await act(async () => button(tree, 'Choose a log session').props.onPress())
  await act(async () => pastOption(tree).props.onPress())
  expect(text(tree.root)).toContain('past-only')
  expect(text(tree.root)).not.toContain('current-only')
  expect(mockLive).toBeNull()
  await act(async () => button(tree, 'Share the log').props.onPress())
  expect(share).toHaveBeenLastCalledWith({ message: 'past-only' })
  await act(async () => button(tree, 'Choose a log session').props.onPress())
  await act(async () => button(tree, 'Current session').props.onPress())
  expect(text(tree.root)).toContain('current-only')
  await act(async () => mockLive?.({ t: 2, level: 'info', source: 'mic', line: 'live-new' }))
  expect(text(tree.root)).toContain('live-new')
  await act(async () => tree.unmount())
  share.mockRestore()
})

test('a late historical read cannot replace the current session after switching back', async () => {
  let resolvePast!: (entries: unknown[]) => void
  ;(logSessionEntries as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { resolvePast = resolve }))
  let tree!: ReactTestRenderer.ReactTestRenderer
  await act(async () => { tree = ReactTestRenderer.create(<LogPanel onClose={() => undefined} />) })
  await act(async () => button(tree, 'Choose a log session').props.onPress())
  await act(async () => pastOption(tree).props.onPress())
  await act(async () => button(tree, 'Choose a log session').props.onPress())
  await act(async () => button(tree, 'Current session').props.onPress())
  await act(async () => resolvePast([{ t: 1, level: 'info', source: 'app', line: 'late-past' }]))
  expect(text(tree.root)).toContain('current-only')
  expect(text(tree.root)).not.toContain('late-past')
  await act(async () => tree.unmount())
})
