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



// An injected reader makes byte work and mutation windows observable without
// a timing assertion that can pass while the implementation still rehashes.
final class FakeIdentityFile {
  var stamp = SingzFileStamp(size: 8, ctimeNanoseconds: 100)
  var bytes = Data([1, 2, 3, 4, 5, 6, 7, 8])
  var bytesRead = 0
  var readFailure = false
  var duringRead: (() -> Void)?
}
enum FakeReadError: Error { case failed }
final class FakeIdentityReader: SingzIdentityReader {
  let file: FakeIdentityFile
  var sent = false
  init(_ file: FakeIdentityFile) { self.file = file }
  func stamp() throws -> SingzFileStamp { file.stamp }
  func read() throws -> Data {
    if sent {
      if file.readFailure { throw FakeReadError.failed }
      return Data()
    }
    sent = true
    let bytes = file.bytes
    file.bytesRead += bytes.count
    file.duringRead?()
    return bytes
  }
  func close() {}
}
func fakeStore(_ file: FakeIdentityFile, capacity: Int = 128,
               pathStamp: (() -> SingzFileStamp)? = nil) -> SingzContentIdentityStore {
  SingzContentIdentityStore(capacity: capacity,
    openReader: { _ in FakeIdentityReader(file) },
    pathStamp: { _ in pathStamp?() ?? file.stamp })
}
let fake = FakeIdentityFile()
let memo = fakeStore(fake)
let fakeURL = root.appendingPathComponent("fake-owned.wav")
let currency = memo.identity(fakeURL)
let waveform = memo.identity(fakeURL)
check(currency?.md5 == "0ee0646c1c77d8131cc8f4ee65c7673b" && waveform?.md5 == currency?.md5,
      "currency and waveform identity share the actual bytes' MD5")
check(fake.bytesRead == 8, "currency followed by waveform hashes once, repeat reads zero bytes")
fake.stamp = SingzFileStamp(size: 8, ctimeNanoseconds: 101)
fake.bytes = Data([8, 7, 6, 5, 4, 3, 2, 1])
let changed = memo.identity(fakeURL)
check(changed?.md5 != currency?.md5 && fake.bytesRead == 16,
      "ctime change of one nanosecond within the same second invalidates restored mtime")

let unstable = FakeIdentityFile()
unstable.duringRead = { unstable.stamp = SingzFileStamp(size: 8, ctimeNanoseconds: 101) }
let unstableMemo = fakeStore(unstable)
check(unstableMemo.identity(fakeURL) == nil, "mutation during hashing fails closed")
unstable.duringRead = nil
check(unstableMemo.identity(fakeURL) != nil && unstable.bytesRead == 16,
      "mutated digest was not published or cached")

let failing = FakeIdentityFile()
failing.readFailure = true
let failingMemo = fakeStore(failing)
check(failingMemo.identity(fakeURL) == nil, "read error after partial bytes cannot finalize a digest")
failing.readFailure = false
check(failingMemo.identity(fakeURL) != nil && failing.bytesRead == 16,
      "a partial digest is not cached after a read failure")

let replacing = FakeIdentityFile()
var replacementPath = replacing.stamp
replacing.duringRead = { replacementPath = SingzFileStamp(inode: 2, size: 8, ctimeNanoseconds: 100) }
let replacingMemo = fakeStore(replacing, pathStamp: { replacementPath })
check(replacingMemo.identity(fakeURL) == nil, "path replacement while descriptor stays unchanged fails closed")

let lruFile = FakeIdentityFile()
let lru = fakeStore(lruFile, capacity: 2)
let a = root.appendingPathComponent("a"), b = root.appendingPathComponent("b"), c = root.appendingPathComponent("c")
_ = lru.identity(a); _ = lru.identity(b); _ = lru.identity(a); _ = lru.identity(c)
check(lruFile.bytesRead == 24, "LRU touch reuses an entry without reading bytes")
_ = lru.identity(b)
check(lruFile.bytesRead == 32, "bounded LRU evicts the least recently used identity")

