"""Measure peak RSS of the GPUI audio helper while opening a generated song.

The driver delegates UI setup to test_native_open_steps_ui.py, which isolates
config, project, model and pack roots. This wrapper samples only descendants of
that run and records helper RSS in KiB for the selected 5 or 12 minute fixture.
"""
import argparse
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
STEP_BUDGET = 180.0

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('helper', type=Path)
parser.add_argument('sample', type=Path)
parser.add_argument('out', type=Path)
parser.add_argument('--label', required=True)
parser.add_argument('--baseline', action='store_true', help='record RSS even if the open budgets fail (non-streaming helper)')
args = parser.parse_args()
app, helper, sample, out = (p.resolve() for p in (args.app, args.helper, args.sample, args.out))
out.mkdir(parents=True, exist_ok=True)
repo = Path(__file__).resolve().parents[3]
driver = Path(__file__).with_name('test_native_open_steps_ui.py')
started = time.monotonic()

sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()


def descendants(root):
    result = subprocess.run(['ps', '-axo', 'pid=,ppid=,rss=,comm='], capture_output=True, text=True, timeout=5, check=True)
    rows = []
    for line in result.stdout.splitlines():
        columns = line.strip().split(None, 3)
        if len(columns) == 4:
            rows.append((int(columns[0]), int(columns[1]), int(columns[2]), columns[3]))
    family = {root}
    changed = True
    while changed:
        old = len(family)
        family.update(pid for pid, parent, _, _ in rows if parent in family)
        changed = len(family) != old
    return [(pid, rss, name) for pid, _, rss, name in rows if pid in family and 'singz-gpui-audio' in name]


def kill_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


with tempfile.TemporaryDirectory(prefix='singz-stream-rss-') as temporary:
    root = Path(temporary)
    bin_dir = root / 'bin'
    bin_dir.mkdir()
    local_app = bin_dir / app.name
    local_helper = bin_dir / helper.name
    shutil.copy2(app, local_app)
    shutil.copy2(helper, local_helper)
    children = []
    folder = out / args.label
    folder.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, str(driver), str(local_app), str(folder), '--sample', str(sample)]
    env = {key: value for key, value in os.environ.items() if not key.startswith('SINGZ_GPUI_')}
    env.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
               SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'))
    with (folder / 'driver.log').open('w') as log:
        process = subprocess.Popen(command, cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        children.append(process)
        peaks = {}
        app_groups = set()
        try:
            while process.poll() is None:
                elapsed = time.monotonic() - started
                assert elapsed < TOTAL_DEADLINE and elapsed < STEP_BUDGET, 'RSS measurement deadline expired'
                for pid, rss, name in descendants(process.pid):
                    try:
                        app_groups.add(os.getpgid(pid))
                    except ProcessLookupError:
                        pass  # exited between the ps snapshot and this call; its RSS row still counts
                    row = peaks.setdefault(pid, {'peakRssKiB': rss, 'command': name})
                    row['peakRssKiB'] = max(row['peakRssKiB'], rss)
                time.sleep(.1)
            assert process.returncode == 0 or args.baseline, (folder / 'driver.log').read_text(errors='replace')
        finally:
            for group in app_groups:
                try:
                    os.killpg(group, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            for child in children:
                if child.poll() is None:
                    kill_group(child)
    measured = [row for row in peaks.values()]
    assert measured, 'audio helper process was never observed in the app process tree'
    receipt = {'label': args.label, 'sample': str(sample), 'appSha256': sha(app), 'helperSha256': sha(helper),
               'peakHelperRssKiB': max(row['peakRssKiB'] for row in measured), 'helperProcesses': measured, 'driverPassed': process.returncode == 0,
               'build': 'qualify + ui-tests', 'muted': True, 'hidden': True, 'liveFps': 'unmeasured'}
    (folder / 'rss.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt, indent=2))
