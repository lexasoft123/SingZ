"""Exercise the one shared Python runner without any JavaScript runtime."""
import hashlib,json,os,subprocess,sys,tempfile
from pathlib import Path
repo=Path(__file__).resolve().parents[3];runner=repo/'scripts/onnx_split_runner.py'
assert "../../scripts/onnx_split_runner.py?raw" in (repo/'src/main/onnx-runner.ts').read_text()
assert 'include_str!("../../../scripts/onnx_split_runner.py")' in (repo/'experiments/gpui-player/src/source_jobs.rs').read_text()
compile(runner.read_text(),str(runner),'exec')
with tempfile.TemporaryDirectory(prefix='singz-shared-runner-') as folder:
 root=Path(folder);module=root/'demucs_onnx';module.mkdir();(module/'__init__.py').write_text('');(module/'cli.py').write_text('import sys,json\ndef main():\n print(json.dumps(sys.argv[1:]))\n return 7\n')
 env=dict(os.environ,PYTHONPATH=str(root),PYTHONDONTWRITEBYTECODE='1')
 argv=['separate','input with spaces.wav','output folder','--providers','cpu','-v']
 r=subprocess.run([sys.executable,str(runner),*argv],env=env,capture_output=True,text=True,timeout=15)
 assert r.returncode==7 and json.loads(r.stdout)==argv,(r.returncode,r.stdout,r.stderr)
 code='import runpy,sys;sys.platform="win32";sys.argv='+repr([str(runner),'separate','in.wav','out','--providers','trtrtx'])+';runpy.run_path('+repr(str(runner))+',run_name="__main__")'
 r=subprocess.run([sys.executable,'-c',code],env=env,capture_output=True,text=True,timeout=15)
 assert r.returncode==3 and 'TensorRT RTX payload missing' in r.stdout,(r.returncode,r.stdout,r.stderr)
print('PASS: one shared ONNX runner; CPU argv/exit propagation and missing Windows GPU payload refusal; SHA256 '+hashlib.sha256(runner.read_bytes()).hexdigest())
