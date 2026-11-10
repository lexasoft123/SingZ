#pragma once
#include <loopz/audio_history.hpp>
#include <zcore/device/audio_host.h>
#include <atomic>
#include <memory>

namespace singz {
// One producer, arbitrarily many timestamped readers. No PCM crosses JS.
struct LoopZSongSource {
  std::shared_ptr<loopz::AudioHistory> history = std::make_shared<loopz::AudioHistory>(2);
  std::atomic<bool> leased{false};
};
std::unique_ptr<AudioHostBackend> createLoopZSourceBackend(std::shared_ptr<LoopZSongSource> source);
} // namespace singz
