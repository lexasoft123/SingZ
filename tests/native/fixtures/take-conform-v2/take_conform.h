// Frozen committed 4aec2c9 oracle: test-only version-2 PCM golden comparison.
#pragma once

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

namespace singz_v2_reference {
// Offline only. Coordinates are at the raw take rate, including projectFrame.
// Neither current transport tempo nor current song transposition is an input.
inline constexpr const char *kTakeConformVersion = "take-conform-2";
// Admission covers retained raw PCM, placed PCM, backend and converter scratch.
inline constexpr uint64_t kTakeConformMaximumResidentBytes = 128u * 1024u * 1024u;
struct TakeConformAnchor { uint64_t takeFrame; double projectFrame; };
struct TakeConformSetting { uint64_t takeFrame; double transposeSemitones; };
struct TakeConformEffect {
  std::string id{"pitch-follow"};
  bool enabled{true};
  double manualOffsetSemitones{0};
  // Signalsmith 1.3.2 supports formant compensation in this offline path.
  bool preserveFormants{false};
};
struct TakeConformRequest {
  std::vector<TakeConformAnchor> anchors;
  std::vector<TakeConformSetting> settings;
  std::vector<TakeConformEffect> effects;
  uint64_t songDurationProjectFrames{0}; // at outputRate
  double startPositionSec{0}, userOffsetSec{0};
  uint32_t outputRate{48000};
};
struct TakeConformPcm { uint32_t sampleRate{0}; std::vector<int16_t> samples; };
struct TakeConformResult {
  TakeConformPcm pcm;
  uint32_t inputLatencyFrames{0}, outputLatencyFrames{0};
  // Diagnostics/admission receipt, not a retained copy of intermediate PCM.
  uint32_t signalsmithPasses{0};
  uint64_t processedBlocks{0}, estimatedPeakBytes{0};
};
// Throws on malformed WAV/map, cancellation, or admission limits. Fixed seed,
// block schedule and quantisation give bit-identical output on the same build.
TakeConformResult conformTakePcm(const TakeConformPcm &, const TakeConformRequest &,
                                const std::atomic<bool> *cancel = nullptr);
TakeConformPcm readTakeConformWav(const std::string &path);
void writeTakeConformWav(const std::string &path, const TakeConformPcm &);
} // namespace singz
