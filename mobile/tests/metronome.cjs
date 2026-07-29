/*
 * Metronome + count-in test (run on macOS against the iOS Simulator): injects
 * a constant beat track into the engine, then asserts that a one-bar count-in
 * holds the playhead while clicking exactly four times, hands over into
 * playback, and that the playback click keeps scheduling on the beat.
 *
 * Prereqs: app built+installed in a booted sim (Debug), Metro running.
 *   node mobile/tests/metronome.cjs
 */
const http = require('http');
const { execSync } = require('child_process');
const WebSocket = require('ws');

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
  await sleep(1000);

  // Inject a constant 120 bpm beat track + arm a one-bar count-in, click off.
  const armed = await val(`(() => {
    const beats = [];
    for (let t = 0.2; t < __test.engine.duration - 0.2; t += 0.5) beats.push(t);
    __test.engine.setBeats({ beats, bpm: 120, beatsPerBar: 4, downbeat: 0, source: 'manual' });
    __test.engine.setMetronome({ click: false, countInBars: 1, volume: 0.4 });
    return __test.engine.beats !== null;
  })()`);
  if (armed !== true) throw new Error('beat track injection failed');
  await ev('__test.engine.seek(0)');
  await sleep(400);
  const clicks0 = await val('__test.engine.clickCount');

  await ev('void __test.engine.play()');
  const t0 = Date.now();
  let sawCounting = null;
  let advanceAt = null;
  let posEarly = 0;
  while (Date.now() - t0 < 6000) {
    const st = await val(
      'JSON.stringify({p:__test.engine.audioPosition, c:__test.engine.countInStatus, pl:__test.engine.playing})'
    );
    const { p, c, pl } = JSON.parse(st);
    if (c && !sawCounting) sawCounting = c;
    if (Date.now() - t0 < 1500) posEarly = Math.max(posEarly, p);
    if (p > 0.1 && pl) {
      advanceAt = Date.now() - t0;
      break;
    }
    await sleep(150);
  }
  const clicks1 = await val('__test.engine.clickCount');
  console.log(
    `count-in: status=${JSON.stringify(sawCounting)} heldPos=${posEarly.toFixed(3)} advanceAt=${advanceAt}ms clicks=${clicks1 - clicks0}`
  );
  if (!sawCounting || sawCounting.total !== 4 || sawCounting.perBar !== 4)
    throw new Error('count-in status wrong');
  if (posEarly > 0.05) throw new Error(`position moved during count-in (${posEarly})`);
  if (advanceAt === null || advanceAt < 1600 || advanceAt > 3400)
    throw new Error(`music entered at ${advanceAt} ms (expected ~2000)`);
  if (clicks1 - clicks0 !== 4) throw new Error(`count-in clicked ${clicks1 - clicks0}x (want 4)`);

  await ev('__test.engine.pause()');
  if ((await val('__test.engine.countInStatus')) !== null) throw new Error('counting after pause');

  // Playback click: count-in hands over into on-beat clicks that keep coming.
  await ev(`__test.engine.setMetronome({ click: true, countInBars: 1, volume: 0.4 })`);
  await ev('__test.engine.seek(0)');
  await sleep(300);
  const clicks2 = await val('__test.engine.clickCount');
  await ev('void __test.engine.play()');
  await sleep(4500);
  const clicks3 = await val('__test.engine.clickCount');
  const playing = await val('__test.engine.playing');
  console.log(`playback click: ${clicks3 - clicks2} clicks in 4.5 s, playing=${playing}`);
  if (playing !== true) throw new Error('not playing');
  if (clicks3 - clicks2 < 8) throw new Error(`only ${clicks3 - clicks2} clicks with click on`);
  await ev('__test.engine.pause()');

  console.log('PASS');
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS FAIL', e.message);
  process.exit(1);
});
