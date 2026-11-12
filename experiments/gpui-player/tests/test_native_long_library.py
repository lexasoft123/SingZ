"""Hidden muted native long songs and a large library (Q-14; budgets N9, N10, N11).

Generates its fixtures in a scratch folder (synthetic mono WAV stems, nothing
committed) and drives the app's `ui-tests` hook (src/ui_long_library.rs), one launch
per stage:

  songs    a 12-minute and a 60-minute six-lane song: open, play, seek near the end,
           loop near the end, play out, waveform and timeline (f64, C-13); the 60-minute
           song also takes a full-rate pan/zoom/resize burst under playback (N11)
  cycles   20 open/close cycles, the 12- and the 60-minute song alternating (N10)
  library  a 200-project library: catalog load, wheel scroll, typed search, card open
  exfat    the same library, plus the 12-minute song, on an ExFAT volume made here with
           hdiutil (detached and deleted at the end)
  smb      the same on a mounted SMB share, only when --smb-root names one

Memory (N9, N10) is sampled from outside: at each phase the app writes marks/<name>.ready
and holds; this driver sums the footprint of the app and every descendant (the audio
helper), then writes marks/<name>.ack.

Run on a qualify build with the helper next to it:
  cargo build --profile qualify --features ui-tests
  python3 test_native_long_library.py target/qualify/singz-gpui-player /tmp/evidence
Hidden and muted. Every launch has a deadline, so does the whole driver.
"""
import argparse
import atexit
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave

TOTAL_DEADLINE = 2400.0
LAUNCH_DEADLINES = {'songs': 900.0, 'cycles': 400.0, 'library': 240.0}

# --- Budgets. Never raise one to make a run pass; find the cause. -------------------------
# Open: the Q-05 per-step budget (2x its worst measured open of the six-lane sample). A
# song's length must not show in it: streamed lanes are opened, not decoded.
OPEN_BUDGET_MS = 1800.0
# N9. The Electron all-process total is recorded by Q-01 (plan/Q-01-electron-baseline.json),
# which does not exist yet, so the comparison with Electron cannot be asserted here. What
# this driver proves instead is the property that makes the budget hold for any length:
# a 60-minute song costs no more memory than a 12-minute one (streamed, nothing buffered).
LENGTH_GROWTH_MB = 32.0
# N10: no growth across the cycles. Slope over cycles WARMUP..end of the tree footprint.
CYCLE_WARMUP = 4
STEADY_SECONDS = 20.0   # playing time before the steady footprint is sampled (N9)
CYCLE_SLOPE_MB_PER_CYCLE = 1.0
# N11: starvedBlocks == 0 on every lane, absolute.
# Library (200 projects). N2/N4 at the interim 60 Hz target: one refresh period.
FRAME_BUDGET_MS = 16.7
# MEASURED (local APFS and ExFAT, 200 projects): catalog reload 29-33 ms local, 76-83 ms ExFAT, the first
# load on ExFAT 184 ms. Budget = 2x the worst measured value, rounded up.
LIBRARY_LOAD_BUDGET_MS = 400.0
# MEASURED: 60-minute six-lane song, waveform complete 1.0 s after the open request on a quiet machine and up to 3.7 s
# under load (12 min: 0.3 s). Budget = 2x the worst, because the machine is shared.
WAVEFORM_READY_BUDGET_MS = 8000.0

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
parser.add_argument('--stages', default='songs,cycles,library,exfat',
                    help='comma list of songs,cycles,library,exfat,smb,mounted (mounted needs --library-root)')
parser.add_argument('--scratch', type=Path, default=None, help='fixture folder (default: a fresh temporary one)')
parser.add_argument('--smb-root', type=Path, default=None, help='a writable folder on a mounted SMB share')
parser.add_argument('--minutes', default='12,60', help='long-song lengths in minutes')
parser.add_argument('--burst-seconds', type=float, default=60.0)
parser.add_argument('--projects', type=int, default=200)
parser.add_argument('--library-root', type=Path, default=None,
                    help='an already-populated, already-mounted library of projects named "Library project 0001"... (as the library stage makes them; stage mounted, e.g. an SMB share). Used as found')
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
REPO = Path(__file__).resolve().parents[3]
stages = [s for s in args.stages.split(',') if s]
minutes = [int(m) for m in args.minutes.split(',')]
started = time.monotonic()
children, cleanups = [], []


