"""Hidden real C-major harmonic analysis for current-pitch and harmonic-only projects."""
import argparse,json,math,os,struct,subprocess,sys,tempfile,time,wave
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('app',type=Path);parser.add_argument('out',type=Path);parser.add_argument('--tools-dir',type=Path)
args=parser.parse_args();app=args.app.resolve();out=args.out.resolve();out.mkdir(parents=True,exist_ok=True)
tools=(args.tools_dir or app.parent).resolve();suffix='.exe' if sys.platform=='win32' else ''
def front():
    if sys.platform=='darwin':return subprocess.run(['/usr/bin/lsappinfo','front'],capture_output=True,text=True,timeout=3).stdout.strip()
    return None
with tempfile.TemporaryDirectory(prefix='singz-native-key-') as folder:
    root=Path(folder)
    # Same 12s triad and bass as core_host_tests.cpp's authoritative key fixture.
    sr=44100
    # Generate continuously across all12s, avoiding one-second phase resets.
    def audio(path,tones):
        with wave.open(str(path),'wb') as w:
            w.setparams((1,2,sr,0,'NONE','not compressed'))
            for sec in range(12):
                w.writeframes(b''.join(struct.pack('<h',round(32767*sum(amp*math.sin((i+sec*sr+1)*math.tau*hz/sr) for hz,amp in tones))) for i in range(sr)))
    for name,has_vocal in [('current-pitch-stale-key',True),('harmonic-only-missing-key',False)]:
        project=root/'Native key – проверка – 音楽 🎵'/name;(project/'stems').mkdir(parents=True)
        audio(project/'stems/guitar.wav',[(130.81,.25),(164.81,.20),(196.,.22)])
        audio(project/'stems/bass.wav',[(65.41,.30)])
        settings={}
        if has_vocal:
            audio(project/'stems/vocals.wav',[(220.,.1)])
            settings={'melody':{'detVersion':4,'hopSec':.025,'f0':'x480'},'key':{'pc':8,'minor':True,'detVersion':1}}
        raw={'version':2,'name':name,'foreign':{'preserve':'exact metadata'},'settings':settings}
        (project/'project.json').write_text(json.dumps(raw))
        case=out/name;case.mkdir(exist_ok=True)
        env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_')}
        env.update(SINGZ_GPUI_BACKGROUND='1',SINGZ_MUTE='1',SINGZ_NO_SYNC='1',SINGZ_GPUI_CONFIG_DIR=str(root/(name+'-prefs')),SINGZ_GPUI_PROJECTS_ROOT=str(root/'library'),SINGZ_GPUI_TEST_PROJECT=str(project),SINGZ_GPUI_PROJECT_KEY_TEST=str(case))
        env.update(SINGZ_GPUI_AUDIO_HELPER=str(tools/('singz-gpui-audio'+suffix)),SINGZ_GPUI_ANALYZER=str(tools/('singz-analyze'+suffix)),SINGZ_GPUI_INPUT_HELPER=str(tools/('singz-gpui-input'+suffix)))
        before=front();seen={before}
        with (case/'app.log').open('w') as log:
            p=subprocess.Popen([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT);deadline=time.monotonic()+65
            try:
                while p.poll() is None:
                    seen.add(front());assert time.monotonic()<deadline,'Native key case timed out';time.sleep(.1)
            finally:
                if p.poll() is None:p.terminate();p.wait(timeout=10)
        seen.add(front());(case/'host.json').write_text(json.dumps({'exitCode':p.returncode,'foregroundStable':seen=={before},'pid':p.pid,'retired':p.poll() is not None},indent=2))
        assert p.returncode==0,(case/'app.log').read_text();assert seen=={before},'Foreground changed'
        assert (case/'result.json').is_file()
        saved=json.loads((project/'project.json').read_text())
        assert saved['settings']['key']=={'pc':0,'minor':False,'detVersion':2}
        assert saved['foreign']==raw['foreign']
        if has_vocal:assert saved['settings']['melody']==settings['melody'],'Current melody was replaced'
        else:assert 'melody' not in saved['settings'],'Harmonic-only project acquired fabricated pitch'
print('PASS: real native harmonic key detection, stale-key healing with current pitch, harmonic-only analysis, automatic Save and foreground stability')
