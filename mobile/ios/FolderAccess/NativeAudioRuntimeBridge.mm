#import <React/RCTBridgeModule.h>

#import <SingzDspRuntime/SingzDspRuntimeCapability.h>

// Phase iOS-A is intentionally a read-only packaging probe. It proves the
// callback-safe graph component reached the installed app, but cannot open an
// AudioUnit, mutate AVAudioSession, or start playback. Phase iOS-B adds product
// ownership only behind ADR-0008's serialized handoff coordinator.
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
  (void)reject;
  const SingzDspRuntimeLinkStatus* status = SingzDspRuntimeGetLinkStatus();
  if (status == nullptr || status->interfaceVersion != 1 ||
      status->buildId == nullptr) {
    resolve(@{
      @"available": @NO,
      @"buildId": @"",
      @"graph": @NO,
      @"audioHostAdapter": @NO,
      @"ownership": @"legacy",
    });
    return;
  }
  resolve(@{
    @"available": @YES,
    @"buildId": [NSString stringWithUTF8String:status->buildId],
    @"graph": @((status->capabilityFlags &
                  SingzDspRuntimeCapabilityGraph) != 0),
    @"audioHostAdapter": @((status->capabilityFlags &
                             SingzDspRuntimeCapabilityAudioHostAdapter) != 0),
    @"ownership": @"legacy",
  });
}

@end
