#pragma once

#include <memory>
#include <string>
#include <vector>
#include <zcore/device/audio_host.h>
#include <zcore/device/audio_input.h>

namespace singz {

// Process-lifetime device owner. Client stop retires only that client's render
// context; the output keeps the silent base route ready for the next client.
// Input capture is deliberately separate and inactive until explicitly begun.
class SharedAudioService final {
 public:
  SharedAudioService();
  explicit SharedAudioService(std::unique_ptr<AudioHostBackend> backend);
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
  AudioHostStatus status() const;
  uint64_t renderedFrames() const noexcept;
  double sampleRate() const noexcept;
  uint64_t inventoryRevision() const noexcept;
  uint64_t enumerationCount() const noexcept;
  uint64_t watchedDeviceCount() const noexcept;
  std::string providerId() const;
  // Monitoring has an exclusive direct host until it joins this service.
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
