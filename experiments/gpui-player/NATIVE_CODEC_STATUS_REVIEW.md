# Native malformed-media classifications

The strict canonical decoder proof on VM403 rejected app `8fff6b08` at the MP3
truncation case. A separate 24-case diagnostic found six exact-status mismatches:
MP3 and AAC truncated/corrupt data returned UnsupportedFormat; AIFF/AIFC truncated
headers returned IoError. All invalid inputs already returned no audio and closed
their descriptors. This repair corrects classification, not unsafe acceptance.

## Causes and repair

- Native MP3 indexing treated a recognized ID3 header extending past EOF, or a
  completed tag with fewer than four audio bytes, as absence of a supported
  frame chain. A bounded stack-only boundary check now reports MalformedData.
  Random data, free-format and channel-changing streams remain UnsupportedFormat;
  normal frame search, tag skipping, valid samples and torn-last-frame policy stay
  intact. Whole-file and streaming callers receive the same boundary result.
- FFmpeg probing could return success with missing AAC channel/rate information.
  Missing parameters now mean MalformedData; positive out-of-profile parameters
  retain UnsupportedFormat.
- FFmpeg's AIFF demuxer uses EIO for truncated container fields. The adapter now
  requires actual descriptor-callback/stdio error evidence before reporting
  IoError. Genuine I/O, cancellation and resource errors retain their distinctions.

The original public-source branch diagnostic confirms AAC parameters of 0/0 and
1/0, and AIFF/AIFC error −5 with `ioError=0`. It instruments only an isolated copy;
original source, SDK and the rejected canonical binary remain unchanged.
The canonical contract, fixture bytes, expected statuses and deadlines were not
relaxed. No detector-version bump or saved-analysis rewrite is appropriate for an
error-only change; valid media must retain its samples and dimensions.

## Local native evidence

Evidence: `/tmp/singz-native-decoder-status-20261110/mac-v1` and `mac-v2`, plus
`/tmp/singz-native-tour-a11y-20261109` diagnostics.

- Seven native decoder/streaming/resource suites pass under the pinned full
  FFmpeg SDK and again under the basic WAV/FLAC/MP3 profile: 14 suite executions.
  Coverage includes MP3 bit-exact reference samples, streaming/seek, tagged FLAC,
  malformed ID3 boundaries, genuine unsupported profiles, truncated files and
  allocation/working-memory limits.
- The full dynamic codec provisioning matrix passes with strengthened exact
  rejection statuses, genuine write-only descriptor failure and no data mutation
  or descriptor leak.
- The basic capability seam passes its ordinary no-argument invocation. A prior
  harness incorrectly used `--available`, which intentionally requires dynamic
  FFmpeg; that rejection is retained. Its contract was not changed to accept a
  basic build. Passing full/basic native checks were retained with source/SDK pins.
- Source bytes and the selected SDK remained frozen. No Node, UI window, physical
  microphone or output device was used.

## Published Linux checkpoint

Published app `03c22a6c` with UIKit `6f694bf0` passes all nine phases on VM403:
native codec assembly, native test configure/build, all seven native suites,
the strengthened codec provisioning matrix, Rust UI checks and unit tests, and
both UI-enabled and ordinary application builds. The controller reports
`sourceFrozen: true` and 175.35 seconds total. Its completed SSH session is
65428; the retained controller log is
`/tmp/singz-native-tour-a11y-20261109/linux-decoder-fixed-build.host.log`.
The target evidence directory is `/lab/checkpoint-711ac271/evidence-v3`.

The separately compiled, relocated canonical proof subsequently passes all 34
cases, including eight valid-media decodes, from the same published source.
Its result reports source/SDK/fixture/runtime bytes frozen and actual mappings
for all four FFmpeg libraries in the relocated runtime. Binary SHA256 is
`670c73a67092cb07f7592a8edd0709fa525dc34228a1b0780c36590ecb703c7d`;
the unchanged canonical contract SHA256 is
`ae91a6a86c28b027b2bc1e2a09fdb6ddfc304a0e7b189132c81c852e658d2b45`.
Evidence is `/lab/checkpoint-711ac271/canonical-codec-qualification-v3`, with
local logs/manifests retained under the scratch directory above. Initial SSH
connections closed; the successful later attempt is retained without retrying
or weakening a failed matrix. This is core decoder qualification: target helper/
app journeys, Windows delivery and package qualification remain open.
The separate nonblocking analyzer-provenance diagnostic limitation is tracked in
`DESKTOP_ACCEPTANCE_GAPS.md`; test byte hashes must not be described as production
provenance diagnostics or automatic stored-cache invalidation.
