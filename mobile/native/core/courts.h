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
// gated), and the parity harness is what would notice it stopping — which is
// the reason the harness compares chord runs and not merely verdicts.
//
// Landing in pieces, evidence first. Present so far: the extractor layer.
namespace singz {

/** A chord run on the base lattice: when it starts, how long it holds, and
 *  the label — `buildCourtEvidence`'s `runs`, which is the single input that
 *  decides whether the courts speak at all. */
struct ChordRun {
  double t = 0;
  double sec = 0;
  std::string c;
};

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

/** Frame RMS and its 95th percentile — the loudness the voice extractor and
 *  the quiet-zone pulse fit are both judged against. */
struct RmsEnvelope {
  std::vector<float> rms;
  double fps = 0;
  double p95 = 0;
};
RmsEnvelope rmsEnvelope(const std::vector<float>& buf);

}  // namespace singz
