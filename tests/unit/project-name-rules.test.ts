/**
 * The TS end of the writer's shared name/path table
 * (tests/shared/project-name-cases.json) — run BEHAVIOR-level against the
 * reference writer, so the rows pin what a caller observes (created dir
 * names, rejected writes), not private helpers. Kotlin runs the same rows in
 * ProjectPathsTest; the Swift module mirrors the same rules.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
