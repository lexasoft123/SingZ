#import "NativePlaybackBridgeSupport.h"
#import "NativePlaybackAudioSession.h"
#import "NativePlaybackAuthorizedPath.h"
#import "NativePlaybackBridgeBoundary.h"
#import "NativePlaybackBridgeResult.h"
#import "NativePlaybackBridgeSchema.h"

#import <SingzDspRuntime/SingzDspRuntimeCapability.h>
#import <SingzPlaybackSession/native_playback_session.h>

#include <cstdint>
#include <cstdlib>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace {

struct PlaybackBridgeOwner {
  PlaybackBridgeOwner()
      : session(std::make_unique<singz::NativePlaybackSession>()),
        queue(
            dispatch_queue_create("com.lexasoft.singz.native-playback-control",
                                  DISPATCH_QUEUE_SERIAL)) {}

  std::unique_ptr<singz::NativePlaybackSession> session;
  dispatch_queue_t queue;
  std::atomic<uint64_t> latestClaimedGeneration{0};
  std::atomic<uint64_t> cancelledThrough{0};
  SingzPlaybackAudioSessionIntent preparedAudioSessionIntent;

  void noteCancellation(uint64_t generation) noexcept {
    uint64_t previous = cancelledThrough.load(std::memory_order_relaxed);
    while (previous < generation &&
           !cancelledThrough.compare_exchange_weak(
               previous, generation, std::memory_order_release,
               std::memory_order_relaxed)) {
    }
  }
};

PlaybackBridgeOwner &owner() {
  static auto *value = new PlaybackBridgeOwner();
  return *value;
}

singz::NativePlaybackCleanupResult
uncertainCleanup(uint64_t generation) noexcept {
  return {singz::NativePlaybackCleanupSafety::Uncertain,
          singz::NativePlaybackError::TeardownUncertain,
          generation,
          singz::NativePlaybackState::Quarantined,
          0,
          singz::AudioHostTerminalReason::ProviderFailure,
          true};
}

singz::NativePlaybackCleanupResult
failClaimedPrepare(void *context, uint64_t generation) noexcept {
  auto *session = static_cast<singz::NativePlaybackSession *>(context);
  if (session == nullptr)
    return uncertainCleanup(generation);
  singz::NativePlaybackCleanupResult cleanup = uncertainCleanup(generation);
  const auto failure = SingzPlaybackBridgeBoundary([&] {
    (void)session->failPrepareAdmission(
        generation, singz::NativePlaybackError::DecodeFailure);
    // Failed admission itself deliberately leaves an exact-generation
    // handshake. Complete the matching unload here; an outer bridge failure
    // is fallback-safe only after the session proves every global owner gone.
    cleanup = session->abortPrepareDelivery(generation);
  });
  return failure == SingzPlaybackBridgeBoundaryFailure::None
             ? cleanup
             : uncertainCleanup(generation);
}

singz::NativePlaybackCleanupResult
unloadMutatedPrepare(void *context, uint64_t generation) noexcept {
  auto *session = static_cast<singz::NativePlaybackSession *>(context);
  if (session == nullptr)
    return uncertainCleanup(generation);
  singz::NativePlaybackCleanupResult cleanup = uncertainCleanup(generation);
  const auto failure = SingzPlaybackBridgeBoundary(
      [&] { cleanup = session->abortPrepareDelivery(generation); });
  return failure == SingzPlaybackBridgeBoundaryFailure::None
             ? cleanup
             : uncertainCleanup(generation);
}

bool acknowledgeCommandDelivery(
    void *context, singz::NativePlaybackDeliveryToken token) noexcept {
  auto *session = static_cast<singz::NativePlaybackSession *>(context);
  if (session == nullptr)
    return false;
  bool acknowledged = false;
  const auto failure = SingzPlaybackBridgeBoundary(
      [&] { acknowledged = session->acknowledgeDelivery(token); });
  return failure == SingzPlaybackBridgeBoundaryFailure::None && acknowledged;
}

singz::NativePlaybackCleanupResult
abortCommandDelivery(void *context,
                     singz::NativePlaybackDeliveryToken token) noexcept {
  auto *session = static_cast<singz::NativePlaybackSession *>(context);
  if (session == nullptr)
    return uncertainCleanup(token.generation);
  singz::NativePlaybackCleanupResult cleanup =
      uncertainCleanup(token.generation);
  const auto failure = SingzPlaybackBridgeBoundary(
      [&] { cleanup = session->abortDelivery(token); });
  return failure == SingzPlaybackBridgeBoundaryFailure::None
             ? cleanup
             : uncertainCleanup(token.generation);
}

