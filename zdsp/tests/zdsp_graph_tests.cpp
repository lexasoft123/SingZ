#include "zdsp/offline_renderer.h"
#include "allocation_trap.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <new>
#include <thread>
#include <vector>

namespace {
using namespace zdsp;

[[noreturn]] void fail(const char* message) {
  std::fprintf(stderr, "FAIL: %s\n", message);
  std::abort();
}
void expect(bool value, const char* message) { if (!value) fail(message); }
void near(float actual, float expected, float tolerance, const char* message) {
  if (std::fabs(actual - expected) > tolerance) fail(message);
}

Status markStateTransfer(const CompiledGraph*, CompiledGraph*, void* context) noexcept {
  ++*static_cast<uint32_t*>(context);
  return okStatus();
}

TransitionPlan hardCut() {
  return {TransitionKind::HardCut, {0}, {0}, {0}, InfiniteTailPolicy::Cut,
          {TailKind::None, {0}}, {0}, 0, 100, 1000, 0};
}
TransitionPlan crossfade(uint32_t frames, uint32_t oldDelay = 0,
                         uint32_t newDelay = 0) {
  return {TransitionKind::Crossfade, {frames}, {oldDelay}, {newDelay},
          InfiniteTailPolicy::Fade, {TailKind::None, {0}}, {0},
          200, 200, 800, 1};
}

struct Builder {
  std::vector<uint8_t> bytes;
  RealtimeArena arena{};
  AudioBusDescriptor mono{1, SampleFormat::Float32Planar,
                          AudioChannelLayout::Mono, nullptr};
  AudioBusDescriptor stereo{2, SampleFormat::Float32Planar,
                            AudioChannelLayout::Stereo, nullptr};
  GraphNodeDescription nodes[kMaximumGraphNodes]{};
  GraphConnection connections[kMaximumGraphConnections]{};
  uint32_t nodeCount = 0;
  uint32_t connectionCount = 0;
  CompiledGraph* graph = nullptr;
  GraphCompileResult lastResult{};
  SampleRateHz sampleRate{48000.0};
  FrameCount maximumFrames{256};

  Builder() : bytes(4 * 1024 * 1024) {
    expect(succeeded(initializeArena(&arena, {bytes.data(),
        static_cast<uint32_t>(bytes.size())})), "initialize graph arena");
  }
  ~Builder() {
    if (graph != nullptr) (void)deactivateCompiledGraph(graph);
  }

  void input(uint64_t id) {
    nodes[nodeCount++] = {{id}, {0, id}, 1, GraphNodeRole::Input,
        GraphNodeFlagNone, 0, 1, nullptr, &mono, {}, {}};
  }
  void output(uint64_t id) {
    nodes[nodeCount++] = {{id}, {0, id}, 1, GraphNodeRole::Output,
        GraphNodeFlagNone, 1, 0, &mono, nullptr, {}, {}};
  }
  void inputBus(uint64_t id, const AudioBusDescriptor* bus) {
    nodes[nodeCount++] = {{id}, {0, id}, 1, GraphNodeRole::Input,
        GraphNodeFlagNone, 0, 1, nullptr, bus, {}, {}};
  }
  void outputBus(uint64_t id, const AudioBusDescriptor* bus) {
    nodes[nodeCount++] = {{id}, {0, id}, 1, GraphNodeRole::Output,
        GraphNodeFlagNone, 1, 0, bus, nullptr, {}, {}};
  }
  ProcessorHandle builtin(uint64_t id, BuiltinNodeKind kind,
                          uint32_t inputBuses, float value0 = 1.0f,
                          float value1 = 1.0f, uint32_t frames = 0,
                          OscillatorWaveform waveform = OscillatorWaveform::Saw,
                          uint32_t flags = GraphNodeFlagNone) {
    BuiltinNodeConfig config{kind, {id}, inputBuses == 0 ? 0u : 1u, 1,
        inputBuses, value0, value1,
        frames, waveform, nullptr, 0};
    const size_t stateBytes = builtinStateBytes(config);
    uint8_t* state = static_cast<uint8_t*>(arenaAllocate(&arena, stateBytes, 64));
    expect(state != nullptr, "builtin state storage");
    ProcessorHandle processor = createBuiltinProcessor(
        config, {state, static_cast<uint32_t>(stateBytes)});
    expect(processor.state != nullptr, "create builtin processor");
    const size_t durableBytes = builtinPreparedBytes(config, {256});
    void* durable = durableBytes == 0 ? nullptr
        : arenaAllocate(&arena, durableBytes, alignof(float));
    expect(durableBytes == 0 || durable != nullptr, "builtin durable storage");
    AudioBusDescriptor* inputs = nullptr;
    if (inputBuses != 0) {
      inputs = arenaArray<AudioBusDescriptor>(&arena, inputBuses);
      expect(inputs != nullptr, "input descriptors");
      for (uint32_t bus = 0; bus < inputBuses; ++bus) inputs[bus] = mono;
    }
    nodes[nodeCount++] = {{id}, {1, static_cast<uint64_t>(kind)}, 1,
        GraphNodeRole::Processor, flags, inputBuses, 1, inputs, &mono,
        processor, {durable, durableBytes, alignof(float)}};
    return processor;
  }
  ProcessorHandle builtinBus(uint64_t id, BuiltinNodeKind kind,
                             const AudioBusDescriptor* bus,
                             uint32_t frames = 0) {
    BuiltinNodeConfig config{kind, {id}, bus->channelCount,
        bus->channelCount, 1, 0.0f, 0.0f, frames,
        OscillatorWaveform::Saw, nullptr, 0};
    const size_t stateBytes = builtinStateBytes(config);
    uint8_t* state = static_cast<uint8_t*>(arenaAllocate(&arena, stateBytes, 64));
    expect(state != nullptr, "multi-bus builtin state storage");
    ProcessorHandle processor = createBuiltinProcessor(
        config, {state, static_cast<uint32_t>(stateBytes)});
    expect(processor.state != nullptr, "create multi-bus builtin processor");
    const size_t durableBytes = builtinPreparedBytes(config, maximumFrames);
    void* durable = durableBytes == 0 ? nullptr
        : arenaAllocate(&arena, durableBytes, alignof(float));
    expect(durableBytes == 0 || durable != nullptr,
           "multi-bus builtin durable storage");
    nodes[nodeCount++] = {{id}, {1, static_cast<uint64_t>(kind)}, 1,
        GraphNodeRole::Processor, GraphNodeFlagNone, 1, 1, bus, bus,
        processor, {durable, durableBytes, alignof(float)}};
    return processor;
  }
  void connect(uint64_t source, uint32_t sourceBus,
               uint64_t destination, uint32_t destinationBus) {
    connections[connectionCount++] = {{source}, sourceBus,
                                      {destination}, destinationBus};
  }
  Status compile(GraphCompileError* error = nullptr) {
    GraphDescription description{kGraphFormatVersion, sampleRate, maximumFrames,
        nodes, nodeCount, connections, connectionCount};
    const Status status = compileGraph(description, &arena, &lastResult, error);
    if (succeeded(status)) graph = lastResult.graph;
    return status;
  }
};

void topologyAndPlanner() {
  uint8_t arenaBytes[128]{};
  RealtimeArena smallArena{};
  expect(succeeded(initializeArena(&smallArena, {arenaBytes, sizeof(arenaBytes)})),
         "initialize realtime arena");
  const ArenaCheckpoint initial = checkpoint(smallArena);
  void* aligned = arenaAllocate(&smallArena, 16, 16);
  expect(aligned != nullptr && (reinterpret_cast<uintptr_t>(aligned) & 15) == 0,
         "arena honors alignment");
  expect(arenaAllocate(&smallArena, 256, 8) == nullptr,
         "arena exhaustion is bounded");
  rewindArena(&smallArena, initial);
  expect(smallArena.used == initial.used, "arena checkpoint rollback is exact");

  Builder chain;
  chain.input(1);
  chain.builtin(2, BuiltinNodeKind::Gain, 1, 0.5f, 1.0f, 0,
                OscillatorWaveform::Saw, GraphNodeFlagMayProcessInPlace);
  chain.output(3);
  chain.connect(1, 0, 2, 0);
  chain.connect(2, 0, 3, 0);
  expect(succeeded(chain.compile()), "compile linear graph");
  const BufferPlanSummary linear = compiledGraphBufferPlan(*chain.graph);
  expect(linear.inPlaceAliasCount == 1 && linear.physicalBufferCount == 1,
         "exact in-place alias and lifetime plan");
  expect(compiledGraphNodeId(*chain.graph, 0).value == 1 &&
         compiledGraphNodeId(*chain.graph, 2).value == 3,
         "stable ids survive topological compilation");

  Builder scrambled;
  scrambled.output(33);
  scrambled.builtin(32, BuiltinNodeKind::Gain, 1);
  scrambled.input(31);
  scrambled.connect(31, 0, 32, 0); scrambled.connect(32, 0, 33, 0);
  expect(succeeded(scrambled.compile()) &&
         compiledGraphNodeId(*scrambled.graph, 0).value == 31 &&
         compiledGraphNodeId(*scrambled.graph, 2).value == 33,
         "topological plan is independent of description order");

  Builder fanout;
  fanout.input(10);
  fanout.builtin(11, BuiltinNodeKind::Gain, 1, 1.0f, 1.0f, 0,
                 OscillatorWaveform::Saw, GraphNodeFlagMayProcessInPlace);
  fanout.builtin(12, BuiltinNodeKind::Gain, 1, 1.0f, 1.0f, 0,
                 OscillatorWaveform::Saw, GraphNodeFlagMayProcessInPlace);
  fanout.builtin(13, BuiltinNodeKind::Mix, 2);
  fanout.output(14);
  fanout.connect(10, 0, 11, 0);
  fanout.connect(10, 0, 12, 0);
  fanout.connect(11, 0, 13, 0);
  fanout.connect(12, 0, 13, 1);
  fanout.connect(13, 0, 14, 0);
  expect(succeeded(fanout.compile()), "compile fan-out/fan-in graph");
  expect(compiledGraphBufferPlan(*fanout.graph).inPlaceAliasCount == 1,
         "fan-out aliases only at its final live consumer");

  Builder cycle;
  cycle.builtin(20, BuiltinNodeKind::Gain, 1);
  cycle.builtin(21, BuiltinNodeKind::Gain, 1);
  cycle.output(22);
  cycle.connect(20, 0, 21, 0);
  cycle.connect(21, 0, 20, 0);
  cycle.connect(21, 0, 22, 0);
  GraphCompileError error{};
  expect(!succeeded(cycle.compile(&error)) && error.kind == GraphErrorKind::Cycle,
         "cycles are rejected");
}

ProcessorHandle preparedBuiltin(const BuiltinNodeConfig& config,
                                const AudioBusDescriptor* inputs,
                                uint32_t inputCount,
                                const AudioBusDescriptor& output,
                                std::vector<uint8_t>* stateBytes,
                                std::vector<uint8_t>* durableBytes) {
  stateBytes->resize(builtinStateBytes(config));
  ProcessorHandle processor = createBuiltinProcessor(config,
      {stateBytes->data(), static_cast<uint32_t>(stateBytes->size())});
  durableBytes->resize(builtinPreparedBytes(config, {32}));
  PrepareSpec spec{kProcessorInterfaceVersion, kPrepareSpecV1RequiredSize,
      {48000.0}, {32}, inputCount, 1, inputs, &output};
  PreparedStorage durable{durableBytes->empty() ? nullptr : durableBytes->data(),
                          durableBytes->size(), alignof(float)};
  const Status status = processor.functions->prepare(
      processor.state, &spec, &durable);
  if (!succeeded(status)) std::fprintf(stderr,
      "direct builtin prepare failed code=%u detail=%u kind=%u in=%u/%u out=%u/%u\n",
      static_cast<unsigned>(status.code), status.detail,
      static_cast<unsigned>(config.kind), inputCount, config.inputChannels,
      output.channelCount, config.outputChannels);
  expect(succeeded(status), "prepare direct builtin");
  return processor;
}

void builtinBusContracts() {
  AudioBusDescriptor mono{1, SampleFormat::Float32Planar,
                          AudioChannelLayout::Mono, nullptr};
  AudioBusDescriptor stereo{2, SampleFormat::Float32Planar,
                            AudioChannelLayout::Stereo, nullptr};
  auto factoryAccepts = [](const BuiltinNodeConfig& config) {
    alignas(64) uint8_t bytes[32 * 1024]{};
    ProcessorHandle processor = createBuiltinProcessor(
        config, {bytes, static_cast<uint32_t>(sizeof(bytes))});
    if (processor.state == nullptr) return false;
    expect(succeeded(destroyProcessor(&processor)),
           "destroy unprepared builtin contract probe");
    return true;
  };
  auto prepareRejected = [](const BuiltinNodeConfig& config,
                            const AudioBusDescriptor* inputs,
                            uint32_t inputCount,
                            const AudioBusDescriptor* outputs,
                            uint32_t outputCount) {
    std::vector<uint8_t> bytes(builtinStateBytes(config));
    ProcessorHandle processor = createBuiltinProcessor(
        config, {bytes.data(), static_cast<uint32_t>(bytes.size())});
    expect(processor.state != nullptr, "create builtin prepare rejection probe");
    PrepareSpec spec{kProcessorInterfaceVersion, kPrepareSpecV1RequiredSize,
        {48000.0}, {32}, inputCount, outputCount, inputs, outputs};
    PreparedStorage durable{nullptr, 0, 1};
    const Status prepared = processor.functions->prepare(
        processor.state, &spec, &durable);
    expect(!succeeded(prepared) && succeeded(destroyProcessor(&processor)),
           "builtin rejects bus shape before activation");
  };

  constexpr BuiltinNodeKind unaryKinds[]{
      BuiltinNodeKind::Gain, BuiltinNodeKind::DelayCompensation,
      BuiltinNodeKind::PeakRms, BuiltinNodeKind::Tap,
      BuiltinNodeKind::SafetyLimiter};
  for (BuiltinNodeKind kind : unaryKinds) {
    BuiltinNodeConfig monoToStereo{kind, {100}, 1, 2, 1, 1.0f, 1.0f,
        0, OscillatorWaveform::Saw, nullptr, 0};
    expect(!factoryAccepts(monoToStereo),
           "unary builtin factory rejects mono-to-stereo contract");
    BuiltinNodeConfig monoContract{kind, {101}, 1, 1, 1, 1.0f, 1.0f,
        0, OscillatorWaveform::Saw, nullptr, 0};
    prepareRejected(monoContract, &mono, 1, &stereo, 1);
    BuiltinNodeConfig noInput = monoContract; noInput.inputBusCount = 0;
    BuiltinNodeConfig twoInputs = monoContract; twoInputs.inputBusCount = 2;
    expect(!factoryAccepts(noInput) && !factoryAccepts(twoInputs),
           "unary builtin factory enforces exactly one input bus");
  }

  BuiltinNodeConfig mixNoInputs{BuiltinNodeKind::Mix, {110}, 1, 1, 0,
      0, 0, 0, OscillatorWaveform::Saw, nullptr, 0};
  BuiltinNodeConfig mixMonoToStereo{BuiltinNodeKind::Mix, {111}, 1, 2, 2,
      0, 0, 0, OscillatorWaveform::Saw, nullptr, 0};
  expect(!factoryAccepts(mixNoInputs) && !factoryAccepts(mixMonoToStereo),
         "mix factory requires compatible non-empty inputs");
  BuiltinNodeConfig stereoMix{BuiltinNodeKind::Mix, {112}, 2, 2, 2,
      0, 0, 0, OscillatorWaveform::Saw, nullptr, 0};
  AudioBusDescriptor mixedWidths[]{mono, stereo};
  prepareRejected(stereoMix, mixedWidths, 2, &stereo, 1);

  float identity[]{1.0f};
  BuiltinNodeConfig mapNoInput{BuiltinNodeKind::ChannelMap, {120}, 1, 1, 0,
      0, 0, 0, OscillatorWaveform::Saw, identity, 0};
  BuiltinNodeConfig mapTwoInputs = mapNoInput; mapTwoInputs.inputBusCount = 2;
  expect(!factoryAccepts(mapNoInput) && !factoryAccepts(mapTwoInputs),
         "channel map factory enforces exactly one input bus");
  float invalidMap[]{std::numeric_limits<float>::quiet_NaN()};
  BuiltinNodeConfig nonFiniteMap{BuiltinNodeKind::ChannelMap, {121}, 1, 1, 1,
      0, 0, 0, OscillatorWaveform::Saw, invalidMap, 0};
  expect(!factoryAccepts(nonFiniteMap),
         "channel map factory rejects non-finite coefficients");

  BuiltinNodeConfig oscillatorWithInput{BuiltinNodeKind::Oscillator, {130},
      1, 1, 1, 440.0f, 0.1f, 0, OscillatorWaveform::Sine, nullptr, 0};
  expect(!factoryAccepts(oscillatorWithInput),
         "oscillator factory enforces source-only input shape");
  BuiltinNodeConfig oscillator{BuiltinNodeKind::Oscillator, {131}, 0, 2, 0,
      440.0f, 0.1f, 0, OscillatorWaveform::Sine, nullptr, 0};
  std::vector<uint8_t> oscillatorState, oscillatorDurable;
  ProcessorHandle validOscillator = preparedBuiltin(
      oscillator, nullptr, 0, stereo, &oscillatorState, &oscillatorDurable);
  expect(succeeded(deactivateProcessor(validOscillator)) &&
         succeeded(destroyProcessor(&validOscillator)),
         "oscillator accepts zero inputs and exactly one valid output");

  BuiltinNodeConfig tooWide{BuiltinNodeKind::Gain, {140},
      kMaximumChannelsPerBus + 1, kMaximumChannelsPerBus + 1, 1,
      1.0f, 1.0f, 0, OscillatorWaveform::Saw, nullptr, 0};
  expect(!factoryAccepts(tooWide), "builtin factory rejects over-wide buses");
  BuiltinNodeConfig validGain{BuiltinNodeKind::Gain, {141}, 1, 1, 1,
      1.0f, 1.0f, 0, OscillatorWaveform::Saw, nullptr, 0};
  BuiltinNodeConfig zeroNodeGain = validGain;
  zeroNodeGain.node = {0};
  expect(!factoryAccepts(zeroNodeGain),
         "builtin factory rejects the unset stable node id");
  prepareRejected(validGain, nullptr, 1, &mono, 1);
  prepareRejected(validGain, &mono, 1, nullptr, 1);

  const float nonFiniteValues[]{
      std::numeric_limits<float>::quiet_NaN(),
      std::numeric_limits<float>::infinity(),
      -std::numeric_limits<float>::infinity()};
  for (float invalid : nonFiniteValues) {
    BuiltinNodeConfig gainScalar{BuiltinNodeKind::Gain, {150}, 1, 1, 1,
        invalid, 0.0f, 0, OscillatorWaveform::Saw, nullptr, 0};
    BuiltinNodeConfig limiterScalar{BuiltinNodeKind::SafetyLimiter, {151},
        1, 1, 1, invalid, 0.0f, 0, OscillatorWaveform::Saw, nullptr, 0};
    BuiltinNodeConfig oscillatorFrequency{BuiltinNodeKind::Oscillator, {152},
        0, 1, 0, invalid, 0.5f, 0, OscillatorWaveform::Sine, nullptr, 0};
    BuiltinNodeConfig oscillatorAmplitude{BuiltinNodeKind::Oscillator, {153},
        0, 1, 0, 440.0f, invalid, 0, OscillatorWaveform::Sine, nullptr, 0};
    float coefficient[]{invalid};
    BuiltinNodeConfig mapScalar{BuiltinNodeKind::ChannelMap, {154}, 1, 1, 1,
        0.0f, 0.0f, 0, OscillatorWaveform::Saw, coefficient, 0};
    expect(!factoryAccepts(gainScalar) && !factoryAccepts(limiterScalar) &&
           !factoryAccepts(oscillatorFrequency) &&
           !factoryAccepts(oscillatorAmplitude) && !factoryAccepts(mapScalar),
           "builtin factory rejects every NaN and infinity scalar variant");
  }

  BuiltinNodeConfig zeroLimiter{BuiltinNodeKind::SafetyLimiter, {160},
      1, 1, 1, 0.0f, 0.0f, 0, OscillatorWaveform::Saw, nullptr, 0};
  BuiltinNodeConfig negativeLimiter = zeroLimiter;
  negativeLimiter.value0 = -std::numeric_limits<float>::min();
  BuiltinNodeConfig excessiveLimiter = zeroLimiter;
  excessiveLimiter.value0 = std::nextafter(1.0f, 2.0f);
  expect(!factoryAccepts(zeroLimiter) && !factoryAccepts(negativeLimiter) &&
         !factoryAccepts(excessiveLimiter),
         "limiter factory enforces a positive normalized threshold");

  BuiltinNodeConfig negativeFrequency{BuiltinNodeKind::Oscillator, {161},
      0, 1, 0, -std::numeric_limits<float>::min(), 0.5f, 0,
      OscillatorWaveform::Sine, nullptr, 0};
  BuiltinNodeConfig negativeAmplitude{BuiltinNodeKind::Oscillator, {162},
      0, 1, 0, 440.0f, -std::numeric_limits<float>::min(), 0,
      OscillatorWaveform::Sine, nullptr, 0};
  BuiltinNodeConfig excessiveAmplitude = negativeAmplitude;
  excessiveAmplitude.value1 = std::nextafter(1.0f, 2.0f);
  expect(!factoryAccepts(negativeFrequency) &&
         !factoryAccepts(negativeAmplitude) &&
         !factoryAccepts(excessiveAmplitude),
         "oscillator factory enforces non-negative frequency and normalized amplitude");

  BuiltinNodeConfig hugeDelay{BuiltinNodeKind::DelayCompensation, {163},
      kMaximumChannelsPerBus, kMaximumChannelsPerBus, 1, 0.0f, 0.0f,
      UINT32_MAX, OscillatorWaveform::Saw, nullptr, 0};
  expect(!factoryAccepts(hugeDelay),
         "delay factory rejects an unrepresentable prepared sample count");

  BuiltinNodeConfig minimumLimiter{BuiltinNodeKind::SafetyLimiter, {164},
      1, 1, 1, std::numeric_limits<float>::min(), 0.0f, 0,
      OscillatorWaveform::Saw, nullptr, 0};
  BuiltinNodeConfig unityLimiter = minimumLimiter;
  unityLimiter.value0 = 1.0f;
  BuiltinNodeConfig finiteNegativeGain{BuiltinNodeKind::Gain, {165}, 1, 1, 1,
      -std::numeric_limits<float>::max(), 0.0f, 0,
      OscillatorWaveform::Saw, nullptr, 0};
  expect(factoryAccepts(minimumLimiter),
         "limiter accepts the minimum positive threshold boundary");
  expect(factoryAccepts(unityLimiter),
         "limiter accepts the unity threshold boundary");
  expect(factoryAccepts(finiteNegativeGain),
         "gain accepts every finite scalar boundary");

  BuiltinNodeConfig nyquistOscillator{BuiltinNodeKind::Oscillator, {166},
      0, 1, 0, 24000.0f, 1.0f, 0, OscillatorWaveform::Sine, nullptr, 0};
  BuiltinNodeConfig zeroOscillator = nyquistOscillator;
  zeroOscillator.value0 = 0.0f;
  zeroOscillator.value1 = 0.0f;
  std::vector<uint8_t> nyquistState, nyquistDurable;
  ProcessorHandle nyquist = preparedBuiltin(nyquistOscillator, nullptr, 0,
      mono, &nyquistState, &nyquistDurable);
  expect(factoryAccepts(zeroOscillator) &&
         succeeded(deactivateProcessor(nyquist)) &&
         succeeded(destroyProcessor(&nyquist)),
         "oscillator accepts zero frequency/amplitude range through Nyquist");
  BuiltinNodeConfig aboveNyquist = nyquistOscillator;
  aboveNyquist.value0 = std::nextafter(24000.0f, 48000.0f);
  prepareRejected(aboveNyquist, nullptr, 0, &mono, 1);

  BuiltinNodeConfig limiterConfig{BuiltinNodeKind::SafetyLimiter, {167},
      1, 1, 1, 0.5f, 0.0f, 0, OscillatorWaveform::Saw, nullptr, 0};
  std::vector<uint8_t> limiterState, limiterDurable;
  ProcessorHandle limiter = preparedBuiltin(limiterConfig, &mono, 1, mono,
      &limiterState, &limiterDurable);
  float limiterInputSamples[]{2.0f, -2.0f};
  float limiterOutputSamples[2]{};
  const float* limiterInputs[]{limiterInputSamples};
  float* limiterOutputs[]{limiterOutputSamples};
  ConstAudioBusView limiterInput{limiterInputs, 1, {2}, {2}, nullptr};
  MutableAudioBusView limiterOutput{limiterOutputs, 1, {2}, {2}};
  ParameterEvent excessiveThreshold{{167}, kLimiterThresholdParameter, {0},
      2.0f, ParameterCurve::Step, {0}};
  ProcessContext limiterContext{kProcessContextInterfaceVersion,
      kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {2},
      &excessiveThreshold, 1, nullptr, 0, {nullptr, 0},
      {DiscontinuityReason::None, 0}};
  limiter.functions->process(limiter.state, &limiterContext, &limiterInput, 1,
                             &limiterOutput, 1);
  expect(limiterOutputSamples[0] == 1.0f &&
         limiterOutputSamples[1] == -1.0f &&
         succeeded(deactivateProcessor(limiter)) &&
         succeeded(destroyProcessor(&limiter)),
         "over-range limiter automation falls back to unity and cannot bypass clipping");
}

void remainingBuiltins() {
  alignas(64) uint8_t invalidStorage[512]{};
  BuiltinNodeConfig invalidKind{static_cast<BuiltinNodeKind>(99), {90}, 1, 1,
      1, 1.0f, 1.0f, 0, OscillatorWaveform::Saw, nullptr, 0};
  expect(createBuiltinProcessor(invalidKind,
      {invalidStorage, sizeof(invalidStorage)}).state == nullptr,
      "builtin factory rejects out-of-domain node kind");
  BuiltinNodeConfig invalidWaveform{BuiltinNodeKind::Oscillator, {91}, 1, 1,
      0, 440.0f, 0.1f, 0, static_cast<OscillatorWaveform>(99), nullptr, 0};
  expect(createBuiltinProcessor(invalidWaveform,
      {invalidStorage, sizeof(invalidStorage)}).state == nullptr,
      "oscillator factory rejects out-of-domain waveform");

  AudioBusDescriptor stereo{2, SampleFormat::Float32Planar,
                            AudioChannelLayout::Stereo, nullptr};
  float swap[]{0, 1, 1, 0};
  BuiltinNodeConfig mapConfig{BuiltinNodeKind::ChannelMap, {1}, 2, 2, 1,
      0, 0, 0, OscillatorWaveform::Saw, swap, 0};
  std::vector<uint8_t> mapState, mapDurable;
  ProcessorHandle map = preparedBuiltin(mapConfig, &stereo, 1, stereo,
                                        &mapState, &mapDurable);
  swap[0] = 1.0f;
  float left[]{1, 2}, right[]{3, 4}, outLeft[2]{}, outRight[2]{};
  const float* inputs[]{left, right}; float* outputs[]{outLeft, outRight};
  ConstAudioBusView input{inputs, 2, {2}, {2}, nullptr};
  MutableAudioBusView output{outputs, 2, {2}, {2}};
  ProcessContext context{kProcessContextInterfaceVersion, kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {2},
      nullptr, 0, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0}};
  map.functions->process(map.state, &context, &input, 1, &output, 1);
  expect(outLeft[0] == 3 && outRight[0] == 1,
         "channel map owns its matrix and maps explicitly");
  expect(succeeded(deactivateProcessor(map)) && succeeded(destroyProcessor(&map)),
         "channel map lifecycle");

