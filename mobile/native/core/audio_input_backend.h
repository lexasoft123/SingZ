#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "audio_input.h"

namespace singz {

using AudioInputPush = bool (*)(void*, const float*, uint32_t, uint64_t, uint64_t);

class AudioInputBackend {
 public:
  virtual ~AudioInputBackend() = default;
  // open() resolves/configures hardware but MUST NOT start callbacks. Its
  // returned rate is published into the shared delivery state before start().
  virtual AudioInputResult open(const AudioInputConfig& config, AudioInputPush push,
                                void* context) = 0;
  virtual AudioInputResult start() = 0;
  virtual void stop() = 0;
  // Lock-free backend flags are rendered into a message here, off RT.
  virtual bool takeFailure(std::string& error) = 0;
};

std::unique_ptr<AudioInputBackend> createPlatformAudioInputBackend();
std::vector<AudioInputDevice> enumeratePlatformAudioInputDevices(std::string* error);

#if defined(SINGZ_CORE_TESTS)
// Host-test injection: compiled out of every production core.
using AudioInputBackendFactoryForTests = std::unique_ptr<AudioInputBackend> (*)();
void setAudioInputBackendForTests(AudioInputBackendFactoryForTests factory,
                                  std::vector<AudioInputDevice> devices);
#endif

}  // namespace singz
