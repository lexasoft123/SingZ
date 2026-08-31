#include <zcore/device/audio_host.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>

#include "zcore/platform/ios/audio_host_ios_helpers.h"

#define CHECK(expression)                                                      \
  do {                                                                         \
    if (!(expression)) {                                                       \
      std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__,  \
                   #expression);                                               \
      std::abort();                                                            \
    }                                                                          \
  } while (false)

namespace {

using singz::detail::IosAudioHostPortKind;
using singz::detail::IosAudioHostPreparedRoute;
using singz::detail::IosAudioHostSessionSnapshot;

IosAudioHostSessionSnapshot outputSession() {
  IosAudioHostSessionSnapshot snapshot;
  snapshot.routeGeneration = 11;
  snapshot.category = "AVAudioSessionCategoryPlayback";
  snapshot.mode = "AVAudioSessionModeDefault";
  snapshot.outputActive = true;
  snapshot.outputUid = "ios-output:speaker";
  snapshot.outputChannels = 2;
  snapshot.outputKind = IosAudioHostPortKind::BuiltIn;
  snapshot.sampleRate = 48000.0;
  snapshot.ioBufferDurationSeconds = 128.0 / 48000.0;
  snapshot.outputLatencySeconds = 53.25 / 48000.0;
  return snapshot;
}

singz::AudioHostConfig outputConfig() {
  singz::AudioHostConfig config;
  config.outputDeviceUid = "ios-output:speaker";
  config.outputChannels = {0, 1};
  config.requestedSampleRate = 48000.0;
  config.requestedBufferFrames = 128;
  config.maximumFrames = 1024;
  return config;
}

void testOutputOnlyFacts() {
  const auto snapshot = outputSession();
  const auto config = outputConfig();
  IosAudioHostPreparedRoute route;
  std::string error;
  CHECK(
      singz::detail::prepareIosAudioHostRoute(config, snapshot, &route, error));
  CHECK(error.empty());
  CHECK(route.format.sampleRate == 48000.0);
  CHECK(route.format.nominalBufferFrames == 128);
  CHECK(route.format.maximumFrames == 1024);
  CHECK(route.format.inputChannels == 0);
  CHECK(route.format.outputChannels == 2);
  CHECK(route.format.float32Planar);
  CHECK(route.format.outputClockMaster);
  CHECK(route.latency.inputDeviceFrames == 0);
  CHECK(route.latency.outputDeviceFrames == 53);
  CHECK(route.latency.bufferFrames == 128);
  CHECK(route.latency.externalRouteFrames == 0);
  CHECK(route.outputChannelMap.size() == 2);
  CHECK(route.outputChannelMap[0] == 0);
  CHECK(route.outputChannelMap[1] == 1);
  CHECK(route.transport == singz::AudioHostTransport::BuiltIn);
  CHECK(route.monitoringSuitability ==
        singz::AudioHostMonitoringSuitability::LowLatency);
}

void testProviderMaximumFrames() {
  CHECK(singz::detail::validIosAudioHostMaximumFrames(128, 128, 1024));
  CHECK(singz::detail::validIosAudioHostMaximumFrames(1024, 128, 1024));
  CHECK(!singz::detail::validIosAudioHostMaximumFrames(127, 128, 1024));
  CHECK(!singz::detail::validIosAudioHostMaximumFrames(1025, 128, 1024));
  CHECK(!singz::detail::validIosAudioHostMaximumFrames(0, 128, 1024));
  CHECK(!singz::detail::validIosAudioHostMaximumFrames(128, 0, 1024));
}

void testTerminalReasonSurvivesProviderTeardown() {
  using Reason = singz::AudioHostTerminalReason;
  singz::AudioHostTerminalCauseLatch live;
  singz::AudioHostTerminalCauseLatch retained;
  live.publish(Reason::RouteChanged,
               singz::AudioHostTerminalProducer::PlatformNotification);
  live.publish(Reason::ProviderFailure,
               singz::AudioHostTerminalProducer::Provider);
  retained.retain(live.current(),
                  singz::AudioHostTerminalProducer::ControlRetained);
  CHECK(retained.current().reason == Reason::RouteChanged);
  live.reset();
  CHECK(retained.current().reason == Reason::RouteChanged);

  // Arrival order, not enum priority or sampling time, determines the cause.
  live.publish(Reason::MediaServicesLost,
               singz::AudioHostTerminalProducer::PlatformNotification);
  live.publish(Reason::Interrupted, singz::AudioHostTerminalProducer::Provider);
  CHECK(live.current().reason == Reason::MediaServicesLost);
  live.reset();
  live.publish(Reason::Interrupted,
               singz::AudioHostTerminalProducer::PlatformNotification);
  live.publish(Reason::MediaServicesLost,
               singz::AudioHostTerminalProducer::Provider);
  CHECK(live.current().reason == Reason::Interrupted);
  live.reset();
  live.publish(Reason::ProviderFailure,
               singz::AudioHostTerminalProducer::Provider);
  live.publish(Reason::RouteChanged,
               singz::AudioHostTerminalProducer::PlatformNotification);
  CHECK(live.current().reason == Reason::ProviderFailure);
  retained.reset();
  CHECK(retained.current().reason == Reason::None);

  using State = singz::AudioHostState;
  CHECK(singz::detail::iosAudioHostReportedState(
            State::Running, Reason::RouteChanged) == State::Error);
  CHECK(singz::detail::iosAudioHostReportedState(
            State::Open, Reason::MediaServicesLost) == State::DeviceLost);
  CHECK(singz::detail::iosAudioHostReportedState(
            State::Stopped, Reason::RouteChanged) == State::Stopped);
  CHECK(singz::detail::iosAudioHostReportedState(
            State::Closed, Reason::Interrupted) == State::Closed);

  // A successful dispose is the physical quiescence proof. Stop followed by
  // a failed dispose retains the provider lease in process quarantine and
  // therefore must never masquerade as Stopped to the playback session.
  CHECK(singz::detail::iosAudioHostStateAfterDispose(State::Running, true) ==
        State::Stopped);
  CHECK(singz::detail::iosAudioHostStateAfterDispose(State::Closed, true) ==
        State::Closed);
  CHECK(singz::detail::iosAudioHostStateAfterDispose(State::Running, false) ==
        State::Error);
  CHECK(singz::detail::iosAudioHostStateAfterDispose(State::DeviceLost,
                                                     false) == State::Error);
}

void testTerminalOrdinalSaturationAndBoundedJournal() {
  using Producer = singz::AudioHostTerminalProducer;
  using Reason = singz::AudioHostTerminalReason;
  CHECK(singz::kAudioHostTerminalRetainAttempts ==
        singz::kAudioHostTerminalMaximumConcurrentPublishers);
  CHECK(singz::kAudioHostTerminalSlotsPerProducer == 4);
  CHECK(singz::kAudioHostTerminalMaximumConcurrentPublishers >
        singz::kAudioHostTerminalSlotsPerProducer + 2);
  std::atomic<uint32_t> admissionCount{0};
  for (uint32_t index = 0;
       index < singz::kAudioHostTerminalMaximumConcurrentPublishers; ++index)
    CHECK(singz::detail::tryAdmitAudioHostTerminalPublisher(admissionCount));
  CHECK(!singz::detail::tryAdmitAudioHostTerminalPublisher(admissionCount));
  CHECK(admissionCount.load(std::memory_order_acquire) ==
        singz::kAudioHostTerminalMaximumConcurrentPublishers);
  for (uint32_t index = 0;
       index < singz::kAudioHostTerminalMaximumConcurrentPublishers; ++index)
    singz::detail::releaseAudioHostTerminalPublisher(admissionCount);
  CHECK(admissionCount.load(std::memory_order_acquire) == 0);
  admissionCount.store(UINT32_MAX, std::memory_order_release);
  CHECK(!singz::detail::tryAdmitAudioHostTerminalPublisher(admissionCount));
  CHECK(admissionCount.load(std::memory_order_acquire) == UINT32_MAX);
  admissionCount.store(singz::kAudioHostTerminalMaximumConcurrentPublishers,
                       std::memory_order_release);
  CHECK(!singz::detail::tryAdmitAudioHostTerminalPublisher(admissionCount));
  CHECK(admissionCount.load(std::memory_order_acquire) ==
        singz::kAudioHostTerminalMaximumConcurrentPublishers);
  CHECK(singz::gAudioHostTerminalOrdinalPublishers.load(
            std::memory_order_acquire) == 0);
  const bool savedOrdinalViolation =
      singz::gAudioHostTerminalOrdinalConcurrencyViolated.exchange(
          false, std::memory_order_acq_rel);
  for (uint32_t index = 0;
       index < singz::kAudioHostTerminalMaximumConcurrentPublishers; ++index)
    CHECK(singz::detail::tryAdmitAudioHostTerminalPublisher(
        singz::gAudioHostTerminalOrdinalPublishers));
  const uint64_t beforeRejectedPublisher =
      singz::gAudioHostTerminalOrdinal.load(std::memory_order_acquire);
  const auto rejectedPublisher =
      singz::makeAudioHostTerminalCause(Reason::ProviderFailure);
  CHECK(rejectedPublisher.ordinal == singz::kAudioHostTerminalMaximumOrdinal);
  CHECK(singz::gAudioHostTerminalOrdinal.load(std::memory_order_acquire) ==
        beforeRejectedPublisher);
  CHECK(singz::gAudioHostTerminalOrdinalConcurrencyViolated.load(
      std::memory_order_acquire));
  for (uint32_t index = 0;
       index < singz::kAudioHostTerminalMaximumConcurrentPublishers; ++index)
    singz::detail::releaseAudioHostTerminalPublisher(
        singz::gAudioHostTerminalOrdinalPublishers);
  const auto afterRejectedPublisher =
      singz::makeAudioHostTerminalCause(Reason::RouteChanged);
  CHECK(afterRejectedPublisher.ordinal == beforeRejectedPublisher + 1);
  CHECK(!singz::gAudioHostTerminalOrdinalSaturated.load(
      std::memory_order_acquire));
  CHECK(singz::gAudioHostTerminalOrdinalPublishers.load(
            std::memory_order_acquire) == 0);
  singz::gAudioHostTerminalOrdinalConcurrencyViolated.store(
      savedOrdinalViolation, std::memory_order_release);
  const uint64_t saved = singz::gAudioHostTerminalOrdinal.exchange(
      singz::kAudioHostTerminalOrdinalSaturationBoundary - 2,
      std::memory_order_acq_rel);
  const bool savedSaturation =
      singz::gAudioHostTerminalOrdinalSaturated.exchange(
          false, std::memory_order_acq_rel);
  const auto beforeBoundary =
      singz::makeAudioHostTerminalCause(Reason::RouteChanged);
  const auto boundary = singz::makeAudioHostTerminalCause(Reason::Interrupted);
  const auto saturated =
      singz::makeAudioHostTerminalCause(Reason::ProviderFailure);
  const auto futureSession =
      singz::makeAudioHostTerminalCause(Reason::MediaServicesReset);
  CHECK(beforeBoundary.ordinal ==
        singz::kAudioHostTerminalOrdinalSaturationBoundary - 1);
  CHECK(boundary.ordinal == singz::kAudioHostTerminalOrdinalSaturationBoundary);
  CHECK(saturated.ordinal == singz::kAudioHostTerminalMaximumOrdinal);
  CHECK(futureSession.ordinal == singz::kAudioHostTerminalMaximumOrdinal);
  CHECK(singz::gAudioHostTerminalOrdinal.load(std::memory_order_acquire) <=
        singz::kAudioHostTerminalMaximumOrdinal);
  CHECK(singz::gAudioHostTerminalOrdinalSaturated.load(
      std::memory_order_acquire));
  singz::gAudioHostTerminalOrdinal.store(saved, std::memory_order_release);
  singz::gAudioHostTerminalOrdinalSaturated.store(savedSaturation,
                                                  std::memory_order_release);

  // Ordinary contention consumes unique fetch-add tickets and cannot poison
  // a later session into saturation merely because publishers overlapped.
  constexpr uint32_t kConcurrent = 16;
  const uint64_t contentionBase =
      singz::gAudioHostTerminalOrdinal.load(std::memory_order_acquire);
  std::array<singz::AudioHostTerminalCause, kConcurrent> concurrent{};
  std::array<std::thread, kConcurrent> allocators;
  std::atomic<bool> allocate{false};
  for (uint32_t index = 0; index < kConcurrent; ++index) {
    allocators[index] = std::thread([&, index] {
      while (!allocate.load(std::memory_order_acquire))
        std::this_thread::yield();
      concurrent[index] =
          singz::makeAudioHostTerminalCause(Reason::ProviderFailure);
    });
  }
  allocate.store(true, std::memory_order_release);
  for (auto &allocator : allocators)
    allocator.join();
  std::array<uint64_t, kConcurrent> tickets{};
  for (uint32_t index = 0; index < kConcurrent; ++index)
    tickets[index] = concurrent[index].ordinal;
  std::sort(tickets.begin(), tickets.end());
  for (uint32_t index = 0; index < kConcurrent; ++index)
    CHECK(tickets[index] == contentionBase + index + 1);
  const auto laterSession =
      singz::makeAudioHostTerminalCause(Reason::RouteChanged);
  CHECK(laterSession.ordinal == contentionBase + kConcurrent + 1);
  CHECK(!singz::gAudioHostTerminalOrdinalSaturated.load(
      std::memory_order_acquire));

  singz::AudioHostTerminalCauseLatch resetProof;
  resetProof.publish(Reason::RouteChanged, Producer::Test);
  const uint64_t epochBeforeReset =
      singz::gAudioHostTerminalOrdinal.load(std::memory_order_acquire);
  resetProof.reset();
  CHECK(!resetProof.hasCause());
  CHECK(singz::gAudioHostTerminalOrdinal.load(std::memory_order_acquire) ==
        epochBeforeReset);

  // The true first event is stamped and then paused before retain. More than
  // the old per-producer capacity publish meanwhile. Resuming the delayed
  // writer must replace their later minimum with its exact reason+ordinal.
  singz::AudioHostTerminalCauseLatch journal;
  const auto earliest = singz::makeAudioHostTerminalCause(Reason::RouteChanged);
  constexpr uint32_t kLaterPublishers =
      singz::kAudioHostTerminalSlotsPerProducer + 3;
  std::array<std::thread, kLaterPublishers> workers;
  std::atomic<bool> go{false};
  for (uint32_t index = 0; index < kLaterPublishers; ++index) {
    workers[index] = std::thread([&] {
      while (!go.load(std::memory_order_acquire))
        std::this_thread::yield();
      journal.retain(singz::makeAudioHostTerminalCause(Reason::ProviderFailure),
                     Producer::Test);
    });
  }
  go.store(true, std::memory_order_release);
  for (auto &worker : workers)
    worker.join();
  CHECK(journal.current().ordinal > earliest.ordinal);
  journal.retain(earliest, Producer::Test);
  const auto recorded = journal.current();
  CHECK(recorded.ordinal == earliest.ordinal &&
        recorded.reason == earliest.reason);
  CHECK(!journal.concurrencyBoundViolated());

  // Deterministically hold every retain admission before its publication.
  // The rejected 65th cause must become observable through the exact
  // fail-closed fallback without waiting for any admitted publisher.
  std::atomic<uint64_t> pausedEarliest{0};
  std::atomic<uint64_t> rejectedFallback{0};
  std::atomic<uint32_t> pausedRetainers{
      singz::kAudioHostTerminalMaximumConcurrentPublishers};
  std::atomic<bool> rejectedViolation{false};
  const auto rejectedCause =
      singz::makeAudioHostTerminalCause(Reason::Interrupted);
  singz::detail::retainAudioHostTerminalCause(rejectedCause, pausedEarliest,
                                              rejectedFallback, pausedRetainers,
                                              rejectedViolation);
  const auto visibleRejected = singz::detail::unpackAudioHostTerminalCause(
      rejectedFallback.load(std::memory_order_acquire));
  CHECK(pausedEarliest.load(std::memory_order_acquire) == 0 &&
        visibleRejected.reason == Reason::Interrupted &&
        visibleRejected.ordinal == rejectedCause.ordinal &&
        rejectedViolation.load(std::memory_order_acquire) &&
        pausedRetainers.load(std::memory_order_acquire) ==
            singz::kAudioHostTerminalMaximumConcurrentPublishers);
}

struct NotificationLatch {
  std::mutex mutex;
  std::condition_variable condition;
  singz::detail::IosAudioHostNotificationEdge target{};
  bool reached{false};
  bool release{false};
};

void pauseNotification(
    void *opaque, singz::detail::IosAudioHostNotificationEdge edge) noexcept {
  auto *latch = static_cast<NotificationLatch *>(opaque);
  if (edge != latch->target)
    return;
  std::unique_lock<std::mutex> lock(latch->mutex);
  latch->reached = true;
  latch->condition.notify_all();
  latch->condition.wait(lock, [&] { return latch->release; });
}

void testNotificationPublicationAndTeardownLinearize() {
  using Edge = singz::detail::IosAudioHostNotificationEdge;
  {
    singz::detail::IosAudioHostSessionSignals signals;
    signals.observerAdmission.open();
    CHECK(singz::detail::publishIosAudioHostSessionChange(
        &signals, singz::detail::IosAudioHostRouteChanged));
    CHECK(singz::detail::publishIosAudioHostSessionChange(
        &signals, singz::detail::IosAudioHostMediaServicesLost));
    CHECK(signals.firstTerminalCause.current().reason ==
          singz::AudioHostTerminalReason::RouteChanged);
  }
  {
    singz::detail::IosAudioHostSessionSignals signals;
    signals.observerAdmission.open();
    CHECK(singz::detail::publishIosAudioHostSessionChange(
        &signals, singz::detail::IosAudioHostMediaServicesLost));
    CHECK(singz::detail::publishIosAudioHostSessionChange(
        &signals, singz::detail::IosAudioHostRouteChanged));
    CHECK(signals.firstTerminalCause.current().reason ==
          singz::AudioHostTerminalReason::MediaServicesLost);
  }
  for (Edge edge : {Edge::Entered, Edge::TerminalCausePublished,
                    Edge::PendingPublished, Edge::GenerationPublished}) {
    singz::detail::IosAudioHostSessionSignals signals;
    signals.routeGeneration.store(11, std::memory_order_relaxed);
    signals.observerAdmission.open();
    NotificationLatch latch;
    latch.target = edge;
    signals.testObserve = pauseNotification;
    signals.testContext = &latch;
    bool published = false;
    std::thread observer([&] {
      published = singz::detail::publishIosAudioHostSessionChange(
          &signals, singz::detail::IosAudioHostRouteChanged);
    });
    {
      std::unique_lock<std::mutex> lock(latch.mutex);
      latch.condition.wait(lock, [&] { return latch.reached; });
    }

    const uint32_t pending = signals.pending.load(std::memory_order_acquire);
    const uint64_t generation =
        signals.routeGeneration.load(std::memory_order_acquire);
    const auto terminal = signals.firstTerminalCause.current();
    if (edge == Edge::Entered) {
      CHECK(pending == 0 && generation == 11 &&
            terminal.reason == singz::AudioHostTerminalReason::None);
      CHECK(!singz::detail::iosAudioHostCallbackTerminal(&signals));
    } else if (edge == Edge::TerminalCausePublished) {
      CHECK(pending == 0 && generation == 11 &&
            terminal.reason == singz::AudioHostTerminalReason::RouteChanged);
      uint32_t graphEntries = 0;
      if (!singz::detail::iosAudioHostCallbackTerminal(&signals))
        ++graphEntries;
      CHECK(graphEntries == 0);
    } else if (edge == Edge::PendingPublished) {
      CHECK((pending & singz::detail::IosAudioHostRouteChanged) != 0 &&
            generation == 11 &&
            terminal.reason == singz::AudioHostTerminalReason::RouteChanged);
    } else {
      CHECK((pending & singz::detail::IosAudioHostRouteChanged) != 0 &&
            generation == 12 &&
            terminal.reason == singz::AudioHostTerminalReason::RouteChanged);
    }
    // Once the notification has published either fact, open/start cannot
    // mistake it for the prepared route: cause is visible no later than the
    // generation change.
    if (edge != Edge::Entered)
      CHECK(terminal.reason != singz::AudioHostTerminalReason::None ||
            pending != 0 || generation != 11);

    std::atomic<bool> teardownEntered{false};
    std::atomic<bool> teardownDone{false};
    std::thread teardown([&] {
      singz::detail::closeIosAudioHostSessionNotifications(&signals);
      teardownEntered.store(true, std::memory_order_release);
      singz::detail::waitForIosAudioHostSessionNotifications(&signals);
      teardownDone.store(true, std::memory_order_release);
    });
    while (!teardownEntered.load(std::memory_order_acquire))
      std::this_thread::yield();
    CHECK(!teardownDone.load(std::memory_order_acquire));
    {
      std::lock_guard<std::mutex> lock(latch.mutex);
      latch.release = true;
      latch.condition.notify_all();
    }
    observer.join();
    teardown.join();
    CHECK(published && teardownDone.load(std::memory_order_acquire));
    CHECK(signals.pending.load(std::memory_order_acquire) ==
          singz::detail::IosAudioHostRouteChanged);
    CHECK(signals.routeGeneration.load(std::memory_order_acquire) == 12);
    CHECK(!singz::detail::publishIosAudioHostSessionChange(
        &signals, singz::detail::IosAudioHostInterrupted));
    CHECK(signals.pending.load(std::memory_order_acquire) ==
          singz::detail::IosAudioHostRouteChanged);
  }
}

void testSparseOutputMapAndExternalLatency() {
  auto snapshot = outputSession();
  snapshot.outputChannels = 8;
  snapshot.outputKind = IosAudioHostPortKind::BluetoothA2dp;
  snapshot.outputLatencySeconds = 0.137;
  auto config = outputConfig();
  config.outputChannels = {6, 7};
  IosAudioHostPreparedRoute route;
  std::string error;
  CHECK(
      singz::detail::prepareIosAudioHostRoute(config, snapshot, &route, error));
  CHECK(route.outputChannelMap.size() == 8);
  for (uint32_t index = 0; index < 6; ++index) {
    CHECK(route.outputChannelMap[index] == -1);
  }
  CHECK(route.outputChannelMap[6] == 0);
  CHECK(route.outputChannelMap[7] == 1);
  CHECK(route.latency.outputDeviceFrames == 0);
  CHECK(route.latency.externalRouteFrames == 6576);
  CHECK(route.monitoringSuitability ==
        singz::AudioHostMonitoringSuitability::HighLatency);
}

void testPreparedDuplex() {
  auto snapshot = outputSession();
  snapshot.category = "AVAudioSessionCategoryPlayAndRecord";
  snapshot.mode = "AVAudioSessionModeMeasurement";
  snapshot.inputActive = true;
  snapshot.recordCapable = true;
  snapshot.inputUid = "ios:usb-mic";
  snapshot.inputChannels = 8;
  snapshot.inputKind = IosAudioHostPortKind::Usb;
  snapshot.inputLeaseActive = true;
  snapshot.inputLeaseToken = 91;
  snapshot.inputRouteGeneration = 22;
  snapshot.inputLeaseRouteGeneration = 22;
  snapshot.inputLeaseUid = "ios:usb-mic";
  snapshot.inputLeaseMinimumChannels = 8;
  snapshot.inputLatencySeconds = 23.2 / 48000.0;
  auto config = outputConfig();
  config.inputDeviceUid = "ios:usb-mic";
  config.inputChannels = {2, 5};
  IosAudioHostPreparedRoute route;
  std::string error;
  CHECK(
      singz::detail::prepareIosAudioHostRoute(config, snapshot, &route, error));
  CHECK(route.format.inputChannels == 2);
  CHECK(route.inputChannelMap.size() == 2);
  CHECK(route.inputChannelMap[0] == 2);
  CHECK(route.inputChannelMap[1] == 5);
  CHECK(route.latency.inputDeviceFrames == 23);

  snapshot.inputLeaseRouteGeneration++;
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error));
  CHECK(error.find("prepared session lease") != std::string::npos);
}

