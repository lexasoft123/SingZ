"""Loaded-song preparation through hidden native GPUI, no Node or hardware input."""
import hashlib,json,math,os,struct,subprocess,sys,tempfile,wave
from pathlib import Path
app=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='singz-preparation-') as folder:
    root=Path(folder);projects=[];original={}
    for name,key in [('known',{'pc':11,'minor':True,'detVersion':2}),('unknown',{'pc':4,'minor':False,'detVersion':1})]:
        project=root/name;(project/'stems').mkdir(parents=True)
        with wave.open(str(project/'stems/vocals.wav'),'wb') as audio:
            audio.setparams((1,2,48000,0,'NONE','not compressed'))
            audio.writeframes(b''.join(struct.pack('<h',int(4000*math.sin(i*math.tau*220/48000))) for i in range(48000*12)))
        metadata=project/'project.json';metadata.write_text(json.dumps({'version':2,'name':f'{name.title()} key fixture','settings':{'transpose':2,'key':key,'melody':{'detVersion':4,'hopSec':.025,'f0':' '.join(['2400']*480)}}}))
        original[metadata]=hashlib.sha256(metadata.read_bytes()).hexdigest();projects.append(project)
    fixture=root/'a3.wav'
    with wave.open(str(fixture),'wb') as audio:
        audio.setparams((1,2,16000,0,'NONE','not compressed'));audio.writeframes(b''.join(struct.pack('<h',int(8000*math.sin(i*math.tau*220/16000))) for i in range(16000)))
    env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_')}
    env.update(SINGZ_MUTE='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(root/'prefs'),SINGZ_GPUI_CAPTURE_FIXTURE=str(fixture),SINGZ_GPUI_TEST_PROJECT=str(projects[0]),SINGZ_GPUI_UNKNOWN_PROJECT=str(projects[1]),SINGZ_GPUI_TRAINING_PREPARATION_TEST=str(out))
    with (out/'preparation.log').open('w') as log:r=subprocess.run([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=130)
    assert r.returncode==0,(out/'preparation.log').read_text()
    for metadata,sha in original.items():assert hashlib.sha256(metadata.read_bytes()).hexdigest()==sha,'Preparation mutated saved key/analysis'
    result=json.loads((out/'result.json').read_text());assert all(result[k] for k in ['setupFirst','keyStampAndTranspose','rangePreserved','nativePreparedScore','summaryBackToPausedSong','replacementInvalidatesContext','unknownKeyManualSetup'])
    (out/'fixture.json').write_text(json.dumps({'applicationSha256':hashlib.sha256(app.read_bytes()).hexdigest(),'projects':{p.parent.name:sha for p,sha in original.items()},'captureSha256':hashlib.sha256(fixture.read_bytes()).hexdigest(),'hidden':True,'muted':True,'hardwareInput':False},indent=2))
print('PASS: four source song recipes, explicit setup, stamped/transposed key, real native prepared score, paused song return and stale-load invalidation')
