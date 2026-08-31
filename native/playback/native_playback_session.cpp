#include "native_playback_session.h"

#include "native_playback_callback.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <mutex>
#include <new>
#include <stdexcept>
#include <type_traits>
#include <utility>

#include <zdsp/audio_host_graph_adapter.h>
#include <zdsp/builtin_nodes.h>
#include <zdsp/decoded_buffer_source.h>
#include <zdsp/graph.h>
#include <zdsp/graph_runner.h>
#include <zdsp/realtime_arena.h>

namespace singz {
namespace {

constexpr uint64_t kLaneNodeBase = 100;
constexpr uint64_t kMixNode = 1000;
constexpr uint64_t kMasterNode = 1001;
constexpr uint64_t kLimiterNode = 1002;
constexpr uint64_t kOutputNode = 1003;
constexpr size_t kArenaBaseBytes = 4u * 1024u * 1024u;
constexpr size_t kMaximumArenaBytes = 256u * 1024u * 1024u;

NativePlaybackResult failure(NativePlaybackError error, uint64_t generation,
                             NativePlaybackState state, std::string message) {
  return {false, error, generation, state, {}, {}, std::move(message)};
}

NativePlaybackResult failureWithoutMessage(NativePlaybackError error,
                                           uint64_t generation,
                                           NativePlaybackState state) noexcept {
  NativePlaybackResult result;
  result.ok = false;
  result.error = error;
  result.generation = generation;
  result.state = state;
  return result;
}

bool finiteGain(float gain) noexcept {
  return std::isfinite(gain) && gain >= 0.0F &&
         gain <= kNativePlaybackMaximumLinearGain;
}

bool validChannels(const std::vector<uint32_t> &channels) noexcept {
  if (channels.empty() || channels.size() > zdsp::kMaximumChannelsPerBus)
    return false;
  for (size_t index = 0; index < channels.size(); ++index) {
    if (channels[index] >= kAudioHostMaxChannels)
      return false;
    for (size_t prior = 0; prior < index; ++prior)
      if (channels[index] == channels[prior])
        return false;
  }
  return true;
}

zdsp::AudioBusDescriptor descriptor(
    uint32_t channels,
    std::array<zdsp::AudioChannelRole, zdsp::kMaximumChannelsPerBus> *roles) {
  if (channels == 1) {
    return {1, zdsp::SampleFormat::Float32Planar,
            zdsp::AudioChannelLayout::Mono, nullptr};
  }
  if (channels == 2) {
    return {2, zdsp::SampleFormat::Float32Planar,
            zdsp::AudioChannelLayout::Stereo, nullptr};
  }
  for (uint32_t channel = 0; channel < channels; ++channel)
    (*roles)[channel] = zdsp::AudioChannelRole::Discrete;
  return {channels, zdsp::SampleFormat::Float32Planar,
          zdsp::AudioChannelLayout::Discrete, roles->data()};
}

uint64_t presentationLatencyFrames(const AudioHostLatency &latency) noexcept {
  uint64_t total = latency.outputDeviceFrames;
  total += latency.bufferFrames;
  total += latency.externalRouteFrames;
  return total;
}

bool safeStoppedState(AudioHostState state) noexcept {
  return state == AudioHostState::Stopped || state == AudioHostState::Closed;
}

AudioHostTerminalCause
effectiveTerminalCause(const AudioHostStatus &host,
                       AudioHostTerminalCause callback) noexcept {
  AudioHostTerminalCause hostCause{host.terminalReason, host.terminalOrdinal};
  if (hostCause.reason != AudioHostTerminalReason::None &&
      hostCause.ordinal == 0)
    hostCause = makeAudioHostTerminalCause(hostCause.reason);
  if (hostCause.reason == AudioHostTerminalReason::None &&
      host.state == AudioHostState::DeviceLost)
    hostCause = makeAudioHostTerminalCause(AudioHostTerminalReason::DeviceLost);
  if (hostCause.reason == AudioHostTerminalReason::None &&
      host.state == AudioHostState::Error)
    hostCause =
        makeAudioHostTerminalCause(AudioHostTerminalReason::ProviderFailure);
  return firstAudioHostTerminalCause(hostCause, callback);
}

NativePlaybackError decodeError(DecodedAudioStatus status) noexcept {
  switch (status) {
  case DecodedAudioStatus::Cancelled:
    return NativePlaybackError::Cancelled;
  case DecodedAudioStatus::LimitExceeded:
    return NativePlaybackError::LimitExceeded;
  case DecodedAudioStatus::ResourceExhausted:
    return NativePlaybackError::ResourceExhausted;
  case DecodedAudioStatus::Ok:
  case DecodedAudioStatus::InvalidArgument:
  case DecodedAudioStatus::IoError:
  case DecodedAudioStatus::UnsupportedFormat:
  case DecodedAudioStatus::MalformedData:
    return NativePlaybackError::DecodeFailure;
  }
  return NativePlaybackError::DecodeFailure;
}

void injectFailure(NativePlaybackTestHooks *hooks,
                   NativePlaybackAllocationPoint point) {
  if (hooks == nullptr || hooks->inject == nullptr)
    return;
  switch (hooks->inject(hooks->context, point)) {
  case NativePlaybackInjectedFailure::None:
    return;
  case NativePlaybackInjectedFailure::BadAllocation:
    throw std::bad_alloc();
  case NativePlaybackInjectedFailure::Unexpected:
    throw point;
  }
}

struct PreparedPlaybackGraph {
  struct Lane {
    std::string id;
    std::shared_ptr<const DecodedAudio> owner;
    std::array<const float *, zdsp::kMaximumChannelsPerBus> channelPointers{};
    std::array<zdsp::AudioChannelRole, zdsp::kMaximumChannelsPerBus> roles{};
    zdsp::AudioBusDescriptor sourceBus{};
    zdsp::ProcessorHandle source{};
    zdsp::ProcessorHandle gainProcessor{};
    mutable zdsp::DecodedBufferSourceCursorReader cursorReader{};
    float gain{1.0F};
    bool muted{false};
    bool solo{false};
  };

  PreparedPlaybackGraph(std::vector<Lane> decoded, double sampleRate,
                        uint32_t outputChannels, uint32_t maximumFrames,
                        float initialMaster, NativePlaybackTestHooks *hooks)
      : lanes(std::move(decoded)), sampleRate(sampleRate),
        outputChannels(outputChannels), maximumFrames(maximumFrames),
        masterGain(initialMaster), testHooks(hooks) {
    const uint64_t logicalBuffers = lanes.size() * 4u + 8u;
    const uint64_t sampleBytes =
        logicalBuffers * outputChannels * maximumFrames * sizeof(float);
    const uint64_t requested = kArenaBaseBytes + sampleBytes;
    if (requested <= kMaximumArenaBytes &&
        requested <= std::numeric_limits<uint32_t>::max())
      arenaBytes.resize(static_cast<size_t>(requested));
  }

  ~PreparedPlaybackGraph() {
    if (runnerInitialized || graph != nullptr || !lanes.empty())
      (void)shutdown();
  }

  std::vector<Lane> lanes;
  std::vector<uint8_t> arenaBytes;
  zdsp::RealtimeArena arena{};
  zdsp::CompiledGraph *graph{nullptr};
  zdsp::ProcessorHandle masterProcessor{};
  zdsp::RuntimeDiagnostics diagnostics{};
  zdsp::RetirementSlot retirement[1]{};
  zdsp::SnapshotPublisher publisher{};
  zdsp::PublishedGraphSnapshot snapshot{};
  zdsp::ParameterQueue parameters{};
  zdsp::GraphRunner runner{};
  zdsp::AudioHostGraphAdapter adapter{};
  NativePlaybackCallbackState callback{};
  double sampleRate{0.0};
  uint32_t outputChannels{0};
  uint32_t maximumFrames{0};
  float masterGain{1.0F};
  bool runnerInitialized{false};
  bool telemetryLive{true};
  size_t retainedBytes{0};
  NativePlaybackTestHooks *testHooks{nullptr};

  void observe(NativePlaybackLifecycleEvent event) noexcept {
    if (testHooks != nullptr && testHooks->observe != nullptr)
      testHooks->observe(testHooks->context, event);
  }

  void inject(NativePlaybackAllocationPoint point) {
    injectFailure(testHooks, point);
  }

  zdsp::ProcessorHandle makeBuiltin(const zdsp::BuiltinNodeConfig &config,
                                    void **durable, size_t *durableBytes) {
    const size_t stateBytes = zdsp::builtinStateBytes(config);
    void *state = zdsp::arenaAllocate(&arena, stateBytes, 64);
    if (state == nullptr)
      return {};
    zdsp::ProcessorHandle processor = zdsp::createBuiltinProcessor(
        config,
        {static_cast<uint8_t *>(state), static_cast<uint32_t>(stateBytes)});
    if (processor.state == nullptr)
      return {};
    *durableBytes = zdsp::builtinPreparedBytes(config, {maximumFrames});
    *durable = *durableBytes == 0
                   ? nullptr
                   : zdsp::arenaAllocate(&arena, *durableBytes, alignof(float));
    if (*durableBytes != 0 && *durable == nullptr) {
      (void)zdsp::destroyProcessor(&processor);
      return {};
    }
    return processor;
  }

