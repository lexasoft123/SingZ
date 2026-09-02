#include <native/playback/native_playback_callback.h>
#include <native/playback/native_playback_projection.h>
#include <native/playback/native_playback_session.h>
#include <native/playback/signalsmith_time_pitch.h>
#include <zcore/media/flac_io.h>
#include <zcore/media/wav.h>
#include <zdsp/scheduled_cue_source.h>

#include "allocation_trap.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#include <process.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

#define CHECK(expression)                                                      \
  do {                                                                         \
    if (!(expression)) {                                                       \
      std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__,  \
                   #expression);                                               \
      std::abort();                                                            \
    }                                                                          \
  } while (false)

namespace {

static_assert(singz::playback_internal::loopAdjustedProjectFrame(
                  std::numeric_limits<int64_t>::min(), true, 4, 11) == 6);
static_assert(singz::playback_internal::loopAdjustedProjectFrame(
                  std::numeric_limits<int64_t>::max(), true, 4, 11) == 7);

int processId() noexcept {
#if defined(_WIN32)
  return _getpid();
#else
  return static_cast<int>(::getpid());
#endif
}

std::string scratch(const char *name) {
  return (std::filesystem::temp_directory_path() /
          (std::string("singz-native-playback-") + std::to_string(processId()) +
           "-" + name))
      .string();
}

int openRead(const std::string &path) noexcept {
#if defined(_WIN32)
  return _open(path.c_str(), _O_RDONLY | _O_BINARY);
#else
  return ::open(path.c_str(), O_RDONLY);
#endif
}

std::string writeWav(const char *name, uint32_t channels,
                     const std::vector<float> &interleaved) {
  const std::string path = scratch(name);
  std::remove(path.c_str());
  singz::WavWriter writer;
  CHECK(channels != 0 && interleaved.size() % channels == 0);
  CHECK(writer.open(path, 48000, static_cast<int>(channels)));
  CHECK(writer.append(interleaved.data(),
                      static_cast<int64_t>(interleaved.size() / channels)));
  CHECK(writer.finalize());
  return path;
}

float pcm16(float value) {
  return static_cast<float>(std::lrintf(value * 32767.0F)) / 32768.0F;
}

bool near(float actual, float expected, float tolerance = 0.0001F) {
  return std::isfinite(actual) && std::fabs(actual - expected) <= tolerance;
}

struct Trace {
  std::vector<singz::NativePlaybackLifecycleEvent> events;
};

void observe(void *opaque, singz::NativePlaybackLifecycleEvent event) noexcept {
  static_cast<Trace *>(opaque)->events.push_back(event);
}

struct PublicationLatch {
  std::mutex mutex;
  std::condition_variable condition;
  bool enabled{true};
  bool ready{false};
  bool release{false};
};

void blockPublication(void *opaque,
                      singz::NativePlaybackLifecycleEvent event) noexcept {
  if (event != singz::NativePlaybackLifecycleEvent::PrepareReadyToPublish)
    return;
  auto *latch = static_cast<PublicationLatch *>(opaque);
  std::unique_lock<std::mutex> lock(latch->mutex);
  if (!latch->enabled)
    return;
  latch->ready = true;
  latch->condition.notify_all();
  latch->condition.wait(lock, [&] { return latch->release; });
}

void blockProvisionalStart(void *opaque,
                           singz::NativePlaybackLifecycleEvent event) noexcept {
  if (event != singz::NativePlaybackLifecycleEvent::HostStartProvisionalRunning)
    return;
  auto *latch = static_cast<PublicationLatch *>(opaque);
  std::unique_lock<std::mutex> lock(latch->mutex);
  latch->ready = true;
  latch->condition.notify_all();
  latch->condition.wait(lock, [&] { return latch->release; });
}

void waitUntilReady(PublicationLatch *latch) {
  std::unique_lock<std::mutex> lock(latch->mutex);
  latch->condition.wait(lock, [&] { return latch->ready; });
}

void releasePublication(PublicationLatch *latch) {
  std::lock_guard<std::mutex> lock(latch->mutex);
  latch->release = true;
  latch->condition.notify_all();
}

struct StartLatch {
  std::mutex mutex;
  std::condition_variable condition;
  bool entered{false};
  bool release{false};
};

struct StaleTeardownLatch {
  std::mutex mutex;
  std::condition_variable condition;
  bool publicationReady{false};
  bool releasePublication{false};
  bool teardownReady{false};
  bool releaseTeardown{false};
  bool failShutdown{false};
};

void blockStaleTeardown(void *opaque,
                        singz::NativePlaybackLifecycleEvent event) noexcept {
  auto *latch = static_cast<StaleTeardownLatch *>(opaque);
  std::unique_lock<std::mutex> lock(latch->mutex);
  if (event == singz::NativePlaybackLifecycleEvent::PrepareReadyToPublish) {
    latch->publicationReady = true;
    latch->condition.notify_all();
    latch->condition.wait(lock, [&] { return latch->releasePublication; });
  } else if (event == singz::NativePlaybackLifecycleEvent::RunnerShutdown) {
    latch->teardownReady = true;
    latch->condition.notify_all();
    latch->condition.wait(lock, [&] { return latch->releaseTeardown; });
  }
}

void waitStaleLatch(StaleTeardownLatch *latch, bool publication) {
  std::unique_lock<std::mutex> lock(latch->mutex);
  latch->condition.wait(lock, [&] {
    return publication ? latch->publicationReady : latch->teardownReady;
  });
}

void releaseStaleLatch(StaleTeardownLatch *latch, bool publication) {
  std::lock_guard<std::mutex> lock(latch->mutex);
  if (publication)
    latch->releasePublication = true;
  else
    latch->releaseTeardown = true;
  latch->condition.notify_all();
}

bool failStaleRunnerShutdown(void *opaque) noexcept {
  return static_cast<StaleTeardownLatch *>(opaque)->failShutdown;
}

bool exhaustHandoffLeaseSerial(void *opaque) noexcept {
  return opaque != nullptr && *static_cast<bool *>(opaque);
}

bool exhaustUnloadReceiptJournal(void *opaque) noexcept {
  return opaque != nullptr && *static_cast<bool *>(opaque);
}

bool forceTransportTelemetryCollision(void *opaque) noexcept {
  return opaque != nullptr && *static_cast<bool *>(opaque);
}

void waitUntilStartEntered(StartLatch *latch) {
  std::unique_lock<std::mutex> lock(latch->mutex);
  latch->condition.wait(lock, [&] { return latch->entered; });
}

void releaseStart(StartLatch *latch) {
  std::lock_guard<std::mutex> lock(latch->mutex);
  latch->release = true;
  latch->condition.notify_all();
}

struct AllocationFault {
  singz::NativePlaybackAllocationPoint point{
      singz::NativePlaybackAllocationPoint::AfterDecode};
  singz::NativePlaybackInjectedFailure failure{
      singz::NativePlaybackInjectedFailure::None};
  uint32_t hits{0};
};

singz::NativePlaybackInjectedFailure
injectAllocationFailure(void *opaque,
                        singz::NativePlaybackAllocationPoint point) noexcept {
  auto *fault = static_cast<AllocationFault *>(opaque);
  if (fault->point != point || fault->hits++ != 0)
    return singz::NativePlaybackInjectedFailure::None;
  return fault->failure;
}

class ManualOutputBackend final : public singz::AudioHostBackend {
public:
  singz::AudioHostInventory enumerate() const override {
    ++enumerations;
    singz::AudioHostDeviceInfo device;
    device.uid = "manual:output";
    device.label = "Manual output";
    device.defaultOutput = true;
    device.outputChannels = 2;
    device.nominalSampleRate = 48000.0;
    device.sampleRateRanges = {{48000.0, 48000.0}};
    device.bufferFrames = {1, 512, 2, 1};
    device.direction = singz::AudioHostEndpointDirection::Output;
    device.transport = singz::AudioHostTransport::BuiltIn;
    return {{std::move(device)}, {}, "manual:output"};
  }

  singz::AudioHostResult open(const singz::AudioHostConfig &config,
                              singz::AudioHostRender render,
                              void *renderContext) override {
    lastConfig = config;
    ++opens;
    terminalCause.reset();
    if (throwOpenAfterHiddenMutation) {
      callback = render;
      context = renderContext;
      hiddenOpenResources = true;
      state = singz::AudioHostState::Closed;
      throw std::runtime_error("injected hidden open exception");
    }
    if (throwOpen)
      throw std::runtime_error("injected open exception");
    if (failOpen) {
      terminalCause.publish(singz::AudioHostTerminalReason::ProviderFailure,
                            singz::AudioHostTerminalProducer::Provider);
      state = singz::AudioHostState::Error;
      return {false, singz::AudioHostError::ProviderFailure,
              state, {},
              {},    "injected open failure"};
    }
    if (!config.inputDeviceUid.empty() || !config.inputChannels.empty() ||
        config.outputDeviceUid != "manual:output" ||
        config.outputChannels != std::vector<uint32_t>({0, 1}) ||
        config.requestedSampleRate != 48000.0 || render == nullptr) {
      state = singz::AudioHostState::Error;
      return {false, singz::AudioHostError::InvalidConfiguration,
              state, {},
              {},    "bad fixture config"};
    }
    callback = render;
    context = renderContext;
    const uint32_t openedMaximum =
        actualMaximumFrames == 0 ? config.maximumFrames : actualMaximumFrames;
    const uint32_t openedNominal = actualNominalBufferFrames == 0
                                       ? std::min<uint32_t>(2, openedMaximum)
                                       : actualNominalBufferFrames;
    format = {48000.0,
              openedMaximum,
              openedNominal,
              0,
              2,
              true,
              true,
              singz::AudioHostAccessMode::Shared};
    latency = {0, 2, 2, 0};
    state = singz::AudioHostState::Open;
    ++streamGeneration;
    if (cancelOnOpen != nullptr)
      cancelOnOpen->store(true, std::memory_order_release);
    return {true, singz::AudioHostError::None, state, format, latency, {}};
  }

  singz::AudioHostResult start() override {
    ++starts;
    if (failStart) {
      terminalCause.publish(singz::AudioHostTerminalReason::ProviderFailure,
                            singz::AudioHostTerminalProducer::Provider);
      state = singz::AudioHostState::Error;
      return {false,   singz::AudioHostError::ProviderFailure,
              state,   format,
              latency, "injected start failure"};
    }
    if (state != singz::AudioHostState::Open)
      return {false,   singz::AudioHostError::InvalidState,
              state,   format,
              latency, "not open"};
    state = singz::AudioHostState::Running;
    if (throwStartAfterHiddenMutation) {
      hiddenStartResources = true;
      state = singz::AudioHostState::Stopped;
      throw std::runtime_error("injected hidden start exception");
    }
    if (throwStart)
      throw std::runtime_error("injected start exception");
    if (renderTerminalDuringStart)
      CHECK(!drive(0));
    if (startLatch != nullptr) {
      std::unique_lock<std::mutex> lock(startLatch->mutex);
      startLatch->entered = true;
      startLatch->condition.notify_all();
      startLatch->condition.wait(lock, [&] { return startLatch->release; });
    }
    return {true, singz::AudioHostError::None, state, format, latency, {}};
  }

  void stop() noexcept override {
    ++stops;
    if (graphTerminalDuringStop && context != nullptr) {
      auto *graph = static_cast<singz::NativePlaybackCallbackState *>(context);
      graph->firstTerminalCause.publish(
          singz::AudioHostTerminalReason::RouteChanged,
          singz::AudioHostTerminalProducer::GraphCallback);
    }
    if (providerTerminalDuringStop) {
      terminalCause.publish(singz::AudioHostTerminalReason::Interrupted,
                            singz::AudioHostTerminalProducer::Provider);
    }
    hiddenOpenResources = false;
    hiddenStartResources = false;
    callback = nullptr;
    context = nullptr;
    state = uncertainStop ? singz::AudioHostState::Error
                          : singz::AudioHostState::Stopped;
    if (uncertainStop)
      terminalCause.publish(singz::AudioHostTerminalReason::ProviderFailure,
                            singz::AudioHostTerminalProducer::Provider);
  }

  singz::AudioHostStatus status() const noexcept override {
    ++statusCalls;
    singz::AudioHostStatus result;
    result.state = state;
    const auto terminal = terminalCause.current();
    result.terminalReason = terminal.reason;
    result.terminalOrdinal = terminal.ordinal;
    result.format = format;
    result.latency = latency;
    result.routeGeneration = routeGeneration;
    result.streamGeneration = streamGeneration;
    result.callbacks = callbacks;
    result.renderedFrames = renderedFrames;
    result.xruns = xruns;
    result.deadlineMisses = deadlineMisses;
    result.discontinuities = discontinuities;
    result.renderFailures = renderFailures;
    return result;
  }

  bool drive(uint32_t frames, uint32_t discontinuity = 0) {
    CHECK(frames <= left.size());
    const uint32_t cleared = std::max<uint32_t>(frames, 1);
    std::fill_n(left.data(), cleared, 0.0F);
    std::fill_n(right.data(), cleared, 0.0F);
    if (state != singz::AudioHostState::Running)
      return false;
    std::fill_n(left.data(), frames, 7.0F);
    std::fill_n(right.data(), frames, 7.0F);
    float *output[]{left.data(), right.data()};
    singz::AudioHostRenderBlock block{nullptr,
                                      output,
                                      0,
                                      2,
                                      frames,
                                      format.maximumFrames,
                                      48000.0,
                                      1,
                                      routeGeneration,
                                      streamGeneration,
                                      callbacks,
                                      0,
                                      0,
                                      false,
                                      false,
                                      renderedFrames,
                                      renderedFrames * 1000,
                                      true,
                                      true,
                                      renderedFrames * 1000,
                                      discontinuity,
                                      true};
    ++callbacks;
    if (discontinuity != 0)
      ++discontinuities;
    const bool ok = callback != nullptr && callback(context, block);
    if (ok) {
      if (captureOutput)
        outputTrace.insert(outputTrace.end(), left.begin(),
                           left.begin() + frames);
      renderedFrames += frames;
    } else
      ++renderFailures;
    return ok;
  }

  void setTerminal(singz::AudioHostTerminalReason reason) noexcept {
    terminalCause.publish(reason, singz::AudioHostTerminalProducer::Provider);
    state = reason == singz::AudioHostTerminalReason::MediaServicesLost
                ? singz::AudioHostState::DeviceLost
                : singz::AudioHostState::Error;
  }

  void setGraphTerminal(singz::AudioHostTerminalReason reason) noexcept {
    auto *graph = static_cast<singz::NativePlaybackCallbackState *>(context);
    CHECK(graph != nullptr);
    graph->firstTerminalCause.publish(
        reason, singz::AudioHostTerminalProducer::GraphCallback);
  }

  void injectHostDiagnostics() noexcept {
    xruns = 3;
    deadlineMisses = 4;
    renderFailures = 5;
  }

  void setPresentationLatency(uint32_t outputDeviceFrames,
                              uint32_t bufferFrames,
                              uint32_t externalRouteFrames) noexcept {
    latency.outputDeviceFrames = outputDeviceFrames;
    latency.bufferFrames = bufferFrames;
    latency.externalRouteFrames = externalRouteFrames;
  }

  void reanchorRouteAndStream() noexcept {
    ++routeGeneration;
    ++streamGeneration;
  }

  void advanceRouteIdentityOnly() noexcept { ++routeGeneration; }

  void advanceStreamIdentityOnly() noexcept { ++streamGeneration; }

