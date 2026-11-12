#pragma once

// The control-domain half of streamed playback.
//
// zdsp's streaming source (zdsp/streaming_window_source.h) plays out of a
// window and renders silence for anything the window does not hold. This is
// what keeps the window ahead of it: one thread that decodes FLAC into every
// lane's ring, chases the position the render thread publishes, and seeks when
// that position jumps.
//
// ONE thread for all lanes, not one per lane. Six threads waking each other on
// a phone is worse than one doing round-robin refills, and the measured refill
// headroom leaves room to spare — 1385x realtime for six lanes together on the
// POCO, 1637x on the Mac (docs/FLAC-STREAMING-RESEARCH.md).
//
// The overwrite hazard is handled by NEVER writing near the render thread.
// A ring is a fixed number of frames, so filling ahead eventually overwrites
// what is behind; frames within `safetyFrames` of the published demand are
// therefore off limits, and the feeder waits rather than crossing that line.
// It is the one rule that makes a torn frame impossible instead of unlikely.
//
// JUMPS are staged, not chased. The node reads ONE contiguous resident range,
// and a seek or a loop wrap moves playback somewhere that range does not hold.
// Chasing the node's published demand meant the feeder heard about a jump only
// after a block had already played silence at the target, and then paid a
// decoder seek and a refill per lane while every block kept starving: ~20
// blocks a lane per seek and ~12 a lane per wrap on the RK3588 Box. So each
// lane owns a second, STANDBY ring. The target region (a seek's landing, a
// loop's head) is decoded into it ahead of time, and the TRANSPORT, on the
// render thread and at the exact slice the position moves, swaps the window
// to it (`transportJumped`). That swap is two stores and one lock-free publish
// per lane; the feeder adopts the swapped ring afterwards and simply carries
// on decoding from where the stage ended.

#include <zcore/legacy/resample.h>
#include <zcore/media/decoded_audio.h>
#include <zcore/media/streaming_audio_source.h>
#include <zdsp/streaming_window_source.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace singz {

// The seek bar's bucket count, matching kNativePlaybackLaneSummaryBuckets.
// Stated here rather than included, because this header is deliberately below
// the session: the session depends on the feeder, not the other way round. A
// static_assert in the session keeps the two honest.
inline constexpr size_t kStreamingWaveformBuckets = 96;

struct StreamingLaneOptions {
  // Capacity of EACH of the two reusable rings. Must be a power of two.
  // The default pair totals 2097152 bytes per stereo lane (2 MiB), including
  // standby: the same ring budget as the old single 262144-frame window.
  // Each ring spans 2.73 s at 48 kHz; ordinary refills target 1.37 s ahead.
  uint64_t windowFrames{131072};
  // How far ahead of the render thread the feeder tries to stay.
  uint64_t targetAheadFrames{65536};
  // Frames behind the render position that are never overwritten. This is the
  // guard that makes the ring safe without a lock: the feeder stops filling
  // rather than write within it.
  uint64_t safetyFrames{16384};
  // How much must be resident before `prime()` reports success.
  uint64_t primeFrames{32768};
  // How much of a jump target is decoded into the standby ring before the
  // transport moves there. Enough for the feeder to find the swap and resume
  // ordinary refills from the stage's end (0.68 s at 48 kHz). Caller seeks
  // only publish a request; this decode runs on the feeder thread. A lane
  // that fits the ring stages its whole extent so even an immediate wrap
  // within the landing callback already has its head.
  uint64_t stageFrames{32768};
  // Test-only decoder latency seam; invoked off the render thread.
  void (*beforeStageDecode)(void*) noexcept {nullptr};
  void* stageDecodeContext{nullptr};
};

