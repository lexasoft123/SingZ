#import <Foundation/Foundation.h>

#import "NativePlaybackAudioSession.h"
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

NSDictionary *validPlayback() {
  return @{
    @"version" : @2,
    @"transport" : @{
      @"entrySeconds" : @1.0,
      @"durationSeconds" : @4.0,
      @"playbackRate" : @1.0,
      @"transposeSemitones" : @0.0,
    },
    @"cues" : @{
      @"click" : @YES,
      @"countInBars" : @1,
      @"volume" : @0.7,
      @"accent" : @YES,
      @"beatGrid" : @{
        @"beats" : @[ @0.0, @0.5, @1.0, @1.5, @2.0, @2.5, @3.0, @3.5 ],
        @"beatsPerBar" : @4,
        @"downbeat" : @0,
        @"downbeats" : @[ @0, @4 ],
      },
    },
  };
}

NSDictionary *withPlayback(NSDictionary *playback) {
  NSMutableDictionary *request = [validRequest() mutableCopy];
  request[@"playback"] = playback;
  return request;
}

NSDictionary *withTraining(NSDictionary *training) {
  NSMutableDictionary *request = [validRequest() mutableCopy];
  request[@"training"] = training;
  return request;
}

NSDictionary *withInitialTransport(NSDictionary *initialTransport) {
  NSMutableDictionary *request = [validRequest() mutableCopy];
  request[@"initialTransport"] = initialTransport;
  return request;
}

NSDictionary *replacingObjectKey(NSDictionary *object, NSString *key,
                                 id value) {
  NSMutableDictionary *copy = [object mutableCopy];
  copy[key] = value;
  return copy;
}

NSDictionary *replacingPlaybackTransport(NSString *key, id value) {
  NSDictionary *playback = validPlayback();
  return withPlayback(replacingObjectKey(
      playback, @"transport",
      replacingObjectKey(playback[@"transport"], key, value)));
}

NSDictionary *replacingPlaybackCues(NSString *key, id value) {
  NSDictionary *playback = validPlayback();
  return withPlayback(replacingObjectKey(
      playback, @"cues", replacingObjectKey(playback[@"cues"], key, value)));
}

