// The streaming source against the decoded source it is meant to replace.
//
// The bar is parity, not plausibility: for any transport the two nodes are
// given, a fed streaming window must render the SAME floats as a fully decoded
// buffer. A lane that is a few samples out drifts against the other five and
// nothing downstream can see it, which is why these cases compare samples
// rather than checking that something non-zero came out.
//
// What is deliberately NOT parity is behaviour when the window has not caught
// up. There the decoded source has an answer that streaming cannot have, and
// the honest response on the render thread is silence plus a count — a file
// operation there is precisely what this node exists to avoid.
#include "zdsp/decoded_buffer_source.h"
#include "zdsp/streaming_window_source.h"

#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {
using namespace zdsp;

int failures = 0;
void check(bool ok, const char *what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL  %s\n", what);
    failures++;
  }
}

constexpr uint32_t kChannels = 2;
constexpr uint64_t kSongFrames = 200000;
constexpr uint64_t kCapacity = 8192;  // power of two, ~186 ms at 44.1k
constexpr uint32_t kBlock = 256;
constexpr double kRate = 44100.0;

// Two channels that differ and do not repeat, so a source that swapped or
// offset a channel cannot pass by luck.
float sampleAt(uint32_t channel, uint64_t frame) {
  const double t = static_cast<double>(frame);
  return static_cast<float>(channel == 0 ? std::sin(t * 0.0013)
                                         : 0.7 * std::sin(t * 0.00031 + 1.0));
}

struct Song {
  std::vector<std::vector<float>> planes;
  std::array<const float *, kChannels> pointers{};
  Song() {
    planes.assign(kChannels, std::vector<float>(kSongFrames, 0.0F));
    for (uint32_t c = 0; c < kChannels; c++) {
      for (uint64_t f = 0; f < kSongFrames; f++)
        planes[c][f] = sampleAt(c, f);
      pointers[c] = planes[c].data();
    }
  }
};

// A window plus its storage. `feedTo(end)` fills every frame the feeder would
// have delivered for a resident range ending at `end`, exactly as a real feeder
// would: it may only hold `capacityFrames`, so the start trails the end.
struct Window {
  std::vector<std::vector<float>> planes;
  std::array<float *, kChannels> pointers{};
  StreamingWindow window{};
  Window() {
    planes.assign(kChannels, std::vector<float>(kCapacity, 0.0F));
    for (uint32_t c = 0; c < kChannels; c++)
      pointers[c] = planes[c].data();
    window.channels = pointers.data();
    window.channelCount = kChannels;
    window.capacityFrames = kCapacity;
    window.totalFrames = kSongFrames;
    window.sampleRate = {kRate};
    streamingWindowInitialize(&window, 0);
  }
  void feed(uint64_t start, uint64_t end) {
    if (end > kSongFrames)
      end = kSongFrames;
    if (end - start > kCapacity)
      start = end - kCapacity;
    for (uint64_t f = start; f < end; f++)
      for (uint32_t c = 0; c < kChannels; c++)
        planes[c][f & (kCapacity - 1)] = sampleAt(c, f);
    streamingWindowPublishResident(&window, start, end);
  }
};

struct Output {
  std::vector<std::vector<float>> planes;
  std::array<float *, kChannels> pointers{};
  MutableAudioBusView view{};
  Output() {
    planes.assign(kChannels, std::vector<float>(kBlock, 0.0F));
    for (uint32_t c = 0; c < kChannels; c++)
      pointers[c] = planes[c].data();
    view.channels = pointers.data();
    view.channelCount = kChannels;
    view.frames = {kBlock};
  }
};

AudioBusDescriptor stereoBus() {
  return {kChannels, SampleFormat::Float32Planar, AudioChannelLayout::Stereo,
          nullptr};
}

bool prepareSource(const ProcessorHandle &handle) {
  const AudioBusDescriptor bus = stereoBus();
  PrepareSpec spec{};
  spec.interfaceVersion = kProcessorInterfaceVersion;
  spec.structSize = kPrepareSpecV1RequiredSize;
  spec.sampleRate = {kRate};
  spec.maximumBlockFrames = {kBlock};
  spec.inputBusCount = 0;
  spec.outputBusCount = 1;
  spec.inputBuses = nullptr;
  spec.outputBuses = &bus;
  return succeeded(handle.functions->prepare(handle.state, &spec, nullptr));
}

