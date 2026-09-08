/*
 * Scratch driver: experimental native playback on the iOS Simulator.
 * Seeds a phone-library project (looped sample, 122 s, manual grid 120 bpm 4/4,
 * click ON, 1-bar count-in), enables the native preference, opens the song,
 * plays, changes pitch, samples position, seeks, leaves — reading the in-app
 * log (src/log.ts logEntries) and the player's backend (captured by wrapping
 * createPlaybackBackend through Metro's dev __r) the whole way.
 *
 * Silent: legacy master gain zeroed, native master gain set to 0 before play.
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../../tests/shared/watchdog.cjs').arm('native-playback-ios')

const http = require('http');
const { createHash } = require('crypto');
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const { join } = require('path');
const WebSocket = require('ws');

const BUNDLE = 'io.s-dev.singz';
const UDID = process.env.SIM_UDID;
const DEVICE_NAME = process.env.SIM_DEVICE_NAME;
const PORT = process.env.METRO_PORT || '8081';
const PROJECT = process.env.PROJECT_NAME || 'Native Playback E2E';
const REPO = process.env.REPO_MOBILE;
const STEMS = process.env.STEMS_DIR;
if (!UDID || !DEVICE_NAME || !REPO || !STEMS) throw new Error('SIM_UDID, SIM_DEVICE_NAME, REPO_MOBILE, STEMS_DIR required');
const SAMPLE = join(REPO, 'assets', 'sample');

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

function seedProject(data, name) {
  const dir = join(data, 'Documents', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(join(dir, 'stems'), { recursive: true });
  const stemHashes = {};
  for (const f of fs.readdirSync(STEMS)) {
    if (!f.endsWith('.flac')) continue;
    const to = join(dir, 'stems', f);
    fs.copyFileSync(join(STEMS, f), to);
    const buf = fs.readFileSync(to);
    stemHashes[f] = { md5: createHash('md5').update(buf).digest('hex'), size: buf.length, mtimeMs: fs.statSync(to).mtimeMs };
  }
  fs.copyFileSync(join(SAMPLE, 'lyrics.json'), join(dir, 'lyrics.json'));
  const beats = [];
  for (let i = 0; i < 244; i++) beats.push(Number((i * 0.5).toFixed(3)));
  const downbeats = [];
  for (let i = 0; i < beats.length; i += 4) downbeats.push(i);
  const doc = JSON.parse(fs.readFileSync(join(SAMPLE, 'project.json'), 'utf8'));
  doc.name = name;
  doc.stemHashes = stemHashes;
  doc.settings.beat = { beats, bpm: 120, beatsPerBar: 4, downbeat: 0, downbeats, source: 'manual' };
  doc.settings.metronome = { click: true, countInBars: 1, volume: 0.7, accent: true };
  delete doc.settings.key;
  delete doc.settings.melody;
  delete doc.settings.analysisNone;
  fs.writeFileSync(join(dir, 'project.json'), JSON.stringify(doc));
  return { bars: downbeats.length, dir };
}

const results = [];
const report = (item, ok, detail) => {
  results.push({ item, ok, detail });
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${item}\n${detail}`);
};

(async () => {
  const data = execFileSync('xcrun', ['simctl', 'get_app_container', UDID, BUNDLE, 'data'], { encoding: 'utf8' }).trim();
  execSync(`xcrun simctl terminate ${UDID} ${BUNDLE} 2>/dev/null || true`);
  const seeded = seedProject(data, PROJECT);
  console.log(`container : ${data}\nseeded    : ${PROJECT} — ${seeded.bars} bars @120 bpm, click on, 1-bar count-in\n            ${seeded.dir}`);
  const launched = execSync(`xcrun simctl launch ${UDID} ${BUNDLE}`).toString().trim();
  console.log(`launched  : ${launched}`);
  await sleep(8000);

  const probe = (t) =>
    new Promise((res) => {
      const sock = new WebSocket(t.webSocketDebuggerUrl, { origin: `http://localhost:${PORT}` });
      const give = (v) => {
        clearTimeout(timer);
        if (!v) sock.close();
        res(v);
      };
      const timer = setTimeout(() => give(null), 5000);
      sock.on('error', () => give(null));
      sock.on('open', () => {
        sock.on('message', (m) => {
          let g = null;
          try {
            g = JSON.parse(m.toString());
          } catch {
            return;
          }
          if (!g || g.id !== 1) return;
          give(g.result?.result?.value === 2 ? sock : null);
        });
        sock.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } }));
      });
    });

  let ws = null;
  let picked = null;
  for (let i = 0; i < 60 && !ws; i++) {
    let cands = [];
    try {
      const l = await getJson(`http://localhost:${PORT}/json`);
      cands = l.filter((t) => t.webSocketDebuggerUrl && t.deviceName === DEVICE_NAME);
    } catch {}
    for (const c of cands) {
      ws = await probe(c);
      if (ws) {
        picked = c;
        break;
      }
    }
    if (!ws) await sleep(1000);
  }
  if (!ws) throw new Error(`no live debugger target named ${DEVICE_NAME} on :${PORT}`);
  console.log(`target    : ${picked.deviceName} · ${picked.title || ''} · ${picked.id}`);
  let id = 1;
  const pend = new Map();
  ws.on('message', (m) => {
    const g = JSON.parse(m.toString());
    if (pend.has(g.id)) {
      pend.get(g.id)(g);
      pend.delete(g.id);
    }
  });
  const ev = (e, timeoutMs = 20000) =>
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
          rej(new Error('eval timeout: ' + e.slice(0, 80)));
        }
      }, timeoutMs);
    });
  let slot = 0;
  /** RN's Promise is a polyfill the inspector's awaitPromise does not unwrap:
   *  park a thenable's outcome on a global slot and poll it from here. */
  const val = async (e, t = 20000) => {
    const n = ++slot;
    const wrapped = `(() => { const __v = (${e}); if (__v && typeof __v.then === 'function') { globalThis.__p${n} = { done: false }; __v.then(v => { globalThis.__p${n} = { done: true, v }; }, err => { globalThis.__p${n} = { done: true, err: String(err && (err.stack || err.message) || err) }; }); return '__PENDING__'; } return __v; })()`;
    const g = await ev(wrapped, t);
    if (g.result?.exceptionDetails) {
      throw new Error('eval threw: ' + JSON.stringify(g.result.exceptionDetails.exception?.description || g.result.exceptionDetails.text));
    }
    const v = g.result?.result?.value;
    if (v !== '__PENDING__') return v;
    const t0 = Date.now();
    while (Date.now() - t0 < t) {
      const r = await ev(`(() => { const p = globalThis.__p${n}; if (!p || !p.done) return '__PENDING__'; delete globalThis.__p${n}; return JSON.stringify(p); })()`, 20000);
      const rv = r.result?.result?.value;
      if (rv !== '__PENDING__') {
        const p = JSON.parse(rv);
        if (p.err !== undefined) throw new Error('promise rejected: ' + p.err);
        return p.v;
      }
      await sleep(30);
    }
    throw new Error('promise never settled: ' + e.slice(0, 80));
  };

  for (let i = 0; i < 40; i++) {
    if ((await val('typeof __test')) === 'object') break;
    await sleep(500);
  }
  if ((await val('typeof __test')) !== 'object') throw new Error('__test never appeared');
  await ev('try { __test.engine.master.gain.value = 0 } catch (e) {}');

  // ---- module access through Metro's dev require
  const modNames = await val(`(() => {
    const out = {};
    for (const n of ['src/playback/native.ts','src/playback/backend.ts','src/log.ts']) {
      try { __r(n); out[n] = 'ok'; } catch (e) { out[n] = String(e.message); }
    }
    return out;
  })()`);
  console.log('modules   :', JSON.stringify(modNames));
  if (Object.values(modNames).some((v) => v !== 'ok')) throw new Error('module names not resolvable through __r');

  await val(`(() => {
    const m = __r('src/playback/backend.ts');
    if (!globalThis.__origCreate) {
      globalThis.__origCreate = m.createPlaybackBackend;
      const d = Object.getOwnPropertyDescriptor(m, 'createPlaybackBackend');
      const wrapped = (e, p) => { const b = globalThis.__origCreate(e, p); globalThis.__backend = b; return b; };
      if (d && d.writable) m.createPlaybackBackend = wrapped;
      else Object.defineProperty(m, 'createPlaybackBackend', { get: () => wrapped, configurable: true });
    }
    globalThis.__log = () => __r('src/log.ts').logEntries();
    globalThis.__np = __r('src/playback/native.ts').nativePlayback;
    return typeof __r('src/playback/backend.ts').createPlaybackBackend;
  })()`);

  const status0 = await val('__np.settingsStatus().then(s => JSON.stringify({enabled:s.enabled,supported:s.supported,detail:s.detail,buildId:s.capability&&s.capability.buildId,playbackBuild:s.capability&&s.capability.playbackBuild}))');
  console.log('native    :', status0);
  await val('__np.saveEnabled(true).then(() => 1)');
  const status1 = await val('__np.settingsStatus().then(s => JSON.stringify({enabled:s.enabled,supported:s.supported}))');
  console.log('native    :', status1);
  if (!JSON.parse(status1).enabled || !JSON.parse(status1).supported) throw new Error('native playback not enabled/supported: ' + status1);

  const logSince = async (t) => {
    const all = JSON.parse(await val('__log().then(e => JSON.stringify(e))'));
    return all.filter((e) => e.t >= t);
  };
  const fmt = (entries, t0) =>
    entries
      .filter((e) => /^(dsp|native-playback|playback)$/.test(e.source))
      .map((e) => `  ${(((e.t - t0) / 1000).toFixed(3)).padStart(8)}s [${e.level}] ${e.source}: ${e.line}`)
      .join('\n');
  const count = (entries, re) => entries.filter((e) => re.test(e.line)).length;

  // ---- open the project
  await ev("void __test.selectMode('phone')");
  await sleep(1500);
  let listed = false;
  for (let i = 0; i < 40 && !listed; i++) {
    listed = (await val(`(__test.projects || []).includes(${JSON.stringify(PROJECT)})`)) === true;
    if (!listed) {
      await ev('void __test.refresh()');
      await sleep(500);
    }
  }
  if (!listed) throw new Error(`${PROJECT} never listed — libMode=${await val('__test.libMode')}`);
  const tOpen = await val('Date.now()');
  await ev(`void __test.openProject(${JSON.stringify(PROJECT)})`);
  let open = false;
  for (let i = 0; i < 240 && !open; i++) {
    open = (await val("__test.screen === 'player' && typeof globalThis.__backend === 'object'")) === true;
    if (!open) await sleep(250);
  }
  if (!open) throw new Error('project never opened natively (screen/backend)');
  const tPlayerUp = await val('Date.now()');
  const kind = await val('__backend.kind');
  console.log(`\nopened    : kind=${kind} · ${((tPlayerUp - tOpen) / 1000).toFixed(2)} s to player screen`);
  if (kind !== 'ios-native') throw new Error('backend is not ios-native: ' + kind);
  await ev('try { __test.engine.master.gain.value = 0 } catch (e) {}');
  await sleep(5000);

  const openLog = await logSince(tOpen);
  console.log('log since open (5 s settle):\n' + fmt(openLog, tOpen));
  const prep1 = count(openLog, /preparing graph/);
  const ready1 = count(openLog, /graph ready/);
  const refused1 = count(openLog, /graph build refused/);
  const cueFail1 = count(openLog, /cue rebuild failed/);
  const skipped1 = count(openLog, /cue rebuild skipped/);
  const rebuilt1 = count(openLog, /cue graph rebuilt/);
  report(
    '1. open: exactly one preparing graph + graph ready, no refusal/cue failure/second prepare (5 s window)',
    prep1 === 1 && ready1 === 1 && refused1 === 0 && cueFail1 === 0 && rebuilt1 === 0,
    `preparing graph=${prep1} graph ready=${ready1} graph build refused=${refused1} cue rebuild failed=${cueFail1} cue graph rebuilt=${rebuilt1} cue rebuild skipped=${skipped1}`
  );

  // wait for any background analysis (key/melody on the seeded project) to finish before timing Play
  let busy = true;
  const tA = Date.now();
  while (Date.now() - tA < 240000) {
    const s = JSON.parse(await val('JSON.stringify(__test.songSheet())'));
    if (s.busy === false && s.analysisStage === null) {
      busy = false;
      break;
    }
    await sleep(1000);
  }
  console.log(`\nanalysis  : ${busy ? 'STILL BUSY after 240 s' : `idle after ${((Date.now() - tA) / 1000).toFixed(0)} s`}`);
  const preLog = await logSince(tOpen);
  const prepPre = count(preLog, /preparing graph/);
  console.log(`preparing graph lines between open and Play (whole window): ${prepPre}`);
  if (prepPre !== 1) console.log(fmt(preLog, tOpen));

  // ---- mute natively, then Play
  await val('(async () => { __backend.setMasterGain(0); await __backend.transportTail; return __backend.masterGain })()');
  const tMute = await val('Date.now()');
  const preState = JSON.parse(await val('JSON.stringify(__backend.handle.snapshot())'));
  console.log(`pre-play  : phase=${preState.phase} pos=${preState.positionSec} dur=${preState.durationSec} masterGain=${await val('__backend.masterGain')}`);

  const playRes = JSON.parse(
    await val(`(async () => { const t0 = Date.now(); let r; try { r = await __backend.play(); } catch (e) { r = { error: String(e && e.message) }; } return JSON.stringify({ t0, tDone: Date.now(), r }); })()`, 30000)
  );
  let renderT = null, audibleT = null, prepPlay = 0, playLog = [];
  for (let i = 0; i < 100 && (renderT === null || audibleT === null); i++) {
    playLog = await logSince(playRes.t0);
    const r = playLog.find((e) => /rendering started/.test(e.line));
    const a = playLog.find((e) => /first audible callback/.test(e.line));
    if (r) renderT = r.t;
    if (a) audibleT = a.t;
    if (renderT === null || audibleT === null) await sleep(100);
  }
  await sleep(500);
  playLog = await logSince(playRes.t0);
  prepPlay = count(playLog, /preparing graph/);
  console.log('log since play():\n' + fmt(playLog, playRes.t0));
  const playToRender = renderT === null ? null : renderT - playRes.t0;
  const playToAudible = audibleT === null ? null : audibleT - playRes.t0;
  report(
    '2. play: rendering started + first audible callback, no new preparing graph, play→rendering well under 1 s',
    renderT !== null && audibleT !== null && prepPlay === 0 && playToRender < 1000,
    `play() resolved in ${playRes.tDone - playRes.t0} ms (${JSON.stringify(playRes.r)}) · play→"rendering started" ${playToRender} ms · play→"first audible callback" ${playToAudible} ms · preparing graph lines after play=${prepPlay}`
  );

  // wait until past the count-in
  let pos = 0;
  for (let i = 0; i < 100; i++) {
    pos = await val('__backend.position');
    const cs = JSON.parse(await val('JSON.stringify(__backend.countInStatus)'));
    if (pos > 1.0 && !(cs && cs.active)) break;
    await sleep(200);
  }
  console.log(`\nplaying   : position=${pos.toFixed(3)} playing=${await val('__backend.playing')}`);

  // ---- 4a. position projection sampling
  const sampler = (ms, everyMs, extra = '') =>
    val(
      `(() => new Promise(res => { const out = []; const t0 = Date.now(); ${extra}
        const iv = setInterval(() => { const t = Date.now(); out.push([t - t0, __backend.position, __backend.audioPosition]); if (t - t0 >= ${ms}) { clearInterval(iv); res(JSON.stringify({ t0, out })); } }, ${everyMs}); }))()`,
      ms + 5000
    ).then(JSON.parse);
  const s1 = await sampler(1000, 20);
  const positions = s1.out.map((s) => s[1]);
  const distinct = new Set(positions.map((p) => p.toFixed(4))).size;
  const steps = [], ratios = [], dts = [];
  for (let i = 1; i < s1.out.length; i++) {
    const dt = (s1.out[i][0] - s1.out[i - 1][0]) / 1000;
    const dp = s1.out[i][1] - s1.out[i - 1][1];
    steps.push(dp); dts.push(dt); ratios.push(dp / dt);
  }
  const maxStep = Math.max(...steps), minStep = Math.min(...steps);
  const zeroSteps = steps.filter((s) => Math.abs(s) < 1e-6).length;
  const negSteps = steps.filter((s) => s < -1e-6).length;
  const span = positions[positions.length - 1] - positions[0];
  const wall = (s1.out[s1.out.length - 1][0] - s1.out[0][0]) / 1000;
  const meanRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const minRatio = Math.min(...ratios), maxRatio = Math.max(...ratios);
  console.log(`\nposition samples (t ms, position, audioPosition, step ms) — all ${s1.out.length}:\n` + s1.out.map((s, i) => `  ${String(s[0]).padStart(4)} ${s[1].toFixed(4)} ${s[2].toFixed(4)} ${i ? ((s[1] - s1.out[i - 1][1]) * 1000).toFixed(1) : '—'}`).join('\n'));
  report(
    '4a. position projection: advances continuously with wall time between 200 ms polls (no repeated values, no stairs)',
    zeroSteps === 0 && negSteps === 0 && maxStep < 0.15 && meanRatio > 0.85 && meanRatio < 1.15 && minRatio > 0.5,
    `${s1.out.length} samples over ${(wall * 1000).toFixed(0)} ms wall (sampler interval min=${(Math.min(...dts) * 1000).toFixed(0)} max=${(Math.max(...dts) * 1000).toFixed(0)} ms) · distinct positions=${distinct} · step min=${(minStep * 1000).toFixed(1)} ms max=${(maxStep * 1000).toFixed(1)} ms · zero steps=${zeroSteps} · negative steps=${negSteps} · position advanced ${span.toFixed(3)} s in ${wall.toFixed(3)} s wall · step/dt ratio mean=${meanRatio.toFixed(3)} min=${minRatio.toFixed(3)} max=${maxRatio.toFixed(3)}`
  );

  // ---- 3. pitch change
  const tPitch = await val('Date.now()');
  await ev('__backend.setPitchTempo(2, 1)');
  await sleep(10000);
  const pitchLog = await logSince(tPitch);
  console.log('log since setPitchTempo(+2, 1):\n' + fmt(pitchLog, tPitch));
  const rebuilt = count(pitchLog, /cue graph rebuilt/);
  const resumed = count(pitchLog, /cue graph resumed/);
  const prepP = count(pitchLog, /preparing graph/);
  const skippedP = count(pitchLog, /cue rebuild skipped/);
  const failedP = count(pitchLog, /cue rebuild failed/);
  const pitchNow = JSON.parse(await val('JSON.stringify(__backend.pitchTempo)'));
  const posAfterPitch1 = await val('__backend.position');
  await sleep(500);
  const posAfterPitch2 = await val('__backend.position');
  report(
    '3a. one pitch change: exactly one cue graph rebuilt + one cue graph resumed, one preparing graph in 10 s',
    rebuilt === 1 && resumed === 1 && prepP === 1 && failedP === 0,
    `cue graph rebuilt=${rebuilt} cue graph resumed=${resumed} preparing graph=${prepP} cue rebuild skipped=${skippedP} cue rebuild failed=${failedP} · pitchTempo now=${JSON.stringify(pitchNow)} · playing=${await val('__backend.playing')} position ${posAfterPitch1.toFixed(2)}→${posAfterPitch2.toFixed(2)} over 0.5 s`
  );

  const tPitch2 = await val('Date.now()');
  await ev('__backend.setPitchTempo(2, 1)');
  await sleep(5000);
  const pitchLog2 = await logSince(tPitch2);
  console.log('log since second identical setPitchTempo(+2, 1):\n' + (fmt(pitchLog2, tPitch2) || '  (no dsp/native lines)'));
  const prepP2 = count(pitchLog2, /preparing graph/);
  const skippedP2 = count(pitchLog2, /cue rebuild skipped/);
  const rebuilt2 = count(pitchLog2, /cue graph rebuilt/);
  report(
    '3b. second identical setPitchTempo(+2, 1): zero new prepares',
    prepP2 === 0 && rebuilt2 === 0,
    `preparing graph=${prepP2} cue graph rebuilt=${rebuilt2} cue rebuild skipped=${skippedP2} (in 5 s)`
  );

  // ---- 4b. seek to 60 s while playing
  const before = await val('__backend.position');
  const seekRes = await val(
    `(() => new Promise(res => { const out = []; const t0 = Date.now(); let tResolved = null; let seekErr = null;
      const iv = setInterval(() => { const t = Date.now(); out.push([t - t0, __backend.position, __backend.audioPosition, tResolved !== null]); if (t - t0 >= 1000) { clearInterval(iv); res(JSON.stringify({ t0, tResolved: tResolved === null ? null : tResolved - t0, seekErr, out })); } }, 20);
      __backend.seek(60);
      __backend.transportTail.then(() => { tResolved = Date.now(); }, e => { seekErr = String(e && e.message); tResolved = Date.now(); });
    }))()`,
    10000
  ).then(JSON.parse);
  await sleep(300);
  const seekLog = await logSince(seekRes.t0);
  const after = seekRes.out.filter((s) => s[3]);
  const badAfter = after.filter((s) => !(s[1] >= 59.5 && s[1] <= 61.5));
  const afterMin = after.length ? Math.min(...after.map((s) => s[1])) : null, afterMax = after.length ? Math.max(...after.map((s) => s[1])) : null;
  const backSteps = after.filter((s, i) => i > 0 && s[1] < after[i - 1][1] - 1e-6).map((s, i) => s[1]);
  const firstAfter = after[0];
  console.log(`\nseek samples (t ms, position, audioPosition, resolved?) — position before=${before.toFixed(3)}, seek resolved at ${seekRes.tResolved} ms:\n` + seekRes.out.map((s) => `  ${String(s[0]).padStart(4)} ${s[1].toFixed(3)} ${s[2].toFixed(3)} ${s[3] ? 'after' : 'before'}`).join('\n'));
  if (seekLog.length) console.log('log during seek:\n' + fmt(seekLog, seekRes.t0));
  report(
    '4b. seek(60) while playing: first sample after the seek resolves already reads ≈60 s, none shows the pre-seek position',
    seekRes.tResolved !== null && !seekRes.seekErr && after.length > 0 && badAfter.length === 0,
    `resolved after ${seekRes.tResolved} ms · first post-resolve sample: t=${firstAfter ? firstAfter[0] : '—'} ms position=${firstAfter ? firstAfter[1].toFixed(3) : '—'} · post-resolve samples=${after.length} out-of-band=${badAfter.length} · post-resolve position range ${afterMin === null ? '—' : afterMin.toFixed(3)}..${afterMax === null ? '—' : afterMax.toFixed(3)} · backward corrections=${backSteps.length}${seekRes.seekErr ? ' · seek error: ' + seekRes.seekErr : ''}`
  );

  // ---- 5. leave the player
  const tBack = await val('Date.now()');
  await ev('void __test.back()');
  let catalog = false;
  for (let i = 0; i < 60 && !catalog; i++) {
    catalog = (await val("__test.screen === 'catalog'")) === true;
    if (!catalog) await sleep(500);
  }
  await sleep(3000);
  const backLog = await logSince(tBack);
  console.log('log since back():\n' + fmt(backLog, tBack));
  const unloaded = backLog.filter((e) => e.source === 'native-playback' && /unloaded generation/.test(e.line));
  const sess = JSON.parse(await val('__np.settingsStatus().then(s => JSON.stringify(s.capability && s.capability.session))'));
  report(
    '5. leave: catalog shown, native-playback "unloaded generation" logged, native session unloaded',
    catalog && unloaded.length >= 1 && sess && sess.state === 'unloaded',
    `catalog=${catalog} · unloaded lines=${unloaded.length}: ${unloaded.map((e) => e.line).join(' | ')} · native session state=${sess && sess.state}`
  );

  console.log('\n==== SUMMARY ====');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.item}`);
  const allOk = results.every((r) => r.ok);
  console.log(allOk ? '\nPASS' : '\nFAIL');
  ws.close();
  process.exit(allOk ? 0 : 1);
})().catch((e) => {
  console.error(`FAIL: ${e.stack || e.message}`);
  process.exit(1);
});
