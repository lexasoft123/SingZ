# GPUI desktop interface prototype

A standalone native port of the SingZ desktop interface. It starts on the catalog and uses
isolated sample data. It does not open the real project library, use Drive credentials,
access microphone hardware, or play audio.

Requires Rust and GPUI Kit's native platform prerequisites (macOS 15+ for this Mac setup).
Keep the sibling UIKit checkout at `../singz-ui`: Cargo resolves `singz-uikit` from its
`gpui` directory.

```sh
cargo run --manifest-path experiments/gpui-player/Cargo.toml
```

## Current interface

The catalog follows the production `DropScreen`: equalizer hero, drop/browse area,
projects location panel, title search and project cards. Selecting a card opens the player.
All cards preview the same 192-second fixture; they do not load different audio. Browse,
project deletion, folder changes and backend actions explain their prototype limitations.

The player has six stem lanes, mute/solo, gain rails, a waveform ruler and seek interaction.
The footer follows `Transport.tsx`: restart, play/pause, clock, loop, song output, metronome,
line continuation, transpose, tempo, BPM state, Karaoke, Split and Stem files. Play advances
a silent clock. Transpose/tempo/mix controls change local state. Backend-only actions do
not pretend to process or save audio. Karaoke reveals lyrics and the sample pitch strip and
mutes the vocal lane; Guide vocals controls the local guide state.

Settings opens as a viewport modal above the prior page. The Audio view contains playback
and input selectors, native-playback and headphone checkboxes, a microphone meter,
monitoring route/graph and a gain slider. Menus, checkboxes and gain keep local draft state;
they do not apply device routes. Monitoring is unavailable without a native audio service.
The content scrolls inside the modal; Close, Escape and the scrim return to the prior page.
Player animation is paused while the modal is open.

No real playback, decoding, separation, pitch detection, project saving or backend bridge is
implemented by this UI executable. A native backend experiment is forthcoming; this screen
prototype is not evidence of backend availability or audio performance.

The header Log button now opens a native diagnostic dialog with selectable rows, local
session selection, Copy and standard dismissal. It starts empty until a log backend is
connected; Save explicitly reports its prototype limitation. See [screen inventory](SCREEN_PORT_STATUS.md)
and [Log port review](LOG_PORT_REVIEW.md) for remaining states and visual differences.

## Shared UIKit and assets

Reusable native controls live in `../singz-ui/gpui`: pills, icon buttons, play control,
checkboxes, selectors/popups, sliders, modal material, scrollbars, badges, search and
transport controls. Screen composition stays in this project. Production SVG paths are
reused rather than replaced with font glyphs.

Fonts are owned by the sibling UIKit crate and distributed in UIKit's `dist/fonts`.
`singz_uikit::init(cx)` registers its bundled native faces once per App; this prototype
keeps no private TTF copies. Regenerate at the UIKit root with
`python3 scripts/gen-fonts.py && npm run build`. The explicit native families select the heavier visual outlines by family name;
Windows aliases normalize style metadata while macOS retains its original metadata.
Both variants have identical static glyph outlines and layout tables. License and source provenance ship with the distribution.

See [Dell Windows verification](WINDOWS_PORT_REVIEW.md) for font matching,
background interaction results, measured resource use and remaining platform gaps.
See [Linux VM 403 verification](LINUX_PORT_REVIEW.md) for Linux captures,
frameless/background fixes and software-Vulkan qualification limits.

The waveform fixture uses normalized peaks exported from the real Electron renderer after
it decoded the six FLAC stems. `assets/review-peaks.bin` includes six arrays of 192000
float32 buckets. Decoder/fixture provenance and exported per-lane metadata are described
in [player_reference.md](player_reference.md). These peaks are a shared visual fixture,
not a native decoding implementation.

The [approved native highlighting standard](LYRICS_HIGHLIGHT_STANDARD.md) takes precedence over Electron for the lyric paint effect.

The original six-line verse repeats to fill the fixture. Native lyrics use shaped glyph
metrics, the production line metrics, 150ms anticipation, a partial glyph sweep and the
approved native word halo. Active text retains the approved layered paint: readable base,
12-slice amber feather, an 18px advancing bright core, and eight cached halo-opacity levels.
The light moves through glyphs instead of selecting whole letters. Centering follows line changes; wheel/scrollbar
input lets the singer read elsewhere until the next line. Geometry/shaped text and glow
images are cached. Rendering and
Chromium rasterization differences remain under review; no screen is certified pixel-perfect.

The macOS renderer has an opt-in [GPU grain extension](vendor/gpui-pre-apple/GRAIN_EXTENSION.md).
It composites the source SVG noise above the whole scene in one GPU pass, shared by live
windows and hidden captures. Runtime shaders avoid requiring Xcode's separate Metal
compiler toolchain. The hidden smoke suite validates its output against an independent
blend formula. Other rendering backends still need the same effect. The process-local
text policy matches Electron's antialiased CSS without changing system font preferences.

## Normal and test builds

