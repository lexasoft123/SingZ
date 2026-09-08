// The feeder and the source node together, against the full decode.
//
// The node's own tests (zdsp/tests/streaming_window_source_tests.cpp) hand it a
// window filled by hand. This one puts the real pieces in a line — a FLAC on
// disk, the streaming decoder, the ring, the transport — and asks the question
// that actually matters to a singer: does the song come out of the graph the
// same as it does today, and does it come out without gaps?
//
// The reference is `prepareDecodedAudio`, the up-front decode this replaces.
#include "streaming_lane_feeder.h"

#include <zcore/media/decoded_audio.h>
#include <zcore/media/flac_io.h>
#include <zdsp/streaming_window_source.h>

#include <FLAC/stream_encoder.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <chrono>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace {

int failures = 0;
void check(bool ok, const char* what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL  %s\n", what);
    failures++;
  }
}

constexpr uint32_t kRate = 44100;
constexpr uint64_t kFrames = 400000;  // ~9 s
constexpr uint32_t kBlock = 512;

std::string tempPath(const char* suffix) {
  static int counter = 0;
  std::string path = "/tmp/singz_feeder_";
  path += std::to_string(counter++);
  path += suffix;
  return path;
}

singz::OwnedFileDescriptor openRead(const std::string& path) {
#if defined(_WIN32)
  int fd = -1;
  _sopen_s(&fd, path.c_str(), _O_RDONLY | _O_BINARY, _SH_DENYNO, 0);
#else
  const int fd = ::open(path.c_str(), O_RDONLY);
#endif
  return singz::OwnedFileDescriptor(fd);
}

std::string encodeFlac(uint64_t frames, uint32_t rate, unsigned channels) {
  const std::string path = tempPath(".flac");
  FLAC__StreamEncoder* e = FLAC__stream_encoder_new();
  FLAC__stream_encoder_set_channels(e, channels);
  FLAC__stream_encoder_set_bits_per_sample(e, 16);
  FLAC__stream_encoder_set_sample_rate(e, rate);
  FLAC__stream_encoder_set_compression_level(e, 5);
  FLAC__stream_encoder_set_total_samples_estimate(e, frames);
  if (FLAC__stream_encoder_init_file(e, path.c_str(), nullptr, nullptr) !=
      FLAC__STREAM_ENCODER_INIT_STATUS_OK) {
    FLAC__stream_encoder_delete(e);
    return {};
  }
  std::vector<FLAC__int32> block(4096 * channels);
  uint64_t at = 0;
  while (at < frames) {
    const uint64_t n = std::min<uint64_t>(4096, frames - at);
    for (uint64_t i = 0; i < n; i++)
      for (unsigned c = 0; c < channels; c++)
        block[i * channels + c] = static_cast<FLAC__int32>(
            std::lround(9000.0 * std::sin((at + i) * (0.011 + 0.003 * c))));
    FLAC__stream_encoder_process_interleaved(e, block.data(),
                                             static_cast<unsigned>(n));
    at += n;
  }
  FLAC__stream_encoder_finish(e);
  FLAC__stream_encoder_delete(e);
  return path;
}

struct Output {
  std::vector<std::vector<float>> planes;
  std::vector<float*> pointers;
  zdsp::MutableAudioBusView view{};
  Output(uint32_t channels) {
    planes.assign(channels, std::vector<float>(kBlock, 0.0F));
    pointers.resize(channels);
    for (uint32_t c = 0; c < channels; c++)
      pointers[c] = planes[c].data();
    view.channels = pointers.data();
    view.channelCount = channels;
    view.frames = {kBlock};
  }
};

bool prepareSource(const zdsp::ProcessorHandle& handle, uint32_t channels) {
  const zdsp::AudioBusDescriptor bus{channels,
                                     zdsp::SampleFormat::Float32Planar,
                                     zdsp::AudioChannelLayout::Stereo, nullptr};
  zdsp::PrepareSpec spec{};
  spec.interfaceVersion = zdsp::kProcessorInterfaceVersion;
  spec.structSize = zdsp::kPrepareSpecV1RequiredSize;
  spec.sampleRate = {static_cast<double>(kRate)};
  spec.maximumBlockFrames = {kBlock};
  spec.inputBusCount = 0;
  spec.outputBusCount = 1;
  spec.inputBuses = nullptr;
  spec.outputBuses = &bus;
  return zdsp::succeeded(
      handle.functions->prepare(handle.state, &spec, nullptr));
}

