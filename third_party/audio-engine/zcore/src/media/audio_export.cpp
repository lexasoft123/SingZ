#include <zcore/media/audio_export.h>
#include <FLAC/stream_encoder.h>
extern "C" {
#include <lame.h>
}
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <memory>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#define fdopen _fdopen
#endif

namespace singz {
namespace {
using File = std::unique_ptr<std::FILE, decltype(&std::fclose)>;
FLAC__StreamEncoderWriteStatus writeFlac(const FLAC__StreamEncoder*, const FLAC__byte bytes[], size_t count, unsigned, unsigned, void* context) {
  auto* file = static_cast<std::FILE*>(context);
  return std::fwrite(bytes, 1, count, file) == count ? FLAC__STREAM_ENCODER_WRITE_STATUS_OK : FLAC__STREAM_ENCODER_WRITE_STATUS_FATAL_ERROR;
}
int16_t quantize(float value) {
  if (!std::isfinite(value)) return 0;
  return static_cast<int16_t>(std::clamp(std::lround(static_cast<double>(value) * 32768.0), -32768L, 32767L));
}
void little(std::array<unsigned char, 44>& header, size_t at, uint32_t value, size_t bytes) {
  for (size_t i = 0; i < bytes; ++i) header[at + i] = static_cast<unsigned char>(value >> (i * 8));
}
}
AudioExportResult exportAudioMix(std::vector<OwnedFileDescriptor> sources, OwnedFileDescriptor destination,
                             AudioExportFormat format, DecodeCancellation cancel) noexcept {
  try {
    DecodedAudioPrepareOptions options;
    options.maximumChannels = 2;
    if (sources.empty() || sources.size() > 64) return {false, "Invalid export sources"};
    if (format == AudioExportFormat::Mp3 || sources.size() > 1) options.requiredSampleRate = 44100;
    std::vector<std::shared_ptr<const DecodedAudio>> decodedSources;
    size_t retained = 0;
    uint32_t channels = 0, sampleRate = 0;
    uint64_t frames = 0;
    for (auto& source : sources) {
      options.maximumDecodedBytes = (size_t{1} << 30) - retained;
      auto decoded = prepareDecodedAudio(std::move(source), options, cancel);
      if (!decoded.ok()) return {false, cancel.isRequested() ? "Export cancelled" : "Could not decode source audio"};
      const auto& audio = *decoded.audio;
      if (audio.channelCount() == 0 || audio.channelCount() > 2 || audio.frameCount() == 0)
        return {false, "Export requires mono or stereo audio"};
      retained += audio.retainedBytes();
      channels = std::max(channels, audio.channelCount());
      frames = std::max(frames, audio.frameCount());
      sampleRate = audio.sampleRate();
      decodedSources.push_back(std::move(decoded.audio));
    }
    auto sample = [&](uint64_t frame, uint32_t channel) {
      double sum = 0;
      for (const auto& audio : decodedSources) {
        if (frame < audio->frameCount())
          sum += audio->channelData(audio->channelCount() == 1 ? 0 : channel)[frame];
      }
      return std::isfinite(sum) ? sum : 0.0;
    };
    double gain = 1.0;
    if (decodedSources.size() > 1) {
      double peak = 1.0;
      for (uint64_t frame = 0; frame < frames; ++frame) {
        if (frame % 4096 == 0 && cancel.isRequested()) return {false, "Export cancelled"};
        for (uint32_t c = 0; c < channels; ++c) peak = std::max(peak, std::abs(sample(frame, c)));
      }
      gain = 1.0 / peak;
    }
    if (cancel.isRequested()) return {false, "Export cancelled"};
#ifdef _WIN32
    if (_setmode(destination.get(), _O_BINARY) == -1) return {false, "Could not open output"};
#endif
    auto* rawFile = fdopen(destination.get(), "wb");
    if (!rawFile) return {false, "Could not open output"};
    (void)destination.release();
    File file(rawFile, std::fclose);
    const uint64_t dataBytes = frames * channels * 2;
    if (format == AudioExportFormat::Wav) {
      if (dataBytes > UINT32_MAX - 36) return {false, "Audio exceeds WAV size limit"};
      std::array<unsigned char, 44> header{};
      std::copy_n("RIFF", 4, header.begin()); std::copy_n("WAVEfmt ", 8, header.begin() + 8);
      std::copy_n("data", 4, header.begin() + 36);
      little(header, 4, static_cast<uint32_t>(dataBytes + 36), 4); little(header, 16, 16, 4);
      little(header, 20, 1, 2); little(header, 22, channels, 2); little(header, 24, sampleRate, 4);
      little(header, 28, sampleRate * channels * 2, 4); little(header, 32, channels * 2, 2);
      little(header, 34, 16, 2); little(header, 40, static_cast<uint32_t>(dataBytes), 4);
      if (std::fwrite(header.data(), 1, header.size(), file.get()) != header.size()) return {false, "Could not write WAV header"};
    }
    auto flac = std::unique_ptr<FLAC__StreamEncoder, decltype(&FLAC__stream_encoder_delete)>(
        format == AudioExportFormat::Flac ? FLAC__stream_encoder_new() : nullptr, FLAC__stream_encoder_delete);
    if (format == AudioExportFormat::Flac) {
      if (!flac || !FLAC__stream_encoder_set_channels(flac.get(), channels) ||
          !FLAC__stream_encoder_set_sample_rate(flac.get(), sampleRate) ||
          !FLAC__stream_encoder_set_bits_per_sample(flac.get(), 16) ||
          !FLAC__stream_encoder_set_compression_level(flac.get(), 5) ||
          !FLAC__stream_encoder_set_verify(flac.get(), true) ||
          !FLAC__stream_encoder_set_total_samples_estimate(flac.get(), frames) ||
          FLAC__stream_encoder_init_stream(flac.get(), writeFlac, nullptr, nullptr, nullptr, file.get()) != FLAC__STREAM_ENCODER_INIT_STATUS_OK)
        return {false, "Could not initialize FLAC encoder"};
    }
    auto mp3 = std::unique_ptr<lame_global_flags, decltype(&lame_close)>(
        format == AudioExportFormat::Mp3 ? lame_init() : nullptr, lame_close);
    if (format == AudioExportFormat::Mp3) {
      if (!mp3 || lame_set_num_channels(mp3.get(), static_cast<int>(channels)) < 0 ||
          lame_set_in_samplerate(mp3.get(), static_cast<int>(sampleRate)) < 0 ||
          lame_set_brate(mp3.get(), channels == 1 ? 160 : 320) < 0 ||
          lame_set_quality(mp3.get(), 2) < 0 ||
          lame_set_num_samples(mp3.get(), static_cast<unsigned long>(frames)) < 0 ||
          lame_init_params(mp3.get()) < 0)
        return {false, "Could not initialize MP3 encoder"};
    }
    const size_t block = 4096;
    std::vector<unsigned char> mp3Bytes(block * 5 / 4 + 7200);
    std::vector<int16_t> pcm(block * channels);
    std::vector<FLAC__int32> flacPcm(block * channels);
    std::vector<unsigned char> wavPcm(block * channels * 2);
    for (uint64_t offset = 0; offset < frames; offset += block) {
      if (cancel.isRequested()) return {false, "Export cancelled"};
      const auto count = static_cast<size_t>(std::min<uint64_t>(block, frames - offset));
      std::fill(pcm.begin(), pcm.end(), 0);
      for (size_t i = 0; i < count; ++i) for (uint32_t c = 0; c < channels; ++c) {
        const auto value = quantize(static_cast<float>(sample(offset + i, c) * gain));
        const auto at = i * channels + c;
        pcm[at] = value; flacPcm[at] = value;
        wavPcm[at * 2] = static_cast<unsigned char>(value);
        wavPcm[at * 2 + 1] = static_cast<unsigned char>(static_cast<uint16_t>(value) >> 8);
      }
      if (flac) {
        if (!FLAC__stream_encoder_process_interleaved(flac.get(), flacPcm.data(), static_cast<unsigned>(count))) return {false, "FLAC encoding failed"};
      } else if (mp3) {
        const int written = channels == 2
            ? lame_encode_buffer_interleaved(mp3.get(), pcm.data(), static_cast<int>(count), mp3Bytes.data(), static_cast<int>(mp3Bytes.size()))
            : lame_encode_buffer(mp3.get(), pcm.data(), pcm.data(), static_cast<int>(count), mp3Bytes.data(), static_cast<int>(mp3Bytes.size()));
        auto* bytes = mp3Bytes.data();
        if (written < 0 || (written > 0 && (!bytes || std::fwrite(bytes, 1, static_cast<size_t>(written), file.get()) != static_cast<size_t>(written)))) return {false, "MP3 encoding failed"};
      } else if (std::fwrite(wavPcm.data(), 1, count * channels * 2, file.get()) != count * channels * 2) return {false, "WAV encoding failed"};
    }
    if (flac && !FLAC__stream_encoder_finish(flac.get())) return {false, "FLAC verification failed"};
    if (mp3) {
      const int written = lame_encode_flush(mp3.get(), mp3Bytes.data(), static_cast<int>(mp3Bytes.size()));
      auto* bytes = mp3Bytes.data();
      if (written < 0 || (written > 0 && (!bytes || std::fwrite(bytes, 1, static_cast<size_t>(written), file.get()) != static_cast<size_t>(written)))) return {false, "Could not finish MP3"};
    }
    if (mp3) {
      // No ID3 metadata is configured: the reserved LAME frame starts at zero.
      const auto tagSize = lame_get_lametag_frame(mp3.get(), mp3Bytes.data(), mp3Bytes.size());
      if (tagSize > mp3Bytes.size() || (tagSize > 0 &&
          (std::fseek(file.get(), 0, SEEK_SET) != 0 ||
           std::fwrite(mp3Bytes.data(), 1, tagSize, file.get()) != tagSize)))
        return {false, "Could not write MP3 duration tag"};
    }
    if (cancel.isRequested()) return {false, "Export cancelled"};
    if (std::fflush(file.get()) != 0) return {false, "Could not flush output"};
    return {true, {}};
  } catch (const std::exception& error) { return {false, error.what()}; }
  catch (...) { return {false, "Audio export failed"}; }
}
AudioExportResult exportAudio(OwnedFileDescriptor source, OwnedFileDescriptor destination,
                             AudioExportFormat format, DecodeCancellation cancel) noexcept {
  try {
    std::vector<OwnedFileDescriptor> sources;
    sources.push_back(std::move(source));
    return exportAudioMix(std::move(sources), std::move(destination), format, cancel);
  } catch (...) { return {false, "Audio export failed"}; }
}
}
