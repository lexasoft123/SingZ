package com.singzplayer

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.singzplayer.split.SingzCore
import kotlin.concurrent.thread

/**
 * JS bridge to the shared C++ engine core. Phase 0 exposes only the ORT
 * probe (model load + one dummy inference — the on-device smoke the spike
 * measures with); the split job API lands with Phase 2 and runs in the
 * :split service, not here.
 */
class SplitModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName(): String = "SingzSplit"

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
   * Engine-proof entry (Phase 2 bring-up; the :split service becomes the
   * production driver): run the whole split on a worker thread against a raw
   * f32 stereo mix, streaming stage/chunk progress as events. Resolves ""
   * on ok, "cancelled", or the error message.
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
        val emitter = reactApplicationContext.getJSModule(
          com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java
        )
        val listener = object : SingzCore.SplitListener {
          override fun onStage(stage: String, frac: Float) {
            val m = com.facebook.react.bridge.Arguments.createMap()
            m.putString("stage", stage)
            m.putDouble("frac", frac.toDouble())
            emitter.emit("singzSplitProgress", m)
          }
          override fun onChunk(done: Long, total: Long) {
            val m = com.facebook.react.bridge.Arguments.createMap()
            m.putString("stage", "chunk")
            m.putDouble("done", done.toDouble())
            m.putDouble("total", total.toDouble())
            emitter.emit("singzSplitProgress", m)
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

  @ReactMethod
  fun cancelSplit(promise: Promise) {
    try {
      SingzCore.cancelSplit()
      promise.resolve(true)
    } catch (t: Throwable) {
      promise.reject("cancel", t)
    }
  }
}
