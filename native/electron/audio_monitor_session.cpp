#include "audio_monitor_session.h"

#include "audio_monitor_callback.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <mutex>
#include <utility>

#include <zdsp/audio_host_graph_adapter.h>
#include <zdsp/builtin_nodes.h>
#include <zdsp/graph.h>
#include <zdsp/graph_runner.h>
#include <zdsp/realtime_arena.h>

namespace singz {
namespace {

constexpr uint64_t kInputNode = 1;
constexpr uint64_t kPreMeterNode = 2;
constexpr uint64_t kGainNode = 3;
constexpr uint64_t kChannelMapNode = 4;
constexpr uint64_t kLimiterNode = 5;
constexpr uint64_t kPostMeterNode = 6;
constexpr uint64_t kOutputNode = 7;
constexpr size_t kArenaBaseBytes = 2u * 1024u * 1024u;

AudioMonitorResult failure(AudioMonitorError error, uint64_t generation,
                           AudioHostState state, std::string message) {
  return {false, error, generation, state, {}, {}, std::move(message)};
}

bool validChannels(const std::vector<uint32_t>& channels) {
  if (channels.empty() || channels.size() > zdsp::kMaximumChannelsPerBus)
    return false;
  for (size_t index = 0; index < channels.size(); ++index) {
    for (size_t prior = 0; prior < index; ++prior) {
      if (channels[index] == channels[prior]) return false;
    }
  }
  return true;
}

bool validConfig(const AudioMonitorConfig& config, std::string* message) {
  if (config.inputDeviceUid.empty() || config.outputDeviceUid.empty()) {
    *message = "Input and output device UIDs are required";
    return false;
  }
#if defined(__APPLE__)
  if (config.inputDeviceUid != config.outputDeviceUid) {
    *message = "macOS monitoring requires one same-device duplex UID";
    return false;
  }
#endif
  if (!validChannels(config.inputChannels) ||
      !validChannels(config.outputChannels)) {
    *message = "Channel maps must contain 1 to 64 unique physical channels";
    return false;
  }
  if (!std::isfinite(config.sampleRate) || config.sampleRate < 8000.0 ||
      config.sampleRate > 384000.0) {
    *message = "Sample rate must be finite and between 8000 and 384000 Hz";
    return false;
  }
  if (config.bufferFrames == 0 || config.maximumFrames == 0 ||
      config.maximumFrames > kAudioHostMaxFrames ||
      config.bufferFrames > config.maximumFrames) {
    *message = "Buffer and maximum frames must be 1 to 8192, with maximum covering the buffer";
    return false;
  }
  return true;
}

zdsp::AudioBusDescriptor descriptor(
    uint32_t channels,
    std::array<zdsp::AudioChannelRole, zdsp::kMaximumChannelsPerBus>* roles) {
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

struct PreparedMonitorTelemetry {
  AudioMonitorMeter pre{};
  AudioMonitorMeter post{};
  bool deviceLost{false};
  uint32_t adapterRenderFailures{0};
  uint32_t terminalRenderFailures{0};
  uint32_t adapterLastStatusCode{0};
  uint32_t parameterOverflows{0};
  uint32_t nonFiniteSamples{0};
  uint32_t rejectedBlocks{0};
};

struct PreparedMonitorGraph {
  explicit PreparedMonitorGraph(const AudioMonitorConfig& config,
                                AudioMonitorTestHooks* testHooks)
      : inputChannels(static_cast<uint32_t>(config.inputChannels.size())),
        outputChannels(static_cast<uint32_t>(config.outputChannels.size())),
        maximumFrames(config.maximumFrames), testHooks(testHooks) {
    const uint64_t samples =
        static_cast<uint64_t>(inputChannels + outputChannels) * maximumFrames;
    const uint64_t variable = samples * sizeof(float) * 4u;
    const uint64_t total = kArenaBaseBytes + variable;
    if (total <= static_cast<uint64_t>(std::numeric_limits<uint32_t>::max()))
      arenaBytes.resize(static_cast<size_t>(total));
  }

  std::vector<uint8_t> arenaBytes;
  zdsp::RealtimeArena arena{};
  zdsp::CompiledGraph* graph{nullptr};
  zdsp::ProcessorHandle preMeter{};
  zdsp::ProcessorHandle gain{};
  zdsp::ProcessorHandle postMeter{};
  zdsp::RuntimeDiagnostics diagnostics{};
  zdsp::RetirementSlot retirement[1]{};
  zdsp::SnapshotPublisher publisher{};
  zdsp::PublishedGraphSnapshot snapshot{};
  zdsp::ParameterQueue parameters{};
  zdsp::GraphRunner runner{};
  zdsp::AudioHostGraphAdapter adapter{};
  AudioMonitorCallbackState callback{};
  uint32_t inputChannels{0};
  uint32_t outputChannels{0};
  uint32_t maximumFrames{0};
  bool runnerInitialized{false};
  bool telemetryLive{true};
  PreparedMonitorTelemetry frozenTelemetry{};
  AudioMonitorTestHooks* testHooks{nullptr};

  void observe(AudioMonitorLifecycleEvent event) noexcept {
    if (testHooks != nullptr && testHooks->observe != nullptr)
      testHooks->observe(testHooks->context, event);
  }

  static bool consumeFailure(uint32_t* remaining) noexcept {
    if (remaining == nullptr || *remaining == 0) return false;
    if (*remaining != std::numeric_limits<uint32_t>::max()) --*remaining;
    return true;
  }

  zdsp::ProcessorHandle makeBuiltin(const zdsp::BuiltinNodeConfig& config,
                                    zdsp::FrameCount maxFrames,
                                    void** durable, size_t* durableBytes) {
    const size_t stateBytes = zdsp::builtinStateBytes(config);
    void* state = zdsp::arenaAllocate(&arena, stateBytes, 64);
    if (state == nullptr) return {};
    zdsp::ProcessorHandle processor = zdsp::createBuiltinProcessor(
        config, {static_cast<uint8_t*>(state),
                 static_cast<uint32_t>(stateBytes)});
    if (processor.state == nullptr) return {};
    *durableBytes = zdsp::builtinPreparedBytes(config, maxFrames);
    *durable = *durableBytes == 0
                   ? nullptr
                   : zdsp::arenaAllocate(&arena, *durableBytes, alignof(float));
    if (*durableBytes != 0 && *durable == nullptr) {
      (void)zdsp::destroyProcessor(&processor);
      return {};
    }
    return processor;
  }

  zdsp::Status prepare(const AudioMonitorConfig& config,
                       zdsp::GraphCompileError* compileError) {
    if (arenaBytes.empty()) return {zdsp::StatusCode::InsufficientStorage, 1};
    zdsp::Status initialized = zdsp::initializeArena(
        &arena, {arenaBytes.data(), static_cast<uint32_t>(arenaBytes.size())});
    if (!zdsp::succeeded(initialized)) return initialized;

    std::array<zdsp::AudioChannelRole, zdsp::kMaximumChannelsPerBus> inputRoles{};
    std::array<zdsp::AudioChannelRole, zdsp::kMaximumChannelsPerBus> outputRoles{};
    const zdsp::AudioBusDescriptor inputBus =
        descriptor(inputChannels, &inputRoles);
    const zdsp::AudioBusDescriptor outputBus =
        descriptor(outputChannels, &outputRoles);
    std::array<float, zdsp::kMaximumChannelsPerBus *
                          zdsp::kMaximumChannelsPerBus> matrix{};
    if (inputChannels == 1) {
      for (uint32_t out = 0; out < outputChannels; ++out)
        matrix[out * inputChannels] = 1.0F;
    } else {
      const uint32_t matching = std::min(inputChannels, outputChannels);
      for (uint32_t channel = 0; channel < matching; ++channel)
        matrix[channel * inputChannels + channel] = 1.0F;
    }

    const zdsp::BuiltinNodeConfig configs[] = {
        {zdsp::BuiltinNodeKind::PeakRms, {kPreMeterNode}, inputChannels,
         inputChannels, 1, 0.0F, 0.0F, 0,
         zdsp::OscillatorWaveform::Saw, nullptr, 0},
        {zdsp::BuiltinNodeKind::Gain, {kGainNode}, inputChannels,
         inputChannels, 1, 0.0F, 0.0F, 0,
         zdsp::OscillatorWaveform::Saw, nullptr, 0},
        {zdsp::BuiltinNodeKind::ChannelMap, {kChannelMapNode}, inputChannels,
         outputChannels, 1, 0.0F, 0.0F, 0,
         zdsp::OscillatorWaveform::Saw, matrix.data(), 0},
        {zdsp::BuiltinNodeKind::SafetyLimiter, {kLimiterNode}, outputChannels,
         outputChannels, 1, kMonitorLimiterCeiling, 0.0F, 0,
         zdsp::OscillatorWaveform::Saw, nullptr, 0},
        {zdsp::BuiltinNodeKind::PeakRms, {kPostMeterNode}, outputChannels,
         outputChannels, 1, 0.0F, 0.0F, 0,
         zdsp::OscillatorWaveform::Saw, nullptr, 0},
    };
    std::array<zdsp::ProcessorHandle, 5> processors{};
    std::array<void*, 5> durable{};
    std::array<size_t, 5> durableBytes{};
    for (size_t index = 0; index < processors.size(); ++index) {
      processors[index] = makeBuiltin(configs[index], {maximumFrames},
                                      &durable[index], &durableBytes[index]);
      if (processors[index].state != nullptr) continue;
      for (size_t built = 0; built < index; ++built)
        (void)zdsp::destroyProcessor(&processors[built]);
      return {zdsp::StatusCode::InsufficientStorage, 2};
    }
    preMeter = processors[0];
    gain = processors[1];
    postMeter = processors[4];

    std::array<zdsp::GraphNodeDescription, 7> nodes{};
    nodes[0] = {{kInputNode}, {0, kInputNode}, 1,
                zdsp::GraphNodeRole::Input, zdsp::GraphNodeFlagNone,
                0, 1, nullptr, &inputBus, {}, {}};
    const zdsp::AudioBusDescriptor* processorInputs[] = {
        &inputBus, &inputBus, &inputBus, &outputBus, &outputBus};
    const zdsp::AudioBusDescriptor* processorOutputs[] = {
        &inputBus, &inputBus, &outputBus, &outputBus, &outputBus};
    for (size_t index = 0; index < processors.size(); ++index) {
      nodes[index + 1] = {
          {configs[index].node.value},
          {1, static_cast<uint64_t>(configs[index].kind)}, 1,
          zdsp::GraphNodeRole::Processor,
          zdsp::GraphNodeFlagMayProcessInPlace, 1, 1,
          processorInputs[index], processorOutputs[index], processors[index],
          {durable[index], durableBytes[index], alignof(float)}};
    }
    nodes[6] = {{kOutputNode}, {0, kOutputNode}, 1,
                zdsp::GraphNodeRole::Output, zdsp::GraphNodeFlagNone,
                1, 0, &outputBus, nullptr, {}, {}};
    const std::array<zdsp::GraphConnection, 6> connections{{
        {{kInputNode}, 0, {kPreMeterNode}, 0},
        {{kPreMeterNode}, 0, {kGainNode}, 0},
        {{kGainNode}, 0, {kChannelMapNode}, 0},
        {{kChannelMapNode}, 0, {kLimiterNode}, 0},
        {{kLimiterNode}, 0, {kPostMeterNode}, 0},
        {{kPostMeterNode}, 0, {kOutputNode}, 0},
    }};
    const zdsp::GraphDescription description{
        zdsp::kGraphFormatVersion, {config.sampleRate}, {maximumFrames},
        nodes.data(), static_cast<uint32_t>(nodes.size()), connections.data(),
        static_cast<uint32_t>(connections.size())};
    zdsp::GraphCompileResult compiled{};
    const zdsp::Status compiledStatus =
        zdsp::compileGraph(description, &arena, &compiled, compileError);
    if (!zdsp::succeeded(compiledStatus)) return compiledStatus;
    graph = compiled.graph;

    zdsp::initializePublisher(&publisher, retirement, 1, &diagnostics);
    const zdsp::TransitionPlan hardCut{
        zdsp::TransitionKind::HardCut, {0}, {0}, {0},
        zdsp::InfiniteTailPolicy::Cut, {zdsp::TailKind::None, {0}}, {0},
        0, 100, 1000, 0};
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

  bool enqueueGain(float linear) noexcept {
    const zdsp::ParameterEvent event{{kGainNode}, zdsp::kGainParameter, {0},
                                     linear, zdsp::ParameterCurve::Linear,
                                     {kMonitorGainRampFrames}};
    return zdsp::enqueueParameter(&parameters, event, &diagnostics);
  }

  AudioMonitorMeter readPreMeter() const noexcept {
    const zdsp::MeterReading reading = zdsp::builtinMeter(preMeter);
    return {reading.peak, reading.rms, reading.frames};
  }

  AudioMonitorMeter readPostMeter() const noexcept {
    const zdsp::MeterReading reading = zdsp::builtinMeter(postMeter);
    return {reading.peak, reading.rms, reading.frames};
  }

  PreparedMonitorTelemetry readLiveTelemetry() const noexcept {
    PreparedMonitorTelemetry result;
    result.pre = readPreMeter();
    result.post = readPostMeter();
    result.deviceLost =
        callback.deviceLost.load(std::memory_order_acquire) != 0;
    result.adapterRenderFailures =
        adapter.renderFailures.load(std::memory_order_relaxed);
    result.terminalRenderFailures =
        callback.terminalFailures.load(std::memory_order_relaxed);
    result.adapterLastStatusCode =
        adapter.lastStatusCode.load(std::memory_order_relaxed);
    result.parameterOverflows =
        diagnostics.parameterOverflows.load(std::memory_order_relaxed);
    result.nonFiniteSamples =
        diagnostics.nonFiniteSamples.load(std::memory_order_relaxed);
    result.rejectedBlocks =
        diagnostics.rejectedBlocks.load(std::memory_order_relaxed);
    return result;
  }

  PreparedMonitorTelemetry telemetry() const noexcept {
    return telemetryLive ? readLiveTelemetry() : frozenTelemetry;
  }

  void freezeTelemetry() noexcept {
    if (!telemetryLive) return;
    frozenTelemetry = readLiveTelemetry();
    // deactivateCompiledGraph is deliberately non-transactional: a failure
    // may mean processors have already been destroyed. Freeze every diagnostic
    // and invalidate borrowed meter handles before the first shutdown attempt
    // so retained or released sessions tell the same final truth without
    // dereferencing ended processor lifetimes.
    preMeter = {};
    postMeter = {};
    telemetryLive = false;
    observe(AudioMonitorLifecycleEvent::MeterTelemetryFrozen);
  }

  bool shutdown() noexcept {
    const zdsp::ProcessorHandle partialFailureMeter = postMeter;
    freezeTelemetry();
    if (runnerInitialized) {
      observe(AudioMonitorLifecycleEvent::RunnerShutdownAttempt);
      if (testHooks != nullptr &&
          consumeFailure(&testHooks->runnerShutdownFailures))
        return false;
      zdsp::PublishedGraphSnapshot* snapshots[2]{};
      uint32_t count = 0;
      const zdsp::Status stopped =
          zdsp::shutdownGraphRunner(&runner, snapshots, 2, &count);
      if (!zdsp::succeeded(stopped)) return false;
      runnerInitialized = false;
      adapter.runner = nullptr;
      callback.adapter = nullptr;
    }
    if (graph != nullptr) {
      observe(AudioMonitorLifecycleEvent::GraphDeactivateAttempt);
      if (testHooks != nullptr &&
          consumeFailure(&testHooks->graphDeactivateFailures))
        return false;
      if (testHooks != nullptr && partialFailureMeter.state != nullptr &&
          consumeFailure(&testHooks->partialGraphDeactivateFailures)) {
        // Test-only fault that makes the following graph walk genuinely
        // partial: this meter's graph-owned handle still says Active, while
        // its state is already deactivated. The walk fails on this node but
        // continues destroying the remaining processors.
        (void)zdsp::deactivateProcessor(partialFailureMeter);
      }
      const zdsp::Status deactivated = zdsp::deactivateCompiledGraph(graph);
      if (!zdsp::succeeded(deactivated)) return false;
      graph = nullptr;
    }
    return true;
  }
};

}  // namespace

const char* audioMonitorErrorName(AudioMonitorError error) noexcept {
  switch (error) {
    case AudioMonitorError::None: return "none";
    case AudioMonitorError::InvalidGeneration: return "invalid-generation";
    case AudioMonitorError::AlreadyRunning: return "already-running";
    case AudioMonitorError::InvalidConfiguration: return "invalid-configuration";
    case AudioMonitorError::PlatformNotReady: return "platform-not-ready";
    case AudioMonitorError::UnsupportedRoute: return "unsupported-route";
    case AudioMonitorError::NativeAudioBusy: return "native-audio-busy";
    case AudioMonitorError::GraphFailure: return "graph-failure";
    case AudioMonitorError::HostFailure: return "host-failure";
    case AudioMonitorError::QueueFull: return "queue-full";
  }
  return "host-failure";
}

struct AudioMonitorSession::Impl {
  explicit Impl(std::unique_ptr<AudioHostBackend> backend,
                bool usesPlatformBackend, AudioMonitorTestHooks* testHooks)
      : host(std::move(backend)), usesPlatformBackend(usesPlatformBackend),
        testHooks(testHooks) {}

  ~Impl() {
    if (!teardown() && prepared != nullptr) {
      prepared->observe(AudioMonitorLifecycleEvent::PreparedQuarantined);
      // The graph still owns processor state in this arena. Leaking this bounded
      // session object at process teardown is safer than releasing live DSP
      // storage; normal end() retains it and permits an explicit retry.
      (void)prepared.release();
    }
  }

  mutable std::mutex mutex;
  AudioHost host;
  std::unique_ptr<PreparedMonitorGraph> prepared;
  uint64_t generation{0};
  uint64_t highestGeneration{0};
  float gainDb{0.0F};
  bool enabled{false};
  PreparedMonitorTelemetry lastTelemetry{};
  AudioHostStatus lastHost{};
  std::string lastError;
  bool usesPlatformBackend{false};
  AudioMonitorTestHooks* testHooks{nullptr};

  bool teardown() noexcept {
    if (prepared != nullptr)
      prepared->observe(AudioMonitorLifecycleEvent::HostStopBegin);
    host.stop();
    if (prepared != nullptr)
      prepared->observe(AudioMonitorLifecycleEvent::HostStopComplete);
    lastHost = host.status();
    if (prepared != nullptr) {
      const bool shutDown = prepared->shutdown();
      lastTelemetry = prepared->frozenTelemetry;
      if (!shutDown) {
        enabled = false;
        return false;
      }
      prepared->observe(AudioMonitorLifecycleEvent::PreparedReleased);
      prepared.reset();
    }
    generation = 0;
    gainDb = 0.0F;
    enabled = false;
    return true;
  }
};

AudioMonitorSession::AudioMonitorSession()
    : impl_(std::make_unique<Impl>(createPlatformAudioHostBackend(), true,
                                  nullptr)) {}

AudioMonitorSession::AudioMonitorSession(
    std::unique_ptr<AudioHostBackend> backend)
    : impl_(std::make_unique<Impl>(std::move(backend), false, nullptr)) {}

AudioMonitorSession::AudioMonitorSession(
    std::unique_ptr<AudioHostBackend> backend, AudioMonitorTestHooks* testHooks)
    : impl_(std::make_unique<Impl>(std::move(backend), false, testHooks)) {}

AudioMonitorSession::~AudioMonitorSession() = default;

AudioHostInventory AudioMonitorSession::enumerate() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->host.enumerate();
}

AudioMonitorResult AudioMonitorSession::begin(
    const AudioMonitorConfig& config, uint64_t ownershipGeneration) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (ownershipGeneration == 0 ||
      ownershipGeneration <= impl_->highestGeneration) {
    return failure(AudioMonitorError::InvalidGeneration, ownershipGeneration,
                   impl_->lastHost.state,
                   "Ownership generation must increase monotonically");
  }
  if (impl_->generation != 0) {
    return failure(AudioMonitorError::AlreadyRunning, ownershipGeneration,
                   impl_->host.status().state,
                   "End the active monitor generation before starting another");
  }
  std::string invalid;
  if (!validConfig(config, &invalid)) {
    return failure(AudioMonitorError::InvalidConfiguration,
                   ownershipGeneration, impl_->lastHost.state,
                   std::move(invalid));
  }
#if defined(_WIN32)
  if (impl_->usesPlatformBackend) {
    return failure(
        AudioMonitorError::PlatformNotReady, ownershipGeneration,
        impl_->lastHost.state,
        "Windows monitoring remains disabled until the WASAPI hot loop is "
        "extracted into the enforced real-time policy target");
  }
#endif
  const AudioHostInventory inventory = impl_->host.enumerate();
  const auto selected = std::find_if(
      inventory.devices.begin(), inventory.devices.end(),
      [&](const AudioHostDeviceInfo& device) {
        return device.uid == config.inputDeviceUid &&
               device.uid == config.outputDeviceUid;
      });
  if (selected == inventory.devices.end() ||
      selected->direction != AudioHostEndpointDirection::Duplex ||
      selected->inputChannels == 0 || selected->outputChannels == 0) {
    return failure(AudioMonitorError::UnsupportedRoute, ownershipGeneration,
                   impl_->lastHost.state,
                   "Monitoring requires one provider-confirmed duplex route");
  }
  if (selected->monitoringSuitability !=
      AudioHostMonitoringSuitability::LowLatency) {
    return failure(AudioMonitorError::UnsupportedRoute, ownershipGeneration,
                   impl_->lastHost.state,
                   "The selected provider route is not approved for low-latency monitoring");
  }
  for (uint32_t channel : config.inputChannels) {
    if (channel >= selected->inputChannels)
      return failure(AudioMonitorError::InvalidConfiguration,
                     ownershipGeneration, impl_->lastHost.state,
                     "An input channel is outside the provider inventory");
  }
  for (uint32_t channel : config.outputChannels) {
    if (channel >= selected->outputChannels)
      return failure(AudioMonitorError::InvalidConfiguration,
                     ownershipGeneration, impl_->lastHost.state,
                     "An output channel is outside the provider inventory");
  }
  impl_->highestGeneration = ownershipGeneration;
  auto prepared =
      std::make_unique<PreparedMonitorGraph>(config, impl_->testHooks);
  zdsp::GraphCompileError compileError{};
  const zdsp::Status graphStatus = prepared->prepare(config, &compileError);
  if (!zdsp::succeeded(graphStatus)) {
    impl_->lastError = "Could not prepare the monitoring graph";
    return failure(AudioMonitorError::GraphFailure, ownershipGeneration,
                   impl_->lastHost.state, impl_->lastError);
  }

