# D-02 — What render architecture meets N1-N5, and how are presented frames measured on macOS?

Decision record for `COMPLETION_PLAN.md` section 4.2, row D-02. Written 2026-11-11
against `codex/gpui-interface` at `483b4527`. `$G` = `experiments/gpui-player`.
`$V` = `$G/vendor` (materialised by `scripts/gpui-vendor.py`). `$REG` = the cargo
registry source for the versions `$G/Cargo.lock` pins. Anything marked *(inferred)*
was not checked against code or a measurement. Nothing was built, run or measured
for this record; it rests on reading the tree.

Status: **proposed**. It becomes binding when the user signs section 8.

**The G0/Q-02 baselines do not exist yet.** The plan orders D-02 after Q-01/Q-02;
this record was written first. It is therefore built as a ladder: a first stage
that the code alone justifies, and later stages that are entered only when a
named baseline number says so (section 4.2). No budget is claimed as met.

## 1. Question

Which render architecture lets the native desktop hold N1-N5 (plan section 3.1)
for 6-lane playback with lanes, lyrics and the pitch strip visible: redraw gating
plus cached layers inside GPUI's paint model, a custom Metal layer, or a patch to
GPUI's frame scheduling? And which method reports per-frame present times,
dropped frames and p99 on macOS, so that N1-N3 and N5 stop being inferred from
draw counts?

Interim gate (user decision, 2026-11-11): 60 presented FPS, p99 ≤ 16.7 ms, zero
dropped frames at 60 Hz. 120 Hz (p99 ≤ 8.3 ms) stays the release target.

## 2. Inputs, and what was verified

### 2.1 How a frame is scheduled and presented on macOS

| Claim | Evidence | Status |
|---|---|---|
| The macOS window crate is **not vendored**; it comes from crates.io | `$G/Cargo.toml:73-79` lists six path crates, none is `gpui-pre-macos`; `$G/Cargo.lock:2634-2636` has a registry source | Verified. Any change to mac window or display-link code means vendoring a seventh crate |
| On macOS 14+ each window is paced by a `CAMetalDisplayLink` on the main run loop, which hands out the frame's drawable | `$REG/gpui-pre-macos-0.3.11/src/window.rs:641-648`, `:839-855`, `:3435-3462`; `$V/gpui-pre-apple/src/display_link.rs:67-88` | Verified. `CVDisplayLink` is only the pre-14 fallback (`window.rs:856-867`) |
| The link is demand-driven: it pauses after an update in which GPUI neither drew, presented nor asked for another frame | `$REG/gpui-pre-macos-0.3.11/src/display_link.rs:297-343`; `window.rs:3458-3461` | Verified. Idle GPUI itself presents nothing; N5 is an app-side problem |
| A window that is not occlusion-visible gets no display link at all | `window.rs:829-837`, `:3055-3066` | Verified. **A hidden or fully covered window presents no frames**; `ui_benchmark.rs:46-48` says the same |
| One frame = next-frame callbacks, then draw if dirty, then present | `$V/gpui-pre/src/window.rs:1881-2095` (`should_draw` at `:2024`, `present` at `:3915-3930`) | Verified |
| `request_animation_frame` notifies the current view on the next frame; `notify` marks the view **and every ancestor** dirty | `$V/gpui-pre/src/window.rs:2946-2949`, `:2480-2491` | Verified |
| A dirty frame rebuilds the whole scene and the GPU redraws the whole window; there is no partial present. Only `Entity::cached(style)` views that are not dirty reuse their prepaint and paint ranges | `$V/gpui-pre/src/view.rs:250-259`, `:555-559`, `:643`; `$V/gpui-pre/src/window.rs:3734-3875` | Verified |
| Present is `presentDrawable` + `commit` (or `waitUntilScheduled` + `present` during live resize) | `$V/gpui-pre-apple/src/metal_renderer.rs:606-659`; resize path `$REG/.../window.rs:3390-3409` | Verified. One function covers both drawable sources |
| Default throttles: 30 fps when the window is not active, 30 fps in Low Power Mode, 60 fps at thermal Serious/Critical | `$V/gpui-pre/src/platform.rs:2818-2820`; applied at `window.rs:1952-2005`; the app does not override them (`$G/src/desktop_lifecycle.rs:142-153`, `$G/src/window_chrome.rs:6-33`) | Verified. **An unfocused SingZ window is capped at 30 fps today** |
| After high-rate input GPUI keeps presenting the last scene for 1 s | `window.rs:1392-1395`, `:1943-1950`, `:2025-2027` | Verified. An N5 window must start more than 1 s after the last input |
| The display link uses the default frame-rate range | `$V/gpui-pre-apple/src/display_link.rs:76-82` | Verified as written. Whether that yields 120 Hz on a ProMotion or 120 Hz external panel is **not verified**; the Q-02 empty-window probe answers it |
| GPUI's `profiler` feature records "presented" frames at submit time, not at scan-out | `$V/gpui-pre/src/window.rs:3916-3927`; `$V/gpui-pre/src/profiler.rs:1126-1150` (`submitted_at = presentation.present_start`) | Verified. It cannot prove N1-N3 |
| `MTLDrawable.addPresentedHandler` and `presentedTime` are bound, and the crate already enables `block2` | `$REG/objc2-metal-0.3.2/src/generated/MTLDrawable.rs:16-58`; `$V/gpui-pre-apple/Cargo.toml:62`, `:220-234` | Verified |
| `CAMetalDisplayLinkUpdate` exposes `targetPresentationTimestamp`; GPUI drops it before the app sees a frame | `$REG/objc2-quartz-core-0.3.2/src/generated/CAMetalDisplayLink.rs:31-38`; `$V/gpui-pre/src/platform.rs:1064-1077` | Verified |
| Existing patches: 6 crates, 2,961 patch lines; `gpui-pre-apple` already patches `metal_renderer.rs` and exports app-callable globals | `$G/vendor-patches/*.patch`; `$V/gpui-pre-apple/src/gpui_apple.rs:9-12`; callers `$G/src/background.rs:42-54` | Verified. A present observer follows an existing pattern |

