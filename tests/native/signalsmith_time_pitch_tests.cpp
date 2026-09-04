#include "native/playback/signalsmith_time_pitch.h"
#include "zdsp/tests/allocation_trap.h"

#include <array>
#include <chrono>
#include <thread>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {

[[noreturn]] void fail(const char *message) {
  std::fprintf(stderr, "FAIL: %s\n", message);
  std::abort();
}
void expect(bool value, const char *message) {
  if (!value) fail(message);
}

struct Harness {
  singz::SignalsmithTimePitchConfig config;
  std::vector<uint8_t> state;
  std::vector<float> prepared;
  zdsp::ProcessorHandle processor{};
  zdsp::AudioBusDescriptor bus;

  explicit Harness(float semitones)
      : config{{710}, {48000.0}, 2, 128, semitones},
        state(singz::signalsmithTimePitchStateBytes()),
        prepared(singz::signalsmithTimePitchPreparedBytes(config) /
                 sizeof(float)),
        bus{2, zdsp::SampleFormat::Float32Planar,
            zdsp::AudioChannelLayout::Stereo, nullptr} {
    processor = singz::createSignalsmithTimePitch(
        config, {state.data(), static_cast<uint32_t>(state.size())});
    expect(processor.state != nullptr, "Signalsmith processor constructs");
    const zdsp::PrepareSpec spec{
        zdsp::kProcessorInterfaceVersion, zdsp::kPrepareSpecV1RequiredSize,
        {48000.0}, {128}, 1, 1, &bus, &bus};
    const zdsp::PreparedStorage storage{
        prepared.data(), prepared.size() * sizeof(float), alignof(float)};
    expect(zdsp::succeeded(processor.functions->prepare(processor.state, &spec,
                                                        &storage)),
           "Signalsmith processor prepares and warms off RT");
    expect(processor.functions->latency(processor.state).value > 0,
           "Signalsmith processor declares algorithm latency");
  }

  void render(const float *left, const float *right, float *outLeft,
              float *outRight, uint32_t frames,
              uint32_t flags = zdsp::ProcessContextFlagNone) {
    const float *inputs[]{left, right};
    float *outputs[]{outLeft, outRight};
    const zdsp::ConstAudioBusView input{inputs, 2, {frames}, {128}, nullptr};
    const zdsp::MutableAudioBusView output{outputs, 2, {frames}, {128}};
    const zdsp::ProcessContext context{
        zdsp::kProcessContextInterfaceVersion,
        zdsp::kProcessContextV2RequiredSize,
        {{1}, {1}, {0}, {0}, {0}, zdsp::RenderTimeNone},
        nullptr, {48000.0}, {frames}, nullptr, 0, nullptr, 0, {nullptr, 0},
        {zdsp::DiscontinuityReason::None, zdsp::DiscontinuityFlagNone},
        flags};
    processor.functions->process(processor.state, &context, &input, 1,
                                 &output, 1);
  }

  uint32_t anchorFrames() const {
    return singz::signalsmithTimePitchAnchorFrames(processor);
  }

  singz::SignalsmithTimePitchAnchorInput anchorInput(
      const std::vector<float> &left,
      const std::vector<float> &right) const {
    expect(left.size() == anchorFrames() && right.size() == anchorFrames(),
           "Signalsmith anchor fixture has the structural frame count");
    anchorChannels = {left.data(), right.data()};
    return {anchorChannels.data(), 2, anchorFrames()};
  }

  void reset(zdsp::DiscontinuityReason reason) {
    processor.functions->reset(
        processor.state,
        {reason, zdsp::DiscontinuityFlagResetState |
                     zdsp::DiscontinuityFlagTimeValid});
  }

  void shutdown() {
    if (processor.state == nullptr) return;
    expect(zdsp::succeeded(processor.functions->deactivate(processor.state)),
           "Signalsmith processor deactivates");
    expect(zdsp::succeeded(zdsp::destroyProcessor(&processor)),
           "Signalsmith processor destroys off RT");
  }

