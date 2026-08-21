#pragma once
#include <cstdint>
#include <string>

#include "wav.h"

// FLAC in and out for the core, on the vendored libFLAC
// (mobile/native/third_party/flac — provenance and the licence boundary are
// in its README). Phase 5 of docs/PHONE-STANDALONE.md.
//
// Nothing outside wav.cpp should need readFlac* directly: readWavMono and
// readWavInfo dispatch on the file's MAGIC BYTES (a stem is named by its id,
// and a FLAC named .wav answers plausibly and wrongly if the suffix is
// trusted), so every detector, the ML mix, the CLI and both bindings gained
// FLAC the moment the dispatch landed. These are exposed for wav.cpp and for
// the host tests, which want to hit the FLAC path by name.
namespace singz {

// Decoded to mono float32 with the SAME fold as the WAV reader — per frame,
// per channel, acc = float(acc + v/channels) with v scaled by 2^(bps-1) —
// because grid parity rests on the fold, not just on losslessness.
MonoWav readFlacMono(const std::string& path);

// STREAMINFO only: rate, channels, total frames. No samples read.
WavInfo readFlacInfo(const std::string& path);

// One stem of the v1->v2 upgrade, idempotent and crash-safe, shared by both
// bindings so the two platforms cannot drift:
//
//   flac exists           -> delete the wav if present, done (a re-run after
//                            a kill between rename and unlink heals itself;
//                            a completed .flac is trustworthy because .part
//                            is never renamed unless the encoder FINISHED
//                            with verify on)
//   wav exists            -> encode to <flac>.part (level 5, verify on — the
//                            encoder decodes its own output as it writes and
//                            fails the finish on any mismatch), rename to
//                            <flac>, delete the wav
//   neither               -> error
//
// A kill at any instant leaves the wav, or a verified flac, or both — never
// a doc-visible file that is wrong. Readers never see .part: both platforms
// probe stems/<id>.flac then stems/<id>.wav by exact name.
//
// Only canonical 16-bit PCM WAV is accepted (what the split writes and what
// the desktop's converter accepts — src/main/flac.ts rejects the same way).
struct CompactResult {
  bool ok = false;
  bool skipped = false;   // flac was already there; nothing was encoded
  int64_t bytes = 0;      // size of the flac on disk
  std::string error;
};

CompactResult compactStem(const std::string& wavPath, const std::string& flacPath);

}  // namespace singz
