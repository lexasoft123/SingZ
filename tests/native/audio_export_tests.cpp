#include <zcore/media/audio_export.h>
#include <zcore/media/wav.h>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <vector>
#include <fcntl.h>
#ifdef _WIN32
#include <io.h>
#else
#include <unistd.h>
#endif
using namespace singz;
static void check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
static OwnedFileDescriptor input(const std::filesystem::path& path) {
#ifdef _WIN32
  return OwnedFileDescriptor(_open(path.string().c_str(), O_RDONLY | O_BINARY));
#else
  return OwnedFileDescriptor(open(path.string().c_str(), O_RDONLY));
#endif
}
static OwnedFileDescriptor output(const std::filesystem::path& path) {
#ifdef _WIN32
  return OwnedFileDescriptor(_open(path.string().c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_BINARY, 0600));
#else
  return OwnedFileDescriptor(open(path.string().c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600));
#endif
}
int main() {
  const auto dir = std::filesystem::temp_directory_path() / ("singz-core-export-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  std::filesystem::create_directory(dir);
  try {
    for (const int channels : {1, 2}) {
      const auto source = dir / (std::to_string(channels) + ".wav");
      std::vector<float> pcm(48000 * channels);
      for (size_t i = 0; i < 48000; ++i) for (int c = 0; c < channels; ++c) pcm[i * channels + c] = static_cast<float>(std::sin(i * 2 * 3.141592653589793 * 440 / 48000) * (c == 0 ? 0.5 : -0.5));
      WavWriter writer;
      check(writer.open(source.string(), 48000, channels), "open fixture");
      check(writer.append(pcm.data(), 48000) && writer.finalize(), "write fixture");
      auto original = prepareDecodedAudio(input(source)); check(original.ok(), "decode fixture");
      for (const auto format : {AudioExportFormat::Wav, AudioExportFormat::Flac, AudioExportFormat::Mp3}) {
        const auto destination = dir / (std::to_string(channels) + "-" + std::to_string(static_cast<int>(format)) + ".out");
        const auto result = exportAudio(input(source), output(destination), format);
        if (!result.ok) throw std::runtime_error(result.error);
        auto decoded = prepareDecodedAudio(input(destination)); if (!decoded.ok()) throw std::runtime_error("decode exported audio channels=" + std::to_string(channels) + " format=" + std::to_string(static_cast<int>(format)) + " status=" + std::to_string(static_cast<int>(decoded.status)));
        check(decoded.audio->channelCount() == static_cast<uint32_t>(channels), "channel count");
        if (format == AudioExportFormat::Mp3) {
          check(decoded.audio->sampleRate() == 44100, "MP3 native resample");
          // The decoder exposes encoder delay and padded MP3 frames (under 100 ms).
          check(decoded.audio->frameCount() >= 44100 && decoded.audio->frameCount() <= 48510, "MP3 duration");
        } else {
          check(decoded.audio->sampleRate() == 48000 && decoded.audio->frameCount() == 48000, "lossless rate and frames");
          for (int c = 0; c < channels; ++c) for (size_t i = 0; i < 48000; ++i)
            check(decoded.audio->channelData(c)[i] == original.audio->channelData(c)[i], "PCM16 exact round trip");
        }
      }
      const auto cancelled = exportAudio(input(source), output(dir / "cancelled.out"), AudioExportFormat::Wav, {nullptr, [](void*) noexcept { return true; }});
      check(!cancelled.ok && std::filesystem::file_size(dir / "cancelled.out") == 0, "cancel leaves no audio");
      // Re-export a FLAC source, covering the actual v2 project path.
      const auto flac = dir / (std::to_string(channels) + "-1.out");
      check(exportAudio(input(flac), output(dir / "from-flac.wav"), AudioExportFormat::Wav).ok, "FLAC to WAV");
    }
    // Mix different rates, channels and lengths: mono is duplicated and shorter
    // sources end in silence. The original stem gain is retained below full scale.
    const auto stereo = dir / "instrument.wav", mono = dir / "backing.wav";
    WavWriter stereoWriter, monoWriter;
    std::vector<float> instrument(44100 * 2), backing(24000, 0.25f);
    for (size_t i = 0; i < 44100; ++i) { instrument[i * 2] = 0.25f; instrument[i * 2 + 1] = -0.25f; }
    check(stereoWriter.open(stereo.string(), 44100, 2) && stereoWriter.append(instrument.data(), 44100) && stereoWriter.finalize(), "stereo mix fixture");
    check(monoWriter.open(mono.string(), 48000, 1) && monoWriter.append(backing.data(), 24000) && monoWriter.finalize(), "mono mix fixture");
    std::vector<OwnedFileDescriptor> inputs;
    inputs.push_back(input(stereo)); inputs.push_back(input(mono));
    check(exportAudioMix(std::move(inputs), output(dir / "mix.wav"), AudioExportFormat::Wav).ok, "native mix export");
    auto mixed = prepareDecodedAudio(input(dir / "mix.wav"));
    check(mixed.ok() && mixed.audio->frameCount() == 44100 && mixed.audio->channelCount() == 2, "mix shape");
    check(std::abs(mixed.audio->channelData(0)[10000] - 0.5f) < 0.001f && std::abs(mixed.audio->channelData(1)[10000]) < 0.001f, "aligned mono backing summed into stereo");
    check(mixed.audio->channelData(0)[33000] == 0.25f && mixed.audio->channelData(1)[33000] == -0.25f, "short backing ends without truncating instruments");
    inputs.clear();
    for (int i = 0; i < 8; ++i) inputs.push_back(input(stereo));
    check(exportAudioMix(std::move(inputs), output(dir / "peak.wav"), AudioExportFormat::Wav).ok, "peak-safe mix export");
    auto peak = prepareDecodedAudio(input(dir / "peak.wav"));
    check(peak.ok() && peak.audio->channelData(0)[10000] > 0.99f && peak.audio->channelData(1)[10000] == -1.0f, "one uniform gain prevents mix clipping");
    std::filesystem::remove_all(dir);
    std::cout << "native audio export passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::filesystem::remove_all(dir);
    std::cerr << error.what() << '\n'; return 1;
  }
}
