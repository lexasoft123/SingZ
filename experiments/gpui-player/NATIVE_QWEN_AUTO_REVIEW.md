# Automatic native lyrics qualification — 2026-11-09

Adds an opt-in `ui-tests` journey for a project with no lyrics. Normal app behavior
is unchanged. The real production LRCLIB lookup runs before native local Qwen
transcription. A legitimate lookup hit emits bypass evidence and exit 77 instead
of claiming Qwen passed. No forced miss, mock server or fixture inference is used.

The driver copies a bounded spoken fixture into a private library, removing only
copied lyrics/heard-cache files and copied `songFile` metadata to exclude legacy
original-song cache reuse. It preserves project name/source filename and directory
basename, including fallback lookup identity. All original files, installed models
and supplied native executable identities are checked before/after.

## Verified result

- All 21 existing lyrics-resolution policy tests pass; normal check and UI build pass.
- Actual LRCLIB returns Miss; Searching and Transcribing are observed and captured.
  Real Qwen produces 26 finite timed words and a fresh source-bound heard cache.
- Automatic `lyrics.json` publication requires no Transcribe, header Save or editor
  Save. Persisted source is `whisper`, engine `qwen3-asr-1.7b`, lookup version 3,
  pending false; stale alignment metadata is absent. Reopen preserves exact lines
  and word timings. Native Play/Pause completes with matching receipts.
- Ready and reopened states pass at 1280×800 and 1060×640, plus two actual progress
  captures at 1280×800. All six full screenshots were inspected. Whisper shows
  Edit/Change and hides Align/Precise. These are candidate captures, not matched
  production visual parity.
- Hidden/muted run finishes in 6.840 s. Foreground identity remains stable; all
  nine observed process identities retire, with no observation errors. Source
  fixture, model and runtime inputs remain unchanged.
- Nine app CPU samples: mean 16.48%, max/p95 44.72% (100% is one core). Footprint
  mean 240,876,857 B, maximum 331,072,784 B. System GPU counters are available in
  all nine samples. No sampling errors. Helper CPU is excluded; GPU includes
  other processes. Live FPS remains unmeasured in the hidden window.

## Evidence and remaining scope

Working evidence: `/tmp/singz-qwen-auto-20261109`, with source identity, build logs,
policy-test log and `ui-v1/evidence.json`, process/foreground/resource receipts,
screenshots and state sidecars. Selected artifacts are archived beside the normal
preview at `automatic-qwen-qualification-20261109`. Models/work profiles/binaries
are excluded from Git.

UI binary SHA256: `54950dec46f492b843fc9ef63703d2954fe6341cb1d76adb2642dcc3792751b8`.

This closes the actual automatic Miss→Qwen UI path on the current macOS host.
The live Down and Hit paths are supported by this test but were not exercised
in this run; their existing policy tests are separate evidence. Spoken audio is
not singing timing ground truth. Hardware input/OS choosers, current Windows/Linux
delivery, full production visual/temporal parity, live FPS and release signing
remain open. No glyph renderer, fonts, UIKit or production runtime changes.
