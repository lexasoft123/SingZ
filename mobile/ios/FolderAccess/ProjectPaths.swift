import Foundation

/**
 * The phone writer's name and path rules, apart from file handling so they
 * can be held to the shared table (tests/shared/project-name-cases.json)
 * without a simulator or Pods — the CacheCurrency pattern. FolderAccess is the
 * only production caller; Kotlin's ProjectPaths carries the same rules, and
 * both mirror the desktop's safeName in src/main/projects.ts.
 *
 *   mobile/scripts/test-swift-project-paths.sh
 */
enum ProjectPaths {
  /** Desktop projects.ts safeName, mirrored: same strip, same fallback. */
  static func safeName(_ name: String) -> String {
    var s = name.replacingOccurrences(
      of: "\\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aif|aiff)$",
      with: "", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "[/\\\\:*?\"<>|]", with: " ", options: .regularExpression)
    s = s.replacingOccurrences(of: "\\s{2,}", with: " ", options: .regularExpression)
    // No leading dot: listProjects skipped hidden folders, so a song added
    // as "...Baby One More Time" landed in a folder the library never showed
    // (a picked folder still skips them). Dots and spaces in one pass; ICU's
    // \s covers all that .whitespaces trims below, so the trim cannot
    // uncover a dot.
    s = s.replacingOccurrences(of: "^[\\s.]+", with: "", options: .regularExpression)
    s = s.trimmingCharacters(in: .whitespaces)
    return s.isEmpty ? "Untitled song" : s
  }

  /** Relative file path inside a project — subdirs fine, escapes are not. */
  static func relOk(_ file: String) -> Bool {
    guard !file.isEmpty, !file.hasPrefix("/") else { return false }
    return file.split(separator: "/", omittingEmptySubsequences: false)
      .allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
  }

  /** A project dir must be a plain child of its root — never a path. */
  static func plainChild(_ project: String) -> Bool {
    !project.isEmpty && !project.contains("/") && project != ".." && project != "."
  }
}