  AudioBusDescriptor mono{1, SampleFormat::Float32Planar,
                          AudioChannelLayout::Mono, nullptr};
  BuiltinNodeConfig disabledTapConfig{BuiltinNodeKind::Tap, {92}, 1, 1, 1,
      0, 0, 0, OscillatorWaveform::Saw, nullptr, 0};
  std::vector<uint8_t> disabledTapState, disabledTapDurable;
  ProcessorHandle disabledTap = preparedBuiltin(
      disabledTapConfig, &mono, 1, mono, &disabledTapState,
      &disabledTapDurable);
  float disabledInputSample = 0.5f, disabledOutputSample = 0.0f;
  const float* disabledInputChannels[]{&disabledInputSample};
  float* disabledOutputChannels[]{&disabledOutputSample};
  ConstAudioBusView disabledInput{disabledInputChannels, 1, {1}, {1}, nullptr};
  MutableAudioBusView disabledOutput{disabledOutputChannels, 1, {1}, {1}};
  ProcessContext disabledContext{kProcessContextInterfaceVersion,
      kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {1},
      nullptr, 0, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0}};
  disabledTap.functions->process(disabledTap.state, &disabledContext,
      &disabledInput, 1, &disabledOutput, 1);
  expect(disabledOutputSample == 0.5f && builtinTapFrames(disabledTap) == 0 &&
         succeeded(deactivateProcessor(disabledTap)) &&
         succeeded(destroyProcessor(&disabledTap)),
         "zero-capacity tap remains a safe transparent processor");

  BuiltinNodeConfig meterConfig{BuiltinNodeKind::PeakRms, {2}, 1, 1, 1,
      0, 0, 0, OscillatorWaveform::Saw, nullptr, 0};
  std::vector<uint8_t> meterState, meterDurable;
  ProcessorHandle meter = preparedBuiltin(meterConfig, &mono, 1, mono,
                                          &meterState, &meterDurable);
  float meterInput[]{1, -1, 0, 0}; float meterOutput[4]{};
  const float* meterIn[]{meterInput}; float* meterOut[]{meterOutput};
  ConstAudioBusView meterInputBus{meterIn, 1, {4}, {4}, nullptr};
  MutableAudioBusView meterOutputBus{meterOut, 1, {4}, {4}};
  context.frames = {4};
  meter.functions->process(meter.state, &context, &meterInputBus, 1,
                           &meterOutputBus, 1);
  const MeterReading reading = builtinMeter(meter);
  near(reading.peak, 1.0f, 0.0f, "peak meter");
  near(reading.rms, std::sqrt(0.5f), 0.00001f, "RMS meter");
  meter.functions->reset(meter.state,
      {DiscontinuityReason::SourceSeek, DiscontinuityFlagResetState});
  const MeterReading resetReading = builtinMeter(meter);
  expect(resetReading.peak == 0.0f && resetReading.rms == 0.0f &&
         resetReading.frames == 0,
         "meter reset publishes a coherent empty current window");
  float quiet[4]{}; const float* quietIn[]{quiet};
  ConstAudioBusView quietBus{quietIn, 1, {4}, {4}, nullptr};
  meter.functions->process(meter.state, &context, &quietBus, 1,
                           &meterOutputBus, 1);
  const MeterReading quietReading = builtinMeter(meter);
  expect(quietReading.peak == 0.0f && quietReading.rms == 0.0f &&
         quietReading.frames == 4,
         "meter snapshot represents the current block, not lifetime maxima");
  expect(succeeded(deactivateProcessor(meter)) && succeeded(destroyProcessor(&meter)),
         "meter lifecycle");

  BuiltinNodeConfig stereoMeterConfig{BuiltinNodeKind::PeakRms, {22}, 2, 2, 1,
      0, 0, 0, OscillatorWaveform::Saw, nullptr, 0};
  std::vector<uint8_t> stereoMeterState, stereoMeterDurable;
  ProcessorHandle stereoMeter = preparedBuiltin(
      stereoMeterConfig, &stereo, 1, stereo, &stereoMeterState,
      &stereoMeterDurable);
  float meterLeft[]{1.0f, 0.0f}; float meterRight[]{0.0f, -1.0f};
  float meterOutLeft[2]{}, meterOutRight[2]{};
  const float* stereoMeterIn[]{meterLeft, meterRight};
  float* stereoMeterOut[]{meterOutLeft, meterOutRight};
  ConstAudioBusView stereoMeterInput{stereoMeterIn, 2, {2}, {2}, nullptr};
  MutableAudioBusView stereoMeterOutput{stereoMeterOut, 2, {2}, {2}};
  context.frames = {2};
  stereoMeter.functions->process(stereoMeter.state, &context,
      &stereoMeterInput, 1, &stereoMeterOutput, 1);
  const MeterReading stereoReading = builtinMeter(stereoMeter);
  expect(stereoReading.frames == 2,
         "meter reports audio frames rather than channel-sample count");
  near(stereoReading.rms, std::sqrt(0.5f), 0.00001f,
       "stereo RMS includes every channel sample");
  expect(succeeded(deactivateProcessor(stereoMeter)) &&
         succeeded(destroyProcessor(&stereoMeter)), "stereo meter lifecycle");

  float tapped[4]{};
  BuiltinNodeConfig tapConfig{BuiltinNodeKind::Tap, {3}, 1, 1, 1,
      0, 0, 0, OscillatorWaveform::Saw, nullptr, 4};
  std::vector<uint8_t> tapState, tapDurable;
  ProcessorHandle tap = preparedBuiltin(tapConfig, &mono, 1, mono,
                                        &tapState, &tapDurable);
  tap.functions->process(tap.state, &context, &meterInputBus, 1,
                         &meterOutputBus, 1);
  expect(builtinTapFrames(tap) == 4 &&
         builtinTapSnapshot(tap, tapped, 4) == 4 &&
         tapped[0] == 1 && tapped[1] == -1,
         "bounded tap publishes a copied current-block snapshot");
  float latestInput[]{0.25f, 0.5f}; const float* latestIn[]{latestInput};
  ConstAudioBusView latestBus{latestIn, 1, {2}, {2}, nullptr};
  context.frames = {2}; meterOutputBus.frames = {2};
  tap.functions->process(tap.state, &context, &latestBus, 1,
                         &meterOutputBus, 1);
  expect(builtinTapSnapshot(tap, tapped, 4) == 2 && tapped[0] == 0.25f &&
         tapped[1] == 0.5f,
         "tap snapshot is bounded current-block telemetry");
  tap.functions->reset(tap.state,
      {DiscontinuityReason::SourceSeek, DiscontinuityFlagResetState});
  expect(builtinTapFrames(tap) == 0 && builtinTapSnapshot(tap, tapped, 4) == 0,
         "tap reset publishes an empty current window");
  expect(succeeded(deactivateProcessor(tap)) && succeeded(destroyProcessor(&tap)),
         "tap lifecycle");
}

void automationAcrossPartitions() {
  AudioBusDescriptor mono{1, SampleFormat::Float32Planar,
                          AudioChannelLayout::Mono, nullptr};
  BuiltinNodeConfig gainConfig{BuiltinNodeKind::Gain, {50}, 1, 1, 1,
      0.0f, 0.0f, 0, OscillatorWaveform::Saw, nullptr, 0};
  std::vector<uint8_t> gainState, gainDurable;
  ProcessorHandle gain = preparedBuiltin(gainConfig, &mono, 1, mono,
                                         &gainState, &gainDurable);
  float ones[8]{1, 1, 1, 1, 1, 1, 1, 1}; float output[8]{};
  const float* inputChannels[]{ones}; float* outputChannels[]{output};
  ConstAudioBusView input{inputChannels, 1, {2}, {8}, nullptr};
  MutableAudioBusView out{outputChannels, 1, {2}, {8}};
  ParameterEvent ramp{{50}, kGainParameter, {0}, 1.0f,
                      ParameterCurve::Linear, {4}};
  ProcessContext context{kProcessContextInterfaceVersion, kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {2},
      &ramp, 1, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0}};
  gain.functions->process(gain.state, &context, &input, 1, &out, 1);
  near(output[0], 0.0f, 0.0f, "ramp begins from current value");
  near(output[1], 0.25f, 0.000001f, "ramp advances sample accurately");
  input.channels = inputChannels; inputChannels[0] = ones + 2;
  outputChannels[0] = output + 2; context.parameters = nullptr;
  context.parameterCount = 0;
  gain.functions->process(gain.state, &context, &input, 1, &out, 1);
  near(output[2], 0.5f, 0.000001f, "ramp persists across callback boundary");
  near(output[3], 0.75f, 0.000001f, "cross-block ramp reaches target next sample");
  inputChannels[0] = ones + 4; outputChannels[0] = output + 4;
  context.frames = {4}; input.frames = {4}; out.frames = {4};
  ParameterEvent late{{50}, kGainParameter, {2}, 0.5f,
                      ParameterCurve::Step, {0}};
  context.parameters = &late; context.parameterCount = 1;
  gain.functions->process(gain.state, &context, &input, 1, &out, 1);
  expect(output[4] == 1.0f && output[5] == 1.0f &&
         output[6] == 0.5f && output[7] == 0.5f,
         "late-offset step changes only the named sample and later");

  ParameterEvent flush{{50}, kGainParameter, {0}, 0.2f,
                       ParameterCurve::Step, {0}};
  context.frames = {0}; input.frames = {0}; out.frames = {0};
  context.parameters = &flush; context.parameterCount = 1;
  gain.functions->process(gain.state, &context, &input, 1, &out, 1);
  context.frames = {1}; input.frames = {1}; out.frames = {1};
  inputChannels[0] = ones; outputChannels[0] = output;
  context.parameters = nullptr; context.parameterCount = 0;
  gain.functions->process(gain.state, &context, &input, 1, &out, 1);
  near(output[0], 0.2f, 0.000001f,
       "zero-frame offset-zero event updates the next audio block");
  expect(succeeded(deactivateProcessor(gain)) &&
         succeeded(destroyProcessor(&gain)), "automation gain lifecycle");

  auto renderRamp = [&](uint32_t firstPartition, float* rendered) {
    std::vector<uint8_t> state, durable;
    ProcessorHandle processor = preparedBuiltin(gainConfig, &mono, 1, mono,
                                                 &state, &durable);
    const float* inChannels[]{ones}; float* outChannels[]{rendered};
    ConstAudioBusView in{inChannels, 1, {firstPartition}, {8}, nullptr};
    MutableAudioBusView result{outChannels, 1, {firstPartition}, {8}};
    ParameterEvent event{{50}, kGainParameter, {0}, 1.0f,
                         ParameterCurve::Linear, {8}};
    ProcessContext split{kProcessContextInterfaceVersion,
        kProcessContextV1RequiredSize,
        {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0},
        {firstPartition}, &event, 1, nullptr, 0, {nullptr, 0},
        {DiscontinuityReason::None, 0}};
    processor.functions->process(processor.state, &split, &in, 1, &result, 1);
    if (firstPartition < 8) {
      inChannels[0] = ones + firstPartition;
      outChannels[0] = rendered + firstPartition;
      split.frames = {8 - firstPartition}; in.frames = split.frames;
      result.frames = split.frames; split.parameters = nullptr;
      split.parameterCount = 0;
      processor.functions->process(processor.state, &split, &in, 1, &result, 1);
    }
    expect(succeeded(deactivateProcessor(processor)) &&
           succeeded(destroyProcessor(&processor)), "partition ramp lifecycle");
  };
  float whole[8]{}, split[8]{};
  renderRamp(8, whole); renderRamp(3, split);
  expect(std::memcmp(whole, split, sizeof(whole)) == 0,
         "automation output is callback-partition invariant");
}

struct TelemetryReadBarrier {
  std::atomic<bool> armed{true};
  std::atomic<bool> validated{false};
  std::atomic<bool> writerDone{false};
};
void telemetryReadBarrier(void* opaque) noexcept {
  TelemetryReadBarrier* barrier = static_cast<TelemetryReadBarrier*>(opaque);
  if (!barrier->armed.exchange(false, std::memory_order_acq_rel)) return;
  barrier->validated.store(true, std::memory_order_release);
  while (!barrier->writerDone.load(std::memory_order_acquire))
    std::this_thread::yield();
}

void telemetryConcurrency() {
  AudioBusDescriptor mono{1, SampleFormat::Float32Planar,
                          AudioChannelLayout::Mono, nullptr};
  BuiltinNodeConfig meterConfig{BuiltinNodeKind::PeakRms, {60}, 1, 1, 1,
      0.0f, 0.0f, 0, OscillatorWaveform::Saw, nullptr, 0};
  BuiltinNodeConfig tapConfig{BuiltinNodeKind::Tap, {61}, 1, 1, 1,
      0.0f, 0.0f, 0, OscillatorWaveform::Saw, nullptr, 16};
  std::vector<uint8_t> meterState, meterDurable, tapState, tapDurable;
  ProcessorHandle meter = preparedBuiltin(meterConfig, &mono, 1, mono,
                                           &meterState, &meterDurable);
  ProcessorHandle tap = preparedBuiltin(tapConfig, &mono, 1, mono,
                                         &tapState, &tapDurable);
  float inputSamples[16]{}, meterSamples[16]{}, tapSamples[16]{};
  const float* inputChannels[]{inputSamples};
  float* meterChannels[]{meterSamples}; float* tapChannels[]{tapSamples};
  ConstAudioBusView input{inputChannels, 1, {16}, {16}, nullptr};
  MutableAudioBusView meterOutput{meterChannels, 1, {16}, {16}};
  MutableAudioBusView tapOutput{tapChannels, 1, {16}, {16}};
  ProcessContext context{kProcessContextInterfaceVersion, kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {16},
      nullptr, 0, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0}};
  std::atomic<bool> finished{false};
  std::thread writer([&] {
    for (uint32_t block = 0; block < 10000; ++block) {
      const bool high = (block & 1u) == 0;
      const uint32_t frames = high ? 5 : 13;
      const float value = high ? 1.0f : 0.25f;
      for (uint32_t frame = 0; frame < frames; ++frame)
        inputSamples[frame] = value;
      context.frames = {frames}; input.frames = {frames};
      meterOutput.frames = {frames}; tapOutput.frames = {frames};
      meter.functions->process(meter.state, &context, &input, 1,
                               &meterOutput, 1);
      tap.functions->process(tap.state, &context, &input, 1, &tapOutput, 1);
    }
    finished.store(true, std::memory_order_release);
  });
  float snapshot[16]{};
  while (!finished.load(std::memory_order_acquire)) {
    const MeterReading reading = builtinMeter(meter);
    const bool empty = reading.frames == 0 && reading.peak == 0.0f &&
                       reading.rms == 0.0f;
    const bool high = reading.frames == 5 && reading.peak == 1.0f &&
                      reading.rms == 1.0f;
    const bool low = reading.frames == 13 && reading.peak == 0.25f &&
                     reading.rms == 0.25f;
    expect(empty || high || low,
           "meter seqlock publishes one correlated generation");
    const uint32_t tapFrames = builtinTapSnapshot(tap, snapshot, 16);
    bool coherent = tapFrames == 0 || tapFrames == 5 || tapFrames == 13;
    if (tapFrames != 0) {
      const float expected = tapFrames == 5 ? 1.0f : 0.25f;
      for (uint32_t frame = 0; frame < tapFrames; ++frame)
        coherent = coherent && snapshot[frame] == expected;
    }
    expect(coherent, "tap seqlock publishes one correlated generation");
  }
  writer.join();

  // Pause after the reader validates its selected slot. Two publications then
  // force the writer to reuse that exact physical slot before copying resumes.
  constexpr uint32_t slowFrames = 16;
  BuiltinNodeConfig slowTapConfig{BuiltinNodeKind::Tap, {62}, 1, 1, 1,
      0.0f, 0.0f, 0, OscillatorWaveform::Saw, nullptr, slowFrames};
  std::vector<uint8_t> slowState, slowDurable;
  ProcessorHandle slowTap = preparedBuiltin(slowTapConfig, &mono, 1, mono,
                                             &slowState, &slowDurable);
  std::vector<float> slowInputSamples(slowFrames, 1.0f);
  std::vector<float> slowOutputSamples(slowFrames);
  std::vector<float> slowSnapshot(slowFrames);
  const float* slowInputChannels[]{slowInputSamples.data()};
  float* slowOutputChannels[]{slowOutputSamples.data()};
  ConstAudioBusView slowInput{slowInputChannels, 1, {slowFrames},
                              {slowFrames}, nullptr};
  MutableAudioBusView slowOutput{slowOutputChannels, 1, {slowFrames},
                                 {slowFrames}};
  ProcessContext slowContext = context; slowContext.frames = {slowFrames};
  slowTap.functions->process(slowTap.state, &slowContext, &slowInput, 1,
                             &slowOutput, 1);
  TelemetryReadBarrier barrier{};
  uint32_t slowReadFrames = 0;
  std::thread slowReader([&] {
    slowReadFrames = builtinTapSnapshotTestOnly(
        slowTap, slowSnapshot.data(), slowFrames, telemetryReadBarrier,
        &barrier);
  });
  while (!barrier.validated.load(std::memory_order_acquire))
    std::this_thread::yield();
  for (uint32_t publication = 0; publication < 2; ++publication) {
    const uint32_t frames = publication == 0 ? 5 : 13;
    const float value = publication == 0 ? 0.25f : 0.5f;
    slowContext.frames = {frames}; slowInput.frames = {frames};
    slowOutput.frames = {frames};
    for (uint32_t frame = 0; frame < frames; ++frame)
      slowInputSamples[frame] = value;
    slowTap.functions->process(slowTap.state, &slowContext, &slowInput, 1,
                               &slowOutput, 1);
  }
  barrier.writerDone.store(true, std::memory_order_release);
  slowReader.join();
  bool slowCoherent = slowReadFrames == 13;
  for (uint32_t frame = 0; frame < slowReadFrames; ++frame)
    slowCoherent = slowCoherent && slowSnapshot[frame] == 0.5f;
  expect(slowCoherent,
         "slow telemetry reader survives repeated publication slot reuse");
  expect(succeeded(deactivateProcessor(slowTap)) &&
         succeeded(destroyProcessor(&slowTap)),
         "slow-reader telemetry lifecycle");
  expect(succeeded(deactivateProcessor(meter)) &&
         succeeded(destroyProcessor(&meter)) &&
         succeeded(deactivateProcessor(tap)) && succeeded(destroyProcessor(&tap)),
         "telemetry concurrency lifecycle");
}

void latencyCompensationAndRendering() {
  Builder graph;
  graph.builtin(1, BuiltinNodeKind::Oscillator, 0, 120.0f, 0.25f);
  graph.builtin(2, BuiltinNodeKind::DelayCompensation, 1, 0.0f, 0.0f, 5);
  graph.builtin(3, BuiltinNodeKind::Oscillator, 0, 120.0f, 0.25f);
  graph.builtin(4, BuiltinNodeKind::Mix, 2);
  graph.output(5);
  graph.connect(1, 0, 2, 0);
  graph.connect(2, 0, 4, 0);
  graph.connect(3, 0, 4, 1);
  graph.connect(4, 0, 5, 0);
  GraphCompileError latencyError{};
  const Status latencyStatus = graph.compile(&latencyError);
  if (!succeeded(latencyStatus)) std::fprintf(stderr,
      "latency compile error kind=%u node=%llu port=%u status=%u detail=%u\n",
      static_cast<unsigned>(latencyError.kind),
      static_cast<unsigned long long>(latencyError.node.value), latencyError.port,
      static_cast<unsigned>(latencyError.processorStatus.code),
      latencyError.processorStatus.detail);
  expect(succeeded(latencyStatus), "compile compensated parallel paths");
  expect(compiledGraphLatency(*graph.graph).value == 5 &&
         compiledGraphBufferPlan(*graph.graph).compensatedEdgeCount == 1,
         "short parallel path receives exact delay compensation");

  float output[32]{};
  float* channels[]{output};
  MutableAudioBusView bus{channels, 1, {32}, {32}};
  ProcessContext context{kProcessContextInterfaceVersion,
      kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr,
      {48000.0}, {32}, nullptr, 0, nullptr, 0, {nullptr, 0},
      {DiscontinuityReason::None, DiscontinuityFlagNone}};
  RuntimeDiagnostics diagnostics{};
  RetirementSlot slots[2]{};
  SnapshotPublisher publisher{};
  initializePublisher(&publisher, slots, 2, &diagnostics);
  PublishedGraphSnapshot snapshot{graph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &snapshot).status), "publish graph");
  GraphRunner runner{};
  runner.tailFrame = 99;
  GraphRunnerStorage storage{};
  initializeGraphRunner(&runner, &publisher, storage, nullptr, nullptr, &diagnostics);
  expect(runner.tailFrame == 0, "runner initializes finite-tail progress");
  expect(succeeded(renderGraphBlock(&runner, context, nullptr, 0, &bus, 1)),
         "render compensated graph");
  for (uint32_t frame = 0; frame < 5; ++frame) near(output[frame], 0.0f, 0.0f,
      "both paths align behind five-frame latency");

  Builder bypass;
  bypass.input(10);
  bypass.builtin(11, BuiltinNodeKind::DelayCompensation, 1, 0.0f, 0.0f, 3,
                 OscillatorWaveform::Saw, GraphNodeFlagBypassed);
  bypass.output(12);
  bypass.connect(10, 0, 11, 0); bypass.connect(11, 0, 12, 0);
  expect(succeeded(bypass.compile()) && compiledGraphLatency(*bypass.graph).value == 3,
         "compile latency-preserving bypass");
  float bypassInput[8]{1, 2, 3, 4, 5, 6, 7, 8}; float bypassOutput[8]{};
  const float* bypassInChannels[]{bypassInput}; float* bypassOutChannels[]{bypassOutput};
  ConstAudioBusView bypassIn{bypassInChannels, 1, {8}, {8}, nullptr};
  MutableAudioBusView bypassOut{bypassOutChannels, 1, {8}, {8}};
  RuntimeDiagnostics bypassDiagnostics{}; RetirementSlot bypassSlots[1]{};
  SnapshotPublisher bypassPublisher{};
  initializePublisher(&bypassPublisher, bypassSlots, 1, &bypassDiagnostics);
  PublishedGraphSnapshot bypassSnapshot{bypass.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&bypassPublisher, &bypassSnapshot).status),
         "publish bypass graph");
  GraphRunner bypassRunner{}; GraphRunnerStorage bypassStorage{};
  initializeGraphRunner(&bypassRunner, &bypassPublisher, bypassStorage,
                        nullptr, nullptr, &bypassDiagnostics);
  context.frames = {8};
  expect(succeeded(renderGraphBlock(&bypassRunner, context, &bypassIn, 1,
                                    &bypassOut, 1)), "render bypass graph");
  expect(bypassOutput[0] == 0.0f && bypassOutput[1] == 0.0f &&
         bypassOutput[2] == 0.0f && bypassOutput[3] == 1.0f,
         "bypass preserves the processor's declared latency");
}

