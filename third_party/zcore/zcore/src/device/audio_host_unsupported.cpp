#include "audio_host_unsupported.h"

#include <zcore/device/audio_host.h>

namespace singz {
namespace {

class UnsupportedAudioHostBackend final : public AudioHostBackend {
 public:
  AudioHostInventory enumerate() const override { return {}; }
  AudioHostResult open(const AudioHostConfig&, AudioHostRender, void*) override {
    return {false, AudioHostError::Unsupported, AudioHostState::Unsupported,
            {}, {}, "Full-duplex AudioHost is not implemented on this platform"};
  }
  AudioHostResult start() override {
    return {false, AudioHostError::Unsupported, AudioHostState::Unsupported,
            {}, {}, "Full-duplex AudioHost is not implemented on this platform"};
  }
  void stop() noexcept override {}
  AudioHostStatus status() const noexcept override {
    return {AudioHostState::Unsupported};
  }
};

}  // namespace

std::unique_ptr<AudioHostBackend> makeUnsupportedAudioHostBackend() {
  return std::make_unique<UnsupportedAudioHostBackend>();
}

}  // namespace singz
