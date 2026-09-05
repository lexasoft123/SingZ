#include "playback_cue_plan.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <new>
#include <utility>

namespace singz {
namespace {

constexpr double kMinimumSampleRate = 8000.0;
constexpr double kMaximumSampleRate = 384000.0;
constexpr double kMinimumPlaybackRate = 0.25;
constexpr double kMaximumPlaybackRate = 4.0;
constexpr uint32_t kMaximumCountInBars = 2;
constexpr uint32_t kGridlessBeatsPerBar = 3;
constexpr double kGridlessPeriodSeconds = 1.0;
constexpr double kMinimumBeatSeparationSeconds = 0.05;
constexpr double kMinimumBpm = 30.0;
constexpr double kMaximumBpm = 300.0;
constexpr double kClickDurationSeconds = 0.055;
constexpr double kClickAttackSeconds = 0.0015;
constexpr double kClickDecaySeconds = 0.012;
constexpr double kOrdinaryFrequencyHz = 1046.5;
constexpr double kOrdinaryAmplitude = 0.62;
constexpr double kAccentFrequencyHz = 1568.0;
constexpr double kAccentAmplitude = 0.9;
constexpr double kTwoPi = 6.283185307179586476925286766559;

PlaybackCuePlanResult failure(PlaybackCuePlanError error, const char *message) {
  return {error, nullptr, message};
}

bool isMeter(uint32_t beatsPerBar) noexcept {
  return beatsPerBar == 2 || beatsPerBar == 3 || beatsPerBar == 4 ||
         beatsPerBar == 6;
}

bool roundedFrames(double seconds, double sampleRate,
                   int64_t *frames) noexcept {
  if (frames == nullptr || !std::isfinite(seconds) ||
      !std::isfinite(sampleRate)) {
    return false;
  }
  // JavaScript computes this product in binary64 before Math.round. Do not
  // widen either operand: x87-style excess precision changes adversarial
  // half-frame decisions and would make the portable planner disagree.
  const double value = seconds * sampleRate;
  if (!std::isfinite(value) ||
      static_cast<long double>(value) <
          static_cast<long double>(std::numeric_limits<int64_t>::min()) ||
      static_cast<long double>(value) >
          static_cast<long double>(std::numeric_limits<int64_t>::max())) {
    return false;
  }
  *frames = std::llround(value);
  return true;
}

double localPeriod(const PlaybackCueBeatGrid &grid, int64_t index) {
  const auto &beats = grid.beats;
  const int64_t lastInterval = static_cast<int64_t>(beats.size()) - 2;
  const int64_t rounded = index;
  const int64_t start =
      std::max<int64_t>(0, std::min<int64_t>(lastInterval, rounded - 4));
  const int64_t end =
      std::min<int64_t>(static_cast<int64_t>(beats.size()) - 1, start + 8);
  std::array<double, 8> intervals{};
  size_t count = 0;
  for (int64_t i = start; i < end; ++i) {
    intervals[count++] =
        beats[static_cast<size_t>(i + 1)] - beats[static_cast<size_t>(i)];
  }
  std::sort(intervals.begin(), intervals.begin() + count);
  return intervals[count / 2];
}

double beatTime(const PlaybackCueBeatGrid &grid, int64_t index) {
  const auto &beats = grid.beats;
  if (index < 0) {
    return beats.front() + static_cast<double>(index) * localPeriod(grid, 0);
  }
  if (index >= static_cast<int64_t>(beats.size())) {
    const int64_t last = static_cast<int64_t>(beats.size()) - 1;
    return beats.back() +
           static_cast<double>(index - last) * localPeriod(grid, last);
  }
  return beats[static_cast<size_t>(index)];
}

int64_t beatIndexAtOrAfter(const PlaybackCueBeatGrid &grid, double time) {
  const auto &beats = grid.beats;
  if (time <= beats.front()) {
    const double period = localPeriod(grid, 0);
    const int64_t distance = static_cast<int64_t>(
        std::floor((beats.front() - time) / period + 1e-9));
    return distance > 0 ? -distance : 0;
  }
  if (time > beats.back()) {
    const double period =
        localPeriod(grid, static_cast<int64_t>(beats.size()) - 1);
    return static_cast<int64_t>(beats.size()) - 1 +
           static_cast<int64_t>(
               std::ceil((time - beats.back()) / period - 1e-9));
  }
  size_t low = 0;
  size_t high = beats.size() - 1;
  while (low < high) {
    const size_t middle = (low + high) >> 1U;
    if (beats[middle] >= time - 1e-9) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return static_cast<int64_t>(low);
}

size_t downbeatAtOrBefore(const std::vector<uint32_t> &downbeats,
                          int64_t index) {
  size_t low = 0;
  size_t high = downbeats.size() - 1;
  while (low < high) {
    const size_t middle = (low + high + 1) >> 1U;
    if (static_cast<int64_t>(downbeats[middle]) <= index) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

uint32_t positiveModulo(int64_t value, uint32_t divisor) noexcept {
  const int64_t signedDivisor = static_cast<int64_t>(divisor);
  return static_cast<uint32_t>(((value % signedDivisor) + signedDivisor) %
                               signedDivisor);
}

uint32_t accentIndex(const PlaybackCueBeatGrid &grid, int64_t index) {
  const auto &downbeats = grid.downbeats;
  if (!downbeats.empty()) {
    const uint32_t firstLength =
        downbeats.size() >= 2 ? downbeats[1] - downbeats[0] : grid.beatsPerBar;
    const uint32_t lastLength =
        downbeats.size() >= 2
            ? downbeats.back() - downbeats[downbeats.size() - 2]
            : grid.beatsPerBar;
    if (index < static_cast<int64_t>(downbeats.front())) {
      return positiveModulo(index - static_cast<int64_t>(downbeats.front()),
                            firstLength);
    }
    if (index >= static_cast<int64_t>(downbeats.back())) {
      return positiveModulo(index - static_cast<int64_t>(downbeats.back()),
                            lastLength);
    }
    return static_cast<uint32_t>(
        index -
        static_cast<int64_t>(downbeats[downbeatAtOrBefore(downbeats, index)]));
  }
  return positiveModulo(index - static_cast<int64_t>(grid.downbeat),
                        grid.beatsPerBar);
}

uint32_t barLengthAt(const PlaybackCueBeatGrid &grid, int64_t index) {
  const auto &downbeats = grid.downbeats;
  if (downbeats.size() < 2) {
    return grid.beatsPerBar;
  }
  if (index < static_cast<int64_t>(downbeats.front())) {
    return downbeats[1] - downbeats[0];
  }
  if (index >= static_cast<int64_t>(downbeats.back())) {
    return downbeats.back() - downbeats[downbeats.size() - 2];
  }
  const size_t position = downbeatAtOrBefore(downbeats, index);
  return downbeats[position + 1] - downbeats[position];
}

bool validateGrid(const PlaybackCueBeatGrid &grid,
                  PlaybackCuePlanResult *error) {
  if (grid.beats.empty()) {
    if (!grid.downbeats.empty()) {
      *error = failure(PlaybackCuePlanError::InvalidConfiguration,
                       "gridless cue plan cannot contain downbeats");
      return false;
    }
    return true;
  }
  if (grid.beats.size() < 2) {
    *error = failure(PlaybackCuePlanError::InvalidConfiguration,
                     "beat grid must contain at least two beats");
    return false;
  }
  if (grid.beats.size() > kPlaybackCueMaximumBeats) {
    *error = failure(PlaybackCuePlanError::LimitExceeded,
                     "beat grid exceeds the prepared beat limit");
    return false;
  }
  if (!isMeter(grid.beatsPerBar) || grid.downbeat >= grid.beatsPerBar) {
    *error = failure(PlaybackCuePlanError::InvalidConfiguration,
                     "beat meter or uniform downbeat is invalid");
    return false;
  }
  for (size_t i = 0; i < grid.beats.size(); ++i) {
    const double beat = grid.beats[i];
    if (!std::isfinite(beat) || beat < 0.0 ||
        beat > kPlaybackCueMaximumDurationSeconds ||
        (i > 0 && beat - grid.beats[i - 1] <= kMinimumBeatSeparationSeconds)) {
      *error = failure(PlaybackCuePlanError::InvalidConfiguration,
                       "beat positions must be finite, sorted and separated");
      return false;
    }
  }
  std::vector<double> intervals;
  intervals.reserve(grid.beats.size() - 1);
  for (size_t i = 1; i < grid.beats.size(); ++i) {
    intervals.push_back(grid.beats[i] - grid.beats[i - 1]);
  }
  std::sort(intervals.begin(), intervals.end());
  const double bpm = 60.0 / intervals[intervals.size() / 2];
  if (!std::isfinite(bpm) || bpm < kMinimumBpm || bpm > kMaximumBpm) {
    *error = failure(PlaybackCuePlanError::InvalidConfiguration,
                     "beat grid median tempo is outside 30-300 BPM");
    return false;
  }
  if (grid.downbeats.size() > grid.beats.size()) {
    *error = failure(PlaybackCuePlanError::LimitExceeded,
                     "downbeat map exceeds the beat count");
    return false;
  }
  for (size_t i = 0; i < grid.downbeats.size(); ++i) {
    const uint32_t downbeat = grid.downbeats[i];
    if (downbeat >= grid.beats.size() ||
        (i > 0 && downbeat <= grid.downbeats[i - 1])) {
      *error = failure(PlaybackCuePlanError::InvalidConfiguration,
                       "downbeat indexes must be sorted and in range");
      return false;
    }
  }
  return true;
}

std::vector<float> clickPcm(double sampleRate, double frequency,
                            double amplitude) {
  const size_t count =
      static_cast<size_t>(std::llround(sampleRate * kClickDurationSeconds));
  std::vector<float> samples(count);
  for (size_t i = 0; i < count; ++i) {
    const double time = static_cast<double>(i) / sampleRate;
    samples[i] = static_cast<float>(amplitude *
                                    std::min(1.0, time / kClickAttackSeconds) *
                                    std::exp(-time / kClickDecaySeconds) *
                                    std::sin(kTwoPi * frequency * time));
  }
  return samples;
}

} // namespace

PlaybackCuePlanResult
preparePlaybackCuePlan(const PlaybackCuePlanRequest &request) noexcept {
  try {
    if (!std::isfinite(request.entrySeconds) || request.entrySeconds < 0.0 ||
        !std::isfinite(request.durationSeconds) ||
        request.durationSeconds <= 0.0 ||
        request.durationSeconds > kPlaybackCueMaximumDurationSeconds ||
        request.entrySeconds > request.durationSeconds ||
        !std::isfinite(request.sampleRate) ||
        request.sampleRate < kMinimumSampleRate ||
        request.sampleRate > kMaximumSampleRate ||
        !std::isfinite(request.playbackRate) ||
        request.playbackRate < kMinimumPlaybackRate ||
        request.playbackRate > kMaximumPlaybackRate ||
        !std::isfinite(request.volume) || request.volume < 0.0 ||
        request.volume > 1.0 || request.countInBars > kMaximumCountInBars) {
      return failure(PlaybackCuePlanError::InvalidConfiguration,
                     "cue plan scalar configuration is invalid");
    }
    const bool hasAnchor = std::isfinite(request.countInAnchorSeconds) &&
                           request.countInAnchorSeconds >= 0.0 &&
                           request.countInAnchorSeconds != request.entrySeconds;
    if (hasAnchor && (request.countInAnchorSeconds < request.entrySeconds ||
                      request.countInAnchorSeconds > request.durationSeconds)) {
      return failure(PlaybackCuePlanError::InvalidConfiguration,
                     "cue plan count-in anchor is outside the song");
    }
    const double anchorSeconds =
        hasAnchor ? request.countInAnchorSeconds : request.entrySeconds;

    PlaybackCuePlanResult validation;
    if (!validateGrid(request.beatGrid, &validation)) {
      return validation;
    }

    auto plan = std::make_shared<PlaybackCuePlan>();
    plan->beatGrid = request.beatGrid;
    plan->click = request.click;
    plan->countInBars = request.countInBars;
    plan->volume = static_cast<float>(request.volume);
    plan->accent = request.accent;
    plan->sampleRate = request.sampleRate;
    plan->playbackRate = request.playbackRate;
    if (!roundedFrames(request.entrySeconds, request.sampleRate,
                       &plan->sourceStartFrame) ||
        !roundedFrames(anchorSeconds - request.entrySeconds,
                       request.sampleRate, &plan->landingProjectFrame) ||
        !roundedFrames(request.durationSeconds - request.entrySeconds,
                       request.sampleRate, &plan->songDurationFrames)) {
      return failure(PlaybackCuePlanError::LimitExceeded,
                     "cue plan frame range cannot be represented");
    }
    plan->ordinaryClickPcm =
        clickPcm(request.sampleRate, kOrdinaryFrequencyHz, kOrdinaryAmplitude);
    plan->accentClickPcm =
        clickPcm(request.sampleRate, kAccentFrequencyHz, kAccentAmplitude);

    const auto addEvent = [&](double relativeSeconds, bool useAccent) -> bool {
      if (plan->events.size() >= kPlaybackCueMaximumEvents) {
        return false;
      }
      int64_t frame = 0;
      if (!roundedFrames(relativeSeconds, request.sampleRate, &frame)) {
        return false;
      }
      plan->events.push_back({frame, useAccent ? PlaybackCueSound::Accent
                                               : PlaybackCueSound::Ordinary});
      return true;
    };

    if (request.beatGrid.beats.empty()) {
      const uint32_t ticks = request.countInBars * kGridlessBeatsPerBar;
      plan->countInBeatsPerBar = ticks > 0 ? kGridlessBeatsPerBar : 0;
      plan->countInEventCount = ticks;
      int64_t preRoll = 0;
      // Gridless fallback is an output-clock countdown, unlike beat-grid
      // events which live in original-song time.  Convert each real-time
      // second into playback-rate project frames so Q32 transport renders
      // the three/six ticks one output second apart at every tempo.
      if (!roundedFrames(static_cast<double>(ticks) *
                             kGridlessPeriodSeconds * request.playbackRate,
                         request.sampleRate, &preRoll)) {
        return failure(PlaybackCuePlanError::LimitExceeded,
                       "gridless pre-roll cannot be represented");
      }
      plan->preRollFrames = preRoll;
      for (uint32_t tick = 0; tick < ticks; ++tick) {
        const double relative =
            -static_cast<double>(ticks - tick) * kGridlessPeriodSeconds *
            request.playbackRate;
        const bool useAccent =
            request.accent && tick % kGridlessBeatsPerBar == 0;
        if (!addEvent(relative, useAccent)) {
          return failure(PlaybackCuePlanError::LimitExceeded,
                         "gridless cue event limit exceeded");
        }
      }
    } else if (request.click || request.countInBars > 0) {
      const auto &grid = request.beatGrid;
      const int64_t entryBeat = beatIndexAtOrAfter(grid, anchorSeconds);
      int64_t firstBeat = entryBeat;
      if (request.countInBars > 0) {
        plan->countInBeatsPerBar = barLengthAt(grid, entryBeat);
        const uint64_t count = static_cast<uint64_t>(request.countInBars) *
                               plan->countInBeatsPerBar;
        if (count > kPlaybackCueMaximumEvents ||
            count >
                static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
          return failure(PlaybackCuePlanError::LimitExceeded,
                         "grid count-in exceeds the cue event limit");
        }
        plan->countInEventCount = static_cast<uint32_t>(count);
        firstBeat -= static_cast<int64_t>(count);
        int64_t firstFrame = 0;
        if (!roundedFrames(beatTime(grid, firstBeat) - anchorSeconds,
                           request.sampleRate, &firstFrame)) {
          return failure(PlaybackCuePlanError::LimitExceeded,
                         "grid pre-roll cannot be represented");
        }
        plan->preRollFrames = std::max<int64_t>(0, -firstFrame);
      }

      for (int64_t beat = firstBeat;; ++beat) {
        if (!request.click && beat >= entryBeat) {
          break;
        }
        const double seconds = beatTime(grid, beat);
        if (beat >= entryBeat && seconds > request.durationSeconds) {
          break;
        }
        // Count-in beats live in the pre-roll, relative to where the song
        // begins; the beats from there on live in the project timeline.
        const double relative =
            beat < entryBeat ? seconds - anchorSeconds
                             : seconds - request.entrySeconds;
        if (!addEvent(relative,
                      request.accent && accentIndex(grid, beat) == 0)) {
          return failure(PlaybackCuePlanError::LimitExceeded,
                         "grid cue event limit exceeded");
        }
        if (beat == std::numeric_limits<int64_t>::max()) {
          return failure(PlaybackCuePlanError::LimitExceeded,
                         "beat index cannot be represented");
        }
      }
    }

    return {PlaybackCuePlanError::None,
            std::shared_ptr<const PlaybackCuePlan>(std::move(plan)),
            {}};
  } catch (const std::bad_alloc &) {
    return {PlaybackCuePlanError::ResourceExhausted, nullptr, {}};
  } catch (...) {
    return {PlaybackCuePlanError::InvalidConfiguration, nullptr, {}};
  }
}

} // namespace singz
