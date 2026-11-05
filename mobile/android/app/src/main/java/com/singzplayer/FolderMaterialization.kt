package com.singzplayer

import java.io.File
import java.io.InputStream
import java.security.MessageDigest

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

  fun sameContent(openSource: () -> InputStream, destination: File): Boolean {
    if (!destination.isFile) return false
    val sourceMd5 = try {
      openSource().use { md5(it) }
    } catch (_: Exception) {
      null
    } ?: return false
    val destinationMd5 = md5(destination) ?: return false
    return sourceMd5 == destinationMd5
  }

  private fun digest(input: InputStream): String {
    val digest = MessageDigest.getInstance("MD5")
    input.use { stream ->
      val buffer = ByteArray(1 shl 16)
      while (true) {
        val count = stream.read(buffer)
        if (count <= 0) break
        digest.update(buffer, 0, count)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }
}
