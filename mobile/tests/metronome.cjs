/*
 * Metronome + count-in test (run on macOS against the iOS Simulator): injects
 * a constant beat track into the engine, then asserts that a one-bar count-in
 * holds the playhead while clicking exactly four times, hands over into
 * playback, and that the playback click keeps scheduling on the beat.
 * Ends grid-less (rubato): with no beat track a count-in must still run —
 * three ticks one second apart — and the playback click must stay silent.
 *
 * Prereqs: app built+installed in a booted sim (Debug), Metro running.
 *   node mobile/tests/metronome.cjs
 */
const http = require('http');
const { execSync } = require('child_process');
const WebSocket = require('ws');
const PORT = process.env.METRO_PORT || '8081';

const BUNDLE = 'io.s-dev.singz';
const UDID = process.env.SIM_UDID || 'C624B667-6F58-4F85-B64F-63B75545DDE2';

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
      }, 20000);
    });
  const val = async (e) => (await ev(e)).result?.result?.value;

  for (let i = 0; i < 30; i++) {
    if ((await val('typeof __test')) === 'object') break;
    await sleep(500);
  }
  // Automated runs are silent: master bus for the song; clicks bypass it,
  // so every setMetronome below passes volume 0 (clickCount still counts).
  await ev('__test.engine.master.gain.value = 0');
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
    __test.engine.setMetronome({ click: false, countInBars: 1, volume: 0, accent: true });
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
  await ev(`__test.engine.setMetronome({ click: true, countInBars: 1, volume: 0, accent: true })`);
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

  // Latency-following dots: on a 0.3 s output route (Bluetooth-ish), each dot
  // must fill only when its click becomes AUDIBLE (schedule + route lag), and
  // the dots must persist until the music itself is audible.
  const LAG = 0.3;
  await ev(`(() => {
    __test.engine.setMetronome({ click: false, countInBars: 1, volume: 0, accent: true });
    __test.engine.setDisplayLatency = () => {}; // pin against route events
    __test.engine.displayLag = ${LAG};
  })()`);
  await ev('__test.engine.seek(0)');
  await sleep(300);
  await ev('void __test.engine.play()');
  const samples = [];
  const tL = Date.now();
  while (Date.now() - tL < 5200) {
    const s = JSON.parse(
      await val(`(() => {
        const e = __test.engine;
        const c = e.countInfo;
        return JSON.stringify({
          now: e.ctx.currentTime,
          st: e.countInStatus,
          first: c ? c.firstCtx : null,
          per: c ? c.periodCtx : null,
          started: e.startedAt,
          stretch: e.stretchLatency,
          pl: e.playing
        });
      })()`)
    );
    samples.push(s);
    if (!s.pl) break;
    await sleep(70);
  }
  const info = samples.find((s) => s.first !== null);
  if (!info) throw new Error('no countInfo captured');
  let okDots = 0;
  let badDots = 0;
  let early = 0;
  let lastCounting = null;
  for (const s of samples) {
    if (s.st === null) continue;
    lastCounting = s;
    const exp = Math.max(
      0,
      Math.min(s.st.total, Math.floor((s.now - LAG - info.first) / info.per) + 1)
    );
    if (s.st.done === exp) okDots++;
    else badDots++;
    if (s.now - LAG < info.first && s.st.done > 0) early++;
  }
  const audibleStart = info.started + info.stretch + LAG;
  console.log(
    `latency dots: ${okDots} ok / ${badDots} off, early=${early}, lastCounting=${lastCounting ? lastCounting.now.toFixed(3) : 'none'} audibleStart=${audibleStart.toFixed(3)}`
  );
  if (early > 0) throw new Error('a dot filled before its click was audible');
  if (okDots < (okDots + badDots) * 0.8) throw new Error('dots do not follow the audible clock');
  if (!lastCounting || lastCounting.now < audibleStart - 0.25)
    throw new Error('dots vanished before the music was audible');
  await ev('__test.engine.pause()');

  // Rubato: no beat track at all — the count-in degrades to the clock
  // (bars×3 ticks, one per second) and the playback click stays silent.
  await ev(`(() => {
    __test.engine.displayLag = 0;
    __test.engine.setBeats(null);
    __test.engine.setMetronome({ click: false, countInBars: 1, volume: 0, accent: true });
  })()`);
  await ev('__test.engine.seek(0)');
  await sleep(400);
  const rClicks0 = await val('__test.engine.clickCount');
  await ev('void __test.engine.play()');
  const rT0 = Date.now();
  let rSaw = null;
  let rInfo = null;
  let rAdvanceAt = null;
  let rPosEarly = 0;
  while (Date.now() - rT0 < 7000) {
    const st = await val(`(() => {
      const e = __test.engine;
      const c = e.countInfo;
      return JSON.stringify({
        p: e.audioPosition, c: e.countInStatus, pl: e.playing,
        per: c ? c.periodCtx : null, span: c ? e.startedAt + e.stretchLatency - c.firstCtx : null
      });
    })()`);
    const { p, c, pl, per, span } = JSON.parse(st);
    if (c && !rSaw) rSaw = c;
    if (per !== null && !rInfo) rInfo = { per, span };
    if (Date.now() - rT0 < 2400) rPosEarly = Math.max(rPosEarly, p);
    if (p > 0.1 && pl) {
      rAdvanceAt = Date.now() - rT0;
      break;
    }
    await sleep(150);
  }
  const rClicks1 = await val('__test.engine.clickCount');
  console.log(
    `rubato count-in: status=${JSON.stringify(rSaw)} info=${JSON.stringify(rInfo)} heldPos=${rPosEarly.toFixed(3)} advanceAt=${rAdvanceAt}ms ticks=${rClicks1 - rClicks0}`
  );
  if (!rSaw || rSaw.total !== 3 || rSaw.perBar !== 3)
    throw new Error('rubato count-in status wrong');
  if (!rInfo || Math.abs(rInfo.per - 1) > 1e-6 || Math.abs(rInfo.span - 3) > 0.01)
    throw new Error('rubato ticks not one second apart');
  if (rPosEarly > 0.05) throw new Error(`position moved during rubato count-in (${rPosEarly})`);
  if (rAdvanceAt === null || rAdvanceAt < 2600 || rAdvanceAt > 4600)
    throw new Error(`music entered at ${rAdvanceAt} ms (expected ~3000)`);
  if (rClicks1 - rClicks0 !== 3) throw new Error(`rubato ticked ${rClicks1 - rClicks0}x (want 3)`);
  await ev('__test.engine.pause()');

  // Click-on without a grid: the count-in still runs, nothing clicks after.
  await ev(`__test.engine.setMetronome({ click: true, countInBars: 1, volume: 0, accent: true })`);
  await ev('__test.engine.seek(0)');
  await sleep(300);
  const rClicks2 = await val('__test.engine.clickCount');
  await ev('void __test.engine.play()');
  await sleep(5500);
  const rClicks3 = await val('__test.engine.clickCount');
  const rPlaying = await val('__test.engine.playing');
  console.log(`rubato click-on: ${rClicks3 - rClicks2} ticks in 5.5 s, playing=${rPlaying}`);
  if (rPlaying !== true) throw new Error('not playing (rubato click-on)');
  if (rClicks3 - rClicks2 !== 3)
    throw new Error(`grid-less playback clicked ${rClicks3 - rClicks2}x (want 3 count-in only)`);
  await ev('__test.engine.pause()');

  console.log('PASS');
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS FAIL', e.message);
  process.exit(1);
});
