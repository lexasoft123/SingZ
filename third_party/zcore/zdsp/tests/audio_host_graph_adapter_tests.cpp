#include <zdsp/audio_host_graph_adapter.h>
#include <zdsp/builtin_nodes.h>
#include <zdsp/graph.h>
#include <zdsp/graph_runner.h>
#include <zdsp/realtime_arena.h>

#include "allocation_trap.h"

#include <array>
#include <cstdio>
#include <cstdlib>
#include <vector>

#define CHECK(expression)                                                      \
  do {                                                                         \
    if (!(expression)) {                                                       \
      std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__,  \
                   #expression);                                               \
      std::abort();                                                            \
    }                                                                          \
  } while (false)

namespace {
struct TransportProviderState {
  zdsp::TransportContext transport{};
  uint32_t calls{0};
  uint64_t lastOutputFrame{0};
  std::array<uint32_t, 8> offsets{};
  std::array<uint32_t, 8> remaining{};
  uint32_t requestedFrames{0};
  bool succeeds{true};
};

bool sliceTransport(void *opaque, const singz::AudioHostRenderBlock &block,
                    uint32_t offset, uint32_t remaining,
                    zdsp::AudioHostTransportSlice *slice) noexcept {
  auto *state = static_cast<TransportProviderState *>(opaque);
  if (state == nullptr || slice == nullptr)
    return false;
  if (state->calls < state->offsets.size()) {
    state->offsets[state->calls] = offset;
    state->remaining[state->calls] = remaining;
  }
  ++state->calls;
  state->lastOutputFrame = block.outputFrame;
  if (!state->succeeds)
    return false;
  slice->transport = state->transport;
  slice->transport.projectTimeSamples += offset;
  slice->transport.continuousTimeSamples += offset;
  slice->frames = {state->requestedFrames == 0 ? remaining
                                               : state->requestedFrames};
  return true;
}

struct SliceProbeState {
  std::array<int64_t, 8> project{};
  std::array<uint64_t, 8> graphFrames{};
  std::array<uint64_t, 8> renderHostTimes{};
  std::array<uint64_t, 8> callbackHostTimes{};
  std::array<zdsp::DiscontinuityReason, 8> discontinuities{};
  std::array<uint32_t, 8> discontinuityFlags{};
  uint32_t calls{0};
};

zdsp::Status probePrepare(void *, const zdsp::PrepareSpec *,
                          const zdsp::PreparedStorage *) noexcept {
  return zdsp::okStatus();
}

void probeReset(void *, zdsp::Discontinuity) noexcept {}

void probeProcess(void *opaque, const zdsp::ProcessContext *process,
                  const zdsp::ConstAudioBusView *, uint32_t,
                  const zdsp::MutableAudioBusView *outputs,
                  uint32_t outputCount) noexcept {
  auto *state = static_cast<SliceProbeState *>(opaque);
  if (state == nullptr || process == nullptr || process->transport == nullptr ||
      outputs == nullptr || outputCount != 1 || outputs[0].channelCount != 1)
    return;
  const uint32_t call = state->calls++;
  if (call < state->project.size()) {
    state->project[call] = process->transport->projectTimeSamples;
    state->graphFrames[call] = process->time.graphFrame.value;
    state->renderHostTimes[call] = process->time.renderHostTime.value;
    state->callbackHostTimes[call] = process->time.callbackHostTime.value;
    state->discontinuities[call] = process->discontinuity.reason;
    state->discontinuityFlags[call] = process->discontinuity.flags;
  }
  for (uint32_t frame = 0; frame < process->frames.value; ++frame)
    outputs[0].channels[0][frame] = static_cast<float>(
        process->transport->projectTimeSamples + static_cast<int64_t>(frame));
}

zdsp::LatencyFrames probeLatency(const void *) noexcept { return {0}; }
zdsp::TailInfo probeTail(const void *) noexcept {
  return {zdsp::TailKind::None, {0}};
}
zdsp::Status probeDeactivate(void *) noexcept { return zdsp::okStatus(); }
zdsp::Status probeDestroy(void *) noexcept { return zdsp::okStatus(); }

constexpr zdsp::ProcessorVTable kSliceProbeFunctions{
    zdsp::kProcessorInterfaceVersion,
    zdsp::kProcessorVTableV1RequiredSize,
    probePrepare,
    probeReset,
    probeProcess,
    probeLatency,
    probeTail,
    probeDeactivate,
    probeDestroy};

struct BoundaryProviderState {
  uint32_t calls{0};
  bool zeroSlice{false};
  bool oversizeSlice{false};
  zdsp::Discontinuity firstDiscontinuity{zdsp::DiscontinuityReason::None,
                                         zdsp::DiscontinuityFlagNone};
};

bool boundaryTransport(void *opaque, const singz::AudioHostRenderBlock &,
                       uint32_t offset, uint32_t remaining,
                       zdsp::AudioHostTransportSlice *slice) noexcept {
  auto *state = static_cast<BoundaryProviderState *>(opaque);
  if (state == nullptr || slice == nullptr)
    return false;
  ++state->calls;
  slice->transport.validFields = zdsp::TransportValidProjectSamples |
                                 zdsp::TransportValidContinuousSamples;
  slice->transport.stateFlags = zdsp::TransportStatePlaying;
  slice->transport.projectTimeSamples = static_cast<int64_t>(offset) - 2;
  slice->transport.continuousTimeSamples = offset;
  if (state->zeroSlice) {
    slice->frames = {0};
    return true;
  }
  if (state->oversizeSlice) {
    slice->frames = {remaining + 1};
    return true;
  }
  if (offset == 0) {
    slice->frames = {2};
    slice->discontinuity = state->firstDiscontinuity;
  } else if (offset == 2) {
    slice->frames = {3};
    slice->discontinuity = {zdsp::DiscontinuityReason::SourceSeek,
                            zdsp::DiscontinuityFlagResetState |
                                zdsp::DiscontinuityFlagTimeValid};
  } else {
    slice->frames = {remaining};
    slice->discontinuity = {zdsp::DiscontinuityReason::SourceLoop,
                            zdsp::DiscontinuityFlagResetState |
                                zdsp::DiscontinuityFlagTimeValid};
  }
  return true;
}

void expectReason(singz::AudioHostRenderBlock block, uint32_t flags,
                  zdsp::DiscontinuityReason reason) {
  block.discontinuity = flags;
  zdsp::ProcessContext process{};
  zdsp::CaptureTime capture{};
  zdsp::mapAudioHostProcessContext(block, &process, &capture);
  CHECK(process.discontinuity.reason == reason);
  CHECK((process.discontinuity.flags & zdsp::DiscontinuityFlagResetState) != 0);
  CHECK(capture.discontinuity.reason == reason);
}

void successPathInvokesGraph() {
  std::vector<uint8_t> storageBytes(1024 * 1024);
  zdsp::RealtimeArena arena{};
  CHECK(zdsp::succeeded(zdsp::initializeArena(
      &arena,
      {storageBytes.data(), static_cast<uint32_t>(storageBytes.size())})));
  zdsp::AudioBusDescriptor mono{1, zdsp::SampleFormat::Float32Planar,
                                zdsp::AudioChannelLayout::Mono, nullptr};
  zdsp::BuiltinNodeConfig gainConfig{
      zdsp::BuiltinNodeKind::Gain,   {2},     1, 1, 1, 0.5F, 1.0F, 0,
      zdsp::OscillatorWaveform::Saw, nullptr, 0};
  const size_t stateSize = zdsp::builtinStateBytes(gainConfig);
  auto *state =
      static_cast<uint8_t *>(zdsp::arenaAllocate(&arena, stateSize, 64));
  CHECK(state != nullptr);
  const zdsp::ProcessorHandle gain = zdsp::createBuiltinProcessor(
      gainConfig, {state, static_cast<uint32_t>(stateSize)});
  CHECK(gain.state != nullptr);
  const size_t preparedSize = zdsp::builtinPreparedBytes(gainConfig, {64});
  void *prepared = preparedSize == 0 ? nullptr
                                     : zdsp::arenaAllocate(&arena, preparedSize,
                                                           alignof(float));
  CHECK(preparedSize == 0 || prepared != nullptr);
  zdsp::GraphNodeDescription nodes[] = {
      {{1},
       {0, 1},
       1,
       zdsp::GraphNodeRole::Input,
       zdsp::GraphNodeFlagNone,
       0,
       1,
       nullptr,
       &mono,
       {},
       {}},
      {{2},
       {1, 1},
       1,
       zdsp::GraphNodeRole::Processor,
       zdsp::GraphNodeFlagMayProcessInPlace,
       1,
       1,
       &mono,
       &mono,
       gain,
       {prepared, preparedSize, alignof(float)}},
      {{3},
       {0, 3},
       1,
       zdsp::GraphNodeRole::Output,
       zdsp::GraphNodeFlagNone,
       1,
       0,
       &mono,
       nullptr,
       {},
       {}}};
  zdsp::GraphConnection connections[] = {{{1}, 0, {2}, 0}, {{2}, 0, {3}, 0}};
  zdsp::GraphDescription description{
      zdsp::kGraphFormatVersion, {48000.0}, {64}, nodes, 3, connections, 2};
  zdsp::GraphCompileResult compiled{};
  zdsp::GraphCompileError compileError{};
  CHECK(zdsp::succeeded(
      zdsp::compileGraph(description, &arena, &compiled, &compileError)));

  zdsp::RuntimeDiagnostics diagnostics{};
  zdsp::RetirementSlot slot[1]{};
  zdsp::SnapshotPublisher publisher{};
  zdsp::initializePublisher(&publisher, slot, 1, &diagnostics);
  zdsp::TransitionPlan hardCut{zdsp::TransitionKind::HardCut,
                               {0},
                               {0},
                               {0},
                               zdsp::InfiniteTailPolicy::Cut,
                               {zdsp::TailKind::None, {0}},
                               {0},
                               0,
                               100,
                               1000,
                               0};
  zdsp::PublishedGraphSnapshot snapshot{compiled.graph, 1, hardCut, 0};
  CHECK(zdsp::succeeded(zdsp::submitSnapshot(&publisher, &snapshot).status));
  zdsp::GraphRunner runner{};
  zdsp::initializeGraphRunner(&runner, &publisher, {}, nullptr, nullptr,
                              &diagnostics);
  zdsp::AudioHostGraphAdapter adapter{&runner};
  float inputSamples[]{1.0F, -0.5F, 0.25F, 0.0F};
  float outputSamples[4]{};
  const float *input[] = {inputSamples};
  float *output[] = {outputSamples};
  singz::AudioHostRenderBlock block{
      input,   output,  1,
      1,       4,       64,
      48000.0, 77,      5,
      3,       19,      1000,
      900000,  true,    true,
      2000,    1000000, true,
      true,    950000,  singz::AudioHostDiscontinuityNone,
      true};
  const bool rendered = zdsp::renderAudioHostGraph(&adapter, block);
  if (!rendered) {
    std::fprintf(stderr, "adapter status=%u rejected=%u\n",
                 adapter.lastStatusCode.load(),
                 diagnostics.rejectedBlocks.load());
  }
  CHECK(rendered);
  CHECK(outputSamples[0] == 0.5F && outputSamples[1] == -0.25F &&
        outputSamples[2] == 0.125F && outputSamples[3] == 0.0F);
  CHECK(adapter.renderFailures.load() == 0);
  CHECK(adapter.lastStatusCode.load() ==
        static_cast<uint32_t>(zdsp::StatusCode::Ok));
  CHECK(diagnostics.rejectedBlocks.load() == 0);
  zdsp::ProcessContext mapped{};
  zdsp::CaptureTime capture{};
  zdsp::mapAudioHostProcessContext(block, &mapped, &capture);
  CHECK(capture.sequence == 19 && capture.sourceFrame.value == 1000 &&
        capture.sampleHostTime.value == 900000 &&
        mapped.time.graphFrame.value == 2000);
  zdsp::PublishedGraphSnapshot *retired[1]{};
  uint32_t retiredCount = 0;
  CHECK(zdsp::succeeded(
      zdsp::shutdownGraphRunner(&runner, retired, 1, &retiredCount)));
  CHECK(retiredCount == 1 && retired[0] == &snapshot);
  CHECK(zdsp::succeeded(zdsp::deactivateCompiledGraph(compiled.graph)));
}

void sourceOnlyPathInvokesGraph() {
  std::vector<uint8_t> storageBytes(1024 * 1024);
  zdsp::RealtimeArena arena{};
  CHECK(zdsp::succeeded(zdsp::initializeArena(
      &arena,
      {storageBytes.data(), static_cast<uint32_t>(storageBytes.size())})));
  zdsp::AudioBusDescriptor mono{1, zdsp::SampleFormat::Float32Planar,
                                zdsp::AudioChannelLayout::Mono, nullptr};
  zdsp::BuiltinNodeConfig oscillatorConfig{
      zdsp::BuiltinNodeKind::Oscillator, {11},    0, 1, 0, 12000.0F, 0.25F, 0,
      zdsp::OscillatorWaveform::Saw,     nullptr, 0};
  const size_t stateSize = zdsp::builtinStateBytes(oscillatorConfig);
  auto *state =
      static_cast<uint8_t *>(zdsp::arenaAllocate(&arena, stateSize, 64));
  CHECK(state != nullptr);
  const zdsp::ProcessorHandle oscillator = zdsp::createBuiltinProcessor(
      oscillatorConfig, {state, static_cast<uint32_t>(stateSize)});
  CHECK(oscillator.state != nullptr);
  zdsp::GraphNodeDescription nodes[] = {{{11},
                                         {1, 2},
                                         1,
                                         zdsp::GraphNodeRole::Processor,
                                         zdsp::GraphNodeFlagNone,
                                         0,
                                         1,
                                         nullptr,
                                         &mono,
                                         oscillator,
                                         {}},
                                        {{12},
                                         {0, 3},
                                         1,
                                         zdsp::GraphNodeRole::Output,
                                         zdsp::GraphNodeFlagNone,
                                         1,
                                         0,
                                         &mono,
                                         nullptr,
                                         {},
                                         {}}};
  zdsp::GraphConnection connections[] = {{{11}, 0, {12}, 0}};
  zdsp::GraphDescription description{
      zdsp::kGraphFormatVersion, {48000.0}, {64}, nodes, 2, connections, 1};
  zdsp::GraphCompileResult compiled{};
  zdsp::GraphCompileError compileError{};
  CHECK(zdsp::succeeded(
      zdsp::compileGraph(description, &arena, &compiled, &compileError)));

  zdsp::RuntimeDiagnostics diagnostics{};
  zdsp::RetirementSlot slot[1]{};
  zdsp::SnapshotPublisher publisher{};
  zdsp::initializePublisher(&publisher, slot, 1, &diagnostics);
  zdsp::TransitionPlan hardCut{zdsp::TransitionKind::HardCut,
                               {0},
                               {0},
                               {0},
                               zdsp::InfiniteTailPolicy::Cut,
                               {zdsp::TailKind::None, {0}},
                               {0},
                               0,
                               100,
                               1000,
                               0};
  zdsp::PublishedGraphSnapshot snapshot{compiled.graph, 1, hardCut, 0};
  CHECK(zdsp::succeeded(zdsp::submitSnapshot(&publisher, &snapshot).status));
  zdsp::GraphRunner runner{};
  zdsp::initializeGraphRunner(&runner, &publisher, {}, nullptr, nullptr,
                              &diagnostics);
  zdsp::AudioHostGraphAdapter adapter{&runner};
  TransportProviderState transportProvider{};
  transportProvider.transport.validFields =
      zdsp::TransportValidProjectSamples |
      zdsp::TransportValidContinuousSamples;
  transportProvider.transport.stateFlags = zdsp::TransportStatePlaying;
  transportProvider.transport.projectTimeSamples = -2;
  transportProvider.transport.continuousTimeSamples = 20;
  adapter.transport = {sliceTransport, &transportProvider};
  float outputSamples[4]{};
  float *output[] = {outputSamples};
  singz::AudioHostRenderBlock block{
      nullptr, output,  0,
      1,       4,       64,
      48000.0, 77,      5,
      3,       19,      0,
      0,       false,   false,
      2000,    1000000, true,
      false,   950000,  singz::AudioHostDiscontinuityNone,
      true};
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  const bool rendered = zdsp::renderAudioHostGraph(&adapter, block);
  zdsp::test::setAllocationTrapEnabled(false);
  CHECK(rendered);
  CHECK(zdsp::test::trappedAllocationCount() == 0);
  CHECK(transportProvider.calls == 1 &&
        transportProvider.lastOutputFrame == 2000);
  CHECK(outputSamples[0] == -0.25F && outputSamples[1] == -0.125F &&
        outputSamples[2] == 0.0F && outputSamples[3] == 0.125F);
  CHECK(adapter.renderFailures.load() == 0);
  CHECK(diagnostics.rejectedBlocks.load() == 0);
  zdsp::ProcessContext mapped{};
  zdsp::CaptureTime capture{};
  zdsp::mapAudioHostProcessContext(block, &mapped, &capture);
  CHECK(mapped.transport == nullptr);
  CHECK(capture.sourceFrame.value == 0);
  CHECK(capture.sampleHostTime.value == 0);
  CHECK(capture.quality == zdsp::CaptureTimestampQuality::Unknown);
  CHECK(capture.flags == zdsp::CaptureTimeCallbackHostValid);

  const float *unexpectedInput[] = {outputSamples};
  block.input = unexpectedInput;
  for (float &sample : outputSamples)
    sample = 1.0F;
  CHECK(!zdsp::renderAudioHostGraph(&adapter, block));
  for (float sample : outputSamples)
    CHECK(sample == 0.0F);
  block.inputChannels = 1;
  for (float &sample : outputSamples)
    sample = 1.0F;
  CHECK(!zdsp::renderAudioHostGraph(&adapter, block));
  for (float sample : outputSamples)
    CHECK(sample == 0.0F);
  block.input = nullptr;
  CHECK(!zdsp::renderAudioHostGraph(&adapter, block));
  CHECK(adapter.renderFailures.load() == 3);

  block.inputChannels = 0;
  transportProvider.succeeds = false;
  for (float &sample : outputSamples)
    sample = 1.0F;
  CHECK(!zdsp::renderAudioHostGraph(&adapter, block));
  for (float sample : outputSamples)
    CHECK(sample == 0.0F);
  CHECK(adapter.renderFailures.load() == 4);
  CHECK(adapter.lastStatusCode.load() ==
        static_cast<uint32_t>(zdsp::StatusCode::InvalidArgument));

  transportProvider.succeeds = true;
  transportProvider.transport.validFields = zdsp::TransportValidTempo;
  transportProvider.transport.tempo = -1.0;
  CHECK(!zdsp::renderAudioHostGraph(&adapter, block));
  CHECK(adapter.renderFailures.load() == 5);
  CHECK(adapter.lastStatusCode.load() ==
        static_cast<uint32_t>(zdsp::StatusCode::InvalidArgument));

  zdsp::PublishedGraphSnapshot *retired[1]{};
  uint32_t retiredCount = 0;
  CHECK(zdsp::succeeded(
      zdsp::shutdownGraphRunner(&runner, retired, 1, &retiredCount)));
  CHECK(retiredCount == 1 && retired[0] == &snapshot);
  CHECK(zdsp::succeeded(zdsp::deactivateCompiledGraph(compiled.graph)));
}

void transportSlicesAreSampleExactAndBounded() {
  std::vector<uint8_t> storageBytes(1024 * 1024);
  zdsp::RealtimeArena arena{};
  CHECK(zdsp::succeeded(zdsp::initializeArena(
      &arena,
      {storageBytes.data(), static_cast<uint32_t>(storageBytes.size())})));
  zdsp::AudioBusDescriptor mono{1, zdsp::SampleFormat::Float32Planar,
                                zdsp::AudioChannelLayout::Mono, nullptr};
  SliceProbeState probe{};
  zdsp::ProcessorHandle processor{&probe, &kSliceProbeFunctions};
  zdsp::GraphNodeDescription nodes[] = {{{21},
                                         {7, 21},
                                         1,
                                         zdsp::GraphNodeRole::Processor,
                                         zdsp::GraphNodeFlagNone,
                                         0,
                                         1,
                                         nullptr,
                                         &mono,
                                         processor,
                                         {}},
                                        {{22},
                                         {0, 22},
                                         1,
                                         zdsp::GraphNodeRole::Output,
                                         zdsp::GraphNodeFlagNone,
                                         1,
                                         0,
                                         &mono,
                                         nullptr,
                                         {},
                                         {}}};
  zdsp::GraphConnection connections[] = {{{21}, 0, {22}, 0}};
  zdsp::GraphDescription description{
      zdsp::kGraphFormatVersion, {48000.0}, {64}, nodes, 2, connections, 1};
  zdsp::GraphCompileResult compiled{};
  zdsp::GraphCompileError compileError{};
  CHECK(zdsp::succeeded(
      zdsp::compileGraph(description, &arena, &compiled, &compileError)));
  zdsp::RuntimeDiagnostics diagnostics{};
  zdsp::RetirementSlot slot[1]{};
  zdsp::SnapshotPublisher publisher{};
  zdsp::initializePublisher(&publisher, slot, 1, &diagnostics);
  zdsp::TransitionPlan hardCut{zdsp::TransitionKind::HardCut,
                               {0},
                               {0},
                               {0},
                               zdsp::InfiniteTailPolicy::Cut,
                               {zdsp::TailKind::None, {0}},
                               {0},
                               0,
                               100,
                               1000,
                               0};
  zdsp::PublishedGraphSnapshot snapshot{compiled.graph, 1, hardCut, 0};
  CHECK(zdsp::succeeded(zdsp::submitSnapshot(&publisher, &snapshot).status));
  zdsp::GraphRunner runner{};
  zdsp::initializeGraphRunner(&runner, &publisher, {}, nullptr, nullptr,
                              &diagnostics);
  BoundaryProviderState provider{};
  zdsp::AudioHostGraphAdapter adapter{&runner};
  adapter.transport = {boundaryTransport, &provider};
  float samples[7]{};
  float *output[]{samples};
  singz::AudioHostRenderBlock block{
      nullptr, output,  0,
      1,       7,       64,
      48000.0, 77,      5,
      3,       19,      0,
      0,       false,   false,
      2000,    1000000, true,
      true,    950000,  singz::AudioHostDiscontinuityStart,
      true};
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  CHECK(zdsp::renderAudioHostGraph(&adapter, block));
  zdsp::test::setAllocationTrapEnabled(false);
  CHECK(zdsp::test::trappedAllocationCount() == 0);
  CHECK(provider.calls == 3 && probe.calls == 3);
  for (uint32_t frame = 0; frame < 7; ++frame)
    CHECK(samples[frame] ==
          static_cast<float>(static_cast<int32_t>(frame) - 2));
  CHECK(probe.project[0] == -2 && probe.project[1] == 0 &&
        probe.project[2] == 3);
  CHECK(probe.graphFrames[0] == 2000 && probe.graphFrames[1] == 2002 &&
        probe.graphFrames[2] == 2005);
  CHECK(probe.renderHostTimes[0] == 1000000 &&
        probe.renderHostTimes[1] == 1041666 &&
        probe.renderHostTimes[2] == 1104166);
  CHECK(probe.callbackHostTimes[0] == 950000 &&
        probe.callbackHostTimes[1] == 950000 &&
        probe.callbackHostTimes[2] == 950000);
  CHECK(probe.discontinuities[0] ==
            zdsp::DiscontinuityReason::StreamGenerationChanged &&
        probe.discontinuities[1] == zdsp::DiscontinuityReason::SourceSeek &&
        probe.discontinuities[2] == zdsp::DiscontinuityReason::SourceLoop);

  // One callback-frame boundary is emitted. Hardware reset facts outrank
  // lower-priority transport source facts, and ResetState survives coalescing.
  block.frames = 2;
  provider = {};
  provider.firstDiscontinuity = {zdsp::DiscontinuityReason::SourceSeek,
                                 zdsp::DiscontinuityFlagResetState |
                                     zdsp::DiscontinuityFlagTimeValid};
  block.discontinuity = singz::AudioHostDiscontinuityRouteChanged;
  CHECK(zdsp::renderAudioHostGraph(&adapter, block));
  CHECK(probe.discontinuities[3] ==
            zdsp::DiscontinuityReason::RouteGenerationChanged &&
        (probe.discontinuityFlags[3] & zdsp::DiscontinuityFlagResetState) != 0);
  provider = {};
  provider.firstDiscontinuity = {zdsp::DiscontinuityReason::SourceLoop,
                                 zdsp::DiscontinuityFlagResetState |
                                     zdsp::DiscontinuityFlagTimeValid};
  block.discontinuity = singz::AudioHostDiscontinuityClockReanchored;
  CHECK(zdsp::renderAudioHostGraph(&adapter, block));
  CHECK(probe.discontinuities[4] ==
            zdsp::DiscontinuityReason::ClockReanchored &&
        (probe.discontinuityFlags[4] & zdsp::DiscontinuityFlagResetState) != 0);
  provider = {};
  provider.firstDiscontinuity = {zdsp::DiscontinuityReason::SourceSeek,
                                 zdsp::DiscontinuityFlagResetState |
                                     zdsp::DiscontinuityFlagTimeValid};
  block.discontinuity = singz::AudioHostDiscontinuityNone;
  CHECK(zdsp::renderAudioHostGraph(&adapter, block));
  CHECK(probe.discontinuities[5] == zdsp::DiscontinuityReason::SourceSeek &&
        (probe.discontinuityFlags[5] & zdsp::DiscontinuityFlagResetState) != 0);

  provider = {};
  provider.zeroSlice = true;
  block.frames = 7;
  block.discontinuity = singz::AudioHostDiscontinuityStart;
  std::fill(std::begin(samples), std::end(samples), 1.0F);
  CHECK(!zdsp::renderAudioHostGraph(&adapter, block));
  for (float sample : samples)
    CHECK(sample == 0.0F);
  provider.zeroSlice = false;
  provider.oversizeSlice = true;
  std::fill(std::begin(samples), std::end(samples), 1.0F);
  CHECK(!zdsp::renderAudioHostGraph(&adapter, block));
  for (float sample : samples)
    CHECK(sample == 0.0F);
  CHECK(adapter.renderFailures.load() == 2);

  zdsp::PublishedGraphSnapshot *retired[1]{};
  uint32_t retiredCount = 0;
  CHECK(zdsp::succeeded(
      zdsp::shutdownGraphRunner(&runner, retired, 1, &retiredCount)));
  CHECK(retiredCount == 1 && retired[0] == &snapshot);
  CHECK(zdsp::succeeded(zdsp::deactivateCompiledGraph(compiled.graph)));
}
} // namespace

