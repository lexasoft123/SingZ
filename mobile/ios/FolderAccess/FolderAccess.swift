import AuthenticationServices
import CryptoKit
import Foundation
import Network
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
  var pickFileResolve: RCTPromiseResolveBlock?  // internal: audio-file pick (FolderAccessWriter.swift)
  var pickFileReject: RCTPromiseRejectBlock?
  private var rootURL: URL?
  private var rootScoped = false

  @objc static func requiresMainQueueSetup() -> Bool { false }

  func documentsURL() -> URL {  // internal: FolderAccessWriter.swift uses it
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
  }

  /**
   * Downloaded stems live in Application Support, NOT Caches: iOS evicts
   * Caches under storage pressure, and re-fetching a song the phone already
   * has is exactly what an offline library exists to prevent. Excluded from
   * iCloud backup — these are reproducible copies of files that live in Drive
   * or a synced folder, and a few hundred MB a song has no business in a
   * device backup. Whatever the old cache still holds is adopted once rather
   * than downloaded again.
   */
  func cacheRootURL() -> URL {  // internal: FolderAccessWriter.swift uses it
    let fm = FileManager.default
    var base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("singz-projects", isDirectory: true)
    if !fm.fileExists(atPath: base.path) {
      try? fm.createDirectory(
        at: base.deletingLastPathComponent(), withIntermediateDirectories: true)
      let old = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("singz-projects", isDirectory: true)
      if fm.fileExists(atPath: old.path) {
        try? fm.moveItem(at: old, to: base)
        NSLog("SingZ cache: adopted %@ into Application Support", old.path)
      }
      if !fm.fileExists(atPath: base.path) {
        try? fm.createDirectory(at: base, withIntermediateDirectories: true)
      }
      var vals = URLResourceValues()
      vals.isExcludedFromBackup = true
      try? base.setResourceValues(vals)
    }
    return base
  }

  /** Cache folder for one project, or nil when the name is not a plain child. */
  private func cacheDirFor(_ project: String) -> URL? {
    guard !project.isEmpty, !project.contains("/"), project != "..", project != "." else {
      return nil
    }
    return cacheRootURL().appendingPathComponent(project, isDirectory: true)
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

  /** One audio file via the system picker (asCopy — the URL is already our
   *  own temp copy) → a private copy the decoders can open by plain path.
   *  Resolves null on cancel. Mirrors the Android module exactly. */
  @objc func pickAudioFile(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard let host = self.topViewController() else {
        reject("no_ui", "could not open the file picker (no window)", nil)
        return
      }
      guard self.pickFileResolve == nil else {
        reject("busy", "File picker is already open", nil)
        return
      }
      self.pickFileResolve = resolve
      self.pickFileReject = reject
      let picker = UIDocumentPickerViewController(
        forOpeningContentTypes: [UTType.audio], asCopy: true)
      picker.allowsMultipleSelection = false
      picker.delegate = self
      host.present(picker, animated: true)
    }
  }

  func documentPicker(
    _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
  ) {
    if let fileResolve = pickFileResolve {
      let fileReject = pickFileReject
      pickFileResolve = nil
      pickFileReject = nil
      guard let url = urls.first else {
        fileResolve(nil)
        return
      }
      DispatchQueue.global(qos: .utility).async {
        do {
          let fm = FileManager.default
          let dir = self.cacheRootURL()
            .appendingPathComponent("imports", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
          try fm.createDirectory(at: dir, withIntermediateDirectories: true)
          let out = dir.appendingPathComponent(url.lastPathComponent)
          try fm.moveItem(at: url, to: out)
          let attrs = try? fm.attributesOfItem(atPath: out.path)
          let size = (attrs?[.size] as? Int64) ?? 0
          fileResolve(["path": out.path, "name": url.lastPathComponent, "size": Double(size)])
        } catch {
          // a failed copy is an error, never a cancel — nil would read as one
          fileReject?("pick", "Cannot copy the picked file", error)
        }
      }
      return
    }
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
    if let fileResolve = pickFileResolve {
      pickFileResolve = nil
      pickFileReject = nil
      fileResolve(nil)
      return
    }
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
    let root = activateRoot()
    let src = root.url
      .appendingPathComponent(project as String, isDirectory: true)
      .appendingPathComponent(file as String)
    // Files in the app's own Documents are already plain local paths, so hand
    // one straight back (Android has always done this). Copying them into the
    // download folder would now duplicate every stem for good, that folder no
    // longer being something the OS clears out.
    if root.kind == "documents", FileManager.default.fileExists(atPath: src.path) {
      resolve(src.path)
      return
    }
    let dstDir = cacheRootURL().appendingPathComponent(project as String, isDirectory: true)
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

  /** What each project occupies on this phone — powers the ✓ and the size line. */
  @objc func cacheUsage(
    _ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let fm = FileManager.default
    let root = cacheRootURL()
    var out: [[String: Any]] = []
    let dirs =
      (try? fm.contentsOfDirectory(
        at: root, includingPropertiesForKeys: [.isDirectoryKey], options: [])) ?? []
    for dir in dirs {
      guard (try? dir.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true else {
        continue
      }
      var bytes: Int64 = 0
      var files = 0
      var sizes: [String: Int64] = [:]
      if let walk = fm.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey]) {
        for case let f as URL in walk {
          // a fetch in flight is not bytes the phone has (Android stages here;
          // the rule belongs to the module, not to one platform)
          if f.pathExtension == "part" { continue }
          if let size = (try? f.resourceValues(forKeys: [.fileSizeKey]))?.fileSize {
            bytes += Int64(size)
            files += 1
            let rel = f.path.hasPrefix(dir.path + "/")
              ? String(f.path.dropFirst(dir.path.count + 1)) : f.lastPathComponent
            sizes[rel] = Int64(size)
          }
        }
      }
      if files > 0 {
        out.append([
          "project": dir.lastPathComponent, "bytes": bytes, "files": files, "sizes": sizes
        ])
      }
    }
    resolve(out)
  }

  /**
   * "Do we already have this file?" — asked of the file itself, never of a
   * record of past downloads: a ledger has no row for a copy fetched by an
   * older build, and the phone would re-download a song it is plainly holding.
   * Missing, wrong size, wrong bytes → fetch. With no md5 to compare against
   * (an older desktop's project.json) the size is all there is.
   */
  private func isCurrent(_ url: URL, _ md5: String, _ size: Int64) -> Bool {
    let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
    let have = (attrs?[.size] as? Int64) ?? -1
    return CacheCurrency.isCurrent(haveSize: have, wantSize: size, wantMd5: md5) {
      attrs.map { hashOf(url, $0) }
    }
  }

  /** md5 of a file, remembered against its own identity (size + mtime) so a
   *  song hashes once and not on every open. A rewrite moves the mtime, so a
   *  stale row cannot outlive the bytes it describes. The read is chunked —
   *  these are whole stems, and a song's worth will not fit in memory twice. */
  func hashOf(_ url: URL, _ attrs: [FileAttributeKey: Any]) -> String {  // internal: FolderAccessWriter.swift uses it
    let size = (attrs[.size] as? Int64) ?? 0
    let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
    let stamp = "\(size):\(Int64(mtime * 1000))"
    let key = "singz.hash.\(url.path)"
    let kept = UserDefaults.standard.string(forKey: key)?.split(separator: ":", maxSplits: 2)
    if let kept, kept.count == 3, "\(kept[0]):\(kept[1])" == stamp { return String(kept[2]) }
    guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
    defer { try? handle.close() }
    var md5 = Insecure.MD5()
    while let chunk = try? handle.read(upToCount: 1 << 16), !chunk.isEmpty {
      md5.update(data: chunk)
    }
    let hex = md5.finalize().map { String(format: "%02x", $0) }.joined()
    UserDefaults.standard.set("\(stamp):\(hex)", forKey: key)
    return hex
  }

  /** Drop one project's downloaded files, or everything when project is "". */
  @objc func clearCache(
    _ project: NSString,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let name = project as String
    let target: URL
    if name.isEmpty {
      target = cacheRootURL()
    } else {
      guard let dir = cacheDirFor(name) else {
        reject("clear", "Bad project name", nil)
        return
      }
      target = dir
    }
    do {
      if FileManager.default.fileExists(atPath: target.path) {
        try FileManager.default.removeItem(at: target)
      }
      // the memo describes files that no longer exist; left alone it is parsed
      // into memory at every launch, forever
      let stale = "singz.hash.\(target.path)"
      for key in UserDefaults.standard.dictionaryRepresentation().keys
      where key == stale || key.hasPrefix(stale + "/") {
        UserDefaults.standard.removeObject(forKey: key)
      }
      resolve(true)
    } catch {
      reject("clear", "Could not free that space: \(error.localizedDescription)", error)
    }
  }

  // ------------------------------------------------- Google Drive helpers --

  private var oauthListener: NWListener?
  private var oauthWaitResolve: RCTPromiseResolveBlock?
  private var oauthWaitReject: RCTPromiseRejectBlock?
  private var authSession: ASWebAuthenticationSession?

  /**
   * Loopback OAuth, iOS flavor: the listener catches Google's redirect while
   * ASWebAuthenticationSession keeps the app foreground (a Safari bounce
   * would suspend us and kill the socket mid-consent). One Desktop-type
   * client therefore serves every platform.
   */
  @objc func oauthStart(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    oauthListener?.cancel()
    do {
      let listener = try NWListener(using: .tcp, on: .any)
      oauthListener = listener
      var settled = false
      listener.newConnectionHandler = { [weak self] conn in self?.handleOAuthConnection(conn) }
      listener.stateUpdateHandler = { state in
        switch state {
        case .ready:
          if !settled {
            settled = true
            resolve(Int(listener.port?.rawValue ?? 0))
          }
        case .failed(let err):
          if !settled {
            settled = true
            reject("oauth", err.localizedDescription, err)
          }
        default:
          break
        }
      }
      listener.start(queue: .global())
    } catch {
      reject("oauth", "Cannot open the sign-in listener: \(error.localizedDescription)", error)
    }
  }

  @objc func oauthWait(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard oauthListener != nil else {
      reject("oauth", "Sign-in listener is not running", nil)
      return
    }
    oauthWaitResolve = resolve
    oauthWaitReject = reject
    DispatchQueue.global().asyncAfter(deadline: .now() + 300) { [weak self] in
      guard let self, let rej = self.oauthWaitReject else { return }
      self.oauthWaitResolve = nil
      self.oauthWaitReject = nil
      self.oauthListener?.cancel()
      self.oauthListener = nil
      DispatchQueue.main.async {
        self.authSession?.cancel()
        self.authSession = nil
      }
      rej("oauth", "Sign-in was not completed", nil)
    }
  }

  private func handleOAuthConnection(_ conn: NWConnection) {
    conn.start(queue: .global())
    conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
      guard let self else { return }
      let request = String(data: data ?? Data(), encoding: .utf8) ?? ""
      let path = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
      let body = "<html><body style=\"font-family:sans-serif;padding:40px\">"
        + "<h3>SingZ is signed in</h3>You can close this and go back to the app.</body></html>"
      let resp = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: \(body.utf8.count)\r\n"
        + "Connection: close\r\n\r\n" + body
      conn.send(content: resp.data(using: .utf8), completion: .contentProcessed { _ in conn.cancel() })
      let port = self.oauthListener?.port?.rawValue ?? 0
      DispatchQueue.main.async {
        self.authSession?.cancel()
        self.authSession = nil
      }
      if let res = self.oauthWaitResolve {
        self.oauthWaitResolve = nil
        self.oauthWaitReject = nil
        res("http://127.0.0.1:\(port)\(path)")
      }
      self.oauthListener?.cancel()
      self.oauthListener = nil
    }
  }

  /** Present Google consent in the in-app auth sheet (app stays active). */
  @objc func oauthPresent(
    _ url: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let authUrl = URL(string: url) else {
      reject("oauth", "Bad sign-in URL", nil)
      return
    }
    DispatchQueue.main.async {
      // callbackURLScheme never fires — the loopback listener finishes the
      // flow and cancels the sheet; the scheme only satisfies the API.
      let session = ASWebAuthenticationSession(url: authUrl, callbackURLScheme: "singz") {
        [weak self] _, error in
        guard let self else { return }
        if error != nil, let rej = self.oauthWaitReject {
          // user dismissed the sheet before completing
          self.oauthWaitResolve = nil
          self.oauthWaitReject = nil
          self.oauthListener?.cancel()
          self.oauthListener = nil
          rej("oauth", "Google sign-in was cancelled", nil)
        }
      }
      session.prefersEphemeralWebBrowserSession = false
      session.presentationContextProvider = self
      self.authSession = session
      if session.start() {
        resolve(nil)
      } else {
        reject("oauth", "Cannot present the sign-in sheet", nil)
      }
    }
  }

  /**
   * Stream an authorized URL into the project cache (Drive media downloads).
   * The copy on disk is served whenever it IS the wanted file — see isCurrent;
   * the URL is not touched then, so a downloaded song opens with no signal.
   */
  @objc func fetchToCache(
    _ project: String,
    file: String,
    url: String,
    auth: String,
    expectedMd5: String,
    expectedBytes: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let remote = URL(string: url) else {
      reject("fetch", "Bad download URL for \(file)", nil)
      return
    }
    let out = cacheRootURL().appendingPathComponent(project, isDirectory: true)
      .appendingPathComponent(file)
    let fm = FileManager.default
    if isCurrent(out, expectedMd5, expectedBytes.int64Value) {
      resolve(["path": out.path, "downloaded": false])
      return
    }
    var req = URLRequest(url: remote)
    req.setValue(auth, forHTTPHeaderField: "Authorization")
    req.timeoutInterval = 120
    let task = URLSession.shared.downloadTask(with: req) { tmp, response, error in
      if let error {
        reject("fetch", "\(file): \(error.localizedDescription)", error)
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard status / 100 == 2, let tmp else {
        reject("fetch", "Drive download failed (\(status)) for \(file)", nil)
        return
      }
      do {
        try fm.createDirectory(
          at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
        if fm.fileExists(atPath: out.path) { try fm.removeItem(at: out) }
        try fm.moveItem(at: tmp, to: out)
        // What landed must be what was asked for — a connection cut halfway
        // leaves a plausible file, and caching it would poison every later
        // open with audio that decodes to silence or noise.
        if !expectedMd5.isEmpty,
          let attrs = try? fm.attributesOfItem(atPath: out.path),
          self.hashOf(out, attrs) != expectedMd5
        {
          try? fm.removeItem(at: out)
          reject("fetch", "\(file) arrived damaged — try again", nil)
          return
        }
        resolve(["path": out.path, "downloaded": true])
      } catch {
        reject("fetch", "Cannot cache \(file): \(error.localizedDescription)", error)
      }
    }
    task.resume()
  }
}

extension FolderAccess: ASWebAuthenticationPresentationContextProviding {
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    for scene in UIApplication.shared.connectedScenes {
      guard let ws = scene as? UIWindowScene else { continue }
      if let win = ws.windows.first(where: { $0.isKeyWindow }) ?? ws.windows.first {
        return win
      }
    }
    return ASPresentationAnchor()
  }
}
