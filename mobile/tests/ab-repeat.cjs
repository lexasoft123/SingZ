/*
 * A-B repeat, through the button's own path (macOS against the iOS Simulator).
 *
 * loop-region.cjs already drives `engine.setRegion` — the engine has had the
 * whole mechanism since the desktop needed it, and it was never the part in
 * doubt. What shipped in v0.18.0 and nothing covered is the UI on top: the
 * three-state cycle (off -> A marked -> looping -> off) and the marks the
 * scrub rail draws its band from. `TEST.cycleLoop` and `TEST.loopMarks` were
 * exported for exactly this and no test referenced either.
 *
 * So this driver drives `cycleLoop` — the callback the A–B control's `onPress`
 * is wired to, which is as close to a tap as CDP reaches: React Native has no
 * DOM to click, so nothing here would notice the control being disabled,
 * hidden, or rewired to a different handler. What it does cover is everything
 * that happens once it is pressed. It reads the two things the button owns:
 *   - `TEST.loopMarks` — what the UI believes, and what the band is drawn
 *     from (`loopA`/`loopB` and `engine.duration` are its only inputs, so the
 *     band's own geometry is asserted here as arithmetic; no pixel is read,
 *     and the screenshot at the end is for a human to confirm one appeared)
 *   - `engine.regionState` — what the engine was actually told, which is the
 *     honest answer: cycleLoop reads the region BACK after arming rather
 *     than assuming its marks were taken, so these two agreeing is the
 *     property, not either one alone
 *
 * Covered, in order: mark A, arm, clear; marks taken in either order; a
 * mis-tap too short to loop re-marks A instead of arming silently; and the
 * loop actually going round, which is the whole point of the feature.
 *
 * Prereqs: app built+installed in a booted sim (Debug), Metro running.
 *   node mobile/tests/ab-repeat.cjs
 *   SIM_UDID=… METRO_PORT=8082 node mobile/tests/ab-repeat.cjs
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
const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;

/**
 * This device's own name, asked of simctl.
 *
 * Metro lists EVERY attached app and identifies each only by deviceName — no
 * UDID — so the /iphone|ipad/ filter the other drivers use picks whichever
 * simulator answered first, and cannot tell two of them apart at all. With
 * SIM_UDID naming a specific device (two sessions on one Mac, which is the
 * documented way to run these in parallel) the exact name is a real
 * discriminator, so use it and keep the regex only as the fallback. Measured
 * the hard way: this run had a real Xiaomi phone attached to the same Metro.
 */