void testFailClosedPolicy() {
  IosAudioHostPreparedRoute route;
  std::string error;
  singz::AudioHostError errorCode = singz::AudioHostError::None;
  auto snapshot = outputSession();
  auto config = outputConfig();

  config.outputDeviceUid = "ios-output:missing";
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error, &errorCode));
  CHECK(errorCode == singz::AudioHostError::DeviceNotFound);
  config = outputConfig();

  config.outputChannels = {1, 1};
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error));
  config = outputConfig();
  config.requestedSampleRate = 44100.0;
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error));
  config = outputConfig();
  config.requestedBufferFrames = 256;
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error));
  config = outputConfig();
  config.maximumFrames = 64;
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error));
  config = outputConfig();
  config.exclusive = true;
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error));
  config = outputConfig();
  config.inputDeviceUid = "ios:mic";
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error));

  snapshot = outputSession();
  snapshot.category = "AVAudioSessionCategoryPlayAndRecord";
  snapshot.inputActive = true;
  snapshot.recordCapable = true;
  snapshot.inputUid = "ios:usb-mic";
  snapshot.inputChannels = 2;
  snapshot.inputLeaseActive = true;
  snapshot.inputLeaseToken = 1;
  snapshot.inputRouteGeneration = 3;
  snapshot.inputLeaseRouteGeneration = 3;
  snapshot.inputLeaseUid = "ios:usb-mic";
  snapshot.inputLeaseMinimumChannels = 2;
  config = outputConfig();
  config.inputDeviceUid = "ios:other-mic";
  config.inputChannels = {0};
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error, &errorCode));
  CHECK(errorCode == singz::AudioHostError::DeviceNotFound);

  config.inputDeviceUid = "ios:usb-mic";
  snapshot.inputLeaseUid = "ios:stale-mic";
  CHECK(!singz::detail::prepareIosAudioHostRoute(config, snapshot, &route,
                                                 error, &errorCode));
  CHECK(errorCode == singz::AudioHostError::InvalidConfiguration);
}

