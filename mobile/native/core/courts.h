#pragma once
#include <string>
#include <vector>

#include "analysis.h"

// v20 — the octave courts and the meter court
// (src/renderer/src/audio/courts.ts), ported into the core under the same
// rules as the rest: bit-identical to the TypeScript, no stamp moved.
//
// Every constant in the TS was calibrated against library ground truth and
// every guard descends from a measured failure, so this file changes nothing
// and reproduces the arithmetic exactly — including the order it happens in.
//
// A NOTE ON libm. This is the first ported layer that leans on transcendental
// functions for its ANSWERS rather than for a window: cos/sin drive the FFT
// twiddles, log2 assigns each bin its pitch class, and log1p/hypot compress
// the magnitudes a chord label is read off. C++ `std::cos` and V8's
// `Math.cos` are not required by any standard to agree in the last ulp, so
// bit-parity here is an empirical property of the platform's libm and not a
// guarantee the porting rules can enforce. It holds on macOS/arm64, and as of
// 2026-08-22 on the Linux toolchains measured — Ubuntu 24.04 x86_64 (glibc
// 2.39, g++ 13.3, the runner CI pins) and Debian 12 (glibc 2.36, g++ 12.2) on
// x86_64 and aarch64, which CI does not run
// (analysis.cpp's goertzel and Hann window already depend on it and are
// gated), and the parity harness is what would notice it stopping — at the
// VALUE level, where chroma, beat-sync chroma and rms are compared as exact
// doubles, so a single ulp fails them. The chord runs beside them are a
// weaker instrument ON PURPOSE: they compare decisions, so their floor is
// ~1e-2 relative (measured: emissions scaled by 1.001 pass every stem, 1.01
// fails only the stem with short ambiguous runs). They gate the decoder's
// structure and its tie rule; the numbers it decides from are gated above it,
// which is where a mis-ported width or a reassociated sum would show.
//
// Landing in pieces, evidence first. Present so far: the extractor layer, the
// chord decoder, and the voice/form extractors — i.e. everything
// buildCourtEvidence reads. The courts themselves are next.
namespace singz {

/** The neural model's own level, as the doubling court reads it. The TS's
 *  `ev.ml`, null when the model said nothing or said too little. */
struct MlLevel {
  double bpm = 0;
  double uni = 0;
};

/** A chord run on the base lattice: when it starts, how long it holds, and
 *  the label — `buildCourtEvidence`'s `runs`, which is the single input that
 *  decides whether the courts speak at all. */
struct ChordRun {
  double t = 0;
  double sec = 0;
  std::string c;
};

/** Frame RMS and its 95th percentile — the loudness the voice extractor and
 *  the quiet-zone pulse fit are both judged against. */
struct RmsEnvelope {
  std::vector<float> rms;
  double fps = 0;
  double p95 = 0;
};
RmsEnvelope rmsEnvelope(const std::vector<float>& buf);

/** A phrase-final held note or section-final word, from the vocals stem. */
struct VoiceHold {
  double t = 0;
  double gapSec = 0;
};

/** What the courts are allowed to weigh. Assembled by `buildCourtEvidence`
 *  from the same stems the detector already has, at 22.05 kHz — the rate
 *  every threshold in this file was calibrated at. A track with no stems
 *  yields no evidence and the courts abstain rather than guess. */
struct CourtEvidence {
  std::vector<ChordRun> runs;
  std::vector<VoiceHold> voice;
  std::vector<double> seams;              // form-novelty seams (section starts)
  std::vector<std::pair<double, double>> words;  // aligned words: start, end
  // `notes` (polyphonic transcription) is absent by construction — the app
  // has none either, and the TS always passes [].
  /** The TS's `ml`. Present only when the neural lattice ran AND had at
   *  least 32 beats to speak from — `mlLevelStats` decides, and the doubling
   *  court is the only reader. */
  MlLevel ml;
  bool hasMl = false;
};

/** The stems the courts are assembled from — mono at 44.1 kHz, as the rest of
 *  the core carries them. `harm` is the harmonic layer (the TS's aux.inst),
 *  summed; `bass` names chord roots; `vocals` gives holds and seams. */
struct CourtSources {
  // A POINTER, like bass and vocals below. By value this deep-copied every
  // harmonic stem's PCM at the assignment — ~53 MB each on a five-minute song,
  // ~159 MB for other/guitar/piano — on top of the ~105 MB the conversion loop
  // inside already peaks at. beats.h's BeatAux carries this same note after
  // making the same mistake; repeating it two files later is what comments
  // like that exist to prevent.
  const std::vector<AnalysisStem>* harm = nullptr;
  const AnalysisStem* bass = nullptr;
  const AnalysisStem* vocals = nullptr;
  std::vector<std::pair<double, double>> words;
  // NO `ml` HERE, deliberately, and the caller has to know it: the TS's
  // buildCourtEvidence takes the neural lattice among its sources and fills
  // `ev.ml` itself, while this one cannot — the lattice arrives from
  // beat_this, not from audio, so whoever assembles the evidence must call
  // mlLevelStats and set `ev.ml`/`ev.hasMl` by hand (the parity harness does
  // exactly that on both sides). Forget it and doubleCourt — whose only
  // witness IS the model — silently never fires, on a phone, with no parity
  // run able to see it, because both sides would agree on nothing happening.
};

/** The grid the courts are asked to judge, and hand back.
 *
 *  The four trailing members are the TS's OPTIONALS. C++ has no `undefined`,
 *  so each carries its own `has` flag rather than a sentinel value: `downbeat`
 *  0 and `halvedFrom` 0 are both legitimate numbers, and a sentinel would make
 *  "absent" indistinguishable from a grid that genuinely starts on beat 0.
 *  `originalBars` is never persisted — halveGrid keeps it as the ruler the
 *  parity test measures 2/4s against, and the caller strips it. */
struct CourtGrid {
  double bpm = 0;
  int beatsPerBar = 4;
  int downbeat = 0;
  std::vector<double> beats;
  std::vector<int> downbeats;
  bool hasDownbeats = false;
  std::vector<double> originalBars;
  bool hasOriginalBars = false;
  double halvedFrom = 0;
  bool hasHalvedFrom = false;
  double doubledFrom = 0;
  bool hasDoubledFrom = false;
};

/**
 * Everything the courts are allowed to weigh, assembled from the stems the
 * detector already has — `buildCourtEvidence`.
 *
 * The abstention contract lives here rather than in the courts: a track with
 * no harmonic stem yields no chord runs, one with no bass yields none either
 * (the bass names the roots), and `applyCourts` then declines to speak at all
 * on `runs.length < 8`. Missing evidence is silence, never a guess.
 */
CourtEvidence buildCourtEvidence(const CourtGrid& det, const CourtSources& src);

/** 44.1k mono to 22.05k by pair-averaging — the chroma band tops out at
 *  2 kHz, where a 2-tap box is transparent. */
std::vector<float> to22k(const std::vector<float>& x);

/** In-place radix-2 complex FFT, exactly the TS's loop order. */
void fftComplex(std::vector<double>& re, std::vector<double>& im);

/** Log-magnitude chroma per frame over [loHz, hiHz), 4096/1024 at 22.05k. */
std::vector<std::vector<float>> chromaFrames(const std::vector<float>& x, double loHz, double hiHz);

/** Chroma averaged over each beat interval and L2-normalised. */
std::vector<std::vector<float>> beatSyncChroma(const std::vector<std::vector<float>>& chroma,
                                               const std::vector<double>& beats);

/** One Viterbi-decoded chord segment on the beat lattice. */
struct ChordSeg {
  std::string name;
  double t = 0;   // the beat time it starts at
  int len = 0;    // its length in beats
};

/**
 * Beat-synchronous chord labels: 24 maj/min templates on the summed harmonic
 * chroma, the bass chroma naming the root, Viterbi with a stay bonus.
 *
 * This is the function `buildCourtEvidence` turns into `runs` — and `runs` is
 * the single thing that decides whether the courts speak at all
 * (`applyCourts` abstains on `runs.length < 8 && !ev.ml`). Nothing downstream
 * of it matters if this is wrong.
 */
std::vector<ChordSeg> chordRuns(const std::vector<std::vector<float>>& Ch,
                                const std::vector<std::vector<float>>& Cb, const std::vector<double>& beats);

/** `vocalEvidence`'s own output, BEFORE buildCourtEvidence maps it — the court
 *  reads the mapped `VoiceHold` (t + gapSec, rounded), not this. */
struct VoiceHit {
  double t = 0;
  double holdSec = 0;
  double gapSec = 0;
};

/**
 * Phrase-final held notes and section-final words from the vocals stem.
 *
 * Two paths, and which one runs is decided by the caller's data rather than
 * by a flag: with aligned WORDS it grades the silence after each word against
 * the beat; without them it falls back to energy segments and last-rise
 * detection. The word path is the one the app takes, and the one the eval
 * battery calibrated.
 */
std::vector<VoiceHit> vocalEvidence(const RmsEnvelope& env, const std::vector<double>& beats,
                                    const std::vector<std::pair<double, double>>* words);

/**
 * Form-novelty seams — section starts, from a checkerboard novelty kernel over
 * half-bar chroma with the vocal activity fraction appended as two extra
 * dimensions. Peaks above mean+sd that dominate their +/-K neighbourhood.
 */
std::vector<double> formSeams(const std::vector<std::vector<float>>& Ch, const RmsEnvelope& vocalEnv,
                              const std::vector<double>& beats);

/* ---- the courts themselves (courts.ts, ported verbatim) ---------------- */

/** The neural model's own level: bpm from the median raw-lattice interval,
 *  unimodality = the fraction of intervals within 10% of that median.
 *  `ok` false is the TS's null — fewer than 32 beats, or no lattice. */
MlLevel mlLevelStats(const std::vector<double>& mlBeats, bool& ok);

/** The chord decoder flaps on the fine lattice — a change only counts when
 *  the NEW label survives >= minHold. Consecutive same-label runs merge into
 *  ONE chord spanning their whole extent. Exported because the post-halve
 *  head backcast reads it too. */
std::vector<ChordRun> changePoints(const std::vector<ChordRun>& runs, double minHold = 0.9);

/** Bar times from a grid (downbeat indices, or the uniform fallback). */
std::vector<double> barTimes(const CourtGrid& det);

/** Fraction of chord-run starts sitting on bar lines (tol in seconds). */
double chordsOnBars(const std::vector<double>& starts, const std::vector<double>& bars, double tol);

/** What a court decided, and the `dbg` line the TS writes beside it.
 *
 *  The string is the TS's KEYS and ORDER — not its bytes: these carry
 *  `%.17g` doubles where the TS writes a shortest repr (2.8700000000000001
 *  against 2.87), and the harness compares PARSED VALUES, which is why that
 *  passes. Anything that hands this text to a platform JSON parser inherits
 *  the mlGridJson finding: Foundation's is not correctly rounded on 17
 *  significant digits. A binding that surfaces these records should build
 *  them from the core's doubles, the way SingzSplit.mm builds the grid. */
struct CourtVerdict {
  bool fire = false;   // 'halve' for the octave court, 'double' for the other
  std::string dbg;     // JSON object, the TS's dbg.oct / dbg.dbl
};

/** The octave court: three witnesses (harmonic rhythm, windowed parity
 *  concentration, quiet-zone pulse fit); two convict and the grid halves. */
CourtVerdict octaveCourt(const CourtGrid& det, const CourtEvidence& ev);

/** The doubling court. Audio testimony failed here — what separates a true
 *  double is the MODEL's conviction, so this reads `ev.ml` alone. */
CourtVerdict doubleCourt(const CourtGrid& det, const CourtEvidence& ev);

/** Double: midpoints between every pair; bar phase = whichever old-beat
 *  parity the chord changes land on. */
CourtGrid doubleGrid(const CourtGrid& det, const CourtEvidence& ev);

/** Halve: every other beat, the surviving parity being the one the chords
 *  land on; bars re-lay at 4 from the winning phase. */
CourtGrid halveGrid(const CourtGrid& det, const CourtEvidence& ev);

/** One odd bar the meter court placed. */
struct AppliedStep {
  double t = 0;
  int L = 0;
  std::string why;
  double gain = 0;
};

/** What the courts wrote down on their way to a verdict — the TS's `dbg`
 *  object, which the parity harness reads. Not every TS field is here: the
 *  per-candidate `steps` trace is diagnostic only and is left to the TS. */
struct CourtsDbg {
  bool abstained = false;
  /** Did applyCourts hand back something OTHER than its input? The TS's
   *  caller asks this with `courted !== det0` — object identity — which a
   *  by-value C++ return cannot express, and comparing contents is not the
   *  same question: a court that fires and reproduces the grid exactly still
   *  sends the caller through the adoption block (a second sanitizeBars, a
   *  halvedFrom test).
   *
   *  Set wherever the TS CONSTRUCTS A NEW GRID OBJECT — which is not the same
   *  as "wherever a court decided something". meterCourt materializes a
   *  uniform bar array for a grid that arrived without one, purely so its own
   *  tests have bars to measure; no verdict follows, and the caller still
   *  adopts the result, because the object it got back is not the one it
   *  passed in. Two library songs ship their bar lines that way. */
  bool changed = false;
  std::string oct;   // dbg.oct, verbatim JSON (empty when the court did not run)
  std::string dbl;   // dbg.dbl
  int cands = 0;
  bool halfBar = false;
  std::string cadenceCensus;  // dbg.cadenceCensus, insertion order
  std::string plan;           // dbg.plan on a halved grid, else empty
  std::vector<AppliedStep> applied;
};

/**
 * Run the courts over a detected grid — the TS's `applyCourts`, the entry
 * point the app calls and the one the parity harness gates.
 *
 * Returns the input UNCHANGED when abstaining: fewer than 8 chord runs and
 * no ml level is "no evidence, no opinion", and a stems-less track must pass
 * through without even a materialized downbeats array.
 */
CourtGrid applyCourts(const CourtGrid& det, const CourtEvidence& ev, CourtsDbg& dbg);

}  // namespace singz
