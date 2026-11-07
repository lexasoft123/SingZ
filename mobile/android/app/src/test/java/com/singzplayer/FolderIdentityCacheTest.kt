package com.singzplayer

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same service drives currency and waveform identity; stamp/reader injection
 * proves byte reads, sub-second invalidation and descriptor races without JNI. */
class FolderIdentityCacheTest {
  private class Fixture {
    var pathStamp = FolderFileStamp(1, 2, 4, 1_700_000_000, 123_456_789, 1_700_000_000, 222_222_222)
    var descriptorStamp = pathStamp
    var bytes = "aaaa".toByteArray()
    var opens = 0
    var bytesRead = 0
    var closes = 0
    var failOpen = false
    var failStat = false
    var failAfterBytes: Int? = null
    var chunkSize = Int.MAX_VALUE
    var onRead: (() -> Unit)? = null
    var canonicalRedirect: String? = null
    var stampReads = 0
    var onStamp: ((Int) -> Unit)? = null
    var descriptorPath: String? = null
    var failDescriptorPath = false

    val cache = FolderIdentityCache(
      canonicalize = { canonicalRedirect ?: if (it == "alias") "song" else it },
      stampPath = {
        if (failStat) throw IOException("fixture stat failure")
        stampReads++
        onStamp?.invoke(stampReads)
        pathStamp
      },
      openFile = { path ->
        if (failOpen) throw IOException("fixture open failure")
        opens++
        val data = ByteArrayInputStream(bytes.copyOf())
        var consumed = 0
        object : FolderIdentityReader {
          override val input = object : InputStream() {
            override fun read(): Int = error("the cache must use bounded block reads")
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
              val action = onRead
              onRead = null
              action?.invoke()
              if (failAfterBytes?.let { consumed >= it } == true) throw IOException("fixture read failure")
              val count = data.read(buffer, offset, minOf(length, chunkSize))
              if (count > 0) { consumed += count; bytesRead += count }
              return count
            }
          }
          override fun stamp(): FolderFileStamp = descriptorStamp
          override fun canonicalPath(): String? = if (failDescriptorPath) null else descriptorPath ?: path
          override fun close() { closes++; data.close() }
        }
      }
    )

