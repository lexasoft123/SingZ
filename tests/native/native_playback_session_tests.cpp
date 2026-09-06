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
#include <functional>
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

struct CallbackCapture {
  singz::AudioHostRender callback{nullptr};
  void *context{nullptr};
};

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
    if (capture != nullptr) {
      capture->callback = render;
      capture->context = renderContext;
    }
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

  // Hold and release the stream the way the Android host does: no close, no
  // reopen, the render context untouched. drive() renders nothing while held
  // (it checks Running), which is exactly the silence a real paused stream
  // gives. `refuseSuspend` models a backend that cannot hold a stream.
  singz::AudioHostResult suspend() override {
    ++suspends;
    if (refuseSuspend || state != singz::AudioHostState::Running)
      return {false,   singz::AudioHostError::InvalidState,
              state,   format,
              latency, "not running"};
    state = singz::AudioHostState::Suspended;
    return {true, singz::AudioHostError::None, state, format, latency, {}};
  }

  singz::AudioHostResult resume() override {
    ++resumes;
    if (state != singz::AudioHostState::Suspended)
      return {false,   singz::AudioHostError::InvalidState,
              state,   format,
              latency, "not suspended"};
    state = singz::AudioHostState::Running;
    return {true, singz::AudioHostError::None, state, format, latency, {}};
  }

  void stop() noexcept override {
    ++stops;
    if (graphTerminalDuringStop && renderingGraph() != nullptr) {
      auto *graph = renderingGraph();
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

  // The host's context is the session's render router; the generation that
  // is rendering hangs off it.
  singz::NativePlaybackCallbackState *renderingGraph() const noexcept {
    auto *router = static_cast<singz::NativePlaybackRenderRouter *>(context);
    return router == nullptr ? nullptr
                             : router->current.load(std::memory_order_acquire);
  }

  void setGraphTerminal(singz::AudioHostTerminalReason reason) noexcept {
    auto *graph = renderingGraph();
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
  // Test-owned copy of what open() was handed, for a test that must keep
  // calling the callback after this backend (and its session) are gone.
  CallbackCapture *capture{nullptr};
  uint32_t actualMaximumFrames{0};
  uint32_t actualNominalBufferFrames{0};
  uint32_t stops{0};
  mutable uint32_t statusCalls{0};
  mutable uint32_t enumerations{0};
  uint32_t opens{0};
  uint32_t starts{0};
  uint32_t suspends{0};
  uint32_t resumes{0};
  bool refuseSuspend{false};
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

// The envelope is generation-exact and lives off the status poll now, so a
// test asks for it the same way the facade will.
singz::NativePlaybackLanePeaksResult
peaksOf(const singz::NativePlaybackSession &session, uint64_t generation) {
  const singz::NativePlaybackLanePeaksResult result =
      session.lanePeaks(generation);
  CHECK(result.ok && result.error == singz::NativePlaybackError::None &&
        result.generation == generation &&
        result.bucketCount == singz::kNativePlaybackLaneSummaryBuckets);
  return result;
}

// Samples what the session is holding at the moment the replacement decode
// starts. A declining prepare that freed its parked lanes only afterwards
// would be holding two copies of a song at once — ~1.7 GB for a six-lane
// five-minute project, which is a jetsam kill rather than a slow rebuild.
struct ParkedPeakWatch {
  singz::NativePlaybackSession *session{nullptr};
  std::mutex mutex;
  bool sampled{false};
  size_t parkedAtFirstDecodePoll{0};
  size_t retainedAtFirstDecodePoll{0};
};

bool watchParkedAtDecode(void *opaque) noexcept {
  auto *watch = static_cast<ParkedPeakWatch *>(opaque);
  try {
    std::lock_guard<std::mutex> lock(watch->mutex);
    if (!watch->sampled && watch->session != nullptr) {
      // prepare() holds no session lock while decoding, so this is the
      // ordinary status any observer would read at that instant.
      const singz::NativePlaybackStatus status = watch->session->status();
      watch->parkedAtFirstDecodePoll = status.parkedLaneBytes;
      watch->retainedAtFirstDecodePoll = status.retainedBytes;
      watch->sampled = true;
    }
  } catch (...) {
  }
  return false;
}

singz::NativePlaybackLaneSource keyedLane(const char *id,
                                          const std::string &path,
                                          const char *key = nullptr) {
  singz::NativePlaybackLaneSource source =
      lane(id, path);
  source.sourceKey = key == nullptr ? path : std::string(key);
  return source;
}

// A tempo or transpose change rebuilds the graph over the same six files. The
// decode is the expensive half, so a retaining unload parks it — and every
// claim that makes about what the session is holding has to be true.
void decodedLaneRetentionAcrossRebuild() {
  const std::vector<float> original(2400, 0.4F);
  const std::vector<float> replacement(2400, 0.1F);
  const std::string first = writeWav("retain-a.wav", 1, original);
  const std::string second = writeWav("retain-b.wav", 1, original);
  const float originalPeak = std::fabs(pcm16(0.4F));
  const float replacementPeak = std::fabs(pcm16(0.1F));
  CHECK(originalPeak != replacementPeak);

  constexpr size_t arenaBytes =
      4u * 1024u * 1024u + 16u * 2u * 512u * sizeof(float);
  constexpr size_t laneBytes = 2400u * sizeof(float);
  constexpr size_t parkedBytes = 2u * laneBytes;

  // Rewriting the files after the park is what makes adoption visible: an
  // adopted lane still carries the audio it was decoded from, a re-decoded
  // one carries what is on disk now.
  const auto rewriteFiles = [&](const std::vector<float> &samples) {
    CHECK(writeWav("retain-a.wav", 1, samples) == first);
    CHECK(writeWav("retain-b.wav", 1, samples) == second);
  };

  // A cleanup that proves the session empty hands the process fallback lease
  // away, and the next prepare has to hand it back. Threading it here is the
  // same bookkeeping the product bridge does.
  uint64_t handoffLease = 0;
  const auto adoptLease = [&](const singz::NativePlaybackCleanupResult &proof) {
    if (proof.globallyComplete())
      handoffLease = proof.handoffLease;
  };
  const auto prepareTwo = [&](singz::NativePlaybackSession &session,
                              uint64_t generation, const char *firstId,
                              const char *secondId, const char *firstKey,
                              double sampleRate) {
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(keyedLane(firstId, first, firstKey));
    lanes.push_back(keyedLane(secondId, second));
    singz::NativePlaybackPrepareConfig request = config();
    request.requestedSampleRate = sampleRate;
    request.handoffLease = handoffLease;
    handoffLease = 0;
    return session.prepare(std::move(request), std::move(lanes), generation);
  };

  {
    rewriteFiles(original);
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend));
    CHECK(prepareTwo(session, 901, "a", "b", nullptr, 48000.0).ok);
    auto status = session.status();
    CHECK(status.parkedLaneBytes == 0 && status.parkedLaneCount == 0 &&
          status.retainedBytes == arenaBytes + parkedBytes &&
          peaksOf(session, 901).lanes[0].peaks[0] == originalPeak);

    // Default retention is exactly today's: nothing is kept.
    CHECK(session.unload(901).ok);
    CHECK(session.status().parkedLaneBytes == 0 &&
          session.status().retainedBytes == 0);
    const auto releasedProof = session.cleanupProof(901);
    CHECK(releasedProof.parkedLaneBytes == 0 &&
          releasedProof.retainedBytes == 0 &&
          releasedProof.globallyComplete());
    adoptLease(releasedProof);
  }

  {
    rewriteFiles(original);
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend));
    CHECK(prepareTwo(session, 911, "a", "b", nullptr, 48000.0).ok);
    CHECK(session.unload(911, singz::NativePlaybackLaneRetention::Park).ok);
    auto parked = session.status();
    // The graph is gone; the PCM is not, and the status says so rather than
    // reporting an empty session that is still holding a song.
    CHECK(parked.state == singz::NativePlaybackState::Unloaded &&
          parked.generation == 0 && parked.graphArenaBytes == 0 &&
          parked.lanes.empty() && parked.parkedLaneCount == 2 &&
          parked.parkedLaneBytes == parkedBytes &&
          parked.retainedBytes == parkedBytes);
    const auto proof = session.cleanupProof(911);
    CHECK(proof.parkedLaneBytes == parkedBytes &&
          proof.retainedBytes == parkedBytes && !proof.globallyComplete() &&
          proof.handoffLease == 0);

    rewriteFiles(replacement);
    CHECK(prepareTwo(session, 912, "a", "b", nullptr, 48000.0).ok);
    auto adopted = session.status();
    const auto adoptedPeaks = peaksOf(session, 912);
    CHECK(adopted.parkedLaneBytes == 0 && adopted.parkedLaneCount == 0 &&
          adopted.retainedBytes == arenaBytes + parkedBytes &&
          adopted.lanes.size() == 2 && adoptedPeaks.lanes.size() == 2 &&
          adoptedPeaks.lanes[0].peaks[0] == originalPeak &&
          adoptedPeaks.lanes[1].peaks[0] == originalPeak &&
          adopted.durationFrames == 2400);
    CHECK(session.unload(912).ok);
    CHECK(session.status().retainedBytes == 0);
  }

  // Every way of not being the same lane set decodes instead of adopting.
  struct Mismatch {
    const char *firstId;
    const char *secondId;
    const char *firstKey;
    double sampleRate;
    bool dropSecondLane;
  };
  const Mismatch mismatches[]{
      {"renamed", "b", nullptr, 48000.0, false},
      {"a", "b", "a-different-key", 48000.0, false},
      {"a", "b", "", 48000.0, false},
      {"a", "b", nullptr, 44100.0, false},
      {"a", "b", nullptr, 48000.0, true},
  };
  uint64_t generation = 921;
  for (const Mismatch &mismatch : mismatches) {
    rewriteFiles(original);
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend));
    CHECK(prepareTwo(session, generation, "a", "b", nullptr, 48000.0).ok);
    CHECK(
        session.unload(generation, singz::NativePlaybackLaneRetention::Park).ok);
    CHECK(session.status().parkedLaneBytes == parkedBytes);
    ++generation;
    rewriteFiles(replacement);
    if (mismatch.dropSecondLane) {
      auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
      lanes.push_back(keyedLane("a", first));
      singz::NativePlaybackPrepareConfig request = config();
      request.handoffLease = handoffLease;
      handoffLease = 0;
      CHECK(session.prepare(std::move(request), std::move(lanes), generation)
                .ok);
    } else {
      CHECK(prepareTwo(session, generation, mismatch.firstId,
                       mismatch.secondId, mismatch.firstKey,
                       mismatch.sampleRate)
                .ok);
    }
    const auto status = session.status();
    const auto mismatchPeaks = peaksOf(session, generation);
    // Not adopted: the lane carries what is on disk now. At a rate the parked
    // lane was not decoded at, the re-decode also resamples, so the exact
    // value is only asserted where no resampling is involved.
    CHECK(status.parkedLaneBytes == 0 && status.parkedLaneCount == 0 &&
          mismatchPeaks.lanes[0].peaks[0] != originalPeak &&
          (mismatch.sampleRate != 48000.0 ||
           mismatchPeaks.lanes[0].peaks[0] == replacementPeak));
    CHECK(session.unload(generation).ok);
    ++generation;
  }

  // A declining prepare must free the parked lanes BEFORE it allocates the
  // replacement, not after. The decode cancellation token is polled by the
  // decoding thread immediately before the first lane is read, so what the
  // session reports there is the peak this rebuild ever reaches.
  {
    rewriteFiles(original);
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend));
    CHECK(prepareTwo(session, 931, "a", "b", nullptr, 48000.0).ok);
    CHECK(session.unload(931, singz::NativePlaybackLaneRetention::Park).ok);
    CHECK(session.status().parkedLaneBytes == parkedBytes);
    rewriteFiles(replacement);
    ParkedPeakWatch watch;
    watch.session = &session;
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(keyedLane("a", first, "a-different-key"));
    lanes.push_back(keyedLane("b", second));
    singz::NativePlaybackPrepareConfig request = config();
    request.handoffLease = handoffLease;
    handoffLease = 0;
    CHECK(session
              .prepare(std::move(request), std::move(lanes), 932,
                       {&watch, watchParkedAtDecode})
              .ok);
    // Sampled at all (the decline really did decode), and holding nothing:
    // the old song's PCM is gone and the new graph's arena is not yet
    // reserved, so one song is the high-water mark, never two.
    CHECK(watch.sampled && watch.parkedAtFirstDecodePoll == 0 &&
          watch.retainedAtFirstDecodePoll == 0);
    const auto status = session.status();
    CHECK(status.parkedLaneBytes == 0 &&
          peaksOf(session, 932).lanes[0].peaks[0] == replacementPeak &&
          status.retainedBytes == arenaBytes + parkedBytes);
    CHECK(session.unload(932).ok);
  }

  // Anything that is not the adopting prepare hands the memory back. The
  // commands are driven through a live generation so each one is a real call
  // rather than a rejected one.
  const auto releasedBy =
      [&](uint64_t base,
          const std::function<void(singz::NativePlaybackSession &, uint64_t)>
              &command) {
        rewriteFiles(original);
        auto backend = std::make_unique<ManualOutputBackend>();
        singz::NativePlaybackSession session(std::move(backend));
        CHECK(prepareTwo(session, base, "a", "b", nullptr, 48000.0).ok);
        CHECK(session.unload(base, singz::NativePlaybackLaneRetention::Park).ok);
        CHECK(session.status().parkedLaneBytes == parkedBytes);
        command(session, base);
        CHECK(session.status().parkedLaneBytes == 0 &&
              session.status().parkedLaneCount == 0 &&
              session.status().retainedBytes == 0);
      };
  releasedBy(941, [](singz::NativePlaybackSession &session, uint64_t base) {
    CHECK(session.unload(base).ok);
  });
  releasedBy(943, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.openOutput(base);
  });
  releasedBy(945, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.start(base);
  });
  releasedBy(947, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.stop(base);
  });
  releasedBy(949, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.pause(base);
  });
  releasedBy(951, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.resume(base);
  });
  releasedBy(953, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.seek(base, 0);
  });
  releasedBy(955, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.setLoop(base, 0, 100);
  });
  releasedBy(957, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.clearLoop(base);
  });
  releasedBy(959, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.reanchorTransport(base);
  });
  releasedBy(961, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.setLaneControl(base, "a", 1.0F, true, false);
  });
  releasedBy(963, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.setMasterGain(base, 0.5F);
  });
  releasedBy(965, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.setTrainingEnabled(base, true);
  });
  releasedBy(967, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.previewClick(base);
  });
  releasedBy(969, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.requestCancellation(base);
  });
  releasedBy(973, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.failPrepareAdmission(base + 1,
                                       singz::NativePlaybackError::HostFailure);
  });
  releasedBy(975, [&](singz::NativePlaybackSession &session, uint64_t base) {
    // This one proves cleanup on the way through, so it takes the process
    // fallback lease with it; the next prepare has to hand it back.
    adoptLease(session.abortPrepareDelivery(base));
  });
  releasedBy(977, [&](singz::NativePlaybackSession &session, uint64_t base) {
    const auto proof = session.cleanupProof(base);
    adoptLease(proof);
    // cleanupProof only observes; the parked bytes must survive it, and the
    // unload below is what actually releases them.
    CHECK(session.status().parkedLaneBytes != 0);
    CHECK(session.unload(base).ok);
  });
  releasedBy(979, [](singz::NativePlaybackSession &session, uint64_t base) {
    (void)session.replaceAudioHostBackend(
        std::make_unique<ManualOutputBackend>());
    (void)base;
  });

  // A lane nobody named can never be recognized again, so it is not parked at
  // all — the retaining unload refuses the whole set rather than parking
  // something that a later prepare might adopt on an empty-equals-empty
  // match. This is the only thing standing between an unnamed lane and a
  // wrong adoption, so it is checked on the PARK side, where it acts.
  {
    rewriteFiles(original);
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(keyedLane("a", first, ""));
    lanes.push_back(keyedLane("b", second, ""));
    singz::NativePlaybackPrepareConfig request = config();
    request.handoffLease = handoffLease;
    handoffLease = 0;
    CHECK(session.prepare(std::move(request), std::move(lanes), 981).ok);
    CHECK(session.unload(981, singz::NativePlaybackLaneRetention::Park).ok);
    CHECK(session.status().parkedLaneBytes == 0 &&
          session.status().parkedLaneCount == 0 &&
          session.status().retainedBytes == 0);

    rewriteFiles(replacement);
    auto again = std::vector<singz::NativePlaybackLaneSource>{};
    again.push_back(keyedLane("a", first, ""));
    again.push_back(keyedLane("b", second, ""));
    CHECK(session.prepare(config(), std::move(again), 982).ok);
    CHECK(peaksOf(session, 982).lanes[0].peaks[0] == replacementPeak);
    CHECK(session.unload(982).ok);
  }

  // THE SEQUENCE THE PRODUCT ACTUALLY ISSUES. All three bridges claim the
  // next generation before preparing it, so a claim that released the parked
  // lanes would free them microseconds before the only call that can adopt
  // them — which is what happened, and it made retention dead code in the
  // product while a test that never claimed went on passing.
  {
    rewriteFiles(original);
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    CHECK(prepareTwo(session, 971, "a", "b", nullptr, 48000.0).ok);
    CHECK(session.openOutput(971).ok && session.start(971).ok);
    CHECK(fake->drive(128, singz::AudioHostDiscontinuityStart));
    CHECK(session.stop(971).ok);
    CHECK(session.unload(971, singz::NativePlaybackLaneRetention::Park).ok);
    CHECK(session.status().parkedLaneBytes == parkedBytes);

    // The claim is the first half of a prepare, and the only command that
    // leaves the parked lanes alone.
    CHECK(session.claimGeneration(972));
    CHECK(session.status().parkedLaneBytes == parkedBytes &&
          session.status().parkedLaneCount == 2 &&
          session.status().retainedBytes == parkedBytes);

    rewriteFiles(replacement);
    CHECK(prepareTwo(session, 972, "a", "b", nullptr, 48000.0).ok);
    // Adopted: the lanes still carry the audio they were decoded from, not
    // what is on disk now.
    CHECK(peaksOf(session, 972).lanes[0].peaks[0] == originalPeak &&
          peaksOf(session, 972).lanes[1].peaks[0] == originalPeak);
    CHECK(session.status().parkedLaneBytes == 0 &&
          session.status().retainedBytes == arenaBytes + parkedBytes);
    CHECK(session.unload(972).ok);
  }

  // ...and the same sequence with lanes that do not match still decodes, so
  // the claim's exemption cannot smuggle a stale song into a new one.
  {
    rewriteFiles(original);
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend));
    CHECK(prepareTwo(session, 973, "a", "b", nullptr, 48000.0).ok);
    CHECK(session.unload(973, singz::NativePlaybackLaneRetention::Park).ok);
    CHECK(session.claimGeneration(974));
    CHECK(session.status().parkedLaneBytes == parkedBytes);
    rewriteFiles(replacement);
    CHECK(prepareTwo(session, 974, "a", "b", "a-different-key", 48000.0).ok);
    CHECK(peaksOf(session, 974).lanes[0].peaks[0] == replacementPeak &&
          session.status().parkedLaneBytes == 0);
    CHECK(session.unload(974).ok);
  }

  // THE RELEASE EVERY BRIDGE ACTUALLY ISSUES. All three call
  // unloadWithCleanup and none calls unload, and unloadWithCleanup can return
  // a journaled receipt without ever reaching unload() — which was the only
  // caller that released a park. A park receipt can never be Complete
  // (parked bytes ARE retained bytes), so it would have replayed forever and
  // the memory would never have come back through the product's own path.
  {
    rewriteFiles(original);
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend));
    CHECK(prepareTwo(session, 985, "a", "b", nullptr, 48000.0).ok);
    const auto parked = session.unloadWithCleanup(
        985, singz::NativePlaybackLaneRetention::Park);
    CHECK(parked.playback.ok &&
          parked.cleanup.parkedLaneBytes == parkedBytes &&
          !parked.cleanup.globallyComplete());
    CHECK(session.status().parkedLaneBytes == parkedBytes);

    // The same generation, released through the same entry point the bridges
    // use. It must free the park AND stop replaying the park's verdict.
    const auto released = session.unloadWithCleanup(985);
    CHECK(session.status().parkedLaneBytes == 0 &&
          session.status().parkedLaneCount == 0 &&
          session.status().retainedBytes == 0);
    CHECK(released.cleanup.parkedLaneBytes == 0 &&
          released.cleanup.retainedBytes == 0);
    // Not the park's receipt handed back a second time: the desktop addon
    // only releases its ownership when this says the session is empty.
    CHECK(released.cleanup.globallyComplete());
    adoptLease(released.cleanup);
  }

  // The receipt an exceptional bridge delivery reads must carry the same fact.
  {
    rewriteFiles(original);
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend));
    CHECK(prepareTwo(session, 991, "a", "b", nullptr, 48000.0).ok);
    const auto receipt = session.unloadWithCleanup(
        991, singz::NativePlaybackLaneRetention::Park);
    CHECK(receipt.playback.ok &&
          receipt.cleanup.parkedLaneBytes == parkedBytes &&
          receipt.cleanup.retainedBytes == parkedBytes &&
          !receipt.cleanup.globallyComplete() &&
          receipt.cleanup.handoffLease == 0);
    rewriteFiles(replacement);
    CHECK(prepareTwo(session, 992, "a", "b", nullptr, 48000.0).ok);
    CHECK(peaksOf(session, 992).lanes[0].peaks[0] == originalPeak &&
          session.status().parkedLaneBytes == 0);
    const auto released = session.unloadWithCleanup(992);
    CHECK(released.playback.ok && released.cleanup.parkedLaneBytes == 0 &&
          released.cleanup.retainedBytes == 0 &&
          released.cleanup.globallyComplete());
    adoptLease(released.cleanup);
  }

  // Hand back the process fallback lease this test acquired, so the suites
  // after it start from the same Available coordinator it found.
  if (handoffLease != 0) {
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(keyedLane("a", first));
    singz::NativePlaybackPrepareConfig request = config();
    request.handoffLease = handoffLease;
    handoffLease = 0;
    CHECK(session.prepare(std::move(request), std::move(lanes), 999).ok);
    CHECK(session.unload(999).ok);
  }

  std::remove(first.c_str());
  std::remove(second.c_str());
}

