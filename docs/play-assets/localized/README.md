# Localized Google Play screenshots

Real SingZ 0.26.5 Android release captures, taken on a dedicated Pixel 7 / API 36 emulator on 25 October 2026. The release was rebuilt with R8 optimization enabled and tested through its native UI; screenshots do not rely on development-only driver hooks.

Each listing locale has four images in filename/upload order: highlighted-lyrics player, mixer, training dashboard, and interval exercise setup. The interface follows Android's per-app language; the bundled sample retains its original English lyrics.

Locales: en-US, ru-RU, zh-CN, hi-IN, ja-JP, ko-KR, th, id, vi, fil, ms, tr-TR and zh-TW.

Files are RGB PNGs, 1251×2224 (exact 9:16). Only the OS status and navigation bars were cropped from 1080×2400 captures (y=112 through 2336). The intact 1080×2224 app content is centered on a dark canvas, with 85/86 px side padding; it is never stretched or enclosed in a synthetic device frame. Playback was silent. All captures were visually reviewed.

`fastlane android metadata` stages each locale's own set from these folders, preflighting every locale before replacing staged images. Binary publishing lanes continue to skip listing images.

Turkish captures (`tr-TR`) were added on 28 October 2026 with app support and store copy. They are prepared for the next release, so the public listing does not advertise an interface language before its binary ships.