struct ProbeState {
  uint32_t prepared;
  uint32_t active;
  uint32_t resets;
  uint32_t processes;
  uint32_t resetSeenAtProcess;
  uint32_t failPrepare;
  uint32_t deactivateFailures;
  uint32_t destroyFailures;
  uint32_t deactivateCalls;
  uint32_t destroyCalls;
  const CaptureTime* capture;
};
Status probePrepare(void* opaque, const PrepareSpec*, const PreparedStorage*) noexcept {
  ProbeState* state = static_cast<ProbeState*>(opaque);
  if (state->failPrepare != 0) return {StatusCode::UnsupportedFormat, 77};
  state->prepared = 1; state->active = 1; return okStatus();
}
void probeReset(void* opaque, Discontinuity) noexcept {
  ++static_cast<ProbeState*>(opaque)->resets;
}
void probeProcess(void* opaque, const ProcessContext*, const ConstAudioBusView* input,
                  uint32_t, const MutableAudioBusView* output, uint32_t) noexcept {
  ProbeState* state = static_cast<ProbeState*>(opaque);
  ++state->processes;
  state->resetSeenAtProcess = state->resets;
  state->capture = input[0].capture;
  for (uint32_t frame = 0; frame < output[0].frames.value; ++frame)
    output[0].channels[0][frame] = input[0].channels[0][frame];
}
LatencyFrames probeLatency(const void*) noexcept { return {0}; }
TailInfo probeTail(const void*) noexcept { return {TailKind::None, {0}}; }
Status probeDeactivate(void* opaque) noexcept {
  ProbeState* state = static_cast<ProbeState*>(opaque);
  ++state->deactivateCalls;
  if (state->deactivateFailures != 0) {
    --state->deactivateFailures;
    return {StatusCode::UnsupportedFormat, 88};
  }
  state->active = 0; return okStatus();
}
Status probeDestroy(void* opaque) noexcept {
  ProbeState* state = static_cast<ProbeState*>(opaque);
  ++state->destroyCalls;
  if (state->active != 0) return {StatusCode::InvalidArgument, 89};
  if (state->destroyFailures != 0) {
    --state->destroyFailures;
    return {StatusCode::UnsupportedFormat, 90};
  }
  state->prepared = 0;
  return okStatus();
}
constexpr ProcessorVTable probeFunctions{kProcessorInterfaceVersion,
    kProcessorVTableV1RequiredSize, probePrepare, probeReset, probeProcess,
    probeLatency, probeTail, probeDeactivate, probeDestroy};

void probeProcessAlternate(void* opaque, const ProcessContext* context,
                           const ConstAudioBusView* input, uint32_t inputCount,
                           const MutableAudioBusView* output,
                           uint32_t outputCount) noexcept {
  probeProcess(opaque, context, input, inputCount, output, outputCount);
}
constexpr ProcessorVTable alternateProbeFunctions{kProcessorInterfaceVersion,
    kProcessorVTableV1RequiredSize, probePrepare, probeReset,
    probeProcessAlternate, probeLatency, probeTail, probeDeactivate,
    probeDestroy};

void duplicateProcessorOwnershipRejectedBeforePrepare() {
  auto verify = [](const ProcessorVTable* secondVtable,
                   const char* message) {
    ProbeState shared{};
    Builder graph;
    graph.input(1);
    graph.nodes[graph.nodeCount++] = {{2}, {9, 2}, 1,
        GraphNodeRole::Processor, GraphNodeFlagMayProcessInPlace,
        1, 1, &graph.mono, &graph.mono,
        {&shared, &probeFunctions}, {nullptr, 0, 1}};
    graph.nodes[graph.nodeCount++] = {{3}, {10, 3}, 1,
        GraphNodeRole::Processor, GraphNodeFlagMayProcessInPlace,
        1, 1, &graph.mono, &graph.mono,
        {&shared, secondVtable}, {nullptr, 0, 1}};
    graph.output(4);
    graph.connect(1, 0, 2, 0);
    graph.connect(2, 0, 3, 0);
    graph.connect(3, 0, 4, 0);
    const ArenaCheckpoint before = checkpoint(graph.arena);
    GraphCompileError error{};
    expect(!succeeded(graph.compile(&error)) &&
           error.kind == GraphErrorKind::DuplicateProcessor &&
           error.node.value == 3 && error.port == 1 &&
           checkpoint(graph.arena).used == before.used &&
           shared.prepared == 0 && shared.active == 0 &&
           shared.deactivateCalls == 0 && shared.destroyCalls == 0,
           message);
  };
  verify(&probeFunctions,
         "same-state same-vtable processor alias rejects without lifecycle calls");
  verify(&alternateProbeFunctions,
         "same-state different-vtable processor alias rejects without lifecycle calls");
}

struct EventProbeState {
  ParameterEvent parameters[kMaximumEventsPerBlock]{};
  MusicalEvent events[kMaximumEventsPerBlock]{};
  uint32_t parameterCount{0};
  uint32_t eventCount{0};
};
Status eventProbePrepare(void*, const PrepareSpec*,
                         const PreparedStorage*) noexcept { return okStatus(); }
void eventProbeReset(void*, Discontinuity) noexcept {}
void eventProbeProcess(void* opaque, const ProcessContext* context,
                       const ConstAudioBusView* input, uint32_t,
                       const MutableAudioBusView* output, uint32_t) noexcept {
  EventProbeState* state = static_cast<EventProbeState*>(opaque);
  state->parameterCount = context->parameterCount;
  state->eventCount = context->eventCount;
  for (uint32_t index = 0; index < context->parameterCount; ++index)
    state->parameters[index] = context->parameters[index];
  for (uint32_t index = 0; index < context->eventCount; ++index)
    state->events[index] = context->events[index];
  for (uint32_t frame = 0; frame < output[0].frames.value; ++frame)
    output[0].channels[0][frame] = input[0].channels[0][frame];
}
Status eventProbeDeactivate(void*) noexcept { return okStatus(); }
Status eventProbeDestroy(void*) noexcept { return okStatus(); }
constexpr ProcessorVTable eventProbeFunctions{kProcessorInterfaceVersion,
    kProcessorVTableV1RequiredSize, eventProbePrepare, eventProbeReset,
    eventProbeProcess, probeLatency, probeTail, eventProbeDeactivate,
    eventProbeDestroy};

struct CapturePairProbeState {
  CaptureTime capture[2]{};
  bool valid[2]{};
};
void capturePairProcess(void* opaque, const ProcessContext*,
                        const ConstAudioBusView* input, uint32_t inputCount,
                        const MutableAudioBusView* output, uint32_t) noexcept {
  CapturePairProbeState* state = static_cast<CapturePairProbeState*>(opaque);
  for (uint32_t bus = 0; bus < 2; ++bus) {
    state->valid[bus] = bus < inputCount && input[bus].capture != nullptr;
    if (state->valid[bus]) state->capture[bus] = *input[bus].capture;
  }
  for (uint32_t frame = 0; frame < output[0].frames.value; ++frame)
    output[0].channels[0][frame] = input[0].channels[0][frame] +
                                  input[1].channels[0][frame];
}
constexpr ProcessorVTable capturePairFunctions{kProcessorInterfaceVersion,
    kProcessorVTableV1RequiredSize, eventProbePrepare, eventProbeReset,
    capturePairProcess, probeLatency, probeTail, eventProbeDeactivate,
    eventProbeDestroy};

struct BlockingProbeState {
  std::atomic<bool> entered{false};
  std::atomic<bool> release{false};
  bool callbackDomainSeen{false};
  uint32_t parameterCount{0};
  uint32_t eventCount{0};
};

struct AdoptionTransferBarrier {
  std::atomic<uint32_t> stage{0};
  std::atomic<uint32_t> released{0};
};
void adoptionTransferBarrier(void* opaque,
                             AdoptionTransferStage stage) noexcept {
  AdoptionTransferBarrier* barrier =
      static_cast<AdoptionTransferBarrier*>(opaque);
  const uint32_t value = static_cast<uint32_t>(stage);
  barrier->stage.store(value, std::memory_order_release);
  while (barrier->released.load(std::memory_order_acquire) < value)
    std::this_thread::yield();
}
struct RejectionTransferBarrier {
  std::atomic<uint32_t> stage{0};
  std::atomic<uint32_t> released{0};
};
void rejectionTransferBarrier(void* opaque,
                              RejectionTransferStage stage) noexcept {
  RejectionTransferBarrier* barrier =
      static_cast<RejectionTransferBarrier*>(opaque);
  const uint32_t value = static_cast<uint32_t>(stage);
  barrier->stage.store(value, std::memory_order_release);
  while (barrier->released.load(std::memory_order_acquire) < value)
    std::this_thread::yield();
}
void blockingProbeProcess(void* opaque, const ProcessContext* context,
                          const ConstAudioBusView* input, uint32_t,
                          const MutableAudioBusView* output, uint32_t) noexcept {
  BlockingProbeState* state = static_cast<BlockingProbeState*>(opaque);
  state->callbackDomainSeen = inGraphRenderCallback();
  state->parameterCount = context->parameterCount;
  state->eventCount = context->eventCount;
  state->entered.store(true, std::memory_order_release);
  while (!state->release.load(std::memory_order_acquire))
    std::this_thread::yield();
  for (uint32_t frame = 0; frame < output[0].frames.value; ++frame)
    output[0].channels[0][frame] = input[0].channels[0][frame];
}
constexpr ProcessorVTable blockingProbeFunctions{kProcessorInterfaceVersion,
    kProcessorVTableV1RequiredSize, eventProbePrepare, eventProbeReset,
    blockingProbeProcess, probeLatency, probeTail, eventProbeDeactivate,
    eventProbeDestroy};

struct TailProbeState {
  TailInfo declared;
  uint64_t remaining;
  uint32_t prepared;
  uint32_t active;
  uint32_t triggered;
  uint32_t tailDrainFrames{0};
  uint32_t tailParameterEvents{0};
  uint32_t tailMusicalEvents{0};
  uint32_t tailTransportStates{0};
};
Status tailProbePrepare(void* opaque, const PrepareSpec*,
                        const PreparedStorage*) noexcept {
  TailProbeState* state = static_cast<TailProbeState*>(opaque);
  state->prepared = 1; state->active = 1; return okStatus();
}
void tailProbeReset(void* opaque, Discontinuity) noexcept {
  TailProbeState* state = static_cast<TailProbeState*>(opaque);
  state->remaining = 0; state->triggered = 0;
}
void tailProbeProcess(void* opaque, const ProcessContext* context,
                      const ConstAudioBusView* input, uint32_t,
                      const MutableAudioBusView* output, uint32_t) noexcept {
  TailProbeState* state = static_cast<TailProbeState*>(opaque);
  if ((processContextFlags(*context) & ProcessContextFlagTailDrain) != 0) {
    state->tailDrainFrames += context->frames.value;
    state->tailParameterEvents += context->parameterCount;
    state->tailMusicalEvents += context->eventCount;
    if (context->transport != nullptr)
      state->tailTransportStates |= context->transport->stateFlags;
  }
  for (uint32_t frame = 0; frame < output[0].frames.value; ++frame) {
    const float incoming = input[0].channels[0][frame];
    if (incoming != 0.0f) {
      state->triggered = 1;
      state->remaining = state->declared.frames.value;
      output[0].channels[0][frame] = incoming;
    } else if (state->declared.kind == TailKind::Infinite &&
               state->triggered != 0) {
      output[0].channels[0][frame] = 0.5f;
    } else if (state->remaining != 0) {
      output[0].channels[0][frame] = 0.5f;
      --state->remaining;
    } else {
      output[0].channels[0][frame] = 0.0f;
    }
  }
}
LatencyFrames tailProbeLatency(const void*) noexcept { return {0}; }
TailInfo tailProbeTail(const void* opaque) noexcept {
  return static_cast<const TailProbeState*>(opaque)->declared;
}
Status tailProbeDeactivate(void* opaque) noexcept {
  static_cast<TailProbeState*>(opaque)->active = 0; return okStatus();
}
Status tailProbeDestroy(void*) noexcept { return okStatus(); }
constexpr ProcessorVTable tailProbeFunctions{kProcessorInterfaceVersion,
    kProcessorVTableV1RequiredSize, tailProbePrepare, tailProbeReset,
    tailProbeProcess, tailProbeLatency, tailProbeTail, tailProbeDeactivate,
    tailProbeDestroy};

void discontinuitiesAndFailedPrepare() {
  ProbeState probe{};
  Builder graph;
  graph.input(1);
  graph.nodes[graph.nodeCount++] = {{2}, {9, 2}, 1, GraphNodeRole::Processor,
      GraphNodeFlagMayProcessInPlace, 1, 1, &graph.mono, &graph.mono,
      {&probe, &probeFunctions}, {nullptr, 0, 1}};
  graph.output(3);
  graph.connect(1, 0, 2, 0); graph.connect(2, 0, 3, 0);
  expect(succeeded(graph.compile()), "compile discontinuity probe");
  float inputSample = 0.25f, outputSample = 0.0f;
  const float* inputChannels[]{&inputSample}; float* outputChannels[]{&outputSample};
  ConstAudioBusView input{inputChannels, 1, {1}, {1}, nullptr};
  MutableAudioBusView output{outputChannels, 1, {1}, {1}};
  RuntimeDiagnostics diagnostics{}; RetirementSlot slots[1]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slots, 1, &diagnostics);
  PublishedGraphSnapshot snapshot{graph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &snapshot).status),
         "publish discontinuity graph");
  GraphRunner runner{}; GraphRunnerStorage storage{};
  initializeGraphRunner(&runner, &publisher, storage, nullptr, nullptr, &diagnostics);
  constexpr DiscontinuityReason reasons[]{
      DiscontinuityReason::StreamGenerationChanged, DiscontinuityReason::SequenceGap,
      DiscontinuityReason::SampleRateChanged, DiscontinuityReason::RouteGenerationChanged,
      DiscontinuityReason::TimestampQualityChanged, DiscontinuityReason::ClockReanchored,
      DiscontinuityReason::SourceSeek, DiscontinuityReason::SourceLoop,
      DiscontinuityReason::DeviceLost,
      DiscontinuityReason::SourceFrameOverflow};
  for (uint32_t index = 0; index < sizeof(reasons) / sizeof(reasons[0]); ++index) {
    ProcessContext context{kProcessContextInterfaceVersion,
        kProcessContextV1RequiredSize,
        {{1}, {1}, {index}, {0}, {0}, RenderTimeDiscontinuous}, nullptr,
        {48000.0}, {1}, nullptr, 0, nullptr, 0, {nullptr, 0},
        {reasons[index], DiscontinuityFlagResetState}};
    expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)),
           "typed discontinuity block");
    expect(probe.resets == index + 1 && probe.resetSeenAtProcess == probe.resets,
           "exact reset happens before affected block");
  }

  Builder failing;
  failing.input(10);
  ProbeState bad{}; bad.failPrepare = 1;
  failing.nodes[failing.nodeCount++] = {{11}, {9, 11}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &failing.mono, &failing.mono,
      {&bad, &probeFunctions}, {nullptr, 0, 1}};
  failing.output(12); failing.connect(10, 0, 11, 0); failing.connect(11, 0, 12, 0);
  GraphCompileError error{};
  expect(!succeeded(failing.compile(&error)) &&
         error.kind == GraphErrorKind::ProcessorFailure &&
         runner.active == &snapshot && probe.active != 0,
         "failed prepare leaves active graph unchanged");
}

void lifecycleFailureRecovery() {
  ProbeState held{};
  held.deactivateFailures = 1;
  ProbeState prepareFailure{};
  prepareFailure.failPrepare = 1;
  Builder rollback;
  rollback.input(1);
  rollback.nodes[rollback.nodeCount++] = {{2}, {9, 2}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &rollback.mono, &rollback.mono,
      {&held, &probeFunctions}, {nullptr, 0, 1}};
  rollback.nodes[rollback.nodeCount++] = {{3}, {9, 3}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &rollback.mono, &rollback.mono,
      {&prepareFailure, &probeFunctions}, {nullptr, 0, 1}};
  rollback.output(4);
  rollback.connect(1, 0, 2, 0); rollback.connect(2, 0, 3, 0);
  rollback.connect(3, 0, 4, 0);
  expect(!succeeded(rollback.compile()) && held.active != 0 &&
         held.deactivateCalls == 1 && held.destroyCalls == 0 &&
         rollback.lastResult.cleanupCount == 1 &&
         rollback.lastResult.cleanupArena == &rollback.arena,
         "failed deactivate quarantines live compile rollback ownership");
  expect(succeeded(cleanupFailedCompile(&rollback.lastResult)) &&
         held.deactivateCalls == 2 && held.destroyCalls == 1 &&
         held.active == 0 && rollback.lastResult.cleanupCount == 0 &&
         rollback.lastResult.cleanupArena == nullptr,
         "compile rollback teardown retries without premature reclaim");

  ProbeState destroyHeld{};
  destroyHeld.destroyFailures = 1;
  ProbeState secondPrepareFailure{};
  secondPrepareFailure.failPrepare = 1;
  Builder destroyRollback;
  destroyRollback.input(10);
  destroyRollback.nodes[destroyRollback.nodeCount++] = {{11}, {9, 11}, 1,
      GraphNodeRole::Processor, 0, 1, 1,
      &destroyRollback.mono, &destroyRollback.mono,
      {&destroyHeld, &probeFunctions}, {nullptr, 0, 1}};
  destroyRollback.nodes[destroyRollback.nodeCount++] = {{12}, {9, 12}, 1,
      GraphNodeRole::Processor, 0, 1, 1,
      &destroyRollback.mono, &destroyRollback.mono,
      {&secondPrepareFailure, &probeFunctions}, {nullptr, 0, 1}};
  destroyRollback.output(13);
  destroyRollback.connect(10, 0, 11, 0);
  destroyRollback.connect(11, 0, 12, 0);
  destroyRollback.connect(12, 0, 13, 0);
  expect(!succeeded(destroyRollback.compile()) && destroyHeld.active == 0 &&
         destroyHeld.deactivateCalls == 1 && destroyHeld.destroyCalls == 1 &&
         destroyRollback.lastResult.cleanup[0].state ==
             ProcessorOwnershipState::Deactivated,
         "failed destroy preserves deactivated rollback handle");
  expect(succeeded(cleanupFailedCompile(&destroyRollback.lastResult)) &&
         destroyHeld.deactivateCalls == 1 && destroyHeld.destroyCalls == 2,
         "destroy retry never deactivates an already inactive processor");

  ProbeState live{};
  Builder compiled;
  compiled.input(20);
  compiled.nodes[compiled.nodeCount++] = {{21}, {9, 21}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &compiled.mono, &compiled.mono,
      {&live, &probeFunctions}, {nullptr, 0, 1}};
  compiled.output(22); compiled.connect(20, 0, 21, 0);
  compiled.connect(21, 0, 22, 0);
  expect(succeeded(compiled.compile()), "compile retryable teardown graph");
  live.deactivateFailures = 1;
  live.destroyFailures = 1;
  expect(!succeeded(deactivateCompiledGraph(compiled.graph)) &&
         live.active != 0 && live.destroyCalls == 0,
         "compiled teardown never destroys after failed deactivate");
  expect(!succeeded(deactivateCompiledGraph(compiled.graph)) &&
         live.active == 0 && live.deactivateCalls == 2 && live.destroyCalls == 1,
         "compiled teardown quarantines failed destroy");
  expect(succeeded(deactivateCompiledGraph(compiled.graph)) &&
         live.deactivateCalls == 2 && live.destroyCalls == 2,
         "compiled teardown retries destroy without duplicate deactivate");
}