  bool failOpen{false};
  bool failStart{false};
  bool throwOpen{false};
  bool throwOpenAfterHiddenMutation{false};
  bool throwStartAfterHiddenMutation{false};
  bool throwStart{false};
  bool uncertainStop{false};
  bool renderTerminalDuringStart{false};
  bool graphTerminalDuringStop{false};
  bool providerTerminalDuringStop{false};
  bool hiddenOpenResources{false};
  bool hiddenStartResources{false};
  std::atomic<bool> *cancelOnOpen{nullptr};
  StartLatch *startLatch{nullptr};
  uint32_t actualMaximumFrames{0};
  uint32_t actualNominalBufferFrames{0};
  uint32_t stops{0};
  mutable uint32_t statusCalls{0};
  mutable uint32_t enumerations{0};
  uint32_t opens{0};
  uint32_t starts{0};
  bool captureOutput{false};
  std::vector<float> outputTrace;
  singz::AudioHostConfig lastConfig{};
  std::array<float, 1024> left{};
  std::array<float, 1024> right{};

private:
  singz::AudioHostRender callback{nullptr};
  void *context{nullptr};
  singz::AudioHostState state{singz::AudioHostState::Closed};
  singz::AudioHostTerminalCauseLatch terminalCause{};
  singz::AudioHostFormat format{};
  singz::AudioHostLatency latency{};
  uint64_t routeGeneration{1};
  uint64_t streamGeneration{0};
  uint64_t callbacks{0};
  uint64_t renderedFrames{0};
  uint64_t xruns{0};
  uint64_t deadlineMisses{0};
  uint64_t discontinuities{0};
  uint64_t renderFailures{0};
};

singz::NativePlaybackPrepareConfig config() {
  singz::NativePlaybackPrepareConfig result;
  result.outputDeviceUid = "manual:output";
  result.outputChannels = {0, 1};
  result.requestedSampleRate = 48000.0;
  result.maximumFrames = 512;
  return result;
}

singz::NativePlaybackLaneSource lane(const char *id, const std::string &path,
                                     float gain = 1.0F, bool muted = false,
                                     bool solo = false) {
  return {id, singz::OwnedFileDescriptor(openRead(path)), gain, muted, solo};
}

const singz::NativePlaybackGraphSnapshot &
graphSnapshot(const singz::NativePlaybackStatus &status) {
  CHECK(status.graphSnapshot != nullptr);
  CHECK(status.graphSnapshot->nodes.size() == status.graphNodeCount);
  CHECK(status.graphSnapshot->connections.size() ==
        status.graphConnectionCount);
  CHECK(status.graphSnapshot->latencyCompensatedConnectionCount ==
        status.latencyCompensatedEdgeCount);
  CHECK(status.graphSnapshot->outputLatencyFrames == status.graphLatencyFrames);
  return *status.graphSnapshot;
}

const singz::NativePlaybackGraphNodeStatus *
graphNode(const singz::NativePlaybackGraphSnapshot &graph,
          const char *label) {
  const auto found = std::find_if(
      graph.nodes.begin(), graph.nodes.end(), [&](const auto &node) {
        return node.label == label;
      });
  return found == graph.nodes.end() ? nullptr : &*found;
}

const singz::NativePlaybackGraphNodeStatus *
graphNodeById(const singz::NativePlaybackGraphSnapshot &graph, uint64_t id) {
  const auto found = std::find_if(
      graph.nodes.begin(), graph.nodes.end(),
      [id](const auto &node) { return node.id == id; });
  return found == graph.nodes.end() ? nullptr : &*found;
}

const singz::NativePlaybackGraphNode *documentNode(
    const singz::NativePlaybackGraphDocument &document, zdsp::NodeTypeId type,
    const char *bindingKind = nullptr, const char *laneId = nullptr,
    const char *inputPort = nullptr) {
  const auto found = std::find_if(
      document.nodes.begin(), document.nodes.end(), [&](const auto &node) {
        if (!singz::nativePlaybackGraphTypeEqual(node.type, type))
          return false;
        if (bindingKind != nullptr &&
            (!node.binding.has_value() ||
             node.binding->kind != bindingKind))
          return false;
        if (laneId != nullptr &&
            (!node.binding.has_value() || node.binding->laneId != laneId))
          return false;
        return inputPort == nullptr ||
               std::any_of(node.inputs.begin(), node.inputs.end(),
                           [inputPort](const auto &port) {
                             return port.id == inputPort;
                           });
      });
  return found == document.nodes.end() ? nullptr : &*found;
}

const singz::NativePlaybackGraphConnectionStatus *
graphConnection(const singz::NativePlaybackGraphSnapshot &graph,
                uint64_t sourceNode, uint64_t destinationNode,
                uint32_t destinationBus = 0) {
  const auto found = std::find_if(
      graph.connections.begin(), graph.connections.end(),
      [&](const auto &connection) {
        return connection.sourceNodeId == sourceNode &&
               connection.destinationNodeId == destinationNode &&
               connection.destinationBus == destinationBus;
      });
  return found == graph.connections.end() ? nullptr : &*found;
}

void compositionAndLifetime() {
  std::vector<float> a(256, 0.1F);
  std::vector<float> b(384, 0.2F);
  const std::string wav = writeWav("a.wav", 1, a);
  const std::string flacWav = writeWav("b.wav", 1, b);
  const std::string flac = scratch("b.flac");
  std::remove(flac.c_str());
  CHECK(singz::compactStem(flacWav, flac).ok);

  constexpr size_t expectedArenaBytes =
      4u * 1024u * 1024u + 16u * 2u * 512u * sizeof(float);
  constexpr size_t expectedPcmBytes = (256u + 384u) * sizeof(float);
  {
    auto limitedBackend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *limitedFake = limitedBackend.get();
    singz::NativePlaybackSession limited(std::move(limitedBackend));
    singz::NativePlaybackPrepareConfig limitedConfig = config();
    limitedConfig.maximumRetainedBytes =
        expectedArenaBytes + expectedPcmBytes - 1;
    auto limitedLanes = std::vector<singz::NativePlaybackLaneSource>{};
    limitedLanes.push_back(lane("a", wav));
    limitedLanes.push_back(lane("b", flac));
    const auto rejected =
        limited.prepare(std::move(limitedConfig), std::move(limitedLanes), 9);
    CHECK(!rejected.ok &&
          rejected.error == singz::NativePlaybackError::LimitExceeded &&
          limited.status().retainedBytes == 0 && limitedFake->opens == 0);
  }

  Trace trace;
  singz::NativePlaybackTestHooks hooks{observe, &trace};
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend), &hooks);
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("a", wav));
  lanes.push_back(lane("b", flac));
  singz::NativePlaybackGraphContext plainContext;
  plainContext.outputChannels = 2;
  plainContext.lanes = {{"a", 1, false}, {"b", 1, false}};
  const auto plainDocument =
      singz::synthesizeNativePlaybackGraphDocument(plainContext);
  const auto *expectedSourceA = documentNode(
      plainDocument, singz::kGraphTypeProjectLaneSource, "project-lane", "a");
  const auto *expectedMapA = documentNode(
      plainDocument, singz::kGraphTypeChannelMap, "project-lane", "a");
  const auto *expectedGainA = documentNode(
      plainDocument, singz::kGraphTypeGain, "project-lane", "a");
  const auto *expectedSongMix =
      documentNode(plainDocument, singz::kGraphTypeMix, nullptr, nullptr,
                   "lane:a");
  const auto *expectedSongGain = documentNode(
      plainDocument, singz::kGraphTypeGain, "song-master");
  const auto *expectedLimiter =
      documentNode(plainDocument, singz::kGraphTypeSafetyLimiter);
  const auto *expectedOutput = documentNode(
      plainDocument, singz::kGraphTypePhysicalOutput, "project-output");
  CHECK(expectedSourceA != nullptr && expectedMapA != nullptr &&
        expectedGainA != nullptr && expectedSongMix != nullptr &&
        expectedSongGain != nullptr && expectedLimiter != nullptr &&
        expectedOutput != nullptr && plainDocument.nodes.size() == 10 &&
        plainDocument.connections.size() == 9);
  CHECK(session.prepare(config(), std::move(lanes), 10).ok);
  auto status = session.status();
  CHECK(status.state == singz::NativePlaybackState::Prepared &&
        status.generation == 10 && status.lanes.size() == 2 &&
        status.lanes[0].cursorFrames == 0 &&
        status.lanes[1].cursorFrames == 0 && status.durationFrames == 384 &&
        status.transportGeneration == 10 &&
        status.transportState == singz::NativePlaybackTransportState::Stopped &&
        status.graphArenaBytes == expectedArenaBytes &&
        status.retainedBytes == expectedArenaBytes + expectedPcmBytes);
  CHECK(fake->enumerations == 0 && fake->opens == 0 && fake->starts == 0);
  const auto &plainGraph = graphSnapshot(status);
  CHECK(plainGraph.generation == 10 && plainGraph.formatVersion == 1 &&
        plainGraph.sampleRate == 48000.0 && plainGraph.maximumFrames == 512 &&
        plainGraph.nodes.size() == plainDocument.nodes.size() &&
        plainGraph.connections.size() == plainDocument.connections.size());
  const auto *sourceA = graphNode(plainGraph, "lane source[a]");
  const auto *mapA = graphNode(plainGraph, "channel map[a]");
  const auto *gainA = graphNode(plainGraph, "lane gain[a]");
  const auto *songMix = graphNode(plainGraph, "song mix");
  const auto *limiter = graphNode(plainGraph, "safety limiter");
  const auto *output = graphNode(plainGraph, "physical output");
  CHECK(sourceA != nullptr && sourceA->id == expectedSourceA->id &&
        sourceA->kind == singz::NativePlaybackGraphNodeKind::DecodedSource &&
        sourceA->typeHigh == singz::kGraphTypeProjectLaneSource.high &&
        sourceA->typeLow == singz::kGraphTypeProjectLaneSource.low &&
        sourceA->outputBusCount == 1 &&
        sourceA->outputBusChannels[0] == 1 && mapA != nullptr &&
        mapA->id == expectedMapA->id && mapA->id != sourceA->id &&
        mapA->kind == singz::NativePlaybackGraphNodeKind::ChannelMap &&
        mapA->inputBusChannels[0] == 1 && mapA->outputBusChannels[0] == 2 &&
        gainA != nullptr && gainA->id == expectedGainA->id &&
        gainA->id != mapA->id && songMix != nullptr &&
        songMix->id == expectedSongMix->id &&
        songMix->inputBusCount == 2 && songMix->inputBusChannels[0] == 2 &&
        songMix->inputBusChannels[1] == 2 && limiter != nullptr &&
        limiter->id == expectedLimiter->id && output != nullptr &&
        output->id == expectedOutput->id &&
        output->role == singz::NativePlaybackGraphNodeRole::Output &&
        output->kind == singz::NativePlaybackGraphNodeKind::PhysicalOutput);
  CHECK(graphNode(plainGraph, "prepared cue source") == nullptr &&
        graphNode(plainGraph, "reference gain") == nullptr &&
        graphNode(plainGraph, "Signalsmith time/pitch") == nullptr &&
        graphConnection(plainGraph, gainA->id, songMix->id, 0) != nullptr &&
        graphConnection(plainGraph, expectedSongGain->id, limiter->id) !=
            nullptr &&
        graphConnection(plainGraph, limiter->id, output->id) != nullptr);
  CHECK(session.openOutput(10).ok);
  status = session.status();
  CHECK(status.state == singz::NativePlaybackState::OutputOpen &&
        status.graphArenaBytes == expectedArenaBytes &&
        status.retainedBytes == expectedArenaBytes + expectedPcmBytes &&
        fake->enumerations == 1 && fake->opens == 1 && fake->starts == 0);
  CHECK(fake->lastConfig.inputDeviceUid.empty() &&
        fake->lastConfig.inputChannels.empty());
  CHECK(session.start(10).ok);
  status = session.status();
  CHECK(status.state == singz::NativePlaybackState::Running &&
        status.graphArenaBytes == expectedArenaBytes &&
        status.retainedBytes == expectedArenaBytes + expectedPcmBytes);

  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  CHECK(fake->drive(64, singz::AudioHostDiscontinuityStart));
  zdsp::test::setAllocationTrapEnabled(false);
  CHECK(zdsp::test::trappedAllocationCount() == 0);
  const float initial = pcm16(0.1F) + pcm16(0.2F);
  CHECK(near(fake->left[0], initial) && near(fake->right[0], initial));
  CHECK(session.start(10).error == singz::NativePlaybackError::InvalidState);

  CHECK(session.setLaneControl(10, "a", 1.0F, true, false).ok);
  CHECK(fake->drive(128));
  CHECK(fake->left[0] > pcm16(0.2F) &&
        near(fake->left[127], pcm16(0.2F), 0.001F));
  CHECK(session.setLaneControl(10, "a", 1.0F, false, false).ok);
  CHECK(session.setLaneControl(10, "b", 1.0F, false, true).ok);
  CHECK(session.setMasterGain(10, 0.5F).ok);
  CHECK(fake->drive(128));
  CHECK(near(fake->left[127], pcm16(0.2F) * 0.5F, 0.002F));
  status = session.status();
  CHECK(status.renderedFrames == 320 && status.audibleFrames == 316 &&
        status.lanes[0].cursorFrames == 256 &&
        status.lanes[1].cursorFrames == 320 && status.lanes[0].muted == false &&
        status.lanes[1].solo && status.masterGain == 0.5F);
  CHECK(fake->drive(128));
  status = session.status();
  CHECK(status.lanes[0].cursorFrames == 256 &&
        status.lanes[1].cursorFrames == 384 && near(fake->left[64], 0.0F) &&
        near(fake->right[127], 0.0F));

  CHECK(session.stop(10).ok);
  status = session.status();
  CHECK(status.state == singz::NativePlaybackState::Stopped &&
        status.graphArenaBytes == expectedArenaBytes &&
        status.retainedBytes == expectedArenaBytes + expectedPcmBytes);
  CHECK(session.start(10).error ==
        singz::NativePlaybackError::InvalidGeneration);
  CHECK(session.unload(10).ok);
  status = session.status();
  CHECK(status.generation == 0 && status.retainedBytes == 0 &&
        status.graphArenaBytes == 0 &&
        status.lanes.empty() && status.graphSnapshot == nullptr);
  const auto hostStop =
      std::find(trace.events.begin(), trace.events.end(),
                singz::NativePlaybackLifecycleEvent::HostStopComplete);
  const auto runner =
      std::find(trace.events.begin(), trace.events.end(),
                singz::NativePlaybackLifecycleEvent::RunnerShutdown);
  const auto graph =
      std::find(trace.events.begin(), trace.events.end(),
                singz::NativePlaybackLifecycleEvent::GraphDeactivate);
  const auto release =
      std::find(trace.events.begin(), trace.events.end(),
                singz::NativePlaybackLifecycleEvent::DecodedRelease);
  CHECK(hostStop < runner && runner < graph && graph < release);
  CHECK(session.start(10).error ==
        singz::NativePlaybackError::InvalidGeneration);

  std::remove(wav.c_str());
  std::remove(flacWav.c_str());
  std::remove(flac.c_str());
}

void trainingDuckComposition() {
  const std::string vocals =
      writeWav("training-vocals.wav", 1, std::vector<float>(768, 0.2F));
  const std::string guitar =
      writeWav("training-guitar.wav", 1, std::vector<float>(768, 0.1F));
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));

  singz::NativePlaybackPrepareConfig prepared = config();
  singz::NativePlaybackTrainingDuckConfig training;
  training.mode = singz::NativePlaybackTrainingMode::Period;
  training.periodFrames = 128;
  training.laneIds = {"vocals"};
  training.enabled = true;
  prepared.trainingDuck = training;

  // The default graph is now an in-memory portable document. Lane processor
  // IDs are stable functions of logical lane + role, not the old positional
  // 1300 + lane-index IDs. Prove that reordering sources cannot retarget a
  // generation-bound training control to another singer lane.
  singz::NativePlaybackGraphContext graphContext;
  graphContext.outputChannels = 2;
  graphContext.hasTraining = true;
  graphContext.lanes = {{"vocals", 1, true}, {"guitar", 1, false}};
  const auto expectedDocument =
      singz::synthesizeNativePlaybackGraphDocument(graphContext);
  std::reverse(graphContext.lanes.begin(), graphContext.lanes.end());
  const auto reorderedDocument =
      singz::synthesizeNativePlaybackGraphDocument(graphContext);
  const auto laneNodeId = [](const singz::NativePlaybackGraphDocument &document,
                             zdsp::NodeTypeId type,
                             const char *laneId) -> uint64_t {
    const auto found = std::find_if(
        document.nodes.begin(), document.nodes.end(), [&](const auto &node) {
          return singz::nativePlaybackGraphTypeEqual(node.type, type) &&
                 node.binding.has_value() &&
                 node.binding->kind == "project-lane" &&
                 node.binding->laneId == laneId;
        });
    return found == document.nodes.end() ? 0 : found->id;
  };
  const uint64_t expectedTrainingId =
      laneNodeId(expectedDocument, singz::kGraphTypeTrainingDuck, "vocals");
  CHECK(expectedTrainingId != 0 &&
        expectedTrainingId == laneNodeId(reorderedDocument,
                                         singz::kGraphTypeTrainingDuck,
                                         "vocals") &&
        laneNodeId(expectedDocument, singz::kGraphTypeProjectLaneSource,
                   "vocals") ==
            laneNodeId(reorderedDocument,
                       singz::kGraphTypeProjectLaneSource, "vocals") &&
        laneNodeId(expectedDocument, singz::kGraphTypeGain, "vocals") ==
            laneNodeId(reorderedDocument, singz::kGraphTypeGain, "vocals") &&
        singz::synthesizedNativePlaybackGraphNodeCount(graphContext) == 11 &&
        expectedDocument.nodes.size() == 11 &&
        expectedDocument.connections.size() == 10);
  std::vector<singz::NativePlaybackLaneSource> lanes;
  lanes.push_back(lane("vocals", vocals));
  lanes.push_back(lane("guitar", guitar));
  CHECK(session.prepare(std::move(prepared), std::move(lanes), 1).ok);
  auto status = session.status();
  CHECK(status.trainingEnabled && status.trainingLanes.size() == 1 &&
        status.trainingLanes[0] == "vocals" &&
        status.topology.find("prepared training duck") != std::string::npos);
  const auto &trainingGraph = graphSnapshot(status);
  const auto *vocalsGain = graphNode(trainingGraph, "lane gain[vocals]");
  const auto *vocalsTraining =
      graphNode(trainingGraph, "prepared training duck[vocals]");
  const auto *guitarGain = graphNode(trainingGraph, "lane gain[guitar]");
  const auto *trainingMix = graphNode(trainingGraph, "song mix");
  CHECK(trainingGraph.nodes.size() == expectedDocument.nodes.size() &&
        trainingGraph.connections.size() ==
            expectedDocument.connections.size() &&
        vocalsGain != nullptr &&
        vocalsTraining != nullptr &&
        vocalsTraining->id == expectedTrainingId &&
        vocalsTraining->kind ==
            singz::NativePlaybackGraphNodeKind::ScheduledGain &&
        vocalsTraining->typeHigh == singz::kGraphTypeTrainingDuck.high &&
        vocalsTraining->typeLow == singz::kGraphTypeTrainingDuck.low &&
        vocalsTraining->inputBusCount == 1 &&
        vocalsTraining->inputBusChannels[0] == 2 &&
        vocalsTraining->outputBusChannels[0] == 2 && guitarGain != nullptr &&
        trainingMix != nullptr);
  CHECK(graphConnection(trainingGraph, vocalsGain->id, vocalsTraining->id) !=
            nullptr &&
        graphConnection(trainingGraph, vocalsTraining->id, trainingMix->id,
                        0) != nullptr &&
        graphConnection(trainingGraph, guitarGain->id, trainingMix->id, 1) !=
            nullptr &&
        graphNode(trainingGraph, "prepared training duck[guitar]") == nullptr);
  CHECK(session.openOutput(1).ok && session.start(1).ok);

  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  CHECK(fake->drive(128, singz::AudioHostDiscontinuityStart));
  zdsp::test::setAllocationTrapEnabled(false);
  CHECK(zdsp::test::trappedAllocationCount() == 0 &&
        near(fake->left[0], pcm16(0.3F), 0.0002F));
  CHECK(fake->drive(128));
  CHECK(near(fake->left[127], pcm16(0.1F), 0.002F));

  // Disarming is a scalar parameter event on the already prepared graph. It
  // restores only the independent training layer; user lane state is intact.
  CHECK(session.setTrainingEnabled(1, false).ok);
  CHECK(session.seek(1, 128).ok && fake->drive(128));
  CHECK(near(fake->left[0], pcm16(0.3F), 0.002F) &&
        near(fake->left[127], pcm16(0.3F), 0.002F));
  status = session.status();
  CHECK(!status.trainingEnabled && status.lanes[0].gain == 1.0F &&
        !status.lanes[0].muted && !status.lanes[0].solo);
  CHECK(session.setTrainingEnabled(1, true).ok);
  CHECK(session.seek(1, 128).ok && fake->drive(128));
  CHECK(near(fake->left[0], pcm16(0.1F), 0.002F) &&
        near(fake->left[127], pcm16(0.1F), 0.002F));

  const auto unloaded = session.unloadWithCleanup(1);
  CHECK(unloaded.playback.ok && unloaded.cleanup.globallyComplete());

  singz::NativePlaybackPrepareConfig invalid = config();
  invalid.handoffLease = unloaded.cleanup.handoffLease;
  training.mode = singz::NativePlaybackTrainingMode::Windows;
  training.periodFrames = 0;
  training.windows = {{20, 40}, {39, 60}};
  invalid.trainingDuck = training;
  std::vector<singz::NativePlaybackLaneSource> invalidLanes;
  invalidLanes.push_back(lane("vocals", vocals));
  CHECK(session.prepare(std::move(invalid), std::move(invalidLanes), 2).error ==
        singz::NativePlaybackError::InvalidConfiguration);
  CHECK(session.unload(2).ok);
  std::remove(vocals.c_str());
  std::remove(guitar.c_str());
}

singz::PlaybackCuePlanRequest cueRequest(bool click, uint32_t countInBars,
                                         double volume) {
  singz::PlaybackCuePlanRequest request;
  request.beatGrid.beats = {0.0, 0.2, 0.4, 0.6, 0.8};
  request.beatGrid.beatsPerBar = 2;
  request.beatGrid.downbeat = 0;
  request.beatGrid.downbeats = {0, 2, 4};
  request.click = click;
  request.countInBars = countInBars;
  request.volume = volume;
  request.accent = true;
  request.entrySeconds = 0.4;
  request.durationSeconds = 0.8;
  request.sampleRate = 48000.0;
  request.playbackRate = 1.0;
  return request;
}

float rangePeak(const std::vector<float> &samples, size_t first, size_t last,
                float baseline = 0.0F) {
  CHECK(first <= last && last <= samples.size());
  float peak = 0.0F;
  for (size_t index = first; index < last; ++index)
    peak = std::max(peak, std::fabs(samples[index] - baseline));
  return peak;
}

