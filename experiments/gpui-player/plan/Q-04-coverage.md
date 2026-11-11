# Q-04 — native analysis and lyrics race qualification

Base: `8cfcc94d` (C-21 present), with C-10 `6c232784` and C-14 `2291f172`.
R-02 is the coverage reference; there is no separate Q-04 decision record.

## Files and ownership

- `tests/test_native_analysis_lyrics_races.py`: fixtures, native detector oracles,
  local HTTP service, deadlines, descendant cleanup, persistence evidence.
- `src/ui_analysis_lyrics_races.rs`: one `ui-tests` module driving actual project
  loading, production event subscriptions, native jobs, editor/sidebar controls,
  save receipts and reopening.
- `src/main.rs`: only the feature-gated module declaration and one dispatch.
- This report. No permanent production behaviour changes; no integration.rs edits.

## Running

Bootstrap with `scripts/worktree-setup.sh --desktop-only`. Copy the bundled
`mobile/assets/sample` from the main checkout into this checkout (ordinary files,
not a sibling artifact link). Compile matching local native helpers and a
`cargo build --profile qualify --features ui-tests --offline --locked` binary;
all builds must use the repository's native build lock. Then run:

```sh
python3 experiments/gpui-player/tests/test_native_analysis_lyrics_races.py \
  experiments/gpui-player/target/qualify/singz-gpui-player /tmp/q04-evidence
```

`--case NAME` selects a single regression; it may be repeated. `--tools PATH`
selects this checkout's matching native helpers. The driver verifies the
analyzer's embedded source fingerprint, records the binary hash and Git revision,
and refuses an app path outside `qualify`. Every app run sets `SINGZ_MUTE=1`,
`SINGZ_GPUI_BACKGROUND=1`, `SINGZ_NO_SYNC=1` and isolated configuration/library paths.
The hook verifies that its window is neither presented nor active. Isolated
preferences acknowledge the current release highlights (automatic in qualify,
unlike debug builds), and alignment cases enable Karaoke so their saved lines
and sidebar controls are mounted. Auto-lookup cases explicitly emit the production
Retry event; simply opening a saved song does not request Auto resolution.

Budgets are 35 seconds per hook wait/native tool step, 180 seconds inside each
hook, 185 seconds per app process and 900 seconds overall. Fixture barriers expire
at 30 seconds. The Python owner kills its app's process group and tracks descendant
birth times so separately grouped helpers are retired on expiry as well.

## Scenarios and oracles

| Case | Guarantee |
|---|---|
| `pitch-switch` | Hold A's real analyzer before inference, switch to B, release, explicitly save B; A's metadata stays unchanged and B retains its own pitch in memory and on disk. |
| `lookup-switch` | Hold A's automatic online lookup response, change epoch to B, release, await A's settled receipt; both lyric files and B's displayed lines/credit remain correct. |
| `candidate-switch` | Hold an explicit candidate response, switch to B and await disposition; neither A nor B is rewritten by the retired job. |
| `rate-44100`, `rate-48000` | Real detector output on separately resampled copies of the complete bundled vocal stem matches the app's decoded/saved pitch frames and integer-decimation hop; Save/reopen preserves it. |
| `beat-rate-44100`, `beat-rate-48000` | Real native beats from the bundled vocal/drum/bass stems match the app's source-rate beat times and BPM/octave, persist and reopen with current key/beat stamps. |
| `stamp-old`, `stamp-string` | Old numeric and string stamps rederive melody, key and beats through native jobs, auto-save and survive a second load. |
| `stamp-float`, `stamp-future` | Equal floating numeric and fractional newer stamps retain cached melody/key/beat data across explicit Save and reopen, without downgrade. |
| `tolerant` | A bad line is dropped; backward/zero-length word times clamp; the editor opens the normalized saved line, and reading never rewrites the file. |
| `edited-backup`, `unreadable-backup` | Auto preserves edited or unreadable bytes; explicit candidate publication preserves an occupied backup and creates the next suffix with exact original bytes; the replacement survives reopen. |
| `lyrics-cancel` | Cancel after the real word-aligner starts restores the complete displayed document and previous Ready details; the settled cancelled job cannot write the file. |
| `align`, `precise-align` | Actual sidebar Align and Precise publish aligned lyrics with Qwen/CTC method metadata, which survive reopening. |
| `editor-align-draft` | Actual editor input changes a draft word; the runtime receives the draft, alignment previews without writing or changing displayed saved lyrics, and explicit Save/reopen preserves the edited result. |

The sample's first twelve seconds did not yield a steady beat grid. The full
40.8-second bundled sample does. Both source-rate beat oracles must find at least
nine beats and agree within 5% in octave; there is no external annotated musical
beat ground truth. Pitch additionally requires non-silent frames, source-duration
coverage, and *different* 44.1/48-kHz hops before any app scenario can pass.

Neural models are one-MiB protocol headers. Fixture executables speak the
production ASR HTTP, word-aligner and precise CTC protocols with deterministic
transcripts/timings; the app performs its own chunking on decoded sample audio. Native decoding, HTTP, job ownership, publication, save and reopen are
real; this does not qualify neural recognition/alignment quality. Candidate
selection enters the same production Apply subscription event as the UI control;
this suite does not requalify candidate-list layout or pointer hit testing.

## Validation and mutation evidence