### 2.2 What the app does per frame today

| Claim | Evidence | Status |
|---|---|---|
| While playing, the root `Player` requests an animation frame every frame, so the root is notified and `Player::render` reruns in full | `$G/src/main.rs:5380`, `:5591-5638` | Verified |
| No view in the app is cached | `grep -rn '\.cached(' $G/src` → no match | Verified. Every frame re-renders, re-lays-out and repaints every element |
| Root render also runs service syncs each frame | `main.rs:5381-5388` (`sync_audio_provider` twice, `poll_locale`, `sync_microphone`, `refresh_carry_widget`) | Verified. Cost not measured |
| The playhead is a positioned `div` with a shadow and a path, laid out by the root | `main.rs:5714-5740` | Verified. Moving it re-lays-out the timeline overlay |
| Steady playback paints each lane as two cached textures, the second clipped to progress | `$G/src/waveform.rs:238-270` | Verified. This part is already cheap |
| The lane cache key contains the exact view range and size; any pan, zoom or resize frame rebuilds mask, Gaussian blur and two RGBA textures per lane **on the main thread** | `waveform.rs:176-218` (`image::imageops::blur` at `:196`) | Verified. Per-frame cost not measured; it is the first N4 suspect |
| A mute/solo fade rebuilds two RGBA textures per lane at each of up to 64 steps | `waveform.rs:175`, `:220-237`; fade driver `main.rs:5596-5604` | Verified |
| Replaced textures are never released from the sprite atlas | `grep -rn drop_image $G/src` → no match; release is explicit (`$V/gpui-pre/src/window.rs:5504-5516`) | Verified absent. Atlas growth under pan or fade is *(inferred)*; bears on N9/N10 |
| Lyrics paint caches shaped lines by (text, colour, scale); the advancing band is 12 clipped sprite draws plus 12 shaped-line paints for the active word | `main.rs:4673-4700`, `:5010-5050` | Verified. Matches `$G/LYRICS_HIGHLIGHT_STANDARD.md:21-26` |
| Lyrics paint refills a `Vec` per paint and can re-notify the root on geometry change | `main.rs:4751-4760`, `:4799`; R-05 "per-frame allocations" | Verified |
| The pitch strip is its own entity; it is told the position every frame and shapes formatted labels in paint | `main.rs:5631-5634`; `$G/src/pitch_strip.rs:224`, `:596`, `:814`, `:974`; R-05 | Verified |
| Displayed time has one owner, projected from a native anchor at render-time `Instant::now()` | `$G/src/transport_timing.rs:194-222` (`Playhead`), `:473`; `main.rs:5607` | Verified (C-20) |
| `ui_benchmark` measures hidden offscreen render plus readback, at a 120 Hz cadence, and says it is not display FPS | `$G/src/ui_benchmark.rs:1`, `:63`, `:109-119` | Verified. `prepareAndDrawWallMs` is still the best existing proxy for main-thread frame work |
| The perf harness has null slots for `fps`, `frameTimeMs`, `dropped` | `tests/perf/perf_harness.py:103`, `:430`; `tests/perf/README.md` | Verified. C-07 fills them |
| The modal-open clock freeze is presentation-only | `$G/src/backdrop_clock.rs:1-33`; `main.rs:5446-5456`, `:5791` | Verified. Gating must keep it |

R-05 was spot-checked at the rows cited above and not re-derived. Its line
numbers are for `f7607311`; `main.rs` has moved since, and this record's
numbers are for `483b4527`.

### 2.3 What is not known

1. Main-thread work per frame for the reference scenario (Q-02).
2. Whether an empty animating window presents at the panel rate with no drops
   (Q-02 probe). This separates "GPUI scheduling is the limit" from "our frame
   work is the limit".
3. GPU time per frame, including the grain pass (`metal_renderer.rs:687-700`).
4. Behaviour at 120 Hz. No panel is available.

## 3. Options

Costs are worker-days for the Mac plus the Windows follow-through where the
option forces one. "Frame work" means main-thread time from the display-link
signal to command-buffer commit.

### (a) State-gated redraw plus cached per-lane layers, inside GPUI's paint model

Keep one GPUI scene. Stop frames that carry no change; make the per-frame part
small; move rasterisation off the frame path. Three stages, each entered on
evidence:

- **a1. Gate and unblock (always).** No frame without a visible change;
  waveform rasterisation leaves the main thread and stops being keyed on the
  exact view; fades stop rebuilding textures; replaced textures are released;
  per-frame allocation and label shaping are removed from lyrics and pitch
  paint.
