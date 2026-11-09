"""Hidden native Drive integration with loopback PKCE and real encoded WAVs.

No browser, Google credentials, Node, global input or foreground activation.
Screenshots are native candidates, not matched-production parity evidence.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import wave

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


fixture = module('native_drive_fixture', Path(__file__).with_name('drive_fixture.py'))
perf = module('native_drive_perf', Path(__file__).with_name('interface-perf.py'))


def foreground():
    if platform.system() == 'Darwin':
        return subprocess.run(['/usr/bin/lsappinfo', 'front'], capture_output=True,
                              text=True, timeout=2).stdout.strip()
    return None


def audio(path, frequency):
    path.parent.mkdir(parents=True, exist_ok=True)
    rate = 16000
    samples = b''.join(struct.pack('<h', round(1000*math.sin(i*math.tau*frequency/rate)))
                       for i in range(rate))
    with wave.open(str(path), 'wb') as stream:
        stream.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        stream.writeframes(samples*120)


def inventory(directory):
    return {str(p.relative_to(directory)): {'bytes': p.stat().st_size, 'sha256': sha(p)}
            for p in directory.rglob('*') if p.is_file()}


def request(base, operation):
    data = json.dumps(operation).encode()
    req = urllib.request.Request(base+'/control', data=data,
        headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=4) as response:
        assert json.load(response)['ok'] is True


class CallbackOnly(urllib.request.HTTPRedirectHandler):
    def __init__(self, callback):
        super().__init__()
        self.callback = callback

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        assert (target.scheme == 'http' and target.hostname == '127.0.0.1'
                and target.port == self.callback.port and not target.username and not target.password
                and target.path == self.callback.path == '/oauth2/callback' and not target.fragment), 'Non-local OAuth redirect'
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def authorize(base, path):
    value = json.loads(path.read_text())['url']
    parsed, allowed = urllib.parse.urlsplit(value), urllib.parse.urlsplit(base)
    assert (parsed.scheme, parsed.hostname, parsed.port, parsed.path) == (
        'http', '127.0.0.1', allowed.port, '/o/oauth2/v2/auth'), 'Non-fixture authorization URL'
    assert not parsed.username and not parsed.password and not parsed.fragment
    query = urllib.parse.parse_qs(parsed.query)
    assert query['client_id'] == ['fixture-client'] and query['code_challenge_method'] == ['S256']
    callback = urllib.parse.urlsplit(query['redirect_uri'][0])
    assert callback.hostname == '127.0.0.1' and callback.scheme == 'http' and callback.path == '/oauth2/callback'
    opener = urllib.request.build_opener(CallbackOnly(callback))
    with opener.open(value, timeout=8) as response:
        assert response.status == 200
    # Never print the URL, nonce, code, verifier or token material.


def helper_pids(pid):
    listed = subprocess.run(['pgrep', '-P', str(pid)], capture_output=True, text=True, timeout=2)
    result = []
    for value in listed.stdout.split():
        if not value.isdecimal():
            continue
        command = subprocess.run(['ps', '-p', value, '-o', 'comm='], capture_output=True,
                                 text=True, timeout=2).stdout.strip()
        if Path(command).name in ('singz-gpui-audio', 'singz-gpui-audio.exe'):
            result.append(int(value))
    return result


def remote_document(state):
    rows = [row for row in state['files'] if row['name'] == 'project.json' and not row['trashed']]
    assert len(rows) == 1, [(row['name'], row['id']) for row in rows]
    return json.loads(base64.b64decode(rows[0]['contentBase64']))


def launch(environment, folder, server, project, original):
    folder.mkdir(parents=True, exist_ok=True)
    (folder/'acks').mkdir(exist_ok=True)
    before, started = foreground(), time.monotonic()
    samples, errors, previous = [], [], {}
    handled, callbacks, spools = set(), set(), {}
    baseline = None
    with (folder/'drive.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=environment, stdout=log, stderr=subprocess.STDOUT)
        if platform.system() == 'Darwin':
            try:
                cpu, memory = perf.process_usage(child.pid)
                previous[child.pid] = cpu, time.monotonic()
                baseline = {'cpuNanoseconds': cpu, 'footprintBytes': memory}
            except OSError as error:
                errors.append({'phase': 'baseline', 'error': str(error)})
        next_sample = time.monotonic()+.1
        intervals = 0
        try:
            while child.poll() is None:
                assert time.monotonic()-started < 120, 'Native Drive UI timeout'
                for path in sorted(folder.glob('authorization-url-*.json')):
                    if path.name not in callbacks:
                        authorize(server.base, path)
                        callbacks.add(path.name)
                for path in sorted((folder/'requests').glob('*.json')):
                    if path.name in handled:
                        continue
                    value = json.loads(path.read_text())
                    operation = value['operation']
                    if operation == 'arm-upload':
                        request(server.base, {'gates': {'upload': True}})
                    elif operation == 'upload-held':
                        if server.state.snapshot()['gates']['upload']['waiting'] == 0:
                            continue
                        if path.stem.startswith('first-held-'):
                            width = path.stem.rsplit('-', 1)[1]
                            private_root = (Path(environment['SINGZ_GPUI_CONFIG_DIR'])/'gdrive/spool').resolve()
                            candidates = list(private_root.glob('sync-*/'+project.name+'/project.json'))
                            assert len(candidates) == 1, 'Expected exactly one active private project spool'
                            assert not candidates[0].is_symlink(), 'Private spool must be an ordinary file'
                            spool = candidates[0].resolve()
                            assert spool.is_relative_to(private_root), 'Upload spool escaped the isolated private root'
                            captured = spool.read_bytes()
                            document = json.loads(captured)
                            assert document['settings']['tracks']['bass']['muted'] is False
                            spools[width] = spool, hashlib.sha256(captured).hexdigest()
                            (folder/(path.stem+'-spool.json')).write_text(json.dumps(document, indent=2))
                    elif operation == 'release-upload':
                        if path.stem.startswith('release-first-'):
                            width = path.stem.rsplit('-', 1)[1]
                            spool, captured_hash = spools[width]
                            assert sha(spool) == captured_hash, 'Native Save mutated the in-flight private upload spool'
                            latest = json.loads((folder/f'during-upload-save-{width}.json').read_text())
                            assert latest['settings']['tracks']['bass']['muted'] is True
                            (folder/(path.stem+'-spool-proof.json')).write_text(json.dumps({
                                'privateSpoolSha256Before': captured_hash, 'privateSpoolSha256AfterSave': sha(spool),
                                'capturedMuted': False, 'latestSavedMuted': True}, indent=2))
                        request(server.base, {'release': ['upload']})
                    elif operation == 'install-blocked':
                        broken = project.parent/'Broken graph fixture'
                        shutil.copytree(project, broken)
                        raw = json.loads(json.dumps(original))
                        raw.update(name='Broken graph fixture', graphHash={
                            'format': 1, 'mtimeMs': 1, 'size': 12, 'md5': '0'*32})
                        (broken/'project.json').write_text(json.dumps(raw))
                        (broken/'graph.json').unlink(missing_ok=True)
                        empty = project.parent/'Empty native fixture'
                        empty.mkdir()
                        (empty/'project.json').write_text(json.dumps({'version': 2,
                            'name': 'Empty native fixture', 'songFile': '', 'settings': {
                                'nativeEmptyTracks': True, 'nativeOriginalDisabled': True, 'custom': []}}))
                    elif operation == 'remote-proof':
                        actual = server.state.snapshot()
                        document = remote_document(actual)
                        assert document['foreign'] == original['foreign']
                        if path.stem.startswith('followup-proof-'):
                            assert document['settings']['tracks']['bass']['muted'] is True, document
                            # The save during upload must earn a second metadata
                            # publication, not merely a local clean badge.
                            complete = [row for row in actual['requests']
                                if row['operation'] == 'upload' and row['status'] in (200, 201)]
                            assert len(complete) >= 2
                        (folder/(path.stem+'-remote.json')).write_text(json.dumps(actual, indent=2))
                    else:
                        raise AssertionError(operation)
                    (folder/'acks'/path.name).write_text(json.dumps({'ok': True}))
                    handled.add(path.name)
                if time.monotonic() >= next_sample:
                    now = time.monotonic()
                    if platform.system() == 'Darwin':
                        try:
                            for pid in [child.pid, *helper_pids(child.pid)]:
                                try:
                                    cpu, memory = perf.process_usage(pid)
                                    old = previous.get(pid)
                                    if old:
                                        samples.append({'role': 'app' if pid == child.pid else 'native-helper',
                                            'pid': pid, 'elapsedSeconds': now-started,
                                            'cpuPercent': (cpu-old[0])/((now-old[1])*1e9)*100,
                                            'footprintBytes': memory})
                                    previous[pid] = cpu, now
                                except OSError as error:
                                    errors.append({'phase': 'sample', 'role': 'app' if pid == child.pid else 'native-helper', 'error': str(error)})
                            gpu = perf.gpu_usage()
                            samples.append({'role': 'system-gpu', 'elapsedSeconds': now-started, 'gpu': gpu})
                        except (OSError, subprocess.TimeoutExpired) as error:
                            errors.append({'phase': 'inventory', 'error': str(error)})
                    intervals += 1
                    next_sample = time.monotonic()+(.1 if intervals < 2 else .5)
                time.sleep(.01)
            child.wait(timeout=5)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            request(server.base, {'release': ['upload', 'list', 'download', 'token']})
    lifetime, after = time.monotonic()-started, foreground()
    (folder/'foreground.json').write_text(json.dumps({'before': before, 'after': after,
        'unchanged': before == after, 'method': 'read-only; no activation or global input'}, indent=2))
    cpu = [row['cpuPercent'] for row in samples if row.get('role') == 'app']
    assert all(math.isfinite(row['cpuPercent']) and row['cpuPercent'] >= 0 and row['footprintBytes'] >= 0
               for row in samples if 'cpuPercent' in row), samples
    (folder/'performance.json').write_text(json.dumps({'samples': samples, 'baseline': baseline,
        'errors': errors, 'lifetimeSeconds': lifetime, 'appCpuAvailable': bool(cpu),
        'helperCpuAvailable': any(row.get('role') == 'native-helper' for row in samples),
        'scope': 'observed GPUI/native helper CPU and memory; GPU system-wide, fixture server excluded',
        'liveFps': {'available': False, 'reason': 'Hidden macOS windows suspend display callbacks'},
        'visualParity': 'native candidate only; no matched production reference'}, indent=2))
    assert before == after, 'Foreground application changed'
    assert child.returncode == 0 and (folder/'result.json').exists(), (folder/'drive.log').read_text()
    assert not (folder/'failure.txt').exists(), (folder/'failure.txt').read_text() if (folder/'failure.txt').exists() else ''
    if platform.system() == 'Darwin':
        assert cpu or lifetime < .25, (lifetime, errors)


with tempfile.TemporaryDirectory(prefix='singz-drive-ui-') as temporary:
    root = Path(temporary).resolve()
    project = root/'library'/'Drive song fixture'
    audio(project/'stems/vocals.wav', 220)
    audio(project/'stems/bass.wav', 110)
    original = {'version': 2, 'name': 'Drive song fixture', 'foreign': {'preserve': 17},
        'savedAt': '2026-11-01T00:00:00Z', 'settings': {
            'tempo': 1, 'transpose': 0, 'masterVolume': .61, 'loop': False,
            'tracks': {'vocals': {'volume': .37, 'muted': False, 'solo': False},
                       'bass': {'volume': .7, 'muted': False, 'solo': False}},
            'beat': {'beats': [i*.5 for i in range(240)], 'bpm': 120, 'beatsPerBar': 4,
                'downbeat': 0, 'downbeats': list(range(0, 240, 4)), 'autoDownbeats': list(range(0, 240, 4)),
                'source': 'auto', 'detVersion': 23},
            'melody': {'detVersion': 4, 'hopSec': .01, 'f0': ' '.join(['2400']*12000)},
            'metronome': {'click': False, 'countInBars': 0, 'volume': .3, 'accent': True, 'grid': False}}}
    (project/'project.json').write_text(json.dumps(original))
    (project/'lyrics.json').write_text(json.dumps({'source': 'edited', 'credit': 'Native fixture',
        'lines': [{'time': 0, 'text': 'Keep the song playing', 'words': [
            {'text': 'Keep', 'start': 0, 'end': 1}, {'text': 'the', 'start': 1, 'end': 2},
            {'text': 'song', 'start': 2, 'end': 3}, {'text': 'playing', 'start': 3, 'end': 4}]}]}))
    (project/'foreign.txt').write_text('Foreign content must survive Drive and native Save.')
    original_files = inventory(project)
    server = fixture.Server()
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    environment = {key: value for key, value in os.environ.items()
        if not key.startswith('SINGZ_GPUI_') and key not in (
            'SINGZ_NO_SYNC', 'SINGZ_GDRIVE_CONFIG', 'SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS')}
    environment.update(SINGZ_MUTE='1', SINGZ_NO_SYSTEM_ENGINES='1', SINGZ_GPUI_BACKGROUND='1',
        SINGZ_GPUI_TEST_NO_CAPTURE='1', SINGZ_GPUI_CONFIG_DIR=str(root/'prefs'),
        SINGZ_GPUI_PROJECTS_ROOT=str(root/'library'), SINGZ_GPUI_TEST_PROJECT=str(project),
        SINGZ_PACK_DIR=str(root/'missing-pack'), SINGZ_MODELS_DIR=str(root/'missing-models'),
        SINGZ_GDRIVE_CONFIG=json.dumps({'clientId': 'fixture-client', 'clientSecret': 'fixture-secret',
            'authBase': server.base, 'apiBase': server.base, 'uploadBase': server.base}))
    helper = app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')
    font_root = Path(__file__).resolve().parents[4]/'singz-ui/gpui/assets/fonts'
    (out/'fixture.json').write_text(json.dumps({'appSha256': sha(app), 'helperSha256': sha(helper),
        'fixtureServerSha256': sha(Path(__file__).with_name('drive_fixture.py')),
        'fontFiles': {str(p.relative_to(font_root)): sha(p) for p in font_root.rglob('*') if p.is_file()},
        'original': original, 'files': original_files, 'viewports': [[1280,800],[1060,640]],
        'source': ['DropScreen.tsx', 'ProjectPicker.tsx'], 'scale': 2, 'hidden': True, 'muted': True,
        'noNode': True, 'liveFps': 'unmeasured', 'visualParity': 'native candidate only'}, indent=2))
    try:
        for stage in ('exercise', 'restart'):
            launch({**environment, 'SINGZ_GPUI_DRIVE_TEST': str(out/stage),
                    'SINGZ_GPUI_DRIVE_STAGE': stage}, out/stage, server, project, original)
            actual = inventory(project)
            for name, value in original_files.items():
                if name != 'project.json':
                    assert actual[name] == value, (name, actual[name], value)
            raw = json.loads((project/'project.json').read_text())
            assert raw['foreign'] == original['foreign']
            assert raw['settings']['tracks'] == original['settings']['tracks'], raw['settings']['tracks']
            assert raw['settings']['beat'] == original['settings']['beat']
            session = json.loads((root/'prefs/gdrive/session.json').read_text())
            proof = {'generation': session['generation'], 'tokensPresent': session['tokens'] is not None}
            (out/stage/'account-persistence-proof.json').write_text(json.dumps(proof, indent=2))
            assert proof['tokensPresent'] is (stage == 'exercise')
            if os.name != 'nt':
                assert (root/'prefs/gdrive/session.json').stat().st_mode & 0o077 == 0
            stage_result = json.loads((out/stage/'result.json').read_text())
            if stage == 'exercise':
                assert stage_result['actualLibraryDriveFocusRecovery'] is True, stage_result
            for width, height in ((1280,800),(1060,640)):
                names = (f'restored-{width}', f'restored-picker-{width}') if stage == 'restart' else (
                    f'uploading-{width}', f'playing-upload-save-{width}', f'pending-followup-{width}',
                    f'synced-{width}', f'cancelled-{width}', f'picker-synced-{width}', f'sync-log-{width}')
                for name in names:
                    state = json.loads((out/stage/(name+'.json')).read_text())
                    assert state['viewport'] == [width,height] and state['hidden'] and state['scale'] == 2, name
                    from PIL import Image
                    assert Image.open(out/stage/(name+'.png')).size == (width*2,height*2), name
                if stage == 'exercise':
                    uploading = json.loads((out/stage/f'uploading-{width}.json').read_text())
                    cancelled = json.loads((out/stage/f'cancelled-{width}.json').read_text())
                    # Catalog deliberately pauses the covered transport. The
                    # adapter separately resumes actual Player playback while
                    # HTTP is held and after cancellation; those receipts must
                    # prove both UI and native progress in the same epoch.
                    for paused in (uploading, cancelled):
                        assert paused['screen'] == 2 and paused['playing'] is False and paused['native']['playing'] is False, paused
                        assert paused['drive']['scheduler']['dirty'] != 0, paused
                    assert uploading['drive']['busy'] is True and uploading['drive']['captureProject'] is None, uploading
                    assert cancelled['drive']['busy'] is False and 'Sync paused' in cancelled['drive']['progress'], cancelled
                    held = json.loads((out/stage/f'catalog-paused-held-{width}.json').read_text())
                    playing_held = json.loads((out/stage/f'playing-held-upload-{width}.json').read_text())
                    playing_cancelled = json.loads((out/stage/f'playing-after-cancel-{width}.json').read_text())
                    busy_focus = json.loads((out/stage/f'busy-focus-recovered-{width}.json').read_text())
                    cancel_focus = json.loads((out/stage/f'cancel-focus-recovered-{width}.json').read_text())
                    for receipt in (held, playing_held, playing_cancelled, busy_focus, cancel_focus):
                        assert receipt['viewport'] == [width,height] and receipt['hidden'] is True and receipt['scale'] == 2, receipt
                    assert held['screen'] == 2 and held['playing'] is False and held['native']['playing'] is False, held
                    assert held['drive']['busy'] is True and held['drive']['captureProject'] is None and held['drive']['scheduler']['dirty'] != 0, held
                    assert held['epoch'] == uploading['epoch'] == playing_held['epoch'], playing_held
                    assert playing_held['screen'] == 1 and playing_held['playing'] is True and playing_held['native']['playing'] is True, playing_held
                    assert playing_held['position'] > held['position'] + .25 and playing_held['native']['position'] > held['native']['position'], playing_held
                    assert playing_held['drive']['busy'] is True and playing_held['drive']['captureProject'] is None, playing_held
                    assert playing_held['drive']['scheduler']['lastSync'] == held['drive']['scheduler']['lastSync'], playing_held
                    assert playing_cancelled['screen'] == 1 and playing_cancelled['playing'] is True and playing_cancelled['native']['playing'] is True, playing_cancelled
                    assert playing_cancelled['epoch'] == cancelled['epoch'] == busy_focus['epoch'] == cancel_focus['epoch'], playing_cancelled
                    assert playing_cancelled['position'] > cancelled['position'] + .25 and playing_cancelled['native']['position'] > cancelled['native']['position'], playing_cancelled
                    assert playing_cancelled['drive']['busy'] is False and playing_cancelled['drive']['scheduler']['dirty'] != 0, playing_cancelled
                    assert 'Sync paused' in playing_cancelled['drive']['progress'], playing_cancelled
                    assert playing_cancelled['drive']['scheduler']['lastSync'] == cancelled['drive']['scheduler']['lastSync'] == busy_focus['drive']['scheduler']['lastSync'], playing_cancelled
                    for focused in (busy_focus, cancel_focus):
                        assert focused['screen'] == 2 and focused['playing'] is False and focused['native']['playing'] is False, focused
                        assert focused['library']['driveOwnsFocus'] is True and focused['library']['validFocus'] is True, focused
                        assert focused['headerFocused'] is None and focused['searchFocused'] is False, focused
                        assert focused['library']['focusedControl'] in focused['library']['enabledControls'], focused
                    assert busy_focus['drive']['signedIn'] is True and busy_focus['drive']['busy'] is True, busy_focus
                    assert busy_focus['library']['focusedControl'] in ('library-drive-cancel', 'library-drive-browse'), busy_focus
                    assert 'library-drive-sync' not in busy_focus['library']['enabledControls'], busy_focus
                    assert cancel_focus['drive']['busy'] is False and cancel_focus['drive']['scheduler']['dirty'] != 0, cancel_focus
                    assert cancel_focus['library']['focusedControl'] == 'library-drive-sync', cancel_focus
                    assert 'library-drive-cancel' not in cancel_focus['library']['enabledControls'], cancel_focus
                    if width == 1280:
                        signing_in = json.loads((out/stage/'signin-focus-recovered-1280.json').read_text())
                        assert signing_in['drive']['signingIn'] is True and signing_in['drive']['signedIn'] is False, signing_in
                        assert signing_in['screen'] == 2 and signing_in['searchFocused'] is True and signing_in['headerFocused'] is None, signing_in
                        assert signing_in['library']['driveOwnsFocus'] is False and signing_in['library']['validFocus'] is True, signing_in
                        assert signing_in['library']['focusedControl'] is None and signing_in['epoch'] == held['epoch'], signing_in
        final = server.state.snapshot()
        assert final['oauth']['authorizations'] == 2 and final['oauth']['codeExchanges'] == 2, final['oauth']
        assert remote_document(final)['settings']['tracks']['bass']['muted'] is False
        blocked = json.loads((out/'exercise/blocked-real-projects.json').read_text())
        # Windows can preserve the verbatim prefix even after Path.resolve.
        # Compare actual filesystem identities and reject aliases of one project.
        states = []
        for directory, status in blocked['drive']['projects'].items():
            identity = Path(directory)
            assert all(not identity.samefile(previous) for previous, _ in states), (
                'Duplicate project identity', directory)
            states.append((identity, status))
        for name in ('Broken graph fixture', 'Empty native fixture'):
            expected = project.parent/name
            assert [status for identity, status in states if identity.samefile(expected)] == ['blocked']
        assert blocked['drive']['scheduler']['dirty'] != 0
        (out/'result.json').write_text(json.dumps({'actualOAuthCallbacks': 2, 'stages': 2, 'sizesPerStage': 2,
            'realUploadSaveFollowup': True, 'realCancellation': True, 'actualBlockedProjects': True,
            'catalogPauseAndVisiblePlayerPlayback': True, 'libraryDriveFocusRecovery': True,
            'privateAccountRestoredThenTombstoned': True, 'foreignFilesPreserved': True,
            'foregroundUnchanged': True, 'liveFps': 'unmeasured', 'visualParity': 'unqualified candidate'}, indent=2))
    finally:
        server.stop()
        server_thread.join(timeout=5)
        server.server_close()
        (out/'fixture-server-state.json').write_text(json.dumps(server.state.snapshot(), indent=2))
