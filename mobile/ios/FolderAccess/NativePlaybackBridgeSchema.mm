#import "NativePlaybackBridgeSchema.h"

#include <algorithm>
#include <cmath>
#include <initializer_list>
#include <limits>
#include <utility>

namespace {

constexpr double kMaximumSafeJsInteger =
    static_cast<double>(singz::kNativePlaybackMaximumJsSafeInteger);

bool isExactNumber(id value) {
  return [value isKindOfClass:NSNumber.class] &&
         CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID();
}

bool parseUint32(id value, uint32_t *result, bool allowZero) {
  if (result == nullptr)
    return false;
  *result = 0;
  if (!isExactNumber(value))
    return false;
  const double requested = [value doubleValue];
  if (!std::isfinite(requested) || requested < (allowZero ? 0.0 : 1.0) ||
      std::floor(requested) != requested ||
      requested > std::numeric_limits<uint32_t>::max())
    return false;
  *result = static_cast<uint32_t>(requested);
  return true;
}

bool parseJsSafeUint64(id value, uint64_t *result, bool allowZero) {
  if (result == nullptr)
    return false;
  *result = 0;
  if (!isExactNumber(value))
    return false;
  const double requested = [value doubleValue];
  if (!std::isfinite(requested) || requested < (allowZero ? 0.0 : 1.0) ||
      std::floor(requested) != requested || requested > kMaximumSafeJsInteger)
    return false;
  *result = static_cast<uint64_t>(requested);
  return true;
}

bool parseGain(id value, float *result) {
  if (result == nullptr)
    return false;
  *result = 0.0F;
  if (!isExactNumber(value))
    return false;
  const double requested = [value doubleValue];
  if (!std::isfinite(requested) || requested < 0.0 ||
      requested > singz::kNativePlaybackMaximumLinearGain)
    return false;
  *result = static_cast<float>(requested);
  return true;
}

bool parseBool(id value, bool *result) {
  if (result == nullptr)
    return false;
  *result = false;
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID())
    return false;
  *result = [value boolValue];
  return true;
}

bool parseString(id value, std::string *result, bool allowEmpty = false) {
  if (result == nullptr)
    return false;
  result->clear();
  if (![value isKindOfClass:NSString.class])
    return false;
  NSString *string = value;
  if (!allowEmpty && string.length == 0)
    return false;
  const char *utf8 = string.UTF8String;
  // NSString may contain an unpaired UTF-16 surrogate. In that case
  // UTF8String is null; constructing std::string from it would be undefined.
  if (utf8 == nullptr)
    return false;
  const NSUInteger byteLength =
      [string lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  std::string candidate(utf8, static_cast<size_t>(byteLength));
  // Every accepted bridge string is later passed through C/C++ APIs whose
  // string boundary is NUL-terminated (notably filesystem authorization and
  // descriptor opening). Reject an embedded U+0000 here so no field can be
  // silently truncated or reinterpreted after schema validation.
  if (candidate.find('\0') != std::string::npos)
    return false;
  if (!allowEmpty && candidate.empty())
    return false;
  *result = std::move(candidate);
  return true;
}

bool hasOnlyKeys(NSDictionary *value,
                 std::initializer_list<NSString *> allowed) {
  if (![value isKindOfClass:NSDictionary.class])
    return false;
  for (id key in value) {
    if (![key isKindOfClass:NSString.class])
      return false;
    bool found = false;
    for (NSString *candidate : allowed)
      found = found || [key isEqualToString:candidate];
    if (!found)
      return false;
  }
  return true;
}

bool parseChannels(NSArray *values, std::vector<uint32_t> *channels) {
  if (channels == nullptr)
    return false;
  channels->clear();
  if (![values isKindOfClass:NSArray.class] || values.count == 0 ||
      values.count > singz::kAudioHostMaxChannels)
    return false;
  std::vector<uint32_t> candidate;
  candidate.reserve(values.count);
  for (id value in values) {
    uint32_t channel = 0;
    if (!parseUint32(value, &channel, true) ||
        channel >= singz::kAudioHostMaxChannels ||
        std::find(candidate.begin(), candidate.end(), channel) !=
            candidate.end())
      return false;
    candidate.push_back(channel);
  }
  *channels = std::move(candidate);
  return true;
}

} // namespace

bool SingzParsePlaybackGeneration(id value, uint64_t *generation) {
  if (generation == nullptr)
    return false;
  *generation = 0;
  return parseJsSafeUint64(value, generation, false);
}

