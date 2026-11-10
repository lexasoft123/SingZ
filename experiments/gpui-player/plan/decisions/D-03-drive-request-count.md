# D-03 — How does Drive sync reach Electron's request count without changing what it uploads?

Decision record, written 2026-11-10 against `codex/gpui-interface` at `f7607311`.
Paths are relative to the repository root; `$G` is `experiments/gpui-player`.
Anything marked *(inferred)* was not checked against code. Nothing was built or
run for this record: every request count below is a trace of the code, not a
measurement. The first step of C-12 turns the trace into a measured number.

## Question

A clean Electron sync costs four Drive requests for a library of any size up to
50 projects. The native sync costs far more, and starts one `curl` process per
request. The plan frames the fix as three choices: batched `in parents` listing,
the HTTP transport, and where the `stemHashes`/`lyricsHash` write-back sits
relative to the project lease and the dirty ledger. The constraint is that the
bytes native uploads, and the planner's decisions, do not change.

The reading for this record changed the question in two ways:

1. **Batched listing already exists in native.** The excess comes from somewhere
   else: every clean project re-runs the journaled publication protocol and
   re-verifies every remote member by exact-ID GET, three to five times.
2. **A write-back into `project.json` collides with a native invariant Electron
   does not have.** Native uses the whole-file fingerprint of `project.json` as
   the compare-and-swap base for Save, delete, rename, import and recording
   recovery. Electron serialises writers through a queue and has no such base.

## Inputs, and what was verified

### Verified against code

