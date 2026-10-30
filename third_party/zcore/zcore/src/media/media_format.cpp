// Which container a file is, decided ONCE, by content, for both ways the core
// reads audio: `prepareDecodedAudio` (the whole file) and
// `openStreamingAudioSource` (a moving window). One detector means a file
// cannot be one format to the decode and another to the stream — the lane the
// desktop measures through a streaming source is checked against a decode of
// the same file, and a phone streams exactly the lanes it would otherwise have
// decoded.
//
// By content, never by name: a FLAC called `.wav` has bitten this codebase
// before (`zcore/media/flac_io.h`). The extension a product boundary saw
// arrives separately, as the DECLARED format, and each path refuses a
// declaration the content contradicts.
//
// The answer is a classification, not a validation. A RIFF that is not WAVE
// still says Wav, so the WAV parser can call it MalformedData rather than an
// unknown format; an MPEG sync word says Mp3, and the MP3 parser is what
// decides whether a Layer III stream is really there (it searches for a chain
// of frames). MP3 has no magic — an ID3 tag is optional and a sync pattern
// occurs in arbitrary data — which is why it is the last guess and why the
// parser, not this, is the arbiter.
#include "decoded_audio_internal.h"

#include <cstring>

namespace singz::media_internal {

bool skipId3v2Tags(const MediaByteSource& source, uint64_t* offset) noexcept {
  for (;;) {
    unsigned char b[10] = {0};
    const int64_t got = readFully(source, *offset, b, sizeof(b));
    if (got < 0) return false;
    if (got < 10 || std::memcmp(b, "ID3", 3) != 0) return true;
    // A size that is not synchsafe is not a tag header.
    if (((b[6] | b[7] | b[8] | b[9]) & 0x80) != 0) return true;
    const uint64_t size = (static_cast<uint64_t>(b[6]) << 21) |
        (static_cast<uint64_t>(b[7]) << 14) | (static_cast<uint64_t>(b[8]) << 7) |
        static_cast<uint64_t>(b[9]);
    // An ID3v2.4 footer adds ten more bytes.
    const uint64_t total = 10 + size + ((b[5] & 0x10) != 0 ? 10 : 0);
    // A tag that runs off the end is data, not a tag.
    if (*offset + total > source.length) return true;
    *offset += total;
  }
}

DecodedAudioStatus detectMediaFormat(const MediaByteSource& source,
                                     DecodedAudioSourceFormat* format) noexcept {
  *format = DecodedAudioSourceFormat::Auto;
  unsigned char b[16] = {0};
  const int64_t got = readFully(source, 0, b, sizeof(b));
  if (got < 0) return DecodedAudioStatus::IoError;
  const size_t size = static_cast<size_t>(got);
  if (size >= 4 && std::memcmp(b, "RIFF", 4) == 0) {
    *format = DecodedAudioSourceFormat::Wav;
  } else if (size >= 4 && std::memcmp(b, "fLaC", 4) == 0) {
    *format = DecodedAudioSourceFormat::Flac;
  } else if (size >= 4 && std::memcmp(b, "OggS", 4) == 0) {
    *format = DecodedAudioSourceFormat::Ogg;
  } else if (size >= 12 && std::memcmp(b, "FORM", 4) == 0 &&
             (std::memcmp(b + 8, "AIFF", 4) == 0 || std::memcmp(b + 8, "AIFC", 4) == 0)) {
    *format = DecodedAudioSourceFormat::Aiff;
  } else if (size >= 12 && std::memcmp(b + 4, "ftyp", 4) == 0) {
    *format = DecodedAudioSourceFormat::M4a;
  } else if (size >= 3 && std::memcmp(b, "ID3", 3) == 0) {
    // An ID3v2 tag is legal before FLAC as well as MP3; look past it.
    uint64_t audio = 0;
    if (!skipId3v2Tags(source, &audio)) return DecodedAudioStatus::IoError;
    unsigned char magic[4] = {0};
    const int64_t m = readFully(source, audio, magic, sizeof(magic));
    if (m < 0) return DecodedAudioStatus::IoError;
    *format = m == 4 && std::memcmp(magic, "fLaC", 4) == 0 ? DecodedAudioSourceFormat::Flac
                                                          : DecodedAudioSourceFormat::Mp3;
  } else if (size >= 2 && b[0] == 0xff && (b[1] & 0xf6u) == 0xf0u) {
    // ADTS: an MPEG sync with the layer bits zero.
    *format = DecodedAudioSourceFormat::Aac;
  } else if (size >= 2 && b[0] == 0xff && (b[1] & 0xe0u) == 0xe0u && (b[1] & 0x06u) != 0) {
    *format = DecodedAudioSourceFormat::Mp3;
  }
  return DecodedAudioStatus::Ok;
}

bool declarationMatches(DecodedAudioSourceFormat declared,
                        DecodedAudioSourceFormat detected) noexcept {
  if (declared == DecodedAudioSourceFormat::Auto) return true;
  // One Ogg container carries both Vorbis and Opus.
  if (detected == DecodedAudioSourceFormat::Ogg)
    return declared == DecodedAudioSourceFormat::Ogg ||
        declared == DecodedAudioSourceFormat::Opus;
  return declared == detected;
}

}  // namespace singz::media_internal