void externalBoundariesAndProvenance() {
  Builder graph;
  graph.input(1);
  graph.builtin(2, BuiltinNodeKind::Gain, 1, 2.0f, 1.0f, 0,
                OscillatorWaveform::Saw, GraphNodeFlagMayProcessInPlace);
  graph.output(3);
  graph.input(10);
  graph.builtin(11, BuiltinNodeKind::Gain, 1, 3.0f, 1.0f, 0,
                OscillatorWaveform::Saw, GraphNodeFlagMayProcessInPlace);
  graph.builtin(12, BuiltinNodeKind::Gain, 1, 2.0f, 1.0f, 0,
                OscillatorWaveform::Saw, GraphNodeFlagMayProcessInPlace);
  graph.output(13);
  graph.connect(1, 0, 2, 0); graph.connect(2, 0, 3, 0);
  graph.connect(10, 0, 11, 0); graph.connect(11, 0, 12, 0);
  graph.connect(12, 0, 13, 0);
  expect(succeeded(graph.compile()), "compile independent multi-I/O graph");
  float firstInput = 2.0f, secondInput = 5.0f;
  float firstOutput = 0.0f, secondOutput = 0.0f;
  const float* firstInChannels[]{&firstInput};
  const float* secondInChannels[]{&secondInput};
  float* firstOutChannels[]{&firstOutput};
  float* secondOutChannels[]{&secondOutput};
  ConstAudioBusView inputs[]{
      {firstInChannels, 1, {1}, {1}, nullptr},
      {secondInChannels, 1, {1}, {1}, nullptr}};
  MutableAudioBusView outputs[]{
      {firstOutChannels, 1, {1}, {1}},
      {secondOutChannels, 1, {1}, {1}}};
  RuntimeDiagnostics diagnostics{}; RetirementSlot slots[1]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slots, 1, &diagnostics);
  PublishedGraphSnapshot snapshot{graph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &snapshot).status),
         "publish independent multi-I/O graph");
  GraphRunner runner{}; GraphRunnerStorage storage{};
  initializeGraphRunner(&runner, &publisher, storage, nullptr, nullptr, &diagnostics);
  ProcessContext context{kProcessContextInterfaceVersion, kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {1},
      nullptr, 0, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0}};
  expect(succeeded(renderGraphBlock(&runner, context, inputs, 2, outputs, 2)) &&
         firstOutput == 4.0f && secondOutput == 30.0f,
         "external pre/post copies remain live across independent branches");

  ProbeState transparentProbe{};
  Builder transparent;
  transparent.input(20);
  transparent.nodes[transparent.nodeCount++] = {{21}, {9, 21}, 1,
      GraphNodeRole::Processor, GraphNodeFlagMayProcessInPlace, 1, 1,
      &transparent.mono, &transparent.mono,
      {&transparentProbe, &probeFunctions}, {nullptr, 0, 1}};
  transparent.output(22); transparent.connect(20, 0, 21, 0);
  transparent.connect(21, 0, 22, 0);
  expect(succeeded(transparent.compile()), "compile provenance transform");
  CaptureTime capture{};
  inputs[0].capture = &capture;
  RetirementSlot transparentSlot[1]{}; SnapshotPublisher transparentPublisher{};
  initializePublisher(&transparentPublisher, transparentSlot, 1, &diagnostics);
  PublishedGraphSnapshot transparentSnapshot{
      transparent.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&transparentPublisher,
                                  &transparentSnapshot).status),
         "publish provenance transform");
  GraphRunner transparentRunner{};
  initializeGraphRunner(&transparentRunner, &transparentPublisher, {}, nullptr,
                        nullptr, &diagnostics);
  expect(succeeded(renderGraphBlock(&transparentRunner, context, inputs, 1,
                                    outputs, 1)) &&
         transparentProbe.capture == &capture,
         "one-source transparent transform preserves capture provenance");

  constexpr uint32_t fullCaptureFlags =
      CaptureTimeSourceFrameValid | CaptureTimeSampleHostValid |
      CaptureTimeCallbackHostValid | CaptureTimeStaleAnchor |
      CaptureTimeTimestampQualityValid;
  capture.clockDomain = {7};
  capture.streamGeneration = {8};
  capture.sequence = 9;
  capture.sourceFrame = {10};
  capture.sampleHostTime = {11};
  capture.callbackHostTime = {12};
  capture.quality = CaptureTimestampQuality::Hardware;
  capture.flags = fullCaptureFlags;
  expect(succeeded(renderGraphBlock(&transparentRunner, context, inputs, 1,
                                    outputs, 1)) &&
         transparentProbe.capture != nullptr &&
         transparentProbe.capture->flags == fullCaptureFlags,
         "full known capture-validity mask reaches the input bus losslessly");

  const uint32_t processesBeforeInvalidFlags = transparentProbe.processes;
  const uint32_t epochBeforeInvalidFlags =
      acknowledgedEpoch(transparentRunner);
  firstOutput = 123.0f;
  capture.flags = fullCaptureFlags | (1u << 5);
  expect(!succeeded(renderGraphBlock(&transparentRunner, context, inputs, 1,
                                     outputs, 1)) &&
         transparentProbe.processes == processesBeforeInvalidFlags &&
         acknowledgedEpoch(transparentRunner) == epochBeforeInvalidFlags &&
         firstOutput == 123.0f,
         "unknown capture flag rejects before graph or output mutation");

  capture.flags = CaptureTimeStaleAnchor;
  expect(!succeeded(renderGraphBlock(&transparentRunner, context, inputs, 1,
                                     outputs, 1)) &&
         transparentProbe.processes == processesBeforeInvalidFlags,
         "stale anchor without sample and quality validity is rejected");
  capture.flags = CaptureTimeStaleAnchor | CaptureTimeSampleHostValid |
                  CaptureTimeTimestampQualityValid;
  expect(succeeded(renderGraphBlock(&transparentRunner, context, inputs, 1,
                                    outputs, 1)) &&
         transparentProbe.capture != nullptr &&
         transparentProbe.capture->flags == capture.flags,
         "stale anchor with sample and quality validity is accepted");

  ProbeState fanInProbe{};
  Builder fanIn;
  fanIn.input(30); fanIn.input(31);
  fanIn.builtin(32, BuiltinNodeKind::Mix, 2);
  fanIn.nodes[fanIn.nodeCount++] = {{33}, {9, 33}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &fanIn.mono, &fanIn.mono,
      {&fanInProbe, &probeFunctions}, {nullptr, 0, 1}};
  fanIn.output(34); fanIn.connect(30, 0, 32, 0); fanIn.connect(31, 0, 32, 1);
  fanIn.connect(32, 0, 33, 0); fanIn.connect(33, 0, 34, 0);
  expect(succeeded(fanIn.compile()), "compile provenance fan-in");
  inputs[1].capture = &capture;
  RetirementSlot fanInSlot[1]{}; SnapshotPublisher fanInPublisher{};
  initializePublisher(&fanInPublisher, fanInSlot, 1, &diagnostics);
  PublishedGraphSnapshot fanInSnapshot{fanIn.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&fanInPublisher, &fanInSnapshot).status),
         "publish provenance fan-in");
  GraphRunner fanInRunner{};
  initializeGraphRunner(&fanInRunner, &fanInPublisher, {}, nullptr, nullptr,
                        &diagnostics);
  expect(succeeded(renderGraphBlock(&fanInRunner, context, inputs, 2, outputs, 1)) &&
         fanInProbe.capture == nullptr && firstOutput == 7.0f,
         "fan-in clears ambiguous capture provenance while preserving values");

  ProbeState delayedProbe{};
  Builder delayed;
  delayed.input(40);
  delayed.builtin(41, BuiltinNodeKind::DelayCompensation, 1, 0.0f, 0.0f, 64);
  delayed.nodes[delayed.nodeCount++] = {{42}, {9, 42}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &delayed.mono, &delayed.mono,
      {&delayedProbe, &probeFunctions}, {nullptr, 0, 1}};
  delayed.output(43); delayed.connect(40, 0, 41, 0);
  delayed.connect(41, 0, 42, 0); delayed.connect(42, 0, 43, 0);
  expect(succeeded(delayed.compile()), "compile provenance delay graph");
  float delayedInputSamples[64]{}; float delayedOutputSamples[64]{};
  const float* delayedInputChannels[]{delayedInputSamples};
  float* delayedOutputChannels[]{delayedOutputSamples};
  CaptureTime delayedCapture{{7}, {8}, 10, {36}, {1000000000},
      {2000000000}, CaptureTimestampQuality::Hardware,
      {DiscontinuityReason::None, DiscontinuityFlagNone},
      CaptureTimeSourceFrameValid | CaptureTimeSampleHostValid |
          CaptureTimeCallbackHostValid};
  ConstAudioBusView delayedInput{delayedInputChannels, 1, {64}, {64},
                                 &delayedCapture};
  MutableAudioBusView delayedOutput{delayedOutputChannels, 1, {64}, {64}};
  RetirementSlot delayedSlots[1]{}; SnapshotPublisher delayedPublisher{};
  initializePublisher(&delayedPublisher, delayedSlots, 1, &diagnostics);
  PublishedGraphSnapshot delayedSnapshot{delayed.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&delayedPublisher, &delayedSnapshot).status),
         "publish provenance delay graph");
  GraphRunner delayedRunner{};
  initializeGraphRunner(&delayedRunner, &delayedPublisher, {}, nullptr, nullptr,
                        &diagnostics);
  ProcessContext delayedContext = context; delayedContext.frames = {64};
  expect(succeeded(renderGraphBlock(&delayedRunner, delayedContext,
                                    &delayedInput, 1, &delayedOutput, 1)) &&
         delayedProbe.capture == nullptr,
         "delay metadata remains invalid throughout warmup");
  delayedCapture.sequence = 11;
  delayedCapture.sourceFrame = {100};
  delayedCapture.sampleHostTime = {1001333333};
  expect(succeeded(renderGraphBlock(&delayedRunner, delayedContext,
                                    &delayedInput, 1, &delayedOutput, 1)) &&
         delayedProbe.capture != nullptr &&
         delayedProbe.capture->sourceFrame.value == 36 &&
         delayedProbe.capture->sampleHostTime.value == 1000000000 &&
         delayedProbe.capture->sequence == 10,
         "delay output carries the metadata of its uniformly primed samples");
  delayedContext.time.flags = RenderTimeDiscontinuous;
  delayedContext.discontinuity = {DiscontinuityReason::SequenceGap,
                                  DiscontinuityFlagResetState};
  delayedCapture.sequence = 12; delayedCapture.sourceFrame = {164};
  expect(succeeded(renderGraphBlock(&delayedRunner, delayedContext,
                                    &delayedInput, 1, &delayedOutput, 1)) &&
         delayedProbe.capture == nullptr,
         "discontinuity reset invalidates delayed capture history");

  ProbeState nonAlignedProbe{};
  Builder nonAligned; nonAligned.input(44);
  nonAligned.builtin(45, BuiltinNodeKind::DelayCompensation, 1, 0.0f, 0.0f, 2);
  nonAligned.nodes[nonAligned.nodeCount++] = {{46}, {9, 46}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &nonAligned.mono, &nonAligned.mono,
      {&nonAlignedProbe, &probeFunctions}, {nullptr, 0, 1}};
  nonAligned.output(47); nonAligned.connect(44, 0, 45, 0);
  nonAligned.connect(45, 0, 46, 0); nonAligned.connect(46, 0, 47, 0);
  expect(succeeded(nonAligned.compile()),
         "compile non-block-aligned capture delay");
  float nonAlignedInputSamples[3]{}, nonAlignedOutputSamples[3]{};
  const float* nonAlignedInputChannels[]{nonAlignedInputSamples};
  float* nonAlignedOutputChannels[]{nonAlignedOutputSamples};
  CaptureTime nonAlignedCapture{{7}, {8}, 30, {100}, {1000000000},
      {2000000000}, CaptureTimestampQuality::Hardware,
      {DiscontinuityReason::None, DiscontinuityFlagNone},
      CaptureTimeSourceFrameValid | CaptureTimeSampleHostValid |
          CaptureTimeCallbackHostValid};
  ConstAudioBusView nonAlignedInput{nonAlignedInputChannels, 1, {3}, {3},
                                    &nonAlignedCapture};
  MutableAudioBusView nonAlignedOutput{nonAlignedOutputChannels, 1, {3}, {3}};
  RetirementSlot nonAlignedSlot[1]{}; SnapshotPublisher nonAlignedPublisher{};
  initializePublisher(&nonAlignedPublisher, nonAlignedSlot, 1, &diagnostics);
  PublishedGraphSnapshot nonAlignedSnapshot{nonAligned.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&nonAlignedPublisher,
                                  &nonAlignedSnapshot).status),
         "publish non-block-aligned capture delay");
  GraphRunner nonAlignedRunner{};
  initializeGraphRunner(&nonAlignedRunner, &nonAlignedPublisher, {}, nullptr,
                        nullptr, &diagnostics);
  ProcessContext nonAlignedContext = context; nonAlignedContext.frames = {3};
  expect(succeeded(renderGraphBlock(&nonAlignedRunner, nonAlignedContext,
                                    &nonAlignedInput, 1,
                                    &nonAlignedOutput, 1)) &&
         nonAlignedProbe.capture == nullptr,
         "non-block-aligned delay warmup metadata is invalid");
  nonAlignedCapture.sequence = 31;
  nonAlignedCapture.sourceFrame = {103};
  nonAlignedCapture.sampleHostTime = {1000062500};
  nonAlignedCapture.callbackHostTime = {2000062500};
  expect(succeeded(renderGraphBlock(&nonAlignedRunner, nonAlignedContext,
                                    &nonAlignedInput, 1,
                                    &nonAlignedOutput, 1)) &&
         nonAlignedProbe.capture != nullptr &&
         nonAlignedProbe.capture->sequence == 30 &&
         nonAlignedProbe.capture->sourceFrame.value == 101 &&
         nonAlignedProbe.capture->sampleHostTime.value == 1000020833 &&
         nonAlignedProbe.capture->callbackHostTime.value == 2000000000,
         "delay metadata crosses normal contiguous callback boundaries");

  CapturePairProbeState compensatedProbe{};
  Builder compensated; compensated.input(50);
  compensated.builtin(51, BuiltinNodeKind::DelayCompensation, 1, 0.0f,
                      0.0f, 2);
  compensated.input(52);
  AudioBusDescriptor pairInputs[]{compensated.mono, compensated.mono};
  compensated.nodes[compensated.nodeCount++] = {{53}, {9, 53}, 1,
      GraphNodeRole::Processor, 0, 2, 1, pairInputs, &compensated.mono,
      {&compensatedProbe, &capturePairFunctions}, {nullptr, 0, 1}};
  compensated.output(54); compensated.connect(50, 0, 51, 0);
  compensated.connect(51, 0, 53, 0); compensated.connect(52, 0, 53, 1);
  compensated.connect(53, 0, 54, 0);
  expect(succeeded(compensated.compile()),
         "compile automatic compensation provenance graph");
  float pairInputA[2]{1.0f, 1.0f}, pairInputB[2]{2.0f, 2.0f};
  float pairOutputSamples[2]{};
  const float* pairInputAChannels[]{pairInputA};
  const float* pairInputBChannels[]{pairInputB};
  float* pairOutputChannels[]{pairOutputSamples};
  CaptureTime pairCapture{{7}, {8}, 20, {200}, {3000000000},
      {4000000000}, CaptureTimestampQuality::Hardware,
      {DiscontinuityReason::None, DiscontinuityFlagNone},
      CaptureTimeSourceFrameValid | CaptureTimeSampleHostValid |
          CaptureTimeCallbackHostValid};
  ConstAudioBusView pairInputsView[]{
      {pairInputAChannels, 1, {2}, {2}, &pairCapture},
      {pairInputBChannels, 1, {2}, {2}, &pairCapture}};
  MutableAudioBusView pairOutput{pairOutputChannels, 1, {2}, {2}};
  RetirementSlot compensatedSlot[1]{}; SnapshotPublisher compensatedPublisher{};
  initializePublisher(&compensatedPublisher, compensatedSlot, 1, &diagnostics);
  PublishedGraphSnapshot compensatedSnapshot{compensated.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&compensatedPublisher,
                                  &compensatedSnapshot).status),
         "publish automatic compensation provenance graph");
  GraphRunner compensatedRunner{};
  initializeGraphRunner(&compensatedRunner, &compensatedPublisher, {}, nullptr,
                        nullptr, &diagnostics);
  ProcessContext pairContext = context; pairContext.frames = {2};
  expect(succeeded(renderGraphBlock(&compensatedRunner, pairContext,
                                    pairInputsView, 2, &pairOutput, 1)) &&
         !compensatedProbe.valid[0] && !compensatedProbe.valid[1],
         "intrinsic and automatic compensation metadata warm up invalid");
  pairCapture.sequence = 21; pairCapture.sourceFrame = {202};
  pairCapture.sampleHostTime = {3000041667};
  expect(succeeded(renderGraphBlock(&compensatedRunner, pairContext,
                                    pairInputsView, 2, &pairOutput, 1)) &&
         compensatedProbe.valid[0] && compensatedProbe.valid[1] &&
         compensatedProbe.capture[0].sourceFrame.value == 200 &&
         compensatedProbe.capture[1].sourceFrame.value == 200 &&
         compensatedProbe.capture[0].sequence == 20 &&
         compensatedProbe.capture[1].sequence == 20,
         "automatic compensation exposes metadata for delayed samples");
}

void transitionCompatibilityAndTails() {
  TailProbeState firstTail{{TailKind::Finite, {2}}, 0, 0, 0, 0};
  TailProbeState secondTail{{TailKind::Finite, {3}}, 0, 0, 0, 0};
  Builder composed;
  composed.input(1);
  composed.nodes[composed.nodeCount++] = {{2}, {8, 2}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &composed.mono, &composed.mono,
      {&firstTail, &tailProbeFunctions}, {nullptr, 0, 1}};
  composed.nodes[composed.nodeCount++] = {{3}, {8, 3}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &composed.mono, &composed.mono,
      {&secondTail, &tailProbeFunctions}, {nullptr, 0, 1}};
  composed.builtin(4, BuiltinNodeKind::DelayCompensation, 1, 0.0f, 0.0f, 2);
  composed.output(5); composed.connect(1, 0, 2, 0);
  composed.connect(2, 0, 3, 0); composed.connect(3, 0, 4, 0);
  composed.connect(4, 0, 5, 0);
  expect(succeeded(composed.compile()) &&
         compiledGraphTail(*composed.graph).kind == TailKind::Finite &&
         compiledGraphTail(*composed.graph).frames.value == 7,
         "finite tails compose serially with downstream deterministic latency");

  TailProbeState finite{{TailKind::Finite, {4}}, 0, 0, 0, 0};
  Builder oldGraph; oldGraph.input(10);
  oldGraph.nodes[oldGraph.nodeCount++] = {{11}, {8, 11}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &oldGraph.mono, &oldGraph.mono,
      {&finite, &tailProbeFunctions}, {nullptr, 0, 1}};
  oldGraph.output(12); oldGraph.connect(10, 0, 11, 0);
  oldGraph.connect(11, 0, 12, 0);
  expect(succeeded(oldGraph.compile()), "compile finite-tail graph");
  Builder replacement; replacement.input(10);
  replacement.builtin(20, BuiltinNodeKind::Gain, 1, 0.0f);
  replacement.output(12); replacement.connect(10, 0, 20, 0);
  replacement.connect(20, 0, 12, 0);
  expect(succeeded(replacement.compile()), "compile tail replacement graph");
  TransitionPlan finitePlan{};
  TransitionRequest finiteRequest{TransitionKind::Crossfade, {2},
      InfiniteTailPolicy::Fade, 100, 100, 800, nullptr, nullptr, {4}};
  finiteRequest.expectedOldGeneration = 1;
  finiteRequest.replacementGeneration = 2;
  expect(succeeded(prepareTransition(oldGraph.graph, replacement.graph,
                                     finiteRequest, &finitePlan)) &&
         finitePlan.tailSpillFrames.value == 4,
         "finite transition reserves its compiled drain bound");
  TransitionRequest shortFinite = finiteRequest;
  shortFinite.tailSpillFrames = {3};
  expect(!succeeded(prepareTransition(oldGraph.graph, replacement.graph,
                                      shortFinite, &finitePlan)),
         "finite transition rejects insufficient spill capacity");

  RuntimeDiagnostics diagnostics{}; RetirementSlot slots[2]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slots, 2, &diagnostics);
  PublishedGraphSnapshot oldSnapshot{oldGraph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &oldSnapshot).status),
         "publish finite-tail source");
  float oldSamples[2]{}, silenceSamples[2]{}, inputSamples[2]{0.0f, 1.0f};
  const float* silenceChannels[1]{}; float* oldChannels[]{oldSamples};
  const float* inputChannels[]{inputSamples}; float outputSamples[2]{};
  float* outputChannels[]{outputSamples};
  GraphRunnerStorage storage{oldSamples, oldChannels, nullptr, nullptr, nullptr,
      1, {2}, {0}, {0}, silenceSamples, silenceChannels, 1};
  GraphRunner runner{};
  initializeGraphRunner(&runner, &publisher, storage, nullptr, nullptr, &diagnostics);
  ConstAudioBusView input{inputChannels, 1, {2}, {2}, nullptr};
  MutableAudioBusView output{outputChannels, 1, {2}, {2}};
  ProcessContext context{kProcessContextInterfaceVersion, kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {2},
      nullptr, 0, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0}};
  expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)),
         "seed finite processor tail");
  PublishedGraphSnapshot replacementSnapshot{
      replacement.graph, 2, finitePlan, 0};
  expect(succeeded(submitSnapshot(&publisher, &replacementSnapshot).status),
         "publish finite drain transition");
  inputSamples[0] = 0.0f; inputSamples[1] = 0.0f;
  expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
         runner.fadingFrom == &oldSnapshot,
         "finite transition crossfade begins");
  expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
         outputSamples[0] == 0.0f && outputSamples[1] == 0.0f &&
         runner.fadingFrom == &oldSnapshot,
         "finite old tail drains silently after its fade reaches zero");
  expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
         runner.fadingFrom == nullptr,
         "finite spill retires at its caller-bounded endpoint");

  TailProbeState infinite{{TailKind::Infinite, {0}}, 0, 0, 0, 0};
  Builder infiniteGraph; infiniteGraph.input(30);
  infiniteGraph.nodes[infiniteGraph.nodeCount++] = {{31}, {8, 31}, 1,
      GraphNodeRole::Processor, 0, 1, 1,
      &infiniteGraph.mono, &infiniteGraph.mono,
      {&infinite, &tailProbeFunctions}, {nullptr, 0, 1}};
  infiniteGraph.output(32); infiniteGraph.connect(30, 0, 31, 0);
  infiniteGraph.connect(31, 0, 32, 0);
  expect(succeeded(infiniteGraph.compile()), "compile infinite-tail graph");
  Builder infiniteReplacement; infiniteReplacement.input(30);
  infiniteReplacement.builtin(40, BuiltinNodeKind::Gain, 1, 0.0f);
  infiniteReplacement.output(32); infiniteReplacement.connect(30, 0, 40, 0);
  infiniteReplacement.connect(40, 0, 32, 0);
  expect(succeeded(infiniteReplacement.compile()),
         "compile infinite-tail replacement");
  TransitionRequest rejectRequest{TransitionKind::Crossfade, {2},
      InfiniteTailPolicy::Reject, 100, 100, 800, nullptr, nullptr, {4}};
  rejectRequest.expectedOldGeneration = 1;
  rejectRequest.replacementGeneration = 2;
  expect(!succeeded(prepareTransition(infiniteGraph.graph,
                                      infiniteReplacement.graph,
                                      rejectRequest, &finitePlan)),
         "infinite Reject policy refuses publication");
  TransitionRequest fadeRequest = rejectRequest;
  fadeRequest.infiniteTailPolicy = InfiniteTailPolicy::Fade;
  TransitionPlan fadePlan{};
  expect(succeeded(prepareTransition(infiniteGraph.graph,
                                     infiniteReplacement.graph,
                                     fadeRequest, &fadePlan)) &&
         fadePlan.tailSpillFrames.value == 4,
         "infinite Fade policy requires an explicit caller bound");

  RuntimeDiagnostics fadeDiagnostics{}; RetirementSlot fadeSlots[2]{};
  SnapshotPublisher fadePublisher{};
  initializePublisher(&fadePublisher, fadeSlots, 2, &fadeDiagnostics);
  PublishedGraphSnapshot infiniteSnapshot{infiniteGraph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&fadePublisher, &infiniteSnapshot).status),
         "publish infinite-tail source");
  float fadeOld[2]{}, fadeSilence[2]{}, fadeInputSamples[2]{0.0f, 1.0f};
  float fadeOutputSamples[2]{}; float* fadeOldChannels[]{fadeOld};
  const float* fadeSilenceChannels[1]{};
  const float* fadeInputChannels[]{fadeInputSamples};
  float* fadeOutputChannels[]{fadeOutputSamples};
  GraphRunnerStorage fadeStorage{fadeOld, fadeOldChannels, nullptr, nullptr,
      nullptr, 1, {2}, {0}, {0}, fadeSilence, fadeSilenceChannels, 1};
  GraphRunner fadeRunner{};
  initializeGraphRunner(&fadeRunner, &fadePublisher, fadeStorage, nullptr,
                        nullptr, &fadeDiagnostics);
  ConstAudioBusView fadeInput{fadeInputChannels, 1, {2}, {2}, nullptr};
  MutableAudioBusView fadeOutput{fadeOutputChannels, 1, {2}, {2}};
  expect(succeeded(renderGraphBlock(&fadeRunner, context, &fadeInput, 1,
                                    &fadeOutput, 1)),
         "seed infinite tail");
  PublishedGraphSnapshot fadeReplacementSnapshot{
      infiniteReplacement.graph, 2, fadePlan, 0};
  expect(succeeded(submitSnapshot(&fadePublisher,
                                  &fadeReplacementSnapshot).status),
         "publish infinite fade transition");
  fadeInputSamples[0] = 0.0f; fadeInputSamples[1] = 0.0f;
  expect(succeeded(renderGraphBlock(&fadeRunner, context, &fadeInput, 1,
                                    &fadeOutput, 1)),
         "infinite fade crossfade");
  expect(succeeded(renderGraphBlock(&fadeRunner, context, &fadeInput, 1,
                                    &fadeOutput, 1)) &&
         fadeOutputSamples[0] == 0.0f && fadeOutputSamples[1] == 0.0f,
         "infinite Fade spill cannot restart a completed old-path fade");
  expect(succeeded(renderGraphBlock(&fadeRunner, context, &fadeInput, 1,
                                    &fadeOutput, 1)) &&
         fadeOutputSamples[0] == 0.0f && fadeOutputSamples[1] == 0.0f &&
         fadeRunner.fadingFrom == nullptr,
         "infinite Fade retires exactly at the explicit bound");

  TailProbeState cutTail{{TailKind::Infinite, {0}}, 0, 0, 0, 0};
  Builder cutGraph; cutGraph.input(50);
  cutGraph.nodes[cutGraph.nodeCount++] = {{51}, {8, 51}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &cutGraph.mono, &cutGraph.mono,
      {&cutTail, &tailProbeFunctions}, {nullptr, 0, 1}};
  cutGraph.output(52); cutGraph.connect(50, 0, 51, 0);
  cutGraph.connect(51, 0, 52, 0);
  expect(succeeded(cutGraph.compile()), "compile infinite cut source");
  Builder cutReplacement; cutReplacement.input(50);
  cutReplacement.builtin(53, BuiltinNodeKind::Gain, 1, 0.0f);
  cutReplacement.output(52); cutReplacement.connect(50, 0, 53, 0);
  cutReplacement.connect(53, 0, 52, 0);
  expect(succeeded(cutReplacement.compile()), "compile infinite cut replacement");
  TransitionRequest cutRequest{TransitionKind::HardCut, {0},
      InfiniteTailPolicy::Cut, 100, 100, 800, nullptr, nullptr, {0}};
  cutRequest.expectedOldGeneration = 1;
  cutRequest.replacementGeneration = 2;
  TransitionPlan cutPlan{};
  expect(succeeded(prepareTransition(cutGraph.graph, cutReplacement.graph,
                                     cutRequest, &cutPlan)),
         "infinite Cut policy prepares an immediate hard cut");
  RetirementSlot cutSlots[2]{}; SnapshotPublisher cutPublisher{};
  initializePublisher(&cutPublisher, cutSlots, 2, &fadeDiagnostics);
  PublishedGraphSnapshot cutSource{cutGraph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&cutPublisher, &cutSource).status),
         "publish infinite cut source");
  GraphRunner cutRunner{};
  initializeGraphRunner(&cutRunner, &cutPublisher, {}, nullptr, nullptr,
                        &fadeDiagnostics);
  fadeInputSamples[1] = 1.0f;
  expect(succeeded(renderGraphBlock(&cutRunner, context, &fadeInput, 1,
                                    &fadeOutput, 1)), "seed cut source");
  PublishedGraphSnapshot cutReplacementSnapshot{
      cutReplacement.graph, 2, cutPlan, 0};
  expect(succeeded(submitSnapshot(&cutPublisher,
                                  &cutReplacementSnapshot).status),
         "publish infinite cut replacement");
  fadeInputSamples[1] = 0.0f;
  expect(succeeded(renderGraphBlock(&cutRunner, context, &fadeInput, 1,
                                    &fadeOutput, 1)) &&
         fadeOutputSamples[0] == 0.0f && fadeOutputSamples[1] == 0.0f &&
         cutRunner.fadingFrom == nullptr,
         "infinite Cut drops the old tail without running a fade path");

  Builder wrongRate; wrongRate.sampleRate = {44100.0}; wrongRate.input(10);
  wrongRate.builtin(20, BuiltinNodeKind::Gain, 1); wrongRate.output(12);
  wrongRate.connect(10, 0, 20, 0); wrongRate.connect(20, 0, 12, 0);
  expect(succeeded(wrongRate.compile()) &&
         !succeeded(prepareTransition(oldGraph.graph, wrongRate.graph,
                                      finiteRequest, &finitePlan)),
         "transition rejects incompatible sample rate before state transfer");
  Builder wrongBlock; wrongBlock.maximumFrames = {128}; wrongBlock.input(10);
  wrongBlock.builtin(20, BuiltinNodeKind::Gain, 1); wrongBlock.output(12);
  wrongBlock.connect(10, 0, 20, 0); wrongBlock.connect(20, 0, 12, 0);
  expect(succeeded(wrongBlock.compile()) &&
         !succeeded(prepareTransition(oldGraph.graph, wrongBlock.graph,
                                      finiteRequest, &finitePlan)),
         "transition rejects incompatible maximum block contract");
}

void tailEnvelopeContinuity() {
  auto render = [](const uint32_t* partitions, uint32_t partitionCount,
                   std::vector<float>* samples) {
    TailProbeState tail{{TailKind::Finite, {4}}, 0, 0, 0, 0};
    Builder oldGraph; oldGraph.input(1);
    oldGraph.nodes[oldGraph.nodeCount++] = {{2}, {8, 2}, 1,
        GraphNodeRole::Processor, 0, 1, 1, &oldGraph.mono, &oldGraph.mono,
        {&tail, &tailProbeFunctions}, {nullptr, 0, 1}};
    oldGraph.output(3); oldGraph.connect(1, 0, 2, 0);
    oldGraph.connect(2, 0, 3, 0);
    expect(succeeded(oldGraph.compile()), "compile envelope tail source");
    Builder replacement; replacement.input(1);
    replacement.builtin(4, BuiltinNodeKind::Gain, 1, 0.0f);
    replacement.output(3); replacement.connect(1, 0, 4, 0);
    replacement.connect(4, 0, 3, 0);
    expect(succeeded(replacement.compile()), "compile zero envelope replacement");
    TransitionRequest request{TransitionKind::Crossfade, {2},
        InfiniteTailPolicy::Fade, 100, 100, 800, nullptr, nullptr, {4}};
    request.expectedOldGeneration = 1; request.replacementGeneration = 2;
    TransitionPlan plan{};
    expect(succeeded(prepareTransition(oldGraph.graph, replacement.graph,
                                       request, &plan)) &&
           plan.tailSpillFrames.value == 4,
           "prepare two-frame fade with four-frame finite spill");
    RuntimeDiagnostics diagnostics{}; RetirementSlot slots[2]{};
    SnapshotPublisher publisher{}; initializePublisher(&publisher, slots, 2,
                                                        &diagnostics);
    PublishedGraphSnapshot oldSnapshot{oldGraph.graph, 1, hardCut(), 0};
    expect(succeeded(submitSnapshot(&publisher, &oldSnapshot).status),
           "publish envelope source");
    float oldScratch[6]{}, silence[6]{}, inputSamples[6]{}, outputSamples[6]{};
    float* oldChannels[]{oldScratch}; const float* silenceChannels[1]{};
    const float* inputChannels[]{inputSamples}; float* outputChannels[]{outputSamples};
    GraphRunnerStorage storage{oldScratch, oldChannels, nullptr, nullptr, nullptr,
        1, {6}, {0}, {0}, silence, silenceChannels, 1};
    GraphRunner runner{}; initializeGraphRunner(&runner, &publisher, storage,
                                                nullptr, nullptr, &diagnostics);
    ConstAudioBusView input{inputChannels, 1, {1}, {6}, nullptr};
    MutableAudioBusView output{outputChannels, 1, {1}, {6}};
    ProcessContext context{kProcessContextInterfaceVersion,
        kProcessContextV1RequiredSize,
        {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {1},
        nullptr, 0, nullptr, 0, {nullptr, 0},
        {DiscontinuityReason::None, 0}};
    inputSamples[0] = 0.5f;
    expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
           outputSamples[0] == 0.5f, "seed constant finite tail at one half");
    inputSamples[0] = 0.0f;
    PublishedGraphSnapshot next{replacement.graph, 2, plan, 0};
    expect(succeeded(submitSnapshot(&publisher, &next).status),
           "publish envelope replacement");
    samples->clear();
    for (uint32_t part = 0; part < partitionCount; ++part) {
      const uint32_t frames = partitions[part];
      context.frames = {frames}; input.frames = {frames}; output.frames = {frames};
      expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)),
             "render envelope partition");
      samples->insert(samples->end(), outputSamples, outputSamples + frames);
    }
    expect(tail.tailDrainFrames == 4 && runner.fadingFrom == nullptr,
           "finite tail drains for its exact silent spill bound");
  };
  const uint32_t whole[]{6};
  const uint32_t partitioned[]{1, 2, 3};
  std::vector<float> wholeOutput, partitionedOutput;
  render(whole, 1, &wholeOutput);
  render(partitioned, 3, &partitionedOutput);
  const std::vector<float> expected{0.25f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
  expect(wholeOutput == expected && partitionedOutput == expected &&
         wholeOutput[1] == wholeOutput[2],
         "last fade sample and first spill sample are continuous and partition invariant");
}