void cueGraphTransportCompositionAndLifetime() {
  constexpr uint32_t preRoll = 19200;
  constexpr uint32_t songFramesToRender = 10000;
  constexpr float songSample = 0.1F;
  const std::string wav =
      writeWav("cue-graph.wav", 1, std::vector<float>(40000, songSample));
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  uint64_t generation = 1;
  uint64_t handoffLease = 0;

  const auto render = [&](singz::NativePlaybackPrepareConfig request,
                          const std::vector<uint32_t> &partitions,
                          uint32_t frames, bool trapFirstCallback,
                          singz::NativePlaybackStatus *preparedStatus,
                          singz::NativePlaybackStatus *firstStatus) {
    request.handoffLease = handoffLease;
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("song", wav));
    CHECK(session.prepare(std::move(request), std::move(lanes), generation).ok);
    *preparedStatus = session.status();
    CHECK(session.openOutput(generation).ok && session.start(generation).ok);
    fake->captureOutput = true;
    fake->outputTrace.clear();
    uint32_t rendered = 0;
    size_t partition = 0;
    bool first = true;
    while (rendered < frames) {
      const uint32_t block = std::min(
          partitions[partition++ % partitions.size()], frames - rendered);
      if (first && trapFirstCallback) {
        fake->captureOutput = false;
        zdsp::test::resetAllocationTrap();
        zdsp::test::setAllocationTrapEnabled(true);
      }
      CHECK(fake->drive(block, first ? singz::AudioHostDiscontinuityStart : 0));
      if (first && trapFirstCallback) {
        zdsp::test::setAllocationTrapEnabled(false);
        CHECK(zdsp::test::trappedAllocationCount() == 0);
        fake->captureOutput = true;
        fake->outputTrace.insert(fake->outputTrace.end(), fake->left.begin(),
                                 fake->left.begin() + block);
      }
      rendered += block;
      if (first) {
        *firstStatus = session.status();
        first = false;
      }
    }
    fake->captureOutput = false;
    std::vector<float> output = fake->outputTrace;
    const auto unloaded = session.unloadWithCleanup(generation);
    CHECK(unloaded.playback.ok && unloaded.cleanup.globallyComplete() &&
          unloaded.cleanup.retainedBytes == 0);
    handoffLease = unloaded.cleanup.handoffLease;
    ++generation;
    return output;
  };

  singz::NativePlaybackPrepareConfig full = config();
  full.cuePlan = cueRequest(true, 1, 0.5);
  full.cuePlan->durationSeconds = 100.0; // discarded in favor of decoded lanes
  singz::NativePlaybackStatus prepared{};
  singz::NativePlaybackStatus afterFirst{};
  const std::vector<float> coarse = render(
      full, {512}, preRoll + songFramesToRender, true, &prepared, &afterFirst);
  CHECK(
      prepared.preRollFrames == preRoll && prepared.cueEventCount == 5 &&
      prepared.renderedProjectFrame == -static_cast<int64_t>(preRoll) &&
      prepared.remainingPreRollFrames == preRoll &&
      prepared.transportState == singz::NativePlaybackTransportState::Stopped &&
      prepared.transportGeneration == 1 && prepared.durationFrames == 20800 &&
      prepared.referenceGain == 0.5F && prepared.graphNodeCount == 12 &&
      prepared.graphConnectionCount == 11 &&
      prepared.topology.find("reference gain") != std::string::npos &&
      prepared.lanes.size() == 1 && prepared.lanes[0].cursorFrames == preRoll);
  singz::NativePlaybackGraphContext referenceContext;
  referenceContext.outputChannels = 2;
  referenceContext.hasReference = true;
  referenceContext.lanes = {{"song", 1, false}};
  const auto referenceDocument =
      singz::synthesizeNativePlaybackGraphDocument(referenceContext);
  const auto *expectedCueSource = documentNode(
      referenceDocument, singz::kGraphTypeCueSource, "reference-cues");
  const auto *expectedReferenceMap = documentNode(
      referenceDocument, singz::kGraphTypeChannelMap, "reference-map");
  const auto *expectedReferenceGain = documentNode(
      referenceDocument, singz::kGraphTypeGain, "reference-gain");
  const auto *expectedOutputMix =
      documentNode(referenceDocument, singz::kGraphTypeMix, nullptr, nullptr,
                   "reference");
  const auto *expectedOutputGain = documentNode(
      referenceDocument, singz::kGraphTypeGain, "output-gain");
  const auto *expectedReferenceLimiter =
      documentNode(referenceDocument, singz::kGraphTypeSafetyLimiter);
  const auto *expectedReferenceOutput = documentNode(
      referenceDocument, singz::kGraphTypePhysicalOutput, "project-output");
  CHECK(expectedCueSource != nullptr && expectedReferenceMap != nullptr &&
        expectedReferenceGain != nullptr && expectedOutputMix != nullptr &&
        expectedOutputGain != nullptr && expectedReferenceLimiter != nullptr &&
        expectedReferenceOutput != nullptr &&
        referenceDocument.nodes.size() == 12 &&
        referenceDocument.connections.size() == 11);
  const auto &referenceGraph = graphSnapshot(prepared);
  const auto *cueSource = graphNodeById(referenceGraph, expectedCueSource->id);
  const auto *referenceMap =
      graphNodeById(referenceGraph, expectedReferenceMap->id);
  const auto *referenceGain =
      graphNodeById(referenceGraph, expectedReferenceGain->id);
  const auto *outputMix =
      graphNodeById(referenceGraph, expectedOutputMix->id);
  const auto *outputGain =
      graphNodeById(referenceGraph, expectedOutputGain->id);
  const auto *referenceLimiter =
      graphNodeById(referenceGraph, expectedReferenceLimiter->id);
  const auto *referenceOutput =
      graphNodeById(referenceGraph, expectedReferenceOutput->id);
  CHECK(referenceGraph.nodes.size() == referenceDocument.nodes.size() &&
        referenceGraph.connections.size() ==
            referenceDocument.connections.size() &&
        cueSource != nullptr && cueSource->label == "prepared cue source" &&
        cueSource->kind ==
            singz::NativePlaybackGraphNodeKind::ScheduledCueSource &&
        cueSource->inputBusCount == 0 && cueSource->outputBusChannels[0] == 1 &&
        referenceMap != nullptr && referenceMap->label == "reference map" &&
        referenceMap->inputBusChannels[0] == 1 &&
        referenceMap->outputBusChannels[0] == 2 && referenceGain != nullptr &&
        referenceGain->label == "reference gain" && outputMix != nullptr &&
        outputMix->label == "output mix" && outputMix->inputBusCount == 2 &&
        outputGain != nullptr && outputGain->label == "output gain" &&
        referenceLimiter != nullptr && referenceOutput != nullptr);
  CHECK(graphConnection(referenceGraph, cueSource->id, referenceMap->id) !=
            nullptr &&
        graphConnection(referenceGraph, referenceMap->id, referenceGain->id) !=
            nullptr &&
        graphConnection(referenceGraph, referenceGain->id, outputMix->id, 1) !=
            nullptr &&
        graphConnection(referenceGraph, outputMix->id, outputGain->id) !=
            nullptr &&
        graphConnection(referenceGraph, outputGain->id,
                        referenceLimiter->id) != nullptr &&
        graphConnection(referenceGraph, referenceLimiter->id,
                        referenceOutput->id) != nullptr);
  CHECK(afterFirst.lanes[0].cursorFrames == preRoll);
  CHECK(
      afterFirst.renderedProjectFrame == -static_cast<int64_t>(preRoll - 512) &&
      afterFirst.audibleProjectFrame == -static_cast<int64_t>(preRoll - 508) &&
      afterFirst.continuousFrame == 512 &&
      afterFirst.remainingPreRollFrames == preRoll - 512 &&
      afterFirst.cueEventsCompleted == 1 && afterFirst.nextCueEventIndex == 1 &&
      afterFirst.presentationLatencyFrames == 4 &&
      afterFirst.transportState ==
          singz::NativePlaybackTransportState::PreRoll);
  CHECK(rangePeak(coarse, 1, 256) > 0.05F);
  CHECK(near(coarse[preRoll - 1], 0.0F, 0.00001F));
  CHECK(near(coarse[preRoll], pcm16(songSample), 0.0001F));
  CHECK(rangePeak(coarse, preRoll + 1, preRoll + 512, pcm16(songSample)) >
        0.05F);
  const float accent =
      rangePeak(coarse, preRoll, preRoll + 2048, pcm16(songSample));
  const float ordinary =
      rangePeak(coarse, preRoll + 9600, preRoll + 10000, pcm16(songSample));
  CHECK(accent > ordinary * 1.2F && ordinary > 0.05F);

  singz::NativePlaybackStatus finePrepared{};
  singz::NativePlaybackStatus fineFirst{};
  const std::vector<float> fine =
      render(full, {127, 251, 61, 509}, preRoll + songFramesToRender, false,
             &finePrepared, &fineFirst);
  CHECK(fine.size() == coarse.size());
  for (size_t index = 0; index < coarse.size(); ++index)
    CHECK(near(fine[index], coarse[index], 0.00001F));

  singz::NativePlaybackPrepareConfig mutedSong = config();
  mutedSong.masterGain = 0.0F;
  mutedSong.cuePlan = cueRequest(false, 1, 0.5);
  singz::NativePlaybackStatus countInPrepared{};
  singz::NativePlaybackStatus countInFirst{};
  const std::vector<float> countIn = render(
      mutedSong, {257}, preRoll + 3000, false, &countInPrepared, &countInFirst);
  CHECK(rangePeak(countIn, 1, 1024) > 0.05F);
  CHECK(rangePeak(countIn, preRoll, countIn.size()) < 0.00001F);

  singz::NativePlaybackPrepareConfig quarterReference = config();
  quarterReference.masterGain = 0.0F;
  quarterReference.cuePlan = cueRequest(false, 1, 0.25);
  singz::NativePlaybackStatus quarterPrepared{};
  singz::NativePlaybackStatus quarterFirst{};
  const std::vector<float> quarter = render(
      quarterReference, {512}, 1024, false, &quarterPrepared, &quarterFirst);
  CHECK(quarterPrepared.referenceGain == 0.25F);
  const float halfPeak = rangePeak(countIn, 1, 1024);
  const float quarterPeak = rangePeak(quarter, 1, 1024);
  CHECK(near(halfPeak, quarterPeak * 2.0F, 0.002F));

  singz::NativePlaybackPrepareConfig stretchedReference = config();
  stretchedReference.masterGain = 0.0F;
  stretchedReference.playbackRate = 0.75;
  stretchedReference.cuePlan = cueRequest(false, 1, 0.5);
  stretchedReference.cuePlan->playbackRate = 0.75;
  singz::NativePlaybackStatus stretchedPrepared{};
  singz::NativePlaybackStatus stretchedFirst{};
  const std::vector<float> stretchedCue = render(
      stretchedReference, {509, 257}, 20000, false, &stretchedPrepared,
      &stretchedFirst);
  const size_t graphLatency =
      static_cast<size_t>(stretchedPrepared.graphLatencyFrames);
  CHECK(graphLatency > 0 && graphLatency + 1024 < stretchedCue.size() &&
        stretchedPrepared.latencyCompensatedEdgeCount == 1 &&
        stretchedPrepared.topology.find("Signalsmith time/pitch") !=
            std::string::npos);
  singz::NativePlaybackGraphContext stretchedContext = referenceContext;
  stretchedContext.needsTimePitch = true;
  const auto stretchedDocument =
      singz::synthesizeNativePlaybackGraphDocument(stretchedContext);
  const auto *expectedTimePitch =
      documentNode(stretchedDocument, singz::kGraphTypeSignalsmithTimePitch);
  const auto *expectedStretchedReferenceGain = documentNode(
      stretchedDocument, singz::kGraphTypeGain, "reference-gain");
  const auto *expectedStretchedOutputMix =
      documentNode(stretchedDocument, singz::kGraphTypeMix, nullptr, nullptr,
                   "reference");
  CHECK(expectedTimePitch != nullptr &&
        expectedStretchedReferenceGain != nullptr &&
        expectedStretchedOutputMix != nullptr &&
        stretchedDocument.nodes.size() == 13 &&
        stretchedDocument.connections.size() == 12);
  const auto &stretchedGraph = graphSnapshot(stretchedPrepared);
  const auto *timePitch =
      graphNodeById(stretchedGraph, expectedTimePitch->id);
  const auto *stretchedReferenceGain =
      graphNodeById(stretchedGraph, expectedStretchedReferenceGain->id);
  const auto *stretchedOutputMix =
      graphNodeById(stretchedGraph, expectedStretchedOutputMix->id);
  CHECK(stretchedGraph.nodes.size() == stretchedDocument.nodes.size() &&
        stretchedGraph.connections.size() ==
            stretchedDocument.connections.size() &&
        timePitch != nullptr && timePitch->label == "Signalsmith time/pitch" &&
        timePitch->kind ==
            singz::NativePlaybackGraphNodeKind::SignalsmithTimePitch &&
        timePitch->typeHigh == singz::kGraphTypeSignalsmithTimePitch.high &&
        timePitch->typeLow == singz::kGraphTypeSignalsmithTimePitch.low &&
        timePitch->inputBusCount == 1 &&
        timePitch->outputBusCount == 1 &&
        timePitch->inputBusChannels[0] == 2 &&
        timePitch->outputBusChannels[0] == 2 &&
        timePitch->intrinsicLatencyFrames == graphLatency &&
        timePitch->outputLatencyFrames == graphLatency &&
        stretchedReferenceGain != nullptr && stretchedOutputMix != nullptr &&
        stretchedOutputMix->arrivalLatencyFrames == graphLatency);
  const auto *songAligned =
      graphConnection(stretchedGraph, timePitch->id, stretchedOutputMix->id, 0);
  const auto *referenceAligned = graphConnection(
      stretchedGraph, stretchedReferenceGain->id, stretchedOutputMix->id, 1);
  CHECK(songAligned != nullptr && songAligned->compensationFrames == 0 &&
        !songAligned->latencyCompensated &&
        referenceAligned != nullptr &&
        referenceAligned->compensationFrames == graphLatency &&
        referenceAligned->latencyCompensated &&
        referenceAligned->destinationArrivalLatencyFrames == graphLatency);
  CHECK(rangePeak(stretchedCue, 0, graphLatency) < 0.00001F);
  CHECK(rangePeak(stretchedCue, graphLatency, graphLatency + 1024) > 0.05F);

  singz::NativePlaybackPrepareConfig limited = config();
  limited.masterGain = 4.0F;
  limited.cuePlan = cueRequest(true, 1, 1.0);
  singz::NativePlaybackStatus limitedPrepared{};
  singz::NativePlaybackStatus limitedFirst{};
  const std::vector<float> clipped = render(
      limited, {383}, preRoll + 1024, false, &limitedPrepared, &limitedFirst);
  const float clippedPeak = rangePeak(clipped, preRoll, clipped.size());
  CHECK(clippedPeak <= singz::kNativePlaybackLimiterCeiling + 0.00001F &&
        clippedPeak >= singz::kNativePlaybackLimiterCeiling - 0.00001F);

  singz::NativePlaybackPrepareConfig legacy = config();
  singz::NativePlaybackStatus legacyPrepared{};
  singz::NativePlaybackStatus legacyFirst{};
  const std::vector<float> ordinaryPlayback =
      render(legacy, {64}, 64, false, &legacyPrepared, &legacyFirst);
  singz::NativePlaybackGraphContext legacyContext;
  legacyContext.outputChannels = 2;
  legacyContext.lanes = {{"song", 1, false}};
  const auto legacyDocument =
      singz::synthesizeNativePlaybackGraphDocument(legacyContext);
  const auto *expectedLegacyGain =
      documentNode(legacyDocument, singz::kGraphTypeGain, "song-master");
  const auto *expectedLegacyLimiter =
      documentNode(legacyDocument, singz::kGraphTypeSafetyLimiter);
  CHECK(expectedLegacyGain != nullptr && expectedLegacyLimiter != nullptr &&
        legacyDocument.nodes.size() == 7 &&
        legacyDocument.connections.size() == 6);
  CHECK(legacyPrepared.preRollFrames == 0 &&
        legacyPrepared.cueEventCount == 0 &&
        legacyPrepared.referenceGain == 0.0F &&
        legacyPrepared.graphNodeCount == 7 &&
        legacyPrepared.graphConnectionCount == 6);
  const auto &legacyGraph = graphSnapshot(legacyPrepared);
  const auto *legacyGain =
      graphNodeById(legacyGraph, expectedLegacyGain->id);
  const auto *legacyLimiter =
      graphNodeById(legacyGraph, expectedLegacyLimiter->id);
  CHECK(legacyGraph.nodes.size() == legacyDocument.nodes.size() &&
        legacyGraph.connections.size() == legacyDocument.connections.size() &&
        legacyGraph.latencyCompensatedConnectionCount == 0 &&
        legacyGain != nullptr && legacyGain->label == "song gain" &&
        legacyLimiter != nullptr && legacyLimiter->label == "safety limiter" &&
        graphConnection(legacyGraph, legacyGain->id, legacyLimiter->id) !=
            nullptr &&
        graphNode(legacyGraph, "prepared cue source") == nullptr &&
        graphNode(legacyGraph, "reference map") == nullptr &&
        graphNode(legacyGraph, "reference gain") == nullptr &&
        graphNode(legacyGraph, "output mix") == nullptr &&
        graphNode(legacyGraph, "output gain") == nullptr);
  for (float sample : ordinaryPlayback)
    CHECK(near(sample, pcm16(songSample)));

  singz::NativePlaybackPrepareConfig loopingCues = config();
  loopingCues.handoffLease = handoffLease;
  loopingCues.cuePlan = cueRequest(true, 0, 0.5);
  auto loopingLanes = std::vector<singz::NativePlaybackLaneSource>{};
  loopingLanes.push_back(lane("song", wav));
  CHECK(
      session
          .prepare(std::move(loopingCues), std::move(loopingLanes), generation)
          .ok);
  CHECK(session.openOutput(generation).ok && session.start(generation).ok &&
        session.setLoop(generation, 0, 256).ok);
  fake->outputTrace.clear();
  fake->captureOutput = true;
  CHECK(fake->drive(512));
  fake->captureOutput = false;
  CHECK(fake->outputTrace.size() == 512);
  for (uint32_t frame = 0; frame < 256; ++frame)
    CHECK(near(fake->outputTrace[frame], fake->outputTrace[frame + 256],
               0.00001F));
  auto loopingStatus = session.status();
  CHECK(loopingStatus.loopCount == 1 &&
        loopingStatus.renderedProjectFrame == 256 &&
        loopingStatus.cueEventsCompleted == 1);
  CHECK(session.seek(generation, 0).ok);
  fake->outputTrace.clear();
  fake->captureOutput = true;
  CHECK(fake->drive(127));
  CHECK(fake->drive(129));
  CHECK(fake->drive(256));
  fake->captureOutput = false;
  CHECK(fake->outputTrace.size() == 512);
  for (uint32_t frame = 0; frame < 256; ++frame)
    CHECK(near(fake->outputTrace[frame], fake->outputTrace[frame + 256],
               0.00001F));
  const auto loopingUnload = session.unloadWithCleanup(generation);
  CHECK(loopingUnload.playback.ok && loopingUnload.cleanup.globallyComplete());
  handoffLease = loopingUnload.cleanup.handoffLease;
  ++generation;

  singz::NativePlaybackPrepareConfig controlledCountIn = config();
  controlledCountIn.handoffLease = handoffLease;
  controlledCountIn.cuePlan = cueRequest(false, 1, 0.5);
  auto controlledLanes = std::vector<singz::NativePlaybackLaneSource>{};
  controlledLanes.push_back(lane("song", wav));
  CHECK(session
            .prepare(std::move(controlledCountIn), std::move(controlledLanes),
                     generation)
            .ok);
  CHECK(session.openOutput(generation).ok && session.start(generation).ok);
  CHECK(fake->drive(100));
  CHECK(session.pause(generation).ok && fake->drive(17));
  auto controlledStatus = session.status();
  CHECK(controlledStatus.renderedProjectFrame == -19100 &&
        controlledStatus.remainingPreRollFrames == 19100 &&
        controlledStatus.transportState ==
            singz::NativePlaybackTransportState::Paused);
  CHECK(session.resume(generation).ok && fake->drive(100));
  controlledStatus = session.status();
  CHECK(controlledStatus.renderedProjectFrame == -19000 &&
        controlledStatus.remainingPreRollFrames == 19000 &&
        controlledStatus.continuousFrame == 217);
  CHECK(session.seek(generation, 0).ok && fake->drive(1));
  controlledStatus = session.status();
  CHECK(controlledStatus.renderedProjectFrame == 1 &&
        controlledStatus.remainingPreRollFrames == 0 &&
        controlledStatus.seekCount == 1 &&
        controlledStatus.transportState ==
            singz::NativePlaybackTransportState::Playing);
  const auto controlledUnload = session.unloadWithCleanup(generation);
  CHECK(controlledUnload.playback.ok &&
        controlledUnload.cleanup.globallyComplete());
  handoffLease = controlledUnload.cleanup.handoffLease;
  ++generation;

  // The integration cases deliberately exercise fallback leases between
  // generations. Consume the final lease and use an ordinary unload so the
  // rest of this process starts from the same Available coordinator state.
  singz::NativePlaybackPrepareConfig cleanupConfig = config();
  cleanupConfig.handoffLease = handoffLease;
  auto cleanupLanes = std::vector<singz::NativePlaybackLaneSource>{};
  cleanupLanes.push_back(lane("cleanup", wav));
  CHECK(session
            .prepare(std::move(cleanupConfig), std::move(cleanupLanes),
                     generation)
            .ok);
  CHECK(session.unload(generation).ok);

  std::remove(wav.c_str());
}

