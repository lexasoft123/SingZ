#include "native/playback/playback_cue_plan.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#ifndef SINGZ_PLAYBACK_CUE_FIXTURE_PATH
#error "SINGZ_PLAYBACK_CUE_FIXTURE_PATH must name the shared parity fixture"
#endif

namespace {

struct Json {
  enum class Kind { Null, Boolean, Number, String, Array, Object };
  Kind kind{Kind::Null};
  bool boolean{false};
  double number{0.0};
  std::string string;
  std::vector<Json> array;
  std::map<std::string, Json> object;

  const Json &at(const std::string &key) const { return object.at(key); }
};

class JsonParser {
public:
  explicit JsonParser(std::string text) : text_(std::move(text)) {}

  Json parse() {
    Json value = parseValue();
    whitespace();
    if (position_ != text_.size()) {
      throw std::runtime_error("trailing JSON data");
    }
    return value;
  }

private:
  Json parseValue() {
    whitespace();
    if (position_ >= text_.size()) {
      throw std::runtime_error("unexpected JSON end");
    }
    const char token = text_[position_];
    if (token == '{') {
      return parseObject();
    }
    if (token == '[') {
      return parseArray();
    }
    if (token == '"') {
      Json out;
      out.kind = Json::Kind::String;
      out.string = parseString();
      return out;
    }
    if (token == 't' || token == 'f') {
      Json out;
      out.kind = Json::Kind::Boolean;
      if (text_.compare(position_, 4, "true") == 0) {
        out.boolean = true;
        position_ += 4;
      } else if (text_.compare(position_, 5, "false") == 0) {
        out.boolean = false;
        position_ += 5;
      } else {
        throw std::runtime_error("invalid JSON boolean");
      }
      return out;
    }
    if (text_.compare(position_, 4, "null") == 0) {
      position_ += 4;
      return {};
    }
    return parseNumber();
  }

  Json parseObject() {
    Json out;
    out.kind = Json::Kind::Object;
    ++position_;
    whitespace();
    if (consume('}')) {
      return out;
    }
    for (;;) {
      whitespace();
      if (position_ >= text_.size() || text_[position_] != '"') {
        throw std::runtime_error("JSON object key expected");
      }
      const std::string key = parseString();
      whitespace();
      require(':');
      if (!out.object.emplace(key, parseValue()).second) {
        throw std::runtime_error("duplicate JSON object key");
      }
      whitespace();
      if (consume('}')) {
        return out;
      }
      require(',');
    }
  }

  Json parseArray() {
    Json out;
    out.kind = Json::Kind::Array;
    ++position_;
    whitespace();
    if (consume(']')) {
      return out;
    }
    for (;;) {
      out.array.push_back(parseValue());
      whitespace();
      if (consume(']')) {
        return out;
      }
      require(',');
    }
  }

  std::string parseString() {
    require('"');
    std::string out;
    while (position_ < text_.size()) {
      const char value = text_[position_++];
      if (value == '"') {
        return out;
      }
      if (value == '\\') {
        if (position_ >= text_.size()) {
          throw std::runtime_error("truncated JSON escape");
        }
        const char escaped = text_[position_++];
        switch (escaped) {
        case '"':
        case '\\':
        case '/':
          out.push_back(escaped);
          break;
        case 'b':
          out.push_back('\b');
          break;
        case 'f':
          out.push_back('\f');
          break;
        case 'n':
          out.push_back('\n');
          break;
        case 'r':
          out.push_back('\r');
          break;
        case 't':
          out.push_back('\t');
          break;
        default:
          throw std::runtime_error("unsupported JSON string escape");
        }
      } else {
        out.push_back(value);
      }
    }
    throw std::runtime_error("unterminated JSON string");
  }

  Json parseNumber() {
    const char *begin = text_.c_str() + position_;
    char *end = nullptr;
    const double number = std::strtod(begin, &end);
    if (end == begin) {
      throw std::runtime_error("invalid JSON number");
    }
    position_ += static_cast<size_t>(end - begin);
    Json out;
    out.kind = Json::Kind::Number;
    out.number = number;
    return out;
  }

