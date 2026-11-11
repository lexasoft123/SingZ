# D-01: How is the single worker thread replaced, and who owns in-flight state?

Decision record, written 2026-11-10 against `f7607311` (`codex/gpui-interface`).
`$G` = `experiments/gpui-player`. Line numbers are for `f7607311`. The working tree
carried an uncommitted three-line marker at the top of `$G/src/main.rs` while this
was written, so `main.rs` lines in a dirty tree are three higher than cited here.
Anything marked *(inferred)* was not checked against code. No build, test or app
run was performed for this record; every bound and duration below is a proposal
until a package measures it.

Status: **proposed**, awaiting the sign-offs in section 6.

## 1. Question

`$G/src/integration.rs` runs one command worker (`thread::spawn` at
`integration.rs:877`, loop `worker()` at `:2016-3025`). That thread owns the audio
helper's pipe and also performs disk and CPU work inline. The plan asks for five
things, and they need one consistent ownership model:

1. Transport commands must not queue behind slow work (C-17).
2. The audio helper is asked to quit and is killed only as a fallback; a refused
   command leaves the helper and the loaded song alive (C-18).
3. The in-flight request state spread over `struct Player` gets typed owners (C-19).
4. The playhead never steps backward except on seek, loop wrap or song change (C-20).
5. A panic leaves a crash record and no orphaned helper (C-22).

## 2. Inputs, and what was verified

### 2.1 Thread and queue model today

| Claim | Verified at | Result |
|---|---|---|
| One command worker owns the helper connection | `integration.rs:877`, `:2071` (`let mut connection`) | Confirmed. `Connection` is a local of `worker()`; nothing else writes the helper's stdin |
| "Single worker thread" (R-01) | `integration.rs:837` (delete-inspect worker), `:849` (inventory worker), `:1740` (reader thread per helper), `integration_save.rs:49-51` (save service), `:2408`, `:2460`, `:2473`, `:2485`, `:2497`, `:2510`, `:2735` (per-job threads) | R-01's correction holds: it is a single *command* worker. Catalog, lyrics, beat, analysis, deletion and saves already run on their own threads |
| Queue is bounded and admission never blocks the UI | `integration.rs:821` (`sync_channel(128)`), every `try_send` in `:923-1210` | Confirmed. Every failure, including a dead worker, is reported as "Native command queue is full" (`.context(...)` on any `try_send` error) |
| Epoch fencing crosses threads through atomics | `integration.rs:1015` (`epoch.fetch_add` at admission), `:1929-1939` (`connection_read_allowed`) | Confirmed |
| The helper executes commands strictly one at a time | `tools/native/singz-gpui-audio.cpp:976-984` (read one line, handle, `reply`), `:1551` | Confirmed. No per-command serial in the framing, as R-11 says |

### 2.2 What still runs inline on the command worker

These block Play, Pause, Seek and the status poll for their full duration:

| Inline work | Site | Why it is slow |
|---|---|---|
| Joining the previous lyrics or beat job before starting the next | `integration.rs:2458`, `:2471`, `:2483`, `:2495`, `:2508` | Cancellation is cooperative; the join waits for an external process to notice |
| Track edit: joins, measuring new sources, stamping | `:2677`, `:2678-2684` (`prevalidate_new_tracks`, `prepare_lane_candidate`), `:1454` (`measure_new_track` spawns a helper) | Decodes whole files |
| Library import copy or move | `:2755` (`project_import::execute`) | Copies a project directory |
| Project open: read, validate, lyric mask shaping | `:2542` (`read_open_project_overlay`), lyric preparation after the helper spawn (`:2583-2601`) | Disk plus text shaping. The old helper keeps playing during the read and cannot be paused, because its epoch was already superseded at `:1015` and the poll and playback paths filter on the current epoch (`:2892`, `:2988-2990`) |
| Rename, delete preparation, lyrics save, publication read | `:2764-2783`, `:2707-2730`, `:2646-2671`, `:2303-2311` | Disk |
| Preference writes | `:2267-2278`, `:2871` | Disk, small |
| Output change with no helper loaded | `:2379` (`inventory_with_provider`) | Spawns a probe process |

`integration_save.rs:1-2` already states the rule this record generalises:
"native command/status polling never waits for disk I/O".

### 2.3 Helper lifecycle

| Claim | Verified at | Result |
|---|---|---|
| Kill sites at 1359/1376/1676 (plan, R-01) | `integration.rs:1347-1380`, `:1674-1679` | **Corrected.** 1359 and 1376 are `MeasureProcess::drop`, the track-measuring helper, not the audio helper. The audio helper is killed at `:1676` (`Connection::drop`), `:1736` (missing pipes) and `:2287` (test fault injection, `ui-tests` only) |
| The audio helper is always force-killed | `integration.rs:1674-1679`; `grep quit $G/src` finds no sender | Confirmed. Every retirement is `drop(connection.take())` → `child.kill()` + `wait()`. Rust never sends `quit` |
| The helper already supports a clean exit | `singz-gpui-audio.cpp:1316` (`quit` breaks the loop), `:977` (stdin EOF breaks the loop), `:1553-1557` (`clearCues`, `unloadWithCleanup`, `parkOutput`, exit code 0 or 1) | Confirmed. No helper change is needed for a graceful quit |
| The input helper is already retired gracefully | `$G/src/microphone.rs:736-754` (`stop`, 750 ms, then kill); `tools/native/singz-gpui-input.cpp:111` (`quit`/`stop`, EOF) | Confirmed. This is the precedent for the audio helper |
| Kill + wait is load-bearing as a proof | `integration.rs:1677` (`provider_retired` decremented only after `wait()`), `:2558` comment, `integration_provider.rs:10-12` (`can_change` requires `retired`) | Confirmed. Any graceful path must still end in a reaped child before the next helper spawns or the provider changes |

