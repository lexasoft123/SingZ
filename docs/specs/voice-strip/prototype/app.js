/* SingZ Voice strip prototype. No audio, no microphone: everything is simulated. */
(() => {
'use strict';

/* ---- strings (one object, for later i18n) ---- */
const STR = {
  muteAria: 'Mute voice take playback', unmuteAria: 'Unmute voice take playback',
  monOnAria: 'Monitoring on. Click to turn off', monOffAria: 'Monitor my voice (monitoring is off)',
  monOffTitle: 'Monitor my voice (off)', monOnTitle: 'Monitoring on. Click to turn off',
  soloAria: 'Solo voice', armAria: 'Arm for recording', disarmAria: 'Arm for recording',
  recordTitle: 'Record (R)', stopTitle: 'Stop recording (R)',
  recWhy: { perm: 'Record unavailable: microphone access needed', missing: 'Record unavailable: no input found', error: 'Record unavailable: retry the input first', take: 'Record unavailable: keep or discard the current take first' },
  voiceLevel: 'Voice level',
  monitorLevel: 'Monitor level',
  inputGroupNone: 'No input found', inputPerm: 'Mic access needed',
  msgMonitoring: 'Monitoring on',
  msgArmed: 'Armed. Recording starts at the playhead.',
  msgRecording: 'Recording over the song',
  msgReview: 'Keep the take, or discard it to record again.',
  msgListenAlone: 'Listening to the take alone. The song is muted.',
  msgListenSong: "Listening with the song at the take's settings",
  latencyUnavailable: 'Monitoring needs a low-latency route (over 256 frames). Recording still works.',
  routeUnavailable: "Monitoring isn't available on this output route (Bluetooth). Recording still works.",
  permNeeded: 'Microphone access needed to record.', permBtn: 'Allow microphone',
  inputMissing: 'No microphone found.', inputBtn: 'Check again',
  errorText: 'Input unplugged. The first 0:12 was kept.', retry: 'Retry',
  levelTip: (l, p) => `Input level ${l < -59 ? '\u2212\u221e' : (l >= 0 ? l : '\u2212' + -l)} dBFS, peak ${p >= 0 ? p : '\u2212' + -p}`,
  levelNone: 'Input level: no signal (input is not live)',
  clipOn: 'Input clipped. Click to reset the clip indicator', clipOff: 'No clipping. Clip indicator',
  badgeOk: (ms) => `${ms} ms`, badgeLatency: '> 256 frames', badgeRoute: 'no route',
  badgeTitleOk: 'Monitoring latency (target 32 frames, max accepted 256)',
  badgeTitleLatency: 'This route cannot monitor within 256 frames',
  badgeTitleRoute: 'Monitoring is not available on this route',
  emptyIdle: 'Your take appears here, at the playhead',
  emptyArmed: 'Armed. Press Record (R) to start at the playhead',
  emptyPerm: 'Allow microphone access to record', emptyMissing: 'Connect a microphone to record',
  keep: 'Keep take', kept: 'Take kept', listen: 'Listen', listenSong: 'Listen with song', add: 'Add to song as track',
  discard: 'Discard take', stopListening: 'Stop listening', stopListeningSong: 'Stop listening with song',
  takeInfo: (n, dur, extra) => `Take ${n} · ${dur}${extra}`,
  recordingInfo: (dur) => `Recording · ${dur}`,
  tag: (tempo, tr, changed) => `recorded at ${tempo}% · ${tr}${changed ? ' · changed mid-take' : ''}`,
  tagTitleChanged: 'Tempo or transpose changed while recording. The take plays back as sung.',
  tagTitle: 'The take was recorded against the song at these settings.',
  playLabel: 'Play', pauseLabel: 'Pause',
  announce: {
    recording: 'Recording started', review: 'Recording stopped. Keep or discard the take.',
    kept: 'Take kept', discarded: 'Take discarded', added: (n) => `Added Voice take ${n} as a track`,
    monOn: 'Monitoring on', monOff: 'Monitoring off', granted: 'Microphone allowed', found: 'Input found',
    retried: 'Input reconnected', armed: 'Armed', disarmed: 'Disarmed',
  },
  states: ['idle', 'input-missing', 'permission-needed', 'armed', 'recording', 'take-review', 'playing-take',
    'monitoring-on', 'monitoring-unavailable-latency', 'monitoring-unavailable-route', 'error-recoverable'],
};
const INPUTS = [
  { group: 'MacBook Pro Microphone', opts: [['mbp:1', 'MacBook Pro Mic · mono']] },
  { group: 'Scarlett 2i2 USB', opts: [['scar:1', 'Scarlett 2i2 · In 1 (mono)'], ['scar:2', 'Scarlett 2i2 · In 2 (mono)']] },
];
const STEMS = [
  { id: 'vocals', name: 'Vocals', color: '#f0566e', seed: 3, density: 0.55 },
  { id: 'drums', name: 'Drums', color: '#f6c445', seed: 7, density: 0.7 },
  { id: 'bass', name: 'Bass', color: '#5a86ff', seed: 11, density: 0.85 },
  { id: 'guitar', name: 'Guitar', color: '#f58b2a', seed: 19, density: 0.8 },
];
const LEN = 200; // song length, seconds
const VOICE = '#5be3b0';

/* ---- state ---- */
const S = {
  perm: 'granted', inputMissing: false, phase: 'idle', listen: null, // 'alone' | 'song'
  avail: 'ok', muted: true, takeMute: false, solo: false, level: 80, monLevel: 50, input: 'scar:1', error: null, take: null, takeN: 0,
};
const song = { pos: 0, playing: false, tempo: 100, trans: 0 };
const stems = STEMS.map((s) => ({ ...s, mute: false, solo: false, level: 80 }));
let extra = []; // takes added as tracks

/* ---- icons ---- */
const SV = (b) => `<svg viewBox="0 0 16 16" aria-hidden="true">${b}</svg>`;
const ST = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
const ICON = {
  rec: SV('<circle cx="8" cy="8" r="4.2" fill="currentColor"/>'),
  gear: SV(`<circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path ${ST} d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2"/>`),
  speaker: SV(`<path d="M2 6h2.6L8 3v10L4.6 10H2z" fill="currentColor"/><path ${ST} d="M10.4 5.8a3.2 3.2 0 0 1 0 4.4M12.2 4a5.6 5.6 0 0 1 0 8"/>`),
  check: SV(`<path ${ST} d="M3 8.5l3.2 3.2L13 4.5"/>`),
  play: SV('<path d="M4.5 3v10l8-5z" fill="currentColor"/>'),
  playSong: SV('<path d="M2.5 3.5v9l6-4.5z" fill="currentColor"/><rect x="10.2" y="6.5" width="1.6" height="5" rx=".6" fill="currentColor"/><rect x="13" y="4" width="1.6" height="8" rx=".6" fill="currentColor"/>'),
  stop: SV('<rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor"/>'),
  add: SV(`<rect x="2.5" y="2.5" width="11" height="11" rx="2.4" ${ST}/><path ${ST} d="M8 5.2v5.6M5.2 8h5.6"/>`),
  trash: SV(`<path ${ST} d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.6 4.5l.6 8.5h5.6l.6-8.5"/>`),
};
const setBtn = (b, label, icon) => { b.title = label; b.setAttribute('aria-label', label); if (icon && b.dataset.ic !== icon) { b.dataset.ic = icon; b.innerHTML = ICON[icon]; } };

/* ---- helpers ---- */
const $ = (id) => document.getElementById(id);
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const sgn = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const announce = (t) => { $('live').textContent = ''; setTimeout(() => { $('live').textContent = t; }, 30); };
const monitoring = () => S.avail === 'ok' && !S.muted;
// Record is one press, like Play: only a real blocker (mic, input, error) disables it. A take in review is kept and a playing take stops.
const canPressRecord = () => S.perm === 'granted' && !S.inputMissing && !S.error;
const canRecord = () => S.perm === 'granted' && !S.inputMissing && !S.error && (S.phase === 'idle' || S.phase === 'armed');
const makePeaks = (n, seed, base = 0.5) => {
  const r = rng(seed); const out = []; let env = 0.4;
  for (let i = 0; i < n; i++) { if (i % 14 === 0) env = 0.15 + r() * 0.85 * base * 1.6; out.push(Math.min(1, env * (0.45 + r() * 0.55))); }
  return out;
};
stems.forEach((s) => { s.peaks = makePeaks(900, s.seed, s.density); });

/* ---- build static bits ---- */
const sel = $('inputSel');
function buildInputs() {
  sel.innerHTML = '';
  if (S.perm !== 'granted' || S.inputMissing) {
    const o = document.createElement('option'); o.textContent = S.perm !== 'granted' ? STR.inputPerm : STR.inputGroupNone; sel.append(o); return;
  }
  INPUTS.forEach((g) => { const og = document.createElement('optgroup'); og.label = g.group;
    g.opts.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; og.append(o); });
    sel.append(og); });
  sel.value = S.input;
}
const meterEl = $('meter');
const SEGS = 24;
for (let i = 0; i < SEGS; i++) { const s = document.createElement('i'); if (i >= 22) s.className = 'redz'; else if (i >= 17) s.className = 'hotz'; meterEl.append(s); }
const meterSegs = [...meterEl.children];
const ruler = $('ruler');
for (let t = 0; t <= LEN; t += 30) { const s = document.createElement('span'); s.style.left = `${(t / LEN) * 100}%`; s.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; ruler.append(s); }

