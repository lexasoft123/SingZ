# The desktop's second copy of every song — scope

Status: **scoped, not started** (2026-09-07). Bigger than it looks; the two
things that make it so are in "What the first draft got wrong".

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

Those are the four rules that harness reports red "by decision". The delta is
the renderer's copy: legacy holds one, native holds two.

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

## What the first draft got wrong

Both errors were found in review, before any code.

**The analysis refs pin the same objects.** (7) holds its own references to the
very `AudioBuffer`s the lanes hold. Dropping `track.buffer` alone frees
NOTHING — the measured delta would not move, and the work would look done. Any
release has to cover the lane and all five refs, or be scoped so those refs
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

- Kit first: `Waveform` takes a nullable buffer and falls back to peaks.
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
  renderer can do, so the rows move on the collector's schedule, not ours.
- **`prepMelody` and Re-detect are the blast radius** if a release is wrong:
  a wrong duration corrupts a stored line and saves it.

## The measurement

`player-session-e2e.cjs` on a quiet host, the four footprint rows — the reason
this exists and the proof it worked. Run the melody/beat song-switch and
bar-editing mac drivers too: the consumers most easily broken here are exactly
what those cover.
