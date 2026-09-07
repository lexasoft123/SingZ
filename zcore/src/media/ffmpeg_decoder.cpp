#include "decoded_audio_internal.h"

#if defined(SINGZ_ZCORE_FFMPEG)

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/mem.h>
#include <libswresample/swresample.h>
}

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <zcore/base/file_compat.h>
#include <limits>
#include <memory>
#include <new>
#include <vector>

namespace singz::media_internal {
namespace {

constexpr int kIoBufferBytes = 32 * 1024;
constexpr uint32_t kMinimumSampleRate = 8000;
constexpr uint32_t kMaximumSampleRate = 768000;

struct FfmpegIo {
  std::FILE* file = nullptr;
  DecodeCancellation cancellation{};
  bool ioError = false;
};

int readPacket(void* opaque, uint8_t* buffer, int size) noexcept {
  auto* io = static_cast<FfmpegIo*>(opaque);
  if (io == nullptr || io->file == nullptr || buffer == nullptr || size <= 0)
    return AVERROR(EINVAL);
  if (io->cancellation.isRequested()) return AVERROR_EXIT;
  const size_t read = std::fread(buffer, 1, static_cast<size_t>(size), io->file);
  if (read != 0) return static_cast<int>(read);
  if (std::ferror(io->file) != 0) {
    io->ioError = true;
    return AVERROR(EIO);
  }
  return AVERROR_EOF;
}

int64_t seekPacket(void* opaque, int64_t offset, int whence) noexcept {
  auto* io = static_cast<FfmpegIo*>(opaque);
  if (io == nullptr || io->file == nullptr) return AVERROR(EINVAL);
  if (io->cancellation.isRequested()) return AVERROR_EXIT;
  if (whence == AVSEEK_SIZE) {
    const auto original = ftello(io->file);
    if (original < 0 || fseeko(io->file, 0, SEEK_END) != 0) {
      io->ioError = true;
      return AVERROR(EIO);
    }
    const auto end = ftello(io->file);
    if (end < 0 || fseeko(io->file, original, SEEK_SET) != 0) {
      io->ioError = true;
      return AVERROR(EIO);
    }
    return static_cast<int64_t>(end);
  }
  const int origin = (whence & ~AVSEEK_FORCE) == SEEK_SET ? SEEK_SET :
      (whence & ~AVSEEK_FORCE) == SEEK_CUR ? SEEK_CUR :
      (whence & ~AVSEEK_FORCE) == SEEK_END ? SEEK_END : -1;
  if (origin < 0 || fseeko(io->file, offset, origin) != 0) {
    io->ioError = true;
    return AVERROR(EIO);
  }
  const auto position = ftello(io->file);
  if (position < 0) {
    io->ioError = true;
    return AVERROR(EIO);
  }
  return static_cast<int64_t>(position);
}

int interruptDecode(void* opaque) noexcept {
  auto* io = static_cast<FfmpegIo*>(opaque);
  return io != nullptr && io->cancellation.isRequested() ? 1 : 0;
}

struct AvioOwner {
  AVIOContext* value = nullptr;
  ~AvioOwner() {
    if (value == nullptr) return;
    // avio_context_free() releases only the struct; the I/O buffer handed to
    // avio_alloc_context() stays ours, and libavformat may have swapped it
    // for a larger one while probing, so free value->buffer, never the
    // pointer this file allocated.
    av_freep(&value->buffer);
    avio_context_free(&value);
  }
};

struct FormatOwner {
  AVFormatContext* value = nullptr;
  ~FormatOwner() {
    if (value != nullptr) avformat_close_input(&value);
  }
};

struct CodecOwner {
  AVCodecContext* value = nullptr;
  ~CodecOwner() { avcodec_free_context(&value); }
};

struct PacketOwner {
  AVPacket* value = av_packet_alloc();
  ~PacketOwner() { av_packet_free(&value); }
};

struct FrameOwner {
  AVFrame* value = av_frame_alloc();
  ~FrameOwner() { av_frame_free(&value); }
};

struct SwrOwner {
  SwrContext* value = nullptr;
  ~SwrOwner() { swr_free(&value); }
};

DecodedAudioStatus statusForError(int error, const FfmpegIo& io,
                                  DecodeCancellation cancellation) noexcept {
  if (cancellation.isRequested() || error == AVERROR_EXIT)
    return DecodedAudioStatus::Cancelled;
  if (io.ioError || error == AVERROR(EIO)) return DecodedAudioStatus::IoError;
  if (error == AVERROR(ENOMEM)) return DecodedAudioStatus::ResourceExhausted;
  return DecodedAudioStatus::MalformedData;
}

const AVInputFormat* inputFormat(DecodedAudioSourceFormat format) noexcept {
  switch (format) {
    case DecodedAudioSourceFormat::Mp3:
      return av_find_input_format("mp3");
    case DecodedAudioSourceFormat::M4a:
      return av_find_input_format("mov");
    case DecodedAudioSourceFormat::Aac:
      return av_find_input_format("aac");
    case DecodedAudioSourceFormat::Ogg:
      return av_find_input_format("ogg");
    case DecodedAudioSourceFormat::Aiff:
      return av_find_input_format("aiff");
    default:
      return nullptr;
  }
}

bool allowedAiffCodec(AVCodecID codec) noexcept {
  switch (codec) {
    case AV_CODEC_ID_PCM_S8:
    case AV_CODEC_ID_PCM_U8:
    case AV_CODEC_ID_PCM_S16BE:
    case AV_CODEC_ID_PCM_S16LE:
    case AV_CODEC_ID_PCM_S24BE:
    case AV_CODEC_ID_PCM_S24LE:
    case AV_CODEC_ID_PCM_S32BE:
    case AV_CODEC_ID_PCM_S32LE:
    case AV_CODEC_ID_PCM_F32BE:
    case AV_CODEC_ID_PCM_F32LE:
    case AV_CODEC_ID_PCM_F64BE:
    case AV_CODEC_ID_PCM_F64LE:
    case AV_CODEC_ID_PCM_ALAW:
    case AV_CODEC_ID_PCM_MULAW:
      return true;
    default:
      return false;
  }
}

bool hasDecoder(AVCodecID codec) noexcept {
  return avcodec_find_decoder(codec) != nullptr;
}

bool hasAllAiffPcmDecoders() noexcept {
  constexpr AVCodecID required[] = {
      AV_CODEC_ID_PCM_S8, AV_CODEC_ID_PCM_U8,
      AV_CODEC_ID_PCM_S16BE, AV_CODEC_ID_PCM_S16LE,
      AV_CODEC_ID_PCM_S24BE, AV_CODEC_ID_PCM_S24LE,
      AV_CODEC_ID_PCM_S32BE, AV_CODEC_ID_PCM_S32LE,
      AV_CODEC_ID_PCM_F32BE, AV_CODEC_ID_PCM_F32LE,
      AV_CODEC_ID_PCM_F64BE, AV_CODEC_ID_PCM_F64LE,
      AV_CODEC_ID_PCM_ALAW, AV_CODEC_ID_PCM_MULAW};
  for (AVCodecID codec : required) {
    if (!hasDecoder(codec)) return false;
  }
  return true;
}

bool allowedCodec(DecodedAudioSourceFormat detected,
                  DecodedAudioSourceFormat declared,
                  AVCodecID codec) noexcept {
  switch (detected) {
    case DecodedAudioSourceFormat::Mp3:
      return codec == AV_CODEC_ID_MP3;
    case DecodedAudioSourceFormat::M4a:
      return codec == AV_CODEC_ID_AAC || codec == AV_CODEC_ID_ALAC;
    case DecodedAudioSourceFormat::Aac:
      return codec == AV_CODEC_ID_AAC;
    case DecodedAudioSourceFormat::Ogg:
      if (declared == DecodedAudioSourceFormat::Opus)
        return codec == AV_CODEC_ID_OPUS;
      return codec == AV_CODEC_ID_VORBIS || codec == AV_CODEC_ID_OPUS;
    case DecodedAudioSourceFormat::Aiff:
      return allowedAiffCodec(codec);
    default:
      return false;
  }
}

bool withinLimits(uint32_t channels, uint64_t frames,
                  const DecodedAudioPrepareOptions& options) noexcept {
  if (channels == 0 || channels > options.maximumChannels ||
      frames > options.maximumFrames ||
      (frames != 0 && channels > std::numeric_limits<uint64_t>::max() / frames))
    return false;
  const uint64_t samples = frames * channels;
  return samples <= std::numeric_limits<size_t>::max() / sizeof(float) &&
      samples * sizeof(float) <= options.maximumDecodedBytes &&
      samples * sizeof(float) <= options.maximumWorkingBytes;
}

DecodedAudioStatus appendConverted(
    SwrContext* swr, const AVFrame* frame,
    const DecodedAudioPrepareOptions& options,
    DecodeCancellation cancellation, WorkingAudio* output) {
  if (cancellation.isRequested()) return DecodedAudioStatus::Cancelled;
  const int capacity = swr_get_out_samples(swr, frame == nullptr ? 0 : frame->nb_samples);
  if (capacity < 0) return DecodedAudioStatus::MalformedData;
  if (capacity == 0 && frame == nullptr) return DecodedAudioStatus::Ok;
  const uint32_t channels = static_cast<uint32_t>(output->channels.size());
  if (channels == 0 || static_cast<uint64_t>(capacity) >
          std::numeric_limits<size_t>::max() / channels)
    return DecodedAudioStatus::LimitExceeded;
  const size_t temporarySamples = static_cast<size_t>(capacity) * channels;
  const size_t workingSampleLimit = options.maximumWorkingBytes / sizeof(float);
  size_t retainedCapacity = 0;
  for (const auto& channel : output->channels) {
    if (channel.capacity() > std::numeric_limits<size_t>::max() - retainedCapacity)
      return DecodedAudioStatus::LimitExceeded;
    retainedCapacity += channel.capacity();
  }
  if (temporarySamples > std::numeric_limits<size_t>::max() - retainedCapacity ||
      temporarySamples + retainedCapacity > workingSampleLimit)
    return DecodedAudioStatus::LimitExceeded;

  std::vector<float> temporary(temporarySamples);
  if (temporary.capacity() > std::numeric_limits<size_t>::max() - retainedCapacity ||
      temporary.capacity() + retainedCapacity > workingSampleLimit)
    return DecodedAudioStatus::LimitExceeded;
  std::vector<uint8_t*> planes(channels);
  for (uint32_t channel = 0; channel < channels; ++channel)
    planes[channel] = reinterpret_cast<uint8_t*>(
        temporary.data() + static_cast<size_t>(channel) * capacity);
  const uint8_t** input = frame == nullptr
      ? nullptr
      : const_cast<const uint8_t**>(frame->extended_data);
  const int produced = swr_convert(
      swr, planes.data(), capacity, input, frame == nullptr ? 0 : frame->nb_samples);
  if (produced < 0) return DecodedAudioStatus::MalformedData;
  if (produced == 0) return DecodedAudioStatus::Ok;
  const uint64_t oldFrames = output->frameCount;
  const uint64_t newFrames = oldFrames + static_cast<uint64_t>(produced);
  if (newFrames < oldFrames || !withinLimits(channels, newFrames, options))
    return DecodedAudioStatus::LimitExceeded;
  // Validate converted samples before replacing any retained channel. A bad
  // later plane must not leave the working result partially advanced.
  for (uint32_t channel = 0; channel < channels; ++channel) {
    const float* source = temporary.data() +
        static_cast<size_t>(channel) * capacity;
    for (int sample = 0; sample < produced; ++sample) {
      if (!std::isfinite(source[sample]))
        return DecodedAudioStatus::MalformedData;
    }
  }
  for (uint32_t channel = 0; channel < channels; ++channel) {
    auto& destination = output->channels[channel];
    const size_t oldCapacity = destination.capacity();
    const float* source = temporary.data() +
        static_cast<size_t>(channel) * capacity;
    const size_t requiredCapacity = static_cast<size_t>(newFrames);
    if (requiredCapacity > oldCapacity) {
      // Grow at an explicit factor so decoding remains amortized linear, but
      // construct the replacement at that exact size instead of delegating a
      // hidden growth factor to vector::resize. If the spare capacity would
      // exceed this caller's budget, fall back to the exact required size.
      size_t targetCapacity = requiredCapacity;
      if (oldCapacity <= std::numeric_limits<size_t>::max() / 2) {
        const size_t doubled = oldCapacity * 2;
        if (doubled > targetCapacity && doubled <= options.maximumFrames)
          targetCapacity = doubled;
      }
      const size_t liveBeforeReplacement = temporary.capacity() + retainedCapacity;
      if (targetCapacity > workingSampleLimit - liveBeforeReplacement)
        targetCapacity = requiredCapacity;
      if (requiredCapacity > workingSampleLimit - liveBeforeReplacement)
        return DecodedAudioStatus::LimitExceeded;
      // A sized vector asks the supported std::allocator implementations for
      // exactly targetCapacity samples. The old destination remains live
      // until swap, and liveBeforeReplacement includes it.
      std::vector<float> replacement(targetCapacity);
      if (replacement.capacity() >
              std::numeric_limits<size_t>::max() - liveBeforeReplacement ||
          liveBeforeReplacement + replacement.capacity() > workingSampleLimit)
        return DecodedAudioStatus::LimitExceeded;
      std::copy(destination.begin(), destination.end(), replacement.begin());
      std::copy_n(source, produced,
                  replacement.begin() + static_cast<size_t>(oldFrames));
      replacement.resize(requiredCapacity);
      destination.swap(replacement);
      retainedCapacity = retainedCapacity - oldCapacity + destination.capacity();
    } else {
      destination.resize(requiredCapacity);
      std::copy_n(source, produced,
                  destination.begin() + static_cast<size_t>(oldFrames));
    }
  }
  output->frameCount = newFrames;
  return cancellation.isRequested() ? DecodedAudioStatus::Cancelled
                                    : DecodedAudioStatus::Ok;
}

}  // namespace

const char* ffmpegRuntimeVersion() noexcept { return av_version_info(); }

const char* ffmpegRuntimeLicense() noexcept { return avcodec_license(); }

bool ffmpegRuntimeCompatible() noexcept {
  const char* configuration = avcodec_configuration();
  const char* formatConfiguration = avformat_configuration();
  const char* utilConfiguration = avutil_configuration();
  const char* resampleConfiguration = swresample_configuration();
  const char* license = avcodec_license();
  const bool lgplPolicy = configuration != nullptr &&
      license != nullptr &&
      // FFmpeg's avcodec_license() API returns this canonical short string;
      // the full GNU license title lives in the distributed COPYING file.
      // Match the pinned LGPL build exactly so a GPL/nonfree or differently
      // licensed runtime cannot become compatible through loose substring
      // matching.
      std::strcmp(license, "LGPL version 2.1 or later") == 0 &&
      std::strstr(configuration, "--enable-gpl") == nullptr &&
      std::strstr(configuration, "--enable-nonfree") == nullptr;
  const bool oneBuild = configuration != nullptr &&
      formatConfiguration != nullptr &&
      utilConfiguration != nullptr && resampleConfiguration != nullptr &&
      std::strcmp(configuration, formatConfiguration) == 0 &&
      std::strcmp(configuration, utilConfiguration) == 0 &&
      std::strcmp(configuration, resampleConfiguration) == 0;
  return lgplPolicy && oneBuild &&
      (avcodec_version() >> 16) == LIBAVCODEC_VERSION_MAJOR &&
      (avformat_version() >> 16) == LIBAVFORMAT_VERSION_MAJOR &&
      (avutil_version() >> 16) == LIBAVUTIL_VERSION_MAJOR &&
      (swresample_version() >> 16) == LIBSWRESAMPLE_VERSION_MAJOR;
}

uint32_t ffmpegCodecCapabilityMask() noexcept {
  if (!ffmpegRuntimeCompatible()) return 0;
  uint32_t mask = 0;
  const bool mp3 = av_find_input_format("mp3") != nullptr;
  const bool mov = av_find_input_format("mov") != nullptr;
  const bool aac = av_find_input_format("aac") != nullptr;
  const bool ogg = av_find_input_format("ogg") != nullptr;
  const bool aiff = av_find_input_format("aiff") != nullptr;
  if (mp3 && hasDecoder(AV_CODEC_ID_MP3))
    mask |= DecodedAudioCapabilityMp3;
  if (mov && hasDecoder(AV_CODEC_ID_AAC))
    mask |= DecodedAudioCapabilityM4aAac;
  if (mov && hasDecoder(AV_CODEC_ID_ALAC))
    mask |= DecodedAudioCapabilityM4aAlac;
  if (aac && hasDecoder(AV_CODEC_ID_AAC))
    mask |= DecodedAudioCapabilityAac;
  if (ogg && hasDecoder(AV_CODEC_ID_VORBIS))
    mask |= DecodedAudioCapabilityOggVorbis;
  if (ogg && hasDecoder(AV_CODEC_ID_OPUS))
    mask |= DecodedAudioCapabilityOggOpus;
  if (aiff && hasAllAiffPcmDecoders())
    mask |= DecodedAudioCapabilityAiff;
  return mask;
}

DecodedAudioStatus decodeFfmpeg(
    std::FILE* file, DecodedAudioSourceFormat detectedFormat,
    DecodedAudioSourceFormat declaredFormat,
    const DecodedAudioPrepareOptions& options,
    DecodeCancellation cancellation, WorkingAudio* output) noexcept {
  try {
    if (file == nullptr || output == nullptr || !ffmpegRuntimeCompatible())
      return DecodedAudioStatus::UnsupportedFormat;
    if (fseeko(file, 0, SEEK_SET) != 0) return DecodedAudioStatus::IoError;
    const AVInputFormat* demuxer = inputFormat(detectedFormat);
    if (demuxer == nullptr) return DecodedAudioStatus::UnsupportedFormat;

    FfmpegIo io{file, cancellation};
    auto* ioBuffer = static_cast<unsigned char*>(av_malloc(kIoBufferBytes));
    if (ioBuffer == nullptr) return DecodedAudioStatus::ResourceExhausted;
    AvioOwner avio;
    avio.value = avio_alloc_context(
        ioBuffer, kIoBufferBytes, 0, &io, readPacket, nullptr, seekPacket);
    if (avio.value == nullptr) {
      av_free(ioBuffer);
      return DecodedAudioStatus::ResourceExhausted;
    }

    FormatOwner format;
    format.value = avformat_alloc_context();
    if (format.value == nullptr) return DecodedAudioStatus::ResourceExhausted;
    format.value->pb = avio.value;
    format.value->flags |= AVFMT_FLAG_CUSTOM_IO;
    format.value->interrupt_callback = {interruptDecode, &io};
    format.value->probesize = std::min<int64_t>(
        static_cast<int64_t>(options.maximumEncodedBytes), 256 * 1024);
    format.value->max_analyze_duration = 5 * AV_TIME_BASE;
    format.value->max_streams = 8;
    int error = avformat_open_input(&format.value, nullptr, demuxer, nullptr);
    if (error < 0) return statusForError(error, io, cancellation);
    error = avformat_find_stream_info(format.value, nullptr);
    if (error < 0) return statusForError(error, io, cancellation);

    // Prepared project media is deliberately a single-audio-stream product
    // format. Reject cover art, video, subtitles and second audio programs:
    // accepting them would make probing and packet work depend on content the
    // caller neither selected nor bounded as an audio lane.
    if (format.value->nb_streams != 1 ||
        format.value->streams[0]->codecpar->codec_type != AVMEDIA_TYPE_AUDIO)
      return DecodedAudioStatus::UnsupportedFormat;
    const int streamIndex = 0;
    AVCodecParameters* parameters = format.value->streams[streamIndex]->codecpar;
    if (!allowedCodec(detectedFormat, declaredFormat, parameters->codec_id))
      return DecodedAudioStatus::UnsupportedFormat;
    const AVCodec* decoder = avcodec_find_decoder(parameters->codec_id);
    if (decoder == nullptr) return DecodedAudioStatus::UnsupportedFormat;

    CodecOwner codec;
    codec.value = avcodec_alloc_context3(decoder);
    if (codec.value == nullptr) return DecodedAudioStatus::ResourceExhausted;
    error = avcodec_parameters_to_context(codec.value, parameters);
    if (error < 0) return statusForError(error, io, cancellation);
    codec.value->err_recognition = AV_EF_CRCCHECK | AV_EF_CAREFUL | AV_EF_EXPLODE;
    error = avcodec_open2(codec.value, decoder, nullptr);
    if (error < 0) return statusForError(error, io, cancellation);

    const int channels = codec.value->ch_layout.nb_channels;
    const int sampleRate = codec.value->sample_rate;
    if (channels <= 0 || channels > static_cast<int>(options.maximumChannels) ||
        sampleRate < static_cast<int>(kMinimumSampleRate) ||
        sampleRate > static_cast<int>(kMaximumSampleRate))
      return DecodedAudioStatus::UnsupportedFormat;
    if (!withinLimits(static_cast<uint32_t>(channels), 0, options))
      return DecodedAudioStatus::LimitExceeded;

    AVChannelLayout inputLayout{};
    if (av_channel_layout_check(&codec.value->ch_layout))
      error = av_channel_layout_copy(&inputLayout, &codec.value->ch_layout);
    else {
      av_channel_layout_default(&inputLayout, channels);
      error = av_channel_layout_check(&inputLayout) ? 0 : AVERROR(EINVAL);
    }
    if (error < 0) return statusForError(error, io, cancellation);
    AVChannelLayout outputLayout{};
    error = av_channel_layout_copy(&outputLayout, &inputLayout);
    if (error < 0) {
      av_channel_layout_uninit(&inputLayout);
      return statusForError(error, io, cancellation);
    }
    SwrOwner swr;
    error = swr_alloc_set_opts2(
        &swr.value, &outputLayout, AV_SAMPLE_FMT_FLTP, sampleRate,
        &inputLayout, codec.value->sample_fmt, sampleRate, 0, nullptr);
    av_channel_layout_uninit(&inputLayout);
    av_channel_layout_uninit(&outputLayout);
    if (error < 0 || swr.value == nullptr)
      return statusForError(error < 0 ? error : AVERROR(ENOMEM), io, cancellation);
    error = swr_init(swr.value);
    if (error < 0) return statusForError(error, io, cancellation);

    WorkingAudio candidate;
    candidate.sampleRate = static_cast<uint32_t>(sampleRate);
    candidate.channels.resize(static_cast<size_t>(channels));
    PacketOwner packet;
    FrameOwner frame;
    if (packet.value == nullptr || frame.value == nullptr)
      return DecodedAudioStatus::ResourceExhausted;

    auto receiveFrames = [&](bool flushing) -> DecodedAudioStatus {
      for (;;) {
        if (cancellation.isRequested()) return DecodedAudioStatus::Cancelled;
        const int received = avcodec_receive_frame(codec.value, frame.value);
        if (received == AVERROR(EAGAIN) || received == AVERROR_EOF)
          return DecodedAudioStatus::Ok;
        if (received < 0) return statusForError(received, io, cancellation);
        if (frame.value->sample_rate != sampleRate ||
            frame.value->ch_layout.nb_channels != channels ||
            frame.value->nb_samples < 0) {
          av_frame_unref(frame.value);
          return DecodedAudioStatus::MalformedData;
        }
        DecodedAudioStatus status = appendConverted(
            swr.value, frame.value, options, cancellation, &candidate);
        av_frame_unref(frame.value);
        if (status != DecodedAudioStatus::Ok) return status;
        if (flushing && candidate.frameCount > options.maximumFrames)
          return DecodedAudioStatus::LimitExceeded;
      }
    };

    for (;;) {
      if (cancellation.isRequested()) return DecodedAudioStatus::Cancelled;
      error = av_read_frame(format.value, packet.value);
      if (error == AVERROR_EOF) break;
      if (error < 0) return statusForError(error, io, cancellation);
      if (packet.value->stream_index == streamIndex) {
        if ((packet.value->flags & AV_PKT_FLAG_CORRUPT) != 0) {
          av_packet_unref(packet.value);
          return DecodedAudioStatus::MalformedData;
        }
        error = avcodec_send_packet(codec.value, packet.value);
        av_packet_unref(packet.value);
        if (error < 0) return statusForError(error, io, cancellation);
        const DecodedAudioStatus status = receiveFrames(false);
        if (status != DecodedAudioStatus::Ok) return status;
      } else {
        av_packet_unref(packet.value);
      }
    }
    error = avcodec_send_packet(codec.value, nullptr);
    if (error < 0 && error != AVERROR_EOF)
      return statusForError(error, io, cancellation);
    DecodedAudioStatus status = receiveFrames(true);
    if (status != DecodedAudioStatus::Ok) return status;
    for (;;) {
      const uint64_t before = candidate.frameCount;
      status = appendConverted(swr.value, nullptr, options, cancellation, &candidate);
      if (status != DecodedAudioStatus::Ok) return status;
      if (candidate.frameCount == before) break;
    }
    if (cancellation.isRequested()) return DecodedAudioStatus::Cancelled;
    if (candidate.frameCount == 0) return DecodedAudioStatus::MalformedData;
    *output = std::move(candidate);
    return DecodedAudioStatus::Ok;
  } catch (const std::bad_alloc&) {
    return DecodedAudioStatus::ResourceExhausted;
  } catch (...) {
    return DecodedAudioStatus::MalformedData;
  }
}

}  // namespace singz::media_internal

#endif
