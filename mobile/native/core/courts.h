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
// guarantee the porting rules can enforce. It holds on macOS/arm64 today
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
  // `ml` is absent because the ML lattice is not ported; the TS's null.
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
};

/** The grid the courts are asked to judge. */
struct CourtGrid {
  double bpm = 0;
  int beatsPerBar = 4;
  int downbeat = 0;
  std::vector<double> beats;
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



}  // namespace singz
