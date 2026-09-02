#pragma once

#include <string>
#include <vector>

namespace singz::codec_target_proof {

// Ordinary-thread, test-build-only proof over the zcore descriptor decoder.
// The caller owns fixture authorization and hashes the returned canonical JSON
// together with the packaged binary/runtime bytes. No audio device is opened
// and this function is never reachable from a real-time callback.
[[nodiscard]] std::string run(
    const std::vector<std::string>& fixturePaths) noexcept;

}  // namespace singz::codec_target_proof
