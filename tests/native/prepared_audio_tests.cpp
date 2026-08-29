#include <zcore/media/decoded_audio.h>
#include <zcore/media/flac_io.h>
#include <zcore/media/wav.h>
#include <zcore/legacy/resample.h>

#include "allocation_trap.h"
#include "zdsp/decoded_buffer_source.h"

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
  expect(unsupportedResult.status == singz::DecodedAudioStatus::UnsupportedFormat &&
             unsupportedResult.audio == nullptr,
         "unsupported magic fails without publication");

  singz::DecodedAudioPrepareOptions bounded;
  bounded.maximumDecodedBytes = 4;
  const singz::DecodedAudioResult overLimit = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openForDecode(wav)), bounded);
  expect(overLimit.status == singz::DecodedAudioStatus::LimitExceeded &&
             overLimit.audio == nullptr,
         "decode byte bound is enforced before publication");
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

  expect(std::strcmp(singz::decodedAudioCapabilityTag(),
                     "singz-prepared-audio-fd-wav-flac-v1") == 0,
         "prepared-audio capability tag is durable");

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
  alignas(std::max_align_t) std::array<unsigned char, 1024> state{};
  zdsp::ProcessorHandle processor{};
  zdsp::AudioBusDescriptor bus{};

  SourceHarness(zdsp::NodeId node, const float* const* channels,
                uint32_t channelCount, uint64_t frames,
                double sampleRate = 48000.0) {
    bus = {channelCount, zdsp::SampleFormat::Float32Planar,
           channelCount == 1 ? zdsp::AudioChannelLayout::Mono
                             : zdsp::AudioChannelLayout::Stereo,
           nullptr};
    const zdsp::DecodedBufferSourceConfig config{
        node, {channels, channelCount, frames, {sampleRate}}};
    expect(zdsp::decodedBufferSourceStateBytes() <= state.size(),
           "source state fits harness");
    processor = zdsp::createDecodedBufferSource(
        config, {state.data(), static_cast<uint32_t>(state.size())});
    expect(processor.state != nullptr, "decoded source constructs");
    const zdsp::PrepareSpec spec{
        zdsp::kProcessorInterfaceVersion, zdsp::kPrepareSpecV1RequiredSize,
        {sampleRate}, {64}, 0, 1, nullptr, &bus};
    const zdsp::PreparedStorage prepared{nullptr, 0, 1};
    expect(zdsp::succeeded(processor.functions->prepare(
               processor.state, &spec, &prepared)),
           "decoded source prepares");
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
              uint32_t flags = zdsp::ProcessContextFlagNone) {
    zdsp::ProcessContext context{
        zdsp::kProcessContextInterfaceVersion,
        zdsp::kProcessContextV2RequiredSize,
        {{1}, {1}, {0}, {0}, {0}, zdsp::RenderTimeNone},
        nullptr, {48000.0}, {frames}, nullptr, 0, nullptr, 0,
        {nullptr, 0},
        {zdsp::DiscontinuityReason::None, zdsp::DiscontinuityFlagNone}, flags};
    zdsp::MutableAudioBusView outputBus{
        output, bus.channelCount, {frames}, {frames}};
    processor.functions->process(processor.state, &context, nullptr, 0,
                                 &outputBus, 1);
  }
};

void sourceTests() {
  const std::array<float, 5> left{1, 2, 3, 4, 5};
  const std::array<float, 5> right{-1, -2, -3, -4, -5};
  const float* channels[]{left.data(), right.data()};
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
    renderedLeft.insert(renderedLeft.end(), blockLeft.begin(),
                        blockLeft.begin() + frames);
    renderedRight.insert(renderedRight.end(), blockRight.begin(),
                         blockRight.begin() + frames);
  }
  expect(renderedLeft == std::vector<float>({1, 2, 3, 4, 5, 0, 0}) &&
             renderedRight == std::vector<float>({-1, -2, -3, -4, -5, 0, 0}),
         "source is block-partition independent and zero-fills its end");

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

  const float* positive[]{left.data()};
  const float* negative[]{right.data()};
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

}  // namespace

int main() {
  decodeTests();
  sourceTests();
  std::puts("prepared audio tests: ok");
  return 0;
}