function buildLanes() {
  const host = $('stems'); host.innerHTML = '';
  [...stems, ...extra].forEach((s) => {
    const row = document.createElement('section'); row.className = 'lane'; row.style.setProperty('--stem', s.color); row.dataset.id = s.id;
    row.setAttribute('aria-label', `${s.name} track`);
    row.innerHTML = `<div class="lane-controls"><div class="lane-title"><span class="lane-dot" aria-hidden="true"></span><h2 class="lane-name"></h2></div>
      <div class="lane-buttons"><button class="chip mute" type="button" aria-pressed="false">M</button><button class="chip solo" type="button" aria-pressed="false">S</button>
      <input class="vol" type="range" min="0" max="100" aria-label=""></div></div><div class="lane-wave"><canvas aria-hidden="true"></canvas></div>`;
    row.querySelector('.lane-name').textContent = s.name;
    const [m, so] = row.querySelectorAll('.chip'); const vol = row.querySelector('.vol');
    m.setAttribute('aria-label', `Mute ${s.name}`); so.setAttribute('aria-label', `Solo ${s.name}`); vol.setAttribute('aria-label', `${s.name} level`); vol.value = s.level;
    m.onclick = () => { s.mute = !s.mute; renderLanes(); };
    so.onclick = () => { s.solo = !s.solo; renderLanes(); };
    vol.oninput = () => { s.level = +vol.value; };
    row.querySelector('.lane-wave').onclick = (e) => seekFrom(e, e.currentTarget);
    host.append(row);
  });
  renderLanes(); drawLanes();
}
function renderLanes() {
  const anySolo = stems.some((s) => s.solo) || extra.some((s) => s.solo) || S.solo;
  document.querySelectorAll('.lane').forEach((row) => {
    const s = [...stems, ...extra].find((x) => x.id === row.dataset.id);
    const off = s.mute || (anySolo && !s.solo) || (S.listen === 'alone' && song.playing);
    row.classList.toggle('is-off', off);
    const [m, so] = row.querySelectorAll('.chip');
    m.classList.toggle('active', s.mute); m.setAttribute('aria-pressed', s.mute);
    so.classList.toggle('active', s.solo); so.setAttribute('aria-pressed', s.solo);
  });
}
function drawWave(canvas, peaks, color, from = 0, to = 1) {
  const r = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const c = canvas.getContext('2d'); c.clearRect(0, 0, w, h); c.fillStyle = color; c.globalAlpha = 0.9;
  const step = 3 * dpr, mid = h / 2;
  for (let x = from * w; x < to * w; x += step) {
    const p = peaks[Math.min(peaks.length - 1, Math.floor(((x / w - from) / Math.max(1e-6, to - from)) * (peaks.length - 1)))] || 0;
    const bh = Math.max(1.5 * dpr, p * h * 0.82); c.fillRect(x, mid - bh / 2, 2 * dpr, bh);
  }
}
function drawLanes() {
  document.querySelectorAll('.lane').forEach((row) => {
    const s = [...stems, ...extra].find((x) => x.id === row.dataset.id); const cv = row.querySelector('canvas');
    if (s.region) drawWave(cv, s.peaks, s.color, s.region[0] / LEN, s.region[1] / LEN); else drawWave(cv, s.peaks, s.color);
  });
}
const clipCv = $('clipWave');
function drawClip() { if (S.take) drawWave(clipCv, S.take.peaks.length ? S.take.peaks : [0.05], VOICE); }