singz::NativePlaybackCleanupResult
abortGenerationDelivery(void *context, uint64_t generation) noexcept {
  return unloadMutatedPrepare(context, generation);
}

NSString *fromStd(const std::string &value) {
  return [NSString stringWithUTF8String:value.c_str()] ?: @"";
}

void rejectBoundaryFailure(RCTPromiseRejectBlock reject,
                           SingzPlaybackBridgeBoundaryFailure failure,
                           singz::NativePlaybackCleanupResult cleanup = {},
                           bool cleanupRequired = false) noexcept {
  if (cleanupRequired && !cleanup.globallyComplete()) {
    (void)SingzPlaybackBridgeBoundary(^{
      NSString *message = [NSString
          stringWithFormat:
              @"Native playback cleanup is uncertain (error=%s state=%u "
              @"retainedBytes=%llu terminal=%u processQuarantineReserved=%d "
              @"processQuarantinePoisoned=%d)",
              singz::nativePlaybackErrorName(cleanup.error),
              static_cast<unsigned int>(cleanup.state),
              static_cast<unsigned long long>(cleanup.retainedBytes),
              static_cast<unsigned int>(cleanup.terminalReason),
              cleanup.processQuarantineReserved,
              cleanup.processQuarantinePoisoned];
      NSError *detail = [NSError
          errorWithDomain:@"SingzNativePlayback"
                     code:static_cast<NSInteger>(cleanup.error)
                 userInfo:@{
                   @"generation" : @(cleanup.generation),
                   @"state" : @(static_cast<unsigned int>(cleanup.state)),
                   @"retainedBytes" : @(cleanup.retainedBytes),
                   @"terminalReason" :
                       @(static_cast<unsigned int>(cleanup.terminalReason)),
                   @"physicalOwnershipRetained" :
                       @(cleanup.physicalOwnershipRetained),
                   @"processQuarantineRetainedBytes" :
                       @(cleanup.processQuarantineRetainedBytes),
                   @"processQuarantineReserved" :
                       @(cleanup.processQuarantineReserved),
                   @"processQuarantinePoisoned" :
                       @(cleanup.processQuarantinePoisoned),
                   @"fallbackSafe" : @NO,
                 }];
      reject(@"E_NATIVE_PLAYBACK_TEARDOWN_UNCERTAIN", message, detail);
    });
    return;
  }
  if (failure == SingzPlaybackBridgeBoundaryFailure::None)
    return;
  NSString *code =
      failure == SingzPlaybackBridgeBoundaryFailure::ResourceExhausted
          ? @"E_NATIVE_PLAYBACK_RESOURCE_EXHAUSTED"
          : @"E_NATIVE_PLAYBACK_PROVIDER";
  NSString *message =
      failure == SingzPlaybackBridgeBoundaryFailure::ResourceExhausted
          ? @"Native playback could not allocate required resources"
          : @"Native playback failed at the platform bridge boundary";
  (void)SingzPlaybackBridgeBoundary(^{
    reject(code, message, nil);
  });
}

template <typename Callable>
void runBridgeBoundary(RCTPromiseRejectBlock reject,
                       Callable &&callable) noexcept {
  const SingzPlaybackBridgeBoundaryFailure failure =
      SingzPlaybackBridgeBoundary(std::forward<Callable>(callable));
  rejectBoundaryFailure(reject, failure);
}

NSString *playbackState(singz::NativePlaybackState state) {
  switch (state) {
  case singz::NativePlaybackState::Unloaded:
    return @"unloaded";
  case singz::NativePlaybackState::Preparing:
    return @"preparing";
  case singz::NativePlaybackState::Prepared:
    return @"prepared";
  case singz::NativePlaybackState::OutputOpen:
    return @"output-open";
  case singz::NativePlaybackState::Running:
    return @"running";
  case singz::NativePlaybackState::Stopped:
    return @"stopped";
  case singz::NativePlaybackState::Terminal:
    return @"terminal";
  case singz::NativePlaybackState::Quarantined:
    return @"quarantined";
  }
  return @"terminal";
}

NSString *hostState(singz::AudioHostState state) {
  switch (state) {
  case singz::AudioHostState::Closed:
    return @"closed";
  case singz::AudioHostState::Open:
    return @"open";
  case singz::AudioHostState::Running:
    return @"running";
  case singz::AudioHostState::Stopped:
    return @"stopped";
  case singz::AudioHostState::DeviceLost:
    return @"device-lost";
  case singz::AudioHostState::Error:
    return @"error";
  case singz::AudioHostState::Unsupported:
    return @"unsupported";
  }
  return @"error";
}

