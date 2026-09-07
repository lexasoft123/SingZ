#!/usr/bin/env bash
set -euo pipefail

# Developer/CI fixture materialization only. These tiny files are not shipped;
# output codec/container pairs are the full product matrix and are decoded by
# descriptor in codec_provisioning_tests. FFmpeg 8.x is required so fixture
# behavior cannot silently change across major versions.
out="${1:?output directory}"
mkdir -p "$out"
version="$(ffmpeg -hide_banner -version | sed -n '1s/^ffmpeg version \([^ ]*\).*/\1/p')"
case "$version" in
  8.*) ;;
  *) echo "FFmpeg 8.x required, found ${version:-unknown}" >&2; exit 2 ;;
esac
input=( -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=0.08' -ac 1 )
ffmpeg -hide_banner -loglevel error -y "${input[@]}" -c:a libmp3lame "$out/tone.mp3"
ffmpeg -hide_banner -loglevel error -y "${input[@]}" -c:a aac -f adts "$out/tone.aac"
ffmpeg -hide_banner -loglevel error -y "${input[@]}" -c:a aac "$out/tone-aac.m4a"
ffmpeg -hide_banner -loglevel error -y "${input[@]}" -c:a alac "$out/tone-alac.m4a"
ffmpeg -hide_banner -loglevel error -y "${input[@]}" -c:a libvorbis "$out/tone.ogg"
ffmpeg -hide_banner -loglevel error -y "${input[@]}" -c:a libopus "$out/tone.opus"
ffmpeg -hide_banner -loglevel error -y "${input[@]}" -c:a pcm_s16be "$out/tone.aiff"
# AIFC exercises the other FORM declaration accepted by the product matrix.
ffmpeg -hide_banner -loglevel error -y "${input[@]}" -c:a pcm_s16le -f aiff "$out/tone.aifc"
# Product-policy negatives: exactly one audio stream, and only the explicit
# codec allowlist inside an otherwise accepted container.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=0.08' \
  -f lavfi -i 'color=black:size=16x16:rate=10:duration=0.08' \
  -map 0:a -map 1:v -c:a aac -c:v mpeg4 "$out/audio-plus-video.m4a"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'color=black:size=16x16:rate=10:duration=0.08' \
  -an -c:v mpeg4 "$out/video-only.m4a"
ffmpeg -hide_banner -loglevel error -y "${input[@]}" \
  -c:a flac -f ogg "$out/unsupported-flac.ogg"
# Large enough to cross several 32 KiB custom-AVIO reads before cancellation.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=12' \
  -ac 1 -c:a libmp3lame "$out/cancel-long.mp3"
shasum -a 256 "$out"/*
