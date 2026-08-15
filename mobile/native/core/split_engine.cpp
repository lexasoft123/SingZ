#include "split_engine.h"

#include <algorithm>
#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <memory>
#include <vector>

#include <onnxruntime_cxx_api.h>
#if defined(__APPLE__)
#include <coreml_provider_factory.h>
#endif

#include "resample.h"
#include "wav.h"

// Faithful C++ port of demucs_onnx 0.3.4's _chunked_separate_single (the
// exact driver the desktop ONNX packs run; its source ships in the packs):
// fixed (1, 2, 343980) graph input, quarter-segment stride, triangular
// transition window, accumulate stems * w and weight += w, divide by
// max(weight, 1e-8) at the end. Normalization lives INSIDE the exported
// graph — raw chunks in, stems out. No shifts (not implemented upstream in
// the ONNX path either).
//
// Two things the python driver does not do, added for the phone:
//  - STREAMING commit: once chunk i+1 can no longer touch a sample, that
//    sample's weighted sum is final — it is divided and appended to the six
//    .part WAVs, so full-song stem buffers never exist in RAM (<25 MB here;
//    the ORT session dominates).
//  - RESUME: the not-yet-final accumulator tail + the next chunk index are
//    persisted after every chunk (tail.bin + the caller's job.json), so a
//    killed job continues at its last segment instead of restarting a
//    multi-minute split.
namespace singz {
namespace {

constexpr int kSampleRate = 44100;
constexpr int kChannels = 2;
constexpr int64_t kSegment = 343980;            // 7.8 s — baked into the graph
constexpr int64_t kOverlap = kSegment / 4;      // 85,995
constexpr int64_t kStride = kSegment - kOverlap;
constexpr int kStems = 6;
const char* const kStemNames[kStems] = {"drums", "bass",   "other",
                                        "vocals", "guitar", "piano"};

struct Tail {
  // Accumulators for the region [committed, committed + len): weighted stem
  // sums (stems x channels x len, stem-major) and the shared weight lane.
  int64_t start = 0;  // absolute sample index of tail[0]
  int64_t len = 0;
  std::vector<float> acc;     // kStems * kChannels * len
  std::vector<float> weight;  // len
};

bool writeTail(const std::string& path, const Tail& t) {
  const std::string tmp = path + ".part";
  std::FILE* f = std::fopen(tmp.c_str(), "wb");
  if (f == nullptr) return false;
  bool ok = std::fwrite(&t.start, sizeof(t.start), 1, f) == 1 &&
            std::fwrite(&t.len, sizeof(t.len), 1, f) == 1 &&
            (t.acc.empty() ||
             std::fwrite(t.acc.data(), sizeof(float), t.acc.size(), f) == t.acc.size()) &&
            (t.weight.empty() ||
             std::fwrite(t.weight.data(), sizeof(float), t.weight.size(), f) ==
                 t.weight.size());
  ok = (std::fclose(f) == 0) && ok;
  if (!ok) return false;
  std::remove(path.c_str());
  return std::rename(tmp.c_str(), path.c_str()) == 0;
}

bool readTail(const std::string& path, Tail& t) {
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (f == nullptr) return false;
  bool ok = std::fread(&t.start, sizeof(t.start), 1, f) == 1 &&
            std::fread(&t.len, sizeof(t.len), 1, f) == 1 && t.len >= 0 &&
            t.len <= kSegment;
  if (ok) {
    t.acc.resize(static_cast<size_t>(kStems * kChannels * t.len));
    t.weight.resize(static_cast<size_t>(t.len));
    ok = (t.acc.empty() ||
          std::fread(t.acc.data(), sizeof(float), t.acc.size(), f) == t.acc.size()) &&
         (t.weight.empty() ||
          std::fread(t.weight.data(), sizeof(float), t.weight.size(), f) ==
              t.weight.size());
  }
  std::fclose(f);
  return ok;
}

// Triangular fade window, exactly _make_transition_window(343980, 0.25):
// linspace(0,1,transition) up, ones, the same ramp reversed down.
std::vector<float> transitionWindow() {
  const int64_t transition = static_cast<int64_t>(kSegment * 0.25);
  std::vector<float> w(static_cast<size_t>(kSegment), 1.0f);
  for (int64_t i = 0; i < transition; i++) {
    const float v = static_cast<float>(i) / static_cast<float>(transition - 1);
    w[static_cast<size_t>(i)] = v;
    w[static_cast<size_t>(kSegment - 1 - i)] = v;
  }
  return w;
}

}  // namespace

SplitResult runSplit(const SplitJobConfig& config, Progress& progress,
                     std::string& errorOut) {
  // ---- source mix: raw interleaved f32 stereo at config.srcRate ----
  std::FILE* src = std::fopen(config.mixPcmPath.c_str(), "rb");
  if (src == nullptr) {
    errorOut = "cannot open the decoded mix";
    return SplitResult::failed;
  }
  fseeko(src, 0, SEEK_END);
  const int64_t srcBytes = ftello(src);
  fseeko(src, 0, SEEK_SET);
  const int64_t srcFrames = srcBytes / (sizeof(float) * kChannels);
  if (srcFrames <= 0) {
    std::fclose(src);
    errorOut = "the decoded mix is empty";
    return SplitResult::failed;
  }

  // ---- pass 1: resample to a 44.1k temp file (or use the source as-is) ----
  progress.report("resample", 0.0f);
  std::string mix44Path = config.mixPcmPath;
  int64_t totalLen = srcFrames;
  if (config.srcRate != kSampleRate) {
    mix44Path = config.jobDir + "/mix44.raw";
    std::FILE* probe = std::fopen(mix44Path.c_str(), "rb");
    if (probe != nullptr) {
      // resume: the 44.1k mix survived the kill — reuse it
      fseeko(probe, 0, SEEK_END);
      totalLen = ftello(probe) / (sizeof(float) * kChannels);
      std::fclose(probe);
    } else {
      const std::string tmp = mix44Path + ".part";
      std::FILE* dst = std::fopen(tmp.c_str(), "wb");
      if (dst == nullptr) {
        std::fclose(src);
        errorOut = "cannot write the 44.1k mix";
        return SplitResult::failed;
      }
      Resampler rs(config.srcRate, kSampleRate, kChannels);
      std::vector<float> in(static_cast<size_t>(1 << 16));
      std::vector<float> out;
      int64_t done = 0;
      bool ok = true;
      for (;;) {
        const size_t nRead = std::fread(in.data(), sizeof(float), in.size(), src);
        if (nRead == 0) break;
        out.clear();
        rs.process(in.data(), static_cast<int64_t>(nRead) / kChannels, out);
        if (!out.empty() &&
            std::fwrite(out.data(), sizeof(float), out.size(), dst) != out.size()) {
          ok = false;
          break;
        }
        done += static_cast<int64_t>(nRead) / kChannels;
        progress.report("resample", static_cast<float>(done) / srcFrames);
        if (progress.cancelled()) {
          ok = false;
          break;
        }
      }
      if (ok) {
        out.clear();
        rs.flush(out);
        ok = out.empty() ||
             std::fwrite(out.data(), sizeof(float), out.size(), dst) == out.size();
      }
      fseeko(dst, 0, SEEK_END);
      totalLen = ftello(dst) / (sizeof(float) * kChannels);
      ok = (std::fclose(dst) == 0) && ok;
      if (!ok || progress.cancelled()) {
        std::remove(tmp.c_str());
        std::fclose(src);
        errorOut = progress.cancelled() ? "" : "resampling the mix failed";
        return progress.cancelled() ? SplitResult::cancelled : SplitResult::failed;
      }
      std::remove(mix44Path.c_str());
      if (std::rename(tmp.c_str(), mix44Path.c_str()) != 0) {
        std::fclose(src);
        errorOut = "cannot finish the 44.1k mix";
        return SplitResult::failed;
      }
    }
  }
  std::fclose(src);

  std::FILE* mix = std::fopen(mix44Path.c_str(), "rb");
  if (mix == nullptr) {
    errorOut = "cannot open the 44.1k mix";
    return SplitResult::failed;
  }

  const int64_t nChunks = std::max<int64_t>(1, (totalLen + kStride - 1) / kStride);

  // ---- resume state ----
  // The TAIL is the authority on where to continue, never the caller's
  // job.json: the engine persists the tail BEFORE the caller can record the
  // chunk index, so a kill in that gap leaves job.json one behind — trusting
  // it would replay a chunk into accumulators that no longer cover it
  // (negative offsets, wild writes). tail.start is committed samples, always
  // a whole number of strides; anything else is a corrupt tail → fresh run.
  const std::string tailPath = config.jobDir + "/tail.bin";
  Tail tail;
  int64_t startChunk = 0;
  int64_t committed = 0;
  if (config.resumeChunk > 0 && readTail(tailPath, tail) && tail.start >= 0 &&
      tail.start <= totalLen && tail.start % kStride == 0) {
    committed = tail.start;
    startChunk = tail.start / kStride;
  } else {
    tail = Tail{};
  }

  // ---- stem writers (append when resuming; committed samples are theirs) ----
  std::vector<std::unique_ptr<WavWriter>> writers;
  for (int s = 0; s < kStems; s++) {
    auto w = std::make_unique<WavWriter>();
    const std::string path =
        config.jobDir + "/" + kStemNames[s] + ".wav.part";
    bool ok = startChunk > 0 ? w->open(path, kSampleRate, kChannels, committed)
                             : w->open(path, kSampleRate, kChannels);
    if (!ok && startChunk > 0) {
      // a stem shorter than the tail claims = the kill outran stdio (or the
      // .part vanished) — the tail cannot be honored, restart cleanly
      startChunk = 0;
      committed = 0;
      tail = Tail{};
      for (auto& earlier : writers) {
        earlier->open(config.jobDir + "/" + kStemNames[&earlier - writers.data()] +
                          ".wav.part",
                      kSampleRate, kChannels);
      }
      ok = w->open(path, kSampleRate, kChannels);
    }
    if (!ok) {
      std::fclose(mix);
      errorOut = std::string("cannot write ") + kStemNames[s];
      return SplitResult::failed;
    }
    writers.push_back(std::move(w));
  }

  // ---- ORT session ----
  progress.report("load-model", 0.0f);
  std::unique_ptr<Ort::Env> env;
  std::unique_ptr<Ort::Session> session;
  try {
    env = std::make_unique<Ort::Env>(ORT_LOGGING_LEVEL_ERROR, "singz-split");
    Ort::SessionOptions opts;
    // ORT's load-time graph rewrites kill the app outright on a real iPhone
    // (measured: two seconds into load-model, 76 MB used with 3.3 GB free, so
    // not memory; identical on every attempt, never once on the simulator).
    // With them off the same model loads in two seconds and splits a 5-minute
    // song in 5m30s at a 1265 MB peak, and the stems still reconstruct the
    // source at corr 0.9993 — the rewrites are fusions, not semantics.
    opts.SetGraphOptimizationLevel(config.disableGraphOpt
                                       ? GraphOptimizationLevel::ORT_DISABLE_ALL
                                       : GraphOptimizationLevel::ORT_ENABLE_ALL);
    if (config.intraOpThreads > 0) opts.SetIntraOpNumThreads(config.intraOpThreads);
    // The arena never hands memory back and the memory pattern pre-reserves
    // the union of every activation. Dropping both trades malloc traffic for
    // a lower peak — measured on iOS, where the device now runs at 700-900 MB
    // steady. NOT on by default: Android's numbers were taken with the arena.
    if (config.leanAllocator) {
      opts.DisableCpuMemArena();
      opts.DisableMemPattern();
    }
#if defined(__APPLE__)
    if (config.coreMlEp) {
      // MLProgram is the format that carries fp16 and the wider op set, which
      // is what makes the neural engine reachable at all — the older NeuralNetwork
      // path would silently land back on CPU.
      try {
        Ort::SessionOptions coreml = opts.Clone();
        Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_CoreML(
            coreml, COREML_FLAG_CREATE_MLPROGRAM));
        session = std::make_unique<Ort::Session>(*env, config.modelPath.c_str(), coreml);
        progress.report("coreml", 0.0f);
      } catch (const std::exception& e) {
        // Partition refused, compile failed, unsupported OS — none of it is
        // fatal, the CPU path below is the same one that shipped. Reported as
        // a stage, never through errorOut: this run is not failing. The
        // MESSAGE rides along, because the first field run of this path threw
        // away the one thing worth knowing — why.
        session.reset();
        // The reason is worth keeping, but it reaches ObjC as a dictionary
        // value and JS as a log line: ORT statuses carry node lists and
        // newlines, and stringWithUTF8String: returns nil on non-UTF-8 bytes,
        // which would raise inside the event literal. One line, ASCII, capped.
        std::string why = e.what() != nullptr ? e.what() : "";
        for (char& ch : why) {
          const unsigned char u = static_cast<unsigned char>(ch);
          if (u < 0x20 || u > 0x7e) ch = ' ';
        }
        if (why.size() > 160) why.resize(160);
        progress.report(("coreml-unavailable: " + why).c_str(), 0.0f);
      }
    }
#endif
    if (!session) session = std::make_unique<Ort::Session>(*env, config.modelPath.c_str(), opts);
  } catch (const std::exception& e) {
    std::fclose(mix);
    errorOut = std::string("the split model did not load: ") + e.what();
    return SplitResult::failed;
  }

