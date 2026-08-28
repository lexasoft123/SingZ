#include "native/electron/audio_monitor_session.h"
#include "native/electron/native_audio_ownership.h"
#include "allocation_trap.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <memory>
#include <string>

#define CHECK(expression)                                                      \
  do {                                                                         \
    if (!(expression)) {                                                       \
      std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__, \
                   #expression);                                               \
      std::abort();                                                            \
    }                                                                          \
  } while (false)

namespace {

struct LifetimeTrace {
  uint32_t stops{0};
  uint32_t destroys{0};
  uint32_t callbacksDuringStop{0};
  uint32_t opens{0};
  singz::AudioHostConfig lastOpen{};
  std::array<singz::AudioMonitorLifecycleEvent, 32> events{};
  uint32_t eventCount{0};
};

void recordLifecycle(void* context,
                     singz::AudioMonitorLifecycleEvent event) noexcept {
  auto* trace = static_cast<LifetimeTrace*>(context);
  if (trace->eventCount < trace->events.size())
    trace->events[trace->eventCount++] = event;
}

class ManualAudioHostBackend final : public singz::AudioHostBackend {
 public:
  explicit ManualAudioHostBackend(
      LifetimeTrace* trace,
      singz::AudioHostMonitoringSuitability suitability =
          singz::AudioHostMonitoringSuitability::LowLatency,
      bool failStart = false)
      : trace_(trace), suitability_(suitability), failStart_(failStart) {}
  ~ManualAudioHostBackend() override {
    CHECK(state_ != singz::AudioHostState::Running);
    ++trace_->destroys;
  }

  singz::AudioHostInventory enumerate() const override {
    singz::AudioHostDeviceInfo device;
    device.uid = "manual:duplex";
    device.label = "Manual deterministic duplex fixture";
    device.defaultInput = true;
    device.defaultOutput = true;
    device.inputChannels = 4;
    device.outputChannels = 4;
    device.nominalSampleRate = 48000.0;
    device.sampleRateRanges = {{48000.0, 48000.0}};
    device.bufferFrames = {1, 256, 128, 1};
    device.transport = suitability_ ==
                               singz::AudioHostMonitoringSuitability::HighLatency
                           ? singz::AudioHostTransport::Bluetooth
                           : singz::AudioHostTransport::Usb;
    device.monitoringSuitability = suitability_;
    return {{device}, device.uid, device.uid};
  }

  singz::AudioHostResult open(const singz::AudioHostConfig& config,
                              singz::AudioHostRender render,
                              void* context) override {
    ++trace_->opens;
    trace_->lastOpen = config;
    if (config.inputDeviceUid != "manual:duplex" ||
        config.outputDeviceUid != "manual:duplex" ||
        config.inputChannels != std::vector<uint32_t>({2}) ||
        config.outputChannels != std::vector<uint32_t>({0, 1}) ||
        config.requestedSampleRate != 48000.0 ||
        config.requestedBufferFrames != 128 ||
        config.maximumFrames != 256 || render == nullptr) {
      state_ = singz::AudioHostState::Error;
      return {false, singz::AudioHostError::InvalidConfiguration, state_, {}, {},
              "manual host rejected config"};
    }
    render_ = render;
    context_ = context;
    state_ = singz::AudioHostState::Open;
    format_ = {48000.0, 256, 128, 1, 2, true, true,
               config.exclusive ? singz::AudioHostAccessMode::Exclusive
                                : singz::AudioHostAccessMode::Shared};
    latency_ = {16, 24, 128, 0};
    status_ = {};
    status_.state = state_;
    status_.format = format_;
    status_.latency = latency_;
    status_.routeGeneration = 5;
    status_.streamGeneration = 7;
    return {true, singz::AudioHostError::None, state_, format_, latency_, {}};
  }

  singz::AudioHostResult start() override {
    if (state_ != singz::AudioHostState::Open) {
      return {false, singz::AudioHostError::InvalidState, state_, format_,
              latency_, "manual host was not open"};
    }
    if (failStart_) {
      state_ = singz::AudioHostState::Error;
      status_.state = state_;
      return {false, singz::AudioHostError::ProviderFailure, state_, format_,
              latency_, "injected start failure"};
    }
    state_ = singz::AudioHostState::Running;
    status_.state = state_;
    return {true, singz::AudioHostError::None, state_, format_, latency_, {}};
  }

