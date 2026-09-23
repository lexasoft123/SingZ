// The native MP3 decoder (zcore/src/media/mp3_streaming_source.cpp) against FFmpeg,
// and its streaming source against its own whole-file decode.
//
// Two bars, and they are different on purpose:
//
//   - Against FFmpeg the LENGTH is exact and the samples are within a small
//     tolerance. Two MP3 decoders are two float implementations of the same
//     synthesis and do not agree to the bit; they must agree on every sample's
//     place, or a lane drifts. The references are FFmpeg's decode of each
//     fixture, committed as 24-bit FLAC (tests/fixtures/mp3/generate.sh), so
//     the suite runs where no FFmpeg is installed — MSVC and the sanitizer
//     gate included.
//   - Against the whole-file decode, the streaming source is compared BIT FOR
//     BIT: from the top at awkward read sizes, and after every seek. A seek has
//     to rebuild the decoder state (the bit reservoir, the IMDCT overlap, the
//     filterbank) by decoding a run-up; if it ever rebuilt too little, the
//     first frames after the seek would differ in the last bits, and this is
//     where that shows.
//
// SINGZ_MP3_EXTRA_FILES (paths separated by ':' — ';' on Windows) runs the
// same checks against real files, with FFmpeg called at run time for the
// reference. That is how the field file this work started from (593 s, 320
// kbps CBR, no Xing header, 1008 bytes of 0xFF on the end) was checked; it is
// never committed.
#include <zcore/media/decoded_audio.h>
#include <zcore/media/streaming_audio_source.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <random>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#include <share.h>
#include <sys/stat.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

#ifndef SINGZ_MP3_FIXTURE_DIR
#error "SINGZ_MP3_FIXTURE_DIR must name tests/fixtures/mp3/data"
#endif

namespace {

int failures = 0;

void check(bool ok, const std::string& what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL  %s\n", what.c_str());
    failures++;
  }
}

std::string fixture(const char* name) { return std::string(SINGZ_MP3_FIXTURE_DIR) + "/" + name; }

std::string tempPath(const char* suffix) {
  static int counter = 0;
  std::string base =
#if defined(_WIN32)
      std::string(std::getenv("TEMP") != nullptr ? std::getenv("TEMP") : ".");
#else
      std::string("/tmp");
#endif
  return base + "/singz-mp3-" + std::to_string(counter++) + suffix;
}

int openRawRead(const std::string& path) {
#if defined(_WIN32)
  int fd = -1;
  _sopen_s(&fd, path.c_str(), _O_RDONLY | _O_BINARY, _SH_DENYNO, 0);
  return fd;
#else
  return ::open(path.c_str(), O_RDONLY);
#endif
}

singz::OwnedFileDescriptor openRead(const std::string& path) {
  return singz::OwnedFileDescriptor(openRawRead(path));
}

std::vector<unsigned char> readFile(const std::string& path) {
  std::vector<unsigned char> bytes;
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (f == nullptr) return bytes;
  unsigned char block[65536];
  size_t n = 0;
  while ((n = std::fread(block, 1, sizeof(block), f)) > 0) bytes.insert(bytes.end(), block, block + n);
  std::fclose(f);
  return bytes;
}

void writeFile(const std::string& path, const std::vector<unsigned char>& bytes) {
  std::FILE* f = std::fopen(path.c_str(), "wb");
  if (f == nullptr) return;
  std::fwrite(bytes.data(), 1, bytes.size(), f);
  std::fclose(f);
}

std::shared_ptr<const singz::DecodedAudio> decodeWhole(
    const std::string& path,
    singz::DecodedAudioSourceFormat format = singz::DecodedAudioSourceFormat::Auto,
    singz::DecodedAudioStatus* status = nullptr) {
  singz::DecodedAudioPrepareOptions options{};
  options.sourceFormat = format;
  const auto result = singz::prepareDecodedAudio(openRead(path), options);
  if (status != nullptr) *status = result.status;
  return result.ok() ? result.audio : nullptr;
}

// Planar audio held in memory, from whichever decoder.
struct Pcm {
  uint32_t rate = 0;
  std::vector<std::vector<float>> channels;
  [[nodiscard]] uint64_t frames() const { return channels.empty() ? 0 : channels[0].size(); }
};