- **a2. Thin root (if the baseline says so).** The per-frame layers become
  entities (`LanesView`, `LyricsView`, the existing `PitchStrip`, a
  `PlayheadOverlay`); everything else under `Player` is embedded with
  `Entity::cached(style)`. A playback frame then re-renders the thin root and
  the dynamic views only, and reuses the paint ranges of the rest.
- Cost: a1 9-11 days (C-70 4, C-71 a1 part 3-4, C-72 a1 part 2-3). a2 adds
  5-7 days, mostly in `main.rs`. No Windows-specific work; both platforms share
  it.
- Risk: a1 low to medium (the pan/zoom interim frame is a stretched texture, a
  visible change that needs review). a2 medium: `cached` views need a definite
  size (`view.rs:253-256`), and state now on `Player` must move or be shared;
  it touches the file every other package edits.
- NFR impact: N5/N6 directly (a1). N4 directly (a1 removes main-thread raster
  from pan/zoom). N1-N3: a1 removes spikes; a2 lowers the steady cost. N9/N10
  improve through texture release; a1 adds a bounded overscan texture per lane.
  N11 unaffected or better (less main-thread contention with status handling).

### (b) A custom Metal layer for lanes and the playhead

A second `CAMetalLayer` over or under GPUI's, with its own display link and
renderer for waveforms and the playhead; GPUI keeps chrome, lyrics and input.

- Cost: 15-25 days on the Mac. Windows needs a second implementation
  (DirectComposition or a wgpu surface beside `gpui-pre-wgpu`): another 15-25.
  Plus a patch to the non-vendored mac window crate to host the sublayer.
- Risk: high. Z-order (GPUI modals, menus, tooltips and the region overlay must
  sit above lanes, so the layer must go under a transparent GPUI layer, which
  the grain and backdrop passes do not expect); two frame sources to keep in
  phase during resize, where GPUI switches to `presentsWithTransaction`
  (`$REG/.../window.rs:3394-3407`); hidden-capture drivers
  (`render_to_image`, `metal_renderer.rs:730-739`) would not see the lanes, so
  every image-based test loses them; accessibility bounds (D-06) come from GPUI
  elements.
- NFR impact: best case for N1-N4 on lanes only, since lane frames stop
  depending on the main thread. Lyrics, the costliest text path and the one
  with an approved visual standard, are not helped. N5 needs a second gate. N9
  up by the layer's own textures.

### (c) Patch vendored GPUI's frame scheduling

Change when and how often frames are requested or presented.

- Where it would land: `$V/gpui-pre/src/window.rs:1881-2095` (frame callback,
  throttles, pacer; vendored); `$V/gpui-pre-apple/src/display_link.rs:76-82`
  (frame-rate range; vendored); `$REG/gpui-pre-macos-0.3.11/src/window.rs:3435-3462`
  and `display_link.rs:297-343` (pause/wake and drawable hand-out; **not
  vendored**, so a seventh crate and patch file).
- Cost: 0.5 day for the frame-rate range alone. 3-6 days for anything in the
  callback or the mac window crate, plus rebase cost at each GPUI bump.
- Risk: low for the range setter; medium to high elsewhere (drawable ownership
  and the resize path are subtle, and `metal_renderer.rs:2016-2056` tests only
  the renderer side).
- NFR impact: only N1/N3, and only if scheduling is the limit. It cannot reduce
  frame work, so it cannot fix N2 or N4 if the app's own render is slow.
  Nothing in the code read shows a scheduling defect: the link is per-window,
  demand-driven, and supplies the drawable early.

### Comparison

| | a1 | a1 + a2 | (b) | (c) |
|---|---|---|---|---|
| Worker-days, Mac | 9-11 | 14-18 | 15-25 | 0.5 to 6 |
| Extra for Windows | 0 | 0 | 15-25 | 0 to 3 |
| New vendored crate | no | no | yes (`gpui-pre-macos`) | only beyond the range setter |
| Helps N5 / N6 | yes | yes | no | no |
| Helps N4 | yes | yes | lanes only | no |
| Helps N1-N3 | spikes | spikes and steady cost | lanes only | pacing only |
| Lyrics standard at risk | no | no | no (untouched), but unsolved | no |

## 4. Recommendation

**Option (a), entered as a1 now and a2 on evidence. No custom Metal layer. No
scheduling patch, except a one-line frame-rate-range setter if the 120 Hz probe
needs it. One small vendor patch for measurement only (section 6).**

Reasons, from the code:

1. The scheduling path is already what (c) would build: a per-window
   `CAMetalDisplayLink` that pauses when idle and hands out the drawable. The
   visible defects are on the app side: full root render per frame, no cached
   view, main-thread rasterisation on pan/zoom, texture rebuilds on fade.
2. a1 is needed under every option. Even with (b), N5/N6 need gating and
   lyrics and pitch need their per-frame work removed.
3. (b) doubles on Windows and breaks image-based test coverage; it is the
   only option that costs more than the 2-4 weeks section 10 of the plan allots
   to phase 7.

### 4.1 Design