  zdsp::Status prepare(zdsp::GraphCompileError *compileError) {
    if (arenaBytes.empty())
      return {zdsp::StatusCode::InsufficientStorage, 1};
    const zdsp::Status initialized = zdsp::initializeArena(
        &arena, {arenaBytes.data(), static_cast<uint32_t>(arenaBytes.size())});
    if (!zdsp::succeeded(initialized))
      return initialized;

    std::array<zdsp::AudioChannelRole, zdsp::kMaximumChannelsPerBus>
        outputRoles{};
    const zdsp::AudioBusDescriptor outputBus =
        descriptor(outputChannels, &outputRoles);
    const bool anySolo = std::any_of(
        lanes.begin(), lanes.end(), [](const Lane &lane) { return lane.solo; });

    std::vector<zdsp::GraphNodeDescription> nodes;
    std::vector<zdsp::GraphConnection> connections;
    std::vector<zdsp::AudioBusDescriptor> mixInputs(lanes.size(), outputBus);
    std::vector<std::array<float, zdsp::kMaximumChannelsPerBus *
                                      zdsp::kMaximumChannelsPerBus>>
        matrices(lanes.size());
    std::vector<zdsp::ProcessorHandle> mapProcessors(lanes.size());
    std::vector<void *> mapDurable(lanes.size());
    std::vector<size_t> mapDurableBytes(lanes.size());
    std::vector<void *> gainDurable(lanes.size());
    std::vector<size_t> gainDurableBytes(lanes.size());
    nodes.reserve(lanes.size() * 3u + 4u);
    connections.reserve(lanes.size() * 3u + 3u);

    for (size_t index = 0; index < lanes.size(); ++index) {
      Lane &lane = lanes[index];
      const uint32_t sourceChannels = lane.owner->channelCount();
      lane.sourceBus = descriptor(sourceChannels, &lane.roles);
      for (uint32_t channel = 0; channel < sourceChannels; ++channel)
        lane.channelPointers[channel] = lane.owner->channelData(channel);
      const uint64_t sourceNode = kLaneNodeBase + index * 3u;
      const uint64_t mapNode = sourceNode + 1u;
      const uint64_t gainNode = sourceNode + 2u;

      const size_t sourceBytes = zdsp::decodedBufferSourceStateBytes();
      void *sourceState = zdsp::arenaAllocate(&arena, sourceBytes, 64);
      if (sourceState == nullptr)
        return {zdsp::StatusCode::InsufficientStorage, 2};
      lane.source =
          zdsp::createDecodedBufferSource({{sourceNode},
                                           {lane.channelPointers.data(),
                                            sourceChannels,
                                            lane.owner->frameCount(),
                                            {sampleRate}}},
                                          {static_cast<uint8_t *>(sourceState),
                                           static_cast<uint32_t>(sourceBytes)});
      if (lane.source.state == nullptr)
        return {zdsp::StatusCode::InsufficientStorage, 3};

      auto &matrix = matrices[index];
      if (sourceChannels == 1) {
        for (uint32_t out = 0; out < outputChannels; ++out)
          matrix[out * sourceChannels] = 1.0F;
      } else if (outputChannels == 1) {
        const float scale = 1.0F / static_cast<float>(sourceChannels);
        for (uint32_t in = 0; in < sourceChannels; ++in)
          matrix[in] = scale;
      } else {
        const uint32_t matching = std::min(sourceChannels, outputChannels);
        for (uint32_t channel = 0; channel < matching; ++channel)
          matrix[channel * sourceChannels + channel] = 1.0F;
      }
      const zdsp::BuiltinNodeConfig mapConfig{zdsp::BuiltinNodeKind::ChannelMap,
                                              {mapNode},
                                              sourceChannels,
                                              outputChannels,
                                              1,
                                              0.0F,
                                              0.0F,
                                              0,
                                              zdsp::OscillatorWaveform::Saw,
                                              matrix.data(),
                                              0};
      const float effective =
          lane.muted || (anySolo && !lane.solo) ? 0.0F : lane.gain;
      const zdsp::BuiltinNodeConfig gainConfig{zdsp::BuiltinNodeKind::Gain,
                                               {gainNode},
                                               outputChannels,
                                               outputChannels,
                                               1,
                                               effective,
                                               0.0F,
                                               0,
                                               zdsp::OscillatorWaveform::Saw,
                                               nullptr,
                                               0};
      mapProcessors[index] =
          makeBuiltin(mapConfig, &mapDurable[index], &mapDurableBytes[index]);
      lane.gainProcessor = makeBuiltin(gainConfig, &gainDurable[index],
                                       &gainDurableBytes[index]);
      if (mapProcessors[index].state == nullptr ||
          lane.gainProcessor.state == nullptr)
        return {zdsp::StatusCode::InsufficientStorage, 4};

      nodes.push_back({{sourceNode},
                       {3, sourceNode},
                       1,
                       zdsp::GraphNodeRole::Processor,
                       zdsp::GraphNodeFlagNone,
                       0,
                       1,
                       nullptr,
                       &lane.sourceBus,
                       lane.source,
                       {nullptr, 0, 1}});
      nodes.push_back(
          {{mapNode},
           {1, static_cast<uint64_t>(zdsp::BuiltinNodeKind::ChannelMap)},
           1,
           zdsp::GraphNodeRole::Processor,
           zdsp::GraphNodeFlagMayProcessInPlace,
           1,
           1,
           &lane.sourceBus,
           &outputBus,
           mapProcessors[index],
           {mapDurable[index], mapDurableBytes[index], alignof(float)}});
      nodes.push_back(
          {{gainNode},
           {1, static_cast<uint64_t>(zdsp::BuiltinNodeKind::Gain)},
           1,
           zdsp::GraphNodeRole::Processor,
           zdsp::GraphNodeFlagMayProcessInPlace,
           1,
           1,
           &outputBus,
           &outputBus,
           lane.gainProcessor,
           {gainDurable[index], gainDurableBytes[index], alignof(float)}});
      connections.push_back({{sourceNode}, 0, {mapNode}, 0});
      connections.push_back({{mapNode}, 0, {gainNode}, 0});
      connections.push_back(
          {{gainNode}, 0, {kMixNode}, static_cast<uint32_t>(index)});
      retainedBytes += lane.owner->retainedBytes();
    }

    const zdsp::BuiltinNodeConfig finalConfigs[] = {
        {zdsp::BuiltinNodeKind::Mix,
         {kMixNode},
         outputChannels,
         outputChannels,
         static_cast<uint32_t>(lanes.size()),
         0.0F,
         0.0F,
         0,
         zdsp::OscillatorWaveform::Saw,
         nullptr,
         0},
        {zdsp::BuiltinNodeKind::Gain,
         {kMasterNode},
         outputChannels,
         outputChannels,
         1,
         masterGain,
         0.0F,
         0,
         zdsp::OscillatorWaveform::Saw,
         nullptr,
         0},
        {zdsp::BuiltinNodeKind::SafetyLimiter,
         {kLimiterNode},
         outputChannels,
         outputChannels,
         1,
         kNativePlaybackLimiterCeiling,
         0.0F,
         0,
         zdsp::OscillatorWaveform::Saw,
         nullptr,
         0},
    };
    std::array<zdsp::ProcessorHandle, 3> finalProcessors{};
    std::array<void *, 3> finalDurable{};
    std::array<size_t, 3> finalDurableBytes{};
    for (size_t index = 0; index < finalProcessors.size(); ++index) {
      finalProcessors[index] = makeBuiltin(
          finalConfigs[index], &finalDurable[index], &finalDurableBytes[index]);
      if (finalProcessors[index].state == nullptr)
        return {zdsp::StatusCode::InsufficientStorage, 5};
    }
    masterProcessor = finalProcessors[1];
    nodes.push_back({{kMixNode},
                     {1, static_cast<uint64_t>(zdsp::BuiltinNodeKind::Mix)},
                     1,
                     zdsp::GraphNodeRole::Processor,
                     zdsp::GraphNodeFlagNone,
                     static_cast<uint32_t>(lanes.size()),
                     1,
                     mixInputs.data(),
                     &outputBus,
                     finalProcessors[0],
                     {finalDurable[0], finalDurableBytes[0], alignof(float)}});
    nodes.push_back({{kMasterNode},
                     {1, static_cast<uint64_t>(zdsp::BuiltinNodeKind::Gain)},
                     1,
                     zdsp::GraphNodeRole::Processor,
                     zdsp::GraphNodeFlagMayProcessInPlace,
                     1,
                     1,
                     &outputBus,
                     &outputBus,
                     finalProcessors[1],
                     {finalDurable[1], finalDurableBytes[1], alignof(float)}});
    nodes.push_back(
        {{kLimiterNode},
         {1, static_cast<uint64_t>(zdsp::BuiltinNodeKind::SafetyLimiter)},
         1,
         zdsp::GraphNodeRole::Processor,
         zdsp::GraphNodeFlagMayProcessInPlace,
         1,
         1,
         &outputBus,
         &outputBus,
         finalProcessors[2],
         {finalDurable[2], finalDurableBytes[2], alignof(float)}});
    nodes.push_back({{kOutputNode},
                     {0, kOutputNode},
                     1,
                     zdsp::GraphNodeRole::Output,
                     zdsp::GraphNodeFlagNone,
                     1,
                     0,
                     &outputBus,
                     nullptr,
                     {},
                     {}});
    connections.push_back({{kMixNode}, 0, {kMasterNode}, 0});
    connections.push_back({{kMasterNode}, 0, {kLimiterNode}, 0});
    connections.push_back({{kLimiterNode}, 0, {kOutputNode}, 0});

    const zdsp::GraphDescription description{
        zdsp::kGraphFormatVersion,
        {sampleRate},
        {maximumFrames},
        nodes.data(),
        static_cast<uint32_t>(nodes.size()),
        connections.data(),
        static_cast<uint32_t>(connections.size())};
    zdsp::GraphCompileResult compiled{};
    const zdsp::Status compileStatus =
        zdsp::compileGraph(description, &arena, &compiled, compileError);
    if (!zdsp::succeeded(compileStatus)) {
      (void)zdsp::cleanupFailedCompile(&compiled);
      return compileStatus;
    }
    graph = compiled.graph;
    zdsp::initializePublisher(&publisher, retirement, 1, &diagnostics);
    const zdsp::TransitionPlan hardCut{zdsp::TransitionKind::HardCut,
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
    snapshot = {graph, 1, hardCut, 0};
    const zdsp::PublicationResult published =
        zdsp::submitSnapshot(&publisher, &snapshot);
    if (!zdsp::succeeded(published.status)) {
      (void)zdsp::deactivateCompiledGraph(graph);
      graph = nullptr;
      return published.status;
    }
    zdsp::initializeGraphRunner(&runner, &publisher, {}, &parameters, nullptr,
                                &diagnostics);
    runnerInitialized = true;
    adapter.runner = &runner;
    callback.adapter = &adapter;
    return zdsp::okStatus();
  }

  bool enqueueGain(zdsp::NodeId node, float value) noexcept {
    return zdsp::enqueueParameter(&parameters,
                                  {node,
                                   zdsp::kGainParameter,
                                   {0},
                                   value,
                                   zdsp::ParameterCurve::Linear,
                                   {kNativePlaybackGainRampFrames}},
                                  &diagnostics);
  }

  bool applyLaneGains() noexcept {
    const bool anySolo = std::any_of(
        lanes.begin(), lanes.end(), [](const Lane &lane) { return lane.solo; });
    std::array<zdsp::ParameterEvent, kNativePlaybackMaximumLanes> events{};
    for (size_t index = 0; index < lanes.size(); ++index) {
      const Lane &lane = lanes[index];
      const float effective =
          lane.muted || (anySolo && !lane.solo) ? 0.0F : lane.gain;
      events[index] = {{kLaneNodeBase + index * 3u + 2u},
                       zdsp::kGainParameter,
                       {0},
                       effective,
                       zdsp::ParameterCurve::Linear,
                       {kNativePlaybackGainRampFrames}};
    }
    if (parameters.pushBatch(events.data(),
                             static_cast<uint32_t>(lanes.size())))
      return true;
    diagnostics.parameterOverflows.fetch_add(1, std::memory_order_relaxed);
    return false;
  }

  bool enqueueMaster(float value) noexcept {
    return enqueueGain({kMasterNode}, value);
  }

  bool allCursorsAtStart() const noexcept {
    for (const Lane &lane : lanes)
      if (zdsp::decodedBufferSourceCursor(lane.source, &lane.cursorReader) != 0)
        return false;
    return true;
  }

  bool shutdown() noexcept {
    telemetryLive = false;
    if (runnerInitialized) {
      observe(NativePlaybackLifecycleEvent::RunnerShutdown);
      if (testHooks != nullptr && testHooks->failRunnerShutdown != nullptr &&
          testHooks->failRunnerShutdown(testHooks->context))
        return false;
      zdsp::PublishedGraphSnapshot *snapshots[2]{};
      uint32_t count = 0;
      const zdsp::Status stopped =
          zdsp::shutdownGraphRunner(&runner, snapshots, 2, &count);
      if (!zdsp::succeeded(stopped))
        return false;
      runnerInitialized = false;
      adapter.runner = nullptr;
      callback.adapter = nullptr;
    }
    if (graph != nullptr) {
      observe(NativePlaybackLifecycleEvent::GraphDeactivate);
      const zdsp::Status deactivated = zdsp::deactivateCompiledGraph(graph);
      if (!zdsp::succeeded(deactivated))
        return false;
      graph = nullptr;
    }
    observe(NativePlaybackLifecycleEvent::DecodedRelease);
    lanes.clear();
    retainedBytes = 0;
    return true;
  }
};

enum class PlaybackQuarantineSlotState : uint32_t {
  Available = 0,
  Reserved,
  Consumed,
};

struct QuarantinedPlaybackGraph {
  std::atomic<PlaybackQuarantineSlotState> state{
      PlaybackQuarantineSlotState::Available};
  // While Reserved the graph is owned by exactly one session, possibly in an
  // off-lock stale-retirement call. Publishing its size here lets every other
  // session report the process owner without dereferencing that session.
  std::atomic<size_t> reservedRetainedBytes{0};
  std::unique_ptr<PreparedPlaybackGraph> graph;
};

static_assert(
    std::is_nothrow_default_constructible_v<QuarantinedPlaybackGraph>);

QuarantinedPlaybackGraph &playbackQuarantine() noexcept {
  // Placement construction uses preallocated process-lifetime storage: no
  // lazy heap allocation can terminate this noexcept fail-stop path, and the
  // intentionally retained graph is not destroyed during static teardown.
  alignas(QuarantinedPlaybackGraph) static std::byte
      storage[sizeof(QuarantinedPlaybackGraph)]{};
  static auto *quarantine =
      ::new (static_cast<void *>(storage)) QuarantinedPlaybackGraph();
  return *quarantine;
}

bool reservePlaybackQuarantineSlot() noexcept {
  auto &holder = playbackQuarantine();
  PlaybackQuarantineSlotState expected = PlaybackQuarantineSlotState::Available;
  const bool reserved = holder.state.compare_exchange_strong(
      expected, PlaybackQuarantineSlotState::Reserved,
      std::memory_order_acq_rel, std::memory_order_acquire);
  if (reserved)
    holder.reservedRetainedBytes.store(0, std::memory_order_release);
  return reserved;
}

void publishPlaybackQuarantineRetainedBytes(size_t retainedBytes) noexcept {
  auto &holder = playbackQuarantine();
  if (holder.state.load(std::memory_order_acquire) ==
      PlaybackQuarantineSlotState::Reserved)
    holder.reservedRetainedBytes.store(retainedBytes,
                                       std::memory_order_release);
}

void releasePlaybackQuarantineSlot() noexcept {
  auto &holder = playbackQuarantine();
  holder.reservedRetainedBytes.store(0, std::memory_order_release);
  PlaybackQuarantineSlotState expected = PlaybackQuarantineSlotState::Reserved;
  (void)holder.state.compare_exchange_strong(
      expected, PlaybackQuarantineSlotState::Available,
      std::memory_order_acq_rel, std::memory_order_acquire);
}

bool consumePlaybackQuarantineSlot(
    std::unique_ptr<PreparedPlaybackGraph> *graph) noexcept {
  if (graph == nullptr || *graph == nullptr)
    return true;
  auto &holder = playbackQuarantine();
  if (holder.state.load(std::memory_order_acquire) !=
          PlaybackQuarantineSlotState::Reserved ||
      holder.graph != nullptr) {
    return false;
  }
  (*graph)->observe(NativePlaybackLifecycleEvent::PreparedQuarantined);
  holder.graph = std::move(*graph);
  holder.state.store(PlaybackQuarantineSlotState::Consumed,
                     std::memory_order_release);
  return true;
}

void quarantineReserved(
    std::unique_ptr<PreparedPlaybackGraph> *graph) noexcept {
  if (graph == nullptr || *graph == nullptr)
    return;
  if (!consumePlaybackQuarantineSlot(graph)) {
    // Reservation makes this unreachable: there can be only one process-wide
    // prepared graph. Fail immediately rather than silently accumulating an
    // unbounded set of potentially callback-referenced graphs.
    std::terminate();
  }
}

struct PlaybackQuarantineSnapshot {
  PlaybackQuarantineSlotState state{PlaybackQuarantineSlotState::Available};
  size_t retainedBytes{0};
  bool graphPresent{false};
};

PlaybackQuarantineSnapshot playbackQuarantineSnapshot() noexcept {
  auto &holder = playbackQuarantine();
  PlaybackQuarantineSnapshot snapshot;
  snapshot.state = holder.state.load(std::memory_order_acquire);
  if (snapshot.state == PlaybackQuarantineSlotState::Consumed) {
    // Consumed is process-lifetime terminal. The graph was published before
    // the release-store of Consumed and is never mutated or released again,
    // so an acquire snapshot can safely expose its retained-byte fact.
    snapshot.graphPresent = true;
    if (holder.graph != nullptr)
      snapshot.retainedBytes = holder.graph->retainedBytes;
  } else if (snapshot.state == PlaybackQuarantineSlotState::Reserved) {
    snapshot.retainedBytes =
        holder.reservedRetainedBytes.load(std::memory_order_acquire);
  }
  // Available implies graph == nullptr by construction: the only graph write
  // precedes the terminal Consumed store, which never transitions back.
  return snapshot;
}

// Process-global ownership is deliberately stronger than the bounded graph
// quarantine. The quarantine answers where a fail-stop graph lives; this
// coordinator answers who may own *any* native playback lifecycle, including
// a generation claimed synchronously before descriptor admission. All state
// changes are ordinary-thread operations and use one fixed, allocation-free
// mutex-protected record so cleanup-to-fallback has no check/claim race.
struct PlaybackOwnershipCoordinator {
  std::mutex mutex;
  NativePlaybackCoordinatorState state{
      NativePlaybackCoordinatorState::Available};
  uint64_t epoch{1};
  uint64_t ownerSession{0};
  uint64_t ownerGeneration{0};
  uint64_t leaseSourceSession{0};
  uint64_t leaseSourceGeneration{0};
  uint64_t handoffLease{0};
  uint64_t nextSessionSerial{1};
  uint64_t nextLeaseSerial{1};
  bool sessionSerialExhausted{false};
  bool leaseSerialExhausted{false};
};

PlaybackOwnershipCoordinator &playbackOwnershipCoordinator() noexcept {
  alignas(PlaybackOwnershipCoordinator) static std::byte
      storage[sizeof(PlaybackOwnershipCoordinator)]{};
  static auto *coordinator =
      ::new (static_cast<void *>(storage)) PlaybackOwnershipCoordinator();
  return *coordinator;
}

struct PlaybackOwnershipSnapshot {
  NativePlaybackCoordinatorState state{
      NativePlaybackCoordinatorState::Available};
  uint64_t epoch{0};
  uint64_t ownerSession{0};
  uint64_t ownerGeneration{0};
  uint64_t leaseSourceSession{0};
  uint64_t leaseSourceGeneration{0};
  uint64_t handoffLease{0};
};

PlaybackOwnershipSnapshot coordinatorSnapshotLocked(
    const PlaybackOwnershipCoordinator &coordinator) noexcept {
  return {coordinator.state,
          coordinator.epoch,
          coordinator.ownerSession,
          coordinator.ownerGeneration,
          coordinator.leaseSourceSession,
          coordinator.leaseSourceGeneration,
          coordinator.handoffLease};
}

PlaybackOwnershipSnapshot playbackOwnershipSnapshot() noexcept {
  auto &coordinator = playbackOwnershipCoordinator();
  try {
    std::lock_guard<std::mutex> lock(coordinator.mutex);
    return coordinatorSnapshotLocked(coordinator);
  } catch (...) {
    PlaybackOwnershipSnapshot snapshot;
    snapshot.state = NativePlaybackCoordinatorState::Poisoned;
    return snapshot;
  }
}

bool advanceCoordinatorEpochLocked(
    PlaybackOwnershipCoordinator *coordinator) noexcept {
  if (coordinator == nullptr ||
      coordinator->epoch >= kNativePlaybackMaximumJsSafeInteger) {
    if (coordinator != nullptr)
      coordinator->state = NativePlaybackCoordinatorState::Poisoned;
    return false;
  }
  ++coordinator->epoch;
  return true;
}

uint64_t registerPlaybackSession() noexcept {
  auto &coordinator = playbackOwnershipCoordinator();
  try {
    std::lock_guard<std::mutex> lock(coordinator.mutex);
    if (coordinator.sessionSerialExhausted ||
        coordinator.nextSessionSerial == 0 ||
        coordinator.nextSessionSerial > kNativePlaybackMaximumJsSafeInteger)
      return 0;
    const uint64_t serial = coordinator.nextSessionSerial;
    if (serial == kNativePlaybackMaximumJsSafeInteger) {
      coordinator.sessionSerialExhausted = true;
    } else {
      ++coordinator.nextSessionSerial;
    }
    return serial;
  } catch (...) {
    return 0;
  }
}

struct PlaybackCoordinatorClaim {
  bool ok{false};
  NativePlaybackError error{NativePlaybackError::ResourceExhausted};
  PlaybackOwnershipSnapshot snapshot{};
  uint64_t consumedLease{0};
};

PlaybackCoordinatorClaim
claimPlaybackOwnership(uint64_t session, uint64_t generation,
                       uint64_t handoffLease) noexcept {
  PlaybackCoordinatorClaim result;
  auto &coordinator = playbackOwnershipCoordinator();
  try {
    std::lock_guard<std::mutex> lock(coordinator.mutex);
    const PlaybackQuarantineSnapshot quarantine = playbackQuarantineSnapshot();
    if (quarantine.state == PlaybackQuarantineSlotState::Consumed ||
        quarantine.graphPresent) {
      coordinator.state = NativePlaybackCoordinatorState::Poisoned;
      coordinator.handoffLease = 0;
      result.error = NativePlaybackError::TeardownUncertain;
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    if (session == 0 || generation == 0 ||
        handoffLease > kNativePlaybackMaximumJsSafeInteger) {
      result.error = NativePlaybackError::InvalidConfiguration;
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    switch (coordinator.state) {
    case NativePlaybackCoordinatorState::Available:
      if (handoffLease != 0) {
        result.error = NativePlaybackError::InvalidGeneration;
        break;
      }
      if (!advanceCoordinatorEpochLocked(&coordinator))
        break;
      coordinator.state = NativePlaybackCoordinatorState::NativeOwned;
      coordinator.ownerSession = session;
      coordinator.ownerGeneration = generation;
      coordinator.leaseSourceSession = 0;
      coordinator.leaseSourceGeneration = 0;
      coordinator.handoffLease = 0;
      result.ok = true;
      result.error = NativePlaybackError::None;
      break;
    case NativePlaybackCoordinatorState::NativeOwned:
      if (handoffLease == 0 && coordinator.ownerSession == session &&
          generation > coordinator.ownerGeneration) {
        if (!advanceCoordinatorEpochLocked(&coordinator))
          break;
        coordinator.ownerGeneration = generation;
        result.ok = true;
        result.error = NativePlaybackError::None;
      } else if (coordinator.ownerSession == session &&
                 generation <= coordinator.ownerGeneration) {
        result.error = NativePlaybackError::InvalidGeneration;
      }
      break;
    case NativePlaybackCoordinatorState::FallbackLeased:
      if (handoffLease != 0 && handoffLease == coordinator.handoffLease) {
        const uint64_t consumed = coordinator.handoffLease;
        if (!advanceCoordinatorEpochLocked(&coordinator))
          break;
        coordinator.state = NativePlaybackCoordinatorState::NativeOwned;
        coordinator.ownerSession = session;
        coordinator.ownerGeneration = generation;
        coordinator.leaseSourceSession = 0;
        coordinator.leaseSourceGeneration = 0;
        coordinator.handoffLease = 0;
        result.ok = true;
        result.error = NativePlaybackError::None;
        result.consumedLease = consumed;
      } else {
        result.error = handoffLease == 0
                           ? NativePlaybackError::ResourceExhausted
                           : NativePlaybackError::InvalidGeneration;
      }
      break;
    case NativePlaybackCoordinatorState::Poisoned:
      result.error = NativePlaybackError::TeardownUncertain;
      break;
    }
    result.snapshot = coordinatorSnapshotLocked(coordinator);
    return result;
  } catch (...) {
    result.snapshot.state = NativePlaybackCoordinatorState::Poisoned;
    result.error = NativePlaybackError::TeardownUncertain;
    return result;
  }
}

bool playbackOwnershipMatches(uint64_t session, uint64_t generation) noexcept {
  const PlaybackOwnershipSnapshot snapshot = playbackOwnershipSnapshot();
  return snapshot.state == NativePlaybackCoordinatorState::NativeOwned &&
         snapshot.ownerSession == session &&
         snapshot.ownerGeneration == generation;
}

void poisonPlaybackOwnership(uint64_t session, uint64_t generation) noexcept {
  auto &coordinator = playbackOwnershipCoordinator();
  try {
    std::lock_guard<std::mutex> lock(coordinator.mutex);
    if (coordinator.state != NativePlaybackCoordinatorState::Poisoned) {
      (void)advanceCoordinatorEpochLocked(&coordinator);
      coordinator.state = NativePlaybackCoordinatorState::Poisoned;
      coordinator.ownerSession = session;
      coordinator.ownerGeneration = generation;
      coordinator.leaseSourceSession = 0;
      coordinator.leaseSourceGeneration = 0;
      coordinator.handoffLease = 0;
    }
  } catch (...) {
  }
}

void abandonPlaybackOwnership(uint64_t session) noexcept {
  auto &coordinator = playbackOwnershipCoordinator();
  try {
    std::lock_guard<std::mutex> lock(coordinator.mutex);
    if (coordinator.state == NativePlaybackCoordinatorState::NativeOwned &&
        coordinator.ownerSession == session &&
        playbackQuarantineSnapshot().state ==
            PlaybackQuarantineSlotState::Available) {
      if (!advanceCoordinatorEpochLocked(&coordinator))
        return;
      coordinator.state = NativePlaybackCoordinatorState::Available;
      coordinator.ownerSession = 0;
      coordinator.ownerGeneration = 0;
      coordinator.leaseSourceSession = 0;
      coordinator.leaseSourceGeneration = 0;
      coordinator.handoffLease = 0;
    }
  } catch (...) {
  }
}

struct PlaybackLeaseAcquisition {
  NativePlaybackCleanupSafety safety{NativePlaybackCleanupSafety::NotOwned};
  NativePlaybackError error{NativePlaybackError::None};
  PlaybackOwnershipSnapshot snapshot{};
};

PlaybackLeaseAcquisition
acquireFallbackLease(uint64_t session, uint64_t generation, bool locallyEmpty,
                     bool forceSerialExhaustion) noexcept {
  PlaybackLeaseAcquisition result;
  auto &coordinator = playbackOwnershipCoordinator();
  try {
    std::lock_guard<std::mutex> lock(coordinator.mutex);
    const PlaybackQuarantineSnapshot quarantine = playbackQuarantineSnapshot();
    if (coordinator.state == NativePlaybackCoordinatorState::FallbackLeased &&
        coordinator.leaseSourceSession == session &&
        coordinator.leaseSourceGeneration == generation &&
        coordinator.handoffLease != 0) {
      result.safety = NativePlaybackCleanupSafety::Complete;
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    if (coordinator.state == NativePlaybackCoordinatorState::Poisoned ||
        quarantine.state == PlaybackQuarantineSlotState::Consumed ||
        quarantine.graphPresent) {
      coordinator.state = NativePlaybackCoordinatorState::Poisoned;
      coordinator.handoffLease = 0;
      result.safety = NativePlaybackCleanupSafety::Uncertain;
      result.error = NativePlaybackError::TeardownUncertain;
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    if (coordinator.state != NativePlaybackCoordinatorState::NativeOwned ||
        coordinator.ownerSession != session ||
        coordinator.ownerGeneration != generation) {
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    if (!locallyEmpty ||
        quarantine.state != PlaybackQuarantineSlotState::Available) {
      result.safety = NativePlaybackCleanupSafety::Uncertain;
      result.error = NativePlaybackError::TeardownUncertain;
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    if (forceSerialExhaustion) {
      coordinator.nextLeaseSerial = kNativePlaybackMaximumJsSafeInteger;
      coordinator.leaseSerialExhausted = true;
    }
    if (coordinator.leaseSerialExhausted || coordinator.nextLeaseSerial == 0 ||
        coordinator.nextLeaseSerial > kNativePlaybackMaximumJsSafeInteger) {
      result.safety = NativePlaybackCleanupSafety::Uncertain;
      result.error = NativePlaybackError::ResourceExhausted;
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    const uint64_t lease = coordinator.nextLeaseSerial;
    if (lease == kNativePlaybackMaximumJsSafeInteger) {
      coordinator.leaseSerialExhausted = true;
    } else {
      ++coordinator.nextLeaseSerial;
    }
    if (!advanceCoordinatorEpochLocked(&coordinator)) {
      result.safety = NativePlaybackCleanupSafety::Uncertain;
      result.error = NativePlaybackError::TeardownUncertain;
      result.snapshot = coordinatorSnapshotLocked(coordinator);
      return result;
    }
    coordinator.state = NativePlaybackCoordinatorState::FallbackLeased;
    coordinator.leaseSourceSession = session;
    coordinator.leaseSourceGeneration = generation;
    coordinator.handoffLease = lease;
    result.safety = NativePlaybackCleanupSafety::Complete;
    result.snapshot = coordinatorSnapshotLocked(coordinator);
    return result;
  } catch (...) {
    result.safety = NativePlaybackCleanupSafety::Uncertain;
    result.error = NativePlaybackError::TeardownUncertain;
    result.snapshot.state = NativePlaybackCoordinatorState::Poisoned;
    return result;
  }
}

void advanceAtomic(std::atomic<uint64_t> *value, uint64_t requested) noexcept {
  uint64_t observed = value->load(std::memory_order_acquire);
  while (requested > observed &&
         !value->compare_exchange_weak(observed, requested,
                                       std::memory_order_acq_rel,
                                       std::memory_order_acquire)) {
  }
}

struct PrepareCancellationState {
  std::atomic<uint64_t> *latestGeneration{nullptr};
  std::atomic<uint64_t> *cancelledThrough{nullptr};
  uint64_t generation{0};
  DecodeCancellation external{};
};

bool prepareCancelled(void *opaque) noexcept {
  const auto *state = static_cast<const PrepareCancellationState *>(opaque);
  return state == nullptr || state->latestGeneration == nullptr ||
         state->cancelledThrough == nullptr ||
         state->latestGeneration->load(std::memory_order_acquire) !=
             state->generation ||
         state->cancelledThrough->load(std::memory_order_acquire) >=
             state->generation ||
         state->external.isRequested();
}

} // namespace

const char *nativePlaybackErrorName(NativePlaybackError error) noexcept {
  switch (error) {
  case NativePlaybackError::None:
    return "none";
  case NativePlaybackError::InvalidGeneration:
    return "invalid-generation";
  case NativePlaybackError::InvalidState:
    return "invalid-state";
  case NativePlaybackError::InvalidConfiguration:
    return "invalid-configuration";
  case NativePlaybackError::Cancelled:
    return "cancelled";
  case NativePlaybackError::DecodeFailure:
    return "decode-failure";
  case NativePlaybackError::LimitExceeded:
    return "limit-exceeded";
  case NativePlaybackError::ResourceExhausted:
    return "resource-exhausted";
  case NativePlaybackError::GraphFailure:
    return "graph-failure";
  case NativePlaybackError::HostFailure:
    return "host-failure";
  case NativePlaybackError::ProviderFailure:
    return "provider-failure";
  case NativePlaybackError::QueueFull:
    return "queue-full";
  case NativePlaybackError::TeardownUncertain:
    return "teardown-uncertain";
  }
  return "host-failure";
}

struct NativePlaybackSession::Impl {
  static constexpr size_t kUnloadReceiptCapacity = 8;

  struct UnloadReceiptEntry {
    bool occupied{false};
    bool ready{false};
    uint64_t commandGeneration{0};
    uint64_t cleanupGeneration{0};
    bool playbackOk{false};
    NativePlaybackError playbackError{NativePlaybackError::InvalidState};
    NativePlaybackState playbackState{NativePlaybackState::Unloaded};
    AudioHostFormat playbackFormat{};
    AudioHostLatency playbackLatency{};
    NativePlaybackCleanupResult cleanup{};
  };

  explicit Impl(std::unique_ptr<AudioHostBackend> backend,
                NativePlaybackTestHooks *hooks)
      : host(std::move(backend)), testHooks(hooks),
        sessionId(registerPlaybackSession()) {}

  ~Impl() {
    if (prepared != nullptr) {
      if (!stopHost() || !prepared->shutdown()) {
        quarantineReserved(&prepared);
        quarantineSlotReserved = false;
        poisonPlaybackOwnership(sessionId, generation);
        return;
      }
      prepared.reset();
    }
    releaseQuarantineReservation();
    abandonPlaybackOwnership(sessionId);
  }

  mutable std::mutex mutex;
  // A short control-domain gate linearizes generation/cancellation claims
  // with prepared/open/running publication. It is never held across decode,
  // graph compilation or an AudioHost call.
  mutable std::mutex generationGate;
  AudioHost host;
  std::unique_ptr<PreparedPlaybackGraph> prepared;
  uint64_t generation{0};
  uint64_t highestAttemptGeneration{0};
  uint64_t lastCancelledGeneration{0};
  uint64_t failedPrepareCleanupGeneration{0};
  uint64_t lastUnloadedGeneration{0};
  // A stale graph remains owned here logically while its unique_ptr is held
  // by prepare() for off-lock shutdown. The reservation and prepare mutation
  // marker stay live until shutdown reaches a terminal result.
  uint64_t retiringPrepareGeneration{0};
  size_t retiringPrepareBytes{0};
  bool retiringUnloadRequested{false};
  bool retiringSupersededByNewerClaim{false};
  uint64_t prepareUnloadRequestedGeneration{0};
  std::atomic<uint64_t> pendingClaimUnloadGeneration{0};
  std::atomic<uint64_t> latestGeneration{0};
  std::atomic<uint64_t> activeGeneration{0};
  std::atomic<uint64_t> cancelledThrough{0};
  NativePlaybackState state{NativePlaybackState::Unloaded};
  NativePlaybackPrepareConfig preparedConfig{};
  AudioHostStatus lastHost{};
  AudioHostTerminalCause lastTerminal{};
  std::string lastError;
  NativePlaybackTestHooks *testHooks{nullptr};
  uint64_t sessionId{0};
  bool quarantineSlotReserved{false};
  std::atomic<uint64_t> pendingClaimGeneration{0};
  std::atomic<uint64_t> claimedHandoffLeaseGeneration{0};
  std::atomic<uint64_t> claimedHandoffLease{0};
  uint64_t prepareMutationGeneration{0};
  uint64_t openInvocationGeneration{0};
  uint64_t openMutationGeneration{0};
  uint64_t startInvocationGeneration{0};
  uint64_t startMutationGeneration{0};
  uint64_t nextDeliverySerial{1};
  NativePlaybackDeliveryToken pendingOpenDelivery{};
  NativePlaybackDeliveryToken pendingStartDelivery{};
  std::array<UnloadReceiptEntry, kUnloadReceiptCapacity> unloadReceipts{};
  uint64_t unloadReceiptJournalExhaustedGeneration{0};
  bool retiringOldUnloadCommandAccepted{false};

  void latchTerminal(AudioHostTerminalCause cause) noexcept {
    if (cause.reason != AudioHostTerminalReason::None && cause.ordinal == 0)
      cause = makeAudioHostTerminalCause(cause.reason);
    lastTerminal = firstAudioHostTerminalCause(lastTerminal, cause);
  }

  bool reserveQuarantineReservation() noexcept {
    if (quarantineSlotReserved)
      return true;
    quarantineSlotReserved = reservePlaybackQuarantineSlot();
    return quarantineSlotReserved;
  }

  void releaseQuarantineReservation() noexcept {
    if (!quarantineSlotReserved)
      return;
    releasePlaybackQuarantineSlot();
    quarantineSlotReserved = false;
  }

  void quarantinePrepared() noexcept {
    quarantineReserved(&prepared);
    quarantineSlotReserved = false;
    poisonPlaybackOwnership(sessionId, generation);
  }

  AudioHostTerminalCause callbackTerminalCause() const noexcept {
    return prepared == nullptr
               ? AudioHostTerminalCause{}
               : prepared->callback.firstTerminalCause.current();
  }

  bool hostMutationActive() const noexcept {
    return openMutationGeneration != 0 || startMutationGeneration != 0;
  }

  bool hostMutationActiveFor(uint64_t requested) const noexcept {
    return requested != 0 && (openMutationGeneration == requested ||
                              startMutationGeneration == requested);
  }

  // A cleanup result may be labelled Complete only when the entire session
  // owns nothing, not merely when the requested token/generation is absent.
  // In particular, a later failed prepare retains an exact-generation
  // cleanup handshake and a quarantine reservation even though its public
  // state is Unloaded and it has no decoded bytes yet.
  bool locallyEmptyForCleanup() const noexcept {
    const PlaybackQuarantineSnapshot quarantine = playbackQuarantineSnapshot();
    return quarantine.state == PlaybackQuarantineSlotState::Available &&
           !quarantine.graphPresent && quarantine.retainedBytes == 0 &&
           prepared == nullptr && state == NativePlaybackState::Unloaded &&
           generation == 0 &&
           activeGeneration.load(std::memory_order_acquire) == 0 &&
           failedPrepareCleanupGeneration == 0 &&
           retiringPrepareGeneration == 0 && retiringPrepareBytes == 0 &&
           !retiringUnloadRequested && !retiringSupersededByNewerClaim &&
           prepareUnloadRequestedGeneration == 0 &&
           pendingClaimUnloadGeneration == 0 &&
           prepareMutationGeneration == 0 && !hostMutationActive() &&
           openInvocationGeneration == 0 && startInvocationGeneration == 0 &&
           !pendingOpenDelivery.valid() && !pendingStartDelivery.valid() &&
           !quarantineSlotReserved && pendingClaimGeneration == 0;
  }

  bool armDelivery(NativePlaybackDeliveryCommand command, uint64_t requested,
                   NativePlaybackDeliveryToken *output) noexcept {
    if (output == nullptr)
      return true;
    *output = {};
    // Serial zero is permanently invalid. Refuse the physically impossible
    // exhaustion boundary instead of wrapping and making a stale token live.
    if (nextDeliverySerial == std::numeric_limits<uint64_t>::max())
      return false;
    const NativePlaybackDeliveryToken token{requested, nextDeliverySerial++,
                                            command};
    *output = token;
    if (command == NativePlaybackDeliveryCommand::OpenOutput) {
      pendingOpenDelivery = token;
    } else if (command == NativePlaybackDeliveryCommand::Start) {
      pendingStartDelivery = token;
    } else {
      *output = {};
      return false;
    }
    return true;
  }

  static bool
  sameDeliveryToken(const NativePlaybackDeliveryToken &left,
                    const NativePlaybackDeliveryToken &right) noexcept {
    return left.valid() && left.generation == right.generation &&
           left.serial == right.serial && left.command == right.command;
  }

  NativePlaybackCleanupResult
  cleanupSnapshot(NativePlaybackCleanupSafety safety, NativePlaybackError error,
                  uint64_t requested) const noexcept {
    NativePlaybackCleanupResult result;
    result.safety = safety;
    result.error = error;
    result.generation = requested;
    result.state = state;
    const size_t preparedRetained =
        prepared == nullptr ? 0 : prepared->retainedBytes;
    const size_t localRetained =
        retiringPrepareBytes >
                std::numeric_limits<size_t>::max() - preparedRetained
            ? std::numeric_limits<size_t>::max()
            : preparedRetained + retiringPrepareBytes;
    const PlaybackQuarantineSnapshot quarantine = playbackQuarantineSnapshot();
    result.processQuarantineRetainedBytes = quarantine.retainedBytes;
    result.processQuarantineReserved =
        quarantine.state == PlaybackQuarantineSlotState::Reserved;
    result.processQuarantinePoisoned =
        quarantine.state == PlaybackQuarantineSlotState::Consumed ||
        quarantine.graphPresent;
    const PlaybackOwnershipSnapshot coordinator = playbackOwnershipSnapshot();
    result.coordinatorState = coordinator.state;
    result.coordinatorEpoch = coordinator.epoch;
    result.coordinatorOwnerSession = coordinator.ownerSession;
    result.coordinatorOwnerGeneration = coordinator.ownerGeneration;
    if (result.safety == NativePlaybackCleanupSafety::Complete &&
        coordinator.state == NativePlaybackCoordinatorState::FallbackLeased &&
        coordinator.leaseSourceSession == sessionId &&
        coordinator.leaseSourceGeneration == requested)
      result.handoffLease = coordinator.handoffLease;
    // A session holding the reservation owns the same bytes described by the
    // process snapshot; another session owns no local copy. Avoid double
    // counting while retaining a process-visible byte fact for observers.
    result.retainedBytes =
        quarantineSlotReserved &&
                quarantine.state == PlaybackQuarantineSlotState::Reserved
            ? std::max(localRetained, quarantine.retainedBytes)
        : quarantine.retainedBytes >
                std::numeric_limits<size_t>::max() - localRetained
            ? std::numeric_limits<size_t>::max()
            : localRetained + quarantine.retainedBytes;
    // Complete is a transferable ownership result, not an empty snapshot.
    // It exists only while the exact source generation's process fallback
    // lease remains held. A concurrent correct reentry consumes the token and
    // therefore safely demotes an older result construction.
    if (result.safety == NativePlaybackCleanupSafety::Complete &&
        (retiringPrepareGeneration != 0 ||
         quarantine.state != PlaybackQuarantineSlotState::Available ||
         result.handoffLease == 0 ||
         coordinator.state != NativePlaybackCoordinatorState::FallbackLeased)) {
      const bool uncertain =
          retiringPrepareGeneration != 0 || result.processQuarantinePoisoned ||
          coordinator.state == NativePlaybackCoordinatorState::Poisoned;
      result.safety = uncertain ? NativePlaybackCleanupSafety::Uncertain
                                : NativePlaybackCleanupSafety::NotOwned;
      result.error = uncertain ? NativePlaybackError::TeardownUncertain
                               : NativePlaybackError::None;
    }
    result.terminalReason = lastTerminal.reason;
    result.physicalOwnershipRetained = hostMutationActive();
    return result;
  }

  NativePlaybackCleanupResult
  acquireCleanupLease(uint64_t requested) const noexcept {
    const bool forceExhaustion =
        testHooks != nullptr &&
        testHooks->exhaustHandoffLeaseSerial != nullptr &&
        testHooks->exhaustHandoffLeaseSerial(testHooks->context);
    const PlaybackLeaseAcquisition acquisition = acquireFallbackLease(
        sessionId, requested, locallyEmptyForCleanup(), forceExhaustion);
    return cleanupSnapshot(acquisition.safety, acquisition.error, requested);
  }

  bool cleanupReceiptStillCurrent(
      const NativePlaybackCleanupResult &cleanup) const noexcept {
    if (cleanup.safety != NativePlaybackCleanupSafety::Complete)
      return true;
    const PlaybackOwnershipSnapshot ownership = playbackOwnershipSnapshot();
    return cleanup.globallyComplete() &&
           ownership.state == NativePlaybackCoordinatorState::FallbackLeased &&
           ownership.handoffLease == cleanup.handoffLease &&
           ownership.leaseSourceSession == sessionId &&
           ownership.leaseSourceGeneration == cleanup.generation;
  }

  UnloadReceiptEntry *findUnloadReceipt(uint64_t commandGeneration) noexcept {
    for (auto &entry : unloadReceipts) {
      if (entry.occupied && entry.commandGeneration == commandGeneration)
        return &entry;
    }
    return nullptr;
  }

  const UnloadReceiptEntry *
  findUnloadReceipt(uint64_t commandGeneration) const noexcept {
    for (const auto &entry : unloadReceipts) {
      if (entry.occupied && entry.commandGeneration == commandGeneration)
        return &entry;
    }
    return nullptr;
  }

  UnloadReceiptEntry *
  reserveUnloadReceipt(uint64_t commandGeneration,
                       uint64_t cleanupGeneration) noexcept {
    if (auto *existing = findUnloadReceipt(commandGeneration))
      return existing;
    UnloadReceiptEntry *available = nullptr;
    for (auto &entry : unloadReceipts) {
      if (!entry.occupied) {
        available = &entry;
        break;
      }
      // Once a fallback lease was transferred back to native, its old proof
      // is intentionally no longer fallback-safe and its bounded slot may be
      // reused. NotOwned receipts carry no ownership claim either.
      if ((entry.ready &&
           entry.cleanup.safety == NativePlaybackCleanupSafety::NotOwned) ||
          (entry.ready &&
           entry.cleanup.safety == NativePlaybackCleanupSafety::Complete &&
           !cleanupReceiptStillCurrent(entry.cleanup)))
        available = &entry;
    }
    if (available == nullptr)
      return nullptr;
    *available = {};
    available->occupied = true;
    available->commandGeneration = commandGeneration;
    available->cleanupGeneration = cleanupGeneration;
    return available;
  }

  bool reserveDeferredUnloadReceipts(uint64_t oldGeneration,
                                     uint64_t cleanupGeneration) noexcept {
    if (testHooks != nullptr &&
        testHooks->exhaustUnloadReceiptJournal != nullptr &&
        testHooks->exhaustUnloadReceiptJournal(testHooks->context))
      return false;
    UnloadReceiptEntry *cleanup =
        reserveUnloadReceipt(cleanupGeneration, cleanupGeneration);
    if (cleanup == nullptr)
      return false;
    UnloadReceiptEntry *old =
        oldGeneration == cleanupGeneration
            ? cleanup
            : reserveUnloadReceipt(oldGeneration, cleanupGeneration);
    if (old == nullptr) {
      if (!cleanup->ready)
        *cleanup = {};
      return false;
    }
    return true;
  }

  static NativePlaybackResult
  playbackFromReceipt(const UnloadReceiptEntry &entry) noexcept {
    NativePlaybackResult result;
    result.ok = entry.playbackOk;
    result.error = entry.playbackError;
    result.generation = entry.commandGeneration;
    result.state = entry.playbackState;
    result.format = entry.playbackFormat;
    result.latency = entry.playbackLatency;
    return result;
  }

  static NativePlaybackUnloadReceipt
  unloadReceiptFromEntry(const UnloadReceiptEntry &entry) noexcept {
    return {playbackFromReceipt(entry), entry.cleanup};
  }

  void publishUnloadReceipt(uint64_t commandGeneration,
                            NativePlaybackResult playback,
                            NativePlaybackCleanupResult cleanup) noexcept {
    UnloadReceiptEntry *entry = findUnloadReceipt(commandGeneration);
    if (entry == nullptr)
      entry = reserveUnloadReceipt(commandGeneration, cleanup.generation);
    if (entry == nullptr)
      return;
    entry->cleanupGeneration = cleanup.generation;
    entry->playbackOk = playback.ok;
    entry->playbackError = playback.error;
    entry->playbackState = playback.state;
    entry->playbackFormat = playback.format;
    entry->playbackLatency = playback.latency;
    entry->cleanup = cleanup;
    entry->ready = true;
  }

  void discardUnloadReceipt(uint64_t commandGeneration) noexcept {
    if (auto *entry = findUnloadReceipt(commandGeneration))
      *entry = {};
  }

  // Finalize a newer claim whose exact unload was accepted while an older
  // graph still owned the process quarantine reservation. Callers must have
  // physically retired the old graph and published their ordinary Unloaded
  // state first. Keeping this one path shared by normal unload and stale
  // prepare retirement prevents the deferred generation from requiring a
  // second unload merely to release its claim and acquire the fallback lease.
  NativePlaybackCleanupResult finalizeDeferredClaimUnloadAfterRetirement(
      uint64_t retiredGeneration, bool publishRetiredCommandReceipt) noexcept {
    const uint64_t cleanupGeneration =
        pendingClaimUnloadGeneration.load(std::memory_order_acquire);
    if (cleanupGeneration == 0)
      return cleanupSnapshot(NativePlaybackCleanupSafety::NotOwned,
                             NativePlaybackError::None, 0);
    if (pendingClaimGeneration.load(std::memory_order_acquire) ==
        cleanupGeneration)
      pendingClaimGeneration.store(0, std::memory_order_release);
    if (failedPrepareCleanupGeneration == cleanupGeneration)
      failedPrepareCleanupGeneration = 0;
    pendingClaimUnloadGeneration.store(0, std::memory_order_release);
    if (claimedHandoffLeaseGeneration.load(std::memory_order_acquire) ==
        cleanupGeneration) {
      claimedHandoffLeaseGeneration.store(0, std::memory_order_release);
      claimedHandoffLease.store(0, std::memory_order_release);
    }
    releaseQuarantineReservation();
    NativePlaybackCleanupResult cleanup =
        acquireCleanupLease(cleanupGeneration);
    NativePlaybackResult cleanupPlayback = success(cleanupGeneration);
    publishUnloadReceipt(cleanupGeneration, std::move(cleanupPlayback),
                         cleanup);
    if (publishRetiredCommandReceipt) {
      NativePlaybackResult retiredPlayback = success(retiredGeneration);
      if (cleanup.safety == NativePlaybackCleanupSafety::Uncertain) {
        retiredPlayback.ok = false;
        retiredPlayback.error = cleanup.error == NativePlaybackError::None
                                    ? NativePlaybackError::TeardownUncertain
                                    : cleanup.error;
      }
      publishUnloadReceipt(retiredGeneration, std::move(retiredPlayback),
                           cleanup);
    } else {
      discardUnloadReceipt(retiredGeneration);
    }
    return cleanup;
  }

  void refreshTerminalState() noexcept {
    if (prepared == nullptr || state == NativePlaybackState::Preparing ||
        state == NativePlaybackState::Prepared ||
        state == NativePlaybackState::Unloaded ||
        state == NativePlaybackState::Quarantined || !hostMutationActive())
      return;
    const AudioHostStatus current = host.status();
    const AudioHostTerminalCause cause =
        effectiveTerminalCause(current, callbackTerminalCause());
    if (cause.reason != AudioHostTerminalReason::None ||
        current.state == AudioHostState::DeviceLost ||
        current.state == AudioHostState::Error) {
      state = NativePlaybackState::Terminal;
      latchTerminal(cause.reason != AudioHostTerminalReason::None
                        ? cause
                        : makeAudioHostTerminalCause(
                              AudioHostTerminalReason::ProviderFailure));
    }
  }

  bool currentForCommand(uint64_t requested) const noexcept {
    return requested != 0 && requested == generation && prepared != nullptr &&
           requested == latestGeneration.load(std::memory_order_acquire) &&
           cancelledThrough.load(std::memory_order_acquire) < requested;
  }

  NativePlaybackResult recoverPrepareException(NativePlaybackError error,
                                               uint64_t requested) noexcept {
    std::lock_guard<std::mutex> lock(mutex);
    if (prepareMutationGeneration != requested)
      return failureWithoutMessage(error, requested, state);
    prepareMutationGeneration = 0;
    if (generation == requested) {
      if (prepared != nullptr) {
        if (!prepared->shutdown()) {
          quarantinePrepared();
          state = NativePlaybackState::Quarantined;
          activeGeneration.store(0, std::memory_order_release);
          generation = 0;
          failedPrepareCleanupGeneration = 0;
          lastError.clear();
          return failureWithoutMessage(NativePlaybackError::GraphFailure,
                                       requested, state);
        }
        prepared.reset();
      }
      generation = 0;
      activeGeneration.store(0, std::memory_order_release);
      state = NativePlaybackState::Unloaded;
      preparedConfig = {};
      failedPrepareCleanupGeneration = requested;
      lastError.clear();
    }
    return failureWithoutMessage(error, requested, state);
  }

  NativePlaybackResult recoverOpenException(NativePlaybackError error,
                                            uint64_t requested) noexcept {
    std::lock_guard<std::mutex> lock(mutex);
    if (openInvocationGeneration != requested)
      return failureWithoutMessage(error, requested, state);
    // host.open may have acquired a lease, observers or an AudioUnit while
    // still reporting Closed/Stopped. Mutation admission, not published host
    // state, decides whether physical stop is mandatory.
    if (!stopHost(true, true)) {
      state = NativePlaybackState::Quarantined;
      return failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                   requested, state);
    }
    if (requested == generation && prepared != nullptr) {
      state = NativePlaybackState::Prepared;
      lastError.clear();
    }
    return failureWithoutMessage(error, requested, state);
  }

  NativePlaybackResult recoverStartException(NativePlaybackError error,
                                             uint64_t requested) noexcept {
    std::lock_guard<std::mutex> lock(mutex);
    if (startInvocationGeneration != requested)
      return failureWithoutMessage(error, requested, state);
    const AudioHostStatus beforeStop = host.status();
    const AudioHostTerminalCause cause =
        effectiveTerminalCause(beforeStop, callbackTerminalCause());
    latchTerminal(cause);
    if (!stopHost(false, true)) {
      state = NativePlaybackState::Quarantined;
      return failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                   requested, state);
    }
    if (lastTerminal.reason != AudioHostTerminalReason::None) {
      state = NativePlaybackState::Terminal;
    } else {
      state = NativePlaybackState::Stopped;
    }
    lastError.clear();
    return failureWithoutMessage(error, requested, state);
  }

  bool stopHost(bool force = false,
                bool preserveDeliveryToken = false) noexcept {
    const bool mutationActive = hostMutationActive();
    // A merely Prepared generation has never admitted this provider. Do not
    // sample or stop a stale stream from a prior generation, and do not import
    // its format, telemetry or retained terminal cause.
    if (!mutationActive && !force)
      return true;
    const AudioHostStatus before = host.status();
    latchTerminal(effectiveTerminalCause(before, callbackTerminalCause()));
    if (!force && !mutationActive && safeStoppedState(before.state)) {
      lastHost = before;
      return true;
    }
    if (prepared != nullptr)
      prepared->observe(NativePlaybackLifecycleEvent::HostStopBegin);
    host.stop();
    if (prepared != nullptr)
      prepared->observe(NativePlaybackLifecycleEvent::HostStopComplete);
    lastHost = host.status();
    // This is the final observation after provider callback quiescence. Merge
    // both domains before graph retirement can release callback state.
    latchTerminal(effectiveTerminalCause(lastHost, callbackTerminalCause()));
    const bool quiesced = safeStoppedState(lastHost.state);
    if (quiesced) {
      // These admission markers are physical-ownership facts, not transient
      // call-stack flags. Clear them only after provider quiescence is proven.
      openMutationGeneration = 0;
      openInvocationGeneration = 0;
      startMutationGeneration = 0;
      startInvocationGeneration = 0;
      if (!preserveDeliveryToken) {
        pendingOpenDelivery = {};
        pendingStartDelivery = {};
      }
    }
    return quiesced;
  }

  NativePlaybackResult success(uint64_t resultGeneration) const noexcept {
    const AudioHostStatus current =
        prepared != nullptr && hostMutationActive() ? host.status() : lastHost;
    AudioHostFormat format = current.format;
    if (prepared != nullptr &&
        (state == NativePlaybackState::Prepared || format.sampleRate <= 0.0)) {
      format.sampleRate = prepared->sampleRate;
      format.maximumFrames = prepared->maximumFrames;
      format.outputChannels = prepared->outputChannels;
      format.float32Planar = true;
    }
    return {true,
            NativePlaybackError::None,
            resultGeneration,
            state,
            format,
            current.latency,
            {}};
  }
};

NativePlaybackSession::NativePlaybackSession()
    : impl_(std::make_unique<Impl>(createPlatformAudioHostBackend(), nullptr)) {
}

NativePlaybackSession::NativePlaybackSession(
    std::unique_ptr<AudioHostBackend> backend)
    : impl_(std::make_unique<Impl>(std::move(backend), nullptr)) {}

NativePlaybackSession::NativePlaybackSession(
    std::unique_ptr<AudioHostBackend> backend,
    NativePlaybackTestHooks *testHooks)
    : impl_(std::make_unique<Impl>(std::move(backend), testHooks)) {}

NativePlaybackSession::~NativePlaybackSession() = default;

AudioHostInventory NativePlaybackSession::enumerate() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->host.enumerate();
}

bool NativePlaybackSession::claimGeneration(uint64_t generation) noexcept {
  return claimGeneration(generation, 0).ok;
}

NativePlaybackResult
NativePlaybackSession::claimGeneration(uint64_t generation,
                                       uint64_t handoffLease) noexcept {
  if (generation == 0 || handoffLease > kNativePlaybackMaximumJsSafeInteger)
    return failureWithoutMessage(NativePlaybackError::InvalidConfiguration,
                                 generation, NativePlaybackState::Unloaded);
  try {
    std::lock_guard<std::mutex> gate(impl_->generationGate);
    const uint64_t latest =
        impl_->latestGeneration.load(std::memory_order_acquire);
    if (generation <= latest)
      return failureWithoutMessage(NativePlaybackError::InvalidGeneration,
                                   generation, NativePlaybackState::Unloaded);
    const PlaybackCoordinatorClaim claim =
        claimPlaybackOwnership(impl_->sessionId, generation, handoffLease);
    if (!claim.ok)
      return failureWithoutMessage(claim.error, generation,
                                   NativePlaybackState::Unloaded);
    impl_->latestGeneration.store(generation, std::memory_order_release);
    impl_->pendingClaimGeneration = generation;
    impl_->claimedHandoffLeaseGeneration = generation;
    impl_->claimedHandoffLease = claim.consumedLease;
    return {true,       NativePlaybackError::None,
            generation, NativePlaybackState::Unloaded,
            {},         {},
            {}};
  } catch (...) {
    return failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                 generation, NativePlaybackState::Quarantined);
  }
}

bool NativePlaybackSession::requestCancellation(uint64_t generation) noexcept {
  if (generation == 0)
    return false;
  try {
    std::lock_guard<std::mutex> gate(impl_->generationGate);
    const uint64_t active =
        impl_->activeGeneration.load(std::memory_order_acquire);
    const uint64_t latest =
        impl_->latestGeneration.load(std::memory_order_acquire);
    if (generation != active && generation != latest)
      return false;
    advanceAtomic(&impl_->cancelledThrough, generation);
    return true;
  } catch (...) {
    return false;
  }
}

NativePlaybackResult NativePlaybackSession::failPrepareAdmission(
    uint64_t generation, NativePlaybackError error) noexcept {
  try {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    std::lock_guard<std::mutex> gate(impl_->generationGate);
    const uint64_t latest =
        impl_->latestGeneration.load(std::memory_order_acquire);
    if (generation == 0 || generation != latest ||
        generation <= impl_->highestAttemptGeneration ||
        impl_->pendingClaimGeneration != generation ||
        !playbackOwnershipMatches(impl_->sessionId, generation) ||
        impl_->failedPrepareCleanupGeneration != 0) {
      return failureWithoutMessage(NativePlaybackError::InvalidGeneration,
                                   generation, impl_->state);
    }
    impl_->highestAttemptGeneration = generation;
    impl_->pendingClaimGeneration = 0;
    impl_->claimedHandoffLeaseGeneration = 0;
    impl_->claimedHandoffLease = 0;
    impl_->failedPrepareCleanupGeneration = generation;
    if (impl_->prepared == nullptr && impl_->generation == 0 &&
        impl_->activeGeneration.load(std::memory_order_acquire) == 0) {
      impl_->state = NativePlaybackState::Unloaded;
      impl_->preparedConfig = {};
      impl_->lastHost = {};
      impl_->lastTerminal = {};
      impl_->lastError.clear();
    }
    const NativePlaybackError admitted =
        error == NativePlaybackError::ResourceExhausted
            ? NativePlaybackError::ResourceExhausted
            : NativePlaybackError::DecodeFailure;
    return failureWithoutMessage(admitted, generation, impl_->state);
  } catch (...) {
    return failureWithoutMessage(NativePlaybackError::ProviderFailure,
                                 generation, NativePlaybackState::Unloaded);
  }
}

NativePlaybackResult
NativePlaybackSession::prepare(NativePlaybackPrepareConfig config,
                               std::vector<NativePlaybackLaneSource> sources,
                               uint64_t generation,
                               DecodeCancellation cancellation) try {
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    std::lock_guard<std::mutex> gate(impl_->generationGate);
    uint64_t latest = impl_->latestGeneration.load(std::memory_order_acquire);
    if (generation == 0 || generation < latest ||
        generation <= impl_->highestAttemptGeneration) {
      injectFailure(impl_->testHooks,
                    NativePlaybackAllocationPoint::PreparePreconditionResult);
      return failure(NativePlaybackError::InvalidGeneration, generation,
                     impl_->state,
                     "Playback generation must increase monotonically");
    }
    if (generation > latest) {
      const PlaybackCoordinatorClaim claim = claimPlaybackOwnership(
          impl_->sessionId, generation, config.handoffLease);
      if (!claim.ok) {
        injectFailure(impl_->testHooks,
                      NativePlaybackAllocationPoint::PreparePreconditionResult);
        return failure(claim.error, generation, impl_->state,
                       "Native playback ownership is unavailable");
      }
      impl_->latestGeneration.store(generation, std::memory_order_release);
      impl_->pendingClaimGeneration = generation;
      impl_->claimedHandoffLeaseGeneration = generation;
      impl_->claimedHandoffLease = claim.consumedLease;
      latest = generation;
    }
    const PlaybackOwnershipSnapshot ownership = playbackOwnershipSnapshot();
    if (generation != latest || impl_->pendingClaimGeneration != generation ||
        ownership.state != NativePlaybackCoordinatorState::NativeOwned ||
        ownership.ownerSession != impl_->sessionId ||
        ownership.ownerGeneration != generation ||
        impl_->claimedHandoffLeaseGeneration != generation ||
        impl_->claimedHandoffLease != config.handoffLease) {
      injectFailure(impl_->testHooks,
                    NativePlaybackAllocationPoint::PreparePreconditionResult);
      return failure(ownership.state == NativePlaybackCoordinatorState::Poisoned
                         ? NativePlaybackError::TeardownUncertain
                         : NativePlaybackError::InvalidGeneration,
                     generation, impl_->state,
                     "The native playback ownership claim is stale");
    }
    if (impl_->prepared != nullptr || impl_->generation != 0 ||
        impl_->activeGeneration.load(std::memory_order_acquire) != 0 ||
        impl_->failedPrepareCleanupGeneration != 0 ||
        impl_->retiringPrepareGeneration != 0) {
      injectFailure(impl_->testHooks,
                    NativePlaybackAllocationPoint::PreparePreconditionResult);
      return failure(NativePlaybackError::InvalidState, generation,
                     impl_->state,
                     "Unload the active native playback generation first");
    }
    if (!impl_->reserveQuarantineReservation()) {
      impl_->highestAttemptGeneration = generation;
      impl_->pendingClaimGeneration = 0;
      impl_->claimedHandoffLeaseGeneration = 0;
      impl_->claimedHandoffLease = 0;
      impl_->failedPrepareCleanupGeneration = generation;
      impl_->lastHost = {};
      impl_->lastTerminal = {};
      impl_->lastError.clear();
      return failure(NativePlaybackError::ResourceExhausted, generation,
                     impl_->state,
                     "The bounded native playback quarantine is unavailable");
    }
    impl_->highestAttemptGeneration = generation;
    impl_->pendingClaimGeneration = 0;
    impl_->claimedHandoffLeaseGeneration = 0;
    impl_->claimedHandoffLease = 0;
    impl_->generation = generation;
    impl_->activeGeneration.store(generation, std::memory_order_release);
    impl_->state = NativePlaybackState::Preparing;
    impl_->prepareMutationGeneration = generation;
    impl_->lastHost = {};
    impl_->lastTerminal = {};
    impl_->lastError.clear();
  }

  const auto failPreparation = [&](NativePlaybackError error,
                                   std::string message) {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (impl_->generation == generation && impl_->prepared == nullptr) {
      impl_->prepareMutationGeneration = 0;
      impl_->generation = 0;
      impl_->activeGeneration.store(0, std::memory_order_release);
      impl_->state = NativePlaybackState::Unloaded;
      impl_->failedPrepareCleanupGeneration = generation;
      if (error == NativePlaybackError::Cancelled)
        impl_->lastCancelledGeneration = generation;
      impl_->lastError = message;
    }
    return failure(error, generation, impl_->state, std::move(message));
  };

  if (config.outputDeviceUid.empty() || !validChannels(config.outputChannels) ||
      !std::isfinite(config.requestedSampleRate) ||
      config.requestedSampleRate <= 0.0 ||
      config.requestedSampleRate >
          static_cast<double>(std::numeric_limits<uint32_t>::max()) ||
      std::floor(config.requestedSampleRate) != config.requestedSampleRate ||
      config.maximumFrames == 0 || config.maximumFrames > kAudioHostMaxFrames ||
      !finiteGain(config.masterGain) || config.maximumRetainedBytes == 0 ||
      sources.empty() || sources.size() > kNativePlaybackMaximumLanes) {
    return failPreparation(NativePlaybackError::InvalidConfiguration,
                           "Native playback configuration is invalid");
  }
  for (size_t index = 0; index < sources.size(); ++index) {
    if (sources[index].id.empty() || !sources[index].descriptor.valid() ||
        !finiteGain(sources[index].gain)) {
      return failPreparation(NativePlaybackError::InvalidConfiguration,
                             "A playback lane is invalid");
    }
    for (size_t prior = 0; prior < index; ++prior)
      if (sources[index].id == sources[prior].id)
        return failPreparation(NativePlaybackError::InvalidConfiguration,
                               "Playback lane IDs must be unique");
  }

  PrepareCancellationState cancellationState{&impl_->latestGeneration,
                                             &impl_->cancelledThrough,
                                             generation, cancellation};
  const DecodeCancellation combined{&cancellationState, prepareCancelled};

  std::vector<PreparedPlaybackGraph::Lane> decoded;
  decoded.reserve(sources.size());
  size_t retained = 0;
  for (NativePlaybackLaneSource &source : sources) {
    if (combined.isRequested())
      return failPreparation(NativePlaybackError::Cancelled,
                             "Native playback preparation was superseded");
    DecodedAudioPrepareOptions options = config.decodeOptions;
    options.requiredSampleRate =
        static_cast<uint32_t>(std::llround(config.requestedSampleRate));
    const size_t remaining = config.maximumRetainedBytes - retained;
    if (remaining == 0) {
      return failPreparation(
          NativePlaybackError::LimitExceeded,
          "Prepared playback lanes reached the aggregate memory limit");
    }
    options.maximumDecodedBytes =
        std::min(options.maximumDecodedBytes, remaining);
    DecodedAudioResult result =
        prepareDecodedAudio(std::move(source.descriptor), options, combined);
    if (!result.ok()) {
      const NativePlaybackError error = decodeError(result.status);
      return failPreparation(
          error, error == NativePlaybackError::Cancelled
                     ? "Native playback preparation was superseded"
                     : "A WAV/FLAC playback lane could not be prepared");
    }
    const size_t bytes = result.audio->retainedBytes();
    if (bytes > config.maximumRetainedBytes - retained) {
      return failPreparation(
          NativePlaybackError::LimitExceeded,
          "Prepared playback lanes exceed the aggregate memory limit");
    }
    retained += bytes;
    PreparedPlaybackGraph::Lane lane;
    lane.id = std::move(source.id);
    lane.owner = std::move(result.audio);
    lane.gain = source.gain;
    lane.muted = source.muted;
    lane.solo = source.solo;
    decoded.push_back(std::move(lane));
    injectFailure(impl_->testHooks, NativePlaybackAllocationPoint::AfterDecode);
  }
  if (combined.isRequested())
    return failPreparation(NativePlaybackError::Cancelled,
                           "Native playback preparation was superseded");

  auto prepared = std::make_unique<PreparedPlaybackGraph>(
      std::move(decoded), config.requestedSampleRate,
      static_cast<uint32_t>(config.outputChannels.size()), config.maximumFrames,
      config.masterGain, impl_->testHooks);
  prepared->inject(NativePlaybackAllocationPoint::AfterArena);
  zdsp::GraphCompileError compileError{};
  const zdsp::Status graphStatus = prepared->prepare(&compileError);
  if (!zdsp::succeeded(graphStatus)) {
    (void)prepared->shutdown();
    return failPreparation(NativePlaybackError::GraphFailure,
                           "The native playback graph could not be prepared");
  }
  prepared->inject(NativePlaybackAllocationPoint::AfterGraphCompile);

  prepared->observe(NativePlaybackLifecycleEvent::PrepareReadyToPublish);
  std::unique_ptr<PreparedPlaybackGraph> stale;
  NativePlaybackState staleState = NativePlaybackState::Unloaded;
  {
    // claimGeneration takes generationGate. The final admission check and
    // publication are therefore one linearized action: a newer claim either
    // wins before this block and prevents publication, or follows it and
    // immediately makes this generation stale for output/control commands.
    std::lock_guard<std::mutex> lock(impl_->mutex);
    std::lock_guard<std::mutex> gate(impl_->generationGate);
    if (impl_->latestGeneration.load(std::memory_order_acquire) != generation ||
        impl_->cancelledThrough.load(std::memory_order_acquire) >= generation ||
        impl_->generation != generation ||
        impl_->state != NativePlaybackState::Preparing) {
      stale = std::move(prepared);
      impl_->retiringPrepareGeneration = generation;
      impl_->retiringPrepareBytes = stale->retainedBytes;
      const PlaybackOwnershipSnapshot ownership = playbackOwnershipSnapshot();
      impl_->retiringSupersededByNewerClaim =
          ownership.state == NativePlaybackCoordinatorState::NativeOwned &&
          ownership.ownerSession == impl_->sessionId &&
          ownership.ownerGeneration > generation;
      impl_->retiringUnloadRequested =
          impl_->prepareUnloadRequestedGeneration == generation ||
          impl_->retiringSupersededByNewerClaim;
      impl_->retiringOldUnloadCommandAccepted =
          impl_->prepareUnloadRequestedGeneration == generation;
      impl_->prepareUnloadRequestedGeneration = 0;
      publishPlaybackQuarantineRetainedBytes(stale->retainedBytes);
      if (impl_->generation == generation) {
        impl_->generation = 0;
        impl_->activeGeneration.store(0, std::memory_order_release);
        impl_->state = NativePlaybackState::Unloaded;
        if (!impl_->retiringSupersededByNewerClaim &&
            impl_->failedPrepareCleanupGeneration == 0)
          impl_->failedPrepareCleanupGeneration = generation;
        impl_->lastCancelledGeneration = generation;
      }
      impl_->lastError = "Native playback preparation was superseded";
      staleState = impl_->state;
    } else {
      impl_->prepared = std::move(prepared);
      publishPlaybackQuarantineRetainedBytes(impl_->prepared->retainedBytes);
      impl_->preparedConfig = std::move(config);
      impl_->state = NativePlaybackState::Prepared;
      // Preparing a new generation has not touched AudioHost. Publish a fresh
      // per-generation baseline rather than the provider's previous stopped
      // stream counters, negotiated format or latency.
      impl_->lastHost = {};
      impl_->lastTerminal = {};
      impl_->lastError.clear();
      impl_->prepareMutationGeneration = 0;
      return impl_->success(generation);
    }
  }
  // Decoded owners can be hundreds of megabytes and graph shutdown may wait
  // on test/provider quiescence. Neither session mutex nor generation gate is
  // held while retiring the stale local graph.
  const bool retired = stale->shutdown();
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (impl_->retiringPrepareGeneration != generation) {
      // Losing the ownership record would make freeing callback-visible state
      // unverifiable. Preserve the graph rather than guessing.
      if (stale != nullptr)
        quarantineReserved(&stale);
      impl_->quarantineSlotReserved = false;
      poisonPlaybackOwnership(impl_->sessionId, generation);
      return failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                   generation, impl_->state);
    }
    const bool unloadRequested = impl_->retiringUnloadRequested;
    const bool supersededByNewerClaim = impl_->retiringSupersededByNewerClaim;
    const bool oldUnloadCommandAccepted =
        impl_->retiringOldUnloadCommandAccepted;
    impl_->retiringPrepareGeneration = 0;
    impl_->retiringPrepareBytes = 0;
    impl_->retiringUnloadRequested = false;
    impl_->retiringSupersededByNewerClaim = false;
    impl_->retiringOldUnloadCommandAccepted = false;
    if (impl_->prepareMutationGeneration == generation)
      impl_->prepareMutationGeneration = 0;
    if (!retired) {
      // shutdown() failed before decoded release. Consume the exact reservation
      // that admitted this stale graph; never republish it into a newer
      // generation's session state.
      quarantineReserved(&stale);
      impl_->quarantineSlotReserved = false;
      poisonPlaybackOwnership(impl_->sessionId, generation);
      if (unloadRequested) {
        if (!supersededByNewerClaim) {
          impl_->failedPrepareCleanupGeneration = 0;
          impl_->lastUnloadedGeneration = generation;
        }
        if (supersededByNewerClaim &&
            impl_->pendingClaimUnloadGeneration != 0) {
          const uint64_t cleanupGeneration =
              impl_->pendingClaimUnloadGeneration.load(
                  std::memory_order_acquire);
          const auto cleanup = impl_->cleanupSnapshot(
              NativePlaybackCleanupSafety::Uncertain,
              NativePlaybackError::TeardownUncertain, cleanupGeneration);
          impl_->publishUnloadReceipt(
              cleanupGeneration,
              failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                    cleanupGeneration, impl_->state),
              cleanup);
          if (oldUnloadCommandAccepted)
            impl_->publishUnloadReceipt(
                generation,
                failureWithoutMessage(NativePlaybackError::GraphFailure,
                                      generation, impl_->state),
                cleanup);
          else
            impl_->discardUnloadReceipt(generation);
        }
      }
      impl_->lastError =
          "The stale native playback graph did not retire cleanly";
      return failureWithoutMessage(NativePlaybackError::GraphFailure,
                                   generation, impl_->state);
    }
    publishPlaybackQuarantineRetainedBytes(0);
    if (unloadRequested) {
      if (!supersededByNewerClaim) {
        impl_->failedPrepareCleanupGeneration = 0;
        impl_->lastUnloadedGeneration = generation;
        impl_->releaseQuarantineReservation();
      } else if (impl_->pendingClaimUnloadGeneration != 0) {
        (void)impl_->finalizeDeferredClaimUnloadAfterRetirement(
            generation, oldUnloadCommandAccepted);
      }
    }
    staleState = impl_->state;
  }
  return failure(NativePlaybackError::Cancelled, generation, staleState,
                 "Native playback preparation was superseded");
} catch (const std::bad_alloc &) {
  return impl_->recoverPrepareException(NativePlaybackError::ResourceExhausted,
                                        generation);
} catch (...) {
  return impl_->recoverPrepareException(NativePlaybackError::GraphFailure,
                                        generation);
}

NativePlaybackResult NativePlaybackSession::openOutput(
    uint64_t generation, NativePlaybackDeliveryToken *deliveryToken) try {
  if (deliveryToken != nullptr)
    *deliveryToken = {};
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation)) {
    injectFailure(impl_->testHooks,
                  NativePlaybackAllocationPoint::OpenPreconditionResult);
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  }
  if (impl_->state == NativePlaybackState::Terminal) {
    injectFailure(impl_->testHooks,
                  NativePlaybackAllocationPoint::OpenPreconditionResult);
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback reached a terminal output state");
  }
  if ((impl_->state != NativePlaybackState::Prepared &&
       impl_->state != NativePlaybackState::Stopped) ||
      !impl_->prepared->allCursorsAtStart()) {
    injectFailure(impl_->testHooks,
                  NativePlaybackAllocationPoint::OpenPreconditionResult);
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "The prepared frame-zero graph cannot open output now");
  }

  const NativePlaybackPrepareConfig &config = impl_->preparedConfig;
  const AudioHostInventory inventory = impl_->host.enumerate();
  const auto output = std::find_if(
      inventory.devices.begin(), inventory.devices.end(),
      [&](const AudioHostDeviceInfo &device) {
        return device.uid == config.outputDeviceUid &&
               (device.direction == AudioHostEndpointDirection::Output ||
                device.direction == AudioHostEndpointDirection::Duplex);
      });
  bool routeValid = output != inventory.devices.end() &&
                    output->outputChannels != 0 &&
                    output->nominalSampleRate == config.requestedSampleRate;
  for (uint32_t channel : config.outputChannels)
    routeValid = routeValid && output != inventory.devices.end() &&
                 channel < output->outputChannels;
  if (!routeValid) {
    impl_->lastError = "The prepared iOS output route no longer matches";
    return failure(NativePlaybackError::HostFailure, generation, impl_->state,
                   impl_->lastError);
  }

  AudioHostConfig hostConfig;
  hostConfig.outputDeviceUid = config.outputDeviceUid;
  hostConfig.outputChannels = config.outputChannels;
  hostConfig.requestedSampleRate = config.requestedSampleRate;
  hostConfig.requestedBufferFrames = config.requestedBufferFrames;
  hostConfig.maximumFrames = config.maximumFrames;
  if (!impl_->armDelivery(NativePlaybackDeliveryCommand::OpenOutput, generation,
                          deliveryToken)) {
    return failureWithoutMessage(NativePlaybackError::ResourceExhausted,
                                 generation, impl_->state);
  }
  impl_->openInvocationGeneration = generation;
  impl_->openMutationGeneration = generation;
  const AudioHostResult opened = impl_->host.open(
      hostConfig, &nativePlaybackRender, &impl_->prepared->callback);
  const uint32_t actualMaximumFrames = opened.format.maximumFrames;
  const uint32_t nominalBufferFrames = opened.format.nominalBufferFrames;
  const bool exact =
      opened.ok && opened.format.sampleRate == config.requestedSampleRate &&
      actualMaximumFrames != 0 && actualMaximumFrames <= config.maximumFrames &&
      nominalBufferFrames != 0 && nominalBufferFrames <= actualMaximumFrames &&
      opened.format.inputChannels == 0 &&
      opened.format.outputChannels == config.outputChannels.size();
  std::unique_lock<std::mutex> gate(impl_->generationGate);
  const bool stillCurrent =
      impl_->latestGeneration.load(std::memory_order_acquire) == generation &&
      impl_->cancelledThrough.load(std::memory_order_acquire) < generation;
  if (!exact || !stillCurrent) {
    // The decision not to publish OutputOpen is now linearized. Do not hold
    // the generation gate across provider quiescence.
    gate.unlock();
    const std::string message =
        !stillCurrent ? "Native playback output open was superseded"
        : opened.message.empty()
            ? "The host did not negotiate the exact source graph format"
            : opened.message;
    if (!impl_->stopHost(true, true)) {
      impl_->state = NativePlaybackState::Quarantined;
      impl_->lastError =
          "The failed output open did not confirm callback quiescence";
      return failure(NativePlaybackError::TeardownUncertain, generation,
                     impl_->state, impl_->lastError);
    }
    impl_->state = NativePlaybackState::Prepared;
    impl_->lastError = message;
    return failure(!stillCurrent ? NativePlaybackError::Cancelled
                                 : NativePlaybackError::HostFailure,
                   generation, impl_->state, impl_->lastError);
  }
  impl_->state = NativePlaybackState::OutputOpen;
  impl_->lastHost = impl_->host.status();
  impl_->lastTerminal = {};
  impl_->lastError.clear();
  NativePlaybackResult result = impl_->success(generation);
  impl_->openInvocationGeneration = 0;
  return result;
} catch (const std::bad_alloc &) {
  return impl_->recoverOpenException(NativePlaybackError::ResourceExhausted,
                                     generation);
} catch (...) {
  return impl_->recoverOpenException(NativePlaybackError::ProviderFailure,
                                     generation);
}

