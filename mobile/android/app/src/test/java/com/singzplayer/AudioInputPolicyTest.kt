package com.singzplayer

import com.singzplayer.audio.AudioInputOwnership
import com.singzplayer.audio.AudioInputPolicy
import com.singzplayer.audio.AudioInputStopController
import com.singzplayer.audio.AudioRoutePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioInputPolicyTest {
  @Test
  fun `USB multichannel inventory keeps every advertised lane`() {
    assertEquals(
      16,
      AudioInputPolicy.channelCount(
        intArrayOf(1, 2, 8, 16),
        intArrayOf(),
        intArrayOf()
      )
    )
    assertEquals("android:41", AudioInputPolicy.portableUid(41))
  }

  @Test
  fun `empty or corrupt vendor metadata never invents hidden channels`() {
    assertEquals(1, AudioInputPolicy.channelCount(intArrayOf(), intArrayOf(), intArrayOf()))
    assertEquals(
      2,
      AudioInputPolicy.channelCount(
        intArrayOf(-4, 999),
        intArrayOf(0b11),
        intArrayOf()
      )
    )
  }

  @Test
  fun `sample-rate policy prefers the native low-latency family`() {
    assertEquals(48_000.0, AudioInputPolicy.sampleRate(intArrayOf(44_100, 48_000)), 0.0)
    assertEquals(96_000.0, AudioInputPolicy.sampleRate(intArrayOf(44_100, 96_000)), 0.0)
    assertEquals(48_000.0, AudioInputPolicy.sampleRate(intArrayOf()), 0.0)
  }

  @Test
  fun `Bluetooth inputs are honest high-latency routes`() {
    assertTrue(AudioInputPolicy.highLatency(7)) // TYPE_BLUETOOTH_SCO
    assertTrue(AudioInputPolicy.highLatency(26)) // TYPE_BLE_HEADSET
    assertTrue(AudioInputPolicy.highLatency(23)) // TYPE_HEARING_AID
    assertTrue(AudioInputPolicy.highLatency(21)) // TYPE_BUS / automotive
    assertFalse(AudioInputPolicy.highLatency(11)) // TYPE_USB_DEVICE
  }

  @Test
  fun `app fallback prefers wired inputs without claiming an OS default`() {
    assertTrue(AudioInputPolicy.inputPreference(11) > AudioInputPolicy.inputPreference(3))
    assertTrue(AudioInputPolicy.inputPreference(3) > AudioInputPolicy.inputPreference(15))
  }

  @Test
  fun `bluetooth never outranks the built-in microphone`() {
    // The module establishes no SCO/communication route, so a Bluetooth
    // capture endpoint carries nothing. Connected earbuds must not take the
    // capture away from the microphone that is always live.
    for (bluetooth in intArrayOf(7, 8, 23, 26, 27, 30))
      assertTrue(AudioInputPolicy.inputPreference(15) > AudioInputPolicy.inputPreference(bluetooth))
  }

  @Test
  fun `one owner and generation rejects stale stop and unplug`() {
    val ownership = AudioInputOwnership()
    val first = ownership.acquire("training", 41)!!
    assertNull(ownership.acquire("settings", 41))
    assertNull(ownership.release("training", first.generation + 1))
    assertEquals(first, ownership.removeDevice(41))
    val second = ownership.acquire("settings", 8)!!
    assertTrue(second.generation > first.generation)
    assertNull(ownership.release("training", first.generation))
    assertEquals(second, ownership.release("settings", second.generation))
  }

  @Test
  fun `start racing invalidation cannot commit or reacquire`() {
    val ownership = AudioInputOwnership()
    val starting = ownership.acquire("training", 41)!!
    assertEquals(starting, ownership.invalidate())
    assertFalse(ownership.isCurrent(starting))
    assertNull(ownership.acquire("late", 41))
  }

  @Test
  fun `callback after shutdown is rejected deterministically`() {
    val ownership = AudioInputOwnership()
    val held = ownership.acquire("training", 41)!!
    assertTrue(ownership.isCurrent(held))
    ownership.invalidate()
    assertFalse(ownership.isCurrent(held))
    assertTrue(ownership.isInvalidated())
  }

  @Test
  fun `production stop seam retains token until native confirms and supports retry`() {
    val ownership = AudioInputOwnership()
    val held = ownership.acquire("training", 41)!!
    var attempts = 0
    val controller = AudioInputStopController(ownership) {
      ++attempts > 1
    }

    assertNull(controller.stop(held.owner, held.generation))
    assertEquals(held, ownership.current())
    assertNull(ownership.acquire("late", 41))

    assertEquals(held, controller.stop(held.owner, held.generation))
    assertNull(ownership.current())
    assertEquals(2, attempts)
  }

  @Test
  fun `production stop seam retains token when native throws`() {
    val ownership = AudioInputOwnership()
    val held = ownership.acquire("training", 41)!!
    val controller = AudioInputStopController(ownership) {
      throw IllegalStateException("native stop failed")
    }

    try {
      controller.stop(held.owner, held.generation)
    } catch (_: IllegalStateException) {}
    assertEquals(held, ownership.current())
  }

  @Test
  fun `playing output route classifications cover delayed Android transports`() {
    assertEquals("BluetoothA2DPOutput", AudioRoutePolicy.classify(8).portType)
    assertEquals("BluetoothHFP", AudioRoutePolicy.classify(7).portType)
    assertEquals("BluetoothLE", AudioRoutePolicy.classify(26).portType)
    assertEquals("HearingAid", AudioRoutePolicy.classify(23).portType)
    assertEquals("CarAudio", AudioRoutePolicy.classify(21).portType)
    assertEquals("USB Audio", AudioRoutePolicy.classify(11).portType)
    assertEquals("USB Audio", AudioRoutePolicy.classify(12).portType)
    assertEquals("UnknownOutput", AudioRoutePolicy.classify(0).portType)
  }

  @Test
  fun `input transports distinguish USB BLE hearing aid and automotive routes`() {
    assertEquals("usb", AudioInputPolicy.transport(12))
    assertEquals("hearing-aid", AudioInputPolicy.transport(23))
    assertEquals("bluetooth-le", AudioInputPolicy.transport(26))
    assertEquals("bluetooth-le", AudioInputPolicy.transport(27))
    assertEquals("bluetooth-le", AudioInputPolicy.transport(30))
    assertEquals("automotive", AudioInputPolicy.transport(21))
    assertTrue(AudioInputPolicy.warning(21)!!.startsWith("Automotive"))
    assertTrue(AudioInputPolicy.warning(23)!!.startsWith("Hearing-aid"))
  }

  @Test
  fun `actual routed device type is authoritative and null stays unknown`() {
    assertEquals("USB Audio", AudioRoutePolicy.classifyRouted(12).portType)
    assertEquals("UnknownOutput", AudioRoutePolicy.classifyRouted(null).portType)
  }

  @Test
  fun `measured presentation queue is not added to the property buffer twice`() {
    val measured = AudioRoutePolicy.latency(0.137, 256.0 / 48_000.0)
    assertEquals(0.137, measured.outputLatency, 0.0)
    assertEquals(0.0, measured.ioBufferDuration, 0.0)

    val fallback = AudioRoutePolicy.latency(0.0, 256.0 / 48_000.0)
    assertEquals(0.0, fallback.outputLatency, 0.0)
    assertEquals(256.0 / 48_000.0, fallback.ioBufferDuration, 0.0)
  }
}
