#include "signalsmith_time_pitch.h"

#include <signalsmith-stretch.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <limits>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace singz {
namespace {

// Fits a 32-bit long on purpose: Windows is LLP64, and a wider literal would
// truncate there and seed the stretch differently from every other platform.
constexpr long kSignalsmithFixedSeed = 0x494e475aL;
static_assert(kSignalsmithFixedSeed <= 0x7fffffffL,
              "the Signalsmith seed must survive a 32-bit long");
constexpr float kSignalsmithTonalityLimitHz = 8000.0F;
constexpr double kSignalsmithLoopReplenishSeconds = 0.25;
constexpr auto kSignalsmithLoopWorkerPollInterval =
    std::chrono::milliseconds(2);
// While no recurring loop is active the worker has nothing to replenish, so
// it polls at this rate instead: measured on the POCO (exact per-thread ticks,
// parity plan Step 4 run 7), the 2 ms poll cost about 1.2% of a core PER LIVE
// STAGE, hold or not, and a project whose graph carries a Stretch stage at
// unity has one in every generation. Activation happens on the render thread
// (the Start/loop command in the callback), which must not enter the wake
// machinery, so the worker notices it by polling — within this interval,
// which sits inside the design's own margin: the bank is pre-primed with two
// entries at plan time and the minimum loop length already reserves
// kSignalsmithLoopReplenishSeconds per wrap for the worker.
constexpr auto kSignalsmithLoopWorkerIdlePollInterval =
    std::chrono::milliseconds(100);
static_assert(kSignalsmithLoopWorkerIdlePollInterval.count() * 2 <
                  static_cast<long>(kSignalsmithLoopReplenishSeconds * 1000.0),
              "the idle poll must notice an activation well inside one "
              "replenishment period");
// The slot budget, per engine: 1 active; up to 2 loop-bank slots (4 while a
// region is being re-set, both banks Ready); 0-1 pending reanchor plan; and
// one per SEEK IN FLIGHT (each Seek command owns its replacement until the
// callback drains it — SignalsmithTimePitchSeekPlan). With a loop armed that
// is one or two seeks between callbacks; a burst past that is refused as
// QueueFull by the session, the retryable code, never as a graph failure.
constexpr uint32_t kSignalsmithAnchorSlotCount = 6;
constexpr uint32_t kNoSignalsmithAnchorSlot = UINT32_MAX;
constexpr uint32_t kSignalsmithReanchorSlotBits = 3;
constexpr uint64_t kSignalsmithReanchorSlotMask =
    (uint64_t{1} << kSignalsmithReanchorSlotBits) - 1u;
constexpr uint64_t kSignalsmithMaximumReanchorGeneration =
    std::numeric_limits<uint64_t>::max() >> kSignalsmithReanchorSlotBits;
static_assert(kSignalsmithAnchorSlotCount <
              (uint32_t{1} << kSignalsmithReanchorSlotBits));
constexpr uint32_t kSignalsmithLoopBankCount = 2;
constexpr uint32_t kSignalsmithLoopReadySlots = 2;
constexpr uint32_t kNoSignalsmithLoopBank = UINT32_MAX;

enum class AnchorSlotState : uint32_t {
  Retired = 0,
  Preparing,
  Ready,
  Active,
};

enum class AnchorKind : uint32_t { None = 0, Seek, Loop, Reanchor };

enum class LoopBankState : uint32_t {
  Inactive = 0,
  Preparing,
  Ready,
  Active,
};

struct SignalsmithAnchorSlot {
  SignalsmithAnchorSlot() : stretch(kSignalsmithFixedSeed) {}

  signalsmith::stretch::SignalsmithStretch<float> stretch;
  std::atomic<AnchorSlotState> lifecycle{AnchorSlotState::Retired};
  std::atomic<AnchorKind> kind{AnchorKind::None};
  // The prime count when this slot was last primed for a per-command seek
  // plan; what a plan checks before it arms or discards (see the header).
  std::atomic<uint64_t> stamp{0};
};

struct SignalsmithLoopBank {
  std::atomic<LoopBankState> lifecycle{LoopBankState::Inactive};
  std::atomic<uint64_t> generation{0};
  std::array<std::atomic<uint32_t>, kSignalsmithLoopReadySlots> slots{};
  std::atomic<uint32_t> consumed{0};
  std::array<const float *, kSignalsmithTimePitchMaximumChannels> inputs{};
  std::vector<float> samples;

  SignalsmithLoopBank() noexcept {
    for (auto &slot : slots)
      slot.store(kNoSignalsmithAnchorSlot, std::memory_order_relaxed);
  }
};

struct SignalsmithTimePitchState {
  explicit SignalsmithTimePitchState(SignalsmithTimePitchConfig prepared)
      : config(prepared) {}

