"""Hidden muted native played edge on the playhead line (Q-05).

Native twin of tests/e2e/mac/played-edge-e2e.cjs (field report 2026-09-24: "stem lines
shadow removal is following the crosshair with delay"). On a scratch copy of the bundled
sample song, zoomed to eight seconds, the ui_played_edge hook renders the real window and
classifies every informative lane column as played or unplayed from the pixels:

  * paused at six positions, none a multiple of a quarter second, and
  * playing for twelve real frames,

and this driver requires that every classified column left of the playhead glow is
played and every one right of it is unplayed. A played layer that trails the line (a
stale or throttled clock) leaves unplayed columns left of the glow and fails. The
frames must be informative (enough columns on both sides) so the check cannot pass
vacuously. Resolution is the glow width (about 13 points each side); the one-device-pixel
floor/round residual between the clip and the line is below it and not covered.

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
MIN_INFORMATIVE = 120   # device columns per side, per frame

with tempfile.TemporaryDirectory(prefix='singz-played-edge-') as temporary, Step('fixtures'):
    root = Path(temporary).resolve()
    library = root / 'library'
    project = library / 'Played edge sample'
    shutil.copytree(SAMPLE, project)
    measured = json.loads(subprocess.run([str(helper), '--measure-input', str(project / 'stems/vocals.flac')], capture_output=True, text=True, timeout=30, check=True).stdout)
    duration = measured['frames'] / measured['sampleRate']
    count = int(duration * 2) + 1
    raw = json.loads((project / 'project.json').read_text())
    raw['name'] = 'Played edge sample'
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
        SINGZ_GPUI_PLAYED_EDGE_TEST=str(out / 'app'), SINGZ_GPUI_PLAYED_EDGE_PROJECT=str(project),
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
        edge = json.loads((out / 'app/edge.json').read_text())
        judged = 0
        problems = []
        for group in ('paused', 'playing'):
            for frame in edge[group]:
                if 'skipped' in frame:
                    continue
                name = f"{group} {frame.get('offsetSeconds', frame.get('frame'))}"
                if frame['informativeLeft'] < MIN_INFORMATIVE or frame['informativeRight'] < MIN_INFORMATIVE:
                    problems.append(f"{name}: too few informative columns to judge (left {frame['informativeLeft']}, right {frame['informativeRight']})")
                    continue
                judged += 1
                if frame['unplayedLeft']:
                    problems.append(f"{name}: {frame['unplayedLeft']} of {frame['informativeLeft']} columns left of the playhead are NOT played (first at device column {frame['firstUnplayedLeft']}, head {frame['headDeviceColumn']:.0f})")
                if frame['playedRight']:
                    problems.append(f"{name}: {frame['playedRight']} of {frame['informativeRight']} columns right of the playhead ARE played (last at device column {frame['lastPlayedRight']}, head {frame['headDeviceColumn']:.0f})")
        assert len(edge['paused']) == 6 and sum('skipped' not in f for f in edge['playing']) >= 6, ('too few judged playing frames', edge['playing'])
        (out / 'played-edge.json').write_text(json.dumps({'judgedFrames': judged, 'problems': problems, 'edge': edge, 'hidden': True, 'muted': True}, indent=2))
        assert judged >= 12 and not problems, 'FAIL (%d): ' % len(problems) + '; '.join(problems)
    finally:
        kill_children()
        shutil.copytree(root, out / 'fixtures', dirs_exist_ok=True, ignore=shutil.ignore_patterns('*.flac'))
print('PASS hidden native played edge: the played layer ends on the playhead line, paused and playing')
