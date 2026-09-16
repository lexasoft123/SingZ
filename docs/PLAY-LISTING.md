# Google Play listing — SingZ

Everything the Play Console asks for that fastlane cannot upload for you — the
declarations, the questionnaire answers, and the reasoning behind them — written
out so they can be answered rather than improvised at the keyboard. The listing
copy itself is version-controlled and pushed by fastlane; see below.

> **The one claim to keep straight.** SingZ works on music the singer already
> has — there is no catalogue, no store and no streaming. A song reaches the
> phone either split ON the phone (a file the singer picks, separated on the
> device after a one-time ~136 MB model download, on phones with enough
> memory) or prepared in the SingZ desktop app and read over Google Drive or a
> copied folder. Every paragraph below is written so a stranger installing
> this from a cold search understands that before they tap Install — both
> because it is true and because "misleading claims" is a Play policy. (The
> phone once could not split at all, and this box said so; a listing that
> still says it undersells the app and contradicts the Add a song button.)

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

**Permissions.** `INTERNET`; `RECORD_AUDIO` (asked only when the singer opens a
listening feature — the pitch guide or vocal training — analysed live, never
recorded or stored); `POST_NOTIFICATIONS`; and three foreground-service types,
each of which Play asks about in its own declaration (below).

### Foreground service permissions

Play Console → App content → **Foreground service permissions**. Every type
the manifest declares needs a description, the user impact if the task were
deferred or interrupted, and a short video of the feature in use.

| Permission | Service | What to answer |
| --- | --- | --- |
| `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | `NowPlayingService` | **Media playback.** SingZ plays music (a song split into instrument tracks for singing practice). While a song is playing, a media notification with play, pause and skip keeps it playing when the user locks the phone or leaves the app. The service is foreground only while a song is actually playing; pausing detaches it. *Impact if interrupted:* the song the user is singing along to stops mid-song. *Video:* open the sample song, press Play, lock the phone, show the music continuing and the lock-screen controls pausing and resuming it. |
| `FOREGROUND_SERVICE_MEDIA_PROCESSING` (API 35+) / `FOREGROUND_SERVICE_DATA_SYNC` (29–34) | `SplitService` | **Separating a song into tracks.** Started only when the user adds a song and asks for it to be split; the split runs on the device for several minutes with a progress notification and a Cancel button. *Impact if interrupted:* the split is lost and has to start again. *Video:* Add a song → pick a file → the progress notification counting chunks. |

`mediaPlayback` was added in 0.22.0 (Now Playing). Update the declaration
before sending that release for review — Play Console checks the declared
types against the bundle's manifest at submission.

A declaration for a permission Play has never seen from this app cannot be
filled in before that bundle is uploaded, and a finished release carrying it is
refused until it is. `fastlane android draft` breaks the circle: it uploads the
bundle as a draft, which reaches no tester but does make the form appear.
`fastlane android promote` finishes the release afterwards. See
[docs/ANDROID-RELEASE.md](ANDROID-RELEASE.md) § When a new permission deadlocks
the release.

---

## Graphics

Generated into `docs/play-assets/` by `scripts/make-play-assets.sh`:

| Asset | Spec | File |
| --- | --- | --- |
| App icon | 512×512 PNG, no alpha | `icon-512.png` |
| Feature graphic | 1024×500 PNG, no alpha | `feature-1024x500.png` |
| Phone screenshots | 2–8, PNG, 9:16 | `screenshot-*.png` |

Screenshots are captured from the real app on an emulator, not mocked up.
