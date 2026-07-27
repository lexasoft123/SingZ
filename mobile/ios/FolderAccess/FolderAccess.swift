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
      do {
        let probe = try URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale)
        NSLog("SingZ root: bookmark resolved to %@ (stale=%d)", probe.path, stale ? 1 : 0)
      } catch {
        NSLog("SingZ root: bookmark resolve FAILED — %@", error.localizedDescription)
      }
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

  /**
   * Wait for an iCloud item to be fully local (no-op for regular files).
   * An undownloaded item exists only as a ".name.icloud" placeholder — the
   * logical URL has no readable attributes yet, so materialization must be
   * requested unconditionally and completion judged by the real file
   * appearing with a settled downloading status.
   */
  private func ensureDownloaded(_ url: URL, timeout: TimeInterval) throws {
    let fm = FileManager.default
    let path = url.path
    let placeholderPath = url.deletingLastPathComponent()
      .appendingPathComponent(".\(url.lastPathComponent).icloud").path
    // URL instances cache resourceValues — a fresh URL per poll is mandatory,
    // or the downloading status never appears to change.
    func settled() -> Bool {
      guard fm.fileExists(atPath: path) else { return false }
      let st = (try? URL(fileURLWithPath: path)
        .resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]))?
        .ubiquitousItemDownloadingStatus
      return st == nil || st == .current
    }
    if settled() { return }
    guard fm.fileExists(atPath: path) || fm.fileExists(atPath: placeholderPath) else {
      throw NSError(
        domain: "SingZ", code: 3,
        userInfo: [NSLocalizedDescriptionKey: "\(url.lastPathComponent) is not in this folder"]
      )
    }
    do {
      try fm.startDownloadingUbiquitousItem(at: url)
    } catch {
      NSLog("SingZ download: start failed for %@ — %@", url.lastPathComponent,
            error.localizedDescription)
    }
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if settled() { return }
      Thread.sleep(forTimeInterval: 0.3)
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

  /** RCTPresentedViewController can be nil under the bridgeless new arch — walk the scenes. */
  private func topViewController() -> UIViewController? {
    if let vc = RCTPresentedViewController() { return vc }
    for scene in UIApplication.shared.connectedScenes {
      guard let ws = scene as? UIWindowScene else { continue }
      for window in ws.windows where window.isKeyWindow {
        var top = window.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        if top != nil { return top }
      }
    }
    return nil
  }

  @objc func pickFolder(
    _ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard let host = self.topViewController() else {
        NSLog("SingZ pick: no view controller to present from")
        reject("no_ui", "could not open the folder picker (no window)", nil)
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
    do {
      let bookmark = try url.bookmarkData()
      UserDefaults.standard.set(bookmark, forKey: Self.bookmarkKey)
      NSLog("SingZ pick: bookmarked %@ (scoped=%d, %d bytes)", url.path, scoped ? 1 : 0, bookmark.count)
    } catch {
      NSLog("SingZ pick: bookmarkData FAILED for %@ — %@", url.path, error.localizedDescription)
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
      NSLog("SingZ list: %d entries in %@", entries.count, root.path)
      for dir in entries {
        NSLog("SingZ list: entry %@ dir=%d pj=%d", dir.lastPathComponent,
          ((try? dir.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true) ? 1 : 0,
          present(dir, "project.json") ? 1 : 0)
        guard (try? dir.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true,
          present(dir, "project.json")
        else { continue }
        let metaURL = dir.appendingPathComponent("project.json")
        guard let metaData = try? coordinatedRead(metaURL),
          let metaText = String(data: metaData, encoding: .utf8)
        else {
          NSLog("SingZ list: meta read failed for %@", dir.lastPathComponent)
          continue
        }
        var stems: [String: String] = [:]
        var cached = true
        var bytes = 0
        let stemsDir = dir.appendingPathComponent("stems", isDirectory: true)
        for s in ["vocals", "drums", "bass", "guitar", "piano", "other"] {
          var ext: String? = nil
          if present(stemsDir, "\(s).flac") {
            ext = "flac"
          } else if present(stemsDir, "\(s).wav") {
            ext = "wav"
          }
          guard let e = ext else { continue }
          stems[s] = e
          // materialized = the real file exists (not just a .name.icloud placeholder)
          let real = stemsDir.appendingPathComponent("\(s).\(e)")
          if fm.fileExists(atPath: real.path) {
            bytes += (try? real.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
          } else {
            cached = false
          }
        }
        out.append([
          "dir": dir.lastPathComponent,
          "meta": metaText,
          "stems": stems,
          "cached": stems.isEmpty ? false : cached,
          "bytes": bytes,
          "hasLyrics": present(dir, "lyrics.json"),
        ])
      }
      resolve(out)
    } catch {
      NSLog("SingZ list: enumeration FAILED — %@", error.localizedDescription)
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
