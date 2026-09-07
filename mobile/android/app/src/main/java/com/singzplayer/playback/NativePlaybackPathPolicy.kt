package com.singzplayer.playback

import java.io.File

/** Descriptor authorization's Kotlin preflight. JNI repeats this check after
 * opening with O_NOFOLLOW, using the descriptor's /proc/self/fd target. */
object NativePlaybackPathPolicy {
  fun canonicalRoots(roots: Iterable<File>): List<String> = roots
    .mapNotNull { runCatching { it.canonicalFile.absolutePath }.getOrNull() }
    .distinct()

  fun authorize(path: String, canonicalRoots: List<String>): String {
    require(path.isNotEmpty() && '\u0000' !in path) { "A playback lane path is empty" }
    val candidate = File(path).canonicalFile
    require(candidate.isFile) { "A playback lane could not be opened" }
    require(canonicalRoots.any { inside(candidate.absolutePath, it) }) {
      "The playback lane is outside the app's authorized local roots"
    }
    return candidate.absolutePath
  }

  fun inside(path: String, root: String): Boolean {
    if (path == root || path.length <= root.length || !path.startsWith(root)) return false
    return root.endsWith(File.separator) || path[root.length] == File.separatorChar
  }
}
