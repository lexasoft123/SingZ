#pragma once

#import <React/RCTBridgeModule.h>

void SingzNativePlaybackStatus(RCTPromiseResolveBlock resolve,
                               RCTPromiseRejectBlock reject);
// The session block alone — the object Status nests under "session" — for the
// telemetry poll, without the route inventory and runtime description Status
// rebuilds on every call. Android's nativePlaybackSession() is its exact twin:
// same name, no arguments.
void SingzNativePlaybackSession(RCTPromiseResolveBlock resolve,
                                RCTPromiseRejectBlock reject);
// Where the song is RIGHT NOW, answered on the CALLING thread — the player's
// clock, read the way the legacy engine reads its AudioContext's currentTime.
// The only synchronous entry here: it never touches the control queue
// (prepare and stop can hold it for seconds) and reads the core's lock-free
// publication. Android's positionNow() is its exact twin: same name, no
// arguments, the same keys.
NSDictionary* SingzNativePlaybackPositionNow(void);
// Hold a parked generation's output stream without closing it, and let it go
// again. iOS keeps rendering in the background by decision and never calls
// these; they exist so both bridges expose the same surface (same name, one
// argument plus the promise pair, like stop) — the RemoteIO host refuses
// with InvalidState and the stream keeps rendering, which is exactly the
// contract. Android's suspendOutput/resumeOutput are the twins that act.
void SingzNativePlaybackSuspendOutput(NSNumber* generation,
                                      RCTPromiseResolveBlock resolve,
                                      RCTPromiseRejectBlock reject);
void SingzNativePlaybackResumeOutput(NSNumber* generation,
                                     RCTPromiseResolveBlock resolve,
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
