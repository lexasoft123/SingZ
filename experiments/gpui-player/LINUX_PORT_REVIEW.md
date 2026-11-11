# Linux VM 403 verification — 2026-11-06

Verified on `singz-debian13` (VM 403), Debian 13 x86-64, 8 vCPUs and 16 GiB
RAM. The task uses its own Podman container and source snapshot under
`~/dev/gpui-port-20261106`. Existing development and LRCLIB containers were
preserved. Rust 1.99.1 and test prerequisites are container-local, with the
toolchain/cache retained in that user directory.

There is no `/dev/dri` hardware render node. Vulkan uses Mesa 25.0.7 llvmpipe
(LLVM 19.1.7); the private Xvfb display runs at scale 2 with Openbox. This is
software-rendered X11 verification, not hardware GPU or Wayland qualification.

## Fixed during verification

- The published Linux backend lacked `render_to_image`. A test-only X11/Wayland
  bridge now captures through the window's existing WGPU device, pipelines and
  sprite atlas, using the same target format, alpha and clear policy as live
  rendering. Padded-row readback, size checks, timeouts and GPU errors are
  retained. See [capture bridge](vendor/gpui-pre-linux/OFFSCREEN_CAPTURE.md).
- X11 ignored `show: false` and mapped every fixture. Initially hidden windows
  now stay unmapped and skip swapchain presentation. Final resource samples
  record no mapped prototype windows, and private-display foreground readings
  are unchanged during each hidden case.
- Opaque client chrome no longer requires GTK's transparent-shadow extension
  to remove the native titlebar under Openbox. Transparent surfaces retain the
  original fallback. UIKit supplies the header buttons and Linux resize grips.
- The component root's default 20px frame padding shifted the app layout and
  its input targets. An opt-in application frame configuration removes that
  extra border/shadow for this Linux window; other consumers keep the published
  defaults. See [frame configuration](vendor/gpui-component/APP_FRAME.md).
- Shared compact zoom labels now remain on one line. The pitch toolbar, key
  readout and compact microphone status stay separate; short windows scroll
  their stem lanes without painting over the pitch strip.

## Results and limits

| Check | Result |
| --- | --- |
| Native build with UI tests | Passed, locked dependencies |
| Normal native build | Passed, locked dependencies |
| Screens | 18 captures, 1280×800 and 1060×640, inspected |
| Log | Selection, session menu, popup-first Escape, Close and scrim passed |
| Interaction assertions | Catalog/Browse/card, player, lyrics, Settings and short-window stem scrolling passed |
| Apple renderer contracts | Unavailable on Linux; complete smoke process exits 1 here |
| Lyric sequence | 363 timestamp captures passed, advancing glow covered |
| WGPU readback regressions | 4 passed: colors, row padding/sizes, target reuse and invalid-size recovery |
| Native frame capture | Whole X11 window; native frame extents `[0,0,0,0]` |
| macOS regression | 18/18 capture PNGs unchanged; complete hidden smoke passed |

The final UI-test binary SHA-256 is
`6fd5c444d8fdb598c9edee1c8d443b4cb236be1f8b4bdef5a8092fdd17cc7f68`.
The archived source hash manifest identifies the uncommitted candidate.
The normal executable SHA-256 is
`87f500acf704e7d83e059614d3fedd8eb688e9c91cf8c7975b2795eabc4e1297`.

At 2560×1600 physical pixels, the final 8.185 s offscreen measurement completed
31 images: **3.787 images/s**. Lyrics paint p95 was **0.972 ms**. Whole-case CPU
mean, including startup/warmup, was **594.62% of one core** (about 5.95 virtual
cores); peak sampled benchmark RSS was **518.6 MB**. Hardware GPU utilization
is unavailable and is recorded as unavailable, not zero. **Live presentation
FPS remains unmeasured**; readback throughput cannot establish live smoothness.

Native minimize/restore activation checks were not performed: automatic review
rejected the proposed explicit window activation because background automation
must not activate or raise windows. No rejected activation test was written or
executed. Full-window previews are captured only on the private virtual display.

No matching Electron-on-Linux reference was captured, so pixel-perfect parity
is not certified. Linux whole-scene grain, emoji/fallback raster differences,
hardware acceleration, Wayland runtime behavior, rounded corners and real
native window-control/resize gestures remain qualification items. There is
still no native audio or library backend integration in this UI executable.

Evidence is retained in this chat's `gpui-linux-vm403` visualization directory:
full-window and screen PNGs, all lyric frames, source/binary hashes, Vulkan
inventory, CPU/RSS samples, build logs and the four renderer-test results.
