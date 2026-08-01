/**
 * The TypeScript end of the shared conformance table. The Kotlin and Swift
 * runners (mobile/android/app/src/test/…, mobile/ios/FolderAccess/Tests/…) read
 * the same JSON, so the three implementations of the ladder cannot drift apart
 * without one of them going red.
 */
import { describe, expect, it } from 'vitest'
import cases from '../shared/currency-cases.json'
import { isCurrent } from '../../mobile/src/current'
import { isFresh } from '../../src/main/sync-plan'

describe('isCurrent — the shared case table', () => {
  for (const c of cases.isCurrent) {
    it(c.name, () => {
      // -1 is the table's "no such file"; a null md5 is "it could not be hashed"
      const have = c.have.size < 0 ? null : { size: c.have.size, md5: c.have.md5 ?? undefined }
      expect(isCurrent(have, { size: c.want.size, md5: c.want.md5 })).toBe(c.expect)
    })
  }
})

describe('isFresh — the desktop re-hash rule', () => {
  for (const c of cases.isFresh) {
    it(c.name, () => {
      expect(isFresh(c.prev ?? undefined, c.now)).toBe(c.expect)
    })
  }
})
