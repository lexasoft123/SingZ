"""Actual Start, native cue/CREPE/scoring, completion, restart and Identify in hidden GPUI."""
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
app=Path(sys.argv[1]).resolve()
out=Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='singz-training-capture-') as folder:
    root=Path(folder);fixture=root/'a3.wav'
    with wave.open(str(fixture),'wb') as audio:
        audio.setparams((1,2,16000,0,'NONE','not compressed'))
        audio.writeframes(b''.join(struct.pack('<h',int(8000*math.sin(i*math.tau*220/16000))) for i in range(16000)))
    env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_')}
    # Use the actual product owners, with only hardware capture replaced by PCM replay.
    env.update(SINGZ_MUTE='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(root/'prefs'),SINGZ_GPUI_CAPTURE_FIXTURE=str(fixture),SINGZ_GPUI_TRAINING_RUN_TEST=str(out))
    with (out/'capture-score.log').open('w') as log:
        completed=subprocess.run([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=75)
    assert completed.returncode==0,(out/'capture-score.log').read_text()
    result=json.loads((out/'result.json').read_text())
    assert all(result[k] for k in ['actualStart','nativeCrepe','vocalOnTarget','completionHold','summaryReleasesOwners','restart','leavePauses','identifyWithoutCapture','identifyCorrect','guidedNextTarget','endReleasesOwners'])
    (out/'fixture.json').write_text(json.dumps({'inputSha256':hashlib.sha256(fixture.read_bytes()).hexdigest(),'sampleRate':16000,'frequency':220,'applicationSha256':hashlib.sha256(app.read_bytes()).hexdigest(),'hidden':True,'hardwareInput':False},indent=2))
print('PASS: actual Start -> native cues/CREPE -> scored summary, owner release, restart, pause and Identify')
