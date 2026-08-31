#import <React/RCTBridgeModule.h>

#import "NativePlaybackBridgeSupport.h"

// Phase iOS-B2 keeps the generation-bound B1 playback surface behind one
// experimental product coordinator. AVAudioSession activation remains a
// separate serialized command between legacy suspension and RemoteIO open.
@interface NativeAudioRuntime : NSObject <RCTBridgeModule>
@end

@implementation NativeAudioRuntime

RCT_EXPORT_MODULE(NativeAudioRuntime)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(status:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  SingzNativePlaybackStatus(resolve, reject);
}

RCT_REMAP_METHOD(
    prepare,
    prepare : (nonnull NSNumber*)generation
        request : (NSDictionary*)request
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  SingzNativePlaybackPrepare(generation, request, resolve, reject);
}

RCT_REMAP_METHOD(
    configureOutputSession,
    configureOutputSession : (nonnull NSNumber*)generation
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  SingzNativePlaybackConfigureOutputSession(generation, resolve, reject);
}

RCT_REMAP_METHOD(
    openOutput,
    openOutput : (nonnull NSNumber*)generation
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  SingzNativePlaybackOpenOutput(generation, resolve, reject);
}

RCT_REMAP_METHOD(
    start,
    start : (nonnull NSNumber*)generation
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  SingzNativePlaybackStart(generation, resolve, reject);
}

RCT_REMAP_METHOD(
    stop,
    stop : (nonnull NSNumber*)generation
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  SingzNativePlaybackStop(generation, resolve, reject);
}

RCT_REMAP_METHOD(
    unload,
    unload : (nonnull NSNumber*)generation
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  SingzNativePlaybackUnload(generation, resolve, reject);
}

RCT_REMAP_METHOD(
    setControl,
    setControl : (nonnull NSNumber*)generation
        control : (NSDictionary*)control
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  SingzNativePlaybackSetControl(generation, control, resolve, reject);
}

@end
