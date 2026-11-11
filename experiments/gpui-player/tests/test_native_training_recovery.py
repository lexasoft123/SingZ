#!/usr/bin/env python3
"""Hidden connected Identify output failure/retry with an owned native helper.

Run independently without a song, then with --song-backed. The latter proves
that actual Continue stays disabled until actual Settings Retry restores the song.
No hardware microphone, vocal runtime, recordings or physical hotplug is tested.
"""
import argparse
import contextlib
import hashlib
import http.server
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import struct
import subprocess
import tempfile
import threading
import time
import wave

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
parser.add_argument('--song-backed', action='store_true', help='Retain a dirty synthetic song and recover it through Settings Retry before Continue')
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
source = Path(__file__).resolve().parents[1] / 'src/ui_training_recovery.rs'
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()


def tone(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    rate = 48000
    with wave.open(str(path), 'wb') as audio:
        audio.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(5000 * math.sin(i * math.tau * 220 / rate))) for i in range(rate * 12)))


def foreground():
    if platform.system() != 'Darwin':
        return None
    p = subprocess.run(['/usr/bin/lsappinfo', 'front'], capture_output=True, text=True, timeout=3)
    return {'returncode': p.returncode, 'identity': p.stdout.strip()}


@contextlib.contextmanager
def lyrics_miss_server():
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            found = self.path.startswith('/api/search')
            body = b'[]' if found else b'{"message":"fixture miss"}'
            self.send_response(200 if found else 404)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/api'
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=3)


spec = importlib.util.spec_from_file_location('interface_perf', Path(__file__).with_name('interface-perf.py'))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)
helper = app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')
assert app.is_file() and helper.is_file(), 'Requires built ui-tests app and native helper'
for name in ['result.json', 'failure.txt']:
    (out / name).unlink(missing_ok=True)
