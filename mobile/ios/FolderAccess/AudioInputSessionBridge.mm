#import <React/RCTBridgeModule.h>

#include "audio_input_ios_session.h"

#include <cerrno>
#include <cstdint>
#include <cstdlib>

@interface AudioInputSession : NSObject <RCTBridgeModule>
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

}  // namespace

@implementation AudioInputSession

RCT_EXPORT_MODULE(AudioInputSession)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
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

@end
