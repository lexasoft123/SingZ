#include "wav.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace singz {
namespace {

void putU32(uint8_t* p, uint32_t v) {
  p[0] = v & 0xff;
  p[1] = (v >> 8) & 0xff;
  p[2] = (v >> 16) & 0xff;
  p[3] = (v >> 24) & 0xff;
}

void putU16(uint8_t* p, uint16_t v) {
  p[0] = v & 0xff;
  p[1] = (v >> 8) & 0xff;
}

}  // namespace

bool WavWriter::open(const std::string& path, int sampleRate, int channels,
                     int64_t existingFrames) {
  close();
  sampleRate_ = sampleRate;
  channels_ = channels;
  finalized_ = false;
  if (existingFrames >= 0) {
    f_ = std::fopen(path.c_str(), "r+b");
    if (f_ == nullptr) return false;
    // Backstop: the file must really hold every claimed frame — a resume
    // after a kill that outran stdio would otherwise zero-fill the gap.
    if (fseeko(f_, 0, SEEK_END) != 0 ||
        ftello(f_) < 44 + existingFrames * channels_ * 2) {
      close();
      return false;
    }
    frames_ = existingFrames;
    return fseeko(f_, 44 + existingFrames * channels_ * 2, SEEK_SET) == 0;
  }
  f_ = std::fopen(path.c_str(), "wb");
  if (f_ == nullptr) return false;
  frames_ = 0;
  uint8_t header[44] = {0};
  return std::fwrite(header, 1, sizeof(header), f_) == sizeof(header);
}

bool WavWriter::append(const float* interleaved, int64_t frames) {
  if (f_ == nullptr || frames <= 0) return f_ != nullptr;
  const int64_t samples = frames * channels_;
  std::vector<int16_t> pcm(static_cast<size_t>(samples));
  for (int64_t i = 0; i < samples; i++) {
    const float v = interleaved[i];
    // same shape as the desktop's renderer WAV: scale, round, clamp
    float scaled = v * 32767.0f;
    if (scaled > 32767.0f) scaled = 32767.0f;
    if (scaled < -32768.0f) scaled = -32768.0f;
    pcm[static_cast<size_t>(i)] = static_cast<int16_t>(std::lrintf(scaled));
  }
  if (std::fwrite(pcm.data(), 2, static_cast<size_t>(samples), f_) !=
      static_cast<size_t>(samples)) {
    return false;
  }
  frames_ += frames;
  return true;
}

bool WavWriter::flush() {
  return f_ != nullptr && std::fflush(f_) == 0;
}

bool WavWriter::finalize() {
  if (finalized_) return true;  // documented safe to call twice
  if (f_ == nullptr) return false;
  const uint32_t dataBytes = static_cast<uint32_t>(frames_ * channels_ * 2);
  uint8_t header[44];
  std::memcpy(header, "RIFF", 4);
  putU32(header + 4, 36 + dataBytes);
  std::memcpy(header + 8, "WAVE", 4);
  std::memcpy(header + 12, "fmt ", 4);
  putU32(header + 16, 16);
  putU16(header + 20, 1);  // PCM — the only format the desktop FLAC reader takes
  putU16(header + 22, static_cast<uint16_t>(channels_));
  putU32(header + 24, static_cast<uint32_t>(sampleRate_));
  putU32(header + 28, static_cast<uint32_t>(sampleRate_ * channels_ * 2));
  putU16(header + 32, static_cast<uint16_t>(channels_ * 2));
  putU16(header + 34, 16);
  std::memcpy(header + 36, "data", 4);
  putU32(header + 40, dataBytes);
  if (fseeko(f_, 0, SEEK_SET) != 0) return false;
  if (std::fwrite(header, 1, sizeof(header), f_) != sizeof(header)) return false;
  finalized_ = true;
  close();
  return true;
}

void WavWriter::close() {
  if (f_ != nullptr) {
    std::fclose(f_);
    f_ = nullptr;
  }
}

}  // namespace singz

// ---- reader ----------------------------------------------------------------
#include "flac_io.h"

