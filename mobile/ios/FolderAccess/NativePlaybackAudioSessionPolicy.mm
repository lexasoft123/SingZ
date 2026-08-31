#import "NativePlaybackAudioSession.h"

#include <algorithm>
#include <cmath>
#include <utility>

namespace {

constexpr const char* kPlaybackCategory = "AVAudioSessionCategoryPlayback";
constexpr const char* kDefaultMode = "AVAudioSessionModeDefault";

SingzPlaybackAudioSessionResult failure(
    SingzPlaybackAudioSessionError error, uint64_t generation,
    singz::NativePlaybackState state, std::string message,
    SingzPlaybackAudioSessionSnapshot snapshot = {}, double sampleRate = 0.0,
    uint32_t maximumFrames = 0, uint32_t nominalBufferFrames = 0,
    uint32_t outputChannels = 0) {
  return {false,
          error,
          generation,
          state,
          sampleRate,
          maximumFrames,
          nominalBufferFrames,
          outputChannels,
          std::move(snapshot),
          std::move(message)};
}

NSString* errorName(SingzPlaybackAudioSessionError error) {
  switch (error) {
    case SingzPlaybackAudioSessionError::None:
      return @"none";
    case SingzPlaybackAudioSessionError::InvalidGeneration:
      return @"invalid-generation";
    case SingzPlaybackAudioSessionError::InvalidState:
      return @"invalid-state";
    case SingzPlaybackAudioSessionError::ConfigurationFailed:
      return @"configuration-failed";
    case SingzPlaybackAudioSessionError::VerificationFailed:
      return @"verification-failed";
  }
  return @"verification-failed";
}

NSString* playbackState(singz::NativePlaybackState state) {
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

NSString* fromStd(const std::string& value) {
  return [NSString stringWithUTF8String:value.c_str()] ?: @"";
}

}  // namespace

SingzPlaybackAudioSessionResult SingzPlaybackAudioSessionPreflight(
    uint64_t requestedGeneration, uint64_t currentGeneration,
    uint64_t cancelledThrough, singz::NativePlaybackState state,
    const SingzPlaybackAudioSessionIntent& intent) {
  if (requestedGeneration == 0 || requestedGeneration != currentGeneration ||
      requestedGeneration != intent.generation) {
    return failure(SingzPlaybackAudioSessionError::InvalidGeneration,
                   requestedGeneration, state,
                   "The native playback generation is stale");
  }
  if (cancelledThrough >= requestedGeneration ||
      state != singz::NativePlaybackState::Prepared) {
    return failure(SingzPlaybackAudioSessionError::InvalidState,
                   requestedGeneration, state,
                   "Only the exact prepared playback session may configure "
                   "AVAudioSession");
  }
  if (intent.outputDeviceUid.empty() || intent.outputChannels.empty() ||
      !std::isfinite(intent.sampleRate) || intent.sampleRate <= 0.0) {
    return failure(SingzPlaybackAudioSessionError::InvalidState,
                   requestedGeneration, state,
                   "The prepared playback output intent is unavailable");
  }
  return {true,
          SingzPlaybackAudioSessionError::None,
          requestedGeneration,
          state,
          intent.sampleRate,
          intent.maximumFrames,
          0,
          static_cast<uint32_t>(intent.outputChannels.size()),
          {},
          {}};
}

SingzPlaybackAudioSessionResult SingzVerifyPlaybackAudioSession(
    uint64_t generation, singz::NativePlaybackState state,
    const SingzPlaybackAudioSessionIntent& intent,
    SingzPlaybackAudioSessionSnapshot snapshot) {
  const auto reject = [&](const char* message) {
    const double sampleRate = snapshot.sampleRate;
    const uint32_t nominalBufferFrames = snapshot.nominalBufferFrames;
    return failure(
        SingzPlaybackAudioSessionError::VerificationFailed, generation, state,
        message, std::move(snapshot), sampleRate, intent.maximumFrames,
        nominalBufferFrames,
        static_cast<uint32_t>(intent.outputChannels.size()));
  };
  if (!snapshot.active)
    return reject("The iOS playback session is not active");
  if (snapshot.category != kPlaybackCategory ||
      snapshot.mode != kDefaultMode || snapshot.categoryOptions != 0) {
    return reject(
        "The iOS playback category, mode or options were not applied exactly");
  }
  if (snapshot.outputRouteCount != 1 ||
      snapshot.outputDeviceUid != intent.outputDeviceUid) {
    return reject(
        "The active iOS output route does not match the prepared device");
  }
  if (snapshot.outputChannelCount == 0 ||
      !std::all_of(intent.outputChannels.begin(), intent.outputChannels.end(),
                   [&](uint32_t channel) {
                     return channel < snapshot.outputChannelCount;
                   })) {
    return reject(
        "The active iOS output route does not provide the prepared channels");
  }
  if (!std::isfinite(snapshot.sampleRate) ||
      snapshot.sampleRate != intent.sampleRate) {
    return reject(
        "The active iOS output route does not match the prepared sample rate");
  }
  return {true,
          SingzPlaybackAudioSessionError::None,
          generation,
          state,
          snapshot.sampleRate,
          intent.maximumFrames,
          snapshot.nominalBufferFrames,
          static_cast<uint32_t>(intent.outputChannels.size()),
          std::move(snapshot),
          {}};
}

NSDictionary* SingzPlaybackAudioSessionResultDictionary(
    const SingzPlaybackAudioSessionResult& result) {
  return @{
    @"ok" : @(result.ok),
    @"error" : errorName(result.error),
    @"generation" : @(result.generation),
    @"state" : playbackState(result.state),
    @"sampleRate" : @(result.sampleRate),
    @"maximumFrames" : @(result.maximumFrames),
    @"nominalBufferFrames" : @(result.nominalBufferFrames),
    @"outputChannels" : @(result.outputChannels),
    @"message" : fromStd(result.message),
  };
}