// Diagnostics. Every one of these is a thing that would otherwise be invisible
// on a phone: a lane that starves, a scrub that costs a seek, a feeder that
// cannot keep up.
struct StreamingLaneStats {
  uint64_t refills{0};
  uint64_t seeks{0};
  uint64_t framesDecoded{0};
  uint64_t starvedBlocks{0};
  uint64_t waitedForGuard{0};
  bool ended{false};
  // Jump targets decoded into the standby ring, how many of them the render
  // thread actually swapped in, and how many were taken back unused (the jump
  // never came, or went somewhere else).
  uint64_t stages{0};
  uint64_t swaps{0};
  uint64_t stagesAbandoned{0};
  // What the waveform pass is doing for this lane. It works on a Mac, on the
  // POCO and on the simulator, and produced nothing at all on an iPhone — and
  // "nothing" is the one answer that says nothing about why. These four say
  // whether the pass ever reached the lane, whether it had a handle to read,
  // how far it got and what stopped it.
  bool waveformSource{false};   // a second handle was opened for it
  bool waveformStarted{false};  // the pass reached this lane
  bool waveformDone{false};     // and finished it
  uint64_t waveformFrames{0};   // frames read so far
  uint32_t waveformError{0};    // the DecodedAudioStatus that stopped it, if any
  // The two numbers that tell the two remaining stories apart. A pass that is
  // slow because the FILE is slow spends its whole elapsed time inside read();
  // one that is slow because the THREAD is not being scheduled spends almost
  // none of it there and the rest waiting to run. Six real lanes measure in
  // 1.9 s on a Mac and had not finished in 390 s on an iPhone, so one of those
  // two is happening and no amount of reading the source says which.
  uint64_t waveformReadMs{0};     // wall time inside read(), this lane
  uint64_t waveformElapsedMs{0};  // wall time since this lane's pass began
  // What the pass thread actually got, rather than what it asked for.
  int32_t waveformQos{-1};        // qos_class_self(), Apple only
  int32_t waveformIoPolicy{-1};   // getiopolicy_np(DISK, THREAD), Apple only
  // Is the pass thread still there, and how long since it started?
  //
  // The lane clocks above only advance while the loop is going round, so a
  // thread that exited and a thread wedged inside one read() freeze them the
  // same way — and a phone showed 155 ms of reading, 177 ms elapsed, and then
  // nothing for another 66 s. These two separate the cases: alive with
  // sinceStart climbing and frames stuck means wedged in a read, and gone
  // without `done` means the loop returned early.
  bool waveformAlive{false};       // the pass thread is inside waveformLoop()
  // Wall time since the pass began, measured when stats() is CALLED rather
  // than inside the loop — so it keeps climbing after the loop stops, which
  // is the whole point of it.
  uint64_t waveformSinceStartMs{0};
};

class StreamingLaneGroup {
 public:
  StreamingLaneGroup();
  ~StreamingLaneGroup();

  StreamingLaneGroup(const StreamingLaneGroup&) = delete;
  StreamingLaneGroup& operator=(const StreamingLaneGroup&) = delete;

  // Open one lane. Call before `prime()`; both descriptors are consumed either
  // way.
  //
  // `requiredSampleRate` of 0 keeps the file's own rate. Anything else is the
  // DEVICE's rate and the lane is resampled into it as it is fed — which is
  // not a detail: our stems are 44.1 kHz and an iPhone's session runs at 48,
  // so the mismatch is the ordinary case and a feeder that could not resample
  // would never once be used on a phone.
  //
  // TWO descriptors because the waveform pass reads the same file
  // independently of playback: playback seeks wherever the singer goes, and a
  // linear pass sharing that decoder would be dragged along with it. An empty
  // `analysis` descriptor simply means no waveform.
  [[nodiscard]] DecodedAudioStatus addLane(OwnedFileDescriptor descriptor,
                                           OwnedFileDescriptor analysis,
                                           uint32_t requiredSampleRate);

  // Seek every lane to `startFrame` and fill `primeFrames` before returning,
  // so a caller that sees Ok may start playback immediately. This is the whole
  // cost of opening a song under streaming.
  [[nodiscard]] DecodedAudioStatus prime(uint64_t startFrame);

  // Begin chasing. Idempotent; `stop()` joins and is called by the destructor.
  void start();
  void stop();

