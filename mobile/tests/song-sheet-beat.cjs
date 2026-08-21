/*
 * The Song sheet's rows say what is KNOWN about their own detector, watched on
 * a device through somebody else's analysis (macOS + the iOS Simulator).
 *
 * The rule this guards is song-sheet-copy.ts: the runner shows ONE progress
 * line for a whole job — beat, then key, then melody — and a row may show it
 * only while the line is about that row's detector. The bug it replaced was
 * found on a phone and could only be found on one: a HAND-MADE grid, which
 * nothing here re-detects and for which the sheet deliberately withholds
 * "Detect again", read "Reading the key…" under "Listening now — the click and
 * the count-in pick the beat up the moment it is found", with the singer's own
 * 120 bpm · 4/4 · 20 bars gone from the row that promises to keep it.
 *
 * Two seeded phone-library projects, each watched for a whole analysis:
 *   1. a hand-made grid, no key, no melody — the job runs and the beat is no
 *      part of it. The Beat row must read 'grid' at every single sample.
 *   2. nothing detected at all — the Beat row may speak for itself, and must
 *      stop the moment the beat is settled. Its blind window (the grid is
 *      committed only after the key step, so the screen has not been told yet)
 *      must read 'busy', never 'idle': that window is what used to say
 *      "Not detected yet" over a grid that had just been found.
 *
 * Each phase fails if it never sees the stage it exists to catch — a pass that
 * never opened the window would prove nothing.
 *
 * Prereqs: app built+installed in a booted sim (Debug), Metro running.
 *   node mobile/tests/song-sheet-beat.cjs
 * Env: SIM_UDID, METRO_PORT (default 8081).
 */
const http = require('http');
const { createHash } = require('crypto');
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const { join } = require('path');
const WebSocket = require('ws');

const BUNDLE = 'com.lexasoft.singz';
const UDID = process.env.SIM_UDID || 'C624B667-6F58-4F85-B64F-63B75545DDE2';
const PORT = process.env.METRO_PORT || '8081';
const PROJECT = 'Hand Tuned Grid Test';
const FRESH = 'Nothing Detected Test';
const SAMPLE = join(__dirname, '..', 'assets', 'sample');

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

/**
 * A phone-library project (Documents/ is the phone root when no folder is
 * picked) carrying the sample's stems. With a grid it is one a singer tuned by
 * hand — 120 bpm, 4/4, 20 bars, `source: 'manual'` — so the plan skips the
 * beat and asks only for the key and the melody. Without one, everything runs.
 */