  const std::vector<float> window = transitionWindow();
  std::vector<float> chunkIn(static_cast<size_t>(kChannels * kSegment));
  std::vector<float> planar(static_cast<size_t>(kChannels * kSegment));
  Ort::MemoryInfo mem = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
  const int64_t inShape[3] = {1, kChannels, kSegment};
  const char* inNames[] = {"mix"};
  const char* outNames[] = {"stems"};

  // Accumulators spanning [accStart, accEnd): fixed capacity (a chunk can
  // reach at most one stride past the previous committable point), committed
  // prefix flushed to the writers and the window slid forward.
  std::vector<float> acc;     // (stems, channels, cap), lane-planar
  std::vector<float> weight;  // cap
  int64_t accStart = committed;
  const int64_t cap = kSegment + kStride;
  {
    std::vector<float> fixedAcc(static_cast<size_t>(kStems * kChannels * cap), 0.0f);
    std::vector<float> fixedW(static_cast<size_t>(cap), 0.0f);
    for (int64_t i = 0; i < tail.len; i++) {
      fixedW[static_cast<size_t>(i)] = tail.weight[static_cast<size_t>(i)];
      for (int s = 0; s < kStems; s++) {
        for (int c = 0; c < kChannels; c++) {
          const size_t from =
              static_cast<size_t>((s * kChannels + c) * tail.len + i);
          const size_t to = static_cast<size_t>((s * kChannels + c) * cap + i);
          fixedAcc[to] = tail.acc[from];
        }
      }
    }
    acc = std::move(fixedAcc);
    weight = std::move(fixedW);
  }
  int64_t accEnd = accStart + tail.len;  // exclusive high-water of accumulated data

