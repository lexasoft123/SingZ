# Model manager and engine setup locale checkpoint — 2026-11-08

The native model manager now uses the existing `settings.wizard.*` and
`main.model.*` translations for titles, introduction, registry labels/descriptions,
installed/Get/Reinstall, retry/Skip/Close and Windows engine-mode explanations.
Stable registry IDs select the copy; cache paths, downloads, sizes, transaction
state and technical reason codes do not change with language.

Engine setup uses `settings.demucs.*` copy. Shared UIKit keeps the title,
bold Demucs introduction, code-styled pipx note, selectable/scrolling terminal
command and buttons. New label-accepting APIs retain the original English wrappers.
The terminal command and copied bytes remain exact; translations are never applied
to command syntax or raw probe errors.

The final hidden, muted English/Russian batch passes all four drivers: model manager
and engine setup in each language. Its 52 captures include compact/full windows,
missing/downloading/installed/error states, real loopback curl/tar installs, obsolete
pack rejection, multipart rollback/retry, manual cancellation versus automatic Skip,
CPU preference/restart, source command selection/Copy/reset, keyboard focus,
dismissal, actual subprocess rechecks and both stale-probe orders. The Windows
catalog is simulated on the Mac; this is not Windows hardware qualification.
Model captures record accepted locale and actual display-row inputs. Foreground
identity remains unchanged in all four drivers; app CPU/footprint and system-wide
GPU telemetry are archived. Live display FPS remains unmeasured.

Image review exposed a driver bug: it waited for a worker error but could capture
the mounted model view while that view still showed progress. The wait now observes
the widget's accepted snapshot, and the failed-reinstall capture asserts its actual
nonbusy error state. No extra delay, injected UI state or relaxed expectation was
introduced. The first batch remains preserved as pre-driver-fix evidence.

Final strict comparison against the hash-verified preceding native build gives
7/26 full frames exact: all seven English model-manager images match. The nineteen
setup images differ, including asynchronous blurred catalog/header content behind
the modal and state-dependent probe/route captures. The full images, overlays,
differences and sidecars remain available without masks or transforms. An additional
older diagnostics-reference batch gives 0/26 exact and remains preserved separately.
These results do not establish production visual or temporal parity.

Normal and UI-feature builds pass. The production-code Rust suite passes 747 tests,
0 failed, 2 ignored; the later correction touches only the UI-test adapter. Eight
comparator self-checks pass. All 86 shared/dist font hashes are unchanged. The
approved lyric paint was not edited. The recurring earlier engine-discovery fixture
timeout remains undiagnosed; this checkpoint does not claim to fix it.

Remaining work includes native-only loading/installer/probe errors, complete tooltip
and accessibility parity, all-locale layouts, contextual model notices/progress easing,
real release assets/inference, production reference captures and platform/packaging
qualification. Durable evidence and source overlays are in `gpui-model-locale-20261108`
in this chat's visualization directory. The full desktop goal remains active.
