"""Hidden real GPUI custom-track controls, native decode and encoded Save lifecycle."""
import argparse, hashlib, importlib.util, json, math, os, platform, shutil, struct, subprocess, tempfile, threading, time, wave
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('app',type=Path);p.add_argument('out',type=Path);a=p.parse_args();app=a.app.resolve();out=a.out.resolve();out.mkdir(parents=True,exist_ok=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def foreground():
 if platform.system()!='Darwin':return None
 return subprocess.run(['/usr/bin/lsappinfo','front'],capture_output=True,text=True,timeout=2).stdout.strip()
def tone(path,seconds,hz):
 path.parent.mkdir(parents=True,exist_ok=True)
 with wave.open(str(path),'wb') as f:
  f.setparams((1,2,16000,0,'NONE','not compressed'));f.writeframes(b''.join(struct.pack('<h',int(3500*math.sin(i*math.tau*hz/16000))) for i in range(int(16000*seconds))))
with tempfile.TemporaryDirectory(prefix='singz-custom-ui-') as tmp:
 root=Path(tmp).resolve();project=root/'library/Custom tracks';(project/'stems').mkdir(parents=True);tone(project/'stems/vocals.wav',3,220)
 (project/'project.json').write_text(json.dumps({'version':2,'name':'Custom tracks','settings':{'melody':{'detVersion':4,'hopSec':0.01,'f0':' '.join(['2400']*300)}},'foreign':{'keep':True}}))
 (project/'notes.txt').write_text('Keep unrelated project files.');(project/'stems/foreign-audio.txt').write_text('Keep foreign prefix.');(project/'stems/custom-unused.txt').write_text('Owned stale custom file.')
 first=root/'picked/first/Harmony_take.wav';tone(first,1.5,330)
 longwav=root/'picked/long.wav';tone(longwav,6,440);second=root/'picked/second/Harmony_take.flac';second.parent.mkdir()
 helper=app.with_name('singz-gpui-audio.exe' if os.name=='nt' else 'singz-gpui-audio')
 subprocess.run([str(helper),'--compact-stem',str(longwav),str(second)],check=True,capture_output=True)
 invalid=root/'picked/broken.wav';invalid.write_bytes(b'Invalid audio file; valid selections around it must survive.')
 original={str(x):sha(x) for x in [first,second,project/'stems/vocals.wav']}
 env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ['SINGZ_PACK_DIR','SINGZ_MODELS_DIR','SINGZ_DEMUCS']}
 env.update(SINGZ_MUTE='1',SINGZ_NO_SYNC='1',SINGZ_NO_SYSTEM_ENGINES='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(root/'prefs'),SINGZ_GPUI_PROJECTS_ROOT=str(project.parent),SINGZ_GPUI_TEST_PROJECT=str(project),SINGZ_GPUI_CUSTOM_TRACK_TEST=str(out),SINGZ_GPUI_CUSTOM_TRACK_FILES=json.dumps([str(first),str(invalid),str(second)]),SINGZ_PACK_DIR=str(root/'missing-pack'),SINGZ_MODELS_DIR=str(root/'missing-models'))
 spec=importlib.util.spec_from_file_location('interface_perf',Path(__file__).with_name('interface-perf.py'));perf=importlib.util.module_from_spec(spec);spec.loader.exec_module(perf)
 before=foreground();samples=[];stop=threading.Event();started=time.monotonic()
 with (out/'custom-tracks.log').open('w') as log:
  proc=subprocess.Popen([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT)
  def sample():
   previous=None
   while not stop.wait(.4):
    try:
     if platform.system()!='Darwin':return
     cpu,memory=perf.process_usage(proc.pid);now=time.monotonic()
     if previous:samples.append({'elapsedSeconds':now-started,'processCpuPercent':(cpu-previous[0])/((now-previous[1])*1e9)*100,'processFootprintBytes':memory,'gpuSystem':perf.gpu_usage()})
     previous=cpu,now
    except OSError:return
  thread=threading.Thread(target=sample,daemon=True);thread.start()
  try:proc.wait(timeout=150)
  finally:
   if proc.poll() is None:proc.kill();proc.wait(timeout=5)
   stop.set();thread.join(timeout=4)
 (out/'performance.json').write_text(json.dumps({'samples':samples,'scope':'GPUI app only; helper separate; GPU system-wide','liveFps':{'available':False,'reason':'hidden window display cadence unmeasured'}},indent=2))
 after=foreground();assert before==after,(before,after)
 (out/'foreground.json').write_text(json.dumps({'before':before,'after':after,'unchanged':True},indent=2))
 assert proc.returncode==0 and (out/'result.json').exists(),(out/'custom-tracks.log').read_text()
 for width in [1280,1060]:
  raw=json.loads((out/f'saved-{width}.json').read_text());custom=raw['settings']['custom'];assert len(custom)==2
  assert len({t['id'] for t in custom})==2 and custom[0]['label']=='Renamed harmony 🎤'
  assert custom[0]['file'].endswith('.wav') and custom[1]['file'].endswith('.flac')
  assert raw['foreign']=={'keep':True}
  receipt=json.loads((out/f'saved-media-{width}.json').read_text());assert receipt=={custom[0]['id']:original[str(first)],custom[1]['id']:original[str(second)]},receipt
 result=json.loads((out/'result.json').read_text());project=Path(result['finalProject'])
 for path in [first,second]:assert sha(path)==original[str(path)],str(path)
 assert sha(project/'stems/vocals.wav')==original[str(root/'library/Custom tracks/stems/vocals.wav')]
 raw=json.loads((project/'project.json').read_text());assert not raw['settings'].get('custom')
 assert (project/'notes.txt').read_text()=='Keep unrelated project files.' and (project/'stems/foreign-audio.txt').exists()
 assert not list((project/'stems').glob('custom-*')),'Removed custom media were not pruned'
 assert not (project/'.singz-native-split.json').exists(),'Private transaction journal residue'
 shutil.copytree(project,out/'final-project',dirs_exist_ok=True)
 (out/'fixture.json').write_text(json.dumps({'appSha256':sha(app),'helperSha256':sha(helper),'originalMedia':original,'hidden':True,'muted':True,'noNode':True,'fixturePickerBoundary':True,'chooserPresentation':'not exercised','encodedOriginalsPreserved':True},indent=2))
print('PASS: hidden two-size custom Add/Rename/Save/reopen/Remove, native playback/duration and encoded hashes')