  ~Harness() { shutdown(); }

private:
  mutable std::array<const float *, 2> anchorChannels{};
};

void preparedDeterministicRealtimeContract() {
  Harness first(5.0F);
  Harness second(5.0F);
  std::array<float, 128> left{};
  std::array<float, 128> right{};
  std::array<float, 128> firstLeft{};
  std::array<float, 128> firstRight{};
  std::array<float, 128> secondLeft{};
  std::array<float, 128> secondRight{};
  for (uint32_t frame = 0; frame < left.size(); ++frame) {
    left[frame] = std::sin(static_cast<float>(frame) * 0.071F);
    right[frame] = std::cos(static_cast<float>(frame) * 0.047F);
  }

  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  for (uint32_t block = 0; block < 48; ++block) {
    first.render(left.data(), right.data(), firstLeft.data(), firstRight.data(),
                 left.size());
    second.render(left.data(), right.data(), secondLeft.data(),
                  secondRight.data(), right.size());
    expect(firstLeft == secondLeft && firstRight == secondRight,
           "fixed seed produces deterministic whole-song output");
  }
  first.processor.functions->reset(
      first.processor.state,
      {zdsp::DiscontinuityReason::SourceSeek,
       zdsp::DiscontinuityFlagResetState});
  second.processor.functions->reset(
      second.processor.state,
      {zdsp::DiscontinuityReason::SourceSeek,
       zdsp::DiscontinuityFlagResetState});
  first.render(left.data(), right.data(), firstLeft.data(), firstRight.data(),
               left.size());
  second.render(left.data(), right.data(), secondLeft.data(),
                secondRight.data(), right.size());
  first.shutdown();
  second.shutdown();
  zdsp::test::setAllocationTrapEnabled(false);
  expect(zdsp::test::trappedAllocationCount() == 0,
         "Signalsmith process, reset and teardown allocate nothing after prepare");
  expect(firstLeft == secondLeft && firstRight == secondRight,
         "reset retains deterministic fixed-seed state");
}

void drainsPreparedTail() {
  Harness harness(7.0F);
  std::array<float, 128> input{};
  std::array<float, 128> outputLeft{};
  std::array<float, 128> outputRight{};
  input.back() = 1.0F;
  harness.render(input.data(), input.data(), outputLeft.data(),
                 outputRight.data(), input.size());
  input.fill(0.0F);
  bool heardTail = false;
  const uint32_t latency =
      harness.processor.functions->latency(harness.processor.state).value;
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  for (uint32_t rendered = 0; rendered < latency + input.size();
       rendered += input.size()) {
    outputLeft.fill(0.0F);
    outputRight.fill(0.0F);
    harness.render(input.data(), input.data(), outputLeft.data(),
                   outputRight.data(), input.size(),
                   zdsp::ProcessContextFlagTailDrain);
    for (float sample : outputLeft)
      heardTail = heardTail || std::fabs(sample) > 1e-7F;
  }
  zdsp::test::setAllocationTrapEnabled(false);
  expect(zdsp::test::trappedAllocationCount() == 0,
         "Signalsmith tail drain allocates nothing");
  expect(heardTail,
         "Signalsmith emits buffered end-of-song audio during declared tail");
}