void nativeReferencePreviewClickContract() {
  const std::string wav = writeWav(
      "preview-click.wav", 1, std::vector<float>(40000, 0.4F));
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));

  singz::NativePlaybackPrepareConfig request = config();
  request.masterGain = 0.0F;
  request.cuePlan = cueRequest(false, 1, 1.0);
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("song", wav));
  CHECK(session.prepare(std::move(request), std::move(lanes), 31).ok);
  auto status = session.status();
  CHECK(status.cueEventCount != 0 && status.preRollFrames != 0 &&
        status.graphNodeCount == 12 &&
        status.graphConnectionCount == 11 &&
        status.topology.rfind("actual graph · nodes [", 0) == 0 &&
        status.topology.find("reference gain→output mix") !=
            std::string::npos &&
        status.topology.find("output gain→safety limiter") !=
            std::string::npos &&
        status.previewClicksEnqueued == 0 &&
        status.previewClicksPending == 0);
  const int64_t preparedProjectFrame = status.renderedProjectFrame;
  const uint64_t preparedPreRollFrames = status.remainingPreRollFrames;
  // Preview owns the already-prepared native host before first Play, but it
  // must not start song transport or synthesize a count-in.
  CHECK(session.previewClick(31).ok);
  status = session.status();
  CHECK(status.state == singz::NativePlaybackState::Running &&
        status.transportState ==
            singz::NativePlaybackTransportState::Stopped &&
        status.renderedProjectFrame == preparedProjectFrame &&
        status.remainingPreRollFrames == preparedPreRollFrames &&
        status.previewClicksEnqueued == 1 &&
        status.previewClicksStarted == 0 &&
        status.previewClicksCompleted == 0 &&
        status.previewClicksPending == 1);

  fake->outputTrace.clear();
  fake->captureOutput = false;
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  CHECK(fake->drive(512));
  zdsp::test::setAllocationTrapEnabled(false);
  fake->outputTrace.insert(fake->outputTrace.end(), fake->left.begin(),
                           fake->left.begin() + 512);
  CHECK(zdsp::test::trappedAllocationCount() == 0 &&
        rangePeak(fake->outputTrace, 0, fake->outputTrace.size()) > 0.1F);
  status = session.status();
  CHECK(status.previewClicksStarted == 1 &&
        status.previewClicksCompleted == 0 &&
        status.previewClicksPending == 1 &&
        status.transportState ==
            singz::NativePlaybackTransportState::Stopped &&
        status.renderedProjectFrame == preparedProjectFrame &&
        status.remainingPreRollFrames == preparedPreRollFrames);

  // Finish the ordinary click, then overlap the whole bounded accent mailbox.
  for (uint32_t remaining = 2640u - 512u; remaining != 0;) {
    const uint32_t frames = std::min<uint32_t>(remaining, 512u);
    CHECK(fake->drive(frames));
    remaining -= frames;
  }
  status = session.status();
  CHECK(status.previewClicksCompleted == 1 &&
        status.previewClicksPending == 0);
  for (uint32_t index = 0; index < zdsp::kMaximumScheduledCueOneShots;
       ++index)
    CHECK(session
              .previewClick(31,
                            singz::NativePlaybackPreviewClickSound::Accent)
              .ok);
  CHECK(session
            .previewClick(31, singz::NativePlaybackPreviewClickSound::Accent)
            .error == singz::NativePlaybackError::QueueFull);
  fake->outputTrace.clear();
  fake->captureOutput = true;
  CHECK(fake->drive(512));
  fake->captureOutput = false;
  const float peak =
      rangePeak(fake->outputTrace, 0, fake->outputTrace.size());
  CHECK(peak <= singz::kNativePlaybackLimiterCeiling + 0.00001F &&
        peak >= singz::kNativePlaybackLimiterCeiling - 0.00001F);
  status = session.status();
  CHECK(status.previewClicksEnqueued == 33 &&
        status.previewClicksStarted == 33 &&
        status.previewClicksCompleted == 1 &&
        status.previewClicksPending == 32);
  fake->setPresentationLatency(3, 5, 7);
  status = session.status();
  const uint64_t continuousBeforeStart = status.continuousFrame;
  CHECK(continuousBeforeStart > 0 &&
        status.totalPresentationLatencyFrames > 1);
  CHECK(session.start(31).ok && fake->drive(1));
  status = session.status();
  CHECK(status.transportState ==
            singz::NativePlaybackTransportState::PreRoll &&
        status.renderedProjectFrame == preparedProjectFrame + 1 &&
        status.continuousFrame == continuousBeforeStart + 1 &&
        status.audibleProjectionQuality ==
            singz::NativePlaybackAudibleProjectionQuality::Unavailable);
  uint64_t framesToMature = status.totalPresentationLatencyFrames - 1;
  while (framesToMature != 0) {
    const uint32_t frames =
        static_cast<uint32_t>(std::min<uint64_t>(framesToMature, 512));
    CHECK(fake->drive(frames));
    framesToMature -= frames;
  }
  status = session.status();
  CHECK(status.continuousFrame ==
            continuousBeforeStart + status.totalPresentationLatencyFrames &&
        status.audibleProjectionQuality ==
            singz::NativePlaybackAudibleProjectionQuality::Current &&
        status.audibleProjectFrame == preparedProjectFrame);
  CHECK(session.previewClick(999).error ==
        singz::NativePlaybackError::InvalidGeneration);
  CHECK(session.unload(31).ok);

  singz::NativePlaybackPrepareConfig noReference = config();
  auto ordinaryLanes = std::vector<singz::NativePlaybackLaneSource>{};
  ordinaryLanes.push_back(lane("song", wav));
  CHECK(session
            .prepare(std::move(noReference), std::move(ordinaryLanes), 32)
            .ok);
  CHECK(session.openOutput(32).ok && session.start(32).ok);
  CHECK(session.previewClick(32).error ==
        singz::NativePlaybackError::InvalidConfiguration);
  CHECK(session.unload(32).ok);

  singz::NativePlaybackPrepareConfig lifecycle = config();
  lifecycle.masterGain = 0.0F;
  lifecycle.cuePlan = cueRequest(false, 0, 1.0);
  auto lifecycleLanes = std::vector<singz::NativePlaybackLaneSource>{};
  lifecycleLanes.push_back(lane("song", wav));
  CHECK(session
            .prepare(std::move(lifecycle), std::move(lifecycleLanes), 33)
            .ok);
  CHECK(session.openOutput(33).ok && session.start(33).ok && fake->drive(4));
  CHECK(session.pause(33).ok && fake->drive(1));
  status = session.status();
  const int64_t pausedFrame = status.renderedProjectFrame;
  CHECK(status.transportState ==
        singz::NativePlaybackTransportState::Paused);
  CHECK(session
            .previewClick(33,
                          singz::NativePlaybackPreviewClickSound::Accent)
            .ok &&
        fake->drive(512));
  status = session.status();
  CHECK(status.transportState ==
            singz::NativePlaybackTransportState::Paused &&
        status.renderedProjectFrame == pausedFrame);
  const int64_t completedFrame = static_cast<int64_t>(status.durationFrames);
  CHECK(session.resume(33).ok);
  CHECK(session.seek(33, completedFrame).ok);
  CHECK(fake->drive(1));
  status = session.status();
  CHECK(status.transportState ==
            singz::NativePlaybackTransportState::Completed &&
        status.renderedProjectFrame == completedFrame);
  CHECK(session.previewClick(33).ok && fake->drive(512));
  status = session.status();
  CHECK(status.transportState ==
            singz::NativePlaybackTransportState::Completed &&
        status.renderedProjectFrame == completedFrame);
  CHECK(session.unload(33).ok);
  std::remove(wav.c_str());
}

void transportControlKernelAndTelemetry() {
  std::vector<float> ramp(64);
  for (uint32_t frame = 0; frame < ramp.size(); ++frame)
    ramp[frame] = static_cast<float>(frame) * 0.005F;
  const std::string wav = writeWav("transport-kernel.wav", 1, ramp);
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("song", wav));
    CHECK(session.prepare(config(), std::move(lanes), 41).ok);
    CHECK(session.openOutput(41).ok && session.start(41).ok);
    CHECK(fake->drive(5, singz::AudioHostDiscontinuityStart));
    auto status = session.status();
    CHECK(status.transportGeneration == 41 && status.durationFrames == 64 &&
          status.renderedProjectFrame == 5 && status.audibleProjectFrame == 1 &&
          status.audibleProjectionQuality ==
              singz::NativePlaybackAudibleProjectionQuality::Current &&
          status.continuousFrame == 5 &&
          status.transportState ==
              singz::NativePlaybackTransportState::Playing &&
          status.transportDiscontinuities == 1 && status.playbackRate == 1.0 &&
          status.lastTransportBoundary ==
              singz::NativePlaybackTransportBoundaryReason::
                  StreamGenerationChanged &&
          status.transportTelemetryQuality ==
              singz::NativePlaybackTransportTelemetryQuality::Current);

    CHECK(session.pause(41).ok);
    CHECK(fake->drive(4));
    for (uint32_t frame = 0; frame < 4; ++frame)
      CHECK(fake->left[frame] == 0.0F && fake->right[frame] == 0.0F);
    status = session.status();
    CHECK(status.renderedProjectFrame == 5 && status.continuousFrame == 9 &&
          status.transportState == singz::NativePlaybackTransportState::Paused);

    CHECK(session.resume(41).ok);
    CHECK(fake->drive(3));
    CHECK(near(fake->left[0], pcm16(ramp[5])) &&
          near(fake->left[2], pcm16(ramp[7])));
    status = session.status();
    CHECK(status.renderedProjectFrame == 8 && status.continuousFrame == 12 &&
          status.remainingPreRollFrames == 0);

    CHECK(session.seek(41, 20).ok);
    CHECK(fake->drive(4));
    CHECK(near(fake->left[0], pcm16(ramp[20])) &&
          near(fake->left[3], pcm16(ramp[23])));
    status = session.status();
    CHECK(status.renderedProjectFrame == 24 && status.seekCount == 1 &&
          status.transportDiscontinuities == 2 &&
          status.lastTransportBoundary ==
              singz::NativePlaybackTransportBoundaryReason::SourceSeek);

    CHECK(session.setLoop(41, 4, 7).ok);
    CHECK(session.seek(41, 5).ok);
    fake->outputTrace.clear();
    fake->captureOutput = true;
    CHECK(fake->drive(8));
    fake->captureOutput = false;
    const std::array<uint32_t, 8> expectedFrames{5, 6, 4, 5, 6, 4, 5, 6};
    CHECK(fake->outputTrace.size() == expectedFrames.size());
    for (uint32_t index = 0; index < expectedFrames.size(); ++index)
      CHECK(near(fake->outputTrace[index], pcm16(ramp[expectedFrames[index]])));
    status = session.status();
    CHECK(status.loopEnabled && status.loopStartFrame == 4 &&
          status.loopEndFrame == 7 && status.loopCount == 2 &&
          status.renderedProjectFrame == 7 && status.seekCount == 2);

    CHECK(session.seek(41, 5).ok);
    fake->outputTrace.clear();
    fake->captureOutput = true;
    CHECK(fake->drive(1));
    CHECK(fake->drive(2));
    CHECK(fake->drive(5));
    fake->captureOutput = false;
    CHECK(fake->outputTrace.size() == expectedFrames.size());
    for (uint32_t index = 0; index < expectedFrames.size(); ++index)
      CHECK(near(fake->outputTrace[index], pcm16(ramp[expectedFrames[index]])));
    status = session.status();
    CHECK(status.renderedProjectFrame == 7 && status.loopCount == 4 &&
          status.seekCount == 3);

    CHECK(session.clearLoop(41).ok);
    CHECK(fake->drive(1));
    status = session.status();
    CHECK(!status.loopEnabled && status.renderedProjectFrame == 8);
    const int64_t renderedBeforeLatency = status.renderedProjectFrame;
    const uint64_t continuousBeforeLatency = status.continuousFrame;
    fake->setPresentationLatency(5, 7, 11);
    status = session.status();
    CHECK(status.presentationLatencyFrames == 23 &&
          status.renderedProjectFrame == renderedBeforeLatency &&
          status.continuousFrame == continuousBeforeLatency &&
          status.audibleProjectionQuality ==
              singz::NativePlaybackAudibleProjectionQuality::Unavailable);

    const uint64_t beforeExplicit = status.transportDiscontinuities;
    CHECK(session.reanchorTransport(41).ok);
    CHECK(fake->drive(1));
    status = session.status();
    CHECK(status.renderedProjectFrame == 9 &&
          status.transportDiscontinuities == beforeExplicit + 1 &&
          status.lastTransportBoundary ==
              singz::NativePlaybackTransportBoundaryReason::ClockReanchored);
    const uint64_t beforeRoute = status.transportDiscontinuities;
    fake->reanchorRouteAndStream();
    CHECK(fake->drive(1));
    status = session.status();
    CHECK(status.renderedProjectFrame == 10 &&
          status.transportDiscontinuities == beforeRoute + 1 &&
          status.lastTransportBoundary ==
              singz::NativePlaybackTransportBoundaryReason::
                  RouteGenerationChanged);

    // Multiple same-callback control facts become one emitted reset boundary.
    // Reanchor outranks the two overwritten seek reasons, while the final seek
    // position is still the actual rendered source position.
    const uint64_t beforeCoalesced = status.transportDiscontinuities;
    const uint64_t seeksBeforeCoalesced = status.seekCount;
    CHECK(session.seek(41, 11).ok && session.seek(41, 13).ok &&
          session.reanchorTransport(41).ok);
    CHECK(fake->drive(1));
    status = session.status();
    CHECK(status.renderedProjectFrame == 14 &&
          status.transportDiscontinuities == beforeCoalesced + 1 &&
          status.seekCount == seeksBeforeCoalesced &&
          status.lastTransportBoundary ==
              singz::NativePlaybackTransportBoundaryReason::ClockReanchored);

    // A hardware clock reset owns a simultaneous seek boundary; one reset is
    // emitted and counted, but the absolute seek still takes effect.
    const uint64_t beforeHostSeek = status.transportDiscontinuities;
    const uint64_t seeksBeforeHostSeek = status.seekCount;
    CHECK(session.seek(41, 20).ok);
    CHECK(fake->drive(1, singz::AudioHostDiscontinuityClockReanchored));
    status = session.status();
    CHECK(status.renderedProjectFrame == 21 &&
          status.transportDiscontinuities == beforeHostSeek + 1 &&
          status.seekCount == seeksBeforeHostSeek &&
          status.lastTransportBoundary ==
              singz::NativePlaybackTransportBoundaryReason::ClockReanchored);

    const uint64_t beforeIdentity = status.transportDiscontinuities;
    fake->advanceRouteIdentityOnly();
    CHECK(fake->drive(1));
    status = session.status();
    CHECK(status.transportDiscontinuities == beforeIdentity + 1 &&
          status.lastTransportBoundary ==
              singz::NativePlaybackTransportBoundaryReason::
                  RouteGenerationChanged);
    fake->advanceStreamIdentityOnly();
    CHECK(fake->drive(1));
    status = session.status();
    CHECK(status.transportDiscontinuities == beforeIdentity + 2 &&
          status.lastTransportBoundary ==
              singz::NativePlaybackTransportBoundaryReason::ClockReanchored);

    CHECK(session.pause(999).error ==
          singz::NativePlaybackError::InvalidGeneration);
    CHECK(session.resume(999).error ==
          singz::NativePlaybackError::InvalidGeneration);
    CHECK(session.seek(999, 0).error ==
          singz::NativePlaybackError::InvalidGeneration);
    CHECK(session.setLoop(999, 1, 2).error ==
          singz::NativePlaybackError::InvalidGeneration);
    CHECK(session.clearLoop(999).error ==
          singz::NativePlaybackError::InvalidGeneration);
    CHECK(session.reanchorTransport(999).error ==
          singz::NativePlaybackError::InvalidGeneration);
    CHECK(session.pause(41).ok);
    CHECK(session.seek(41, 2).ok);
    CHECK(fake->drive(3));
    status = session.status();
    CHECK(status.renderedProjectFrame == 2 &&
          status.continuousFrame == continuousBeforeLatency + 9 &&
          status.transportState == singz::NativePlaybackTransportState::Paused);
    for (uint32_t frame = 0; frame < 3; ++frame)
      CHECK(fake->left[frame] == 0.0F);
    CHECK(session.resume(41).ok);
    CHECK(fake->drive(2));
    CHECK(near(fake->left[0], pcm16(ramp[2])) &&
          near(fake->left[1], pcm16(ramp[3])));

    CHECK(session.stop(41).ok);
    status = session.status();
    CHECK(status.transportState ==
          singz::NativePlaybackTransportState::Stopped);
    CHECK(session.unload(41).ok);
    status = session.status();
    CHECK(status.generation == 0 && status.retainedBytes == 0 &&
          status.transportGeneration == 0);
  }

  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    singz::NativePlaybackPrepareConfig rateAware = config();
    rateAware.playbackRate = 0.75;
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("song", wav));
    const auto result =
        session.prepare(std::move(rateAware), std::move(lanes), 42);
    CHECK(result.ok && session.openOutput(42).ok && session.start(42).ok);
    CHECK(fake->drive(4, singz::AudioHostDiscontinuityStart));
    const auto rateStatus = session.status();
    CHECK(rateStatus.renderedProjectFrame == 3 &&
          rateStatus.playbackRate == 0.75 && rateStatus.graphLatencyFrames > 0 &&
          rateStatus.timePitchAnchorsPublished == 1 &&
          rateStatus.timePitchAnchorMisses == 0 &&
          rateStatus.lastTransportBoundary ==
              singz::NativePlaybackTransportBoundaryReason::
                  StreamGenerationChanged &&
          rateStatus.topology.find("Signalsmith time/pitch") !=
              std::string::npos &&
          fake->left[0] == 0.0F && fake->left[1] == 0.0F);
    singz::NativePlaybackGraphContext rateContext;
    rateContext.outputChannels = 2;
    rateContext.needsTimePitch = true;
    rateContext.lanes = {{"song", 1, false}};
    const auto rateDocument =
        singz::synthesizeNativePlaybackGraphDocument(rateContext);
    const auto *expectedRateTimePitch =
        documentNode(rateDocument, singz::kGraphTypeSignalsmithTimePitch);
    const auto *expectedRateLimiter =
        documentNode(rateDocument, singz::kGraphTypeSafetyLimiter);
    CHECK(expectedRateTimePitch != nullptr && expectedRateLimiter != nullptr &&
          rateDocument.nodes.size() == 8 &&
          rateDocument.connections.size() == 7);
    const auto &rateGraph = graphSnapshot(rateStatus);
    const auto *rateTimePitch =
        graphNodeById(rateGraph, expectedRateTimePitch->id);
    const auto *rateLimiter =
        graphNodeById(rateGraph, expectedRateLimiter->id);
    CHECK(rateGraph.nodes.size() == rateDocument.nodes.size() &&
          rateGraph.connections.size() == rateDocument.connections.size() &&
          rateTimePitch != nullptr &&
          rateTimePitch->label == "Signalsmith time/pitch" &&
          rateLimiter != nullptr && rateLimiter->label == "safety limiter" &&
          rateGraph.latencyCompensatedConnectionCount == 0 &&
          graphConnection(rateGraph, rateTimePitch->id, rateLimiter->id) !=
              nullptr &&
          graphNode(rateGraph, "prepared cue source") == nullptr &&
          graphNode(rateGraph, "reference gain") == nullptr &&
          graphNode(rateGraph, "output mix") == nullptr);
    CHECK(session.setLoop(42, 0, 1).error ==
          singz::NativePlaybackError::InvalidConfiguration);
    CHECK(session.unload(42).ok);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend));
    singz::NativePlaybackPrepareConfig capped = config();
    capped.playbackRate = 0.75;
    const singz::SignalsmithTimePitchConfig estimateConfig{
        {710}, {capped.requestedSampleRate},
        static_cast<uint32_t>(capped.outputChannels.size()),
        capped.maximumFrames,
        static_cast<float>(-12.0 * std::log2(capped.playbackRate))};
    capped.maximumRetainedBytes =
        singz::signalsmithTimePitchRetainedBytes(estimateConfig) - 1u;
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("song", wav));
    const auto result =
        session.prepare(std::move(capped), std::move(lanes), 43);
    CHECK(!result.ok &&
          result.error == singz::NativePlaybackError::LimitExceeded &&
          session.status().retainedBytes == 0);
    CHECK(session.unload(43).ok);
  }
  std::remove(wav.c_str());
}

void audibleProjectionWaitsForLatencyHistory() {
  const std::string wav = writeWav(
      "audible-projection.wav", 1, std::vector<float>(50000, 0.1F));
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  singz::NativePlaybackPrepareConfig request = config();
  request.playbackRate = 0.75;
  request.preparedStartProjectFrame = 19998;
  request.initialTransport.loop = singz::NativePlaybackInitialLoop{1000, 20000};
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("song", wav));
  CHECK(session.prepare(std::move(request), std::move(lanes), 44).ok);
  auto status = session.status();
  CHECK(status.timePitchAnchorsPrepared == 4 &&
        status.timePitchAnchorsPublished == 0 &&
        status.timePitchAnchorMisses == 0 &&
        status.timePitchReplacementReady && status.timePitchLoopPriming);
  CHECK(session.openOutput(44).ok);
  fake->setPresentationLatency(7, 11, 13);
  CHECK(session.start(44).ok);
  const auto driveFrames = [&](uint64_t frames) {
    while (frames != 0) {
      const uint32_t block =
          static_cast<uint32_t>(std::min<uint64_t>(frames, 512));
      CHECK(fake->drive(block));
      frames -= block;
    }
  };

  CHECK(fake->drive(4));
  status = session.status();
  CHECK(status.loopCount == 1 && status.renderedProjectFrame >= 1000 &&
        status.renderedProjectFrame < 20000 &&
        status.timePitchAnchorsPublished == 1 &&
        status.timePitchAnchorMisses == 0 && status.timePitchLoopPriming &&
        status.totalPresentationLatencyFrames ==
            status.graphLatencyFrames + 31 &&
        status.audibleProjectionQuality ==
            singz::NativePlaybackAudibleProjectionQuality::Unavailable);

  driveFrames(status.totalPresentationLatencyFrames);
  status = session.status();
  CHECK(status.audibleProjectionQuality ==
            singz::NativePlaybackAudibleProjectionQuality::Current &&
        status.audibleProjectFrame >= 1000 &&
        status.audibleProjectFrame < 20000);

  const uint64_t explicitAnchorsPublished = status.timePitchAnchorsPublished;
  const int64_t explicitProjectFrame = status.renderedProjectFrame;
  const uint64_t explicitContinuousFrame = status.continuousFrame;
  CHECK(session.reanchorTransport(44).ok && fake->drive(1));
  status = session.status();
  CHECK(status.lastTransportBoundary ==
            singz::NativePlaybackTransportBoundaryReason::ClockReanchored &&
        status.timePitchAnchorsPublished == explicitAnchorsPublished + 1 &&
        status.timePitchAnchorMisses == 0 &&
        status.renderedProjectFrame > explicitProjectFrame &&
        status.continuousFrame == explicitContinuousFrame + 1 &&
        status.audibleProjectionQuality ==
            singz::NativePlaybackAudibleProjectionQuality::Unavailable);
  driveFrames(status.totalPresentationLatencyFrames);
  status = session.status();
  CHECK(status.audibleProjectionQuality ==
        singz::NativePlaybackAudibleProjectionQuality::Current);

  const uint64_t routeAnchorsPublished = status.timePitchAnchorsPublished;
  const uint64_t routeContinuousFrame = status.continuousFrame;
  CHECK(session.reanchorTransport(44).ok);
  fake->reanchorRouteAndStream();
  CHECK(fake->drive(1));
  status = session.status();
  CHECK(status.lastTransportBoundary ==
            singz::NativePlaybackTransportBoundaryReason::
                RouteGenerationChanged &&
        status.timePitchAnchorsPublished == routeAnchorsPublished + 1 &&
        status.timePitchAnchorMisses == 0 &&
        status.continuousFrame == routeContinuousFrame + 1 &&
        status.audibleProjectionQuality ==
            singz::NativePlaybackAudibleProjectionQuality::Unavailable);
  driveFrames(status.totalPresentationLatencyFrames);
  CHECK(session.status().audibleProjectionQuality ==
        singz::NativePlaybackAudibleProjectionQuality::Current);

  status = session.status();
  const uint64_t streamAnchorsPublished = status.timePitchAnchorsPublished;
  const uint64_t streamContinuousFrame = status.continuousFrame;
  CHECK(session.reanchorTransport(44).ok);
  fake->advanceStreamIdentityOnly();
  CHECK(fake->drive(1));
  status = session.status();
  CHECK(status.lastTransportBoundary ==
            singz::NativePlaybackTransportBoundaryReason::ClockReanchored &&
        status.timePitchAnchorsPublished == streamAnchorsPublished + 1 &&
        status.timePitchAnchorMisses == 0 &&
        status.continuousFrame == streamContinuousFrame + 1);

  // Only the final positional command owns the coalesced one-shot boundary.
  // A trailing reanchor is primed at the newest queued seek, not at stale
  // telemetry from before either seek.
  uint64_t orderedPublished = status.timePitchAnchorsPublished;
  CHECK(session.seek(44, 1100).ok && session.seek(44, 1300).ok &&
        session.reanchorTransport(44).ok && fake->drive(2));
  status = session.status();
  CHECK(status.renderedProjectFrame == 1301 &&
        status.lastTransportBoundary ==
            singz::NativePlaybackTransportBoundaryReason::ClockReanchored &&
        status.timePitchAnchorsPublished == orderedPublished + 1 &&
        status.timePitchAnchorMisses == 0);

  // A seek after the reanchor is authoritative and publishes the prepared
  // seek engine even though the higher-priority clock reason is emitted.
  orderedPublished = status.timePitchAnchorsPublished;
  CHECK(session.reanchorTransport(44).ok && session.seek(44, 1500).ok &&
        fake->drive(2));
  status = session.status();
  CHECK(status.renderedProjectFrame == 1501 &&
        status.lastTransportBoundary ==
            singz::NativePlaybackTransportBoundaryReason::ClockReanchored &&
        status.timePitchAnchorsPublished == orderedPublished + 1 &&
        status.timePitchAnchorMisses == 0);

  // The same final-intent rule holds when a reanchor is between two seeks;
  // its unused generation-exact replacement is retired at the callback edge.
  orderedPublished = status.timePitchAnchorsPublished;
  CHECK(session.seek(44, 1600).ok && session.reanchorTransport(44).ok &&
        session.seek(44, 1700).ok && fake->drive(2));
  status = session.status();
  CHECK(status.renderedProjectFrame == 1701 &&
        status.lastTransportBoundary ==
            singz::NativePlaybackTransportBoundaryReason::ClockReanchored &&
        status.timePitchAnchorsPublished == orderedPublished + 1 &&
        status.timePitchAnchorMisses == 0);

  CHECK(session.seek(44, 19999).ok && fake->drive(2));
  status = session.status();
  CHECK(status.timePitchAnchorsPublished >= 2 &&
        status.timePitchAnchorMisses == 0 && status.cueEventsCompleted == 0);
  bool loopAnchorReady = status.timePitchReplacementReady;
  for (uint32_t attempt = 0; attempt < 200 && !loopAnchorReady; ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    loopAnchorReady = session.status().timePitchReplacementReady;
  }
  CHECK(loopAnchorReady && fake->drive(1));
  status = session.status();
  CHECK(status.loopCount >= 2 &&
        status.timePitchAnchorMisses == 0 &&
        status.audibleProjectionQuality ==
            singz::NativePlaybackAudibleProjectionQuality::Unavailable);
  CHECK(session.unload(44).ok);
  std::remove(wav.c_str());
}

