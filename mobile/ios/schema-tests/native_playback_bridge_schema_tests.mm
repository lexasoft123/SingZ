#import <Foundation/Foundation.h>

#import "NativePlaybackAuthorizedPath.h"
#import "NativePlaybackBridgeBoundary.h"
#import "NativePlaybackBridgeResult.h"
#import "NativePlaybackBridgeSchema.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <limits.h>
#include <memory>
#include <new>
#include <string>
#include <unistd.h>
#include <vector>

#define CHECK(value)                                                           \
  do {                                                                         \
    if (!(value)) {                                                            \
      std::fprintf(stderr, "schema CHECK failed at %s:%d: %s\n", __FILE__,     \
                   __LINE__, #value);                                          \
      std::abort();                                                            \
    }                                                                          \
  } while (false)

NSDictionary *validRequest() {
  return @{
    @"lanes" : @[ @{
      @"id" : @"vocals",
      @"path" : @"/app/song.flac",
      @"gain" : @1.0,
      @"muted" : @NO,
      @"solo" : @YES,
    } ],
    @"outputDeviceUid" : @"ios:current-output",
    @"outputChannels" : @[ @0, @1 ],
    @"sampleRate" : @48000,
    @"maximumFrames" : @512,
    @"bufferFrames" : @128,
    @"masterGain" : @0.5,
    @"maximumRetainedBytes" : @1048576,
  };
}

bool parses(NSDictionary *request) {
  SingzParsedPlaybackPrepare parsed;
  NSString *error = nil;
  return SingzParsePlaybackPrepare(request, &parsed, &error);
}

struct FakePrepareOwnership {
  uint64_t generation{7};
  size_t retainedBytes{0};
  bool cleanupPending{false};
  uint32_t failedAdmissions{0};
  uint32_t cancellations{0};
  uint32_t unloads{0};
  bool openMutation{false};
  bool startMutation{false};
  bool outputLease{false};
  bool running{false};
  bool uncertainCleanup{false};
  bool uncertainAdmission{false};
  uint32_t acknowledgements{0};
  singz::NativePlaybackDeliveryToken pending{};

  bool unload(uint64_t requested) noexcept {
    if (requested != generation)
      return false;
    ++unloads;
    retainedBytes = 0;
    cleanupPending = false;
    openMutation = false;
    startMutation = false;
    outputLease = false;
    running = false;
    pending = {};
    return true;
  }
};

singz::NativePlaybackCleanupResult
fakeCleanupResult(FakePrepareOwnership *fake,
                  singz::NativePlaybackCleanupSafety safety,
                  uint64_t generation) noexcept {
  singz::NativePlaybackCleanupResult result;
  result.safety = safety;
  result.error = safety == singz::NativePlaybackCleanupSafety::Uncertain
                     ? singz::NativePlaybackError::TeardownUncertain
                     : singz::NativePlaybackError::None;
  result.generation = generation;
  result.state = safety == singz::NativePlaybackCleanupSafety::Uncertain
                     ? singz::NativePlaybackState::Quarantined
                     : singz::NativePlaybackState::Unloaded;
  result.retainedBytes = fake == nullptr ? 0 : fake->retainedBytes;
  result.terminalReason =
      safety == singz::NativePlaybackCleanupSafety::Uncertain
          ? singz::AudioHostTerminalReason::ProviderFailure
          : singz::AudioHostTerminalReason::None;
  result.physicalOwnershipRetained =
      fake != nullptr && (fake->openMutation || fake->startMutation ||
                          fake->outputLease || fake->running);
  result.coordinatorEpoch = 11;
  result.coordinatorOwnerSession = 3;
  result.coordinatorOwnerGeneration = generation;
  if (safety == singz::NativePlaybackCleanupSafety::Complete) {
    result.coordinatorState =
        singz::NativePlaybackCoordinatorState::FallbackLeased;
    result.handoffLease = 29;
  } else if (safety == singz::NativePlaybackCleanupSafety::Uncertain) {
    result.coordinatorState = singz::NativePlaybackCoordinatorState::Poisoned;
  } else {
    result.coordinatorState =
        singz::NativePlaybackCoordinatorState::NativeOwned;
  }
  return result;
}

singz::NativePlaybackCleanupResult
fakeFailAdmission(void *opaque, uint64_t generation) noexcept {
  auto *fake = static_cast<FakePrepareOwnership *>(opaque);
  if (fake == nullptr || generation != fake->generation)
    return fakeCleanupResult(fake, singz::NativePlaybackCleanupSafety::NotOwned,
                             generation);
  ++fake->failedAdmissions;
  fake->retainedBytes = 0;
  fake->cleanupPending = true;
  if (fake->uncertainAdmission)
    return fakeCleanupResult(
        fake, singz::NativePlaybackCleanupSafety::Uncertain, generation);
  // Production failClaimedPrepare resolves the admission and immediately
  // performs the matching unload. Mirror that full callback contract here;
  // leaving cleanupPending while returning Complete would be a false global
  // fallback proof.
  (void)fake->unload(generation);
  return fakeCleanupResult(fake, singz::NativePlaybackCleanupSafety::Complete,
                           generation);
}

singz::NativePlaybackCleanupResult
fakeCancelAndUnload(void *opaque, uint64_t generation) noexcept {
  auto *fake = static_cast<FakePrepareOwnership *>(opaque);
  if (fake == nullptr || generation != fake->generation)
    return fakeCleanupResult(fake, singz::NativePlaybackCleanupSafety::NotOwned,
                             generation);
  ++fake->cancellations;
  if (fake->uncertainCleanup)
    return fakeCleanupResult(
        fake, singz::NativePlaybackCleanupSafety::Uncertain, generation);
  (void)fake->unload(generation);
  return fakeCleanupResult(fake, singz::NativePlaybackCleanupSafety::Complete,
                           generation);
}

bool fakeAcknowledgeDelivery(
    void *opaque, singz::NativePlaybackDeliveryToken token) noexcept {
  auto *fake = static_cast<FakePrepareOwnership *>(opaque);
  if (fake == nullptr || !token.valid() ||
      token.generation != fake->generation ||
      token.generation != fake->pending.generation ||
      token.serial != fake->pending.serial ||
      token.command != fake->pending.command)
    return false;
  ++fake->acknowledgements;
  fake->pending = {};
  return true;
}

singz::NativePlaybackCleanupResult
fakeAbortDelivery(void *opaque,
                  singz::NativePlaybackDeliveryToken token) noexcept {
  auto *fake = static_cast<FakePrepareOwnership *>(opaque);
  if (fake == nullptr || !token.valid() ||
      token.generation != fake->generation ||
      token.generation != fake->pending.generation ||
      token.serial != fake->pending.serial ||
      token.command != fake->pending.command)
    return fakeCleanupResult(fake, singz::NativePlaybackCleanupSafety::NotOwned,
                             token.generation);
  fake->pending = {};
  return fakeCancelAndUnload(opaque, token.generation);
}

singz::NativePlaybackCleanupResult throwingPrepareCleanup(void *, uint64_t) {
  throw std::bad_alloc();
}

singz::NativePlaybackCleanupResult
throwingCommandCleanup(void *, singz::NativePlaybackDeliveryToken) {
  @throw [NSException exceptionWithName:@"CleanupFailure"
                                 reason:@"fixture"
                               userInfo:nil];
}

struct PrepareFault {
  SingzPlaybackPrepareFaultPoint target{};
  bool objectiveC{false};
  int capturedDescriptor{-1};
  uint32_t hits{0};
};

void injectPrepareFault(void *opaque, SingzPlaybackPrepareFaultPoint point,
                        int descriptor) {
  auto *fault = static_cast<PrepareFault *>(opaque);
  if (fault == nullptr || point != fault->target)
    return;
  ++fault->hits;
  if (descriptor >= 0)
    fault->capturedDescriptor = descriptor;
  if (fault->objectiveC) {
    @throw [NSException exceptionWithName:@"InjectedPrepareBridgeFailure"
                                   reason:@"ownership fixture"
                                 userInfo:nil];
  }
  throw std::bad_alloc();
}

void testPrepareOwnershipGuard() {
  const std::vector<SingzPlaybackPrepareFaultPoint> beforeMutation{
      SingzPlaybackPrepareFaultPoint::AfterGenerationClaim,
      SingzPlaybackPrepareFaultPoint::LaneVectorConstruction,
      SingzPlaybackPrepareFaultPoint::PathConstruction,
      SingzPlaybackPrepareFaultPoint::DescriptorConstruction,
      SingzPlaybackPrepareFaultPoint::PostDescriptorOpen,
  };
  for (size_t index = 0; index < beforeMutation.size(); ++index) {
    FakePrepareOwnership fake;
    PrepareFault fault{beforeMutation[index], index % 2 != 0};
    SingzPlaybackPrepareFaultHook hook{&fault, &injectPrepareFault};
    gSingzPlaybackPrepareFaultHook.store(&hook, std::memory_order_release);
    {
      SingzPlaybackPrepareOwnershipGuard guard;
      guard.activate({&fake, &fakeFailAdmission, &fakeCancelAndUnload},
                     fake.generation);
      const auto failure = SingzPlaybackBridgeBoundary(
          [&] { SingzPlaybackInjectPrepareFault(beforeMutation[index]); });
      CHECK(failure != SingzPlaybackBridgeBoundaryFailure::None);
    }
    gSingzPlaybackPrepareFaultHook.store(nullptr, std::memory_order_release);
    CHECK(fake.failedAdmissions == 1 && fake.cancellations == 0 &&
          fake.unloads == 1 && fake.retainedBytes == 0 && !fake.cleanupPending);
  }

  for (const auto point : {
           SingzPlaybackPrepareFaultPoint::PostPreparePreResult,
           SingzPlaybackPrepareFaultPoint::ResultDictionaryConversion,
           SingzPlaybackPrepareFaultPoint::PrePromiseResolve,
       }) {
    FakePrepareOwnership fake;
    fake.retainedBytes = 659u * 1024u * 1024u;
    PrepareFault fault{
        point, point == SingzPlaybackPrepareFaultPoint::PrePromiseResolve};
    SingzPlaybackPrepareFaultHook hook{&fault, &injectPrepareFault};
    gSingzPlaybackPrepareFaultHook.store(&hook, std::memory_order_release);
    {
      SingzPlaybackPrepareOwnershipGuard guard;
      guard.activate({&fake, &fakeFailAdmission, &fakeCancelAndUnload},
                     fake.generation);
      guard.markSessionMutation();
      const auto failure = SingzPlaybackBridgeBoundary(
          [&] { SingzPlaybackInjectPrepareFault(point); });
      CHECK(failure != SingzPlaybackBridgeBoundaryFailure::None);
    }
    gSingzPlaybackPrepareFaultHook.store(nullptr, std::memory_order_release);
    CHECK(fake.failedAdmissions == 0 && fake.cancellations == 1 &&
          fake.unloads == 1 && fake.retainedBytes == 0 && !fake.cleanupPending);
    CHECK(fake.unload(fake.generation));
  }

  FakePrepareOwnership delivered;
  delivered.retainedBytes = 1024;
  {
    SingzPlaybackPrepareOwnershipGuard guard;
    guard.activate({&delivered, &fakeFailAdmission, &fakeCancelAndUnload},
                   delivered.generation);
    guard.markSessionMutation();
    guard.markDelivered();
  }
  CHECK(delivered.retainedBytes == 1024 && delivered.unloads == 0);
}

void testActualBlockCopyGuard() {
  FakePrepareOwnership fake;
  PrepareFault fault{SingzPlaybackPrepareFaultPoint::BlockCaptureCopy};
  SingzPlaybackPrepareFaultHook hook{&fault, &injectPrepareFault};
  gSingzPlaybackPrepareFaultHook.store(&hook, std::memory_order_release);
  {
    SingzPlaybackPrepareOwnershipGuard guard;
    guard.activate({&fake, &fakeFailAdmission, &fakeCancelAndUnload},
                   fake.generation);
    const auto failure = SingzPlaybackBridgeBoundary([&] {
      // The sentinel must be local to this lexical block scope. Capturing an
      // outer C++ lambda reference would only copy the pointer, making the
      // fault injection vacuous.
      SingzPlaybackPrepareBlockCopySentinel sentinel;
      void (^stackBlock)(void) = ^{
        sentinel.touch();
      };
      id copiedBlock = [stackBlock copy];
      (void)copiedBlock;
    });
    CHECK(failure == SingzPlaybackBridgeBoundaryFailure::ResourceExhausted);
  }
  gSingzPlaybackPrepareFaultHook.store(nullptr, std::memory_order_release);
  CHECK(fault.hits != 0 && fake.failedAdmissions == 1 && fake.unloads == 1 &&
        fake.retainedBytes == 0 && !fake.cleanupPending);
}

void testPrepareOuterBoundaryVerdict() {
  const SingzPlaybackPrepareFaultPoint points[]{
      SingzPlaybackPrepareFaultPoint::AfterGenerationClaim,
      SingzPlaybackPrepareFaultPoint::PrepareGuardAllocation,
      SingzPlaybackPrepareFaultPoint::PrepareBlockCaptureConstruction,
      SingzPlaybackPrepareFaultPoint::BlockCaptureCopy,
      SingzPlaybackPrepareFaultPoint::PrepareDispatch,
  };
  for (const SingzPlaybackPrepareFaultPoint point : points) {
    for (const bool uncertain : {false, true}) {
      FakePrepareOwnership fake;
      fake.uncertainAdmission = uncertain;
      PrepareFault fault{
          point, point == SingzPlaybackPrepareFaultPoint::PrepareDispatch};
      SingzPlaybackPrepareFaultHook hook{&fault, &injectPrepareFault};
      gSingzPlaybackPrepareFaultHook.store(&hook, std::memory_order_release);

      SingzPlaybackPrepareOwnershipGuard claimed;
      std::shared_ptr<SingzPlaybackPrepareOwnershipGuard> transferred;
      const auto failure = SingzPlaybackBridgeBoundary([&] {
        const SingzPlaybackPrepareCleanup cleanup{&fake, &fakeFailAdmission,
                                                  &fakeCancelAndUnload};
        claimed.activate(cleanup, fake.generation);
        SingzPlaybackInjectPrepareFault(
            SingzPlaybackPrepareFaultPoint::AfterGenerationClaim);
        SingzPlaybackInjectPrepareFault(
            SingzPlaybackPrepareFaultPoint::PrepareGuardAllocation);
        transferred = std::make_shared<SingzPlaybackPrepareOwnershipGuard>();
        transferred->activate(cleanup, fake.generation);
        claimed.dismiss();
        SingzPlaybackInjectPrepareFault(
            SingzPlaybackPrepareFaultPoint::PrepareBlockCaptureConstruction);
        SingzPlaybackPrepareBlockCopySentinel sentinel;
        SingzPlaybackInjectPrepareFault(
            SingzPlaybackPrepareFaultPoint::PrepareDispatch);
        // This is the real libdispatch block-copy path used by the bridge. A
        // BlockCaptureCopy fault comes from the captured C++ sentinel's copy
        // constructor, not from a pre-copy test hook.
        dispatch_queue_t queue =
            dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);
        dispatch_async(queue, ^{
          sentinel.touch();
        });
      });
      const auto outer = SingzPlaybackFinishPrepareOuterBoundary(
          failure, claimed, transferred.get());
      gSingzPlaybackPrepareFaultHook.store(nullptr, std::memory_order_release);

      CHECK(failure != SingzPlaybackBridgeBoundaryFailure::None &&
            outer.cleanupRequired && fault.hits == 1 &&
            fake.failedAdmissions == 1);
      if (uncertain) {
        CHECK(outer.cleanup.safety ==
                  singz::NativePlaybackCleanupSafety::Uncertain &&
              outer.cleanup.error ==
                  singz::NativePlaybackError::TeardownUncertain &&
              !outer.cleanup.globallyComplete() && fake.cleanupPending &&
              fake.unloads == 0);
      } else {
        CHECK(outer.cleanup.safety ==
                  singz::NativePlaybackCleanupSafety::Complete &&
              outer.cleanup.globallyComplete() && !fake.cleanupPending &&
              fake.unloads == 1);
      }
    }
  }

  // Cleanup callback exceptions are contained by the same integrated outer
  // path and become a stable non-fallback-safe verdict.
  {
    SingzPlaybackPrepareOwnershipGuard claimed;
    const auto failure = SingzPlaybackBridgeBoundary([&] {
      claimed.activate({nullptr, &throwingPrepareCleanup, nullptr}, 7);
      throw std::bad_alloc();
    });
    const auto outer =
        SingzPlaybackFinishPrepareOuterBoundary(failure, claimed);
    CHECK(outer.cleanupRequired &&
          outer.cleanup.safety ==
              singz::NativePlaybackCleanupSafety::Uncertain &&
          !outer.cleanup.globallyComplete());
  }

  // NotOwned describes only this claim. The outer boundary retains it so the
  // bridge rejects teardown-uncertain instead of treating it as fallback-safe.
  {
    FakePrepareOwnership fake;
    SingzPlaybackPrepareOwnershipGuard claimed;
    const auto failure = SingzPlaybackBridgeBoundary([&] {
      claimed.activate({&fake, &fakeFailAdmission, &fakeCancelAndUnload}, 8);
      throw std::bad_alloc();
    });
    const auto outer =
        SingzPlaybackFinishPrepareOuterBoundary(failure, claimed);
    CHECK(outer.cleanupRequired &&
          outer.cleanup.safety ==
              singz::NativePlaybackCleanupSafety::NotOwned &&
          !outer.cleanup.globallyComplete());
  }
}

