"""Hidden muted native audio Settings across a relaunch (Q-05).

Native twin of the persistence legs of tests/e2e/mac/audio-devices-e2e.cjs. Three fresh
app processes share one isolated config directory and a synthetic device inventory
(no hardware is opened, capture is disabled, output is muted):

  choose   real clicks pick output channels 7 and 8 of a duplex device; the choice
           reaches audio.json;
  restart  the saved choice is read back: the same Settings controls show the same
           labels, and merely opening Settings leaves audio.json byte for byte as it was;
  missing  the saved device is gone from the inventory: Settings says the saved channel
           is unavailable instead of quietly adopting another device, and the file keeps
           the singer's choice.

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
STEP_BUDGETS = {'fixtures': 30.0, 'choose': 60.0, 'restart': 60.0, 'missing': 60.0}

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
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



with tempfile.TemporaryDirectory(prefix='singz-settings-relaunch-') as temporary, Step('fixtures'):
    root = Path(temporary).resolve()
    for name in ('preferences', 'library', 'tmp', 'cache'):
        (root / name).mkdir()
    environment = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_')}
    environment.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1', SINGZ_GPUI_TEST_NO_CAPTURE='1', SINGZ_GPUI_BACKGROUND='1',
        SINGZ_GPUI_CONFIG_DIR=str(root / 'preferences'), SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'),
        SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'))
    (root / 'preferences' / 'release-highlights.json').write_text(json.dumps({'version': 1, 'releaseNotesSeen': json.loads((Path(__file__).resolve().parents[3] / 'package.json').read_text())['version']}))
    audio_json = root / 'preferences/audio.json'
    try:
        states = {}
        for stage in ('choose', 'restart', 'missing'):
            folder = out / stage
            (folder).mkdir(parents=True, exist_ok=True)
            (folder / 'state.json').unlink(missing_ok=True)
            (folder / 'failure.txt').unlink(missing_ok=True)
            with Step(stage) as step:
                code = run_app({**environment, 'SINGZ_GPUI_SETTINGS_RELAUNCH_TEST': str(folder), 'SINGZ_GPUI_SETTINGS_STAGE': stage}, folder, step)
            failure = folder / 'failure.txt'
            assert code == 0 and (folder / 'state.json').is_file(), failure.read_text() if failure.exists() else (folder / 'app.log').read_text()
            states[stage] = json.loads((folder / 'state.json').read_text())
            for flag in ('monitorRequested', 'micRequested', 'micPermissionRequested'):
                assert states[stage][flag] is False, (stage, 'Settings requested hardware', flag)
            if stage == 'choose':
                saved_after_choose = audio_json.read_bytes()
        choose, restart, missing = states['choose'], states['restart'], states['missing']

        # ---- choose: real clicks reached the file ------------------------------------------
        saved = json.loads(saved_after_choose)
        assert saved['monitorOutputUid'] == 'singz:fake-duplex' and saved['monitorOutputChannels'] == [6, 7], saved
        assert choose['outputs'] == [6, 7] and choose['labels']['left'] and choose['labels']['right'], choose
        assert choose['labels']['left'] != choose['labels']['right'], choose['labels']

        # ---- restart: the same choice comes back, and opening Settings rewrites nothing ----
        assert restart['outputs'] == [6, 7] and restart['monitorOutput'] == 'singz:fake-duplex', ('the saved channel choice was not restored', restart)
        assert restart['labels']['left'] == choose['labels']['left'] and restart['labels']['right'] == choose['labels']['right'], ('Settings shows a different choice after relaunch', choose['labels'], restart['labels'])
        assert restart['labels']['monitorOutput'] == choose['labels']['monitorOutput'], (choose['labels'], restart['labels'])
        assert 'unavailable' not in json.dumps(restart['labels']).lower(), restart['labels']
        assert restart['audioJsonBeforeOpen'] == saved_after_choose.decode() == restart['audioJson'], 'opening Settings rewrote audio.json'

        # ---- missing: the unplugged device is reported, never replaced ---------------------
        assert missing['outputs'] == [6, 7] and missing['monitorOutput'] == 'singz:fake-duplex', ('a missing device was silently replaced', missing)
        assert 'unavailable' in (missing['labels']['monitorOutput'] or '').lower(), ('the missing monitoring device is not reported as unavailable', missing['labels'])
        assert missing['labels']['left'] != choose['labels']['left'], ('Settings still presents the vanished device\'s channel as selectable', missing['labels'])
        assert missing['audioJson'] == saved_after_choose.decode() == audio_json.read_text(), 'the missing-device run rewrote the singer\'s choice'
        (out / 'settings-relaunch.json').write_text(json.dumps({'saved': saved, 'labels': {k: v['labels'] for k, v in states.items()}, 'synthetic': True, 'hidden': True, 'muted': True}, indent=2))
    finally:
        kill_children()
        shutil.copytree(root, out / 'fixtures', dirs_exist_ok=True)
print('PASS hidden native audio Settings: channel choice persists across relaunch, unchanged by opening, unavailable device reported not replaced')
