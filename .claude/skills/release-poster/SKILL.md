---
name: release-poster
description: Make the SingZ release poster and the Telegram post text for a version — a vertical collage of real app interface highlights plus short EN/RU channel copy. Use this whenever the user asks for a release poster, a Telegram/WhatsApp post or announcement for a release, an "announce v0.x" image, channel copy for a new version, or a visual to go with release notes — and whenever a release is being cut and the channel needs telling. Also use it to redo or restyle an existing poster.
---

# SingZ release poster

Two deliverables, and they carry different loads:

1. **The poster** — a 4:5 image, real interface fragments collaged, read at
   the size of a phone chat column.
2. **The post text** — English and Russian, short, in the release-notes voice.

The split matters. The poster is seen at ~400 px wide and carries **very few,
very large words**; the prose lives in the caption, where the reader gets it at
native size. Trying to fit the release notes onto the image is the single
easiest way to produce something nobody can read.

## How this gets triggered

Usually by `.claude/hooks/poster-after-tag.sh` (PostToolUse/Bash), which fires
when a `v*` tag is created and hands the session the version. It skips
hyphenated prereleases — those go to one tester, not the channel — and stays
quiet if `docs/release-notes/v<version>-poster.png` already exists, so
re-tagging does not nag. Its truth table is `poster-after-tag.test.sh`.

The hook only *asks*. It cannot build the poster itself, and no CI job can
either: every fragment is a screenshot of the running app, which needs the
built desktop app, a booted simulator with this build installed, and the song
library. If any of those is missing, say so — do not substitute a mockup.

## Before anything else: what release is this?

Read `docs/release-notes/v<version>.md`. It is the source of truth for what
shipped, and its first line (`v<version> — <tagline>`) is the release's own
framing. Pick the **two or three** changes a singer would actually notice —
not the longest section, not the cleverest engineering. If the notes do not
exist yet, they get written first (see CLAUDE.md § Releasing); a poster for a
release nobody has described is guesswork.

Decide from the notes **which surface the release is about**. A phone release
needs phone screenshots; shipping desktop shots for it misrepresents the work.

## Capture: real UI only

Every fragment is a screenshot of the running app. Never mock up, redraw, or
"clean" a screen in the poster — this repo verifies by driving the real app,
and a poster of invented UI is a claim about the product that no test covers.

**Stage a presentable library first.** A dev machine's library is full of
`Split test iOS B 3` and duplicate imports, and they are legible in the
catalog shot. Either open a device/library whose song list you would show a
stranger, or frame around the junk — and check the result rather than assuming.

```bash
npm run build                                    # out/ must be current
node .claude/skills/release-poster/scripts/capture-desktop.cjs
```

`E2E_PROJECT` picks the song, `E2E_OUT` the shot directory. It launches with
`SINGZ_MUTE=1` and `SINGZ_NO_SYNC=1` — silent because automated runs are
silent, and sync-free because a poster run on a signed-in machine must never
push the real Drive.

For phones the template wants **two specific screens**, in this order:

1. **The catalog** — tab row, "Add a song", songs with their stem counts. This
   is where the Split button lives, so it is also the source for the zoom.
2. **The player** — lyrics mid-song. Open the bundled
   **"Sample — Sing with me"** for this: its words are ours, so the poster can
   be published without putting someone else's lyrics on a public channel.
   It sits at the bottom of the "This iPhone" list.

Drive the app to each, capturing as you go:

```bash
.claude/skills/release-poster/scripts/capture-phone.sh ios <shots-dir>   # once per screen
.claude/skills/release-poster/scripts/make-phone-crops.sh \
  <shots-dir>/phone-ios-<catalog>.png <shots-dir>/phone-ios-<player>.png <shots-dir>
```

`capture-phone.sh` writes timestamped files; `make-phone-crops.sh` turns the
two you chose into `phone-cat-crop.png` and `phone-kar-crop.png`, which are the
names the template and `fragment-widths.json` use. Do this rather than cropping
by hand — hand-cropping gives a different answer every run.

