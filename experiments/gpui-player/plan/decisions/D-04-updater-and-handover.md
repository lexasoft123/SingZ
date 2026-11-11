# D-04: Updater and Electron handover

Decision record, written 2026-11-10 against the working tree at `f7607311`
(branch `codex/gpui-interface`). `$G` = `experiments/gpui-player`. Other agents were
editing `$G/Cargo.toml`, `$G/src/main.rs` and both packagers while this was written,
so line numbers in those four files may have moved by a few lines. Anything marked
*(inferred)* was not checked against code.

Status: **proposed, awaiting sign-off** (section 6).

## 1. Question

1. How does the native desktop update itself: which mechanism, which trust anchor,
   how are stable and prerelease channels served, and how does it roll back?
2. How does someone on the Electron desktop get to native, and back: who offers
   what, which state is shared, which is imported once, which is left behind, and
   what are the bundle id, install path and name while both exist?

## 2. Inputs and what was verified

### 2.1 Verified against code

| # | Fact | Where |
|---|---|---|
| V1 | Electron self-installs only on Windows (electron-updater, download in background, install on quit). macOS and Linux only poll `api.github.com/.../releases/latest` and offer the release page. Check runs 3 s after start, then every 6 h. | `src/main/updater.ts:6-7,45-66,68-111,113-123` |
| V2 | Electron's version compare drops any prerelease suffix: `parseInt('0-beta')` is `0`, so `0.27.0-beta.3` equals `0.27.0`. | `src/main/updater.ts:25-32` |
| V3 | Update state shown to the user is one of `none / checking / available{version,url} / downloading{version,percent} / ready{version} / error{message}`; the title bar shows a chip for `ready` and `available`. | `src/shared/types.ts:463-469`, `src/renderer/src/App.tsx:3934-3945` |
| V4 | The Electron updater is already gated to the desktop surface; Box never starts it. | `src/main/launch-surface.ts:20-22`, `src/main/index.ts:328,1028` |
| V5 | Hyphenated tags are created as GitHub prereleases, so they are never `releases/latest`. The attach step uploads `dist/*.dmg dist/*.exe dist/latest*.yml dist/*.blockmap vendor/packs/*.tar.gz`. | `.github/workflows/build.yml:449-452,474-475` |
| V6 | The Windows Electron installer is NSIS, per-user, with no signing configuration; no `deleteAppDataOnUninstall` key is set. Whether a shipped installer carries an Authenticode signature was not inspected. | `electron-builder.yml:223-229` (whole file grepped) |
| V7 | Electron identity: `appId com.lexasoft.singz`, product name `SingZ`, profile dir `SingZ`. Box is `com.lexasoft.singz.box` / `SingZ Box` and sets its own `userData`. Desktop `userData` is Electron's default unless `SINGZ_USERDATA_DIR` is set. | `electron-builder.yml:1-2`, `src/shared/product-identity.ts:11-26`, `src/main/bootstrap.ts:21-40` |
| V8 | Native preview identity: bundle id `com.lexasoft.singz.gpui.preview`, name `SingZ Preview`, ad-hoc signing only. | `scripts/package-gpui-macos.py:27,462-465,486-491` |
| V9 | Native config root: `SINGZ_GPUI_CONFIG_DIR`, else `~/Library/Application Support/SingZ-GPUI`, `%APPDATA%\SingZ-GPUI`, `$XDG_CONFIG_HOME/singz-gpui`. | `$G/src/audio_devices.rs:330-350` |
| V10 | **Models and the splitter pack are already shared by default.** Native resolves `<appData>/SingZ/models` and `<appData>/SingZ/gpu-splitter` (note `SingZ`, not `SingZ-GPUI`), the same paths Electron uses, with the same `SINGZ_MODELS_DIR` / `SINGZ_PACK_DIR` overrides. This corrects R-03, which says the native production root is not established. | `$G/src/model_catalog.rs:105-135`, `src/main/models.ts:17-24` |
| V11 | The default library is the same folder in both apps (`~/Documents/SingZ`). A custom root lives in Electron's `settings.json` as `projectsRoot` and in native's `<config>/library.json` under the same key. Electron accepts any existing path; native requires an absolute directory. | `src/main/projects.ts:50-67`, `src/main/settings.ts:12`, `$G/src/project_library.rs:40-42,200-213` |
| V12 | Electron keeps Drive tokens inside `settings.json` (`gdrive: {access, refresh, expiresAt, authMode?, clientId?}`), written non-atomically with `writeFileSync`. A 400/401 on refresh deletes them. No token revocation call exists in either app. | `src/shared/drive-device.ts:14-20`, `src/main/settings.ts:54-65`, `src/main/gdrive.ts:101-109,240-250` (grep for `revoke`: none) |
| V13 | Native keeps `{generation, tokens:{access, refresh, expiresAt}}` in `<config>/gdrive/session.json`, directory `0700`, file refused unless private; it states that nothing reads Electron settings. It has no `clientId` field. | `$G/src/drive_auth.rs:164-175,236-280` |
| V14 | Native bakes its OAuth client from `mobile/gdrive.config.json`, falling back to `src/main/gdrive-config.ts`; Electron imports `./gdrive-config`. Whether both resolve to the same client id in a release build was **not** checked (the files hold credentials and were not opened). | `$G/build_config.rs:6-8`, `$G/build.rs:25-37`, `src/main/gdrive.ts:15,92` |
| V15 | The dirty ledger is advisory in Electron: "it never says what to upload. The sync still diffs the whole library against Drive." Electron shape `{seq, dirs, allSeq, since?}`; native shape `{seq, dirs, allSeq, retireOps, since?}` in `<config>/sync.json`, both capped at 100 dirs. | `src/main/sync-dirty.ts:7-23,29`, `src/main/settings.ts:32-40`, `$G/src/sync_dirty.rs:14-16,35-46` |
| V16 | Audio device preferences in Electron live in renderer `localStorage` (`singz.audio`), not in a file native can read. | `src/renderer/src/App.tsx:769,1148` |
| V17 | Native already persists language, window geometry, release-note acknowledgement and training in its own files: `language.json`, `window-state-native.json` ("Never reads Electron's global geometry"), `release-highlights.json`, `training-preferences.json`. | `$G/src/locale_service.rs:18`, `$G/src/desktop_window_state.rs:1,12`, `$G/src/release_highlights.rs:20`, `$G/src/training_store.rs:112` |
| V18 | Native and Electron are on one version line: `package.json` is `0.26.7`, `release_highlights::CURRENT_VERSION` is `0.26.7`, and the model catalog reads `package.json` to build the pack URL `releases/download/v<version>/gpu-splitter-…`. | `package.json:3`, `$G/src/release_highlights.rs:18`, `$G/src/model_catalog.rs:125-136`, `src/main/models.ts:538` |
| V19 | `release_highlights::valid_version` accepts only three numeric parts. A prerelease version string such as `0.27.0-beta.1` is rejected today. | `$G/src/release_highlights.rs:199-205,256` |
| V20 | Native HTTP is a spawned `curl` / `curl.exe` per request; the crate has `sha2` and `base64` but no signature-verification crate and no archive crate. | `$G/src/drive_http.rs:295`, `$G/Cargo.toml` `[dependencies]` |
| V21 | A grep of `$G/src/main.rs` and `desktop_lifecycle.rs` found no single-instance guard for the native app. | grep `single.?instance\|already running`: no hits |
| V22 | macOS release signing exists for Electron: Developer ID + notarization in CI since v0.19.1, secrets `APPLE_DEVELOPER_ID_CERTIFICATE_BASE64`, `APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD` and the three `APP_STORE_CONNECT_API_*`. | `docs/MACOS-SIGNING.md:10-13,45-59` |
| V23 | Windows refuses to rename a directory while any child handle is open. | R-12, citing `$G/WINDOWS_FILESYSTEM_REVIEW.md:27-33` (report read, source file not reopened) |