void telemetryCollisionPublishesCoherentGeneration() {
  const std::string wav =
      writeWav("telemetry-collision.wav", 1, std::vector<float>(64, 0.1F));
  bool collide = true;
  singz::NativePlaybackTestHooks hooks{};
  hooks.context = &collide;
  hooks.forceTransportTelemetryCollision = forceTransportTelemetryCollision;
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend), &hooks);

  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("song", wav));
  CHECK(session.prepare(config(), std::move(lanes), 51).ok);
  auto status = session.status();
  CHECK(status.transportGeneration == 51 &&
        status.transportTelemetryQuality ==
            singz::NativePlaybackTransportTelemetryQuality::Initial &&
        status.transportState == singz::NativePlaybackTransportState::Stopped &&
        status.renderedProjectFrame == 0);

  collide = false;
  status = session.status();
  CHECK(status.transportGeneration == 51 &&
        status.transportTelemetryQuality ==
            singz::NativePlaybackTransportTelemetryQuality::Current);
  CHECK(session.openOutput(51).ok && session.start(51).ok &&
        fake->drive(5, singz::AudioHostDiscontinuityStart));
  status = session.status();
  CHECK(status.renderedProjectFrame == 5 && status.transportGeneration == 51 &&
        status.transportTelemetryQuality ==
            singz::NativePlaybackTransportTelemetryQuality::Current);
  CHECK(fake->drive(3));
  collide = true;
  status = session.status();
  CHECK(status.renderedProjectFrame == 5 && status.transportGeneration == 51 &&
        status.transportTelemetryQuality ==
            singz::NativePlaybackTransportTelemetryQuality::LastGood);
  collide = false;
  status = session.status();
  CHECK(status.renderedProjectFrame == 8 && status.transportGeneration == 51 &&
        status.transportTelemetryQuality ==
            singz::NativePlaybackTransportTelemetryQuality::Current);
  CHECK(session.unload(51).ok);

  // A reader cache from the retired generation is never reused for its
  // successor. Collision before generation 52's first sample yields that
  // generation's explicit initial snapshot instead.
  auto successorLanes = std::vector<singz::NativePlaybackLaneSource>{};
  successorLanes.push_back(lane("song", wav));
  CHECK(session.prepare(config(), std::move(successorLanes), 52).ok);
  collide = true;
  status = session.status();
  CHECK(status.transportGeneration == 52 &&
        status.transportTelemetryQuality ==
            singz::NativePlaybackTransportTelemetryQuality::Initial &&
        status.renderedProjectFrame == 0 &&
        status.transportState == singz::NativePlaybackTransportState::Stopped);
  CHECK(session.unload(52).ok);
  std::remove(wav.c_str());
}

void preparedStartOverridePreservesRebuildPosition() {
  constexpr int64_t kPreRoll = 19200;
  constexpr int64_t kFinalDuration = 20800;
  constexpr int64_t kUnequalFinalDuration = 30800;
  const std::string wav = writeWav("prepared-start-override.wav", 1,
                                   std::vector<float>(40000, 0.1F));
  const std::string longerWav = writeWav("prepared-start-override-longer.wav",
                                         1, std::vector<float>(50000, 0.2F));
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));

  const auto prepareAt = [&](uint64_t generation,
                             std::optional<int64_t> position,
                             bool unequalLanes = false) {
    singz::NativePlaybackPrepareConfig request = config();
    request.cuePlan = cueRequest(false, 1, 0.5);
    request.preparedStartProjectFrame = position;
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("song", wav));
    if (unequalLanes)
      lanes.push_back(lane("longer", longerWav));
    return session.prepare(std::move(request), std::move(lanes), generation);
  };

  CHECK(prepareAt(61, -9600).ok);
  auto status = session.status();
  CHECK(status.preRollFrames == kPreRoll &&
        status.preparedStartProjectFrame == -9600 &&
        status.renderedProjectFrame == -9600 &&
        status.remainingPreRollFrames == 9600 &&
        status.cueEventsCompleted == 1 && status.nextCueEventIndex == 1);
  CHECK(session.openOutput(61).ok && session.start(61).ok &&
        fake->drive(100, singz::AudioHostDiscontinuityStart));
  status = session.status();
  CHECK(status.renderedProjectFrame == -9500 &&
        status.remainingPreRollFrames == 9500 && status.seekCount == 0);
  CHECK(session.unload(61).ok);

  CHECK(prepareAt(62, 100).ok);
  status = session.status();
  CHECK(status.preparedStartProjectFrame == 100 &&
        status.renderedProjectFrame == 100 &&
        status.remainingPreRollFrames == 0 &&
        status.cueEventsCompleted == status.nextCueEventIndex);
  CHECK(session.openOutput(62).ok && session.start(62).ok && fake->drive(1));
  status = session.status();
  CHECK(status.renderedProjectFrame == 101 && status.seekCount == 0);
  CHECK(session.unload(62).ok);

  CHECK(prepareAt(63, std::nullopt).ok);
  status = session.status();
  CHECK(status.preparedStartProjectFrame == -kPreRoll &&
        status.renderedProjectFrame == -kPreRoll &&
        status.remainingPreRollFrames == static_cast<uint64_t>(kPreRoll));
  CHECK(session.unload(63).ok);

  // Cue preparation trims the entry offset from the raw source extent. The
  // final published duration is the rebuild bound, even though PCM continues
  // after that project frame.
  CHECK(prepareAt(64, kFinalDuration).ok);
  status = session.status();
  CHECK(status.durationFrames == static_cast<uint64_t>(kFinalDuration) &&
        status.preparedStartProjectFrame == kFinalDuration &&
        status.renderedProjectFrame == kFinalDuration);
  CHECK(session.unload(64).ok);
  CHECK(prepareAt(65, kFinalDuration + 1).error ==
        singz::NativePlaybackError::InvalidConfiguration);
  CHECK(session.unload(65).ok);

  CHECK(prepareAt(66, kUnequalFinalDuration, true).ok);
  status = session.status();
  CHECK(status.durationFrames == static_cast<uint64_t>(kUnequalFinalDuration) &&
        status.lanes.size() == 2 && status.lanes[0].totalFrames == 40000 &&
        status.lanes[1].totalFrames == 50000 &&
        status.preparedStartProjectFrame == kUnequalFinalDuration);
  CHECK(session.unload(66).ok);
  CHECK(prepareAt(67, kUnequalFinalDuration + 1, true).error ==
        singz::NativePlaybackError::InvalidConfiguration);
  CHECK(session.unload(67).ok);

  CHECK(prepareAt(68, -kPreRoll - 1).error ==
        singz::NativePlaybackError::InvalidConfiguration);
  CHECK(session.unload(68).ok);
  std::remove(wav.c_str());
  std::remove(longerWav.c_str());
}

void preparedInitialTransportIsAtomicAtFirstCallback() {
  std::vector<float> ramp(64);
  for (size_t frame = 0; frame < ramp.size(); ++frame)
    ramp[frame] = static_cast<float>(frame + 1) / 100.0F;
  const std::string wav =
      writeWav("prepared-initial-transport.wav", 1, ramp);
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));

  const auto prepare = [&](uint64_t generation, int64_t start, bool paused,
                           int64_t loopStart, int64_t loopEnd) {
    singz::NativePlaybackPrepareConfig request = config();
    request.preparedStartProjectFrame = start;
    request.initialTransport.startPaused = paused;
    request.initialTransport.loop =
        singz::NativePlaybackInitialLoop{loopStart, loopEnd};
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("song", wav));
    return session.prepare(std::move(request), std::move(lanes), generation);
  };

  // A paused replacement graph starts its provider so ownership is real, but
  // the very first callback observes pause + loop + exact project position.
  // It cannot emit or advance a transient block while JS restores commands.
  CHECK(prepare(71, 10, true, 8, 16).ok);
  CHECK(session.openOutput(71).ok && session.start(71).ok);
  fake->captureOutput = true;
  fake->outputTrace.clear();
  CHECK(fake->drive(8, singz::AudioHostDiscontinuityStart));
  fake->captureOutput = false;
  CHECK(fake->outputTrace.size() == 8);
  for (const float sample : fake->outputTrace)
    CHECK(sample == 0.0F);
  auto status = session.status();
  CHECK(status.transportState == singz::NativePlaybackTransportState::Paused &&
        status.renderedProjectFrame == 10 && status.loopEnabled &&
        status.loopStartFrame == 8 && status.loopEndFrame == 16 &&
        status.lanes.size() == 1 && status.lanes[0].cursorFrames == 0);
  CHECK(session.unload(71).ok);

  // Playing replacement starts two frames before loop B. The loop is part of
  // the Start command, so the same first hardware callback wraps to A instead
  // of leaking frames 16+ before a later control message arrives.
  CHECK(prepare(72, 14, false, 8, 16).ok);
  CHECK(session.openOutput(72).ok && session.start(72).ok);
  fake->captureOutput = true;
  fake->outputTrace.clear();
  CHECK(fake->drive(6, singz::AudioHostDiscontinuityStart));
  fake->captureOutput = false;
  const std::array<size_t, 6> expectedFrames{14, 15, 8, 9, 10, 11};
  CHECK(fake->outputTrace.size() == expectedFrames.size());
  for (size_t index = 0; index < expectedFrames.size(); ++index)
    CHECK(near(fake->outputTrace[index],
               pcm16(ramp[expectedFrames[index]])));
  status = session.status();
  CHECK(status.transportState ==
            singz::NativePlaybackTransportState::Playing &&
        status.renderedProjectFrame == 12 && status.loopEnabled &&
        status.loopStartFrame == 8 && status.loopEndFrame == 16 &&
        status.loopCount == 1);
  CHECK(session.unload(72).ok);

  // Restored loop state is also the control-domain truth before callback one.
  // Clearing it between Start and that callback must not no-op.
  CHECK(prepare(73, 14, false, 8, 16).ok);
  CHECK(session.openOutput(73).ok && session.start(73).ok &&
        session.clearLoop(73).ok);
  fake->captureOutput = true;
  fake->outputTrace.clear();
  CHECK(fake->drive(6, singz::AudioHostDiscontinuityStart));
  fake->captureOutput = false;
  CHECK(fake->outputTrace.size() == 6);
  for (size_t index = 0; index < 6; ++index)
    CHECK(near(fake->outputTrace[index], pcm16(ramp[14 + index])));
  status = session.status();
  CHECK(!status.loopEnabled && status.renderedProjectFrame == 20 &&
        status.loopCount == 0);
  CHECK(session.unload(73).ok);

  // A seek queued against the same restored loop resolves modulo that loop,
  // even though the callback has not installed the Start command yet.
  CHECK(prepare(74, 14, false, 8, 16).ok);
  CHECK(session.openOutput(74).ok && session.start(74).ok &&
        session.seek(74, 18).ok);
  fake->captureOutput = true;
  fake->outputTrace.clear();
  CHECK(fake->drive(4));
  fake->captureOutput = false;
  CHECK(fake->outputTrace.size() == 4);
  for (size_t index = 0; index < 4; ++index)
    CHECK(near(fake->outputTrace[index], pcm16(ramp[10 + index])));
  status = session.status();
  CHECK(status.loopEnabled && status.renderedProjectFrame == 14 &&
        status.seekCount == 1 && status.loopCount == 0);
  CHECK(session.unload(74).ok);

  CHECK(prepare(75, 10, false, 8, 65).error ==
        singz::NativePlaybackError::InvalidConfiguration);
  CHECK(session.unload(75).ok);
  std::remove(wav.c_str());
}

void publicationAndCancellation() {
  const std::string wav =
      writeWav("publication.wav", 1, std::vector<float>(64, 0.1F));
  {
    PublicationLatch latch;
    singz::NativePlaybackTestHooks hooks{blockPublication, &latch};
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend), &hooks);
    CHECK(session.claimGeneration(1));
    singz::NativePlaybackResult prepareResult;
    std::thread preparing([&] {
      auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
      lanes.push_back(lane("a", wav));
      prepareResult = session.prepare(config(), std::move(lanes), 1);
    });
    waitUntilReady(&latch);
    CHECK(session.claimGeneration(2));
    releasePublication(&latch);
    preparing.join();
    CHECK(prepareResult.error == singz::NativePlaybackError::Cancelled &&
          session.status().state == singz::NativePlaybackState::Unloaded &&
          fake->enumerations == 0 && fake->opens == 0);
    CHECK(session.unload(1).ok && session.unload(1).ok);

    latch.enabled = false;
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 2).ok);
    CHECK(session.claimGeneration(3));
    CHECK(session.openOutput(2).error ==
          singz::NativePlaybackError::InvalidGeneration);
    CHECK(session.start(2).error ==
          singz::NativePlaybackError::InvalidGeneration);
    CHECK(session.setMasterGain(2, 0.5F).error ==
          singz::NativePlaybackError::InvalidGeneration);
    CHECK(session.stop(2).ok);
    CHECK(session.unload(2).ok);
    auto replacement = std::vector<singz::NativePlaybackLaneSource>{};
    replacement.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(replacement), 3).ok);
    CHECK(session.unload(3).ok);
  }
  for (bool unload : {false, true}) {
    PublicationLatch latch;
    singz::NativePlaybackTestHooks hooks{blockPublication, &latch};
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend), &hooks);
    CHECK(session.claimGeneration(1));
    singz::NativePlaybackResult prepareResult;
    std::thread preparing([&] {
      auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
      lanes.push_back(lane("a", wav));
      prepareResult = session.prepare(config(), std::move(lanes), 1);
    });
    waitUntilReady(&latch);
    const singz::NativePlaybackResult cancelResult =
        unload ? session.unload(1) : session.stop(1);
    CHECK(cancelResult.ok);
    releasePublication(&latch);
    preparing.join();
    CHECK(prepareResult.error == singz::NativePlaybackError::Cancelled &&
          fake->enumerations == 0 && fake->opens == 0);
    CHECK((unload ? session.unload(1) : session.stop(1)).ok);
    if (!unload)
      CHECK(session.unload(1).ok);
  }
  {
    StaleTeardownLatch latch;
    singz::NativePlaybackTestHooks hooks{blockStaleTeardown, &latch};
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend), &hooks);
    auto observerBackend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession observer(std::move(observerBackend));
    CHECK(session.claimGeneration(1));
    singz::NativePlaybackResult result;
    std::thread preparing([&] {
      auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
      lanes.push_back(lane("a", wav));
      result = session.prepare(config(), std::move(lanes), 1);
    });
    waitStaleLatch(&latch, true);
    CHECK(session.claimGeneration(2));
    releaseStaleLatch(&latch, true);
    waitStaleLatch(&latch, false);

    CHECK(session.unload(1).ok);
    const auto retiringProof = session.cleanupProof(1);
    CHECK(
        retiringProof.safety == singz::NativePlaybackCleanupSafety::Uncertain &&
        retiringProof.error == singz::NativePlaybackError::TeardownUncertain &&
        retiringProof.retainedBytes != 0 &&
        retiringProof.processQuarantineReserved &&
        retiringProof.processQuarantineRetainedBytes != 0 &&
        !retiringProof.globallyComplete());

    auto blockedLanes = std::vector<singz::NativePlaybackLaneSource>{};
    blockedLanes.push_back(lane("blocked", wav));
    CHECK(observer.prepare(config(), std::move(blockedLanes), 1).error ==
          singz::NativePlaybackError::ResourceExhausted);
    CHECK(observer.unload(1).error ==
              singz::NativePlaybackError::InvalidGeneration &&
          observer.cleanupProof(1).safety ==
              singz::NativePlaybackCleanupSafety::NotOwned &&
          !observer.cleanupProof(1).globallyComplete());

    std::atomic<bool> claimReturned{false};
    bool claimed = false;
    std::thread thirdClaim([&] {
      claimed = session.claimGeneration(3);
      claimReturned.store(true, std::memory_order_release);
    });
    for (uint32_t attempt = 0;
         attempt < 200 && !claimReturned.load(std::memory_order_acquire);
         ++attempt) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    const bool advancedBeforeTeardownRelease =
        claimReturned.load(std::memory_order_acquire);
    auto newerLanes = std::vector<singz::NativePlaybackLaneSource>{};
    newerLanes.push_back(lane("newer", wav));
    CHECK(session.prepare(config(), std::move(newerLanes), 3).error ==
          singz::NativePlaybackError::InvalidState);
    releaseStaleLatch(&latch, false);
    thirdClaim.join();
    preparing.join();
    CHECK(advancedBeforeTeardownRelease && claimed &&
          result.error == singz::NativePlaybackError::Cancelled);
    CHECK(session.cleanupProof(1).safety ==
              singz::NativePlaybackCleanupSafety::NotOwned &&
          observer.cleanupProof(1).safety ==
              singz::NativePlaybackCleanupSafety::NotOwned &&
          session.unload(1).ok);
  }
  std::remove(wav.c_str());
}

void callbackTerminalLatch() {
  zdsp::AudioHostGraphAdapter adapter{};
  singz::NativePlaybackCallbackState callback;
  callback.adapter = &adapter;
  std::array<float, 8> left{};
  std::array<float, 8> right{};
  float *output[]{left.data(), right.data()};
  singz::AudioHostRenderBlock block{
      nullptr, output, 0,     2,     8, 8, 48000.0, 1,    1, 1, 0,
      0,       0,      false, false, 0, 0, true,    true, 0, 0, true};
  std::fill(left.begin(), left.end(), 1.0F);
  std::fill(right.begin(), right.end(), 1.0F);
  CHECK(!singz::nativePlaybackRender(&callback, block));
  CHECK(callback.firstTerminalCause.current().reason ==
            singz::AudioHostTerminalReason::ProviderFailure &&
        adapter.renderFailures.load(std::memory_order_relaxed) == 1 &&
        std::all_of(left.begin(), left.end(),
                    [](float sample) { return sample == 0.0F; }));
  std::fill(left.begin(), left.end(), 1.0F);
  CHECK(!singz::nativePlaybackRender(&callback, block));
  CHECK(adapter.renderFailures.load(std::memory_order_relaxed) == 1 &&
        callback.terminalFailures.load(std::memory_order_relaxed) >= 2 &&
        std::all_of(left.begin(), left.end(),
                    [](float sample) { return sample == 0.0F; }));
}

