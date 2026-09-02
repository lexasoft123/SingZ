#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace singz {

inline constexpr size_t kPlaybackCueMaximumBeats = 20000;
inline constexpr size_t kPlaybackCueMaximumEvents = 40000;
inline constexpr double kPlaybackCueMaximumDurationSeconds = 12.0 * 60.0 * 60.0;

// Bridge-independent, already-sanitized beat document. Beat positions are
// authoritative seconds in the original song timeline. Explicit downbeats,
// when present, are beat indexes and define the local meter exactly.
struct PlaybackCueBeatGrid {
  std::vector<double> beats;
  uint32_t beatsPerBar{4};
  uint32_t downbeat{0};
  std::vector<uint32_t> downbeats;
};

struct PlaybackCuePlanRequest {
  // An empty beat array selects the legacy gridless count-in behavior.
  PlaybackCueBeatGrid beatGrid;
  bool click{false};
  uint32_t countInBars{0};
  double volume{0.7};
  bool accent{true};
  double entrySeconds{0.0};
  double durationSeconds{0.0};
  double sampleRate{0.0};
  double playbackRate{1.0};
};

enum class PlaybackCueSound : uint8_t {
  Ordinary = 0,
  Accent = 1,
};

struct PlaybackCueEvent {
  // Signed output/project frame relative to song entry. Count-in cues are
  // negative. A frame-zero cue coincides with the first selected song frame.
  int64_t projectFrame{0};
  PlaybackCueSound sound{PlaybackCueSound::Ordinary};
};

// Prepared, owning control-domain result. Sessions publish this object as
// shared_ptr<const PlaybackCuePlan>; callback code only observes immutable
// frame positions and PCM storage.
struct PlaybackCuePlan {
  PlaybackCueBeatGrid beatGrid;
  bool click{false};
  uint32_t countInBars{0};
  // PCM below is the canonical unscaled legacy Float32 waveform. Apply this
  // scalar separately in ReferenceGain, just as Web Audio materializes the
  // buffer before its GainNode sees metronome volume.
  float volume{0.0F};
  bool accent{false};
  double sampleRate{0.0};
  double playbackRate{1.0};
  int64_t sourceStartFrame{0};
  int64_t songDurationFrames{0};
  int64_t preRollFrames{0};
  uint32_t countInEventCount{0};
  uint32_t countInBeatsPerBar{0};
  std::vector<PlaybackCueEvent> events;
  std::vector<float> ordinaryClickPcm;
  std::vector<float> accentClickPcm;
};

enum class PlaybackCuePlanError : uint32_t {
  None = 0,
  InvalidConfiguration,
  LimitExceeded,
  ResourceExhausted,
};

struct PlaybackCuePlanResult {
  PlaybackCuePlanError error{PlaybackCuePlanError::InvalidConfiguration};
  std::shared_ptr<const PlaybackCuePlan> plan;
  std::string message;

  [[nodiscard]] bool ok() const noexcept {
    return error == PlaybackCuePlanError::None && plan != nullptr;
  }
};

[[nodiscard]] PlaybackCuePlanResult
preparePlaybackCuePlan(const PlaybackCuePlanRequest &request) noexcept;

} // namespace singz
