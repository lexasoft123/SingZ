"""Actual Windows native provider controls, ownership refusal and persisted restart.

Run with the ui-tests EXE and an isolated evidence directory. This driver never
executes Node, opens capture, changes OS defaults or activates a window. Windows
run_windows_ui.ps1 supplies the independent helper retirement/GPU/frame observer.
"""
import argparse
import contextlib
import ctypes
from ctypes import wintypes
import hashlib
import http.server
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import threading
import time
import wave


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


@contextlib.contextmanager
def lyrics_miss_server():
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'[]' if self.path.startswith('/api/search') else b'{"message":"private fixture miss"}'
            self.send_response(200 if self.path.startswith('/api/search') else 404)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/api'
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


class MemoryCounters(ctypes.Structure):
    _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD),
               ('PeakWorkingSetSize', ctypes.c_size_t), ('WorkingSetSize', ctypes.c_size_t),
               ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t),
               ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t), ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
               ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t)]


def observe(app, folder, env):
    """Observe the actual app identity/counters without activating its window."""
    folder.mkdir()
    user = ctypes.WinDLL('user32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    user.GetForegroundWindow.restype = wintypes.HWND
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(MemoryCounters), wintypes.DWORD]
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    before = int(user.GetForegroundWindow() or 0)
    assert before, 'Foreground identity unavailable before launch'
    samples, fronts, rejected = [], [], []
    started = time.monotonic()
    handle = None
    previous = None
    forced = False
    with (folder / 'app.log').open('w', encoding='utf-8') as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            handle = kernel.OpenProcess(0x1000 | 0x0010, False, child.pid)
            assert handle, f'Cannot observe owned app PID {child.pid}'
            while child.poll() is None:
                assert time.monotonic() - started < 180, 'Provider UI journey deadline'
                current = int(user.GetForegroundWindow() or 0)
                fronts.append(current)
                assert current == before, 'Foreground changed during hidden provider workflow'
                created, exited, sys_time, usr_time = (wintypes.FILETIME() for _ in range(4))
                memory = MemoryCounters()
                memory.cb = ctypes.sizeof(memory)
                ok_times = kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(sys_time), ctypes.byref(usr_time))
                ok_memory = psapi.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb)
                now = time.monotonic()
                if not ok_times or not ok_memory:
                    terminal = child.poll() is not None
                    rejected.append({'terminal': terminal, 'winerror': ctypes.get_last_error()})
                    assert terminal, 'Live app resource counter failed'
                    break
                integer = lambda value: (value.dwHighDateTime << 32) | value.dwLowDateTime
                cpu = (integer(sys_time) + integer(usr_time)) / 10_000_000
                percent = 100 * (cpu - previous[0]) / (now - previous[1]) if previous else None
                assert memory.WorkingSetSize > 0 and (percent is None or math.isfinite(percent) and percent >= 0)
                samples.append({'pid': child.pid, 'creationTime100ns': integer(created), 'elapsedSeconds': now - started,
                                'cpuSeconds': cpu, 'cpuPercentOneCore': percent, 'rssBytes': memory.WorkingSetSize})
                previous = cpu, now
                time.sleep(.1)
            child.wait(timeout=8)
        finally:
            if child.poll() is None:
                forced = True
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
            if handle:
                kernel.CloseHandle(handle)
            after = int(user.GetForegroundWindow() or 0)
            (folder / 'process-exit.json').write_text(json.dumps({'pid': child.pid, 'returncode': child.returncode,
                'forced': forced, 'wallSeconds': time.monotonic() - started}, indent=2))
            (folder / 'foreground.json').write_text(json.dumps({'before': before, 'after': after, 'samples': fronts,
                'unchanged': after == before and all(front == before for front in fronts)}, indent=2))
            (folder / 'interface-metrics.json').write_text(json.dumps({'samples': samples, 'rejected': rejected,
                'cpuScope': 'Owned UI process, one-core percentage', 'memoryScope': 'Owned UI working set',
                'gpu': 'Independent Windows runner supplies per-owned-app engine counters',
                'helperRetirement': 'Independent Windows runner supplies start-time-qualified helper identities',
                'liveFps': 'unmeasured: hidden static captures do not qualify display cadence'}, indent=2))
    assert not forced and child.returncode == 0, (folder / 'app.log').read_text(encoding='utf-8', errors='replace')
    assert samples and after == before, 'Missing resource/foreground evidence'
    result = json.loads((folder / 'result.json').read_text())
    assert result['actualWindows'] and result['actualControls'] and result['hidden'] and result['muted']
    assert not result['hardwareInput'] and not result['fixtureBackend']
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    assert os.name == 'nt', 'Actual Windows is required; this test has no synthetic platform mode'
    app, out = args.app.resolve(strict=True), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    # Never erase an earlier failed fixture/evidence batch.
    root = out / 'private-fixture'
    root.mkdir()
    prefs, library = root / 'prefs', root / 'library'
    for directory in [prefs, library, root / 'tmp', root / 'cache']:
        directory.mkdir()
    helper = app.with_name('singz-gpui-audio.exe')
    assert helper.is_file()
    identities = {'appSha256': sha(app), 'helperSha256': sha(helper)}
    seed = {'nativeAudioProvider': 'asio', 'outputUid': 'asio:private-unavailable-output',
            'inputUid': 'private-raw-microphone-uid', 'monitorOutputUid': 'private-raw-monitor-uid',
            'future': {'keep': [17, 'private provider preference']}, 'karaoke': False}
    (prefs / 'audio.json').write_text(json.dumps(seed), encoding='utf-8')
    sentinel = root / 'must-survive.txt'
    sentinel.write_text('Outside all actual project deletion targets.\n')
    sentinel_hash = sha(sentinel)
    source = root / 'source.wav'
    block = b''.join(struct.pack('<h', int(1800 * math.sin(i * math.tau * 220 / 16000))) for i in range(16000))
    with wave.open(str(source), 'wb') as stream:
        stream.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        stream.writeframes(block * 120)
    import shutil
    original = sha(source)
    fixture_projects = {}
    for width in (1280, 1060):
        project = library / f'provider-{width}'
        (project / 'stems').mkdir(parents=True)
        shutil.copyfile(source, project / 'stems' / 'vocals.wav')
        raw = {'version': 2, 'name': f'Provider ownership {width}', 'savedAt': '2026-11-09T12:00:00Z',
               'settings': {'melody': {'detVersion': 4, 'hopSec': .025, 'f0': ' '.join(['2400'] * 4800)},
                            'key': {'pc': 9, 'minor': True, 'detVersion': 2}}, 'foreign': {'private': True}}
        (project / 'project.json').write_text(json.dumps(raw), encoding='utf-8')
        fixture_projects[str(width)] = {'path': str(project), 'metadataSha256': sha(project / 'project.json'), 'audioSha256': original}
    catalog = root / 'model-catalog.json'
    catalog.write_text(json.dumps({'flavor': 'linux', 'entries': []}))
    (out / 'fixture.json').write_text(json.dumps({**identities, 'projects': fixture_projects, 'privateRoot': str(root),
        'preferences': str(prefs), 'library': str(library), 'sourceSha256': original, 'seed': seed,
        'noNode': True, 'actualWindowsAvailability': True, 'physicalAudioAudibility': 'unqualified',
        'visualReference': 'candidate captures only; no production parity claim'}, indent=2))
    with lyrics_miss_server() as lyrics_url:
        env = {key: value for key, value in os.environ.items() if not key.startswith('SINGZ_')}
        env.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1', SINGZ_GPUI_BACKGROUND='1',
            SINGZ_GPUI_TEST_NO_CAPTURE='1', SINGZ_GPUI_CONFIG_DIR=str(prefs), SINGZ_GPUI_PROJECTS_ROOT=str(library),
            SINGZ_GPUI_AUDIO_HELPER=str(helper), SINGZ_PACK_DIR=str(root / 'missing-pack'),
            SINGZ_MODELS_DIR=str(root / 'missing-models'), SINGZ_LLAMA_SERVER=str(root / 'missing-llama'),
            SINGZ_CRISPASR=str(root / 'missing-crispasr'), SINGZ_GPUI_MODEL_FIXTURE=str(catalog),
            SINGZ_GPUI_LRCLIB_URL=lyrics_url, TMPDIR=str(root / 'tmp'), TMP=str(root / 'tmp'), TEMP=str(root / 'tmp'),
            XDG_CACHE_HOME=str(root / 'cache'), HF_HOME=str(root / 'cache' / 'huggingface'),
            TORCH_HOME=str(root / 'cache' / 'torch'), PYTHONDONTWRITEBYTECODE='1')
        preflight = subprocess.run([str(helper), '--providers'], env=env, capture_output=True, text=True,
                                   timeout=15, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
        availability = json.loads(preflight.stdout)
        assert availability['protocol'] == 1 and availability['ok'] and availability['platform'] == 'win32'
        assert any(row['id'] == 'wasapi' and row['compiled'] and row['available'] for row in availability['providers'])
        assert any(row['id'] == 'asio' and not row['available'] and row['detail'] for row in availability['providers'])
        (out / 'availability.json').write_text(json.dumps(availability, indent=2))
        results = []
        for name in ('first', 'restart'):
            selected_env = dict(env, SINGZ_GPUI_AUDIO_PROVIDER_TEST=str(out / name))
            if name == 'restart':
                selected_env['SINGZ_GPUI_AUDIO_PROVIDER_RESTART'] = '1'
            result = observe(app, out / name, selected_env)
            assert result['restart'] == (name == 'restart')
            expected = ('restart', 'menu', 'wasapi') if name == 'restart' else ('unloaded', 'menu', 'wasapi', 'playing-disabled', 'paused-disabled', 'retired-reenabled')
            for width in (1280, 1060):
                for phase in expected:
                    basename = out / name / f'{phase}-{width}'
                    assert basename.with_suffix('.png').stat().st_size > 0
                    state = json.loads(basename.with_suffix('.state.json').read_text())
                    assert state['hidden'] and not state['active'] and state['capture']['owner'] == 0
                    assert state['viewport'] == [width, 800 if width == 1280 else 640]
                    assert state['provider']['availability']['platform'] == 'win32'
                if name == 'first':
                    assert not Path(fixture_projects[str(width)]['path']).exists(), 'Actual project Delete did not finish'
            if name == 'first':
                assert len(result['probes']) == 6, 'Missing same-worker refusal or native owned receipts'
                assert (out / name / 'unavailable-open-1280.png').is_file()
                for row in result['probes']:
                    if row['phase'] == 'owned-after-refusals':
                        assert row['helperPid'] > 0 and row['native']['provider'] == 'wasapi'
                        assert row['native']['backendProvider'] == 'wasapi' and row['native']['fixture'] is False
            saved = json.loads((prefs / 'audio.json').read_text())
            assert saved['nativeAudioProvider'] == 'wasapi' and saved['outputUid'] == ''
            assert {key: saved[key] for key in seed if key not in ('nativeAudioProvider', 'outputUid')} == {key: value for key, value in seed.items() if key not in ('nativeAudioProvider', 'outputUid')}
            assert sha(source) == original and sha(sentinel) == sentinel_hash
            assert sha(app) == identities['appSha256'] and sha(helper) == identities['helperSha256']
            results.append({'name': name, 'result': str(out / name / 'result.json'), 'preferencesSha256': sha(prefs / 'audio.json')})
    assert results[0]['preferencesSha256'] == results[1]['preferencesSha256'], 'Persisted restart wrote unchanged preferences'
    (out / 'result.json').write_text(json.dumps({'passed': True, 'actualWindows': True, 'runs': results,
        'noNode': True, 'hidden': True, 'hardwareInput': False, 'liveFps': 'unmeasured',
        'retainedPrivateFixture': str(root), 'scope': 'Actual Windows native provider availability, controls, ownership refusal, deletion retirement and persisted restart; candidate captures, no visual parity claim'}, indent=2))
    print('PASS: actual Windows provider controls, disabled ASIO, WASAPI persistence, owner refusal and real Delete retirement at both sizes')


if __name__ == '__main__':
    main()