function seedProject(data, name, withGrid) {
  const dir = join(data, 'Documents', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(join(dir, 'stems'), { recursive: true });
  const stemHashes = {};
  for (const f of fs.readdirSync(join(SAMPLE, 'stems'))) {
    const to = join(dir, 'stems', f);
    fs.copyFileSync(join(SAMPLE, 'stems', f), to);
    const buf = fs.readFileSync(to);
    stemHashes[f] = {
      md5: createHash('md5').update(buf).digest('hex'),
      size: buf.length,
      mtimeMs: fs.statSync(to).mtimeMs
    };
  }
  fs.copyFileSync(join(SAMPLE, 'lyrics.json'), join(dir, 'lyrics.json'));
  const beats = [];
  for (let i = 0; i < 78; i++) beats.push(Number((i * 0.5).toFixed(3)));
  const downbeats = []; // INDICES into beats, one per bar — 20 of them
  for (let i = 0; i < beats.length; i += 4) downbeats.push(i);
  const doc = JSON.parse(fs.readFileSync(join(SAMPLE, 'project.json'), 'utf8'));
  doc.name = name;
  doc.stemHashes = stemHashes;
  if (withGrid) {
    doc.settings.beat = { beats, bpm: 120, beatsPerBar: 4, downbeat: 0, downbeats, source: 'manual' };
  } else {
    delete doc.settings.beat;
  }
  delete doc.settings.key;
  delete doc.settings.melody;
  delete doc.settings.analysisNone;
  fs.writeFileSync(join(dir, 'project.json'), JSON.stringify(doc));
  return { bars: downbeats.length };
}

(async () => {
  const data = execFileSync('xcrun', ['simctl', 'get_app_container', UDID, BUNDLE, 'data'], {
    encoding: 'utf8'
  }).trim();
  execSync(`xcrun simctl terminate ${UDID} ${BUNDLE} 2>/dev/null || true`);
  const seeded = seedProject(data, PROJECT, true);
  seedProject(data, FRESH, false);
  console.log(
    `container : ${data}\n` +
      `seeded    : ${PROJECT} — hand-made grid, ${seeded.bars} bars, no key, no melody\n` +
      `            ${FRESH} — nothing detected at all\n`
  );

  execSync(`xcrun simctl launch ${UDID} ${BUNDLE}`);
  await sleep(9000);

  /**
   * Connect to one candidate and prove it answers. Metro lists every attached
   * app AND keeps targets that are already dead — a previous run's, another
   * worktree's — so the first match is not necessarily the live one. A dead
   * one accepts nothing and emits neither 'open' nor 'error', so an unguarded
   * wait on those two events hangs the driver forever with no output at all.
   * Every step here has a deadline, and the target has to do arithmetic
   * before it is believed.
   */
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
        // NOT `once`: the inspector may push a frame of its own ahead of the
        // reply, and taking the first frame as the answer would reject a
        // perfectly live target — 60 retries later, blaming Metro. A frame
        // that is not JSON must not throw out of here either; there is no
        // catch above a ws handler, so it would die without a FAIL line.
        sock.on('message', (m) => {
          let g = null;
          try {
            g = JSON.parse(m.toString());
          } catch {
            return; // not ours; keep waiting for the reply or the deadline
          }
          if (!g || g.id !== 1) return; // JSON.parse('null') parses fine
          give(g.result?.result?.value === 2 ? sock : null);
        });
        sock.send(
          JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } })
        );
      });
    });

  let ws = null;
  for (let i = 0; i < 60 && !ws; i++) {
    let cands = [];
    try {
      const l = await getJson(`http://localhost:${PORT}/json`);
      // deviceName filter: Metro lists EVERY attached app, and an Android
      // emulator sorts ahead of the simulator — an unfiltered pick drives the
      // phone while reporting on iOS. See the note in seek-memory.cjs.
      cands = l.filter((t) => t.webSocketDebuggerUrl && /iphone|ipad/i.test(t.deviceName || ''));
    } catch {}
    for (const c of cands) {
      ws = await probe(c);
      if (ws) break;
    }
    if (!ws) await sleep(1000);
  }
  if (!ws) throw new Error(`no live debugger target on :${PORT} (is Metro running?)`);
  let id = 1; // the probe used id 1
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
  if ((await val('typeof __test')) !== 'object') throw new Error('__test never appeared');

  // Automated runs are silent.
  await ev('try { __test.engine.master.gain.value = 0 } catch (e) {}');
  // The phone's own library, whatever a previous driver left picked.
  await ev("void __test.selectMode('phone')");
  await sleep(1500);

  /** Open one seeded project with its Song sheet showing. */
  const openWithSheet = async (name) => {
    let listed = false;
    for (let i = 0; i < 40 && !listed; i++) {
      listed = (await val(`(__test.projects || []).includes(${JSON.stringify(name)})`)) === true;
      if (!listed) {
        await ev('void __test.refresh()');
        await sleep(500);
      }
    }
    if (!listed) throw new Error(`${name} never listed — libMode=${await val('__test.libMode')}`);
    await ev(`void __test.openProject(${JSON.stringify(name)})`);
    let open = false;
    for (let i = 0; i < 120 && !open; i++) {
      open = (await val("__test.screen === 'player'")) === true;
      if (!open) await sleep(500);
    }
    if (!open) throw new Error(`${name} never opened`);
    await ev('try { __test.engine.master.gain.value = 0 } catch (e) {}');
    await ev('void __test.openSongSheet()');
    await sleep(400);
  };

  let check = () => {};

  /**
   * Poll the sheet for one whole analysis, calling `check` on every sample and
   * printing each distinct (stage, row state) pair. `wanted` is the stage this
   * phase exists to catch: never seeing it is a failure, not a pass.
   */
  const watch = async (wanted) => {
    const trace = [];
    const seen = new Set();
    let sawWanted = false;
    let finished = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 240000) {
      const s = JSON.parse(await val('JSON.stringify(__test.songSheet())'));
      if (!s.open) throw new Error('the Song sheet closed under us');
      const key = `${s.analysisStage ?? '—'} | ${s.beatRowState} | ${s.beatRow ?? '—'}`;
      if (!seen.has(key)) {
        seen.add(key);
        trace.push({ at: Math.round((Date.now() - t0) / 100) / 10, ...s });
      }
      if (wanted.includes(s.analysisStage)) sawWanted = true;
      check(s);
      if (sawWanted && s.analysisStage === null && s.busy === false) {
        finished = true;
        break;
      }
      await sleep(120);
    }
    for (const t of trace) {
      const grid = t.beat ? `${Math.round(t.beat.bpm)} bpm · ${t.beat.bars} bars` : '—';
      console.log(
        `  ${String(t.at).padStart(6)}s  ${String(t.analysisStage ?? '—').padEnd(7)}` +
          ` ${String(t.beatRowState).padEnd(9)} ${String(t.beatRow ?? '—').padEnd(24)} ${grid}`
      );
    }
    if (!sawWanted) throw new Error(`no ${wanted.join('/')} stage was ever seen — nothing was proved`);
    if (!finished) throw new Error('the analysis never finished within 240 s');
    return trace;
  };

  // ---- 1. a hand-made grid, while the key and the melody run over it
  console.log(`${PROJECT} — stage → Beat row:`);
  check = (s) => {
    if (s.beatManual !== true) throw new Error(`the fixture lost its manual grid: ${JSON.stringify(s)}`);
    if (s.beatRowState !== 'grid') {
      throw new Error(`the Beat row went '${s.beatRowState}' at the ${s.analysisStage} stage`);
    }
    // The line belongs to another detector: this row must not have it at all.
    if (s.beatRow !== null) throw new Error(`the Beat row took the ${s.analysisStage} line: "${s.beatRow}"`);
    if (!s.beat || Math.round(s.beat.bpm) !== 120 || s.beat.bars !== 20) {
      throw new Error(`the hand-tuned grid changed: ${JSON.stringify(s.beat)}`);
    }
  };
  await openWithSheet(PROJECT);
  await watch(['key', 'melody']);
  // It has to have been a REAL analysis, not one that died on the way in.
  const key = await val('__test.songSheet().key');
  if (!key) throw new Error('the key never landed — the analysis failed rather than ran');
  // The protection this row exists for: no button to destroy the grid.
  const offered = await val('__test.songSheet().canAnalyse');
  const pressed = await val('__test.detectAgain()');
  if (offered !== false || pressed !== false) {
    throw new Error(`"Detect again" was offered on a hand-made grid (canAnalyse=${offered})`);
  }
  console.log(`  key landed: ${key} — a whole analysis ran and the Beat row never spoke for it\n`);

  // ---- 2. nothing detected: the row speaks for itself, then stops
  await ev('void __test.closeSheets()');
  await ev('void __test.back()');
  for (let i = 0; i < 60 && (await val('__test.screen')) !== 'catalog'; i++) await sleep(500);
  console.log(`${FRESH} — stage → Beat row:`);
  let spoke = false; // the row showed its OWN detector's line
  let blind = false; // the window where the grid exists but is not committed
  let settled = false;
  check = (s) => {
    if (s.beatRowState === 'progress') {
      if (s.analysisStage !== 'start' && s.analysisStage !== 'beat') {
        throw new Error(`the ${s.analysisStage} stage spoke for the Beat row: "${s.beatRow}"`);
      }
      if (!s.beatRow) throw new Error("'progress' with no line of its own");
      if (settled) throw new Error('a settled Beat row went back to progress');
      spoke = true;
    }
    // A stored "no beat in these drums" is an answer, not a gap: this fixture
    // yields a grid on both platforms today, but a detector that changed its
    // mind must settle the row rather than fail it with a message about a
    // verdict this line never accepted.
    if (s.beat || s.noBeatVerdict) settled = true;
    // The grid is committed only after the key step, so between the two the
    // screen has no grid and its own detector is done: that is 'busy', and it
    // is the window that used to read "Not detected yet" over a found grid.
    if (s.analysisStage === 'key' && !s.beat && !s.noBeatVerdict) {
      if (s.beatRowState !== 'busy') {
        throw new Error(`the blind window read '${s.beatRowState}', not 'busy'`);
      }
      blind = true;
    }
    if (settled && s.beatRowState !== 'grid' && s.beatRowState !== 'verdict') {
      throw new Error(`a settled beat showed '${s.beatRowState}' at the ${s.analysisStage} stage`);
    }
  };
  await openWithSheet(FRESH);
  await watch(['melody']);
  if (!spoke) throw new Error('the beat stage never reached the row — was it over before the sheet opened?');
  if (!settled) throw new Error('the beat never settled — neither a grid nor a verdict');
  if (!blind) console.log('  (no blind window this run — the grid committed before the key step)');
  console.log('  the row spoke for its own detector, went busy, then held its answer\n');

  console.log('PASS');
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
});
