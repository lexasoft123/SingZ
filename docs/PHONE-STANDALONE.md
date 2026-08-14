# Phone standalone song-adding — research record & architecture

Status: **Phase 0 (spike + rig) in progress.** Researched 2026-08-14 (three codebase
exploration agents + web verification + one design agent); scope decisions and the
architecture below approved the same day. This document is the record — read it before
touching the phone pipeline, and update it as phases land (the docs/BEAT-DETECTION.md
convention).

The goal: add a track and analyze it **entirely on the phone** — import an audio file,
split into the six stems, detect beats, track melody, fetch lyrics — standalone, with
the result eventually publishable to Drive so the desktop adopts it. Android ships
first (the family fleet, $0 distribution); iOS is in scope with the same engine core.

## Scope decisions (user, 2026-08-14)

- **Staged shipping**: import + play + lyrics first (no split), split/analysis in later
  releases. Android integrates each chunk first; iOS follows once the core is proven.
- **Heavy compute in shared C++**: split engine + Beat This runner + FLAC encode are
  one C++ core linked on both platforms — speed headroom, and iOS becomes an
  integration rather than a rewrite.
- **Drive publish in scope, last phase**, including the desktop adoption pass.
- **Weak devices are gated** with honest copy ("add this song on the desktop"), not
  allowed to die mid-split. Import + lyrics work everywhere.
- **Whisper alignment stays desktop-only** (its models are 1.6 GB + 1.2 GB); phone
  lyrics are LRCLIB lines + the ~12 chars/sec word estimate, exactly like an unaligned
  desktop song.

## Feasibility verdicts

| Capability | Verdict | Why |
|---|---|---|
| Six-stem split on-device | Feasible — CPU/XNNPACK (Android), CPU + optional CoreML EP (iOS) | The desktop ONNX engine reduces to one fixed-shape graph (`htdemucs_6s_fp16weights.onnx`, 136.4 MB, input `(1,2,343980)` f32 @44.1 k = 7.8 s segments, 25 % triangular overlap-add, no shifts) + ~500 lines of array bookkeeping. Est. 5–30 min/song CPU by device tier (iPhone-Pro CoreML est. 3–6 min), ~2–2.5 GB peak RAM |
| Beat grid (homegrown v21) | Feasible, code-identical | `detectBeats` + courts are dependency-free TS that already run in plain Node (the eval harness esbuild-bundles them) |
| Beat This! ML lattice | Feasible, parity with desktop ONNX packs | The packs already ship `beat_this.onnx` (82.5 MB) + `logmel.onnx` (4.5 MB); `scripts/beat_runner_onnx.py` (192 lines of numpy) is the port spec. `aux.ml` stays optional — a no-ml grid at the current stamp is a packless desktop, already legitimate |
| Melody (pYIN) | Feasible, code-identical | Pure TS, ~1.8 GFLOP per 4-min song, runs on the vocals stem |
| Lyrics | LRCLIB yes; whisper align no | LRCLIB is plain HTTPS TS; align model sizes are desktop-class |
| Publish to Drive | Feasible; **desktop must change first** | `drive.file` + the shared OAuth client already permit phone writes — but the desktop root reconcile trashes unknown SingZ-root folders (see below) |

## What the exploration established (the facts the design leans on)

- **The ONNX splitter is portable by construction.** `src/main/separation.ts`'s ONNX
  flavor is the PyPI package `demucs-onnx` 0.3.4 (StemSplit, MIT; models on HF
  `StemSplitio/htdemucs-6s-onnx`); its own keywords advertise Android/iOS ORT targets.
  Fixed-shape graph, fp16-stored/fp32-computed weights, chunk loop + triangular
  overlap-add, soxr/soundfile only for IO. onnxruntime 1.23.2. Desktop feeds pack
  engines a renderer-rendered 44.1 k stereo int16 WAV (`needsPcm`) — the phone
  mirrors that contract with a native decode step.
