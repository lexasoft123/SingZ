# Phone standalone song-adding — research record & architecture

Status: **Phases 0–4 shipped (v0.16.x). Phase 4 is complete: every detector — melody, key, beats with the courts and the neural fork — runs in the C++ core on both phones, bound, wired and gated device-against-host over a corpus — the HOMEGROWN pipeline and the v20 courts, that is; the neural fork is gated per-platform on one song each and across 17 songs on the host, never over the corpus, which runs with the lattice off on both sides by design. Phase 5 (FLAC storage) is COMPLETE and device-verified 2026-08-21: the core reads FLAC on both platforms (POCO 178.1 s → 28.7 s, sim 51 s → 21.7 s, grids identical to WAV value for value), writes it (compactStem, 41.4 s for six stems on the phone), and a phone-split song compacts itself after its first analysis — with convergence proven against the killed-tail state live on the POCO and the killed-middle state under test. Phase 6 (publish to Drive) is all that remains.** Researched 2026-08-14 (three codebase
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
    - **Seventh slice — the head backcast, and the gate comes off**
      (2026-08-16). `backcastHead` is ported (~275 lines): the anchor search,
      the unsteady/missing triggers, the folded-band flux onset extractor with
      its beat-scale non-maximum suppression, the periodicity test that decides
      whether those onsets may arbitrate at all, the four honest cases, the
      backward walk with its snap, and the bar re-laying with its carried-vs-
      chord phase vote. With it the core gained `detectBeatsNoCourts` — the
      whole pipeline assembled (tracker → vote → backcast → sanitize →
      suspectAt) and named for what it still lacks, so nobody wires it
      believing the courts are in it.
      Assembling it exposed an ordering bug from the previous slice: the TS
      sanitizes AFTER the backcast, and `sanitizeBars` had been left inside
      `barPhase`. Harmless while the backcast never fired — which is exactly
      why it survived a 31/31 pass — and wrong the moment it did.
      **The lattice gate is now off.** It had been withholding `beatsSec` and
      the bars whenever the head machinery was not provably idle; the C++
      rebuilds the same head now, so the gate was hiding the one stage most
      worth comparing. What is left gating is the courts alone. All four
      library projects pass **38/38 with it open**, tau unchanged.
    - **The fixtures had to be invented, because the library cannot reach
      this code.** All four eval projects report `head ok` — their grids start
      on time and track cleanly — so a parity pass over them says nothing
      whatever about 275 lines that never executed. Two earlier attempts to
      build a triggering case failed identically: the instrument fill absorbed
      the drum-free intro every time, the grid started early, and the backcast
      was never reached. What gets past it is an intro too QUIET for the
      fill's presence test but still audible to the backcast's own onset
      picker, played in free time so the fill's span-quality gate rejects the
      span outright. Measured while building it: at intro amplitude 0.02 the
      fill still swallowed it; at 0.05 the span is rejected, the grid starts
      14 s in, `missing` fires, six free-time chords are found, 0/5 are
      periodic so they are not trusted to arbitrate, and the walk extends 24
      beats back to the first chord. `eval/beats/fixtures.mjs` generates it,
      the harness builds it on every run, and it is the first input to reach
      the stage at all.
      And because a fixture is a CLAIM that some path executed, each one
      carries a precondition checked against the TS's own debug: if a tuning
      change quietly stops it triggering, that is a hard failure, not a
      silently vacuous pass. The first version of that check was itself
      vacuous — it compared the grid against `debug.beats`, which the TS never
      writes, so it read `length > 0`. It asserts `beats[0] < 3` now, which on
      a fixture whose drums start at 14 s can only be true if the head really
      was counted backward. Verified by making the intro loud again: the
      fixture then reports `head ok` and the harness FAILS.
    - **Review found the slice's one behavioural change covered by nothing**,
      which is the finding worth keeping. Moving `sanitizeBars` after the
      backcast was the only semantic edit here — and on the corpus the
      backcast declines, while on the first fixture `downbeats` is undefined
      so the sanitize never runs at all. A regression putting it back inside
      `barPhase` would have passed 38/38.
      `head-missing-bars` answers half of that: same refused intro, but an
      accented kit (kick on 1 and 3, the one twice as heavy, snare on 2 and 4)
      so the rotation vote finds a confident anchor and the song HAS bars.
      It reaches the whole `if (bars)` re-laying block — 24 head bars laid by
      the carried phase, `headBackcast` written, 36 bars, 6 suspect marks, and
      the sanitize running over a list the backcast changed.
      **True for a slice, and no longer**: sanitizeBars finds nothing to fix on
      that list, so the two ORDERS produce the same answer there —
      `head-missing-bars` passes 38/38 against a build with the sanitize moved
      back inside `barPhase`. A third fixture, `sanitize-order`, closes it.
      Two reasons the extend case can never separate them ON THAT FIXTURE, and
      both are provable rather than merely observed — worth writing down so
      nobody hunts for a counter-example that cannot exist. The `nBeats` bound
      is EXACTLY neutral: post-backcast indices are `k - cutIdx + K` against a
      bound of `nb - cutIdx + K`, so `k - cutIdx + K < nb - cutIdx + K` iff
      `k < nb`, in extend and replace alike. And the head bars are
      sanitize-invariant by construction: `carried` and `chord` both step by
      exactly `bpb`, and the seam is `bpb` (carried) or clamped to 2..7
      (chord), so no gap the head contributes can trip either limb. Since
      backcastHead reads only `bars.length > 0`, `bars.filter(k >= cutIdx)`
      and `body[0]`, every way in runs through `bars` itself.
      **`sanitize-order`, built and measured.** The lever is the FIRST bar
      pair, and it is the merge loop's cost comparison rather than the bound:
      at `hit === 1`, dropping `db[0]` DELETES a gap outright while dropping
      `db[1]` merely merges two, so the cheap delete wins — but only while the
      pair is at the front. Let the backcast prepend head bars and the same
      pair sits in the interior, both options merge, the tie goes the other way,
      and the song's whole bar rotation lands a beat off.
      Manufacturing a defective FIRST pair takes a phase cut. Bars are laid per
      piece at `k ≡ rot (mod bpb)` (analysis.ts:1379), so a cut at beat 4 with
      rotation 3 before it and 0 after gives `[3, 4, 8, 12, …]`: one bar from
      the leading piece, then the next piece's first bar one beat later. Three
      things gate that cut, and each cost an attempt. The interval defect must
      sit at `k = 3` — `cut = k + 1` and `phasePieces` never looks at `k = 0`,
      so a defect on the first interval proposes nothing. The segment vote and
      the window vote must DISAGREE: with no bass the segment reads kick and
      slam (accent on rotation 3) while the window is 0.45 harmonic
      (chords changing on rotation 0), and agreeing cues propose nothing. And
      the cut must clear the +0.3 global harmonic test (analysis.ts:1409).
      The trap that cost the most was none of those: `harmNov` falls back to
      the BASS-only novelty unless `harmParts.length > 1` (analysis.ts:1101).
      With a single `other` and no bass, `windowRot` bails at its
      `hUsed < bpb && lUsed < 2` guard for every window, no cut is proposed at
      all, and both orders agree — the fixture was built and measured that way
      once, reading green and proving nothing. It writes `guitar.wav` as well.
      The head must also stay TRACKED, which is why the defect sits at index 3
      and not 1: `unsteady` is `off / anchor > 0.25`, so index 1 gives anchor 2
      and ratio 1/2 — unsteady, and a deliberately free-time intro can never
      have trusted onsets, so `backcastHead` returns null at analysis.ts:1870
      and nothing happens. At index 3 the anchor is 4 and the ratio is exactly
      0.25, not greater, so the extend path runs.
      Measured, correct order: `headBackcast` {added 22, carried}, `phaseCuts`
      [4], `harmGain` {plain 0, cut 0.9997}, `sanitized` {74 → 73}, downbeats
      `[1, 5, 9, 13, 17, 21]`, `downbeat` 1, 7 suspect marks. Sanitize moved
      back into `barPhase`: `[2, 6, 10, 14, 18, 22]`, `downbeat` 2, 6 suspects,
      no `sanitized` at all — the harness stops at
      `FIRST DIVERGENCE at sanitized: ts=74:73 c++=none`, exit 1, while both
      older fixtures still PASS. Six different head bar times and a different
      rotation: audible, not bookkeeping.
      The precondition pins the cut INDEX, not merely that some cut happened.
      Review found the hole, and simulating every cut index against verbatim
      `buildBars`/`sanitizeBars` sized it. Beat 4 is the only cut where the two
      orders differ at all. Every LATER BAR LINE leaves the leading piece two
      bars or more, so the short pair lands in the interior, both orders drop
      the same one, and `sanitized` still reads 74:73 with `downbeats[0]` still
      1 — silent, every time. Cuts BETWEEN bar lines fail loudly on their own:
      the leading bar sits a clear 5 beats from the next piece, so there is no
      short pair and sanitize never runs. A whole class of silent cuts is the
      exact vacuity the preconditions exist to prevent, and pinning the index
      closes it.
      No count is given on purpose. Three drafts of this paragraph carried
      three different totals — 3, then 66, then a range that assumed cuts could
      reach 268 when `phasePieces` cannot place one past its last window centre
      — because each was a sweep's bounds quoted as a population. The mechanism
      is frame-independent and the numbers were not, so the numbers went.
    - Two silent-skip paths in the anti-vacuity machinery, both closed: a
      fixture added without a `FIXTURE_PRECONDITIONS` entry used to run
      unguarded and print PASS (the harness now refuses to start, exit 2), and
      `SINGZ_NO_FIXTURES=1` dropped them while the summary still read
      "IDENTICAL" (it now says out loud that the backcast is uncovered).
      The lattice gate also became a POSITIVE test asked of the TS rather than
      resting on the absence of an `ml` key in an aux literal a few lines away
      — and the FIRST version of that test watched three fields, none of them
      the splice's own record. `debug.lattice` reads `'drums'` *during* a
      splice (the splice only runs when the ML lattice was not adopted), and
      the other two are written behind extra gates. It is one field now:
      `debug.mlLattice`, which `latticeFromMl` writes unconditionally on every
      non-null return, so its absence proves the function bailed at its own
      guard — no mlChoice, no adoption, no splice, no seams. A hedge that
      watches the wrong fields is worse than no hedge, because it reads as
      covered.
    - **What the fixtures still do NOT reach**, listed so it is not discovered
      later: the `replace` limb entire (unsteady + trusted onsets, the
      `unexplained` fraction, the refusal when onsets are junk), any run with
      `onsetsTrusted === true` and therefore all snapping, the chord-phase bar
      vote, `no stable anchor`, the two early returns, `walk: 'empty'`, the
      `body.empty()` branch, and every part at a rate other than 44.1 kHz.
    - One TS inconsistency recorded rather than silently repaired:
      `backcastHead` reads `getChannelData(0)` for inst and bass — channel
      ZERO, not the fold used everywhere else — while drums arrives folded.
      The core has only the fold, which is identical for the mono buffers the
      harness and the phone both supply and differs from the desktop
      renderer's stereo AudioBuffers. Matching the TS is this file's contract
      and the fold is the better input, so that gets reconciled once, at the
      desktop swap, deliberately.
    - **Survey before the courts slice** (2026-08-17, re-measured 2026-08-18
      after the corpus turned out to be wrong — see below). What the courts
      actually decide, measured by running the TS over the library twice: once
      with the parity harness's aux (fill stems, vocals, lyric line starts) and
      once with the same aux plus BASS, which in a no-ml configuration is what
      stops `applyCourts` abstaining (`runs.length < 8 && !ev.ml`,
      courts.ts:1500, and `runs` fills only inside `if (bass22)`). With a pack
      present `ml` alone would wake them too.
      **The library is the 17 projects under whatever `settings.json` names as
      `projectsRoot`** — currently the iCloud SingZ folder. `--library` on the
      parity harness resolves it, and every number below came from there.
      Of the 17: **15 produce a grid, 2 are refused** (Father and Son and The
      Music Of The Night, both "windows disagree on a tempo (rubato?)").

      | song | bars, no bass | with bass | edits | by route |
      |---|---|---|---|---|
      | Zeit | 163 | **82** | — | octaveCourt HALVE |
      | Wish You Were Here | 0 | **86** | — | octaveCourt HALVE |
      | Wild World | 62 | 65 | 6 | 3 break-pair, 3 cadence |
      | Sixteen Tons | 78 | 81 | 3 | 3 break-pair |
      | Turn The Page | 114 | 117 | 3 | 2 break-pair, 1 plain |
      | Soldier Of Fortune | 54 | 56 | 2 | 1 break-pair, 1 plain |
      | Mr Crowley | 109 | 109 | 1 | 1 break-pair |
      | Panzerkampf | 0 | 130 | 1 | 1 break-pair |
      | Wanted Dead Or Alive | 96 | 96 | 1 | 1 break-pair |
      | the other 6 | — | — | 0 | — |

      The route column adds to **12 break-pair + 3 cadence + 2 plain = 17**,
      which is the sentence below it. The first version of this table did not:
      it mixed route names with EVIDENCE names ("held note", "form seam") in
      one column, so it summed to 11 break-pair against a prose 12 and no
      reader could tell which was right. Route and evidence are orthogonal —
      every edit has one of each — and conflating them is how a table stops
      being checkable.

      **17 edits over the corpus: 12 by the break-pair route, 5 not** (3 by a
      cadence route, 2 plain step placement). So break-pair is still where a
      port starts, but it is 70% of the work rather than the 83% four songs
      suggested, and there is a third route the small corpus never showed at
      all.
      **`octaveCourt` is NOT idle.** It halves two songs, which is exactly
      what courts.ts's own header says it exists for ("Zeit and WYWH ship at
      exactly double their notation"). It has real regression material, so
      only `doubleCourt` needs an invented fixture.
      **`doubleCourt` is untested rather than idle** — it runs in the else
      branch of the octave verdict (courts.ts:1508) and `doubleGrid` inserts a
      midpoint between every pair, so beat times move while `oct` reads keep.
      It reports nothing here because it bails at `!ev.ml` before its debug
      line and this harness supplies no ml. That is a property of the harness
      config, not of the corpus: a Beat This! pack is installed on this
      machine, so the app's own configuration is the one still unmeasured.
    - **The corpus was wrong, and it took a claim with it.** Everything in the
      first version of this survey was measured against `~/Documents/SingZ` —
      a stale four-project copy (3 of the 4 still v1 WAV against the library's
      v2 FLAC; the decoded PCM is identical, the containers are not). The
      library copies carry whisper-ALIGNED lyrics where the stale ones have
      LRC estimates — in ALL FOUR overlapping projects, not just one:
      Nothing Else Matters 39 of 39 line starts differ, Wanted Dead Or Alive
      53 of 53, Panzerkampf 64 of 65, Sixteen Tons 32 of 32 plus a line-count
      difference. Line starts feed the vote, which is why three table rows
      moved — naming a single song made the changes look stranger than they
      are.
      The headline was the casualty: "octaveCourt is idle on the whole corpus,
      no library song exercises it, so it will need synthetic fixtures" was
      false, and it was the sentence the porting plan for that court rested
      on. Two more rows were wrong too — Nothing Else Matters is 0 → 154 bars
      with NO edits (the stale copy said 154 → 155 with one), and Wanted Dead
      Or Alive is 96 → 96 (the stale copy said 96 → 97) — and the break-pair
      statistic moved from "5 of 6" to "12 of 17" with a third route
      appearing. The table above is the re-measured one; nothing from the
      stale run survives in it.
      **The port itself was never at risk and is now far better evidenced.**
      Parity compares two implementations on whatever input it is handed, so
      the corpus could not threaten it: re-run over all 17, beats parity is
      identical on every song that produces a grid — **38/38 on 14 of the 15
      and 37/38 on Primo Victoria**, which compares one stage fewer for a
      reason not yet run down — and the two refusals are refused identically
      on both sides for the same recorded reason. Nothing diverges anywhere;
      the coverage count is what varies, and "38/38 on every song" was a
      rounding of my own results in my own favour. What the wrong corpus threatened was every DESCRIPTIVE claim
      made from it, and it took several.
    - **Where Panzerkampf's 130 bars come from** — kept, because it is still
      the sharpest thing this survey found, and because the rewrite above
      very nearly lost it. An earlier version of this section claimed the
      bars came from the VOTE, on the strength of "130 x 4 is about 515
      beats". They do not. `debug.segCues` settles it with no new
      instrumentation: with bass the song's one segment scores under
      `ANCHOR_CONF`, so no anchor is placed and the vote lays no bars at all.
      All 130 come from `meterCourt` replacing a bar-less grid with a UNIFORM
      list (`barTimes`' fallback, courts.ts:629-633).
      The supporting histogram — 126 bars of exactly 4 beats plus one 2 and
      two 3s, i.e. ceil(515/4) = 129 uniform bars minus the one inside the
      L=3 edge pair plus the two it adds — was measured on the STALE grid and
      has not been re-run. The bar count reproduces on the library (130), so
      the identification stands as an argument about a mechanism; the exact
      gap shape is not a library measurement and is not claimed as one.
      The methodological lesson from that round is what the table above now
      obeys: an approximate fit that matches two rival mechanisms is evidence
      for neither, and a count a reader can disprove by adding up the column
      above it is the wrong thing to get wrong.
      The lesson is cheap to state and was expensive here: **a corpus is an
      input like any other, and this document had no line saying which one.**
      It does now, and `--library` means nobody has to type a path they might
      get wrong.
    - **Step 0 is done** (2026-08-17). `singz-analyze beats` takes `--bass`,
      and an argument it does not recognise — or one given without a path —
      is now FATAL (exit 2) instead of falling through the loop in silence.
      That silence was the whole hazard: it would have run the TypeScript
      with a bass stem and the C++ without one.
      It also produced a cross-check of the corrected Panzerkampf finding
      from the C++ side — and the first numbers written here were themselves
      off the stale copy. On the LIBRARY Panzerkampf, with the harness's aux
      (drums + guitar/piano/other + vocals + its 65 aligned line starts), the
      C++ scores **0.015 without bass and 0.073 with**, and the rotation moves
      0 to 2. TS agrees. 0.073 is 91% of `ANCHOR_CONF` — not the comfortable
      margin the stale copy's 0.047 suggested, and on exactly the quantity
      step 1 exists to watch.
      The attribution rests on the THRESHOLD, not on a bar count: with bass
      the vote scores 0.073, under 0.08, so it places no anchor and therefore
      no bars, and the bars the TS ships must come from downstream. The count
      cannot carry it — drop the line starts and the same song scores 0.142
      and the pre-court vote lays 129 uniform bars, which is the same
      ceil(515/4) `meterCourt` would materialise. Two mechanisms, one number,
      again.
    - **Eighth slice — the chord layer** (2026-08-18). `chordRuns` is ported:
      24 maj/min templates on the summed harmonic chroma, the bass chroma
      naming the root, Viterbi with a 0.35 stay bonus. It is the function
      `buildCourtEvidence` turns into `runs`, and `runs` is the single thing
      that decides whether the courts speak at all — `applyCourts` abstains on
      `runs.length < 8 && !ev.ml` — so nothing downstream of it matters if it
      is wrong.
      Identical to the TS on every sample stem (17-18 runs each, and the count
      varies per stem so the comparison is not degenerate).
      **The gate is mutation-tested, and the first attempt was inconclusive in
      a useful way.** Perturbing `STAY` by 1e-7 relative changed nothing at
      all — the Viterbi margins are simply wider than that, which is worth
      knowing — so it proved neither that the gate works nor that it does not.
      Removing the stay bonus entirely (`STAY = 0`) makes it fail loudly and
      precisely: 17 runs against 20, first divergence named as `A@28.5x5`
      versus `A@28.5x2`. A mutation too small to change the answer is not
      evidence that a gate is live.
      **And my reading of that was still too flattering.** Review measured the
      floor properly: scaling the major emission scores by 1.001 passes every
      stem, 1.01 fails only the one with short ambiguous runs, 1.05 leaves
      three of six passing. That is ~1e-2 relative — five to fourteen orders
      coarser than the float-store (~6e-8) and reordered-dot-product (~1e-16)
      differences the porting rules exist to police. So this is a DECISION
      gate, not a value gate: it proves the decoder's structure and its tie
      rule (verified — flipping `>` to `>=` fails), while the numbers it
      decides from are gated one layer up at exact-double precision. Both
      courts.h and the harness header say so now; they had sold it as
      ulp-drift detection, which it is not.
    - **Ninth slice — the voice and form evidence** (2026-08-18).
      `vocalEvidence`, `formSeams` and `phraseSegments` are ported. With that
      the courts' whole INPUT side is native: chord runs, held notes and
      section seams are everything `buildCourtEvidence` assembles.
      `vocalEvidence` has two paths and the gate runs the one that matters:
      with aligned WORDS it grades the silence after each word against the
      beat, without them it falls back to energy segments and last-rise
      detection. The app always has words, so gating only the fallback would
      have gated the path nothing takes — the harness passes synthetic words
      and exercises the real one. Identical on every stem: 4 voice hits, and
      0-2 seams which vary per stem so the seam comparison is not degenerate.
      **The voice comparison is redundant across stems and the record should
      say so**: with words supplied, `vocalEvidence` reads only the vocals
      stem and the word list, so all six runs compute the same answer. It is
      compared, not skipped — but it is one comparison performed six times,
      not six independent ones. Seams differ per stem because they read the
      harmonic chroma too.
      One JSON trap worth the line: a final word with no successor has a
      genuinely infinite `gapSec`, and C's `%g` prints `inf`, which is not
      JSON — the harness died on it. The CLI emits `1e999`, which `JSON.parse`
      turns back into `Infinity` exactly, so the comparison sees the value the
      TS actually holds rather than a finite stand-in.
    - Next: the rest of detectBeats and courts (same method, same harness)
      — which is now the whole remaining cost of a phone analysis — then
      the desktop's `analysis:run` IPC over the CLI, then retire the TS
      detectors behind a one-release flag.
    - **4b's iOS half** (2026-08-18). `mlGrid` crosses the ObjC++ binding
      the way it crosses JNI — 22 050 Hz mono wav + models dir in, the
      desktop's own grid out, rate CHECKED rather than resampled. On the
      iPhone 16 Pro simulator: 73 beats, 18 downbeats and all 4 082
      probabilities identical to the desktop runner in 1.4 s of INFERENCE for
      a 40.8 s song (Android, rebuilt against the same core, agrees). That
      1.4 s is the BINDING's `elapsedMs` — each binding mints its own clock,
      which is exactly why the two platforms' fields are not comparable — and
      on iOS it starts after the model load; the cost table below says 2.2 s
      for the same song because it measures the caller's JS→JS wall. Same
      run, two spans — the note at `t0` in SingzSplit.mm is the standing
      warning not to mix them. Treat any single EMULATOR timing as
      indicative only: the same 40.8 s song measured 14.2, 17.6 and 26.1 s
      across runs here, so an older figure in a commit message need not
      contradict this table.
      Permanent suite: `mobile/tests/mlgrid-ios.cjs`.
      Two findings worth keeping, both of which a grid comparison is blind to:
      **(1) arity.** The method shipped taking two arguments while the hook
      and the JNI pass three; the bridge then never dispatches and the
      promise never settles — no work, no rejection, no red box. Hence the
      suite's settle DEADLINE and its native-method probe, and the CLAUDE.md
      gotcha. **(2) `%.17g` must not reach Foundation.** `NSJSONSerialization`
      is not correctly rounded on seventeen significant digits, so parsing
      `mlGridJson` back cost 49 of 2041 beat probabilities and 7 downbeat
      ones their last bit while every beat and downbeat stayed identical.
      The binding now builds its result from the core's doubles;
      `mlGridRounded` is the rounding, once, for both consumers.
      The tee ships on iOS too (same wrapper, RCTLogWarn where Android uses
      logcat) and is what settled this: the iOS logits differ from the
      recording's — real cross-platform ORT drift — and none of it reaches a
      rounded probability.
    - **What the grid COSTS** (2026-08-18). Measured per run, fresh process,
      the same audio on both. Wall is the hook's JS→JS time (model load +
      inference + marshalling); CPU is the process's own utime+stime delta;
      peak is `VmHWM` on Android — the kernel's high-water mark, which no
      sampling can miss — and 100 ms `ps` sampling on the sim, **so the iOS
      peaks are a LOWER bound and the Android ones are exact**. Read the two
      columns as the same order of magnitude, not as a difference measured
      to the megabyte.

      | | 40.8 s song | 4 min song (6× the audio) |
      |---|---|---|
      | **POCO X6 Pro wall** | **3.7 s (11× realtime)** | **14.9 s (16×)** |
      | **POCO X6 Pro CPU** | **13.0 s (≈3.5 cores)** | **55.8 s (≈3.7)** |
      | **POCO X6 Pro peak RSS** | **461 → 1147 MB (+686)** | **458 → 1269 MB (+811)** |
      | iOS sim wall | 2.2 s (19× realtime) | 6.0 s (41×) |
      | iOS sim CPU | 8.8 s (≈4 cores) | 29.8 s |
      | iOS sim peak RSS | 376 → 1035 MB (**+660**) | 311 → 1067 MB (**+756**) |
      | Android emu wall | 14.3 s (2.8× realtime) | 61.3 s (4.0×) |
      | Android emu CPU | 26.2 s (≈1.8 cores) | 114.5 s |
      | Android emu peak RSS | 442 → 1117 MB (**+675**) | 442 → 1247 MB (**+805**) |

      **The headline is that peak RSS barely tracks song length.** Six times
      the audio costs +96 MB on iOS and +130 MB on Android — the linear part
      (frames, spect, probabilities) — on top of a FIXED ~660-690 MB that is
      the ORT session and its per-chunk activations. Chunks are 1500 frames
      whatever the song is. So the memory question for the fleet is "can this
      device spare ~700-800 MB transiently", not "how long is the song", and
      it is the same order of magnitude on both platforms. Both RELEASE it,
      measured after the fact rather than assumed: the sim's process sits at
      204 MB idle having peaked at 1067, and the emulator's `VmRSS` is 473 MB
      against a `VmHWM` of 1247 — the high-water mark never falls, so it is
      `VmRSS` that says the memory came back.
      Longer songs are also CHEAPER per second — 19× → 41× realtime on the
      sim — because a 40.8 s song still pays for two padded 30 s chunks.
      Parallelism differs sharply and is NOT one number: CPU/wall is ≈4-5
      cores on the sim and ≈1.8 on the emulator, which is a property of those
      two hosts' core counts and ORT's thread pool, and among the first things
      a real device will contradict.
      **THE REAL PHONE AGREES, and that is the point of the row at the top.**
      A POCO X6 Pro (Snapdragon 7+ Gen 2, 8 cores, 11.4 GB, HyperOS/API 35)
      peaks at +686 MB for the short song and +811 MB for the 4-minute one —
      within 2% of the emulator, the other exact `VmHWM` measurement, and
      4-7% of the sim's sampled lower bound — so the fixed-cost shape is a
      property of the model and not of the host. It is the fastest REAL
      DEVICE of the three and about 4× the emulator, which is the
      like-for-like comparison; the sim's higher multiples (19×/41×) come
      from desktop-class cores, not from being a phone. With
      5.4 GB free on that device the ~800 MB transient is comfortable, and it
      returns: RSS falls back to 483 MB after the run.
      The remaining numbers are a simulator and an emulator on an M2, NOT
      phone numbers; what they establish is the shape (fixed-cost-dominated,
      released after), not the absolute — and on two song lengths only, so the
      per-minute cost (28 MB on the sim, 38 on the emulator, 37 on the phone,
      over 3.4 added minutes) is a slope through two points, not a curve.
      The Android device pass is DONE (the POCO row above); iOS is still
      simulator-only. And the ~700-800 MB transient has to be read against
      the split gate's own budget before beats and a split can ever run near
      each other — 11.4 GB of phone makes it comfortable here, which says
      nothing about the 6-8 GB devices the capability gate exists for.
    - **4b wired** (2026-08-19). The lattice reaches the pipeline. The
      binding's new entry is `mlGridFromStems` (both platforms, same arity):
      44.1 kHz stem paths in, the core sums and decimates them itself
      (`sumStemsTo22k` — the desktop's fetchMlGrid mix, natively; ~250 MB
      of audio never crosses a JS runtime), the grid out. `pipeline.ts`
      runs it FIRST, before any stem crosses to the worklet host, so the
      ORT session's ~700 MB and the six decoded stems never coexist, and
      hands the result to `detectBeats` as the `ml` aux. The beat models
      are an opt-in "better beats" card in the phone library (87 MB, once;
      dismissable; never downloaded on anyone's behalf) — `BEAT_MODELS`
      was already pinned to `models-1`, and the sha256s match the files the
      device suites were verified with. Both natives grew `modelStatus`
      (a stat, never a download) so the planner can ask without touching
      the network.
      **The stamp trap is closed**: `analysisNone.beatMl` is the beat
      verdict's sub-stamp — true when the lattice was heard on the way to
      "no grid". BEAT_DETECT_VERSION alone cannot carry it (the desktop
      stores ml and no-ml grids under one detVersion), so a verdict that
      predates the models is re-asked exactly once when they land, and a
      verdict heard WITH them binds. Jest gates it (29 pipeline tests, the
      sub-stamp rule mutation-tested: ignoring it turns exactly the two
      re-ask tests red). Proven end to end on the sim
      (`mobile/tests/ml-aux-ios.cjs`): models absent → homegrown grid,
      `ml 0 ms`, the offer showing; models seeded → re-analysis logs
      `ml grid: 120 beats, 37 downbeats in 3.8s` and `ml 3955 ms`, fresh
      grid under the current stamp, key and melody kept.
      **And a real finding on the way**: the shared `Resampler` was sized
      for 48k→44.1k (24 taps per output at up=147 is a ~3.5k-tap prototype)
      and the same 24 at 44.1k→22.05k is a 24-TAP lowpass — measured −3 dB
      at 10 kHz, content at 12-14 kHz aliasing back at −10..−25 dB. On
      real stems that was 16.8 dB SNR against soxr and a different grid.
      The tap count now scales with the net decimation (96-tap prototype
      at 2:1; 14 kHz aliases at −134 dB; 48k→44.1k byte-identical to
      before, its 110 dB gate unmoved), and the host harness gates the 2:1
      response directly — the old filter turns three checks red. The
      "110 dB" in resample.h's header had been measured with a 1 kHz tone
      at a near-unity ratio, where a short filter cannot show.
      **What "matches the desktop" can mean here, measured before the
      device suites' gate was set**: three good renders of the same three
      stems (Chromium's OfflineAudioContext — the desktop's actual path,
      via `scripts/render-ml-mix.cjs` —, the core's Kaiser, ffmpeg's soxr)
      agree to 0.01 dB from 20 Hz to 10 kHz, differ in group delay and the
      last 500 Hz under Nyquist, and Beat This! gives them THREE grids:
      119/43, 120/37, 117/39 beats/downbeats. Chromium's is the
      least-filtered of the three (it sums at 44.1k and its per-source
      interpolation folds 11 kHz+ back in; its peak is the raw sum's), yet
      it is what the desktop ships. There is no resampler-independent grid
      to match bit for bit. What is stable is the LATTICE: phone vs
      Chromium beats F1 0.996 (119 of 119 within 70 ms), same tempo,
      downbeats F1 0.88 — the downbeat head is the marginal one, and `ml`
      is evidence to the courts, not the grid. So `mlgrid-stems-{android,
      ios}.cjs` gate beat-F1 ≥ 0.98 / tempo / downbeat-F1 ≥ 0.80 against
      the Chromium oracle, and dropping a stem turns them red (F1 0.975,
      tempo 120 vs 125). iOS and Android agree with each other bit for bit
      on the from-stems path (120/37 on both).
      Not done: the ≥10-song corpus eval of phone-ml grids — `beats-corpus`
      withholds the lattice from both sides deliberately (feeding the host
      CLI the identical grid means shipping ~13 000 numbers a song), so the
      corpus gate does NOT cover this and no other suite does it at scale.
      (Two items that stood here are done: the real-phone run of the
      from-stems path landed with the twelfth slice's forced analysis on the
      POCO, and `mlgrid-android.cjs` needed no levelling — checked in
      Phase 4 and found already point for point with its iOS sibling.)
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
    - **Tenth slice — the ML fork, and `detectBeats` is whole**
      (2026-08-20). The last un-ported stage of the detector: `latticeFromMl`
      with its octave and steadiness guards, `dominantMlBarLen`, `levelMix`,
      v17's `levelNormalize`, the whole v11-v16 splice family (~430 lines: the
      thinned and bar-anchored parity views, the per-span carry vote, the
      zone-local halved view, the five splice reasons), and the bar-phase
      touchpoints — the waltz meter, the drumless bar histogram, the segment
      seams, the `mld` cue, the void physical-defect gate, the spliced-intro
      bars and the per-span rotation re-vote. Composed with courts.cpp and the
      head backcast's post-halve second chance, the core's entry point is now
      `detectBeats` and the name has dropped its qualifier, as the header it
      carried told the next person to do.
      The front-end (flux, low band, drum onsets) moved out of
      `trackFromDrums` into `drumFrontEnd` on the way, because `latticeFromMl`
      needs `drumFlux` too and the fork between them happens before either has
      run — the TS's own shape, which the port had flattened for convenience.
      **The gate widened to the app's real aux.** `singz-analyze beats` takes
      `--ml`, `--bass` and `--word`; `eval/beats/make-ml-grids.mjs` runs the
      installed pack's Beat This! over the library and writes the grids as
      JSONL, which the harness hands to BOTH sides as whitespace tokens (JS's
      shortest round-trip repr in, strtod out — the same double on both sides,
      which a %.17g hop through Foundation would not give). 50 stages, 25
      inputs (17 library songs and 8 fixtures), identical — and identical
      again with `--ml` withheld, which is the packless path the phones take
      without the models.
      **Adding bass found a real bug in the courts, three days old.**
      `meterCourt` materializes a uniform bar array for a grid that reached it
      without one — purely so its own tests have bars to measure, no verdict
      follows — and the TS does it by building a NEW OBJECT, which its caller
      tests by identity (`courted !== det0`). So a song whose phase pass finds
      no confident anchor leaves the courts WITH bars even though every court
      declined. Panzerkampf's 129 bar lines and Primo Victoria's 64 are exactly
      that, and this side was shipping neither while every court debug field
      still compared equal. `CourtsDbg.changed` now marks the construction, not
      the verdict.
      **And a hole in the gate itself, found by mutation.** `debug.reject`
      used to imply the TS returned null, so the harness broke out of the
      comparison as soon as it saw one. The ML fallback ends that: the tracker
      writes "windows disagree on a tempo (rubato?)", the model's lattice is
      adopted, and a grid comes back with the string still sitting in the
      debug. Father and Son compared ONE stage of forty-nine and printed PASS —
      and had been doing so in every run of this slice. The test is the return
      value on both sides now. What surfaced it: an octave-gate mutant that
      should have rewritten that song's entire grid survived, twice, which is
      not something a live gate does.
      **Coverage is measured, not assumed.** The harness ends with a
      branch-by-branch report of what the run executed — twenty-two named
      branches, each with the songs that reached it — because a green parity
      run that does not say what it ran is the failure the fixtures exist to
      prevent, one level up. Four branches the library structurally cannot
      reach got fixtures with preconditions: `ml-verbatim` (the bare-mix early
      return needs a project with no bass and no instrument stem), `ml-waltz`
      (a 3-beat meter the drums-first path cannot emit at all), `ml-drumless`
      (the meter read off the model's own bar histogram and the phase off its
      own marks — and its bars are SIX beats long on purpose, because both the
      histogram and the autocorrelation it replaces answer 4 on a 4/4 song and
      a 4/4 fixture would have proved nothing), and `ml-multilevel` (v17's
      thinning, with a seam whose local interval sits between 0.7 and 0.9 of
      the song's own).
      Two of those fixtures took a second shape to work. `ml-drumless` began
      as quiet white noise, on the reasoning that a real drums lane carries
      bleed: the onset picker found 339 peaks in it and marked 78% of beats
      active against a 30% ceiling, reaching neither branch. And
      `ml-multilevel`'s seam began as alternating 0.30/0.50 gaps — but the
      median of an odd window over two values is always one of them, so the
      local interval read 0.30 or 0.50 and never the 0.40 the seam existed to
      produce. Both are the same lesson: a fixture that plausibly resembles a
      case while missing its branch is worse than none, because it reads as
      covered.
      **Mutation results**, since that is the only way to tell "covered" from
      "reached but inert": nine mutants of the ML port, six killed by the
      corpus (the octave gate both ways, the steadiness gate, the seam's
      half-bar allowance, the span-phase margin, the `mld` cue weight), two
      more killed by `ml-multilevel` once its seam was reshaped, and three
      that survive and are printed by the harness as KNOWN UNEXERCISED — the
      splice's v16 level gate (no span in these lattices sits at the wrong
      level, so removing it entirely changes no grid), `levelNormalize`'s
      `barAt` tolerance (Beat This! snaps every downbeat onto a beat, so the
      distance is always 0 and any tolerance accepts), and the splice debug's
      carry-over across a refused splice (a debug field only; no grid depends
      on it).
      One smaller shape worth keeping: the CLI now OMITS the tracker's debug
      groups it did not reach rather than printing their zero defaults. The ML
      fork can return before the tracker entirely, and a printed 0 against the
      TS's unwritten key is a divergence that exists only in the report.
      **Review caught the one touchpoint that was not in `detectBeats` at
      all.** `trackFromDrums` reads `aux.ml` too — v16/v17 widen the octave
      near-tie window from 3% to 12% when the model tracked both levels in one
      song, because then it is saying in its own voice that the race is real.
      It decides a whole-song halve or double and leaves no trace but
      `debug.octaveTie`, and this port had left it at the narrow 3% with a
      comment ("without a pack is absent") that the same diff had made false.
      Nothing caught it: the harness had no `octaveTie` stage, so the field was
      never compared, and no library song has BOTH halves of the trigger —
      Puppe, Turn The Page and Wild World widen the window but race by more
      than 12%; Primo Victoria, Sixteen Tons and Wanted Dead Or Alive race
      inside the band with unambiguous models. A 23-input run at 49 identical
      stages was hiding a whole-song octave.
      Now: `trackFromDrums` takes the whole `BeatAux` rather than the fill
      stems (which is the TS's own shape, and removes the way for the two to
      disagree about what the tracker may read), `mlBimodal` is ported, the
      stage exists, and `ml-octave-tie` is a fixture built to have both halves
      — an SSSW accent at 0.45 s puts the 133 and 66.5 bpm candidates 6.7%
      apart with the half-time reading winning on support x alternation, and a
      lattice whose ratio falls outside every view window and whose level
      mixing gets it refused, so the tie is the only thing the model touches.
      Reverting the fix now turns the gate red at that fixture.
      The same review found the host test suite no longer compiling —
      `barPhase` had gained a required parameter and `tests/native/
      core_host_tests.cpp` still called the four-argument form, which the
      Android CI canary runs before anything else. Fixed; the suite passes.
      Not done in this slice: the bindings (`analyzeBeats` on both platforms,
      arity-matched) and `deps.ts` switching off the worklet host, which is
      where the 22.6 s of a phone analysis actually goes.
    - **Eleventh slice — the detector reaches the phone** (2026-08-20).
      `analyzeBeats` binds on both platforms with the same name and the same
      seven arguments: the drums, the bass, the vocals, the instrument bed,
      the lyric line starts, the aligned words as a FLAT [s0,e0,s1,e1,…]
      array, and the neural lattice or null. What the two platforms
      deliberately do NOT share is the marshalling — Android crosses a JSON
      line from C++ and parses it in Kotlin, iOS builds its dictionary from
      the core's doubles without any text at all — because Foundation's JSON
      number parser is not correctly rounded on 17-significant-digit input
      and Kotlin's is. A beat time is a double that has to survive; the text
      hop is safe on exactly one of the two platforms.
      The lattice crosses as three arrays plus fps, not four: nothing in
      `detectBeats` or the courts reads `beatProb`, and it is ~12 000 numbers
      per four-minute song.
      `deps.ts` chooses the native when every stem is WAV and the installed
      binary carries the method, and falls back to the worklet TS otherwise —
      a copied desktop project's FLAC, or JS newer than the app. The fallback
      loads its stems ONE AT A TIME and awaits each: ~53 MB of float32 apiece,
      and decoding four at once is four times the peak for no wall-clock gain.
      `pipeline.ts` no longer crosses anything to any runtime — `put()` is
      gone entirely — which means the beat stems must be named in the STAMP by
      hand, because put() used to do that as a side effect. A stem left off
      that list could be replaced mid-run without the commit noticing;
      `analysis-pipeline.test.ts` watches the VOCALS specifically, since every
      other aux stem is also named by the key stage and would pass even if the
      beat list dropped it.
      **Measured on the iOS Simulator, four-minute song**: 8.5 s native
      against 31.4 s on the worklet host for the same stems, and 51 s through
      the FLAC fallback (which decodes as well as tracks). The whole pipeline
      run reports `load 0 ms` now, which is the change stated in one number.
      **Verified value for value on device**, not by counts: the new
      `mobile/tests/beats-native-ios.cjs` runs the native, the worklet TS and
      the deps branch over one project and requires every beat time, the
      tempo, the meter, the rotation, every bar index and every suspect mark
      to agree — then runs the whole thing again over a lossless FLAC copy,
      where the fallback must reproduce the native's grid EXACTLY rather than
      approximately. It does. The suite asks the INSTALLED binary for
      `analyzeBeats` before anything else, because Metro serves JS live and a
      build made before this landed would silently take the fallback and
      compare the TypeScript against itself.
      Mutation found the sharpness of that check to be input-dependent, which
      is now in its header: with the seeded project's guitar and piano silent,
      a fallback mutated to drop its LAST instrument stem passed. Moving the
      mutation to the first (the one with music) gave 919 beats on a different
      rotation and turned it red.
      **Android is driven too, on the user's own POCO X6 Pro.**
      `beats-native-android.cjs` is the iOS suite's sibling — the same
      comparison, a different target selector — and it exists as its own file
      rather than a flag because the two bindings MARSHAL DIFFERENTLY: iOS
      builds its dictionary from the core's doubles, Android crosses a JSON
      line and parses it in Kotlin. A beat time that lost a bit in that text
      hop would be invisible to every count and to the iOS suite. It does not:
      513 beats, 97.5 bpm, 129 bars, identical to the worklet's, in **25.7 s
      native against 126.1 s** on a 5.3-minute song. The phone got the build
      with `-PdebugAppIdSuffix=.debug`, which is what keeps the release app's
      downloaded songs and Drive sign-in intact.
      **Both suites cross the FULL aux**, which review caught them not doing:
      the lattice and the aligned words are the two arguments the real
      pipeline always fills and a bare comparison never sends, and a
      mis-marshalled word pair or ml dictionary yields a grid that is wrong
      and is stored under an unchanged detVersion — never re-derived. The
      suites now report what actually crossed (iOS 176 words / 894 ml beats,
      Android 296 words / 545 ml beats) and say so out loud when either
      crossed empty. Holding that aux constant is also why the FLAC leg takes
      its lattice from the WAV twin: the core cannot read FLAC, and an unequal
      aux would make the fallback comparison answer a different question.
    - **Player + analysis on one real phone, measured** (2026-08-20). The
      number `keepStems` exists for, and which had never been read off a
      device. POCO X6 Pro, a 5.3-minute six-stem song, total PSS from
      `dumpsys meminfo` (never a JS eval — opening a song decodes six stems
      and evaluating during a decodeAudioData segfaults the Hermes
      inspector):
      catalog with nothing open **369 MB**; the song open in the player
      **1243 MB** (+874 for six decoded stems); and with a full forced
      analysis running ON TOP of it, including the neural lattice, a peak of
      **2118 MB** — +875 MB over the open song.
      The same song analysed the OLD way, with the worklet leg crossing six
      more decoded stems to the analysis runtime, peaks at **2236 MB**:
      +1060 MB over its open song, and that figure carries NO ORT session at
      all. So the core's path costs less at its peak than the worklet's did
      while doing strictly more — the ~700 MB ONNX session included. At 12 GB
      the phone is nowhere near trouble; the figure to carry forward for the
      6 GB tier is that a song open PLUS an analysis is a ~2.1 GB event, not
      the ~2.9 GB the two stem sets would have made of it.
    - **The corpus gate: device C++ == host C++, twelve songs, both
      platforms** (2026-08-20). `mobile/tests/beats-corpus.cjs` closes the
      last link in the chain. `eval/beats-parity.mjs` proves TypeScript ≡ C++
      on the HOST across the library; `beats-native-{ios,android}.cjs` prove
      the core ≡ the worklet TS on ONE song, on the device. Neither says
      whether an ARM build, a different libm or a different ORT gives the
      same answer as the machine the gate runs on. This does: it seeds a
      corpus, asks the device for each grid, runs the host CLI over the SAME
      bytes, and compares value for value.
      **11 songs with a grid, identical on both, plus one both sides refused**
      — on the iPhone 17 Pro simulator (5.7-7.3 s per 90-second excerpt) and
      on the user's POCO X6 Pro (7.2-7.3 s). The two devices also agree with
      each other, which is not something either suite alone can say.
      It is honest about its scope in its own header: the neural lattice is
      OFF on both sides, because feeding the host CLI the identical lattice
      means shipping ~13 000 numbers back per song for a comparison the
      single-song suites already make with the real thing. So the corpus is
      the homegrown pipeline and the v20 courts; the ML fork is covered
      per-platform on one song each and across 17 songs on the host.
      Mutation-checked, because device and host run the SAME C++ source and a
      bug in it would move both: pointing the host at a neighbouring song
      turns that row red with `host 94 beats vs device 118; first difference
      at index 0`.
    - **A song sheet, because the analysis was invisible** (2026-08-20, at the
      user's request: "there is no possibility to understand what is current
      beat detection state on the phone"). The player's header gained a
      top-right control opening a per-song sheet: the beat (tempo, meter, bar
      count — or the live progress line, or the verdict), the "better beats"
      models with their download, the key, the melody and the lyrics.
      The state worth the whole feature is the middle one. A song nothing has
      read, a song being read right now, and a song the detector listened to
      and honestly found no beat in all looked identical from the player — and
      the third is a stored VERDICT the app deliberately never revisits, so
      from the outside it is indistinguishable from a bug. It now says so, and
      offers the one action that changes the answer.
      "Detect again" needed a real addition rather than a button: every stamp
      says nothing needs doing, which is exactly why the singer is pressing
      it. `planAnalysis` gained a `force` that sets every stamp and every
      stored verdict aside and runs each detector the stems allow; hand-placed
      bar lines still survive, because analyzeProject folds them back. Driven
      on the simulator: the sheet went through "Listening for the beat…" and
      "Finding the beat…" to a fresh grid, which is a real run — a no-op would
      have gone straight from "Getting ready…" to done.
    - **Twelfth slice — the corpus gate, and the sheet learns to attribute**
      (2026-08-21, merged as #1 and #2). Three links had to hold for the port
      to mean anything, and only two of them had a suite. `eval/beats-parity`
      proves TypeScript ≡ C++ on THIS machine; `beats-native-{ios,android}`
      prove core ≡ worklet on a device. Nothing proved **device C++ ≡ host
      C++**, which an ARM build or a different libm could break in silence.
      `mobile/tests/beats-corpus.cjs` closes it: eleven songs with a grid plus
      one both sides refuse, value for value, on the iPhone simulator AND the
      POCO — and the two devices agree with each other. Its stem order is one
      constant on both sides, because review measured the sorted-vs-literal
      split moving `fluxSum`, `acAt4` and the fill's alpha, which would one day
      have read as the device disagreeing with the host. Its Android seed now
      clears the destination before pushing: `push` overwrites what it carries
      and removes nothing, so a `lyrics.json` from an earlier run was read into
      the device's aux while the host CLI got no `--line/--word`. Proved on the
      POCO by planting a deliberately off-grid one and watching corpus-01 still
      land on 118 beats / 30 bars with the sentinel gone.
      **Measured on the user's phone**, 5.3-minute song: catalog 369 MB, the
      song open in the player 1243 MB, a full forced analysis on top peaking at
      2118 MB — against 2236 MB for the old worklet path, which carries no ORT
      session at all. The core's peak is LOWER while it does strictly more.
      **Then the song sheet had to stop lying, twice.** The progress line is
      project-wide but was tested first in the Beat row, so the key and melody
      stages captured it: a hand-tuned grid read `BEAT / "Reading the key…"`
      and lost both its `120 bpm · 4/4 · 20 bars` and its promise that nothing
      here re-detects over it — the promise being the entire point of the
      manual branch. The stage now travels with the line (`AnalysisStage`
      through `onStep` → `AnalysisProgress`), and each row shows only its own.
      That fix alone was WORSE than the bug, and the gate caught it: the grid
      is computed in the beat stage but not committed until after the key stage
      (`pipeline.ts:466` vs `:485`), so de-attributing the line un-shadowed
      three leaves that only make sense before a run starts — "Not detected
      yet" and "Nothing has read the stems yet." for the seconds the key is
      read, on every fresh phone-split song. The value and the hint were each
      walking that four-level chain independently, which is HOW they drifted,
      so the precedence is one pure function now (`song-sheet-copy.ts`,
      `sheetRowState`) and `'idle'` is unreachable while anything runs.
      All three rows are on it: the Key row had the identical lie one row down
      (the detector stores "the harmonic bed is silent, no key" and the row
      printed "Not detected yet" over it), and the Melody row joined because
      during the beat stage it and Key are equally queued and were saying
      different things about it. The metronome hint deliberately does NOT use
      it — its precedence is grid-before-progress, the reverse, because it
      answers what the click is FOLLOWING rather than what is being worked out.
      Verified on both platforms afterwards: the busy window is real (iOS
      10.5-12.0 s, Android 17.6-20.1 s, between `progress/beat` and
      `grid/melody`) and `idle`-while-busy samples were **zero** in every run.
      Two notes for whoever writes the next device suite: "Tracking the melody
      · N%" is unreachable on the native path (`trackMelodyNative` resolves
      without progress; the percentage is the worklet/FLAC fallback only), and
      a "drumless" fixture must be digital SILENCE — a structureless drone
      still came back with a grid (126 bpm, 0 downbeats), testing the grid path
      instead of the verdict path.

## Phase 5 — FLAC storage, re-scoped: the DECODER comes first (2026-08-21)

The plan had this phase as "encode the stems, migrate the projects". That order
is wrong, and the reason did not exist when the plan was written.

**On this phone, WAV is the FAST format.** `deps.ts` sends a project to the C++
core only when every stem is WAV (`coreReads = /\.wav$/i`) and to the worklet
TS otherwise, because the core reads WAV and nothing else.

Both platforms are measured end to end now (the POCO's FLAC leg was recorded
2026-08-21, on a FLAC copy of the same Panzerkampf project the WAV figures came
from — grid identical either way, 513 beats / 129 bars):

| | POCO X6 Pro | iOS Simulator |
|---|---|---|
| core, WAV stems | **25.8 s** | 8.5 s |
| deps branch on FLAC (worklet fallback) | **178.1 s** | 51 s |
| the format's penalty | **6.9x** | 6.0x |

These are same-rig debug comparisons — both legs of each pair ran on the same
build in the same run, so the ORDERING is the robust part and the decision
rests on it; the release app's absolute times, and likely its ratio, are
smaller (the ~54 s decode slice below runs through the app bundle's JS buffer
handling, which is the inflated path). The Android figure decomposes, because
the driver times tracking apart from the branch: `ms.ts` 124.2 s is the worklet TRACKING with stems already decoded —
near-identical to the WAV leg's 125.0 s, as it must be, since tracking does not
care what the file was — and `ms.via` 178.1 s is the real deps branch, decode
included. So the **decode itself costs ~54 s** on this phone through the
audio-api path, and the other ~99 s of the penalty is JS tracking instead of
C++. Note what that 54 s is NOT: it is miniaudio decoding via audio-api plus
JS-side buffer handling, not the vendored libFLAC, which nothing calls yet —
an upper bound on what slice 2 replaces, not a prediction of what it costs.
(The vendored decoder does these same six stems in **1.28 s on the M2**; even
at 10x on the phone, slice 2 turns 178 s into roughly 35-40 s.)

This section carried a wrong number once already — an earlier draft paired
25.7 against 126.1 as if that were WAV-vs-FLAC, when both were WAV. Both
halves came from the record, the sentence read cleanly, and it was still
wrong; two measurements from different harnesses look like a pair.

A note for whoever runs that suite with a FLAC leg: the driver's own deadline
is 15 minutes PER LEG (`DEADLINE_MS = 900000`), and the run that produced the
number above was killed at 10 minutes by the LAUNCHER (the shell tool's cap),
not by the driver — the app finished on its own and the result was read out
afterwards. Launch it in the background or with a >15-minute cap; and know
that the driver's "arity skew between JS and native?" die-message now has a
second innocent cause, a slow leg under a short launcher.

Converting phone stems to FLAC without teaching the core to read them
therefore buys disk and pays roughly sevenfold on every re-analysis.

That does not bite on every open: analysis re-runs only when a detector stamp
moves (`BEAT_DETECT_VERSION`, `PITCH_DETECT_VERSION`) or the singer presses
"Detect again". Those are precisely the moments somebody is waiting for it.

The plan missed it because it was written in Phase 0, when every detector ran
on the worklet host and the stem format made no difference to analysis at all.
Phase 4 moved the detectors into the core and quietly made the format
load-bearing. `deps.ts` even says so in a comment — *"The core will read FLAC
once the desktop CLI needs it; this branch then goes away"* — which is the
right instinct filed under the wrong phase.

**So the rule for this phase is: never create a file the core cannot read.**
The decoder lands, and is proven, before anything encodes.

### Why FLAC at all, since the question was asked

Measured on the same six stems: WAV 321 MB, FLAC -5 **115 MB (36%)**, ALAC
121 MB. So the codec race is a wash — ALAC buys nothing and Android has no
encoder for it; WavPack would land within a few percent. Lossy (Opus, ~25 MB)
is excluded by something harder than quality: the detectors are bit-identical
ports, and analysis over lossy stems would give a DIFFERENT GRID than the
desktop for the same song — the divergence Phase 4 existed to eliminate.

What actually decides it is that FLAC is not a choice being made here at all:
**v2 = FLAC stems is the project format**. The desktop writes it, Drive syncs
it, the currency rule on three platforms compares it, both phone readers
already accept it, and every song downloaded from Drive is already FLAC on the
phone today. A different phone format would not be a better codec, it would be
a fork of the project format — and Phase 6 (publish, desktop adopts) would put
a transcode at the boundary anyway.

One nuance recorded because it was nearly gotten wrong: the single-encoder
argument (one behaviour on both platforms) justifies vendoring the ENCODER,
where levels and framing genuinely vary, and does NOT apply to the decoder —
FLAC decode is exactly specified, every conformant decoder yields identical
samples. The core still decodes with the vendored libFLAC, but the reason is
architectural (the core reads file paths itself; MediaCodec and ExtAudioFile
cannot be called from inside it without re-crossing stems over a runtime,
which is the exact thing Phase 4 removed), not behavioural.

### Slices, in this order — ALL FOUR LANDED AND DEVICE-VERIFIED 2026-08-21

The numbers, measured on the real targets the same day:

| | POCO X6 Pro | iOS Simulator |
|---|---|---|
| FLAC analysis, worklet fallback (before) | 178.1 s | 51 s |
| FLAC analysis, the core (after) | **28.7 s** | **21.7 s** |
| grid vs the WAV native grid | identical, value for value | identical, value for value |

Same song, same aux (296 words / 545 ml beats crossed), 513 beats and 129
bars agreeing to the 17th digit. The grid-identity row is the one that
carries slice 2: FLAC through the core answers exactly what WAV answers.

And slice 4 ran END TO END on the phone, twice, the second time by accident
of the first: a v1 WAV project with no analyses opened in phone mode →
detectors (native, ml 33.1 s + beat 26.3 s) → compact — which FAILED its
first run, every stem "kept as wav — stems/x.flac is missing", because
`encodeFlacNative` resolved the OUTPUT path through `localFile`, which
verifies existence: right for an input, absurd for an output, and invisible
to every jest fake because the fake's statFile answers for anything. The
failure ordering held exactly as designed — detectors committed, wavs kept,
doc stayed truthfully v1 — and the phone was left in the PRECISE state the
stranded-tail blocker described: v1, all wav, every stamp current. The fixed
bundle then reopened the project and the convergence ran live:
`plan.compact` alone queued it, NO detector ran ("grid kept, key kept,
melody kept · ml 0 ms, beat 0 ms"), **six stems encoded in 41.4 s** (321 MB
→ 115 MB, level 5, verify on, ~7 s/stem with per-stem progress), doc
version 2, stored analyses untouched. The design's hardest requirement was
proven by its own first bug.

Review then found the LAST member of the stranding family — one state
deeper than the tail. A kill inside the compact LOOP (after some per-stem
unlinks, before the single doc write — anywhere in ~34 of the 41.4 s
measured) leaves mixed stems under an all-wav doc; the all-wav probe is
then false forever, the doc names deleted files (the two-level-hashing
contract Phase 6's publish reads), and the unconverted stems never
compact. What tells that state from a FAILED stem — which must NOT retry
every open — is the DOC: a failed run wrote its flacs into stemHashes, a
killed one never got to. So `plan.compact` also fires for a probed .flac
stem with no `${id}.flac` doc entry, and the healing run branches per
stem: wav → encode as normal; flac → sweep a leftover wav if the kill
landed in the rename→unlink micro-window (compactStem's skip-heal, whose
wav-resolution rejecting IS the ordinary healed state) and state the flac
in the doc, which is the half the kill lost. Pinned by THE KILLED MIDDLE
jest test and mutation-proven: the probe-only gate fails it.

One measured note for the suites: the FLAC leg's `viaSame` check silently
became STRONGER with slice 2 — `via` is the core there now, so it holds
core-on-flac == worklet-on-flac on the device — and its label still claimed
the old routing. Both suites are relabelled, with the meaning-per-binary
stated at the check.

1. **Vendor libFLAC + the gate** *(done, 2026-08-21)*. Encoder AND decoder
   sources are both in the tree already — the decoder came along for the
   encoder's self-verify mode, which turns out to be exactly what slice 2
   needs.
2. **The core reads FLAC** *(done)*. Exactly as planned: BOTH readers —
   `readWavMono` and `readWavInfo` — dispatch on the file's magic bytes
   inside `wav.cpp` (fLaC → `flac_io.cpp`, RIFF → the walk that was already
   there), so all six `coreReads` sites in `deps.ts`, `audioDuration`
   included, went together and the JS-side widening of `coreReads` was the
   LAST step, gated on `nativeFlacAvailable()` (the `encodeFlac` method's
   presence on the INSTALLED binary — reader and encoder shipped in one
   native change, so one probe answers for both, and an older native under
   newer JS keeps the worklet fallback).
   The delicate part was never losslessness — it is the FOLD. `readWavMono`
   squeezes its running channel sum through float32 after every channel
   (`acc = float(acc + v/channels)`, the JS `loadMono44k` fold), and a FLAC
   path folding in double would differ in the last bit while every byte on
   disk was right. The host gate therefore asserts the FLAC decode of a stem
   equals the WAV it was encoded from **sample for sample, no tolerance** —
   plus the magic dispatch (the same FLAC bytes under a `.wav` name decode
   identically) and `readWavInfo` parity across the formats.
   Consumers wired: the host test runner and `build-analyze-host.sh` compile
   the vendored C once (as C — a C++ compile of C99 is the wrong language)
   into shared objects; the Android CMakeLists gets a `singzflac` STATIC
   library linked into `singzcore`; the SingzCore pod compiles `flac/src/*.c`
   (synced by `sync-singzcore.js`, structure preserved — the `deduplication/`
   fragments must NOT be in `source_files` or they compile standalone and
   fail). Every one of them passes `-DHAVE_CONFIG_H`, the flag the vendor
   README warns fails silently at the flag and loudly inside an SDK header. The vendored sources are wired into
   `mobile/android/app/src/main/cpp/CMakeLists.txt` and the SingzCore podspec
   — **with `-DHAVE_CONFIG_H`**, without which `config.h` is not read at all
   and the build dies inside a platform system header. Then `coreReads`
   widens and the worklet fallback stops mattering for FLAC.
   Gate: the host round-trip already writes a FLAC; decode it back through
   `readWavMono` and require it sample-exact against the WAV it came from.
   Device: a copied desktop FLAC project analyses on the native path at WAV
   speed — the same before/after comparison that produced the numbers above.
3. **The core writes FLAC** *(done)*. Not a bare encoder: `compactStem`
   (`flac_io.cpp`) is the upgrade's whole per-stem op, in the core so the two
   platforms cannot drift — encode to `.part` (level 5, **verify on**: the
   encoder decodes its own output as it writes and fails the finish on any
   mismatch, which is the decode-back check placed where a crash cannot skip
   it; total samples declared — `src/main/flac.ts`'s four choices), rename,
   delete the WAV. **Idempotent**: a flac already at the destination means a
   kill landed between rename and unlink — the re-run deletes the wav and
   reports skipped, because `.part` is never renamed unless the encoder
   FINISHED. Only canonical 16-bit PCM is accepted, the desktop's own rule.
   Bound as `encodeFlac` on both platforms, same name, same two string
   arguments (the arity rule at the top of `SingzSplit.mm`); Android crosses
   the result as one JSON line — sizes and booleans survive text, and no
   core double is in it.
4. **The writer emits v2, and old projects upgrade themselves** *(done)*.
   The compact phase rides the tail of `analyzeProject`, AFTER the
   detectors, through the same single-flight queue — and is PLANNED, not
   only ridden: `planAnalysis` returns `compact` for a v1 all-WAV project
   regardless of stamp currency, `CatalogScreen`'s phone-mode open gate
   includes it, and the runner re-checks the native probe (a build that
   cannot encode plans a no-op, same cost as any other). The stranded-tail
   kill therefore converges on the next open. Per stem, a failed encode
   keeps the WAV and the doc keeps naming it; `version` flips to 2 only when
   EVERY stem converted (the desktop's `allFlac` rule), and the doc rewrite
   is re-read → merge → write with fresh `statFile` hashes (the native's
   memoized md5). `compacted` rides `AnalysisResult` so listeners re-list —
   entry.stems changed. Guarded by six jest tests including THE STRANDED
   TAIL (mutation-proven: restoring the tail-only design fails it) and a
   FLAC-born-project-never-plans check.

### Auto re-encode — the desktop's mechanics, but AFTER analysis, not on open

The desktop does not ask. `App.tsx:727` calls `upgradeProject(dir)` on open,
unasked, in the background; `migrateProjectToV2` takes the project lock,
converts every stem, bumps `version` to 2, refreshes `stemHashes`, writes
project.json LAST and marks the library dirty so Drive gets the new files. Per
stem, a failed encode keeps the WAV and the project stays v1 rather than
claiming a conversion that did not happen. (It also guards its result with
`loadSeq` — the analysis-must-not-outlive-the-song rule — and the phone's
version needs the same.)

The phone copies the mechanics but NOT the trigger, and the difference came
out of asking whether FLAC fits mobile at all. Encode-on-open is the
desktop's shape because on the desktop the stems' format never mattered to
anything downstream. On the phone it does: a phone-split song is born WAV,
which is the format the core analyses fastest, and its first full analysis is
guaranteed to be ahead of it. Encoding on open would put the decode penalty in
front of the one analysis that is certain to happen. So the rule is:

**A phone-split project stays WAV until its first full analysis has finished,
and the encode runs after the detectors, through the same queue, as the tail
of the same job.** The hot path never touches FLAC while it is hot.
Re-analysis after that (a stamp bump, "Detect again") pays the in-core decode
slice 2 buys — the ~1.3 s-on-M2 path, not today's 54 s — which is the cost
that made encode-on-open wrong. Projects that ARRIVE as FLAC (copied desktop
folders, Drive downloads) are already in their final format and none of this
applies.

**The encode is PLANNED, not only ridden (slice 4's hardest requirement)** —
review caught the convergence
hole in the tail-only version. Walk the kill: detectors finish and COMMIT
(stamps now current), the phone dies during the encode. Next open,
`CatalogScreen` runs `planAnalysis` and queues a job only when a detector is
owed — all stamps are current, nothing is planned, and a tail that only rides
analysis jobs never runs again: the project is stranded v1/WAV forever,
silently, because WAV plays and analyses fine. The desktop never has this
state because its trigger is idempotent-on-open — the mechanism the phone
dropped when it moved the trigger. So the planner also queues an encode-only
job for a v1 phone-split project whose detectors are current; the first
analysis still carries the encode as its tail, and the plan step is what
makes a killed tail converge instead of strand. The OTHER kill — analysis
itself dying — needs nothing: no stored grid means `plan.beat` is true on the
next open, and WAV is the correct resting state to be stranded in, being the
fast one.

The other two differences from being a phone stand as before:

- **Crash safety has to be real, not incidental.** A desktop that dies
  mid-conversion is rare; a phone is killed as a matter of course. So per stem:
  encode to `.flac.part`, rename, decode it back and check it against the WAV,
  and only then delete the WAV — and rewrite project.json at the end. A kill at
  any point leaves either the old WAV or a verified FLAC, never a doc naming a
  file that is not there.
- **It must not fight the analysis runner.** Conversion and a detector run both
  touch the same stems, and `run.ts` already owns a single-flight queue for
  exactly that reason. The upgrade goes through the same queue rather than
  beside it; a project being analysed is not a project to repack underneath.

Mixed WAV/FLAC folders are legal on both sides and always were — the desktop's
`stemFile()` prefers `.flac` and the phone carries a per-stem
`Record<string, 'flac' | 'wav'>` — so an interrupted upgrade is a state the
readers already handle rather than a corruption to guard against.

### Numbers: three measured on 2026-08-21, two still owed

Measured, on the POCO's own Panzerkampf stems (5.3-minute song):

- **321 MB as WAV, 115 MB as FLAC -5 (36%)** — so the plan's old ~256 MB was
  wrong (the reviewer's arithmetic said ~336 MB and the disk says 321) and
  ~65 MB was optimistic. One stem skews the ratio: bass.flac is 61 KB, that
  lane is near-silent in this song.
- **Android FLAC analysis: 178.1 s** against 25.8 s native (above).
- **The vendored decoder at 1.28 s for all six stems on the M2** — the number
  that bounds slice 2's benefit from below on the phone only after scaling,
  so treat it as evidence the decode is cheap, not as a phone figure.

Still owed, before any copy quotes a number at the singer:

- **The in-core decode time ON THE PHONE** (slice 2's actual deliverable
  number; the M2 figure x some unknown factor).
- ~~What FLAC adds to a plain song OPEN for playback~~ — asked and answered,
  though not the way it was planned, and the episode is worth its space
  because it burned half a day and produced two new driving traps.
  Measured on the POCO's DEBUG app: WAV open 27 s, FLAC open 58 s — which
  reads as "FLAC doubles every open" right up until the user points out that
  real desktop-uploaded FLAC projects open in **3-4 s on the release app**.
  The debug rig was then re-measured with no inspector attached at any point
  (tap by `input tap` at uiautomator bounds, completion by the catalog
  marker leaving the UI dump): WAV still took **30.2 s**. So the inspector
  was never the poison — **the debug rig itself is**: the dev Metro bundle's
  `__DEV__` JS inflates the load path by roughly an order of magnitude (the
  30 s and the 3-4 s are DIFFERENT songs on different rigs, so the factor is
  directional, not a ratio of one measurement), and NO number measured on it
  describes the product. The release app cannot be driven (no inspector, no
  run-as), so the authoritative figure is the user's lived one: FLAC opens
  in 3-4 s where it matters, the playback tax is small, and the
  encode-after-first-analysis trigger stands. Debug-rig open times must
  never be quoted as product numbers — this section nearly did.
  Two traps found on the way, both now in CLAUDE.md's territory:
  **disconnecting the Hermes inspector while a decode is in flight kills
  the app** exactly like evaluating does (SIGSEGV at 0x0 on `mqt_v_js`,
  reproduced 2026-08-21 12:36) — the socket may sit attached idle through a
  load, but may neither speak nor hang up during one; and uiautomator
  bounds parsing must not `tr -d "[]"` — deleting the `][` between the two
  pairs glues y1 to x2 and every tap lands on garbage coordinates, which
  looks exactly like "taps do nothing".

The discipline stands: the one number in this section that was stated
confidently without being measured is the one that turned out to be wrong.
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
