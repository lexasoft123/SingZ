/*
 * Regression test: the tracks a singer adds on the desktop play on the phone
 * (run on macOS against the iOS Simulator). Seeds a folder project built from
 * the bundled sample plus one added track that is DELIBERATELY shorter than
 * the song — a lane of a different length must not shorten the song, end
 * playback early, or lose its desktop name and colour.
 *
 * Prereqs: app built+installed in a booted sim (Debug), Metro running.
 *   node mobile/tests/custom-track.cjs
 * Env: SIM_UDID, METRO_PORT (default 8081).
 */
const http = require('http');
const { execSync, execFileSync } = require('child_process');
const { mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } = require('fs');
const { join } = require('path');
const WebSocket = require('ws');

const BUNDLE = 'com.lexasoft.singz';
const UDID = process.env.SIM_UDID || 'C624B667-6F58-4F85-B64F-63B75545DDE2';
const PORT = process.env.METRO_PORT || '8081';
const PROJECT = 'Added Track Test';
const SAMPLE = join(__dirname, '..', 'assets', 'sample');
const STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];

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
      .on('error', rej);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 16-bit stereo WAV tone — a stand-in for the singer's own recording. */
function toneWav(path, seconds, freq) {
  const sr = 44100;
  const n = Math.round(sr * seconds);
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 9000);
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([h, pcm]));
}

/** Drop a project with one added track into the app's own Documents folder. */
function seedProject() {
  const data = execFileSync('xcrun', ['simctl', 'get_app_container', UDID, BUNDLE, 'data'], {
    encoding: 'utf8'
  }).trim();
  const dir = join(data, 'Documents', PROJECT);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'stems'), { recursive: true });
  for (const s of STEMS) copyFileSync(join(SAMPLE, 'stems', `${s}.flac`), join(dir, 'stems', `${s}.flac`));
  copyFileSync(join(SAMPLE, 'lyrics.json'), join(dir, 'lyrics.json'));
  toneWav(join(dir, 'stems', 'custom-my-harmony.wav'), 4, 330);
  const doc = JSON.parse(readFileSync(join(SAMPLE, 'project.json'), 'utf8'));
  doc.name = PROJECT;
  doc.settings.custom = [
    {
      id: 'custom-my-harmony',
      label: 'My harmony',
      color: '#ff9ad5',
      file: 'stems/custom-my-harmony.wav'
    }
  ];
  doc.settings.tracks['custom-my-harmony'] = { muted: false, solo: false, volume: 0.6 };
  writeFileSync(join(dir, 'project.json'), JSON.stringify(doc, null, 1));
  return dir;
}

(async () => {
  const dir = seedProject();
  console.log(`seeded ${dir}`);
  execSync(`xcrun simctl terminate ${UDID} ${BUNDLE} 2>/dev/null || true`);
  execSync(`xcrun simctl launch ${UDID} ${BUNDLE}`);
  await sleep(9000);

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const l = await getJson(`http://localhost:${PORT}/json`);
      target = l.find((t) => t.webSocketDebuggerUrl) ?? null;
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
        JSON.stringify({
          id: i,
          method: 'Runtime.evaluate',
          params: { expression: e, returnByValue: true }
        })
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

  for (let i = 0; i < 30; i++) {
    if ((await val('typeof __test')) === 'object') break;
    await sleep(500);
  }

  // --- open the seeded project ------------------------------------------
  await ev('void __test.refresh()');
  for (let i = 0; i < 40; i++) {
    if ((await val(`(__test.projects||[]).includes(${JSON.stringify(PROJECT)})`)) === true) break;
    await sleep(500);
  }
  await ev(`void __test.openProject(${JSON.stringify(PROJECT)})`);
  for (let i = 0; i < 120; i++) {
    if ((await val("__test.screen==='player' && __test.engine.duration>0")) === true) break;
    await sleep(500);
  }
  if ((await val("__test.screen")) !== 'player') throw new Error('project never opened');

  // --- the added lane is there, last, named and coloured as saved --------
  const lanes = JSON.parse(await val('JSON.stringify(__test.lanes())'));
  console.log('lanes:', lanes.map((l) => `${l.id}(${l.label},${l.seconds}s)`).join(' '));
  const last = lanes[lanes.length - 1];
  if (!last.custom || last.id !== 'custom-my-harmony') {
    throw new Error('the added track is not the last lane');
  }
  if (last.label !== 'My harmony' || last.color !== '#ff9ad5') {
    throw new Error(`the added lane lost its desktop name/colour: ${JSON.stringify(last)}`);
  }
  if (Math.abs(last.seconds - 4) > 0.2) throw new Error(`added lane decoded wrong (${last.seconds}s)`);
  if (lanes.filter((l) => !l.custom).length !== 6) throw new Error('the six stems must still be there');

  // A lane shorter than the song must not shorten the song.
  const songSecs = lanes.find((l) => l.id === 'vocals').seconds;
  const duration = await val('Math.round(__test.engine.duration*10)/10');
  console.log(`duration ${duration}s (song ${songSecs}s, added 4s)`);
  if (Math.abs(duration - songSecs) > 0.2) throw new Error('the short added lane changed the duration');

  // --- its saved mixer state applied ------------------------------------
  const state = JSON.parse(
    await val(
      "JSON.stringify(__test.engine.getTrackStates().find(t=>t.id==='custom-my-harmony'))"
    )
  );
  console.log('mixer state:', JSON.stringify(state));
  if (Math.abs(state.volume - 0.6) > 0.01) throw new Error('saved volume for the added lane was ignored');

  // --- it plays, and playback carries on past the short lane's end -------
  await ev('void __test.engine.play()');
  await sleep(6000);
  const pos = await val('Math.round(__test.engine.position*10)/10');
  const playing = await val('__test.engine.playing');
  await ev('__test.engine.pause()');
  console.log(`position after 6s: ${pos} (playing=${playing})`);
  if (!playing || !(pos > 4.5)) throw new Error(`playback stopped at the short lane (pos=${pos})`);

  // --- muting it reaches the engine -------------------------------------
  await ev("__test.engine.setMuted('custom-my-harmony', true)");
  const muted = await val(
    "__test.engine.getTrackStates().find(t=>t.id==='custom-my-harmony').muted"
  );
  if (muted !== true) throw new Error('the added lane could not be muted');

  // --- and leaving the song lets go of it -------------------------------
  await ev('__test.back()');
  for (let i = 0; i < 20; i++) {
    if ((await val("__test.screen==='catalog'")) === true) break;
    await sleep(300);
  }
  if ((await val('__test.engine.duration')) !== 0) throw new Error('engine still holds the project');

  console.log('PASS');
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS FAIL', e.message ?? e);
  process.exit(1);
});