  AudioHostConfig hostConfig;
  hostConfig.inputDeviceUid = config.inputDeviceUid;
  hostConfig.outputDeviceUid = config.outputDeviceUid;
  hostConfig.inputChannels = config.inputChannels;
  hostConfig.outputChannels = config.outputChannels;
  hostConfig.requestedSampleRate = config.sampleRate;
  hostConfig.requestedBufferFrames = config.bufferFrames;
  hostConfig.maximumFrames = config.maximumFrames;
  hostConfig.exclusive = config.exclusive;
  AudioHostResult opened = impl_->host.open(
      hostConfig, &audioMonitorRender, &prepared->callback);
  if (!opened.ok || opened.format.sampleRate != config.sampleRate ||
      opened.format.maximumFrames != config.maximumFrames ||
      opened.format.inputChannels != prepared->inputChannels ||
      opened.format.outputChannels != prepared->outputChannels) {
    impl_->host.stop();
    impl_->lastHost = impl_->host.status();
    impl_->lastError = opened.message.empty()
                           ? "The host did not negotiate the exact monitor format"
                           : opened.message;
    if (!prepared->shutdown()) {
      impl_->prepared = std::move(prepared);
      impl_->generation = ownershipGeneration;
      impl_->enabled = false;
      impl_->lastError =
          "Host open failed and the prepared graph requires teardown retry";
      return failure(AudioMonitorError::GraphFailure, ownershipGeneration,
                     impl_->lastHost.state, impl_->lastError);
    }
    return failure(AudioMonitorError::HostFailure, ownershipGeneration,
                   opened.state, impl_->lastError);
  }

