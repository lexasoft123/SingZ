#include <zcore/media/decoded_audio.h>
#include <zcore/media/flac_io.h>
#include <zcore/media/wav.h>
#include <zcore/legacy/resample.h>

#include "allocation_trap.h"
#include "zdsp/decoded_buffer_source.h"
#include "zdsp/scheduled_cue_source.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <limits>
#include <memory>
#include <string>
#include <vector>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <process.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace {

[[noreturn]] void fail(const char* message) {
  std::fprintf(stderr, "FAIL: %s\n", message);
  std::abort();
}

void expect(bool condition, const char* message) {
  if (!condition) fail(message);
}

void expectNear(float actual, float expected, float tolerance,
                const char* message) {
  if (!std::isfinite(actual) || !std::isfinite(expected) ||
      !std::isfinite(tolerance) || std::fabs(actual - expected) > tolerance)
    fail(message);
}

int processId() noexcept {
#if defined(_WIN32)
  return _getpid();
#else
  return static_cast<int>(::getpid());
#endif
}

std::string scratch(const char* name) {
  return (std::filesystem::temp_directory_path() /
      (std::string("singz-prepared-") + std::to_string(processId()) + "-" + name)).string();
}

int openForDecode(const std::string& path) noexcept {
#if defined(_WIN32)
  return _open(path.c_str(), _O_RDONLY | _O_BINARY);
#else
  return ::open(path.c_str(), O_RDONLY);
#endif
}

void closeTestDescriptor(int descriptor) noexcept {
#if defined(_WIN32)
  (void)_close(descriptor);
#else
  (void)::close(descriptor);
#endif
}

bool seekTestDescriptor(int descriptor, int64_t offset, int origin) noexcept {
#if defined(_WIN32)
  return _lseeki64(descriptor, offset, origin) >= 0;
#else
  return ::lseek(descriptor, static_cast<off_t>(offset), origin) >= 0;
#endif
}

struct DescriptorProbe {
#if defined(_WIN32)
  intptr_t handle = -1;
#else
  int descriptor = -1;
#endif
};

DescriptorProbe probeDescriptor(int descriptor) noexcept {
#if defined(_WIN32)
  return {_get_osfhandle(descriptor)};
#else
  return {descriptor};
#endif
}

bool descriptorProbeIsOpen(DescriptorProbe probe) noexcept {
#if defined(_WIN32)
  DWORD flags = 0;
  return probe.handle != -1 &&
      GetHandleInformation(reinterpret_cast<HANDLE>(probe.handle), &flags) != 0;
#else
  errno = 0;
  return fcntl(probe.descriptor, F_GETFD) != -1 || errno != EBADF;
#endif
}

float pcm16(float value) {
  float scaled = value * 32767.0f;
  if (scaled > 32767.0f) scaled = 32767.0f;
  if (scaled < -32768.0f) scaled = -32768.0f;
  return static_cast<float>(std::lrintf(scaled)) / 32768.0f;
}

std::string writeWav(const char* name, uint32_t sampleRate, uint32_t channels,
                     const std::vector<float>& interleaved) {
  const std::string path = scratch(name);
  std::remove(path.c_str());
  singz::WavWriter writer;
  expect(channels != 0 && interleaved.size() % channels == 0,
         "WAV fixture shape is valid");
  expect(writer.open(path, static_cast<int>(sampleRate),
                     static_cast<int>(channels)),
         "WAV fixture opens");
  expect(writer.append(interleaved.data(),
                       static_cast<int64_t>(interleaved.size() / channels)),
         "WAV fixture appends");
  expect(writer.finalize(), "WAV fixture finalizes");
  return path;
}

std::string writeStereoWav(const char* name, uint32_t sampleRate,
                           const std::vector<float>& interleaved) {
  return writeWav(name, sampleRate, 2, interleaved);
}

void writeBytes(const std::string& path, const std::vector<unsigned char>& bytes) {
  std::FILE* file = std::fopen(path.c_str(), "wb");
  expect(file != nullptr, "raw fixture opens");
  expect(std::fwrite(bytes.data(), 1, bytes.size(), file) == bytes.size(),
         "raw fixture writes");
  std::fclose(file);
}

std::vector<unsigned char> readBytes(const std::string& path) {
  std::FILE* file = std::fopen(path.c_str(), "rb");
  expect(file != nullptr, "raw fixture reopens");
  expect(std::fseek(file, 0, SEEK_END) == 0, "raw fixture seeks to end");
  const long length = std::ftell(file);
  expect(length >= 0 && std::fseek(file, 0, SEEK_SET) == 0,
         "raw fixture length is available");
  std::vector<unsigned char> bytes(static_cast<size_t>(length));
  expect(bytes.empty() ||
             std::fread(bytes.data(), 1, bytes.size(), file) == bytes.size(),
         "raw fixture reads");
  std::fclose(file);
  return bytes;
}

void putLittle16(std::vector<unsigned char>* bytes, size_t offset,
                 uint16_t value) {
  (*bytes)[offset] = static_cast<unsigned char>(value & 0xffu);
  (*bytes)[offset + 1] = static_cast<unsigned char>((value >> 8) & 0xffu);
}

void putLittle32(std::vector<unsigned char>* bytes, size_t offset,
                 uint32_t value) {
  for (size_t byte = 0; byte < 4; ++byte)
    (*bytes)[offset + byte] =
        static_cast<unsigned char>((value >> (byte * 8)) & 0xffu);
}

uint64_t readBig64(const std::vector<unsigned char>& bytes, size_t offset) {
  uint64_t value = 0;
  for (size_t byte = 0; byte < 8; ++byte)
    value = (value << 8) | bytes[offset + byte];
  return value;
}

void putBig64(std::vector<unsigned char>* bytes, size_t offset,
              uint64_t value) {
  for (size_t byte = 0; byte < 8; ++byte)
    (*bytes)[offset + byte] = static_cast<unsigned char>(
        value >> ((7 - byte) * 8));
}

void setFlacTotalSamples(std::vector<unsigned char>* bytes, uint64_t frames) {
  expect(bytes->size() >= 26 &&
             std::memcmp(bytes->data(), "fLaC", 4) == 0 &&
             frames < (uint64_t{1} << 36),
         "FLAC STREAMINFO total-samples fixture is valid");
  uint64_t word = readBig64(*bytes, 18);
  word = (word & ~((uint64_t{1} << 36) - 1)) | frames;
  putBig64(bytes, 18, word);
}

void setFlacStreamInfoRate(std::vector<unsigned char>* bytes, uint32_t rate) {
  expect(bytes->size() >= 26 &&
             std::memcmp(bytes->data(), "fLaC", 4) == 0 &&
             rate < (uint32_t{1} << 20),
         "FLAC STREAMINFO sample-rate fixture is valid");
  uint64_t word = readBig64(*bytes, 18);
  word = (word & ((uint64_t{1} << 44) - 1)) |
      (static_cast<uint64_t>(rate) << 44);
  putBig64(bytes, 18, word);
}

std::string writeExtensibleWav(const char* name, uint32_t formatSize,
                               bool validGuid) {
  expect(formatSize >= 26, "extensible fixture retains extension prefix");
  constexpr std::array<unsigned char, 16> pcmGuid{
      0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
      0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};
  const size_t dataHeader = 20 + formatSize + (formatSize & 1u);
  std::vector<unsigned char> bytes(dataHeader + 8 + 4, 0);
  std::memcpy(bytes.data(), "RIFF", 4);
  putLittle32(&bytes, 4, static_cast<uint32_t>(bytes.size() - 8));
  std::memcpy(bytes.data() + 8, "WAVEfmt ", 8);
  putLittle32(&bytes, 16, formatSize);
  const size_t format = 20;
  putLittle16(&bytes, format, 0xfffe);
  putLittle16(&bytes, format + 2, 2);
  putLittle32(&bytes, format + 4, 48000);
  putLittle32(&bytes, format + 8, 48000 * 4);
  putLittle16(&bytes, format + 12, 4);
  putLittle16(&bytes, format + 14, 16);
  putLittle16(&bytes, format + 16, 22);
  putLittle16(&bytes, format + 18, 16);
  if (formatSize >= 40) {
    std::memcpy(bytes.data() + format + 24, pcmGuid.data(), pcmGuid.size());
    if (!validGuid) bytes[format + 39] ^= 0xffu;
  }
  std::memcpy(bytes.data() + dataHeader, "data", 4);
  putLittle32(&bytes, dataHeader + 4, 4);
  putLittle16(&bytes, dataHeader + 8, 8192);
  putLittle16(&bytes, dataHeader + 10,
              static_cast<uint16_t>(static_cast<int16_t>(-8192)));
  const std::string path = scratch(name);
  writeBytes(path, bytes);
  return path;
}

std::string writeFloatWav(const char* name, float sample) {
  std::vector<unsigned char> bytes(48, 0);
  std::memcpy(bytes.data(), "RIFF", 4);
  putLittle32(&bytes, 4, 40);
  std::memcpy(bytes.data() + 8, "WAVEfmt ", 8);
  putLittle32(&bytes, 16, 16);
  putLittle16(&bytes, 20, 3);
  putLittle16(&bytes, 22, 1);
  putLittle32(&bytes, 24, 48000);
  putLittle32(&bytes, 28, 48000 * 4);
  putLittle16(&bytes, 32, 4);
  putLittle16(&bytes, 34, 32);
  std::memcpy(bytes.data() + 36, "data", 4);
  putLittle32(&bytes, 40, 4);
  std::memcpy(bytes.data() + 44, &sample, sizeof(sample));
  const std::string path = scratch(name);
  writeBytes(path, bytes);
  return path;
}

std::string writeMetadataOnlyFlac(const char* name) {
  constexpr uint32_t paddingBytes = 1u << 20;
  std::vector<unsigned char> bytes{
      'f', 'L', 'a', 'C', 0x00, 0x00, 0x00, 34};
  const size_t streamInfo = bytes.size();
  bytes.resize(bytes.size() + 34, 0);
  bytes[streamInfo] = 0x10;
  bytes[streamInfo + 2] = 0x10;
  const uint64_t rateChannelsBits =
      (uint64_t{48000} << 44) | (uint64_t{1} << 41) |
      (uint64_t{15} << 36);
  for (size_t byte = 0; byte < 8; ++byte)
    bytes[streamInfo + 10 + byte] = static_cast<unsigned char>(
        rateChannelsBits >> ((7 - byte) * 8));
  bytes.push_back(0x81);  // Last metadata block, PADDING.
  bytes.push_back(0x10);
  bytes.push_back(0x00);
  bytes.push_back(0x00);
  bytes.resize(bytes.size() + paddingBytes, 0);
  const std::string path = scratch(name);
  writeBytes(path, bytes);
  return path;
}

struct CancelAfter {
  uint32_t calls = 0;
  uint32_t limit = 0;
};

bool cancelAfter(void* opaque) noexcept {
  auto* state = static_cast<CancelAfter*>(opaque);
  return ++state->calls >= state->limit;
}