  SignalsmithTimePitchConfig config{};
  std::array<SignalsmithAnchorSlot, kSignalsmithAnchorSlotCount> slots;
  std::array<SignalsmithLoopBank, kSignalsmithLoopBankCount> loopBanks;
  std::array<float *, kSignalsmithTimePitchMaximumChannels> inputs{};
  std::array<float *, kSignalsmithTimePitchMaximumChannels> outputs{};
  std::array<float *, kSignalsmithTimePitchMaximumChannels> zeroInputs{};
  uint32_t anchorFrames{0};
  uint32_t minimumLoopOutputFrames{0};
  uint32_t activeSlot{0};
  std::atomic<uint32_t> pendingSeekSlot{kNoSignalsmithAnchorSlot};
  // Under workerMutex: the next SignalsmithTimePitchSeekPlan stamp.
  uint64_t nextSeekStamp{1};
  // Generation and slot are one atomic publication unit. Publishing them in
  // separate atomics permits a supersede/reuse ABA race where an old command
  // can claim a newly prepared slot with the same index.
  std::atomic<uint64_t> pendingReanchorToken{0};
  std::atomic<uint32_t> armedBoundarySlot{kNoSignalsmithAnchorSlot};
  uint64_t nextReanchorGeneration{1};
  std::atomic<uint32_t> activeLoopBank{kNoSignalsmithLoopBank};
  std::atomic<uint64_t> activeLoopGeneration{0};
  uint32_t nextPreparedLoopBank{0};
  uint64_t nextLoopGeneration{1};
  uint32_t recurringBank{kNoSignalsmithLoopBank};
  uint64_t recurringGeneration{0};
  std::atomic<bool> recurringEnabled{false};
  std::atomic<uint64_t> loopConsumptionEpoch{0};
  std::atomic<bool> workerStop{false};
  std::atomic<uint64_t> workerWakeups{0};
  std::atomic<uint64_t> anchorsPrepared{0};
  std::atomic<uint64_t> anchorsPublished{0};
  std::atomic<uint64_t> anchorMisses{0};
  std::mutex workerMutex;
  std::condition_variable workerWake;
  std::thread worker;
  zdsp::LatencyFrames declaredLatency{0};
  bool prepared{false};
  bool active{false};
};

static_assert(std::atomic<uint64_t>::is_always_lock_free &&
              std::atomic<uint32_t>::is_always_lock_free &&
              std::atomic<AnchorKind>::is_always_lock_free &&
              std::atomic<LoopBankState>::is_always_lock_free);

bool validConfig(const SignalsmithTimePitchConfig &config) noexcept {
  return config.node.value != 0 && std::isfinite(config.sampleRate.value) &&
         config.sampleRate.value >= kSignalsmithTimePitchMinimumSampleRate &&
         config.sampleRate.value <= kSignalsmithTimePitchMaximumSampleRate &&
         config.channels != 0 &&
         config.channels <= kSignalsmithTimePitchMaximumChannels &&
         config.maximumBlockFrames != 0 &&
         config.maximumBlockFrames <=
             kSignalsmithTimePitchMaximumBlockFrames &&
         std::isfinite(config.transposeSemitones) &&
         config.transposeSemitones >= -48.0F &&
         config.transposeSemitones <= 48.0F;
}

void configureStretch(SignalsmithTimePitchState *state,
                      SignalsmithAnchorSlot *slot) {
  slot->stretch.presetCheaper(
      static_cast<int>(state->config.channels),
      static_cast<float>(state->config.sampleRate.value), true);
  slot->stretch.setTransposeSemitones(
      state->config.transposeSemitones,
      kSignalsmithTonalityLimitHz /
          static_cast<float>(state->config.sampleRate.value));
}

bool validAnchorInput(const SignalsmithTimePitchState &state,
                      const SignalsmithTimePitchAnchorInput &input) noexcept {
  if (input.channels == nullptr || input.channelCount != state.config.channels ||
      input.frameCount != state.anchorFrames || input.frameCount == 0)
    return false;
  for (uint32_t channel = 0; channel < input.channelCount; ++channel) {
    if (input.channels[channel] == nullptr)
      return false;
    for (uint32_t frame = 0; frame < input.frameCount; ++frame)
      if (!std::isfinite(input.channels[channel][frame]))
        return false;
  }
  return true;
}

bool primeSlot(SignalsmithTimePitchState *state, uint32_t slotIndex,
               const SignalsmithTimePitchAnchorInput &input,
               AnchorKind kind) noexcept {
  if (slotIndex >= state->slots.size() || !validAnchorInput(*state, input))
    return false;
  SignalsmithAnchorSlot &slot = state->slots[slotIndex];
  try {
    slot.stretch.outputSeek(input.channels,
                            static_cast<int>(input.frameCount));
  } catch (...) {
    slot.lifecycle.store(AnchorSlotState::Retired,
                         std::memory_order_release);
    return false;
  }
  slot.kind.store(kind, std::memory_order_relaxed);
  slot.lifecycle.store(AnchorSlotState::Ready, std::memory_order_release);
  state->anchorsPrepared.fetch_add(1, std::memory_order_relaxed);
  return true;
}

uint32_t claimRetiredSlot(SignalsmithTimePitchState *state) noexcept {
  for (uint32_t index = 0; index < state->slots.size(); ++index) {
    AnchorSlotState expected = AnchorSlotState::Retired;
    if (state->slots[index].lifecycle.compare_exchange_strong(
            expected, AnchorSlotState::Preparing, std::memory_order_acq_rel,
            std::memory_order_acquire))
      return index;
  }
  return kNoSignalsmithAnchorSlot;
}

void retireReadySlot(SignalsmithTimePitchState *state,
                     uint32_t slotIndex) noexcept {
  if (slotIndex >= state->slots.size())
    return;
  AnchorSlotState expected = AnchorSlotState::Ready;
  (void)state->slots[slotIndex].lifecycle.compare_exchange_strong(
      expected, AnchorSlotState::Retired, std::memory_order_acq_rel,
      std::memory_order_acquire);
}

void retirePendingSeek(SignalsmithTimePitchState *state) noexcept {
  retireReadySlot(state, state->pendingSeekSlot.exchange(
                             kNoSignalsmithAnchorSlot,
                             std::memory_order_acq_rel));
}

uint64_t reanchorToken(uint64_t generation, uint32_t slot) noexcept {
  if (generation == 0 || generation > kSignalsmithMaximumReanchorGeneration ||
      slot >= kSignalsmithAnchorSlotCount)
    return 0;
  return (generation << kSignalsmithReanchorSlotBits) |
         (static_cast<uint64_t>(slot) + 1u);
}

uint32_t reanchorTokenSlot(uint64_t token) noexcept {
  if (token == 0)
    return kNoSignalsmithAnchorSlot;
  const uint64_t encoded = token & kSignalsmithReanchorSlotMask;
  return encoded == 0 ? kNoSignalsmithAnchorSlot
                      : static_cast<uint32_t>(encoded - 1u);
}

void retirePendingReanchor(SignalsmithTimePitchState *state) noexcept {
  retireReadySlot(state, reanchorTokenSlot(
                             state->pendingReanchorToken.exchange(
                                 0, std::memory_order_acq_rel)));
}

void retireLoopBankSlots(SignalsmithTimePitchState *state,
                         SignalsmithLoopBank *bank) noexcept {
  for (auto &entry : bank->slots)
    retireReadySlot(state, entry.exchange(kNoSignalsmithAnchorSlot,
                                          std::memory_order_acq_rel));
  bank->consumed.store(0, std::memory_order_relaxed);
}

bool publishPreparedSeek(SignalsmithTimePitchState *state,
                         uint32_t slot) noexcept {
  if (slot >= state->slots.size())
    return false;
  uint32_t expected = kNoSignalsmithAnchorSlot;
  if (state->pendingSeekSlot.compare_exchange_strong(
          expected, slot, std::memory_order_release,
          std::memory_order_acquire))
    return true;
  retireReadySlot(state, slot);
  return false;
}

bool prepareSeekLocked(SignalsmithTimePitchState *state,
                       const SignalsmithTimePitchAnchorInput &input) noexcept {
  retirePendingSeek(state);
  const uint32_t slot = claimRetiredSlot(state);
  return slot != kNoSignalsmithAnchorSlot &&
         primeSlot(state, slot, input, AnchorKind::Seek) &&
         publishPreparedSeek(state, slot);
}

bool armBoundarySlot(SignalsmithTimePitchState *state, uint32_t slot,
                     AnchorKind expectedKind) noexcept {
  if (slot >= state->slots.size() ||
      state->slots[slot].kind.load(std::memory_order_acquire) != expectedKind ||
      state->slots[slot].lifecycle.load(std::memory_order_acquire) !=
          AnchorSlotState::Ready)
    return false;
  const uint32_t previous = state->armedBoundarySlot.exchange(
      slot, std::memory_order_acq_rel);
  if (previous < state->slots.size() && previous != slot)
    retireReadySlot(state, previous);
  return true;
}

bool publishPreparedReanchor(SignalsmithTimePitchState *state, uint32_t slot,
                             uint64_t generation) noexcept {
  const uint64_t token = reanchorToken(generation, slot);
  if (token == 0)
    return false;
  uint64_t expected = 0;
  if (state->pendingReanchorToken.compare_exchange_strong(
          expected, token, std::memory_order_release,
          std::memory_order_acquire))
    return true;
  retireReadySlot(state, slot);
  return false;
}

uint32_t claimLoopBank(SignalsmithTimePitchState *state) noexcept {
  for (uint32_t attempt = 0; attempt < kSignalsmithLoopBankCount; ++attempt) {
    const uint32_t index =
        (state->nextPreparedLoopBank + attempt) % kSignalsmithLoopBankCount;
    SignalsmithLoopBank &bank = state->loopBanks[index];
    LoopBankState expected = LoopBankState::Inactive;
    if (!bank.lifecycle.compare_exchange_strong(
            expected, LoopBankState::Preparing, std::memory_order_acq_rel,
            std::memory_order_acquire)) {
      expected = LoopBankState::Ready;
      if (!bank.lifecycle.compare_exchange_strong(
              expected, LoopBankState::Preparing, std::memory_order_acq_rel,
              std::memory_order_acquire))
        continue;
    }
    retireLoopBankSlots(state, &bank);
    state->nextPreparedLoopBank = (index + 1u) % kSignalsmithLoopBankCount;
    return index;
  }
  return kNoSignalsmithLoopBank;
}

bool replenishLoopBankSlotLocked(SignalsmithTimePitchState *state,
                                 uint32_t bankIndex,
                                 uint64_t generation,
                                 uint32_t entryIndex) noexcept {
  if (bankIndex >= state->loopBanks.size() ||
      entryIndex >= kSignalsmithLoopReadySlots)
    return false;
  SignalsmithLoopBank &bank = state->loopBanks[bankIndex];
  if (bank.generation.load(std::memory_order_acquire) != generation ||
      bank.lifecycle.load(std::memory_order_acquire) != LoopBankState::Active ||
      bank.slots[entryIndex].load(std::memory_order_acquire) !=
          kNoSignalsmithAnchorSlot ||
      bank.samples.empty())
    return false;
  const uint32_t slot = claimRetiredSlot(state);
  const SignalsmithTimePitchAnchorInput input{
      bank.inputs.data(), state->config.channels, state->anchorFrames};
  if (slot == kNoSignalsmithAnchorSlot ||
      !primeSlot(state, slot, input, AnchorKind::Loop))
    return false;
  if (bank.generation.load(std::memory_order_acquire) == generation &&
      bank.lifecycle.load(std::memory_order_acquire) == LoopBankState::Active) {
    uint32_t empty = kNoSignalsmithAnchorSlot;
    if (bank.slots[entryIndex].compare_exchange_strong(
            empty, slot, std::memory_order_release,
            std::memory_order_acquire))
      return true;
  }
  retireReadySlot(state, slot);
  return false;
}

void anchorWorker(SignalsmithTimePitchState *state) noexcept {
  uint64_t observed = state->loopConsumptionEpoch.load(std::memory_order_acquire);
  std::unique_lock<std::mutex> lock(state->workerMutex);
  while (!state->workerStop.load(std::memory_order_acquire)) {
    // Callback publication is deliberately only one lock-free epoch write.
    // Polling bounds replenishment latency without making the audio thread
    // enter the platform atomic-wake machinery.  The condition variable is
    // reserved for ordinary-thread shutdown so teardown never waits for the
    // next poll interval.
    const auto interval =
        state->recurringEnabled.load(std::memory_order_acquire)
            ? kSignalsmithLoopWorkerPollInterval
            : kSignalsmithLoopWorkerIdlePollInterval;
    state->workerWake.wait_for(lock, interval, [&] {
      return state->workerStop.load(std::memory_order_acquire) ||
             state->loopConsumptionEpoch.load(std::memory_order_acquire) !=
                 observed;
    });
    state->workerWakeups.fetch_add(1u, std::memory_order_relaxed);
    if (state->workerStop.load(std::memory_order_acquire))
      break;
    const uint64_t published =
        state->loopConsumptionEpoch.load(std::memory_order_acquire);
    if (published == observed)
      continue;
    observed = published;
    const uint32_t bankIndex =
        state->activeLoopBank.load(std::memory_order_acquire);
    const uint64_t generation =
        state->activeLoopGeneration.load(std::memory_order_acquire);
    if (!state->recurringEnabled.load(std::memory_order_acquire) ||
        bankIndex >= state->loopBanks.size() || generation == 0)
      continue;
    for (uint32_t entry = 0; entry < kSignalsmithLoopReadySlots; ++entry)
      if (state->loopBanks[bankIndex].slots[entry].load(
              std::memory_order_acquire) == kNoSignalsmithAnchorSlot)
        (void)replenishLoopBankSlotLocked(state, bankIndex, generation, entry);
  }
}

zdsp::Status prepare(void *opaque, const zdsp::PrepareSpec *spec,
                     const zdsp::PreparedStorage *storage) noexcept {
  if (opaque == nullptr || spec == nullptr || storage == nullptr)
    return {zdsp::StatusCode::InvalidArgument, 1};
  auto *state = static_cast<SignalsmithTimePitchState *>(opaque);
  if (state->prepared || !zdsp::succeeded(zdsp::validatePrepareSpec(*spec)))
    return {zdsp::StatusCode::InvalidArgument, 2};
  if (spec->inputBusCount != 1 || spec->outputBusCount != 1 ||
      spec->inputBuses[0].channelCount != state->config.channels ||
      spec->outputBuses[0].channelCount != state->config.channels ||
      spec->inputBuses[0].sampleFormat != zdsp::SampleFormat::Float32Planar ||
      spec->outputBuses[0].sampleFormat != zdsp::SampleFormat::Float32Planar ||
      spec->sampleRate.value != state->config.sampleRate.value ||
      spec->maximumBlockFrames.value > state->config.maximumBlockFrames)
    return {zdsp::StatusCode::UnsupportedFormat, 3};

  const size_t required = signalsmithTimePitchPreparedBytes(state->config);
  if (required == 0 || storage->data == nullptr || storage->size < required ||
      (reinterpret_cast<uintptr_t>(storage->data) & (alignof(float) - 1u)) != 0)
    return {zdsp::StatusCode::InsufficientStorage, 4};

  try {
    for (SignalsmithAnchorSlot &slot : state->slots)
      configureStretch(state, &slot);
    const uint64_t latency =
        static_cast<uint64_t>(state->slots[0].stretch.inputLatency()) +
        static_cast<uint64_t>(state->slots[0].stretch.outputLatency());
    if (latency > std::numeric_limits<uint32_t>::max())
      return {zdsp::StatusCode::CapacityExceeded, 5};
    state->declaredLatency = {static_cast<uint32_t>(latency)};
    const int anchorFrames = state->slots[0].stretch.outputSeekLength(1.0F);
    if (anchorFrames <= 0 ||
        static_cast<uint64_t>(anchorFrames) >
            std::numeric_limits<uint32_t>::max())
      return {zdsp::StatusCode::CapacityExceeded, 6};
    state->anchorFrames = static_cast<uint32_t>(anchorFrames);
    const uint64_t structuralMinimum =
        static_cast<uint64_t>(state->anchorFrames) +
        static_cast<uint64_t>(state->config.maximumBlockFrames) * 2u;
    const uint64_t schedulingMinimum = static_cast<uint64_t>(std::ceil(
        state->config.sampleRate.value * kSignalsmithLoopReplenishSeconds));
    const uint64_t minimumLoopFrames =
        std::max(structuralMinimum, schedulingMinimum);
    if (minimumLoopFrames > std::numeric_limits<uint32_t>::max())
      return {zdsp::StatusCode::CapacityExceeded, 7};
    state->minimumLoopOutputFrames =
        static_cast<uint32_t>(minimumLoopFrames);

    auto *samples = static_cast<float *>(storage->data);
    const size_t plane = state->config.maximumBlockFrames;
    std::fill_n(samples, plane * state->config.channels * 2u, 0.0F);
    for (uint32_t channel = 0; channel < state->config.channels; ++channel) {
      state->inputs[channel] = samples + plane * channel;
      state->zeroInputs[channel] = samples + plane * channel;
      state->outputs[channel] =
          samples + plane * (state->config.channels + channel);
    }
    // Exercise maximum callback shape before publication. Any vector growth,
    // FFT plan setup and lazy capacity changes happen here on the control
    // thread; process/reset can subsequently be guarded by the allocation trap.
    for (SignalsmithAnchorSlot &slot : state->slots) {
      slot.stretch.process(
          state->inputs.data(),
          static_cast<int>(state->config.maximumBlockFrames),
          state->outputs.data(),
          static_cast<int>(state->config.maximumBlockFrames));
      slot.stretch.reset();
      slot.lifecycle.store(AnchorSlotState::Retired,
                           std::memory_order_relaxed);
    }
    state->activeSlot = 0;
    state->slots[0].lifecycle.store(AnchorSlotState::Active,
                                    std::memory_order_relaxed);
    state->worker = std::thread(anchorWorker, state);
  } catch (...) {
    return {zdsp::StatusCode::InsufficientStorage, 8};
  }
  state->prepared = true;
  state->active = true;
  return zdsp::okStatus();
}

void reset(void *opaque, zdsp::Discontinuity discontinuity) noexcept {
  auto *state = static_cast<SignalsmithTimePitchState *>(opaque);
  if (state == nullptr || !state->active)
    return;
  if (discontinuity.reason == zdsp::DiscontinuityReason::None)
    return;

  uint32_t replacement = kNoSignalsmithAnchorSlot;
  AnchorKind expectedKind = AnchorKind::None;
  if (discontinuity.reason == zdsp::DiscontinuityReason::SourceLoop) {
    const uint32_t bankIndex =
        state->activeLoopBank.load(std::memory_order_acquire);
    if (bankIndex < state->loopBanks.size()) {
      SignalsmithLoopBank &bank = state->loopBanks[bankIndex];
      const uint32_t sequence =
          bank.consumed.fetch_add(1u, std::memory_order_relaxed);
      replacement = bank.slots[sequence % kSignalsmithLoopReadySlots]
                        .exchange(kNoSignalsmithAnchorSlot,
                                  std::memory_order_acq_rel);
    }
    expectedKind = AnchorKind::Loop;
  } else {
    // The transport command arms the last one-shot operation in command order.
    // A higher-priority route/clock boundary may coalesce with a seek, so a
    // generic reset intentionally accepts either prepared one-shot kind.
    replacement = state->armedBoundarySlot.exchange(
        kNoSignalsmithAnchorSlot, std::memory_order_acq_rel);
    if (replacement >= state->slots.size() &&
        discontinuity.reason == zdsp::DiscontinuityReason::SourceSeek) {
      // Standalone processor users can retain the legacy prime-then-reset API;
      // the product session always arms at its callback command boundary.
      replacement = state->pendingSeekSlot.exchange(
          kNoSignalsmithAnchorSlot, std::memory_order_acq_rel);
    }
    if (replacement < state->slots.size())
      expectedKind = state->slots[replacement].kind.load(
          std::memory_order_acquire);
    if (expectedKind != AnchorKind::Seek &&
        expectedKind != AnchorKind::Reanchor)
      expectedKind = AnchorKind::None;
  }

  if (replacement < state->slots.size() && expectedKind != AnchorKind::None &&
      state->slots[replacement].kind.load(std::memory_order_acquire) ==
          expectedKind &&
      state->slots[replacement].lifecycle.load(std::memory_order_acquire) ==
          AnchorSlotState::Ready) {
    const uint32_t previous = state->activeSlot;
    state->slots[replacement].lifecycle.store(AnchorSlotState::Active,
                                              std::memory_order_relaxed);
    state->activeSlot = replacement;
    state->slots[previous].lifecycle.store(AnchorSlotState::Retired,
                                           std::memory_order_release);
    state->anchorsPublished.fetch_add(1, std::memory_order_relaxed);
    if (expectedKind == AnchorKind::Loop)
      state->loopConsumptionEpoch.fetch_add(1u, std::memory_order_release);
    return;
  }
  // Never flush the active Stretch object from the callback: the last valid
  // processor stays, and the caller gets an observable miss instead.
  //
  // This is the ORDINARY path, not an error one. The session used to refuse
  // any unprepared generic boundary before render, which turned out to wedge
  // every transposed song — one anchor per open against a host that raises a
  // clock reanchor of its own at every stream start. It now refuses only a
  // boundary that MOVED THE SOURCE (nextSlice in
  // native_playback_session.cpp), and everything else arrives here: the
  // Stretch state is a function of source-signal history alone, so a boundary
  // that moves nothing has nothing to re-anchor. anchorMisses therefore
  // counts host boundaries on a live session and is a diagnostic, not a fault.
  state->anchorMisses.fetch_add(1, std::memory_order_relaxed);
}

void process(void *opaque, const zdsp::ProcessContext *context,
             const zdsp::ConstAudioBusView *inputs, uint32_t inputCount,
             const zdsp::MutableAudioBusView *outputs,
             uint32_t outputCount) noexcept {
  auto *state = static_cast<SignalsmithTimePitchState *>(opaque);
  if (state == nullptr || context == nullptr || inputs == nullptr ||
      outputs == nullptr || !state->active || inputCount != 1 ||
      outputCount != 1)
    return;
  const zdsp::ConstAudioBusView &input = inputs[0];
  const zdsp::MutableAudioBusView &output = outputs[0];
  const uint32_t frames = output.frames.value;
  if (frames == 0 || frames > state->config.maximumBlockFrames ||
      input.frames.value != frames ||
      input.channelCount != state->config.channels ||
      output.channelCount != state->config.channels)
    return;
  const bool drainingTail =
      (zdsp::processContextFlags(*context) &
       zdsp::ProcessContextFlagTailDrain) != 0;
  for (uint32_t channel = 0; channel < state->config.channels; ++channel) {
    state->inputs[channel] =
        drainingTail ? state->zeroInputs[channel]
                     : const_cast<float *>(input.channels[channel]);
    state->outputs[channel] = output.channels[channel];
  }
  state->slots[state->activeSlot].stretch.process(
      state->inputs.data(), static_cast<int>(frames), state->outputs.data(),
      static_cast<int>(frames));
  for (uint32_t channel = 0; channel < output.channelCount; ++channel)
    for (uint32_t frame = 0; frame < frames; ++frame)
      if (!std::isfinite(output.channels[channel][frame]))
        output.channels[channel][frame] = 0.0F;
}

zdsp::LatencyFrames latency(const void *opaque) noexcept {
  const auto *state = static_cast<const SignalsmithTimePitchState *>(opaque);
  return state == nullptr ? zdsp::LatencyFrames{0} : state->declaredLatency;
}

zdsp::TailInfo tail(const void *opaque) noexcept {
  return {zdsp::TailKind::Finite, {latency(opaque).value}};
}

zdsp::Status deactivate(void *opaque) noexcept {
  auto *state = static_cast<SignalsmithTimePitchState *>(opaque);
  if (state == nullptr || !state->active)
    return {zdsp::StatusCode::InvalidArgument, 1};
  state->workerStop.store(true, std::memory_order_release);
  state->loopConsumptionEpoch.fetch_add(1u, std::memory_order_release);
  state->workerWake.notify_all();
  if (state->worker.joinable())
    state->worker.join();
  state->active = false;
  return zdsp::okStatus();
}

zdsp::Status destroy(void *opaque) noexcept {
  auto *state = static_cast<SignalsmithTimePitchState *>(opaque);
  if (state == nullptr || state->active)
    return {zdsp::StatusCode::InvalidArgument, 1};
  state->prepared = false;
  std::destroy_at(state);
  return zdsp::okStatus();
}

constexpr zdsp::ProcessorVTable kFunctions{
    zdsp::kProcessorInterfaceVersion, zdsp::kProcessorVTableV1RequiredSize,
    prepare, reset, process, latency, tail, deactivate, destroy};

} // namespace