// The bounded pool's admission decision, as the pool itself reports it.
struct LaneDecodePoolDecision {
  std::mutex mutex;
  uint32_t claims{0};
  uint32_t workers{0};
  uint64_t laneBudget{0};
  uint64_t smallestDecodedBytes{UINT64_MAX};
  uint64_t largestDecodedBytes{0};
  uint64_t largestWorkingBytes{0};
  // THE number: the largest sum of allowances held by decodes in flight at
  // once. Any single lane's allowance is the adjacent quantity, and a pool
  // that hands out too many perfectly reasonable allowances passes on it.
  uint64_t peakInFlightBytes{0};
  bool workingMatchesDecoded{true};
};

// Called from the pool's own worker threads, once per lane claim.
void observeLaneDecodePool(void *opaque, uint32_t workers, uint64_t laneBudget,
                           uint64_t laneDecodedBytes,
                           uint64_t laneWorkingBytes,
                           uint64_t inFlightDecodedBytes) noexcept {
  auto *decision = static_cast<LaneDecodePoolDecision *>(opaque);
  std::lock_guard<std::mutex> lock(decision->mutex);
  ++decision->claims;
  decision->workers = workers;
  decision->laneBudget = laneBudget;
  decision->smallestDecodedBytes =
      std::min(decision->smallestDecodedBytes, laneDecodedBytes);
  decision->largestDecodedBytes =
      std::max(decision->largestDecodedBytes, laneDecodedBytes);
  decision->largestWorkingBytes =
      std::max(decision->largestWorkingBytes, laneWorkingBytes);
  decision->peakInFlightBytes =
      std::max(decision->peakInFlightBytes, inFlightDecodedBytes);
  // Bounded relative to what the lane may publish, and never above the
  // caller's own per-decode working budget.
  const singz::DecodedAudioPrepareOptions defaults{};
  const uint64_t expected = std::min<uint64_t>(
      defaults.maximumWorkingBytes,
      laneDecodedBytes *
          singz::kNativePlaybackLaneWorkingBytesPerDecodedByte);
  if (laneWorkingBytes != expected)
    decision->workingMatchesDecoded = false;
}

// A command carrying a generation that is not the live one must be refused,
// and — this is the part that matters — must leave the generation that IS
// live exactly as it was. Getting this wrong reaches a singer as "the audio
// stopped for no reason": a late stop from a superseded generation tears down
// a graph that is happily playing, and every log line looks healthy.
//
// Two shapes, because the guards are two. A generation that never existed
// probes stop()'s and unload()'s own inline checks. A NEWER generation that
// the bridge has claimed but not yet prepared probes the shared
// currentForCommand() equality — until that prepare publishes a graph, the
// only graph in the session belongs to the older generation.
void staleGenerationCommandsCannotDisturbTheLiveOne() {
  const std::string wav =
      writeWav("stale-command.wav", 1, std::vector<float>(8192, 0.25F));
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("song", wav));
  CHECK(session.prepare(config(), std::move(lanes), 1101).ok);
  CHECK(session.openOutput(1101).ok && session.start(1101).ok);
  CHECK(fake->drive(128, singz::AudioHostDiscontinuityStart));
  CHECK(session.setMasterGain(1101, 0.75F).ok);
  CHECK(session.setLaneControl(1101, "song", 0.5F, false, false).ok);

  const auto stillLive = [&](const char *what) {
    const singz::NativePlaybackStatus status = session.status();
    CHECK(status.generation == 1101);
    CHECK(status.state == singz::NativePlaybackState::Running);
    CHECK(status.masterGain == 0.75F);
    CHECK(status.lanes.size() == 1 && status.lanes[0].gain == 0.5F);
    CHECK(status.transportState ==
          singz::NativePlaybackTransportState::Playing);
    // Still rendering: a graph that was quietly torn down cannot do this.
    const uint64_t before = status.renderedFrames;
    CHECK(fake->drive(128));
    CHECK(session.status().renderedFrames > before);
    (void)what;
  };
  stillLive("baseline");

  const auto refused = [&](const singz::NativePlaybackResult &result) {
    CHECK(!result.ok &&
          result.error == singz::NativePlaybackError::InvalidGeneration);
  };

  // A generation this session has never seen.
  const uint64_t ghost = 990001;
  refused(session.stop(ghost));
  stillLive("stop(ghost)");
  refused(session.unload(ghost));
  stillLive("unload(ghost)");
  refused(session.unload(ghost, singz::NativePlaybackLaneRetention::Park));
  stillLive("unload(ghost, park)");
  refused(session.pause(ghost));
  refused(session.resume(ghost));
  refused(session.seek(ghost, 0));
  refused(session.setLoop(ghost, 0, 1024));
  refused(session.clearLoop(ghost));
  refused(session.reanchorTransport(ghost));
  refused(session.setLaneControl(ghost, "song", 1.0F, true, false));
  refused(session.setMasterGain(ghost, 0.1F));
  refused(session.setTrainingEnabled(ghost, true));
  refused(session.previewClick(ghost));
  refused(session.openOutput(ghost));
  refused(session.start(ghost));
  stillLive("ghost command sweep");
  CHECK(session.unloadWithCleanup(ghost).playback.ok == false);
  stillLive("unloadWithCleanup(ghost)");

  // A newer generation the bridge has claimed but not yet prepared. Its
  // commands must not reach the graph that is still playing under 1101.
  CHECK(session.claimGeneration(1102));
  const uint64_t claimed = 1102;
  // ORDER MATTERS HERE, and getting it wrong hid the very defect this covers:
  // stop() and unload() advance the cancellation epoch to the generation they
  // are handed before anything else looks at it, so probing stop() first
  // leaves every command after it refused by the epoch rather than by the
  // generation equality under test. The shared-guard commands go first.
  refused(session.pause(claimed));
  refused(session.resume(claimed));
  refused(session.seek(claimed, 0));
  refused(session.setLoop(claimed, 0, 1024));
  refused(session.clearLoop(claimed));
  refused(session.reanchorTransport(claimed));
  refused(session.setLaneControl(claimed, "song", 1.0F, true, false));
  refused(session.setMasterGain(claimed, 0.1F));
  refused(session.setTrainingEnabled(claimed, true));
  refused(session.previewClick(claimed));
  refused(session.openOutput(claimed));
  refused(session.start(claimed));
  // Last, for the reason above.
  refused(session.stop(claimed));
  const singz::NativePlaybackStatus afterClaim = session.status();
  CHECK(afterClaim.generation == 1101 &&
        afterClaim.state == singz::NativePlaybackState::Running &&
        afterClaim.masterGain == 0.75F &&
        afterClaim.lanes.size() == 1 && afterClaim.lanes[0].gain == 0.5F);

  CHECK(session.unload(1101).ok);
  std::remove(wav.c_str());
}

// Concurrent decoding is bounded by memory, not by the core count. Six
// five-minute 44.1 kHz stems resampled to 48 kHz measured 881 MB peak decoded
// one at a time and 1940 MB decoded all six at once; the bound holds it to
// 1097 MB. This pins the arithmetic that produces that, from the numbers the
// pool actually used rather than from a stopwatch or an RSS reading.
void laneDecodePoolStaysInsideTheMemoryBudget() {
  // Lanes sized so that one lane's bytes are a MEANINGFUL fraction of its
  // share of the budget. With a default 1 GB budget and 16 kB lanes the share
  // is ten thousand times the lane, and every accounting slip rounds to
  // nothing — which is how a pool that returned each reservation in full
  // instead of minus what it published went unnoticed.
  constexpr size_t laneFrames = 4096;
  constexpr size_t laneBytes = laneFrames * sizeof(float);
  std::vector<std::string> files;
  for (int index = 0; index < 6; ++index) {
    files.push_back(writeWav(("pool-bound-" + std::to_string(index)).c_str(), 1,
                             std::vector<float>(laneFrames, 0.1F)));
  }
  const auto laneSet = [&]() {
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    for (int index = 0; index < 6; ++index)
      lanes.push_back(lane(("lane" + std::to_string(index)).c_str(),
                           files[static_cast<size_t>(index)]));
    return lanes;
  };

  // Measure the graph arena first, so the tight budget below can be stated in
  // lanes rather than guessed.
  size_t arenaBytes = 0;
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession probe(std::move(backend));
    CHECK(probe.prepare(config(), laneSet(), 1000).ok);
    const auto status = probe.status();
    CHECK(status.retainedBytes > 6u * laneBytes);
    arenaBytes = status.retainedBytes - 6u * laneBytes;
    CHECK(probe.unload(1000).ok);
  }

  LaneDecodePoolDecision decision;
  singz::NativePlaybackTestHooks hooks{};
  hooks.context = &decision;
  hooks.observeLaneDecodePool = observeLaneDecodePool;
  auto backend = std::make_unique<ManualOutputBackend>();
  singz::NativePlaybackSession session(std::move(backend), &hooks);
  auto lanes = laneSet();
  singz::NativePlaybackPrepareConfig request = config();
  // Nine lanes' worth of budget for six lanes: every lane fits its share of
  // one and a half, and a reservation the pool forgets to reclaim is visible
  // within two claims instead of within ten thousand.
  request.maximumRetainedBytes = arenaBytes + 9u * laneBytes;
  const size_t budget = request.maximumRetainedBytes;
  CHECK(session.prepare(std::move(request), std::move(lanes), 1001).ok);
  CHECK(decision.claims == 6 && decision.workers != 0 &&
        decision.laneBudget == 9u * laneBytes &&
        decision.laneBudget <= budget);

  // THE CEILING, asserted on the sum rather than on any one allowance: at no
  // moment was more of the budget spoken for — by lanes already decoded plus
  // every decode in flight — than there is. The version this replaced handed
  // out 1x, 1x, 2x, 3x, 4x, 5x the share and peaked at 1.49x the budget, and
  // passed a test that looked at one lane at a time.
  CHECK(decision.peakInFlightBytes <= decision.laneBudget);
  // Every lane really did get decoded inside that ceiling.
  CHECK(session.status().retainedBytes == arenaBytes + 6u * laneBytes);
  // Not vacuous: more than one lane really was in flight at once, so the sum
  // above is a sum and not a single allowance wearing its name.
  if (decision.workers > 1)
    CHECK(decision.peakInFlightBytes > decision.largestDecodedBytes);
  // Every individual allowance is inside the budget too, necessarily.
  CHECK(decision.largestDecodedBytes <= decision.laneBudget &&
        decision.smallestDecodedBytes != 0);
  // Each lane's transient is bounded relative to what it may publish, not by
  // the 2 GB per-decode default no caller ever chose.
  const singz::DecodedAudioPrepareOptions decodeDefaults{};
  CHECK(decision.workingMatchesDecoded &&
        decision.largestWorkingBytes <= decodeDefaults.maximumWorkingBytes);
  // Concurrency is the declared constant, not the core count.
  CHECK(decision.workers <=
        singz::kNativePlaybackMaximumConcurrentLaneDecodes);
  if (std::thread::hardware_concurrency() >=
      singz::kNativePlaybackMaximumConcurrentLaneDecodes) {
    CHECK(decision.workers ==
          singz::kNativePlaybackMaximumConcurrentLaneDecodes);
  }
  CHECK(session.unload(1001).ok);
  for (const std::string &file : files)
    std::remove(file.c_str());
  (void)laneBytes;
}