### 2.4 Refusals

R-01 marked "refusals kill the helper" as not established. Checked per path:

| Command path | Site | On `ok:false` from the helper |
|---|---|---|
| Rate / transpose | `integration.rs:1885-1898` | Classified. `Refused` keeps the helper after a fresh status proves the old graph |
| Region / loop | `:1851-1884` | Classified |
| Output route | `:1815-1832` | Classified |
| Lane replace, Carry | `:1576`, `:597`, `:2702-2704`, `:2812-2814` | Classified (`Refused` / `Disconnected` / `Committed`) |
| Seek, master, lane (`Control`) | `:1806-1814` → `Status::parse` bails on `ok != true` (`:405-407`) → `:2967-2976` | **Helper killed**, `TransportFailed` |
| Play / pause | `:541-563` (`Status::parse` inside `settle_playback_receipt`) → `:2909-2918` | **Helper killed** |
| Metronome | `:1799-1805` → `:2857-2864` | **Helper killed**. The helper refuses over-limit count-ins with a plain `ok:false` (`singz-gpui-audio.cpp:1481-1483`) |
| Training cue | `:2168`, `:2183-2187` | **Helper killed**. The helper refuses over-capacity cues (`singz-gpui-audio.cpp:1436`) |
| Park / unpark | `:2229-2258` | Helper killed, deliberately ("Never leave an uncertain live output behind a failed handoff") |
| Status poll | `:2986-3002` | Helper killed |

So the claim is **confirmed for six paths and false for five**. The helper itself
survives every refusal: it replies and reads the next line
(`singz-gpui-audio.cpp:1551`). Survivable refusals are therefore a Rust-only
change that generalises the classification `rate()` already does
(`integration.rs:1894`: `ok == false`, `state <= 5`, `Status::reported` parses,
then a fresh `status`).

### 2.5 Playhead

| Claim | Verified at | Result |
|---|---|---|
| No monotonic rule exists (R-01: "not found") | `$G/src/empty_project_host.rs:42-131` (`Player::playback_status`), `$G/src/main.rs:5499-5509` (frame projection) | **Corrected.** Partial rules exist: stale samples dropped (`empty_project_host.rs:65-70`), post-seek hold (`:101-107`), immature-projection floor (`:108-114`). There is no general guard: `self.position = position` at `:118` is unconditional |
| Pause can step back | `main.rs:3619-3649` sets `playing` from intent (`:3633`, `:3649`) at once, so projection stops; the next status, sampled before the pause applied, is then assigned at `empty_project_host.rs:118` | Mechanism confirmed in code; magnitude not measured *(inferred: up to one poll period, 33 ms, plus reply latency)* |
| Projection is capped and folded | `main.rs:5501-5507` (`elapsed.min(0.1) * rate`, loop fold) | Confirmed |
| Status timestamps are taken in Rust, not in the helper | `integration.rs:496` (`sampled_at: Instant::now()` at parse) | Confirmed. Reply-latency jitter moves the anchor |
| The four rules to port | `tests/e2e/mac/count-in-e2e.cjs:84-140` (items 8-11: pause hold, immature stand-in, post-seek hold, loop fold) | Read; these are the Electron rules C-20 names |
| The position logic is not in the files C-20 lists | C-20 row lists `transport_timing.rs`, `timeline_host.rs`; `transport_timing.rs` holds only count-in math (`:1-192`), `timeline_host.rs:81-99` only consumes `self.position` | **The C-20 edit list is incomplete.** See section 7 |

### 2.6 `Player` state

| Claim | Verified at | Result |
|---|---|---|
| About 58 `pending` fields (review); 23 (R-01) | `main.rs:421-760` | 23 fields with `pending` in the name, 44 serial/sequence/session/epoch/generation/revision fields, about 315 fields in total |
| Hosts are already split by domain | `impl Player` in 19 `$G/src/*_host.rs` files (for example `transport_host.rs:18`, `carry_line_host.rs:11`) | Confirmed. The split is by method, not by state: every field still lives on `Player` |
| Three copies of "save requested + deferred navigation" | `main.rs` fields `native_rate_save_requested`/`native_rate_navigation`, `metronome_save_requested`/`metronome_navigation`, `carry_save_requested`/`carry_navigation` | Confirmed |
| Pending seek counts every queued seek | `main.rs:4260-4263` (`expected = pending count + 1`) | Confirmed. Seeks must therefore stay FIFO and uncoalesced |