size_t signalsmithTimePitchStateBytes() noexcept {
  return sizeof(SignalsmithTimePitchState);
}

uint32_t signalsmithTimePitchAnchorFrames(
    const zdsp::ProcessorHandle &processor) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return 0;
  return static_cast<const SignalsmithTimePitchState *>(processor.state)
      ->anchorFrames;
}

uint32_t signalsmithTimePitchMinimumLoopOutputFrames(
    const zdsp::ProcessorHandle &processor) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return 0;
  return static_cast<const SignalsmithTimePitchState *>(processor.state)
      ->minimumLoopOutputFrames;
}

bool primeSignalsmithTimePitchInitial(
    const zdsp::ProcessorHandle &processor,
    const SignalsmithTimePitchAnchorInput &input) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return false;
  auto *state = static_cast<SignalsmithTimePitchState *>(processor.state);
  try {
    std::lock_guard<std::mutex> lock(state->workerMutex);
    if (!state->active || !validAnchorInput(*state, input))
      return false;
    state->slots[state->activeSlot].stretch.outputSeek(
        input.channels, static_cast<int>(input.frameCount));
    state->anchorsPrepared.fetch_add(1, std::memory_order_relaxed);
    return true;
  } catch (...) {
    return false;
  }
}

bool primeSignalsmithTimePitchSeek(
    const zdsp::ProcessorHandle &processor,
    const SignalsmithTimePitchAnchorInput &input) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return false;
  auto *state = static_cast<SignalsmithTimePitchState *>(processor.state);
  try {
    std::lock_guard<std::mutex> lock(state->workerMutex);
    return state->active && validAnchorInput(*state, input) &&
           prepareSeekLocked(state, input);
  } catch (...) {
    return false;
  }
}