**Redraw gating (C-70).** One rule: a frame is requested only by a named
animation source that is currently changing visible state. The sources are
closed and enumerated: playback projection, pending-seek hold (≤ 1 s,
`transport_timing.rs:473-480`), lane fade, lane enter, lyric scroll
convergence, countdown sprite, count-in, timeline animation, capture file.
`main.rs:5591-5638` already computes most of this as `animating`; C-70 turns it
into a small `FrameDemand` value with one bit per source, so a test can assert
which source asked. Setters called from render become change-gated
(`pitch_strip.set_position/set_view` at `main.rs:5631-5634` already are, per
R-05). Root notifications from host callbacks are gated on an actual change
(R-05 verdicts). The modal freeze (`backdrop_clock.rs`) stays presentation-only.
The inactive-window throttle is set per section 8 item 2.

**Lanes (C-71).**
- Rasterise per lane off the main thread (`cx.background_spawn`), latest wins,
  published with a generation fence (project epoch, lane revision, size, dpr).
- Texture covers the view plus overscan (one view-width each side, capped by
  the song). Pan inside the overscan is a translate of the same texture. Zoom
  and pan beyond overscan draw the last texture stretched for the interim
  frames and swap when the new raster lands. At rest the pixels equal today's
  (`waveform.rs:63-118` unchanged as the rasteriser).
- Fade: build the two endpoint pairs once (audible and muted) and cross-fade
  with element opacity (`paint_image` carries it, `$V/gpui-pre/src/window.rs:5466-5476`).
  The intermediate colours then differ slightly from today's 64-step filter;
  that needs one visual review (section 8 item 4). Fallback if rejected: keep
  the filter, 8 steps, built off-thread.
- Every replaced texture goes through `window.drop_image`.
- Playhead: paint it (line, glow, cap) in one canvas at a device-pixel-snapped
  x, instead of a laid-out `div` with a shadow. Position still comes only from
  `Playhead` (C-20); no second clock.

**Lyrics and pitch strip (C-72).** Paint layers, slice count, band width,
intensity curve, halo levels and 1/200 progress quantisation are unchanged
(`LYRICS_HIGHLIGHT_STANDARD.md:21-26`). Changes are below the visual surface:
the `layout` vector and shape cache are reused without per-frame allocation,
the geometry re-notify (`main.rs:4751-4760`) stays one-shot, pitch labels are
shaped once per (label, size) and reused, and the roll's static rows are not
rebuilt per frame. The stored pitch line path is cached per view range like the
beat grid already is (`main.rs:5845`).

**Thin root (a2, conditional).** Dynamic entities as above; header, transport,
lane controls, sidebar, footer embedded with `cached`. `Player` keeps ownership
of state; views read through small shared snapshots, not by moving fields
(C-19 is consolidating those fields now; a2 must follow it, not race it).

**Frame pacing against the audio clock.** Keep projecting at render-time
`Instant::now()`. With the drawable supplied by the display link, the offset
to scan-out is close to constant, so the error is a fixed lead of under two
refresh periods plus callback jitter. C-07 records the projected position with
each presented frame; if the jitter of (position delta ÷ presented delta) at
steady rate exceeds 5% p99, pass `targetPresentationTimestamp` through
`RequestFrameOptions` and project to it. That is a later, separate patch and
it is not assumed.

### 4.2 What the baselines must show

T = refresh period (16.67 ms now, 8.33 ms at release). Numbers are for the Mac,
release build, reference scenario, visible window, measured by section 5.

| Q-02 result | Meaning | Action |
|---|---|---|
| Empty animating window: fps within 1% of panel rate, 0 dropped in 3 min | GPUI scheduling is sound | Confirms "no (c)". Proceed |
| Empty animating window drops frames or runs at half rate | Scheduling or system is the limit | Overturns "no (c)". First try the frame-rate-range setter (0.5 day); if that fails, stop and bring it to the user with the trace |
| Reference scenario: frame work p99 ≤ 0.5 T at 60 Hz (8.3 ms), 0 dropped, pan/zoom included | Interim gate met with headroom | a1 only for the interim gate. a2 is decided by the next row |
| Frame work p99 > 0.25 T at 60 Hz (4.2 ms) in steady playback after a1 | 120 Hz target (0.5 T = 4.2 ms) would be missed | Enter a2 |
| Frame work p99 ≤ 4.2 ms after a1 | 120 Hz reachable without a2 | Drop a2; C-71/C-72 shrink to their a1 parts |
| Frame work fine, but GPU time p99 > 0.5 T | GPU-bound (overdraw, grain pass, sprite count) | Not (b). Cut GPU cost inside (a): the grain pass and the 12-slice band are the first suspects; any change to the band needs the user |
| After a2, frame work p99 still > 0.5 T at the target rate | GPUI's cached scene build is itself too slow | Only now is (b) justified. Stop; take it to the user with numbers (plan G1 rule) |
| Paused or idle: any presented frame in 60 s (after the 1 s input sustain) | A redraw source leaks | C-70 not done; the `FrameDemand` log names the source |
| Atlas or footprint grows across 1,000 pan frames or 200 fades | Texture release missing | C-71 not done |

G1 passes for the interim gate when rows 1 and 3 hold, or when rows 1 and 4
hold and a2 is scheduled. The 120 Hz re-run (plan 3.1) repeats the table at
T = 8.33 ms.

### 4.3 NFR budgets per package

