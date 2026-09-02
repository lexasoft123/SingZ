#pragma once

#import <Foundation/Foundation.h>

#import <SingzPlaybackSession/native_playback_session.h>

#include <cstdint>
#include <string>
#include <vector>

struct SingzParsedPlaybackLane {
  std::string id;
  std::string path;
  float gain{1.0F};
  bool muted{false};
  bool solo{false};
};

struct SingzParsedPlaybackPrepare {
  singz::NativePlaybackPrepareConfig config;
  std::vector<SingzParsedPlaybackLane> lanes;
};

struct SingzParsedPlaybackControl {
  bool lane{false};
  bool training{false};
  std::string laneId;
  float gain{0.0F};
  bool muted{false};
  bool solo{false};
  bool enabled{false};
};

enum class SingzPlaybackTransportCommandKind : uint32_t {
  Pause = 0,
  Resume,
  Seek,
  SetLoop,
  ClearLoop,
  Reanchor,
};

struct SingzParsedPlaybackTransportCommand {
  SingzPlaybackTransportCommandKind kind{
      SingzPlaybackTransportCommandKind::Pause};
  int64_t projectFrame{0};
  int64_t loopStartFrame{0};
  int64_t loopEndFrame{0};
};

bool SingzParsePlaybackGeneration(id value, uint64_t* generation);
bool SingzParsePlaybackPreviewClickSound(
    id value, singz::NativePlaybackPreviewClickSound* sound);
bool SingzParsePlaybackPrepare(NSDictionary* request,
                               SingzParsedPlaybackPrepare* parsed,
                               NSString** error);
bool SingzParsePlaybackControl(NSDictionary* control,
                               SingzParsedPlaybackControl* parsed);
bool SingzParsePlaybackTransportCommand(
    NSDictionary* command, SingzParsedPlaybackTransportCommand* parsed);
