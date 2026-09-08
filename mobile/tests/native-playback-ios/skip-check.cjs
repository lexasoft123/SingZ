/* Attach to the RUNNING app (no relaunch): dump the native lines the memory
 * driver's cycles wrote, then open the seeded project and issue a cue rebuild
 * request with an unchanged configuration straight at the coordinator, which
 * is the layer that owns the "cue rebuild skipped · configuration unchanged"
 * line (the handle's setPitchTempo returns before it on identical values). */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../../tests/shared/watchdog.cjs').arm('skip-check')

const http = require('http');
const WebSocket = require('ws');
const DEVICE_NAME = process.env.SIM_DEVICE_NAME;
const PORT = process.env.METRO_PORT || '8081';
const PROJECT = process.env.PROJECT_NAME || 'Native Playback E2E';
const SINCE = Number(process.env.SINCE_MS || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) =>
  new Promise((res, rej) => {
    http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); })
      .on('error', rej).setTimeout(5000, function () { this.destroy(new Error('timeout')); });
  });
(async () => {
  const probe = (t) => new Promise((res) => {
    const sock = new WebSocket(t.webSocketDebuggerUrl, { origin: `http://localhost:${PORT}` });
    const give = (v) => { clearTimeout(timer); if (!v) sock.close(); res(v); };
    const timer = setTimeout(() => give(null), 5000);
    sock.on('error', () => give(null));
    sock.on('open', () => {
      sock.on('message', (m) => { let g = null; try { g = JSON.parse(m.toString()); } catch { return; } if (!g || g.id !== 1) return; give(g.result?.result?.value === 2 ? sock : null); });
      sock.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } }));
    });
  });
  let ws = null;
  for (let i = 0; i < 30 && !ws; i++) {
    let cands = [];
    try { cands = (await getJson(`http://localhost:${PORT}/json`)).filter((t) => t.webSocketDebuggerUrl && t.deviceName === DEVICE_NAME); } catch {}
    for (const c of cands) { ws = await probe(c); if (ws) break; }
    if (!ws) await sleep(1000);
  }
  if (!ws) throw new Error('no live target');
  let id = 1; const pend = new Map();
  ws.on('message', (m) => { const g = JSON.parse(m.toString()); if (pend.has(g.id)) { pend.get(g.id)(g); pend.delete(g.id); } });
  const ev = (e, t = 20000) => new Promise((res, rej) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true } })); pend.set(i, res); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('eval timeout')); } }, t); });
  let slot = 0;
  const val = async (e, t = 20000) => {
    const n = ++slot;
    const g = await ev(`(() => { const __v = (${e}); if (__v && typeof __v.then === 'function') { globalThis.__q${n} = { done: false }; __v.then(v => { globalThis.__q${n} = { done: true, v }; }, err => { globalThis.__q${n} = { done: true, err: String(err && (err.stack || err.message) || err) }; }); return '__PENDING__'; } return __v; })()`, t);
    if (g.result?.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(g.result.exceptionDetails.exception?.description || g.result.exceptionDetails.text));
    const v = g.result?.result?.value;
    if (v !== '__PENDING__') return v;
    const t0 = Date.now();
    while (Date.now() - t0 < t) {
      const r = await ev(`(() => { const p = globalThis.__q${n}; if (!p || !p.done) return '__PENDING__'; delete globalThis.__q${n}; return JSON.stringify(p); })()`);
      const rv = r.result?.result?.value;
      if (rv !== '__PENDING__') { const p = JSON.parse(rv); if (p.err !== undefined) throw new Error('promise rejected: ' + p.err); return p.v; }
      await sleep(30);
    }
    throw new Error('promise never settled');
  };
  if ((await val('typeof __test')) !== 'object') throw new Error('__test missing');
  await ev('try { __test.engine.master.gain.value = 0 } catch (e) {}');
  await val(`(() => {
    const m = __r('src/playback/backend.ts');
    if (!globalThis.__origCreate) {
      globalThis.__origCreate = m.createPlaybackBackend;
      const d = Object.getOwnPropertyDescriptor(m, 'createPlaybackBackend');
      const wrapped = (e, p) => { const b = globalThis.__origCreate(e, p); globalThis.__backend = b; return b; };
      if (d && d.writable) m.createPlaybackBackend = wrapped; else Object.defineProperty(m, 'createPlaybackBackend', { get: () => wrapped, configurable: true });
    }
    globalThis.__log = () => __r('src/log.ts').logEntries();
    globalThis.__np = __r('src/playback/native.ts').nativePlayback;
    return 1; })()`);
  const fmt = (es, t0) => es.filter((e) => /^(dsp|native-playback|playback)$/.test(e.source)).map((e) => `  ${new Date(e.t).toTimeString().slice(0, 8)} [${e.level}] ${e.source}: ${e.line.slice(0, 150)}`).join('\n');
  const all = JSON.parse(await val('__log().then(e => JSON.stringify(e))'));
  console.log(`log entries in the running app: ${all.length}`);
  console.log('native/dsp lines since the memory driver launched the app:\n' + fmt(all.filter((e) => e.t >= SINCE && /materializ|unloaded generation|bypassed|project attached|preparing graph|graph ready|graph released|legacy/.test(e.line))));

  console.log(`\nscreen: ${await val('__test.screen')}`);
  await ev("void __test.selectMode('phone')");
  await sleep(1000);
  for (let i = 0; i < 40; i++) { if ((await val(`(__test.projects || []).includes(${JSON.stringify(PROJECT)})`)) === true) break; await ev('void __test.refresh()'); await sleep(500); }
  const tOpen = await val('Date.now()');
  await ev(`void __test.openProject(${JSON.stringify(PROJECT)})`);
  let open = false;
  for (let i = 0; i < 240 && !open; i++) { open = (await val("__test.screen === 'player' && typeof globalThis.__backend === 'object'")) === true; if (!open) await sleep(250); }
  if (!open) throw new Error('never opened');
  await ev('try { __test.engine.master.gain.value = 0 } catch (e) {}');
  await sleep(3000);
  console.log(`opened kind=${await val('__backend.kind')} phase=${await val('__backend.handle.snapshot().phase')}`);

  // (a) an unchanged-configuration rebuild request straight at the coordinator
  const tA = await val('Date.now()');
  const rA = await val('__np.rebuildHandleCues(__backend.handle, __backend.handle.beatInfo, __backend.handle.metronomeConfig).then(() => "resolved")', 30000);
  await sleep(1500);
  let L = JSON.parse(await val('__log().then(e => JSON.stringify(e))')).filter((e) => e.t >= tA);
  console.log(`\n(a) rebuildHandleCues(same beat, same metronome) → ${rA}\n` + (fmt(L) || '  (no lines)'));
  const skippedA = L.filter((e) => /cue rebuild skipped/.test(e.line)).length, prepA = L.filter((e) => /preparing graph/.test(e.line)).length;
  console.log(`    cue rebuild skipped=${skippedA} preparing graph=${prepA} → ${skippedA === 1 && prepA === 0 ? 'PASS' : 'FAIL'}`);

  // (b) the UI path: push the same metronome + same beats through the backend
  const tB = await val('Date.now()');
  await ev('__backend.setMetronome(JSON.parse(JSON.stringify(__backend.metronome))); __backend.setBeats(JSON.parse(JSON.stringify(__backend.beats)))');
  await sleep(2500);
  L = JSON.parse(await val('__log().then(e => JSON.stringify(e))')).filter((e) => e.t >= tB);
  console.log(`\n(b) backend.setMetronome(same) + setBeats(same)\n` + (fmt(L) || '  (no dsp/native lines — deduped before the coordinator)'));
  console.log(`    preparing graph=${L.filter((e) => /preparing graph/.test(e.line)).length} → ${L.filter((e) => /preparing graph/.test(e.line)).length === 0 ? 'PASS' : 'FAIL'}`);

  // (c) a click toggle that DOES change the configuration must rebuild exactly once, then the same request again must skip
  const tC = await val('Date.now()');
  await ev('__backend.setMetronome(Object.assign(JSON.parse(JSON.stringify(__backend.metronome)), { click: false }))');
  await sleep(12000);
  L = JSON.parse(await val('__log().then(e => JSON.stringify(e))')).filter((e) => e.t >= tC);
  console.log(`\n(c) backend.setMetronome(click:false) while prepared (never played)\n` + (fmt(L) || '  (no lines)'));
  const prepC = L.filter((e) => /preparing graph/.test(e.line)).length, rebuiltC = L.filter((e) => /cue graph rebuilt/.test(e.line)).length, refusedC = L.filter((e) => /graph build refused|cue rebuild failed/.test(e.line)).length;
  console.log(`    preparing graph=${prepC} cue graph rebuilt=${rebuiltC} refused/failed=${refusedC} → ${prepC === 1 && rebuiltC === 1 && refusedC === 0 ? 'PASS' : 'FAIL'}`);
  const tD = await val('Date.now()');
  const rD = await val('__np.rebuildHandleCues(__backend.handle, __backend.handle.beatInfo, __backend.handle.metronomeConfig).then(() => "resolved")', 30000);
  await sleep(1500);
  L = JSON.parse(await val('__log().then(e => JSON.stringify(e))')).filter((e) => e.t >= tD);
  console.log(`\n(d) same request again after the rebuild → ${rD}\n` + (fmt(L) || '  (no lines)'));
  console.log(`    cue rebuild skipped=${L.filter((e) => /cue rebuild skipped/.test(e.line)).length} preparing graph=${L.filter((e) => /preparing graph/.test(e.line)).length}`);

  await ev('void __test.back()');
  await sleep(2500);
  console.log(`\nscreen after back: ${await val('__test.screen')}`);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL: ' + (e.stack || e.message)); process.exit(1); });
