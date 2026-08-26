#pragma once

#include <cstddef>

namespace singz {

struct LiveInputFrame {
  double frequency = 0;
  double clarity = 0;
  double rms = 0;
  double dbfs = -120;
};

// Delivery/analysis-thread YIN + level analysis. This is deliberately outside
// the callback transport and device lifecycle contracts.
LiveInputFrame analyzeLiveInput(const float* mono, size_t frames,
                                double sampleRate,
                                double minFrequency = 70.0,
                                double maxFrequency = 1050.0);

}  // namespace singz