binary_hash, helper_hash, source_hash = sha(app), sha(helper), sha(source)
front_before = foreground()
with tempfile.TemporaryDirectory(prefix='singz-training-recovery-') as temporary, lyrics_miss_server() as lyrics_url:
    root = Path(temporary).resolve()
    config, library = root / 'preferences', root / 'library'
    fixture = root / 'synthetic.wav'
    tone(fixture)
    fixture_hash = sha(fixture)
    project = library / 'Retained training song'
    (project / 'stems').mkdir(parents=True)
    (project / 'stems/vocals.wav').write_bytes(fixture.read_bytes())
    (project / 'project.json').write_text(json.dumps({'version': 2, 'name': project.name,
        'settings': {'tempo': 1, 'transpose': 0, 'masterVolume': 1, 'loop': False,
            'view': {'s': 0, 'e': 12},
            'tracks': {'vocals': {'volume': 1, 'muted': False, 'solo': False}},
            'metronome': {'click': False, 'countInBars': 0, 'volume': .7, 'accent': True, 'grid': False}},
        'foreignFixture': 'preserve-training-song'}, indent=2))
    (project / 'lyrics.json').write_text(json.dumps({'source': 'edited', 'lines': [
        {'start': 0, 'end': 4, 'text': 'Retain the song and exercise'},
        {'start': 4, 'end': 8, 'text': 'Resume only after output retry'},
        {'start': 8, 'end': 12, 'text': 'Continue the same session'}]}))
    metadata_hash, lyrics_hash = sha(project / 'project.json'), sha(project / 'lyrics.json')
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in {
        'SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS', 'SINGZ_MUTE', 'SINGZ_NO_SYNC', 'SINGZ_NO_SYSTEM_ENGINES'}}
    env.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
               SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
               SINGZ_GPUI_CONFIG_DIR=str(config), SINGZ_GPUI_PROJECTS_ROOT=str(library),
               SINGZ_GPUI_AUDIO_HELPER=str(helper), SINGZ_GPUI_TRAINING_RECOVERY_TEST=str(out),
               SINGZ_GPUI_TRAINING_RECOVERY_FIXTURE=str(fixture),
               SINGZ_GPUI_ANALYZER=str(root / 'missing-analyzer'), SINGZ_GPUI_LRCLIB_URL=lyrics_url,
               SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
               SINGZ_DEMUCS=str(root / 'missing-demucs'))
    if args.song_backed:
        env['SINGZ_GPUI_TRAINING_RECOVERY_PROJECT'] = str(project)
    resources, stop, started = [], threading.Event(), time.monotonic()
    with (out / 'native-training-recovery.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT)

        def sample():
            previous = None
            while not stop.wait(.4):
                if platform.system() != 'Darwin':
                    resources.append({'available': False, 'reason': 'macOS process counters unavailable'})
                    return
                try:
                    cpu, memory = perf.process_usage(child.pid)
                    now = time.monotonic()
                    if previous:
                        resources.append({'elapsedSeconds': now - started,
                            'processCpuPercent': (cpu - previous[0]) / ((now - previous[1]) * 1e9) * 100,
                            'processFootprintBytes': memory, 'gpuSystem': perf.gpu_usage()})
                    previous = cpu, now
                except (OSError, RuntimeError):
                    return

        worker = threading.Thread(target=sample, daemon=True)
        worker.start()
        try:
            child.wait(timeout=150)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            stop.set()
            worker.join(timeout=4)
            front_after = foreground()
            (out / 'performance.json').write_text(json.dumps({
                'scope': 'GPUI main process CPU/footprint; excludes helpers; GPU system-wide',
                'wallSeconds': time.monotonic() - started, 'samples': resources,
                'foregroundBefore': front_before, 'foregroundAfter': front_after,
                'liveFps': {'available': False, 'reason': 'hidden captures do not measure display cadence'}}, indent=2))
    assert front_before == front_after, 'Hidden run changed foreground application'
    assert child.returncode == 0 and (out / 'result.json').is_file(), (out / 'native-training-recovery.log').read_text()
    result = json.loads((out / 'result.json').read_text())
    required = ['actualStart', 'actualFirstCorrectAnswer', 'faultedOwnedNativeHelper',
                'retainedSameSessionAndPrompt', 'retainedFirstReceipt', 'specificRunErrorRetained',
                'noAutomaticCueOrScore', 'actualNoticeEscape', 'actualExplicitContinue', 'freshNativeReplay',
                'actualSecondCorrectAnswer', 'completedSameSession', 'identifyWithoutMicrophone',
                'stalePausedControllerReceiptIgnored', 'staleFreshCueControllerReceiptIgnored', 'hidden', 'muted']
    assert all(result.get(key) is True for key in required), result
    assert result['songBacked'] is args.song_backed and result['persistedHistoryCount'] == 1
    assert all(result[key] is args.song_backed for key in ['songContinueDisabled', 'directContinueBlocked', 'actualSettingsRetry', 'dirtySongRetained'])
    assert not any(result[key] for key in ['hardwareMicrophoneQualified', 'vocalRuntimeExercised', 'otherScreenNavigationExercised', 'recordingsExercised'])
    assert result['originalHelperPid'] != result['replacementHelperPid']
    assert result['replayCueGeneration'] > result['oldCueGeneration'] > 0
    assert 'not native receipt injection' in result['staleReceiptScope'] and result['error']
    first = result['firstReceipt']
    assert first['promptIndex'] == 1 and first['correct'] is True
    assert result['finalReceipts'][0] == first
    assert len(result['finalReceipts']) == 2 and result['finalReceipts'][1]['correct'] is True
    before = json.loads((out / 'before-fault.json').read_text())
    completed = json.loads((out / 'completed-state.json').read_text())
    assert before['session']['id'] == completed['session']['id'] == result['sessionId']
    assert before['session']['phase'] == 'Cue' and before['session']['index'] == 2
    assert before['session']['receipts'] == [first]
    assert completed['session']['phase'] == 'Summary' and completed['session']['correct'] == 2
    probes = json.loads((out / 'native-probes.json').read_text())
    assert all(p['epoch'] == result['epoch'] and p['sampleAgeSeconds'] < 1 and not p['monitorLeased'] for p in probes)
    fault = next(p for p in probes if p['stage'] == 'second-cue-before-fault')
    replay = next(p for p in probes if p['stage'] == 'second-cue-explicit-continue')
    assert fault['helperPid'] == result['originalHelperPid'] and fault['cueGeneration'] == result['oldCueGeneration']
    assert replay['helperPid'] == result['replacementHelperPid'] and replay['cueGeneration'] == result['replayCueGeneration']
    assert fault['trainingOnly'] is (not args.song_backed) and replay['trainingOnly'] is (not args.song_backed)
    assert fault['activeTraining'] == [result['epoch'], result['oldCueGeneration']]
    assert replay['activeTraining'] == [result['epoch'], result['replayCueGeneration']]
    if args.song_backed:
        recovered = next(p for p in probes if p['stage'] == 'song-settings-recovered-paused')
        assert recovered['helperPid'] == replay['helperPid'] and not recovered['playing'] and not recovered['trainingOnly']
        assert abs(recovered['position'] - 2) < .03 and abs(recovered['rate'] - .8) < .0001 and recovered['transpose'] == -2
        assert sha(project / 'project.json') == metadata_hash == sha(out / 'retained-project.json')
        assert sha(project / 'lyrics.json') == lyrics_hash and sha(project / 'stems/vocals.wav') == fixture_hash
        assert completed['editSeq'] == before['editSeq'] > before['savedSeq'] == completed['savedSeq']
        assert completed['project'] == before['project']
    sidecars = sorted(out.glob('training-*.state.json'))
    assert len(sidecars) == (7 if args.song_backed else 5)
    assert {tuple(json.loads(p.read_text())['viewport']) for p in sidecars} == {(1280, 800), (1060, 640)}
    for sidecar in sidecars:
        state = json.loads(sidecar.read_text())
        png = sidecar.with_name(sidecar.name.removesuffix('.state.json') + '.png')
        data = png.read_bytes()
        assert data[:8] == b'\x89PNG\r\n\x1a\n'
        dimensions = list(struct.unpack('>II', data[16:24]))
        assert dimensions == state['imagePixels'] and sha(png) == state['screenshotSha256']
        assert all(abs(dimensions[i] - state['viewport'][i] * state['scale']) <= 2 for i in [0, 1])
        assert state['hidden'] and state['hiddenConfigured'] and state['mutedConfigured']
        assert not state['windowPresented'] and not state['windowActive']
        assert state['fixtureSha256'] == fixture_hash and state['binarySha256'] == binary_hash and state['testSourceSha256'] == source_hash
        assert state['epoch'] == result['epoch'] and state['session']['id'] == result['sessionId']
        assert state['microphone'] == {'phase': 'Off', 'owner': 0, 'intent': False}
        assert 'not native receipt injection' in state['scope']
        if sidecar.name.startswith('training-failed-'):
            assert state['session']['phase'] == 'Paused' and state['session']['error'] == result['error']
            assert state['session']['receipts'] == [first] and state['training']['generation'] is None
            assert result['error'] in state['notice'] and state['tracksAudioFailed'] is args.song_backed
        if sidecar.name.startswith('training-continue-blocked-'):
            assert state['session']['phase'] == 'Paused' and state['tracksAudioFailed'] and not state['trainingOutputAvailable']
            assert state['training']['generation'] is None and state['session']['receipts'] == [first]
    receipt_files = sorted((config / 'training-receipts').glob('*.json'))
    assert len(receipt_files) == 1
    receipt = json.loads(receipt_files[0].read_text())
    assert receipt['sessionId'] == result['sessionId'] and receipt['aggregate']['sessions'] == 1
    (out / 'persisted-training-history.json').write_text(json.dumps(receipt, indent=2))
    (out / 'fixture.json').write_text(json.dumps({'appSha256': binary_hash, 'helperSha256': helper_hash,
        'testSourceSha256': source_hash, 'sourceFilesSha256': {str(p.relative_to(source.parent.parent)): sha(p) for p in [source, source.with_name('main.rs'), source.with_name('audio_recovery_host.rs'), source.with_name('training.rs'), source.with_name('training_run.rs')]},
        'syntheticPcmSha256': fixture_hash, 'projectMetadataSha256': metadata_hash, 'lyricsSha256': lyrics_hash,
        'platform': platform.platform(), 'songBacked': args.song_backed, 'noNode': True, 'hidden': True, 'muted': True,
        'isolatedProfilesAndLibrary': True, 'localLyricsMissServer': True, 'analyzerAndModels': 'absent isolated paths',
        'hardwareMicrophoneQualified': False, 'vocalRuntimeExercised': False, 'productionParity': 'not evaluated'}, indent=2))
print('PASS: same Identify session/first receipt survives owned native output failure; explicit retry/Continue completes second prompt (' + ('song-backed' if args.song_backed else 'standalone') + ')')
