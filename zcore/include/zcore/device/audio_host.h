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

enum class AudioHostEndpointDirection : uint32_t {
  Duplex,
  Input,
  Output,
};

enum class AudioHostAccessMode : uint32_t {
  Shared,
  Exclusive,
};

// Provider-reported physical transport. Product policy consumes this typed
// capability and never guesses from a friendly device label or UID.
enum class AudioHostTransport : uint32_t {
  Unknown,
  BuiltIn,
  Aggregate,
  Virtual,
  Pci,
  Usb,
  FireWire,
  Bluetooth,
  BluetoothLowEnergy,
  Hdmi,
  DisplayPort,
  AirPlay,
  Avb,
  Thunderbolt,
  ContinuityWired,
  ContinuityWireless,
  Vehicle,
};

enum class AudioHostMonitoringSuitability : uint32_t {
  Unknown,
  LowLatency,
  HighLatency,
  Unsupported,
};

struct AudioHostBufferRange {
  uint32_t minimumFrames{0};
  uint32_t maximumFrames{0};
  uint32_t preferredFrames{0};
  // Legal periods advance in this many frames. Zero means the provider does
  // not expose a discrete granularity.
  uint32_t fundamentalFrames{0};
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
  // Provider-published element names in the same zero-based order used by
  // AudioHostConfig channel maps. A provider may leave either vector empty
  // when its driver API exposes only a channel count.
  std::vector<std::string> inputChannelLabels;
  std::vector<std::string> outputChannelLabels;
  double nominalSampleRate{0.0};
  // CoreAudio and other providers may expose continuous ranges. A discrete
  // supported rate is represented by minimumHz == maximumHz.
  std::vector<AudioHostRateRange> sampleRateRanges;
  AudioHostBufferRange bufferFrames;
  // A platform may expose input and output as distinct endpoints. The UID is
  // always the platform's opaque endpoint identifier; callers must not parse
  // it or derive pairing from the friendly label.
  AudioHostEndpointDirection direction{AudioHostEndpointDirection::Duplex};
  // Inventory describes the currently active shared profile. Exclusive
  // formats are exact-probed at open time and are never inferred from it.
  AudioHostAccessMode accessMode{AudioHostAccessMode::Shared};
  AudioHostTransport transport{AudioHostTransport::Unknown};
  AudioHostMonitoringSuitability monitoringSuitability{
      AudioHostMonitoringSuitability::Unknown};
};

struct AudioHostInventory {
  std::vector<AudioHostDeviceInfo> devices;
  std::string defaultInputUid;
  std::string defaultOutputUid;
};

struct AudioHostConfig {
  // An empty input UID together with an empty input channel map requests an
  // output-only stream. Providers that implement output-only operation must
  // publish zero input channels and a null input bus to the render callback.
  // Supplying only one of these fields is invalid. Non-empty input remains
  // the existing duplex/capture contract and may retain platform pairing
  // restrictions.
  std::string inputDeviceUid;
  std::string outputDeviceUid;
  // Zero-based physical device channel indices in client channel order.
  std::vector<uint32_t> inputChannels;
  std::vector<uint32_t> outputChannels;
  double requestedSampleRate{0.0};
  uint32_t requestedBufferFrames{0};
  uint32_t maximumFrames{kAudioHostMaxFrames};
  // Never falls back silently: an exclusive request either opens exclusive
  // streams with the exact format or fails.
  bool exclusive{false};
};

struct AudioHostFormat {
  double sampleRate{0.0};
  uint32_t maximumFrames{0};
  uint32_t nominalBufferFrames{0};
  uint32_t inputChannels{0};
  uint32_t outputChannels{0};
  bool float32Planar{true};
  bool outputClockMaster{true};
  AudioHostAccessMode accessMode{AudioHostAccessMode::Shared};
};

struct AudioHostLatency {
  // Independent components; consumers choose the path they are measuring and
  // must not add a hidden aggregate supplied by the provider.
  uint32_t inputDeviceFrames{0};
  uint32_t outputDeviceFrames{0};
  uint32_t bufferFrames{0};
  uint32_t externalRouteFrames{0};
};

struct AudioHostDiagnostics {
  // WASAPI and future split-clock providers report their stream-level values
  // here instead of mislabeling GetStreamLatency as pure hardware latency.
  uint64_t inputStreamLatency100ns{0};
  uint64_t outputStreamLatency100ns{0};
  uint32_t inputPeriodFrames{0};
  uint32_t outputPeriodFrames{0};
  uint32_t inputBufferFrames{0};
  uint32_t outputBufferFrames{0};
  uint32_t fifoCapacityFrames{0};
  uint32_t fifoCurrentFrames{0};
  uint32_t fifoMinimumFrames{0};
  uint32_t fifoMaximumFrames{0};
  uint64_t fifoUnderflows{0};
  uint64_t fifoOverflows{0};
  // Capture frames absent from the bounded endpoint-priming window and
  // supplied as zero input. This is not general silence detection. Windows
  // accumulates this and the flow balance exactly in lock-free uint64 counters
  // (saturating only at UINT64_MAX).
  uint64_t startupInputZeroFrames{0};
  // Frames accepted into the capture FIFO minus frames requested by render
  // callbacks. This is a queue-flow balance, not a clock-drift estimate.
  int64_t acceptedCaptureMinusRenderedFrames{0};
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
  AudioHostDiagnostics diagnostics{};
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