NativePlaybackResult
NativePlaybackSession::start(uint64_t generation,
                             NativePlaybackDeliveryToken *deliveryToken) try {
  if (deliveryToken != nullptr)
    *deliveryToken = {};
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation)) {
    injectFailure(impl_->testHooks,
                  NativePlaybackAllocationPoint::StartPreconditionResult);
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  }
  if (impl_->state == NativePlaybackState::Terminal) {
    injectFailure(impl_->testHooks,
                  NativePlaybackAllocationPoint::StartPreconditionResult);
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback reached a terminal output state");
  }
  if (impl_->state != NativePlaybackState::OutputOpen ||
      !impl_->prepared->allCursorsAtStart()) {
    injectFailure(impl_->testHooks,
                  NativePlaybackAllocationPoint::StartPreconditionResult);
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback can start only once from frame zero");
  }

  const AudioHostStatus before = impl_->host.status();
  const AudioHostTerminalCause callbackBefore = impl_->callbackTerminalCause();
  const AudioHostTerminalCause terminalBefore =
      effectiveTerminalCause(before, callbackBefore);
  if (terminalBefore.reason != AudioHostTerminalReason::None ||
      before.state == AudioHostState::DeviceLost ||
      before.state == AudioHostState::Error) {
    impl_->latchTerminal(terminalBefore.reason != AudioHostTerminalReason::None
                             ? terminalBefore
                             : makeAudioHostTerminalCause(
                                   AudioHostTerminalReason::ProviderFailure));
    impl_->state = NativePlaybackState::Terminal;
    return failureWithoutMessage(NativePlaybackError::ProviderFailure,
                                 generation, impl_->state);
  }
  if (before.state != AudioHostState::Open) {
    injectFailure(impl_->testHooks,
                  NativePlaybackAllocationPoint::StartPreconditionResult);
    return failureWithoutMessage(NativePlaybackError::HostFailure, generation,
                                 impl_->state);
  }

  // The provider may invoke the render callback before start() returns. Keep
  // the public state at OutputOpen until generation, cancellation, callback
  // and host health have all been revalidated after that call.
  if (!impl_->armDelivery(NativePlaybackDeliveryCommand::Start, generation,
                          deliveryToken)) {
    return failureWithoutMessage(NativePlaybackError::ResourceExhausted,
                                 generation, impl_->state);
  }
  impl_->startInvocationGeneration = generation;
  impl_->startMutationGeneration = generation;
  const AudioHostResult started = impl_->host.start();
  const AudioHostStatus after = impl_->host.status();
  const AudioHostTerminalCause callbackAfter = impl_->callbackTerminalCause();
  const AudioHostTerminalCause terminalAfter =
      effectiveTerminalCause(after, callbackAfter);
  std::unique_lock<std::mutex> gate(impl_->generationGate);
  const bool stillLatest =
      impl_->latestGeneration.load(std::memory_order_acquire) == generation;
  const bool notCancelled =
      impl_->cancelledThrough.load(std::memory_order_acquire) < generation;
  const bool callbackHealthy =
      callbackAfter.reason == AudioHostTerminalReason::None;
  const bool hostHealthy =
      started.ok && after.state == AudioHostState::Running &&
      after.terminalReason == AudioHostTerminalReason::None;
  if (!stillLatest || !notCancelled || !callbackHealthy || !hostHealthy) {
    const NativePlaybackError error =
        !stillLatest || !notCancelled
            ? NativePlaybackError::Cancelled
            : (!started.ok ? NativePlaybackError::HostFailure
                           : NativePlaybackError::ProviderFailure);
    if (terminalAfter.reason != AudioHostTerminalReason::None)
      impl_->latchTerminal(terminalAfter);
    // No Running state was published. Claims remain immediate while a slow
    // provider stop establishes callback quiescence.
    gate.unlock();
    if (!impl_->stopHost(false, true)) {
      impl_->state = NativePlaybackState::Quarantined;
      return failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                   generation, impl_->state);
    }
    // stopHost performs the final post-quiescence host+graph merge. A route,
    // provider or graph terminal can arrive during stop itself, after the
    // pre-stop snapshot above, so publication must use that merged latch.
    impl_->state = impl_->lastTerminal.reason != AudioHostTerminalReason::None
                       ? NativePlaybackState::Terminal
                       : NativePlaybackState::Stopped;
    impl_->lastError.clear();
    return failureWithoutMessage(error, generation, impl_->state);
  }
  // Running is provisional and still hidden by the session mutex. A callback
  // may begin as host.start returns, so provide a deterministic test edge and
  // then revalidate every publication guard once more before returning ok.
  impl_->state = NativePlaybackState::Running;
  gate.unlock();
  if (impl_->prepared != nullptr)
    impl_->prepared->observe(
        NativePlaybackLifecycleEvent::HostStartProvisionalRunning);
  const AudioHostStatus finalHost = impl_->host.status();
  const AudioHostTerminalCause finalCallback = impl_->callbackTerminalCause();
  const AudioHostTerminalCause finalTerminal =
      effectiveTerminalCause(finalHost, finalCallback);
  gate.lock();
  const bool finallyLatest =
      impl_->latestGeneration.load(std::memory_order_acquire) == generation;
  const bool finallyNotCancelled =
      impl_->cancelledThrough.load(std::memory_order_acquire) < generation;
  const bool finallyHealthy =
      finalTerminal.reason == AudioHostTerminalReason::None &&
      finalHost.state == AudioHostState::Running;
  if (!finallyLatest || !finallyNotCancelled || !finallyHealthy) {
    if (finalTerminal.reason != AudioHostTerminalReason::None)
      impl_->latchTerminal(finalTerminal);
    gate.unlock();
    if (!impl_->stopHost(false, true)) {
      impl_->state = NativePlaybackState::Quarantined;
      return failureWithoutMessage(NativePlaybackError::TeardownUncertain,
                                   generation, impl_->state);
    }
    impl_->state = impl_->lastTerminal.reason != AudioHostTerminalReason::None
                       ? NativePlaybackState::Terminal
                       : NativePlaybackState::Stopped;
    return failureWithoutMessage(!finallyLatest || !finallyNotCancelled
                                     ? NativePlaybackError::Cancelled
                                     : NativePlaybackError::ProviderFailure,
                                 generation, impl_->state);
  }
  impl_->lastHost = finalHost;
  impl_->lastError.clear();
  NativePlaybackResult result{true,
                              NativePlaybackError::None,
                              generation,
                              impl_->state,
                              finalHost.format,
                              finalHost.latency,
                              {}};
  impl_->startInvocationGeneration = 0;
  return result;
} catch (const std::bad_alloc &) {
  return impl_->recoverStartException(NativePlaybackError::ResourceExhausted,
                                      generation);
} catch (...) {
  return impl_->recoverStartException(NativePlaybackError::ProviderFailure,
                                      generation);
}