- **Beat detection needs no porting, only a host.** `analysis.ts` (2791 lines) +
  `courts.ts` (1514) + `beat.ts` (399): zero npm deps, no FFT library (Goertzel +
  time-domain envelopes + autocorrelation), pins itself to 44.1 k mono internally
  (`monoAt44k`), and runs in plain Node today (`eval/beats/run-current.mjs` proves a
  6-line duck-typed AudioBuffer suffices). It hard-requires the drums stem — beat
  grids are a **post-split** feature on every platform, including the desktop.
- **The ML lattice ships in the packs already**; `beat_runner_onnx.py` documents the
  full chain (reflect-pad framing 1024/441 → `logmel.onnx` → 1500-frame chunks with
  6-frame borders, keep_first overlap → 7-wide max-filter peak pick → downbeat→beat
  snap → one JSON line). Desktop's model input is a 22.05 k mono OfflineAudioContext
  sum of all loaded stems (`fetchMlGrid`, App.tsx:1545).
- **Melody**: pure-TS pYIN in a Web Worker (`pyin.ts` + `pitch.worker.ts`);
  `PITCH_DETECT_VERSION = 1`; ~20 kB encoded per song. The **mobile player reads no
  melody at all** and `settings.beat` is optional — a phone project is playable with
  zero analyses, which is what makes staged shipping work.
- **Project contract**: only `settings.beat` + `settings.melody` are stored analyses;
  project.json is written **last** (the doc names every file); `stemHashes`
  {md5,size,mtimeMs} per stems/ file + `lyricsHash`. Desktop `saveProject` keeps the
  original as `song.<ext>` and desktop `listProjects` **skips a project whose songFile
  is missing** — a phone writer must keep the imported original. Top-level orphan
  *files* on Drive are left alone by sync (`sync-plan.ts:121`); only unknown root
  *folders* and unknown files under `stems/` get trashed.
