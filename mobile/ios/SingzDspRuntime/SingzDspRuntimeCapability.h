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

// Packaging evidence plus the capability gate for the one Experimental B2
// product facade. The runtime itself remains React/AVAudioSession-free; the
// serialized bridge helper configures the intended session only after the JS
// coordinator has suspended legacy output, and output ownership begins at the
// generation-bound openOutput command.
const SingzDspRuntimeLinkStatus *SingzDspRuntimeGetLinkStatus(void);

#ifdef __cplusplus
}
#endif