def remaining():
    return TOTAL_DEADLINE - (time.monotonic() - started)


def kill_children():
    for child in children:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def run_cleanups():
    kill_children()
    while cleanups:
        try:
            cleanups.pop()()
        except Exception as error:  # a cleanup must not hide the real failure
            print('cleanup failed:', error, file=sys.stderr)


atexit.register(run_cleanups)
for sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, lambda *_: sys.exit(130))

spec = importlib.util.spec_from_file_location('interface_perf', Path(__file__).with_name('interface-perf.py'))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)
helper = app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')
assert helper.is_file(), f'build the audio helper next to the app: {helper}'
contract = (REPO / 'src/renderer/src/audio/analysis-contract.ts').read_text()
version_of = lambda name: int(contract.split(f'export const {name} = ', 1)[1].splitlines()[0].strip())
BEAT_VERSION, KEY_VERSION = version_of('BEAT_DETECT_VERSION'), version_of('KEY_DETECT_VERSION')
RATE = 16000
LANES = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']
TAIL_LANES = {'vocals', 'bass'}   # these carry a loud last TAIL seconds: the waveform must show it at the end
TAIL_SECONDS = 30


# --- fixtures ------------------------------------------------------------------------------
def tone(frequency, amplitude, seconds):
    count = int(RATE * seconds)
    return b''.join(struct.pack('<h', round(amplitude * 32767 * __import__('math').sin(i * 6.283185307179586 * frequency / RATE)))
                    for i in range(count))


def write_wav(path, seconds, frequency, tail):
    path.parent.mkdir(parents=True, exist_ok=True)
    quiet, loud = tone(frequency, .05, 1), tone(frequency, .6, 1)
    with wave.open(str(path), 'wb') as stream:
        stream.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
        for second in range(seconds):
            stream.writeframes(loud if tail and second >= seconds - TAIL_SECONDS else quiet)


def project_json(name, seconds, lanes):
    beats = [i * .5 for i in range(int(seconds * 2) + 1)]
    downbeats = list(range(0, int(seconds * 2) + 1, 4))
    return {'version': 2, 'name': name, 'savedAt': '2026-11-07T12:00:00Z', 'settings': {
        'tempo': 1, 'transpose': 0, 'masterVolume': .8, 'loop': False, 'selection': None,
        'tracks': {lane: {'volume': .8, 'muted': False, 'solo': False} for lane in lanes},
        'beat': {'beats': beats, 'bpm': 120, 'beatsPerBar': 4, 'downbeat': 0, 'downbeats': downbeats,
                 'autoDownbeats': downbeats, 'source': 'auto', 'detVersion': BEAT_VERSION},
        'key': {'pc': 9, 'minor': False, 'detVersion': KEY_VERSION},
        'melody': {'detVersion': 4, 'hopSec': .01, 'f0': ' '.join(['2400'] * (int(seconds / .01) + 1))},
        'metronome': {'click': False, 'countInBars': 0, 'volume': .3, 'accent': True, 'grid': False}}}


def lyrics_json(seconds):
    lines = [{'start': t, 'end': t + 4, 'text': f'Words {t}', 'words': [
        {'w': 'Words', 's': t, 'e': t + 1.5}, {'w': str(t), 's': t + 2, 'e': t + 3.5}]} for t in range(0, seconds - 5, 6)]
    return {'source': 'edited', 'credit': 'fixture', 'lines': lines}


def make_song(root, name, seconds):
    folder = root / name
    for index, lane in enumerate(LANES):
        write_wav(folder / 'stems' / f'{lane}.wav', seconds, 110 * (index + 1), lane in TAIL_LANES)
    (folder / 'project.json').write_text(json.dumps(project_json(name, seconds, LANES)))
    (folder / 'lyrics.json').write_text(json.dumps(lyrics_json(seconds)))
    return folder


