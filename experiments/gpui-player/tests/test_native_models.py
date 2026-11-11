"""Real native model transport/install through hidden GPUI. No Node, real models or inference.
The simulated Windows catalog tests Windows wizard options on the host, not Windows qualification.
"""
import errno, hashlib, http.server, importlib.util, io, json, math, os, signal, subprocess, sys, tarfile, tempfile, threading, time
from pathlib import Path
app=Path(sys.argv[1]).resolve(strict=True);out=Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
assert not any(out.iterdir()),'Model UI tests require a fresh OUT; old captures/results cannot qualify'
assert all(arg=='--keyboard' for arg in sys.argv[3:]),'Only optional --keyboard is supported'
keyboard='--keyboard' in sys.argv[3:]
sys.dont_write_bytecode=True
def sibling(name,filename):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
processes=sibling('models_processes','test_native_lyrics_live.py')
foreground=sibling('models_foreground','test_native_lyrics_real.py').foreground
perf=sibling('models_resources','interface-perf.py')
app_sha=hashlib.sha256(app.read_bytes()).hexdigest()

def run_observed(directory,env,timeout):
    """Bounded real app/process observation; no live display-FPS claim."""
    before=foreground();fronts=[];owners={};samples=[];errors=[];rejected=[];terminal_discards=[]
    started=time.monotonic();previous=None;next_usage=started
    with (directory/'models.log').open('w') as log:
        child=subprocess.Popen([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            while child.poll() is None:
                assert time.monotonic()-started<timeout,'Models UI deadline exceeded'
                table=processes.process_table();active={child.pid}|{row['pid'] for row in owners.values() if processes.same_process(row,table.get(row['pid']))}
                changed=True
                while changed:
                    changed=False
                    for row in table.values():
                        if row['pid'] in active or row['parent'] in active:
                            owners[(row['pid'],row['start'],row['command'])]=row
                            if row['pid'] not in active:active.add(row['pid']);changed=True
                fronts.append(foreground())
                def confirmed_terminal():
                    if child.poll() is not None:return True
                    try:child.wait(timeout=.1)
                    except subprocess.TimeoutExpired:return False
                    return True
                if time.monotonic()>=next_usage:
                    next_usage=time.monotonic()+.5
                    raw={'pid':child.pid,'previousCpuNanoseconds':previous[0] if previous else None,'previousSampleMonotonic':previous[1] if previous else None}
                    try:
                        cpu,footprint=perf.process_usage(child.pid);now=time.monotonic()
                        raw.update(cpuNanoseconds=cpu,footprintBytes=footprint,sampleMonotonic=now,elapsedSeconds=now-started)
                        percent=(cpu-previous[0])/((now-previous[1])*1e9)*100 if previous is not None else None
                        raw['appCpuPercent']=percent
                        valid=math.isfinite(cpu) and cpu>=0 and footprint>0 and (percent is None or math.isfinite(percent) and percent>=0)
                        if not valid:
                            record={'reason':'Invalid CPU counter, CPU delta or physical footprint','rawReadback':raw,'processConfirmedTerminal':confirmed_terminal()}
                            rejected.append(record)
                            if record['processConfirmedTerminal']:terminal_discards.append(record)
                            else:errors.append(record)
                            previous=None
                        else:
                            if percent is not None:
                                samples.append({'elapsedSeconds':now-started,'appCpuPercent':percent,'appFootprintBytes':footprint,'gpuSystem':perf.gpu_usage()})
                            previous=(cpu,now)
                    except (OSError,RuntimeError) as error:
                        gone=isinstance(error,OSError) and error.errno in (errno.ESRCH,errno.ENOENT)
                        terminal=confirmed_terminal() if gone else False
                        record={'reason':str(error),'exceptionType':type(error).__name__,'errno':getattr(error,'errno',None),'rawReadback':raw,'processConfirmedTerminal':terminal}
                        rejected.append(record)
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
            deadline=time.monotonic()+8
            while True:
                table=processes.process_table();remaining=[row for row in owners.values() if processes.same_process(row,table.get(row['pid']))]
                if not remaining or time.monotonic()>=deadline:break
                time.sleep(.2)
            survivors=list(remaining)
            for sig,delay in ((signal.SIGTERM,1),(signal.SIGKILL,0)):
                for row in remaining:
                    if row['pid']!=child.pid:
                        try:os.kill(row['pid'],sig)
                        except ProcessLookupError:pass
                if delay and remaining:time.sleep(delay)
                table=processes.process_table();remaining=[row for row in remaining if processes.same_process(row,table.get(row['pid']))]
            after=foreground();observations=[before,*fronts,after]
            available=all(row.get('available') for row in observations)
            stable=available and all(row['identity']==before['identity'] for row in observations)
            (directory/'foreground.json').write_text(json.dumps({'before':before,'after':after,'samples':fronts,'allAvailable':available,'unchanged':stable,'verdict':'stable-observed-foreground' if stable else 'unqualified'},indent=2))
            (directory/'process-exit.json').write_text(json.dumps({'pid':child.pid,'terminal':True,'returncode':child.returncode,'wallSeconds':time.monotonic()-started,'forcedStop':forced,'observed':list(owners.values()),'survivorsBeforeCleanup':survivors,'survivorsAfterCleanup':remaining},indent=2))
            (directory/'interface-metrics.json').write_text(json.dumps({'targetIntervalSeconds':.5,'samples':samples,'errors':errors,'rejectedSamples':rejected,'terminalDiscardCount':len(terminal_discards),'terminalDiscards':terminal_discards,'summary':{
                'appCpuPercent':perf.summarize([row['appCpuPercent'] for row in samples]),'appFootprintBytes':perf.summarize([row['appFootprintBytes'] for row in samples]),
                'systemGpuAvailableSamples':sum(row['gpuSystem'].get('available') is True for row in samples),'systemGpuUnavailableReasons':sorted({row['gpuSystem'].get('reason','unavailable') for row in samples if row['gpuSystem'].get('available') is not True}),'gpuScope':'System-wide IOAccelerator counters, including other processes','cpuScope':'App process only; 100 percent is one CPU core','helperCpuIncluded':False,
                'liveFps':'unmeasured: hidden window','performanceVerdict':'Resource observations only; no live display cadence qualification'}},indent=2))
    assert child.returncode==0 and not forced,(directory/'models.log').read_text()
    assert owners and not survivors and not remaining,'Observed native-process natural retirement failed'
    assert stable,'Foreground observation unavailable or changed during hidden Models test'
    assert samples and not errors,'App CPU/GPU resource observation failed'
    return {'wallSeconds':time.monotonic()-started,'foregroundStable':stable,'observedProcesses':len(owners),'resourceSamples':len(samples)}

with tempfile.TemporaryDirectory(prefix='singz-models-') as folder:
    root=Path(folder).resolve();prefs=root/'prefs';(prefs/'models').mkdir(parents=True)
    for name in ('library','tmp','cache'):(root/name).mkdir()
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
                    if i==0 and self.path=='/pack' and mode=='hold':
                        # Keep the real curl worker in flight across screenshot
                        # readback. Only the post-Skip assertion releases it.
                        deadline=time.monotonic()+30
                        while control.read_text()=='hold':
                            if time.monotonic()>=deadline:
                                self.close_connection=True;return
                            time.sleep(.05)
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
    env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_')}
    env.update(SINGZ_MUTE='1',SINGZ_NO_SYNC='1',SINGZ_NO_SYSTEM_ENGINES='1',SINGZ_GPUI_TEST_NO_CAPTURE='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(prefs),SINGZ_GPUI_PROJECTS_ROOT=str(root/'library'),SINGZ_GPUI_MODEL_FIXTURE=str(catalog),SINGZ_GPUI_MODEL_CONTROL=str(control),SINGZ_GPUI_MODELS_TEST=str(out),SINGZ_MODELS_DIR=str(prefs/'models'),SINGZ_PACK_DIR=str(prefs/'gpu-splitter'),SINGZ_LLAMA_SERVER=str(root/'missing-llama'),SINGZ_CRISPASR=str(root/'missing-crispasr'),XDG_CACHE_HOME=str(root/'cache'),HF_HOME=str(root/'cache/huggingface'),TORCH_HOME=str(root/'cache/torch'),TMPDIR=str(root/'tmp'),PYTHONDONTWRITEBYTECODE='1')
    if keyboard:env['SINGZ_GPUI_MODELS_KEYBOARD_TEST']='1'
    try:
        initial_observation=run_observed(out,env,300 if keyboard else 110)
        result=json.loads((out/'result.json').read_text());assert all(result.values()),result
        if keyboard:
            receipt=json.loads((out/'keyboard-result.json').read_text())
            for flag in ('tabAndShiftTab','enterAndSpace','realGetAndReinstall','explicitRetry','busyFocusRecovery','focusedAutoscroll','persistentEscape','manualCloseCancels','automaticSkipContinues','modeControls','syntheticWindowsCatalogOnly','fixtureOnlyMissingPackPreparation'):
                assert receipt.get(flag) is True,flag
            assert receipt['sizes']==[[1280,800],[1060,640]] and receipt['hardwareInference'] is False
            steps=json.loads((out/'keyboard-steps.json').read_text())
            assert steps and all(row['hidden'] is True and row['active'] is False for row in steps)
            from PIL import Image
            for width,height in ((1280,800),(1060,640)):
                rows=[row for row in steps if row['viewport']==[width,height]]
                for stage in ('Tab-ShiftTab-persistent-Escape','automatic-Skip-worker-completed'):
                    assert any(row['step']==stage for row in rows),f'Missing {stage} at {width}'
                for phase,control_id in (('error','model-retry'),('skip','model-close')):
                    name=f'keyboard-{phase}-{width}'
                    path=out/f'{name}.png';state=json.loads((out/f'{name}.state.json').read_text())
                    assert state['viewport']==[width,height] and state['hidden'] is True and state['active'] is False
                    assert state['keyboard']['focusInside'] is True and state['keyboard']['focusedControl']==control_id
                    scale=state['scale'];assert isinstance(scale,(int,float)) and math.isfinite(scale) and scale>0
                    with Image.open(path) as pixels:
                        assert pixels.size==(round(width*scale),round(height*scale)) and list(pixels.size)==state['raster']
        pack=json.loads((prefs/'gpu-splitter/python/pack.json').read_text());assert pack['formatVersion']==10
        for name in ['one','two','three']:assert (prefs/f'models/{name}.gguf').read_bytes().startswith(b'GGUF')
        # First successful Qwen download fetched only the missing two parts.
        qwen=[r for r in requests if r['path'] in ['/one','/two','/three']]
        assert [r['path'] for r in qwen[:2]]==['/two','/three'],qwen
        assert (prefs/'trtrtx-disabled.json').is_file() and (prefs/'dml-disabled.json').is_file()
        leftovers=[str(p.relative_to(prefs)) for p in prefs.rglob('*') if p.name.endswith(('.incoming','.previous','.transaction.json','.tar.gz','.tmp'))]
        assert not leftovers,leftovers
        request_count=len(requests);restart=out/'restart';restart.mkdir(exist_ok=True)
        env.pop('SINGZ_GPUI_MODELS_KEYBOARD_TEST',None)
        env.update(SINGZ_GPUI_MODELS_RESTART='1',SINGZ_GPUI_MODELS_TEST=str(restart))
        restart_observation=run_observed(restart,env,30)
        assert all(json.loads((restart/'result.json').read_text()).values())
        assert len(requests)==request_count,'Restart unexpectedly downloaded installed models'
        assert hashlib.sha256(app.read_bytes()).hexdigest()==app_sha,'Application changed during qualification'
        (out/'fixture.json').write_text(json.dumps({'appSha256':app_sha,'catalog':fixture,'requests':requests,'isolated':True,'realCurlTar':True,'inferenceTested':False,'keyboard':keyboard,'initialObservation':initial_observation,'restartObservation':restart_observation,'liveFps':'unmeasured','platform':'host with simulated Windows catalog','shutdownCleanup':True},indent=2))
    finally:server.shutdown();server.server_close()
print('PASS: native model wizard, curl/tar install, cancellation, Skip, invalid pack preservation, multipart truncation rollback, retry, CPU mode and shutdown cleanup; keyboard='+str(keyboard))
