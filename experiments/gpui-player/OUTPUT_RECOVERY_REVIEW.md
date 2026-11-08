# Native output recovery — 2026-11-08

Status: the covered native recovery, working-publication and Source handoff
checkpoint is verified on Mac and Linux. The full desktop goal remains active.
This is not a full desktop, production visual parity, or physical hotplug pass.

## Document ownership and audio recovery

Runtime playback/control/poll failures now emit `TransportFailed`, separate from
initial Open failure. The audio helper is retired while the loaded document,
accepted unsaved mix, lyric draft/revision, lyric layout/scroll, dirty bookkeeping,
working-copy destination and independent document work remain owned. The clock
stops. Initial invalid new Open still follows its destructive failure lifecycle.

Settings output selection/Retry captures the owned document and accepted mix.
Recovery validates the canonical project/media, metadata hash, loaded lane
size/mtime identities and saved graph before preparing a new helper on the exact
requested UID. It restores controls, loop and a callback-acknowledged paused seek,
then revalidates ownership/media. Only accepted output selection persists the
preference. It does not reopen the editor or automatically start playback.
Size/mtime identities do not establish cryptographic equality for an audio file
whose bytes change while both size and timestamp are deliberately preserved.

A route change on a live helper retains it only after an explicit refusal and a
fresh valid status prove the old ownership and controls. Timeout, malformed or
uncertain status retires it and retains the document for explicit recovery.
Empty documents remain paused, without song audio or a claimed physical output.

## Working-copy Save and Source handoff

The Source worker returns a hash of the exact metadata bytes it published. The
host independently reads that hash-bound publication and adopts its paths/media
without ordinary Open or replacement of the editor's current draft. Independent
lyric Save remains independent of project Save. Failed publication reads retain
the working document and publication receipt; explicit Retry reads it again,
while duplicate Save is fenced. Offline publication remains audio-failed until
Retry. A healthy working Save reprepares paused audio automatically.

Source split/rename handoff now configures the loop, waits for the actual paused
seek receipt, then queues Play if the retained intent was playing. Ordinary
interactive seeks retain their existing asynchronous behavior. The hidden Source
test records the paused receipt and first actual Play before its screenshot
delay. It compares adjacent heard positions modulo the loop with a wall-clock
bound shorter than a loop. Render loop counters are diagnostic only, because
they and heard position belong to different clock domains.

## Final evidence

Final v5 normal Rust suites pass **781 tests, zero failures, two ignored on both
Mac and Linux**. Normal and UI builds pass; the normal Mac executable is restored.
Hidden muted workflows pass **185 PNGs across 29 app launches**, with no builds or
native-heavy checks running during capture:

| Workflow | Mac PNGs / launches | Linux PNGs / launches |
| --- | --- | --- |
| Source split, handoff, working Save, legacy FLAC, conflict, rename, cancellation | 14 / 1 | 14 / 1 |
| Document/draft recovery, Save/restart and offline publication | 19 / 3 | 19 / 3 |
| Settings route and missing saved output | 16 / 3 | 13 / 3 |
| Native graph Save/restart | 8 / 2 | 8 / 2 |
| Empty-project lifecycle | 16 / 3 | 16 / 3 |
| Lyrics editor | 22 / 1 | not run in this Linux batch |
| Carry | 20 / 4 | not run in this Linux batch |
| Total | 115 / 17 | 70 / 12 |

The independent checker verifies all 20 frozen changed-source hashes, source and
binary receipts, every final PNG's decoded dimensions/hash, recovery sidecars,
paused seek/actual Play receipts, persisted metadata/lyrics/media hashes and
nonempty exact app counts. Mac foreground stays unchanged; Linux clients stay
unmapped on private Xvfb/Openbox displays with unchanged private foreground.
Independent PID/start-identity checks retire every observed owner, including 52
Linux UI/helper observations. Both exact lab containers are stopped, retaining
source/caches. Foreign host PID 1268/startTicks 4023 still owns PCM0p in PREPARED;
other containers are unchanged. The user's preview bundle is not replaced.

All 38 new recovery captures use explicit 1280×800 or 1060×640 logical viewports at
2×. Fifteen legacy Mac Settings/Carry frames measure 2560×1602 (initial logical
height inferred as 801 at 2×), so they are excluded from exact 1280×800 claims.
No pixels are resized, aligned or masked. Existing legacy interaction images and
missing production reference/sidecar states do not establish a complete parity
matrix. Representative full frames were read on both platforms, including the
repaired offline lyric body, retained editor and Settings Retry; the inspection
scope does not claim human review of every matrix region/frame.

Recovery and Source drivers retain CPU/memory reports; Linux outer sampling also
covers owned helper CPU. Mac Source sampling excludes separate inference/helper
CPU. GPU availability/scope is recorded by the drivers, with Linux software
rendering rather than hardware GPU qualification. Live FPS is **unmeasured**;
hidden stepped captures do not establish live display cadence.

