#pragma once
#include "core.h"
#include <vector>
namespace monitor_spike {
struct WaveformResult {
  bool measured{}, controlSilent{};
  size_t windows{};
  double delayMs{}, minCorrelation{}, spreadMs{}, controlRms{}, controlCorrelation{};
};
// Offline only. Six half-second chirp-bearing windows across two four-second
// signal segments, preceded by a four-second muted control. Timestamps align
// source and return; the lag includes output/return hardware outside the history.
WaveformResult correlate(std::span<const Point> source, std::span<const Point> returned,
                         uint64_t begin, double rate, double maxLagMs,
                         double threshold = .9999, double controlRmsLimit = 1e-5);
}