bool NativePlaybackSession::acknowledgeDelivery(
    NativePlaybackDeliveryToken token) noexcept {
  if (!token.valid())
    return false;
  try {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    NativePlaybackDeliveryToken *pending = nullptr;
    if (token.command == NativePlaybackDeliveryCommand::OpenOutput)
      pending = &impl_->pendingOpenDelivery;
    if (token.command == NativePlaybackDeliveryCommand::Start)
      pending = &impl_->pendingStartDelivery;
    if (pending == nullptr || !impl_->sameDeliveryToken(*pending, token))
      return false;
    *pending = {};
    return true;
  } catch (...) {
    return false;
  }
}

NativePlaybackCleanupResult NativePlaybackSession::abortDelivery(
    NativePlaybackDeliveryToken token) noexcept {
  NativePlaybackCleanupResult uncertain{
      NativePlaybackCleanupSafety::Uncertain,
      NativePlaybackError::TeardownUncertain,
      token.generation,
      NativePlaybackState::Quarantined,
      0,
      AudioHostTerminalReason::ProviderFailure,
      true};
  if (!token.valid()) {
    uncertain.safety = NativePlaybackCleanupSafety::NotOwned;
    uncertain.error = NativePlaybackError::None;
    uncertain.state = NativePlaybackState::Unloaded;
    uncertain.terminalReason = AudioHostTerminalReason::None;
    return uncertain;
  }
  try {
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      NativePlaybackDeliveryToken *pending = nullptr;
      if (token.command == NativePlaybackDeliveryCommand::OpenOutput)
        pending = &impl_->pendingOpenDelivery;
      if (token.command == NativePlaybackDeliveryCommand::Start)
        pending = &impl_->pendingStartDelivery;
      if (pending == nullptr || !impl_->sameDeliveryToken(*pending, token))
        return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::NotOwned,
                                      NativePlaybackError::None,
                                      token.generation);
      // Consume the exact one-shot capability before releasing the mutex.
      // A duplicate abort and an acknowledgement racing behind it are no-ops.
      *pending = {};
    }
    (void)requestCancellation(token.generation);
    return unloadWithCleanup(token.generation).cleanup;
  } catch (...) {
    try {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::Uncertain,
                                    NativePlaybackError::TeardownUncertain,
                                    token.generation);
    } catch (...) {
      return uncertain;
    }
  }
}