def make_library(root, count):
    """`count` small two-stem projects; `Library project 0150` is the only one whose name holds '0150'."""
    root.mkdir(parents=True, exist_ok=True)
    template = Path(tempfile.mkdtemp(prefix='singz-library-template-'))  # never beside the library: ExFAT adds ._ files
    write_wav(template / 'vocals.wav', 10, 220, False)
    shutil.copyfile(template / 'vocals.wav', template / 'bass.wav')
    for number in range(1, count + 1):
        name = f'Library project {number:04d}'
        folder = root / name
        (folder / 'stems').mkdir(parents=True)
        for lane in ('vocals', 'bass'):
            shutil.copyfile(template / f'{lane}.wav', folder / 'stems' / f'{lane}.wav')
        raw = project_json(name, 10, ['vocals', 'bass'])
        raw['savedAt'] = f'2026-10-{1 + number % 28:02d}T{number % 24:02d}:00:00Z'
        (folder / 'project.json').write_text(json.dumps(raw))
        if number % 2:
            (folder / 'lyrics.json').write_text(json.dumps(lyrics_json(10)))
    shutil.rmtree(template)


def inventory(folder):
    return {str(p.relative_to(folder)): (p.stat().st_size, p.stat().st_mtime_ns) for p in sorted(folder.rglob('*')) if p.is_file()}


# --- launching and memory sampling -----------------------------------------------------------
def tree_footprint(pid):
    table = subprocess.run(['ps', '-axo', 'pid=,ppid='], capture_output=True, text=True, timeout=10).stdout.split()
    parents = dict(zip(map(int, table[0::2]), map(int, table[1::2])))
    members, grew = {pid}, True
    while grew:
        grew = False
        for child, parent in parents.items():
            if parent in members and child not in members:
                members.add(child)
                grew = True
    parts = {}
    for member in members:
        try:
            parts[member] = perf.process_usage(member)[1]
        except OSError:
            pass
    return sum(parts.values()), parts


