"""Hidden GPUI → native CREPE PCM replay, meters, ownership and cleanup. No Node.
No microphone hardware is opened by this driver. Run after both native and ui-tests builds:
  python3 test_native_microphone.py /path/to/singz-gpui-player /tmp/evidence
"""
import json,math,os,struct,subprocess,sys,tempfile,wave
from pathlib import Path
app=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
def tone(path,rate,seconds):
    with wave.open(str(path),'wb') as f:
        f.setparams((1,2,rate,0,'NONE','not compressed'));f.writeframes(b''.join(struct.pack('<h',int(8000*math.sin(i*math.tau*220/rate))) for i in range(rate*seconds)))
with tempfile.TemporaryDirectory(prefix='singz-microphone-ui-') as folder:
    root=Path(folder);project=root/'project';(project/'stems').mkdir(parents=True);tone(project/'stems/vocals.wav',48000,12)
    fixture=root/'microphone.wav';tone(fixture,16000,1)
    (project/'project.json').write_text(json.dumps({'version':2,'name':'Native microphone fixture','settings':{'melody':{'detVersion':4,'hopSec':.025,'f0':' '.join(['2400']*480)}}}))
    (project/'lyrics.json').write_text(json.dumps({'source':'edited','lines':[{'start':0,'end':4,'text':'Hold the note softly'},{'start':4,'end':8,'text':'Sing with the melody'},{'start':8,'end':12,'text':'Stay with the music'}]}))
    env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_')}
    config=root/'preferences';env.update(SINGZ_MUTE='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(config),SINGZ_GPUI_TEST_PROJECT=str(project),SINGZ_GPUI_CAPTURE_FIXTURE=str(fixture),SINGZ_GPUI_MICROPHONE_TEST=str(out))
    with (out/'native-microphone.log').open('w') as log:
        result=subprocess.run([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=90)
    assert result.returncode==0,(out/'native-microphone.log').read_text()
    prefs=json.loads((config/'audio.json').read_text());assert prefs['inputChannel']==0,'Corrected microphone choice was not persisted'
    assert json.loads((out/'result.json').read_text())['stopAcknowledged']
    print('PASS: native CREPE microphone fixture, matching/score/meter, input-owner handoff, invalid-channel recovery and Stop')