void outputClampAndStartLinearization() {
  const std::string wav =
      writeWav("start-linearization.wav", 1, std::vector<float>(256, 0.25F));
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    fake->actualMaximumFrames = 128;
    fake->actualNominalBufferFrames = 128;
    singz::NativePlaybackSession session(std::move(backend));
    singz::NativePlaybackPrepareConfig large = config();
    large.maximumFrames = 1024;
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(large, std::move(lanes), 1).ok);
    singz::NativePlaybackDeliveryToken token;
    const auto opened = session.openOutput(1, &token);
    CHECK(opened.ok && opened.format.maximumFrames == 128 &&
          opened.format.nominalBufferFrames == 128);
    const auto openedStatus = session.status();
    CHECK(openedStatus.host.format.maximumFrames == 128 &&
          openedStatus.host.format.nominalBufferFrames == 128);
    CHECK(session.start(1).ok && fake->drive(128));
    CHECK(session.stop(1).ok && session.unload(1).ok);
  }
  for (bool claimNewGeneration : {false, true}) {
    StartLatch latch;
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    fake->startLatch = &latch;
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    CHECK(session.openOutput(1).ok);
    singz::NativePlaybackResult started;
    std::thread starting([&] { started = session.start(1); });
    waitUntilStartEntered(&latch);
    if (claimNewGeneration)
      CHECK(session.claimGeneration(2));
    else
      CHECK(session.requestCancellation(1));
    releaseStart(&latch);
    starting.join();
    CHECK(started.error == singz::NativePlaybackError::Cancelled &&
          started.state == singz::NativePlaybackState::Stopped &&
          session.status().state == singz::NativePlaybackState::Stopped);
    CHECK(!fake->drive(16) && fake->left[0] == 0.0F &&
          session.status().renderedFrames == 0);
    CHECK(session.stop(1).ok && session.unload(1).ok);
    if (claimNewGeneration) {
      auto replacement = std::vector<singz::NativePlaybackLaneSource>{};
      replacement.push_back(lane("a", wav));
      CHECK(session.prepare(config(), std::move(replacement), 2).ok);
      CHECK(session.unload(2).ok);
    }
  }
  {
    StartLatch latch;
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    fake->startLatch = &latch;
    fake->graphTerminalDuringStop = true;
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    CHECK(session.openOutput(1).ok);
    singz::NativePlaybackResult result;
    std::thread starting([&] { result = session.start(1); });
    waitUntilStartEntered(&latch);
    CHECK(session.requestCancellation(1));
    releaseStart(&latch);
    starting.join();
    const auto stopped = session.status();
    CHECK(!result.ok && result.error == singz::NativePlaybackError::Cancelled &&
          result.state == singz::NativePlaybackState::Terminal &&
          stopped.state == result.state &&
          stopped.terminalReason ==
              singz::AudioHostTerminalReason::RouteChanged);
    CHECK(!fake->drive(16));
    CHECK(session.unload(1).ok);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    fake->throwStart = true;
    fake->providerTerminalDuringStop = true;
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    CHECK(session.openOutput(1).ok);
    const auto result = session.start(1);
    const auto stopped = session.status();
    CHECK(!result.ok &&
          result.error == singz::NativePlaybackError::ProviderFailure &&
          result.state == singz::NativePlaybackState::Terminal &&
          stopped.state == result.state &&
          stopped.terminalReason ==
              singz::AudioHostTerminalReason::Interrupted);
    CHECK(!fake->drive(16));
    CHECK(session.unload(1).ok);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    fake->renderTerminalDuringStart = true;
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    CHECK(session.openOutput(1).ok);
    const auto started = session.start(1);
    CHECK(!started.ok &&
          started.error == singz::NativePlaybackError::ProviderFailure &&
          started.state == singz::NativePlaybackState::Terminal &&
          session.status().terminalRenderFailures == 1);
    CHECK(!fake->drive(16) && fake->left[0] == 0.0F &&
          session.status().renderedFrames == 0);
    CHECK(session.unload(1).ok);
  }
  {
    PublicationLatch latch;
    singz::NativePlaybackTestHooks hooks{blockProvisionalStart, &latch};
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend), &hooks);
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    CHECK(session.openOutput(1).ok);
    singz::NativePlaybackResult result;
    std::thread starting([&] { result = session.start(1); });
    waitUntilReady(&latch);
    fake->setGraphTerminal(singz::AudioHostTerminalReason::RouteChanged);
    releasePublication(&latch);
    starting.join();
    CHECK(!result.ok &&
          result.error == singz::NativePlaybackError::ProviderFailure &&
          result.state == singz::NativePlaybackState::Terminal &&
          session.status().state == singz::NativePlaybackState::Terminal &&
          fake->stops == 1 && !fake->drive(16));
    CHECK(session.unload(1).ok);
  }
  std::remove(wav.c_str());
}

void preparedGenerationResetsHostTelemetry() {
  const std::string wav =
      writeWav("telemetry-reset.wav", 1, std::vector<float>(128, 0.15F));
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  auto first = std::vector<singz::NativePlaybackLaneSource>{};
  first.push_back(lane("a", wav));
  CHECK(session.prepare(config(), std::move(first), 1).ok);
  CHECK(session.openOutput(1).ok && session.start(1).ok);
  CHECK(fake->drive(32, singz::AudioHostDiscontinuityStart));
  fake->injectHostDiagnostics();
  const auto previous = session.status();
  CHECK(previous.host.streamGeneration != 0 && previous.host.callbacks != 0 &&
        previous.host.renderedFrames != 0 && previous.host.xruns != 0 &&
        previous.host.deadlineMisses != 0 &&
        previous.host.discontinuities != 0 &&
        previous.host.renderFailures != 0);
  CHECK(session.unload(1).ok);

  auto second = std::vector<singz::NativePlaybackLaneSource>{};
  second.push_back(lane("a", wav));
  CHECK(session.prepare(config(), std::move(second), 2).ok);
  const auto fresh = session.status();
  CHECK(fresh.state == singz::NativePlaybackState::Prepared &&
        fresh.generation == 2 &&
        fresh.host.state == singz::AudioHostState::Closed &&
        fresh.host.format.nominalBufferFrames == 0 &&
        fresh.host.latency.inputDeviceFrames == 0 &&
        fresh.host.latency.outputDeviceFrames == 0 &&
        fresh.host.latency.bufferFrames == 0 &&
        fresh.host.latency.externalRouteFrames == 0 &&
        fresh.host.streamGeneration == 0 && fresh.host.callbacks == 0 &&
        fresh.host.renderedFrames == 0 && fresh.host.xruns == 0 &&
        fresh.host.deadlineMisses == 0 && fresh.host.discontinuities == 0 &&
        fresh.host.renderFailures == 0 && fresh.renderedFrames == 0 &&
        fresh.audibleFrames == 0);
  CHECK(session.unload(2).ok);
  std::remove(wav.c_str());
}

void resourceAndAggregateBoundaries() {
  const std::string wav =
      writeWav("resource-boundary.wav", 1, std::vector<float>(64, 0.1F));
  for (const auto point :
       {singz::NativePlaybackAllocationPoint::AfterDecode,
        singz::NativePlaybackAllocationPoint::AfterArena,
        singz::NativePlaybackAllocationPoint::AfterGraphCompile}) {
    AllocationFault fault{point,
                          singz::NativePlaybackInjectedFailure::BadAllocation};
    singz::NativePlaybackTestHooks hooks{nullptr, &fault,
                                         injectAllocationFailure};
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend), &hooks);
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    const auto result = session.prepare(config(), std::move(lanes), 1);
    CHECK(result.error == singz::NativePlaybackError::ResourceExhausted &&
          result.state == singz::NativePlaybackState::Unloaded &&
          session.status().retainedBytes == 0 && fake->opens == 0 &&
          fake->starts == 0);
    CHECK(session.unload(1).ok && session.unload(1).ok);
  }
  {
    AllocationFault fault{
        singz::NativePlaybackAllocationPoint::AfterGraphCompile,
        singz::NativePlaybackInjectedFailure::Unexpected};
    singz::NativePlaybackTestHooks hooks{nullptr, &fault,
                                         injectAllocationFailure};
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend), &hooks);
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).error ==
          singz::NativePlaybackError::GraphFailure);
    CHECK(session.status().state == singz::NativePlaybackState::Unloaded &&
          session.status().retainedBytes == 0);
    CHECK(session.unload(1).ok);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    auto exact = config();
    exact.maximumRetainedBytes = 64u * sizeof(float);
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    lanes.push_back(lane("b", wav));
    const auto result = session.prepare(exact, std::move(lanes), 1);
    CHECK(result.error == singz::NativePlaybackError::LimitExceeded &&
          result.state == singz::NativePlaybackState::Unloaded &&
          session.status().retainedBytes == 0 && fake->enumerations == 0 &&
          fake->opens == 0);
    CHECK(session.unload(1).ok);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    fake->throwOpen = true;
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    const auto result = session.openOutput(1);
    CHECK(result.error == singz::NativePlaybackError::ProviderFailure &&
          result.state == singz::NativePlaybackState::Prepared &&
          session.status().retainedBytes != 0);
    CHECK(session.unload(1).ok);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    fake->throwStart = true;
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    CHECK(session.openOutput(1).ok);
    const auto result = session.start(1);
    CHECK(result.error == singz::NativePlaybackError::ProviderFailure &&
          result.state == singz::NativePlaybackState::Stopped &&
          !fake->drive(16));
    CHECK(session.unload(1).ok);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    auto invalid = config();
    invalid.outputChannels = {singz::kAudioHostMaxChannels};
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    const auto result = session.prepare(invalid, std::move(lanes), 1);
    CHECK(result.error == singz::NativePlaybackError::InvalidConfiguration &&
          session.status().retainedBytes == 0 && fake->enumerations == 0 &&
          fake->opens == 0 && fake->starts == 0);
    CHECK(session.unload(1).ok);
  }
  CHECK(std::string(singz::nativePlaybackErrorName(
            singz::NativePlaybackError::ResourceExhausted)) ==
        "resource-exhausted");
  std::remove(wav.c_str());
}

void admittedDescriptorFailureCleansUp() {
  const std::string wav =
      writeWav("descriptor-admission.wav", 1, std::vector<float>(32, 0.1F));
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  CHECK(session.claimGeneration(1));
  const auto failure = session.failPrepareAdmission(
      1, singz::NativePlaybackError::DecodeFailure);
  CHECK(!failure.ok &&
        failure.error == singz::NativePlaybackError::DecodeFailure &&
        failure.state == singz::NativePlaybackState::Unloaded &&
        session.status().retainedBytes == 0 && fake->opens == 0);
  const auto cleanup = session.abortPrepareDelivery(1);
  CHECK(cleanup.safety == singz::NativePlaybackCleanupSafety::Complete &&
        cleanup.globallyComplete() && cleanup.retainedBytes == 0 &&
        cleanup.handoffLease != 0 && session.unload(1).ok &&
        session.unload(1).ok);
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("a", wav));
  auto reentry = config();
  reentry.handoffLease = cleanup.handoffLease;
  CHECK(session.prepare(reentry, std::move(lanes), 2).ok);
  CHECK(session.unload(2).ok);
  std::remove(wav.c_str());
}

void preconditionExceptionsDoNotRollbackActivePlayback() {
  const std::string wav =
      writeWav("precondition-exception.wav", 1, std::vector<float>(128, 0.2F));
  AllocationFault fault;
  singz::NativePlaybackTestHooks hooks{nullptr, &fault,
                                       injectAllocationFailure};
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend), &hooks);
  auto first = std::vector<singz::NativePlaybackLaneSource>{};
  first.push_back(lane("a", wav));
  CHECK(session.prepare(config(), std::move(first), 1).ok);

  fault = {singz::NativePlaybackAllocationPoint::PreparePreconditionResult,
           singz::NativePlaybackInjectedFailure::BadAllocation, 0};
  auto repeated = std::vector<singz::NativePlaybackLaneSource>{};
  repeated.push_back(lane("b", wav));
  CHECK(session.prepare(config(), std::move(repeated), 1).error ==
        singz::NativePlaybackError::ResourceExhausted);
  CHECK(session.status().state == singz::NativePlaybackState::Prepared &&
        session.status().retainedBytes != 0 && fake->stops == 0);

  CHECK(session.openOutput(1).ok);
  for (auto injected : {singz::NativePlaybackInjectedFailure::BadAllocation,
                        singz::NativePlaybackInjectedFailure::Unexpected}) {
    fault = {singz::NativePlaybackAllocationPoint::OpenPreconditionResult,
             injected, 0};
    const auto result = session.openOutput(1);
    CHECK(result.error ==
          (injected == singz::NativePlaybackInjectedFailure::BadAllocation
               ? singz::NativePlaybackError::ResourceExhausted
               : singz::NativePlaybackError::ProviderFailure));
    CHECK(session.status().state == singz::NativePlaybackState::OutputOpen &&
          fake->stops == 0 && fake->opens == 1);
  }

  CHECK(session.start(1).ok);
  for (auto injected : {singz::NativePlaybackInjectedFailure::BadAllocation,
                        singz::NativePlaybackInjectedFailure::Unexpected}) {
    fault = {singz::NativePlaybackAllocationPoint::StartPreconditionResult,
             injected, 0};
    const auto result = session.start(1);
    CHECK(result.error ==
          (injected == singz::NativePlaybackInjectedFailure::BadAllocation
               ? singz::NativePlaybackError::ResourceExhausted
               : singz::NativePlaybackError::ProviderFailure));
    CHECK(session.status().state == singz::NativePlaybackState::Running &&
          fake->starts == 1 && fake->stops == 0 && fake->drive(8));
  }
  CHECK(session.unload(1).ok);
  std::remove(wav.c_str());
}

void terminalFirstCauseAndPhysicalQuiescence() {
  const std::string wav =
      writeWav("terminal-first-cause.wav", 1, std::vector<float>(64, 0.1F));
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    CHECK(session.openOutput(1).ok && session.start(1).ok);
    fake->setTerminal(singz::AudioHostTerminalReason::RouteChanged);
    CHECK(session.status().terminalReason ==
          singz::AudioHostTerminalReason::RouteChanged);
    fake->setTerminal(singz::AudioHostTerminalReason::MediaServicesLost);
    CHECK(session.status().terminalReason ==
          singz::AudioHostTerminalReason::RouteChanged);
    const auto stopped = session.stop(1);
    CHECK(stopped.ok && stopped.state == singz::NativePlaybackState::Terminal &&
          session.status().state == singz::NativePlaybackState::Terminal &&
          session.status().terminalReason ==
              singz::AudioHostTerminalReason::RouteChanged);
    CHECK(session.unload(1).ok);
    CHECK(session.status().state == singz::NativePlaybackState::Unloaded &&
          session.status().retainedBytes == 0 &&
          session.status().terminalReason ==
              singz::AudioHostTerminalReason::RouteChanged);

    auto next = std::vector<singz::NativePlaybackLaneSource>{};
    next.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(next), 2).ok);
    CHECK(session.status().terminalReason ==
          singz::AudioHostTerminalReason::None);
    CHECK(session.openOutput(2).ok);
    CHECK(session.status().terminalReason ==
          singz::AudioHostTerminalReason::None);
    CHECK(session.unload(2).ok);
  }

  // Independent graph and provider domains retain the publication-time
  // winner even when neither cause is sampled until both have arrived.
  for (const bool graphFirst : {true, false}) {
    auto orderedBackend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *ordered = orderedBackend.get();
    singz::NativePlaybackSession orderedSession(std::move(orderedBackend));
    auto orderedLanes = std::vector<singz::NativePlaybackLaneSource>{};
    orderedLanes.push_back(lane("a", wav));
    CHECK(orderedSession.prepare(config(), std::move(orderedLanes), 1).ok);
    CHECK(orderedSession.openOutput(1).ok && orderedSession.start(1).ok);
    if (graphFirst) {
      ordered->setGraphTerminal(singz::AudioHostTerminalReason::RouteChanged);
      ordered->setTerminal(singz::AudioHostTerminalReason::MediaServicesLost);
    } else {
      ordered->setTerminal(singz::AudioHostTerminalReason::Interrupted);
      ordered->setGraphTerminal(
          singz::AudioHostTerminalReason::ProviderFailure);
    }
    const auto orderedStatus = orderedSession.status();
    CHECK(orderedStatus.terminalReason ==
          (graphFirst ? singz::AudioHostTerminalReason::RouteChanged
                      : singz::AudioHostTerminalReason::Interrupted));
    CHECK(orderedSession.stop(1).state == singz::NativePlaybackState::Terminal);
    CHECK(orderedSession.unload(1).ok &&
          orderedSession.status().retainedBytes == 0 &&
          orderedSession.status().terminalReason ==
              orderedStatus.terminalReason);
  }
  std::remove(wav.c_str());
}

void openExceptionAndFinalStopCause() {
  const std::string wav =
      writeWav("open-stop-final-cause.wav", 1, std::vector<float>(64, 0.1F));
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    fake->throwOpenAfterHiddenMutation = true;
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    singz::NativePlaybackDeliveryToken token;
    const auto opened = session.openOutput(1, &token);
    CHECK(!opened.ok &&
          opened.error == singz::NativePlaybackError::ProviderFailure &&
          opened.state == singz::NativePlaybackState::Prepared &&
          fake->opens == 1 && fake->stops == 1 && !fake->hiddenOpenResources &&
          token.valid() && session.acknowledgeDelivery(token));
    CHECK(session.unload(1).ok && !fake->hiddenOpenResources);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    fake->throwStartAfterHiddenMutation = true;
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    CHECK(session.openOutput(1).ok);
    singz::NativePlaybackDeliveryToken token;
    const auto started = session.start(1, &token);
    CHECK(!started.ok &&
          started.error == singz::NativePlaybackError::ProviderFailure &&
          started.state == singz::NativePlaybackState::Stopped &&
          fake->starts == 1 && fake->stops == 1 &&
          !fake->hiddenStartResources && !fake->drive(16) && token.valid() &&
          session.acknowledgeDelivery(token));
    CHECK(session.unload(1).ok && !fake->hiddenStartResources);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    fake->graphTerminalDuringStop = true;
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    CHECK(session.openOutput(1).ok && session.start(1).ok);
    CHECK(session.unload(1).ok);
    const auto unloaded = session.status();
    CHECK(unloaded.state == singz::NativePlaybackState::Unloaded &&
          unloaded.retainedBytes == 0 &&
          unloaded.terminalReason ==
              singz::AudioHostTerminalReason::RouteChanged);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    auto first = std::vector<singz::NativePlaybackLaneSource>{};
    first.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(first), 1).ok);
    CHECK(session.openOutput(1).ok && session.start(1).ok);
    fake->setTerminal(singz::AudioHostTerminalReason::RouteChanged);
    CHECK(session.unload(1).ok);
    auto second = std::vector<singz::NativePlaybackLaneSource>{};
    second.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(second), 2).ok);
    fake->failOpen = true;
    CHECK(session.openOutput(2).error ==
          singz::NativePlaybackError::HostFailure);
    const auto failed = session.status();
    CHECK(failed.state == singz::NativePlaybackState::Prepared &&
          failed.terminalReason ==
              singz::AudioHostTerminalReason::ProviderFailure);
    CHECK(session.unload(2).ok);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    auto first = std::vector<singz::NativePlaybackLaneSource>{};
    first.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(first), 1).ok);
    CHECK(session.unload(1).ok);

    // Generation 2 fails after reserving the mandatory bounded-quarantine
    // slot. Its exact unload handshake is global ownership even though public
    // state is Unloaded and retained decoded bytes are zero. Cleaning an old
    // already-unloaded generation must neither claim global completeness nor
    // consume generation 2's reservation/handshake.
    auto invalid = config();
    invalid.outputDeviceUid.clear();
    auto second = std::vector<singz::NativePlaybackLaneSource>{};
    second.push_back(lane("a", wav));
    const auto failed =
        session.prepare(std::move(invalid), std::move(second), 2);
    CHECK(!failed.ok &&
          failed.error == singz::NativePlaybackError::InvalidConfiguration &&
          failed.state == singz::NativePlaybackState::Unloaded);
    const uint32_t stopsBefore = fake->stops;
    const auto oldCleanup = session.abortPrepareDelivery(1);
    CHECK(oldCleanup.safety == singz::NativePlaybackCleanupSafety::NotOwned &&
          oldCleanup.state == singz::NativePlaybackState::Unloaded &&
          oldCleanup.retainedBytes == 0 &&
          !oldCleanup.physicalOwnershipRetained &&
          !oldCleanup.globallyComplete() && fake->stops == stopsBefore);
    CHECK(session.unload(2).ok && session.unload(2).ok &&
          session.status().state == singz::NativePlaybackState::Unloaded &&
          session.status().retainedBytes == 0);
  }
  std::remove(wav.c_str());
}