void decodeTests() {
  const std::vector<float> stereo{
      0.25f, -0.25f, 0.5f, -0.5f, -0.75f, 0.75f, 1.0f, -1.0f};
  const std::string wav = writeStereoWav("channels.wav", 48000, stereo);

  // Each preparation receives a separately opened descriptor by ownership
  // transfer. A second descriptor proves the decoder neither stores nor
  // closes unrelated authority owned by its caller.
  const int borrowed = openForDecode(wav);
  expect(borrowed >= 0, "independent descriptor opens");
  singz::OwnedFileDescriptor input(openForDecode(wav));
  expect(input.valid(), "owned descriptor opens");
  const int consumed = input.get();
  const DescriptorProbe consumedProbe = probeDescriptor(consumed);
  const DescriptorProbe borrowedProbe = probeDescriptor(borrowed);
  const singz::DecodedAudioResult decoded = singz::prepareDecodedAudio(
      std::move(input));
  expect(decoded.ok(), "stereo WAV descriptor decodes");
  expect(!input.valid(), "moved descriptor is empty");
  expect(!descriptorProbeIsOpen(consumedProbe), "consumed descriptor closes");
  expect(descriptorProbeIsOpen(borrowedProbe),
         "independent descriptor remains open");
  expect(decoded.audio->sampleRate() == 48000 &&
             decoded.audio->channelCount() == 2 &&
             decoded.audio->frameCount() == 4,
         "WAV shape is preserved");
  for (size_t frame = 0; frame < 4; ++frame) {
    expectNear(decoded.audio->channelData(0)[frame], pcm16(stereo[frame * 2]),
               0.0f, "WAV left channel is preserved");
    expectNear(decoded.audio->channelData(1)[frame],
               pcm16(stereo[frame * 2 + 1]), 0.0f,
               "WAV right channel is preserved");
  }
  closeTestDescriptor(borrowed);

  const int midDescriptor = openForDecode(wav);
  expect(midDescriptor >= 0 && seekTestDescriptor(midDescriptor, 19, SEEK_SET),
         "positioned descriptor seeks into source");
  const DescriptorProbe midProbe = probeDescriptor(midDescriptor);
  const singz::DecodedAudioResult decodedFromMiddle =
      singz::prepareDecodedAudio(singz::OwnedFileDescriptor(midDescriptor));
  expect(decodedFromMiddle.ok() && decodedFromMiddle.audio->frameCount() == 4,
         "descriptor position does not change WAV preparation");
  expect(!descriptorProbeIsOpen(midProbe),
         "positioned descriptor closes after decode");

  const std::vector<unsigned char> validWavBytes = readBytes(wav);
  expect(validWavBytes.size() == 60, "WAV extent fixture is conventional");
  std::vector<std::string> extentFixtures;
  auto tooLongBytes = validWavBytes;
  putLittle32(&tooLongBytes, 40, 20);
  extentFixtures.push_back(scratch("declared-too-long.wav"));
  writeBytes(extentFixtures.back(), tooLongBytes);
  const int tooLongDescriptor = openForDecode(extentFixtures.back());
  const DescriptorProbe tooLongProbe = probeDescriptor(tooLongDescriptor);
  const singz::DecodedAudioResult tooLong = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(tooLongDescriptor));
  expect(tooLong.status == singz::DecodedAudioStatus::MalformedData &&
             tooLong.audio == nullptr,
         "finite WAV extent cannot exceed available bytes");
  expect(!descriptorProbeIsOpen(tooLongProbe),
         "malformed WAV descriptor closes");

  auto unalignedBytes = validWavBytes;
  putLittle32(&unalignedBytes, 40, 15);
  extentFixtures.push_back(scratch("unaligned.wav"));
  writeBytes(extentFixtures.back(), unalignedBytes);
  const singz::DecodedAudioResult unaligned = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(extentFixtures.back())));
  expect(unaligned.status == singz::DecodedAudioStatus::MalformedData &&
             unaligned.audio == nullptr,
         "finite WAV extent must contain complete frames");

  auto streamingBytes = validWavBytes;
  putLittle32(&streamingBytes, 40, std::numeric_limits<uint32_t>::max());
  extentFixtures.push_back(scratch("streaming-size.wav"));
  writeBytes(extentFixtures.back(), streamingBytes);
  const singz::DecodedAudioResult streaming = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(extentFixtures.back())));
  expect(streaming.status == singz::DecodedAudioStatus::UnsupportedFormat &&
             streaming.audio == nullptr,
         "WAV streaming sentinel is rejected without RF64 extent parsing");

  auto streamingRiffBytes = validWavBytes;
  putLittle32(&streamingRiffBytes, 4,
              std::numeric_limits<uint32_t>::max());
  extentFixtures.push_back(scratch("streaming-riff-size.wav"));
  writeBytes(extentFixtures.back(), streamingRiffBytes);
  const singz::DecodedAudioResult streamingRiff = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(extentFixtures.back())));
  expect(streamingRiff.status == singz::DecodedAudioStatus::UnsupportedFormat &&
             streamingRiff.audio == nullptr,
         "RIFF size sentinel is rejected without RF64 ds64 parsing");

  auto largeRiffBytes = validWavBytes;
  putLittle32(&largeRiffBytes, 4, 1000);
  extentFixtures.push_back(scratch("riff-too-large.wav"));
  writeBytes(extentFixtures.back(), largeRiffBytes);
  const singz::DecodedAudioResult largeRiff = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(extentFixtures.back())));
  expect(largeRiff.status == singz::DecodedAudioStatus::MalformedData &&
             largeRiff.audio == nullptr,
         "RIFF container cannot exceed the physical file");

  auto tinyRiffBytes = validWavBytes;
  putLittle32(&tinyRiffBytes, 4, 3);
  extentFixtures.push_back(scratch("riff-too-small.wav"));
  writeBytes(extentFixtures.back(), tinyRiffBytes);
  const singz::DecodedAudioResult tinyRiff = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(extentFixtures.back())));
  expect(tinyRiff.status == singz::DecodedAudioStatus::MalformedData &&
             tinyRiff.audio == nullptr,
         "RIFF container must include the WAVE form payload");

  auto crossingFormatBytes = validWavBytes;
  putLittle32(&crossingFormatBytes, 4, 20);
  extentFixtures.push_back(scratch("riff-crossing-fmt.wav"));
  writeBytes(extentFixtures.back(), crossingFormatBytes);
  const singz::DecodedAudioResult crossingFormat = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(extentFixtures.back())));
  expect(crossingFormat.status == singz::DecodedAudioStatus::MalformedData &&
             crossingFormat.audio == nullptr,
         "fmt payload cannot borrow physical bytes beyond RIFF end");

  auto crossingDataBytes = validWavBytes;
  putLittle32(&crossingDataBytes, 4, 44);
  extentFixtures.push_back(scratch("riff-crossing-data.wav"));
  writeBytes(extentFixtures.back(), crossingDataBytes);
  const singz::DecodedAudioResult crossingData = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(extentFixtures.back())));
  expect(crossingData.status == singz::DecodedAudioStatus::MalformedData &&
             crossingData.audio == nullptr,
         "data payload cannot borrow physical bytes beyond RIFF end");

  const std::string extensible = writeExtensibleWav(
      "extensible.wav", 40, true);
  const singz::DecodedAudioResult decodedExtensible =
      singz::prepareDecodedAudio(
          singz::OwnedFileDescriptor(openForDecode(extensible)));
  expect(decodedExtensible.ok() &&
             decodedExtensible.audio->channelCount() == 2 &&
             decodedExtensible.audio->frameCount() == 1,
         "canonical extensible PCM decodes");
  expectNear(decodedExtensible.audio->channelData(0)[0], 0.25f, 0.0f,
             "extensible PCM left sample is preserved");
  expectNear(decodedExtensible.audio->channelData(1)[0], -0.25f, 0.0f,
             "extensible PCM right sample is preserved");

  const std::string shortExtensible = writeExtensibleWav(
      "short-extensible.wav", 26, true);
  const singz::DecodedAudioResult decodedShortExtensible =
      singz::prepareDecodedAudio(
          singz::OwnedFileDescriptor(openForDecode(shortExtensible)));
  expect(decodedShortExtensible.status ==
             singz::DecodedAudioStatus::MalformedData &&
             decodedShortExtensible.audio == nullptr,
         "prefix-only extensible format is malformed");

  const std::string badGuidExtensible = writeExtensibleWav(
      "bad-guid-extensible.wav", 40, false);
  const singz::DecodedAudioResult decodedBadGuid = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(badGuidExtensible)));
  expect(decodedBadGuid.status == singz::DecodedAudioStatus::UnsupportedFormat &&
             decodedBadGuid.audio == nullptr,
         "unknown extensible subtype GUID is unsupported");

  auto mismatchedValidBitsBytes = readBytes(extensible);
  putLittle16(&mismatchedValidBitsBytes, 38, 12);
  extentFixtures.push_back(scratch("extensible-valid-bits-mismatch.wav"));
  writeBytes(extentFixtures.back(), mismatchedValidBitsBytes);
  const singz::DecodedAudioResult mismatchedValidBits =
      singz::prepareDecodedAudio(singz::OwnedFileDescriptor(
          openForDecode(extentFixtures.back())));
  expect(mismatchedValidBits.status ==
             singz::DecodedAudioStatus::UnsupportedFormat &&
             mismatchedValidBits.audio == nullptr,
         "reduced valid-bit extensible PCM is rejected explicitly");

  const std::string flacWav = writeStereoWav("channels-flac.wav", 48000, stereo);
  const std::string flac = scratch("channels.flac");
  std::remove(flac.c_str());
  const singz::CompactResult compacted = singz::compactStem(flacWav, flac);
  expect(compacted.ok, "FLAC fixture compacts");
  const int flacDescriptor = openForDecode(flac);
  expect(flacDescriptor >= 0, "FLAC descriptor opens");
  const DescriptorProbe flacProbe = probeDescriptor(flacDescriptor);
  const singz::DecodedAudioResult decodedFlac = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(flacDescriptor));
  expect(decodedFlac.ok(), "stereo FLAC descriptor decodes");
  expect(!descriptorProbeIsOpen(flacProbe),
         "consumed FLAC descriptor closes");
  expect(decodedFlac.audio->sampleRate() == 48000 &&
             decodedFlac.audio->channelCount() == 2 &&
             decodedFlac.audio->frameCount() == 4,
         "FLAC shape is preserved");
  for (size_t frame = 0; frame < 4; ++frame) {
    expectNear(decodedFlac.audio->channelData(0)[frame],
               pcm16(stereo[frame * 2]), 0.0f,
               "FLAC left channel is preserved");
    expectNear(decodedFlac.audio->channelData(1)[frame],
               pcm16(stereo[frame * 2 + 1]), 0.0f,
               "FLAC right channel is preserved");
  }

  const std::vector<unsigned char> validFlacBytes = readBytes(flac);
  std::vector<std::string> flacIntegrityFixtures;
  auto shorterDeclarationBytes = validFlacBytes;
  setFlacTotalSamples(&shorterDeclarationBytes, 5);
  flacIntegrityFixtures.push_back(scratch("flac-shorter-than-declared.flac"));
  writeBytes(flacIntegrityFixtures.back(), shorterDeclarationBytes);
  const singz::DecodedAudioResult shorterDeclaration =
      singz::prepareDecodedAudio(singz::OwnedFileDescriptor(
          openForDecode(flacIntegrityFixtures.back())));
  expect(shorterDeclaration.status == singz::DecodedAudioStatus::MalformedData &&
             shorterDeclaration.audio == nullptr,
         "FLAC must reach a nonzero declared total exactly");

  auto longerDeclarationBytes = validFlacBytes;
  setFlacTotalSamples(&longerDeclarationBytes, 3);
  flacIntegrityFixtures.push_back(scratch("flac-longer-than-declared.flac"));
  writeBytes(flacIntegrityFixtures.back(), longerDeclarationBytes);
  const singz::DecodedAudioResult longerDeclaration =
      singz::prepareDecodedAudio(singz::OwnedFileDescriptor(
          openForDecode(flacIntegrityFixtures.back())));
  expect(longerDeclaration.status == singz::DecodedAudioStatus::MalformedData &&
             longerDeclaration.audio == nullptr,
         "FLAC frame cannot exceed a nonzero declared total");

  auto mismatchedRateBytes = validFlacBytes;
  setFlacStreamInfoRate(&mismatchedRateBytes, 44100);
  flacIntegrityFixtures.push_back(scratch("flac-rate-mismatch.flac"));
  writeBytes(flacIntegrityFixtures.back(), mismatchedRateBytes);
  const singz::DecodedAudioResult mismatchedRate =
      singz::prepareDecodedAudio(singz::OwnedFileDescriptor(
          openForDecode(flacIntegrityFixtures.back())));
  expect(mismatchedRate.status == singz::DecodedAudioStatus::MalformedData &&
             mismatchedRate.audio == nullptr,
         "FLAC frame rate must match STREAMINFO");

  const int eofDescriptor = openForDecode(flac);
  expect(eofDescriptor >= 0 && seekTestDescriptor(eofDescriptor, 0, SEEK_END),
         "positioned descriptor seeks to source end");
  const DescriptorProbe eofProbe = probeDescriptor(eofDescriptor);
  const singz::DecodedAudioResult decodedFromEof =
      singz::prepareDecodedAudio(singz::OwnedFileDescriptor(eofDescriptor));
  expect(decodedFromEof.ok() && decodedFromEof.audio->frameCount() == 4,
         "descriptor EOF position does not change FLAC preparation");
  expect(!descriptorProbeIsOpen(eofProbe),
         "EOF-positioned descriptor closes after decode");

  std::vector<float> longStereo(24000 * 2);
  for (size_t frame = 0; frame < longStereo.size() / 2; ++frame) {
    longStereo[frame * 2] = static_cast<float>(frame % 101) / 101.0f;
    longStereo[frame * 2 + 1] = -longStereo[frame * 2];
  }
  const std::string cancellable = writeStereoWav(
      "cancel.wav", 48000, longStereo);
  const std::string outputGrowthWav = writeStereoWav(
      "output-growth.wav", 48000, longStereo);
  // Calls 4 and 5 grow/convert two 4096-frame planar chunks; call 6 cancels
  // before the third, proving large WAV initialization is sliced atomically.
  CancelAfter cancel{0, 6};
  const int cancelDescriptor = openForDecode(cancellable);
  const DescriptorProbe cancelProbe = probeDescriptor(cancelDescriptor);
  const singz::DecodedAudioResult cancelled = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(cancelDescriptor), {}, {&cancel, cancelAfter});
  expect(cancelled.status == singz::DecodedAudioStatus::Cancelled &&
             cancelled.audio == nullptr && cancel.calls == 6,
         "chunk-cancelled WAV decode publishes no partial planar storage");
  expect(!descriptorProbeIsOpen(cancelProbe), "cancelled descriptor closes");

  const std::string cancelFlac = scratch("cancel.flac");
  std::remove(cancelFlac.c_str());
  expect(singz::compactStem(cancellable, cancelFlac).ok,
         "cancellable FLAC fixture compacts");
  CancelAfter cancelFlacState{0, 3};
  const int cancelFlacDescriptor = openForDecode(cancelFlac);
  const DescriptorProbe cancelFlacProbe = probeDescriptor(cancelFlacDescriptor);
  const singz::DecodedAudioResult cancelledFlac = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(cancelFlacDescriptor), {},
      {&cancelFlacState, cancelAfter});
  expect(cancelledFlac.status == singz::DecodedAudioStatus::Cancelled &&
             cancelledFlac.audio == nullptr,
         "cancelled FLAC decode publishes no partial audio");
  expect(!descriptorProbeIsOpen(cancelFlacProbe),
         "cancelled FLAC descriptor closes");

  const std::string metadataFlac = writeMetadataOnlyFlac("metadata-only.flac");
  CancelAfter metadataCancel{0, 4};
  const int metadataDescriptor = openForDecode(metadataFlac);
  const DescriptorProbe metadataProbe = probeDescriptor(metadataDescriptor);
  const singz::DecodedAudioResult cancelledMetadata =
      singz::prepareDecodedAudio(
          singz::OwnedFileDescriptor(metadataDescriptor), {},
          {&metadataCancel, cancelAfter});
  expect(cancelledMetadata.status == singz::DecodedAudioStatus::Cancelled &&
             cancelledMetadata.audio == nullptr && metadataCancel.calls >= 4,
         "FLAC read cancellation aborts a large no-frame metadata stream");
  expect(!descriptorProbeIsOpen(metadataProbe),
         "metadata-cancelled FLAC descriptor closes");

  auto declaredMetadataBytes = readBytes(metadataFlac);
  setFlacTotalSamples(&declaredMetadataBytes, 4);
  const std::string declaredMetadataFlac = scratch(
      "metadata-nonzero-total.flac");
  writeBytes(declaredMetadataFlac, declaredMetadataBytes);
  const singz::DecodedAudioResult declaredMetadata =
      singz::prepareDecodedAudio(singz::OwnedFileDescriptor(
          openForDecode(declaredMetadataFlac)));
  expect(declaredMetadata.status == singz::DecodedAudioStatus::MalformedData &&
             declaredMetadata.audio == nullptr,
         "metadata-only FLAC cannot satisfy a nonzero declared total");

  const std::string malformed = scratch("malformed.bin");
  writeBytes(malformed, {'R', 'I', 'F', 'F', 1, 2, 3, 4, 'N', 'O', 'P', 'E'});
  const int malformedDescriptor = openForDecode(malformed);
  const DescriptorProbe malformedProbe = probeDescriptor(malformedDescriptor);
  const singz::DecodedAudioResult malformedResult = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(malformedDescriptor));
  expect(malformedResult.status == singz::DecodedAudioStatus::MalformedData &&
             malformedResult.audio == nullptr,
         "malformed RIFF fails without publication");
  expect(!descriptorProbeIsOpen(malformedProbe),
         "malformed descriptor closes without publication");

  const std::string unsupported = scratch("unsupported.bin");
  writeBytes(unsupported, {'O', 'g', 'g', 'S', 1, 2, 3, 4});
  const singz::DecodedAudioResult unsupportedResult = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(unsupported)));
  const auto codecCapabilities = singz::decodedAudioCodecCapabilities();
  const auto expectedOggStatus = singz::decodedAudioFormatSupported(
      singz::DecodedAudioSourceFormat::Ogg)
      ? singz::DecodedAudioStatus::MalformedData
      : singz::DecodedAudioStatus::UnsupportedFormat;
  expect(unsupportedResult.status == expectedOggStatus &&
             unsupportedResult.audio == nullptr,
         "truncated Ogg fails without publication or false support");

  singz::DecodedAudioPrepareOptions bounded;
  bounded.maximumDecodedBytes = 4;
  const singz::DecodedAudioResult overLimit = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(wav)), bounded);
  expect(overLimit.status == singz::DecodedAudioStatus::LimitExceeded &&
             overLimit.audio == nullptr,
         "decode byte bound is enforced before publication");
  singz::DecodedAudioPrepareOptions encodedBound;
  encodedBound.maximumEncodedBytes = 8;
  const int encodedBoundDescriptor = openForDecode(wav);
  const DescriptorProbe encodedBoundProbe =
      probeDescriptor(encodedBoundDescriptor);
  const singz::DecodedAudioResult encodedOverLimit =
      singz::prepareDecodedAudio(
          singz::OwnedFileDescriptor(encodedBoundDescriptor), encodedBound);
  expect(encodedOverLimit.status == singz::DecodedAudioStatus::LimitExceeded &&
             encodedOverLimit.audio == nullptr &&
             !descriptorProbeIsOpen(encodedBoundProbe),
         "encoded input bound rejects before parsing and closes authority");
  const singz::DecodedAudioResult invalid = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(-1));
  expect(invalid.status == singz::DecodedAudioStatus::InvalidArgument &&
             invalid.audio == nullptr,
         "invalid descriptor fails cleanly");
  singz::DecodedAudioPrepareOptions invalidOptions;
  invalidOptions.maximumChannels = 0;
  const int invalidOptionsDescriptor = openForDecode(wav);
  const DescriptorProbe invalidOptionsProbe =
      probeDescriptor(invalidOptionsDescriptor);
  const singz::DecodedAudioResult invalidOptionsResult =
      singz::prepareDecodedAudio(
          singz::OwnedFileDescriptor(invalidOptionsDescriptor), invalidOptions);
  expect(invalidOptionsResult.status == singz::DecodedAudioStatus::InvalidArgument &&
             invalidOptionsResult.audio == nullptr,
         "invalid options fail without publication");
  expect(!descriptorProbeIsOpen(invalidOptionsProbe),
         "invalid-options descriptor closes");
  singz::DecodedAudioPrepareOptions raisedPollBudget;
  raisedPollBudget.maximumResampleOperationsPerPoll = (uint64_t{1} << 18) + 1;
  const singz::DecodedAudioResult raisedPollBudgetResult =
      singz::prepareDecodedAudio(
          singz::OwnedFileDescriptor(openForDecode(wav)), raisedPollBudget);
  expect(raisedPollBudgetResult.status ==
             singz::DecodedAudioStatus::InvalidArgument &&
             raisedPollBudgetResult.audio == nullptr,
         "per-poll resample budget cannot exceed implementation cap");

  const int replaced = openForDecode(wav);
  const int replacement = openForDecode(wav);
  const DescriptorProbe replacedProbe = probeDescriptor(replaced);
  const DescriptorProbe replacementProbe = probeDescriptor(replacement);
  expect(replaced >= 0 && replacement >= 0, "move-assignment fixtures open");
  {
    singz::OwnedFileDescriptor owner(replaced);
    owner = singz::OwnedFileDescriptor(replacement);
    expect(!descriptorProbeIsOpen(replacedProbe) &&
               descriptorProbeIsOpen(replacementProbe),
           "descriptor move assignment closes replaced ownership");
  }
  expect(!descriptorProbeIsOpen(replacementProbe),
         "descriptor destruction closes current ownership");

  std::vector<float> resampleInput(480 * 2);
  for (size_t frame = 0; frame < 480; ++frame) {
    const float sample = static_cast<float>(0.4 * std::sin(
        2.0 * 3.14159265358979323846 * 1000.0 * frame / 48000.0));
    resampleInput[frame * 2] = sample;
    resampleInput[frame * 2 + 1] = -sample;
  }
  const std::string resampleWav = writeStereoWav(
      "resample.wav", 48000, resampleInput);
  singz::DecodedAudioPrepareOptions resampleOptions;
  resampleOptions.requiredSampleRate = 44100;
  const singz::DecodedAudioResult resampled = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(resampleWav)), resampleOptions);
  expect(resampled.ok() && resampled.audio->sampleRate() == 44100 &&
             resampled.audio->frameCount() == 441,
         "resample publishes exact rounded duration");
  for (uint64_t frame = 0; frame < resampled.audio->frameCount(); ++frame)
    expectNear(resampled.audio->channelData(0)[frame] +
                   resampled.audio->channelData(1)[frame],
               0.0f, 1.0e-7f,
               "multichannel resample keeps opposite phase locked");

  // The long fixture reaches planar output materialization in six chunks.
  // Calls 19 and 20 complete two chunks; call 21 cancels before the third so
  // destination zero-initialization cannot become an unbounded gap.
  CancelAfter outputGrowthCancel{0, 21};
  const singz::DecodedAudioResult cancelledOutputGrowth =
      singz::prepareDecodedAudio(
          singz::OwnedFileDescriptor(openForDecode(outputGrowthWav)),
          resampleOptions, {&outputGrowthCancel, cancelAfter});
  expect(cancelledOutputGrowth.status == singz::DecodedAudioStatus::Cancelled &&
             cancelledOutputGrowth.audio == nullptr &&
             outputGrowthCancel.calls == 21,
         "resampled planar growth cancels between bounded output chunks");

  singz::DecodedAudioPrepareOptions workBound = resampleOptions;
  workBound.maximumWorkingBytes = 4096;
  const singz::DecodedAudioResult overWorkingBound =
      singz::prepareDecodedAudio(
          singz::OwnedFileDescriptor(openForDecode(resampleWav)), workBound);
  expect(overWorkingBound.status == singz::DecodedAudioStatus::LimitExceeded &&
             overWorkingBound.audio == nullptr,
         "resample peak float-payload budget is enforced");

  singz::DecodedAudioPrepareOptions operationBound = resampleOptions;
  operationBound.maximumResampleOperations = 1;
  const singz::DecodedAudioResult overOperationBound =
      singz::prepareDecodedAudio(
          singz::OwnedFileDescriptor(openForDecode(resampleWav)), operationBound);
  expect(overOperationBound.status == singz::DecodedAudioStatus::LimitExceeded &&
             overOperationBound.audio == nullptr,
         "resample operation budget is enforced before construction");

  const std::string extremeRatio = writeStereoWav(
      "extreme-ratio.wav", 767999, {0.1f, -0.1f});
  singz::DecodedAudioPrepareOptions extremeOptions;
  extremeOptions.requiredSampleRate = 768000;
  const singz::DecodedAudioResult extreme = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(extremeRatio)), extremeOptions);
  expect(extreme.status == singz::DecodedAudioStatus::LimitExceeded &&
             extreme.audio == nullptr,
         "extreme co-prime rate ratio is rejected before filter construction");

  std::vector<float> manyChannels(64, 0.125f);
  const std::string pathologicalUpsample = writeWav(
      "pathological-upsample.wav", 8000, 64, manyChannels);
  singz::DecodedAudioPrepareOptions pathologicalOptions;
  pathologicalOptions.requiredSampleRate = 768000;
  CancelAfter pathologicalPolls{0, 100};
  const singz::DecodedAudioResult rejectedUpsample =
      singz::prepareDecodedAudio(
          singz::OwnedFileDescriptor(openForDecode(pathologicalUpsample)),
          pathologicalOptions, {&pathologicalPolls, cancelAfter});
  expect(rejectedUpsample.status == singz::DecodedAudioStatus::LimitExceeded &&
             rejectedUpsample.audio == nullptr && pathologicalPolls.calls == 6,
         "first-call history rejects pathological upsample before construction");

  constexpr uint64_t pollBudget = uint64_t{1} << 18;
  constexpr uint64_t boundaryTaps = 65;
  constexpr uint64_t boundaryChannels = 64;
  constexpr uint64_t boundarySlice = 62;
  constexpr uint64_t workPerOutput = boundaryTaps * boundaryChannels;
  constexpr uint64_t firstOutputFrames =
      ((boundaryTaps - 1 + boundarySlice) + 1) / 2;
  constexpr uint64_t laterOutputFrames = (boundarySlice + 1) / 2;
  expect(workPerOutput == 4160 && firstOutputFrames == 63 &&
             firstOutputFrames * workPerOutput == 262080 &&
             firstOutputFrames * workPerOutput <= pollBudget &&
             laterOutputFrames * workPerOutput <= pollBudget &&
             boundarySlice * boundaryTaps * boundaryChannels == 257920 &&
             boundarySlice * boundaryTaps * boundaryChannels <= pollBudget,
         "96k->48k boundary arithmetic fits every per-poll work bound");

  const std::string cancellableBoundary = writeWav(
      "cancel-boundary.wav", 96000, 64, manyChannels);
  singz::DecodedAudioPrepareOptions boundaryOptions;
  boundaryOptions.requiredSampleRate = 48000;
  expect(boundaryOptions.maximumResampleOperationsPerPoll == pollBudget,
         "default per-poll resample budget is explicit");
  const singz::DecodedAudioResult completedBoundary =
      singz::prepareDecodedAudio(
          singz::OwnedFileDescriptor(openForDecode(cancellableBoundary)),
          boundaryOptions);
  expect(completedBoundary.ok() &&
             completedBoundary.audio->channelCount() == 64 &&
             completedBoundary.audio->frameCount() == 1,
         "supported boundary multichannel tail publishes exact duration");

  // The 65-frame zero tail is partitioned 62+3. Compare that completed path
  // bit-for-bit with the legacy one-shot flush contract.
  singz::Resampler referenceBoundary(96000, 48000, 64);
  std::vector<float> referenceOutput;
  referenceBoundary.process(manyChannels.data(), 1, referenceOutput);
  referenceBoundary.flush(referenceOutput);
  const uint64_t referenceLatency = static_cast<uint64_t>(
      referenceBoundary.latencyOutFrames());
  expect(referenceOutput.size() / 64 >= referenceLatency + 1,
         "reference boundary tail covers compensated output");
  for (uint32_t channel = 0; channel < 64; ++channel) {
    const float expected = referenceOutput[static_cast<size_t>(
        referenceLatency * 64 + channel)];
    expectNear(completedBoundary.audio->channelData(channel)[0], expected, 0.0f,
               "sliced boundary tail is bit-exact with one-shot flush");
  }

  // Calls 1-6 cover entry, WAV decode and resample setup. Call 7 completes
  // the sole source process, call 8 completes the first bounded tail process,
  // and call 9 cancels before the second. This is non-vacuous tail evidence.
  CancelAfter boundaryCancel{0, 9};
  const singz::DecodedAudioResult cancelledBoundary =
      singz::prepareDecodedAudio(
          singz::OwnedFileDescriptor(openForDecode(cancellableBoundary)),
          boundaryOptions, {&boundaryCancel, cancelAfter});
  expect(cancelledBoundary.status == singz::DecodedAudioStatus::Cancelled &&
             cancelledBoundary.audio == nullptr && boundaryCancel.calls == 9,
         "boundary resample cancels after source and tail process slices");

  const std::string zeroWav = writeStereoWav("zero.wav", 48000, {});
  const singz::DecodedAudioResult zero = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(zeroWav)));
  expect(zero.ok() && zero.audio->frameCount() == 0 &&
             zero.audio->sampleRate() == 48000,
         "zero-frame WAV publishes at native rate");
  const singz::DecodedAudioResult zeroResampled = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(zeroWav)), resampleOptions);
  expect(zeroResampled.ok() && zeroResampled.audio->frameCount() == 0 &&
             zeroResampled.audio->sampleRate() == 44100,
         "zero-frame WAV adopts required rate without constructing resampler");

  const std::string nanWav = writeFloatWav(
      "nan.wav", std::numeric_limits<float>::quiet_NaN());
  const std::string infinityWav = writeFloatWav(
      "infinity.wav", std::numeric_limits<float>::infinity());
  for (const std::string* path : {&nanWav, &infinityWav}) {
    const singz::DecodedAudioResult nonFinite = singz::prepareDecodedAudio(
        singz::OwnedFileDescriptor(openForDecode(*path)));
    expect(nonFinite.status == singz::DecodedAudioStatus::MalformedData &&
               nonFinite.audio == nullptr,
           "non-finite float WAV samples are rejected before publication");
  }

  const std::string shortWav = writeStereoWav(
      "short.wav", 48000, {0.1f, -0.1f, 0.2f, -0.2f});
  const singz::DecodedAudioResult shorter = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(shortWav)));
  expect(shorter.ok() && shorter.audio->frameCount() == 2 &&
             decoded.audio->frameCount() == 4,
         "independent lanes preserve unequal lengths");

  const char* expectedCapabilityTag = codecCapabilities.completeProductMatrix
      ? "singz-prepared-audio-fd-ffmpeg-full-matrix-v3"
      : (codecCapabilities.dynamicallyLinkedFfmpeg
             ? "singz-prepared-audio-fd-ffmpeg-partial-runtime-v2"
             : "singz-prepared-audio-fd-wav-flac-v1");
  expect(std::strcmp(singz::decodedAudioCapabilityTag(),
                     expectedCapabilityTag) == 0,
         "prepared-audio capability tag is durable");
  expect(singz::decodedAudioFormatForExtension(".MP3") ==
             singz::DecodedAudioSourceFormat::Mp3 &&
             singz::decodedAudioFormatForExtension(".oga") ==
                 singz::DecodedAudioSourceFormat::Ogg &&
             singz::decodedAudioFormatForExtension(".aiff") ==
                 singz::DecodedAudioSourceFormat::Aiff,
         "codec extensions map case-insensitively through the allowlist");
  expect(singz::decodedAudioFormatForExtension("file.mp3") ==
             singz::DecodedAudioSourceFormat::Auto &&
             singz::decodedAudioFormatForExtension(".http://device") ==
                 singz::DecodedAudioSourceFormat::Auto &&
             singz::decodedAudioFormatForExtension(".\\\\server") ==
                 singz::DecodedAudioSourceFormat::Auto,
         "extension mapping rejects paths, protocols and device spellings");
  expect((codecCapabilities.formatMask &
          (singz::DecodedAudioCapabilityWav |
           singz::DecodedAudioCapabilityFlac)) ==
             (singz::DecodedAudioCapabilityWav |
              singz::DecodedAudioCapabilityFlac),
         "always-built codec capabilities report WAV and FLAC");

  std::remove(wav.c_str());
  std::remove(extensible.c_str());
  std::remove(shortExtensible.c_str());
  std::remove(badGuidExtensible.c_str());
  std::remove(flacWav.c_str());
  std::remove(flac.c_str());
  std::remove(cancellable.c_str());
  std::remove(outputGrowthWav.c_str());
  std::remove(cancelFlac.c_str());
  std::remove(metadataFlac.c_str());
  std::remove(declaredMetadataFlac.c_str());
  std::remove(malformed.c_str());
  std::remove(unsupported.c_str());
  std::remove(resampleWav.c_str());
  std::remove(extremeRatio.c_str());
  std::remove(pathologicalUpsample.c_str());
  std::remove(cancellableBoundary.c_str());
  std::remove(zeroWav.c_str());
  std::remove(nanWav.c_str());
  std::remove(infinityWav.c_str());
  std::remove(shortWav.c_str());
  for (const auto& path : extentFixtures) std::remove(path.c_str());
  for (const auto& path : flacIntegrityFixtures) std::remove(path.c_str());
}

