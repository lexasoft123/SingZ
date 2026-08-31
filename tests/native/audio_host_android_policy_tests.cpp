#include "audio_host_android_policy.h"
#include "audio_host_android_callback_policy.h"
#include "audio_host_android_lifecycle.h"
#include "audio_host_android_sampler.h"
#include <zcore/device/audio_input_callback_gate.h>

#include <cstdio>
#include <cstdlib>
#include <atomic>
#include <latch>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#define CHECK(expression)                                                      \
  do {                                                                         \
    if (!(expression)) {                                                       \
      std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__, \
                   #expression);                                               \
      std::abort();                                                            \
    }                                                                          \
  } while (false)

namespace {

singz::detail::AndroidAudioHostInventorySnapshot inventory() {
  using Device = singz::detail::AndroidAudioHostDevice;
  singz::detail::AndroidAudioHostInventorySnapshot result;
  result.routeGeneration = 7;
  result.devices = {
      Device{31, "android:31", "USB input", true, false, 16, 0.0,
             {44100.0, 48000.0, 96000.0},
             singz::AudioHostTransport::Usb,
             singz::AudioHostMonitoringSuitability::LowLatency},
      Device{32, "android:32", "USB output", false, true, 16, 0.0,
             {44100.0, 48000.0, 96000.0},
             singz::AudioHostTransport::Usb,
             singz::AudioHostMonitoringSuitability::LowLatency},
      Device{44, "android:44", "Car output", false, true, 2, 0.0,
             {48000.0},
             singz::AudioHostTransport::Vehicle,
             singz::AudioHostMonitoringSuitability::HighLatency}};
  return result;
}

singz::AudioHostConfig duplexConfig() {
  singz::AudioHostConfig config;
  config.inputDeviceUid = "android:31";
  config.outputDeviceUid = "android:32";
  config.inputChannels = {2, 7};
  config.outputChannels = {6, 7};
  config.requestedSampleRate = 48000.0;
  config.requestedBufferFrames = 192;
  config.maximumFrames = 1024;
  return config;
}

void testSparsePairedRoute() {
  const auto snapshot = inventory();
  CHECK(snapshot.devices[0].nominalSampleRate == 0.0);
  CHECK(snapshot.devices[0].sampleRates.size() == 3);
  const auto config = duplexConfig();
  singz::detail::AndroidAudioHostPreparedRoute route;
  std::string error;
  CHECK(singz::detail::prepareAndroidAudioHostRoute(config, snapshot, &route,
                                                    error));
  CHECK(route.routeGeneration == 7);
  CHECK(route.inputDeviceId == 31);
  CHECK(route.outputDeviceId == 32);
  CHECK(route.inputEndpointChannels == 8);
  CHECK(route.outputEndpointChannels == 8);
  CHECK(route.inputChannelMap == config.inputChannels);
  CHECK(route.outputChannelMap.size() == 8);
  for (uint32_t channel = 0; channel < 6; ++channel) {
    CHECK(route.outputChannelMap[channel] == -1);
  }
  CHECK(route.outputChannelMap[6] == 0);
  CHECK(route.outputChannelMap[7] == 1);
}

void testMonitoringSuitabilityIsTriState() {
  CHECK(singz::detail::androidAudioHostMonitoringSuitability("low-latency") ==
        singz::AudioHostMonitoringSuitability::LowLatency);
  CHECK(singz::detail::androidAudioHostMonitoringSuitability("high-latency") ==
        singz::AudioHostMonitoringSuitability::HighLatency);
  CHECK(singz::detail::androidAudioHostMonitoringSuitability("unknown") ==
        singz::AudioHostMonitoringSuitability::Unknown);
  CHECK(singz::detail::androidAudioHostMonitoringSuitability("hdmi") ==
        singz::AudioHostMonitoringSuitability::Unknown);
}

void testOutputOnlyAndHighLatency() {
  auto config = duplexConfig();
  config.inputDeviceUid.clear();
  config.inputChannels.clear();
  config.outputDeviceUid = "android:44";
  config.outputChannels = {0, 1};
  singz::detail::AndroidAudioHostPreparedRoute route;
  std::string error;
  CHECK(singz::detail::prepareAndroidAudioHostRoute(config, inventory(),
                                                    &route, error));
  CHECK(route.inputEndpointChannels == 0);
  CHECK(route.monitoringSuitability ==
        singz::AudioHostMonitoringSuitability::HighLatency);
}

void testFailClosedPreparation() {
  auto config = duplexConfig();
  auto snapshot = inventory();
  singz::detail::AndroidAudioHostPreparedRoute route;
  std::string error;
  singz::AudioHostError code = singz::AudioHostError::None;
  config.outputDeviceUid = "android:404";
  CHECK(!singz::detail::prepareAndroidAudioHostRoute(
      config, snapshot, &route, error, &code));
  CHECK(code == singz::AudioHostError::DeviceNotFound);

  config = duplexConfig();
  config.inputChannels = {16};
  CHECK(!singz::detail::prepareAndroidAudioHostRoute(config, snapshot, &route,
                                                     error));
  config = duplexConfig();
  config.outputChannels = {1, 1};
  CHECK(!singz::detail::prepareAndroidAudioHostRoute(config, snapshot, &route,
                                                     error));
  config = duplexConfig();
  config.requestedSampleRate = 48000.5;
  CHECK(!singz::detail::prepareAndroidAudioHostRoute(config, snapshot, &route,
                                                     error));
}

singz::detail::AndroidAudioHostOpenedStream goodOpened() {
  singz::detail::AndroidAudioHostOpenedStream stream;
  stream.deviceId = 32;
  stream.channels = 8;
  stream.sampleRate = 48000;
  stream.framesPerBurst = 192;
  stream.framesPerCallback = 192;
  stream.bufferSizeFrames = 384;
  stream.bufferCapacityFrames = 768;
  stream.api = singz::detail::AndroidAudioHostApi::AAudio;
  stream.format = singz::AudioHostSampleFormat::Float32;
  stream.performance =
      singz::detail::AndroidAudioHostPerformance::LowLatency;
  stream.accessMode = singz::AudioHostAccessMode::Shared;
  return stream;
}

void testOpenedFacts() {
  std::string error;
  auto stream = goodOpened();
  CHECK(singz::detail::validateAndroidAudioHostOpenedStream(
            stream, 32, 8, 48000, 192, 1024,
            singz::AudioHostAccessMode::Shared, true, error) ==
        singz::AudioHostError::None);

  // Android route substitution is typed for both members of the pair. The
  // backend propagates this result instead of flattening it to provider error.
  stream.deviceId = 33;
  CHECK(singz::detail::validateAndroidAudioHostOpenedStream(
            stream, 32, 8, 48000, 192, 1024,
            singz::AudioHostAccessMode::Shared, true, error) ==
        singz::AudioHostError::DeviceNotFound);  // output substitution
  stream = goodOpened();
  stream.deviceId = 41;
  CHECK(singz::detail::validateAndroidAudioHostOpenedStream(
            stream, 40, 8, 48000, 0, 1024,
            singz::AudioHostAccessMode::Shared, true, error) ==
        singz::AudioHostError::DeviceNotFound);  // input substitution

  stream.api = singz::detail::AndroidAudioHostApi::OpenSles;
  stream.deviceId = 32;
  CHECK(singz::detail::validateAndroidAudioHostOpenedStream(
            stream, 32, 8, 48000, 192, 1024,
            singz::AudioHostAccessMode::Shared, true, error) ==
        singz::AudioHostError::ProviderFailure);
  stream = goodOpened();
  CHECK(singz::detail::validateAndroidAudioHostOpenedStream(
            stream, 32, 8, 48000, 192, 1024,
            singz::AudioHostAccessMode::Exclusive, true, error) ==
        singz::AudioHostError::ProviderFailure);
  stream = goodOpened();
  stream.bufferSizeFrames = 769;
  CHECK(singz::detail::validateAndroidAudioHostOpenedStream(
            stream, 32, 8, 48000, 192, 1024,
            singz::AudioHostAccessMode::Shared, true, error) ==
        singz::AudioHostError::ProviderFailure);
  stream = goodOpened();
  stream.framesPerBurst = 2048;
  CHECK(singz::detail::validateAndroidAudioHostOpenedStream(
            stream, 32, 8, 48000, 192, 1024,
            singz::AudioHostAccessMode::Shared, true, error) ==
        singz::AudioHostError::ProviderFailure);
  stream = goodOpened();
  stream.hardwareChannels = 8;
  CHECK(singz::detail::validateAndroidAudioHostOpenedStream(
            stream, 32, 8, 48000, 192, 1024,
            singz::AudioHostAccessMode::Shared, true, error) ==
        singz::AudioHostError::ProviderFailure);
  stream.hardwareSampleRate = 48000;
  stream.hardwareFormat =
      singz::AudioHostSampleFormat::Other;
  CHECK(singz::detail::validateAndroidAudioHostOpenedStream(
            stream, 32, 8, 48000, 192, 1024,
            singz::AudioHostAccessMode::Shared, true, error) ==
        singz::AudioHostError::None);
}

void testDrainPolicy() {
  singz::detail::AndroidAudioHostDrainState state{2, 1, 2};
  CHECK(singz::detail::androidAudioHostDrainAction(&state, false) ==
        singz::detail::AndroidAudioHostDrainAction::Drain);
  CHECK(state.callbacksToDrain == 2);
  CHECK(singz::detail::androidAudioHostDrainAction(&state, true) ==
        singz::detail::AndroidAudioHostDrainAction::Drain);
  CHECK(state.callbacksToDrain == 1);
  CHECK(singz::detail::androidAudioHostDrainAction(&state, true) ==
        singz::detail::AndroidAudioHostDrainAction::Drain);
  CHECK(singz::detail::androidAudioHostDrainAction(&state, false) ==
        singz::detail::AndroidAudioHostDrainAction::Cushion);
  CHECK(singz::detail::androidAudioHostDrainAction(&state, false) ==
        singz::detail::AndroidAudioHostDrainAction::Discard);
  CHECK(singz::detail::androidAudioHostDrainAction(&state, false) ==
        singz::detail::AndroidAudioHostDrainAction::Discard);
  CHECK(singz::detail::androidAudioHostDrainAction(&state, false) ==
        singz::detail::AndroidAudioHostDrainAction::Render);
}

void testTimestampFreshnessAndDeadline() {
  using singz::detail::AndroidAudioHostTimestampAnchor;
  const AndroidAudioHostTimestampAnchor empty{};
  CHECK(!singz::detail::projectAndroidAudioHostTimestamp(
             empty, 0, 48000, 1000000000ULL).hardware);
  const AndroidAudioHostTimestampAnchor anchor{
      480, 1000000000ULL, 1000000000ULL, true};
  auto projection = singz::detail::projectAndroidAudioHostTimestamp(
      anchor, 960, 48000, 1010000000ULL);
  CHECK(projection.hardware);
  CHECK(projection.hostTimeNs == 1010000000ULL);
  projection = singz::detail::projectAndroidAudioHostTimestamp(
      anchor, 960, 48000,
      1000000000ULL +
          singz::detail::kAndroidAudioHostTimestampFreshnessNs + 1);
  CHECK(!projection.hardware);
  CHECK(projection.hostTimeNs == 0);
  const AndroidAudioHostTimestampAnchor staleFrameTime{
      480, 1, 1000000000ULL, true};
  CHECK(!singz::detail::projectAndroidAudioHostTimestamp(
             staleFrameTime, 960, 48000, 1010000000ULL).hardware);
  CHECK(!singz::detail::androidAudioHostDeadlineMiss(
      1000, 1000 + 3999999, 192, 48000));
  CHECK(singz::detail::androidAudioHostDeadlineMiss(
      1000, 1000 + 4000001, 192, 48000));
}

void testBothDriverXrunsResetTheGraph() {
  singz::detail::AndroidAudioHostDriverXrunState state{3, 5};
  CHECK(!singz::detail::androidAudioHostDriverXrunChanged(&state, 3, 5));
  CHECK(singz::detail::androidAudioHostDriverXrunChanged(&state, 4, 5));
  CHECK(singz::detail::androidAudioHostDriverXrunChanged(&state, 4, 6));
}

struct OwnerProbe { int value{17}; };

void testLateCallbackOwnerEntryIsRejected() {
  CHECK(singz::detail::androidAudioHostRejectedCallbackContinues());
  singz::AudioInputCallbackOwnerGate<OwnerProbe> gate;
  OwnerProbe owner;
  gate.open(&owner);
  CHECK(gate.enter() == &owner);
  gate.leave();
  gate.beginClose();
  CHECK(gate.inFlight() == 0);
  CHECK(gate.clearOwnerIfQuiescent());
  CHECK(gate.enter() == nullptr);
}

void testTerminalErrorHandoffCompletesExactlyOnce() {
  singz::detail::AndroidAudioHostErrorHandoffState handoff;
  int stream = 0;
  CHECK(singz::detail::androidAudioHostRequestErrorTeardown(
            &handoff, 7, &stream).generation == 0);
  handoff.shutdown = false;
  const auto first = singz::detail::androidAudioHostRequestErrorTeardown(
      &handoff, 7, &stream);
  CHECK(first.generation == 1);
  CHECK(first.pairEpoch == 7);
  CHECK(first.failingStream == &stream);
  CHECK(!singz::detail::androidAudioHostErrorTeardownComplete(handoff, first));
  const auto taken =
      singz::detail::androidAudioHostTakeErrorTeardown(&handoff);
  CHECK(taken.generation == first.generation);
  CHECK(taken.pairEpoch == first.pairEpoch);
  CHECK(taken.failingStream == first.failingStream);
  CHECK(singz::detail::androidAudioHostTakeErrorTeardown(&handoff)
            .generation == 0);
  singz::detail::androidAudioHostCompleteErrorTeardown(&handoff, first);
  CHECK(singz::detail::androidAudioHostErrorTeardownComplete(handoff, first));
  const auto late = singz::detail::androidAudioHostRequestErrorTeardown(
      &handoff, 7, &stream);
  CHECK(late.generation == 2);
  handoff.shutdown = true;
  CHECK(singz::detail::androidAudioHostErrorTeardownComplete(handoff, late));
}

void openPair(singz::detail::AndroidAudioHostPairState* state, uint64_t epoch,
              const void* input, const void* output) {
  CHECK(singz::detail::androidAudioHostBeginPairOpen(state, epoch));
  CHECK(singz::detail::androidAudioHostPublishOutputIdentity(state, epoch,
                                                             output));
  if (input != nullptr) {
    CHECK(singz::detail::androidAudioHostPublishInputIdentity(state, epoch,
                                                              input));
  }
  CHECK(singz::detail::androidAudioHostCompletePairOpen(
      state, epoch, output, input, input != nullptr));
}

void runPair(singz::detail::AndroidAudioHostPairState* state, uint64_t epoch) {
  CHECK(singz::detail::androidAudioHostBeginPairStart(state, epoch));
  state->inputStarted = state->inputIdentity != nullptr;
  state->outputStarted = true;
  state->timestampSamplerStarted = true;
  CHECK(singz::detail::androidAudioHostCompletePairStart(state, epoch));
}

void testOldErrorCannotTouchReplacementPair() {
  int input1 = 0;
  int output1 = 0;
  int output2 = 0;
  singz::detail::AndroidAudioHostPairState state;
  std::mutex lifecycle;
  openPair(&state, 1, &input1, &output1);
  runPair(&state, 1);
  std::latch errorClaimed(1);
  std::latch releaseWorker(1);
  std::latch workerCompleted(1);
  std::thread worker([&] {
    {
      std::lock_guard<std::mutex> lock(lifecycle);
      CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
                &state, 1, &output1) ==
            singz::detail::AndroidAudioHostErrorClaim::Claimed);
    }
    errorClaimed.count_down();
    releaseWorker.wait();
    {
      std::lock_guard<std::mutex> lock(lifecycle);
      CHECK(singz::detail::androidAudioHostBeginErrorWorker(&state, 1,
                                                            &output1));
      CHECK(singz::detail::androidAudioHostCompleteErrorWorker(
          &state, 1, &output1, false));
      CHECK(state.phase ==
            singz::detail::AndroidAudioHostPairPhase::ErrorStopping);
    }
    workerCompleted.count_down();
  });
  errorClaimed.wait();
  {
    std::lock_guard<std::mutex> lock(lifecycle);
    CHECK(singz::detail::androidAudioHostClaimUserStop(&state, 1) ==
          singz::detail::AndroidAudioHostUserStopAction::WaitForErrorWorker);
    CHECK(!singz::detail::androidAudioHostBeginPairOpen(&state, 2));
  }
  releaseWorker.count_down();
  workerCompleted.wait();
  worker.join();
  {
    std::lock_guard<std::mutex> lock(lifecycle);
    CHECK(singz::detail::androidAudioHostCompleteUserStop(&state, 1, false));
    openPair(&state, 2, nullptr, &output2);
    // A duplicate/delayed old-pair worker cannot acquire the replacement.
    CHECK(!singz::detail::androidAudioHostBeginErrorWorker(&state, 1,
                                                           &output1));
  }
  CHECK(state.epoch == 2);
  CHECK(state.outputIdentity == &output2);
  CHECK(state.phase == singz::detail::AndroidAudioHostPairPhase::Open);
}

