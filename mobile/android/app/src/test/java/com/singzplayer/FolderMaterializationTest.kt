package com.singzplayer

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FolderMaterializationTest {
  @Test
  fun `same-size replacement with restored mtime fails content equality`() {
    val root = createTempDir(prefix = "singz-folder-materialization")
    try {
      val source = File(root, "source.flac")
      val cached = File(root, "cached.flac")
      val original = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8)
      source.writeBytes(original)
      cached.writeBytes(original)
      val restored = 1_700_000_000_000L
      source.setLastModified(restored)
      cached.setLastModified(restored)
      assertTrue(FolderMaterialization.sameContent({ source.inputStream() }, cached))

      // Negative control: size and mtime remain equal. A metadata-only check
      // accepts the stale destination here and native playback reads old bytes.
      source.writeBytes(byteArrayOf(8, 7, 6, 5, 4, 3, 2, 1))
      source.setLastModified(restored)
      cached.setLastModified(restored)
      assertTrue(source.length() == cached.length())
      assertTrue(source.lastModified() == cached.lastModified())
      assertFalse(FolderMaterialization.sameContent({ source.inputStream() }, cached))
    } finally {
      root.deleteRecursively()
    }
  }
}
