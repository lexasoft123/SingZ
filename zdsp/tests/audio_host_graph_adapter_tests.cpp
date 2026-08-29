#include <zdsp/audio_host_graph_adapter.h>
#include <zdsp/builtin_nodes.h>
#include <zdsp/graph.h>
#include <zdsp/graph_runner.h>
#include <zdsp/realtime_arena.h>

#include "allocation_trap.h"

#include <cstdlib>
#include <cstdio>
#include <vector>

#define CHECK(expression)                                                      \
  do {                                                                         \
    if (!(expression)) {                                                       \
      std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__, \
                   #expression);                                               \
      std::abort();                                                            \
    }                                                                          \
  } while (false)

namespace {
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
      &arena, {storageBytes.data(),
               static_cast<uint32_t>(storageBytes.size())})));
  zdsp::AudioBusDescriptor mono{1, zdsp::SampleFormat::Float32Planar,
                                zdsp::AudioChannelLayout::Mono, nullptr};
  zdsp::BuiltinNodeConfig gainConfig{
      zdsp::BuiltinNodeKind::Gain, {2}, 1, 1, 1, 0.5F, 1.0F, 0,
      zdsp::OscillatorWaveform::Saw, nullptr, 0};
  const size_t stateSize = zdsp::builtinStateBytes(gainConfig);
  auto* state = static_cast<uint8_t*>(zdsp::arenaAllocate(&arena, stateSize, 64));
  CHECK(state != nullptr);
  const zdsp::ProcessorHandle gain = zdsp::createBuiltinProcessor(
      gainConfig, {state, static_cast<uint32_t>(stateSize)});
  CHECK(gain.state != nullptr);
  const size_t preparedSize = zdsp::builtinPreparedBytes(gainConfig, {64});
  void* prepared = preparedSize == 0
                       ? nullptr
                       : zdsp::arenaAllocate(&arena, preparedSize, alignof(float));
  CHECK(preparedSize == 0 || prepared != nullptr);
  zdsp::GraphNodeDescription nodes[] = {
      {{1}, {0, 1}, 1, zdsp::GraphNodeRole::Input, zdsp::GraphNodeFlagNone,
       0, 1, nullptr, &mono, {}, {}},
      {{2}, {1, 1}, 1, zdsp::GraphNodeRole::Processor,
       zdsp::GraphNodeFlagMayProcessInPlace, 1, 1, &mono, &mono, gain,
       {prepared, preparedSize, alignof(float)}},
      {{3}, {0, 3}, 1, zdsp::GraphNodeRole::Output, zdsp::GraphNodeFlagNone,
       1, 0, &mono, nullptr, {}, {}}};
  zdsp::GraphConnection connections[] = {{{1}, 0, {2}, 0},
                                          {{2}, 0, {3}, 0}};
  zdsp::GraphDescription description{zdsp::kGraphFormatVersion, {48000.0}, {64},
                                     nodes, 3, connections, 2};
  zdsp::GraphCompileResult compiled{};
  zdsp::GraphCompileError compileError{};
  CHECK(zdsp::succeeded(
      zdsp::compileGraph(description, &arena, &compiled, &compileError)));

  zdsp::RuntimeDiagnostics diagnostics{};
  zdsp::RetirementSlot slot[1]{};
  zdsp::SnapshotPublisher publisher{};
  zdsp::initializePublisher(&publisher, slot, 1, &diagnostics);
  zdsp::TransitionPlan hardCut{
      zdsp::TransitionKind::HardCut, {0}, {0}, {0},
      zdsp::InfiniteTailPolicy::Cut, {zdsp::TailKind::None, {0}}, {0},
      0, 100, 1000, 0};
  zdsp::PublishedGraphSnapshot snapshot{compiled.graph, 1, hardCut, 0};
  CHECK(zdsp::succeeded(zdsp::submitSnapshot(&publisher, &snapshot).status));
  zdsp::GraphRunner runner{};
  zdsp::initializeGraphRunner(&runner, &publisher, {}, nullptr, nullptr,
                              &diagnostics);
  zdsp::AudioHostGraphAdapter adapter{&runner};
  float inputSamples[]{1.0F, -0.5F, 0.25F, 0.0F};
  float outputSamples[4]{};
  const float* input[] = {inputSamples};
  float* output[] = {outputSamples};
  singz::AudioHostRenderBlock block{
      input, output, 1, 1, 4, 64, 48000.0, 77, 5, 3, 19, 1000,
      900000, true, true, 2000, 1000000, 950000,
      singz::AudioHostDiscontinuityNone, true};
  const bool rendered = zdsp::renderAudioHostGraph(&adapter, block);
  if (!rendered) {
    std::fprintf(stderr, "adapter status=%u rejected=%u\n",
                 adapter.lastStatusCode.load(), diagnostics.rejectedBlocks.load());
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
  zdsp::PublishedGraphSnapshot* retired[1]{};
  uint32_t retiredCount = 0;
  CHECK(zdsp::succeeded(zdsp::shutdownGraphRunner(
      &runner, retired, 1, &retiredCount)));
  CHECK(retiredCount == 1 && retired[0] == &snapshot);
  CHECK(zdsp::succeeded(zdsp::deactivateCompiledGraph(compiled.graph)));
}

