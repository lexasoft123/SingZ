#include "zdsp/graph_fixture.h"
#include "zdsp/latency.h"
#include "zdsp/prototype_gain_meter.h"

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <new>
#include <type_traits>
#if defined(_WIN32)
#include <malloc.h>
#endif

namespace {
std::atomic<bool> countAllocations{false};
std::atomic<uint64_t> allocationCount{0};
void* allocateAligned(std::size_t size, std::size_t alignment) noexcept {
#if defined(_WIN32)
  return _aligned_malloc(size, alignment);
#else
  return std::aligned_alloc(alignment, size);
#endif
}
void releaseAligned(void* pointer) noexcept {
#if defined(_WIN32)
  _aligned_free(pointer);
#else
  std::free(pointer);
#endif
}
}

void* operator new(std::size_t size) {
  if (countAllocations.load(std::memory_order_relaxed)) allocationCount.fetch_add(1, std::memory_order_relaxed);
  if (void* p = std::malloc(size)) return p;
  throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
  if (countAllocations.load(std::memory_order_relaxed)) allocationCount.fetch_add(1, std::memory_order_relaxed);
  if (void* p = std::malloc(size)) return p;
  throw std::bad_alloc();
}
void* operator new(std::size_t size, const std::nothrow_t&) noexcept {
  if (countAllocations.load(std::memory_order_relaxed)) allocationCount.fetch_add(1, std::memory_order_relaxed);
  return std::malloc(size);
}
void* operator new[](std::size_t size, const std::nothrow_t&) noexcept {
  if (countAllocations.load(std::memory_order_relaxed)) allocationCount.fetch_add(1, std::memory_order_relaxed);
  return std::malloc(size);
}
void* operator new(std::size_t size, std::align_val_t alignment) {
  if (countAllocations.load(std::memory_order_relaxed)) allocationCount.fetch_add(1, std::memory_order_relaxed);
  const size_t alignedSize = (size + static_cast<size_t>(alignment) - 1) & ~(static_cast<size_t>(alignment) - 1);
  if (void* p = allocateAligned(alignedSize, static_cast<size_t>(alignment))) return p;
  throw std::bad_alloc();
}
void* operator new[](std::size_t size, std::align_val_t alignment) {
  return ::operator new(size, alignment);
}
void* operator new(std::size_t size, std::align_val_t alignment, const std::nothrow_t&) noexcept {
  if (countAllocations.load(std::memory_order_relaxed)) allocationCount.fetch_add(1, std::memory_order_relaxed);
  const size_t alignedSize = (size + static_cast<size_t>(alignment) - 1) & ~(static_cast<size_t>(alignment) - 1);
  return allocateAligned(alignedSize, static_cast<size_t>(alignment));
}
void* operator new[](std::size_t size, std::align_val_t alignment, const std::nothrow_t& tag) noexcept {
  return ::operator new(size, alignment, tag);
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }
void operator delete(void* p, std::align_val_t) noexcept { releaseAligned(p); }
void operator delete[](void* p, std::align_val_t) noexcept { releaseAligned(p); }
void operator delete(void* p, std::size_t, std::align_val_t) noexcept { releaseAligned(p); }
void operator delete[](void* p, std::size_t, std::align_val_t) noexcept { releaseAligned(p); }

namespace {
using namespace zdsp;

static_assert(std::is_standard_layout_v<ProcessorVTable>);
static_assert(std::is_trivially_copyable_v<ProcessorVTable>);
static_assert(std::is_standard_layout_v<ProcessContext>);
static_assert(std::is_trivially_copyable_v<ProcessContext>);
static_assert(std::is_standard_layout_v<ConstAudioBusView>);
static_assert(std::is_trivially_copyable_v<ConstAudioBusView>);
static_assert(std::is_same_v<ProcessorProcessFn,
    void (*)(void*, const ProcessContext*, const ConstAudioBusView*, uint32_t,
             const MutableAudioBusView*, uint32_t) noexcept>);

[[noreturn]] void fail(const char* message) {
  std::fprintf(stderr, "FAIL: %s\n", message);
  std::abort();
}
void expect(bool value, const char* message) { if (!value) fail(message); }
void near(float actual, float expected, float epsilon, const char* message) {
  if (std::fabs(actual - expected) > epsilon) fail(message);
}

struct Fixture {
  alignas(PrototypeGainMeterState) uint8_t storage[sizeof(PrototypeGainMeterState)];
  AudioBusDescriptor stereo{2, SampleFormat::Float32Planar, AudioChannelLayout::Stereo, nullptr};
  PrototypeFakeHost host{};
  float in[2][256]{};
  float out[2][256]{};
  const float* inPointers[2]{in[0], in[1]};
  float* outPointers[2]{out[0], out[1]};

  Fixture() {
    for (auto& channel : in) for (float& sample : channel) sample = 1.0f;
    PreparedStorage prepared{storage, sizeof(storage), alignof(PrototypeGainMeterState)};
    const auto processor = makePrototypeGainMeter({{42}, 1.0f}, prepared);
    PrepareSpec spec{kProcessorInterfaceVersion, kPrepareSpecV1RequiredSize, {48000.0}, {256},
                     1, 1, &stereo, &stereo};
    expect(succeeded(preparePrototypeFakeHost(&host, processor, spec)), "prepare lifecycle");
  }
  ~Fixture() {
    if (host.active != 0) expect(succeeded(destroyPrototypeFakeHost(&host)), "deactivate then destroy lifecycle");
  }

