#include <zdsp/analysis/live_input_analysis.h>

#include <zcore/legacy/live_input_analysis.h>

namespace zdsp::analysis {

const char* analysisBuildId() noexcept { return "zdsp-analysis-phase2-v1"; }

LiveInputFrame analyzeLiveInput(const float* mono, size_t frames,
                                double sampleRate, double minFrequency,
                                double maxFrequency) {
  const singz::LiveInputFrame legacy = singz::analyzeLiveInput(
      mono, frames, sampleRate, minFrequency, maxFrequency);
  return {legacy.frequency, legacy.clarity, legacy.peak, legacy.rms,
          legacy.dbfs};
}

}  // namespace zdsp::analysis