SignalsmithTimePitchReanchorPlan primeSignalsmithTimePitchReanchor(
    const zdsp::ProcessorHandle &processor,
    const SignalsmithTimePitchAnchorInput &input) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return {};
  auto *state = static_cast<SignalsmithTimePitchState *>(processor.state);
  try {
    std::lock_guard<std::mutex> lock(state->workerMutex);
    if (!state->active || !validAnchorInput(*state, input))
      return {};
    retirePendingReanchor(state);
    const uint32_t slot = claimRetiredSlot(state);
    if (slot == kNoSignalsmithAnchorSlot ||
        !primeSlot(state, slot, input, AnchorKind::Reanchor))
      return {};
    uint64_t generation = state->nextReanchorGeneration++;
    if (generation == 0 ||
        generation > kSignalsmithMaximumReanchorGeneration) {
      generation = 1;
      state->nextReanchorGeneration = 2;
    }
    if (!publishPreparedReanchor(state, slot, generation))
      return {};
    return {generation, slot};
  } catch (...) {
    return {};
  }
}

bool armSignalsmithTimePitchSeek(
    const zdsp::ProcessorHandle &processor) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return false;
  auto *state = static_cast<SignalsmithTimePitchState *>(processor.state);
  const uint32_t slot = state->pendingSeekSlot.exchange(
      kNoSignalsmithAnchorSlot, std::memory_order_acq_rel);
  return armBoundarySlot(state, slot, AnchorKind::Seek);
}

