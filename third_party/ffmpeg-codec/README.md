# SingZ FFmpeg codec profile

Phase 4 playback promises one codec matrix on desktop, iOS and Android:
WAV, FLAC, MP3, raw AAC, M4A/AAC, M4A/ALAC, Ogg/Vorbis, Ogg/Opus and
AIFF/AIFC PCM. `profile.json` is the machine-readable release gate for that
promise.

The runtime is built from the exact official FFmpeg source archive recorded in
the profile. It is a small, decode-only, network-disabled LGPL build. GPL and
non-free components are forbidden. Four replaceable shared libraries are
produced: libavcodec, libavformat, libavutil and libswresample. They are build
inputs under `vendor/ffmpeg-codec/` and are intentionally not committed.

The `rn-audio-libs` v3.1.0 FFmpeg binaries pulled by
`react-native-audio-api` are a temporary compatibility runtime, not this
profile. Their embedded configuration enables only the `hls,mov,mp3`
demuxers and `aac,mp3,flac,alac` decoders; therefore they cannot satisfy raw
AAC, Ogg/Vorbis, Ogg/Opus or AIFF. The compatibility verifier pins those bytes
and reports the missing matrix explicitly. A release gate must use a generated
SingZ pack and the full fixture-mode codec test, never infer support from the
presence of four libav files.

Build/provision flow:

1. `scripts/build-ffmpeg-codec-runtime.sh <target>` downloads (or consumes
   `SINGZ_FFMPEG_SOURCE_ARCHIVE`), checksum-verifies and builds one slice with
   at most `SINGZ_NATIVE_JOBS` jobs (default 8).
2. `scripts/finalize-ffmpeg-codec-runtime.mjs <target> <staging-dir>` writes an
   atomic target pack with per-file hashes and the exact configure string.
3. `scripts/verify-ffmpeg-codec-pack.mjs --target <target> --require-full`
   verifies provenance, dynamic-library shape, ABI majors, configuration and
   the full matrix before CMake or a package consumes the pack.
4. `scripts/compose-ffmpeg-ios-xcframeworks.mjs` wraps the three verified iOS
   slice packs as four real dynamic framework XCFrameworks. It rewrites every
   component ID and inter-component dependency from the source-pack dylib name
   to `@rpath/libav*.framework/libav*`, publishes framework headers/modules,
   and binds every resulting byte to the source manifests. This keeps the
   LGPL runtime independently replaceable while React Native, Fabric,
   SingzCore and the static ONNX Runtime XCFramework stay in the normal static
   Pods graph.
5. `mobile/scripts/select-ffmpeg-codec-runtime.mjs` copies only a verified
   framework pack into RNAudioAPI's vendored-framework paths and records an
   exact selection receipt. CocoaPods then embeds the dynamic codec frameworks
   without enabling target-wide `use_frameworks!`.

Proof-staging composition is explicit and Debug-only. Release composition
requires promoted format-2 target receipts for the device and both simulator
architectures; a configuration-only source pack remains ineligible even when
its framework shape is valid.

The last runtime proof is `codec_provisioning_tests` with all deterministic
fixtures. Static configuration checks are necessary packaging evidence, but
they do not replace decoding every promised container/codec pair.