  impl_->prepared = std::move(prepared);
  impl_->generation = ownershipGeneration;
  impl_->gainDb = 0.0F;
  impl_->enabled = false;
  AudioHostResult started = impl_->host.start();
  if (!started.ok) {
    impl_->lastError = started.message;
    const AudioHostState state = started.state;
    if (!impl_->teardown()) {
      impl_->lastError =
          "Host start failed and the prepared graph requires teardown retry";
      return failure(AudioMonitorError::GraphFailure, ownershipGeneration,
                     state, impl_->lastError);
    }
    return failure(AudioMonitorError::HostFailure, ownershipGeneration,
                   state, impl_->lastError);
  }
  impl_->lastError.clear();
  impl_->lastHost = impl_->host.status();
  return {true, AudioMonitorError::None, ownershipGeneration, started.state,
          started.format, started.latency, {}};
}

AudioMonitorResult AudioMonitorSession::setGain(
    uint64_t ownershipGeneration, float gainDb, bool enabled) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (ownershipGeneration == 0 || ownershipGeneration != impl_->generation ||
      impl_->prepared == nullptr) {
    return failure(AudioMonitorError::InvalidGeneration, ownershipGeneration,
                   impl_->host.status().state,
                   "The monitor generation is no longer active");
  }
  const AudioHostStatus hostStatus = impl_->host.status();
  if (hostStatus.state != AudioHostState::Running ||
      !impl_->prepared->runnerInitialized || !impl_->prepared->telemetryLive) {
    impl_->enabled = false;
    return failure(AudioMonitorError::GraphFailure, ownershipGeneration,
                   hostStatus.state,
                   "The monitor is stopped and retained only for teardown");
  }
  if (!std::isfinite(gainDb) || gainDb < kMonitorMinimumGainDb ||
      gainDb > kMonitorMaximumGainDb) {
    return failure(AudioMonitorError::InvalidConfiguration,
                   ownershipGeneration, impl_->host.status().state,
                   "Monitor gain must be finite and between -60 and +12 dB");
  }
  const float linear = enabled ? std::pow(10.0F, gainDb / 20.0F) : 0.0F;
  if (!impl_->prepared->enqueueGain(linear)) {
    return failure(AudioMonitorError::QueueFull, ownershipGeneration,
                   impl_->host.status().state,
                   "The bounded monitor parameter queue is full");
  }
  impl_->gainDb = gainDb;
  impl_->enabled = enabled;
  return {true, AudioMonitorError::None, ownershipGeneration,
          hostStatus.state, hostStatus.format, hostStatus.latency, {}};
}

