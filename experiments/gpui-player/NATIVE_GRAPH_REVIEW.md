# Saved native graph playback — 2026-11-08

The native app now opens saved format-1 graphs through the existing shared audio
engine. Catalog rows stay visible without requiring graph readability. Opening a
referenced graph verifies an ordinary, bounded file against the exact saved MD5
and byte count before retiring the previous song. Stray graph files remain
invisible; missing, damaged and future references cannot silently select a default
graph. Raw graph bytes, opaque fields and project references are preserved on Save.

The portable validator still accepts the wider wire contract. A separate playback
projection applies the shared native limits: 128 nodes, 256 connections, 16 ports
per direction, 64 parameters per node, nonzero native IDs and 128-byte UTF-8 names.
Unpaired UTF-16 names remain valid for transport but cannot be represented by this
native bridge and are refused for playback. Future formats remain unopened.

The Rust worker captures only recognized controls into a private temporary
manifest (0700 directory/0600 file on Unix), keeps it alive until the helper's
admission reply, and removes it afterward. The helper pins an ordinary file,
limits it to 8 MiB and 4096-byte lines, and strictly parses bounded ASCII/hex
fields. No unknown JSON, adapter state or graph-supplied file path enters DSP.
The existing shared materializer owns lane binding, processor schemas, topology,
placeholder policy, resource limits and compilation. Prepare failures remain
errors. Native graph admission/counts are checked against the requested session.

The helper prepares explicit graphs with the same zero-event reference bus used
by the current desktop source, including click previews. Its retained prepare
configuration carries the same graph through tempo/transpose, metronome, routing
and output handoff rebuilds. A graph must itself contain the processors and
bindings required by those features; unsupported topology is not synthesized away.

Verification uses a new shared 14-node/13-edge native fixture with an extra static
trim, Signalsmith, song master and cue/reference branch. On the actual shared DSP
with a fake output device, its gain=1 output peak is 0.399994 and gain=0.5 output
peak is 0.199997. This independently proves that the stored topology affects audio.
Tempo/transpose rebuilding, seek/loop, park/unpark and subsequent playback retain
explicit graph admission. Six malformed/count/channel/nonfinite/truncated/trailing
and semantic lane-binding refusals pass. No unmuted hardware output is used.

Three connected Rust tests cover hash verification, integral JSON numbers such as
1.0, fractional refusal, stray/missing/changed/future/
unsafe files, native-versus-wire limits and manifest lifetime/permissions. The full
Rust suite passes 765 tests, zero failures, two ignored. The initial full compile
required updating the transport test's explicit Status fixture for the new graph
receipt fields; that failed log is retained. Earlier intermittent engine shell
startup timeouts remain unresolved despite this passing run.

The hidden mounted-app workflow opens the saved graph, checks its native admission,
uses Play/Pause/Mute, seeks, changes tempo/transpose, saves with Cmd/Ctrl-S, verifies
an actual external-edit conflict, replaces generations, handles a failed load and
quits with a prepared helper. A second process repeats it from the saved project.
Its first restart attempt exposed a test fault: the fixed externalChange payload
could already equal the saved bytes. The hook now increments a fixture revision
and asserts that the edit changed bytes before checking conflict protection. No
production Save conflict rule was changed; the failed run is retained.

Normal/UI app builds and the final hidden workflows pass: 30 PNGs across four app
processes, with unchanged foreground identity. The graph workflow captures four
native states per process at 1280×800 (8 PNGs); the existing writer/Drive regression
covers both 1280×800 and 1060×640 (22 PNGs). Observed graph audio helpers are
independently confirmed retired after app quit. Raw receipts are in the manifest.
These interaction captures do not establish
production pixel or temporal parity. CPU/footprint and system-wide GPU samples
are separate from live display FPS, which remains unmeasured. Shared UIKit/fonts
and approved lyric paint sources remain unchanged. No Node/Electron, staging,
commit, preview replacement or foreground activation was used.

Windows/Linux, physical devices, all graph topology/control combinations, explicit
graph-edit API integration, live services and full production visual/locale/
accessibility qualification remain open. The current source has no graph editor
screen; this checkpoint does not introduce one. The full desktop objective is
still active.

[Evidence and source recovery](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-native-graph-20261108/REVIEW.md).
