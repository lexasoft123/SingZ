# Native desktop Drive restore

The native app now has a read-only desktop project browser and download path,
separate from its full-library writer and phone-publication adoption. This is a
necessary dependency for empty-project sync, not completion of that round trip.
`drive_snapshot::capture` still refuses native empty publication. Older readers
ignore the native empty flags and can rediscover retained remote audio; that
publication compatibility boundary remains open.

## Reader and ownership

- Listing and downloads use GET operations; OAuth token exchange remains the
  existing native PKCE flow. The reader never creates, patches, trashes or adopts
  remote projects, and never downloads into the writer library.
- Payloads require Drive MD5/size and matching project-declared references.
  Verified stems work without an original file, including the writer's historical
  stale original reference. Graph and lyrics references are validated too.
- Explicit empty reader documents require both boolean flags, an empty custom
  roster and no audio/graph references. Missing files alone cannot imply empty.
- Private, leased stages retain verified members for cancellation/error retry.
  Failed payloads remain unpublished. Final publication uses a separate short
  cache lease and monotonically ordered immutable version directories.
- Current remote document ID/hash/size is compared with the original cache
  receipt. A changed cloud revision offers Download; local saved edits remain
  Open when the cloud revision is unchanged. New copies preserve old local edits.
- Cached projects remain discoverable after a local title/directory rename.
  Cache edits do not enqueue the writer's sync-dirty ledger. Linked cache roots
  confer no such exemption. Ordinary writer projects keep their existing marks.
- Each request has cancellation and session-generation fences. Close/account
  actions invalidate pending work; completion opens only the current request's
  project. Network/filesystem work stays on the reader worker.

## Native interface

Library and ProjectPicker expose the signed-in browser. The dialog uses shared
UIKit picker/search/row/progress controls, actual text input, scoped Tab/Escape,
reading keys, busy Cancel and focus recovery. Library Drive actions reveal their
measured bounds once on a focus change; manual scrolling is not continuously
reversed. Search spaces remain text while a paused native song is loaded.

Layout reference is explicitly an external prototype, not current production
renderer evidence: `/Users/maxplanck/.codex/worktrees/tv-drive-sign-in/SingZ` at
HEAD `669ba5a0d1deed1f6003de82100e75dd08d8768f`. Its DriveProjects components are
untracked and stylesheet dirty. Immutable source copies and hashes are under
`/tmp/singz-drive-restore-20261109/external-layout-source`. Dialog SHA-256 is
`3f5e6b59d372f0aaa734d654215672cf2cb98d60cc7976a35ce15199de79420c`;
button SHA-256 is
`d19968494b54648436720f5fde300fc291a69af97d3e992691898f8170cb1a98`.
No other checkout was edited. Nine source EN/RU strings are registered across all
13 dictionaries; untranslated source locales retain explicit English fallback.

## Verification scope

Artifacts live under `/tmp/singz-drive-restore-20261109`.

- Normal checks and successive builds pass. Restore tests cover real read-only
  HTTP/retry, declared hashes, private resume, exact cache reuse, local edits,
  renamed copies, remote revisions, generation ties and publication exclusion.
- Earlier full suites pass at 901, 903 and 906 tests. The `full-tests-v5` suite
  records 908 passed, one failed and two installed-model tests ignored. Its sole
  failure is the already observed two-second engine-probe shell fixture. The
  unchanged-deadline isolated case passes once with process observations in
  `engine-probe-focused-observed.json`; this does not close its intermittency.
  The current Library focus-repair source passes 909 tests with zero failures
  and the same two ignores in `full-tests-v10.log` (12.46 seconds). This also
  does not establish a cause or fix for the historical probe failure.
- The dedicated UI journey uses private loopback PKCE, encoded fixtures and
  separate online/offline launches. It checks actual browser keys/search,
  cancellation/retry, three full-body corrupt responses exhausting the existing
  retry budget, a subsequent successful Retry, native playback and offline opens.
  Empty remote data is a reader fixture, not a native-writer publication claim.

The first draft checkpoint preserved an unresolved `project.json` byte mismatch.
The diagnostic driver now saves exact seeded payloads and preserves private
prefs/cache/library, remote state, the original exception and immutable-input
checks before temporary cleanup on failure. Symlinks are copied without following
them. The retained `ui-v6/project-default-document.diff` establishes the cause:
the default six-stem fixture lacked a current harmonic key. Native analysis added
`settings.key` (`pc=4`, minor, detector version 2), and the existing automatic Save
normalized the mixer/training/view fields and added `savedAt`. The other three
documents remained byte-identical. All original inputs remained unchanged.

The saved-project fixture now includes that valid current key stamp alongside its
existing melody stamp. Production analysis and automatic Save are unchanged; no
checksum assertion, deadline or retry budget was relaxed. The unchanged UI binary
passes the complete driver in `ui-v8`: 17 online and 12 offline captures at
1280×800 and 1060×640, with exact cached payload checks after both launches. The
loopback server is stopped before the fresh offline process. Real native
Play/Pause is confirmed for nonempty projects; strict empty reader data opens with
zero duration, lanes and graph and released physical output. The cache remains
separate from the writer library and the remote GET-only ledger is unchanged.

The final two launches have 29 error-free app CPU/footprint/system-GPU samples,
unchanged continuously observed foreground identity, nine observed audio helpers
and 18 observed process identities naturally retired with no survivors. Mean app
CPU is 59.1% online and 74.4% offline during rendering/captures; maximum footprint
is approximately 680 MB and 642 MB respectively. Helper CPU is excluded and GPU
is system-wide. These short capture workloads do not qualify idle usage or live
display FPS. A preceding run (`ui-v7`) reached both native success receipts but
failed the strict foreground-stability gate; it is retained as a failed run.

