#import "NativePlaybackAudioSession.h"

#import <AVFAudio/AVFAudio.h>

#include <cmath>
#include <string>
#include <utility>

namespace {

constexpr const char* kOutputUidPrefix = "ios-output:";

std::string fromNSString(NSString* value) {
  if (value == nil)
    return {};
  const char* utf8 = value.UTF8String;
  return utf8 == nullptr ? std::string() : std::string(utf8);
}

std::string outputUid(AVAudioSessionPortDescription* port) {
  const std::string uid = port == nil ? std::string() : fromNSString(port.UID);
  return uid.empty() ? std::string() : std::string(kOutputUidPrefix) + uid;
}

SingzPlaybackAudioSessionSnapshot snapshot(AVAudioSession* session,
                                           bool active) {
  SingzPlaybackAudioSessionSnapshot result;
  result.category = fromNSString(session.category);
  result.mode = fromNSString(session.mode);
  result.categoryOptions = static_cast<uint64_t>(session.categoryOptions);
  result.active = active;
  NSArray<AVAudioSessionPortDescription*>* outputs =
      session.currentRoute.outputs;
  result.outputRouteCount = static_cast<uint32_t>(outputs.count);
  result.outputDeviceUid =
      outputs.count == 1 ? outputUid(outputs.firstObject) : std::string();
  const NSInteger channels = session.outputNumberOfChannels;
  result.outputChannelCount =
      channels > 0 && static_cast<uint64_t>(channels) <= UINT32_MAX
          ? static_cast<uint32_t>(channels)
          : 0;
  result.sampleRate = session.sampleRate;
  const double nominalFrames = session.IOBufferDuration * result.sampleRate;
  result.nominalBufferFrames =
      std::isfinite(nominalFrames) && nominalFrames >= 1.0 &&
              nominalFrames <= UINT32_MAX
          ? static_cast<uint32_t>(std::llround(nominalFrames))
          : 0;
  return result;
}

SingzPlaybackAudioSessionResult configurationFailure(
    uint64_t generation, singz::NativePlaybackState state,
    const SingzPlaybackAudioSessionIntent& intent, AVAudioSession* session,
    bool active, NSString* operation,
    NSError* error) {
  NSString* detail = error.localizedDescription ?: @"unknown provider error";
  NSString* message =
      [NSString stringWithFormat:@"Could not %@ the iOS playback session: %@",
                                 operation, detail];
  SingzPlaybackAudioSessionSnapshot current = snapshot(session, active);
  return {false,
          SingzPlaybackAudioSessionError::ConfigurationFailed,
          generation,
          state,
          intent.sampleRate,
          intent.maximumFrames,
          current.nominalBufferFrames,
          static_cast<uint32_t>(intent.outputChannels.size()),
          std::move(current),
          fromNSString(message)};
}

}  // namespace

SingzPlaybackAudioSessionResult SingzConfigurePlaybackAudioSession(
    uint64_t requestedGeneration, uint64_t currentGeneration,
    uint64_t cancelledThrough, singz::NativePlaybackState state,
    const SingzPlaybackAudioSessionIntent& intent) {
  SingzPlaybackAudioSessionResult result = SingzPlaybackAudioSessionPreflight(
      requestedGeneration, currentGeneration, cancelledThrough, state, intent);
  if (!result.ok)
    return result;

  AVAudioSession* session = AVAudioSession.sharedInstance;
  NSError* error = nil;
  if (![session setCategory:AVAudioSessionCategoryPlayback
                       mode:AVAudioSessionModeDefault
                    options:0
                      error:&error]) {
    return configurationFailure(requestedGeneration, state, intent, session,
                                false, @"configure", error);
  }
  error = nil;
  if (![session setActive:YES error:&error]) {
    return configurationFailure(requestedGeneration, state, intent, session,
                                false, @"activate", error);
  }
  return SingzVerifyPlaybackAudioSession(requestedGeneration, state, intent,
                                         snapshot(session, true));
}
