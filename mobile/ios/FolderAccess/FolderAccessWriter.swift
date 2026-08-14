import AVFoundation
import Foundation
import UIKit
import UniformTypeIdentifiers

/**
 * Phone-created projects (Phase 1, docs/PHONE-STANDALONE.md): the writer half
 * of FolderAccess, mirroring the Android module's JS surface exactly. Writers
 * operate ONLY under the Documents folder — the "This phone" library the
 * listing already walks. Every write is .part+rename; every path is guarded
 * the way cacheDirFor guards cache names.
 */
extension FolderAccess {

  private var fm: FileManager { FileManager.default }

  /** A project's folder under the documents root, or nil on a bad name. */
  private func docDirFor(_ project: String) -> URL? {
    guard !project.isEmpty, !project.contains("/"), project != "..", project != "." else {
      return nil
    }
    return documentsURL().appendingPathComponent(project, isDirectory: true)
  }

  /** Relative file path inside a project — subdirs fine, escapes are not. */
  private func relOk(_ file: String) -> Bool {
    guard !file.isEmpty, !file.hasPrefix("/") else { return false }
    return file.split(separator: "/", omittingEmptySubsequences: false)
      .allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
  }

  /** Desktop projects.ts safeName, mirrored: same strip, same fallback. */
  private func safeName(_ name: String) -> String {
    var s = name.replacingOccurrences(
      of: "\\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aif|aiff)$",
      with: "", options: [.regularExpression, .caseInsensitive])
    s = s.replacingOccurrences(of: "[/\\\\:*?\"<>|]", with: " ", options: .regularExpression)
    s = s.replacingOccurrences(of: "\\s{2,}", with: " ", options: .regularExpression)
    s = s.trimmingCharacters(in: .whitespaces)
    return s.isEmpty ? "Untitled song" : s
  }

  /** Atomic install of tmp at out: replace when out exists (a kill mid-write
   *  must never leave the project without the file), plain move otherwise. */
  private func install(_ tmp: URL, at out: URL) throws {
    if fm.fileExists(atPath: out.path) {
      _ = try fm.replaceItemAt(out, withItemAt: tmp)
    } else {
      try fm.moveItem(at: tmp, to: out)
    }
  }

