"""Hidden real device Settings, persisted restart, and unavailable-route repair.
Requires the native helper and a --features ui-tests application build. Never alters
OS defaults. Every active output is forced muted. Fixtures/preferences are isolated.
Run: python3 test_native_settings.py /path/to/singz-gpui-player /tmp/evidence
"""
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import wave
app=Path(sys.argv[1]).resolve()
out=Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
if '--preferences-only' in sys.argv[3:]:
    with tempfile.TemporaryDirectory(prefix='singz-settings-preferences-') as folder:
        import importlib.util
        import errno
        import signal
        import time
        sys.dont_write_bytecode=True
        def sibling(name,filename):
            spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename))
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
        processes=sibling('settings_processes','test_native_lyrics_live.py')
        foreground=sibling('settings_foreground','test_native_lyrics_real.py').foreground
        perf=sibling('settings_metrics','interface-perf.py')
        root=Path(folder)
        for name in ('preferences','library','tmp','cache'): (root/name).mkdir()
        helper=os.environ.get('SINGZ_GPUI_AUDIO_HELPER',str(app.with_name('singz-gpui-audio')))
        env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_')}
        env.update(SINGZ_MUTE='1',SINGZ_NO_SYNC='1',SINGZ_NO_SYSTEM_ENGINES='1',SINGZ_GPUI_TEST_NO_CAPTURE='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(root/'preferences'),SINGZ_GPUI_PROJECTS_ROOT=str(root/'library'),SINGZ_GPUI_AUDIO_HELPER=helper,SINGZ_MODELS_DIR=str(root/'missing-models'),SINGZ_PACK_DIR=str(root/'missing-pack'),SINGZ_LLAMA_SERVER=str(root/'missing-llama'),SINGZ_CRISPASR=str(root/'missing-crispasr'),SINGZ_GPUI_AUDIO_SETTINGS=str(out),SINGZ_GPUI_SETTINGS_PREFS_TEST='1',XDG_CACHE_HOME=str(root/'cache'),HF_HOME=str(root/'cache/huggingface'),TORCH_HOME=str(root/'cache/torch'),TMPDIR=str(root/'tmp'),PYTHONDONTWRITEBYTECODE='1')
        before=foreground();fronts=[];owners={};samples=[];errors=[];rejected=[];terminal_discards=[];started=time.monotonic();previous=None
        with (out/'preferences.log').open('w') as log:
            child=subprocess.Popen([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            try:
                while child.poll() is None:
                    assert time.monotonic()-started<90,'Preferences UI deadline exceeded'
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
                        # Only missing-process errors may be discarded, and only
                        # after observing actual exit (with at most 100ms settle).
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
                (out/'foreground.json').write_text(json.dumps({'before':before,'after':after,'samples':fronts,'allAvailable':available,'unchanged':stable,'verdict':'stable-observed-foreground' if stable else 'unqualified'},indent=2))
                (out/'process-exit.json').write_text(json.dumps({'pid':child.pid,'returncode':child.returncode,'forcedStop':forced,'observed':list(owners.values()),'survivorsBeforeCleanup':survivors,'survivorsAfterCleanup':remaining},indent=2))
                (out/'interface-metrics.json').write_text(json.dumps({'samples':samples,'errors':errors,'rejectedSamples':rejected,'terminalDiscardCount':len(terminal_discards),'terminalDiscards':terminal_discards,'summary':{'appCpuPercent':perf.summarize([row['appCpuPercent'] for row in samples]),'gpuScope':'System-wide IOAccelerator counters, including other processes','cpuScope':'App process only','liveFps':'unmeasured: hidden window'}},indent=2))
        assert child.returncode==0 and not forced,(out/'preferences.log').read_text()
        assert owners and not survivors and not remaining,'Observed helper retirement failed'
        assert samples and not errors,'App CPU/GPU resource observation failed'
        receipt=json.loads((out/'result.json').read_text())
        assert receipt['duplicateRejectedByPointer'] and receipt['escapeDismissesPopup']
        assert receipt['sameDevicePreservesChannels'] and receipt['changedDeviceResetsChannels']
        assert receipt['persistedReadback'] and receipt['unavailableSavedChannelsRefused']
        assert receipt['preferenceFailureVisibleAndClearable'] and not receipt['hardwareCapture']
        for width in (1280,1060):
            for state in ('device-reset','unavailable-error'):
                capture=out/f'preferences-{state}-{width}'
                assert capture.with_suffix('.png').stat().st_size>0
                metadata=json.loads(capture.with_suffix('.state.json').read_text())
                assert metadata['hidden'] and not metadata['active']
                assert metadata['viewport']==[width,800 if width==1280 else 640]
                if state=='unavailable-error':
                    assert metadata['error'] and all(label=='Saved channel · unavailable' for label in metadata['labels'].values())
        print('PASS: hidden synthetic-inventory Settings controls, duplicate rejection, device reset, persisted preferences and unavailable/error labels at both sizes')
    raise SystemExit(0)
with tempfile.TemporaryDirectory(prefix='singz-native-settings-') as folder:
    root=Path(folder);project=root/'Project';(project/'stems').mkdir(parents=True)
    with wave.open(str(project/'stems/vocals.wav'),'wb') as stream:
        stream.setparams((1,2,48000,0,'NONE','not compressed'))
        stream.writeframes(b''.join(struct.pack('<h',int(7000*math.sin(i*math.tau*220/48000))) for i in range(48000*12)))
    (project/'project.json').write_text(json.dumps({'version':2,'name':'Native Settings fixture','settings':{'melody':{'detVersion':4,'hopSec':.025,'f0':' '.join(['2400']*480)}}}))
    config=root/'preferences'
    def run(name,extra=None):
        env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_')}
        env.update(SINGZ_MUTE='1',SINGZ_GPUI_TEST_NO_CAPTURE='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_GPUI_CONFIG_DIR=str(config),SINGZ_GPUI_TEST_PROJECT=str(project),SINGZ_GPUI_AUDIO_SETTINGS=str(out/name))
        env.update(extra or {})
        with (out/(name+'.log')).open('w') as log:
            result=subprocess.run([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=90)
        assert result.returncode==0,(out/(name+'.log')).read_text()
    run('initial')
    saved=json.loads((config/'audio.json').read_text());assert saved['outputUid']
    run('restart')
    assert json.loads((config/'audio.json').read_text())['outputUid']==saved['outputUid']
    (config/'audio.json').write_text(json.dumps({'outputUid':'missing-saved-output','future':'keep'}))
    run('missing-saved-output',{'SINGZ_GPUI_SETTINGS_MISSING_START':'1'})
    assert json.loads((config/'audio.json').read_text())['future']=='keep'
    (out/'result.json').write_text(json.dumps({'initial':True,'restart':True,'missingSavedOutputRecovery':True,'savedOutputUid':saved['outputUid']},indent=2))
    print('PASS: real native Settings; output persistence across restart; unavailable saved output repair without fallback')