void sourceOnlyPathInvokesGraph() {
  std::vector<uint8_t> storageBytes(1024 * 1024);
  zdsp::RealtimeArena arena{};
  CHECK(zdsp::succeeded(zdsp::initializeArena(
      &arena, {storageBytes.data(),
               static_cast<uint32_t>(storageBytes.size())})));
  zdsp::AudioBusDescriptor mono{1, zdsp::SampleFormat::Float32Planar,
                                zdsp::AudioChannelLayout::Mono, nullptr};
  zdsp::BuiltinNodeConfig oscillatorConfig{
      zdsp::BuiltinNodeKind::Oscillator, {11}, 0, 1, 0, 12000.0F, 0.25F, 0,
      zdsp::OscillatorWaveform::Saw, nullptr, 0};
  const size_t stateSize = zdsp::builtinStateBytes(oscillatorConfig);
  auto* state = static_cast<uint8_t*>(
      zdsp::arenaAllocate(&arena, stateSize, 64));
  CHECK(state != nullptr);
  const zdsp::ProcessorHandle oscillator = zdsp::createBuiltinProcessor(
      oscillatorConfig, {state, static_cast<uint32_t>(stateSize)});
  CHECK(oscillator.state != nullptr);
  zdsp::GraphNodeDescription nodes[] = {
      {{11}, {1, 2}, 1, zdsp::GraphNodeRole::Processor,
       zdsp::GraphNodeFlagNone, 0, 1, nullptr, &mono, oscillator, {}},
      {{12}, {0, 3}, 1, zdsp::GraphNodeRole::Output,
       zdsp::GraphNodeFlagNone, 1, 0, &mono, nullptr, {}, {}}};
  zdsp::GraphConnection connections[] = {{{11}, 0, {12}, 0}};
  zdsp::GraphDescription description{zdsp::kGraphFormatVersion, {48000.0},
                                     {64}, nodes, 2, connections, 1};
  zdsp::GraphCompileResult compiled{};
  zdsp::GraphCompileError compileError{};
  CHECK(zdsp::succeeded(
      zdsp::compileGraph(description, &arena, &compiled, &compileError)));

  zdsp::RuntimeDiagnostics diagnostics{};
  zdsp::RetirementSlot slot[1]{};
  zdsp::SnapshotPublisher publisher{};
  zdsp::initializePublisher(&publisher, slot, 1, &diagnostics);
  zdsp::TransitionPlan hardCut{
      zdsp::TransitionKind::HardCut, {0}, {0}, {0},
      zdsp::InfiniteTailPolicy::Cut, {zdsp::TailKind::None, {0}}, {0},
      0, 100, 1000, 0};
  zdsp::PublishedGraphSnapshot snapshot{compiled.graph, 1, hardCut, 0};
  CHECK(zdsp::succeeded(zdsp::submitSnapshot(&publisher, &snapshot).status));
  zdsp::GraphRunner runner{};
  zdsp::initializeGraphRunner(&runner, &publisher, {}, nullptr, nullptr,
                              &diagnostics);
  zdsp::AudioHostGraphAdapter adapter{&runner};
  float outputSamples[4]{};
  float* output[] = {outputSamples};
  singz::AudioHostRenderBlock block{
      nullptr, output, 0, 1, 4, 64, 48000.0, 77, 5, 3, 19, 0,
      0, false, false, 2000, 1000000, 950000,
      singz::AudioHostDiscontinuityNone, true};
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  const bool rendered = zdsp::renderAudioHostGraph(&adapter, block);
  zdsp::test::setAllocationTrapEnabled(false);
  CHECK(rendered);
  CHECK(zdsp::test::trappedAllocationCount() == 0);
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

  const float* unexpectedInput[] = {outputSamples};
  block.input = unexpectedInput;
  for (float& sample : outputSamples) sample = 1.0F;
  CHECK(!zdsp::renderAudioHostGraph(&adapter, block));
  for (float sample : outputSamples) CHECK(sample == 0.0F);
  block.inputChannels = 1;
  for (float& sample : outputSamples) sample = 1.0F;
  CHECK(!zdsp::renderAudioHostGraph(&adapter, block));
  for (float sample : outputSamples) CHECK(sample == 0.0F);
  block.input = nullptr;
  CHECK(!zdsp::renderAudioHostGraph(&adapter, block));
  CHECK(adapter.renderFailures.load() == 3);

  zdsp::PublishedGraphSnapshot* retired[1]{};
  uint32_t retiredCount = 0;
  CHECK(zdsp::succeeded(zdsp::shutdownGraphRunner(
      &runner, retired, 1, &retiredCount)));
  CHECK(retiredCount == 1 && retired[0] == &snapshot);
  CHECK(zdsp::succeeded(zdsp::deactivateCompiledGraph(compiled.graph)));
}
}  // namespace

