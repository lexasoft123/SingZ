# D-05 — What is the release layout and the reproducible build?

Decision record, written 2026-11-10 against `codex/gpui-interface` with the C-03
changes (release profile, pinned `singz-uikit`, packager refusals), since committed
as `f68b27e`. Paths are relative to the repository root; `$G` is
`experiments/gpui-player`. Line numbers are at `f68b27e`; the H-01 citation check
confirmed the C-03-dependent ones there. Anything marked *(inferred)* was not checked
against code; that includes platform behaviour (codesign, TCC, cargo, NSIS) that
this tree cannot prove. Nothing was built for this record. `cargo` is not on this
shell's `PATH`, so cargo behaviour is stated from knowledge, not from a run. The
existing `$G/target/release/singz-gpui-player` (built 2026-11-10 23:18) was
inspected with `ls`, `grep -a` and `strings`.

## Question

What does a shipped native SingZ consist of, where does each piece sit on disk,
in what order is it signed, and what makes two builds of the same commit the same
build? Seven sub-questions: crate location; how `singz-uikit` is pinned; release
profile; how test gates stay out of the shipped binary while qualification still
drives a release-profile build; bundle layout and signing order; Windows installer
technology; where splitter packs and models live.

Bundle identifier, product name during coexistence, install path handover and the
update feed belong to D-04. This record fixes the layout they plug into and names
the seams.

## Inputs, and what was verified

| Claim | Evidence | Status |
|---|---|---|
| C-03 staged state: release profile `opt-level 3`, thin LTO, 16 codegen units, `line-tables-only`, `strip = "symbols"` | `$G/Cargo.toml:41-46` | Verified |
| `singz-uikit` is a git dependency at rev `1c1081ad`, and the lockfile records that commit | `$G/Cargo.toml:14`; `$G/Cargo.lock:6287-6289` | Verified |
| The packagers still read the font licences from a sibling checkout, not from the pinned source | `scripts/package-gpui-macos.py:431`; `scripts/package-gpui-desktop.py:439` (`ROOT.parent / 'singz-ui'`) | Verified. The sibling here happens to sit at `1c1081ad`; nothing enforces it |
| The packagers decide "release" from the directory name | `validate_runtime_profile`, `scripts/package-gpui-macos.py:35-41`, `scripts/package-gpui-desktop.py:27-33` | Verified. `cargo build --release --features ui-tests` also lands in `target/release`; only the marker check (`:43-45`, `:35-37`) separates them |
| The stripped arm64 release binary is 55.3 MB | `ls -la $G/target/release/singz-gpui-player` → 55,319,888 bytes | Verified for that one build. Helpers and engines were not measured |
| The release binary embeds the builder's home directory | `strings -a` finds 1,095 strings under `/Users/<user>/.cargo/registry/...` | Verified. Not reproducible across machines, and it leaks the build account |
| The default release binary contains `SINGZ_GDRIVE_CONFIG`, `SINGZ_GPUI_DEMO`, `SINGZ_GPUI_CAPTURE_FILE`; it does not contain `SINGZ_GPUI_DRIVE_TEST` or the `ui-tests` marker | `grep -a -c` on the release binary: 1, 1, 1, 0, 0 | Verified. Confirms R-06 section 5 |
| R-06 section 1 readers | `$G/src/drive_auth.rs:68`; `$G/src/integration.rs:340-348` (`fixture_mode` and its key scan); `$G/src/main.rs:1432`, `1439`, `1583`, `1631`, `3422`, `4473-4474`; `$G/src/locale_service.rs:42-43`; `$G/src/model_catalog.rs:183` | Verified at working-tree lines. The rest of R-06's tables were not re-walked |
| `ui-tests` is the only feature, used at 419 `cfg` sites | `$G/Cargo.toml:8`; `grep -rn 'feature *= *"ui-tests"' $G/src \| wc -l` | Verified |
| Helpers are found next to the running executable | `$G/src/main.rs:1300-1301`; `$G/src/microphone.rs:764-766`; `$G/src/analyze_provenance.rs:108-114` | Verified |
| Pitch model and training sounds are read from `Contents/Resources` in a bundle, adjacent otherwise | `$G/src/microphone.rs:712-720`; `tools/native/singz-gpui-audio.cpp:699-700` | Verified |
| Engines are searched at `<exe dir>/`, `<exe dir>/engines/`, `<exe dir>/../Resources/engines/`, then a **compile-time checkout path**, then the **Electron app's** engines | `$G/src/lyrics_align.rs:264-301` (`CARGO_MANIFEST_DIR/../../vendor` at 291-294; `/Applications/SingZ.app/Contents/Resources/engines` at 296-299) | Verified. The last two are in the shipped binary today |
| macOS packager layout: four executables in `Contents/MacOS`, FFmpeg dylibs in `Contents/MacOS/ffmpeg`, codec receipts, pitch, sounds, licences and engines under `Contents/Resources` | `scripts/package-gpui-macos.py:460-476`, `379-390` | Verified |
| macOS signing today is ad-hoc only, in path-sorted order, with no hardened runtime and no entitlements | `scripts/package-gpui-macos.py:501-506` | Verified |
| The Windows/Linux packager has no engines option and builds a folder, not an installer | `scripts/package-gpui-desktop.py:426-428`, `411`, `510` | Verified |
| The process that opens the microphone is `singz-gpui-input` | `tools/native/singz-gpui-input.cpp:104-105` (`AudioInput::start`); `CMakeLists.txt:510-512` links the permission prompt and embeds `tools/native/gpui-input-info.plist` | Verified. `singz-gpui-audio` parks playback for monitoring (`:1196`, `:1384`) and has no capture path that I found |
| Electron's entitlements carry two JIT keys plus `device.audio-input`, on every signature | `build/entitlements.mac.plist`, `build/entitlements.mac.inherit.plist` | Verified. Their comment says which process TCC checks was never measured |
| Native models and packs already resolve to Electron's directories | `$G/src/model_catalog.rs:119-133` (`<appData>/SingZ/models`, `<appData>/SingZ/gpu-splitter`); `src/main/models.ts:17-23`; `src/shared/product-identity.ts:15` | Verified. Native's own settings live apart in `SingZ-GPUI` (`$G/src/audio_devices.rs:338-348`) |
| Pack download URL is the same release asset in both apps | `$G/src/model_catalog.rs:183`; `src/main/models.ts:538` | Verified |
| Pack format numbers | `$G/src/model_catalog.rs:28-30` (Windows 10, else 6); `src/main/models.ts:112` (Windows **and Linux** 10, else 6) | Verified. Linux differs; the native registry offers no splitter pack on Linux, so it is latent |
| The product version has two sources in the crate | `$G/Cargo.toml:3` is `0.1.0`; `package.json:3` is `0.26.7`. `$G/src/model_catalog.rs:126` reads `package.json`; `$G/src/main.rs:3994` rebuilds the registry from `CARGO_PKG_VERSION`; `scripts/package-gpui-macos.py:412-414` defaults the bundle version from `Cargo.toml` | Verified by reading. Effect not run: a download started from the lyrics editor appears to ask for `v0.1.0/gpu-splitter-…` |
| Electron release assets and naming | `electron-builder.yml:82` (`SingZ-${version}-${os}-${arch}.${ext}`); upload glob `.github/workflows/build.yml:474`; hyphenated tags are prereleases at `:452` | Verified |
| Electron's Windows installer is NSIS, per-user, not one-click | `electron-builder.yml:223-229` | Verified |
| A new top-level directory is packaged into Electron's asar unless excluded | `electron-builder.yml:14-16`, `:35` (`!experiments/*`) | Verified |
| The crate reaches into the repository by relative path | `$G/build.rs:9`, `:20`; twelve `include_str!`/`include_bytes!("../../../…")` sites, e.g. `$G/src/model_catalog.rs:126`, `release_highlights.rs:19`, `source_jobs.rs:599`, `:846`, `lyrics_align.rs:1745-1747` | Verified |
| No toolchain pin, no cargo config, no Windows resource embedding | no `rust-toolchain*`, no `$G/.cargo/`; `$G/build.rs` has no icon or version resource step | Verified by listing and grep |
| No CI job builds the crate | no `cargo` or `gpui` in `.github/workflows/*` | Verified |
| R-08's claim that the native path has no workflow, signing, installer or updater | Follows from the rows above | Verified for what this record uses |

