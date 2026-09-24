package com.singzplayer

/**
 * The phone writer's name and path rules, apart from file handling so a JVM
 * test can hold them to the shared table (tests/shared/project-name-cases.json)
 * without an emulator — the CacheCurrency pattern. FolderAccessModule is the
 * only production caller; ProjectPaths.swift mirrors the same rules, held to
 * the same table by mobile/scripts/test-swift-project-paths.sh.
 */
object ProjectPaths {

  /** Desktop projects.ts safeName, mirrored: same strip, same fallback. */
  fun safeName(name: String): String {
    val cleaned = name
      .replace(Regex("\\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aif|aiff)$", RegexOption.IGNORE_CASE), "")
      .replace(Regex("[/\\\\:*?\"<>|]"), " ")
      .replace(Regex("\\s{2,}"), " ")
      // No leading dot: iOS listed the library without hidden entries, so a
      // folder named ".hack" never appeared there (see projects.ts). Dots go
      // with everything trim() takes, in one pass — Java's \s is ASCII-only,
      // and a regex would let trim() uncover a dot behind a no-break space.
      .trimStart { it == '.' || it.isWhitespace() }
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
