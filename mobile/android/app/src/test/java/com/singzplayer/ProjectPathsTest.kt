package com.singzplayer

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin end of the writer's shared name/path table
 * (tests/shared/project-name-cases.json). The TS reference writer runs the
 * same rows behavior-level (tests/unit/project-name-rules.test.ts), so a
 * phone add cannot name or place a folder differently than the tests and
 * the desktop expect.
 */
class ProjectPathsTest {

  private fun casesFile(): File {
    // gradle runs unit tests from the module dir; the table lives at the repo root
    var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (dir != null) {
      val candidate = File(dir, "tests/shared/project-name-cases.json")
      if (candidate.isFile) return candidate
      dir = dir.parentFile
    }
    throw IllegalStateException(
      "project-name-cases.json not found above ${System.getProperty("user.dir")}"
    )
  }

  @Test
  fun `safeName rows`() {
    val doc = JSONObject(casesFile().readText())
    val rows = doc.getJSONArray("safeName")
    assertTrue("the table should not be empty", rows.length() > 0)
    for (i in 0 until rows.length()) {
      val row = rows.getJSONObject(i)
      assertEquals(row.getString("in"), row.getString("out"), ProjectPaths.safeName(row.getString("in")))
    }
  }

  @Test
  fun `relOk rows`() {
    val doc = JSONObject(casesFile().readText())
    val rows = doc.getJSONArray("relOk")
    for (i in 0 until rows.length()) {
      val row = rows.getJSONObject(i)
      assertEquals(row.getString("in"), row.getBoolean("ok"), ProjectPaths.relOk(row.getString("in")))
    }
  }

  @Test
  fun `plainChild rows`() {
    val doc = JSONObject(casesFile().readText())
    val rows = doc.getJSONArray("plainChild")
    for (i in 0 until rows.length()) {
      val row = rows.getJSONObject(i)
      assertEquals(row.getString("in"), row.getBoolean("ok"), ProjectPaths.plainChild(row.getString("in")))
    }
  }
}
