#include <zdsp/audio_host_graph_adapter.h>

#include <limits>

#include <zdsp/audio_bus.h>
#include <zdsp/graph_runner.h>
#include <zdsp/process_context.h>

namespace zdsp {
namespace {

void silence(const singz::AudioHostRenderBlock& block) noexcept {
  if (block.output == nullptr) return;
  for (uint32_t channel = 0; channel < block.outputChannels; ++channel) {
    float* samples = block.output[channel];
    if (samples == nullptr) continue;
    for (uint32_t frame = 0; frame < block.frames; ++frame) samples[frame] = 0.0F;
  }
}

void saturate(std::atomic<uint32_t>& value) noexcept {
  uint32_t old = value.load(std::memory_order_relaxed);
  for (uint32_t attempt = 0; attempt < 4; ++attempt) {
    if (old == std::numeric_limits<uint32_t>::max() ||
        value.compare_exchange_weak(old, old + 1, std::memory_order_relaxed,
                                    std::memory_order_relaxed)) {
      return;
    }
  }
}

Discontinuity mapDiscontinuity(uint32_t value) noexcept {
  if ((value & singz::AudioHostDiscontinuityDeviceLost) != 0) {
    return {DiscontinuityReason::DeviceLost, DiscontinuityFlagResetState};
  }
  if ((value & singz::AudioHostDiscontinuityRouteChanged) != 0) {
    return {DiscontinuityReason::RouteGenerationChanged,
            DiscontinuityFlagResetState | DiscontinuityFlagTimeValid};
  }
  if ((value & singz::AudioHostDiscontinuityXRun) != 0) {
    return {DiscontinuityReason::SequenceGap,
            DiscontinuityFlagResetState | DiscontinuityFlagTimeValid};
  }
  if ((value & singz::AudioHostDiscontinuityTimestampQualityChanged) != 0) {
    return {DiscontinuityReason::TimestampQualityChanged,
            DiscontinuityFlagResetState | DiscontinuityFlagTimeValid};
  }
  if ((value & singz::AudioHostDiscontinuityClockReanchored) != 0) {
    return {DiscontinuityReason::ClockReanchored,
            DiscontinuityFlagResetState | DiscontinuityFlagTimeValid};
  }
  if ((value & singz::AudioHostDiscontinuitySequenceGap) != 0) {
    return {DiscontinuityReason::SequenceGap,
            DiscontinuityFlagResetState | DiscontinuityFlagTimeValid};
  }
  if ((value & singz::AudioHostDiscontinuityStart) != 0) {
    return {DiscontinuityReason::StreamGenerationChanged,
            DiscontinuityFlagResetState | DiscontinuityFlagTimeValid};
  }
  return {DiscontinuityReason::None, DiscontinuityFlagNone};
}

}  // namespace

bool renderAudioHostGraph(void* context,
                          const singz::AudioHostRenderBlock& block) noexcept {
  auto* adapter = static_cast<AudioHostGraphAdapter*>(context);
  const bool hasInput = block.inputChannels != 0;
  if (adapter == nullptr || adapter->runner == nullptr ||
      block.output == nullptr || block.outputChannels == 0 || block.frames == 0 ||
      (hasInput && block.input == nullptr) ||
      (!hasInput && block.input != nullptr)) {
    silence(block);
    if (adapter != nullptr) saturate(adapter->renderFailures);
    return false;
  }
  CaptureTime capture{};
  ProcessContext process{};
  mapAudioHostProcessContext(block, &process, &capture);
  ConstAudioBusView input{block.input, block.inputChannels, {block.frames},
                          {block.maximumFrames}, &capture};
  MutableAudioBusView output{block.output, block.outputChannels, {block.frames},
                             {block.maximumFrames}};
  const Status status = renderGraphBlock(adapter->runner, process,
                                         hasInput ? &input : nullptr,
                                         hasInput ? 1u : 0u, &output, 1);
  adapter->lastStatusCode.store(static_cast<uint32_t>(status.code),
                                std::memory_order_relaxed);
  if (!succeeded(status)) {
    saturate(adapter->renderFailures);
    silence(block);
    return false;
  }
  return true;
}

void mapAudioHostProcessContext(const singz::AudioHostRenderBlock& block,
                                ProcessContext* process,
                                CaptureTime* capture) noexcept {
  if (process == nullptr || capture == nullptr) return;
  const Discontinuity discontinuity = mapDiscontinuity(block.discontinuity);
  *capture = {{block.clockDomain}, {block.streamGeneration}, block.callbackSequence,
              {block.inputSourceFrame}, {block.inputSampleHostTimeNs},
              {block.callbackHostTimeNs},
              !block.inputTimestampValid
                  ? CaptureTimestampQuality::Unknown
                  : (block.inputTimestampHardware
                         ? CaptureTimestampQuality::Hardware
                         : CaptureTimestampQuality::Estimated),
              discontinuity,
              CaptureTimeCallbackHostValid |
                  (block.inputTimestampValid
                       ? CaptureTimeSourceFrameValid | CaptureTimeSampleHostValid |
                             CaptureTimeTimestampQualityValid
                       : CaptureTimeNone)};
  *process = {};
  process->interfaceVersion = kProcessContextInterfaceVersion;
  process->structSize = kProcessContextV2RequiredSize;
  process->time = {{block.clockDomain}, {block.streamGeneration}, {block.outputFrame},
                   {block.outputHostTimeNs}, {block.callbackHostTimeNs},
                   (block.outputTimestampValid ? RenderTimeHostValid : 0u) |
                       (block.outputTimestampHardware
                            ? RenderTimeHostHardware
                            : 0u) |
                       (block.discontinuity != singz::AudioHostDiscontinuityNone
                            ? RenderTimeDiscontinuous
                            : 0u)};
  process->sampleRate = {block.sampleRate};
  process->frames = {block.frames};
  process->discontinuity = discontinuity;
}

}  // namespace zdsp
