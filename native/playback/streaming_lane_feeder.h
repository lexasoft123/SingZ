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
  // Ring capacity per lane, in frames. Must be a power of two. 262144 frames
  // is ~5.9 s at 44.1 kHz and ~2 MB per stereo lane — against ~109 MB for a
  // fully decoded 5-minute stereo lane.
  uint64_t windowFrames{262144};
  // How far ahead of the render thread the feeder tries to stay.
  uint64_t targetAheadFrames{131072};
  // Frames behind the render position that are never overwritten. This is the
  // guard that makes the ring safe without a lock: the feeder stops filling
  // rather than write within it.
  uint64_t safetyFrames{16384};
  // How much must be resident before `prime()` reports success.
  uint64_t primeFrames{32768};
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

 private:
  struct Lane {
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
    std::vector<std::vector<float>> planes;
    std::vector<float*> pointers;
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

  bool serviceLane(Lane& lane);
  bool seekLane(Lane& lane, uint64_t outputFrame);
  uint64_t fillLane(Lane& lane, uint64_t index, uint64_t frames);
  void loop();
  void waveformLoop();

  StreamingLaneOptions options_{};
  std::vector<std::unique_ptr<Lane>> lanes_;
  std::thread thread_;
  std::thread waveformThread_;
  std::atomic<bool> waveformRunning_{false};
  // Written once when the pass starts and read from stats(), so elapsed can be
  // reported from OUTSIDE the loop that stopped advancing.
  std::atomic<bool> waveformAlive_{false};
  std::chrono::steady_clock::time_point waveformStartedAt_{};
  mutable std::mutex mutex_;
  std::condition_variable wake_;
  std::atomic<bool> running_{false};

 public:
  void setOptions(const StreamingLaneOptions& options) { options_ = options; }
  [[nodiscard]] const StreamingLaneOptions& options() const noexcept {
    return options_;
  }
};

}  // namespace singz