int main() {
  successPathInvokesGraph();
  sourceOnlyPathInvokesGraph();
  transportSlicesAreSampleExactAndBounded();
  float inputSamples[17]{};
  float outputSamples[17];
  const float *input[] = {inputSamples};
  float *output[] = {outputSamples};
  singz::AudioHostRenderBlock block{
      input,   output, 1,
      1,       17,     64,
      96000.0, 41,     7,
      9,       12,     4096,
      123456,  true,   true,
      8192,    234567, true,
      true,    200000, singz::AudioHostDiscontinuityRouteChanged,
      true};
  zdsp::ProcessContext process{};
  zdsp::CaptureTime capture{};
  zdsp::mapAudioHostProcessContext(block, &process, &capture);
  CHECK(process.sampleRate.value == 96000.0);
  CHECK(process.frames.value == 17);
  CHECK(process.time.clockDomain.value == 41);
  CHECK(process.time.streamGeneration.value == 9);
  CHECK(process.time.graphFrame.value == 8192);
  CHECK(process.time.renderHostTime.value == 234567);
  CHECK((process.time.flags & zdsp::RenderTimeHostValid) != 0);
  CHECK((process.time.flags & zdsp::RenderTimeHostHardware) != 0);
  CHECK(process.discontinuity.reason ==
        zdsp::DiscontinuityReason::RouteGenerationChanged);
  CHECK(capture.sequence == 12);
  CHECK(capture.sourceFrame.value == 4096);
  CHECK(capture.sampleHostTime.value == 123456);
  CHECK(capture.quality == zdsp::CaptureTimestampQuality::Hardware);
  // Startup without an anchor is explicitly invalid, a fresh hardware anchor
  // is valid+hardware, and the stale-anchor callback-entry fallback remains
  // valid but is never mislabeled as hardware.
  block.outputHostTimeNs = 0;
  block.outputTimestampValid = false;
  block.outputTimestampHardware = false;
  zdsp::mapAudioHostProcessContext(block, &process, &capture);
  CHECK((process.time.flags & zdsp::RenderTimeHostValid) == 0);
  CHECK((process.time.flags & zdsp::RenderTimeHostHardware) == 0);
  block.outputHostTimeNs = 345678;
  block.outputTimestampValid = true;
  block.outputTimestampHardware = true;
  zdsp::mapAudioHostProcessContext(block, &process, &capture);
  CHECK((process.time.flags & zdsp::RenderTimeHostValid) != 0);
  CHECK((process.time.flags & zdsp::RenderTimeHostHardware) != 0);
  block.outputHostTimeNs = block.callbackHostTimeNs;
  block.outputTimestampHardware = false;
  block.discontinuity = singz::AudioHostDiscontinuityTimestampQualityChanged;
  zdsp::mapAudioHostProcessContext(block, &process, &capture);
  CHECK((process.time.flags & zdsp::RenderTimeHostValid) != 0);
  CHECK((process.time.flags & zdsp::RenderTimeHostHardware) == 0);
  CHECK(process.discontinuity.reason ==
        zdsp::DiscontinuityReason::TimestampQualityChanged);
  expectReason(block, singz::AudioHostDiscontinuityStart,
               zdsp::DiscontinuityReason::StreamGenerationChanged);
  expectReason(block, singz::AudioHostDiscontinuityXRun,
               zdsp::DiscontinuityReason::SequenceGap);
  expectReason(block, singz::AudioHostDiscontinuityRouteChanged,
               zdsp::DiscontinuityReason::RouteGenerationChanged);
  expectReason(block, singz::AudioHostDiscontinuityDeviceLost,
               zdsp::DiscontinuityReason::DeviceLost);
  expectReason(block, singz::AudioHostDiscontinuityTimestampQualityChanged,
               zdsp::DiscontinuityReason::TimestampQualityChanged);
  expectReason(block, singz::AudioHostDiscontinuityClockReanchored,
               zdsp::DiscontinuityReason::ClockReanchored);
  expectReason(block, singz::AudioHostDiscontinuitySequenceGap,
               zdsp::DiscontinuityReason::SequenceGap);
  expectReason(block,
               singz::AudioHostDiscontinuityTimestampQualityChanged |
                   singz::AudioHostDiscontinuityClockReanchored,
               zdsp::DiscontinuityReason::ClockReanchored);
  expectReason(block,
               singz::AudioHostDiscontinuityStart |
                   singz::AudioHostDiscontinuityClockReanchored,
               zdsp::DiscontinuityReason::StreamGenerationChanged);
  expectReason(block,
               singz::AudioHostDiscontinuityRouteChanged |
                   singz::AudioHostDiscontinuityStart,
               zdsp::DiscontinuityReason::RouteGenerationChanged);
  for (float &sample : outputSamples)
    sample = 1.0F;
  zdsp::AudioHostGraphAdapter adapter;
  CHECK(!zdsp::renderAudioHostGraph(&adapter, block));
  CHECK(adapter.renderFailures.load() == 1);
  for (float sample : outputSamples)
    CHECK(sample == 0.0F);
  return 0;
}