NSString *terminalReason(singz::AudioHostTerminalReason reason) {
  switch (reason) {
  case singz::AudioHostTerminalReason::None:
    return @"none";
  case singz::AudioHostTerminalReason::RouteChanged:
    return @"route-changed";
  case singz::AudioHostTerminalReason::Interrupted:
    return @"interrupted";
  case singz::AudioHostTerminalReason::MediaServicesLost:
    return @"media-services-lost";
  case singz::AudioHostTerminalReason::MediaServicesReset:
    return @"media-services-reset";
  case singz::AudioHostTerminalReason::DeviceLost:
    return @"device-lost";
  case singz::AudioHostTerminalReason::ProviderFailure:
    return @"provider-failure";
  }
  return @"provider-failure";
}

NSDictionary *resultDictionary(const singz::NativePlaybackResult &result) {
  return SingzNativePlaybackResultDictionary(result);
}

NSArray *outputInventory(const singz::AudioHostInventory &inventory) {
  NSMutableArray *outputs = [NSMutableArray array];
  for (const auto &device : inventory.devices) {
    if (device.outputChannels == 0)
      continue;
    NSMutableArray *labels = [NSMutableArray array];
    for (const std::string &label : device.outputChannelLabels)
      [labels addObject:fromStd(label)];
    [outputs addObject:@{
      @"uid" : fromStd(device.uid),
      @"label" : fromStd(device.label),
      @"default" : @(device.defaultOutput),
      @"channels" : @(device.outputChannels),
      @"channelLabels" : labels,
      @"sampleRate" : @(device.nominalSampleRate),
    }];
  }
  return outputs;
}

NSDictionary *statusDictionary(singz::NativePlaybackSession &session) {
  const singz::NativePlaybackStatus status = session.status();
  NSMutableArray *lanes = [NSMutableArray array];
  for (const auto &lane : status.lanes) {
    [lanes addObject:@{
      @"id" : fromStd(lane.id),
      @"cursorFrames" : @(lane.cursorFrames),
      @"totalFrames" : @(lane.totalFrames),
      @"gain" : @(lane.gain),
      @"muted" : @(lane.muted),
      @"solo" : @(lane.solo),
    }];
  }
  return @{
    @"generation" : @(status.generation),
    @"state" : playbackState(status.state),
    @"hostState" : hostState(status.host.state),
    @"terminalReason" : terminalReason(status.terminalReason),
    @"terminalOrdinal" : @(status.terminalOrdinal),
    @"sampleRate" : @(status.host.format.sampleRate),
    @"maximumFrames" : @(status.host.format.maximumFrames),
    @"nominalBufferFrames" : @(status.host.format.nominalBufferFrames),
    @"outputChannels" : @(status.host.format.outputChannels),
    @"renderedFrames" : @(status.renderedFrames),
    @"audibleFrames" : @(status.audibleFrames),
    @"retainedBytes" : @(status.retainedBytes),
    @"masterGain" : @(status.masterGain),
    @"xruns" : @(status.host.xruns),
    @"deadlineMisses" : @(status.host.deadlineMisses),
    @"discontinuities" : @(status.host.discontinuities),
    @"renderFailures" : @(status.host.renderFailures),
    @"adapterRenderFailures" : @(status.adapterRenderFailures),
    @"terminalRenderFailures" : @(status.terminalRenderFailures),
    @"parameterOverflows" : @(status.parameterOverflows),
    @"nonFiniteSamples" : @(status.nonFiniteSamples),
    @"rejectedBlocks" : @(status.rejectedBlocks),
    @"latency" : @{
      @"outputDeviceFrames" : @(status.host.latency.outputDeviceFrames),
      @"bufferFrames" : @(status.host.latency.bufferFrames),
      @"externalRouteFrames" : @(status.host.latency.externalRouteFrames),
    },
    @"lanes" : lanes,
    @"message" : fromStd(status.error),
  };
}

} // namespace