// Records which threads polled the cancellation token, which is how this
// suite proves the bounded decode pool actually ran rather than trusting a
// stopwatch. Also flips to cancelled after a chosen number of polls.
struct DecodeWatch {
  std::mutex mutex;
  std::condition_variable condition;
  std::vector<std::thread::id> threads; // distinct, in arrival order
  uint32_t polls{0};
  uint32_t cancelAfter{0};
  // Hold the first caller until a second one arrives. Whether two threads
  // decode at once is the thing being asserted, and counting arrivals after
  // the fact is a race: with four small lanes the calling thread can take
  // every one of them before a spawned worker is ever scheduled.
  bool rendezvous{false};

  size_t distinctThreads() {
    std::lock_guard<std::mutex> lock(mutex);
    return threads.size();
  }
};

bool watchDecode(void *opaque) noexcept {
  auto *watch = static_cast<DecodeWatch *>(opaque);
  try {
    std::unique_lock<std::mutex> lock(watch->mutex);
    if (std::find(watch->threads.begin(), watch->threads.end(),
                  std::this_thread::get_id()) == watch->threads.end())
      watch->threads.push_back(std::this_thread::get_id());
    ++watch->polls;
    watch->condition.notify_all();
    // A machine with one core has no second thread to wait for, so this is
    // bounded rather than a barrier.
    if (watch->rendezvous && watch->threads.size() < 2) {
      (void)watch->condition.wait_for(lock, std::chrono::seconds(5), [&] {
        return watch->threads.size() >= 2;
      });
    }
    return watch->cancelAfter != 0 && watch->polls > watch->cancelAfter;
  } catch (...) {
    return false;
  }
}

bool forceSequentialDecode(void *opaque) noexcept {
  return *static_cast<const bool *>(opaque);
}

// Lanes decoded on the pool must be the same audio, admitted by the same
// accounting, refused in the same words as lanes decoded one at a time.
void parallelLaneDecodeMatchesSequential() {
  const std::string wavA =
      writeWav("parallel-a.wav", 1, std::vector<float>(3000, 0.11F));
  std::vector<float> stereo(2 * 2500);
  for (size_t frame = 0; frame < 2500; ++frame) {
    stereo[frame * 2] = 0.2F * static_cast<float>((frame % 7) + 1) / 7.0F;
    stereo[frame * 2 + 1] = -0.3F * static_cast<float>((frame % 5) + 1) / 5.0F;
  }
  const std::string wavB = writeWav("parallel-b.wav", 2, stereo);
  const std::string wavC =
      writeWav("parallel-c.wav", 1, std::vector<float>(1800, -0.07F));
  const std::string flacSource =
      writeWav("parallel-d-source.wav", 1, std::vector<float>(2200, 0.23F));
  const std::string flacD = scratch("parallel-d.flac");
  std::remove(flacD.c_str());
  CHECK(singz::compactStem(flacSource, flacD).ok);

  bool sequential = false;
  singz::NativePlaybackTestHooks hooks{};
  hooks.context = &sequential;
  hooks.forceSequentialLaneDecode = forceSequentialDecode;

  struct Observed {
    singz::NativePlaybackStatus status;
    singz::NativePlaybackLanePeaksResult peaks;
    std::vector<float> left;
    std::vector<float> right;
    size_t decodeThreads{0};
  };
  const auto run = [&](uint64_t generation, bool forceSequential) {
    sequential = forceSequential;
    DecodeWatch watch;
    watch.rendezvous = !forceSequential;
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend), &hooks);
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wavA));
    lanes.push_back(lane("b", wavB));
    lanes.push_back(lane("c", wavC));
    lanes.push_back(lane("d", flacD));
    const singz::DecodeCancellation cancellation{&watch, watchDecode};
    CHECK(session
              .prepare(config(), std::move(lanes), generation, cancellation)
              .ok);
    Observed observed;
    observed.status = session.status();
    observed.peaks = peaksOf(session, generation);
    observed.decodeThreads = watch.distinctThreads();
    CHECK(session.openOutput(generation).ok && session.start(generation).ok);
    CHECK(fake->drive(512, singz::AudioHostDiscontinuityStart));
    observed.left.assign(fake->left.begin(), fake->left.begin() + 512);
    observed.right.assign(fake->right.begin(), fake->right.begin() + 512);
    CHECK(session.unload(generation).ok);
    return observed;
  };

  const Observed pooled = run(801, false);
  const Observed serial = run(802, true);
  // Not a stopwatch: the token is polled by whichever thread is decoding, so
  // more than one caller is the pool itself. A single-core machine has no
  // pool to prove, and the value equality below is the point either way.
  if (std::thread::hardware_concurrency() > 1)
    CHECK(pooled.decodeThreads > 1);
  CHECK(serial.decodeThreads == 1);
  CHECK(pooled.status.lanes.size() == 4 &&
        serial.status.lanes.size() == 4 &&
        pooled.status.retainedBytes == serial.status.retainedBytes &&
        pooled.status.durationFrames == serial.status.durationFrames &&
        pooled.status.durationFrames == 3000);
  for (size_t index = 0; index < 4; ++index) {
    CHECK(pooled.status.lanes[index].id == serial.status.lanes[index].id &&
          pooled.status.lanes[index].totalFrames ==
              serial.status.lanes[index].totalFrames &&
          pooled.peaks.lanes[index].id == serial.peaks.lanes[index].id &&
          pooled.peaks.lanes[index].valid ==
              serial.peaks.lanes[index].valid &&
          pooled.peaks.lanes[index].peaks == serial.peaks.lanes[index].peaks);
  }
  CHECK(pooled.left == serial.left && pooled.right == serial.right);
  // The mixed lanes must actually be audible, or the comparison above is a
  // comparison of two silences.
  CHECK(std::any_of(pooled.left.begin(), pooled.left.end(),
                    [](float value) { return value != 0.0F; }));

  // Aggregate refusals: same code AND same words on both paths. The first is
  // a budget exhausted before a lane starts, the second a lane larger than
  // the cap that budget leaves its decoder.
  constexpr size_t arenaBytes =
      4u * 1024u * 1024u + 16u * 2u * 512u * sizeof(float);
  const auto refuse = [&](uint64_t generation, bool forceSequential,
                          size_t maximumRetainedBytes) {
    sequential = forceSequential;
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend), &hooks);
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wavA));
    lanes.push_back(lane("b", wavB));
    singz::NativePlaybackPrepareConfig request = config();
    request.maximumRetainedBytes = maximumRetainedBytes;
    const auto result =
        session.prepare(std::move(request), std::move(lanes), generation);
    CHECK(!result.ok && session.status().retainedBytes == 0);
    CHECK(session.unload(generation).ok);
    return result;
  };
  const auto exhausted = refuse(803, false, arenaBytes);
  const auto exhaustedSerial = refuse(804, true, arenaBytes);
  CHECK(exhausted.error == singz::NativePlaybackError::LimitExceeded &&
        exhausted.message ==
            "Prepared playback lanes reached the aggregate memory limit" &&
        exhausted.error == exhaustedSerial.error &&
        exhausted.message == exhaustedSerial.message);
  const size_t squeezed = arenaBytes + 3000u * sizeof(float) + 16u;
  const auto tooBig = refuse(805, false, squeezed);
  const auto tooBigSerial = refuse(806, true, squeezed);
  CHECK(tooBig.error == singz::NativePlaybackError::LimitExceeded &&
        tooBig.message == "A WAV/FLAC playback lane could not be prepared" &&
        tooBig.error == tooBigSerial.error &&
        tooBig.message == tooBigSerial.message);

  // The pool's own per-lane budget is not the only door: two lanes that each
  // fit the whole budget can still not fit TOGETHER, and only the ordered
  // admission that follows the pool can see that. Making the first lane much
  // slower to decode than the second is what puts the second lane's decode
  // before the first lane's commit, so the pool cannot refuse this on its own
  // and the ordered pass is the thing under test. (On a single-core machine
  // the pool refuses it first instead; the refusal is the same either way.)
  const std::string bigSource =
      writeWav("parallel-big-source.wav", 1, std::vector<float>(400000, 0.3F));
  const std::string bigFlac = scratch("parallel-big.flac");
  std::remove(bigFlac.c_str());
  CHECK(singz::compactStem(bigSource, bigFlac).ok);
  const std::string tinyWav =
      writeWav("parallel-tiny.wav", 1, std::vector<float>(64, 0.2F));
  const size_t together =
      arenaBytes + 400000u * sizeof(float) + 64u * sizeof(float) - 4u;
  const auto refusePair = [&](uint64_t generation, bool forceSequential) {
    sequential = forceSequential;
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend), &hooks);
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("big", bigFlac));
    lanes.push_back(lane("tiny", tinyWav));
    singz::NativePlaybackPrepareConfig request = config();
    request.maximumRetainedBytes = together;
    const auto result =
        session.prepare(std::move(request), std::move(lanes), generation);
    CHECK(!result.ok && session.status().retainedBytes == 0);
    CHECK(session.unload(generation).ok);
    return result;
  };
  const auto pair = refusePair(809, false);
  const auto pairSerial = refusePair(810, true);
  CHECK(pair.error == singz::NativePlaybackError::LimitExceeded &&
        pair.message == "A WAV/FLAC playback lane could not be prepared" &&
        pair.error == pairSerial.error && pair.message == pairSerial.message);

  // THE CLIFF, and the line that explains it. Lanes are not all the same
  // length here — a singer's own added track can be any length beside six
  // equal stems — so a lane larger than its share of the budget is a real
  // shape. The pool declines it and the whole open drops to one lane at a
  // time, which is correct and costs seconds; silent, it is unexplainable
  // from a log. The status must name the lane that caused it.
  {
    sequential = false;
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend), &hooks);
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("oversized", bigFlac));
    lanes.push_back(lane("small", tinyWav));
    singz::NativePlaybackPrepareConfig request = config();
    // Room for both lanes with a little to spare, so the SEQUENTIAL path
    // admits them comfortably — but each lane's share is about half of that,
    // which the big lane alone exceeds.
    const size_t bigBytes = 400000u * sizeof(float);
    const size_t smallBytes = 64u * sizeof(float);
    request.maximumRetainedBytes =
        arenaBytes + bigBytes + smallBytes + 64u * 1024u;
    const auto prepared =
        session.prepare(std::move(request), std::move(lanes), 811);
    CHECK(prepared.ok);
    const singz::NativePlaybackStatus status = session.status();
    // It opened — just the slow way, and it says which lane made it so.
    CHECK(status.lanes.size() == 2 &&
          status.retainedBytes == arenaBytes + bigBytes + smallBytes);
    CHECK(!status.laneDecodeFallback.empty());
    CHECK(status.laneDecodeFallback.find("oversized") != std::string::npos);
    CHECK(status.laneDecodeFallback.find("share of the decode budget") !=
          std::string::npos);
    CHECK(session.unload(811).ok);
  }

  // An ordinary open says nothing, because there is nothing to explain.
  {
    sequential = false;
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend), &hooks);
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wavA));
    lanes.push_back(lane("b", wavB));
    CHECK(session.prepare(config(), std::move(lanes), 812).ok);
    CHECK(session.status().laneDecodeFallback.empty());
    CHECK(session.unload(812).ok);
  }

  // Cancellation is answered by the pool's own workers, so it aborts without
  // waiting for the slowest lane, and it says exactly what it always said.
  const auto cancel = [&](uint64_t generation, bool forceSequential) {
    sequential = forceSequential;
    DecodeWatch watch;
    watch.cancelAfter = 1;
    auto backend = std::make_unique<ManualOutputBackend>();
    singz::NativePlaybackSession session(std::move(backend), &hooks);
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(lane("a", wavA));
    lanes.push_back(lane("b", wavB));
    lanes.push_back(lane("c", wavC));
    lanes.push_back(lane("d", flacD));
    const singz::DecodeCancellation cancellation{&watch, watchDecode};
    const auto result = session.prepare(config(), std::move(lanes), generation,
                                        cancellation);
    CHECK(!result.ok && session.status().retainedBytes == 0 &&
          session.status().lanes.empty() &&
          session.status().state == singz::NativePlaybackState::Unloaded);
    CHECK(session.unload(generation).ok);
    return result;
  };
  const auto cancelled = cancel(807, false);
  const auto cancelledSerial = cancel(808, true);
  CHECK(cancelled.error == singz::NativePlaybackError::Cancelled &&
        cancelled.message == "Native playback preparation was superseded" &&
        cancelled.error == cancelledSerial.error &&
        cancelled.message == cancelledSerial.message);

  std::remove(wavA.c_str());
  std::remove(wavB.c_str());
  std::remove(wavC.c_str());
  std::remove(flacSource.c_str());
  std::remove(flacD.c_str());
  std::remove(bigSource.c_str());
  std::remove(bigFlac.c_str());
  std::remove(tinyWav.c_str());
}

