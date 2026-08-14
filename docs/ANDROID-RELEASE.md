# Shipping SingZ on Android

Two destinations, one build: Google Play takes the `.aab`, the family fleet
sideloads the `.apk`. Both come out of the same tag build, signed with the same
upload key.

## The upload key

Play never sees this key's private half — it signs what you upload, Google
re-signs what it distributes (Play App Signing, on by default for new apps).
So there are two keys in play:

| Key | Who holds it | If lost |
| --- | --- | --- |
| **Upload key** | you | Google resets it on request; the listing survives |
| **App signing key** | Google | not your problem |

That makes a *leaked* upload key the thing to worry about, not a lost one.
It never enters the repo — `*.jks` and `keystore.properties` are gitignored.

Create it once. Pick a real password and put it in a password manager as you go:

```bash
keytool -genkeypair -v -keystore singz-upload.jks -alias singz-upload -keyalg RSA -keysize 2048 -validity 10000
```

`-validity 10000` is ~27 years; Play rejects keys that expire before 2033.
Store `singz-upload.jks` outside the repo — alongside the password, not with it.

## Building a release locally

Point gradle at the key with a `keystore.properties` in `mobile/android/`
(gitignored). Paths are relative to `mobile/android/`:

```
storeFile=../../secrets/singz-upload.jks
storePassword=…
keyAlias=singz-upload
keyPassword=…
```

Then, with a **stock** JDK 21 — `brew install openjdk@21`, which is what CI uses
(temurin 21) and needs no admin rights:

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew bundleRelease assembleRelease
```

**Not Android Studio's bundled JBR.** That runtime enforces JEP 472, so when
AGP shells out to Prefab — which loads a native library through JNA — the JVM
prints four `restricted method in java.lang.System` warnings to stderr. AGP
fails `configureCMake…` on *any* prefab stderr even though the process exits 0,
and the error it surfaces is the warning text with no mention of prefab, JNA or
the JDK. It looks like a broken native build and is not one. The environment
variable escape hatch does not work either: `JDK_JAVA_OPTIONS=--enable-native-access=ALL-UNNAMED`
silences JNA but makes the launcher print `NOTE: Picked up JDK_JAVA_OPTIONS`,
which is still stderr, and still fails. Use a JDK that does not warn.

Outputs land in `app/build/outputs/bundle/release/app-release.aab` and
`app/build/outputs/apk/release/app-release.apk`.

**Without a key, a release build still succeeds — signed with the debug key.**
That keeps `assembleRelease` usable for a quick sideload, and gradle prints a
warning saying the build is not shippable. Play rejects such an upload with a
message that never names the key, which is why the warning exists at all.

## Versions

`versionCode` and `versionName` are derived from the **desktop** `package.json`,
so one tag produces a dmg, an installer and a bundle that all agree:

```
0.14.0  ->  versionName "0.14.0", versionCode 1400   (major*10000 + minor*100 + patch)
```

Play refuses a `versionCode` it has already accepted, even for a bundle that was
never released. To re-upload under the same version — a rejected submission, a
corrected bundle — override it:

```bash
SINGZ_VERSION_CODE=1401 ./gradlew bundleRelease
```

Keep the override above the formula's next value or the following release will
collide with it.

## CI

`.github/workflows/android.yml` builds both artifacts on a `v*` tag and attaches
them to the GitHub Release. It needs four repo secrets:

| Secret | Contents |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -i singz-upload.jks` (one line) |
| `ANDROID_KEYSTORE_PASSWORD` | the store password |
| `ANDROID_KEY_ALIAS` | `singz-upload` |
| `ANDROID_KEY_PASSWORD` | the key password |

On macOS, `base64 -i singz-upload.jks | pbcopy` puts the value on the clipboard.

A tag build **fails** rather than producing a debug-signed bundle, and fails the
same way if `GDRIVE_CONFIG` is missing — a public release with Drive sync
silently absent is worse than no release. Manual `workflow_dispatch` runs only
warn, so an unsigned test build is still possible.

The `Report bundle identity` step prints the signing certificate and the package
line into the log, so the two things Play refuses an upload for are visible
before you ever open the Console.

## Uploading

Download `SingZ-<tag>-android.aab` from the GitHub Release and upload it in the
Play Console under the track you are shipping to. The `.apk` on the same release
is the sideload build — do not upload it to Play; it is there for the phones that
install outside the store.

Store listing copy, Data safety answers and the content-rating questionnaire are
in [PLAY-LISTING.md](PLAY-LISTING.md).

Automating this comes later: the Play Developer API cannot create an app entry,
and refuses uploads for a package that has never had one uploaded by hand. The
first bundle goes up through the Console no matter what. Every upload after that
is fastlane's job — see below.

## Publishing with fastlane