The normal build supports the interactive silent prototype. Test adapters are enabled only
with `--features ui-tests`; normal builds do not run smoke or review capture tasks.
All automated checks stay hidden and dispatch input inside the app. They do not activate
windows or send global pointer/keyboard input.

```sh
cargo build --manifest-path experiments/gpui-player/Cargo.toml --features ui-tests
SINGZ_GPUI_BACKGROUND=1 SINGZ_GPUI_UI_SMOKE=/tmp/singz-gpui-ui-smoke \
  experiments/gpui-player/target/debug/singz-gpui-player
SINGZ_GPUI_BACKGROUND=1 SINGZ_GPUI_REVIEW_CAPTURE=/tmp/singz-gpui-review \
  experiments/gpui-player/target/debug/singz-gpui-player
```

The smoke driver exercises real click dispatch, catalog search/open, Settings controls and
scrolling, and player controls. It captures native renderer images and fails on incorrect
state changes. The review adapter captures catalog, Settings and player at 1280×800 and
1060×640, plus deterministic paused lyric sweep and line-boundary states at 1280×800.
Hidden macOS windows suspend normal display callbacks, so manually stepped offscreen
captures establish neither live FPS nor smooth scrolling cadence.

Follow [UI_REVIEW.md](UI_REVIEW.md) and the linked interface-port-review skill for the real
production-reference capture contract, required state matrix and strict comparison loop.
References and candidates must use identical fixtures, locale, viewport, device scale,
timestamps and color profiles. Keep old batches immutable. Interaction success is separate
from visual parity. [REVIEW.md](REVIEW.md) records the earlier findings;
[player_reference.md](player_reference.md) records the resolved fixture blocker and measured
production player geometry.

```sh
python3 experiments/gpui-player/tests/test_compare_ui.py
python3 experiments/gpui-player/tests/compare-ui.py \
  --reference /tmp/reference.png --candidate /tmp/candidate.png --out /tmp/diff
```

## Performance measurements

The background throughput benchmark renders and reads back real GPU images without display
callbacks. It reports completed images per second, frame intervals, draw/readback wall time,
process CPU/RSS, and available system GPU utilization. It checks that the advancing highlight
was drawn. These results are distinct from display FPS:

```sh
python3 experiments/gpui-player/tests/interface-offscreen-perf.py
```

The older display-cadence telemetry runner remains available:

```sh
python3 experiments/gpui-player/tests/interface-perf.py
python3 experiments/gpui-player/tests/test_perf_gate.py
```

The runner builds the optimized development binary, starts its own hidden process, warms
up for five seconds, measures for twelve seconds and cleans up that process. Use
`--skip-build` only when the binary matches current source. The default JSON report is
`/tmp/singz-gpui-interface-perf.json`.

Reports distinguish UI draw cadence from display presentation FPS. They include frame
interval percentiles, lyric CPU paint time, process CPU (100% means one logical core),
memory and available IOAccelerator utilization. GPU counters are system-wide and include
other apps; unavailable counters are reported explicitly. Insufficient hidden-window
cadence is unmeasured/failing telemetry, never zero-filled or interpreted as smoothness.
The gate requires complete telemetry windows; optional CPU budgets are configured by the
runner flags. Offscreen stills and timestamped highlight samples are not an FPS benchmark.

## Window chrome

The macOS window is frameless with native traffic lights inside the 52px SingZ header.
Header content reserves 92px on the left; fullscreen releases that space. Native resize,
minimize, close and fullscreen controls remain native. Drag/double-click handling delegates
to the platform preference; controls preserve GPUI click tracking while preventing header
drag propagation. Windows also draws into the complete window frame, reserving
150px on the right for UIKit's minimize/maximize/close controls. Native edge and
corner hit tests retain resizing. Linux uses the same controls with client-side
resize grips and an opt-in zero-padding component frame. X11 is verified on
VM 403; Wayland runtime checks remain outstanding.

The pitch strip uses a separate toolbar for Note bars, Fit and the compact
microphone status. The key/piano roll stays below it, and short-window stem
lanes scroll within their own clipped viewport rather than covering the pitch panel.

Earlier manual Mac checks covered drag, zoom/restore, minimize/restore and resize. Hidden
scene captures omit AppKit traffic lights and the OS shadow, so content parity does not
certify native chrome parity on any platform.

The hidden 120 Hz lyric-paint adapter records first-word, final-word and line-boundary
sequences (363 samples), successful advancing-halo image draws, hashes and exact crops:

```sh
SINGZ_MUTE=1 SINGZ_NO_SYNC=1 SINGZ_GPUI_BACKGROUND=1 \
SINGZ_GPUI_LYRICS_REVIEW=/tmp/singz-gpui-lyrics-review \
  experiments/gpui-player/target/debug/singz-gpui-player
```

Build with `--features ui-tests` first. These settled timeline samples establish paint
evidence, not live presentation FPS. Historical approved captures use older geometry
and timing; do not claim whole-image pixel identity from the restored paint algorithm.