- **The mobile app is closer than expected.** Decode for playback already covers
  wav/flac/mp3/ogg (miniaudio) + m4a/aac (FFmpeg .so's in the APK). The library's
  "This phone" mode (Android `getExternalFilesDir/SingZ projects`, iOS `Documents/`)
  lists any folder containing project.json — phone-created projects appear with zero
  new listing code. `loadProject` filters stems by presence and appends validated
  `customTracks()` lanes, so an unsplit import plays as one custom lane. What's
  missing is plumbing: FolderAccess has **no write API**, no single-file picker; the
  phone Drive client is GET-only.
- **The sync danger is real and specific**: `src/main/gdrive.ts` root reconcile
  (~:598–626) trashes any SingZ-root Drive folder whose name is not a local library
  dir — on launch and 4 s after every save. A phone upload into the shared root today
  would be trashed by the next desktop sync. Publish therefore requires a desktop-side
  **adoption** pass (sequenced last; design below).
- **Memory rules that bind the design**: decoded stems ≈138 MB/min of song;
  `MAX_DECODED_BYTES` 1.25 GB projection guard; `AudioBuffer.release()` (audio-api
  patch 4) after use; analysis must go stem-at-a-time and never stack on a loaded
  song.

## Web research (verified 2026-08-14; July 2026 sweep re-confirmed)

- **No subprocesses on mobile, ever** — engines must be linked libraries; model packs
  become weights-only downloads.
- On-device htdemucs: ~2–2.5 GB peak RAM; hard floor ≈ iPhone 12/A14 and 8 GB-class
  Androids. M4 Pro CPU ≈ 1.6 s per 7.8 s segment → phones est. 4–30 min/song by tier.
- ORT: Android = stock `onnxruntime-android` Maven AAR with XNNPACK EP (NNAPI
  deprecated, Vulkan still flaky → CPU path); iOS = official `onnxruntime-c` /
  `onnxruntime-objc` pods, CoreML EP available with CPU fallback.
- Long jobs: Android foreground service (`mediaProcessing` API 35+, `dataSync`
  29–34); iOS 26 `BGContinuedProcessingTask` (user-initiated, survives screen-off,
  wants streamed progress — per-segment progress fits), pre-26 = keep foreground.
- Analysis JS hosts: Hermes has no JIT (est. 10–30× slower than V8) on both
  platforms; a hidden WebView has JIT on both (Android System WebView = V8; iOS
  WKWebView = JavaScriptCore, full WebAudio incl. OfflineAudioContext since 14.5).
- Landscape: MonoBand ships 6-stem on-device separation on Android (the UX is
  shippable); sevagh's demucs-android is **GPL-3.0 and archived — reference only,
  never vendor**; mosynthkey/beat_this_cpp (MIT) proves the Beat This chain runs
  without Python.

## Architecture

One shared C++ core (`mobile/native/core/`) does the heavy compute on both platforms:

- `split_engine` — segmentation, mix normalization, ORT session, 25 % triangular
  overlap-add, **streamed** stem output (six `stems/<name>.wav.part` appended after
  each segment; persisted overlap tail + `job.json{segIndex}` make resume possible;
  RAM outside ORT stays <150 MB).
- `beat_this` — the `beat_runner_onnx.py` port, same JSON contract, written to the
  job dir. Input = stems summed at 44.1 k mono + half-band decimate ×2 → 22 050.
- `resample` (rational polyphase windowed-sinc, SNR-tested), `wav` writer,
  `flac_enc` (vendored libFLAC — one encoder on both platforms; decode-back verify
  before any WAV is deleted, per-stem WAV fallback keeps v1 semantics),
  `ort_env` (EP ladder: XNNPACK/CPU Android, CoreML→CPU iOS with a per-device
  disable marker like desktop's `dml-disabled.json`), `progress.h` (C callback +
  atomic cancel; chunk-pace watchdog — first segment 5 min, then 8× rolling median).

Bindings: Android — CMake under `mobile/android/app/src/main/cpp/` + a thin JNI
driver, `externalNativeBuild` in `:app`, ORT from the Maven AAR; the job runs in a
foreground service in an **isolated `:split` process** (lmkd can kill it without
taking the UI; `START_NOT_STICKY`). iOS — local pod `mobile/ios/SingzCore/` (podspec
globs `../native/core`, the FolderAccess/patch-3 local-pod pattern; re-run pod install
after file drops), ObjC++ wrapper; the job runs in-process under
`BGContinuedProcessingTask` (iOS 26+) or foregrounded pre-26; **split refuses to start
while a song is loaded** (jetsam headroom). Platform decode stays native-per-OS
(MediaExtractor/MediaCodec; AVAudioFile/ExtAudioFile), each writing the temp 44.1 k
stereo PCM mix the core consumes — the desktop `needsPcm` contract, natively.

Analysis (beats + melody + key) reuses the desktop sources **verbatim** via an esbuild
bundle (`mobile/scripts/build-analysis.mjs`, postinstall, gitignored output): the real
`detectBeats`/`BEAT_DETECT_VERSION`, `encodeMelody`/`melodyFitsSong`/
`PITCH_DETECT_VERSION`, and `trackMelodyCore` from the extracted
`src/renderer/src/audio/pitch-core.ts` (the worker is now a thin envelope — identical
math, no version bump, locked by an output-equality test). Version stamps ride in the
bundle, so the phone can never stamp a stale constant; a phone no-ml grid at the
current stamp is the same legitimate state as a packless desktop. The JS host is
chosen by the Phase-0 spike behind one interface (`mobile/src/analysis/host.ts`):
Hermes-on-worklets-runtime vs hidden WebView. **Decision rule, fixed before
measuring**: Hermes wins only if melody+beats on a 4-min song take ≤ 120 s on a
mid-range Android AND its grids match the Node baseline exactly on ≥ 10 eval-library
songs; otherwise WebView (JIT on both platforms).

Pipeline invariants are ported, not approximated (`mobile/src/analysis/pipeline.ts`):
jobSeq captured per job; results land by re-read → merge → write of the **target
dir's** project.json with the desktop keep-rule (absent never deletes existing
analyses); `melodyFitsSong` re-checked against the dir's stems before writing;
re-analysis triggers mirror the desktop (missing, or `source:'auto'` with a stale
`detVersion`); lyrics run before beats so `lineStarts`/`words` exist for the courts.

