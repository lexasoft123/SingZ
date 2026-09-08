# Playing FLAC without decoding the song first

**Verdict: feasible, and the decode was never the expensive part.** Streaming six
lanes in realtime costs **under 1% of a core on this Mac** and single-digit
percent on the field phone. What costs 1.5 s of every phone open and ~141 MB per
song is not the decoding — it is decoding *all of it at once, before the singer
sees anything*.

This is a research note, not a plan of record. Nothing here is implemented.

## Built and measured (2026-09-08)

`zcore/src/media/flac_streaming_source.cpp` implements `StreamingAudioSource`
over the vendored libFLAC. Not wired into the graph — the realtime node that
consumes it is the next step — but real, tested against the full decode, and
benchmarked on hardware.

`flac_streaming_benchmark <lane.flac>...`, the six Deutschland stems (323.1 s
each), against `prepareDecodedAudio` — the path in use today:

| | decode everything | stream: open + one 0.5 s window | |
|---|---|---|---|
| **Mac (M-series)** | 1359 ms · 652 MB | **2.0 ms · 1.1 MB** | 692x faster, 594x smaller |
| **POCO F5 (arm64)** | 1858 ms · 652 MB | **3.0 ms · 1.1 MB** | 613x faster, 594x smaller |

And the number that says it can actually play: refilling all six lanes runs at
**1637x realtime on the Mac and 1348x on the POCO**. A ring buffer has three
orders of magnitude of headroom to absorb a scrub, a busy phone or a slow disk.

**iOS**: the same source and benchmark build clean for `arm64-apple-ios` (a
device binary, not the simulator). RUNNING it on a phone needs signing and an
app host, so there is no iPhone row above and there should not be one until
there is a measurement rather than an extrapolation.

**A review pass (Fable, 2026-09-08) found three state-machine defects**, one of
them the exact failure the interface's exactness contract exists to prevent:

- **`process_single` can call the write callback MORE THAN ONCE.** libFLAC
  synthesises silence for missing frames to keep a damaged stream aligned
  (`stream_decoder.c`, "Check whether frames are missing") and delivers those
  writes before the real frame. Staging reset itself on every write and kept
  only the LAST, so a damaged file played back **shifted by a whole block —
  4096 frames** — with `read()` still returning Ok. Staging appends now.
- **Errors were swallowed mid-decode.** `process_single` loops past a bad frame
  and returns TRUE with the next good one, so consulting the error flag only on
  failure meant `Ok` was returned across damage. And an error path returned
  `framesRead = 0` after already handing frames to the caller, so `position()`
  under-reported them for the rest of the song. Partial data is now `Ok` with
  the count, the error arrives on the next call, and `position()` always
  advances by what was handed over.
- **A failed seek left the source readable from an unknown offset**, with
  `position()` still reporting the old one — one stem drifting against five
  with nothing able to see it. It refuses to read until a seek succeeds.

The first was reproduced by a test written for it, which drifts by exactly 4096
frames against the fixed code and passes with it. Getting there took two
attempts: the first version of that test stopped at the reported error, and the
shift only appears in the audio AFTER the damage — the error fix hid the
alignment bug from the test meant to catch it. The invariant that works is
ALIGNMENT, not equality, because silence in the right place is a correct answer
and audio in the wrong place is not.

Two things the implementation learned that the research did not predict:

- **libFLAC's seek is ALREADY sample-exact.** This file was written expecting
  the standard hazard — `seek_absolute` landing on the frame CONTAINING the
  target, leaving the caller to drop up to a block of run-in (4096 frames,
  92.9 ms here). It does not: after a seek libFLAC hands over a SHORTENED frame
  whose header reports the target itself. Instrumented across seven targets
  deliberately off block boundaries, the run-in was zero every time. The drop
  logic written for it is gone.
- **A negative control is what found that.** Breaking the drop changed no test,
  which meant either the tests missed it or the code was dead. It was dead.

## The question

SingZ decodes every lane of a song to planar float PCM before playback starts.
That is ~1.3 s of the ~1.5 s a phone spends preparing a graph, and it leaves
~141 MB per song resident in the core — the twin of the renderer copy removed in
`DESKTOP-LANE-RESIDENCY.md`, and the phone's jetsam risk. Asked: can we play the
FLAC directly instead?

Nothing plays FLAC. The audio callback needs PCM floats, so a decode happens
either way. The real question is **when**, and **how much at once**.

## Measured: the decode is cheap per second

`ffmpeg -threads 1`, one stem, Deutschland's vocals (323.1 s, 44.1 kHz stereo),
best of three warm runs on this Mac:

| | throughput | six lanes in realtime |
|---|---|---|
| decode only | **982x realtime** | **0.6% of one core** |
| decode + 44.1→48 kHz, soxr | 612x | 1.0% of one core |
| decode + 44.1→48 kHz, swr | 970x | 0.6% of one core |

(The first cold run read 416x; the rest is warm page cache. A streaming design
reads from disk continuously, so the honest figure sits between the two — still
two orders of magnitude above what playback needs.)

