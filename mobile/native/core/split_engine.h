#pragma once
#include <string>

#include "progress.h"

// Phase-2 contract (docs/PHONE-STANDALONE.md): the demucs-onnx driver, file
// to file. Input is the temp 44.1 kHz stereo PCM mix the platform decoder
// wrote (the desktop `needsPcm` contract, natively); output is six
// stems/<name>.wav.part streamed as segments finalize, plus a persisted
// overlap tail + job.json{segIndex} so a killed job resumes at its last
// segment. Implementation lands with Phase 2 — this header exists so both
// bindings compile against the settled API from the start.
namespace singz {

struct SplitJobConfig {
  std::string modelPath;   // htdemucs_6s_fp16weights.onnx
  std::string mixPcmPath;  // interleaved f32 stereo @44.1k, raw
  std::string jobDir;      // job.json, tail.bin, stem .part files
  std::string outDir;      // final stems/ destination
  int intraOpThreads = 0;  // 0 = ORT default (big cores)
};

enum class SplitResult { ok, cancelled, failed };

SplitResult runSplit(const SplitJobConfig& config, Progress& progress,
                     std::string& errorOut);

}  // namespace singz
