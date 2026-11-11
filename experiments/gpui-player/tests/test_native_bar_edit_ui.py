"""Hidden muted native bar drag + Re-detect keep a hand-placed bar (Q-05).

Native twin of tests/e2e/mac/bar-edit-e2e.cjs and redetect-bars-e2e.cjs. On a copy of
the bundled sample song with a current auto grid, the app (real ruler drag, real
Re-detect button, real Save) is driven by the ui_bar_edit hook; this driver judges the
bytes on disk, which are what Drive syncs and the phones open:

  1. the drag records exactly one user bar, folded into `downbeats`, with the
     detector's own `autoDownbeats` and `source: auto` untouched, saved without help;
  2. the Metronome popover counts the hand-set bar (the singer's only way to see it);
  3. Re-detect really runs the detector (the analyzer stub counts its calls, and the
     project goes dirty), yet the bar is still there afterwards, in the popover and
     in the grid;
  4. after Save the file still holds the bar within 0.3 s, still `source: auto`.

The analyzer is a bounded Python stub with a deterministic answer: no detector-quality
claim. Run on a qualify build: cargo build --profile qualify --features ui-tests
Deadlines: per-step budgets and a total deadline; the app and its children are killed
when either expires.
"""
import argparse
import atexit
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

TOTAL_DEADLINE = 360.0
STEP_BUDGETS = {'fixtures': 60.0, 'app': 240.0}

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
parser.add_argument('--sample', type=Path, default=None)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
REPO = Path(__file__).resolve().parents[3]
SAMPLE = (args.sample or REPO / 'mobile/assets/sample').resolve()
started = time.monotonic()
children = []


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


atexit.register(kill_children)
for sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, lambda *_: sys.exit(130))


class Step:
    def __init__(self, name):
        self.name, self.limit = name, STEP_BUDGETS[name]

    def __enter__(self):
        self.begin = time.monotonic()
        assert remaining() > 0, 'total deadline expired before step ' + self.name
        return self

    def __exit__(self, kind, value, trace):
        if kind is None:
            elapsed = time.monotonic() - self.begin
            assert elapsed <= self.limit, f'step {self.name} took {elapsed:.1f}s, budget {self.limit}s'

    def timeout(self):
        return min(self.limit - (time.monotonic() - self.begin), remaining())


def run_app(environment, folder, step):
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / 'app.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    children.append(child)
    try:
        child.wait(timeout=max(step.timeout(), 1))
    except subprocess.TimeoutExpired:
        kill_children()
        raise AssertionError(f'app exceeded the {step.name} budget or the total deadline; killed')
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    return child.returncode


contract = (REPO / 'src/renderer/src/audio/analysis-contract.ts').read_text()
version = int(contract.split('export const BEAT_DETECT_VERSION = ', 1)[1].splitlines()[0].strip())
helper = app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')
assert helper.is_file(), f'rebuild the audio helper next to the app: {helper}'
assert (SAMPLE / 'project.json').is_file(), f'bundled sample song missing: {SAMPLE}'