AudioMonitorStatus AudioMonitorSession::status() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  AudioMonitorStatus result;
  result.active = impl_->generation != 0;
  result.enabled = impl_->enabled;
  result.ownershipGeneration = impl_->generation;
  result.gainDb = impl_->gainDb;
  const bool frozen = impl_->prepared != nullptr &&
                      !impl_->prepared->telemetryLive;
  result.host = impl_->generation != 0 && !frozen
                    ? impl_->host.status()
                    : impl_->lastHost;
  result.error = impl_->lastError;
  const PreparedMonitorTelemetry telemetry = impl_->prepared != nullptr
      ? impl_->prepared->telemetry()
      : impl_->lastTelemetry;
  result.pre = telemetry.pre;
  result.post = telemetry.post;
  result.deviceLost = telemetry.deviceLost ||
                      result.host.state == AudioHostState::DeviceLost;
  result.adapterRenderFailures = telemetry.adapterRenderFailures;
  result.terminalRenderFailures = telemetry.terminalRenderFailures;
  result.adapterLastStatusCode = telemetry.adapterLastStatusCode;
  result.parameterOverflows = telemetry.parameterOverflows;
  result.nonFiniteSamples = telemetry.nonFiniteSamples;
  result.rejectedBlocks = telemetry.rejectedBlocks;
  return result;
}

AudioMonitorResult AudioMonitorSession::end(uint64_t ownershipGeneration) {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  if (ownershipGeneration == 0 || ownershipGeneration != impl_->generation ||
      impl_->prepared == nullptr) {
    return failure(AudioMonitorError::InvalidGeneration, ownershipGeneration,
                   impl_->lastHost.state,
                   "The monitor generation is no longer active");
  }
  const bool stopped = impl_->teardown();
  if (!stopped) {
    impl_->lastError = "The monitoring graph did not shut down cleanly";
    return failure(AudioMonitorError::GraphFailure, ownershipGeneration,
                   impl_->lastHost.state, impl_->lastError);
  }
  impl_->lastError.clear();
  return {true, AudioMonitorError::None, ownershipGeneration,
          impl_->lastHost.state, impl_->lastHost.format,
          impl_->lastHost.latency, {}};
}

}  // namespace singz
