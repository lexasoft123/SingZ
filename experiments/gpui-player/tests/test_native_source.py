"""Hidden file drop -> existing inference -> seven native lanes -> Save.
Default uses a local fault-injection interpreter; --real uses installed weights.
--real --fresh-models first installs the released host pack into private caches.
Both paths use the real shared C++ decoder and playback bridge, never Node.
"""
import argparse,hashlib,json,math,os,struct,subprocess,sys,tempfile,wave,time,importlib.util,platform,threading
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('app',type=Path);p.add_argument('out',type=Path)
p.add_argument('--real',action='store_true')
p.add_argument('--phase-parity',action='store_true',help='Run isolated split-stage, cancellation and native-load ownership faults')
p.add_argument('--fresh-models',action='store_true',help='With --real, install the actual released host splitter pack into private empty caches before splitting')
args=p.parse_args()
if args.phase_parity and (args.real or args.fresh_models):p.error('--phase-parity uses only the explicit fault-injection fixture')
if args.fresh_models and not args.real:p.error('--fresh-models requires --real; fixture installs cannot qualify released models')
app=args.app.resolve();out=args.out.resolve();out.mkdir(parents=True,exist_ok=True);(out/'result.json').unlink(missing_ok=True)
if args.fresh_models:(out/'migration-models.json').unlink(missing_ok=True)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def foreground():
 if platform.system()!='Darwin':return {'available':False,'reason':'lsappinfo is macOS-only'}
 try:
  reply=subprocess.run(['/usr/bin/lsappinfo','front'],capture_output=True,text=True,timeout=2)
  if reply.returncode or not reply.stdout.strip():return {'available':False,'reason':'lsappinfo returned no foreground identity'}
  return {'available':True,'identity':reply.stdout.strip()}
 except (OSError,subprocess.TimeoutExpired) as error:return {'available':False,'reason':str(error)}