void testUncertaintyObservedAcrossDrainWindow() {
  int output = 0;
  singz::detail::AndroidAudioHostPairState state;
  std::mutex lifecycle;
  openPair(&state, 9, nullptr, &output);
  runPair(&state, 9);
  CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
            &state, 9, &output) ==
        singz::detail::AndroidAudioHostErrorClaim::Claimed);
  CHECK(singz::detail::androidAudioHostClaimUserStop(&state, 9) ==
        singz::detail::AndroidAudioHostUserStopAction::WaitForErrorWorker);
  std::latch workerMayFinish(1);
  std::thread worker([&] {
    workerMayFinish.wait();
    std::lock_guard<std::mutex> lock(lifecycle);
    CHECK(singz::detail::androidAudioHostBeginErrorWorker(&state, 9,
                                                          &output));
    CHECK(singz::detail::androidAudioHostCompleteErrorWorker(
        &state, 9, &output, true));
  });
  // This models the real stop() drain window: lifecycle ownership is released
  // while the exact-pair error worker publishes its close uncertainty.
  workerMayFinish.count_down();
  worker.join();
  {
    std::lock_guard<std::mutex> lock(lifecycle);
    CHECK(!singz::detail::androidAudioHostCompleteUserStop(&state, 9, false));
  }
  CHECK(state.uncertainty);
  CHECK(state.phase == singz::detail::AndroidAudioHostPairPhase::Quarantined);
}

