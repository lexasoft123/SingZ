package com.singzplayer

/**
 * "Is the copy we have the file we want?" — the one rule the whole Drive
 * library turns on, kept apart from the file handling so it can be tested
 * against the shared table in tests/shared/currency-cases.json. TypeScript and
 * Swift answer the same table; three implementations of five lines is how a
 * song came to sit in the library ticked and then download itself.
 *
 * `md5` is a lambda because hashing is the expensive half: it is only ever
 * called once the cheap checks have passed.
 */
object CacheCurrency {
  fun isCurrent(haveSize: Long, wantSize: Long, wantMd5: String, md5: () -> String?): Boolean {
    if (haveSize < 0) return false // nothing on disk
    if (wantSize > 0 && haveSize != wantSize) return false
    if (wantMd5.isEmpty()) return wantSize > 0 // nothing better stated than the size
    return md5() == wantMd5
  }
}
