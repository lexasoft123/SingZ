#import "NativePlaybackBridgeSchema.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <initializer_list>
#include <limits>
#include <utility>

namespace {

constexpr double kMaximumSafeJsInteger =
    static_cast<double>(singz::kNativePlaybackMaximumJsSafeInteger);
constexpr uint32_t kPlaybackContractVersion = 2;
constexpr double kMinimumPlaybackRate = 0.25;
constexpr double kMaximumPlaybackRate = 4.0;
constexpr double kMinimumBeatSeparationSeconds = 0.05;
constexpr double kMinimumBpm = 30.0;
constexpr double kMaximumBpm = 300.0;

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

bool parseJsSafeNonNegativeInt64(id value, int64_t *result) {
  if (result == nullptr)
    return false;
  *result = 0;
  if (!isExactNumber(value))
    return false;
  const double requested = [value doubleValue];
  if (!std::isfinite(requested) || requested < 0.0 ||
      std::floor(requested) != requested || requested > kMaximumSafeJsInteger)
    return false;
  *result = static_cast<int64_t>(requested);
  return true;
}

bool parseJsSafeInt64(id value, int64_t *result) {
  if (result == nullptr)
    return false;
  *result = 0;
  if (!isExactNumber(value))
    return false;
  const double requested = [value doubleValue];
  if (!std::isfinite(requested) || std::floor(requested) != requested ||
      requested < -kMaximumSafeJsInteger || requested > kMaximumSafeJsInteger)
    return false;
  *result = static_cast<int64_t>(requested);
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

bool parseFiniteDouble(id value, double *result, double minimum,
                       double maximum) {
  if (result == nullptr)
    return false;
  *result = 0.0;
  if (!isExactNumber(value))
    return false;
  const double requested = [value doubleValue];
  if (!std::isfinite(requested) || requested < minimum || requested > maximum)
    return false;
  *result = requested;
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

bool parseBeatGrid(id value, singz::PlaybackCueBeatGrid *grid,
                   uint32_t countInBars, uint64_t *countInEventPotential) {
  if (grid == nullptr || countInEventPotential == nullptr)
    return false;
  *grid = {};
  *countInEventPotential = 0;
  if (![value isKindOfClass:NSDictionary.class] ||
      !hasOnlyKeys(value,
                   {@"beats", @"beatsPerBar", @"downbeat", @"downbeats"}))
    return false;
  NSDictionary *object = value;
  id beatsValue = object[@"beats"];
  id downbeatsValue = object[@"downbeats"];
  if (![beatsValue isKindOfClass:NSArray.class] ||
      ![downbeatsValue isKindOfClass:NSArray.class])
    return false;
  NSArray *beats = beatsValue;
  NSArray *downbeats = downbeatsValue;
  if (beats.count < 2 || beats.count > singz::kPlaybackCueMaximumBeats ||
      downbeats.count > beats.count)
    return false;

  uint32_t beatsPerBar = 0;
  uint32_t downbeat = 0;
  if (!parseUint32(object[@"beatsPerBar"], &beatsPerBar, false) ||
      (beatsPerBar != 2 && beatsPerBar != 3 && beatsPerBar != 4 &&
       beatsPerBar != 6) ||
      !parseUint32(object[@"downbeat"], &downbeat, true) ||
      downbeat >= beatsPerBar)
    return false;

  std::vector<double> parsedBeats;
  parsedBeats.reserve(beats.count);
  std::vector<double> intervals;
  intervals.reserve(beats.count - 1);
  double previous = 0.0;
  for (NSUInteger index = 0; index < beats.count; ++index) {
    double beat = 0.0;
    if (!parseFiniteDouble(beats[index], &beat, 0.0,
                           singz::kPlaybackCueMaximumDurationSeconds) ||
        (index > 0 && beat - previous <= kMinimumBeatSeparationSeconds))
      return false;
    if (index > 0)
      intervals.push_back(beat - previous);
    parsedBeats.push_back(beat);
    previous = beat;
  }
  std::sort(intervals.begin(), intervals.end());
  const double bpm = 60.0 / intervals[intervals.size() / 2];
  if (!std::isfinite(bpm) || bpm < kMinimumBpm || bpm > kMaximumBpm)
    return false;

  std::vector<uint32_t> parsedDownbeats;
  parsedDownbeats.reserve(downbeats.count);
  uint32_t previousDownbeat = 0;
  uint32_t maximumBarLength = beatsPerBar;
  for (NSUInteger index = 0; index < downbeats.count; ++index) {
    uint32_t position = 0;
    if (!parseUint32(downbeats[index], &position, true) ||
        position >= beats.count || (index > 0 && position <= previousDownbeat))
      return false;
    if (index > 0)
      maximumBarLength =
          std::max(maximumBarLength, position - previousDownbeat);
    parsedDownbeats.push_back(position);
    previousDownbeat = position;
  }
  const uint64_t countInPotential =
      static_cast<uint64_t>(countInBars) * maximumBarLength;
  if (countInPotential > singz::kPlaybackCueMaximumEvents)
    return false;

  grid->beats = std::move(parsedBeats);
  grid->beatsPerBar = beatsPerBar;
  grid->downbeat = downbeat;
  grid->downbeats = std::move(parsedDownbeats);
  *countInEventPotential = countInPotential;
  return true;
}

bool parsePlayback(id value, double sampleRate,
                   singz::PlaybackCuePlanRequest *request,
                   double *transposeSemitones) {
  if (request == nullptr || transposeSemitones == nullptr)
    return false;
  *request = {};
  if (![value isKindOfClass:NSDictionary.class] ||
      !hasOnlyKeys(value, {@"version", @"transport", @"cues"}))
    return false;
  NSDictionary *playback = value;
  uint32_t version = 0;
  if (!parseUint32(playback[@"version"], &version, false) ||
      version != kPlaybackContractVersion)
    return false;

  id transportValue = playback[@"transport"];
  id cuesValue = playback[@"cues"];
  if (![transportValue isKindOfClass:NSDictionary.class] ||
      !hasOnlyKeys(transportValue,
                   {@"entrySeconds", @"countInAnchorSeconds",
                    @"durationSeconds", @"playbackRate",
                    @"transposeSemitones"}) ||
      ![cuesValue isKindOfClass:NSDictionary.class] ||
      !hasOnlyKeys(cuesValue, {@"click", @"countInBars", @"volume", @"accent",
                               @"beatGrid"}))
    return false;

  NSDictionary *transport = transportValue;
  NSDictionary *cues = cuesValue;
  singz::PlaybackCuePlanRequest candidate;
  // Optional: where the song audibly begins when that is not the entry (a
  // Play from mid-song with the count-in on). Absent, the request's default
  // (negative) says the count-in precedes the entry itself.
  if (transport[@"countInAnchorSeconds"] != nil &&
      (!parseFiniteDouble(transport[@"countInAnchorSeconds"],
                          &candidate.countInAnchorSeconds, 0.0,
                          singz::kPlaybackCueMaximumDurationSeconds)))
    return false;
  if (!parseFiniteDouble(transport[@"entrySeconds"], &candidate.entrySeconds,
                         0.0, singz::kPlaybackCueMaximumDurationSeconds) ||
      !parseFiniteDouble(transport[@"playbackRate"], &candidate.playbackRate,
                         kMinimumPlaybackRate, kMaximumPlaybackRate) ||
      !parseFiniteDouble(transport[@"transposeSemitones"],
                         transposeSemitones, -24.0, 24.0) ||
      !parseBool(cues[@"click"], &candidate.click) ||
      !parseUint32(cues[@"countInBars"], &candidate.countInBars, true) ||
      candidate.countInBars > 2 ||
      !parseFiniteDouble(cues[@"volume"], &candidate.volume, 0.0, 1.0) ||
      !parseBool(cues[@"accent"], &candidate.accent))
    return false;

  // Duration is decoded-lane authority. Older test/control clients may still
  // send the field, but it is schema-checked and deliberately discarded; the
  // native session overwrites this sentinel after every lane is decoded.
  id durationValue = transport[@"durationSeconds"];
  double ignoredDuration = 0.0;
  if (durationValue != nil &&
      (!parseFiniteDouble(durationValue, &ignoredDuration, 0.0,
                          singz::kPlaybackCueMaximumDurationSeconds) ||
       ignoredDuration <= 0.0))
    return false;
  candidate.durationSeconds = singz::kPlaybackCueMaximumDurationSeconds;

  id beatGrid = cues[@"beatGrid"];
  uint64_t countInPotential = static_cast<uint64_t>(candidate.countInBars) * 3;
  if (beatGrid != nil &&
      !parseBeatGrid(beatGrid, &candidate.beatGrid, candidate.countInBars,
                     &countInPotential))
    return false;

  if (candidate.click && candidate.beatGrid.beats.empty())
    return false;
  if (candidate.click) {
    const auto &beats = candidate.beatGrid.beats;
    const double clickPotential = static_cast<double>(beats.size()) + 2;
    if (!std::isfinite(clickPotential) ||
        clickPotential + static_cast<double>(countInPotential) >
            static_cast<double>(singz::kPlaybackCueMaximumEvents))
      return false;
  }

  // The surrounding native prepare route owns the only graph clock. The
  // nested DTO intentionally carries no duplicate sample-rate field.
  candidate.sampleRate = sampleRate;
  *request = std::move(candidate);
  return true;
}

bool parseTraining(id value, singz::NativePlaybackTrainingDuckConfig *result) {
  if (result == nullptr)
    return false;
  *result = {};
  if (![value isKindOfClass:NSDictionary.class] ||
      !hasOnlyKeys(value,
                   {@"mode", @"periodFrames", @"windows", @"laneIds",
                    @"enabled"}))
    return false;
  NSDictionary *object = value;
  id modeValue = object[@"mode"];
  id laneIdsValue = object[@"laneIds"];
  if (![modeValue isKindOfClass:NSString.class] ||
      ![laneIdsValue isKindOfClass:NSArray.class] ||
      !parseBool(object[@"enabled"], &result->enabled))
    return false;
  NSArray *laneIds = laneIdsValue;
  if (laneIds.count == 0 ||
      laneIds.count > singz::kNativePlaybackMaximumLanes)
    return false;
  result->laneIds.reserve(laneIds.count);
  for (id laneIdValue in laneIds) {
    std::string laneId;
    if (!parseString(laneIdValue, &laneId) ||
        std::find(result->laneIds.begin(), result->laneIds.end(), laneId) !=
            result->laneIds.end())
      return false;
    result->laneIds.push_back(std::move(laneId));
  }

  if ([modeValue isEqualToString:@"period"]) {
    if (object[@"windows"] != nil ||
        !parseJsSafeNonNegativeInt64(object[@"periodFrames"],
                                     &result->periodFrames) ||
        result->periodFrames == 0)
      return false;
    result->mode = singz::NativePlaybackTrainingMode::Period;
    return true;
  }
  if (![modeValue isEqualToString:@"windows"] ||
      object[@"periodFrames"] != nil ||
      ![object[@"windows"] isKindOfClass:NSArray.class])
    return false;
  NSArray *windows = object[@"windows"];
  if (windows.count == 0 ||
      windows.count > singz::kNativePlaybackMaximumTrainingWindows)
    return false;
  result->mode = singz::NativePlaybackTrainingMode::Windows;
  result->windows.reserve(windows.count);
  int64_t previousEnd = 0;
  for (NSUInteger index = 0; index < windows.count; ++index) {
    id windowValue = windows[index];
    if (![windowValue isKindOfClass:NSDictionary.class] ||
        !hasOnlyKeys(windowValue,
                     {@"startProjectFrame", @"endProjectFrame"}))
      return false;
    NSDictionary *window = windowValue;
    singz::NativePlaybackTrainingWindow parsedWindow;
    if (!parseJsSafeNonNegativeInt64(window[@"startProjectFrame"],
                                     &parsedWindow.startProjectFrame) ||
        !parseJsSafeNonNegativeInt64(window[@"endProjectFrame"],
                                     &parsedWindow.endProjectFrame) ||
        parsedWindow.endProjectFrame <= parsedWindow.startProjectFrame ||
        (index != 0 && parsedWindow.startProjectFrame < previousEnd))
      return false;
    previousEnd = parsedWindow.endProjectFrame;
    result->windows.push_back(parsedWindow);
  }
  return true;
}

bool parseInitialTransport(
    id value, singz::NativePlaybackInitialTransportConfig *result) {
  if (result == nullptr)
    return false;
  *result = {};
  if (![value isKindOfClass:NSDictionary.class] ||
      !hasOnlyKeys(value, {@"state", @"loop"}))
    return false;
  NSDictionary *object = value;
  id state = object[@"state"];
  if (![state isKindOfClass:NSString.class] ||
      (![state isEqualToString:@"playing"] &&
       ![state isEqualToString:@"paused"]))
    return false;
  result->startPaused = [state isEqualToString:@"paused"];
  id loopValue = object[@"loop"];
  if (loopValue == nil)
    return true;
  if (![loopValue isKindOfClass:NSDictionary.class] ||
      !hasOnlyKeys(loopValue, {@"startProjectFrame", @"endProjectFrame"}))
    return false;
  NSDictionary *loop = loopValue;
  singz::NativePlaybackInitialLoop parsedLoop;
  if (!parseJsSafeNonNegativeInt64(loop[@"startProjectFrame"],
                                   &parsedLoop.startProjectFrame) ||
      !parseJsSafeNonNegativeInt64(loop[@"endProjectFrame"],
                                   &parsedLoop.endProjectFrame) ||
      parsedLoop.endProjectFrame <= parsedLoop.startProjectFrame)
    return false;
  result->loop = parsedLoop;
  return true;
}

bool parseGraphNodeId(id value, uint64_t *result) {
  std::string text;
  if (result == nullptr || !parseString(value, &text) || text.size() > 20 ||
      (text.size() > 1 && text[0] == '0'))
    return false;
  const auto converted =
      std::from_chars(text.data(), text.data() + text.size(), *result, 10);
  return converted.ec == std::errc{} &&
         converted.ptr == text.data() + text.size() && *result != 0;
}

bool parseGraphType(id value, zdsp::NodeTypeId *result) {
  std::string text;
  if (result == nullptr || !parseString(value, &text) || text.size() != 32)
    return false;
  for (const char character : text)
    if (!((character >= '0' && character <= '9') ||
          (character >= 'a' && character <= 'f')))
      return false;
  const auto high =
      std::from_chars(text.data(), text.data() + 16, result->high, 16);
  const auto low =
      std::from_chars(text.data() + 16, text.data() + 32, result->low, 16);
  return high.ec == std::errc{} && high.ptr == text.data() + 16 &&
         low.ec == std::errc{} && low.ptr == text.data() + 32;
}

bool parseGraphPorts(id value,
                     std::vector<singz::NativePlaybackGraphPort> *result) {
  if (result == nullptr || ![value isKindOfClass:NSArray.class])
    return false;
  NSArray *array = value;
  if (array.count > zdsp::kMaximumBusesPerProcessor)
    return false;
  std::vector<singz::NativePlaybackGraphPort> ports;
  ports.reserve(array.count);
  for (id raw in array) {
    if (![raw isKindOfClass:NSDictionary.class] ||
        !hasOnlyKeys(raw, {@"id", @"channels"}))
      return false;
    NSDictionary *object = raw;
    singz::NativePlaybackGraphPort port;
    if (!parseString(object[@"id"], &port.id) || port.id.size() > 128 ||
        !parseUint32(object[@"channels"], &port.channels, false) ||
        port.channels > zdsp::kMaximumChannelsPerBus ||
        std::any_of(ports.begin(), ports.end(), [&](const auto &prior) {
          return prior.id == port.id;
        }))
      return false;
    ports.push_back(std::move(port));
  }
  *result = std::move(ports);
  return true;
}

bool parseGraphParameters(
    id value,
    std::vector<singz::NativePlaybackGraphParameter> *result) {
  if (result == nullptr || ![value isKindOfClass:NSDictionary.class])
    return false;
  NSDictionary *object = value;
  if (object.count > singz::kNativePlaybackGraphMaximumParametersPerNode)
    return false;
  std::vector<singz::NativePlaybackGraphParameter> parameters;
  parameters.reserve(object.count);
  for (id key in object) {
    singz::NativePlaybackGraphParameter parameter;
    double normalized = 0.0;
    if (!parseString(key, &parameter.id) || parameter.id.size() > 128 ||
        !parseFiniteDouble(object[key], &normalized, 0.0, 1.0))
      return false;
    parameter.normalizedValue = normalized;
    parameters.push_back(std::move(parameter));
  }
  *result = std::move(parameters);
  return true;
}

bool parseGraphDocument(id value,
                        singz::NativePlaybackGraphDocument *result) {
  if (result == nullptr || ![value isKindOfClass:NSDictionary.class] ||
      !hasOnlyKeys(value, {@"format", @"engine", @"nodes", @"connections"}))
    return false;
  NSDictionary *object = value;
  singz::NativePlaybackGraphDocument document;
  if (!parseUint32(object[@"format"], &document.format, false) ||
      document.format != singz::kNativePlaybackGraphDocumentFormat ||
      !parseString(object[@"engine"], &document.engine) ||
      document.engine != singz::kNativePlaybackGraphDocumentEngine ||
      ![object[@"nodes"] isKindOfClass:NSArray.class] ||
      ![object[@"connections"] isKindOfClass:NSArray.class])
    return false;
  NSArray *nodes = object[@"nodes"];
  NSArray *connections = object[@"connections"];
  if (nodes.count == 0 || nodes.count > zdsp::kMaximumGraphNodes ||
      connections.count > zdsp::kMaximumGraphConnections)
    return false;
  document.nodes.reserve(nodes.count);
  for (id raw in nodes) {
    if (![raw isKindOfClass:NSDictionary.class] ||
        !hasOnlyKeys(raw,
                     {@"id", @"type", @"typeVersion", @"execution",
                      @"unavailable", @"ports", @"parameters", @"binding"}))
      return false;
    NSDictionary *nodeObject = raw;
    id portsValue = nodeObject[@"ports"];
    if (![portsValue isKindOfClass:NSDictionary.class] ||
        !hasOnlyKeys(portsValue, {@"inputs", @"outputs"}))
      return false;
    NSDictionary *ports = portsValue;
    singz::NativePlaybackGraphNode node;
    uint32_t typeVersion = 0;
    std::string unavailable;
    if (!parseGraphNodeId(nodeObject[@"id"], &node.id) ||
        !parseGraphType(nodeObject[@"type"], &node.type) ||
        !parseUint32(nodeObject[@"typeVersion"], &typeVersion, false) ||
        !parseString(nodeObject[@"execution"], &node.execution) ||
        node.execution.size() > 128 ||
        !parseString(nodeObject[@"unavailable"], &unavailable) ||
        (unavailable != "bypass" && unavailable != "silence") ||
        !parseGraphPorts(ports[@"inputs"], &node.inputs) ||
        !parseGraphPorts(ports[@"outputs"], &node.outputs) ||
        !parseGraphParameters(nodeObject[@"parameters"], &node.parameters))
      return false;
    node.typeVersion = typeVersion;
    node.unavailable =
        unavailable == "bypass"
            ? singz::NativePlaybackGraphUnavailablePolicy::Bypass
            : singz::NativePlaybackGraphUnavailablePolicy::Silence;
    id bindingValue = nodeObject[@"binding"];
    if (bindingValue != nil) {
      if (![bindingValue isKindOfClass:NSDictionary.class] ||
          !hasOnlyKeys(bindingValue, {@"kind", @"laneId"}))
        return false;
      NSDictionary *bindingObject = bindingValue;
      singz::NativePlaybackGraphBinding binding;
      if (!parseString(bindingObject[@"kind"], &binding.kind) ||
          binding.kind.size() > 128)
        return false;
      if (bindingObject[@"laneId"] != nil &&
          (!parseString(bindingObject[@"laneId"], &binding.laneId) ||
           binding.laneId.size() > 128))
        return false;
      node.binding = std::move(binding);
    }
    document.nodes.push_back(std::move(node));
  }
  document.connections.reserve(connections.count);
  for (id raw in connections) {
    if (![raw isKindOfClass:NSDictionary.class] ||
        !hasOnlyKeys(raw, {@"from", @"to"}))
      return false;
    NSDictionary *connectionObject = raw;
    id fromValue = connectionObject[@"from"];
    id toValue = connectionObject[@"to"];
    if (![fromValue isKindOfClass:NSDictionary.class] ||
        !hasOnlyKeys(fromValue, {@"node", @"port"}) ||
        ![toValue isKindOfClass:NSDictionary.class] ||
        !hasOnlyKeys(toValue, {@"node", @"port"}))
      return false;
    NSDictionary *from = fromValue;
    NSDictionary *to = toValue;
    singz::NativePlaybackGraphConnection connection;
    if (!parseGraphNodeId(from[@"node"], &connection.from.node) ||
        !parseString(from[@"port"], &connection.from.port) ||
        connection.from.port.size() > 128 ||
        !parseGraphNodeId(to[@"node"], &connection.to.node) ||
        !parseString(to[@"port"], &connection.to.port) ||
        connection.to.port.size() > 128)
      return false;
    document.connections.push_back(std::move(connection));
  }
  *result = std::move(document);
  return true;
}

} // namespace

bool SingzParsePlaybackGeneration(id value, uint64_t *generation) {
  if (generation == nullptr)
    return false;
  *generation = 0;
  return parseJsSafeUint64(value, generation, false);
}

bool SingzParsePlaybackPreviewClickSound(
    id value, singz::NativePlaybackPreviewClickSound *sound) {
  if (sound == nullptr)
    return false;
  *sound = singz::NativePlaybackPreviewClickSound::Ordinary;
  uint32_t parsed = 0;
  if (!parseUint32(value, &parsed, true) || parsed > 1)
    return false;
  *sound = parsed == 0 ? singz::NativePlaybackPreviewClickSound::Ordinary
                       : singz::NativePlaybackPreviewClickSound::Accent;
  return true;
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
  if (!hasOnlyKeys(request, {@"lanes", @"outputDeviceUid", @"outputChannels",
                             @"sampleRate", @"maximumFrames", @"bufferFrames",
                             @"masterGain", @"maximumRetainedBytes",
                             @"handoffLease", @"playback", @"training",
                             @"preparedStartProjectFrame",
                             @"initialTransport", @"graphDocument",
                             @"swapFromGeneration", @"streamLanes"})) {
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

  id playbackValue = request[@"playback"];
  if (playbackValue != nil) {
    singz::PlaybackCuePlanRequest playback;
    double transposeSemitones = 0.0;
    if (!parsePlayback(playbackValue, sampleRate, &playback,
                       &transposeSemitones)) {
      *error = @"The versioned playback transport or cue plan is invalid";
      return false;
    }
    candidate.config.playbackRate = playback.playbackRate;
    candidate.config.transposeSemitones = transposeSemitones;
    candidate.config.cuePlan = std::move(playback);
  }
  id trainingValue = request[@"training"];
  if (trainingValue != nil) {
    singz::NativePlaybackTrainingDuckConfig training;
    if (!parseTraining(trainingValue, &training)) {
      *error = @"The prepared native training schedule is invalid";
      return false;
    }
    candidate.config.trainingDuck = std::move(training);
  }
  id preparedStartProjectFrame = request[@"preparedStartProjectFrame"];
  if (preparedStartProjectFrame != nil) {
    int64_t frame = 0;
    if (!parseJsSafeInt64(preparedStartProjectFrame, &frame)) {
      *error = @"The prepared playback start position is invalid";
      return false;
    }
    candidate.config.preparedStartProjectFrame = frame;
  }
  id initialTransport = request[@"initialTransport"];
  if (initialTransport != nil &&
      !parseInitialTransport(initialTransport,
                             &candidate.config.initialTransport)) {
    *error = @"The prepared initial transport is invalid";
    return false;
  }
  id graphDocument = request[@"graphDocument"];
  if (graphDocument != nil) {
    singz::NativePlaybackGraphDocument graph;
    if (!parseGraphDocument(graphDocument, &graph)) {
      *error = @"The portable native graph document is invalid";
      return false;
    }
    candidate.config.graphDocument = std::move(graph);
  }

  // Play the lanes out of their FLAC rather than decoding each one whole.
  // Absent means false, which is today's behaviour exactly.
  id streamLanes = request[@"streamLanes"];
  if (streamLanes != nil &&
      !parseBool(streamLanes, &candidate.config.streamLanes)) {
    *error = @"The playback lane streaming flag is invalid";
    return false;
  }

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
  id swapFromValue = request[@"swapFromGeneration"];
  if (swapFromValue != nil &&
      !parseJsSafeUint64(swapFromValue, &candidate.config.swapFromGeneration,
                         false)) {
    *error = @"The native playback swap source generation is invalid";
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
  const bool trainingSelectorPresent = control[@"trainingEnabled"] != nil;
  if (static_cast<uint32_t>(laneSelectorPresent) +
          static_cast<uint32_t>(masterSelectorPresent) +
          static_cast<uint32_t>(trainingSelectorPresent) !=
      1)
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
  if (trainingSelectorPresent) {
    if (!hasOnlyKeys(control, {@"trainingEnabled"}) ||
        !parseBool(control[@"trainingEnabled"], &candidate.enabled))
      return false;
    candidate.training = true;
    *parsed = std::move(candidate);
    return true;
  }
  if (!hasOnlyKeys(control, {@"masterGain"}) ||
      !parseGain(control[@"masterGain"], &candidate.gain))
    return false;
  *parsed = std::move(candidate);
  return true;
}

bool SingzParsePlaybackTransportCommand(
    NSDictionary *command, SingzParsedPlaybackTransportCommand *parsed) {
  if (parsed == nullptr)
    return false;
  *parsed = {};
  if (![command isKindOfClass:NSDictionary.class])
    return false;
  id kindValue = command[@"kind"];
  if (![kindValue isKindOfClass:NSString.class])
    return false;
  NSString *kind = kindValue;
  SingzParsedPlaybackTransportCommand candidate;
  if ([kind isEqualToString:@"pause"] || [kind isEqualToString:@"resume"] ||
      [kind isEqualToString:@"clear-loop"] ||
      [kind isEqualToString:@"reanchor"]) {
    if (!hasOnlyKeys(command, {@"kind"}))
      return false;
    if ([kind isEqualToString:@"pause"])
      candidate.kind = SingzPlaybackTransportCommandKind::Pause;
    else if ([kind isEqualToString:@"resume"])
      candidate.kind = SingzPlaybackTransportCommandKind::Resume;
    else if ([kind isEqualToString:@"clear-loop"])
      candidate.kind = SingzPlaybackTransportCommandKind::ClearLoop;
    else
      candidate.kind = SingzPlaybackTransportCommandKind::Reanchor;
  } else if ([kind isEqualToString:@"seek"]) {
    if (!hasOnlyKeys(command, {@"kind", @"projectFrame"}) ||
        !parseJsSafeNonNegativeInt64(command[@"projectFrame"],
                                     &candidate.projectFrame))
      return false;
    candidate.kind = SingzPlaybackTransportCommandKind::Seek;
  } else if ([kind isEqualToString:@"set-loop"]) {
    if (!hasOnlyKeys(command,
                     {@"kind", @"startProjectFrame", @"endProjectFrame"}) ||
        !parseJsSafeNonNegativeInt64(command[@"startProjectFrame"],
                                     &candidate.loopStartFrame) ||
        !parseJsSafeNonNegativeInt64(command[@"endProjectFrame"],
                                     &candidate.loopEndFrame) ||
        candidate.loopEndFrame <= candidate.loopStartFrame)
      return false;
    candidate.kind = SingzPlaybackTransportCommandKind::SetLoop;
  } else {
    return false;
  }
  *parsed = candidate;
  return true;
}
