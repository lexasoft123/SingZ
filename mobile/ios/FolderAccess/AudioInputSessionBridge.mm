#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

#include "audio_input_ios_session.h"

#include <zdsp/analysis/capture_adapter.h>
#include <zcore/device/audio_input.h>

#include <atomic>
#include <cerrno>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <memory>
#include <mutex>
#include <string>

namespace {

enum class CaptureOwnerPhase : uint8_t { Running, Stopping, FullyStopped };

struct CaptureOwnerState {
  explicit CaptureOwnerState(uint64_t ownerGeneration)
      : generation(ownerGeneration) {}

  uint64_t generation = 0;
  CaptureOwnerPhase phase = CaptureOwnerPhase::Running;
  bool stopSucceeded = false;
  std::string stopError;
};

}  // namespace

@interface AudioInputSession : RCTEventEmitter <RCTBridgeModule>
{
 @private
  std::mutex _captureMutex;
  std::condition_variable _captureCondition;
  std::shared_ptr<CaptureOwnerState> _captureOwner;
  std::unique_ptr<singz::AudioInput> _captureInput;
  std::shared_ptr<void> _captureContext;
  dispatch_source_t _captureMonitor;
 @public
  std::atomic<bool> _hasListeners;
}
@end

namespace {

bool parseToken(NSString* tokenString, uint64_t& token)
{
  token = 0;
  const char* tokenChars = tokenString.UTF8String;
  if (!tokenChars || !tokenChars[0]) return false;
  errno = 0;
  char* end = nullptr;
  const unsigned long long parsed = std::strtoull(tokenChars, &end, 10);
  if (errno != 0 || end == tokenChars || *end != '\0' || parsed == 0) return false;
  token = static_cast<uint64_t>(parsed);
  return true;
}

NSString* errorMessage(const char* error, NSString* fallback)
{
  return error[0] ? [NSString stringWithUTF8String:error] : fallback;
}

NSString* timestampQuality(zdsp::CaptureTimestampQuality quality)
{
  switch (quality) {
    case zdsp::CaptureTimestampQuality::Hardware: return @"hardware";
    case zdsp::CaptureTimestampQuality::Estimated: return @"callback-estimate";
    case zdsp::CaptureTimestampQuality::Unknown: return @"unknown";
  }
  return @"unknown";
}

NSString* discontinuityReason(zdsp::DiscontinuityReason reason)
{
  switch (reason) {
    case zdsp::DiscontinuityReason::None: return @"none";
    case zdsp::DiscontinuityReason::StreamGenerationChanged: return @"stream-generation";
    case zdsp::DiscontinuityReason::SequenceGap: return @"sequence-gap";
    case zdsp::DiscontinuityReason::SampleRateChanged: return @"sample-rate";
    case zdsp::DiscontinuityReason::TimestampQualityChanged: return @"timestamp-quality";
    case zdsp::DiscontinuityReason::ClockReanchored: return @"clock-reanchored";
    case zdsp::DiscontinuityReason::DeviceLost: return @"device-lost";
    case zdsp::DiscontinuityReason::SourceFrameOverflow: return @"source-frame-overflow";
    case zdsp::DiscontinuityReason::RouteGenerationChanged: return @"route-generation";
    case zdsp::DiscontinuityReason::SourceSeek: return @"source-seek";
    case zdsp::DiscontinuityReason::SourceLoop: return @"source-loop";
  }
  return @"device-lost";
}

bool stopAndDestroyCaptureInput(std::unique_ptr<singz::AudioInput>& input,
                                std::string& error)
{
  error.clear();
  if (!input) return true;
  input->stop();
  const singz::AudioInputState stoppedState = input->state();
  if (stoppedState != singz::AudioInputState::Stopped) {
    error = input->lastError();
    if (error.empty()) error = "iOS audio input delivery join did not complete";
  }
  // stop() joins delivery before destruction. Destroy the native owner before
  // publishing FullyStopped so no waiter can release process-global session
  // ownership while AudioInput cleanup is still live.
  input.reset();
  return stoppedState == singz::AudioInputState::Stopped;
}

struct IosCaptureBridge {
  __weak AudioInputSession* owner = nil;
  uint64_t generation = 0;
  std::atomic<bool> active{true};
  zdsp::analysis::LiveInputAnalysisAdapter adapter;

  IosCaptureBridge(AudioInputSession* inputOwner, uint64_t inputGeneration)
      : owner(inputOwner), generation(inputGeneration), adapter(inputGeneration) {}

