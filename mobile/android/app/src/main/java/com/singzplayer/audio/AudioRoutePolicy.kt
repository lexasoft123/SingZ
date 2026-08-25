package com.singzplayer.audio

/** Pure classification of AudioDeviceInfo.type values. The playing
 * AudioTrack supplies the type; this policy never guesses from the list of
 * merely connected outputs. */
object AudioRoutePolicy {
  data class Route(val portType: String, val fallbackName: String)
  data class Latency(val outputLatency: Double, val ioBufferDuration: Double)

  /** The nullable type must come from the playing AudioTrack.routedDevice. */
  fun classifyRouted(type: Int?): Route = classify(type ?: 0)

  fun classify(type: Int): Route = when (type) {
    8 -> Route("BluetoothA2DPOutput", "Bluetooth")
    7 -> Route("BluetoothHFP", "Bluetooth headset")
    26, 27, 30 -> Route("BluetoothLE", "Bluetooth LE audio")
    23 -> Route("HearingAid", "Hearing aid")
    21 -> Route("CarAudio", "Car audio") // TYPE_BUS / automotive HAL
    11, 12, 22 -> Route("USB Audio", "USB audio")
    9 -> Route("HDMIOutput", "HDMI")
    3, 4 -> Route("Headphones", "Headphones")
    2 -> Route("Speaker", "Speaker")
    else -> Route("UnknownOutput", "Output route unknown")
  }

  /**
   * AudioTimestamp queue depth already includes the track/HAL buffer. Adding
   * PROPERTY_OUTPUT_FRAMES_PER_BUFFER would count that portion twice. The
   * property is retained only as the conservative fallback when no timestamp
   * measurement was available.
   */
  fun latency(measuredPresentationSec: Double, propertyBufferSec: Double): Latency {
    val measured = measuredPresentationSec.takeIf { it.isFinite() && it > 0 }
    return if (measured != null) Latency(measured, 0.0)
    else Latency(0.0, propertyBufferSec.takeIf { it.isFinite() && it > 0 } ?: 0.0)
  }
}
