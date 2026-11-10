package com.singzplayer

import java.io.File
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest

/** Identity of one regular file, including changes hidden by restored mtime. */
data class FolderFileStamp(
  val device: Long,
  val inode: Long,
  val size: Long,
  val modifiedSeconds: Long,
  val modifiedNanoseconds: Long,
  val changedSeconds: Long,
  val changedNanoseconds: Long
) {
  fun valid(): Boolean = size >= 0 && modifiedNanoseconds in 0..999_999_999L &&
    changedNanoseconds in 0..999_999_999L
}

data class FolderFileIdentity(val path: String, val stamp: FolderFileStamp, val md5: String)

/** An input and its stat must describe the SAME opened descriptor. */
interface FolderIdentityReader : Closeable {
  val input: InputStream
  fun stamp(): FolderFileStamp?
  fun canonicalPath(): String?
  override fun close() = input.close()
}

/** Process-local only: weak persisted size+mtime memos cannot prove identity.
 * Injectable boundaries keep the currency/identity contract testable on the JVM.
 * The monitor also coalesces concurrent requests into one successful hash. */
class FolderIdentityCache(
  private val stampPath: (String) -> FolderFileStamp?,
  private val openFile: (String) -> FolderIdentityReader,
  private val canonicalize: (String) -> String = { File(it).canonicalPath },
  private val maximumEntries: Int = 128
) {
  init { require(maximumEntries > 0) }
  private val entries = LinkedHashMap<String, FolderFileIdentity>(16, 0.75f, true)

  @Synchronized
  fun identity(path: String, isAllowed: (String) -> Boolean = { true }): FolderFileIdentity? {
    var canonical: String? = null
    try {
      val key = canonicalize(path)
      // Public fileIdentity callers must re-check the final canonical target,
      // even when their earlier allowlist check already resolved this path.
      if (!isAllowed(key)) return null
      canonical = key
      val before = stampPath(key)?.takeIf { it.valid() }
      if (before == null) {
        entries.remove(key)
        return null
      }
      val cached = entries[key]
      if (cached?.stamp == before) {
        if (stampPath(key) == before) return cached
        entries.remove(key)
        return null
      }
      entries.remove(key)
      val identity = openFile(key).use { reader ->
        val opened = reader.stamp()?.takeIf { it.valid() } ?: return null
        if (opened != before) return null
        // Path stats can both follow an attacker-replaced parent link. Check
        // the opened descriptor's own path before consuming ANY file bytes.
        val descriptorPath = reader.canonicalPath()?.let(canonicalize) ?: return null
        if (descriptorPath != key || !isAllowed(descriptorPath)) return null
        val digest = MessageDigest.getInstance("MD5")
        val buffer = ByteArray(1 shl 16)
        var bytes = 0L
        while (true) {
          val count = reader.input.read(buffer)
          if (count < 0) break
          if (count == 0 || bytes > opened.size - count) return null
          digest.update(buffer, 0, count)
          bytes += count
        }
        if (bytes != opened.size || reader.stamp() != opened || stampPath(key) != opened) return null
        FolderFileIdentity(key, opened, digest.digest().toMd5Hex())
      }
      entries[key] = identity
      while (entries.size > maximumEntries) {
        val iterator = entries.entries.iterator()
        iterator.next()
        iterator.remove()
      }
      return identity
    } catch (_: Exception) {
      if (canonical != null) entries.remove(canonical)
      return null
    }
  }
}

private fun ByteArray.toMd5Hex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }

/** Fresh content comparison for SAF/folder materialization. */
object FolderMaterialization {
  fun md5(file: File): String? = try {
    digest(file.inputStream())
  } catch (_: Exception) {
    null
  }

  fun md5(input: InputStream): String? = try {
    digest(input)
  } catch (_: Exception) {
    null
  }

  fun sameContent(
    openSource: () -> InputStream,
    destination: File,
    destinationMd5: (File) -> String? = ::md5
  ): Boolean {
    if (!destination.isFile) return false
    val sourceMd5 = try {
      md5(openSource())
    } catch (_: Exception) {
      null
    } ?: return false
    val knownDestination = destinationMd5(destination) ?: return false
    return sourceMd5 == knownDestination
  }

  private fun digest(input: InputStream): String {
    val digest = MessageDigest.getInstance("MD5")
    input.use { stream ->
      val buffer = ByteArray(1 shl 16)
      while (true) {
        val count = stream.read(buffer)
        if (count < 0) break
        if (count == 0) throw IOException("The file returned no bytes before EOF")
        digest.update(buffer, 0, count)
      }
    }
    return digest.digest().toMd5Hex()
  }
}
