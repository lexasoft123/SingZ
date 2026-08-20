package com.singzplayer

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.RemoteException
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.singzplayer.split.JobStore
import com.singzplayer.split.SingzCore
import com.singzplayer.split.SplitService
import kotlin.concurrent.thread

/**
 * JS bridge to the split machinery. Production path: startSplit hands the
 * job to the :split-process foreground service and mirrors its Messenger
 * progress into DeviceEventEmitter ('singzSplitProgress'/'singzSplitState');
 * job.json (splitStatus) is the durable truth that survives both processes.
 * ortProbe and runSplitDirect stay as the in-process bring-up/parity
 * harness the sim tests drive.
 */
class SplitModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName(): String = "SingzSplit"

  // Touched from the NativeModules thread (start/attach), main (disconnect,
  // terminal state) and invalidate — @Synchronized methods below are the
  // lock, @Volatile covers the bare reads.
  @Volatile private var bound = false
  private val clientMessenger = Messenger(Handler(Looper.getMainLooper()) { msg ->
    onServiceMessage(msg)
    true
  })
  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
      try {
        Messenger(binder).send(Message.obtain(null, SplitService.MSG_REGISTER).apply {
          replyTo = clientMessenger
        })
      } catch (_: RemoteException) {}
    }
    // The :split process can die under us (watchdog, lmkd, a test's kill);
    // a stale `bound` then makes every later bindEvents() a no-op and the
    // next job runs silent. Drop the binding so the next start re-registers.
    override fun onServiceDisconnected(name: ComponentName?) = unbindEvents()
    override fun onBindingDied(name: ComponentName?) = unbindEvents()
  }

  private fun emit(event: String, params: com.facebook.react.bridge.WritableMap) {
    reactApplicationContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(event, params)
  }

  private fun onServiceMessage(msg: Message) {
    when (msg.what) {
      SplitService.MSG_PROGRESS -> {
        val d = msg.data
        val m = Arguments.createMap()
        m.putString("stage", d.getString("stage"))
        m.putDouble("frac", d.getFloat("frac").toDouble())
        m.putDouble("done", d.getLong("done").toDouble())
        m.putDouble("total", d.getLong("total").toDouble())
        emit("singzSplitProgress", m)
      }
      SplitService.MSG_STATE -> {
        val d = msg.data
        val m = Arguments.createMap()
        m.putString("state", d.getString("state"))
        d.getString("error")?.let { m.putString("error", it) }
        emit("singzSplitState", m)
        val state = d.getString("state")
        if (state != null && state != "busy") unbindEvents() // service is stopping
      }
    }
  }

  @Synchronized
  private fun bindEvents() {
    // Always a fresh binding: registration happens in onServiceConnected,
    // and only a new connect reaches a service in a NEW process.
    unbindEvents()
    val ctx = reactApplicationContext
    // flags=0: attach if running, never resurrect a stopped service.
    bound = ctx.bindService(Intent(ctx, SplitService::class.java), connection, 0)
  }

  @Synchronized
  private fun unbindEvents() {
    if (!bound) return
    bound = false
    try { reactApplicationContext.unbindService(connection) } catch (_: Exception) {}
  }

  override fun invalidate() {
    unbindEvents()
    super.invalidate()
  }

  /** Start (or resume) the one split job in the :split service. */
  @ReactMethod
  fun startSplit(
    srcPath: String,
    modelPath: String,
    projectDir: String,
    resume: Boolean,
    watchdogCapMs: Double,
    promise: Promise
  ) {
    try {
      val ctx = reactApplicationContext
      val i = Intent(ctx, SplitService::class.java)
        .setAction(SplitService.ACTION_START)
        .putExtra(SplitService.EXTRA_SRC, srcPath)
        .putExtra(SplitService.EXTRA_MODEL, modelPath)
        .putExtra(SplitService.EXTRA_PROJECT_DIR, projectDir)
        .putExtra(SplitService.EXTRA_RESUME, resume)
        .putExtra(SplitService.EXTRA_WATCHDOG_CAP_MS, watchdogCapMs.toLong())
      ctx.startForegroundService(i)
      bindEvents()
      promise.resolve(true)
    } catch (t: Throwable) {
      promise.reject("split", t)
    }
  }

  /** The job record, or null when there is none (never started, or a cancel
   *  cleaned up). The UI decides Resume/Discard off this at launch. */
  @ReactMethod
  fun splitStatus(promise: Promise) {
    try {
      val job = JobStore.read(SplitService.jobDir(reactApplicationContext))
      if (job == null) {
        promise.resolve(null)
        return
      }
      val m = Arguments.createMap()
      m.putString("state", job.state)
      m.putString("srcPath", job.srcPath)
      m.putString("projectDir", job.projectDir)
      m.putInt("srcRate", job.srcRate)
      m.putDouble("chunksDone", job.chunksDone.toDouble())
      m.putDouble("totalChunks", job.totalChunks.toDouble())
      job.error?.let { m.putString("error", it) }
      m.putDouble("updatedAtMs", job.updatedAtMs.toDouble())
      // Where the finished stems live — the adoption moves them out of here.
      m.putString("jobDir", SplitService.jobDir(reactApplicationContext).absolutePath)
      promise.resolve(m)
    } catch (t: Throwable) {
      promise.reject("status", t)
    }
  }

  /** Attach progress events after an app relaunch found a live job. */
  @ReactMethod
  fun attachSplitEvents(promise: Promise) {
    try {
      bindEvents()
      promise.resolve(bound)
    } catch (t: Throwable) {
      promise.reject("attach", t)
    }
  }

  /** Discard the job dir (stems, mix, tail, doc). The UI cancels first when
   *  the job is live — a running service would just recreate the doc. */
  @ReactMethod
  fun clearJob(promise: Promise) {
    try {
      SplitService.jobDir(reactApplicationContext).deleteRecursively()
      promise.resolve(true)
    } catch (t: Throwable) {
      promise.reject("clear", t)
    }
  }

  @ReactMethod
  fun cancelSplit(promise: Promise) {
    try {
      // The service's engine lives in the :split process — the intent is
      // the production cancel. The local flag only exists for the
      // in-process bring-up path, and only when THIS process ever loaded
      // the core (an external fun on an unloaded lib throws, and a throw
      // before the intent once ate the real cancel entirely).
      if (SingzCore.isLoaded()) SingzCore.cancelSplit()
      val ctx = reactApplicationContext
      try {
        ctx.startService(Intent(ctx, SplitService::class.java).setAction(SplitService.ACTION_CANCEL))
      } catch (_: Exception) {
        // Backgrounded with no live service = nothing to cancel.
      }
      promise.resolve(true)
    } catch (t: Throwable) {
      promise.reject("cancel", t)
    }
  }

  // --- Phase 4c: the melody tracker in the core ---------------------------

  /**
   * Phase 4b: the Beat This! grid. `wavPath` must be 22 050 Hz mono (the core
   * checks and refuses otherwise rather than resampling — a 44.1 kHz file
   * would otherwise come back as a confident grid at half the real tempo).
   * `modelsDir` holds logmel.onnx and beat_this.onnx.
   *
   * Resolves the core's JSON line PARSED, so JS gets the same object shape the
   * desktop's fetchMlGrid produces. An `error` key from the core becomes a
   * rejection here: a caller that saw `{error: …}` as a normal result would
   * store a grid-less analysis and stamp it as done.
   */
  @ReactMethod
  fun mlGrid(wavPath: String, modelsDir: String, dumpDir: String, promise: Promise) {
    mlGridCall(promise) { SingzCore.mlGrid(wavPath, modelsDir, dumpDir) }
  }

  /**
   * The same grid from the project's STEMS (44.1 kHz wavs; the core sums and
   * decimates to the model's rate itself) — the analysis pipeline's entry
   * point. Same arity and payload as iOS, per the rule at the top of
   * SingzSplit.mm.
   */
  @ReactMethod
  fun mlGridFromStems(stemPaths: ReadableArray, modelsDir: String, dumpDir: String, promise: Promise) {
    val paths = Array(stemPaths.size()) { i -> stemPaths.getString(i) ?: "" }
    mlGridCall(promise) { SingzCore.mlGridFromStems(paths, modelsDir, dumpDir) }
  }

  /** Both mlGrid entry points end here: run off-thread, parse the core's
   *  JSON line, reject an `error` object rather than resolving it — a caller
   *  that saw `{error: …}` as a normal result would store a grid-less
   *  analysis and stamp it as done. */
  private fun mlGridCall(promise: Promise, run: () -> String) {
    thread(name = "singz-mlgrid") {
      val loadErr = SingzCore.ensureLoaded()
      if (loadErr != null) {
        promise.reject("mlgrid_core", "core library: $loadErr")
        return@thread
      }
      try {
        val started = System.currentTimeMillis()
        val json = run()
        val elapsed = System.currentTimeMillis() - started
        val obj = org.json.JSONObject(json)
        if (obj.has("error")) {
          promise.reject("mlgrid", obj.getString("error"))
          return@thread
        }
        val m = Arguments.createMap()
        for (key in listOf("beats", "downbeats", "beat_prob", "downbeat_prob")) {
          val src = obj.getJSONArray(key)
          val arr = Arguments.createArray()
          for (i in 0 until src.length()) arr.pushDouble(src.getDouble(i))
          m.putArray(key, arr)
        }
        m.putInt("fps", obj.getInt("fps"))
        m.putInt("elapsedMs", elapsed.toInt())
        promise.resolve(m)
      } catch (t: Throwable) {
        promise.reject("mlgrid", t)
      }
    }
  }

  @ReactMethod
  fun analyzeMelody(wavPath: String, promise: Promise) {
    thread(name = "singz-melody") {
      val loadErr = SingzCore.ensureLoaded()
      if (loadErr != null) {
        promise.reject("melody_core", "core library: $loadErr")
        return@thread
      }
      try {
        val v = SingzCore.analyzeMelody(wavPath)
        if (v == null || v.size < 4) {
          promise.reject("melody_read", "could not read $wavPath")
          return@thread
        }
        val m = Arguments.createMap()
        m.putDouble("hopSec", v[0])
        m.putDouble("sampleRate", v[1])
        m.putDouble("durationSec", v[2])
        m.putInt("detVersion", v[3].toInt())
        m.putInt("frames", v.size - 4)
        val f0 = Arguments.createArray()
        for (i in 4 until v.size) f0.pushDouble(v[i])
        m.putArray("f0", f0)
        promise.resolve(m)
      } catch (t: Throwable) {
        promise.reject("melody", t)
      }
    }
  }

  /**
   * The beat detector in the core. Same arity and payload as iOS, per the rule
   * at the top of SingzSplit.mm — and note what the two sides do NOT share:
   * this one crosses a JSON line from C++ and parses it here, where iOS builds
   * its dictionary from the doubles directly. Kotlin's number parser is
   * correctly rounded and Foundation's is not (see beat_this.h), so the text
   * hop is safe on exactly one of the two platforms.
   *
   * `ml` is the neural lattice or null; only the three arrays the detector
   * actually reads cross (beats, downbeats, downbeatProb) plus fps.
   */
  @ReactMethod
  fun analyzeBeats(
    drumsPath: String,
    bassPath: String,
    vocalsPath: String,
    instPaths: ReadableArray,
    lineStarts: ReadableArray,
    words: ReadableArray,
    ml: ReadableMap?,
    promise: Promise
  ) {
    thread(name = "singz-beats") {
      val loadErr = SingzCore.ensureLoaded()
      if (loadErr != null) {
        promise.reject("beats_core", "core library: $loadErr")
        return@thread
      }
      try {
        val inst = Array(instPaths.size()) { instPaths.getString(it) ?: "" }
        val lines = DoubleArray(lineStarts.size()) { lineStarts.getDouble(it) }
        val flatWords = DoubleArray(words.size()) { words.getDouble(it) }
        val mlArr = { key: String ->
          val a = ml?.getArray(key)
          if (a == null) DoubleArray(0) else DoubleArray(a.size()) { a.getDouble(it) }
        }
        val started = System.currentTimeMillis()
        val json = SingzCore.analyzeBeats(
          drumsPath, bassPath, vocalsPath, inst, lines, flatWords,
          mlArr("beats"), mlArr("downbeats"), mlArr("downbeatProb"),
          if (ml != null && ml.hasKey("fps")) ml.getInt("fps") else 0
        )
        val elapsed = System.currentTimeMillis() - started
        if (json == null) {
          promise.reject("beats_read", "could not read a stem for the beat detector")
          return@thread
        }
        val obj = org.json.JSONObject(json)
        if (!obj.getBoolean("ok")) {
          // The detector's OWN refusal — no steady pulse deserves a metronome.
          // A legitimate verdict the app stores, never an error.
          promise.resolve(null)
          return@thread
        }
        val m = Arguments.createMap()
        m.putDouble("bpm", obj.getDouble("bpm"))
        m.putInt("beatsPerBar", obj.getInt("beatsPerBar"))
        m.putInt("downbeat", obj.getInt("downbeat"))
        m.putInt("detVersion", obj.getInt("detVersion"))
        m.putInt("elapsedMs", elapsed.toInt())
        val beats = obj.getJSONArray("beats")
        val ba = Arguments.createArray()
        for (i in 0 until beats.length()) ba.pushDouble(beats.getDouble(i))
        m.putArray("beats", ba)
        // Only when the core wrote them: an ABSENT downbeats and an empty one
        // are different answers upstream (the TS's undefined is not []).
        if (obj.has("downbeats")) {
          val db = obj.getJSONArray("downbeats")
          val da = Arguments.createArray()
          for (i in 0 until db.length()) da.pushInt(db.getInt(i))
          m.putArray("downbeats", da)
        }
        if (obj.has("suspectAt")) {
          val sa = obj.getJSONArray("suspectAt")
          val aa = Arguments.createArray()
          for (i in 0 until sa.length()) aa.pushDouble(sa.getDouble(i))
          m.putArray("suspectAt", aa)
        }
        promise.resolve(m)
      } catch (t: Throwable) {
        promise.reject("beats", t)
      }
    }
  }

  @ReactMethod
  fun analyzeKey(instPaths: ReadableArray, bassPath: String, promise: Promise) {
    thread(name = "singz-key") {
      val loadErr = SingzCore.ensureLoaded()
      if (loadErr != null) {
        promise.reject("key_core", "core library: $loadErr")
        return@thread
      }
      try {
        val paths = Array(instPaths.size()) { instPaths.getString(it) ?: "" }
        val v = SingzCore.analyzeKey(paths, bassPath)
        if (v == null) {
          promise.reject("key_read", "could not read a harmonic stem")
          return@thread
        }
        if (v.size < 3) {
          promise.resolve(null) // a silent bed: no key, and that is the answer
          return@thread
        }
        val m = Arguments.createMap()
        m.putInt("pc", v[0].toInt())
        m.putBoolean("minor", v[1] != 0.0)
        m.putInt("detVersion", v[2].toInt())
        promise.resolve(m)
      } catch (t: Throwable) {
        promise.reject("key", t)
      }
    }
  }

  @ReactMethod
  fun wavInfo(wavPath: String, promise: Promise) {
    thread(name = "singz-wavinfo") {
      val loadErr = SingzCore.ensureLoaded()
      if (loadErr != null) {
        promise.reject("wav_core", "core library: $loadErr")
        return@thread
      }
      try {
        val v = SingzCore.wavInfo(wavPath)
        if (v == null || v.size < 4) {
          promise.reject("wav_read", "could not read $wavPath")
          return@thread
        }
        val m = Arguments.createMap()
        m.putDouble("sampleRate", v[0])
        m.putDouble("channels", v[1])
        m.putDouble("frames", v[2])
        m.putDouble("durationSec", v[3])
        promise.resolve(m)
      } catch (t: Throwable) {
        promise.reject("wav", t)
      }
    }
  }

  // --- Phase-0/bring-up surface (sim tests + parity harness) --------------

  @ReactMethod
  fun ortProbe(modelPath: String, promise: Promise) {
    // A probe on a 136 MB graph blocks for seconds — never on the JS thread.
    thread(name = "singz-ort-probe") {
      val loadErr = SingzCore.ensureLoaded()
      if (loadErr != null) {
        promise.resolve("""{"ok":false,"error":"core library: $loadErr"}""")
        return@thread
      }
      try {
        promise.resolve(SingzCore.ortProbe(modelPath))
      } catch (t: Throwable) {
        promise.reject("probe", t)
      }
    }
  }

  /**
   * Engine-proof entry (bring-up; the :split service is the production
   * driver): run the whole split on a worker thread against a raw f32
   * stereo mix, streaming stage/chunk progress as events. Resolves "" on
   * ok, "cancelled", or the error message.
   */
  @ReactMethod
  fun runSplitDirect(
    modelPath: String,
    mixPath: String,
    jobDir: String,
    srcRate: Int,
    resumeChunk: Double,
    promise: Promise
  ) {
    thread(name = "singz-split") {
      val loadErr = SingzCore.ensureLoaded()
      if (loadErr != null) {
        promise.resolve("core library: $loadErr")
        return@thread
      }
      try {
        java.io.File(jobDir).mkdirs()
        val listener = object : SingzCore.SplitListener {
          override fun onStage(stage: String, frac: Float) {
            val m = Arguments.createMap()
            m.putString("stage", stage)
            m.putDouble("frac", frac.toDouble())
            emit("singzSplitProgress", m)
          }
          override fun onChunk(done: Long, total: Long) {
            val m = Arguments.createMap()
            m.putString("stage", "chunk")
            m.putDouble("done", done.toDouble())
            m.putDouble("total", total.toDouble())
            emit("singzSplitProgress", m)
          }
        }
        promise.resolve(
          SingzCore.runSplit(modelPath, mixPath, jobDir, srcRate, resumeChunk.toLong(), 0, listener)
        )
      } catch (t: Throwable) {
        promise.reject("split", t)
      }
    }
  }
}
