"""Hidden actual ruler/dialog -> native source export, with independent PCM checks."""
import argparse, array, hashlib, importlib.util, json, math, os, platform, shutil, struct, subprocess, tempfile, threading, time, wave
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('app',type=Path);p.add_argument('out',type=Path);a=p.parse_args();app=a.app.resolve();out=a.out.resolve();out.mkdir(parents=True,exist_ok=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def front():
 if platform.system()!='Darwin':return None
 return subprocess.run(['/usr/bin/lsappinfo','front'],capture_output=True,text=True,timeout=2).stdout.strip()
def tone(path,hz):
 path.parent.mkdir(parents=True,exist_ok=True)
 with wave.open(str(path),'wb') as f:
  f.setparams((1,2,16000,0,'NONE','not compressed'));f.writeframes(b''.join(struct.pack('<h',round(1200*math.sin(i*math.tau*hz/16000))) for i in range(4800)))
def tree(path):return {str(p.relative_to(path)):{'bytes':p.stat().st_size,'sha256':sha(p)} for p in path.rglob('*') if p.is_file()}
def integrity(before,after,label):
 # Only the exact zero-byte project writer coordination file is admissible.
 allowed={'.singz-native-write.lock'}
 extra={k:v for k,v in after.items() if k not in before}
 bad={k:v for k,v in extra.items() if k not in allowed or v['bytes']!=0}
 changed={k:{'before':v,'after':after.get(k)} for k,v in before.items() if after.get(k)!=v}
 receipt={'before':before,'after':after,'added':extra,'changed':changed,'unexpectedAdded':bad}
 (out/f'{label}-integrity.json').write_text(json.dumps(receipt,indent=2))
 assert not changed and not bad,receipt
with tempfile.TemporaryDirectory(prefix='singz-export-ui-') as tmp:
 root=Path(tmp).resolve();project=root/'library/Export originals';(project/'stems').mkdir(parents=True);dest=root/'exports';dest.mkdir()
 builtin=[('vocals',220),('drums',300),('bass',400),('guitar',500),('piano',600),('other',700)]
 sources=[]
 for id,hz in builtin:
  path=project/f'stems/{id}.wav';tone(path,hz);sources.append({'id':id,'frequency':hz,'path':str(path)})
 custom=[]
 for i in range(10):
  id='custom-backing-vocals' if i==0 else f'custom-extra-{i}'
  label='Backing vocals' if i==0 else f'Custom {i} — long stored harmony label 🎤'
  relative=f'stems/{id}.wav';tone(project/relative,800+100*i)
  custom.append({'id':id,'label':label,'color':'#a98cff','file':relative});sources.append({'id':id,'frequency':800+100*i,'path':str(project/relative)})
 raw={'version':2,'name':'Export originals','settings':{'custom':custom,'masterVolume':0,'transpose':7,'tempo':1.25,'tracks':{id:{'volume':0,'muted':True} for id,_ in builtin}},'foreign':{'preserve':'metadata and source ownership'}}
 (project/'project.json').write_text(json.dumps(raw));(project/'lyrics.json').write_text('{"source":"edited","lines":[],"credit":"Keep"}');(project/'foreign.txt').write_text('Never modify source project for export.')
 before=tree(project);helper=app.with_name('singz-gpui-audio.exe' if os.name=='nt' else 'singz-gpui-audio')
 env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ['SINGZ_PACK_DIR','SINGZ_MODELS_DIR','SINGZ_DEMUCS']}
 env.update(SINGZ_MUTE='1',SINGZ_NO_SYNC='1',SINGZ_NO_SYSTEM_ENGINES='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(root/'prefs'),SINGZ_GPUI_PROJECTS_ROOT=str(project.parent),SINGZ_GPUI_TEST_PROJECT=str(project),SINGZ_GPUI_STEM_EXPORT_TEST=str(out),SINGZ_GPUI_STEM_EXPORT_DEST=str(dest),SINGZ_GPUI_STEM_EXPORT_GATE=str(root/'encode.gate'),SINGZ_PACK_DIR=str(root/'missing-pack'),SINGZ_MODELS_DIR=str(root/'missing-models'))
 spec=importlib.util.spec_from_file_location('interface_perf',Path(__file__).with_name('interface-perf.py'));perf=importlib.util.module_from_spec(spec);spec.loader.exec_module(perf)
 foreground_before=front();samples=[];stop=threading.Event();started=time.monotonic()
 with (out/'stem-export-ui.log').open('w') as log:
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
  try:proc.wait(timeout=180)
  finally:
   if proc.poll() is None:proc.kill();proc.wait(timeout=5)
   stop.set();thread.join(timeout=4)
 foreground_after=front();(out/'foreground.json').write_text(json.dumps({'before':foreground_before,'after':foreground_after,'unchanged':foreground_before==foreground_after,'note':'Read-only observation; differing user activity is not a test failure.'},indent=2))
 (out/'performance.json').write_text(json.dumps({'samples':samples,'scope':'GPUI app CPU only; helper separate; GPU system-wide','liveFps':{'available':False,'reason':'hidden window display cadence unmeasured'}},indent=2))
 # Always archive state/diffs before assertions or TemporaryDirectory teardown.
 after=tree(project);(out/'source-before.json').write_text(json.dumps(before,indent=2));(out/'source-after.json').write_text(json.dumps(after,indent=2));shutil.copytree(dest,out/'exports',dirs_exist_ok=True)
 (out/'fixture.json').write_text(json.dumps({'appSha256':sha(app),'helperSha256':sha(helper),'sources':sources,'projectBefore':before,'viewportSizes':[[1280,800],[1060,640]],'locale':'en','hidden':True,'muted':True,'noNode':True,'chooserBoundary':'actual plan captured, queued folder fixture; OS chooser not presented','productionParity':'unqualified; native screenshots only'},indent=2))
 integrity(before,after,'source')
 assert proc.returncode==0 and (out/'result.json').exists(),(out/'stem-export-ui.log').read_text()
 assert not (root/'prefs/sync.json').exists(),'Export created sync mutations'
 oracle=[]
 def decode(path):
  measured=json.loads(subprocess.run([str(helper),'--measure-input',str(path)],check=True,capture_output=True,text=True,timeout=15).stdout)
  assert measured['ok'] and measured['channels']==1,measured
  seconds=measured['frames']/measured['sampleRate'];assert abs(seconds-.3)<.15,(path,measured)
  pcm=root/f'pcm-{len(oracle)}.f32';subprocess.run([str(helper),'--render-lyrics-input',str(path),str(pcm)],check=True,capture_output=True,timeout=15)
  data=array.array('f');data.frombytes(pcm.read_bytes());
  if os.sys.byteorder!='little':data.byteswap()
  # Independent single-frequency DFT over the original .3s payload. No native
  # mix/encode implementation is reused as the expected signal.
  amplitudes={str(s['frequency']):2/len(data)*abs(sum(v*complex(math.cos(-math.tau*s['frequency']*i/16000),math.sin(-math.tau*s['frequency']*i/16000)) for i,v in enumerate(data))) for s in sources}
  oracle.append({'file':str(path.relative_to(dest)),'sha256':sha(path),'metadata':measured,'decodedSha256':sha(pcm),'amplitudes':amplitudes});return amplitudes
 for width,height in [(1280,800),(1060,640)]:
  files=sorted((dest/f'mp3-{width}').glob('*.mp3'));assert len(files)==16,files
  for path,source in zip(files,sources):
   amps=decode(path);assert float(amps[str(source['frequency'])])>.02,(path,amps)
  wavs=sorted((dest/f'wav-{width}').glob('*.wav'));assert len(wavs)==2,wavs
  for path,source in zip(wavs,[sources[0],sources[-1]]):
   amps=decode(path);assert float(amps[str(source['frequency'])])>.03,(path,amps)
  flacs=list((dest/f'karaoke-{width}').glob('*.flac'));assert len(flacs)==1,flacs
  amps=decode(flacs[0]);included={300,400,500,600,700,800}
  for hz,value in amps.items():assert value>(.03) if int(hz) in included else value<.001,(hz,value,amps)
  assert not list((dest/f'cancel-{width}').iterdir()),'Cancel left staged/partial output'
  for statefile in out.glob(f'*-{width}.json'):
   state=json.loads(statefile.read_text());assert state['viewport']==[width,height],(statefile,state['viewport']);assert state['hidden']
 (out/'encoded-oracle.json').write_text(json.dumps(oracle,indent=2))
print('PASS: hidden two-size export controls, actual MP3/WAV/FLAC source audio and cancellation/collision fences')
