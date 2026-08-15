/*
 * Regression test: desktop loop selections must be inert on mobile (run on
 * macOS against the iOS Simulator). Field bug (Jul 2026): projects with a
 * saved practice selection played wrong on the phone — an armed region also
 * used to survive engine.load(), so one song's loop could bound the next.
 * Mobile now never reads doc.settings.selection and load() clears regions.
 *
 * Prereqs: app built+installed in a booted sim (Debug), Metro running.
 *   node mobile/tests/loop-region.cjs
 */
const http = require('http');
const { execSync } = require('child_process');
const WebSocket = require('ws');
const PORT = process.env.METRO_PORT || '8081';

const BUNDLE = 'com.lexasoft.singz';
const UDID = process.env.SIM_UDID || 'C624B667-6F58-4F85-B64F-63B75545DDE2';

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

(async () => {
  execSync(`xcrun simctl terminate ${UDID} ${BUNDLE} 2>/dev/null || true`);
  execSync(`xcrun simctl launch ${UDID} ${BUNDLE}`);
  await sleep(9000);

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const l = await getJson(`http://localhost:${PORT}/json`);
      // Metro lists EVERY attached app, and an Android emulator sorts ahead of the
      // simulator — five drivers here picked the first target with no device filter
      // and silently drove Android while reporting on iOS (measured: a loop-region
      // run failed as "sample never opened" because it was talking to a phone).
      // Pick by deviceName, and let METRO_PORT reach the right worktree's Metro.
      target =
        l.find((t) => t.webSocketDebuggerUrl && /iphone|ipad/i.test(t.deviceName || '')) ?? null;
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
      }, 25000);
    });
  const val = async (e) => (await ev(e)).result?.result?.value;
  const openSample = async () => {
    await ev('void __test.openSample()');
    for (let i = 0; i < 120; i++) {
      if ((await val("__test.screen==='player' && __test.engine.duration>0")) === true) return;
      await sleep(500);
    }
    throw new Error('sample never opened');
  };

  for (let i = 0; i < 30; i++) {
    if ((await val('typeof __test')) === 'object') break;
    await sleep(500);
  }
  await ev('__test.engine.master.gain.value = 0'); // automated runs are silent

  await openSample();
  const initial = await val('JSON.stringify(__test.engine.regionState)');
  console.log(`region after load: ${initial}`);
  if (initial !== 'null') throw new Error('a fresh load must not arm any region');

  // Arm a region by hand (what a stale build could leave), leave, reopen.
  await ev('__test.engine.setRegion({start: 20, end: 30}, true)');
  await ev('__test.back()');
  for (let i = 0; i < 20; i++) {
    if ((await val("__test.screen==='catalog'")) === true) break;
    await sleep(300);
  }
  await openSample();
  const reopened = await val('JSON.stringify(__test.engine.regionState)');
  console.log(`region after reopen: ${reopened}`);
  if (reopened !== 'null') throw new Error('region survived a reload');

  // Playback must sail past the old region end (no wrap back to 20).
  await ev('__test.engine.seek(28)');
  await ev('void __test.engine.play()');
  await sleep(3500);
  const pos = await val('Math.round(__test.engine.position*10)/10');
  await ev('__test.engine.pause()');
  console.log(`position after playing across old edge: ${pos}`);
  if (!(pos > 30.5)) throw new Error(`playback wrapped at a stale region end (pos=${pos})`);

  console.log('PASS');
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS FAIL', e.message ?? e);
  process.exit(1);
});
