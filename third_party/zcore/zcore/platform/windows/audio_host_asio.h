#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <zcore/device/audio_host.h>

namespace singz {

// This header is deliberately independent of the Steinberg SDK. A separately
// licensed translation unit may implement AsioDriverApi, but the zcore-facing
// provider contract and its deterministic fake remain buildable without any
// proprietary headers or binaries.
inline constexpr const char *kAsioSdkUnavailableReason =
    "The separately licensed Steinberg ASIO SDK/runtime is not vendored";

enum class AsioDriverError : uint32_t {
  None,
  Unavailable,
  InvalidState,
  InvalidConfiguration,
  DeviceNotFound,
  UnsupportedFormat,
  DeviceLost,
  Failure,
};

enum class AsioDriverState : uint32_t {
  Closed,
  Open,
  Running,
  Stopped,
  DeviceLost,
  Error,
};

struct AsioDriverProbe {
  bool available{false};
  std::string detail;
};

struct AsioDriverDevice {
  std::string uid;
  std::string label;
  uint32_t inputChannels{0};
  uint32_t outputChannels{0};
  std::vector<std::string> inputChannelLabels;
  std::vector<std::string> outputChannelLabels;
  std::vector<double> sampleRates;
  AudioHostBufferRange bufferFrames{};
  uint32_t inputLatencyFrames{0};
  uint32_t outputLatencyFrames{0};
};

struct AsioDriverInventory {
  std::vector<AsioDriverDevice> devices;
  std::string defaultUid;
};

struct AsioDriverOpenConfig {
  std::string deviceUid;
  std::vector<uint32_t> inputChannels;
  std::vector<uint32_t> outputChannels;
  double sampleRate{0.0};
  uint32_t bufferFrames{0};
  uint32_t maximumFrames{0};
};

// The future licensed adapter performs any native ASIO sample conversion into
// these preallocated planar float32 buses. No buffer ownership crosses the
// callback, and frames is always bounded by the open-time maximum.
struct AsioDriverProcessBlock {
  const float *const *input{nullptr};
  float *const *output{nullptr};
  uint32_t inputChannels{0};
  uint32_t outputChannels{0};
  uint32_t frames{0};
  uint64_t samplePosition{0};
  uint64_t systemTimeNs{0};
  bool samplePositionValid{false};
  bool systemTimeValid{false};
  bool xrun{false};
  bool deadlineMiss{false};
  uint32_t discontinuity{AudioHostDiscontinuityNone};
};

using AsioDriverProcess = bool (*)(
    void *context, const AsioDriverProcessBlock &block) noexcept;
using AsioDriverTerminal = void (*)(void *context,
                                    AsioDriverError error) noexcept;

struct AsioDriverCallbacks {
  void *context{nullptr};
  AsioDriverProcess process{nullptr};
  AsioDriverTerminal terminal{nullptr};
};

struct AsioDriverOpenResult {
  bool ok{false};
  AsioDriverError error{AsioDriverError::Failure};
  AsioDriverState state{AsioDriverState::Error};
  double sampleRate{0.0};
  uint32_t bufferFrames{0};
  uint32_t maximumFrames{0};
  uint32_t inputChannels{0};
  uint32_t outputChannels{0};
  uint32_t inputLatencyFrames{0};
  uint32_t outputLatencyFrames{0};
  bool float32Planar{false};
  std::string message;
};

struct AsioDriverResult {
  bool ok{false};
  AsioDriverError error{AsioDriverError::Failure};
  AsioDriverState state{AsioDriverState::Error};
  std::string message;
};

struct AsioDriverStatus {
  AsioDriverState state{AsioDriverState::Closed};
  AsioDriverError error{AsioDriverError::None};
};

class AsioDriverApi {
 public:
  virtual ~AsioDriverApi() = default;
  [[nodiscard]] virtual AsioDriverProbe probe() const = 0;
  [[nodiscard]] virtual AsioDriverInventory enumerate() const = 0;
  virtual AsioDriverOpenResult open(const AsioDriverOpenConfig &config,
                                    AsioDriverCallbacks callbacks) = 0;
  virtual AsioDriverResult start() = 0;
  // stop() must close callback admission and join/quiesce every callback before
  // returning. It is serialized with open/start by AudioHost's owner.
  virtual void stop() noexcept = 0;
  [[nodiscard]] virtual AsioDriverStatus status() const noexcept = 0;
};

enum class AsioProviderAvailabilityError : uint32_t {
  None,
  SdkAdapterNotCompiled,
  RuntimeUnavailable,
};

struct AsioProviderStatus {
  bool compiled{false};
  bool available{false};
  AsioProviderAvailabilityError error{
      AsioProviderAvailabilityError::SdkAdapterNotCompiled};
  std::string detail;
};

class AsioAudioHostProvider final {
 public:
  // Shipping builds have no licensed driver adapter and return false. Tests
  // inject an SDK-neutral AsioDriverApi without changing that product fact.
  [[nodiscard]] static bool compiled() noexcept;
  [[nodiscard]] static const char *unavailableReason() noexcept;
  [[nodiscard]] static AsioProviderStatus probe();
  [[nodiscard]] static AsioProviderStatus probe(const AsioDriverApi &driver);
  [[nodiscard]] static std::unique_ptr<AudioHostBackend> create();
  [[nodiscard]] static std::unique_ptr<AudioHostBackend> create(
      std::unique_ptr<AsioDriverApi> driver);
};

}  // namespace singz
