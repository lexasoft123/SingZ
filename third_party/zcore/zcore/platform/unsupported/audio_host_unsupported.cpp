#include "../../src/device/audio_host_unsupported.h"
#include <zcore/device/audio_host.h>
namespace singz {
std::unique_ptr<AudioHostBackend> createPlatformAudioHostBackend() {
  return makeUnsupportedAudioHostBackend();
}
}  // namespace singz