void testSecondPairErrorMakesOwnedTeardownUncertain() {
  int input = 0;
  int output = 0;
  singz::detail::AndroidAudioHostPairState state;
  openPair(&state, 10, &input, &output);
  runPair(&state, 10);
  CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
            &state, 10, &output) ==
        singz::detail::AndroidAudioHostErrorClaim::Claimed);
  CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
            &state, 10, &input) ==
        singz::detail::AndroidAudioHostErrorClaim::Stale);
  CHECK(state.uncertainty);
  CHECK(state.errorStreamIdentity == &output);
}

void testConcurrentStartAndErrorSerialize() {
  int output = 0;
  singz::detail::AndroidAudioHostPairState state;
  openPair(&state, 12, nullptr, &output);
  std::mutex lifecycle;
  std::atomic<bool> startWon{false};
  std::atomic<singz::detail::AndroidAudioHostErrorClaim> errorClaim{
      singz::detail::AndroidAudioHostErrorClaim::Stale};
  std::thread start([&] {
    std::lock_guard<std::mutex> lock(lifecycle);
    if (singz::detail::androidAudioHostBeginPairStart(&state, 12)) {
      state.outputStarted = true;
      state.timestampSamplerStarted = true;
      startWon.store(singz::detail::androidAudioHostCompletePairStart(
                         &state, 12),
                     std::memory_order_release);
    }
  });
  std::thread error([&] {
    std::lock_guard<std::mutex> lock(lifecycle);
    errorClaim.store(singz::detail::androidAudioHostClaimErrorTeardown(
                         &state, 12, &output),
                     std::memory_order_release);
  });
  start.join();
  error.join();
  CHECK(errorClaim.load(std::memory_order_acquire) ==
        singz::detail::AndroidAudioHostErrorClaim::Claimed);
  CHECK(!startWon.load(std::memory_order_acquire) || state.outputStarted);
  CHECK(state.teardownOwner ==
        singz::detail::AndroidAudioHostTeardownOwner::ErrorWorker);
  CHECK(state.phase == singz::detail::AndroidAudioHostPairPhase::ErrorOwned);
}

