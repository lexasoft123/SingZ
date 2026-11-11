"""50 hidden, muted real-app open/quit cycles; requires a ui-tests build (macOS).

Usage: python3.13 test_native_helper_lifecycle.py APP OUTPUT
The existing request-file UI harness drives production Open and application Quit.
A transparent exec wrapper records only helpers owned by this run, never global PIDs.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import signal
import struct
import subprocess
import sys
import tempfile
import time
import wave


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    app, out = args.app.resolve(), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    assert platform.system() == 'Darwin', 'Windows field-laptop qualification is a human run'
    helper = app.with_name('singz-gpui-audio')
    assert app.is_file() and helper.is_file()
    total_deadline = time.monotonic() + 600
    quit_ms, helper_ms, owned = [], [], set()
    app_child = None
    active_group = None

    def alive(pid):
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False

    def remaining(seconds):
        value = min(seconds, total_deadline - time.monotonic())
        assert value > 0, '600-second total deadline exceeded'
        return value

    try:
        with tempfile.TemporaryDirectory(prefix='singz-c18-lifecycle-') as temporary:
            root = Path(temporary)
            project = root / 'library' / 'Lifecycle'
            (project / 'stems').mkdir(parents=True)
            with wave.open(str(project / 'stems' / 'vocals.wav'), 'wb') as audio:
                audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                audio.writeframes(b''.join(struct.pack('<h', round(1000 * math.sin(i * math.tau * 220 / 16000))) for i in range(16000)) * 4)
            (project / 'project.json').write_text(json.dumps({'version': 2, 'name': 'Lifecycle', 'settings': {}}))
            launches = out / 'helpers.jsonl'
            launches.write_text('')
            wrapper = root / 'audio-helper'
            wrapper.write_text(f'#!{sys.executable}\nimport os,sys,json\nwith open({str(launches)!r},"a") as log: log.write(json.dumps({{"pid":os.getpid(),"probe":any(arg in ("--devices","--providers","--measure-input") for arg in sys.argv[1:])}})+"\\n")\nos.execv({str(helper)!r},[{str(helper)!r},*sys.argv[1:]])\n')
            wrapper.chmod(0o700)
            for cycle in range(50):
                folder = out / f'{cycle:02}'
                folder.mkdir(parents=True, exist_ok=True)
                scenario, config = root / f'scenario-{cycle}', root / f'config-{cycle}'
                scenario.mkdir()
                config.mkdir()
                environment = {key: value for key, value in os.environ.items() if not key.startswith('SINGZ_')}
                environment.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_GPUI_BACKGROUND='1',
                    SINGZ_GPUI_TEST_NO_CAPTURE='1', SINGZ_GPUI_CONFIG_DIR=str(config),
                    SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'), SINGZ_GPUI_TEST_PROJECT=str(project),
                    SINGZ_GPUI_PERF_SCENARIO=str(scenario), SINGZ_GPUI_AUDIO_HELPER=str(wrapper),
                    SINGZ_PERF_STEP_TIMEOUT='15')
                with (folder / 'app.log').open('w') as log:
                    app_child = subprocess.Popen([str(app)], env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                    active_group = app_child.pid
                    def action(name, budget=15):
                        receipt = scenario / 'receipt.json'
                        receipt.unlink(missing_ok=True)
                        temporary_request = scenario / 'request.tmp'
                        temporary_request.write_text(json.dumps({'action': name}))
                        temporary_request.rename(scenario / 'request.json')
                        deadline = time.monotonic() + remaining(budget)
                        while not receipt.exists():
                            assert app_child.poll() is None, f'app exited during {name}; see {folder}'
                            assert time.monotonic() < deadline, f'{name} step deadline exceeded'
                            time.sleep(.005)
                        value = json.loads(receipt.read_text())
                        assert value['action'] == name and value['completed'], value
                        return value
                    action('launch')
                    action('open')
                    if cycle == 0:
                        for test_action in ('invalid-control-refusal', 'seek-refusal'):
                            refusal = action(test_action)
                            (folder / f'{test_action}.json').write_text(json.dumps(refusal, indent=2) + '\n')
                    rows = [json.loads(line) for line in launches.read_text().splitlines()]
                    pids = {row['pid'] for row in rows}
                    new = {row['pid'] for row in rows if not row['probe']} - owned
                    assert new and all(alive(pid) for pid in new), 'Open did not leave an owned live helper'
                    owned.update(pids)
                    started = time.monotonic()
                    action('quit', .750)
                    app_child.wait(timeout=remaining(max(.001, .750 - (time.monotonic() - started))))
                    quit_ms.append((time.monotonic() - started) * 1000)
                    assert app_child.returncode == 0
                    app_child = None
                assert not any(alive(pid) for pid in owned), f'cycle {cycle}: orphan helper'
                active_group = None
                records = '\n'.join(path.read_text(errors='replace') for path in config.rglob('*') if path.is_file())
                measured = re.findall(r'Helper retirement: Ok\(Clean\), elapsed_ms=([0-9.]+)', records)
                assert len(measured) == 1, f'cycle {cycle}: missing clean retirement receipt'
                helper_ms.append(float(measured[0]))
                assert helper_ms[-1] <= 750 and quit_ms[-1] <= 750
                print(f'cycle={cycle + 1}/50 quit_ms={quit_ms[-1]:.3f} helper_ms={helper_ms[-1]:.3f}', flush=True)
            def summary(values):
                values = sorted(values)
                return {'p50': values[24], 'p95': values[47], 'max': values[-1]}
            result = {'cycles': 50, 'helperQuitMs': summary(helper_ms), 'applicationQuitMs': summary(quit_ms),
                'ownedHelpers': len(owned), 'longLivedHelpers': sum(not row['probe'] for row in rows), 'orphanHelpers': 0, 'quitBoundMs': 750,
                'hidden': True, 'muted': True, 'profile': 'ui-tests (dev opt-level=2)', 'displayMode': 'hidden', 'platform': platform.platform(),
                'machine': platform.machine(), 'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True, timeout=30).strip(),
                'worktreeDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], text=True, timeout=30).strip()),
                'appSha256': hashlib.sha256(app.read_bytes()).hexdigest(),
                'helperSha256': hashlib.sha256(helper.read_bytes()).hexdigest(),
                'windows': 'Human field-laptop run required'}
            (out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
            print(json.dumps(result, indent=2))
    finally:
        try:
            if app_child is not None and app_child.poll() is None:
                app_child.kill()
                app_child.wait(timeout=5)
        finally:
            if active_group is not None:
                # Retain only the current failed cycle's private session; settled
                # group IDs are discarded immediately to avoid later PID reuse.
                try:
                    os.killpg(active_group, signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == '__main__':
    main()