NativePlaybackCleanupResult
NativePlaybackSession::abortPrepareDelivery(uint64_t generation) noexcept {
  NativePlaybackCleanupResult uncertain{
      NativePlaybackCleanupSafety::Uncertain,
      NativePlaybackError::TeardownUncertain,
      generation,
      NativePlaybackState::Quarantined,
      0,
      AudioHostTerminalReason::ProviderFailure,
      true};
  if (generation == 0) {
    uncertain.safety = NativePlaybackCleanupSafety::NotOwned;
    uncertain.error = NativePlaybackError::None;
    uncertain.state = NativePlaybackState::Unloaded;
    uncertain.terminalReason = AudioHostTerminalReason::None;
    return uncertain;
  }
  try {
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      if (const auto *receipt = impl_->findUnloadReceipt(generation);
          receipt != nullptr && receipt->ready &&
          impl_->cleanupReceiptStillCurrent(receipt->cleanup))
        return receipt->cleanup;
      if (generation == impl_->lastUnloadedGeneration) {
        return impl_->acquireCleanupLease(generation);
      }
      const bool owned =
          (generation == impl_->generation && impl_->prepared != nullptr) ||
          generation == impl_->failedPrepareCleanupGeneration ||
          generation == impl_->pendingClaimGeneration ||
          generation == impl_->retiringPrepareGeneration;
      if (!owned)
        return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::NotOwned,
                                      NativePlaybackError::None, generation);
    }
    (void)requestCancellation(generation);
    return unloadWithCleanup(generation).cleanup;
  } catch (...) {
    try {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::Uncertain,
                                    NativePlaybackError::TeardownUncertain,
                                    generation);
    } catch (...) {
      return uncertain;
    }
  }
}