namespace singz {

namespace {
// Dispatch on the file's first four bytes, not its suffix: a stem is named
// by its id, projects open from anywhere, and a FLAC named .wav would
// otherwise fail as "not a RIFF/WAVE file" while a WAV named .flac already
// fails loudly — the asymmetric case is the one the suffix cannot catch.
bool looksFlac(const std::string& path) {
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (f == nullptr) return false;
  unsigned char magic[4] = {0, 0, 0, 0};
  const size_t got = std::fread(magic, 1, 4, f);
  std::fclose(f);
  return got == 4 && std::memcmp(magic, "fLaC", 4) == 0;
}
}  // namespace


namespace {
uint32_t le32(const unsigned char* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}
uint16_t le16(const unsigned char* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }
}  // namespace

namespace {
// The header walk both readers share: leaves `f` positioned at the first
// data byte and reports the format; `frames` is the data chunk's stated
// count clamped to the bytes actually left in the file (streaming encoders
// write 0xFFFFFFFF sizes; a truncated file states more than it holds — and
// a multi-GB allocation off a lying header would take the app down).
struct WavHeader {
  int format = 0, channels = 0, bits = 0, rate = 0;
  int64_t frames = 0;
  bool isFloat = false;
  std::string error;
};

bool walkHeader(std::FILE* f, WavHeader& h) {
  unsigned char hdr[12];
  if (std::fread(hdr, 1, 12, f) != 12 || std::memcmp(hdr, "RIFF", 4) != 0 || std::memcmp(hdr + 8, "WAVE", 4) != 0) {
    h.error = "not a RIFF/WAVE file";
    return false;
  }
  bool haveFmt = false;
  for (;;) {
    unsigned char ch[8];
    if (std::fread(ch, 1, 8, f) != 8) {
      h.error = haveFmt ? "no data chunk" : "no fmt chunk";
      return false;
    }
    const uint32_t size = le32(ch + 4);
    if (std::memcmp(ch, "fmt ", 4) == 0) {
      if (size < 16) {
        h.error = "fmt chunk too short";
        return false;
      }
      std::vector<unsigned char> fmt(size);
      if (std::fread(fmt.data(), 1, size, f) != size) {
        h.error = "truncated fmt chunk";
        return false;
      }
      h.format = le16(fmt.data());
      h.channels = le16(fmt.data() + 2);
      h.rate = static_cast<int>(le32(fmt.data() + 4));
      h.bits = le16(fmt.data() + 14);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in the sub-format GUID.
      if (h.format == 0xFFFE && size >= 26) h.format = le16(fmt.data() + 24);
      haveFmt = true;
      if (size & 1) std::fseek(f, 1, SEEK_CUR);
    } else if (std::memcmp(ch, "data", 4) == 0) {
      if (!haveFmt || h.channels <= 0 || h.rate <= 0) {
        h.error = "data before fmt";
        return false;
      }
      h.isFloat = h.format == 3;
      if (!(h.isFloat && h.bits == 32) && !(h.format == 1 && (h.bits == 16 || h.bits == 24 || h.bits == 32))) {
        h.error = "unsupported sample format";
        return false;
      }
      const long here = std::ftell(f);
      std::fseek(f, 0, SEEK_END);
      const long end = std::ftell(f);
      std::fseek(f, here, SEEK_SET);
      const int64_t left = here >= 0 && end >= here ? static_cast<int64_t>(end - here) : 0;
      const int64_t frameBytes = static_cast<int64_t>(h.bits / 8) * h.channels;
      h.frames = std::min<int64_t>(static_cast<int64_t>(size), left) / frameBytes;
      return true;
    } else {
      std::fseek(f, static_cast<long>(size + (size & 1)), SEEK_CUR);
    }
  }
}
}  // namespace

WavInfo readWavInfo(const std::string& path) {
  if (looksFlac(path)) return readFlacInfo(path);
  WavInfo out;
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (f == nullptr) {
    out.error = "cannot open";
    return out;
  }
  WavHeader h;
  const bool ok = walkHeader(f, h);
  std::fclose(f);
  if (!ok) {
    out.error = h.error;
    return out;
  }
  out.sampleRate = h.rate;
  out.channels = h.channels;
  out.frames = h.frames;
  out.ok = true;
  return out;
}

MonoWav readWavMono(const std::string& path) {
  if (looksFlac(path)) return readFlacMono(path);
  MonoWav out;
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (f == nullptr) {
    out.error = "cannot open";
    return out;
  }
  WavHeader h;
  if (!walkHeader(f, h)) {
    std::fclose(f);
    out.error = h.error;
    return out;
  }
  {
    const int channels = h.channels;
    const int bits = h.bits;
    const bool isFloat = h.isFloat;
    const int rate = h.rate;
    {
      const size_t bytesPer = static_cast<size_t>(bits / 8);
      const size_t frameBytes = bytesPer * static_cast<size_t>(channels);
      const size_t frames = static_cast<size_t>(h.frames);
      std::vector<unsigned char> raw(frames * frameBytes);
      const size_t got = std::fread(raw.data(), 1, raw.size(), f);
      const size_t haveFrames = got / frameBytes;
      out.samples.resize(haveFrames);
      for (size_t i = 0; i < haveFrames; i++) {
        double acc = 0;
        for (int c = 0; c < channels; c++) {
          const unsigned char* p = raw.data() + i * frameBytes + static_cast<size_t>(c) * bytesPer;
          double v;
          if (isFloat) {
            float fv;
            std::memcpy(&fv, p, 4);
            v = fv;
          } else if (bits == 16) {
            v = static_cast<int16_t>(le16(p)) / 32768.0;
          } else if (bits == 24) {
            int32_t s = static_cast<int32_t>((static_cast<uint32_t>(p[0]) << 8) | (static_cast<uint32_t>(p[1]) << 16) |
                                             (static_cast<uint32_t>(p[2]) << 24)) >> 8;
            v = s / 8388608.0;
          } else {
            v = static_cast<int32_t>(le32(p)) / 2147483648.0;
          }
          // The JS fold: mono[i] += data[i] / chans, channel by channel.
          acc = static_cast<double>(static_cast<float>(acc + v / channels));
        }
        out.samples[i] = static_cast<float>(acc);
      }
      out.sampleRate = rate;
      out.channels = channels;
      out.ok = true;
    }
  }
  std::fclose(f);
  return out;
}

}  // namespace singz