| # | Fact | Evidence |
|---|---|---|
| V1 | Electron's clean sync is `ensureFolder` + root listing + one batched listing of project folders + one of `stems/` folders, 50 parents per query. A clean project costs zero requests: the loop `continue`s when the plan has no upload and no trash. The catalog is uploaded only when its md5 differs from the listing's. | `src/main/gdrive.ts:797-798`, `:845`, `:855`, `:1016-1019`, `:1105`; `src/main/sync-plan.ts:35-45` |
| V2 | Electron's own test pins this: four hits, zero stem reads, no upload. | `tests/unit/gdrive-sync.test.ts:119-126` |
| V3 | Native already batches the same two listings with the same chunk size. | `$G/src/drive_sync.rs:196-216`; `$G/src/drive_remote.rs:231-248` (`children_of`); `$G/src/drive_plan.rs:12`, `:175-187` |
| V4 | Native's prelude, before any project: SingZ folder lookup, root listing, account identity (`about`), account identity again inside the retirement pass, root listing again. | `$G/src/drive_sync.rs:96`, `:97`, `:103`, `:127`, `:141`; `$G/src/drive_retirement.rs:97-110`; `$G/src/drive_retire_transaction.rs:331-345`, `:855` |
| V5 | Every project, clean or not, goes through `prepare` → `finish` → (end of run) `remember_publication`. There is no clean-project shortcut that avoids the network. | `$G/src/drive_sync.rs:238-340`, `:412-417` |
| V6 | `prepare` on a clean project: `admit_destination` (account identity + a root listing), then it returns the existing `Complete` journal. | `$G/src/drive_publication.rs:74`, `:76-81`; `$G/src/drive_retire_transaction.rs:1165-1247`, `:504-515` |
| V7 | `finish` on an already complete journal: account identity; root listing and folder listing; one GET for the folder and one per member; catalog read (root listing + GET + download); then `capture_verify_publication`. | `$G/src/drive_publication.rs:143-166` (lines 147, 158, 159, 162), `:51-52`, `:57-59` |
| V8 | `capture_verify_publication`: account identity, a GET per folder and member, two roster listings, catalog GET and download, then every GET and both listings again. `10 + 2M` requests for a project with `M` members and a stems folder. | `$G/src/drive_retirement.rs:162-200` (lines 167, 168, 172, 180, 183, 186, 197, 198), `:122-129`, `:150-159` |
| V9 | The lineage record it produces is content-addressed and does not contain the catalog file's metadata, so re-recording an unchanged lineage is a no-op. Retirement verifies a lineage live before acting on it. | `$G/src/drive_retirement.rs:45-53`, `:205-212`; `$G/src/drive_retire_transaction.rs:372-394` |
| V10 | The empty-project transaction and its two hooks make no request when there is no empty project and no journal. | `$G/src/drive_empty.rs:542-550`, `:480-482`, `:513-515` |
| V11 | End of run: one more catalog read (three requests), catalog upload only on md5 change. | `$G/src/drive_sync.rs:357-358`, `:389-401`; `$G/src/drive_publication.rs:57-59` |
| V12 | Listing rows and exact-ID metadata carry the same fields except `trashed`, and listings filter `trashed=false`. | `$G/src/drive_remote.rs:17`, `:164-177`, `:221-229` |
| V13 | One `curl` (or `curl.exe`) process per request, a private scratch directory, two reader threads and a 5 ms poll loop. No connection reuse is possible. | `$G/src/drive_http.rs:228-461` (spawn at 294-335, poll at 383-402) |
| V14 | No HTTP or TLS client is compiled into the app today. `rustls`, `hyper`, `tokio` and a `reqwest` fork are in `Cargo.lock` only as an optional dependency of `gpui-kit-assets`; `$G/target/debug/deps` has no artifact for any of them. GPUI's `http_client` crate is compiled but is a trait without a network implementation here. | `$G/Cargo.toml` (no HTTP dependency); `$G/Cargo.lock` (dependents of `gpui-pre-reqwest`); `$G/target/debug/deps` listing |
| V15 | Native reuses a cached hash when size matches and mtime is within 2 ms, the same rule as Electron. The cache it reads is the local `project.json`. | `$G/src/drive_snapshot.rs:85-98`, `:278`, `:342`; `src/main/projects.ts:293`, `:322`; `src/main/sync-plan.ts:161-167` |
| V16 | Native never writes those hashes locally. They are set on the transported copy only, which is re-serialised compact with `serde_json::to_vec`. | `$G/src/drive_snapshot.rs:369`, `:376`, `:387-392`; comment at `:25-26` |
| V17 | A native split deletes `stemHashes` from `project.json`, so every natively split project has no cache and every sync reads every stem in full. | `$G/src/source_jobs.rs:1381-1384`; `$G/src/drive_snapshot.rs:55-81` |
| V18 | Electron writes the hashes into the local file under the project document queue, before it captures `project.json`, and uploads the local bytes. That write does not touch the ledger. | `src/main/gdrive.ts:904-950`; `src/main/projects.ts:564-582`; `src/main/gdrive.ts:1110-1111` |
| V19 | Native Save is a compare-and-swap on the fingerprint of `project.json` and fails with "Project changed outside this app. Reopen it before saving." when the file changed. The editor saves from its in-memory document. | `$G/src/project_store.rs:698-747`; `$G/src/integration_save.rs:26-34` |
| V20 | The same fingerprint guards recording-recovery adoption and loaded-media verification, and is captured by delete, rename and import. | `$G/src/integration_recovery.rs:25-45`; `$G/src/project_delete.rs:327-386`; `$G/src/integration.rs:1057` |
| V21 | The Drive service keeps a receipt of `project path → fingerprint of local project.json` and marks a project dirty when the file no longer matches. | `$G/src/drive_service.rs:249-283`, `:586-589`, `:709-710`; `$G/src/drive_sync.rs:339` |
| V22 | The dirty ledger is explicit marks only; `project_store::commit_expected_locked` does not mark. Save marks through its own hook. | `$G/src/sync_dirty.rs:123`, `:193`; `$G/src/integration_save.rs:44`; `$G/src/project_store.rs:698-747` |
| V23 | The scheduler runs a sync 8 s after launch, 4 s after a change, and sweeps a clean library every 6 hours. | `$G/src/sync_scheduler.rs:5-9` |
| V24 | The fake Drive records ordered requests and per-route counts at `/state`. R-09's statement that the fixture is missing is wrong. | `$G/tests/drive_fixture.py:1-14`, `:79`, `:102-105`, `:184` |
| V25 | The per-project catalog commit moves the project's row to the end of `projects`; the end-of-run manifest is in directory order. | `$G/src/drive_publication.rs:135`; `$G/src/drive_sync.rs:238-244`, `:375` |
| V26 | The RFC places HTTP among the client-side effect handlers, outside the core, and makes "same number of requests as Electron on the fake Drive at 50 projects, hashes written back without marking the ledger" a phase exit. | `docs/rfc/0001-shared-product-core.md:148-150`, `:234`, `:583-585` |

