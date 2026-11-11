#!/usr/bin/env python3
"""Capture fixed-timeline native screenshot frames; requires a capture-mode player already running."""
import argparse,json,subprocess,time
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--control',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
p.add_argument('--window-id',type=int);p.add_argument('--region',default='1185,570,345,80');p.add_argument('--fps',type=int,default=120)
p.add_argument('--frames',type=int,default=161);p.add_argument('--start',type=float,default=63.85)
a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True);manifest=[]
for frame in range(a.frames):
 position=a.start+frame/a.fps;token=f'{position:.8f}'
 temporary=a.control.with_suffix('.next');temporary.write_text(token);temporary.replace(a.control)
 deadline=time.monotonic()+5
 ack=a.control.with_suffix('.ack')
 while not ack.exists() or ack.read_text()!=token:
  if time.monotonic()>deadline:raise RuntimeError(f'No render acknowledgement for frame {frame}')
  time.sleep(.01)
 # Acknowledgement arrives on the next display callback; allow that frame to present.
 time.sleep(.035)
 filename=f'frame-{frame:04d}.png'
 subprocess.run(['screencapture','-x','-o']+(['-l'+str(a.window_id)] if a.window_id else ['-R'+a.region])+[str(a.out/filename)],check=True)
 manifest.append({'frame':frame,'position_s':position,'timeline_fps':a.fps,'file':filename})
 if frame%40==0:print(f'Captured {frame+1}/{a.frames}',flush=True)
(a.out/'frames.json').write_text(json.dumps(manifest,indent=2))
(a.out/'index.html').write_text('''<!doctype html><meta charset="utf-8"><title>Lyric highlight frames</title><style>body{background:#12100d;color:#f4efe6;font:16px system-ui;margin:24px}img{width:690px;max-width:100%;image-rendering:auto}button,input{margin:12px}figure{margin:0 0 20px}small{color:#9b917e}</style><h1>Lyric highlight — consecutive frames</h1><p>Frozen screenshots at 120Hz timeline steps. These are deterministic samples, not a recording of actual presentation timing.</p><button id="prev">Previous</button><button id="next">Next</button><input id="slider" type="range" min="0" value="0"><span id="label"></span><div><img id="preview"></div><h2>All frames</h2><div id="all"></div><script>const frames='''+json.dumps(manifest)+''';slider.max=frames.length-1;function show(i){slider.value=i;preview.src=frames[i].file;label.textContent=`Frame ${i} · ${frames[i].position_s.toFixed(5)} s`};slider.oninput=()=>show(+slider.value);prev.onclick=()=>show(Math.max(0,+slider.value-1));next.onclick=()=>show(Math.min(frames.length-1,+slider.value+1));document.onkeydown=e=>{if(e.key==='ArrowRight')next.click();if(e.key==='ArrowLeft')prev.click()};all.innerHTML=frames.map(f=>`<figure><small>Frame ${f.frame} · ${f.position_s.toFixed(5)} s</small><br><img loading="lazy" src="${f.file}"></figure>`).join('');show(0)</script>''')
print(a.out/'index.html')
