#include <zdsp/analysis/pitch_analysis_module.h>
#include <zdsp/analysis/crepe_tiny.h>
#include <zdsp/graph_runner.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <stdexcept>
#include <vector>

namespace zdsp::analysis {
struct PitchAnalysisModule::Impl {
  static constexpr uint32_t capacity = 8;
  struct Slot {
    std::vector<float> pcm;
    singz::AudioInputBlockView block;
  };
  PitchAnalysisConfig config;
  std::unique_ptr<CrepeTiny> crepe;
  std::unique_ptr<LiveInputAnalysisAdapter> adapter;
  std::array<Slot, capacity> slots;
  std::atomic<uint32_t> write{0}, read{0}, dropped{0};
  std::vector<uint8_t> arenaBytes;
  std::vector<float> output;
  RealtimeArena arena{};
  GraphCompileResult compiled{};
  SnapshotPublisher publisher{};
  RetirementSlot retirement[1]{};
  RuntimeDiagnostics diagnostics{};
  PublishedGraphSnapshot snapshot{};
  GraphRunner runner{};
  double graphRate = 0;
  bool graphLive = false;

  explicit Impl(PitchAnalysisConfig value) : config(std::move(value)) {
    if (!config.maximumBlockFrames || config.maximumBlockFrames > 16384)
      throw std::invalid_argument("Pitch analysis block capacity must be 1..16384");
    auto analyzer = config.analyzer;
    int rate = config.analysisRate;
    size_t frames = config.windowFrames, hop = config.hopFrames;
    if (config.detector == PitchDetectorKind::CrepeTiny) {
      crepe = std::make_unique<CrepeTiny>(config.modelPath);
      analyzer = [this](const float* pcm, size_t n, double r) { return crepe->analyze(pcm, n, r); };
      rate = 16000; frames = 1024; hop = 320;
    } else if (config.detector == PitchDetectorKind::Yin) {
      analyzer = {}; rate = 0; frames = 2048; hop = 512;
    } else if (!analyzer) throw std::invalid_argument("Custom pitch detector needs an analyzer");
    adapter = std::make_unique<LiveInputAnalysisAdapter>(config.generation, analyzer, rate, frames, hop);
    for (auto& slot : slots) slot.pcm.resize(config.maximumBlockFrames);
    output.resize(config.maximumBlockFrames);
    arenaBytes.resize(256 * 1024 + config.maximumBlockFrames * 16);
  }
  ~Impl() { closeGraph(); }
  void closeGraph() noexcept {
    if (!graphLive) return;
    PublishedGraphSnapshot* retired[2]{};
    uint32_t count = 0;
    (void)shutdownGraphRunner(&runner, retired, 2, &count);
    (void)deactivateCompiledGraph(compiled.graph);
    compiled = {};
    graphLive = false;
  }
  static Status prepare(void* state, const PrepareSpec* spec, const PreparedStorage*) noexcept {
    auto& self = *static_cast<Impl*>(state);
    if (spec->maximumBlockFrames.value > self.config.maximumBlockFrames ||
        spec->inputBusCount != 1 || spec->outputBusCount != 1 ||
        spec->inputBuses[0].channelCount != 1 || spec->outputBuses[0].channelCount != 1)
      return {StatusCode::UnsupportedFormat, 0};
    return okStatus();
  }
  static void reset(void*, Discontinuity) noexcept {}
  static void process(void* state, const ProcessContext* context,
                      const ConstAudioBusView* inputs, uint32_t inputCount,
                      const MutableAudioBusView* outputs, uint32_t outputCount) noexcept {
    auto& self = *static_cast<Impl*>(state);
    if (inputCount != 1 || outputCount != 1 || !inputs || !outputs ||
        !isValid(inputs[0]) || !isValid(outputs[0]) ||
        inputs[0].channelCount != 1 || outputs[0].channelCount != 1 ||
        context->frames.value > inputs[0].frames.value ||
        context->frames.value > outputs[0].frames.value) return;
    const auto& input = inputs[0];
    const uint32_t frames = context->frames.value;
    std::copy_n(input.channels[0], frames, outputs[0].channels[0]);
    if ((processContextFlags(*context) & ProcessContextFlagTailDrain) || !input.capture ||
        frames > self.config.maximumBlockFrames) return;
    const uint32_t w = self.write.load(std::memory_order_relaxed);
    if (w - self.read.load(std::memory_order_acquire) >= capacity) {
      self.dropped.fetch_add(1, std::memory_order_relaxed); return;
    }
    auto& slot = self.slots[w % capacity];
    std::copy_n(input.channels[0], frames, slot.pcm.data());
    const auto& capture = *input.capture;
    auto& block = slot.block;
    block = {};
    block.capture.clockDomainId = capture.clockDomain.value;
    block.capture.streamGeneration = capture.streamGeneration.value;
    block.capture.sequence = block.sequence = capture.sequence;
    block.capture.sourceFrame = capture.sourceFrame.value;
    block.capture.sampleHostTimeNs = block.sampleHostTimeNs = capture.sampleHostTime.value;
    block.capture.callbackHostTimeNs = block.callbackHostTimeNs = capture.callbackHostTime.value;
    block.capture.timestampQuality = block.timestampQuality =
      capture.quality == CaptureTimestampQuality::Hardware ? singz::AudioInputTimestampQuality::Hardware :
      capture.quality == CaptureTimestampQuality::Estimated ? singz::AudioInputTimestampQuality::CallbackEstimate :
      singz::AudioInputTimestampQuality::Unknown;
    block.capture.flags =
      ((capture.flags & CaptureTimeSourceFrameValid) ? singz::AudioInputSourceFrameValid : 0u) |
      ((capture.flags & CaptureTimeSampleHostValid) ? singz::AudioInputSampleHostTimeValid : 0u) |
      ((capture.flags & CaptureTimeCallbackHostValid) ? singz::AudioInputCallbackHostTimeValid : 0u) |
      ((capture.flags & CaptureTimeTimestampQualityValid) ? singz::AudioInputTimestampQualityValid : 0u) |
      ((capture.flags & CaptureTimeStaleAnchor) ? singz::AudioInputStaleAnchor : 0u);
    switch (capture.discontinuity.reason) {
      case DiscontinuityReason::StreamGenerationChanged: block.capture.discontinuity = singz::AudioInputDiscontinuityReason::StreamGenerationChanged; break;
      case DiscontinuityReason::SequenceGap: block.capture.discontinuity = singz::AudioInputDiscontinuityReason::SequenceGap; break;
      case DiscontinuityReason::SampleRateChanged: block.capture.discontinuity = singz::AudioInputDiscontinuityReason::SampleRateChanged; break;
      case DiscontinuityReason::TimestampQualityChanged: block.capture.discontinuity = singz::AudioInputDiscontinuityReason::TimestampQualityChanged; break;
      case DiscontinuityReason::ClockReanchored: block.capture.discontinuity = singz::AudioInputDiscontinuityReason::ClockReanchored; break;
      case DiscontinuityReason::DeviceLost: block.capture.discontinuity = singz::AudioInputDiscontinuityReason::DeviceLost; break;
      case DiscontinuityReason::SourceFrameOverflow: block.capture.discontinuity = singz::AudioInputDiscontinuityReason::SourceFrameOverflow; break;
      default:
        if (capture.discontinuity.reason != DiscontinuityReason::None) {
          block.capture.discontinuity = singz::AudioInputDiscontinuityReason::ClockReanchored;
        }
        break;
    }
    if (block.capture.discontinuity != singz::AudioInputDiscontinuityReason::None)
      block.capture.flags |= singz::AudioInputDiscontinuous;
    block.sampleRate = context->sampleRate.value;
    block.mono = slot.pcm.data(); block.frames = frames;
    self.write.store(w + 1, std::memory_order_release);
  }
  static LatencyFrames latency(const void*) noexcept { return {0}; }
  static TailInfo tail(const void*) noexcept { return {TailKind::None, {0}}; }
  static Status deactivate(void*) noexcept { return okStatus(); }
  static Status destroy(void*) noexcept { return okStatus(); } // borrowed module owns state
  static const ProcessorVTable vtable;
  ProcessorHandle processor() noexcept { return {this, &vtable}; }
  bool configure(double rate) {
    if (graphLive && graphRate == rate) return true;
    closeGraph();
    if (!std::isfinite(rate) || rate <= 0) return false;
    if (!succeeded(initializeArena(&arena, {arenaBytes.data(), static_cast<uint32_t>(arenaBytes.size())}))) return false;
    const AudioBusDescriptor mono{1, SampleFormat::Float32Planar, AudioChannelLayout::Mono, nullptr};
    const GraphNodeDescription nodes[] = {
      {{1}, {0,1}, 1, GraphNodeRole::Input, 0, 0, 1, nullptr, &mono, {}, {}},
      {{2}, kPitchAnalysisTapNodeType, kPitchAnalysisTapSchemaVersion, GraphNodeRole::Processor, GraphNodeFlagMayProcessInPlace,
        1, 1, &mono, &mono, processor(), {}},
      {{3}, {0,3}, 1, GraphNodeRole::Output, 0, 1, 0, &mono, nullptr, {}, {}}
    };
    const GraphConnection connections[] = {{{1},0,{2},0}, {{2},0,{3},0}};
    const GraphDescription description{kGraphFormatVersion, {rate}, {config.maximumBlockFrames}, nodes, 3, connections, 2};
    GraphCompileError error{};
    if (!succeeded(compileGraph(description, &arena, &compiled, &error))) return false;
    initializePublisher(&publisher, retirement, 1, &diagnostics);
    TransitionPlan transition{};
    transition.infiniteTailPolicy = InfiniteTailPolicy::Cut;
    transition.combinedCpuLimitPermille = 1000;
    snapshot = {compiled.graph, 1, transition, 0};
    if (!succeeded(submitSnapshot(&publisher, &snapshot).status)) {
      compiled = {}; return false;
    }
    initializeGraphRunner(&runner, &publisher, {}, nullptr, nullptr, &diagnostics);
    graphRate = rate; graphLive = true;
    return true;
  }
};
const ProcessorVTable PitchAnalysisModule::Impl::vtable{
  kProcessorInterfaceVersion, sizeof(ProcessorVTable), prepare, reset, process,
  latency, tail, deactivate, destroy, nullptr
};
PitchAnalysisModule::PitchAnalysisModule(PitchAnalysisConfig config) : impl_(std::make_unique<Impl>(std::move(config))) {}
PitchAnalysisModule::~PitchAnalysisModule() = default;
ProcessorHandle PitchAnalysisModule::graphProcessor() noexcept { return impl_->processor(); }
void PitchAnalysisModule::cancel(uint64_t generation) noexcept { impl_->adapter->cancel(generation); }
void PitchAnalysisModule::drain(const LiveInputAnalysisAdapter::Sink& sink) {
  if (inGraphRenderCallback()) throw std::logic_error("Pitch inference cannot run in the graph callback");
  auto& self = *impl_;
  uint32_t r = self.read.load(std::memory_order_relaxed);
  const uint32_t w = self.write.load(std::memory_order_acquire);
  // Bound recovery latency after a slow inference. Discard stale queued blocks;
  // their source-frame/sequence gap resets the adapter rather than blending them.
  if (w - r > 2) { self.dropped.fetch_add(w-r-2, std::memory_order_relaxed); r = w-2; }
  while (r != w) {
    self.adapter->push(self.slots[r % Impl::capacity].block, sink);
    self.read.store(++r, std::memory_order_release);
  }
}
bool PitchAnalysisModule::push(const singz::AudioInputBlockView& block, const LiveInputAnalysisAdapter::Sink& sink) {
  auto& self = *impl_;
  CaptureTime capture{};
  if (!block.mono || !block.frames || block.frames > self.config.maximumBlockFrames ||
      !mapCaptureMetadata(block, capture) || !self.configure(block.sampleRate)) return false;
  const float* channels[] = {block.mono}; float* output[] = {self.output.data()};
  const ConstAudioBusView input{channels, 1, {block.frames}, {block.frames}, &capture};
  const MutableAudioBusView destination{output, 1, {block.frames}, {self.config.maximumBlockFrames}};
  ProcessContext context{};
  context.interfaceVersion = kProcessContextInterfaceVersion; context.structSize = sizeof(context);
  context.sampleRate = {block.sampleRate}; context.frames = {block.frames};
  context.time.clockDomain = capture.clockDomain; context.time.streamGeneration = capture.streamGeneration;
  context.time.graphFrame = capture.sourceFrame;
  const bool rendered = succeeded(renderGraphBlock(&self.runner, context, &input, 1, &destination, 1));
  if (rendered) drain(sink);
  return rendered;
}
const char* PitchAnalysisModule::detectorName() const noexcept {
  return impl_->crepe ? "crepe-tiny" : impl_->config.detector == PitchDetectorKind::Yin ? "yin" : "custom";
}
double PitchAnalysisModule::inferenceMs() const noexcept { return impl_->crepe ? impl_->crepe->inferenceMs : 0; }
bool PitchAnalysisModule::harmonicCorrected() const noexcept { return impl_->crepe && impl_->crepe->harmonicCorrected; }
float PitchAnalysisModule::appliedGain() const noexcept { return impl_->adapter->appliedGain(); }
uint32_t PitchAnalysisModule::droppedBlocks() const noexcept { return impl_->dropped.load(std::memory_order_relaxed); }
}  // namespace zdsp::analysis