### Request count, traced

`P` projects, `S` of them with a `stems/` folder, `M` remote members per project
(files plus the stems folder). The reference project of plan section 3 — six
stems, lyrics — has `M = 9`.

| Step | Requests | Source |
|---|---|---|
| Prelude | 5 | V4 |
| Batched listings | `⌈P/50⌉ + ⌈S/50⌉` | V3 |
| Per clean project: `prepare` | 2 | V6 |
| Per clean project: `finish` | `17 + 3M` | V7, V8 |
| Per clean project: `remember_publication` | `10 + 2M` | V5, V8 |
| End of run catalog read | 3 | V11 |
| **Native clean total** | **`8 + ⌈P/50⌉ + ⌈S/50⌉ + P·(29 + 5M)`** | |
| **Electron clean total** | **`2 + ⌈P/50⌉ + ⌈S/50⌉`** | V1 |

| Projects (`M = 9`) | Electron | Native today (traced) | `curl` processes |
|---:|---:|---:|---:|
| 1 | 4 | 84 | 84 |
| 10 | 4 | 750 | 750 |
| 50 | 4 | 3,710 | 3,710 |

A project without stems (`M = 2`) costs `25 + 5M = 35`. Token refresh is not
counted. The RFC's "over a thousand for 50 songs" is an underestimate.

One changed `project.json` in one project, by the same trace, costs that project
about `74 + 9M` (155 at `M = 9`) through `prepare` and a non-complete `finish`
(`$G/src/drive_publication.rs:69-108`, `:143-166`, `:112-120`, `:123-142`), on top
of the clean cost of every other project. Electron's cost for the same change is
8 requests, or 10 when a stem or `lyrics.json` changed and `project.json` follows
it (`src/main/gdrive.ts:358-380`, `:1094-1108`). This path was traced once and
not re-checked line by line; treat 155 as ±10 *(inferred)*.

### Checked claims from the research reports

| Claim | Result |
|---|---|
| R-09: native reconciliation listing is 6 requests at 50 projects because the project listing "needs two chunks" | Wrong. 50 ids are one chunk (`$G/src/drive_plan.rs:178-187`). |
| R-09: native totals "not determinable"; fixture absent | Determinable by trace (table above). Fixture present (V24). |
| R-09: Electron 4 clean, 8 with one file changed | Confirmed for a `project.json`-only change; 10 otherwise. |
| R-01: `stemHashes` not written back, "confirmed at snapshot boundary" | Confirmed end to end: no local write exists (V16), and native splits remove the field (V17). |
| R-01: one `curl` per request | Confirmed (V13). |
| Plan 4.3 row C-12: the work is "batched Drive listing" in `drive_remote.rs`, `drive_plan.rs`, `drive_http.rs`, `drive_graph.rs` | The batching is done (V3). The work is in `drive_sync.rs`, `drive_publication.rs`, `drive_retirement.rs` and `drive_retire_transaction.rs`. `drive_graph.rs` is not involved. |

## Options

Costs are worker-days including the second review where the plan requires one.
"Budgets" are the N-rows of plan section 3.

### 1. Request count

