# The desktop's second copy of every song

Status: **released** (2026-09-07). Under native playback the renderer now lets
its decode of every lane go the moment the core is playing, and fetches back
whatever a later reason needs. What follows is the scope as it was measured
and argued, then what the release actually turned out to be — including the
double meaning the scoping pass had NOT found, which was the largest single
piece of the work.

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

## Every holder has a second meaning, and that is the actual work

Discovered by doing the first two steps rather than by reading. A holder is
never only "the samples": each one is also a CONDITION somewhere, and
releasing it answers that condition wrongly and silently. The type system
cannot see any of this — `stamp-upgrade-e2e.cjs` caught the first one, unit
tests and typecheck were green throughout.

- **`vocalsBufRef`** is the samples AND "is there a song to measure". The
  melody staleness gate read `buf.duration` for the length and `!buf` for "no
  vocals lane at all — adopt whatever is stored". Release the buffer and the
  second reading fires: a stale v1 melody is adopted instead of re-derived,
  which is the cross-song contamination that arm exists to prevent. Fixed by
  giving the length its own ref, set wherever the buffer is.
  Beware the obvious repair: reading the length from `tracks` instead looks
  equivalent and is not. `prepMelody` runs inside the load, before React has
  committed the lane state, so `tracksRef` is empty there and the gate takes
  the same wrong arm. It has to be a ref written beside the buffer.
- **`originalBufRef`** is the samples AND "can a split provide PCM".
  `if (status.needsPcm && originalBufRef.current)` skips `provideSplitInput`
  entirely when the buffer is gone — no error, no PCM, a split that proceeds
  without its input. The song file is on disk (`song.path` is right there in
  the same call), so this one wants a re-decode, not a guard.

  Do it WITH the release, not before. That ref is only populated when a raw
  song file is opened — for a project that already has stems it is null
  today, so re-splitting one already takes the skip branch. Adding the
  re-decode on its own therefore changes a live path (every `needsPcm`
  re-split gains a decode and an offline render) for no benefit until
  something is actually released. Written and reverted once for that reason.
  Note also that `media:read` THROWS on an unauthorized path, so the read
  belongs inside the try, not just the decode.
- **The four analysis refs** are the fallback AND what Re-detect reads live.
  `analysisStems`/`melodyInput` prefer `decodeStemAtFileRate(path)` and use
  the refs only when a stem cannot be read at its own rate, so releasing them
  removes a fallback rather than a primary — but it removes it at Re-detect
  time, not at load, which is where it will be noticed.

The lesson for the remaining steps: for each holder, find what asks "is it
there?" before deciding what to do about the samples themselves.

## The release, as built

One `AudioBuffer` per lane, held in the engine, nulled by
`releaseLaneBuffers()` and fetched back by `ensureTrackBuffer(id)`. Around
that:

- **The release is gated on `nativePlayback.active`**, not on the preference
  or on the load. Native decides at every Play whether it can take the song
  (`tryStart` can decline the fifth Play of a song it took four times), and
  the Web Audio fallback lives on the other side of that decision. So the
  buffers go only once the core is demonstrably playing, in `performPlay`,
  before the `emit()` — one notification, one consistent picture.
- **A released lane is always recoverable**, and this is what makes the whole
  thing safe rather than merely careful: native REFUSES a song any of whose
  lanes lacks a readable path (`desktopNativePlaybackSupported` checks every
  one). A lane with no path is therefore never released.
- **Web Audio never starts on a partial mix.** `performPlay` awaits
  `ensureLaneBuffers()` before the fallback and throws if any lane cannot be
  restored. A decode costs a second or two of silence at Play; a mix quietly
  missing a lane costs the singer the take.
- **The engine still does not speak to `window.singz`.** It is handed a
  reader (`setLaneReader`) and decodes with its own context, so the samples
  come back at the output device's rate, exactly as at load.
- **The lanes on screen mirror the engine**, in both directions, from the
  existing subscription — so `Waveform` draws from `peaks` while the samples
  are away and gets its sample-accurate zoom back if a fallback restores
  them. The mirror is skipped whenever the two sides disagree about which
  lanes exist, because it fires from inside `engine.load`, one `setTracks`
  before the app's lane list catches up, and matching an old lane id against
  a new song's engine would put another song's samples on screen.

## The four analysis refs were also FOUR SONG IDENTITIES

The scoping pass had these as "a fallback, read live at Re-detect". They were
also the thing seven `if` statements compared to decide whether the song had
changed under a running analysis:

```
if (drumsBufRef.current !== drums) return // song changed mid-flight
```

That is an identity check that only means what it says while the ref outlives
the whole pass. The moment a lane can be let go, a release mid-analysis reads
as a song switch and the pass abandons its work — quietly, and only under
native playback, and only on songs long enough for the release to land first.
Every one of them is now `loadSeq`, which is what the other twenty long-running
analyses in `App.tsx` already asked.

With that, the refs answered nothing that something else did not answer
better, and all five are gone: `drumsBufRef`, `bassBufRef`, `vocalsBufRef`,
`instBufsRef` and `originalBufRef`. What replaced each meaning:

| the ref used to mean | now |
|---|---|
| "this song has drums / harmonics / vocals" | `hasStem(id)` / `hasHarmonicStems()`, off `audibleIdsRef` |
| "the song has not changed under me" | `loadSeq` |
| "the analysis fallback samples" | `laneSamples(id)` — a re-decode, only on the path where a stem file cannot be read at its own rate |
| "a split can hand over PCM" | a re-decode of `song.path`, inside the try, since `readAudio` throws on an unauthorized path |
| "the vocals are long enough to judge a stored melody" | `vocalsSecondsRef` (landed earlier) |

`melodyInput` can now answer null — neither the file nor a re-decode — and
`prepMelody` stands its status back down to `none` when it does, so a later
prep can try again rather than find `computing` forever.

## Shape, as scoped

- ~~Kit first: `Waveform` takes a nullable buffer and falls back to peaks.~~
  **Done** — `@singz/ui` v1.7.0, and both apps are on it.
- ~~`UITrack` carries `duration`.~~ **Done** — the lane carries it, and the
  song length, the per-lane view fractions, the added-track notice and the
  start-offset clamp all read it rather than a buffer.
- ~~The melody staleness gate stops reading its length off the buffer.~~
  **Done** — `vocalsSecondsRef`, see above for why not `tracks`.
- ~~**`prepMelody`'s `if (!buf) return`.**~~ **Done** — it asks the inventory
  (`hasStem('vocals')`) instead. "The vocals samples are not resident" is a
  fact about memory; answering it there would have left the pitch strip empty
  on every song the native graph was playing.
- ~~Release covers the lane AND the analysis/original refs.~~ **Done** — the
  refs are gone entirely; see above.
- ~~Re-decode on demand.~~ **Done** for the editor (`ensureTrackBuffer`), the
  split's PCM leg, the analyses' per-stem fallback and the Web Audio
  fallback. **Not done, deliberately, for deep zoom**: past the 600-bucket
  threshold `Waveform` draws from `peaks` instead of fetching a hundred
  megabytes back for a picture. Peaks are what every wider view draws from
  anyway, so this degrades detail rather than blanking, and a fallback to Web
  Audio restores the sample-accurate draw as a side effect.

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