## Options

Costs are worker-days including review. "Budgets" refers to section 3.1 of the
plan.

### 1. Crate location

| Option | Cost | Risk | Budgets |
|---|---|---|---|
| **1a. Stay in `experiments/gpui-player` until the default switch (recommended)** | 0 | The name is wrong for a shipped product. Cosmetic once build paths are remapped (option 5) | None |
| 1b. Move now to a two-level path such as `desktop/native` | 2 | Every wave-2 and wave-3 package edits `$G/src`; a rename under them means a rebase for each. Eight files outside the crate, about eighty review documents and every plan document name the path. A new top-level directory needs its own exclusion in `electron-builder.yml` or it ships inside Electron's asar | None |
| 1c. Move after default, in one commit with no package in flight | 1, later | Low. A two-level destination keeps all `../../../` includes valid | None |

### 2. How `singz-uikit` is pinned

| Option | Cost | Risk | Budgets |
|---|---|---|---|
| **2a. Git revision in `Cargo.toml`, locked in `Cargo.lock` (staged; recommended)** | 0.5 to finish (licence source, override guard) | Needs network and read access to `lexasoft123/singz-ui` at build time; CI needs credentials if the repository is private. A local `paths` override in a cargo config would not show in the lockfile | None |
| 2b. Git submodule under `third_party/`, path dependency | 1 | Every worktree must initialise it; a stale or dirty submodule checkout compiles without complaint, which is the stale-binary trap again. Same GitHub dependency as 2a | None |
| 2c. Vendored copy under `$G/vendor/` like the six GPUI crates | 1.5, plus every later sync | Hermetic, but a second copy of a shared kit drifts. C-62 already assumes a pin bump, not an in-tree edit | None |