struct SourceHarness {
  struct Position {
    int64_t entryProjectTimeSamples;
    uint64_t sourceStartFrame;
  };

  alignas(std::max_align_t) std::array<unsigned char, 1024> state{};
  zdsp::ProcessorHandle processor{};
  zdsp::AudioBusDescriptor bus{};

  SourceHarness(zdsp::NodeId node, const float* const* channels,
                uint32_t channelCount, uint64_t frames,
                double sampleRate = 48000.0) {
    initialize(node, channels, channelCount, frames, {0, 0}, false, sampleRate);
  }

  SourceHarness(zdsp::NodeId node, const float* const* channels,
                uint32_t channelCount, uint64_t frames, Position position,
                double sampleRate = 48000.0) {
    initialize(node, channels, channelCount, frames, position, true,
               sampleRate);
  }

  void initialize(zdsp::NodeId node, const float* const* channels,
                  uint32_t channelCount, uint64_t frames, Position position,
                  bool positioned, double sampleRate) {
    bus = {channelCount, zdsp::SampleFormat::Float32Planar,
           channelCount == 1 ? zdsp::AudioChannelLayout::Mono
                             : zdsp::AudioChannelLayout::Stereo,
           nullptr};
    expect(zdsp::decodedBufferSourceStateBytes() <= state.size(),
           "source state fits harness");
    const zdsp::DecodedBufferView buffer{
        channels, channelCount, frames, {sampleRate}};
    processor = positioned
                    ? zdsp::createPositionedDecodedBufferSource(
                          {node, buffer, position.entryProjectTimeSamples,
                           position.sourceStartFrame},
                          {state.data(), static_cast<uint32_t>(state.size())})
                    : zdsp::createDecodedBufferSource(
                          {node, buffer},
                          {state.data(), static_cast<uint32_t>(state.size())});
    expect(processor.state != nullptr, "decoded source constructs");
    const zdsp::PrepareSpec spec{
        zdsp::kProcessorInterfaceVersion, zdsp::kPrepareSpecV1RequiredSize,
        {sampleRate}, {64}, 0, 1, nullptr, &bus};
    const zdsp::PreparedStorage prepared{nullptr, 0, 1};
    expect(zdsp::succeeded(processor.functions->prepare(
               processor.state, &spec, &prepared)),
           "decoded source prepares");
    expect(zdsp::decodedBufferSourceCursor(processor) ==
               position.sourceStartFrame,
           "decoded source cursor starts at its prepared frame");
  }

