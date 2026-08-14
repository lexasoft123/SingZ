#pragma once
#include <cstdint>
#include <cstdio>
#include <string>

// Streaming 16-bit PCM WAV writer for the split engine: header reserved up
// front, samples appended as segments finalize, sizes patched on close. The
// desktop engines emit exactly this format (44.1 kHz stereo PCM16), and the
// desktop FLAC converter accepts only it — matching is the contract.
namespace singz {

class WavWriter {
 public:
  WavWriter() = default;
  ~WavWriter() { close(); }
  WavWriter(const WavWriter&) = delete;
  WavWriter& operator=(const WavWriter&) = delete;

  // Opens path for writing (truncates) and reserves the 44-byte header.
  // When resuming, `existingFrames` re-opens for append instead.
  bool open(const std::string& path, int sampleRate, int channels,
            int64_t existingFrames = -1);

  // Interleaved float32 [-1,1] -> PCM16 (round-half-away, clamped).
  bool append(const float* interleaved, int64_t frames);

  // Push buffered samples to the kernel — the resume tail must never claim
  // frames stdio still holds (a SIGKILL would splice zeros into the stem).
  bool flush();

  int64_t frames() const { return frames_; }

  // Patch the RIFF/data sizes and close. Safe to call twice.
  bool finalize();

 private:
  void close();

  std::FILE* f_ = nullptr;
  int sampleRate_ = 44100;
  int channels_ = 2;
  int64_t frames_ = 0;
  bool finalized_ = false;
};

}  // namespace singz