void preparedSeekAndRecurringLoopAnchors() {
  Harness dirty(5.0F);
  Harness fresh(5.0F);
  std::array<float, 128> dirtyInput{};
  std::array<float, 128> futureLeft{};
  std::array<float, 128> futureRight{};
  std::array<float, 128> dirtyLeft{};
  std::array<float, 128> dirtyRight{};
  std::array<float, 128> freshLeft{};
  std::array<float, 128> freshRight{};
  dirtyInput.fill(0.75F);
  for (uint32_t frame = 0; frame < futureLeft.size(); ++frame) {
    futureLeft[frame] = std::sin(static_cast<float>(frame) * 0.023F);
    futureRight[frame] = std::cos(static_cast<float>(frame) * 0.031F);
  }
  for (uint32_t block = 0; block < 12; ++block)
    dirty.render(dirtyInput.data(), dirtyInput.data(), dirtyLeft.data(),
                 dirtyRight.data(), dirtyInput.size());

  std::vector<float> anchorLeft(dirty.anchorFrames());
  std::vector<float> anchorRight(dirty.anchorFrames());
  for (uint32_t frame = 0; frame < dirty.anchorFrames(); ++frame) {
    anchorLeft[frame] = std::sin(static_cast<float>(frame) * 0.007F);
    anchorRight[frame] = std::cos(static_cast<float>(frame) * 0.009F);
  }
  const auto dirtyAnchor = dirty.anchorInput(anchorLeft, anchorRight);
  const auto freshAnchor = fresh.anchorInput(anchorLeft, anchorRight);
  expect(singz::primeSignalsmithTimePitchSeek(dirty.processor, dirtyAnchor),
         "seek replacement is prepared off RT");
  expect(singz::primeSignalsmithTimePitchInitial(fresh.processor, freshAnchor),
         "initial state accepts the same prepared history off RT");
  auto status = singz::signalsmithTimePitchAnchorStatus(dirty.processor);
  expect(status.prepared == 1 && status.published == 0 && status.misses == 0 &&
             status.replacementReady,
         "seek anchor status distinguishes preparation from publication");

  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  expect(singz::armSignalsmithTimePitchSeek(dirty.processor),
         "prepared seek arms at the callback command boundary");
  dirty.reset(zdsp::DiscontinuityReason::SourceSeek);
  dirty.render(futureLeft.data(), futureRight.data(), dirtyLeft.data(),
               dirtyRight.data(), futureLeft.size());
  fresh.render(futureLeft.data(), futureRight.data(), freshLeft.data(),
               freshRight.data(), futureLeft.size());
  zdsp::test::setAllocationTrapEnabled(false);
  expect(zdsp::test::trappedAllocationCount() == 0,
         "prepared seek publication and first render allocate nothing");
  expect(dirtyLeft == freshLeft && dirtyRight == freshRight,
         "seek atomically replaces dirty stretch history with target history");
  status = singz::signalsmithTimePitchAnchorStatus(dirty.processor);
  expect(status.prepared == 1 && status.published == 1 && status.misses == 0 &&
             !status.replacementReady,
         "seek replacement publishes at exactly one reset boundary");

  const uint32_t minimumLoopFrames =
      singz::signalsmithTimePitchMinimumLoopOutputFrames(dirty.processor);
  expect(minimumLoopFrames > dirty.anchorFrames(),
         "loop admission includes an explicit replenishment deadline");
  const auto rejectedShort = singz::configureSignalsmithTimePitchLoop(
      dirty.processor, &dirtyAnchor, minimumLoopFrames - 1u);
  expect(rejectedShort.code ==
             singz::SignalsmithTimePitchLoopPrepareCode::TooShort &&
             rejectedShort.minimumOutputFrames == minimumLoopFrames,
         "a loop shorter than the guaranteed prime period is rejected");
  const auto preparedLoop = singz::configureSignalsmithTimePitchLoop(
      dirty.processor, &dirtyAnchor, minimumLoopFrames);
  expect(preparedLoop.ok() && preparedLoop.plan.valid() &&
             singz::activateSignalsmithTimePitchLoop(dirty.processor,
                                                      preparedLoop.plan),
         "admitted loop publishes a generation-bound two-entry bank");
  status = singz::signalsmithTimePitchAnchorStatus(dirty.processor);
  expect(status.prepared == 3 && status.recurring && status.replacementReady,
         "loop anchor status exposes both pre-primed replacements");
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  dirty.reset(zdsp::DiscontinuityReason::SourceLoop);
  dirty.render(futureLeft.data(), futureRight.data(), dirtyLeft.data(),
               dirtyRight.data(), futureLeft.size());
  zdsp::test::setAllocationTrapEnabled(false);
  expect(zdsp::test::trappedAllocationCount() == 0,
         "loop anchor publication and render allocate nothing");
  status = singz::signalsmithTimePitchAnchorStatus(dirty.processor);
  expect(status.published == 2 && status.misses == 0 && status.recurring,
         "loop reset consumes the prepared replacement without a miss");

  // A second wrap is deadline-safe even if the worker has not received CPU:
  // it consumes the other entry prepared before plan publication. This is a
  // deterministic boundary proof, not a permissive sleep/poll race.
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  dirty.reset(zdsp::DiscontinuityReason::SourceLoop);
  dirty.render(futureLeft.data(), futureRight.data(), dirtyLeft.data(),
               dirtyRight.data(), futureLeft.size());
  zdsp::test::setAllocationTrapEnabled(false);
  expect(zdsp::test::trappedAllocationCount() == 0,
         "second pre-primed loop publication allocates nothing");
  status = singz::signalsmithTimePitchAnchorStatus(dirty.processor);
  expect(status.published == 3 && status.misses == 0 && status.recurring,
         "two immediate loop boundaries cannot starve the replacement bank");

  const auto disabled = singz::configureSignalsmithTimePitchLoop(
      dirty.processor, nullptr, 0);
  expect(disabled.code ==
             singz::SignalsmithTimePitchLoopPrepareCode::Disabled,
         "recurring loop disable is an explicit prepared result");
  singz::deactivateSignalsmithTimePitchLoop(dirty.processor);
  status = singz::signalsmithTimePitchAnchorStatus(dirty.processor);
  expect(!status.recurring && !status.replacementReady,
         "disabling a loop retires its unused prepared replacement");
}

