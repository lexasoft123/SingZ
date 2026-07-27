import Foundation
import React
import UIKit
import UniformTypeIdentifiers

/**
 * Project-folder access for the SingZ player.
 *
 * The library root is either the app's own Documents folder (file sharing is
 * on, so projects can be dropped in via Finder/Files) or a user-picked folder
 * — typically iCloud Drive/SingZ — held as a security-scoped bookmark.
 * Reads go through NSFileCoordinator and wait for iCloud to materialize
 * dataless items, so evicted stems download on demand.
 */
@objc(FolderAccess)
class FolderAccess: NSObject, UIDocumentPickerDelegate {
  private static let bookmarkKey = "singz.rootBookmark"
  private var pickResolve: RCTPromiseResolveBlock?
  private var rootURL: URL?
  private var rootScoped = false

  @objc static func requiresMainQueueSetup() -> Bool { false }

  private func documentsURL() -> URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
  }

  private func cachesURL() -> URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("singz-projects", isDirectory: true)
  }

  /** Resolve + retain the active root (picked bookmark if present, else Documents). */
  private func activateRoot() -> (url: URL, kind: String, name: String) {
    if let data = UserDefaults.standard.data(forKey: Self.bookmarkKey) {
      var stale = false
      if let url = try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale) {
        if rootURL?.path != url.path {
          if rootScoped { rootURL?.stopAccessingSecurityScopedResource() }
          rootScoped = url.startAccessingSecurityScopedResource()
          rootURL = url
        }
        if stale, let fresh = try? url.bookmarkData() {
          UserDefaults.standard.set(fresh, forKey: Self.bookmarkKey)
        }
        return (url, "picked", url.lastPathComponent)
      }
      UserDefaults.standard.removeObject(forKey: Self.bookmarkKey)
    }
    if rootScoped { rootURL?.stopAccessingSecurityScopedResource(); rootScoped = false }
    rootURL = documentsURL()
    return (rootURL!, "documents", "On My iPhone")
  }

  /** Wait for an iCloud item to be fully local (no-op for regular files). */
  private func ensureDownloaded(_ url: URL, timeout: TimeInterval) throws {
    let keys: Set<URLResourceKey> = [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey]
    guard (try? url.resourceValues(forKeys: keys))?.isUbiquitousItem == true else { return }
    if (try? url.resourceValues(forKeys: keys))?.ubiquitousItemDownloadingStatus == .current {
      return
    }
    try FileManager.default.startDownloadingUbiquitousItem(at: url)
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if (try? url.resourceValues(forKeys: keys))?.ubiquitousItemDownloadingStatus == .current {
        return
      }
      Thread.sleep(forTimeInterval: 0.25)
    }
    throw NSError(
      domain: "SingZ", code: 1,
      userInfo: [NSLocalizedDescriptionKey: "iCloud is still downloading \(url.lastPathComponent)"]
    )
  }

  private func coordinatedRead(_ url: URL) throws -> Data {
    try ensureDownloaded(url, timeout: 120)
    var coordError: NSError?
    var data: Data?
    var readError: Error?
    NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordError) { u in
      do { data = try Data(contentsOf: u) } catch { readError = error }
    }
    if let e = coordError ?? (readError as NSError?) { throw e }
    guard let d = data else {
      throw NSError(
        domain: "SingZ", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "could not read \(url.lastPathComponent)"]
      )
    }
    return d
  }

  /** A file exists either materialized or as an iCloud ".name.icloud" placeholder. */
  private func present(_ dir: URL, _ name: String) -> Bool {
    let fm = FileManager.default
    return fm.fileExists(atPath: dir.appendingPathComponent(name).path)
      || fm.fileExists(atPath: dir.appendingPathComponent(".\(name).icloud").path)
  }

  // MARK: - Exported API

  @objc func pickFolder(
    _ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard let host = RCTPresentedViewController() else {
        reject("no_ui", "no view controller to present from", nil)
        return
      }
      self.pickResolve = resolve
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
      picker.allowsMultipleSelection = false
      picker.delegate = self
      host.present(picker, animated: true)
    }
  }

  func documentPicker(
    _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
  ) {
    defer { pickResolve = nil }
    guard let url = urls.first else {
      pickResolve?(nil)
      return
    }
    let scoped = url.startAccessingSecurityScopedResource()
    if let bookmark = try? url.bookmarkData() {
      UserDefaults.standard.set(bookmark, forKey: Self.bookmarkKey)
    }
    if rootScoped { rootURL?.stopAccessingSecurityScopedResource() }
    rootURL = url
    rootScoped = scoped
    pickResolve?(["kind": "picked", "path": url.path, "name": url.lastPathComponent])
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    pickResolve?(nil)
    pickResolve = nil
  }

  @objc func getRoot(
    _ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    let root = activateRoot()
    resolve(["kind": root.kind, "path": root.url.path, "name": root.name])
  }

  @objc func clearRoot(
    _ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    UserDefaults.standard.removeObject(forKey: Self.bookmarkKey)
    let root = activateRoot()
    resolve(["kind": root.kind, "path": root.url.path, "name": root.name])
  }

  @objc func listProjects(
    _ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    let root = activateRoot().url
    let fm = FileManager.default
    var out: [[String: Any]] = []
    do {
      let entries = try fm.contentsOfDirectory(
        at: root, includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles]
      )
      for dir in entries {
        guard (try? dir.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true,
          present(dir, "project.json")
        else { continue }
        let metaURL = dir.appendingPathComponent("project.json")
        guard let metaData = try? coordinatedRead(metaURL),
          let metaText = String(data: metaData, encoding: .utf8)
        else { continue }
        var stems: [String: String] = [:]
        let stemsDir = dir.appendingPathComponent("stems", isDirectory: true)
        for s in ["vocals", "drums", "bass", "guitar", "piano", "other"] {
          if present(stemsDir, "\(s).flac") {
            stems[s] = "flac"
          } else if present(stemsDir, "\(s).wav") {
            stems[s] = "wav"
          }
        }
        out.append([
          "dir": dir.lastPathComponent,
          "meta": metaText,
          "stems": stems,
          "hasLyrics": present(dir, "lyrics.json"),
        ])
      }
      resolve(out)
    } catch {
      reject("list_failed", error.localizedDescription, error)
    }
  }

  @objc func readText(
    _ project: NSString, file: NSString,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    let url = activateRoot().url
      .appendingPathComponent(project as String, isDirectory: true)
      .appendingPathComponent(file as String)
    do {
      let data = try coordinatedRead(url)
      resolve(String(data: data, encoding: .utf8) ?? "")
    } catch {
      reject("read_failed", "\(file): \(error.localizedDescription)", error)
    }
  }

  /** Materialize a project file into the app cache; returns a plain local path. */
  @objc func localFile(
    _ project: NSString, file: NSString,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    let src = activateRoot().url
      .appendingPathComponent(project as String, isDirectory: true)
      .appendingPathComponent(file as String)
    let dstDir = cachesURL().appendingPathComponent(project as String, isDirectory: true)
    let dst = dstDir.appendingPathComponent((file as String).replacingOccurrences(of: "/", with: "_"))
    let fm = FileManager.default
    do {
      try ensureDownloaded(src, timeout: 300)
      let srcSize = (try? src.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? -1
      let dstSize = (try? dst.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? -2
      if srcSize != dstSize {
        try fm.createDirectory(at: dstDir, withIntermediateDirectories: true)
        let data = try coordinatedRead(src)
        try data.write(to: dst, options: .atomic)
      }
      resolve(dst.path)
    } catch {
      reject("local_failed", "\(file): \(error.localizedDescription)", error)
    }
  }
}