void rejectedTransitionRetainsActiveGraph() {
  ProbeState activeProbe{};
  Builder activeGraph; activeGraph.input(1);
  activeGraph.nodes[activeGraph.nodeCount++] = {{2}, {9, 2}, 1,
      GraphNodeRole::Processor, 0, 1, 1,
      &activeGraph.mono, &activeGraph.mono,
      {&activeProbe, &probeFunctions}, {nullptr, 0, 1}};
  activeGraph.output(3); activeGraph.connect(1, 0, 2, 0);
  activeGraph.connect(2, 0, 3, 0);
  expect(succeeded(activeGraph.compile()), "compile transition-retention graph");
  Builder wrongRate; wrongRate.sampleRate = {44100.0}; wrongRate.input(1);
  wrongRate.builtin(4, BuiltinNodeKind::Gain, 1); wrongRate.output(3);
  wrongRate.connect(1, 0, 4, 0); wrongRate.connect(4, 0, 3, 0);
  expect(succeeded(wrongRate.compile()), "compile rejected-rate graph");
  RuntimeDiagnostics diagnostics{}; RetirementSlot slots[2]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slots, 2, &diagnostics);
  PublishedGraphSnapshot activeSnapshot{activeGraph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &activeSnapshot).status),
         "publish transition-retention graph");
  GraphRunner runner{};
  initializeGraphRunner(&runner, &publisher, {}, nullptr, nullptr, &diagnostics);
  float inputSample = 1.0f, outputSample = 0.0f;
  const float* inputChannels[]{&inputSample}; float* outputChannels[]{&outputSample};
  ConstAudioBusView input{inputChannels, 1, {1}, {1}, nullptr};
  MutableAudioBusView output{outputChannels, 1, {1}, {1}};
  ProcessContext context{kProcessContextInterfaceVersion, kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {1},
      nullptr, 0, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0}};
  expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
         activeProbe.processes == 1, "seed retained active graph");
  const uint32_t beforeEpoch = acknowledgedEpoch(runner);
  PublishedGraphSnapshot wrongRateSnapshot{wrongRate.graph, 2, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &wrongRateSnapshot).status),
         "submit incompatible rate snapshot for render-side defense");
  expect(!succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
         runner.active == &activeSnapshot && activeProbe.processes == 1 &&
         acknowledgedEpoch(runner) == beforeEpoch,
         "incompatible claimed snapshot leaves active state and epoch unchanged");
  PublishedGraphSnapshot* reclaimed[2]{};
  expect(reclaimSnapshots(&publisher, acknowledgedEpoch(runner), reclaimed, 2) == 1 &&
         reclaimed[0] == &wrongRateSnapshot,
         "rejected claimed snapshot is returned for off-RT final release");

  Builder compatible; compatible.input(1);
  compatible.builtin(5, BuiltinNodeKind::Gain, 1); compatible.output(3);
  compatible.connect(1, 0, 5, 0); compatible.connect(5, 0, 3, 0);
  expect(succeeded(compatible.compile()), "compile storage rejection graph");
  TransitionRequest request{TransitionKind::Crossfade, {2},
      InfiniteTailPolicy::Fade, 100, 100, 800, nullptr, nullptr, {0}};
  request.expectedOldGeneration = 1;
  request.replacementGeneration = 3;
  TransitionPlan plan{};
  expect(succeeded(prepareTransition(activeGraph.graph, compatible.graph,
                                     request, &plan)),
         "prepare compatible transition for capacity rejection");
  PublishedGraphSnapshot noStorage{compatible.graph, 3, plan, 0};
  expect(succeeded(submitSnapshot(&publisher, &noStorage).status),
         "submit transition without runner storage");
  expect(!succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
         runner.active == &activeSnapshot && activeProbe.processes == 1 &&
         acknowledgedEpoch(runner) == beforeEpoch,
         "transition storage rejection does not advance either graph");
  expect(reclaimSnapshots(&publisher, acknowledgedEpoch(runner), reclaimed, 2) == 1 &&
         reclaimed[0] == &noStorage,
         "capacity-rejected snapshot retires through bounded control path");

  Builder wrongTopology;
  wrongTopology.builtin(6, BuiltinNodeKind::Oscillator, 0, 100.0f, 0.1f);
  wrongTopology.output(7); wrongTopology.connect(6, 0, 7, 0);
  expect(succeeded(wrongTopology.compile()), "compile rejected topology graph");
  PublishedGraphSnapshot topologySnapshot{wrongTopology.graph, 4, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &topologySnapshot).status),
         "submit incompatible topology snapshot");
  expect(!succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
         runner.active == &activeSnapshot && activeProbe.processes == 1 &&
         acknowledgedEpoch(runner) == beforeEpoch,
         "external topology mismatch cannot replace the active graph");
  expect(reclaimSnapshots(&publisher, acknowledgedEpoch(runner), reclaimed, 2) == 1 &&
         reclaimed[0] == &topologySnapshot,
         "topology-rejected snapshot is released only off RT");
}

void exactTransitionBoundaryAndTailContext() {
  auto render = [](const uint32_t* partitions, uint32_t partitionCount,
                   std::vector<float>* rendered, uint32_t* drainedFrames) {
    TailProbeState tail{{TailKind::Finite, {4}}, 0, 0, 0, 0};
    Builder oldGraph; oldGraph.input(1);
    oldGraph.nodes[oldGraph.nodeCount++] = {{2}, {8, 2}, 1,
        GraphNodeRole::Processor, 0, 1, 1, &oldGraph.mono, &oldGraph.mono,
        {&tail, &tailProbeFunctions}, {nullptr, 0, 1}};
    oldGraph.output(3); oldGraph.connect(1, 0, 2, 0);
    oldGraph.connect(2, 0, 3, 0);
    expect(succeeded(oldGraph.compile()), "compile exact-boundary tail source");
    Builder replacement; replacement.input(1);
    replacement.builtin(4, BuiltinNodeKind::Gain, 1, 0.0f);
    replacement.output(3); replacement.connect(1, 0, 4, 0);
    replacement.connect(4, 0, 3, 0);
    expect(succeeded(replacement.compile()), "compile exact-boundary replacement");
    TransitionRequest request{TransitionKind::Crossfade, {3},
        InfiniteTailPolicy::Fade, 100, 100, 800, nullptr, nullptr, {4}};
    request.expectedOldGeneration = 1; request.replacementGeneration = 2;
    TransitionPlan plan{};
    expect(succeeded(prepareTransition(oldGraph.graph, replacement.graph,
                                       request, &plan)),
           "prepare non-divisible exact-boundary transition");
    RuntimeDiagnostics diagnostics{}; RetirementSlot slots[2]{};
    SnapshotPublisher publisher{};
    initializePublisher(&publisher, slots, 2, &diagnostics);
    PublishedGraphSnapshot oldSnapshot{oldGraph.graph, 1, hardCut(), 0};
    expect(succeeded(submitSnapshot(&publisher, &oldSnapshot).status),
           "publish exact-boundary source");
    float oldSamples[4]{}, silenceSamples[4]{}, inputSamples[5]{};
    float outputSamples[5]{}; float* oldChannels[]{oldSamples};
    const float* silenceChannels[1]{}; const float* inputChannels[]{inputSamples};
    float* outputChannels[]{outputSamples};
    GraphRunnerStorage storage{oldSamples, oldChannels, nullptr, nullptr,
        nullptr, 1, {4}, {0}, {0}, silenceSamples, silenceChannels, 1};
    ParameterQueue parameterQueue; MusicalEventQueue musicalQueue;
    GraphRunner runner{};
    initializeGraphRunner(&runner, &publisher, storage, &parameterQueue,
                          &musicalQueue,
                          &diagnostics);
    ConstAudioBusView input{inputChannels, 1, {1}, {5}, nullptr};
    MutableAudioBusView output{outputChannels, 1, {1}, {5}};
    TransportContext transport{};
    transport.stateFlags = TransportStatePlaying | TransportStateRecording;
    ProcessContext context{kProcessContextInterfaceVersion,
        kProcessContextV1RequiredSize,
        {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, &transport, {48000.0}, {1},
        nullptr, 0, nullptr, 0, {nullptr, 0},
        {DiscontinuityReason::None, 0}};
    inputSamples[0] = 1.0f;
    expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)),
           "seed exact-boundary finite tail");
    inputSamples[0] = 0.0f;
    PublishedGraphSnapshot next{replacement.graph, 2, plan, 0};
    expect(succeeded(submitSnapshot(&publisher, &next).status),
           "publish exact-boundary transition");
    rendered->clear();
    for (uint32_t part = 0; part < partitionCount; ++part) {
      const uint32_t frames = partitions[part];
      ParameterEvent parameter{{999}, {999}, {frames - 1}, 1.0f,
                               ParameterCurve::Step, {0}};
      MusicalEvent musical{{frames - 1}, MusicalEventKind::NoteOn, 0, 60, 1.0f};
      context.frames = {frames}; context.parameters = &parameter;
      context.parameterCount = 1; context.events = &musical;
      context.eventCount = 1; input.frames = {frames}; output.frames = {frames};
      expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)),
             "render exact-boundary transition partition");
      rendered->insert(rendered->end(), outputSamples, outputSamples + frames);
      if (partitionCount == 3 && part == 0) {
        const uint64_t beforeTransition = runner.transitionFrame;
        const uint64_t beforeTail = runner.tailFrame;
        const uint32_t beforeTailCalls = tail.tailDrainFrames;
        const uint32_t beforeEpoch = acknowledgedEpoch(runner);
        for (float& sample : outputSamples) sample = 9.0f;
        context.frames = {5}; input.frames = {5}; output.frames = {5};
        parameter.sampleOffset = {4}; musical.sampleOffset = {4};
        expect(enqueueParameter(&parameterQueue, parameter, &diagnostics) &&
               enqueueMusicalEvent(&musicalQueue, musical, &diagnostics),
               "enqueue before variable-block preflight rejection");
        expect(!succeeded(renderGraphBlock(&runner, context, &input, 1,
                                           &output, 1)) &&
               runner.transitionFrame == beforeTransition &&
               runner.tailFrame == beforeTail &&
               tail.tailDrainFrames == beforeTailCalls &&
               acknowledgedEpoch(runner) == beforeEpoch &&
               outputSamples[0] == 9.0f && outputSamples[4] == 9.0f,
               "variable block preflight rejects scratch shortage without mutation");
        ParameterEvent retainedParameter{}; MusicalEvent retainedMusical{};
        expect(parameterQueue.pop(&retainedParameter) &&
               musicalQueue.pop(&retainedMusical) &&
               retainedParameter.sampleOffset.value == 4 &&
               retainedMusical.sampleOffset.value == 4,
               "preflight rejection leaves queued control data untouched");
      }
    }
    expect(runner.fadingFrom == nullptr && tail.tailParameterEvents == 0 &&
           tail.tailMusicalEvents == 0 && tail.tailTransportStates == 0,
           "tail context suppresses events and running transport");
    *drainedFrames = tail.tailDrainFrames;
  };

  const uint32_t coarseParts[]{2, 4, 1};
  const uint32_t fineParts[]{1, 1, 1, 1, 1, 1, 1};
  std::vector<float> coarse, fine; uint32_t coarseDrain = 0, fineDrain = 0;
  render(coarseParts, 3, &coarse, &coarseDrain);
  render(fineParts, 7, &fine, &fineDrain);
  expect(coarse == fine && coarse.size() == 7 && coarseDrain == 4 &&
         fineDrain == 4 && coarse[3] == 0.0f && coarse[4] == 0.0f &&
         coarse[5] == 0.0f && coarse[6] == 0.0f,
         "mid-block endpoint and bounded tail are partition invariant");

  TailProbeState bypassedInfinite{{TailKind::Infinite, {0}}, 0, 0, 0, 0};
  Builder bypassed; bypassed.input(20);
  bypassed.nodes[bypassed.nodeCount++] = {{21}, {8, 21}, 1,
      GraphNodeRole::Processor, GraphNodeFlagBypassed, 1, 1,
      &bypassed.mono, &bypassed.mono,
      {&bypassedInfinite, &tailProbeFunctions}, {nullptr, 0, 1}};
  bypassed.output(22); bypassed.connect(20, 0, 21, 0);
  bypassed.connect(21, 0, 22, 0);
  expect(succeeded(bypassed.compile()) &&
         compiledGraphTail(*bypassed.graph).kind == TailKind::None,
         "bypass excludes intrinsic infinite tail while preserving its path");

  AudioBusDescriptor mono{1, SampleFormat::Float32Planar,
                          AudioChannelLayout::Mono, nullptr};
  BuiltinNodeConfig oscillatorConfig{BuiltinNodeKind::Oscillator, {30}, 0, 1, 0,
      480.0f, 1.0f, 0, OscillatorWaveform::Saw, nullptr, 0};
  std::vector<uint8_t> oscillatorState, oscillatorDurable;
  ProcessorHandle oscillator = preparedBuiltin(oscillatorConfig, nullptr, 0,
      mono, &oscillatorState, &oscillatorDurable);
  float oscillatorSample = 0.0f; float* oscillatorChannels[]{&oscillatorSample};
  MutableAudioBusView oscillatorOutput{oscillatorChannels, 1, {1}, {1}};
  ProcessContext oscillatorContext{kProcessContextInterfaceVersion,
      kProcessContextV2RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {1},
      nullptr, 0, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0},
      ProcessContextFlagNone};
  oscillator.functions->process(oscillator.state, &oscillatorContext, nullptr,
                                0, &oscillatorOutput, 1);
  oscillatorContext.flags = ProcessContextFlagTailDrain;
  oscillator.functions->process(oscillator.state, &oscillatorContext, nullptr,
                                0, &oscillatorOutput, 1);
  expect(oscillatorSample == 0.0f,
         "autonomous oscillator emits no new signal during tail drain");
  oscillatorContext.flags = ProcessContextFlagNone;
  oscillator.functions->process(oscillator.state, &oscillatorContext, nullptr,
                                0, &oscillatorOutput, 1);
  near(oscillatorSample, -0.98f, 0.00001f,
       "tail drain does not advance autonomous oscillator phase");
  expect(succeeded(deactivateProcessor(oscillator)) &&
         succeeded(destroyProcessor(&oscillator)),
         "tail-drain oscillator lifecycle");
}

void transitionPlanIdentityCoalescing() {
  ProbeState activeProbe{};
  Builder graphA; graphA.input(1);
  graphA.nodes[graphA.nodeCount++] = {{2}, {9, 2}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &graphA.mono, &graphA.mono,
      {&activeProbe, &probeFunctions}, {nullptr, 0, 1}};
  graphA.output(3); graphA.connect(1, 0, 2, 0); graphA.connect(2, 0, 3, 0);
  expect(succeeded(graphA.compile()), "compile identity graph A");
  Builder graphB; graphB.input(1);
  graphB.builtin(4, BuiltinNodeKind::DelayCompensation, 1, 0.0f, 0.0f, 2);
  graphB.output(3); graphB.connect(1, 0, 4, 0); graphB.connect(4, 0, 3, 0);
  expect(succeeded(graphB.compile()), "compile identity graph B");
  TailProbeState tailC{{TailKind::Finite, {5}}, 0, 0, 0, 0};
  Builder graphC; graphC.input(1);
  graphC.nodes[graphC.nodeCount++] = {{5}, {8, 5}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &graphC.mono, &graphC.mono,
      {&tailC, &tailProbeFunctions}, {nullptr, 0, 1}};
  graphC.output(3); graphC.connect(1, 0, 5, 0); graphC.connect(5, 0, 3, 0);
  expect(succeeded(graphC.compile()), "compile identity graph C");

  TransitionRequest abRequest{TransitionKind::Crossfade, {3},
      InfiniteTailPolicy::Fade, 100, 100, 800, nullptr, nullptr, {2}};
  abRequest.expectedOldGeneration = 1; abRequest.replacementGeneration = 2;
  TransitionPlan abPlan{};
  expect(succeeded(prepareTransition(graphA.graph, graphB.graph, abRequest,
                                     &abPlan)), "prepare exact A-to-B plan");
  TransitionRequest bcRequest{TransitionKind::Crossfade, {3},
      InfiniteTailPolicy::Fade, 100, 100, 800, nullptr, nullptr, {2}};
  bcRequest.expectedOldGeneration = 2; bcRequest.replacementGeneration = 3;
  TransitionPlan bcPlan{};
  expect(succeeded(prepareTransition(graphB.graph, graphC.graph, bcRequest,
                                     &bcPlan)) &&
         abPlan.oldAlignmentDelay.value == 2 &&
         bcPlan.newAlignmentDelay.value == 2 &&
         compiledGraphTail(*graphC.graph).frames.value == 5,
         "A/B/C plans retain distinct latency and tail identity");

  RuntimeDiagnostics diagnostics{}; RetirementSlot slots[2]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slots, 2,
                                                      &diagnostics);
  PublishedGraphSnapshot a{graphA.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &a).status), "publish graph A");
  GraphRunner runner{}; initializeGraphRunner(&runner, &publisher, {}, nullptr,
                                              nullptr, &diagnostics);
  float inputSample = 1.0f, outputSample = 0.0f;
  const float* inputChannels[]{&inputSample}; float* outputChannels[]{&outputSample};
  ConstAudioBusView input{inputChannels, 1, {1}, {1}, nullptr};
  MutableAudioBusView output{outputChannels, 1, {1}, {1}};
  ProcessContext context{kProcessContextInterfaceVersion,
      kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {1},
      nullptr, 0, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0}};
  expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)),
         "adopt graph A before coalescing");
  const uint32_t processes = activeProbe.processes;
  PublishedGraphSnapshot b{graphB.graph, 2, abPlan, 0};
  PublishedGraphSnapshot c{graphC.graph, 3, bcPlan, 0};
  expect(succeeded(submitSnapshot(&publisher, &b).status), "submit A-to-B");
  PublicationResult coalesced = submitSnapshot(&publisher, &c);
  expect(coalesced.superseded == &b,
         "latest pending C supersedes unobserved B off RT");
  expect(!succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
         runner.active == &a && activeProbe.processes == processes,
         "B-derived plan cannot be applied to active A and replacement C");
  PublishedGraphSnapshot* reclaimed[1]{};
  expect(reclaimSnapshots(&publisher, acknowledgedEpoch(runner), reclaimed, 1) == 1 &&
         reclaimed[0] == &c,
         "identity-rejected C returns through bounded off-RT reclamation");
}

void adoptionOwnershipNeverDisappears() {
  Builder oldGraph; oldGraph.input(1);
  oldGraph.builtin(2, BuiltinNodeKind::Gain, 1, 1.0f);
  oldGraph.output(3); oldGraph.connect(1, 0, 2, 0);
  oldGraph.connect(2, 0, 3, 0);
  expect(succeeded(oldGraph.compile()), "compile adoption ownership source");
  Builder replacement; replacement.input(1);
  replacement.builtin(4, BuiltinNodeKind::Gain, 1, 2.0f);
  replacement.output(3); replacement.connect(1, 0, 4, 0);
  replacement.connect(4, 0, 3, 0);
  expect(succeeded(replacement.compile()),
         "compile adoption ownership replacement");
  RuntimeDiagnostics diagnostics{}; RetirementSlot slots[2]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slots, 2,
                                                      &diagnostics);
  PublishedGraphSnapshot oldSnapshot{oldGraph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &oldSnapshot).status),
         "publish adoption ownership source");
  GraphRunner runner{}; initializeGraphRunner(&runner, &publisher, {}, nullptr,
                                              nullptr, &diagnostics);
  float inputSample = 1.0f, outputSample = 0.0f;
  const float* inputChannels[]{&inputSample}; float* outputChannels[]{&outputSample};
  ConstAudioBusView input{inputChannels, 1, {1}, {1}, nullptr};
  MutableAudioBusView output{outputChannels, 1, {1}, {1}};
  ProcessContext context{kProcessContextInterfaceVersion,
      kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {1},
      nullptr, 0, nullptr, 0, {nullptr, 0},
      {DiscontinuityReason::None, 0}};
  expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)),
         "adopt ownership source");
  TransitionPlan plan = hardCut();
  plan.expectedOldGraph = oldGraph.graph;
  plan.expectedReplacementGraph = replacement.graph;
  plan.expectedOldGeneration = 1;
  plan.replacementGeneration = 2;
  PublishedGraphSnapshot next{replacement.graph, 2, plan, 0};
  expect(succeeded(submitSnapshot(&publisher, &next).status),
         "publish ownership replacement");

  AdoptionTransferBarrier barrier{};
  setAdoptionTransferTestHook(&publisher, adoptionTransferBarrier, &barrier);
  Status rendered{};
  std::thread render([&] {
    rendered = renderGraphBlock(&runner, context, &input, 1, &output, 1);
  });
  const auto watchdog = std::chrono::steady_clock::now() +
                        std::chrono::seconds(5);
  for (uint32_t expectedStage = 1; expectedStage <= 3; ++expectedStage) {
    while (barrier.stage.load(std::memory_order_acquire) < expectedStage) {
      expect(std::chrono::steady_clock::now() < watchdog,
             "adoption ownership transfer barrier watchdog");
      std::this_thread::yield();
    }
    const PublicationResult alias = submitSnapshot(&publisher, &oldSnapshot);
    expect(!succeeded(alias.status) && alias.superseded == nullptr &&
           alias.deferred == 0,
           "old graph resubmission is rejected at every adoption stage");
    barrier.released.store(expectedStage, std::memory_order_release);
  }
  render.join();
  setAdoptionTransferTestHook(&publisher, nullptr, nullptr);
  PublishedGraphSnapshot* reclaimed[1]{};
  expect(succeeded(rendered) && runner.active == &next && outputSample == 2.0f &&
         reclaimSnapshots(&publisher, acknowledgedEpoch(runner), reclaimed, 1) == 1 &&
         reclaimed[0] == &oldSnapshot,
         "ownership transfer publishes replacement and retires old off RT once");
}