NSDictionary *replacingPlaybackGrid(NSString *key, id value) {
  NSDictionary *playback = validPlayback();
  NSDictionary *cues = playback[@"cues"];
  NSDictionary *grid = cues[@"beatGrid"];
  return withPlayback(replacingObjectKey(
      playback, @"cues",
      replacingObjectKey(cues, @"beatGrid",
                         replacingObjectKey(grid, key, value))));
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

// What this schema deliberately does NOT check.
//
// The validation matrix in docs/NATIVE-PLAYBACK-BRIDGE.md section 9 has the
// core as its authoritative row: a bridge may reject earlier for a better
// error message, but the core is what actually enforces. Two of that matrix's
// "no" cells belong to this file, and until now they were an assertion about
// code nobody had asked. Android's schema rejects a duplicate lane ID; this
// one accepts it and lets prepare fail with InvalidConfiguration and the
// message "Playback lane IDs must be unique".
//
// So this test asserts the ACCEPTANCE. If someone adds the check here — a
// reasonable thing to want — this goes red, and the matrix has to be updated
// in the same change rather than quietly becoming wrong.
void testWhatTheSchemaLeavesToTheCore() {
  NSMutableDictionary *duplicated = [validRequest() mutableCopy];
  NSDictionary *lane = @{
    @"id" : @"vocals",
    @"path" : @"/app/other.flac",
    @"gain" : @1.0,
    @"muted" : @NO,
    @"solo" : @NO,
  };
  duplicated[@"lanes"] = @[ ((NSArray *)validRequest()[@"lanes"]).firstObject, lane ];
  CHECK(parses(duplicated));

  // The lanes really are duplicates by ID, so the acceptance above is the
  // interesting kind rather than an accident of the fixture.
  NSArray *lanes = duplicated[@"lanes"];
  CHECK(lanes.count == 2);
  CHECK([lanes[0][@"id"] isEqualToString:lanes[1][@"id"]]);
  CHECK(![lanes[0][@"path"] isEqualToString:lanes[1][@"path"]]);
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

void testPlaybackResultErrorMapping() {
  singz::NativePlaybackResult result;
  result.ok = false;
  result.error = singz::NativePlaybackError::UnsupportedPlaybackRate;
  result.generation = 9;
  result.state = singz::NativePlaybackState::Preparing;
  NSDictionary *dictionary = SingzNativePlaybackResultDictionary(result);
  CHECK([dictionary[@"ok"] isEqual:@NO] &&
        [dictionary[@"error"] isEqual:@"unsupported-playback-rate"] &&
        [dictionary[@"generation"] isEqual:@9] &&
        [dictionary[@"state"] isEqual:@"preparing"]);
}

void testPlaybackAudioSessionPolicy() {
  const SingzPlaybackAudioSessionIntent intent{
      7, "ios-output:fixture", {0, 1}, 48000.0, 512};
  const SingzPlaybackAudioSessionSnapshot active{
      "AVAudioSessionCategoryPlayback",
      "AVAudioSessionModeDefault",
      0,
      true,
      1,
      "ios-output:fixture",
      2,
      48000.0,
      128,
  };

  auto result = SingzPlaybackAudioSessionPreflight(
      7, 7, 0, singz::NativePlaybackState::Prepared, intent);
  CHECK(result.ok && result.error == SingzPlaybackAudioSessionError::None);
  result = SingzVerifyPlaybackAudioSession(
      7, singz::NativePlaybackState::Prepared, intent, active);
  CHECK(result.ok && result.error == SingzPlaybackAudioSessionError::None &&
        result.session.active && result.session.outputChannelCount == 2);
  NSDictionary *dictionary = SingzPlaybackAudioSessionResultDictionary(result);
  CHECK(dictionary.count == 9 && [dictionary[@"ok"] isEqual:@YES] &&
        [dictionary[@"error"] isEqual:@"none"] &&
        [dictionary[@"generation"] isEqual:@7] &&
        [dictionary[@"state"] isEqual:@"prepared"] &&
        [dictionary[@"sampleRate"] isEqual:@48000] &&
        [dictionary[@"maximumFrames"] isEqual:@512] &&
        [dictionary[@"nominalBufferFrames"] isEqual:@128] &&
        [dictionary[@"outputChannels"] isEqual:@2] &&
        [dictionary[@"message"] isEqual:@""]);

  result = SingzPlaybackAudioSessionPreflight(
      7, 8, 0, singz::NativePlaybackState::Prepared, intent);
  CHECK(!result.ok &&
        result.error == SingzPlaybackAudioSessionError::InvalidGeneration);
  result = SingzPlaybackAudioSessionPreflight(
      7, 7, 7, singz::NativePlaybackState::Prepared, intent);
  CHECK(!result.ok &&
        result.error == SingzPlaybackAudioSessionError::InvalidState);
  result = SingzPlaybackAudioSessionPreflight(
      7, 7, 0, singz::NativePlaybackState::OutputOpen, intent);
  CHECK(!result.ok &&
        result.error == SingzPlaybackAudioSessionError::InvalidState);

  const auto verifyFailure = [&](SingzPlaybackAudioSessionSnapshot snapshot) {
    const auto failure = SingzVerifyPlaybackAudioSession(
        7, singz::NativePlaybackState::Prepared, intent, std::move(snapshot));
    CHECK(!failure.ok &&
          failure.error == SingzPlaybackAudioSessionError::VerificationFailed &&
          !failure.message.empty());
  };
  auto malformed = active;
  malformed.active = false;
  verifyFailure(malformed);
  malformed = active;
  malformed.category = "AVAudioSessionCategoryPlayAndRecord";
  verifyFailure(malformed);
  malformed = active;
  malformed.mode = "AVAudioSessionModeMeasurement";
  verifyFailure(malformed);
  malformed = active;
  malformed.categoryOptions = 1;
  verifyFailure(malformed);
  malformed = active;
  malformed.outputRouteCount = 2;
  verifyFailure(malformed);
  malformed = active;
  malformed.outputDeviceUid = "ios-output:other";
  verifyFailure(malformed);
  malformed = active;
  malformed.outputChannelCount = 1;
  verifyFailure(malformed);
  malformed = active;
  malformed.sampleRate = 44100.0;
  verifyFailure(malformed);
}

void testPlaybackTransportCueSchema() {
  SingzParsedPlaybackPrepare parsed;
  NSString *error = nil;
  CHECK(SingzParsePlaybackPrepare(withPlayback(validPlayback()), &parsed,
                                  &error));
  CHECK(error == nil && parsed.config.cuePlan.has_value());
  const auto &plan = *parsed.config.cuePlan;
  CHECK(plan.sampleRate == 48000.0 && plan.entrySeconds == 1.0 &&
        plan.durationSeconds == singz::kPlaybackCueMaximumDurationSeconds &&
        plan.playbackRate == 1.0 && plan.click && plan.countInBars == 1 &&
        plan.volume == 0.7 && plan.accent &&
        plan.beatGrid.beats.size() == 8 &&
        plan.beatGrid.downbeats == std::vector<uint32_t>({0, 4}));

  NSMutableDictionary *rebuild = [withPlayback(validPlayback()) mutableCopy];
  rebuild[@"preparedStartProjectFrame"] = @(-24000);
  CHECK(SingzParsePlaybackPrepare(rebuild, &parsed, &error) &&
        parsed.config.preparedStartProjectFrame.has_value() &&
        *parsed.config.preparedStartProjectFrame == -24000);
  for (id invalid in @[
         @0.5,
         @9007199254740992.0,
         @(-9007199254740992.0),
         @YES,
         @"0",
       ]) {
    NSMutableDictionary *candidate = [withPlayback(validPlayback()) mutableCopy];
    candidate[@"preparedStartProjectFrame"] = invalid;
    CHECK(!SingzParsePlaybackPrepare(candidate, &parsed, &error));
  }

  NSDictionary *playbackWithoutDuration = replacingObjectKey(
      validPlayback(), @"transport", @{
        @"entrySeconds" : @1.0,
        @"playbackRate" : @1.0,
        @"transposeSemitones" : @0.0,
      });
  CHECK(SingzParsePlaybackPrepare(withPlayback(playbackWithoutDuration),
                                  &parsed, &error));
  CHECK(parsed.config.cuePlan->durationSeconds ==
        singz::kPlaybackCueMaximumDurationSeconds);

  NSDictionary *gridless = replacingObjectKey(
      validPlayback(), @"cues", @{
        @"click" : @NO,
        @"countInBars" : @2,
        @"volume" : @0.25,
        @"accent" : @NO,
      });
  CHECK(SingzParsePlaybackPrepare(withPlayback(gridless), &parsed, &error));
  CHECK(parsed.config.cuePlan.has_value() &&
        parsed.config.cuePlan->beatGrid.beats.empty() &&
        parsed.config.cuePlan->countInBars == 2 &&
        !parsed.config.cuePlan->click);

  NSDictionary *transportOnly = replacingObjectKey(
      gridless, @"cues", @{
        @"click" : @NO,
        @"countInBars" : @0,
        @"volume" : @0.0,
        @"accent" : @YES,
      });
  CHECK(
      SingzParsePlaybackPrepare(withPlayback(transportOnly), &parsed, &error));
  CHECK(parsed.config.cuePlan.has_value() &&
        parsed.config.cuePlan->countInBars == 0 &&
        parsed.config.cuePlan->beatGrid.beats.empty());

  NSDictionary *gridCountInOnly = replacingPlaybackCues(@"click", @NO);
  CHECK(SingzParsePlaybackPrepare(gridCountInOnly, &parsed, &error));
  CHECK(parsed.config.cuePlan.has_value() && !parsed.config.cuePlan->click &&
        parsed.config.cuePlan->beatGrid.beats.size() == 8);

  NSMutableDictionary *sampleRateRequest =
      [withPlayback(validPlayback()) mutableCopy];
  sampleRateRequest[@"sampleRate"] = @44100;
  CHECK(SingzParsePlaybackPrepare(sampleRateRequest, &parsed, &error));
  CHECK(parsed.config.cuePlan->sampleRate == 44100.0);

  const auto rejects = [&](NSDictionary *request) {
    CHECK(SingzParsePlaybackPrepare(withPlayback(validPlayback()), &parsed,
                                    &error));
    CHECK(!SingzParsePlaybackPrepare(request, &parsed, &error));
    CHECK(error != nil && !parsed.config.cuePlan.has_value() &&
          parsed.lanes.empty() && parsed.config.outputDeviceUid.empty());
  };

  for (id invalid in @[ @YES, @0, @1, @3, @1.5, @"2", NSNull.null ])
    rejects(
        withPlayback(replacingObjectKey(validPlayback(), @"version", invalid)));
  for (NSString *key in @[ @"transport", @"cues" ]) {
    for (id invalid in @[ @YES, @1, @"object", NSNull.null ])
      rejects(withPlayback(replacingObjectKey(validPlayback(), key, invalid)));
  }
  for (NSString *key in
       @[ @"entrySeconds", @"durationSeconds", @"playbackRate",
          @"transposeSemitones" ]) {
    for (id invalid in @[
           @YES, @"1", NSNull.null, [NSNumber numberWithDouble:NAN],
           [NSNumber numberWithDouble:INFINITY]
         ])
      rejects(replacingPlaybackTransport(key, invalid));
  }
  rejects(replacingPlaybackTransport(@"entrySeconds", @(-1)));
  // The count-in anchor is optional; set, it must be a finite non-negative
  // second count and reaches the plan request as given.
  for (id invalid in @[
         @YES, @"1", NSNull.null, @(-0.5), [NSNumber numberWithDouble:NAN],
         [NSNumber numberWithDouble:INFINITY]
       ])
    rejects(replacingPlaybackTransport(@"countInAnchorSeconds", invalid));
  CHECK(SingzParsePlaybackPrepare(
      replacingPlaybackTransport(@"countInAnchorSeconds", @2.5), &parsed,
      &error));
  CHECK(parsed.config.cuePlan->countInAnchorSeconds == 2.5);
  CHECK(SingzParsePlaybackPrepare(withPlayback(validPlayback()), &parsed,
                                  &error) &&
        parsed.config.cuePlan.has_value() &&
        parsed.config.cuePlan->countInAnchorSeconds < 0.0);
  rejects(replacingPlaybackTransport(@"durationSeconds", @0));
  rejects(replacingPlaybackTransport(@"durationSeconds", @43200.1));
  CHECK(SingzParsePlaybackPrepare(
      replacingPlaybackTransport(@"durationSeconds", @0.5), &parsed, &error));
  CHECK(parsed.config.cuePlan->durationSeconds ==
        singz::kPlaybackCueMaximumDurationSeconds);
  rejects(replacingPlaybackTransport(@"playbackRate", @0.249));
  rejects(replacingPlaybackTransport(@"playbackRate", @4.001));
  rejects(replacingPlaybackTransport(@"transposeSemitones", @(-24.001)));
  rejects(replacingPlaybackTransport(@"transposeSemitones", @24.001));
  CHECK(SingzParsePlaybackPrepare(
      replacingPlaybackTransport(@"transposeSemitones", @(-24.0)), &parsed,
      &error));
  CHECK(parsed.config.transposeSemitones == -24.0);
  NSMutableDictionary *missingTranspose = [validPlayback() mutableCopy];
  NSMutableDictionary *missingTransposeTransport =
      [missingTranspose[@"transport"] mutableCopy];
  [missingTransposeTransport removeObjectForKey:@"transposeSemitones"];
  missingTranspose[@"transport"] = missingTransposeTransport;
  rejects(withPlayback(missingTranspose));
  rejects(replacingPlaybackTransport(@"futureTransposeMode", @"formant"));

  for (id invalid in @[ @1, @"true", NSNull.null ]) {
    rejects(replacingPlaybackCues(@"click", invalid));
    rejects(replacingPlaybackCues(@"accent", invalid));
  }
  for (id invalid in @[
         @YES, @(-1), @3, @1.5, @"1", NSNull.null,
         @(singz::kNativePlaybackMaximumJsSafeInteger + 1)
       ])
    rejects(replacingPlaybackCues(@"countInBars", invalid));
  for (id invalid in @[
         @YES, @(-0.01), @1.01, @"0.7", NSNull.null,
         [NSNumber numberWithDouble:NAN]
       ])
    rejects(replacingPlaybackCues(@"volume", invalid));

  NSDictionary *gridlessClick = replacingObjectKey(
      validPlayback(), @"cues", @{
        @"click" : @YES,
        @"countInBars" : @0,
        @"volume" : @0.7,
        @"accent" : @YES,
      });
  rejects(withPlayback(gridlessClick));
  for (id invalid in @[ @YES, @1, @"grid", NSNull.null ])
    rejects(replacingPlaybackCues(@"beatGrid", invalid));
  for (id invalid in @[ @YES, @1, @"beats", NSNull.null ])
    rejects(replacingPlaybackGrid(@"beats", invalid));
  for (id invalid in @[ @YES, @1, @"downbeats", NSNull.null ])
    rejects(replacingPlaybackGrid(@"downbeats", invalid));
  rejects(replacingPlaybackGrid(@"beats", @[ @0.0, @1.0, @0.5 ]));
  rejects(replacingPlaybackGrid(@"beats", @[ @0.0, @0.05, @0.5 ]));
  rejects(replacingPlaybackGrid(@"beats", @[ @0.0, @0.19, @0.38 ]));
  rejects(replacingPlaybackGrid(@"beats", @[ @0.0, @2.01, @4.02 ]));
  rejects(replacingPlaybackGrid(@"beats", @[ @0.0, @43200.1 ]));
  rejects(replacingPlaybackGrid(
      @"beats", @[ @0.0, [NSNumber numberWithDouble:NAN], @1.0 ]));
  rejects(replacingPlaybackGrid(@"beats", @[ @0.0 ]));
  for (id invalid in @[ @YES, @1, @5, @7, @3.5, @"4", NSNull.null ])
    rejects(replacingPlaybackGrid(@"beatsPerBar", invalid));
  for (id invalid in @[ @YES, @4, @(-1), @1.5, @"0", NSNull.null ])
    rejects(replacingPlaybackGrid(@"downbeat", invalid));
  rejects(replacingPlaybackGrid(@"downbeats", @[ @4, @0 ]));
  rejects(replacingPlaybackGrid(@"downbeats", @[ @0, @8 ]));
  rejects(replacingPlaybackGrid(@"downbeats", @[ @0, @0 ]));
  rejects(replacingPlaybackGrid(@"downbeats", @[ @0, @1.5 ]));
  rejects(replacingPlaybackGrid(
      @"downbeats",
      @[ @0, @(singz::kNativePlaybackMaximumJsSafeInteger + 1) ]));

  NSMutableArray *tooManyBeats = [NSMutableArray array];
  for (NSUInteger index = 0; index <= singz::kPlaybackCueMaximumBeats; ++index)
    [tooManyBeats addObject:@(static_cast<double>(index) * 0.5)];
  rejects(replacingPlaybackGrid(@"beats", tooManyBeats));

  NSDictionary *denseGrid = @{
    @"beats" : @[ @0.0, @0.21, @0.42 ],
    @"beatsPerBar" : @4,
    @"downbeat" : @0,
    @"downbeats" : @[],
  };
  NSDictionary *durationHintDoesNotSynthesizeClicks = replacingObjectKey(
      validPlayback(), @"transport", @{
        @"entrySeconds" : @0.0,
        @"durationSeconds" : @10000.0,
        @"playbackRate" : @1.0,
        @"transposeSemitones" : @0.0,
      });
  durationHintDoesNotSynthesizeClicks = replacingObjectKey(
      durationHintDoesNotSynthesizeClicks, @"cues",
      replacingObjectKey(durationHintDoesNotSynthesizeClicks[@"cues"],
                         @"beatGrid", denseGrid));
  CHECK(SingzParsePlaybackPrepare(withPlayback(durationHintDoesNotSynthesizeClicks),
                                  &parsed, &error));
  CHECK(parsed.config.cuePlan->beatGrid.beats.size() == 3 &&
        parsed.config.cuePlan->durationSeconds ==
            singz::kPlaybackCueMaximumDurationSeconds);

  for (NSString *level in @[ @"playback", @"transport", @"cues", @"grid" ]) {
    NSDictionary *playback = validPlayback();
    if ([level isEqualToString:@"playback"]) {
      playback = replacingObjectKey(playback, @"unexpected", @1);
    } else if ([level isEqualToString:@"transport"]) {
      playback = replacingObjectKey(
          playback, @"transport",
          replacingObjectKey(playback[@"transport"], @"unexpected", @1));
    } else if ([level isEqualToString:@"cues"]) {
      playback = replacingObjectKey(
          playback, @"cues",
          replacingObjectKey(playback[@"cues"], @"unexpected", @1));
    } else {
      NSDictionary *cues = playback[@"cues"];
      playback = replacingObjectKey(
          playback, @"cues",
          replacingObjectKey(
              cues, @"beatGrid",
              replacingObjectKey(cues[@"beatGrid"], @"unexpected", @1)));
    }
    rejects(withPlayback(playback));
  }
}

void testPortableGraphProjectionSchema() {
  NSDictionary *node = @{
    @"id" : @"13835058055282163713",
    @"type" : @"73696e677a2d6473700000000000000d",
    @"typeVersion" : @7,
    @"execution" : @"vendor-bridge",
    @"unavailable" : @"bypass",
    @"ports" : @{
      @"inputs" : @[ @{ @"id" : @"in", @"channels" : @2 } ],
      @"outputs" : @[ @{ @"id" : @"out", @"channels" : @2 } ],
    },
    @"parameters" : @{ @"vendor.depth" : @0.25 },
    @"binding" : @{ @"kind" : @"adapter" },
  };
  NSDictionary *document = @{
    @"format" : @1,
    @"engine" : @"singz-dsp",
    @"nodes" : @[ node ],
    @"connections" : @[],
  };
  NSMutableDictionary *request = [validRequest() mutableCopy];
  request[@"graphDocument"] = document;
  SingzParsedPlaybackPrepare parsed;
  NSString *error = nil;
  CHECK(SingzParsePlaybackPrepare(request, &parsed, &error) && error == nil &&
        parsed.config.graphDocument.has_value());
  const singz::NativePlaybackGraphDocument &graph =
      *parsed.config.graphDocument;
  CHECK(graph.nodes.size() == 1 &&
        graph.nodes[0].id == UINT64_C(13835058055282163713) &&
        graph.nodes[0].type.high == UINT64_C(0x73696e677a2d6473) &&
        graph.nodes[0].type.low == UINT64_C(0x700000000000000d) &&
        graph.nodes[0].unavailable ==
            singz::NativePlaybackGraphUnavailablePolicy::Bypass &&
        graph.nodes[0].parameters.size() == 1);

  NSMutableDictionary *extraDocument = [document mutableCopy];
  extraDocument[@"future"] = @YES;
  request[@"graphDocument"] = extraDocument;
  CHECK(!SingzParsePlaybackPrepare(request, &parsed, &error));

  NSMutableDictionary *upperNode = [node mutableCopy];
  upperNode[@"type"] = @"73696E677A2D6473700000000000000D";
  request[@"graphDocument"] = replacingObjectKey(document, @"nodes", @[ upperNode ]);
  CHECK(!SingzParsePlaybackPrepare(request, &parsed, &error));

  NSMutableDictionary *badParameters = [node mutableCopy];
  badParameters[@"parameters"] = @{ @"vendor.depth" : @(NAN) };
  request[@"graphDocument"] =
      replacingObjectKey(document, @"nodes", @[ badParameters ]);
  CHECK(!SingzParsePlaybackPrepare(request, &parsed, &error));
}

void testPlaybackTrainingSchema() {
  SingzParsedPlaybackPrepare parsed;
  NSString *error = nil;
  CHECK(SingzParsePlaybackPrepare(
      withTraining(@{
        @"mode" : @"period",
        @"periodFrames" : @240000,
        @"laneIds" : @[ @"vocals" ],
        @"enabled" : @YES,
      }),
      &parsed, &error));
  CHECK(error == nil && parsed.config.trainingDuck.has_value() &&
        parsed.config.trainingDuck->mode ==
            singz::NativePlaybackTrainingMode::Period &&
        parsed.config.trainingDuck->periodFrames == 240000 &&
        parsed.config.trainingDuck->enabled &&
        parsed.config.trainingDuck->laneIds ==
            std::vector<std::string>({"vocals"}));

  CHECK(SingzParsePlaybackPrepare(
      withTraining(@{
        @"mode" : @"windows",
        @"windows" : @[
          @{ @"startProjectFrame" : @10, @"endProjectFrame" : @20 },
          @{ @"startProjectFrame" : @20, @"endProjectFrame" : @40 },
        ],
        @"laneIds" : @[ @"vocals" ],
        @"enabled" : @NO,
      }),
      &parsed, &error));
  CHECK(parsed.config.trainingDuck.has_value() &&
        parsed.config.trainingDuck->mode ==
            singz::NativePlaybackTrainingMode::Windows &&
        parsed.config.trainingDuck->windows.size() == 2 &&
        parsed.config.trainingDuck->windows[1].endProjectFrame == 40 &&
        !parsed.config.trainingDuck->enabled);

  for (NSDictionary *invalid in @[
         @{ @"mode" : @"period", @"periodFrames" : @0,
            @"laneIds" : @[ @"vocals" ], @"enabled" : @YES },
         @{ @"mode" : @"period", @"periodFrames" : @10,
            @"windows" : @[], @"laneIds" : @[ @"vocals" ],
            @"enabled" : @YES },
         @{ @"mode" : @"windows",
            @"windows" : @[
              @{ @"startProjectFrame" : @10, @"endProjectFrame" : @30 },
              @{ @"startProjectFrame" : @20, @"endProjectFrame" : @40 },
            ],
            @"laneIds" : @[ @"vocals" ], @"enabled" : @YES },
         @{ @"mode" : @"windows", @"windows" : @[],
            @"laneIds" : @[ @"vocals" ], @"enabled" : @YES },
         @{ @"mode" : @"period", @"periodFrames" : @10,
            @"laneIds" : @[ @"vocals", @"vocals" ],
            @"enabled" : @YES },
       ]) {
    CHECK(!SingzParsePlaybackPrepare(withTraining(invalid), &parsed, &error));
    CHECK(error != nil && !parsed.config.trainingDuck.has_value());
  }

  SingzParsedPlaybackControl control;
  CHECK(SingzParsePlaybackControl(@{ @"trainingEnabled" : @YES }, &control) &&
        control.training && control.enabled && !control.lane);
  CHECK(!SingzParsePlaybackControl(
      @{ @"trainingEnabled" : @YES, @"masterGain" : @1.0 }, &control));
  CHECK(!SingzParsePlaybackControl(@{ @"trainingEnabled" : @1 }, &control));
  CHECK(!control.training && !control.enabled && !control.lane);
}

void testPlaybackInitialTransportSchema() {
  SingzParsedPlaybackPrepare parsed;
  NSString *error = nil;
  CHECK(SingzParsePlaybackPrepare(
      withInitialTransport(@{
        @"state" : @"paused",
        @"loop" : @{
          @"startProjectFrame" : @48000,
          @"endProjectFrame" : @96000,
        },
      }),
      &parsed, &error));
  CHECK(error == nil && parsed.config.initialTransport.startPaused &&
        parsed.config.initialTransport.loop.has_value() &&
        parsed.config.initialTransport.loop->startProjectFrame == 48000 &&
        parsed.config.initialTransport.loop->endProjectFrame == 96000);

  CHECK(SingzParsePlaybackPrepare(
      withInitialTransport(@{ @"state" : @"playing" }), &parsed, &error));
  CHECK(!parsed.config.initialTransport.startPaused &&
        !parsed.config.initialTransport.loop.has_value());

  for (NSDictionary *invalid in @[
         @{ @"state" : @"stopped" },
         @{ @"state" : @YES },
         @{ @"state" : @"paused", @"future" : @1 },
         @{ @"state" : @"paused",
            @"loop" : @{ @"startProjectFrame" : @(-1),
                          @"endProjectFrame" : @4 } },
         @{ @"state" : @"paused",
            @"loop" : @{ @"startProjectFrame" : @8,
                          @"endProjectFrame" : @8 } },
         @{ @"state" : @"paused",
            @"loop" : @{ @"startProjectFrame" : @8.5,
                          @"endProjectFrame" : @10 } },
         @{ @"state" : @"paused",
            @"loop" : @{
              @"startProjectFrame" : @8,
              @"endProjectFrame" : @9007199254740992.0,
            } },
         @{ @"state" : @"paused",
            @"loop" : @{ @"startProjectFrame" : @8,
                          @"endProjectFrame" : @10,
                          @"future" : @1 } },
       ]) {
    CHECK(!SingzParsePlaybackPrepare(withInitialTransport(invalid), &parsed,
                                     &error));
    CHECK(error != nil && !parsed.config.initialTransport.startPaused &&
          !parsed.config.initialTransport.loop.has_value());
  }
}

void testPlaybackPreviewClickSchema() {
  singz::NativePlaybackPreviewClickSound sound =
      singz::NativePlaybackPreviewClickSound::Accent;
  CHECK(SingzParsePlaybackPreviewClickSound(@0, &sound));
  CHECK(sound == singz::NativePlaybackPreviewClickSound::Ordinary);
  CHECK(SingzParsePlaybackPreviewClickSound(@1, &sound));
  CHECK(sound == singz::NativePlaybackPreviewClickSound::Accent);
  for (id invalid in @[ @YES, @(-1), @2, @0.5, @"0", NSNull.null ]) {
    CHECK(!SingzParsePlaybackPreviewClickSound(invalid, &sound));
    CHECK(sound == singz::NativePlaybackPreviewClickSound::Ordinary);
  }
  CHECK(!SingzParsePlaybackPreviewClickSound(@0, nullptr));
}

void testPlaybackTransportCommandSchema() {
  SingzParsedPlaybackTransportCommand command;
  CHECK(SingzParsePlaybackTransportCommand(@{@"kind" : @"pause"}, &command));
  CHECK(command.kind == SingzPlaybackTransportCommandKind::Pause);
  CHECK(SingzParsePlaybackTransportCommand(@{@"kind" : @"resume"}, &command));
  CHECK(command.kind == SingzPlaybackTransportCommandKind::Resume);
  CHECK(SingzParsePlaybackTransportCommand(
      @{@"kind" : @"seek", @"projectFrame" : @48000}, &command));
  CHECK(command.kind == SingzPlaybackTransportCommandKind::Seek &&
        command.projectFrame == 48000);
  CHECK(SingzParsePlaybackTransportCommand(
      @{
        @"kind" : @"set-loop",
        @"startProjectFrame" : @12000,
        @"endProjectFrame" : @96000,
      },
      &command));
  CHECK(command.kind == SingzPlaybackTransportCommandKind::SetLoop &&
        command.loopStartFrame == 12000 && command.loopEndFrame == 96000);
  CHECK(SingzParsePlaybackTransportCommand(@{@"kind" : @"clear-loop"},
                                           &command));
  CHECK(command.kind == SingzPlaybackTransportCommandKind::ClearLoop);
  CHECK(SingzParsePlaybackTransportCommand(@{@"kind" : @"reanchor"},
                                           &command));
  CHECK(command.kind == SingzPlaybackTransportCommandKind::Reanchor);

  for (NSDictionary *invalid in @[
         @{},
         @{@"kind" : @"future"},
         @{@"kind" : @"pause", @"projectFrame" : @0},
         @{@"kind" : @"seek"},
         @{@"kind" : @"seek", @"projectFrame" : @YES},
         @{@"kind" : @"seek", @"projectFrame" : @(-1)},
         @{@"kind" : @"seek", @"projectFrame" : @0.5},
         @{@"kind" : @"seek",
           @"projectFrame" :
               @(singz::kNativePlaybackMaximumJsSafeInteger + 1)},
         @{@"kind" : @"set-loop",
           @"startProjectFrame" : @2,
           @"endProjectFrame" : @2},
         @{@"kind" : @"set-loop",
           @"startProjectFrame" : @3,
           @"endProjectFrame" : @2},
         @{@"kind" : @"set-loop",
           @"startProjectFrame" : @0,
           @"endProjectFrame" : @4,
           @"unexpected" : @1},
       ]) {
    CHECK(!SingzParsePlaybackTransportCommand(invalid, &command));
    CHECK(command.kind == SingzPlaybackTransportCommandKind::Pause &&
          command.projectFrame == 0 && command.loopStartFrame == 0 &&
          command.loopEndFrame == 0);
  }
}

int main() {
  @autoreleasepool {
    testActualBlockCopyGuard();
    testPrepareOuterBoundaryVerdict();
    testCommandMutationOwnershipGuard();
    testStopUnloadDeliveryGuard();
    testPostOpenDescriptorOwnership();
    testPlaybackTransportCueSchema();
    testPlaybackTrainingSchema();
    testPlaybackInitialTransportSchema();
    testPlaybackPreviewClickSchema();
    testPlaybackTransportCommandSchema();
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
    NSMutableDictionary *positioned = [validRequest() mutableCopy];
    positioned[@"preparedStartProjectFrame"] = @(-480);
    CHECK(SingzParsePlaybackPrepare(positioned, &reusedPrepare, &parseError));
    CHECK(reusedPrepare.config.maximumFrames == 512 &&
          reusedPrepare.config.requestedBufferFrames == 128 &&
          reusedPrepare.config.masterGain == 0.5F &&
          reusedPrepare.config.handoffLease == 0 &&
          reusedPrepare.config.preparedStartProjectFrame.has_value() &&
          *reusedPrepare.config.preparedStartProjectFrame == -480);
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
          !reusedPrepare.config.preparedStartProjectFrame.has_value() &&
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
    testPortableGraphProjectionSchema();
    testWhatTheSchemaLeavesToTheCore();
    testPrepareOwnershipGuard();
    testPlaybackResultErrorMapping();
    testUnloadCleanupResultSchema();
    testPlaybackAudioSessionPolicy();
  }
  std::puts("native playback bridge schema tests: ok");
  return 0;
}
