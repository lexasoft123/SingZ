from pathlib import Path
import re,json,argparse,os
os.chdir(Path(__file__).resolve().parent.parent)
p=argparse.ArgumentParser();p.add_argument("--check",action="store_true");args=p.parse_args()
text=Path('src/shared/quick-start/index.ts').read_text();en=text.split('const en = {',1)[1].split('const ru =',1)[0]
values={k:v for k,v in re.findall(r"(\w+): '([^']*)'",en)}
steps={k:[a,b] for k,a,b in re.findall(r"(\w+): \[\s*'([^']*)',\s*'([^']*)'\s*\]",en)}
for key,title in [('library','Open your own MP3'),('split','Split your MP3 into stems')]:
 found=re.findall(r"'"+re.escape(title)+r"',\s*'([^']*)'",text);assert found;steps[key]=[title,found[-1]]
values['steps']=steps;assert len(steps)==8
values.update(saved=['Your saved songs','Your saved projects live here. Choose a song to open it. Once it opens, replay this guide with ? to explore the player controls.'],karaoke=['Show the lyrics','Turn on Karaoke here to show synced lyrics and the pitch display alongside your tracks.'],tempo='Find your tempo and key',loop='Select a passage on the waveform, then enable Loop here to practise that section repeatedly.',intro='Follow the balloons beside the controls on this screen. Replay the guide from Settings or with ? at any time.')
ui=Path('src/renderer/src/components/QuickStart.tsx').read_text()
for value in [*values['saved'],*values['karaoke'],values['tempo'],values['loop'],values['intro']]:
 assert "'"+value+"'" in ui, 'QuickStart.tsx copy changed; reconcile native generator'
output=json.dumps(values,ensure_ascii=False,indent=2)+'\n';dest=Path('experiments/gpui-player/src/quick_start_copy.json')
if args.check:assert dest.read_text()==output, 'Native Quick start copy is stale'
else:dest.write_text(output)
print('Quick start desktop English copy matches source')