  ~SourceHarness() {
    if (processor.state == nullptr) return;
    expect(zdsp::succeeded(processor.functions->deactivate(processor.state)),
           "decoded source deactivates");
    expect(zdsp::succeeded(zdsp::destroyProcessor(&processor)),
           "decoded source destroys");
  }

  void reset(zdsp::DiscontinuityReason reason) {
    processor.functions->reset(processor.state,
        {reason, zdsp::DiscontinuityFlagResetState});
  }

  void render(uint32_t frames, float* const* output,
              uint32_t flags = zdsp::ProcessContextFlagNone,
              const zdsp::TransportContext* transport = nullptr) {
    zdsp::ProcessContext context{
        zdsp::kProcessContextInterfaceVersion,
        zdsp::kProcessContextV2RequiredSize,
        {{1}, {1}, {0}, {0}, {0}, zdsp::RenderTimeNone},
        transport, {48000.0}, {frames}, nullptr, 0, nullptr, 0,
        {nullptr, 0},
        {zdsp::DiscontinuityReason::None, zdsp::DiscontinuityFlagNone}, flags};
    zdsp::MutableAudioBusView outputBus{
        output, bus.channelCount, {frames}, {frames}};
    processor.functions->process(processor.state, &context, nullptr, 0,
                                 &outputBus, 1);
  }
};

