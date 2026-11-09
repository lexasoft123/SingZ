"""Hidden native saved-graph open/playback/Save/restart; no global input or Node."""
import argparse, errno, hashlib, importlib.util, json, math, os, platform, shutil, signal, struct, subprocess, sys, tempfile, time, wave
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('app',type=Path);p.add_argument('out',type=Path);p.add_argument('--karaoke',action='store_true',help='Also prove production Karaoke event mutes native vocals and persists across Save/reopen');p.add_argument('--navigation',action='store_true',help='Also prove Songs/Catalog pause and Training remembered catalog through production header events');p.add_argument('--region',action='store_true',help='Also prove real region gestures, native stop/wrap and selection Save/reopen');p.add_argument('--output',action='store_true',help='Also verify native song output controls');p.add_argument('--catalog',action='store_true',help='Also verify fresh catalog scans and keyboard actions');p.add_argument('--timeline',action='store_true',help='Also verify actual native timeline wheel/pinch/seek/follow');p.add_argument('--lyrics-countdown',action='store_true',help='Verify native instrumental-gap lyric cues');p.add_argument('--keyboard',action='store_true',help='Verify transport keys from focused controls');p.add_argument('--footer-keyboard',action='store_true',help='Verify footer focus, native actions and owned Split menu keys');a=p.parse_args();app=a.app.resolve(strict=True);out=a.out.resolve();out.mkdir(parents=True,exist_ok=True)
assert not any(out.iterdir()),'Native graph UI tests require a fresh OUT'
if a.footer_keyboard:assert a.keyboard and a.karaoke,'Footer keys require --keyboard and --karaoke with isolated saved lyrics'
if a.timeline or a.lyrics_countdown:assert a.karaoke,'Timeline/countdown cases require the isolated local Karaoke lyrics fixture'
expected_captures=4+2*int(a.region)+2*int(a.output)+2*int(a.catalog)+8*int(a.timeline)+4*int(a.lyrics_countdown)+4*int(a.keyboard)+4*int(a.footer_keyboard)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
sys.dont_write_bytecode=True
def sibling(name,filename):
 spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename))
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
perf=sibling('graph_perf','interface-perf.py')
processes=sibling('graph_processes','test_native_lyrics_live.py')
foreground=sibling('graph_foreground','test_native_lyrics_real.py').foreground

