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
}
