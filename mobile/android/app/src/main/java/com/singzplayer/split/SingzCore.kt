package com.singzplayer.split

import com.singzplayer.playback.NativePlaybackGraphConnectionJni
import com.singzplayer.playback.NativePlaybackGraphNodeJni

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
    monitoringSuitability: Array<String>,
    defaultOutputUid: String
  )

  /** Packaging probe only; it never opens a device or acquires audio focus. */
  external fun hasAndroidAudioHostProvider(): Boolean

  // Phase 4 native playback. Every method below is control-domain only. The
  // Oboe callback stays wholly inside zcore -> zdsp and never calls JNI.
  external fun nativePlaybackStatus(): String
  external fun nativePlaybackSession(): String
  /** Eight doubles, no JSON, no lock: available, generation, transport state
   *  code, renderedProjectFrame, continuousFrame, remainingPreRollFrames,
   *  seekCount, ageMs. The one native playback read that runs on the JS
   *  thread rather than the control thread — see NativeAudioRuntimeModule. */
  external fun nativePlaybackPositionNow(): DoubleArray
  /** Hold a parked generation's Oboe stream (AAudio pause, nothing closed)
   *  and let it go again; the result JSON is the same shape every command
   *  answers with. See NativeAudioRuntimeModule.suspendOutput. */
  external fun nativePlaybackSuspendOutput(generation: Long): String
  external fun nativePlaybackResumeOutput(generation: Long): String
  external fun nativePlaybackClaim(generation: Long, handoffLease: Long): String
  external fun nativePlaybackRequestCancellation(generation: Long): Boolean
  external fun nativePlaybackPrepare(
    generation: Long,
    outputDeviceUid: String,
    outputChannels: IntArray,
    sampleRate: Int,
    maximumFrames: Int,
    bufferFrames: Int,
    masterGain: Float,
    maximumRetainedBytes: Long,
    handoffLease: Long,
    preparedStartProjectFramePresent: Boolean,
    preparedStartProjectFrame: Long,
    initialPaused: Boolean,
    initialLoopPresent: Boolean,
    initialLoopStartProjectFrame: Long,
    initialLoopEndProjectFrame: Long,
    laneIds: Array<String>,
    lanePaths: Array<String>,
    laneGains: FloatArray,
    laneMuted: BooleanArray,
    laneSolo: BooleanArray,
    playbackPresent: Boolean,
    entrySeconds: Double,
    playbackRate: Double,
    transposeSemitones: Double,
    click: Boolean,
    countInBars: Int,
    cueVolume: Double,
    accent: Boolean,
    beats: DoubleArray,
    beatsPerBar: Int,
    downbeat: Int,
    downbeats: IntArray,
    trainingPresent: Boolean,
    trainingMode: Int,
    trainingPeriodFrames: Long,
    trainingWindowStarts: LongArray,
    trainingWindowEnds: LongArray,
    trainingLaneIds: Array<String>,
    trainingEnabled: Boolean,
    graphPresent: Boolean,
    graphNodes: Array<NativePlaybackGraphNodeJni>,
    graphConnections: Array<NativePlaybackGraphConnectionJni>,
    authorizedRoots: Array<String>
  ): String
  external fun nativePlaybackConfigured(generation: Long): String
  external fun nativePlaybackOpenOutput(generation: Long): String
  external fun nativePlaybackStart(generation: Long): String
  external fun nativePlaybackStop(generation: Long): String
  external fun nativePlaybackPause(generation: Long): String
  external fun nativePlaybackResume(generation: Long): String
  external fun nativePlaybackSeek(generation: Long, projectFrame: Long): String
  external fun nativePlaybackSetLoop(
    generation: Long,
    startProjectFrame: Long,
    endProjectFrame: Long
  ): String
  external fun nativePlaybackClearLoop(generation: Long): String
  external fun nativePlaybackReanchor(generation: Long): String
  external fun nativePlaybackPreviewClick(generation: Long, sound: Int): String
  external fun nativePlaybackSetLaneControl(
    generation: Long,
    laneId: String,
    gain: Float,
    muted: Boolean,
    solo: Boolean
  ): String
  external fun nativePlaybackSetMasterGain(generation: Long, gain: Float): String
  external fun nativePlaybackSetTrainingEnabled(generation: Long, enabled: Boolean): String
  /**
   * The prepared lane envelopes for one generation: immutable for it, so read
   * once and cache under the generation. Deliberately not part of status,
   * which is polled several times a second.
   *
   * JSON: {ok, error, generation, bucketCount, lanes[{id, peaksValid,
   * peaks[bucketCount]}], message}. `generation` is a number here and on iOS;
   * the desktop addon publishes it as a decimal string.
   */
  external fun nativePlaybackLanePeaks(generation: Long): String

  external fun nativePlaybackUnload(generation: Long): String

  /**
   * Unload that parks this generation's decoded lanes for the very next
   * prepare of the same files at the same rate — a tempo or transpose rebuild
   * then costs a graph rebuild instead of a whole re-decode. Anything else
   * releases them. iOS's unloadRetainingLanes is its exact twin.
   */
  external fun nativePlaybackUnloadRetainingLanes(generation: Long): String

  /**
   * Test-build-only full codec matrix proof. The native implementation is
   * present only with -PsingzCodecTargetProof=true and never opens audio I/O.
   */
  external fun nativeCodecTargetProof(fixturePaths: Array<String>): String

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
