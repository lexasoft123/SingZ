#include <native/playback/native_playback_callback.h>
#include <native/playback/native_playback_session.h>
#include <zcore/media/flac_io.h>
#include <zcore/media/wav.h>

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
    if (ok)
      renderedFrames += frames;
    else
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

void compositionAndLifetime() {
  std::vector<float> a(256, 0.1F);
  std::vector<float> b(384, 0.2F);
  const std::string wav = writeWav("a.wav", 1, a);
  const std::string flacWav = writeWav("b.wav", 1, b);
  const std::string flac = scratch("b.flac");
  std::remove(flac.c_str());
  CHECK(singz::compactStem(flacWav, flac).ok);

  Trace trace;
  singz::NativePlaybackTestHooks hooks{observe, &trace};
  auto backend = std::make_unique<ManualOutputBackend>();
  ManualOutputBackend *fake = backend.get();
  singz::NativePlaybackSession session(std::move(backend), &hooks);
  auto lanes = std::vector<singz::NativePlaybackLaneSource>{};
  lanes.push_back(lane("a", wav));
  lanes.push_back(lane("b", flac));
  CHECK(session.prepare(config(), std::move(lanes), 10).ok);
  auto status = session.status();
  CHECK(status.state == singz::NativePlaybackState::Prepared &&
        status.generation == 10 && status.lanes.size() == 2 &&
        status.lanes[0].cursorFrames == 0 &&
        status.lanes[1].cursorFrames == 0 &&
        status.retainedBytes == (256u + 384u) * sizeof(float));
  CHECK(fake->enumerations == 0 && fake->opens == 0 && fake->starts == 0);
  CHECK(session.openOutput(10).ok);
  CHECK(session.status().state == singz::NativePlaybackState::OutputOpen &&
        fake->enumerations == 1 && fake->opens == 1 && fake->starts == 0);
  CHECK(fake->lastConfig.inputDeviceUid.empty() &&
        fake->lastConfig.inputChannels.empty());
  CHECK(session.start(10).ok);

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
  CHECK(session.start(10).error ==
        singz::NativePlaybackError::InvalidGeneration);
  CHECK(session.unload(10).ok);
  status = session.status();
  CHECK(status.generation == 0 && status.retainedBytes == 0 &&
        status.lanes.empty());
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
        "singz.native.playback-session.wav-flac.frame-zero.v1");
  boundedQuarantinePoisonsFuturePrepare();
  std::puts("native playback session tests: ok");
  return 0;
}
