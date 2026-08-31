#include "zdsp/offline_renderer.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <vector>

namespace {
using namespace zdsp;
using Clock = std::chrono::steady_clock;

[[noreturn]] void fail(const char* message) {
  std::fprintf(stderr, "%s\n", message);
  std::abort();
}

struct Distribution {
  double p50;
  double p95;
  double p99;
  double maximum;
};

Distribution distribution(std::vector<double> samples) {
  std::sort(samples.begin(), samples.end());
  auto percentile = [&](double fraction) {
    return samples[static_cast<size_t>(fraction * (samples.size() - 1))];
  };
  return {percentile(0.50), percentile(0.95), percentile(0.99),
          samples.back()};
}

void report(const char* label, const std::vector<double>& samples,
            double deadlineUs, uint32_t misses, double checksum) {
  const Distribution value = distribution(samples);
  std::printf("%s samples=%zu p50=%.3fus p95=%.3fus p99=%.3fus max=%.3fus "
              "deadline=%.3fus maxPercent=%.3f%% margin=%.3fus misses=%u "
              "checksum=%.6f\n",
      label, samples.size(), value.p50, value.p95, value.p99, value.maximum,
      deadlineUs, value.maximum / deadlineUs * 100.0,
      deadlineUs - value.maximum, misses, checksum);
}

}  // namespace

