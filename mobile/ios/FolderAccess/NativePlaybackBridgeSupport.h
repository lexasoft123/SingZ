#pragma once

#import <React/RCTBridgeModule.h>

void SingzNativePlaybackStatus(RCTPromiseResolveBlock resolve,
                               RCTPromiseRejectBlock reject);
void SingzNativePlaybackPrepare(NSNumber* generation, NSDictionary* request,
                                RCTPromiseResolveBlock resolve,
                                RCTPromiseRejectBlock reject);
void SingzNativePlaybackConfigureOutputSession(NSNumber* generation,
                                               RCTPromiseResolveBlock resolve,
                                               RCTPromiseRejectBlock reject);
void SingzNativePlaybackOpenOutput(NSNumber* generation,
                                   RCTPromiseResolveBlock resolve,
                                   RCTPromiseRejectBlock reject);
void SingzNativePlaybackStart(NSNumber* generation,
                              RCTPromiseResolveBlock resolve,
                              RCTPromiseRejectBlock reject);
void SingzNativePlaybackStop(NSNumber* generation,
                             RCTPromiseResolveBlock resolve,
                             RCTPromiseRejectBlock reject);
void SingzNativePlaybackUnload(NSNumber* generation,
                               RCTPromiseResolveBlock resolve,
                               RCTPromiseRejectBlock reject);
void SingzNativePlaybackSetControl(NSNumber* generation,
                                   NSDictionary* control,
                                   RCTPromiseResolveBlock resolve,
                                   RCTPromiseRejectBlock reject);