The qualify `ui-tests` build passes on macOS arm64 at the base commit above.
The default Rust suite was compiled with `cargo test --offline --locked --no-run`
under the native build lock, then its binary ran outside that lock with four test
threads: **1,186 passed, 0 failed, 3 ignored** in 151.20 seconds. `SINGZ_MUTE=1`
was set; `SINGZ_NO_SYNC` must be unset for the local mocked Drive service tests.
An initial run with sync disabled was stopped and restarted with that corrected
configuration; those failures were harness configuration, not product regressions.

Independent native preconditions on the complete bundled sample:

| Source rate | Pitch hop (seconds) | Pitch frames | Voiced frames | Native BPM | Beats |
|---|---:|---:|---:|---:|---:|
| 44,100 | 0.025034013605442176 | 1,627 | 777 | 99.38401442307693 | 66 |
| 48,000 | 0.025 | 1,629 | 777 | 99.38401442307723 | 66 |

The Python syntax and Rust formatting checks pass. A deliberate short timeout
proved per-step process-group cleanup; a blocked owner proved the independent
total watchdog exits 124 and kills a child plus a separately grouped grandchild.
The first descendant-cleanup check failed because `ps` birth times had trailing
whitespace; after normalization both cleanup checks pass.

### Final connected run

**18/18 cases passed**, process exit 0, in 25.87 seconds: `qualify` with
`ui-tests`, hidden and muted, macOS arm64, base commit
`8cfcc94d5777932c9af8a34d83f1e5c0c1a70939` plus this unstaged test patch.
The final run uses the rebuilt clean binary after restoring every mutation.
The basic WAV/FLAC/MP3 native helpers were built locally with four compile edges;
all scenario stems are WAV conversions of the bundled sample.

- App SHA-256: `bb74d20597fee2a81c60a425d8569bb3e9d73cd2b01f6f4ea09eaf3f5be0a946`.
- Embedded analyzer source fingerprint: `4e664329d036fb75eb2c6f48ec294672a17f467d`.
- Embedded detector stamps: pitch 4, key 2, beat 23; these also match the headers.
- Python syntax, Rust formatting and `git diff --check` pass.
- No C-10/C-14 drift entries remain in the shared case-table file; it was not edited.

### Failure before the guarded behaviour is restored

Temporary mutations were compiled into separate local qualify snapshots. The
original bytes of every production source were restored immediately after
compilation, before running those snapshots. Clean control snapshots passed the
same cases and final fixtures; the final clean build then passed all eighteen.
A negative run counts only when the app reports an explicit `Q04 failed:` result,
not an unrelated launch, tool, provenance or fixture error.

| Cases rejected | Temporary break | Observed failure output (sanitized) |
|---|---|---|
| `rate-44100`, `rate-48000` | `project_analysis::melody_needed` always false | `Q04 failed: Q-04 pitch frames/stamp differ from source-rate oracle` — stale v3 `x1632` remained. |
| `beat-rate-44100`, `beat-rate-48000` | Double the detected BPM in `beat_analysis` conversion | `Q04 failed: Beat source-rate BPM/octave differs` |
| `stamp-old`, `stamp-string` | Disable melody upgrade | `Q04 failed: Q-04 pitch frames/stamp differ from source-rate oracle` — v3 or string `"4"` remained. |
| `stamp-float`, `stamp-future` | Read pitch stamps with `as_u64` instead of `as_f64` | `Q04 failed: Q-04 pitch frames/stamp differ from source-rate oracle` — the cached equal/future payload was replaced with newly derived v4 frames. |
| `tolerant` | Refuse zero/backward words in the saved reader | `Q04 failed: Tolerant load did not skip bad rows` |
| `edited-backup`, `unreadable-backup` | Return success without backing up protected bytes | `Q04 failed: No such file or directory (os error 2)` at the exact `.bak.1` preservation assertion; the occupied `.bak` existed but the required new backup did not. |
| `lyrics-cancel` | Discard previous Ready state instead of restoring it | `Q04 failed: Cancel did not restore shown Ready details` — state was `idle`, `showsLyrics=false`. |
| `align`, `precise-align` | Replace the Qwen/CTC result method with a wrong method | `Q04 failed: Q-04 step timed out` at the exact expected persisted method predicate. |
| `editor-align-draft` | Replace the returned alignment method | `Q04 failed: Q-04 step timed out` waiting for the editor's Qwen result. |

**15 mutation controls rejected.** No assertion or deadline was weakened.
Final diffs are empty for `project_analysis.rs`, `project_pitch.rs`,
`project_lyrics.rs`, `lyrics_store.rs`, `lyrics_sidebar.rs`, `lyrics_align.rs`,
`beat_analysis.rs`, and `integration.rs`. Only the four owned files are changed.

### Scope limits and reviewer notes

The **three switch-race cases have positive deterministic-barrier evidence only**.
The pitch subprocess and HTTP response are genuinely held, the project epoch is
changed, and the lyric cases await the old operation's settled receipt before
asserting both files and B's displayed state. The integration-owned producer
cancellation/publication fences prevent a late result from being produced even
if a UI receipt guard alone is removed. Forcing the unsafe publication would
require an integration mutation or a new injection seam there. The coordinator
explicitly instructed documenting such controls instead of touching C-17's
`integration.rs`; these three cases are **not claimed mutation-qualified**.

The task needed no human product choice. Remaining independent Claude review is
coordinator-owned. No Windows field run, installed neural-model quality run,
physical microphone run, Beat This model run or visible-frame qualification was
performed. The three ignored Rust tests cover installed beat inference, a slow
large-library request baseline, and installed real lyric alignment. None is
silently counted as covered by the deterministic alignment protocols here.
