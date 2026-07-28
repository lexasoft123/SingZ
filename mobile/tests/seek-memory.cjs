/*
 * Memory regression test for the seek path (run on macOS against the iOS
 * Simulator): react-native-audio-api used to deep-copy every AudioBuffer per
 * source creation, so each seek stacked another full stem-set of PCM until
 * jetsam killed the app on device (~1.5 GB after 2-3 scrubs). The sim never
 * dies (macOS has no jetsam) but the growth is measurable from the host.
 *
 * Prereqs: app built+installed in a booted sim (Debug), Metro running.
 *   node mobile/tests/seek-memory.cjs            # asserts bounded growth
 *   STRICT=0 node mobile/tests/seek-memory.cjs   # report only, no assert
 */
const http = require('http');
const { execSync } = require('child_process');
const WebSocket = require('ws');

const BUNDLE = 'com.lexasoft.singz';
const UDID = process.env.SIM_UDID || 'C624B667-6F58-4F85-B64F-63B75545DDE2';
const BURSTS = parseInt(process.env.BURSTS || '6', 10);
/**
 * Patched lib shows ~3-4 MB/seek of GC-sawtooth creep; the regression this
 * guards against is ~345 MB/seek (a full stem-set copy), so the limit scales
 * with burst count while staying far below one stem-set.
 */
const MAX_GROWTH_MB = 60 + 12 * BURSTS;

const getJson = (u) =>
  new Promise((res, rej) => {
    http.get(u, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => {
        try {
          res(JSON.parse(d));
        } catch (e) {
          rej(e);
        }
      });
    }).on('error', rej);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rssMb() {
  const pid = execSync(`pgrep -f "SingZPlayer.app/SingZPlayer" | head -1`).toString().trim();
  if (!pid) throw new Error('sim app process not found');
  return Math.round(parseInt(execSync(`ps -o rss= -p ${pid}`).toString().trim(), 10) / 1024);
}

(async () => {
  execSync(`xcrun simctl terminate ${UDID} ${BUNDLE} 2>/dev/null || true`);
  execSync(`xcrun simctl launch ${UDID} ${BUNDLE}`);
  await sleep(9000);

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const l = await getJson('http://localhost:8081/json');
      target = l.find((t) => t.webSocketDebuggerUrl) ?? null;
    } catch {}
    if (!target) await sleep(1000);
  }
  if (!target) throw new Error('no debugger target');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { origin: 'http://localhost:8081' });
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
        JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true } })
      );
      pend.set(i, res);
      setTimeout(() => {
        if (pend.has(i)) {
          pend.delete(i);
          rej(new Error('eval timeout'));
        }
      }, 20000);
    });
  const val = async (e) => (await ev(e)).result?.result?.value;

  for (let i = 0; i < 30; i++) {
    if ((await val('typeof __test')) === 'object') break;
    await sleep(500);
  }
  await ev('void __test.openSample()');
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    ready = (await val("__test.screen==='player' && __test.engine.duration>0")) === true;
    if (!ready) await sleep(500);
  }
  if (!ready) throw new Error('sample never opened');
  await sleep(1500);
  const base = rssMb();
  console.log(`baseline after open: ${base} MB`);

  // Seek targets scale with the sample's duration (~41 s) so the test
  // never chases positions past the end of the bundled song.
  const D = await val('__test.engine.duration');
  console.log(`sample duration: ${Math.round(D * 10) / 10} s`);
  await ev(`__test.engine.seek(${0.55 * D})`);
  await ev('void __test.engine.play()');
  await sleep(1500);
  const afterPlay = rssMb();
  console.log(`after play: ${afterPlay} MB (+${afterPlay - base})`);
  if ((await val('__test.engine.playing')) !== true) throw new Error('engine not playing');

  let peak = afterPlay;
  for (let round = 0; round < BURSTS; round++) {
    for (const t of [0.3 * D + round, 0.9 * D - round, 0.5 * D + round]) {
      await ev(`__test.engine.seek(${t})`);
      await sleep(100);
    }
    await sleep(900);
    const playing = await val('__test.engine.playing');
    const mb = rssMb();
    peak = Math.max(peak, mb);
    console.log(`burst ${round + 1}: rss=${mb} MB (+${mb - afterPlay} vs play) playing=${playing}`);
    if (playing !== true) throw new Error(`playback did not resume after burst ${round + 1}`);
  }
  await ev('__test.engine.pause()');

  const growth = peak - afterPlay;
  console.log(`RESULT baseline=${base} afterPlay=${afterPlay} peak=${peak} growth=${growth} MB`);
  if (process.env.STRICT !== '0' && growth > MAX_GROWTH_MB) {
    console.log(`FAIL: seek bursts grew memory by ${growth} MB (limit ${MAX_GROWTH_MB})`);
    process.exit(1);
  }
  console.log('PASS');
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS FAIL', e.message);
  process.exit(1);
});
