# C-44 native handover export contract (C-40 consumer)

The last Electron **desktop** build writes `<userData>/native-handover.json`
atomically from renderer preferences. Box never writes this file. It contains no
credentials, account information, project paths, raw audio or active sessions.
The native importer opens it read-only; it never opens Chromium localStorage.

```json
{
  "formatVersion": 1,
  "product": "desktop",
  "audio": {
    "nativeOutputUid": "opaque-current-native-playback-output-uid",
    "nativeInputUid": "opaque-native-input-uid",
    "inputChannel": 0,
    "nativeMonitorOutputUid": "opaque-native-monitor-output-uid",
    "nativeMonitorOutputChannels": [0, 1],
    "monitorGainDb": -18
  },
  "metronome": {
    "click": false, "countInBars": 0, "volume": 0.7,
    "accent": true, "grid": false
  },
  "karaoke": false,
  "trainingControls": {
    "formatVersion": 1, "sound": 0, "volume": 0.65,
    "tolerance": 1, "focus": 0, "program": null
  }
}
```

`formatVersion` and `product` are required. Unknown versions or a non-desktop
product are skipped with a durable reason; unknown fields are ignored. Each
optional top-level item is independently imported once, unless native holds a
non-default value. Absent file/items retain native defaults and are recorded as
skipped; a later export does not override a recorded skip. Invalid JSON,
oversized, unreadable, linked or changing files retry on a later launch.

`audio` may include the existing Electron `AudioPrefs` object. C-44 additionally
exports `nativeOutputUid` **only if the current native playback route proves it**;
never relabel a Chromium `outputId` as a native UID. The native consumer ignores
Chromium `inputId` and ordinary `outputId`; Linux's explicit `native:<uid>` output
ID is understood. All three native UIDs are matched against present native
devices with the right direction. Missing or stale IDs use system defaults.
Channels must exist on that device; invalid input channels fall back to zero;
monitor output channels must be distinct. `monitorGainDb` accepts -60 through 0.
Monitoring is never enabled and headphone confirmation is never imported. The
consumer currently uses the native platform-default provider: ASIO exports do
not change the provider or reinterpret provider-scoped output UIDs.

`metronome` requires the five fields shown, with booleans, count-in 0..2, and
finite volume 0..1. `karaoke` is a boolean. `trainingControls` matches native
`training_store::Controls`: sound index 0..3 (Electron's training sound must be
mapped to the native order), reference volume 0..2, tolerance index 0..3,
focus 0..12, optional program `{ "level": 0..2, "startedAt": <safe unsigned JS timestamp> }`.
Unknown fields in these exported objects are ignored. No automatic program start
or active training session is restored. Use the native Controls defaults for
values that have no Electron equivalent; export a complete Controls object.

Training profile preferences and completion receipts are imported separately
from `training-preferences.json` and `training-receipts/` using their shared
schemas, not from this export. Drive auth and dirty-ledger adoption are C-41.

Electron default discovery was checked in Electron v38's
[`ElectronPathProvider`](https://github.com/electron/electron/blob/v38.0.0/shell/app/electron_main_delegate.cc)
and [`DIR_APP_DATA`](https://github.com/electron/electron/blob/v38.0.0/shell/common/electron_paths.h):
userData appends the application name to appData; macOS uses Application Support,
Windows roaming AppData (Chromium [macOS provider](https://github.com/chromium/chromium/blob/main/base/base_paths_mac.mm) and [Windows provider](https://github.com/chromium/chromium/blob/main/base/base_paths_win.cc)), Linux XDG_CONFIG_HOME (fallback `~/.config`). Candidate
identities are packaged `SingZ`, development `singz`, then driver `Electron`, in
that precedence, with one profile pinned for the whole import. No Box candidate
is considered and custom Electron userData overrides are not searched.

C-40 retains `qwenOfferDismissed` as `qwen_offer_dismissed` (a boolean) in the native migration receipt: no native Qwen launch-offer store or consumer exists in this checkout. A future offer owner must honor that imported boolean. Custom native config overrides and fixture/review launches suppress automatic source discovery, so automation never reads the real Electron profile.

## Startup and retry behavior after C-40 review

Electron `settings.json` has a 4 MiB read bound because its unrelated Drive dirty
ledger can contain many absolute project paths. The handover export remains
bounded at 64 KiB. Final-component symlinks/reparse points are refused; symlinked
HOME/config ancestors are supported, with canonical source/destination overlap
checks retained.

Library-root canonicalization, metadata and directory probes run on a read-only
worker with a two-second deadline. Late results cannot publish preferences.
Missing/unmounted/unreadable/timed-out libraries retry on the next launch, up to
20 probe attempts; exhaustion has a durable reason. Relative/invalid roots stay
terminal. Publication never probes or writes the adopted root.

The pre-window phase records eligible audio-device adoption as retryable without
querying hardware. A first-frame callback starts the device migration on a
background worker; helper failures/timeouts retain `retry-later`. Publication
rechecks native device choices under the audio-store lease so a choice made by
the singer while enumeration runs wins. Migration persists the preferences and
does not reroute an already initialized/playing audio session; the next backend
initialization restores the adopted choices.

The settings summary counts preference groups actually imported during the
current process. Historical import outcomes remain in `migration.json` without
showing the summary on subsequent launches. Size-only window imports centre on
the native display and preserve that centred normal frame through maximization.
