"""Real native analysis/Save and analyzer cancellation; hidden, muted, no Node.
Run after the native-tools and --features ui-tests builds:
  python3 tests/test_native_analysis.py /absolute/path/to/singz-gpui-player /tmp/evidence
"""
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
tools = Path(os.environ.get('SINGZ_NATIVE_TEST_TOOLS', str(app.parent))).resolve()

def fixture(root):
    (root / 'stems').mkdir(parents=True)
    with wave.open(str(root / 'stems/vocals.wav'), 'wb') as stream:
        stream.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
        stream.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(i * math.tau * 220 / 48000))) for i in range(48000 * 4)))
    (root / 'project.json').write_text(json.dumps({'version': 2, 'name': 'Native analysis — голос', 'settings': {}}))

def run(project, name, extra):
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_')}
    env.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_CONFIG_DIR=str(project.parent / (name+'-prefs')), SINGZ_GPUI_PROJECTS_ROOT=str(project.parent / 'library'), SINGZ_GPUI_AUDIO_HELPER=str(tools/'singz-gpui-audio'), SINGZ_GPUI_ANALYZER=str(tools/'singz-analyze'), SINGZ_GPUI_TEST_PROJECT=str(project),
               SINGZ_GPUI_INTEGRATION_TEST=str(out / name))
    env.update(extra)
    with (out / (name + '.log')).open('w') as log:
        result = subprocess.run([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT, timeout=90)
    assert result.returncode == 0, (out / (name + '.log')).read_text()

with tempfile.TemporaryDirectory(prefix='singz-native-analysis-') as folder:
    root = Path(folder)
    real = root / 'real project'
    fixture(real)
    run(real, 'real-analysis', {'SINGZ_GPUI_TEST_ANALYSIS': '1', 'SINGZ_GPUI_TEST_SAVE': '1'})
    saved = json.loads((real / 'project.json').read_text())
    assert saved['settings']['melody']['detVersion'] == 4
    assert saved['settings']['melody']['f0']
    slow = root / 'cancel project'
    fixture(slow)
    pids = root / 'analyzer-pids'
    stub = root / 'slow-analyzer'
    stub.write_text(f'#!{sys.executable}\nimport os,time\nwith open({str(pids)!r},"a") as f:f.write(str(os.getpid())+"\\n")\ntime.sleep(100)\n')
    stub.chmod(0o700)
    run(slow, 'cancel-analysis', {'SINGZ_GPUI_ANALYZER': str(stub)})
    recorded = [int(v) for v in pids.read_text().split()]
    assert recorded, 'Analyzer cancellation test never started its analyzer'
    for pid in recorded:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        raise AssertionError(f'Analyzer {pid} survived replacement/quit')
    (out / 'analysis-result.json').write_text(json.dumps({'realDetectionAndSave': True, 'cancelledAndReapedProcesses': len(recorded)}, indent=2))
    print('PASS: native vocal analysis → pitch view → keyboard Save; cancelled analyzers reaped on replacement/quit')
