package com.singzplayer.audio

/** Pure policy kept outside Android framework objects so the JVM suite can
 * pin conservative device claims without a phone or mocked AudioManager. */
object AudioInputPolicy {
  const val MAX_CHANNELS = 256

  fun portableUid(deviceId: Int): String {
    require(deviceId > 0) { "Android audio device ID must be positive" }
    return "android:$deviceId"
  }

  fun channelCount(
    advertisedCounts: IntArray,
    channelMasks: IntArray,
    channelIndexMasks: IntArray
  ): Int {
    val candidates = ArrayList<Int>()
    candidates.addAll(advertisedCounts.filter { it in 1..MAX_CHANNELS })
    candidates.addAll(channelMasks.map { Integer.bitCount(it) }.filter { it in 1..MAX_CHANNELS })
    candidates.addAll(channelIndexMasks.map { Integer.bitCount(it) }.filter { it in 1..MAX_CHANNELS })
    // Empty metadata is common on vendor Bluetooth and some built-in routes.
    // Mono is the only truthful fallback; inventing stereo or 16 USB lanes
    // would let the UI select a channel AAudio cannot promise.
    return candidates.maxOrNull() ?: 1
  }

  fun sampleRate(advertised: IntArray): Double {
    val usable = advertised.filter { it in 8_000..384_000 }
    return when {
      48_000 in usable -> 48_000.0
      usable.isNotEmpty() -> usable.max().toDouble()
      else -> 48_000.0 // AAudio negotiates and verifies the actual rate.
    }
  }

  fun transport(type: Int): String = when (type) {
    7 -> "bluetooth-sco"
    23 -> "hearing-aid"
    26, 27, 30 -> "bluetooth-le"
    21 -> "automotive"
    11, 12, 22 -> "usb"
    3, 4 -> "wired"
    15 -> "built-in"
    else -> "other"
  }

  fun highLatency(type: Int): Boolean = when (type) {
    // AudioDeviceInfo's Bluetooth types. Several are normally output-only,
    // but if a vendor publishes one as an input it must still get the honest
    // high-latency warning. Keep this explicit: the user-facing BLE transport
    // label intentionally does not claim that LE Audio is ordinary SCO.
    7, 8, 21, 23, 26, 27, 30 -> true
    else -> false
  }

  fun warning(type: Int): String? = when (type) {
    21 -> "Automotive audio routing is controlled by Android and may add substantial latency."
    23 -> "Hearing-aid microphone routing is controlled by Android and may add substantial latency."
    7, 8, 26, 27, 30 ->
      "Bluetooth microphone routing is controlled by Android and may add substantial latency."
    else -> null
  }

  /** App fallback preference only; Android exposes no public active/default
   * capture endpoint. Prefer an attached physical interface without claiming
   * the OS routed capture there. Ties stay deterministic by device ID. */
  fun inputPreference(type: Int): Int = when (type) {
    11, 12, 22 -> 4 // USB device/accessory/headset
    3, 4, 5, 6 -> 3 // wired headset/headphones/analog/digital line
    7, 8, 23, 26, 27, 30 -> 2 // Bluetooth families
    15 -> 1 // built-in microphone
    else -> 0
  }
}