  void whitespace() {
    while (position_ < text_.size() &&
           (text_[position_] == ' ' || text_[position_] == '\n' ||
            text_[position_] == '\r' || text_[position_] == '\t')) {
      ++position_;
    }
  }

  bool consume(char expected) {
    if (position_ < text_.size() && text_[position_] == expected) {
      ++position_;
      return true;
    }
    return false;
  }

  void require(char expected) {
    if (!consume(expected)) {
      throw std::runtime_error("unexpected JSON token");
    }
  }

  std::string text_;
  size_t position_{0};
};

int failures = 0;

void expect(bool condition, const std::string &message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    ++failures;
  }
}

double number(const Json &value) {
  if (value.kind != Json::Kind::Number) {
    throw std::runtime_error("fixture number expected");
  }
  return value.number;
}

bool boolean(const Json &value) {
  if (value.kind != Json::Kind::Boolean) {
    throw std::runtime_error("fixture boolean expected");
  }
  return value.boolean;
}

std::string string(const Json &value) {
  if (value.kind != Json::Kind::String) {
    throw std::runtime_error("fixture string expected");
  }
  return value.string;
}

uint32_t u32(const Json &value) {
  const double raw = number(value);
  if (raw < 0.0 || raw > std::numeric_limits<uint32_t>::max() ||
      std::floor(raw) != raw) {
    throw std::runtime_error("fixture uint32 expected");
  }
  return static_cast<uint32_t>(raw);
}

int64_t i64(const Json &value) {
  const double raw = number(value);
  if (raw < static_cast<double>(std::numeric_limits<int64_t>::min()) ||
      raw > static_cast<double>(std::numeric_limits<int64_t>::max()) ||
      std::floor(raw) != raw) {
    throw std::runtime_error("fixture int64 expected");
  }
  return static_cast<int64_t>(raw);
}

singz::PlaybackCuePlanRequest requestFrom(const Json &row) {
  singz::PlaybackCuePlanRequest request;
  request.sampleRate = number(row.at("sampleRate"));
  request.entrySeconds = number(row.at("entrySeconds"));
  if (row.object.count("countInAnchorSeconds") != 0)
    request.countInAnchorSeconds = number(row.at("countInAnchorSeconds"));
  request.durationSeconds = number(row.at("durationSeconds"));
  request.playbackRate = number(row.at("playbackRate"));
  request.click = boolean(row.at("click"));
  request.countInBars = u32(row.at("countInBars"));
  request.volume = number(row.at("volume"));
  request.accent = boolean(row.at("accent"));
  const Json &beat = row.at("beat");
  if (beat.kind != Json::Kind::Null) {
    request.beatGrid.beatsPerBar = u32(beat.at("beatsPerBar"));
    request.beatGrid.downbeat = u32(beat.at("downbeat"));
    for (const Json &value : beat.at("beats").array) {
      request.beatGrid.beats.push_back(number(value));
    }
    for (const Json &value : beat.at("downbeats").array) {
      request.beatGrid.downbeats.push_back(u32(value));
    }
  }
  return request;
}

float expectedClickSample(size_t frame, double sampleRate, double frequency,
                          double amplitude) {
  const double time = static_cast<double>(frame) / sampleRate;
  return static_cast<float>(
      amplitude * std::min(1.0, time / 0.0015) * std::exp(-time / 0.012) *
      std::sin(6.283185307179586476925286766559 * frequency * time));
}

// Apple, Windows and Android libm implementations may differ in the final
// sin/exp bit. Two Float32 ULP near full scale is tight enough to catch a
// changed envelope/order without requiring cross-libc bit identity.
constexpr double kPcmAbsoluteTolerance = 2e-7;

bool nearPcm(float actual, double expected,
             double tolerance = kPcmAbsoluteTolerance) {
  return std::abs(static_cast<double>(actual) - expected) <= tolerance;
}

