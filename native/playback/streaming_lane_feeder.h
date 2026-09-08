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

#include <zcore/media/decoded_audio.h>
#include <zcore/media/streaming_audio_source.h>
#include <zdsp/streaming_window_source.h>

#include <atomic>
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
};

class StreamingLaneGroup {
 public:
  StreamingLaneGroup();
  ~StreamingLaneGroup();

  StreamingLaneGroup(const StreamingLaneGroup&) = delete;
  StreamingLaneGroup& operator=(const StreamingLaneGroup&) = delete;

  // Open one lane. Call before `prime()`; both descriptors are consumed either
  // way. `requiredSampleRate` of 0 accepts whatever the file holds — the
  // streaming source does not resample, so a lane that disagrees with the
  // device is refused here rather than played at the wrong speed.
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

  // The seek bar's envelope, decoded once in the background.
  //
  // This is the whole reason a streamed song can still draw a waveform: the
  // statistic is a linear pass over every sample, which is exactly what
  // streaming avoids paying for up front — so it is paid AFTER the song is
  // already playing, on a thread nobody is waiting for, and the answer is
  // meant to be cached by the caller against the stem's hash so it is paid
  // once per file rather than once per open.
  void startWaveformPass();
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
    StreamingLaneStats stats;
    bool ended{false};
  };

  bool serviceLane(Lane& lane);
  void loop();
  void waveformLoop();

  StreamingLaneOptions options_{};
  std::vector<std::unique_ptr<Lane>> lanes_;
  std::thread thread_;
  std::thread waveformThread_;
  std::atomic<bool> waveformRunning_{false};
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