### 2.7 Panic and idle behaviour

| Claim | Verified at | Result |
|---|---|---|
| No panic hook | `grep set_hook\|catch_unwind $G/src` → none | Confirmed |
| Profile unwinds | `$G/Cargo.toml` has no `panic =` key | Confirmed for the committed manifest. The `[profile.release]` block in the tree is uncommitted work by another package |
| A worker panic already retires the audio helper, silently | `Connection` is a local of `worker()`; unwinding runs `Connection::drop` (`:1674`) | Confirmed by structure. The UI is never told: later sends report "queue is full" (2.1) |
| A main-thread panic or abort leaves helpers to notice EOF | `singz-gpui-audio.cpp:977`, `singz-gpui-input.cpp:111` | Confirmed for the two stdio helpers. Children that do not read stdin (ffmpeg, `llama-server`, `crispasr`, `curl`; 47 `Command::new` sites) are not covered *(inferred that they outlive an abort)* |
| The diagnostics sink is unsafe inside a panic hook | `$G/src/diagnostics.rs:166-167` (`lock().unwrap()`), `:134-150` (async queue, `try_send`) | Confirmed. A crash record must be written directly, not through the sink |
| Windows Job Object precedent | `$G/src/lyrics_align.rs:1954-1992` | Confirmed |
| Idle wake-ups | UI timer every 16 ms (`main.rs:1312-1322`); worker `recv_timeout(20 ms)` (`integration.rs:2111`); inventory worker 20 ms (`:851`); delete-inspect worker 20 ms (`:1214`); helper `status` every 33 ms playing or paused (`:2986-2993`) | Confirmed. All run while paused. Their cost against N6 is not measured |

### 2.8 Research reports

- **R-01**: used as a lead. Three rows corrected above (kill sites, refusals, playhead).
- **R-05**: its `main.rs` ranges were not re-verified line by line; this record
  relies only on the status-driven notify path and the 16 ms poll timer, both
  checked here.
- **R-11**: the helper has no per-command serial and already sits on the session
  seam for playback. The serial command loop was verified
  (`singz-gpui-audio.cpp:976-984`); the session-side citations were not re-read
  *(inferred)*.
- **`TRANSPORT_TIMING_REVIEW.md`**: "Ordinary transport/mixer commands remain
  FIFO-queued behind native rate preparation" and "Playback intent uses an exact
  command serial receipt". Both are contracts the v15 timing suite asserts; this
  record keeps them.

## 3. Options

Costs are worker-days for the whole unblocked chain (C-17, C-18, C-19, C-20, C-22;
the plan budgets 5 + 4 + 5 + 4 + 2 = 20). C-18, C-20 and C-22 cost the same under
every option; the options differ in C-17 and C-19.

### (a) Transport actor + jobs coordinator + helper supervisor

Two owners replace the worker:

- **Transport actor**: the only owner of the helper pipe. It runs exactly the
  helper-bound requests and the status poll, in today's order.
- **Jobs coordinator**: owns everything that touches disk or waits on another
  thread: project read, lane prevalidation, import, rename, delete preparation,
  lyrics save, preference writes, and the join of superseded jobs.
- **Helper supervisor**: a type, not a thread. It owns `Child`, spawn, graceful
  retirement and the process registry the panic hook reads.

| | |
|---|---|
| Cost | C-17 5, C-19 5; chain 20 worker-days, as budgeted |
| Risk | Medium. Open, track edit, import, rename and delete become two-phase (prepare on jobs, adopt on transport). Each needs its epoch fence re-proved. The helper protocol and FIFO order among helper commands do not change, so the v15 timing contracts hold by construction |
| N6 idle CPU | Improves: jobs coordinator blocks on `recv()`; inventory and delete-inspect workers fold into it, removing two 20 ms wake-ups. Thread count net -1 |
| N7 playing CPU | Neutral |
| N11 audio | Neutral to positive: disk work can no longer delay the status poll or a Pause |
| N12 startup | Neutral: preference loads move off the transport thread but stay off the UI thread |
| N13 song open | Risk: graceful quit adds the old helper's teardown to a song switch (section 4.3). Project read can overlap nothing new, so first open is unchanged |
| N1-N5 frames | Neutral. No UI-thread work is added |
| N9/N10 memory | Neutral: one fewer thread stack; no new retained state |

### (b) Keep one worker, add a priority lane

A second channel for Play/Pause/Seek that the worker drains first.

| | |
|---|---|
| Cost | C-17 2; chain about 17 worker-days |
| Risk | High that it does not meet C-17's acceptance. A priority lane only helps between requests. The slow work in 2.2 runs *inside* one request and cannot be pre-empted; pumping the urgent lane from the jobs' cancel callbacks would re-enter `connection` mid-transaction. Making the slow work pre-emptible means moving it to threads, which is option (a) done piecemeal. It also reorders helper commands (a Seek overtaking a queued Rate), which the timing contract in 2.8 forbids |
| Budgets | N6 unchanged (all polling stays). N11 unchanged. N13 same as (a) once C-18 lands |

