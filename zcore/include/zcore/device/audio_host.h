#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <zcore/device/audio_host_render.h>

namespace singz {

enum class AudioHostState : uint32_t {
  Closed,
  Open,
  Running,
  Stopped,
  DeviceLost,
  Error,
  Unsupported,
};

enum class AudioHostError : uint32_t {
  None,
  Unsupported,
  InvalidState,
  InvalidConfiguration,
  DeviceNotFound,
  DifferentDevicesUnsupported,
  ProviderFailure,
};

struct AudioHostBufferRange {
  uint32_t minimumFrames{0};
  uint32_t maximumFrames{0};
  uint32_t preferredFrames{0};
};

struct AudioHostRateRange {
  double minimumHz{0.0};
  double maximumHz{0.0};
};

struct AudioHostDeviceInfo {
  std::string uid;
  std::string label;
  bool defaultInput{false};
  bool defaultOutput{false};
  uint32_t inputChannels{0};
  uint32_t outputChannels{0};
  double nominalSampleRate{0.0};
  // CoreAudio and other providers may expose continuous ranges. A discrete
  // supported rate is represented by minimumHz == maximumHz.
  std::vector<AudioHostRateRange> sampleRateRanges;
  AudioHostBufferRange bufferFrames;
};

struct AudioHostInventory {
  std::vector<AudioHostDeviceInfo> devices;
  std::string defaultInputUid;
  std::string defaultOutputUid;
};

struct AudioHostConfig {
  std::string inputDeviceUid;
  std::string outputDeviceUid;
  // Zero-based physical device channel indices in client channel order.
  std::vector<uint32_t> inputChannels;
  std::vector<uint32_t> outputChannels;
  double requestedSampleRate{0.0};
  uint32_t requestedBufferFrames{0};
  uint32_t maximumFrames{kAudioHostMaxFrames};
};

struct AudioHostFormat {
  double sampleRate{0.0};
  uint32_t maximumFrames{0};
  uint32_t nominalBufferFrames{0};
  uint32_t inputChannels{0};
  uint32_t outputChannels{0};
  bool float32Planar{true};
  bool outputClockMaster{true};
};

struct AudioHostLatency {
  // Independent components; consumers choose the path they are measuring and
  // must not add a hidden aggregate supplied by the provider.
  uint32_t inputDeviceFrames{0};
  uint32_t outputDeviceFrames{0};
  uint32_t bufferFrames{0};
  uint32_t externalRouteFrames{0};
};

struct AudioHostResult {
  bool ok{false};
  AudioHostError error{AudioHostError::ProviderFailure};
  AudioHostState state{AudioHostState::Error};
  AudioHostFormat format{};
  AudioHostLatency latency{};
  std::string message;
};

struct AudioHostStatus {
  AudioHostState state{AudioHostState::Closed};
  AudioHostFormat format{};
  AudioHostLatency latency{};
  uint64_t routeGeneration{0};
  uint64_t streamGeneration{0};
  uint64_t callbacks{0};
  uint64_t renderedFrames{0};
  uint64_t xruns{0};
  uint64_t deadlineMisses{0};
  uint64_t discontinuities{0};
  uint64_t invalidCallbacks{0};
  uint64_t renderFailures{0};
};

class AudioHostBackend {
 public:
  virtual ~AudioHostBackend() = default;
  virtual AudioHostInventory enumerate() const = 0;
  virtual AudioHostResult open(const AudioHostConfig& config,
                               AudioHostRender render,
                               void* renderContext) = 0;
  virtual AudioHostResult start() = 0;
  virtual void stop() noexcept = 0;
  virtual AudioHostStatus status() const noexcept = 0;
};

// Control-domain lifecycle owner. Construction and enumeration do not open,
// start, or otherwise mutate an audio device. Calls to open(), start(), stop(),
// and status() are serialized by the owner; status() may overlap only the
// audio callback's lock-free telemetry updates.
class AudioHost final {
 public:
  AudioHost();
  explicit AudioHost(std::unique_ptr<AudioHostBackend> backend);
  ~AudioHost();
  AudioHost(AudioHost&&) noexcept;
  AudioHost& operator=(AudioHost&&) noexcept;
  AudioHost(const AudioHost&) = delete;
  AudioHost& operator=(const AudioHost&) = delete;

  AudioHostInventory enumerate() const;
  AudioHostResult open(const AudioHostConfig& config, AudioHostRender render,
                       void* renderContext);
  AudioHostResult start();
  void stop() noexcept;
  AudioHostStatus status() const noexcept;

 private:
  std::unique_ptr<AudioHostBackend> backend_;
};

std::unique_ptr<AudioHostBackend> createPlatformAudioHostBackend();

}  // namespace singz