/* ---- actions ---- */
function seekFrom(e, el) {
  if (S.phase === 'recording' || S.listen) return;
  const r = el.getBoundingClientRect(); song.pos = Math.max(0, Math.min(LEN, ((e.clientX - r.left) / r.width) * LEN)); render();
}
function startRecording() {
  if (!canPressRecord()) return; setClip(false); // one press: arms the input if needed and records
  if (S.listen) { S.listen = null; song.playing = false; }
  if (S.take) S.take.kept = true; // the previous take stays on disk
  S.take = { n: S.takeN + 1, start: song.pos, span: 0, real: 0, tempo: song.tempo, trans: song.trans, changed: false, kept: false, partial: false, peaks: [] };
  S.phase = 'recording'; song.playing = true; announce(STR.announce.recording); render();
}
function stopRecording() {
  S.takeN = S.take.n; S.phase = 'review'; song.playing = false; announce(STR.announce.review); render(); $('keepBtn').focus();
}
function stopListening() { S.listen = null; S.phase = 'review'; song.playing = false; render(); }
function listen(mode) {
  const t = S.take; song.pos = t.start; if (mode === 'song') { song.tempo = t.tempo; song.trans = t.trans; }
  S.listen = mode; S.phase = 'playing'; song.playing = true; render();
}
function discard() { S.take = null; S.phase = 'idle'; S.listen = null; S.error = null; announce(STR.announce.discarded); render(); $('recBtn').focus(); }
function addAsTrack() {
  const t = S.take; extra.push({ id: `take${t.n}`, name: `Voice take ${t.n}`, color: VOICE, mute: false, solo: false, level: 80, peaks: t.peaks, region: [t.start, t.start + t.span] });
  S.take = null; S.phase = 'idle'; S.listen = null; S.error = null; buildLanes(); announce(STR.announce.added(t.n)); render(); $('recBtn').focus();
}
function bump(kind, d) {
  if (kind === 'tempo') song.tempo = Math.max(50, Math.min(150, song.tempo + d)); else song.trans = Math.max(-12, Math.min(12, song.trans + d));
  if (S.phase === 'recording' && S.take) { S.take.tempo = song.tempo; S.take.trans = song.trans; S.take.changed = true; }
  render();
}