SignalsmithTimePitchSeekPlan primeSignalsmithTimePitchSeekPlan(
    const zdsp::ProcessorHandle &processor,
    const SignalsmithTimePitchAnchorInput &input) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return {};
  auto *state = static_cast<SignalsmithTimePitchState *>(processor.state);
  try {
    std::lock_guard<std::mutex> lock(state->workerMutex);
    if (!state->active || !validAnchorInput(*state, input))
      return {};
    // Deliberately NOT retirePendingSeek: another command's replacement is
    // that command's to arm or discard.
    const uint32_t slot = claimRetiredSlot(state);
    if (slot == kNoSignalsmithAnchorSlot)
      return {};
    uint64_t stamp = state->nextSeekStamp++;
    if (stamp == 0)
      stamp = state->nextSeekStamp++;
    // Stamped before it is Ready, so a plan that reads Ready reads its stamp.
    state->slots[slot].stamp.store(stamp, std::memory_order_release);
    if (!primeSlot(state, slot, input, AnchorKind::Seek))
      return {};
    return {slot, stamp};
  } catch (...) {
    return {};
  }
}

bool armSignalsmithTimePitchSeekPlan(
    const zdsp::ProcessorHandle &processor,
    SignalsmithTimePitchSeekPlan plan) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions ||
      !plan.valid())
    return false;
  auto *state = static_cast<SignalsmithTimePitchState *>(processor.state);
  if (plan.slot >= state->slots.size() ||
      state->slots[plan.slot].stamp.load(std::memory_order_acquire) !=
          plan.stamp)
    return false;
  return armBoundarySlot(state, plan.slot, AnchorKind::Seek);
}

