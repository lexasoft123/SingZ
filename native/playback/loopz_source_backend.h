#pragma once
#include <atomic>
#include <loopz/audio_history.hpp>
#include <loopz/runtime/audio_runtime.hpp>
#include <memory>
#include <zcore/device/audio_host.h>

namespace singz {
// One producer, arbitrarily many timestamped readers. No PCM crosses JS.
struct LoopZSongSource final : loopz::runtime::DeviceClockSource {
  LoopZSongSource();
  ~LoopZSongSource() override;
  std::shared_ptr<loopz::AudioHistory> history =
      std::make_shared<loopz::AudioHistory>(2);
  std::atomic<bool> leased{false};
  uint32_t channels() const noexcept override { return 2; }
  loopz::AudioReadResult
  read(uint64_t host, double rate, loopz::RoutingOutput output, uint32_t frames,
       loopz::AudioReadCursor &cursor) const noexcept override;
  loopz::AudioReadResult
  readWithFilter(uint64_t host, double rate, loopz::RoutingOutput output,
                 uint32_t frames, loopz::AudioReadCursor &cursor,
                 loopz::ResamplingFilter filter) const noexcept override;
  void selectClockDriver(const void *owner) const noexcept override;
  bool renderClocked(const void *owner,
                     const AudioHostRenderBlock &block) const noexcept override;
  bool deviceClocked() const noexcept;
  uint64_t clockRevision() const noexcept;
  // Serialized internal control APIs. Callback pointers are admitted only after
  // start and cleared only after all callbacks leave the source gate.
  void attachProducer(AudioHostRender render, void *context);
  void detachProducer(void *context) noexcept;
  void waitForFallback(const std::atomic<bool> &running) const;
  void wakeProducer() const noexcept;

private:
  struct State;
  std::unique_ptr<State> state_;
};
std::unique_ptr<AudioHostBackend>
createLoopZSourceBackend(std::shared_ptr<LoopZSongSource> source);
} // namespace singz