void rejectedOwnershipNeverDisappears() {
  Builder activeGraph;
  activeGraph.input(1);
  activeGraph.builtin(2, BuiltinNodeKind::Gain, 1, 1.0f);
  activeGraph.output(3);
  activeGraph.connect(1, 0, 2, 0);
  activeGraph.connect(2, 0, 3, 0);
  expect(succeeded(activeGraph.compile()),
         "compile rejected-ownership active graph");

  struct RejectedOwner {
    std::atomic<uint32_t>* destructions;
    Builder graph;
    PublishedGraphSnapshot snapshot{};
    explicit RejectedOwner(std::atomic<uint32_t>* count)
        : destructions(count) {
      graph.sampleRate = {44100.0};
      graph.input(1);
      graph.builtin(2, BuiltinNodeKind::Gain, 1, 2.0f);
      graph.output(3);
      graph.connect(1, 0, 2, 0);
      graph.connect(2, 0, 3, 0);
      expect(succeeded(graph.compile()),
             "compile dynamically owned incompatible rejection graph");
      snapshot = {graph.graph, 2, hardCut(), 0};
    }
    ~RejectedOwner() {
      destructions->fetch_add(1, std::memory_order_relaxed);
    }
  };

  RuntimeDiagnostics diagnostics{};
  RetirementSlot slots[2]{};
  SnapshotPublisher publisher{};
  initializePublisher(&publisher, slots, 2, &diagnostics);
  PublishedGraphSnapshot activeSnapshot{activeGraph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &activeSnapshot).status),
         "publish rejected-ownership active graph");
  GraphRunner runner{};
  initializeGraphRunner(&runner, &publisher, {}, nullptr, nullptr,
                        &diagnostics);
  float inputSample = 1.0f, outputSample = 0.0f;
  const float* inputChannels[]{&inputSample};
  float* outputChannels[]{&outputSample};
  ConstAudioBusView input{inputChannels, 1, {1}, {1}, nullptr};
  MutableAudioBusView output{outputChannels, 1, {1}, {1}};
  ProcessContext context{kProcessContextInterfaceVersion,
      kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {1},
      nullptr, 0, nullptr, 0, {nullptr, 0},
      {DiscontinuityReason::None, 0}};
  expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)),
         "adopt rejected-ownership active graph");

  std::atomic<uint32_t> destructions{0};
  RejectedOwner* owner = new RejectedOwner(&destructions);
  expect(succeeded(submitSnapshot(&publisher, &owner->snapshot).status),
         "publish dynamically owned incompatible rejection graph");
  const uint32_t slotIndex = owner->snapshot.reservedRetirementSlot;
  expect(slotIndex < 2, "rejected snapshot owns a bounded reservation");
  PublishedGraphSnapshot aliasSnapshot{owner->graph.graph, 3, hardCut(), 0};

  RejectionTransferBarrier barrier{};
  setRejectionTransferTestHook(&publisher, rejectionTransferBarrier, &barrier);
  Status rendered{};
  std::thread render([&] {
    rendered = renderGraphBlock(&runner, context, &input, 1, &output, 1);
  });
  const auto watchdog = std::chrono::steady_clock::now() +
                        std::chrono::seconds(5);
  PublishedGraphSnapshot* reclaimed[1]{};
  for (uint32_t expectedStage = 1; expectedStage <= 3; ++expectedStage) {
    while (barrier.stage.load(std::memory_order_acquire) < expectedStage) {
      expect(std::chrono::steady_clock::now() < watchdog,
             "rejection ownership transfer barrier watchdog");
      std::this_thread::yield();
    }
    RetirementSlot& slot = slots[slotIndex];
    const PublishedGraphSnapshot* claimed =
        publisher.claimedView.load(std::memory_order_acquire);
    const uint32_t state = slot.state.load(std::memory_order_acquire);
    const PublishedGraphSnapshot* reserved =
        slot.snapshot.load(std::memory_order_acquire);
    expect(reserved == &owner->snapshot &&
           state == static_cast<uint32_t>(
               expectedStage == 3 ? RetirementSlotState::Waiting
                                  : RetirementSlotState::Reserved) &&
           (expectedStage == 1 ? claimed == &owner->snapshot
                               : claimed == nullptr),
           "rejected snapshot is continuously visible in claimed or slot ownership");
    const PublicationResult alias = submitSnapshot(&publisher, &aliasSnapshot);
    expect(!succeeded(alias.status) && alias.superseded == nullptr &&
           alias.deferred == 0,
           "rejected graph alias is refused at every ownership handoff stage");
    const uint32_t count = reclaimSnapshots(
        &publisher, acknowledgedEpoch(runner), reclaimed, 1);
    if (expectedStage < 3) {
      expect(count == 0 && destructions.load(std::memory_order_relaxed) == 0,
             "Reserved rejection ownership is never reclaimable");
    } else {
      expect(count == 1 && reclaimed[0] == &owner->snapshot,
             "Waiting rejection ownership becomes reclaimable exactly once");
      delete owner;
      owner = nullptr;
      expect(destructions.load(std::memory_order_relaxed) == 1,
             "reclaimed rejected graph is destroyed only off RT");
    }
    barrier.released.store(expectedStage, std::memory_order_release);
  }
  render.join();
  setRejectionTransferTestHook(&publisher, nullptr, nullptr);
  expect(!succeeded(rendered) && runner.active == &activeSnapshot &&
         publisher.claimedView.load(std::memory_order_acquire) == nullptr &&
         slots[slotIndex].state.load(std::memory_order_acquire) ==
             static_cast<uint32_t>(RetirementSlotState::Free) &&
         slots[slotIndex].snapshot.load(std::memory_order_acquire) == nullptr &&
         destructions.load(std::memory_order_relaxed) == 1,
         "render returns after reclaimed destruction without stale ownership access");
  PublishedGraphSnapshot* extracted[1]{};
  uint32_t extractedCount = 0;
  expect(succeeded(shutdownGraphRunner(
             &runner, extracted, 1, &extractedCount)) &&
         extractedCount == 1 && extracted[0] == &activeSnapshot,
         "rejection race shutdown retains only the active snapshot");
}

void finalAuditContractsAndShutdown() {
  Builder first; first.input(1); first.builtin(2, BuiltinNodeKind::Gain, 1, 1.0f);
  first.output(3); first.connect(1, 0, 2, 0); first.connect(2, 0, 3, 0);
  expect(succeeded(first.compile()), "compile final-audit first graph");
  Builder delayed; delayed.input(1);
  delayed.builtin(4, BuiltinNodeKind::DelayCompensation, 1, 0.0f, 0.0f, 2);
  delayed.output(3); delayed.connect(1, 0, 4, 0); delayed.connect(4, 0, 3, 0);
  expect(succeeded(delayed.compile()), "compile final-audit delayed graph");
  Builder replacement; replacement.input(1);
  replacement.builtin(5, BuiltinNodeKind::DelayCompensation, 1, 0.0f, 0.0f, 2);
  replacement.output(3); replacement.connect(1, 0, 5, 0);
  replacement.connect(5, 0, 3, 0);
  expect(succeeded(replacement.compile()), "compile final-audit replacement");

  TransitionRequest hardRequest{TransitionKind::HardCut, {0},
      InfiniteTailPolicy::Cut, 0, 100, 1000, nullptr, nullptr, {0}};
  hardRequest.expectedOldGeneration = 1; hardRequest.replacementGeneration = 2;
  TransitionPlan hardPlan{};
  expect(succeeded(prepareTransition(first.graph, delayed.graph, hardRequest,
                                     &hardPlan)) &&
         hardPlan.oldAlignmentDelay.value == 0 &&
         hardPlan.newAlignmentDelay.value == 0,
         "hard cut ignores differing graph latency for emergency replacement");
  expect(!succeeded(prepareTransition(first.graph, first.graph, hardRequest,
                                      &hardPlan)),
         "transition rejects identical replaced and replacement graph");
  TransitionRequest invalidPolicy = hardRequest;
  invalidPolicy.infiniteTailPolicy = static_cast<InfiniteTailPolicy>(99);
  expect(!succeeded(prepareTransition(first.graph, delayed.graph,
                                      invalidPolicy, &hardPlan)),
         "transition request validates infinite-tail policy enum domain");
  expect(succeeded(prepareTransition(first.graph, delayed.graph, hardRequest,
                                     &hardPlan)), "restore hard-cut plan");

  RuntimeDiagnostics diagnostics{}; RetirementSlot slots[4]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slots, 4,
                                                      &diagnostics);
  PublishedGraphSnapshot zero{first.graph, 0, hardCut(), 0};
  expect(!succeeded(submitSnapshot(&publisher, &zero).status) &&
         publisher.pending.load() == nullptr,
         "generation zero is an unpublished sentinel and cannot bootstrap");
  PublishedGraphSnapshot invalidEnum{first.graph, 1, hardCut(), 0};
  invalidEnum.transition.infiniteTailPolicy = static_cast<InfiniteTailPolicy>(99);
  expect(!succeeded(submitSnapshot(&publisher, &invalidEnum).status) &&
         publisher.pending.load() == nullptr,
         "invalid infinite-tail policy publication is non-mutating");
  PublishedGraphSnapshot one{first.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &one).status),
         "generation one bootstraps publication");
  PublishedGraphSnapshot samePending{first.graph, 9, hardCut(), 0};
  expect(!succeeded(submitSnapshot(&publisher, &one).status) &&
         !succeeded(submitSnapshot(&publisher, &samePending).status),
         "duplicate snapshot and compiled graph cannot be pending twice");

  float inputSample = 1.0f, outputSample = 0.0f, oldSample = 0.0f;
  float silenceSample = 0.0f;
  const float* inputChannels[]{&inputSample}; float* outputChannels[]{&outputSample};
  float* oldChannels[]{&oldSample};
  const float* silenceChannels[]{&silenceSample};
  ConstAudioBusView input{inputChannels, 1, {1}, {1}, nullptr};
  MutableAudioBusView output{outputChannels, 1, {1}, {1}};
  GraphRunnerStorage storage{&oldSample, oldChannels, nullptr, nullptr, nullptr,
                             1, {1}, {0}, {0}, &silenceSample,
                             silenceChannels, 1};
  GraphRunner runner{}; initializeGraphRunner(&runner, &publisher, storage,
                                              nullptr, nullptr, &diagnostics);
  ProcessContext context{kProcessContextInterfaceVersion,
      kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {1},
      nullptr, 0, nullptr, 0, {nullptr, 0},
      {DiscontinuityReason::None, 0}};
  expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
         runner.active == &one,
         "generation one becomes active");
  expect(!succeeded(submitSnapshot(&publisher, &one).status) &&
         !succeeded(submitSnapshot(&publisher, &samePending).status),
         "active snapshot and active compiled graph reject resubmission");
  PublishedGraphSnapshot two{delayed.graph, 2, hardPlan, 0};
  expect(succeeded(submitSnapshot(&publisher, &two).status) &&
         succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
         runner.active == &two,
         "generation one to two differing-latency hard cut succeeds");

  TransitionRequest fadeRequest{TransitionKind::Crossfade, {4},
      InfiniteTailPolicy::Fade, 100, 100, 800, nullptr, nullptr, {2}};
  fadeRequest.expectedOldGeneration = 2; fadeRequest.replacementGeneration = 3;
  TransitionPlan fadePlan{};
  expect(succeeded(prepareTransition(delayed.graph, replacement.graph,
                                     fadeRequest, &fadePlan)),
         "prepare final-audit active transition");
  PublishedGraphSnapshot three{replacement.graph, 3, fadePlan, 0};
  const PublicationResult submittedThree = submitSnapshot(&publisher, &three);
  const Status renderedThree = succeeded(submittedThree.status)
      ? renderGraphBlock(&runner, context, &input, 1, &output, 1)
      : submittedThree.status;
  expect(succeeded(submittedThree.status) && succeeded(renderedThree) &&
         runner.fadingFrom == &two,
         "start final-audit active transition");
  PublishedGraphSnapshot sameFading{delayed.graph, 10, hardCut(), 0};
  expect(!succeeded(submitSnapshot(&publisher, &sameFading).status),
         "fading compiled graph cannot be republished");
  const float* nullLane[]{nullptr};
  ConstAudioBusView malformed{nullLane, 1, {1}, {1}, nullptr};
  const uint64_t beforeTransition = runner.transitionFrame;
  const uint32_t beforeEpoch = acknowledgedEpoch(runner);
  outputSample = 9.0f;
  expect(!succeeded(renderGraphBlock(&runner, context, &malformed, 1,
                                     &output, 1)) &&
         runner.transitionFrame == beforeTransition &&
         acknowledgedEpoch(runner) == beforeEpoch && outputSample == 9.0f,
         "null external channel lane rejects before active transition mutation");

  ProcessContext discontinuity = context; discontinuity.frames = {0};
  input.frames = {0}; output.frames = {0};
  discontinuity.time.flags = RenderTimeDiscontinuous;
  discontinuity.discontinuity = {DiscontinuityReason::SourceSeek,
                                 DiscontinuityFlagResetState};
  expect(succeeded(renderGraphBlock(&runner, discontinuity, &input, 1,
                                    &output, 1)) &&
         runner.fadingFrom == nullptr && runner.transitionFrame == 0 &&
         runner.tailFrame == 0,
         "typed discontinuity cancels fade/tail at the exact boundary");

  PublishedGraphSnapshot* extracted[4]{}; uint32_t extractedCount = 0;
  expect(!succeeded(shutdownGraphRunner(&runner, extracted, 1,
                                        &extractedCount)) &&
         runner.active == &three,
         "shutdown capacity failure is non-mutating");
  expect(succeeded(shutdownGraphRunner(&runner, extracted, 4,
                                       &extractedCount)) &&
         extractedCount == 3 && runner.active == nullptr &&
         publisher.pending.load() == nullptr && publisher.deferred == nullptr,
         "shutdown atomically extracts active and retired ownership");
  context.frames = {1}; input.frames = {1}; output.frames = {1};
  expect(renderGraphBlock(&runner, context, &input, 1, &output, 1).code ==
             StatusCode::Busy,
         "quiesced runner cannot re-enter rendering");
  expect(submitSnapshot(&publisher, &one).status.code == StatusCode::Busy &&
         publisher.pending.load() == nullptr,
         "quiescent shutdown permanently closes snapshot publication");

  uint8_t arenaBytes[512]{}; RealtimeArena arena{};
  expect(succeeded(initializeArena(&arena, {arenaBytes, sizeof(arenaBytes)})),
         "initialize early-failure cleanup arena");
  GraphDescription invalid{}; GraphCompileResult failed{};
  GraphCompileError compileError{};
  expect(!succeeded(compileGraph(invalid, &arena, &failed, &compileError)),
         "produce early compile failure");
  void* marker = arenaAllocate(&arena, 32, 8); const size_t used = arena.used;
  expect(marker != nullptr && succeeded(cleanupFailedCompile(&failed)) &&
         arena.used == used,
         "cleanup after rewound early failure cannot rewind later allocations");
}

void discontinuitiesCancelFadeAndTail() {
  struct Scenario { DiscontinuityReason reason; bool enterTail; };
  const Scenario scenarios[]{
      {DiscontinuityReason::SourceSeek, false},
      {DiscontinuityReason::RouteGenerationChanged, true},
      {DiscontinuityReason::DeviceLost, true},
      {DiscontinuityReason::SourceFrameOverflow, true}};
  for (const Scenario scenario : scenarios) {
    TailProbeState oldTail{{TailKind::Finite, {4}}, 0, 0, 0, 0};
    Builder oldGraph; oldGraph.input(1);
    oldGraph.nodes[oldGraph.nodeCount++] = {{2}, {8, 2}, 1,
        GraphNodeRole::Processor, 0, 1, 1, &oldGraph.mono, &oldGraph.mono,
        {&oldTail, &tailProbeFunctions}, {nullptr, 0, 1}};
    oldGraph.output(3); oldGraph.connect(1, 0, 2, 0);
    oldGraph.connect(2, 0, 3, 0);
    expect(succeeded(oldGraph.compile()), "compile discontinuity tail source");
    Builder replacement; replacement.input(1);
    replacement.builtin(4, BuiltinNodeKind::Gain, 1, 1.0f);
    replacement.output(3); replacement.connect(1, 0, 4, 0);
    replacement.connect(4, 0, 3, 0);
    expect(succeeded(replacement.compile()), "compile discontinuity replacement");
    Builder later; later.input(1);
    later.builtin(5, BuiltinNodeKind::DelayCompensation, 1, 0.0f, 0.0f, 2);
    later.output(3); later.connect(1, 0, 5, 0); later.connect(5, 0, 3, 0);
    expect(succeeded(later.compile()), "compile post-discontinuity transition");

    TransitionRequest request{TransitionKind::Crossfade, {2},
        InfiniteTailPolicy::Fade, 100, 100, 800, nullptr, nullptr, {4}};
    request.expectedOldGeneration = 1; request.replacementGeneration = 2;
    TransitionPlan plan{};
    expect(succeeded(prepareTransition(oldGraph.graph, replacement.graph,
                                       request, &plan)),
           "prepare discontinuity transition");
    RuntimeDiagnostics diagnostics{}; RetirementSlot slots[3]{};
    SnapshotPublisher publisher{}; initializePublisher(&publisher, slots, 3,
                                                        &diagnostics);
    PublishedGraphSnapshot oldSnapshot{oldGraph.graph, 1, hardCut(), 0};
    expect(succeeded(submitSnapshot(&publisher, &oldSnapshot).status),
           "publish discontinuity source");
    float inputSamples[4]{1.0f}, outputSamples[4]{}, oldSamples[4]{};
    float oldAlign[4]{}, newAlign[4]{}, history[4]{};
    float silence[4]{};
    const float* inputChannels[]{inputSamples}; float* outputChannels[]{outputSamples};
    float* oldChannels[]{oldSamples}; const float* silenceChannels[]{silence};
    ConstAudioBusView input{inputChannels, 1, {1}, {4}, nullptr};
    MutableAudioBusView output{outputChannels, 1, {1}, {4}};
    GraphRunnerStorage storage{oldSamples, oldChannels, oldAlign, newAlign,
        history, 1, {4}, {4}, {4}, silence, silenceChannels, 1};
    GraphRunner runner{}; initializeGraphRunner(&runner, &publisher, storage,
                                                nullptr, nullptr, &diagnostics);
    ProcessContext context{kProcessContextInterfaceVersion,
        kProcessContextV1RequiredSize,
        {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {1},
        nullptr, 0, nullptr, 0, {nullptr, 0},
        {DiscontinuityReason::None, 0}};
    expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)),
           "seed pre-discontinuity audio");
    inputSamples[0] = 0.0f;
    PublishedGraphSnapshot replacementSnapshot{replacement.graph, 2, plan, 0};
    expect(succeeded(submitSnapshot(&publisher, &replacementSnapshot).status),
           "publish transition before discontinuity");
    context.frames = {scenario.enterTail ? 3u : 1u};
    input.frames = context.frames; output.frames = context.frames;
    expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
           runner.fadingFrom == &oldSnapshot &&
           (!scenario.enterTail || runner.tailFrame != 0),
           "enter requested fade/tail state before discontinuity");
    context.frames = {0}; input.frames = {0}; output.frames = {0};
    context.time.flags = RenderTimeDiscontinuous;
    context.discontinuity = {scenario.reason, DiscontinuityFlagResetState};
    expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
           runner.fadingFrom == nullptr && runner.transitionFrame == 0 &&
           runner.tailFrame == 0 && history[0] == 0.0f && history[1] == 0.0f &&
           oldAlign[0] == 0.0f && newAlign[0] == 0.0f,
           "typed seek/route/device discontinuity clears transition history");
    PublishedGraphSnapshot* reclaimed[1]{};
    expect(reclaimSnapshots(&publisher, acknowledgedEpoch(runner), reclaimed,
                            1) == 1 && reclaimed[0] == &oldSnapshot,
           "discontinuity-retired old graph reaches off-RT reclamation");

    TransitionRequest laterRequest{TransitionKind::Crossfade, {2},
        InfiniteTailPolicy::Fade, 100, 100, 800, nullptr, nullptr, {2}};
    laterRequest.expectedOldGeneration = 2; laterRequest.replacementGeneration = 3;
    TransitionPlan laterPlan{};
    expect(succeeded(prepareTransition(replacement.graph, later.graph,
                                       laterRequest, &laterPlan)),
           "prepare transition after discontinuity");
    PublishedGraphSnapshot laterSnapshot{later.graph, 3, laterPlan, 0};
    expect(succeeded(submitSnapshot(&publisher, &laterSnapshot).status),
           "publish transition after discontinuity");
    inputSamples[0] = 1.0f; context.frames = {1}; input.frames = {1};
    output.frames = {1}; context.time.flags = RenderTimeNone;
    context.discontinuity = {DiscontinuityReason::None, 0};
    expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
           outputSamples[0] == 0.0f,
           "later transition cannot seed alignment from pre-discontinuity audio");
    PublishedGraphSnapshot* extracted[3]{}; uint32_t count = 0;
    expect(succeeded(shutdownGraphRunner(&runner, extracted, 3, &count)),
           "shutdown discontinuity scenario");
  }
}

void shutdownBusyAndCallbackGuard() {
  BlockingProbeState blocking{};
  Builder graph; graph.input(1);
  graph.nodes[graph.nodeCount++] = {{2}, {9, 2}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &graph.mono, &graph.mono,
      {&blocking, &blockingProbeFunctions}, {nullptr, 0, 1}};
  graph.output(3); graph.connect(1, 0, 2, 0); graph.connect(2, 0, 3, 0);
  expect(succeeded(graph.compile()), "compile blocking shutdown graph");
  RuntimeDiagnostics diagnostics{}; RetirementSlot slot[1]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slot, 1,
                                                      &diagnostics);
  PublishedGraphSnapshot snapshot{graph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &snapshot).status),
         "publish blocking shutdown graph");
  GraphRunner runner{}; initializeGraphRunner(&runner, &publisher, {}, nullptr,
                                              nullptr, &diagnostics);
  float inputSample = 1.0f, outputSample = 0.0f;
  const float* inputChannels[]{&inputSample}; float* outputChannels[]{&outputSample};
  ConstAudioBusView input{inputChannels, 1, {1}, {1}, nullptr};
  MutableAudioBusView output{outputChannels, 1, {1}, {1}};
  ProcessContext context{kProcessContextInterfaceVersion,
      kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {1},
      nullptr, 0, nullptr, 0, {nullptr, 0},
      {DiscontinuityReason::None, 0}};
  Status rendered{};
  std::thread render([&] {
    rendered = renderGraphBlock(&runner, context, &input, 1, &output, 1);
  });
  while (!blocking.entered.load(std::memory_order_acquire))
    std::this_thread::yield();
  PublishedGraphSnapshot* extracted[1]{}; uint32_t count = 0;
  expect(shutdownGraphRunner(&runner, extracted, 1, &count).code ==
             StatusCode::Busy && runner.active == &snapshot,
         "shutdown returns Busy without mutation while render is in flight");
  blocking.release.store(true, std::memory_order_release);
  render.join();
  expect(succeeded(rendered) && blocking.callbackDomainSeen,
         "callback-domain guard is visible to project-owned synchronization");
  expect(succeeded(shutdownGraphRunner(&runner, extracted, 1, &count)) &&
         count == 1 && extracted[0] == &snapshot,
         "shutdown succeeds after renderer quiescence");
}

void boundedAndNonDestructiveQueueDrains() {
  BlockingProbeState blocking{};
  Builder blockingGraph; blockingGraph.input(1);
  blockingGraph.nodes[blockingGraph.nodeCount++] = {{2}, {9, 2}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &blockingGraph.mono,
      &blockingGraph.mono, {&blocking, &blockingProbeFunctions},
      {nullptr, 0, 1}};
  blockingGraph.output(3); blockingGraph.connect(1, 0, 2, 0);
  blockingGraph.connect(2, 0, 3, 0);
  expect(succeeded(blockingGraph.compile()),
         "compile bounded queue drain graph");
  ParameterQueue parameters; MusicalEventQueue musical;
  ParameterEvent initialParameter{{2}, {1}, {0}, 0.5f,
                                  ParameterCurve::Step, {0}};
  MusicalEvent initialMusical{{0}, MusicalEventKind::AllNotesOff, 0, 1, 0.0f};
  for (uint32_t index = 0; index < kRuntimeEventQueueCapacity - 1; ++index) {
    expect(parameters.push(initialParameter) && musical.push(initialMusical),
           "fill queues to their captured block-entry boundary");
  }
  expect(parameters.snapshotAvailable() == kRuntimeEventQueueCapacity - 1 &&
         musical.snapshotAvailable() == kRuntimeEventQueueCapacity - 1,
         "queue snapshot is bounded to capacity minus one");
  ParameterEvent laterParameter{{2}, {999}, {0}, 9.0f,
                                ParameterCurve::Step, {0}};
  MusicalEvent laterMusical{{0}, MusicalEventKind::NoteOn, 0, 127, 1.0f};
  constexpr uint32_t replenishmentCount = 64;
  std::atomic<bool> producerDone{false};
  std::thread producer([&] {
    for (uint32_t index = 0; index < replenishmentCount; ++index)
      while (!parameters.push(laterParameter)) std::this_thread::yield();
    for (uint32_t index = 0; index < replenishmentCount; ++index)
      while (!musical.push(laterMusical)) std::this_thread::yield();
    producerDone.store(true, std::memory_order_release);
  });

  RuntimeDiagnostics diagnostics{}; RetirementSlot slot[1]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slot, 1,
                                                      &diagnostics);
  PublishedGraphSnapshot snapshot{blockingGraph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &snapshot).status),
         "publish bounded queue drain graph");
  GraphRunner runner{}; initializeGraphRunner(&runner, &publisher, {},
                                              &parameters, &musical,
                                              &diagnostics);
  float inputSample = 1.0f, outputSample = 0.0f;
  const float* inputChannels[]{&inputSample}; float* outputChannels[]{&outputSample};
  ConstAudioBusView input{inputChannels, 1, {1}, {1}, nullptr};
  MutableAudioBusView output{outputChannels, 1, {1}, {1}};
  ProcessContext context{kProcessContextInterfaceVersion,
      kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {1},
      nullptr, 0, nullptr, 0, {nullptr, 0},
      {DiscontinuityReason::None, 0}};
  Status rendered{};
  std::thread renderer([&] {
    rendered = renderGraphBlock(&runner, context, &input, 1, &output, 1);
  });
  const auto watchdog = std::chrono::steady_clock::now() +
                        std::chrono::seconds(5);
  while (!blocking.entered.load(std::memory_order_acquire) ||
         !producerDone.load(std::memory_order_acquire)) {
    expect(std::chrono::steady_clock::now() < watchdog,
           "bounded replenishment barrier watchdog");
    std::this_thread::yield();
  }
  blocking.release.store(true, std::memory_order_release);
  renderer.join(); producer.join();
  ParameterEvent retainedParameter{}; MusicalEvent retainedMusical{};
  expect(succeeded(rendered) && blocking.parameterCount <= kMaximumEventsPerBlock &&
         blocking.eventCount <= kMaximumEventsPerBlock &&
         parameters.snapshotAvailable() == replenishmentCount &&
         musical.snapshotAvailable() == replenishmentCount &&
         parameters.pop(&retainedParameter) && musical.pop(&retainedMusical) &&
         retainedParameter.parameter.value == 999 &&
         retainedMusical.kind == MusicalEventKind::NoteOn &&
         retainedMusical.key == 127,
         "callback consumes only captured entries and leaves replenishment for next block");
  expect(parameters.push(retainedParameter) && musical.push(retainedMusical) &&
         succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
         blocking.parameterCount == replenishmentCount &&
         blocking.eventCount == replenishmentCount &&
         parameters.snapshotAvailable() == 0 && musical.snapshotAvailable() == 0,
         "next callback consumes the producer writes left beyond the prior snapshot");

  ParameterQueue emptyParameters; MusicalEventQueue emptyMusical;
  expect(emptyParameters.push(laterParameter) && emptyMusical.push(laterMusical),
         "seed empty-runner queue sentinels");
  SnapshotPublisher emptyPublisher{}; RetirementSlot emptySlot[1]{};
  initializePublisher(&emptyPublisher, emptySlot, 1, &diagnostics);
  GraphRunner emptyRunner{}; initializeGraphRunner(&emptyRunner, &emptyPublisher,
      {}, &emptyParameters, &emptyMusical, &diagnostics);
  expect(!succeeded(renderGraphBlock(&emptyRunner, context, nullptr, 0,
                                     nullptr, 0)) &&
         emptyParameters.snapshotAvailable() == 1 &&
         emptyMusical.snapshotAvailable() == 1,
         "empty runner rejects without touching queues");

  EventProbeState tailProbe{};
  Builder tailGraph; tailGraph.input(10);
  tailGraph.nodes[tailGraph.nodeCount++] = {{11}, {9, 11}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &tailGraph.mono, &tailGraph.mono,
      {&tailProbe, &eventProbeFunctions}, {nullptr, 0, 1}};
  tailGraph.output(12); tailGraph.connect(10, 0, 11, 0);
  tailGraph.connect(11, 0, 12, 0);
  expect(succeeded(tailGraph.compile()), "compile external tail-drain graph");
  ParameterQueue tailParameters; MusicalEventQueue tailMusical;
  ParameterEvent tailParameter{{11}, {999}, {0}, 9.0f,
                               ParameterCurve::Step, {0}};
  expect(tailParameters.push(tailParameter) && tailMusical.push(laterMusical),
         "seed external tail-drain sentinels");
  SnapshotPublisher tailPublisher{}; RetirementSlot tailSlot[1]{};
  initializePublisher(&tailPublisher, tailSlot, 1, &diagnostics);
  PublishedGraphSnapshot tailSnapshot{tailGraph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&tailPublisher, &tailSnapshot).status),
         "publish external tail-drain graph");
  GraphRunner tailRunner{}; initializeGraphRunner(&tailRunner, &tailPublisher,
      {}, &tailParameters, &tailMusical, &diagnostics);
  ProcessContext tailContext = context;
  tailContext.structSize = kProcessContextV2RequiredSize;
  tailContext.flags = ProcessContextFlagTailDrain;
  expect(succeeded(renderGraphBlock(&tailRunner, tailContext, &input, 1,
                                    &output, 1)) &&
         tailProbe.parameterCount == 0 && tailProbe.eventCount == 0 &&
         tailParameters.snapshotAvailable() == 1 &&
         tailMusical.snapshotAvailable() == 1,
         "external tail drain renders empty events and preserves both queues");
  tailContext.flags = ProcessContextFlagNone;
  expect(succeeded(renderGraphBlock(&tailRunner, tailContext, &input, 1,
                                    &output, 1)) &&
         tailProbe.parameterCount == 1 && tailProbe.eventCount == 1 &&
         tailParameters.snapshotAvailable() == 0 &&
         tailMusical.snapshotAvailable() == 0,
         "next normal block receives events preserved by external tail drain");
  expect(tailParameters.push(tailParameter) && tailMusical.push(laterMusical),
         "seed invalid-context sentinels");
  ProcessContext invalidContext = tailContext;
  invalidContext.flags = 1u << 31;
  expect(!succeeded(renderGraphBlock(&tailRunner, invalidContext, &input, 1,
                                     &output, 1)) &&
         tailParameters.snapshotAvailable() == 1 &&
         tailMusical.snapshotAvailable() == 1,
         "invalid input context is rejected before queue access");

  ParameterQueue rejectedParameters; MusicalEventQueue rejectedMusical;
  expect(rejectedParameters.push(laterParameter) &&
         rejectedMusical.push(laterMusical), "seed rejected-claim sentinels");
  SnapshotPublisher rejectedPublisher{}; RetirementSlot rejectedSlot[1]{};
  initializePublisher(&rejectedPublisher, rejectedSlot, 1, &diagnostics);
  PublishedGraphSnapshot rejectedSnapshot{tailGraph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&rejectedPublisher, &rejectedSnapshot).status),
         "publish incompatible claimed graph");
  GraphRunner rejectedRunner{}; initializeGraphRunner(&rejectedRunner,
      &rejectedPublisher, {}, &rejectedParameters, &rejectedMusical,
      &diagnostics);
  ProcessContext incompatible = context; incompatible.sampleRate = {44100.0};
  expect(!succeeded(renderGraphBlock(&rejectedRunner, incompatible, &input, 1,
                                     &output, 1)) &&
         rejectedRunner.active == nullptr &&
         rejectedParameters.snapshotAvailable() == 1 &&
         rejectedMusical.snapshotAvailable() == 1,
         "incompatible claimed graph is rejected without draining queues");
}