void runValidCase(const Json &row) {
  const std::string name = string(row.at("name"));
  const singz::PlaybackCuePlanRequest request = requestFrom(row);
  const singz::PlaybackCuePlanResult result =
      singz::preparePlaybackCuePlan(request);
  expect(result.ok(),
         name + ": planner rejected valid fixture: " + result.message);
  if (!result.ok()) {
    return;
  }
  const auto &plan = *result.plan;
  const Json &expected = row.at("expected");
  expect(plan.sourceStartFrame == i64(expected.at("sourceStartFrame")),
         name + ": source start frame");
  expect(plan.songDurationFrames == i64(expected.at("songDurationFrames")),
         name + ": song duration frames");
  expect(plan.landingProjectFrame == i64(expected.at("landingProjectFrame")),
         name + ": landingProjectFrame");
  expect(plan.preRollFrames == i64(expected.at("preRollFrames")),
         name + ": pre-roll frames");
  expect(plan.countInEventCount == u32(expected.at("countInEventCount")),
         name + ": count-in event count");
  expect(plan.countInBeatsPerBar == u32(expected.at("countInBeatsPerBar")),
         name + ": count-in local meter");
  expect(plan.ordinaryClickPcm.size() == u32(expected.at("clickFrames")),
         name + ": ordinary click length");
  expect(plan.accentClickPcm.size() == u32(expected.at("clickFrames")),
         name + ": accent click length");
  expect(std::bit_cast<uint32_t>(plan.volume) ==
             std::bit_cast<uint32_t>(static_cast<float>(request.volume)),
         name + ": volume is a separate Float32 ReferenceGain scalar");
  expect(plan.beatGrid.beats == request.beatGrid.beats,
         name + ": sanitized beat positions retained exactly");
  expect(plan.beatGrid.downbeats == request.beatGrid.downbeats,
         name + ": sanitized downbeats retained exactly");

  const auto &events = expected.at("events").array;
  expect(plan.events.size() == events.size(), name + ": event count");
  const size_t eventCount = std::min(plan.events.size(), events.size());
  for (size_t i = 0; i < eventCount; ++i) {
    const int64_t frame = i64(events[i].array[0]);
    const auto sound = string(events[i].array[1]) == "accent"
                           ? singz::PlaybackCueSound::Accent
                           : singz::PlaybackCueSound::Ordinary;
    expect(plan.events[i].projectFrame == frame,
           name + ": event frame " + std::to_string(i));
    expect(plan.events[i].sound == sound,
           name + ": event sound " + std::to_string(i));
    if (i > 0) {
      expect(plan.events[i].projectFrame >= plan.events[i - 1].projectFrame,
             name + ": prepared events stay sorted");
    }
  }

  for (size_t i = 0; i < plan.ordinaryClickPcm.size(); ++i) {
    expect(nearPcm(plan.ordinaryClickPcm[i],
                   expectedClickSample(i, request.sampleRate, 1046.5, 0.62)),
           name + ": ordinary PCM frame " + std::to_string(i));
    expect(nearPcm(plan.accentClickPcm[i],
                   expectedClickSample(i, request.sampleRate, 1568.0, 0.9)),
           name + ": accent PCM frame " + std::to_string(i));
  }
}