  // Blocking ordinary-thread helpers. stageJump is for deterministic
  // feeder tests/explicit offline staging; it skips an already resident
  // target. stagePreparedStart always prepares the first Start/count-in
  // landing, before the feeder/host starts. Neither is called by seek/start.
  size_t stageJump(uint64_t sourceFrame);
  size_t stagePreparedStart(uint64_t sourceFrame);
  // Control domain: accept/coalesce a seek or an implicit loop-entry jump
  // without taking the decoder mutex. Play-after-end uses seek then resume
  // on both desktop and mobile. Even a wholly resident target supersedes
  // earlier stages: an older queued jump must not replace its live window.
  uint64_t requestJump(uint64_t sourceFrame) noexcept;
  // Render domain: claim ALL lanes before publishing ANY. A failed claim
  // leaves the old position playing; no lock, retry loop or allocation.
  bool commitJump(uint64_t token, uint64_t sourceFrame) noexcept;
  // Render/control domain: stop staging a consumed/timed-out request.
  void cancelJump(uint64_t token) noexcept;

  // Control domain: the loop the transport wraps in, in SOURCE frames, end
  // exclusive. While playback is inside it the feeder never decodes past its
  // end and keeps its head where the wrap will want it — resident when the
  // loop fits the ring, staged in the standby ring when it does not.
  void setLoop(uint64_t startFrame, uint64_t endFrame);
  void clearLoop();
  // RENDER domain: the transport has just moved the source position to
  // `sourceFrame` (applied seek, loop wrap, count-in landing). Lock-free,
  // allocation-free, bounded by the lane count: each lane whose staged target
  // holds the frame swaps its window to the standby ring and publishes it.
  void transportJumped(uint64_t sourceFrame) noexcept;
  // Control domain, lock-free: one frame of what this lane's window publishes,
  // false when it does not hold it (or was mid-swap). Reads through the ring
  // the window currently points at, which the render thread may change.
  [[nodiscard]] bool sampleAt(size_t lane, uint32_t channel, uint64_t frame,
                              float* value) const noexcept;

  [[nodiscard]] size_t laneCount() const noexcept { return lanes_.size(); }
  // Valid until the group is destroyed. The source node holds this pointer.
  [[nodiscard]] zdsp::StreamingWindow* window(size_t lane) noexcept;
  [[nodiscard]] const StreamingAudioInfo* info(size_t lane) const noexcept;
  [[nodiscard]] StreamingLaneStats stats(size_t lane) const noexcept;
  // What this lane's ring actually costs. Not derivable from the options: a
  // lane shorter than the window gets a smaller ring, and the memory budget
  // must be told the truth rather than the request.
  [[nodiscard]] size_t retainedBytes(size_t lane) const noexcept;
  // The lane's length in OUTPUT frames — what the window holds and the graph
  // counts. Equal to the file's own count only when no resampling is needed.
  [[nodiscard]] uint64_t outputFrames(size_t lane) const noexcept;

  // The seek bar's envelope, decoded once in the background.
  //
  // This is the whole reason a streamed song can still draw a waveform: the
  // statistic is a linear pass over every sample, which is exactly what
  // streaming avoids paying for up front — so it is paid AFTER the song is
  // already playing, on a thread nobody is waiting for, and the answer is
  // meant to be cached by the caller against the stem's hash so it is paid
  // once per file rather than once per open.
  void startWaveformPass();
  /**
   * Hand this lane an envelope somebody already measured, so the pass skips it.
   *
   * A cue change, a pitch change and a tempo change each REBUILD the graph, and
   * every rebuild used to construct a fresh group that started measuring from
   * the first lane again — throwing away everything the last one had done. A
   * singer who touches the metronome and the pitch in the first few seconds
   * (which is exactly when they do) could restart the pass six times and see no
   * waveform at all, while each individual attempt looked healthy.
   *
   * None of those changes touch the STEMS, so their envelope is still true.
   */
  void seedWaveform(size_t lane, const float* buckets, size_t bucketCount);
  // False until this lane's pass has finished. `buckets` receives the same
  // RMS-per-bucket statistic the decoded path publishes.
  [[nodiscard]] bool waveform(size_t lane, float* buckets,
                              size_t bucketCount) const noexcept;
  [[nodiscard]] bool waveformComplete() const noexcept;

