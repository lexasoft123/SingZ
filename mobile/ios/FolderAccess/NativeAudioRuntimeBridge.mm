#import <React/RCTBridgeModule.h>

#import "NativePlaybackBridgeSupport.h"

// Phase iOS-B1 exposes a generation-bound dormant playback surface. No JS
// product consumer calls it yet, and ownership remains "legacy" until the
// ADR-0008 coordinator performs an atomic output handoff in B2.
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
