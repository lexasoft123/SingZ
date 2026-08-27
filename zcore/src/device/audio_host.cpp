#include <zcore/device/audio_host.h>

namespace singz {

AudioHost::AudioHost() : backend_(createPlatformAudioHostBackend()) {}
AudioHost::AudioHost(std::unique_ptr<AudioHostBackend> backend)
    : backend_(std::move(backend)) {}
AudioHost::~AudioHost() { stop(); }
AudioHost::AudioHost(AudioHost&&) noexcept = default;
AudioHost& AudioHost::operator=(AudioHost&& other) noexcept {
  if (this == &other) return *this;
  stop();
  backend_ = std::move(other.backend_);
  return *this;
}

AudioHostInventory AudioHost::enumerate() const {
  return backend_ != nullptr ? backend_->enumerate() : AudioHostInventory{};
}

AudioHostResult AudioHost::open(const AudioHostConfig& config,
                                AudioHostRender render, void* renderContext) {
  if (backend_ == nullptr) {
    return {false, AudioHostError::Unsupported, AudioHostState::Unsupported,
            {}, {}, "No audio host provider is available"};
  }
  return backend_->open(config, render, renderContext);
}

AudioHostResult AudioHost::start() {
  if (backend_ == nullptr) {
    return {false, AudioHostError::Unsupported, AudioHostState::Unsupported,
            {}, {}, "No audio host provider is available"};
  }
  return backend_->start();
}

void AudioHost::stop() noexcept {
  if (backend_ != nullptr) backend_->stop();
}

AudioHostStatus AudioHost::status() const noexcept {
  return backend_ != nullptr ? backend_->status()
                             : AudioHostStatus{AudioHostState::Unsupported};
}

}  // namespace singz
