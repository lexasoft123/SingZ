#include "zdsp/processor.h"

#include <stdint.h>

// Compile/link evidence only. Nothing calls this from Java or playback; keeping
// one external C++ reference prevents the shared-library link from discarding
// the otherwise-unreferenced same-toolchain contract validator. This is not a
// plug-in/shared-library C adapter or factory.
ZDSP_INTERNAL_API uint32_t singz_zdsp_contract_link_smoke() noexcept {
  const zdsp::AudioBusDescriptor stereo{2, zdsp::SampleFormat::Float32Planar,
                                         zdsp::AudioChannelLayout::Stereo, nullptr};
  const zdsp::PrepareSpec spec{zdsp::kProcessorInterfaceVersion,
                               zdsp::kPrepareSpecV1RequiredSize,
                               {48000.0}, {256}, 1, 1, &stereo, &stereo};
  return static_cast<uint32_t>(zdsp::validatePrepareSpec(spec).code);
}
