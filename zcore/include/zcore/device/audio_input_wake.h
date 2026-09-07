#pragma once

#include <cstdint>
#include <memory>

namespace singz {

// Platform event used by the portable SPSC consumer. Implementations live in
// per-OS files so audio_input.cpp has no HAL or operating-system headers.
class AudioInputWake {
 public:
  AudioInputWake();
  ~AudioInputWake();
  AudioInputWake(const AudioInputWake&) = delete;
  AudioInputWake& operator=(const AudioInputWake&) = delete;

  void signal() noexcept;
  void drain();
  bool wait(uint32_t timeoutMs);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace singz
