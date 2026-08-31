#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct SingzDspRuntimeLinkStatus {
  uint32_t interfaceVersion;
  uint32_t capabilityFlags;
  const char *buildId;
} SingzDspRuntimeLinkStatus;

enum {
  SingzDspRuntimeCapabilityGraph = 1u << 0,
  SingzDspRuntimeCapabilityAudioHostAdapter = 1u << 1,
  SingzDspRuntimeCapabilityPlaybackCallback = 1u << 2,
  // Normal unload resolves a generation-exact, process-global cleanup proof.
  SingzDspRuntimeCapabilityPlaybackCleanupProof = 1u << 3,
  // Cleanup proof transfers process ownership through a positive JS-safe
  // handoff lease that the next prepare consumes atomically.
  SingzDspRuntimeCapabilityPlaybackHandoffLease = 1u << 4,
};

// Packaging evidence only. Phase iOS-B1 exposes dormant generation-bound
// playback commands through the existing React Native bridge, but no product
// JavaScript consumes them. The runtime never mutates AVAudioSession and takes
// output ownership only after a future B2 coordinator explicitly calls the
// prepared session's openOutput command.
const SingzDspRuntimeLinkStatus *SingzDspRuntimeGetLinkStatus(void);

#ifdef __cplusplus
}
#endif
