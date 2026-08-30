# Shipping SingZ on iOS

TestFlight and the App Store both take the same `.ipa`, exported with
`export_method: app-store` and built once per run by
[`mobile/ios/fastlane/Fastfile`](../mobile/ios/fastlane/Fastfile). That IPA is
**not** the sis-motors.ru sideload build — that one is development-signed and
installs over `itms-services://`; this one is App Store-signed and is only
ever valid inside App Store Connect. Two different certificate types, two
different pipelines; see [ship-ios-ipa](../.claude/skills/ship-ios-ipa/SKILL.md)
for the other one.

## What the API cannot do

Apple's own docs say it outright: *"Don't use this API to create new apps;
instead, create new apps on the App Store Connect website."* The app record —
the bundle ID's entry in App Store Connect, with its own numeric Apple ID —
is a one-time, by-hand step, the same wall Android's Play Console has for the
very first bundle (see [ANDROID-RELEASE.md](ANDROID-RELEASE.md)). Everything
after that — builds, TestFlight distribution, submitting for review, the
store listing text — is scriptable and lives in CI.

## One-time setup (do this once, by hand, in App Store Connect)

The bundle ID is `io.s-dev.singz` — **not** `com.lexasoft.singz`, which
Android and the desktop app both still use. iOS ended up on a different one
because `com.lexasoft.singz` was already registered as an explicit App ID
under a different, since-expired-membership Apple ID (discovered the hard
way: App Store Connect's "New App" bundle ID dropdown simply didn't list it,
and manually registering it explicitly failed with "An App ID with
Identifier … is not available" — bundle IDs are unique across *all* Apple
Developer accounts, not just one team). `io.s-dev.singz` is free and
registered fresh under this team.