**1A. Batched listing only (the plan's wording).** Cost 0: it exists. Effect 0.
Not an option; listed because the C-12 row is written around it.

**1B. Quiet path for clean projects (recommended).** A project is *quiet* when
all of the following hold, decided from local state and the listings the run has
already fetched, with no request:

1. the planner returns no upload and no trash for it (planner untouched);
2. a `Complete` publication journal exists for this binding and project whose
   capture equals the current capture — root identity, directory identity and
   local document fingerprint — and whose members match the local snapshot
   (the condition `prepare` already tests at `$G/src/drive_publication.rs:78-80`);
3. the batched listings show the journal's folder and every journal member with
   equal id, name, parent, md5, size, MIME type and `appProperties`, and show no
   member the journal does not know;
4. the current catalog's row for the project equals the journal's row;
5. no retirement journal guards the name and no local delete or rename is
   unfinished for it (the local half of `admit_destination`);
6. a recorded lineage exists for this capture, or none can exist because the
   directory identity is not persistent (`created` absent,
   `$G/src/directory_identity.rs:34-36`). In that second case the quiet path
   repeats the warning `finish` gives today, so a library on such a filesystem
   is quiet too instead of paying the full cost for ever.

A quiet project contributes its journal row to the catalog and its fingerprint
to the report, and makes no request. Any failed condition sends the project down
today's path unchanged. Alongside it:

- account identity is fetched once per run and reused while the token generation
  is unchanged (the existing `stop` closures already cancel on a generation
  change);
- the second root listing (`$G/src/drive_sync.rs:141`) is skipped when the
  retirement pass made no Drive request;
- the catalog body is taken from a private cache when the root listing's md5 for
  `catalog.json` equals the md5 of the cached bytes; otherwise it is downloaded
  once and cached. The cache is self-validating: wrong bytes cannot match;
- publication journals are indexed once per run instead of re-read per project
  (`handles()` at `$G/src/drive_publication.rs:48-49` is `O(projects × history)`
  file reads today).

Result: `3 + ⌈P/50⌉ + ⌈S/50⌉` clean, one more when the catalog cache is cold.
That is Electron plus one. Cost 6 to 7 days on `sol`, plus V-01. Risk medium:
it removes re-verification, so the argument that nothing is lost has to hold.
It does: V12 says a listing row is the same observation as a GET for anything
not trashed, and a trashed member is absent from the listing, which fails
condition 3. No remote write is made on behalf of a quiet project. No new
lineage is recorded for it, and retirement re-verifies live before it trashes
anything (V9). The risk that remains is an implementation slip in the
comparison, which is what the tamper tests in the outline are for.
Budgets: removes about 3,700 process spawns from the launch sync at 50 projects
(V23), which today overlaps N12, N13 and the first minutes of N7 and N11.

**1C. Memoise GETs inside the existing protocol.** Keep every step, cache each
exact-ID answer for the run. Cost 3 days. Gets to roughly `P × 6` requests, not
to Electron's count. Risk high: the protocol observes twice on purpose (before
and after the catalog read, `$G/src/drive_retirement.rs:194-198`); a memo turns
the second observation into a copy of the first on the paths that do write.
Rejected.

**1D. Exact parity (Electron + 0).** 1B plus persisting the account key across
runs. Cost +1 day. Risk: an authority fact cached on disk outlives the check
that it is still true; `TokenStore` adopts a newer on-disk generation from
another process (`$G/src/drive_auth.rs:365-372`), so "same generation" is weaker
across processes than within one. Not recommended; offered because the plan says
"within Electron's request count plus the margin D-03 sets".

### 2. Transport

**2A. Keep `curl` per request (recommended for C-12).** Cost 0. After 1B a
clean sync is 5 processes. A changed project is still about 120 to 155
processes, at perhaps 0.15 to 0.4 s each with a fresh TLS handshake *(inferred;
not measured)*, so 20 to 60 s to push one Save. Risk: none new. It keeps the
audited properties of `drive_http.rs`: secrets on stdin, no redirects, bounded
output. Budgets: no size change (N14); short CPU bursts in child processes
during a changed-project sync count against N7 if a sync overlaps playback.