// The two facts a facade cannot recover from telemetry alone: how many
// count-in beats there are and what the bars are, and what each lane's audio
// looks like when nothing decodes the stems in JavaScript.
void laneWaveformSummaryAndCountInMeter() {
  constexpr size_t buckets = singz::kNativePlaybackLaneSummaryBuckets;
  static_assert(buckets == 96, "the phones draw exactly 96 slivers");
  constexpr size_t framesPerBucket = 400;
  constexpr size_t frames = buckets * framesPerBucket; // 0.8 s at 48 kHz
  constexpr size_t spikeOffset = 137;
  constexpr size_t stereoBucket = 7;
  constexpr float stereoSpike = -0.75F;

  // One spike per bucket, alternating sign and rising in amplitude: a bucket
  // that reads the wrong span, drops the sign or normalizes the envelope
  // cannot reproduce this shape.
  std::vector<float> mono(frames, 0.0F);
  for (size_t bucket = 0; bucket < buckets; ++bucket) {
    mono[bucket * framesPerBucket + spikeOffset] =
        (bucket % 2 == 0 ? 1.0F : -1.0F) *
        (0.01F * static_cast<float>(bucket + 1));
  }
  const std::string monoWav = writeWav("summary-mono.wav", 1, mono);

  // The same shape on channel 0 plus one louder spike on channel 1: the
  // bucket peak is taken across every channel, not from the first one.
  std::vector<float> stereo(frames * 2, 0.0F);
  for (size_t frame = 0; frame < frames; ++frame)
    stereo[frame * 2] = mono[frame];
  stereo[(stereoBucket * framesPerBucket + 200) * 2 + 1] = stereoSpike;
  const std::string stereoWav = writeWav("summary-stereo.wav", 2, stereo);

  // Fewer frames than buckets: every bucket must still be defined.
  const std::vector<float> shortSamples = {0.5F, -0.25F, 0.125F, 0.0625F,
                                           0.03125F};
  const std::string shortWav = writeWav("summary-short.wav", 1, shortSamples);
  const std::string silentWav =
      writeWav("summary-silent.wav", 1, std::vector<float>(framesPerBucket));

  struct Summary {
    singz::NativePlaybackStatus status;
    singz::NativePlaybackLanePeaksResult peaks;
  };
  const auto summarize =
      [&](uint64_t generation,
          const std::optional<singz::PlaybackCuePlanRequest> &cue) {
        auto backend = std::make_unique<ManualOutputBackend>();
        singz::NativePlaybackSession session(std::move(backend));
        auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
        lanes.push_back(lane("mono", monoWav));
        lanes.push_back(lane("stereo", stereoWav));
        lanes.push_back(lane("short", shortWav));
        lanes.push_back(lane("silent", silentWav));
        singz::NativePlaybackPrepareConfig request = config();
        request.cuePlan = cue;
        CHECK(session.prepare(std::move(request), std::move(lanes), generation)
                  .ok);
        Summary summary;
        summary.status = session.status();
        summary.peaks = peaksOf(session, generation);
        // A second read of the same generation returns the same bytes.
        const singz::NativePlaybackLanePeaksResult again =
            peaksOf(session, generation);
        CHECK(summary.peaks.lanes.size() == again.lanes.size());
        for (size_t index = 0; index < again.lanes.size(); ++index)
          CHECK(summary.peaks.lanes[index].peaks == again.lanes[index].peaks);
        // A stale generation is refused rather than answered with an older
        // envelope, so a cache keyed on the generation cannot go wrong.
        const auto stale = session.lanePeaks(generation + 1);
        CHECK(!stale.ok &&
              stale.error == singz::NativePlaybackError::InvalidGeneration &&
              stale.lanes.empty());
        CHECK(session.unload(generation).ok);
        CHECK(session.status().lanes.empty());
        CHECK(!session.lanePeaks(generation).ok);
        return summary;
      };

  const Summary plain = summarize(701, std::nullopt);
  CHECK(plain.status.preRollFrames == 0 && plain.status.cueEventCount == 0 &&
        plain.status.countInEventCount == 0 &&
        plain.status.countInBeatsPerBar == 0);

  // Click without a count-in: cues exist, the count-in meter is still empty.
  const Summary clickOnly = summarize(702, cueRequest(true, 0, 0.5));
  CHECK(clickOnly.status.cueEventCount != 0 &&
        clickOnly.status.preRollFrames == 0 &&
        clickOnly.status.countInEventCount == 0 &&
        clickOnly.status.countInBeatsPerBar == 0);

  // One count-in bar over a grid whose downbeats are every second beat: two
  // beats in the bar, two count-in events, 0.4 s of pre-roll.
  const Summary countedIn = summarize(703, cueRequest(true, 1, 0.5));
  CHECK(countedIn.status.preRollFrames == 19200 &&
        countedIn.status.countInEventCount == 2 &&
        countedIn.status.countInBeatsPerBar == 2);

  // Two count-in bars over the same grid: four events, the meter unchanged.
  singz::PlaybackCuePlanRequest twoBars = cueRequest(false, 2, 0.5);
  const Summary twoBarStatus = summarize(704, twoBars);
  CHECK(twoBarStatus.status.countInEventCount == 4 &&
        twoBarStatus.status.countInBeatsPerBar == 2 &&
        twoBarStatus.status.preRollFrames == 38400);

  CHECK(plain.status.lanes.size() == 4 && plain.peaks.lanes.size() == 4);
  const auto &monoLane = plain.peaks.lanes[0];
  const auto &stereoLane = plain.peaks.lanes[1];
  const auto &shortLane = plain.peaks.lanes[2];
  const auto &silentLane = plain.peaks.lanes[3];
  CHECK(monoLane.id == "mono" && stereoLane.id == "stereo" &&
        shortLane.id == "short" && silentLane.id == "silent");
  CHECK(monoLane.peaks.size() == buckets && monoLane.valid &&
        stereoLane.valid && shortLane.valid && silentLane.valid);

  // The envelope is the RMS over every sample of every channel in the
  // bucket — the legacy seek bar's statistic — not the peak. One spike in a
  // bucket of 400 silent frames is spike/20; the stereo lane's extra spike
  // sits in one channel of the same bucket, so both channels' 800 samples
  // carry both.
  for (size_t bucket = 0; bucket < buckets; ++bucket) {
    const double spike =
        std::fabs(pcm16(0.01F * static_cast<float>(bucket + 1)));
    const double expected = std::sqrt(spike * spike / framesPerBucket);
    CHECK(near(monoLane.peaks[bucket], static_cast<float>(expected), 1e-7F));
    const double stereoExtra =
        bucket == stereoBucket ? std::fabs(pcm16(stereoSpike)) : 0.0;
    const double expectedStereo = std::sqrt(
        (spike * spike + stereoExtra * stereoExtra) / (2.0 * framesPerBucket));
    CHECK(near(stereoLane.peaks[bucket], static_cast<float>(expectedStereo),
               1e-7F));
    CHECK(silentLane.peaks[bucket] == 0.0F);
    // Fewer frames than buckets: each bucket reads the one frame it starts
    // on rather than reporting silence the lane does not contain — and the
    // RMS of one sample is that sample's magnitude.
    const size_t frame = bucket * shortSamples.size() / buckets;
    CHECK(shortLane.peaks[bucket] == std::fabs(pcm16(shortSamples[frame])));
  }
  // The envelope is the audio's own level, never normalized to full scale.
  CHECK(monoLane.peaks[buckets - 1] < 1.0F &&
        monoLane.peaks[0] < monoLane.peaks[buckets - 1]);

  // Same input, same bytes: a second preparation of the same files.
  const Summary repeated = summarize(705, std::nullopt);
  CHECK(repeated.peaks.lanes.size() == plain.peaks.lanes.size());
  for (size_t index = 0; index < plain.peaks.lanes.size(); ++index) {
    CHECK(repeated.peaks.lanes[index].peaks ==
              plain.peaks.lanes[index].peaks &&
          repeated.peaks.lanes[index].valid ==
              plain.peaks.lanes[index].valid);
  }
  // A cue plan changes the timeline, never the lanes' own audio.
  CHECK(countedIn.peaks.lanes.size() == plain.peaks.lanes.size());
  for (size_t index = 0; index < plain.peaks.lanes.size(); ++index)
    CHECK(countedIn.peaks.lanes[index].peaks ==
          plain.peaks.lanes[index].peaks);

  std::remove(monoWav.c_str());
  std::remove(stereoWav.c_str());
  std::remove(shortWav.c_str());
  std::remove(silentWav.c_str());
}

// Legacy counts in on every Play from wherever the singer is. The native
// transport does the same through a count-in ANCHOR: the plan's pre-roll runs
// before the anchor, the transport counts down through negative frames with
// the sources silent, and on the frame the pre-roll ends it lands on the
// anchor the way a seek would. The song here is 0.1 before the anchor and 0.3
// from it on, so the first audible sample says where playback began.
void countInLandsOnAnchorMidSong() {
  constexpr uint32_t landing = 19200; // 0.4 s at 48 kHz: one two-beat bar
  constexpr uint32_t after = 3000;
  std::vector<float> song(40000, 0.1F);
  std::fill(song.begin() + landing, song.end(), 0.3F);
  const std::string wav = writeWav("count-in-anchor.wav", 1, song);
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));

  singz::NativePlaybackPrepareConfig request = config();
  request.cuePlan = cueRequest(true, 1, 0.0);
  request.cuePlan->entrySeconds = 0.0;
  request.cuePlan->countInAnchorSeconds = 0.4;
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("song", wav));
  CHECK(session.prepare(std::move(request), std::move(lanes), 1).ok);
  const singz::NativePlaybackStatus prepared = session.status();
  // Sources sit at the entry; the transport at minus the pre-roll; the count
  // of events is the two count-in beats plus the three from the anchor on.
  CHECK(prepared.preRollFrames == landing && prepared.cueEventCount == 5 &&
        prepared.renderedProjectFrame == -static_cast<int64_t>(landing) &&
        prepared.remainingPreRollFrames == landing &&
        prepared.durationFrames == 40000 && prepared.lanes.size() == 1 &&
        prepared.lanes[0].cursorFrames == 0);
  CHECK(session.openOutput(1).ok && session.start(1).ok);
  fake->captureOutput = true;
  fake->outputTrace.clear();
  uint32_t rendered = 0;
  bool first = true;
  while (rendered < landing + after) {
    const uint32_t block = std::min<uint32_t>(512, landing + after - rendered);
    CHECK(fake->drive(block, first ? singz::AudioHostDiscontinuityStart : 0));
    first = false;
    rendered += block;
  }
  fake->captureOutput = false;
  const std::vector<float> out = fake->outputTrace;
  const singz::NativePlaybackStatus played = session.status();
  // Silence through the count-in; the song's 0.3 — the sample AT the anchor,
  // not the 0.1 before it — on the very frame the pre-roll ends; and the
  // transport reads the anchor plus what it rendered since.
  CHECK(near(out[landing - 1], 0.0F, 0.00001F));
  CHECK(near(out[landing], pcm16(0.3F), 0.0001F));
  CHECK(played.transportState == singz::NativePlaybackTransportState::Playing &&
        played.renderedProjectFrame == static_cast<int64_t>(landing + after) &&
        played.remainingPreRollFrames == 0 &&
        played.lanes[0].cursorFrames == landing + after);
  const auto unloaded = session.unloadWithCleanup(1);
  CHECK(unloaded.playback.ok && unloaded.cleanup.globallyComplete());
  // Consume the fallback lease with an ordinary unload, so the tests after
  // this one start from the Available coordinator state (as the cue test
  // above does).
  singz::NativePlaybackPrepareConfig cleanupConfig = config();
  cleanupConfig.handoffLease = unloaded.cleanup.handoffLease;
  auto cleanupLanes = std::vector<singz::NativePlaybackLaneSource>{};
  cleanupLanes.push_back(lane("cleanup", wav));
  CHECK(session.prepare(std::move(cleanupConfig), std::move(cleanupLanes), 2).ok);
  CHECK(session.unload(2).ok);
  std::remove(wav.c_str());
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

/* Play on a song that ran out is `seek(0); resume()` back to back, with no
   callback between them. resume() used to resolve Playing or Completed from the
   frame the callback last PUBLISHED — still the end — so the callback applied
   the seek and then a Resume that said the song was over: Completed at frame
   zero, no sound, and Play looked ignored (measured on the iOS simulator,
   2026-09-04; Android passed the same step on timing alone). */
void resumeAfterAQueuedSeekPlaysFromWhereTheSeekLands() {
  std::vector<float> ramp(64);
  for (uint32_t frame = 0; frame < ramp.size(); ++frame)
    ramp[frame] = static_cast<float>(frame) * 0.005F;
  const std::string wav = writeWav("resume-after-seek.wav", 1, ramp);
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("song", wav));
  CHECK(session.prepare(config(), std::move(lanes), 43).ok);
  CHECK(session.openOutput(43).ok && session.start(43).ok);

  // Let the song run out on its own.
  CHECK(fake->drive(5, singz::AudioHostDiscontinuityStart));
  CHECK(fake->drive(60));
  auto status = session.status();
  CHECK(status.transportState ==
            singz::NativePlaybackTransportState::Completed &&
        status.renderedProjectFrame == 64);
  // The park: accepted, because the control domain still says Playing.
  CHECK(session.pause(43).ok && fake->drive(1));
  status = session.status();
  CHECK(status.transportState == singz::NativePlaybackTransportState::Paused &&
        status.renderedProjectFrame == 64);

  // Play again — the seek is still in the mailbox when resume() decides.
  CHECK(session.seek(43, 0).ok);
  CHECK(session.resume(43).ok);
  CHECK(fake->drive(3));
  // ramp[0] is zero, so left[0] alone would pass on silence: the teeth are
  // the two non-zero frames.
  CHECK(near(fake->left[0], pcm16(ramp[0])) &&
        near(fake->left[1], pcm16(ramp[1])) &&
        near(fake->left[2], pcm16(ramp[2])));
  status = session.status();
  CHECK(status.transportState ==
            singz::NativePlaybackTransportState::Playing &&
        status.renderedProjectFrame == 3 && status.seekCount == 1);
  // And the restarted song is pausable: both domains agree it is playing.
  CHECK(session.pause(43).ok && fake->drive(1));
  status = session.status();
  CHECK(status.transportState == singz::NativePlaybackTransportState::Paused &&
        status.renderedProjectFrame == 3);

  // A resume genuinely AT the end still ends the song — one block later, the
  // way running out does — and that completion is the natural shape: the
  // control domain says Playing, so pause() is accepted rather than refused.
  CHECK(session.seek(43, 64).ok && fake->drive(1));
  status = session.status();
  CHECK(status.transportState == singz::NativePlaybackTransportState::Paused &&
        status.renderedProjectFrame == 64);
  CHECK(session.resume(43).ok && fake->drive(1));
  status = session.status();
  CHECK(status.transportState ==
            singz::NativePlaybackTransportState::Completed &&
        status.renderedProjectFrame == 64);
  CHECK(session.pause(43).ok);
  CHECK(session.unload(43).ok);
  std::remove(wav.c_str());
}

/* Play on a song that ran out, on a graph WITH a time/pitch stage, and the
   seek arrives twice: the screen's own seek(0) and then the facade's, which
   restarts a parked song by seeking before it resumes (the two came 54 ms
   apart on an iPhone 13, 2026-09-05, and the second's boundary never
   rendered: 73 refused callbacks, graph status 202, anchor outcome 57, then
   the terminal). Each seek() primes its own Stretch replacement and the
   second prime RETIRES the first's pending slot; a callback that drains the
   first command in that window arms nothing. The contract is that the
   transport still renders once the second command arrives. */
void twoSeeksInARowAfterTheSongRanOutStillRenderWithATimePitchStage() {
  const std::string wav = writeWav("two-seeks-parked.wav", 1,
                                   std::vector<float>(4096, 0.1F));
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  singz::NativePlaybackPrepareConfig request = config();
  request.playbackRate = 0.75;
  request.transposeSemitones = 2.0;
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("song", wav));
  CHECK(session.prepare(std::move(request), std::move(lanes), 91).ok);
  CHECK(session.openOutput(91).ok && session.start(91).ok);
  CHECK(fake->drive(64, singz::AudioHostDiscontinuityStart));
  // Run out.
  for (uint32_t i = 0; i < 200; ++i)
    CHECK(fake->drive(64));
  auto status = session.status();
  CHECK(status.transportState ==
            singz::NativePlaybackTransportState::Completed &&
        status.adapterRenderFailures == 0);
  CHECK(session.pause(91).ok && fake->drive(64));
  status = session.status();
  CHECK(status.transportState == singz::NativePlaybackTransportState::Paused);

  // Back to back, no callback between: the mailbox holds both.
  const uint64_t seeksBefore = status.seekCount;
  CHECK(session.seek(91, 0).ok);
  CHECK(session.seek(91, 0).ok);
  CHECK(session.resume(91).ok);
  for (uint32_t i = 0; i < 4; ++i)
    CHECK(fake->drive(64));
  status = session.status();
  CHECK(status.adapterRenderFailures == 0 && status.graphStatusDetail != 202 &&
        status.transportState ==
            singz::NativePlaybackTransportState::Playing &&
        status.seekCount >= seeksBefore + 1 && status.renderedProjectFrame > 0 &&
        status.renderedProjectFrame < 2000);

  // One callback between the two seeks: the first is armed and consumed
  // before the second primes.
  CHECK(session.pause(91).ok && fake->drive(64));
  CHECK(session.seek(91, 0).ok && fake->drive(64));
  CHECK(session.seek(91, 0).ok && session.resume(91).ok);
  for (uint32_t i = 0; i < 4; ++i)
    CHECK(fake->drive(64));
  status = session.status();
  CHECK(status.adapterRenderFailures == 0 && status.graphStatusDetail != 202 &&
        status.transportState ==
            singz::NativePlaybackTransportState::Playing);
  CHECK(session.unload(91).ok);
  std::remove(wav.c_str());
}

/* The interleaving the session API cannot order by itself: a callback that
   drains the first seek WHILE the second seek() is priming. On the phone the
   callback comes every 21 ms and a six-lane prime took ~50 ms, so the drain
   landed inside the prime; on this Mac the prime is microseconds, so the
   callback thread here is paced and the pair is raced 600 times. Before
   per-command seek plans this wedged within the first 20 rounds (detail 202,
   anchor 57, the session Terminal after ONE refused callback — mutation-
   checked: arm from the shared mailbox again and it fails the same way).
   Nondeterministic by nature, which is why the deterministic pair test
   above sits beside it and the processor-level plan test pins the contract. */
void twoSeeksRacedAgainstTheCallbackNeverWedge() {
  const std::string wav = writeWav("two-seeks-race.wav", 2,
                                   std::vector<float>(480000, 0.1F));
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  singz::NativePlaybackPrepareConfig request = config();
  request.playbackRate = 0.75;
  request.transposeSemitones = 2.0;
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  for (int i = 0; i < 6; ++i)
    lanes.push_back(lane(("lane" + std::to_string(i)).c_str(), wav));
  CHECK(session.prepare(std::move(request), std::move(lanes), 92).ok);
  CHECK(session.openOutput(92).ok && session.start(92).ok);
  CHECK(fake->drive(64, singz::AudioHostDiscontinuityStart));
  CHECK(session.pause(92).ok && fake->drive(64));
  std::atomic<bool> stop{false};
  std::atomic<uint32_t> callbacks{0};
  std::thread rt([&] {
    while (!stop.load(std::memory_order_relaxed)) {
      (void)fake->drive(64);
      callbacks.fetch_add(1, std::memory_order_relaxed);
      std::this_thread::sleep_for(std::chrono::microseconds(200));
    }
  });
  bool healthy = true;
  for (uint32_t round = 0; round < 600 && healthy; ++round) {
    const auto first = session.seek(92, 1000 + round * 7);
    const auto second = session.seek(92, 200000 + round * 7);
    const uint32_t settle = callbacks.load() + 12;
    while (callbacks.load() < settle) {
    }
    const auto status = session.status();
    healthy = first.ok && second.ok && status.adapterRenderFailures == 0 &&
              status.graphStatusDetail != 202 &&
              status.state == singz::NativePlaybackState::Running;
    if (!healthy)
      std::fprintf(stderr,
                   "round %u: first ok=%d second ok=%d ('%s') · failures %u · "
                   "detail %u · anchor %u · state %u\n",
                   round, first.ok ? 1 : 0, second.ok ? 1 : 0,
                   second.message.c_str(), status.adapterRenderFailures,
                   status.graphStatusDetail, status.timePitchAnchorOutcome,
                   static_cast<unsigned>(status.state));
  }
  stop.store(true);
  rt.join();
  CHECK(healthy);
  CHECK(session.unload(92).ok);
  std::remove(wav.c_str());
}

