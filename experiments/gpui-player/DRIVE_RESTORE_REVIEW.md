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
- Earlier full suites pass at 901, 903 and 906 tests. The latest source suite
  records 908 passed, one failed and two installed-model tests ignored. Its sole
  failure is the already observed two-second engine-probe shell fixture. The
  unchanged-deadline isolated case passes once with process observations in
  `engine-probe-focused-observed.json`; this does not close its intermittency.
- The dedicated UI journey uses private loopback PKCE, encoded fixtures and
  separate online/offline launches. It checks actual browser keys/search,
  cancellation/retry, three full-body corrupt responses exhausting the existing
  retry budget, a subsequent successful Retry, native playback and offline opens.
  Empty remote data is a reader fixture, not a native-writer publication claim.

Draft checkpoint status: the latest online native journey reaches its success
receipt and produces 17 captures, but the Python post-validator fails because
the cached default project's `project.json` differs from the downloaded fixture.
The cause is not yet established. The temporary profile was removed on failure,
so the next diagnostic run must preserve it before cleanup. The offline launch
was not reached; the complete online/offline driver is not passing. This source
checkpoint is published for review with that failure open.

Current UI binary SHA-256:
`1a453478d5123a5267dacbecd7ff6fa334593df200b61a0f03f68bf4980eeb2b`.
Current normal binary SHA-256:
`3ded0d5fc2c12fc95713e79490298c64b9d0386abd202167bd141f091bff7390`.
The normal packaged preview has not been refreshed for this source checkpoint.

Preserved failures include typed-input propagation, compact focus scrolling,
incorrect driver assumptions about retained stages/automatic integrity retries,
and one foreground-observation rejection during unrelated app switching. No
production timeout or comparison threshold was relaxed to hide them.

No Node/Electron execution, physical microphone, OS chooser or global input is
used. Source geometry/functional tests do not establish production raster parity,
all-locale fit, accessibility announcements, Windows/Linux qualification or live
FPS. The full desktop goal remains active. See [acceptance gaps](DESKTOP_ACCEPTANCE_GAPS.md).
