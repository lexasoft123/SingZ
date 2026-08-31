#pragma once

#include <cstdint>

namespace singz::detail {

enum class AndroidAudioHostPairPhase : uint32_t {
  Empty,
  Opening,
  Open,
  Starting,
  Running,
  ErrorOwned,
  UserStopping,
  ErrorStopping,
  Closed,
  Quarantined,
};

enum class AndroidAudioHostTeardownOwner : uint32_t {
  None,
  User,
  ErrorWorker,
};

enum class AndroidAudioHostLifecycleRun : uint32_t {
  Completed,
  CallFailed,
  Superseded,
};

// These helpers are the production ordering policy for Oboe lifecycle calls.
// Callers provide the concrete stream operations, and the continuation probe
// re-checks the epoch/owner under the short pair lock after every potentially
// re-entrant Oboe call. No coordinator mutex is held by these helpers.
template <typename RequestStart, typename WaitStarted, typename MarkStarted,
          typename ContinuePair>
AndroidAudioHostLifecycleRun androidAudioHostStartPair(
    const void* input, const void* output, RequestStart&& requestStart,
    WaitStarted&& waitStarted, MarkStarted&& markStarted,
    ContinuePair&& continuePair) {
  const void* streams[] = {input, output};
  for (const void* stream : streams) {
    if (stream == nullptr) continue;
    if (!requestStart(stream)) {
      return AndroidAudioHostLifecycleRun::CallFailed;
    }
    if (!continuePair()) return AndroidAudioHostLifecycleRun::Superseded;
    if (!waitStarted(stream)) {
      return AndroidAudioHostLifecycleRun::CallFailed;
    }
    markStarted(stream);
    if (!continuePair()) return AndroidAudioHostLifecycleRun::Superseded;
  }
  return AndroidAudioHostLifecycleRun::Completed;
}

template <typename Stop, typename Close, typename ContinuePair>
AndroidAudioHostLifecycleRun androidAudioHostStopClosePair(
    const void* input, bool inputStarted, const void* output,
    bool outputStarted, const void* oboeClosedStream, Stop&& stop,
    Close&& close, ContinuePair&& continuePair) {
  const void* streams[] = {output, input};
  const bool started[] = {outputStarted, inputStarted};
  for (uint32_t index = 0; index < 2; ++index) {
    const void* stream = streams[index];
    if (stream == nullptr || stream == oboeClosedStream || !started[index]) {
      continue;
    }
    if (!stop(stream)) return AndroidAudioHostLifecycleRun::CallFailed;
    if (!continuePair()) return AndroidAudioHostLifecycleRun::Superseded;
  }
  for (const void* stream : streams) {
    if (stream == nullptr || stream == oboeClosedStream) continue;
    if (!close(stream)) return AndroidAudioHostLifecycleRun::CallFailed;
    if (!continuePair()) return AndroidAudioHostLifecycleRun::Superseded;
  }
  return AndroidAudioHostLifecycleRun::Completed;
}

struct AndroidAudioHostPairState {
  uint64_t epoch{0};
  AndroidAudioHostPairPhase phase{AndroidAudioHostPairPhase::Empty};
  AndroidAudioHostTeardownOwner teardownOwner{
      AndroidAudioHostTeardownOwner::None};
  const void* inputIdentity{nullptr};
  const void* outputIdentity{nullptr};
  const void* errorStreamIdentity{nullptr};
  bool uncertainty{false};
  bool stopRequested{false};
  bool inputStarted{false};
  bool outputStarted{false};
  bool timestampSamplerStarted{false};
  bool workerRequested{false};
  bool workerCompleted{false};
};

struct AndroidAudioHostStartCommitFacts {
  const void* expectedInput{nullptr};
  const void* expectedOutput{nullptr};
  bool requireInput{false};
  bool inputStreamStarted{false};
  bool outputStreamStarted{false};
  bool routeCurrent{false};
  bool runtimeHealthy{false};
  bool callbackAccepting{false};
  uint32_t expectedFailureGeneration{0};
  uint32_t observedFailureGeneration{0};
};

struct AndroidAudioHostStartBaselineFacts {
  uint32_t failureGenerationBefore{0};
  bool runtimeHealthy{false};
  // Before requestStart the data callback gate must still be closed. Opening
  // it is part of the start transaction, never evidence to normalize a token
  // which changed while this snapshot was being taken.
  bool callbackAccepting{false};
  bool routeCurrent{false};
  uint32_t failureGenerationAfter{0};
};

inline bool androidAudioHostStartBaselineHealthy(
    const AndroidAudioHostStartBaselineFacts& facts) noexcept {
  return facts.failureGenerationBefore == facts.failureGenerationAfter &&
         facts.runtimeHealthy && !facts.callbackAccepting &&
         facts.routeCurrent;
}

inline bool androidAudioHostStartCommitHealthy(
    const AndroidAudioHostPairState& state, uint64_t epoch,
    const AndroidAudioHostStartCommitFacts& facts) noexcept {
  return state.epoch == epoch &&
         state.phase == AndroidAudioHostPairPhase::Starting &&
         state.teardownOwner == AndroidAudioHostTeardownOwner::None &&
         !state.uncertainty && state.errorStreamIdentity == nullptr &&
         facts.expectedOutput != nullptr &&
         state.outputIdentity == facts.expectedOutput &&
         (!facts.requireInput ||
          (facts.expectedInput != nullptr &&
           state.inputIdentity == facts.expectedInput)) &&
         (!facts.requireInput ||
          (state.inputStarted && facts.inputStreamStarted)) &&
         state.outputStarted && facts.outputStreamStarted &&
         facts.routeCurrent &&
         facts.runtimeHealthy && facts.callbackAccepting &&
         facts.observedFailureGeneration == facts.expectedFailureGeneration;
}

inline bool androidAudioHostCommitPairStart(
    AndroidAudioHostPairState* state, uint64_t epoch,
    const AndroidAudioHostStartCommitFacts& facts) noexcept {
  if (state == nullptr ||
      !androidAudioHostStartCommitHealthy(*state, epoch, facts)) {
    return false;
  }
  state->timestampSamplerStarted = true;
  state->phase = AndroidAudioHostPairPhase::Running;
  return true;
}

inline bool androidAudioHostFinalStartHealthy(
    uint32_t expectedFailureGeneration,
    uint32_t failureGenerationBefore, bool runtimeHealthy,
    bool callbackAccepting, bool routeCurrent,
    uint32_t failureGenerationAfter) noexcept {
  return failureGenerationBefore == expectedFailureGeneration &&
         failureGenerationAfter == expectedFailureGeneration &&
         runtimeHealthy && callbackAccepting && routeCurrent;
}

inline bool androidAudioHostPairContains(
    const AndroidAudioHostPairState& state, const void* stream) noexcept {
  return stream != nullptr &&
         (stream == state.inputIdentity || stream == state.outputIdentity);
}

inline bool androidAudioHostOpeningCanBindProvisionalStream(
    const AndroidAudioHostPairState& state, const void* stream) noexcept {
  // The callback owner is newly allocated and permanently stamped with this
  // pair epoch before either builder can expose it to Oboe. During Opening,
  // an exact-epoch callback can therefore bind the not-yet-published member.
  return stream != nullptr &&
         state.phase == AndroidAudioHostPairPhase::Opening &&
         (state.outputIdentity == nullptr || state.inputIdentity == nullptr);
}

inline bool androidAudioHostBeginPairOpen(
    AndroidAudioHostPairState* state, uint64_t epoch) noexcept {
  if (state == nullptr || epoch == 0 ||
      state->phase == AndroidAudioHostPairPhase::Quarantined ||
      (state->phase != AndroidAudioHostPairPhase::Empty &&
       state->phase != AndroidAudioHostPairPhase::Closed) ||
      state->uncertainty) {
    return false;
  }
  *state = {};
  state->epoch = epoch;
  state->phase = AndroidAudioHostPairPhase::Opening;
  return true;
}

inline bool androidAudioHostPublishOutputIdentity(
    AndroidAudioHostPairState* state, uint64_t epoch,
    const void* output) noexcept {
  if (state == nullptr || state->epoch != epoch || output == nullptr ||
      state->phase != AndroidAudioHostPairPhase::Opening ||
      state->outputIdentity != nullptr) {
    return false;
  }
  state->outputIdentity = output;
  return true;
}

inline bool androidAudioHostPublishInputIdentity(
    AndroidAudioHostPairState* state, uint64_t epoch,
    const void* input) noexcept {
  if (state == nullptr || state->epoch != epoch || input == nullptr ||
      state->phase != AndroidAudioHostPairPhase::Opening ||
      state->inputIdentity != nullptr) {
    return false;
  }
  state->inputIdentity = input;
  return true;
}

inline bool androidAudioHostPairOpeningMatches(
    const AndroidAudioHostPairState& state, uint64_t epoch,
    const void* expectedOutput, const void* expectedInput,
    bool requireOutput, bool requireInput) noexcept {
  if (state.epoch != epoch ||
      state.phase != AndroidAudioHostPairPhase::Opening ||
      state.teardownOwner != AndroidAudioHostTeardownOwner::None ||
      state.uncertainty || state.errorStreamIdentity != nullptr) {
    return false;
  }
  if (requireOutput &&
      (expectedOutput == nullptr || state.outputIdentity != expectedOutput)) {
    return false;
  }
  if (requireInput &&
      (expectedInput == nullptr || state.inputIdentity != expectedInput)) {
    return false;
  }
  return true;
}

inline bool androidAudioHostCompletePairOpen(
    AndroidAudioHostPairState* state, uint64_t epoch,
    const void* expectedOutput, const void* expectedInput,
    bool requireInput) noexcept {
  if (state == nullptr ||
      !androidAudioHostPairOpeningMatches(*state, epoch, expectedOutput,
                                         expectedInput, true,
                                         requireInput)) {
    return false;
  }
  state->phase = AndroidAudioHostPairPhase::Open;
  return true;
}

inline bool androidAudioHostBeginPairStart(
    AndroidAudioHostPairState* state, uint64_t epoch) noexcept {
  if (state == nullptr || state->epoch != epoch ||
      state->phase != AndroidAudioHostPairPhase::Open ||
      state->outputIdentity == nullptr ||
      state->teardownOwner != AndroidAudioHostTeardownOwner::None) {
    return false;
  }
  state->phase = AndroidAudioHostPairPhase::Starting;
  return true;
}

inline bool androidAudioHostBeginPairStart(
    AndroidAudioHostPairState* state, uint64_t epoch,
    const AndroidAudioHostStartBaselineFacts& facts) noexcept {
  return androidAudioHostStartBaselineHealthy(facts) &&
         androidAudioHostBeginPairStart(state, epoch);
}

inline bool androidAudioHostCompletePairStart(
    AndroidAudioHostPairState* state, uint64_t epoch) noexcept {
  if (state == nullptr || state->epoch != epoch ||
      state->phase != AndroidAudioHostPairPhase::Starting ||
      state->teardownOwner != AndroidAudioHostTeardownOwner::None) {
    return false;
  }
  state->phase = AndroidAudioHostPairPhase::Running;
  return true;
}

enum class AndroidAudioHostErrorClaim : uint32_t {
  Stale,
  UserOwned,
  Claimed,
  AlreadyClaimed,
};

inline AndroidAudioHostErrorClaim androidAudioHostClaimErrorTeardown(
    AndroidAudioHostPairState* state, uint64_t epoch,
    const void* failingStream) noexcept {
  if (state == nullptr || state->epoch != epoch ||
      (!androidAudioHostPairContains(*state, failingStream) &&
       state->errorStreamIdentity != failingStream &&
       !androidAudioHostOpeningCanBindProvisionalStream(*state,
                                                        failingStream)) ||
      state->phase == AndroidAudioHostPairPhase::Empty ||
      state->phase == AndroidAudioHostPairPhase::Closed ||
      state->phase == AndroidAudioHostPairPhase::Quarantined) {
    return AndroidAudioHostErrorClaim::Stale;
  }
  if (state->teardownOwner == AndroidAudioHostTeardownOwner::User) {
    // Oboe's independent failing-stream close has overlapped the user-owned
    // stop/close sequence. No return value from that sequence can now prove
    // exclusive ownership, so the epoch must fail-stop after drain.
    state->uncertainty = true;
    return AndroidAudioHostErrorClaim::UserOwned;
  }
  if (state->teardownOwner == AndroidAudioHostTeardownOwner::ErrorWorker) {
    if (state->errorStreamIdentity == failingStream) {
      return AndroidAudioHostErrorClaim::AlreadyClaimed;
    }
    // A second member of the same pair entered Oboe's independent close path
    // after teardown ownership was reserved for the first. Keep one worker,
    // but retain the evidence that its stream lifecycle calls can overlap.
    state->uncertainty = true;
    return AndroidAudioHostErrorClaim::Stale;
  }
  state->teardownOwner = AndroidAudioHostTeardownOwner::ErrorWorker;
  state->errorStreamIdentity = failingStream;
  state->phase = AndroidAudioHostPairPhase::ErrorOwned;
  return AndroidAudioHostErrorClaim::Claimed;
}

enum class AndroidAudioHostUserStopAction : uint32_t {
  Stale,
  OperatePair,
  WaitForErrorWorker,
  AlreadyStopping,
};

inline AndroidAudioHostUserStopAction androidAudioHostClaimUserStop(
    AndroidAudioHostPairState* state, uint64_t epoch) noexcept {
  if (state == nullptr || state->epoch != epoch ||
      state->phase == AndroidAudioHostPairPhase::Empty ||
      state->phase == AndroidAudioHostPairPhase::Closed ||
      state->phase == AndroidAudioHostPairPhase::Quarantined) {
    return AndroidAudioHostUserStopAction::Stale;
  }
  state->stopRequested = true;
  if (state->teardownOwner == AndroidAudioHostTeardownOwner::ErrorWorker) {
    return state->workerCompleted
               ? AndroidAudioHostUserStopAction::AlreadyStopping
               : AndroidAudioHostUserStopAction::WaitForErrorWorker;
  }
  if (state->teardownOwner == AndroidAudioHostTeardownOwner::User) {
    return AndroidAudioHostUserStopAction::AlreadyStopping;
  }
  state->teardownOwner = AndroidAudioHostTeardownOwner::User;
  state->phase = AndroidAudioHostPairPhase::UserStopping;
  return AndroidAudioHostUserStopAction::OperatePair;
}

inline bool androidAudioHostBeginErrorWorker(
    AndroidAudioHostPairState* state, uint64_t epoch,
    const void* failingStream) noexcept {
  if (state == nullptr || state->epoch != epoch ||
      state->teardownOwner != AndroidAudioHostTeardownOwner::ErrorWorker ||
      state->errorStreamIdentity != failingStream ||
      (!androidAudioHostPairContains(*state, failingStream) &&
       state->errorStreamIdentity != failingStream) ||
      state->workerCompleted ||
      (state->phase != AndroidAudioHostPairPhase::ErrorOwned &&
       state->phase != AndroidAudioHostPairPhase::ErrorStopping)) {
    return false;
  }
  state->workerRequested = true;
  state->phase = AndroidAudioHostPairPhase::ErrorStopping;
  return true;
}

inline void androidAudioHostPublishPairUncertainty(
    AndroidAudioHostPairState* state, uint64_t epoch,
    bool uncertainty) noexcept {
  if (state != nullptr && state->epoch == epoch && uncertainty) {
    state->uncertainty = true;
  }
}

inline bool androidAudioHostCompleteErrorWorker(
    AndroidAudioHostPairState* state, uint64_t epoch,
    const void* failingStream, bool uncertainty) noexcept {
  if (state == nullptr || state->epoch != epoch ||
      state->teardownOwner != AndroidAudioHostTeardownOwner::ErrorWorker ||
      state->errorStreamIdentity != failingStream ||
      state->phase != AndroidAudioHostPairPhase::ErrorStopping) {
    return false;
  }
  state->uncertainty = state->uncertainty || uncertainty;
  state->inputStarted = false;
  state->outputStarted = false;
  state->timestampSamplerStarted = false;
  state->workerCompleted = true;
  // The worker proved pair stream teardown, but callback owner/admission and
  // prepared storage are finalized only by user stop/open/destruction.
  state->phase = AndroidAudioHostPairPhase::ErrorStopping;
  return true;
}

inline bool androidAudioHostCompleteUserStop(
    AndroidAudioHostPairState* state, uint64_t epoch,
    bool uncertainty) noexcept {
  if (state == nullptr || state->epoch != epoch ||
      (state->teardownOwner != AndroidAudioHostTeardownOwner::User &&
       state->teardownOwner != AndroidAudioHostTeardownOwner::ErrorWorker)) {
    return false;
  }
  state->uncertainty = state->uncertainty || uncertainty;
  state->inputStarted = false;
  state->outputStarted = false;
  state->timestampSamplerStarted = false;
  state->phase = state->uncertainty
                     ? AndroidAudioHostPairPhase::Quarantined
                     : AndroidAudioHostPairPhase::Closed;
  return !state->uncertainty;
}

struct AndroidAudioHostErrorTeardownRequest {
  uint64_t generation{0};
  uint64_t pairEpoch{0};
  const void* failingStream{nullptr};
};

struct AndroidAudioHostErrorHandoffState {
  uint64_t requested{0};
  uint64_t completed{0};
  AndroidAudioHostErrorTeardownRequest pending{};
  bool shutdown{true};
};

inline AndroidAudioHostErrorTeardownRequest androidAudioHostRequestErrorTeardown(
    AndroidAudioHostErrorHandoffState* state, uint64_t pairEpoch,
    const void* failingStream) noexcept {
  if (state == nullptr || state->shutdown || pairEpoch == 0 ||
      failingStream == nullptr) {
    return {};
  }
  state->pending = {++state->requested, pairEpoch, failingStream};
  return state->pending;
}

inline AndroidAudioHostErrorTeardownRequest androidAudioHostTakeErrorTeardown(
    AndroidAudioHostErrorHandoffState* state) noexcept {
  if (state == nullptr || state->shutdown ||
      state->pending.generation == 0) {
    return {};
  }
  const AndroidAudioHostErrorTeardownRequest result = state->pending;
  state->pending = {};
  return result;
}

inline void androidAudioHostCompleteErrorTeardown(
    AndroidAudioHostErrorHandoffState* state,
    AndroidAudioHostErrorTeardownRequest request) noexcept {
  if (state != nullptr && request.generation > state->completed) {
    state->completed = request.generation;
  }
}

inline bool androidAudioHostErrorTeardownComplete(
    const AndroidAudioHostErrorHandoffState& state,
    AndroidAudioHostErrorTeardownRequest request) noexcept {
  return request.generation == 0 || state.completed >= request.generation ||
         state.shutdown;
}

}  // namespace singz::detail
