#!/usr/bin/env python3
"""One hidden muted native app: raw Save holds monitor lease until header Stop.

Requires a ui-tests build and sibling native audio helper. Generates only synthetic
PCM in isolated profiles/library; never builds, activates windows or sends OS input.
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
import sys
import subprocess
import tempfile
import threading
import time
import wave

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
parser.add_argument('--held-output-adapter', action='store_true',
                    help='Add held saving state plus queued default Output controller intent during Stop cleanup')
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
source = Path(__file__).resolve().parents[1] / 'src/ui_monitor_publication.rs'
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()


def tone(path, rate, seconds):
    with wave.open(str(path), 'wb') as audio:
        audio.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(5000 * math.sin(i * math.tau * 220 / rate)))
                                   for i in range(rate * seconds)))


def foreground():
    if platform.system() != 'Darwin':
        return None
    p = subprocess.run(['/usr/bin/lsappinfo', 'front'], capture_output=True, text=True, timeout=3)
    return {'returncode': p.returncode, 'identity': p.stdout.strip()}


@contextlib.contextmanager
def lyrics_miss_server():
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'[]' if self.path.startswith('/api/search') else b'{"message":"fixture miss"}'
            self.send_response(200 if self.path.startswith('/api/search') else 404)
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
assert app.is_file() and helper.is_file(), 'Requires built GPUI app and sibling native helper'
for name in ['result.json', 'failure.txt']:
    (out / name).unlink(missing_ok=True)
binary_hash, helper_hash, source_hash = sha(app), sha(helper), sha(source)
front_before = foreground()
with tempfile.TemporaryDirectory(prefix='singz-monitor-publication-') as folder, lyrics_miss_server() as url:
    root = Path(folder).resolve()
    raw, mic = root / 'Raw monitor publication.wav', root / 'Microphone.wav'
    tone(raw, 48000, 12)
    tone(mic, 16000, 1)
    raw_hash, mic_hash = sha(raw), sha(mic)
    config, library = root / 'preferences', root / 'library'
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in {
        'SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS', 'SINGZ_MUTE', 'SINGZ_NO_SYNC', 'SINGZ_NO_SYSTEM_ENGINES'}}
    env.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
               SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
               SINGZ_GPUI_CONFIG_DIR=str(config), SINGZ_GPUI_PROJECTS_ROOT=str(library),
               SINGZ_GPUI_AUDIO_HELPER=str(helper), SINGZ_GPUI_CAPTURE_FIXTURE=str(mic),
               SINGZ_GPUI_MONITOR_PUBLICATION_TEST=str(out), SINGZ_GPUI_MONITOR_PUBLICATION_RAW=str(raw),
               SINGZ_GPUI_ANALYZER=str(root / 'missing-analyzer'), SINGZ_GPUI_LRCLIB_URL=url,
               SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
               SINGZ_DEMUCS=str(root / 'missing-demucs'))
    if args.held_output_adapter:
        env['SINGZ_GPUI_MONITOR_PUBLICATION_ADAPTER'] = '1'
    resources, stop, started = [], threading.Event(), time.monotonic()
    with (out / 'native-monitor-publication.log').open('w') as log:
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
                'liveFps': {'available': False, 'reason': 'hidden captures do not measure live display cadence'}}, indent=2))
    assert front_before == front_after, 'Foreground app identity changed during hidden run'
    assert child.returncode == 0 and (out / 'result.json').is_file(), (out / 'native-monitor-publication.log').read_text()
    result = json.loads((out / 'result.json').read_text())
    if result.get('platformUnavailablePolicy') is True:
        assert platform.system() in ['Windows', 'Linux'], result
        assert result['publicationWorkflowExercised'] is False
        assert result['actualDisabledMonitorClick'] and result['headphonesConfirmed'] and result['noNativeLeaseAcquired']
        assert result['hardwareMonitoringQualified'] is False and result['reason']
        assert 'not exercised' in result['policyScope'] and 'nativeAdvance' not in result
        assert result['hidden'] and result['muted']
        assert sha(out / 'working-project.json') == result['workingMetadataSha256']
        assert sha(out / 'raw-source.wav') == raw_hash == result['rawSourceSha256']
        assert Path(result['workingDir']).resolve().is_relative_to(config.resolve() / 'source-work')
        probes = json.loads((out / 'native-probes.json').read_text())
        assert len(probes) == 3
        assert all(row['helperPid'] == result['originalHelperPid'] and row['epoch'] == result['epoch']
                   and not row['monitorLeased'] and not row['parked'] and not row['playing']
                   and abs(row['position'] - 2) < .03 and row['sampleAgeSeconds'] < 1 for row in probes)
        sidecars = sorted(out.glob('*.state.json'))
        assert len(sidecars) == 2 and len(list(out.glob('*.png'))) == 2
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
            assert state['fixtureSha256'] == raw_hash and state['microphoneSha256'] == mic_hash
            assert state['binarySha256'] == binary_hash and state['testSourceSha256'] == source_hash
            assert state['epoch'] == result['epoch'] and state['platformUnavailablePolicy']
            assert state['monitorRouteError'] == result['reason']
            assert state['micPhase'] == 'Off' and state['micOwner'] == 0 and not state['micIntent']
            assert not any(state[key] for key in ['requested', 'parked', 'pending', 'monitorBusy', 'playing'])
            assert state['notice'] is None and state['publicationEpoch'] is None
            assert state['sourceWorking'] and state['project']['dir'] == result['workingDir']
        (out / 'fixture.json').write_text(json.dumps({'appSha256': binary_hash, 'helperSha256': helper_hash,
            'testSourceSha256': source_hash, 'sourceFilesSha256': {str(p.relative_to(source.parent.parent)): sha(p) for p in [source, source.with_name('main.rs'), source.with_name('settings.rs'), source.with_name('integration.rs')]},
            'rawPcmSha256': raw_hash, 'microphonePcmSha256': mic_hash, 'platform': platform.platform(),
            'noNode': True, 'muted': True, 'hidden': True, 'isolatedLibrary': True,
            'platformUnavailablePolicy': True, 'publicationWorkflowExercised': False,
            'hardwareMonitoringQualified': False, 'policyScope': result['policyScope'],
            'persistedEvidence': ['working-project.json', 'raw-source.wav'],
            'productionParity': 'not evaluated'}, indent=2))
        print('PASS: policy only; disabled native Monitor preserves Windows/Linux platform-unavailable policy and paused playback; publication workflow not exercised')
        raise SystemExit(0)
    flags = ['connectedRawPublication', 'actualSettingsMonitor', 'headphonesRequired', 'actualEscape',
             'actualHeaderSave', 'sameNativeEpoch', 'sameMicrophoneGeneration', 'nativeSequenceAdvanced',
             'nativeLeaseHeldThroughoutSave', 'adoptedExactPublication', 'deferredUntilHeaderStop',
             'actualHeaderStop', 'stopReleasesInput', 'stopRecoversPaused', 'explicitPlay', 'hidden', 'muted']
    assert all(result.get(key) is True for key in flags), result
    assert result['heldSavingStateAdapter'] is args.held_output_adapter
    assert result['explicitOutputQueuedDuringCleanup'] is args.held_output_adapter
    assert result['automaticHeaderStopRecovery'] is (not args.held_output_adapter)
    assert result['hardwareMonitoringQualified'] is False
    assert result['nativeAdvance']['to'] > result['nativeAdvance']['from'] + .04
    published = Path(result['publishedDir']).resolve()
    assert published.is_relative_to(library.resolve()) and published.is_dir()
    metadata = published / 'project.json'
    saved = json.loads(metadata.read_text())
    assert sha(metadata) == result['publishedMetadataSha256'] == sha(out / 'published-project.json')
    assert sha(published / saved['songFile']) == raw_hash == result['publishedAudioSha256'] == sha(out / 'published-original.wav')
    assert saved['settings']['tempo'] == .8 and saved['settings']['transpose'] == -2
    assert saved['settings']['masterVolume'] == .6 and saved['settings']['loop'] is True
    probes = json.loads((out / 'native-probes.json').read_text())
    assert result['originalHelperPid'] != result['replacementHelperPid']
    assert result['concurrentSecondWriterExercised'] is False
    assert result['actualOutputSelectorExercised'] is False
    if args.held_output_adapter:
        assert 'Player::select_output("")' in result['stopRecoveryAdapterScope']
        assert 'not an actual selector/UI route test' in result['stopRecoveryAdapterScope']
    else:
        assert 'no held saving state or controller Output adapter is used' in result['stopRecoveryAdapterScope']
    assert 'no real concurrent second writer' in result['stopRecoveryAdapterScope']
    assert all(row['epoch'] == result['epoch'] and row['sampleAgeSeconds'] < 1 for row in probes)
    for row in probes:
        expected_pid = result['replacementHelperPid'] if row['stage'] in ['stopped', 'playing-from', 'playing-to'] else result['originalHelperPid']
        assert row['helperPid'] == expected_pid, row
    leased = [row for row in probes if row['stage'] in ['before-save', 'save']]
    assert len(leased) >= 2
    assert all(row['monitorLeased'] and row['parked'] and row['physicalOutputReleased'] and not row['playing'] for row in leased)
    stopped = [row for row in probes if row['stage'] == 'stopped']
    assert len(stopped) == 1 and not stopped[0]['monitorLeased'] and not stopped[0]['parked']
    sidecars = sorted(out.glob('monitor-*.state.json'))
    assert len(sidecars) == (7 if args.held_output_adapter else 6)
    held_rows = [row for row in probes if row['stage'] == 'stop-held-saving-adapter']
    assert len(held_rows) == (1 if args.held_output_adapter else 0)
    for sidecar in sidecars:
        state = json.loads(sidecar.read_text())
        png = sidecar.with_name(sidecar.name.removesuffix('.state.json') + '.png')
        data = png.read_bytes()
        assert data[:8] == b'\x89PNG\r\n\x1a\n'
        dimensions = list(struct.unpack('>II', data[16:24]))
        assert dimensions == state['imagePixels'] and sha(png) == state['screenshotSha256']
        assert state['viewport'] in [[1280, 800], [1060, 640]]
        assert all(abs(dimensions[i] - state['viewport'][i] * state['scale']) <= 2 for i in [0, 1])
        assert state['hidden'] and state['hiddenConfigured'] and state['mutedConfigured']
        assert not state['windowPresented'] and not state['windowActive']
        assert state['fixtureSha256'] == raw_hash and state['microphoneSha256'] == mic_hash
        assert state['binarySha256'] == binary_hash and state['testSourceSha256'] == source_hash
        assert state['epoch'] == result['epoch']
        assert state['heldSavingStateAdapter'] is args.held_output_adapter
        assert state['stopRecoveryAdapterScope'] == result['stopRecoveryAdapterScope']
        if sidecar.name.startswith('monitor-published-'):
            assert state['publicationEpoch'] == state['epoch'] and state['tracksAudioFailed']
            assert not state['audioRecoveryPending'] and not state['publicationPending'] and not state['sourceWorking']
            assert state['requested'] and state['parked'] and state['micPhase'] == 'Monitoring' and state['micOwner'] == 3
            assert state['generation'] == result['generation'] and state['fixture'] and not state['audibleMonitor']
        if sidecar.name.startswith('monitor-stop-held-saving-adapter-'):
            assert args.held_output_adapter
            assert state['saving'] and state['publicationEpoch'] == state['epoch']
            assert state['queuedActionCount'] == state['queuedOutputCount'] == state['queuedDefaultOutputCount'] == 1
            assert not state['audioRecoveryPending'] and state['tracksAudioFailed']
            assert state['micPhase'] == 'Off' and state['micOwner'] == 0 and not state['monitorBusy']
            assert 'no real concurrent second writer' in state['stopRecoveryAdapterScope']
        if sidecar.name.startswith('monitor-stopped-'):
            assert state['queuedActionCount'] == state['queuedOutputCount'] == state['queuedDefaultOutputCount'] == 0
            assert state['micPhase'] == 'Off' and state['micOwner'] == 0 and not state['monitorBusy']
            assert state['publicationEpoch'] is None and not state['audioRecoveryPending'] and not state['tracksAudioFailed']
            assert not state['playing'] and abs(state['native']['position'] - 2) < .03
    (out / 'fixture.json').write_text(json.dumps({'appSha256': binary_hash, 'helperSha256': helper_hash,
        'testSourceSha256': source_hash, 'sourceFilesSha256': {str(p.relative_to(source.parent.parent)): sha(p) for p in [source, source.with_name('main.rs'), source.with_name('integration.rs'), source.with_name('integration_recovery.rs')]}, 'rawPcmSha256': raw_hash, 'microphonePcmSha256': mic_hash,
        'platform': platform.platform(), 'noNode': True, 'muted': True, 'hidden': True,
        'isolatedLibrary': True, 'localLyricsMissServer': True, 'analyzerAndModels': 'absent isolated paths',
        'persistedEvidence': ['published-project.json', 'published-original.wav'],
        'heldSavingStateAdapter': args.held_output_adapter,
        'stopRecoveryAdapterScope': result['stopRecoveryAdapterScope'],
        'hardwareMonitoringQualified': False, 'productionParity': 'not evaluated'}, indent=2))
print('PASS: connected raw Save keeps native monitoring leased; header Stop restores paused saved project; explicit Play advances')
