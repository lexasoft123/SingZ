# dr_mp3, vendored

The MPEG-1/2/2.5 Layer III decoder under zcore's native MP3 support
(`zcore/src/media/mp3_streaming_source.cpp`). One file, taken verbatim. Nothing here is
modified.

## Provenance

| | |
|---|---|
| upstream | https://github.com/mackron/dr_libs — `dr_mp3.h` |
| commit | `dfe8377631000664666519fdb83da193fd8037f4` (2026-09-01, header says v0.7.4) |
| sha256 | `997b7ee18de6e6b81e2a83f1ea9fc62aef25c62b28d48db95635f49e65de0a2f` |
| license | **MIT No Attribution** (the file offers public domain *or* MIT-0; SingZ takes MIT-0, which needs no notice in the product). The embedded decoder core is lieff/minimp3, CC0 1.0. The full text of both is at the end of `dr_mp3.h`. |

MIT-0 and CC0 impose nothing on the app — no attribution, no copyleft, no
replacement obligation. That is the whole reason this exists beside the FFmpeg
path: MP3 no longer waits on the LGPL dynamic-linking product selection
(`third_party/NOTICE-FFMPEG.md`), which shipped phone builds have never made.

## What of it is used

Only the **low-level frame decoder**: `drmp3dec` / `drmp3dec_decode_frame`,
one frame's bytes in, that frame's PCM out. zcore does everything around it
itself — ID3v2/ID3v1/APE/Lyrics3 tags, the frame index, Xing/Info/LAME and VBRI
headers, encoder delay and padding, and sample-exact seeking — because the
exactness contract in `zcore/include/zcore/media/streaming_audio_source.h`
belongs to zcore and must hold identically for the whole-file decode and the
streaming source. dr_mp3's own high-level `drmp3` reader, its stdio helpers and
its Layer I/II path are compiled out (`DR_MP3_NO_STDIO`, `DR_MP3_ONLY_MP3`).

The implementation is compiled exactly once, in
`zcore/src/media/mp3_streaming_source.cpp` (through `mp3_dr.h`, which makes
every dr_mp3 function `static`), with this directory on a SYSTEM include path
so the strict presets (`-Wall -Wextra -Wpedantic -Werror`) judge our code and
not upstream's.

## Updating

Replace `dr_mp3.h`, update the commit and sha256 above, then run the MP3 suite
(`mp3_decoder_tests` under ctest) — it compares against committed FFmpeg
references and checks every seek sample for sample against the whole-file
decode, which is what would notice a decoder change in the state a seek run-up
has to rebuild.
