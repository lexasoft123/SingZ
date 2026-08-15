import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One presentation at a time.
 *
 * The add sheet used to open the system file picker from its own mount
 * effect. On iOS that puts two view controllers into presentation from one
 * React commit, and UIKit keeps only one: it logged "Attempt to present
 * <RCTFabricModalHostViewController> on <UIViewController> which is waiting
 * for a delayed presention of <UIDocumentPickerViewController> to complete"
 * and then never presented the sheet. The flow kept running — picked, read,
 * lyrics — behind a screen with nothing on it, which is what reached a real
 * phone as "I've added song but interface just freezed".
 *
 * The picker now runs in the catalog, before the sheet exists, and the sheet
 * takes the picked file as a prop. No device can be asked about this in a
 * headless suite (the modal never mounts), so the rule is guarded at the
 * source: the sheet must not reach for the picker again.
 */
const read = (rel: string): string => readFileSync(join(__dirname, '..', 'src', rel), 'utf8')

test('the add sheet never opens the picker itself', () => {
  const sheet = read('ui/AddSongSheet.tsx')
  // a type-only import is fine; calling it is not
  expect(sheet).not.toMatch(/\bpickAudioFile\s*\(/)
})

test('the catalog picks first and opens the sheet with the file', () => {
  const catalog = read('ui/CatalogScreen.tsx')
  expect(catalog).toMatch(/\bpickAudioFile\s*\(\)/)
  // the sheet is handed what was picked — never opened empty
  expect(catalog).toMatch(/<AddSongSheet[\s\S]{0,200}src=\{addSrc\}/)
})
