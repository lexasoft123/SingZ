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
 *                          --version v0.16.0 --out post-kit.html [--preview pre.png]
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

const en = readFileSync(EN, 'utf8').trim();
const ru = readFileSync(RU, 'utf8').trim();
const LIMIT = 1024; // Telegram photo caption

// Captions land inside <pre> and only need text escaping; --version also lands
// in an attribute (the download filename), where an unescaped quote would
// break out of it. Escape both contexts rather than trusting argv.
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
    ${previewURI ? `<div style="margin-top:24px"><h2>How it lands in a chat</h2>
      <img src="${previewURI}" alt="poster at phone chat width" style="width:200px;border-radius:8px;border:1px solid var(--line)" /></div>` : ''}
  </section>

  <section>
    <div class="card">
      <div class="card-top">
        <h2 style="margin:0">English</h2>
        <span class="count" data-count-for="en"></span>
      </div>
      <pre id="en">${esc(en)}</pre>
      <div class="row"><button class="primary" data-copy="en">Copy English</button></div>
    </div>

    <div class="card">
      <div class="card-top">
        <h2 style="margin:0">Russian</h2>
        <span class="count" data-count-for="ru"></span>
      </div>
      <pre id="ru">${esc(ru)}</pre>
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

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const text = document.getElementById(btn.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      flash(btn, 'Copied ✓');
    } catch {
      // Clipboard refused (rare on file://) — select it so ⌘C still works.
      const r = document.createRange();
      r.selectNodeContents(document.getElementById(btn.dataset.copy));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      flash(btn, 'Selected — press ⌘C');
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
      flash(btn, 'Use Save PNG instead');
    }
  });
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
console.log(`  english ${en.length}/${LIMIT}   russian ${ru.length}/${LIMIT}`);
