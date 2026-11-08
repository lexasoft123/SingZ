"""Hidden real device Settings, persisted restart, and unavailable-route repair.
Requires the native helper and a --features ui-tests application build. Never alters
OS defaults. Every active output is forced muted. Fixtures/preferences are isolated.
Run: python3 test_native_settings.py /path/to/singz-gpui-player /tmp/evidence
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
app=Path(sys.argv[1]).resolve()
out=Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='singz-native-settings-') as folder:
    root=Path(folder);project=root/'Project';(project/'stems').mkdir(parents=True)
    with wave.open(str(project/'stems/vocals.wav'),'wb') as stream:
        stream.setparams((1,2,48000,0,'NONE','not compressed'))
        stream.writeframes(b''.join(struct.pack('<h',int(7000*math.sin(i*math.tau*220/48000))) for i in range(48000*12)))
    (project/'project.json').write_text(json.dumps({'version':2,'name':'Native Settings fixture','settings':{'melody':{'detVersion':4,'hopSec':.025,'f0':' '.join(['2400']*480)}}}))
    config=root/'preferences'
    def run(name,extra=None):
        env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_')}
        env.update(SINGZ_MUTE='1',SINGZ_GPUI_TEST_NO_CAPTURE='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(config),SINGZ_GPUI_TEST_PROJECT=str(project),SINGZ_GPUI_AUDIO_SETTINGS=str(out/name))
        env.update(extra or {})
        with (out/(name+'.log')).open('w') as log:
            result=subprocess.run([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=90)
        assert result.returncode==0,(out/(name+'.log')).read_text()
    run('initial')
    saved=json.loads((config/'audio.json').read_text());assert saved['outputUid']
    run('restart')
    assert json.loads((config/'audio.json').read_text())['outputUid']==saved['outputUid']
    (config/'audio.json').write_text(json.dumps({'outputUid':'missing-saved-output','future':'keep'}))
    run('missing-saved-output',{'SINGZ_GPUI_SETTINGS_MISSING_START':'1'})
    assert json.loads((config/'audio.json').read_text())['future']=='keep'
    (out/'result.json').write_text(json.dumps({'initial':True,'restart':True,'missingSavedOutputRecovery':True,'savedOutputUid':saved['outputUid']},indent=2))
    print('PASS: real native Settings; output persistence across restart; unavailable saved output repair without fallback')