void runPcmGolden(const Json &golden) {
  singz::PlaybackCuePlanRequest request;
  request.sampleRate = number(golden.at("sampleRate"));
  request.durationSeconds = 1.0;
  request.playbackRate = 1.0;
  request.volume = 0.37;
  const auto first = singz::preparePlaybackCuePlan(request);
  expect(first.ok(), "PCM golden plan prepared");
  if (!first.ok()) {
    return;
  }
  expect(first.plan->ordinaryClickPcm.size() == u32(golden.at("frames")),
         "PCM golden ordinary frame count");
  expect(first.plan->accentClickPcm.size() == u32(golden.at("frames")),
         "PCM golden accent frame count");
  const double tolerance = number(golden.at("absoluteTolerance"));
  for (const Json &sample : golden.at("samples").array) {
    const size_t frame = u32(sample.array[0]);
    expect(nearPcm(first.plan->ordinaryClickPcm.at(frame),
                   number(sample.array[1]), tolerance),
           "PCM golden ordinary sample " + std::to_string(frame));
    expect(nearPcm(first.plan->accentClickPcm.at(frame),
                   number(sample.array[2]), tolerance),
           "PCM golden accent sample " + std::to_string(frame));
  }
  const auto ordinaryPeak = *std::max_element(
      first.plan->ordinaryClickPcm.begin(), first.plan->ordinaryClickPcm.end(),
      [](float left, float right) { return std::abs(left) < std::abs(right); });
  const auto accentPeak = *std::max_element(
      first.plan->accentClickPcm.begin(), first.plan->accentClickPcm.end(),
      [](float left, float right) { return std::abs(left) < std::abs(right); });
  expect(first.plan->ordinaryClickPcm.front() == 0.0F,
         "ordinary click begins at zero attack");
  expect(first.plan->accentClickPcm.front() == 0.0F,
         "accent click begins at zero attack");
  expect(std::abs(ordinaryPeak) > 0.4F && std::abs(ordinaryPeak) <= 0.62F,
         "ordinary click preserves attack/amplitude envelope");
  expect(std::abs(accentPeak) > 0.6F && std::abs(accentPeak) <= 0.9F,
         "accent click preserves attack/amplitude envelope");
  expect(std::abs(first.plan->ordinaryClickPcm.back()) < 0.02F &&
             std::abs(first.plan->accentClickPcm.back()) < 0.02F,
         "click exponential tail decays before 55 ms");

  request.volume = 0.91;
  const auto second = singz::preparePlaybackCuePlan(request);
  expect(second.ok(), "PCM second-volume plan prepared");
  if (!second.ok()) {
    return;
  }
  for (size_t i = 0; i < first.plan->ordinaryClickPcm.size(); ++i) {
    expect(nearPcm(first.plan->ordinaryClickPcm[i],
                   second.plan->ordinaryClickPcm[i]),
           "ordinary PCM is invariant under ReferenceGain volume");
    expect(
        nearPcm(first.plan->accentClickPcm[i], second.plan->accentClickPcm[i]),
        "accent PCM is invariant under ReferenceGain volume");
  }
  expect(std::bit_cast<uint32_t>(first.plan->volume) !=
             std::bit_cast<uint32_t>(second.plan->volume),
         "ReferenceGain volume remains separate from PCM");
}

void runReferenceGainGolden(const Json &fixture) {
  const Json &pcm = fixture.at("pcmGolden").array.front();
  singz::PlaybackCuePlanRequest baselineRequest;
  baselineRequest.sampleRate = number(pcm.at("sampleRate"));
  baselineRequest.durationSeconds = 1.0;
  baselineRequest.playbackRate = 1.0;
  baselineRequest.volume = 0.0;
  const auto baseline = singz::preparePlaybackCuePlan(baselineRequest);
  expect(baseline.ok(), "ReferenceGain baseline plan prepared");
  if (!baseline.ok()) {
    return;
  }
  for (const Json &golden : fixture.at("referenceGainGolden").array) {
    singz::PlaybackCuePlanRequest request;
    request.sampleRate = number(pcm.at("sampleRate"));
    request.durationSeconds = 1.0;
    request.playbackRate = 1.0;
    request.volume = number(golden.array[0]);
    const auto result = singz::preparePlaybackCuePlan(request);
    expect(result.ok(), "ReferenceGain golden plan prepared");
    if (!result.ok()) {
      continue;
    }
    expect(std::bit_cast<uint32_t>(result.plan->volume) == u32(golden.array[1]),
           "ReferenceGain preserves the shared Float32 volume scalar");
    for (size_t i = 0; i < baseline.plan->ordinaryClickPcm.size(); ++i) {
      expect(nearPcm(result.plan->ordinaryClickPcm[i],
                     baseline.plan->ordinaryClickPcm[i]),
             "ordinary base PCM is independent of ReferenceGain");
      expect(nearPcm(result.plan->accentClickPcm[i],
                     baseline.plan->accentClickPcm[i]),
             "accent base PCM is independent of ReferenceGain");
    }
  }
}

