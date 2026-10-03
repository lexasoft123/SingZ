#pragma once

#include <zdsp/analysis/capture_adapter.h>
#include <zdsp/graph.h>
#include <memory>
#include <string>

namespace zdsp::analysis {

inline constexpr NodeTypeId kPitchAnalysisTapNodeType{0x7069746368, 1};
inline constexpr uint32_t kPitchAnalysisTapSchemaVersion = 1;

enum class PitchDetectorKind { Yin, CrepeTiny, Custom };
struct PitchAnalysisConfig {
  PitchDetectorKind detector = PitchDetectorKind::CrepeTiny;
  std::string modelPath;
  uint64_t generation = 1;
  uint32_t maximumBlockFrames = 16384;
  // Custom detectors use the same framing, provenance and graph tap.
  LiveInputAnalysisAdapter::Analyzer analyzer;
  int analysisRate = 16000;
  size_t windowFrames = 1024;
  size_t hopFrames = 320;
};

// Control-domain construction/destruction. One producer and one analysis
// consumer. The graph processor only copies PCM/provenance to a bounded SPSC
// queue; drain() performs resampling/inference outside the render callback.
// Stop/join both domains before destroying this object. The borrowed processor
// must be retired before destruction. No detector/model enters zcore or the
// callback-safe zdsp runtime's dependency closure.
class PitchAnalysisModule {
 public:
  explicit PitchAnalysisModule(PitchAnalysisConfig config);
  ~PitchAnalysisModule();
  PitchAnalysisModule(const PitchAnalysisModule&) = delete;
  PitchAnalysisModule& operator=(const PitchAnalysisModule&) = delete;

  ProcessorHandle graphProcessor() noexcept;
  void cancel(uint64_t generation) noexcept;
  void drain(const LiveInputAnalysisAdapter::Sink& sink);
  // Capture convenience route: compiled Input -> Pitch tap -> Output graph,
  // followed by drain on the existing ordinary capture-delivery worker.
  bool push(const singz::AudioInputBlockView& block,
            const LiveInputAnalysisAdapter::Sink& sink);
  const char* detectorName() const noexcept;
  double inferenceMs() const noexcept;
  bool harmonicCorrected() const noexcept;
  float appliedGain() const noexcept;
  uint32_t droppedBlocks() const noexcept;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}  // namespace zdsp::analysis
