# iPhone store screenshots

Training assets refreshed for the next release:

- `04-train.png`: daily program and dated practice activity.
- `05-practice.png`: guided interval with the current target highlighted.
- `07-sounds.png`: exercise setup with globally remembered instrument, volume and pitch window.

Captured from the real iPhone 17 simulator app on 6 October 2026, using this branch and UI kit 1.9.4. Practice history is demonstration data in the simulator; cue playback was muted. Captures are scaled from 1206×2622 to 1320×2868, RGB without alpha, for the 6.9-inch store slot. Existing song/library images remain valid.

English screenshots are shared across the existing storefront locales. EN/RU/Simplified Chinese listing descriptions live under `mobile/ios/fastlane/metadata/`. Assets are prepared locally; publishing uses `scripts/push-ios-screenshots.rb` as documented in `docs/IOS-RELEASE.md`.

## Header and search creatives

`creative/header-{en-US,ru,zh-Hans}.png` uses Apple's 3840×1646 header size.
`creative/search-{en-US,ru,zh-Hans}.png` uses the 1920×1280 search-result size.
All are RGB PNGs without transparency. `*-preview.png` files are 800-pixel
review copies, not upload assets. Regenerate with:

```sh
node scripts/make-ios-creative-assets.cjs
```

The artwork uses the real bundled-song player capture and the interval exercise
capture. Marketing copy is localized; captured app screens are English.
There are no prices, URLs, platform logos or unsupported awards in the artwork.

References: [Apple asset best practices](https://developer.apple.com/app-store/asset-best-practices/)
and [creative specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/creative-assets-specifications).

On 6 October 2026 the API verified the karaoke-focused name, subtitle, keywords,
description and promotional text for en-US, ru and zh-Hans on the pending
0.26.1 version. Fastlane was updated to 2.240.1. Its client and Apple's
22 September 2026 public OpenAPI schema do not contain creative Asset Library
endpoints; artwork upload must use App Store Connect until that API is published.
All six creative PNGs were uploaded through App Store Connect on 6 October 2026
and submitted together. Apple confirmed “6 Items Submitted”; all six assets are
Waiting for Review in submission `8a1af88d-29a8-448b-97b0-536d9e93c392`.
They are not yet approved or assigned to localized header/search placements:
the pending 0.26.1 version's creative selector is disabled while Waiting for
Review. Complete placement assignment when Apple makes that control available.
