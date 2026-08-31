#pragma once

#include "zdsp/graph_runner.h"

namespace zdsp {

struct OfflineRenderSpec {
  FrameLength frames;
  FrameCount partitionFrames;
  uint32_t outputChannels;
};

struct OfflineRenderResult {
  uint64_t renderedFrames;
  uint64_t pcmHash;
  uint64_t wavHash;
  uint32_t wavBytes;
};

[[nodiscard]] ZDSP_INTERNAL_API Status renderOffline(
    CompiledGraph* graph, const OfflineRenderSpec& spec, float* planarOutput,
    MutableByteView wavOutput, OfflineRenderResult* result) noexcept;

}  // namespace zdsp