Models are **pinned-tag GitHub release assets** (the `models-1` precedent — never
`latest/download`): tag `phone-models-1` with the three raw .onnx files
(136.4 + 82.5 + 4.5 MB), Range-resumable, sha256-verified, stored durably
(`filesDir/models` / iOS Application Support, backup-excluded).
`mobile/src/analysis/models.ts` pins the tag + size/sha table (the
`PACK_FORMAT_REQUIRED` role). The split model is required; the beat models are a
skippable "better beats" extra. Releases must stay public (existing invariant).

Project writing: phone projects are ordinary folders in the "This phone" root. New
FolderAccess methods with the identical-JS-surface rule (Kotlin + Swift):
`pickAudioFile`, `writeText`, `ensureProjectDir`, `moveIntoProject`, `statFile`,
`deleteProject`, `readMediaTags`, `downloadFile`. `mobile/src/writer.ts` mirrors
desktop `saveProject` ordering (stems → lyrics.json → project.json last), keeps the
original as `song.<ext>` AND as a `stems/custom-original.<ext>` lane so the unsplit
project plays; the split phase removes that lane when the six stems land. Docs are v1
WAV until the FLAC phase, then v2.

Publish + adoption (last): the desktop gains an adoption pass **before** the
reconcile — a remote root folder that is not local and **not named in the previous
`catalog.json`** was added by a phone → download it into the library (name collision →
" (phone)" suffix), `allowRoot`, mark dirty; a folder named in the previous catalog
but missing locally was deleted on the desktop → trash, today's semantics.
catalog.json bumps to format 3 with `capabilities:{adopt:1}`; phones enable Publish
only when they see it (old phones fall back to folder-walking, old desktops keep
working). The phone uploads project.json last and never writes catalog.json. Phone
edits of desktop-owned/published projects stay blocked with honest copy — desktop
sync is local-is-truth with no merge protocol, and inventing one is out of scope.

## Phases

0. **Spike + rig** (this phase): pitch-core extraction + equality test; analysis
   bundle + node smoke; compare-grids tool; C++ core skeleton compiling on both
   builds; ORT smoke on real devices; host measurement. Exit criteria below.
1. **Add a song — import + play + lyrics** (no split; the first shipped milestone).
   Sibling if time: "Add a track" (custom lane) to phone-local projects.
2. **On-device six-stem split, Android** (service, models, progress/cancel/resume,
   capability gate, stem-correlation fixture vs desktop ≥ 0.999).
3. **Split on iOS** (pod wiring, BGContinuedProcessingTask, CoreML EP with fallback
   marker, jetsam observation run).
4. **Beats + melody on-device, both platforms** (host per spike, C++ beat_this,
   stamps + parity eval over ≥ 10 songs).
5. **FLAC storage (v2) + phone-side upgrade** (~256 → ~65 MB per song).
6. **Publish to Drive + desktop adoption** (desktop half releases first; roundtrip
   suite is the contract).

Per-phase verification lives in the plan and lands in tests as each phase is built:
mobile jest + `tests/shared/fake-native-cache.ts` extensions, a new
`tests/roundtrip/phone-to-desktop.test.ts`, Kotlin/C++ unit tests in the CI canary,
and device passes driven by adb/simctl **polling files or `singz.crumb` — never
CDP-eval during decode** (the Hermes-inspector segfault rule).

## Phase-0 spike exit criteria (fixed before measuring)

- **JS host**: Hermes wins only if melody+beats for a 4-min song ≤ 120 s on the
  mid-range Android AND grids byte-match the Node baseline on ≥ 10 library songs;
  otherwise WebView.
- **Split viability**: mid-range Android ≤ 45 s/segment (≈ ≤ 30 min per 4-min song)
  to count as "supported"; above that, the device-floor copy calls it
  flagship-recommended.
- **iOS EP**: CoreML EP adopted only if it beats CPU by ≥ 1.5× on the same segments
  with max-abs stem diff within fp16 noise; otherwise CPU-only with the marker
  mechanism ready.
