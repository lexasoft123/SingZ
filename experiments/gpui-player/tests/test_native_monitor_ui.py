"""Hidden native monitoring, persistent header Stop, and output restoration.

Uses the existing muted PCM capture fixture. No microphone hardware, Node,
global input or native window activation is involved.
"""
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
import sys
import tempfile
import threading
import time
import wave

app = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
for filename in ['result.json', 'failure.txt']:
    (out / filename).unlink(missing_ok=True)


def tone(path, rate, seconds):
    with wave.open(str(path), 'wb') as audio:
        audio.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(i * math.tau * 220 / rate)))
                                   for i in range(rate * seconds)))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


spec = importlib.util.spec_from_file_location('interface_perf', Path(__file__).with_name('interface-perf.py'))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)

with tempfile.TemporaryDirectory(prefix='singz-microphone-ui-') as folder:
    root = Path(folder).resolve()
    project = root / 'project'
    (project / 'stems').mkdir(parents=True)
    tone(project / 'stems/vocals.wav', 48000, 12)
    fixture = root / 'microphone.wav'
    tone(fixture, 16000, 1)
    (project / 'project.json').write_text(json.dumps({'version': 2, 'name': 'Native microphone fixture',
        'settings': {'beat': {'beats': [i * .5 for i in range(24)], 'bpm': 120,
            'beatsPerBar': 4, 'downbeat': 0, 'downbeats': list(range(0, 24, 4)),
            'autoDownbeats': list(range(0, 24, 4)), 'source': 'manual'},
            'melody': {'detVersion': 4, 'hopSec': .025, 'f0': ' '.join(['2400'] * 480)}}}))
    (project / 'lyrics.json').write_text(json.dumps({'source': 'edited', 'lines': [
        {'start': 0, 'end': 4, 'text': 'Hold the note softly'},
        {'start': 4, 'end': 8, 'text': 'Sing with the melody'},
        {'start': 8, 'end': 12, 'text': 'Stay with the music'}]}))
    other = root / 'older-destination'
    shutil.copytree(project, other)
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_')}
    config = root / 'preferences'
    env.update(SINGZ_MUTE='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_CONFIG_DIR=str(config),
        SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'), SINGZ_GPUI_TEST_PROJECT=str(project),
        SINGZ_GPUI_CAPTURE_FIXTURE=str(fixture), SINGZ_GPUI_MONITOR_TEST=str(out),
        SINGZ_GPUI_MONITOR_OTHER_PROJECT=str(other))
    resources, stop, started = [], threading.Event(), time.monotonic()
    with (out / 'native-microphone.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT)

        def sample():
            previous = None
            while not stop.wait(.5):
                try:
                    if platform.system() != 'Darwin':
                        resources.append({'available': False, 'reason': 'macOS process counters unavailable'})
                        return
                    cpu, memory = perf.process_usage(child.pid)
                    now = time.monotonic()
                    if previous:
                        resources.append({'elapsedSeconds': now - started,
                            'processCpuPercent': (cpu - previous[0]) / ((now - previous[1]) * 1e9) * 100,
                            'processFootprintBytes': memory, 'gpuSystem': perf.gpu_usage()})
                    previous = cpu, now
                except OSError:
                    return
        worker = threading.Thread(target=sample, daemon=True)
        worker.start()
        try:
            child.wait(timeout=90)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            stop.set()
            worker.join(timeout=4)
            (out / 'performance.json').write_text(json.dumps({
                'scope': 'main GPUI CPU/footprint; excludes audio helpers; GPU system-wide',
                'wallSeconds': time.monotonic() - started, 'samples': resources,
                'liveFps': {'available': False, 'reason': 'hidden static renders do not measure live display cadence'}}, indent=2))
    assert child.returncode == 0 and (out / 'result.json').is_file(), (out / 'native-microphone.log').read_text()
    prefs = json.loads((config / 'audio.json').read_text())
    assert prefs['monitorGainDb'] == -30, 'Live monitor gain was not persisted'
    result = json.loads((out / 'result.json').read_text())
    required = ['realPlaybackPark', 'fakeMonitoring', 'headphonesRequired', 'gainKeepsGeneration',
        'nativeRefusalRestoresPaused', 'positionPreserved', 'stopRestoresPaused', 'explicitPlay',
        'projectReplacementStopsMonitor', 'headerStopOutsideSettings', 'headerStopReleasesInput',
        'headerStopRestoresPaused', 'headerOwnerDisappears', 'typedRateStopsMonitor',
        'actualBpmStopsMonitor', 'coalescedRateSaveNavigation', 'commandsSurviveDeferredOpen',
        'latestNavigationWins', 'hidden', 'muted']
    assert all(result.get(key) is True for key in required), result
    assert result['hardwareMonitoringQualified'] is False, 'Fixture run claimed hardware qualification'
    queued = json.loads((out / 'monitor-rate-queued.json').read_text())
    trace = json.loads((out / 'monitor-rate-handoff.json').read_text())
    saved = json.loads((out / 'monitor-rate-saved-project.json').read_text())
    assert abs(queued['deferred'][0] - 1.1) < .00006 and queued['deferred'][1] == -1 and queued['rateActions'] == 1
    assert queued['saveRequested'] and queued['navigationHeld'] and not queued['loading']
    assert abs(saved['settings']['tempo'] - 1.1) < .00006 and saved['settings']['transpose'] == -1
    assert trace and any(row['nativePending'] for row in trace), 'No typed native rate request observed'
    assert all(not row['monitorBusy'] and row['micOwner'] != 3 and row['micPhase'] != 'Monitoring'
               for row in trace if row['nativePending']), 'Rate dispatched before monitor released output'
    active = json.loads((out / 'header-monitor-active.state.json').read_text())
    stopped = json.loads((out / 'header-monitor-stopped.state.json').read_text())
    assert active['header']['visible'] is True and active['micOwner'] == 3 and active['fixture'] is True
    assert active['requested'] and active['parked'] and active['monitorBusy'] and not active['audibleMonitor']
    assert stopped['header']['visible'] is False and stopped['micOwner'] == 0 and stopped['micPhase'] == 'Off'
    assert not any(stopped[key] for key in ['requested', 'parked', 'pending', 'monitorBusy', 'headphones', 'playing'])
    assert abs(stopped['position'] - active['position']) < .03, 'Header Stop changed parked song position'
    for state in [active, stopped]:
        assert not state['windowPresented'] and not state['windowActive']
        assert state['hiddenConfigured'] and state['mutedConfigured']
    (out / 'fixture.json').write_text(json.dumps({'appSha256': sha(app),
        'helperSha256': sha(app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')),
        'microphonePcmSha256': sha(fixture), 'vocalSha256': sha(project / 'stems/vocals.wav'),
        'platform': platform.platform(), 'noNode': True, 'muted': True,
        'capture': 'hidden native content and app-local input',
        'hardwareMonitoringQualified': False,
        'visualReference': 'candidate only; matching production header captures absent'}, indent=2))
print('PASS: native muted monitor park/release, live gain, Settings Stop, persistent header Stop/paused restoration, explicit Play and project replacement')