With 2a cargo itself guarantees the compiled source is the locked commit. That is
the property the other two only approximate, and it is why 2a wins despite the
network dependency.

### 3. Release profile

| Option | Cost | Risk | Budgets |
|---|---|---|---|
| **3a. Freeze the staged profile, add packed split debug info (recommended)** | 0.5 | `strip = "symbols"` with debug info left in object files keeps nothing to symbolicate a crash record with *(inferred)*. `split-debuginfo = "packed"` keeps a dSYM, `.dwp` or PDB beside the binary as a build artifact that is archived, not shipped *(inferred)* | Baseline for every N. N14: no change to shipped bytes |
| 3b. `codegen-units = 1`, fat LTO | 0.5, plus much longer links in CI and locally | Unmeasured gain. Changing the profile after Q-02 invalidates the baseline (plan rule 9) | N1-N3, N7, N12: unknown, possibly a few percent. N14: probably smaller *(inferred)* |
| 3c. `opt-level = "s"` or `"z"` | 0.5 | Trades frame time for size when size has headroom | N14 better; N1-N3 and N7 worse *(inferred)* |
| 3d. `panic = "abort"` | 0.5 | C-22 needs the hook to retire helpers and a worker panic to stay contained; that is D-01's call | N14 slightly better |

### 4. Test gates and the qualification build

| Option | Cost | Risk | Budgets |
|---|---|---|---|
| **4a. One feature, keep the name `ui-tests`; everything R-06 calls a test gate, fixture or dangerous read moves under it; a `qualify` profile that inherits `release` (recommended)** | 3 (this is C-23) plus 0.5 in C-03 | N1-N13 are then measured on the `qualify` binary, which carries cold test code the shipped binary does not. Mitigated by a ship-versus-qualify comparison on the scenarios that need no hooks | Shipped binary shrinks slightly. Measurement rule changes: see Consequences |
| 4b. Two features: `test-hooks` (env gates) and `ui-tests` (driver modules) | 4.5 | Three build variants instead of two; more ways to test the wrong binary. Nothing today needs hooks without drivers | Same as 4a |
| 4c. Rename `ui-tests` to `test-hooks` | 4 | 419 `cfg` sites and every driver document change for no behaviour | Same as 4a |
| 4d. Leave section 1 reads in the shipped binary so the perf harness can drive it | 0 | A shipped app that swaps its OAuth client, enters demo mode or follows a file for its playhead from the environment. Plan risk "test gates ship" stays open | Lets N1-N13 run on the exact shipped binary |
| 4e. A narrow always-on automation channel in the shipped binary | 6+ | New attack surface; a second driver protocol to qualify | Same as 4d |

### 5. What "reproducible" means

| Option | Cost | Risk | Budgets |
|---|---|---|---|
| **5a. Pinned inputs plus a build receipt the packagers require (recommended)** | 2, inside the final form of C-03 | Not bit-for-bit across machines; signing and notarization timestamps prevent that for the final artifact anyway | None |
| 5b. Bit-for-bit unsigned payload, verified by a second CI build | 5+ | MSVC and CMake determinism, FFmpeg and engine builds; little field value for a two-platform desktop app | None |
| 5c. Leave as staged (directory-name check and marker) | 0 | The check passes a hooks build placed in `release`; builds embed machine paths; no toolchain record | None |

### 6. Bundle layout and signing order

| Option | Cost | Risk | Budgets |
|---|---|---|---|
| **6a. Keep the layout the code already resolves; sign inside-out in explicit stages; microphone entitlement on the app and `singz-gpui-input` only (recommended)** | Inside C-30 and C-31 as sized | Notarization of dylibs under `Contents/MacOS/ffmpeg` and of executables under `Contents/Resources/engines` is untried for this bundle. Electron ships engines in `Resources/engines` notarized (`electron-builder.yml:133-135`), which covers half of it | N12: no extra hop. N14: per-architecture dmg keeps size at one slice |
| 6b. Apple-standard: dylibs to `Contents/Frameworks`, engines and helpers to `Contents/Helpers` | +2 | Helpers need a second rpath; four Rust resolution sites and the loose-folder layout change; every packager test moves | None |
| 6c. Universal macOS binary | +1.5 | Doubles every Mach-O | N14 worse by roughly the app's size again |

### 7. Windows installer technology

| Option | Cost | Risk | Budgets |
|---|---|---|---|
| **7a. NSIS, standalone `makensis`, Unicode, per-user (recommended)** | 5 (C-31 as sized) | Script language is awkward; the uninstaller must be signed through NSIS's finalize hooks *(inferred)* | N14: LZMA solid compression is the best of the four *(inferred)* |
| 7b. Inno Setup | 5 | Equal technically. A second installer technology beside Electron's NSIS; D-04's handover and silent-install flags would differ between the two desktops | N14 similar |
| 7c. WiX / MSI | 7 | Per-user MSI is awkward; upgrade rules and GUID discipline; heavier for the updater | N14 worse *(inferred)* |
| 7d. MSIX | 6 | Cannot be installed unsigned, so it is blocked on the certificate decision. Packaged apps get redirected `AppData`, which breaks the shared `%APPDATA%\SingZ\models` and pack directory *(inferred)* | N14 similar |