// The synchronous read the phones' UI clock is built on. Its whole point is
// what it does NOT do — take the control mutex, look inside the mailbox,
// assemble a status — so the test pins what it reads (the callback's last
// published frame, block by block, equal to status()'s), what it refuses (a
// generation that is not the active one: before its prepare has committed,
// after its unload), what it leaves alone (a queued seek is NOT overlaid —
// the JS side carries that intent until seekCount moves, which is what lets
// the read stay out of the mailbox), that a paused frame stays put however
// many blocks the host asks for, and that its age is a steady-clock delta
// that grows between reads with no callback in between.
// Reads positionNow() from inside a prepare's decode — the one place a
// synchronous read provably races a control-thread command — and records
// whether it ever handed out a frame while the generation was still being
// prepared. Returns false: it never asks the decode to stop.
struct PositionNowDuringPrepare {
  singz::NativePlaybackSession *session{nullptr};
  std::atomic<uint32_t> polls{0};
  std::atomic<bool> sawAvailable{false};
};

bool probePositionNowDuringPrepare(void *opaque) noexcept {
  auto *probe = static_cast<PositionNowDuringPrepare *>(opaque);
  if (probe->session->positionNow().available)
    probe->sawAvailable.store(true, std::memory_order_relaxed);
  probe->polls.fetch_add(1u, std::memory_order_relaxed);
  return false;
}

void positionNowReadsTheCallbackWithoutTheControlLock() {
  std::vector<float> ramp(128);
  for (uint32_t frame = 0; frame < ramp.size(); ++frame)
    ramp[frame] = static_cast<float>(frame) * 0.002F;
  const std::string wav = writeWav("position-now.wav", 1, ramp);
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  // Nothing prepared: nothing to read, and it says so.
  CHECK(!session.positionNow().available);

  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("song", wav));
  CHECK(session.prepare(config(), std::move(lanes), 43).ok);
  // Prepared, not yet opened: the read already names THIS generation at its
  // entry frame, so a UI that asks between prepare and Play is not shown the
  // previous song's exit.
  auto now = session.positionNow();
  CHECK(now.available && now.generation == 43 &&
        now.transportState == singz::NativePlaybackTransportState::Stopped &&
        now.renderedProjectFrame == 0 && now.seekCount == 0);

  CHECK(session.openOutput(43).ok && session.start(43).ok);
  CHECK(fake->drive(5, singz::AudioHostDiscontinuityStart));
  CHECK(fake->drive(10));
  now = session.positionNow();
  auto status = session.status();
  CHECK(now.available && now.generation == 43 &&
        now.transportState == singz::NativePlaybackTransportState::Playing &&
        now.renderedProjectFrame == status.renderedProjectFrame &&
        now.renderedProjectFrame == 15 &&
        now.continuousFrame == status.continuousFrame && now.seekCount == 0 &&
        now.ageNs < 1'000'000'000ULL);
  // Age is a delta on the steady clock: it grows between two reads with no
  // callback between them, while the frame does not move.
  const auto earlier = session.positionNow();
  std::this_thread::sleep_for(std::chrono::milliseconds(2));
  const auto later = session.positionNow();
  CHECK(later.available && later.ageNs > earlier.ageNs &&
        later.renderedProjectFrame == earlier.renderedProjectFrame);

  // A queued seek is not overlaid: until the callback drains it the read
  // still says 15 with seekCount 0, and one block later it says the landing
  // frame with seekCount 1. status() overlays nothing here either, so the
  // two agree throughout.
  CHECK(session.seek(43, 60).ok);
  now = session.positionNow();
  CHECK(now.renderedProjectFrame == 15 && now.seekCount == 0);
  CHECK(fake->drive(1));
  now = session.positionNow();
  status = session.status();
  CHECK(now.seekCount == 1 && now.renderedProjectFrame == 61 &&
        status.renderedProjectFrame == 61);

  // Paused: the frame freezes at the block the pause landed on and stays
  // there however many blocks the host keeps asking for.
  CHECK(session.pause(43).ok && fake->drive(1));
  now = session.positionNow();
  CHECK(now.transportState == singz::NativePlaybackTransportState::Paused &&
        now.renderedProjectFrame == 61);
  CHECK(fake->drive(7));
  now = session.positionNow();
  CHECK(now.transportState == singz::NativePlaybackTransportState::Paused &&
        now.renderedProjectFrame == 61 && now.seekCount == 1);

  // Unloaded: the sink is cleared with the callback proven quiescent, and a
  // generation the session no longer owns is never handed out as a frame.
  CHECK(session.unload(43).ok);
  CHECK(!session.positionNow().available);

  // The next song publishes under its own number through the same sink —
  // and NOT before its prepare commits. Prepare admission makes 44 the
  // active generation before the decode starts, while the sink still says
  // nothing, and a read from inside the decode must come back unavailable
  // rather than lend the new song a frame it has not rendered (or the old
  // song's last one). It must also come back at all: the read takes no lock
  // the prepare could be holding. (The claim alone changes nothing here.)
  CHECK(session.claimGeneration(44));
  CHECK(!session.positionNow().available);
  auto second = std::vector<singz::NativePlaybackLaneSource>{};
  second.push_back(lane("song", wav));
  PositionNowDuringPrepare probe;
  probe.session = &session;
  CHECK(session
            .prepare(config(), std::move(second), 44,
                     {&probe, probePositionNowDuringPrepare})
            .ok);
  CHECK(probe.polls.load(std::memory_order_relaxed) > 0 &&
        !probe.sawAvailable.load(std::memory_order_relaxed));
  now = session.positionNow();
  CHECK(now.available && now.generation == 44 && now.renderedProjectFrame == 0);
  CHECK(session.unload(44).ok);
  CHECK(!session.positionNow().available);
  std::remove(wav.c_str());
}

// The background park on Android: pause the transport, then HOLD the stream
// — no close, no reopen, no re-prepare — and let it go at the next Play. What
// is pinned: a hold is refused while the transport advances (the stream keeps
// rendering, untouched); a hold on a parked transport stops the host asking
// for blocks while the clock stays exactly where it was; the release resumes
// the SAME stream (no second open, no second start) and the song continues
// from the held frame; a host that cannot hold refuses and the stream keeps
// rendering; and a held stream still closes on unload — the cleanup proof
// does not depend on the stream having been released first.
void aHeldStreamKeepsTheGraphAndResumesInPlace() {
  std::vector<float> ramp(128);
  for (uint32_t frame = 0; frame < ramp.size(); ++frame)
    ramp[frame] = static_cast<float>(frame) * 0.002F;
  const std::string wav = writeWav("held-stream.wav", 1, ramp);
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("song", wav));
  CHECK(session.prepare(config(), std::move(lanes), 44).ok);
  CHECK(session.openOutput(44).ok && session.start(44).ok);
  CHECK(fake->drive(5, singz::AudioHostDiscontinuityStart));
  CHECK(fake->drive(10));

  // Advancing: refused, and the host was never asked.
  auto held = session.suspendOutput(44);
  CHECK(!held.ok && held.error == singz::NativePlaybackError::InvalidState &&
        fake->suspends == 0 && fake->status().state == singz::AudioHostState::Running);
  CHECK(fake->drive(1));

  // Pause ASKED but not yet rendered: still refused, host untouched — a hold
  // here would freeze the stream with the callback's transport still Playing
  // and every clock projecting forward from it.
  CHECK(session.pause(44).ok);
  held = session.suspendOutput(44);
  CHECK(!held.ok && held.error == singz::NativePlaybackError::InvalidState &&
        fake->suspends == 0);
  // Parked, then held: the host stops asking for blocks, the clock stays put.
  CHECK(fake->drive(1));
  CHECK(session.suspendOutput(44).ok && fake->suspends == 1);
  auto status = session.status();
  CHECK(status.host.state == singz::AudioHostState::Suspended &&
        status.state == singz::NativePlaybackState::Running &&
        status.renderedProjectFrame == 16);
  CHECK(!fake->drive(8));
  auto now = session.positionNow();
  CHECK(now.available && now.renderedProjectFrame == 16 &&
        now.transportState == singz::NativePlaybackTransportState::Paused);
  // Holding twice is idempotent, not a second pause.
  CHECK(session.suspendOutput(44).ok && fake->suspends == 1);

  // Released: the SAME stream — no reopen, no restart — and the song goes on
  // from the held frame once the transport resumes.
  CHECK(session.resumeOutput(44).ok && fake->resumes == 1);
  CHECK(fake->opens == 1 && fake->starts == 1);
  status = session.status();
  CHECK(status.host.state == singz::AudioHostState::Running &&
        status.renderedProjectFrame == 16);
  CHECK(session.resume(44).ok && fake->drive(4));
  status = session.status();
  CHECK(status.transportState ==
            singz::NativePlaybackTransportState::Playing &&
        status.renderedProjectFrame == 20);
  // Releasing what is not held is nothing to do, not an error.
  CHECK(session.resumeOutput(44).ok && fake->resumes == 1);

  // A host that cannot hold: refused, and the stream keeps rendering.
  CHECK(session.pause(44).ok && fake->drive(1));
  fake->refuseSuspend = true;
  held = session.suspendOutput(44);
  CHECK(!held.ok && held.error == singz::NativePlaybackError::InvalidState &&
        fake->suspends == 2 && fake->status().state == singz::AudioHostState::Running);
  fake->refuseSuspend = false;
  status = session.status();
  CHECK(status.state == singz::NativePlaybackState::Running &&
        status.host.state == singz::AudioHostState::Running);

  // Held at unload: the stream still closes. (Not cleanupProof here — asking
  // it after an unload mints the process-global fallback lease, and the next
  // session's plain claim is then refused; the fake's stop count and state
  // are the closure.)
  CHECK(session.suspendOutput(44).ok && fake->suspends == 3);
  CHECK(session.unload(44).ok);
  CHECK(fake->stops == 1 && fake->status().state == singz::AudioHostState::Stopped);
  std::remove(wav.c_str());
}

// --- Replacing a generation on the running stream (Step 3 of the parity
// plan). A metronome toggle, a training change, a transpose: the player used
// to stop the stream, unload, prepare, open and start again, and the singer
// heard the gap. Now the replacement is prepared while the song plays and
// the render thread hands the clock across at a block boundary.

std::vector<float> swapRamp(uint32_t frames) {
  std::vector<float> ramp(frames);
  for (uint32_t frame = 0; frame < frames; ++frame)
    ramp[frame] = pcm16(static_cast<float>(frame % 1000) * 0.0009F + 0.01F);
  return ramp;
}

uint32_t countEvents(const Trace &trace,
                     singz::NativePlaybackLifecycleEvent event) {
  return static_cast<uint32_t>(
      std::count(trace.events.begin(), trace.events.end(), event));
}

void aSwapLandsOnTheRunningStreamWithoutAGap() {
  const std::vector<float> ramp = swapRamp(4096);
  const std::string wav = writeWav("swap-seam.wav", 1, ramp);
  Trace trace;
  singz::NativePlaybackTestHooks hooks{observe, &trace};
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend), &hooks);
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(keyedLane("song", wav));
  // Gains are set at prepare (instant), not by command (a 128-frame ramp),
  // so every output sample below is a known multiple of the lane's.
  singz::NativePlaybackPrepareConfig original = config();
  original.masterGain = 0.5F;
  CHECK(session.prepare(std::move(original), std::move(lanes), 1).ok);
  CHECK(session.openOutput(1).ok && session.start(1).ok);
  fake->captureOutput = true;
  CHECK(fake->drive(5, singz::AudioHostDiscontinuityStart));
  CHECK(fake->drive(10));
  auto status = session.status();
  CHECK(status.renderedProjectFrame == 15 && status.continuousFrame == 15);
  const uint64_t discontinuitiesBefore = status.transportDiscontinuities;
  const size_t oneGraphBytes = status.retainedBytes;
  const uint32_t deactivationsBefore =
      countEvents(trace, singz::NativePlaybackLifecycleEvent::GraphDeactivate);

  // The replacement: same lanes (adopted, not decoded again), a different
  // master gain so the seam is visible in the samples.
  singz::NativePlaybackPrepareConfig replacement = config();
  replacement.swapFromGeneration = 1;
  replacement.preparedStartProjectFrame = 15;
  replacement.masterGain = 0.25F;
  auto replacementLanes = std::vector<singz::NativePlaybackLaneSource>{};
  replacementLanes.push_back(keyedLane("song", wav));
  const auto armed =
      session.prepare(std::move(replacement), std::move(replacementLanes), 2);
  CHECK(armed.ok && armed.generation == 2 &&
        armed.state == singz::NativePlaybackState::Running);
  // Armed, not landed: the stream, its format and the old graph untouched.
  status = session.status();
  CHECK(status.generation == 2 &&
        status.state == singz::NativePlaybackState::Running &&
        status.swapPendingGeneration == 1 && status.retiringSwapGeneration == 0 &&
        status.transportGeneration == 1 && status.renderedProjectFrame == 15 &&
        status.swapLandings == 0 && status.masterGain == 0.25F);
  CHECK(status.retainedBytes > oneGraphBytes &&
        status.retainedBytes < 2 * oneGraphBytes);
  CHECK(fake->opens == 1 && fake->starts == 1 && fake->stops == 0);
  CHECK(countEvents(trace, singz::NativePlaybackLifecycleEvent::GraphDeactivate) ==
        deactivationsBefore);
  auto now = session.positionNow();
  CHECK(now.available && now.generation == 1 && now.renderedProjectFrame == 15);
  // The song is generation 2's now; generation 1 is only ever acknowledged.
  CHECK(session.pause(1).error == singz::NativePlaybackError::InvalidGeneration);
  auto proof = session.cleanupProof(1);
  CHECK(proof.safety == singz::NativePlaybackCleanupSafety::Uncertain);

  // The seam: one block. The clock carries across, the graph resets and says
  // why, and the outgoing graph is freed by the first status() after.
  CHECK(fake->drive(8));
  status = session.status();
  CHECK(status.generation == 2 && status.transportGeneration == 2 &&
        status.state == singz::NativePlaybackState::Running &&
        status.transportState == singz::NativePlaybackTransportState::Playing &&
        status.renderedProjectFrame == 23 && status.continuousFrame == 23 &&
        status.transportDiscontinuities == discontinuitiesBefore + 1 &&
        status.lastTransportBoundary ==
            singz::NativePlaybackTransportBoundaryReason::ClockReanchored &&
        status.swapLandings == 1 && status.swapLateLandings == 0 &&
        status.swapPendingGeneration == 0 &&
        status.retiringSwapGeneration == 0 &&
        status.adapterRenderFailures == 0 &&
        status.terminalRenderFailures == 0);
  CHECK(status.retainedBytes == oneGraphBytes);
  CHECK(countEvents(trace, singz::NativePlaybackLifecycleEvent::GraphDeactivate) ==
        deactivationsBefore + 1);
  CHECK(fake->opens == 1 && fake->starts == 1 && fake->stops == 0);
  now = session.positionNow();
  CHECK(now.available && now.generation == 2 && now.renderedProjectFrame == 23);
  CHECK(fake->drive(9));
  fake->captureOutput = false;
  // Every frame of the song reached the output exactly once, the first 15 at
  // the old gain and the rest at the new one: no repeat, no skip, no silence.
  CHECK(fake->outputTrace.size() == 32);
  for (uint32_t frame = 0; frame < 32; ++frame)
    CHECK(near(fake->outputTrace[frame],
               ramp[frame] * (frame < 15 ? 0.5F : 0.25F), 0.00002F));

  proof = session.cleanupProof(1);
  CHECK(proof.safety == singz::NativePlaybackCleanupSafety::NotOwned);
  CHECK(session.unload(1).ok);
  CHECK(session.seek(1, 0).error ==
        singz::NativePlaybackError::InvalidGeneration);
  status = session.status();
  CHECK(status.generation == 2 &&
        status.state == singz::NativePlaybackState::Running &&
        status.renderedProjectFrame == 32);

  // A second swap on the same stream, back to a louder mix.
  singz::NativePlaybackPrepareConfig third = config();
  third.swapFromGeneration = 2;
  third.preparedStartProjectFrame = 32;
  third.masterGain = 1.0F;
  auto thirdLanes = std::vector<singz::NativePlaybackLaneSource>{};
  thirdLanes.push_back(keyedLane("song", wav));
  CHECK(session.prepare(std::move(third), std::move(thirdLanes), 3).ok);
  fake->outputTrace.clear();
  fake->captureOutput = true;
  // Two blocks with no status() between them: the render thread alone must
  // put the request down after landing it, or the second block would land
  // it again and drag the clock back to the outgoing transport's frame.
  CHECK(fake->drive(8) && fake->drive(8));
  fake->captureOutput = false;
  status = session.status();
  CHECK(status.generation == 3 && status.transportGeneration == 3 &&
        status.renderedProjectFrame == 48 && status.swapLandings == 2 &&
        status.retiringSwapGeneration == 0);
  for (uint32_t frame = 0; frame < 16; ++frame)
    CHECK(near(fake->outputTrace[frame], ramp[32 + frame], 0.00002F));
  CHECK(session.pause(3).ok && fake->drive(1));
  // A plain unload, not a cleanup proof: the proof mints the process
  // fallback lease, and the next test's plain claim would be refused.
  CHECK(session.unload(3).ok && fake->stops == 1);
  CHECK(session.cleanupProof(2).safety ==
        singz::NativePlaybackCleanupSafety::NotOwned);
  std::remove(wav.c_str());
}