void testConcurrentStopAndErrorHaveOneTeardownOwner() {
  int output = 0;
  singz::detail::AndroidAudioHostPairState state;
  openPair(&state, 21, nullptr, &output);
  runPair(&state, 21);
  std::mutex lifecycle;
  std::atomic<singz::detail::AndroidAudioHostUserStopAction> stopAction{
      singz::detail::AndroidAudioHostUserStopAction::Stale};
  std::atomic<singz::detail::AndroidAudioHostErrorClaim> errorClaim{
      singz::detail::AndroidAudioHostErrorClaim::Stale};
  std::thread stop([&] {
    std::lock_guard<std::mutex> lock(lifecycle);
    stopAction.store(singz::detail::androidAudioHostClaimUserStop(&state, 21),
                     std::memory_order_release);
  });
  std::thread error([&] {
    std::lock_guard<std::mutex> lock(lifecycle);
    errorClaim.store(singz::detail::androidAudioHostClaimErrorTeardown(
                         &state, 21, &output),
                     std::memory_order_release);
  });
  stop.join();
  error.join();
  const auto owner = state.teardownOwner;
  CHECK(owner == singz::detail::AndroidAudioHostTeardownOwner::User ||
        owner == singz::detail::AndroidAudioHostTeardownOwner::ErrorWorker);
  if (owner == singz::detail::AndroidAudioHostTeardownOwner::User) {
    CHECK(errorClaim.load(std::memory_order_acquire) ==
          singz::detail::AndroidAudioHostErrorClaim::UserOwned);
    CHECK(state.uncertainty);
  } else {
    CHECK(stopAction.load(std::memory_order_acquire) ==
          singz::detail::AndroidAudioHostUserStopAction::WaitForErrorWorker);
  }
}