NativePlaybackCleanupResult
NativePlaybackSession::cleanupProof(uint64_t generation) const noexcept {
  NativePlaybackCleanupResult uncertain{
      NativePlaybackCleanupSafety::Uncertain,
      NativePlaybackError::TeardownUncertain,
      generation,
      NativePlaybackState::Quarantined,
      0,
      AudioHostTerminalReason::ProviderFailure,
      true};
  if (generation == 0) {
    uncertain.safety = NativePlaybackCleanupSafety::NotOwned;
    uncertain.error = NativePlaybackError::None;
    uncertain.state = NativePlaybackState::Unloaded;
    uncertain.terminalReason = AudioHostTerminalReason::None;
    return uncertain;
  }
  try {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    if (generation == impl_->unloadReceiptJournalExhaustedGeneration)
      return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::Uncertain,
                                    NativePlaybackError::ResourceExhausted,
                                    generation);
    if (const auto *receipt = impl_->findUnloadReceipt(generation);
        receipt != nullptr && receipt->ready) {
      if (receipt->cleanup.generation == generation &&
          impl_->cleanupReceiptStillCurrent(receipt->cleanup))
        return receipt->cleanup;
      if (receipt->cleanup.generation != generation)
        return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::NotOwned,
                                      NativePlaybackError::None, generation);
    }
    if (playbackOwnershipSnapshot().state ==
        NativePlaybackCoordinatorState::Poisoned) {
      return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::Uncertain,
                                    NativePlaybackError::TeardownUncertain,
                                    generation);
    }
    if (generation == impl_->retiringPrepareGeneration) {
      return impl_->cleanupSnapshot(NativePlaybackCleanupSafety::Uncertain,
                                    NativePlaybackError::TeardownUncertain,
                                    generation);
    }
    if (generation == impl_->lastUnloadedGeneration) {
      return impl_->acquireCleanupLease(generation);
    }
    const bool stillOwned =
        generation == impl_->failedPrepareCleanupGeneration ||
        generation == impl_->pendingClaimGeneration ||
        generation == impl_->prepareMutationGeneration ||
        generation == impl_->generation ||
        impl_->hostMutationActiveFor(generation);
    return impl_->cleanupSnapshot(
        stillOwned ? NativePlaybackCleanupSafety::Uncertain
                   : NativePlaybackCleanupSafety::NotOwned,
        stillOwned ? NativePlaybackError::TeardownUncertain
                   : NativePlaybackError::None,
        generation);
  } catch (...) {
    return uncertain;
  }
}