### (c) Per-domain actors

Transport, project, lyrics, analysis and devices each get a thread and mailbox.

| | |
|---|---|
| Cost | C-17 10-12, C-19 6; chain 27-29 worker-days |
| Risk | High. Open, track edit and delete each touch three or four domains, so every one becomes a multi-actor saga with its own cancellation order. That is more places for the stale-result bugs the epoch fences exist to prevent, on the plan's critical path (C-17 → C-20 → Q-03) |
| Budgets | N6 worse unless every mailbox blocks (three more idle threads). N9 slightly worse (thread stacks). Others neutral |
| Note | Outside `integration.rs` the app is already per-domain: Drive, library, source jobs, stem export, diagnostics, models, training stores and locale are separate `Service`s with their own threads (fields at `main.rs:421-760`). (c) would only split what is left, and what is left is coupled through the helper |

## 4. Recommendation

**Adopt (a), in its narrowest form: split the worker along one line only, "touches
the helper pipe" versus "does not".**

### 4.1 Threads and ownership

```
UI thread (Player)            owns intent: what was asked, under which serial
  │  Backend facade           same public methods as today; routes each request
  ├─► Transport actor         owns Connection (helper stdin/stdout), monitor lease,
  │                           active training cue, output uid, provider state
  └─► Jobs coordinator        owns job handles, cancel flags, preference stores,
                              project preparation; never touches the helper
Reader thread per helper      unchanged (integration.rs:1740)
Save service                  unchanged (integration_save.rs)
```

Rules:

1. **The helper pipe has one owner.** Only the transport actor writes to or reads
   from a helper. No lock, no sharing.
2. **Helper commands stay strictly FIFO in one queue.** No priority lane, no
   coalescing. Pending seeks count every queued seek (2.6) and rate preparation
   is contractually ahead of later transport commands (2.8). The gain in C-17
   comes from removing non-helper work from this thread, not from reordering.
3. **Two-phase operations.** A request that needs both sides is prepared by the
   jobs coordinator and then handed to the transport actor as one message:

   | Operation | Jobs coordinator (prepare) | Transport actor (adopt) |
   |---|---|---|
   | Open | read and validate project, metronome commands, lyric masks | re-verify delete recovery, retire old helper, spawn, configure, publish `Opened` |
   | Track edit | cancel and join jobs, prevalidate, stamp | `replace_lanes`, configure, publish |
   | Import (move) | — | retire helper, then hand to jobs for the copy |
   | Import (copy) | copy | re-epoch the retained helper, status |
   | Rename, loaded delete | rename / delete after the transport confirms retirement | retire helper, confirm |
   | Lyrics save, publication read, preferences, catalog, inventory, delete inspect | whole request | — |

   Every hand-off carries the epoch and is dropped if `latest` has moved, exactly
   as today. Moving lyric-mask preparation ahead of the helper spawn is a
   reordering *(inferred safe; the implementer must confirm nothing between
   `integration.rs:2560` and `:2601` depends on the new helper)*.
4. **Mailboxes block.** The jobs coordinator uses `recv()`. The transport actor
   uses `recv_timeout(time to next poll)`, not a fixed 20 ms.
5. **Events are unchanged.** `Event` and every `Backend` method signature stay as
   they are, so C-17 does not edit `main.rs`.

**What (a) does not fix.** A Pause still waits behind a command the helper itself
is executing: a rate rebuild (timeout 55 s, `integration.rs:1899`), an output
change (120 s, `:1811`), a lane commit, a metronome rebuild. The helper is serial
(2.1). The UI already reflects Pause at once from intent (`main.rs:3649`).
Removing this wait needs an asynchronous prepare in the helper protocol and
belongs with D-07/C-80, not here.

### 4.2 The C-17 bound

Proposed, to be confirmed by measurement on both machines (section 6):

- With a non-helper job held open (a library import parked on the existing
  `SINGZ_GPUI_IMPORT_RECEIPT_GATE` at `integration.rs:2756`), 200 alternating
  `play`/`pause`/`seek` commands: time from `Backend::playback()`/`control()`
  admission to the receipt being published is **p99 ≤ 30 ms and max ≤ 100 ms**.
- The same run without the held job differs by **≤ 5 ms at p99**. This relative
  criterion is the one that proves the split; the absolute numbers depend on the
  audio callback period.
- Negative control: the same test against the pre-C-17 worker must fail.

### 4.3 Helper supervisor (C-18)

Retirement becomes a function with a reported outcome instead of a `Drop`:

1. Write `quit`, close stdin (either alone ends the helper's loop,
   `singz-gpui-audio.cpp:977`, `:1316`).
2. Wait for exit up to the **quit bound: 750 ms**, the value the input helper
   already uses (`microphone.rs:742`).
