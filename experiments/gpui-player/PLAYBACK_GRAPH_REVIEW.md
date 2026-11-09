# Native Settings playback graph

Settings now follows the source automatic selection: an accepted, non-unloaded
song graph displays playback; otherwise it displays monitoring. Missing or invalid
playback metadata displays the localized structured-graph-unavailable message.
It does not substitute the monitor schematic for an unavailable playback graph.

## Implementation

The C++ helper serializes `NativePlaybackStatus.graphSnapshot`, including lossless
decimal IDs, actual module kinds/roles, bus channel arrays, edges and latency facts.
Counts come from the compiled native graph. The Rust projection validates bounded
arrays, unique IDs/input destinations, bus connectivity, generation, totals and
latency compensation. Invalid visualization metadata does not interrupt audio.
Immutable snapshots use `Arc` when propagated through playback status consumers.

Settings receives accepted Opened, telemetry/transport, parking, recovery, custom
lane and restored-import statuses through production routes. New loads, deleted
projects and failed transports clear the old presentation. Existing epoch,
revision, timestamp and rate-generation guards continue to reject obsolete status.

Graph faces, header, diagnostic rows and focus outline live in sibling UIKit.
Playback faces have no decorative chain links; actual connections are listed
explicitly. A stationary viewport wrapper owns measurement/focus while its child
scrolls. Scoped keyboard Home/End/Left/Right reaches all modules; Up/Down/PageUp/
PageDown reads the connection list within measured Settings scroll bounds.
The monitoring painter remains the prior composition.

## Verification

Artifacts are under `/tmp/singz-playback-graph-20261109`. `source-v2.json` records
source for the passing 887-test suite (zero failures, two installed-model ignores).
The native helper build and existing real-DSP graph test pass, including custom
admission, gain, rate replacement, parking/unparking and malformed manifests.
The final normal check/build and UI-feature build pass. The final UI binary is
`37da075954e8af45c3b483a31a41c2c348d354ec179b3e3ed58b1b3d2eb6d75a`;
the audio helper is
`842aa085683dbfbc64087c53d5ccdc4bb9a81acfe2b31a6df89fe0336dda777f`.
`ui-final/fixture.json` passes all 23 captures and four generation receipts.
It observes 19 error-free app CPU/footprint/system-GPU samples, stable foreground
and natural retirement of all 11 observed process identities. Capture-run app CPU
averages 61.9%, with peak footprint 665,372,208 bytes. These are capture-burst
observations, not a steady-state or live-cadence benchmark.

`settings-keyboard-final` passes the existing two-size selector/range/checkbox,
preference-error and focus regression; all ten observed process identities retire.
Its earlier failed run found a missing graph `focusedBounds` test diagnostic.
That diagnostic now uses the same measured node viewport as production focus;
no assertion or production painter was changed for that repair.

The normal binary is
`a5157a680fdda22288b16ac6ce054c421dab70f827c97b18c95f9fcfbba61454`.
The refreshed preview lives under `macos-playback-graph-20261109` in the session's
`gpui-native-packages-20261108` artifact directory. Deep strict ad-hoc signature,
all 39 payload hashes, no-Node payload and configured Drive build-info pass.
This is a local preview, not notarization or release qualification.

The focused hidden journey uses real native ordinary/custom graphs, actual Header
Settings/Save activation, four accepted graph-generation replacements and custom
Save/reopen with unchanged graph bytes. It uses actual keyboard scrolling to the
final module and connection at 1280×800 and 1060×640. Runtime graph mutation uses
production transport events while Settings stays open; it is not a measured click
on a visible speed/transpose control. Invalid-snapshot paths are covered by parser
tests, not by a claim that a live helper emitted malformed data.

The initial compile rejected an accidental formatter filename banner; it was
removed. The first UI run exposed moving viewport diagnostics/focus and review
removed unsupported chain stubs. Original failed sources, binaries and captures
remain immutable in the evidence directory. No threshold/deadline was loosened.

No Node/Electron execution, physical input, OS chooser or global input is used.
Hidden captures establish neither production visual/temporal parity nor live FPS.
All-locale and accessibility/platform qualification remain open. The full desktop
goal remains active; see [acceptance gaps](DESKTOP_ACCEPTANCE_GAPS.md).