On the POCO the whole-song decode of a 122 s six-lane project runs at roughly
**560x realtime aggregate** (~1.3 s for 732 lane-seconds, across the pool).
Realtime playback of six lanes needs 6x. That is about **1% of the decode
capacity the phone already demonstrates during an open**.

**So this measurement also kills a lead this note previously offered.** Matching
the stems' 44.1 kHz to a 48 kHz device looked like a cheap win; measured, a
high-quality resample costs ~60% on top of the decode and a cheap one costs
nothing. It is not where the seconds are, and a streaming design would pay it
per block rather than once — which at these throughputs is still nothing.

## What FLAC gives us, and the one thing our files are missing

- **Frames are independently decodable.** Each carries its own header and sample
  number, so playback can start at any frame without touching what came before.
  Unlike MP3 there is no bit reservoir and no encoder-delay ambiguity.
- **Our stems use a 4096-sample block** (STREAMINFO says `block 4096-4096`),
  which at 44.1 kHz is **92.9 ms** — the granularity a seek lands on before
  decoding forward to the exact sample.
- **Our stems carry NO SEEKTABLE.** Checked: STREAMINFO and a 40-byte
  VORBIS_COMMENT, nothing else. libFLAC uses the seektable when present and
  otherwise falls back to an interpolating binary search over the file —
  more I/O and more frame headers parsed, per seek, which is the wrong cost to
  pay on a scrub.

That last one looked like step zero of any streaming work — a seek point per
second on a 323 s file is 323 x 18 bytes, **5.8 KB**. Investigated, and the
conclusion flipped. See "Do we add a seektable?" below.

## What the core has today

- **Vendored libFLAC** (`third_party/native/flac`), the reference implementation
  — which already has both the pull/push streaming API and
  `FLAC__stream_decoder_seek_absolute`. The decoder we would need is in the tree.
- **`DecodedBufferView`** (`zdsp/include/zdsp/decoded_buffer_source.h`): the
  graph's source node is a view over immutable planar floats for the WHOLE song.
  This is the thing that would change.
- **`PositionedDecodedBufferSourceConfig`**: project time maps to source frame
  as `sourceStartFrame + (projectTime - entryProjectTime)`. That mapping is
  exactly what a streaming source would keep — it is the buffer behind it that
  would become a window rather than the whole song.

## Do we add a seektable? Probably not — build the index in memory instead

Three routes exist, and checking them changed the recommendation:

1. **The core's C++ encoder** (`zcore/src/media/flac_io.cpp`): trivial. libFLAC's
   `FLAC__metadata_object_seektable_template_append_spaced_points_by_samples`
   plus `FLAC__stream_encoder_set_metadata` before init, about ten lines. Covers
   only the stems a PHONE writes.
2. **The desktop's encoder** (`src/main/flac.ts`, libflacjs/WASM): awkward.
   `FLAC__stream_encoder_set_metadata` IS exported by the build, but the object
   constructors — `FLAC__metadata_object_new`,
   `..._seektable_template_append_spaced_points_*` — are NOT, so the block would
   have to be hand-built in WASM memory against libFLAC's struct layout. That is
   ABI-fragile work for a cosmetic gain. And the desktop is where most stems are
   made, because that is where the splitter runs.
3. **A post-hoc writer**, which would serve both encoders AND backfill every
   project already on disk. Viable, and the spec is what makes it viable: a seek
   point's offset is **"from the first byte of the first frame header to the
   first byte of the target frame's header"** — RELATIVE, not absolute. So
   inserting a SEEKTABLE block before the audio does not invalidate the offsets
   it contains. The work is a pass over the frame headers to collect
   (sample, relative offset) pairs.

**But none of them are the right answer**, and the interface above is why. A
seektable only helps once something seeks in a streamed file, and nothing does
today — so all three are preparation for unscheduled work, and two of them
rewrite audio files that singers already own.

`StreamingAudioSource::buildSeekIndex()` does the same job in memory, from one
pass at open, and needs no migration, no file rewriting and no second encoder
change. Every song already on disk gets it for free. If that open-time pass ever
proves to cost too much, THEN writing a seektable into newly encoded files is
the optimization — cheap, and by then it would be optimizing something real
rather than guessing.

Recorded because the question was asked and the obvious answer was wrong.

## The architecture, and what is genuinely hard here

The shape is standard: a decoder thread per lane (or a pool) filling a lock-free
ring buffer, the audio callback reading only from the ring and never decoding.
Four things make SingZ harder than a media player, and none of them are FLAC:

1. **Signalsmith Stretch wants lookahead.** The stretcher already consumes ahead
   of the playhead; the ring has to stay ahead of *it*, not of the callback. The
   buffer depth is set by the stretcher's window, not by taste.
2. **Continuous scrubbing.** A singer drags the playhead; a media player seeks
   occasionally. Every drag frame is a seek-and-refill across six lanes. This is
   what the missing seektable would hurt most.
