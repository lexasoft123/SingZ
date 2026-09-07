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

  /** AudioManager is allowed to publish no rate metadata. The dormant host
   * keeps that as unknown instead of manufacturing a 48 kHz physical claim. */
  fun hostSampleRates(advertised: IntArray): IntArray = advertised
    .filter { it in 8_000..384_000 }
    .distinct()
    .sorted()
    .toIntArray()

  inline fun publishCaptureThenBestEffortHost(
    publishCapture: () -> Unit,
    publishHost: () -> Unit
  ) {
    publishCapture()
    runCatching(publishHost)
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

  /** How willingly a song may be played out of this endpoint, higher first;
   *  0 means never.
   *
   *  Something has to answer "which output?", because AudioManager publishes
   *  every endpoint the phone has and marks none of them. Nothing did: the
   *  first by UID STRING was taken, and "android:10" sorts before
   *  "android:3", so a real handset prepared six lanes at 16 kHz for a
   *  TELEPHONY endpoint and Oboe refused to open it. A singer's own phone,
   *  every time, with nothing in the log naming the route.
   *
   *  These are AudioDeviceInfo type constants. Only the ones a person could
   *  reasonably listen to music through score at all — the earpiece, the
   *  telephony path and Bluetooth SCO (a mono voice-call profile, not A2DP)
   *  are deliberately zero however loudly they advertise themselves. */
  fun mediaOutputRank(type: Int): Int = when (type) {
    3, 4, 11, 12, 22 -> 60 // wired headset/headphones, USB device/accessory/headset
    8, 23, 26, 27, 30 -> 50 // Bluetooth A2DP, hearing aid, BLE headset/speaker/broadcast
    5, 6, 9, 10, 13, 19, 29, 31 -> 40 // line, SPDIF, HDMI/ARC/eARC, dock(+analog), aux
    2 -> 30 // the built-in speaker
    // SPEAKER_SAFE is the same speaker with a volume ceiling. It must rank
    // BELOW its twin rather than tie: a tie is broken by device id, and a
    // phone that happens to number it lower would play the song quietly with
    // nothing naming the reason — the id-ordering accident this exists to end.
    24 -> 25
    // IP(20) and BUS(21) are the two the platform declines to describe — "a
    // device connected over IP", "type-agnostic … external audio systems" —
    // so they name a transport and leave the purpose to the OEM. On Android
    // Automotive EVERY output context is published as BUS, the call buses
    // included, so ranking them playable would re-admit exactly the class
    // this function exists to keep out. Declining to guess costs nothing on a
    // phone, which publishes neither.
    else -> 0 // earpiece(1), SCO(7), telephony(18), IP(20), BUS(21), tuners, submix, inputs
  }

  /** The endpoint a song should play out of, or "" when the phone offers
   *  nothing a person would listen to music through. "" publishes no default,
   *  and the mobile caller then declines native playback for this device
   *  rather than guessing — legacy plays the song. It must never fall back to
   *  the first published output: that list is ordered by uid STRING, which is
   *  how a 16 kHz telephony endpoint came to be chosen over a speaker. */
  fun mediaOutputUid(uids: Array<String>, types: IntArray, sinks: BooleanArray): String {
    var best = 0
    var chosen = ""
    val count = minOf(uids.size, types.size, sinks.size)
    for (index in 0 until count) {
      if (!sinks[index]) continue
      val rank = mediaOutputRank(types[index])
      // Strictly greater: ties keep the caller's order, which is by device
      // id, and both callers sort by id — so the choice is stable and never
      // flaps between refreshes. A tie is NOT always one destination under
      // two names: the 60 tier can hold a 3.5 mm jack and a USB DAC at once,
      // the 50 tier A2DP and a hearing aid. What a tier does guarantee is
      // that every member NAMES a physical music destination, so the id picks
      // between two acceptable outputs and can never land on the earpiece,
      // telephony or SCO class this function exists to keep out.
      if (rank > best) {
        best = rank
        chosen = uids[index]
      }
    }
    return chosen
  }

  /** Typed AudioHost transport; unlike input UI copy this covers sinks too. */
  fun hostTransport(type: Int): String = when (type) {
    2, 15 -> "built-in" // speaker / built-in microphone
    7, 8 -> "bluetooth"
    23, 26, 27, 30 -> "bluetooth-low-energy"
    21 -> "vehicle" // TYPE_BUS / automotive HAL
    11, 12, 22 -> "usb"
    9, 10, 29 -> "hdmi"
    else -> "unknown"
  }

  fun highLatency(type: Int): Boolean = when (type) {
    // AudioDeviceInfo's Bluetooth types. Several are normally output-only,
    // but if a vendor publishes one as an input it must still get the honest
    // high-latency warning. Keep this explicit: the user-facing BLE transport
    // label intentionally does not claim that LE Audio is ordinary SCO.
    7, 8, 21, 23, 26, 27, 30 -> true
    else -> false
  }

  /** Monitoring suitability is intentionally tri-state. Not being on the
   * delayed-route denylist does not prove a vendor/HDMI endpoint is suitable
   * for live sidetone. */
  fun hostMonitoringSuitability(type: Int): String = when (type) {
    2, 3, 4, 5, 6, 11, 12, 15, 22 -> "low-latency"
    7, 8, 21, 23, 26, 27, 30 -> "high-latency"
    else -> "unknown"
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
   * the OS routed capture there. Ties stay deterministic by device ID.
   *
   * Bluetooth ranks BELOW the built-in microphone, and that ordering is the
   * point of this function rather than a detail of it. AudioInputModule
   * deliberately owns no route: it never sets MODE_IN_COMMUNICATION, a
   * communication device, or audio focus, because react-native-audio-api owns
   * the playback session. A Bluetooth capture endpoint only carries audio once
   * Android has been asked to route capture there — so ranking one first aims
   * SingZ at an endpoint it will not activate, on the say-so of earbuds the
   * singer connected for LISTENING. Nothing in the app offers a picker to
   * escape that choice, so the fallback has to be the microphone that is
   * always live. USB and wired inputs stay above it: those are physical routes
   * that carry audio as soon as they are plugged in. */
  fun inputPreference(type: Int): Int = when (type) {
    11, 12, 22 -> 4 // USB device/accessory/headset
    3, 4, 5, 6 -> 3 // wired headset/headphones/analog/digital line
    15 -> 2 // built-in microphone
    7, 8, 23, 26, 27, 30 -> 1 // Bluetooth families — no route of ours reaches them
    else -> 0
  }
}
