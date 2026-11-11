# Dell Windows verification — 2026-11-06

Test machine: DESKTOP-5G2SN2I, Windows 10 Home 19045, Intel HD 4600 /
NVIDIA GeForce GT 750M. Rust 1.99.1 MSVC is permanently installed under the
user's `.cargo` and `.rustup` directories, with `.cargo/bin` on the user PATH.

The candidate is based on SingZ `bd56510e` and UIKit `3075c57`, plus the
font-distribution and background-window changes described below. Source file
hashes are in the evidence archive's `font-candidate-identity.json`.

## Font ownership and matching

UIKit owns the licensed Bricolage Grotesque and Martian Mono sources, nine static
faces and nine Windows metadata aliases. Its npm distribution includes
`dist/fonts`, `dist/fonts.css`, source subsets, licenses and a hash manifest.
The native crate embeds and registers the faces once per App; the prototype
has no private TTF copies and needs no installed system fonts.

DirectWrite's exact style filtering previously fell back to a system font for
the explicit heavier families requested with normal weight. Windows aliases
retain the same glyph/layout tables and expose normal style metadata. macOS
keeps its original metadata. The corrected Dell screenshots were inspected.
On macOS, all 18 screen captures and all 363 lyric frames are pixel-identical
to the prior native baseline. This is regression evidence, not Electron parity.

## Background verification

All cases used hidden windows, silent fixtures, no sync, app-local input and
user-session scheduled tasks. Read-only foreground/window probes recorded no
visible app windows, no app foreground samples and unchanged foreground
handles for every corrected case. No global input was sent.

| Case | Result |
| --- | --- |
| Screens | 18 captures at 1280×800 and 1060×640; passed |
| Log | Selection, session menu, Close, popup-first Escape, scrim; passed |
| Lyrics | All 363 consecutive timestamp captures; passed in 41.11 s |
| Interactions | Catalog, player, lyrics and Settings assertions passed |
| Renderer contracts | Apple-only contracts unavailable; smoke exits 1 here |
| Offscreen benchmark | Passed; advancing glow covered |

Windows delivers resize callbacks asynchronously. The smoke fixture explicitly
resizes, yields to the event loop and verifies its viewport before input.
The pinned `gpui-pre-windows` fork adds `SWP_NOZORDER | SWP_NOACTIVATE` to resize;
the executable uses the Windows GUI subsystem to avoid a console window.

The original lyric capture forced 90 draws at every timestamp and timed out
after generating its images, with peak sampled RSS 8.25 GB. The capture now
stops settling once lyric scrolling is inactive, retaining at least two draws
and the settle assertion. Peak sampled RSS was 1.12 GB; all frames completed.
The resulting macOS frame bytes are unchanged.

## Measured performance and limits

The 1280×800 viewport rendered at scale 2 (2560×1600), with a 2 s warmup and
8.018 s measurement. Candidate binary SHA-256:
`bf06d67b39d7e342e50ce86892f48e025780c61ecfc80f3147f467db3c779250`.
The subsequent smoke-only driver rebuild has SHA-256
`3e53432c6a31e0b1a5a0476c39088c67b20e8fd73e3892deedf71edf41e3e526`.

- 165 completed offscreen readbacks: **20.579 images/s**.
- Lyrics paint p95: **0.406 ms**; GPU-render-plus-readback wall p95: **31.383 ms**.
- Measurement-window CPU mean: **64.59% of one core**.
- Per-process GPU-engine utilization sum mean: **29.64%** (Windows counters;
  this is not pure command duration or a system-wide GPU percentage).
- Peak sampled benchmark RSS: **395.8 MB**.
- **Live presentation FPS is unmeasured.** Stepped rendering/readback cannot
  establish display smoothness. The JSON definition's macOS callback note is
  platform-specific wording; its `liveFPS: null` also applies to this run.

Windows whole-scene grain and raster parity still
need implementation/comparison. No matching Windows Electron reference was
captured, so no Windows screen is certified pixel-perfect.

Durable evidence: `gpui-windows-dell` under this chat's visualization directory,
including the full lyric sequence, resource samples, screenshots, logs and
source/binary identities. The remote verification tree is retained under
`C:\Users\123\singz-lab\gpui-bd56510e-20261106`; task-owned scheduled jobs
are removed after completion. The permanent user Rust toolchain is retained.

## Follow-up: frameless chrome and pitch overlap fixes

The user subsequently required a frameless Windows window and reported the
Note bars/Fit controls overlapping the key, with a microphone warning across
the piano roll. The window now uses a transparent titlebar and client-owned
non-client area, with shared UIKit 46×52px minimize/maximize/close controls.
The header reserves their space. The native capture includes the whole HWND;
client and window dimensions are identical, and all eight resize hit-test
cases pass without changing the foreground window.

The pitch strip now has a separate 34px toolbar above the key and piano roll.
Its compact microphone status stays in that row. This is an explicit correction
to the previous overlapping layout, so the old pitch-layout capture is not an
authority for these controls. In short windows, the stem lanes scroll in a
clipped viewport rather than painting over the pitch strip. Both viewport sizes
are captured again; the hidden interaction driver checks the lower stems can
be reached by scrolling. The approved lyric paint remains unchanged.

Follow-up evidence is saved in `gpui-windows-dell/frameless-pitch-fix` in the
same visualization directory. Full Electron raster parity and rounded outer
window corners remain unverified. Native minimize/maximize/close are wired,
but maximizing was not driven on the user's desktop because it could activate
the window; frame geometry and edge hit tests use app-scoped messages only.
