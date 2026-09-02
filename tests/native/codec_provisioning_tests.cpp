#include <zcore/media/decoded_audio.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
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

int openRead(const char* path) noexcept {
#if defined(_WIN32)
  return _open(path, _O_RDONLY | _O_BINARY);
#else
  return ::open(path, O_RDONLY);
#endif
}

bool descriptorOpen(int descriptor) noexcept {
#if defined(_WIN32)
  errno = 0;
  return _get_osfhandle(descriptor) != -1 || errno != EBADF;
#else
  errno = 0;
  return fcntl(descriptor, F_GETFD) != -1 || errno != EBADF;
#endif
}

bool cancelled(void*) noexcept { return true; }

struct CancelAfter {
  unsigned calls = 0;
  unsigned limit = 0;
};
bool cancelAfter(void* opaque) noexcept {
  auto* state = static_cast<CancelAfter*>(opaque);
  return ++state->calls >= state->limit;
}

std::vector<unsigned char> readBytes(const char* source) {
  std::FILE* input = std::fopen(source, "rb");
  expect(input != nullptr && std::fseek(input, 0, SEEK_END) == 0,
         "mutation fixture opens");
  const long size = std::ftell(input);
  expect(size > 16 && std::fseek(input, 0, SEEK_SET) == 0,
         "mutation fixture has content");
  std::vector<unsigned char> bytes(static_cast<size_t>(size));
  expect(std::fread(bytes.data(), 1, bytes.size(), input) == bytes.size(),
         "mutation fixture reads bytes");
  std::fclose(input);
  return bytes;
}

std::string writeMutation(const char* source, const char* label,
                          size_t retained, bool corrupt) {
  std::vector<unsigned char> bytes = readBytes(source);
  retained = std::min(retained, bytes.size());
  bytes.resize(retained);
  if (corrupt) {
    const size_t oldSize = bytes.size();
    bytes.resize(std::max<size_t>(oldSize, 48), 0xa5);
    // Keep strict signature detection intact while making every structural
    // field after the first container bytes deterministic garbage.
    for (size_t index = std::min<size_t>(16, oldSize); index < bytes.size(); ++index)
      bytes[index] = static_cast<unsigned char>(0xa5 ^ index);
  }
  const std::string target = (std::filesystem::temp_directory_path() /
      (std::string("singz-codec-") + label)).string();
  std::FILE* output = std::fopen(target.c_str(), "wb");
  expect(output != nullptr &&
             std::fwrite(bytes.data(), 1, bytes.size(), output) == bytes.size(),
         "mutation fixture writes bytes");
  std::fclose(output);
  return target;
}

void decodeOne(const char* path, singz::DecodedAudioSourceFormat format) {
  const int descriptor = openRead(path);
  expect(descriptor >= 0, "codec fixture opens");
  singz::DecodedAudioPrepareOptions options;
  options.sourceFormat = format;
  const singz::DecodedAudioResult result = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(descriptor), options);
  expect(result.ok() && result.audio->sampleRate() >= 8000 &&
             result.audio->channelCount() >= 1 &&
             result.audio->frameCount() >= 1,
         "declared codec fixture decodes to bounded planar audio");
  expect(!descriptorOpen(descriptor), "successful extended decode closes once");
}

void expectRejected(const char* path, singz::DecodedAudioSourceFormat format,
                    const char* message) {
  const int descriptor = openRead(path);
  expect(descriptor >= 0, "negative codec fixture opens");
  singz::DecodedAudioPrepareOptions options;
  options.sourceFormat = format;
  const auto result = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(descriptor), options);
  expect(!result.ok() && result.audio == nullptr, message);
  expect(!descriptorOpen(descriptor),
         "negative extended decode consumes descriptor exactly once");
}

struct Fixture {
  const char* path;
  singz::DecodedAudioSourceFormat format;
  uint32_t capability;
  size_t signatureBytes;
  const char* label;
};

}  // namespace