void SingzNativePlaybackStatus(RCTPromiseResolveBlock resolve,
                               RCTPromiseRejectBlock reject) {
  runBridgeBoundary(reject, [&] {
    PlaybackBridgeOwner &bridge = owner();
    // A dispatch block nested inside this temporary C++ lambda must capture
    // real local block values. Reaching through the lambda's `[&]` closure
    // leaves a pointer to its dead stack object once this function returns.
    RCTPromiseResolveBlock asyncResolve = [resolve copy];
    RCTPromiseRejectBlock asyncReject = [reject copy];
    dispatch_async(bridge.queue, ^{
      runBridgeBoundary(asyncReject, [&] {
        const SingzDspRuntimeLinkStatus *link = SingzDspRuntimeGetLinkStatus();
        const bool available = link != nullptr && link->interfaceVersion == 1 &&
                               link->buildId != nullptr;
        asyncResolve(@{
          @"available" : @(available),
          @"buildId" : available ? [NSString stringWithUTF8String:link->buildId]
                                 : @"",
          @"graph" : @(available && (link->capabilityFlags &
                                     SingzDspRuntimeCapabilityGraph) != 0),
          @"audioHostAdapter" :
              @(available && (link->capabilityFlags &
                              SingzDspRuntimeCapabilityAudioHostAdapter) != 0),
          @"playbackSession" :
              @(available && (link->capabilityFlags &
                              SingzDspRuntimeCapabilityPlaybackCallback) != 0),
          @"playbackCleanupProof" :
              @(available &&
                (link->capabilityFlags &
                 SingzDspRuntimeCapabilityPlaybackCleanupProof) != 0),
          @"playbackHandoffLease" :
              @(available &&
                (link->capabilityFlags &
                 SingzDspRuntimeCapabilityPlaybackHandoffLease) != 0),
          @"playbackBuild" : [NSString
              stringWithUTF8String:singz::nativePlaybackSessionCapabilityTag()],
          @"ownership" : @"coordinated",
          @"activation" : @"experimental-b2",
          @"outputs" : outputInventory(bridge.session->enumerate()),
          @"session" : statusDictionary(*bridge.session),
        });
      });
    });
  });
}

