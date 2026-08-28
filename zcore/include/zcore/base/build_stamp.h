#pragma once

// Which shared native sources this binary was actually built from.
//
// Detector format stamps answer whether stored analysis has the shape this
// binary expects. They do not identify the source checkout. A same-version
// binary from another worktree can therefore pass every format check while
// running different zcore/zdsp code. Vendored host tools compile the unified
// fingerprint from scripts/analyze-source-hash.sh into the executable so the
// caller can distinguish those cases without trusting a sidecar.

namespace singz {

/** The source fingerprint compiled into this binary, or "" when unstamped. */
const char* buildSourceHash();

}  // namespace singz
