# Healthy live-helper publication failure — 2026-11-08

The healthy, unmonitored working-Save case previously left open by
[the publication recovery review](PUBLICATION_RECOVERY_REVIEW.md) is now verified
on macOS and Linux VM403. The existing FIFO Pause works in this case: after a
real publication-read failure the original helper remains owned and paused,
rather than continuing playback. No production playback change was needed.
The full desktop goal remains active.

## Measurement and workflow

The new `--live-publication-fault` driver phase opens raw audio, edits and saves
lyrics independently, accepts volume/rate/transpose/loop changes, then uses actual
Play and verifies advancing current native position. It never kills the helper.
Actual Header Save publishes the project; exact metadata quarantine then causes
the real publication read to fail.

`ui-tests` adds a backend-owned `ProbeOwnedAudio` request. Each probe issues a new
`status` command to the matching owned child, before host status admission. It
reports the child PID, epoch, monitoring lease, active training and native state.
It does not read the UI's cached `last_playback_status`, mutate ownership or add
release-build telemetry. Probe age is recorded immediately on receipt.

Seven fresh observations, spaced at least 100 ms apart, require the same helper,
same route/epoch/graph/loop, no monitor/training owner, `playing=false` and stable
native position. The working document, draft, lyrics `Arc`, accepted mix and
publication receipt remain retained; the local stopped clock also stays fixed.
The metadata is repaired with the exact saved bytes. Actual Settings Retry
adopts the publication and creates a paused replacement helper, then actual Play
must advance current native position again. There are 13 probes per live run.

| Final live measurement | Mac | Linux |
| --- | --- | --- |
| Stable paused observations | 7 | 7 |
| Observation window, seconds | 0.9022 | 0.9551 |
| Native stopped position, seconds | 2.518396 | 3.3247917 |
| Original → replacement helper PID | 61397 → 61468 | 376 → 393 |

Probe PIDs are independently cross-checked against the platform process observer.
The different stopped positions reflect different capture/runtime delays, not a
matched visual or temporal fixture. This is a bounded native state measurement;
it does not qualify acoustic output, physical hotplug, monitoring or training.

## Final evidence and preserved failures

Final v3 normal Rust suites pass **781 tests, zero failures, two ignored on each
platform**. Both UI builds pass and the normal Mac app is restored. With builds
and native-heavy tests stopped, each platform passes seven live-case images/one
app, 29 existing publication-fault images/three apps and 19 existing recovery
images/three apps: **110 final PNGs / 14 apps** total.

A separate verifier checks 21 checkpoint source hashes, unchanged UIKit hash,
binary receipts, every decoded PNG and state sidecar, probe ownership/freshness,
native stopped/advancing state, exact persisted metadata/lyrics/media, loop
canonicalization and foreground/display state. Every final capture meets the
1280×800 or 1060×640 logical viewport contract at 2×. Final Mac workflows have
unchanged foreground; Linux windows stay unmapped on private displays. Full
failure and resumed-playback images were inspected on both platforms. There are
no matched production references or visual-parity claims for these new states.
CPU/memory samples are preserved; live FPS/GPU remain unmeasured and Linux uses
software rendering. Fonts, shared UIKit and approved lyric paint are unchanged.

Preserved evidence includes:

- v1 Mac/Linux tests wrongly treated `selection=None` becoming explicit `0..12`
  as loss. `current_mix` already writes the implicit full-song range. The corrected
  assertion requires exact native bounds before/after plus exact saved selection;
  it does not drop the loop check.
- v2 Linux completed the native workflow but Python rejected initial probe ages
  serialized after Save/render delays. Final v3 records ages at receipt, keeping
  the same freshness limit. The intermediate run is not final proof.
- The first final Mac recovery regression stopped when foreground changed from
  Codex to Chrome. Both bundle identities were read without activation; native
  test windows remained hidden. That run is retained as interrupted evidence.
  Only that terminal workflow was repeated, using the identical frozen binary,
  in `mac-recovery-v3b`; the final unchanged-foreground check passes.
- The requested Kimi Fast review exited with provider 429/five-hour quota before
  its final report. Its bounded prompt, log and exact process retirement are
  preserved; this is not counted as a completed independent source review.

Independent retirement checks confirm all observed final app/helper identities
(27 Mac, 19 Linux) are gone, including preserved Mac failed/interrupted owners.
The exact two task containers are stopped; host PID1268/startTicks4023 still owns
PCM0p in PREPARED and other containers are unchanged. Source/caches and the user
preview are retained. No stage or commit was performed.

## Remaining scope and artifact identity

Monitoring/training handoffs, pending-Pause admission failure and the broader
training/recovery matrix remain unqualified. Do not infer those from an
unmonitored, no-cue run or unconditionally retire a monitor-leased helper.
Recovery copy/localization, hardware/permissions, latest Windows, choosers,
live services/models, accessibility, production visual/temporal parity, live FPS
and release packaging remain open. The recurring engine startup timeout is not
resolved by passing suites in this batch.

Artifacts live in
`/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-live-publication-20261108`.
See `final-source-v3.json`, `final-capture-manifest.json`,
`independent-final-validation.json` and the process/cleanup receipts. Linux archive
SHA-256 is `fbacd3e5db9a3f88ff1f4c213ab25ee017e49d62b0bb29bdc5a6bb2c54560974`
(24,348,381 bytes), independently checked, reopened and CRC-verified. The combined
archive identity is recorded in `completed-archive-receipt.json`.
