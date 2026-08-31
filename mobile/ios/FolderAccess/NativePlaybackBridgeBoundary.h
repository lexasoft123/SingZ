#pragma once

#import <Foundation/Foundation.h>

#import <SingzPlaybackSession/native_playback_session.h>

#include <atomic>
#include <cstdint>
#include <new>
#include <utility>

enum class SingzPlaybackBridgeBoundaryFailure : unsigned int {
  None = 0,
  ResourceExhausted,
  ProviderFailure,
};

enum class SingzPlaybackPrepareFaultPoint : unsigned int {
  AfterGenerationClaim,
  PrepareGuardAllocation,
  PrepareBlockCaptureConstruction,
  BlockCaptureCopy,
  PrepareDispatch,
  LaneVectorConstruction,
  PathConstruction,
  DescriptorConstruction,
  PostDescriptorOpen,
  PostPreparePreResult,
  ResultDictionaryConversion,
  PrePromiseResolve,
  OpenResultDictionaryConversion,
  OpenPromiseDelivery,
  StartResultDictionaryConversion,
  StartPromiseDelivery,
  StopBlockCaptureCopy,
  StopResultDictionaryConversion,
  StopPrePromiseResolve,
  StopPromiseDelivery,
  UnloadBlockCaptureCopy,
  UnloadResultDictionaryConversion,
  UnloadPrePromiseResolve,
  UnloadPromiseDelivery,
};

struct SingzPlaybackPrepareFaultHook {
  void* context{nullptr};
  void (*inject)(void*, SingzPlaybackPrepareFaultPoint, int){nullptr};
};

inline std::atomic<SingzPlaybackPrepareFaultHook*>
    gSingzPlaybackPrepareFaultHook{nullptr};

inline void SingzPlaybackInjectPrepareFault(
    SingzPlaybackPrepareFaultPoint point, int descriptor = -1) {
  SingzPlaybackPrepareFaultHook* hook =
      gSingzPlaybackPrepareFaultHook.load(std::memory_order_acquire);
  if (hook != nullptr && hook->inject != nullptr)
    hook->inject(hook->context, point, descriptor);
}

// A C++ capture with a non-trivial copy helper forces the Objective-C block
// runtime to execute this copy constructor when dispatch_async copies the
// stack block. The normally-null fault hook makes production copies trivial;
// tests inject at the real block-copy boundary rather than immediately before
// the block literal.
class SingzPlaybackPrepareBlockCopySentinel final {
 public:
  explicit SingzPlaybackPrepareBlockCopySentinel(
      SingzPlaybackPrepareFaultPoint point =
          SingzPlaybackPrepareFaultPoint::BlockCaptureCopy) noexcept
      : point_(point) {}
  SingzPlaybackPrepareBlockCopySentinel(
      const SingzPlaybackPrepareBlockCopySentinel& other)
      : point_(other.point_) {
    SingzPlaybackInjectPrepareFault(point_);
  }
  SingzPlaybackPrepareBlockCopySentinel& operator=(
      const SingzPlaybackPrepareBlockCopySentinel&) = delete;
  uint32_t touch() const noexcept { return marker_; }

 private:
  // Volatile makes the block's use observable so Clang cannot erase the C++
  // capture (and therefore its copy helper) as an empty object.
  volatile uint32_t marker_{0x53494e47u};
  SingzPlaybackPrepareFaultPoint point_{
      SingzPlaybackPrepareFaultPoint::BlockCaptureCopy};
};

// ObjC++/RCT and GCD are exception-free ABI boundaries even though Foundation
// collection construction and C++ value conversion may allocate. Keep this
// small helper Foundation-only so the malformed-schema runner can exercise
// both C++ and Objective-C exceptional exits without linking React Native.
template <typename Callable>
SingzPlaybackBridgeBoundaryFailure SingzPlaybackBridgeBoundary(
    Callable&& callable) noexcept {
  @try {
    try {
      std::forward<Callable>(callable)();
      return SingzPlaybackBridgeBoundaryFailure::None;
    } catch (const std::bad_alloc&) {
      return SingzPlaybackBridgeBoundaryFailure::ResourceExhausted;
    } catch (...) {
      return SingzPlaybackBridgeBoundaryFailure::ProviderFailure;
    }
  } @catch (NSException*) {
    return SingzPlaybackBridgeBoundaryFailure::ProviderFailure;
  }
}

inline singz::NativePlaybackCleanupResult SingzPlaybackUncertainCleanup(
    uint64_t generation) noexcept {
  return {singz::NativePlaybackCleanupSafety::Uncertain,
          singz::NativePlaybackError::TeardownUncertain,
          generation,
          singz::NativePlaybackState::Quarantined,
          0,
          singz::AudioHostTerminalReason::ProviderFailure,
          true};
}

struct SingzPlaybackPrepareCleanup {
  void* context{nullptr};
  singz::NativePlaybackCleanupResult (*failAdmission)(
      void*, uint64_t){nullptr};
  singz::NativePlaybackCleanupResult (*cancelAndUnload)(
      void*, uint64_t){nullptr};
};

