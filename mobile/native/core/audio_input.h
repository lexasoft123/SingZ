#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace singz {

// Portable description of a physical input. `uid` is the operating system's
// stable identifier, never a transient enumeration index. Channels are always
// zero-based in the core; labels are display-only and may fall back to
// "Channel N" when a driver publishes no names.
struct AudioInputDevice {
  std::string uid;
  std::string label;
  bool isDefault = false;
  double sampleRate = 0;
  uint32_t channels = 0;
  std::vector<std::string> channelLabels;
};

struct AudioInputConfig {
  std::string deviceUid;
  uint32_t channel = 0;
  uint32_t ringBlocks = 32;
};

enum class AudioInputState {
  Idle,
  Starting,
  Running,
  Stopping,
  Stopped,
  Unsupported,
  Error,
};

struct AudioInputResult {
  bool ok = false;
  AudioInputState state = AudioInputState::Error;
  std::string error;
  double sampleRate = 0;
  uint32_t channel = 0;
};

struct AudioInputStats {
  uint64_t deliveredBlocks = 0;
  uint64_t deliveredFrames = 0;
  uint64_t overruns = 0;
  uint64_t deliveryWakeups = 0;
};

// Callback-scoped view of one selected, contiguous mono input plane in a
// preallocated ring slot. `mono` is valid only
// until the sink returns; processors that need retention explicitly copy it.
// This keeps steady-state raw delivery allocation-free. The core never stores
// blocks anywhere durable and never batches raw delivery for an analyzer.
// Metadata and lifetime intentionally fit a later planar multi-channel/duplex
// DSP graph; this transport API does not host analyzers or plugin nodes.
struct AudioInputBlockView {
  uint64_t sequence = 0;
  // Same monotonic host clock per backend: sampleHostTimeNs comes from AUHAL's
  // buffer timestamp on macOS or WASAPI's 100 ns QPC position on Windows;
  // callbackHostTimeNs is captured immediately before the RT push. Other
  // backends must document the same clock or set either value to 0.
  uint64_t sampleHostTimeNs = 0;
  uint64_t callbackHostTimeNs = 0;
  double sampleRate = 0;
  const float* mono = nullptr;
  uint32_t frames = 0;
};

using AudioInputSink = std::function<void(const AudioInputBlockView&)>;

// Preallocated single-producer/single-consumer ring. push() is the only API
// used on the hardware callback and performs no allocation, locking, logging,
// JSON, or signal analysis. pop() belongs to the ordinary delivery thread.
class AudioInputRing {
 public:
  AudioInputRing(uint32_t blocks, uint32_t maxFrames);
  ~AudioInputRing();
  AudioInputRing(const AudioInputRing&) = delete;
  AudioInputRing& operator=(const AudioInputRing&) = delete;

  bool valid() const;
  bool push(const float* mono, uint32_t frames, uint64_t sampleHostTimeNs,
            uint64_t callbackHostTimeNs = 0);
  bool peek(AudioInputBlockView& out, double sampleRate);
  void consume();
  uint64_t overruns() const;
  uint32_t capacity() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

struct LiveInputFrame {
  double frequency = 0;
  double clarity = 0;
  double rms = 0;
  double dbfs = -120;
};

// Lightweight live YIN + level analysis for metering/training. This is
// deliberately independent of AudioInput so future processors may consume
// the raw block first and choose whether/when to analyze it.
LiveInputFrame analyzeLiveInput(const float* mono, size_t frames, double sampleRate,
                                double minFrequency = 70.0,
                                double maxFrequency = 1050.0);

std::vector<AudioInputDevice> enumerateAudioInputDevices(std::string* error = nullptr);
bool audioInputBackendSupported();
bool validateAudioInputConfig(const AudioInputConfig& config,
                              const std::vector<AudioInputDevice>& devices,
                              std::string& error);
bool makeAudioInputChannelMap(uint32_t selectedChannel, uint32_t deviceChannels,
                              int32_t& sourceChannel, std::string& error);
const char* audioInputStateName(AudioInputState state);

class AudioInput {
 public:
  AudioInput();
  ~AudioInput();
  AudioInput(const AudioInput&) = delete;
  AudioInput& operator=(const AudioInput&) = delete;

  AudioInputResult start(const AudioInputConfig& config, AudioInputSink sink);
  void stop();
  AudioInputState state() const;
  AudioInputStats stats() const;
  std::string lastError() const;

  // Calling stop() or destroying the AudioInput from its sink is supported.
  // Calling start() recursively from the sink is rejected: a fresh start
  // belongs on a control thread after the callback returns.

 private:
  struct Impl;
  std::shared_ptr<Impl> impl_;
};

}  // namespace singz