with tempfile.TemporaryDirectory(prefix='singz-native-source-') as temp:
 root=Path(temp);source=root/'New native song.wav'
 with wave.open(str(source),'wb') as audio:
  audio.setparams((1,2,48000,0,'NONE','not compressed'));audio.writeframes(b''.join(struct.pack('<h',int(7000*math.sin(i*math.tau*220/48000))) for i in range(48000*2)))
 original=sha(source);helper=app.with_name('singz-gpui-audio.exe' if os.name=='nt' else 'singz-gpui-audio')
 rendered=root/'prepared.wav';r=subprocess.run([str(helper),'--render-input',str(source),str(rendered)],capture_output=True,text=True,timeout=30);assert r.returncode==0,r.stderr
 receipt=json.loads(r.stdout);assert receipt['frames']==88200 and receipt['channels']==2 and receipt['sampleRate']==44100
 with wave.open(str(rendered),'rb') as audio:
  assert audio.getparams()[:4]==(2,2,44100,88200);data=audio.readframes(audio.getnframes());samples=struct.unpack('<'+'h'*(len(data)//2),data);assert samples[::2]==samples[1::2] and max(samples)>5000
 encoded=sha(rendered);r=subprocess.run([str(helper),'--render-input',str(source),str(rendered)],capture_output=True,timeout=30);assert r.returncode!=0 and sha(rendered)==encoded,'Offline helper overwrote an existing destination'
 bad=root/'bad.wav';bad.write_bytes(b'not audio');r=subprocess.run([str(helper),'--render-input',str(bad),str(root/'bad-output.wav')],capture_output=True,timeout=30);assert r.returncode!=0 and not (root/'bad-output.wav').exists()
 env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ['SINGZ_PACK_DIR','SINGZ_MODELS_DIR']}
 env.update(SINGZ_MUTE='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_TEST_NO_CAPTURE='1',SINGZ_GPUI_CONFIG_DIR=str(root/'prefs'),SINGZ_GPUI_PROJECTS_ROOT=str(root/'library'),SINGZ_GPUI_SOURCE_FILE=str(source),SINGZ_GPUI_SOURCE_TEST=str(out))
 if args.phase_parity:env.update(SINGZ_GPUI_SOURCE_PHASE_PARITY_TEST='1',SINGZ_GPUI_SPLIT_LOAD_GATE=str(root/'split-load-gate'))
 pack_fixture=None
 if args.fresh_models:
  pack=root/'fresh-pack';models=root/'fresh-models';prefs=root/'prefs';library=root/'library'
  assert all(path.is_absolute() and not path.exists() for path in (pack,models,prefs,library))
  assert len({pack,models,prefs,library})==4
  # Real registry URLs, production installer and the downloaded pack must own
  # this run. A user engine/URL/cache override cannot satisfy fresh-install proof.
  for name in ('SINGZ_GPU_PACK_URL','SINGZ_DEMUCS'):
   env.pop(name,None)
  env.update(SINGZ_PACK_DIR=str(pack),SINGZ_MODELS_DIR=str(models),SINGZ_NO_SYSTEM_ENGINES='1',SINGZ_GPUI_MIGRATION_TEST=str(out),TORCH_HOME=str(prefs/'torch-home'),HF_HOME=str(prefs/'hf-home'),HF_HUB_CACHE=str(prefs/'hf-home/hub'),HUGGINGFACE_HUB_CACHE=str(prefs/'hf-home/hub'),TRANSFORMERS_CACHE=str(prefs/'hf-home/transformers'))
 elif args.real:
  pack=Path.home()/'Library/Application Support/SingZ/gpu-splitter';env['SINGZ_PACK_DIR']=str(pack)
 else:
  pack=root/'pack';(pack/'python/bin').mkdir(parents=True);(pack/'python/models/uvr').mkdir(parents=True);(pack/'python/models/uvr/UVR_MDXNET_KARA_2.onnx').write_bytes(b'fixture');(pack/'python/pack.json').write_text('{"formatVersion":10,"target":"darwin-x64"}')
  # Normal native validation applies here (no MODEL_FIXTURE override). An Intel
  # pack also needs its embedded ONNX marker when probed by an ARM application.
  # Sparse zero bytes satisfy the bounded size check, not real model inference;
  # the fault-injection interpreter below supplies every split result.
  weight=pack/'python/model-cache/models--StemSplitio--htdemucs-6s-onnx/snapshots/test/htdemucs_6s_fp16weights.onnx';weight.parent.mkdir(parents=True)
  with weight.open('xb') as f:f.truncate(100_000_001)
  assert weight.stat().st_size==100_000_001
  pack_fixture={'kind':'fault-injection-interpreter-with-sparse-zero-onnx-marker','weightPath':str(weight.relative_to(pack)),'weightLogicalBytes':weight.stat().st_size,'weightContents':'zero-filled sparse placeholder; not ONNX model weights','realInference':False}
  control=root/'control';control.write_text('good');shim=pack/'python/bin/python3'
  shim.write_text('#!'+sys.executable+'\n'+r'''
import sys,os,time,shutil,subprocess,wave,struct,json
from pathlib import Path
control=Path(os.environ['SINGZ_GPUI_SOURCE_CONTROL']);mode=control.read_text();args=sys.argv[1:]
onnx_shim='import sys; from demucs_onnx.cli import main; sys.exit(main())'
if args in (['-m','demucs','--help'],['-c',onnx_shim,'--help']):print('fixture interpreter');sys.exit(0)
if len(args)==13 and args[0].endswith('onnx-runner.py') and args[1]=='separate' and args[4:9]==['--model','htdemucs_6s','--precision','fp16weights','--cache-dir'] and args[10]=='--providers' and args[11] in ['cpu','trtrtx'] and args[12]=='-v':
 kind='six';source=Path(args[2]);output=Path(args[3])
elif len(args)==9 and args[:7]==['-m','demucs','-n','htdemucs_6s','--filename','{stem}.{ext}','-o']:
 kind='six';source=Path(args[8]);output=Path(args[7])/'htdemucs_6s'
elif len(args)==7 and args[0].endswith('vocal-runner.py') and args[1]=='--model' and args[3]=='--input' and args[5]=='--output':
 kind='uvr';source=Path(args[4]);output=Path(args[6])
else:
 print('fixture interpreter: unsupported command: '+repr(args),file=sys.stderr);sys.exit(2)
if kind=='uvr' and mode=='fail-vocals':
 print('fixture vocal separation failure',file=sys.stderr);sys.exit(3)
if kind=='uvr' and mode=='hold-vocals':
 child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);control.with_suffix('.pid').write_text(str(child.pid))
 owner={'pid':child.pid}
 if sys.platform.startswith('linux'):owner['startTicks']=Path(f'/proc/{child.pid}/stat').read_text().rsplit(') ',1)[1].split()[19]
 else:owner['identity']=subprocess.check_output(['ps','-p',str(child.pid),'-o','lstart=,comm='],text=True).strip()
 control.with_suffix('.owner.json').write_text(json.dumps(owner));print('{"percent":33}',flush=True)
 while control.read_text()=='hold-vocals':time.sleep(.03)
if mode=='hold':
 print('chunk 1/3: fixture',flush=True)
 while control.read_text()=='hold':time.sleep(.03)
if mode=='slow':
 child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);control.with_suffix('.pid').write_text(str(child.pid))
 owner={'pid':child.pid}
 if sys.platform.startswith('linux'):owner['startTicks']=Path(f'/proc/{child.pid}/stat').read_text().rsplit(') ',1)[1].split()[19]
 else:owner['identity']=subprocess.check_output(['ps','-p',str(child.pid),'-o','lstart=,comm='],text=True).strip()
 control.with_suffix('.owner.json').write_text(json.dumps(owner))
 print('chunk 1/3: fixture',flush=True);time.sleep(15)
if kind=='six':
 output.mkdir(exist_ok=True)
 for stem in ['vocals','drums','bass','guitar','piano','other']:
  if mode=='missing' and stem=='piano':continue
  if mode=='changed':
   with wave.open(str(source),'rb') as audio:params=audio.getparams();samples=struct.unpack('<'+'h'*(audio.getnframes()*audio.getnchannels()),audio.readframes(audio.getnframes()))
   with wave.open(str(output/(stem+'.wav')),'wb') as audio:audio.setparams(params);audio.writeframes(struct.pack('<'+'h'*len(samples),*(v//2 for v in samples)))
  else:shutil.copyfile(source,output/(stem+'.wav'))
 print('chunk 3/3: fixture',flush=True)
else:
 output.mkdir(exist_ok=True)
 if source.suffix=='.flac':
  decoded=output/'decoded.wav';subprocess.run([os.environ['SINGZ_GPUI_SOURCE_NATIVE_HELPER'],'--render-input',str(source),str(decoded)],check=True);source=decoded
 for name in ['lead','backing']:shutil.copyfile(source,output/(name+'.wav'))
 print('{"percent":100}',flush=True)
''');shim.chmod(0o755);env.update(SINGZ_PACK_DIR=str(pack),SINGZ_GPUI_SOURCE_CONTROL=str(control),SINGZ_GPUI_SOURCE_NATIVE_HELPER=str(helper))
 legacy=root/'legacy-six';(legacy/'stems').mkdir(parents=True)
 compact_input=root/'compact.wav';compact_input.write_bytes(rendered.read_bytes());compact_flac=root/'compact.flac'
 r=subprocess.run([str(helper),'--compact-stem',str(compact_input),str(compact_flac)],capture_output=True,text=True,timeout=30);assert r.returncode==0,r.stderr
 assert compact_flac.read_bytes().startswith(b'fLaC') and not compact_input.exists()
 for stem in ['vocals','drums','bass','guitar','piano','other']:(legacy/f'stems/{stem}.flac').write_bytes(compact_flac.read_bytes())
 (legacy/'song.wav').write_bytes(source.read_bytes());(legacy/'project.json').write_text(json.dumps({'version':2,'name':'Legacy six','songFile':'song.wav','settings':{},'foreignLegacy':'preserve'}))
 env['SINGZ_GPUI_SOURCE_LEGACY_PROJECT']=str(legacy)
 spec=importlib.util.spec_from_file_location('interface_perf',Path(__file__).with_name('interface-perf.py'));perf=importlib.util.module_from_spec(spec);spec.loader.exec_module(perf)
 resources=[];front_samples=[];front_before=foreground() if args.fresh_models else None;stop=threading.Event();started=time.monotonic()
 with (out/'source.log').open('w') as log:
  child=subprocess.Popen([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT)
  def sample():
   previous=None
   while not stop.wait(.5):
    try:
     if args.fresh_models:front_samples.append({'elapsedSeconds':time.monotonic()-started,**foreground()})
     if platform.system()!='Darwin':resources.append({'available':False,'reason':'macOS counters unavailable on this host'});return
     cpu,memory=perf.process_usage(child.pid);now=time.monotonic()
     if previous:resources.append({'elapsedSeconds':now-started,'processCpuPercent':(cpu-previous[0])/((now-previous[1])*1e9)*100,'processFootprintBytes':memory,'gpuSystem':perf.gpu_usage()})
     previous=(cpu,now)
    except OSError as error:
     if child.poll() is None:resources.append({'available':False,'reason':str(error)})
     return
  sampling=threading.Thread(target=sample,daemon=True);sampling.start()
  try:
   if args.fresh_models:
    deadline=started+1200
    # Observe this exact launched process throughout download/install/inference;
    # never restart it or turn an old receipt into a newly completed workflow.
    while child.poll() is None:
     if time.monotonic()>=deadline:raise TimeoutError('Released-model install + split/Save/reopen exceeded 20 minutes; inspect source.log')
     time.sleep(.25)
   else:child.wait(timeout=300 if args.real else 130)
  finally:
   if child.poll() is None:child.kill();child.wait(timeout=5)
   stop.set();sampling.join(timeout=4)
   if args.fresh_models:
    front_after=foreground();observations=[front_before,*front_samples,front_after]
    front_available=all(item.get('available') is True for item in observations)
    front_unchanged=front_available and all(item['identity']==front_before['identity'] for item in observations)
    front_verdict='stable-observed-foreground' if front_unchanged else 'observation-unavailable' if not front_available else 'external-interruption; focus-steal verdict unqualified'
    (out/'foreground.json').write_text(json.dumps({'before':front_before,'after':front_after,'samples':front_samples,'allAvailable':front_available,'unchanged':front_unchanged,'verdict':front_verdict,'scope':'Read-only front application identity during the same hidden process; no activation/global input'},indent=2))
  result=child
 (out/'performance.json').write_text(json.dumps({'scope':'main GPUI process; excludes separate inference/helper CPU','wallSeconds':time.monotonic()-started,'wallScope':'workflow including screenshot settlement; not inference benchmark','samples':resources,'liveFps':{'available':False,'reason':'not measured in this hidden event-driven workflow; stepped captures do not establish live display cadence'},'inferenceCpu':{'available':False,'reason':'separate workers not sampled'}},indent=2))
 assert result.returncode==0 and (out/'result.json').is_file(),(out/'source.log').read_text()
 result=json.loads((out/'result.json').read_text())
 if args.phase_parity:
  assert all(result.get(key) is True for key in ('phaseParity','readinessDuringInference','cancelUntilRetirement','vocalFailureKeepsAcceptedStems','vocalCancelKeepsAcceptedStems','loadingCancelRestoresOriginal','loadingErrorPreservesOriginal','newerOpenRejectsLateHandoff','hidden','muted')),result
  assert result.get('realModels') is False and sha(source)==original and not list((root/'library').glob('*/project.json'))
  owner=json.loads(control.with_suffix('.owner.json').read_text());pid=owner['pid']
  if sys.platform.startswith('linux'):
   proc=Path(f'/proc/{pid}/stat')
   fields=proc.read_text().rsplit(') ',1)[1].split() if proc.exists() else None
   assert fields is None or fields[19]!=owner['startTicks'] or fields[0]=='Z','Owned vocal descendant survived quit'
  else:
   current=subprocess.run(['ps','-p',str(pid),'-o','lstart=,comm='],capture_output=True,text=True,timeout=30)
   assert current.returncode!=0 or current.stdout.strip()!=owner['identity'],'Owned vocal descendant survived quit'
  print('PASS: split phases, live readiness, accepted stems retention and epoch-fenced loading rollback')
  sys.exit(0)
 assert all(result[k] for k in ['nativeFileDrop','unsavedOriginal','splitSevenLanes','leadBacking','saveOnlyPublishesOnRequest','seventhLaneMixRestored','nativePlayback','hidden','muted'])
 model_install=None
 if args.fresh_models:
  proof=out/'migration-models.json';assert proof.is_file(),'Fresh run reached no released-model installation receipt'
  model_install=json.loads(proof.read_text())
  assert all(model_install.get(key) is True for key in ('freshModels','releasedHostPack','installed','engineReady','downloadObserved','hidden','muted')),model_install
  assert model_install.get('fixtureModels') is False and model_install.get('modelId')=='gpu-splitter' and model_install.get('resolvedEngine')=='pack',model_install
  for key,expected in [('packDirectory',pack),('modelsDirectory',models),('configDirectory',prefs),('libraryDirectory',library)]:
   assert Path(model_install[key]).resolve()==expected.resolve(),(key,model_install[key],expected)
  urls=model_install.get('urls');assert isinstance(urls,list) and len(urls)==1 and urls[0].startswith('https://github.com/lexasoft123/SingZ/releases/download/v'),model_install
  assert urls[0].endswith('/gpu-splitter-'+model_install['target']+'.tar.gz'),model_install
  assert result.get('realModels') is True and not result.get('faultCases'),result
  if platform.system()=='Darwin' and not front_unchanged:print('Foreground observation unqualified: '+front_verdict+'; raw samples retained in foreground.json',file=sys.stderr)
  assert env['SINGZ_GPUI_SOURCE_LEGACY_PROJECT']==str(legacy),'Source workflow must reopen the saved project after visiting the legacy project'

 if not args.real:assert result['inlineSplitPlayback'] and result['splitHandoffRestored'] and result['workingSplitRename'] and result['settingsRetainedOnSplit']
 saved=Path(result['savedProject']);raw=json.loads((saved/'project.json').read_text());assert raw['settings']['tracks']['custom-backing-vocals']['muted'] is True;assert raw['settings']['tracks']['custom-backing-vocals']['volume']==.42
 assert raw['settings']['custom'][0]['file']=='stems/custom-backing-vocals.wav' and raw['settings']['leadVocalSeparated'] is True
 assert all((saved/f'stems/{stem}.flac').is_file() for stem in ['drums','bass','guitar','piano','other']),'Saved instrument stems were not compacted'
 assert not (saved/'stems/drums.wav').exists()
 files={str(f.relative_to(saved)):sha(f) for f in saved.rglob('*') if f.is_file() and not f.name.endswith('.lock')}
 assert len(list((root/'library').glob('*/project.json')))==1,'Re-splitting forked another library project'
 assert not list((root/'library').rglob('.singz-native-split.json')) and not list((root/'library').rglob('.native-split-*'))
 assert sha(source)==original,'Import mutated the original song'
 if not args.real:
  owner=json.loads(control.with_suffix('.owner.json').read_text());pid=owner['pid']
  assert int(control.with_suffix('.pid').read_text())==pid
  def alive():
   if sys.platform.startswith('linux'):
    try:fields=Path(f'/proc/{pid}/stat').read_text().rsplit(') ',1)[1].split()
    except FileNotFoundError:return False
    # An orphan zombie awaits container init; it is terminated, with no live
    # executable. PID reuse cannot make an unrelated process our descendant.
    return fields[19]==owner['startTicks'] and fields[0]!='Z'
   current=subprocess.run(['ps','-p',str(pid),'-o','lstart=,comm='],capture_output=True,text=True,timeout=30)
   return current.returncode==0 and current.stdout.strip()==owner['identity']
  for _ in range(50):
   if not alive():break
   time.sleep(.05)
  assert not alive(),'Owned inference descendant remains live after cancellation/shutdown'
  assert raw['externalNote']=='keep me' and (saved/'notes.txt').read_bytes()==b'unrelated file'
 (out/'fixture.json').write_text(json.dumps({'appSha256':sha(app),'helperSha256':sha(helper),'originalSha256':original,'renderReceipt':receipt,'pack':json.loads((pack/'python/pack.json').read_text()),'packFixture':pack_fixture,'realModels':args.real,'freshModels':args.fresh_models,'releasedModelInstall':model_install,'files':files,'noNode':True,'muted':True,'hidden':True,'shutdownChildCleanup':not args.real,'ownedInferenceChild':None if args.real else owner,'settingsCaptureDisabled':True},indent=2))
 # Retain the newly saved project as evidence, independent of test temporaries.
 import shutil
 shutil.copytree(saved,out/'saved-project',dirs_exist_ok=True)
print('PASS: native decode/resample, dropped loose song, seven-lane split, explicit Save, seventh-lane mixer persistence and native playback'+(' after fresh released-model installation with real inference and Save/reopen' if args.fresh_models else ' with real installed inference' if args.real else '; cancellation, missing stem, conflict and shutdown faults'))