  void accept(const singz::AudioInputBlockView& block)
  {
    if (!active.load(std::memory_order_acquire)) return;
    (void)adapter.push(block, [this](const zdsp::analysis::AnalysisWindow& window) {
      // AudioInput delivery is a native std::thread with no ambient Cocoa
      // autorelease pool. Keep analysis outside and bound every temporary
      // Foundation object to this scalar-event scope.
      @autoreleasepool {
        AudioInputSession* strongOwner = owner;
        if (!strongOwner || !active.load(std::memory_order_acquire) ||
            !strongOwner->_hasListeners.load(std::memory_order_acquire)) return;
        NSDictionary* payload = @{
          @"generation": @(window.ownershipGeneration),
          @"clockDomainId": [NSString stringWithFormat:@"%llu", window.start.clockDomain.value],
          @"streamGeneration": [NSString stringWithFormat:@"%llu", window.start.streamGeneration.value],
          @"startSequence": [NSString stringWithFormat:@"%llu", window.start.sequence],
          @"endSequence": [NSString stringWithFormat:@"%llu", window.end.sequence],
          @"startSourceFrame": [NSString stringWithFormat:@"%llu", window.start.sourceFrame.value],
          @"endSourceFrame": [NSString stringWithFormat:@"%llu", window.end.sourceFrame.value],
          @"sampleHostTimeStartNs": [NSString stringWithFormat:@"%llu", window.start.sampleHostTime.value],
          @"sampleHostTimeEndNs": [NSString stringWithFormat:@"%llu", window.end.sampleHostTime.value],
          @"callbackHostTimeNs": [NSString stringWithFormat:@"%llu", window.deliveredAt.value],
          @"startFlags": @(static_cast<uint32_t>(window.start.flags)),
          @"endFlags": @(static_cast<uint32_t>(window.end.flags)),
          @"timestampQuality": timestampQuality(window.start.quality),
          @"discontinuityReason": discontinuityReason(window.resetReason),
          @"resetCount": [NSString stringWithFormat:@"%llu", window.resetCount],
          @"sampleRate": @(window.sampleRate.value),
          @"frequency": @(window.analysis.frequency),
          @"clarity": @(window.analysis.clarity),
          @"peak": @(window.analysis.peak),
          @"rms": @(window.analysis.rms),
          @"dbfs": @(window.analysis.dbfs),
        };
        [strongOwner sendEventWithName:@"singzAudioInputFrame" body:payload];
      }
    });
  }
};

}  // namespace

@implementation AudioInputSession

RCT_EXPORT_MODULE(AudioInputSession)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  self = [super init];
  if (self) _hasListeners.store(false, std::memory_order_relaxed);
  return self;
}

- (NSArray<NSString*>*)supportedEvents
{
  return @[@"singzAudioInputFrame", @"singzAudioInputState"];
}

- (void)startObserving
{
  _hasListeners.store(true, std::memory_order_release);
}

- (void)stopObserving
{
  _hasListeners.store(false, std::memory_order_release);
}

- (void)cancelCaptureMonitorLocked
{
  if (!_captureMonitor) return;
  dispatch_source_t monitor = _captureMonitor;
  _captureMonitor = nil;
  dispatch_source_cancel(monitor);
}

- (void)pollCaptureState
{
  std::unique_ptr<singz::AudioInput> input;
  std::shared_ptr<IosCaptureBridge> context;
  std::shared_ptr<CaptureOwnerState> owner;
  NSString* error = nil;
  {
    std::lock_guard<std::mutex> lock(_captureMutex);
    if (!_captureInput || !_captureOwner ||
        _captureOwner->phase != CaptureOwnerPhase::Running) return;
    const singz::AudioInputState state = _captureInput->state();
    if (state != singz::AudioInputState::Error &&
        state != singz::AudioInputState::Unsupported) return;
    owner = _captureOwner;
    context = std::static_pointer_cast<IosCaptureBridge>(_captureContext);
    if (context) {
      context->active.store(false, std::memory_order_release);
    }
    const std::string nativeError = _captureInput->lastError();
    error = nativeError.empty()
        ? @"iOS audio input stopped unexpectedly"
        : [NSString stringWithUTF8String:nativeError.c_str()];
    owner->phase = CaptureOwnerPhase::Stopping;
    owner->stopSucceeded = false;
    owner->stopError.clear();
    input = std::move(_captureInput);
    _captureContext.reset();
    [self cancelCaptureMonitorLocked];
  }
  std::string stopError;
  const bool stopped = stopAndDestroyCaptureInput(input, stopError);
  // Delivery is joined and AudioInput is destroyed. Only now may analyzer
  // state/context be destroyed and FullyStopped become visible to waiters.
  context.reset();
  {
    std::lock_guard<std::mutex> lock(_captureMutex);
    owner->stopSucceeded = stopped;
    owner->stopError = stopError;
    owner->phase = CaptureOwnerPhase::FullyStopped;
  }
  _captureCondition.notify_all();
  if (_hasListeners.load(std::memory_order_acquire))
    [self sendEventWithName:@"singzAudioInputState"
                       body:@{@"generation": @(owner->generation),
                              @"state": @"error",
                              @"error": stopped
                                  ? error
                                  : [NSString stringWithUTF8String:
                                        owner->stopError.c_str()]}];
}

