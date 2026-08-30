/*
 * Build the post kit: one self-contained HTML page holding the poster and both
 * captions, with a copy button on each.
 *
 * Why a page and not just files: posting means getting an image and a specific
 * block of text into Telegram. Handing over a PNG path and two .txt files makes
 * the human do the assembly every time, and retyping a caption is how a typo
 * reaches a channel.
 *
 * Captions copy through execCommand, NOT the async Clipboard API: the API is
 * permission-gated and a locally-opened page is exactly where the permission is
 * refused, so every press used to fall through to "Selected — press ⌘C". The
 * image has no such escape (see the [data-img] handler) and its button is
 * allowed to fail loudly.
 *
 * Deliberately a LOCAL file, not a published artifact: a published page cannot
 * hand the viewer a download, and clipboard access is the point here.
 *
 * Usage:
 *   node make-post-kit.cjs --poster p.png --en en.txt --ru ru.txt \
 *                          --version v0.16.0 --out post-kit.html \
 *                          [--preview pre.png] [--downloads dl.json]
 *
 * --downloads takes [{label, file, url, mb?}] and renders a real link per
 * platform. Build it from `gh release view --json assets` rather than by hand:
 * an asset name is a thing the release decides, and a link typed from memory is
 * a 404 posted to a channel. Omit the flag and the section is simply absent.
 */
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { basename, resolve } = require('node:path');

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const POSTER = arg('poster');
const EN = arg('en');
const RU = arg('ru');
const VERSION = arg('version', 'v0.0.0');
const OUT = arg('out', 'post-kit.html');
const PREVIEW = arg('preview');
const DOWNLOADS = arg('downloads');
const REPO = process.env.SINGZ_REPO
  ?? require('node:path').resolve(__dirname, '..', '..', '..', '..'); // <repo>/.claude/skills/release-poster/scripts

for (const [flag, v] of [['--poster', POSTER], ['--en', EN], ['--ru', RU]]) {
  if (!v || !existsSync(v)) {
    console.error(`missing or unreadable ${flag}: ${v ?? '(not given)'}`);
    process.exit(1);
  }
}

const b64 = (p) => readFileSync(p).toString('base64');
const posterURI = `data:image/png;base64,${b64(POSTER)}`;
const previewURI = PREVIEW && existsSync(PREVIEW) ? `data:image/png;base64,${b64(PREVIEW)}` : null;

// The display face, inlined so the kit survives being moved or emailed.
const FONT = `${REPO}/node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2`;
const fontFace = existsSync(FONT)
  ? `@font-face{font-family:'Bricolage';src:url(data:font/woff2;base64,${b64(FONT)}) format('woff2');font-weight:200 800;}`
  : '';

let downloads = [];
if (DOWNLOADS) {
  if (!existsSync(DOWNLOADS)) {
    console.error(`missing or unreadable --downloads: ${DOWNLOADS}`);
    process.exit(1);
  }
  downloads = JSON.parse(readFileSync(DOWNLOADS, 'utf8'));
  // Only http(s) may become an href here. The list is generated, but this page
  // is handed around, and a javascript: or data: URL arriving through a JSON
  // file would execute on click.
  for (const d of downloads) {
    if (!/^https?:\/\//i.test(d.url ?? '')) {
      console.error(`--downloads: refusing a non-http url for ${d.label ?? '?'}: ${d.url}`);
      process.exit(1);
    }
  }
}

const en = readFileSync(EN, 'utf8').trim();
const ru = readFileSync(RU, 'utf8').trim();
const LIMIT = 1024; // Telegram photo caption

// --version lands in an attribute (the download filename), where an unescaped quote would
// break out of it. Escape rather than trusting argv.
/*
 * Captions may carry [label](https://…), which becomes a REAL <a> inside the
 * <pre> so the page can be read and the link followed. What it does NOT do is
 * reach Telegram as a link: measured by the person posting, a pasted
 * [label](url) arrives as literal brackets — the composer converts markdown as
 * you TYPE it and does not re-parse the clipboard — and the rich text/html
 * flavour did not survive the paste either. An earlier version of this comment
 * claimed the opposite and the whole caption budget was built on it. A bare URL
 * is the only form this repo has watched reach Telegram as a link, so that is
 * what the captions spell out; the markdown form stays supported for copy that
 * will be typed rather than pasted.
 *
 * http(s) only, same rule as --downloads: a caption is a file someone edits by
 * hand, and a javascript: href here would execute on click.
 */
