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
All six original creative PNGs were assigned to their localized header/search
placements and resubmitted with 0.26.1 (30) on 6 October 2026 at 11:44 Moscow.
The app submission is `37f4c5a1-a4d5-4ce4-b8de-73145f31efa3`; the app and
six creatives showed Waiting for Review.

The original submission was withdrawn and all six revised creatives were uploaded
and assigned to en-US, ru and zh-Hans. The replacements use larger, equally wide
upper-screen phone crops with a fade at the bottom, and keep the headline inside
the visible center. App Store Connect's product and search previews were checked
on iPhone, iPhone Duo (outer/inner display) and iPad, including available portrait
and landscape views. Russian and Chinese header/search artwork was also checked.

The replacements and 0.26.1 (30) were resubmitted on 6 October 2026 at 12:48
Moscow. Submission `a0669c39-8490-48ce-844d-36e159ccec19` and all six replacement
creatives showed **Waiting for Review**. The old creatives remain unassigned in
the Asset Library. The renderer also writes conservative portrait and landscape
crop checks to `/private/tmp/singz-header-*-crop.png`; those are estimates, not
Apple's official device renderer.

The App Store Connect header thumbnail was measured at 478×205 pixels, displayed
at 560×240 CSS pixels, while the uploaded source was 3840×1646. The thumbnail
explains the visible softness in the administration page; it does not establish
the quality of the eventual live App Store rendering.