  Status block(uint32_t frames, const ParameterEvent* events = nullptr, uint32_t count = 0,
               Discontinuity discontinuity = {DiscontinuityReason::None, DiscontinuityFlagNone}) {
    ConstAudioBusView input{frames == 0 ? nullptr : inPointers, 2, {frames}, {256}, nullptr};
    MutableAudioBusView output{frames == 0 ? nullptr : outPointers, 2, {frames}, {256}};
    return processPrototypeBlock(&host, input, output, events, count, discontinuity);
  }
};

void appendCompatiblePrefixesAndTransportBits() {
  Fixture fixture;
  AudioBusDescriptor stereo{2, SampleFormat::Float32Planar,
                            AudioChannelLayout::Stereo, nullptr};
  PrepareSpec currentSpec{kProcessorInterfaceVersion,
                          kPrepareSpecV1RequiredSize, {48000.0}, {256},
                          1, 1, &stereo, &stereo};
  struct FuturePrepareSpec { PrepareSpec v1; uint64_t appended; };
  FuturePrepareSpec futureSpec{currentSpec, 0x1234};
  static_assert(sizeof(FuturePrepareSpec) > sizeof(PrepareSpec));
  futureSpec.v1.structSize = static_cast<uint32_t>(sizeof(FuturePrepareSpec));
  expect(succeeded(validatePrepareSpec(futureSpec.v1)),
         "prepare accepts a future struct larger than V1");
  futureSpec.v1.structSize = kPrepareSpecV1RequiredSize - 1;
  expect(!succeeded(validatePrepareSpec(futureSpec.v1)), "prepare rejects truncated V1 prefix");

  struct FutureVTable { ProcessorVTable v1; uint64_t appended; };
  FutureVTable futureVTable{*fixture.host.processor.functions, 0x5678};
  static_assert(sizeof(FutureVTable) > sizeof(ProcessorVTable));
  futureVTable.v1.structSize = static_cast<uint32_t>(sizeof(FutureVTable));
  ProcessorHandle prefixed{fixture.host.processor.state, &futureVTable.v1};
  expect(succeeded(validateProcessor(prefixed)),
         "processor accepts a future vtable larger than V1");
  futureVTable.v1.structSize = kProcessorVTableV1RequiredSize - 1;
  expect(!succeeded(validateProcessor(prefixed)), "processor rejects truncated V1 vtable prefix");

  ProcessContext context{kProcessContextInterfaceVersion, kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, nullptr, {48000.0}, {0},
      nullptr, 0, nullptr, 0, {nullptr, 0}, {DiscontinuityReason::None, 0}};
  struct FutureContext { ProcessContext v1; uint64_t appended; } futureContext{context, 0x9abc};
  static_assert(sizeof(FutureContext) > sizeof(ProcessContext));
  futureContext.v1.structSize = static_cast<uint32_t>(sizeof(FutureContext));
  expect(succeeded(validateProcessContext(futureContext.v1)),
         "process accepts a future context larger than V1");
  futureContext.v1.structSize = kProcessContextV1RequiredSize - 1;
  expect(!succeeded(validateProcessContext(futureContext.v1)), "process rejects truncated V1 prefix");

  context.scratch = {nullptr, 1};
  expect(!succeeded(validateProcessContext(context)),
         "process rejects non-empty scratch without storage");
  context.scratch = {nullptr, 0};
  expect(succeeded(validateProcessContext(context)),
         "process accepts empty null scratch");

  static_assert(!std::is_same_v<TransportValidFields, TransportStateFlags>);
  expect(TransportValidTempo != TransportValidProjectSamples &&
         TransportStatePlaying != TransportStateRecording &&
         TransportStateRecording != TransportStateCycling,
         "transport fields have independent bits");
}

void transportValidation() {
  constexpr uint64_t allValidFields =
      TransportValidProjectSamples | TransportValidContinuousSamples |
      TransportValidTempo | TransportValidMusicPosition |
      TransportValidCycleRange | TransportValidTimeSignature;
  TransportContext transport{allValidFields,
      TransportStatePlaying | TransportStateCycling,
      -48000, -24000, 120.0, -4.0, -8.0, 0.0, 16.0, 7, 8};
  ProcessContext context{kProcessContextInterfaceVersion,
      kProcessContextV1RequiredSize,
      {{1}, {1}, {0}, {0}, {0}, RenderTimeNone}, &transport,
      {48000.0}, {0}, nullptr, 0, nullptr, 0, {nullptr, 0},
      {DiscontinuityReason::None, DiscontinuityFlagNone}};
  expect(succeeded(validateProcessContext(context)),
         "accept coherent transport including negative pre-roll");

  transport.tempo = std::numeric_limits<double>::quiet_NaN();
  expect(!succeeded(validateProcessContext(context)), "reject NaN tempo");
  transport.tempo = std::numeric_limits<double>::infinity();
  expect(!succeeded(validateProcessContext(context)), "reject infinite tempo");
  transport.tempo = 0.0;
  expect(!succeeded(validateProcessContext(context)), "reject zero tempo");
  transport.tempo = -1.0;
  expect(!succeeded(validateProcessContext(context)), "reject negative tempo");
  transport.validFields &= ~TransportValidTempo;
  expect(succeeded(validateProcessContext(context)),
         "ignore unavailable tempo payload");
  transport.validFields |= TransportValidTempo;
  transport.tempo = 120.0;

  transport.timeSignatureNumerator = 0;
  expect(!succeeded(validateProcessContext(context)),
         "reject zero time-signature numerator");
  transport.timeSignatureNumerator = -3;
  expect(!succeeded(validateProcessContext(context)),
         "reject negative time-signature numerator");
  transport.timeSignatureNumerator = 7;
  transport.timeSignatureDenominator = 0;
  expect(!succeeded(validateProcessContext(context)),
         "reject zero time-signature denominator");
  transport.timeSignatureDenominator = -4;
  expect(!succeeded(validateProcessContext(context)),
         "reject negative time-signature denominator");
  transport.timeSignatureDenominator = 3;
  expect(!succeeded(validateProcessContext(context)),
         "reject non-power-of-two time-signature denominator");
  transport.timeSignatureDenominator = 8;

  transport.projectTimeMusic = std::numeric_limits<double>::quiet_NaN();
  expect(!succeeded(validateProcessContext(context)),
         "reject NaN musical project position");
  transport.projectTimeMusic = -4.0;
  transport.barPositionMusic = std::numeric_limits<double>::infinity();
  expect(!succeeded(validateProcessContext(context)),
         "reject infinite musical bar position");
  transport.barPositionMusic = -8.0;

  transport.cycleStartMusic = std::numeric_limits<double>::quiet_NaN();
  expect(!succeeded(validateProcessContext(context)), "reject NaN cycle start");
  transport.cycleStartMusic = 0.0;
  transport.cycleEndMusic = std::numeric_limits<double>::infinity();
  expect(!succeeded(validateProcessContext(context)), "reject infinite cycle end");
  transport.cycleEndMusic = 0.0;
  expect(!succeeded(validateProcessContext(context)), "reject empty cycle range");
  transport.cycleEndMusic = -1.0;
  expect(!succeeded(validateProcessContext(context)), "reject reversed cycle range");
  transport.cycleEndMusic = 16.0;
  transport.validFields &= ~TransportValidCycleRange;
  expect(!succeeded(validateProcessContext(context)),
         "cycling requires a valid cycle range");
  transport.stateFlags &= ~TransportStateCycling;
  expect(succeeded(validateProcessContext(context)),
         "non-cycling transport may omit the cycle range");
  transport.validFields |= TransportValidCycleRange;
  transport.stateFlags |= TransportStateCycling;
  expect(succeeded(validateProcessContext(context)),
         "accept restored coherent cycling transport");
}

void prepareWithScopedTopology(PrototypeFakeHost* host,
                               ProcessorHandle processor) {
  const AudioChannelRole roles[]{AudioChannelRole::Left,
                                 AudioChannelRole::Right};
  const AudioBusDescriptor buses[]{
      {2, SampleFormat::Float32Planar, AudioChannelLayout::Discrete, roles}};
  const PrepareSpec spec{kProcessorInterfaceVersion,
                         kPrepareSpecV1RequiredSize, {48000.0}, {64},
                         1, 1, buses, buses};
  expect(succeeded(preparePrototypeFakeHost(host, processor, spec)),
         "prepare with caller-scoped topology");
}

void prepareTopologyLifetime() {
  alignas(PrototypeGainMeterState) uint8_t storage[sizeof(PrototypeGainMeterState)]{};
  const PreparedStorage prepared{storage, sizeof(storage),
                                 alignof(PrototypeGainMeterState)};
  const ProcessorHandle processor = makePrototypeGainMeter({{17}, 1.0f}, prepared);
  PrototypeFakeHost host{};
  prepareWithScopedTopology(&host, processor);

  // Descriptor and role arrays are now out of scope. Rendering may consult
  // only the scalar topology copied during prepare.
  float inputSamples[2][8]{{1.0f}, {0.5f}};
  float outputSamples[2][8]{};
  const float* inputChannels[]{inputSamples[0], inputSamples[1]};
  float* outputChannels[]{outputSamples[0], outputSamples[1]};
  const ConstAudioBusView input{inputChannels, 2, {8}, {8}, nullptr};
  const MutableAudioBusView output{outputChannels, 2, {8}, {8}};
  expect(succeeded(processPrototypeBlock(&host, input, output, nullptr, 0,
      {DiscontinuityReason::None, DiscontinuityFlagNone})),
      "render after prepare topology lifetime ends");
  expect(outputSamples[0][0] == 1.0f && outputSamples[1][0] == 0.5f,
         "owned scalar topology renders correct channels");
  expect(succeeded(destroyPrototypeFakeHost(&host)),
         "destroy scoped-topology host");
}

void prepareTopologyAndLifecycle() {
  AudioBusDescriptor stereo{2, SampleFormat::Float32Planar, AudioChannelLayout::Stereo, nullptr};
  PrepareSpec spec{kProcessorInterfaceVersion, kPrepareSpecV1RequiredSize, {48000.0}, {256},
                   1, 1, &stereo, &stereo};
  expect(succeeded(validatePrepareSpec(spec)), "valid planar stereo topology");
  spec.sampleRate.value = std::numeric_limits<double>::quiet_NaN();
  expect(!succeeded(validatePrepareSpec(spec)), "reject NaN sample rate");
  spec.sampleRate.value = std::numeric_limits<double>::infinity();
  expect(!succeeded(validatePrepareSpec(spec)), "reject infinite sample rate");
  spec.sampleRate.value = 48000.0;
  spec.inputBuses = nullptr;
  expect(!succeeded(validatePrepareSpec(spec)), "reject missing topology array");
  spec.inputBuses = &stereo;
  AudioBusDescriptor invalidStereo{3, SampleFormat::Float32Planar, AudioChannelLayout::Stereo, nullptr};
  spec.outputBuses = &invalidStereo;
  expect(!succeeded(validatePrepareSpec(spec)), "reject invalid canonical stereo topology");
  const AudioChannelRole roles[]{AudioChannelRole::Left, AudioChannelRole::Right};
  AudioBusDescriptor discrete{2, SampleFormat::Float32Planar, AudioChannelLayout::Discrete, roles};
  spec.inputBuses = &discrete; spec.outputBuses = &discrete;
  expect(succeeded(validatePrepareSpec(spec)), "accept explicit discrete roles");

  Fixture fixture;
  ProcessorHandle live = fixture.host.processor;
  expect(!succeeded(preparePrototypeFakeHost(&fixture.host, live, spec)),
         "fake host rejects repeated prepare while active");
  PrototypeFakeHost secondHost{};
  expect(!succeeded(preparePrototypeFakeHost(&secondHost, live, spec)),
         "processor rejects repeated prepare through another host");
  expect(!succeeded(destroyProcessor(&live)), "destroy requires prior deactivate");
  auto* state = reinterpret_cast<PrototypeGainMeterState*>(fixture.storage);
  expect(succeeded(destroyPrototypeFakeHost(&fixture.host)), "host deactivates then destroys");
  expect(state->active == 0 && state->destroyed == 1 && fixture.host.processor.state == nullptr,
         "opaque state teardown completes off RT");
  PrototypeFakeHost afterDestroy{};
  expect(!succeeded(preparePrototypeFakeHost(&afterDestroy, live, spec)),
         "destroyed processor state cannot be prepared again through a stale handle");
}

void aliasSafety() {
  Fixture fixture;
  ConstAudioBusView input{fixture.inPointers, 2, {8}, {256}, nullptr};
  float* inPlace[]{fixture.in[0], fixture.in[1]};
  MutableAudioBusView exact{inPlace, 2, {8}, {256}};
  expect(succeeded(processPrototypeBlock(&fixture.host, input, exact, nullptr, 0,
      {DiscontinuityReason::None, 0})), "corresponding-channel exact in-place is supported");

  float* partial[]{fixture.in[0] + 1, fixture.out[1]};
  MutableAudioBusView partialOutput{partial, 2, {8}, {256}};
  expect(!succeeded(processPrototypeBlock(&fixture.host, input, partialOutput, nullptr, 0,
      {DiscontinuityReason::None, 0})), "partial overlap is rejected");
  float* cross[]{fixture.in[1], fixture.out[1]};
  MutableAudioBusView crossOutput{cross, 2, {8}, {256}};
  expect(!succeeded(processPrototypeBlock(&fixture.host, input, crossOutput, nullptr, 0,
      {DiscontinuityReason::None, 0})), "cross-channel overlap is rejected");
  float* duplicate[]{fixture.out[0], fixture.out[0]};
  MutableAudioBusView duplicateOutput{duplicate, 2, {8}, {256}};
  expect(!succeeded(processPrototypeBlock(&fixture.host, input, duplicateOutput, nullptr, 0,
      {DiscontinuityReason::None, 0})), "output-output overlap is rejected");
}

void discontinuityResetOwnership() {
  Fixture fixture;
  ConstAudioBusView input{fixture.inPointers, 2, {1}, {256}, nullptr};
  MutableAudioBusView output{fixture.outPointers, 2, {1}, {256}};
  ProcessContext marked{kProcessContextInterfaceVersion, kProcessContextV1RequiredSize,
      {fixture.host.clockDomain, fixture.host.streamGeneration, {0}, {0}, {0}, RenderTimeDiscontinuous},
      nullptr, {48000.0}, {1}, nullptr, 0, nullptr, 0, {nullptr, 0},
      {DiscontinuityReason::SourceSeek, DiscontinuityFlagResetState}};
  ProcessContext missingRenderMark = marked;
  missingRenderMark.time.flags = RenderTimeNone;
  expect(!succeeded(validateProcessContext(missingRenderMark)),
         "reject typed reset without render-time discontinuity mark");
  ProcessContext untypedRenderMark = marked;
  untypedRenderMark.discontinuity =
      {DiscontinuityReason::None, DiscontinuityFlagNone};
  expect(!succeeded(validateProcessContext(untypedRenderMark)),
         "reject render-time discontinuity mark without typed reason");
  fixture.host.processor.functions->process(fixture.host.processor.state, &marked, &input, 1, &output, 1);
  expect(prototypeMeter(fixture.host.processor).resetCount == 0,
         "processor does not self-reset from marked process context");

  const auto* state = static_cast<const PrototypeGainMeterState*>(fixture.host.processor.state);
  const PrototypeGainMeterState beforeRejected = *state;
  const FramePosition frameBeforeRejected = fixture.host.nextFrame;
  expect(!succeeded(fixture.block(1, nullptr, 0,
      {DiscontinuityReason::None, DiscontinuityFlagResetState})),
      "reject reset flag without typed discontinuity reason");
  expect(std::memcmp(&beforeRejected, state, sizeof(beforeRejected)) == 0 &&
         fixture.host.nextFrame.value == frameBeforeRejected.value &&
         fixture.host.resetDispatchCount == 0,
         "rejected untyped reset does not mutate processor or runner state");
  expect(!succeeded(fixture.block(1, nullptr, 0,
      {DiscontinuityReason::SourceSeek, DiscontinuityFlagNone})),
      "reject typed discontinuity without reset flag");
  expect(std::memcmp(&beforeRejected, state, sizeof(beforeRejected)) == 0 &&
         fixture.host.nextFrame.value == frameBeforeRejected.value &&
         fixture.host.resetDispatchCount == 0,
         "rejected non-reset boundary does not mutate processor or runner state");
  expect(succeeded(fixture.block(1, nullptr, 0, marked.discontinuity)), "runner processes marked block");
  expect(prototypeMeter(fixture.host.processor).resetCount == 1 && fixture.host.resetDispatchCount == 1,
         "runner owns exactly one reset before marked block");
}

void lifecycleAndVariableBlocks() {
  Fixture fixture;
  expect(succeeded(fixture.block(1)), "one frame");
  expect(succeeded(fixture.block(64)), "normal block");
  expect(succeeded(fixture.block(256)), "maximum block");
  expect(succeeded(fixture.block(17)), "changing block");
  expect(fixture.host.nextFrame.value == 338, "frame clock increments exactly");
  expect(fixture.host.processor.functions->latency(fixture.host.processor.state).value == 0, "prototype latency");
  expect(fixture.host.processor.functions->tail(fixture.host.processor.state).kind == TailKind::None, "prototype tail");

  ConstAudioBusView oversized{fixture.inPointers, 2, {257}, {256}, nullptr};
  MutableAudioBusView output{fixture.outPointers, 2, {257}, {256}};
  expect(!succeeded(processPrototypeBlock(&fixture.host, oversized, output, nullptr, 0,
                                          {DiscontinuityReason::None, 0})), "reject buffer bounds");
}

void parametersMeterAndReset() {
  Fixture fixture;
  const ParameterEvent ramp{{42}, kPrototypeGainParameter, {0}, 0.0f, ParameterCurve::Linear, {4}};
  expect(succeeded(fixture.block(4, &ramp, 1)), "linear event");
  near(fixture.out[0][0], .75f, 1e-6f, "ramp sample 0");
  near(fixture.out[0][3], 0.0f, 1e-6f, "ramp sample 3");
  auto meter = prototypeMeter(fixture.host.processor);
  near(meter.peak, .75f, 1e-6f, "meter peak");
  near(meter.rms, std::sqrt(.21875f), 1e-6f, "meter rms across channels");
  expect(meter.samples == 8, "meter sample count");

  const ParameterEvent flush{{42}, kPrototypeGainParameter, {0}, .5f, ParameterCurve::Step, {0}};
  expect(succeeded(fixture.block(0, &flush, 1)), "zero-frame event flush");
  expect(succeeded(fixture.block(1)), "post-flush render");
  near(fixture.out[0][0], .5f, 1e-6f, "zero-frame flush applies parameter");

  const ParameterEvent longRamp{{42}, kPrototypeGainParameter, {0}, 1.0f, ParameterCurve::Linear, {8}};
  expect(succeeded(fixture.block(2, &longRamp, 1)), "start long ramp");
  expect(succeeded(fixture.block(1, nullptr, 0,
      {DiscontinuityReason::SourceSeek, DiscontinuityFlagResetState})), "discontinuity render");
  meter = prototypeMeter(fixture.host.processor);
  expect(meter.resetCount == 1 && fixture.host.resetDispatchCount == 1,
         "runner dispatches discontinuity reset exactly once");
  near(fixture.out[0][0], 1.0f, 1e-6f, "reset adopts target without stale ramp");

  const ParameterEvent badOffset{{42}, kPrototypeGainParameter, {2}, .2f, ParameterCurve::Step, {0}};
  expect(!succeeded(fixture.block(1, &badOffset, 1)), "reject out-of-block event");
}

void realtimePathDoesNotAllocate() {
  allocationCount.store(0, std::memory_order_relaxed);
  countAllocations.store(true, std::memory_order_relaxed);
  void* ordinary = ::operator new(8);
  void* array = ::operator new[](8);
  void* nothrow = ::operator new(8, std::nothrow);
  void* nothrowArray = ::operator new[](8, std::nothrow);
  void* aligned = ::operator new(64, std::align_val_t{64});
  void* alignedArray = ::operator new[](64, std::align_val_t{64}, std::nothrow);
  countAllocations.store(false, std::memory_order_relaxed);
  ::operator delete(ordinary); ::operator delete[](array);
  ::operator delete(nothrow); ::operator delete[](nothrowArray);
  ::operator delete(aligned, std::align_val_t{64});
  ::operator delete[](alignedArray, std::align_val_t{64});
  expect(allocationCount.load(std::memory_order_relaxed) == 6,
         "allocation guard covers ordinary, array, aligned and nothrow new");

  Fixture fixture;
  allocationCount.store(0, std::memory_order_relaxed);
  countAllocations.store(true, std::memory_order_relaxed);
  for (uint32_t i = 0; i < 1000; ++i) {
    if (!succeeded(fixture.block((i % 255) + 1))) fail("render while allocation counter active");
  }
  countAllocations.store(false, std::memory_order_relaxed);
  expect(allocationCount.load(std::memory_order_relaxed) == 0, "steady-state render allocates nothing");
}

void latencyComposition() {
  RouteLatencySnapshot complete{kRouteLatencySnapshotVersion, kRouteLatencySnapshotV1RequiredSize,
      {7}, RouteLatencyProvenance::PlatformMeasured,
      RouteLatencyAutomaticComplete | RouteLatencyHasCapture | RouteLatencyHasInputConversion |
          RouteLatencyHasRenderDevice | RouteLatencyHasExternalRoute | RouteLatencyHasUserTrim,
      900, {100}, {3}, {2}, {20}, {30}, {-5}, {123}};
  LatencyComposition result{};
  expect(succeeded(composeRouteLatency(complete, &result)), "complete route latency");
  expect(result.captureToGraph.value == 5 && result.graphToAudible.value == 95 &&
         result.totalPresentation.value == 100, "complete estimate is not double-counted");
  complete.flags &= ~RouteLatencyAutomaticComplete;
  expect(succeeded(composeRouteLatency(complete, &result)), "component route latency");
  expect(result.graphToAudible.value == 45 && result.totalPresentation.value == 50,
         "component estimates add once");

  struct FutureLatency { RouteLatencySnapshot v1; uint64_t appended; } future{complete, 7};
  static_assert(sizeof(FutureLatency) > sizeof(RouteLatencySnapshot));
  future.v1.structSize = static_cast<uint32_t>(sizeof(FutureLatency));
  expect(succeeded(composeRouteLatency(future.v1, &result)),
         "latency accepts a future snapshot larger than V1");
  future.v1.structSize = kRouteLatencySnapshotV1RequiredSize - 1;
  expect(!succeeded(composeRouteLatency(future.v1, &result)), "latency rejects truncated V1 prefix");

  RouteLatencySnapshot overflow = complete;
  overflow.flags = RouteLatencyHasCapture | RouteLatencyHasInputConversion;
  overflow.captureDevice.value = std::numeric_limits<int64_t>::max();
  overflow.inputConversion.value = 1;
  expect(composeRouteLatency(overflow, &result).code == StatusCode::CapacityExceeded,
         "capture latency addition rejects overflow");
  overflow.flags = RouteLatencyAutomaticComplete | RouteLatencyHasUserTrim;
  overflow.captureDevice.value = 0; overflow.inputConversion.value = 0;
  overflow.automaticPresentation.value = std::numeric_limits<int64_t>::max();
  overflow.userTrim.value = 1;
  expect(composeRouteLatency(overflow, &result).code == StatusCode::CapacityExceeded,
         "presentation latency addition rejects overflow");
  overflow.flags = RouteLatencyHasCapture | RouteLatencyAutomaticComplete;
  overflow.captureDevice.value = std::numeric_limits<int64_t>::max();
  overflow.automaticPresentation.value = 1;
  overflow.userTrim.value = 0;
  expect(composeRouteLatency(overflow, &result).code == StatusCode::CapacityExceeded,
         "total latency addition rejects overflow");
  overflow.automaticPresentation.value = 0;
  expect(succeeded(composeRouteLatency(overflow, &result)) &&
         result.totalPresentation.value == std::numeric_limits<int64_t>::max(),
         "latency exact integer boundary succeeds");
}

void unknownNodeRoundTrip() {
  const uint8_t knownState[]{1, 2, 3};
  const uint8_t unknownState[]{0xde, 0xad, 0xbe, 0xef, 0x00};
  const GraphNodeRecord nodes[]{
      {{11}, {1, 2}, 3, 0, {knownState, sizeof(knownState)}},
      {{99}, {0xfeed, 0xbeef}, 77, 0x80000000u, {unknownState, sizeof(unknownState)}}};
  const GraphDocumentView source{kGraphFixtureFormatVersion, nodes, 2};
  alignas(GraphNodeRecord) uint8_t first[256]{};
  uint8_t second[256]{}; uint32_t firstSize = 0, secondSize = 0;
  expect(succeeded(encodeGraphFixture(source, {first, sizeof(first)}, &firstSize)), "encode graph fixture");

  alignas(uint32_t) uint8_t bytesOutputAlias[256]{};
  auto* bytesInOutput = reinterpret_cast<uint32_t*>(bytesOutputAlias);
  *bytesInOutput = 0x11223344u;
  expect(encodeGraphFixture(source,
      {bytesOutputAlias, sizeof(bytesOutputAlias)}, bytesInOutput).code ==
          StatusCode::InvalidArgument,
      "encode rejects bytesWritten overlapping output storage");
  expect(*bytesInOutput == 0x11223344u,
         "bytesWritten-output alias fails before mutation");

  GraphNodeRecord mutableNodes[]{nodes[0], nodes[1]};
  const GraphDocumentView mutableSource{kGraphFixtureFormatVersion,
                                        mutableNodes, 2};
  const uint32_t originalTypeVersion = mutableNodes[0].typeVersion;
  expect(encodeGraphFixture(mutableSource, {second, sizeof(second)},
      &mutableNodes[0].typeVersion).code == StatusCode::InvalidArgument,
      "encode rejects bytesWritten overlapping node descriptors");
  expect(mutableNodes[0].typeVersion == originalTypeVersion,
         "bytesWritten-node alias fails before mutation");

  alignas(uint32_t) uint8_t mutableState[8]{1, 2, 3, 4};
  GraphNodeRecord mutableStateNode{
      {12}, {3, 4}, 1, 0, {mutableState, sizeof(mutableState)}};
  const GraphDocumentView mutableStateSource{
      kGraphFixtureFormatVersion, &mutableStateNode, 1};
  const uint32_t originalStateWord =
      *reinterpret_cast<uint32_t*>(mutableState);
  expect(encodeGraphFixture(mutableStateSource, {second, sizeof(second)},
      reinterpret_cast<uint32_t*>(mutableState)).code ==
          StatusCode::InvalidArgument,
      "encode rejects bytesWritten overlapping opaque state source");
  expect(*reinterpret_cast<uint32_t*>(mutableState) == originalStateWord,
         "bytesWritten-state alias fails before mutation");

  GraphDocumentView mutableDocument = source;
  const uint32_t originalFormatVersion = mutableDocument.formatVersion;
  expect(encodeGraphFixture(mutableDocument, {second, sizeof(second)},
      &mutableDocument.formatVersion).code == StatusCode::InvalidArgument,
      "encode rejects bytesWritten overlapping document source");
  expect(mutableDocument.formatVersion == originalFormatVersion,
         "bytesWritten-document alias fails before mutation");

  alignas(GraphDocumentView) uint8_t documentOutputAlias[256]{};
  auto* documentInOutput =
      reinterpret_cast<GraphDocumentView*>(documentOutputAlias + 16);
  *documentInOutput = source;
  uint32_t documentAliasBytes = 0;
  expect(encodeGraphFixture(*documentInOutput,
      {documentOutputAlias, sizeof(documentOutputAlias)},
      &documentAliasBytes).code == StatusCode::InvalidArgument,
      "encode rejects output overlapping document source object");

  GraphNodeRecord decodedNodes[2]{}; uint8_t decodedStates[32]{};
  GraphFixtureRequirements requirements{}; GraphDocumentView decoded{};
  expect(succeeded(decodeGraphFixture({first, firstSize},
      {decodedNodes, 2, {decodedStates, sizeof(decodedStates)}}, &requirements, &decoded)),
      "decode graph fixture");
  expect(requirements.nodeCount == 2 && requirements.stateBytes == 8,
         "successful decode publishes exact storage use");
  expect(decoded.nodeCount == 2 && decoded.nodes[1].typeVersion == 77 && decoded.nodes[1].opaqueState.size == 5,
         "unknown node retained as opaque placeholder");
  expect(std::memcmp(decoded.nodes[1].opaqueState.data, unknownState, sizeof(unknownState)) == 0,
         "unknown payload retained byte-for-byte");
  first[firstSize - 1] ^= 0xff;
  expect(decoded.nodes[1].opaqueState.data[4] == 0,
         "decoded opaque state is caller-owned, not an encoded-buffer alias");
  first[firstSize - 1] ^= 0xff;
  expect(succeeded(encodeGraphFixture(decoded, {second, sizeof(second)}, &secondSize)), "re-encode graph fixture");
  expect(firstSize == secondSize && std::memcmp(first, second, firstSize) == 0, "fixture round trip deterministic");

  GraphFixtureRequirements needed{0xaaaaaaaau, 0xbbbbbbbbu};
  GraphDocumentView insufficient{0xccccccccu, nullptr, 0xddddddddu};
  GraphNodeRecord oneNode[1]{}; uint8_t tooLittleState[7]{};
  expect(decodeGraphFixture({first, firstSize}, {oneNode, 1, {tooLittleState, sizeof(tooLittleState)}},
      &needed, &insufficient).code == StatusCode::InsufficientStorage,
      "valid fixture reports insufficient caller storage only after inspection");
  expect(needed.nodeCount == 0xaaaaaaaau && needed.stateBytes == 0xbbbbbbbbu &&
         insufficient.formatVersion == 0xccccccccu &&
         insufficient.nodeCount == 0xddddddddu,
         "insufficient decode leaves out parameters untouched");

  GraphFixtureRequirements aliasRequirements{}; GraphDocumentView aliasDocument{};
  uint8_t aliasStates[16]{};
  expect(decodeGraphFixture({first, firstSize},
      {reinterpret_cast<GraphNodeRecord*>(first + 16), 2,
       {aliasStates, sizeof(aliasStates)}},
      &aliasRequirements, &aliasDocument).code == StatusCode::InvalidArgument,
      "decode rejects encoded input overlapping caller node storage");
  GraphNodeRecord aliasNodes[2]{};
  expect(decodeGraphFixture({first, firstSize},
      {aliasNodes, 2, {first + 24, 16}},
      &aliasRequirements, &aliasDocument).code == StatusCode::InvalidArgument,
      "decode rejects encoded input overlapping caller state storage");
  alignas(GraphNodeRecord) uint8_t overlappingDecodeStorage[
      sizeof(GraphNodeRecord) * 2 + 16]{};
  auto* overlappingNodes =
      reinterpret_cast<GraphNodeRecord*>(overlappingDecodeStorage);
  expect(decodeGraphFixture({first, firstSize},
      {overlappingNodes, 2,
       {overlappingDecodeStorage + sizeof(GraphNodeRecord), 16}},
      &aliasRequirements, &aliasDocument).code == StatusCode::InvalidArgument,
      "decode rejects caller node and state storage overlap");

  uint8_t encodedBeforeAlias[256]{};
  std::memcpy(encodedBeforeAlias, first, firstSize);
  expect(decodeGraphFixture({first, firstSize},
      {aliasNodes, 2, {aliasStates, sizeof(aliasStates)}},
      reinterpret_cast<GraphFixtureRequirements*>(first),
      &aliasDocument).code == StatusCode::InvalidArgument,
      "decode rejects requirements overlapping encoded input");
  expect(std::memcmp(first, encodedBeforeAlias, firstSize) == 0,
         "requirements-encoded alias fails before mutation");

  expect(decodeGraphFixture({first, firstSize},
      {aliasNodes, 2, {aliasStates, sizeof(aliasStates)}},
      reinterpret_cast<GraphFixtureRequirements*>(&aliasNodes[0]),
      &aliasDocument).code == StatusCode::InvalidArgument,
      "decode rejects requirements overlapping node storage");

  alignas(GraphFixtureRequirements) uint8_t requirementsStateAlias[32]{};
  expect(decodeGraphFixture({first, firstSize},
      {aliasNodes, 2,
       {requirementsStateAlias, sizeof(requirementsStateAlias)}},
      reinterpret_cast<GraphFixtureRequirements*>(requirementsStateAlias),
      &aliasDocument).code == StatusCode::InvalidArgument,
      "decode rejects requirements overlapping state storage");

  expect(decodeGraphFixture({first, firstSize},
      {aliasNodes, 2, {aliasStates, sizeof(aliasStates)}},
      &aliasRequirements, reinterpret_cast<GraphDocumentView*>(first)).code ==
          StatusCode::InvalidArgument,
      "decode rejects document overlapping encoded input");

  expect(decodeGraphFixture({first, firstSize},
      {aliasNodes, 2, {aliasStates, sizeof(aliasStates)}},
      &aliasRequirements,
      reinterpret_cast<GraphDocumentView*>(&aliasNodes[0])).code ==
          StatusCode::InvalidArgument,
      "decode rejects document overlapping node storage");

  alignas(GraphDocumentView) uint8_t documentStateAlias[32]{};
  expect(decodeGraphFixture({first, firstSize},
      {aliasNodes, 2, {documentStateAlias, sizeof(documentStateAlias)}},
      &aliasRequirements,
      reinterpret_cast<GraphDocumentView*>(documentStateAlias)).code ==
          StatusCode::InvalidArgument,
      "decode rejects document overlapping state storage");

  alignas(GraphDocumentView) uint8_t overlappingOutParameters[
      sizeof(GraphDocumentView)]{};
  expect(decodeGraphFixture({first, firstSize},
      {aliasNodes, 2, {aliasStates, sizeof(aliasStates)}},
      reinterpret_cast<GraphFixtureRequirements*>(overlappingOutParameters),
      reinterpret_cast<GraphDocumentView*>(overlappingOutParameters)).code ==
          StatusCode::InvalidArgument,
      "decode rejects requirements and document overlap");

  alignas(GraphNodeRecord) uint8_t descriptorAlias[256]{};
  auto* laterDescriptor =
      reinterpret_cast<GraphNodeRecord*>(descriptorAlias + 16);
  laterDescriptor[0] = nodes[1];
  const GraphDocumentView descriptorAliasDocument{
      kGraphFixtureFormatVersion, laterDescriptor, 1};
  uint32_t aliasBytes = 0;
  expect(encodeGraphFixture(descriptorAliasDocument,
      {descriptorAlias, sizeof(descriptorAlias)}, &aliasBytes).code ==
          StatusCode::InvalidArgument,
      "encode rejects output that would corrupt a later node header");

  uint8_t stateAlias[256]{};
  stateAlias[48] = 0xa5;
  const GraphNodeRecord stateAliasNode{
      {7}, {8, 9}, 1, 0, {stateAlias + 48, 1}};
  expect(encodeGraphFixture(
      {kGraphFixtureFormatVersion, &stateAliasNode, 1},
      {stateAlias, sizeof(stateAlias)}, &aliasBytes).code ==
          StatusCode::InvalidArgument,
      "encode rejects output overlapping an opaque state source");
  expect(stateAlias[48] == 0xa5,
         "encode alias rejection occurs before source corruption");

  for (uint32_t length = 0; length < firstSize; ++length) {
    GraphNodeRecord truncatedNodes[2]{}; uint8_t truncatedState[16]{};
    GraphFixtureRequirements truncatedRequirements{}; GraphDocumentView truncated{};
    expect(!succeeded(decodeGraphFixture({first, length},
        {truncatedNodes, 2, {truncatedState, sizeof(truncatedState)}},
        &truncatedRequirements, &truncated)), "every truncated prefix is rejected");
  }

  auto put32At = [](uint8_t* bytes, uint32_t offset, uint32_t value) {
    for (uint32_t i = 0; i < 4; ++i) bytes[offset + i] = static_cast<uint8_t>(value >> (8 * i));
  };
  uint8_t malformed[256]{};
  auto rejectMutation = [&](uint32_t offset, uint32_t value, const char* message) {
    std::memcpy(malformed, first, firstSize); put32At(malformed, offset, value);
    GraphNodeRecord nodesOut[2]{}; uint8_t stateOut[16]{};
    GraphFixtureRequirements req{}; GraphDocumentView doc{};
    expect(!succeeded(decodeGraphFixture({malformed, firstSize},
        {nodesOut, 2, {stateOut, sizeof(stateOut)}}, &req, &doc)), message);
  };
  rejectMutation(4, kGraphFixtureFormatVersion + 1, "unknown fixture version is rejected");
  rejectMutation(8, UINT32_MAX, "huge node count is rejected");
  rejectMutation(12, 1, "header reserved bits are rejected");
  rejectMutation(48, kGraphFixtureMaximumStateBytesPerNode + 1, "huge node state is rejected");
  rejectMutation(52, 1, "node reserved bits are rejected");

  static uint8_t maximumState[kGraphFixtureMaximumStateBytesPerNode]{};
  GraphNodeRecord tooMuchState[9]{};
  for (uint32_t i = 0; i < 9; ++i) {
    tooMuchState[i] = {{i + 1}, {1, i}, 1, 0,
                       {maximumState, kGraphFixtureMaximumStateBytesPerNode}};
  }
  uint8_t tinyOutput[1]{}; uint32_t requiredBytes = 0xabcdef01u;
  expect(encodeGraphFixture({kGraphFixtureFormatVersion, tooMuchState, 9},
      {tinyOutput, sizeof(tinyOutput)}, &requiredBytes).code == StatusCode::CapacityExceeded,
      "fixture total-state limit is enforced before output access");
  expect(encodeGraphFixture({kGraphFixtureFormatVersion, nodes, 2},
      {tinyOutput, sizeof(tinyOutput)}, &requiredBytes).code == StatusCode::InsufficientStorage &&
      requiredBytes == 0xabcdef01u,
      "insufficient encode leaves bytesWritten untouched");

  uint32_t random = 0x13579bdfu;
  for (uint32_t iteration = 0; iteration < 4000; ++iteration) {
    std::memcpy(malformed, first, firstSize);
    random = random * 1664525u + 1013904223u;
    const uint32_t mutations = 1 + (random & 3u);
    for (uint32_t mutation = 0; mutation < mutations; ++mutation) {
      random = random * 1664525u + 1013904223u;
      malformed[random % firstSize] ^= static_cast<uint8_t>((random >> 16) | 1u);
    }
    random = random * 1664525u + 1013904223u;
    const uint32_t fuzzSize = (random & 7u) == 0 ? random % firstSize : firstSize;
    GraphNodeRecord fuzzNodes[kGraphFixtureMaximumNodes]{}; uint8_t fuzzStates[32]{};
    GraphFixtureRequirements req{}; GraphDocumentView doc{};
    const Status status = decodeGraphFixture({malformed, fuzzSize},
        {fuzzNodes, kGraphFixtureMaximumNodes, {fuzzStates, sizeof(fuzzStates)}}, &req, &doc);
    if (succeeded(status)) {
      expect(req.nodeCount <= kGraphFixtureMaximumNodes && req.stateBytes <= sizeof(fuzzStates),
             "deterministic fuzz success respects decoded capacities");
    }
  }
}

}  // namespace

int main() {
  appendCompatiblePrefixesAndTransportBits();
  transportValidation();
  prepareTopologyAndLifecycle();
  prepareTopologyLifetime();
  lifecycleAndVariableBlocks();
  aliasSafety();
  discontinuityResetOwnership();
  parametersMeterAndReset();
  realtimePathDoesNotAllocate();
  latencyComposition();
  unknownNodeRoundTrip();
  std::puts("zdsp contract tests passed");
  return 0;
}