void testCommandMutationOwnershipGuard() {
  struct Fixture {
    SingzPlaybackPrepareFaultPoint point;
    bool start;
    bool objectiveC;
  };
  const Fixture fixtures[]{
      {SingzPlaybackPrepareFaultPoint::OpenResultDictionaryConversion, false,
       false},
      {SingzPlaybackPrepareFaultPoint::OpenPromiseDelivery, false, true},
      {SingzPlaybackPrepareFaultPoint::StartResultDictionaryConversion, true,
       false},
      {SingzPlaybackPrepareFaultPoint::StartPromiseDelivery, true, true},
  };
  for (const Fixture &fixture : fixtures) {
    FakePrepareOwnership fake;
    fake.retainedBytes = 659u * 1024u * 1024u;
    fake.openMutation = !fixture.start;
    fake.startMutation = fixture.start;
    fake.outputLease = true;
    fake.running = fixture.start;
    fake.pending = {fake.generation, fixture.start ? 22u : 11u,
                    fixture.start
                        ? singz::NativePlaybackDeliveryCommand::Start
                        : singz::NativePlaybackDeliveryCommand::OpenOutput};
    PrepareFault fault{fixture.point, fixture.objectiveC};
    SingzPlaybackPrepareFaultHook hook{&fault, &injectPrepareFault};
    gSingzPlaybackPrepareFaultHook.store(&hook, std::memory_order_release);
    {
      SingzPlaybackCommandDeliveryGuard guard(
          {&fake, &fakeAcknowledgeDelivery, &fakeAbortDelivery});
      *guard.tokenOutput() = fake.pending;
      const auto failure = SingzPlaybackBridgeBoundary([&] {
        NSDictionary *dictionary = @{@"ok" : @YES};
        (void)dictionary;
        SingzPlaybackInjectPrepareFault(fixture.point);
      });
      CHECK(failure != SingzPlaybackBridgeBoundaryFailure::None);
      const auto cleanup = guard.cleanupNow();
      CHECK(cleanup.safety == singz::NativePlaybackCleanupSafety::Complete &&
            cleanup.globallyComplete());
    }
    gSingzPlaybackPrepareFaultHook.store(nullptr, std::memory_order_release);
    CHECK(fault.hits == 1 && fake.cancellations == 1 && fake.unloads == 1 &&
          fake.retainedBytes == 0 && !fake.outputLease && !fake.running &&
          !fake.openMutation && !fake.startMutation);
  }

  // Duplicate/precondition failures never receive a command token. A later
  // result-conversion or promise-delivery exception therefore cannot stop the
  // already-valid same-generation stream.
  for (const Fixture &fixture : fixtures) {
    FakePrepareOwnership fake;
    fake.retainedBytes = 1024;
    fake.outputLease = true;
    fake.running = fixture.start;
    PrepareFault fault{fixture.point, fixture.objectiveC};
    SingzPlaybackPrepareFaultHook hook{&fault, &injectPrepareFault};
    gSingzPlaybackPrepareFaultHook.store(&hook, std::memory_order_release);
    SingzPlaybackCommandDeliveryGuard guard(
        {&fake, &fakeAcknowledgeDelivery, &fakeAbortDelivery});
    const auto failure = SingzPlaybackBridgeBoundary([&] {
      NSDictionary *dictionary = @{@"ok" : @NO};
      (void)dictionary;
      SingzPlaybackInjectPrepareFault(fixture.point);
    });
    gSingzPlaybackPrepareFaultHook.store(nullptr, std::memory_order_release);
    CHECK(failure != SingzPlaybackBridgeBoundaryFailure::None &&
          fault.hits == 1);
    const auto cleanup = guard.cleanupNow();
    CHECK(cleanup.safety == singz::NativePlaybackCleanupSafety::NotOwned &&
          !cleanup.globallyComplete());
    CHECK(fake.cancellations == 0 && fake.unloads == 0 &&
          fake.retainedBytes == 1024 && fake.outputLease &&
          fake.running == fixture.start);
  }

  // A successful delivery explicitly acknowledges the exact token. Duplicate
  // ack/abort is inert and physical ownership remains active.
  {
    FakePrepareOwnership fake;
    fake.retainedBytes = 1024;
    fake.outputLease = true;
    fake.pending = {fake.generation, 31,
                    singz::NativePlaybackDeliveryCommand::OpenOutput};
    SingzPlaybackCommandDeliveryGuard guard(
        {&fake, &fakeAcknowledgeDelivery, &fakeAbortDelivery});
    *guard.tokenOutput() = fake.pending;
    const auto delivered = guard.token();
    CHECK(guard.acknowledge() && fake.acknowledgements == 1 &&
          fake.outputLease && fake.retainedBytes == 1024);
    CHECK(fakeAbortDelivery(&fake, delivered).safety ==
          singz::NativePlaybackCleanupSafety::NotOwned);
  }

  // A forced cleanup that cannot prove quiescence is a hard, stable
  // non-fallback-safe verdict with retained ownership details.
  {
    FakePrepareOwnership fake;
    fake.retainedBytes = 659u * 1024u * 1024u;
    fake.outputLease = true;
    fake.uncertainCleanup = true;
    fake.pending = {fake.generation, 41,
                    singz::NativePlaybackDeliveryCommand::OpenOutput};
    SingzPlaybackCommandDeliveryGuard guard(
        {&fake, &fakeAcknowledgeDelivery, &fakeAbortDelivery});
    *guard.tokenOutput() = fake.pending;
    const auto cleanup = guard.cleanupNow();
    CHECK(cleanup.safety == singz::NativePlaybackCleanupSafety::Uncertain &&
          cleanup.error == singz::NativePlaybackError::TeardownUncertain &&
          cleanup.state == singz::NativePlaybackState::Quarantined &&
          cleanup.retainedBytes == 659u * 1024u * 1024u &&
          !cleanup.globallyComplete() && fake.cancellations == 1 &&
          fake.unloads == 0 && fake.outputLease);
  }

  // Guard destructors/cleanup methods are genuine C++ and Objective-C
  // no-throw boundaries even if a future cleanup callback regresses.
  {
    SingzPlaybackPrepareOwnershipGuard guard;
    guard.activate({nullptr, nullptr, &throwingPrepareCleanup}, 7);
    guard.markSessionMutation();
    const auto cleanup = guard.cleanupNow();
    CHECK(cleanup.safety == singz::NativePlaybackCleanupSafety::Uncertain &&
          !cleanup.globallyComplete());
  }
  {
    SingzPlaybackCommandDeliveryGuard guard(
        {nullptr, nullptr, &throwingCommandCleanup});
    *guard.tokenOutput() = {7, 99,
                            singz::NativePlaybackDeliveryCommand::OpenOutput};
    const auto cleanup = guard.cleanupNow();
    CHECK(cleanup.safety == singz::NativePlaybackCleanupSafety::Uncertain &&
          !cleanup.globallyComplete());
  }
}

