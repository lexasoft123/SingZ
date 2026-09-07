// The core's half of the TypeScript/C++ playback contract.
//
// It reads the same two files the TypeScript suites read —
// tests/shared/native-playback-bridge-manifest.json and
// tests/shared/native-playback-agreement-cases.json — and puts their claims to
// the core itself. Where a value is restated on both sides of the boundary,
// this is the side that answers for C++; jest and vitest answer for the rest.
//
// What it can reach matters. The enum-to-string tables the bridges publish are
// written in the bridges, not here, so the only wire table the core owns is
// nativePlaybackErrorName — and that one is asserted string for string,
// fallthrough included, because the core falls back to "host-failure" where
// the TypeScript parser falls back to "provider-failure" and a table pin that
// dropped the last line would call those identical.
//
// See docs/NATIVE-PLAYBACK-BRIDGE.md.

#include <native/playback/native_playback_graph_document.h>
#include <native/playback/native_playback_session.h>
#include <native/playback/playback_cue_plan.h>
#include <zcore/media/decoded_audio.h>

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <iterator>
#include <map>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "tests/native/fixture_json.h"

#ifndef SINGZ_NATIVE_PLAYBACK_MANIFEST_PATH
#error "SINGZ_NATIVE_PLAYBACK_MANIFEST_PATH must name the shared bridge manifest"
#endif
#ifndef SINGZ_NATIVE_PLAYBACK_AGREEMENT_PATH
#error "SINGZ_NATIVE_PLAYBACK_AGREEMENT_PATH must name the shared agreement cases"
#endif