void testQuarantineRetainsControlAndRejectsResume() {
  auto control =
      std::make_shared<singz::detail::AndroidAudioHostPairState>();
  std::weak_ptr<singz::detail::AndroidAudioHostPairState> observed =
      control;
  int output = 0;
  openPair(control.get(), 30, nullptr, &output);
  CHECK(singz::detail::androidAudioHostClaimUserStop(control.get(), 30) ==
        singz::detail::AndroidAudioHostUserStopAction::OperatePair);
  CHECK(!singz::detail::androidAudioHostCompleteUserStop(control.get(), 30,
                                                         true));
  const auto quarantine = control;
  control.reset();
  CHECK(!observed.expired());
  CHECK(quarantine->phase ==
        singz::detail::AndroidAudioHostPairPhase::Quarantined);
  CHECK(!singz::detail::androidAudioHostBeginPairOpen(quarantine.get(), 31));
}

void testBeforeCloseDrainsBlockedTimestampQuery() {
  singz::detail::AndroidAudioHostSamplerOwner sampler;
  std::latch queryEntered(1);
  std::latch releaseQuery(1);
  std::atomic<bool> queryExited{false};
  CHECK(sampler.start(41, [&](const std::atomic<uint32_t>&) {
    queryEntered.count_down();
    releaseQuery.wait();
    queryExited.store(true, std::memory_order_release);
  }));
  queryEntered.wait();

  std::latch beforeCloseCalled(1);
  std::atomic<bool> beforeCloseReturned{false};
  std::atomic<bool> closeObservedDrainedQuery{false};
  std::thread beforeClose([&] {
    beforeCloseCalled.count_down();
    sampler.stopAndJoin(41);
    beforeCloseReturned.store(true, std::memory_order_release);
    // Models the Oboe close which follows onErrorBeforeClose's return.
    closeObservedDrainedQuery.store(
        queryExited.load(std::memory_order_acquire),
        std::memory_order_release);
  });
  beforeCloseCalled.wait();
  // The query cannot exit before the test releases it, therefore a correct
  // synchronous drain cannot have returned yet.
  CHECK(!queryExited.load(std::memory_order_acquire));
  CHECK(!beforeCloseReturned.load(std::memory_order_acquire));
  releaseQuery.count_down();
  beforeClose.join();
  CHECK(beforeCloseReturned.load(std::memory_order_acquire));
  CHECK(closeObservedDrainedQuery.load(std::memory_order_acquire));
}

void testBeforeCloseEpochGateRejectsLateSamplerStart() {
  singz::detail::AndroidAudioHostSamplerOwner sampler;
  sampler.stopAndJoin(50);
  CHECK(!sampler.start(50, [](const std::atomic<uint32_t>&) {}));
  std::latch newerStarted(1);
  CHECK(sampler.start(51, [&](const std::atomic<uint32_t>& stop) {
    newerStarted.count_down();
    while (stop.load(std::memory_order_acquire) == 0) {
      std::this_thread::yield();
    }
  }));
  newerStarted.wait();
  sampler.stopAndJoin(50);  // stale old epoch cannot stop the replacement.
  CHECK(sampler.runningFor(51));
  sampler.stopAndJoin(51);
  CHECK(!sampler.runningFor(51));
}

