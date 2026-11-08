#pragma once

#include <cstdint>
#include <memory>

#include <zcore/device/audio_host.h>

namespace singz {

struct FakeAudioHostOptions {
  uint32_t callbackCount{8};
  bool varyingBlocks{true};
  uint32_t injectXRunAt{0};
  uint32_t injectDeadlineMissAt{0};
  // Normalized long-running input for product lifecycle fixtures. The default
  // retains the original channel-identification ramp used by core tests.
  float inputScale{1.0F};
  bool realtimePaced{false};
};

std::unique_ptr<AudioHostBackend> createFakeAudioHostBackend(
    FakeAudioHostOptions options = {});

}  // namespace singz