The `ui-v8` restore-pass UI binary SHA-256:
`1a453478d5123a5267dacbecd7ff6fa334593df200b61a0f03f68bf4980eeb2b`.
The pre-focus-repair normal binary SHA-256:
`3ded0d5fc2c12fc95713e79490298c64b9d0386abd202167bd141f091bff7390`.
The pre-focus-repair normal preview is
`gpui-native-packages-20261108/macos-drive-restore-20261109/SingZ Native.app`
under this chat's visualization directory. Deep strict ad-hoc signature, all 39
payload hashes, configured Drive build-info and absence of Node payloads pass.
Manifest SHA-256:
`bd32ebeb0917da93c6c96737c573da2c548f361d9f60a03a579ce1f5882c4c4f`.
The package was not raised or activated. This is not notarization or release
qualification.

An existing writer regression exposed a stale UI adapter: it clicked Songs to
toggle Library, while production uses the explicit Catalog action. The shared
writer/adoption helper now reaches the actual mounted Header Catalog control
through Tab and Enter down/up. Production navigation and wait budgets are
unchanged. The current source pauses audio when Catalog covers the transport
(`App.tsx::toggleCatalog`, `desktop_actions::enter_desktop_catalog`); the writer
adapter now verifies that pause, then resumes through the actual Player control
and requires native advancement in the same epoch during the held upload and
after cancellation. Dirty intent, mute/Save, spool, cancellation and retry checks
remain. Additional JSON receipts distinguish these states.

The adoption adapter's previous “lyrics not loaded” failure actually had all 24
rows and the correct credit: it incorrectly required Karaoke to be enabled.
Karaoke remains the private profile's current default-off remembered mode. The
adapter now checks that preference independently and verifies every lyric row's
text, timing and word count. Its native gain/mute and payload checks remain.
This adoption regression does not qualify on-screen sung highlighting.

The writer regression then exposed a real Library focus defect: Connect and
Sync share a handle, and disabling/removing that action left focus on an
unmounted node, preventing Tab from reaching Header Catalog. Library now derives
current enabled actions from configuration/account/busy state, preserves valid
aliases, and recovers only while its own invalid Drive handle still owns focus.
Signing in can recover to search; busy/removal transitions recover to Cancel,
Sync or Browse as appropriate. Later pointer/text/Header/dialog focus is left
alone. The existing one-time reveal rule remains, so manual wheel scrolling is
not continuously reversed. Drive activation and keyboard rings now use the same
existing shared UIKit helper as Browse; default painters/layout are unchanged.
Actual transition checks and JSON receipts cover these ownership boundaries.

## Final focus-repair checkpoint

The frozen production focus repair passes the complete Rust suite (909 passed,
zero failed, two installed-model ignores), UI-feature build and normal build.
Final UI binary SHA-256:
`55e45b8d9f2120f058b5339119da08e8edcbcfeb6ce0f455d04ae1dad4c001b6`.
Final normal binary SHA-256:
`b2a848548d28a37a42d331aa1374dbe29478c5bb7af667d7726a4b6c2ea75ac0`.
Helper SHA-256 remains
`842aa085683dbfbc64087c53d5ccdc4bb9a81acfe2b31a6df89fe0336dda777f`.

- `ui-v10` passes the complete read-only browser/cache journey again: 17 online
  and 12 fresh-offline captures, exact payload checks, search transport ownership,
  retained cancellation/integrity stages, actual Retry and native playback.
  Its 28 error-free app CPU/footprint/system-GPU samples have unchanged continuous
  foreground observations; nine audio helpers and 18 process identities retire
  naturally with no survivors. Mean app CPU is 59.9%/73.3% online/offline and
  peak footprint approximately 656/640 MB during captures. Helper CPU is
  excluded; system GPU and unmeasured live FPS retain the limitations above.
- `writer-regression-v5` passes both private-profile launches at both sizes
  with 22 captures,
  including native playback during held upload and after cancellation, current
  metadata Save/follow-up, dirty intent, actual focus transitions, real blocked
  empty/broken projects, account restoration/tombstoning and foreign-file checks.
  The Python validator independently checks the new pause/play/focus receipts.
- `adoption-regression-v4` passes gated streaming, cancellation/resume, actual
  catalog open, native gain/mute/playback, saved lyrics and offline reopen, with
  22 captures. Default-off Karaoke is preserved rather than inferred from lyrics.
  The existing writer/adoption observers use before/after foreground checks;
  those are narrower than the reader journey's continuous/process-identity proof.

The final normal preview is
`gpui-native-packages-20261108/macos-drive-restore-focus-20261109/SingZ Native.app`
under this chat's visualization directory. Deep strict ad-hoc signature, all 39
payload hashes, configured Drive build-info and no-Node payload checks pass.
Manifest SHA-256:
`cd061468c206de1c4aa05a196331ecba6654234609ba5626cee02be1c76aa7af`.
The earlier preview/evidence remain intact. Final and failed-run evidence is
archived alongside the new preview. No app was raised or activated.

Preserved failures include typed-input propagation, compact focus scrolling,
incorrect driver assumptions about retained stages/automatic integrity retries,
and one foreground-observation rejection during unrelated app switching. No
production timeout or comparison threshold was relaxed to hide them.

No Node/Electron execution, physical microphone, OS chooser or global input is
used. Source geometry/functional tests do not establish production raster parity,
all-locale fit, accessibility announcements, Windows/Linux qualification or live
FPS. The full desktop goal remains active. See [acceptance gaps](DESKTOP_ACCEPTANCE_GAPS.md).