`mobile/android/fastlane/` drives [supply](https://docs.fastlane.tools/actions/supply/).
Lanes, all run from `mobile/android`:

| Lane | What it does |
| --- | --- |
| `preview` | Stages the listing and prints every field with its length. No network. |
| `validate` | Uploads nothing; proves the service account and the bundle are acceptable. |
| `internal` | Bundle → internal track. |
| `closed` | Bundle → closed track (`PLAY_CLOSED_TRACK`, default `alpha`). |
| `production` | Bundle → production as a staged rollout (`PLAY_ROLLOUT`, default 10%). |
| `metadata` | Listing text and graphics only, no binary. |

```bash
cd mobile/android && bundle exec fastlane android validate
```

The release lanes deliberately do **not** push the listing. Shipping a binary
should not silently rewrite the shopfront, so changing the store page is its own
lane, run on purpose.

Graphics are not committed under `fastlane/`. They are staged at run time from
`docs/play-assets/` into the tree supply expects, so the same PNGs are never
stored twice and `scripts/make-play-assets.sh` stays the one place they are made.

Release notes come from `docs/release-notes/v<version>.md`, folded into
`changelogs/<versionCode>.txt` and truncated at Play's 500-character limit with a
warning — write that file by hand when the note is longer than the store allows.

### The service account

supply authenticates as a service account, not as you:

1. Play Console → **Setup → API access** → link a Google Cloud project.
2. In that project, create a service account and download a **JSON key**.
3. Back in Play Console → **Users and permissions** → invite the service
   account's email, granting *Release manager* (or at minimum: view app
   information, and release to the tracks you intend to use).
4. Permissions take a few minutes to propagate. Until they do, `validate` fails
   with a 401 that says nothing useful — wait, then retry.

Locally, drop the JSON at `mobile/android/fastlane/play-service-account.json`
(gitignored). For CI, put its **contents** in a repo secret named
`PLAY_SERVICE_ACCOUNT_JSON` — the workflow passes it through
`SUPPLY_JSON_KEY_DATA` so the credential never touches the runner's disk.

That key can publish to your listing. It belongs in a password manager and a
CI secret, nowhere else.

### From CI

Pushing a `v*` tag builds the bundle and **ships it to the closed testing
track**, with no further input — that is what tagging is for, and testers
should not wait on someone remembering to press a button.

**Production is never automatic.** It reaches strangers, a staged rollout is a
judgement call, and `git tag` is too easy to type. To reach production, dispatch
the Android workflow by hand and choose `production` from the track menu. The
same form offers `validate` (ships nothing, proves the credentials) and a
`metadata` tick box to push the listing in the same run.

Four secrets sign the build and one publishes it:

```bash
gh secret set ANDROID_KEYSTORE_BASE64 < <(base64 -i ~/SingZ-signing/singz-upload.jks)
gh secret set ANDROID_KEYSTORE_PASSWORD   # paste when prompted
gh secret set ANDROID_KEY_ALIAS           # singz-upload
gh secret set ANDROID_KEY_PASSWORD        # same as the store password
gh secret set PLAY_SERVICE_ACCOUNT_JSON < mobile/android/fastlane/play-service-account.json
```

The service-account JSON goes in as **file contents**, not a path: the workflow
hands it to supply through `SUPPLY_JSON_KEY_DATA` so the credential never
touches the runner's disk.

The closed track here is a custom one named `Testing`. If that ever changes,
set a repo **variable** `PLAY_CLOSED_TRACK` to the new name — asking Play for a
track that does not exist returns an empty track rather than an error, which
looks exactly like an upload that silently failed.

## First release: the personal-account path

A personal developer account registered after 13 Nov 2023 cannot reach
production until **12 testers have been opted into a closed test for 14
continuous days**. Two traps in that sentence:

- **Internal testing does not count.** The clock only runs on a *closed* track.
- **Listed is not opted in.** Each tester must follow the opt-in link and
  install from Play. Someone sideloading the APK counts for nothing, and if the
  opted-in count drops below 12 the 14 days are at risk.

So the clock is the critical path, and everything else fits inside it. Order:

1. **Create the upload key** (above) and keep it somewhere you will still have
   in five years.
2. **Publish the privacy policy.** GitHub Pages, source `main` / `docs`, gives
   `https://lexasoft123.github.io/SingZ/privacy-policy.html`. Load it in a
   browser before going further — a closed test cannot roll out without a URL
   that actually resolves.
3. **Create the app** in the Console (name, default language, app/free).
4. **Complete every item under App content.** All the answers are written out in
   [PLAY-LISTING.md](PLAY-LISTING.md): privacy policy URL, ads (none), app
   access (no login — say so explicitly), content rating questionnaire, target
   audience (13+), Data safety (no data collected), plus the government /
   financial / health declarations. Closed testing is blocked until this section
   is complete, and Data safety specifically is required on any track except
   internal.
5. **Fill the store listing** — copy and graphics from
   [PLAY-LISTING.md](PLAY-LISTING.md) and `docs/play-assets/`.
6. **Build a signed AAB** and upload it to a **Closed testing** track.
7. **Add 12+ testers.** Use a Google Group as the tester list rather than a raw
   email list — you can then add and remove people without editing the track.
   Send them the opt-in link and confirm each one installs.
8. **Wait 14 days**, then apply for production access. Use the wait to gather
   real feedback; the review afterwards asks what you changed because of it.

Steps 1–7 are a single evening's work. Step 8 is the part no amount of
preparation shortens, which is why it starts first.