**2B. Persistent `curl`.** `curl` reads all of `--config -` before the first
transfer *(inferred from curl's behaviour, not tested here)*, so one process
cannot serve a sequence where each request depends on the last answer. It could
serve a batch of independent GETs with `--next`. After 1B there is no such batch
left on the clean path. Cost 3 to 4 days, risk medium (response demultiplexing,
per-request deadlines), benefit close to nil. Rejected.

**2C. In-process blocking client with keep-alive.** `ureq` with the platform TLS
stack (`native-tls`: Secure Transport, SChannel; both already resolved in
`Cargo.lock`) behind the existing `drive_http::request` signature. Platform TLS
rather than bundled roots, so it trusts what `curl` trusts today behind a
corporate proxy. Cost 4 to 5 days on `sol` plus V-01, and it touches every
caller of `drive_http::request` (nine files, including OAuth, LRCLIB and model
install). Risk medium: cancellation must be rebuilt (a blocking call cannot be
killed like a child process), redirects must stay off, proxy behaviour changes.
Budgets: binary grows by 1 to 2.5 MB *(inferred)* against N14's 122 MB; removes
process spawns; per-request time falls to roughly a round trip.

**2D. `libcurl` binding.** Same semantics as today in process. Needs a vendored
C build of libcurl on Windows, which lands on D-05's reproducible build. Cost 5
to 6 days, risk medium. No advantage over 2C that justifies the build edge.

### 3. Where the hash cache lives

**3A. Write into `project.json` during capture, as Electron does.** Under the
project lease, before the fingerprint the rest of the run uses is taken, through
`project_store::commit_locked`. This does not re-dirty: the ledger is not marked
(V22) and the receipt records the post-write fingerprint (V21). It breaks
something else. V19 and V20: any holder of the old fingerprint — an open
project's next Save, a pending recording-recovery adoption, an open delete or
rename dialog — is refused after the write. The editor would also write its stale
in-memory `stemHashes` back on the next Save. Making that safe needs a rebase
path through `integration.rs`, `main.rs` and `project_store.rs`, which the C-17
chain owns in wave 2. Cost 4 days plus 3 to 4 for the rebase. Risk high: a new
writer of user documents on the sync path, racing an Electron that ignores
native's lease during side-by-side beta.

**3B. Private sidecar cache (recommended).** Keep `{name → md5, size, mtimeMs}`
for stems and the source file in native's private state, bound to the project
directory's identity. `hash_value` consults the document's own entry first (so
hashes Electron wrote are used as today), then the sidecar; a fresh entry in
either means the file is not opened. Written under the project lease after
hashing; a failed write is a warning. `project.json` is never touched, so the
lease, the ledger, the receipt and every fingerprint holder are unaffected by
construction. The transported document is byte-identical to today's because the
values placed in it are the same. Cost 3 days on `sol` plus V-01. Risk low to
medium: a wrong cached md5 makes the planner skip a changed stem, the same
exposure Electron accepts, narrowed by the identity binding.
Budgets: removes a full read of every stem of every natively split project from
every sync — several GB at 50 projects *(inferred sizes)* — which on iCloud is
also a re-download (RFC line 68).

**3C. In-memory cache only.** 1 day. Lost on restart, and the first sync after
launch is the one that matters (V23). Rejected.

`lyricsHash` needs nothing: `lyrics.json` is read whole on every capture because
its bytes are spooled, and the hash is recomputed from them
(`$G/src/drive_snapshot.rs:372-378`).

## Recommendation

**1B + 2A + 3B.**

- C-12 becomes "quiet path for clean projects", not "batched listing". Budget:
  clean sync `≤ Electron + 1`, and `≤ Electron + 2` on a cold catalog cache —
  5 and 6 requests at 50 projects with stems. No non-GET request on a clean run.
- Transport stays `curl` in C-12. `drive_http.rs` is not edited. 2C is held as a
  separate, already-specified package (C-12T below) that starts only if the
  measured wall time of a one-project change on the Windows laptop exceeds a
  threshold the user sets.
- C-11 becomes "persistent stem hash cache", kept outside `project.json`. The
  acceptance in the plan row holds as written except for the file it names:
  second clean sync reads zero stem bytes, nothing is marked dirty, tolerance is
  Electron's 2 ms.
- The changed-project path is left as it is. Its cost is pinned by a counting
  test so it cannot grow, and reported, not reduced.

Order stays C-11 → C-12; both edit `drive_sync.rs`.

## Consequences

- **What it uploads does not change.** The planner is not edited. The slow path
  is not edited. The quiet path performs no write. The sidecar changes where a
  hash is remembered, not its value.
- **The plan's C-12 edit list is wrong and must be replaced** by the list in the
  outline. `drive_publication.rs`, `drive_retirement.rs` and
  `drive_retire_transaction.rs` are added; `drive_graph.rs` and `drive_http.rs`
  are dropped.
- **The plan's C-11 title is wrong for native.** The RFC exit (V26) says "written
  back without marking the ledger"; this record satisfies its purpose (no stem
  bytes on a clean sync) by a different mechanism and needs sign-off for that.