void renderBlock(const zdsp::ProcessorHandle& handle, Output* output,
                 int64_t projectSamples) {
  zdsp::TransportContext transport{};
  transport.validFields = zdsp::TransportValidProjectSamples;
  transport.stateFlags = zdsp::TransportStatePlaying;
  transport.projectTimeSamples = projectSamples;
  transport.projectRateQ32 = zdsp::kProjectRateOneQ32;
  zdsp::ProcessContext context{};
  context.interfaceVersion = zdsp::kProcessorInterfaceVersion;
  context.structSize = zdsp::kProcessContextV1RequiredSize;
  context.transport = &transport;
  context.sampleRate = {static_cast<double>(kRate)};
  context.frames = {kBlock};
  handle.functions->process(handle.state, &context, nullptr, 0, &output->view,
                            1);
}

}  // namespace

int main() {
  const std::string wav = tempPath(".wav");
  const std::string flac = encodeFlac(kFrames, kRate, 2);
  if (flac.empty()) {
    std::fprintf(stderr, "FAIL  the fixture could not be encoded\n");
    return 1;
  }

  // The reference: the whole song, decoded up front, exactly as today.
  singz::DecodedAudioPrepareOptions decodeOptions;
  decodeOptions.sourceFormat = singz::DecodedAudioSourceFormat::Flac;
  const singz::DecodedAudioResult reference =
      singz::prepareDecodedAudio(openRead(flac), decodeOptions);
  check(reference.ok(), "the reference decode succeeds");
  if (!reference.ok())
    return 1;

  // ---- 1. the feeder keeps the node fed for a whole linear pass ----------
  //
  // Serviced on this thread between blocks, which is stricter than the real
  // feeder thread: it gets exactly one chance per block to keep up.
  {
    singz::StreamingLaneGroup group;
    singz::StreamingLaneOptions options;
    options.windowFrames = 65536;
    options.targetAheadFrames = 32768;
    options.safetyFrames = 8192;
    options.primeFrames = 16384;
    group.setOptions(options);
    check(group.addLane(openRead(flac), kRate) == singz::DecodedAudioStatus::Ok,
          "a lane opens");
    check(group.prime(0) == singz::DecodedAudioStatus::Ok,
          "and primes at the start");

    std::vector<uint8_t> storage(zdsp::streamingWindowSourceStateBytes() + 64);
    uint8_t* aligned = storage.data() +
                       ((64 - (reinterpret_cast<uintptr_t>(storage.data()) &
                               63u)) &
                        63u);
    const zdsp::ProcessorHandle streamed = zdsp::createPositionedStreamingSource(
        {{1}, group.window(0), 0, 0},
        {aligned, static_cast<uint32_t>(zdsp::streamingWindowSourceStateBytes())});
    check(streamed.state != nullptr, "the source node is created over it");
    check(prepareSource(streamed, 2), "and prepares");

    Output out(2);
    bool matched = true;
    uint64_t compared = 0;
    const uint64_t blocks = (kFrames - kBlock) / kBlock;
    for (uint64_t block = 0; block < blocks; block++) {
      const int64_t at = static_cast<int64_t>(block * kBlock);
      for (int round = 0; round < 8; round++)
        if (!group.serviceOnceForTesting())
          break;
      renderBlock(streamed, &out, at);
      for (uint32_t c = 0; c < 2; c++)
        for (uint32_t f = 0; f < kBlock; f++) {
          const float expected =
              reference.audio->channelData(c)[static_cast<uint64_t>(at) + f];
          if (out.planes[c][f] != expected)
            matched = false;
          compared++;
        }
    }
    check(compared > 700000, "the pass actually compared the whole song");
    check(matched, "every frame of a linear pass matches the full decode");
    const singz::StreamingLaneStats stats = group.stats(0);
    check(stats.starvedBlocks == 0,
          "and no block starved, so a singer hears no gap");
    (void)streamed.functions->deactivate(streamed.state);
    (void)streamed.functions->destroy(streamed.state);
  }

  // ---- 2. a scrub is chased, and what plays after it is the right audio --
  {
    singz::StreamingLaneGroup group;
    singz::StreamingLaneOptions options;
    options.windowFrames = 65536;
    options.targetAheadFrames = 32768;
    options.safetyFrames = 8192;
    options.primeFrames = 16384;
    group.setOptions(options);
    check(group.addLane(openRead(flac), kRate) == singz::DecodedAudioStatus::Ok,
          "a lane opens for the scrub case");
    check(group.prime(0) == singz::DecodedAudioStatus::Ok, "and primes");

    std::vector<uint8_t> storage(zdsp::streamingWindowSourceStateBytes() + 64);
    uint8_t* aligned = storage.data() +
                       ((64 - (reinterpret_cast<uintptr_t>(storage.data()) &
                               63u)) &
                        63u);
    const zdsp::ProcessorHandle streamed = zdsp::createPositionedStreamingSource(
        {{1}, group.window(0), 0, 0},
        {aligned, static_cast<uint32_t>(zdsp::streamingWindowSourceStateBytes())});
    check(streamed.state != nullptr && prepareSource(streamed, 2),
          "the node prepares for the scrub case");

    Output out(2);
    // Jump backwards and forwards the way a singer works a phrase.
    const int64_t spots[] = {300000, 12000, 250000, 4096, 380000};
    bool matched = true;
    for (const int64_t spot : spots) {
      // The block at the new spot may starve — that is the design. What must
      // be true is that the feeder catches up and the audio is then correct.
      renderBlock(streamed, &out, spot);
      for (int round = 0; round < 64; round++)
        group.serviceOnceForTesting();
      renderBlock(streamed, &out, spot);
      for (uint32_t c = 0; c < 2; c++)
        for (uint32_t f = 0; f < kBlock; f++) {
          const float expected =
              reference.audio->channelData(c)[static_cast<uint64_t>(spot) + f];
          if (out.planes[c][f] != expected)
            matched = false;
        }
    }
    check(matched, "after each scrub the audio is the song's own samples");
    check(group.stats(0).seeks >= 4,
          "and each scrub cost a seek, not a silent forward decode");
    (void)streamed.functions->deactivate(streamed.state);
    (void)streamed.functions->destroy(streamed.state);
  }

  // ---- 3. the feeder thread keeps up on its own ---------------------------
  //
  // Same linear pass, but serviced by the real thread rather than by hand, so
  // the threading and the wake-up interval are exercised too.
  //
  // PACED, and that is not a weakening of the test. Rendering flat out asks
  // the feeder to supply thousands of times realtime, which no decoder can do
  // and no device ever demands — the first version of this case failed for
  // exactly that reason and was measuring the test harness, not the feeder.
  // 20x realtime is far past what a phone asks for and still a real bar.
  {
    singz::StreamingLaneGroup group;
    check(group.addLane(openRead(flac), kRate) == singz::DecodedAudioStatus::Ok,
          "a lane opens for the threaded case");
    check(group.prime(0) == singz::DecodedAudioStatus::Ok, "and primes");
    group.start();

    std::vector<uint8_t> storage(zdsp::streamingWindowSourceStateBytes() + 64);
    uint8_t* aligned = storage.data() +
                       ((64 - (reinterpret_cast<uintptr_t>(storage.data()) &
                               63u)) &
                        63u);
    const zdsp::ProcessorHandle streamed = zdsp::createPositionedStreamingSource(
        {{1}, group.window(0), 0, 0},
        {aligned, static_cast<uint32_t>(zdsp::streamingWindowSourceStateBytes())});
    check(streamed.state != nullptr && prepareSource(streamed, 2),
          "the node prepares for the threaded case");

    Output out(2);
    bool matched = true;
    const uint64_t blocks = (kFrames - kBlock) / kBlock;
    for (uint64_t block = 0; block < blocks; block++) {
      const int64_t at = static_cast<int64_t>(block * kBlock);
      renderBlock(streamed, &out, at);
      for (uint32_t c = 0; c < 2; c++)
        for (uint32_t f = 0; f < kBlock; f++)
          if (out.planes[c][f] !=
              reference.audio->channelData(c)[static_cast<uint64_t>(at) + f])
            matched = false;
      std::this_thread::sleep_for(std::chrono::microseconds(
          static_cast<long long>(1000000.0 * kBlock / kRate / 20.0)));
    }
    group.stop();
    check(matched, "the feeder thread delivers the same audio as the decode");
    (void)streamed.functions->deactivate(streamed.state);
    (void)streamed.functions->destroy(streamed.state);
  }

  std::remove(flac.c_str());
  std::remove(wav.c_str());
  if (failures == 0)
    std::printf("streaming lane feeder: the graph plays a FLAC without decoding it\n");
  return failures == 0 ? 0 : 1;
}
