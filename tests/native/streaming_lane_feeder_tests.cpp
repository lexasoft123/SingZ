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

int main(int argc, char** argv) {
  // How long does the waveform pass ACTUALLY take, with nothing competing?
  //
  //   SINGZ_WAVEFORM_BENCH=1 streaming_lane_feeder_tests lane.flac [lane.flac...]
  //
  // A phone measured six lanes in 20 s, of which 18 s went into the first one.
  // That is either throughput or scheduling, and the two want opposite fixes —
  // so this measures throughput alone, on the same hardware, before anybody
  // theorises about the other. Shipping a guess about it once was enough.
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
    std::printf("streaming lane feeder: the graph plays a FLAC without decoding it\n");
  return failures == 0 ? 0 : 1;
}
