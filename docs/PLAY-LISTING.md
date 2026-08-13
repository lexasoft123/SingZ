# Google Play listing — SingZ

Everything the Play Console asks for that fastlane cannot upload for you — the
declarations, the questionnaire answers, and the reasoning behind them — written
out so they can be answered rather than improvised at the keyboard. The listing
copy itself is version-controlled and pushed by fastlane; see below.

> **The one claim to keep straight.** The phone app *plays* song projects; it
> does not split them. Splitting happens in the SingZ desktop app, and the
> phone reads the result. Every paragraph below is written so a stranger
> installing this from a cold search understands that before they tap Install —
> both because it is true and because "misleading claims" is a Play policy.

---

## Store listing

The copy itself lives in `mobile/android/fastlane/metadata/android/en-US/`,
because that is what fastlane uploads. Editing it here as well would create two
answers to one question, and the one the store shows would be whichever fastlane
read last.

| Field | File | Limit |
| --- | --- | --- |
| App name | `title.txt` | 30 |
| Short description | `short_description.txt` | 80 |
| Full description | `full_description.txt` | 4000 |
| Release notes | `changelogs/<versionCode>.txt` | 500 |

`fastlane android preview` prints each one with its length and flags anything
over, without touching the network.

**Category:** Music & Audio
**Tags:** Music, Karaoke, Singing, Practice
**Contact email:** lexasoft@gmail.com
**Website:** https://github.com/lexasoft123/SingZ
**Privacy policy:** https://lexasoft123.github.io/SingZ/privacy-policy.html

---

## App access

Play reviewers must be able to reach every screen. Answer:

> **All functionality is available without signing in.**
> The app opens with a bundled sample song and a working library. Google Drive
> sign-in is optional and only adds a second library source; no feature is
> behind it, and no account is required to review the app.

Give no credentials. There are none to give — there is no SingZ account.

---

## Data safety

The honest answer to the first question is **no**, and the rest of the form
collapses behind it. The reasoning, in case it is ever queried:

- Play defines *collection* as **transmitting data off the device**. SingZ has no
  server. Nothing is transmitted to the developer, because there is nowhere to
  transmit it to.
- Song files are read from device storage or downloaded **from** the user's own
  Drive. Data moving onto the phone is not collection.
- The account email arrives from Google inside the sign-in response and is shown
  in the UI. It is never sent anywhere.
- Traffic to Google's own OAuth and Drive endpoints is the user reaching their
  own account at their own direction, not the developer sharing their data.

| Question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | **No** |
| Is all user data encrypted in transit? | **Yes** (HTTPS to Google only) |
| Do you provide a way for users to request data deletion? | **Yes** — uninstall removes all app storage; Drive access is revocable at myaccount.google.com/permissions |

> **Judgment call worth knowing about.** Some developers additionally declare
> "Files and docs — collected, app functionality" on the grounds that Drive
> traffic touches user files. It is defensible either way. The declaration above
> matches Play's written definition of collection, and matches what the code
> does. If Google ever queries it, the answer is the four bullets above.

---

## Content rating (IARC questionnaire)

Category: **Utility, Productivity, Communication or Other** → Music.

Every content question answers **No**: no violence, no sexuality, no profanity
from the app itself, no controlled substances, no gambling, no simulated
gambling, no horror, no crude humour.

Two that trip people up:

- **Does the app allow users to interact or exchange content?** No. There is no
  network between users, no comments, no sharing to other users. The Android
  share sheet for the diagnostic log is not user-to-user content exchange.
- **Does the app share the user's location?** No.

Expected result: **Everyone / PEGI 3**.

Note the app plays whatever recordings the user supplies, so lyrics may contain
anything — that is user-supplied media on their own device, not app content, and
the questionnaire is about the app.

---

## Remaining declarations

| Declaration | Answer |
| --- | --- |
| Ads | No ads |
| Target audience | 13+ (below 13 pulls the app into the Families programme and its extra review) |
| News app | No |
| COVID-19 contact tracing or status | No |
| Government app | No |
| Financial features | None |
| Health apps | No |
| Data deletion URL | Not required — no account exists to delete |

**Permissions.** The app declares `INTERNET` and nothing else. No sensitive or
restricted permission is used, so no permissions declaration form is triggered.

---

## Graphics

Generated into `docs/play-assets/` by `scripts/make-play-assets.sh`:

| Asset | Spec | File |
| --- | --- | --- |
| App icon | 512×512 PNG, no alpha | `icon-512.png` |
| Feature graphic | 1024×500 PNG, no alpha | `feature-1024x500.png` |
| Phone screenshots | 2–8, PNG, 9:16 | `screenshot-*.png` |

Screenshots are captured from the real app on an emulator, not mocked up.
