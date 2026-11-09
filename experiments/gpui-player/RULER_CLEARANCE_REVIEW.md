# Native ruler label clearance — 2026-11-09

## Problem and change

The compact 12-second fixture admitted `0:10` using its center and a fixed
130px reservation. The opaque zoom group subsequently covered the final glyph.
Ruler labels now use their intrinsic shaped-text bounds and the zoom group's
measured layout width from the **same frame**. An overlapping label is omitted
in full. Tick cadence, shared UIKit controls and their styling are unchanged.

The host wrapper delegates the existing GPUI element lifecycle. Zoom layout is
registered during layout requests, before any label prepaint. Test evidence also
records the zoom group's actual prepaint bounds and independently checks the
calculated boundary against that origin.

In the compact karaoke-OFF capture, the actual group starts at x=911 logical
pixels; `0:10` occupies x=890.9844 through 918.34375. It is wholly omitted because
it would overlap by approximately 7.34px. At 1280px the same label clears the
controls and remains visible.

## Qualification

Frozen build evidence:
`/tmp/singz-ruler-clearance-20261109/build-v1`.

- Locked offline UI-enabled test compilation passed.
- Full Rust suite: 1,009 passed, zero failed, two installed-model ignores.
- UI-enabled and normal builds passed with two compiler jobs.
- Source, fonts and reused native helpers stayed unchanged through validation.
- UI app SHA256: `79521b4df38f40ba5892442ec4f537b73e27491dbe49a8fc057dd73e77f1d821`.
- Normal app SHA256: `85f39ce72d7d5808f97fd3d0cf6bbade162e713bc230421905ed7856102112f3`.

The maintained journey was run through the frozen capture wrapper:

```sh
python3 experiments/gpui-player/tests/test_native_graph_ui.py \
  /isolated/ui-runtime/singz-gpui-player /fresh/evidence --karaoke --timeline
```

`/tmp/singz-ruler-clearance-20261109/ui-v1` contains two successful native app
launches, 24 top-level full screenshots and four additional follow frames. Each launch includes fit views with karaoke OFF
and ON at 1280×800 and 1060×640, plus zoom and pan captures. Existing native
playback, actual zoom buttons, cursor-centered wheel zoom, burst pan, pitch pinch,
saved view/reopen, follow and seek assertions remain intact. Extra captures
increase the expected count by four per launch; no earlier assertion was relaxed.

Both launches were hidden and muted, with app-local input, isolated preferences,
library and temporary data. Foreground observations stayed unchanged. Both apps
and their observed helpers retired naturally, with no forced stop or survivors.
There were 30 and 25 error-free app CPU/footprint/system-GPU observations,
respectively, and zero terminal sample discards. Helper CPU is excluded; live
display FPS is unmeasured. Readbacks are included in this resource workload.

All 28 images were inspected: the independent visual reviewer covered
the first 14, and the coordinator covered the restart 14. Fit/zoom/pan labels are
complete or wholly omitted, and controls remain unobstructed in these cases.
The image comparator's eight self-tests also pass. No matching Electron image
pair was produced or claimed.

## Limits and remaining differences

The current production TS ruler also uses a fixed center-only reservation. This
fix establishes native non-overlap; it does not prove a native-only divergence
from production. Node/Electron execution remains excluded by the user's request.
Matching production captures, long-clock fixtures, other locales, platform
rendering and live display cadence remain unqualified.

Karaoke captures still expose a horizontal lyrics scrollbar with a white corner
square. It predates this change: the same corner is visible in the older
`/tmp/singz-singing-controls-20261109/ui-v5/first/timeline-zoom-controls-1060.png`.
It remains a separate visual defect. Compact Saved status abbreviation and
entrance-fade captures also remain outside a complete parity verdict. The
approved native partial-glyph/glow implementation was not changed.

Durable evidence is archived under the session visualization directory in
`gpui-ruler-clearance-20261109`, including source/runtime pins, logs, screenshots,
resource/process/foreground receipts and the local platform-validator results.
Windows/Linux Drive execution remains open as recorded in
`PLATFORM_DRIVE_QUALIFICATION.md`.
