import AVFAudio
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
