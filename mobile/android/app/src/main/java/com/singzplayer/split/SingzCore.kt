package com.singzplayer.split

/**
 * The shared C++ engine core (mobile/native/core, docs/PHONE-STANDALONE.md).
 * Loading is lazy and failure is a value, not a crash: an ABI the core does
 * not ship for (or a broken .so) must degrade to "splitting unavailable on
 * this phone", never take the player down with it.
 */
object SingzCore {
  @Volatile private var loadError: String? = null
  @Volatile private var loaded = false

  fun ensureLoaded(): String? {
    if (loaded) return null
    synchronized(this) {
      if (loaded) return null
      loadError?.let { return it }
      return try {
        System.loadLibrary("singzcore")
        loaded = true
        null
      } catch (t: Throwable) {
        val msg = t.message ?: t.javaClass.simpleName
        loadError = msg
        msg
      }
    }
  }

  /** Phase-0 smoke: load a model, run one dummy-shaped inference. JSON out. */
  external fun ortProbe(modelPath: String): String
}
