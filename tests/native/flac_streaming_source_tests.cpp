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

#include <FLAC/metadata.h>
#include <FLAC/stream_encoder.h>

#include <algorithm>

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

// Encode a FLAC directly with libFLAC, so the cases the app's own encoder
// cannot produce are still testable: a stream WITH a seektable (ours writes
// none), and one that declares no total length (ours always declares it).
//
// `seekPointEvery` builds the seektable the way the app would: a template of
// placeholder points attached BEFORE encoding, which libFLAC rewrites with
// real offsets at finish(). Hence real points rather than placeholders, and
// hence a fixture that exercises the Indexed path rather than merely looking
// like it does.
std::string encodeFlac(uint64_t frames, uint32_t rate, unsigned channels, bool declareTotal,
                       uint64_t seekPointEvery = 0) {
  const std::string path = tempPath(".flac");
  FLAC__StreamEncoder* e = FLAC__stream_encoder_new();
  FLAC__stream_encoder_set_channels(e, channels);
  FLAC__stream_encoder_set_bits_per_sample(e, 16);
  FLAC__stream_encoder_set_sample_rate(e, rate);
  FLAC__stream_encoder_set_compression_level(e, 5);
  if (declareTotal) FLAC__stream_encoder_set_total_samples_estimate(e, frames);
  FLAC__StreamMetadata* seektable = nullptr;
  if (seekPointEvery > 0) {
    seektable = FLAC__metadata_object_new(FLAC__METADATA_TYPE_SEEKTABLE);
    if (seektable == nullptr ||
        !FLAC__metadata_object_seektable_template_append_spaced_points_by_samples(
            seektable, static_cast<unsigned>(seekPointEvery), frames) ||
        !FLAC__metadata_object_seektable_template_sort(seektable, true)) {
      if (seektable != nullptr) FLAC__metadata_object_delete(seektable);
      FLAC__stream_encoder_delete(e);
      return {};
    }
    FLAC__stream_encoder_set_metadata(e, &seektable, 1);
  }
  if (FLAC__stream_encoder_init_file(e, path.c_str(), nullptr, nullptr) !=
      FLAC__STREAM_ENCODER_INIT_STATUS_OK) {
    if (seektable != nullptr) FLAC__metadata_object_delete(seektable);
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
    FLAC__stream_encoder_process_interleaved(e, block.data(), static_cast<unsigned>(n));
    at += n;
  }
  FLAC__stream_encoder_finish(e);
  FLAC__stream_encoder_delete(e);
  // Deleted only after finish(): the encoder holds the template until then,
  // and rewrites its points in place as it closes the file. Guarded because
  // FLAC__metadata_object_delete dereferences its argument — the only null
  // check is an assert, which is compiled out in a release build.
  if (seektable != nullptr) FLAC__metadata_object_delete(seektable);
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

  // ---- 2. seek is sample-exact -----------------------------------------
  //
  // libFLAC turns out to do this FOR you — after a seek it hands over a
  // shortened frame whose header reports the requested sample, so the run-in
  // this file once dropped by hand was always zero. These cases stay because
  // they are what would notice if that ever changed: every target is
  // deliberately off a block boundary, and each is compared against the full
  // decode rather than against itself.
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

  // ---- 5. damage: never shifted audio reported as Ok --------------------
  //
  // The defect this case exists for: libFLAC's `process_single` can call the
  // write callback SEVERAL times — it synthesises silence for missing frames
  // to keep the stream aligned — and a staging buffer that reset on every
  // write kept only the last, playing the rest of the song a block early with
  // `Ok` returned. Corrupting the middle of the file is what provokes it.
  {
    const std::string broken = tempPath(".flac");
    {
      std::FILE* in = std::fopen(flac.c_str(), "rb");
      std::FILE* out = std::fopen(broken.c_str(), "wb");
      std::fseek(in, 0, SEEK_END);
      const long size = std::ftell(in);
      std::fseek(in, 0, SEEK_SET);
      std::vector<unsigned char> bytes(static_cast<size_t>(size));
      (void)std::fread(bytes.data(), 1, bytes.size(), in);
      for (size_t i = bytes.size() / 2; i < bytes.size() / 2 + 64; i++) bytes[i] ^= 0xFFu;
      (void)std::fwrite(bytes.data(), 1, bytes.size(), out);
      std::fclose(in);
      std::fclose(out);
    }
    singz::DecodedAudioStatus status = singz::DecodedAudioStatus::InvalidArgument;
    auto source = singz::openStreamingAudioSource(openRead(broken), {}, &status);
    if (source != nullptr) {
      // Read the WHOLE file, continuing past the error rather than stopping at
      // it. Stopping is what a well-behaved caller does and it is exactly what
      // hides this bug: the shift only shows up in the audio AFTER the damage.
      std::vector<std::vector<float>> got(2, std::vector<float>(frames, 0.0F));
      float* planes[2] = {nullptr, nullptr};
      uint64_t at = 0;
      int emptyReads = 0;
      while (at < frames && emptyReads < 2) {
        const size_t want = static_cast<size_t>(std::min<uint64_t>(4096, frames - at));
        planes[0] = got[0].data() + at;
        planes[1] = got[1].data() + at;
        size_t n = 0;
        (void)source->read(planes, want, &n);  // status ignored ON PURPOSE
        emptyReads = n == 0 ? emptyReads + 1 : 0;
        at += n;
      }
      // The invariant is ALIGNMENT, not equality: libFLAC substitutes silence
      // for frames it could not read, and silence in the right place is a
      // correct answer. Audio in the WRONG place is not. So take a window well
      // past the damage and find which offset it matches the reference at —
      // zero is the only acceptable answer.
      int drift = 9999;
      if (at > frames / 2 + 40000) {
        const size_t probe = static_cast<size_t>(frames / 2 + 30000);
        const size_t width = 2048;
        for (int off = -8192; off <= 8192 && drift == 9999; off += 1) {
          const long long refAt = static_cast<long long>(probe) + off;
          if (refAt < 0 || refAt + static_cast<long long>(width) > static_cast<long long>(frames))
            continue;
          if (std::memcmp(got[0].data() + probe, ref.channels[0].data() + refAt,
                          width * sizeof(float)) == 0) {
            drift = off;
          }
        }
      }
      check(drift == 0, "audio after damage stays ALIGNED with the source, not shifted by a block");
      if (drift != 0 && drift != 9999)
        std::fprintf(stderr, "  (drifted by %d frames)\n", drift);
    }
    std::remove(broken.c_str());
  }

  // ---- 6. truncation: the end is reported once and stays reported --------
  {
    const std::string cut = tempPath(".flac");
    {
      std::FILE* in = std::fopen(flac.c_str(), "rb");
      std::FILE* out = std::fopen(cut.c_str(), "wb");
      std::fseek(in, 0, SEEK_END);
      const long size = std::ftell(in);
      std::fseek(in, 0, SEEK_SET);
      std::vector<unsigned char> bytes(static_cast<size_t>(size * 6 / 10));
      (void)std::fread(bytes.data(), 1, bytes.size(), in);
      (void)std::fwrite(bytes.data(), 1, bytes.size(), out);
      std::fclose(in);
      std::fclose(out);
    }
    singz::DecodedAudioStatus status = singz::DecodedAudioStatus::InvalidArgument;
    auto source = singz::openStreamingAudioSource(openRead(cut), {}, &status);
    if (source != nullptr) {
      (void)readAll(*source, frames, 8192, 2);
      // A seek into the missing tail must not leave a source that answers Ok
      // from an unknown offset — it is broken until a seek succeeds.
      const auto seeked = source->seek(frames - 100);
      if (seeked != singz::DecodedAudioStatus::Ok) {
        std::vector<float> l(64), r(64);
        float* planes[2] = {l.data(), r.data()};
        size_t n = 1;
        check(source->read(planes, 64, &n) != singz::DecodedAudioStatus::Ok,
              "a source whose seek failed refuses to read rather than inventing a position");
        check(source->seek(0) == singz::DecodedAudioStatus::Ok,
              "a successful seek un-breaks it");
      }
    }
    std::remove(cut.c_str());
  }

  // ---- 7. the small awkward asks ----------------------------------------
  {
    singz::DecodedAudioStatus status = singz::DecodedAudioStatus::InvalidArgument;
    auto source = singz::openStreamingAudioSource(openRead(flac), {}, &status);
    if (source != nullptr) {
      check(source->seek(frames + 5000) == singz::DecodedAudioStatus::Ok &&
                source->position() == frames,
            "seeking past the end clamps to the end rather than failing");
      std::vector<float> l(8), r(8);
      float* planes[2] = {l.data(), r.data()};
      size_t n = 7;
      check(source->read(planes, 0, &n) == singz::DecodedAudioStatus::Ok && n == 0,
            "a zero-frame read is Ok and reads nothing");
      check(source->seek(0) == singz::DecodedAudioStatus::Ok, "and it can seek back");
      size_t m = 0;
      check(source->read(planes, 8, &m) == singz::DecodedAudioStatus::Ok && m == 8,
            "and read again afterwards");
    }
  }

  // ---- 8. a stream WITH a seektable says Indexed, one without does not --
  //
  // Both halves matter: a source that reported Indexed unconditionally would
  // pass the first check on its own, and Indexed is the answer that tells a
  // scrub it need not coalesce, so getting it wrong is not cosmetic.
  {
    const std::string plain = encodeFlac(400000, rate, 2, true);
    const std::string indexed = encodeFlac(400000, rate, 2, true, 4096 * 10);
    check(!indexed.empty() && !plain.empty(), "a seektable fixture encodes");
    if (!plain.empty()) {
      auto bare = singz::openStreamingAudioSource(openRead(plain), {}, nullptr);
      check(bare != nullptr && bare->info().seekCost != singz::SeekCost::Indexed,
            "the same audio without a seektable is NOT reported as Indexed");
      std::remove(plain.c_str());
    }
    if (!indexed.empty()) {
      singz::DecodedAudioStatus status = singz::DecodedAudioStatus::InvalidArgument;
      auto source = singz::openStreamingAudioSource(openRead(indexed), {}, &status);
      check(source != nullptr, "a seektable stream opens");
      if (source != nullptr) {
        check(source->info().seekCost == singz::SeekCost::Indexed,
              "a SEEKTABLE is reported as Indexed, so a scrub need not coalesce");
        check(source->seek(123456) == singz::DecodedAudioStatus::Ok &&
                  source->position() == 123456,
              "and it still seeks exactly");
      }
      std::remove(indexed.c_str());
    }
  }

  // ---- 9. MONO, and a stream that declares no length --------------------
  //
  // Every other case here is 16-bit stereo, which is what this app writes;
  // these are the shapes a file from somewhere else can have. (24-bit is not
  // covered because our own encoder cannot make one — it is fixed at 16 — so
  // the fixture would have to come from outside the tree.)
  {
    const std::string mono = encodeFlac(50000, rate, 1, true);
    if (!mono.empty()) {
      singz::DecodedAudioStatus status = singz::DecodedAudioStatus::InvalidArgument;
      auto source = singz::openStreamingAudioSource(openRead(mono), {}, &status);
      check(source != nullptr && source->info().channels == 1, "a mono stream opens as mono");
      if (source != nullptr) {
        std::vector<float> only(1000, 0.0F);
        float* planes[1] = {only.data()};
        size_t n = 0;
        check(source->read(planes, 1000, &n) == singz::DecodedAudioStatus::Ok && n == 1000,
              "and reads its single channel");
      }
      std::remove(mono.c_str());
    }
    // An UNDECLARED length has to be made by hand: libFLAC's file encoder
    // rewrites STREAMINFO at finish() with the true total whenever the output
    // is seekable, so refusing to give it an estimate changes nothing. A
    // stream that genuinely does not know its length is the pipe/MP3 case, and
    // zeroing the field is the honest way to produce one here.
    std::string unknown = encodeFlac(50000, rate, 2, true);
    if (!unknown.empty()) {
      std::FILE* f = std::fopen(unknown.c_str(), "r+b");
      if (f != nullptr) {
        // STREAMINFO payload starts at 8; total_samples is 36 bits ending at
        // payload byte 17, i.e. the low nibble of byte 13 plus bytes 14-17.
        unsigned char b13 = 0;
        std::fseek(f, 8 + 13, SEEK_SET);
        (void)std::fread(&b13, 1, 1, f);
        b13 &= 0xF0;
        std::fseek(f, 8 + 13, SEEK_SET);
        std::fwrite(&b13, 1, 1, f);
        const unsigned char zeros[4] = {0, 0, 0, 0};
        std::fwrite(zeros, 1, 4, f);
        std::fclose(f);
      }
    }
    if (!unknown.empty()) {
      singz::DecodedAudioStatus status = singz::DecodedAudioStatus::InvalidArgument;
      auto source = singz::openStreamingAudioSource(openRead(unknown), {}, &status);
      check(source != nullptr, "a stream with no declared length still opens");
      if (source != nullptr) {
        check(source->info().frameCount == 0 && !source->info().frameCountFromContainer,
              "and says its length did not come from the container");
        const auto got = readAll(*source, 60000, 4096, 2);
        check(got[0].size() == 50000, "and reading discovers the real end");
      }
      std::remove(unknown.c_str());
    }
  }

  // ---- 10. not a FLAC, and the descriptor either way --------------------
  {
    // A FRESH wav: compactStem deletes the one it compacted, which is what it
    // is for (flac_io.h: "flac exists -> delete the wav if present"), so the
    // fixture from the top of this file is long gone by here.
    const std::string other = writeStereoWav(1000, rate);
    singz::DecodedAudioStatus status = singz::DecodedAudioStatus::Ok;
    auto none = singz::openStreamingAudioSource(openRead(other), {}, &status);
    check(none == nullptr && status == singz::DecodedAudioStatus::UnsupportedFormat,
          "a WAV is refused as UnsupportedFormat, not as damaged FLAC");

    // The descriptor must be closed on every refusal, or a song's worth of
    // lanes leaks one each time a format is guessed wrong.
    singz::OwnedFileDescriptor probe = openRead(other);
    const int raw = probe.get();
    (void)singz::openStreamingAudioSource(std::move(probe), {}, &status);
#if !defined(_WIN32)
    check(::fcntl(raw, F_GETFD) == -1, "a refused open closes the descriptor it was given");
#endif
    std::remove(other.c_str());
  }

  std::remove(flac.c_str());  // compactStem already removed the wav
  // ---- 11. two sources over ONE descriptor read independently -------------
  //
  // The waveform pass reads the same stem linearly while playback seeks around
  // it, on another thread. The obvious way to give it a handle is dup(), and
  // dup SHARES the file offset — so unless each source tracks its own position
  // and reads positionally, the two drag each other's cursor about and both
  // return nonsense.
  //
  // The alternative was reopening the file by path (F_GETPATH on Apple,
  // /proc/self/fd on Linux), which works on a Mac and is a question mark
  // inside a sandboxed app on a phone — a question this test removes rather
  // than answers.
  {
    const uint32_t rate2 = 44100;
    const std::string wav2 = writeStereoWav(120000, rate2);
    const std::string flac2 = tempPath(".flac");
    std::remove(flac2.c_str());
    check(singz::compactStem(wav2, flac2).ok, "a fixture for the shared descriptor");
    const Reference reference = fullDecode(flac2);
    check(reference.frames > 0, "and it decodes as a reference");

    singz::OwnedFileDescriptor first = openRead(flac2);
    // `_dup` on Windows, so the case actually RUNS there. Guarding the dup
    // but NOT the check that followed it left `duplicated` at -1 and failed
    // the suite on Windows by construction — a red that says nothing.
    //
    // The Windows readAt seeks before every read and never consults the
    // inherited position, so a shared file pointer cannot bite this serial
    // interleaving on either platform; what the test pins is that neither
    // source depends on where the other left the cursor. Two Windows sources
    // reading CONCURRENTLY would be a different question, needing overlapped
    // IO — see the note in flac_streaming_source.cpp — and nothing does that.
    int duplicated = -1;
#if defined(_WIN32)
    duplicated = _dup(first.get());
#else
    duplicated = ::dup(first.get());
#endif
    check(duplicated >= 0, "the descriptor duplicates");

    auto a = singz::openStreamingAudioSource(std::move(first), {}, nullptr);
    auto b = duplicated < 0
                 ? nullptr
                 : singz::openStreamingAudioSource(
                       singz::OwnedFileDescriptor(duplicated), {}, nullptr);
    check(a != nullptr && b != nullptr, "and both sources open over it");

    if (a != nullptr && b != nullptr) {
      // Interleaved on purpose: one source seeking and reading between the
      // other's reads is exactly what playback does to the waveform pass.
      const size_t block = 4096;
      std::vector<std::vector<float>> planesA(2, std::vector<float>(block, 0.0F));
      std::vector<std::vector<float>> planesB(2, std::vector<float>(block, 0.0F));
      float* pa[2] = {planesA[0].data(), planesA[1].data()};
      float* pb[2] = {planesB[0].data(), planesB[1].data()};
      bool matched = true;
      uint64_t at = 0;
      for (int round = 0; round < 8 && matched; round++) {
        size_t gotA = 0;
        size_t gotB = 0;
        // B jumps about; A walks forward. Neither may disturb the other.
        (void)b->seek(50000 + static_cast<uint64_t>(round) * 1000);
        (void)b->read(pb, block, &gotB);
        (void)a->read(pa, block, &gotA);
        for (size_t frame = 0; frame < gotA; frame++)
          for (uint32_t c = 0; c < 2; c++)
            if (planesA[c][frame] != reference.channels[c][at + frame])
              matched = false;
        for (size_t frame = 0; frame < gotB; frame++)
          for (uint32_t c = 0; c < 2; c++)
            if (planesB[c][frame] !=
                reference.channels[c][50000 + static_cast<uint64_t>(round) * 1000 + frame])
              matched = false;
        at += gotA;
      }
      check(matched,
            "and neither disturbs the other's position, so one descriptor "
            "serves playback and the waveform pass");
    }
    std::remove(wav2.c_str());
    std::remove(flac2.c_str());
  }

  if (failures == 0) std::printf("flac streaming source: every case matches the full decode\n");
  return failures == 0 ? 0 : 1;
}
