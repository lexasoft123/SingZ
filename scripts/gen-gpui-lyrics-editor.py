"""Snapshot native editor English copy from source, without executing JS."""
from pathlib import Path
import argparse, ast, hashlib, json, re

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
source = root / 'src/shared/i18n/en/lyrics.ts'
text = source.read_text()
pattern = r"'(lyrics\.(?:editor|check)\.[^']+)'\s*:\s*('(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\")"
values = {key: ast.literal_eval(value) for key, value in re.findall(pattern, text)}
assert len(values) > 65 and values['lyrics.editor.title'] == 'Edit lyrics'
values['_sourceSha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
output = json.dumps(values, ensure_ascii=False, indent=2) + '\n'
target = root / 'experiments/gpui-player/src/lyrics_editor_copy.json'
if args.check:
    assert target.read_text() == output, 'Native lyrics editor copy is stale'
else:
    target.write_text(output)
print('Native lyrics editor English copy matches source')