void aSwapWhilePausedLandsAtTheNextBlockAndKeepsTheFrame() {
  const std::vector<float> ramp = swapRamp(2048);
  const std::string wav = writeWav("swap-paused.wav", 1, ramp);
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(keyedLane("song", wav));
  CHECK(session.prepare(config(), std::move(lanes), 7).ok);
  CHECK(session.openOutput(7).ok && session.start(7).ok);
  CHECK(fake->drive(12, singz::AudioHostDiscontinuityStart));
  CHECK(session.pause(7).ok && fake->drive(4));
  auto status = session.status();
  CHECK(status.transportState == singz::NativePlaybackTransportState::Paused &&
        status.renderedProjectFrame == 12 && status.continuousFrame == 16);

  singz::NativePlaybackPrepareConfig replacement = config();
  replacement.swapFromGeneration = 7;
  replacement.preparedStartProjectFrame = 12;
  replacement.initialTransport.startPaused = true;
  auto replacementLanes = std::vector<singz::NativePlaybackLaneSource>{};
  replacementLanes.push_back(keyedLane("song", wav));
  CHECK(session.prepare(std::move(replacement), std::move(replacementLanes), 8)
            .ok);
  // Paused is carried across untouched: the seam does not move the song.
  CHECK(fake->drive(4));
  status = session.status();
  CHECK(status.generation == 8 && status.transportGeneration == 8 &&
        status.transportState == singz::NativePlaybackTransportState::Paused &&
        status.renderedProjectFrame == 12 && status.continuousFrame == 20 &&
        status.swapLandings == 1);
  auto now = session.positionNow();
  CHECK(now.available && now.generation == 8 && now.renderedProjectFrame == 12 &&
        now.transportState == singz::NativePlaybackTransportState::Paused);
  // A resume queued into the replacement plays on from the held frame.
  CHECK(session.resume(8).ok && fake->drive(5));
  status = session.status();
  CHECK(status.transportState == singz::NativePlaybackTransportState::Playing &&
        status.renderedProjectFrame == 17);
  // The stream can still be held and released, under the new generation.
  CHECK(session.pause(8).ok && fake->drive(1));
  CHECK(session.suspendOutput(8).ok && session.resumeOutput(8).ok);
  CHECK(session.unload(8).ok && fake->stops == 1);
  std::remove(wav.c_str());
}

void stoppingDuringAnArmedSwapRetiresBothGraphs() {
  const std::vector<float> ramp = swapRamp(2048);
  const std::string wav = writeWav("swap-stop.wav", 1, ramp);
  Trace trace;
  singz::NativePlaybackTestHooks hooks{observe, &trace};
  for (const bool viaStop : {false, true}) {
    trace.events.clear();
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend), &hooks);
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(keyedLane("song", wav));
    CHECK(session.prepare(config(), std::move(lanes), 20).ok);
    CHECK(session.openOutput(20).ok && session.start(20).ok);
    CHECK(fake->drive(8, singz::AudioHostDiscontinuityStart));
    singz::NativePlaybackPrepareConfig replacement = config();
    replacement.swapFromGeneration = 20;
    replacement.preparedStartProjectFrame = 8;
    auto replacementLanes = std::vector<singz::NativePlaybackLaneSource>{};
    replacementLanes.push_back(keyedLane("song", wav));
    CHECK(session.prepare(std::move(replacement), std::move(replacementLanes),
                          21)
              .ok);
    CHECK(session.status().swapPendingGeneration == 20);
    // Armed but never landed: no block was rendered. Both graphs retire on
    // the one stop, and nothing of either is left behind.
    if (viaStop) {
      CHECK(session.stop(21).ok);
      CHECK(fake->stops == 1 && session.status().state ==
                                    singz::NativePlaybackState::Stopped);
    }
    const auto unloaded = session.unloadWithCleanup(21);
    CHECK(unloaded.playback.ok && fake->stops == 1 &&
          unloaded.cleanup.globallyComplete() &&
          unloaded.cleanup.retainedBytes == 0);
    CHECK(countEvents(trace,
                      singz::NativePlaybackLifecycleEvent::GraphDeactivate) == 2);
    CHECK(session.cleanupProof(20).safety ==
              singz::NativePlaybackCleanupSafety::NotOwned &&
          session.unload(20).ok);
    // The session is empty enough to start over.
    singz::NativePlaybackPrepareConfig fresh = config();
    fresh.handoffLease = unloaded.cleanup.handoffLease;
    auto freshLanes = std::vector<singz::NativePlaybackLaneSource>{};
    freshLanes.push_back(keyedLane("song", wav));
    CHECK(session.prepare(std::move(fresh), std::move(freshLanes), 22).ok);
    CHECK(session.unload(22).ok);
  }
  std::remove(wav.c_str());
}

void aSwapIsRefusedWhereItCouldNotLand() {
  const std::vector<float> ramp = swapRamp(2048);
  const std::string wav = writeWav("swap-refused.wav", 1, ramp);
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  const auto swapPrepare = [&](uint64_t from, uint64_t to) {
    singz::NativePlaybackPrepareConfig replacement = config();
    replacement.swapFromGeneration = from;
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(keyedLane("song", wav));
    return session.prepare(std::move(replacement), std::move(lanes), to);
  };
  // Every refused candidate is answered as a cancelled generation is, the
  // way the player unloads a failed prepare: nothing of it exists, and
  // asking is not an error.
  const auto refused = [&](const singz::NativePlaybackResult &result) {
    CHECK(!result.ok &&
          result.error == singz::NativePlaybackError::InvalidState);
    CHECK(session.unload(result.generation).ok);
    CHECK(session.cleanupProof(result.generation).safety ==
          singz::NativePlaybackCleanupSafety::NotOwned);
  };
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(keyedLane("song", wav));
  // Merely prepared: there is no stream to land on.
  CHECK(session.prepare(config(), std::move(lanes), 30).ok);
  refused(swapPrepare(30, 31));
  auto status = session.status();
  CHECK(status.generation == 30 &&
        status.state == singz::NativePlaybackState::Prepared);
  // ...and the song it would have replaced is still the singer's to drive.
  CHECK(session.openOutput(30).ok && session.start(30).ok);
  CHECK(fake->drive(8, singz::AudioHostDiscontinuityStart));
  // A generation this session is not rendering.
  refused(swapPrepare(29, 32));
  refused(swapPrepare(0x7777, 33));
  // A held stream renders no blocks, so the seam could never come.
  CHECK(session.pause(30).ok && fake->drive(1));
  CHECK(session.suspendOutput(30).ok);
  refused(swapPrepare(30, 34));
  CHECK(session.resumeOutput(30).ok && session.resume(30).ok);
  CHECK(fake->drive(4));
  status = session.status();
  CHECK(status.generation == 30 &&
        status.state == singz::NativePlaybackState::Running &&
        status.transportState == singz::NativePlaybackTransportState::Playing &&
        status.renderedProjectFrame == 12 && status.swapLandings == 0);
  CHECK(fake->opens == 1 && fake->starts == 1 && fake->stops == 0);
  // And once the stream is running again, a swap lands as usual.
  CHECK(swapPrepare(30, 35).ok && fake->drive(3));
  status = session.status();
  CHECK(status.generation == 35 && status.transportGeneration == 35 &&
        status.renderedProjectFrame == 15 && status.swapLandings == 1);
  CHECK(session.unload(35).ok && fake->stops == 1);
  std::remove(wav.c_str());
}

void aFailedOrCancelledSwapCandidateLeavesTheSongPlaying() {
  const std::vector<float> ramp = swapRamp(2048);
  const std::string wav = writeWav("swap-candidate.wav", 1, ramp);
  {
    // A candidate that cannot be prepared: a lane that is not there.
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(keyedLane("song", wav));
    CHECK(session.prepare(config(), std::move(lanes), 40).ok);
    CHECK(session.openOutput(40).ok && session.start(40).ok);
    CHECK(fake->drive(8, singz::AudioHostDiscontinuityStart));
    singz::NativePlaybackPrepareConfig replacement = config();
    replacement.swapFromGeneration = 40;
    auto broken = std::vector<singz::NativePlaybackLaneSource>{};
    broken.push_back(keyedLane("song", wav));
    broken.push_back(keyedLane("missing", scratch("swap-not-there.wav")));
    const auto failed =
        session.prepare(std::move(replacement), std::move(broken), 41);
    CHECK(!failed.ok && failed.error != singz::NativePlaybackError::InvalidState);
    auto status = session.status();
    CHECK(status.generation == 40 &&
          status.state == singz::NativePlaybackState::Running &&
          status.swapPendingGeneration == 0 && status.error.empty());
    // The song plays on and answers its own commands.
    CHECK(fake->drive(4) && session.pause(40).ok && fake->drive(1) &&
          session.resume(40).ok && fake->drive(3));
    status = session.status();
    CHECK(status.renderedProjectFrame == 15 &&
          status.transportState ==
              singz::NativePlaybackTransportState::Playing);
    CHECK(session.unload(41).ok && session.stop(41).ok &&
          session.cleanupProof(41).safety ==
              singz::NativePlaybackCleanupSafety::NotOwned);
    // The next candidate is fine.
    singz::NativePlaybackPrepareConfig again = config();
    again.swapFromGeneration = 40;
    auto goodLanes = std::vector<singz::NativePlaybackLaneSource>{};
    goodLanes.push_back(keyedLane("song", wav));
    CHECK(session.prepare(std::move(again), std::move(goodLanes), 42).ok);
    CHECK(fake->drive(5));
    status = session.status();
    CHECK(status.generation == 42 && status.transportGeneration == 42 &&
          status.renderedProjectFrame == 20);
    CHECK(session.unload(42).ok);
  }
  for (const bool viaUnload : {false, true}) {
    // A candidate given up on while it is being built: cancelled by name,
    // and the song behind it never notices.
    PublicationLatch latch;
    singz::NativePlaybackTestHooks hooks{blockPublication, &latch};
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend), &hooks);
    latch.enabled = false;
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(keyedLane("song", wav));
    CHECK(session.prepare(config(), std::move(lanes), 50).ok);
    CHECK(session.openOutput(50).ok && session.start(50).ok);
    CHECK(fake->drive(8, singz::AudioHostDiscontinuityStart));
    latch.enabled = true;
    singz::NativePlaybackResult candidate;
    std::thread preparing([&] {
      singz::NativePlaybackPrepareConfig replacement = config();
      replacement.swapFromGeneration = 50;
      auto replacementLanes = std::vector<singz::NativePlaybackLaneSource>{};
      replacementLanes.push_back(keyedLane("song", wav));
      candidate = session.prepare(std::move(replacement),
                                  std::move(replacementLanes), 51);
    });
    waitUntilReady(&latch);
    // While the candidate is compiled the song keeps rendering and taking
    // commands under its own number.
    CHECK(fake->drive(4) && session.pause(50).ok && fake->drive(1) &&
          session.resume(50).ok);
    if (viaUnload)
      CHECK(session.unload(51).ok);
    else
      CHECK(session.requestCancellation(51));
    releasePublication(&latch);
    preparing.join();
    CHECK(!candidate.ok &&
          candidate.error == singz::NativePlaybackError::Cancelled);
    latch.enabled = false;
    CHECK(fake->drive(3));
    auto status = session.status();
    CHECK(status.generation == 50 &&
          status.state == singz::NativePlaybackState::Running &&
          status.transportGeneration == 50 &&
          status.renderedProjectFrame == 15 && status.swapLandings == 0 &&
          status.swapPendingGeneration == 0);
    CHECK(session.unload(51).ok &&
          session.cleanupProof(51).safety ==
              singz::NativePlaybackCleanupSafety::NotOwned);
    CHECK(session.unload(50).ok && fake->stops == 1);
  }
  std::remove(wav.c_str());
}

// The one path a swap adds to the quarantine story: a stream that never
// proves quiescence takes BOTH graphs and the render block with it, and the
// callback it may still be running lands the seam it was armed for out of
// memory nothing freed. Its own process — the quarantine is process-global
// and terminal.
void aQuarantinedSwapKeepsRenderingAfterTheSessionIsGone() {
  const std::vector<float> ramp = swapRamp(2048);
  const std::string wav = writeWav("swap-quarantine.wav", 1, ramp);
  CallbackCapture capture;
  {
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    fake->capture = &capture;
    fake->uncertainStop = true;
    singz::NativePlaybackSession session(std::move(backend));
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(keyedLane("song", wav));
    CHECK(session.prepare(config(), std::move(lanes), 70).ok);
    CHECK(session.openOutput(70).ok && session.start(70).ok);
    CHECK(fake->drive(8, singz::AudioHostDiscontinuityStart));
    singz::NativePlaybackPrepareConfig replacement = config();
    replacement.swapFromGeneration = 70;
    replacement.preparedStartProjectFrame = 8;
    replacement.masterGain = 0.5F;
    auto replacementLanes = std::vector<singz::NativePlaybackLaneSource>{};
    replacementLanes.push_back(keyedLane("song", wav));
    CHECK(session.prepare(std::move(replacement), std::move(replacementLanes),
                          71)
              .ok);
    CHECK(session.status().swapPendingGeneration == 70);
    // The session goes away with a host that will not confirm quiescence.
  }
  CHECK(capture.callback != nullptr && capture.context != nullptr);
  const auto proof = singz::NativePlaybackSession().cleanupProof(71);
  CHECK(proof.processQuarantinePoisoned);

  // The host keeps calling. The seam lands and the song plays on from frame
  // 8 at the replacement's gain; nothing it touches has been freed.
  std::array<float, 8> left{};
  std::array<float, 8> right{};
  float *output[]{left.data(), right.data()};
  uint64_t rendered = 8;
  for (uint32_t block = 0; block < 3; ++block) {
    std::fill(left.begin(), left.end(), 1.0F);
    std::fill(right.begin(), right.end(), 1.0F);
    singz::AudioHostRenderBlock view{
        nullptr, output, 0,     2,     8,    8,    48000.0, 1, 1, 1,
        block + 2, 0,    0,     false, false, rendered, 0, true, true,
        0,       0,      true};
    CHECK(capture.callback(capture.context, view));
    for (uint32_t frame = 0; frame < 8; ++frame)
      CHECK(near(left[frame], ramp[rendered + frame] * 0.5F, 0.00002F));
    rendered += 8;
  }
  std::remove(wav.c_str());
}