bool SingzParsePlaybackPrepare(NSDictionary *request,
                               SingzParsedPlaybackPrepare *parsed,
                               NSString **error) {
  if (parsed != nullptr)
    *parsed = {};
  if (error != nullptr)
    *error = nil;
  if (parsed == nullptr || error == nullptr) {
    if (error != nullptr)
      *error = @"The native playback prepare schema is invalid";
    return false;
  }
  SingzParsedPlaybackPrepare candidate;
  if (!hasOnlyKeys(request,
                   {@"lanes", @"outputDeviceUid", @"outputChannels",
                    @"sampleRate", @"maximumFrames", @"bufferFrames",
                    @"masterGain", @"maximumRetainedBytes", @"handoffLease"})) {
    *error = @"The native playback prepare schema is invalid";
    return false;
  }
  id specsValue = request[@"lanes"];
  id outputUidValue = request[@"outputDeviceUid"];
  id outputChannelsValue = request[@"outputChannels"];
  id sampleRateValue = request[@"sampleRate"];
  if (![specsValue isKindOfClass:NSArray.class] ||
      ![outputChannelsValue isKindOfClass:NSArray.class]) {
    *error = @"The playback route intent is invalid";
    return false;
  }
  NSArray *specs = specsValue;
  if (specs.count == 0 || specs.count > singz::kNativePlaybackMaximumLanes ||
      !parseChannels(outputChannelsValue, &candidate.config.outputChannels)) {
    *error = @"The native playback lane or output channel list is invalid";
    return false;
  }
  uint32_t sampleRate = 0;
  if (!parseUint32(sampleRateValue, &sampleRate, false)) {
    *error = @"The playback sample rate is invalid";
    return false;
  }
  if (!parseString(outputUidValue, &candidate.config.outputDeviceUid)) {
    *error = @"The playback route intent is invalid";
    return false;
  }
  candidate.config.requestedSampleRate = sampleRate;

  id maximumFrames = request[@"maximumFrames"];
  if (maximumFrames != nil &&
      !parseUint32(maximumFrames, &candidate.config.maximumFrames, false)) {
    *error = @"The maximum callback size is invalid";
    return false;
  }
  id bufferFrames = request[@"bufferFrames"];
  if (bufferFrames != nil &&
      !parseUint32(bufferFrames, &candidate.config.requestedBufferFrames,
                   true)) {
    *error = @"The requested buffer size is invalid";
    return false;
  }
  id masterGain = request[@"masterGain"];
  if (masterGain != nil &&
      !parseGain(masterGain, &candidate.config.masterGain)) {
    *error = @"The master gain is invalid";
    return false;
  }
  id retainedBytesValue = request[@"maximumRetainedBytes"];
  if (retainedBytesValue != nil) {
    if (!isExactNumber(retainedBytesValue)) {
      *error = @"The retained-byte limit is invalid";
      return false;
    }
    const double bytes = [retainedBytesValue doubleValue];
    if (!std::isfinite(bytes) || bytes < 1 || std::floor(bytes) != bytes ||
        bytes > kMaximumSafeJsInteger ||
        bytes > static_cast<double>(std::numeric_limits<size_t>::max())) {
      *error = @"The retained-byte limit is invalid";
      return false;
    }
    candidate.config.maximumRetainedBytes = static_cast<size_t>(bytes);
  }
  id handoffLeaseValue = request[@"handoffLease"];
  if (handoffLeaseValue != nil &&
      !parseJsSafeUint64(handoffLeaseValue, &candidate.config.handoffLease,
                         false)) {
    *error = @"The native playback handoff lease is invalid";
    return false;
  }

  candidate.lanes.reserve(specs.count);
  for (id object in specs) {
    if (![object isKindOfClass:NSDictionary.class] ||
        !hasOnlyKeys(object, {@"id", @"path", @"gain", @"muted", @"solo"})) {
      *error = @"A native playback lane schema is invalid";
      return false;
    }
    NSDictionary *spec = object;
    id laneId = spec[@"id"];
    id path = spec[@"path"];
    SingzParsedPlaybackLane lane;
    if (!parseString(laneId, &lane.id) || !parseString(path, &lane.path)) {
      *error = @"A native playback lane is invalid";
      return false;
    }
    id gain = spec[@"gain"];
    id muted = spec[@"muted"];
    id solo = spec[@"solo"];
    if ((gain != nil && !parseGain(gain, &lane.gain)) ||
        (muted != nil && !parseBool(muted, &lane.muted)) ||
        (solo != nil && !parseBool(solo, &lane.solo))) {
      *error = @"A native playback lane control is invalid";
      return false;
    }
    candidate.lanes.push_back(std::move(lane));
  }
  *parsed = std::move(candidate);
  return true;
}

bool SingzParsePlaybackControl(NSDictionary *control,
                               SingzParsedPlaybackControl *parsed) {
  if (parsed == nullptr)
    return false;
  *parsed = {};
  if (![control isKindOfClass:NSDictionary.class])
    return false;
  SingzParsedPlaybackControl candidate;
  const bool laneSelectorPresent = control[@"laneId"] != nil;
  const bool masterSelectorPresent = control[@"masterGain"] != nil;
  if (laneSelectorPresent == masterSelectorPresent)
    return false;
  if (laneSelectorPresent) {
    if (!hasOnlyKeys(control, {@"laneId", @"gain", @"muted", @"solo"}))
      return false;
    id laneId = control[@"laneId"];
    if (!parseString(laneId, &candidate.laneId) ||
        !parseGain(control[@"gain"], &candidate.gain) ||
        !parseBool(control[@"muted"], &candidate.muted) ||
        !parseBool(control[@"solo"], &candidate.solo))
      return false;
    candidate.lane = true;
    *parsed = std::move(candidate);
    return true;
  }
  if (!hasOnlyKeys(control, {@"masterGain"}) ||
      !parseGain(control[@"masterGain"], &candidate.gain))
    return false;
  *parsed = std::move(candidate);
  return true;
}