### 2.2 Taken from the research reports without re-checking

- R-03: window state, sync log, training receipts and "other renderer UI state"
  rows. *(inferred)*
- R-08: the per-executable entitlement table. *(inferred; belongs to D-05/C-30)*
- Electron's resolved `userData` paths (`~/Library/Application Support/SingZ`,
  `%APPDATA%\SingZ`) follow from Electron's defaults, not from repository code.
  *(inferred)*
- RFC 0001 has nothing on updating or handover (grepped for `updat|handover|install`;
  only project-document migration appears, lines 92, 250, 524). Its relevant rule is
  the plan's: keep new rule modules pure.

## 3. Options

Costs are worker-days for the coding packages, excluding coordinator review.
Budgets refer to `COMPLETION_PLAN.md` section 3.1.

### 3.1 Updater

| | U-A: own updater, platform signature only | U-B: Sparkle (mac) + WinSparkle (Windows) | U-C: signed-manifest swapper over GitHub Releases |
|---|---|---|---|
| How | Poll GitHub Releases, download the installer or archive, trust TLS plus `codesign` / Authenticode, swap | Embed Sparkle.framework and WinSparkle.dll, publish two appcasts, let each library show its own window and run its own install | Each release carries, per OS and arch, an update archive plus a small manifest signed with an Ed25519 key the project holds. The app verifies manifest signature, archive hash, then the platform signature; stages beside the install; swaps by rename; keeps the previous payload; a watchdog confirms the first launch or swaps back |
| Cost | 6 | 8-10 | 7 (the C-33 row's size) |
| Rollback | Must be written anyway | Neither library has one; must be written anyway, around a third-party installer step | Built in: it is the same rename, reversed |
| Risk | **High on Windows**: V6 shows no certificate today, so the only authenticity check would be TLS to GitHub. Medium on macOS | Medium-high: an Objective-C framework with its own XPC helpers inside a Rust bundle complicates the inside-out signing C-30 has to get right; WinSparkle runs an installer, tying update to D-05's installer choice; two UIs outside GPUI, outside the app's i18n, not "surfaced as Electron's is" | Medium: more of our own code on a path that can brick an install, offset by a state machine that is testable without the network and identical on both platforms. Key custody is a new human duty |
| N5/N6 idle | One timer per 6 h | Library-owned timers, not measured *(inferred negligible)* | One timer per 6 h; no redraw unless the state changes |
| N7/N11 playing | Download and hashing compete with playback unless deferred | Not controllable | Download and verification are deferred while the transport is playing or recording, and run as a child `curl` plus a low-priority hashing thread otherwise |
| N9 memory | Stream to disk | Framework resident, a few MB *(inferred)* | Stream to disk; nothing buffered |
| N12 startup | None | Framework load at launch *(inferred small)* | One `stat` of `<config>/updates/state.json`; no network before first interactive frame |
| N14 size | None | Adds the framework and DLL to the package *(inferred a few MB)* | Adds one small verification crate. Disk: one previous payload is retained (at most one installer's worth) |

### 3.2 Channel

| | C-A: one app, channel is a setting | C-B: separate "Beta" app identity |
|---|---|---|
| How | Stable builds read the latest non-prerelease release; a "Receive beta versions" setting also considers prereleases. A build installed from a prerelease has it on by default | Prerelease tags build a second identity with its own bundle id and config |
| Cost | Included in C-33 | +3 (second identity through packagers, signing, workflow) and every stable tag must also build the beta identity |
| Risk | A beta user and a stable user share one config format: a prerelease must not write state the last stable cannot read | Low for users, high for release-pipeline complexity |

### 3.3 Handover

| | H-A: Electron installs native | H-B: native imports on first run, Electron unchanged | H-C: Electron offers, native imports |
|---|---|---|---|
| How | The last Electron build downloads and launches the native installer | Nothing in Electron; people find native on the release page | The last Electron desktop build shows an offer that opens the native download, and writes one small export file for the values native cannot read. Native imports on first run whichever way it was installed |
| Cost | 5 in the Electron tree, plus C-40 to C-42 anyway | 0 extra | 3 (C-44 as sized) |
| Risk | High: cross-app install from an unsigned Windows context, and it reaches into the tree Box ships from | Medium: no discovery; audio preferences cannot be imported (V16) | Low: Electron only opens a URL and writes a file in its own profile; native only reads |
| Budgets | None | None | Import runs once, before first interactive frame, bounded to small JSON files: it must fit inside N12 on the first launch too |

### 3.4 State policy alternatives

Share one profile directory (rejected: Electron rewrites `settings.json` whole and
non-atomically, V12, and would drop fields it does not know only by luck of its
spread-merge; two writers on tokens is a credential-loss path), import once
(chosen for everything personal), or leave behind (chosen for diagnostics and
transient UI state).

## 4. Recommendation

**Updater: U-C with channel C-A. Handover: H-C.** Identity is fixed now and never
changes.

### 4.1 Updater design

**Feed.** No server. Each release that ships native carries, per target
(`macos-arm64`, `macos-x64`, `windows-x64`):

- `singz-native-<target>.zip`: the update archive. macOS: the notarized, stapled
  `.app`, zipped with `ditto -c -k --keepParent`. Windows: the payload folder C-31's
  installer lays down, byte for byte.
- `singz-native-<target>.update.json`: `{schema, version, channel, target, archive:
  {name, bytes, sha256}, minOs, rollbackFloor, notesUrl}`.
- `singz-native-<target>.update.json.sig`: detached Ed25519 signature over the
  manifest bytes.

None of these names matches Electron's `latest*.yml`, `*.blockmap`, or the pack
name `gpu-splitter-…`, so Electron's Windows feed and both apps' pack URL (V5, V18)
are untouched. The human-facing `.dmg` and Windows installer stay separate assets.

**Lookup.** Stable:
`https://github.com/lexasoft123/SingZ/releases/latest/download/singz-native-<target>.update.json`
(a redirect, no API quota; a 404 means "latest has no native build" and is reported
as up to date). Beta: `api.github.com/.../releases?per_page=10`, highest version
that carries the manifest for this target. First check no sooner than 10 s after
the first interactive frame, then every 6 h (Electron's cadence, V1), plus "Check
now" in settings.

**Version rule.** Full semver precedence including prerelease identifiers, in a
pure module; `0.27.0-beta.2 < 0.27.0`. Never install a version that is not strictly
newer than the running one. Native's version is the release tag's version (V18);
`valid_version` (V19) must accept prerelease strings before the first `-beta` tag.

**Trust, in order, all required.** (1) Manifest signature against a public key
compiled into the binary; two key slots so a key can be rotated by shipping the
next key one release ahead. (2) Archive length and SHA-256 from the manifest, hashed
while streaming. (3) Platform check on the staged payload: macOS `codesign --verify
--deep --strict` with a designated requirement pinning the Team ID of the running
app, and Gatekeeper assessment; Windows Authenticode with the publisher pinned,
**only if** C-31 ships a certificate. Without a certificate the Ed25519 signature
is the Windows trust anchor, which is the reason U-A is rejected.

**Stage, swap, confirm, roll back.** One state machine, both platforms, durable in
`<config>/updates/state.json`:

```
idle -> downloading -> staged -> swapping -> pending-confirm -> confirmed
                                     |              |
                                     +-> aborted    +-> rolled-back (version blocked)
```

- Stage into a sibling of the install on the same volume, so the swap is a rename.
- Swap on restart ("Restart to update", and on quit when a payload is staged,
  matching Electron's Windows behaviour, V1). macOS: the running app exchanges the
  bundles with `renamex_np(RENAME_SWAP)`. Windows: the app copies its own, already
  trusted executable to `<config>/updates/applier/`, starts it with
  `--apply-update`, and exits; the applier waits for the app and all three helpers
  to exit (V23), renames `install -> previous`, `staged -> install`, with a bounded
  retry, and puts things back if the second rename fails.
- The process that performed the swap stays alive as a watchdog. It launches the
  new version and waits up to 60 s for a confirmation: main window presented,
  audio helper handshake answered, 20 s without exit. Confirmation marks the state
  `confirmed`. A crash, a non-zero exit or the deadline swaps back, relaunches the
  old version, and records the version as blocked so it is not offered again.
- Second line: a build that starts and finds itself `pending-confirm` for the
  second time rolls back before creating a window.
- The previous payload is kept until the next update is staged.
- Refuse to self-update, and fall back to Electron's `available` state with the
  download link, when the install is not writable (non-admin `/Applications`), is
  translocated or on a read-only volume, or another instance is running. V21: a
  single-instance guard is a prerequisite and is part of C-33.

**Compatibility rule that makes rollback safe.** A release must not write any
config or project state that the release named in its manifest `rollbackFloor`
cannot read. Confirmation is written before any one-way state migration runs.

**Surface.** The same six states as `UpdateState` (V3): a title-bar chip for
`ready` and `available`, progress in settings, the channel toggle and "Check now"
in settings, every string through the native i18n catalog.

**Not in the first version.** Delta updates, background install without a
restart, Linux (preview target: check and offer only), elevation prompts.

**Threat model** (coordinator decision, 2026-11-12). Trusted: the current
user and administrators (an administrator can replace the app, its install
folder or the user's files directly, so the updater does not try to defend
against one). Untrusted: other non-admin local users, plus the network and the
release feed (the manifest signature and archive hash are the authority for
what gets installed). The defences that follow from this: the update
coordination directory sits beside the install, is created private (macOS
`0700`; Windows a protected DACL for the user, SYSTEM and Administrators only)
and must be owned by the user, not a link or reparse point, without a macOS
ACL, before it is used; an unsafe or foreign directory is left untouched and
the app offers the download link instead. No file is created by a predictable
name or opened through a link. Uninstall deletes only what the current and
original inventories list, walking from a handle on the install folder and
refusing every link or junction; a refusal stops the uninstaller with
everything else left in place.

Accepted residual risks:

- Something running as the user or as an administrator can tamper with the
  install, its inventories or the coordination directory; nothing stops that.
- On macOS an administrator (every admin user can write `/Applications`) can
  rename or replace the coordination directory between its check and later
  path-based use; the directory is checked when used, not held open.
- On Windows the uninstaller pins each ancestor folder while it deletes inside
  it, but swapping an ancestor needs write access inside the user's own
  install, which only the user or an administrator has. No oplock or
  transaction machinery is used against that.
- Windows `sync_dir` is a no-op (NTFS journals metadata); power-loss
  durability of directory entries there rests on NTFS, not on a flush.
- The marker files that identify Windows payloads are labels bound to the
  transaction, not authentication: whoever can write the install can forge
  them, which the model already trusts.
- Denial of service by another local user (for example pre-creating an
  unsafe coordination directory) is out of scope beyond the fallback: the app
  then offers the download link instead of updating itself.

### 4.2 Identity during coexistence (permanent)

| | Electron desktop (unchanged) | Native |
|---|---|---|
| Bundle id / AppUserModelID / uninstall key | `com.lexasoft.singz` | `com.lexasoft.singz.native` |
| Config root | `<appData>/SingZ` | `<appData>/SingZ-GPUI` (kept: hidden from users, and renaming buys nothing but a migration) |
| Models and pack | `<appData>/SingZ/{models,gpu-splitter}` | the same directories (V10) |
| Library | `~/Documents/SingZ` or `projectsRoot` | the same |
| macOS bundle name | `SingZ.app` | `SingZ Beta.app` in prerelease artifacts, `SingZ.app` in stable artifacts; an in-place update never renames what is installed |
| Windows install dir | NSIS per-user default *(inferred `%LOCALAPPDATA%\Programs\SingZ`)* | its own per-user directory, never Electron's; exact form is D-05's, with the constraints in section 5 |

Consequence of the naming: during beta both apps sit side by side under different
names, which is the plan's coexistence constraint. From the first stable native
release, installing native on a Mac replaces `SingZ.app` in `/Applications` when
the user says so, and reinstalling the Electron fallback replaces it back; neither
touches the other's state because state lives outside the bundle in different
roots. The bundle id never changes, so the microphone grant, the updater and the
config root are stable across beta and stable. The name is a product choice and is
listed for sign-off.

### 4.3 Handover and state policy

Electron never writes native state. Native never writes Electron state. The
import runs once per item, on first launch, before the first window; each item's
outcome is recorded in `<config>/migration.json`, and a recorded item is never
imported again even if Electron's value changes later. An item native already
holds a non-default value for is skipped and recorded as `kept-native`. Electron's
files are opened read-only, size-bounded, without following symlinks; a parse
failure (possible mid-write, V12) is "try again next launch", not "done". The source
is the desktop profile only, never `SingZ Box` (V7).

| State | Policy | Note |
|---|---|---|
| Project library and documents | **Shared** | Same folder already (V11) |
| Custom library root (`projectsRoot`) | **Import once** into `library.json` | Only if absolute and an existing directory (native's stricter rule, V11) |
| Models, splitter pack | **Shared** | Already the default (V10); C-42 proves it and guards format and concurrent download |
| Language | **Import once** into `language.json` | |
| Release notes seen | **Import once** as the baseline | So the first native launch does not replay old notes |
| Window geometry | **Import once**, size and maximized flag only, through native's own display validation | Position is not imported |
| Drive sign-in | **Import once**, through `TokenStore`, only when the Electron token's client equals native's baked client id and `authMode` is not `device`; otherwise ask to sign in | V12-V14. The two apps then hold the same refresh token independently. Sign-off item |
| Sync dirty ledger | **Import once, conservatively**: every Electron dirty dir becomes dirty in native under fresh native sequence numbers; `allSeq > 0` becomes whole-library dirty; a clean Electron ledger imports as clean. `gdriveLastSync` is imported for display only | Safe because the ledger never decides what is uploaded (V15); the zero-upload guarantee comes from the planner's diff, which depends on C-11/C-12 |
| Audio devices, metronome, karaoke and training display preferences | **Import once from an export file** `<userData>/native-handover.json` that the C-44 Electron build writes from its renderer state (V16). Device ids are validated against present devices; absent file means defaults | Users who never ran the C-44 build get defaults |
| Training preferences and receipts | **Import once**, receipts copied if the schema matches | R-03 *(inferred)*; not in C-40's row today, see section 5 |
| Qwen offer dismissed | **Import once** | |
| Sync log, logs, per-project selection, welcome dismissal, Chromium caches | **Left** | |

**The offer (C-44).** The last Electron desktop build checks the release it already
fetches for the native manifest of its platform. While native is prerelease-only it
adds one quiet entry ("Try the new SingZ (beta)") in settings and What's New. Once
a stable release carries native it shows the title-bar chip with "Get the new
SingZ", opening the native download for the platform. It installs nothing. Box
shows none of it (V4). Electron's version compare (V2) already ignores prerelease
suffixes, so a native beta tag cannot trigger a false Electron update.

**The way back.** Native settings carry "Use the previous SingZ", which opens the
pinned Electron fallback release. Because nothing of Electron's was modified, the
old app opens as it was left; changes made in native since (library root, Drive
sign-in, preferences) are not carried back, and the dialog says so.

**Electron after the switch.** One more Electron desktop release line as fallback
(plan section 6, *inferred there*): it keeps receiving its `latest.yml`, and its
Windows auto-update keeps working. The release after that stops publishing
Electron desktop assets; the Electron tree stays for Box.

## 5. Consequences

- **New standing duty: the update key.** Whoever holds the Ed25519 private key can
  ship code to every install; losing it strands installs on the last version
  signed with it unless the second key slot was provisioned. It lives in CI
  secrets and an offline copy, never in either repository.
- **For D-05 (not decided here, but constrained).** The Windows install must be
  per-user and writable without elevation; the updater swaps the payload directory
  itself and never runs the installer; the installer's uninstall key and shortcuts
  must be distinct from Electron's and must survive a payload swap; uninstall
  leaves `<appData>/SingZ`, `<appData>/SingZ-GPUI` and the library. The macOS
  packager must emit the update zip from the stapled bundle. A release build must
  be able to point the updater at a local feed only under D-05's `test-hooks`
  feature, never through a plain environment variable in a shipped binary.
- **For C-30/C-34.** `BUNDLE_ID` and the bundle name in
  `scripts/package-gpui-macos.py:27,462` change to section 4.2's values. C-34
  signs manifests and attaches the three assets per target, and must prove
  Electron's `latest*.yml` is unchanged.
- **Version strings.** V19 has to be fixed before the first `-beta` tag, or the
  release-notes path rejects the app's own version.
- **Single instance.** V21: the guard is new work inside C-33.
- **C-42 shrinks.** The default roots already coincide (V10); what remains is the
  proof, the `PACK_FORMAT_REQUIRED` check, and two desktops downloading one model
  at once. Likely 1-1.5 days rather than 2.
- **C-40 grows slightly** if training receipts are included (+0.5); the
  coordinator should add them to the row or defer them by name.
- **Two apps, one refresh token.** If Google rejects the token for one app
  (revoked in the account page), each app independently drops to signed-out;
  Electron deletes its copy (V12). Neither can sign the other out, since neither
  revokes.
- **Beta sync.** No cross-app local sync lock is added. Safety when both desktops
  sync one Drive library rests on C-43's cross-writer suite, so no beta build
  ships with sync enabled before C-43 is green (the plan's own risk response).
- **Disk.** One retained previous payload per install.
- **Budgets.** No change to N1-N4, N8, N10, N13. N5/N6: one 6 h timer. N7/N11:
  download and verification wait for an idle transport. N12: one `stat` at launch,
  and the one-time import must be measured inside the first-launch startup time.
  N14: the installer grows by one small crate; the update zip is a separate asset
  and is not the measured installer.

## 6. What the human must decide or sign off

Credentials and custody:

1. **Update-signing key.** Approve the Ed25519 scheme; generate the key pair and a
   second (rotation) pair; decide who holds the offline copy; add the private key
   as a CI secret. Nothing in C-33 can be accepted from "real signed artifacts"
   without it.
2. **Apple Team ID** to pin in the updater's requirement, and confirmation that
   the existing Developer ID certificate and App Store Connect key (V22) are to be
   used for the native app.
3. **Windows code-signing certificate**: yes or no (already listed for C-31). The
   updater works either way; with "no", the Ed25519 signature is the only
   authenticity check on Windows and SmartScreen warnings remain for first installs.
4. **OAuth client.** Confirm native release builds use the same Google OAuth
   desktop client as Electron (V14 was not checked). If they do not, Drive sign-in
   cannot be imported and every migrating singer signs in again.

Product choices:

5. **Name.** `SingZ Beta` for prerelease artifacts and `SingZ` from the first
   stable native release, as in 4.2; or a single different permanent name.
6. **Bundle id** `com.lexasoft.singz.native`, permanent. It cannot be changed
   later without a second migration and a new microphone prompt.
7. **Importing the Drive sign-in** from the Electron profile without asking,
   with a one-line notice, versus always asking to sign in again.
8. **Beta opt-in** as a setting inside one app (recommended) rather than a
   separate Beta app.
9. **Automatic rollback** that blocks the failed version without asking, and
   install-on-quit when an update is staged.
10. **Fallback length.** One Electron desktop release line after the switch, then
    Electron desktop assets stop.
11. **Offer wording and timing** in Electron: quiet entry during beta, title-bar
    chip once native is stable.
12. **Training receipts** in the first-run import, or deferred.

## 7. Outlines for the unblocked packages

Tiers follow plan section 2. Every `sol` package gets a Sonnet V-01 review before
the coordinator's gate. New Rust rule modules are pure (no I/O), per the plan's
first decided constraint.

### C-33 Updater — `sol`, effort high, then V-01 (`sonnet`). Depends: D-04 signed, D-05, C-30, C-31

| File | Content |
|---|---|
| `$G/src/updater_manifest.rs` (new, pure) | Manifest schema, semver precedence with prerelease, channel selection, target match, `rollbackFloor`, Ed25519 verification against two baked keys |
| `$G/src/updater_state.rs` (new) | The durable state machine in `<config>/updates/state.json`, blocked-version list, atomic publication via `project_store::replace` |
| `$G/src/updater_fetch.rs` (new) | Stable and beta lookup, streamed download through the `drive_http` curl path with resume, length and SHA-256 while streaming, deferral while the transport is busy |
| `$G/src/updater_stage.rs` (new) | Extraction to the same-volume staging sibling, path-escape checks, platform signature check, writability / translocation / second-instance refusal |
| `$G/src/updater_swap.rs`, `updater_swap_windows.rs` (new) | Rename swap, applier mode, watchdog, confirmation, rollback |
| `$G/src/updater_host.rs`, `$G/src/ui_updater.rs` (new) | The six states, title-bar chip, settings rows; UI test entry under the `ui-tests` feature |
| `$G/src/settings.rs`, `$G/src/header.rs` | Channel toggle, "Check now", progress, chip |
| `$G/src/main.rs` | `--apply-update` and pending-confirm handling before any window; single-instance guard; confirmation call after first interactive frame |
| `$G/src/release_highlights.rs` | `valid_version` accepts prerelease versions (V19) |
| `$G/Cargo.toml`, `Cargo.lock` | One Ed25519 verification crate, exact-pinned; an archive crate only if D-05 rules out system `ditto` / `tar` |
| `scripts/package-gpui-macos.py`, `scripts/package-gpui-desktop.py`, `scripts/sign-gpui-update.py` (new) | Update zip, manifest, signature |
| Locale catalogs | Updater strings in every locale |

Tests that prove it:

- `$G/src/updater_manifest_tests.rs`: version precedence table (including V2's
  case), wrong key, truncated signature, wrong target, downgrade, equal version,
  channel filtering. Negative control: flip one manifest byte.
- `$G/src/updater_state_tests.rs`: every transition, crash at each step replayed
  from the durable file, blocked version never re-offered.
- `tests/shared/test_gpui_update_manifest.py`: packager output verifies; a
  modified archive does not.
- `$G/tests/test_native_updater.py` (new driver, per-step and total deadline, muted
  and hidden): local feed, N to N+1, tampered archive refused, unsigned manifest
  refused, forced-failure build (crashes before confirming) rolled back to N and
  blocked, unwritable install falls back to `available`, download deferred during
  playback with `starvedBlocks` still 0.
- Acceptance run (human + coordinator): N to N+1 and a forced-failure rollback from
  real signed artifacts on the Mac and the Windows field laptop, limited user,
  non-ASCII profile path.

### C-40 First-run import — `sol`, effort medium, then V-01. Depends: D-04 signed, R-03

| File | Content |
|---|---|
| `$G/src/migrate_plan.rs` (new, pure) | Given parsed Electron settings, handover export and current native state, returns per-item actions (`import`, `kept-native`, `skip-invalid`, `retry-later`) |
| `$G/src/migrate_source.rs` (new) | Locates the Electron desktop profile per platform, bounded read-only reads, torn-read detection |
| `$G/src/migrate.rs` (new) | Applies actions through each store's own writer (`project_library`, `locale_service`, `desktop_window_state`, `audio_devices`, `release_highlights`, `training_store` if approved); writes `<config>/migration.json` |
| `$G/src/settings.rs` | A read-only "Imported from your previous SingZ" summary |
| `$G/src/main.rs` | One call before the first window |

Tests: `$G/src/migrate_plan_tests.rs` over fixture profiles for the desktop identity
on macOS and Windows layouts, plus a Box profile that must be ignored; second run is
a no-op (byte-identical native config, Electron fixture hashes unchanged, which is
also the proof it never writes Electron's files); torn `settings.json` retries;
relative or missing `projectsRoot` is skipped; stale audio device id falls back.
Negative control: remove the "already recorded" check and the re-run test must fail.
Startup time with a full fixture profile stays within the Q-02 threshold.

### C-41 Drive sign-in and ledger adoption — `sol`, effort high, then V-01. Depends: D-04 signed, R-03, sign-off items 4 and 7

| File | Content |
|---|---|
| `$G/src/drive_auth.rs` | A `TokenStore` import entry that takes validated tokens and bumps the generation; client-id and `authMode` match rule; no raw file writes |
| `$G/src/sync_dirty.rs` | A conservative adopt operation: marks under fresh native sequence numbers, whole-library mark when Electron's `allSeq > 0` or more than 100 dirs |
| `$G/src/drive_state.rs` | Last-sync display value |
| `$G/src/migrate_plan.rs`, `migrate.rs` | Two more items, same record |

Tests: `drive_auth_tests.rs` (client mismatch, device-mode token, malformed secret,
existing native session kept); `sync_dirty_tests.rs` (dirty in, dirty out; clean in,
clean out; Electron sequence numbers never copied); a fake-Drive round trip in
`$G/tests` where Electron's real sync publishes, native adopts and its first sync
performs zero uploads, with a negative control that edits one file and expects
exactly one. The token never appears in logs or in `migration.json`.

### C-42 Shared models, packs and caches — `sol` per the plan, effort low. Depends: C-32, R-03

| File | Content |
|---|---|
| `$G/src/model_catalog.rs`, `model_install.rs`, `model_service.rs` | Keep the shared roots (V10); enforce Electron's `PACK_FORMAT_REQUIRED`; an install lock so two desktops do not extract one pack at the same time |
| `$G/src/source_jobs.rs` | Only if a splitter cache format is shown to match; otherwise left alone and stated |

Tests: a profile with Electron-downloaded models present triggers zero downloads
(request log from the fixture server is empty); a pack with the wrong format is
reported as not installed rather than used; two concurrent installs serialize.

### C-43 Two desktops, one Drive library — `sol`, effort high, then V-01. Depends: C-12, D-04 signed

D-04 adds no file to the plan's row. It fixes two rules the suite must assert:
both apps may hold the same refresh token at once, and neither app's ledger is
visible to the other, so convergence must come from the planner's diff alone.

Files: `$G/src/drive_sync.rs`, `drive_adopt.rs`, `drive_retirement.rs`,
`drive_snapshot.rs`; new `tests/roundtrip/` cross-writer suite. Tests: alternating
real TypeScript and Rust syncs against one fake Drive converge within two rounds
and then upload nothing; `catalog.json` bytes are stable across writers; an edit
made in Electron after the import is uploaded by native's next full sync although
native's ledger is clean; phone-published folders survive both.

### C-44 Electron-side handover — `sonnet`, effort medium. Depends: D-04 signed, C-33, C-34

| File | Content |
|---|---|
| `src/main/updater.ts` | Detect the native manifest asset for this platform in the release already fetched; expose "native available" with channel and download URL. Windows electron-updater flow unchanged |
| `src/shared/types.ts` | Extend `UpdateState` or add a sibling handover state |
| `src/main/native-handover.ts` (new), `src/main/index.ts`, `src/preload/index.ts` | Write `<userData>/native-handover.json` (schema-versioned, no secrets) from renderer-reported preferences; IPC returning result objects |
| `src/renderer/src/App.tsx`, settings and What's New components | The quiet beta entry, the stable chip, reporting the `localStorage` preferences to main |
| `src/shared/i18n` catalogs | Strings in every locale |
| `src/main/launch-surface.ts` | Only if a separate gate is needed; Box must stay excluded through `desktopUpdaterEnabled` |

Tests: unit tests for manifest detection and for the export file's schema; an
Electron e2e driver (watchdog armed) with a local release fixture showing the offer
on the desktop surface and **not** on the Box surface; the export file round-trips
into C-40's fixtures; a prerelease-only fixture shows the quiet entry and no chip.
Acceptance (human): on both platforms an Electron install follows the offer to
native, imports, and returns through "Use the previous SingZ" to an unchanged
Electron.

## 8. What this unblocks

C-33 and C-40 to C-44 once section 6 is signed. C-33 additionally needs D-05, C-30
and C-31; C-41 needs items 4 and 7; C-44 needs C-34's asset names, which section
4.1 fixes.
