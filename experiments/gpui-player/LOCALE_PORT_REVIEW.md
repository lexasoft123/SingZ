# Native locale checkpoint — 2026-11-08

System language and all thirteen source locales now work in the native header menu.
The shared popup, flags, row controls and rich-text helpers live in `singz-ui/gpui`.
Rust extracts the existing TypeScript dictionary literals during the build; no Node
executes during build, tests or runtime. Dictionary counts are 1,238 per locale,
except Russian's 1,260 plural forms. Unknown keys fall back through English.

The native worker resolves system/forced language, persists `language.json` without
discarding unknown fields, and fences stale startup and selection receipts. Picking
a language updates mounted views without reopening the audio graph. The menu supports
arrows, Home/End, wrapping, Enter/Space, Escape, Tab/Shift-Tab and outside dismissal.
Its viewport cap/scroll is an explicit native usability adaptation; production popup
pixel parity is unqualified.

Source keys now drive header/catalog, player controls, Settings, lyrics sidebar,
training, storage/import/delete/export, Quick start and release chrome. Quick start
has source English/Russian copy and intentionally falls back to English elsewhere.
Release content uses the source's available-translation fallback. Backend errors,
native-only statuses/dates, lyrics editor, model/setup, Log, Carry and metronome still
need a complete localization audit. The source opened-song deletion warning promises
continued playback; the native implementation stops/closes that song, so its accurate
English warning is retained pending accurate translations.

Thai captures exposed missing complex-script segmentation. The GPUI wrapper now uses
the already bundled ICU dictionary segmenter. Three tests exercise the actual
production break API, including Thai and mixed grapheme clusters. The upstream vendor
test harness lacks its font/dev assets and is not claimed as passing.

Keyboard testing also exposed stale focus after importing a project: closing the
modal restored an Import header handle that had disappeared. Explicit player focus
now takes precedence over that restoration. The empty-project workflow asserts
mounted-root focus before dispatching the real Save shortcut; no forced test focus.

Verification on the final source:

- Five consecutive Rust suites: 747 passed, 0 failed, 2 ignored each; 11 UIKit tests
  and 8 comparator self-checks pass. Earlier intermittent engine probe timeouts remain
  undiagnosed; test-only bounded diagnostics were added without relaxing deadlines.
- Hidden, muted locale flow: 47 PNGs, both 1280×800 and 1060×640 at 2×, all fourteen
  choices, preserved search draft/native playback, EN/RU tour/release copy, rapid picks,
  unknown preference preservation and real restart into Japanese; foreground unchanged.
- Eleven final background UI drivers pass: locale, timing, monitor, Carry, picker,
  Quick start, release, training, export, sidebar and Drive. Dedicated empty-project
  verification passes sixteen captures/three processes, including post-import Save.
- Strict historical native comparisons: 25/84 full frames exact; 59 differ (10 training,
  49 player frames). Source English punctuation/degree/control/status copy changed;
  full-frame reports, overlays and differences remain preserved. All 49 approved lyric
  paint frame records/regions remain exact. All 86 shared/dist font hashes unchanged.

Durable evidence: `gpui-locale-20261108` in this chat's visualization directory,
including identity hashes, source recovery, captures, comparisons, logs and manifest.
CPU/memory and system-wide GPU telemetry are recorded; hidden macOS live FPS remains
unmeasured. This checkpoint establishes native functionality, not production visual,
animation, accessibility, hardware, Windows/Linux or packaging parity. The full desktop
goal remains active.

## Follow-up: metronome and Carry labels

The next source batch connects metronome labels, grid/version status and user-bar
plurals, count-in choices and detection captions to the source keys. The no-grid
caption now distinguishes whether Re-detect is available, as the source does.
Carry uses source labels and plural captions; built-in lane names are translated
only in the widget's cloned display inventory, preserving custom names and scheduling
IDs. Shared UIKit adds label-accepting header/lane helpers with unchanged English
wrappers. Neither change alters accepted audio/grid/configuration state.

The expanded hidden locale driver passes 55 captures, including English/Russian
popovers at both sizes, continued native playback, unchanged project bytes, rapid
preference choices and Japanese restart. Existing Carry and metronome workflows
also pass (20 and 16 captures), including keyboard/scroll/long custom names,
tempo/grid changes, Save and restart. English/Russian compact and full popovers
were visually inspected. Current-source normal and UI builds pass.

The follow-up full Rust suite reports 746 passed, 1 failed, 2 ignored: the known
engine-status fake-command timeout recurred. Its timeout trace records no output,
no observed exit and a maximum polling gap of 8.9 ms; the root cause remains open.
The isolated engine-status subset then passes all ten tests. This follow-up does
not claim a green full suite. No deadlines, expectations or ignored tests changed.

Strict Carry comparisons against the preceding locale checkpoint yield 5/20 full
frames exact. The others include asynchronous mixer/waveform/playback-state differences;
for example `off-1280` differs in track presentation while the popup copy remains
visually unchanged. Reports preserve every difference without masking or alignment.
The older Drive comparison also remains preserved separately; it predates locale
header changes and is not substituted for the newer reference. Production visual
and temporal parity, all-locale layout, tooltips and accessibility remain unqualified.

Follow-up evidence lives in the sibling `gpui-popover-locale-20261108` archive.
