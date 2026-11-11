"""Hidden native inline title editing and saved-directory rename, without Node."""
import argparse, hashlib, json, math, os, shutil, struct, tempfile, wave, threading
import contextlib, http.server
from pathlib import Path
import test_native_training_keyboard as shared
p=argparse.ArgumentParser();p.add_argument('app',type=Path);p.add_argument('out',type=Path);args=p.parse_args();app=args.app.resolve();out=args.out.resolve();out.mkdir(parents=True,exist_ok=True);(out/'result.json').unlink(missing_ok=True)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
@contextlib.contextmanager
def lyrics_miss_server():
 class Handler(http.server.BaseHTTPRequestHandler):
  def do_GET(self):
   search=self.path.startswith('/api/search');body=b'[]' if search else b'{"message":"fixture miss"}'
   self.send_response(200 if search else 404);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
  def log_message(self,*_):pass
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
 try:yield f'http://127.0.0.1:{server.server_port}/api'
 finally:server.shutdown();server.server_close();worker.join(timeout=3)
with tempfile.TemporaryDirectory(prefix='singz-native-title-') as temp, lyrics_miss_server() as lyrics_url:
 root=Path(temp).resolve();project=root/'external/Original';project.mkdir(parents=True);(root/'external/Occupied').mkdir();source=root/'source.wav'
 with wave.open(str(source),'wb') as audio:
  audio.setparams((2,2,44100,0,'NONE','not compressed'));audio.writeframes(b''.join(struct.pack('<hh',int(6000*math.sin(i*math.tau*220/44100)),int(6000*math.sin(i*math.tau*330/44100))) for i in range(44100*3)))
 shutil.copyfile(source,project/'song.wav');original=sha(source)
 (project/'project.json').write_text(json.dumps({'version':2,'name':'Original','songFile':'song.wav','settings':{},'foreign':{'keep':True}}));(project/'notes.txt').write_text('keep notes')
 for name in ['cache','tmp']:(root/name).mkdir()
 catalog=root/'catalog.json';catalog.write_text(json.dumps({'flavor':'linux','entries':[]}))
 env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_')}
 env.update(SINGZ_MUTE='1',SINGZ_NO_SYNC='1',SINGZ_NO_SYSTEM_ENGINES='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(root/'prefs'),SINGZ_GPUI_PROJECTS_ROOT=str(root/'library'),SINGZ_GPUI_TEST_PROJECT=str(project),SINGZ_GPUI_SOURCE_FILE=str(source),SINGZ_GPUI_TITLE_TEST=str(out),SINGZ_PACK_DIR=str(root/'missing-pack'),SINGZ_MODELS_DIR=str(root/'missing-models'),SINGZ_LLAMA_SERVER=str(root/'missing-llama'),SINGZ_CRISPASR=str(root/'missing-crispasr'),SINGZ_GPUI_MODEL_FIXTURE=str(catalog),SINGZ_GPUI_LRCLIB_URL=lyrics_url,TMPDIR=str(root/'tmp'),XDG_CACHE_HOME=str(root/'cache'),HF_HOME=str(root/'cache/huggingface'),TORCH_HOME=str(root/'cache/torch'),PYTHONDONTWRITEBYTECODE='1')
 try:observation=shared.run_observed(app,out,env,110,expect_input_helper=False)
 finally:
  if (out/'app.log').is_file():shutil.copy2(out/'app.log',out/'title.log')
 resources=[{'elapsedSeconds':row['elapsedSeconds'],'processCpuPercent':row['cpuPercent'],'processFootprintBytes':row['footprintBytes'],'gpuSystem':row['gpuSystem']} for row in observation['samples']]
 elapsed=json.loads((out/'process-exit.json').read_text())['wallSeconds']
 (out/'performance.json').write_text(json.dumps({'scope':observation['scope'],'wallSeconds':elapsed,'samples':resources,'liveFps':{'available':False,'reason':'hidden window cadence unmeasured; static captures do not prove smoothness'}},indent=2))
 assert (out/'result.json').is_file(),(out/'title.log').read_text()
 result=json.loads((out/'result.json').read_text());assert all(result[k] for k in ['keyboardPencilOpen','escape','blank','enter','blur','collisionRefused','externalEditRefused','mixAndPausedPositionRetained','playingRetained','libraryRouteAndSearchFocusRetained','hidden','muted'])
 saved=Path(result['savedFolderRename']);imported=Path(result['unsavedSavedProject']);assert saved.parent.samefile(project.parent) and saved.name=='Playing rename' and not project.exists()
 raw=json.loads((saved/'project.json').read_text());assert raw['name']=='Playing rename' and raw['foreign']=={'keep':True} and raw['externalChange']=='keep'
 assert sha(saved/'song.wav')==original and (saved/'notes.txt').read_text()=='keep notes';assert list((root/'external/Occupied').iterdir())==[];assert not (root/'external/Refused stale rename').exists()
 assert imported.parent.samefile(root/'library') and imported.name=='Unsaved named source' and json.loads((imported/'project.json').read_text())['name']==imported.name;assert sha(source)==original
 shutil.copytree(saved,out/'renamed-project',dirs_exist_ok=True);shutil.copytree(imported,out/'imported-project',dirs_exist_ok=True)
 (out/'fixture.json').write_text(json.dumps({'appSha256':sha(app),'helperSha256':sha(app.with_name('singz-gpui-audio.exe' if os.name=='nt' else 'singz-gpui-audio')),'sourceSha256':original,'noNode':True,'hidden':True,'muted':True,'initialProject':{'name':'Original','duration':3,'format':'PCM16 stereo 44100'},'states':['editing','escape','blank','enter','collision','playing rename','external conflict','loose-source blur','explicit Save'],'newVisualReferences':'absent; candidate captures only'},indent=2))
print('PASS: inline title keyboard/blur, exclusive saved rename, conflict guards, mix/position/play restoration, unsaved title and explicit Save')