with tempfile.TemporaryDirectory(prefix='singz-bar-edit-') as temporary, Step('fixtures'):
    root = Path(temporary).resolve()
    library = root / 'library'
    project = library / 'Bar edit sample'
    shutil.copytree(SAMPLE, project)
    measured = json.loads(subprocess.run([str(helper), '--measure-input', str(project / 'stems/drums.flac')], capture_output=True, text=True, timeout=30, check=True).stdout)
    duration = measured['frames'] / measured['sampleRate']
    count = int(duration * 2) + 1
    beats = [i * .5 for i in range(count)]
    downbeats = list(range(0, count, 4))
    raw = json.loads((project / 'project.json').read_text())
    raw['name'] = 'Bar edit sample'
    raw['settings']['beat'] = {'beats': beats, 'bpm': 120, 'beatsPerBar': 4, 'downbeat': 0, 'downbeats': downbeats,
        'autoDownbeats': downbeats, 'source': 'auto', 'detVersion': version}
    raw['settings']['key'] = {'pc': 0, 'minor': False, 'detVersion': int(contract.split('export const KEY_DETECT_VERSION = ', 1)[1].splitlines()[0].strip())}
    raw['settings']['melody'] = {'detVersion': 4, 'hopSec': .01, 'f0': ' '.join(['2400'] * (int(duration / .01) + 1))}
    # A zoomed view puts the bar lines far enough apart to grab, like the Electron driver's strip.
    raw['settings']['view'] = {'s': 0, 'e': 32}
    (project / 'project.json').write_text(json.dumps(raw))
    (root / 'prefs').mkdir()
    # qualify (release) builds open What's new automatically unless this version is acknowledged
    (root / 'prefs' / 'release-highlights.json').write_text(json.dumps({'version': 1, 'releaseNotesSeen': json.loads((REPO / 'package.json').read_text())['version']}))
    (root / 'prefs/metronome.json').write_text(json.dumps({'version': 1, 'grid': True, 'click': False, 'countInBars': 0, 'volume': .7, 'accent': True}))
    control = root / 'control.json'
    control.write_text(json.dumps({'mode': 'valid', 'delayMs': 600}))
    calls = root / 'calls.jsonl'
    calls.write_text('')
    analyzer = root / 'analyzer'
    analyzer.write_text(f'#!{sys.executable}\n' + '''import json, os, sys, time
from pathlib import Path
control = Path(os.environ['SINGZ_GPUI_BEAT_CONTROL'])
mode = json.loads(control.read_text())
args = sys.argv[1:]
if args[:2] != ['analyze', '--beats'] or '--ml-stdin' not in args or '--drums' not in args:
    raise SystemExit('Unexpected analyzer command: ' + repr(args))
tokens = sys.stdin.read()
with (control.parent / 'calls.jsonl').open('a') as log:
    log.write(json.dumps({'pid': os.getpid(), 'args': args, 'tokens': tokens}) + '\\n')
time.sleep(mode.get('delayMs', 0) / 1000)
print(json.dumps({'diagnostic': 'deterministic fixture, not detector quality'}), flush=True)
count = COUNT
# A different bar phase from the stored grid, so applying the result is observable.
result = {'detVersion': VERSION, 'ok': True, 'bpm': 120, 'beatsPerBar': 4, 'downbeat': 1, 'hasDownbeats': True,
    'beatsSec': [i * .5 for i in range(count)], 'downbeats': list(range(1, count, 4)), 'suspectAt': []}
print(json.dumps({'beats': result}), flush=True)
'''.replace('VERSION', str(version)).replace('COUNT', str(count)))
    analyzer.chmod(0o700)
    before = (project / 'project.json').read_bytes()
    environment = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ('SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR')}
    environment.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
        SINGZ_GPUI_BAR_EDIT_TEST=str(out / 'app'), SINGZ_GPUI_BAR_EDIT_PROJECT=str(project),
        SINGZ_GPUI_BEAT_CONTROL=str(control), SINGZ_GPUI_ANALYZER=str(analyzer),
        SINGZ_GPUI_CONFIG_DIR=str(root / 'prefs'), SINGZ_GPUI_PROJECTS_ROOT=str(library),
        SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'))
    (out / 'app').mkdir(exist_ok=True)
    (out / 'app/result.json').unlink(missing_ok=True)
    (out / 'app/failure.txt').unlink(missing_ok=True)
    try:
        with Step('app') as step:
            code = run_app(environment, out / 'app', step)
        failure = out / 'app/failure.txt'
        assert code == 0 and (out / 'app/result.json').is_file(), failure.read_text() if failure.exists() else (out / 'app/app.log').read_text()
        stage = lambda name: json.loads((out / 'app' / f'{name}.json').read_text())
        opened, dragged, popover, redetected, saved = (stage(n) for n in ('1-opened', '2-dragged', '3-popover-before', '4-redetected', '5-saved'))
        origin = json.loads((out / 'app/dragged-from.json').read_text())['from']
        for record in (opened, dragged, popover, redetected, saved):
            assert record['hiddenConfigured'] and record['mutedConfigured'] and not record['windowPresented'] and not record['windowActive'], record['stage']
        index = lambda t: min(range(count), key=lambda i: abs(beats[i] - t))

        # ---- 1. the drag -------------------------------------------------------
        assert 'userBars' not in opened['disk'] and opened['disk']['source'] == 'auto', opened['disk']
        disk = dragged['disk']
        assert len(disk['userBars']) == 1, ('the drag recorded no single user bar', disk.get('userBars'))
        t = disk['userBars'][0]
        assert abs(t - origin) >= 0.4, ('the bar line did not move', origin, t)
        assert abs(beats[index(t)] - t) < 1e-6, ('user bar is not beat-aligned', t)
        assert index(t) in disk['downbeats'], ('user bar was not folded into downbeats', index(t))
        assert disk['autoDownbeats'] == downbeats, 'the detector base was altered by the edit'
        assert disk['source'] == 'auto' and disk['detVersion'] == version, ('a bar edit made the grid manual or restamped it', disk)
        assert dragged['analyzerCalls'] == 0, 'the drag ran the detector'

        # ---- 2. the popover says so --------------------------------------------
        assert popover['popoverOpen'] and popover['popoverHandSetBars'] == 1, popover
        assert '1 hand-set bar' in popover['popoverText'], popover['popoverText']
        assert popover['redetectEnabled'], 'Re-detect is not offered (no drums lane?)'

        live_auto = lambda r: r['beat']['autoDownbeats']
        # ---- 3. Re-detect ran, and the bar is still counted --------------------
        records = [json.loads(line) for line in calls.read_text().splitlines()]
        assert len(records) == 1 and '--ml-stdin' in records[0]['args'], ('Re-detect did not run the detector exactly once', records)
        assert redetected['analyzerCalls'] == 1 and not redetected['job'], redetected
        assert redetected['editSequence'] > dragged['editSequence'] and live_auto(redetected) == list(range(1, count, 4)), 'the detector result was never applied to the project'
        assert redetected['popoverHandSetBars'] == 1 and '1 hand-set bar' in redetected['popoverText'], 'Re-detect dropped the bar from the popover'
        live = redetected['beat']
        assert live['userBars'] and abs(live['userBars'][0] - t) <= 0.3, ('Re-detect lost or moved the live bar', live.get('userBars'), t)
        assert redetected['disk'] == disk, 'Re-detect saved by itself (it must wait for Save)'

        # ---- 4. the file after Save --------------------------------------------
        final = saved['disk']
        assert final.get('userBars') and abs(final['userBars'][0] - t) <= 0.3, ('Re-detect threw the hand-placed bar away on disk', final.get('userBars'), t)
        assert final['source'] == 'auto', ("source became %r: opts the song out of future detector work" % final['source'])
        assert index(final['userBars'][0]) in final['downbeats'] and final['autoDownbeats'] == list(range(1, count, 4)), ('the file does not hold the new detector base folded with the bar', final)
        after = json.loads((project / 'project.json').read_text())
        assert after['settings']['beat'] == final, 'the Save record disagrees with the file'
        assert after['settings']['view'] and after['name'] == 'Bar edit sample'
        (out / 'bar-edit.json').write_text(json.dumps({'originalBar': origin, 'userBar': t, 'finalUserBars': final['userBars'], 'analyzerCalls': len(records),
            'scope': 'deterministic analyzer stub; app-state and file bytes, not detector quality', 'hidden': True, 'muted': True}, indent=2))
    finally:
        kill_children()
        shutil.copytree(root, out / 'fixtures', dirs_exist_ok=True, ignore=shutil.ignore_patterns('*.flac'))
print('PASS hidden native bar drag + Re-detect: hand-placed bar kept in popover, grid and file; source stays auto')