  auto commitUpTo = [&](int64_t upTo) -> bool {
    // divide + interleave + append [accStart, upTo), then slide the window
    if (upTo <= accStart) return true;
    const int64_t n = upTo - accStart;
    std::vector<float> inter(static_cast<size_t>(n * kChannels));
    for (int s = 0; s < kStems; s++) {
      for (int64_t i = 0; i < n; i++) {
        const float w = std::max(weight[static_cast<size_t>(i)], 1e-8f);
        for (int c = 0; c < kChannels; c++) {
          inter[static_cast<size_t>(i * kChannels + c)] =
              acc[static_cast<size_t>((s * kChannels + c) * cap + i)] / w;
        }
      }
      if (!writers[static_cast<size_t>(s)]->append(inter.data(), n)) return false;
    }
    // slide: move [n, accEnd-accStart) to the front, zero the vacated tail
    const int64_t remain = accEnd - upTo;
    for (int s = 0; s < kStems; s++) {
      for (int c = 0; c < kChannels; c++) {
        float* lane = acc.data() + static_cast<size_t>((s * kChannels + c) * cap);
        std::memmove(lane, lane + n, static_cast<size_t>(remain) * sizeof(float));
        std::memset(lane + remain, 0, static_cast<size_t>(cap - remain) * sizeof(float));
      }
    }
    std::memmove(weight.data(), weight.data() + n,
                 static_cast<size_t>(remain) * sizeof(float));
    std::memset(weight.data() + remain, 0,
                static_cast<size_t>(cap - remain) * sizeof(float));
    accStart = upTo;
    return true;
  };

