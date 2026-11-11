"""Three hidden GPUI processes: final Remove/Save, Copy/Move, restart-empty/Add/Save."""
import argparse, hashlib, importlib.util, json, math, os, platform, shutil, struct, subprocess, tempfile, threading, time, wave
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('app',type=Path);p.add_argument('out',type=Path);args=p.parse_args();app=args.app.resolve();out=args.out.resolve();out.mkdir(parents=True,exist_ok=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def tone(path,seconds,hz):
 path.parent.mkdir(parents=True,exist_ok=True)
 with wave.open(str(path),'wb') as f:
  f.setparams((1,2,16000,0,'NONE','not compressed'));f.writeframes(b''.join(struct.pack('<h',int(3000*math.sin(i*math.tau*hz/16000))) for i in range(int(16000*seconds))))
def foreground():
 if platform.system()!='Darwin':return None
 return subprocess.run(['/usr/bin/lsappinfo','front'],capture_output=True,text=True,timeout=2).stdout.strip()
spec=importlib.util.spec_from_file_location('interface_perf',Path(__file__).with_name('interface-perf.py'));perf=importlib.util.module_from_spec(spec);spec.loader.exec_module(perf)
with tempfile.TemporaryDirectory(prefix='singz-empty-ui-') as tmp:
 root=Path(tmp).resolve();library=root/'library';library.mkdir();originals={}
 for width in [1280,1060]:
  project=library/f'Empty {width}';(project/'stems').mkdir(parents=True);tone(project/'stems/custom-initial.wav',2,220)
  originals[str(width)]=sha(project/'stems/custom-initial.wav')
  (project/'project.json').write_text(json.dumps({'version':2,'name':f'Empty {width}','settings':{'custom':[{'id':'custom-initial','label':'First track','color':'#c7e06a','file':'stems/custom-initial.wav'}]},'foreign':{'keep':True}}))
  (project/'notes.txt').write_text('Keep unrelated documents.');(project/'stems/foreign.txt').write_text('Foreign prefix survives empty Save.')
 tone(root/'short.wav',0.5,220);tone(root/'new-one.wav',5,330);tone(root/'new-two.wav',7,440);(root/'bad.wav').write_bytes(b'Not an audio stream')
 helper=app.with_name('singz-gpui-audio.exe' if os.name=='nt' else 'singz-gpui-audio')
 subprocess.run([str(helper),'--compact-stem',str(root/'new-two.wav'),str(root/'new-two.flac')],check=True,capture_output=True)
 original=root/'source-only';original.mkdir();shutil.copyfile(root/'new-one.wav',original/'song.wav')
 (original/'project.json').write_text(json.dumps({'version':2,'name':'Unsplit source fixture','songFile':'song.wav','settings':{}}))
 final_hash=sha(root/'new-two.flac');before=foreground();all_perf=[]
 base={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ['SINGZ_PACK_DIR','SINGZ_MODELS_DIR','SINGZ_DEMUCS']}
 base.update(SINGZ_MUTE='1',SINGZ_NO_SYNC='1',SINGZ_NO_SYSTEM_ENGINES='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(root/'preferences'),SINGZ_GPUI_PROJECTS_ROOT=str(library),SINGZ_GPUI_EMPTY_PROJECT_FIXTURES=str(root),SINGZ_PACK_DIR=str(root/'missing-pack'),SINGZ_MODELS_DIR=str(root/'missing-models'))
 for phase in ['remove','import','resume']:
  if phase=='import':
   for width in [1280,1060]:
    for kind in ['Plain copy','Added copy','Removed move']:
     dest=root/'external'/f'{kind} {width}';shutil.copytree(library/f'Empty {width}',dest)
     raw=json.loads((dest/'project.json').read_text());raw['name']=dest.name
     if kind=='Removed move':
      tone(dest/'stems/custom-remove.wav',3,220);raw['settings'].pop('nativeEmptyTracks',None);raw['settings']['custom']=[{'id':'custom-remove','label':'Remove before Move','color':'#c7e06a','file':'stems/custom-remove.wav'}]
     (dest/'project.json').write_text(json.dumps(raw))
  phaseout=out/phase;phaseout.mkdir();env={**base,'SINGZ_GPUI_EMPTY_PROJECT_TEST':str(phaseout),'SINGZ_GPUI_EMPTY_PROJECT_PHASE':phase};stop=threading.Event();samples=[];started=time.monotonic()
  with (phaseout/'empty.log').open('w') as log:
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
   try:proc.wait(timeout=160)
   finally:
    if proc.poll() is None:proc.kill();proc.wait(timeout=5)
    stop.set();thread.join(timeout=4)
  (phaseout/'performance.json').write_text(json.dumps({'samples':samples,'scope':'main GPUI process only; helper separate; GPU system-wide','liveFps':{'available':False,'reason':'hidden display cadence unmeasured'}},indent=2));all_perf.append({'phase':phase,'samples':len(samples)})
  assert proc.returncode==0 and (phaseout/'result.json').exists(),(phaseout/'empty.log').read_text()
  for width in [1280,1060]:
   project=library/f'Empty {width}';raw=json.loads((project/'project.json').read_text());assert raw['foreign']=={'keep':True}
   assert (project/'notes.txt').read_text()=='Keep unrelated documents.' and (project/'stems/foreign.txt').exists()
   assert not (project/'stems/custom-initial.wav').exists()
   if phase in ['remove','import']:
    assert raw['settings']['nativeEmptyTracks'] is True and raw['settings']['nativeOriginalDisabled'] is True
    assert raw['settings']['custom']==[] and all(k not in raw['settings'] for k in ['loop','selection','view'])
    assert not list((project/'stems').glob('custom-*'))
   else:
    assert not raw['settings'].get('nativeEmptyTracks') and raw['settings']['nativeOriginalDisabled'] is True
    assert len(raw['settings']['custom'])==1;entry=raw['settings']['custom'][0];assert entry['file'].endswith('.flac')
    assert sha(project/entry['file'])==final_hash
   shutil.copytree(project,phaseout/f'project-{width}',dirs_exist_ok=True)
  if phase=='import':
   for entry in json.loads((phaseout/'result.json').read_text())['imports']:
    dest=Path(entry['destination']);raw=json.loads((dest/'project.json').read_text());assert raw['foreign']=={'keep':True}
    if entry['kind']=='Added copy':
     assert not raw['settings'].get('nativeEmptyTracks') and len(raw['settings']['custom'])==1;assert sha(dest/raw['settings']['custom'][0]['file'])==sha(root/'new-one.wav')
    else:assert raw['settings']['nativeEmptyTracks'] is True and raw['settings']['custom']==[] and not list((dest/'stems').glob('custom-*'))
    assert Path(entry['source']).exists()==(entry['kind']!='Removed move')
    shutil.copytree(dest,phaseout/dest.name,dirs_exist_ok=True)
 after=foreground();assert after==before,(before,after)
 (out/'fixture.json').write_text(json.dumps({'uiBinarySha256':sha(app),'helperSha256':sha(helper),'threeIndependentLaunches':True,'initialHashes':originals,'finalFlacHash':final_hash,'noNode':True,'hidden':True,'muted':True,'foregroundBefore':before,'foregroundAfter':after,'samples':all_perf,'lateStatusScope':'Delayed delivery of an actual earlier helper status with receipt clock advanced, not synthetic audio','chooserScope':'isolated picker-return fixture; native chooser presentation untested'},indent=2))
print('PASS: final custom Remove, actual empty graph, CAS refusal, standalone training, process restart, rejected Add, paused re-add and late-status fences at two sizes')