struct CursorInterference {
  SourceHarness* source{nullptr};
  std::array<float, 1> output{};
};

struct CueHarness {
  alignas(std::max_align_t) std::array<unsigned char, 1024> state{};
  zdsp::ProcessorHandle processor{};
  zdsp::AudioBusDescriptor bus{
      1, zdsp::SampleFormat::Float32Planar,
      zdsp::AudioChannelLayout::Mono, nullptr};
  double sampleRate{48000.0};
  uint32_t maximumBlockFrames{64};

  explicit CueHarness(const zdsp::ScheduledCueSourceConfig& config,
                      uint32_t maximumFrames = 64)
      : sampleRate(config.sampleRate.value),
        maximumBlockFrames(maximumFrames) {
    expect(zdsp::scheduledCueSourceStateBytes() <= state.size(),
           "scheduled cue state fits harness");
    processor = zdsp::createScheduledCueSource(
        config, {state.data(), static_cast<uint32_t>(state.size())});
    expect(processor.state != nullptr, "scheduled cue source constructs");
    const zdsp::PrepareSpec spec{
        zdsp::kProcessorInterfaceVersion, zdsp::kPrepareSpecV1RequiredSize,
        {sampleRate}, {maximumBlockFrames}, 0, 1, nullptr, &bus};
    const zdsp::PreparedStorage prepared{nullptr, 0, 1};
    expect(zdsp::succeeded(processor.functions->prepare(
               processor.state, &spec, &prepared)),
           "scheduled cue source prepares");
  }

  ~CueHarness() {
    if (processor.state == nullptr) return;
    expect(zdsp::succeeded(processor.functions->deactivate(processor.state)),
           "scheduled cue source deactivates");
    expect(zdsp::succeeded(zdsp::destroyProcessor(&processor)),
           "scheduled cue source destroys");
  }

  void render(uint32_t frames, float* output,
              const zdsp::TransportContext* transport,
              uint32_t flags = zdsp::ProcessContextFlagNone) {
    zdsp::ProcessContext context{
        zdsp::kProcessContextInterfaceVersion,
        zdsp::kProcessContextV2RequiredSize,
        {{1}, {1}, {0}, {0}, {0}, zdsp::RenderTimeNone},
        transport, {sampleRate}, {frames}, nullptr, 0, nullptr, 0,
        {nullptr, 0},
        {zdsp::DiscontinuityReason::None, zdsp::DiscontinuityFlagNone}, flags};
    float* channels[]{output};
    const zdsp::MutableAudioBusView outputBus{
        channels, 1, {frames}, {frames}};
    processor.functions->process(processor.state, &context, nullptr, 0,
                                 &outputBus, 1);
  }
};

void publishBetweenCursorWords(void* opaque, uint32_t) noexcept {
  auto* interference = static_cast<CursorInterference*>(opaque);
  float* channels[]{interference->output.data()};
  interference->source->render(1, channels);
}

