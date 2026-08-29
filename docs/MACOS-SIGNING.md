# Signing and notarizing the macOS desktop build

Up to and including **v0.19.0**, every published mac `.dmg` was **ad-hoc
signed** (`scripts/afterPack.cjs`): enough to turn the unrecoverable "app is
damaged" quarantine dialog into the ordinary "unidentified developer"
right-click-to-open flow, but every download needed that workaround. A
**Developer ID Application** certificate plus Apple notarization removes it
entirely — Gatekeeper checks the notarization ticket instead of complaining.

CI does that now and is verified (see below). **v0.19.1 is the first signed,
notarized release**. `afterPack.cjs` ad-hoc repairs every final bundle first;
that remains the final signature for forks and machines with no certificate,
while electron-builder's later Developer ID pass replaces it in release CI.

One thing about that first tag is worth watching rather than assuming: the
proving runs were `workflow_dispatch`es, and `build.yml`'s attach step is
gated on a tag ref — so no signed dmg has ever actually been *attached* to a
release. Check that the v0.19.1 tag build attaches one.

This is a *third* Apple certificate type, distinct from the two the iOS
pipeline uses (see [IOS-RELEASE.md](IOS-RELEASE.md)):

| Certificate | Signs | Used for |
| --- | --- | --- |
| iPhone Developer | iOS dev builds | the sis-motors.ru sideload (already set up) |
| Apple Distribution | iOS App Store builds | TestFlight / App Store |
| **Developer ID Application** | **macOS apps** | **this — direct distribution outside the Mac App Store** |

## One-time setup

1. **Make a Developer ID Application certificate.** Xcode → Settings →
   Accounts → your team → Manage Certificates → **+** → **Developer ID
   Application**. (Or the portal: Certificates, Identifiers & Profiles →
   Certificates → **+** → Developer ID Application, from a CSR made in
   Keychain Access → Certificate Assistant → Request a Certificate.) No
   provisioning profile is needed for this one — Developer ID apps aren't
   sandboxed or profile-scoped the way iOS builds are.

2. **Reuse the App Store Connect API key.** Notarization authenticates the
   same way TestFlight uploads do — an App Store Connect API key avoids both
   an Apple ID password and a 2FA prompt in CI, and never expires. If you
   already made one for [IOS-RELEASE.md](IOS-RELEASE.md) step 3, it works
   here unchanged; nothing else to generate.

## Export and set the secrets

```bash
# Keychain Access → find "Developer ID Application: …" → right-click →
# Export → .p12 → set a password → save as developer-id.p12
base64 -i developer-id.p12 | pbcopy   # -> APPLE_DEVELOPER_ID_CERTIFICATE_BASE64

gh secret set APPLE_DEVELOPER_ID_CERTIFICATE_BASE64 < <(base64 -i developer-id.p12)
gh secret set APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD --body "<the .p12 export password>"
```

The notarization credentials are the **same three secrets**
`IOS-RELEASE.md` already has you set — `APP_STORE_CONNECT_API_KEY_ID`,
`APP_STORE_CONNECT_API_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY_BASE64`. Set
them once; both pipelines read them.

## Why CI imports the certificate itself instead of setting `CSC_LINK`

`CSC_LINK` is the documented way to hand electron-builder a `.p12`, and it is
**broken in the version this repo pins** (26.15.3). Do not "simplify"
`build.yml` back to it.

`app-builder-lib`'s `createKeychain` builds the temp keychain with
`randomBytes(32).toString("base64")` as its password, and then `importCerts`
runs, for each certificate:

```
security import <cert> -k <keychain> -T /usr/bin/codesign -P <p12 password>
security set-key-partition-list -S apple-tool:,apple: -s -k <p12 password> <keychain>
```

The `import -P` is right. The `set-key-partition-list -k` is not: that flag
takes the **keychain** password, and it is being given the `.p12` one. The
two agree only if you happen to have used the same string for both.

Measured here with a *throwaway self-signed cert*, so it is the mechanism and
not one bad certificate — `-k <p12 password>` fails with `SecKeychainUnlock:
The user name or passphrase you entered is not correct`, `-k <keychain
password>` succeeds. What you see is the build dying as a bare `security
process failed 1`, after the engine builds and before anything is packaged,
with nothing pointing at a password mix-up. Worse, electron-builder echoes
the failing command — **including the `.p12` password** — into the log.