Pcm fromDecoded(const singz::DecodedAudio& audio) {
  Pcm pcm;
  pcm.rate = audio.sampleRate();
  for (uint32_t c = 0; c < audio.channelCount(); ++c)
    pcm.channels.emplace_back(audio.channelData(c), audio.channelData(c) + audio.frameCount());
  return pcm;
}

// FFmpeg at run time, for SINGZ_MP3_EXTRA_FILES only.
bool ffmpegDecode(const std::string& path, uint32_t channels, Pcm* out) {
#if defined(_WIN32)
  (void)path; (void)channels; (void)out;
  return false;
#else
  const std::string command = "ffmpeg -v quiet -i '" + path + "' -f f32le -";
  std::FILE* pipe = ::popen(command.c_str(), "r");
  if (pipe == nullptr) return false;
  out->channels.assign(channels, {});
  std::vector<float> block(4096 * channels);
  size_t n = 0;
  size_t carry = 0;
  while ((n = std::fread(block.data() + carry, sizeof(float), block.size() - carry, pipe)) > 0) {
    const size_t total = carry + n;
    const size_t whole = total / channels;
    for (size_t i = 0; i < whole; ++i)
      for (uint32_t c = 0; c < channels; ++c) out->channels[c].push_back(block[i * channels + c]);
    carry = total - whole * channels;
    std::memmove(block.data(), block.data() + whole * channels, carry * sizeof(float));
  }
  return ::pclose(pipe) == 0;
#endif
}

struct Agreement {
  bool sameShape = false;
  double maxError = 0.0;
  double snrDb = 0.0;
};

Agreement compare(const Pcm& got, const Pcm& want) {
  Agreement a;
  a.sameShape = got.rate == want.rate && got.channels.size() == want.channels.size() &&
                got.frames() == want.frames();
  if (!a.sameShape) return a;
  double signal = 0.0;
  double noise = 0.0;
  for (size_t c = 0; c < got.channels.size(); ++c)
    for (size_t i = 0; i < got.frames(); ++i) {
      const double w = want.channels[c][i];
      const double e = static_cast<double>(got.channels[c][i]) - w;
      a.maxError = std::max(a.maxError, std::fabs(e));
      signal += w * w;
      noise += e * e;
    }
  a.snrDb = noise == 0.0 ? 999.0 : 10.0 * std::log10(signal / noise);
  return a;
}

bool bitEqual(const Pcm& a, const Pcm& b) {
  if (a.channels.size() != b.channels.size() || a.frames() != b.frames()) return false;
  for (size_t c = 0; c < a.channels.size(); ++c)
    if (std::memcmp(a.channels[c].data(), b.channels[c].data(), a.frames() * sizeof(float)) != 0)
      return false;
  return true;
}

std::unique_ptr<singz::StreamingAudioSource> openStream(
    const std::string& path, singz::DecodedAudioStatus* status,
    singz::DecodedAudioSourceFormat format = singz::DecodedAudioSourceFormat::Auto) {
  singz::StreamingAudioOpenOptions options{};
  options.sourceFormat = format;
  return singz::openStreamingAudioSource(openRead(path), options, status);
}

// Reads `limit` frames (or to the end) in blocks of `block`.
Pcm readStream(singz::StreamingAudioSource& source, size_t block, uint64_t limit,
               singz::DecodedAudioStatus* last = nullptr) {
  const auto& info = source.info();
  Pcm pcm;
  pcm.rate = info.sampleRate;
  pcm.channels.assign(info.channels, {});
  std::vector<std::vector<float>> staging(info.channels, std::vector<float>(block));
  std::vector<float*> pointers(info.channels);
  for (uint16_t c = 0; c < info.channels; ++c) pointers[c] = staging[c].data();
  uint64_t total = 0;
  while (total < limit) {
    const size_t want = static_cast<size_t>(std::min<uint64_t>(block, limit - total));
    size_t got = 0;
    const auto status = source.read(pointers.data(), want, &got);
    if (last != nullptr) *last = status;
    if (status != singz::DecodedAudioStatus::Ok) break;
    for (uint16_t c = 0; c < info.channels; ++c)
      pcm.channels[c].insert(pcm.channels[c].end(), staging[c].begin(), staging[c].begin() + got);
    total += got;
    if (got == 0) break;
  }
  return pcm;
}