All on the Mac reference scenario; "frame work" as defined in section 3.
Interim (60 Hz) figure first, release (120 Hz) in brackets where it differs.

| Package | Frame time | CPU | Memory |
|---|---|---|---|
| C-07 mac | Observer adds ≤ 0.05 ms per presented frame; nothing on the main thread except one atomic load when disabled | ≤ 0.5% of one core while recording; 0 when disabled | ≤ 1 MB: a preallocated ring of 32,768 samples (covers 3 min at 120 Hz plus margin); no allocation per frame |
| C-70 | Not a frame-time package. 0 presented frames in 60 s paused, idle library and modal open (N5) | App + helpers < 1% of one core idle (N6) | No increase (≤ +1 MB) |
| C-71 | Lanes only: frame work p99 ≤ 4.2 ms steady and during pan/zoom/resize [same figure is the 120 Hz budget]; no main-thread raster call longer than 0.5 ms; presented p99 ≤ T, 0 dropped in 3 min; pan/zoom on screen within one frame (N4) | Steady lanes-only playback ≤ 12% of one core main thread at 60 Hz [≤ 24% at 120 Hz]; raster worker ≤ 1 core for ≤ 100 ms after a gesture settles | Waveform textures ≤ 48 MB at 2560×1440 @2x with 6 lanes, constant across 1,000 pan frames and 200 fades; ≤ +24 MB over Q-02 at the default window |
| C-72 | Full scenario: frame work p99 ≤ 8.3 ms [≤ 4.2 ms]; presented p99 ≤ T, 0 dropped in 3 min; 0 shape-cache misses and 0 heap allocations in lyric and pitch paint across 600 steady frames | Full playback main thread ≤ 25% of one core at 60 Hz; total within N7 (≤ Electron, target half) | Shape and label caches bounded per project and cleared on project change; ≤ +8 MB over Q-02 |
| All four together | N1-N3 as gated | N6, N7 | ≤ +32 MB over the Q-02 native figure and still within N9; N10 slope within noise |

"Presented p99 ≤ T" is read with a 3% tolerance (17.2 ms at 60 Hz), because
present times are quantised to refresh periods: a p99 of exactly 16.67 ms is
the best possible value, and timestamp jitter alone would fail a strict ≤ 16.7.
The user is asked to confirm this reading (section 8 item 3).

## 5. How presented frames are measured on macOS

### 5.1 Options

| Method | Per-frame present time | Dropped frames, p99 | Hidden window | Works for Electron | Verdict |
|---|---|---|---|---|---|
| Display-link callback timestamps in the app (`CAMetalDisplayLinkUpdate`, or `CVDisplayLink`) | No. It reports when a frame is **requested** and its target time | Only requested-versus-drawn; cannot see a frame that was drawn late or discarded by the compositor | No link when hidden | No | Use as the **expected-frame reference**, not as the measurement |
| Instruments, Metal System Trace / Display template | Yes, from the system side | Yes, by hand | No | Yes | Manual, not scriptable into the C-06 JSON; needs Xcode on the machine. Keep for diagnosis |
| `MTLDrawable.addPresentedHandler` + `presentedTime` | **Yes**: host time the drawable reached the display, 0 if it was skipped | **Yes**, computed from the deltas | No drawable when hidden | No | **Chosen** for native |
| GPUI `profiler` feature | Submit time only (2.1) | "Late" relative to its own estimate | n/a | No | Rejected for N1-N3; usable as a frame-work source |
| ScreenCaptureKit frame-delta observer | Display time of each changed frame, from outside | Yes | No | **Yes** | Common cross-check for both apps; needs Screen Recording permission *(inferred: not implemented here)* |

### 5.2 Chosen method

**Primary, native: a presented handler on every drawable GPUI presents,
recorded in-process, written into the C-06 schema.**

- Each presented drawable yields one sample: `presentedTime` (seconds, host
  clock), the commit time, the display link's `targetPresentationTimestamp`
  when one drove the frame, frame work in ms, and the app's `FrameDemand` bits
  and projected song position for that frame.
- **fps** = (n − 1) ÷ (last − first `presentedTime`) over the window.
- **frame time** = successive `presentedTime` deltas; report p50, p99, max.
- **dropped** = Σ max(0, round(delta ÷ T) − 1) over consecutive samples taken
  while a continuous animation source was demanding frames, plus every sample
  whose `presentedTime` is 0. T comes from the median delta of
  `targetPresentationTimestamp`, cross-checked against the display mode. A gap
  that spans a period with no demand is not a drop; that is why demand is
  recorded per frame.
- **N5** = number of samples in the idle window, which must be 0. The window
  starts 2 s after the last input, because GPUI re-presents for 1 s after
  high-rate input (2.1).
- **Headroom** (diagnostic, not a gate by itself): frame work, and GPU time
  from `GPUStartTime`/`GPUEndTime` in a completed handler on the same command
  buffer. Present deltas are quantised and cannot show how close a frame came
  to missing.

**Cross-check and Electron leg: ScreenCaptureKit observer** in `tests/perf/`,
capturing the one window and counting frames whose status is complete, with
their display times. It runs unchanged against both apps. It is the fallback
named in the plan's risk table and the only like-for-like figure for Q-01. It
is not the gate: N1-N3 are absolute budgets on the native app, so the native
gate does not depend on Electron being measurable the same way. Acceptance for
the observer is agreement with the presented-handler count within 1% on the
native app.

