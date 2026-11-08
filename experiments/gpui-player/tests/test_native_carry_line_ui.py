"""Hidden Carry UI/native receipt checks with durable two-process restart."""
import argparse, hashlib, importlib.util, json, math, os, platform, shutil, struct, subprocess, tempfile, threading, time, wave
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('app',type=Path);p.add_argument('out',type=Path);a=p.parse_args();app=a.app.resolve();out=a.out.resolve();out.mkdir(parents=True,exist_ok=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def foreground():
 if platform.system()!='Darwin':return None
 return subprocess.run(['/usr/bin/lsappinfo','front'],capture_output=True,text=True,timeout=2).stdout.strip()
def tone(path,hz):
 path.parent.mkdir(parents=True,exist_ok=True)
 # Repeating integral-second source PCM is deterministic and cheap to create.
 second=b''.join(struct.pack('<h',round(1000*math.sin(i*math.tau*hz/16000))) for i in range(16000))
 with wave.open(str(path),'wb') as f:f.setparams((1,2,16000,0,'NONE','not compressed'));f.writeframes(second*30)
def inventory(root):return {str(p.relative_to(root)):{'bytes':p.stat().st_size,'sha256':sha(p)} for p in root.rglob('*') if p.is_file()}
def run(env,folder):
 folder.mkdir(parents=True,exist_ok=True);(folder/'result.json').unlink(missing_ok=True)
 before=foreground();stop=threading.Event();samples=[];started=time.monotonic()
 with (folder/'carry.log').open('w') as log:
  proc=subprocess.Popen([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT)
  def sample():
   previous=None
   while not stop.wait(.5):
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
 after=foreground();(folder/'foreground.json').write_text(json.dumps({'before':before,'after':after,'unchanged':before==after,'note':'Read-only observation; concurrent user activity is not failed.'},indent=2))
 (folder/'performance.json').write_text(json.dumps({'samples':samples,'scope':'app CPU/footprint; helper separate; GPU systemwide','liveFps':{'available':False,'reason':'hidden macOS windows do not establish live display cadence'}},indent=2))
 return proc.returncode
spec=importlib.util.spec_from_file_location('interface_perf',Path(__file__).with_name('interface-perf.py'));perf=importlib.util.module_from_spec(spec);spec.loader.exec_module(perf)
with tempfile.TemporaryDirectory(prefix='singz-carry-ui-') as temporary:
 root=Path(temporary).resolve();project=root/'library/Carry fixture';fresh=root/'library/Fresh fallback';(project/'stems').mkdir(parents=True);fresh.mkdir()
 for id,hz in [('vocals',220),('bass',110)]:tone(project/f'stems/{id}.wav',hz)
 custom=[]
 for i in range(4):
  id=f'custom-harmony-{i}';file=f'stems/{id}.wav';tone(project/file,330+110*i)
  custom.append({'id':id,'label':f'Harmony {i+1} — голос 🎤','file':file,'color':'#a98cff'})
 beat={'beats':[i*.5 for i in range(60)],'bpm':120,'beatsPerBar':4,'downbeat':0,'downbeats':list(range(0,60,4)),'autoDownbeats':list(range(0,60,4)),'source':'auto','detVersion':23,'futureBeat':{'preserve':True}}
 original={'version':2,'name':'Carry fixture','foreign':{'keep':'all unrelated fields'},'settings':{'custom':custom,'tracks':{'bass':{'volume':.7,'muted':True}},'beat':beat,'melody':{'detVersion':4,'hopSec':.01,'f0':' '.join(['2400']*3000)},'training':{'mode':'time','periodSec':10,'hear':1,'sing':1,'stems':['vocals'],'futureCarry':{'keep':17}}}}
 (project/'project.json').write_text(json.dumps(original));(project/'foreign.txt').write_text('Keep this file byte-for-byte.')
 lyrics={'source':'edited','credit':'Carry independent timing fixture','lines':[{'text':f'Line {i+1} carry the song','start':i*5,'end':(i+1)*5,'words':[{'w':word,'s':i*5+j,'e':i*5+j+1} for j,word in enumerate(['Line',str(i+1),'carry','the','song'])]} for i in range(6)]}
 (project/'lyrics.json').write_text(json.dumps(lyrics));shutil.copyfile(project/'stems/vocals.wav',fresh/'song.wav');(fresh/'project.json').write_text(json.dumps({'version':2,'name':'Fresh fallback','songFile':'song.wav','foreign':{'fresh':True}}))
 crowded=root/'library/Crowded guides';shutil.copytree(project,crowded)
 crowded_raw=json.loads((crowded/'project.json').read_text());crowded_custom=[]
 for i in range(16):
  id=f'custom-crowded-{i}';file=f'stems/{id}.wav';shutil.copyfile(project/'stems/vocals.wav',crowded/file)
  crowded_custom.append({'id':id,'label':f'Guide {i+1} — голос 🎤 '+('UnbreakableLongLabel'*8),'file':file,'color':'#a98cff'})
 (crowded/'stems/vocals.wav').unlink();(crowded/'stems/bass.wav').unlink()
 for i in range(4):(crowded/f'stems/custom-harmony-{i}.wav').unlink()
 crowded_raw['name']='Crowded guides';crowded_raw['settings']['custom']=crowded_custom;crowded_raw['settings']['tracks']={};crowded_raw['settings']['training']['stems']=['custom-crowded-0']
 (crowded/'project.json').write_text(json.dumps(crowded_raw))
 working=root/'working-copy';target=root/'library/Working target'
 shutil.copytree(project,working);shutil.copytree(project,target)
 baseline=inventory(project);fresh_baseline=inventory(fresh)
 env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ['SINGZ_PACK_DIR','SINGZ_MODELS_DIR','SINGZ_DEMUCS']}
 env.update(SINGZ_MUTE='1',SINGZ_NO_SYNC='1',SINGZ_NO_SYSTEM_ENGINES='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(root/'prefs'),SINGZ_GPUI_PROJECTS_ROOT=str(project.parent),SINGZ_GPUI_TEST_PROJECT=str(project),SINGZ_GPUI_CARRY_FRESH_PROJECT=str(fresh),SINGZ_GPUI_CARRY_GATE=str(root/'accepted-carry.gate'),SINGZ_GPUI_CARRY_CROWDED=str(crowded),SINGZ_GPUI_CARRY_WORKING=str(working),SINGZ_GPUI_CARRY_TARGET=str(target),SINGZ_PACK_DIR=str(root/'missing-pack'),SINGZ_MODELS_DIR=str(root/'missing-models'))
 helper=app.with_name('singz-gpui-audio.exe' if os.name=='nt' else 'singz-gpui-audio')
 (out/'fixture.json').write_text(json.dumps({'appSha256':sha(app),'helperSha256':sha(helper),'initialProject':original,'initialLyrics':lyrics,'initialInventory':baseline,'freshInventory':fresh_baseline,'viewportSizes':[[1280,800],[1060,640]],'hidden':True,'muted':True,'noNode':True,'locale':'en','staleStatus':'actual native prior status cloned; production host delivery deliberately delayed until newer accepted carry revision','DSPAuthority':'separate actual native helper suite; this driver asserts UI/plans/receipts','productionParity':'unqualified; no matching Electron frames'},indent=2))
 try:
  for stage in ['exercise','restart','working','crowded']:
   folder=out/stage;code=run({**env,'SINGZ_GPUI_CARRY_TEST':str(folder),'SINGZ_GPUI_CARRY_STAGE':stage},folder)
   after=inventory(project);(folder/'source-integrity.json').write_text(json.dumps({'before':baseline,'after':after,'differences':{k:{'before':baseline.get(k),'after':after.get(k)} for k in baseline.keys()|after.keys() if baseline.get(k)!=after.get(k)}},indent=2))
   shutil.copytree(project,out/'final-project',dirs_exist_ok=True)
   assert code==0 and (folder/'result.json').exists(),(folder/'carry.log').read_text()
   if stage=='restart':
    global_at_restart=json.loads((root/'prefs/carry-line.json').read_text());assert global_at_restart['mode']=='lines' and global_at_restart['hear']==2 and global_at_restart['sing']==1 and global_at_restart['stems']==['custom-harmony-0']
    (out/'global-config.json').write_text(json.dumps(global_at_restart,indent=2))
   for name,stamp in baseline.items():
    if name!='project.json':assert after.get(name)==stamp,(name,stamp,after.get(name))
   for name,stamp in fresh_baseline.items():assert inventory(fresh).get(name)==stamp,('fresh mutated',name)
  published=json.loads((out/'working/published-project.json').read_text());assert published['settings']['training']['on'] is True and published['settings']['training']['periodSec']==15
  target_inventory=inventory(target);lossless=[]
  for name,stamp in baseline.items():
   if name=='project.json':continue
   if name in ['stems/vocals.wav','stems/bass.wav'] and name not in target_inventory:
    flac=target/Path(name).with_suffix('.flac');assert flac.is_file(),('missing published source',name)
    decoded=[]
    for index,source in enumerate([project/name,flac]):
     pcm=root/f'published-{Path(name).stem}-{index}.f32';subprocess.run([str(helper),'--render-lyrics-input',str(source),str(pcm)],check=True,capture_output=True,timeout=15);decoded.append(pcm.read_bytes())
    assert decoded[0] and decoded[0]==decoded[1],('working compaction changed decoded PCM',name)
    lossless.append({'source':name,'published':str(flac.relative_to(target)),'decodedSha256':hashlib.sha256(decoded[0]).hexdigest()})
   else:assert target_inventory.get(name)==stamp,('working publication changed source',name)
  (out/'working/publication-integrity.json').write_text(json.dumps({'inventory':target_inventory,'losslessBuiltinCompaction':lossless},indent=2));shutil.copytree(target,out/'published-working-target',dirs_exist_ok=True)
  queued=json.loads((out/'exercise/queued-save-project.json').read_text());assert queued['settings']['training']['on'] is True and queued['settings']['training']['hear']==3 and queued['settings']['training']['stems']==['custom-harmony-0']
  held=json.loads((out/'exercise/queued-save-navigation.json').read_text());assert held['queuedSave'] and held['pending'] and held['queuedNavigation'] and held['carry']['config']['hear']==2
  navigated=json.loads((out/'exercise/queued-navigation-opened.json').read_text());assert not navigated['carry']['enabled'] and navigated['carry']['config']['hear']==3 and navigated['epoch']!=held['epoch']
  saved=json.loads((project/'project.json').read_text());training=saved['settings']['training'];assert training['on'] is True and training['mode']=='lines' and training['periodSec']==60 and training['hear']==2 and training['sing']==1 and training['stems']==['custom-harmony-0'],training
  assert training['futureCarry']=={'keep':17} and saved['foreign']==original['foreign']
  assert saved['settings']['tracks']['bass']['muted'] is True and saved['settings']['custom']==custom
  assert saved['settings']['beat']==beat and saved['settings']['melody']==original['settings']['melody']
  global_config=json.loads((root/'prefs/carry-line.json').read_text());assert global_config['mode']=='time' and global_config['stems']==['custom-crowded-0','custom-crowded-15'] and 'on' not in global_config
  for width,height in [(1280,800),(1060,640)]:
   for path in (out/'exercise').glob(f'*-{width}.json'):
    state=json.loads(path.read_text());assert state['viewport']==[width,height] and state['hidden'],path
   lines=json.loads((out/'exercise'/f'lines-{width}.json').read_text());assert lines['lineMask']==[False,False,True,False,False,True] and lines['carryRevision']==lines['native']['carryRevision']
   assert lines['plan']['laneIds']==['custom-harmony-0'] and lines['plan']['windows']==[{'s':9.85,'e':14.85},{'s':24.85,'e':30.0}]
  (out/'saved-project.json').write_text(json.dumps(saved,indent=2));(out/'final-global-config.json').write_text(json.dumps(global_config,indent=2))
 finally:
  if project.exists():shutil.copytree(project,out/'final-project',dirs_exist_ok=True)
print('PASS: hidden Carry controls/clamps/lyric windows, native playback receipts and saved/global restart policy')
