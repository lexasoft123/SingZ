// iOS binding of the shared C++ engine core (mobile/native/core) — the same
// marshalling-only rule as Android's singz_core_jni.cpp: the module name and
// the JSON payloads are identical on both platforms, so the JS pipeline has
// one surface. Phase 0 exposes only the ORT probe; the split job API lands
// with Phase 3 (BGContinuedProcessingTask runner).
#import <React/RCTBridgeModule.h>

#include <string>

#include "ort_env.h"

@interface SingzSplit : NSObject <RCTBridgeModule>
@end

@implementation SingzSplit

RCT_EXPORT_MODULE(SingzSplit)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

RCT_EXPORT_METHOD(ortProbe:(NSString *)modelPath
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  // A probe on a 136 MB graph blocks for seconds — never on the JS thread.
  NSString *path = modelPath ?: @"";
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    const std::string json = singz::ortProbeJson(std::string(path.UTF8String));
    resolve([NSString stringWithUTF8String:json.c_str()]);
  });
}

@end