### 5.3 What needs a visible window

| Measurement | Window |
|---|---|
| Presented fps, frame time, dropped (N1-N3), pan/zoom latency (N4), idle presents (N5) | **Visible, unoccluded and key.** Hidden: no display link, no drawable, no handler. Not key: capped at 30 fps unless section 8 item 2 changes it |
| ScreenCaptureKit cross-check | Visible, on a display, Screen Recording granted to the runner |
| Frame work per frame, shape-cache misses, allocation counts, `FrameDemand` | Hidden is enough (`ui_benchmark.rs`, `ui_perf_scenario.rs`) |
| CI perf smoke (plan 3.3): offscreen frame cost and "idle redraw count = 0" | Hidden. The idle count there is the number of frames **demanded** (`FrameDemand` non-zero) and drawn, not presented; it is a smoke signal and is labelled so |

Visible runs follow plan 3.2: dedicated or virtual display, muted, on mains
power with Low Power Mode off (otherwise the 30 fps throttle in 2.1 applies),
window frontmost, nothing overlapping it. The run record stores display mode,
refresh rate, power source, Low Power state and thermal state, and a run with
Low Power on or thermal state above Nominal is rejected, not averaged.

## 6. Does vendored GPUI need patching?

**Yes, once, for measurement. No for the architecture.**

| Patch | Where | Size | When |
|---|---|---|---|
| Present observer | New `$V/gpui-pre-apple/src/present_observer.rs`; export beside the grain functions at `$V/gpui-pre-apple/src/gpui_apple.rs:9-12`; attach in `MetalRenderer::draw` at `$V/gpui-pre-apple/src/metal_renderer.rs:651-658`, before `present` / `presentDrawable`, on both branches | About 80-120 lines. No `Cargo.toml` change: `block2` and `MTLDrawable` are already enabled | C-07 mac leg |
| Frame-rate range | `$V/gpui-pre-apple/src/display_link.rs:76-82` (`setPreferredFrameRateRange`) | About 5 lines | Only if the 120 Hz empty-window probe runs below the panel rate |
| Target presentation time to the app | `$V/gpui-pre/src/platform.rs:1064-1077` plus the non-vendored mac window crate at `window.rs:3451-3455` | Would add a seventh vendored crate | Only if the pacing jitter test in 4.1 fails. Not planned |

