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

/**
 * A stem at the detectors' own rate: all channels already folded (wav.h), the
 * sample rate converted to 44.1 kHz by linear interpolation — analysis.ts's
 * `monoAt44k`, minus the channel half it no longer needs. Shared rather than
 * re-rolled per detector: beats.cpp wants exactly this and the ordering and
 * bounds discipline should travel with it, not be repeated.
 */
std::vector<float> monoAt44kPublic(const AnalysisStem& stem);

/**
 * analysis.ts's `goertzel` — one bin's energy over [start,end), decimated by
 * 4. Shared for the same reason monoAt44k is: the key detector and the beat
 * detector's chord-change cue read chroma the same way, and a second copy is
 * a second thing to keep bit-identical.
 */
double goertzelPublic(const std::vector<float>& data, size_t start, size_t end, double freq, double sr);

/**
 * How long `monoAt44kPublic` will make a stem, without materializing it —
 * so a caller summing several stems can size the accumulator up front and
 * then convert-add-drop one at a time instead of holding them all.
 */
size_t resampledLengthPublic(const AnalysisStem& stem);

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
