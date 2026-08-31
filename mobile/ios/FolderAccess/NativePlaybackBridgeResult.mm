#import "NativePlaybackBridgeResult.h"

namespace {

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

NSString *cleanupSafety(singz::NativePlaybackCleanupSafety safety) {
  switch (safety) {
  case singz::NativePlaybackCleanupSafety::NotOwned:
    return @"not-owned";
  case singz::NativePlaybackCleanupSafety::Complete:
    return @"complete";
  case singz::NativePlaybackCleanupSafety::Uncertain:
    return @"uncertain";
  }
  return @"uncertain";
}

NSString *coordinatorState(singz::NativePlaybackCoordinatorState state) {
  switch (state) {
  case singz::NativePlaybackCoordinatorState::Available:
    return @"available";
  case singz::NativePlaybackCoordinatorState::NativeOwned:
    return @"native-owned";
  case singz::NativePlaybackCoordinatorState::FallbackLeased:
    return @"fallback-leased";
  case singz::NativePlaybackCoordinatorState::Poisoned:
    return @"poisoned";
  }
  return @"poisoned";
}

NSString *playbackError(singz::NativePlaybackError error) {
  switch (error) {
  case singz::NativePlaybackError::None:
    return @"none";
  case singz::NativePlaybackError::InvalidGeneration:
    return @"invalid-generation";
  case singz::NativePlaybackError::InvalidState:
    return @"invalid-state";
  case singz::NativePlaybackError::InvalidConfiguration:
    return @"invalid-configuration";
  case singz::NativePlaybackError::Cancelled:
    return @"cancelled";
  case singz::NativePlaybackError::DecodeFailure:
    return @"decode-failure";
  case singz::NativePlaybackError::LimitExceeded:
    return @"limit-exceeded";
  case singz::NativePlaybackError::ResourceExhausted:
    return @"resource-exhausted";
  case singz::NativePlaybackError::GraphFailure:
    return @"graph-failure";
  case singz::NativePlaybackError::HostFailure:
    return @"host-failure";
  case singz::NativePlaybackError::ProviderFailure:
    return @"provider-failure";
  case singz::NativePlaybackError::QueueFull:
    return @"queue-full";
  case singz::NativePlaybackError::TeardownUncertain:
    return @"teardown-uncertain";
  }
  return @"provider-failure";
}

NSString *fromStd(const std::string &value) {
  return [NSString stringWithUTF8String:value.c_str()] ?: @"";
}

} // namespace

NSDictionary *
SingzNativePlaybackResultDictionary(const singz::NativePlaybackResult &result) {
  return @{
    @"ok" : @(result.ok),
    @"error" : playbackError(result.error),
    @"generation" : @(result.generation),
    @"state" : playbackState(result.state),
    @"sampleRate" : @(result.format.sampleRate),
    @"maximumFrames" : @(result.format.maximumFrames),
    @"nominalBufferFrames" : @(result.format.nominalBufferFrames),
    @"outputChannels" : @(result.format.outputChannels),
    @"message" : fromStd(result.message),
  };
}

NSDictionary *SingzNativePlaybackCleanupDictionary(
    const singz::NativePlaybackCleanupResult &cleanup) {
  const bool complete = cleanup.globallyComplete();
  return @{
    @"safety" : cleanupSafety(cleanup.safety),
    @"error" : playbackError(cleanup.error),
    @"generation" : @(cleanup.generation),
    @"state" : playbackState(cleanup.state),
    @"retainedBytes" : @(cleanup.retainedBytes),
    @"physicalOwnershipRetained" : @(cleanup.physicalOwnershipRetained),
    @"processQuarantineRetainedBytes" :
        @(cleanup.processQuarantineRetainedBytes),
    @"processQuarantineReserved" : @(cleanup.processQuarantineReserved),
    @"processQuarantinePoisoned" : @(cleanup.processQuarantinePoisoned),
    @"terminalReason" : terminalReason(cleanup.terminalReason),
    @"coordinatorState" : coordinatorState(cleanup.coordinatorState),
    @"coordinatorEpoch" : @(cleanup.coordinatorEpoch),
    @"coordinatorOwnerSession" : @(cleanup.coordinatorOwnerSession),
    @"coordinatorOwnerGeneration" : @(cleanup.coordinatorOwnerGeneration),
    @"handoffLease" : @(cleanup.handoffLease),
    @"globallyComplete" : @(complete),
    @"fallbackSafe" : @(complete),
  };
}

NSDictionary *SingzNativePlaybackUnloadResultDictionary(
    const singz::NativePlaybackResult &result,
    const singz::NativePlaybackCleanupResult &cleanup) {
  NSMutableDictionary *dictionary =
      [SingzNativePlaybackResultDictionary(result) mutableCopy];
  dictionary[@"cleanup"] = SingzNativePlaybackCleanupDictionary(cleanup);
  return [dictionary copy];
}
