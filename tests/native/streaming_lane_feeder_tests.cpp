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
#include <cstring>
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

// Windows has no /tmp, so a hardcoded one made `init_file` fail and the suite
// reported "the fixture could not be encoded" — a red that says nothing about
// the feeder. Same shape as flac_streaming_source_tests' own tempPath.
std::string tempPath(const char* suffix) {
  static int counter = 0;
  const std::string base =
#if defined(_WIN32)
      std::string(std::getenv("TEMP") != nullptr ? std::getenv("TEMP") : ".");
#else
      std::string("/tmp");
#endif
  return base + "/singz_feeder_" + std::to_string(counter++) + suffix;
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

// A 32-bit float stereo WAV with peaks past full scale — the shape of every
// lead and backing lane since 0.23.0, which the feeder could not stream at all
// until the WAV source existed (one such lane put the whole song back on a
// full decode).
std::string writeFloatWav(uint64_t frames, uint32_t rate) {
  const std::string path = tempPath(".wav");
  std::FILE* f = std::fopen(path.c_str(), "wb");
  if (f == nullptr) return {};
  const uint32_t dataBytes = static_cast<uint32_t>(frames * 2 * 4);
  auto u32 = [&](uint32_t v) { std::fwrite(&v, 4, 1, f); };
  auto u16 = [&](uint16_t v) { std::fwrite(&v, 2, 1, f); };
  std::fwrite("RIFF", 1, 4, f);
  u32(36 + dataBytes);
  std::fwrite("WAVEfmt ", 1, 8, f);
  u32(16); u16(3); u16(2); u32(rate); u32(rate * 8); u16(8); u16(32);
  std::fwrite("data", 1, 4, f);
  u32(dataBytes);
  for (uint64_t i = 0; i < frames; i++) {
    const double t = static_cast<double>(i);
    const float left = static_cast<float>(1.6 * std::sin(t * 0.013));
    const float right = static_cast<float>(0.7 * std::sin(t * 0.0029 + 0.5));
    std::fwrite(&left, 4, 1, f);
    std::fwrite(&right, 4, 1, f);
  }
  std::fclose(f);
  return path;
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

// `rate` is the DEVICE's: a resampled lane's node runs at the rate it was
// resampled into, never at the file's.
bool prepareSource(const zdsp::ProcessorHandle& handle, uint32_t channels,
                   uint32_t rate = kRate) {
  const zdsp::AudioBusDescriptor bus{channels,
                                     zdsp::SampleFormat::Float32Planar,
                                     zdsp::AudioChannelLayout::Stereo, nullptr};
  zdsp::PrepareSpec spec{};
  spec.interfaceVersion = zdsp::kProcessorInterfaceVersion;
  spec.structSize = zdsp::kPrepareSpecV1RequiredSize;
  spec.sampleRate = {static_cast<double>(rate)};
  spec.maximumBlockFrames = {kBlock};
  spec.inputBusCount = 0;
  spec.outputBusCount = 1;
  spec.inputBuses = nullptr;
  spec.outputBuses = &bus;
  return zdsp::succeeded(
      handle.functions->prepare(handle.state, &spec, nullptr));
}

void renderBlock(const zdsp::ProcessorHandle& handle, Output* output,
                 int64_t projectSamples, uint32_t rate = kRate) {
  zdsp::TransportContext transport{};
  transport.validFields = zdsp::TransportValidProjectSamples;
  transport.stateFlags = zdsp::TransportStatePlaying;
  transport.projectTimeSamples = projectSamples;
  transport.projectRateQ32 = zdsp::kProjectRateOneQ32;
  zdsp::ProcessContext context{};
  context.interfaceVersion = zdsp::kProcessorInterfaceVersion;
  context.structSize = zdsp::kProcessContextV1RequiredSize;
  context.transport = &transport;
  context.sampleRate = {static_cast<double>(rate)};
  context.frames = {kBlock};
  handle.functions->process(handle.state, &context, nullptr, 0, &output->view,
                            1);
}

}  // namespace

int main(int argc, char** argv) {
  // How long does the waveform pass ACTUALLY take, with nothing competing?
  //
  //   SINGZ_WAVEFORM_BENCH=1 streaming_lane_feeder_tests lane.flac [lane.flac...]
  //
  // A phone measured six lanes in 20 s, of which 18 s went into the first one.
  // That is either throughput or scheduling, and the two want opposite fixes —
  // so this measures throughput alone, on the same hardware, before anybody
  // theorises about the other. Shipping a guess about it once was enough.
  // What does ONE seek cost, per lane, on real stems?
  //
  //   SINGZ_SEEK_BENCH=1 streaming_lane_feeder_tests lane.flac [lane.flac...]
  //
  // The session harness measured a native seek at ~195 ms against legacy's 10,
  // on a six-lane song. That is either one expensive seek six times over or
  // one lane being pathological, and the two want opposite fixes — an index,
  // or parallelism across lanes. Measuring one lane at a time settles it.
  if (std::getenv("SINGZ_SEEK_BENCH") != nullptr) {
    for (int i = 1; i < argc; i++) {
      auto source = singz::openStreamingAudioSource(openRead(argv[i]), {}, nullptr);
      if (source == nullptr) {
        std::fprintf(stderr, "could not open %s\n", argv[i]);
        return 1;
      }
      const singz::StreamingAudioInfo info = source->info();
      const char* cost = info.seekCost == singz::SeekCost::Indexed ? "Indexed" : "Search";
      // Somewhere past the middle every time, so no seek is answered from
      // whatever the open happened to leave buffered.
      double worst = 0, total = 0;
      const int rounds = 8;
      for (int r = 0; r < rounds; r++) {
        const uint64_t target =
            static_cast<uint64_t>(info.frameCount * (0.15 + 0.7 * (r / double(rounds))));
        const auto t0 = std::chrono::steady_clock::now();
        const singz::DecodedAudioStatus st = source->seek(target);
        const double ms =
            std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0)
                .count();
        if (st != singz::DecodedAudioStatus::Ok) {
          std::fprintf(stderr, "seek failed on %s\n", argv[i]);
          return 1;
        }
        total += ms;
        if (ms > worst) worst = ms;
      }
      const char* name = std::strrchr(argv[i], '/');
      std::printf("%-14s %-8s mean %6.1f ms · worst %6.1f ms over %d seeks\n",
                  name != nullptr ? name + 1 : argv[i], cost, total / rounds, worst, rounds);
    }
    return 0;
  }

  if (std::getenv("SINGZ_WAVEFORM_BENCH") != nullptr) {
    singz::StreamingLaneGroup group;
    for (int i = 1; i < argc; i++) {
      if (group.addLane(openRead(argv[i]), openRead(argv[i]), 0) !=
          singz::DecodedAudioStatus::Ok) {
        std::fprintf(stderr, "could not open %s\n", argv[i]);
        return 1;
      }
    }
    if (group.laneCount() == 0) {
      std::fprintf(stderr, "usage: SINGZ_WAVEFORM_BENCH=1 %s <lane.flac>...\n", argv[0]);
      return 2;
    }
    // WITH the feeder running, when asked: that is the difference between this
    // benchmark and the app, and the app is ten times slower. Measuring both
    // says whether the two are competing or whether the phone is slow for some
    // other reason.
    const bool withFeeder = std::getenv("SINGZ_WAVEFORM_BENCH_FEEDER") != nullptr;
    if (withFeeder) {
      if (group.prime(0) != singz::DecodedAudioStatus::Ok) {
        std::fprintf(stderr, "prime failed\n");
        return 1;
      }
      group.start();
    }
    double seconds = 0;
    for (size_t lane = 0; lane < group.laneCount(); lane++) {
      const singz::StreamingAudioInfo* info = group.info(lane);
      if (info != nullptr && info->sampleRate != 0)
        seconds = std::max(seconds,
                           static_cast<double>(info->frameCount) / info->sampleRate);
    }
    const auto started = std::chrono::steady_clock::now();
    group.startWaveformPass();
    std::vector<float> buckets(singz::kStreamingWaveformBuckets, 0.0F);
    size_t done = 0;
    while (done < group.laneCount()) {
      done = 0;
      for (size_t lane = 0; lane < group.laneCount(); lane++)
        if (group.waveform(lane, buckets.data(), buckets.size())) done++;
      if (done < group.laneCount())
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    const double ms = std::chrono::duration<double, std::milli>(
                          std::chrono::steady_clock::now() - started)
                          .count();
    // The same per-lane line the phone logs, so a host number and a device
    // number can be read side by side. read vs elapsed is the point of it:
    // equal means the file is the cost, far apart means the thread is not
    // being scheduled.
    for (size_t lane = 0; lane < group.laneCount(); lane++) {
      const singz::StreamingLaneStats stats = group.stats(lane);
      std::printf("  lane %zu . frames=%llu . read=%llums . elapsed=%llums . qos=%d . iopol=%d\n",
                  lane, static_cast<unsigned long long>(stats.waveformFrames),
                  static_cast<unsigned long long>(stats.waveformReadMs),
                  static_cast<unsigned long long>(stats.waveformElapsedMs),
                  stats.waveformQos, stats.waveformIoPolicy);
    }
    std::printf("waveform: %zu lanes · %.1f s each · feeder %s · measured in %.0f ms (%.0fx realtime)\n",
                group.laneCount(), seconds, withFeeder ? "RUNNING" : "idle", ms,
                ms > 0 ? seconds * group.laneCount() * 1000.0 / ms : 0.0);
    group.stop();
    return 0;
  }

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
    check(group.addLane(openRead(flac), openRead(flac), kRate) == singz::DecodedAudioStatus::Ok,
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

  // ---- 1b. a float WAV lane feeds exactly the same way --------------------
  //
  // The same linear pass, against a lane shaped like the separated lead: 32-bit
  // float with peaks past full scale. It must match the full decode to the bit
  // and never starve, and the peaks must arrive unclamped.
  {
    const std::string lead = writeFloatWav(kFrames, kRate);
    check(!lead.empty(), "the float WAV fixture writes");
    const singz::DecodedAudioResult leadReference = singz::prepareDecodedAudio(openRead(lead));
    check(leadReference.ok(), "and decodes as a reference");
    singz::StreamingLaneGroup group;
    singz::StreamingLaneOptions options;
    options.windowFrames = 65536;
    options.targetAheadFrames = 32768;
    options.safetyFrames = 8192;
    options.primeFrames = 16384;
    group.setOptions(options);
    check(group.addLane(openRead(lead), openRead(lead), kRate) == singz::DecodedAudioStatus::Ok,
          "a float WAV lane opens in the feeder");
    check(group.prime(0) == singz::DecodedAudioStatus::Ok, "and primes at the start");
    std::vector<uint8_t> storage(zdsp::streamingWindowSourceStateBytes() + 64);
    uint8_t* aligned = storage.data() +
                       ((64 - (reinterpret_cast<uintptr_t>(storage.data()) & 63u)) & 63u);
    const zdsp::ProcessorHandle streamed = zdsp::createPositionedStreamingSource(
        {{1}, group.window(0), 0, 0},
        {aligned, static_cast<uint32_t>(zdsp::streamingWindowSourceStateBytes())});
    check(streamed.state != nullptr && prepareSource(streamed, 2),
          "the source node is created and prepared over it");
    if (streamed.state != nullptr && leadReference.ok()) {
      Output out(2);
      bool matched = true;
      float peak = 0.0F;
      uint64_t compared = 0;
      const uint64_t blocks = (kFrames - kBlock) / kBlock;
      for (uint64_t block = 0; block < blocks; block++) {
        const int64_t at = static_cast<int64_t>(block * kBlock);
        for (int round = 0; round < 8; round++)
          if (!group.serviceOnceForTesting()) break;
        renderBlock(streamed, &out, at);
        for (uint32_t c = 0; c < 2; c++)
          for (uint32_t fr = 0; fr < kBlock; fr++) {
            const float got = out.planes[c][fr];
            if (got != leadReference.audio->channelData(c)[static_cast<uint64_t>(at) + fr])
              matched = false;
            peak = std::max(peak, std::fabs(got));
            compared++;
          }
      }
      check(compared > 700000, "the WAV pass actually compared the whole song");
      check(matched, "every frame of a float WAV lane matches the full decode");
      check(peak > 1.0F, "and its peaks past full scale arrive unclamped");
      check(group.stats(0).starvedBlocks == 0, "and no block starved");
      (void)streamed.functions->deactivate(streamed.state);
      (void)streamed.functions->destroy(streamed.state);
    }
    group.stop();
    std::remove(lead.c_str());
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
    check(group.addLane(openRead(flac), openRead(flac), kRate) == singz::DecodedAudioStatus::Ok,
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
    check(group.addLane(openRead(flac), openRead(flac), kRate) == singz::DecodedAudioStatus::Ok,
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

  // ---- 3b. a RESAMPLED lane matches the resampled decode ------------------
  //
  // The case every real song on a phone takes: 44.1 kHz stems into a 48 kHz
  // session. The reference is the same decode the app does today, asked for
  // the same output rate, so this compares two resamplings of one file rather
  // than a resampling against an original.
  {
    const std::string wav441 = tempPath(".wav");
    // 44.1 kHz fixture, written by hand: the helper above is fixed at kRate.
    {
      std::FILE* f = std::fopen(wav441.c_str(), "wb");
      const uint32_t frames = 120000;
      const uint32_t dataBytes = frames * 2 * 2;
      auto u32 = [&](uint32_t v) { std::fwrite(&v, 4, 1, f); };
      auto u16 = [&](uint16_t v) { std::fwrite(&v, 2, 1, f); };
      std::fwrite("RIFF", 1, 4, f); u32(36 + dataBytes);
      std::fwrite("WAVEfmt ", 1, 8, f);
      u32(16); u16(1); u16(2); u32(44100); u32(44100 * 4); u16(4); u16(16);
      std::fwrite("data", 1, 4, f); u32(dataBytes);
      for (uint32_t i = 0; i < frames; i++) {
        const auto left = static_cast<int16_t>(
            std::lround(9000.0 * std::sin(i * 0.011)));
        const auto right = static_cast<int16_t>(
            std::lround(7000.0 * std::sin(i * 0.017 + 0.5)));
        std::fwrite(&left, 2, 1, f);
        std::fwrite(&right, 2, 1, f);
      }
      std::fclose(f);
    }
    const std::string flac441 = tempPath(".flac");
    std::remove(flac441.c_str());
    check(singz::compactStem(wav441, flac441).ok, "a 44.1 kHz fixture compacts");

    singz::DecodedAudioPrepareOptions resampledOptions;
    resampledOptions.sourceFormat = singz::DecodedAudioSourceFormat::Flac;
    resampledOptions.requiredSampleRate = 48000;
    const singz::DecodedAudioResult resampled =
        singz::prepareDecodedAudio(openRead(flac441), resampledOptions);
    check(resampled.ok(), "and the decoded reference resamples it to 48 kHz");

    if (resampled.ok()) {
      singz::StreamingLaneGroup group;
      check(group.addLane(openRead(flac441), singz::OwnedFileDescriptor(), 48000) ==
                singz::DecodedAudioStatus::Ok,
            "a resampled lane opens");
      check(group.prime(0) == singz::DecodedAudioStatus::Ok,
            "and primes at the device rate");
      // Within a frame or two of the decode: both round the same way from the
      // same rates, which is what keeps six lanes together.
      const uint64_t got = group.outputFrames(0);
      const uint64_t want = resampled.audio->frameCount();
      check(got + 2 >= want && want + 2 >= got,
            "and its length agrees with the resampled decode");

      // The samples themselves, over the first stretch the ring holds.
      uint64_t start = 0;
      uint64_t end = 0;
      for (int round = 0; round < 200; round++) {
        group.serviceOnceForTesting();
        (void)zdsp::streamingWindowResident(group.window(0), &start, &end);
        if (end > 20000) break;
      }
      check(end > 20000, "and the ring fills with resampled frames");
      double worst = 0.0;
      const uint64_t compare = std::min<uint64_t>(end, 20000);
      for (uint64_t frame = 1000; frame < compare; frame++)
        for (uint32_t c = 0; c < 2; c++) {
          const float mine = group.window(0)->channels[c]
              [frame & (group.window(0)->capacityFrames - 1)];
          const float theirs = resampled.audio->channelData(c)[frame];
          worst = std::max(worst, std::fabs(static_cast<double>(mine - theirs)));
        }
      check(worst < 1e-4, "and they are the same audio the decode produces");
    }
    std::remove(wav441.c_str());
    std::remove(flac441.c_str());
  }

  // ---- 3c. a lane fed to its END still follows playback back --------------
  //
  // Play after the song ran out is a seek to the top and a resume on the SAME
  // graph (the desktop's Play with the count-in off), and a scrub back out of
  // the last few seconds is the same thing mid-song — so a feeder that has
  // taken a lane to its end must chase the demand when it jumps back. It did
  // not: `serviceLane` returned as soon as a lane had ENDED with its ring at
  // the song's end, before it looked at the demand at all, and every lane then
  // played silence while the metronome, which is no lane, went on clicking.
  // A singer's report, on a 48 kHz WASAPI output where every stem is
  // resampled — and a resampled lane is exactly the one that gets there: its
  // decoder reaches the end of the file BEFORE the ring is full, because the
  // filter's tail only comes out of the flush. The device-rate lane rides
  // along so the unresampled path is held to the same promise.
  for (const uint32_t deviceRate : {48000u, kRate}) {
    const bool resampling = deviceRate != kRate;
    singz::DecodedAudioPrepareOptions endOptions;
    endOptions.sourceFormat = singz::DecodedAudioSourceFormat::Flac;
    endOptions.requiredSampleRate = deviceRate;
    const singz::DecodedAudioResult song =
        singz::prepareDecodedAudio(openRead(flac), endOptions);
    check(song.ok(), "the end-of-song reference decodes at the device rate");
    if (!song.ok()) continue;

    singz::StreamingLaneGroup group;
    singz::StreamingLaneOptions options;
    options.windowFrames = 65536;
    options.targetAheadFrames = 32768;
    options.safetyFrames = 8192;
    options.primeFrames = 16384;
    group.setOptions(options);
    check(group.addLane(openRead(flac), singz::OwnedFileDescriptor(), deviceRate) ==
              singz::DecodedAudioStatus::Ok,
          "a lane opens for the end-of-song case");
    check(group.prime(0) == singz::DecodedAudioStatus::Ok, "and primes");
    std::vector<uint8_t> storage(zdsp::streamingWindowSourceStateBytes() + 64);
    uint8_t* aligned = storage.data() +
                       ((64 - (reinterpret_cast<uintptr_t>(storage.data()) & 63u)) & 63u);
    const zdsp::ProcessorHandle streamed = zdsp::createPositionedStreamingSource(
        {{1}, group.window(0), 0, 0},
        {aligned, static_cast<uint32_t>(zdsp::streamingWindowSourceStateBytes())});
    check(streamed.state != nullptr && prepareSource(streamed, 2, deviceRate),
          "the node prepares at the device rate");
    if (streamed.state == nullptr) continue;

    // Play out the song's last blocks, the feeder serviced between them the
    // way its thread would be.
    Output out(2);
    const uint64_t total = group.outputFrames(0);
    for (uint64_t at = total - 16 * kBlock; at + kBlock <= total; at += kBlock) {
      for (int round = 0; round < 64; round++)
        if (!group.serviceOnceForTesting()) break;
      renderBlock(streamed, &out, static_cast<int64_t>(at), deviceRate);
    }
    for (int round = 0; round < 64; round++)
      if (!group.serviceOnceForTesting()) break;
    uint64_t residentStart = 0;
    uint64_t residentEnd = 0;
    (void)zdsp::streamingWindowResident(group.window(0), &residentStart, &residentEnd);
    check(residentEnd == total, "the ring reached the end of the song");
    // Asserted so this case cannot quietly stop reaching the state it is for.
    if (resampling)
      check(group.stats(0).ended,
            "and the resampled lane's decoder ENDED on the way, as a real song's does");

    // Play again from the top. The first block may starve — that is the
    // design; after the feeder's turn it must be the song, every block.
    const uint64_t seeksBefore = group.stats(0).seeks;
    renderBlock(streamed, &out, 0, deviceRate);
    double worst = 0.0;
    float loudest = 0.0F;
    for (uint64_t block = 0; block < 16; block++) {
      for (int round = 0; round < 64; round++)
        if (!group.serviceOnceForTesting()) break;
      const uint64_t at = block * kBlock;
      renderBlock(streamed, &out, static_cast<int64_t>(at), deviceRate);
      for (uint32_t c = 0; c < 2; c++)
        for (uint32_t f = 0; f < kBlock; f++) {
          const float got = out.planes[c][f];
          loudest = std::max(loudest, std::fabs(got));
          // Past the filter's start-up for the resampled lane, as 3b compares;
          // to the bit for the device-rate one.
          if (at + f >= (resampling ? 1000u : 0u))
            worst = std::max(worst, std::fabs(static_cast<double>(got) -
                                              song.audio->channelData(c)[at + f]));
        }
    }
    check(group.stats(0).seeks > seeksBefore, "the jump back to the top cost the feeder a seek");
    check(loudest > 0.05F, "and the top of the song plays again instead of silence");
    check(resampling ? worst < 1e-4 : worst == 0.0, "and it is the song's own audio");
    (void)streamed.functions->deactivate(streamed.state);
    (void)streamed.functions->destroy(streamed.state);
  }

  // ---- 4. the background waveform pass ----------------------------------
  {
    singz::StreamingLaneGroup group;
    check(group.addLane(openRead(flac), openRead(flac), kRate) ==
              singz::DecodedAudioStatus::Ok,
          "a lane opens for the waveform case");
    group.startWaveformPass();
    std::vector<float> buckets(singz::kStreamingWaveformBuckets, -1.0F);
    bool ready = false;
    for (int attempt = 0; attempt < 400 && !ready; attempt++) {
      ready = group.waveform(0, buckets.data(), buckets.size());
      if (!ready)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    check(ready, "the waveform pass finishes");
    if (ready) {
      double loudest = 0.0;
      for (const float value : buckets)
        loudest = std::max(loudest, static_cast<double>(value));
      check(loudest > 0.05, "and it carries the fixture's actual level");
      // Against the decoded summary of the same file, bucket for bucket.
      const uint64_t frames = reference.audio->frameCount();
      const uint32_t channels = reference.audio->channelCount();
      double worst = 0.0;
      for (size_t bucket = 0; bucket < buckets.size(); bucket++) {
        const uint64_t begin = bucket * frames / buckets.size();
        uint64_t end = (bucket + 1) * frames / buckets.size();
        if (end <= begin) end = begin + 1;
        if (end > frames) end = frames;
        double sum = 0.0;
        uint64_t count = 0;
        for (uint32_t c = 0; c < channels; c++)
          for (uint64_t f = begin; f < end; f++) {
            const double v = reference.audio->channelData(c)[f];
            sum += v * v;
            count++;
          }
        const double expected = count == 0 ? 0.0 : std::sqrt(sum / count);
        worst = std::max(worst, std::fabs(expected - buckets[bucket]));
      }
      check(worst < 1e-5, "and matches the decoded summary bucket for bucket");
    }
    group.stop();
  }

  std::remove(flac.c_str());
  std::remove(wav.c_str());
  if (failures == 0)
    std::printf("streaming lane feeder: the graph plays a FLAC and a float WAV without decoding either\n");
  return failures == 0 ? 0 : 1;
}
