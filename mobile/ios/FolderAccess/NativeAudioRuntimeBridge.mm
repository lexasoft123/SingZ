#import <React/RCTBridgeModule.h>

#import "NativePlaybackBridgeSupport.h"
#import "NativeCodecTargetProof.h"

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

RCT_EXPORT_METHOD(session:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  SingzNativePlaybackSession(resolve, reject);
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
    lanePeaks,
    lanePeaks : (nonnull NSNumber*)generation
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  SingzNativePlaybackLanePeaks(generation, resolve, reject);
}

RCT_REMAP_METHOD(
    unload,
    unload : (nonnull NSNumber*)generation
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  SingzNativePlaybackUnload(generation, resolve, reject);
}

// One argument plus the promise pair, exactly like unload above and exactly
// like Android's unloadRetainingLanes(generationValue, promise). An arity that
// disagrees with JS is never dispatched and never says so.
RCT_REMAP_METHOD(
    unloadRetainingLanes,
    unloadRetainingLanes : (nonnull NSNumber*)generation
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  SingzNativePlaybackUnloadRetainingLanes(generation, resolve, reject);
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

RCT_REMAP_METHOD(
    transport,
    transport : (nonnull NSNumber*)generation
        command : (NSDictionary*)command
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  SingzNativePlaybackTransport(generation, command, resolve, reject);
}

RCT_REMAP_METHOD(
    previewClick,
    previewClick : (nonnull NSNumber*)generation
        sound : (nonnull NSNumber*)sound
        resolver : (RCTPromiseResolveBlock)resolve
        rejecter : (RCTPromiseRejectBlock)reject)
{
  SingzNativePlaybackPreviewClick(generation, sound, resolve, reject);
}

#if defined(SINGZ_CODEC_TARGET_PROOF)
  RCT_EXPORT_METHOD(codecTargetProof:(RCTPromiseResolveBlock)resolve
                    rejecter:(RCTPromiseRejectBlock)reject)
  {
    SingzRunCodecTargetProof(resolve, reject);
  }
#endif

@end
