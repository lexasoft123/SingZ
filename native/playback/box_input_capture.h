#pragma once
#include <zcore/device/audio_input.h>
#include <memory>
#include <array>
namespace singz {
// Private analysis reader of LoopZ-owned history. All lifecycle calls run on
// the routing control owner; stop drains its reader before releasing the lease.
struct BoxInputMeter {
  bool valid{false};
  uint32_t channels{0};
  std::array<float, 64> peak{}, rms{};
};
class BoxInputCapture final {
 public:
  BoxInputCapture();
  ~BoxInputCapture();
  BoxInputCapture(const BoxInputCapture&) = delete;
  BoxInputCapture& operator=(const BoxInputCapture&) = delete;
  AudioInputResult start(const AudioInputConfig&, AudioInputSink,
                        const std::vector<AudioInputDevice>* = nullptr);
  void stop(bool retainPrepared = false);
  AudioInputStats stats() const;
  BoxInputMeter meter() const;
  AudioInputState state() const;
  std::string lastError() const;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}