// One block at a project position, played.
void renderBlock(const ProcessorHandle &handle, Output *output,
                 int64_t projectSamples) {
  TransportContext transport{};
  transport.validFields = TransportValidProjectSamples;
  transport.stateFlags = TransportStatePlaying;
  transport.projectTimeSamples = projectSamples;
  transport.projectTimeFractionQ32 = 0;
  transport.projectRateQ32 = kProjectRateOneQ32;
  ProcessContext context{};
  context.interfaceVersion = kProcessorInterfaceVersion;
  context.structSize = kProcessContextV1RequiredSize;
  context.transport = &transport;
  context.sampleRate = {kRate};
  context.frames = {kBlock};
  handle.functions->process(handle.state, &context, nullptr, 0, &output->view,
                            1);
}

void destroySource(const ProcessorHandle &handle) {
  (void)handle.functions->deactivate(handle.state);
  (void)handle.functions->destroy(handle.state);
}

}  // namespace

int main() {
  Song song;
  std::vector<uint8_t> decodedStorage(decodedBufferSourceStateBytes() + 64);
  std::vector<uint8_t> streamStorage(streamingWindowSourceStateBytes() + 64);
  auto align = [](std::vector<uint8_t> &bytes) {
    uintptr_t address = reinterpret_cast<uintptr_t>(bytes.data());
    const uintptr_t aligned = (address + 63u) & ~static_cast<uintptr_t>(63u);
    return bytes.data() + (aligned - address);
  };

  // ---- 1. parity with the decoded source, block after block --------------
  {
    Window window;
    ProcessorHandle decoded = createPositionedDecodedBufferSource(
        {{1},
         {song.pointers.data(), kChannels, kSongFrames, {kRate}},
         0,
         0},
        {align(decodedStorage), static_cast<uint32_t>(kBlock * 64)});
    ProcessorHandle streamed = createPositionedStreamingSource(
        {{2}, &window.window, 0, 0},
        {align(streamStorage), static_cast<uint32_t>(kBlock * 64)});
    check(decoded.state != nullptr, "the decoded source is created");
    check(streamed.state != nullptr, "the streaming source is created");
    check(prepareSource(decoded) && prepareSource(streamed),
          "both sources prepare against the same spec");

    Output a;
    Output b;
    bool identical = true;
    bool sawAudio = false;
    for (uint32_t block = 0; block < 100; block++) {
      const int64_t at = static_cast<int64_t>(block) * kBlock;
      // The feeder stays a window ahead, which is its whole job.
      window.feed(0, static_cast<uint64_t>(at) + kCapacity / 2);
      renderBlock(decoded, &a, at);
      renderBlock(streamed, &b, at);
      for (uint32_t c = 0; c < kChannels; c++)
        for (uint32_t f = 0; f < kBlock; f++) {
          if (a.planes[c][f] != b.planes[c][f])
            identical = false;
          if (a.planes[c][f] != 0.0F)
            sawAudio = true;
        }
    }
    check(sawAudio, "the reference actually rendered audio, so parity means something");
    check(identical, "a fed window renders exactly what the decoded buffer does");
    check(window.window.starvedBlocks.load(std::memory_order_relaxed) == 0,
          "and a window kept ahead never starves");
    destroySource(decoded);
    destroySource(streamed);
  }

  // ---- 2. a seek the feeder has not caught up on is silence, and counted --
  //
  // This is the case the decoded source cannot have, and the one a singer
  // would hear as a dropout rather than as a wrong note.
  {
    Window window;
    ProcessorHandle streamed = createPositionedStreamingSource(
        {{2}, &window.window, 0, 0},
        {align(streamStorage), static_cast<uint32_t>(kBlock * 64)});
    check(streamed.state != nullptr && prepareSource(streamed),
          "the streaming source prepares for the seek case");
    Output out;
    window.feed(0, kCapacity);
    renderBlock(streamed, &out, 0);
    check(window.window.starvedBlocks.load(std::memory_order_relaxed) == 0,
          "playing inside the window does not starve");

    // Jump far past what the feeder has: every frame must be silent.
    const int64_t far = 150000;
    renderBlock(streamed, &out, far);
    bool silent = true;
    for (uint32_t c = 0; c < kChannels; c++)
      for (uint32_t f = 0; f < kBlock; f++)
        if (out.planes[c][f] != 0.0F)
          silent = false;
    check(silent, "a seek beyond the window renders silence, never stale samples");
    check(window.window.starvedBlocks.load(std::memory_order_relaxed) == 1,
          "and the starved block is counted exactly once");

    // The feeder is told where to go, which is how it recovers.
    uint64_t demand = 0;
    check(streamingWindowDemand(&window.window, &demand),
          "the block published its demand");
    check(demand == static_cast<uint64_t>(far),
          "and demand is the frame playback actually wanted");

    // Once fed there, the same block plays — and matches the song exactly.
    window.feed(static_cast<uint64_t>(far), static_cast<uint64_t>(far) + kCapacity);
    renderBlock(streamed, &out, far);
    bool recovered = true;
    for (uint32_t c = 0; c < kChannels; c++)
      for (uint32_t f = 0; f < kBlock; f++)
        if (out.planes[c][f] != sampleAt(c, static_cast<uint64_t>(far) + f))
          recovered = false;
    check(recovered, "and the frames after the refill are the song's own samples");
    destroySource(streamed);
  }

  // ---- 2b. scrubbing BACKWARDS out of the window is silence too ----------
  //
  // Its own case because the forward jump above does not actually prove the
  // range check: there the next frame is missing as well, so the interpolation
  // guard would have produced silence even with the range check deleted
  // (measured — that mutant passed case 2). Playing BEHIND a window whose end
  // is far ahead leaves the next frame present and the wanted frame absent,
  // which only the range check can catch. A singer scrubbing back a verse hits
  // exactly this, and without the check the ring hands out a stale frame from
  // whatever the modulo lands on — audible, and wrong rather than late.
  {
    Window window;
    ProcessorHandle streamed = createPositionedStreamingSource(
        {{2}, &window.window, 0, 0},
        {align(streamStorage), static_cast<uint32_t>(kBlock * 64)});
    check(streamed.state != nullptr && prepareSource(streamed),
          "the streaming source prepares for the backwards case");
    Output out;
    window.feed(100000, 100000 + kCapacity);
    const int64_t behind = 50000;
    renderBlock(streamed, &out, behind);
    bool silent = true;
    for (uint32_t c = 0; c < kChannels; c++)
      for (uint32_t f = 0; f < kBlock; f++)
        if (out.planes[c][f] != 0.0F)
          silent = false;
    check(silent, "a position behind the window is silent, not a stale ring frame");
    check(window.window.starvedBlocks.load(std::memory_order_relaxed) == 1,
          "and it counts as one starved block");
    uint64_t demand = 0;
    check(streamingWindowDemand(&window.window, &demand) &&
              demand == static_cast<uint64_t>(behind),
          "and the feeder is told to come back for it");
    destroySource(streamed);
  }

  // ---- 3. the window may not claim more than it can hold -----------------
  //
  // A feeder that published a range longer than the ring would have the render
  // thread indexing frames its own newer samples had already overwritten. That
  // is a WRONG sample rather than a late one, so the publication clamps.
  {
    Window window;
    streamingWindowPublishResident(&window.window, 0, kCapacity * 4);
    uint64_t start = 0;
    uint64_t end = 0;
    check(streamingWindowResident(&window.window, &start, &end),
          "an oversized range still publishes");
    check(end - start == kCapacity,
          "but is clamped to what the ring can actually hold");
    check(end == kCapacity * 4, "keeping the newest frames, not the oldest");
  }

  // ---- 4. a bad window is refused rather than played ----------------------
  {
    Window window;
    window.window.capacityFrames = 5000;  // not a power of two
    check(createPositionedStreamingSource(
              {{2}, &window.window, 0, 0},
              {align(streamStorage), static_cast<uint32_t>(kBlock * 64)})
                  .state == nullptr,
          "a capacity that is not a power of two is refused");
    window.window.capacityFrames = kCapacity;
    check(createPositionedStreamingSource(
              {{2}, nullptr, 0, 0},
              {align(streamStorage), static_cast<uint32_t>(kBlock * 64)})
                  .state == nullptr,
          "and so is a missing window");
  }

  if (failures == 0)
    std::printf("streaming window source: parity with the decoded buffer\n");
  return failures == 0 ? 0 : 1;
}