NativePlaybackResult NativePlaybackSession::stop(uint64_t generation) {
  (void)requestCancellation(generation);
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (generation == 0 || generation != impl_->generation ||
      impl_->prepared == nullptr) {
    if (generation != 0 && generation == impl_->generation &&
        impl_->state == NativePlaybackState::Preparing)
      return impl_->success(generation);
    if (generation != 0 && generation == impl_->lastCancelledGeneration)
      return impl_->success(generation);
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  }
  if (impl_->state != NativePlaybackState::Running &&
      impl_->state != NativePlaybackState::OutputOpen &&
      impl_->state != NativePlaybackState::Prepared &&
      impl_->state != NativePlaybackState::Terminal &&
      impl_->state != NativePlaybackState::Stopped) {
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback is not stoppable in its current state");
  }
  if (!impl_->stopHost()) {
    impl_->state = NativePlaybackState::Quarantined;
    impl_->lastError = "The native output host did not confirm quiescence";
    return failure(NativePlaybackError::TeardownUncertain, generation,
                   impl_->state, impl_->lastError);
  }
  impl_->state = impl_->lastTerminal.reason != AudioHostTerminalReason::None
                     ? NativePlaybackState::Terminal
                     : NativePlaybackState::Stopped;
  impl_->lastError.clear();
  return impl_->success(generation);
}

