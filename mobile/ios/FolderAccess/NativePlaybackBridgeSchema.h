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
  std::string laneId;
  float gain{0.0F};
  bool muted{false};
  bool solo{false};
};

bool SingzParsePlaybackGeneration(id value, uint64_t* generation);
bool SingzParsePlaybackPrepare(NSDictionary* request,
                               SingzParsedPlaybackPrepare* parsed,
                               NSString** error);
bool SingzParsePlaybackControl(NSDictionary* control,
                               SingzParsedPlaybackControl* parsed);
