#pragma once

#include <atomic>
#include <cstdint>

#include <zcore/device/audio_host_render.h>
#include <zdsp/clock.h>
#include <zdsp/process_context.h>

namespace zdsp {
struct GraphRunner;

static_assert(std::atomic<uint32_t>::is_always_lock_free,
              "The audio-host adapter requires native 32-bit atomic telemetry");

struct AudioHostGraphAdapter {
  GraphRunner* runner{nullptr};
  std::atomic<uint32_t> renderFailures{0};
  std::atomic<uint32_t> lastStatusCode{0};
};

bool renderAudioHostGraph(void* context,
                          const singz::AudioHostRenderBlock& block) noexcept;
void mapAudioHostProcessContext(const singz::AudioHostRenderBlock& block,
                                ProcessContext* process,
                                CaptureTime* capture) noexcept;

}  // namespace zdsp