def run_observed(folder,env,timeout):
 """Observe owned identities and resources; screenshots do not qualify live FPS."""
 mac=platform.system()=='Darwin'
 front=lambda:foreground() if mac else {'available':False,'reason':'Foreground observation unavailable on this platform'}
 before=front();fronts=[];owners={};samples=[];errors=[];rejected=[];terminal_discards=[]
 started=time.monotonic();previous=None;next_sample=started
 with (folder/'app.log').open('w') as log:
  child=subprocess.Popen([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:
   while child.poll() is None:
    assert time.monotonic()-started<timeout,'Native saved-graph UI timeout'
    if mac:
     table=processes.process_table();active={child.pid}|{row['pid'] for row in owners.values() if processes.same_process(row,table.get(row['pid']))}
     changed=True
     while changed:
      changed=False
      for row in table.values():
       if row['pid'] in active or row['parent'] in active:
        owners[(row['pid'],row['start'],row['command'])]=row
        if row['pid'] not in active:active.add(row['pid']);changed=True
     fronts.append(front())
     def confirmed_terminal():
      if child.poll() is not None:return True
      try:child.wait(timeout=.1)
      except subprocess.TimeoutExpired:return False
      return True
     if time.monotonic()>=next_sample:
      next_sample=time.monotonic()+.5
      raw={'pid':child.pid,'previousCpuNanoseconds':previous[0] if previous else None,'previousSampleMonotonic':previous[1] if previous else None}
      try:
       cpu,memory=perf.process_usage(child.pid);now=time.monotonic()
       raw.update(cpuNanoseconds=cpu,footprintBytes=memory,sampleMonotonic=now,elapsedSeconds=now-started)
       percent=(cpu-previous[0])/(1e9*(now-previous[1]))*100 if previous is not None else None
       raw['cpuPercent']=percent
       valid=math.isfinite(cpu) and cpu>=0 and memory>0 and (percent is None or math.isfinite(percent) and percent>=0)
       if not valid:
        record={'reason':'Invalid CPU counter, CPU delta or footprint','rawReadback':raw,'processConfirmedTerminal':confirmed_terminal()};rejected.append(record)
        if record['processConfirmedTerminal']:terminal_discards.append(record)
        else:errors.append(record)
        previous=None
       else:
        if percent is not None:samples.append({'elapsedSeconds':now-started,'cpuPercent':percent,'footprintBytes':memory,'gpuSystem':perf.gpu_usage()})
        previous=(cpu,now)
      except (OSError,RuntimeError) as error:
       gone=isinstance(error,OSError) and error.errno in (errno.ESRCH,errno.ENOENT)
       terminal=confirmed_terminal() if gone else False
       record={'reason':str(error),'exceptionType':type(error).__name__,'errno':getattr(error,'errno',None),'rawReadback':raw,'processConfirmedTerminal':terminal};rejected.append(record)
       if gone and terminal:terminal_discards.append(record)
       else:errors.append(record)
       previous=None
    time.sleep(.2)
  finally:
   forced=child.poll() is None
   if forced:
    child.terminate()
    try:child.wait(timeout=5)
    except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
   remaining=[];survivors=[]
   if mac:
    deadline=time.monotonic()+8
    while True:
     table=processes.process_table();remaining=[row for row in owners.values() if processes.same_process(row,table.get(row['pid']))]
     if not remaining or time.monotonic()>=deadline:break
     time.sleep(.2)
    survivors=list(remaining)
    for sig,delay in ((signal.SIGTERM,1),(signal.SIGKILL,0)):
     table=processes.process_table()
     for row in remaining:
      if row['pid']!=child.pid and processes.same_process(row,table.get(row['pid'])):
       try:os.kill(row['pid'],sig)
       except ProcessLookupError:pass
     if delay and remaining:time.sleep(delay)
     table=processes.process_table();remaining=[row for row in remaining if processes.same_process(row,table.get(row['pid']))]
   after=front();observations=[before,*fronts,after]
   available=all(row.get('available') for row in observations)
   stable=available and all(row['identity']==before['identity'] for row in observations)
   helpers=[row for row in owners.values() if row['command'].endswith('singz-gpui-audio')]
   observation={'foregroundUnchanged':stable if mac else None,'foregroundScope':'continuous available macOS identity observations' if mac else 'unqualified',
    'samples':samples,'errors':errors,'rejectedSamples':rejected,'terminalDiscardCount':len(terminal_discards),'terminalDiscards':terminal_discards,
    'liveFps':'unmeasured','scope':'app CPU/footprint only; helper CPU excluded; GPU system-wide','observedHelpersRetired':[row['pid'] for row in helpers],
    'summary':{'cpuPercent':perf.summarize([row['cpuPercent'] for row in samples]),'footprintBytes':perf.summarize([row['footprintBytes'] for row in samples]),
     'systemGpuAvailableSamples':sum(row['gpuSystem'].get('available') is True for row in samples),'systemGpuUnavailableReasons':sorted({row['gpuSystem'].get('reason','unavailable') for row in samples if row['gpuSystem'].get('available') is not True}),'performanceVerdict':'Resource observations only; live display cadence unqualified'}}
   (folder/'observer.json').write_text(json.dumps(observation,indent=2))
   (folder/'foreground.json').write_text(json.dumps({'before':before,'after':after,'samples':fronts,'allAvailable':available,'unchanged':stable},indent=2))
   (folder/'process-exit.json').write_text(json.dumps({'pid':child.pid,'terminal':True,'returncode':child.returncode,'forcedStop':forced,'wallSeconds':time.monotonic()-started,'observed':list(owners.values()),'survivorsBeforeCleanup':survivors,'survivorsAfterCleanup':remaining,'scope':'recursive observed process identities' if mac else 'app process only; helper retirement unqualified'},indent=2))
 assert child.returncode==0 and not forced,(folder/'app.log').read_text()[-8000:]
 if mac:
  assert helpers,'No real native audio helper was observed'
  assert owners and not survivors and not remaining,'Observed native process failed natural retirement'
  assert stable,'Hidden test changed foreground or foreground identity was unavailable'
  assert samples and not errors,'Invalid live CPU/GPU resource observation'
 return observation
results=[]
with tempfile.TemporaryDirectory(prefix='singz-native-graph-ui-') as tmp:
 root=Path(tmp).resolve();
 for name in ('tmp','cache'):(root/name).mkdir()
 project=root/'library/Native graph fixture';(project/'stems').mkdir(parents=True)
 source=project/'stems/vocals.wav'
 with wave.open(str(source),'wb') as w:
  w.setparams((1,2,48000,0,'NONE','not compressed'));w.writeframes(b''.join(struct.pack('<h',round(8000*math.sin(i*math.tau*220/48000))) for i in range(48000))*12)
 graph=Path(__file__).resolve().parents[3]/'tests/shared/native-playback-graph.json';(project/'graph.json').write_bytes(graph.read_bytes());graph_hash={'format':1,'size':graph.stat().st_size,'md5':hashlib.md5(graph.read_bytes()).hexdigest(),'mtimeMs':0}
 original={'version':2,'name':'Native graph fixture','foreign':{'preserve':'opaque project data'},'graphHash':graph_hash,'settings':{'tracks':{'vocals':{'volume':.7,'muted':False}},'masterVolume':.6,'tempo':1,'transpose':0,'metronome':{'click':False,'countInBars':0,'volume':.7,'accent':True}}}
 (project/'project.json').write_text(json.dumps(original));source_hash=sha(source)
 lyrics_hash=None
 if a.karaoke:
  # Valid local saved lyrics prevent this transport regression from using LRCLIB.
  lines=[{'start':0,'end':12,'text':'Guide vocal fixture','words':[{'w':'Guide','s':0,'e':4},{'w':'vocal','s':4,'e':8},{'w':'fixture','s':8,'e':12}]}]
  if a.lyrics_countdown:
   lines=[{'start':6,'end':7,'text':'Guide vocal fixture','words':[{'w':'Guide','s':6,'e':6.3},{'w':'vocal','s':6.3,'e':6.6},{'w':'fixture','s':6.6,'e':7}]},{'start':11,'end':12,'text':'Next line','words':[{'w':'Next','s':11,'e':11.5},{'w':'line','s':11.5,'e':12}]}]
  lyrics=project/'lyrics.json';lyrics.write_text(json.dumps({'source':'edited','credit':'Local synthetic transport fixture','lines':lines}));lyrics_hash=sha(lyrics)
 env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_')}
 env.update(SINGZ_MUTE='1',SINGZ_NO_SYNC='1',SINGZ_NO_SYSTEM_ENGINES='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_TEST_NO_CAPTURE='1',SINGZ_GPUI_CONFIG_DIR=str(root/'prefs'),SINGZ_GPUI_PROJECTS_ROOT=str(root/'library'),SINGZ_GPUI_TEST_PROJECT=str(project),SINGZ_GPUI_TEST_GRAPH='1',SINGZ_GPUI_TEST_SAVE='1',SINGZ_GPUI_TEST_ANALYSIS='1',SINGZ_PACK_DIR=str(root/'missing-pack'),SINGZ_MODELS_DIR=str(root/'missing-models'),SINGZ_LLAMA_SERVER=str(root/'missing-llama'),SINGZ_CRISPASR=str(root/'missing-crispasr'),TMPDIR=str(root/'tmp'),XDG_CACHE_HOME=str(root/'cache'),HF_HOME=str(root/'cache/huggingface'),TORCH_HOME=str(root/'cache/torch'),PYTHONDONTWRITEBYTECODE='1')
 if a.karaoke:env['SINGZ_GPUI_TEST_KARAOKE']='1'
 if a.navigation:env['SINGZ_GPUI_TEST_NAVIGATION']='1'
 if a.region:env['SINGZ_GPUI_TEST_REGION']='1'
 if a.output:env['SINGZ_GPUI_TEST_OUTPUT']='1'
 if a.catalog:env['SINGZ_GPUI_TEST_CATALOG']='1'
 if a.timeline:env['SINGZ_GPUI_TEST_TIMELINE']='1'
 if a.lyrics_countdown:env['SINGZ_GPUI_TEST_LYRICS_COUNTDOWN']='1'
 if a.keyboard:env['SINGZ_GPUI_TEST_KEYBOARD']='1'
 if a.footer_keyboard:env['SINGZ_GPUI_TEST_FOOTER_KEYBOARD']='1'
 for stage in ('first','restart'):
  folder=out/stage;folder.mkdir()
  input_project=json.loads((project/'project.json').read_text());input_guide_muted=input_project['settings']['tracks']['vocals']['muted']
  (folder/'stage-input.json').write_text(json.dumps({'stage':stage,'projectSha256':sha(project/'project.json'),'inputGuideMuted':input_guide_muted,'fixturePreparation':'For Karaoke restart only, vocals.muted was set false after the first-stage actual Save proof; all other project fields retained' if a.karaoke and stage=='restart' else 'original or normally saved fixture'},indent=2))
  stage_env={**env,'SINGZ_GPUI_INTEGRATION_TEST':str(folder)}
  if a.karaoke:stage_env.update(SINGZ_GPUI_TEST_KARAOKE_PREF_EXPECT='0' if stage=='first' else '1',SINGZ_GPUI_TEST_KARAOKE_PREF_FINISH='1' if stage=='first' else '0')
  try:
   observation=run_observed(folder,stage_env,420 if a.footer_keyboard else 240 if a.timeline or a.lyrics_countdown or a.keyboard else 180 if a.output or a.catalog else 120)
  except BaseException:
   if (root/'prefs').exists():shutil.copytree(root/'prefs',folder/'failure-preferences',dirs_exist_ok=True)
   raise
  text=(folder/'app.log').read_text();assert 'NATIVE_INTEGRATION passed:' in text and 'NATIVE_SAVE passed:' in text,text[-5000:]
  assert len(list(folder.glob('*.png')))==expected_captures
  from PIL import Image
  for image in folder.glob('*.png'):
   state=json.loads((image.with_suffix('.state.json') if image.stem.startswith('footer-') else image.with_suffix('.json')).read_text());assert state['viewport']==([1060,640] if image.stem.endswith('-1060') else [1280,800]) and state['hidden'],state
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
   for flag in ('actualWaveDrag','actualRulerDrag','bothEdgeResize','actualClickClear','actualEscapeClear','nativeNonloopEndStop','nativeLoopWrap','savedSelectionReopened','savedNoneReopened','restoredBaseline','actualRestartAlternation','restartResetsAfterPlayback','restartResetsAfterReopen','restartWithoutSelection','restartPreservedAcrossPlayingRename','renameCatalogPauseWins','renameOriginalPathRestored'):assert proof.get(flag) is True,(flag,proof)
   assert proof['sizes']==[[1280,800],[1060,640]]
   assert proof['endStop']['native']['playing'] is False and proof['endStop']['native']['loop'] is None
   assert abs(proof['endStop']['native']['position']-proof['endStop']['selection'][1])<.03
   assert proof['loopWrap']['native']['playing'] is True and proof['loopWrap']['native']['loopCount']>0
   assert proof['reopenedSome']['selection'] is not None and proof['reopenedSome']['looping'] is True
   assert 'selection' not in saved['settings'] and saved['settings']['loop'] is False
   for width in (1280,1060):
    state=json.loads((folder/f'region-selection-{width}.json').read_text());assert state['selection'] is not None and not state['regionBusy'] and not state['gesture']
  if a.timeline:
   assert 'NATIVE_TIMELINE passed:' in text,text[-5000:]
   proof=json.loads((folder/'timeline.json').read_text())
   for flag in ('sameFrameRulerClearance','fitKaraokeOffAndOnCaptured','actualZoomButtons','pausedPlayheadAtZoomControlsCaptured','pinchAfterKeyboardSave','cursorCenteredWheelZoom','burstPanAccumulated','pitchWheelPan','pitchPinchZoom','manualViewSavedReopened','actualOffscreenArrowSeekCuts','playingPageTurnHasIntermediateViews','manualPanAwayDoesNotSnapBack','actualRestartCutsBack','restoredBaseline'):assert proof.get(flag) is True,(flag,proof)
   assert proof['sizes']==[[1280,800],[1060,640]]
   for width in (1280,1060):
    for karaoke in (False,True):
     fit=json.loads((folder/f'timeline-fit-karaoke-{str(karaoke).lower()}-{width}.json').read_text())
     assert fit['view']==[0.0,1.0] and fit['duration']==12,fit
     labels=fit['timeline']['ruler']['labels'];assert labels,fit
     for label in labels:
      assert label['width']>0 and label['zoomWidth']>0,label
      left=fit['timeline']['ruler']['zoomGroup']['left']
      assert abs(left-label['groupLeft'])<.01,label
      assert label['admitted']==(label['right']<=left),label
     if width==1060 and not karaoke:
      ten=[label for label in labels if label['text']=='0:10']
      assert ten and all(not label['admitted'] for label in ten),labels
   assert len(proof['follow'])>8 and proof['seekCut']['view'][0]>0,proof
  if a.output:
   assert 'NATIVE_SONG_OUTPUT passed:' in text,text[-5000:]
   proof=json.loads((folder/'output.json').read_text())
   for flag in ('actualPopupTrigger','actualOuterThumbDrag','actualRangeKeys','silentMinimum','plus12Headroom','halfDbStep','actualMuteRestore','actualUnity','actualClipReset','actualEscapeDismiss','underlyingTransportUnchanged','savedUnityReopened','restoredOriginalGain','savedZeroFreshReopenUnmuteUnity'):assert proof.get(flag) is True,(flag,proof)
   assert proof['clippingRuntimeQualified'] is False,proof
   assert abs(saved['settings']['masterVolume']-original['settings']['masterVolume'])<1e-6,saved
  if a.catalog:
   assert 'NATIVE_CATALOG passed:' in text,text[-5000:]
   proof=json.loads((folder/'catalog.json').read_text())
   for flag in ('externalCreationRescanned','searchShortcut','actualKeyboardOpen','externalRenameRescanned','keyboardDeleteConfirmation','escapePreservesProject','vanishedFocusedCardFallsBackToSearch','externalRemovalRescanned','restoredBaseline'):assert proof.get(flag) is True,(flag,proof)
  if a.lyrics_countdown:
   assert 'NATIVE_LYRICS_COUNTDOWN passed:' in text,text[-5000:]
   proof=json.loads((folder/'countdown.json').read_text())
   for flag in ('actualKaraokePlayPauseControls','initialLongGapSeconds','introThreeTwoOne','laterGapThreeTwoOne','pausedCueRemoved','singingCueClear','cachedSpriteRendered','restoredBaseline'):assert proof.get(flag) is True,(flag,proof)
   assert proof['sizes']==[[1280,800],[1060,640]]
  if a.keyboard:
   assert 'NATIVE_DESKTOP_KEYBOARD passed:' in text,text[-5000:]
   proof=json.loads((folder/'keyboard.json').read_text())
   for flag in ('actualTabToButton','spaceFromButtonPlaysPauses','spaceBlursButtonAndKeyupDoesNotActivate','arrowsFromButtonSeek','enterStillActivatesLogAndSave','logOwnsTransportKeys','titleSpaceAndArrowsStayText','outputDialogSliderOwnsKeys','stemFaderTabReachable','stemFaderPointerFocus','stemFaderBurstKeysAccumulate','stemFaderHomeEndClamp','stemFaderKeysReachNativeGainWithoutSeeking','stemFaderSpaceRetainsFocusAndGain','restoredBaseline'):assert proof.get(flag) is True,(flag,proof)
   for flag in ('mixerButtonsTabReachable','mixerButtonsPointerFocus','mixerButtonsEnterReachesNativeMuteSolo','mixerButtonsSpaceIsTransportOnly','mixerButtonsArrowsSeekWithFocus','mixerButtonsRestoredAndSaved','mixerResetTabReachable','mixerResetEnterAndPointerReachNative','mixerResetDisabledSkipped','mixerResetDisabledFocusReturnsToRoot','mixerResetSpaceIsTransportOnly','mixerResetArrowsSeekWithFocus','trackHeaderTabReachable','trackHeaderSpaceIsTransportOnly','trackHeaderArrowsSeekWithFocus','trackHeaderExportEnterEscape'):assert proof.get(flag) is True,(flag,proof)
   assert proof['sizes']==[[1280,800],[1060,640]]
   assert 'NATIVE_METRONOME_KEYBOARD passed:' in text,text[-5000:]
   proof=json.loads((folder/'metronome-keyboard.json').read_text())
   for flag in ('actualTabAndPointerFocus','bpmTypingOwnsSongKeys','burstRangeKeysAccumulate','homeEndClamp','rangeArrowsDoNotSeek','nonmodalSpaceTogglesSong','rangeSpaceRetainsFocus','buttonSpaceDoesNotActivate','buttonArrowsSeek','enterActivatesAccent','nativeTransactionsAccepted','restoredSavedBaseline','disabledHalfFocusRecoversTransport','boundaryGridRestoredThroughProductionOpen','tapSessionResetOnActualReopen','threeFreshTapsAccepted','gridOnlyTriggerActive','countInOnlyTriggerInactive'):assert proof.get(flag) is True,(flag,proof)
   assert proof['sizes']==[[1280,800],[1060,640]]
  if a.footer_keyboard:
   proof=json.loads((folder/'footer-keyboard.json').read_text())
   for flag in ('actualTabAndShiftTab','enterPlayPause','enterRestart','nativeLoop','nativeKaraokeMute','nativeTranspose','nativeTempo','nativeBpmSteps','metCarryEnterEscape','outputKeysContained','outputPopupButtonsActivateOnce','splitNavigationDisabledSkip','splitEscapeContained','splitActualMissingEngineRefusal','baselineRestored','focusedControlRemovalRecoversRoot','recoveryDoesNotStealLaterPointerFocus','disabledMenuRecoversScope'):
    assert proof.get(flag) is True,(flag,proof)
   assert proof['sizes']==[[1280,800],[1060,640]] and proof['inferenceTested'] is False
   assert proof['liveFps']=='unmeasured' and proof['receipts'] and proof['fixturePreparations']
   assert proof['outputNativeSilentByFixture'] is True and proof['nativePositiveMasterGainTested'] is False
   assert proof['outputGainScope']=='Host output controls restore positive gain and unity; SINGZ_MUTE=1 clamps actual native song/reference master gain to zero throughout. Positive native master gain and audible output are not tested.'
   for width,height in ((1280,800),(1060,640)):
    output_receipts=[]
    for phase in ('output-popup-mute-enter','output-popup-unmute-space','output-popup-unity-enter'):
     rows=[row for row in proof['receipts'] if row['phase']==phase and row['viewport']==[width,height]]
     assert len(rows)==1,(phase,width,rows)
     row=rows[0];host=row['masterVolume'];native=row['native']['masterGain']
     assert all(isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) for value in (host,native)),row
     # The mandatory muted fixture keeps actual native output silent even
     # while host controls restore their previous positive gain or unity.
     assert abs(native)<.00001 and row['playing'] is False and row['native']['playing'] is False,row
     if phase=='output-popup-mute-enter':assert abs(host)<.00001,row
     elif phase=='output-popup-unmute-space':assert host>0,row
     else:assert abs(host-1)<.00001,row
     output_receipts.append(row)
    assert len({row['seekCount'] for row in output_receipts})==1
    assert max(row['position'] for row in output_receipts)-min(row['position'] for row in output_receipts)<.03
    for phase in ('focused','split'):
     name=f'footer-{phase}-{width}';state=json.loads((folder/f'{name}.state.json').read_text())
     assert state['viewport']==[width,height] and state['hidden'] is True and state['active'] is False
     keyboard=state['keyboard'];assert keyboard['focusedControl']==('transport-play' if phase=='focused' else 'split-stems')
     assert keyboard['splitOpen'] is (phase=='split')
     if phase=='split':assert keyboard['splitFocused'] is True and keyboard['splitFocusOrder']==['split-stems']
     scale=state['scale'];assert isinstance(scale,(int,float)) and math.isfinite(scale) and scale>0
     with Image.open(folder/f'{name}.png') as image:assert list(image.size)==state['raster']==[round(width*scale),round(height*scale)]
  (folder/'project-after.json').write_text(json.dumps(saved,indent=2))
  results.append({'stage':stage,'captures':expected_captures,'foregroundUnchanged':observation['foregroundUnchanged'],'inputGuideMuted':input_guide_muted})
  if a.karaoke and stage=='first':
   # Controlled next-launch fixture preparation, after the real Save proof
   # above has already been retained in first/project-after.json.
   before_preparation=sha(project/'project.json');prepared=json.loads(json.dumps(saved));prepared['settings']['tracks']['vocals']['muted']=False
   (project/'project.json').write_text(json.dumps(prepared));assert sha(source)==source_hash and sha(project/'lyrics.json')==lyrics_hash and (project/'graph.json').read_bytes()==graph.read_bytes()
   (folder/'restart-fixture-preparation.json').write_text(json.dumps({'fixturePreparationOnly':True,'firstStageSavedGuideMuted':saved['settings']['tracks']['vocals']['muted'],'nextLaunchGuideMuted':False,'onlyChangedField':'settings.tracks.vocals.muted','beforeProjectSha256':before_preparation,'afterProjectSha256':sha(project/'project.json'),'graphAudioLyricsUnchanged':True},indent=2))
(out/'result.json').write_text(json.dumps({'passed':True,'appSha256':sha(app),'helperSha256':sha(app.with_name('singz-gpui-audio.exe' if platform.system()=='Windows' else 'singz-gpui-audio')),'graphSha256':sha(graph),'catalogRefreshAndKeyboardActions':a.catalog,'timelineNavigation':a.timeline,'lyricsGapCountdown':a.lyrics_countdown,'focusedButtonTransportKeys':a.keyboard,'footerKeyboardControls':a.footer_keyboard,'mixerKeyboardControls':a.keyboard,'nonmodalMetronomeKeyboardControls':a.keyboard,'songOutputControls':a.output,'regionGesturesNativeBoundariesAndPersistence':a.region,'actualGraphAdmission':True,'actualSaveAndRestart':True,'karaokeRestoredOnMutesInitiallyEnabledGuide':a.karaoke,'karaokeEscapePersistsOff':a.karaoke,'karaokePreferencePersistenceAndRelaunch':a.karaoke,'karaokeNativeMuteAndPersistence':a.karaoke,'karaokeScope':'Production native_transport event route; real native vocals lane; Save/reopen/restart; no measured Karaoke button click' if a.karaoke else 'not exercised','navigationNativePauseAndRememberedCatalog':a.navigation,'navigationScope':'Production Header entity events and transport subscription; native pause receipts; no measured header button clicks' if a.navigation else 'not exercised','savedLyricsFixtureSha256':lyrics_hash,'stages':results,'muted':True,'hidden':True,'newProductionParity':'unqualified','liveFps':'unmeasured'},indent=2))