/* ---- render (state -> DOM) ---- */
function render() {
  const had = document.activeElement; const v = $('voice'); const rb0 = null; v.dataset.phase = S.phase;
  const rec = S.phase === 'recording', rv = S.phase === 'review', pl = S.phase === 'playing', armed = S.phase === 'armed';
  const needSetup = S.perm !== 'granted' || S.inputMissing;
  // input
  const wantKey = `${S.perm}|${S.inputMissing}`; if (sel.dataset.k !== wantKey) { sel.dataset.k = wantKey; buildInputs(); }
  sel.disabled = needSetup || rec || pl;
  // monitor / mute / solo / arm / level
  const mon = $('monBtn'); const unav = S.avail !== 'ok'; const on = monitoring();
  mon.classList.toggle('active', on); mon.setAttribute('aria-pressed', on); mon.setAttribute('aria-disabled', unav);
  setBtn(mon, unav ? (S.avail === 'latency' ? STR.latencyUnavailable : STR.routeUnavailable) : on ? STR.monOnTitle : STR.monOffTitle, 'speaker');
  if (!unav) mon.setAttribute('aria-label', on ? STR.monOnAria : STR.monOffAria);
  const mt = $('muteBtn'); mt.classList.toggle('active', S.takeMute); mt.setAttribute('aria-pressed', S.takeMute); setBtn(mt, S.takeMute ? STR.unmuteAria : STR.muteAria);
  $('soloBtn').classList.toggle('active', S.solo); $('soloBtn').setAttribute('aria-pressed', S.solo); setBtn($('soloBtn'), STR.soloAria);
  const ab = $('armBtn'); ab.classList.toggle('active', armed || rec); ab.setAttribute('aria-pressed', armed || rec); setBtn(ab, armed ? STR.disarmAria : STR.armAria, 'rec');
  ab.disabled = !(canRecord());
  if (ab.disabled) ab.title = rec ? 'Recording. Stop first to change arm' : (S.perm !== 'granted' ? STR.recWhy.perm : S.inputMissing ? STR.recWhy.missing : S.error ? STR.recWhy.error : STR.recWhy.take);
  // The fader edits the monitor level while the speaker is on, the take playback level otherwise.
  $('levelRng').value = on ? S.monLevel : S.level; $('levelRng').setAttribute('aria-label', on ? STR.monitorLevel : STR.voiceLevel); $('levelRng').title = on ? STR.monitorLevel : STR.voiceLevel;
  // transport record
  const rb = $('recBtn'); rb.disabled = !(canPressRecord() || rec); rb.classList.toggle('armed', armed); rb.classList.toggle('recording', rec);
  const why = S.perm !== 'granted' ? STR.recWhy.perm : S.inputMissing ? STR.recWhy.missing : S.error ? STR.recWhy.error : '';
  setBtn(rb, rec ? STR.stopTitle : rb.disabled ? why : STR.recordTitle); rb.setAttribute('aria-pressed', rec);
  $('recTime').textContent = rec ? fmt(S.take.real) : '';
  // latency badge
  const bd = $('latBadge');
  if (S.avail === 'ok' && !S.muted) { bd.hidden = false; bd.className = 'badge ok'; bd.textContent = STR.badgeOk(12); bd.title = STR.badgeTitleOk; }
  else if (S.avail === 'latency') { bd.hidden = false; bd.className = 'badge warn'; bd.textContent = STR.badgeLatency; bd.title = STR.badgeTitleLatency; }
  else if (S.avail === 'route') { bd.hidden = false; bd.className = 'badge warn'; bd.textContent = STR.badgeRoute; bd.title = STR.badgeTitleRoute; }
  else bd.hidden = true;
  renderMsg();
  const live = armed || rec || monitoring(); meterEl.classList.toggle('live', live); if (!live) resetMeter();
  // clip + empty hint
  const t = S.take; const clip = $('clip'); clip.hidden = !t;
  const empty = $('voiceEmpty'); empty.hidden = !!t;
  empty.textContent = S.perm !== 'granted' ? STR.emptyPerm : S.inputMissing ? STR.emptyMissing : armed ? STR.emptyArmed : STR.emptyIdle;
  if (t) {
    clip.classList.toggle('recording', rec); clip.classList.toggle('partial', t.partial); clip.classList.toggle('playing', pl);
    const tag = $('clipTag'); tag.textContent = STR.tag(t.tempo, sgn(t.trans), t.changed); tag.classList.toggle('changed', t.changed || t.tempo !== 100 || t.trans !== 0);
    tag.title = t.changed ? STR.tagTitleChanged : STR.tagTitle; placeClip(); drawClip();
  }
  // take actions (icon buttons in the lane header)
  const tb = $('takebar'); tb.hidden = !t || rec; $('takeInfo').hidden = !t;
  if (t) {
    $('takeInfo').textContent = rec ? STR.recordingInfo(fmt(t.real)) : STR.takeInfo(t.n, fmt(t.real), t.partial ? ' · partial' : '');
    setBtn($('keepBtn'), t.kept ? STR.kept : STR.keep, 'check'); $('keepBtn').hidden = pl; $('keepBtn').disabled = t.kept; $('keepBtn').classList.toggle('primary', !t.kept);
    setBtn($('listenBtn'), pl ? STR.stopListening : STR.listen, pl ? 'stop' : 'play'); $('listenBtn').hidden = pl && S.listen === 'song'; $('listenBtn').classList.toggle('on', pl && S.listen === 'alone');
    setBtn($('listenSongBtn'), pl ? STR.stopListeningSong : STR.listenSong, pl ? 'stop' : 'playSong'); $('listenSongBtn').hidden = pl && S.listen === 'alone'; $('listenSongBtn').classList.toggle('on', pl && S.listen === 'song');
    setBtn($('addBtn'), STR.add, 'add'); $('addBtn').hidden = pl; setBtn($('discardBtn'), STR.discard, 'trash'); $('discardBtn').hidden = pl;
  }
  // transport
  $('playBtn').textContent = song.playing ? '❚❚' : '▶'; $('playBtn').setAttribute('aria-label', song.playing ? STR.pauseLabel : STR.playLabel);
  $('trOut').innerHTML = `${sgn(song.trans)} <small>st</small>`; $('tpOut').innerHTML = `${song.tempo} <small>%</small>`;
  tickUi();
  renderLanes();
  if (had && had !== document.body && (had.hidden || had.closest('[hidden]') || had.offsetParent === null)) (rb.disabled ? $('playBtn') : rb).focus();
}
let noteKey = '';
function renderMsg() {
  const m = $('msg'); const parts = []; let cls = ''; let btnTxt = null, btnFn = null;
  if (S.error) { cls = 'err'; parts.push(STR.errorText); btnTxt = STR.retry; btnFn = () => { S.error = null; S.inputMissing = false; announce(STR.announce.retried); render(); }; }
  else if (S.perm !== 'granted') { cls = 'warn'; parts.push(STR.permNeeded); btnTxt = STR.permBtn; btnFn = () => { S.perm = 'granted'; announce(STR.announce.granted); render(); }; }
  else if (S.inputMissing) { cls = 'warn'; parts.push(STR.inputMissing); btnTxt = STR.inputBtn; btnFn = () => { S.inputMissing = false; announce(STR.announce.found); render(); }; }
  else if (S.avail !== 'ok') { cls = 'warn'; parts.push(S.avail === 'latency' ? STR.latencyUnavailable : STR.routeUnavailable); }
  else if (S.phase === 'recording') parts.push(STR.msgRecording);
  else if (S.phase === 'playing') parts.push(S.listen === 'alone' ? STR.msgListenAlone : `${STR.msgListenSong} (${S.take.tempo}% \u00b7 ${sgn(S.take.trans)})`);
  else if (S.phase === 'review') parts.push(STR.msgReview);
  else if (monitoring()) parts.push(STR.msgMonitoring);
  const key = cls + parts.join() + btnTxt; if (key === noteKey) return; noteKey = key;
  m.className = `note ${cls}`; m.innerHTML = '';
  if (parts[0]) { const s = document.createElement('span'); s.textContent = parts[0]; s.title = parts[0]; m.append(s); }
  if (btnTxt) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = btnTxt; b.onclick = btnFn; m.append(b); }
}
function placeClip() {
  const t = S.take; if (!t) return; const c = $('clip');
  c.style.left = `${(t.start / LEN) * 100}%`; c.style.width = `${Math.max(0.3, (t.span / LEN) * 100)}%`;
}
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let peakV = 0, peakAge = 0, clipped = false, lastMeterPaint = 0;
const toDb = (v) => Math.round(-60 + v * 60);
function setClip(on) {
  clipped = on; const led = $('clipLed'); led.classList.toggle('on', on);
  setBtn(led, on ? STR.clipOn : STR.clipOff);
}
function setMeter(v, dt = 0) {
  v = Math.max(0, Math.min(1, v));
  if (v >= peakV) { peakV = v; peakAge = 0; } else { peakAge += dt; if (peakAge > 1.2) peakV = Math.max(v, peakV - dt * 0.35); }
  if (v >= 0.998) setClip(true); // full scale, >= -0.1 dBFS
  const n = Math.round(v * SEGS), pk = Math.min(SEGS - 1, Math.round(peakV * SEGS) - 1);
  meterSegs.forEach((s, i) => { const hz = s.classList.contains('hotz') ? ' hotz' : s.classList.contains('redz') ? ' redz' : ''; const z = s.className.replace(/\b(on|peak)\b/g, '').trim(); s.className = `${z}${i < n ? ' on' : ''}${i === pk && peakV > 0.02 ? ' peak' : ''}`.trim(); });
  const live = v > 0 || peakV > 0;
  const tip = live ? STR.levelTip(toDb(v), toDb(peakV)) : STR.levelNone;
  meterEl.title = tip; meterEl.setAttribute('aria-valuenow', toDb(v)); meterEl.setAttribute('aria-valuetext', tip);
}
function resetMeter() { peakV = 0; peakAge = 0; setMeter(0); }
function tickUi() {
  $('playhead').style.left = `${(song.pos / LEN) * 100}%`; $('timeNow').textContent = fmt(song.pos);
}