void sourceTests() {
  const std::array<float, 5> left{1, 2, 3, 4, 5};
  const std::array<float, 5> right{-1, -2, -3, -4, -5};
  const float* channels[]{left.data(), right.data()};
  const float* positive[]{left.data()};
  const float* negative[]{right.data()};
  SourceHarness source({1}, channels, 2, left.size());

  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  source.render(0, nullptr);
  zdsp::test::setAllocationTrapEnabled(false);
  expect(zdsp::test::trappedAllocationCount() == 0,
         "zero-frame source flush accepts no channel storage");

  std::vector<float> renderedLeft;
  std::vector<float> renderedRight;
  for (const uint32_t frames : {2u, 1u, 4u}) {
    std::array<float, 4> blockLeft{99, 99, 99, 99};
    std::array<float, 4> blockRight{99, 99, 99, 99};
    float* output[]{blockLeft.data(), blockRight.data()};
    zdsp::test::resetAllocationTrap();
    zdsp::test::setAllocationTrapEnabled(true);
    source.render(frames, output);
    zdsp::test::setAllocationTrapEnabled(false);
    expect(zdsp::test::trappedAllocationCount() == 0,
           "decoded source render allocates nothing");
    expect(zdsp::decodedBufferSourceCursor(source.processor) ==
               std::min<uint64_t>(left.size(), renderedLeft.size() + frames),
           "decoded source cursor publishes a non-torn block boundary");
    renderedLeft.insert(renderedLeft.end(), blockLeft.begin(),
                        blockLeft.begin() + frames);
    renderedRight.insert(renderedRight.end(), blockRight.begin(),
                         blockRight.begin() + frames);
  }
  expect(renderedLeft == std::vector<float>({1, 2, 3, 4, 5, 0, 0}) &&
             renderedRight == std::vector<float>({-1, -2, -3, -4, -5, 0, 0}),
         "source is block-partition independent and zero-fills its end");

  const std::array<float, 32> cursorSamples{};
  const float* cursorChannels[]{cursorSamples.data()};
  SourceHarness cursorSource({10}, cursorChannels, 1, cursorSamples.size());
  std::array<float, 2> cursorOutput{};
  float* cursorOutputChannels[]{cursorOutput.data()};
  cursorSource.render(2, cursorOutputChannels);
  zdsp::DecodedBufferSourceCursorReader cursorReader;
  expect(zdsp::decodedBufferSourceCursor(cursorSource.processor,
                                         &cursorReader) == 2,
         "cursor reader stores a verified last-good boundary");
  CursorInterference interference{&cursorSource};
  const zdsp::DecodedBufferSourceCursorReadHook cursorHook{
      publishBetweenCursorWords, &interference};
  expect(zdsp::decodedBufferSourceCursor(cursorSource.processor,
                                         &cursorReader, &cursorHook) == 2,
         "bounded retry falls back to the verified cursor, not a torn pair");
  expect(zdsp::decodedBufferSourceCursor(cursorSource.processor,
                                         &cursorReader) == 10,
         "reader advances after a later verified snapshot");

  SourceHarness resetSource({11}, channels, 2, left.size());
  std::array<float, 2> resetLeft{};
  std::array<float, 2> resetRight{};
  float* resetOutput[]{resetLeft.data(), resetRight.data()};
  resetSource.render(2, resetOutput);
  resetSource.reset(zdsp::DiscontinuityReason::SequenceGap);
  resetSource.render(2, resetOutput);
  expect(resetLeft == std::array<float, 2>{3, 4} &&
             resetRight == std::array<float, 2>{-3, -4},
         "generic graph reset preserves decoded-source cursor");
  resetSource.reset(zdsp::DiscontinuityReason::SourceSeek);
  resetSource.render(2, resetOutput);
  expect(resetLeft == std::array<float, 2>{5, 0} &&
             resetRight == std::array<float, 2>{-5, 0},
         "source-seek reason cannot rewind without a positioned contract");

  SourceHarness tailSource({12}, channels, 2, left.size());
  std::array<float, 2> tailLeft{8, 8};
  std::array<float, 2> tailRight{8, 8};
  float* tailOutput[]{tailLeft.data(), tailRight.data()};
  tailSource.render(2, tailOutput, zdsp::ProcessContextFlagTailDrain);
  expect(tailLeft == std::array<float, 2>{0, 0} &&
             tailRight == std::array<float, 2>{0, 0},
         "tail drain emits silence");
  tailSource.render(2, tailOutput);
  expect(tailLeft == std::array<float, 2>{1, 2} &&
             tailRight == std::array<float, 2>{-1, -2},
         "tail drain does not advance source time");

  auto transportAt = [](int64_t projectFrame,
                        uint64_t rateQ32 = zdsp::kProjectRateOneQ32,
                        uint32_t fractionQ32 = 0u) {
    zdsp::TransportContext transport{};
    transport.validFields = zdsp::TransportValidProjectSamples |
                            zdsp::TransportValidContinuousSamples |
                            zdsp::TransportValidProjectRateQ32;
    transport.stateFlags = zdsp::TransportStatePlaying;
    transport.projectTimeSamples = projectFrame;
    transport.projectTimeFractionQ32 = fractionQ32;
    transport.projectRateQ32 = rateQ32;
    transport.continuousTimeSamples = projectFrame + 100;
    return transport;
  };
  SourceHarness positioned({20}, positive, 1, left.size(),
                           SourceHarness::Position{10, 1});
  std::array<float, 8> positionedResult{};
  uint32_t positionedOffset = 0;
  int64_t positionedProject = 7;
  for (const uint32_t frames : {2u, 4u, 2u}) {
    std::array<float, 4> block{99, 99, 99, 99};
    float* output[]{block.data()};
    const zdsp::TransportContext transport = transportAt(positionedProject);
    positioned.render(frames, output, zdsp::ProcessContextFlagNone, &transport);
    std::copy_n(block.data(), frames,
                positionedResult.data() + positionedOffset);
    positionedOffset += frames;
    positionedProject += frames;
    if (positionedProject <= 10)
      expect(zdsp::decodedBufferSourceCursor(positioned.processor) == 1,
             "positioned source quarantines its selected cursor in pre-roll");
  }
  expect(positionedResult == std::array<float, 8>{0, 0, 0, 2, 3, 4, 5, 0},
         "positioned source crosses negative entry offset sample-exactly");

  SourceHarness positionedWhole({21}, positive, 1, left.size(),
                                SourceHarness::Position{10, 1});
  std::array<float, 8> positionedWholeResult{};
  float* positionedWholeBus[]{positionedWholeResult.data()};
  const zdsp::TransportContext wholeTransport = transportAt(7);
  positionedWhole.render(8, positionedWholeBus, zdsp::ProcessContextFlagNone,
                         &wholeTransport);
  expect(positionedWholeResult == positionedResult,
         "positioned source is independent of callback partitioning");

  SourceHarness halfRate({28}, positive, 1, left.size(),
                         SourceHarness::Position{0, 0});
  std::array<float, 8> halfRateOutput{};
  float* halfRateBus[]{halfRateOutput.data()};
  const zdsp::TransportContext halfRateTransport =
      transportAt(-1, zdsp::kProjectRateOneQ32 / 2u);
  halfRate.render(halfRateOutput.size(), halfRateBus,
                  zdsp::ProcessContextFlagNone, &halfRateTransport);
  expect(halfRateOutput ==
             std::array<float, 8>{0.0F, 0.0F, 1.0F, 1.5F,
                                  2.0F, 2.5F, 3.0F, 3.5F},
         "positioned source interpolates Q32 slow transport through pre-roll");

  SourceHarness halfRateSplit({29}, positive, 1, left.size(),
                              SourceHarness::Position{0, 0});
  std::array<float, 8> halfRateSplitOutput{};
  zdsp::TransportContext partitionTransport = halfRateTransport;
  uint32_t partitionOffset = 0;
  for (uint32_t frames : {3u, 2u, 3u}) {
    float* bus[]{halfRateSplitOutput.data() + partitionOffset};
    halfRateSplit.render(frames, bus, zdsp::ProcessContextFlagNone,
                         &partitionTransport);
    zdsp::ProjectSamplePositionQ32 next{};
    expect(zdsp::projectSamplePositionAt(partitionTransport, frames, &next),
           "Q32 partition fixture advances safely");
    partitionTransport.projectTimeSamples = next.samples;
    partitionTransport.projectTimeFractionQ32 = next.fraction;
    partitionOffset += frames;
  }
  expect(halfRateSplitOutput == halfRateOutput,
         "Q32 positioned interpolation is callback-partition invariant");

  SourceHarness fastRate({30}, positive, 1, left.size(),
                         SourceHarness::Position{0, 0});
  std::array<float, 4> fastRateOutput{};
  float* fastRateBus[]{fastRateOutput.data()};
  const zdsp::TransportContext fastRateTransport =
      transportAt(0, zdsp::kProjectRateOneQ32 +
                         zdsp::kProjectRateOneQ32 / 2u);
  fastRate.render(fastRateOutput.size(), fastRateBus,
                  zdsp::ProcessContextFlagNone, &fastRateTransport);
  expect(fastRateOutput ==
             std::array<float, 4>{1.0F, 2.5F, 4.0F, 2.5F},
         "positioned source interpolates transport faster than one project frame");
  fastRate.reset(zdsp::DiscontinuityReason::SourceLoop);
  std::array<float, 4> loopReanchor{};
  float* loopReanchorBus[]{loopReanchor.data()};
  fastRate.render(loopReanchor.size(), loopReanchorBus,
                  zdsp::ProcessContextFlagNone, &fastRateTransport);
  expect(loopReanchor == fastRateOutput,
         "Q32 positioned source follows an exact backward loop re-anchor");

  SourceHarness missingTransport({22}, positive, 1, left.size(),
                                 SourceHarness::Position{0, 1});
  std::array<float, 2> missingOutput{9, 9};
  float* missingBus[]{missingOutput.data()};
  missingTransport.render(2, missingBus);
  expect(missingOutput == std::array<float, 2>{0, 0} &&
             zdsp::decodedBufferSourceCursor(missingTransport.processor) == 1,
         "positioned source fails silent without a valid transport snapshot");
  zdsp::TransportContext invalidTransport{};
  missingOutput = {9, 9};
  missingTransport.render(2, missingBus, zdsp::ProcessContextFlagNone,
                          &invalidTransport);
  expect(missingOutput == std::array<float, 2>{0, 0} &&
             zdsp::decodedBufferSourceCursor(missingTransport.processor) == 1,
         "positioned source ignores an unavailable project position");

  SourceHarness pausedSource({26}, positive, 1, left.size(),
                             SourceHarness::Position{0, 0});
  const zdsp::TransportContext playingAtOne = transportAt(1);
  pausedSource.render(2, missingBus, zdsp::ProcessContextFlagNone,
                      &playingAtOne);
  expect(missingOutput == std::array<float, 2>{2, 3} &&
             zdsp::decodedBufferSourceCursor(pausedSource.processor) == 3,
         "positioned source publishes its playing transport position");
  zdsp::TransportContext pausedAtThree = transportAt(3);
  pausedAtThree.stateFlags = zdsp::TransportStateNone;
  missingOutput = {9, 9};
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  pausedSource.render(2, missingBus, zdsp::ProcessContextFlagNone,
                      &pausedAtThree);
  zdsp::test::setAllocationTrapEnabled(false);
  expect(zdsp::test::trappedAllocationCount() == 0,
         "paused positioned source render allocates nothing");
  expect(missingOutput == std::array<float, 2>{0, 0} &&
             zdsp::decodedBufferSourceCursor(pausedSource.processor) == 3,
         "paused positioned source emits silence without consuming its cursor");
  const zdsp::TransportContext playingAtThree = transportAt(3);
  pausedSource.render(2, missingBus, zdsp::ProcessContextFlagNone,
                      &playingAtThree);
  expect(missingOutput == std::array<float, 2>{4, 5} &&
             zdsp::decodedBufferSourceCursor(pausedSource.processor) == 5,
         "positioned source resumes at the transport-mapped frame after pause");

  const uint64_t cursorBeforeTail =
      zdsp::decodedBufferSourceCursor(pausedSource.processor);
  missingOutput = {9, 9};
  pausedSource.render(2, missingBus, zdsp::ProcessContextFlagTailDrain,
                      &playingAtOne);
  expect(missingOutput == std::array<float, 2>{0, 0} &&
             zdsp::decodedBufferSourceCursor(pausedSource.processor) ==
                 cursorBeforeTail,
         "positioned source tail drain preserves its mapped cursor");

  SourceHarness sequentialWithPausedTransport({27}, positive, 1, left.size());
  missingOutput = {9, 9};
  sequentialWithPausedTransport.render(2, missingBus,
                                       zdsp::ProcessContextFlagNone,
                                       &pausedAtThree);
  expect(missingOutput == std::array<float, 2>{1, 2} &&
             zdsp::decodedBufferSourceCursor(
                 sequentialWithPausedTransport.processor) == 2,
         "legacy sequential source ignores transport play state");

  const zdsp::TransportContext afterEntry = transportAt(2);
  missingTransport.render(2, missingBus, zdsp::ProcessContextFlagNone,
                          &afterEntry);
  const zdsp::TransportContext reanchored = transportAt(0);
  missingTransport.render(1, missingBus, zdsp::ProcessContextFlagNone,
                          &reanchored);
  expect(missingOutput[0] == 2.0f &&
             zdsp::decodedBufferSourceCursor(missingTransport.processor) == 2,
         "positioned source follows a backward transport re-anchor");

  SourceHarness positionedPositive({23}, positive, 1, left.size(),
                                   SourceHarness::Position{0, 0});
  SourceHarness positionedNegative({24}, negative, 1, right.size(),
                                   SourceHarness::Position{0, 0});
  int64_t lockedProject = -2;
  for (const uint32_t frames : {2u, 1u, 3u}) {
    std::array<float, 3> positiveOut{};
    std::array<float, 3> negativeOut{};
    float* positiveBus[]{positiveOut.data()};
    float* negativeBus[]{negativeOut.data()};
    const zdsp::TransportContext transport = transportAt(lockedProject);
    positionedPositive.render(frames, positiveBus, zdsp::ProcessContextFlagNone,
                              &transport);
    positionedNegative.render(frames, negativeBus, zdsp::ProcessContextFlagNone,
                              &transport);
    for (uint32_t frame = 0; frame < frames; ++frame)
      expect(positiveOut[frame] + negativeOut[frame] == 0.0f,
             "positioned lanes stay sample-locked across pre-roll blocks");
    lockedProject += frames;
  }

  const std::array<float, 3> shorter{1, 2, 3};
  const float* shortChannels[]{shorter.data()};
  const float* longChannels[]{right.data()};
  SourceHarness shortSource({2}, shortChannels, 1, shorter.size());
  SourceHarness longSource({3}, longChannels, 1, right.size());
  std::array<float, 5> shortOut{};
  std::array<float, 5> longOut{};
  float* shortBus[]{shortOut.data()};
  float* longBus[]{longOut.data()};
  shortSource.render(5, shortBus);
  longSource.render(5, longBus);
  expect(shortOut == std::array<float, 5>{1, 2, 3, 0, 0} &&
             longOut == right,
         "unequal source lanes end independently without over-read");

  SourceHarness positiveSource({4}, positive, 1, left.size());
  SourceHarness negativeSource({5}, negative, 1, right.size());
  for (const uint32_t frames : {1u, 3u, 1u}) {
    std::array<float, 3> positiveOut{};
    std::array<float, 3> negativeOut{};
    float* positiveBus[]{positiveOut.data()};
    float* negativeBus[]{negativeOut.data()};
    positiveSource.render(frames, positiveBus);
    negativeSource.render(frames, negativeBus);
    for (uint32_t frame = 0; frame < frames; ++frame)
      expect(positiveOut[frame] + negativeOut[frame] == 0.0f,
             "lane sources remain sample-locked across block partitions");
  }

  alignas(std::max_align_t) std::array<unsigned char, 1024> invalidState{};
  const zdsp::DecodedBufferSourceConfig badRate{
      {9}, {positive, 1, left.size(), {0.0}}};
  expect(zdsp::createDecodedBufferSource(
             badRate, {invalidState.data(),
                       static_cast<uint32_t>(invalidState.size())}).state == nullptr,
         "source rejects an invalid rate");
  expect(zdsp::createPositionedDecodedBufferSource(
             {{25}, {positive, 1, left.size(), {48000.0}}, 0, left.size() + 1},
             {invalidState.data(), static_cast<uint32_t>(invalidState.size())})
                 .state == nullptr,
         "positioned source rejects a start beyond its buffer");

  // The owner is deliberately external to the processor. Holding it for the
  // complete source lifetime makes the borrow explicit and sanitizer-visible.
  auto owner = std::make_shared<std::vector<float>>(std::initializer_list<float>{6, 7});
  std::weak_ptr<std::vector<float>> lifetime = owner;
  {
    const float* ownedChannels[]{owner->data()};
    SourceHarness ownedSource({10}, ownedChannels, 1, owner->size());
    std::array<float, 2> ownedOutput{};
    float* ownedBus[]{ownedOutput.data()};
    ownedSource.render(2, ownedBus);
    expect(ownedOutput == std::array<float, 2>{6, 7} && !lifetime.expired(),
           "session owner keeps borrowed samples alive through render");
  }
  owner.reset();
  expect(lifetime.expired(), "decoded source retains no hidden sample owner");
}