- **A changed project still costs two orders of magnitude more than Electron.**
  That is the journaled publication protocol, which exists to make delete and
  rename safe. Bringing it down is a protocol redesign and is not in C-12.
- **Two catalog writes per changed project** *(inferred from V25, not run)*: the
  per-project commit appends the row, the end-of-run manifest restores directory
  order. The counting test will show it. Fixing the order in the per-project
  commit would remove it; that changes catalog bytes mid-run and belongs to C-43.
- **First native sync of a library Electron uploaded re-uploads every
  `project.json`** *(inferred, not run)*: native transports compact JSON
  (`$G/src/drive_snapshot.rs:387-392`), Electron uploads its pretty-printed local
  file (`src/main/projects.ts:565`). It also has no journals, so every project
  takes the slow path once. The same difference means two desktops on one
  library cannot reach "upload nothing" as D-04's C-43 outline requires. Neither
  3A nor 3B fixes that; it needs both writers to transport the same bytes. C-43
  must own it, and 3A would become a prerequisite there if C-43 chooses
  "transport the local file verbatim".
- **Publication journals are never pruned**
  (`$G/src/drive_publication.rs:240-249`, a test that 4,098 are tolerated). The
  per-run index in 1B stops this costing `O(projects × history)`, but the
  directory still grows by one entry per changed project per sync. Not addressed
  here.
- **Each capture still fsyncs up to three small spool files per project**
  (`$G/src/drive_snapshot.rs:436-449`) on a clean sync. Local cost only; left
  alone because the planner needs their md5. Worth a line in the Q-02 idle
  profile if a clean sweep shows up in N6.
- **Shipping on the system `curl`** stays a product dependency: `curl.exe` is
  present on Windows 10 1803 and later *(inferred)*, and `Command::new("curl")`
  resolves through `PATH` (`$G/src/drive_http.rs:295`).
- **Section 3 budgets.** Frame budgets N1 to N5 are untouched: all of this is on
  the Drive worker thread. N6: a clean sweep becomes 5 short child processes
  every 6 hours instead of thousands. N7 and N11: the launch sync no longer
  overlaps the first minutes of playback with a process storm. N9 and N10: the
  catalog cache and the journal index are bounded by the 16 MiB catalog limit
  and one journal per project; no growth per sync. N12 and N13: the launch sync
  at 8 s stops competing for disk with song open, because stems are no longer
  read. N14: unchanged under 2A.

## What the human must decide or sign off

1. **C-11 by sidecar instead of writing `project.json`.** This departs from the
   plan row's title and from the RFC's wording. The alternative (3A) costs about
   4 more days, edits files the C-17 chain owns, and adds a document writer to
   the sync path. Yes or no.
2. **The margin.** Is "Electron + 1 in steady state, + 2 on a cold catalog cache"
   acceptable as the C-12 budget, or is exact parity required (1D, +1 day, with
   the stated risk)?
3. **The changed-project cost.** About 120 to 155 requests to push one saved
   project, against Electron's 8 to 10. Accept for beta with the number pinned
   by a test, or fund a redesign of the publication protocol as a new package?
4. **The transport threshold.** What wall time for a one-project change on the
   Windows laptop triggers C-12T? Proposed: 10 s excluding byte transfer.
   Starting C-12T also means approving a new HTTP dependency and its TLS choice
   (platform TLS proposed).
5. **System `curl` in the shipped product.** Is depending on the OS-provided
   `curl` acceptable for the default build, including the minimum Windows
   version that implies?
6. **Side-by-side on one local library folder.** Is running Electron and native
   against the same projects folder a supported beta configuration? If yes, the
   byte-convergence item above is a release blocker for C-43, not a nicety.
7. **The one-time re-upload** of every `project.json` when native first syncs an
   Electron-built library: acceptable, or must C-43 prevent it?
