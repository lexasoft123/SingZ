# Native playback: the prepare off the JS thread — scope

Status: **step 1 done** (2026-09-07, after the DSP-graph merge `c1b6865`;
reshaped after a plan review the same day, then implemented). Transition
events are a separate scope, sketched at the end, not a prerequisite or a
co-requisite.

Measured on the same song either side of the change — the work is identical
(2670 ms of graph build before, 2662 ms after), only the thread that waits
for it moved:

| | main-loop ticks | worst main-loop lag |
|---|---|---|
| before | 57 | **2621 ms**, ending on the millisecond `graph ready` was logged |
| after | 107 | 272 ms — the addon's dylib load, before the prepare starts |

Step 1 is complete as it stands. Two items it originally listed were dropped
rather than deferred, each for a reason recorded where it appears below:
exporting `playbackPositionNow` (the premise was wrong — the phones' value
comes from a same-thread read the desktop renderer cannot have at any price
worth paying), and the synchronous drain as its
own export (unnecessary — the drain lives inside `unloadPlayback` and the env
cleanup hook, so `stop()` and `before-quit` never had to change).

## The defect, as it stood

Everything in this section is the state BEFORE step 1; it is kept because it
is the argument for the shape the fix took.

`preparePlayback` was a plain synchronous N-API function, and nothing in the
bridge used `napi_create_async_work`. It ran `session.prepare(...)` on
Electron's main thread and returned when the graph was built: **2,714 ms in a
field log on 2026-09-07**, during which every renderer IPC queued behind it
and the window stopped responding. It froze on open (the prepare-ahead) as
much as on Play.

Two things about it that shape the fix:

- **The decode was already parallel.** `prepare()` runs its lanes on a
  `std::thread` pool (`native_playback_session.cpp:2251-2290`). Main was not
  computing, it was *waiting*. Moving the wait off the JS thread adds no CPU
  parallelism; it only stops blocking the UI.
- **The seam blocked too.** A transpose, training or metronome change prepares
  a candidate on the running generation's stream, and the facade's
  `audibleSeconds()` comment recorded that this held main for over half a
  second — which is why its projection is bounded to a second at all. That was
  the freeze felt *while singing*, and it is why the fix moves the seam's
  prepare as well as the fresh start.

Why the 5 Hz status poll blocked during a prepare: because the IPC handler
runs on the same JS thread that was inside `preparePlayback`. Not because of
`playback.mutex` — that becomes relevant only once the work leaves the thread,
which is why step 1 keeps that lock rather than removing it.

## Not the same defect as the stale picture

An earlier draft tied this to the 2026-09-07 `resume failed` bug (a second
Play inside one status poll) as "one defect, two symptoms". The code says
otherwise:

- The phones already have the owner-thread model this scope proposes (Android:
  `Executors.newSingleThreadExecutor`, `NativeAudioRuntimeModule.kt:48`) and
  they **still poll at 1000 ms** and still had the stale-picture class of bug.
  An async boundary does not remove it.
- That bug is closed at the facade (`431d051`): `resume()` reads a fresh status
  before commanding and survives an `invalid-state` refusal against a
  transport that is in fact playing.

The freeze is a thread-placement defect. The stale picture is a latency
property; events would improve it and are scoped separately below.

## What the phones got right, and the desktop lacks

Long work off the JS thread, and **exactly one synchronous call**:
`positionNow()`, O(1) over the lock-free `PlaybackPositionPublication`
(`native_playback_session.h:945`, `.cpp:8021`). Both phone bridges export it;
the manifest pins it as the one `synchronous: true` method.

The desktop bridge does not export it, and after step 1 that is a considered
position rather than an omission — see item 6. The phones can be synchronous
because their JS and their audio module share a process; the desktop's facade
is in the renderer and reaches the addon only over IPC.

Note what is NOT lock-free: `NativePlaybackSession::status()` takes
`impl_->mutex` on its first line (`.cpp:7773`) and assembles ~75 fields. The
header says so (`.h:509-513`). An earlier draft called the status read
"lock-free via the seqlock" — the seqlock is the per-transport telemetry bank
that `status()` reads *under* that mutex, and it is replaced at every seam.