// A terminal boundary on the block after the arm: the outgoing generation
// latches it, and the swap must NOT land on top of that — the session reads
// the latch off the generation that is rendering, and both graphs retire on
// the stop that follows.
void aSwapWaitsOnAnOutgoingGenerationThatLatchedTerminal() {
  const std::vector<float> ramp = swapRamp(2048);
  const std::string wav = writeWav("swap-latched.wav", 1, ramp);
  Trace trace;
  singz::NativePlaybackTestHooks hooks{observe, &trace};
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend), &hooks);
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(keyedLane("song", wav));
  CHECK(session.prepare(config(), std::move(lanes), 80).ok);
  CHECK(session.openOutput(80).ok && session.start(80).ok);
  CHECK(fake->drive(8, singz::AudioHostDiscontinuityStart));
  singz::NativePlaybackPrepareConfig replacement = config();
  replacement.swapFromGeneration = 80;
  replacement.preparedStartProjectFrame = 8;
  auto replacementLanes = std::vector<singz::NativePlaybackLaneSource>{};
  replacementLanes.push_back(keyedLane("song", wav));
  CHECK(session.prepare(std::move(replacement), std::move(replacementLanes),
                        81)
            .ok);
  // The route goes away on the very block the seam was due on, and then the
  // host (as a real one would not, but the fake does) keeps calling.
  CHECK(!fake->drive(4, singz::AudioHostDiscontinuityRouteChanged));
  CHECK(!fake->drive(4));
  auto status = session.status();
  CHECK(status.swapLandings == 0 && status.swapPendingGeneration == 80 &&
        status.state == singz::NativePlaybackState::Terminal &&
        status.terminalReason == singz::AudioHostTerminalReason::RouteChanged);
  CHECK(session.unload(81).ok && fake->stops == 1);
  CHECK(countEvents(trace, singz::NativePlaybackLifecycleEvent::GraphDeactivate) ==
        2);
  // (Not the unloaded generation's own proof: that one mints the process
  // fallback lease and the next test's plain claim would be refused.)
  CHECK(session.cleanupProof(80).safety ==
        singz::NativePlaybackCleanupSafety::NotOwned);
  std::remove(wav.c_str());
}

// --- Rate and pitch swaps land on the frame their Stretch anchor was filled
// for (Step 3b). The control thread predicts where the outgoing clock will
// be a few blocks ahead, primes the incoming graph's anchor there, and the
// render thread splits the block on that stream frame.

void aRateChangeSwapLandsOnItsAnchorFrame() {
  const std::vector<float> ramp = swapRamp(4096);
  const std::string wav = writeWav("swap-rate.wav", 1, ramp);
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(keyedLane("song", wav));
  CHECK(session.prepare(config(), std::move(lanes), 100).ok);
  CHECK(session.openOutput(100).ok && session.start(100).ok);
  // The fake's nominal buffer is 2 frames, so the landing is armed 6 stream
  // frames ahead of the last publication.
  CHECK(fake->drive(8, singz::AudioHostDiscontinuityStart));
  CHECK(fake->drive(8));
  auto status = session.status();
  CHECK(status.renderedProjectFrame == 16 && status.continuousFrame == 16);

  // 1.0 → 0.75: the candidate gains a Stretch stage.
  const auto swapTo = [&](uint64_t from, uint64_t to, double rate) {
    singz::NativePlaybackPrepareConfig replacement = config();
    replacement.swapFromGeneration = from;
    replacement.playbackRate = rate;
    replacement.preparedStartProjectFrame = session.status().renderedProjectFrame;
    auto replacementLanes = std::vector<singz::NativePlaybackLaneSource>{};
    replacementLanes.push_back(keyedLane("song", wav));
    return session.prepare(std::move(replacement), std::move(replacementLanes),
                           to);
  };
  CHECK(swapTo(100, 101, 0.75).ok);
  status = session.status();
  CHECK(status.swapPendingGeneration == 100 &&
        status.timePitchAnchorsPublished == 0);
  // Not in this block (4 < 6 frames ahead) …
  CHECK(fake->drive(4));
  status = session.status();
  CHECK(status.transportGeneration == 100 && status.renderedProjectFrame == 20 &&
        status.swapLandings == 0);
  // … but two frames into the next: 2 frames at 1.0 (→ 22), then 6 at 0.75
  // (→ 26.5). Exactly where the anchor was filled for.
  CHECK(fake->drive(8));
  status = session.status();
  CHECK(status.transportGeneration == 101 && status.continuousFrame == 28 &&
        status.renderedProjectFrame == 26 && status.swapLandings == 1 &&
        status.swapLateLandings == 0 &&
        status.lastTransportBoundary ==
            singz::NativePlaybackTransportBoundaryReason::ClockReanchored &&
        status.timePitchAnchorOutcome == 40 &&
        status.timePitchAnchorsPublished == 1 &&
        status.timePitchAnchorMisses == 0 && status.adapterRenderFailures == 0 &&
        status.graphStatusDetail == 0);
  CHECK(fake->drive(8));
  status = session.status();
  CHECK(status.renderedProjectFrame == 32 && status.continuousFrame == 36 &&
        status.timePitchAnchorMisses == 0);

  // 0.75 → 1.25: both graphs carry a stage; the seam is exact again and the
  // new stage publishes exactly one anchor.
  CHECK(swapTo(101, 102, 1.25).ok);
  CHECK(fake->drive(8) && fake->drive(8));
  status = session.status();
  CHECK(status.transportGeneration == 102 && status.swapLandings == 2 &&
        status.swapLateLandings == 0 && status.timePitchAnchorOutcome == 40 &&
        status.timePitchAnchorsPublished == 1 &&
        status.timePitchAnchorMisses == 0 && status.adapterRenderFailures == 0);
  // continuous 52; landing at 42 = 6 frames at 0.75 from 32.5 (→ 37.0),
  // then 10 at 1.25 (→ 49.5).
  CHECK(status.continuousFrame == 52 && status.renderedProjectFrame == 49);

  // 1.25 → 1.0: the stage goes away; no anchor to land on, nothing late.
  CHECK(swapTo(102, 103, 1.0).ok);
  CHECK(fake->drive(8));
  status = session.status();
  CHECK(status.transportGeneration == 103 && status.swapLandings == 3 &&
        status.swapLateLandings == 0 && status.timePitchAnchorOutcome == 0 &&
        status.renderedProjectFrame == 57 && status.continuousFrame == 60);

  // Paused: the seam lands on the next block at the parked frame, and that
  // IS the anchor's frame — exact, and the anchor publishes on resume.
  CHECK(session.pause(103).ok && fake->drive(4));
  CHECK(swapTo(103, 104, 0.8).ok);
  CHECK(fake->drive(4));
  status = session.status();
  CHECK(status.transportGeneration == 104 && status.swapLandings == 4 &&
        status.swapLateLandings == 0 && status.renderedProjectFrame == 57 &&
        status.transportState == singz::NativePlaybackTransportState::Paused &&
        status.timePitchAnchorOutcome == 40 &&
        status.timePitchAnchorsPublished == 1);
  CHECK(session.resume(104).ok && fake->drive(5));
  status = session.status();
  CHECK(status.renderedProjectFrame == 61 && status.timePitchAnchorMisses == 0);
  CHECK(session.unload(104).ok);
  std::remove(wav.c_str());
}

void aSwapArmedBehindAnUnappliedCommandLandsUnanchored() {
  const std::vector<float> ramp = swapRamp(4096);
  const std::string wav = writeWav("swap-unapplied.wav", 1, ramp);
  // An injected prime cost: the arm below can predict nothing, and must
  // still say what the stage cost.
  singz::NativePlaybackTestHooks hooks{};
  hooks.timePitchPrimeNs = 20'000'000;
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend), &hooks);
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(keyedLane("song", wav));
  CHECK(session.prepare(config(), std::move(lanes), 110).ok);
  CHECK(session.openOutput(110).ok && session.start(110).ok);
  CHECK(fake->drive(8, singz::AudioHostDiscontinuityStart));
  // A seek the callback has not applied yet: the prediction would be for the
  // wrong place, so none is made, and the seam lands on the next block with
  // the stage's prepared state (frame 8's, a few frames off) rather than an
  // anchor for a frame the song is not at.
  CHECK(session.seek(110, 1000).ok);
  singz::NativePlaybackPrepareConfig replacement = config();
  replacement.swapFromGeneration = 110;
  replacement.playbackRate = 0.75;
  replacement.preparedStartProjectFrame = 8;
  auto replacementLanes = std::vector<singz::NativePlaybackLaneSource>{};
  replacementLanes.push_back(keyedLane("song", wav));
  CHECK(session.prepare(std::move(replacement), std::move(replacementLanes),
                        111)
            .ok);
  CHECK(fake->drive(8));
  auto status = session.status();
  // An unanchored seam is a counted miss on the new stage (the diagnostic
  // the Stretch keeps for a generic boundary it had nothing prepared for),
  // and nothing was late: no frame was ever asked for.
  CHECK(status.transportGeneration == 111 && status.swapLandings == 1 &&
        status.swapLateLandings == 0 && status.timePitchAnchorOutcome == 42 &&
        status.timePitchAnchorsPublished == 0 &&
        status.timePitchAnchorMisses == 1 &&
        status.renderedProjectFrame == 1006 && status.adapterRenderFailures == 0);
  // What the arm reports for a seam it could not predict: the prime cost it
  // measured, and no budget — the next block's first frame.
  CHECK(status.swapPrimeNs == 20'000'000 && status.swapLandingFrames == 0);
  // And the song is fine from there: a seek on the new generation anchors
  // as any seek does.
  CHECK(session.seek(111, 2000).ok && fake->drive(8));
  status = session.status();
  CHECK(status.renderedProjectFrame == 2006 &&
        status.timePitchAnchorsPublished == 1 &&
        status.timePitchAnchorMisses == 1);
  CHECK(session.unload(111).ok);
  std::remove(wav.c_str());
}

enum class LoopSwapShape { LoopToSongEnd, IncomingDropsLoop, SeamOnTheWrap };

void aLoopSurvivesARateSwapAcrossItsWrap() {
  const std::vector<float> ramp = swapRamp(60000);
  const std::string wav = writeWav("swap-loop.wav", 1, ramp);
  // Three loop shapes the prediction has to get right: a loop to the END of
  // the song crossed on the way to the seam (where a wrap the prediction
  // skipped would let the duration stop the advance instead); an outgoing
  // loop the incoming generation does not have (where the end wrap by the
  // incoming loop is no substitute for wrapping on the way); and a seam that
  // falls exactly on the loop end (where the outgoing transport hands over
  // the PRE-wrap frame, and the handoff itself must wrap it).
  for (const LoopSwapShape shape :
       {LoopSwapShape::LoopToSongEnd, LoopSwapShape::IncomingDropsLoop,
        LoopSwapShape::SeamOnTheWrap}) {
    const bool incomingLoops = shape != LoopSwapShape::IncomingDropsLoop;
    const bool seamOnTheWrap = shape == LoopSwapShape::SeamOnTheWrap;
    const int64_t loopEnd = shape == LoopSwapShape::LoopToSongEnd ? 60000 : 20000;
    auto backend = std::make_unique<ManualOutputBackend>();
    ManualOutputBackend *fake = backend.get();
    singz::NativePlaybackSession session(std::move(backend));
    singz::NativePlaybackPrepareConfig looping = config();
    looping.playbackRate = 0.75;
    // 8 frames at 0.75 land one frame short of the loop end, or four short
    // for the seam that is to fall on it (6 × 0.75 = 4.5 → loopEnd + 0.5).
    looping.preparedStartProjectFrame = loopEnd - (seamOnTheWrap ? 10 : 7);
    looping.initialTransport.loop =
        singz::NativePlaybackInitialLoop{1000, loopEnd};
    auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
    lanes.push_back(keyedLane("song", wav));
    CHECK(session.prepare(std::move(looping), std::move(lanes), 120).ok);
    CHECK(session.openOutput(120).ok && session.start(120).ok);
    CHECK(fake->drive(8, singz::AudioHostDiscontinuityStart));
    auto status = session.status();
    const int64_t before = loopEnd - (seamOnTheWrap ? 4 : 1);
    CHECK(status.renderedProjectFrame == before && status.loopCount == 0);
    // The seam is armed 6 stream frames ahead. One frame short: 2 of them
    // reach the loop end (→ loopEnd + 0.5), the wrap lands at 1000.5, and 4
    // more at 0.75 put the seam at 1003.5. Four short: all 6 reach exactly
    // loopEnd + 0.5, the outgoing hands that over, the handoff wraps it to
    // 1000.5.
    singz::NativePlaybackPrepareConfig replacement = config();
    replacement.swapFromGeneration = 120;
    replacement.playbackRate = 1.25;
    replacement.preparedStartProjectFrame = before;
    if (incomingLoops)
      replacement.initialTransport.loop =
          singz::NativePlaybackInitialLoop{1000, loopEnd};
    auto replacementLanes = std::vector<singz::NativePlaybackLaneSource>{};
    replacementLanes.push_back(keyedLane("song", wav));
    CHECK(session.prepare(std::move(replacement), std::move(replacementLanes),
                          121)
              .ok);
    CHECK(fake->drive(8));
    status = session.status();
    CHECK(status.transportGeneration == 121 && status.swapLandings == 1 &&
          status.swapLateLandings == 0 && status.timePitchAnchorOutcome == 40 &&
          status.loopCount == 1 && status.loopEnabled == incomingLoops &&
          status.timePitchAnchorsPublished == 1 &&
          status.timePitchAnchorMisses == 0 && status.adapterRenderFailures == 0);
    // 1003.5 + 2 × 1.25 = 1006, or 1000.5 + 2 × 1.25 = 1003.
    CHECK(status.renderedProjectFrame == (seamOnTheWrap ? 1003 : 1006) &&
          status.continuousFrame == 16);
    if (incomingLoops) {
      // The new generation's loop bank is live: the next wrap is its own.
      CHECK(session.seek(121, loopEnd - 5).ok);
      CHECK(fake->drive(8) && fake->drive(8));
      status = session.status();
      CHECK(status.loopCount == 2 && status.renderedProjectFrame >= 1000 &&
            status.renderedProjectFrame < 1020 &&
            status.adapterRenderFailures == 0 &&
            status.timePitchAnchorMisses == 0 && status.timePitchLoopPriming);
    } else {
      // No loop any more: the song plays on past where the old one wrapped.
      CHECK(session.seek(121, 19995).ok && fake->drive(8));
      status = session.status();
      CHECK(status.renderedProjectFrame == 20005 && status.loopCount == 1 &&
            status.adapterRenderFailures == 0);
    }
    CHECK(session.unload(121).ok);
  }
  std::remove(wav.c_str());
}

// A phone primes a Stretch stage in tens of milliseconds where this suite
// takes microseconds, and the swap re-primes the candidate AFTER predicting
// its landing: measured on the POCO, every rate-change seam landed late by
// exactly that price. The budget therefore grows by twice the prime cost the
// candidate's prepare measured — and the seam still lands on the frame.
void aSlowStretchPrimeStretchesTheLandingBudget() {
  const std::vector<float> ramp = swapRamp(60000);
  const std::string wav = writeWav("swap-slow-prime.wav", 1, ramp);
  // Two sessions, in turn: the process coordinator owns one at a time, and a
  // session hands ownership back only when it is destroyed.
  {
  singz::NativePlaybackTestHooks hooks{};
  // 20 ms at 48 kHz: 960 frames, one and a half times that is 1440, plus
  // the three two-frame nominal buffers of the fake.
  hooks.timePitchPrimeNs = 20'000'000;
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend), &hooks);
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(keyedLane("song", wav));
  CHECK(session.prepare(config(), std::move(lanes), 140).ok);
  CHECK(session.openOutput(140).ok && session.start(140).ok);
  CHECK(fake->drive(8, singz::AudioHostDiscontinuityStart));
  singz::NativePlaybackPrepareConfig replacement = config();
  replacement.swapFromGeneration = 140;
  replacement.playbackRate = 0.75;
  replacement.preparedStartProjectFrame = 8;
  auto replacementLanes = std::vector<singz::NativePlaybackLaneSource>{};
  replacementLanes.push_back(keyedLane("song", wav));
  CHECK(session.prepare(std::move(replacement), std::move(replacementLanes),
                        141)
            .ok);
  // Armed for stream frame 8 + 6 + 1440 = 1454: eleven full blocks of 128
  // stay the outgoing generation's, the twelfth splits at offset 38.
  auto status = session.status();
  CHECK(status.swapPrimeNs == 20'000'000 && status.swapLandingFrames == 1446);
  for (uint32_t block = 0; block < 11; ++block)
    CHECK(fake->drive(128));
  status = session.status();
  CHECK(status.transportGeneration == 140 && status.swapLandings == 0 &&
        status.continuousFrame == 1416 && status.renderedProjectFrame == 1416);
  CHECK(fake->drive(128));
  status = session.status();
  // 1454 at 1.0, then 90 frames at 0.75 → 1521.5.
  CHECK(status.transportGeneration == 141 && status.swapLandings == 1 &&
        status.swapLateLandings == 0 && status.timePitchAnchorOutcome == 40 &&
        status.timePitchAnchorsPublished == 1 &&
        status.timePitchAnchorMisses == 0 && status.continuousFrame == 1544 &&
        status.renderedProjectFrame == 1521);
  // The cap: a prime the budget cannot afford is bought only up to the cap,
  // which stays below the facade's wait, and the seam lands (late) rather
  // than being given up.
  CHECK(session.unload(141).ok);
  }
  {
  auto capped = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *cappedFake = capped.get();
  singz::NativePlaybackTestHooks slow{};
  slow.timePitchPrimeNs = 3'000'000'000; // 3 s
  singz::NativePlaybackSession slowSession(std::move(capped), &slow);
  auto slowLanes = std::vector<singz::NativePlaybackLaneSource>{};
  slowLanes.push_back(keyedLane("song", wav));
  CHECK(slowSession.prepare(config(), std::move(slowLanes), 150).ok);
  CHECK(slowSession.openOutput(150).ok && slowSession.start(150).ok);
  CHECK(cappedFake->drive(8, singz::AudioHostDiscontinuityStart));
  singz::NativePlaybackPrepareConfig slowReplacement = config();
  slowReplacement.swapFromGeneration = 150;
  slowReplacement.playbackRate = 0.75;
  slowReplacement.preparedStartProjectFrame = 8;
  auto slowReplacementLanes = std::vector<singz::NativePlaybackLaneSource>{};
  slowReplacementLanes.push_back(keyedLane("song", wav));
  CHECK(slowSession
            .prepare(std::move(slowReplacement), std::move(slowReplacementLanes),
                     151)
            .ok);
  const auto slowStatus = slowSession.status();
  CHECK(slowStatus.swapLandingFrames == 6 + 36000);
  CHECK(slowSession.unload(151).ok);
  }
  std::remove(wav.c_str());
}

