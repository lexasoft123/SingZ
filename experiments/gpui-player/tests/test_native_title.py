"""Hidden native inline title editing and saved-directory rename, without Node."""
import argparse, hashlib, json, math, os, shutil, struct, subprocess, tempfile, wave, time, threading, importlib.util, platform
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('app',type=Path);p.add_argument('out',type=Path);args=p.parse_args();app=args.app.resolve();out=args.out.resolve();out.mkdir(parents=True,exist_ok=True);(out/'result.json').unlink(missing_ok=True)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
with tempfile.TemporaryDirectory(prefix='singz-native-title-') as temp:
 root=Path(temp).resolve();project=root/'external/Original';project.mkdir(parents=True);(root/'external/Occupied').mkdir();source=root/'source.wav'
 with wave.open(str(source),'wb') as audio:
  audio.setparams((2,2,44100,0,'NONE','not compressed'));audio.writeframes(b''.join(struct.pack('<hh',int(6000*math.sin(i*math.tau*220/44100)),int(6000*math.sin(i*math.tau*330/44100))) for i in range(44100*3)))
 shutil.copyfile(source,project/'song.wav');original=sha(source)
 (project/'project.json').write_text(json.dumps({'version':2,'name':'Original','songFile':'song.wav','settings':{},'foreign':{'keep':True}}));(project/'notes.txt').write_text('keep notes')
 env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ['SINGZ_PACK_DIR','SINGZ_MODELS_DIR']}
 env.update(SINGZ_MUTE='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(root/'prefs'),SINGZ_GPUI_PROJECTS_ROOT=str(root/'library'),SINGZ_GPUI_TEST_PROJECT=str(project),SINGZ_GPUI_SOURCE_FILE=str(source),SINGZ_GPUI_TITLE_TEST=str(out),SINGZ_PACK_DIR=str(root/'missing-pack'))
 spec=importlib.util.spec_from_file_location('interface_perf',Path(__file__).with_name('interface-perf.py'));perf=importlib.util.module_from_spec(spec);spec.loader.exec_module(perf)
 resources=[];stop=threading.Event();started=time.monotonic()
 with (out/'title.log').open('w') as log:
  r=subprocess.Popen([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT)
  def sample():
   previous=None
   while not stop.wait(.5):
    try:
     if platform.system()!='Darwin':resources.append({'available':False,'reason':'macOS counters unavailable'});return
     cpu,memory=perf.process_usage(r.pid);now=time.monotonic()
     if previous:resources.append({'elapsedSeconds':now-started,'processCpuPercent':(cpu-previous[0])/((now-previous[1])*1e9)*100,'processFootprintBytes':memory,'gpuSystem':perf.gpu_usage()})
     previous=(cpu,now)
    except OSError:return
  sampling=threading.Thread(target=sample,daemon=True);sampling.start()
  try:r.wait(timeout=110)
  finally:
   if r.poll() is None:r.kill();r.wait(timeout=5)
   stop.set();sampling.join(timeout=4)
 (out/'performance.json').write_text(json.dumps({'scope':'main GPUI process CPU/footprint; excludes native helper; GPU counters system-wide','wallSeconds':time.monotonic()-started,'samples':resources,'liveFps':{'available':False,'reason':'hidden window cadence unmeasured; static captures do not prove smoothness'}},indent=2))
 assert r.returncode==0 and (out/'result.json').is_file(),(out/'title.log').read_text()
 result=json.loads((out/'result.json').read_text());assert all(result[k] for k in ['escape','blank','enter','blur','collisionRefused','externalEditRefused','mixAndPausedPositionRetained','playingRetained','libraryRouteAndSearchFocusRetained','hidden','muted'])
 saved=Path(result['savedFolderRename']);imported=Path(result['unsavedSavedProject']);assert saved.parent.samefile(project.parent) and saved.name=='Playing rename' and not project.exists()
 raw=json.loads((saved/'project.json').read_text());assert raw['name']=='Playing rename' and raw['foreign']=={'keep':True} and raw['externalChange']=='keep'
 assert sha(saved/'song.wav')==original and (saved/'notes.txt').read_text()=='keep notes';assert list((root/'external/Occupied').iterdir())==[];assert not (root/'external/Refused stale rename').exists()
 assert imported.parent.samefile(root/'library') and imported.name=='Unsaved named source' and json.loads((imported/'project.json').read_text())['name']==imported.name;assert sha(source)==original
 shutil.copytree(saved,out/'renamed-project',dirs_exist_ok=True);shutil.copytree(imported,out/'imported-project',dirs_exist_ok=True)
 (out/'fixture.json').write_text(json.dumps({'appSha256':sha(app),'helperSha256':sha(app.with_name('singz-gpui-audio.exe' if os.name=='nt' else 'singz-gpui-audio')),'sourceSha256':original,'noNode':True,'hidden':True,'muted':True,'initialProject':{'name':'Original','duration':3,'format':'PCM16 stereo 44100'},'states':['editing','escape','blank','enter','collision','playing rename','external conflict','loose-source blur','explicit Save'],'newVisualReferences':'absent; candidate captures only'},indent=2))
print('PASS: inline title keyboard/blur, exclusive saved rename, conflict guards, mix/position/play restoration, unsaved title and explicit Save')