def launch(stage, plan, folder, library_root, prefs, deadline, extra=None):
    folder.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(folder / 'marks', ignore_errors=True)
    for name in ('result.json', 'failure.txt'):
        (folder / name).unlink(missing_ok=True)
    prefs.mkdir(parents=True, exist_ok=True)
    # qualify builds open What's new automatically unless this version is acknowledged
    (prefs / 'release-highlights.json').write_text(json.dumps(
        {'version': 1, 'releaseNotesSeen': json.loads((REPO / 'package.json').read_text())['version']}))
    environment = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ('SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS')}
    environment.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
                       SINGZ_GPUI_CONFIG_DIR=str(prefs), SINGZ_GPUI_PROJECTS_ROOT=str(library_root),
                       SINGZ_PACK_DIR=str(prefs / 'missing-pack'), SINGZ_MODELS_DIR=str(prefs / 'missing-models'),
                       SINGZ_GPUI_LONG_LIBRARY_TEST=str(folder), SINGZ_GPUI_LONG_STAGE=stage, SINGZ_GPUI_LONG_PLAN=json.dumps(plan))
    environment.update(extra or {})
    assert remaining() > 0, 'total deadline expired before ' + stage
    marks, samples, stop = folder / 'marks', {}, threading.Event()
    with (folder / 'app.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    children.append(child)

    def sampler():
        while not stop.is_set():
            for ready in sorted(marks.glob('*.ready')) if marks.is_dir() else []:
                name = ready.stem
                if name in samples:
                    continue
                total, parts = tree_footprint(child.pid)
                samples[name] = {'footprintBytes': total, 'processes': len(parts), 'perProcessBytes': {str(k): v for k, v in parts.items()},
                                 'markEpoch': float(ready.read_text() or 0)}
                if name in os.environ.get('SINGZ_LONG_MALLOC_HISTORY', '').split(','):  # diagnosis aid: needs MallocStackLogging=1 in the environment
                    with (folder / f'malloc-history-{name}.txt').open('w') as dump:
                        subprocess.run(['malloc_history', str(child.pid), '-callTree', '-collapseRecursion'], stdout=dump, stderr=subprocess.STDOUT, timeout=600)
                if os.environ.get('SINGZ_LONG_VMMAP'):  # diagnosis aid: which memory region grows
                    with (folder / f'vmmap-{name}.txt').open('w') as dump:
                        subprocess.run(['vmmap', '-summary', str(child.pid)], stdout=dump, stderr=subprocess.DEVNULL, timeout=60)
                (marks / f'{name}.ack').write_text('ok')
            stop.wait(.02)
    worker = threading.Thread(target=sampler, daemon=True)
    worker.start()
    begun = time.monotonic()
    try:
        child.wait(timeout=max(min(deadline, remaining()), 1))
    except subprocess.TimeoutExpired:
        kill_children()
        raise AssertionError(f'{stage} launch exceeded {deadline:.0f}s or the total deadline; killed. Marks so far: {sorted(samples)}')
    finally:
        stop.set()
        worker.join(timeout=5)
        try:
            os.killpg(child.pid, signal.SIGKILL)  # stragglers in the group
        except (ProcessLookupError, PermissionError):
            pass
    failure = (folder / 'failure.txt').read_text() if (folder / 'failure.txt').exists() else None
    assert failure is None and child.returncode == 0 and (folder / 'result.json').is_file(), \
        failure or (folder / 'app.log').read_text()[-4000:]
    (folder / 'footprints.json').write_text(json.dumps(samples, indent=2))
    return samples, time.monotonic() - begun


def mb(value):
    return value / 1048576


def zero_starvation(where, lanes):
    assert lanes, (where, 'no lane streaming counters reported')
    for lane in lanes:
        assert lane['streamed'] is True, (where, 'lane not streamed', lane)
        assert lane['starvedBlocks'] == 0, (where, 'N11: starvedBlocks != 0', lane)


def judge_open(where, steps):
    for name in ('identity', 'ready', 'duration', 'graph'):
        if name in steps:
            assert steps[name] <= OPEN_BUDGET_MS, (where, f'open step {name} took {steps[name]:.0f} ms, budget {OPEN_BUDGET_MS:.0f} ms', steps)
    assert steps['identity'] <= steps['ready'] <= steps['graph'] + 1e-6, (where, 'open steps out of order', steps)


def judge_song(record, seconds, folder):
    label = record['label']
    assert abs(record['duration'] - seconds) < 0.05, (label, 'timeline duration', record['duration'], seconds)
    assert record['viewAtOpen'] == [0.0, 1.0], (label, 'whole song not in view at open', record['viewAtOpen'])
    assert record['lanes'] == len(LANES), (label, record['lanes'])
    judge_open(label, record['open'])
    assert record['waveformReadyMs'] <= WAVEFORM_READY_BUDGET_MS, (label, 'waveform took too long', record['waveformReadyMs'])
    # waveform: the loud last TAIL seconds sit at the end of the whole-song envelope, in every tail lane
    fraction = (seconds - TAIL_SECONDS) / seconds
    seen = {}
    for lane in record['waveform']:
        assert lane['len'] > 1 and lane['max'] > 0, (label, 'empty waveform lane', lane)
        seen[lane['slot']] = lane
    assert len(seen) == len(LANES), (label, 'waveform lanes', record['waveform'])
    tails = [lane for lane in record['waveform'] if lane['halfMaxFraction'] > 0]
    assert len(tails) == len(TAIL_LANES), (label, 'tail lanes', record['waveform'])
    for lane in tails:
        assert abs(lane['halfMaxFraction'] - fraction) < 0.01, (label, 'waveform tail is not at the end of the song', lane, fraction)
        assert lane['bodyMax'] < 0.5 * lane['max'], (label, 'waveform body is not quieter than its tail', lane)
    zero_starvation((label, 'after play'), record['afterPlay']['starved'])
    assert record['afterPlay']['position'] > 3, (label, record['afterPlay'])
    seek = record['seekNearEnd']
    assert 1.4 < seek['to'] - seek['from'] < 3.0, (label, 'position did not follow the near-end seek in real time', seek)
    assert seek['to'] <= seconds + 0.05 and abs(seek['nativePosition'] - seek['to']) < 1.5, (label, 'near-end seek position', seek)
    zero_starvation((label, 'near-end seek'), seek['starved'])
    loop = record['loopNearEnd']
    assert abs(loop['reported'][0] - loop['start']) < 0.002 and abs(loop['reported'][1] - loop['end']) < 0.002, (label, 'loop near the end', loop)
    assert loop['laps'] >= 2, (label, loop)
    zero_starvation((label, 'loop near the end'), loop['starved'])
    assert record['zoomedEndFrameMs']['p99'] <= FRAME_BUDGET_MS * 3, (label, 'zoomed end frame', record['zoomedEndFrameMs'])
    if 'burst' in record:
        burst = record['burst']
        assert burst['playing'] and burst['frames']['count'] > 100, (label, burst)
        zero_starvation((label, 'pan/zoom/resize burst'), burst['starved'])
    out_ = record['playedOut']
    assert out_['position'] >= seconds - 0.25 and abs(out_['nativeDuration'] - seconds) < 0.05, (label, 'play-out', out_)
    zero_starvation((label, 'play-out'), out_['starved'])


# --- stages --------------------------------------------------------------------------------------
summary = {'budgets': {'openMs': OPEN_BUDGET_MS, 'lengthGrowthMB': LENGTH_GROWTH_MB, 'cycleSlopeMBPerCycle': CYCLE_SLOPE_MB_PER_CYCLE,
                       'frameMs': FRAME_BUDGET_MS, 'libraryLoadMs': LIBRARY_LOAD_BUDGET_MS}, 'stages': {}}
scratch_holder = None
if args.scratch:
    scratch = args.scratch.resolve()
    scratch.mkdir(parents=True, exist_ok=True)
else:
    scratch_holder = tempfile.TemporaryDirectory(prefix='singz-long-library-')
    scratch = Path(scratch_holder.name).resolve()
    cleanups.append(scratch_holder.cleanup)


def library_stage(label, library_root, folder, prefs):
    count = args.projects
    chosen = 150 if count >= 150 else count
    match_title = f'Library project {chosen:04d}'
    before = inventory(library_root)
    plan = {'projects': len(list(p for p in library_root.iterdir() if (p / 'project.json').is_file())), 'query': f'{chosen:04d}',
            'matchTitle': match_title, 'matchDir': str(library_root / match_title), 'idleFrames': int(os.environ.get('SINGZ_LONG_IDLE_FRAMES', 30)),
            'typingDelayMs': int(os.environ.get('SINGZ_LONG_TYPING_DELAY_MS', 0)),
            'typingCycles': int(os.environ.get('SINGZ_LONG_TYPING_CYCLES', 0))}
    assert plan['projects'] >= count, (label, 'library fixture missing', plan)
    samples, wall = launch('library', plan, folder, library_root, prefs, LAUNCH_DEADLINES['library'])
    record = json.loads((folder / 'library.json').read_text())
    assert record['expectedProjects'] == plan['projects'], record
    assert all(ms <= LIBRARY_LOAD_BUDGET_MS for ms in record['reloadMs']) and record['initialLoadFromHookMs'] <= LIBRARY_LOAD_BUDGET_MS, (label, 'library load', record['reloadMs'], record['initialLoadFromHookMs'])
    scroll = record['scroll']
    assert scroll['reachedBottom'] and scroll['returnedTop'], (label, 'scroll did not reach both ends', scroll)
    assert scroll['frameMs']['p99'] <= FRAME_BUDGET_MS, (label, f"scroll frame p99 {scroll['frameMs']['p99']:.1f} ms over {FRAME_BUDGET_MS} ms", scroll['frameMs'])
    assert record['idleFrameMs']['p99'] <= FRAME_BUDGET_MS, (label, 'idle frame', record['idleFrameMs'])
    search = record['search']
    assert search['matchesAfterEachKey'][-1] == 1 and search['result']['matches'] == 1, (label, 'search', search)
    assert search['result']['firstMatch'] == search['expectedTitle'], (label, 'search matched the wrong project', search)
    assert search['cleared']['matches'] == search['cleared']['projects'] == plan['projects'], (label, 'clearing the search', search['cleared'])
    # N4: input reaches the screen within one frame, at 200 projects. For every keystroke, the first of the
    # session included: it is on screen in the first frame drawn after its dispatch, and its dispatch and that
    # frame each fit in one frame. (The first character typed into an empty field makes the input handler draw
    # the old state once inside the dispatch, `rendersInDispatch` == 1, before the key is applied; later keys
    # do not. That draw is part of dispatchMs, so it is held to a frame too and never hidden.)
    for split in search['typingSplit']:
        assert split['appliedInThatFrame'], (label, 'N4: the keystroke was not on screen in the frame that followed it', split)
        assert split['rendersTotal'] - split['rendersInDispatch'] <= 1, (label, 'N4: a keystroke needed more than one draw after its dispatch', split)
        assert split['dispatchMs'] <= FRAME_BUDGET_MS and split['frameMs'] <= FRAME_BUDGET_MS, (label, 'N4: keystroke phase took more than one frame', split, FRAME_BUDGET_MS)
    assert search['cleared']['query'] == '' and search['cleared']['matches'] == plan['projects'], (label, 'clearing did not show every project', search['cleared'])
    assert search['clearMs']['max'] <= FRAME_BUDGET_MS, (label, 'N4: clearing the search took more than one frame', search['clearMs'])
    judge_open((label, 'card open'), {**record['open']['stepsMs'], 'duration': record['open']['stepsMs']['ready']})
    assert Path(record['open']['dir']).name == match_title, (label, record['open'])
    assert inventory(library_root) == before, (label, 'loading, searching and opening changed the library')
    return {'wallSeconds': round(wall, 1), **record, 'footprintMB': round(mb(samples['library-loaded']['footprintBytes']), 1)}


try:
    songs = {}
    if any(s in stages for s in ('songs', 'cycles')):
        songs_root = scratch / 'songs'
        for length in minutes:
            if not (songs_root / f'Long song {length} min' / 'project.json').exists():
                make_song(songs_root, f'Long song {length} min', length * 60)
            songs[length] = songs_root / f'Long song {length} min'
    if 'songs' in stages:
        rows, footprints = {}, {}
        for n in minutes:
            # One launch per song: footprints of different lengths are then comparable.
            stems_before = inventory(songs[n] / 'stems')
            burst = args.burst_seconds if n == max(minutes) else 0
            plan = {'songs': [{'label': f'{n}min', 'dir': str(songs[n]), 'seconds': n * 60, 'burstSeconds': burst, 'steadySeconds': STEADY_SECONDS}]}
            samples, wall = launch('songs', plan, out / f'songs-{n}min', songs_root, scratch / f'prefs-songs-{n}', LAUNCH_DEADLINES['songs'])
            record = json.loads((out / f'songs-{n}min' / f'song-{n}min.json').read_text())
            judge_song(record, n * 60, out / f'songs-{n}min')
            assert inventory(songs[n] / 'stems') == stems_before, f'{n} min stems changed'
            phases = ('open', 'playing') + (('burst', 'after-burst') if burst else ())
            footprints[n] = {phase: mb(samples[f'{n}min-{phase}']['footprintBytes']) for phase in phases}
            rows[n] = {'wallSeconds': round(wall, 1), 'open': record['open'], 'waveformReadyMs': round(record['waveformReadyMs']),
                       'burstFrameMs': record.get('burst', {}).get('frames'), 'footprintMB': {k: round(v, 1) for k, v in footprints[n].items()}}
        # N9: the footprint does not depend on the length of the song
        if len(minutes) > 1:
            short, long = min(minutes), max(minutes)
            # open and steady playing are averaged: the transient between them (GPU and allocator
            # pools) moves one mark by tens of MB in either direction, independent of length
            level = lambda n: (footprints[n]['open'] + footprints[n]['playing']) / 2
            growth = level(long) - level(short)
            assert growth <= LENGTH_GROWTH_MB, f'N9: {long} min plays at {growth:.1f} MB more than {short} min (limit {LENGTH_GROWTH_MB} MB)'
            rows['lengthGrowthMB'] = round(growth, 1)
        summary['stages']['songs'] = rows
        print('songs  ', json.dumps(rows))
    if 'cycles' in stages:
        plan = {'songs': [str(songs[min(minutes)]), str(songs[max(minutes)])], 'cycles': 20}
        samples, wall = launch('cycles', plan, out / 'cycles', songs_root, scratch / 'prefs-cycles', LAUNCH_DEADLINES['cycles'])
        series = [mb(samples[f'cycle-{i:02d}']['footprintBytes']) for i in range(20)]
        steady = series[CYCLE_WARMUP:]
        n = len(steady)
        mean_x, mean_y = (n - 1) / 2, sum(steady) / n
        slope = sum((i - mean_x) * (y - mean_y) for i, y in enumerate(steady)) / sum((i - mean_x) ** 2 for i in range(n))
        cycles = json.loads((out / 'cycles' / 'cycles.json').read_text())['opens']
        assert [c['cycle'] for c in cycles] == list(range(20)), cycles
        for c in cycles:
            judge_open(f"cycle {c['cycle']}", c['stepsMs'])
        assert slope <= CYCLE_SLOPE_MB_PER_CYCLE, f'N10: footprint grows {slope:.2f} MB per open/close cycle (limit {CYCLE_SLOPE_MB_PER_CYCLE}); series {[round(v) for v in series]}'
        summary['stages']['cycles'] = {'wallSeconds': round(wall, 1), 'slopeMBPerCycle': round(slope, 3), 'footprintMB': [round(v, 1) for v in series]}
        print('cycles ', json.dumps(summary['stages']['cycles']))
    if 'library' in stages:
        library = scratch / 'library'
        if not library.is_dir():
            make_library(library, args.projects)
        summary['stages']['library'] = library_stage('library', library, out / 'library', scratch / 'prefs-library')
        print('library', json.dumps({k: summary['stages']['library'][k] for k in ('reloadMs', 'initialLoadFromHookMs')}))
    if 'exfat' in stages:
        assert sys.platform == 'darwin', 'the exFAT stage builds its volume with hdiutil'
        image, mount = scratch / 'exfat.dmg', scratch / 'exfat-mount'
        mount.mkdir(exist_ok=True)
        subprocess.run(['hdiutil', 'create', '-size', '2g', '-fs', 'ExFAT', '-volname', 'SingZExFAT', str(image)], check=True, capture_output=True, timeout=120)
        cleanups.append(lambda: image.unlink(missing_ok=True))

        def detach():
            if os.path.ismount(mount):
                result = subprocess.run(['hdiutil', 'detach', str(mount)], capture_output=True, text=True, timeout=60)
                if result.returncode != 0:
                    subprocess.run(['hdiutil', 'detach', '-force', str(mount)], check=True, capture_output=True, timeout=60)
        cleanups.append(detach)
        subprocess.run(['hdiutil', 'attach', str(image), '-nobrowse', '-mountpoint', str(mount)], check=True, capture_output=True, timeout=120)
        fs = subprocess.run(['diskutil', 'info', str(mount)], capture_output=True, text=True, timeout=30).stdout
        assert 'ExFAT' in fs or 'exFAT' in fs, 'the mounted volume is not ExFAT:\n' + fs
        library = mount / 'library'
        make_library(library, args.projects)
        summary['stages']['exfat'] = library_stage('exfat', library, out / 'exfat', scratch / 'prefs-exfat')
        # a long song streamed from the volume
        shortest = min(minutes)
        song = make_song(mount / 'songs', f'Long song {shortest} min', shortest * 60)
        plan = {'songs': [{'label': f'{shortest}min', 'dir': str(song), 'seconds': shortest * 60, 'burstSeconds': 0}]}
        samples, wall = launch('songs', plan, out / 'exfat-song', mount / 'songs', scratch / 'prefs-exfat-song', LAUNCH_DEADLINES['songs'])
        judge_song(json.loads((out / 'exfat-song' / f'song-{shortest}min.json').read_text()), shortest * 60, out / 'exfat-song')
        summary['stages']['exfat']['songWallSeconds'] = round(wall, 1)
        print('exfat  ', json.dumps({k: summary['stages']['exfat'][k] for k in ('reloadMs', 'initialLoadFromHookMs')}))
    if 'smb' in stages or args.smb_root:
        if not args.smb_root:
            summary['stages']['smb'] = 'not run: no --smb-root (a mounted, writable SMB folder) was given'
            print('smb     not run: pass --smb-root <mounted share folder>')
        else:
            library = args.smb_root.resolve() / f'singz-long-library-{os.getpid()}'
            cleanups.append(lambda: shutil.rmtree(library, ignore_errors=True))
            make_library(library / 'library', args.projects)
            summary['stages']['smb'] = library_stage('smb', library / 'library', out / 'smb', scratch / 'prefs-smb')
            print('smb    ', json.dumps({k: summary['stages']['smb'][k] for k in ('reloadMs', 'initialLoadFromHookMs')}))
    if 'mounted' in stages or args.library_root:
        assert args.library_root, 'stage mounted needs --library-root'
        summary['stages']['mounted'] = library_stage('mounted', args.library_root.resolve(), out / 'mounted', scratch / 'prefs-mounted')
        print('mounted', json.dumps({k: summary['stages']['mounted'][k] for k in ('reloadMs', 'initialLoadFromHookMs')}))
    summary['build'] = 'qualify + ui-tests'
    summary['display'], summary['muted'] = 'hidden', True
    (out / 'long-library.json').write_text(json.dumps(summary, indent=2))
finally:
    run_cleanups()
print('PASS hidden native long songs and large library:', ', '.join(summary['stages']))