void SingzNativePlaybackPrepare(NSNumber *generationValue,
                                NSDictionary *request,
                                RCTPromiseResolveBlock resolve,
                                RCTPromiseRejectBlock reject) {
  SingzPlaybackPrepareOwnershipGuard admissionGuard;
  std::shared_ptr<SingzPlaybackPrepareOwnershipGuard> asyncGuard;
  const SingzPlaybackBridgeBoundaryFailure failure =
      SingzPlaybackBridgeBoundary([&] {
        uint64_t generation = 0;
        SingzParsedPlaybackPrepare parsed;
        NSString *parseError = nil;
        if (!SingzParsePlaybackGeneration(generationValue, &generation) ||
            !SingzParsePlaybackPrepare(request, &parsed, &parseError)) {
          reject(@"E_NATIVE_PLAYBACK",
                 parseError
                     ?: @"The native playback prepare request is invalid",
                 nil);
          return;
        }
        PlaybackBridgeOwner &bridge = owner();
        const singz::NativePlaybackResult claim =
            bridge.session->claimGeneration(generation,
                                            parsed.config.handoffLease);
        if (!claim.ok) {
          resolve(resultDictionary(claim));
          return;
        }
        bridge.latestClaimedGeneration.store(generation,
                                             std::memory_order_release);
        const SingzPlaybackPrepareCleanup cleanup{
            bridge.session.get(), &failClaimedPrepare, &unloadMutatedPrepare};
        admissionGuard.activate(cleanup, generation);
        SingzPlaybackInjectPrepareFault(
            SingzPlaybackPrepareFaultPoint::AfterGenerationClaim);
        SingzPlaybackInjectPrepareFault(
            SingzPlaybackPrepareFaultPoint::PrepareGuardAllocation);
        asyncGuard = std::make_shared<SingzPlaybackPrepareOwnershipGuard>();
        asyncGuard->activate(cleanup, generation);
        // From this point the shared guard survives until either dispatch block
        // delivery or the contained outer-boundary cleanup below.
        admissionGuard.dismiss();
        SingzPlaybackInjectPrepareFault(
            SingzPlaybackPrepareFaultPoint::PrepareBlockCaptureConstruction);
        SingzPlaybackPrepareBlockCopySentinel blockCopySentinel;
        SingzPlaybackInjectPrepareFault(
            SingzPlaybackPrepareFaultPoint::PrepareDispatch);
        const auto dispatchedGuard = asyncGuard;
        RCTPromiseResolveBlock asyncResolve = [resolve copy];
        RCTPromiseRejectBlock asyncReject = [reject copy];
        dispatch_async(bridge.queue, ^{
          blockCopySentinel.touch();
          const SingzPlaybackBridgeBoundaryFailure failure =
              SingzPlaybackBridgeBoundary([&] {
                SingzPlaybackInjectPrepareFault(
                    SingzPlaybackPrepareFaultPoint::LaneVectorConstruction);
                SingzPlaybackAudioSessionIntent audioSessionIntent{
                    generation, parsed.config.outputDeviceUid,
                    parsed.config.outputChannels,
                    parsed.config.requestedSampleRate,
                    parsed.config.maximumFrames};
                std::vector<singz::NativePlaybackLaneSource> lanes;
                lanes.reserve(parsed.lanes.size());
                for (const SingzParsedPlaybackLane &lane : parsed.lanes) {
                  SingzPlaybackInjectPrepareFault(
                      SingzPlaybackPrepareFaultPoint::PathConstruction);
                  NSString *path =
                      [NSString stringWithUTF8String:lane.path.c_str()];
                  std::string pathError;
                  SingzPlaybackInjectPrepareFault(
                      SingzPlaybackPrepareFaultPoint::DescriptorConstruction);
                  singz::OwnedFileDescriptor descriptor =
                      SingzOpenAuthorizedPlaybackPath(path, &pathError);
                  if (!descriptor.valid()) {
                    dispatchedGuard->markSessionMutation();
                    const singz::NativePlaybackResult result =
                        bridge.session->failPrepareAdmission(
                            generation,
                            singz::NativePlaybackError::DecodeFailure);
                    SingzPlaybackInjectPrepareFault(
                        SingzPlaybackPrepareFaultPoint::
                            ResultDictionaryConversion);
                    NSDictionary *dictionary = resultDictionary(result);
                    SingzPlaybackInjectPrepareFault(
                        SingzPlaybackPrepareFaultPoint::PrePromiseResolve);
                    asyncResolve(dictionary);
                    dispatchedGuard->markDelivered();
                    return;
                  }
                  lanes.push_back({lane.id, std::move(descriptor), lane.gain,
                                   lane.muted, lane.solo});
                }
                dispatchedGuard->markSessionMutation();
                const singz::NativePlaybackResult result =
                    bridge.session->prepare(std::move(parsed.config),
                                            std::move(lanes), generation);
                if (result.ok &&
                    result.state == singz::NativePlaybackState::Prepared) {
                  bridge.preparedAudioSessionIntent =
                      std::move(audioSessionIntent);
                }
                SingzPlaybackInjectPrepareFault(
                    SingzPlaybackPrepareFaultPoint::PostPreparePreResult);
                SingzPlaybackInjectPrepareFault(
                    SingzPlaybackPrepareFaultPoint::ResultDictionaryConversion);
                NSDictionary *dictionary = resultDictionary(result);
                SingzPlaybackInjectPrepareFault(
                    SingzPlaybackPrepareFaultPoint::PrePromiseResolve);
                asyncResolve(dictionary);
                dispatchedGuard->markDelivered();
              });
          if (failure != SingzPlaybackBridgeBoundaryFailure::None) {
            // Cleanup precedes rejection, so a B2 fallback cannot race decoded
            // owners left behind by an exceptional result/delivery conversion.
            const auto cleanupResult = dispatchedGuard->cleanupNow();
            rejectBoundaryFailure(asyncReject, failure, cleanupResult, true);
          }
        });
      });
  const auto outer = SingzPlaybackFinishPrepareOuterBoundary(
      failure, admissionGuard, asyncGuard.get());
  if (failure != SingzPlaybackBridgeBoundaryFailure::None) {
    rejectBoundaryFailure(reject, failure, outer.cleanup,
                          outer.cleanupRequired);
  }
}

