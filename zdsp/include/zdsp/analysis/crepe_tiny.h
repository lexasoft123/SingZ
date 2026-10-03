#pragma once
#include <zdsp/analysis/live_input_analysis.h>
#include <array>
#include <memory>
#include <string>

// Control-thread construction; inference belongs to AudioInput delivery,
// never RemoteIO. No exercise target enters this detector.
namespace zdsp::analysis {
class CrepeTiny {
 public:
  explicit CrepeTiny(const std::string& modelPath);
  ~CrepeTiny();
  zdsp::analysis::LiveInputFrame analyze(const float* pcm, size_t frames, double rate);
  const std::array<float, 360>& probabilities() const;
  double inferenceMs = 0;
  bool harmonicCorrected = false;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace zdsp::analysis
