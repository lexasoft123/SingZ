#pragma once

#include "output_callback_diagnostics.h"
#include <memory>
#include <optional>
#include <string>
#include <vector>
#include <zcore/device/audio_host.h>
#include <zcore/device/audio_input.h>

namespace singz {

// Process-lifetime device owner. Client stop retires only that client's render
// context; the output keeps the silent base route ready for the next client.
// Song and monitor buffer holds release independently; graph stop retains the song hold.
// Input capture is deliberately separate and inactive until explicitly begun.
class SharedAudioService final {
 public:
  SharedAudioService();
  explicit SharedAudioService(std::unique_ptr<AudioHostBackend> backend, std::string provider = {});
  ~SharedAudioService();
  SharedAudioService(const SharedAudioService&) = delete;
  SharedAudioService& operator=(const SharedAudioService&) = delete;

  AudioHostResult initialize(const AudioHostConfig& config = {});
  AudioHostResult ensureOutput();
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
  // Final bus mixer sees song plus training PCM and must preserve that input.
  void setMicrophoneRenderer(AudioHostRender render, void* context);
  void clearMicrophoneRenderer();
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
  AudioHostConfig voiceMonitorOutputConfig(const std::optional<std::string>& selectedUid = {}, bool independent = false) const;
  // Weakly tracked activity: a joining song adopts the monitor period without writing.
  std::shared_ptr<const AudioHostConfig> retainVoiceMonitorOutput(const AudioHostConfig& config);
  // Current song output intent, independent of transient client/host stop.
  // A completed browser handback clears it; a native client open sets it.
  bool playbackOutputCurrent() const;
  OutputCallbackDiagnosticSnapshot callbackDiagnostics() const noexcept;
  bool setPlaybackOutputCurrent(bool current);
  // An existing song host negotiates once and holds until its session ends.
  AudioHostResult prepareVoiceMonitor(uint32_t targetFrames = 32, uint32_t maximumFrames = 256);
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
