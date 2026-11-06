# Real player reference — 6 November 2026

The previous decode blocker was fixture data: saved tracks had `gain` instead of required
`volume`. Fixing that field produced `phase: ready` in 702–720 ms. No app source, decoder,
native addon or production behavior was changed. Scratch seed/capture files remain in `/tmp`.

Clean immutable captures (autosave toast expired before capture):

- `/tmp/singz-ui-parity-review-20261106/player-reference-clean/player-1280-reference.png`
- `/tmp/singz-ui-parity-review-20261106/player-reference-clean/player-1060-reference.png`

Matching JSON sidecars include per-file SHA256 hashes, viewport/device scale, full mixer state,
position, engine mode, guide/Karaoke classes, lyric scroll and measured DOM regions. Both real
Electron windows stayed invisible/unfocused, used isolated userData, muted output and disabled
sync. The driver asserts those conditions after every resize. Both full screenshots were read.

State: English, 2× scale, paused at exactly 64 s of 192 s, transpose 0, tempo 1, native playback
disabled, all lanes at volume 0.8 and solo false. Clicking real Karaoke mutes vocals, leaves
other five lanes unmuted, reveals the pitch strip, enables the lyrics panel and leaves Guide
vocals off (`chip guide`). Lyrics source is Edited, credit Demo lyrics; current line is
“Every note will light the way”; `.lp-body` scrollTop = 84 at both sizes.

| Region | 1280×800 bounds | 1060×640 bounds |
| --- | --- | --- |
| Main row | 0,52 / 1280×629 | 0,52 / 1060×469 |
| Main column | 0,52 / 920×629 | 0,52 / 700×469 |
| Stack | 0,52 / 920×457 | 0,52 / 700×297 |
| Ruler | 238,56 / 660×30 | 238,56 / 440×30 |
| Pitch strip | 0,509 / 920×172 | 0,349 / 700×172 |
| Lyrics panel | 920,52 / 360×629 | 700,52 / 360×469 |
| Lyrics header | 921,52 / 359×53 | 701,52 / 359×53 |
| Lyrics source | 921,105 / 359×59 | 701,105 / 359×59 |
| Lyrics body | 921,164 / 359×517 | 701,164 / 359×357 |
| Footer | 0,681 / 1280×119 | 0,521 / 1060×119 |
| Footer left | 24,694 / 576.844×48 | 24,534 / 540.844×48 |
| Footer right | 587.828,752 / 668.172×36 | 367.828,592 / 668.172×36 |

Source changes required for the native player:

1. Match actual fixture state (vocals muted, Guide off, Karaoke on); the original native
   capture has vocals unmuted and Guide on, so those pixels cannot prove paint equivalence.
2. Add the 172px pitch area when Karaoke is on. This changes stack height and every lane row.
   Current production has an observable overlap at 1060px between the fixed-height track rows
   and pitch strip; record this as a reference issue, never manufacture a different baseline.
3. Use responsive wrapping footer: main flex gap20, left gap14, right gap10, padding12px24px,
   row gap10, min-height86, height auto. Both measured states wrap to119px. Native footer80px
   is too short and omits output, metronome, carry-line, speed, Split and Stem files controls.
4. Port actual ruler/add-track/reset/export/zoom controls and dynamic time tick interval.
   Native `STEMS` plus hardcoded five ticks is a different composition.
5. Use shared PCM-derived envelope for waveforms. Native generated 260-bar arrays are still
   different from real decoded FLAC peaks. Controls width238 matches the reference ruler x;
   reference muted vocals and post-playhead opacity/line cap are also different.
6. Port full lyrics source toolbar and fixed body geometry before measuring text/glow. The
   native source row omits Check & align / Precise / Change and adds prototype footer text.

Strict diagnostic comparisons against the old pre-fix native captures were run and overlays
and differences read. Both differ (1280: 4,086,677 pixels; 1060: 2,704,715). Those pairs have
state/composition differences and are not acceptance pairs or similarity scores. Reports are
under `player-reference-clean/player-{1280,1060}-diff/`. No acceptance case is exact and no
consecutive lyric-frame comparison has been established. Live FPS remains unmeasured hidden.

## Added deterministic source frames

Twelve real source frames are now available (candidate comparisons remain root-owned):
`/tmp/singz-ui-parity-review-20261106/temporal-reference/` contains six sweep samples from
64.25 through 64.3333333 and three nominal line-boundary samples from 71.9833333 through
72.0166667. `temporal-reference-anticipation/` adds 71.8333333, 71.85 and 71.8666667.
JSON sidecars report exact engine position, actual current line and mixer state. The
anticipation batch additionally records every current span's actual class and `--p` value.
Both contact sheets were inspected. These use paused real engine seeks and settled DOM
layout; they verify timestamped fill states, not live cadence or the in-flight smooth scroll.

Production anticipates by 0.15s. At 71.8333333 the old line is fully sung; at 71.85 the next
line is current with `--p:0`; at 71.8666667 its first word has `--p:0.02`. Sampling only around
72 would miss the actual line boundary. Production quantizes word progress to 1/200.

`player-reference-measured/` contains Chromium-decoded normalized per-lane peak exports,
192000 little-endian float32 values each plus decoder/normalization metadata. The native
waveform owner used these exact values for the shared fixture asset, removing the earlier
PCM/envelope mismatch. The renderer exports include each source stem's SHA256 in sidecars.
