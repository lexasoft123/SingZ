#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <zcore/device/audio_host.h>

namespace singz {

inline constexpr float kMonitorMinimumGainDb = -60.0F;
inline constexpr float kMonitorMaximumGainDb = 12.0F;
inline constexpr uint32_t kMonitorGainRampFrames = 128;
inline constexpr float kMonitorLimiterCeiling = 0.891250938F;  // -1 dBFS.

enum class AudioMonitorError : uint32_t {
  None = 0,
  InvalidGeneration,
  AlreadyRunning,
  InvalidConfiguration,
  PlatformNotReady,
  UnsupportedRoute,
  NativeAudioBusy,
  GraphFailure,
  HostFailure,
  QueueFull,
};

const char* audioMonitorErrorName(AudioMonitorError error) noexcept;

struct AudioMonitorConfig {
  std::string inputDeviceUid;
  std::string outputDeviceUid;
  std::vector<uint32_t> inputChannels;
  std::vector<uint32_t> outputChannels;
  double sampleRate{0.0};
  uint32_t bufferFrames{0};
  uint32_t maximumFrames{0};
  bool exclusive{false};
};

struct AudioMonitorResult {
  bool ok{false};
  AudioMonitorError error{AudioMonitorError::HostFailure};
  uint64_t ownershipGeneration{0};
  AudioHostState state{AudioHostState::Closed};
  AudioHostFormat format{};
  AudioHostLatency latency{};
  std::string message;
};

struct AudioMonitorMeter {
  float peak{0.0F};
  float rms{0.0F};
  uint64_t frames{0};
};

struct AudioMonitorStatus {
  bool active{false};
  bool enabled{false};
  bool deviceLost{false};
  uint64_t ownershipGeneration{0};
  float gainDb{0.0F};
  AudioMonitorMeter pre{};
  AudioMonitorMeter post{};
  AudioHostStatus host{};
  uint32_t adapterRenderFailures{0};
  uint32_t terminalRenderFailures{0};
  uint32_t adapterLastStatusCode{0};
  uint32_t parameterOverflows{0};
  uint32_t nonFiniteSamples{0};
  uint32_t rejectedBlocks{0};
  std::string error;
};

enum class AudioMonitorLifecycleEvent : uint32_t {
  HostStopBegin,
  HostStopComplete,
  MeterTelemetryFrozen,
  RunnerShutdownAttempt,
  GraphDeactivateAttempt,
  PreparedReleased,
  PreparedQuarantined,
};

// Deterministic control-domain fault injection for lifecycle tests only.
// Production construction never supplies this object.
struct AudioMonitorTestHooks {
  uint32_t runnerShutdownFailures{0};
  uint32_t graphDeactivateFailures{0};
  // Produces a real, retryable non-transactional graph teardown: a test-only
  // pass-through processor fails deactivation while the graph walk destroys
  // other processors, then succeeds on a later retry.
  uint32_t partialGraphDeactivateFailures{0};
  void (*observe)(void*, AudioMonitorLifecycleEvent) noexcept{nullptr};
  void* context{nullptr};
};

// Control-domain product composition owner. Its render thunk touches only the
// prepared graph and lock-free telemetry. Public methods serialize lifecycle;
// raw PCM and graph ownership never leave this object.
class AudioMonitorSession final {
 public:
  AudioMonitorSession();
  explicit AudioMonitorSession(std::unique_ptr<AudioHostBackend> backend);
  AudioMonitorSession(std::unique_ptr<AudioHostBackend> backend,
                      AudioMonitorTestHooks* testHooks);
  ~AudioMonitorSession();
  AudioMonitorSession(const AudioMonitorSession&) = delete;
  AudioMonitorSession& operator=(const AudioMonitorSession&) = delete;

  AudioHostInventory enumerate() const;
  AudioMonitorResult begin(const AudioMonitorConfig& config,
                           uint64_t ownershipGeneration);
  AudioMonitorResult setGain(uint64_t ownershipGeneration, float gainDb,
                             bool enabled);
  AudioMonitorStatus status() const;
  AudioMonitorResult end(uint64_t ownershipGeneration);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace singz
