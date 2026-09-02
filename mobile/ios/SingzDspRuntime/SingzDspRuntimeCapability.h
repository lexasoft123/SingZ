#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct SingzDspRuntimeLinkStatus {
  uint32_t interfaceVersion;
  uint32_t capabilityFlags;
  uint32_t playbackContractVersion;
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
  // The AudioHost callback receives a signed, generation-bound transport
  // snapshot and positioned sources consume its project sample clock.
  SingzDspRuntimeCapabilityPlaybackTransport = 1u << 5,
  // The linked runtime contains the immutable bounded scheduled-cue source;
  // the playback session links the portable cue planner that feeds it.
  SingzDspRuntimeCapabilityScheduledCues = 1u << 6,
  // One off-RT-prepared whole-song Signalsmith processor follows SongGain;
  // Q32 source transport and graph latency compensation are linked with it.
  SingzDspRuntimeCapabilityTimePitch = 1u << 7,
};

// Packaging evidence plus the capability gate for the versioned experimental
// playback facade. The runtime itself remains React/AVAudioSession-free; the
// serialized bridge helper configures the intended session only after the JS
// coordinator has suspended legacy output, and output ownership begins at the
// generation-bound openOutput command.
const SingzDspRuntimeLinkStatus *SingzDspRuntimeGetLinkStatus(void);

#ifdef __cplusplus
}
#endif
