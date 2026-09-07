# The desktop's second copy of every song — scope

Status: **kit landed, app change not started** (2026-09-07). The bytes are
reclaimable — measured below — and the shape is bigger than it looks; the two
things that make it so are in "What the first draft got wrong". `@singz/ui`
v1.7.0 ships the nullable `buffer` this needs, and both apps are on it.

## The cost

Under native playback the desktop holds each song TWICE: the core's decoded
lanes in the graph, and the renderer's `AudioBuffer` per lane. Measured by
`player-session-e2e.cjs` on a quiet Mac, native against legacy:

| phase | legacy | native | delta |
|---|---|---|---|
| idle in player | 624 MB | 704 MB | +80 |
| playing | 672 MB | 805 MB | **+133** |
| pitch change | 659 MB | 813 MB | +154 |
| after leaving | 749 MB | 813 MB | +64 |

Those are the four rules that harness reports red "by decision": legacy holds
one copy of the song, native holds two. The delta is the SECOND copy — see the
measured section for which of the two it is, and why that is not the one this
work removes.

**And it is macOS-only value today.** `desktopNativePlaybackPreferred` returns
the stored choice, else `platform === 'darwin'` — Windows is still Web Audio by
default, so the whole Windows fleet still needs every lane resident. The
memory-constrained half of the fleet gets nothing from this until native is
the default there too.

## Who needs the decoded buffer

Enumerated from the code, and the first draft of this list was wrong in a way
that would have wasted the work — see below.

1. **Web Audio playback** — the legacy backend, and the fallback when native
   refuses. Every lane, resident, for as long as it plays.
2. **`computePeaks`** (`makeTrack`, App.tsx) — one-shot at load.
3. **Zoomed waveform drawing** — `@singz/ui`'s `Waveform` reads
   `getChannelData` only when `span * n < RAW_THRESHOLD_BUCKETS` (600). Every
   wider view draws from `peaks`. Inside that component, every read of the
   buffer lives in that one branch.
4. **`duration`** — and not just once at load: `Engine.load` derives
   `this.duration` from `t.buffer.duration`, `applyLoop` and `start` read
   `src.buffer.duration`, `TrackStack` reads it per lane per render, and
   App.tsx reads it for the added-track notice. `UITrack` has no `duration`
   field, so carrying it is a new field plus an engine change, not free.
5. **LyricsEditor's vocals envelope** — `engine.getTrackBuffer('vocals')`,
   while the editor is open.
6. **The splitter's `needsPcm` leg** — `originalBufRef` is rendered through an
   `OfflineAudioContext` into `provideSplitInput`, on demand and arbitrarily
   long after load. A placeholder there hands the splitter silence, with no
   error.
7. **The analysis refs** — `drumsBufRef`, `bassBufRef`, `vocalsBufRef`,
   `instBufsRef`. These are the declared fallback in `analysisStems` and
   `melodyInput` when a stem file cannot be read at its own rate, and they are
   read live at Re-detect, not only at load.
