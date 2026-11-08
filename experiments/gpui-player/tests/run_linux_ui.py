"""Run a native workflow on a private X server; never activate windows or inject OS input."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

from PIL import Image
from Xlib import X, display, error as xerror

DRIVERS = {
    'key': 'test_native_project_key_ui.py',
    'graph': 'test_native_graph_ui.py',
    'settings': 'test_native_settings.py',
    'empty': 'test_native_empty_project_ui.py',
    'recovery': 'test_native_audio_recovery.py',
    'publication': 'test_native_audio_recovery.py',
    'publication-live': 'test_native_audio_recovery.py',
    'monitor-publication': 'test_native_monitor_publication.py',
    'monitor': 'test_native_monitor_ui.py',
    'training-recovery': 'test_native_training_recovery.py',
    'training-recovery-song': 'test_native_training_recovery.py',
    'training-run': 'test_native_training_run.py',
    'training-input-recovery': 'test_native_training_input_recovery.py',
    'training-input-completing': 'test_native_training_input_recovery.py',
    'source': 'test_native_source.py',
    'drive': 'test_native_drive_ui.py',
    'adoption': 'test_native_drive_adoption_ui.py',
    'title': 'test_native_title.py',
    'import': 'test_native_library_import.py',
    'delete': 'test_native_project_delete.py',
    'recording': 'test_native_training_recording.py',
    'recording-recovery': 'test_native_training_recording_recovery.py',
    'recording-publication': 'test_native_recording_publication_recovery.py',
    'recording-publication-helper': 'test_native_recording_publication_recovery.py',
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
parser.add_argument('--case', choices=DRIVERS, required=True)
parser.add_argument('--display', default=':97')
parser.add_argument('--timeout', type=float, default=900)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
paths = {app: 'ui', **{app.with_name(name): 'helper' for name in
    ('singz-gpui-audio', 'singz-gpui-input', 'singz-analyze')}}
hz, page = os.sysconf('SC_CLK_TCK'), os.sysconf('SC_PAGE_SIZE')


def process(pid):
    try:
        tail = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
        return {'pid': pid, 'startTicks': tail[19], 'state': tail[0],
                'ticks': int(tail[11]) + int(tail[12]), 'rssBytes': int(tail[21]) * page,
                'executable': Path(f'/proc/{pid}/exe').resolve(strict=True)}
    except (FileNotFoundError, ProcessLookupError):
        return None


def same_live(owner):
    current = process(owner['pid'])
    return current and current['startTicks'] == owner['startTicks'] and current['state'] != 'Z'


def processes():
    for path in Path('/proc').iterdir():
        if path.name.isdigit():
            value = process(int(path.name))
            if value and value['executable'] in paths:
                yield value


def stop_owned(owner, sig):
    try:
        descriptor = os.pidfd_open(owner['pid'])
    except ProcessLookupError:
        return
    try:
        if same_live(owner):
            signal.pidfd_send_signal(descriptor, sig)
    finally:
        os.close(descriptor)


assert not list(processes()), 'A native process from this app directory is already running'
services, owned, samples, frames, previous = [], {}, [], {}, {}
foreground_samples = []
server = driver = bus_owner = None
started = time.monotonic()
passed, failure, before, after = False, None, None, None
artifacts = [{'file': p.name, 'sha256': sha(p)} for p in paths if p.is_file()]
with tempfile.TemporaryDirectory(prefix='singz-linux-ui-runtime-') as runtime:
    env = {**os.environ, 'DISPLAY': args.display, 'GPUI_X11_SCALE_FACTOR': '2',
           'XDG_RUNTIME_DIR': runtime, 'LIBGL_ALWAYS_SOFTWARE': '1',
           'SINGZ_GPUI_BACKGROUND': '1', 'SINGZ_MUTE': '1', 'SINGZ_NO_SYNC': '1',
           'SINGZ_NO_SYSTEM_ENGINES': '1', 'SINGZ_LANG': 'en', 'PYTHONUTF8': '1'}
    env.pop('WAYLAND_DISPLAY', None)
    try:
        for name, command in [('xvfb', ['Xvfb', args.display, '-screen', '0',
                '2880x1800x24', '-dpi', '192', '-nolisten', 'tcp', '-ac'])]:
            with (out / f'{name}.log').open('wb') as log:
                services.append(subprocess.Popen(command, stdout=log, stderr=log, env=env))
        time.sleep(1)
        assert services[0].poll() is None, 'Private X server did not start; existing displays are never reused'
        bus = subprocess.check_output(['dbus-daemon', '--session', '--fork',
            '--print-address=1', '--print-pid=1'], env=env, text=True, timeout=10).splitlines()
        env['DBUS_SESSION_BUS_ADDRESS'] = bus[0]
        bus_owner = process(int(bus[1]))
        with (out / 'openbox.log').open('wb') as log:
            services.append(subprocess.Popen(['openbox', '--sm-disable'], stdout=log, stderr=log, env=env))
        time.sleep(1)
        assert all(p.poll() is None for p in services), 'Private display service exited'
        server = display.Display(args.display)
        root = server.screen().root
        active_atom = server.intern_atom('_NET_ACTIVE_WINDOW')
        pid_atom = server.intern_atom('_NET_WM_PID')
        motif_atom = server.intern_atom('_MOTIF_WM_HINTS')

        def foreground():
            value = root.get_full_property(active_atom, X.AnyPropertyType)
            return list(map(int, value.value)) if value is not None else []

        def windows(window):
            try:
                children = window.query_tree().children
            except xerror.BadWindow:
                return
            for child in children:
                yield child
                yield from windows(child)

        before = foreground()
        with (out / 'vulkan-summary.log').open('wb') as log:
            subprocess.run(['vulkaninfo', '--summary'], env=env, stdout=log,
                           stderr=subprocess.STDOUT, timeout=30)
        command = [sys.executable, str(Path(__file__).with_name(DRIVERS[args.case])),
                   str(app), str(out / 'workflow')]
        if args.case == 'publication':
            command.append('--publication-fault')
        elif args.case == 'publication-live':
            command.append('--live-publication-fault')
        elif args.case == 'training-recovery-song':
            command.append('--song-backed')
        elif args.case == 'training-input-completing':
            command.append('--completing')
        elif args.case == 'recording-publication-helper':
            command.append('--helper-stage')
        with (out / 'driver.stdout.log').open('wb') as stdout, (out / 'driver.stderr.log').open('wb') as stderr:
            driver = subprocess.Popen(command, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
            while driver.poll() is None:
                now = time.monotonic()
                assert now - started < args.timeout, 'Workflow exceeded its bounded timeout'
                assert all(p.poll() is None for p in services), 'Private display service exited'
                current = list(processes())
                for value in current:
                    key = (value['pid'], value['startTicks'])
                    role = paths[value['executable']]
                    owned[key] = {'pid': value['pid'], 'startTicks': value['startTicks'],
                                  'role': role, 'executable': str(value['executable'])}
                    prior = previous.get(key)
                    cpu = 100 * (value['ticks'] - prior[0]) / hz / (now - prior[1]) if prior else None
                    samples.append({**owned[key], 'seconds': now - started,
                                    'cpuPercentOneCore': cpu, 'rssBytes': value['rssBytes']})
                    previous[key] = (value['ticks'], now)
                active = foreground()
                foreground_samples.append({'seconds': now - started, 'window': active})
                assert active == before, 'Private display foreground changed'
                for window in windows(root):
                    try:
                        prop = window.get_full_property(pid_atom, X.AnyPropertyType)
                        if prop is None or not any(k[0] == int(prop.value[0]) for k in owned):
                            continue
                        assert window.get_attributes().map_state == X.IsUnmapped, 'Native test window became mapped'
                        geometry = window.get_geometry()
                        hints = window.get_full_property(motif_atom, X.AnyPropertyType)
                        frames[window.id] = {'pid': int(prop.value[0]), 'windowId': window.id,
                            'width': geometry.width, 'height': geometry.height, 'mapped': False,
                            'motifHints': list(map(int, hints.value)) if hints is not None else []}
                    except (xerror.BadWindow, xerror.BadDrawable):
                        # A window can disappear between inventory and inspection.
                        continue
                time.sleep(.25)
        assert driver.returncode == 0, 'Native workflow driver failed; inspect driver logs'
        after = foreground()
        assert after == before, 'Private display foreground changed at completion'
        app_count = sum(v['role'] == 'ui' for v in owned.values())
        expected_count = 3 if args.case in ('settings', 'empty', 'recovery', 'publication') else 2 if args.case in ('key', 'graph', 'drive', 'adoption') else 1
        assert app_count == expected_count, f'Expected {expected_count} app processes, observed {app_count}'
        assert any(v['width'] > 1 and v['height'] > 1 for v in frames.values()), 'No native client window observed'
        remaining = list(processes())
        for value in remaining:
            owned[(value['pid'], value['startTicks'])] = {
                'pid': value['pid'], 'startTicks': value['startTicks'],
                'role': paths[value['executable']], 'executable': str(value['executable'])}
        assert not remaining, 'Native process survived the workflow'
        captures = []
        for png in sorted((out / 'workflow').rglob('*.png')):
            with Image.open(png) as image:
                width, height = image.size
                image.verify()
            expected_pixels = ((2480, 1640),) if args.case == 'key' else ((2560, 1600), (2120, 1280))
            assert (width, height) in expected_pixels, f'Unexpected viewport: {png}'
            captures.append({'file': str(png.relative_to(out)), 'sha256': sha(png),
                'pixels': [width, height], 'logicalViewport': [width / 2, height / 2], 'deviceScale': 2})
        assert captures, 'No renderer captures produced'
        passed = True
    except Exception as error:
        failure = f'{type(error).__name__}: {error}'
        captures = []
    finally:
        if driver and driver.poll() is None:
            os.killpg(driver.pid, signal.SIGTERM)
            try:
                driver.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(driver.pid, signal.SIGKILL)
                driver.wait(timeout=5)
        for value in owned.values():
            stop_owned(value, signal.SIGTERM)
        deadline = time.monotonic() + 5
        while any(same_live(value) for value in owned.values()) and time.monotonic() < deadline:
            time.sleep(.1)
        for value in owned.values():
            stop_owned(value, signal.SIGKILL)
        if server:
            server.close()
        for child in reversed(services):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
        if bus_owner and same_live(bus_owner):
            stop_owned(bus_owner, signal.SIGTERM)
        (out / 'runner.json').write_text(json.dumps({'passed': passed, 'case': args.case,
            'failure': failure, 'appSha256': sha(app), 'artifacts': artifacts,
            'privateDisplay': args.display, 'foregroundBefore': before, 'foregroundAfter': after,
            'foregroundSamples': foreground_samples, 'frames': list(frames.values()),
            'ownedProcesses': list(owned.values()), 'samples': samples, 'captures': captures,
            'gpu': {'available': False, 'reason': 'Per-process GPU counters not collected',
                    'renderNodes': [str(p) for p in Path('/dev/dri').glob('renderD*')]},
            'liveFps': None, 'performanceScope': 'UI and native C++ helper CPU/RSS; active workflow including readbacks; live display cadence unmeasured',
            'nativeFrameScope': 'Unmapped X11 clients and decoration hints; shown native frame not qualified',
            'productionParity': 'unqualified'}, indent=2) + '\n')
if failure:
    raise SystemExit(failure)
print(f'PASS {args.case}: {len(captures)} captures, hidden native windows, unchanged private-display foreground')
