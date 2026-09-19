#include <zcore/legacy/live_input_analysis.h>

#include <zcore/legacy/pitch_candidates.h>

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

namespace singz {

namespace {
bool isFinitePositive(double value) { return std::isfinite(value) && value > 0; }
}  // namespace

LiveInputFrame analyzeLiveInput(const float* mono, size_t frames,
                                double sampleRate, double minFrequency,
                                double maxFrequency) {
  LiveInputFrame result;
  if (!mono || frames < 32 || !isFinitePositive(sampleRate) ||
      !isFinitePositive(minFrequency) || !isFinitePositive(maxFrequency) ||
      minFrequency >= maxFrequency) {
    return result;
  }

  const float* data = mono;
  std::vector<float> sanitized;
  for (size_t i = 0; i < frames; ++i) {
    if (!std::isfinite(mono[i])) {
      sanitized.assign(mono, mono + frames);
      for (float& sample : sanitized)
        if (!std::isfinite(sample)) sample = 0;
      data = sanitized.data();
      break;
    }
  }
  double sumSquares = 0;
  double peak = 0;
  for (size_t i = 0; i < frames; ++i) {
    const double sample = data[i];
    sumSquares += sample * sample;
    peak = std::max(peak, std::fabs(sample));
  }
  result.peak = peak;
  result.rms = std::sqrt(sumSquares / static_cast<double>(frames));
  result.dbfs = result.rms > 0
                    ? std::max(-120.0, 20.0 * std::log10(result.rms))
                    : -120.0;
  if (result.rms < 0.01) return result;

  const size_t minTau = std::max<size_t>(
      2, static_cast<size_t>(std::floor(sampleRate / maxFrequency)));
  const size_t maxTau = std::min(
      frames / 2,
      static_cast<size_t>(std::ceil(sampleRate / minFrequency) + 1));
  if (maxTau <= minTau + 2) return result;

  std::vector<float> difference(maxTau + 1, 0.0f);
  std::vector<float> cmnd(maxTau + 1, 0.0f);
  cmnd[0] = 1.0f;
  const size_t window = frames - maxTau;
  for (size_t tau = 1; tau <= maxTau; ++tau) {
    double sum = 0;
    for (size_t i = 0; i < window; ++i) {
      const double delta = static_cast<double>(data[i]) - data[i + tau];
      sum += delta * delta;
    }
    difference[tau] = static_cast<float>(sum);
  }
  double running = 0;
  for (size_t tau = 1; tau <= maxTau; ++tau) {
    running += difference[tau];
    cmnd[tau] = running == 0
                    ? 1.0f
                    : static_cast<float>(difference[tau] *
                                         static_cast<double>(tau) / running);
  }

  const auto candidates = pitch::candidates(cmnd, static_cast<int>(minTau),
                                             static_cast<int>(maxTau), sampleRate, data, static_cast<int>(frames));
  const pitch::Candidate* best = nullptr;
  for (const auto& candidate : candidates) {
    if (candidate.f0 < minFrequency * 0.999 || candidate.f0 > maxFrequency * 1.001) continue;
    if (!best || candidate.val < best->val) best = &candidate;
    if (candidate.val < 0.15) { best = &candidate; break; }
  }
  if (best && best->val <= 0.3) {
    result.frequency = std::clamp(best->f0, minFrequency, maxFrequency);
    result.clarity = std::clamp(1.0 - best->val, 0.0, 1.0);
  }
  return result;
}

}  // namespace singz