void discardSignalsmithTimePitchSeekPlan(
    const zdsp::ProcessorHandle &processor,
    SignalsmithTimePitchSeekPlan plan) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions ||
      !plan.valid())
    return;
  auto *state = static_cast<SignalsmithTimePitchState *>(processor.state);
  if (plan.slot < state->slots.size() &&
      state->slots[plan.slot].stamp.load(std::memory_order_acquire) ==
          plan.stamp)
    retireReadySlot(state, plan.slot);
}

void discardSignalsmithTimePitchSeek(
    const zdsp::ProcessorHandle &processor) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return;
  auto *state = static_cast<SignalsmithTimePitchState *>(processor.state);
  retirePendingSeek(state);
}

bool armSignalsmithTimePitchReanchor(
    const zdsp::ProcessorHandle &processor,
    SignalsmithTimePitchReanchorPlan plan) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions ||
      !plan.valid())
    return false;
  auto *state = static_cast<SignalsmithTimePitchState *>(processor.state);
  const uint64_t token = reanchorToken(plan.generation, plan.slot);
  if (token == 0)
    return false;
  uint64_t expected = token;
  if (!state->pendingReanchorToken.compare_exchange_strong(
          expected, 0, std::memory_order_acq_rel,
          std::memory_order_acquire))
    return false;
  return armBoundarySlot(state, plan.slot, AnchorKind::Reanchor);
}

void discardSignalsmithTimePitchReanchor(
    const zdsp::ProcessorHandle &processor,
    SignalsmithTimePitchReanchorPlan plan) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions ||
      !plan.valid())
    return;
  auto *state = static_cast<SignalsmithTimePitchState *>(processor.state);
  const uint64_t token = reanchorToken(plan.generation, plan.slot);
  uint64_t expected = token;
  if (token != 0 && state->pendingReanchorToken.compare_exchange_strong(
                        expected, 0, std::memory_order_acq_rel,
                        std::memory_order_acquire))
    retireReadySlot(state, plan.slot);
}

