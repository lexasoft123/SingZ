#!/usr/bin/env bash
set -euo pipefail

# The MP3 suite's corpus (tests/native/mp3_decoder_tests.cpp): one small,
# SYNTHESIZED file per shape the native decoder has to get right, and for each
# the reference FFmpeg decodes it to — so the suite runs anywhere (MSVC, the
# sanitizer gate) with no FFmpeg on the machine.
#
# Regeneration is an intentional update, never a build step: the committed
# bytes are the test. The references are FFmpeg's `-f f32le` output stored as
# 24-bit FLAC (quantisation 6e-8, far under the suite's tolerance), which the
# suite reads through zcore's own FLAC decoder.
#
# Requires FFmpeg 8.x and LAME 3.100. Nothing here is a recording of anybody:
# every signal is an aevalsrc expression.
out="${1:-$(dirname "$0")/data}"
mkdir -p "$out"
version="$(ffmpeg -hide_banner -version | sed -n '1s/^ffmpeg version \([^ ]*\).*/\1/p')"
case "$version" in
  8.*) ;;
  *) echo "FFmpeg 8.x required, found ${version:-unknown}" >&2; exit 2 ;;
esac
lame --version | head -1 | grep -q 'version 3.100' || { echo "LAME 3.100 required" >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
q=(-hide_banner -loglevel error -y)

# Stereo with different content per side: a tone and a sweep on the left, a
# chord with a tremolo on the right, and a click train on both — transients
# are where block switching (short windows) happens, which a pure tone never
# exercises.
signal() { # rate seconds channels -> wav
  local rate="$1" seconds="$2" channels="$3" dest="$4"
  local left='0.35*sin(2*PI*440*t)+0.25*sin(2*PI*(150+1800*t)*t)+0.5*(mod(floor(t*8),2))*exp(-400*mod(t,0.125))*sin(2*PI*3000*t)'
  local right='0.2*(sin(2*PI*261.6*t)+sin(2*PI*329.6*t)+sin(2*PI*392*t))*(0.6+0.4*sin(2*PI*5*t))+0.5*exp(-400*mod(t+0.06,0.125))*sin(2*PI*5000*t)'
  local expr="$left|$right"
  [ "$channels" = 1 ] && expr="$left"
  ffmpeg "${q[@]}" -f lavfi -i "aevalsrc=exprs='${expr}':s=${rate}:d=${seconds}" \
    -c:a pcm_s16le "$dest"
}

signal 44100 0.7 2 "$work/s44.wav"
signal 48000 0.7 2 "$work/s48.wav"
signal 48000 0.7 1 "$work/m48.wav"
signal 22050 0.7 2 "$work/s22.wav"

# CBR 320 with NO Xing/Info frame (-t): nothing states the length or the
# encoder delay, so nothing is trimmed — FFmpeg's answer, and ours.
lame --quiet -b 320 --cbr -t "$work/s44.wav" "$out/cbr320-noxing-44k.mp3"
# VBR with a Xing + LAME tag: frame count, delay and padding all stated.
lame --quiet -V 2 "$work/s44.wav" "$out/vbr-xing-44k.mp3"
# VBR with no header at all: the length exists only in the frames.
lame --quiet -V 2 -t "$work/s48.wav" "$out/vbr-noxing-48k.mp3"
# Mono, CBR with an Info tag (gapless trim on a CBR file).
lame --quiet -m m -b 96 --cbr "$work/m48.wav" "$out/mono-cbr-48k.mp3"
# MPEG-2 (576 samples a frame).
lame --quiet -V 4 "$work/s22.wav" "$out/mpeg2-vbr-22k.mp3"
# FFmpeg's own encoder: an Info tag whose encoder string is "Lavc".
ffmpeg "${q[@]}" -i "$work/s44.wav" -c:a libmp3lame -b:a 192k "$out/lavc-44k.mp3"

python3 - "$work" "$out" <<'EOF'
import os, random, struct, sys
work, out = sys.argv[1], sys.argv[2]
rng = random.Random(20260923)

def synchsafe(n):
    return bytes([(n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F])

def no_sync(n):
    # Bytes that can never start an MPEG sync word.
    return bytes(rng.randrange(0, 0xFF) for _ in range(n))

cbr = open(os.path.join(out, 'cbr320-noxing-44k.mp3'), 'rb').read()
vbr = open(os.path.join(out, 'vbr-xing-44k.mp3'), 'rb').read()

# The field file's shape: 320 kbps CBR, no header, and a run of 0xFF on the
# end — 1008 bytes of it, as that file carried. 0xFFFF reads as a sync word
# with the forbidden bitrate index 15, which is the point.
open(os.path.join(out, 'ff-padded-44k.mp3'), 'wb').write(cbr + b'\xff' * 1008)

# Tags at both ends: an ID3v2.4 tag with a text frame and padding at the head;
# APEv2 (header + footer) then ID3v1 at the tail.
title = b'\x03' + 'synthetic tone'.encode()
frame = b'TIT2' + synchsafe(len(title)) + b'\x00\x00' + title
body = frame + b'\x00' * 512
id3v2 = b'ID3\x04\x00\x00' + synchsafe(len(body)) + body
item = struct.pack('<II', 5, 0) + b'Title\x00' + b'synth'
ape_size = len(item) + 32
ape_header = b'APETAGEX' + struct.pack('<IIII', 2000, ape_size, 1, 0xA0000000) + b'\x00' * 8
ape_footer = b'APETAGEX' + struct.pack('<IIII', 2000, ape_size, 1, 0x80000000) + b'\x00' * 8
id3v1 = b'TAG' + b'synthetic tone'.ljust(30, b'\x00') + b'\x00' * 94 + b'\xff'
assert len(id3v1) == 128
open(os.path.join(out, 'tagged-44k.mp3'), 'wb').write(
    id3v2 + vbr + ape_header + item + ape_footer + id3v1)

# Junk between two frames mid-stream: the index must resynchronise and the
# decoder keep its state across the gap.
def frames(data):
    rates = [44100, 48000, 32000]
    kbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    at, found = 0, []
    while at + 4 <= len(data) and data[at] == 0xFF:
        br, sr, pad = data[at + 2] >> 4, (data[at + 2] >> 2) & 3, (data[at + 2] >> 1) & 1
        size = 144 * kbps[br] * 1000 // rates[sr] + pad
        found.append(at)
        at += size
    return found
starts = frames(cbr)
cut = starts[len(starts) // 2]
open(os.path.join(out, 'junk-44k.mp3'), 'wb').write(cbr[:cut] + no_sync(333) + cbr[cut:])
EOF

# References. Three files carry no reference of their own, on purpose:
#   - ff-padded and tagged hold exactly the audio of the file they were built
#     from, and the suite holds them to THAT file's reference — which is the
#     claim (padding and tags are not audio), not merely "FFmpeg agrees".
#   - junk is held to the clean file's DECODE, bit for bit. FFmpeg is no oracle
#     there: its parser hands the junk and the frame after it to the decoder
#     as one packet, which is rejected ("Header missing"), and the intact frame
#     is lost — 1152 samples short. Keeping it is the better answer.
rm -f "$out"/*.ref.flac
for f in "$out"/*.mp3; do
  case "$(basename "$f")" in ff-padded-*|tagged-*|junk-*) continue ;; esac
  ffmpeg "${q[@]}" -i "$f" -c:a flac -sample_fmt s32 -bits_per_raw_sample 24 \
    -compression_level 12 "${f%.mp3}.ref.flac"
done
shasum -a 256 "$out"/*