Screenshots are headless; no live panel is needed. If the change being
announced is native, the installed build must postdate it — a stale binary
photographs the old app perfectly.

**Read every screenshot you take.** Look for: the `dev` badge in the titlebar,
song titles you would not publish, a half-loaded waveform, an empty state where
you expected content.

## The zoomed detail is what sells it

At chat-column size, a whole app window is texture — pleasant, unreadable, and
it proves nothing. What lands is **one control, blown up**: the Split button,
the tick that means "downloaded", the verdict row. Crop it tight and give it
the accent glow.

**Measure the crop, never eyeball it.** Uneven padding around a button is
instantly visible once it is floating on a dark ground — the first attempt here
left 11 px on one side and 42 on the other, and it read as a broken export.
Every primary control in the app is painted with the accent, so it can be found
by colour:

```bash
python3 .claude/skills/release-poster/scripts/find-control.py shots/phone-ios-<catalog>.png --pad 26
# 39 accent regions (sizes: 35721, 7443, 1248, 1248…); showing the largest …
# control  x 786..1133 (w 348)  y 336..438 (h 103)      <- the "This iPhone" tab
```

It reports **every** accent region, because the wordmark, the logo bars and any
active tab are painted with the same colour as the button. Pick the one you
meant with `--nth 1` or by constraining the search:

```bash
python3 … find-control.py shots/phone-ios-<catalog>.png --pad 26 --region 600,2200,1206,2622
# control  x 963..1106 (w 144)  y 2398..2464 (h 67)     <- the Split pill
# crop=196:119:937:2372
ffmpeg -y -i shots/phone-ios-<catalog>.png -vf "crop=196:119:937:2372" shots/zoom-split.png
```

Those numbers are for a 1206×2622 iPhone shot with the unsplit song where it
happened to sit — the region and the resulting crop change with the device and
how far the list is scrolled. Re-measure every time; the point of the script is
that re-measuring is cheap.

Pair it with a short mono pointer (`One tap →`). That pairing — a real control
plus three words — does the work a paragraph would fail at.

## Compose

Start from `assets/poster-template.html`, which is the approved house style.
Replace `__REPO__` with the repo path (the brand fonts load from
`node_modules/@fontsource-variable/…`), `__SHOTS__` with the shot directory,
`__VERSION__` with the tag.

The direction is a **studio contact sheet**: fragments pinned at angles, deep
shadows, a warm stage bloom, mono annotations like a producer's markup. It is
deliberately dense — but density is not the goal, legibility at 400 px is, and
every element that cannot survive that shrink is costing space it does not earn.

Palette and faces come from the app's own tokens (`--sz-accent #ffa028`,
`--sz-bg #12100d`, Bricolage Grotesque, Martian Mono). Do not invent a palette;
the poster should look like the product, and the product already has one.

**Minimum sizes on the 1024-wide canvas** (a Telegram photo renders ~400 px in
a phone chat, so divide by ~2.5 for what the reader gets):

| element | size | why |
| --- | --- | --- |
| headline | 90–100 px | the only thing guaranteed to be read |
| subhead | 34–38 px | one line, not two |
| bullets | 30–34 px | three lines, ≤ 6 words each |
| mono labels | 22–25 px | below this they are decoration |

Composition rules that came from getting them wrong:

- **Never cut a fragment mid-word.** A plate sliced through text reads as a
  broken export, not a crop. Show the whole panel scaled down, or crop on a
  clean edge.
- **Keep the collage in its own fixed-height box.** Phones that overflow it
  land on the bullets and hide them.
- **Do not repeat content between fragments.** A zoomed lyric line next to a
  phone showing the same lyric just looks like a duplicate.

## Sharpness: resize once, render 1:1