## Step 1 — prepare off the JS thread

**Move `session.prepare(...)` alone onto a worker.** Fresh-start and seam
together — the session already runs the seam's candidate build while the old
generation keeps taking commands (`.cpp:5590-5620`), and `prepare()` never
touches the audio driver (the backend object is constructed in the bridge; the
driver is first touched in `openOutput`). Commands, `openOutput`, `start`,
`stop` and `status` stay synchronous on main, where every driver call already
is — which is what keeps ASIO's thread affinity intact without a new thread.

Mechanism: `napi_create_async_work`. Ordering came out simpler than the
plan expected: at most ONE prepare is ever in flight because a second is
refused under `playback.mutex`, so "chained one-outstanding" is structural
rather than a queue — and a refusal is also what protects a SEAM, where the
running generation is still the old one and nothing else would notice a
second candidate. Thread identity is not needed because no driver call moves.
A dedicated owner thread is what you build when commands move too, and they
should move only if measured to block — `openOutput` enumerates under the
session mutex, `stop` waits for callback quiescence. Measure first.

What it takes, in order of how easily it is forgotten:

1. **`playback.mutex` stays**, around the bridge struct only (`generation`,
   `handoffLease`, `provider`, and the ordering of claim → prepare → rekey).
   It must NOT be held across the worker's run; the bridge's pre- and
   post-bookkeeping is split around it. Main needs `playback.generation` at
   enqueue time for the "another session is active" and "seam must name the
   active generation" refusals, so thread confinement is not available for
   these fields. The contention disappears with the work, not the lock.
2. **Cancel out of band, at enqueue, on the JS thread.** `unload()`/`stop()`
   call `requestCancellation()` first, and the decode pool polls that atomic.
   An unload merely *queued behind* a prepare is observed only after the decode
   has finished — the queue turns a cancellable prepare into an uncancellable
   one. `requestCancellation` takes only `generationGate` and `parkedMutex`,
   so it is safe to call from main immediately.
3. **Pending-generation bookkeeping in `capture.ts`.** Today
   `playbackGeneration` is set only after the synchronous result reports
   `ownershipRetained` (`:1422-1425`). With a promise, during the in-flight
   prepare it is `''`, so `rendererGone()`/`stop()` skip the unload and a
   generation that lands afterwards owns the device with nobody to unload it.
   Record a pending generation at enqueue; unload it on resolution if its
   owner is gone. The facade's `this.ahead` has the same shape.
4. **The synchronous quit path.** Resolved without a new export, because
   `unloadPlayback` stayed synchronous: it drains first (cancel, then wait for
   the worker), so `captureOwner.stop()` is unchanged and `before-quit` still
   works. `cleanupPlaybackBridge` drains the same way, so a worker cannot
   outlive the env. What `stop()` cannot do is unload a generation whose
   prepare has not resolved — main has no id for it yet — so `capture.ts`
   marks it abandoned and unloads it when it lands; the env cleanup hook is
   the fail-closed owner if the process goes first.
5. **No TSFN needed.** `napi_create_async_work` completes on the loop by
   itself; a TSFN is what a dedicated owner thread would have needed to
   resolve promises. One less thing to keep `ref`-counted.
6. **~~Export `playbackPositionNow` and let the facade paint from it.~~
   DROPPED, and the reason is worth keeping.** It was written, withdrawn once
   because the contract suite rightly refuses a half-wired export, and then
   dropped outright on 2026-09-07 when the premise turned out to be false.

   `positionNow` is valuable on the phones because it is a SYNCHRONOUS O(1)
   read of a lock-free publication, on the same thread that paints. The
   desktop cannot have that: the facade lives in the RENDERER and the addon in
   main. A synchronous renderer→main read is *possible* — `ipcRenderer.sendSync`
   is right there in the preload, used by `saveTrainingPreferencesSync` — but
   it is a blocking round trip into another process that waits on main's event
   loop, which is a far worse thing to do at frame rate than the poll it would
   replace. So a desktop `positionNow` would in practice be POLLED, cheaply
   (it never takes the session mutex), and that shortens the projection rather
   than removing it.

   And the projection got safer with step 1. `audibleSeconds()` extrapolates
   from the last status by wall-clock, bounded to one second, and the reason
   that bound existed was that "a seam's prepare holds main, and with it the
   poll, for over half a second". Prepare no longer holds main at all, so the
   poll keeps flowing and the extrapolation spans a poll interval rather than
   a graph build.

   What would actually pay for itself is the transition-event channel below —
   or, for the playhead specifically, a shared-memory read the renderer can
   make without a round trip. Both are their own scope. A desktop
   `positionNow` bolted on before either would add an export, an IPC channel
   and a poll to shave an error the async prepare already shrank.