void queuesContainmentAndAllocationTrap() {
  ParameterQueue queue;
  RuntimeDiagnostics queueDiagnostics{};
  ParameterEvent event{{1}, {1}, {0}, 0.5f, ParameterCurve::Step, {0}};
  uint32_t accepted = 0;
  while (enqueueParameter(&queue, event, &queueDiagnostics)) ++accepted;
  expect(accepted == kRuntimeEventQueueCapacity - 1 &&
         queueDiagnostics.parameterOverflows.load() == 1,
         "parameter queue overflow is bounded");

  Builder queuedGain;
  queuedGain.input(40);
  queuedGain.builtin(41, BuiltinNodeKind::Gain, 1, 0.0f);
  queuedGain.output(42); queuedGain.connect(40, 0, 41, 0);
  queuedGain.connect(41, 0, 42, 0);
  expect(succeeded(queuedGain.compile()), "compile queued automation graph");
  ParameterQueue latestQueue;
  RuntimeDiagnostics latestDiagnostics{};
  for (uint32_t index = 0; index < kRuntimeEventQueueCapacity - 1; ++index) {
    ParameterEvent latest{{41}, kGainParameter, {0},
        static_cast<float>(index), ParameterCurve::Step, {0}};
    expect(enqueueParameter(&latestQueue, latest, &latestDiagnostics),
           "fill accepted parameter queue");
  }
  RetirementSlot latestSlot[1]{}; SnapshotPublisher latestPublisher{};
  initializePublisher(&latestPublisher, latestSlot, 1, &latestDiagnostics);
  PublishedGraphSnapshot latestSnapshot{queuedGain.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&latestPublisher, &latestSnapshot).status),
         "publish queued automation graph");
  GraphRunner latestRunner{};
  initializeGraphRunner(&latestRunner, &latestPublisher, {}, &latestQueue,
                        nullptr, &latestDiagnostics);
  float queuedInputSamples[4]{1, 1, 1, 1}; float queuedOutputSamples[4]{};
  const float* queuedInChannels[]{queuedInputSamples};
  float* queuedOutChannels[]{queuedOutputSamples};
  ConstAudioBusView queuedInput{queuedInChannels, 1, {1}, {4}, nullptr};
  MutableAudioBusView queuedOutput{queuedOutChannels, 1, {1}, {4}};
  ProcessContext queuedContext{kProcessContextInterfaceVersion,
      kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {1},
      nullptr, 0, nullptr, 0, {nullptr, 0},
      {DiscontinuityReason::None, 0}};
  expect(succeeded(renderGraphBlock(&latestRunner, queuedContext, &queuedInput,
                                    1, &queuedOutput, 1)) &&
         queuedOutputSamples[0] ==
             static_cast<float>(kRuntimeEventQueueCapacity - 2) &&
         latestDiagnostics.parameterOverflows.load() != 0,
         "overflow coalescing preserves the newest accepted parameter state");
  ParameterEvent unsorted[]{
      {{41}, kGainParameter, {3}, 0.3f, ParameterCurve::Step, {0}},
      {{41}, kGainParameter, {0}, 0.1f, ParameterCurve::Step, {0}},
      {{41}, kGainParameter, {2}, 0.2f, ParameterCurve::Step, {0}}};
  for (const ParameterEvent& item : unsorted)
    expect(enqueueParameter(&latestQueue, item, &latestDiagnostics),
           "enqueue unsorted parameter event");
  queuedContext.frames = {4}; queuedInput.frames = {4}; queuedOutput.frames = {4};
  expect(succeeded(renderGraphBlock(&latestRunner, queuedContext, &queuedInput,
                                    1, &queuedOutput, 1)) &&
         queuedOutputSamples[0] == 0.1f && queuedOutputSamples[1] == 0.1f &&
         queuedOutputSamples[2] == 0.2f && queuedOutputSamples[3] == 0.3f,
         "queued unsorted offsets are processed robustly in sample order");

  EventProbeState eventProbe{};
  Builder eventGraph; eventGraph.input(80);
  eventGraph.nodes[eventGraph.nodeCount++] = {{81}, {9, 81}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &eventGraph.mono, &eventGraph.mono,
      {&eventProbe, &eventProbeFunctions}, {nullptr, 0, 1}};
  eventGraph.output(82); eventGraph.connect(80, 0, 81, 0);
  eventGraph.connect(81, 0, 82, 0);
  expect(succeeded(eventGraph.compile()), "compile overload-order event probe");
  ParameterQueue recencyQueue; MusicalEventQueue musicalQueue;
  RuntimeDiagnostics eventDiagnostics{};
  for (uint32_t key = 1; key <= kMaximumEventsPerBlock; ++key) {
    ParameterEvent keyed{{81}, {key}, {0}, static_cast<float>(key),
                         ParameterCurve::Step, {0}};
    expect(enqueueParameter(&recencyQueue, keyed, &eventDiagnostics),
           "fill distinct parameter state keys");
  }
  ParameterEvent refresh{{81}, {1}, {0}, 999.0f, ParameterCurve::Step, {0}};
  ParameterEvent newestKey{{81}, {257}, {0}, 257.0f,
                           ParameterCurve::Step, {0}};
  expect(enqueueParameter(&recencyQueue, refresh, &eventDiagnostics) &&
         enqueueParameter(&recencyQueue, newestKey, &eventDiagnostics),
         "enqueue refreshed and newest parameter keys");
  for (uint32_t ordinal = 0; ordinal < 300; ++ordinal) {
    MusicalEvent item{{0}, MusicalEventKind::AllNotesOff, 0,
                      static_cast<uint16_t>(ordinal % 128), 0.0f};
    if (ordinal == 298) item = {{0}, MusicalEventKind::NoteOn, 0, 64, 1.0f};
    if (ordinal == 299) item = {{0}, MusicalEventKind::NoteOff, 0, 64, 0.0f};
    expect(enqueueMusicalEvent(&musicalQueue, item, &eventDiagnostics),
           "fill saturated musical event queue");
  }
  RetirementSlot eventSlots[1]{}; SnapshotPublisher eventPublisher{};
  initializePublisher(&eventPublisher, eventSlots, 1, &eventDiagnostics);
  PublishedGraphSnapshot eventSnapshot{eventGraph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&eventPublisher, &eventSnapshot).status),
         "publish overload-order event probe");
  GraphRunner eventRunner{};
  initializeGraphRunner(&eventRunner, &eventPublisher, {}, &recencyQueue,
                        &musicalQueue, &eventDiagnostics);
  queuedContext.frames = {1}; queuedInput.frames = {1}; queuedOutput.frames = {1};
  expect(succeeded(renderGraphBlock(&eventRunner, queuedContext, &queuedInput,
                                    1, &queuedOutput, 1)),
         "render saturated event queues");
  bool sawRefreshed = false, sawEvicted = false, sawNewest = false;
  for (uint32_t index = 0; index < eventProbe.parameterCount; ++index) {
    const ParameterEvent& retained = eventProbe.parameters[index];
    if (retained.parameter.value == 1 && retained.value == 999.0f)
      sawRefreshed = true;
    if (retained.parameter.value == 2) sawEvicted = true;
    if (retained.parameter.value == 257) sawNewest = true;
  }
  expect(eventProbe.parameterCount == kMaximumEventsPerBlock && sawRefreshed &&
         !sawEvicted && sawNewest,
         "parameter refresh updates age and evicts the truly oldest key");
  expect(eventProbe.eventCount == kMaximumEventsPerBlock &&
         eventProbe.events[kMaximumEventsPerBlock - 2].kind ==
             MusicalEventKind::NoteOn &&
         eventProbe.events[kMaximumEventsPerBlock - 1].kind ==
             MusicalEventKind::NoteOff &&
         eventDiagnostics.musicalEventOverflows.load() == 44,
         "musical overload preserves FIFO order for equal-offset on/off");

  Builder graph;
  graph.input(1); graph.builtin(2, BuiltinNodeKind::Gain, 1, 1.0f);
  graph.builtin(3, BuiltinNodeKind::SafetyLimiter, 1, 1.0f);
  graph.output(4); graph.connect(1, 0, 2, 0); graph.connect(2, 0, 3, 0);
  graph.connect(3, 0, 4, 0); expect(succeeded(graph.compile()), "compile containment graph");
  float inputSamples[8]{1.0f, std::numeric_limits<float>::quiet_NaN(),
      std::numeric_limits<float>::infinity(), -std::numeric_limits<float>::infinity(),
      2.0f, -2.0f, 0.5f, -0.5f};
  float outputSamples[8]{}; const float* in[]{inputSamples}; float* out[]{outputSamples};
  ConstAudioBusView input{in, 1, {8}, {8}, nullptr};
  MutableAudioBusView output{out, 1, {8}, {8}};
  RuntimeDiagnostics diagnostics{}; RetirementSlot slots[1]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slots, 1, &diagnostics);
  PublishedGraphSnapshot snapshot{graph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &snapshot).status),
         "publish containment graph");
  GraphRunner runner{}; GraphRunnerStorage storage{};
  initializeGraphRunner(&runner, &publisher, storage, nullptr, nullptr, &diagnostics);
  ProcessContext context{kProcessContextInterfaceVersion, kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {8},
      nullptr, 0, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0}};
  test::resetAllocationTrap();
  test::setAllocationTrapEnabled(true);
  const Status status = renderGraphBlock(&runner, context, &input, 1, &output, 1);
  test::setAllocationTrapEnabled(false);
  expect(succeeded(status) && test::trappedAllocationCount() == 0,
         "steady-state runner performs no allocation");
  expect(outputSamples[1] == 0.0f && outputSamples[2] == 0.0f &&
         outputSamples[3] == 0.0f && outputSamples[4] == 1.0f &&
         outputSamples[5] == -1.0f && diagnostics.nonFiniteSamples.load() == 3,
         "non-finite values are contained before the next node");

  Builder overflowingMix;
  overflowingMix.input(70); overflowingMix.input(71);
  overflowingMix.builtin(72, BuiltinNodeKind::Mix, 2);
  overflowingMix.output(73);
  overflowingMix.connect(70, 0, 72, 0);
  overflowingMix.connect(71, 0, 72, 1);
  overflowingMix.connect(72, 0, 73, 0);
  expect(succeeded(overflowingMix.compile()), "compile internal-overflow mix");
  float maximum = std::numeric_limits<float>::max();
  const float* maximumChannels[]{&maximum};
  ConstAudioBusView maximumInputs[]{
      {maximumChannels, 1, {1}, {1}, nullptr},
      {maximumChannels, 1, {1}, {1}, nullptr}};
  float containedMix = 1.0f; float* containedMixChannels[]{&containedMix};
  MutableAudioBusView containedMixOutput{containedMixChannels, 1, {1}, {1}};
  RuntimeDiagnostics mixDiagnostics{}; RetirementSlot mixSlots[1]{};
  SnapshotPublisher mixPublisher{};
  initializePublisher(&mixPublisher, mixSlots, 1, &mixDiagnostics);
  PublishedGraphSnapshot mixSnapshot{overflowingMix.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&mixPublisher, &mixSnapshot).status),
         "publish internal-overflow mix");
  GraphRunner mixRunner{};
  initializeGraphRunner(&mixRunner, &mixPublisher, {}, nullptr, nullptr,
                        &mixDiagnostics);
  ProcessContext oneFrame = context; oneFrame.frames = {1};
  expect(succeeded(renderGraphBlock(&mixRunner, oneFrame, maximumInputs, 2,
                                    &containedMixOutput, 1)) &&
         containedMix == 0.0f &&
         mixDiagnostics.nonFiniteSamples.load() == 1,
         "builtin overflow is contained and published once per node/block");
}

void allocationTrapReplacementForms() {
  constexpr std::size_t size = 64;
  constexpr std::align_val_t alignment{64};
  test::resetAllocationTrap();
  test::setAllocationTrapEnabled(true);
  void* scalar = ::operator new(size);
  void* sizedScalar = ::operator new(size);
  void* array = ::operator new[](size);
  void* sizedArray = ::operator new[](size);
  void* nothrowScalar = ::operator new(size, std::nothrow);
  void* nothrowArray = ::operator new[](size, std::nothrow);
  void* alignedScalar = ::operator new(size, alignment);
  void* sizedAlignedScalar = ::operator new(size, alignment);
  void* alignedArray = ::operator new[](size, alignment);
  void* sizedAlignedArray = ::operator new[](size, alignment);
  void* nothrowAlignedScalar = ::operator new(size, alignment, std::nothrow);
  void* nothrowAlignedArray = ::operator new[](size, alignment, std::nothrow);
  test::setAllocationTrapEnabled(false);

  expect(nothrowScalar != nullptr && nothrowArray != nullptr &&
             nothrowAlignedScalar != nullptr && nothrowAlignedArray != nullptr &&
             test::trappedAllocationCount() == 12,
         "allocation trap covers scalar, array, aligned, sized and nothrow forms");

  ::operator delete(scalar);
  ::operator delete(sizedScalar, size);
  ::operator delete[](array);
  ::operator delete[](sizedArray, size);
  ::operator delete(nothrowScalar, std::nothrow);
  ::operator delete[](nothrowArray, std::nothrow);
  ::operator delete(alignedScalar, alignment);
  ::operator delete(sizedAlignedScalar, size, alignment);
  ::operator delete[](alignedArray, alignment);
  ::operator delete[](sizedAlignedArray, size, alignment);
  ::operator delete(nothrowAlignedScalar, alignment, std::nothrow);
  ::operator delete[](nothrowAlignedArray, alignment, std::nothrow);
}

void publicationTransitionAndRetirement() {
  Builder oldGraph; oldGraph.builtin(1, BuiltinNodeKind::Oscillator, 0, 100.0f, 0.25f);
  oldGraph.output(2); oldGraph.connect(1, 0, 2, 0); expect(succeeded(oldGraph.compile()), "old graph");
  Builder newGraph; newGraph.builtin(3, BuiltinNodeKind::Oscillator, 0, 200.0f, 0.25f);
  newGraph.builtin(7, BuiltinNodeKind::DelayCompensation, 1, 0.0f, 0.0f, 2);
  newGraph.output(4); newGraph.connect(3, 0, 7, 0); newGraph.connect(7, 0, 4, 0);
  expect(succeeded(newGraph.compile()) && compiledGraphLatency(*newGraph.graph).value == 2,
         "new graph with moved latency");
  Builder newestGraph; newestGraph.builtin(5, BuiltinNodeKind::Oscillator, 0, 300.0f, 0.25f);
  newestGraph.output(6); newestGraph.connect(5, 0, 6, 0); expect(succeeded(newestGraph.compile()), "newest graph");
  Builder replacementGraph;
  replacementGraph.builtin(8, BuiltinNodeKind::Oscillator, 0, 400.0f, 0.25f);
  replacementGraph.builtin(9, BuiltinNodeKind::DelayCompensation, 1,
                           0.0f, 0.0f, 2);
  replacementGraph.output(10); replacementGraph.connect(8, 0, 9, 0);
  replacementGraph.connect(9, 0, 10, 0);
  expect(succeeded(replacementGraph.compile()), "replacement graph");

  RuntimeDiagnostics diagnostics{}; RetirementSlot slot[1]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slot, 1, &diagnostics);
  PublishedGraphSnapshot oldSnapshot{oldGraph.graph, 1, hardCut(), 0};
  uint32_t transferCount = 0;
  TransitionPlan preparedTransition{};
  TransitionRequest transitionRequest{TransitionKind::Crossfade, {16},
      InfiniteTailPolicy::Fade, 200, 200, 800,
      markStateTransfer, &transferCount, {2}};
  transitionRequest.expectedOldGeneration = 1;
  transitionRequest.replacementGeneration = 2;
  expect(succeeded(prepareTransition(oldGraph.graph, newGraph.graph,
                                     transitionRequest, &preparedTransition)) &&
         preparedTransition.oldAlignmentDelay.value == 2 &&
         preparedTransition.newAlignmentDelay.value == 0 &&
         preparedTransition.stateTransferred == 1 && transferCount == 1,
         "transition preparation derives latency and runs state adapter off RT");
  PublishedGraphSnapshot newSnapshot{newGraph.graph, 2, preparedTransition, 0};
  PublishedGraphSnapshot newestSnapshot{newestGraph.graph, 3, crossfade(16), 0};
  expect(submitSnapshot(&publisher, &oldSnapshot).superseded == nullptr,
         "first snapshot pending");
  float outputSamples[8]{}; float oldSamples[8]{}; float oldAlign[8]{};
  float newAlign[8]{}; float history[8]{};
  float* outputChannels[]{outputSamples}; float* oldChannels[]{oldSamples};
  MutableAudioBusView output{outputChannels, 1, {8}, {8}};
  GraphRunnerStorage storage{oldSamples, oldChannels, oldAlign, newAlign, history,
                             1, {8}, {8}, {8}, nullptr, nullptr, 0};
  GraphRunner runner{}; initializeGraphRunner(&runner, &publisher, storage, nullptr, nullptr, &diagnostics);
  ProcessContext context{kProcessContextInterfaceVersion, kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {8},
      nullptr, 0, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0}};
  expect(succeeded(renderGraphBlock(&runner, context, nullptr, 0, &output, 1)), "adopt first");
  const float beforeTransition = outputSamples[7];
  expect(succeeded(submitSnapshot(&publisher, &newSnapshot).status), "publish transition");
  expect(succeeded(renderGraphBlock(&runner, context, nullptr, 0, &output, 1)) &&
         runner.fadingFrom == &oldSnapshot, "bounded crossfade begins");
  expect(std::fabs(outputSamples[0] - beforeTransition) < 0.05f,
         "latency-aligned transition has no waveform jump");
  PublicationResult deferred = submitSnapshot(&publisher, &newestSnapshot);
  expect(deferred.deferred == 1 && publisher.deferred == &newestSnapshot,
         "saturated retirement defers latest update");
  TransitionRequest replacementRequest{TransitionKind::Crossfade, {16},
      InfiniteTailPolicy::Fade, 100, 100, 800, nullptr, nullptr, {2}};
  replacementRequest.expectedOldGeneration = 2;
  replacementRequest.replacementGeneration = 4;
  TransitionPlan replacementPlan{};
  expect(succeeded(prepareTransition(newGraph.graph, replacementGraph.graph,
                                     replacementRequest, &replacementPlan)),
         "prepare distinct deferred replacement");
  PublishedGraphSnapshot replacement{replacementGraph.graph, 4,
                                     replacementPlan, 0};
  PublicationResult coalesced = submitSnapshot(&publisher, &replacement);
  expect(coalesced.superseded == &newestSnapshot && publisher.deferred == &replacement,
         "deferred updates coalesce latest-wins");
  expect(succeeded(renderGraphBlock(&runner, context, nullptr, 0, &output, 1)) &&
         runner.fadingFrom == &oldSnapshot,
         "crossfade endpoint retains the prepared latency spill");
  expect(succeeded(renderGraphBlock(&runner, context, nullptr, 0, &output, 1)) &&
         runner.fadingFrom == nullptr,
         "aligned old path retires at its exact bounded spill endpoint");
  PublishedGraphSnapshot* reclaimed[1]{};
  expect(reclaimSnapshots(&publisher, acknowledgedEpoch(runner), reclaimed, 1) == 1 &&
         reclaimed[0] == &oldSnapshot, "old snapshot final release is control-side");
  expect(serviceDeferredSnapshot(&publisher).deferred == 0,
         "deferred latest graph publishes after reclamation");

  PublishedGraphSnapshot overloaded{newGraph.graph, 5, crossfade(8), 0};
  overloaded.transition.oldCpuPermille = 600;
  overloaded.transition.newCpuPermille = 500;
  overloaded.transition.combinedCpuLimitPermille = 900;
  expect(!succeeded(submitSnapshot(&publisher, &overloaded).status),
         "combined transition CPU is rejected off RT");
  TransitionRequest overloadedRequest{TransitionKind::Crossfade, {8},
      InfiniteTailPolicy::Fade, 600, 500, 900, nullptr, nullptr, {0}};
  overloadedRequest.expectedOldGeneration = 1;
  overloadedRequest.replacementGeneration = 5;
  expect(!succeeded(prepareTransition(oldGraph.graph, newGraph.graph,
                                      overloadedRequest, &preparedTransition)),
         "transition preparation rejects combined CPU before publication");
  PublishedGraphSnapshot infinite{newGraph.graph, 6, crossfade(8), 0};
  infinite.transition.replacedTail = {TailKind::Infinite, {0}};
  infinite.transition.infiniteTailPolicy = InfiniteTailPolicy::Reject;
  expect(!succeeded(submitSnapshot(&publisher, &infinite).status),
         "infinite tail requires explicit fade or cut policy");
}