let concurrent = FakeIdentityFile()
let concurrentMemo = fakeStore(concurrent)
DispatchQueue.concurrentPerform(iterations: 12) { _ in _ = concurrentMemo.identity(fakeURL) }
check(concurrent.bytesRead == 8, "concurrent identity callers share a single hash")

let diskMemo = SingzContentIdentityStore()
let diskBefore = diskMemo.identity(source)
let savedMtime = try fm.attributesOfItem(atPath: source.path)[.modificationDate] as! Date
try original.write(to: source, options: .atomic)
try fm.setAttributes([.modificationDate: savedMtime], ofItemAtPath: source.path)
let diskAfter = diskMemo.identity(source)
check(diskBefore?.md5 != diskAfter?.md5, "real atomic replacement at same size/restored mtime invalidates")
let link = root.appendingPathComponent("identity-link")
try fm.createSymbolicLink(at: link, withDestinationURL: source)
check(diskMemo.identity(link)?.md5 == diskAfter?.md5, "canonical aliases identify the same actual file")



let inPlace = try FileHandle(forWritingTo: source)
try inPlace.write(contentsOf: Data([8, 7, 6, 5, 4, 3, 2, 1]))
try inPlace.close()
try fm.setAttributes([.modificationDate: savedMtime], ofItemAtPath: source.path)
let inPlaceAfter = diskMemo.identity(source)
check(inPlaceAfter?.stamp.inode == diskAfter?.stamp.inode && inPlaceAfter?.md5 != diskAfter?.md5,
      "real in-place overwrite at same inode/size/restored mtime invalidates")

let destinationFake = FakeIdentityFile()
destinationFake.bytes = Data([8, 7, 6, 5, 4, 3, 2, 1])
let destinationMemo = fakeStore(destinationFake)
check(SingzFolderContentMatches(source, cached, identities: destinationMemo),
      "picked-source comparison accepts the validated destination identity")
_ = destinationMemo.identity(cached)
check(destinationFake.bytesRead == 8,
      "picked comparison followed by file identity does not reread destination bytes")
try original.write(to: source)
try fm.setAttributes([.modificationDate: savedMtime], ofItemAtPath: source.path)
check(!SingzFolderContentMatches(source, cached, identities: destinationMemo),
      "picked-source bytes are still read fresh despite cached destination identity")



// Model a caller authorizing an old canonical path, then the path being
// replaced by a symlink before identity resolves it again. The store must
// authorize its own resolution before opening or reading anything.
let approved = root.appendingPathComponent("approved", isDirectory: true)
let outside = root.appendingPathComponent("outside", isDirectory: true)
try fm.createDirectory(at: approved, withIntermediateDirectories: true)
try fm.createDirectory(at: outside, withIntermediateDirectories: true)
let boundaryPath = approved.appendingPathComponent("audio.wav")
let outsidePath = outside.appendingPathComponent("secret.wav")
try original.write(to: boundaryPath); try original.write(to: outsidePath)
let formerlyApproved = boundaryPath.standardizedFileURL.resolvingSymlinksInPath()
try fm.removeItem(at: boundaryPath)
try fm.createSymbolicLink(at: boundaryPath, withDestinationURL: outsidePath)
var boundaryOpens = 0
let boundaryStore = SingzContentIdentityStore(openReader: { _ in
  boundaryOpens += 1
  return FakeIdentityReader(FakeIdentityFile())
}, pathStamp: { _ in SingzFileStamp(size: 8) })
let rejected = boundaryStore.identity(formerlyApproved, authorized: { $0.hasPrefix(approved.path + "/") })
check(rejected == nil && boundaryOpens == 0,
      "redirect after caller authorization is rejected before outside file is opened")

exit(failures == 0 ? 0 : 1)
