# Localized App Store screenshots

Captured from the real SingZ 0.26.5 app on dedicated iPhone 17 Pro and 13-inch iPad simulators on 25 October 2026. Each locale has four screenshots in upload order:

1. Player with highlighted lyrics from the bundled “Sing with me” sample.
2. Mixer and per-song output level.
3. Training dashboard with song preparation.
4. Interval exercise setup.

The interface follows each system language. The sample's own English lyrics stay in their original language. No UI was redrawn. Playback and training cues were muted; development overlays were hidden before capture. Every capture was visually reviewed.

`iphone/<App Store locale>/` contains 1320×2868 RGB PNGs for `APP_IPHONE_67`. Captures were resized with Lanczos while preserving proportions, trimming at most two outer pixels. `ipad/<App Store locale>/` contains native 2064×2752 RGB PNGs for `APP_IPAD_PRO_3GEN_129`.

Locales: en-US, ru, zh-Hans, hi, ja, ko, th, id, vi, ms, tr, es-MX, pt-BR and zh-Hant. Apple does not offer a Filipino listing locale; Filipino captures are included in the Google Play set instead.

The uploader preflights all locale folders and replaces only the specified device family:

```sh
scripts/with-apple-secrets.sh ruby scripts/push-ios-screenshots.rb docs/ios-assets/localized/iphone APP_IPHONE_67
scripts/with-apple-secrets.sh ruby scripts/push-ios-screenshots.rb docs/ios-assets/localized/ipad APP_IPAD_PRO_3GEN_129
```

Apple locks screenshot edits while a version waits for review. The uploader refuses that state before changing any sets. These assets can be applied to an editable version; released 0.26.5 screenshots remain unchanged. The Turkish sets added on 28 October 2026 are prepared for the next update.

Latin American Spanish (`es-MX`, including Peru) and Brazilian Portuguese (`pt-BR`) sets were added on 29 October 2026 from the corresponding real simulator interfaces. These are prepared for the next release.
