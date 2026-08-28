#pragma once

// Which sources this binary was actually built from.
//
// The detector stamps (kPitchDetectVersion and friends) answer "is this
// binary's ANSWER shaped like the one the caller expects" — they move only
// when a detector's output does. They cannot answer "was this binary built
// from the tree in front of me", and a same-version binary compiled from
// different code is exactly what slipped through during the v0.19.0 cut: a
// sibling worktree rebuilt the shared vendor/ slot from its own branch and
// the desktop spawned that binary for hours, live-input adapter and all.
//
// scripts/vendor-analyze.sh already computes a fingerprint of every file
// under mobile/native/core (plus the script itself) and writes it beside the
// binary; passing the same value as SINGZ_SOURCE_HASH puts it INSIDE the
// binary, where a sidecar file cannot drift from it and an $SINGZ_ANALYZE
// override still answers for itself.
//
// Any other build — build-analyze-host.sh, run-core-host-tests.sh, both
// phones — leaves it unset and reports "" for "unknown". That is a valid
// answer, not a failure: the desktop degrades to the sidecar, and nothing
// ever refuses to run over it.

namespace singz {

/** The source fingerprint compiled in, or "" when this build recorded none. */
const char* buildSourceHash();

}  // namespace singz
