/*
 * Downloaded songs must survive (run on macOS against the iOS Simulator).
 *
 * Stems used to be copied into Library/Caches, which iOS empties whenever it
 * feels storage pressure — re-downloading a song the phone already has is the
 * one thing an offline library must not do. They now live in Application
 * Support, excluded from iCloud backup, with whatever the old cache still
 * held adopted once instead of fetched again. Since nothing on the phone can
 * show the difference, this asserts against the app container directly.
 *
 * The Drive half (persisted catalog, md5 re-use) needs no device and lives in
 * mobile/__tests__/gdrive-offline.test.ts.
 *
 * Prereqs: app built+installed in a booted sim (Debug), Metro running.
 *   node mobile/tests/offline-cache.cjs
 *
 * With a Metro from another worktree already on 8081, build the app with
 * RCT_METRO_PORT=8082, serve this tree on 8082, and pass METRO_PORT=8082 —
 * otherwise the app quietly loads the other tree's JS. The __test.forget
 * probe below is what catches that.
 */
const http = require('http');
const fs = require('node:fs');
const { join } = require('node:path');
const { execSync } = require('child_process');
const WebSocket = require('ws');

const BUNDLE = 'com.lexasoft.singz';
const UDID = process.env.SIM_UDID || 'C624B667-6F58-4F85-B64F-63B75545DDE2';
const REPO = join(__dirname, '..');
const PORT = process.env.METRO_PORT || '8081';
const SONG = 'Cached Song';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Metro's target list. The timeout is the point: `http.get` has none of its
 * own, so a Metro that accepts the connection and then stalls — which is what
 * one busy building a cold bundle does — never settles the promise, and the
 * driver hangs on this line with nothing printed. The rejection lands in the
 * caller's `catch` and the retry loop simply asks again.
 */
const getJson = (u) =>
  new Promise((res, rej) => {
    http
      .get(u, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try {
            res(JSON.parse(d));
          } catch (e) {
            rej(e);
          }
        });
      })
      .on('error', rej)
      .setTimeout(5000, function () {
        this.destroy(new Error('metro /json timed out'));
      });
  });