`CSC_KEYCHAIN` is only consulted when `CSC_LINK` is unset: `macPackager.js`
calls `createKeychain` solely when `getCscLink()` is non-null. So the
workaround is not to set `CSC_LINK` at all, and instead create the keychain,
import into it, and set the partition list with the keychain's *own*
password — which is what `build.yml`'s signing step does.

Locally the same shape applies: build with `CSC_KEYCHAIN` pointing at a
keychain you prepared, `CSC_NAME` set to the identity **bare** (no
`Developer ID Application: ` prefix — that form is rejected), and `CSC_LINK`
unset.

## What actually signs and notarizes it

`electron-builder.yml`'s `mac` block carries `hardenedRuntime: true`,
`entitlements: build/entitlements.mac.plist`, `entitlementsInherit:
build/entitlements.mac.inherit.plist` and `notarize: true` as flat `mac:`
siblings — **not** nested under a `sign:` key. This repo pins
`electron-builder@^26.15.3`, and in that version `mac.sign` is a slot for a
custom sign *function* (`CustomMacSign | string | null`), not a config
object; the newer nested shape some docs show is a v27+ schema. Getting this
wrong doesn't fail loudly — with no identity present, `sign()` returns
before ever touching a misconfigured `sign:` value, so a broken nested
config still looks fine on every machine without Apple secrets. It only
throws (`customSign is not a function`) the moment a real Developer ID
identity is actually found, i.e. exactly when this is meant to start
working — worth remembering if `electron-builder` is ever bumped to v27+,
since the flat and nested shapes are not interchangeable within one version.

None of this does anything without credentials in the environment —
`notarize: true` specifically logs a warning and skips rather than failing
when unset, which is what keeps `npm run dist` on a machine with no Apple
secrets (forks and CI runs without repository secrets) building an ad-hoc
signed dmg exactly as before.

`.github/workflows/build.yml`'s "macOS signing + notarization secrets" step
base64-decodes the certificate, imports it into a temporary keychain, rejects
anything that is not a Developer ID Application identity, then exports
`CSC_KEYCHAIN` and the bare `CSC_NAME`. It deliberately exports neither
`CSC_LINK` nor `CSC_KEY_PASSWORD`; using those would re-enter the keychain bug
above. The same step maps notarization onto `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER` and `APPLE_TEAM_ID`, writing each
optional value only when its secret is non-empty. Missing repository secrets
therefore leave afterPack's valid ad-hoc signature in place instead of turning
a fork or weekly build into a credentials error.

Two details of that step are load-bearing, and both were got wrong first:

- **`APPLE_API_KEY` is a filesystem PATH to the `.p8`, not the key's
  contents.** app-builder-lib passes it through untouched to
  `@electron/notarize`, whose typings read "File system path to the `.p8`
  private key" and which splices it into `xcrun notarytool --key <value>`.
  So the step base64-**decodes** the secret to `$RUNNER_TEMP/AuthKey.p8`
  (mode 600, wiped with the runner) and exports that path. Some
  electron-builder documentation shows a base64 body for this variable; for
  the pinned version, the code is what counts.
- **The "only if non-empty" helper must be `if/then`, not `[ -n … ] && …`.**
  GitHub runs the step as `bash -e`. The AND-list is exempt from errexit
  inside a function body, but the *function* then returns 1 for an empty
  value, and the call site is a plain simple command — so errexit kills the
  step. Measured: with no secrets set (today's state, the very case the step
  exists to tolerate) the `&&` form exits 1 immediately, taking the whole
  macOS leg down after the engine builds and before packaging, and never
  printing the warning it was supposed to print.

`CSC_KEYCHAIN`/`CSC_NAME` are scoped by a step that only *runs* when
`runner.os == 'macOS'`; they are not placed on the matrix job or its shared
"Package" step. Keep that boundary. Electron-builder's CSC signing variables
also drive the **Windows** Authenticode path, so leaking Apple signing
configuration across the matrix can turn into a Windows signing failure with
nothing "Apple" in its message to explain why.

## The entitlements file

`build/entitlements.mac.plist` / `entitlements.mac.inherit.plist` grant only
`com.apple.security.cs.allow-jit` and
`com.apple.security.cs.allow-unsigned-executable-memory` — what V8/Node need
to keep running under Hardened Runtime, nothing more. Three things this
deliberately does *not* carry, and why adding them by reflex would be wrong:

