/*
 * Memory regression test for the open/close path (run on macOS against the
 * iOS Simulator): closing a song has to give its stems back. It did not —
 * the engine dropped its references and left the rest to GC, while the
 * native graph kept every stopped source node (each holding a shared_ptr to
 * its decoded buffer) until the render thread retired it, which never
 * happens once playback stops. Songs stacked up at ~94 MB per open of the
 * bundled sample, and on device the app took a per-process-limit jetsam kill
 * at 3.5 GB (JetsamEvent-2026-07-28-012852) plus a Hermes heap OOM minutes
 * later. The sim never dies (macOS has no jetsam) but the growth is
 * measurable from the host.
 *
 * Prereqs: app built+installed in a booted sim (Debug), Metro running.
 *   node mobile/tests/open-close-memory.cjs            # asserts bounded growth
 *   STRICT=0 node mobile/tests/open-close-memory.cjs   # report only, no assert
 */
const http = require('http');
const { execSync } = require('child_process');
const WebSocket = require('ws');

const BUNDLE = 'com.lexasoft.singz';
const UDID = process.env.SIM_UDID || 'C624B667-6F58-4F85-B64F-63B75545DDE2';
const CYCLES = parseInt(process.env.CYCLES || '5', 10);
/**
 * The bundled sample decodes to ~94 MB (six stems, ~41 s, 48 kHz stereo
 * float32). Leaking one set per cycle would show ~94 MB of growth per
 * cycle; healthy behaviour is GC sawtooth well under a single set.
 */
const MAX_GROWTH_MB = 150;

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
  const waitFor = async (expr, what) => {
    for (let i = 0; i < 120; i++) {
      if ((await val(expr)) === true) return;
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  for (let i = 0; i < 30; i++) {
    if ((await val('typeof __test')) === 'object') break;
    await sleep(500);
  }

  const idle = rssMb();
  console.log(`catalog idle: ${idle} MB`);

  let base = null;
  let peak = 0;
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    await ev('void __test.openSample()');
    await waitFor("__test.screen==='player' && __test.engine.duration>0", 'sample to open');
    // play briefly: sources that have actually run are the ones the native
    // graph holds on to, which is the leak this guards against
    await ev('void __test.engine.play()');
    await sleep(1200);
    await ev('__test.engine.pause()');
    const loaded = rssMb();

    await ev('__test.back()');
    await waitFor("__test.screen==='catalog'", 'return to catalog');
    await sleep(2500); // destructor thread + a GC pass
    const closed = rssMb();

    if (base === null) base = closed; // first open pays warm-up costs
    peak = Math.max(peak, closed);
    console.log(
      `cycle ${cycle}: loaded=${loaded} MB closed=${closed} MB (+${closed - base} vs first close)`
    );
  }

  const growth = peak - base;
  console.log(`RESULT idle=${idle} firstClose=${base} peakClose=${peak} growth=${growth} MB`);
  if (process.env.STRICT !== '0' && growth > MAX_GROWTH_MB) {
    console.log(`FAIL: ${CYCLES} open/close cycles grew memory by ${growth} MB (limit ${MAX_GROWTH_MB})`);
    process.exit(1);
  }
  console.log('PASS');
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS FAIL', e.message);
  process.exit(1);
});
