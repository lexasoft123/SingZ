#pragma once
#include <algorithm>
#include <atomic>
#include <bit>
#include <cmath>
#include <cstdint>
#include <zcore/device/audio_host_render.h>

namespace singz {
// SINGZ_VOICE_MONITOR_RT_BEGIN
// This complete callback leaf is extracted by CMake for the realtime policy.
inline constexpr float kVoiceMonitorCeiling = 0.8912509381337456f;
inline constexpr uint32_t kVoiceMonitorRampFrames = 128;
// Monitor gain range in dB. Mirrors src/shared/voice-monitor-gain.ts (a TS test pins the equality).
inline constexpr float kVoiceMonitorGainMinDb = -60.0f;
inline constexpr float kVoiceMonitorGainMaxDb = 36.0f;
// Zero-latency safety ceiling: a hard clamp, never a wrap; the callers only pass finite samples.
inline double voiceMonitorLimit(double scaled) noexcept {
  return std::clamp(scaled, -double(kVoiceMonitorCeiling), double(kVoiceMonitorCeiling));
}
inline float flushVoiceMonitorDenormal(float sample) noexcept {
  return (std::bit_cast<uint32_t>(sample) & 0x7f800000u) == 0 ? 0.0f : sample;
}
struct VoiceMonitorRender {
  static_assert(std::atomic<float>::is_always_lock_free);
  static_assert(std::atomic<uint32_t>::is_always_lock_free);
  std::atomic<float> target{0}, peak{0}, rms{0};
  static_assert(std::atomic<uint64_t>::is_always_lock_free);
  std::atomic<uint32_t> silent{1};
  std::atomic<uint64_t> callbacks{0};
  uint32_t outputs{2}; // Prepared before start, immutable until stop.
  uint64_t outputMask{3}; // Selected client lanes only; every other lane is zero.
  float current{0}, destination{0}, step{0};
  uint32_t remaining{0};
  static bool render(void* context, const AudioHostRenderBlock& block) noexcept {
    auto& self = *static_cast<VoiceMonitorRender*>(context);
    const bool bounded = block.frames <= block.maximumFrames &&
        block.frames <= kAudioHostMaxFrames && block.outputChannels <= kAudioHostMaxChannels;
    const bool valid = bounded && block.frames <= 256 && block.input &&
        block.inputChannels == 1 && block.input[0] && block.outputClockMaster &&
        block.outputChannels == self.outputs && block.inputTimestampValid &&
        block.inputTimestampHardware &&
        !(block.discontinuity & (AudioHostDiscontinuityXRun | AudioHostDiscontinuityDeviceLost));
    const uint32_t frames = bounded ? block.frames : std::min(block.frames, block.maximumFrames);
    const uint32_t channels = std::min(block.outputChannels, kAudioHostMaxChannels);
    float peak = 0;
    double squares = 0;
    const float target = self.target.load(std::memory_order_acquire);
    if (target != self.destination) {
      self.destination = target;
      self.remaining = kVoiceMonitorRampFrames;
      self.step = (target - self.current) / kVoiceMonitorRampFrames;
    }
    for (uint32_t frame = 0; frame < std::min(frames, kAudioHostMaxFrames); ++frame) {
      if (self.remaining && --self.remaining == 0) self.current = self.destination;
      else if (self.remaining) self.current += self.step;
      const float input = valid && std::isfinite(block.input[0][frame]) ? flushVoiceMonitorDenormal(block.input[0][frame]) : 0;
      peak = std::max(peak, std::abs(input));
      squares += static_cast<double>(input) * input;
      // Multiply in double so tiny normal input at a low gain never incurs
      // float subnormal arithmetic or publishes a subnormal output.
      const double scaled = static_cast<double>(input) * self.current;
      const float voice = std::abs(scaled) < 0x1p-126 ? 0.0f :
          static_cast<float>(voiceMonitorLimit(scaled));
      if (block.output)
        for (uint32_t channel = 0; channel < channels; ++channel)
          if (block.output[channel]) {
            [[maybe_unused]] const bool selected = (self.outputMask & (uint64_t{1} << channel)) != 0;
            block.output[channel][frame] = selected ? voice : 0.0f;
          }
    }
    self.peak.store(peak, std::memory_order_relaxed);
    self.rms.store(frames ? static_cast<float>(std::sqrt(squares / frames)) : 0, std::memory_order_relaxed);
    self.silent.store(self.current == 0 && self.destination == 0, std::memory_order_release);
    self.callbacks.fetch_add(1, std::memory_order_release);
    return true; // Invalid capture is contained as silence, never stops the song.
  }
};
// SINGZ_VOICE_MONITOR_RT_END
}

