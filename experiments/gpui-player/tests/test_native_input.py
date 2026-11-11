"""Real native CREPE/stop protocol; optional passive-authorized hardware capture.
No output stream is opened. Samples remain native; only scalar telemetry is read.
Run: python3 test_native_input.py /path/to/singz-gpui-input /tmp/evidence [--hardware]
"""
import json, math, os, selectors, struct, subprocess, sys, tempfile, time, wave
from pathlib import Path
exe=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
model=exe.parent/'pitch/crepe-tiny.bin'
def check(args,hardware):
    child=subprocess.Popen([str(exe),'--model',str(model),*args],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env={**os.environ,'SINGZ_MUTE':'1'})
    selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ)
    def read():
        assert selector.select(10),'Native capture reply timed out'
        value=json.loads(child.stdout.readline());assert value['protocol']==1 and value['ok'],value
        assert not value['monitoring'],'Capture unexpectedly opened monitoring'
        return value
    def command(text):
        child.stdin.write(text+'\n');child.stdin.flush();return read()
    try:
        first=read();assert first['active'];frames=[];begin=time.monotonic()
        while time.monotonic()-begin<2:
            time.sleep(.05);frames.append(command('status'))
        last=frames[-1];assert last['sequence']>10 and last['overruns']==0,last
        assert all(f['active'] for f in frames)
        if not hardware:
            assert abs(last['frequency']-220)<5 and last['clarity']>.5 and last['rms']>.1,last
            assert last['fixture'] and last['detector']=='crepe-tiny'
            assert 0<last['frameAgeMs']<500,last
        stopped=command('stop');assert not stopped['active'];assert child.wait(timeout=5)==0
        cpu=(last['cpuSeconds']-first['cpuSeconds'])/(time.monotonic()-begin)*100
        return {'hardware':hardware,'deviceUid':first['deviceUid'],'frames':last['sequence'],'overruns':last['overruns'],'frequencyHz':last['frequency'],'nativeProcessCpuOneCorePercent':cpu,'lastInferenceMs':last['inferenceMs'],'stoppedAndExited':True}
    finally:
        selector.close()
        if child.poll() is None:child.kill();child.wait(timeout=5)
        child.stdin.close();child.stdout.close()
with tempfile.TemporaryDirectory(prefix='singz-input-protocol-') as folder:
    fixture=Path(folder)/'tone.wav'
    with wave.open(str(fixture),'wb') as f:
        f.setparams((1,2,16000,0,'NONE','not compressed'));f.writeframes(b''.join(struct.pack('<h',int(8000*math.sin(i*math.tau*220/16000))) for i in range(16000)))
    result={'nativePcmFixture':check(['--test-input',str(fixture)],False),'hardware':{'qualified':False}}
    if '--hardware' in sys.argv[3:]:
        permission=json.loads(subprocess.check_output([str(exe),'--permission'],text=True,timeout=30));result['permission']=permission
        if permission['permission']=='granted' and permission['supported']:
            # Permission was confirmed without requesting a prompt. No audio is saved.
            result['hardware']=check(['--device','','--channel','0'],True)
            result['hardware']['qualified']=True
        else:result['hardware']['reason']='No existing microphone authorization; no prompt was requested'
    (out/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