inline singz::NativePlaybackCleanupResult SingzPlaybackNoCleanup(
    uint64_t generation = 0) noexcept {
  singz::NativePlaybackCleanupResult result;
  result.generation = generation;
  return result;
}

// Activated immediately after generation claim and transferred into the GCD
// block before that block is constructed. An exceptional exit before the
// session mutates completes failed admission, preserving exact-generation
// cleanup. Once prepare/failPrepareAdmission begins, exceptional delivery
// synchronously cancels and unloads so decoded owners never become orphaned.
class SingzPlaybackPrepareOwnershipGuard final {
 public:
  SingzPlaybackPrepareOwnershipGuard() noexcept = default;
  ~SingzPlaybackPrepareOwnershipGuard() noexcept { cleanupNow(); }
  SingzPlaybackPrepareOwnershipGuard(
      const SingzPlaybackPrepareOwnershipGuard&) = delete;
  SingzPlaybackPrepareOwnershipGuard& operator=(
      const SingzPlaybackPrepareOwnershipGuard&) = delete;

  void activate(SingzPlaybackPrepareCleanup cleanup,
                uint64_t generation) noexcept {
    cleanup_ = cleanup;
    generation_ = generation;
    phase_ = Phase::Claimed;
  }

  void markSessionMutation() noexcept {
    if (phase_ == Phase::Claimed) phase_ = Phase::Mutating;
  }

  void markDelivered() noexcept { phase_ = Phase::Inactive; }

  void dismiss() noexcept { phase_ = Phase::Inactive; }

  [[nodiscard]] bool ownsCleanup() const noexcept {
    return phase_ != Phase::Inactive;
  }

  singz::NativePlaybackCleanupResult cleanupNow() noexcept {
    const Phase phase = phase_;
    phase_ = Phase::Inactive;
    if (phase == Phase::Claimed && cleanup_.failAdmission != nullptr) {
      singz::NativePlaybackCleanupResult result =
          SingzPlaybackUncertainCleanup(generation_);
      const auto failure = SingzPlaybackBridgeBoundary(
          [&] { result = cleanup_.failAdmission(cleanup_.context, generation_); });
      return failure == SingzPlaybackBridgeBoundaryFailure::None
                 ? result
                 : SingzPlaybackUncertainCleanup(generation_);
    } else if (phase == Phase::Mutating &&
               cleanup_.cancelAndUnload != nullptr) {
      singz::NativePlaybackCleanupResult result =
          SingzPlaybackUncertainCleanup(generation_);
      const auto failure = SingzPlaybackBridgeBoundary([&] {
        result = cleanup_.cancelAndUnload(cleanup_.context, generation_);
      });
      return failure == SingzPlaybackBridgeBoundaryFailure::None
                 ? result
                 : SingzPlaybackUncertainCleanup(generation_);
    }
    return SingzPlaybackNoCleanup(generation_);
  }

 private:
  enum class Phase : uint32_t { Inactive, Claimed, Mutating };
  SingzPlaybackPrepareCleanup cleanup_{};
  uint64_t generation_{0};
  Phase phase_{Phase::Inactive};
};

struct SingzPlaybackPrepareOuterBoundaryResult {
  SingzPlaybackBridgeBoundaryFailure failure{
      SingzPlaybackBridgeBoundaryFailure::None};
  singz::NativePlaybackCleanupResult cleanup{};
  bool cleanupRequired{false};
};

// Retains the cleanup verdict after the whole post-claim/pre-dispatch region
// has crossed SingzPlaybackBridgeBoundary. Both guards live outside that
// caught callable: `claimed` owns the generation until ownership transfers to
// the shared GCD-block guard, and `transferred` owns it thereafter. An
// exceptional exit therefore cannot destroy the active owner and discard its
// verdict before React receives it. Explicit cleanup makes the destructor
// inert; the destructor remains a final noexcept fail-closed backstop.
inline SingzPlaybackPrepareOuterBoundaryResult
SingzPlaybackFinishPrepareOuterBoundary(
    SingzPlaybackBridgeBoundaryFailure failure,
    SingzPlaybackPrepareOwnershipGuard& claimed,
    SingzPlaybackPrepareOwnershipGuard* transferred = nullptr) noexcept {
  SingzPlaybackPrepareOuterBoundaryResult result;
  result.failure = failure;
  SingzPlaybackPrepareOwnershipGuard* active =
      transferred != nullptr && transferred->ownsCleanup() ? transferred
                                                            : &claimed;
  if (failure != SingzPlaybackBridgeBoundaryFailure::None &&
      active->ownsCleanup()) {
    result.cleanupRequired = true;
    result.cleanup = active->cleanupNow();
  }
  return result;
}