- (void)startCaptureMonitorLocked
{
  [self cancelCaptureMonitorLocked];
  dispatch_queue_t queue = dispatch_queue_create(
      "com.lexasoft.singz.audio-input-state", DISPATCH_QUEUE_SERIAL);
  _captureMonitor = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
  if (!_captureMonitor) return;
  dispatch_source_set_timer(_captureMonitor,
      dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC),
      50 * NSEC_PER_MSEC, 5 * NSEC_PER_MSEC);
  __weak AudioInputSession* weakSelf = self;
  dispatch_source_set_event_handler(_captureMonitor, ^{
    AudioInputSession* strongSelf = weakSelf;
    if (strongSelf) [strongSelf pollCaptureState];
  });
  dispatch_resume(_captureMonitor);
}

RCT_REMAP_METHOD(
    prepareCapturePreferences,
    prepareCapturePreferences : (NSString*)deviceUid
        minimumChannels : (nonnull NSNumber*)minimumChannels
        lowLatencyBufferDuration : (nonnull NSNumber*)lowLatencyBufferDuration
        timeoutMilliseconds : (nonnull NSNumber*)timeoutMilliseconds
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  uint64_t token = 0;
  char error[512] = {};
  const bool ok = singzIosAudioInputPrepareCapturePreferences(
      deviceUid.UTF8String, minimumChannels.unsignedIntValue,
      lowLatencyBufferDuration.doubleValue, timeoutMilliseconds.unsignedIntValue,
      &token, error, sizeof(error));
  NSMutableDictionary* result = [NSMutableDictionary dictionaryWithObject:@(ok)
                                                                   forKey:@"ok"];
  if (token != 0)
    result[@"token"] =
        [NSString stringWithFormat:@"%llu", static_cast<unsigned long long>(token)];
  if (!ok)
    result[@"error"] =
        errorMessage(error, @"Could not prepare iOS capture preferences");
  resolve(result);
}

RCT_REMAP_METHOD(
    restoreCapturePreferences,
    restoreCapturePreferences : (NSString*)tokenString
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  uint64_t token = 0;
  if (!parseToken(tokenString, token)) {
    reject(@"E_AUDIO_INPUT_PREFERENCES",
           @"The iOS capture preference token is invalid", nil);
    return;
  }
  char error[512] = {};
  if (!singzIosAudioInputRestoreCapturePreferences(token, error, sizeof(error))) {
    reject(@"E_AUDIO_INPUT_PREFERENCES",
           errorMessage(error, @"Could not restore iOS capture preferences"), nil);
    return;
  }
  resolve(nil);
}

RCT_REMAP_METHOD(
    abandonCapturePreferences,
    abandonCapturePreferences : (NSString*)tokenString
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  uint64_t token = 0;
  if (!parseToken(tokenString, token)) {
    reject(@"E_AUDIO_INPUT_PREFERENCES",
           @"The iOS capture preference token is invalid", nil);
    return;
  }
  char error[512] = {};
  singz::IosAudioInputSavedRouteStatus routeStatus =
      singz::IosAudioInputSavedRouteStatus::NotActive;
  if (!singzIosAudioInputAbandonCapturePreferences(
          token, &routeStatus, error, sizeof(error))) {
    reject(@"E_AUDIO_INPUT_PREFERENCES",
           errorMessage(error,
                        @"Could not safely abandon iOS capture preferences"),
           nil);
    return;
  }
  resolve(nil);
}