  auto persistTail = [&](int64_t nextChunk) -> bool {
    // stem bytes must be kernel-durable BEFORE the tail claims them
    for (auto& w : writers) {
      if (!w->flush()) return false;
    }
    Tail t;
    t.start = accStart;
    t.len = accEnd - accStart;
    t.acc.resize(static_cast<size_t>(kStems * kChannels * t.len));
    t.weight.resize(static_cast<size_t>(t.len));
    for (int64_t i = 0; i < t.len; i++) {
      t.weight[static_cast<size_t>(i)] = weight[static_cast<size_t>(i)];
      for (int s = 0; s < kStems; s++) {
        for (int c = 0; c < kChannels; c++) {
          t.acc[static_cast<size_t>((s * kChannels + c) * t.len + i)] =
              acc[static_cast<size_t>((s * kChannels + c) * cap + i)];
        }
      }
    }
    (void)nextChunk;  // recorded by the caller in job.json
    return writeTail(tailPath, t);
  };

  for (int64_t i = startChunk; i < nChunks; i++) {
    if (progress.cancelled()) {
      std::fclose(mix);
      errorOut = "";
      return SplitResult::cancelled;
    }
    const int64_t start = i * kStride;
    const int64_t end = std::min(start + kSegment, totalLen);
    const int64_t chunkLen = end - start;

    // read interleaved [start, end), zero-pad to the fixed segment
    if (fseeko(mix, start * kChannels * sizeof(float), SEEK_SET) != 0) {
      std::fclose(mix);
      errorOut = "mix seek failed";
      return SplitResult::failed;
    }
    const size_t want = static_cast<size_t>(chunkLen * kChannels);
    if (std::fread(chunkIn.data(), sizeof(float), want, mix) != want) {
      std::fclose(mix);
      errorOut = "mix read failed";
      return SplitResult::failed;
    }
    std::fill(chunkIn.begin() + static_cast<int64_t>(want), chunkIn.end(), 0.0f);

    // interleaved -> planar (1, 2, segment)
    for (int64_t t = 0; t < kSegment; t++) {
      for (int c = 0; c < kChannels; c++) {
        planar[static_cast<size_t>(c * kSegment + t)] =
            t < chunkLen ? chunkIn[static_cast<size_t>(t * kChannels + c)] : 0.0f;
      }
    }

    std::vector<Ort::Value> outputs;
    try {
      Ort::Value input = Ort::Value::CreateTensor<float>(
          mem, planar.data(), planar.size(), inShape, 3);
      outputs = session->Run(Ort::RunOptions{nullptr}, inNames, &input, 1,
                             outNames, 1);
    } catch (const std::exception& e) {
      std::fclose(mix);
      errorOut = std::string("the split model failed on a segment: ") + e.what();
      return SplitResult::failed;
    }
    const float* stems = outputs[0].GetTensorData<float>();  // (1, 6, 2, segment)

    // accumulate stems * w and weight += w over [start, end)
    for (int64_t t = 0; t < chunkLen; t++) {
      const float w = window[static_cast<size_t>(t)];
      weight[static_cast<size_t>(start + t - accStart)] += w;
    }
    for (int s = 0; s < kStems; s++) {
      for (int c = 0; c < kChannels; c++) {
        const float* srcLane =
            stems + (static_cast<int64_t>(s) * kChannels + c) * kSegment;
        float* dstLane = acc.data() + static_cast<size_t>((s * kChannels + c) * cap);
        const int64_t off = start - accStart;
        for (int64_t t = 0; t < chunkLen; t++) {
          dstLane[off + t] += srcLane[t] * window[static_cast<size_t>(t)];
        }
      }
    }
    accEnd = std::max(accEnd, end);

    // samples below the NEXT chunk's start are final
    const int64_t finalBelow = std::min((i + 1) * kStride, totalLen);
    if (!commitUpTo(finalBelow)) {
      std::fclose(mix);
      errorOut = "writing a stem failed";
      return SplitResult::failed;
    }
    if (!persistTail(i + 1)) {
      std::fclose(mix);
      errorOut = "persisting the resume tail failed";
      return SplitResult::failed;
    }
    progress.report("split", static_cast<float>(i + 1) / nChunks);
    if (config.onChunkDone != nullptr) {
      config.onChunkDone(config.onChunkUser, i + 1, nChunks);
    }
  }

  std::fclose(mix);
  for (auto& w : writers) {
    if (!w->finalize()) {
      errorOut = "finalizing a stem failed";
      return SplitResult::failed;
    }
  }
  std::remove(tailPath.c_str());
  progress.report("split", 1.0f);
  return SplitResult::ok;
}

}  // namespace singz