A soft poster is the most common failure, and the cause is always the same —
the same pixels resampled two or three times over. A 1206 px phone screenshot
dropped into a 264 px slot is reduced 4.6× by the renderer, and the app's own
small text turns to mush.

So do the reduction **once**, with a good filter, before rendering:

```bash
.claude/skills/release-poster/scripts/prep-fragments.sh shots/ shots-1x/
node .claude/skills/release-poster/scripts/render.cjs poster.html <out-dir> v0.16.0-poster
```

`prep-fragments.sh` resizes each fragment to the exact width the template
displays it at (lanczos + mild unsharp), reading `assets/fragment-widths.json`.
`render.cjs` then renders at 1024×1280, DPR 1, with no downscale afterwards —
text is rasterised natively at final size and fragments land pixel-for-pixel.

If you move a fragment or change its width in the CSS, change it in
`fragment-widths.json` too. They are two halves of one rule, and a fragment
prepped to a width it is no longer displayed at is silently resampled again.
After touching either, check them:

```bash
node .claude/skills/release-poster/scripts/check-widths.cjs poster.html
```

Watch the box model when you do. `.frag`/`.phone` are `border-box` with a 1px
border, so a wrapper at `width: 264px` gives its child a **262px** content box;
an `img { width: 100% }` inside then lands 2px under its source and gets
resampled at 0.992× — same size on screen, every pixel softened, nothing
anywhere reporting it. That shipped once and was caught by review, not by eye.
Either set the image's width explicitly, or make the wrapper 2px wider than the
manifest says.

Pass `--2x` for an additional 2048×2560 copy to send as a **file** rather than
a photo — Telegram recompresses photos past ~1280 on the long side, so that is
the only way to hand someone the full-detail version.

**Read the 400 px preview.** It is the acceptance test: if a bullet, the
version or the zoomed control cannot be read there, it cannot be read in the
channel. Fix and re-render rather than shipping and hoping.

## The post text

English and Russian, both. The notes' `<!-- store:ru-RU -->` block is the
register to match — plain, warm, no marketing throat-clearing.

Telegram allows **1024 characters on a photo caption**; aim well under. Shape:

```
🎤 SingZ v<version> — <the tagline, lowercased into a sentence>

<what you can now do, in one short paragraph — the singer's action, not the feature>

<the annoyance that stopped, one line>

<one smaller change worth knowing, one line>

iPhone · Android · Mac · Windows
```

Write from the singer's side: "Add a song right on your phone. Tap Split." —
not "on-device separation is now supported". Sizes and times earn their place
("about one song-length", "136 MB, once"); adjectives do not.

## Ship it as a post kit, not as loose files

Posting means getting one image and one specific block of text into Telegram.
A PNG path plus two `.txt` files makes the human do that assembly every time,
and retyping a caption is how a typo reaches a channel. So the deliverable is a
single page with a copy button on each piece:

```bash
node .claude/skills/release-poster/scripts/make-post-kit.cjs \
  --poster docs/release-notes/v<version>-poster.png \
  --preview <out>/v<version>-poster-phone-preview.png \
  --en <out>/caption-en.txt --ru <out>/caption-ru.txt \
  --version v<version> --out <out>/post-kit.html
```

It embeds the poster and the display face, so the page is self-contained and
survives being moved or emailed. **Copy image** puts the PNG on the clipboard —
paste straight into Telegram — with **Save PNG** as the fallback, and each
caption shows its length against the 1024 limit.

Keep it a **local** file. A published artifact cannot hand the viewer a
download and is a poor place for clipboard work; this page exists to be
operated, not shared.

Then hand it over with `SendUserFile`. Don't commit the kit — it carries a
base64 copy of the poster and is regenerated in seconds.

## What goes in the repo

Only the poster, next to the notes it belongs to, so each release keeps its own:

```
docs/release-notes/v<version>-poster.png
```

Commit it with the notes. Posting to the channel is the user's call — say the
image is send-as-photo safe at 1280.