void testStopUnloadDeliveryGuard() {
  struct Fixture {
    SingzPlaybackPrepareFaultPoint point;
    bool blockCopy;
    bool objectiveC;
  };
  const Fixture fixtures[]{
      {SingzPlaybackPrepareFaultPoint::StopBlockCaptureCopy, true, false},
      {SingzPlaybackPrepareFaultPoint::StopResultDictionaryConversion, false,
       false},
      {SingzPlaybackPrepareFaultPoint::StopPrePromiseResolve, false, true},
      {SingzPlaybackPrepareFaultPoint::StopPromiseDelivery, false, false},
      {SingzPlaybackPrepareFaultPoint::UnloadBlockCaptureCopy, true, false},
      {SingzPlaybackPrepareFaultPoint::UnloadResultDictionaryConversion, false,
       true},
      {SingzPlaybackPrepareFaultPoint::UnloadPrePromiseResolve, false, false},
      {SingzPlaybackPrepareFaultPoint::UnloadPromiseDelivery, false, true},
  };
  for (const Fixture &fixture : fixtures) {
    FakePrepareOwnership fake;
    fake.retainedBytes = 659u * 1024u * 1024u;
    fake.openMutation = true;
    fake.outputLease = true;
    fake.running = true;
    PrepareFault fault{fixture.point, fixture.objectiveC};
    SingzPlaybackPrepareFaultHook hook{&fault, &injectPrepareFault};
    gSingzPlaybackPrepareFaultHook.store(&hook, std::memory_order_release);
    SingzPlaybackGenerationDeliveryGuard guard;
    guard.activate({&fake, &fakeCancelAndUnload}, fake.generation);
    const auto failure = SingzPlaybackBridgeBoundary([&] {
      if (fixture.blockCopy) {
        SingzPlaybackPrepareBlockCopySentinel sentinel(fixture.point);
        void (^stackBlock)(void) = ^{
          sentinel.touch();
        };
        id copiedBlock = [stackBlock copy];
        (void)copiedBlock;
      } else {
        NSDictionary *dictionary = @{@"ok" : @YES};
        (void)dictionary;
        SingzPlaybackInjectPrepareFault(fixture.point);
      }
    });
    gSingzPlaybackPrepareFaultHook.store(nullptr, std::memory_order_release);
    CHECK(failure != SingzPlaybackBridgeBoundaryFailure::None &&
          fault.hits == 1);
    const auto cleanup = guard.cleanupNow();
    CHECK(cleanup.safety == singz::NativePlaybackCleanupSafety::Complete &&
          cleanup.globallyComplete() && fake.cancellations == 1 &&
          fake.unloads == 1 && fake.retainedBytes == 0 && !fake.openMutation &&
          !fake.startMutation && !fake.outputLease && !fake.running);
  }

  // Both cleanup commands preserve the same hard verdict when their retry
  // cannot prove provider quiescence. The bridge maps this to
  // E_NATIVE_PLAYBACK_TEARDOWN_UNCERTAIN rather than allowing fallback.
  for (const auto point : {
           SingzPlaybackPrepareFaultPoint::StopPromiseDelivery,
           SingzPlaybackPrepareFaultPoint::UnloadPromiseDelivery,
       }) {
    FakePrepareOwnership fake;
    fake.retainedBytes = 659u * 1024u * 1024u;
    fake.outputLease = true;
    fake.uncertainCleanup = true;
    PrepareFault fault{point, false};
    SingzPlaybackPrepareFaultHook hook{&fault, &injectPrepareFault};
    gSingzPlaybackPrepareFaultHook.store(&hook, std::memory_order_release);
    SingzPlaybackGenerationDeliveryGuard guard;
    guard.activate({&fake, &fakeCancelAndUnload}, fake.generation);
    const auto failure = SingzPlaybackBridgeBoundary(
        [&] { SingzPlaybackInjectPrepareFault(point); });
    gSingzPlaybackPrepareFaultHook.store(nullptr, std::memory_order_release);
    CHECK(failure == SingzPlaybackBridgeBoundaryFailure::ResourceExhausted);
    const auto cleanup = guard.cleanupNow();
    CHECK(cleanup.safety == singz::NativePlaybackCleanupSafety::Uncertain &&
          cleanup.error == singz::NativePlaybackError::TeardownUncertain &&
          cleanup.retainedBytes != 0 && cleanup.physicalOwnershipRetained &&
          !cleanup.globallyComplete() && fake.cancellations == 1 &&
          fake.unloads == 0 && fault.hits == 1);
  }

  // A successfully delivered stop result intentionally keeps its stopped
  // media owner; the guard must not turn normal stop into unload.
  {
    FakePrepareOwnership fake;
    fake.retainedBytes = 1024;
    SingzPlaybackGenerationDeliveryGuard guard;
    guard.activate({&fake, &fakeCancelAndUnload}, fake.generation);
    guard.markDelivered();
    CHECK(guard.cleanupNow().safety ==
              singz::NativePlaybackCleanupSafety::NotOwned &&
          fake.cancellations == 0 && fake.unloads == 0 &&
          fake.retainedBytes == 1024);
  }
}