void idleWorkerBarelyWakes() {
  // A prepared stage with no recurring loop has nothing to replenish, and its
  // worker polled at 2 ms anyway — about 1.2% of a phone core per live stage
  // (exact per-thread ticks on the POCO), in every quiet phase. Idle it polls
  // at the slow rate; an active loop takes it back to the fast one. Margins
  // are wide on purpose (a loaded host shortens sleeps and starves threads):
  // the slow rate wakes ~3 times in 300 ms where the fast one wakes ~150.
  Harness stage(5.0F);
  const auto sleepMs = [](int ms) {
    std::this_thread::sleep_for(std::chrono::milliseconds(ms));
  };
  const auto wakeups = [&] {
    return singz::signalsmithTimePitchAnchorStatus(stage.processor)
        .workerWakeups;
  };
  const uint64_t before = wakeups();
  sleepMs(300);
  const uint64_t idle = wakeups() - before;
  expect(idle <= 12, "an idle loop worker wakes at the slow poll rate");

  std::array<float, 128> input{};
  std::array<float, 128> left{};
  std::array<float, 128> right{};
  input.fill(0.5F);
  for (uint32_t block = 0; block < 12; ++block)
    stage.render(input.data(), input.data(), left.data(), right.data(),
                 input.size());
  std::vector<float> anchorLeft(stage.anchorFrames(), 0.25F);
  std::vector<float> anchorRight(stage.anchorFrames(), 0.25F);
  const auto anchor = stage.anchorInput(anchorLeft, anchorRight);
  const uint32_t minimumLoopFrames =
      singz::signalsmithTimePitchMinimumLoopOutputFrames(stage.processor);
  const auto plan = singz::configureSignalsmithTimePitchLoop(
      stage.processor, &anchor, minimumLoopFrames);
  expect(plan.ok() && singz::activateSignalsmithTimePitchLoop(stage.processor,
                                                              plan.plan),
         "a recurring loop activates for the wake-rate check");
  // The worker notices the activation within one idle interval and then
  // polls fast; give it that interval before counting.
  sleepMs(150);
  const uint64_t activeBefore = wakeups();
  sleepMs(300);
  const uint64_t active = wakeups() - activeBefore;
  expect(active >= 30, "an active recurring loop wakes the worker at the fast poll rate");
  singz::deactivateSignalsmithTimePitchLoop(stage.processor);
}