void SingzNativePlaybackConfigureOutputSession(NSNumber *generationValue,
                                               RCTPromiseResolveBlock resolve,
                                               RCTPromiseRejectBlock reject) {
  runBridgeBoundary(reject, [&] {
    uint64_t generation = 0;
    if (!SingzParsePlaybackGeneration(generationValue, &generation)) {
      reject(@"E_NATIVE_PLAYBACK",
             @"The native playback generation is invalid", nil);
      return;
    }
    PlaybackBridgeOwner &bridge = owner();
    RCTPromiseResolveBlock asyncResolve = [resolve copy];
    RCTPromiseRejectBlock asyncReject = [reject copy];
    dispatch_async(bridge.queue, ^{
      runBridgeBoundary(asyncReject, [&] {
        const singz::NativePlaybackStatus before = bridge.session->status();
        const uint64_t latest = bridge.latestClaimedGeneration.load(
            std::memory_order_acquire);
        const uint64_t current =
            before.generation == latest ? latest : uint64_t{0};
        const uint64_t cancelled =
            bridge.cancelledThrough.load(std::memory_order_acquire);
        SingzPlaybackAudioSessionResult result =
            SingzConfigurePlaybackAudioSession(
                generation, current, cancelled, before.state,
                bridge.preparedAudioSessionIntent);

        // A synchronous newer claim or cancellation can race this queued
        // platform call. Recheck at the command's publication boundary so a
        // stale generation never receives a successful activation receipt.
        if (result.ok) {
          SingzPlaybackAudioSessionSnapshot configuredSession =
              std::move(result.session);
          const singz::NativePlaybackStatus after = bridge.session->status();
          const uint64_t latestAfter = bridge.latestClaimedGeneration.load(
              std::memory_order_acquire);
          result = SingzPlaybackAudioSessionPreflight(
              generation,
              after.generation == latestAfter ? latestAfter : uint64_t{0},
              bridge.cancelledThrough.load(std::memory_order_acquire),
              after.state, bridge.preparedAudioSessionIntent);
          if (result.ok) {
            result = SingzVerifyPlaybackAudioSession(
                generation, after.state, bridge.preparedAudioSessionIntent,
                std::move(configuredSession));
          }
        }
        asyncResolve(SingzPlaybackAudioSessionResultDictionary(result));
      });
    });
  });
}

void SingzNativePlaybackOpenOutput(NSNumber *generationValue,
                                   RCTPromiseResolveBlock resolve,
                                   RCTPromiseRejectBlock reject) {
  runBridgeBoundary(reject, [&] {
    uint64_t generation = 0;
    if (!SingzParsePlaybackGeneration(generationValue, &generation)) {
      reject(@"E_NATIVE_PLAYBACK", @"The native playback generation is invalid",
             nil);
      return;
    }
    PlaybackBridgeOwner &bridge = owner();
    const SingzPlaybackCommandDeliveryCleanup cleanup{
        bridge.session.get(), &acknowledgeCommandDelivery,
        &abortCommandDelivery};
    auto asyncGuard =
        std::make_shared<SingzPlaybackCommandDeliveryGuard>(cleanup);
    RCTPromiseResolveBlock asyncResolve = [resolve copy];
    RCTPromiseRejectBlock asyncReject = [reject copy];
    dispatch_async(bridge.queue, ^{
      const SingzPlaybackBridgeBoundaryFailure failure =
          SingzPlaybackBridgeBoundary([&] {
            const singz::NativePlaybackResult result =
                bridge.session->openOutput(generation,
                                           asyncGuard->tokenOutput());
            SingzPlaybackInjectPrepareFault(
                SingzPlaybackPrepareFaultPoint::OpenResultDictionaryConversion);
            NSDictionary *dictionary = resultDictionary(result);
            SingzPlaybackInjectPrepareFault(
                SingzPlaybackPrepareFaultPoint::OpenPromiseDelivery);
            asyncResolve(dictionary);
            if (asyncGuard->token().valid()) {
              if (!asyncGuard->acknowledge())
                throw 1;
            } else {
              asyncGuard->dismissUnmutated();
            }
          });
      if (failure != SingzPlaybackBridgeBoundaryFailure::None) {
        const auto cleanupResult = asyncGuard->cleanupNow();
        rejectBoundaryFailure(asyncReject, failure, cleanupResult, true);
      }
    });
  });
}

void SingzNativePlaybackStart(NSNumber *generationValue,
                              RCTPromiseResolveBlock resolve,
                              RCTPromiseRejectBlock reject) {
  runBridgeBoundary(reject, [&] {
    uint64_t generation = 0;
    if (!SingzParsePlaybackGeneration(generationValue, &generation)) {
      reject(@"E_NATIVE_PLAYBACK", @"The native playback generation is invalid",
             nil);
      return;
    }
    PlaybackBridgeOwner &bridge = owner();
    const SingzPlaybackCommandDeliveryCleanup cleanup{
        bridge.session.get(), &acknowledgeCommandDelivery,
        &abortCommandDelivery};
    auto asyncGuard =
        std::make_shared<SingzPlaybackCommandDeliveryGuard>(cleanup);
    RCTPromiseResolveBlock asyncResolve = [resolve copy];
    RCTPromiseRejectBlock asyncReject = [reject copy];
    dispatch_async(bridge.queue, ^{
      const SingzPlaybackBridgeBoundaryFailure failure =
          SingzPlaybackBridgeBoundary([&] {
            const singz::NativePlaybackResult result =
                bridge.session->start(generation, asyncGuard->tokenOutput());
            SingzPlaybackInjectPrepareFault(
                SingzPlaybackPrepareFaultPoint::
                    StartResultDictionaryConversion);
            NSDictionary *dictionary = resultDictionary(result);
            SingzPlaybackInjectPrepareFault(
                SingzPlaybackPrepareFaultPoint::StartPromiseDelivery);
            asyncResolve(dictionary);
            if (asyncGuard->token().valid()) {
              if (!asyncGuard->acknowledge())
                throw 1;
            } else {
              asyncGuard->dismissUnmutated();
            }
          });
      if (failure != SingzPlaybackBridgeBoundaryFailure::None) {
        const auto cleanupResult = asyncGuard->cleanupNow();
        rejectBoundaryFailure(asyncReject, failure, cleanupResult, true);
      }
    });
  });
}

