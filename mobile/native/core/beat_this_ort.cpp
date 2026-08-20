// The ONNX-backed half of beat_this.h: two sessions, wrapped as the callables
// the pure runner takes. Kept in its own translation unit so beat_this.cpp
// links on a host with no ONNX Runtime — which is what lets the parity harness
// replay recorded tensors instead of needing a model.
#include <array>
#include <memory>
#include <string>
#include <vector>

#include <onnxruntime_cxx_api.h>

#include "beat_this.h"

namespace singz {
namespace {

constexpr int kMel = 128;

struct Sessions {
  std::unique_ptr<Ort::Env> env;
  std::unique_ptr<Ort::Session> mel;
  std::unique_ptr<Ort::Session> model;
  Ort::MemoryInfo mem = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
};

std::string joinPath(const std::string& dir, const char* name) {
  if (dir.empty()) return name;
  return dir.back() == '/' ? dir + name : dir + "/" + name;
}

}  // namespace

BeatThisModels loadBeatThisModels(const std::string& modelsDir, std::string& error) {
  BeatThisModels models;
  error.clear();
  auto s = std::make_shared<Sessions>();
  try {
    s->env = std::make_unique<Ort::Env>(ORT_LOGGING_LEVEL_ERROR, "singz-beat-this");
    Ort::SessionOptions opts;
    // Same reason as the splitter (split_engine.cpp): ORT's load-time graph
    // rewrites are what killed the app on a real iPhone, and they are fusions
    // rather than semantics, so turning them off costs nothing but load time.
    // Applied on Apple only, matching where that was measured.
#if defined(__APPLE__)
    opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_DISABLE_ALL);
#else
    opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
#endif
    // CPU only, on every platform — the desktop ONNX flavor says the same and
    // for the same reason: this model is ~6 s of work and the accelerator
    // paths are where the fragility lives. The splitter is the one that needs
    // them, and it carries its own per-device disable marker.
    const std::string melPath = joinPath(modelsDir, "logmel.onnx");
    const std::string modelPath = joinPath(modelsDir, "beat_this.onnx");
    s->mel = std::make_unique<Ort::Session>(*s->env, melPath.c_str(), opts);
    s->model = std::make_unique<Ort::Session>(*s->env, modelPath.c_str(), opts);
  } catch (const std::exception& e) {
    error = std::string("could not load the beat models: ") + e.what();
    return models;
  }

  models.logmel = [s](const std::vector<float>& frames, int nFrames) -> std::vector<float> {
    try {
      const std::array<int64_t, 2> shape{static_cast<int64_t>(nFrames), kBeatThisNFft};
      Ort::Value in = Ort::Value::CreateTensor<float>(
          s->mem, const_cast<float*>(frames.data()), frames.size(), shape.data(), shape.size());
      const char* inNames[] = {"frames"};
      // The name is fetched rather than assumed (the mel graph is built at pack
      // time), and the owning handle is HELD: `GetOutputNameAllocated(...).get()`
      // in the initialiser would free the string at the end of that expression
      // and leave outNames pointing at released memory.
      Ort::AllocatorWithDefaultOptions alloc;
      auto melOut = s->mel->GetOutputNameAllocated(0, alloc);
      const char* outNames[] = {melOut.get()};
      std::vector<Ort::Value> out =
          s->mel->Run(Ort::RunOptions{nullptr}, inNames, &in, 1, outNames, 1);
      const float* p = out[0].GetTensorData<float>();
      const size_t n = out[0].GetTensorTypeAndShapeInfo().GetElementCount();
      return std::vector<float>(p, p + n);
    } catch (const std::exception&) {
      return std::vector<float>();
    }
  };

  models.model = [s](const std::vector<float>& spect, std::vector<float>& beatLogits,
                     std::vector<float>& downLogits) -> bool {
    try {
      const std::array<int64_t, 3> shape{1, kBeatThisChunk, kMel};
      Ort::Value in = Ort::Value::CreateTensor<float>(
          s->mem, const_cast<float*>(spect.data()), spect.size(), shape.data(), shape.size());
      Ort::AllocatorWithDefaultOptions alloc;
      auto o0 = s->model->GetOutputNameAllocated(0, alloc);
      auto o1 = s->model->GetOutputNameAllocated(1, alloc);
      const char* inNames[] = {"spect"};
      const char* outNames[] = {o0.get(), o1.get()};
      std::vector<Ort::Value> out =
          s->model->Run(Ort::RunOptions{nullptr}, inNames, &in, 1, outNames, 2);
      if (out.size() != 2) return false;
      for (int k = 0; k < 2; k++) {
        const float* p = out[static_cast<size_t>(k)].GetTensorData<float>();
        const size_t n = out[static_cast<size_t>(k)].GetTensorTypeAndShapeInfo().GetElementCount();
        std::vector<float>& dst = k == 0 ? beatLogits : downLogits;
        // Shape is (1, 1500) and `n` is its ELEMENT count, so this copies the
        // 1500 logits flat; there is no batch dim to strip, only one to ignore.
        dst.assign(p, p + n);
      }
      return true;
    } catch (const std::exception&) {
      return false;
    }
  };
  return models;
}

}  // namespace singz
