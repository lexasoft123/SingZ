/**
 * The TS end of the writer's shared name/path table
 * (tests/shared/project-name-cases.json) — run BEHAVIOR-level against the
 * reference writer, so the rows pin what a caller observes (created dir
 * names, rejected writes), not private helpers. Kotlin runs the same rows in
 * ProjectPathsTest, Swift in mobile/scripts/test-swift-project-paths.sh — and
 * the desktop's own safeName, the one the phones mirror, runs them here.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { safeName as desktopSafeName } from '../../src/main/projects'
import { fakeNativeWriter, type FakeNativeWriter } from '../shared/fake-native-cache'
import cases from '../shared/project-name-cases.json'

let docs: string
let native: FakeNativeWriter

beforeEach(() => {
  docs = mkdtempSync(join(tmpdir(), 'singz-name-rules-'))
  native = fakeNativeWriter(docs)
})

afterEach(() => {
  rmSync(docs, { recursive: true, force: true })
})

describe('safeName — observed as the created project dir', () => {
  for (const row of cases.safeName) {
    it(`${JSON.stringify(row.in)} → ${JSON.stringify(row.out)}`, async () => {
      const { dir } = await native.ensureProjectDir(row.in)
      expect(dir).toBe(row.out)
    })
  }
})

describe('safeName — the desktop (projects.ts), which the phones mirror', () => {
  for (const row of cases.safeName) {
    it(`${JSON.stringify(row.in)} → ${JSON.stringify(row.out)}`, () => {
      expect(desktopSafeName(row.in)).toBe(row.out)
    })
  }

  // Past the table: every short name over the characters that interact —
  // dots, whitespace, a banned character, a letter, an extension — gets the
  // same folder from the phone's reference writer and from the desktop, and
  // none of them is hidden, blank-edged or anything but a plain child. No tab
  // in the alphabet: the writer really creates each folder, and Windows (the
  // release build's npm test) refuses a tab inside a name; the table's
  // leading-tab row covers what a tab does to the rule.
  it('agrees with the phone writer on every short name, and never hides the folder', async () => {
    const alphabet = ['.', ' ', ' ', ':', 'a', '.mp3']
    const names = ['']
    let layer = ['']
    for (let len = 1; len <= 4; len++) {
      layer = layer.flatMap((prefix) => alphabet.map((c) => prefix + c))
      names.push(...layer)
    }
    for (const name of names) {
      const desktop = desktopSafeName(name)
      const { dir } = await native.ensureProjectDir(name)
      expect(dir, JSON.stringify(name)).toBe(desktop)
      expect(desktop.startsWith('.'), JSON.stringify(name)).toBe(false)
      expect(desktop, JSON.stringify(name)).toBe(desktop.trim())
      expect(desktop === '' || desktop === '.' || desktop === '..' || desktop.includes('/')).toBe(false)
    }
  })
})

describe('relOk — observed as writeText accepting or refusing', () => {
  for (const row of cases.relOk) {
    it(`${JSON.stringify(row.in)} is ${row.ok ? 'accepted' : 'refused'}`, async () => {
      const { dir } = await native.ensureProjectDir('Rules')
      const attempt = native.writeText(dir, row.in, 'x')
      if (row.ok) await expect(attempt).resolves.toBe(true)
      else await expect(attempt).rejects.toThrow()
    })
  }
})

describe('plainChild — observed as project-name acceptance', () => {
  for (const row of cases.plainChild) {
    it(`${JSON.stringify(row.in)} is ${row.ok ? 'accepted' : 'refused'}`, async () => {
      if (row.ok) {
        // a valid name must be writable-into (the dir itself may not exist yet)
        writeFileSync(join(docs, 'seed.txt'), 'x') // keep tmp non-empty for cleanup sanity
        await expect(
          (async () => {
            await native.writeText(row.in, 'project.json', '{}')
            return true
          })()
        ).resolves.toBe(true)
      } else {
        await expect(native.writeText(row.in, 'project.json', '{}')).rejects.toThrow()
      }
    })
  }
})