void preparedGenericReanchorBoundaries() {
  const std::array<zdsp::DiscontinuityReason, 5> reasons{
      zdsp::DiscontinuityReason::StreamGenerationChanged,
      zdsp::DiscontinuityReason::SampleRateChanged,
      zdsp::DiscontinuityReason::RouteGenerationChanged,
      zdsp::DiscontinuityReason::TimestampQualityChanged,
      zdsp::DiscontinuityReason::ClockReanchored,
  };
  for (const zdsp::DiscontinuityReason reason : reasons) {
    Harness dirty(5.0F);
    Harness fresh(5.0F);
    std::array<float, 128> history{};
    std::array<float, 128> futureLeft{};
    std::array<float, 128> futureRight{};
    std::array<float, 128> dirtyLeft{};
    std::array<float, 128> dirtyRight{};
    std::array<float, 128> freshLeft{};
    std::array<float, 128> freshRight{};
    history.fill(0.75F);
    for (uint32_t frame = 0; frame < futureLeft.size(); ++frame) {
      futureLeft[frame] = std::sin(static_cast<float>(frame) * 0.017F);
      futureRight[frame] = std::cos(static_cast<float>(frame) * 0.019F);
    }
    for (uint32_t block = 0; block < 12; ++block)
      dirty.render(history.data(), history.data(), dirtyLeft.data(),
                   dirtyRight.data(), history.size());

    std::vector<float> anchorLeft(dirty.anchorFrames());
    std::vector<float> anchorRight(dirty.anchorFrames());
    for (uint32_t frame = 0; frame < dirty.anchorFrames(); ++frame) {
      anchorLeft[frame] = std::sin(static_cast<float>(frame) * 0.007F);
      anchorRight[frame] = std::cos(static_cast<float>(frame) * 0.009F);
    }
    const auto dirtyAnchor = dirty.anchorInput(anchorLeft, anchorRight);
    const auto freshAnchor = fresh.anchorInput(anchorLeft, anchorRight);
    const auto plan = singz::primeSignalsmithTimePitchReanchor(
        dirty.processor, dirtyAnchor);
    expect(plan.valid(),
           "generic reanchor prepares a generation-bound slot off RT");
    expect(singz::primeSignalsmithTimePitchInitial(fresh.processor, freshAnchor),
           "generic reanchor oracle accepts the same prepared history");

    zdsp::test::resetAllocationTrap();
    zdsp::test::setAllocationTrapEnabled(true);
    expect(singz::armSignalsmithTimePitchReanchor(dirty.processor, plan),
           "generic reanchor arms with bounded callback-domain atomics");
    dirty.reset(reason);
    dirty.render(futureLeft.data(), futureRight.data(), dirtyLeft.data(),
                 dirtyRight.data(), futureLeft.size());
    fresh.render(futureLeft.data(), futureRight.data(), freshLeft.data(),
                 freshRight.data(), futureLeft.size());
    zdsp::test::setAllocationTrapEnabled(false);
    expect(zdsp::test::trappedAllocationCount() == 0,
           "generic reanchor swap and first render allocate nothing");
    expect(dirtyLeft == freshLeft && dirtyRight == freshRight,
           "generic reanchor atomically replaces dirty Stretch history");
    const auto status =
        singz::signalsmithTimePitchAnchorStatus(dirty.processor);
    expect(status.prepared == 1 && status.published == 1 &&
               status.misses == 0,
           "generic reanchor publication is observable without a miss");
  }

  Harness preserved(5.0F);
  Harness control(5.0F);
  std::array<float, 128> input{};
  std::array<float, 128> preservedLeft{};
  std::array<float, 128> preservedRight{};
  std::array<float, 128> controlLeft{};
  std::array<float, 128> controlRight{};
  input.fill(0.25F);
  for (uint32_t block = 0; block < 12; ++block) {
    preserved.render(input.data(), input.data(), preservedLeft.data(),
                     preservedRight.data(), input.size());
    control.render(input.data(), input.data(), controlLeft.data(),
                   controlRight.data(), input.size());
  }
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  preserved.reset(zdsp::DiscontinuityReason::ClockReanchored);
  preserved.render(input.data(), input.data(), preservedLeft.data(),
                   preservedRight.data(), input.size());
  control.render(input.data(), input.data(), controlLeft.data(),
                 controlRight.data(), input.size());
  zdsp::test::setAllocationTrapEnabled(false);
  expect(zdsp::test::trappedAllocationCount() == 0,
         "unprepared generic boundary remains callback-allocation-free");
  expect(preservedLeft == controlLeft && preservedRight == controlRight,
         "unprepared generic boundary preserves the active Stretch engine");
  expect(singz::signalsmithTimePitchAnchorStatus(preserved.processor).misses ==
             1,
         "unprepared generic boundary reports one bounded miss");

  Harness superseded(5.0F);
  std::vector<float> oldAnchorLeft(superseded.anchorFrames(), 0.1F);
  std::vector<float> oldAnchorRight(superseded.anchorFrames(), 0.2F);
  std::vector<float> newAnchorLeft(superseded.anchorFrames(), 0.3F);
  std::vector<float> newAnchorRight(superseded.anchorFrames(), 0.4F);
  const auto oldPlan = singz::primeSignalsmithTimePitchReanchor(
      superseded.processor,
      superseded.anchorInput(oldAnchorLeft, oldAnchorRight));
  const auto newPlan = singz::primeSignalsmithTimePitchReanchor(
      superseded.processor,
      superseded.anchorInput(newAnchorLeft, newAnchorRight));
  expect(oldPlan.valid() && newPlan.valid() &&
             oldPlan.generation != newPlan.generation,
         "superseding a reanchor publishes a new exact generation");
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  expect(!singz::armSignalsmithTimePitchReanchor(superseded.processor,
                                                 oldPlan),
         "a stale reanchor generation cannot claim the replacement slot");
  expect(singz::armSignalsmithTimePitchReanchor(superseded.processor,
                                                newPlan),
         "the current reanchor generation remains publishable");
  superseded.reset(zdsp::DiscontinuityReason::RouteGenerationChanged);
  zdsp::test::setAllocationTrapEnabled(false);
  expect(zdsp::test::trappedAllocationCount() == 0,
         "stale-token rejection and current-token swap allocate nothing");
  auto supersededStatus =
      singz::signalsmithTimePitchAnchorStatus(superseded.processor);
  expect(supersededStatus.prepared == 2 &&
             supersededStatus.published == 1 &&
             supersededStatus.misses == 0,
         "only the current generation reaches the active Stretch engine");

  const auto unusedPlan = singz::primeSignalsmithTimePitchReanchor(
      superseded.processor,
      superseded.anchorInput(oldAnchorLeft, oldAnchorRight));
  expect(unusedPlan.valid(), "an unused initial-style reanchor can be prepared");
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  singz::discardSignalsmithTimePitchReanchor(superseded.processor, unusedPlan);
  zdsp::test::setAllocationTrapEnabled(false);
  supersededStatus =
      singz::signalsmithTimePitchAnchorStatus(superseded.processor);
  expect(zdsp::test::trappedAllocationCount() == 0 &&
             !supersededStatus.replacementReady,
         "discarding an unneeded reanchor is bounded and returns its slot");

  expect(singz::primeSignalsmithTimePitchSeek(
             superseded.processor,
             superseded.anchorInput(newAnchorLeft, newAnchorRight)),
         "a superseded command-order seek can be prepared");
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  singz::discardSignalsmithTimePitchSeek(superseded.processor);
  zdsp::test::setAllocationTrapEnabled(false);
  expect(zdsp::test::trappedAllocationCount() == 0 &&
             !singz::signalsmithTimePitchAnchorStatus(superseded.processor)
                  .replacementReady,
         "discarding a non-final seek is bounded and returns its slot");
}

