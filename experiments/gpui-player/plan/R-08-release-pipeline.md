# R-08 — Electron release pipeline vs native packagers

Evidence is from commit `f76073111f4171a9faf86fc63b0168f79c21148f`. Line references are repository-relative.

## Side-by-side steps

| Step | Electron pipeline | Native packagers |
|---|---|---|
| Trigger and runner | Release workflow runs on `v*` tags, manual dispatch, and weekly schedule; matrix builds macOS arm64+x64 and Windows x64 (`.github/workflows/build.yml:3-43`). | No release workflow for GPUI is present in the cited packaging docs; documented commands package a prebuilt runtime on the invoking host (`experiments/gpui-player/DESKTOP_PACKAGING.md:7-16`). *(inferred)* |
| Source/setup and verification | Checks out tag/ref with submodules, validates recovery-tag/version/notes, installs Node/npm, generates mobile artifacts, typechecks and runs tests (`.github/workflows/build.yml:45-105`). | Native C++ helpers are built separately; packagers consume an already-built runtime. Packaging explicitly runs without Node/Electron (`experiments/gpui-player/DESKTOP_PACKAGING.md:3-16`; `scripts/build-gpui-native.py:146-205`). |
| App and payload build | Builds renderer, vendored engines, splitter packs, capture addon and Electron package; `dist.cjs` verifies capture artifact, runtime-smokes it when host-compatible, then invokes electron-builder (`.github/workflows/build.yml:129-135`; `scripts/dist.cjs:101-147`). | Copies four executables, assets, licenses, and optional native codecs/engines into a folder/ZIP or `.app`; validates architecture, paths, hashes and dependencies (`scripts/package-gpui-desktop.py:433-489`; `scripts/package-gpui-macos.py:442-496`). |
| Signing | macOS Developer ID signing and notarization are configured; `afterPack` verifies copied addon and supplies ad-hoc fallback when real signing unavailable (`electron-builder.yml:89-122`; `scripts/afterPack.cjs:1-20`; `docs/MACOS-SIGNING.md:10-18`). Windows NSIS target exists; signing status below. | macOS supports optional ad-hoc signing only; docs state no upload/notarization. Distribution entitlements remain unqualified (`scripts/package-gpui-macos.py:486-491`; `experiments/gpui-player/MACOS_PACKAGE_REVIEW.md:107-110`). Windows/Linux are folder/archive assemblers with payload manifest, not installers (`experiments/gpui-player/DESKTOP_PACKAGING.md:19-25`). |
| Publish and update | Workflow uploads artifacts and attaches installers, update metadata and splitter packs to GitHub Releases (`.github/workflows/build.yml:425-475`). Windows updater auto-downloads and installs at quit; macOS/Linux only check GitHub latest and offer release page (`src/main/updater.ts:34-43,68-110`). | Local preview assembly only; no CI release attachment, installer/update feed, or updater is documented. *(inferred from `experiments/gpui-player/DESKTOP_PACKAGING.md:7-16`; `experiments/gpui-player/MACOS_PACKAGE_REVIEW.md:22-27,107-110`)* |
| E2E | Windows workflow runs capture-addon load smoke, unit tests, built-app smoke, makes local `latest.yml` feed, then runs packaged updater E2E (`.github/workflows/e2e-win.yml:25-67`). | Preview package checks described in docs validate startup/relocation and manifests; no update flow is qualified (`experiments/gpui-player/DESKTOP_PACKAGING.md:27-40`; `experiments/gpui-player/MACOS_PACKAGE_REVIEW.md:64-70,107-110`). |

## Electron updater feed assets

| Files | Evidence |
|---|---|
| `latest.yml` (Windows), `latest-mac.yml` (macOS), `*.blockmap` and installer artifacts (`*.exe`, `*.dmg`) | electron-builder GitHub publish config is metadata configuration, with CI attaching files itself (`electron-builder.yml:82-88`); release upload glob includes `dist/latest*.yml`, `dist/*.blockmap`, `dist/*.exe`, and `dist/*.dmg` (`.github/workflows/build.yml:472-475`). Windows E2E directly opens `dist/latest.yml` (`.github/workflows/e2e-win.yml:48-61`). |

## Signing and entitlements

| Question / executable | Finding |
|---|---|
| Windows installer Authenticode today? | No. `electron-builder.yml` defines NSIS x64 and per-user installer options but no Windows `signtoolOptions`/certificate configuration (`electron-builder.yml:223-229`); signing config in the workflow is specifically macOS (`.github/workflows/build.yml:266-296`). Thus unsigned is supported by config evidence, not a live artifact inspection. |
| `singz-gpui-player` | Needs microphone permission only if the UI process itself opens the audio input device; current package embeds microphone usage description and identifies it as main executable (`scripts/package-gpui-macos.py:462-465`). Hardened runtime entitlements required for distribution signing are not yet established by the preview docs (`experiments/gpui-player/MACOS_PACKAGE_REVIEW.md:107-110`). *(inferred)* |
| `singz-gpui-audio` | `com.apple.security.device.audio-input` if this process captures microphone input; completion plan explicitly scopes this entitlement to the process that captures (`experiments/gpui-player/COMPLETION_PLAN.md:258`). *(inferred per actual process capture role)* |
| `singz-gpui-input` | `com.apple.security.device.audio-input` if this helper captures microphone input; helper is separately packaged (`scripts/package-gpui-macos.py:24,453-454`). *(inferred; helper name alone does not prove capture behavior)* |
| `singz-analyze` | No microphone entitlement indicated; analysis helper receives files/data rather than capturing audio (role not confirmed by the cited packaging files). *(inferred)* |
| FFmpeg dylibs and optional engine executables | No microphone entitlement indicated for libraries; optional engines are separately copied (`scripts/package-gpui-macos.py:457-459`). Entitlement should follow actual capture responsibility, which this packaging evidence does not map. *(inferred)* |

## Gaps relative to Electron

| Gap in native path | Evidence |
|---|---|
| Hosted release build workflow, tag/prerelease handling, release notes and asset attachment | Electron workflow implements these (`.github/workflows/build.yml:3-43,437-475`); native packaging docs show local commands and preview only (`experiments/gpui-player/DESKTOP_PACKAGING.md:7-16,27-40`). |
| Developer ID signing, notarization, stapling and signed DMG distribution | Electron does this in CI (`docs/MACOS-SIGNING.md:10-18`; `electron-builder.yml:115-122`); native preview only ad-hoc signs and explicitly leaves distribution signing/notarization open (`experiments/gpui-player/MACOS_PACKAGE_REVIEW.md:22-27,107-110`). |
| Windows installer and Authenticode | Electron config builds NSIS installer (`electron-builder.yml:223-229`); native Windows packager makes a payload folder/archive, and C-31 remains planned (`experiments/gpui-player/DESKTOP_PACKAGING.md:19-25`; `experiments/gpui-player/COMPLETION_PLAN.md:259`). |
| Updater implementation, platform feeds, rollback and update E2E | Electron publishes `latest*.yml`/blockmaps and has Windows updater E2E (`.github/workflows/build.yml:472-475`; `.github/workflows/e2e-win.yml:48-67`). Native docs identify updater/installer flows as unqualified (`experiments/gpui-player/MACOS_PACKAGE_REVIEW.md:107-110`). |
| Final distribution entitlements per executable | Native plan calls for microphone entitlement “where a process captures” but actual process-to-device mapping and distribution entitlements remain unqualified (`experiments/gpui-player/COMPLETION_PLAN.md:258`; `experiments/gpui-player/MACOS_PACKAGE_REVIEW.md:107-110`). |