// ONE definition. The render, the CLI count and the page counter are three
// readings of this rule and the change's whole value is that they agree; a
// second copy edited alone makes them disagree silently.
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

const renderCaption = (text) => esc(text).replace(
  LINK_RE,
  (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const VERSION_SAFE = esc(VERSION);

const html = `<!doctype html>
<meta charset="utf-8" />
<title>SingZ ${VERSION_SAFE} post kit</title>
<style>
${fontFace}
:root{
  --bg:#0c0a08; --panel:#15120e; --raised:#1b1712; --accent:#ffa028;
  --text:#f6f1e8; --dim:#a99e8a; --faint:#7b7263;
  --line:rgba(255,240,214,.12); --ok:#58d68a; --warn:#ff8a7a;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;
  padding:40px 28px 64px;line-height:1.5}
.wrap{max-width:1080px;margin:0 auto;display:grid;grid-template-columns:minmax(280px,380px) 1fr;
  gap:34px;align-items:start}
header{grid-column:1/-1;display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;
  padding-bottom:20px;border-bottom:1px solid var(--line);margin-bottom:6px}
h1{font-family:'Bricolage',system-ui,sans-serif;font-size:30px;font-weight:800;letter-spacing:-.02em}
h1 b{color:var(--accent)}
.hint{color:var(--faint);font-size:14px}
h2{font-family:'Bricolage',system-ui,sans-serif;font-size:15px;font-weight:700;
  text-transform:uppercase;letter-spacing:.09em;color:var(--dim);margin-bottom:12px}
.poster{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}
.poster img{display:block;width:100%;border-radius:8px}
.meta{margin-top:12px;font-size:13px;color:var(--faint);font-family:ui-monospace,monospace;
  display:flex;justify-content:space-between;gap:10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:22px}
.card-top{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:14px}
/* A caption is copied whole or not at all, and a right-click menu offers Copy
   only when something is already selected — which is why right-clicking a
   caption appeared to do nothing. user-select:all makes one click select the
   block, so the native menu, ⌘C and the button all have the same target. */
pre{-webkit-user-select:all;user-select:all;
  background:var(--raised);border:1px solid var(--line);border-radius:10px;padding:16px;
  white-space:pre-wrap;word-wrap:break-word;font-family:ui-monospace,'SF Mono',monospace;
  font-size:14px;line-height:1.62;color:var(--text);max-height:340px;overflow:auto}
.count{font-family:ui-monospace,monospace;font-size:12.5px;color:var(--faint);white-space:nowrap}
.count.over{color:var(--warn)}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
button{font:inherit;font-size:14.5px;font-weight:600;cursor:pointer;border-radius:999px;
  padding:11px 20px;border:1px solid var(--line);background:var(--raised);color:var(--text);
  transition:background .14s,border-color .14s,transform .06s}
button:hover{background:#221d16;border-color:rgba(255,240,214,.24)}
button:active{transform:translateY(1px)}
button.primary{background:var(--accent);color:#241705;border-color:transparent}
button.primary:hover{background:#ffae45}
button.done{background:var(--ok);color:#08210f;border-color:transparent}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
a.dl{text-decoration:none}
.phonehint{margin-top:16px;font-size:13.5px;line-height:1.5;color:var(--dim);
  border-left:2px solid var(--line);padding-left:12px}
.phonehint b{color:var(--text)}
.phonehint code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--accent)}
pre a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
.dls{display:flex;flex-direction:column;gap:10px}
.dlrow{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:13px 16px;border:1px solid var(--line);border-radius:12px;
  background:var(--panel);text-decoration:none;color:inherit}
.dlrow:hover{border-color:var(--accent)}
.dlrow .who{font-weight:700;font-size:15.5px}
.dlrow .what{color:var(--dim);font-size:13px;font-family:ui-monospace,Menlo,monospace;
  overflow-wrap:anywhere}
.dlrow .mb{color:var(--dim);font-size:13.5px;white-space:nowrap;font-variant-numeric:tabular-nums}
.note{grid-column:1/-1;color:var(--faint);font-size:13.5px;border-top:1px solid var(--line);
  padding-top:18px;margin-top:8px}
.note code{font-family:ui-monospace,monospace;color:var(--dim)}
@media (max-width:820px){.wrap{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){button{transition:none}}
</style>

<div class="wrap">
  <header>
    <h1>SingZ <b>${VERSION_SAFE}</b> post kit</h1>
    <span class="hint">Copy a caption, copy the image, paste both into the channel.</span>
  </header>

  <section>
    <h2>Poster</h2>
    <div class="poster">
      <img id="poster" src="${posterURI}" alt="SingZ ${VERSION_SAFE} release poster" />
      <div class="meta"><span>1024 × 1280 · 4:5</span><span>send as photo</span></div>
    </div>
    <div class="row">
      <button class="primary" data-img>Copy image</button>
      <a class="dl" href="${posterURI}" download="singz-${VERSION_SAFE}-poster.png"><button>Save PNG</button></a>
    </div>
    <p class="phonehint"><b>Copy image</b> is the one button a browser can refuse:
      putting a PNG on the clipboard goes through the permission-gated Clipboard API, which is
      withheld on plenty of local pages. When it says <i>Blocked</i>, use <b>Save PNG</b> and drag
      the file in — or drag <code>${esc(POSTER)}</code> straight from disk, which is the same
      bytes and skips the clipboard entirely. The caption buttons need no clipboard permission,
      so they are not the ones to worry about here.
      <b>On a phone:</b> press and hold the poster, then Save to Photos — and press and hold a
      caption rather than trusting its button — a phone browser is the case least tested here.</p>
    ${previewURI ? `<div style="margin-top:24px"><h2>How it lands in a chat</h2>
      <img src="${previewURI}" alt="poster at phone chat width" style="width:200px;border-radius:8px;border:1px solid var(--line)" /></div>` : ''}
  </section>

  ${downloads.length ? `<section>
    <h2>Downloads</h2>
    <div class="dls">
      ${downloads.map((d) => `<a class="dlrow" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">
        <span><span class="who">${esc(d.label)}</span><br /><span class="what">${esc(d.file)}</span></span>
        <span class="mb">${d.mb ? esc(d.mb) + ' MB' : '&rarr;'}</span>
      </a>`).join('\n      ')}
    </div>
  </section>` : ''}

  <section>
    <div class="card">
      <div class="card-top">
        <h2 style="margin:0">English</h2>
        <span class="count" data-count-for="en"></span>
      </div>
      <pre id="en" data-src="${esc(en)}">${renderCaption(en)}</pre>
      <div class="row"><button class="primary" data-copy="en">Copy English</button></div>
    </div>

    <div class="card">
      <div class="card-top">
        <h2 style="margin:0">Russian</h2>
        <span class="count" data-count-for="ru"></span>
      </div>
      <pre id="ru" data-src="${esc(ru)}">${renderCaption(ru)}</pre>
      <div class="row"><button class="primary" data-copy="ru">Copy Russian</button></div>
    </div>
  </section>

  <p class="note">
    Telegram allows ${LIMIT} characters on a photo caption and recompresses photos past
    ~1280&nbsp;px on the long side — this poster is 1280 on its long side, so sending it as a
    photo costs nothing. Poster file: <code>${esc(basename(resolve(POSTER)))}</code>
  </p>
</div>

<script>
const flash = (btn, label) => {
  const original = btn.textContent;
  btn.textContent = label;
  btn.classList.add('done');
  setTimeout(() => { btn.textContent = original; btn.classList.remove('done'); }, 1600);
};

// No pointer that can hover = a touch screen, which is the thing that decides
// whether ⌘C and a data: download are available to the reader.
const TOUCH = matchMedia('(hover: none)').matches;

// The async Clipboard API is the half that fails, and it fails where this page
// actually lives. Measured on a secure origin with navigator.clipboard AND
// ClipboardItem both present: write() and writeText() alike reject with
// "Write permission denied" — it is permission-gated, and a page opened from
// disk or served locally is exactly where the permission is withheld. Every
// press then landed in the old catch, which merely SELECTED the caption and
// asked for a manual copy, which is the bug as the user meets it.
//
// execCommand('copy') is gated on the user gesture alone. It is deprecated and
// it is the one that works here, so it goes FIRST, and it carries both flavours
// in a single copy event (verified against the macOS clipboard: «class HTML»
// and utf8 text side by side after one press).
const richCopy = (el) => {
  // Plain flavour is the caption's OWN source, URLs and all — never textContent,
  // which is the <a> labels with every address dropped. This is simply what the
  // composer receives, which is why the counter below measures the same string.
  const plain = el.dataset.src ?? el.textContent;
  // The pre's white-space:pre-wrap lives in this page's stylesheet and does NOT
  // travel with the fragment, so under the default white-space:normal every
  // blank line collapses to a space and the caption arrives as one run-on
  // paragraph — links intact, shape gone. br rather than wrapping in pre, which
  // Telegram reads as a code block.
  const html = el.innerHTML.replace(/\\n/g, '<br>');
  const sel = getSelection();
  if (!sel) return false;
  const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  let fired = false;
  const onCopy = (e) => {
    e.clipboardData.setData('text/html', html);
    e.clipboardData.setData('text/plain', plain);
    e.preventDefault();
    fired = true;
  };
  const r = document.createRange();
  r.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(r);
  document.addEventListener('copy', onCopy, true);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.removeEventListener('copy', onCopy, true);
  sel.removeAllRanges();
  if (saved) sel.addRange(saved);
  // ok alone is not proof: a browser can return true having copied the raw
  // selection. The listener firing is what says OUR two flavours went on.
  return ok && fired;
};

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const el = document.getElementById(btn.dataset.copy);
    if (richCopy(el)) { flash(btn, 'Copied ✓'); return; }
    // execCommand withheld too (a sandboxed frame can do that) — the async API
    // is worth one try before handing the job back to the reader.
    try {
      const plain = el.dataset.src ?? el.textContent;
      if (window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([el.innerHTML.replace(/\\n/g, '<br>')], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' })
        })]);
      } else {
        await navigator.clipboard.writeText(plain);
      }
      flash(btn, 'Copied ✓');
    } catch {
      // Nothing programmatic is left. Leave it selected so a manual copy still
      // works. Which gesture to name is a question about the DEVICE, not the
      // origin: a desktop at an http:// LAN address still has a ⌘ key.
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      flash(btn, TOUCH ? 'Tap and hold the text to copy' : 'Selected — press ⌘C');
    }
  });
}

// The image has no execCommand route. Selecting the <img> and copying was
// measured putting «class HTML» on the clipboard — 1.6 MB of the data: URI as
// markup — and no PNG at all, which pastes into a chat as nothing. So the async
// API is genuinely the only in-browser way, and where it is refused the answer
// is a file, not another clipboard trick: Save PNG here, or the copy already
// committed next to the release notes, dragged straight into the channel.
for (const btn of document.querySelectorAll('[data-img]')) {
  btn.addEventListener('click', async () => {
    try {
      // Safari needs the ClipboardItem built with a promise inside the gesture.
      const blob = fetch(document.getElementById('poster').src).then((r) => r.blob());
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      flash(btn, 'Image copied ✓');
    } catch (e) {
      // On touch, Save PNG is a second dead end: it is a data: URI download and
      // iOS Safari blocks those at top level. Long-press needs neither the
      // clipboard nor a download.
      flash(btn, TOUCH ? 'Press and hold the poster' : 'Blocked — use Save PNG');
    }
  });
}

for (const el of document.querySelectorAll('[data-count-for]')) {
  // data-src, not textContent: the raw caption is what the composer receives.
  // Counting textContent here would report the <a> labels and disagree with the
  // build over the same caption. (The two agree exactly for LF files; with CRLF
  // the HTML parser drops CR from the attribute, so the page reads one short per
  // line BREAK — the shortfall is the CR count. The CLI is then the stricter of
  // the two, which is the safe direction.)
  const src = document.getElementById(el.dataset.countFor);
  const n = (src.dataset.src ?? src.textContent).length;
  el.textContent = n + ' / ${LIMIT}';
  if (n > ${LIMIT}) el.classList.add('over');
}
</script>
`;

// The page's whole job is done by that script, and it is assembled inside a
// template literal — so a `\n` that needed to be `\\n` lands in the output as a
// REAL newline, breaks a regex literal, and the browser refuses the entire
// block. Nothing says so: the page renders perfectly and every button is inert,
// which is indistinguishable from the clipboard being refused. It happened.
// Parse what we are about to write, and fail the build instead.
const scriptBody = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
try {
  // eslint-disable-next-line no-new-func
  new Function(scriptBody);
} catch (e) {
  console.error(`the generated <script> does not parse — the page would render with dead buttons:\n  ${e.message}`);
  process.exit(1);
}

writeFileSync(OUT, html);
console.log(`POST KIT ${OUT}`);
// Count what the COMPOSER RECEIVES. That is the raw text: see the note below on
// why the entity-budget reading, which this line used to take, describes a
// caption nobody pastes.
// UTF-16 units — String#length already counts those, but naming it says which
// unit was meant, and the page's own counter must use the same one.
const uLen = (t) => t.length;
// UTF-16 units, not code points, and NOT the same rule as store-notes.cjs:
// Play counts characters, so that script counts code points on purpose, while
// Telegram addresses message entities by UTF-16 offset and counts the caption
// the same way. The 🎤 these captions open with is one code point and two
// units — count code points and the page's own counter disagrees by one, and
// the disagreement is in the unsafe direction.
// MEASURED, in Telegram, by the person posting: a pasted [label](url) does NOT
// become a link. The composer converts markdown as you TYPE it and does not
// re-parse what arrives on the clipboard, and the rich text/html flavour did
// not survive the paste either. So the number that decides whether a caption is
// accepted is the RAW text — every character the composer receives — and the
// entity count is the hypothetical one, not the other way round. It was the
// other way round here for three drafts, which is how captions measuring a
// comfortable 788 were handed over at 1166.
const enN = uLen(en);
const ruN = uLen(ru);
console.log(`  english ${enN}/${LIMIT}   russian ${ruN}/${LIMIT}`);
if (enN > LIMIT || ruN > LIMIT) {
  console.error('  a caption is over the limit — it will be refused as a photo caption');
  process.exit(1);
}
// Bare URLs are what survived. They need no entity and nothing parsed, and they
// are the only form this repo has watched reach Telegram as a link, which is why
// the captions spell them out and pay for them. A [label](url) still renders as an <a> on the page, and
// is still worth writing where the caption will be TYPED rather than pasted, but
// it buys no room here: it is counted at full length like any other text.
// A NON-GLOBAL twin for the test. LINK_RE is /g, and /g + .test() carries
// lastIndex between calls: filtering two captions with it tests the second from
// the first one's leftover index, so a caption whose link sits early is passed
// silently. That fails in the one direction that matters — the author fixes the
// caption it named, reruns, sees a clean run, and posts the other one.
const HAS_LINK = new RegExp(LINK_RE.source, LINK_RE.flags.replace('g', ''));
const linked = [['english', en], ['russian', ru]].filter(([, t]) => HAS_LINK.test(t));
if (linked.length) {
  console.log(`  note — [label](url) found in: ${linked.map(([n]) => n).join(', ')}`);
  console.log('  pasting that into Telegram yields literal brackets, not a link.');
  console.log('  spell the URL out instead; it is counted in full either way.');
}
