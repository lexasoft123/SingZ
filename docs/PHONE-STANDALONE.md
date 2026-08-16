# Phone standalone song-adding — research record & architecture

Status: **Phases 0–3 shipped (v0.16.x); Phase 4a (beats/key/melody on-device) landed; 4c (the detectors in C++, one implementation for every platform) in progress — melody done.** Researched 2026-08-14 (three codebase
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

Models are **pinned-tag GitHub release assets** (never `latest/download`):
the three raw .onnx files (136.4 + 82.5 + 4.5 MB) live in `models-1`, the
repo's one bucket of pinned model artifacts, alongside the desktop's aligner —
Range-resumable, sha256-verified, stored durably
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
    live — `mobile/src/analysis/models.ts` pins tag `models-1` with a
    size+sha256 table (the PACK_FORMAT_REQUIRED role: a model revision is a
    NEW FILE NAME stamped there, never a re-upload over an asset some phone
    already judges by its sha256), FolderAccess gained
    `downloadFile`/`cancelDownload` on BOTH platforms (Range-resume into
    durable app storage — filesDir/models / Application Support/models
    backup-excluded — sha256-verified before the rename, .part kept on
    cancel, sha memoized size+mtime like the md5s), and
    `scripts/build-phone-models.sh` verifies real files against the TS table
    and stages the `gh release upload` command (upload, never create: the tag
    already exists and is shared) — publishing is a human act.
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
  - **Phase-2 test slice (2026-08-15, closes P2)**: the permanent suite is
    `mobile/tests/split-android.cjs` — fifteen checks over the whole surface:
    the product loop (add → split → adoption's four contracts → a
    fixture-free reconstruction gate, sum-of-stems vs the source at
    corr ≥ 0.97 — measured 0.9993 on the solo-vocal seed — so the suite
    needs no desktop reference; the LSB-parity gate stays a manual tool),
    audibleStems asserted for real (the solo-vocal seed leaves guitar/piano
    silent → 4 lanes + the hidden-lane log lines), kill-both → interrupted
    card → resume → adoption, cancel, the watchdog seam, the DONE handoff
    (main process killed at chunk N−1 — `am force-stop` is PACKAGE-wide and
    would take :split down too, measured; `run-as kill -9 <main pid>` is
    the per-process kill — service finishes alone, next launch adopts), and
    the duration-less ADTS decode. Host-side C++ tests
    (tests/native/core_host_tests.cpp, run by the Android CI canary on every
    mobile push, no NDK): resampler SNR MEASURED at 110 dB with unity
    passband gain and streamed==one-shot bit-exactness (a quarter-sample
    delay error in the harness reads as 37 dB — fit quadrature, never guess
    group delay), and the WAV writer's byte contract including the desktop
    renderer's asymmetric clamp (−32768 floor). JobStore's contract is
    JVM-tested (round-trip, atomicity, touch pulses only active states) and
    rides the canary's existing gradle step. open-close-memory.cjs re-run
    green on the iOS sim — which doubles as the runtime proof of the
    splitAvailable mount guard (the catalog booted the split-era JS on a
    build with no split natives). Driver lessons: the second addSongFrom
    argument is a FILE name — extension-less silently defaults song.<ext>
    to .mp3; every add CONSUMES its import (the flow moves it), so each add
    re-seeds; riding to the DONE state races live adoption (it exists for
    under a poll interval) — leave at chunk N−1 and kill instead.
  - **Real-device pass (POCO X6 Pro / Dimensity 8300 / 12 GB / HyperOS
    Android 15, 2026-08-15, spike build, phone fully restored after)**: the
    whole product loop ran on the phone — add, split, adoption. Numbers:
    **44.1 s kick-to-done for the 40.8 s sample** (decode + resample +
    session load + 7 chunks), steady chunk pace **4.0–5.1 s** (squarely the
    P0 spike's 4.71 s/segment), **adoption 339 ms**; projection ≈ **3.3 min
    for a 4-minute song**. Peak `:split` PSS ≈ **4.4 GB** on the 12 GB
    device — ORT sizes its arenas to what is free (the same session held
    1.3 GB on the 6 GB emulator), so the 5 GB capability floor stands and
    the process isolation earns its keep on big devices too.
  - **The device lesson (cost the first run)**: Android 15 refuses a
    `mediaProcessing` FGS start while the app is not VISIBLE — with the
    screen off, `:split` died at startForeground before writing job.json,
    no event reached the app, and the card showed "Starting…" until the
    liveness poll quietly cleared it. A real user always taps Split with
    the screen on, so the product path is safe; the failure itself is now
    honest, from both ends. `SplitService` catches whatever
    `startForeground` throws (`refuseStart`): it persists a FAILED
    job.json — "The split couldn't start — keep the screen on and try again
    (<the system's reason>)", keeping a resume's tail so the next Resume
    still resumes — waits 1.5 s for the app's MSG_REGISTER (a binder round
    trip behind the start) so the state event lands, then `stopSelf(startId)`;
    the same record is written for an engine that will not load, which
    used to reach the app as "failed" with no file to show. And the
    catalog's liveness poll no longer clears a card it never heard from:
    the run state carries `started` (false from the kick until the first
    event or job.json), and no file + `started === false` (+ no Cancel
    pressed) becomes "The split never started — try again", which covers a
    service that is never even created (the HyperOS empty shell below).
    Guarded by `mobile/tests/split-refused-android.cjs`, which reproduces
    both on stock Android without a phone: "Restricted" battery + an idle
    uid make the system drop the start silently (`Background start not
    allowed`, no process — the never-started card 12 s after wake); and a
    3 s `media_processing_fgs_timeout_duration` lets the system's own
    onTimeout end one split, after which the next `startForeground` throws
    the REAL `ForegroundServiceStartNotAllowedException` ("Time limit
    already exhausted for foreground service type mediaProcessing") from
    the same call the phone refused — the card showed the refusal 3.0 s
    after Resume, by event. Stock Android 16 allows the screen-off start
    itself (top-sleeping activity, visibility grace), so the device recipe
    is kept in the suite as an observation, not a repro. Device-driver rules: keep the screen on
    (`stay_on_while_plugged_in 3`) and the app foregrounded for every
    service start; MIUI additionally re-disables Install-via-USB
    periodically (INSTALL_FAILED_USER_RESTRICTED with a phone-side
    notification recording the block), and HyperOS may keep an
    IMPORTANCE_LOW notification out of sight entirely — verify the split
    notification's visibility on the fleet's Xiaomi devices before release.
  - **A production song on the POCO (Mein Teil, 4:32 / 320 kbps MP3,
    2026-08-15)**: the engine split it in **242 s — faster than the song
    plays** (0.89× realtime). 47 chunks, median pace **4.11 s** (3.94–6.19),
    14 s to first chunk (session load + resample included), peak PSS ≈
    **4.8 GB** held steady across the whole run (grew 60 MB over 46 chunks —
    an arena, not a leak). Scaled to exactly 4 minutes of audio this is
    ~3.6 min — the 3.3-min projection held within 10 % (the median chunk
    hides a slow tail; the mean is 4.96 s). (Run driven through `runSplitDirect` — the in-process
    engine path — after the finding below blocked the service wrapper; the
    engine cost is identical, and the add itself ran on-device first: the
    272 s MP3 decoded + docced in 8 s.)
  - **HyperOS field finding (must be retested before P2 ships to the
    fleet)**: on the second install of the night, the `:split` service was
    never created — ActivityManager logged the FGS start as "Allowed",
    spawned the process, and the service-creation transaction simply never
    arrived: an empty shell with only runtime daemon threads, no
    onStartCommand, no crash, no ANR, reproduced twice. SmartPower marked
    the fresh process "invisible" 75 ms after spawn. Survived every lever:
    deviceidle whitelist, RUN_ANY_IN_BACKGROUND allow, active standby
    bucket, POST_NOTIFICATIONS granted. The SAME build's service ran fine
    earlier the same night (the 44.1 s sample pass) — prime suspect is
    MIUI's install-attribution risk flag from the blocked-install episode
    (Install-via-USB refusals) poisoning the second install. Before the
    fleet gets P2: retest the RELEASE APK on a rebooted Xiaomi. The UI half
    is done: a service that never comes up leaves no file and no event, and
    the card now says "The split never started — try again" instead of
    clearing (the `started` flag on the run state, above).
  - **Phase 3a — split on iOS (2026-08-15 morning)**: the same JS lit up
    UNTOUCHED — `splitAvailable()` started answering yes and the catalog
    card, flow, adoption and liveness logic all ran as-is; the platform work
    was one pod. `SingzSplitRunner` (ObjC++ in SingzCore) runs the job
    IN-PROCESS (iOS has no :split to isolate into): AVAudioFile decode to
    raw f32 at source rate, job.json with the Android contract byte for
    byte — atomic + F_FULLFSYNC (plain fsync lies on APFS), chunksDone as
    hint, a 5 s CLOCK heartbeat, DONE left as the durable handoff — a
    dispatch watchdog that persists the stall verdict but shoots no process
    (there is none to shoot; the wedged ORT thread rides until the user
    restarts, stated honestly), idle-timer held while a job runs, and
    `SingzSplit` grew the Kotlin-identical method surface as an
    RCTEventEmitter. Sim proof (M2, iPhone 16 Pro sim): the 40.8 s sample
    end to end in **20 s, chunk pace 1.6 s** (P0's ortProbe said 1.82);
    adoption contracts all green; **kill the APP mid-split** (in-process:
    the app IS the job) → truthful job.json → relaunch → interrupted card
    from the frozen pulse → resume → identical adoption. And the LSB gate:
    sim stems vs the desktop pack at **corr 1.000000, ≤ 2 int16 LSBs** —
    three runtimes (desktop x64, Android arm64, iOS arm64) now agree at
    the least significant bit.
  - iOS traps paid for: **AVAudioFile THROWS at EOF** ("nilError") instead
    of returning an empty buffer — loop on framePosition < length, never
    read-until-empty (measured: 1,799,280 clean frames, then a throw). And
    `simctl spawn defaults read` cannot see the app's NSUserDefaults-backed
    log from outside reliably — sim drivers poll CDP globals instead (the
    add-song.cjs precedent; the Hermes-inspector SIGSEGV was Android
    hardware, the sim tolerates global polls).
  - Review round (the gate earning its keep, four findings): (1)
    **RCTEventEmitter silently drops every event when JS subscribes via
    DeviceEventEmitter** — the module's exported addListener never runs, the
    listener count stays zero, and sendEventWithName warns-and-drops rather
    than throwing; `initWithDisabledObservation` restores the Android
    semantics. The sim pass had been BLIND to it — every checked transition
    was also reachable by polling — so the driver now asserts a live chunk
    event reaches the card mid-run, and the permanent suite must keep that
    assertion. (2) A stall verdict must LEAVE the runner busy: the wedged
    ORT thread still owns the serial work queue, and freeing the flag would
    let a mid-session Resume queue a second job behind it — worst case
    wiping six finished stems when the "stall" was merely slow. Busy until
    restart is the honest answer. (3) Watchdog timers expire while the app
    is SUSPENDED and fire on resume — a >30 s app switch read as a stall.
    The refusal signal must be a RESIGN-since-arm flag (resign always
    precedes the freeze, order-independent), never the heartbeat's stamp:
    the heartbeat is a clock proving PROCESS liveness and stamps straight
    through a wedged worker — a freshness check inverts the watchdog into
    one that fires only on false stalls (the second review round caught
    exactly that). Refuse-once-and-re-arm keeps true stalls caught one cap
    later. (4) Every job-dir deletion rides the
    same serial queue as the writers, or the heartbeat can resurrect a
    cancelled doc mid-window.
  - **Phase 3 wrap (2026-08-15): the permanent iOS suite + the background
    task.** `mobile/tests/split-ios.cjs` is split-android's sibling for the
    in-process runner: the product loop with the MANDATORY live-event
    assertion (only events paint chunk text into a live card, and iOS
    RCTEventEmitter drops events for DeviceEventEmitter subscribers unless
    observation is disabled — a polling-shaped pass is blind to exactly
    that regression), the fixture-free reconstruction gate (0.9993
    measured), kill-the-APP resume, and both watchdog paths (true stall
    fires; post-stall resume queues no second job and the healthy run
    self-heals to one adoption — asserted on job.json transitions, never
    on the card's phase). Ran green twice: on the P3a build and on the
    BG-task build. The iOS 26 `BGContinuedProcessingTask` integration:
    EXACT identifier (`com.lexasoft.singz.split` — the scheduler's wildcard
    matching is broken for continued tasks), lazy registration in the
    runner's init (continued tasks are exempt from the register-before-
    launch rule), submitted at every job start, chunk callbacks feed
    `task.progress` + `updateTitle`, expiration completes the task and
    lets ordinary suspension freeze the job — the tail resumes it; a
    submission refusal (any older iOS, the sim) degrades to exactly the
    P3a foreground behavior. Info.plist grew the `processing` background
    mode and the permitted identifier. Spelling note: the completion
    selector is `setTaskCompletedWithSuccess:` (the SDK header, not the
    Swift name). The REAL background run + the jetsam observation need the
    physical iPhone — that is the remaining P3b half.
  - Still to measure: the 10-song real-stem parity eval (closes the host rule
    formally), real-iPhone CPU-vs-CoreML segment times, the real-iPhone
    BGContinuedProcessingTask behavior + jetsam observation (P3b's device
    half), `zipalign -c -P 16` on the packaged APK, the split
    notification's visibility on HyperOS, and the `:split` service on a
    rebooted Xiaomi with a release APK (the HyperOS finding above).
  - **Phase 4a — beats, key and melody on the phone (2026-08-16)**: the
    desktop's detectors run on the phone, off the app thread, and write
    into project.json. The host rule from Phase 0 was decided for Hermes;
    the question left was WHERE in Hermes, since 65 s of pYIN cannot sit on
    the thread that draws the app. Answer: a **worklet runtime**
    (`react-native-worklets`, already a dependency of reanimated) —
    `mobile/src/analysis/host.ts` creates one runtime, once, and the
    detectors reach it as CODE: `build-analysis.mjs` now also emits
    `gen/analysis-worklet.js`, the whole desktop bundle inlined in ONE
    function carrying the `'worklet'` directive, which the worklets babel
    plugin serializes into any runtime (92 kB of source, compiled once per
    runtime by the plugin's own hash cache, module body run once by a
    global memo). No Bundle Mode switch, no app-wide change.
    - **The trap that cost the first run**: the serialized worklet is
      evaluated RAW on Hermes — plugins run before presets, so Metro's
      block-scoping transform never sees it — and Hermes has no
      per-iteration bindings for loop `let`s: measured on the sim,
      `for (let k of ['a','b','c']) fns.push(() => k)` yields `c,c,c` and
      `for (let i…)` likewise (function-scoped closures are fine). Silent
      and wrong: esbuild's own export helper is a getter closure per key in
      a for-of, so EVERY export of the bundle resolved to the last one —
      `lib.detectBeats` was `trackMelodyCore`, and the first host spike
      returned a melody where a grid was asked for. The emitter now runs
      the bundle through `@babel/plugin-transform-block-scoping` before
      inlining it; the detectors close over loop lets too, so without it
      the wrong answers would not always be that loud (CLAUDE.md gotcha).
    - **Proof (iPhone 16 Pro sim, `__test.hostSpike(3)` vs the in-thread
      `analysisSpike(3)`)**: melody 66.0 s on the worklet runtime vs 60.2 s
      in-thread, beats 1.3 s, two 8 MB stems crossed in 26 ms; **f0 7 187
      frames and 350 beats / 87 downbeats IDENTICAL** — a fourth runtime
      agreeing to the bit (node/V8, Android Hermes, iOS Hermes, and now the
      worklet Hermes); the app thread stayed **80% free** during the run
      (1 081 of an ideal 1 347 heartbeat ticks at 50 ms) where the
      in-thread run blanked the driver's polls for a minute; progress
      reached the app 29 times, thinned to 3% steps.
    - **Memory, measured**: runtimes share nothing — a Float32Array is
      copied twice on the way over (a byte vector, then a fresh
      ArrayBuffer there), so stems cross ONE AT A TIME into a store the far
      side keeps between calls (six 4-min mono stems ≈ 242 MB resident
      there, `js_externalBytes`); the far side frees lazily even with its
      `gc()` (Hades finalizes external memory on its own schedule — after a
      clear+gc it held 121/161/242 MB on successive rounds), but the PEAK
      stays bounded at one song's worth plus the lag (a second song's puts
      displaced the first's; six re-puts under one key peaked at 484 MB
      because six new landed before six old were collected). `clearStems`
      calls `gc()` when the runtime exposes it and `runtimeStats()` reads
      Hermes' own numbers for the log. Six stems at 44.1 kHz mono is the
      whole far-side budget; the near side drops each mono copy as it
      lands. Load path: `decodeAudioData(file, 44100)` → fold → `release()`
      on the spot — 44.1 kHz IS the detectors' rate, so `monoAt44k` hands
      the array straight back and the far side copies nothing more.
    - **The pipeline (`analysis/pipeline.ts`, dependency-injected, 15 jest
      cases)** is the desktop's rules ported: (re)detect when a grid is
      missing or an `auto` grid carries an older stamp, never a `manual`
      one, `userBars` re-folded with the desktop's own `applyUserBars`;
      re-track a melody with an old stamp or a length that is another
      song's (`melodyFitsSong`); re-read the key under a new stamp and
      never store the melody-histogram fallback; a detector's NEGATIVE
      answer (no grid in these drums, a silent harmonic bed) is stored under
      its stamp too — `settings.analysisNone`, phone-only, ignored by every
      reader — because the desktop's "ask again on every open" costs it a
      second on decoded buffers and would cost the phone six decodes and a
      minute behind the player, forever, for a drumless song (the review
      caught it; a newer detector asks once more, exactly like a stale
      grid); results land by re-read →
      merge → write of the doc ON DISK (a save that landed mid-run is kept),
      absent results delete nothing, and the stems the answer was computed
      from are compared against the doc's stemHashes before every write —
      a project re-split under the run drops its answer, a project deleted
      under it throws. Order beats → key → melody with a write after each
      half: the grid is what the phone plays, the melody is a minute of
      pYIN, and a kill in that minute leaves the useful half saved; before
      that minute the far side drops every stem but the vocals
      (`keepStems`), since the long stage often overlaps a player holding
      the same song decoded for playback. `analysis/run.ts` is one queue
      app-wide (the host has one stem store), collapsing duplicate asks,
      announcing results on `DeviceEventEmitter('singzAnalysis')` — a
      PARTIAL event the moment the grid is written and a final one after
      the melody — the catalog refreshes its listing on it, and the PLAYER,
      if it is showing that dir IN THE PHONE LIBRARY (a dir name is unique
      only within one library; the desktop's cloud-folder "Foo" must not
      wear the phone's "Foo" grid), sets the grid live so the metronome and
      count-in light up without a reopen. Triggers: after adoption (the split card clears, the
      analysis card takes over: "Reading the drums…", "Finding the beat…",
      "Tracking the melody · 46%") and on open of a phone-library project
      whose doc says something is missing or stale — the phone's own
      library only, never a picked folder or Drive (the desktop's to
      write). `LoadedProject` gained `dir` for the match.
    - **On the sim, end to end (a four-stem mix of the bundled sample,
      split then analysed)**: 3 s of stem reads, **beat 15 s, key 3 s,
      melody 15 s** for the 40.8 s song, all behind an open player; the
      grid came out **67 beats at 98.5 bpm, 4/4, 17 downbeats** against
      make-sample.js's authored 100 bpm 4/4 (68 beats) — the desktop's
      answer, on the phone. Two fixture facts worth knowing before reading
      a run: the solo-vocal seed has no drums, and **no drums means no
      grid**, by rule (detectBeats returns null — the suite's first
      Phase-4 pass read that as a failure); and the sample's "vocal" is
      synthetic, which the splitter routes AWAY from the vocals stem in a
      mix (vocals.wav at −83 dB RMS, `other` at −16), so its melody line
      is all-unvoiced there — stored, stamped, covering the song's length,
      exactly what the desktop would store; only the coverage is asserted.
      `mobile/tests/split-ios.cjs` §1c is the permanent proof (its own
      mix-seeded project, the stamps read off the generated bundle so a
      bumped constant cannot pass by accident, the live pickup asserted in
      the open player).
  - **Phase 4c — the detectors move into the core, one implementation for
    every platform (2026-08-16, decided at review of 4a)**: 4a's numbers on
    real stems (a four-minute song: beats ~90 s, key ~18 s, melody ~90 s of
    Hermes, ~3.3 min behind the player) made the case; the user's answer to
    "port to C++?" was "and make the desktop run the same port" — which
    removes the double-maintenance objection. Plan: port to
    `mobile/native/core`, phones first (in-process, JNI/ObjC++), then the
    desktop through a `singz-analyze` CLI spawned by main like whisper-cli
    (not WASM: main can load native code and the stems are always on disk;
    a CLI is crash-isolated, ABI-free, and the eval harness runs the same
    binary the app ships). Melody first — the smallest detector, the worst
    offender, and it stands up the whole chain.
    - **melody.cpp** = pyin.ts + pitch.ts's cmndProfile + pitch-core.ts
      (decimate, frame RMS, cleaner) ported line for line, float where the
      TS kept Float32Array (d, cmnd, probs — which ACCUMULATES in float32
      — em, binHz, the transition weights, dec, rms, cents, f0) and double
      where it kept numbers, sums in the same order, JS Math.round
      semantics (half toward +∞). **Bit-identical** to the TS: host-side,
      `singz-analyze melody` (the CLI, `mobile/native/core/tools/`) against
      node's trackMelodyCore on the sample's four stems — f0, raw AND rms
      0 differing (vocals 777 voiced frames, bass 1413); on the iPhone sim
      and the Android emulator, `__test.melodyParity` (native reads the WAV
      itself; the TS gets the phone's audio-api decode of the same file, on
      the worklet host) — 777/777, 0 differing, identical hopSec on both.
      Cost: **89 ms** for the 40.8 s vocal on the M2 (V8 330–600 ms;
      Hermes 15 s), 745 ms on the sim vs 13.5 s TS, 5.2 s on the emulator
      vs 65 s TS — a four-minute song's melody in ~1 s on a phone where it
      was ~90 s.
    - The speed came in two steps and the second is a lesson: a faithful
      port ran only ~2.5x faster than V8, because the difference function
      `sum += diff²` must round in the TS's ORDER (bit-parity forbids
      reassociation) and neither V8 nor clang can vectorize a strict-order
      chain. Running eight LAGS side by side — each lag's sum still in
      strict order — keeps every bit and lets the compiler vectorize across
      lanes: 265 → 89 ms. Parity re-verified after.
    - `wav.cpp` gained `readWavMono` (PCM 16/24/32 + float32, any channel
      count, folded exactly as the JS fold — asserted to the bit in
      tests/native/core_host_tests.cpp, which also tracks a synthetic
      phrase within 2 cents and checks the RMS gate); the split's 44.1 kHz
      PCM16 stems are what it reads on the phone. Bindings:
      `SingzSplit.analyzeMelody(path)` / `wavInfo(path)` on iOS (ObjC++,
      utility queue) and Android (JNI → one jdoubleArray: hopSec must stay
      a double, a float32 hop would round the stored value; SplitModule
      runs it on its own thread). `analysis/native.ts` wraps them; the
      pipeline's host is now COMPOSED (`deps.ts`): grid + key on the
      worklet TS, melody in the core — `AnalysisHost.trackMelody` takes a
      file locator, `audioDuration` reads the header for the melody-fit
      rule (no vocals decode in JS at all when only the melody is wanted),
      and the far side is cleared before the melody stage rather than
      keeping the vocals (`keepStems` went away with it). Post-split
      analysis of the sample on the sim: 36 s → ~3 s.
    - Not the POCO: it runs Play's 0.15.0 (installer com.android.vending,
      Play's app-signing key), so neither a debug build nor an upload-key
      release can install over it — Android refuses the signature, and the
      only way past is an uninstall that takes the library and the Drive
      sign-in with it. Its test is the next Play build + the Log panel.
      The emulator (SingZ_API36) had a RELEASE 0.16.0 on it from the FGS
      video — CLAUDE.md's "which emulator can be driven" trap, met again;
      reinstalled as debug for the parity run.
    - **The real-device number that decided what to port next (POCO's iOS
      sibling — the user's iPhone, 2026-08-16, a 5:02 song)**: the whole
      analysis pass took ~110 s — stem load 5.6 s, **beat 92.1 s**, key
      9.5 s, **melody 2.7 s**. The melody is the ported one: on this
      hardware the TS would have been ~100 s for the same song, so the port
      is ~40x, and 84% of what is left is the ONE detector still in
      TypeScript. The pass also proved the queue design on real hardware —
      the singer opened the song, left it three seconds later, and the run
      carried on and wrote its results two minutes on. (Open question from
      the same run: the grid came out 297 beats at 60.1 bpm, which on a
      rock track is usually a half-time pick. Being chased separately; the
      port is deliberately faithful to the current logic, right or wrong.)
    - **Key follows melody (2026-08-16)**: `analysis.cpp` is analysis.ts's
      `estimateKeyFromStems` + `estimateKey` + `monoAt44k` + `goertzel`,
      ported under the melody port's discipline (the same fp-contract
      pragma, float32 stores where the TS has Float32Array, jsRound). Gate:
      `eval/key-parity.mjs` — node's detector against `singz-analyze key`
      over a project's real stems — **identical on all four library
      projects and the bundled sample** (E minor, F# major, A minor, D
      major, C major), which is a stronger check than the melody's was: a
      key is one discrete answer, so agreement is not luck. Host tests
      cover the shapes with no corpus (a synthetic C-major triad bed reads
      C major; a silent bed answers nothing, which must never become a
      stored key). Bindings `SingzSplit.analyzeKey(instPaths, bassPath)` on
      both platforms; `AnalysisHost.estimateKeyFromStems` now takes file
      locators like `trackMelody`, so the key crosses nothing either — and
      with both of them off the worklet, the ONLY thing still putting stems
      across the runtime boundary is the grid's aux. **Verified on both
      devices** (the reviewer's call — every other claim in the slice was
      host-side, and a Metro-only run would have passed VACUOUSLY, since an
      app without the new binary silently takes the worklet fallback):
      rebuilt and installed, `analyzeKey` present in the binary, and
      `__test.keyParity` run against real stems — iOS sim **F major both
      ways, native 778 ms vs TS 1429 ms**; Android emulator **C major both
      ways, 2641 ms vs 5373 ms**. The iOS rebuild first hit the recorded
      CocoaPods trap (a link failure on `facebook::react::Sealable`, the
      RNGestureHandler family named in CLAUDE.md) — `rm -rf Pods && pod
      install` cleared it, exactly as written down; it was not the port.
    - Three review findings worth keeping, all mine to have avoided: the
      pipeline refactor took the key's stems OUT of the stems-changed guard
      (they no longer pass through `put()`, so a key-only run compared an
      empty list against an empty list and could never fail — a key
      computed from replaced stems would have been stored under the current
      stamp and never re-asked); the Android JNI returned the same empty
      array for "silent bed" and "cannot read this file", so an unreadable
      stem would have been recorded as the permanent verdict "this song has
      no key" while iOS rejected on the same input; and holding every
      converted stem through the goertzel pass cost ~1.8x the TS path's
      peak, on a queue that may run beside a player — each stem is now
      summed and dropped as it is converted, same element order, parity
      untouched.
    - **The beat detector begins (2026-08-16, front end only)**: this one
      is ~4300 lines across analysis.ts and courts.ts, and unlike melody
      and key it is ONE pipeline with no exported seams — a wrong grid
      cannot be bisected from its output. So the port mirrors the TS's own
      `debug` object stage for stage (it already carries tau, consistency,
      fill, octaves, reject and two dozen more, so no desktop change was
      needed), and `eval/beats-parity.mjs` compares those in pipeline order
      and names the FIRST stage that diverges. "The tempo family disagrees
      on Panzerkampf, everything before it matches" is a debuggable
      sentence; "Panzerkampf disagrees" is not.
      Landed so far: the onset front end (broadband + low-band energy,
      flux, drum peaks), the instrument fill with its 8-second drum-free
      span rule, local-mean normalisation, the windowed-autocorrelation
      tempo family, and the DP tracker's octave choice with its gates.
      **Identical on all four library projects across 12 compared stages**
      — tau 71.656 / 98.380 / 123.495 / 75.516, every fill and octave
      figure matching to the last digit. Host tests cover the shapes with
      no corpus (a 120 bpm click train is tracked at 120 and not at an
      octave of it; a sustained pad earns no metronome and says why).
      `monoAt44k` is now shared out of analysis.h rather than re-rolled
      here — the reviewer's point that the bounds and ordering discipline
      should travel with it, made before there were two callers.
      Still to port at that point: the tracker's span gates and onset snap,
      the head backcast, the downbeat votes, sanitizeBars, the ML lattice,
      and courts.ts entire.
    - **`trackFromDrums` closes (2026-08-16, same day)**: the placement
      splice (re-track on the FILLED envelope, then keep only the beats
      inside accepted fill spans — the global DP would otherwise bend the
      path across lightly-drummed verses next to a span), the per-span
      quality gate (the span's own autocorrelation must agree with the
      song's tempo family at ≥60% of windows, AND its beats must stay
      steady after snapping to real onsets — the DP grid is smooth by
      construction, snapping is what exposes free-time playing), the onset
      snap, and the void list. The whole drums-first tracker is now in the
      core.
      **23 of 23 stages identical on all four library projects — including
      `beatsSec`, the beat TIMES themselves**, compared as full-precision
      values, plus the per-span verdicts, the median interval and the void
      list. Everything downstream is built on those times, so this is the
      first slice where the comparison reaches the actual product of the
      detector rather than its intermediates.
      Two harness lessons. `debug.voids` is ROUNDED to 0.1 s by the TS
      before recording, so the comparison rounds the C++ the same way
      instead of pretending the debug channel carries full precision — and
      that costs nothing, because the span FRAMES those seconds are derived
      from are compared as exact integers one stage earlier.
      And a claim of mine that was simply FALSE, caught at review: I wrote
      that "nothing between the tracker and the return moves a beat TIME —
      the downbeat machinery only chooses a phase". `applyCourts` runs
      whenever there are harmonic stems, and its octave court needs no ML
      model: a HALVE rewrites the lattice outright, and then fires a second
      `backcastHead`, which is itself called unconditionally. So the
      lattice stages are now gated on the TS's own debug — and the test is
      POSITIVE ("the courts abstained and no backcast happened") rather
      than a list of the downstream actions believed to move times, because
      enumerating those means being right about every branch of 1500
      un-ported lines and being wrong is silent. When the gate closes, the
      harness names the reason through its NOT PORTED channel.
      A probe then corrected the reviewer and me both, twice over. First:
      on all four projects the courts **abstain** rather than
      run-and-decline — and structurally, not by luck. `buildCourtEvidence`
      fills its chord runs only when a BASS stem is present (it is what
      names the roots), and the harness deliberately passes the fill stems
      only, so the runs are empty for every song and applyCourts abstains.
      More inst stems change nothing; adding bass flips it from none to
      many in one step, which is the thing to remember when the aux widens.
      Second, and the same lesson as the spanOk bug one round earlier: my
      backcast probe read `debug.headBackcast !== undefined`, which detects
      an ACTION, not a decline — and `backcastHead` can rebuild the lattice
      WITHOUT writing that field. The probe now names the three ways it
      declines and closes the gate on any shape it does not recognise;
      measured, all four projects report `{verdict: 'head ok'}`.
      An absent field is not evidence: that is now twice in one file, and
      worth carrying into the slices after it.
      Worth stating plainly: 23/23 proves the tracker, not the machinery
      after it.
    - **A test-harness trap worth the line it cost**: the core host tests'
      `CHECK` macro declared `const bool ok = (cond)` internally, so a test
      whose own local was named `ok` expanded to `const bool ok = (ok)` —
      self-initialisation, garbage, and three green stages reported FAIL
      while the CLI and a standalone probe ran the same code correctly at
      the same moment. The macro's internal is now `check_ok_`; a macro
      that captures the caller's names is a trap for every test after it.
    - **Sixth slice — the meter and the bar lines** (2026-08-16). `barPhase`
      is whole for the no-model path: the meter test (dominant 3-beat
      periodicity means the tracked pulse is a compound song's eighth), the
      activity mask, the segments, the six-cue rotation vote per segment
      (kick / entrance / slam / bass chord changes / vocal phrase entries /
      lyric lines, at their meter-specific weights), the anchor rule, the
      slip windows with the physical-defect gate, the global harmonic-gain
      arbiter that decides whether a re-phase pays for itself, and
      `sanitizeBars`. With it the port stops producing beat times only and
      starts producing a `BeatInfo` a player can draw — which is what wiring
      was blocked on.
      **31 of 31 stages identical on all four projects**, and the answers are
      musically legible: Nothing Else Matters comes out 6/8 (ac3/ac4 = 2.61)
      at rotation 1 with 154 uniform six-beat bars — rotation 1 being exactly
      the verses-enter-after-the-bar-line the TS comment describes; Sixteen
      Tons 78 bars over four segments with one 5- and one 7-beat bar at
      section seams; WDOA 96 with one 5; Panzerkampf **none at all**, because
      its best segment scores 0.04 against an `ANCHOR_CONF` of 0.08 — a song
      whose bar structure lives in the rotation index alone is a legitimate
      result, not a failure, and the port refuses in the same place.
    - **The harness gained two inputs, and that was the point.** It had been
      passing the fill stems only. Vocals and lyric line starts engage no
      court (`buildCourtEvidence` fills its chord runs only inside
      `if (bass22)`), so they can be handed over safely — and without them
      two of the six cues would have been `uniform()` on BOTH sides, and
      their parity would have proved nothing at all. Bass is still withheld
      for exactly the reason it was before: it is the single input that flips
      `applyCourts` from abstaining to active, and 1,514 un-ported lines
      would then sit between the two sides. That is the next slice's problem,
      by design.
    - **What review caught, and the third repeat of one mistake.** The
      `downbeats` stage folded "the stage was gated off" and "this song
      legitimately has no bars" into the same `'none'`, which made its own
      `LATTICE_STAGES` skip DEAD: the skip is keyed on `undefined`, so a
      getter that can never yield `undefined` can never be skipped. Harmless
      today (all five inputs report every stage compared, so the gate was
      open throughout) and a live hazard the moment bass lands — it would
      compare the TS's absence against the C++'s real bars. The general
      shape, now worth stating as a rule: **only a stage that can actually
      yield `undefined` can be gated.** That is three times in this one file
      that an absent field was read as evidence.
      Two more: `harmParts` held a converted copy of every harmonic stem at
      once, reintroducing the exact pattern `estimateKeyFromStems`' comment
      exists to forbid (~265 MB on a five-minute song, on a queue that may
      run beside a player holding the same song), and `BeatAux::inst` was a
      `std::vector` **by value** while its own `bass`/`vocals` were pointers,
      so its single assignment deep-copied every stem again. Both fixed:
      convert-add-drop in the TS's own order (bit-identical, and
      `resampledLength` is shared for the sizing), and `inst` is a pointer
      like its neighbours. Measured after: **187 MB peak** for a four-stem
      beats run on a 2:56 song.
      And the harness was comparing each segment's CONCLUSION (rotation,
      margin) but not the six distributions it was drawn from — one cue could
      have diverged while the argmax survived, surfacing much later as a
      wrong bar line. `debug.segCues[].cues` is now a stage of its own, which
      is what takes the count to 31.
    - `goertzel` is shared out of `analysis.h` rather than re-rolled, the
      same call the reviewer made about `monoAt44k` two slices ago — the key
      detector and the chord-change cue read chroma identically, and a second
      copy is a second thing to keep bit-identical forever.
    - Next: the rest of detectBeats and courts (same method, same harness)
      — which is now the whole remaining cost of a phone analysis — then
      the desktop's `analysis:run` IPC over the CLI, then retire the TS
      detectors behind a one-release flag.
    - Left for 4b: the C++ `beat_this` port + the two beat models (the
      `ml` aux that lifts the grid to pack parity — and note that the
      negative verdict is keyed by BEAT_DETECT_VERSION alone while the
      phone's v21 has no ml aux, so when the neural grid ships on the phone
      every `analysisNone.beat === 21` recorded before it must be re-asked
      without a desktop bump: a second key or a phone-side sub-stamp), the ≥10-song real-stem
      parity eval on Android and iOS, **player + analysis measured together
      on a real phone with a ≥4-minute phone-split song** (the sim run was
      the 40 s sample; on device the far side's stems ride alongside
      ~700 MB of playback buffers for the pYIN minute — the reason for
      `keepStems`, and a number that has to be read off a phone before the
      fleet gets it), and the Android suite re-run (adoption and open now
      decode in the background at moments a driver does not control, and
      the Hermes-inspector rule about evals mid-decode applies to those
      decodes too). The phone-side re-analysis of stale desktop grids
      arriving via Drive is deliberately NOT done (desktop-owned; the
      desktop heals them itself).

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
