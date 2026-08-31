#pragma once

#import <Foundation/Foundation.h>

#import <SingzPlaybackSession/native_playback_session.h>

#include <cstdint>
#include <string>
#include <vector>

enum class SingzPlaybackAudioSessionError : uint32_t {
  None = 0,
  InvalidGeneration,
  InvalidState,
  ConfigurationFailed,
  VerificationFailed,
};

// Exact output intent captured from a successfully published native prepare.
// Capturing this value is read-only with respect to AVAudioSession; only the
// dedicated B2 configure command below may mutate the process-global session.
struct SingzPlaybackAudioSessionIntent {
  uint64_t generation{0};
  std::string outputDeviceUid;
  std::vector<uint32_t> outputChannels;
  double sampleRate{0.0};
  uint32_t maximumFrames{0};
};

// Small value snapshot used by the Foundation-only policy runner. The iOS
// adapter fills it after category activation; tests never need a live device.
struct SingzPlaybackAudioSessionSnapshot {
  std::string category;
  std::string mode;
  uint64_t categoryOptions{0};
  bool active{false};
  uint32_t outputRouteCount{0};
  std::string outputDeviceUid;
  uint32_t outputChannelCount{0};
  double sampleRate{0.0};
  uint32_t nominalBufferFrames{0};
};

struct SingzPlaybackAudioSessionResult {
  bool ok{false};
  SingzPlaybackAudioSessionError error{
      SingzPlaybackAudioSessionError::InvalidState};
  uint64_t generation{0};
  singz::NativePlaybackState state{singz::NativePlaybackState::Unloaded};
  double sampleRate{0.0};
  uint32_t maximumFrames{0};
  uint32_t nominalBufferFrames{0};
  uint32_t outputChannels{0};
  SingzPlaybackAudioSessionSnapshot session;
  std::string message;
};

// Allocation-capable policy functions. Call them only inside
// SingzPlaybackBridgeBoundary.
SingzPlaybackAudioSessionResult SingzPlaybackAudioSessionPreflight(
    uint64_t requestedGeneration, uint64_t currentGeneration,
    uint64_t cancelledThrough, singz::NativePlaybackState state,
    const SingzPlaybackAudioSessionIntent& intent);
SingzPlaybackAudioSessionResult SingzVerifyPlaybackAudioSession(
    uint64_t generation, singz::NativePlaybackState state,
    const SingzPlaybackAudioSessionIntent& intent,
    SingzPlaybackAudioSessionSnapshot snapshot);

// iOS-only adapter: preflights the exact prepared generation, applies
// playback/default/options=0, activates AVAudioSession, then verifies the
// active route against the captured prepare intent. It never opens RemoteIO.
SingzPlaybackAudioSessionResult SingzConfigurePlaybackAudioSession(
    uint64_t requestedGeneration, uint64_t currentGeneration,
    uint64_t cancelledThrough, singz::NativePlaybackState state,
    const SingzPlaybackAudioSessionIntent& intent);

NSDictionary* SingzPlaybackAudioSessionResultDictionary(
    const SingzPlaybackAudioSessionResult& result);
