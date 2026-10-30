#pragma once
#include <string>
#include <zcore/media/decoded_audio.h>

namespace singz {
enum class AudioExportFormat { Wav, Flac, Mp3 };
struct AudioExportResult { bool ok = false; std::string error; };
// Ordinary worker only. Consumes authorized descriptors; no mixer, playback
// graph or JavaScript PCM participates. MP3 uses 44.1 kHz / 160 kbps mono or 320 kbps stereo.
// Multiple sources are summed at 44.1 kHz, aligned at zero and peak-limited
// with one uniform gain only when the sum exceeds full scale.
AudioExportResult exportAudioMix(std::vector<OwnedFileDescriptor> sources,
                                OwnedFileDescriptor destination,
                                AudioExportFormat format,
                                DecodeCancellation cancellation = {}) noexcept;
AudioExportResult exportAudio(OwnedFileDescriptor source,
                             OwnedFileDescriptor destination,
                             AudioExportFormat format,
                             DecodeCancellation cancellation = {}) noexcept;
}
