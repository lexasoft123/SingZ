#pragma once
#include <cstddef>
#include <vector>

// The desktop's song analysis (src/renderer/src/audio/analysis.ts), ported
// line for line into the core so ONE implementation serves the desktop and
// both phones — the same contract melody.{h,cpp} already meets, and the same
// bit-parity bar: identical output to the TypeScript on the eval corpus, with
// no detector stamp moved.
//
// This header carries the pieces as they land. First in: the key.
namespace singz {

// A stem as the detectors want it — mono at 44.1 kHz. The TS gets there via
// `monoAt44k(AudioBuffer)`; on this side the caller has already read and
// folded a file (wav.h) and states the rate it came at.
struct AnalysisStem {
  std::vector<float> mono;
  double sampleRate = 44100;
};

struct KeyGuess {
  int pc = 0;        // 0 = C … 11 = B
  bool minor = false;
  bool ok = false;   // false = "no answer" (the TS returns null)
};

/**
 * The stamp of the key detector this file reproduces — analysis.ts's own
 * KEY_DETECT_VERSION. A port that changes any answer must move both.
 */
constexpr int kKeyDetectVersion = 2;

/**
 * Key from the harmonic stems, decoded through chords rather than read off a
 * chroma histogram (the TS comment explains why: raw chroma + Krumhansl
 * collapses on power-chord material). `inst` are the instrument stems summed
 * as the chord layer; `bass` names roots and may be absent. Not ok when the
 * stems are effectively silent — the caller then falls back to the melody
 * histogram for DISPLAY, and must not store that under this stamp.
 */
KeyGuess estimateKeyFromStems(const std::vector<AnalysisStem>& inst, const AnalysisStem* bass);

/**
 * Key from the vocal melody's pitch-class histogram (Krumhansl-Schmuckler) —
 * the answer of last resort, for a project whose stems went missing. Not ok
 * below 100 voiced frames.
 */
KeyGuess estimateKey(const float* f0, size_t n);

}  // namespace singz
