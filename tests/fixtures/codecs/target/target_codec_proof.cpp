#include "target_codec_proof.h"

#include <zcore/media/decoded_audio.h>

#if !defined(SINGZ_ZCORE_FFMPEG)
#error "The codec target proof must compile against the packaged FFmpeg zcore runtime"
#endif
#if !defined(SINGZ_CODEC_TARGET_PROOF_SOURCE_STAMP)
#error "The codec target proof must embed its exact source/generator/contract stamp"
#endif
#if !defined(SINGZ_CODEC_TARGET_PROOF_PLATFORM_STAMP) || \
    !defined(SINGZ_CODEC_TARGET_PROOF_BUILD_STAMP)
#error "The codec target proof must embed its platform harness/build stamp"
#endif

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
}

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <iterator>
#include <limits>
#include <sstream>
#include <string_view>
#include <utility>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace singz::codec_target_proof {
namespace {

constexpr std::string_view kFixtureNames[] = {
    "tone.mp3",          "tone.aac",          "tone-aac.m4a",
    "tone-alac.m4a",     "tone.ogg",          "tone.opus",
    "tone.aiff",         "tone.aifc",         "audio-plus-video.m4a",
    "video-only.m4a",    "unsupported-flac.ogg", "cancel-long.mp3",
};

struct Failure {
  std::string message;
};

struct CaseEvidence {
  std::string name;
  std::string result;
  uint32_t sampleRate = 0;
  uint32_t channels = 0;
  uint64_t frames = 0;
};

int openRead(const std::string& path) noexcept {
#if defined(_WIN32)
  return _open(path.c_str(), _O_RDONLY | _O_BINARY);
#else
  return ::open(path.c_str(), O_RDONLY);
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

bool cancelImmediately(void*) noexcept { return true; }

struct CancelAfter {
  unsigned calls = 0;
  unsigned limit = 0;
};

bool cancelAfter(void* opaque) noexcept {
  auto* state = static_cast<CancelAfter*>(opaque);
  return ++state->calls >= state->limit;
}

std::string jsonEscape(std::string_view value) {
  std::string output;
  output.reserve(value.size() + 16);
  for (const unsigned char ch : value) {
    switch (ch) {
      case '"': output += "\\\""; break;
      case '\\': output += "\\\\"; break;
      case '\b': output += "\\b"; break;
      case '\f': output += "\\f"; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      default:
        if (ch < 0x20) {
          char escaped[7]{};
          std::snprintf(escaped, sizeof(escaped), "\\u%04x", ch);
          output += escaped;
        } else {
          output += static_cast<char>(ch);
        }
    }
  }
  return output;
}

[[noreturn]] void reject(std::string message) { throw Failure{std::move(message)}; }

void require(bool condition, std::string message) {
  if (!condition) reject(std::move(message));
}

std::vector<unsigned char> readBytes(const std::string& source) {
  std::FILE* input = std::fopen(source.c_str(), "rb");
  require(input != nullptr && std::fseek(input, 0, SEEK_END) == 0,
          "mutation fixture opens");
  const long size = std::ftell(input);
  require(size > 16 && std::fseek(input, 0, SEEK_SET) == 0,
          "mutation fixture has content");
  std::vector<unsigned char> bytes(static_cast<size_t>(size));
  require(std::fread(bytes.data(), 1, bytes.size(), input) == bytes.size(),
          "mutation fixture reads bytes");
  std::fclose(input);
  return bytes;
}

std::string writeMutation(const std::string& source, std::string_view label,
                          size_t retained, bool corrupt) {
  std::vector<unsigned char> bytes = readBytes(source);
  retained = std::min(retained, bytes.size());
  bytes.resize(retained);
  if (corrupt) {
    const size_t originalSize = bytes.size();
    bytes.resize(std::max<size_t>(originalSize, 48), 0xa5);
    for (size_t index = std::min<size_t>(16, originalSize);
         index < bytes.size(); ++index) {
      bytes[index] = static_cast<unsigned char>(0xa5 ^ index);
    }
  }
  const std::filesystem::path target =
      std::filesystem::temp_directory_path() /
      ("singz-target-codec-" + std::string(label) + "-" +
       std::to_string(reinterpret_cast<uintptr_t>(bytes.data())));
  std::FILE* output = std::fopen(target.string().c_str(), "wb");
  require(output != nullptr &&
              std::fwrite(bytes.data(), 1, bytes.size(), output) == bytes.size(),
          "mutation fixture writes bytes");
  std::fclose(output);
  return target.string();
}

CaseEvidence decodeOne(const std::string& name, const std::string& path,
                       DecodedAudioSourceFormat format) {
  const int descriptor = openRead(path);
  require(descriptor >= 0, name + " opens");
  DecodedAudioPrepareOptions options;
  options.sourceFormat = format;
  const DecodedAudioResult result = prepareDecodedAudio(
      OwnedFileDescriptor(descriptor), options);
  require(result.ok() && result.audio->sampleRate() >= 8000 &&
              result.audio->channelCount() >= 1 && result.audio->frameCount() >= 1,
          name + " decodes to bounded planar audio");
  require(!descriptorOpen(descriptor), name + " closes descriptor once");
  return {name, "decoded", result.audio->sampleRate(),
          result.audio->channelCount(), result.audio->frameCount()};
}

void expectRejected(const std::string& name, const std::string& path,
                    DecodedAudioSourceFormat format,
                    DecodedAudioStatus expected = DecodedAudioStatus::MalformedData) {
  const int descriptor = openRead(path);
  require(descriptor >= 0, name + " opens");
  DecodedAudioPrepareOptions options;
  options.sourceFormat = format;
  const DecodedAudioResult result = prepareDecodedAudio(
      OwnedFileDescriptor(descriptor), options);
  require(result.status == expected && result.audio == nullptr,
          name + " returns expected rejection");
  require(!descriptorOpen(descriptor), name + " closes descriptor once");
}

struct Fixture {
  size_t index;
  DecodedAudioSourceFormat format;
  uint32_t capability;
  size_t signatureBytes;
  const char* label;
};

std::string successJson(const DecodedAudioCodecCapabilities& capabilities,
                        const std::vector<CaseEvidence>& cases) {
  std::ostringstream output;
  output << "{\"format\":1,\"execution\":\"actual-packaged-zcore-runtime\""
         << ",\"result\":\"full dynamic matrix ok\""
         << ",\"proofContract\":\"singz-codec-target-proof-v1\""
         << ",\"proofSourceStamp\":\""
         << SINGZ_CODEC_TARGET_PROOF_SOURCE_STAMP << "\""
         << ",\"platformSourceStamp\":\""
         << SINGZ_CODEC_TARGET_PROOF_PLATFORM_STAMP << "\""
         << ",\"proofBuildStamp\":\""
         << SINGZ_CODEC_TARGET_PROOF_BUILD_STAMP << "\""
         << ",\"capabilityTag\":\"" << jsonEscape(decodedAudioCapabilityTag()) << "\""
         << ",\"capabilityMask\":" << capabilities.formatMask
         << ",\"dynamicFfmpeg\":true,\"completeProductMatrix\":true"
         << ",\"runtimeVersion\":\""
         << jsonEscape(capabilities.runtimeVersion == nullptr
                           ? ""
                           : capabilities.runtimeVersion)
         << "\",\"runtimeLicense\":\""
         << jsonEscape(capabilities.runtimeLicense == nullptr
                           ? ""
                           : capabilities.runtimeLicense)
         << "\",\"runtimeConfiguration\":\""
         << jsonEscape(avcodec_configuration()) << "\",\"fixtures\":[";
  for (size_t index = 0; index < std::size(kFixtureNames); ++index) {
    if (index != 0) output << ',';
    output << '"' << kFixtureNames[index] << '"';
  }
  output << "],\"cases\":[";
  for (size_t index = 0; index < cases.size(); ++index) {
    if (index != 0) output << ',';
    const auto& item = cases[index];
    output << "{\"name\":\"" << jsonEscape(item.name)
           << "\",\"result\":\"" << jsonEscape(item.result) << '"';
    if (item.sampleRate != 0) {
      output << ",\"sampleRate\":" << item.sampleRate
             << ",\"channels\":" << item.channels
             << ",\"frames\":" << item.frames;
    }
    output << '}';
  }
  output << "]}";
  return output.str();
}

std::string failureJson(std::string_view message) {
  return "{\"format\":1,\"execution\":\"actual-packaged-zcore-runtime\","
         "\"result\":\"failed\",\"error\":\"" + jsonEscape(message) + "\"}";
}

}  // namespace

std::string run(const std::vector<std::string>& fixturePaths) noexcept {
  try {
    require(fixturePaths.size() == std::size(kFixtureNames),
            "target proof requires exactly 12 ordered fixtures");
    for (size_t index = 0; index < fixturePaths.size(); ++index) {
      require(!fixturePaths[index].empty() &&
                  std::filesystem::is_regular_file(fixturePaths[index]),
              std::string(kFixtureNames[index]) + " is missing");
    }

    const DecodedAudioCodecCapabilities capabilities =
        decodedAudioCodecCapabilities();
    require(capabilities.dynamicallyLinkedFfmpeg,
            "zcore is not using replaceable dynamic FFmpeg");
    require(capabilities.completeProductMatrix &&
                capabilities.formatMask == kDecodedAudioProductFormatMask,
            "zcore does not expose the complete product codec matrix");
    require(capabilities.runtimeVersion != nullptr &&
                capabilities.runtimeLicense != nullptr &&
                std::strcmp(capabilities.runtimeLicense,
                            "LGPL version 2.1 or later") == 0,
            "zcore runtime provenance is unavailable");
    require(std::strcmp(decodedAudioCapabilityTag(),
                        "singz-prepared-audio-fd-ffmpeg-full-matrix-v3") == 0,
            "zcore release capability tag is not the full matrix");
    require(std::strcmp(avcodec_configuration(), avformat_configuration()) == 0,
            "loaded libavcodec/libavformat configurations differ");

    constexpr Fixture fixtures[] = {
        {0, DecodedAudioSourceFormat::Mp3, DecodedAudioCapabilityMp3, 10, "mp3"},
        {1, DecodedAudioSourceFormat::Aac, DecodedAudioCapabilityAac, 7, "aac"},
        {2, DecodedAudioSourceFormat::M4a, DecodedAudioCapabilityM4aAac, 12, "m4a-aac"},
        {3, DecodedAudioSourceFormat::M4a, DecodedAudioCapabilityM4aAlac, 12, "m4a-alac"},
        {4, DecodedAudioSourceFormat::Ogg, DecodedAudioCapabilityOggVorbis, 8, "ogg-vorbis"},
        {5, DecodedAudioSourceFormat::Opus, DecodedAudioCapabilityOggOpus, 8, "ogg-opus"},
        {6, DecodedAudioSourceFormat::Aiff, DecodedAudioCapabilityAiff, 12, "aiff"},
        {7, DecodedAudioSourceFormat::Aiff, DecodedAudioCapabilityAiff, 12, "aifc"},
    };

    std::vector<CaseEvidence> cases;
    cases.reserve(36);
    for (const Fixture& fixture : fixtures) {
      require((capabilities.formatMask & fixture.capability) != 0,
              std::string(fixture.label) + " capability is absent");
      cases.push_back(decodeOne(fixture.label, fixturePaths[fixture.index],
                                fixture.format));
      const std::string truncated = writeMutation(
          fixturePaths[fixture.index], std::string(fixture.label) + "-truncated",
          fixture.signatureBytes, false);
      expectRejected(std::string(fixture.label) + "-truncated", truncated,
                     fixture.format);
      std::remove(truncated.c_str());
      cases.push_back({std::string(fixture.label) + "-truncated", "rejected"});
      const std::string corrupt = writeMutation(
          fixturePaths[fixture.index], std::string(fixture.label) + "-corrupt",
          fixture.signatureBytes, true);
      expectRejected(std::string(fixture.label) + "-corrupt", corrupt,
                     fixture.format);
      std::remove(corrupt.c_str());
      cases.push_back({std::string(fixture.label) + "-corrupt", "rejected"});
    }

    {
      const int descriptor = openRead(fixturePaths[0]);
      require(descriptor >= 0, "declaration mismatch fixture opens");
      DecodedAudioPrepareOptions options;
      options.sourceFormat = DecodedAudioSourceFormat::Aiff;
      const auto result = prepareDecodedAudio(OwnedFileDescriptor(descriptor), options);
      require(result.status == DecodedAudioStatus::MalformedData &&
                  result.audio == nullptr && !descriptorOpen(descriptor),
              "declared format mismatch is rejected and closed");
      cases.push_back({"declaration-mismatch", "rejected"});
    }

    {
      const int descriptor = openRead(fixturePaths[0]);
      const auto result = prepareDecodedAudio(
          OwnedFileDescriptor(descriptor), {}, {nullptr, cancelImmediately});
      require(result.status == DecodedAudioStatus::Cancelled &&
                  result.audio == nullptr && !descriptorOpen(descriptor),
              "cancel-before-decode publishes nothing and closes");
      cases.push_back({"cancel-before", "cancelled"});
    }
    {
      CancelAfter state{0, 8};
      const int descriptor = openRead(fixturePaths[11]);
      const auto result = prepareDecodedAudio(
          OwnedFileDescriptor(descriptor), {}, {&state, cancelAfter});
      require(result.status == DecodedAudioStatus::Cancelled &&
                  result.audio == nullptr && !descriptorOpen(descriptor),
              "cancel-during-decode publishes nothing and closes");
      cases.push_back({"cancel-during", "cancelled"});
    }

    {
      DecodedAudioPrepareOptions options;
      options.maximumEncodedBytes = 8;
      const int descriptor = openRead(fixturePaths[2]);
      const auto result = prepareDecodedAudio(OwnedFileDescriptor(descriptor), options);
      require(result.status == DecodedAudioStatus::LimitExceeded &&
                  result.audio == nullptr && !descriptorOpen(descriptor),
              "encoded-byte limit rejects before publication and closes");
      cases.push_back({"encoded-byte-limit", "limit-exceeded"});
    }
    for (const auto [name, field] : {
             std::pair<const char*, int>{"frame-limit", 0},
             {"decoded-byte-limit", 1},
             {"working-byte-limit", 2},
         }) {
      DecodedAudioPrepareOptions options;
      options.sourceFormat = DecodedAudioSourceFormat::Mp3;
      if (field == 0) options.maximumFrames = 1;
      if (field == 1) options.maximumDecodedBytes = 4;
      if (field == 2) options.maximumWorkingBytes = 4;
      const int descriptor = openRead(fixturePaths[0]);
      const auto result = prepareDecodedAudio(OwnedFileDescriptor(descriptor), options);
      require(result.status == DecodedAudioStatus::LimitExceeded &&
                  result.audio == nullptr && !descriptorOpen(descriptor),
              std::string(name) + " rejects without publication and closes");
      cases.push_back({name, "limit-exceeded"});
    }

    expectRejected("audio-plus-video", fixturePaths[8],
                   DecodedAudioSourceFormat::M4a,
                   DecodedAudioStatus::UnsupportedFormat);
    cases.push_back({"audio-plus-video", "rejected"});
    expectRejected("video-only", fixturePaths[9],
                   DecodedAudioSourceFormat::M4a,
                   DecodedAudioStatus::UnsupportedFormat);
    cases.push_back({"video-only", "rejected"});
    expectRejected("unsupported-ogg-codec", fixturePaths[10],
                   DecodedAudioSourceFormat::Ogg,
                   DecodedAudioStatus::UnsupportedFormat);
    cases.push_back({"unsupported-ogg-codec", "rejected"});

    return successJson(capabilities, cases);
  } catch (const Failure& failure) {
    return failureJson(failure.message);
  } catch (const std::exception& exception) {
    return failureJson(exception.what());
  } catch (...) {
    return failureJson("unknown target proof failure");
  }
}

}  // namespace singz::codec_target_proof