/* ---- animation loop ---- */
let last = performance.now(), peakAcc = 0, meterT = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (song.playing) {
    song.pos += dt * (song.tempo / 100);
    if (S.phase === 'recording') {
      const t = S.take; t.real += dt; t.span = song.pos - t.start; peakAcc += dt;
      while (peakAcc > 0.05) { peakAcc -= 0.05; t.peaks.push(0.15 + Math.abs(Math.sin(t.real * 3.1)) * 0.5 * Math.random() + Math.random() * 0.3); }
      placeClip(); drawClip(); $('recTime').textContent = fmt(t.real); $('takeInfo').textContent = STR.recordingInfo(fmt(t.real));
    }
    if (S.phase === 'playing' && song.pos >= S.take.start + S.take.span) { song.pos = S.take.start + S.take.span; stopListening(); }
    if (song.pos >= LEN) { song.pos = LEN; if (S.phase === 'recording') stopRecording(); else { song.playing = false; render(); } }
    tickUi();
  }
  if (meterEl.classList.contains('live')) {
    meterT += dt; const talk = Math.max(0, Math.sin(meterT * 2.3)) * (0.5 + 0.5 * Math.sin(meterT * 0.7));
    if (!reduceMotion.matches || now - lastMeterPaint > 250) {
      lastMeterPaint = now;
      let v = 0.1 + talk * 0.55 + Math.random() * 0.2 * (talk > 0.1 ? 1 : 0.2);
      if (Math.random() < (reduceMotion.matches ? 0.02 : 0.004)) v = 1; // rare simulated spike so the clip latch can be seen
      setMeter(v, reduceMotion.matches ? 0.25 : dt);
    }
  }
  requestAnimationFrame(frame);
}

