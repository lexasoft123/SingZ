import AVFAudio
import CommonCrypto
import Foundation
import React

/**
 * Output-route latency for lyric-sync compensation: what you hear over
 * CarPlay/Bluetooth arrives after the engine clock, so the app shifts its
 * visuals by outputLatency + ioBufferDuration (+ a user trim persisted here —
 * reported values under-report on Bluetooth and are unverified on CarPlay).
 */
@objc(AudioRouteInfo)
class AudioRouteInfo: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func getOutput(
    _ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    let session = AVAudioSession.sharedInstance()
    let port = session.currentRoute.outputs.first
    resolve([
      "outputLatency": session.outputLatency,
      "ioBufferDuration": session.ioBufferDuration,
      "portType": port?.portType.rawValue ?? "unknown",
      "portName": port?.portName ?? "",
      "portUid": port?.uid ?? "",
      // Output volume, so the log can say why a song was inaudible. Already
      // 0..1 here; Android normalizes its step index to match. iOS exposes no
      // step count, so volumeIndex/volumeMax are Android-only and the JS side
      // treats them as optional.
      "volume": session.outputVolume
    ])
  }

  /// base64url, RFC 7636's alphabet: no padding, no + or /.
  private static func b64url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// Counterpart of the Android pkcePair — a verifier from the system CSPRNG
  /// and its SHA-256 challenge. See the Kotlin side for why this moved off
  /// the JS thread: Hermes has no WebCrypto, so the old code sent the
  /// verifier in the clear and built it from a clock and Math.random.
  @objc func pkcePair(
    _ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    var seed = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, seed.count, &seed) == errSecSuccess else {
      reject("pkce", "Cannot read secure random bytes", nil)
      return
    }
    let verifier = AudioRouteInfo.b64url(Data(seed))
    var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    let ascii = Data(verifier.utf8)
    _ = ascii.withUnsafeBytes { CC_SHA256($0.baseAddress, CC_LONG(ascii.count), &digest) }
    resolve(["verifier": verifier, "challenge": AudioRouteInfo.b64url(Data(digest))])
  }

  /// Counterpart of the Android getAppInfo — the build/device header a bug
  /// report needs. iOS exposes no cheap total-RAM figure worth reporting, so
  /// the memory fields are Android-only and the JS side treats them as
  /// optional rather than printing zeroes that mean nothing.
  @objc func getAppInfo(
    _ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    let info = Bundle.main.infoDictionary
    resolve([
      "version": info?["CFBundleShortVersionString"] as? String ?? "",
      "build": info?["CFBundleVersion"] as? String ?? "",
      "abi": "arm64"
    ])
  }

  @objc func getPref(
    _ key: NSString, resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    let d = UserDefaults.standard
    resolve(d.object(forKey: key as String) == nil ? nil : d.double(forKey: key as String))
  }

  @objc func setPref(
    _ key: NSString, value: Double, resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    UserDefaults.standard.set(value, forKey: key as String)
    resolve(nil)
  }

  @objc func getTextPref(
    _ key: NSString, resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(UserDefaults.standard.string(forKey: key as String))
  }

  /** Synchronous flush — breadcrumbs must hit disk before a crash can eat them. */
  @objc func setTextPref(
    _ key: NSString, value: NSString, resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    UserDefaults.standard.set(value as String, forKey: key as String)
    UserDefaults.standard.synchronize()
    resolve(nil)
  }
}