int main(int argc, char** argv) {
  const auto capabilities = singz::decodedAudioCodecCapabilities();
  expect((capabilities.formatMask & singz::DecodedAudioCapabilityWav) != 0 &&
             (capabilities.formatMask & singz::DecodedAudioCapabilityFlac) != 0,
         "base codec capability mask is present");
  expect(!capabilities.completeProductMatrix ||
             capabilities.formatMask == singz::kDecodedAudioProductFormatMask,
         "full-matrix claim is equivalent to the complete product mask");
  expect(!capabilities.dynamicallyLinkedFfmpeg ||
             (capabilities.runtimeVersion != nullptr &&
              capabilities.runtimeLicense != nullptr &&
              std::strcmp(capabilities.runtimeLicense,
                          "LGPL version 2.1 or later") == 0),
         "dynamic runtime reports a compatible version and LGPL license");
  expect(singz::decodedAudioFormatForExtension(".mp3") ==
             singz::DecodedAudioSourceFormat::Mp3 &&
             singz::decodedAudioFormatForExtension(".m4a") ==
                 singz::DecodedAudioSourceFormat::M4a &&
             singz::decodedAudioFormatForExtension(".aac") ==
                 singz::DecodedAudioSourceFormat::Aac &&
             singz::decodedAudioFormatForExtension(".ogg") ==
                 singz::DecodedAudioSourceFormat::Ogg &&
             singz::decodedAudioFormatForExtension(".oga") ==
                 singz::DecodedAudioSourceFormat::Ogg &&
             singz::decodedAudioFormatForExtension(".opus") ==
                 singz::DecodedAudioSourceFormat::Opus &&
             singz::decodedAudioFormatForExtension(".aif") ==
                 singz::DecodedAudioSourceFormat::Aiff &&
             singz::decodedAudioFormatForExtension(".aiff") ==
                 singz::DecodedAudioSourceFormat::Aiff,
         "declared codec extension matrix is complete");
  expect(singz::decodedAudioFormatForExtension("https://host/x.mp3") ==
             singz::DecodedAudioSourceFormat::Auto &&
             singz::decodedAudioFormatForExtension("C:\\device\\x.wav") ==
                 singz::DecodedAudioSourceFormat::Auto,
         "paths, network URLs and device spellings are not accepted");

  // Full fixture mode is opt-in because the ordinary host suite deliberately
  // has no external codec artifact. CI/mobile packaging can pass the seven
  // deterministic files produced by tests/fixtures/codecs/generate.sh.
  if (argc == 1) {
    std::puts("codec provisioning tests: base capability seam ok");
    return 0;
  }
  const bool availableFixtureMode = argc == 14 &&
      std::strcmp(argv[1], "--available") == 0;
  expect(argc == 13 || availableFixtureMode,
         "fixture mode needs mp3,aac,m4a-aac,m4a-alac,ogg,opus,aiff,aifc,"
         "audio+video,video-only,unsupported-ogg,long-mp3");
  char** fixturesArgv = argv + (availableFixtureMode ? 1 : 0);
  constexpr uint32_t fullMask = singz::DecodedAudioCapabilityMp3 |
      singz::DecodedAudioCapabilityM4aAac |
      singz::DecodedAudioCapabilityM4aAlac |
      singz::DecodedAudioCapabilityAac |
      singz::DecodedAudioCapabilityOggVorbis |
      singz::DecodedAudioCapabilityOggOpus |
      singz::DecodedAudioCapabilityAiff;
  std::fprintf(stdout, "codec runtime: tag=%s mask=0x%08x version=%s dynamic=%s\n",
               singz::decodedAudioCapabilityTag(), capabilities.formatMask,
               capabilities.runtimeVersion == nullptr
                   ? "unavailable"
                   : capabilities.runtimeVersion,
               capabilities.dynamicallyLinkedFfmpeg ? "yes" : "no");
  expect(capabilities.dynamicallyLinkedFfmpeg &&
             capabilities.runtimeVersion != nullptr &&
             capabilities.runtimeLicense != nullptr,
         "fixture runtime is a compatible dynamic FFmpeg build");
  if (!availableFixtureMode) {
    expect((capabilities.formatMask & fullMask) == fullMask,
           "fixture runtime truthfully advertises every decoder/demuxer");
    expect(capabilities.completeProductMatrix &&
               capabilities.formatMask == singz::kDecodedAudioProductFormatMask &&
               std::strcmp(singz::decodedAudioCapabilityTag(),
                           "singz-prepared-audio-fd-ffmpeg-full-matrix-v3") == 0,
           "full fixture runtime publishes the release-gated matrix tag");
  } else if (!capabilities.completeProductMatrix) {
    expect(std::strcmp(singz::decodedAudioCapabilityTag(),
                       "singz-prepared-audio-fd-ffmpeg-partial-runtime-v2") == 0,
           "partial fixture runtime cannot publish the product matrix tag");
  }

  const Fixture fixtures[] = {
      {fixturesArgv[1], singz::DecodedAudioSourceFormat::Mp3,
       singz::DecodedAudioCapabilityMp3, 10, "mp3"},
      {fixturesArgv[2], singz::DecodedAudioSourceFormat::Aac,
       singz::DecodedAudioCapabilityAac, 7, "aac"},
      {fixturesArgv[3], singz::DecodedAudioSourceFormat::M4a,
       singz::DecodedAudioCapabilityM4aAac, 12, "m4a-aac"},
      {fixturesArgv[4], singz::DecodedAudioSourceFormat::M4a,
       singz::DecodedAudioCapabilityM4aAlac, 12, "m4a-alac"},
      {fixturesArgv[5], singz::DecodedAudioSourceFormat::Ogg,
       singz::DecodedAudioCapabilityOggVorbis, 8, "ogg-vorbis"},
      {fixturesArgv[6], singz::DecodedAudioSourceFormat::Opus,
       singz::DecodedAudioCapabilityOggOpus, 8, "ogg-opus"},
      {fixturesArgv[7], singz::DecodedAudioSourceFormat::Aiff,
       singz::DecodedAudioCapabilityAiff, 12, "aiff"},
      {fixturesArgv[8], singz::DecodedAudioSourceFormat::Aiff,
       singz::DecodedAudioCapabilityAiff, 12, "aifc"},
  };
  for (const auto& fixture : fixtures) {
    if ((capabilities.formatMask & fixture.capability) == 0) continue;
    decodeOne(fixture.path, fixture.format);
    const std::string truncated = writeMutation(
        fixture.path, (std::string(fixture.label) + "-truncated").c_str(),
        fixture.signatureBytes, false);
    expectRejected(truncated.c_str(), fixture.format,
                   "truncated container cannot publish partial audio");
    std::remove(truncated.c_str());
    const std::string corrupt = writeMutation(
        fixture.path, (std::string(fixture.label) + "-corrupt").c_str(),
        fixture.signatureBytes, true);
    expectRejected(corrupt.c_str(), fixture.format,
                   "corrupt container cannot publish partial audio");
    std::remove(corrupt.c_str());
  }

  singz::DecodedAudioPrepareOptions mismatch;
  mismatch.sourceFormat = singz::DecodedAudioSourceFormat::Aiff;
  const auto wrongDeclaration = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(openRead(fixturesArgv[1])), mismatch);
  expect(wrongDeclaration.status == singz::DecodedAudioStatus::MalformedData &&
             wrongDeclaration.audio == nullptr,
         "declared format must match signature before demux");

  const int cancelDescriptor = openRead(fixturesArgv[1]);
  const auto cancelResult = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(cancelDescriptor), {}, {nullptr, cancelled});
  expect(cancelResult.status == singz::DecodedAudioStatus::Cancelled &&
             !descriptorOpen(cancelDescriptor),
         "cancel-before-decode publishes nothing and closes authority");

  CancelAfter cancelDuring{0, 8};
  const int cancelDuringDescriptor = openRead(fixturesArgv[12]);
  const auto cancelDuringResult = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(cancelDuringDescriptor), {},
      {&cancelDuring, cancelAfter});
  expect(cancelDuringResult.status == singz::DecodedAudioStatus::Cancelled &&
             cancelDuringResult.audio == nullptr &&
             !descriptorOpen(cancelDuringDescriptor),
         "cancel after repeated custom AVIO activity publishes nothing and closes authority");

  singz::DecodedAudioPrepareOptions encodedBound;
  encodedBound.maximumEncodedBytes = 8;
  const int oversizedDescriptor = openRead(fixturesArgv[3]);
  const auto oversized = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(oversizedDescriptor), encodedBound);
  expect(oversized.status == singz::DecodedAudioStatus::LimitExceeded &&
             oversized.audio == nullptr && !descriptorOpen(oversizedDescriptor),
         "extended codec input observes encoded-byte bound before demux");

  for (const auto [limit, field] : {
           std::pair<uint64_t, int>{1, 0},
           std::pair<uint64_t, int>{4, 1},
           std::pair<uint64_t, int>{4, 2},
       }) {
    singz::DecodedAudioPrepareOptions bounded;
    bounded.sourceFormat = singz::DecodedAudioSourceFormat::Mp3;
    if (field == 0) bounded.maximumFrames = limit;
    if (field == 1) bounded.maximumDecodedBytes = static_cast<size_t>(limit);
    if (field == 2) bounded.maximumWorkingBytes = static_cast<size_t>(limit);
    const int descriptor = openRead(fixturesArgv[1]);
    const auto result = singz::prepareDecodedAudio(
        singz::OwnedFileDescriptor(descriptor), bounded);
    expect(result.status == singz::DecodedAudioStatus::LimitExceeded &&
               result.audio == nullptr && !descriptorOpen(descriptor),
           "extended codec observes frame/decoded/working bounds without publication");
  }

  // The fully decoded mono MP3 is 3840 float samples (15360 bytes). A budget
  // equal to that retained result is still insufficient while a channel
  // vector grows: the old allocation, replacement and conversion scratch are
  // simultaneously live. This catches accounting only frameCount + scratch
  // while std::vector reallocates behind it.
  singz::DecodedAudioPrepareOptions overlapBound;
  overlapBound.sourceFormat = singz::DecodedAudioSourceFormat::Mp3;
  overlapBound.maximumFrames = 3840;
  overlapBound.maximumDecodedBytes = 3840 * sizeof(float);
  overlapBound.maximumWorkingBytes = 3840 * sizeof(float);
  const int overlapDescriptor = openRead(fixturesArgv[1]);
  const auto overlapResult = singz::prepareDecodedAudio(
      singz::OwnedFileDescriptor(overlapDescriptor), overlapBound);
  expect(overlapResult.status == singz::DecodedAudioStatus::LimitExceeded &&
             overlapResult.audio == nullptr && !descriptorOpen(overlapDescriptor),
         "working-byte limit accounts for vector replacement overlap");

  expectRejected(fixturesArgv[9], singz::DecodedAudioSourceFormat::M4a,
                 "additional non-audio stream is rejected");
  expectRejected(fixturesArgv[10], singz::DecodedAudioSourceFormat::M4a,
                 "container without an audio stream is rejected");
  expectRejected(fixturesArgv[11], singz::DecodedAudioSourceFormat::Ogg,
                 "unsupported codec in an allowed container is rejected");

  std::puts(availableFixtureMode
                ? "codec provisioning tests: available dynamic matrix ok"
                : "codec provisioning tests: full dynamic matrix ok");
  return 0;
}