void testPostOpenDescriptorOwnership() {
  NSString *path = [NSTemporaryDirectory()
      stringByAppendingPathComponent:@"singz-bridge-fd-owner.tmp"];
  CHECK([@"fd" writeToFile:path
                atomically:YES
                  encoding:NSUTF8StringEncoding
                     error:nil]);
  char canonicalRoot[PATH_MAX]{};
  CHECK(realpath(NSTemporaryDirectory().fileSystemRepresentation,
                 canonicalRoot) != nullptr);
  const std::vector<std::string> roots{canonicalRoot};
  PrepareFault fault{SingzPlaybackPrepareFaultPoint::PostDescriptorOpen};
  SingzPlaybackPrepareFaultHook hook{&fault, &injectPrepareFault};
  gSingzPlaybackPrepareFaultHook.store(&hook, std::memory_order_release);
  const auto failure = SingzPlaybackBridgeBoundary([&] {
    std::string error;
    auto descriptor =
        SingzOpenAuthorizedPlaybackPathAtRoots(path, roots, &error);
    (void)descriptor;
  });
  gSingzPlaybackPrepareFaultHook.store(nullptr, std::memory_order_release);
  CHECK(failure == SingzPlaybackBridgeBoundaryFailure::ResourceExhausted);
  CHECK(fault.hits == 1 && fault.capturedDescriptor >= 0);
  errno = 0;
  CHECK(fcntl(fault.capturedDescriptor, F_GETFD) == -1 && errno == EBADF);
  CHECK([NSFileManager.defaultManager removeItemAtPath:path error:nil]);
}

