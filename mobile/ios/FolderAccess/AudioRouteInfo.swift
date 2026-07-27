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
      "portUid": port?.uid ?? ""
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