/* ---- wiring ---- */
$('playBtn').onclick = () => { if (S.phase === 'recording') return; if (S.listen) stopListening(); song.playing = !song.playing; render(); };
$('rewBtn').onclick = () => { if (S.phase === 'recording') return; song.pos = 0; render(); };
$('tpDn').onclick = () => bump('tempo', -5); $('tpUp').onclick = () => bump('tempo', 5);
$('trDn').onclick = () => bump('trans', -1); $('trUp').onclick = () => bump('trans', 1);
ruler.onclick = (e) => seekFrom(e, ruler);
$('voiceTrack').onclick = (e) => { if (e.target.closest('.clip')) return; seekFrom(e, $('voiceTrack')); };
$('monBtn').onclick = () => { if (S.avail !== 'ok') return; S.muted = !S.muted; announce(S.muted ? STR.announce.monOff : STR.announce.monOn); render(); };
$('muteBtn').onclick = () => { S.takeMute = !S.takeMute; render(); };
$('soloBtn').onclick = () => { S.solo = !S.solo; render(); };
// Track settings popup: Esc and Done close it and focus returns to the gear.
const setModal = $('setModal');
setBtn($('gearBtn'), 'Track settings', 'gear');
const openSettings = () => { setModal.hidden = false; $('gearBtn').setAttribute('aria-expanded', 'true'); $('setMon').focus(); updateSettings(); };
const closeSettings = () => { setModal.hidden = true; $('gearBtn').setAttribute('aria-expanded', 'false'); $('gearBtn').focus(); };
function updateSettings() {
  $('setMon').value = S.monLevel; $('setMonOut').textContent = `${Math.round(S.monLevel * 0.72 - 60)} dB`;
  $('setTake').value = S.level; $('setTakeOut').textContent = `${S.level}%`;
  $('setRoute').textContent = monitoring() ? 'Route: Scarlett 2i2 · buffer 32 frames · estimated delay ≈ 5 ms' : 'Route: shown while monitoring.';
}
$('gearBtn').onclick = openSettings; $('setDone').onclick = closeSettings;
setModal.onclick = (e) => { if (e.target === setModal) closeSettings(); };
$('setMon').oninput = (e) => { S.monLevel = +e.target.value; render(); updateSettings(); };
$('setTake').oninput = (e) => { S.level = +e.target.value; render(); updateSettings(); };
$('setOut').onchange = () => {
  $('setNote').textContent = monitoring() ? 'Switching the monitor output…' : '';
  if (monitoring()) setTimeout(() => { $('setNote').textContent = ''; }, 800);
};
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !setModal.hidden) { e.stopPropagation(); closeSettings(); } }, true);
$('armBtn').onclick = () => { if (!canRecord()) return; S.phase = S.phase === 'armed' ? 'idle' : 'armed'; if (S.phase === 'armed') setClip(false); announce(S.phase === 'armed' ? STR.announce.armed : STR.announce.disarmed); render(); };
$('clipLed').onclick = () => { setClip(false); announce('Clip indicator reset'); };
$('levelRng').oninput = (e) => { if (monitoring()) S.monLevel = +e.target.value; else S.level = +e.target.value; };
sel.onchange = () => { S.input = sel.value; };
$('recBtn').onclick = () => (S.phase === 'recording' ? stopRecording() : startRecording());
$('keepBtn').onclick = () => { S.take.kept = true; announce(STR.announce.kept); render(); };
$('listenBtn').onclick = () => (S.phase === 'playing' ? stopListening() : listen('alone'));
$('listenSongBtn').onclick = () => (S.phase === 'playing' ? stopListening() : listen('song'));
$('addBtn').onclick = addAsTrack; $('discardBtn').onclick = discard;