void bridgeMutationDeliveryCleanup() {
  const std::string wav =
      writeWav("bridge-delivery-cleanup.wav", 1, std::vector<float>(64, 0.1F));
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    singz::NativePlaybackDeliveryToken invalid;
    const auto notOwned = session.abortDelivery(invalid);
    CHECK(notOwned.safety == singz::NativePlaybackCleanupSafety::NotOwned &&
          !notOwned.globallyComplete());
    CHECK(session.status().state == singz::NativePlaybackState::Prepared &&
          session.status().retainedBytes != 0 && fake->stops == 0);
    singz::NativePlaybackDeliveryToken token;
    CHECK(session.openOutput(1, &token).ok && token.valid());
    const singz::NativePlaybackDeliveryToken wrong{
        token.generation, token.serial,
        singz::NativePlaybackDeliveryCommand::Start};
    CHECK(session.abortDelivery(wrong).safety ==
          singz::NativePlaybackCleanupSafety::NotOwned);
    CHECK(session.status().state == singz::NativePlaybackState::OutputOpen &&
          fake->stops == 0);
    const auto cleanup = session.abortDelivery(token);
    CHECK(cleanup.safety == singz::NativePlaybackCleanupSafety::Complete &&
          cleanup.error == singz::NativePlaybackError::None &&
          cleanup.retainedBytes == 0 && cleanup.globallyComplete());
    const auto cleaned = session.status();
    CHECK(cleaned.state == singz::NativePlaybackState::Unloaded &&
          cleaned.retainedBytes == 0 && fake->stops == 1 && !fake->drive(16));
    CHECK(session.claimGeneration(2, cleanup.handoffLease).ok &&
          session.unload(2).ok);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    singz::NativePlaybackDeliveryToken openToken;
    CHECK(session.openOutput(1, &openToken).ok &&
          session.acknowledgeDelivery(openToken));
    const auto acknowledgedOpen = session.abortDelivery(openToken);
    CHECK(acknowledgedOpen.safety ==
              singz::NativePlaybackCleanupSafety::NotOwned &&
          acknowledgedOpen.state == singz::NativePlaybackState::OutputOpen &&
          acknowledgedOpen.retainedBytes != 0 &&
          acknowledgedOpen.physicalOwnershipRetained &&
          !acknowledgedOpen.globallyComplete());
    CHECK(session.status().state == singz::NativePlaybackState::OutputOpen &&
          session.status().retainedBytes != 0 && fake->stops == 0);
    singz::NativePlaybackDeliveryToken startToken;
    CHECK(session.start(1, &startToken).ok && startToken.valid());
    const auto cleanup = session.abortDelivery(startToken);
    CHECK(cleanup.safety == singz::NativePlaybackCleanupSafety::Complete &&
          cleanup.retainedBytes == 0 && cleanup.globallyComplete());
    const auto cleaned = session.status();
    CHECK(cleaned.state == singz::NativePlaybackState::Unloaded &&
          cleaned.retainedBytes == 0 && fake->stops == 1 && !fake->drive(16));
    CHECK(session.claimGeneration(2, cleanup.handoffLease).ok &&
          session.unload(2).ok);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    singz::NativePlaybackDeliveryToken openToken;
    CHECK(session.openOutput(1, &openToken).ok &&
          session.acknowledgeDelivery(openToken));
    singz::NativePlaybackDeliveryToken duplicateOpen{
        9, 9, singz::NativePlaybackDeliveryCommand::OpenOutput};
    const auto duplicateOpenResult = session.openOutput(1, &duplicateOpen);
    CHECK(!duplicateOpenResult.ok && !duplicateOpen.valid() &&
          session.abortDelivery(duplicateOpen).safety ==
              singz::NativePlaybackCleanupSafety::NotOwned &&
          session.status().state == singz::NativePlaybackState::OutputOpen &&
          fake->stops == 0);

    singz::NativePlaybackDeliveryToken startToken;
    CHECK(session.start(1, &startToken).ok &&
          session.acknowledgeDelivery(startToken));
    const auto acknowledgedStart = session.abortDelivery(startToken);
    CHECK(acknowledgedStart.safety ==
              singz::NativePlaybackCleanupSafety::NotOwned &&
          acknowledgedStart.state == singz::NativePlaybackState::Running &&
          acknowledgedStart.retainedBytes != 0 &&
          acknowledgedStart.physicalOwnershipRetained &&
          !acknowledgedStart.globallyComplete() && fake->stops == 0 &&
          fake->drive(16));
    singz::NativePlaybackDeliveryToken duplicateStart{
        9, 9, singz::NativePlaybackDeliveryCommand::Start};
    const auto duplicateStartResult = session.start(1, &duplicateStart);
    CHECK(!duplicateStartResult.ok && !duplicateStart.valid() &&
          session.abortDelivery(duplicateStart).safety ==
              singz::NativePlaybackCleanupSafety::NotOwned &&
          session.status().state == singz::NativePlaybackState::Running &&
          fake->stops == 0 && fake->drive(16));
    CHECK(session.unload(1).ok);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    auto first = std::vector<singz::NativePlaybackLaneSource>{};
    first.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(first), 1).ok);
    CHECK(session.openOutput(1).ok && session.unload(1).ok);
    auto second = std::vector<singz::NativePlaybackLaneSource>{};
    second.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(second), 2).ok);
    CHECK(session.openOutput(2).ok);
    const uint32_t stopsBefore = fake->stops;
    const auto oldCleanup = session.abortPrepareDelivery(1);
    CHECK(oldCleanup.safety == singz::NativePlaybackCleanupSafety::NotOwned &&
          oldCleanup.generation == 1 &&
          oldCleanup.state == singz::NativePlaybackState::OutputOpen &&
          oldCleanup.retainedBytes != 0 &&
          oldCleanup.physicalOwnershipRetained &&
          !oldCleanup.globallyComplete() && fake->stops == stopsBefore &&
          session.status().generation == 2 &&
          session.status().state == singz::NativePlaybackState::OutputOpen);
    CHECK(session.unload(2).ok);
  }
  std::remove(wav.c_str());
}

void preparedWithoutOpenDoesNotTouchStaleHost() {
  const std::string wav =
      writeWav("prepared-no-host.wav", 1, std::vector<float>(64, 0.1F));
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  auto first = std::vector<singz::NativePlaybackLaneSource>{};
  first.push_back(lane("a", wav));
  CHECK(session.prepare(config(), std::move(first), 1).ok);
  CHECK(session.openOutput(1).ok && session.start(1).ok);
  CHECK(fake->drive(16));
  fake->injectHostDiagnostics();
  fake->setTerminal(singz::AudioHostTerminalReason::RouteChanged);
  CHECK(session.unload(1).ok);

  auto second = std::vector<singz::NativePlaybackLaneSource>{};
  second.push_back(lane("a", wav));
  CHECK(session.prepare(config(), std::move(second), 2).ok);
  const uint32_t statusCallsBefore = fake->statusCalls;
  const uint32_t stopsBefore = fake->stops;
  const auto prepared = session.status();
  CHECK(prepared.state == singz::NativePlaybackState::Prepared &&
        prepared.terminalReason == singz::AudioHostTerminalReason::None &&
        prepared.host.state == singz::AudioHostState::Closed &&
        prepared.host.streamGeneration == 0 && prepared.host.callbacks == 0 &&
        prepared.host.renderedFrames == 0 && prepared.host.xruns == 0 &&
        prepared.host.deadlineMisses == 0 &&
        prepared.host.renderFailures == 0 &&
        fake->statusCalls == statusCallsBefore && fake->stops == stopsBefore);
  CHECK(session.unload(2).ok);
  CHECK(fake->statusCalls == statusCallsBefore && fake->stops == stopsBefore);
  const auto unloaded = session.status();
  CHECK(unloaded.state == singz::NativePlaybackState::Unloaded &&
        unloaded.retainedBytes == 0 &&
        unloaded.terminalReason == singz::AudioHostTerminalReason::None &&
        fake->statusCalls == statusCallsBefore && fake->stops == stopsBefore);
  std::remove(wav.c_str());
}

void generationFailureAndTerminalMatrix() {
  const std::string wav =
      writeWav("matrix.wav", 1, std::vector<float>(32, 0.1F));
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend));
    auto zero = std::vector<singz::NativePlaybackLaneSource>{};
    zero.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(zero), 0).error ==
          singz::NativePlaybackError::InvalidGeneration);
    auto malformed = std::vector<singz::NativePlaybackLaneSource>{};
    malformed.push_back(
        {"bad", singz::OwnedFileDescriptor(), 1.0F, false, false});
    CHECK(session.prepare(config(), std::move(malformed), 1).error ==
          singz::NativePlaybackError::InvalidConfiguration);
    CHECK(session.status().generation == 0 &&
          session.status().state == singz::NativePlaybackState::Unloaded &&
          session.status().retainedBytes == 0);
    CHECK(session.unload(1).ok && session.unload(1).ok);

    std::atomic<bool> cancel{true};
    auto cancelFn = [](void *opaque) noexcept {
      return static_cast<std::atomic<bool> *>(opaque)->load();
    };
    auto cancelled = std::vector<singz::NativePlaybackLaneSource>{};
    cancelled.push_back(lane("a", wav));
    CHECK(
        session.prepare(config(), std::move(cancelled), 2, {&cancel, cancelFn})
            .error == singz::NativePlaybackError::Cancelled);
    CHECK(session.unload(2).ok && session.unload(2).ok);
    auto stale = std::vector<singz::NativePlaybackLaneSource>{};
    stale.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(stale), 2).error ==
          singz::NativePlaybackError::InvalidGeneration);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    backend->failOpen = true;
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    CHECK(session.openOutput(1).error ==
          singz::NativePlaybackError::HostFailure);
    CHECK(session.status().state == singz::NativePlaybackState::Prepared &&
          session.status().retainedBytes != 0);
    fake->failOpen = false;
    CHECK(session.openOutput(1).ok);
    CHECK(session.unload(1).ok);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    backend->failStart = true;
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    CHECK(session.openOutput(1).ok);
    CHECK(session.start(1).error == singz::NativePlaybackError::HostFailure);
    CHECK(session.status().state == singz::NativePlaybackState::Terminal);
    CHECK(session.unload(1).ok);
  }
  for (const auto reason :
       {singz::AudioHostTerminalReason::RouteChanged,
        singz::AudioHostTerminalReason::Interrupted,
        singz::AudioHostTerminalReason::MediaServicesLost}) {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    CHECK(session.openOutput(1).ok);
    CHECK(session.start(1).ok);
    fake->setTerminal(reason);
    const auto status = session.status();
    CHECK(status.state == singz::NativePlaybackState::Terminal &&
          status.terminalReason == reason);
    const auto rejected = session.setMasterGain(1, 0.5F);
    CHECK(rejected.error == singz::NativePlaybackError::InvalidState &&
          rejected.state == singz::NativePlaybackState::Terminal);
    CHECK(session.unload(1).ok);
  }
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wav));
    CHECK(session.prepare(config(), std::move(lanes), 1).ok);
    CHECK(session.openOutput(1).ok);
    CHECK(session.start(1).ok);
    CHECK(!fake->drive(0));
    const auto terminal = session.status();
    CHECK(terminal.state == singz::NativePlaybackState::Terminal &&
          terminal.terminalReason ==
              singz::AudioHostTerminalReason::ProviderFailure &&
          terminal.terminalRenderFailures == 1);
    CHECK(session.setMasterGain(1, 0.5F).error ==
          singz::NativePlaybackError::InvalidState);
    const uint32_t adapterFailures = terminal.adapterRenderFailures;
    CHECK(!fake->drive(8));
    CHECK(session.status().adapterRenderFailures == adapterFailures);
    CHECK(session.unload(1).ok);
  }
  std::remove(wav.c_str());
}

void processGlobalQuarantineProof() {
  const std::string wav = writeWav("process-global-quarantine.wav", 1,
                                   std::vector<float>(64, 0.1F));
  auto ownerBackend = std::make_unique<ManualOutputBackend>();
  auto observerBackend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *ownerFake = ownerBackend.get();
  ManualOutputBackend *observerFake = observerBackend.get();
  singz::NativePlaybackSession owner(std::move(ownerBackend));
  singz::NativePlaybackSession observer(std::move(observerBackend));

  auto ownerLanes = std::vector<singz::NativePlaybackLaneSource>{};
  ownerLanes.push_back(lane("a", wav));
  CHECK(owner.prepare(config(), std::move(ownerLanes), 1).ok &&
        owner.status().state == singz::NativePlaybackState::Prepared &&
        owner.status().retainedBytes != 0);

  // The observer cannot even register a claimed-but-not-admitted generation
  // while another process-native owner exists. The losing session creates no
  // unload handshake and cannot turn that token-local fact into fallback.
  auto observerLanes = std::vector<singz::NativePlaybackLaneSource>{};
  observerLanes.push_back(lane("b", wav));
  const auto failed = observer.prepare(config(), std::move(observerLanes), 1);
  CHECK(!failed.ok &&
        failed.error == singz::NativePlaybackError::ResourceExhausted &&
        observer.unload(1).error ==
            singz::NativePlaybackError::InvalidGeneration);
  const uint32_t ownerStops = ownerFake->stops;
  const auto blockedProof = observer.cleanupProof(1);
  CHECK(blockedProof.safety == singz::NativePlaybackCleanupSafety::NotOwned &&
        blockedProof.error == singz::NativePlaybackError::None &&
        blockedProof.processQuarantineReserved &&
        !blockedProof.processQuarantinePoisoned &&
        blockedProof.processQuarantineRetainedBytes ==
            owner.status().retainedBytes &&
        !blockedProof.globallyComplete() && observerFake->stops == 0 &&
        ownerFake->stops == ownerStops &&
        owner.status().state == singz::NativePlaybackState::Prepared &&
        owner.status().retainedBytes != 0);

  CHECK(owner.unload(1).ok);
  const auto releasedProof = owner.cleanupProof(1);
  const auto repeatedProof = owner.cleanupProof(1);
  CHECK(releasedProof.safety == singz::NativePlaybackCleanupSafety::Complete &&
        releasedProof.globallyComplete() && releasedProof.handoffLease != 0 &&
        repeatedProof.handoffLease == releasedProof.handoffLease &&
        repeatedProof.coordinatorEpoch == releasedProof.coordinatorEpoch &&
        observer.cleanupProof(1).safety ==
            singz::NativePlaybackCleanupSafety::NotOwned &&
        !releasedProof.processQuarantineReserved &&
        !releasedProof.processQuarantinePoisoned);
  CHECK(!observer.claimGeneration(1));
  CHECK(!observer.claimGeneration(2, releasedProof.handoffLease + 1).ok);
  CHECK(observer.claimGeneration(2, releasedProof.handoffLease).ok);
  CHECK(!owner.claimGeneration(2, releasedProof.handoffLease).ok);
  CHECK(observer.unload(2).ok);
  std::remove(wav.c_str());
}

void deferredClaimUnloadFinalizesAfterNormalRetirement() {
  const std::string wav =
      writeWav("deferred-claim-unload.wav", 1, std::vector<float>(64, 0.1F));
  auto backend = std::make_unique<ManualOutputBackend>();
  singz::NativePlaybackSession session(std::move(backend));
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("old", wav));
  CHECK(session.prepare(config(), std::move(lanes), 1).ok);
  CHECK(session.claimGeneration(2));

  // The newer exact unload is accepted immediately, but cannot publish a
  // fallback lease until the older decoded graph has physically retired.
  const auto deferred = session.unloadWithCleanup(2);
  CHECK(deferred.playback.ok && deferred.playback.generation == 2 &&
        deferred.cleanup.generation == 2);
  const auto pending = deferred.cleanup;
  CHECK(pending.safety == singz::NativePlaybackCleanupSafety::Uncertain &&
        pending.error == singz::NativePlaybackError::TeardownUncertain &&
        pending.processQuarantineReserved && pending.retainedBytes != 0 &&
        !pending.globallyComplete());

  const auto retired = session.unloadWithCleanup(1);
  CHECK(retired.playback.ok && retired.playback.generation == 1 &&
        retired.playback.state == singz::NativePlaybackState::Unloaded &&
        retired.cleanup.generation == 2);
  const auto completed = session.cleanupProof(2);
  const auto repeated = session.cleanupProof(2);
  CHECK(completed.globallyComplete() && completed.handoffLease != 0 &&
        completed.generation == 2 && completed.retainedBytes == 0 &&
        !completed.physicalOwnershipRetained &&
        !completed.processQuarantineReserved &&
        completed.coordinatorState ==
            singz::NativePlaybackCoordinatorState::FallbackLeased &&
        repeated.handoffLease == completed.handoffLease &&
        repeated.coordinatorEpoch == completed.coordinatorEpoch &&
        session.cleanupProof(1).safety ==
            singz::NativePlaybackCleanupSafety::NotOwned);
  const auto retiredRetry = session.unloadWithCleanup(1);
  CHECK(retiredRetry.playback.ok && retiredRetry.playback.generation == 1 &&
        retiredRetry.playback.state == retired.playback.state &&
        retiredRetry.cleanup.generation == 2 &&
        retiredRetry.cleanup.handoffLease == retired.cleanup.handoffLease &&
        retiredRetry.cleanup.coordinatorEpoch ==
            retired.cleanup.coordinatorEpoch);
  const auto bridgeDeliveryRetry = session.abortPrepareDelivery(1);
  CHECK(bridgeDeliveryRetry.generation == 2 &&
        bridgeDeliveryRetry.handoffLease == completed.handoffLease &&
        bridgeDeliveryRetry.globallyComplete());

  // No second unload(2) is needed. The exact lease transfers directly to the
  // next native generation and cannot be replayed afterward.
  CHECK(session.claimGeneration(3, completed.handoffLease).ok);
  CHECK(session.unload(3).ok);
  std::remove(wav.c_str());
}

void deferredUnloadReceiptJournalExhaustionIsFailClosed() {
  const std::string wav = writeWav("deferred-receipt-exhaustion.wav", 1,
                                   std::vector<float>(64, 0.1F));
  bool exhaust = true;
  singz::NativePlaybackTestHooks hooks{};
  hooks.context = &exhaust;
  hooks.exhaustUnloadReceiptJournal = &exhaustUnloadReceiptJournal;
  auto backend = std::make_unique<ManualOutputBackend>();
  singz::NativePlaybackSession session(std::move(backend), &hooks);
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("old", wav));
  CHECK(session.prepare(config(), std::move(lanes), 1).ok);
  CHECK(session.claimGeneration(2));
  const auto rejected = session.unloadWithCleanup(2);
  CHECK(!rejected.playback.ok &&
        rejected.playback.error ==
            singz::NativePlaybackError::ResourceExhausted &&
        rejected.cleanup.safety ==
            singz::NativePlaybackCleanupSafety::Uncertain &&
        !rejected.cleanup.globallyComplete());
  exhaust = false;
  const auto repeated = session.unloadWithCleanup(2);
  CHECK(repeated.playback.error == rejected.playback.error &&
        repeated.cleanup.safety == rejected.cleanup.safety &&
        !repeated.cleanup.globallyComplete());
  std::remove(wav.c_str());
}

void processOwnershipCoordinatorHandoff() {
  auto backendA = std::make_unique<ManualOutputBackend>();
  auto backendB = std::make_unique<ManualOutputBackend>();
  singz::NativePlaybackSession a(std::move(backendA));
  singz::NativePlaybackSession b(std::move(backendB));
  std::atomic<uint32_t> ready{0};
  std::atomic<bool> go{false};
  singz::NativePlaybackResult claimA;
  singz::NativePlaybackResult claimB;
  std::thread threadA([&] {
    ready.fetch_add(1, std::memory_order_release);
    while (!go.load(std::memory_order_acquire))
      std::this_thread::yield();
    claimA = a.claimGeneration(1, 0);
  });
  std::thread threadB([&] {
    ready.fetch_add(1, std::memory_order_release);
    while (!go.load(std::memory_order_acquire))
      std::this_thread::yield();
    claimB = b.claimGeneration(1, 0);
  });
  while (ready.load(std::memory_order_acquire) != 2)
    std::this_thread::yield();
  go.store(true, std::memory_order_release);
  threadA.join();
  threadB.join();
  CHECK(claimA.ok != claimB.ok);
  singz::NativePlaybackSession *owner = claimA.ok ? &a : &b;
  singz::NativePlaybackSession *rejected = claimA.ok ? &b : &a;
  const auto rejectedClaim = claimA.ok ? claimB : claimA;
  CHECK(rejectedClaim.error == singz::NativePlaybackError::ResourceExhausted);
  CHECK(rejected->failPrepareAdmission(
                    1, singz::NativePlaybackError::DecodeFailure)
                .error == singz::NativePlaybackError::InvalidGeneration &&
        rejected->unload(1).error ==
            singz::NativePlaybackError::InvalidGeneration &&
        rejected->cleanupProof(1).safety ==
            singz::NativePlaybackCleanupSafety::NotOwned);

  CHECK(
      owner->failPrepareAdmission(1, singz::NativePlaybackError::DecodeFailure)
          .error == singz::NativePlaybackError::DecodeFailure);
  CHECK(owner->unload(1).ok);
  const auto lease = owner->cleanupProof(1);
  const auto repeated = owner->cleanupProof(1);
  CHECK(lease.globallyComplete() && lease.handoffLease != 0 &&
        lease.coordinatorState ==
            singz::NativePlaybackCoordinatorState::FallbackLeased &&
        repeated.handoffLease == lease.handoffLease &&
        repeated.coordinatorEpoch == lease.coordinatorEpoch);

  CHECK(rejected->claimGeneration(2, 0).error ==
            singz::NativePlaybackError::ResourceExhausted &&
        rejected->claimGeneration(2, lease.handoffLease + 1).error ==
            singz::NativePlaybackError::InvalidGeneration);
  const auto transferred = rejected->claimGeneration(2, lease.handoffLease);
  CHECK(transferred.ok);
  CHECK(owner->claimGeneration(2, lease.handoffLease).error ==
        singz::NativePlaybackError::ResourceExhausted);
  CHECK(rejected->unload(2).ok);
}

