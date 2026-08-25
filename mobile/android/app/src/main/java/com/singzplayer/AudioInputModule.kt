package com.singzplayer

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.singzplayer.audio.AudioInputOwnership
import com.singzplayer.audio.AudioInputPolicy
import com.singzplayer.audio.AudioInputStopController
import com.singzplayer.split.SingzCore
import java.util.concurrent.Executors
import java.util.concurrent.CountDownLatch
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * AudioManager owns endpoint discovery; AAudio in the shared C++ core owns
 * capture. This bridge deliberately does not set MODE_IN_COMMUNICATION,
 * communicationDevice, audio focus, or a process route: react-native-audio-api
 * remains the only playback-session owner.
 *
 * RECORD_AUDIO is checked here but never requested here. The TypeScript
 * coordinator may request it only from an explicit singer action.
 */
class AudioInputModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  data class Device(
    val id: Int,
    val uid: String,
    val label: String,
    val channels: Int,
    val sampleRate: Double,
    val isPreferred: Boolean,
    val transport: String,
    val highLatency: Boolean,
    val note: String?
  )

  data class Negotiated(
    val deviceUid: String,
    val sampleRate: Double,
    val deviceChannels: Int,
    val selectedChannel: Int,
    val sampleFormat: String,
    val sharingMode: String,
    val performanceMode: String,
    val inputPreset: String,
    val timestampSource: String
  )

  override fun getName(): String = "AudioInput"

  private val audioManager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val ownership = AudioInputOwnership()
  private val stopController = AudioInputStopController(ownership) { stopNative() }
  private val control = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "singz-audio-input-control")
  }
  private val monitor = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "singz-audio-input-state")
  }
  private var monitorFuture: ScheduledFuture<*>? = null
  private val callbackHandler = Handler(Looper.getMainLooper())
  private var callbackRegistered = false

  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
      postControl {
        if (!ownership.isInvalidated()) runCatching { refreshRegistry() }
      }
    }

    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
      postControl {
        if (ownership.isInvalidated()) return@postControl
        for (device in removedDevices) {
          val held = ownership.removeDevice(device.id) ?: continue
          bestEffortStopNative()
          emitState(held, "error", "Android audio input was disconnected")
        }
        runCatching { refreshRegistry() }
      }
    }
  }

  override fun initialize() {
    super.initialize()
    if (!callbackRegistered) {
      audioManager.registerAudioDeviceCallback(deviceCallback, callbackHandler)
      callbackRegistered = true
    }
  }

  override fun invalidate() {
    // Close the gate synchronously so a start already running on `control`
    // cannot publish success after React has begun tearing the module down.
    ownership.invalidate()
    if (callbackRegistered) {
      audioManager.unregisterAudioDeviceCallback(deviceCallback)
      callbackRegistered = false
    }
    val stopped = CountDownLatch(1)
    try {
      control.execute {
        try {
          bestEffortStopNative()
        } finally {
          stopped.countDown()
        }
      }
      // shutdown() preserves the queued stop barrier but rejects every later
      // device callback/React operation. AAudio start has its own 2 s bound.
      control.shutdown()
      stopped.await(3, TimeUnit.SECONDS)
    } catch (_: RejectedExecutionException) {
      stopped.countDown()
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
    monitor.shutdownNow()
    super.invalidate()
  }

  @ReactMethod
  fun listInputs(promise: Promise) {
    val settlement = PromiseSettlement(promise)
    if (!postControl {
      if (ownership.isInvalidated()) {
        settlement.reject("audio_input_invalidated", "Android audio input is shutting down")
        return@postControl
      }
      try {
        val devices = refreshRegistry()
        val array = Arguments.createArray()
        for (device in devices) {
          val map = Arguments.createMap()
          map.putString("uid", device.uid)
          map.putString("label", device.label)
          map.putInt("channels", device.channels)
          map.putDouble("sampleRate", device.sampleRate)
          map.putBoolean("isPreferred", device.isPreferred)
          map.putString("transport", device.transport)
          map.putBoolean("highLatency", device.highLatency)
          if (device.note != null) map.putString("note", device.note)
          val labels = Arguments.createArray()
          repeat(device.channels) { labels.pushString("Channel ${it + 1}") }
          map.putArray("channelLabels", labels)
          array.pushMap(map)
        }
        settlement.resolve(array)
      } catch (error: Throwable) {
        settlement.reject("audio_input_list", error.message ?: "Cannot list Android audio inputs")
      }
    }) settlement.reject("audio_input_invalidated", "Android audio input is shutting down")
  }

  @ReactMethod
  fun start(owner: String, deviceUid: String, channel: Double, promise: Promise) {
    val settlement = PromiseSettlement(promise)
    if (!postControl {
      if (ownership.isInvalidated()) {
        settlement.resolve(result(false, "Android audio input is shutting down"))
        return@postControl
      }
      if (ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        settlement.resolve(result(false, "Microphone permission has not been granted"))
        return@postControl
      }
      val selectedChannel = channel.toInt()
      if (!channel.isFinite() || channel != selectedChannel.toDouble() || selectedChannel < 0) {
        settlement.resolve(result(false, "Android audio input channel is invalid"))
        return@postControl
      }
      val devices = try {
        refreshRegistry()
      } catch (error: Throwable) {
        settlement.resolve(result(false, error.message ?: "Cannot refresh Android audio inputs"))
        return@postControl
      }
      val device = devices.firstOrNull { it.uid == deviceUid }
      if (device == null || selectedChannel >= device.channels) {
        settlement.resolve(result(false, "Android audio input device or channel is unavailable"))
        return@postControl
      }
      val held = ownership.acquire(owner, device.id)
      if (held == null) {
        settlement.resolve(
          result(
            false,
            if (ownership.isInvalidated()) "Android audio input is shutting down"
            else "Another Android audio input owner is active"
          )
        )
        return@postControl
      }
      var nativeStartAttempted = false
      try {
        val listener = object : SingzCore.AudioInputListener {
          override fun onFrame(
            startSequence: Long,
            endSequence: Long,
            sampleHostTimeStartNs: Long,
            sampleHostTimeEndNs: Long,
            callbackHostTimeNs: Long,
            timestampQuality: Int,
            sampleRate: Double,
            frequency: Double,
            clarity: Double,
            rms: Double,
            dbfs: Double
          ) {
            if (!ownership.isCurrent(held)) return
            val frame = Arguments.createMap()
            frame.putDouble("generation", held.generation.toDouble())
            // Nanosecond host times exceed JavaScript's exact integer range.
            frame.putString("startSequence", startSequence.toString())
            frame.putString("endSequence", endSequence.toString())
            frame.putString("sampleHostTimeStartNs", sampleHostTimeStartNs.toString())
            frame.putString("sampleHostTimeEndNs", sampleHostTimeEndNs.toString())
            frame.putString("callbackHostTimeNs", callbackHostTimeNs.toString())
            frame.putString(
              "timestampQuality",
              when (timestampQuality) {
                1 -> "hardware"
                2 -> "callback-estimate"
                else -> "unknown"
              }
            )
            frame.putDouble("sampleRate", sampleRate)
            frame.putDouble("frequency", frequency)
            frame.putDouble("clarity", clarity)
            frame.putDouble("rms", rms)
            frame.putDouble("dbfs", dbfs)
            emit("singzAudioInputFrame", frame)
          }
        }
        // A JNI exception can arrive after native capture has opened but before
        // the negotiated metadata array reaches Kotlin (for example, an
        // allocation failure while constructing the return value). Once the
        // call is attempted, every exceptional exit must therefore stop the
        // native owner, even if Kotlin never observed a successful result.
        nativeStartAttempted = true
        val nativeResult = SingzCore.startAudioInput(device.uid, selectedChannel, listener)
        val error = nativeResult.getOrElse(0) { "Android native audio input returned no result" }
        if (error.isNotEmpty()) {
          bestEffortStopNative()
          ownership.release(held.owner, held.generation)
          settlement.resolve(result(false, error))
          return@postControl
        }
        if (!ownership.isCurrent(held)) {
          bestEffortStopNative()
          settlement.resolve(result(false, "Android audio input was cancelled during shutdown"))
          return@postControl
        }
        val negotiated = parseNegotiated(nativeResult)
        if (negotiated == null || negotiated.deviceUid != device.uid ||
          negotiated.selectedChannel != selectedChannel ||
          selectedChannel >= negotiated.deviceChannels) {
          bestEffortStopNative()
          ownership.release(held.owner, held.generation)
          settlement.resolve(result(false, "Android audio input negotiation was inconsistent"))
          return@postControl
        }
        watchNativeState(held)
        emitState(held, "running", null)
        settlement.resolve(result(true, null, held.generation, negotiated))
      } catch (failure: Throwable) {
        if (nativeStartAttempted) bestEffortStopNative()
        ownership.release(held.owner, held.generation)
        settlement.resolve(
          result(false, failure.message ?: "Android native audio input could not start")
        )
      }
    }) settlement.resolve(result(false, "Android audio input is shutting down"))
  }

  @ReactMethod
  fun stop(owner: String, generation: Double, promise: Promise) {
    val settlement = PromiseSettlement(promise)
    if (!postControl {
      if (ownership.isInvalidated()) {
        settlement.resolve(false)
        return@postControl
      }
      val token = generation.toLong()
      if (!generation.isFinite() || generation != token.toDouble()) {
        settlement.resolve(false)
        return@postControl
      }
      val held = try {
        stopController.stop(owner, token)
      } catch (_: Throwable) {
        null
      }
      if (held == null) {
        settlement.resolve(false)
        return@postControl
      }
      emitState(held, "stopped", null)
      settlement.resolve(true)
    }) settlement.resolve(false)
  }

  @ReactMethod
  fun stats(promise: Promise) {
    val settlement = PromiseSettlement(promise)
    if (!postControl {
      if (ownership.isInvalidated()) {
        settlement.resolve(null)
        return@postControl
      }
      try {
        if (SingzCore.ensureLoaded() != null) {
          settlement.resolve(null)
          return@postControl
        }
        val values = SingzCore.audioInputStats()
        val map = Arguments.createMap()
        map.putDouble("deliveredBlocks", values.getOrElse(0) { 0 }.toDouble())
        map.putDouble("deliveredFrames", values.getOrElse(1) { 0 }.toDouble())
        map.putDouble("overruns", values.getOrElse(2) { 0 }.toDouble())
        map.putDouble("wakeups", values.getOrElse(3) { 0 }.toDouble())
        settlement.resolve(map)
      } catch (_: Throwable) {
        settlement.resolve(null)
      }
    }) settlement.resolve(null)
  }

  // Required by React Native event-emitter modules.
  @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}
  @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) {}

  private fun refreshRegistry(): List<Device> {
    SingzCore.ensureLoaded()?.let { throw IllegalStateException("Native audio core unavailable: $it") }
    val raw = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
      .filter { it.id > 0 }
      .distinctBy { it.id }
      .sortedWith(
        compareByDescending<AudioDeviceInfo> { AudioInputPolicy.inputPreference(it.type) }
          .thenBy { it.id }
      )
      .take(256)
    val preferredId = raw.firstOrNull()?.id
    val devices = raw.map { info ->
      val type = info.type
      Device(
        id = info.id,
        uid = AudioInputPolicy.portableUid(info.id),
        label = info.productName?.toString()?.take(256)?.ifBlank { null }
          ?: if (type == AudioDeviceInfo.TYPE_BUILTIN_MIC) "Built-in microphone" else "Audio input ${info.id}",
        channels = AudioInputPolicy.channelCount(
          info.channelCounts,
          info.channelMasks,
          info.channelIndexMasks
        ),
        sampleRate = AudioInputPolicy.sampleRate(info.sampleRates),
        isPreferred = info.id == preferredId,
        transport = AudioInputPolicy.transport(type),
        highLatency = AudioInputPolicy.highLatency(type),
        note = AudioInputPolicy.warning(type)
      )
    }
    SingzCore.replaceAudioInputDevices(
      devices.map { it.uid }.toTypedArray(),
      devices.map { it.label }.toTypedArray(),
      devices.map { it.sampleRate }.toDoubleArray(),
      devices.map { it.channels }.toIntArray()
    )
    return devices
  }

  private fun watchNativeState(held: AudioInputOwnership.Active) {
    monitorFuture?.cancel(false)
    monitorFuture = monitor.scheduleAtFixedRate({
      postControl poll@{
        if (!ownership.isCurrent(held)) return@poll
        val state = runCatching { SingzCore.audioInputState() }.getOrDefault("error")
        if (state != "error" && state != "unsupported") return@poll
        val current = ownership.release(held.owner, held.generation) ?: return@poll
        val error = runCatching { SingzCore.audioInputLastError() }.getOrDefault("")
        bestEffortStopNative()
        emitState(
          current,
          "error",
          error.ifBlank { "Android audio input stopped unexpectedly" }
        )
      }
    }, 50, 50, TimeUnit.MILLISECONDS)
  }

  private fun stopNative(): Boolean {
    monitorFuture?.cancel(false)
    monitorFuture = null
    if (SingzCore.ensureLoaded() != null) return false
    return SingzCore.stopAudioInput()
  }

  private fun bestEffortStopNative(): Boolean {
    return try {
      stopNative()
    } catch (_: Throwable) {
      false
    }
  }

  private fun result(
    ok: Boolean,
    error: String?,
    generation: Long? = null,
    negotiated: Negotiated? = null
  ) = Arguments.createMap().apply {
    putBoolean("ok", ok)
    if (error != null) putString("error", error)
    if (generation != null) putDouble("generation", generation.toDouble())
    if (negotiated != null) {
      putString("deviceUid", negotiated.deviceUid)
      putDouble("sampleRate", negotiated.sampleRate)
      putInt("deviceChannels", negotiated.deviceChannels)
      putInt("selectedChannel", negotiated.selectedChannel)
      putString("sampleFormat", negotiated.sampleFormat)
      putString("sharingMode", negotiated.sharingMode)
      putString("performanceMode", negotiated.performanceMode)
      putString("inputPreset", negotiated.inputPreset)
      putString("timestampSource", negotiated.timestampSource)
    }
  }

  private fun parseNegotiated(values: Array<String>): Negotiated? {
    if (values.size < 10 || values[0].isNotEmpty()) return null
    val rate = values[2].toDoubleOrNull() ?: return null
    val channels = values[3].toIntOrNull() ?: return null
    val selected = values[4].toIntOrNull() ?: return null
    if (!rate.isFinite() || rate <= 0 || channels !in 1..AudioInputPolicy.MAX_CHANNELS ||
      selected !in 0 until channels) return null
    return Negotiated(
      deviceUid = values[1],
      sampleRate = rate,
      deviceChannels = channels,
      selectedChannel = selected,
      sampleFormat = values[5],
      sharingMode = values[6],
      performanceMode = values[7],
      inputPreset = values[8],
      timestampSource = values[9]
    )
  }

  private fun emitState(held: AudioInputOwnership.Active, state: String, error: String?) {
    val map = Arguments.createMap()
    map.putDouble("generation", held.generation.toDouble())
    map.putString("state", state)
    if (error != null) map.putString("error", error)
    emit("singzAudioInputState", map)
  }

  private fun emit(name: String, body: Any) {
    if (ownership.isInvalidated() || !ctx.hasActiveReactInstance()) return
    runCatching {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(name, body)
    }
  }

  private fun postControl(block: () -> Unit): Boolean {
    if (ownership.isInvalidated()) return false
    return try {
      control.execute(block)
      true
    } catch (_: RejectedExecutionException) {
      false
    }
  }

  private class PromiseSettlement(private val promise: Promise) {
    private val settled = AtomicBoolean(false)

    fun resolve(value: Any?) {
      if (settled.compareAndSet(false, true)) promise.resolve(value)
    }

    fun reject(code: String, message: String) {
      if (settled.compareAndSet(false, true)) promise.reject(code, message)
    }
  }
}
