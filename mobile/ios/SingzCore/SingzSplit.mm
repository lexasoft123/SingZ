// iOS binding of the shared C++ engine core (mobile/native/core) — the same
// marshalling-only rule as Android's singz_core_jni.cpp/SplitModule.kt: the
// module name, method arity and the event payloads are identical on both
// platforms, so the JS pipeline has one surface (service.ts flips on via its
// splitAvailable probe the moment startSplit exists here). The job itself
// lives in SingzSplitRunner — in-process, iOS has no :split to isolate into.
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

#include <string>

#import "SingzSplitRunner.h"

#include "ort_env.h"

@interface SingzSplit : RCTEventEmitter <RCTBridgeModule>
@end

@implementation SingzSplit

RCT_EXPORT_MODULE(SingzSplit)

// Ungated emission, the Android DeviceEventEmitter semantics: the JS side
// subscribes with DeviceEventEmitter.addListener, which never calls this
// module's exported addListener — with observation ENABLED, RCTEventEmitter
// counts zero listeners and silently drops every event (measured in review:
// the card would sit at "Starting…" for a whole split).
- (instancetype)init {
  return [super initWithDisabledObservation];
}

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[ @"singzSplitProgress", @"singzSplitState" ];
}

- (void)emitSafely:(NSString *)name body:(NSDictionary *)body {
  // Belt over the disabled-observation braces: an emitter racing teardown
  // must never take the app down for firing late.
  @try {
    [self sendEventWithName:name body:body];
  } @catch (NSException *e) {
  }
}

RCT_EXPORT_METHOD(startSplit:(NSString *)srcPath
                  modelPath:(NSString *)modelPath
                  projectDir:(NSString *)projectDir
                  resume:(BOOL)resume
                  watchdogCapMs:(double)watchdogCapMs
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  __weak SingzSplit *weakSelf = self;
  const BOOL started = [[SingzSplitRunner shared]
      startWithSrc:srcPath
             model:modelPath
        projectDir:projectDir
            resume:resume
     watchdogCapMs:(int64_t)watchdogCapMs
          progress:^(NSString *stage, double frac, int64_t done, int64_t total,
                     double footprintMb, double headroomMb, double cpuPct) {
            [weakSelf emitSafely:@"singzSplitProgress"
                            body:@{
                              @"stage" : stage,
                              @"frac" : @(frac),
                              @"done" : @((double)done),
                              @"total" : @((double)total),
                              @"memMb" : @(footprintMb),
                              @"freeMb" : @(headroomMb),
                              @"cpuPct" : @(cpuPct)
                            }];
          }
             state:^(NSString *state, NSString *_Nullable error) {
               NSMutableDictionary *body = [@{@"state" : state} mutableCopy];
               if (error) body[@"error"] = error;
               [weakSelf emitSafely:@"singzSplitState" body:body];
             }];
  if (started) {
    resolve(@YES);
  } else {
    // One job at a time; the app checks splitStatus before starting.
    [self emitSafely:@"singzSplitState" body:@{@"state" : @"busy"}];
    resolve(@NO);
  }
}

RCT_EXPORT_METHOD(cancelSplit:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [[SingzSplitRunner shared] cancel];
  resolve(@YES);
}

RCT_EXPORT_METHOD(splitStatus:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSDictionary *status = [SingzSplitRunner jobStatus];
  resolve(status ?: (id)kCFNull);
}

RCT_EXPORT_METHOD(attachSplitEvents:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  // In-process: events flow whenever the app lives — no binder to rebind.
  resolve(@YES);
}

RCT_EXPORT_METHOD(clearJob:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [SingzSplitRunner clearJobDir];
  resolve(@YES);
}

RCT_EXPORT_METHOD(splitVitals:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  resolve([SingzSplitRunner vitals]);
}

RCT_EXPORT_METHOD(takeSplitTrail:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  resolve([SingzSplitRunner takeVitalsTrail] ?: (id)kCFNull);
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