void SingzNativePlaybackStop(NSNumber *generationValue,
                             RCTPromiseResolveBlock resolve,
                             RCTPromiseRejectBlock reject) {
  uint64_t generation = 0;
  PlaybackBridgeOwner *bridge = nullptr;
  bool cleanupClaimed = false;
  std::shared_ptr<SingzPlaybackGenerationDeliveryGuard> asyncGuard;
  const SingzPlaybackBridgeBoundaryFailure outerFailure =
      SingzPlaybackBridgeBoundary([&] {
        if (!SingzParsePlaybackGeneration(generationValue, &generation)) {
          reject(@"E_NATIVE_PLAYBACK",
                 @"The native playback generation is invalid", nil);
          return;
        }
        bridge = &owner();
        // Cancellation is deliberately synchronous and precedes serialization
        // so a queued stop interrupts an in-flight decode immediately.
        if (bridge->session->requestCancellation(generation))
          bridge->noteCancellation(generation);
        cleanupClaimed = true;
        asyncGuard = std::make_shared<SingzPlaybackGenerationDeliveryGuard>();
        asyncGuard->activate({bridge->session.get(), &abortGenerationDelivery},
                             generation);
        SingzPlaybackPrepareBlockCopySentinel blockCopySentinel(
            SingzPlaybackPrepareFaultPoint::StopBlockCaptureCopy);
        PlaybackBridgeOwner *dispatchedBridge = bridge;
        const uint64_t dispatchedGeneration = generation;
        const auto dispatchedGuard = asyncGuard;
        RCTPromiseResolveBlock asyncResolve = [resolve copy];
        RCTPromiseRejectBlock asyncReject = [reject copy];
        dispatch_async(dispatchedBridge->queue, ^{
          blockCopySentinel.touch();
          const SingzPlaybackBridgeBoundaryFailure failure =
              SingzPlaybackBridgeBoundary([&] {
                const singz::NativePlaybackResult result =
                    dispatchedBridge->session->stop(dispatchedGeneration);
                SingzPlaybackInjectPrepareFault(
                    SingzPlaybackPrepareFaultPoint::
                        StopResultDictionaryConversion);
                NSDictionary *dictionary = resultDictionary(result);
                SingzPlaybackInjectPrepareFault(
                    SingzPlaybackPrepareFaultPoint::StopPrePromiseResolve);
                SingzPlaybackInjectPrepareFault(
                    SingzPlaybackPrepareFaultPoint::StopPromiseDelivery);
                asyncResolve(dictionary);
                dispatchedGuard->markDelivered();
              });
          if (failure != SingzPlaybackBridgeBoundaryFailure::None) {
            const auto cleanupResult = dispatchedGuard->cleanupNow();
            rejectBoundaryFailure(asyncReject, failure, cleanupResult, true);
          }
        });
      });
  if (outerFailure != SingzPlaybackBridgeBoundaryFailure::None) {
    singz::NativePlaybackCleanupResult cleanupResult =
        SingzPlaybackNoCleanup(generation);
    if (cleanupClaimed) {
      cleanupResult = asyncGuard != nullptr
                          ? asyncGuard->cleanupNow()
                          : abortGenerationDelivery(bridge == nullptr
                                                        ? nullptr
                                                        : bridge->session.get(),
                                                    generation);
    }
    rejectBoundaryFailure(reject, outerFailure, cleanupResult, cleanupClaimed);
  }
}