NSDictionary *replacing(NSString *key, id value) {
  NSMutableDictionary *request = [validRequest() mutableCopy];
  request[key] = value;
  return request;
}

NSDictionary *replacingLane(NSString *key, id value) {
  NSMutableDictionary *request = [validRequest() mutableCopy];
  NSMutableDictionary *lane = [request[@"lanes"][0] mutableCopy];
  lane[key] = value;
  request[@"lanes"] = @[ lane ];
  return request;
}

NSString *loneSurrogate() {
  const unichar value = 0xD800;
  return [NSString stringWithCharacters:&value length:1];
}

NSString *embeddedNull() {
  const unichar value[]{'a', 0, 'b'};
  return [NSString stringWithCharacters:value length:3];
}

void testUnloadCleanupResultSchema() {
  singz::NativePlaybackResult result;
  result.ok = true;
  result.error = singz::NativePlaybackError::None;
  result.generation = 7;
  result.state = singz::NativePlaybackState::Unloaded;

  singz::NativePlaybackCleanupResult complete;
  complete.safety = singz::NativePlaybackCleanupSafety::Complete;
  complete.generation = 7;
  complete.coordinatorState =
      singz::NativePlaybackCoordinatorState::FallbackLeased;
  complete.coordinatorEpoch = 12;
  complete.coordinatorOwnerSession = 3;
  complete.coordinatorOwnerGeneration = 7;
  complete.handoffLease = 41;
  NSDictionary *dictionary =
      SingzNativePlaybackUnloadResultDictionary(result, complete);
  NSDictionary *cleanup = dictionary[@"cleanup"];
  CHECK([dictionary[@"ok"] isEqual:@YES] &&
        [dictionary[@"generation"] isEqual:@7] &&
        [cleanup[@"safety"] isEqual:@"complete"] &&
        [cleanup[@"error"] isEqual:@"none"] &&
        [cleanup[@"generation"] isEqual:@7] &&
        [cleanup[@"state"] isEqual:@"unloaded"] &&
        [cleanup[@"retainedBytes"] isEqual:@0] &&
        [cleanup[@"physicalOwnershipRetained"] isEqual:@NO] &&
        [cleanup[@"processQuarantineRetainedBytes"] isEqual:@0] &&
        [cleanup[@"processQuarantineReserved"] isEqual:@NO] &&
        [cleanup[@"processQuarantinePoisoned"] isEqual:@NO] &&
        [cleanup[@"terminalReason"] isEqual:@"none"] &&
        [cleanup[@"coordinatorState"] isEqual:@"fallback-leased"] &&
        [cleanup[@"coordinatorEpoch"] isEqual:@12] &&
        [cleanup[@"coordinatorOwnerSession"] isEqual:@3] &&
        [cleanup[@"coordinatorOwnerGeneration"] isEqual:@7] &&
        [cleanup[@"handoffLease"] isEqual:@41] &&
        [cleanup[@"globallyComplete"] isEqual:@YES] &&
        [cleanup[@"fallbackSafe"] isEqual:@YES]);

  // A normal old-generation retirement may complete a previously accepted
  // newer unload. Keep the public result generation and the nested exact
  // cleanup-proof generation independent so the handoff lease cannot be
  // accidentally attributed to the retired graph.
  singz::NativePlaybackResult retiredOld = result;
  retiredOld.generation = 1;
  singz::NativePlaybackCleanupResult deferredNewer = complete;
  deferredNewer.generation = 2;
  deferredNewer.coordinatorOwnerGeneration = 2;
  deferredNewer.handoffLease = 43;
  dictionary =
      SingzNativePlaybackUnloadResultDictionary(retiredOld, deferredNewer);
  cleanup = dictionary[@"cleanup"];
  CHECK([dictionary[@"generation"] isEqual:@1] &&
        [cleanup[@"generation"] isEqual:@2] &&
        [cleanup[@"coordinatorOwnerGeneration"] isEqual:@2] &&
        [cleanup[@"handoffLease"] isEqual:@43] &&
        [cleanup[@"globallyComplete"] isEqual:@YES] &&
        [cleanup[@"fallbackSafe"] isEqual:@YES]);

  singz::NativePlaybackCleanupResult blocked = complete;
  blocked.safety = singz::NativePlaybackCleanupSafety::NotOwned;
  blocked.retainedBytes = 4096;
  blocked.processQuarantineRetainedBytes = 4096;
  blocked.processQuarantineReserved = true;
  blocked.coordinatorState = singz::NativePlaybackCoordinatorState::NativeOwned;
  blocked.handoffLease = 0;
  cleanup = SingzNativePlaybackCleanupDictionary(blocked);
  CHECK([cleanup[@"safety"] isEqual:@"not-owned"] &&
        [cleanup[@"retainedBytes"] isEqual:@4096] &&
        [cleanup[@"processQuarantineReserved"] isEqual:@YES] &&
        [cleanup[@"coordinatorState"] isEqual:@"native-owned"] &&
        [cleanup[@"handoffLease"] isEqual:@0] &&
        [cleanup[@"globallyComplete"] isEqual:@NO] &&
        [cleanup[@"fallbackSafe"] isEqual:@NO]);

  singz::NativePlaybackCleanupResult poisoned = blocked;
  poisoned.safety = singz::NativePlaybackCleanupSafety::Uncertain;
  poisoned.error = singz::NativePlaybackError::TeardownUncertain;
  poisoned.processQuarantineReserved = false;
  poisoned.processQuarantinePoisoned = true;
  poisoned.coordinatorState = singz::NativePlaybackCoordinatorState::Poisoned;
  poisoned.terminalReason = singz::AudioHostTerminalReason::ProviderFailure;
  cleanup = SingzNativePlaybackCleanupDictionary(poisoned);
  CHECK([cleanup[@"safety"] isEqual:@"uncertain"] &&
        [cleanup[@"error"] isEqual:@"teardown-uncertain"] &&
        [cleanup[@"processQuarantinePoisoned"] isEqual:@YES] &&
        [cleanup[@"coordinatorState"] isEqual:@"poisoned"] &&
        [cleanup[@"terminalReason"] isEqual:@"provider-failure"] &&
        [cleanup[@"globallyComplete"] isEqual:@NO] &&
        [cleanup[@"fallbackSafe"] isEqual:@NO]);
}