namespace {

using singz::testfixture::Json;
using singz::testfixture::readFixture;

int failures = 0;

void expect(bool condition, const std::string &what) {
  if (condition) {
    return;
  }
  std::cerr << "FAIL: " << what << '\n';
  ++failures;
}

template <typename Left, typename Right>
void expectEqual(const Left &left, const Right &right, const std::string &what) {
  if (left == right) {
    return;
  }
  std::cerr << "FAIL: " << what << " (" << left << " != " << right << ")\n";
  ++failures;
}

double number(const Json &value) {
  if (value.kind != Json::Kind::Number) {
    throw std::runtime_error("fixture value is not a number");
  }
  return value.number;
}

uint32_t u32(const Json &value) { return static_cast<uint32_t>(number(value)); }

/// One named scalar bound out of the shared agreement fixture.
double bound(const Json &fixture, const std::string &name) {
  for (const Json &row : fixture.at("scalarBounds").array) {
    if (row.at("name").string == name) {
      return number(row.at("value"));
    }
  }
  throw std::runtime_error("no scalar bound named " + name);
}

// ---------------------------------------------------------------------------

void errorNameTable(const Json &manifest) {
  const Json &entry = manifest.at("enums").at("playbackError");
  const std::vector<Json> &names = entry.at("enumerators").array;
  const std::vector<Json> &strings = entry.at("ios").at("strings").array;
  expectEqual(names.size(), strings.size(),
              "the manifest lists one wire string per NativePlaybackError enumerator");
  expectEqual(names.size(), size_t{14}, "NativePlaybackError has fourteen enumerators");

  for (size_t index = 0; index < strings.size(); ++index) {
    const auto value = static_cast<singz::NativePlaybackError>(index);
    expectEqual(std::string(singz::nativePlaybackErrorName(value)), strings[index].string,
                "nativePlaybackErrorName(" + names[index].string + ")");
  }

  // Past the last enumerator the core falls through. The manifest records the
  // iOS table's fallthrough, which is a DIFFERENT string — divergence register
  // entry 3. Pinning both is the only way that stays visible.
  const auto beyond = static_cast<singz::NativePlaybackError>(strings.size() + 1);
  expectEqual(std::string(singz::nativePlaybackErrorName(beyond)), std::string("host-failure"),
              "the core falls through to host-failure");
  expectEqual(entry.at("ios").at("fallback").string, std::string("provider-failure"),
              "iOS falls through to provider-failure instead");
}

// Enum sizes. Naming the LAST enumerator and adding one is not enough: an
// enumerator appended after it leaves the named one at the same index, so the
// count still matches and the mutation walks straight through. (Measured —
// that is exactly what the first version of this test did.)
//
// So each enum gets an exhaustive switch with NO default. Appending an
// enumerator stops this file compiling under -Werror=switch, which is the
// intended consumer going red at the earliest possible moment. The returned
// count is then compared against the manifest, so the two must move together.
#define SINGZ_ENUM_CASE(value)                                                 \
  case value:                                                                  \
    break;

size_t sizeOf(singz::NativePlaybackState probe) {
  switch (probe) {
    using enum singz::NativePlaybackState;
    SINGZ_ENUM_CASE(Unloaded)
    SINGZ_ENUM_CASE(Preparing)
    SINGZ_ENUM_CASE(Prepared)
    SINGZ_ENUM_CASE(OutputOpen)
    SINGZ_ENUM_CASE(Running)
    SINGZ_ENUM_CASE(Stopped)
    SINGZ_ENUM_CASE(Terminal)
    SINGZ_ENUM_CASE(Quarantined)
  }
  return 8;
}

size_t sizeOf(singz::NativePlaybackError probe) {
  switch (probe) {
    using enum singz::NativePlaybackError;
    SINGZ_ENUM_CASE(None)
    SINGZ_ENUM_CASE(InvalidGeneration)
    SINGZ_ENUM_CASE(InvalidState)
    SINGZ_ENUM_CASE(InvalidConfiguration)
    SINGZ_ENUM_CASE(Cancelled)
    SINGZ_ENUM_CASE(DecodeFailure)
    SINGZ_ENUM_CASE(LimitExceeded)
    SINGZ_ENUM_CASE(ResourceExhausted)
    SINGZ_ENUM_CASE(GraphFailure)
    SINGZ_ENUM_CASE(HostFailure)
    SINGZ_ENUM_CASE(ProviderFailure)
    SINGZ_ENUM_CASE(QueueFull)
    SINGZ_ENUM_CASE(TeardownUncertain)
    SINGZ_ENUM_CASE(UnsupportedPlaybackRate)
  }
  return 14;
}

size_t sizeOf(singz::NativePlaybackTransportState probe) {
  switch (probe) {
    using enum singz::NativePlaybackTransportState;
    SINGZ_ENUM_CASE(Stopped)
    SINGZ_ENUM_CASE(PreRoll)
    SINGZ_ENUM_CASE(Playing)
    SINGZ_ENUM_CASE(Paused)
    SINGZ_ENUM_CASE(Completed)
  }
  return 5;
}

size_t sizeOf(singz::NativePlaybackTransportTelemetryQuality probe) {
  switch (probe) {
    using enum singz::NativePlaybackTransportTelemetryQuality;
    SINGZ_ENUM_CASE(Unavailable)
    SINGZ_ENUM_CASE(Initial)
    SINGZ_ENUM_CASE(Current)
    SINGZ_ENUM_CASE(LastGood)
  }
  return 4;
}

size_t sizeOf(singz::NativePlaybackTransportBoundaryReason probe) {
  switch (probe) {
    using enum singz::NativePlaybackTransportBoundaryReason;
    SINGZ_ENUM_CASE(None)
    SINGZ_ENUM_CASE(StreamGenerationChanged)
    SINGZ_ENUM_CASE(SequenceGap)
    SINGZ_ENUM_CASE(SampleRateChanged)
    SINGZ_ENUM_CASE(RouteGenerationChanged)
    SINGZ_ENUM_CASE(TimestampQualityChanged)
    SINGZ_ENUM_CASE(ClockReanchored)
    SINGZ_ENUM_CASE(SourceSeek)
    SINGZ_ENUM_CASE(SourceLoop)
    SINGZ_ENUM_CASE(DeviceLost)
    SINGZ_ENUM_CASE(SourceFrameOverflow)
  }
  return 11;
}

size_t sizeOf(singz::NativePlaybackAudibleProjectionQuality probe) {
  switch (probe) {
    using enum singz::NativePlaybackAudibleProjectionQuality;
    SINGZ_ENUM_CASE(Unavailable)
    SINGZ_ENUM_CASE(Current)
  }
  return 2;
}

size_t sizeOf(singz::NativePlaybackCleanupSafety probe) {
  switch (probe) {
    using enum singz::NativePlaybackCleanupSafety;
    SINGZ_ENUM_CASE(NotOwned)
    SINGZ_ENUM_CASE(Complete)
    SINGZ_ENUM_CASE(Uncertain)
  }
  return 3;
}

size_t sizeOf(singz::NativePlaybackCoordinatorState probe) {
  switch (probe) {
    using enum singz::NativePlaybackCoordinatorState;
    SINGZ_ENUM_CASE(Available)
    SINGZ_ENUM_CASE(NativeOwned)
    SINGZ_ENUM_CASE(FallbackLeased)
    SINGZ_ENUM_CASE(Poisoned)
  }
  return 4;
}

size_t sizeOf(singz::NativePlaybackGraphNodeRole probe) {
  switch (probe) {
    using enum singz::NativePlaybackGraphNodeRole;
    SINGZ_ENUM_CASE(Input)
    SINGZ_ENUM_CASE(Processor)
    SINGZ_ENUM_CASE(Output)
  }
  return 3;
}

size_t sizeOf(singz::NativePlaybackGraphNodeKind probe) {
  switch (probe) {
    using enum singz::NativePlaybackGraphNodeKind;
    SINGZ_ENUM_CASE(Unknown)
    SINGZ_ENUM_CASE(PhysicalOutput)
    SINGZ_ENUM_CASE(DecodedSource)
    SINGZ_ENUM_CASE(ChannelMap)
    SINGZ_ENUM_CASE(Gain)
    SINGZ_ENUM_CASE(Mix)
    SINGZ_ENUM_CASE(ScheduledGain)
    SINGZ_ENUM_CASE(SignalsmithTimePitch)
    SINGZ_ENUM_CASE(ScheduledCueSource)
    SINGZ_ENUM_CASE(PeakRms)
    SINGZ_ENUM_CASE(Tap)
    SINGZ_ENUM_CASE(Oscillator)
    SINGZ_ENUM_CASE(SafetyLimiter)
    SINGZ_ENUM_CASE(UnavailableBypass)
    SINGZ_ENUM_CASE(UnavailableSilence)
  }
  return 15;
}

#undef SINGZ_ENUM_CASE

void enumSizes(const Json &manifest) {
  const auto counted = [&](const std::string &name) {
    return manifest.at("enums").at(name).at("enumerators").array.size();
  };

  expectEqual(sizeOf(singz::NativePlaybackState::Unloaded), counted("playbackState"),
              "NativePlaybackState size");
  expectEqual(sizeOf(singz::NativePlaybackError::None), counted("playbackError"),
              "NativePlaybackError size");
  expectEqual(sizeOf(singz::NativePlaybackTransportState::Stopped), counted("transportState"),
              "NativePlaybackTransportState size");
  expectEqual(sizeOf(singz::NativePlaybackTransportTelemetryQuality::Unavailable),
              counted("transportTelemetryQuality"),
              "NativePlaybackTransportTelemetryQuality size");
  expectEqual(sizeOf(singz::NativePlaybackTransportBoundaryReason::None),
              counted("transportBoundaryReason"),
              "NativePlaybackTransportBoundaryReason size");
  expectEqual(sizeOf(singz::NativePlaybackAudibleProjectionQuality::Unavailable),
              counted("audibleProjectionQuality"),
              "NativePlaybackAudibleProjectionQuality size");
  expectEqual(sizeOf(singz::NativePlaybackCleanupSafety::NotOwned), counted("cleanupSafety"),
              "NativePlaybackCleanupSafety size");
  expectEqual(sizeOf(singz::NativePlaybackCoordinatorState::Available),
              counted("coordinatorState"), "NativePlaybackCoordinatorState size");
  expectEqual(sizeOf(singz::NativePlaybackGraphNodeRole::Input), counted("graphNodeRole"),
              "NativePlaybackGraphNodeRole size");
  expectEqual(sizeOf(singz::NativePlaybackGraphNodeKind::Unknown), counted("graphNodeKind"),
              "NativePlaybackGraphNodeKind size");
}

void capabilityTag(const Json &manifest) {
  expectEqual(std::string(singz::nativePlaybackSessionCapabilityTag()),
              manifest.at("gates").at("playbackBuild").string,
              "the core's capability tag is the manifest's playbackBuild");
  expectEqual(manifest.at("gates").at("desktopCapability").string,
              manifest.at("gates").at("playbackBuild").string,
              "the desktop gate is the same tag under another name");
}

// ---------------------------------------------------------------------------

void codecBits(const Json &fixture) {
  const Json &bits = fixture.at("codecBitValues");
  expectEqual(static_cast<uint32_t>(singz::DecodedAudioCapabilityWav), u32(bits.at("wav")),
              "wav bit");
  expectEqual(static_cast<uint32_t>(singz::DecodedAudioCapabilityFlac), u32(bits.at("flac")),
              "flac bit");
  expectEqual(static_cast<uint32_t>(singz::DecodedAudioCapabilityMp3), u32(bits.at("mp3")),
              "mp3 bit");
  expectEqual(static_cast<uint32_t>(singz::DecodedAudioCapabilityM4aAac), u32(bits.at("m4aAac")),
              "m4a AAC bit");
  expectEqual(static_cast<uint32_t>(singz::DecodedAudioCapabilityM4aAlac),
              u32(bits.at("m4aAlac")), "m4a ALAC bit");
  expectEqual(static_cast<uint32_t>(singz::DecodedAudioCapabilityAac), u32(bits.at("aac")),
              "aac bit");
  expectEqual(static_cast<uint32_t>(singz::DecodedAudioCapabilityOggVorbis),
              u32(bits.at("oggVorbis")), "ogg vorbis bit");
  expectEqual(static_cast<uint32_t>(singz::DecodedAudioCapabilityOggOpus),
              u32(bits.at("oggOpus")), "ogg opus bit");
  expectEqual(static_cast<uint32_t>(singz::DecodedAudioCapabilityAiff), u32(bits.at("aiff")),
              "aiff bit");
  expectEqual(singz::kDecodedAudioProductFormatMask, u32(bits.at("productMask")),
              "the product format mask is every named bit");

  // m4a is the one extension needing two bits, and the TypeScript side tests
  // for both. A build carrying only one must not claim it — the assertion
  // exists here because the mask, not the switch, is what would drift.
  expectEqual(static_cast<uint32_t>(singz::DecodedAudioCapabilityM4aAac |
                                    singz::DecodedAudioCapabilityM4aAlac),
              u32(bits.at("m4aAac")) | u32(bits.at("m4aAlac")), "both m4a bits");
}

void scalarBounds(const Json &fixture) {
  expectEqual(static_cast<double>(singz::kNativePlaybackMaximumLanes), bound(fixture, "maximumLanes"),
              "maximum lanes");
  expectEqual(static_cast<double>(singz::kNativePlaybackMaximumLinearGain),
              bound(fixture, "maximumLinearGain"), "maximum linear gain");
  expectEqual(static_cast<double>(singz::kNativePlaybackDefaultMaximumRetainedBytes),
              bound(fixture, "defaultMaximumRetainedBytes"), "default retention cap");
  expectEqual(static_cast<double>(singz::kNativePlaybackLaneSummaryBuckets),
              bound(fixture, "laneSummaryBuckets"), "lane summary buckets");
  expectEqual(static_cast<double>(singz::kNativePlaybackMaximumConcurrentLaneDecodes),
              bound(fixture, "maximumConcurrentLaneDecodes"), "concurrent lane decodes");
  expectEqual(static_cast<double>(singz::kNativePlaybackMaximumGraphNodes),
              bound(fixture, "maximumGraphNodes"), "maximum graph nodes");
  expectEqual(static_cast<double>(singz::kNativePlaybackMaximumGraphConnections),
              bound(fixture, "maximumGraphConnections"), "maximum graph connections");
  expectEqual(static_cast<double>(singz::kNativePlaybackMaximumTrainingWindows),
              bound(fixture, "maximumTrainingWindows"), "maximum training windows");
  expectEqual(static_cast<double>(singz::kPlaybackCueMaximumBeats), bound(fixture, "maximumBeats"),
              "maximum beats");
  expectEqual(static_cast<double>(singz::kPlaybackCueMaximumEvents),
              bound(fixture, "maximumCueEvents"), "maximum cue events");
  expectEqual(static_cast<double>(singz::kPlaybackCueMaximumDurationSeconds),
              bound(fixture, "maximumDurationSeconds"), "maximum duration");
  expectEqual(static_cast<double>(singz::kNativePlaybackMaximumJsSafeInteger),
              bound(fixture, "maximumJsSafeInteger"), "JS safe integer ceiling");

  // -1 dBFS. Compared AT FLOAT PRECISION, because the constant is a float and
  // the synthesized document's literal is a double: widening the float to
  // double leaves it about 3e-8 away from the fixture's digits, which is the
  // float's own rounding and not a disagreement. A tolerance tight enough to
  // catch a real change and loose enough to ignore that is exactly one
  // narrowing conversion.
  expectEqual(singz::kNativePlaybackLimiterCeiling,
              static_cast<float>(bound(fixture, "limiterCeiling")), "limiter ceiling");
}

// ---------------------------------------------------------------------------

singz::NativePlaybackGraphContext context(size_t lanes, size_t training, bool reference,
                                          bool timePitch) {
  singz::NativePlaybackGraphContext value;
  value.outputChannels = 2;
  value.hasReference = reference;
  value.needsTimePitch = timePitch;
  value.hasTraining = training > 0;
  for (size_t index = 0; index < lanes; ++index) {
    singz::NativePlaybackGraphLaneContext lane;
    lane.id = "lane-" + std::to_string(index);
    lane.sourceChannels = 2;
    lane.trainingSelected = index < training;
    value.lanes.push_back(std::move(lane));
  }
  return value;
}

void graphNodeCount(const Json &fixture) {
  for (const Json &row : fixture.at("graphNodeCount").array) {
    // A row the core cannot express: TypeScript rejects "more training lanes
    // than lanes" up front, while the core derives the training count by
    // counting the lanes themselves, so the input has no representation here.
    if (row.at("agreement").string != "both") {
      continue;
    }
    const auto lanes = static_cast<size_t>(number(row.at("laneCount")));
    const auto training = static_cast<size_t>(number(row.at("trainingLaneCount")));
    const size_t predicted = singz::synthesizedNativePlaybackGraphNodeCount(
        context(lanes, training, row.at("hasReference").boolean,
                row.at("needsTimePitch").boolean));
    expectEqual(predicted, static_cast<size_t>(number(row.at("expected"))),
                "node count: " + row.at("name").string);
  }
}

// The validation matrix in the contract document says the core is the only
// thing that rejects these. Nothing proved it until now, which meant the
// matrix's authoritative row was an assertion about code nobody had asked.
void graphDuplicateRejections() {
  const singz::NativePlaybackGraphContext ctx = context(2, 1, true, false);
  const singz::NativePlaybackGraphDocument healthy =
      singz::synthesizeNativePlaybackGraphDocument(ctx);
  expect(singz::materializeNativePlaybackGraphDocument(healthy, ctx).ok(),
         "the synthesized document materializes");
  expect(healthy.nodes.size() >= 2 && !healthy.connections.empty(),
         "the synthesized document has nodes and connections to duplicate");

  {
    singz::NativePlaybackGraphDocument document = healthy;
    document.nodes.push_back(document.nodes.front());
    const auto result = singz::materializeNativePlaybackGraphDocument(document, ctx);
    expectEqual(static_cast<int>(result.error),
                static_cast<int>(singz::NativePlaybackGraphDocumentError::DuplicateNode),
                "a repeated node id is refused");
  }

  {
    singz::NativePlaybackGraphDocument document = healthy;
    document.connections.push_back(document.connections.front());
    const auto result = singz::materializeNativePlaybackGraphDocument(document, ctx);
    expectEqual(static_cast<int>(result.error),
                static_cast<int>(singz::NativePlaybackGraphDocumentError::DuplicateConnection),
                "a repeated connection is refused");
  }

  {
    // A second producer for one input: same destination, different source.
    singz::NativePlaybackGraphDocument document = healthy;
    singz::NativePlaybackGraphConnection extra = document.connections.front();
    for (const auto &candidate : document.connections) {
      if (candidate.from.node != extra.from.node) {
        extra.from = candidate.from;
        break;
      }
    }
    document.connections.push_back(extra);
    const auto result = singz::materializeNativePlaybackGraphDocument(document, ctx);
    expect(result.error == singz::NativePlaybackGraphDocumentError::InvalidConnection ||
               result.error == singz::NativePlaybackGraphDocumentError::DuplicateConnection,
           "a doubly-produced input is refused");
  }

  {
    // A duplicated port on one node.
    singz::NativePlaybackGraphDocument document = healthy;
    for (auto &node : document.nodes) {
      if (node.inputs.size() == 1) {
        node.inputs.push_back(node.inputs.front());
        break;
      }
    }
    const auto result = singz::materializeNativePlaybackGraphDocument(document, ctx);
    expectEqual(static_cast<int>(result.error),
                static_cast<int>(singz::NativePlaybackGraphDocumentError::InvalidPort),
                "a duplicated port id is refused");
  }
}

void meters(const Json &fixture) {
  const std::vector<Json> &admissible = fixture.at("admissibleMeters").array;
  expectEqual(admissible.size(), size_t{4}, "four admissible meters");
  for (const Json &value : admissible) {
    singz::PlaybackCuePlanRequest request;
    request.sampleRate = number(fixture.at("sampleRate"));
    request.durationSeconds = 60.0;
    request.entrySeconds = 0.0;
    request.playbackRate = 1.0;
    request.click = true;
    request.countInBars = 1;
    request.volume = 1.0;
    request.beatGrid.beatsPerBar = u32(value);
    request.beatGrid.downbeat = 0;
    for (int beat = 0; beat < 8; ++beat) {
      request.beatGrid.beats.push_back(static_cast<double>(beat) * 0.5);
    }
    const singz::PlaybackCuePlanResult result = singz::preparePlaybackCuePlan(request);
    expectEqual(static_cast<int>(result.error),
                static_cast<int>(singz::PlaybackCuePlanError::None),
                "meter " + std::to_string(u32(value)) + " is admissible");
  }

  for (uint32_t meter : {1U, 5U, 7U, 8U}) {
    singz::PlaybackCuePlanRequest request;
    request.sampleRate = number(fixture.at("sampleRate"));
    request.durationSeconds = 60.0;
    request.entrySeconds = 0.0;
    request.playbackRate = 1.0;
    request.click = true;
    request.countInBars = 1;
    request.volume = 1.0;
    request.beatGrid.beatsPerBar = meter;
    request.beatGrid.downbeat = 0;
    for (int beat = 0; beat < 8; ++beat) {
      request.beatGrid.beats.push_back(static_cast<double>(beat) * 0.5);
    }
    const singz::PlaybackCuePlanResult result = singz::preparePlaybackCuePlan(request);
    expect(result.error != singz::PlaybackCuePlanError::None,
           "meter " + std::to_string(meter) + " is refused");
  }
}

} // namespace

int main() {
  const Json manifest = readFixture(SINGZ_NATIVE_PLAYBACK_MANIFEST_PATH);
  const Json fixture = readFixture(SINGZ_NATIVE_PLAYBACK_AGREEMENT_PATH);
  expectEqual(u32(manifest.at("version")), 1U, "bridge manifest version");
  expectEqual(u32(fixture.at("version")), 1U, "agreement fixture version");

  errorNameTable(manifest);
  enumSizes(manifest);
  capabilityTag(manifest);
  codecBits(fixture);
  scalarBounds(fixture);
  graphNodeCount(fixture);
  graphDuplicateRejections();
  meters(fixture);

  if (failures == 0) {
    std::puts("native playback contract tests: ok");
  }
  return failures == 0 ? 0 : 1;
}