void handoffLeaseSerialExhaustionFailsClosed() {
  const std::string wav = writeWav("deferred-lease-exhaustion.wav", 1,
                                   std::vector<float>(64, 0.1F));
  bool exhaust = true;
  singz::NativePlaybackTestHooks hooks{};
  hooks.context = &exhaust;
  hooks.exhaustHandoffLeaseSerial = &exhaustHandoffLeaseSerial;
  auto backend = std::make_unique<ManualOutputBackend>();
  singz::NativePlaybackSession session(std::move(backend), &hooks);
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("old", wav));
  CHECK(session.prepare(config(), std::move(lanes), 1).ok);
  CHECK(session.claimGeneration(2));
  CHECK(session.unloadWithCleanup(2).playback.ok);
  const auto retired = session.unloadWithCleanup(1);
  CHECK(!retired.playback.ok && retired.playback.generation == 1 &&
        retired.playback.error ==
            singz::NativePlaybackError::ResourceExhausted &&
        retired.cleanup.generation == 2);
  const auto retiredRetry = session.unloadWithCleanup(1);
  CHECK(retiredRetry.playback.error == retired.playback.error &&
        retiredRetry.cleanup.error == retired.cleanup.error &&
        retiredRetry.cleanup.coordinatorEpoch ==
            retired.cleanup.coordinatorEpoch);
  const auto exhausted = session.cleanupProof(1);
  CHECK(exhausted.safety == singz::NativePlaybackCleanupSafety::NotOwned &&
        !exhausted.globallyComplete());
  const auto newerExhausted = session.cleanupProof(2);
  CHECK(
      newerExhausted.safety == singz::NativePlaybackCleanupSafety::Uncertain &&
      newerExhausted.error == singz::NativePlaybackError::ResourceExhausted &&
      newerExhausted.handoffLease == 0 && !newerExhausted.globallyComplete() &&
      newerExhausted.coordinatorState ==
          singz::NativePlaybackCoordinatorState::NativeOwned);
  auto otherBackend = std::make_unique<ManualOutputBackend>();
  singz::NativePlaybackSession other(std::move(otherBackend));
  CHECK(other.claimGeneration(1, 0).error ==
        singz::NativePlaybackError::ResourceExhausted);
  std::remove(wav.c_str());
}

void staleRetirementFinalizesDeferredProofWithoutOldUnload() {
  const std::string wav =
      writeWav("stale-deferred-proof.wav", 1, std::vector<float>(64, 0.1F));
  StaleTeardownLatch latch;
  singz::NativePlaybackTestHooks hooks{blockStaleTeardown, &latch};
  auto backend = std::make_unique<ManualOutputBackend>();
  singz::NativePlaybackSession session(std::move(backend), &hooks);
  CHECK(session.claimGeneration(1));
  singz::NativePlaybackResult preparingResult;
  std::thread preparing([&] {
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("stale", wav));
    preparingResult = session.prepare(config(), std::move(lanes), 1);
  });
  waitStaleLatch(&latch, true);
  CHECK(session.claimGeneration(2));
  releaseStaleLatch(&latch, true);
  waitStaleLatch(&latch, false);
  const auto deferred = session.unloadWithCleanup(2);
  CHECK(deferred.playback.ok && !deferred.cleanup.globallyComplete());
  releaseStaleLatch(&latch, false);
  preparing.join();
  CHECK(preparingResult.error == singz::NativePlaybackError::Cancelled);
  const auto proof = session.cleanupProof(2);
  CHECK(proof.globallyComplete() && proof.handoffLease != 0 &&
        proof.generation == 2 &&
        session.cleanupProof(1).safety ==
            singz::NativePlaybackCleanupSafety::NotOwned);
  CHECK(session.claimGeneration(3, proof.handoffLease).ok);
  CHECK(session.unload(3).ok);
  std::remove(wav.c_str());
}

void boundedQuarantinePoisonsFuturePrepare() {
  const std::string wav =
      writeWav("bounded-quarantine.wav", 1, std::vector<float>(32, 0.1F));
  StaleTeardownLatch teardown;
  teardown.failShutdown = true;
  singz::NativePlaybackTestHooks hooks{};
  hooks.context = &teardown;
  hooks.failRunnerShutdown = &failStaleRunnerShutdown;
  auto backend = std::make_unique<ManualOutputBackend>();
  auto session = std::make_unique<singz::NativePlaybackSession>(
      std::move(backend), &hooks);
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("a", wav));
  CHECK(session->prepare(config(), std::move(lanes), 1).ok);
  CHECK(session->claimGeneration(2));
  CHECK(session->unload(2).ok);
  const auto failed = session->unload(1);
  CHECK(failed.error == singz::NativePlaybackError::GraphFailure &&
        failed.state == singz::NativePlaybackState::Quarantined &&
        session->status().retainedBytes != 0);
  const auto cleanup = session->cleanupProof(2);
  CHECK(cleanup.safety == singz::NativePlaybackCleanupSafety::Uncertain &&
        cleanup.error == singz::NativePlaybackError::TeardownUncertain &&
        cleanup.state == singz::NativePlaybackState::Quarantined &&
        cleanup.retainedBytes != 0 && cleanup.processQuarantineReserved &&
        cleanup.handoffLease == 0 && !cleanup.globallyComplete());

  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  session.reset();
  zdsp::test::setAllocationTrapEnabled(false);
  CHECK(zdsp::test::trappedAllocationCount() == 0);

  auto rejectedBackend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *rejectedFake = rejectedBackend.get();
  singz::NativePlaybackSession rejected(std::move(rejectedBackend));
  auto rejectedLanes = std::vector<singz::NativePlaybackLaneSource>{};
  rejectedLanes.push_back(lane("a", wav));
  const auto result = rejected.prepare(config(), std::move(rejectedLanes), 2);
  CHECK(result.error == singz::NativePlaybackError::TeardownUncertain &&
        result.state == singz::NativePlaybackState::Unloaded &&
        rejected.status().retainedBytes == 0 && rejectedFake->opens == 0 &&
        rejectedFake->starts == 0);
  CHECK(rejected.unload(2).error ==
        singz::NativePlaybackError::InvalidGeneration);
  const auto poisonedProof = rejected.cleanupProof(2);
  CHECK(poisonedProof.safety == singz::NativePlaybackCleanupSafety::Uncertain &&
        poisonedProof.error == singz::NativePlaybackError::TeardownUncertain &&
        poisonedProof.processQuarantinePoisoned &&
        !poisonedProof.processQuarantineReserved &&
        poisonedProof.processQuarantineRetainedBytes != 0 &&
        poisonedProof.retainedBytes >=
            poisonedProof.processQuarantineRetainedBytes &&
        !poisonedProof.globallyComplete());
  std::remove(wav.c_str());
}

void staleRetirementFailurePoisonsExactReservation() {
  const std::string wav =
      writeWav("stale-retirement-poison.wav", 1, std::vector<float>(64, 0.1F));
  StaleTeardownLatch latch;
  latch.failShutdown = true;
  singz::NativePlaybackTestHooks hooks{blockStaleTeardown, &latch, nullptr,
                                       &failStaleRunnerShutdown};
  auto backend = std::make_unique<ManualOutputBackend>();
  singz::NativePlaybackSession session(std::move(backend), &hooks);
  CHECK(session.claimGeneration(1));
  singz::NativePlaybackResult result;
  std::thread preparing([&] {
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("stale", wav));
    result = session.prepare(config(), std::move(lanes), 1);
  });
  waitStaleLatch(&latch, true);
  CHECK(session.claimGeneration(2));
  releaseStaleLatch(&latch, true);
  waitStaleLatch(&latch, false);

  CHECK(session.unload(1).ok);
  const auto retiring = session.cleanupProof(1);
  CHECK(retiring.safety == singz::NativePlaybackCleanupSafety::Uncertain &&
        retiring.processQuarantineReserved && retiring.retainedBytes != 0 &&
        !retiring.globallyComplete());
  CHECK(session.claimGeneration(3));
  releaseStaleLatch(&latch, false);
  preparing.join();

  CHECK(result.error == singz::NativePlaybackError::GraphFailure &&
        session.status().state == singz::NativePlaybackState::Unloaded &&
        session.status().generation == 0);
  const auto poisoned = session.cleanupProof(1);
  CHECK(poisoned.safety == singz::NativePlaybackCleanupSafety::Uncertain &&
        poisoned.error == singz::NativePlaybackError::TeardownUncertain &&
        poisoned.processQuarantinePoisoned &&
        poisoned.processQuarantineRetainedBytes != 0 &&
        !poisoned.processQuarantineReserved && !poisoned.globallyComplete());

  auto newer = std::vector<singz::NativePlaybackLaneSource>{};
  newer.push_back(lane("newer", wav));
  CHECK(session.prepare(config(), std::move(newer), 3).error ==
        singz::NativePlaybackError::TeardownUncertain);
  CHECK(session.unload(3).ok);
  const auto newerProof = session.cleanupProof(3);
  CHECK(newerProof.safety == singz::NativePlaybackCleanupSafety::Uncertain &&
        newerProof.processQuarantinePoisoned && !newerProof.globallyComplete());
  std::remove(wav.c_str());
}

void providerDisposeFailureRetainsOwnershipAndPoisonsReopen() {
  const std::string wav =
      writeWav("provider-dispose-failure.wav", 1, std::vector<float>(64, 0.1F));
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  auto session =
      std::make_unique<singz::NativePlaybackSession>(std::move(backend));
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("a", wav));
  CHECK(session->prepare(config(), std::move(lanes), 1).ok);
  CHECK(session->openOutput(1).ok && session->start(1).ok);
  // The fake Error state models RemoteIO stop/dispose uncertainty. It is not
  // a quiescence proof, so the host marker and decoded graph stay owned.
  fake->uncertainStop = true;
  const auto failed = session->unloadWithCleanup(1);
  CHECK(
      !failed.playback.ok &&
      failed.playback.error == singz::NativePlaybackError::TeardownUncertain &&
      failed.cleanup.safety == singz::NativePlaybackCleanupSafety::Uncertain &&
      failed.cleanup.physicalOwnershipRetained &&
      failed.cleanup.handoffLease == 0 && !failed.cleanup.globallyComplete());
  auto observerBackend = std::make_unique<ManualOutputBackend>();
  singz::NativePlaybackSession observer(std::move(observerBackend));
  CHECK(observer.claimGeneration(1, 0).error ==
        singz::NativePlaybackError::ResourceExhausted);
  session.reset();
  auto rejectedBackend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *rejectedFake = rejectedBackend.get();
  singz::NativePlaybackSession rejected(std::move(rejectedBackend));
  auto rejectedLanes = std::vector<singz::NativePlaybackLaneSource>{};
  rejectedLanes.push_back(lane("b", wav));
  CHECK(rejected.prepare(config(), std::move(rejectedLanes), 2).error ==
            singz::NativePlaybackError::TeardownUncertain &&
        rejectedFake->opens == 0 &&
        rejected.cleanupProof(2).processQuarantinePoisoned);
  std::remove(wav.c_str());
}

void portableGraphDocumentMaterializesActualTopology() {
  singz::NativePlaybackGraphContext context;
  context.outputChannels = 2;
  context.lanes.push_back({"voice", 1, false});
  singz::NativePlaybackGraphDocument document =
      singz::synthesizeNativePlaybackGraphDocument(context);
  const auto *documentMaster =
      documentNode(document, singz::kGraphTypeGain, "song-master");
  const auto *documentLimiter =
      documentNode(document, singz::kGraphTypeSafetyLimiter);
  CHECK(documentMaster != nullptr && documentLimiter != nullptr);
  const uint64_t documentMasterId = documentMaster->id;
  const uint64_t documentLimiterId = documentLimiter->id;

  singz::NativePlaybackGraphNode trim;
  trim.id = 9000;
  trim.type = singz::kGraphTypeGain;
  trim.typeVersion = 1;
  trim.execution = "builtin";
  trim.unavailable = singz::NativePlaybackGraphUnavailablePolicy::Silence;
  trim.inputs.push_back({"in", 2});
  trim.outputs.push_back({"out", 2});
  trim.parameters.push_back({"gain", 0.5});
  document.nodes.insert(document.nodes.end() - 2, trim);
  const auto masterToLimiter = std::find_if(
      document.connections.begin(), document.connections.end(),
      [documentMasterId, documentLimiterId](const auto &connection) {
        return connection.from.node == documentMasterId &&
               connection.to.node == documentLimiterId;
      });
  CHECK(masterToLimiter != document.connections.end());
  masterToLimiter->to = {9000, "in"};
  document.connections.push_back(
      {{9000, "out"}, {documentLimiterId, "in"}});
  CHECK(document.nodes.size() == 8 && document.connections.size() == 7);

  const auto materialized =
      singz::materializeNativePlaybackGraphDocument(document, context);
  CHECK(materialized.ok() &&
        materialized.graph.nodes.size() == document.nodes.size() &&
        materialized.graph.connections.size() == document.connections.size() &&
        materialized.graph.nodes[materialized.graph.nodes.size() - 3]
                .document.id == 9000);

  const std::string wav = writeWav(
      "portable-graph-document.wav", 1, std::vector<float>(1024, 0.4F));
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  singz::NativePlaybackPrepareConfig request = config();
  request.graphDocument = std::move(document);
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("voice", wav));
  CHECK(session.prepare(std::move(request), std::move(lanes), 51).ok);
  const auto prepared = session.status();
  const auto &snapshot = graphSnapshot(prepared);
  const auto trimStatus = std::find_if(
      snapshot.nodes.begin(), snapshot.nodes.end(),
      [](const auto &value) { return value.id == 9000; });
  CHECK(trimStatus != snapshot.nodes.end() &&
        trimStatus->kind == singz::NativePlaybackGraphNodeKind::Gain &&
        graphConnection(snapshot, documentMasterId, 9000) != nullptr &&
        graphConnection(snapshot, 9000, documentLimiterId) != nullptr &&
        prepared.topology.find("song gain→gain") != std::string::npos);
  CHECK(session.openOutput(51).ok && session.start(51).ok);
  CHECK(fake->drive(64));
  CHECK(near(fake->left[0], pcm16(0.4F) * 0.5F, 0.0002F));
  CHECK(session.unload(51).ok);
  std::remove(wav.c_str());

  singz::NativePlaybackGraphDocument invalid =
      singz::synthesizeNativePlaybackGraphDocument(context);
  const auto *invalidMaster =
      documentNode(invalid, singz::kGraphTypeGain, "song-master");
  const auto *invalidLimiter =
      documentNode(invalid, singz::kGraphTypeSafetyLimiter);
  CHECK(invalidMaster != nullptr && invalidLimiter != nullptr);
  const uint64_t invalidMasterId = invalidMaster->id;
  const uint64_t invalidLimiterId = invalidLimiter->id;
  const auto songIntoMaster = std::find_if(
      invalid.connections.begin(), invalid.connections.end(),
      [invalidMasterId](const auto &connection) {
        return connection.to.node == invalidMasterId;
      });
  CHECK(songIntoMaster != invalid.connections.end());
  songIntoMaster->from = {invalidLimiterId, "out"};
  CHECK(singz::materializeNativePlaybackGraphDocument(invalid, context).error ==
        singz::NativePlaybackGraphDocumentError::UnsupportedSemanticTopology);

  invalid = singz::synthesizeNativePlaybackGraphDocument(context);
  invalid.nodes.front().outputs.front().channels = 65;
  CHECK(singz::materializeNativePlaybackGraphDocument(invalid, context).error ==
        singz::NativePlaybackGraphDocumentError::InvalidPort);

  invalid = singz::synthesizeNativePlaybackGraphDocument(context);
  invalid.nodes.front().typeVersion = 0;
  CHECK(singz::materializeNativePlaybackGraphDocument(invalid, context).error ==
        singz::NativePlaybackGraphDocumentError::InvalidNode);

  singz::NativePlaybackGraphContext timePitchContext = context;
  timePitchContext.needsTimePitch = true;
  invalid = singz::synthesizeNativePlaybackGraphDocument(timePitchContext);
  const auto *timePitchSongMix = documentNode(
      invalid, singz::kGraphTypeMix, nullptr, nullptr, "lane:voice");
  const auto *timePitchMaster =
      documentNode(invalid, singz::kGraphTypeGain, "song-master");
  CHECK(timePitchSongMix != nullptr && timePitchMaster != nullptr);
  const uint64_t timePitchSongMixId = timePitchSongMix->id;
  const uint64_t timePitchMasterId = timePitchMaster->id;
  singz::NativePlaybackGraphNode unmodelledAnchorGain = trim;
  unmodelledAnchorGain.id = 9001;
  invalid.nodes.push_back(unmodelledAnchorGain);
  const auto mixIntoMaster = std::find_if(
      invalid.connections.begin(), invalid.connections.end(),
      [timePitchSongMixId, timePitchMasterId](const auto &connection) {
        return connection.from.node == timePitchSongMixId &&
               connection.to.node == timePitchMasterId;
      });
  CHECK(mixIntoMaster != invalid.connections.end());
  mixIntoMaster->to = {9001, "in"};
  invalid.connections.push_back({{9001, "out"}, {timePitchMasterId, "in"}});
  CHECK(singz::materializeNativePlaybackGraphDocument(invalid,
                                                       timePitchContext)
            .error ==
        singz::NativePlaybackGraphDocumentError::UnsupportedSemanticTopology);

  singz::NativePlaybackGraphContext maximumContext;
  maximumContext.outputChannels = 2;
  maximumContext.hasReference = true;
  maximumContext.hasTraining = true;
  maximumContext.needsTimePitch = true;
  for (uint32_t index = 0; index < singz::kNativePlaybackMaximumLanes; ++index)
    maximumContext.lanes.push_back(
        {"lane-" + std::to_string(index), 1, true});
  const singz::NativePlaybackGraphDocument maximumDocument =
      singz::synthesizeNativePlaybackGraphDocument(maximumContext);
  CHECK(singz::synthesizedNativePlaybackGraphNodeCount(maximumContext) == 74 &&
        maximumDocument.nodes.size() == 74 &&
        maximumDocument.nodes.size() <=
            singz::kNativePlaybackMaximumGraphNodes &&
        singz::materializeNativePlaybackGraphDocument(maximumDocument,
                                                       maximumContext)
            .ok());
}

} // namespace

int main() {
  if (std::getenv("SINGZ_NATIVE_PLAYBACK_PROVIDER_DISPOSE_FAILURE") !=
      nullptr) {
    providerDisposeFailureRetainsOwnershipAndPoisonsReopen();
    std::puts("native playback provider dispose failure tests: ok");
    return 0;
  }
  if (std::getenv("SINGZ_NATIVE_PLAYBACK_STALE_RETIREMENT_FAILURE") !=
      nullptr) {
    staleRetirementFailurePoisonsExactReservation();
    std::puts("native playback stale retirement failure tests: ok");
    return 0;
  }
  compositionAndLifetime();
  portableGraphDocumentMaterializesActualTopology();
  trainingDuckComposition();
  cueGraphTransportCompositionAndLifetime();
  nativeReferencePreviewClickContract();
  transportControlKernelAndTelemetry();
  audibleProjectionWaitsForLatencyHistory();
  telemetryCollisionPublishesCoherentGeneration();
  preparedStartOverridePreservesRebuildPosition();
  preparedInitialTransportIsAtomicAtFirstCallback();
  publicationAndCancellation();
  callbackTerminalLatch();
  outputClampAndStartLinearization();
  preparedGenerationResetsHostTelemetry();
  resourceAndAggregateBoundaries();
  admittedDescriptorFailureCleansUp();
  preconditionExceptionsDoNotRollbackActivePlayback();
  terminalFirstCauseAndPhysicalQuiescence();
  openExceptionAndFinalStopCause();
  bridgeMutationDeliveryCleanup();
  preparedWithoutOpenDoesNotTouchStaleHost();
  generationFailureAndTerminalMatrix();
  deferredClaimUnloadFinalizesAfterNormalRetirement();
  deferredUnloadReceiptJournalExhaustionIsFailClosed();
  staleRetirementFinalizesDeferredProofWithoutOldUnload();
  processOwnershipCoordinatorHandoff();
  processGlobalQuarantineProof();
  handoffLeaseSerialExhaustionFailsClosed();
  CHECK(std::string(singz::nativePlaybackSessionCapabilityTag()) ==
        "singz.native.playback-session.anchored-preview.v4");
  boundedQuarantinePoisonsFuturePrepare();
  std::puts("native playback session tests: ok");
  return 0;
}
