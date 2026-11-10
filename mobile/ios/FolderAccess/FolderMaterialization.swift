import CryptoKit
import Darwin
import Foundation

/** Never truncate filesystem timestamps: restoring mtime still changes ctime. */
struct SingzFileStamp: Equatable {
  let device: UInt64
  let inode: UInt64
  let size: Int64
  let mtimeSeconds: Int64
  let mtimeNanoseconds: Int64
  let ctimeSeconds: Int64
  let ctimeNanoseconds: Int64

  init(_ value: stat) {
    device = UInt64(bitPattern: Int64(value.st_dev))
    inode = UInt64(value.st_ino)
    size = value.st_size
    mtimeSeconds = Int64(value.st_mtimespec.tv_sec)
    mtimeNanoseconds = Int64(value.st_mtimespec.tv_nsec)
    ctimeSeconds = Int64(value.st_ctimespec.tv_sec)
    ctimeNanoseconds = Int64(value.st_ctimespec.tv_nsec)
  }

  init(device: UInt64 = 1, inode: UInt64 = 1, size: Int64,
       mtimeSeconds: Int64 = 1, mtimeNanoseconds: Int64 = 0,
       ctimeSeconds: Int64 = 1, ctimeNanoseconds: Int64 = 0) {
    self.device = device; self.inode = inode; self.size = size
    self.mtimeSeconds = mtimeSeconds; self.mtimeNanoseconds = mtimeNanoseconds
    self.ctimeSeconds = ctimeSeconds; self.ctimeNanoseconds = ctimeNanoseconds
  }
}

struct SingzContentIdentity {
  let stamp: SingzFileStamp
  let md5: String
}

protocol SingzIdentityReader {
  func stamp() throws -> SingzFileStamp
  func read() throws -> Data
  func close()
}

private enum SingzIdentityError: Error { case changed, unreadable }

private final class SingzDiskIdentityReader: SingzIdentityReader {
  private let handle: FileHandle
  init(_ url: URL) throws {
    let fd = Darwin.open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard fd >= 0 else { throw SingzIdentityError.unreadable }
    handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    // F_GETPATH identifies the actual opened file, even if a parent symlink
    // changed between canonicalization and open. Never hash a different target.
    var bytes = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    guard fcntl(fd, F_GETPATH, &bytes) == 0,
      URL(fileURLWithPath: String(cString: bytes)).standardizedFileURL
        .resolvingSymlinksInPath().path == url.path else {
      try? handle.close()
      throw SingzIdentityError.changed
    }
  }
  func stamp() throws -> SingzFileStamp {
    var info = stat()
    guard fstat(handle.fileDescriptor, &info) == 0,
      info.st_mode & S_IFMT == S_IFREG else { throw SingzIdentityError.unreadable }
    return SingzFileStamp(info)
  }
  func read() throws -> Data { try handle.read(upToCount: 1 << 16) ?? Data() }
  func close() { try? handle.close() }
}

/** Process-local, bounded identity reuse. One lock covers lookup/read/publication:
 * concurrent currency and waveform requests cannot duplicate a full-file read.
 * Nothing from the older persistent size+mtime memo is admitted here. */
final class SingzContentIdentityStore {
  static let shared = SingzContentIdentityStore()
  private let lock = NSLock()
  private let capacity: Int
  private let openReader: (URL) throws -> SingzIdentityReader
  private let pathStamp: (URL) throws -> SingzFileStamp
  private var entries: [String: SingzContentIdentity] = [:]
  private var oldestFirst: [String] = []

  init(capacity: Int = 128,
       openReader: @escaping (URL) throws -> SingzIdentityReader = { try SingzDiskIdentityReader($0) },
       pathStamp: @escaping (URL) throws -> SingzFileStamp = { url in
         var info = stat()
         guard Darwin.lstat(url.path, &info) == 0,
           info.st_mode & S_IFMT == S_IFREG else { throw SingzIdentityError.unreadable }
         return SingzFileStamp(info)
       }) {
    self.capacity = max(1, capacity)
    self.openReader = openReader; self.pathStamp = pathStamp
  }

  func identity(_ url: URL, authorized: (String) -> Bool = { _ in true }) -> SingzContentIdentity? {
    lock.lock(); defer { lock.unlock() }
    let canonical = url.standardizedFileURL.resolvingSymlinksInPath()
    let key = canonical.path
    // Authorization belongs to this exact resolution, not a caller's earlier
    // path snapshot. F_GETPATH then guards a later redirect during open.
    guard authorized(key) else { return nil }
    do {
      let reader = try openReader(canonical)
      defer { reader.close() }
      let before = try reader.stamp()
      guard try pathStamp(canonical) == before else { throw SingzIdentityError.changed }
      if let kept = entries[key], kept.stamp == before {
        guard try reader.stamp() == before,
          try pathStamp(canonical) == before else { throw SingzIdentityError.changed }
        touch(key)
        return kept
      }
      entries.removeValue(forKey: key)
      oldestFirst.removeAll { $0 == key }
      var digest = Insecure.MD5()
      var bytesRead: Int64 = 0
      while true {
        let chunk = try reader.read()
        if chunk.isEmpty { break }
        bytesRead += Int64(chunk.count)
        digest.update(data: chunk)
      }
      guard bytesRead == before.size,
        try reader.stamp() == before,
        try pathStamp(canonical) == before else { throw SingzIdentityError.changed }
      let identity = SingzContentIdentity(stamp: before,
        md5: digest.finalize().map { String(format: "%02x", $0) }.joined())
      entries[key] = identity
      touch(key)
      while oldestFirst.count > capacity {
        entries.removeValue(forKey: oldestFirst.removeFirst())
      }
      return identity
    } catch {
      entries.removeValue(forKey: key)
      oldestFirst.removeAll { $0 == key }
      return nil
    }
  }

  private func touch(_ key: String) {
    oldestFirst.removeAll { $0 == key }
    oldestFirst.append(key)
  }
}

/** Source streams may be provider-backed: always read source bytes fresh. */
func SingzFolderContentMd5(_ url: URL) -> String? {
  // A new store deliberately has no source memo. It still rejects a source
  // changed during the read, a replaced path, and partial/read-error digests.
  SingzContentIdentityStore(capacity: 1).identity(url)?.md5
}

func SingzFolderContentMatches(_ source: URL, _ destination: URL,
                               identities: SingzContentIdentityStore = .shared) -> Bool {
  guard let destinationIdentity = identities.identity(destination),
    let sourceSize = (try? FileManager.default.attributesOfItem(atPath: source.path)[.size] as? NSNumber)?.int64Value,
    sourceSize == destinationIdentity.stamp.size,
    let sourceMd5 = SingzFolderContentMd5(source) else { return false }
  return sourceMd5 == destinationIdentity.md5
}
