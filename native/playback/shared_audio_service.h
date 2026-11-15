#pragma once

#include "output_callback_diagnostics.h"
#include "preview_click_mixer.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <optional>
#include <string>
#include <vector>
#include <map>
#include <functional>
#include <zcore/device/audio_host.h>
#include <zcore/device/audio_input.h>

namespace singz {

// SINGZ_SERVICE_MASTER_RT_BEGIN
// In-place, zero-latency final bus; only the callback touches ramp state.
inline constexpr float kServiceMasterCeiling = 0.891250938F;
inline constexpr uint32_t kServiceMasterRampFrames = 128;
struct ServiceMasterMeterSnapshot {
  float peak{0}, rms{0};
  uint64_t clippedBlocks{0}, callbacks{0};
};
struct ServiceMasterMeter {
  static_assert(std::atomic<uint64_t>::is_always_lock_free);
  static_assert(std::atomic<std::atomic<float>*>::is_always_lock_free);
  static_assert(std::atomic<std::atomic<uint32_t>*>::is_always_lock_free);
  std::atomic<float> peak{0}, rms{0};
  std::atomic<uint64_t> clippedBlocks{0}, callbacks{0}, resetEpoch{0};
  // Registered by the admitted song callback; cleared before every bus block.
  // The service holds that client's gate until these publications complete.
  std::atomic<std::atomic<float>*> songPeak{nullptr}, songRms{nullptr};
  std::atomic<std::atomic<uint32_t>*> songClips{nullptr};
  void clearSongTargets() noexcept {
    songPeak.store(nullptr, std::memory_order_relaxed);
    songRms.store(nullptr, std::memory_order_relaxed);
    songClips.store(nullptr, std::memory_order_relaxed);
  }
  ServiceMasterMeterSnapshot snapshot() const noexcept {
    const auto blocks = callbacks.load(std::memory_order_acquire);
    return {peak.load(std::memory_order_relaxed), rms.load(std::memory_order_relaxed),
            clippedBlocks.load(std::memory_order_relaxed), blocks};
  }
};
struct ServiceMasterStage {
  static_assert(std::atomic<float>::is_always_lock_free);
  std::atomic<float> target{1.0F};
  float current{1.0F}, destination{1.0F}, step{0.0F};
  uint32_t remaining{0};
  bool initialized{false};
  ServiceMasterMeter meter;
  float heldPeak{0};
  uint64_t meterEpoch{0};

  void process(const AudioHostRenderBlock& block) noexcept {
    const auto epoch = meter.resetEpoch.load(std::memory_order_acquire);
    if (epoch != meterEpoch) { heldPeak = 0; meterEpoch = epoch; }
    float peak = 0;
    double squares = 0;
    bool clipped = false;
    const float next = target.load(std::memory_order_acquire);
    // Initial configuration is already in force on the very first sample
    // (especially a muted start). Later changes use the graph's lane ramp.
    if (!initialized) {
      current = destination = next;
      initialized = true;
    }
    if (next != destination) {
      destination = next;
      remaining = kServiceMasterRampFrames;
      step = (next - current) / static_cast<float>(remaining);
    }
    for (uint32_t frame = 0; frame < block.frames; ++frame) {
      // Match the graph gain automation: first sample uses the current gain.
      for (uint32_t channel = 0; channel < block.outputChannels; ++channel) {
        if (!block.output || !block.output[channel]) continue;
        const float sample = block.output[channel][frame];
        const double scaled = std::isfinite(sample)
            ? static_cast<double>(sample) * current : 0.0;
        clipped = clipped || std::abs(scaled) > double(kServiceMasterCeiling);
        block.output[channel][frame] = static_cast<float>(std::clamp(
            scaled, -double(kServiceMasterCeiling), double(kServiceMasterCeiling)));
        const float limited = block.output[channel][frame];
        peak = std::max(peak, std::abs(limited));
        squares += static_cast<double>(limited) * limited;
      }
      if (remaining) {
        current += step;
        if (--remaining == 0) current = destination;
      }
    }
    const float release = block.sampleRate > 0 ? static_cast<float>(
        std::pow(10.0, -static_cast<double>(block.frames) / block.sampleRate)) : 0.0F;
    heldPeak = std::max(peak, heldPeak * release);
    meter.peak.store(heldPeak, std::memory_order_relaxed);
    const double samples = static_cast<double>(block.frames) * block.outputChannels;
    meter.rms.store(samples > 0 ? static_cast<float>(std::sqrt(squares / samples)) : 0,
                    std::memory_order_relaxed);
    const auto count = meter.clippedBlocks.load(std::memory_order_relaxed);
    if (clipped && count != UINT64_MAX)
      meter.clippedBlocks.store(count + 1, std::memory_order_relaxed);
    meter.callbacks.fetch_add(1, std::memory_order_release);
    if (auto* value = meter.songPeak.load(std::memory_order_relaxed))
      value->store(heldPeak, std::memory_order_relaxed);
    if (auto* value = meter.songRms.load(std::memory_order_relaxed))
      value->store(meter.rms.load(std::memory_order_relaxed), std::memory_order_relaxed);
    if (auto* value = meter.songClips.load(std::memory_order_relaxed)) {
      const auto previous = value->load(std::memory_order_relaxed);
      if (clipped && previous != UINT32_MAX) value->store(previous + 1, std::memory_order_relaxed);
    }
  }
};
// SINGZ_SERVICE_MASTER_RT_END

// Process-lifetime device owner. Client stop retires only that client's render
// context; the output keeps the silent base route ready for the next client.
// Graph stop retains the service output while an additive client still needs it.
// Input capture is deliberately separate and inactive until explicitly begun.
class SharedAudioService final {
 public:
  using BufferPreferences = std::map<std::string, uint32_t>;
  struct BufferChangeHooks {
    std::string inputUid;
    // All service callbacks are joined before these control-only hooks run.
    std::function<bool()> pauseInput;
    std::function<std::string(uint32_t)> resumeInput;
    std::function<void(uint64_t, uint64_t)> prepareCues;
  };
  // Reopen the same physical route without replacing its renderers/transport.
  // A failed change restores the previous policy and owners before returning.
  AudioHostResult applyBufferPreferences(const BufferPreferences&, const BufferChangeHooks& = {});
  uint32_t requestedBufferFrames(const std::string& uid) const;
  AudioInputConfig inputBufferConfig(AudioInputConfig config) const;
  SharedAudioService();
  explicit SharedAudioService(std::unique_ptr<AudioHostBackend> backend, std::string provider = {});
  ~SharedAudioService();
  SharedAudioService(const SharedAudioService&) = delete;
  SharedAudioService& operator=(const SharedAudioService&) = delete;

