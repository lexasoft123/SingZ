import Foundation

var failures = 0
func check(_ condition: Bool, _ message: String) {
  print("\(condition ? "ok" : "FAIL"): \(message)")
  if !condition { failures += 1 }
}

let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
defer { try? fm.removeItem(at: root) }
try fm.createDirectory(at: root, withIntermediateDirectories: true)
let source = root.appendingPathComponent("source.flac")
let cached = root.appendingPathComponent("cached.flac")
let original = Data([1, 2, 3, 4, 5, 6, 7, 8])
try original.write(to: source)
try original.write(to: cached)
let restored = Date(timeIntervalSince1970: 1_700_000_000)
try fm.setAttributes([.modificationDate: restored], ofItemAtPath: source.path)
try fm.setAttributes([.modificationDate: restored], ofItemAtPath: cached.path)
check(SingzFolderContentMatches(source, cached), "identical equal-size bytes avoid recopy")

// Negative control: size and mtime still match exactly. A size-only or
// size+mtime-only cache accepts the old destination here and plays stale audio.
try Data([8, 7, 6, 5, 4, 3, 2, 1]).write(to: source)
try fm.setAttributes([.modificationDate: restored], ofItemAtPath: source.path)
try fm.setAttributes([.modificationDate: restored], ofItemAtPath: cached.path)
let sourceSize = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize
let cachedSize = try cached.resourceValues(forKeys: [.fileSizeKey]).fileSize
check(sourceSize == cachedSize, "fixture keeps the replacement at the same size")
check(!SingzFolderContentMatches(source, cached),
      "same-size replacement with restored mtime is detected from content")

exit(failures == 0 ? 0 : 1)
