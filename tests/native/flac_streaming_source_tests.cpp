// The streaming FLAC source against the full decode it is meant to replace.
//
// The reference is `prepareDecodedAudio` — the thing that costs ~1.3 s of every
// phone open — so "the same audio" here means the same floats in the same
// order, not merely something plausible. A stem that is a few milliseconds out
// drifts against the other five and nothing downstream can see it, which is why
// every case below compares samples rather than durations.
#include <zcore/media/decoded_audio.h>
#include <zcore/media/flac_io.h>
#include <zcore/media/streaming_audio_source.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
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

int failures = 0;

void check(bool ok, const char* what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL  %s\n", what);
    failures++;
  }
}

std::string tempPath(const char* suffix) {
  static int counter = 0;
  std::string base =
#if defined(_WIN32)
      std::string(std::getenv("TEMP") != nullptr ? std::getenv("TEMP") : ".");
#else
      std::string("/tmp");
#endif
  return base + "/singz-flac-stream-" + std::to_string(counter++) + suffix;
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

// A stereo WAV whose two channels are DIFFERENT and non-repeating, so a source
// that swapped, duplicated or offset a channel cannot pass by luck.
std::string writeStereoWav(uint64_t frames, uint32_t rate) {
  const std::string path = tempPath(".wav");
  std::FILE* f = std::fopen(path.c_str(), "wb");
  const uint32_t dataBytes = static_cast<uint32_t>(frames * 2 * 2);
  const uint32_t riff = 36 + dataBytes;
  auto u32 = [&](uint32_t v) { std::fwrite(&v, 4, 1, f); };
  auto u16 = [&](uint16_t v) { std::fwrite(&v, 2, 1, f); };
  std::fwrite("RIFF", 1, 4, f); u32(riff); std::fwrite("WAVEfmt ", 1, 8, f);
  u32(16); u16(1); u16(2); u32(rate); u32(rate * 4); u16(4); u16(16);
  std::fwrite("data", 1, 4, f); u32(dataBytes);
  for (uint64_t i = 0; i < frames; i++) {
    const double t = static_cast<double>(i);
    const auto left = static_cast<int16_t>(std::lround(12000.0 * std::sin(t * 0.013)));
    const auto right = static_cast<int16_t>(std::lround(9000.0 * std::sin(t * 0.0031 + 1.0)));
    std::fwrite(&left, 2, 1, f);
    std::fwrite(&right, 2, 1, f);
  }
  std::fclose(f);
  return path;
}

struct Reference {
  std::vector<std::vector<float>> channels;
  uint64_t frames = 0;
  uint32_t rate = 0;
};

Reference fullDecode(const std::string& flacPath) {
  Reference ref;
  singz::DecodedAudioPrepareOptions options;
  options.sourceFormat = singz::DecodedAudioSourceFormat::Flac;
  const singz::DecodedAudioResult result = singz::prepareDecodedAudio(openRead(flacPath), options);
  if (!result.ok()) return ref;
  ref.frames = result.audio->frameCount();
  ref.rate = result.audio->sampleRate();
  for (uint32_t c = 0; c < result.audio->channelCount(); c++) {
    const float* data = result.audio->channelData(c);
    ref.channels.emplace_back(data, data + ref.frames);
  }
  return ref;
}

// Read `frames` from `source` in chunks of `chunk`, into planar vectors.
std::vector<std::vector<float>> readAll(singz::StreamingAudioSource& source, uint64_t frames,
                                        size_t chunk, uint16_t channels) {
  std::vector<std::vector<float>> out(channels, std::vector<float>(frames, 0.0F));
  std::vector<float*> planes(channels, nullptr);
  uint64_t done = 0;
  while (done < frames) {
    const size_t want = static_cast<size_t>(std::min<uint64_t>(chunk, frames - done));
    for (uint16_t c = 0; c < channels; c++) planes[c] = out[c].data() + done;
    size_t got = 0;
    if (source.read(planes.data(), want, &got) != singz::DecodedAudioStatus::Ok) break;
    if (got == 0) break;
    done += got;
  }
  for (auto& plane : out) plane.resize(static_cast<size_t>(done));
  return out;
}

bool same(const std::vector<float>& a, const std::vector<float>& b, size_t fromA, size_t fromB,
          size_t count) {
  if (a.size() < fromA + count || b.size() < fromB + count) return false;
  return std::memcmp(a.data() + fromA, b.data() + fromB, count * sizeof(float)) == 0;
}

}  // namespace