SignalsmithTimePitchLoopPrepareResult configureSignalsmithTimePitchLoop(
    const zdsp::ProcessorHandle &processor,
    const SignalsmithTimePitchAnchorInput *input,
    uint64_t loopOutputFrames) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return {SignalsmithTimePitchLoopPrepareCode::Invalid, {}, 0};
  auto *state = static_cast<SignalsmithTimePitchState *>(processor.state);
  const uint32_t minimum = state->minimumLoopOutputFrames;
  uint32_t claimedBank = kNoSignalsmithLoopBank;
  try {
    std::lock_guard<std::mutex> lock(state->workerMutex);
    if (!state->active)
      return {SignalsmithTimePitchLoopPrepareCode::Invalid, {}, minimum};
    if (input == nullptr)
      return {SignalsmithTimePitchLoopPrepareCode::Disabled, {}, minimum};
    if (!validAnchorInput(*state, *input) ||
        input->frameCount >
            std::numeric_limits<size_t>::max() / input->channelCount ||
        loopOutputFrames == 0)
      return {SignalsmithTimePitchLoopPrepareCode::Invalid, {}, minimum};
    if (loopOutputFrames < minimum)
      return {SignalsmithTimePitchLoopPrepareCode::TooShort, {}, minimum};

    claimedBank = claimLoopBank(state);
    if (claimedBank >= state->loopBanks.size())
      return {SignalsmithTimePitchLoopPrepareCode::Unavailable, {}, minimum};
    SignalsmithLoopBank &bank = state->loopBanks[claimedBank];
    bank.samples.resize(
        static_cast<size_t>(input->frameCount) * input->channelCount);
    for (uint32_t channel = 0; channel < input->channelCount; ++channel) {
      float *destination = bank.samples.data() +
                           static_cast<size_t>(channel) * input->frameCount;
      std::copy_n(input->channels[channel], input->frameCount, destination);
      bank.inputs[channel] = destination;
    }
    const SignalsmithTimePitchAnchorInput recurring{
        bank.inputs.data(), state->config.channels, state->anchorFrames};
    bool ready = true;
    for (uint32_t entry = 0; entry < kSignalsmithLoopReadySlots; ++entry) {
      const uint32_t slot = claimRetiredSlot(state);
      if (slot == kNoSignalsmithAnchorSlot ||
          !primeSlot(state, slot, recurring, AnchorKind::Loop)) {
        ready = false;
        break;
      }
      bank.slots[entry].store(slot, std::memory_order_relaxed);
    }
    if (!ready) {
      retireLoopBankSlots(state, &bank);
      bank.lifecycle.store(LoopBankState::Inactive,
                           std::memory_order_release);
      return {SignalsmithTimePitchLoopPrepareCode::Unavailable, {}, minimum};
    }
    uint64_t generation = state->nextLoopGeneration++;
    if (generation == 0) {
      generation = state->nextLoopGeneration++;
      if (generation == 0)
        generation = 1;
    }
    bank.generation.store(generation, std::memory_order_relaxed);
    bank.consumed.store(0, std::memory_order_relaxed);
    bank.lifecycle.store(LoopBankState::Ready, std::memory_order_release);
    return {SignalsmithTimePitchLoopPrepareCode::Ready,
            {generation, claimedBank}, minimum};
  } catch (...) {
    if (claimedBank < state->loopBanks.size()) {
      SignalsmithLoopBank &bank = state->loopBanks[claimedBank];
      retireLoopBankSlots(state, &bank);
      bank.lifecycle.store(LoopBankState::Inactive,
                           std::memory_order_release);
    }
    return {SignalsmithTimePitchLoopPrepareCode::Unavailable, {}, minimum};
  }
}

bool activateSignalsmithTimePitchLoop(
    const zdsp::ProcessorHandle &processor,
    SignalsmithTimePitchLoopPlan plan) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions ||
      !plan.valid())
    return false;
  auto *state = static_cast<SignalsmithTimePitchState *>(processor.state);
  if (plan.bank >= state->loopBanks.size())
    return false;
  SignalsmithLoopBank &bank = state->loopBanks[plan.bank];
  if (bank.generation.load(std::memory_order_acquire) != plan.generation)
    return false;
  LoopBankState expected = LoopBankState::Ready;
  if (!bank.lifecycle.compare_exchange_strong(
          expected, LoopBankState::Active, std::memory_order_acq_rel,
          std::memory_order_acquire))
    return false;

  state->activeLoopGeneration.store(plan.generation,
                                    std::memory_order_release);
  const uint32_t previous = state->activeLoopBank.exchange(
      plan.bank, std::memory_order_acq_rel);
  state->recurringEnabled.store(true, std::memory_order_release);
  if (previous < state->loopBanks.size() && previous != plan.bank) {
    SignalsmithLoopBank &old = state->loopBanks[previous];
    old.lifecycle.store(LoopBankState::Inactive, std::memory_order_release);
    retireLoopBankSlots(state, &old);
  }
  state->loopConsumptionEpoch.fetch_add(1u, std::memory_order_release);
  return true;
}

void deactivateSignalsmithTimePitchLoop(
    const zdsp::ProcessorHandle &processor) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return;
  auto *state = static_cast<SignalsmithTimePitchState *>(processor.state);
  state->recurringEnabled.store(false, std::memory_order_release);
  state->activeLoopGeneration.store(0, std::memory_order_release);
  const uint32_t active = state->activeLoopBank.exchange(
      kNoSignalsmithLoopBank, std::memory_order_acq_rel);
  if (active < state->loopBanks.size()) {
    SignalsmithLoopBank &bank = state->loopBanks[active];
    bank.lifecycle.store(LoopBankState::Inactive, std::memory_order_release);
    retireLoopBankSlots(state, &bank);
  }
  state->loopConsumptionEpoch.fetch_add(1u, std::memory_order_release);
}

bool signalsmithTimePitchReplacementReady(
    const zdsp::ProcessorHandle &processor) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return true;
  const auto *state =
      static_cast<const SignalsmithTimePitchState *>(processor.state);
  const uint32_t seek =
      state->pendingSeekSlot.load(std::memory_order_acquire);
  if (seek < state->slots.size() &&
      state->slots[seek].lifecycle.load(std::memory_order_acquire) ==
          AnchorSlotState::Ready)
    return true;
  const uint32_t reanchor = reanchorTokenSlot(
      state->pendingReanchorToken.load(std::memory_order_acquire));
  if (reanchor < state->slots.size() &&
      state->slots[reanchor].lifecycle.load(std::memory_order_acquire) ==
          AnchorSlotState::Ready)
    return true;
  const uint32_t armed =
      state->armedBoundarySlot.load(std::memory_order_acquire);
  if (armed < state->slots.size() &&
      state->slots[armed].lifecycle.load(std::memory_order_acquire) ==
          AnchorSlotState::Ready)
    return true;
  if (signalsmithTimePitchLoopReplacementReady(processor))
    return true;
  for (const SignalsmithLoopBank &bank : state->loopBanks) {
    if (bank.lifecycle.load(std::memory_order_acquire) != LoopBankState::Ready)
      continue;
    const uint32_t slot = bank.slots[0].load(std::memory_order_acquire);
    if (slot < state->slots.size() &&
        state->slots[slot].lifecycle.load(std::memory_order_acquire) ==
            AnchorSlotState::Ready)
      return true;
  }
  return false;
}

