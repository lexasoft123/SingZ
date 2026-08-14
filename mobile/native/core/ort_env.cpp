#include "ort_env.h"

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <numeric>
#include <sstream>
#include <vector>

#include <onnxruntime_cxx_api.h>

namespace singz {
namespace {

double msSince(std::chrono::steady_clock::time_point t0) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0)
      .count();
}

std::string jsonEscape(const std::string& s) {
  std::ostringstream out;
  for (const char c : s) {
    switch (c) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          out << buf;
        } else {
          out << c;
        }
    }
  }
  return out.str();
}

std::string describeIo(Ort::Session& session, bool inputsSide) {
  Ort::AllocatorWithDefaultOptions alloc;
  std::ostringstream out;
  const size_t n = inputsSide ? session.GetInputCount() : session.GetOutputCount();
  for (size_t i = 0; i < n; i++) {
    if (i > 0) out << ";";
    auto name = inputsSide ? session.GetInputNameAllocated(i, alloc)
                           : session.GetOutputNameAllocated(i, alloc);
    out << name.get() << ":";
    auto info = inputsSide ? session.GetInputTypeInfo(i) : session.GetOutputTypeInfo(i);
    auto tensor = info.GetTensorTypeAndShapeInfo();
    out << (tensor.GetElementType() == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT ? "f32" : "t")
        << "[";
    const auto shape = tensor.GetShape();
    for (size_t d = 0; d < shape.size(); d++) {
      if (d > 0) out << ",";
      out << shape[d];
    }
    out << "]";
  }
  return out.str();
}

}  // namespace

OrtProbeResult ortProbe(const std::string& modelPath) {
  OrtProbeResult res;
  res.ortVersion = Ort::GetVersionString();
  try {
    Ort::Env env(ORT_LOGGING_LEVEL_ERROR, "singz-probe");
    Ort::SessionOptions opts;
    opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

    const auto t0 = std::chrono::steady_clock::now();
    Ort::Session session(env, modelPath.c_str(), opts);
    res.loadMs = msSince(t0);

    res.inputs = describeIo(session, true);
    res.outputs = describeIo(session, false);

    // Dummy run: first input only, float zeros, dynamic dims as 2. Enough to
    // prove the graph executes on this device; real shapes come with the
    // engines.
    Ort::AllocatorWithDefaultOptions alloc;
    auto inName = session.GetInputNameAllocated(0, alloc);
    // The TypeInfo must outlive the shape view: GetTensorTypeAndShapeInfo()
    // returns an Unowned reference INTO the TypeInfo, and chaining it off the
    // temporary is a use-after-free (Android survived on allocator luck; the
    // iOS simulator SIGSEGV'd in GetDimensions — caught by the Phase-0 run).
    Ort::TypeInfo inTypeInfo = session.GetInputTypeInfo(0);
    auto inInfo = inTypeInfo.GetTensorTypeAndShapeInfo();
    std::vector<int64_t> shape = inInfo.GetShape();
    for (auto& d : shape) {
      if (d <= 0) d = 2;
    }
    const int64_t count =
        std::accumulate(shape.begin(), shape.end(), int64_t{1}, std::multiplies<int64_t>());
    std::vector<float> zeros(static_cast<size_t>(count), 0.0f);
    Ort::MemoryInfo mem = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    Ort::Value input = Ort::Value::CreateTensor<float>(mem, zeros.data(), zeros.size(),
                                                       shape.data(), shape.size());

    std::vector<std::string> outNameStrs;
    std::vector<const char*> outNames;
    for (size_t i = 0; i < session.GetOutputCount(); i++) {
      outNameStrs.push_back(session.GetOutputNameAllocated(i, alloc).get());
    }
    for (const auto& s : outNameStrs) outNames.push_back(s.c_str());
    const char* inNames[] = {inName.get()};

    const auto t1 = std::chrono::steady_clock::now();
    session.Run(Ort::RunOptions{nullptr}, inNames, &input, 1, outNames.data(),
                outNames.size());
    res.runMs = msSince(t1);
    res.ok = true;
  } catch (const std::exception& e) {
    res.error = e.what();
  }
  return res;
}

std::string ortProbeJson(const std::string& modelPath) {
  const OrtProbeResult res = ortProbe(modelPath);
  std::ostringstream json;
  json << "{\"ok\":" << (res.ok ? "true" : "false") << ",\"ortVersion\":\""
       << jsonEscape(res.ortVersion) << "\"";
  if (res.ok) {
    json << ",\"inputs\":\"" << jsonEscape(res.inputs) << "\",\"outputs\":\""
         << jsonEscape(res.outputs) << "\",\"loadMs\":" << res.loadMs
         << ",\"runMs\":" << res.runMs;
  } else {
    json << ",\"error\":\"" << jsonEscape(res.error) << "\"";
  }
  json << "}";
  return json.str();
}

}  // namespace singz