  AudioHostResult initialize(const AudioHostConfig& config = {});
  AudioHostResult ensureOutput();
  enum class PreviewClickError { None, InvalidConfiguration, OutputUnavailable, QueueFull };
  struct PreviewClickResult { bool ok; PreviewClickError error; std::string message; };
  // Opens only the existing selected base route; never requests a new period.
  PreviewClickResult previewClick(bool accent, float gain);
  PreviewClickMixer::Status previewClickStatus() const noexcept;
  // Empty UID explicitly follows subsequent system default changes.
  AudioHostResult configureOutput(const std::string& preferredUid);
  AudioHostResult configureProvider(std::unique_ptr<AudioHostBackend> backend, const std::string& provider);
  AudioHostInventory inventory() const;
  std::vector<AudioInputDevice> inputDevices() const;
  void refreshInventory();
  // Additive renderer: receives the output already rendered by the song.
  // Replacement/clear drains the callback before returning to the caller.
  void setTrainingRenderer(AudioHostRender render, void* context);
  void clearTrainingRenderer();
  // Additive microphone client sees song plus training and preserves that PCM.
  void setMicrophoneRenderer(AudioHostRender render, void* context);
  void clearMicrophoneRenderer();
  // Additive live voice, independent of song/lane lifetime; drained on detach.
  using MonitorAdmission = bool (*)(void*, const AudioHostInventory&, const AudioHostConfig&, const AudioHostResult&) noexcept;
  void setVoiceMonitorRenderer(AudioHostRender render, void* context, MonitorAdmission admission = nullptr);
  bool hasVoiceMonitorRenderer(const void* context) const;
  bool voiceMonitorOutputLost() const;
  void clearVoiceMonitorRenderer();
  // Linear 0..4, ramped over 128 frames after ALL additive clients. Available
  // without a song; rejects invalid values without changing the target.
  bool setMasterGain(float gain) noexcept;
  ServiceMasterMeterSnapshot outputMeter() const noexcept;
  // Preallocated process-lifetime publications wired into a prepared callback.
  ServiceMasterMeter& masterMeterState() noexcept;
  AudioHostStatus status() const;
  uint64_t renderedFrames() const noexcept;
  double sampleRate() const noexcept;
  uint64_t inventoryRevision() const noexcept;
  uint64_t enumerationCount() const noexcept;
  uint64_t watchedDeviceCount() const noexcept;
  std::string providerId() const;
  std::string activeOutputUid() const;
  // UID and physical output channel map copied together under the route lock.
  AudioHostConfig activeOutputConfig() const;
  // Selected output (or current system default), without opening a song host.
  AudioHostConfig commonOutputConfig() const;
  // Current song output intent, independent of transient client/host stop.
  // A completed browser handback clears it; a native client open sets it.
  bool playbackOutputCurrent() const;
  OutputCallbackDiagnosticSnapshot callbackDiagnostics() const noexcept;
  bool setPlaybackOutputCurrent(bool current);
  // Prepare a replacement graph for the retained physical host's capacity.
  uint32_t retainedPlaybackCapacity(const AudioHostConfig& config) const;
  uint64_t outputRouteGeneration() const noexcept;
  // Mobile may park the shared output while another route owns the device.
  void parkOutput() noexcept;
  void shutdown() noexcept;
  std::unique_ptr<AudioHostBackend> playbackBackend(
      std::unique_ptr<AudioHostBackend> backend, std::string provider);

 private:
  struct Impl;
  class Client;
  std::unique_ptr<Impl> impl_;
};

SharedAudioService& sharedAudioService();
std::unique_ptr<AudioHostBackend> sharedPlaybackBackend(
    std::unique_ptr<AudioHostBackend> backend, std::string provider);

}  // namespace singz