### 8. Where engines, splitter packs and models live

| Option | Cost | Risk | Budgets |
|---|---|---|---|
| **8a. `llama-server` and `crispasr` inside the bundle; packs and models downloaded on demand into the directories Electron already uses (recommended; it is what the code does)** | Inside C-32 and C-42 as sized | Two desktops can install or swap the same pack at once; C-42 needs a cross-process lock. The pack asset must exist on the same tag the native build reports as its version | N14: engines add their size, as they do in Electron. N9, N13: none |
| 8b. Native-only directories under `SingZ-GPUI` | +1 | Multi-gigabyte re-download on migration; contradicts C-42's acceptance | N14 same |
| 8c. Pack inside the installer | +1 | 286-361 MB per platform (`$G/src/model_catalog.rs` registry) | N14 fails outright |
| 8d. Engines downloaded on first use | +3 | First transcription needs the network; Electron ships them | N14 better; first-use latency worse |

## Recommendation

1. **Location: stay.** The crate stays at `experiments/gpui-player` until native is
   default, then moves once, to a two-level path, in a commit of its own (1c). No
   package in this plan depends on the name.

2. **`singz-uikit`: git revision, as staged.** Complete it: the release build must
   pass `--locked`; the build receipt records the resolved `singz-uikit` source
   from `cargo metadata` and the build fails if it is not the `Cargo.toml`
   revision; font licences are taken from that same resolved checkout and staged
   into the runtime directory, and the packagers stop defaulting to
   `ROOT.parent / 'singz-ui'`.

3. **Release profile: the staged values, frozen, plus `split-debuginfo = "packed"`.**
   Symbol files are archived per build and never packaged. Add
   `[profile.qualify] inherits = "release"` with no overrides. No further profile
   change before Q-02; after G0, `codegen-units = 1` and fat LTO may be tried
   inside C-73 as a measured experiment with N12 and N14 deltas.

