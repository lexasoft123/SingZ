#include <zcore/device/audio_host.h>

// The Apple smoke build links this leaf with the isolated provider archive and
// its session-policy support. A direct constructor reference forces the
// archive's platform factory into the link even though product playback does
// not instantiate AudioHost before Phase 4.
extern "C" uint32_t singzIosAudioHostLinkSmoke() {
  singz::AudioHost host;
  const singz::AudioHostStatus status = host.status();
  return static_cast<uint32_t>(status.state);
}