  void stop() noexcept override {
    ++trace_->stops;
    if (render_ != nullptr) {
      ++trace_->callbacksDuringStop;
      (void)drive(1, 0.25F);
    }
    if (state_ != singz::AudioHostState::Closed &&
        state_ != singz::AudioHostState::Error)
      state_ = singz::AudioHostState::Stopped;
    status_.state = state_;
    render_ = nullptr;
    context_ = nullptr;
  }

  singz::AudioHostStatus status() const noexcept override { return status_; }

  bool drive(uint32_t frames, float input,
             uint32_t discontinuity = singz::AudioHostDiscontinuityNone,
             double sampleRate = 48000.0) noexcept {
    CHECK(render_ != nullptr && frames != 0 && frames <= 256);
    std::fill_n(input_.data(), frames, input);
    std::fill_n(left_.data(), frames, 7.0F);
    std::fill_n(right_.data(), frames, 7.0F);
    const float* inputs[]{input_.data()};
    float* outputs[]{left_.data(), right_.data()};
    const singz::AudioHostRenderBlock block{
        inputs, outputs, 1, 2, frames, 256, sampleRate, 11,
        status_.routeGeneration, status_.streamGeneration, sequence_,
        renderedFrames_, 1000000 + renderedFrames_, true, true,
        renderedFrames_, 2000000 + renderedFrames_,
        1500000 + renderedFrames_, discontinuity, true};
    if ((discontinuity & singz::AudioHostDiscontinuityDeviceLost) != 0) {
      state_ = singz::AudioHostState::DeviceLost;
      status_.state = state_;
    }
    const bool ok = render_(context_, block);
    ++sequence_;
    ++status_.callbacks;
    status_.renderedFrames += frames;
    renderedFrames_ += frames;
    if (!ok) ++status_.renderFailures;
    return ok;
  }

  float left(uint32_t frame) const noexcept { return left_[frame]; }
  float right(uint32_t frame) const noexcept { return right_[frame]; }

