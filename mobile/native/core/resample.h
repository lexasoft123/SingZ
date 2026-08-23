#pragma once
#include <cstdint>
#include <vector>

// Rational polyphase windowed-sinc resampler (L/M from the rate pair). Two
// consumers: the split engine, bringing a decoded mix to the graph's 44.1 kHz
// (48k->44.1k and other near-unity ratios), and beat_this's sumStemsTo22k,
// decimating 44.1k stems 2:1 to the beat model's 22.05 kHz. Streaming: feed
// blocks, drain output; flush() pushes the tail through. The tap count
// scales with net decimation (resample.cpp says why — a 24-tap prototype
// that is fine near 1:1 is a bad lowpass at 2:1).
// Quality is CI-measured on every mobile push (tests/native/
// core_host_tests.cpp): 48k->44.1k 1 kHz sine SNR > 90 dB (reads 110) and
// unity passband gain; the 2:1 response directly — flat to 10 kHz, 12 kHz
// alias < -30 dB, 14 kHz alias < -60 dB; streamed == one-shot bit for bit.
// A single-tone SNR at a near-unity ratio says nothing about a decimating
// ratio, which is how the 2:1 case shipped aliasing for a while.
namespace singz {

class Resampler {
 public:
  // channels are resampled independently but fed interleaved.
  Resampler(int srcRate, int dstRate, int channels);

  bool passthrough() const { return up_ == 1 && down_ == 1; }

  // Feed interleaved f32 frames; appends interleaved output frames to out.
  void process(const float* in, int64_t frames, std::vector<float>& out);

  // Push the remaining history through (call once, at end of input).
  void flush(std::vector<float>& out);

  // Output frames to drop for a time-true signal: the zero history primes
  // (tapsPerPhase_-1) input samples of delay and the linear-phase kernel
  // another (tapsPerPhase_-1)/2. Exact (integer) for the decimating design,
  // whose odd tap count is chosen for it; callers that only care about
  // steady-state content (the split engine's near-unity path) ignore it.
  int64_t latencyOutFrames() const {
    return static_cast<int64_t>(3) * (tapsPerPhase_ - 1) / 2 * up_ / down_;
  }

 private:
  int up_ = 1;
  int down_ = 1;
  int channels_ = 2;
  int tapsPerPhase_ = 0;
  int64_t phase_ = 0;  // position in units of 1/up_ input frames
  std::vector<float> filter_;   // up_ * tapsPerPhase_, polyphase-ordered
  std::vector<float> history_;  // interleaved, tapsPerPhase_-1 frames
};

}  // namespace singz
