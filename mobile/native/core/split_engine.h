#pragma once
#include <cstdint>
#include <string>

#include "progress.h"

// The demucs-onnx driver, file to file (docs/PHONE-STANDALONE.md): input is
// the raw interleaved f32 STEREO mix the platform decoder wrote (any rate —
// the engine resamples to the graph's 44.1 kHz itself); output is six
// <stem>.wav.part files in jobDir, streamed as segments finalize, plus a
// persisted overlap tail so a killed job resumes at its last segment. The
// caller (the :split service / the iOS job runner) owns job.json, renames
// the .part files after an ok, and enforces the chunk-pace watchdog.
namespace singz {

struct SplitJobConfig {
  std::string modelPath;   // htdemucs_6s_fp16weights.onnx
  std::string mixPcmPath;  // raw interleaved f32 stereo at srcRate
  std::string jobDir;      // mix44.raw, tail.bin, <stem>.wav.part land here
  int srcRate = 44100;
  int intraOpThreads = 0;  // 0 = ORT default (big cores)
  // Resume HINT: >0 asks the engine to attempt a resume. The actual
  // continue point comes from tail.bin alone (the engine persists the tail
  // before the caller can record its own index, so job.json can be one
  // chunk behind after a kill — it is never trusted for arithmetic).
  int64_t resumeChunk = 0;
  // Fired after every finished chunk with (done, total) — the caller
  // persists `done` into job.json as the next resume point and feeds its
  // watchdog. Separate from Progress.report so the fraction stays cheap.
  void (*onChunkDone)(void* user, int64_t done, int64_t total) = nullptr;
  void* onChunkUser = nullptr;
};

enum class SplitResult { ok, cancelled, failed };

SplitResult runSplit(const SplitJobConfig& config, Progress& progress,
                     std::string& errorOut);

}  // namespace singz