const check = (label, cond, detail) => {
  console.log(`${cond ? '  ok ' : ' FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) throw new Error(label);
};

const du = (dir) => {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? du(p) : fs.statSync(p).size;
  }
  return n;
};

(async () => {
  const data = execSync(`xcrun simctl get_app_container ${UDID} ${BUNDLE} data`).toString().trim();
  const durable = join(data, 'Library', 'Application Support', 'singz-projects');
  const purgeable = join(data, 'Library', 'Caches', 'singz-projects');
  const docs = join(data, 'Documents');

  // --- clean slate, then a project on the phone and a leftover in the old cache
  execSync(`xcrun simctl terminate ${UDID} ${BUNDLE} 2>/dev/null || true`);
  fs.rmSync(durable, { recursive: true, force: true });
  fs.rmSync(purgeable, { recursive: true, force: true });
  fs.rmSync(join(docs, SONG), { recursive: true, force: true });

  fs.mkdirSync(join(docs, SONG, 'stems'), { recursive: true });
  const sample = join(REPO, 'assets', 'sample');
  for (const f of fs.readdirSync(join(sample, 'stems'))) {
    fs.copyFileSync(join(sample, 'stems', f), join(docs, SONG, 'stems', f));
  }
  fs.copyFileSync(join(sample, 'lyrics.json'), join(docs, SONG, 'lyrics.json'));
  fs.writeFileSync(
    join(docs, SONG, 'project.json'),
    JSON.stringify({
      version: 2,
      name: SONG,
      savedAt: '2026-01-01T00:00:00.000Z',
      settings: { transpose: 0, tracks: {} }
    })
  );
  // a stem the old purgeable cache still holds — it must be adopted, not refetched
  fs.mkdirSync(join(purgeable, 'Legacy Song', 'stems'), { recursive: true });
  fs.writeFileSync(join(purgeable, 'Legacy Song', 'stems', 'vocals.flac'), 'fLaC-legacy-bytes');
  console.log(`container : ${data}\nseeded    : ${SONG} in Documents + a Legacy Song in Caches\n`);

  // --- drive the app
  execSync(`xcrun simctl launch ${UDID} ${BUNDLE}`);
  await sleep(9000);
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const l = await getJson(`http://localhost:${PORT}/json`);
      // deviceName filter: Metro lists every attached app and an Android
      // emulator sorts first — this driver seeded the iOS container and then
      // interrogated the Android app, reporting Android's projects as a
      // failure. See the note in seek-memory.cjs.
      target =
        l.find((t) => t.webSocketDebuggerUrl && /iphone|ipad/i.test(t.deviceName || '')) ?? null;
    } catch {}
    if (!target) await sleep(1000);
  }
  if (!target) throw new Error(`no debugger target on :${PORT} (is Metro running?)`);
  const ws = new WebSocket(target.webSocketDebuggerUrl, { origin: `http://localhost:${PORT}` });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  let id = 0;
  const pend = new Map();
  ws.on('message', (m) => {
    const g = JSON.parse(m.toString());
    if (pend.has(g.id)) {
      pend.get(g.id)(g);
      pend.delete(g.id);
    }
  });
  const ev = (e) =>
    new Promise((res, rej) => {
      const i = ++id;
      ws.send(
        JSON.stringify({
          id: i,
          method: 'Runtime.evaluate',
          params: { expression: e, returnByValue: true, awaitPromise: true }
        })
      );
      pend.set(i, res);
      setTimeout(() => {
        if (pend.has(i)) {
          pend.delete(i);
          rej(new Error('eval timeout'));
        }
      }, 25000);
    });
  const val = async (e) => (await ev(e)).result?.result?.value;
  for (let i = 0; i < 30; i++) {
    if ((await val('typeof __test')) === 'object') break;
    await sleep(500);
  }
  // Whose JS is this? A Metro from another worktree answers just as happily,
  // and then every assertion below is about somebody else's code.
  check(
    "the app is running THIS tree's bundle",
    (await val('typeof __test.forget')) === 'function',
    `metro :${PORT}`
  );
  await ev('__test.engine.master.gain.value = 0'); // automated runs are silent

  // --- the phone library lists the seeded project
  await ev("void __test.selectMode('phone')");
  for (let i = 0; i < 30; i++) {
    if ((await val(`(__test.projects||[]).includes(${JSON.stringify(SONG)})`)) === true) break;
    await sleep(500);
  }
  console.log('1. listed from the phone');
  check('project listed', (await val(`(__test.projects||[]).includes(${JSON.stringify(SONG)})`)) === true,
    await val('JSON.stringify(__test.projects)'));

  // --- opening it materializes the stems into the durable location
  await ev(`void __test.openProject(${JSON.stringify(SONG)})`);
  for (let i = 0; i < 120; i++) {
    if ((await val("__test.screen==='player' && __test.engine.duration>0")) === true) break;
    await sleep(500);
  }
  check('song opened', (await val("__test.screen==='player'")) === true, await val('__test.busy'));

  console.log('\n2. where the bytes landed');
  check(
    'old cache adopted into Application Support',
    fs.existsSync(join(durable, 'Legacy Song', 'stems', 'vocals.flac')),
    `${du(durable)} bytes under ${durable.split('/').slice(-3).join('/')}`
  );
  check(
    'the purgeable cache is gone, not left behind',
    !fs.existsSync(purgeable),
    fs.existsSync(purgeable) ? 'Caches/singz-projects still there' : 'moved over'
  );
  // A song already in Documents is played from there. It used to be copied
  // into the cache as well, which was free when the OS emptied that folder
  // for us and is a permanent second copy now that it does not.
  check('a local song is not duplicated', du(join(durable, SONG)) === 0, `${du(join(durable, SONG))} bytes`);
  const excluded = execSync(
    `xattr -p com.apple.metadata:com_apple_backup_excludeItem ${JSON.stringify(durable)} 2>/dev/null || echo none`
  )
    .toString()
    .trim();
  check('excluded from iCloud backup', excluded !== 'none', excluded.split('\n').pop());

  // --- the catalog knows what is downloaded, and can give the space back
  await ev('void __test.back()');
  for (let i = 0; i < 20; i++) {
    if ((await val("__test.screen==='catalog'")) === true) break;
    await sleep(300);
  }
  await ev('void __test.refresh()');
  await sleep(1500);
  console.log('\n3. reported and reclaimable');
  const reported = await val("__test.usage && __test.usage['Legacy Song']");
  // TEST.usage is Record<dir, CacheUsage> — the byte count is a field on it,
  // never the value itself. Asserting a number here has been red since the
  // shape changed under the driver in August.
  check(
    'usage reported to the catalog',
    typeof reported?.bytes === 'number' && reported.bytes > 0,
    `${reported?.bytes} bytes`
  );

  await ev("void __test.forget('Legacy Song')");
  await sleep(1500);
  check('files freed on disk', du(join(durable, 'Legacy Song')) === 0);
  check(
    'usage cleared in the catalog',
    !(await val("!!(__test.usage && __test.usage['Legacy Song'])")),
    await val('JSON.stringify(__test.usage)')
  );
  check('the song itself is untouched', fs.existsSync(join(docs, SONG, 'project.json')));

  console.log('\nPASS');
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS FAIL', e.message ?? e);
  process.exit(1);
});