 private:
  LifetimeTrace* trace_;
  singz::AudioHostMonitoringSuitability suitability_;
  bool failStart_{false};
  singz::AudioHostRender render_{nullptr};
  void* context_{nullptr};
  singz::AudioHostState state_{singz::AudioHostState::Closed};
  singz::AudioHostFormat format_{};
  singz::AudioHostLatency latency_{};
  singz::AudioHostStatus status_{};
  std::array<float, 256> input_{};
  std::array<float, 256> left_{};
  std::array<float, 256> right_{};
  uint64_t sequence_{0};
  uint64_t renderedFrames_{0};
};

bool near(float actual, float expected, float tolerance = 0.00001F) {
  return std::fabs(actual - expected) <= tolerance;
}

void monitorCompositionAndLifecycle() {
  LifetimeTrace lifetime;
  auto backend = std::make_unique<ManualAudioHostBackend>(&lifetime);
  ManualAudioHostBackend* fake = backend.get();
  {
    singz::AudioMonitorSession session(std::move(backend));
    const auto inventory = session.enumerate();
    CHECK(inventory.devices.size() == 1 &&
          inventory.defaultInputUid == "manual:duplex");
    CHECK(inventory.devices[0].transport == singz::AudioHostTransport::Usb &&
          inventory.devices[0].monitoringSuitability ==
              singz::AudioHostMonitoringSuitability::LowLatency);

    singz::AudioMonitorConfig config;
    config.inputDeviceUid = "manual:duplex";
    config.outputDeviceUid = "manual:duplex";
    config.inputChannels = {2};
    config.outputChannels = {0, 1};
    config.sampleRate = 48000.0;
    config.bufferFrames = 128;
    config.maximumFrames = 256;

    CHECK(session.begin(config, 0).error ==
          singz::AudioMonitorError::InvalidGeneration);
    const singz::AudioMonitorResult begun = session.begin(config, 42);
    CHECK(begun.ok && begun.state == singz::AudioHostState::Running &&
          begun.format.inputChannels == 1 && begun.format.outputChannels == 2);
    CHECK(lifetime.lastOpen.inputChannels == std::vector<uint32_t>({2}) &&
          lifetime.lastOpen.outputChannels ==
              std::vector<uint32_t>({0, 1}) &&
          lifetime.lastOpen.requestedBufferFrames == 128 &&
          lifetime.lastOpen.requestedSampleRate == 48000.0 &&
          !lifetime.lastOpen.exclusive);
    CHECK(session.begin(config, 43).error ==
          singz::AudioMonitorError::AlreadyRunning);
    CHECK(session.setGain(43, 0.0F, true).error ==
          singz::AudioMonitorError::InvalidGeneration);
    CHECK(session.end(43).error ==
          singz::AudioMonitorError::InvalidGeneration);

    zdsp::test::resetAllocationTrap();
    zdsp::test::setAllocationTrapEnabled(true);
    const bool mutedRendered =
        fake->drive(64, 2.0F, singz::AudioHostDiscontinuityStart);
    zdsp::test::setAllocationTrapEnabled(false);
    CHECK(mutedRendered && zdsp::test::trappedAllocationCount() == 0);
    for (uint32_t frame = 0; frame < 64; ++frame)
      CHECK(fake->left(frame) == 0.0F && fake->right(frame) == 0.0F);
    singz::AudioMonitorStatus status = session.status();
    CHECK(status.active && !status.enabled && status.ownershipGeneration == 42);
    CHECK(near(status.pre.peak, 2.0F) && near(status.pre.rms, 2.0F));
    CHECK(status.post.peak == 0.0F && status.post.rms == 0.0F);

    CHECK(session.setGain(42, 0.0F, true).ok);
    zdsp::test::resetAllocationTrap();
    zdsp::test::setAllocationTrapEnabled(true);
    const bool enabledRendered = fake->drive(128, 2.0F);
    zdsp::test::setAllocationTrapEnabled(false);
    CHECK(enabledRendered && zdsp::test::trappedAllocationCount() == 0);
    CHECK(fake->left(0) == 0.0F && fake->right(0) == 0.0F);
    CHECK(near(fake->left(127), singz::kMonitorLimiterCeiling) &&
          near(fake->right(127), singz::kMonitorLimiterCeiling));
    for (uint32_t frame = 0; frame < 128; ++frame) {
      CHECK(fake->left(frame) == fake->right(frame));
      CHECK(std::fabs(fake->left(frame)) <=
            singz::kMonitorLimiterCeiling + 0.000001F);
    }
    status = session.status();
    CHECK(status.enabled && status.gainDb == 0.0F);
    CHECK(near(status.pre.peak, 2.0F) && near(status.pre.rms, 2.0F));
    CHECK(near(status.post.peak, singz::kMonitorLimiterCeiling));
    CHECK(status.post.rms > 0.0F &&
          status.post.rms < singz::kMonitorLimiterCeiling);

    CHECK(session.setGain(42, -6.0F, false).ok);
    CHECK(fake->drive(64, 1.0F));
    CHECK(fake->left(63) > 0.0F);
    CHECK(fake->drive(64, 1.0F,
                      singz::AudioHostDiscontinuityRouteChanged));
    for (uint32_t frame = 0; frame < 64; ++frame)
      CHECK(fake->left(frame) == 0.0F && fake->right(frame) == 0.0F);
    status = session.status();
    CHECK(!status.enabled && status.post.peak <=
          singz::kMonitorLimiterCeiling);

    CHECK(!fake->drive(16, 1.0F, singz::AudioHostDiscontinuityNone,
                       44100.0));
    status = session.status();
    CHECK(status.adapterRenderFailures == 1 &&
          status.terminalRenderFailures == 0);

    CHECK(!fake->drive(32, 1.0F,
                       singz::AudioHostDiscontinuityDeviceLost));
    for (uint32_t frame = 0; frame < 32; ++frame)
      CHECK(fake->left(frame) == 0.0F && fake->right(frame) == 0.0F);
    status = session.status();
    CHECK(status.deviceLost && status.host.state ==
          singz::AudioHostState::DeviceLost &&
          status.adapterRenderFailures == 1 &&
          status.terminalRenderFailures == 1 &&
          status.host.renderFailures == 2);

    const uint32_t stopsBeforeEnd = lifetime.stops;
    const singz::AudioMonitorResult ended = session.end(42);
    CHECK(ended.ok && lifetime.stops == stopsBeforeEnd + 1);
    status = session.status();
    CHECK(!status.active && !status.enabled && status.deviceLost &&
          status.ownershipGeneration == 0);
    CHECK(status.host.state == singz::AudioHostState::Stopped);
    CHECK(status.host.renderFailures == 2);
    CHECK(status.pre.frames == 1 && near(status.pre.peak, 0.25F));
    CHECK(status.post.frames == 1 && status.post.peak == 0.0F &&
          status.post.rms == 0.0F);
    CHECK(status.adapterRenderFailures == 1);
    CHECK(status.terminalRenderFailures == 1);
    CHECK(status.adapterLastStatusCode == 0);
    CHECK(status.parameterOverflows == 0);
    CHECK(status.nonFiniteSamples == 0);
    CHECK(status.rejectedBlocks == 0);
    CHECK(session.end(42).error ==
          singz::AudioMonitorError::InvalidGeneration);
    CHECK(session.begin(config, 42).error ==
          singz::AudioMonitorError::InvalidGeneration);
    CHECK(session.begin(config, 41).error ==
          singz::AudioMonitorError::InvalidGeneration);
    CHECK(session.begin(config, 43).ok);
    CHECK(session.end(42).error ==
          singz::AudioMonitorError::InvalidGeneration);
    CHECK(session.status().active &&
          session.status().ownershipGeneration == 43);
    CHECK(session.end(43).ok);

    config.exclusive = true;
    CHECK(session.begin(config, 44).ok);
    CHECK(lifetime.lastOpen.inputChannels == std::vector<uint32_t>({2}) &&
          lifetime.lastOpen.outputChannels ==
              std::vector<uint32_t>({0, 1}) &&
          lifetime.lastOpen.requestedBufferFrames == 128 &&
          lifetime.lastOpen.requestedSampleRate == 48000.0 &&
          lifetime.lastOpen.exclusive &&
          session.status().host.format.accessMode ==
              singz::AudioHostAccessMode::Exclusive);
    CHECK(session.end(44).ok);
    CHECK(lifetime.callbacksDuringStop >= 3);
  }
  CHECK(lifetime.destroys == 1);
}

void rejectsInvalidBounds() {
  LifetimeTrace lifetime;
  auto backend = std::make_unique<ManualAudioHostBackend>(&lifetime);
  singz::AudioMonitorSession session(std::move(backend));
  singz::AudioMonitorConfig invalid;
  invalid.inputDeviceUid = "manual:duplex";
  invalid.outputDeviceUid = "manual:duplex";
  invalid.inputChannels = {0, 0};
  invalid.outputChannels = {0, 1};
  invalid.sampleRate = 48000.0;
  invalid.maximumFrames = 256;
  CHECK(session.begin(invalid, 1).error ==
        singz::AudioMonitorError::InvalidConfiguration);

  invalid.inputChannels = {2};
  invalid.bufferFrames = 128;
  CHECK(session.begin(invalid, 1).ok);
  CHECK(session.setGain(1, -60.01F, true).error ==
        singz::AudioMonitorError::InvalidConfiguration);
  CHECK(session.setGain(1, 12.01F, true).error ==
        singz::AudioMonitorError::InvalidConfiguration);
  CHECK(session.end(1).ok);
}

void rejectsProviderTypedHighLatencyRoutes() {
  for (const auto suitability : {
           singz::AudioHostMonitoringSuitability::HighLatency,
           singz::AudioHostMonitoringSuitability::Unknown}) {
    LifetimeTrace lifetime;
    auto backend =
        std::make_unique<ManualAudioHostBackend>(&lifetime, suitability);
    singz::AudioMonitorSession session(std::move(backend));
    singz::AudioMonitorConfig config;
    config.inputDeviceUid = "manual:duplex";
    config.outputDeviceUid = "manual:duplex";
    config.inputChannels = {2};
    config.outputChannels = {0, 1};
    config.sampleRate = 48000.0;
    config.bufferFrames = 128;
    config.maximumFrames = 256;
    CHECK(session.begin(config, 1).error ==
          singz::AudioMonitorError::UnsupportedRoute);
    CHECK(lifetime.opens == 0);
  }
}

void retryableTeardownAndFallbackOrder() {
  auto config = [] {
    singz::AudioMonitorConfig value;
    value.inputDeviceUid = "manual:duplex";
    value.outputDeviceUid = "manual:duplex";
    value.inputChannels = {2};
    value.outputChannels = {0, 1};
    value.sampleRate = 48000.0;
    value.bufferFrames = 128;
    value.maximumFrames = 256;
    return value;
  }();

  for (bool failRunner : {true, false}) {
    LifetimeTrace lifetime;
    singz::AudioMonitorTestHooks hooks;
    hooks.runnerShutdownFailures = failRunner ? 1 : 0;
    hooks.graphDeactivateFailures = failRunner ? 0 : 1;
    hooks.observe = recordLifecycle;
    hooks.context = &lifetime;
    auto backend = std::make_unique<ManualAudioHostBackend>(&lifetime);
    singz::AudioMonitorSession session(std::move(backend), &hooks);
    CHECK(session.begin(config, 1).ok);
    CHECK(session.end(1).error == singz::AudioMonitorError::GraphFailure);
    CHECK(session.status().active && !session.status().enabled &&
          session.status().ownershipGeneration == 1 &&
          session.status().host.state == singz::AudioHostState::Stopped);
    CHECK(session.setGain(1, 0.0F, true).error ==
          singz::AudioMonitorError::GraphFailure);
    CHECK(!session.status().enabled);
    CHECK(session.end(1).ok);
    CHECK(!session.status().active);
    auto firstStop = std::find(lifetime.events.begin(),
                               lifetime.events.begin() + lifetime.eventCount,
                               singz::AudioMonitorLifecycleEvent::HostStopBegin);
    auto firstShutdown = std::find(
        lifetime.events.begin(), lifetime.events.begin() + lifetime.eventCount,
        singz::AudioMonitorLifecycleEvent::RunnerShutdownAttempt);
    auto released = std::find(
        lifetime.events.begin(), lifetime.events.begin() + lifetime.eventCount,
        singz::AudioMonitorLifecycleEvent::PreparedReleased);
    CHECK(firstStop < firstShutdown && firstShutdown < released);
    CHECK(lifetime.callbacksDuringStop >= 1);
  }

  LifetimeTrace lifetime;
  singz::AudioMonitorTestHooks hooks;
  hooks.runnerShutdownFailures = std::numeric_limits<uint32_t>::max();
  hooks.observe = recordLifecycle;
  hooks.context = &lifetime;
  {
    auto backend = std::make_unique<ManualAudioHostBackend>(&lifetime);
    singz::AudioMonitorSession session(std::move(backend), &hooks);
    CHECK(session.begin(config, 1).ok);
  }
  auto stopped = std::find(
      lifetime.events.begin(), lifetime.events.begin() + lifetime.eventCount,
      singz::AudioMonitorLifecycleEvent::HostStopComplete);
  auto quarantined = std::find(
      lifetime.events.begin(), lifetime.events.begin() + lifetime.eventCount,
      singz::AudioMonitorLifecycleEvent::PreparedQuarantined);
  CHECK(stopped < quarantined && quarantined !=
        lifetime.events.begin() + lifetime.eventCount);
  CHECK(lifetime.destroys == 1 && lifetime.callbacksDuringStop == 1);
}

void partialDeactivationFreezesTelemetry() {
  LifetimeTrace lifetime;
  singz::AudioMonitorTestHooks hooks;
  hooks.partialGraphDeactivateFailures = 1;
  hooks.observe = recordLifecycle;
  hooks.context = &lifetime;
  {
    auto backend = std::make_unique<ManualAudioHostBackend>(&lifetime);
    ManualAudioHostBackend* fake = backend.get();
    singz::AudioMonitorSession session(std::move(backend), &hooks);
    singz::AudioMonitorConfig config;
    config.inputDeviceUid = "manual:duplex";
    config.outputDeviceUid = "manual:duplex";
    config.inputChannels = {2};
    config.outputChannels = {0, 1};
    config.sampleRate = 48000.0;
    config.bufferFrames = 128;
    config.maximumFrames = 256;
    CHECK(session.begin(config, 90).ok);
    CHECK(session.setGain(90, 0.0F, true).ok);
    CHECK(fake->drive(128, 0.5F));

    CHECK(session.end(90).error == singz::AudioMonitorError::GraphFailure);
    const singz::AudioMonitorStatus frozen = session.status();
    CHECK(frozen.active && !frozen.enabled &&
          frozen.ownershipGeneration == 90 && frozen.pre.frames == 1 &&
          near(frozen.pre.peak, 0.25F) && frozen.post.frames == 1 &&
          near(frozen.post.peak, 0.25F));
    CHECK(session.setGain(90, 0.0F, true).error ==
          singz::AudioMonitorError::GraphFailure);
    CHECK(!session.status().enabled);
    // Repeated telemetry reads after the graph walk partially destroyed its
    // processors must remain the exact control-domain snapshot.
    const singz::AudioMonitorStatus repeated = session.status();
    CHECK(repeated.pre.frames == frozen.pre.frames &&
          repeated.pre.peak == frozen.pre.peak &&
          repeated.pre.rms == frozen.pre.rms &&
          repeated.post.frames == frozen.post.frames &&
          repeated.post.peak == frozen.post.peak &&
          repeated.post.rms == frozen.post.rms &&
          repeated.deviceLost == frozen.deviceLost &&
          repeated.adapterRenderFailures == frozen.adapterRenderFailures &&
          repeated.terminalRenderFailures == frozen.terminalRenderFailures &&
          repeated.adapterLastStatusCode == frozen.adapterLastStatusCode &&
          repeated.parameterOverflows == frozen.parameterOverflows &&
          repeated.nonFiniteSamples == frozen.nonFiniteSamples &&
          repeated.rejectedBlocks == frozen.rejectedBlocks);

    const auto frozenEvent = std::find(
        lifetime.events.begin(), lifetime.events.begin() + lifetime.eventCount,
        singz::AudioMonitorLifecycleEvent::MeterTelemetryFrozen);
    const auto deactivation = std::find(
        lifetime.events.begin(), lifetime.events.begin() + lifetime.eventCount,
        singz::AudioMonitorLifecycleEvent::GraphDeactivateAttempt);
    CHECK(frozenEvent < deactivation &&
          deactivation != lifetime.events.begin() + lifetime.eventCount);
  }
  const auto quarantined = std::find(
      lifetime.events.begin(), lifetime.events.begin() + lifetime.eventCount,
      singz::AudioMonitorLifecycleEvent::PreparedQuarantined);
  CHECK(quarantined != lifetime.events.begin() + lifetime.eventCount);
  CHECK(lifetime.destroys == 1);
}

void retainedFailedBeginKeepsGlobalLease() {
  LifetimeTrace lifetime;
  singz::AudioMonitorTestHooks hooks;
  hooks.runnerShutdownFailures = 2;
  auto backend = std::make_unique<ManualAudioHostBackend>(
      &lifetime, singz::AudioHostMonitoringSuitability::LowLatency, true);
  singz::AudioMonitorSession session(std::move(backend), &hooks);
  singz::NativeAudioOwnership ownership;
  using Kind = singz::NativeAudioOwnerKind;
  using Acquire = singz::NativeAudioAcquireResult;

  singz::AudioMonitorConfig config;
  config.inputDeviceUid = "manual:duplex";
  config.outputDeviceUid = "manual:duplex";
  config.inputChannels = {2};
  config.outputChannels = {0, 1};
  config.sampleRate = 48000.0;
  config.bufferFrames = 128;
  config.maximumFrames = 256;

  CHECK(ownership.acquire(Kind::Monitor, 100) == Acquire::Acquired);
  const singz::AudioMonitorResult failed = session.begin(config, 100);
  CHECK(!failed.ok && failed.error == singz::AudioMonitorError::GraphFailure);
  singz::AudioMonitorStatus status = session.status();
  CHECK(status.active && status.ownershipGeneration == 100);
  CHECK(!singz::releaseUnretainedMonitorBeginLease(
      &ownership, 100, status.ownershipGeneration));
  CHECK(ownership.snapshot().kind == Kind::Monitor &&
        ownership.acquire(Kind::Capture, 101) == Acquire::Busy);

  const singz::AudioMonitorResult failedCleanup = session.end(100);
  CHECK(!failedCleanup.ok &&
        !singz::releaseMonitorLeaseAfterEnd(
            &ownership, 100, failedCleanup.ok) &&
        ownership.snapshot().kind == Kind::Monitor &&
        ownership.acquire(Kind::Capture, 101) == Acquire::Busy);
  const singz::AudioMonitorResult retriedEnd = session.end(100);
  CHECK(retriedEnd.ok && singz::releaseMonitorLeaseAfterEnd(
                             &ownership, 100, retriedEnd.ok));
  CHECK(ownership.acquire(Kind::Capture, 101) == Acquire::Acquired);
  CHECK(ownership.release(Kind::Capture, 101));
}

}  // namespace

int main() {
  monitorCompositionAndLifecycle();
  rejectsInvalidBounds();
  rejectsProviderTypedHighLatencyRoutes();
  retryableTeardownAndFallbackOrder();
  partialDeactivationFreezesTelemetry();
  retainedFailedBeginKeepsGlobalLease();
  return 0;
}