int main() {
  @autoreleasepool {
    testActualBlockCopyGuard();
    testPrepareOuterBoundaryVerdict();
    testCommandMutationOwnershipGuard();
    testStopUnloadDeliveryGuard();
    testPostOpenDescriptorOwnership();
    uint64_t generation = 0;
    CHECK(SingzParsePlaybackGeneration(@1, &generation) && generation == 1);
    for (id invalid in @[ @YES, @1.5, @0, @(-1), @"1", NSNull.null ]) {
      CHECK(!SingzParsePlaybackGeneration(invalid, &generation));
      CHECK(generation == 0);
    }

    CHECK(parses(validRequest()));
    SingzParsedPlaybackPrepare leasedPrepare;
    NSString *leasedError = nil;
    CHECK(SingzParsePlaybackPrepare(replacing(@"handoffLease", @41),
                                    &leasedPrepare, &leasedError) &&
          leasedPrepare.config.handoffLease == 41);
    for (id invalid in @[ @YES, @"48000", NSNull.null ])
      CHECK(!parses(replacing(@"sampleRate", invalid)));
    for (id invalid in @[ @YES, @"512", NSNull.null ])
      CHECK(!parses(replacing(@"maximumFrames", invalid)));
    for (id invalid in @[ @YES, @"1048576", NSNull.null ])
      CHECK(!parses(replacing(@"maximumRetainedBytes", invalid)));
    for (id invalid in @[
           @YES, @"41", @0, @1.5, NSNull.null,
           @(singz::kNativePlaybackMaximumJsSafeInteger + 1)
         ])
      CHECK(!parses(replacing(@"handoffLease", invalid)));
    CHECK(parses(replacing(@"handoffLease", @41)));
    for (id invalid in @[ @YES, @1, NSNull.null ])
      CHECK(!parses(replacing(@"outputDeviceUid", invalid)));
    for (id invalid in @[ @YES, @"0,1", NSNull.null ])
      CHECK(!parses(replacing(@"outputChannels", invalid)));
    CHECK(!parses(replacing(@"outputChannels", @[ @0, @YES ])));
    CHECK(!parses(replacing(@"outputChannels", @[ @0, @0 ])));
    CHECK(!parses(
        replacing(@"outputChannels", @[ @(singz::kAudioHostMaxChannels) ])));
    CHECK(!parses(replacing(@"lanes", NSNull.null)));
    CHECK(!parses(replacingLane(@"id", @1)));
    CHECK(!parses(replacingLane(@"path", NSNull.null)));
    CHECK(!parses(replacingLane(@"gain", @YES)));
    CHECK(!parses(replacingLane(@"muted", @1)));
    CHECK(!parses(replacingLane(@"solo", NSNull.null)));
    NSMutableDictionary *unknown = [validRequest() mutableCopy];
    unknown[@"unexpected"] = @1;
    CHECK(!parses(unknown));

    SingzParsedPlaybackPrepare reusedPrepare;
    NSString *parseError = nil;
    CHECK(
        SingzParsePlaybackPrepare(validRequest(), &reusedPrepare, &parseError));
    CHECK(reusedPrepare.config.maximumFrames == 512 &&
          reusedPrepare.config.requestedBufferFrames == 128 &&
          reusedPrepare.config.masterGain == 0.5F &&
          reusedPrepare.config.handoffLease == 0);
    NSDictionary *minimal = @{
      @"lanes" : @[ @{@"id" : @"vocals", @"path" : @"/app/song.flac"} ],
      @"outputDeviceUid" : @"ios:current-output",
      @"outputChannels" : @[ @0, @1 ],
      @"sampleRate" : @48000,
    };
    CHECK(SingzParsePlaybackPrepare(minimal, &reusedPrepare, &parseError));
    CHECK(reusedPrepare.config.maximumFrames == 4096 &&
          reusedPrepare.config.requestedBufferFrames == 0 &&
          reusedPrepare.config.masterGain == 1.0F &&
          reusedPrepare.config.handoffLease == 0 &&
          reusedPrepare.lanes.size() == 1 &&
          reusedPrepare.lanes[0].gain == 1.0F &&
          !reusedPrepare.lanes[0].muted && !reusedPrepare.lanes[0].solo);
    CHECK(!SingzParsePlaybackPrepare(replacing(@"lanes", NSNull.null),
                                     &reusedPrepare, &parseError));
    CHECK(reusedPrepare.lanes.empty() &&
          reusedPrepare.config.outputDeviceUid.empty() && parseError != nil);
    CHECK(SingzParsePlaybackPrepare(minimal, &reusedPrepare, &parseError) &&
          parseError == nil);
    NSMutableDictionary *lateFailure = [validRequest() mutableCopy];
    lateFailure[@"lanes"] = @[
      validRequest()[@"lanes"][0],
      @{
        @"id" : @"bad",
        @"path" : @"/app/bad.flac",
        @"gain" : @1.0,
        @"muted" : @NO,
        @"solo" : @1
      },
    ];
    CHECK(!SingzParsePlaybackPrepare(lateFailure, &reusedPrepare, &parseError));
    CHECK(reusedPrepare.lanes.empty() &&
          reusedPrepare.config.outputDeviceUid.empty() &&
          reusedPrepare.config.outputChannels.empty());
    NSString *malformedString = loneSurrogate();
    CHECK(malformedString.length == 1 && malformedString.UTF8String == nullptr);
    for (NSDictionary *malformed in @[
           replacing(@"outputDeviceUid", malformedString),
           replacingLane(@"id", malformedString),
           replacingLane(@"path", malformedString),
         ]) {
      CHECK(SingzParsePlaybackPrepare(validRequest(), &reusedPrepare,
                                      &parseError));
      CHECK(!SingzParsePlaybackPrepare(malformed, &reusedPrepare, &parseError));
      CHECK(reusedPrepare.lanes.empty() &&
            reusedPrepare.config.outputDeviceUid.empty() &&
            reusedPrepare.config.outputChannels.empty() && parseError != nil);
    }
    NSString *nulString = embeddedNull();
    CHECK(nulString.length == 3);
    for (NSDictionary *malformed in @[
           replacing(@"outputDeviceUid", nulString),
           replacingLane(@"id", nulString),
           replacingLane(@"path", nulString),
         ]) {
      CHECK(SingzParsePlaybackPrepare(validRequest(), &reusedPrepare,
                                      &parseError));
      CHECK(!SingzParsePlaybackPrepare(malformed, &reusedPrepare, &parseError));
      CHECK(reusedPrepare.lanes.empty() &&
            reusedPrepare.config.outputDeviceUid.empty() &&
            reusedPrepare.config.outputChannels.empty() && parseError != nil);
    }
    parseError = @"stale";
    CHECK(!SingzParsePlaybackPrepare(validRequest(), nullptr, &parseError) &&
          parseError != nil && ![parseError isEqualToString:@"stale"]);

    SingzParsedPlaybackControl control;
    CHECK(SingzParsePlaybackControl(
        @{
          @"laneId" : @"vocals",
          @"gain" : @1.0,
          @"muted" : @NO,
          @"solo" : @YES
        },
        &control));
    CHECK(control.lane && control.solo && !control.muted);
    CHECK(SingzParsePlaybackControl(@{@"masterGain" : @0.5}, &control));
    CHECK(!control.lane && control.laneId.empty() && !control.muted &&
          !control.solo && control.gain == 0.5F);
    CHECK(!SingzParsePlaybackControl(
        @{@"laneId" : @"vocals",
          @"masterGain" : @0.5},
        &control));
    CHECK(!SingzParsePlaybackControl(
        @{@"laneId" : @"vocals",
          @"gain" : @1.0,
          @"muted" : @1,
          @"solo" : @NO},
        &control));
    CHECK(!control.lane && control.laneId.empty() && control.gain == 0.0F &&
          !control.muted && !control.solo);
    CHECK(!SingzParsePlaybackControl(@{@"masterGain" : @YES}, &control));
    CHECK(!SingzParsePlaybackControl(
        @{@"masterGain" : @0.5,
          @"unexpected" : @1},
        &control));
    CHECK(!control.lane && control.laneId.empty() && control.gain == 0.0F &&
          !control.muted && !control.solo);
    CHECK(SingzParsePlaybackControl(
        @{@"laneId" : @"vocals",
          @"gain" : @1.0,
          @"muted" : @NO,
          @"solo" : @NO},
        &control));
    CHECK(!SingzParsePlaybackControl(
        @{
          @"laneId" : malformedString,
          @"gain" : @1.0,
          @"muted" : @NO,
          @"solo" : @NO
        },
        &control));
    CHECK(!control.lane && control.laneId.empty() && control.gain == 0.0F &&
          !control.muted && !control.solo);
    CHECK(SingzParsePlaybackControl(
        @{@"laneId" : @"vocals",
          @"gain" : @1.0,
          @"muted" : @NO,
          @"solo" : @NO},
        &control));
    CHECK(!SingzParsePlaybackControl(
        @{@"laneId" : nulString,
          @"gain" : @1.0,
          @"muted" : @NO,
          @"solo" : @NO},
        &control));
    CHECK(!control.lane && control.laneId.empty() && control.gain == 0.0F &&
          !control.muted && !control.solo);

    CHECK(SingzPlaybackBridgeBoundary([] {}) ==
          SingzPlaybackBridgeBoundaryFailure::None);
    CHECK(SingzPlaybackBridgeBoundary([] { throw std::bad_alloc(); }) ==
          SingzPlaybackBridgeBoundaryFailure::ResourceExhausted);
    CHECK(SingzPlaybackBridgeBoundary([] { throw 7; }) ==
          SingzPlaybackBridgeBoundaryFailure::ProviderFailure);
    CHECK(SingzPlaybackBridgeBoundary([] {
            @throw [NSException exceptionWithName:@"InjectedBridgeFailure"
                                           reason:@"fixture"
                                         userInfo:nil];
          }) == SingzPlaybackBridgeBoundaryFailure::ProviderFailure);
    testPrepareOwnershipGuard();
    testUnloadCleanupResultSchema();
  }
  std::puts("native playback bridge schema tests: ok");
  return 0;
}
