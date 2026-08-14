package com.singzplayer

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTimestamp
import android.media.AudioTrack
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import kotlin.concurrent.thread

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

  /** Cached probe result — one probe per route, they cost ~300 ms. */
  private var probedKey = ""
  private var probedSec = -1.0

  /**
   * Measure the real presentation latency with AudioTimestamp: keep a silent
   * low-latency track full and compare frames written against frames the DAC
   * has actually presented. Unlike any AudioManager property this includes
   * the HAL/DSP chain (vendor sound effects are the usual 100 ms+ culprit).
   */
  private fun probeOutputLatencySec(): Double {
    var track: AudioTrack? = null
    return try {
      val sr = 48000
      val minBuf = AudioTrack.getMinBufferSize(
        sr, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_FLOAT
      ).coerceAtLeast(4096)
      track = AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .build()
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
            .setSampleRate(sr)
            .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
            .build()
        )
        .setBufferSizeInBytes(minBuf)
        .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
        .setTransferMode(AudioTrack.MODE_STREAM)
        .build()
      val silence = FloatArray(2400 * 2) // 50 ms of stereo silence per write
      track.play()
      var written = 0L
      val ts = AudioTimestamp()
      var best = -1.0
      // non-blocking writes only: a blocking write on a track another engine
      // (our Oboe stream) contends with can wedge forever and the promise
      // would never resolve — the exact bug this replaces
      val deadline = System.nanoTime() + 900_000_000L
      while (System.nanoTime() < deadline) {
        val n = track.write(silence, 0, silence.size, AudioTrack.WRITE_NON_BLOCKING)
        if (n > 0) written += (n / 2).toLong() else Thread.sleep(10)
        // let the pipeline reach steady state before trusting the timestamp
        if (written > sr / 5 && track.getTimestamp(ts)) {
          val presented = ts.framePosition +
            (System.nanoTime() - ts.nanoTime) * sr / 1_000_000_000L
          val pending = written - presented
          if (pending in 1..sr.toLong()) {
            best = pending.toDouble() / sr
            break
          }
        }
      }
      best
    } catch (e: Exception) {
      -1.0
    } finally {
      try {
        track?.stop()
        track?.release()
      } catch (_: Exception) {}
    }
  }

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
    thread(name = "singz-route-probe") {
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
        val key = "$portType:$portName"
        if (probedKey != key || probedSec < 0) {
          probedSec = probeOutputLatencySec()
          probedKey = key
        }
        val map = Arguments.createMap()
        map.putDouble("outputLatency", if (probedSec > 0) probedSec else 0.0)
        map.putDouble("ioBufferDuration", if (sr > 0) frames / sr else 0.0)
        map.putString("portType", portType)
        map.putString("portName", portName)
        map.putString("portUid", key)
        // Media volume, so the log can say why a song was inaudible. A phone
        // sitting at zero plays silently and the volume keys move the ringtone
        // until something is audibly playing — indistinguishable, from the
        // outside, from an app that cannot play at all. Normalized 0..1 for
        // parity with iOS (which reports outputVolume); the raw index and its
        // maximum ride along because "0 of 15" reads better in a report.
        val volIdx = am.getStreamVolume(AudioManager.STREAM_MUSIC)
        val volMax = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        map.putDouble("volume", if (volMax > 0) volIdx.toDouble() / volMax else 0.0)
        map.putInt("volumeIndex", volIdx)
        map.putInt("volumeMax", volMax)
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("route", e.message ?: "Cannot read the audio route")
      }
    }
  }

  /**
   * The header every bug report needs and no reporter thinks to include:
   * which build, on what, with how much room. Read from the installed package
   * rather than from anything baked into JS, so it describes the copy that is
   * actually running. Memory is here because six decoded lanes cost hundreds
   * of megabytes — "which phone" and "how much free" is half the diagnosis
   * when a song refuses to open.
   */
  @ReactMethod
  fun getAppInfo(promise: Promise) {
    try {
      val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
      val code =
        if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode
        else @Suppress("DEPRECATION") pi.versionCode.toLong()
      val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val mi = ActivityManager.MemoryInfo()
      am.getMemoryInfo(mi)
      val map = Arguments.createMap()
      map.putString("version", pi.versionName ?: "")
      map.putString("build", code.toString())
      map.putString("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "")
      map.putDouble("totalMemMB", mi.totalMem / 1048576.0)
      map.putDouble("availMemMB", mi.availMem / 1048576.0)
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("appinfo", e.message ?: "Cannot read app info")
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
