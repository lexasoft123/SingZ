"""Hidden native saved-graph open/playback/Save/restart; no global input or Node."""
import argparse, hashlib, importlib.util, json, math, os, platform, shutil, struct, subprocess, tempfile, time, wave
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('app',type=Path);p.add_argument('out',type=Path);p.add_argument('--karaoke',action='store_true',help='Also prove production Karaoke event mutes native vocals and persists across Save/reopen');p.add_argument('--navigation',action='store_true',help='Also prove Songs/Catalog pause and Training remembered catalog through production header events');p.add_argument('--region',action='store_true',help='Also prove real region gestures, native stop/wrap and selection Save/reopen');a=p.parse_args();app=a.app.resolve();out=a.out.resolve();out.mkdir(parents=True,exist_ok=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
spec=importlib.util.spec_from_file_location('graph_perf',Path(__file__).with_name('interface-perf.py'));perf=importlib.util.module_from_spec(spec);spec.loader.exec_module(perf)
def front():
 if platform.system()=='Darwin':return subprocess.run(['/usr/bin/lsappinfo','front'],capture_output=True,text=True,timeout=2).stdout.strip()
 return None
results=[]
with tempfile.TemporaryDirectory(prefix='singz-native-graph-ui-') as tmp:
 root=Path(tmp);project=root/'library/Native graph fixture';(project/'stems').mkdir(parents=True)
 source=project/'stems/vocals.wav'
 with wave.open(str(source),'wb') as w:
  w.setparams((1,2,48000,0,'NONE','not compressed'));w.writeframes(b''.join(struct.pack('<h',round(8000*math.sin(i*math.tau*220/48000))) for i in range(48000))*12)
 graph=Path(__file__).resolve().parents[3]/'tests/shared/native-playback-graph.json';(project/'graph.json').write_bytes(graph.read_bytes());graph_hash={'format':1,'size':graph.stat().st_size,'md5':hashlib.md5(graph.read_bytes()).hexdigest(),'mtimeMs':0}
 original={'version':2,'name':'Native graph fixture','foreign':{'preserve':'opaque project data'},'graphHash':graph_hash,'settings':{'tracks':{'vocals':{'volume':.7,'muted':False}},'masterVolume':.6,'tempo':1,'transpose':0,'metronome':{'click':False,'countInBars':0,'volume':.7,'accent':True}}}
 (project/'project.json').write_text(json.dumps(original));source_hash=sha(source)
 lyrics_hash=None
 if a.karaoke:
  # Valid local saved lyrics prevent this transport regression from using LRCLIB.
  lyrics=project/'lyrics.json';lyrics.write_text(json.dumps({'source':'edited','credit':'Local synthetic transport fixture','lines':[{'start':0,'end':12,'text':'Guide vocal fixture','words':[{'w':'Guide','s':0,'e':4},{'w':'vocal','s':4,'e':8},{'w':'fixture','s':8,'e':12}]}]}));lyrics_hash=sha(lyrics)
 env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ('SINGZ_PACK_DIR','SINGZ_MODELS_DIR','SINGZ_DEMUCS')}
 env.update(SINGZ_MUTE='1',SINGZ_NO_SYNC='1',SINGZ_NO_SYSTEM_ENGINES='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_TEST_NO_CAPTURE='1',SINGZ_GPUI_CONFIG_DIR=str(root/'prefs'),SINGZ_GPUI_PROJECTS_ROOT=str(root/'library'),SINGZ_GPUI_TEST_PROJECT=str(project),SINGZ_GPUI_TEST_GRAPH='1',SINGZ_GPUI_TEST_SAVE='1',SINGZ_GPUI_TEST_ANALYSIS='1',SINGZ_PACK_DIR=str(root/'missing-pack'),SINGZ_MODELS_DIR=str(root/'missing-models'))
 if a.karaoke:env['SINGZ_GPUI_TEST_KARAOKE']='1'
 if a.navigation:env['SINGZ_GPUI_TEST_NAVIGATION']='1'
 if a.region:env['SINGZ_GPUI_TEST_REGION']='1'
 for stage in ('first','restart'):
  folder=out/stage;folder.mkdir(exist_ok=True);samples=[];errors=[];previous=None;before=front();started=time.monotonic();next_sample=0;helpers={}
  input_project=json.loads((project/'project.json').read_text());input_guide_muted=input_project['settings']['tracks']['vocals']['muted']
  (folder/'stage-input.json').write_text(json.dumps({'stage':stage,'projectSha256':sha(project/'project.json'),'inputGuideMuted':input_guide_muted,'fixturePreparation':'For Karaoke restart only, vocals.muted was set false after the first-stage actual Save proof; all other project fields retained' if a.karaoke and stage=='restart' else 'original or normally saved fixture'},indent=2))
  stage_env={**env,'SINGZ_GPUI_INTEGRATION_TEST':str(folder)}
  if a.karaoke:stage_env.update(SINGZ_GPUI_TEST_KARAOKE_PREF_EXPECT='0' if stage=='first' else '1',SINGZ_GPUI_TEST_KARAOKE_PREF_FINISH='1' if stage=='first' else '0')
  with (folder/'app.log').open('w') as log:
   child=subprocess.Popen([str(app)],env=stage_env,stdout=log,stderr=subprocess.STDOUT)
   try:
    while child.poll() is None:
     assert time.monotonic()-started<120,'Native saved-graph UI timeout'
     if platform.system()=='Darwin' and time.monotonic()>=next_sample:
      next_sample=time.monotonic()+.5
      for value in subprocess.run(['pgrep','-P',str(child.pid)],capture_output=True,text=True,timeout=2).stdout.split():
       if value.isdecimal():
        identity=subprocess.run(['ps','-p',value,'-o','lstart=,comm='],capture_output=True,text=True,timeout=2).stdout.strip()
        if identity.endswith('singz-gpui-audio'):helpers[int(value)]=identity
      try:
       cpu,memory=perf.process_usage(child.pid);now=time.monotonic()
       if previous:samples.append({'cpuPercent':(cpu-previous[0])/1e9/(now-previous[1])*100,'footprintBytes':memory,'gpuSystem':perf.gpu_usage()})
       previous=cpu,now
      except OSError as error:errors.append(str(error))
     time.sleep(.1)
    assert child.returncode==0,(folder/'app.log').read_text()[-8000:]
   finally:
    if child.poll() is None:child.kill();child.wait()
    if child.returncode and (root/'prefs').exists():
     shutil.copytree(root/'prefs',folder/'failure-preferences',dirs_exist_ok=True)
  if platform.system()=='Darwin':
   assert helpers,'No real audio helper was observed'
   for pid,identity in helpers.items():
    remaining=subprocess.run(['ps','-p',str(pid),'-o','lstart=,comm='],capture_output=True,text=True,timeout=2).stdout.strip()
    assert remaining!=identity,('Audio helper survived app quit',pid)
  after=front();assert before==after,'Hidden test changed foreground application'
  text=(folder/'app.log').read_text();assert 'NATIVE_INTEGRATION passed:' in text and 'NATIVE_SAVE passed:' in text,text[-5000:]
  assert len(list(folder.glob('*.png')))==(6 if a.region else 4)
  from PIL import Image
  for image in folder.glob('*.png'):
   state=json.loads(image.with_suffix('.json').read_text());assert state['viewport']==([1060,640] if image.stem=='region-selection-1060' else [1280,800]) and state['hidden'],state
   assert Image.open(image).size==tuple(round(value*state['scale']) for value in state['viewport'])
  saved=json.loads((project/'project.json').read_text());assert saved['graphHash']==graph_hash and saved['foreign']==original['foreign'];assert sha(source)==source_hash and (project/'graph.json').read_bytes()==graph.read_bytes()
  assert saved['settings']['tracks']['vocals']['muted']==(True if a.karaoke else stage=='first')
  if a.karaoke:
   assert 'NATIVE_KARAOKE passed:' in text,text[-5000:]
   proof=json.loads((folder/'karaoke.json').read_text())
   for flag in ('productionNativeTransportEvent','unmutedNativeBaseline','onMutesNativeVocals','offRetainsMute','savedGuideMuted','reopenedNativeGuideMuted'):assert proof.get(flag) is True,(flag,proof)
   for name in ('onObservedLanes','offObservedLanes','reopenedObservedLanes'):
    assert next(lane for lane in proof[name] if lane['id']=='vocals')['muted'] is True,(name,proof)
   assert sha(project/'lyrics.json')==lyrics_hash,'Transport Karaoke altered the saved local lyrics fixture'
   preference=json.loads((folder/'karaoke-preference.json').read_text());initial=stage=='restart';finish=stage=='first'
   assert preference['initial']['preferred'] is initial and preference['initial']['visible'] is initial,preference
   assert preference['final']['preferred'] is finish and preference['final']['visible'] is finish,preference
   assert preference['durableWorkerAcknowledged'] is True and preference['final']['savedSequence']==preference['final']['sequence']>0,preference
   assert json.loads((root/'prefs/audio.json').read_text())['karaoke'] is finish,'Durably acknowledged Karaoke preference did not reach audio.json'
   if initial:assert preference['initial']['nativeVocalsMuted'] is True,preference
   if initial:
    assert input_guide_muted is False,'Restart must prove preferred On mutes an initially enabled guide'
    assert preference['offViaActualEscape'] is True and preference['escapeSelectionWasNone'] is True,preference
  if a.navigation:
   assert 'NATIVE_NAVIGATION passed:' in text,text[-5000:]
   proof=json.loads((folder/'navigation.json').read_text())
   for flag in ('headerEntitySubscription','songsPausesPlayer','repeatedSongsStaysPaused','normalTransportResume','catalogPausesAndOpensLibrary','trainingRemembersCatalog','songsReturnsToRememberedLibrary','catalogReturnsToPausedPlayer','sameNativeEpoch'):assert proof.get(flag) is True,(flag,proof)
  if a.region:
   assert 'NATIVE_REGION passed:' in text,text[-5000:]
   proof=json.loads((folder/'region.json').read_text())
   for flag in ('actualWaveDrag','actualRulerDrag','bothEdgeResize','actualClickClear','actualEscapeClear','nativeNonloopEndStop','nativeLoopWrap','savedSelectionReopened','savedNoneReopened','restoredBaseline'):assert proof.get(flag) is True,(flag,proof)
   assert proof['sizes']==[[1280,800],[1060,640]]
   assert proof['endStop']['native']['playing'] is False and proof['endStop']['native']['loop'] is None
   assert abs(proof['endStop']['native']['position']-proof['endStop']['selection'][1])<.03
   assert proof['loopWrap']['native']['playing'] is True and proof['loopWrap']['native']['loopCount']>0
   assert proof['reopenedSome']['selection'] is not None and proof['reopenedSome']['looping'] is True
   assert 'selection' not in saved['settings'] and saved['settings']['loop'] is False
   for width in (1280,1060):
    state=json.loads((folder/f'region-selection-{width}.json').read_text());assert state['selection'] is not None and not state['regionBusy'] and not state['gesture']
  (folder/'project-after.json').write_text(json.dumps(saved,indent=2));(folder/'observer.json').write_text(json.dumps({'foregroundUnchanged':before==after,'samples':samples,'errors':errors,'liveFps':'unmeasured','scope':'app CPU/footprint only; helper CPU excluded; GPU system-wide','observedHelpersRetired':list(helpers)},indent=2))
  results.append({'stage':stage,'captures':6 if a.region else 4,'foregroundUnchanged':before==after,'inputGuideMuted':input_guide_muted})
  if a.karaoke and stage=='first':
   # Controlled next-launch fixture preparation, after the real Save proof
   # above has already been retained in first/project-after.json.
   before_preparation=sha(project/'project.json');prepared=json.loads(json.dumps(saved));prepared['settings']['tracks']['vocals']['muted']=False
   (project/'project.json').write_text(json.dumps(prepared));assert sha(source)==source_hash and sha(project/'lyrics.json')==lyrics_hash and (project/'graph.json').read_bytes()==graph.read_bytes()
   (folder/'restart-fixture-preparation.json').write_text(json.dumps({'fixturePreparationOnly':True,'firstStageSavedGuideMuted':saved['settings']['tracks']['vocals']['muted'],'nextLaunchGuideMuted':False,'onlyChangedField':'settings.tracks.vocals.muted','beforeProjectSha256':before_preparation,'afterProjectSha256':sha(project/'project.json'),'graphAudioLyricsUnchanged':True},indent=2))
(out/'result.json').write_text(json.dumps({'passed':True,'appSha256':sha(app),'helperSha256':sha(app.with_name('singz-gpui-audio.exe' if platform.system()=='Windows' else 'singz-gpui-audio')),'graphSha256':sha(graph),'regionGesturesNativeBoundariesAndPersistence':a.region,'actualGraphAdmission':True,'actualSaveAndRestart':True,'karaokeRestoredOnMutesInitiallyEnabledGuide':a.karaoke,'karaokeEscapePersistsOff':a.karaoke,'karaokePreferencePersistenceAndRelaunch':a.karaoke,'karaokeNativeMuteAndPersistence':a.karaoke,'karaokeScope':'Production native_transport event route; real native vocals lane; Save/reopen/restart; no measured Karaoke button click' if a.karaoke else 'not exercised','navigationNativePauseAndRememberedCatalog':a.navigation,'navigationScope':'Production Header entity events and transport subscription; native pause receipts; no measured header button clicks' if a.navigation else 'not exercised','savedLyricsFixtureSha256':lyrics_hash,'stages':results,'muted':True,'hidden':True,'newProductionParity':'unqualified','liveFps':'unmeasured'},indent=2))