// Straight from a phone log: the seam counter climbing by hundreds a second
// after one arm, the pending generation never clearing. The host suite must
// say what a landing is: exactly one per arm, however many blocks follow it
// before anyone asks the session.
void aSeamLandsExactlyOnceHoweverManyBlocksFollow() {
  const std::vector<float> ramp = swapRamp(60000);
  const std::string wav = writeWav("swap-once.wav", 1, ramp);
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(keyedLane("song", wav));
  CHECK(session.prepare(config(), std::move(lanes), 160).ok);
  CHECK(session.openOutput(160).ok && session.start(160).ok);
  CHECK(fake->drive(192, singz::AudioHostDiscontinuityStart));
  singz::NativePlaybackPrepareConfig replacement = config();
  replacement.swapFromGeneration = 160;
  replacement.preparedStartProjectFrame = 192;
  auto replacementLanes = std::vector<singz::NativePlaybackLaneSource>{};
  replacementLanes.push_back(keyedLane("song", wav));
  CHECK(session.prepare(std::move(replacement), std::move(replacementLanes),
                        161)
            .ok);
  for (uint32_t block = 0; block < 100; ++block)
    CHECK(fake->drive(192));
  auto status = session.status();
  CHECK(status.swapLandings == 1 && status.swapPendingGeneration == 0 &&
        status.retiringSwapGeneration == 0 && status.transportGeneration == 161 &&
        status.renderedProjectFrame == 192 * 101 &&
        status.continuousFrame == 192 * 101 &&
        status.adapterRenderFailures == 0);
  for (uint32_t block = 0; block < 100; ++block)
    CHECK(fake->drive(192));
  status = session.status();
  CHECK(status.swapLandings == 1 && status.renderedProjectFrame == 192 * 201);
  CHECK(session.unload(161).ok);
  std::remove(wav.c_str());
}

struct SwapArmingLatch {
  std::mutex mutex;
  std::condition_variable condition;
  bool enabled{false};
  bool ready{false};
  bool release{false};
};

void blockSwapArming(void *opaque,
                     singz::NativePlaybackLifecycleEvent event) noexcept {
  if (event != singz::NativePlaybackLifecycleEvent::SwapArming)
    return;
  auto *latch = static_cast<SwapArmingLatch *>(opaque);
  std::unique_lock<std::mutex> lock(latch->mutex);
  if (!latch->enabled)
    return;
  latch->ready = true;
  latch->condition.notify_all();
  latch->condition.wait(lock, [&] { return latch->release; });
}

void waitUntilArming(SwapArmingLatch *latch) {
  std::unique_lock<std::mutex> lock(latch->mutex);
  latch->condition.wait(lock, [&] { return latch->ready; });
}

void releaseArming(SwapArmingLatch *latch) {
  std::lock_guard<std::mutex> lock(latch->mutex);
  latch->release = true;
  latch->condition.notify_all();
}

// The control thread stalls between reading the clock and publishing the
// request — a phone under load — and the song passes the frame the anchor
// was filled for. The seam then lands late: on the next block, unanchored,
// counted, and never with an anchor for a frame the song is not at.
void aSwapArmedTooLateLandsUnanchoredAndSaysSo() {
  const std::vector<float> ramp = swapRamp(4096);
  const std::string wav = writeWav("swap-late.wav", 1, ramp);
  SwapArmingLatch latch;
  singz::NativePlaybackTestHooks hooks{blockSwapArming, &latch};
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend), &hooks);
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(keyedLane("song", wav));
  CHECK(session.prepare(config(), std::move(lanes), 130).ok);
  CHECK(session.openOutput(130).ok && session.start(130).ok);
  CHECK(fake->drive(8, singz::AudioHostDiscontinuityStart));
  latch.enabled = true;
  singz::NativePlaybackResult armed;
  std::thread arming([&] {
    singz::NativePlaybackPrepareConfig replacement = config();
    replacement.swapFromGeneration = 130;
    replacement.playbackRate = 0.75;
    replacement.preparedStartProjectFrame = 8;
    auto replacementLanes = std::vector<singz::NativePlaybackLaneSource>{};
    replacementLanes.push_back(keyedLane("song", wav));
    armed = session.prepare(std::move(replacement),
                            std::move(replacementLanes), 131);
  });
  waitUntilArming(&latch);
  // The landing was armed for stream frame 14 (8 + 3 × the fake's 2-frame
  // nominal buffer). Two blocks go by first.
  CHECK(fake->drive(8) && fake->drive(8));
  releaseArming(&latch);
  arming.join();
  CHECK(armed.ok);
  latch.enabled = false;
  CHECK(fake->drive(8));
  auto status = session.status();
  CHECK(status.transportGeneration == 131 && status.swapLandings == 1 &&
        status.swapLateLandings == 1 && status.timePitchAnchorOutcome == 42 &&
        status.timePitchAnchorsPublished == 0 &&
        status.timePitchAnchorMisses == 1 && status.continuousFrame == 32 &&
        status.renderedProjectFrame == 30 && status.adapterRenderFailures == 0);
  CHECK(session.unload(131).ok);
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

/* The host raises boundaries nobody asked for, and a time/pitch graph has to
   survive all of them. There is exactly ONE reanchor slot per open — the
   protocol admits a single pending plan, and nextSlice spends it on the first
   boundary it emits — so any rule that demands an anchor per boundary wedges
   the generation at its second one. That shipped: the refusal asked "is a
   boundary pending", every stream start raises the host's ClockReanchored
   when its output host time becomes valid, and so every transpose or tempo
   change killed native playback on every device.

   None of these boundaries moves the source. The Stretch state is a function
   of source-signal history alone, so rendering must simply continue, however
   many arrive and without an anchor being consumed. A seek in the middle is
   the control: that one does move the source, and it still anchors.

   Mutation-checked: restore the old "is a boundary pending" term and this
   test dies on the FIRST host boundary, with drive() returning false.

   The other half of the guard — a source move arriving with no anchor
   prepared must still refuse — is reached from the session API after all,
   and it is terminal: one refused callback ends the session. It was reached
   on an iPhone 13 (2026-09-05) by two seeks 54 ms apart, when the second
   seek's prime retired the first's replacement out of the shared mailbox
   before the first command drained. Each Seek command carries its own plan
   now (twoSeeksRacedAgainstTheCallbackNeverWedge, and the processor-level
   perCommandSeekPlans), so priming failure — refused at the command — is
   again the only way the arm can fail. */
void hostBoundariesWithoutSourceMovementKeepRendering() {
  const std::string wav = writeWav("host-boundary-no-source-move.wav", 1,
                                   std::vector<float>(50000, 0.1F));
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend));
  singz::NativePlaybackPrepareConfig request = config();
  // Off-identity rate is what materializes the Stretch stage at all; at 1.0
  // there is no processor and this whole guard is unreachable.
  request.playbackRate = 0.75;
  request.transposeSemitones = 2.0;
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("song", wav));
  CHECK(session.prepare(std::move(request), std::move(lanes), 61).ok);
  CHECK(session.openOutput(61).ok);
  CHECK(session.start(61).ok);
  CHECK(fake->drive(64));
  auto status = session.status();
  CHECK(status.renderedProjectFrame > 0 && status.adapterRenderFailures == 0 &&
        status.timePitchAnchorMisses == 0);

  // Every host boundary in turn, none of them preceded by a reanchor command,
  // and the sequence repeated so a one-anchor-per-open rule cannot pass by
  // spending its single anchor on the first one.
  const uint64_t anchorsAfterStart = status.timePitchAnchorsPublished;
  const uint64_t misses = status.timePitchAnchorMisses;
  const uint64_t discontinuities = status.transportDiscontinuities;
  for (uint32_t round = 0; round < 3; ++round) {
    const int64_t before = status.renderedProjectFrame;
    CHECK(fake->drive(64, singz::AudioHostDiscontinuityClockReanchored));
    status = session.status();
    CHECK(status.lastTransportBoundary ==
              singz::NativePlaybackTransportBoundaryReason::ClockReanchored &&
          status.renderedProjectFrame > before &&
          status.adapterRenderFailures == 0 &&
          status.graphStatusDetail != 202);

    fake->reanchorRouteAndStream();
    CHECK(fake->drive(64));
    status = session.status();
    CHECK(status.lastTransportBoundary ==
              singz::NativePlaybackTransportBoundaryReason::
                  RouteGenerationChanged &&
          status.adapterRenderFailures == 0 &&
          status.graphStatusDetail != 202);

    fake->advanceStreamIdentityOnly();
    CHECK(fake->drive(64));
    status = session.status();
    CHECK(status.lastTransportBoundary ==
              singz::NativePlaybackTransportBoundaryReason::ClockReanchored &&
          status.adapterRenderFailures == 0 &&
          status.graphStatusDetail != 202);

    CHECK(fake->drive(64, singz::AudioHostDiscontinuityXRun));
    status = session.status();
    CHECK(status.adapterRenderFailures == 0 && status.graphStatusDetail != 202);
  }
  /* Twelve boundaries, and not one anchor spent on them: they had nothing to
     anchor. A published count that moved here would mean the graph is
     re-anchoring on facts about the timestamp domain.

     Each one is a MISS, and that is the designed reading rather than a
     complaint. The boundary still has to propagate — other stages reset on a
     route change and must keep doing so — and the Stretch's own reset with no
     ready slot deliberately keeps the last valid processor and counts one
     (signalsmith_time_pitch.cpp, the reset path). So on a graph with a
     time/pitch stage, timePitchAnchorMisses tracks host boundaries and is NOT
     a health signal; renderedProjectFrame advancing and adapterRenderFailures
     staying at zero are. Nothing in the product gates on it — the desktop
     monitor and the addon bridge only report it. */
  CHECK(status.timePitchAnchorsPublished == anchorsAfterStart &&
        status.timePitchAnchorMisses == misses + 12 &&
        status.transportDiscontinuities == discontinuities + 12);

  // The control. A seek does move the source, so it anchors, and rendering
  // continues from the new position rather than refusing.
  const uint64_t anchorsBeforeSeek = status.timePitchAnchorsPublished;
  const uint64_t missesBeforeSeek = status.timePitchAnchorMisses;
  CHECK(session.seek(61, 20000).ok);
  CHECK(fake->drive(64));
  status = session.status();
  CHECK(status.renderedProjectFrame >= 20000 &&
        status.timePitchAnchorsPublished == anchorsBeforeSeek + 1 &&
        status.timePitchAnchorMisses == missesBeforeSeek &&
        status.adapterRenderFailures == 0 && status.graphStatusDetail != 202);

  // And a host boundary immediately after that seek is still free.
  CHECK(fake->drive(64, singz::AudioHostDiscontinuityClockReanchored));
  status = session.status();
  CHECK(status.adapterRenderFailures == 0 && status.graphStatusDetail != 202 &&
        status.timePitchAnchorsPublished == anchorsBeforeSeek + 1);

  CHECK(session.unload(61).ok);
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
  // The host's context is the router; the generation hangs off it.
  singz::NativePlaybackRenderRouter router;
  router.current.store(&callback, std::memory_order_release);
  std::array<float, 8> left{};
  std::array<float, 8> right{};
  float *output[]{left.data(), right.data()};
  singz::AudioHostRenderBlock block{
      nullptr, output, 0,     2,     8, 8, 48000.0, 1,    1, 1, 0,
      0,       0,      false, false, 0, 0, true,    true, 0, 0, true};
  std::fill(left.begin(), left.end(), 1.0F);
  std::fill(right.begin(), right.end(), 1.0F);
  // No generation at all: silence and a refusal, nothing to latch on.
  singz::NativePlaybackRenderRouter empty;
  CHECK(!singz::nativePlaybackRender(&empty, block) &&
        std::all_of(left.begin(), left.end(),
                    [](float sample) { return sample == 0.0F; }));
  std::fill(left.begin(), left.end(), 1.0F);
  CHECK(!singz::nativePlaybackRender(&router, block));
  CHECK(callback.firstTerminalCause.current().reason ==
            singz::AudioHostTerminalReason::ProviderFailure &&
        adapter.renderFailures.load(std::memory_order_relaxed) == 1 &&
        std::all_of(left.begin(), left.end(),
                    [](float sample) { return sample == 0.0F; }));
  std::fill(left.begin(), left.end(), 1.0F);
  CHECK(!singz::nativePlaybackRender(&router, block));
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
  if (std::getenv("SINGZ_NATIVE_PLAYBACK_QUARANTINED_SWAP") != nullptr) {
    aQuarantinedSwapKeepsRenderingAfterTheSessionIsGone();
    std::puts("native playback quarantined swap tests: ok");
    return 0;
  }
  compositionAndLifetime();
  laneWaveformSummaryAndCountInMeter();
  parallelLaneDecodeMatchesSequential();
  laneDecodePoolStaysInsideTheMemoryBudget();
  staleGenerationCommandsCannotDisturbTheLiveOne();
  decodedLaneRetentionAcrossRebuild();
  portableGraphDocumentMaterializesActualTopology();
  trainingDuckComposition();
  cueGraphTransportCompositionAndLifetime();
  countInLandsOnAnchorMidSong();
  nativeReferencePreviewClickContract();
  transportControlKernelAndTelemetry();
  resumeAfterAQueuedSeekPlaysFromWhereTheSeekLands();
  twoSeeksInARowAfterTheSongRanOutStillRenderWithATimePitchStage();
  twoSeeksRacedAgainstTheCallbackNeverWedge();
  positionNowReadsTheCallbackWithoutTheControlLock();
  aHeldStreamKeepsTheGraphAndResumesInPlace();
  aSwapLandsOnTheRunningStreamWithoutAGap();
  aSwapWhilePausedLandsAtTheNextBlockAndKeepsTheFrame();
  stoppingDuringAnArmedSwapRetiresBothGraphs();
  aSwapIsRefusedWhereItCouldNotLand();
  aFailedOrCancelledSwapCandidateLeavesTheSongPlaying();
  aSwapWaitsOnAnOutgoingGenerationThatLatchedTerminal();
  aRateChangeSwapLandsOnItsAnchorFrame();
  aSwapArmedBehindAnUnappliedCommandLandsUnanchored();
  aLoopSurvivesARateSwapAcrossItsWrap();
  aSwapArmedTooLateLandsUnanchoredAndSaysSo();
  aSlowStretchPrimeStretchesTheLandingBudget();
  aSeamLandsExactlyOnceHoweverManyBlocksFollow();
  audibleProjectionWaitsForLatencyHistory();
  hostBoundariesWithoutSourceMovementKeepRendering();
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