#include <memory>
#include <string>
#include <vector>
#include <zcore/device/audio_host.h>
namespace singz {
struct VoiceMonitorAvailability {
  bool available{false};
  std::string reason, detail, deviceUid;
  uint32_t minBufferFrames{0}, maxBufferFrames{0};
};
struct VoiceMonitorOutputCandidate {
  std::string id, name;
  bool usable{false};
  std::string reason;
};
struct VoiceMonitorOutputChoices {
  std::string id, name; // Empty id means no resolved output; name is display-only.
  std::vector<VoiceMonitorOutputCandidate> candidates;
};
VoiceMonitorOutputChoices voiceMonitorOutputChoices(const AudioHostInventory&, const std::string& inputUid,
    uint32_t channel, const std::string& outputUid, bool macOS);
struct VoiceMonitorLatency {
  double sampleRate{0};
  uint32_t requestedFrames{32}, bufferFrames{0}, inputDeviceFrames{0}, outputDeviceFrames{0};
  uint64_t roundTripFrames{0};
  double roundTripMs{0};
  uint32_t queueFrames{0}; // Source-rate history queue, zero only before capture establishes its period.
  bool delayed{false};
  uint32_t inputBufferFrames{0};
  double inputSampleRate{0};
  uint32_t outputPeriodFrames{0}, observedOutputFrames{0}, queueFloorFrames{0};
};
struct VoiceMonitorResult {
  bool ok{false};
  std::string reason, error;
  VoiceMonitorLatency latency;
  std::vector<std::string> warnings;
};
struct VoiceMonitorStatus {
  bool running{false}, lost{false};
  VoiceMonitorLatency latency;
  std::vector<std::string> warnings;
  float peak{0}, rms{0};
  std::string reason; // Optional status diagnostic, e.g. route-changed.
  uint32_t observedCallbackFrames{0};
};
VoiceMonitorAvailability classifyVoiceMonitorRoute(const AudioHostInventory&, const std::string& inputUid,
    uint32_t channel, const std::string& outputUid, bool nativeOutput, bool permission, bool macOS);
struct VoiceMonitorSongRoute {
  std::string output;
  bool native{false};
  std::vector<uint32_t> channels;
  AudioHostStatus song;
  uint64_t generation{0};
};
inline VoiceMonitorSongRoute voiceMonitorSongRoute(const AudioHostConfig& config,
    const std::string& provider, const AudioHostStatus& status, uint64_t generation, [[maybe_unused]] bool currentSongOutput) {
  // Status/generations are retained for diagnostics only. Unit teardown and
  // re-prepare do not change the selected native provider/UID/channel map.
  return {config.outputDeviceUid,currentSongOutput && provider=="coreaudio" && !config.outputDeviceUid.empty(),
      config.outputChannels,status,generation};
}
// Reject only a proven cross-device Web Audio route. Idle and an unknown
// browser endpoint do not imply that the selected native device is unusable.
inline bool voiceMonitorBrowserOutputCompatible([[maybe_unused]] bool playing, [[maybe_unused]] const std::string& browserUid,
    [[maybe_unused]] const std::string& monitorUid) noexcept {
  return !playing || browserUid.empty() || browserUid==monitorUid;
}
inline bool voiceMonitorSongCanBegin(const VoiceMonitorSongRoute& route) noexcept {
  return route.native && (route.song.state==AudioHostState::Open || route.song.state==AudioHostState::Running);
}
// Host Open/Running/Stopped states and stream generations are lifecycle facts,
// not output identity. A same-UID/pair song re-prepare must retain monitoring.
inline bool voiceMonitorSameOutput(const std::string& uid, const std::vector<uint32_t>& channels,
    const AudioHostConfig& current, bool nativeProvider) noexcept {
  return nativeProvider && current.outputDeviceUid==uid && current.outputChannels==channels;
}
inline constexpr uint32_t kVoiceMonitorSettleWaitMs = 25;
inline constexpr uint32_t kVoiceMonitorMuteWaitMs = 100;
inline constexpr uint32_t kVoiceMonitorBeginWaitBudgetMs = kVoiceMonitorSettleWaitMs+kVoiceMonitorMuteWaitMs;
// Shared input capture/recording and playback/training cues are compatible.
// Box input ownership, mic mix, and unknown future ownership modes are not.
inline bool voiceMonitorUseAllowed([[maybe_unused]] bool boxOwnsCapture, [[maybe_unused]] bool micMixActive, [[maybe_unused]] bool ownerSupported) noexcept {
  return !boxOwnsCapture && !micMixActive && ownerSupported;
}
// Externally serialized by the bridge control mutex. Only the last N-API
// environment may tear down addon-wide hosts; unloading a peer retains them.
class VoiceMonitorEnvironmentLifetime {
 public:
  void attach() noexcept { ++references_; }
  bool detach() noexcept { return references_ != 0 && --references_ == 0; }
 private:
  uint32_t references_{0};
};
// Lifecycle/status calls must be serialized on an ordinary control worker.
// begin() deliberately waits at most 125 ms: one 25 ms callback settle plus
// a 100 ms fade only when replacing a running host. There is no idle mute wait.
// This bounds our wait budget, not OS scheduling, enumeration or driver calls.
// The injected backend and platform flag are only for deterministic host tests.
class SharedAudioService;
class VoiceMonitorHost final {
 public:
  VoiceMonitorHost();
  explicit VoiceMonitorHost(std::unique_ptr<AudioHostBackend> backend, bool macOS = true);
  ~VoiceMonitorHost();
  VoiceMonitorAvailability availability(const std::string& inputUid, uint32_t channel,
      const std::string& outputUid, bool nativeOutput, bool permission) const;
  VoiceMonitorResult begin(const std::string& inputUid, uint32_t channel, const std::string& outputUid,
      bool nativeOutput, bool permission, float gainDb, uint32_t targetFrames, uint32_t maxFrames, uint64_t generation,
      const std::vector<uint32_t>& songOutputChannels = {}, SharedAudioService* songService = nullptr);
  bool setGain(float gainDb) noexcept;
  VoiceMonitorStatus status();
  VoiceMonitorResult end(uint64_t generation);
  void close() noexcept;
  void routeChanged();
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}