Pcm slice(const Pcm& pcm, uint64_t from, uint64_t count) {
  Pcm out;
  out.rate = pcm.rate;
  const uint64_t end = std::min<uint64_t>(pcm.frames(), from + count);
  for (const auto& channel : pcm.channels)
    out.channels.emplace_back(channel.begin() + static_cast<std::ptrdiff_t>(std::min(from, end)),
                              channel.begin() + static_cast<std::ptrdiff_t>(end));
  return out;
}

// Streaming against the whole-file decode: every read size, every seek.
void streamingAgrees(const std::string& name, const std::string& path, const Pcm& whole,
                     int seeks) {
  singz::DecodedAudioStatus status = singz::DecodedAudioStatus::InvalidArgument;
  auto source = openStream(path, &status);
  check(source != nullptr && status == singz::DecodedAudioStatus::Ok, name + ": streams (Auto)");
  if (source == nullptr) return;
  const auto& info = source->info();
  check(info.sampleRate == whole.rate && info.channels == whole.channels.size() &&
            info.frameCount == whole.frames(),
        name + ": the stream reports the decode's rate, channels and exact length (" +
            std::to_string(info.frameCount) + " vs " + std::to_string(whole.frames()) + ")");
  check(info.seekCost == singz::SeekCost::RunUp &&
            (info.seekGranularityFrames == 1152 || info.seekGranularityFrames == 576),
        name + ": says a seek costs a run-up, at frame granularity");

  for (size_t block : {size_t{1}, size_t{577}, size_t{1152}, size_t{4096}, size_t{100000}}) {
    if (block == 1 && whole.frames() > 200000) continue;
    check(source->seek(0) == singz::DecodedAudioStatus::Ok, name + ": seeks to 0");
    const Pcm read = readStream(*source, block, UINT64_MAX);
    check(bitEqual(read, whole),
          name + ": streamed to the end in blocks of " + std::to_string(block) +
              " is the whole-file decode bit for bit (" + std::to_string(read.frames()) + " frames)");
    size_t got = 7;
    float dummy[2][4];
    float* ptrs[2] = {dummy[0], dummy[1]};
    check(source->read(ptrs, 4, &got) == singz::DecodedAudioStatus::Ok && got == 0 &&
              source->position() == whole.frames(),
          name + ": and a read at the end returns nothing");
  }

  // Seeks: the edges every frame and the ends offer, then random ones.
  const uint64_t n = whole.frames();
  const uint64_t spf = info.seekGranularityFrames;
  std::vector<uint64_t> targets = {0, 1, spf - 1, spf, spf + 1, 2 * spf, 3 * spf - 1, 5 * spf + 17,
                                   n / 2, n - 1, n - spf, n};
  std::mt19937_64 rng(0x5eed + n);
  for (int i = 0; i < seeks; ++i) targets.push_back(rng() % (n + 1));
  for (uint64_t target : targets) {
    if (target > n) continue;
    check(source->seek(target) == singz::DecodedAudioStatus::Ok, name + ": seek");
    const uint64_t count = std::min<uint64_t>(3000, n - target);
    const Pcm read = readStream(*source, 1000, count);
    check(bitEqual(read, slice(whole, target, count)) && source->position() == target + count,
          name + ": after a seek to " + std::to_string(target) + " the next " +
              std::to_string(count) + " frames are the decode's, bit for bit");
  }
  check(source->seek(n + 12345) == singz::DecodedAudioStatus::Ok && source->position() == n,
        name + ": a seek beyond the end positions at the end");
  // Seek, seek again, then read — the first seek's run-up must not leak.
  (void)source->seek(n / 3);
  (void)source->seek(spf + 3);
  const Pcm after = readStream(*source, 512, 2000);
  check(bitEqual(after, slice(whole, spf + 3, 2000)), name + ": the last of two seeks wins");
}

struct Case {
  const char* file;
  const char* reference;
  uint32_t rate;
  uint16_t channels;
  uint64_t frames;  // what FFmpeg decodes, i.e. after the gapless trim
};

}  // namespace

