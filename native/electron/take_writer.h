#pragma once

#include <zcore/audio/audio_input_transport.h>
#include <atomic>
#include <cstdio>
#include <functional>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>

namespace singz {

struct TakeWriteResult {
  std::string path;
  uint64_t frames = 0;
  uint32_t sampleRate = 0;
  uint64_t firstSampleHostNs = 0;
  AudioInputTimestampQuality firstSampleQuality = AudioInputTimestampQuality::Unknown;
  uint64_t droppedBlocks = 0;
  bool deviceLost = false;
  std::string error;
};
struct TakeFirstSample {
  bool captured = false;
  uint64_t hostNs = 0;
  AudioInputTimestampQuality quality = AudioInputTimestampQuality::Unknown;
};
struct TakeInputLevel { double peakDb = -120; double rmsDb = -120; };

// One permanent instance per capture owner. start/finish/cancel/result are
// serialized by the owner's control mutex. append has exactly one producer;
// it never allocates, locks, calls the OS, or waits for the consumer. Only the
// writer thread converts float to PCM16 and touches the open file.
class TakeWriter {
 public:
  explicit TakeWriter(uint32_t ringBlocks = 128, uint32_t maxFrames = 32768);
  ~TakeWriter();
  TakeWriter(const TakeWriter&) = delete;
  TakeWriter& operator=(const TakeWriter&) = delete;
  void start(const std::string& directory, const std::string& takeId,
             uint32_t sampleRate, std::function<bool()> deviceLost = {});
  bool append(const AudioInputBlockView& block) noexcept;
  TakeWriteResult finish();
  void cancel();
  bool active() const noexcept;
  bool completed() const noexcept;
  TakeInputLevel level() const noexcept;
  TakeFirstSample firstSample() const noexcept;
  void resetLevel() noexcept;
  uint64_t lastSampleHostNs() const noexcept;
  // Call only with the capture delivery thread stopped, before a new capture.
  void resetCaptureTelemetry() noexcept;
  // Canonical mono PCM16 WAV only. An unfinished header's data length is
  // deliberately ignored; complete sample pairs on disk are authoritative.
  static TakeWriteResult recover(const std::string& path);
 private:
  struct Slot;
  void run() noexcept;
  void closeGate() noexcept;
  const uint32_t capacity_, maxFrames_;
  std::unique_ptr<Slot[]> slots_;
  std::unique_ptr<float[]> samples_;
  std::atomic<uint64_t> write_{0}, read_{0}, dropped_{0};
  std::atomic<uint32_t> producers_{0};
  std::atomic<bool> accepting_{false}, done_{true};
  std::atomic<float> peak_{0}, meanSquare_{0};
  std::atomic<uint64_t> firstHostNs_{0}, lastHostNs_{0};
  std::atomic<AudioInputTimestampQuality> firstQuality_{AudioInputTimestampQuality::Unknown};
  std::atomic<bool> firstCaptured_{false};
  std::filesystem::path path_;
  std::thread thread_;
  std::FILE* file_ = nullptr;
  std::function<bool()> deviceLost_;
  TakeWriteResult result_;
};
} // namespace singz
