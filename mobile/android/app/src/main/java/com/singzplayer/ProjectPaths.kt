package com.singzplayer

/**
 * The phone writer's name and path rules, apart from file handling so a JVM
 * test can hold them to the shared table (tests/shared/project-name-cases.json)
 * without an emulator — the CacheCurrency pattern. FolderAccessModule is the
 * only production caller; the Swift module mirrors the same rules.
 */
object ProjectPaths {

  /** Desktop projects.ts safeName, mirrored: same strip, same fallback. */
  fun safeName(name: String): String {
    val cleaned = name
      .replace(Regex("\\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aif|aiff)$", RegexOption.IGNORE_CASE), "")
      .replace(Regex("[/\\\\:*?\"<>|]"), " ")
      .replace(Regex("\\s{2,}"), " ")
      .trim()
    return cleaned.ifEmpty { "Untitled song" }
  }

  /** Relative file path inside a project — subdirs fine, escapes are not. */
  fun relOk(file: String): Boolean =
    file.isNotEmpty() && !file.startsWith("/") &&
      file.split('/').none { it.isEmpty() || it == "." || it == ".." }

  /** A project dir must be a plain child of its root — never a path. */
  fun plainChild(project: String): Boolean =
    project.isNotEmpty() && !project.contains("/") && project != ".." && project != "."
}
