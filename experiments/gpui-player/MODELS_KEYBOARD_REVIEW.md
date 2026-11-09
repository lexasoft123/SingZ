# Native Models keyboard access — 2026-11-09

Models now uses the existing shared UIKit focus/activation wrapper for Get,
Reinstall, GPU/CPU, Retry and Close/Skip. Persistent handles support modal
Tab/Shift-Tab, Enter/Space, automatic focus scrolling and synchronous recovery
when a download replaces the focused Get button with progress. Disabled Get
actions leave Tab order. No new control painter, font or lyric renderer is added.

The source SetupWizard remains persistent: Escape and scrim do not dismiss it.
Manual Close cancels the actual worker; Auto Skip leaves that same worker running.
GPU/CPU remain enabled during downloads. Retry retains the existing native
explicit target policy. A successful pack install retains its existing GPU-mode
reset; CPU is selected again through real keys before the restart check.

## Verified checkpoint

- Normal check, normal build, UI build and the focused Models policy test pass.
- The final hidden/muted keyboard journey passes at 1280×800 and 1060×640 at 2×.
  Actual keydown/up drives Tab, Shift-Tab, Enter, Space and persistent Escape.
  Thirty-five recorded action states and four focused error/Skip screenshots
  include measured bounds and focus ownership. The focused controls stay visible.
- Real loopback curl/tar transport exercises Get/Reinstall, obsolete-pack
  rejection, explicit Retry, cached first multipart file, truncated replacement
  rollback, mode changes, manual cancellation and automatic Skip continuation.
  Existing working bytes survive failed replacement and cancelled reinstall.
  No transaction artifacts remain. Restart restores installed state and CPU
  preference, closes the completed Auto wizard and makes no HTTP requests.
- The keyboard run and restart record 129 app CPU/footprint/system-GPU samples,
  with zero sampling errors or terminal discards. All 38 observed processes
  retire naturally and foreground identity remains stable. Main-run app CPU
  mean is 41.13%, p95 83.57%, maximum 99.95% (100% is one core), including
  interaction and screenshot work. Helpers are excluded from CPU; GPU counters
  are system-wide. Hidden live FPS and display cadence remain unmeasured.
- Four final keyboard images were inspected at both sizes. Production reference
  captures are unavailable in this no-Node checkpoint; full visual parity is open.
- The original pointer installer/restart journey also passes, with 22 observed
  processes retired, unchanged foreground and 35 valid resource samples. One
  zero-footprint readback was discarded only after confirmed process exit; no
  live sampling errors occurred. Six of seven historical native image pairs are
  exact under compare-ui.py. The multipart progress image differs by 126 pixels
  inside `[898,883,916,890]`, at its moving progress fill. Sidecar display inputs,
  locale, dimensions and busy/error states agree; asynchronous snapshot revision
  counters differ in five cases. This is a native regression comparison, not
  production parity or a matched-time animation pass. Pair/overlay/diff remain
  archived without masks, transforms or relaxed thresholds.
- The normal preview passes deep strict ad-hoc signature verification, all 39
  payload hashes, no-Node inspection and configured Drive build-info. It is not
  notarized or release-qualified.

UI SHA256: `225a54365933666b3d6140674666b5f3dd833006e1b8b68775921c6662581f58`.
Normal source SHA256: `c18b312776fdeed0d667452493fdbefa0639a34ded45e79fbdafad96b5d71150`.
Both source identities, the source overlay and runtime hashes are archived with
the normal preview. UIKit stays at `84343d42b940fcafa755e07a6825c3ea396f7ed8`.

Evidence: `/tmp/singz-models-keys-20261109`. The initial v1 reached both sizes but
the fixture download could finish during screenshot readback, invalidating the
in-flight Skip assertion. The loopback response now has a bounded hold released
only after actual Skip is verified with its worker still running. v2 passed all
UI actions but exposed the existing successful-install GPU reset in its final
CPU-marker assertion. v3 verifies the reset and reapplies CPU through the UI;
the original assertions remain. Failed runs and runtimes are preserved.

The catalog simulates Windows options on macOS. Tiny fixture files are neither
real models nor executable Python; this tests installation, not neural inference
or Windows delivery. Auto coverage explicitly makes the private installed pack
obsolete before invoking the real service; it does not inject UI snapshots or
callbacks. User libraries/models/config remain isolated; capture and sync are off.

Remaining concrete keyboard gaps include footer transport actions/Split menu and
training setup. Full production visual/temporal/accessibility parity, live FPS,
physical hardware, current Windows/Linux delivery and release qualification
remain open. The full desktop goal remains active.

Later follow-up: [Footer keyboard review](FOOTER_KEYBOARD_REVIEW.md) records the
footer/Split keyboard implementation and its actual native journeys. Training
Home/setup keyboard access remains a concrete gap.