  @objc func ensureProjectDir(
    _ name: NSString,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .utility).async {
      let base = self.safeName(name as String)
      var dir = base
      var n = 2
      while self.fm.fileExists(
        atPath: self.documentsURL()
          .appendingPathComponent(dir).appendingPathComponent("project.json").path
      ) {
        dir = "\(base) \(n)"
        n += 1
      }
      guard let url = self.docDirFor(dir) else {
        reject("mkdir", "Bad project name", nil)
        return
      }
      do {
        try self.fm.createDirectory(at: url, withIntermediateDirectories: true)
        resolve(["dir": dir, "path": url.path])
      } catch {
        reject("mkdir", "Cannot create the project folder", error)
      }
    }
  }

  @objc func writeText(
    _ project: NSString, file: NSString, text: NSString,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .utility).async {
      guard let dir = self.docDirFor(project as String), self.relOk(file as String) else {
        reject("write", "Bad project or file name", nil)
        return
      }
      let out = dir.appendingPathComponent(file as String)
      let tmp = URL(fileURLWithPath: out.path + ".part")
      do {
        try self.fm.createDirectory(
          at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
        try (text as String).write(to: tmp, atomically: false, encoding: .utf8)
        try self.install(tmp, at: out)
        resolve(true)
      } catch {
        reject("write", "Cannot write \(file)", error)
      }
    }
  }

  @objc func moveIntoProject(
    _ project: NSString, relPath: NSString, srcPath: NSString,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .utility).async {
      guard let dir = self.docDirFor(project as String), self.relOk(relPath as String) else {
        reject("move", "Bad project or file name", nil)
        return
      }
      let src = URL(fileURLWithPath: srcPath as String).standardizedFileURL
      let owned = [self.cacheRootURL(), self.documentsURL()].contains {
        src.path.hasPrefix($0.standardizedFileURL.path + "/")
      }
      guard owned, self.fm.fileExists(atPath: src.path) else {
        reject("move", "Not a file this app owns", nil)
        return
      }
      let out = dir.appendingPathComponent(relPath as String)
      do {
        try self.fm.createDirectory(
          at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
        try self.install(src, at: out)
        // a finished add must not strand its imports/<uuid>/ shell
        let parent = src.deletingLastPathComponent()
        if parent.path.hasPrefix(self.cacheRootURL().path + "/imports/"),
          (try? self.fm.contentsOfDirectory(atPath: parent.path))?.isEmpty == true {
          try? self.fm.removeItem(at: parent)
        }
        resolve(out.path)
      } catch {
        reject("move", "Cannot move \(relPath)", error)
      }
    }
  }

  /** Copy (not move) a file this app owns into a project — the add flow
   *  needs the original present twice: song.<ext> and the pre-split lane. */
  @objc func copyIntoProject(
    _ project: NSString, relPath: NSString, srcPath: NSString,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .utility).async {
      guard let dir = self.docDirFor(project as String), self.relOk(relPath as String) else {
        reject("copy", "Bad project or file name", nil)
        return
      }
      let src = URL(fileURLWithPath: srcPath as String).standardizedFileURL
      let owned = [self.cacheRootURL(), self.documentsURL()].contains {
        src.path.hasPrefix($0.standardizedFileURL.path + "/")
      }
      guard owned, self.fm.fileExists(atPath: src.path) else {
        reject("copy", "Not a file this app owns", nil)
        return
      }
      let out = dir.appendingPathComponent(relPath as String)
      let tmp = URL(fileURLWithPath: out.path + ".part")
      do {
        try self.fm.createDirectory(
          at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
        if self.fm.fileExists(atPath: tmp.path) { try self.fm.removeItem(at: tmp) }
        try self.fm.copyItem(at: src, to: tmp)
        try self.install(tmp, at: out)
        resolve(out.path)
      } catch {
        reject("copy", "Cannot copy \(relPath)", error)
      }
    }
  }

  @objc func statFile(
    _ project: NSString, relPath: NSString,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .utility).async {
      guard let dir = self.docDirFor(project as String), self.relOk(relPath as String) else {
        reject("stat", "Bad project or file name", nil)
        return
      }
      let url = dir.appendingPathComponent(relPath as String)
      guard let attrs = try? self.fm.attributesOfItem(atPath: url.path) else {
        reject("stat", "\(relPath) is missing", nil)
        return
      }
      let md5 = self.hashOf(url, attrs)
      guard !md5.isEmpty else {
        reject("stat", "\(relPath) is unreadable", nil)
        return
      }
      let size = (attrs[.size] as? Int64) ?? 0
      let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
      resolve(["md5": md5, "size": Double(size), "mtimeMs": mtime * 1000])
    }
  }

  @objc func deleteProject(
    _ project: NSString,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .utility).async {
      guard let dir = self.docDirFor(project as String) else {
        reject("delete", "Bad project name", nil)
        return
      }
      guard self.fm.fileExists(atPath: dir.appendingPathComponent("project.json").path) else {
        reject("delete", "Not a project folder", nil)
        return
      }
      do {
        try self.fm.removeItem(at: dir)
        // the hash memos describe files that no longer exist
        let prefix = "singz.hash.\(dir.path)/"
        for key in UserDefaults.standard.dictionaryRepresentation().keys
        where key.hasPrefix(prefix) {
          UserDefaults.standard.removeObject(forKey: key)
        }
        resolve(true)
      } catch {
        reject("delete", "Could not delete it", error)
      }
    }
  }

  /** Tags for the add-a-song card: artist/title/album/durationMs, best effort. */
  @objc func readMediaTags(
    _ path: NSString,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .utility).async {
      let asset = AVURLAsset(url: URL(fileURLWithPath: path as String))
      let sem = DispatchSemaphore(value: 0)
      asset.loadValuesAsynchronously(forKeys: ["duration", "commonMetadata"]) {
        sem.signal()
      }
      _ = sem.wait(timeout: .now() + 10)
      var out: [String: Any] = [:]
      for item in asset.commonMetadata {
        guard let key = item.commonKey?.rawValue, let value = item.stringValue else { continue }
        switch key {
        case AVMetadataKey.commonKeyArtist.rawValue: out["artist"] = value
        case AVMetadataKey.commonKeyTitle.rawValue: out["title"] = value
        case AVMetadataKey.commonKeyAlbumName.rawValue: out["album"] = value
        default: break
        }
      }
      let dur = asset.duration
      if dur.isValid && !dur.isIndefinite {
        out["durationMs"] = CMTimeGetSeconds(dur) * 1000
      }
      resolve(out)
    }
  }
}
