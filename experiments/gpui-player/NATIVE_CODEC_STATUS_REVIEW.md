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

These local checks do not close the strict relocated Linux canonical 34-case
proof or establish helper/app/package qualification. Those must run from the
published repaired source, followed by the maintained platform desktop journeys.
The separate nonblocking analyzer-provenance diagnostic limitation is tracked in
`DESKTOP_ACCEPTANCE_GAPS.md`; test byte hashes must not be described as production
provenance diagnostics or automatic stored-cache invalidation.