int main() {
  std::vector<uint8_t> arenaBytes(2 * 1024 * 1024);
  RealtimeArena arena{};
  if (!succeeded(initializeArena(&arena, {arenaBytes.data(),
      static_cast<uint32_t>(arenaBytes.size())}))) fail("arena");
  AudioBusDescriptor stereo{2, SampleFormat::Float32Planar,
                            AudioChannelLayout::Stereo, nullptr};
  BuiltinNodeConfig oscillator{BuiltinNodeKind::Oscillator, {1}, 0, 2, 0,
      220.0f, 0.1f, 0, OscillatorWaveform::Sine, nullptr, 0};
  BuiltinNodeConfig gain{BuiltinNodeKind::Gain, {2}, 2, 2, 1,
      0.8f, 0.0f, 0, OscillatorWaveform::Sine, nullptr, 0};
  auto make = [&](const BuiltinNodeConfig& config) {
    const size_t bytes = builtinStateBytes(config);
    uint8_t* state = static_cast<uint8_t*>(arenaAllocate(&arena, bytes, 64));
    return createBuiltinProcessor(config, {state, static_cast<uint32_t>(bytes)});
  };
  ProcessorHandle oscillatorHandle = make(oscillator);
  ProcessorHandle gainHandle = make(gain);
  GraphNodeDescription nodes[]{
      {{1}, {1, 1}, 1, GraphNodeRole::Processor, 0, 0, 1, nullptr, &stereo,
       oscillatorHandle, {nullptr, 0, 1}},
      {{2}, {1, 2}, 1, GraphNodeRole::Processor, GraphNodeFlagMayProcessInPlace,
       1, 1, &stereo, &stereo, gainHandle, {nullptr, 0, 1}},
      {{3}, {0, 3}, 1, GraphNodeRole::Output, 0, 1, 0, &stereo, nullptr, {}, {}}};
  GraphConnection connections[]{{{1}, 0, {2}, 0}, {{2}, 0, {3}, 0}};
  GraphDescription description{kGraphFormatVersion, {48000.0}, {128},
      nodes, 3, connections, 2};
  GraphCompileResult compiled{}; GraphCompileError error{};
  if (!succeeded(compileGraph(description, &arena, &compiled, &error))) fail("compile");

  RuntimeDiagnostics diagnostics{}; RetirementSlot slots[2]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slots, 2, &diagnostics);
  TransitionPlan transition{TransitionKind::HardCut, {0}, {0}, {0},
      InfiniteTailPolicy::Cut, {TailKind::None, {0}}, {0}, 0, 100, 1000, 0};
  PublishedGraphSnapshot snapshot{compiled.graph, 1, transition, 0};
  if (!succeeded(submitSnapshot(&publisher, &snapshot).status)) fail("publish");
  GraphRunner runner{}; GraphRunnerStorage storage{};
  initializeGraphRunner(&runner, &publisher, storage, nullptr, nullptr, &diagnostics);
  float samples[2][128]{}; float* channels[]{samples[0], samples[1]};
  MutableAudioBusView output{channels, 2, {128}, {128}};
  ProcessContext context{kProcessContextInterfaceVersion, kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {128},
      nullptr, 0, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0}};
  if (!succeeded(renderGraphBlock(&runner, context, nullptr, 0, &output, 1)))
    fail("warmup");

  constexpr uint32_t individualBlocks = 20000;
  std::vector<double> individual; individual.reserve(individualBlocks);
  uint32_t individualMisses = 0;
  double checksum = 0.0;
  const double deadlineUs = 128.0 / 48000.0 * 1000000.0;
  for (uint32_t block = 0; block < individualBlocks; ++block) {
    context.time.graphFrame.value += 128;
    const auto before = Clock::now();
    const Status status = renderGraphBlock(&runner, context, nullptr, 0,
                                           &output, 1);
    const auto after = Clock::now();
    if (!succeeded(status)) fail("individual render");
    const double elapsed =
        std::chrono::duration<double, std::micro>(after - before).count();
    individual.push_back(elapsed);
    if (elapsed >= deadlineUs) ++individualMisses;
    checksum += samples[0][block & 127];
  }
  report("zdsp-runner individual-block-latency", individual, deadlineUs,
         individualMisses, checksum);

  constexpr uint32_t batches = 2000;
  constexpr uint32_t blocksPerBatch = 32;
  std::vector<double> batchedAverages; batchedAverages.reserve(batches);
  uint32_t slowBatchAverages = 0;
  for (uint32_t batch = 0; batch < batches; ++batch) {
    const auto before = Clock::now();
    for (uint32_t block = 0; block < blocksPerBatch; ++block) {
      context.time.graphFrame.value += 128;
      if (!succeeded(renderGraphBlock(&runner, context, nullptr, 0, &output, 1)))
        fail("render");
      checksum += samples[0][block & 127];
    }
    const auto after = Clock::now();
    const double perBlock = std::chrono::duration<double, std::micro>(after - before).count() /
                            blocksPerBatch;
    batchedAverages.push_back(perBlock);
    if (perBlock >= deadlineUs) ++slowBatchAverages;
  }
  // These are throughput averages over 32 calls. They are intentionally not
  // presented as an individual-call maximum or deadline proof.
  report("zdsp-runner batched-throughput-average-32", batchedAverages,
         deadlineUs, slowBatchAverages, checksum);

  GraphNodeDescription emptyNodes[]{
      {{10}, {0, 10}, 1, GraphNodeRole::Input, 0, 0, 1, nullptr, &stereo, {}, {}},
      {{11}, {0, 11}, 1, GraphNodeRole::Output, 0, 1, 0, &stereo, nullptr, {}, {}}};
  GraphConnection emptyConnection{{10}, 0, {11}, 0};
  GraphDescription emptyDescription{kGraphFormatVersion, {48000.0}, {128},
      emptyNodes, 2, &emptyConnection, 1};
  GraphCompileResult emptyCompiled{};
  if (!succeeded(compileGraph(emptyDescription, &arena, &emptyCompiled, &error)))
    fail("empty graph compile");
  RetirementSlot emptySlots[1]{}; SnapshotPublisher emptyPublisher{};
  initializePublisher(&emptyPublisher, emptySlots, 1, &diagnostics);
  PublishedGraphSnapshot emptySnapshot{emptyCompiled.graph, 1, transition, 0};
  if (!succeeded(submitSnapshot(&emptyPublisher, &emptySnapshot).status))
    fail("empty graph publish");
  GraphRunner emptyRunner{};
  initializeGraphRunner(&emptyRunner, &emptyPublisher, {}, nullptr, nullptr,
                        &diagnostics);
  float emptyInputSamples[2][128]{}; float emptyOutputSamples[2][128]{};
  const float* emptyInputChannels[]{emptyInputSamples[0], emptyInputSamples[1]};
  float* emptyOutputChannels[]{emptyOutputSamples[0], emptyOutputSamples[1]};
  emptyInputSamples[0][0] = 0.125f;
  ConstAudioBusView emptyInput{emptyInputChannels, 2, {128}, {128}, nullptr};
  MutableAudioBusView emptyOutput{emptyOutputChannels, 2, {128}, {128}};
  std::vector<double> emptyIndividual; emptyIndividual.reserve(individualBlocks);
  uint32_t emptyMisses = 0; double emptyChecksum = 0.0;
  for (uint32_t block = 0; block < individualBlocks; ++block) {
    const auto before = Clock::now();
    const Status status = renderGraphBlock(&emptyRunner, context, &emptyInput, 1,
                                           &emptyOutput, 1);
    const auto after = Clock::now();
    if (!succeeded(status)) fail("empty render");
    const double elapsed =
        std::chrono::duration<double, std::micro>(after - before).count();
    emptyIndividual.push_back(elapsed);
    if (elapsed >= deadlineUs) ++emptyMisses;
    emptyChecksum += emptyOutputSamples[0][block & 127];
  }
  report("zdsp-runner empty-graph-individual", emptyIndividual, deadlineUs,
         emptyMisses, emptyChecksum);

  std::vector<double> timerHarness; timerHarness.reserve(individualBlocks);
  uint32_t harnessMisses = 0;
  double harnessChecksum = 0.0;
  for (uint32_t block = 0; block < individualBlocks; ++block) {
    const auto before = Clock::now();
    const Status status = validateProcessContext(context);
    const auto after = Clock::now();
    harnessChecksum += static_cast<uint32_t>(status.code) +
                       context.time.graphFrame.value * 1.0e-12;
    const double elapsed =
        std::chrono::duration<double, std::micro>(after - before).count();
    timerHarness.push_back(elapsed);
    if (elapsed >= deadlineUs) ++harnessMisses;
  }
  // Informational harness overhead is measured honestly but does not decide
  // render acceptance; only the individual render/empty misses below do.
  report("zdsp-runner timer-validation-harness-informational", timerHarness,
         deadlineUs, harnessMisses, harnessChecksum);
  if (!succeeded(deactivateCompiledGraph(compiled.graph))) fail("deactivate");
  if (!succeeded(deactivateCompiledGraph(emptyCompiled.graph)))
    fail("empty deactivate");
  return individualMisses == 0 && emptyMisses == 0 ? 0 : 1;
}
