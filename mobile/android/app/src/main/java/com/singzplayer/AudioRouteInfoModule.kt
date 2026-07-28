package com.singzplayer

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Android counterpart of the iOS AudioRouteInfo module. Android has no public
 * output-latency API, so autoSec only carries the IO buffer duration and the
 * per-route user trim (persisted here in SharedPreferences) does the heavy
 * lifting for Bluetooth/car units. Port type strings reuse the iOS names so
 * the JS label map needs no platform branches.
 */
class AudioRouteInfoModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName(): String = "AudioRouteInfo"

  private val prefs
    get() = ctx.getSharedPreferences("singz", Context.MODE_PRIVATE)

  private fun priority(type: Int): Int = when (type) {
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> 6
    AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET -> 5
    AudioDeviceInfo.TYPE_HDMI -> 4
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET -> 3
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> 1
    else -> 0
  }

  @ReactMethod
  fun getOutput(promise: Promise) {
    try {
      val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val sr = am.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)?.toDoubleOrNull() ?: 48000.0
      val frames = am.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)?.toDoubleOrNull() ?: 256.0
      val pick = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        .filter { priority(it.type) > 0 }
        .maxByOrNull { priority(it.type) }
      val (portType, portName) = when (pick?.type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ->
          "BluetoothA2DPOutput" to (pick.productName?.toString() ?: "Bluetooth")
        AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET ->
          "USB Audio" to (pick.productName?.toString() ?: "USB audio")
        AudioDeviceInfo.TYPE_HDMI -> "HDMIOutput" to "HDMI"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET ->
          "Headphones" to "Headphones"
        else -> "Speaker" to "Speaker"
      }
      val map = Arguments.createMap()
      map.putDouble("outputLatency", 0.0) // not exposed by Android — trim covers it
      map.putDouble("ioBufferDuration", if (sr > 0) frames / sr else 0.0)
      map.putString("portType", portType)
      map.putString("portName", portName)
      map.putString("portUid", "$portType:$portName")
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("route", e.message ?: "Cannot read the audio route")
    }
  }

  @ReactMethod
  fun getPref(key: String, promise: Promise) {
    val v = prefs.getFloat("num:$key", Float.NaN)
    if (v.isNaN()) promise.resolve(null) else promise.resolve(v.toDouble())
  }

  @ReactMethod
  fun setPref(key: String, value: Double, promise: Promise) {
    prefs.edit().putFloat("num:$key", value.toFloat()).commit()
    promise.resolve(null)
  }

  @ReactMethod
  fun getTextPref(key: String, promise: Promise) {
    promise.resolve(prefs.getString("txt:$key", null))
  }

  @ReactMethod
  fun setTextPref(key: String, value: String, promise: Promise) {
    // commit(), not apply(): crash breadcrumbs must survive an imminent abort
    prefs.edit().putString("txt:$key", value).commit()
    promise.resolve(null)
  }
}