void reverseLatencyHistoryPriming() {
  Builder oldGraph;
  oldGraph.builtin(1, BuiltinNodeKind::Oscillator, 0, 100.0f, 0.25f,
                   0, OscillatorWaveform::Saw);
  oldGraph.builtin(2, BuiltinNodeKind::DelayCompensation, 1, 0.0f, 0.0f, 2);
  oldGraph.output(3); oldGraph.connect(1, 0, 2, 0);
  oldGraph.connect(2, 0, 3, 0);
  expect(succeeded(oldGraph.compile()), "compile high-latency transition source");
  Builder newGraph;
  newGraph.builtin(4, BuiltinNodeKind::Oscillator, 0, 100.0f, 0.25f,
                   0, OscillatorWaveform::Saw);
  newGraph.output(3); newGraph.connect(4, 0, 3, 0);
  expect(succeeded(newGraph.compile()), "compile lower-latency replacement");
  TransitionRequest request{TransitionKind::Crossfade, {4},
      InfiniteTailPolicy::Fade, 100, 100, 800, nullptr, nullptr, {2}};
  request.expectedOldGeneration = 1;
  request.replacementGeneration = 2;
  TransitionPlan plan{};
  expect(succeeded(prepareTransition(oldGraph.graph, newGraph.graph,
                                     request, &plan)) &&
         plan.oldAlignmentDelay.value == 0 &&
         plan.newAlignmentDelay.value == 2,
         "reverse latency move delays the new path explicitly");
  RuntimeDiagnostics diagnostics{}; RetirementSlot slots[2]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slots, 2, &diagnostics);
  PublishedGraphSnapshot oldSnapshot{oldGraph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &oldSnapshot).status),
         "publish reverse latency source");
  float outputSamples[4]{}, oldSamples[4]{}, newAlignment[2]{}, history[4]{};
  float* outputChannels[]{outputSamples}; float* oldChannels[]{oldSamples};
  MutableAudioBusView output{outputChannels, 1, {4}, {4}};
  GraphRunnerStorage storage{oldSamples, oldChannels, nullptr, newAlignment,
                             history, 1, {4}, {2}, {4}, nullptr, nullptr, 0};
  GraphRunner runner{};
  initializeGraphRunner(&runner, &publisher, storage, nullptr, nullptr, &diagnostics);
  ProcessContext context{kProcessContextInterfaceVersion, kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {4},
      nullptr, 0, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0}};
  expect(succeeded(renderGraphBlock(&runner, context, nullptr, 0, &output, 1)),
         "seed output history for reverse move");
  const float before = outputSamples[3];
  PublishedGraphSnapshot next{newGraph.graph, 2, plan, 0};
  expect(succeeded(submitSnapshot(&publisher, &next).status),
         "publish reverse latency move");
  expect(succeeded(renderGraphBlock(&runner, context, nullptr, 0, &output, 1)) &&
         std::fabs(outputSamples[0] - before) < 0.05f,
         "reverse latency alignment is primed from history instead of silence");
}

void buildTwoOutputGraph(Builder* graph, bool delayed) {
  graph->maximumFrames = {4};
  graph->inputBus(1, &graph->mono);
  graph->inputBus(2, &graph->stereo);
  if (delayed) {
    graph->builtinBus(3, BuiltinNodeKind::DelayCompensation,
                      &graph->mono, 2);
    graph->builtinBus(4, BuiltinNodeKind::DelayCompensation,
                      &graph->stereo, 2);
  }
  graph->outputBus(5, &graph->mono);
  graph->outputBus(6, &graph->stereo);
  if (delayed) {
    graph->connect(1, 0, 3, 0);
    graph->connect(3, 0, 5, 0);
    graph->connect(2, 0, 4, 0);
    graph->connect(4, 0, 6, 0);
  } else {
    graph->connect(1, 0, 5, 0);
    graph->connect(2, 0, 6, 0);
  }
  expect(succeeded(graph->compile()),
         "compile topology-compatible two-output graph");
}

std::vector<float> renderTwoOutputTransition(bool oldDelayed,
                                             const uint32_t* partitions,
                                             uint32_t partitionCount,
                                             uint32_t* oldDelay,
                                             uint32_t* newDelay) {
  Builder oldGraph;
  Builder replacement;
  buildTwoOutputGraph(&oldGraph, oldDelayed);
  buildTwoOutputGraph(&replacement, !oldDelayed);
  TransitionRequest request{TransitionKind::Crossfade, {2},
      InfiniteTailPolicy::Fade, 100, 100, 800, nullptr, nullptr, {4}};
  request.expectedOldGeneration = 1;
  request.replacementGeneration = 2;
  TransitionPlan plan{};
  expect(succeeded(prepareTransition(oldGraph.graph, replacement.graph,
                                     request, &plan)) &&
         plan.requiredOutputBusCount == 2 &&
         plan.requiredOutputChannels == 3 &&
         plan.requiredTailInputChannels == 3,
         "two-output transition derives aggregate storage requirements off RT");
  *oldDelay = plan.oldAlignmentDelay.value;
  *newDelay = plan.newAlignmentDelay.value;

  RuntimeDiagnostics diagnostics{};
  RetirementSlot slots[2]{};
  SnapshotPublisher publisher{};
  initializePublisher(&publisher, slots, 2, &diagnostics);
  PublishedGraphSnapshot oldSnapshot{oldGraph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &oldSnapshot).status),
         "publish two-output source graph");
  float oldSamples[3 * 4]{};
  float* oldChannels[3]{};
  float oldAlignment[3 * 2]{};
  float newAlignment[3 * 2]{};
  float history[3 * 4]{};
  float silence[3 * 4]{};
  const float* silenceChannels[3]{};
  GraphRunnerStorage storage{oldSamples, oldChannels, oldAlignment,
      newAlignment, history, 3, {4}, {2}, {4}, silence,
      silenceChannels, 3};
  GraphRunner runner{};
  initializeGraphRunner(&runner, &publisher, storage, nullptr, nullptr,
                        &diagnostics);

  float monoInput[4]{0.25f, 0.25f, 0.25f, 0.25f};
  float stereoLeft[4]{0.5f, 0.5f, 0.5f, 0.5f};
  float stereoRight[4]{0.75f, 0.75f, 0.75f, 0.75f};
  const float* monoInputChannels[]{monoInput};
  const float* stereoInputChannels[]{stereoLeft, stereoRight};
  ConstAudioBusView inputs[]{
      {monoInputChannels, 1, {3}, {4}, nullptr},
      {stereoInputChannels, 2, {3}, {4}, nullptr}};
  float monoOutput[4]{};
  float stereoOutputLeft[4]{};
  float stereoOutputRight[4]{};
  float* monoOutputChannels[]{monoOutput};
  float* stereoOutputChannels[]{stereoOutputLeft, stereoOutputRight};
  MutableAudioBusView outputs[]{
      {monoOutputChannels, 1, {3}, {4}},
      {stereoOutputChannels, 2, {3}, {4}}};
  ProcessContext context{kProcessContextInterfaceVersion,
      kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {3},
      nullptr, 0, nullptr, 0, {nullptr, 0},
      {DiscontinuityReason::None, 0}};
  expect(succeeded(renderGraphBlock(&runner, context, inputs, 2, outputs, 2)),
         "seed independent history for both external output buses");
  PublishedGraphSnapshot next{replacement.graph, 2, plan, 0};
  expect(succeeded(submitSnapshot(&publisher, &next).status),
         "publish two-output replacement");

  std::vector<float> rendered;
  uint32_t graphFrame = 3;
  for (uint32_t part = 0; part < partitionCount; ++part) {
    const uint32_t frames = partitions[part];
    inputs[0].frames = {frames};
    inputs[1].frames = {frames};
    outputs[0].frames = {frames};
    outputs[1].frames = {frames};
    context.frames = {frames};
    context.time.graphFrame = {graphFrame};
    expect(succeeded(renderGraphBlock(&runner, context, inputs, 2, outputs, 2)),
           "render two-output transition partition");
    for (uint32_t frame = 0; frame < frames; ++frame) {
      rendered.push_back(monoOutput[frame]);
      rendered.push_back(stereoOutputLeft[frame]);
      rendered.push_back(stereoOutputRight[frame]);
      near(stereoOutputLeft[frame], monoOutput[frame] * 2.0f, 1.0e-6f,
           "first and second output buses never alias");
      near(stereoOutputRight[frame], monoOutput[frame] * 3.0f, 1.0e-6f,
           "stereo lanes retain their distinct logical-bus values");
    }
    graphFrame += frames;
  }
  expect(runner.fadingFrom == nullptr && runner.transitionFrame == 2 &&
         runner.tailFrame == 2,
         "mid-block endpoint drains the exact bounded multi-output spill");
  return rendered;
}

void multiOutputTransitions() {
  const uint32_t partitionA[]{3, 1};
  const uint32_t partitionB[]{1, 3};
  for (const bool oldDelayed : {false, true}) {
    uint32_t oldDelayA = 0, newDelayA = 0;
    uint32_t oldDelayB = 0, newDelayB = 0;
    const std::vector<float> first = renderTwoOutputTransition(
        oldDelayed, partitionA, 2, &oldDelayA, &newDelayA);
    const std::vector<float> second = renderTwoOutputTransition(
        oldDelayed, partitionB, 2, &oldDelayB, &newDelayB);
    expect(oldDelayA == (oldDelayed ? 0u : 2u) &&
           newDelayA == (oldDelayed ? 2u : 0u) &&
           oldDelayA == oldDelayB && newDelayA == newDelayB &&
           first.size() == second.size() && !first.empty() &&
           first[0] > 0.0f && first[1] > first[0] && first[2] > first[1],
           "two-output forward and reverse latency moves derive exact alignment");
    for (uint32_t sample = 0; sample < first.size(); ++sample)
      near(first[sample], second[sample], 1.0e-7f,
           "two-output fade/tail output is callback-partition invariant");
  }

  auto verifyRejectedWithoutMutation = [](bool nullSecondBus) {
    Builder oldGraph;
    Builder replacement;
    buildTwoOutputGraph(&oldGraph, false);
    buildTwoOutputGraph(&replacement, true);
    TransitionRequest request{TransitionKind::Crossfade, {2},
        InfiniteTailPolicy::Fade, 100, 100, 800, nullptr, nullptr, {4}};
    request.expectedOldGeneration = 1;
    request.replacementGeneration = 2;
    TransitionPlan plan{};
    expect(succeeded(prepareTransition(oldGraph.graph, replacement.graph,
                                       request, &plan)),
           "prepare rejected-storage two-output transition");
    RuntimeDiagnostics diagnostics{};
    RetirementSlot slots[2]{};
    SnapshotPublisher publisher{};
    initializePublisher(&publisher, slots, 2, &diagnostics);
    PublishedGraphSnapshot oldSnapshot{oldGraph.graph, 1, hardCut(), 0};
    expect(succeeded(submitSnapshot(&publisher, &oldSnapshot).status),
           "publish rejected-storage source");
    float oldSamples[3 * 4]{};
    float* oldChannels[3]{};
    float oldAlignment[3 * 2]{};
    float newAlignment[3 * 2]{};
    float history[3 * 4]{};
    float silence[3 * 4]{};
    const float* silenceChannels[3]{};
    GraphRunnerStorage storage{oldSamples, oldChannels, oldAlignment,
        newAlignment, history, nullSecondBus ? 3u : 2u, {4}, {2}, {4},
        silence, silenceChannels, 3};
    GraphRunner runner{};
    initializeGraphRunner(&runner, &publisher, storage, nullptr, nullptr,
                          &diagnostics);
    float monoInput[4]{0.25f, 0.25f, 0.25f, 0.25f};
    float stereoLeft[4]{0.5f, 0.5f, 0.5f, 0.5f};
    float stereoRight[4]{0.75f, 0.75f, 0.75f, 0.75f};
    const float* monoInputChannels[]{monoInput};
    const float* stereoInputChannels[]{stereoLeft, stereoRight};
    ConstAudioBusView inputs[]{
        {monoInputChannels, 1, {2}, {4}, nullptr},
        {stereoInputChannels, 2, {2}, {4}, nullptr}};
    float monoOutput[4]{}, stereoOutputLeft[4]{}, stereoOutputRight[4]{};
    float* monoOutputChannels[]{monoOutput};
    float* stereoOutputChannels[]{stereoOutputLeft, stereoOutputRight};
    MutableAudioBusView outputs[]{
        {monoOutputChannels, 1, {2}, {4}},
        {stereoOutputChannels, 2, {2}, {4}}};
    ProcessContext context{kProcessContextInterfaceVersion,
        kProcessContextV1RequiredSize,
        {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {2},
        nullptr, 0, nullptr, 0, {nullptr, 0},
        {DiscontinuityReason::None, 0}};
    expect(succeeded(renderGraphBlock(&runner, context, inputs, 2, outputs, 2)),
           "adopt rejected-storage source graph");
    PublishedGraphSnapshot next{replacement.graph, 2, plan, 0};
    expect(succeeded(submitSnapshot(&publisher, &next).status),
           "publish rejected two-output replacement");
    monoOutput[0] = 11.0f;
    stereoOutputLeft[0] = 22.0f;
    stereoOutputRight[0] = 33.0f;
    if (nullSecondBus) stereoOutputChannels[1] = nullptr;
    const uint32_t epoch = acknowledgedEpoch(runner);
    const Status rejected = renderGraphBlock(
        &runner, context, inputs, 2, outputs, 2);
    expect(!succeeded(rejected) && runner.active == &oldSnapshot &&
           runner.fadingFrom == nullptr && acknowledgedEpoch(runner) == epoch &&
           monoOutput[0] == 11.0f && stereoOutputLeft[0] == 22.0f &&
           stereoOutputRight[0] == 33.0f,
           nullSecondBus
               ? "null lane in second output bus rejects before transition mutation"
               : "insufficient aggregate output scratch rejects without mutation");
  };
  verifyRejectedWithoutMutation(false);
  verifyRejectedWithoutMutation(true);
}

void publicationStress() {
  struct OwnedSnapshot {
    Builder graph;
    PublishedGraphSnapshot snapshot;
    explicit OwnedSnapshot(uint32_t generation) {
      graph.builtin(1, BuiltinNodeKind::Oscillator, 0,
                    180.0f + static_cast<float>(generation), 0.05f);
      graph.output(2); graph.connect(1, 0, 2, 0);
      expect(succeeded(graph.compile()), "compile owned swap stress graph");
      snapshot = {graph.graph, generation, hardCut(), 0};
    }
  };
  constexpr uint32_t snapshotCount = 96;
  OwnedSnapshot* owners[snapshotCount]{};
  for (uint32_t index = 0; index < snapshotCount; ++index)
    owners[index] = new OwnedSnapshot(index + 1);
  for (uint32_t index = 1; index < snapshotCount; ++index) {
    TransitionPlan& plan = owners[index]->snapshot.transition;
    plan.expectedOldGraph = owners[index - 1]->graph.graph;
    plan.expectedReplacementGraph = owners[index]->graph.graph;
    plan.expectedOldGeneration = index;
    plan.replacementGeneration = index + 1;
  }
  uint32_t destructions = 0;
  auto release = [&](PublishedGraphSnapshot* snapshot) {
    if (snapshot == nullptr) return;
    for (uint32_t index = 0; index < snapshotCount; ++index) {
      if (owners[index] != nullptr && &owners[index]->snapshot == snapshot) {
        delete owners[index];
        owners[index] = nullptr;
        ++destructions;
        return;
      }
    }
    fail("snapshot final release occurs exactly once off RT");
  };
  RuntimeDiagnostics diagnostics{}; RetirementSlot slots[8]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slots, 8, &diagnostics);
  expect(succeeded(submitSnapshot(&publisher, &owners[0]->snapshot).status),
         "seed swap stress");
  GraphRunner runner{}; GraphRunnerStorage storage{};
  initializeGraphRunner(&runner, &publisher, storage, nullptr, nullptr, &diagnostics);
  float samples[16]{}; float* channels[]{samples};
  MutableAudioBusView output{channels, 1, {16}, {16}};
  ProcessContext context{kProcessContextInterfaceVersion,
      kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {16},
      nullptr, 0, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0}};
  uint32_t submits = 1, adoptions = 0, reclamations = 0;
  PublishedGraphSnapshot* reclaimed[8]{};
  expect(succeeded(renderGraphBlock(&runner, context, nullptr, 0, &output, 1)) &&
         runner.active == &owners[0]->snapshot,
         "deterministically adopt first lifetime-managed snapshot");
  ++adoptions;
  for (uint32_t next = 1; next < snapshotCount; ++next) {
    PublicationResult publication = submitSnapshot(
        &publisher, &owners[next]->snapshot);
    expect(succeeded(publication.status), "submit lifetime-managed snapshot");
    ++submits;
    release(publication.superseded);
    expect(succeeded(renderGraphBlock(&runner, context, nullptr, 0, &output, 1)) &&
           runner.active == &owners[next]->snapshot,
           "deterministically adopt identity-bound generation");
    ++adoptions;
    uint32_t count = reclaimSnapshots(&publisher, acknowledgedEpoch(runner),
                                      reclaimed, 8);
    for (uint32_t index = 0; index < count; ++index) {
      release(reclaimed[index]);
      ++reclamations;
    }
  }
  PublishedGraphSnapshot* shutdown[8]{}; uint32_t shutdownCount = 0;
  expect(succeeded(shutdownGraphRunner(&runner, shutdown, 8, &shutdownCount)) &&
         shutdownCount == 1,
         "deterministic stress shutdown extracts final active generation");
  for (uint32_t index = 0; index < shutdownCount; ++index)
    release(shutdown[index]);
  for (uint32_t index = 0; index < snapshotCount; ++index) {
    expect(owners[index] == nullptr,
           "every lifetime-managed snapshot reaches one final release");
  }
  expect(submits == snapshotCount && adoptions == snapshotCount &&
         reclamations == snapshotCount - 1 && destructions == snapshotCount &&
         acknowledgedEpoch(runner) == snapshotCount,
         "exactly 96 generations submit, adopt, reclaim, and destroy once");
}

void publicationFloodLatestWins() {
  BlockingProbeState blocking{};
  Builder activeGraph; activeGraph.input(1);
  activeGraph.nodes[activeGraph.nodeCount++] = {{2}, {9, 2}, 1,
      GraphNodeRole::Processor, 0, 1, 1, &activeGraph.mono, &activeGraph.mono,
      {&blocking, &blockingProbeFunctions}, {nullptr, 0, 1}};
  activeGraph.output(3); activeGraph.connect(1, 0, 2, 0);
  activeGraph.connect(2, 0, 3, 0);
  expect(succeeded(activeGraph.compile()), "compile flood active graph");
  struct FloodOwner {
    Builder graph;
    PublishedGraphSnapshot snapshot;
    FloodOwner(uint32_t generation, const CompiledGraph* expectedOld) {
      graph.input(1); graph.builtin(2, BuiltinNodeKind::Gain, 1,
                                    static_cast<float>(generation));
      graph.output(3); graph.connect(1, 0, 2, 0); graph.connect(2, 0, 3, 0);
      expect(succeeded(graph.compile()), "compile flood replacement graph");
      TransitionPlan plan = hardCut();
      plan.expectedOldGraph = expectedOld;
      plan.expectedReplacementGraph = graph.graph;
      plan.expectedOldGeneration = 1;
      plan.replacementGeneration = generation;
      snapshot = {graph.graph, generation, plan, 0};
    }
  };
  constexpr uint32_t generationCount = 96;
  FloodOwner* owners[generationCount]{};
  for (uint32_t generation = 2; generation <= generationCount; ++generation)
    owners[generation - 1] = new FloodOwner(generation, activeGraph.graph);
  std::atomic<uint32_t> destructions{0};
  auto release = [&](PublishedGraphSnapshot* snapshot) {
    if (snapshot == nullptr) return;
    for (uint32_t index = 1; index < generationCount; ++index) {
      if (owners[index] != nullptr && &owners[index]->snapshot == snapshot) {
        delete owners[index]; owners[index] = nullptr;
        destructions.fetch_add(1, std::memory_order_relaxed);
        return;
      }
    }
    fail("flood snapshot is destroyed exactly once off RT");
  };
  RuntimeDiagnostics diagnostics{}; RetirementSlot slots[2]{};
  SnapshotPublisher publisher{}; initializePublisher(&publisher, slots, 2,
                                                      &diagnostics);
  PublishedGraphSnapshot activeSnapshot{activeGraph.graph, 1, hardCut(), 0};
  expect(succeeded(submitSnapshot(&publisher, &activeSnapshot).status),
         "publish flood active graph");
  GraphRunner runner{}; initializeGraphRunner(&runner, &publisher, {}, nullptr,
                                              nullptr, &diagnostics);
  float inputSample = 1.0f, outputSample = 0.0f;
  const float* inputChannels[]{&inputSample}; float* outputChannels[]{&outputSample};
  ConstAudioBusView input{inputChannels, 1, {1}, {1}, nullptr};
  MutableAudioBusView output{outputChannels, 1, {1}, {1}};
  ProcessContext context{kProcessContextInterfaceVersion,
      kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {1},
      nullptr, 0, nullptr, 0, {nullptr, 0},
      {DiscontinuityReason::None, 0}};
  blocking.release.store(true, std::memory_order_release);
  expect(succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)),
         "adopt flood active graph");
  blocking.entered.store(false, std::memory_order_release);
  blocking.release.store(false, std::memory_order_release);
  Status blockedRender{};
  std::thread render([&] {
    blockedRender = renderGraphBlock(&runner, context, &input, 1, &output, 1);
  });
  const auto watchdog = std::chrono::steady_clock::now() +
                        std::chrono::seconds(5);
  while (!blocking.entered.load(std::memory_order_acquire)) {
    expect(std::chrono::steady_clock::now() < watchdog,
           "flood render barrier wall-clock watchdog");
    std::this_thread::yield();
  }
  std::atomic<uint32_t> superseded{0};
  std::thread producer([&] {
    for (uint32_t generation = 2; generation <= generationCount; ++generation) {
      PublicationResult result = submitSnapshot(
          &publisher, &owners[generation - 1]->snapshot);
      expect(succeeded(result.status), "concurrent flood publication");
      if (result.superseded != nullptr) {
        ++superseded;
        release(result.superseded);
      }
    }
  });
  producer.join();
  expect(superseded.load() == generationCount - 2 &&
         publisher.pending.load(std::memory_order_acquire) ==
             &owners[generationCount - 1]->snapshot,
         "concurrent flood coalesces to latest generation without adoption waits");
  blocking.release.store(true, std::memory_order_release);
  render.join();
  expect(succeeded(blockedRender) &&
         succeeded(renderGraphBlock(&runner, context, &input, 1, &output, 1)) &&
         runner.active->generation == generationCount,
         "render adopts the exact latest generation after concurrent flood");
  PublishedGraphSnapshot* extracted[2]{}; uint32_t count = 0;
  expect(succeeded(shutdownGraphRunner(&runner, extracted, 2, &count)) &&
         count == 2,
         "flood shutdown extracts active and retired snapshots");
  for (uint32_t index = 0; index < count; ++index)
    if (extracted[index] != &activeSnapshot) release(extracted[index]);
  expect(destructions.load() == generationCount - 1,
         "all superseded and adopted flood snapshots destroy off RT exactly once");
}

void offlinePartitionAndGolden() {
  auto build = []() {
    Builder* graph = new Builder();
    graph->builtin(1, BuiltinNodeKind::Oscillator, 0, 375.0f, 0.25f, 0,
                   OscillatorWaveform::Saw);
    graph->builtin(2, BuiltinNodeKind::Gain, 1, 0.5f, 1.0f, 0,
                   OscillatorWaveform::Saw, GraphNodeFlagMayProcessInPlace);
    graph->builtin(3, BuiltinNodeKind::SafetyLimiter, 1, 0.9f);
    graph->output(4); graph->connect(1, 0, 2, 0); graph->connect(2, 0, 3, 0);
    graph->connect(3, 0, 4, 0); expect(succeeded(graph->compile()), "offline graph");
    return graph;
  };
  Builder* first = build(); Builder* second = build();
  constexpr uint32_t frames = 480;
  std::vector<float> outputA(frames), outputB(frames);
  std::vector<uint8_t> wavA(44 + frames * sizeof(float));
  std::vector<uint8_t> wavB(wavA.size());
  OfflineRenderResult a{}, b{};
  expect(succeeded(renderOffline(first->graph, {{frames}, {64}, 1}, outputA.data(),
      {wavA.data(), static_cast<uint32_t>(wavA.size())}, &a)), "offline partition 64");
  expect(succeeded(renderOffline(second->graph, {{frames}, {127}, 1}, outputB.data(),
      {wavB.data(), static_cast<uint32_t>(wavB.size())}, &b)), "offline partition 127");
  expect(std::memcmp(outputA.data(), outputB.data(), outputA.size() * sizeof(float)) == 0 &&
         a.pcmHash == b.pcmHash && a.wavHash == b.wavHash && wavA == wavB,
         "offline output is callback-partition invariant");
  // This pair is the versioned little-endian float WAV golden fixture. Update
  // it only with an intentional oscillator/renderer format change.
  constexpr uint64_t expectedPcmHash = 456813383480480899ull;
  constexpr uint64_t expectedWavHash = 4446233685677010001ull;
  expect(a.pcmHash == expectedPcmHash && a.wavHash == expectedWavHash,
         "offline golden WAV/hash fixture");
  std::printf("offline-golden pcm=%llu wav=%llu bytes=%u\n",
      static_cast<unsigned long long>(a.pcmHash),
      static_cast<unsigned long long>(a.wavHash), a.wavBytes);
  delete first; delete second;
}

}  // namespace

int main() {
  topologyAndPlanner();
  builtinBusContracts();
  remainingBuiltins();
  duplicateProcessorOwnershipRejectedBeforePrepare();
  automationAcrossPartitions();
  telemetryConcurrency();
  latencyCompensationAndRendering();
  discontinuitiesAndFailedPrepare();
  lifecycleFailureRecovery();
  externalBoundariesAndProvenance();
  transitionCompatibilityAndTails();
  tailEnvelopeContinuity();
  rejectedTransitionRetainsActiveGraph();
  exactTransitionBoundaryAndTailContext();
  transitionPlanIdentityCoalescing();
  adoptionOwnershipNeverDisappears();
  rejectedOwnershipNeverDisappears();
  finalAuditContractsAndShutdown();
  discontinuitiesCancelFadeAndTail();
  shutdownBusyAndCallbackGuard();
  boundedAndNonDestructiveQueueDrains();
  queuesContainmentAndAllocationTrap();
  allocationTrapReplacementForms();
  publicationTransitionAndRetirement();
  reverseLatencyHistoryPriming();
  multiOutputTransitions();
  publicationStress();
  publicationFloodLatestWins();
  offlinePartitionAndGolden();
  std::puts("zdsp graph tests passed");
  return 0;
}
