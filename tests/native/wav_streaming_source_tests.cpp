// The streaming WAV source against the whole-file decode it stands in for.
//
// Every lead and backing vocal lane since 0.23.0 is a 32-bit float WAV, and a
// song streams only if EVERY lane can: before this source existed one such
// lane sent the whole song back to a full decode on the phones (115 MB held
// against 20 MB for a 40-second song) and on the desktop's open. So the bar
// here is the FLAC suite's: the same floats in the same order as
// `prepareDecodedAudio`, compared bit for bit, at every read size and every
// seek target — a lane a few milliseconds out drifts against the other six and
// nothing downstream can see it.
//
// The refusal cases compare against the decoder too. The two share one header
// walk (wav_streaming_source.cpp), and these cases are what keeps a later edit
// to one of them from quietly making a file playable on one path and refused
// on the other.
#include <zcore/media/decoded_audio.h>
#include <zcore/media/streaming_audio_source.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
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

namespace {

int failures = 0;

void check(bool ok, const std::string& what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL  %s\n", what.c_str());
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
  return base + "/singz-wav-stream-" + std::to_string(counter++) + suffix;
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

// ---- fixtures -----------------------------------------------------------

struct Spec {
  uint16_t channels = 2;
  uint32_t rate = 44100;
  uint16_t bits = 16;
  bool isFloat = false;
  bool extensible = false;
  uint64_t frames = 20000;
  // An odd-sized chunk before fmt, another between fmt and data, and one
  // after data: RIFF pads odd chunks, and a pad byte is not audio.
  bool extraChunks = false;
  // Damage and unsupported shapes, one at a time.
  uint16_t validBits = 0;  // 0: same as bits
  bool unknownGuid = false;
  int blockAlignDelta = 0;
  bool dataBeforeFmt = false;
  bool riffSizeSentinel = false;
  bool dataSizeSentinel = false;
  const char* form = "WAVE";
  size_t truncateBytes = 0;  // cut this many bytes off the end of the file
  int64_t nanAtFrame = -1;   // float only: channel 1 (or 0) of this frame is NaN
};

// Distinct and non-repeating per channel, so a swapped, duplicated or offset
// channel cannot pass by luck. Float lanes reach ±1.7 — the residual peaks a
// lead lane really carries, which is the reason these lanes are float at all.
double sampleValue(uint64_t frame, uint16_t channel, bool isFloat) {
  const double t = static_cast<double>(frame);
  const double amp = isFloat ? 1.7 : 0.9;
  return amp * std::sin(t * (0.0131 + 0.0017 * channel) + 0.7 * channel) *
         (0.55 + 0.45 * std::cos(t * 0.00071 + channel));
}

void put16(std::vector<unsigned char>& b, uint16_t v) {
  b.push_back(static_cast<unsigned char>(v & 0xff));
  b.push_back(static_cast<unsigned char>(v >> 8));
}
void put32(std::vector<unsigned char>& b, uint32_t v) {
  for (int i = 0; i < 4; i++) b.push_back(static_cast<unsigned char>((v >> (8 * i)) & 0xff));
}
void putTag(std::vector<unsigned char>& b, const char* tag) {
  b.insert(b.end(), tag, tag + 4);
}

std::string writeWav(const Spec& s) {
  const uint16_t bytesPerSample = static_cast<uint16_t>(s.bits / 8);
  const uint32_t blockAlign = static_cast<uint32_t>(bytesPerSample) * s.channels;
  const uint32_t dataBytes = static_cast<uint32_t>(s.frames * blockAlign);

  std::vector<unsigned char> fmt;
  const bool plainFloat = s.isFloat && !s.extensible;
  put16(fmt, s.extensible ? 0xfffe : (plainFloat ? 3 : 1));
  put16(fmt, s.channels);
  put32(fmt, s.rate);
  put32(fmt, s.rate * blockAlign);
  put16(fmt, static_cast<uint16_t>(static_cast<int>(blockAlign) + s.blockAlignDelta));
  put16(fmt, s.bits);
  if (s.extensible) {
    put16(fmt, 22);
    put16(fmt, s.validBits != 0 ? s.validBits : s.bits);
    put32(fmt, 0);
    const unsigned char tail[14] = {0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80,
                                    0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};
    fmt.push_back(s.unknownGuid ? 0x07 : (s.isFloat ? 0x03 : 0x01));
    fmt.push_back(0x00);
    fmt.insert(fmt.end(), tail, tail + 14);
  }

  std::vector<unsigned char> data;
  data.reserve(dataBytes);
  for (uint64_t i = 0; i < s.frames; i++) {
    for (uint16_t c = 0; c < s.channels; c++) {
      const double v = sampleValue(i, c, s.isFloat);
      if (s.isFloat) {
        float f = static_cast<float>(v);
        if (static_cast<int64_t>(i) == s.nanAtFrame && c == s.channels - 1) f = std::nanf("");
        uint32_t bits = 0;
        std::memcpy(&bits, &f, 4);
        put32(data, bits);
      } else if (s.bits == 8) {
        data.push_back(static_cast<unsigned char>(128 + std::lround(v * 127.0)));
      } else if (s.bits == 16) {
        put16(data, static_cast<uint16_t>(static_cast<int16_t>(std::lround(v * 32767.0))));
      } else if (s.bits == 24) {
        const auto x = static_cast<int32_t>(std::lround(v * 8388607.0));
        data.push_back(static_cast<unsigned char>(x & 0xff));
        data.push_back(static_cast<unsigned char>((x >> 8) & 0xff));
        data.push_back(static_cast<unsigned char>((x >> 16) & 0xff));
      } else {
        put32(data, static_cast<uint32_t>(static_cast<int32_t>(std::llround(v * 2147483647.0))));
      }
    }
  }
  // 64-bit "float" fixtures only need the right size, not meaningful doubles.
  data.resize(dataBytes, 0);

  std::vector<unsigned char> body;
  putTag(body, s.form);
  auto chunk = [&](const char* tag, const std::vector<unsigned char>& payload,
                   bool sentinel = false) {
    putTag(body, tag);
    put32(body, sentinel ? 0xffffffffu : static_cast<uint32_t>(payload.size()));
    body.insert(body.end(), payload.begin(), payload.end());
    if (payload.size() & 1) body.push_back(0);
  };
  if (s.extraChunks) chunk("LIST", {'I', 'N', 'F', 'O', '!'});
  if (s.dataBeforeFmt) chunk("data", data);
  chunk("fmt ", fmt);
  if (s.extraChunks) chunk("junk", {1, 2, 3});
  if (!s.dataBeforeFmt) chunk("data", data, s.dataSizeSentinel);
  if (s.extraChunks) chunk("id3 ", {9, 9, 9, 9});

  std::vector<unsigned char> file;
  putTag(file, "RIFF");
  put32(file, s.riffSizeSentinel ? 0xffffffffu : static_cast<uint32_t>(body.size()));
  file.insert(file.end(), body.begin(), body.end());
  if (s.truncateBytes > 0 && s.truncateBytes < file.size())
    file.resize(file.size() - s.truncateBytes);

  const std::string path = tempPath(".wav");
  std::FILE* f = std::fopen(path.c_str(), "wb");
  std::fwrite(file.data(), 1, file.size(), f);
  std::fclose(f);
  return path;
}

std::string writeBytes(const std::string& suffix, const std::string& bytes) {
  const std::string path = tempPath(suffix.c_str());
  std::FILE* f = std::fopen(path.c_str(), "wb");
  std::fwrite(bytes.data(), 1, bytes.size(), f);
  std::fclose(f);
  return path;
}

// ---- helpers --------------------------------------------------------------

std::shared_ptr<const singz::DecodedAudio> decodeWhole(const std::string& path) {
  const singz::DecodedAudioResult r = singz::prepareDecodedAudio(openRead(path));
  return r.ok() ? r.audio : nullptr;
}

bool sameFloat(float a, float b) { return std::memcmp(&a, &b, sizeof(float)) == 0; }

// Reads everything left in the source in `step`-sized reads.
std::vector<std::vector<float>> readRest(singz::StreamingAudioSource& source, size_t step,
                                         size_t limit = SIZE_MAX) {
  const uint16_t channels = source.info().channels;
  std::vector<std::vector<float>> out(channels);
  std::vector<std::vector<float>> block(channels, std::vector<float>(step, 0.0F));
  std::vector<float*> ptrs(channels);
  for (uint16_t c = 0; c < channels; c++) ptrs[c] = block[c].data();
  size_t total = 0;
  while (total < limit) {
    const size_t want = std::min(step, limit - total);
    size_t got = 0;
    const singz::DecodedAudioStatus st = source.read(ptrs.data(), want, &got);
    for (uint16_t c = 0; c < channels; c++)
      out[c].insert(out[c].end(), block[c].begin(), block[c].begin() + static_cast<std::ptrdiff_t>(got));
    total += got;
    if (st != singz::DecodedAudioStatus::Ok || got == 0) break;
  }
  return out;
}

bool matchesDecode(const std::vector<std::vector<float>>& got,
                   const singz::DecodedAudio& ref, uint64_t from, uint64_t frames) {
  if (got.size() != ref.channelCount()) return false;
  for (uint32_t c = 0; c < ref.channelCount(); c++) {
    if (got[c].size() != frames) return false;
    const float* want = ref.channelData(c) + from;
    for (uint64_t i = 0; i < frames; i++)
      if (!sameFloat(got[c][i], want[i])) return false;
  }
  return true;
}

std::unique_ptr<singz::StreamingAudioSource> openStream(
    const std::string& path, singz::DecodedAudioStatus* status,
    singz::DecodedAudioSourceFormat format = singz::DecodedAudioSourceFormat::Auto) {
  singz::StreamingAudioOpenOptions options{};
  options.sourceFormat = format;
  return singz::openStreamingAudioSource(openRead(path), options, status);
}

std::string describe(const Spec& s) {
  return std::to_string(s.channels) + "ch " + std::to_string(s.bits) + "-bit " +
         (s.isFloat ? "float" : "int") + (s.extensible ? " extensible" : "") +
         (s.extraChunks ? " +chunks" : "") + " @" + std::to_string(s.rate);
}

}  // namespace

int main() {
  // ---- 1. every accepted shape reads back as the decoder's floats ---------
  std::vector<Spec> shapes;
  {
    Spec s;  // the ordinary splitter-cache stem
    shapes.push_back(s);
    s = Spec{}; s.channels = 1; s.bits = 24; s.rate = 48000; s.frames = 12345;
    shapes.push_back(s);
    s = Spec{}; s.bits = 32;
    shapes.push_back(s);
    s = Spec{}; s.bits = 32; s.isFloat = true;  // the lead/backing lanes
    shapes.push_back(s);
    s = Spec{}; s.bits = 32; s.isFloat = true; s.extensible = true;
    shapes.push_back(s);
    s = Spec{}; s.channels = 6; s.bits = 16; s.extensible = true; s.frames = 7001;
    shapes.push_back(s);
    s = Spec{}; s.bits = 32; s.isFloat = true; s.extraChunks = true; s.frames = 9999;
    shapes.push_back(s);
  }
  for (const Spec& spec : shapes) {
    const std::string what = describe(spec);
    const std::string path = writeWav(spec);
    const auto ref = decodeWhole(path);
    check(ref != nullptr, what + ": the decoder reads the fixture");
    if (ref == nullptr) continue;

    singz::DecodedAudioStatus status = singz::DecodedAudioStatus::InvalidArgument;
    auto source = openStream(path, &status);
    check(source != nullptr && status == singz::DecodedAudioStatus::Ok, what + ": opens");
    if (source == nullptr) continue;
    const auto& info = source->info();
    check(info.sampleRate == ref->sampleRate() && info.channels == ref->channelCount() &&
              info.frameCount == ref->frameCount() && info.frameCount == spec.frames,
          what + ": rate, channels and length agree with the decode");
    check(info.frameCountFromContainer && info.seekCost == singz::SeekCost::Indexed &&
              info.seekGranularityFrames == 1,
          what + ": a WAV is Indexed to the frame from open");

    // Awkward read sizes: one frame, a prime, a whole chunk, straddling one.
    const size_t steps[] = {1, 7, 4096, 5000, 100000};
    for (size_t step : steps) {
      check(source->seek(0) == singz::DecodedAudioStatus::Ok, what + ": seek to 0");
      const auto got = readRest(*source, step);
      check(matchesDecode(got, *ref, 0, spec.frames),
            what + ": reads in steps of " + std::to_string(step) + " equal the decode");
      check(source->position() == spec.frames, what + ": position ends at the length");
    }
    if (spec.isFloat) {
      float peak = 0.0F;
      for (uint32_t c = 0; c < ref->channelCount(); c++)
        for (uint64_t i = 0; i < ref->frameCount(); i++)
          peak = std::max(peak, std::fabs(ref->channelData(c)[i]));
      check(peak > 1.0F, what + ": float peaks above full scale pass through unclamped");
    }

    // Seeks, deliberately off every boundary a chunk or a block might have.
    const uint64_t targets[] = {0, 1, 4095, 4096, 4097, spec.frames / 2, spec.frames - 1};
    for (uint64_t target : targets) {
      if (target >= spec.frames) continue;
      check(source->seek(target) == singz::DecodedAudioStatus::Ok &&
                source->position() == target,
            what + ": seek to " + std::to_string(target));
      const uint64_t n = std::min<uint64_t>(3000, spec.frames - target);
      const auto got = readRest(*source, 997, static_cast<size_t>(n));
      check(matchesDecode(got, *ref, target, n),
            what + ": audio after a seek to " + std::to_string(target) + " is the decode's");
    }
    // At and beyond the end: positioned there, reads zero, still Ok.
    check(source->seek(spec.frames) == singz::DecodedAudioStatus::Ok &&
              source->position() == spec.frames,
          what + ": seek to the end");
    check(source->seek(spec.frames + 500) == singz::DecodedAudioStatus::Ok &&
              source->position() == spec.frames,
          what + ": a seek beyond the end lands at the end");
    {
      std::vector<std::vector<float>> block(spec.channels, std::vector<float>(64));
      std::vector<float*> ptrs(spec.channels);
      for (uint16_t c = 0; c < spec.channels; c++) ptrs[c] = block[c].data();
      size_t got = 99;
      const auto st = source->read(ptrs.data(), 64, &got);
      check(st == singz::DecodedAudioStatus::Ok && got == 0, what + ": reading at the end returns zero");
    }
    check(source->buildSeekIndex({}) == singz::DecodedAudioStatus::Ok &&
              source->info().seekCost == singz::SeekCost::Indexed,
          what + ": building an index is a no-op that stays Indexed");
    source.reset();
    std::remove(path.c_str());
  }

  // ---- 2. two sources on one file do not drag each other about -----------
  {
    Spec spec; spec.bits = 32; spec.isFloat = true; spec.frames = 30000;
    const std::string path = writeWav(spec);
    const auto ref = decodeWhole(path);
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
    if (a != nullptr && b != nullptr && ref != nullptr) {
      std::vector<std::vector<float>> ga(2), gb(2);
      std::vector<std::vector<float>> block(2, std::vector<float>(1000));
      float* ptrs[2] = {block[0].data(), block[1].data()};
      (void)b->seek(20000);
      for (int round = 0; round < 10; round++) {
        size_t got = 0;
        (void)a->read(ptrs, 1000, &got);
        for (int c = 0; c < 2; c++) ga[c].insert(ga[c].end(), block[c].begin(), block[c].begin() + static_cast<std::ptrdiff_t>(got));
        (void)b->read(ptrs, 1000, &got);
        for (int c = 0; c < 2; c++) gb[c].insert(gb[c].end(), block[c].begin(), block[c].begin() + static_cast<std::ptrdiff_t>(got));
      }
      check(matchesDecode(ga, *ref, 0, 10000), "interleaved reads: the first source reads its own frames");
      check(matchesDecode(gb, *ref, 20000, 10000), "interleaved reads: the second source reads its own frames");
    }
    std::remove(path.c_str());
  }

  // ---- 3. refusals agree with the decoder --------------------------------
  {
    struct Refusal {
      const char* what;
      Spec spec;
      singz::DecodedAudioStatus expected;
    };
    std::vector<Refusal> refusals;
    Spec s;
    s = Spec{}; s.form = "AVI ";
    refusals.push_back({"a RIFF that is not WAVE", s, singz::DecodedAudioStatus::MalformedData});
    s = Spec{}; s.bits = 8; s.frames = 1000;
    refusals.push_back({"8-bit PCM", s, singz::DecodedAudioStatus::UnsupportedFormat});
    s = Spec{}; s.bits = 64; s.isFloat = true; s.frames = 1000;
    refusals.push_back({"64-bit float", s, singz::DecodedAudioStatus::UnsupportedFormat});
    s = Spec{}; s.riffSizeSentinel = true;
    refusals.push_back({"an RF64-style RIFF size sentinel", s, singz::DecodedAudioStatus::UnsupportedFormat});
    s = Spec{}; s.dataSizeSentinel = true;
    refusals.push_back({"a streaming data-size sentinel", s, singz::DecodedAudioStatus::UnsupportedFormat});
    s = Spec{}; s.dataBeforeFmt = true;
    refusals.push_back({"data before fmt", s, singz::DecodedAudioStatus::MalformedData});
    s = Spec{}; s.blockAlignDelta = 2;
    refusals.push_back({"a wrong block align", s, singz::DecodedAudioStatus::MalformedData});
    s = Spec{}; s.truncateBytes = 1000;
    refusals.push_back({"a file shorter than its RIFF size", s, singz::DecodedAudioStatus::MalformedData});
    s = Spec{}; s.bits = 32; s.extensible = true; s.validBits = 24;
    refusals.push_back({"extensible with reduced valid bits", s, singz::DecodedAudioStatus::UnsupportedFormat});
    s = Spec{}; s.extensible = true; s.unknownGuid = true;
    refusals.push_back({"extensible with an unknown subformat", s, singz::DecodedAudioStatus::UnsupportedFormat});
    for (const Refusal& r : refusals) {
      const std::string path = writeWav(r.spec);
      const singz::DecodedAudioResult decoded = singz::prepareDecodedAudio(openRead(path));
      singz::DecodedAudioStatus streamed = singz::DecodedAudioStatus::Ok;
      auto source = openStream(path, &streamed);
      check(decoded.status == r.expected, std::string(r.what) + ": the decoder refuses it as expected");
      check(source == nullptr && streamed == decoded.status,
            std::string(r.what) + ": the stream refuses it with the decoder's status");
      std::remove(path.c_str());
    }
  }

  // ---- 4. declared formats, rates, and not-audio ---------------------------
  {
    Spec spec;
    const std::string wav = writeWav(spec);
    singz::DecodedAudioStatus st = singz::DecodedAudioStatus::Ok;
    auto asWav = openStream(wav, &st, singz::DecodedAudioSourceFormat::Wav);
    check(asWav != nullptr && st == singz::DecodedAudioStatus::Ok, "a WAV declared as WAV opens");
    auto asFlac = openStream(wav, &st, singz::DecodedAudioSourceFormat::Flac);
    check(asFlac == nullptr && st == singz::DecodedAudioStatus::UnsupportedFormat,
          "a WAV declared as FLAC is refused, not read as something else");
    singz::StreamingAudioOpenOptions resample{};
    resample.requiredSampleRate = 48000;
    auto none = singz::openStreamingAudioSource(openRead(wav), resample, &st);
    check(none == nullptr && st == singz::DecodedAudioStatus::InvalidArgument,
          "a resample request is refused rather than answered at the wrong rate");

    const std::string text = writeBytes(".wav", "this is not audio, whatever it is called");
    auto named = openStream(text, &st, singz::DecodedAudioSourceFormat::Wav);
    check(named == nullptr && st == singz::DecodedAudioStatus::UnsupportedFormat,
          "a non-RIFF file declared as WAV is refused as UnsupportedFormat");
    auto sniffed = openStream(text, &st);
    check(sniffed == nullptr && st == singz::DecodedAudioStatus::UnsupportedFormat,
          "a non-audio file is refused as UnsupportedFormat when sniffed");

#if !defined(_WIN32)
    // A descriptor handed in is closed on every refusal, on both new paths.
    for (auto format : {singz::DecodedAudioSourceFormat::Wav, singz::DecodedAudioSourceFormat::Auto}) {
      singz::OwnedFileDescriptor probe = openRead(text);
      const int fd = probe.get();
      singz::StreamingAudioOpenOptions options{};
      options.sourceFormat = format;
      (void)singz::openStreamingAudioSource(std::move(probe), options, &st);
      check(::fcntl(fd, F_GETFD) == -1, "a refused open closes the descriptor it was given");
    }
    {
      Spec bad; bad.bits = 8; bad.frames = 10;
      const std::string eight = writeWav(bad);
      singz::OwnedFileDescriptor probe = openRead(eight);
      const int fd = probe.get();
      (void)singz::openStreamingAudioSource(std::move(probe), {}, &st);
      check(::fcntl(fd, F_GETFD) == -1, "a WAV the parser refuses closes its descriptor too");
      std::remove(eight.c_str());
    }
#endif
    std::remove(wav.c_str());
    std::remove(text.c_str());
  }

  // ---- 5. damage part way: the good frames first, then the error ------------
  {
    Spec spec; spec.bits = 32; spec.isFloat = true; spec.frames = 6000; spec.nanAtFrame = 1000;
    const std::string path = writeWav(spec);
    const singz::DecodedAudioResult decoded = singz::prepareDecodedAudio(openRead(path));
    check(decoded.status == singz::DecodedAudioStatus::MalformedData,
          "the decoder refuses a float WAV with a NaN in it");
    singz::DecodedAudioStatus st = singz::DecodedAudioStatus::Ok;
    auto source = openStream(path, &st);
    check(source != nullptr, "the stream opens it: the damage is in the audio, not the header");
    if (source != nullptr) {
      std::vector<std::vector<float>> block(2, std::vector<float>(4096));
      float* ptrs[2] = {block[0].data(), block[1].data()};
      size_t got = 0;
      auto first = source->read(ptrs, 4096, &got);
      check(first == singz::DecodedAudioStatus::Ok && got == 1000,
            "the frames before the damage are handed over with Ok");
      check(source->position() == 1000, "and the position counts exactly those");
      bool exact = true;
      for (int c = 0; c < 2 && exact; c++)
        for (size_t i = 0; i < got; i++)
          if (!sameFloat(block[c][i], static_cast<float>(sampleValue(i, static_cast<uint16_t>(c), true))))
            exact = false;
      check(exact, "and they are the samples written");
      auto second = source->read(ptrs, 4096, &got);
      check(second == singz::DecodedAudioStatus::MalformedData && got == 0,
            "the next read reports the damage with no frames");
      check(source->seek(1001) == singz::DecodedAudioStatus::Ok, "a seek past the damage works");
      auto third = source->read(ptrs, 100, &got);
      check(third == singz::DecodedAudioStatus::Ok && got == 100, "and reading resumes after it");
    }
    std::remove(path.c_str());
  }

  // ---- 6. a file that shrinks under an open source ---------------------------
  {
    Spec spec; spec.bits = 16; spec.frames = 10000;
    const std::string path = writeWav(spec);
    singz::DecodedAudioStatus st = singz::DecodedAudioStatus::Ok;
    auto source = openStream(path, &st);
    check(source != nullptr, "opens before the cut");
    if (source != nullptr) {
      const long keep = 44 + 2500 * 4 + 2;  // header, 2500 frames, half a frame
#if defined(_WIN32)
      int w = -1;
      _sopen_s(&w, path.c_str(), _O_RDWR | _O_BINARY, _SH_DENYNO, _S_IREAD | _S_IWRITE);
      const bool cut = w >= 0 && _chsize_s(w, keep) == 0;
      if (w >= 0) _close(w);
#else
      const bool cut = ::truncate(path.c_str(), keep) == 0;
#endif
      check(cut, "the fixture could be cut");
      std::vector<std::vector<float>> block(2, std::vector<float>(8192));
      float* ptrs[2] = {block[0].data(), block[1].data()};
      size_t got = 0;
      auto first = source->read(ptrs, 8192, &got);
      check(first == singz::DecodedAudioStatus::Ok && got == 2500,
            "the whole frames that survived are handed over, the torn one is not");
      auto second = source->read(ptrs, 8192, &got);
      check(second == singz::DecodedAudioStatus::IoError && got == 0,
            "and the next read says the file ended early");
    }
    std::remove(path.c_str());
  }

  // ---- 7. cancellation stops between chunks and loses nothing ------------------
  {
    Spec spec; spec.bits = 32; spec.isFloat = true; spec.frames = 20000;
    const std::string path = writeWav(spec);
    const auto ref = decodeWhole(path);
    singz::DecodedAudioStatus st = singz::DecodedAudioStatus::Ok;
    auto source = openStream(path, &st);
    std::atomic<bool> stop{true};
    singz::DecodeCancellation cancel{
        &stop, [](void* flag) noexcept { return static_cast<std::atomic<bool>*>(flag)->load(); }};
    if (source != nullptr && ref != nullptr) {
      source->setCancellation(cancel);
      std::vector<std::vector<float>> block(2, std::vector<float>(1000));
      float* ptrs[2] = {block[0].data(), block[1].data()};
      size_t got = 99;
      (void)source->read(ptrs, 1000, &got);
      check(got == 0 && source->position() == 0, "a cancelled read hands over nothing and does not move");
      stop.store(false);
      const auto rest = readRest(*source, 4096);
      check(matchesDecode(rest, *ref, 0, spec.frames), "and once released it reads from where it was");
    }
    std::remove(path.c_str());
  }

  if (failures == 0) std::printf("wav_streaming_source_tests: all passed\n");
  return failures == 0 ? 0 : 1;
}
