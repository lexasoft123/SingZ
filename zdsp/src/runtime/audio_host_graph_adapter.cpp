#include <zdsp/audio_host_graph_adapter.h>

#include <array>
#include <cmath>
#include <limits>

#include <zdsp/audio_bus.h>
#include <zdsp/graph_runner.h>
#include <zdsp/process_context.h>

namespace zdsp {
namespace {

void silence(const singz::AudioHostRenderBlock &block) noexcept {
  if (block.output == nullptr)
    return;
  for (uint32_t channel = 0; channel < block.outputChannels; ++channel) {
    float *samples = block.output[channel];
    if (samples == nullptr)
      continue;
    for (uint32_t frame = 0; frame < block.frames; ++frame)
      samples[frame] = 0.0F;
  }
}

bool addFrames(uint64_t value, uint32_t frames, uint64_t *result) noexcept {
  if (result == nullptr ||
      value > std::numeric_limits<uint64_t>::max() - frames)
    return false;
  *result = value + frames;
  return true;
}

bool addHostTime(uint64_t value, uint32_t frames, double sampleRate,
                 uint64_t *result) noexcept {
  if (result == nullptr || !std::isfinite(sampleRate) || sampleRate <= 0.0)
    return false;
  const long double delta =
      static_cast<long double>(frames) * 1000000000.0L / sampleRate;
  if (delta < 0.0L ||
      delta > static_cast<long double>(std::numeric_limits<uint64_t>::max()) ||
      value >
          std::numeric_limits<uint64_t>::max() - static_cast<uint64_t>(delta))
    return false;
  *result = value + static_cast<uint64_t>(delta);
  return true;
}

bool makeSubview(
    const singz::AudioHostRenderBlock &block, uint32_t offset, uint32_t frames,
    std::array<const float *, singz::kAudioHostMaxChannels> *inputPointers,
    std::array<float *, singz::kAudioHostMaxChannels> *outputPointers,
    singz::AudioHostRenderBlock *view) noexcept {
  if (inputPointers == nullptr || outputPointers == nullptr ||
      view == nullptr || offset > block.frames || frames == 0 ||
      frames > block.frames - offset ||
      block.inputChannels > singz::kAudioHostMaxChannels ||
      block.outputChannels > singz::kAudioHostMaxChannels)
    return false;
  *view = block;
  view->frames = frames;
  if (!addFrames(block.outputFrame, offset, &view->outputFrame))
    return false;
  if (block.inputTimestampValid &&
      !addFrames(block.inputSourceFrame, offset, &view->inputSourceFrame))
    return false;
  if (block.outputTimestampValid &&
      !addHostTime(block.outputHostTimeNs, offset, block.sampleRate,
                   &view->outputHostTimeNs))
    return false;
  if (block.inputTimestampValid &&
      !addHostTime(block.inputSampleHostTimeNs, offset, block.sampleRate,
                   &view->inputSampleHostTimeNs))
    return false;
  if (block.input != nullptr) {
    for (uint32_t channel = 0; channel < block.inputChannels; ++channel) {
      if (block.input[channel] == nullptr)
        return false;
      (*inputPointers)[channel] = block.input[channel] + offset;
    }
    view->input = inputPointers->data();
  }
  for (uint32_t channel = 0; channel < block.outputChannels; ++channel) {
    if (block.output[channel] == nullptr)
      return false;
    (*outputPointers)[channel] = block.output[channel] + offset;
  }
  view->output = outputPointers->data();
  return true;
}

bool renderSlice(AudioHostGraphAdapter *adapter,
                 const singz::AudioHostRenderBlock &block,
                 const TransportContext *transport,
                 Discontinuity discontinuity) noexcept {
  CaptureTime capture{};
  ProcessContext process{};
  mapAudioHostProcessContext(block, &process, &capture);
  process.discontinuity =
      coalesceAudioHostDiscontinuity(process.discontinuity, discontinuity);
  capture.discontinuity = process.discontinuity;
  if (process.discontinuity.reason != DiscontinuityReason::None) {
    process.time.flags |= RenderTimeDiscontinuous;
  } else {
    process.time.flags &= ~RenderTimeDiscontinuous;
  }
  process.transport = transport;
  const bool hasInput = block.inputChannels != 0;
  ConstAudioBusView input{block.input,
                          block.inputChannels,
                          {block.frames},
                          {block.maximumFrames},
                          &capture};
  MutableAudioBusView output{block.output,
                             block.outputChannels,
                             {block.frames},
                             {block.maximumFrames}};
  const Status status =
      renderGraphBlock(adapter->runner, process, hasInput ? &input : nullptr,
                       hasInput ? 1u : 0u, &output, 1);
  adapter->lastStatusCode.store(static_cast<uint32_t>(status.code),
                                std::memory_order_relaxed);
  return succeeded(status);
}

void saturate(std::atomic<uint32_t> &value) noexcept {
  uint32_t old = value.load(std::memory_order_relaxed);
  for (uint32_t attempt = 0; attempt < 4; ++attempt) {
    if (old == std::numeric_limits<uint32_t>::max() ||
        value.compare_exchange_weak(old, old + 1, std::memory_order_relaxed,
                                    std::memory_order_relaxed)) {
      return;
    }
  }
}

uint32_t discontinuityPriority(DiscontinuityReason reason) noexcept {
  switch (reason) {
  case DiscontinuityReason::None:
    return 0;
  case DiscontinuityReason::SourceLoop:
    return 10;
  case DiscontinuityReason::SourceSeek:
    return 20;
  case DiscontinuityReason::TimestampQualityChanged:
    return 30;
  case DiscontinuityReason::SampleRateChanged:
    return 40;
  case DiscontinuityReason::SequenceGap:
    return 50;
  case DiscontinuityReason::ClockReanchored:
    return 60;
  case DiscontinuityReason::StreamGenerationChanged:
    return 70;
  case DiscontinuityReason::RouteGenerationChanged:
    return 80;
  case DiscontinuityReason::SourceFrameOverflow:
    return 90;
  case DiscontinuityReason::DeviceLost:
    return 100;
  }
  return 0;
}

Discontinuity mapDiscontinuityFlags(uint32_t value) noexcept {
  Discontinuity result{DiscontinuityReason::None, DiscontinuityFlagNone};
  if ((value & singz::AudioHostDiscontinuityDeviceLost) != 0) {
    result = coalesceAudioHostDiscontinuity(
        result, {DiscontinuityReason::DeviceLost, DiscontinuityFlagResetState});
  }
  if ((value & singz::AudioHostDiscontinuityRouteChanged) != 0) {
    result = coalesceAudioHostDiscontinuity(
        result, {DiscontinuityReason::RouteGenerationChanged,
                 DiscontinuityFlagResetState | DiscontinuityFlagTimeValid});
  }
  if ((value & singz::AudioHostDiscontinuityXRun) != 0) {
    result = coalesceAudioHostDiscontinuity(
        result, {DiscontinuityReason::SequenceGap,
                 DiscontinuityFlagResetState | DiscontinuityFlagTimeValid});
  }
  if ((value & singz::AudioHostDiscontinuityTimestampQualityChanged) != 0) {
    result = coalesceAudioHostDiscontinuity(
        result, {DiscontinuityReason::TimestampQualityChanged,
                 DiscontinuityFlagResetState | DiscontinuityFlagTimeValid});
  }
  if ((value & singz::AudioHostDiscontinuityClockReanchored) != 0) {
    result = coalesceAudioHostDiscontinuity(
        result, {DiscontinuityReason::ClockReanchored,
                 DiscontinuityFlagResetState | DiscontinuityFlagTimeValid});
  }
  if ((value & singz::AudioHostDiscontinuitySequenceGap) != 0) {
    result = coalesceAudioHostDiscontinuity(
        result, {DiscontinuityReason::SequenceGap,
                 DiscontinuityFlagResetState | DiscontinuityFlagTimeValid});
  }
  if ((value & singz::AudioHostDiscontinuityStart) != 0) {
    result = coalesceAudioHostDiscontinuity(
        result, {DiscontinuityReason::StreamGenerationChanged,
                 DiscontinuityFlagResetState | DiscontinuityFlagTimeValid});
  }
  return result;
}

} // namespace

Discontinuity mapAudioHostDiscontinuity(uint32_t flags) noexcept {
  return mapDiscontinuityFlags(flags);
}

Discontinuity coalesceAudioHostDiscontinuity(Discontinuity left,
                                             Discontinuity right) noexcept {
  Discontinuity selected =
      discontinuityPriority(right.reason) > discontinuityPriority(left.reason)
          ? right
          : left;
  if (selected.reason == DiscontinuityReason::None)
    return {DiscontinuityReason::None, DiscontinuityFlagNone};
  selected.flags |= DiscontinuityFlagResetState;
  return selected;
}

bool renderAudioHostGraph(void *context,
                          const singz::AudioHostRenderBlock &block) noexcept {
  auto *adapter = static_cast<AudioHostGraphAdapter *>(context);
  const bool hasInput = block.inputChannels != 0;
  if (adapter == nullptr || adapter->runner == nullptr ||
      block.output == nullptr || block.outputChannels == 0 ||
      block.frames == 0 || block.frames > block.maximumFrames ||
      block.frames > singz::kAudioHostMaxFrames ||
      block.inputChannels > singz::kAudioHostMaxChannels ||
      block.outputChannels > singz::kAudioHostMaxChannels ||
      (hasInput && block.input == nullptr) ||
      (!hasInput && block.input != nullptr)) {
    silence(block);
    if (adapter != nullptr)
      saturate(adapter->renderFailures);
    return false;
  }
  if (adapter->transport.slice == nullptr) {
    if (renderSlice(adapter, block, nullptr,
                    {DiscontinuityReason::None, DiscontinuityFlagNone}))
      return true;
    saturate(adapter->renderFailures);
    silence(block);
    return false;
  }

  std::array<const float *, singz::kAudioHostMaxChannels> inputPointers{};
  std::array<float *, singz::kAudioHostMaxChannels> outputPointers{};
  uint32_t offset = 0;
  uint32_t slices = 0;
  while (offset < block.frames && slices < kAudioHostMaximumTransportSlices) {
    AudioHostTransportSlice transportSlice{};
    const uint32_t remaining = block.frames - offset;
    if (!adapter->transport.slice(adapter->transport.context, block, offset,
                                  remaining, &transportSlice) ||
        transportSlice.frames.value == 0 ||
        transportSlice.frames.value > remaining) {
      adapter->lastStatusCode.store(
          static_cast<uint32_t>(StatusCode::InvalidArgument),
          std::memory_order_relaxed);
      saturate(adapter->renderFailures);
      silence(block);
      return false;
    }
    singz::AudioHostRenderBlock view{};
    if (!makeSubview(block, offset, transportSlice.frames.value, &inputPointers,
                     &outputPointers, &view)) {
      adapter->lastStatusCode.store(
          static_cast<uint32_t>(StatusCode::InvalidArgument),
          std::memory_order_relaxed);
      saturate(adapter->renderFailures);
      silence(block);
      return false;
    }
    if (offset != 0)
      view.discontinuity = singz::AudioHostDiscontinuityNone;
    if (!renderSlice(adapter, view, &transportSlice.transport,
                     transportSlice.discontinuity)) {
      saturate(adapter->renderFailures);
      silence(block);
      return false;
    }
    offset += transportSlice.frames.value;
    ++slices;
  }
  if (offset != block.frames) {
    adapter->lastStatusCode.store(
        static_cast<uint32_t>(StatusCode::InvalidArgument),
        std::memory_order_relaxed);
    saturate(adapter->renderFailures);
    silence(block);
    return false;
  }
  return true;
}

void mapAudioHostProcessContext(const singz::AudioHostRenderBlock &block,
                                ProcessContext *process,
                                CaptureTime *capture) noexcept {
  if (process == nullptr || capture == nullptr)
    return;
  const Discontinuity discontinuity =
      mapAudioHostDiscontinuity(block.discontinuity);
  *capture = {
      {block.clockDomain},
      {block.streamGeneration},
      block.callbackSequence,
      {block.inputSourceFrame},
      {block.inputSampleHostTimeNs},
      {block.callbackHostTimeNs},
      !block.inputTimestampValid
          ? CaptureTimestampQuality::Unknown
          : (block.inputTimestampHardware ? CaptureTimestampQuality::Hardware
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
  process->time = {
      {block.clockDomain},
      {block.streamGeneration},
      {block.outputFrame},
      {block.outputHostTimeNs},
      {block.callbackHostTimeNs},
      (block.outputTimestampValid ? RenderTimeHostValid : 0u) |
          (block.outputTimestampHardware ? RenderTimeHostHardware : 0u) |
          (block.discontinuity != singz::AudioHostDiscontinuityNone
               ? RenderTimeDiscontinuous
               : 0u)};
  process->sampleRate = {block.sampleRate};
  process->frames = {block.frames};
  process->discontinuity = discontinuity;
}

} // namespace zdsp