struct SingzPlaybackCommandDeliveryCleanup {
  void* context{nullptr};
  bool (*acknowledge)(void*, singz::NativePlaybackDeliveryToken){nullptr};
  singz::NativePlaybackCleanupResult (*abort)(
      void*, singz::NativePlaybackDeliveryToken){nullptr};
};

// Owns one native command-delivery capability. Native writes the token only
// after all command preconditions pass and it admits the host mutation. A
// duplicate/precondition failure therefore leaves token() invalid and cleanup
// cannot touch a previously valid stream of the same generation.
class SingzPlaybackCommandDeliveryGuard final {
 public:
  explicit SingzPlaybackCommandDeliveryGuard(
      SingzPlaybackCommandDeliveryCleanup cleanup) noexcept
      : cleanup_(cleanup) {}
  ~SingzPlaybackCommandDeliveryGuard() noexcept { (void)cleanupNow(); }
  SingzPlaybackCommandDeliveryGuard(
      const SingzPlaybackCommandDeliveryGuard&) = delete;
  SingzPlaybackCommandDeliveryGuard& operator=(
      const SingzPlaybackCommandDeliveryGuard&) = delete;

  singz::NativePlaybackDeliveryToken* tokenOutput() noexcept {
    return &token_;
  }

  [[nodiscard]] singz::NativePlaybackDeliveryToken token() const noexcept {
    return token_;
  }

  bool acknowledge() noexcept {
    if (!active_ || !token_.valid() || cleanup_.acknowledge == nullptr)
      return false;
    bool acknowledged = false;
    const auto failure = SingzPlaybackBridgeBoundary(
        [&] { acknowledged = cleanup_.acknowledge(cleanup_.context, token_); });
    if (failure != SingzPlaybackBridgeBoundaryFailure::None || !acknowledged)
      return false;
    active_ = false;
    token_ = {};
    return true;
  }

  void dismissUnmutated() noexcept {
    if (!token_.valid()) active_ = false;
  }

  singz::NativePlaybackCleanupResult cleanupNow() noexcept {
    if (!active_) return SingzPlaybackNoCleanup(token_.generation);
    active_ = false;
    const singz::NativePlaybackDeliveryToken token = token_;
    token_ = {};
    if (!token.valid() || cleanup_.abort == nullptr)
      return SingzPlaybackNoCleanup(token.generation);
    singz::NativePlaybackCleanupResult result =
        SingzPlaybackUncertainCleanup(token.generation);
    const auto failure = SingzPlaybackBridgeBoundary(
        [&] { result = cleanup_.abort(cleanup_.context, token); });
    return failure == SingzPlaybackBridgeBoundaryFailure::None
               ? result
               : SingzPlaybackUncertainCleanup(token.generation);
  }

 private:
  SingzPlaybackCommandDeliveryCleanup cleanup_{};
  singz::NativePlaybackDeliveryToken token_{};
  bool active_{true};
};

struct SingzPlaybackGenerationDeliveryCleanup {
  void* context{nullptr};
  singz::NativePlaybackCleanupResult (*cancelAndUnload)(
      void*, uint64_t){nullptr};
};

// Stop and unload are already cleanup commands, but their result still
// crosses allocating ObjC/RCT and block-copy boundaries. Until that result is
// delivered, this guard owns an exact-generation retry. Its callback may
// unload only that generation; NotOwned is deliberately not treated as proof
// that the backend is globally empty.
class SingzPlaybackGenerationDeliveryGuard final {
 public:
  SingzPlaybackGenerationDeliveryGuard() noexcept = default;
  ~SingzPlaybackGenerationDeliveryGuard() noexcept { (void)cleanupNow(); }
  SingzPlaybackGenerationDeliveryGuard(
      const SingzPlaybackGenerationDeliveryGuard&) = delete;
  SingzPlaybackGenerationDeliveryGuard& operator=(
      const SingzPlaybackGenerationDeliveryGuard&) = delete;

  void activate(SingzPlaybackGenerationDeliveryCleanup cleanup,
                uint64_t generation) noexcept {
    cleanup_ = cleanup;
    generation_ = generation;
    active_ = true;
  }

  void markDelivered() noexcept { active_ = false; }

  singz::NativePlaybackCleanupResult cleanupNow() noexcept {
    if (!active_) return SingzPlaybackNoCleanup(generation_);
    active_ = false;
    if (generation_ == 0 || cleanup_.cancelAndUnload == nullptr)
      return SingzPlaybackNoCleanup(generation_);
    singz::NativePlaybackCleanupResult result =
        SingzPlaybackUncertainCleanup(generation_);
    const auto failure = SingzPlaybackBridgeBoundary([&] {
      result = cleanup_.cancelAndUnload(cleanup_.context, generation_);
    });
    return failure == SingzPlaybackBridgeBoundaryFailure::None
               ? result
               : SingzPlaybackUncertainCleanup(generation_);
  }

 private:
  SingzPlaybackGenerationDeliveryCleanup cleanup_{};
  uint64_t generation_{0};
  bool active_{false};
};
