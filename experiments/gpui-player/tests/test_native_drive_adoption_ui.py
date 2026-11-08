"""Gated real HTTP adoption, native catalog/playback/Save and offline restart.

All input and captures stay inside hidden, muted GPUI windows. No Node, browser,
real credentials, user library, global pointer or foreground activation.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import wave

parser=argparse.ArgumentParser()
parser.add_argument('app',type=Path);parser.add_argument('out',type=Path)
args=parser.parse_args();app=args.app.resolve();out=args.out.resolve();out.mkdir(parents=True,exist_ok=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
md5=lambda b:hashlib.md5(b).hexdigest()
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
fixture=module('drive_fixture',Path(__file__).with_name('drive_fixture.py'))
perf=module('drive_adoption_perf',Path(__file__).with_name('interface-perf.py'))
def foreground():
 return subprocess.run(['/usr/bin/lsappinfo','front'],capture_output=True,text=True,timeout=2).stdout.strip() if platform.system()=='Darwin' else None
class LocalCallback(urllib.request.HTTPRedirectHandler):
 def __init__(self,callback):super().__init__();self.callback=callback
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  u=urllib.parse.urlsplit(newurl);assert u.scheme=='http' and u.hostname=='127.0.0.1' and u.port==self.callback.port and u.path==self.callback.path=='/oauth2/callback' and not u.username and not u.password and not u.fragment
  return super().redirect_request(req,fp,code,msg,headers,newurl)
def authorize(server,path):
 url=json.loads(path.read_text())['url'];u=urllib.parse.urlsplit(url);base=urllib.parse.urlsplit(server.base)
 assert (u.scheme,u.hostname,u.port,u.path)==('http','127.0.0.1',base.port,'/o/oauth2/v2/auth')
 q=urllib.parse.parse_qs(u.query);assert q['client_id']==['fixture-client'] and q['code_challenge_method']==['S256']
 callback=urllib.parse.urlsplit(q['redirect_uri'][0]);assert callback.scheme=='http' and callback.hostname=='127.0.0.1' and callback.path=='/oauth2/callback'
 with urllib.request.build_opener(LocalCallback(callback)).open(url,timeout=8) as response:assert response.status==200

def launch(env,folder,server,target,expected,offline=False):
 folder.mkdir(parents=True,exist_ok=True);(folder/'acks').mkdir(exist_ok=True)
 before=foreground();started=time.monotonic();samples=[];errors=[];previous=None;handled=set();authorized=False;next_sample=0
 with (folder/'adoption.log').open('w') as log:
  child=subprocess.Popen([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT)
  try:
   while child.poll() is None:
    assert time.monotonic()-started<120,'Adoption UI timeout'
    authorization=folder/'authorization-url-0.json'
    if authorization.exists() and not authorized:
     assert not offline;authorize(server,authorization);authorized=True
    for path in (folder/'requests').glob('*.json'):
     if path.name in handled:continue
     op=json.loads(path.read_text())['operation'];state=server.state.snapshot()
     if op in ('first-held','second-held'):
      name='download-first' if op=='first-held' else 'download-second';count=65536 if op=='first-held' else 262144
      assert state['gates'][name]['waiting']==1,state['gates'];assert not target.exists()
      assert any(r.get('streamedBytes')==count and r['status'] is None for r in state['requests'])
      (folder/(path.stem+'-server.json')).write_text(json.dumps(state,indent=2))
     elif op=='cancelled-proof':
      if state['gates']['download-first']['waiting'] or not any(r.get('cancelled') for r in state['requests'] if r['path'].endswith('/phone-song')):continue
      assert not target.exists()
      stages=list(target.parent.glob('.singz-adopting-*'));assert len(stages)==1
      cached=stages[0]/'project.json.part';assert cached.is_file()
      assert not list(stages[0].rglob('payload.part')),'Cancelled partial payload survived'
      (folder/'cancelled-staging-proof.json').write_text(json.dumps({'metadataSha256':sha(cached),'metadataBytes':cached.stat().st_size,'partialPayloads':0,'destinationExists':False},indent=2))
     elif op in ('release-first','release-second'):
      server.state.control({'release':['download-first' if op=='release-first' else 'download-second']})
     elif op in ('adoption-proof','saved-proof'):
      assert target.is_dir()
      for name,data in expected.items():assert (target/name).read_bytes()==data,(op,name)
      assert any(f['id']=='phone-folder' and f['appProperties'].get('singzState')=='adopted' for f in state['files'])
      raw=json.loads((target/'project.json').read_text());assert raw['foreign']=={'keep':'phone'}
      if op=='saved-proof':assert raw['settings']['tracks']['bass']['muted'] is True
      doc_requests=[r for r in state['requests'] if r['path'].endswith('/phone-doc') and r['query'].get('alt')==['media']]
      assert len(doc_requests)==1,'Verified metadata was downloaded again after resume'
      (folder/(op+'-server.json')).write_text(json.dumps(state,indent=2))
     else:raise AssertionError(op)
     (folder/'acks'/path.name).write_text('{"ok":true}');handled.add(path.name)
    now=time.monotonic()
    if now>=next_sample and platform.system()=='Darwin':
     try:
      cpu,memory=perf.process_usage(child.pid)
      if previous:samples.append({'elapsedSeconds':now-started,'cpuPercent':(cpu-previous[0])/((now-previous[1])*1e9)*100,'footprintBytes':memory,'gpuSystem':perf.gpu_usage()})
      previous=(cpu,now)
     except (OSError,subprocess.TimeoutExpired) as error:errors.append(str(error))
     next_sample=now+.5
    time.sleep(.01)
   child.wait(timeout=5)
  finally:
   if child.poll() is None:child.kill();child.wait(timeout=5)
   server.state.control({'release':['download-first','download-second','download','upload','token','list']})
 after=foreground();assert before==after,'Foreground changed'
 (folder/'observer.json').write_text(json.dumps({'foregroundBefore':before,'foregroundAfter':after,'foregroundUnchanged':before==after,'samples':samples,'errors':errors,'scope':'app CPU/footprint only; helper CPU excluded; GPU system-wide','liveFps':'unmeasured'},indent=2))
 assert child.returncode==0 and (folder/'result.json').exists(),(folder/'adoption.log').read_text()
 result=json.loads((folder/'result.json').read_text());assert result['offline']==offline and result['nativePlayback'] and result['nativeMix'] and result['actualCatalogCard']
 for path in folder.glob('*.json'):
  if path.stem.endswith(('-1280','-1060')):
   state=json.loads(path.read_text());width=int(path.stem.rsplit('-',1)[1]);height=800 if width==1280 else 640
   assert state['viewport']==[width,height] and state['hidden'] and state['scale']==2
   from PIL import Image
   assert Image.open(path.with_suffix('.png')).size==(width*2,height*2)
 if not offline:assert authorized and result['actualCancelResume'] and handled=={'first-held.json','cancelled-proof.json','resumed-first-held.json','second-held.json','release-first.json','release-second.json','adoption-proof.json','saved-proof.json'}
 return result

with tempfile.TemporaryDirectory(prefix='singz-drive-adoption-ui-') as temporary:
 root=Path(temporary).resolve();library=root/'library';library.mkdir();target=library/'Adopted song fixture';files=root/'seed';files.mkdir()
 def audio(name,frequency):
  p=files/name;p.parent.mkdir(parents=True,exist_ok=True);rate=16000
  one=b''.join(struct.pack('<h',round(1000*math.sin(i*math.tau*frequency/rate))) for i in range(rate))
  with wave.open(str(p),'wb') as w:w.setparams((1,2,rate,0,'NONE','not compressed'));w.writeframes(one*120)
  return p.read_bytes()
 original=audio('original.wav',330);vocals=audio('stems/vocals.wav',220);bass=audio('stems/bass.wav',110)
 lyrics=json.dumps({'source':'edited','credit':'Phone fixture credit','lines':[{'start':i*5,'end':i*5+5,'text':'A song brought home','words':[{'w':word,'s':i*5+j,'e':i*5+j+1} for j,word in enumerate(['A','song','brought','home'])]} for i in range(24)]}).encode()
 stamp=lambda b:{'md5':md5(b),'size':len(b),'mtimeMs':1700000000000}
 document={'version':2,'name':'Adopted song fixture','savedAt':'2026-11-01T00:00:00Z','songFile':'original.wav','songHash':stamp(original),'stemHashes':{'vocals.wav':stamp(vocals),'bass.wav':stamp(bass)},'lyricsHash':stamp(lyrics),'foreign':{'keep':'phone'},'settings':{'tempo':1,'transpose':0,'masterVolume':.61,'loop':False,'tracks':{'vocals':{'volume':.37,'muted':False,'solo':False},'bass':{'volume':.7,'muted':False,'solo':False}},'melody':{'detVersion':4,'hopSec':.01,'f0':' '.join(['2400']*12000)},'beat':{'beats':[i*.5 for i in range(240)],'bpm':120,'beatsPerBar':4,'downbeat':0,'source':'auto','detVersion':23},'metronome':{'click':False,'countInBars':0,'volume':.3,'accent':True,'grid':False}}}
 expected={'original.wav':original,'stems/vocals.wav':vocals,'stems/bass.wav':bass,'lyrics.json':lyrics}
 server=fixture.Server();thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 def file(file_id,name,parent,data,mime='application/octet-stream'):
  return {'id':file_id,'name':name,'parents':[parent],'mimeType':mime,'contentBase64':base64.b64encode(data).decode()}
 seed=[{'id':'drive-root','name':'SingZ','parents':['root'],'mimeType':fixture.FOLDER},{'id':'phone-folder','name':target.name,'parents':['drive-root'],'mimeType':fixture.FOLDER,'appProperties':{'singzState':'published','singzPublish':'native-adoption-fixture'}},{'id':'phone-stems','name':'stems','parents':['phone-folder'],'mimeType':fixture.FOLDER},file('phone-doc','project.json','phone-folder',json.dumps(document).encode(),'application/json'),file('phone-song','original.wav','phone-folder',original,'audio/wav'),file('phone-lyrics','lyrics.json','phone-folder',lyrics,'application/json'),file('phone-vocals','vocals.wav','phone-stems',vocals,'audio/wav'),file('phone-bass','bass.wav','phone-stems',bass,'audio/wav')]
 server.state.control({'files':seed,'gates':{'download-first':True,'download-second':True},'chunkGates':[{'fileId':'phone-song','gate':'download-first','afterBytes':65536},{'fileId':'phone-song','gate':'download-second','afterBytes':262144}]})
 env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ('SINGZ_NO_SYNC','SINGZ_GDRIVE_CONFIG','SINGZ_PACK_DIR','SINGZ_MODELS_DIR','SINGZ_DEMUCS')}
 env.update(SINGZ_LANG='en',SINGZ_MUTE='1',SINGZ_NO_SYSTEM_ENGINES='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_TEST_NO_CAPTURE='1',SINGZ_GPUI_CONFIG_DIR=str(root/'prefs'),SINGZ_GPUI_PROJECTS_ROOT=str(library),SINGZ_GPUI_TEST_PROJECT=str(target),SINGZ_PACK_DIR=str(root/'missing-pack'),SINGZ_MODELS_DIR=str(root/'missing-models'),SINGZ_GDRIVE_CONFIG=json.dumps({'clientId':'fixture-client','clientSecret':'fixture-secret','authBase':server.base,'apiBase':server.base,'uploadBase':server.base}))
 try:
  online=launch({**env,'SINGZ_GPUI_DRIVE_TEST':str(out/'online'),'SINGZ_GPUI_DRIVE_STAGE':'adoption'},out/'online',server,target,expected)
  initial_requests=len(server.state.snapshot()['requests']);server.stop();thread.join(timeout=5);server.server_close()
  offline=launch({**env,'SINGZ_GPUI_DRIVE_TEST':str(out/'offline'),'SINGZ_GPUI_DRIVE_STAGE':'adoption-offline'},out/'offline',server,target,expected,offline=True)
  assert len(server.state.snapshot()['requests'])==initial_requests,'Offline launch reached the stopped server'
  shutil.copytree(library,out/'library',dirs_exist_ok=True)
  (out/'fixture.json').write_text(json.dumps({'appSha256':sha(app),'helperSha256':sha(app.with_name('singz-gpui-audio.exe' if os.name=='nt' else 'singz-gpui-audio')),'fixtureServerSha256':sha(Path(__file__).with_name('drive_fixture.py')),'sourceSha256':hashlib.sha256(original).hexdigest(),'expected':{name:hashlib.sha256(data).hexdigest() for name,data in expected.items()},'document':document,'noNode':True,'hidden':True,'muted':True,'liveFps':'unmeasured','productionParity':'unqualified candidate','offlineServerStopped':True},indent=2))
  (out/'result.json').write_text(json.dumps({'online':online,'offline':offline,'captures':len(list(out.rglob('*.png')))},indent=2))
 finally:
  server.stop();thread.join(timeout=5);server.server_close()
print('PASS: gated streaming adoption, catalog open, native playback/mix/lyrics/Save and offline restart')
