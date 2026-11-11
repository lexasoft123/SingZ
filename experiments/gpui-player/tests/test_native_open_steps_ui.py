"""Hidden muted native song open: per-step timings, exact identity, no decode (Q-05).

Native twin of tests/e2e/mac/open-steps-e2e.cjs. The bundled sample song (six FLAC
stems, copied from mobile/assets/sample) is opened as a first open, replaced by a
second project, and re-opened. The app reports when each step first held; this
driver judges them against per-step budgets and checks, from outside the process:

  * identity: the project the app reports is exactly the folder it was asked for;
  * no decode: every launch of the audio helper (a logging wrapper) is a device
    query or a playback session streaming the stems from their files, never a
    one-shot decode (--measure-input, --vocal-envelope, --render-*), and the beat
    analyzer is never started;
  * the fixtures are left byte for byte as found (opening is not an edit).

Run on a qualify build: cargo build --profile qualify --features ui-tests
  python3 test_native_open_steps_ui.py target/qualify/singz-gpui-player /tmp/evidence
Hidden and muted (SINGZ_MUTE=1, SINGZ_GPUI_BACKGROUND=1). Deadlines: every step has a
budget, the whole driver has a deadline, and the app and its descendants are killed
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

TOTAL_DEADLINE = 300.0
STEP_BUDGETS = {'fixtures': 60.0, 'app': 180.0}
# Milliseconds from the call that asks for the open to the step first holding.
# MEASURED, not chosen: 5 runs of this driver on a qualify build (aarch64 Mac, hidden,
# muted, the bundled sample song, commit 8cfcc94d + Q-05 hooks). Each step held at the same
# poll, so all four share one distribution: first open median 319 ms / max 889 ms (the cold
# open), second open median 243 / max 256, re-open median 240 / max 247. Budget = 2x the
# worst measured value (889 ms) = 1800 ms for every step. Do not raise it to make a run
# pass without recording why in plan/Q-05-coverage.md.
OPEN_BUDGET_MS = {'identity': 1800.0, 'ready': 1800.0, 'duration': 1800.0, 'graph': 1800.0}
N13_RELEASE_MS = 560.0

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
        elapsed = time.monotonic() - self.begin
        if kind is None:
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
            os.killpg(child.pid, signal.SIGKILL)  # stragglers in the group
        except (ProcessLookupError, PermissionError):
            pass
    return child.returncode


sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
inventory = lambda root: {str(p.relative_to(root)): {'bytes': p.stat().st_size, 'sha256': sha(p)} for p in sorted(root.rglob('*')) if p.is_file()}
contract = (REPO / 'src/renderer/src/audio/analysis-contract.ts').read_text()
beat_version = int(contract.split('export const BEAT_DETECT_VERSION = ', 1)[1].splitlines()[0].strip())
helper = app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')
assert helper.is_file(), f'rebuild the audio helper next to the app: {helper}'
assert (SAMPLE / 'project.json').is_file() and (SAMPLE / 'stems').is_dir(), f'bundled sample song missing: {SAMPLE}'

with tempfile.TemporaryDirectory(prefix='singz-open-steps-') as temporary, Step('fixtures'):
    root = Path(temporary).resolve()
    library = root / 'library'
    measured = subprocess.run([str(helper), '--measure-input', str(SAMPLE / 'stems/vocals.flac')], capture_output=True, text=True, timeout=30)
    assert measured.returncode == 0, measured.stderr
    duration = json.loads(measured.stdout)['frames'] / json.loads(measured.stdout)['sampleRate']
    stem_names = sorted(p.stem for p in (SAMPLE / 'stems').iterdir())
    fixtures = {}
    for key, name in (('A', 'Open step A'), ('B', 'Open step B')):
        folder = library / name
        shutil.copytree(SAMPLE, folder)
        raw = json.loads((folder / 'project.json').read_text())
        raw['name'] = name
        raw['settings']['beat'] = {'beats': [i * .5 for i in range(int(duration * 2) + 1)], 'bpm': 120, 'beatsPerBar': 4, 'downbeat': 0,
            'downbeats': list(range(0, int(duration * 2) + 1, 4)), 'autoDownbeats': list(range(0, int(duration * 2) + 1, 4)),
            'source': 'auto', 'detVersion': beat_version}
        raw['settings']['key'] = {'pc': 0, 'minor': False, 'detVersion': int(contract.split('export const KEY_DETECT_VERSION = ', 1)[1].splitlines()[0].strip())}
        raw['settings']['melody'] = {'detVersion': 4, 'hopSec': .01, 'f0': ' '.join(['2400'] * (int(duration / .01) + 1))}
        (folder / 'project.json').write_text(json.dumps(raw))
        fixtures[key] = folder
    before = {k: inventory(v) for k, v in fixtures.items()}
    # A logging wrapper records every helper launch, then becomes the real helper.
    helper_log = root / 'helper.log'
    wrapper = root / 'helper-wrapper'
    wrapper.write_text('#!/bin/sh\n{ printf "ARGV"; for a in "$@"; do printf "\\t%s" "$a"; done; printf "\\n"; } >> "$SINGZ_OPEN_STEPS_HELPER_LOG"\n'
                       f'exec "{helper}" "$@"\n')
    wrapper.chmod(0o700)
    analyzer_log = root / 'analyzer.log'
    analyzer = root / 'analyzer'
    analyzer.write_text('#!/bin/sh\necho "$@" >> "$SINGZ_OPEN_STEPS_ANALYZER_LOG"\nexit 3\n')
    analyzer.chmod(0o700)
    # Grid visibility is an app-wide preference.
    (root / 'prefs').mkdir()
    # qualify (release) builds open What's new automatically unless this version is acknowledged
    (root / 'prefs' / 'release-highlights.json').write_text(json.dumps({'version': 1, 'releaseNotesSeen': json.loads((REPO / 'package.json').read_text())['version']}))
    environment = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ('SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS')}
    environment.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
        SINGZ_GPUI_CONFIG_DIR=str(root / 'prefs'), SINGZ_GPUI_PROJECTS_ROOT=str(library),
        SINGZ_GPUI_AUDIO_HELPER=str(wrapper), SINGZ_OPEN_STEPS_HELPER_LOG=str(helper_log),
        SINGZ_GPUI_ANALYZER=str(analyzer), SINGZ_OPEN_STEPS_ANALYZER_LOG=str(analyzer_log),
        SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
        SINGZ_GPUI_OPEN_STEPS_TEST=str(out / 'app'), SINGZ_GPUI_OPEN_STEPS_A=str(fixtures['A']), SINGZ_GPUI_OPEN_STEPS_B=str(fixtures['B']))
    helper_log.write_text('')
    analyzer_log.write_text('')
    (out / 'app').mkdir(exist_ok=True)
    (out / 'app/result.json').unlink(missing_ok=True)
    (out / 'app/failure.txt').unlink(missing_ok=True)
    try:
        with Step('app') as step:
            code = run_app(environment, out / 'app', step)
        assert code == 0 and (out / 'app/result.json').is_file(), (out / 'app/failure.txt').read_text() if (out / 'app/failure.txt').exists() else (out / 'app/app.log').read_text()
        opens = json.loads((out / 'app/result.json').read_text())['opens']
        assert [o['label'] for o in opens] == ['first', 'second', 'reopen'], opens
        expected = {'first': fixtures['A'], 'second': fixtures['B'], 'reopen': fixtures['A']}
        names = {'first': 'Open step A', 'second': 'Open step B', 'reopen': 'Open step A'}
        rows = []
        for record in opens:
            label = record['label']
            # --- exact identity -------------------------------------------------
            assert Path(record['project']).resolve() == expected[label].resolve(), (label, 'wrong project opened', record['project'], str(expected[label]))
            assert record['name'] == names[label], (label, 'wrong project name', record['name'])
            assert len(record['laneSlots']) == len(stem_names) == 6 and record['laneSlots'] == sorted(set(record['laneSlots'])), (label, record['laneSlots'], stem_names)
            assert abs(record['duration'] - duration) < 0.5, (label, record['duration'], duration)
            assert record['notice'] is None and record['saving'] is False and record['beatJob'] is False, (label, 'open raised a notice, saved, or started analysis', record)
            assert record['hidden'] and record['muted'], record
            # --- per-step timings ------------------------------------------------
            steps = record['stepsMs']
            for name, limit in OPEN_BUDGET_MS.items():
                assert name in steps, (label, 'step never held', name, steps)
                assert steps[name] <= limit, (label, f'step {name} took {steps[name]:.0f} ms, budget {limit:.0f} ms', steps)
            assert steps['identity'] <= steps['ready'] <= steps['graph'] + 1e-6 and steps['duration'] >= steps['identity'], (label, 'steps out of order', steps)
            rows.append({'open': label, 'steps_ms': {k: round(v, 1) for k, v in steps.items()}, 'n13_release_budget_ms': N13_RELEASE_MS if label == 'first' else None})
        # --- no decode on open -----------------------------------------------------
        launches = [line.split('\t')[1:] for line in helper_log.read_text().splitlines() if line.startswith('ARGV')]
        forbidden = ('--measure-input', '--vocal-envelope', '--render-lyrics-input', '--render', '--decode')
        decodes = [argv for argv in launches if any(a in forbidden or a.startswith('--render') for a in argv)]
        sessions = [argv for argv in launches if '--output' in argv and any(a.endswith('.flac') for a in argv)]
        queries = [argv for argv in launches if argv and set(argv) <= {'--devices', '--providers'}]
        assert not decodes, f'open decoded audio through the helper: {decodes}'
        assert len(sessions) >= 3, f'expected a streaming playback session per open, saw {len(sessions)}: {launches}'
        assert len(sessions) + len(queries) == len(launches), f'unclassified helper launches: {launches}'
        assert not analyzer_log.read_text().strip(), 'open started the beat/pitch analyzer: ' + analyzer_log.read_text()
        # --- the library is left as found --------------------------------------------
        for key, folder in fixtures.items():
            assert inventory(folder) == before[key], f'opening changed fixture {key}'
        (out / 'open-steps.json').write_text(json.dumps({'rows': rows, 'helperLaunches': launches, 'durationSeconds': duration,
            'build': 'qualify + ui-tests', 'display': 'hidden', 'muted': True, 'budgetsMs': OPEN_BUDGET_MS,
            'note': 'N13 (0.56 s) is a release-build, visible-display budget measured in Q-15; shown for reference only'}, indent=2))
        for row in rows:
            print(row['open'].ljust(7), '  '.join(f'{k} {v:.0f} ms' for k, v in row['steps_ms'].items()))
    finally:
        kill_children()
        shutil.copytree(root, out / 'fixtures', dirs_exist_ok=True, ignore=shutil.ignore_patterns('*.flac'))
print('PASS hidden native open: step timings within budget, exact project identity, no decode, fixtures untouched')
