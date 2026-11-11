"""Hidden native contextual tour, real controls/keyboard/geometry and restart."""
import argparse,hashlib,json,os,platform,subprocess,tempfile,threading,time,importlib.util
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('app',type=Path);p.add_argument('out',type=Path);args=p.parse_args();app=args.app.resolve();out=args.out.resolve();out.mkdir(parents=True,exist_ok=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
spec=importlib.util.spec_from_file_location('interface_perf',Path(__file__).with_name('interface-perf.py'));perf=importlib.util.module_from_spec(spec);spec.loader.exec_module(perf)
with tempfile.TemporaryDirectory(prefix='singz-native-guide-') as temp:
 root=Path(temp).resolve();env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_')};env.update(SINGZ_MUTE='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_DEMO='1',SINGZ_GPUI_TEST_NO_CAPTURE='1',SINGZ_GPUI_CONFIG_DIR=str(root/'prefs'),SINGZ_GPUI_PROJECTS_ROOT=str(root/'library'))
 for name in ['main','restart']:
  folder=out/name;folder.mkdir(exist_ok=True);(folder/'result.json').unlink(missing_ok=True);child_env=env.copy();child_env['SINGZ_GPUI_GUIDE_TEST']=str(folder)
  if name=='restart':child_env['SINGZ_GPUI_GUIDE_RESTART']='1'
  resources=[];stop=threading.Event();started=time.monotonic()
  with (folder/'guide.log').open('w') as log:
   child=subprocess.Popen([str(app)],env=child_env,stdout=log,stderr=subprocess.STDOUT)
   def sample():
    previous=None
    while not stop.wait(.5):
     try:
      if platform.system()!='Darwin':resources.append({'available':False,'reason':'macOS resource counters unavailable'});return
      cpu,memory=perf.process_usage(child.pid);now=time.monotonic()
      if previous:resources.append({'elapsedSeconds':now-started,'processCpuPercent':(cpu-previous[0])/((now-previous[1])*1e9)*100,'processFootprintBytes':memory,'gpuSystem':perf.gpu_usage()})
      previous=(cpu,now)
     except OSError:return
   thread=threading.Thread(target=sample,daemon=True);thread.start()
   try:child.wait(timeout=130)
   finally:
    if child.poll() is None:child.kill();child.wait(timeout=5)
    stop.set();thread.join(timeout=4)
  (folder/'performance.json').write_text(json.dumps({'scope':'GPUI process CPU/footprint, system-wide GPU; demo controls without audio/input workers','wallSeconds':time.monotonic()-started,'samples':resources,'liveFps':{'available':False,'reason':'hidden static renders do not measure live display cadence'}},indent=2))
  assert child.returncode==0 and (folder/'result.json').is_file(),(folder/'guide.log').read_text()
  result=json.loads((folder/'result.json').read_text())
  if name=='main':
   assert all(result[k] for k in ['welcome','keyboardTrap','back','modalInputBlocked','cutoutTargetPixelExact','helpEntry','settingsEntry','escape','hidden','muted']);assert result['sizes']==2 and result['librarySteps']==4 and result['playerSteps']==8
   images=list(folder.glob('*.png'));assert len(images)==32,len(images)
   states=[json.loads(p.read_text()) for p in folder.glob('*.state.json')];assert len(states)==30 and sorted({tuple(s['viewport']) for s in states})==[(1060.,640.),(1280.,800.)]
  else:assert result=={'restart':True,'manualReplay':True}
  assert json.loads((root/'prefs/quick-start.json').read_text())=={'version':1,'seen':True}
 (out/'fixture.json').write_text(json.dumps({'appSha256':sha(app),'sourceCopySha256':sha(Path(__file__).parents[1]/'src/quick_start_copy.json'),'hidden':True,'muted':True,'noNode':True,'demo':True,'microphoneCaptureDisabled':True,'viewportSizes':[[1280,800],[1060,640]],'scale':2,'locale':'en','reference':'production captures absent; new states are candidates'},indent=2))
print('PASS: anchored welcome/library/player tours, two sizes, keyboard trap, modal input guard, Back/Next/Done/Escape, help/settings entry, restart and manual replay')
