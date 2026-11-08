"""Real training UI completions -> process restart -> restored native progress.
No hardware input, foreground window, Node, or shared production preferences.
"""
import hashlib,json,math,os,struct,subprocess,sys,tempfile,wave
from pathlib import Path
app=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='singz-training-progress-') as folder:
    root=Path(folder);fixture=root/'a3.wav'
    with wave.open(str(fixture),'wb') as audio:
        audio.setparams((1,2,16000,0,'NONE','not compressed'))
        audio.writeframes(b''.join(struct.pack('<h',int(8000*math.sin(i*math.tau*220/16000))) for i in range(16000)))
    base={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_')}
    base.update(SINGZ_MUTE='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(root/'prefs'),SINGZ_GPUI_CAPTURE_FIXTURE=str(fixture))
    for name,flag in [('practice','SINGZ_GPUI_TRAINING_RUN_TEST'),('restart','SINGZ_GPUI_TRAINING_HISTORY_TEST'),('restart-program','SINGZ_GPUI_TRAINING_HISTORY_TEST')]:
        env={**base,flag:str(out/name)}
        if name=='restart-program':env['SINGZ_GPUI_EXPECT_PROGRAM']='1'
        with (out/(name+'.log')).open('w') as log:
            result=subprocess.run([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=90)
        assert result.returncode==0,(out/(name+'.log')).read_text()
    receipts=list((root/'prefs/training-receipts').glob('*.json'));assert len(receipts)==2
    for path in receipts:
        value=json.loads(path.read_text());assert path.stem==hashlib.sha256(value['sessionId'].encode()).hexdigest()
        assert value['aggregate']['attempts']==1 and value['aggregate']['sessions']==1
        for forbidden in ['rawAudio','observations','microphone','prompts','targets','cues']:assert forbidden not in path.read_text()
    (out/'fixture.json').write_text(json.dumps({'applicationSha256':hashlib.sha256(app.read_bytes()).hexdigest(),'pcmSha256':hashlib.sha256(fixture.read_bytes()).hexdigest(),'restarts':2,'receiptCount':2,'hidden':True,'muted':True,'hardwareInput':False},indent=2))
    for path in (root/'prefs').glob('*.json'):(out/path.name).write_bytes(path.read_bytes())
    (out/'receipts.json').write_text(json.dumps([json.loads(p.read_text()) for p in receipts],indent=2))
print('PASS: native completed practice survives two restarts; profile/program restored; partial, silent and repeated work cannot inflate credit')