4. **Test gates: one feature, named `ui-tests`.** That is "the feature D-05 names"
   for C-23. Two build kinds exist and no others:

   | Kind | Command shape | Output | May be packaged |
   |---|---|---|---|
   | ship | `cargo build --release --locked` (no features) | `$G/target/release` | Yes |
   | qualify | `cargo build --profile qualify --locked --features ui-tests` | `$G/target/qualify` | Only with `--allow-qualification`, and the result is named and marked as not for distribution |

   Moves under the feature (C-23): `SINGZ_GDRIVE_CONFIG`; `SINGZ_GPUI_DEMO` and the
   `fixture_mode` key scan; `SINGZ_GPUI_PROFILE`; `SINGZ_GPUI_CAPTURE_FILE`;
   `SINGZ_GPUI_OFFSCREEN_BENCHMARK`; `SINGZ_GPUI_TEST_NO_CAPTURE`;
   `SINGZ_E2E_HIDDEN`; `SINGZ_GPU_PACK_URL`; and the executable-path overrides
   `SINGZ_GPUI_AUDIO_HELPER`, `SINGZ_GPUI_INPUT_HELPER`, `SINGZ_GPUI_ANALYZER`,
   `SINGZ_GPUI_PITCH_MODEL`, `SINGZ_LLAMA_SERVER`, `SINGZ_CRISPASR`. The path
   overrides are gated because a child started by the app runs under the app's
   microphone grant on macOS *(inferred)*, so an environment variable should not
   choose that child in a signed build.

   Stays in the shipped binary as operator settings: `SINGZ_LANG`, `SINGZ_NO_SYNC`,
   `SINGZ_MODELS_DIR`, `SINGZ_PACK_DIR` (Electron honours both,
   `src/main/models.ts:17-23`), `SINGZ_GPUI_CONFIG_DIR`, `SINGZ_GPUI_PROJECTS_ROOT`,
   `SINGZ_NO_SYSTEM_ENGINES`, `SINGZ_DEMUCS`, and `SINGZ_GPUI_BACKGROUND` with
   `SINGZ_MUTE` in the helpers. The last two are what let the shipped artifact
   itself be smoke-launched hidden and muted (plan rule 4, C-03's acceptance).

   Also leaves the shipped binary: the `CARGO_MANIFEST_DIR/../../vendor` engine
   candidate (debug builds and `ui-tests` only) and the
   `/Applications/SingZ.app/...` candidate (removed outright once C-32 bundles the
   engines; it makes native run Electron's engines and hides a missing one).

   The C++ helpers are built once and used by both kinds. Their fixture modes stay;
   `singz-gpui-input` already refuses them without `SINGZ_MUTE`
   (`tools/native/singz-gpui-input.cpp:63`).

5. **Reproducible means pinned inputs and a receipt (5a).** A new
   `scripts/build-gpui-release.py` is the only supported way to produce a runtime
   directory. It pins the toolchain (`$G/rust-toolchain.toml`), builds with
   `--locked`, passes `--remap-path-prefix` for the cargo home and the checkout
   through the environment of that one build (never machine config), sets
   `SOURCE_DATE_EPOCH` from the commit, runs `scripts/build-gpui-native.py`, and
   writes `build-receipt.json` into the runtime directory: commit and dirty flag,
   `rustc -Vv`, `Cargo.lock` hash, profile, feature list, `singz-uikit` revision,
   analyzer source hash, codec receipt hash, and the SHA-256 of each executable.
   The packagers require the receipt, check each hash against the bytes they
   copy, refuse a non-empty feature list or a profile other than `release`, and
   keep the marker scan as a second line. The directory-name check is removed.
   `--allow-debug` and `--allow-qualification` remain as explicit escapes.

   The product version has one source, `package.json`. `build.rs` exports it; the
   crate uses it everywhere a version reaches the user or a URL; the packagers
   default to it. `CARGO_PKG_VERSION` stays only as `crateVersion` in
   `--native-build-info`.

6. **Layout: keep what the code resolves (6a).**

   macOS, one dmg per architecture, bundle name and identifier from D-04:

   ```
   <Name>.app/Contents/
     Info.plist
     MacOS/
       singz-gpui-player          main executable
       singz-gpui-audio           playback helper
       singz-gpui-input           capture helper (embedded Info.plist)
       singz-analyze              analyzer
       ffmpeg/                    four FFmpeg dylibs, @loader_path
     Resources/
       <icon>.icns
       pitch/  training-sounds/  licenses/
       ffmpeg/                    codec receipt and notices (no code)
       engines/                   llama-server, crispasr, their dylibs if any
   ```

   Signing order, each step `--options runtime --timestamp`, never `--deep`:

   1. FFmpeg dylibs, then any dylib under `Resources/engines`.
   2. `llama-server`, `crispasr`. No entitlements.
   3. `singz-analyze`, `singz-gpui-audio`. No entitlements.
   4. `singz-gpui-input`, with `com.apple.security.device.audio-input`.
   5. The bundle (main executable), with `com.apple.security.device.audio-input`
      and nothing else. No JIT keys: there is no V8.
   6. `codesign --verify --deep --strict`; notarize and staple the app; build the
      dmg from the stapled app; sign, notarize and staple the dmg *(inferred
      order; C-30 proves it with `spctl`)*.
   7. Write the manifest last, from the stapled bytes.

   Helper signing identifiers are `<bundle id>.audio`, `.input`, `.analyze`,
   passed explicitly; `tools/native/gpui-input-info.plist` is brought in line
   with whatever identifier D-04 picks. The entitlement sits on both the app and
   the capture helper because which of the two TCC holds to it has not been
   measured here either; Q-13 on a clean account is the proof.

   Windows, flat folder under a per-user install directory:

   ```
   singz-gpui-player.exe  singz-gpui-audio.exe  singz-gpui-input.exe  singz-analyze.exe
   <FFmpeg and runtime DLLs, adjacent>
   engines\llama-server.exe  engines\crispasr.exe  (+ their DLLs)
   pitch\  training-sounds\  licenses\  manifest.json
   ```

   Signing order: every DLL, then engines, then helpers, then the player, all
   inside the packager before the manifest hashes are taken; then the
   uninstaller, then the installer. SHA-256 digest and an RFC 3161 timestamp.
   The player gains an icon and a version resource (it has none today). Unsigned
   when no certificate is configured, with the manifest saying so.

   Linux stays a folder or archive preview with the same flat layout.

7. **Windows installer: NSIS (7a).** Per-user, no elevation, silent mode
   available to the updater, install directory and uninstall registry key
   distinct from Electron's until D-04 says otherwise. Uninstall removes the
   install directory only; never `%APPDATA%\SingZ`, `SingZ-GPUI` or the library.

8. **Engines in the bundle; packs and models on demand in the shared
   directories (8a).** The pack stays the Electron job's release asset; native
   builds and ships no pack of its own. Native release artifacts are written to
   `dist/native/` and named `SingZ-Native-<version>-<mac|win>-<arch>.<ext>`, so
   Electron's upload glob and its `latest*.yml` feed never see them. Any native
   update metadata D-04 adds must not be named `latest*.yml`.

## Consequences

- **C-23 moves to wave 1, directly after C-03 and before Q-02 and C-17.** Its
  inputs (this record and R-06) are ready then. It edits `main.rs` and
  `integration.rs`, which the C-17 chain owns in wave 2, so it must land first.
  It also defines the binary Q-02 measures; landing it after the baseline would
  change the measured program.
- **Measurement rule.** N1-N13 are measured on the `qualify` build, because the
  shipped binary can no longer be driven into a loaded, playing song from the
  environment. N14 is measured on the shipped artifact. Each Q-02 and Q-15 run
  adds one comparison on scenarios that need no hooks (cold launch to idle,
  60 s idle CPU, idle footprint) between ship and qualify; a difference outside
  machine noise blocks the run. Section 3.2's "release builds only" should be
  reworded to "the `release` or `qualify` profile, named in the result".
- **The plan's D-05 row lists C-19 as unblocked; the package that depends on
  D-05 is C-23** (`COMPLETION_PLAN.md:251`). C-19 is constrained only in that it
  must keep test-only `Player` state behind `ui-tests` and add no environment
  read. Both outlines are below.
- **C-03 grows by about 2 days** (receipt, release build script, toolchain pin,
  path remapping, version source, `qualify` profile, licence source). The staged
  work is kept, except the directory-name check, which the receipt replaces.
- **C-30 loses the Electron entitlement files as a model.** New, smaller files;
  no JIT keys. Its first task is a throwaway notarization of the current layout,
  because that is the one untried risk in 6a. If Apple rejects code under
  `Contents/MacOS/ffmpeg`, the fallback is `Contents/Frameworks` with a second
  rpath in the helper build (+2 days, and the helpers must be rebuilt).
- **C-31 adds resource embedding** to the player build (`$G/build.rs`, already on
  C-03's edit list, not on C-31's; the coordinator must extend C-31's list or
  fold it into C-03).
- **C-32 gains three items found here:** the desktop packager needs an engines
  option; the two stray engine candidates go; the version used for the pack URL
  at `$G/src/main.rs:3994` must become the product version. The last one touches
  `main.rs`, which is outside C-32's edit list; give it to C-03 with the version
  source.
- **Native and Electron releases share a tag.** The pack URL is built from the
  app version, so a native build whose version has no Electron release behind it
  cannot download a splitter. C-34 runs on the same `v*` tags.
- **Symbol files become a release by-product** to store privately per tag, or
  C-22's crash records cannot be symbolicated.
- **A shipped build no longer honours `SINGZ_GDRIVE_CONFIG`.** Anyone testing
  against a private OAuth client uses a qualify build or bakes the config
  (`SINGZ_GPUI_REQUIRE_DRIVE_CONFIG=1`, `$G/DESKTOP_PACKAGING.md:93-98`).
- **Budgets.** Nothing here spends against N1-N13. N14 has room on the evidence
  available: one 55 MB executable before compression against a 122 MB dmg. That
  is not a measurement; helpers, FFmpeg and both engines were not weighed. C-30
  and C-31 report the real artifact size.

## What the human must decide or sign off

1. **Crate stays in `experiments/` until default, then moves once.** Yes or no.
2. **Is `lexasoft123/singz-ui` private?** If so, CI needs a read credential for
   cargo's git fetch, and that secret has to be created. If a network fetch at
   build time is unacceptable, say so and the choice becomes the submodule (2b).
3. **Operator environment variables that stay in shipped builds:** the list in
   recommendation 4. In particular whether `SINGZ_DEMUCS` (run a user-supplied
   splitter command) and `SINGZ_GPUI_CONFIG_DIR` / `SINGZ_GPUI_PROJECTS_ROOT`
   are supported product settings or should be gated too.
4. **Accept the measurement rule:** N1-N13 on the qualify build, N14 on the
   shipped artifact, with the ship-versus-qualify comparison as the guard.
5. **Rust toolchain version to pin.** It could not be read here; the coordinator
   proposes the version the current builds use and the user confirms.
6. **Windows installer is NSIS**, and the **code-signing certificate decision**
   (none, OV, EV or a cloud signing service). Without one the installer ships
   unsigned and SmartScreen warns.
7. **Apple credentials:** reuse the Developer ID and App Store Connect key the
   Electron pipeline uses (`docs/MACOS-SIGNING.md`), under the same team.
8. **Per-architecture dmgs, not universal.**
9. **Microphone entitlement on the app and the capture helper only**, to be
   confirmed by the Q-13 prompt test on a clean account before any beta.
10. **Executable file names stay `singz-gpui-*`** through beta (display name comes
    from the bundle, the shortcut and the version resource), or D-04 renames them.
11. **C-23 moves to wave 1**, and the D-05 row's "C-19" is read as C-23.
12. **Where symbol files are kept** (private artifact storage; not the public
    release).

## Outlines for the unblocked packages

Model tiers follow section 2 of the plan.

### C-03 final form — release profile, receipt, honest packaging inputs

Tier: `gpt-reserve`, medium. Size 5 (was 3).

Edit:
- `$G/Cargo.toml`: keep `[profile.release]`; add `split-debuginfo = "packed"`;
  add `[profile.qualify] inherits = "release"`.
- `$G/rust-toolchain.toml` (new): exact channel, plus the targets CI builds.
- `$G/build.rs`: export the product version from `package.json`; embed the
  Windows icon and version resource.
- `$G/src/native_build_info.rs`: add `appVersion`, `profile`, `features`.
- `$G/src/model_catalog.rs:126`, `$G/src/main.rs:3994`: one version accessor.
- `scripts/build-gpui-release.py` (new): the steps in recommendation 5; takes
  `--kind ship|qualify`; holds the native build lock for the helper build.
- `scripts/package-gpui-macos.py`, `scripts/package-gpui-desktop.py`: require and
  verify `build-receipt.json`; replace `validate_runtime_profile`; add
  `--allow-qualification`; licences from the runtime directory; version default
  from `package.json`; honour `SOURCE_DATE_EPOCH`.
- `scripts/build-gpui-native.py`: unchanged default; called by the new script.
- `$G/Cargo.lock`, `$G/DESKTOP_PACKAGING.md`.
- `tests/shared/test_package_gpui_profile.py`, `test_package_gpui_macos.py`,
  `test_package_gpui_desktop.py`; new `tests/shared/test_build_gpui_release.py`.

Tests that prove it:
- Receipt tests: missing receipt, hash mismatch, non-empty features, profile
  `qualify` without the flag, and dirty tree each refuse; a matching receipt
  passes. Each must fail against the staged packagers.
- `strings` on a ship binary built by the script finds no path under the
  builder's home or the checkout (negative control: the existing binary has
  1,095).
- Two ship builds of one commit on one machine give identical player hashes
  *(expected; if not, report what differs rather than relaxing the test)*.
- A Rust test asserts the exported version equals `package.json`.
- A ship package launches hidden and muted and exits cleanly.

### C-23 — test gates out of the shipped binary

Tier: `gpt-reserve`, medium, as catalogued. Size 3. Runs in wave 1 after C-03.

Edit:
- `$G/src/drive_auth.rs:68` and its callers `drive_service.rs:62`,
  `drive_restore_service.rs:61`.
- `$G/src/integration.rs:340-348` (`fixture_mode` returns `false` without the
  feature), `:1692`.
- `$G/src/main.rs`: 1300, 1432, 1439, 1583, 1631, 3422, 4473-4474.
- `$G/src/locale_service.rs:43`; `$G/src/model_catalog.rs:183`.
- Helper and engine path overrides: `$G/src/audio_devices.rs:177`,
  `beat_analysis.rs:607`, `lyrics_align.rs:265`, `:291-299`, `:861`,
  `project_key.rs:192`, `microphone.rs:764`, `:771`, `analyze_provenance.rs:100`.
  Route them through one small function so the gate is in one place.
- `$G/src/library.rs`, `$G/src/header.rs` demo-mode sites R-06 lists.
- New `tests/shared/gpui-gated-env-names.json`, generated from the source and
  checked by a test; the packagers scan the player for every name in it.
- `$G/tests/` drivers and `$G/README.md`, `$G/NATIVE_INTEGRATION.md`: build line
  becomes the qualify build.

Tests that prove it:
- The list test: every `SINGZ_` name read in `$G/src` is either in the operator
  allow-list or in the gated list; a new ungated read fails it.
- `strings` on the ship binary finds none of the gated names; the same check on
  the qualify binary finds them (negative control).
- Unit tests: without the feature, `SINGZ_GDRIVE_CONFIG` is ignored and
  `fixture_mode()` is false with `SINGZ_GPUI_DEMO` set.
- Every `$G/tests/test_native_*.py` driver green on the qualify build.

### C-19 — collapse `Player` pending state (constraint only)

Tier: `gpt-reserve`, medium, as catalogued. D-05 adds no files. Rules: fields and
methods that exist only for drivers stay behind `ui-tests`; no new environment
read outside the gated accessor C-23 introduces; acceptance runs on the qualify
build, and the ship build must still compile with no features (CI builds both).

### C-30 — macOS signing, notarization, dmg

Tier: `gpt-reserve`, medium; a Sonnet read of the entitlements and signing order
before the gate, since the last entitlement mistake reached the field
(`build/entitlements.mac.plist` comment).

Edit:
- `scripts/package-gpui-macos.py`: `--sign-identity`, staged signing in the order
  above, explicit identifiers, entitlements per target, notarize and staple,
  dmg creation, manifest after stapling; ad-hoc path kept for missing secrets
  and given the same staged order.
- `build/native/entitlements.gpui.app.plist`,
  `build/native/entitlements.gpui.input.plist` (new).
- `tools/native/gpui-input-info.plist` (identifier per D-04).
- `docs/MACOS-SIGNING.md` (native section), `$G/DESKTOP_PACKAGING.md`.
- `tests/shared/test_package_gpui_macos.py`.

Tests that prove it:
- Extend `test_signing_order_and_failure_cleanup`: the recorded `codesign` calls
  are in stage order, carry `--options runtime`, and only the app and
  `singz-gpui-input` receive entitlements. Must fail on a path-sorted order.
- On a signed build: `codesign --verify --deep --strict`; `codesign -d
  --entitlements` per executable matches the table; `spctl -a -t open
  --context context:primary-signature` on the dmg and `spctl -a` on the app
  inside a quarantined mounted copy.
- Hidden, muted launch from the mounted dmg; all eight codec fixtures decode
  from the signed bundle (existing check, `$G/DESKTOP_PACKAGING.md:85-90`).
- Human: microphone prompt on a clean account (Q-13).

### C-31 — Windows installer and Authenticode

Tier: `gpt-reserve`, medium.

Edit:
- `scripts/package-gpui-desktop.py`: optional signing step between copy and
  manifest; `--installer` output.
- `installer/windows/singz-native.nsi` (new) and its include files.
- `$G/build.rs` resource embedding if not already done in C-03.
- `tests/shared/test_package_gpui_desktop.py`; `$G/DESKTOP_PACKAGING.md`.

Tests that prove it:
- Unit: signing calls are ordered DLLs, engines, helpers, player, and the
  manifest hashes equal the signed bytes; with no certificate the manifest
  records `unsigned`.
- Script test: the uninstall section names only paths under the install
  directory (a grep-level guard against deleting `%APPDATA%`).
- Field laptop, limited user, non-ASCII profile path (human): silent and
  interactive install, launch, uninstall; models, packs, settings and library
  untouched; Electron's install untouched; `signtool verify /pa` on every PE
  when a certificate is present.

### C-32 — engines, packs and models in the shipped layout

Tier: `gpt-reserve`, medium.

Edit:
- `scripts/package-gpui-desktop.py`: `--engines-dir` with the same
  pure-native guard the macOS packager has.
- `$G/src/lyrics_align.rs:264-301`: candidates reduced to the bundled locations
  in ship builds.
- `$G/src/model_catalog.rs:28-30`: Linux pack format aligned with
  `src/main/models.ts:112`, or a comment and test stating why it differs.
- `$G/src/model_install.rs`, `engine_status.rs` as catalogued.
- `scripts/build-gpui-release.py`: stage `vendor/<platform>-<arch>/llama-server`
  and `crispasr` (from `scripts/vendor-llama.sh`, `vendor-crispasr.sh`) into an
  engines directory and record their hashes in the receipt.

Tests that prove it:
- Unit: with Electron's `/Applications/SingZ.app` present and no bundled engine,
  a ship build reports the engine missing (fails today).
- A shared case table for the pack format and the pack URL, read by a vitest
  suite and a Rust test, so the two registries cannot drift.
- Packaged app, both platforms: one split and one transcription, with
  `HF_HUB_OFFLINE=1` observed on the engine processes; zero downloads when
  Electron's models are present.

### C-33 — updater (layout constraints only; D-04 designs it)

Tier: `gpt-6.1-sol`, as catalogued, with the V-01 Sonnet review.

What D-05 fixes for it:
- macOS: replace the whole `.app`; verify the Developer ID team and the stapled
  ticket of the new bundle before the swap. Never patch files inside a signed
  bundle.
- Windows: run the signed NSIS installer silently into the same directory;
  verify its Authenticode publisher first.
- The update unit is the installer artifact named in recommendation 8, checked
  against the manifest hash.
- Helpers must be stopped before the swap (D-01's supervisor).
- The updater reads the product version from the single source C-03 adds.

Files and tests are D-04's to outline; the two that follow from this record are
an update test that proves helpers are gone before files move, and a test that
an artifact with a different signer is refused.

### C-34 — release workflow

Tier: `gpt-reserve` as catalogued. The workflow rules C-04 was given to Sonnet
for apply here too (pinned runners, `paths-ignore`, never an allow-list); either
hand C-34 to Sonnet or have Sonnet review it. The coordinator chooses.

Edit:
- `.github/workflows/build-native.yml` (new, separate from `build.yml` so a
  native failure cannot block or alter the Electron release): `v*` tags and
  manual dispatch; macOS arm64 and x64, Windows x64; runs
  `scripts/build-gpui-release.py --kind ship`, the packagers, and uploads from
  `dist/native/` only.
- `docs/release-notes/` conventions unchanged; no edit to `build.yml` unless the
  asset-name guard below needs one.

Tests that prove it:
- A `-test` tag: signed native artifacts attached, the release marked
  prerelease, and the Electron `latest*.yml`, `.blockmap`, dmg, exe and pack
  assets byte-identical before and after the native job (compare digests).
- A step that fails the job if any native asset name matches `latest*.yml` or an
  Electron `artifactName` pattern.
- The job fails when the receipt shows a dirty tree or any feature.
- Symbol files uploaded as a private workflow artifact, never to the release.

## Not checked

- No build was run: cargo's handling of `split-debuginfo`, `--remap-path-prefix`
  and a custom profile directory is stated from knowledge.
- Which process macOS TCC attributes microphone access to for a helper started
  by the app. Electron's own notes leave the same question open.
- Whether Apple's notary accepts dylibs in a subdirectory of `Contents/MacOS`.
- Sizes of the three helpers, the FFmpeg libraries and both engines; the dmg and
  installer sizes behind N14.
- Whether `lexasoft123/singz-ui` is private, and the Rust version in use.
- Electron's Windows install directory and uninstall key; NSIS and Inno Setup
  availability on the hosted Windows runner.
- R-06's full tables beyond the sites cited above; the C++ helpers' other
  `getenv` reads beyond the three files grepped (`SINGZ_MUTE` only was found).
- That `$G/src/main.rs:3994` produces a wrong pack URL at run time; this is read
  from the code, not reproduced.
- The four Rust `helper` override sites not opened individually
  (`audio_devices.rs:177`, `beat_analysis.rs:607`, `lyrics_align.rs:861`,
  `project_key.rs:192`) were confirmed by grep only.