8. **Real-account measurement.** Q-12 needs the user's Google account to record
   the real request count and wall time, and to learn whether today's volume
   trips a Drive quota *(inferred risk; no quota figure was checked)*. C-11 and
   C-12 themselves need no credential: both are proven on the fake Drive.

## Outline for C-11 — persistent stem hash cache

`sol`, effort high, then V-01 (`sonnet`). 3 days. It decides what the planner
believes about local audio, so a wrong answer leaves a stale stem on Drive.
Depends: D-03 signed (item 1).

| File | Change |
|---|---|
| `$G/src/drive_hash_cache.rs` (new) | Bounded, private, atomically replaced cache file per project under `<config>/gdrive/hash-cache/`. Keyed by directory identity when `persistent_eligible()`, by canonical path otherwise; the stored identity is checked on load. Unsafe, oversized, linked or unparsable files are ignored with a warning. Follow the private-directory and bounded-read pattern of `$G/src/drive_retirement.rs:62-96`. No `Remote` in any signature. |
| `$G/src/drive_snapshot.rs` | `capture_inner` loads the cache after taking the lease (`:216`). `hash_value` takes the document's entry and the cache entry; reuse either when fresh under the 2 ms rule, digest when neither is or when both are fresh and disagree. Covers stems (`:278`) and the source file (`:342`). Save the cache before the final unchanged-document check (`:397-401`), only when it changed. `project.json` is not written. |
| `$G/src/drive_sync.rs` | Pass the configuration directory to `capture`; drop cache files for directories that no longer exist, after the roster scan. |
| `$G/src/drive_plan.rs` | None. `MTIME_TOLERANCE_MS` (`:13`) already exists; use it instead of the literal `2.` at `drive_snapshot.rs:92`. |
| `$G/src/drive_local_ops.rs` | None. The plan row lists it; the cache is not a local operation. |

Tests, in `$G/src/drive_snapshot_tests.rs` and `$G/src/drive_service_tests.rs`:

1. Second capture of an unchanged project digests zero stem bytes (a test-only
   byte counter in `digest`), across a cache reload, for a project whose
   `project.json` has no `stemHashes` — the natively split case (V17).
2. Negative control: the same test with the cache save disabled must fail.
3. A stem rewritten with different bytes, same size, mtime restored within
   1.5 ms: cached md5 is used. Mtime moved by 2.5 ms: digested. Electron's
   boundary (`src/main/sync-plan.ts:161-167`).
4. `project.json` bytes, the sync ledger sequence and the service receipt are
   identical before and after two sync cycles; the scheduler queues no follow-up.
5. The transported `project.json` has the same md5 with a cold cache, a warm
   cache, and at the base commit (golden).
6. A project directory deleted and recreated under the same name does not
   inherit the cache.
7. A document entry written by Electron and a cache entry that disagree: digest.
8. A corrupt, oversized or symlinked cache file never fails a sync.

## Outline for C-12 — quiet path for clean projects

Depends: D-03 signed (items 2 and 3), C-11 merged. 7 to 8 days in two parts.

**C-12a — request-count harness.** `reserve`, effort medium, 1 day. Test code
only; a clear spec; follows the fixture pattern at
`$G/src/drive_publication.rs:185-214`.

| File | Change |
|---|---|
| `$G/src/drive_sync_tests.rs` (new, `#[cfg(test)]`) | A library builder for `P` projects with stems; a helper that diffs the fixture's ordered `/state` requests around one `drive_sync::run`. |
| `$G/tests/drive_fixture.py` | Only if `/state` cannot be diffed as is: a `resetCounts` control. |

It lands first and records today's numbers for `P` = 1, 10, 50, 51 and for one
changed `project.json`, as asserted values. Those are the "before" evidence and
replace the traced table in this record. Expected by trace: 84, 750, 3,710.

**C-12b — the quiet path.** `sol`, effort high, then V-01 (`sonnet`). 6 to 7
days. Escalated because a wrong "quiet" verdict leaves Drive stale, and a wrong
listing comparison could let the orphan pass act on a bad roster.