void testProductionLifecycleCallOrderAndErrorRaces() {
  int input = 0;
  int output = 0;
  std::vector<std::string> calls;
  const auto started = singz::detail::androidAudioHostStartPair(
      &input, &output,
      [&](const void* stream) {
        calls.push_back(stream == &input ? "request input" : "request output");
        return true;
      },
      [&](const void* stream) {
        calls.push_back(stream == &input ? "wait input" : "wait output");
        return true;
      },
      [&](const void* stream) {
        calls.push_back(stream == &input ? "started input" : "started output");
      },
      [] { return true; });
  CHECK(started == singz::detail::AndroidAudioHostLifecycleRun::Completed);
  CHECK((calls == std::vector<std::string>{
                      "request input", "wait input", "started input",
                      "request output", "wait output", "started output"}));

  singz::detail::AndroidAudioHostPairState startState;
  openPair(&startState, 60, &input, &output);
  CHECK(singz::detail::androidAudioHostBeginPairStart(&startState, 60));
  calls.clear();
  const auto failedDuringInputWait = singz::detail::androidAudioHostStartPair(
      &input, &output,
      [&](const void* stream) {
        calls.push_back(stream == &input ? "request input" : "request output");
        return true;
      },
      [&](const void* stream) {
        calls.push_back(stream == &input ? "wait input" : "wait output");
        CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
                  &startState, 60, stream) ==
              singz::detail::AndroidAudioHostErrorClaim::Claimed);
        return true;
      },
      [](const void*) {},
      [&] {
        return startState.teardownOwner ==
               singz::detail::AndroidAudioHostTeardownOwner::None;
      });
  CHECK(failedDuringInputWait ==
        singz::detail::AndroidAudioHostLifecycleRun::Superseded);
  CHECK((calls == std::vector<std::string>{"request input", "wait input"}));

  singz::detail::AndroidAudioHostPairState requestState;
  openPair(&requestState, 62, &input, &output);
  CHECK(singz::detail::androidAudioHostBeginPairStart(&requestState, 62));
  calls.clear();
  const auto failedDuringRequest = singz::detail::androidAudioHostStartPair(
      &input, &output,
      [&](const void* stream) {
        calls.push_back(stream == &input ? "request input" : "request output");
        CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
                  &requestState, 62, stream) ==
              singz::detail::AndroidAudioHostErrorClaim::Claimed);
        return true;
      },
      [&](const void* stream) {
        calls.push_back(stream == &input ? "wait input" : "wait output");
        return true;
      },
      [](const void*) {},
      [&] {
        return requestState.teardownOwner ==
               singz::detail::AndroidAudioHostTeardownOwner::None;
      });
  CHECK(failedDuringRequest ==
        singz::detail::AndroidAudioHostLifecycleRun::Superseded);
  CHECK((calls == std::vector<std::string>{"request input"}));

  singz::detail::AndroidAudioHostPairState stopState;
  openPair(&stopState, 61, &input, &output);
  runPair(&stopState, 61);
  CHECK(singz::detail::androidAudioHostClaimUserStop(&stopState, 61) ==
        singz::detail::AndroidAudioHostUserStopAction::OperatePair);
  calls.clear();
  const auto errorDuringStop = singz::detail::androidAudioHostStopClosePair(
      &input, true, &output, true, nullptr,
      [&](const void* stream) {
        calls.push_back(stream == &output ? "stop output" : "stop input");
        CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
                  &stopState, 61, stream) ==
              singz::detail::AndroidAudioHostErrorClaim::UserOwned);
        return true;
      },
      [&](const void* stream) {
        calls.push_back(stream == &output ? "close output" : "close input");
        return true;
      },
      [&] { return !stopState.uncertainty; });
  CHECK(errorDuringStop ==
        singz::detail::AndroidAudioHostLifecycleRun::Superseded);
  CHECK((calls == std::vector<std::string>{"stop output"}));

  // after-close worker never lifecycle-calls the stream Oboe already closed;
  // it stops then closes only the peer.
  calls.clear();
  const auto peerOnly = singz::detail::androidAudioHostStopClosePair(
      &input, true, &output, true, &output,
      [&](const void* stream) {
        calls.push_back(stream == &input ? "stop input" : "stop output");
        return true;
      },
      [&](const void* stream) {
        calls.push_back(stream == &input ? "close input" : "close output");
        return true;
      },
      [] { return true; });
  CHECK(peerOnly == singz::detail::AndroidAudioHostLifecycleRun::Completed);
  CHECK((calls == std::vector<std::string>{"stop input", "close input"}));
}

