#include "zdsp/offline_renderer.h"

#include "../runtime/graph_internal.h"

#include <bit>
#include <cmath>
#include <limits.h>

namespace zdsp {
namespace {

constexpr uint64_t kFnvOffset = 1469598103934665603ull;
constexpr uint64_t kFnvPrime = 1099511628211ull;

void hashByte(uint8_t value, uint64_t* hash) noexcept {
  *hash ^= value;
  *hash *= kFnvPrime;
}

void put8(uint8_t value, MutableByteView output, uint32_t* cursor,
          uint64_t* hash) noexcept {
  output.data[(*cursor)++] = value;
  hashByte(value, hash);
}
void put16(uint16_t value, MutableByteView output, uint32_t* cursor,
           uint64_t* hash) noexcept {
  put8(static_cast<uint8_t>(value), output, cursor, hash);
  put8(static_cast<uint8_t>(value >> 8), output, cursor, hash);
}
void put32(uint32_t value, MutableByteView output, uint32_t* cursor,
           uint64_t* hash) noexcept {
  put16(static_cast<uint16_t>(value), output, cursor, hash);
  put16(static_cast<uint16_t>(value >> 16), output, cursor, hash);
}
void four(const char value[4], MutableByteView output, uint32_t* cursor,
          uint64_t* hash) noexcept {
  for (uint32_t index = 0; index < 4; ++index)
    put8(static_cast<uint8_t>(value[index]), output, cursor, hash);
}

}  // namespace

Status renderOffline(CompiledGraph* graph, const OfflineRenderSpec& spec,
                     float* planarOutput, MutableByteView wavOutput,
                     OfflineRenderResult* result) noexcept {
  if (graph == nullptr || planarOutput == nullptr || result == nullptr ||
      spec.frames.value > UINT32_MAX || spec.partitionFrames.value == 0 ||
      spec.partitionFrames.value > graph->maximumBlockFrames.value ||
      spec.outputChannels == 0 || graph->inputCount != 0 || graph->outputCount != 1 ||
      graph->outputs[0].channels != spec.outputChannels ||
      !std::isfinite(graph->sampleRate.value) || graph->sampleRate.value > UINT32_MAX)
    return {StatusCode::InvalidArgument, 1};
  const uint32_t totalFrames = static_cast<uint32_t>(spec.frames.value);
  const uint64_t dataBytes64 = static_cast<uint64_t>(totalFrames) *
                               spec.outputChannels * sizeof(float);
  if (dataBytes64 > UINT32_MAX - 44) return {StatusCode::CapacityExceeded, 2};
  const uint32_t dataBytes = static_cast<uint32_t>(dataBytes64);
  if (wavOutput.data == nullptr || wavOutput.capacity < 44 + dataBytes)
    return {StatusCode::InsufficientStorage, 3};

  uint32_t rendered = 0;
  while (rendered < totalFrames) {
    const uint32_t remaining = totalFrames - rendered;
    const uint32_t frames = remaining < spec.partitionFrames.value
        ? remaining : spec.partitionFrames.value;
    float* channels[kMaximumChannelsPerBus]{};
    for (uint32_t channel = 0; channel < spec.outputChannels; ++channel)
      channels[channel] = planarOutput +
          static_cast<size_t>(channel) * totalFrames + rendered;
    MutableAudioBusView output{channels, spec.outputChannels, {frames}, {frames}};
    ProcessContext context{kProcessContextInterfaceVersion,
        kProcessContextV1RequiredSize,
        {{1}, {1}, {rendered}, {0}, {0}, RenderTimeNone}, nullptr,
        graph->sampleRate, {frames}, nullptr, 0, nullptr, 0, {nullptr, 0},
        {DiscontinuityReason::None, DiscontinuityFlagNone}};
    const Status status = processCompiledGraph(graph, context, nullptr, 0,
                                                &output, 1, nullptr);
    if (!succeeded(status)) return status;
    rendered += frames;
  }

  uint64_t pcmHash = kFnvOffset;
  for (uint32_t frame = 0; frame < totalFrames; ++frame) {
    for (uint32_t channel = 0; channel < spec.outputChannels; ++channel) {
      const uint32_t bits = std::bit_cast<uint32_t>(
          planarOutput[static_cast<size_t>(channel) * totalFrames + frame]);
      for (uint32_t byte = 0; byte < 4; ++byte)
        hashByte(static_cast<uint8_t>(bits >> (byte * 8)), &pcmHash);
    }
  }

  const uint32_t rate = static_cast<uint32_t>(std::llround(graph->sampleRate.value));
  const uint64_t byteRate = static_cast<uint64_t>(rate) * spec.outputChannels * sizeof(float);
  if (byteRate > UINT32_MAX) return {StatusCode::CapacityExceeded, 4};
  uint64_t wavHash = kFnvOffset;
  uint32_t cursor = 0;
  four("RIFF", wavOutput, &cursor, &wavHash);
  put32(36 + dataBytes, wavOutput, &cursor, &wavHash);
  four("WAVE", wavOutput, &cursor, &wavHash);
  four("fmt ", wavOutput, &cursor, &wavHash);
  put32(16, wavOutput, &cursor, &wavHash);
  put16(3, wavOutput, &cursor, &wavHash);
  put16(static_cast<uint16_t>(spec.outputChannels), wavOutput, &cursor, &wavHash);
  put32(rate, wavOutput, &cursor, &wavHash);
  put32(static_cast<uint32_t>(byteRate), wavOutput, &cursor, &wavHash);
  put16(static_cast<uint16_t>(spec.outputChannels * sizeof(float)),
        wavOutput, &cursor, &wavHash);
  put16(32, wavOutput, &cursor, &wavHash);
  four("data", wavOutput, &cursor, &wavHash);
  put32(dataBytes, wavOutput, &cursor, &wavHash);
  for (uint32_t frame = 0; frame < totalFrames; ++frame) {
    for (uint32_t channel = 0; channel < spec.outputChannels; ++channel) {
      const uint32_t bits = std::bit_cast<uint32_t>(
          planarOutput[static_cast<size_t>(channel) * totalFrames + frame]);
      put32(bits, wavOutput, &cursor, &wavHash);
    }
  }
  *result = {totalFrames, pcmHash, wavHash, cursor};
  return okStatus();
}

}  // namespace zdsp