bool signalsmithTimePitchLoopReplacementReady(
    const zdsp::ProcessorHandle &processor) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return true;
  const auto *state =
      static_cast<const SignalsmithTimePitchState *>(processor.state);
  const uint32_t bankIndex =
      state->activeLoopBank.load(std::memory_order_acquire);
  if (bankIndex >= state->loopBanks.size())
    return false;
  const SignalsmithLoopBank &bank = state->loopBanks[bankIndex];
  if (bank.lifecycle.load(std::memory_order_acquire) != LoopBankState::Active)
    return false;
  const uint32_t sequence = bank.consumed.load(std::memory_order_relaxed);
  const uint32_t slot =
      bank.slots[sequence % kSignalsmithLoopReadySlots].load(
          std::memory_order_acquire);
  return slot < state->slots.size() &&
         state->slots[slot].kind.load(std::memory_order_acquire) ==
             AnchorKind::Loop &&
         state->slots[slot].lifecycle.load(std::memory_order_acquire) ==
             AnchorSlotState::Ready;
}

void noteSignalsmithTimePitchLoopDeadlineMiss(
    const zdsp::ProcessorHandle &processor) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return;
  static_cast<SignalsmithTimePitchState *>(processor.state)
      ->anchorMisses.fetch_add(1u, std::memory_order_relaxed);
}

SignalsmithTimePitchAnchorStatus signalsmithTimePitchAnchorStatus(
    const zdsp::ProcessorHandle &processor) noexcept {
  if (processor.state == nullptr || processor.functions != &kFunctions)
    return {};
  const auto *state =
      static_cast<const SignalsmithTimePitchState *>(processor.state);
  return {state->anchorsPrepared.load(std::memory_order_relaxed),
          state->anchorsPublished.load(std::memory_order_relaxed),
          state->anchorMisses.load(std::memory_order_relaxed),
          signalsmithTimePitchReplacementReady(processor),
          state->recurringEnabled.load(std::memory_order_relaxed) ||
              std::any_of(state->loopBanks.begin(), state->loopBanks.end(),
                          [](const SignalsmithLoopBank &bank) {
                            return bank.lifecycle.load(
                                       std::memory_order_relaxed) ==
                                   LoopBankState::Ready;
                          }),
          state->workerWakeups.load(std::memory_order_relaxed)};
}

size_t signalsmithTimePitchPreparedBytes(
    const SignalsmithTimePitchConfig &config) noexcept {
  if (!validConfig(config) ||
      config.maximumBlockFrames >
          std::numeric_limits<size_t>::max() /
              (sizeof(float) * config.channels * 2u))
    return 0;
  return sizeof(float) * config.maximumBlockFrames * config.channels * 2u;
}

size_t signalsmithTimePitchRetainedBytes(
    const SignalsmithTimePitchConfig &config) noexcept {
  const size_t prepared = signalsmithTimePitchPreparedBytes(config);
  if (prepared == 0)
    return 0;
  // Pinned Signalsmith Stretch 1.3.2 configures all FFT/STFT/vector storage in
  // presetCheaper().  The allocation test measures cumulative requested heap
  // bytes at the supported rate/channel/block extremes; this deliberately
  // larger linear envelope remains an admission bound, not a live-heap guess.
  constexpr size_t fixedHeadroom = 8u * 1024u * 1024u;
  constexpr size_t bytesPerRateChannel = 128u;
  const double roundedRate = std::ceil(config.sampleRate.value);
  if (roundedRate > static_cast<double>(std::numeric_limits<size_t>::max()))
    return 0;
  const size_t rate = static_cast<size_t>(roundedRate);
  if (rate > std::numeric_limits<size_t>::max() /
                 (config.channels * bytesPerRateChannel))
    return 0;
  const size_t perEngine = rate * config.channels * bytesPerRateChannel;
  if (perEngine > std::numeric_limits<size_t>::max() /
                      kSignalsmithAnchorSlotCount)
    return 0;
  const size_t internal = perEngine * kSignalsmithAnchorSlotCount;
  // presetCheaper() uses a 100 ms block and 40 ms interval. Its input and
  // synthesis latencies are each bounded by one block, so a 250 ms frame
  // envelope conservatively covers outputSeekLength(1). Both independently
  // prepared recurring banks retain a planar copy of that anchor.
  const double roundedLoopFrames = std::ceil(
      config.sampleRate.value * kSignalsmithLoopReplenishSeconds);
  if (roundedLoopFrames >
      static_cast<double>(std::numeric_limits<size_t>::max()))
    return 0;
  const size_t loopFrames = static_cast<size_t>(roundedLoopFrames);
  if (loopFrames > std::numeric_limits<size_t>::max() /
                       (config.channels * sizeof(float)) ||
      loopFrames * config.channels * sizeof(float) >
          std::numeric_limits<size_t>::max() / kSignalsmithLoopBankCount)
    return 0;
  const size_t recurringLoopBanks = loopFrames * config.channels *
                                    sizeof(float) *
                                    kSignalsmithLoopBankCount;
  if (prepared > std::numeric_limits<size_t>::max() -
                     sizeof(SignalsmithTimePitchState) ||
      prepared + sizeof(SignalsmithTimePitchState) >
          std::numeric_limits<size_t>::max() - fixedHeadroom ||
      prepared + sizeof(SignalsmithTimePitchState) + fixedHeadroom >
          std::numeric_limits<size_t>::max() - internal ||
      prepared + sizeof(SignalsmithTimePitchState) + fixedHeadroom + internal >
          std::numeric_limits<size_t>::max() - recurringLoopBanks)
    return 0;
  return prepared + sizeof(SignalsmithTimePitchState) + fixedHeadroom +
         internal + recurringLoopBanks;
}

zdsp::ProcessorHandle createSignalsmithTimePitch(
    const SignalsmithTimePitchConfig &config,
    zdsp::MutableByteView stateStorage) noexcept {
  if (!validConfig(config) || stateStorage.data == nullptr ||
      stateStorage.capacity < sizeof(SignalsmithTimePitchState) ||
      (reinterpret_cast<uintptr_t>(stateStorage.data) &
       (alignof(SignalsmithTimePitchState) - 1u)) != 0)
    return {};
  auto *state = std::construct_at(
      reinterpret_cast<SignalsmithTimePitchState *>(stateStorage.data),
      config);
  return {state, &kFunctions};
}

} // namespace singz
