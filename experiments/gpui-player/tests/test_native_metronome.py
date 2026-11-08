"""Native cue transactions/preview/count-in; no Node, hardware mode muted."""
import argparse,hashlib,json,os,selectors,subprocess,tempfile,time,wave
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('helper',type=Path);p.add_argument('out',type=Path);p.add_argument('--hardware',action='store_true');a=p.parse_args();helper=a.helper.resolve();out=a.out.resolve();out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='singz-native-met-') as folder:
 source=Path(folder)/'cue song — тест.wav'
 with wave.open(str(source),'wb') as audio:audio.setparams((1,2,48000,0,'NONE','not compressed'));audio.writeframes(bytes(48000*12*2))
 child=subprocess.Popen([str(helper),*([] if a.hardware else ['--test-fake-host']),'vocals',str(source)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env={**os.environ,'SINGZ_MUTE':'1'})
 selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ);receipts=[]
 def read():
  assert selector.select(15),'Native metronome timed out';line=child.stdout.readline();assert line,'Helper exited';v=json.loads(line);assert v['protocol']==1 and v['masterGain']==0 and v['referenceGain']==0 and v['cueGain']==0 and v['outputPeak']==0,('mute',v);receipts.append(v);return v
 def command(s,ok=True):
  (out/'last-command.txt').write_text(s);assert len(s)<4096;child.stdin.write(s+'\n');child.stdin.flush();v=read();assert v['ok']==ok,(s,v);return v
 def eventually(predicate):
  deadline=time.monotonic()+6
  while time.monotonic()<deadline:
   v=command('status')
   if predicate(v):return v
   time.sleep(.02)
  raise AssertionError(v)
 def met(click=True,bars=0,volume=.7,accent=True,beats=None,downbeats=None,meter=4,db=0,ok=True):
  beats=beats or [];downbeats=downbeats or [];before=command('status');command(f'met-begin {int(click)} {bars} {volume} {int(accent)} {meter} {db} {len(beats)} {len(downbeats)}')
  for key,values in [('beats',beats),('bars',downbeats)]:
   for i in range(0,len(values),96):command(f'met-{key} {i} {len(values[i:i+96])} '+' '.join(str(n) for n in values[i:i+96]))
  staged=command('status');assert staged['graphGeneration']==before['graphGeneration'],'Staging changed live graph';return command('met-apply',ok)
 try:
  initial=read();assert initial['ok'];g=initial['graphGeneration'];v=command('pause');assert v['baseCallbacks']==0 and not v['playing']
  # Failed staging and planner validation retain the prior playable graph.
  for bad in ['met-apply','met-preview 2','met-begin 1 0 .7 1 4 0 0 0','met-begin 0 3 .7 1 4 0 0 0','met-begin 0 0 nan 1 4 0 0 0','met-begin 0 0 .7 1 5 0 0 0','met-begin 0 0 .7 1 4 4 2 0','met-begin 0 0 .7 1 4 0 20001 0']:
   assert command(bad,False)['graphGeneration']==g
  command('met-begin 1 0 .7 1 4 0 4 0');command('met-beats 0 2 0 .5');command('met-apply',False)
  command('met-begin 1 0 .7 1 4 0 2 0');command('met-beats 1 1 .5',False);command('met-apply',False)
  command('met-begin 1 0 .7 1 4 0 2 0');command('met-beats 0 2 0 .01',False);command('met-apply',False)
  command('met-begin 1 0 .7 1 4 0 2 0');command('met-beats 0 2 0 3');assert command('met-apply',False)['graphGeneration']==g
  command('met-begin 1 0 .7 1 4 0 4 2');command('met-beats 0 4 0 .5 1 1.5');command('met-bars 0 2 2 1',False);assert command('met-apply',False)['graphGeneration']==g
  # Initial plan and preview own the existing paused graph/output.
  beats=[i*.2 for i in range(60)];v=met(beats=beats);assert v['cueEventCount']>=59 and not v['playing'] and v['metronomeClick']
  v=command('met-preview 1');stream=v['streamGeneration'];assert not v['playing']
  eventually(lambda s:s['previewClicksCompleted']>=1);v=met(beats=beats,volume=.5);assert not v['playing'] and v['streamGeneration']==stream;command('play');eventually(lambda s:s['playing'] and s['position']>.1)
  before=command('status');v=met(beats=beats,volume=.3,accent=False);assert v['playing'] and v['streamGeneration']==stream and v['swapLandings']>before['swapLandings'] and not v['metronomeAccent'] and v['metronomeVolume']==.3
  v=command('rate .8 2');assert v['playing'] and v['streamGeneration']==stream and v['cueEventCount']>0
  command('pause');eventually(lambda s:not s['playing']);command('seek 3');eventually(lambda s:abs(s['position']-3)<.03)
  # Every explicit Play counts in at the selected original-song position.
  v=met(beats=beats,bars=1,meter=3);assert not v['playing'] and v['countInEvents']==0
  # Same-song rename/split handoff resumes a freshly prepared plan flat;
  # the saved count-in preference still applies to later explicit Play.
  v=command('play-flat');assert not v['countingIn'] and v['countInEvents']==0
  v=eventually(lambda s:s['playing'] and s['position']>3.05);assert not v['countingIn'] and v['countInEvents']==0
  command('pause');eventually(lambda s:not s['playing']);command('seek 3');eventually(lambda s:abs(s['position']-3)<.03)
  v=command('play');assert v['countInEvents']==3 and v['countInBeatsPerBar']==3 and v['preRollFrames']>0
  eventually(lambda s:s['countingIn']);v=eventually(lambda s:s['playing'] and not s['countingIn'] and s['position']>=3);assert v['position']<4
  command('pause');eventually(lambda s:not s['playing']);command('play');eventually(lambda s:s['countingIn']);command('pause');eventually(lambda s:not s['playing'])
  # Meter map changes are shared planner truth; local 2-beat bar counts two.
  command('rate 1 0');command('seek 1');eventually(lambda s:abs(s['position']-1)<.03)
  met(beats=beats,bars=1,meter=4,downbeats=[0,4,6,10,14,18,22,26,30,34,38,42,46,50,54,58]);v=command('play');assert v['countInEvents']==2 and v['countInBeatsPerBar']==2,v
  eventually(lambda s:s['playing'] and not s['countingIn']);command('pause');eventually(lambda s:not s['playing'])
  # Click-off gridless count-in remains three seconds per selected bar.
  met(click=False,bars=1);v=command('play');assert v['countInEvents']==3 and v['countInBeatsPerBar']==3 and abs(v['preRollFrames']/v['sampleRate']-3)<.001;command('pause');eventually(lambda s:not s['playing'])
  # Full-size uploads remain bounded, and later controls retain the plan.
  before=command('status');v=met(beats=[i*.5 for i in range(20000)],bars=2,downbeats=[0,19999],ok=False);assert v['graphGeneration']==before['graphGeneration']
  met(beats=[i*.5 for i in range(20000)],bars=0);v=command('rate 1.2 -2');assert v['metronomeBeats']==20000 and v['cueEventCount']>0
  command('loop 1 3');v=command('output default');assert not v['playing'] and v['looping'] and v['metronomeBeats']==20000 and v['cueEventCount']>0
  command('park');command('met-preview 0',False);command('met-begin 0 0 .7 1 4 0 0 0',False);v=command('unpark');assert not v['playing'] and v['cueEventCount']>0
  met(click=False,bars=0);command('met-preview 0');eventually(lambda s:s['previewClicksCompleted']>0)
  child.stdin.write('quit\n');child.stdin.flush();assert child.wait(timeout=10)==0
  (out/'receipts.json').write_text(json.dumps(receipts,indent=2));(out/'result.json').write_text(json.dumps({'helperSha256':hashlib.sha256(helper.read_bytes()).hexdigest(),'hardwareMuted':a.hardware,'cueTransactions':True,'preview':True,'countIn':True,'variableMeter':True,'gridless':True,'liveSwap':True,'largeGrid':True,'routeAndPark':True,'flatSameSongHandoff':True,'audibleQualityQualified':False},indent=2))
 finally:
  (out/'receipts.json').write_text(json.dumps(receipts,indent=2))
  if child.poll() is None:child.kill();child.wait(timeout=5)
  selector.close();child.stdin.close();child.stdout.close()
print('PASS: native metronome transaction, preview, live swap, count-in, variable meter, gridless count-in, large grid and route/park preservation')