void testSessionIdentity() {
  const auto before = outputSession();
  auto after = before;
  CHECK(singz::detail::sameIosAudioHostSession(before, after));
  after.routeGeneration++;
  CHECK(!singz::detail::sameIosAudioHostSession(before, after));
  after = before;
  after.sampleRate = 44100.0;
  CHECK(!singz::detail::sameIosAudioHostSession(before, after));
  after = before;
  after.outputUid = "ios-output:headphones";
  CHECK(!singz::detail::sameIosAudioHostSession(before, after));
  after = before;
  after.categoryOptions = 1;
  CHECK(!singz::detail::sameIosAudioHostSession(before, after));
}

void testTransportDoesNotGuess() {
  CHECK(singz::detail::iosAudioHostTransport(IosAudioHostPortKind::Wired) ==
        singz::AudioHostTransport::Unknown);
  CHECK(singz::detail::iosAudioHostMonitoringSuitability(
            IosAudioHostPortKind::Wired) ==
        singz::AudioHostMonitoringSuitability::LowLatency);
  CHECK(singz::detail::iosAudioHostTransport(IosAudioHostPortKind::CarAudio) ==
        singz::AudioHostTransport::Vehicle);
}

} // namespace

int main() {
  testOutputOnlyFacts();
  testProviderMaximumFrames();
  testTerminalReasonSurvivesProviderTeardown();
  testTerminalOrdinalSaturationAndBoundedJournal();
  testNotificationPublicationAndTeardownLinearize();
  testSparseOutputMapAndExternalLatency();
  testPreparedDuplex();
  testFailClosedPolicy();
  testSessionIdentity();
  testTransportDoesNotGuess();
  std::puts("audio_host_ios_policy_tests passed");
  return 0;
}