void runFrameRoundingGolden(const Json &golden) {
  singz::PlaybackCuePlanRequest request;
  request.sampleRate = number(golden.at("sampleRate"));
  request.entrySeconds = number(golden.at("seconds"));
  request.durationSeconds = 1.0;
  request.playbackRate = 1.0;
  const auto result = singz::preparePlaybackCuePlan(request);
  expect(result.ok(), "binary64 seconds-to-frame golden prepared");
  if (result.ok()) {
    expect(result.plan->sourceStartFrame == i64(golden.at("frame")),
           "binary64 seconds-to-frame matches JavaScript rounding");
  }
}

singz::PlaybackCuePlanRequest invalidBaseline() {
  singz::PlaybackCuePlanRequest request;
  request.beatGrid.beats = {0.0, 0.5, 1.0, 1.5, 2.0};
  request.beatGrid.beatsPerBar = 4;
  request.beatGrid.downbeat = 0;
  request.click = true;
  request.countInBars = 1;
  request.volume = 0.7;
  request.accent = true;
  request.entrySeconds = 1.0;
  request.durationSeconds = 2.0;
  request.sampleRate = 48000.0;
  request.playbackRate = 1.0;
  return request;
}

void runInvalidCase(const Json &row) {
  singz::PlaybackCuePlanRequest request = invalidBaseline();
  const std::string name = string(row.at("name"));
  const std::string field = string(row.at("field"));
  const Json &value = row.at("value");
  if (field == "entrySeconds") {
    request.entrySeconds = std::numeric_limits<double>::quiet_NaN();
  } else if (field == "durationSeconds") {
    request.durationSeconds = number(value);
  } else if (field == "beats") {
    request.beatGrid.beats.clear();
    for (const Json &beat : value.array) {
      request.beatGrid.beats.push_back(
          beat.kind == Json::Kind::String
              ? std::numeric_limits<double>::quiet_NaN()
              : number(beat));
    }
  } else if (field == "downbeats") {
    request.beatGrid.downbeats.clear();
    for (const Json &downbeat : value.array) {
      request.beatGrid.downbeats.push_back(u32(downbeat));
    }
  } else if (field == "denseDuration") {
    request.beatGrid.beats = {0.0, 0.2};
    request.entrySeconds = 0.0;
    request.durationSeconds = number(value);
    request.countInBars = 0;
  } else if (field == "beatCount") {
    request.beatGrid.beats.resize(static_cast<size_t>(number(value)));
    for (size_t i = 0; i < request.beatGrid.beats.size(); ++i) {
      request.beatGrid.beats[i] = static_cast<double>(i) * 0.5;
    }
  } else if (field == "durationLimit") {
    request.durationSeconds = number(value);
  } else {
    throw std::runtime_error("unknown invalid fixture field");
  }
  const singz::PlaybackCuePlanResult result =
      singz::preparePlaybackCuePlan(request);
  expect(!result.ok(), name + ": invalid input was accepted");
}

} // namespace

int main() {
  try {
    std::ifstream stream(SINGZ_PLAYBACK_CUE_FIXTURE_PATH,
                         std::ios::in | std::ios::binary);
    if (!stream) {
      throw std::runtime_error("could not open shared playback cue fixture");
    }
    const std::string text((std::istreambuf_iterator<char>(stream)),
                           std::istreambuf_iterator<char>());
    const Json fixture = JsonParser(text).parse();
    expect(u32(fixture.at("version")) == 2,
           "shared playback cue fixture version");
    for (const Json &golden : fixture.at("frameRoundingGolden").array) {
      runFrameRoundingGolden(golden);
    }
    for (const Json &golden : fixture.at("pcmGolden").array) {
      runPcmGolden(golden);
    }
    runReferenceGainGolden(fixture);
    for (const Json &row : fixture.at("cases").array) {
      runValidCase(row);
    }
    for (const Json &row : fixture.at("invalid").array) {
      runInvalidCase(row);
    }
  } catch (const std::exception &error) {
    std::cerr << "FAIL: " << error.what() << '\n';
    ++failures;
  }
  if (failures == 0) {
    std::cout << "playback cue planner tests passed\n";
  }
  return failures == 0 ? 0 : 1;
}
