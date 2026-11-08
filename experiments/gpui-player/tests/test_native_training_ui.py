"""Hidden native Test C4 lifecycle; isolated fixture/preferences, muted CoreAudio.
Usage: test_native_training_ui.py /path/to/singz-gpui-player /tmp/evidence
"""
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import wave

app = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='singz-training-ui-') as folder:
    root = Path(folder)
    project = root / 'song'
    (project / 'stems').mkdir(parents=True)
    with wave.open(str(project / 'stems/vocals.wav'), 'wb') as audio:
        audio.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(4000 * math.sin(i * math.tau * 220 / 48000))) for i in range(48000 * 12)))
    metadata = project / 'project.json'
    metadata.write_text(json.dumps({'version': 2, 'name': 'Training audio lifecycle fixture', 'settings': {'melody': {'detVersion': 4, 'hopSec': .025, 'f0': ' '.join(['2400'] * 480)}}}))
    original = hashlib.sha256(metadata.read_bytes()).hexdigest()
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_')}
    env.update(SINGZ_MUTE='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_CONFIG_DIR=str(root / 'prefs'), SINGZ_GPUI_TEST_PROJECT=str(project), SINGZ_GPUI_TRAINING_AUDIO_TEST=str(out))
    with (out / 'training-audio-ui.log').open('w') as log:
        result = subprocess.run([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT, timeout=90)
    assert result.returncode == 0, (out / 'training-audio-ui.log').read_text()
    assert hashlib.sha256(metadata.read_bytes()).hexdigest() == original, 'Test C4 changed song settings'
    evidence = json.loads((out / 'result.json').read_text())
    assert all(evidence[k] for k in ['nativeNoProjectTest', 'busyState', 'completionAndReap', 'leaveDuringPending', 'projectReplacement', 'loadedSongPaused', 'captureNotOpened'])
    (out / 'fixture.json').write_text(json.dumps({'projectSha256': original, 'fixtureDuration': 12, 'sampleRate': 48000, 'applicationSha256': hashlib.sha256(app.read_bytes()).hexdigest(), 'hidden': True, 'muted': True}, indent=2))
print('PASS: Test C4 without a song, completion, leave/cancel/reap, project replacement and paused loaded song')