/* ---- prototype state switcher ---- */
const proto = $('proto'), list = $('protoList'); let current = 'idle'; let opener = null;
STR.states.forEach((id) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = id; b.dataset.state = id; b.setAttribute('aria-pressed', 'false'); b.onclick = () => forceState(id); list.append(b); });
function reset() {
  Object.assign(S, { takeMute: false, perm: 'granted', inputMissing: false, phase: 'idle', listen: null, avail: 'ok', muted: true, error: null, take: null });
  Object.assign(song, { pos: 12, playing: false, tempo: 100, trans: 0 });
}
const sampleTake = (o) => ({ n: 1, start: 30, span: 34, real: 34, tempo: 100, trans: 0, changed: false, kept: false, partial: false, peaks: makePeaks(220, 5, 0.5), ...o });
function forceState(id) {
  reset(); current = id;
  switch (id) {
    case 'input-missing': S.inputMissing = true; break;
    case 'permission-needed': S.perm = 'needed'; break;
    case 'armed': S.phase = 'armed'; song.pos = 30; break;
    case 'recording': { S.phase = 'recording'; song.playing = true; song.pos = 42.4; S.take = sampleTake({ span: 12.4, real: 12.4, peaks: makePeaks(250, 9, 0.5) }); break; }
    case 'take-review': song.tempo = 80; song.trans = -2; S.take = sampleTake({ real: 34, span: 27.2, tempo: 80, trans: -2 }); S.phase = 'review'; song.pos = 57.2; break;
    case 'playing-take': S.take = sampleTake({}); S.phase = 'playing'; S.listen = 'alone'; song.playing = true; song.pos = 41; break;
    case 'monitoring-on': S.muted = false; song.playing = true; song.pos = 24; break;
    case 'monitoring-unavailable-latency': S.avail = 'latency'; song.playing = true; song.pos = 24; break;
    case 'monitoring-unavailable-route': S.avail = 'route'; song.playing = true; song.pos = 24; break;
    case 'error-recoverable': S.error = true; S.phase = 'review'; S.take = sampleTake({ real: 12, span: 12, partial: true }); song.pos = 42; break;
    default: break;
  }
  sel.dataset.k = ''; render(); markProto();
}
function markProto() { list.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.state === current)); }
function toggleProto(force) {
  const open = force ?? proto.hidden; proto.hidden = !open;
  if (open) { opener = document.activeElement; (list.querySelector('[aria-pressed="true"]') || list.firstChild).focus(); }
  else if (opener && opener !== document.body) opener.focus();
}
$('protoClose').onclick = () => toggleProto(false);
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  if ((e.key === '`' || (e.altKey && e.code === 'KeyP')) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); toggleProto(); }
  else if (e.key === 'Escape' && !proto.hidden) toggleProto(false);
  else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && !typing && !e.repeat) { e.preventDefault(); $('recBtn').click(); }
  else if (e.key === ' ' && !typing && e.target.tagName !== 'BUTTON') { e.preventDefault(); $('playBtn').click(); }
});

/* ---- init ---- */
new ResizeObserver(() => { drawLanes(); drawClip(); }).observe($('mixer'));
reset(); noteKey = '~'; buildInputs(); buildLanes(); render(); markProto();
if (location.hash.slice(1) && STR.states.includes(location.hash.slice(1))) forceState(location.hash.slice(1));
requestAnimationFrame(frame);
setClip(false);
window.__voiceStrip = { setClip, forceState, S, song };
})();
