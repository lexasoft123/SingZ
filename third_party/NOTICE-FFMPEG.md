# FFmpeg codec runtime provenance

SingZ's optional extended decoder uses FFmpeg only through dynamically linked
`libavcodec`, `libavformat`, `libavutil`, and `libswresample`. The decoder uses
custom AVIO over an authorized file descriptor and never delegates to
RNAudioAPI's path/network decoder.

Mobile source:

- React Native Audio API: `0.13.2` (pinned by `mobile/package-lock.json`)
- Prebuilt archive release: `rn-audio-libs` tag `v3.1.0`
- Download script: `react-native-audio-api/scripts/download-prebuilt-binaries.sh`
- Upstream URL: `https://github.com/software-mansion-labs/rn-audio-libs/releases/tag/v3.1.0`
- Runtime-reported FFmpeg version: `8.0.1`
- Required header ABI: libavcodec 62, libavformat 62, libavutil 60,
  libswresample 6

At runtime zcore rejects a libav major mismatch and any build configuration
containing `--enable-gpl` or `--enable-nonfree`. Capability bits are then
derived independently from each demuxer and decoder actually registered.
CMake rejects `.a` inputs. Android additionally scans `libsingzcore.so`'s
`DT_NEEDED` table for all four shared libraries.

The prebuilt archives are external build inputs and are not checked into this
repository. `FFMPEG-SHA256SUMS` records the exact binaries currently supplied
by the pinned dependency so a changed/reissued archive is visible during
provenance review. Their embedded configuration contains only the
`hls,mov,mp3` demuxers and `aac,mp3,flac,alac` decoders. They are therefore a
compatibility runtime, not proof of the SingZ Phase 4 matrix: raw AAC,
Ogg/Vorbis, Ogg/Opus and AIFF are missing.

The product-owned profile is `ffmpeg-codec/profile.json`. Its source is the
official, checksum-pinned FFmpeg 8.0.1 archive and its reproducible decode-only
LGPL recipe is `scripts/build-ffmpeg-codec-runtime.sh`. Desktop extended
codecs, and the missing mobile formats above, remain disabled until those
per-platform shared-runtime packs are provisioned and pass the full fixture
gate. WAV and FLAC do not depend on that future artifact.

FFmpeg is copyright its contributors and licensed under LGPL 2.1-or-later (or
LGPL 3-or-later when configured with the relevant optional features). See
`COPYING.LGPLv2.1` and https://ffmpeg.org/legal.html. Shipping packages must
include this notice, the applicable license, upstream source/build offer, and
permit replacement/relinking of the dynamic libraries.

Corresponding source and replacement instructions
--------------------------------------------------

The exact compatibility-runtime source release, build recipes and toolchain
inputs are published at
`https://github.com/software-mansion-labs/rn-audio-libs/tree/v3.1.0`.
The dependency downloader is
`react-native-audio-api/scripts/download-prebuilt-binaries.sh`; the SHA-256
table bundled beside this notice identifies every binary used by SingZ.

SingZ does not modify FFmpeg and links it dynamically. A recipient may build
an ABI-compatible LGPL FFmpeg with libavcodec 62, libavformat 62, libavutil 60
and libswresample 6 from that source, then replace the correspondingly named
`.so` files in an Android package or the `libav*.framework` binaries in an iOS
development/re-signed package. SingZ imposes no contractual restriction on
reverse engineering needed to debug such replacements. Platform signing and
store policies still apply to installing a modified package.

For a full-matrix SingZ runtime, the corresponding unmodified source is
`https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz`, SHA-256
`05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41`.
The profile and build script above record the complete configuration and
replacement ABI.
