// Streaming against decode-everything, on the same six lanes.
//
// The claim under test (docs/FLAC-STREAMING-RESEARCH.md): the decode is cheap
// per second and expensive only because the whole song is decoded before the
// singer sees anything. So this measures the two things a singer actually
// waits for and pays:
//
//   TIME TO FIRST AUDIO — what the open costs before playback can start.
//   RESIDENT BYTES      — what the song holds while it plays.
//
// and then, because a fast open that stutters is worthless, the third thing:
//
//   REALTIME MARGIN     — how much faster than realtime the streaming refill
//                         runs once playing, which is the headroom a ring
//                         buffer has to absorb a scrub or a busy phone.
//
//   flac_streaming_benchmark <lane.flac> [lane.flac ...]
//
// Runs on any platform the core builds for, which is the point: the same
// binary answers on a Mac, an Android device and an iPhone.
#include <zcore/media/decoded_audio.h>
#include <zcore/media/streaming_audio_source.h>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace {

using Clock = std::chrono::steady_clock;
double msSince(Clock::time_point from) {
  return std::chrono::duration<double, std::milli>(Clock::now() - from).count();
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

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: %s <lane.flac> [lane.flac ...]\n", argv[0]);
    return 2;
  }
  std::vector<std::string> lanes(argv + 1, argv + argc);

  // ---- what happens today: decode every lane, whole ------------------------
  double decodeMs = 0;
  size_t decodedBytes = 0;
  double seconds = 0;
  {
    const auto started = Clock::now();
    std::vector<std::shared_ptr<const singz::DecodedAudio>> held;
    for (const std::string& lane : lanes) {
      singz::DecodedAudioPrepareOptions options;
      options.sourceFormat = singz::DecodedAudioSourceFormat::Flac;
      auto result = singz::prepareDecodedAudio(openRead(lane), options);
      if (!result.ok()) {
        std::fprintf(stderr, "decode failed for %s\n", lane.c_str());
        return 1;
      }
      decodedBytes += result.audio->retainedBytes();
      if (seconds == 0 && result.audio->sampleRate() > 0)
        seconds = static_cast<double>(result.audio->frameCount()) / result.audio->sampleRate();
      // HELD, deliberately: the graph keeps every lane alive for the life of
      // the song, so a benchmark that let them go would measure a peak the app
      // never enjoys.
      held.push_back(result.audio);
    }
    decodeMs = msSince(started);
  }

  // ---- what streaming costs to reach the same first block ------------------
  //
  // "Ready to play" for a streaming design is: every lane open, and one window
  // of audio in hand. A window is the stretcher's lookahead, not the callback
  // block — half a second is a generous stand-in until that node exists.
  const size_t windowFrames = 24000;
  double openMs = 0;
  size_t streamBytes = 0;
  std::vector<std::unique_ptr<singz::StreamingAudioSource>> sources;
  {
    const auto started = Clock::now();
    for (const std::string& lane : lanes) {
      singz::DecodedAudioStatus status = singz::DecodedAudioStatus::InvalidArgument;
      auto source = singz::openStreamingAudioSource(openRead(lane), {}, &status);
      if (source == nullptr) {
        std::fprintf(stderr, "stream open failed for %s (status %u)\n", lane.c_str(),
                     static_cast<unsigned>(status));
        return 1;
      }
      const uint16_t channels = source->info().channels;
      std::vector<std::vector<float>> window(channels, std::vector<float>(windowFrames, 0.0F));
      std::vector<float*> planes(channels);
      for (uint16_t c = 0; c < channels; c++) planes[c] = window[c].data();
      size_t got = 0;
      (void)source->read(planes.data(), windowFrames, &got);
      streamBytes += static_cast<size_t>(channels) * windowFrames * sizeof(float);
      sources.push_back(std::move(source));
    }
    openMs = msSince(started);
  }

  // ---- and once playing: how much faster than realtime does it refill? -----
  double refillMs = 0;
  double refilledSeconds = 0;
  {
    const size_t block = 4800;  // 100 ms at 48k, a plausible refill quantum
    const int blocks = 100;     // 10 s of audio per lane
    std::vector<std::vector<float>> scratch;
    const auto started = Clock::now();
    for (auto& source : sources) {
      const uint16_t channels = source->info().channels;
      scratch.assign(channels, std::vector<float>(block, 0.0F));
      std::vector<float*> planes(channels);
      for (uint16_t c = 0; c < channels; c++) planes[c] = scratch[c].data();
      for (int i = 0; i < blocks; i++) {
        size_t got = 0;
        if (source->read(planes.data(), block, &got) != singz::DecodedAudioStatus::Ok || got == 0)
          break;
      }
      refilledSeconds += static_cast<double>(block) * blocks / source->info().sampleRate;
    }
    refillMs = msSince(started);
  }

  const double mb = 1024.0 * 1024.0;
  std::printf("%zu lanes · %.1f s each\n", lanes.size(), seconds);
  std::printf("  decode everything (today)   %8.1f ms   %7.1f MB resident\n", decodeMs,
              decodedBytes / mb);
  std::printf("  stream: open + one window   %8.1f ms   %7.1f MB resident\n", openMs,
              streamBytes / mb);
  std::printf("  ---------------------------------------------------------\n");
  std::printf("  time to first audio         %8.1fx faster\n", decodeMs / (openMs > 0 ? openMs : 1));
  std::printf("  resident while playing      %8.1fx smaller\n",
              static_cast<double>(decodedBytes) / (streamBytes > 0 ? streamBytes : 1));
  std::printf("  refill headroom             %8.1fx realtime (all lanes together)\n",
              refilledSeconds * 1000.0 / (refillMs > 0 ? refillMs : 1));
  return 0;
}