  // Test seam: run one round of refills on THIS thread instead of the feeder
  // thread, so a test can drive the whole protocol deterministically. Returns
  // true when any lane made progress.
  bool serviceOnceForTesting();
  // Turns the feeder thread has taken (busy or idle); a test reads the idle
  // cadence from it.
  // Called by the idle feeder with the wake mutex held, AFTER its predicate
  // has come back false and immediately before it sleeps: a test can start a
  // wake() here and hold it across the sleep entry. Set before start().
  void setWaitSeamForTesting(void (*seam)(void*), void* context) noexcept {
    waitSeam_ = seam;
    waitSeamContext_ = context;
  }
  [[nodiscard]] uint64_t loopTurnsForTesting() const noexcept {
    return loopTurns_.load(std::memory_order_relaxed);
  }

 private:
  struct Lane {
    // The demand seen by the previous idle round (feeder thread, mutex_).
    uint64_t lastIdleDemand{~0ull};
    std::unique_ptr<StreamingAudioSource> source;
    // Null when the file already matches the device. Recreated on every seek:
    // its filter history belongs to the audio before the jump, and there is no
    // reset short of a new one.
    std::unique_ptr<Resampler> resampler;
    uint32_t sourceRate{0};
    uint32_t outputRate{0};
    // Interleaved resampler output not yet placed in the ring, and how many of
    // its leading frames are the filter's priming delay rather than audio.
    std::vector<float> pending;
    size_t pendingRead{0};
    int64_t dropOutputFrames{0};
    // Refill scratch, kept on the lane rather than made per call: a refill
    // happens every few milliseconds per lane, and this is tens of kilobytes
    // each time. Control domain, so allocating would be legal — just wasteful
    // at a rate that adds up on a phone.
    std::vector<std::vector<float>> decodePlanes;
    std::vector<float*> decodePointers;
    std::vector<float> interleaved;
    // Its own decoder, for the linear waveform pass.
    std::unique_ptr<StreamingAudioSource> analysis;
    std::vector<float> waveformBuckets;
    std::atomic<bool> waveformReady{false};
    // Two rings of identical capacity: `live` is the one the window points
    // at as far as the feeder knows; the other is the standby a jump target
    // is staged into. Each `rings[n]` is the channel-pointer array handed to
    // the window as-is, so a swap is one pointer store.
    std::vector<std::vector<float>> planes[2];
    std::vector<float*> rings[2];
    int live{0};
    // Where the decoder will deliver its next OUTPUT frame. Refilling the
    // live ring from anywhere else needs a reposition first — the decoder is
    // shared with staging.
    uint64_t decoderAt{0};
    // The standby handshake with the render thread. Low two bits are the
    // phase, the rest a generation so a stage taken back and re-armed between
    // the render thread's load and its exchange cannot be swapped in stale.
    // Idle: the feeder owns both rings and the window's resident range.
    // Armed: the standby holds [stageStart, stageEnd); the feeder publishes
    //   nothing for this lane and leaves the decoder alone until it reclaims.
    // Swapped: the render thread swapped the window to the standby and
    //   published the stage; the feeder adopts it and returns to Idle.
    std::atomic<uint32_t> stage{0};
    std::atomic<uint64_t> stageRequest{0};
    std::atomic<uint64_t> stageStart{0};
    std::atomic<uint64_t> stageEnd{0};
    std::atomic<float* const*> stageChannels{nullptr};
    // The ring the window points at, for readers off the render thread.
    std::atomic<float* const*> windowChannels{nullptr};
    std::chrono::steady_clock::time_point stagedAt{};
    // The demand the node had published when a swap was adopted, if it lay
    // outside the stage: it predates the jump (a seek applied while paused
    // renders no block to replace it), so it is not chased while unchanged.
    bool staleDemandValid{false};
    uint64_t staleDemand{0};
    zdsp::StreamingWindow window{};
    // The ring this lane actually got: the option, clamped down to the song
    // when the song is shorter than it.
    uint64_t capacityFrames{0};
    // Mirrors the published range so the feeder need not snapshot its own
    // publication, which it could otherwise lose to itself.
    uint64_t residentStart{0};
    uint64_t residentEnd{0};
    /* Every counter here is written by one thread and read by another —
       the feeder writes refills/framesDecoded/seeks while it services, the
       waveform pass writes its own fields as it goes, and the control thread
       reads the lot through `stats()` for the diagnostics the seek bar logs.
       They were plain members under no shared lock, which ThreadSanitizer
       reported the moment `lanePeaks()` started reading them while the feeder
       was running. Relaxed atomics: these are counters nobody orders anything
       on, so the cost is nil and the read is defined. */
    struct Live {
      std::atomic<uint64_t> refills{0};
      std::atomic<uint64_t> seeks{0};
      std::atomic<uint64_t> framesDecoded{0};
      std::atomic<uint64_t> waitedForGuard{0};
      std::atomic<uint64_t> stages{0};
      std::atomic<uint64_t> swaps{0};
      std::atomic<uint64_t> stagesAbandoned{0};
      std::atomic<bool> waveformSource{false};
      std::atomic<bool> waveformStarted{false};
      std::atomic<bool> waveformDone{false};
      std::atomic<uint64_t> waveformFrames{0};
      std::atomic<uint32_t> waveformError{0};
      std::atomic<uint64_t> waveformReadMs{0};
      std::atomic<uint64_t> waveformElapsedMs{0};
      std::atomic<int32_t> waveformQos{-1};
      std::atomic<int32_t> waveformIoPolicy{-1};
    } stats;
    // Atomic for the same reason the counters above are: it is written by the
    // feeder under mutex_ and read by stats() without it, for the diagnostic.
    // One flip per lane rather than one per refill, so the window is narrow —
    // narrow is not absent, and a race that only shows up on a busy phone is
    // the worst kind to leave in.
    std::atomic<bool> ended{false};
  };