- **Numbers measured 2026-08-14** (POCO 23049PCD8G — X6 Pro class, 12 GB,
  Dimensity 8300, Android 15 — the fleet-class device; via the `.spike`
  side-install + `__test.ortProbe`/`__test.analysisSpike` over CDP):
  - **htdemucs_6s one (1,2,343980) segment: 4.71 s CPU** (session load 10.7 s
    once) → a 4-min song ≈ 41 segments ≈ **3.2 min split**. The ≤45 s/segment
    viability bar passes with a 10× margin; the July 10–30 min estimate was
    far too pessimistic for this hardware class.
  - **beat_this.onnx one 1500-frame chunk: 1.63 s** (load 0.45 s);
    logmel is sub-ms per call → ML beat lattice ≈ 13 s per 4-min song.
  - **Hermes analysis (3-min synthetic): melody 64.2 s + beats 1.3 s ≈ 65 s**
    (V8 baseline on the same M2-class silicon: 1.63 s + 0.09 s — Hermes is
    ~39×/14× slower) → a 4-min song ≈ 87 s, **under the 120 s bar**, and
    **parity is bit-perfect**: all 350 beats, 87 downbeats and 7 187 f0
    frames identical to the Node baseline. Hermes is winning the host rule;
    the WebView fallback stays designed-but-unbuilt.
  - ORT AAR = onnxruntime 1.23.2, legacy layout, all four ABIs
    (libonnxruntime.so ≈ 19 MB arm64).
  - **iOS simulator (iPhone 16 Pro sim on the M2, 2026-08-14)** — the full
    Phase-0 pass runs there too: SingzCore pod executes all three graphs
    (logmel 1.2 ms/run; beat_this 30 s chunk 0.58 s; htdemucs_6s segment
    **1.82 s**, load 3.2 s — M2 silicon ≈ desktop-class, so this brackets the
    real-iPhone number, it does not replace it), and the Hermes spike is
    **bit-perfect against the same baseline** (melody 57.9 s + beats 1.1 s,
    350 beats / 7 187 f0 frames identical). Three runtimes now agree exactly:
    node/V8, Android Hermes, iOS Hermes. The sim run also caught a REAL core
    bug the phone had survived on allocator luck — a use-after-free chaining
    `GetInputTypeInfo(0).GetTensorTypeAndShapeInfo()` off the temporary
    (SIGSEGV in GetDimensions; fixed in ort_env.cpp, both platforms rebuilt).
  - **Phase-2 engine proof (2026-08-14 late)**: the C++ `split_engine` (the
    faithful `demucs_onnx` driver port, streaming commit + resume tail) split
    the 40.8 s sample mix ON-DEVICE (6 GB emulator) in **35 s, 7/7 chunks**,
    and the six stems correlate against the desktop ONNX pack's own split of
    the same mix at **1.000000 with max abs diff ≤ 2 int16 LSBs** on every
    audible stem (the near-silent vocals lane passes the silent-stem rule —
    Pearson floors on ±1 LSB dither below −60 dB; gate on sample closeness
    there). Reference = the extracted darwin-x64 pack python under Rosetta.
    Also measured en route: a **2 GB** device cannot hold the session — lmkd
    killed the app at 1.27 GB RSS ("low on swap and thrashing"), which is the
    `:split`-isolation rationale observed live; the AVD runs at 6 GB now.
    **Resume proven the hard way**: force-killed mid-split after one committed
    stride (tail.bin persisted, stems flushed to the kernel first), resumed
    from the tail alone (job.json is a hint, never arithmetic), and the
    resumed run's stems pass the same gate with identical numbers.
  - **Phase-2 service proof (2026-08-14 night)**: the production Android path
    is live — `AudioDecode` (MediaExtractor/MediaCodec → raw f32 stereo),
    `JobStore` (atomic + fsynced job.json, the cross-process truth),
    `SplitService` (foreground service in its own `:split` process:
    mediaProcessing type on 35+, dataSync 29–34, typeless below;
    START_NOT_STICKY; silent progress notification with chunk count, ETA and
    Cancel; Messenger → DeviceEventEmitter progress; chunk-pace watchdog =
    5 min first chunk then 8× rolling median, answered by persisting
    state=failed and killing its own process — ORT's Run() cannot be
    interrupted, the engine's tail makes it a resume). All five behaviors
    machine-verified on the emulator: **fresh file-to-stems split GATE PASS**
    (corr 1.000000, ≤ 2 LSB vs the desktop pack splitting the same file — the
    full pipeline including decode, not just the engine); **kill the :split
    process mid-split** → the player process stays alive, job.json truthfully
    says splitting 2/7; **resume** → completes, same gate, identical numbers;
    **cancel** → job dir discarded, `cancelled` event lands in JS,
    notification gone; **watchdog** (test-seam 1.5 s cap) → persisted
    "Splitting stalled — resume to try again", `:split` dead, player alive.
    The `MainApplication` boots no React Native in `:split`.
  - Decode traps paid for: (1) requesting float output via KEY_PCM_ENCODING
    makes the raw WAV decoder ECHO "float" in its output format while
    emitting 16-bit samples — half the frames, all noise; configure with the
    UNTOUCHED track format and a first-buffer plausibility guard turns any
    remaining mislabel into an honest error. (2) An f32 WAV whose samples
    exceed ±1.0 (our ffmpeg-summed test mix peaked at 1.98) clips in the
    platform's s16 path — every big diff sat exactly at |x| > 0.999, the
    rest was 1-LSB quantization. Real user files are mastered in-range, and
    the desktop's own `needsPcm` render feeds pack engines int16 WAV, so the
    phone's s16 decode is full parity with the desktop pipeline — the gate
    mix is now PCM16 (−6 dB) so both sides read byte-identical samples.
    (3) A ServiceConnection to a killed process leaves `bound` stale — a
    later bindService no-ops and the next job runs silent; rebind fresh on
    every start and drop the binding in onServiceDisconnected/onBindingDied.
    (4) The app process must not call SingzCore externals it never loaded —
    an UnsatisfiedLinkError before the cancel intent once ate the cancel.
  - **Phase-2 models slice (2026-08-15 small hours)**: model distribution is
    live — `mobile/src/analysis/models.ts` pins tag `phone-models-1` with a
    size+sha256 table (the PACK_FORMAT_REQUIRED role: a model revision is a
    NEW tag stamped there, never a re-upload), FolderAccess gained
    `downloadFile`/`cancelDownload` on BOTH platforms (Range-resume into
    durable app storage — filesDir/models / Application Support/models
    backup-excluded — sha256-verified before the rename, .part kept on
    cancel, sha memoized size+mtime like the md5s), and
    `scripts/build-phone-models.sh` verifies real files against the TS table
    and stages the `gh release create` command — publishing is a human act.
    Capability gate: `splitCapability` at MIN_SPLIT_MEM_MB = 5000 (the
    1.27 GB-RSS session with honest "add the song on your computer" copy
    below it; unknown readings pass — :split isolation makes a wrong yes a
    failed job, never a dead player). Machine-verified on the emulator, all
    four behaviors: fresh 136 MB download (one GET, progress events, sha
    pass); second call answered by the FILE with zero network; cancel mid
    body keeps the .part and the resume request carried `Range=bytes=
    37756928-` — the exact part size (a throttled local server logging every
    Range header is the oracle); a wrong-sha download rejected "arrived
    damaged" with nothing installed. Trap: qemu's 10.0.2.2 NAT moves
    ~330 KB/s — `adb reverse` for anything sized; and a download driver must
    assert on the server's log, not on flags the JS surface deliberately
    does not expose.
  - **Phase-2 adoption + UI slice (2026-08-15)**: the loop is closed — a song
    added on the phone splits and becomes a six-lane project with no desktop
    involved. `mobile/src/split/adopt.ts` (dependency-injected, jest-covered)
    is the writer rule applied to a finished job: six stems move out of the
    job dir (`moveIntoProject` now owns filesDir/split-job as a source),
    stemHashes learns them, the custom-original lane leaves settings AND the
    hashes, project.json is written LAST, only then does the lane file die
    and the job dir clear — and every step tolerates a crashed earlier
    attempt (a stem already moved counts as moved; the whole thing
    converges). `flow.ts` wraps gate → model → service kick and the
    two-dead-resumes rule (failure counter keyed by src + job updatedAtMs so
    one failure counts once). The catalog card is a viewer over job.json +
    the event stream: model download with MB progress, Reading/Warming/
    chunk-of-N with a bar, Cancel, Finishing up, and a failed card with
    Resume/Discard that switches to the honest add-it-on-the-desktop copy at
    two failures. `audibleStems` is ported into loadProject (sampled RMS <
    0.004 hides guitar/piano, dropped buffers released on the spot — the
    GC-is-too-late rule). Machine-verified end to end on the emulator
    (full-flow driver, all through the SAME code path the card drives): add
    → split → adoption rewrote the doc (six rows, no custom-original
    anywhere) → reopen shows 6 lanes (persisted-log oracle, no CDP during
    the app decode) → THEN kill :split AND the app mid-split → relaunch →
    the card reconstructs from the file alone, flips to "The split was
    interrupted" → Resume → completes from the tail → adoption again,
    identical doc. Card + notification visuals screenshot-checked.
  - Liveness lesson: a relaunch seconds after a kill sees FRESH job
    timestamps and would show a running card forever. The pulse must ride a
    CLOCK, never engine callbacks — a chunk can outlast any callback
    cadence (5 min first-chunk budget, 8× median after), and a file that
    only moves on callbacks freezes mid-chunk on a healthy job. The service
    runs a self-rescheduling 5 s handler calling JobStore.touch (read+write
    in one lock hold, active states only), and the app polls while the card
    claims "running": frozen past 90 s = the :split process is genuinely
    dead. The watchdog can only vouch for a process that is alive; the
    file's pulse is the cross-process truth.
  - Still to measure: the 10-song real-stem parity eval (closes the host rule
    formally), sustained multi-segment peak RSS on real fleet hardware,
    real-iPhone CPU-vs-CoreML segment times, `zipalign -c -P 16` on the
    packaged APK.

## Top risks

- **RAM peak** (~2–2.5 GB) on 6–8 GB devices → `:split` isolation + streaming +
  resume + capability gate on Android; on iOS jetsam is the top risk (no process
  isolation): streaming core, split-only-when-unloaded, device floor, observation run.
- **Mid-range split time** (est. 10–30 min/song CPU) → per-segment ETA in the
  notification, watchdog at 8× rolling median, Phase-0 criterion decides the
  supported-device copy; iOS CoreML with CPU fallback + disable marker.
- **Hermes speed/float parity** → spike with the pre-written rule; WebView fallback
  fully designed; host swap contained behind one interface.
- **Stamp divergence** (a phone grid at the current version becomes canonical for
  that project) → parity eval quantifies it; precedent accepts it (packless-desktop
  and hand-tapped grids are canonical today); real drift flips the host choice.
- **C++ build surface** (CMake in :app + local pod + JNI/ObjC++ shims) → the repo
  already vendors C++ into both build systems (audio-api patch 3) with ccache
  conventions for both; the core depends only on ORT + libFLAC; CI compiles both.
- **App size** (ORT ≈ +15–20 MB/ABI on a 166 MB universal APK) → measure in
  Phase 2/3; options: trim `reactNativeArchitectures`, AAB per-device delivery.
- **Adoption edges** (collisions, mid-sync publish, stale catalogs) → adoption is
  idempotent and re-runs every sync; the zero-local refusal stays; the roundtrip
  suite is the contract.

## Open unknowns (Phase 0 answers them)

Hermes-vs-WebView numbers; real segment time + RSS on the actual fleet devices and
the user's iPhone; ORT AAR header/prefab wiring + 16 KB-page compliance;
`onnxruntime-c` pod CoreML EP behavior on the fixed-shape graph; `demucs-onnx` driver
subtleties beyond segment/normalize/overlap-add (the port is written against its
site-packages source; the stem-correlation fixture is the gate); WKWebView host
memory behavior with six decoded stems.