3. On expiry, or if the write fails, kill and wait, as today.
4. Report `Clean` (exit 0), `Unclean` (exit 1: the helper's own cleanup failed)
   or `Killed`. `provider_retired` is decremented only after the child is reaped,
   in all three cases, so the proof in 2.3 is unchanged.
5. `Drop` remains as a kill-and-wait safety net for unwinding.

Which retirements are graceful: navigation (open, rename, move, delete, recover
with replace), training-only teardown, and application quit. Which stay an
immediate kill: a transport fault (the stream may hold a late reply,
`integration.rs:2910-2911`), a failed park hand-off (`:2251-2253`), and test fault
injection.

Refusals: one `Connection` method replaces the ad-hoc `Status::parse`-then-drop.
It returns `Applied(Status)`, `Refused { error, retained: Status }` or `Fault`.
`Refused` requires: reply `ok == false`, `state <= 5`, the reply parses with
`Status::reported`, and a following `status` succeeds with unchanged ownership
keys (the set at `integration.rs:1854-1856`). Anything else is `Fault` and
retires the helper. Applied to Control, Playback, Metronome and Training cue.
Park stays fatal by policy. Refusals reach the UI through the existing events
(`Event::Error` for Control, `Err` in `Metronome`/`Training`); no new variants.

### 4.4 Playhead (C-20)

One pure state machine, `Playhead`, in `$G/src/transport_timing.rs`, replaces the
six loose fields (`native_anchor`, `pending_seek`, `native_floor`,
`native_seek_count`, `native_loop_count`, `native_loop`) and both call sites
(`empty_project_host.rs:83-130`, `main.rs:5499-5509`).

- Inputs: `admit(sample)` with position, `sampled_at`, playing, `audible_current`,
  `seek_count`, `loop_count`, loop range, rate, `counting_in`; `seek(target)`;
  `pause_intent()`; `reset()` on epoch change.
- Output: `shown(now) -> position`.
- Invariant: `shown` never decreases unless one of exactly three things
  happened since the last value: a seek was acknowledged (`seek_count` advanced
  or a local seek was issued), the loop wrapped (`loop_count` advanced, or the
  projection folded), or the playhead was reset (song change, graph or lane
  revision change).
- The four ported rules, each already half-present: pause hold (hold the shown
  value from pause intent until a status with `playing == false` lands), immature
  projection (`!audible_current`: floor at the run's start), post-seek hold (hold
  the target until `seek_count` reaches the expected count), loop fold (a fold
  never goes back past a lap already shown).

No helper or protocol change. Taking `sampled_at` from the helper's clock would
remove reply-latency jitter but is a protocol change; it is not proposed.

### 4.5 In-flight state (C-19)

**Ownership rule: the UI owns intent, the actors own execution, and the only
thing that crosses back is a receipt keyed by `(epoch, serial)`.** `Player`
keeps deciding what a receipt means; it stops spelling the bookkeeping out by
hand in every domain.

- One small generic, `Inflight<T>`: `begin(epoch, payload) -> serial`,
  `settle(epoch, serial) -> Option<T>` (returns the payload only for the current
  request, so a stale receipt is a `None`), `cancel()`, `busy()`. It replaces
  each `*_serial` + `*_pending` pair.
- One struct per domain, living in that domain's existing `*_host.rs`, held as a
  single field on `Player`:

  | Struct | Module | Fields it absorbs (from `main.rs:421-760`) |
  |---|---|---|
  | `TransportFlight` | `transport_host.rs` | `native_play_intent`, `native_play_serial`, `native_rate_serial`, `native_rate_pending`, `native_rate_queued`, `native_rate_deferred`, `native_rate_generation_floor`, `native_rate_save_requested`, `native_rate_navigation`, `count_in_anchor`, `counting_in`, `timing_status`, `count_in_cache` (the playhead fields go to C-20's `Playhead`) |
  | `MetronomeFlight` | new `metronome_host.rs` | `metronome_serial`, `metronome_accepted`, `metronome_pending`, `metronome_requested`, `metronome_save_requested`, `metronome_save_waiting`, `metronome_navigation` |
  | `CarryFlight` | `carry_line_host.rs` | `carry_serial`, `carry_pending`, `carry_plan`, `carry_stamp`, `carry_attempt_stamp`, `carry_save_requested`, `carry_navigation` |
  | `MonitorFlight` | new `monitor_host.rs` | `monitor_requested`, `monitor_parked`, `monitor_pending`, `monitor_serial`, `monitor_publication_epoch`, `monitor_actions` |
  | `LyricsFlight` | `lyrics_sidebar_host.rs` | `lyrics_sidebar_pending`, `lyrics_search_pending`, `lyrics_search_serial`, `lyrics_editor_pending`, `lyrics_editor_serial`, `lyrics_alignment_pending`, `lyrics_alignment_serial`, `lyrics_download_pending` |
  | `TracksFlight` | `custom_tracks_host.rs` | `tracks_pending` and its serial |
  | `DeleteFlight` | `project_delete_host.rs` | `delete_serial`, `delete_inspect_pending`, `delete_pending`, `delete_waiting_monitor` |
  | `DiagnosticsFlight` | `diagnostics_host.rs` | the three `diagnostics_*_pending`, both save serials, `diagnostics_save_receipts` |
  | `ProviderFlight` | `audio_provider_host.rs` | `audio_provider_serial`, `audio_provider_pending` |

  `rename_pending`, `import_pending` and `source_pending` are navigation sagas,
  not request/receipt pairs; they stay as they are in C-19.
- Behaviour does not change. One domain per staged change, each a mechanical
  move. Unifying the three "save requested + deferred navigation" copies is a
  candidate follow-up, not part of C-19.

### 4.6 Panic hook (C-22)

- **Process registry** (`$G/src/process_registry.rs`): a process-global list of
  live long-lived helpers. An entry is added after spawn and removed before the
  child is reaped, so a registered PID cannot have been reused
  (`integration.rs:1301-1302` relies on the same property). Unix stores the PID;
  Windows stores a duplicated process handle.
- **Hook**, installed first in `main()` (`main.rs:6154`), runs once:
  1. Write a crash record directly with `std::fs`: `crash-<utc-ms>-<pid>.json` in
     the diagnostics directory, containing app version, platform, thread name,
     panic message, source location and a captured backtrace. It does not use the
     diagnostics sink (2.7).
  2. If the panicking thread is the main thread, kill every registered helper,
     taking the registry with `try_lock` so the hook cannot deadlock.
  3. Chain to the previous hook.
- **Policy by thread.** Main thread: the process is going down; helpers are
  retired by the hook. Any other thread: the hook writes the record and does not
  touch helpers; unwinding drops that thread's own helper (2.7), and an exit
  guard on each actor publishes one event so the UI shows a blocking "internal
  error, restart SingZ" notice instead of "queue is full". Saves in progress are
  left to finish.
- **Windows backstop.** All registered helpers are also placed in one Job Object
  with kill-on-close, following `lyrics_align.rs:1954-1992`, so an abort or a
  Task Manager kill retires them without any hook.
- **Next launch.** Unreported crash records are listed, one line each goes to the
  durable log through the normal sink, one notice is shown, and the records are
  marked reported. Keep the newest five.

## 5. Consequences

- `integration.rs` loses about 1,000 lines to `integration_transport.rs` and
  `integration_jobs.rs`; the facade, `Request`, `Event` and project reading stay.
- Song switches gain the old helper's clean teardown time, bounded by 750 ms and
  expected to be far below it *(inferred; unmeasured)*. N13 as written measures a
  first open, which is unaffected. C-18 must report the measured quit time on both
  machines; if p95 exceeds 100 ms the bound and the policy return to the user.
- Refused seeks, cues and metronome settings stop tearing down playback. Users
  see the refusal message and keep the song.
- A worker panic becomes visible. Today it leaves an app that reports a full
  queue forever.
- Two idle 20 ms wake-ups disappear. The 33 ms status poll while paused and the
  16 ms UI poll timer remain; they are the next N6 candidates and are **not**
  changed here, because the paused poll also carries device-failure and
  park-state telemetry. Q-02's baseline decides whether a paused cadence is
  needed.
- The helper protocol is untouched, so C-13's constraint ("no protocol change to
  the helper without D-01") resolves to: **none is authorised by this record**.
- Known gap: on macOS a hard kill of the app leaves children that do not read
  stdin running until they finish. Not addressed.
- With `strip = "symbols"` in the (uncommitted) release profile, crash-record
  backtraces are addresses only. Symbolication is a D-05 matter.

### Ordering inside wave 2

The plan gives the C-17 chain `integration.rs` and `main.rs` for the wave. Three
collisions need the coordinator's attention:

1. **C-13** lists `integration.rs` (`duration: f32` at `:397`). Run C-13 before
   C-17 starts, or after C-20 lands. Before is cheaper: C-20's `Playhead` is then
   written in `f64` once.
2. **C-22** lists `main.rs`. Its edit there is confined to `fn main` and one
   `mod` line. Run it **first**; C-18 then registers the audio helper in the
   registry C-22 created.
3. **C-20 and C-19** both rewrite transport fields on `Player`. Run C-20 first
   (it is on the critical path to Q-03), C-19 last.

Recommended order: C-13 → C-22 → C-17 → {C-18 ∥ C-20} → C-19.

## 6. What the human must decide or sign off

1. **Option (a) in its narrow form**: no priority lane, helper commands stay
   FIFO, no helper protocol change.
2. **Pause behind a helper-side rebuild stays as it is** (rate, output, lane
   commit, metronome). Removing it means an asynchronous prepare in the helper
   and is deferred to D-07/C-80. Accept, or ask for it now at extra cost and
   risk on the critical path.
3. **The C-17 bound**: p99 ≤ 30 ms, max ≤ 100 ms, and ≤ 5 ms p99 difference with
   and without a held job. The absolute values need one control run on the Mac
   and on the Windows field laptop before they are fixed.
4. **The quit bound of 750 ms**, and the rule that a measured p95 above 100 ms
   comes back to you because it lands on song-switch time.
5. **Which retirements are graceful** (navigation, training teardown, app quit)
   and which stay an immediate kill (transport fault, failed park, fault
   injection).
6. **Park failure stays fatal** to the helper.
7. **Panic policy**: a main-thread panic retires helpers and the process ends; a
   panic on any other thread keeps the app open with a blocking notice and lets
   saves finish. The alternative is to terminate on every panic.
8. **Windows Job Object** with kill-on-close for all long-lived helpers.
9. **Scope corrections to the plan** (section 7): C-20's edit list gains
   `empty_project_host.rs` and one site in `main.rs`; C-18 needs no change to
   `singz-gpui-audio.cpp`; C-22 gains a new file; the wave-2 order above.
10. **Paused status-poll cadence and the 16 ms UI timer are left alone** until
    Q-02 shows whether N6 needs them changed.

## 7. File-level outline for the unblocked packages

Tiers follow section 2 of the plan. Every `sol` package gets the Sonnet V-01
review before the coordinator's gate. All drivers run muted and hidden under a
deadline (plan rules 4 and 5); C-17, C-18 and C-20 are verified on the Mac and
the Windows field laptop together (rule 6).

### C-17 — Transport on its own actor

- **Tier**: Coder escalated, `codex` `gpt-6.1-sol`, effort high (audio timing).
  V-01 by `claude-sonnet-5-5`.
- **Files to edit**: `$G/src/integration.rs` (facade routing, `Backend::new`,
  `Backend::drop`, removal of the moved arms); new `$G/src/integration_transport.rs`
  (actor loop: Playback, Control, RestoreSeek, Region, Rate, Carry, Metronome,
  Training, CancelTraining, Park, Output, RecoverOutput, Provider, the adopt
  halves of Open / ReplaceLanes / ImportLibrary / Rename / Delete, the status
  poll); new `$G/src/integration_jobs.rs` (prepare halves, SaveLyrics,
  ReadPublication, preference requests, Catalog, lyrics/beat/analysis job
  ownership and joins, inventory, delete inspect); `$G/src/integration_provider.rs`
  and `$G/src/integration_recovery.rs` only for moved signatures.
  `transport_host.rs` is named in the plan row but needs no edit under rule 5 of
  4.1; `main.rs` is not edited.
- **Tests that prove it**:
  - New `$G/src/integration_actor_tests.rs`: with a jobs request parked on a
    gate, `playback`/`control` receipts arrive within the 4.2 bound; mutation
    check by routing the parked job through the transport actor.
  - Hand-off fencing: a prepared Open, track edit and import whose epoch is
    superseded between prepare and adopt is dropped and never touches the helper.
  - Shutdown: existing `shutdown_*` tests (`integration.rs:3307-3394`) still
    pass with both threads; no accepted preference is lost.
  - Existing suites green: `integration_transport_timing_tests.rs`,
    `integration_custom_tracks_tests.rs`, `integration_deletion_tests.rs`,
    `integration_empty_project_tests.rs`, `integration_carry_line_tests.rs`,
    `integration_save_tests.rs`.
  - Drivers: `$G/tests/test_native_transport_timing_ui.py` on both machines, plus
    `test_native_custom_tracks_ui.py`, `test_native_library_import.py`,
    `test_native_project_delete.py`, `test_native_monitor_ui.py`.
  - Evidence: the 4.2 measurement table, with build profile, machine and commit.

### C-18 — Helper supervisor: graceful quit, survivable refusals

- **Tier**: Coder escalated, `codex` `gpt-6.1-sol`, effort high (audio timing and
  session ownership). V-01 by `claude-sonnet-5-5`.
- **Files to edit**: new `$G/src/integration_helper.rs` (`Helper`: spawn,
  `retire() -> Clean | Unclean | Killed`, registry registration);
  `$G/src/integration.rs` (`Connection` uses `Helper`; one classified command
  method; `Connection::drop` kept as the safety net);
  `$G/src/integration_transport.rs` (call sites choose graceful or immediate per
  4.3; Control, Playback, Metronome, Training handle `Refused`);
  `$G/src/integration_recovery.rs` (retire before `prepare`).
  `tools/native/singz-gpui-audio.cpp` is in the plan row but **needs no change**;
  if the worker finds one necessary it stops and asks, and plan rule 7 (rebuild,
  prove the binary) then applies.
- **Tests that prove it**:
  - Unit, with a scripted fake helper selected through
    `SINGZ_GPUI_AUDIO_HELPER` (`integration.rs:1692`): exits on `quit` → `Clean`,
    no kill sent; ignores `quit` → `Killed` after the bound and within bound +
    100 ms; exit code 1 → `Unclean`; `provider_retired` returns to zero in all
    three.
  - Refusal table test: for seek out of range, an over-limit metronome, an
    over-capacity cue and a refused play, the helper PID is unchanged, the next
    `status` succeeds, lane and Carry revisions are unchanged. Negative control:
    the pre-C-18 code fails each row.
  - Fault rows: malformed reply, `state` 6 or 7, changed ownership key after a
    refusal → helper retired, `TransportFailed` published.
  - New driver `$G/tests/test_native_helper_lifecycle.py`: 50 launch/open/quit
    cycles, then no `singz-gpui-audio` process owned by the run remains; reports
    quit-time p50/p95/max. Mac and Windows field laptop.
  - Existing: `test_native_audio_recovery.py`, `test_native_audio_provider_ui.py`,
    `test_native_monitor.py`, `test_native_training_only.py`.

### C-20 — Playhead never steps backward

- **Tier**: Coder escalated, `codex` `gpt-6.1-sol`, effort high (audio timing).
  V-01 by `claude-sonnet-5-5`.
- **Files to edit**: `$G/src/transport_timing.rs` (`Playhead`);
  `$G/src/transport_timing_tests.rs`; **`$G/src/empty_project_host.rs`**
  (`playback_status` feeds `Playhead`; not in the plan row, required);
  **`$G/src/main.rs`** limited to the projection block at `:5499-5509`, the seek
  sites at `:2180`, `:4260-4263`, `:4354`, and the six field declarations and
  initialisers; the reset sites that clear those fields in
  `audio_recovery_host.rs`, `carry_line_host.rs`, `custom_tracks_host.rs`,
  `project_delete_host.rs`, `transport_host.rs`. `timeline_host.rs` is in the
  plan row but only reads `self.position`; edit it only if the driver shows the
  timeline needs the same source.
- **Tests that prove it**: one sampling test per rule in
  `transport_timing_tests.rs`, each replaying a recorded status sequence against
  `Playhead` at sub-millisecond `now` steps and asserting no decrease outside the
  three permitted events:
  1. pause hold (a playing-true status sampled before the pause, delivered after);
  2. immature projection after Play, plain and with a 150 ms latency;
  3. post-seek hold, including two queued seeks and a seek queued behind a rate;
  4. loop fold on a 0.25 s loop across 80 wraps.
  Plus: reordered `sampled_at`, a graph-generation change, a lane-revision
  change. Each test must fail against the current assignment at
  `empty_project_host.rs:118` (mutation check). Drivers:
  `test_native_transport_timing_ui.py` and `test_native_count_in.py` on both
  machines. The live sampling drivers themselves are Q-03.

### C-19 — Collapse `Player` pending state

- **Tier**: Coder default, `codex` `gpt-reserve`, effort medium. No behaviour
  change is permitted, so the full suite is the oracle. If the first attempt
  cannot keep the drivers green, escalate one tier to `claude-sonnet-5-5` and say
  so (the work is convention-bound across 19 host modules).
- **Files to edit**: `$G/src/main.rs` (`struct Player`, its initialiser at
  `:1336-1600`, and field uses); new `$G/src/inflight.rs`; new
  `$G/src/metronome_host.rs` and `$G/src/monitor_host.rs`; and the host modules
  in the 4.5 table: `transport_host.rs`, `carry_line_host.rs`,
  `lyrics_sidebar_host.rs`, `custom_tracks_host.rs`, `project_delete_host.rs`,
  `diagnostics_host.rs`, `audio_provider_host.rs`, plus `audio_recovery_host.rs`
  and `empty_project_host.rs` for field uses. The `ui_*.rs` harnesses that read
  the moved fields change only in field paths.
- **Tests that prove it**: new `$G/src/inflight_tests.rs` (stale epoch, stale
  serial, cancel, reuse after settle); `cargo test` for the crate unchanged in
  count and green; every `$G/tests/test_native_*_ui.py` driver green; the v15
  timing and monitor UI captures unchanged. Evidence includes the count of
  `pending`-named fields on `Player` before (23) and after.

### C-22 — Panic hook and crash record

- **Tier**: Coder default, `codex` `gpt-reserve`, effort medium.
- **Files to edit**: new `$G/src/process_registry.rs`; new `$G/src/crash_record.rs`
  (hook, record writer, next-launch scan); `$G/src/main.rs` limited to `fn main`
  (`:6154`), the `mod` lines and the startup notice call; `$G/src/diagnostics.rs`
  only to expose the diagnostics directory if it is not already reachable;
  `$G/src/diagnostics_tests.rs`; `$G/src/microphone.rs` to register the input
  helper. Registration of the audio helper is C-18's edit. `log_panel.rs` is in
  the plan row and is edited only if the crash line needs its own presentation.
  The exit guard that tells the UI an actor died is added by C-17 if C-22 lands
  first, otherwise here in `integration_transport.rs` and `integration_jobs.rs`.
- **Tests that prove it**:
  - Unit: the record writer produces valid JSON with message and location for
    `&str` and `String` payloads; the hook runs once under a nested panic; the
    registry never holds a reaped PID; `kill_all` with a contended lock returns
    without blocking.
  - New driver `$G/tests/test_native_crash_record.py`, using a panic injection
    point compiled only under the `ui-tests` feature (until C-23 moves it to the
    feature D-05 names): inject on the main thread with a song loaded → the
    process ends non-zero, one crash record exists, no helper started by the run
    is alive after 2 s, and the next launch shows the notice, logs one line and
    marks the record reported. Inject on the transport actor → the app stays up,
    shows the internal-error notice, the helper is gone, a record exists.
  - Windows: the same driver plus a forced `TerminateProcess` of the app proves
    the Job Object retires the helpers.