## Interim evidence

- Interim v4 normal Rust suite: **781 passed, zero failed, two ignored on Mac and
  Linux**. Both normal/UI builds and the listed hidden interactions passed.
  Screenshot review subsequently rejected the sidebar publication state below;
  it is superseded by the final v5 fix and requalification.
- Earlier v1 hidden recovery workflow passed 19 captures over three launches on
  each platform: owned helper death, unsaved draft/mix retention, invalid route
  refusal, actual Settings Retry, paused restoration, native Play, project and
  independent lyric Save/restart, offline working publication and invalid Open.
  These runs precede the final shared seek fence and are not final-binary proof.
- Interim v4 interactions passed 115 Mac captures/17 launches and 70 Linux
  captures/12 launches. These are retained evidence, not the final qualification.
- Final v5 qualification supersedes these interim results, as detailed above.
- No UIKit, font, lyric paint, native C++ helper or approved glow changes.

The new recovery unit cases cover retained accepted mix without disk mutation,
changed media/metadata/track identities, exact publication hashes and linked-media
refusal. Route receipt cases distinguish proven clean refusal from uncertain
mutation and verify accepted UID/control invariants.

## Preserved failures and fixture corrections

The first Mac Source run used an absolute position assertion after a screenshot
delay on a two-second loop. A later v2 instrument combined render loop count with
heard position and overcounted near a wrap. Both failures are retained; neither
proves that playback reset. The immutable pre-recovery Source binary separately
passed its full existing lifecycle. The final receipt test avoids those clock
and screenshot-delay ambiguities.

Linux Source initially failed before qualification because its fake interpreter
did not dispatch the production Linux Demucs command. The fixture now recognizes
the exact ONNX, Demucs and UVR argument/output contracts and rejects unknown
commands explicitly. It still uses fake inference; the sparse ONNX marker is
explicitly a zero-filled placeholder, not model weights. Cancellation checks now
identify their owned descendant by PID and start identity; a terminated orphan
zombie awaiting container init is distinguished from a live process.

Linux v3 Rust tests exposed a new fixture error: both supposedly different-size
audio strings were 30 bytes, so immediate writes could share the same file stamp.
The corrected case asserts a guaranteed size change before testing refusal.
The failed 780/1 run remains evidence; final v4 passes without deadline changes,
production retries, or weakened acceptance assertions.

The v4 screenshot review found a real missed state: offline publication retained
lyric data and its `Arc`, but ordinary `sidebar_context` reset Ready to Idle when
the working-copy path changed. The lyrics body disappeared. The sidecars confirm
`showsLyrics: true` before and `false` after. Owned publication now rekeys the
sidebar without resetting its lyrics/search/consent state, query, results, scroll
or focus handles. New connected assertions require rendered lyrics and retained
sidebar state, not just document pointers. The earlier green interaction flags
alone were insufficient; the v4 images and defect record remain immutable.

## Delegation and limits

Kimi K3.1 Fast agents worked in this shared checkout with distinct file ownership:
recovery UI/driver implementation, read-only production review and Source fixture
repair. Root owns integration/builds/captures. Their submissions, handoffs and
source-level review closure are preserved separately. An additional external
Kimi review was rejected by automatic approval review pending specific source
sharing authorization; it was not retried or routed indirectly. Local work
continues independently.

Artifacts:
`/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-output-recovery-20261108`.
The v1/v3/v4/v5 source manifests and binary receipts distinguish interim from
final evidence. Prior checkpoints remain immutable. `independent-final-validation.json`,
`final-capture-manifest.json`, retirement/cleanup receipts and scope notes retain
the independent verdict and its limits. The Linux archive has SHA-256
`5b3d675aad7cc6b4a754581349e9a690d83b7cab5ce575bd1add7c1898b9897d`
(61,729,002 bytes), checked after transfer and extraction.

Still required: publication-read fault/duplicate-Save UI proof;
training/monitoring recovery;
actual hardware hotplug and permissions; latest Windows integration; recovery
message localization/presentation; explicit legacy capture geometry; real chooser, Google and release-model qualification; production-matched visual and
temporal matrix; hardware GPU/Wayland, live FPS, accessibility and packaging.
Hidden stepped images do not establish live smoothness. Source/other legacy
interaction captures are not complete pixel-parity sidecar/reference evidence.

Final UI binary SHA-256 pins:

- Mac: `b8f79564be950e845d3f620be6312768902199c3fc8dd6ef504f7657863ef2bc`.
- Linux: `00010e766b42faa4de8b323e37218ef51c13555c316403a8f4fba247a86f8653`.
- Native C++ helpers remain byte-identical to the preceding reply-inventory checkpoint.
