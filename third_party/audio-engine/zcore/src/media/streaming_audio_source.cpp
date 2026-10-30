// `openStreamingAudioSource`: the one door to a streaming source, whatever the
// format. It takes the descriptor, decides the format with the same detector
// `prepareDecodedAudio` uses (media_format.cpp), and hands the descriptor to
// that format's implementation:
//
//   WAV   wav_streaming_source.cpp   every frame addressable, seek is arithmetic
//   FLAC  flac_streaming_source.cpp  libFLAC, seektable or its binary search
//   MP3   mp3_streaming_source.cpp   frame index at open, seek decodes a run-up
//
// Anything else is UnsupportedFormat — a container the detector recognises but
// no streaming implementation reads (Ogg, M4A, AAC, AIFF) as much as bytes that
// are no audio at all. The caller's answer to a refusal is the whole-file
// decode (or the legacy engine), one lane at a time, never a failed song.
#include <zcore/media/streaming_audio_source.h>

#include "decoded_audio_internal.h"

namespace singz {

std::unique_ptr<StreamingAudioSource> openStreamingAudioSource(
    OwnedFileDescriptor descriptor, const StreamingAudioOpenOptions& options,
    DecodedAudioStatus* status) {
  auto set = [status](DecodedAudioStatus s) {
    if (status != nullptr) *status = s;
  };
  if (!descriptor.valid()) {
    set(DecodedAudioStatus::InvalidArgument);
    return nullptr;
  }
  const int fd = media_internal::consumeAsDescriptor(&descriptor);
  if (fd < 0) {
    set(DecodedAudioStatus::IoError);
    return nullptr;
  }
  // From here the descriptor is ours to close on a refusal, or the chosen
  // source's — which owns it whatever it returns.
  auto refuse = [&](DecodedAudioStatus s) {
    media_internal::closeRawDescriptor(fd);
    set(s);
    return nullptr;
  };
  const int64_t length = media_internal::fileLength(fd);
  if (length < 0) return refuse(DecodedAudioStatus::IoError);
  DecodedAudioSourceFormat detected = DecodedAudioSourceFormat::Auto;
  const DecodedAudioStatus detection = media_internal::detectMediaFormat(
      media_internal::descriptorByteSource(&fd, static_cast<uint64_t>(length)), &detected);
  if (detection != DecodedAudioStatus::Ok) return refuse(detection);
  // A declared format the content contradicts is refused, never read as what
  // the content really is: the declaration is what the product boundary
  // authorised.
  if (!media_internal::declarationMatches(options.sourceFormat, detected))
    return refuse(DecodedAudioStatus::UnsupportedFormat);
  switch (detected) {
    case DecodedAudioSourceFormat::Wav:
      return media_internal::openWavStreamingSource(fd, options, status);
    case DecodedAudioSourceFormat::Flac:
      return media_internal::openFlacStreamingSource(fd, options, status);
    case DecodedAudioSourceFormat::Mp3:
      return media_internal::openMp3StreamingSource(fd, options, status);
    default:
      return refuse(DecodedAudioStatus::UnsupportedFormat);
  }
}

}  // namespace singz