int main() {
  // ---- 0. the capability every bridge reads ---------------------------------
  {
    const auto caps = singz::decodedAudioCodecCapabilities();
    check((caps.formatMask & singz::DecodedAudioCapabilityMp3) != 0,
          "the codec capability advertises MP3 on every build");
    check(singz::decodedAudioFormatSupported(singz::DecodedAudioSourceFormat::Mp3),
          "decodedAudioFormatSupported(Mp3)");
  }

  // Lengths are what FFmpeg 8 decodes each fixture to. Every file with a
  // LAME/Lavc tag trims to the 0.7 s the generator synthesized, exactly; the
  // two with no header keep every decoded frame, as FFmpeg does.
  const Case cases[] = {
      {"cbr320-noxing-44k.mp3", "cbr320-noxing-44k.ref.flac", 44100, 2, 32256},  // 28 x 1152
      {"ff-padded-44k.mp3", "cbr320-noxing-44k.ref.flac", 44100, 2, 32256},
      {"vbr-xing-44k.mp3", "vbr-xing-44k.ref.flac", 44100, 2, 30870},
      {"tagged-44k.mp3", "vbr-xing-44k.ref.flac", 44100, 2, 30870},
      {"vbr-noxing-48k.mp3", "vbr-noxing-48k.ref.flac", 48000, 2, 35712},  // 31 x 1152
      {"mono-cbr-48k.mp3", "mono-cbr-48k.ref.flac", 48000, 1, 33600},
      {"mpeg2-vbr-22k.mp3", "mpeg2-vbr-22k.ref.flac", 22050, 2, 15435},
      {"lavc-44k.mp3", "lavc-44k.ref.flac", 44100, 2, 30870},
  };

  for (const Case& c : cases) {
    const std::string name = c.file;
    const std::string path = fixture(c.file);
    // ---- 1. whole-file decode vs FFmpeg ------------------------------------
    singz::DecodedAudioStatus status = singz::DecodedAudioStatus::InvalidArgument;
    const auto declared = decodeWhole(path, singz::DecodedAudioSourceFormat::Mp3, &status);
    check(declared != nullptr, name + ": decodes as declared MP3 (status " +
                                   std::to_string(static_cast<int>(status)) + ")");
    const auto sniffed = decodeWhole(path);
    check(sniffed != nullptr, name + ": decodes under Auto");
    const auto reference = decodeWhole(fixture(c.reference));
    check(reference != nullptr, name + ": its FFmpeg reference reads");
    if (declared == nullptr || reference == nullptr) continue;
    const Pcm whole = fromDecoded(*declared);
    check(sniffed != nullptr && bitEqual(fromDecoded(*sniffed), whole),
          name + ": Auto and declared decode identically");
    check(whole.rate == c.rate && whole.channels.size() == c.channels && whole.frames() == c.frames,
          name + ": " + std::to_string(whole.rate) + " Hz, " +
              std::to_string(whole.channels.size()) + " ch, " + std::to_string(whole.frames()) +
              " frames — expected " + std::to_string(c.frames));
    const Agreement a = compare(whole, fromDecoded(*reference));
    check(a.sameShape, name + ": exactly FFmpeg's length (" + std::to_string(whole.frames()) +
                           " vs " + std::to_string(reference->frameCount()) + ")");
    // Two float MP3 synthesis implementations: measured ~1e-6 apart on this
    // corpus. 1e-4 (-80 dBFS) is a tolerance for rounding, not for an offset —
    // one sample of misalignment on these signals is an error of ~0.1.
    check(a.sameShape && a.maxError < 1e-4 && a.snrDb > 80.0,
          name + ": within tolerance of FFmpeg (max error " + std::to_string(a.maxError) +
              ", SNR " + std::to_string(a.snrDb) + " dB)");
    std::printf("%-24s %6llu frames  max|e| %.2e  SNR %.1f dB\n", c.file,
                static_cast<unsigned long long>(whole.frames()), a.maxError, a.snrDb);

    // ---- 2. streaming vs the whole-file decode -----------------------------
    streamingAgrees(name, path, whole, 400);
  }

  // ---- 3. junk between frames ------------------------------------------------
  // The inserted bytes are neither audio nor main data, so the file decodes
  // to exactly the clean file's samples. (FFmpeg drops the intact frame after
  // the junk; see generate.sh.)
  {
    const auto clean = decodeWhole(fixture("cbr320-noxing-44k.mp3"));
    const auto junk = decodeWhole(fixture("junk-44k.mp3"), singz::DecodedAudioSourceFormat::Mp3);
    check(clean != nullptr && junk != nullptr &&
              bitEqual(fromDecoded(*junk), fromDecoded(*clean)),
          "junk between frames: resynchronised, and the decode is the clean file's bit for bit");
    if (junk != nullptr) streamingAgrees("junk-44k.mp3", fixture("junk-44k.mp3"), fromDecoded(*junk), 20);
  }

  // ---- 4. a torn last frame, and a file that shrinks under a stream --------
  {
    const auto bytes = readFile(fixture("cbr320-noxing-44k.mp3"));
    std::vector<unsigned char> torn(bytes.begin(), bytes.end() - 500);
    const std::string path = tempPath(".mp3");
    writeFile(path, torn);
    const auto full = decodeWhole(fixture("cbr320-noxing-44k.mp3"));
    const auto cut = decodeWhole(path);
    check(cut != nullptr && full != nullptr && cut->frameCount() == full->frameCount() - 1152 &&
              bitEqual(fromDecoded(*cut), slice(fromDecoded(*full), 0, full->frameCount() - 1152)),
          "a torn last frame is left out, and everything before it is untouched");

    // Open a stream on the whole file, then cut the file down under it.
    writeFile(path, bytes);
    singz::DecodedAudioStatus st = singz::DecodedAudioStatus::InvalidArgument;
    auto source = openStream(path, &st);
    std::vector<unsigned char> half(bytes.begin(), bytes.begin() + static_cast<std::ptrdiff_t>(bytes.size() / 2));
    writeFile(path, half);
    if (source != nullptr && full != nullptr) {
      singz::DecodedAudioStatus last = singz::DecodedAudioStatus::Ok;
      const Pcm got = readStream(*source, 4096, UINT64_MAX, &last);
      check(last == singz::DecodedAudioStatus::IoError && got.frames() > 0 &&
                got.frames() < full->frameCount() &&
                bitEqual(got, slice(fromDecoded(*full), 0, got.frames())) &&
                source->position() == got.frames(),
            "a file that shrank: what could be read is exact, then IoError, and position agrees");
    }
    std::remove(path.c_str());
  }

  // ---- 5. what is not MP3 is not read as MP3 ---------------------------------
  {
    std::vector<unsigned char> noise(50000);
    std::mt19937 rng(7);
    for (auto& b : noise) b = static_cast<unsigned char>(rng());
    const std::string path = tempPath(".bin");
    writeFile(path, noise);
    singz::DecodedAudioStatus st = singz::DecodedAudioStatus::Ok;
    auto sniffed = openStream(path, &st);
    check(sniffed == nullptr && st == singz::DecodedAudioStatus::UnsupportedFormat,
          "random bytes are not sniffed as MP3");
    auto declared = openStream(path, &st, singz::DecodedAudioSourceFormat::Mp3);
    check(declared == nullptr && st == singz::DecodedAudioStatus::UnsupportedFormat,
          "and a declared MP3 with no Layer III stream is refused as unsupported");
    std::remove(path.c_str());

    auto asWav = openStream(fixture("vbr-xing-44k.mp3"), &st, singz::DecodedAudioSourceFormat::Wav);
    check(asWav == nullptr, "an MP3 declared as WAV is refused");
    auto asFlac = openStream(fixture("vbr-xing-44k.mp3"), &st, singz::DecodedAudioSourceFormat::Flac);
    check(asFlac == nullptr, "an MP3 declared as FLAC is refused");
    auto flacAsMp3 = openStream(fixture("vbr-xing-44k.ref.flac"), &st,
                                singz::DecodedAudioSourceFormat::Mp3);
    check(flacAsMp3 == nullptr, "a FLAC declared as MP3 is refused");
    auto flacAuto = openStream(fixture("vbr-xing-44k.ref.flac"), &st);
    check(flacAuto != nullptr && flacAuto->info().seekCost != singz::SeekCost::RunUp,
          "and a FLAC under Auto still opens as FLAC");

    auto options = singz::StreamingAudioOpenOptions{};
    options.requiredSampleRate = 48000;
    auto resampled = singz::openStreamingAudioSource(openRead(fixture("vbr-xing-44k.mp3")), options, &st);
    check(resampled == nullptr && st == singz::DecodedAudioStatus::InvalidArgument,
          "asking the MP3 source for another rate is a refusal, never wrong-rate audio");
  }

  // ---- 6. two sources on one file do not drag each other about -------------
  {
    const std::string path = fixture("vbr-xing-44k.mp3");
    const auto whole = decodeWhole(path);
    const int raw = openRawRead(path);
#if defined(_WIN32)
    const int copy = _dup(raw);
#else
    const int copy = ::dup(raw);
#endif
    singz::DecodedAudioStatus sa = singz::DecodedAudioStatus::InvalidArgument;
    singz::DecodedAudioStatus sb = singz::DecodedAudioStatus::InvalidArgument;
    auto a = singz::openStreamingAudioSource(singz::OwnedFileDescriptor(raw), {}, &sa);
    auto b = singz::openStreamingAudioSource(singz::OwnedFileDescriptor(copy), {}, &sb);
    check(a != nullptr && b != nullptr, "two sources open over one file description");
    if (a != nullptr && b != nullptr && whole != nullptr) {
      (void)b->seek(whole->frameCount() / 2);
      Pcm ra;
      Pcm rb;
      ra.rate = rb.rate = whole->sampleRate();
      ra.channels.assign(2, {});
      rb.channels.assign(2, {});
      for (int i = 0; i < 12; ++i) {
        const Pcm pa = readStream(*a, 700, 700);
        const Pcm pb = readStream(*b, 900, 900);
        for (int c = 0; c < 2; ++c) {
          ra.channels[c].insert(ra.channels[c].end(), pa.channels[c].begin(), pa.channels[c].end());
          rb.channels[c].insert(rb.channels[c].end(), pb.channels[c].begin(), pb.channels[c].end());
        }
      }
      const Pcm all = fromDecoded(*whole);
      check(bitEqual(ra, slice(all, 0, ra.frames())) &&
                bitEqual(rb, slice(all, whole->frameCount() / 2, rb.frames())),
            "interleaved reads on a shared descriptor each read their own place");
    }
  }

  // ---- 7. cancellation -------------------------------------------------------
  {
    std::atomic<bool> stop{true};
    singz::DecodeCancellation cancel{
        &stop, [](void* flag) noexcept { return static_cast<std::atomic<bool>*>(flag)->load(); }};
    singz::DecodedAudioPrepareOptions options{};
    const auto cancelled = singz::prepareDecodedAudio(openRead(fixture("vbr-xing-44k.mp3")), options, cancel);
    check(cancelled.status == singz::DecodedAudioStatus::Cancelled && cancelled.audio == nullptr,
          "a cancelled whole-file decode publishes nothing");

    const auto whole = decodeWhole(fixture("vbr-xing-44k.mp3"));
    singz::DecodedAudioStatus st = singz::DecodedAudioStatus::Ok;
    auto source = openStream(fixture("vbr-xing-44k.mp3"), &st);
    if (source != nullptr && whole != nullptr) {
      (void)source->seek(5000);
      source->setCancellation(cancel);
      std::vector<std::vector<float>> block(2, std::vector<float>(1000));
      float* ptrs[2] = {block[0].data(), block[1].data()};
      size_t got = 99;
      check(source->read(ptrs, 1000, &got) == singz::DecodedAudioStatus::Ok && got == 0 &&
                source->position() == 5000,
            "a cancelled read (mid run-up) hands over nothing and does not move");
      stop.store(false);
      const Pcm rest = readStream(*source, 4096, UINT64_MAX);
      check(bitEqual(rest, slice(fromDecoded(*whole), 5000, whole->frameCount() - 5000)),
            "and once released it runs the run-up again and reads exactly");
    }
  }

  // ---- 8. the codec target proof's MP3, without FFmpeg ----------------------
  // tests/fixtures/codecs is the corpus the FFmpeg builds' target proof
  // decodes (codec_provisioning_tests, fixture mode). MP3 goes to this
  // decoder on those builds too now, so what that proof expects of MP3 is
  // held here, where it runs on every build: the length FFmpeg decodes, and
  // every prepare bound — including the working bound, which counts the
  // decoded frame alive beside the published planes.
  {
    const std::string tone = std::string(SINGZ_CODEC_FIXTURE_DIR) + "/tone.mp3";
    const auto decoded = decodeWhole(tone, singz::DecodedAudioSourceFormat::Mp3);
    check(decoded != nullptr && decoded->frameCount() == 3840 && decoded->channelCount() == 1 &&
              decoded->sampleRate() == 48000,
          "the target proof's tone.mp3 decodes to FFmpeg's 3840 mono frames at 48 kHz");
    const auto bounded = [&](void (*shape)(singz::DecodedAudioPrepareOptions&)) {
      singz::DecodedAudioPrepareOptions options{};
      options.sourceFormat = singz::DecodedAudioSourceFormat::Mp3;
      shape(options);
      return singz::prepareDecodedAudio(openRead(tone), options);
    };
    for (auto shape : {+[](singz::DecodedAudioPrepareOptions& o) { o.maximumFrames = 1; },
                       +[](singz::DecodedAudioPrepareOptions& o) { o.maximumDecodedBytes = 4; },
                       +[](singz::DecodedAudioPrepareOptions& o) { o.maximumWorkingBytes = 4; },
                       +[](singz::DecodedAudioPrepareOptions& o) {
                         o.maximumFrames = 3840;
                         o.maximumDecodedBytes = 3840 * sizeof(float);
                         o.maximumWorkingBytes = 3840 * sizeof(float);
                       }}) {
      const auto result = bounded(shape);
      check(result.status == singz::DecodedAudioStatus::LimitExceeded && result.audio == nullptr,
            "a prepare bound the decode would exceed is refused before publication");
    }
    const auto exact = bounded(+[](singz::DecodedAudioPrepareOptions& o) {
      o.maximumFrames = 3840;
      o.maximumDecodedBytes = 3840 * sizeof(float);
      o.maximumWorkingBytes = (3840 + 1152) * sizeof(float);
    });
    check(exact.ok(), "and the smallest sufficient bounds are enough");
  }

  // ---- 9. real files, FFmpeg at run time (opt-in) ---------------------------
  if (const char* extra = std::getenv("SINGZ_MP3_EXTRA_FILES"); extra != nullptr && *extra != '\0') {
#if defined(_WIN32)
    const char separator = ';';
#else
    const char separator = ':';
#endif
    std::string list = extra;
    size_t start = 0;
    while (start <= list.size()) {
      const size_t end = std::min(list.find(separator, start), list.size());
      const std::string path = list.substr(start, end - start);
      start = end + 1;
      if (path.empty()) continue;
      const auto whole = decodeWhole(path, singz::DecodedAudioSourceFormat::Mp3);
      check(whole != nullptr, path + ": decodes");
      if (whole == nullptr) continue;
      Pcm reference;
      reference.rate = whole->sampleRate();
      if (!ffmpegDecode(path, whole->channelCount(), &reference)) {
        check(false, path + ": ffmpeg could not decode it for the reference");
        continue;
      }
      const Pcm mine = fromDecoded(*whole);
      const Agreement a = compare(mine, reference);
      check(a.sameShape && a.maxError < 1e-4 && a.snrDb > 80.0,
            path + ": against FFmpeg (" + std::to_string(mine.frames()) + " vs " +
                std::to_string(reference.frames()) + " frames, max error " +
                std::to_string(a.maxError) + ", SNR " + std::to_string(a.snrDb) + " dB)");
      std::printf("%s: %llu frames (FFmpeg %llu)  max|e| %.2e  SNR %.1f dB\n", path.c_str(),
                  static_cast<unsigned long long>(mine.frames()),
                  static_cast<unsigned long long>(reference.frames()), a.maxError, a.snrDb);
      streamingAgrees(path, path, mine, 200);
    }
  }

  if (failures == 0) std::printf("mp3_decoder_tests: all passed\n");
  return failures == 0 ? 0 : 1;
}