8. **`prepMelody`'s staleness gate** — `melodyFitsSong(stored.f0, hopSec,
   buf.duration)` with `buf = vocalsBufRef.current`.

## Measured, 2026-09-07: the bytes are reclaimable, and only a COMPLETE release returns them

The doubt this had to settle was whether dropping references returns anything
at all, given Chromium has no `AudioBuffer.release()`. A driver opened
Deutschland (323.06 s, six stereo lanes) under native playback, forced GC with
`--js-flags=--expose-gc`, and read the RENDERER process alone with
`footprint -p <pid>`:

| | renderer footprint |
|---|---|
| holding the lanes | 914 MB |
| after dropping ONLY `engine.tracks[].buffer` | 865 MB |
| after also dropping the React lane state and the analysis/original refs | **126 MB** |

**This is NOT the number "The cost" reports, and the two must not be
compared.** `player-session-e2e.cjs` sums `top`'s MEM column across the whole
process tree — main, renderer, GPU, utility — on its own ~2-minute staged
song. This is one process, a different metric, and a song two and a half times
longer. It answers a different question, deliberately: *is the renderer's copy
reclaimable at all?*

Three conclusions:

- **Reachability is retired.** 788 MB came back. Those six lanes are
  6 × 323.06 s × 2 ch × 48 kHz × 4 B = 744 MB decimal — the same order, and
  the excess is consistent with the peaks and analysis arrays going with them.
  (`footprint` reports binary units and the computed figure is decimal, so
  this is an order-of-magnitude agreement, not a match.) The rate is the
  OUTPUT DEVICE's, not the file's — `decodeAudioData` resamples, so the same
  song costs 684 MB against a 44.1 kHz device. The harness's staged song is
  122.4 s, which scales to ~282 MB — still well above its largest delta, so
  the comparison below is a cross-song extrapolation, safe in direction
  rather than in magnitude.
- **Timing is NOT retired.** This run forced GC, which production does not.
  The Risks section below still stands in full.
- **A partial release returns 6% and looks finished.** Dropping the engine's
  lane references alone — the obvious change, and what the first draft of this
  scope described — moved 49 MB of the 788.

One thing the experiment implies that "The cost" does not say: the +80…+154 MB
the harness reports is what NATIVE ADDS, i.e. the core's own decoded lanes.
The renderer's copy — what this work removes — is the larger figure. Releasing
it should take native's footprint BELOW legacy's rather than merely level with
it. If it does not, the two copies are not the same size, and that is worth
knowing before anything is claimed.

## What the first draft got wrong

Both errors were found in review, before any code.

**The analysis refs pin the same objects.** (7) holds its own references to the
very `AudioBuffer`s the lanes hold. Dropping `track.buffer` alone frees
almost nothing — 49 MB of the 788 measured above — and the work would look
done. Any release has to cover the lane, the four analysis refs and
`originalBufRef`, or be scoped so those refs
are re-read from files instead (which is what `analysisStems` prefers already;
the refs are its fallback).

**There is no zero-length placeholder.** The first draft's central claim was
that `Waveform` guards on `buffer.length > 0`, so an empty `AudioBuffer` would
let a released lane keep the prop type and no kit change would be needed.
Chromium will not construct one: `createBuffer(1, 0, 48000)` and
`new AudioBuffer({length: 0})` both throw `NotSupportedError` (measured in this
tree's Electron 43.2.0 / Chrome 150). The smallest legal buffer is length 1,
which PASSES that guard and draws a flat one-sample line at deep zoom instead
of falling back to peaks. `WaveformProps.buffer` is non-nullable, so `null` is
not available either. **So `@singz/ui` needs a change** — a nullable buffer, or
a released flag the guard keys on — and this is a cross-package change, not a
contained one.

**And `prepMelody` makes a placeholder dangerous, not just wrong.** A
zero-or-one-sample duration makes every stored melody look like it was tracked
from a different song, so the line re-tracks and auto-saves on every open —
the exact corruption `melodyFitsSong` exists to catch.

## Shape, if it goes ahead

- ~~Kit first: `Waveform` takes a nullable buffer and falls back to peaks.~~
  **Done** — `@singz/ui` v1.7.0, and both apps are on it.
- `UITrack` carries `duration` (and the engine takes it from the lane rather
  than the buffer), so nothing reads duration off a released lane.
- Release covers the lane AND the analysis/original refs, or those refs are
  converted to read from files at their own rate — the path `analysisStems`
  already prefers.
- Re-decode on demand from `sourcePath` when the view crosses the raw
  threshold, the editor opens, a split needs PCM, or playback falls back to
  Web Audio; drop again when the reason goes away.

Nothing here is new machinery — the phones do lazy decode plus explicit
release for the same reason, with harsher consequences (a jetsam kill on the
fifth song).

## Risks

- **The fallback path is the sharp one.** Native refusing must still reach
  audible Web Audio playback, now with a decode in front of it.
- **Zoom must not stutter**, and must never blank: draw peaks until the decode
  lands.
- **GC is not release.** Chromium has no `AudioBuffer.release()` (the phones
  patched one in — audio-api patch 4). Dropping the last reference is all the
  renderer can do, so the rows move on the collector's schedule, not ours —
  the measurement above forced GC explicitly, which production will not. The
  harness samples per phase, so confirm the rows actually move before claiming
  them.
- **`prepMelody` and Re-detect are the blast radius** if a release is wrong:
  a wrong duration corrupts a stored line and saves it.

## The measurement

`player-session-e2e.cjs` on a quiet host, the four footprint rows — the reason
this exists and the proof it worked. Run the melody/beat song-switch and
bar-editing mac drivers too: the consumers most easily broken here are exactly
what those cover.
