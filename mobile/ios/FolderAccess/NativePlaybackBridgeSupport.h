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
// The prepared lane envelopes for one generation. Immutable for it, so the
// facade reads this once and caches under the generation; a stale generation
// is refused rather than answered with an older envelope. Android's
// nativePlaybackLanePeaks(J) is its exact twin.
// Resolves {ok, error, generation, bucketCount, lanes[{id, peaksValid,
// peaks[bucketCount]}], message}. `generation` is a NUMBER here and on
// Android; the desktop addon publishes it as a decimal string.
void SingzNativePlaybackLanePeaks(NSNumber* generation,
                                  RCTPromiseResolveBlock resolve,
                                  RCTPromiseRejectBlock reject);
void SingzNativePlaybackUnload(NSNumber* generation,
                               RCTPromiseResolveBlock resolve,
                               RCTPromiseRejectBlock reject);
// Same unload, same arity, same resolved shape — it additionally parks this
// generation's decoded lanes for the very next prepare of the same files.
// Android's nativePlaybackUnloadRetainingLanes(J) is its exact twin.
void SingzNativePlaybackUnloadRetainingLanes(NSNumber* generation,
                                             RCTPromiseResolveBlock resolve,
                                             RCTPromiseRejectBlock reject);
void SingzNativePlaybackSetControl(NSNumber* generation,
                                   NSDictionary* control,
                                   RCTPromiseResolveBlock resolve,
                                   RCTPromiseRejectBlock reject);
void SingzNativePlaybackTransport(NSNumber* generation,
                                  NSDictionary* command,
                                  RCTPromiseResolveBlock resolve,
                                  RCTPromiseRejectBlock reject);
void SingzNativePlaybackPreviewClick(NSNumber* generation, NSNumber* sound,
                                     RCTPromiseResolveBlock resolve,
                                     RCTPromiseRejectBlock reject);