  bool serviceJumpRequest();
  bool serviceLane(Lane& lane);
  bool seekLane(Lane& lane, uint64_t outputFrame);
  bool repositionDecoder(Lane& lane, uint64_t outputFrame);
  uint64_t fillLane(Lane& lane, float* const* ring, uint64_t index,
                    uint64_t frames);
  // Decode [frame, frame + stageFrames) into the standby ring and arm it.
  bool stageLane(Lane& lane, uint64_t frame);
  // The stage, taken back from the render thread. False when the render
  // thread swapped it in first, in which case the swap has been adopted.
  bool reclaimStage(Lane& lane);
  void adoptSwap(Lane& lane, uint32_t state);
  void loop();
  void waveformLoop();
  // Wake the feeder thread now, from any control-domain thread.
  void wake() noexcept;

  // Single control-domain writer, feeder reader: even sequence = published.
  std::atomic<uint64_t> jumpSequence_{0};
  std::atomic<uint64_t> jumpFrame_{0};
  std::atomic<uint64_t> completedJump_{0};
  StreamingLaneOptions options_{};
  std::vector<std::unique_ptr<Lane>> lanes_;
  std::thread thread_;
  std::thread waveformThread_;
  std::atomic<bool> waveformRunning_{false};
  // Written once when the pass starts and read from stats(), so elapsed can be
  // reported from OUTSIDE the loop that stopped advancing.
  std::atomic<bool> waveformAlive_{false};
  std::chrono::steady_clock::time_point waveformStartedAt_{};
  // The loop the transport wraps in, SOURCE frames. Feeder-thread state,
  // guarded by mutex_.
  bool loopEnabled_{false};
  uint64_t loopStart_{0};
  uint64_t loopEnd_{0};
  mutable std::mutex mutex_;
  std::condition_variable wake_;
  // Guards wakeEpoch_ for the wait only; never held across decoder I/O.
  std::mutex wakeMutex_;
  void (*waitSeam_)(void*){nullptr};
  void* waitSeamContext_{nullptr};
  // Bumped by every wake(): the feeder waits on it, so a wake that lands
  // between its last pass and its sleep is not lost.
  std::atomic<uint64_t> wakeEpoch_{0};
  std::atomic<uint64_t> loopTurns_{0};
  std::atomic<bool> running_{false};

 public:
  void setOptions(const StreamingLaneOptions& options) { options_ = options; }
  [[nodiscard]] const StreamingLaneOptions& options() const noexcept {
    return options_;
  }
};

}  // namespace singz