Observer contract: `gpui_apple::set_present_observer(Option<Arc<dyn Fn(PresentSample) + Send + Sync>>)`.
With none installed the cost is one atomic load per present and no handler is
attached, so the ship binary is unchanged in behaviour. The handler runs on a
system thread: it may only copy numbers into the app's preallocated ring. The
app installs it only under the `ui-tests` feature (D-05's qualify profile);
it adds no environment read to the ship build. The patch follows the vendor
rules: edit `vendor/gpui-pre-apple`, `scripts/gpui-vendor.py --update-patch
gpui-pre-apple`, commit the patch and `vendor.lock`, with a short
`PRESENT_OBSERVER.md` note in the crate like the existing ones.

## 7. Consequences

- **Plan order.** D-02 no longer waits for Q-02; Q-02's probe now needs C-07's
  mac leg first (it always did, per the Q-02 row). C-70 and the a1 parts of
  C-71/C-72 can start at G0 without waiting for a second D-02 pass. a2 is
  decided by the table in 4.2 and recorded as an addendum here.
- **C-71 and C-72 change shape.** Each has an a1 part (fixed) and shares the a2
  part (conditional). Plan estimates of 5 + 5 days hold for a1 + a2 together
  only if a2 lands at the low end; with a2 the pair is 10-14 days.
- **C-73** gains the atlas release check from C-71 as an input; texture release
  is done in C-71 because it is the same code.
- **Windows.** Everything in (a) is shared code. The measurement on Windows
  stays PresentMon (C-07 Windows leg); the `FrameDemand` log and frame-work
  samples are platform-neutral and feed both.
- **Tests.** Image-based drivers keep working; nothing leaves the GPUI scene.
  The approved lyric evidence stays immutable; C-72 is checked against it, not
  regenerated.
- **Unfocused playback.** If item 2 in section 8 is accepted, an unfocused but
  visible window animates at the panel rate while playing, like Electron
  *(inferred for Electron: Chromium does not throttle visible unfocused
  windows)*, at some battery cost.
- **What this record does not cover.** GPU share on Windows (N8) and whether
  the grain pass is affordable there; both need Q-02 on the laptop.

## 8. What the human must decide or sign off

1. **The ladder.** a1 now; a2, the range setter and anything beyond are entered
   only by the 4.2 table; (b) only after a2 fails, and only with your
   agreement.
2. **Unfocused-window throttle.** Default GPUI caps an inactive window at
   30 fps. Recommended: set `inactive_frame_interval: None` so playback is
   smooth on a second display while another app has focus; keep the Low Power
   (30 fps) and thermal (60 fps) limits. The alternative is to keep 30 fps
   unfocused and accept that N1-N3 hold only for the key window.
3. **Reading of "p99 ≤ 16.7 ms".** Accept the 3% tolerance in 4.3, with "0
   dropped" as the strict half of the gate.
4. **Fade appearance.** The cross-fade changes mid-fade lane colours slightly.
   Approve from a before/after capture in C-71, or choose the 8-step fallback.
5. **One more vendor patch** (present observer in `gpui-pre-apple`), and the
   rule that `gpui-pre-macos` is not vendored without a new decision.
6. **Screen Recording permission** for the perf runner on the Mac, needed only
   for the ScreenCaptureKit cross-check and the Electron leg.
7. **Low Power and thermal limits apply to budgets.** N1-N3 are claimed on
   mains power at nominal thermal state only.

## 9. File-level outlines for the unblocked packages

Shared rules for every package: workers are not alone in the tree, preserve
others' edits, and never run `git stash`, `checkout`, `reset`, `clean`, `add`,
`commit` or `push`. `main.rs` is also edited by the C-17 to C-22 chain; each
outline limits its `main.rs` ranges and the coordinator sequences them. Native
builds go through `scripts/with-native-build-lock.mjs`. Every test below must
be shown to fail against the pre-change code or a deliberate negative control.

### C-07 (mac leg) — Presented-frame capture (2.5 days of the row's 5)

- **Tier**: Coder default, `codex` `gpt-reserve`, effort medium. The vendored
  part is unsafe Objective-C block code on the present path, so it gets a V-01
  review by `claude-sonnet-5-5`.
- **Files to edit**: `$V/gpui-pre-apple/src/present_observer.rs` (new),
  `gpui_apple.rs` (export), `metal_renderer.rs` (`draw`, `:651-658` only), new
  `PRESENT_OBSERVER.md`; then `$G/vendor-patches/gpui-pre-apple.patch` and
  `vendor.lock` through `--update-patch`. New `$G/src/frame_log.rs` (ring,
  statistics, JSON), compiled under `ui-tests`. `$G/src/ui_perf_scenario.rs`
  (new `frames` action: start, stop, write). `$G/src/main.rs` limited to the
  `mod` line and one call recording `FrameDemand` and position at
  `:5635-5638`. `tests/perf/perf_harness.py` (fill `fps`, `frameTimeMs`,
  `dropped`; record display mode, power and thermal state; reject bad runs),
  `tests/perf/test_perf_harness.py`. New `tests/perf/sck_observer.swift` (or
  equivalent) and its wrapper for the cross-check.
- **Tests that prove it**:
  - Unit, `frame_log.rs`: synthetic present times at 60 and 120 Hz give the
    rate within 0.1%; one removed sample gives dropped = 1; a gap with no
    demand gives dropped = 0; a zero `presentedTime` counts as dropped; the
    ring never allocates after construction.
  - Unit, vendored crate: with no observer no handler is attached; with one,
    a presented drawable in the existing renderer test harness
    (`metal_renderer.rs:2016-2056` pattern) delivers one sample.
  - Live, visible: a static animation (the empty animating window) for 60 s
    reports the panel rate within 1% and 0 dropped. Negative control: an
    injected 25 ms sleep every 60th frame reports ≥ 1 dropped per second.
  - Live, visible, paused for 60 s: 0 samples. Negative control: an injected
    100 ms repeating notify reports about 600.
  - Cross-check: ScreenCaptureKit count within 1% of the handler count on the
    native app.
- **Acceptance**: the plan row's (60 Hz run within 1% on a static animation;
  the 120 Hz run is deferred with the panel and recorded as such), merged into
  the C-06 schema; a hidden run reports the frame slots as null with the reason
  "hidden window presents no frames", never as zero.

### C-70 — Redraw gating: no frame without a state change (4 days)

- **Tier**: Coder default, `codex` `gpt-reserve`, effort medium. If the first
  attempt cannot keep the UI drivers green, escalate one tier to
  `claude-sonnet-5-5` (convention-bound across host modules) and say so.
- **Files to edit**: new `$G/src/frame_demand.rs` (the closed set of sources);
  `$G/src/main.rs` limited to `:5381-5388` (move per-frame syncs behind change
  checks) and `:5591-5638` (build `FrameDemand`, request a frame only when it
  is non-zero), plus the lyric canvas requests at `:4751-4760`, `:4790`,
  `:4825`; the host modules whose root notifications R-05 marks "gate
  duplicate/no-op": `lyrics_sidebar_host.rs`, `analysis_host.rs`,
  `custom_tracks_host.rs`, `engine_setup.rs`, `audio_recovery_host.rs`,
  `locale_host.rs`, `settings.rs` (equal-value updates only);
  `$G/src/desktop_lifecycle.rs:142-153` for the throttle option, per section 8
  item 2. `backdrop_clock.rs` is read, not changed.
- **Tests that prove it**:
  - Unit, `frame_demand.rs`: each source sets and clears its bit; paused with
    no pending seek, fade, enter, scroll or countdown gives zero.
  - Hidden driver (new `$G/tests/test_native_idle_redraw.py` on
    `ui_perf_scenario`): paused, idle library, and modal open each give 0
    demanded frames and 0 draws over 10 s after a 2 s settle; playing gives
    one per simulated frame. Negative control: the pre-C-70 build fails at
    least the idle-library or progress-notify case, or an injected repeating
    notify does.
  - Visible, with C-07: 0 presented frames in 60 s for the three N5 states;
    idle CPU < 1% of one core over 60 s (N6), three runs.
  - Existing: every `$G/tests/test_native_*_ui.py` driver green;
    `test_native_modal_backdrop` proves the freeze still holds.