RCT_REMAP_METHOD(
    verifyCaptureSession,
    verifyCaptureSession : (NSString*)deviceUid
        minimumChannels : (nonnull NSNumber*)minimumChannels
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  char error[512] = {};
  if (!singzIosAudioInputVerifyCaptureSession(
          deviceUid.UTF8String, minimumChannels.unsignedIntValue,
          error, sizeof(error))) {
    reject(@"E_AUDIO_INPUT_SESSION",
           errorMessage(error, @"The iOS capture session is not ready"), nil);
    return;
  }
  resolve(nil);
}

RCT_REMAP_METHOD(
    verifyPlaybackSession,
    verifyPlaybackSessionWithResolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  char error[512] = {};
  if (!singzIosAudioInputVerifyPlaybackSession(error, sizeof(error))) {
    reject(@"E_AUDIO_INPUT_SESSION",
           errorMessage(error, @"The iOS playback session was not restored"), nil);
    return;
  }
  resolve(nil);
}

RCT_REMAP_METHOD(
    acquireLease,
    acquireLease : (NSString*)deviceUid
        minimumChannels : (nonnull NSNumber*)minimumChannels
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  uint64_t token = 0;
  char error[512] = {};
  if (!singzIosAudioInputAcquireSessionLease(
          deviceUid.UTF8String, minimumChannels.unsignedIntValue,
          &token, error, sizeof(error))) {
    reject(@"E_AUDIO_INPUT_SESSION",
           errorMessage(error, @"Could not acquire the iOS audio input session"),
           nil);
    return;
  }
  resolve([NSString stringWithFormat:@"%llu",
                                      static_cast<unsigned long long>(token)]);
}

RCT_REMAP_METHOD(
    releaseLease,
    releaseLease : (NSString*)tokenString resolver : (RCTPromiseResolveBlock)resolve rejecter :
        (RCTPromiseRejectBlock)reject)
{
  uint64_t token = 0;
  if (!parseToken(tokenString, token)) {
    reject(@"E_AUDIO_INPUT_SESSION", @"The iOS audio input lease token is invalid", nil);
    return;
  }
  singzIosAudioInputReleaseSessionLease(token);
  resolve(nil);
}

RCT_REMAP_METHOD(
    startCapture,
    startCapture : (NSString*)tokenString
        deviceUid : (NSString*)deviceUid
        channel : (nonnull NSNumber*)channel
        ownershipGeneration : (nonnull NSNumber*)ownershipGeneration
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  uint64_t token = 0;
  const double requestedGeneration = ownershipGeneration.doubleValue;
  const double requestedChannel = channel.doubleValue;
  if (!parseToken(tokenString, token) || !std::isfinite(requestedGeneration) ||
      requestedGeneration < 1 ||
      std::floor(requestedGeneration) != requestedGeneration ||
      requestedGeneration > 9007199254740991.0 ||
      !std::isfinite(requestedChannel) || requestedChannel < 0 ||
      std::floor(requestedChannel) != requestedChannel ||
      requestedChannel > std::numeric_limits<uint32_t>::max()) {
    reject(@"E_AUDIO_INPUT_CAPTURE", @"The iOS capture arguments are invalid", nil);
    return;
  }
  const uint64_t generation = static_cast<uint64_t>(requestedGeneration);
  const uint32_t selectedChannel = static_cast<uint32_t>(requestedChannel);
  const std::shared_ptr<singz::IosAudioInputSessionPolicy> policy =
      singz::iosAudioInputSessionPolicy();
  const singz::IosAudioInputSessionSnapshot session =
      policy ? policy->snapshot() : singz::IosAudioInputSessionSnapshot{};
  if (!session.leaseActive || session.leaseToken != token ||
      session.leaseDeviceUid != deviceUid.UTF8String ||
      selectedChannel >= session.leaseMinimumChannels) {
    reject(@"E_AUDIO_INPUT_CAPTURE",
           @"The iOS capture lease is stale or does not match the selected channel", nil);
    return;
  }

  std::lock_guard<std::mutex> lock(_captureMutex);
  if (_captureInput ||
      (_captureOwner &&
       (_captureOwner->phase != CaptureOwnerPhase::FullyStopped ||
        !_captureOwner->stopSucceeded))) {
    reject(@"E_AUDIO_INPUT_CAPTURE", @"Another iOS capture owner is active", nil);
    return;
  }
  auto context = std::make_shared<IosCaptureBridge>(self, generation);
  auto input = std::make_unique<singz::AudioInput>();
  singz::AudioInputConfig config;
  config.deviceUid = deviceUid.UTF8String;
  config.channel = selectedChannel;
  config.ringBlocks = 32;
  const singz::AudioInputResult started = input->start(
      config, [context](const singz::AudioInputBlockView& block) {
        context->accept(block);
      });
  if (!started.ok) {
    context->active.store(false, std::memory_order_release);
    reject(@"E_AUDIO_INPUT_CAPTURE",
           [NSString stringWithUTF8String:started.error.c_str()], nil);
    return;
  }
  _captureOwner = std::make_shared<CaptureOwnerState>(generation);
  _captureContext = context;
  _captureInput = std::move(input);
  [self startCaptureMonitorLocked];
  if (_hasListeners.load(std::memory_order_acquire))
    [self sendEventWithName:@"singzAudioInputState"
                       body:@{@"generation": @(generation), @"state": @"running"}];
  resolve(@{@"ok": @YES,
            @"sampleRate": @(started.sampleRate),
            @"analysisBuild": [NSString stringWithUTF8String:
                zdsp::analysis::analysisBuildId()]});
}