void testOpeningErrorLinearizationWindows() {
  using singz::detail::AndroidAudioHostErrorClaim;
  using singz::detail::AndroidAudioHostPairState;
  int output = 0;
  int input = 0;

  // Output callback synchronously inside openStream, before the application
  // can publish the output identity. The exact callback epoch binds it.
  AndroidAudioHostPairState outputPrepublish;
  CHECK(singz::detail::androidAudioHostBeginPairOpen(&outputPrepublish, 70));
  CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
            &outputPrepublish, 70, &output) == AndroidAudioHostErrorClaim::Claimed);
  CHECK(outputPrepublish.errorStreamIdentity == &output);
  CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
            &outputPrepublish, 70, &output) ==
        AndroidAudioHostErrorClaim::AlreadyClaimed);
  CHECK(!singz::detail::androidAudioHostPublishOutputIdentity(
      &outputPrepublish, 70, &output));
  CHECK(!singz::detail::androidAudioHostCompletePairOpen(
      &outputPrepublish, 70, &output, nullptr, false));

  // Error immediately after exact output identity publication.
  AndroidAudioHostPairState outputPublished;
  CHECK(singz::detail::androidAudioHostBeginPairOpen(&outputPublished, 71));
  CHECK(singz::detail::androidAudioHostPublishOutputIdentity(
      &outputPublished, 71, &output));
  CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
            &outputPublished, 71, &output) == AndroidAudioHostErrorClaim::Claimed);
  CHECK(!singz::detail::androidAudioHostCompletePairOpen(
      &outputPublished, 71, &output, nullptr, false));

  // Input callback inside input openStream after output publication but before
  // input publication binds the still-provisional member to this epoch.
  AndroidAudioHostPairState inputPrepublish;
  CHECK(singz::detail::androidAudioHostBeginPairOpen(&inputPrepublish, 72));
  CHECK(singz::detail::androidAudioHostPublishOutputIdentity(
      &inputPrepublish, 72, &output));
  CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
            &inputPrepublish, 72, &input) == AndroidAudioHostErrorClaim::Claimed);
  CHECK(inputPrepublish.errorStreamIdentity == &input);
  CHECK(!singz::detail::androidAudioHostPublishInputIdentity(
      &inputPrepublish, 72, &input));

  // Both identities exist, but an error which wins before the final commit
  // makes the one Opening->Open transition fail.
  AndroidAudioHostPairState beforeCommit;
  CHECK(singz::detail::androidAudioHostBeginPairOpen(&beforeCommit, 73));
  CHECK(singz::detail::androidAudioHostPublishOutputIdentity(
      &beforeCommit, 73, &output));
  CHECK(singz::detail::androidAudioHostPublishInputIdentity(
      &beforeCommit, 73, &input));
  CHECK(singz::detail::androidAudioHostPairOpeningMatches(
      beforeCommit, 73, &output, &input, true, true));
  CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
            &beforeCommit, 73, &input) == AndroidAudioHostErrorClaim::Claimed);
  CHECK(!singz::detail::androidAudioHostCompletePairOpen(
      &beforeCommit, 73, &output, &input, true));

  // A callback object stamped for an earlier pair can never bind to the new
  // Opening transaction, even while one current identity is provisional.
  AndroidAudioHostPairState replacement;
  CHECK(singz::detail::androidAudioHostBeginPairOpen(&replacement, 74));
  CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
            &replacement, 73, &output) == AndroidAudioHostErrorClaim::Stale);
  CHECK(singz::detail::androidAudioHostPublishOutputIdentity(
      &replacement, 74, &output));
  CHECK(singz::detail::androidAudioHostCompletePairOpen(
      &replacement, 74, &output, nullptr, false));
}

singz::detail::AndroidAudioHostStartCommitFacts healthyStartFacts(
    const void* input, const void* output, bool requireInput,
    uint32_t generation = 0) {
  return {input, output, requireInput, !requireInput || input != nullptr,
          output != nullptr, true, true, true, generation, generation};
}

