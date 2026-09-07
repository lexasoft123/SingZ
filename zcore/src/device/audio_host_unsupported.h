#pragma once

#include <memory>

namespace singz {
class AudioHostBackend;
std::unique_ptr<AudioHostBackend> makeUnsupportedAudioHostBackend();
}  // namespace singz
