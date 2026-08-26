#pragma once

#include "zdsp/graph.h"
#include "zdsp/queues.h"

namespace zdsp {

struct RuntimeBuffer {
  float** channels;
  float* samples;
  uint32_t channelCount;
  const CaptureTime* capture;
};

struct RuntimeCaptureDelay {
  CaptureTime* samples;
  uint8_t* valid;
  CaptureTime output;
  uint32_t frames;
  uint32_t cursor;
};

struct RuntimeDelay {
  float* samples;
  uint32_t frames;
  uint32_t cursor;
  uint32_t channels;
  uint32_t sourceBuffer;
  uint32_t destinationBuffer;
  RuntimeCaptureDelay capture;
};

struct RuntimeInputBinding {
  uint32_t buffer;
  RuntimeDelay* delay;
  uint32_t channels;
};

struct RuntimeOutputBinding { uint32_t buffer; uint32_t channels; };

struct RuntimeNode {
  NodeId id;
  GraphNodeRole role;
  uint32_t flags;
  ProcessorHandle processor;
  RuntimeInputBinding* inputs;
  RuntimeOutputBinding* outputs;
  RuntimeDelay* bypassDelay;
  RuntimeCaptureDelay* captureDelay;
  uint32_t inputCount;
  uint32_t outputCount;
  ProcessorOwnershipState ownership;
};

struct RuntimeExternalBus {
  uint32_t buffer;
  uint32_t channels;
  SampleFormat sampleFormat;
  AudioChannelLayout layout;
  AudioChannelRole roles[kMaximumChannelsPerBus];
};

struct CompiledGraph {
  SampleRateHz sampleRate;
  FrameCount maximumBlockFrames;
  RuntimeNode* nodes;
  uint32_t nodeCount;
  RuntimeBuffer* buffers;
  uint32_t bufferCount;
  RuntimeExternalBus* inputs;
  uint32_t inputCount;
  RuntimeExternalBus* outputs;
  uint32_t outputCount;
  RuntimeDelay* delays;
  uint32_t delayCount;
  RuntimeCaptureDelay* captureDelays;
  uint32_t captureDelayCount;
  BufferPlanSummary plan;
  LatencyFrames latency;
  TailInfo tail;
};

[[nodiscard]] Status processCompiledGraph(
    CompiledGraph* graph, const ProcessContext& context,
    const ConstAudioBusView* inputs, uint32_t inputCount,
    const MutableAudioBusView* outputs, uint32_t outputCount,
    RuntimeDiagnostics* diagnostics) noexcept;

}  // namespace zdsp
