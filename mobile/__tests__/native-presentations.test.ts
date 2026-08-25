import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const tsxUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? tsxUnder(path) : path.endsWith('.tsx') ? [path] : []
  })

test('every app-owned modal is a native-stack presentation', () => {
  const offenders = tsxUnder(join(ROOT, 'src', 'ui'))
    .filter((file) => /<Modal\b/.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(ROOT.length + 1))

  expect(offenders).toEqual([])

  const player = read('src/ui/PlayerScreen.tsx')
  expect(player).toMatch(/presentation: 'formSheet'/)
  expect(player).toMatch(/name="Mixer"/)
  expect(player).toMatch(/name="Song"/)
  expect(player).toMatch(/name="Practice"/)

  const root = read('src/ui/RootNavigator.tsx')
  expect(root).toMatch(/name="AddSong"[\s\S]*presentation: 'formSheet'/)
  expect(root).toMatch(/name="Log"[\s\S]*presentation: 'fullScreenModal'/)
})

test('project creation cannot be dismissed between owning and finishing its files', () => {
  const add = read('src/ui/AddSongSheet.tsx')
  expect(add).toMatch(/creationLocked = step\.k === 'creating' && completedDir == null/)
  expect(add).toMatch(/usePreventRemove\(creationLocked/)
  expect(add).toMatch(/gestureEnabled: !creationLocked/)
  expect(add).toMatch(/setCompletedDir\(dir\)/)
})

test('a native-swiped player sheet releases its route state on unmount', () => {
  const player = read('src/ui/PlayerScreen.tsx')
  expect(player).toMatch(/function PlayerSheetRoute[\s\S]*useEffect\(\(\) => \(\) => onDismiss\(\)/)
  expect(player.match(/<PlayerSheetRoute onDismiss=\{sheetDismissed\}>/g)).toHaveLength(3)
  expect(player).not.toMatch(/listeners=\{\{ blur: sheetDismissed \}\}/)
})