NativePlaybackResult NativePlaybackSession::unload(uint64_t generation) {
  (void)requestCancellation(generation);
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (const auto *receipt = impl_->findUnloadReceipt(generation);
      receipt != nullptr && receipt->ready &&
      impl_->cleanupReceiptStillCurrent(receipt->cleanup))
    return Impl::playbackFromReceipt(*receipt);
  impl_->refreshTerminalState();
  if (generation != 0 &&
      (generation == impl_->pendingClaimGeneration ||
       generation == impl_->failedPrepareCleanupGeneration) &&
      generation != impl_->generation) {
    // A newer same-session synchronous claim can be globally visible while
    // the superseded prepare is still decoding or retiring. Exact cleanup of
    // the newer claim is recorded now, but the shared fail-stop reservation
    // remains owned until the old graph has physically retired.
    if (impl_->generation != 0 || impl_->retiringPrepareGeneration != 0) {
      const uint64_t retiredGeneration = impl_->generation != 0
                                             ? impl_->generation
                                             : impl_->retiringPrepareGeneration;
      if (!impl_->reserveDeferredUnloadReceipts(retiredGeneration, generation))
        return failureWithoutMessage(NativePlaybackError::ResourceExhausted,
                                     generation, impl_->state);
      impl_->pendingClaimUnloadGeneration = generation;
      impl_->lastCancelledGeneration = generation;
      const NativePlaybackResult accepted = impl_->success(generation);
      impl_->publishUnloadReceipt(
          generation, accepted,
          impl_->cleanupSnapshot(NativePlaybackCleanupSafety::Uncertain,
                                 NativePlaybackError::TeardownUncertain,
                                 generation));
      return accepted;
    }
    if (impl_->pendingClaimGeneration == generation)
      impl_->pendingClaimGeneration = 0;
    if (impl_->failedPrepareCleanupGeneration == generation)
      impl_->failedPrepareCleanupGeneration = 0;
    impl_->pendingClaimUnloadGeneration = 0;
    impl_->claimedHandoffLeaseGeneration = 0;
    impl_->claimedHandoffLease = 0;
    impl_->lastUnloadedGeneration = generation;
    impl_->releaseQuarantineReservation();
    impl_->state = NativePlaybackState::Unloaded;
    impl_->lastError.clear();
    return impl_->success(generation);
  }
  if (generation != 0 && generation == impl_->retiringPrepareGeneration) {
    // The graph is deliberately outside the mutex but remains owned by this
    // session and its process reservation. Record the exact unload intent;
    // retirement completion will release the handshake atomically.
    impl_->retiringUnloadRequested = true;
    impl_->retiringOldUnloadCommandAccepted = true;
    impl_->lastCancelledGeneration = generation;
    return impl_->success(generation);
  }
  if (generation != 0 && generation == impl_->generation &&
      impl_->prepared == nullptr &&
      impl_->state == NativePlaybackState::Preparing) {
    // Cancellation may arrive before the final publication check transfers
    // the soon-to-be-stale graph into retirement ownership.
    impl_->prepareUnloadRequestedGeneration = generation;
    impl_->lastCancelledGeneration = generation;
    return impl_->success(generation);
  }
  if (generation != 0 && impl_->prepared == nullptr &&
      impl_->state == NativePlaybackState::Unloaded &&
      generation == impl_->failedPrepareCleanupGeneration) {
    impl_->failedPrepareCleanupGeneration = 0;
    if (impl_->prepareUnloadRequestedGeneration == generation)
      impl_->prepareUnloadRequestedGeneration = 0;
    impl_->lastUnloadedGeneration = generation;
    impl_->pendingClaimUnloadGeneration = 0;
    impl_->claimedHandoffLeaseGeneration = 0;
    impl_->claimedHandoffLease = 0;
    impl_->releaseQuarantineReservation();
    impl_->lastError.clear();
    return impl_->success(generation);
  }
  if (generation != 0 && generation == impl_->lastUnloadedGeneration)
    return impl_->success(generation);
  if (generation == 0 || generation != impl_->generation ||
      impl_->prepared == nullptr) {
    if (generation != 0 && generation == impl_->lastCancelledGeneration)
      return impl_->success(generation);
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  }
  if (!impl_->stopHost()) {
    impl_->state = NativePlaybackState::Quarantined;
    impl_->lastError = "The native output host did not confirm quiescence";
    return failure(NativePlaybackError::TeardownUncertain, generation,
                   impl_->state, impl_->lastError);
  }
  if (!impl_->prepared->shutdown()) {
    impl_->state = NativePlaybackState::Quarantined;
    impl_->lastError = "The native playback graph did not retire cleanly";
    NativePlaybackResult failed =
        failure(NativePlaybackError::GraphFailure, generation, impl_->state,
                impl_->lastError);
    if (impl_->pendingClaimUnloadGeneration != 0) {
      const uint64_t cleanupGeneration =
          impl_->pendingClaimUnloadGeneration.load(std::memory_order_acquire);
      const auto cleanup = impl_->cleanupSnapshot(
          NativePlaybackCleanupSafety::Uncertain,
          NativePlaybackError::TeardownUncertain, cleanupGeneration);
      impl_->publishUnloadReceipt(cleanupGeneration, failed, cleanup);
      impl_->publishUnloadReceipt(generation, failed, cleanup);
    }
    return failed;
  }
  impl_->prepared.reset();
  impl_->lastUnloadedGeneration = generation;
  if (impl_->prepareUnloadRequestedGeneration == generation)
    impl_->prepareUnloadRequestedGeneration = 0;
  impl_->generation = 0;
  if (impl_->pendingClaimGeneration == generation)
    impl_->pendingClaimGeneration = 0;
  if (impl_->pendingClaimUnloadGeneration == generation)
    impl_->pendingClaimUnloadGeneration = 0;
  if (impl_->claimedHandoffLeaseGeneration == generation) {
    impl_->claimedHandoffLeaseGeneration = 0;
    impl_->claimedHandoffLease = 0;
  }
  impl_->activeGeneration.store(0, std::memory_order_release);
  impl_->state = NativePlaybackState::Unloaded;
  impl_->preparedConfig = {};
  impl_->lastError.clear();
  if (impl_->pendingClaimUnloadGeneration != 0) {
    (void)impl_->finalizeDeferredClaimUnloadAfterRetirement(generation, true);
    if (const auto *receipt = impl_->findUnloadReceipt(generation);
        receipt != nullptr && receipt->ready)
      return Impl::playbackFromReceipt(*receipt);
  } else {
    impl_->releaseQuarantineReservation();
  }
  return impl_->success(generation);
}

NativePlaybackUnloadReceipt
NativePlaybackSession::unloadWithCleanup(uint64_t generation) noexcept {
  NativePlaybackUnloadReceipt fallback;
  fallback.playback =
      failureWithoutMessage(NativePlaybackError::TeardownUncertain, generation,
                            NativePlaybackState::Quarantined);
  fallback.cleanup = {NativePlaybackCleanupSafety::Uncertain,
                      NativePlaybackError::TeardownUncertain,
                      generation,
                      NativePlaybackState::Quarantined,
                      0,
                      AudioHostTerminalReason::ProviderFailure,
                      true};
  try {
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      if (const auto *entry = impl_->findUnloadReceipt(generation);
          entry != nullptr && entry->ready &&
          impl_->cleanupReceiptStillCurrent(entry->cleanup))
        return Impl::unloadReceiptFromEntry(*entry);
    }
    NativePlaybackResult playback = unload(generation);
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      if (const auto *entry = impl_->findUnloadReceipt(generation);
          entry != nullptr && entry->ready &&
          impl_->cleanupReceiptStillCurrent(entry->cleanup))
        return Impl::unloadReceiptFromEntry(*entry);
    }
    NativePlaybackCleanupResult cleanup = cleanupProof(generation);
    std::lock_guard<std::mutex> lock(impl_->mutex);
    auto *entry = impl_->reserveUnloadReceipt(generation, cleanup.generation);
    if (entry == nullptr) {
      impl_->unloadReceiptJournalExhaustedGeneration = generation;
      cleanup = impl_->cleanupSnapshot(NativePlaybackCleanupSafety::Uncertain,
                                       NativePlaybackError::ResourceExhausted,
                                       generation);
      if (playback.ok) {
        playback.ok = false;
        playback.error = NativePlaybackError::ResourceExhausted;
        playback.message.clear();
      }
      return {std::move(playback), cleanup};
    }
    impl_->publishUnloadReceipt(generation, playback, cleanup);
    return Impl::unloadReceiptFromEntry(*entry);
  } catch (...) {
    return fallback;
  }
}

NativePlaybackResult
NativePlaybackSession::setLaneControl(uint64_t generation,
                                      const std::string &laneId, float gain,
                                      bool muted, bool solo) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation)) {
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  }
  if (impl_->state == NativePlaybackState::Terminal) {
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback reached a terminal output state");
  }
  if ((impl_->state != NativePlaybackState::Prepared &&
       impl_->state != NativePlaybackState::OutputOpen &&
       impl_->state != NativePlaybackState::Running) ||
      !finiteGain(gain)) {
    return failure(NativePlaybackError::InvalidConfiguration, generation,
                   impl_->state, "The lane control is invalid");
  }
  auto lane =
      std::find_if(impl_->prepared->lanes.begin(), impl_->prepared->lanes.end(),
                   [&](const PreparedPlaybackGraph::Lane &candidate) {
                     return candidate.id == laneId;
                   });
  if (lane == impl_->prepared->lanes.end()) {
    return failure(NativePlaybackError::InvalidConfiguration, generation,
                   impl_->state, "The playback lane ID is unknown");
  }
  const float previousGain = lane->gain;
  const bool previousMuted = lane->muted;
  const bool previousSolo = lane->solo;
  lane->gain = gain;
  lane->muted = muted;
  lane->solo = solo;
  if (!impl_->prepared->applyLaneGains()) {
    lane->gain = previousGain;
    lane->muted = previousMuted;
    lane->solo = previousSolo;
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded playback parameter queue is full");
  }
  return impl_->success(generation);
}

NativePlaybackResult NativePlaybackSession::setMasterGain(uint64_t generation,
                                                          float gain) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  if (!impl_->currentForCommand(generation)) {
    return failure(NativePlaybackError::InvalidGeneration, generation,
                   impl_->state, "The playback generation is stale");
  }
  if (impl_->state == NativePlaybackState::Terminal) {
    return failure(NativePlaybackError::InvalidState, generation, impl_->state,
                   "Native playback reached a terminal output state");
  }
  if ((impl_->state != NativePlaybackState::Prepared &&
       impl_->state != NativePlaybackState::OutputOpen &&
       impl_->state != NativePlaybackState::Running) ||
      !finiteGain(gain)) {
    return failure(NativePlaybackError::InvalidConfiguration, generation,
                   impl_->state, "The master gain is invalid");
  }
  if (!impl_->prepared->enqueueMaster(gain)) {
    return failure(NativePlaybackError::QueueFull, generation, impl_->state,
                   "The bounded playback parameter queue is full");
  }
  impl_->prepared->masterGain = gain;
  return impl_->success(generation);
}

NativePlaybackStatus NativePlaybackSession::status() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->refreshTerminalState();
  NativePlaybackStatus result;
  result.generation = impl_->generation;
  result.state = impl_->state;
  result.host = impl_->prepared != nullptr && impl_->hostMutationActive()
                    ? impl_->host.status()
                    : impl_->lastHost;
  const AudioHostTerminalCause callback = impl_->callbackTerminalCause();
  AudioHostTerminalCause reported = impl_->lastTerminal;
  reported = firstAudioHostTerminalCause(
      reported, {result.host.terminalReason, result.host.terminalOrdinal});
  reported = firstAudioHostTerminalCause(reported, callback);
  result.terminalReason = reported.reason;
  result.terminalOrdinal = reported.ordinal;
  if (impl_->prepared != nullptr &&
      (result.state == NativePlaybackState::Prepared ||
       result.host.format.sampleRate <= 0.0)) {
    result.host.format.sampleRate = impl_->prepared->sampleRate;
    result.host.format.maximumFrames = impl_->prepared->maximumFrames;
    result.host.format.outputChannels = impl_->prepared->outputChannels;
    result.host.format.float32Planar = true;
  }
  result.renderedFrames = result.host.renderedFrames;
  const uint64_t latency = presentationLatencyFrames(result.host.latency);
  result.audibleFrames =
      result.renderedFrames > latency ? result.renderedFrames - latency : 0;
  result.error = impl_->lastError;
  if (impl_->prepared != nullptr) {
    result.retainedBytes = impl_->prepared->retainedBytes;
    result.masterGain = impl_->prepared->masterGain;
    result.adapterRenderFailures =
        impl_->prepared->adapter.renderFailures.load(std::memory_order_relaxed);
    result.terminalRenderFailures =
        impl_->prepared->callback.terminalFailures.load(
            std::memory_order_relaxed);
    result.parameterOverflows =
        impl_->prepared->diagnostics.parameterOverflows.load(
            std::memory_order_relaxed);
    result.nonFiniteSamples =
        impl_->prepared->diagnostics.nonFiniteSamples.load(
            std::memory_order_relaxed);
    result.rejectedBlocks = impl_->prepared->diagnostics.rejectedBlocks.load(
        std::memory_order_relaxed);
    result.lanes.reserve(impl_->prepared->lanes.size());
    for (const PreparedPlaybackGraph::Lane &lane : impl_->prepared->lanes) {
      result.lanes.push_back(
          {lane.id,
           zdsp::decodedBufferSourceCursor(lane.source, &lane.cursorReader),
           lane.owner->frameCount(), lane.gain, lane.muted, lane.solo});
    }
  }
  return result;
}

const char *nativePlaybackSessionCapabilityTag() noexcept {
  return "singz.native.playback-session.wav-flac.frame-zero.v1";
}

} // namespace singz