void testStartCommitLinearizationWindows() {
  using singz::detail::AndroidAudioHostErrorClaim;
  using singz::detail::AndroidAudioHostPairPhase;
  using singz::detail::AndroidAudioHostPairState;
  int input = 0;
  int output = 0;

  // The immutable token is captured while the pair is still Open and the
  // callback gate is closed. A stable snapshot starts normally.
  AndroidAudioHostPairState stableBaseline;
  openPair(&stableBaseline, 79, &input, &output);
  const singz::detail::AndroidAudioHostStartBaselineFacts stableFacts{
      0, true, false, true, 0};
  CHECK(singz::detail::androidAudioHostStartBaselineHealthy(stableFacts));
  CHECK(singz::detail::androidAudioHostBeginPairStart(
      &stableBaseline, 79, stableFacts));

  // Token-only publication is enough to reject the snapshot even while the
  // terminal thread has not yet reached its runtimeFailure/admission stores.
  const singz::detail::AndroidAudioHostStartBaselineFacts splitBaseline{
      0, true, false, true, 1};
  CHECK(!singz::detail::androidAudioHostStartBaselineHealthy(splitBaseline));

  // Oboe error wins pairMutex after the final healthy precheck but before the
  // commit. The production commit observes ErrorOwned and cannot publish
  // Running.
  AndroidAudioHostPairState errorBeforeCommit;
  openPair(&errorBeforeCommit, 80, &input, &output);
  CHECK(singz::detail::androidAudioHostBeginPairStart(&errorBeforeCommit, 80));
  errorBeforeCommit.inputStarted = true;
  errorBeforeCommit.outputStarted = true;
  auto facts = healthyStartFacts(&input, &output, true);
  CHECK(singz::detail::androidAudioHostStartCommitHealthy(
      errorBeforeCommit, 80, facts));
  CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
            &errorBeforeCommit, 80, &output) ==
        AndroidAudioHostErrorClaim::Claimed);
  CHECK(!singz::detail::androidAudioHostCommitPairStart(
      &errorBeforeCommit, 80, facts));

  // Commit wins first. The later Oboe error transitions the already Running
  // pair and public state to Error; there is deliberately no second Running
  // publication after commit which could overwrite it.
  AndroidAudioHostPairState errorAfterCommit;
  openPair(&errorAfterCommit, 81, &input, &output);
  CHECK(singz::detail::androidAudioHostBeginPairStart(&errorAfterCommit, 81));
  errorAfterCommit.inputStarted = true;
  errorAfterCommit.outputStarted = true;
  std::atomic<singz::AudioHostState> publicState{singz::AudioHostState::Open};
  CHECK(singz::detail::androidAudioHostCommitPairStart(
      &errorAfterCommit, 81, facts));
  publicState.store(singz::AudioHostState::Running,
                    std::memory_order_release);
  CHECK(singz::detail::androidAudioHostClaimErrorTeardown(
            &errorAfterCommit, 81, &output) ==
        AndroidAudioHostErrorClaim::Claimed);
  publicState.store(singz::AudioHostState::Error, std::memory_order_release);
  CHECK(publicState.load(std::memory_order_acquire) ==
        singz::AudioHostState::Error);
  CHECK(errorAfterCommit.phase == AndroidAudioHostPairPhase::ErrorOwned);

  // RT terminal increments the lock-free generation without pairMutex. If it
  // lands after precheck but before commit, generation/failure/admission make
  // the production commit fail.
  AndroidAudioHostPairState rtBeforeCommit;
  openPair(&rtBeforeCommit, 82, &input, &output);
  CHECK(singz::detail::androidAudioHostBeginPairStart(&rtBeforeCommit, 82));
  rtBeforeCommit.inputStarted = true;
  rtBeforeCommit.outputStarted = true;
  auto terminalFacts = facts;
  terminalFacts.observedFailureGeneration = 1;
  // The delayed terminal stores have not happened: generation alone must
  // reject commit, rather than becoming a newly sampled baseline.
  terminalFacts.runtimeHealthy = true;
  terminalFacts.callbackAccepting = true;
  CHECK(!singz::detail::androidAudioHostCommitPairStart(
      &rtBeforeCommit, 82, terminalFacts));

  // RT terminal after commit but before the bracketed final acquire recheck
  // forces cleanup rather than returning a false success.
  AndroidAudioHostPairState rtAfterCommit;
  openPair(&rtAfterCommit, 83, &input, &output);
  CHECK(singz::detail::androidAudioHostBeginPairStart(&rtAfterCommit, 83));
  rtAfterCommit.inputStarted = true;
  rtAfterCommit.outputStarted = true;
  CHECK(singz::detail::androidAudioHostCommitPairStart(
      &rtAfterCommit, 83, facts));
  CHECK(!singz::detail::androidAudioHostFinalStartHealthy(
      0, 1, true, true, true, 1));

  // Exact normalized-in-flight schedule: start captured immutable token 0;
  // terminal publishes token 1 and stalls before failure/admission. A late
  // read may see 1, but neither commit nor the final gate may adopt it.
  AndroidAudioHostPairState delayedTerminal;
  openPair(&delayedTerminal, 84, &input, &output);
  CHECK(singz::detail::androidAudioHostBeginPairStart(
      &delayedTerminal, 84, stableFacts));
  delayedTerminal.inputStarted = true;
  delayedTerminal.outputStarted = true;
  auto delayedFacts = healthyStartFacts(&input, &output, true, 0);
  delayedFacts.observedFailureGeneration = 1;
  CHECK(delayedFacts.runtimeHealthy);
  CHECK(delayedFacts.callbackAccepting);
  CHECK(!singz::detail::androidAudioHostCommitPairStart(
      &delayedTerminal, 84, delayedFacts));
  CHECK(!singz::detail::androidAudioHostFinalStartHealthy(
      0, 1, true, true, true, 1));

  // A terminal ordered after the second generation read is a normal
  // post-start runtime failure and does not retroactively invalidate success.
  CHECK(singz::detail::androidAudioHostFinalStartHealthy(
      0, 0, true, true, true, 0));
  const uint32_t terminalAfterReturn = 1;
  CHECK(terminalAfterReturn != 0);
}

}  // namespace

int main() {
  testSparsePairedRoute();
  testMonitoringSuitabilityIsTriState();
  testOutputOnlyAndHighLatency();
  testFailClosedPreparation();
  testOpenedFacts();
  testDrainPolicy();
  testTimestampFreshnessAndDeadline();
  testBothDriverXrunsResetTheGraph();
  testLateCallbackOwnerEntryIsRejected();
  testTerminalErrorHandoffCompletesExactlyOnce();
  testOldErrorCannotTouchReplacementPair();
  testUncertaintyObservedAcrossDrainWindow();
  testSecondPairErrorMakesOwnedTeardownUncertain();
  testConcurrentStartAndErrorSerialize();
  testConcurrentStopAndErrorHaveOneTeardownOwner();
  testQuarantineRetainsControlAndRejectsResume();
  testBeforeCloseDrainsBlockedTimestampQuery();
  testBeforeCloseEpochGateRejectsLateSamplerStart();
  testProductionLifecycleCallOrderAndErrorRaces();
  testOpeningErrorLinearizationWindows();
  testStartCommitLinearizationWindows();
  std::puts("audio_host_android_policy_tests passed");
  return 0;
}