| File | Change |
|---|---|
| `$G/src/drive_plan.rs` | A pure `quiet_members(journal members, listed top, listed stems) -> bool` beside the planner, with table tests. Existing functions untouched. |
| `$G/src/drive_publication.rs` | `quiet(index, binding, capture, plan, admission, catalog) -> Option<PublicationOutcome>` with no `Remote` parameter; a per-run journal index replacing the per-project `handles()` scan; `read_catalog` accepts the root listing and the cache. |
| `$G/src/drive_retire_transaction.rs` | Split `admit_destination` into its local checks and its observation, so the quiet path can supply the root listing it already has. Report whether the retirement pass made a request. |
| `$G/src/drive_retirement.rs` | A local lookup of the recorded lineage for a capture (`latest_publication` at `:235-239` is the base). |
| `$G/src/drive_remote.rs` | Per-run memo of `account_key`, dropped when the token generation changes. |
| `$G/src/drive_sync.rs` | The gate before `prepare` (`:317`); skip `remember_publication` for quiet projects (`:412-417`); reuse the first root listing (`:141`); catalog cache at `:357`. |
| `$G/src/drive_http.rs`, `drive_graph.rs` | None. |

Tests, in addition to every existing Drive suite staying green:

1. Clean sync request count equals `3 + ⌈P/50⌉ + ⌈S/50⌉` for `P` = 1, 10, 50, 51
   with a warm catalog cache, one more cold; every request is a GET. This fails
   at the C-12a baseline, which is the proof it rejects the old behaviour.
2. One changed `project.json`: the count is the same at `P` = 10 and `P` = 50,
   and equals the value C-12a recorded for one project's slow path plus the
   clean prelude. Pinned as an exact number.
3. Tamper cases, each of which must leave the quiet path and produce exactly
   today's result: a member's md5 changed remotely; a member trashed; a foreign
   file added to the folder; a foreign file added to `stems/`; the project
   folder replaced by another id with the same name; the catalog row altered by
   another writer; `catalog.json` replaced; the catalog cache file corrupted; a
   retirement journal guarding the name; an unfinished local rename; the token
   generation changing mid-run.
4. Final fixture state — file set, md5s, `catalog.json` bytes — and the `Report`
   are identical before and after the change on the existing fixtures (golden).
5. Orphan trashing, `published` folders, the empty-library refusal and duplicate
   folder refusal: existing `drive_adopt_tests.rs`, `drive_service_tests.rs`,
   `$G/tests/test_native_drive_ui.py`, `test_native_drive_retirement.py`,
   `test_native_empty_drive.py` unchanged and green.
6. A clean run after a retirement, an adoption, or an empty-project transaction
   still returns `follow_up` exactly as before.

**C-12T — in-process transport (conditional; not started by this record).**
`sol`, effort high, then V-01. 4 to 5 days. Starts only on sign-off item 4.
Files: `$G/Cargo.toml`, `$G/src/drive_http.rs`, `$G/src/drive_http_tests.rs`.
The `request` and `request_with_progress` signatures do not change, so no caller
is edited. Tests: the existing `drive_http_tests.rs` cases for redirects, bounds,
cancellation and partial-file removal pass unchanged; a cancel during connect,
headers and body each return within the poll interval; the bearer token never
reaches a redirect target; a run behind a TLS-intercepting proxy on the laptop
(human). Measure N14 before and after.

## Not checked

- No request count here was measured. C-12a measures them.
- The no-request claim for `drive_adopt::adopt` when there is no published
  folder rests on where its `remote` calls sit (`$G/src/drive_adopt.rs:683`,
  `:864`, `:875`, `:892`, `:442`), not on reading the function through.
- The retirement pass with no journal and no pending local operation was read to
  the account check (`$G/src/drive_retire_transaction.rs:845-915`); the rest of
  the function was skimmed.
- The changed-project trace (155) was done once.
- Per-request times, stem sizes, binary growth under 2C, `curl`'s config
  parsing, and Drive quota are estimates.
- Whether a clean native run leaves the catalog at a fixed point (no reorder
  upload on the second clean run) follows from V25 but was not run.
- `tests/unit/mock-drive.ts` was not read; V2 cites the test that uses it.
- The private `singz-dev` handbook was not consulted. Nothing here touches a
  team host; Q-12 will.
