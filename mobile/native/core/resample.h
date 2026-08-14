#pragma once
#include <cstdint>
#include <vector>

// Rational polyphase windowed-sinc resampler (L/M from the rate pair), used
// by the split engine to bring the decoded mix to the graph's 44.1 kHz.
// Streaming: feed blocks, drain output; flush() pushes the tail through.
// Quality measured in bring-up (>90 dB SNR on in-band sines — far below
// what a separation model can distinguish; stems are per-project artifacts,
// not cross-device-compared bytes); the CI harness lands with the :split
// service slice.
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
