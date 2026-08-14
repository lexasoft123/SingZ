#pragma once
#include <string>

// Thin ONNX Runtime session helpers shared by the split engine and the Beat
// This runner (docs/PHONE-STANDALONE.md). The EP ladder lives here so the
// engines never care: XNNPACK/CPU on Android, CoreML→CPU on iOS with a
// per-device disable marker (the desktop dml-disabled.json pattern).
namespace singz {

// Phase-0 smoke: load a model, describe its IO, run one dummy-shaped
// inference. Proves the ORT link, header wiring and a real session on-device
// before any engine code exists. Dynamic dims are run as 2.
struct OrtProbeResult {
  bool ok = false;
  std::string error;        // set when !ok
  std::string ortVersion;   // e.g. "1.23.2"
  std::string inputs;       // "name:f32[1,2,343980];..."
  std::string outputs;      // same shape notation
  double loadMs = 0;        // session create (includes graph optimize)
  double runMs = 0;         // the dummy Run()
};

OrtProbeResult ortProbe(const std::string& modelPath);

// The probe as one JSON line — bindings marshal this string and nothing
// else, so Android and iOS cannot drift in what they report.
std::string ortProbeJson(const std::string& modelPath);

}  // namespace singz