- **No App Sandbox entitlements** (`com.apple.security.app-sandbox` and its
  exceptions). Those apply to the `mas` (Mac App Store) target; this is
  `dmg` (direct distribution). Copying an App Sandbox guide's entitlements
  file here would sandbox an app that was never built for the sandbox.
- **No `com.apple.security.device.audio-input`.** That entitlement is part
  of the App Sandbox set too — under Hardened Runtime *without* the sandbox,
  microphone access keeps working through the ordinary TCC prompt, gated by
  `NSMicrophoneUsageDescription` (already in `electron-builder.yml`'s
  `mac.extendInfo`), with no extra entitlement. SingZ's mic-driven pitch
  matching was checked against exactly this before wiring hardened runtime
  in — getting it wrong would have silently broken the mic on every signed
  build, discoverable only by someone actually running one.
- **No `disable-library-validation`.** The desktop now packages and loads the
  native Node-API module `Contents/Resources/engines/singz-capture.node`.
  electron-builder must sign that nested Mach-O with the same Developer ID
  team as the containing app; Hardened Runtime's library validation then
  allows the packaged Electron process to load it without weakening the app's
  entitlements. The addon is an explicit `extraResources` input even though
  `npmRebuild: false` and there is no `binding.gyp`, so neither setting is
  evidence that the desktop is native-code-free.

## Signing has run twice; the native addon adds a release load gate

Superseding the "first real run is unverified" note that stood here: it is
verified for the signing/notarization pipeline and the then-vendored
subprocesses, on both a local build and on CI.

**Locally** (2026-08-29): a `--mac --arm64` build signed, notarized and
stapled. Verified the way a downloader experiences it rather than by trusting
the log — `codesign --verify --deep --strict` passes, `xcrun stapler validate`
passes, and `spctl -a -t exec -vv` reports `accepted` /
`source=Notarized Developer ID` both on the app and on the app inside a
quarantined, mounted dmg.

**On CI**, run 33243835099: `1 identity imported`, then
`notarization successful` twice — once per architecture — producing signed,
notarized `SingZ-<version>-mac-x64.dmg` and `-mac-arm64.dmg`.

Those two proving runs predate `singz-capture.node`, so they do not prove its
Hardened Runtime load. Release acceptance now also requires launching a real
Developer ID-signed, notarized SingZ build and opening Settings → Audio until
the Headphone monitoring section's **Audio interface playback** picker lists
the native output devices. That picker is populated only by the packaged
addon's `audioHostDevices` export through the real app process, so success
proves the same-team nested signature passes library validation; the separate
Chromium microphone picker and a signature-only check do not. The existing
capture package checks remain complementary:
`capture-addon-signed-mac.cjs` verifies signed-Mach-O identity and tamper
rejection in the ad-hoc CI package, while `capture-addon-smoke.cjs` verifies
the exports and device-inventory result shapes. Neither should be described
as a Developer ID load unless it ran through the notarized packaged app.

The subprocess risk this section used to flag did **not** materialize.
`electron-builder` deep-signs the whole bundle including the vendored
`whisper-cli` and `singz-analyze` under `extraResources`, and Apple's notary
service accepted them without complaint on every proving run. The capture
addon joins that signed bundle now, but unlike a spawned executable it must
also pass the real-app load gate above. A notary rejection names the failing
path under `engines/` ("not signed with a valid Developer ID certificate" /
"missing a secure timestamp"), and electron-builder logs that output to the
job log either way — still the first place to look.

What DID bite on the way there is recorded above: the `CSC_LINK` keychain-
password bug, and a dangling absolute symlink in the bundle when packaging
from a git worktree (`vendor/darwin-<arch>/whisper-cli` is a link to the main
checkout, and `codesign --strict` rejects it — see the note in `CLAUDE.md`).

The dmg itself is neither signed nor stapled, and that is expected:
electron-builder notarizes and staples the `.app`, then builds the dmg around
it. `spctl` on the dmg says `rejected / source=no usable signature` while the
app inside is `accepted` — which is what a downloader's Gatekeeper actually
evaluates, confirmed by the quarantined-mount test above. `dmg.sign` is
`false` by default for a reason electron-builder states outright: signing it
"will lead to unwanted errors in combination with notarization requirements".
