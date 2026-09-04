package com.singzplayer

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.singzplayer.audio.AudioInputPolicy
import com.singzplayer.playback.NativePlaybackBridgeSchema
import com.singzplayer.playback.NativePlaybackGraphConnectionJni
import com.singzplayer.playback.NativePlaybackGraphNodeJni
import com.singzplayer.playback.NativePlaybackPathPolicy
import com.singzplayer.split.SingzCore
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONArray
import org.json.JSONObject

/**
 * Android Phase 4 playback product boundary. All lifecycle/device work and
 * JNI calls happen on one ordinary control thread. Oboe invokes only the
 * native zcore -> zdsp callback; Java is never reachable from real time.
 */
class NativeAudioRuntimeModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx), LifecycleEventListener {

  override fun getName(): String = "NativeAudioRuntime"

  private val audioManager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val handler = Handler(Looper.getMainLooper())
  private val control = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "singz-native-playback-control")
  }
  private val invalidated = AtomicBoolean(false)
  private val currentGeneration = AtomicLong(0)
  @Volatile private var focusGeneration = 0L
  @Volatile private var focusOwned = false
  private var callbackRegistered = false

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    if (change == AudioManager.AUDIOFOCUS_GAIN || invalidated.get()) return@OnAudioFocusChangeListener
    val generation = currentGeneration.get()
    if (generation <= 0) return@OnAudioFocusChangeListener
    // Every loss/duck is fail-closed. GAIN never restarts automatically: the
    // product must observe Unloaded and explicitly prepare/open/start again.
    SingzCore.nativePlaybackRequestCancellation(generation)
    post {
      runCatching { SingzCore.nativePlaybackUnload(generation) }
      abandonFocus(generation)
      currentGeneration.compareAndSet(generation, 0)
    }
  }

  private val focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
    .setAudioAttributes(
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
        .build()
    )
    .setAcceptsDelayedFocusGain(false)
    .setWillPauseWhenDucked(true)
    .setOnAudioFocusChangeListener(focusListener, handler)
    .build()

  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = routeChanged()
    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = routeChanged()
  }

  override fun initialize() {
    super.initialize()
    ctx.addLifecycleEventListener(this)
    if (!callbackRegistered) {
      audioManager.registerAudioDeviceCallback(deviceCallback, handler)
      callbackRegistered = true
    }
    post { runCatching { refreshHostInventory() } }
  }

  override fun invalidate() {
    if (!invalidated.compareAndSet(false, true)) return
    ctx.removeLifecycleEventListener(this)
    if (callbackRegistered) {
      audioManager.unregisterAudioDeviceCallback(deviceCallback)
      callbackRegistered = false
    }
    val generation = currentGeneration.get()
    if (generation > 0) SingzCore.nativePlaybackRequestCancellation(generation)
    val stopped = CountDownLatch(1)
    try {
      control.execute {
        try {
          if (generation > 0) runCatching { SingzCore.nativePlaybackUnload(generation) }
          abandonFocus(generation)
        } finally {
          stopped.countDown()
        }
      }
      control.shutdown()
      stopped.await(3, TimeUnit.SECONDS)
    } catch (_: Throwable) {
      control.shutdownNow()
    }
    super.invalidate()
  }

  override fun onHostResume() = Unit
  override fun onHostPause() = Unit
  override fun onHostDestroy() = invalidate()

  @ReactMethod
  fun status(promise: Promise) {
    if (!postResult(promise) {
      requireCore()
      refreshHostInventory()
      SingzCore.nativePlaybackStatus()
    }) rejectUnavailable(promise)
  }

  /** The session block alone, for the telemetry poll. Deliberately NOT
   *  refreshHostInventory(): status() re-enumerates every audio device and
   *  hands the core eight arrays on every call, and the poll never read the
   *  result — route changes reach the core through the AudioDeviceCallback
   *  above. Same name and arity as the iOS bridge's session. */
  @ReactMethod
  fun session(promise: Promise) {
    if (!postResult(promise) {
      requireCore()
      SingzCore.nativePlaybackSession()
    }) rejectUnavailable(promise)
  }

  /** Where the song is RIGHT NOW: the player's clock, read the way the legacy
   *  engine reads its AudioContext's currentTime. Blocking-synchronous on
   *  purpose, and the only such method here: it runs on the JS thread, many
   *  times a second, and answers from the core's lock-free publication — no
   *  control-thread hop (prepare and stop can hold that thread for seconds),
   *  no JSON, no device inventory. A core that is not loaded answers
   *  `available: false` rather than throwing into the caller's render.
   *  Same name and arity (none) as the iOS bridge's positionNow; the state
   *  codes are the core enum's own values, pinned by a static_assert beside
   *  the JNI function. */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun positionNow(): WritableMap {
    val map = Arguments.createMap()
    if (invalidated.get() || SingzCore.ensureLoaded() != null) {
      map.putBoolean("available", false)
      return map
    }
    val v = SingzCore.nativePlaybackPositionNow()
    if (v.size < 8) {
      map.putBoolean("available", false)
      return map
    }
    map.putBoolean("available", v[0] != 0.0)
    map.putDouble("generation", v[1])
    map.putString(
      "transportState",
      when (v[2].toInt()) {
        1 -> "pre-roll"
        2 -> "playing"
        3 -> "paused"
        4 -> "completed"
        else -> "stopped"
      },
    )
    map.putDouble("renderedProjectFrame", v[3])
    map.putDouble("continuousFrame", v[4])
    map.putDouble("remainingPreRollFrames", v[5])
    map.putDouble("seekCount", v[6])
    map.putDouble("ageMs", v[7])
    return map
  }

  /** Hold a PARKED generation's output stream without closing it — the
   *  background park on Android. The transport is already paused; without
   *  this the AAudio callback kept rendering the whole graph as silence
   *  behind the home screen, at four times the CPU of the legacy engine's
   *  suspended context. Audio focus is kept: a held song is still ours, and
   *  the next Play is resumeOutput then a transport resume, not a fresh
   *  focus request. Same name and arity as the iOS bridge's suspendOutput. */
  @ReactMethod
  fun suspendOutput(generationValue: Double, promise: Promise) {
    command(generationValue, promise) { generation ->
      requiredJson(SingzCore.nativePlaybackSuspendOutput(generation))
    }
  }

  @ReactMethod
  fun resumeOutput(generationValue: Double, promise: Promise) {
    command(generationValue, promise) { generation ->
      if (!ownsFocus(generation))
        failureResult(generation, "invalid-state", "Android audio focus is not owned").toString()
      else requiredJson(SingzCore.nativePlaybackResumeOutput(generation))
    }
  }

  @ReactMethod
  fun prepare(generationValue: Double, request: ReadableMap, promise: Promise) {
    val generation: Long
    val parsed: NativePlaybackBridgeSchema.Prepare
    val roots: List<String>
    try {
      generation = NativePlaybackBridgeSchema.generation(generationValue)
      parsed = NativePlaybackBridgeSchema.prepare(request.toHashMap())
      roots = authorizedRoots()
      val authorized = parsed.lanes.map { lane ->
        lane.copy(path = NativePlaybackPathPolicy.authorize(lane.path, roots))
      }
      requireCore()
      refreshHostInventory()
      val claim = parseJson(
        SingzCore.nativePlaybackClaim(generation, parsed.handoffLease)
          ?: throw IllegalStateException("Native playback claim returned no result")
      )
      if (!claim.getBoolean("ok")) {
        promise.resolve(jsonObjectToMap(claim))
        return
      }
      currentGeneration.set(generation)
      if (!postResult(promise) {
        val playback = parsed.playback
        val grid = playback?.beatGrid
        val training = parsed.training
        val trainingWindows =
          (training as? NativePlaybackBridgeSchema.Training.Windows)?.windows.orEmpty()
        val graph = parsed.graphDocument
        val result = SingzCore.nativePlaybackPrepare(
          generation,
          parsed.outputDeviceUid,
          parsed.outputChannels,
          parsed.sampleRate,
          parsed.maximumFrames,
          parsed.bufferFrames,
          parsed.masterGain,
          parsed.maximumRetainedBytes,
          parsed.handoffLease,
          parsed.swapFromGeneration,
          parsed.preparedStartProjectFrame != null,
          parsed.preparedStartProjectFrame ?: 0L,
          parsed.initialTransport.startPaused,
          parsed.initialTransport.loop != null,
          parsed.initialTransport.loop?.startProjectFrame ?: 0L,
          parsed.initialTransport.loop?.endProjectFrame ?: 0L,
          authorized.map { it.id }.toTypedArray(),
          authorized.map { it.path }.toTypedArray(),
          authorized.map { it.gain }.toFloatArray(),
          authorized.map { it.muted }.toBooleanArray(),
          authorized.map { it.solo }.toBooleanArray(),
          playback != null,
          playback?.entrySeconds ?: 0.0,
          playback?.playbackRate ?: 1.0,
          playback?.transposeSemitones ?: 0.0,
          playback?.click ?: false,
          playback?.countInBars ?: 0,
          playback?.volume ?: 0.0,
          playback?.accent ?: false,
          grid?.beats ?: doubleArrayOf(),
          grid?.beatsPerBar ?: 0,
          grid?.downbeat ?: 0,
          grid?.downbeats ?: intArrayOf(),
          training != null,
          if (training is NativePlaybackBridgeSchema.Training.Windows) 1 else 0,
          (training as? NativePlaybackBridgeSchema.Training.Period)?.periodFrames ?: 0L,
          trainingWindows.map { it.startProjectFrame }.toLongArray(),
          trainingWindows.map { it.endProjectFrame }.toLongArray(),
          training?.laneIds?.toTypedArray() ?: emptyArray(),
          training?.enabled ?: false,
          graph != null,
          graph?.nodes?.map { it.toJni() }?.toTypedArray()
            ?: emptyArray<NativePlaybackGraphNodeJni>(),
          graph?.connections?.map { it.toJni() }?.toTypedArray()
            ?: emptyArray<NativePlaybackGraphConnectionJni>(),
          roots.toTypedArray()
        )
        inheritFocusForSwap(parsed.swapFromGeneration, generation, result)
        result
      }) {
        // The synchronous claim is already authoritative. If dispatch itself
        // fails, retire that exact generation before rejecting JavaScript.
        runCatching { SingzCore.nativePlaybackRequestCancellation(generation) }
        runCatching { SingzCore.nativePlaybackUnload(generation) }
        rejectUnavailable(promise)
      }
    } catch (error: Throwable) {
      promise.reject("E_NATIVE_PLAYBACK", error.message ?: "Invalid native playback prepare", error)
    }
  }

  @ReactMethod
  fun configureOutputSession(generationValue: Double, promise: Promise) {
    command(generationValue, promise) { generation ->
      val ready = parseJson(requiredJson(SingzCore.nativePlaybackConfigured(generation)))
      if (!ready.getBoolean("ok")) return@command ready.toString()
      val granted = audioManager.requestAudioFocus(focusRequest) ==
        AudioManager.AUDIOFOCUS_REQUEST_GRANTED
      if (!granted) {
        return@command failureResult(
          generation,
          "invalid-state",
          "Android denied media audio focus"
        ).toString()
      }
      focusGeneration = generation
      focusOwned = true
      ready.toString()
    }
  }

  @ReactMethod
  fun openOutput(generationValue: Double, promise: Promise) {
    command(generationValue, promise) { generation ->
      if (!ownsFocus(generation))
        failureResult(generation, "invalid-state", "Android audio focus is not owned").toString()
      else requiredJson(SingzCore.nativePlaybackOpenOutput(generation))
    }
  }

  @ReactMethod
  fun start(generationValue: Double, promise: Promise) {
    command(generationValue, promise) { generation ->
      if (!ownsFocus(generation))
        failureResult(generation, "invalid-state", "Android audio focus is not owned").toString()
      else requiredJson(SingzCore.nativePlaybackStart(generation))
    }
  }

  @ReactMethod
  fun stop(generationValue: Double, promise: Promise) {
    val generation = parseGenerationOrReject(generationValue, promise) ?: return
    SingzCore.nativePlaybackRequestCancellation(generation)
    if (!postResult(promise) {
      val result = requiredJson(SingzCore.nativePlaybackStop(generation))
      abandonFocus(generation)
      result
    }) rejectUnavailable(promise)
  }

  /**
   * The prepared lane envelopes for one generation. One argument plus the
   * promise, exactly like iOS's lanePeaks. Immutable for the generation, so
   * the caller reads it once and caches it.
   */
  @ReactMethod
  fun lanePeaks(generationValue: Double, promise: Promise) {
    val generation = parseGenerationOrReject(generationValue, promise) ?: return
    if (!postResult(promise) {
      requiredJson(SingzCore.nativePlaybackLanePeaks(generation))
    }) rejectUnavailable(promise)
  }

  @ReactMethod
  fun unload(generationValue: Double, promise: Promise) {
    val generation = parseGenerationOrReject(generationValue, promise) ?: return
    SingzCore.nativePlaybackRequestCancellation(generation)
    if (!postResult(promise) {
      val result = requiredJson(SingzCore.nativePlaybackUnload(generation))
      abandonFocus(generation)
      currentGeneration.compareAndSet(generation, 0)
      result
    }) rejectUnavailable(promise)
  }

  /**
   * Unload, keeping this generation's decoded lanes for the next prepare of
   * the same files. One argument plus the promise, exactly like unload above
   * and exactly like iOS's unloadRetainingLanes — an arity that disagrees
   * with JS is never dispatched and never says so. The resolved shape is
   * unload's, including cleanup.parkedLaneBytes.
   */
  @ReactMethod
  fun unloadRetainingLanes(generationValue: Double, promise: Promise) {
    val generation = parseGenerationOrReject(generationValue, promise) ?: return
    SingzCore.nativePlaybackRequestCancellation(generation)
    if (!postResult(promise) {
      val result = requiredJson(SingzCore.nativePlaybackUnloadRetainingLanes(generation))
      abandonFocus(generation)
      // DELIBERATELY leaves currentGeneration set, unlike unload above. Every
      // lifecycle path here — invalidate/onHostDestroy, audio-focus loss and
      // route change — reads it and no-ops at zero. For a plain unload that is
      // harmless because nothing is held; after a RETAINING unload it would
      // strand a song's decoded PCM across backgrounding, focus loss, route
      // change and RN module teardown, in a process Android keeps alive. That
      // is the jetsam shape the explicit-free rule exists for. Holding the
      // generation until the lanes are actually gone means those paths still
      // fire, and nativePlaybackUnload releases parked lanes unconditionally
      // before it looks at the generation at all.
      result
    }) rejectUnavailable(promise)
  }

  @ReactMethod
  fun setControl(generationValue: Double, controlValue: ReadableMap, promise: Promise) {
    val parsed = try {
      NativePlaybackBridgeSchema.control(controlValue.toHashMap())
    } catch (error: Throwable) {
      promise.reject("E_NATIVE_PLAYBACK", error.message ?: "Invalid native playback control", error)
      return
    }
    command(generationValue, promise) { generation ->
      when (parsed) {
        is NativePlaybackBridgeSchema.Control.LaneControl -> requiredJson(
          SingzCore.nativePlaybackSetLaneControl(
            generation, parsed.laneId, parsed.gain, parsed.muted, parsed.solo
          )
        )
        is NativePlaybackBridgeSchema.Control.MasterGain -> requiredJson(
          SingzCore.nativePlaybackSetMasterGain(generation, parsed.gain)
        )
        is NativePlaybackBridgeSchema.Control.TrainingEnabled -> requiredJson(
          SingzCore.nativePlaybackSetTrainingEnabled(generation, parsed.enabled)
        )
      }
    }
  }

  @ReactMethod
  fun transport(generationValue: Double, commandValue: ReadableMap, promise: Promise) {
    val parsed = try {
      NativePlaybackBridgeSchema.transport(commandValue.toHashMap())
    } catch (error: Throwable) {
      promise.reject("E_NATIVE_PLAYBACK", error.message ?: "Invalid native playback transport", error)
      return
    }
    command(generationValue, promise) { generation ->
      requiredJson(
        when (parsed) {
          NativePlaybackBridgeSchema.Transport.Pause -> SingzCore.nativePlaybackPause(generation)
          NativePlaybackBridgeSchema.Transport.Resume -> SingzCore.nativePlaybackResume(generation)
          is NativePlaybackBridgeSchema.Transport.Seek ->
            SingzCore.nativePlaybackSeek(generation, parsed.projectFrame)
          is NativePlaybackBridgeSchema.Transport.SetLoop -> SingzCore.nativePlaybackSetLoop(
            generation, parsed.startProjectFrame, parsed.endProjectFrame
          )
          NativePlaybackBridgeSchema.Transport.ClearLoop ->
            SingzCore.nativePlaybackClearLoop(generation)
          NativePlaybackBridgeSchema.Transport.Reanchor ->
            SingzCore.nativePlaybackReanchor(generation)
        }
      )
    }
  }

  @ReactMethod
  fun previewClick(generationValue: Double, soundValue: Double, promise: Promise) {
    val sound = try {
      NativePlaybackBridgeSchema.previewClickSound(soundValue)
    } catch (error: Throwable) {
      promise.reject(
        "E_NATIVE_PLAYBACK_PREVIEW_SCHEMA",
        error.message ?: "Invalid native playback preview sound",
        error
      )
      return
    }
    command(generationValue, promise) { generation ->
      requiredJson(
        SingzCore.nativePlaybackPreviewClick(generation, sound.nativeValue)
      )
    }
  }

  private fun command(
    generationValue: Double,
    promise: Promise,
    operation: () -> String
  ) {
    parseGenerationOrReject(generationValue, promise) ?: return
    if (!postResult(promise, operation)) rejectUnavailable(promise)
  }

  private fun command(
    generationValue: Double,
    promise: Promise,
    operation: (Long) -> String
  ) {
    val generation = parseGenerationOrReject(generationValue, promise) ?: return
    if (!postResult(promise) { operation(generation) }) rejectUnavailable(promise)
  }

  private fun postResult(promise: Promise, operation: () -> String?): Boolean {
    if (invalidated.get()) return false
    return try {
      control.execute {
        if (invalidated.get()) {
          rejectUnavailable(promise)
          return@execute
        }
        try {
          requireCore()
          promise.resolve(jsonObjectToMap(parseJson(requiredJson(operation()))))
        } catch (error: Throwable) {
          promise.reject("E_NATIVE_PLAYBACK", error.message ?: "Native playback failed", error)
        }
      }
      true
    } catch (_: RejectedExecutionException) {
      false
    }
  }

  private fun post(operation: () -> Unit): Boolean {
    if (invalidated.get()) return false
    return try {
      control.execute {
        if (!invalidated.get()) operation()
      }
      true
    } catch (_: RejectedExecutionException) {
      false
    }
  }

  private fun routeChanged() {
    val generation = currentGeneration.get()
    if (generation > 0) {
      // AudioDeviceCallback does not identify whether Android rerouted an
      // already-open Oboe stream. Retire the owner conservatively: a fresh
      // prepare is the only operation allowed to adopt the new snapshot.
      runCatching { SingzCore.nativePlaybackRequestCancellation(generation) }
    }
    post {
      if (generation > 0) {
        runCatching { SingzCore.nativePlaybackUnload(generation) }
        abandonFocus(generation)
        currentGeneration.compareAndSet(generation, 0)
      }
      runCatching { refreshHostInventory() }
    }
  }

  private fun requireCore() {
    SingzCore.ensureLoaded()?.let {
      throw IllegalStateException("Native audio core unavailable: $it")
    }
  }

  private fun refreshHostInventory() {
    requireCore()
    val devices = audioManager.getDevices(AudioManager.GET_DEVICES_ALL)
      .filter { it.id > 0 && (it.isSource || it.isSink) }
      .distinctBy { Triple(it.id, it.isSource, it.isSink) }
      .sortedBy { it.id }
      .take(256)
    SingzCore.replaceAudioHostDevices(
      devices.map { AudioInputPolicy.portableUid(it.id) }.toTypedArray(),
      devices.map {
        it.productName?.toString()?.take(256)?.ifBlank { null }
          ?: "Android audio endpoint ${it.id}"
      }.toTypedArray(),
      devices.map { AudioInputPolicy.hostSampleRates(it.sampleRates) }.toTypedArray(),
      devices.map {
        AudioInputPolicy.channelCount(it.channelCounts, it.channelMasks, it.channelIndexMasks)
      }.toIntArray(),
      devices.map { it.isSource }.toBooleanArray(),
      devices.map { it.isSink }.toBooleanArray(),
      devices.map { AudioInputPolicy.hostTransport(it.type) }.toTypedArray(),
      devices.map { AudioInputPolicy.hostMonitoringSuitability(it.type) }.toTypedArray(),
      AudioInputPolicy.mediaOutputUid(
        devices.map { AudioInputPolicy.portableUid(it.id) }.toTypedArray(),
        devices.map { it.type }.toIntArray(),
        devices.map { it.isSink }.toBooleanArray()
      )
    )
  }

  private fun authorizedRoots(): List<String> = NativePlaybackPathPolicy.canonicalRoots(
    listOfNotNull(
      ctx.filesDir,
      ctx.cacheDir,
      ctx.noBackupFilesDir,
      ctx.codeCacheDir,
      ctx.getExternalFilesDir(null),
      ctx.externalCacheDir
    )
  )

  private fun ownsFocus(generation: Long): Boolean = focusOwned && focusGeneration == generation

  /** A swap prepare the core accepted takes over the stream — and the audio
   *  focus granted for it — from the generation it replaces. Focus is
   *  granted once, at configureOutputSession, to the generation that opens
   *  the stream, and every later command checks ownsFocus by generation; a
   *  swap opens nothing, so without this the replacement owned the stream
   *  and not the focus, and the first resumeOutput after a background hold
   *  was refused with "audio focus is not owned" — measured on the POCO as
   *  a song that never came back from the home screen. */
  private fun inheritFocusForSwap(from: Long, to: Long, result: String?) {
    if (from == 0L || result == null) return
    val accepted = runCatching { parseJson(result).getBoolean("ok") }.getOrDefault(false)
    if (accepted && ownsFocus(from)) focusGeneration = to
  }

  private fun abandonFocus(generation: Long) {
    if (!focusOwned || focusGeneration != generation) return
    audioManager.abandonAudioFocusRequest(focusRequest)
    focusOwned = false
    focusGeneration = 0
  }

  private fun parseGenerationOrReject(value: Double, promise: Promise): Long? = try {
    NativePlaybackBridgeSchema.generation(value)
  } catch (error: Throwable) {
    promise.reject("E_NATIVE_PLAYBACK", error.message ?: "Invalid native playback generation", error)
    null
  }

  private fun requiredJson(value: String?): String =
    value ?: throw IllegalStateException("Native playback returned no result")

  private fun parseJson(value: String): JSONObject = JSONObject(value)

  private fun failureResult(generation: Long, error: String, message: String): JSONObject =
    JSONObject()
      .put("ok", false)
      .put("error", error)
      .put("generation", generation)
      .put("state", "terminal")
      .put("sampleRate", 0)
      .put("maximumFrames", 0)
      .put("nominalBufferFrames", 0)
      .put("outputChannels", 0)
      .put("message", message)

  private fun rejectUnavailable(promise: Promise) {
    promise.reject("E_NATIVE_PLAYBACK", "The native playback control queue is unavailable")
  }

  private fun jsonObjectToMap(source: JSONObject): WritableMap {
    val result = Arguments.createMap()
    val keys = source.keys()
    while (keys.hasNext()) {
      val key = keys.next()
      putJson(result, key, source.get(key))
    }
    return result
  }

  private fun jsonArrayToArray(source: JSONArray): WritableArray {
    val result = Arguments.createArray()
    for (index in 0 until source.length()) {
      when (val value = source.get(index)) {
        JSONObject.NULL -> result.pushNull()
        is Boolean -> result.pushBoolean(value)
        is Number -> result.pushDouble(value.toDouble())
        is String -> result.pushString(value)
        is JSONObject -> result.pushMap(jsonObjectToMap(value))
        is JSONArray -> result.pushArray(jsonArrayToArray(value))
        else -> throw IllegalArgumentException("Unsupported native playback JSON value")
      }
    }
    return result
  }

  private fun putJson(target: WritableMap, key: String, value: Any) {
    when (value) {
      JSONObject.NULL -> target.putNull(key)
      is Boolean -> target.putBoolean(key, value)
      is Number -> target.putDouble(key, value.toDouble())
      is String -> target.putString(key, value)
      is JSONObject -> target.putMap(key, jsonObjectToMap(value))
      is JSONArray -> target.putArray(key, jsonArrayToArray(value))
      else -> throw IllegalArgumentException("Unsupported native playback JSON value")
    }
  }
}
