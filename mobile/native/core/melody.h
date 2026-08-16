#pragma once
#include <cstddef>
#include <vector>

#include "progress.h"

// The melody tracker — the desktop's pyin.ts + pitch.ts (cmndProfile) +
// pitch-core.ts (decimate, frame-RMS, cleanMelody), ported line for line so
// that ONE implementation serves the desktop (through the singz-analyze CLI)
// and both phones (linked in-process). The bar is the desktop's own output:
// bit-identical f0 on the eval corpus, PITCH_DETECT_VERSION untouched.
//
// Bit-identity is not automatic in a port. The TS keeps its working state in
// Float32Arrays and its arithmetic in doubles, so every store into one of
// those arrays rounds to float32 while every intermediate is double — d[],
// cmnd[], probs[] (which ACCUMULATES in float32), em[], binHz[], the
// transition weights, the decimated signal, rms[], cents[] and f0 itself.
// This port keeps float where the TS kept Float32Array and double where it
// kept numbers, and sums in the same order. What can still differ is the
// last ulp of libm's log/log2/exp/pow against V8's or Hermes' own — mostly
// absorbed by the float32 stores; the corpus gate says whether it ever
// surfaces.
namespace singz {

struct MelodyTrack {
  std::vector<float> f0;   // cleaned line, Hz per hop, 0 = unvoiced
  std::vector<float> raw;  // pYIN's own path before the cleaner (diagnostics)
  std::vector<float> rms;  // per-frame RMS of the decimated vocals
  double hopSec = 0;
};

// The stamp of the tracker this file reproduces — pitch-core.ts's own
// PITCH_DETECT_VERSION. A port that changes any output must move it, and the
// TS constant with it; the parity harness (tests/native + eval) holds both.
constexpr int kPitchDetectVersion = 1;

// Track `mono` (float32 samples at `sampleRate`) — trackMelodyCore's whole
// body: 3x average-pooling decimation, pYIN over 1024-sample frames at a
// 25 ms hop, frame RMS, the cleaner. `progress` (may be null) hears
// "melody" with 0..1 every ~250 frames and can cancel; a cancelled run
// returns an empty track.
MelodyTrack trackMelody(const float* mono, size_t n, double sampleRate,
                        const Progress* progress = nullptr);

}  // namespace singz