const deviceName = (() => {
  try {
    const all = JSON.parse(execSync('xcrun simctl list devices --json').toString()).devices;
    for (const list of Object.values(all)) {
      const hit = list.find((d) => d.udid === UDID);
      if (hit) return hit.name;
    }
  } catch {}
  return null;
})();
const isOurs = (t) =>
  deviceName ? t.deviceName === deviceName : /iphone|ipad/i.test(t.deviceName || '');

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
      target = l.find((t) => t.webSocketDebuggerUrl && isOurs(t)) ?? null;
    } catch {}
    if (!target) await sleep(1000);
  }
  if (!target) {
    throw new Error(
      `no debugger target for ${deviceName ? `"${deviceName}"` : 'any iPhone/iPad'} on Metro ${PORT}`
    );
  }
  console.log(`driving "${target.deviceName}" via Metro ${PORT}`);
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
  const dur = await val('__test.engine.duration');
  console.log(`sample open · ${dur.toFixed(1)}s`);

  /** One press. The marks live in state, so read them a frame later —
   *  TEST.loopMarks is re-published by an effect on every render. */
  const tap = async () => {
    await ev('__test.cycleLoop()');
    await sleep(400);
    const marks = JSON.parse(await val('JSON.stringify(__test.loopMarks)'));
    const region = JSON.parse(await val('JSON.stringify(__test.engine.regionState)'));
    return { marks, region };
  };
  const seek = async (t) => {
    await ev(`__test.engine.seek(${t})`);
    await sleep(250);
  };
  /** Back to the off state whatever the cycle is holding, so each case starts
   *  from the same place without depending on the one before it. Moving away
   *  from A first is not optional: a second tap in the same place is a
   *  mis-tap by the button's own rule and re-marks A instead of arming, so a
   *  naive "tap until clear" never terminates from the A-marked state. */
  const reset = async () => {
    for (let i = 0; i < 4; i++) {
      const m = JSON.parse(await val('JSON.stringify(__test.loopMarks)'));
      if (m.a === null && m.b === null) return;
      if (m.b === null) await seek(m.a + 5 < dur ? m.a + 5 : Math.max(0, m.a - 5));
      await ev('__test.cycleLoop()');
      await sleep(300);
    }
    throw new Error('could not return the loop button to its off state');
  };

  const A = Math.round(dur * 0.25 * 10) / 10;
  const B = Math.round(dur * 0.6 * 10) / 10;

  // ---- 1. off -> A marked -----------------------------------------------
  await reset();
  await seek(A);
  const one = await tap();
  console.log('tap 1:', JSON.stringify(one));
  if (!near(one.marks.a, A, 0.15)) throw new Error(`first tap did not mark A at ${A} (got ${one.marks.a})`);
  if (one.marks.b !== null) throw new Error('first tap marked B as well');
  // Nothing may be armed yet: half a loop is not a loop, and an engine region
  // here would bound playback with no band on the rail to say why.
  if (one.region !== null) throw new Error(`first tap armed a region: ${JSON.stringify(one.region)}`);

  // ---- 2. A marked -> looping -------------------------------------------
  await seek(B);
  const two = await tap();
  console.log('tap 2:', JSON.stringify(two));
  if (!near(two.marks.a, A, 0.15) || !near(two.marks.b, B, 0.15)) {
    throw new Error(`second tap did not mark A-B ${A}-${B} (got ${JSON.stringify(two.marks)})`);
  }
  if (!two.region || two.region.loop !== true) throw new Error('second tap armed no looping region');
  // The UI must draw what the engine owns. cycleLoop reads the region back
  // for this reason — setRegion may cap or reject a span, and a lit button
  // over a loop that was never armed is the failure this prevents.
  if (!near(two.region.start, two.marks.a, 1e-6) || !near(two.region.end, two.marks.b, 1e-6)) {
    throw new Error('the band and the engine disagree about the region');
  }
  // The band's own geometry, from the only two inputs it has.
  const band = {
    left: +((two.marks.a / dur) * 100).toFixed(2),
    right: +(100 - (two.marks.b / dur) * 100).toFixed(2)
  };
  console.log(`band: left ${band.left}%, right ${band.right}%`);
  if (!(band.left > 0 && band.right > 0 && band.left + band.right < 100)) {
    throw new Error(`band geometry is not a visible span: ${JSON.stringify(band)}`);
  }
  execSync(`xcrun simctl io ${UDID} screenshot /tmp/ab-repeat-armed.png`);

  // ---- 3. the loop goes round -------------------------------------------
  // The feature, not the state: start just inside B and it must come back to
  // A rather than sail on. Position is read from the folded clock, which is
  // what the singer sees on the rail.
  const from = B - 0.5;
  await seek(from);
  await ev('void __test.engine.play()');
  await sleep(3000);
  const pos = await val('__test.engine.position');
  await ev('__test.engine.pause()');
  console.log(`played 3s from ${from.toFixed(2)}, now at ${pos.toFixed(2)}`);
  // Near A, not merely "inside the region": everything between A and B is
  // inside it, INCLUDING the place playback started. A test that accepted
  // that would pass on an engine that never played a sample.
  if (!(pos >= A - 0.1 && pos <= A + 3.5)) {
    throw new Error(`playback did not wrap to the region start (pos=${pos}, region ${A}-${B})`);
  }

  // ---- 4. looping -> off -------------------------------------------------
  const three = await tap();
  console.log('tap 3:', JSON.stringify(three));
  if (three.marks.a !== null || three.marks.b !== null) throw new Error('third tap left marks behind');
  if (three.region !== null) throw new Error('third tap left the region armed');

  // ---- 5. marks taken in either order ------------------------------------
  // A singer who hears the end of the hard bar first marks there and works
  // back. min/max, not "second one wins".
  await reset();
  await seek(B);
  await tap();
  await seek(A);
  const back = await tap();
  console.log('marked backwards:', JSON.stringify(back));
  if (!near(back.marks.a, A, 0.15) || !near(back.marks.b, B, 0.15)) {
    throw new Error(`backwards marking did not order the region (got ${JSON.stringify(back.marks)})`);
  }
  if (!back.region || back.region.start > back.region.end) throw new Error('engine took an inverted region');

  // ---- 6. a mis-tap is not a silent loop ---------------------------------
  // Under 0.4s the engine would not loop it anyway; the button re-marks A
  // there rather than lighting up over a region that does nothing.
  await reset();
  await seek(A);
  await tap();
  await seek(A + 0.2);
  const tiny = await tap();
  console.log('two taps in the same place:', JSON.stringify(tiny));
  if (tiny.marks.b !== null) throw new Error('a sub-0.4s span armed a loop that cannot play');
  if (!near(tiny.marks.a, A + 0.2, 0.08)) throw new Error('the mis-tap did not re-mark A where it landed');
  if (tiny.region !== null) throw new Error('a sub-0.4s span reached the engine');

  await reset();
  console.log('SCREENSHOT: /tmp/ab-repeat-armed.png');
  console.log('PASS');
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS FAIL', e.message ?? e);
  process.exit(1);
});