- **Acceptance**: N5 and N6 on the Mac by presented-frame count; the Windows
  field laptop run is listed as outstanding until its session.

### C-71 — Lane and playhead rendering (a1: 3-4 days; a2 share: 3-4 days)

- **Tier**: a1 Coder default, `codex` `gpt-reserve`, effort medium. a2 Coder,
  `claude-sonnet-5-5` (restructures `Player` render, where project conventions
  and the C-19 state layout matter); V-01 of a2 by a Codex model.
- **Files to edit (a1)**: `$G/src/waveform.rs` (off-thread raster with
  generation fence, overscan texture, interim stretch, endpoint cross-fade,
  `drop_image` on replacement, a pure `plan_layers` function for tests);
  `$G/src/main.rs` limited to the lane canvas at `:5253-5290` and the playhead
  block at `:5714-5740`; new `$G/src/playhead_overlay.rs` (painted playhead).
  **(a2)**: new `$G/src/lanes_view.rs`; `main.rs` render tree only (which
  subtrees are embedded with `cached`), after C-19 has landed.
- **Tests that prove it**:
  - Unit, `waveform.rs`: at rest the produced mask equals the current `mask`
    output byte for byte for 5 view ranges and 2 scale factors; a pan inside
    overscan plans zero raster jobs; 1,000 pan steps and 200 fades leave the
    live texture count constant (negative control: the current key at
    `:176-196` plans a raster per step); a stale generation is never published.
  - Hidden driver on `ui_benchmark`/`ui_perf_scenario`: frame work p99 for
    lanes only within the 4.3 budget in steady playback and during a scripted
    pan/zoom/resize burst; no main-thread raster call over 0.5 ms.
  - Image: lane captures at rest unchanged against the current references;
    a before/after fade strip for the user (section 8 item 4).
  - Visible, with C-07: lanes-only playback 3 min, presented p99 ≤ T and 0
    dropped; pan and zoom change appears in the next presented frame (N4);
    `starvedBlocks` = 0 during the burst once D-07's status field exists.
  - Timing: `test_native_transport_timing_ui.py` and the C-20 sampling tests
    unchanged and green (the playhead still has one clock).
- **Acceptance**: N1-N4 with lanes only at the interim gate; atlas and
  footprint flat across the pan and fade loops; a2 entered or dropped by the
  4.2 table, with the number written into this record.

### C-72 — Lyrics and pitch strip rendering (a1: 2-3 days; a2 share: 2-3 days)

- **Tier**: Coder, `claude-sonnet-5-5` (the approved highlight standard and
  i18n text paths are convention-bound); V-01 by a Codex model.
- **Files to edit (a1)**: `$G/src/main.rs` limited to the lyric canvas
  `:4575-5070` (reuse `layout` and shape storage, one-shot geometry notify, no
  per-frame `String` for cache keys); `$G/src/pitch_strip.rs` (`paint_roll`
  `:626-870`, `paint_native_notes` `:872-1030`: label and path caches keyed by
  view range, size and transpose); `$G/src/lyrics_countdown.rs` only if the
  sprite text allocation R-05 notes is on the steady path. **(a2)**: new
  `$G/src/lyrics_view.rs` holding the canvas as its own entity; `PitchStrip`
  embedded with `cached` when its inputs are unchanged.
  `$G/LYRICS_HIGHLIGHT_STANDARD.md` and `tests/reference/approved-lyrics-120hz-v1/`
  are **not** edited.
- **Tests that prove it**:
  - Highlight: the consecutive-frame check the standard requires, 161 samples
    at 120 Hz over 63.85-65.18 s, compared with captures taken from the
    pre-C-72 build at the same geometry: identical. `advancing_glow_draws`
    per frame unchanged (12 per active word).
  - Hidden driver: across 600 steady frames, shape-cache misses = 0 and a
    counting allocator scoped to lyric and pitch paint reports 0 allocations;
    negative control: the pre-C-72 build reports more than 0.
  - Hidden: full-scenario frame work p99 within the 4.3 budget.
  - Visible, with C-07: full reference scenario 3 min, presented p99 ≤ T, 0
    dropped; pan/zoom within one frame with lyrics and pitch visible.
  - Existing: `test_native_lyrics*` and pitch drivers, the lyric scroll
    review, all green.
- **Acceptance**: N1-N4 on the full reference scenario at the interim gate;
  highlight standard unchanged; the 120 Hz figures recorded as "not measured,
  panel unavailable" until the re-run before Q-15.

## 10. Not verified

- Every cost in ms. No frame was timed for this record.
- That the default `CAMetalDisplayLink` range reaches 120 Hz on a 120 Hz panel.
- Atlas growth from unreleased waveform textures (the missing release is
  verified; its size is not).
- The blur and texture rebuild cost per lane during pan/zoom.
- That element opacity on a canvas gives an acceptable fade (API verified,
  appearance not).
- ScreenCaptureKit behaviour for the Electron window, and that its frame
  status and display time are sufficient for a 1% agreement.
- The Windows side of any of this beyond "the code is shared".
- R-05 rows outside those cited in 2.2.
