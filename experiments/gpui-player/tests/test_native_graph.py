"""Saved graph topology on real DSP with a fake output device only; no Node."""
import argparse, copy, hashlib, json, os, queue, struct, subprocess, tempfile, threading, time, wave
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('helper',type=Path);p.add_argument('out',type=Path);a=p.parse_args();helper=a.helper.resolve();out=a.out.resolve();out.mkdir(parents=True,exist_ok=True)
graph=json.loads((Path(__file__).resolve().parents[3]/'tests/shared/native-playback-graph.json').read_text());receipts=[];measurements={}
def wire(g):
 h=lambda s:s.encode().hex();rows=[f"SingZGraph1 {len(g['nodes'])} {len(g['connections'])}"]
 for n in g['nodes']:
  i,o=n['ports']['inputs'],n['ports']['outputs'];b=n.get('binding');params=n['parameters']
  rows.append(f"node {n['id']} {n['type']} {n['typeVersion']} {h(n['execution'])} {int(n['unavailable']=='silence')} {len(i)} {len(o)} {len(params)} {int(b is not None)}")
  rows.extend(f"port {h(port['id'])} {port['channels']}" for port in i+o)
  rows.extend(f"param {h(key)} {value}" for key,value in params.items())
  if b:rows.append(f"binding {h(b['kind'])} {h(b['laneId']) if 'laneId' in b else '-'}")
 for edge in g['connections']:rows.append(f"edge {edge['from']['node']} {h(edge['from']['port'])} {edge['to']['node']} {h(edge['to']['port'])}")
 return '\n'.join(rows+['end',''])
class Session:
 def __init__(self,manifest,audio):
  env={k:v for k,v in os.environ.items() if k!='SINGZ_MUTE'}
  self.child=subprocess.Popen([str(helper),'--test-fake-host','--graph-manifest',str(manifest),'vocals',str(audio)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env);self.lines=queue.Queue()
  def reader():
   for line in self.child.stdout:self.lines.put(line)
   self.lines.put(None)
  threading.Thread(target=reader,daemon=True).start()
 def read(self,ok=True):
  line=self.lines.get(timeout=20);assert line,('helper exited',self.child.poll())
  value=json.loads(line);receipts.append(value);assert value['ok']==ok,value;return value
 def command(self,text,ok=True):
  self.child.stdin.write(text+'\n');self.child.stdin.flush();return self.read(ok)
 def close(self):
  if self.child.poll() is None:self.child.stdin.close()
  try:self.child.wait(timeout=8)
  except subprocess.TimeoutExpired:self.child.kill();self.child.wait();raise
  assert self.child.returncode==0,self.child.stderr.read()
with tempfile.TemporaryDirectory(prefix='singz-native-graph-') as tmp:
 root=Path(tmp);audio=root/'voice.wav'
 with wave.open(str(audio),'wb') as w:w.setparams((1,2,48000,0,'NONE','not compressed'));w.writeframes(struct.pack('<h',13107)*48000*20)
 for gain in (1,.5):
  candidate=copy.deepcopy(graph);next(n for n in candidate['nodes'] if n['id']=='6')['parameters']['gain']=gain
  manifest=root/f'graph-{gain}';manifest.write_text(wire(candidate));session=Session(manifest,audio)
  try:
   ready=session.read();assert ready['explicitGraph'] and ready['graphNodeCount']==14 and ready['graphConnectionCount']==13,ready
   session.command('play');deadline=time.monotonic()+6
   while True:
    value=session.command('status')
    if value['position']>.3 and value['outputPeak']>.1:break
    assert time.monotonic()<deadline,value;time.sleep(.04)
   measurements[str(gain)]=value['outputPeak'];assert abs(value['outputPeak']-.4*gain)<.025,value
   generation=value['graphGeneration'];session.command('rate 1.25 2');deadline=time.monotonic()+6
   while True:
    value=session.command('status')
    if value['graphGeneration']>generation and value['playing'] and value['position']>.6:break
    assert time.monotonic()<deadline,value;time.sleep(.04)
   assert value['explicitGraph'] and value['graphNodeCount']==14,value
   session.command('loop 1 3');session.command('seek 1.5');session.command('unloop')
   parked=session.command('park');assert parked['physicalOutputReleased'] and parked['explicitGraph'],parked
   restored=session.command('unpark');assert not restored['parked'] and restored['explicitGraph'],restored
   session.command('play');session.command('pause')
  finally:session.close()
 assert abs(measurements['0.5']/measurements['1']-.5)<.04,measurements
 # Malformed and over-limit bridge input must be refused before a default graph
 # can become playable, including a fully valid wire shape with invalid topology.
 good=wire(graph)
 invalid=[good.replace('SingZGraph1 14 13','SingZGraph1 129 13'),good.replace('port 6f7574 1','port 6f7574 65',1),good.replace('param 6761696e 0.5','param 6761696e nan'),good.replace('end\n',''),good+'garbage\n',good.replace('binding 70726f6a6563742d6c616e65 766f63616c73','binding 70726f6a6563742d6c616e65 6d697373696e67',1)]
 for i,text in enumerate(invalid):
  assert text!=good,i
  manifest=root/f'bad-{i}';manifest.write_text(text);session=Session(manifest,audio)
  try:
   refused=session.read(False);assert refused['error'],refused
   session.child.wait(timeout=8);assert session.child.returncode!=0
  finally:
   if session.child.poll() is None:session.child.kill();session.child.wait()
(out/'result.json').write_text(json.dumps({'passed':True,'helperSha256':hashlib.sha256(helper.read_bytes()).hexdigest(),'fakeHostOnly':True,'measurements':measurements,'malformedAndSemanticRefusals':len(invalid),'receipts':receipts},indent=2))