void invalidContracts() {
  alignas(64) std::array<uint8_t, 65536> state{};
  singz::SignalsmithTimePitchConfig config{{711}, {48000.0}, 2, 128, 0.0F};
  expect(singz::signalsmithTimePitchRetainedBytes(config) >
             singz::signalsmithTimePitchPreparedBytes(config),
         "retained estimate accounts for hidden Signalsmith FFT/vector heap");
  auto rejected = [&](const singz::SignalsmithTimePitchConfig &candidate) {
    return singz::createSignalsmithTimePitch(
               candidate,
               {state.data(), static_cast<uint32_t>(state.size())})
               .state == nullptr;
  };
  auto invalid = config;
  invalid.node = {0};
  expect(rejected(invalid), "Signalsmith rejects zero node identity");
  invalid = config;
  invalid.channels = 0;
  expect(rejected(invalid), "Signalsmith rejects zero channels");
  invalid = config;
  invalid.maximumBlockFrames = 0;
  expect(rejected(invalid), "Signalsmith rejects zero callback capacity");
  invalid = config;
  invalid.transposeSemitones = 49.0F;
  expect(rejected(invalid), "Signalsmith rejects an unsafe transpose range");
  invalid = config;
  invalid.sampleRate = {7999.0};
  expect(rejected(invalid), "Signalsmith rejects an unsupported low rate");
  invalid = config;
  invalid.sampleRate = {192001.0};
  expect(rejected(invalid), "Signalsmith rejects an unsupported high rate");
  invalid = config;
  invalid.channels = 9;
  expect(rejected(invalid), "Signalsmith rejects more than 7.1 channels");
  invalid = config;
  invalid.maximumBlockFrames = 8193;
  expect(rejected(invalid), "Signalsmith rejects an oversized callback");
  expect(singz::createSignalsmithTimePitch(
             config, {state.data(), 1})
             .state == nullptr,
         "Signalsmith rejects insufficient state storage");
}