## The contract

`tests/shared/native-playback-bridge-manifest.json` is hand-edited on purpose.
Its `methods.desktopAddon` entries carried `ipc`/`preload`/`dormant` and no
`synchronous` field, unlike the phone entries. They carry one now — `false`
for `preparePlayback` alone — which is what makes "returns a promise"
representable at all. Two pins will not see the change and one will break on it:
`addonExportNames` parses the export table textually, so promise-ness is
invisible to it — the vitest over the addon has to assert that a stale
synchronous binary is refused; and `tests/unit/capture-addon-build.test.ts`
pins literal source strings (`playback.backendFactory(...)`,
`playback.session.replaceAudioHostBackend(...)`), so moving that code into a
job struct means re-pinning them, deliberately.

## Tests owed

- `transport-race-e2e.cjs`: **done** — leg 3 runs a 50 ms heartbeat inside
  MAIN across a song switch and fails if its own event loop stalls past
  1200 ms. It measures main, not the renderer: the renderer decodes its own
  Web Audio copy of the song and blocks itself, which is a different and
  still-open problem (the desktop full switch).
- Vitest over the addon: `preparePlayback` returns a promise; two prepares
  submitted concurrently apply in order; an unload issued mid-prepare cancels
  the decode (bounded time, not "eventually").
- `capture.ts` unit: a renderer gone during an in-flight prepare leaves no
  generation owning the device; `stop()` at quit drains.
- Native ctest: `requestCancellation` from a second thread ends a running
  `prepare()` within a bounded number of decode blocks.

## Risks

- Cancellation and quit are where this goes wrong, not the threading — items 2
  and 4 above are the whole risk register.
- ASIO affinity is preserved by *not* moving driver calls. If a later step
  moves them, that step needs the dedicated thread and a Windows verification
  with the SDK adapter actually compiled (`SINGZ_ASIO_SDK_ADAPTER_COMPILED`),
  or the check is vacuous. WASAPI needs nothing from the bridge's thread: it
  runs its own STA endpoint thread.
- A stale binary reports green: this is native, so rebuild, reinstall, and
  grep the binary for a literal the change added.

## Later, separately: transition events

Discrete transitions (`playing`/`paused`/`pre-roll`/`completed`/`stopped`,
seek-landed, loop-changed, swap-landed, `device-lost`, `quarantined`) pushed
from the core so consumers stop busy-polling for receipts
(`SEEK_RECEIPT_POLL_MS = 15` on the phones, the desktop's 24-read `seekCount`
wait) and the phone poll can relax for battery. Continuous telemetry stays a
poll; the poll stays as heartbeat, and **no consumer may require an event**.

Two design points settled by the review, so they are not re-derived:

- The ledger lives at **session** level, modelled on `impl_->position` (a
  `shared_ptr` shared across generations), not on the per-transport telemetry
  bank — `stopped`, `device-lost` and `quarantined` straddle or outlive a
  graph.
- There are **three wake domains** — the render callback, the WASAPI endpoint
  worker (`device-lost`), and the control thread (`quarantined`, `stopped`).
  Only the RT one is bound by no-alloc/no-lock/no-log; the others build the
  payload directly.

Hosts: a second TSFN on the desktop (the `EventBridge` coalesce-and-count
shape from `capture_addon.cpp`), `RCTEventEmitter` on iOS and
`RCTDeviceEventEmitter` from `NativeAudioRuntimeModule.kt` on Android — both
phone bridges are request/response today, so both emitters are new surface,
and the manifest gains an `events` section in the same commit as the first of
them.
