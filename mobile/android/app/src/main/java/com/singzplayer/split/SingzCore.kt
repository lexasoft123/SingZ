package com.singzplayer.split

/**
 * The shared top-level C++ zcore package (docs/PHONE-STANDALONE.md).
 * Loading is lazy and failure is a value, not a crash: an ABI the core does
 * not ship for (or a broken .so) must degrade to "splitting unavailable on
 * this phone", never take the player down with it.
 */
object SingzCore {
  @Volatile private var loadError: String? = null
  @Volatile private var loaded = false

  /** True only after a successful ensureLoaded() in THIS process. */
  fun isLoaded(): Boolean = loaded

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

  /** Analyzed live-input evidence. Raw microphone PCM never crosses JNI. */
  interface AudioInputListener {
    fun onFrame(
      ownershipGeneration: Long,
      clockDomainId: Long,
      streamGeneration: Long,
      startSequence: Long,
      endSequence: Long,
      startSourceFrame: Long,
      endSourceFrame: Long,
      sampleHostTimeStartNs: Long,
      sampleHostTimeEndNs: Long,
      callbackHostTimeNs: Long,
      startFlags: Int,
      endFlags: Int,
      timestampQuality: Int,
      discontinuityReason: Int,
      resetCount: Long,
      sampleRate: Double,
      frequency: Double,
      clarity: Double,
      peak: Double,
      rms: Double,
      dbfs: Double
    )
  }

  /** Replace the AudioManager-owned endpoint snapshot used by AAudio. */
  external fun replaceAudioInputDevices(
    uids: Array<String>,
    labels: Array<String>,
    sampleRates: DoubleArray,
    channels: IntArray
  )

  /** Java AudioManager remains the authoritative dormant AudioHost inventory. */
  external fun replaceAudioHostDevices(
    uids: Array<String>,
    labels: Array<String>,
    sampleRates: Array<IntArray>,
    channels: IntArray,
    inputs: BooleanArray,
    outputs: BooleanArray,
    transports: Array<String>,
    monitoringSuitability: Array<String>
  )

  /** Packaging probe only; it never opens a device or acquires audio focus. */
  external fun hasAndroidAudioHostProvider(): Boolean

  /**
   * [error, actualDeviceUid, sampleRate, deviceChannels, selectedChannel,
   * sampleFormat, sharingMode, performanceMode, inputPreset, timestampSource].
   */
  external fun startAudioInput(
    deviceUid: String,
    channel: Int,
    ownershipGeneration: Long,
    listener: AudioInputListener
  ): Array<String>

  /** Synchronously tears down capture; true means the native owner is gone. */
  external fun stopAudioInput(): Boolean
  external fun audioInputState(): String
  external fun audioInputLastError(): String
  /** delivered blocks, delivered frames, core-ring overruns, wakeups. */
  external fun audioInputStats(): LongArray

  /** Phase-0 smoke: load a model, run one dummy-shaped inference. JSON out. */
  external fun ortProbe(modelPath: String): String

  /**
   * Phase 4c: the melody tracker (core melody.cpp — the desktop's pyin,
   * bit-identical). Reads the WAV itself; returns [hopSec, sampleRate,
   * durationSec, detVersion, f0 per hop...], or an empty array when the file could
   * not be read. ON THE CALLING THREAD — a four-minute song is ~1 s.
   */
  external fun analyzeMelody(wavPath: String): DoubleArray?

  /** [sampleRate, channels, frames, durationSec] of a WAV, or empty. */
  external fun wavInfo(wavPath: String): DoubleArray?

  /** One stem of the v1->v2 upgrade: encode wav -> flac (verify on, .part
   *  rename, wav deleted on success; idempotent when the flac exists). One
   *  JSON line back — {"ok":true,"bytes":N,"skipped":b} or {"ok":false,
   *  "error":"…"}. */
  external fun encodeFlac(wavPath: String, flacPath: String): String?

  /**
   * Phase 4b: the Beat This! grid (core beat_this.cpp — the desktop packs'
   * beat_runner_onnx.py, ported). `wavPath` must be 22 050 Hz MONO and is
   * checked, not resampled: at 44.1 kHz this would return a grid at half the
   * real tempo with nothing reporting a problem. `modelsDir` holds
   * logmel.onnx and beat_this.onnx.
   *
   * Returns the desktop's one JSON line — beats, downbeats, beat_prob,
   * downbeat_prob, fps — or `{"error":"…"}`. An error object rather than an
   * empty string because "this song has no grid" and "the models are not
   * downloaded" are different answers and the caller must be able to tell
   * them apart. ON THE CALLING THREAD; ~6 s of work for a 40 s song.
   */
  external fun mlGrid(wavPath: String, modelsDir: String, dumpDir: String): String

  /**
   * The same grid from the project's STEMS: 44.1 kHz wav paths in, the core
   * sums and decimates them to the model's 22.05 kHz itself (sumStemsTo22k —
   * the desktop's fetchMlGrid mix, natively), so no audio crosses a JS
   * runtime for this. Same JSON line or `{"error":"…"}` out. ON THE CALLING
   * THREAD; reading + summing adds a second or two to mlGrid's cost.
   */
  external fun mlGridFromStems(stemPaths: Array<String>, modelsDir: String, dumpDir: String): String

  /**
   * Phase 4d: the beat detector (core beats.cpp + courts.cpp — the desktop's
   * whole `detectBeats`, bit-identical: the neural fork, the drums-first
   * tracker, the splices, the bar phase, the head backcast and the v20
   * courts). Reads its stems from disk, so no audio crosses a JS runtime.
   *
   * `bassPath`/`vocalsPath` may be "" (absent). `words` is a FLAT
   * [s0,e0,s1,e1,…] array — the v20 meter court's witness — and an odd length
   * is a caller bug, not half a word. The neural lattice arrives as its three
   * arrays plus fps; `beatProb` is deliberately not among them, because
   * nothing in detectBeats or the courts reads it and it is ~12 000 doubles
   * per four-minute song.
   *
   * Returns the grid as one JSON line — `{"ok":false}` is the detector's own
   * refusal (a drumless or rubato song), which the app stores as a verdict —
   * or `null` when a stem could not be READ, which is a different answer and
   * must not be mistaken for it. ON THE CALLING THREAD; seconds for a
   * four-minute song.
   */
  external fun analyzeBeats(
    drumsPath: String,
    bassPath: String,
    vocalsPath: String,
    instPaths: Array<String>,
    lineStarts: DoubleArray,
    words: DoubleArray,
    mlBeats: DoubleArray,
    mlDownbeats: DoubleArray,
    mlDownbeatProb: DoubleArray,
    mlFps: Int
  ): String?

  /**
   * Phase 4c: the key detector (core analysis.cpp — the desktop's
   * estimateKeyFromStems, bit-identical). Returns [pc, minor(0/1),
   * detVersion], or an EMPTY array when the harmonic bed is silent — which
   * is an answer ("no key"), not a failure. ON THE CALLING THREAD.
   */
  external fun analyzeKey(instPaths: Array<String>, bassPath: String): DoubleArray?

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