int main() {
  // ~7.3 s at 44.1 kHz: more than one FLAC block (4096) many times over, and
  // deliberately NOT a multiple of the block size, so the last frame is short.
  const uint64_t frames = 321'733;
  const uint32_t rate = 44100;
  const std::string wav = writeStereoWav(frames, rate);
  const std::string flac = tempPath(".flac");
  const singz::CompactResult encoded = singz::compactStem(wav, flac);
  check(encoded.ok, "the fixture encodes to FLAC");
  if (!encoded.ok) {
    std::fprintf(stderr, "  (%s)\n", encoded.error.c_str());
    return 1;
  }

  const Reference ref = fullDecode(flac);
  check(ref.frames == frames, "the full decode returns every frame");
  check(ref.channels.size() == 2, "the full decode returns two channels");
  if (ref.channels.size() != 2) return 1;

  // ---- 1. straight through, in awkward chunks --------------------------
  {
    singz::DecodedAudioStatus status = singz::DecodedAudioStatus::InvalidArgument;
    auto source = singz::openStreamingAudioSource(openRead(flac), {}, &status);
    check(source != nullptr && status == singz::DecodedAudioStatus::Ok, "a FLAC opens");
    if (source == nullptr) return 1;
    check(source->info().sampleRate == rate, "the rate comes from STREAMINFO");
    check(source->info().channels == 2, "the channel count comes from STREAMINFO");
    check(source->info().frameCount == frames, "the frame count comes from STREAMINFO");

    // 1000 is coprime with the 4096 block, so almost every read straddles a
    // frame boundary and the staging remainder is exercised on every call.
    const auto got = readAll(*source, frames, 1000, 2);
    check(got[0].size() == frames, "streaming reads every frame");
    check(same(got[0], ref.channels[0], 0, 0, static_cast<size_t>(frames)),
          "left channel is identical to the full decode");
    check(same(got[1], ref.channels[1], 0, 0, static_cast<size_t>(frames)),
          "right channel is identical to the full decode");
    check(source->position() == frames, "position ends at the frame count");
  }

  // ---- 2. seek is sample-exact, not block-exact ------------------------
  //
  // This is the case libFLAC does NOT do for you: `seek_absolute` lands on the
  // frame containing the target, so a source that forwards it blindly reads up
  // to 4095 frames of the wrong audio. Every target below is deliberately off
  // a block boundary.
  {
    const uint64_t targets[] = {1, 4095, 4096, 4097, 10'000, 123'457, frames - 1};
    for (const uint64_t target : targets) {
      singz::DecodedAudioStatus status = singz::DecodedAudioStatus::InvalidArgument;
      auto source = singz::openStreamingAudioSource(openRead(flac), {}, &status);
      if (source == nullptr) {
        check(false, "a FLAC opens for the seek case");
        continue;
      }
      check(source->seek(target) == singz::DecodedAudioStatus::Ok, "seek reports success");
      check(source->position() == target, "position reads back the requested frame");
      const size_t want = static_cast<size_t>(std::min<uint64_t>(2000, frames - target));
      const auto got = readAll(*source, want, 512, 2);
      const std::string what = "audio after seek(" + std::to_string(target) + ") is exact";
      check(got[0].size() == want && same(got[0], ref.channels[0], 0,
                                          static_cast<size_t>(target), want),
            what.c_str());
      check(got[1].size() == want && same(got[1], ref.channels[1], 0,
                                          static_cast<size_t>(target), want),
            what.c_str());
    }
  }

  // ---- 3. seeking backwards, and to the very end -----------------------
  {
    singz::DecodedAudioStatus status = singz::DecodedAudioStatus::InvalidArgument;
    auto source = singz::openStreamingAudioSource(openRead(flac), {}, &status);
    if (source == nullptr) return failures == 0 ? 0 : 1;
    (void)readAll(*source, 50'000, 4096, 2);
    check(source->seek(7) == singz::DecodedAudioStatus::Ok, "a backwards seek succeeds");
    const auto back = readAll(*source, 1000, 333, 2);
    check(same(back[0], ref.channels[0], 0, 7, 1000), "a backwards seek is exact too");

    check(source->seek(frames) == singz::DecodedAudioStatus::Ok, "seeking to the end succeeds");
    size_t got = 1;
    std::vector<float> l(16), r(16);
    float* planes[2] = {l.data(), r.data()};
    check(source->read(planes, 16, &got) == singz::DecodedAudioStatus::Ok &&
              got == 0,
          "reading at the end returns zero frames, not an error");
  }

  // ---- 4. what the interface promised about this file ------------------
  {
    singz::DecodedAudioStatus status = singz::DecodedAudioStatus::InvalidArgument;
    auto source = singz::openStreamingAudioSource(openRead(flac), {}, &status);
    if (source != nullptr) {
      // Our encoder writes no SEEKTABLE, so the source must SAY so rather than
      // claim an index it does not have — a scrubbing caller reads this to
      // decide whether to coalesce seeks.
      check(source->info().seekCost == singz::SeekCost::Search,
            "a stem with no SEEKTABLE reports Search, not Indexed");
      check(source->info().seekGranularityFrames == 4096,
            "the seek granularity is the FLAC block size");
      // Resampling is refused rather than silently skipped.
      singz::StreamingAudioOpenOptions resample;
      resample.requiredSampleRate = 48000;
      singz::DecodedAudioStatus rs = singz::DecodedAudioStatus::Ok;
      auto none = singz::openStreamingAudioSource(openRead(flac), resample, &rs);
      check(none == nullptr && rs == singz::DecodedAudioStatus::InvalidArgument,
            "a rate this source cannot deliver is refused, not ignored");
    }
  }

  std::remove(wav.c_str());
  std::remove(flac.c_str());
  if (failures == 0) std::printf("flac streaming source: every case matches the full decode\n");
  return failures == 0 ? 0 : 1;
}
