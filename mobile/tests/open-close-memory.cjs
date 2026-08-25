/*
 * Memory regression test for closing a song (run on macOS against the iOS
 * Simulator). Closing has to hand the stems back, and handing them back may
 * not wait for GC: a six-stem song is 630-845 MB, Hermes sees only the small
 * wrapper, and on device the app took a per-process-limit jetsam kill at
 * 3.5 GB on the fifth song (JetsamEvent-2026-07-28-012852) with a Hermes
 * heap OOM minutes later.
 *
 * Two parts, because the bundled sample alone cannot prove this: at 94 MB a
 * set, GC keeps up either way and RSS says nothing (measured: leaking and
 * not-leaking both plateau over 12 cycles).
 *   1. release: decode a big pile of stems, release them, watch RSS fall.
 *      This is the mechanism the whole fix rests on — AudioBuffer.release()
 *      from audio-api patch 4 — and it fails loudly if that patch drifts.
 *   2. flow: open/close the sample a few times, asserting the app survives
 *      and lands back on the catalog (the wiring around the mechanism).
 *
 * Prereqs: app built+installed in a booted sim (Debug), Metro running.
 *   node mobile/tests/open-close-memory.cjs            # asserts
 *   STRICT=0 node mobile/tests/open-close-memory.cjs   # report only
 */
const http = require('http');
const { execSync } = require('child_process');
const WebSocket = require('ws');

const BUNDLE = 'com.lexasoft.singz';
const UDID = process.env.SIM_UDID || 'C624B667-6F58-4F85-B64F-63B75545DDE2';
const DEVICE_NAME = process.env.SIM_DEVICE_NAME || 'iPhone 16 Pro';
/* Another worktree's Metro on 8081 would hand us ITS app: keep them apart with
 * a second simulator, RCT_METRO_PORT=8082 + the RCT_jsLocation default, and
 * METRO_PORT here (see offline-cache.cjs). */
const PORT = process.env.METRO_PORT || '8081';
const CYCLES = parseInt(process.env.CYCLES || '3', 10);
/**
 * Song-sized buffers, deliberately: 5 minutes of 48 kHz stereo is 115 MB, the
 * scale at which freeing actually returns pages to the OS. Anything sample-
 * sized (7.8 MB a stem) stays in the allocator's cache and RSS won't move,
 * which is why this part synthesizes buffers instead of decoding the sample.
 */
const BUFFERS = parseInt(process.env.BUFFERS || '4', 10);
const BUFFER_SECONDS = 300;
/** Releasing ~460 MB must return most of it; allocator retention eats some. */
const MIN_RECLAIM_FRAC = 0.6;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The pid `simctl launch` reported. Never pgrep for it: two simulators running
 * (this tree next to another worktree's) give two SingZPlayer processes, and
 * measuring the other one reads as "release() freed nothing". */
let appPid = null;

function rssMb() {
  if (!appPid) throw new Error('sim app process not found');
  return Math.round(parseInt(execSync(`ps -o rss= -p ${appPid}`).toString().trim(), 10) / 1024);
}

(async () => {
  execSync(`xcrun simctl terminate ${UDID} ${BUNDLE} 2>/dev/null || true`);
  appPid = /:\s*(\d+)/.exec(execSync(`xcrun simctl launch ${UDID} ${BUNDLE}`).toString())?.[1] ?? null;
  await sleep(9000);

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const l = await getJson(`http://localhost:${PORT}/json`);
      // Metro lists EVERY connected app — an Android emulator sharing this
      // port would answer the sim's evals. Pick by device name.
      target = l.find((t) => t.webSocketDebuggerUrl && t.deviceName === DEVICE_NAME) ?? null;
    } catch {}
    if (!target) await sleep(1000);
  }
  if (!target) throw new Error('no debugger target');
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
  await ev('__test.engine.master.gain.value = 0'); // automated runs are silent

  const idle = rssMb();
  console.log(`catalog idle: ${idle} MB`);

  /* 1. the mechanism: hold song-sized PCM, then hand it back. */
  const held = await val(`(() => {
    globalThis.__mem = [];
    const ctx = __test.engine.ctx;
    for (let i = 0; i < ${BUFFERS}; i++) {
      const b = ctx.createBuffer(2, ctx.sampleRate * ${BUFFER_SECONDS}, ctx.sampleRate);
      b.getChannelData(0)[0] = 1; // touch it so the pages are real
      globalThis.__mem.push(b);
    }
    return __mem.reduce((n, b) => n + b.length * b.numberOfChannels * 4, 0);
  })()`);
  const mb = Math.round(held / 1e6);
  await sleep(1500);
  const allocated = rssMb();
  console.log(`held ${BUFFERS} song-sized buffers (${mb} MB of PCM): rss=${allocated} MB`);

  const hooked = await val('__mem.filter((b) => b.buffer && b.buffer.release).length');
  if (hooked !== BUFFERS) {
    console.log(`FAIL: AudioBuffer.release missing on ${BUFFERS - hooked} buffers — audio-api patch 4 did not apply`);
    process.exit(1);
  }
  await ev('__mem.forEach((b) => b.buffer.release())');
  await sleep(2500);
  const after = rssMb();
  const reclaimed = allocated - after;
  console.log(`released: rss=${after} MB (gave back ${reclaimed} of ${mb} MB)`);
  await ev('globalThis.__mem = []');

  if (process.env.STRICT !== '0' && reclaimed < mb * MIN_RECLAIM_FRAC) {
    console.log(
      `FAIL: release() gave back only ${reclaimed} MB of ${mb} MB — audio-api patch 4 ` +
        '(AudioBuffer.release) no longer frees the channels'
    );
    process.exit(1);
  }

  /* 2. the wiring: open and close for real. */
  const closes = [];
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

    closes.push(closed);
    console.log(`cycle ${cycle}: loaded=${loaded} MB closed=${closed} MB`);
  }

  console.log(
    `RESULT idle=${idle} reclaimed=${reclaimed}/${mb} MB closes=${closes.join('/')}`
  );
  console.log('PASS');
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS FAIL', e.message);
  process.exit(1);
});