1. **Register the App ID.** Certificates, Identifiers & Profiles →
   Identifiers → **+** → App IDs → **Continue** → type **App** → **Continue**.
   Description: anything ("SingZ"). Bundle ID: **Explicit** (not
   Wildcard — a wildcard ID can't be selected for an App Store provisioning
   profile or App Store Connect's app-creation dropdown), `io.s-dev.singz`.
   **Capabilities: leave everything unchecked** — nothing in the app is
   gated behind a portal capability (no `.entitlements` file exists in
   `mobile/ios/`, no `SystemCapabilities` block in the `.pbxproj`; mic,
   background audio and document browsing are all plain `Info.plist`
   declarations). **Continue** → **Register**.

2. **Create the app record.** App Store Connect → Apps → **+** → New App.
   Platform iOS, name "SingZ" (or whatever is free — the *listing* name
   lives in `mobile/ios/fastlane/metadata/*/name.txt` and can differ),
   primary language, bundle ID `io.s-dev.singz` (now selectable in the
   dropdown from step 1), SKU (anything stable, e.g. `singz-ios`).

3. **Generate an App Store Connect API key.** Users and Access → Integrations
   → App Store Connect API → Team Keys → **+**. Role: **App Manager** (enough
   to upload builds, manage TestFlight and submit for review; Admin also
   works). This gives you three values, and the `.p8` file downloads **once**
   — losing it means generating a new key, not re-downloading the old one:
   - **Issuer ID** (shown on the same page, one per team)
   - **Key ID** (shown next to the key you just made)
   - The `.p8` file itself (`AuthKey_<KeyID>.p8`)

   This key is *also* what macOS desktop notarization uses — see
   [MACOS-SIGNING.md](MACOS-SIGNING.md). One key, two consumers; no need to
   make a second one.

4. **Mint the certificate and profile with `match`.** No Keychain Access
   export, no CSR, no `.p12` juggling — `match` creates the Apple
   Distribution certificate and the App Store provisioning profile, encrypts
   them, and commits them to a private repo
   (`lexasoft123/singz-ios-certs`, already created; the URL lives in
   `mobile/ios/fastlane/Matchfile`).

   The credentials live in a **SOPS-encrypted store** rather than loose
   files — see [The local secret store](#the-local-secret-store) below for
   how it was made and how to read it. With that in place:

   ```bash
   cd mobile/ios && bundle install
   cd - && scripts/with-apple-secrets.sh bash -c 'cd mobile/ios && bundle exec fastlane ios certs'
   ```

   This mints **one** Apple Distribution certificate and **two** profiles
   from it — App Store and Ad Hoc — and pushes all three encrypted to the
   certs repo. One certificate for both on purpose: Apple caps Distribution
   certificates per team, so match reuses rather than minting a second.

   It is the **only** command that may create signing assets, and it never
   runs in CI — the lane refuses outright when `$CI` is set, and is absent
   from the workflow's lane choices. A CI job that mints a certificate on
   every run is the documented way a team hits that cap and then cannot ship
   until somebody revokes one by hand. CI runs `match` readonly: it fetches
   what this command created and nothing else.

   Re-run it when a certificate expires (yearly), when a new machine needs
   the identity, or after registering a device (below) — on a new machine it
   is the same one command with the same `MATCH_PASSWORD`, which is the
   whole point of match over hand-exported `.p12` files.

## Ad-hoc builds for the install page

`https://sis-motors.ru/singz/` serves an IPA over `itms-services://` (see the
`ship-ios-ipa` skill). That build used to be **development**-signed, because
this Mac had no Distribution certificate; it does now, so ad-hoc — the
mechanism actually intended for this — is available.

Ad-hoc installs only on UDIDs registered with the team, so a new phone is two
commands:

```bash
scripts/with-apple-secrets.sh bash -c 'cd mobile/ios && bundle exec fastlane ios add_device udid:<UDID> name:"<whose phone>"'
scripts/with-apple-secrets.sh bash -c 'cd mobile/ios && bundle exec fastlane ios certs'
```

The second is not optional: registering a device does **not** retroactively
change existing profiles. `certs` passes `force_for_new_devices: true` for
the ad-hoc type so the re-run actually regenerates the profile instead of
handing back the stale one — and a profile that silently covers no devices
looks identical to a good one until an install fails on the phone. Check it:

```bash
security cms -D -i ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/<uuid>.mobileprovision \
  | plutil -extract ProvisionedDevices json -o - -
```

For a phone plugged into this Mac, its UDID is
`xcrun devicectl list devices --json-output /tmp/d.json` then the
`hardwareProperties.udid` field — **not** the Identifier column that command
prints, which is a CoreDevice UUID and is not what provisioning uses.

Build one with `fastlane ios adhoc` (needs `SINGZ_IOS_BUILD_NUMBER` set —
there is no CI run number locally):

```bash
SINGZ_IOS_BUILD_NUMBER=<n> scripts/with-apple-secrets.sh bash -c 'cd mobile/ios && bundle exec fastlane ios adhoc'
```

## Build-time signing traps (each of these cost a build)

The lanes override signing on the **xcodebuild command line** (`xcargs`)
rather than writing it into `project.pbxproj`. The project stays on
automatic *development* signing, which is what Xcode and the sideload build
want; the lanes need manual signing against a match profile. Overriding
means neither has to win, and a failed CI job never leaves half a run number
written into the project.

Three things about that, all measured here rather than reasoned about:

- **`build_app` has no `build_number` option.** Passing one fails the lane
  before compiling anything ("Could not find option 'build_number'"). The
  build number is `CURRENT_PROJECT_VERSION` in the same `xcargs` string;
  `Info.plist`'s `CFBundleVersion` is already `$(CURRENT_PROJECT_VERSION)`,
  so it flows through. (`increment_build_number` is the other route, and it
  rewrites `project.pbxproj` — which is what we are avoiding.)
- **xcodebuild command-line overrides cannot express conditional settings.**
  `CODE_SIGN_IDENTITY[sdk=iphoneos*]=Apple Distribution` is split on the
  first `=`, so the name becomes `CODE_SIGN_IDENTITY[sdk` and the value
  `iphoneos*]=Apple Distribution` — which surfaces as the genuinely
  baffling "No certificate for team 'USJ7H3X44X' matching
  `'iphoneos*]=Apple Distribution'` found". Only the plain form works.
- **Without `CODE_SIGN_STYLE=Manual` the archive hunts for a *development*
  profile** and fails with "No profiles for 'io.s-dev.singz' were found …
  Automatic signing is disabled and unable to generate a profile". Note it
  says *App Development*: the project's own
  `CODE_SIGN_IDENTITY[sdk=iphoneos*]` is `iPhone Developer`, so a perfectly
  good distribution profile sitting right there is not what it asked for.

Also: **`pod install`, never `bundle exec pod install`.** From `mobile/ios`
bundler resolves the fastlane-only `Gemfile` this pipeline added and dies
with "can't find executable pod for gem cocoapods".
`scripts/worktree-setup.sh` is the repo's one definition of how pods get
installed and it uses the bare command with a UTF-8 `LANG`; CI does the same.

**An `npm ci` in an existing worktree breaks the iOS build, and the error
names neither npm nor the cause.** react-native-audio-api's prebuilt static
libs (`libogg.a`, `libopus.a`, `libvorbis*.a`, plus the ffmpeg xcframeworks)
are **not in its npm tarball** — its podspec's `prepare_command` fetches them
via `scripts/download-prebuilt-binaries.sh`, which CocoaPods runs when it
first integrates the pod and skips for one it has already integrated. So
`npm ci` deletes them and neither a re-run of `npm ci` nor a subsequent
`pod install` puts them back; the archive fails with "Build input files
cannot be found: …/external/iphoneos/libogg.a" and five siblings. Restore
them directly:

```bash
(cd mobile/node_modules/react-native-audio-api && ./scripts/download-prebuilt-binaries.sh ios)
node mobile/scripts/patch-audio-api.js          # npm ci reset the patched sources too
(cd mobile/ios && LANG=en_US.UTF-8 pod install) # MUST come after the download
```

**The order of those three matters and getting it wrong fails at the
linker, not at the download.** The same tarball carries the ffmpeg
xcframeworks (`external/ffmpeg_ios/libav*.xcframework`), and the podspec
declares them as `vendored_frameworks`. CocoaPods records vendored
frameworks that exist *at pod-install time*, so a `pod install` that ran
while `ffmpeg_ios/` was absent produces a Pods project that never links
them — and the build then compiles cleanly all the way through and dies in
`ld` with a wall of undefined `_av_*` symbols (`av_frame_alloc`,
`av_dict_set`, `avcodec_*`) referenced from `libRNAudioAPI.a`, which reads
like a broken audio-api release rather than a stale project file. Download
first, `pod install` second.

`patch-audio-api.js` is idempotent and reports "already applied" when there
is nothing to do. CI is unaffected by any of this: it installs into an empty
tree, so CocoaPods integrates the pod for the first time, the
`prepare_command` fetches the binaries, and the ordering resolves itself.

## App Privacy, export compliance, and the other console-only answers

fastlane cannot set these. They are one-time, but a submission is refused
until they are done — and the refusal arrives at the very last API call,
after the binary and metadata have already gone up.

**App Privacy → "Data Not Collected".** The first question ends the form.
The reasoning, so it is not re-derived (and can be defended if queried):

- There are no analytics, crash-reporting, ads or attribution SDKs in the
  dependency tree at all.
- Five outbound hosts, none of them ours: Google's OAuth and Drive endpoints
  (the user reaching their *own* account — data flows onto the phone),
  `lrclib.net` for a lyrics lookup, and `github.com` for the model download.
  There is no SingZ server, so there is nowhere to collect anything to.
- The microphone is analysed in memory and never recorded —
  `mobile/src/training/mic.ts` has no write, upload or fetch path.
- Apple's own rule is the decisive one: data processed only on the device
  and not sent off it is **not** collected.

`docs/PLAY-LISTING.md` § Data safety reaches the same answer on Google's
form; keep the two consistent.

**Saving is not publishing.** App Privacy has a separate **Publish** button,
and until it is pressed Apple treats the answers as absent —
"You must have published answers to your app's data usages", raised at
submission time. This cost one full release run.

**Export compliance is declared in the binary, not the console.**
`ITSAppUsesNonExemptEncryption = false` is in `mobile/ios/SingZPlayer/Info.plist`.
The app implements no encryption: CommonCrypto/CryptoKit appear only for
SHA-256 and MD5 *hashing* (audio-route identity, cache currency), and all
networking is the OS's own HTTPS. Without that key App Store Connect asks on
every upload, and — worse — answering it through the API mid-submission makes
Apple **reprocess the build**, which breaks the submission that is already in
flight.

**Also console-only:** category (Music), the age-rating questionnaire (all
"None" — SingZ lands at 4+), pricing and availability. `copyright.txt` in the
metadata tree covers the copyright string, which is otherwise a
"missing required attribute 'copyright'" failure at submit time.

## The local secret store

`.keys/secrets.enc.yaml`, encrypted with [SOPS](https://github.com/getsops/sops)
to the age key at `~/.config/sops/age/keys.txt`. It holds the API key id, the
issuer id, the `.p8` body, the match passphrase, the App Review contact
(`review_*`) and the Developer ID `.p12` export password
(`mac_p12_password`, for a local signed macOS build — nothing reads it
automatically; CI signs from its own repo secret. See
[MACOS-SIGNING.md](MACOS-SIGNING.md)). Rules are in `.sops.yaml`
at the repo root; only values are encrypted, so `git diff` and a glance still
show the structure.

`scripts/with-apple-secrets.sh <command>` decrypts it, exports
`APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_API_ISSUER_ID` and
`MATCH_PASSWORD` — plus `SINGZ_REVIEW_*` and `SINGZ_MAC_P12_PASSWORD` when
the store carries them — writes the `.p8` to a mode-600 temp file pointed at
by `SINGZ_ASC_KEY_PATH`, runs the command, and deletes the temp file on the
way out, so no secret reaches a shell history, a process argument list, or a
file that outlives the command. The script's own header is the list of
record; keep it and this sentence in step.

Read a value by hand with `sops -d .keys/secrets.enc.yaml`. Edit or rotate
one with `sops .keys/secrets.enc.yaml`. Add a second machine or person by
putting their age public key in `.sops.yaml` and running
`sops updatekeys .keys/secrets.enc.yaml` — no re-entry of the secrets.

Two things about it that are deliberate:

- **The ciphertext is NOT committed.** `.keys/` is in `.gitignore` *and*
  `.git/info/exclude` (the latter covers every worktree immediately, which
  the tracked file cannot until it is merged). SOPS output is safe to commit
  in principle, but this repo is public and Apple hands out a `.p8` exactly
  once. Encrypted *and* untracked.
- **`SOPS_AGE_KEY_FILE` is set explicitly** by the helper. Measured here:
  sops does not fall back to the default age key path on its own — it
  reports only the `SOPS_AGE_*`/SSH locations and fails to decrypt.

## Set the CI secrets

Local runs need no secrets — the Fastfile reads `.keys/AuthKey_<KeyID>.p8`
directly, and git auth comes from your existing `gh` login (run
`gh auth setup-git` once if a `git push` to the certs repo ever prompts).
CI has neither, so it gets five secrets:

```bash
gh secret set APP_STORE_CONNECT_API_KEY_ID --body "<KeyID>"
gh secret set APP_STORE_CONNECT_API_ISSUER_ID --body "<IssuerID>"
gh secret set APP_STORE_CONNECT_API_KEY_BASE64 < <(base64 -i .keys/AuthKey_<KeyID>.p8)
gh secret set MATCH_PASSWORD --body '<your match passphrase>'

# Read access to the private certs repo. A fine-grained PAT scoped to
# lexasoft123/singz-ios-certs with Contents: Read-only is enough — match is
# readonly in CI and never pushes.
echo -n "lexasoft123:<PAT>" | base64 | gh secret set MATCH_GIT_BASIC_AUTHORIZATION
```

The `release` lane additionally needs the App Review contact, which is a real
person's name, phone and email and so is NOT in the tracked metadata tree —
locally it comes from the SOPS store via `scripts/with-apple-secrets.sh`, and
CI gets it as four more secrets:

```bash
gh secret set SINGZ_REVIEW_FIRST_NAME --body "<first>"
gh secret set SINGZ_REVIEW_LAST_NAME  --body "<last>"
gh secret set SINGZ_REVIEW_PHONE      --body "<phone>"
gh secret set SINGZ_REVIEW_EMAIL      --body "<email>"
```

That is nine secrets instead of the seven the hand-managed approach needed,
and — the reason this matters more than the count — **the profile name is
never written down anywhere**. `match` exports it into
`sigh_io.s-dev.singz_appstore_profile-name`, which the `archive` lane reads,
so regenerating or renaming the profile cannot leave CI pointed at a name
that no longer exists.

A provisioning profile expires yearly and a certificate expires after (by
default) one year too — when either does, `fastlane ios validate` starts
failing with a clear "profile has expired" / "certificate has expired"
message from Apple; regenerate that one thing and re-export it, no need to
touch the others.

## What CI does with them

`.github/workflows/ios.yml`:

- **A `v*` tag** builds and uploads to **TestFlight** automatically — the
  same "tagging is the ship decision" reasoning as Android's closed track.
  No tester group is assigned by this job; open App Store Connect and add
  the build to a group once it finishes processing (Apple's own processing
  step, 15–60 min, that nothing in CI can shorten — the job does not wait
  for it).
- **Manual dispatch** lets you choose `validate` (checks the App Store
  Connect key and the two `match` secrets, the version match, and actually
  fetches the certs — ships nothing. It does **not** touch the four
  `SINGZ_REVIEW_*` secrets: only `release` reads those, so a green `validate`
  does not prove a submission will not stop on a missing contact), `beta`
  (TestFlight), `release` (builds and submits for review with
  `automatic_release: true`, so an approved build goes **live on the store by
  itself** — there is no second confirmation, and dispatching the lane is
  therefore the decision to publish), or `metadata` (pushes the store listing text
  only, no binary).

  The lanes are `beta`/`release` rather than the more obvious
  `testflight`/`appstore` because those two are the names of fastlane
  *actions* — a lane shadowing an action is something fastlane warns about
  by name, and it leaves which one a bare invocation resolves to up to
  context. `certs` is deliberately not among the choices: CI must never mint
  a certificate (see step 4).

Every lane starts by checking `MARKETING_VERSION` in
`mobile/ios/SingZPlayer.xcodeproj/project.pbxproj` against the root
`package.json` version and refuses to build on a mismatch — that field is
still hand-bumped (see the root `CLAUDE.md`), CI only refuses to ship a
stale one.

The **build number** (`CURRENT_PROJECT_VERSION`) is *not* hand-bumped for
this path — the workflow passes `github.run_number`. That counter is
**per-workflow, not repo-wide**: it starts at 1 for any newly added
workflow, and ios.yml's first runs were numbered 1, 2, 3 while this repo had
hundreds of Action runs across the other five workflows. (Earlier revisions
of this page, of `CLAUDE.md` and of the Fastfile all claimed it never went
backwards "across the whole repo's Action history". It was wrong in all
three.)

**So bumping `MARKETING_VERSION` is not optional before the first CI upload
of a version that was ever hand-uploaded.** Apple scopes build-number
ordering to one `CFBundleShortVersionString`, and 0.19.0 reached build 33
through hand-driven local uploads — so the first CI `beta` against 0.19.0
would have offered build 4 and Apple would have refused it. A fresh version
train accepts a low build number happily, which is why the fix is a version
bump rather than a build-number override. Past that one seam no build number
is typed by hand here.

## Store listing text

Lives in `mobile/ios/fastlane/metadata/<locale>/` (`en-US`, `ru` — Apple's
locale codes, not always Android's: Russian is `ru` here, `ru-RU` under
`mobile/android/fastlane/metadata/android/`).
`scripts/store-notes.cjs` writes `release_notes.txt` in every locale it
finds a directory for, from the same `<!-- store:LOCALE -->` blocks in
`docs/release-notes/v<version>.md` that already feed Android's Play
changelog — one block, both stores, so write it assuming either audience
reads it (a wording that's only true on one platform, e.g. naming an
OS-specific capture path, is wrong on the other one's listing).

When a release is genuinely not the same release on both phones, add
`<!-- store:LOCALE:ios -->`, which REPLACES the shared block for the App
Store and TestFlight and changes nothing on Play. Reach for it only then:
the shared block is the default precisely so one claim cannot drift into two
wordings. 0.19.1 is the case that forced it — an Android capture rewrite and
a minSdk raised to Android 9, neither true of iPhone, and the shared text was
on its way into `upload_to_app_store(submit_for_review: true)` saying "SingZ
needs Android 9 now". Naming another mobile platform is review guideline
2.3.10, and that was the iPhone app's first submission. `external_changelog`
feeds TestFlight's "what to test" from the same file, so the override covers
both. The `:ios` blocks are stripped from the GitHub Release body by the
workflows; only the shared ones appear there.

`name.txt`, `subtitle.txt`, `description.txt`, `keywords.txt`,
`privacy_url.txt` and `support_url.txt` are static-ish and edited by hand —
run the `metadata` lane after changing any of them.

**Screenshots go up through `scripts/push-ios-screenshots.rb`, not fastlane.**
`deliver` uploads every staged file into *every* locale — 5 images became 10
per locale, measured twice, and `overwrite_screenshots: true` does not prevent
it — so the `metadata` lane passes `skip_screenshots: true` and the script owns
them instead. It deletes each locale's sets and re-uploads in filename order,
which is why they are named `01-`…`05-`: sorted filename order IS the order on
the storefront, and the first is what App Store search results show.

```bash
scripts/with-apple-secrets.sh bash -c \
  'cd mobile/ios && bundle exec ruby ../../scripts/push-ios-screenshots.rb ../../docs/ios-assets'
```

It must run under `bundle exec` from `mobile/ios` (that is where spaceship
resolves) and needs the API-key env the wrapper provides. Images live once in
`docs/ios-assets/`, beside `docs/play-assets/`; 1320x2868 registers as the
iPhone 6.9" slot, which is the only size App Store Connect now requires.
