import CryptoKit
import Foundation

/** Fresh, chunked content identity for folder copies. No document hash or
 * size+mtime memo participates in this answer. */
func SingzFolderContentMd5(_ url: URL) -> String? {
  do {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var md5 = Insecure.MD5()
    while true {
      let chunk = try handle.read(upToCount: 1 << 16)
      guard let chunk, !chunk.isEmpty else { break }
      md5.update(data: chunk)
    }
    return md5.finalize().map { String(format: "%02x", $0) }.joined()
  } catch {
    return nil
  }
}

func SingzFolderContentMatches(_ source: URL, _ destination: URL) -> Bool {
  let fm = FileManager.default
  guard fm.fileExists(atPath: source.path), fm.fileExists(atPath: destination.path),
    let sourceAttrs = try? fm.attributesOfItem(atPath: source.path),
    let destinationAttrs = try? fm.attributesOfItem(atPath: destination.path),
    let sourceSize = (sourceAttrs[.size] as? NSNumber)?.int64Value,
    let destinationSize = (destinationAttrs[.size] as? NSNumber)?.int64Value,
    sourceSize == destinationSize,
    let sourceMd5 = SingzFolderContentMd5(source),
    let destinationMd5 = SingzFolderContentMd5(destination)
  else { return false }
  return sourceMd5 == destinationMd5
}
