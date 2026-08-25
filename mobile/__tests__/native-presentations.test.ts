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
  expect(player).toMatch(
    /sheetAllowedDetents: NATIVE_SHEET_FIT_SUPPORTED \? 'fitToContents' : \[0\.55, 0\.93\]/
  )
  expect(player).toMatch(/name="Mixer"/)
  expect(player).toMatch(/name="Song"/)
  expect(player).toMatch(/name="Practice"/)
  expect(player.match(/options=\{PLAYER_SHEET_OPTIONS\}/g)).toHaveLength(2)
  expect(player).toMatch(/name="Mixer"[\s\S]*options=\{MIXER_SHEET_OPTIONS\}/)
  expect(player).toMatch(/MIXER_SHEET_OPTIONS[\s\S]*sheetInitialDetentIndex: 0/)
  expect(player.match(/<Sheet\n/g)).toHaveLength(3)
  expect(player.match(/fitContent=\{NATIVE_SHEET_FIT_SUPPORTED\}/g)).toHaveLength(3)
  expect(player).not.toMatch(/actionLabel=/)
  expect(player.match(/<SheetScrollView/g)).toHaveLength(3)
  expect(player).toMatch(/name="Mixer"[\s\S]*<SheetScrollView[\s\S]*\{hasVocals &&[\s\S]*\{tracks\.map/)
  expect(player.match(/contentInsetAdjustmentBehavior="never"/g)).toHaveLength(3)

  const bits = read('src/ui/bits.tsx')
  expect(bits).toMatch(/Platform\.OS !== 'ios' \|\| Number\.parseInt\(String\(Platform\.Version\), 10\) >= 16/)
  expect(bits).toMatch(/fitContent && b\.sheetFitContent/)
  expect(bits).toMatch(
    /sheetFitContent: \{[\s\S]*?flex: 0,[\s\S]*?paddingBottom: Platform\.OS === 'ios' \? 0 : 34/
  )
  expect(bits).toMatch(/maxHeight: Math\.max\(0, windowHeight - insets\.top\)/)
  expect(bits).toMatch(/sheetBodyFitContent: \{ flex: 0 \}/)
  expect(bits).toMatch(/function SheetScrollView/)
  expect(bits).toMatch(
    /NATIVE_SHEET_FIT_SUPPORTED[\s\S]*?height: Math\.min\(contentHeight, maxHeight\)[\s\S]*?: b\.sheetScrollFill/
  )
  expect(bits).toMatch(/sheetScrollFill: \{ flex: 1 \}/)

  const add = read('src/ui/AddSongSheet.tsx')
  expect(add).toMatch(
    /<Sheet[\s\S]*title="Add a song"[\s\S]*actionLabel="Cancel"[\s\S]*fitContent=\{NATIVE_SHEET_FIT_SUPPORTED\}/
  )
  expect(add).toMatch(/<SheetScrollView/)

  const root = read('src/ui/RootNavigator.tsx')
  expect(root).toMatch(
    /name="AddSong"[\s\S]*presentation: 'formSheet'[\s\S]*sheetAllowedDetents: NATIVE_SHEET_FIT_SUPPORTED \? 'fitToContents' : \[0\.42, 0\.93\]/
  )
  expect(root).toMatch(/!NATIVE_SHEET_FIT_SUPPORTED \? \{ sheetInitialDetentIndex: 0 \} : \{\}/)
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
