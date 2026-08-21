#pragma once
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

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

namespace singz {

// One stem as mono float32 — what the detectors take. Despite the name this
// is the core's ONE audio-read choke point and it dispatches on the file's
// magic bytes: RIFF goes down the WAV path below, fLaC goes to the vendored
// libFLAC (flac_io.h) with the identical channel fold, so every caller —
// beats, key, melody, the ML mix, the CLI, both bindings — gained FLAC the
// moment the dispatch landed, and none of them needed to know.
// The WAV path accepts PCM 16/24/
// 32-bit and IEEE float32, any channel count; EVERY channel is averaged in
// (each sample scaled to [-1,1) the way the phone's audio decoder does it,
// s / 32768 for 16-bit, and the average taken in double before the float32
// store). For mono and stereo — the shapes the phone reads, since a split
// stem is always one or two channels — that is the JS `loadMono44k` fold to
// the bit, which is what the parity gate rests on. Above two channels the
// two deliberately differ: `loadMono44k` averages the first two and ignores
// the rest (a Web Audio convenience), and a reader that dropped channels
// 3-6 would be wrong for the desktop CLI, which will meet real files.
struct MonoWav {
  std::vector<float> samples;
  int sampleRate = 0;
  int channels = 0;
  bool ok = false;
  std::string error;
};

MonoWav readWavMono(const std::string& path);

// The header alone — rate, channels and the frame count the data chunk
// states (clamped to what the file actually holds) — no samples read. What
// the melody-fit rule needs before anything is tracked. Dispatches on magic
// bytes exactly like readWavMono (FLAC answers from STREAMINFO).
struct WavInfo {
  int sampleRate = 0;
  int channels = 0;
  int64_t frames = 0;
  bool ok = false;
  std::string error;
};

WavInfo readWavInfo(const std::string& path);

}  // namespace singz
