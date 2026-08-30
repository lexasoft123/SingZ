#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct SingzDspRuntimeLinkStatus {
  uint32_t interfaceVersion;
  uint32_t capabilityFlags;
  const char* buildId;
} SingzDspRuntimeLinkStatus;

enum {
  SingzDspRuntimeCapabilityGraph = 1u << 0,
  SingzDspRuntimeCapabilityAudioHostAdapter = 1u << 1,
};

// Packaging evidence only. Phase iOS-A deliberately exposes no graph/session
// open or start command and never takes AVAudioSession or output ownership.
const SingzDspRuntimeLinkStatus* SingzDspRuntimeGetLinkStatus(void);

#ifdef __cplusplus
}
#endif
