#include "wav.h"

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