int main() {
  successPathInvokesGraph();
  sourceOnlyPathInvokesGraph();
  float inputSamples[17]{};
  float outputSamples[17];
  const float* input[] = {inputSamples};
  float* output[] = {outputSamples};
  singz::AudioHostRenderBlock block{input, output, 1, 1, 17, 64, 96000.0,
                                    41, 7, 9, 12, 4096, 123456, true, true,
                                    8192, 234567, 200000,
                                    singz::AudioHostDiscontinuityRouteChanged, true};
  zdsp::ProcessContext process{};
  zdsp::CaptureTime capture{};
  zdsp::mapAudioHostProcessContext(block, &process, &capture);
  CHECK(process.sampleRate.value == 96000.0);
  CHECK(process.frames.value == 17);
  CHECK(process.time.clockDomain.value == 41);
  CHECK(process.time.streamGeneration.value == 9);
  CHECK(process.time.graphFrame.value == 8192);
  CHECK(process.time.renderHostTime.value == 234567);
  CHECK(process.discontinuity.reason == zdsp::DiscontinuityReason::RouteGenerationChanged);
  CHECK(capture.sequence == 12);
  CHECK(capture.sourceFrame.value == 4096);
  CHECK(capture.sampleHostTime.value == 123456);
  CHECK(capture.quality == zdsp::CaptureTimestampQuality::Hardware);
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
  for (float& sample : outputSamples) sample = 1.0F;
  zdsp::AudioHostGraphAdapter adapter;
  CHECK(!zdsp::renderAudioHostGraph(&adapter, block));
  CHECK(adapter.renderFailures.load() == 1);
  for (float sample : outputSamples) CHECK(sample == 0.0F);
  return 0;
}
