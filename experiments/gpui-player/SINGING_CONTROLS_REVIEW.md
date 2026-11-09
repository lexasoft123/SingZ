# Singing controls checkpoint · 2026-11-09

Native instrumental gaps now show the production lyric-panel seconds label for
long pauses, then three/two/one dots before the upcoming line. The cue exists only
while playing. The shared UIKit sprite cache prepares glyphs and blur off-thread,
keeps sixteen captions/four pending builds, and explicitly releases evicted pulse
images from GPU atlases. Source line-box/tracking/pulse rules are retained; Windows
uses its static source policy. Upcoming first-line text stays faint until its
150 ms anticipated start. Active partial-glyph paint is unchanged once started.

Song Space and left/right work with ordinary button focus. Space blurs an
activatable button to prevent keyup activation; Enter remains the button action.
Text entries and dialogs own their keys. Stem faders are Tab/pointer reachable,
keep focus on Space, and consume arrows/Home/End, including multiple relative
keys before repaint. The native lane receives the resulting gain without seeking.
A real-input test exposed title wrappers consuming printable keys before input
insertion; title Escape is consumed, while other keys can reach the platform IME.

## Evidence

`/tmp/singz-singing-controls-20261109/ui-v5` is the final combined hidden/muted
batch: two fresh launches, 1280×800 and 1060×640 at 2×, forty main PNGs plus four
saved timeline-motion PNGs. It covers native graph/Save/restart, Karaoke preferences,
region boundaries, Restart handoffs, timeline wheel/pinch/follow, output, catalog,
countdown and keyboard controls together. Both foreground records remain unchanged;
all 34 observed helpers retire; 258 app CPU samples have no sampling errors.
GPU values are system-wide, helper CPU is excluded and live display FPS is unmeasured.
The six new full countdown/keyboard captures were inspected at both sizes.

Countdown traces contain 96 and 95 real native heard-clock observations, including
all nine pulse levels, intro/later three/two/one and cue removal during singing.
Pause removes cue and bounds. Screenshot capture uses a separate actual playback
pass from sequence observation; no position or playing-state assignment is used.
Keyboard receipts prove actual Tab, Space down/up, Enter, typed Space, arrows,
pointer focus, three same-render fader increments to .53, native gain, Home/End
and baseline restoration with Save. Old global shortcuts and Catalog behavior
retain their documented scope.

Four countdown tests, three keyboard policy tests and one shared range test pass.
The normal host check and final UI-feature build pass. Normal packaged-preview
qualification is recorded separately alongside the assembled application.

The 363 first/final-word and line-boundary restoration PNGs are byte-exact against
`gpui-approved-highlight-restored`; first/mid and final-glyph images were inspected.
The 49 saved-native lyric regions have exactly the same complete `frames.json`
(position, pixel-region hashes and advancing-glow draw counts) as
`gpui-transport-timing-20261108/regression/lyrics/frames.json`.
The UI binary SHA-256 is
`938896d912480859f4b720c3e6a2b3014f223b019f662bd226e21c24087276b1`.
The unchanged native-helper SHA-256 is
`a14e484376aaf88df7a7e7dd92180f7a27794920d032a7bcbf7f9dc4a7530860`.

The refreshed normal preview builds successfully, passes deep strict signing and
all 39 payload hashes, contains no Node payload, and reports Drive configured.
Its native `crispasr --help` passes. `llama-server --help` exceeds ten seconds
without output on the initial launch and bounded repeats; the previous preview’s
byte-identical llama-server binary also times out on this host. The failure is preserved in the
package qualification and remains unresolved. Do not treat the refreshed preview
as fully startup-qualified or attribute that failure to the new UI without evidence.

## Preserved failures and limits

`ui-v1` records the missing canonical-path conversion in the new countdown adapter.
`ui-v2` records the actual title typing failure; `ui-v3` proves its fix in the
new journeys alone. `ui-v4` records a skipped observation of intro two while
synchronous screenshot work occupied the UI thread. The final uninterrupted
sequence retains all three counts rather than relaxing that assertion.

The first 49-frame launch rejected an old synthetic key stamp. A separate fixture
copy updates only `settings.key.detVersion` from 1 to the current 2; preparation,
unchanged file hashes and reason are recorded in `lyrics-fixture-preparation.json`.
This is fixture preparation for lyric paint, not key-analysis qualification.
The original fixture and all visual baselines remain untouched.

No Node/Electron build/reference capture was run. Full production layout/typography
and temporal parity, live FPS, physical microphone/OS chooser use, current platform
delivery and nonzero-signal clipping remain open. Mute/Solo and legacy metronome
fader keyboard reachability are not qualified by this checkpoint. Historical
approved full-window images have different geometry; exact restoration regions
do not imply historical full-window identity. The full desktop goal remains active.