void scheduledCueTests() {
  const std::array<float, 3> shortSound{1.0f, 0.5f, 0.25f};
  const std::array<float, 2> loudSound{10.0f, 20.0f};
  const std::array<zdsp::ScheduledCueSoundView, 2> sounds{{
      {shortSound.data(), static_cast<uint32_t>(shortSound.size())},
      {loudSound.data(), static_cast<uint32_t>(loudSound.size())},
  }};
  const std::array<zdsp::ScheduledCueEvent, 4> events{{
      {-2, 0}, {-1, 1}, {1, 1}, {1, 1},
  }};
  const zdsp::ScheduledCueSourceConfig config{
      {30}, events.data(), static_cast<uint32_t>(events.size()), sounds.data(),
      static_cast<uint32_t>(sounds.size()), {48000.0}};
  auto transportAt = [](int64_t projectFrame, bool playing = true,
                        uint64_t rateQ32 = zdsp::kProjectRateOneQ32,
                        uint32_t fractionQ32 = 0u) {
    zdsp::TransportContext transport{};
    transport.validFields = zdsp::TransportValidProjectSamples |
                            zdsp::TransportValidProjectRateQ32;
    transport.stateFlags =
        playing ? zdsp::TransportStatePlaying : zdsp::TransportStateNone;
    transport.projectTimeSamples = projectFrame;
    transport.projectTimeFractionQ32 = fractionQ32;
    transport.projectRateQ32 = rateQ32;
    return transport;
  };

  CueHarness whole(config);
  std::array<float, 8> wholeOutput{};
  const zdsp::TransportContext wholeTransport = transportAt(-4);
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  whole.render(wholeOutput.size(), wholeOutput.data(), &wholeTransport);
  zdsp::test::setAllocationTrapEnabled(false);
  expect(zdsp::test::trappedAllocationCount() == 0,
         "scheduled cue render allocates nothing");
  const std::array<float, 8> expected{
      0.0f, 0.0f, 1.0f, 10.5f, 20.25f, 20.0f, 40.0f, 0.0f};
  expect(wholeOutput == expected,
         "scheduled cues mix negative, simultaneous and overlapping events");

  CueHarness partitioned(config);
  std::array<float, 8> partitionedOutput{};
  uint32_t destinationOffset = 0;
  int64_t projectFrame = -4;
  for (const uint32_t frames : {1u, 3u, 4u}) {
    const zdsp::TransportContext transport = transportAt(projectFrame);
    partitioned.render(frames, partitionedOutput.data() + destinationOffset,
                       &transport);
    destinationOffset += frames;
    projectFrame += frames;
  }
  expect(partitionedOutput == wholeOutput,
         "scheduled cues are independent of callback partitioning");

  const std::array<zdsp::ScheduledCueEvent, 1> rateEvents{{{0, 0}}};
  const zdsp::ScheduledCueSourceConfig rateConfig{
      {33}, rateEvents.data(), static_cast<uint32_t>(rateEvents.size()),
      sounds.data(), static_cast<uint32_t>(sounds.size()), {48000.0},
      zdsp::kProjectRateOneQ32 * 4u};
  CueHarness slow(rateConfig);
  std::array<float, 6> slowOutput{};
  const zdsp::TransportContext slowTransport =
      transportAt(-1, true, zdsp::kProjectRateOneQ32 / 2u);
  slow.render(slowOutput.size(), slowOutput.data(), &slowTransport);
  expect(slowOutput ==
             std::array<float, 6>{0.0F, 0.0F, 1.0F, 0.5F, 0.25F, 0.0F},
         "slow Q32 cue crosses at the first reaching output frame and keeps output-time duration");

  CueHarness fast(rateConfig);
  std::array<float, 6> fastOutput{};
  const zdsp::TransportContext fastTransport =
      transportAt(-3, true, zdsp::kProjectRateOneQ32 * 2u);
  fast.render(fastOutput.size(), fastOutput.data(), &fastTransport);
  expect(fastOutput == slowOutput,
         "fast Q32 cue crossing does not compress its click waveform");

  CueHarness slowPartitioned(rateConfig);
  std::array<float, 6> slowPartitionedOutput{};
  zdsp::TransportContext slowPartitionTransport = slowTransport;
  uint32_t slowOffset = 0;
  for (uint32_t frames : {1u, 2u, 3u}) {
    slowPartitioned.render(frames, slowPartitionedOutput.data() + slowOffset,
                           &slowPartitionTransport);
    zdsp::ProjectSamplePositionQ32 next{};
    expect(zdsp::projectSamplePositionAt(slowPartitionTransport, frames,
                                         &next),
           "cue Q32 partition fixture advances safely");
    slowPartitionTransport.projectTimeSamples = next.samples;
    slowPartitionTransport.projectTimeFractionQ32 = next.fraction;
    slowOffset += frames;
  }
  expect(slowPartitionedOutput == slowOutput,
         "Q32 cue rendering is callback-partition invariant");

  // Above rate 1.0 the lookback must cover one whole sound duration: from -1
  // at 2.5x the event at 0 first sounds at output frame 1 (project 1.5), and
  // a {3, 1} split starts its second block at project 6.5, two output frames
  // into the click. A lookback one frame short skipped the event there.
  const uint64_t fastRateQ32 =
      zdsp::kProjectRateOneQ32 * 2u + zdsp::kProjectRateOneQ32 / 2u;
  CueHarness fastWhole(rateConfig);
  std::array<float, 4> fastWholeOutput{};
  const zdsp::TransportContext fastWholeTransport =
      transportAt(-1, true, fastRateQ32);
  fastWhole.render(fastWholeOutput.size(), fastWholeOutput.data(),
                   &fastWholeTransport);
  expect(fastWholeOutput == std::array<float, 4>{0.0F, 1.0F, 0.5F, 0.25F},
         "fast Q32 cue renders its whole tail in one block");
  CueHarness fastPartitioned(rateConfig);
  std::array<float, 4> fastPartitionedOutput{};
  zdsp::TransportContext fastPartitionTransport = fastWholeTransport;
  uint32_t fastOffset = 0;
  for (uint32_t frames : {3u, 1u}) {
    fastPartitioned.render(frames, fastPartitionedOutput.data() + fastOffset,
                           &fastPartitionTransport);
    zdsp::ProjectSamplePositionQ32 next{};
    expect(zdsp::projectSamplePositionAt(fastPartitionTransport, frames,
                                         &next),
           "fast Q32 partition fixture advances safely");
    fastPartitionTransport.projectTimeSamples = next.samples;
    fastPartitionTransport.projectTimeFractionQ32 = next.fraction;
    fastOffset += frames;
  }
  expect(fastPartitionedOutput == fastWholeOutput,
         "fast Q32 cue tail survives a callback boundary");

  std::array<float, 3> fractionalTail{};
  const zdsp::TransportContext tailTransport =
      transportAt(1, true, zdsp::kProjectRateOneQ32 * 2u);
  fast.render(fractionalTail.size(), fractionalTail.data(), &tailTransport);
  expect(fractionalTail == std::array<float, 3>{1.0F, 0.5F, 0.25F},
         "cue tail offset is elapsed output samples, not raw project frames");

  std::array<float, 6> loopedRateOutput{};
  fast.processor.functions->reset(
      fast.processor.state,
      {zdsp::DiscontinuityReason::SourceLoop,
       zdsp::DiscontinuityFlagResetState});
  fast.render(loopedRateOutput.size(), loopedRateOutput.data(), &fastTransport);
  expect(loopedRateOutput == fastOutput,
         "Q32 cue source reanchors exactly after loop or backward seek");

  std::array<float, 2> forwardOutput{};
  const zdsp::TransportContext forward = transportAt(1);
  whole.render(forwardOutput.size(), forwardOutput.data(), &forward);
  expect(forwardOutput == std::array<float, 2>{20.0f, 40.0f},
         "scheduled cues render simultaneous events after a forward seek");
  std::array<float, 3> backwardOutput{};
  const zdsp::TransportContext backward = transportAt(-2);
  whole.render(backwardOutput.size(), backwardOutput.data(), &backward);
  expect(backwardOutput == std::array<float, 3>{1.0f, 10.5f, 20.25f},
         "scheduled cues follow a backward seek or loop re-anchor");

  std::array<float, 3> silentOutput{9.0f, 9.0f, 9.0f};
  whole.render(silentOutput.size(), silentOutput.data(), nullptr);
  expect(silentOutput == std::array<float, 3>{0.0f, 0.0f, 0.0f},
         "scheduled cues fail silent without transport");
  zdsp::TransportContext invalidTransport{};
  silentOutput = {9.0f, 9.0f, 9.0f};
  whole.render(silentOutput.size(), silentOutput.data(), &invalidTransport);
  expect(silentOutput == std::array<float, 3>{0.0f, 0.0f, 0.0f},
         "scheduled cues fail silent without a project position");
  const zdsp::TransportContext paused = transportAt(-2, false);
  silentOutput = {9.0f, 9.0f, 9.0f};
  whole.render(silentOutput.size(), silentOutput.data(), &paused);
  expect(silentOutput == std::array<float, 3>{0.0f, 0.0f, 0.0f},
         "scheduled cues are silent while transport is not playing");
  const zdsp::TransportContext playing = transportAt(-2);
  silentOutput = {9.0f, 9.0f, 9.0f};
  whole.render(silentOutput.size(), silentOutput.data(), &playing,
               zdsp::ProcessContextFlagTailDrain);
  expect(silentOutput == std::array<float, 3>{0.0f, 0.0f, 0.0f},
         "scheduled cues generate no tail-drain audio");

  CueHarness preview(config);
  expect(zdsp::enqueueScheduledCueOneShot(preview.processor, 0),
         "prepared cue source accepts a one-shot preview command");
  auto previewStatus = zdsp::scheduledCueOneShotStatus(preview.processor);
  expect(previewStatus.enqueued == 1 && previewStatus.started == 0 &&
             previewStatus.completed == 0 && previewStatus.pending == 1,
         "preview command status is published before its graph boundary");
  std::array<float, 2> previewHead{};
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  preview.render(previewHead.size(), previewHead.data(), nullptr);
  zdsp::test::setAllocationTrapEnabled(false);
  expect(zdsp::test::trappedAllocationCount() == 0,
         "preview command and render path allocate nothing");
  expect(previewHead == std::array<float, 2>{1.0F, 0.5F},
         "one-shot preview starts at the next graph block while transport is idle");
  previewStatus = zdsp::scheduledCueOneShotStatus(preview.processor);
  expect(previewStatus.started == 1 && previewStatus.completed == 0 &&
             previewStatus.pending == 1,
         "preview status retains an in-flight click tail");
  float previewTail = 0.0F;
  preview.render(1, &previewTail, nullptr);
  previewStatus = zdsp::scheduledCueOneShotStatus(preview.processor);
  expect(previewTail == 0.25F && previewStatus.completed == 1 &&
             previewStatus.pending == 0,
         "one-shot preview tail completes through later graph blocks");
  for (uint32_t index = 0; index < zdsp::kMaximumScheduledCueOneShots;
       ++index)
    expect(zdsp::enqueueScheduledCueOneShot(preview.processor, 1),
           "bounded preview mailbox admits its declared capacity");
  expect(!zdsp::enqueueScheduledCueOneShot(preview.processor, 1),
         "bounded preview mailbox rejects overflow");
  expect(!zdsp::enqueueScheduledCueOneShot(preview.processor, 2),
         "preview command rejects a sound outside the prepared bank");

  const zdsp::TransportContext overflowing =
      transportAt(std::numeric_limits<int64_t>::max());
  std::array<float, 2> overflowOutput{9.0f, 9.0f};
  whole.render(overflowOutput.size(), overflowOutput.data(), &overflowing);
  expect(overflowOutput == std::array<float, 2>{0.0f, 0.0f},
         "scheduled cues fail silent when a callback position overflows");

  alignas(std::max_align_t) std::array<unsigned char, 1024> invalidState{};
  const auto rejects = [&](const zdsp::ScheduledCueSourceConfig& candidate,
                           const char* message) {
    expect(zdsp::createScheduledCueSource(
               candidate,
               {invalidState.data(),
                static_cast<uint32_t>(invalidState.size())})
               .state == nullptr,
           message);
  };
  rejects({{31}, events.data(), static_cast<uint32_t>(events.size()),
           sounds.data(), static_cast<uint32_t>(sounds.size()), {0.0}},
          "scheduled cue source rejects a zero sample rate");
  rejects({{31}, events.data(), static_cast<uint32_t>(events.size()),
           sounds.data(), static_cast<uint32_t>(sounds.size()),
           {std::numeric_limits<double>::infinity()}},
          "scheduled cue source rejects a non-finite sample rate");
  rejects({{31}, nullptr, 1, sounds.data(),
           static_cast<uint32_t>(sounds.size()), {48000.0}},
          "scheduled cue source rejects a missing event array");
  rejects({{31}, events.data(), static_cast<uint32_t>(events.size()),
           sounds.data(), static_cast<uint32_t>(sounds.size()), {48000.0}, 0},
          "scheduled cue source rejects a zero prepared maximum rate");

  const std::array<zdsp::ScheduledCueEvent, 2> unsorted{{{1, 0}, {0, 0}}};
  rejects({{31}, unsorted.data(), static_cast<uint32_t>(unsorted.size()),
           sounds.data(), static_cast<uint32_t>(sounds.size()), {48000.0}},
          "scheduled cue source rejects unsorted events");
  const zdsp::ScheduledCueEvent invalidSoundIndex{0, 2};
  rejects({{31}, &invalidSoundIndex, 1, sounds.data(),
           static_cast<uint32_t>(sounds.size()), {48000.0}},
          "scheduled cue source rejects an invalid sound index");

  const float nonFiniteSample = std::numeric_limits<float>::quiet_NaN();
  const zdsp::ScheduledCueSoundView nonFiniteSound{&nonFiniteSample, 1};
  const zdsp::ScheduledCueEvent oneEvent{0, 0};
  rejects({{31}, &oneEvent, 1, &nonFiniteSound, 1, {48000.0}},
          "scheduled cue source rejects non-finite PCM");
  const zdsp::ScheduledCueSoundView missingPcm{nullptr, 1};
  rejects({{31}, &oneEvent, 1, &missingPcm, 1, {48000.0}},
          "scheduled cue source rejects missing PCM");
  const zdsp::ScheduledCueSoundView emptySound{shortSound.data(), 0};
  rejects({{31}, &oneEvent, 1, &emptySound, 1, {48000.0}},
          "scheduled cue source rejects an empty sound");
  const zdsp::ScheduledCueSoundView oversizedSound{
      shortSound.data(), zdsp::kMaximumScheduledCueFramesPerSound + 1u};
  rejects({{31}, &oneEvent, 1, &oversizedSound, 1, {48000.0}},
          "scheduled cue source rejects an oversized sound");
  std::vector<float> maximumSound(
      zdsp::kMaximumScheduledCueFramesPerSound, 0.0f);
  std::array<zdsp::ScheduledCueSoundView, 5> excessiveSoundBank{};
  for (auto& sound : excessiveSoundBank)
    sound = {maximumSound.data(),
             zdsp::kMaximumScheduledCueFramesPerSound};
  rejects({{31}, &oneEvent, 1, excessiveSoundBank.data(),
           static_cast<uint32_t>(excessiveSoundBank.size()), {48000.0}},
          "scheduled cue source enforces its total PCM-frame bound");

  const std::array<float, 2> twoFrames{};
  const zdsp::ScheduledCueSoundView twoFrameSound{twoFrames.data(), 2};
  const zdsp::ScheduledCueEvent endpointOverflow{
      std::numeric_limits<int64_t>::max(), 0};
  rejects({{31}, &endpointOverflow, 1, &twoFrameSound, 1, {48000.0}},
          "scheduled cue source rejects an overflowing event extent");
  rejects({{31}, &oneEvent, zdsp::kMaximumScheduledCueEvents + 1u,
           sounds.data(), static_cast<uint32_t>(sounds.size()), {48000.0}},
          "scheduled cue source enforces its event-count bound");
  rejects({{31}, &oneEvent, 1, sounds.data(),
           zdsp::kMaximumScheduledCueSounds + 1u, {48000.0}},
          "scheduled cue source enforces its sound-count bound");

  std::array<zdsp::ScheduledCueEvent,
             zdsp::kMaximumScheduledCueOverlap + 1u>
      excessiveOverlap{};
  for (auto& event : excessiveOverlap) event = {0, 0};
  rejects({{31}, excessiveOverlap.data(),
           static_cast<uint32_t>(excessiveOverlap.size()), sounds.data(),
           static_cast<uint32_t>(sounds.size()), {48000.0}},
          "scheduled cue source enforces its overlap bound");

  std::vector<zdsp::ScheduledCueEvent> denseEvents(
      zdsp::kMaximumScheduledCueEventsPerRender + 1u);
  for (uint32_t index = 0; index < denseEvents.size(); ++index)
    denseEvents[index] = {static_cast<int64_t>(index), 0};
  const zdsp::ScheduledCueSoundView oneFrameSound{shortSound.data(), 1};
  const zdsp::ScheduledCueSourceConfig denseConfig{
      {32}, denseEvents.data(), static_cast<uint32_t>(denseEvents.size()),
      &oneFrameSound, 1, {48000.0}};
  zdsp::ProcessorHandle dense = zdsp::createScheduledCueSource(
      denseConfig,
      {invalidState.data(), static_cast<uint32_t>(invalidState.size())});
  expect(dense.state != nullptr, "dense schedule passes creation validation");
  const zdsp::AudioBusDescriptor monoBus{
      1, zdsp::SampleFormat::Float32Planar,
      zdsp::AudioChannelLayout::Mono, nullptr};
  const zdsp::PrepareSpec denseSpec{
      zdsp::kProcessorInterfaceVersion, zdsp::kPrepareSpecV1RequiredSize,
      {48000.0}, {512}, 0, 1, nullptr, &monoBus};
  const zdsp::PreparedStorage noPreparedStorage{nullptr, 0, 1};
  expect(dense.functions->prepare(dense.state, &denseSpec, &noPreparedStorage)
                 .code == zdsp::StatusCode::CapacityExceeded,
         "scheduled cue source rejects excessive per-render density");
  expect(zdsp::succeeded(zdsp::destroyProcessor(&dense)),
         "unprepared dense scheduled cue source destroys");

  std::vector<zdsp::ScheduledCueEvent> fastDenseEvents(
      zdsp::kMaximumScheduledCueEventsPerRender + 1u);
  for (uint32_t index = 0; index < fastDenseEvents.size(); ++index)
    fastDenseEvents[index] = {static_cast<int64_t>(index), 0};
  const zdsp::ScheduledCueSourceConfig fastDenseConfig{
      {34}, fastDenseEvents.data(),
      static_cast<uint32_t>(fastDenseEvents.size()), &oneFrameSound, 1,
      {48000.0}, zdsp::kProjectRateOneQ32 * 4u};
  zdsp::ProcessorHandle fastDense = zdsp::createScheduledCueSource(
      fastDenseConfig,
      {invalidState.data(), static_cast<uint32_t>(invalidState.size())});
  expect(fastDense.state != nullptr,
         "maximum-rate density fixture passes creation validation");
  zdsp::PrepareSpec fastDenseSpec = denseSpec;
  fastDenseSpec.maximumBlockFrames = {65};
  expect(fastDense.functions
                 ->prepare(fastDense.state, &fastDenseSpec, &noPreparedStorage)
                 .code == zdsp::StatusCode::CapacityExceeded,
         "prepare rejects a max-rate schedule that could exceed callback capacity");
  expect(zdsp::succeeded(zdsp::destroyProcessor(&fastDense)),
         "unprepared maximum-rate dense source destroys");

  std::array<zdsp::ScheduledCueEvent, zdsp::kMaximumScheduledCueOverlap>
      simultaneousEvents{};
  for (auto& event : simultaneousEvents) event = {0, 0};
  const zdsp::ScheduledCueSourceConfig simultaneousConfig{
      {35}, simultaneousEvents.data(),
      static_cast<uint32_t>(simultaneousEvents.size()), &oneFrameSound, 1,
      {48000.0}, zdsp::kProjectRateOneQ32 * 4u};
  CueHarness simultaneous(simultaneousConfig);
  float simultaneousOutput = 0.0F;
  const zdsp::TransportContext simultaneousTransport =
      transportAt(0, true, zdsp::kProjectRateOneQ32 * 4u);
  simultaneous.render(1, &simultaneousOutput, &simultaneousTransport);
  expect(simultaneousOutput ==
             shortSound[0] *
                 static_cast<float>(zdsp::kMaximumScheduledCueOverlap),
         "all allowed simultaneous cues render at maximum supported rate");

  const auto rejectsPrepare = [&](const zdsp::PrepareSpec& spec,
                                  const char* message) {
    zdsp::ProcessorHandle source = zdsp::createScheduledCueSource(
        config,
        {invalidState.data(), static_cast<uint32_t>(invalidState.size())});
    expect(source.state != nullptr, "format-test cue source constructs");
    expect(source.functions->prepare(source.state, &spec, &noPreparedStorage)
                   .code == zdsp::StatusCode::UnsupportedFormat,
           message);
    expect(zdsp::succeeded(zdsp::destroyProcessor(&source)),
           "unprepared format-test cue source destroys");
  };
  const zdsp::AudioBusDescriptor stereoBus{
      2, zdsp::SampleFormat::Float32Planar,
      zdsp::AudioChannelLayout::Stereo, nullptr};
  zdsp::PrepareSpec invalidPrepare = denseSpec;
  invalidPrepare.maximumBlockFrames = {64};
  invalidPrepare.outputBuses = &stereoBus;
  rejectsPrepare(invalidPrepare,
                 "scheduled cue source rejects non-mono output");
  invalidPrepare.outputBuses = &monoBus;
  invalidPrepare.inputBusCount = 1;
  invalidPrepare.inputBuses = &monoBus;
  rejectsPrepare(invalidPrepare,
                 "scheduled cue source rejects an input bus");
  invalidPrepare.inputBusCount = 0;
  invalidPrepare.inputBuses = nullptr;
  invalidPrepare.sampleRate = {44100.0};
  rejectsPrepare(invalidPrepare,
                 "scheduled cue source rejects a mismatched sample rate");
}

}  // namespace

int main() {
  decodeTests();
  sourceTests();
  scheduledCueTests();
  std::puts("prepared audio tests: ok");
  return 0;
}