void retainedEstimateCoversPinnedAllocator() {
  // The combined maximum exercises the worst supported rate/channel product
  // and maximum callback warm-up.  The minimum proves the fixed part of the
  // envelope; the ordinary stereo case prevents a max-only blind spot.
  const std::array<singz::SignalsmithTimePitchConfig, 3> configs{{
      {{720}, {8000.0}, 1, 1, 0.0F},
      {{721}, {48000.0}, 2, 4096, 7.0F},
      {{722}, {192000.0}, 8, 8192, -12.0F},
  }};
  for (const auto &config : configs) {
    const size_t stateBytes = singz::signalsmithTimePitchStateBytes();
    const size_t preparedBytes =
        singz::signalsmithTimePitchPreparedBytes(config);
    const size_t retainedBytes =
        singz::signalsmithTimePitchRetainedBytes(config);
    expect(preparedBytes != 0 && retainedBytes != 0,
           "supported extreme has a deterministic retained estimate");
    std::vector<uint8_t> state(stateBytes);
    std::vector<float> prepared(preparedBytes / sizeof(float));
    auto processor = singz::createSignalsmithTimePitch(
        config, {state.data(), static_cast<uint32_t>(state.size())});
    expect(processor.state != nullptr,
           "supported extreme constructs before allocation measurement");
    std::array<zdsp::AudioChannelRole, 8> roles{};
    for (uint32_t channel = 0; channel < config.channels; ++channel)
      roles[channel] = zdsp::AudioChannelRole::Discrete;
    const zdsp::AudioBusDescriptor bus{
        config.channels, zdsp::SampleFormat::Float32Planar,
        config.channels == 1 ? zdsp::AudioChannelLayout::Mono
                             : (config.channels == 2
                                    ? zdsp::AudioChannelLayout::Stereo
                                    : zdsp::AudioChannelLayout::Discrete),
        config.channels > 2 ? roles.data() : nullptr};
    const zdsp::PrepareSpec spec{
        zdsp::kProcessorInterfaceVersion, zdsp::kPrepareSpecV1RequiredSize,
        config.sampleRate, {config.maximumBlockFrames}, 1, 1, &bus, &bus};
    const zdsp::PreparedStorage storage{
        prepared.data(), preparedBytes, alignof(float)};
    zdsp::test::resetAllocationTrap();
    zdsp::test::setAllocationTrapEnabled(true);
    const zdsp::Status preparedStatus =
        processor.functions->prepare(processor.state, &spec, &storage);
    zdsp::test::setAllocationTrapEnabled(false);
    if (!zdsp::succeeded(preparedStatus))
      std::fprintf(stderr,
                   "prepare failed at %.0f Hz/%u ch/%u frames: %u detail %u\n",
                   config.sampleRate.value, config.channels,
                   config.maximumBlockFrames,
                   static_cast<unsigned>(preparedStatus.code),
                   preparedStatus.detail);
    expect(zdsp::succeeded(preparedStatus),
           "supported extreme configures and warms the pinned processor");
    const uint64_t measuredPrepare = zdsp::test::trappedAllocationBytes();
    const uint32_t anchorFrames =
        singz::signalsmithTimePitchAnchorFrames(processor);
    std::vector<std::vector<float>> anchorSamples(
        config.channels, std::vector<float>(anchorFrames, 0.125F));
    std::array<const float *, singz::kSignalsmithTimePitchMaximumChannels>
        anchorChannels{};
    for (uint32_t channel = 0; channel < config.channels; ++channel)
      anchorChannels[channel] = anchorSamples[channel].data();
    const singz::SignalsmithTimePitchAnchorInput anchor{
        anchorChannels.data(), config.channels, anchorFrames};
    const uint32_t minimumLoopFrames =
        singz::signalsmithTimePitchMinimumLoopOutputFrames(processor);
    zdsp::test::resetAllocationTrap();
    zdsp::test::setAllocationTrapEnabled(true);
    const auto firstBank = singz::configureSignalsmithTimePitchLoop(
        processor, &anchor, minimumLoopFrames);
    const auto secondBank = singz::configureSignalsmithTimePitchLoop(
        processor, &anchor, minimumLoopFrames);
    zdsp::test::setAllocationTrapEnabled(false);
    expect(firstBank.code == singz::SignalsmithTimePitchLoopPrepareCode::Ready &&
               secondBank.code ==
                   singz::SignalsmithTimePitchLoopPrepareCode::Ready &&
               firstBank.plan.bank != secondBank.plan.bank,
           "allocation proof prepares both independently retained loop banks");
    const uint64_t measuredLoopBanks =
        zdsp::test::trappedAllocationBytes();
    const uint64_t exactLoopSamples =
        static_cast<uint64_t>(anchorFrames) * config.channels * sizeof(float) *
        2u;
    expect(measuredLoopBanks >= exactLoopSamples,
           "allocation helper observes both recurring loop-bank sample copies");
    const uint64_t measuredInternal = measuredPrepare + measuredLoopBanks;
    expect(measuredInternal != 0,
           "allocation helper observes pinned internal heap requests");
    expect(measuredInternal <=
               retainedBytes - stateBytes - preparedBytes,
           "retained estimate covers cumulative pinned heap requests plus external storage");
    expect(zdsp::succeeded(processor.functions->deactivate(processor.state)),
           "measured processor deactivates");
    expect(zdsp::succeeded(zdsp::destroyProcessor(&processor)),
           "measured processor destroys");
  }
}

} // namespace

int main() {
  invalidContracts();
  retainedEstimateCoversPinnedAllocator();
  preparedDeterministicRealtimeContract();
  preparedSeekAndRecurringLoopAnchors();
  idleWorkerBarelyWakes();
  preparedGenericReanchorBoundaries();
  drainsPreparedTail();
  std::puts("signalsmith time/pitch tests passed");
  return 0;
}
