/*
 * Build the post kit: one self-contained HTML page holding the poster and both
 * captions, with a copy button on each.
 *
 * Why a page and not just files: posting means getting an image and a specific
 * block of text into Telegram. Handing over a PNG path and two .txt files makes
 * the human do the assembly every time, and retyping a caption is how a typo
 * reaches a channel. The image copies to the clipboard, so the whole post is
 * two clicks.
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
 * Captions may carry [label](https://…). It becomes a REAL <a> inside the
 * <pre>, which is what makes the whole thing work: textContent then yields the
 * label alone — exactly the plain text Telegram counts against its 1024, and
 * exactly what a plain-text paste should be — while innerHTML yields the rich
 * flavour whose links survive a paste into Telegram Desktop. Embedding a link
 * this way is also SHORTER than spelling the URL out, so it buys caption room
 * rather than spending it.
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
pre{background:var(--raised);border:1px solid var(--line);border-radius:10px;padding:16px;
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
.phonehint.live{border-left-color:var(--accent)}
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
    <p class="phonehint" id="phonehint"><b>On a phone:</b> press and hold the poster above, then
      Save to Photos — and press and hold a caption to copy it. The buttons need a clipboard, which
      a browser grants on <code>file://</code>, <code>localhost</code> and HTTPS but not on a plain
      <code>http://</code> address — and iOS will not open this from a file at all, so a phone
      arrives by IP and has none.</p>
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
      <pre id="en">${renderCaption(en)}</pre>
      <div class="row"><button class="primary" data-copy="en">Copy English</button></div>
    </div>

    <div class="card">
      <div class="card-top">
        <h2 style="margin:0">Russian</h2>
        <span class="count" data-count-for="ru"></span>
      </div>
      <pre id="ru">${renderCaption(ru)}</pre>
      <div class="row"><button class="primary" data-copy="ru">Copy Russian</button></div>
    </div>
  </section>

  <p class="note">
    Telegram allows ${LIMIT} characters on a photo caption and recompresses photos past
    ~1280&nbsp;px on the long side — this poster is 1280 on its long side, so sending it as a
    photo costs nothing. Poster file: <code>${basename(resolve(POSTER))}</code>
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

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const el = document.getElementById(btn.dataset.copy);
    const text = el.textContent;
    try {
      // Two flavours on one clipboard. Telegram Desktop takes the HTML and
      // keeps the embedded links; anything that only understands plain text
      // gets the labels, which is the caption Telegram counts. writeText alone
      // would silently drop every link, which is the whole point here.
      if (el.querySelector('a') && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({
          // The pre's white-space:pre-wrap lives in this page's stylesheet and
          // does NOT travel with the fragment, so under the default
          // white-space:normal every blank line collapses to a space and the
          // caption arrives as one run-on paragraph — links intact, shape gone.
          // br rather than wrapping in pre, which Telegram reads as a code block.
          'text/html': new Blob([el.innerHTML.replace(/\\n/g, '<br>')], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' })
        })]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      flash(btn, 'Copied ✓');
    } catch {
      // Clipboard refused (rare on file://) — select it so ⌘C still works.
      // Which gesture to name is a question about the DEVICE, not the origin:
      // a desktop at the same http:// LAN address has no clipboard either and
      // still has a ⌘ key.
      const r = document.createRange();
      r.selectNodeContents(document.getElementById(btn.dataset.copy));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      flash(btn, TOUCH ? 'Tap and hold the text to copy' : 'Selected — press ⌘C');
    }
  });
}

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
      // clipboard nor a download. On a desktop Save PNG works, insecure origin
      // or not, so that is still where a mouse gets sent.
      flash(btn, TOUCH ? 'Press and hold the poster' : 'Use Save PNG instead');
    }
  });
}

// No clipboard at all (a page reached by IP, or any insecure origin) means the
// two Copy buttons cannot work however they are pressed. Say so before the press.
if (!navigator.clipboard) {
  const h = document.getElementById('phonehint');
  if (h) h.classList.add('live');
  for (const b of document.querySelectorAll('[data-copy],[data-img]')) b.title =
    'This browser gives no clipboard on an insecure origin — press and hold the poster or the caption instead.';
}

for (const el of document.querySelectorAll('[data-count-for]')) {
  const n = document.getElementById(el.dataset.countFor).textContent.length;
  el.textContent = n + ' / ${LIMIT}';
  if (n > ${LIMIT}) el.classList.add('over');
}
</script>
`;

writeFileSync(OUT, html);
console.log(`POST KIT ${OUT}`);
// Count what Telegram counts: the VISIBLE text. A [label](url) costs the
// label, never the URL — link entities sit outside the caption's character
// budget — so measuring the raw source reports a caption of 928 as 1260 and
// sends someone cutting good copy to fit a limit they were never near.
const visible = (t) => t.replace(LINK_RE, '$1');
// UTF-16 units, not code points, and NOT the same rule as store-notes.cjs:
// Play counts characters, so that script counts code points on purpose, while
// Telegram addresses message entities by UTF-16 offset and counts the caption
// the same way. The 🎤 these captions open with is one code point and two
// units — count code points and the page's own counter disagrees by one, and
// the disagreement is in the unsafe direction.
const enN = visible(en).length;
const ruN = visible(ru).length;
console.log(`  english ${enN}/${LIMIT}   russian ${ruN}/${LIMIT}`);
if (enN > LIMIT || ruN > LIMIT) {
  console.error('  a caption is over the limit — it will be refused as a photo caption');
  process.exit(1);
}
