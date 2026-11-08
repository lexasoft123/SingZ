"""Real native model transport/install through hidden GPUI. No Node, real models or inference.
The simulated Windows catalog tests Windows wizard options on the host, not Windows qualification.
"""
import hashlib, http.server, io, json, os, subprocess, sys, tarfile, tempfile, threading, time
from pathlib import Path
app=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='singz-models-') as folder:
    root=Path(folder);prefs=root/'prefs';(prefs/'models').mkdir(parents=True)
    control=root/'control';control.write_text('good');requests=[]
    def archive(version):
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream,mode='w:gz') as tar:
            for name,data in {'python/python.exe':b'fixture-only-not-executable','python/pack.json':json.dumps({'formatVersion':version}).encode(),'python/models/uvr/UVR_MDXNET_KARA_2.onnx':b'fixture','python/model-cache/models--StemSplitio--htdemucs-6s-onnx/snapshots/test/htdemucs_6s_fp16weights.onnx':b'fixture'}.items():
                info=tarfile.TarInfo(name);info.size=len(data);tar.addfile(info,io.BytesIO(data))
        return stream.getvalue()
    packs={True:archive(10),False:archive(9)}
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            mode=control.read_text();requests.append({'path':self.path,'mode':mode})
            data=packs[mode!='old'] if self.path=='/pack' else (b'GGUF'+(b'NEW' if mode=='truncated' else b'data')*32000)
            self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers()
            try:
                if mode=='truncated' and self.path=='/two':
                    self.wfile.write(data[:100]);self.wfile.flush();self.close_connection=True;return
                # Keep pack in flight long enough to exercise Skip/Close independently of fixture speed.
                delay=.12 if self.path=='/pack' else (.08 if mode=='slow' else 0)
                chunks=20 if self.path=='/pack' else 30
                for i in range(chunks):
                    self.wfile.write(data[len(data)*i//chunks:len(data)*(i+1)//chunks]);self.wfile.flush();time.sleep(delay)
            except (BrokenPipeError,ConnectionResetError):pass
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    base=f'http://127.0.0.1:{server.server_port}'
    def part(file,path,kind):return {'file':file,'url':base+path,'mb':1,'minBytes':4,'kind':kind}
    fixture={'flavor':'windows','entries':[
        {'id':'gpu-splitter','label':'Stem splitter · AI','description':'Splits songs into seven tracks — lead and backing vocals, drums, bass, guitar, piano and the rest — on your GPU when it can (GeForce RTX 30xx or newer; CPU otherwise).','optional':False,'archive':True,'parts':[part('pack.tar.gz','/pack','archive')]},
        {'id':'qwen-asr','label':'Speech model · lyrics','description':'Hears the vocals: transcribes lyrics when none are online, and checks & aligns downloaded lyrics against what is actually sung. Trained on singing, in 30 languages, with its own word aligner.','optional':True,'archive':False,'parts':[part(f'{name}.gguf',f'/{name}','gguf') for name in ['one','two','three']]},
        {'id':'aligner','label':'Precise word aligner','description':'Snaps every lyric word to the exact moment it is sung — the sharpest karaoke timing, in 1,100+ languages. Runs through the stem splitter.','optional':True,'archive':False,'parts':[part('aligner.onnx','/aligner','onnx')]}
    ]}
    catalog=root/'catalog.json';catalog.write_text(json.dumps(fixture));(prefs/'models/one.gguf').write_bytes(b'GGUFcached-first-part')
    env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ['SINGZ_MODELS_DIR','SINGZ_PACK_DIR']}
    env.update(SINGZ_MUTE='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(prefs),SINGZ_GPUI_PROJECTS_ROOT=str(root/'library'),SINGZ_GPUI_MODEL_FIXTURE=str(catalog),SINGZ_GPUI_MODEL_CONTROL=str(control),SINGZ_GPUI_MODELS_TEST=str(out))
    try:
        with (out/'models.log').open('w') as log:r=subprocess.run([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=110)
        assert r.returncode==0,(out/'models.log').read_text()
        result=json.loads((out/'result.json').read_text());assert all(result.values()),result
        pack=json.loads((prefs/'gpu-splitter/python/pack.json').read_text());assert pack['formatVersion']==10
        for name in ['one','two','three']:assert (prefs/f'models/{name}.gguf').read_bytes().startswith(b'GGUF')
        # First successful Qwen download fetched only the missing two parts.
        qwen=[r for r in requests if r['path'] in ['/one','/two','/three']]
        assert [r['path'] for r in qwen[:2]]==['/two','/three'],qwen
        assert (prefs/'trtrtx-disabled.json').is_file() and (prefs/'dml-disabled.json').is_file()
        leftovers=[str(p.relative_to(prefs)) for p in prefs.rglob('*') if p.name.endswith(('.incoming','.previous','.transaction.json','.tar.gz','.tmp'))]
        assert not leftovers,leftovers
        request_count=len(requests);restart=out/'restart';restart.mkdir(exist_ok=True)
        env.update(SINGZ_GPUI_MODELS_RESTART='1',SINGZ_GPUI_MODELS_TEST=str(restart))
        with (restart/'models.log').open('w') as log:
            restored=subprocess.run([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=20)
        assert restored.returncode==0,(restart/'models.log').read_text()
        assert all(json.loads((restart/'result.json').read_text()).values())
        assert len(requests)==request_count,'Restart unexpectedly downloaded installed models'
        (out/'fixture.json').write_text(json.dumps({'appSha256':hashlib.sha256(app.read_bytes()).hexdigest(),'catalog':fixture,'requests':requests,'isolated':True,'realCurlTar':True,'inferenceTested':False,'platform':'host with simulated Windows catalog','shutdownCleanup':True},indent=2))
    finally:server.shutdown();server.server_close()
print('PASS: native model wizard, curl/tar install, cancellation, Skip, invalid pack preservation, multipart truncation rollback, retry, CPU mode and shutdown cleanup')