3. **Count-in pre-roll runs at NEGATIVE project frames**, and A-B loops
   re-anchor mid-playback. Both are already handled by the positioned-source
   mapping, but both become refill events instead of pointer arithmetic.
4. **A transpose or tempo change is a structural rebuild today**, and it is fast
   only because the decoded lanes are PARKED and adopted (measured: 88-229 ms on
   the POCO against ~1500 ms for a fresh decode). With streaming there is nothing
   to park — the rebuild becomes cheap for the same reason the open does, but
   the whole parking/adoption mechanism in `native_playback_session.cpp` becomes
   dead and would need removing carefully rather than left to rot.

## Prior art

- **REAPER decodes compressed sources on the fly and writes no intermediate
  file** — its forum's answer to editing MP3s without converting to WAV is that
  it converts to floating point audio on the fly, without creating a new file.
  The only thing written beside the media is `.reapeaks`, for drawing. An
  existence proof at track counts far past six.
- **Ableton Live transcodes**, and documents it: a compressed sample is decoded
  to a temporary uncompressed file in a "Decoding Cache" with a maximum size, a
  minimum-free-space rule and a Cleanup button.

So the field is split, and streaming compressed multitrack audio is ordinary.
"FLAC is too awkward to stream" is not a defensible reason.

## If it goes ahead, in this order

1. **Prepare behind the open** (mobile), as the desktop already does. Not
   streaming at all — it moves the 1.5 s out of the singer's way and buys time
   to do the rest properly.
2. **A streaming source node beside `DecodedBufferSource`**, chosen per lane, so
   the two can be compared on the same song with the existing harnesses. The
   sanitizer gates and `player-session` are the judges. It implements
   `StreamingAudioSource` (`zcore/include/zcore/media/streaming_audio_source.h`,
   interface only today) so MP3 and AAC adapters slot in behind the same
   contract later.
3. **Retire parking/adoption** once streaming is the only path.
4. **Only then**, if `buildSeekIndex` proves expensive, write seektables into
   newly encoded stems.

## Built (2026-09-08)

Steps 1 and 2 are done, and step 2 is the one that changed shape while it was
built. What shipped:

| piece | where |
|---|---|
| the source node | `zdsp/include/zdsp/streaming_window_source.h` |
| the feeder | `native/playback/streaming_lane_feeder.h` |
| the session flag | `NativePlaybackPrepareConfig::streamLanes` |
| the bridges | iOS schema, Kotlin schema, JNI, `mobile/src/playback/native.ts` |

The design that survived contact:

- The node is addressed by **source frame, never ring offset**, and the
  transport mapping is copied verbatim from the positioned decoded source so a
  seek, a count-in pre-roll and a loop re-anchor behave identically.
- A frame the window does not hold renders **silence and is counted**. Silence
  is the only honest answer on the render thread; the alternative is a file
  operation there.
- The ring is safe **without a lock** because the feeder never writes within
  `safetyFrames` of the published demand, and retires before it overwrites.
- One feeder thread for all lanes.

Four things were only found by testing, and each would have shipped silently:

1. **The window range check was unproven.** A mutant with it deleted passed —
   the interpolation guard covered for it. The case that isolates it is
   scrubbing BACKWARDS into a window whose end is far ahead.
2. **The play cursor has a different reader per backing**, and the decoded one
   answers zero for a streamed source, which reads as "the song is at the
   start".
3. **The JNI signature string** needed the extra `Z`. It is matched at runtime,
   so a miss is a crash on the device, not a compile error.
4. **Our stems are 44.1 kHz and a phone's session commonly runs at 48.** The
   streaming source cannot resample and the decoded one can, so a mismatch now
   falls back to decoding. Before that, a build with streaming on could not
   have opened a single song — found by asking what rate the device actually
   runs, not by any test.

### Known gap: the waveform

`summarizeLanePeaks` is a linear pass over decoded PCM, and a streamed lane has
none to pass over. Computing it eagerly means decoding the whole song, which is
the exact cost streaming removes — so a streamed lane reports no waveform and
the seek bar draws none. Peaks have to become asynchronous (a background pass,
published under its generation) before streaming can be the only path. Note
that peaks are documented as immutable for a prepared generation, so this is a
contract change and not just a background job.

## What would say it is working

`mobile/tests/open-steps-android.cjs` and `tests/e2e/mac/open-steps-e2e.cjs`
print the open step by step; the graph-build step should collapse. `player-
session.cjs` already measures seek, loop, pitch-change and memory on both
platforms — a streaming build that keeps those green while the open gets shorter
and the retained bytes fall is the whole claim.

Sources: [REAPER — editing MP3s without converting to
WAV](https://forum.cockos.com/archive/index.php/t-29463.html) ·
[Ableton — Managing Files and
Sets](https://www.ableton.com/en/manual/managing-files-and-sets/) ·
[libFLAC stream decoder
API](https://xiph.org/flac/api/group__flac__stream__decoder.html)
