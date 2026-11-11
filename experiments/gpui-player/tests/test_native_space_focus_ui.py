"""Hidden muted native Space ownership after real pointer clicks (Q-05).

Native twin of tests/e2e/mac/space-focus-e2e.cjs, driven by the ui_space_focus hook
with real mouse clicks and real key events (never Tab, never a handler call):

  1. click a lane's Mute, then Space twice: the song starts and stops, Mute stays as
     the click left it, and Mute does not keep focus afterwards;
  2. click a stem fader, then Right and Space: Right moves the fader and does not seek,
     Space plays and pauses without touching the fader;
  3. click into the BPM field, then Space: a field being typed into owns the key, so
     the song does not start.

A click that leaves focus where the leg needs it elsewhere is INCONCLUSIVE (exit 2),
never a pass: without the focus there is no bug to catch. The song is a scratch copy
of the bundled sample, so the mixer edits the clicks cause never touch a real library.

Run on a qualify build: cargo build --profile qualify --features ui-tests
Deadlines: per-step budgets and a total deadline; the app and its children are killed
when either expires.
"""
import argparse
import atexit
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

TOTAL_DEADLINE = 240.0
STEP_BUDGETS = {'fixtures': 60.0, 'app': 150.0}

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



helper = app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')
assert helper.is_file(), f'rebuild the audio helper next to the app: {helper}'
assert (SAMPLE / 'project.json').is_file(), f'bundled sample song missing: {SAMPLE}'
contract = (REPO / 'src/renderer/src/audio/analysis-contract.ts').read_text()
version = int(contract.split('export const BEAT_DETECT_VERSION = ', 1)[1].splitlines()[0].strip())
inconclusive = None

with tempfile.TemporaryDirectory(prefix='singz-space-focus-') as temporary, Step('fixtures'):
    root = Path(temporary).resolve()
    library = root / 'library'
    project = library / 'Space focus sample'
    shutil.copytree(SAMPLE, project)
    measured = json.loads(subprocess.run([str(helper), '--measure-input', str(project / 'stems/vocals.flac')], capture_output=True, text=True, timeout=30, check=True).stdout)
    duration = measured['frames'] / measured['sampleRate']
    count = int(duration * 2) + 1
    raw = json.loads((project / 'project.json').read_text())
    raw['name'] = 'Space focus sample'
    # Current analyses, so opening never tries to derive (and save) anything.
    raw['settings']['beat'] = {'beats': [i * .5 for i in range(count)], 'bpm': 120, 'beatsPerBar': 4, 'downbeat': 0,
        'downbeats': list(range(0, count, 4)), 'autoDownbeats': list(range(0, count, 4)), 'source': 'auto', 'detVersion': version}
    raw['settings']['key'] = {'pc': 0, 'minor': False, 'detVersion': int(contract.split('export const KEY_DETECT_VERSION = ', 1)[1].splitlines()[0].strip())}
    raw['settings']['melody'] = {'detVersion': 4, 'hopSec': .01, 'f0': ' '.join(['2400'] * (int(duration / .01) + 1))}
    (project / 'project.json').write_text(json.dumps(raw))
    (root / 'prefs').mkdir()
    # qualify (release) builds open What's new automatically unless this version is acknowledged
    (root / 'prefs' / 'release-highlights.json').write_text(json.dumps({'version': 1, 'releaseNotesSeen': json.loads((REPO / 'package.json').read_text())['version']}))
    environment = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ('SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR')}
    environment.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
        SINGZ_GPUI_SPACE_FOCUS_TEST=str(out / 'app'), SINGZ_GPUI_SPACE_FOCUS_PROJECT=str(project),
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
        legs = {leg['label']: leg for leg in json.loads((out / 'app/legs.json').read_text())}
        assert all(leg['hidden'] and leg['notice'] is None for leg in legs.values()), legs
        problems = []

        # ---- 1. Mute, then Space ------------------------------------------------------
        clicked = legs['mute-clicked']
        if not clicked['muteFocused']:
            inconclusive = 'clicking Mute left focus elsewhere: nothing for Space to press again'
        assert clicked['muted'] is True, 'the Mute click did not mute'
        for label, playing in (('mute-space-start', True), ('mute-space-stop', False)):
            leg = legs[label]
            if leg['playing'] is not playing:
                problems.append(f'Space after clicking Mute did not {label.split("-")[-1]} the song')
            if leg['muted'] is not True:
                problems.append(f'Space after clicking Mute pressed Mute again (muted now {leg["muted"]})')
            if leg['muteFocused']:
                problems.append('Mute still holds focus after Space: the next Space could still reach it')

        # ---- 2. a fader keeps its arrows and gives up Space -----------------------------
        fader = legs['fader-clicked']
        if not fader['gainFocused']:
            inconclusive = inconclusive or 'clicking a fader left focus elsewhere'
        moved = legs['fader-right']
        if not moved['gain'] > fader['gain']:
            problems.append(f'Right on a focused fader did not move it ({fader["gain"]} -> {moved["gain"]})')
        if moved['seekCount'] != fader['seekCount'] or abs(moved['position'] - fader['position']) > 1.0:
            problems.append(f'Right on a focused fader seeked the song ({fader["position"]} -> {moved["position"]})')
        for label, playing in (('fader-space-start', True), ('fader-space-stop', False)):
            leg = legs[label]
            if leg['playing'] is not playing:
                problems.append(f'Space with a fader focused did not {label.split("-")[-1]} the song')
            if leg['gain'] != moved['gain']:
                problems.append(f'Space with a fader focused moved the fader ({moved["gain"]} -> {leg["gain"]})')

        # ---- 3. a text field owns Space -------------------------------------------------
        field = legs['bpm-clicked']
        if not field['bpmFocused']:
            inconclusive = inconclusive or 'clicking the BPM field left focus elsewhere'
        typed = legs['bpm-space']
        if typed['playing'] != field['playing'] or typed['seekCount'] != field['seekCount']:
            problems.append('Space typed into the BPM field also toggled the song')
        (out / 'space-focus.json').write_text(json.dumps({'legs': list(legs.values()), 'problems': problems, 'inconclusive': inconclusive, 'hidden': True, 'muted': True}, indent=2))
        assert not problems, 'FAIL (%d): ' % len(problems) + '; '.join(problems)
        if inconclusive:
            print('INCONCLUSIVE:', inconclusive)
            sys.exit(2)
    finally:
        kill_children()
        shutil.copytree(root, out / 'fixtures', dirs_exist_ok=True, ignore=shutil.ignore_patterns('*.flac'))
print('PASS hidden native Space: plays and pauses whatever was clicked last; faders keep their arrows, the BPM field keeps its Space')