RCT_REMAP_METHOD(
    stopCapture,
    stopCapture : (nonnull NSNumber*)ownershipGeneration
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  const double requestedGeneration = ownershipGeneration.doubleValue;
  if (!std::isfinite(requestedGeneration) || requestedGeneration < 1 ||
      std::floor(requestedGeneration) != requestedGeneration ||
      requestedGeneration > 9007199254740991.0) {
    reject(@"E_AUDIO_INPUT_CAPTURE", @"The iOS capture generation is invalid", nil);
    return;
  }
  const uint64_t generation = static_cast<uint64_t>(requestedGeneration);
  std::unique_ptr<singz::AudioInput> input;
  std::shared_ptr<IosCaptureBridge> context;
  std::shared_ptr<CaptureOwnerState> owner;
  {
    std::unique_lock<std::mutex> lock(_captureMutex);
    owner = _captureOwner;
    if (!owner) {
      lock.unlock();
      resolve(nil);
      return;
    }
    if (owner->generation != generation) {
      lock.unlock();
      reject(@"E_AUDIO_INPUT_CAPTURE", @"The iOS capture generation is stale", nil);
      return;
    }
    if (owner->phase == CaptureOwnerPhase::Stopping) {
      _captureCondition.wait(lock, [&] {
        return owner->phase != CaptureOwnerPhase::Stopping;
      });
    }
    if (owner->phase == CaptureOwnerPhase::FullyStopped) {
      const bool stopped = owner->stopSucceeded;
      const std::string stopError = owner->stopError;
      lock.unlock();
      if (!stopped) {
        reject(@"E_AUDIO_INPUT_CAPTURE",
               [NSString stringWithUTF8String:stopError.c_str()], nil);
      } else {
        resolve(nil);
      }
      return;
    }
    context = std::static_pointer_cast<IosCaptureBridge>(_captureContext);
    if (!context || context->generation != generation || !_captureInput) {
      lock.unlock();
      reject(@"E_AUDIO_INPUT_CAPTURE", @"The iOS capture owner is inconsistent", nil);
      return;
    }
    context->active.store(false, std::memory_order_release);
    owner->phase = CaptureOwnerPhase::Stopping;
    owner->stopSucceeded = false;
    owner->stopError.clear();
    input = std::move(_captureInput);
    _captureContext.reset();
    [self cancelCaptureMonitorLocked];
  }
  std::string stopError;
  const bool stopped = stopAndDestroyCaptureInput(input, stopError);
  // The delivery join and native-owner destruction precede analyzer teardown.
  context.reset();
  {
    std::lock_guard<std::mutex> lock(_captureMutex);
    owner->stopSucceeded = stopped;
    owner->stopError = stopError;
    owner->phase = CaptureOwnerPhase::FullyStopped;
  }
  _captureCondition.notify_all();
  if (!stopped) {
    reject(@"E_AUDIO_INPUT_CAPTURE",
           [NSString stringWithUTF8String:stopError.c_str()], nil);
    return;
  }
  if (_hasListeners.load(std::memory_order_acquire))
    [self sendEventWithName:@"singzAudioInputState"
                       body:@{@"generation": ownershipGeneration,
                              @"state": @"stopped"}];
  resolve(nil);
}

@end