    fun replaceStamp(next: FolderFileStamp) {
      pathStamp = next
      descriptorStamp = next
    }
  }

  @Test
  fun `currency then identity hashes once and unchanged repeats read zero bytes`() {
    val f = Fixture()
    val want = "74b87337454200d4d33f80c4663dc5e5" // MD5 of aaaa
    fun current() = CacheCurrency.isCurrent(4, 4, want) { f.cache.identity("song")?.md5 }
    assertTrue(current())
    assertEquals(want, f.cache.identity("song")?.md5)
    repeat(4) { assertTrue(current()); assertEquals(want, f.cache.identity("song")?.md5) }
    assertEquals(1, f.opens)
    assertEquals(4, f.bytesRead)
    assertEquals(1, f.closes)
    assertEquals(want, f.cache.identity("alias")?.md5)
    assertEquals(1, f.opens)
  }

  @Test
  fun `negative control always rehash reads twice instead of meeting warm byte budget`() {
    val withoutProcessMemo = listOf(Fixture(), Fixture())
    for (f in withoutProcessMemo) assertNotNull(f.cache.identity("song"))
    assertEquals(2, withoutProcessMemo.sumOf { it.opens })
    assertEquals(8, withoutProcessMemo.sumOf { it.bytesRead })
    val shared = Fixture()
    repeat(2) { assertNotNull(shared.cache.identity("song")) }
    assertEquals(1, shared.opens)
    assertEquals(4, shared.bytesRead)
  }

  @Test
  fun `recanonicalization outside owned roots is refused before any file bytes or cached digest`() {
    val f = Fixture()
    // Models a parent symlink changed after the public method's initial
    // allowlist check. The service sees the final target before opening it.
    f.canonicalRedirect = "/outside/song"
    assertNull(f.cache.identity("/owned/song") { it.startsWith("/owned/") })
    assertEquals(0, f.opens)
    assertEquals(0, f.bytesRead)
    // An existing process-cache entry must not bypass the caller's boundary.
    assertNotNull(f.cache.identity("/outside/song"))
    assertNull(f.cache.identity("/owned/song") { it.startsWith("/owned/") })
    assertEquals(1, f.opens)
    assertEquals(4, f.bytesRead)
  }

  @Test
  fun `parent link redirected after authorization cannot make matching outside stats readable`() {
    val f = Fixture()
    f.onStamp = { count ->
      if (count == 1) {
        // Initial canonical/allowed path was /owned/song. Both the later
        // path stat and opened FD now name the same outside inode, so stat
        // equality alone would falsely accept this read.
        f.replaceStamp(f.pathStamp.copy(inode = 900))
        f.descriptorPath = "/outside/song"
      }
    }
    assertNull(f.cache.identity("/owned/song") { it.startsWith("/owned/") })
    assertEquals(1, f.opens)
    assertEquals(1, f.closes)
    assertEquals(0, f.bytesRead)
  }

  @Test
  fun `unavailable descriptor path is refused and closed before reading`() {
    val f = Fixture()
    f.failDescriptorPath = true
    assertNull(f.cache.identity("song"))
    assertEquals(1, f.closes)
    assertEquals(0, f.bytesRead)
    f.failDescriptorPath = false
    assertNotNull(f.cache.identity("song"))
    assertEquals(2, f.opens)
  }

  @Test
  fun `same-size replacement with exact restored mtime invalidates on ctime nanoseconds`() {
    val f = Fixture()
    val first = f.cache.identity("song")!!
    f.bytes = "bbbb".toByteArray()
    f.replaceStamp(f.pathStamp.copy(changedNanoseconds = f.pathStamp.changedNanoseconds + 1))
    val next = f.cache.identity("song")!!
    assertEquals(first.stamp.size, next.stamp.size)
    assertEquals(first.stamp.modifiedSeconds, next.stamp.modifiedSeconds)
    assertEquals(first.stamp.modifiedNanoseconds, next.stamp.modifiedNanoseconds)
    assertEquals(first.stamp.changedSeconds, next.stamp.changedSeconds)
    assertNotEquals(first.md5, next.md5)
    assertEquals(2, f.opens)
    assertEquals(8, f.bytesRead)
  }

  @Test
  fun `inode device size and mtime nanoseconds are all part of identity`() {
    for (changed in listOf<(FolderFileStamp) -> FolderFileStamp>(
      { it.copy(inode = it.inode + 1) },
      { it.copy(device = it.device + 1) },
      { it.copy(size = 5) },
      { it.copy(modifiedNanoseconds = it.modifiedNanoseconds + 1) }
    )) {
      val f = Fixture()
      assertNotNull(f.cache.identity("song"))
      f.replaceStamp(changed(f.pathStamp))
      if (f.pathStamp.size == 5L) f.bytes = "aaaaa".toByteArray()
      assertNotNull(f.cache.identity("song"))
      assertEquals(2, f.opens)
    }
  }

  @Test
  fun `a replacement between path stat and open is never published`() {
    val f = Fixture()
    f.descriptorStamp = f.pathStamp.copy(inode = 99)
    assertNull(f.cache.identity("song"))
    assertEquals(0, f.bytesRead)
    assertEquals(1, f.closes)
    f.descriptorStamp = f.pathStamp
    assertNotNull(f.cache.identity("song"))
    assertEquals(2, f.opens)
  }

  @Test
  fun `a cached hit whose path changes during lookup is refused without reading stale bytes`() {
    val f = Fixture()
    assertNotNull(f.cache.identity("song"))
    f.onStamp = { count ->
      if (count == 4) f.pathStamp = f.pathStamp.copy(inode = 99)
    }
    assertNull(f.cache.identity("song"))
    assertEquals(1, f.opens)
    assertEquals(4, f.bytesRead)
    f.descriptorStamp = f.pathStamp
    assertNotNull(f.cache.identity("song"))
    assertEquals(2, f.opens)
  }

  @Test
  fun `descriptor mutation or path replacement during reading is rejected and retry hashes again`() {
    for (descriptorChanged in listOf(true, false)) {
      val f = Fixture()
      f.onRead = {
        f.pathStamp = f.pathStamp.copy(changedNanoseconds = f.pathStamp.changedNanoseconds + 1)
        if (descriptorChanged) f.descriptorStamp = f.pathStamp
      }
      assertNull(f.cache.identity("song"))
      assertEquals(1, f.closes)
      f.descriptorStamp = f.pathStamp
      assertNotNull(f.cache.identity("song"))
      assertEquals(2, f.opens)
      assertEquals(8, f.bytesRead)
    }
  }

  @Test
  fun `read errors and short reads cannot finalize or remember partial digests`() {
    val f = Fixture()
    f.chunkSize = 2
    f.failAfterBytes = 2
    assertNull(f.cache.identity("song"))
    assertEquals(2, f.bytesRead)
    assertEquals(1, f.closes)
    f.failAfterBytes = null
    assertEquals("74b87337454200d4d33f80c4663dc5e5", f.cache.identity("song")?.md5)
    assertEquals(6, f.bytesRead)
    assertEquals(2, f.opens)

    val short = Fixture()
    short.bytes = "aaa".toByteArray()
    assertNull(short.cache.identity("song"))
    short.bytes = "aaaa".toByteArray()
    assertNotNull(short.cache.identity("song"))
    assertEquals(2, short.opens)
  }

  @Test
  fun `stat or open failure does not preserve a stale entry`() {
    val f = Fixture()
    assertNotNull(f.cache.identity("song"))
    f.failStat = true
    assertNull(f.cache.identity("song"))
    f.failStat = false
    assertNotNull(f.cache.identity("song"))
    assertEquals(2, f.opens)
    f.replaceStamp(f.pathStamp.copy(inode = 9))
    f.failOpen = true
    assertNull(f.cache.identity("song"))
    f.failOpen = false
    assertNotNull(f.cache.identity("song"))
    assertEquals(3, f.opens)
  }

  @Test
  fun `invalid subsecond stamps and zero-length reads fail closed`() {
    val f = Fixture()
    f.replaceStamp(f.pathStamp.copy(changedNanoseconds = 1_000_000_000))
    assertNull(f.cache.identity("song"))
    assertEquals(0, f.opens)
    val zero = Fixture()
    zero.chunkSize = 0
    assertNull(zero.cache.identity("song"))
    assertEquals(1, zero.closes)
  }

  @Test
  fun `process memo retains at most 128 most recently used paths`() {
    val f = Fixture()
    repeat(128) { assertNotNull(f.cache.identity("song-$it")) }
    assertEquals(128, f.opens)
    assertNotNull(f.cache.identity("song-0"))
    assertNotNull(f.cache.identity("song-128"))
    assertNotNull(f.cache.identity("song-0"))
    assertEquals(129, f.opens)
    assertNotNull(f.cache.identity("song-1"))
    assertEquals(130, f.opens)
  }

  @Test
  fun `concurrent currency and identity share one descriptor hash`() {
    val f = Fixture()
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    f.onRead = { entered.countDown(); check(release.await(3, TimeUnit.SECONDS)) }
    val results = arrayOfNulls<FolderFileIdentity>(2)
    val first = Thread { results[0] = f.cache.identity("song") }
    val second = Thread { results[1] = f.cache.identity("song") }
    first.start()
    try {
      assertTrue(entered.await(3, TimeUnit.SECONDS))
      second.start()
    } finally {
      release.countDown()
      first.join(3000)
      second.join(3000)
    }
    assertFalse(first.isAlive)
    assertFalse(second.isAlive)
    assertNotNull(results[0])
    assertEquals(results[0], results[1])
    assertEquals(1, f.opens)
    assertEquals(4, f.bytesRead)
  }

  @Test
  fun `opaque source is freshly compared while validated destination identity is reused`() {
    val directory = createTempDir(prefix = "singz-opaque-comparison")
    try {
      val destination = File(directory, "cached.flac")
      destination.writeText("aaaa")
      val f = Fixture()
      var sourceBytes = "aaaa".toByteArray()
      var sourceOpens = 0
      fun compare() = FolderMaterialization.sameContent(
        { sourceOpens++; ByteArrayInputStream(sourceBytes) }, destination,
        { f.cache.identity("song")?.md5 }
      )
      assertTrue(compare())
      assertNotNull(f.cache.identity("song"))
      assertTrue(compare())
      sourceBytes = "bbbb".toByteArray()
      assertFalse(compare())
      assertEquals(3, sourceOpens)
      assertEquals(1, f.opens)
      assertEquals(4, f.bytesRead)
    } finally {
      directory.deleteRecursively()
    }
  }
}
