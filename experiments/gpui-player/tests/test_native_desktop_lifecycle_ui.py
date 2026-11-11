"""Focused macOS lifecycle check. Output directory must use a fresh config."""
import argparse,json,os,subprocess,sys,time
from pathlib import Path
parser=argparse.ArgumentParser(description="Hidden macOS native lifecycle check; no OS input or activation")
parser.add_argument('app',type=Path)
parser.add_argument('out',type=Path)
args=parser.parse_args()
assert sys.platform=='darwin','Close-to-Dock-reopen case is macOS-specific'
app=args.app.resolve()
out=args.out.resolve();out.mkdir(parents=True,exist_ok=True)
assert not (out/'prefs').exists(),'Use fresh isolated config'
env={k:v for k,v in os.environ.items() if not k.startswith('SINGZ_GPUI_')}
env.update(SINGZ_GPUI_DEMO='1',SINGZ_GPUI_BACKGROUND='1',SINGZ_MUTE='1',SINGZ_GPUI_CONFIG_DIR=str(out/'prefs'),SINGZ_GPUI_DESKTOP_LIFECYCLE_TEST=str(out))
def front():
 return subprocess.run(['/usr/bin/lsappinfo','front'],capture_output=True,text=True,timeout=3).stdout.strip()
before=front();seen={before}
with (out/'app.log').open('w') as log:
 p=subprocess.Popen([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT)
 deadline=time.monotonic()+40
 try:
  while p.poll() is None:
   seen.add(front())
   if time.monotonic()>deadline:raise TimeoutError('Hidden lifecycle case timed out')
   time.sleep(.1)
 finally:
  if p.poll() is None:p.terminate();p.wait(timeout=10)
after=front();seen.add(after)
(out/'host.json').write_text(json.dumps({'exitCode':p.returncode,'foregroundBefore':before,'foregroundAfter':after,'foregroundStable':seen=={before},'pid':p.pid,'retired':p.poll() is not None},indent=2))
assert p.returncode==0,(out/'app.log').read_text()
assert seen=={before},'Foreground changed'
assert (out/'result.json').exists(),'Missing successful case result'
print((out/'result.json').read_text())