void SingzNativePlaybackUnload(NSNumber *generationValue,
                               RCTPromiseResolveBlock resolve,
                               RCTPromiseRejectBlock reject) {
  uint64_t generation = 0;
  PlaybackBridgeOwner *bridge = nullptr;
  bool cleanupClaimed = false;
  std::shared_ptr<SingzPlaybackGenerationDeliveryGuard> asyncGuard;
  const SingzPlaybackBridgeBoundaryFailure outerFailure =
      SingzPlaybackBridgeBoundary([&] {
        if (!SingzParsePlaybackGeneration(generationValue, &generation)) {
          reject(@"E_NATIVE_PLAYBACK",
                 @"The native playback generation is invalid", nil);
          return;
        }
        bridge = &owner();
        // See stop: unload must advance the cancellation epoch before enqueue.
        if (bridge->session->requestCancellation(generation))
          bridge->noteCancellation(generation);
        cleanupClaimed = true;
        asyncGuard = std::make_shared<SingzPlaybackGenerationDeliveryGuard>();
        asyncGuard->activate({bridge->session.get(), &abortGenerationDelivery},
                             generation);
        SingzPlaybackPrepareBlockCopySentinel blockCopySentinel(
            SingzPlaybackPrepareFaultPoint::UnloadBlockCaptureCopy);
        PlaybackBridgeOwner *dispatchedBridge = bridge;
        const uint64_t dispatchedGeneration = generation;
        const auto dispatchedGuard = asyncGuard;
        RCTPromiseResolveBlock asyncResolve = [resolve copy];
        RCTPromiseRejectBlock asyncReject = [reject copy];
        dispatch_async(dispatchedBridge->queue, ^{
          blockCopySentinel.touch();
          const SingzPlaybackBridgeBoundaryFailure failure =
              SingzPlaybackBridgeBoundary([&] {
                const singz::NativePlaybackUnloadReceipt receipt =
                    dispatchedBridge->session->unloadWithCleanup(
                        dispatchedGeneration);
                SingzPlaybackInjectPrepareFault(
                    SingzPlaybackPrepareFaultPoint::
                        UnloadResultDictionaryConversion);
                NSDictionary *dictionary =
                    SingzNativePlaybackUnloadResultDictionary(receipt.playback,
                                                              receipt.cleanup);
                SingzPlaybackInjectPrepareFault(
                    SingzPlaybackPrepareFaultPoint::UnloadPrePromiseResolve);
                SingzPlaybackInjectPrepareFault(
                    SingzPlaybackPrepareFaultPoint::UnloadPromiseDelivery);
                asyncResolve(dictionary);
                dispatchedGuard->markDelivered();
              });
          if (failure != SingzPlaybackBridgeBoundaryFailure::None) {
            const auto cleanupResult = dispatchedGuard->cleanupNow();
            rejectBoundaryFailure(asyncReject, failure, cleanupResult, true);
          }
        });
      });
  if (outerFailure != SingzPlaybackBridgeBoundaryFailure::None) {
    singz::NativePlaybackCleanupResult cleanupResult =
        SingzPlaybackNoCleanup(generation);
    if (cleanupClaimed) {
      cleanupResult = asyncGuard != nullptr
                          ? asyncGuard->cleanupNow()
                          : abortGenerationDelivery(bridge == nullptr
                                                        ? nullptr
                                                        : bridge->session.get(),
                                                    generation);
    }
    rejectBoundaryFailure(reject, outerFailure, cleanupResult, cleanupClaimed);
  }
}

void SingzNativePlaybackSetControl(NSNumber *generationValue,
                                   NSDictionary *control,
                                   RCTPromiseResolveBlock resolve,
                                   RCTPromiseRejectBlock reject) {
  runBridgeBoundary(reject, [&] {
    uint64_t generation = 0;
    SingzParsedPlaybackControl parsed;
    if (!SingzParsePlaybackGeneration(generationValue, &generation) ||
        !SingzParsePlaybackControl(control, &parsed)) {
      reject(@"E_NATIVE_PLAYBACK", @"The native playback control is invalid",
             nil);
      return;
    }
    PlaybackBridgeOwner &bridge = owner();
    RCTPromiseResolveBlock asyncResolve = [resolve copy];
    RCTPromiseRejectBlock asyncReject = [reject copy];
    dispatch_async(bridge.queue, ^{
      runBridgeBoundary(asyncReject, [&] {
        if (parsed.lane) {
          asyncResolve(resultDictionary(bridge.session->setLaneControl(
              generation, parsed.laneId, parsed.gain, parsed.muted,
              parsed.solo)));
          return;
        }
        asyncResolve(resultDictionary(
            bridge.session->setMasterGain(generation, parsed.gain)));
      });
    });
  });
}
