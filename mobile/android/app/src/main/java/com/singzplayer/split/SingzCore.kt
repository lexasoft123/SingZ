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

  /** Progress callbacks from the engine, on the split worker thread. */
  interface SplitListener {
    fun onStage(stage: String, frac: Float)
    fun onChunk(done: Long, total: Long)
  }

  /** Phase-0 smoke: load a model, run one dummy-shaped inference. JSON out. */
  external fun ortProbe(modelPath: String): String

  /**
   * The whole split, ON THE CALLING THREAD (own a worker for it): raw f32
   * stereo mix in, six <stem>.wav.part + resume tail in jobDir out.
   * Returns "" on ok, "cancelled", or an error message.
   */
  external fun runSplit(
    modelPath: String,
    mixPath: String,
    jobDir: String,
    srcRate: Int,
    resumeChunk: Long,
    threads: Int,
    listener: SplitListener?
  ): String

  /** Flip the engine's cancel flag; the segment in flight finishes first. */
  external fun cancelSplit()
}
