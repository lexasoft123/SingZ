package com.singzplayer

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin end of the shared conformance table
 * (tests/shared/currency-cases.json). TypeScript and Swift run the same rows,
 * so "is the copy we have the file we want?" cannot mean three different things
 * on three platforms — which is exactly how a downloaded song ended up
 * re-downloading itself on Android.
 */
class CacheCurrencyTest {

  private fun casesFile(): File {
    // gradle runs unit tests from the module dir; the table lives at the repo root
    var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (dir != null) {
      val candidate = File(dir, "tests/shared/currency-cases.json")
      if (candidate.isFile) return candidate
      dir = dir.parentFile
    }
    throw IllegalStateException("currency-cases.json not found above ${System.getProperty("user.dir")}")
  }

  @Test
  fun `every row in the shared table`() {
    val doc = JSONObject(casesFile().readText())
    val rows = doc.getJSONArray("isCurrent")
    assertTrue("the table should not be empty", rows.length() > 0)
    for (i in 0 until rows.length()) {
      val row = rows.getJSONObject(i)
      val have = row.getJSONObject("have")
      val want = row.getJSONObject("want")
      val haveSize = have.getLong("size")
      // a JSON null means "present but it could not be hashed", which must
      // reach the rule as a null supplier — not as the string "null"
      val haveMd5 = if (have.has("md5") && !have.isNull("md5")) have.getString("md5") else null
      val got = CacheCurrency.isCurrent(
        haveSize,
        want.getLong("size"),
        if (want.has("md5") && !want.isNull("md5")) want.getString("md5") else ""
      ) { haveMd5 }
      assertEquals(row.getString("name"), row.getBoolean("expect"), got)
    }
  }

  @Test
  fun `hashing is the expensive half, so it happens last`() {
    var hashed = 0
    // wrong size: the answer is no without ever opening the file
    CacheCurrency.isCurrent(60, 100, "aaa") { hashed++; "aaa" }
    assertEquals(0, hashed)
    // nothing on disk: likewise
    CacheCurrency.isCurrent(-1, 100, "aaa") { hashed++; "aaa" }
    assertEquals(0, hashed)
    // size agrees and an md5 was stated: now it is worth reading
    CacheCurrency.isCurrent(100, 100, "aaa") { hashed++; "aaa" }
    assertEquals(1, hashed)
  }
}
