"""Hidden muted native model wizard and aligner consent (Q-05).

Native twin of tests/e2e/mac/wizard-consent-e2e.cjs. With the speech model installed
and the precise aligner absent (a fixture models directory), the app is driven by
the ui_first_run hook through the same controls a singer uses:

  1. the wizard lists every artifact the platform offers and shows the aligner (and
     the splitter pack) as not installed, the speech model as installed;
  2. opening the list starts nothing: no download is running after a wait;
  3. closing the wizard returns to the song that was open;
  4. Precise, with the aligner absent, shows a consent that names the aligner and its
     size and does not download.

"No install before consent" is enforced from outside the app: a `curl` shim first on
PATH records every launch (any launch fails the run) and the model and pack
directories must be byte for byte what the driver created.

Run on a qualify build: cargo build --profile qualify --features ui-tests
Deadlines: per-step budgets and a total deadline; the app and its children are killed
when either expires.
"""
import argparse
import atexit
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time

TOTAL_DEADLINE = 240.0
STEP_BUDGETS = {'fixtures': 60.0, 'app': 150.0}

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
parser.add_argument('--sample', type=Path, default=None)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
assert platform.system() in ('Darwin', 'Windows'), 'the wizard offers the aligner only on macOS and Windows'
REPO = Path(__file__).resolve().parents[3]
SAMPLE = (args.sample or REPO / 'mobile/assets/sample').resolve()
started = time.monotonic()
children = []


def remaining():
    return TOTAL_DEADLINE - (time.monotonic() - started)


def kill_children():
    for child in children:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


atexit.register(kill_children)
for sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, lambda *_: sys.exit(130))


class Step:
    def __init__(self, name):
        self.name, self.limit = name, STEP_BUDGETS[name]

    def __enter__(self):
        self.begin = time.monotonic()
        assert remaining() > 0, 'total deadline expired before step ' + self.name
        return self

    def __exit__(self, kind, value, trace):
        if kind is None:
            elapsed = time.monotonic() - self.begin
            assert elapsed <= self.limit, f'step {self.name} took {elapsed:.1f}s, budget {self.limit}s'

    def timeout(self):
        return min(self.limit - (time.monotonic() - self.begin), remaining())


def run_app(environment, folder, step):
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / 'app.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    children.append(child)
    try:
        child.wait(timeout=max(step.timeout(), 1))
    except subprocess.TimeoutExpired:
        kill_children()
        raise AssertionError(f'app exceeded the {step.name} budget or the total deadline; killed')
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    return child.returncode


sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
# The app creates empty `.gpui-model-<id>.lock` files while it checks what is installed; they are
# not model content, so they are ignored. Anything else appearing is an install.
inventory = lambda root: {str(p.relative_to(root)): {'bytes': p.stat().st_size, 'sha256': sha(p)} for p in sorted(root.rglob('*')) if p.is_file() and not (p.name.startswith('.gpui-model-') and p.name.endswith('.lock') and p.stat().st_size == 0)}
helper = app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')
assert helper.is_file(), f'rebuild the audio helper next to the app: {helper}'
assert (SAMPLE / 'project.json').is_file() and (SAMPLE / 'lyrics.json').is_file(), f'bundled sample song missing: {SAMPLE}'

with tempfile.TemporaryDirectory(prefix='singz-first-run-') as temporary, Step('fixtures'):
    root = Path(temporary).resolve()
    library = root / 'library'
    project = library / 'First run sample'
    shutil.copytree(SAMPLE, project)
    raw = json.loads((project / 'project.json').read_text())
    raw['name'] = 'First run sample'
    (project / 'project.json').write_text(json.dumps(raw))
    # The sidebar offers Check/Precise only for lyrics that are not a raw speech transcript; the
    # sample's lyrics are one, so the copy is marked as the singer's own edit.
    lyrics = json.loads((project / 'lyrics.json').read_text())
    lyrics['source'] = 'edited'
    (project / 'lyrics.json').write_text(json.dumps(lyrics))
    # The speech model is installed (three GGUF parts, magic bytes, over the size floor);
    # the splitter pack and the precise aligner are not.
    models, pack = root / 'models', root / 'pack'
    models.mkdir()
    for name in ('Qwen3-ASR-1.7B-Q8_0.gguf', 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf', 'qwen3-forced-aligner-0.6b-q8_0.gguf'):
        with (models / name).open('wb') as stream:
            stream.write(b'GGUF')
            stream.truncate(1024 * 1024 + 16)
    # Precise needs the pack's Python and the two lyric engines to be offered at all;
    # these are inert regular files, never executed because nothing is accepted.
    (pack / 'python/bin').mkdir(parents=True)
    (pack / 'python/bin/python3').write_text('#!/bin/sh\nexit 1\n')
    engines = root / 'engines'
    engines.mkdir()
    for name in ('llama-server', 'crispasr'):
        (engines / name).write_text('#!/bin/sh\nexit 1\n')
        (engines / name).chmod(0o700)
    shim = root / 'shim'
    shim.mkdir()
    curl_log = root / 'curl.log'
    curl_log.write_text('')
    (shim / 'curl').write_text('#!/bin/sh\necho "$@" >> "$SINGZ_FIRST_RUN_CURL_LOG"\nexit 7\n')
    (shim / 'curl').chmod(0o700)
    (root / 'prefs').mkdir()
    # qualify (release) builds open What's new automatically unless this version is acknowledged
    (root / 'prefs' / 'release-highlights.json').write_text(json.dumps({'version': 1, 'releaseNotesSeen': json.loads((REPO / 'package.json').read_text())['version']}))
    before = {'project': inventory(project), 'models': inventory(models), 'pack': inventory(pack)}
    environment = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_') and k not in ('LANG',)}
    environment.update(PATH=f'{shim}{os.pathsep}{os.environ["PATH"]}', SINGZ_FIRST_RUN_CURL_LOG=str(curl_log),
        SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
        SINGZ_GPUI_FIRST_RUN_TEST=str(out / 'app'), SINGZ_GPUI_FIRST_RUN_PROJECT=str(project),
        SINGZ_GPUI_CONFIG_DIR=str(root / 'prefs'), SINGZ_GPUI_PROJECTS_ROOT=str(library),
        SINGZ_MODELS_DIR=str(models), SINGZ_PACK_DIR=str(pack),
        SINGZ_LLAMA_SERVER=str(engines / 'llama-server'), SINGZ_CRISPASR=str(engines / 'crispasr'))
    (out / 'app').mkdir(exist_ok=True)
    (out / 'app/result.json').unlink(missing_ok=True)
    (out / 'app/failure.txt').unlink(missing_ok=True)
    try:
        with Step('app') as step:
            code = run_app(environment, out / 'app', step)
        failure = out / 'app/failure.txt'
        assert code == 0 and (out / 'app/result.json').is_file(), failure.read_text() if failure.exists() else (out / 'app/app.log').read_text()
        read = lambda name: json.loads((out / 'app' / f'{name}.json').read_text())
        wizard, waited, closed, consent = read('wizard'), read('wizard-after-wait'), read('wizard-closed'), read('consent')
        for record in (wizard, waited, closed, consent):
            assert not record['windowPresented'] and not record['windowActive'], record

        # ---- 1. every artifact is listed, the aligner is not installed ---------------
        rows = {r['id']: r for r in wizard['rows']}
        assert wizard['screen'] == 'models' and wizard['loaded'], wizard
        assert set(rows) == {'gpu-splitter', 'qwen-asr', 'aligner'}, ('wizard does not list the three artifacts', sorted(rows))
        assert rows['aligner']['present'] is False and rows['aligner']['optional'] is True, rows['aligner']
        assert rows['qwen-asr']['present'] is True, rows['qwen-asr']
        assert rows['gpu-splitter']['present'] is False, rows['gpu-splitter']
        assert rows['aligner']['downloadMb'] > 0 and all(r['label'] for r in rows.values()), rows

        # ---- 2. looking starts nothing -----------------------------------------------
        assert waited['busy'] is False and waited['running'] == [], ('the wizard began installing by itself', waited)

        # ---- 3. closing returns to the song ------------------------------------------
        assert closed['screen'] == 'other' and Path(closed['project']).resolve() == project.resolve(), ('closing the wizard did not return to the open song', closed)

        # ---- 4. Precise asks first and names the aligner ------------------------------
        side = consent['sidebar']
        assert side['status'] == 'consent' and side['details']['what'] == 'aligner', ('Precise did not show an aligner consent', side)
        assert side['details']['sizeMb'] == rows['aligner']['downloadMb'], ('consent size is not the aligner size', side['details'], rows['aligner'])
        assert consent['busy'] is False and consent['running'] == [], consent

        # ---- nothing was fetched or written before an accept ---------------------------
        assert not curl_log.read_text().strip(), 'a download was started without consent: ' + curl_log.read_text()
        assert inventory(models) == before['models'], 'the model directory changed before any consent'
        assert inventory(pack) == before['pack'], 'the splitter pack directory changed before any consent'
        # project.json may legitimately record the Karaoke switch the driver pressed; the lyrics and stems may not change.
        now = inventory(project)
        assert {k: v for k, v in now.items() if k not in ('project.json', '.singz-native-write.lock')} == {k: v for k, v in before['project'].items() if k not in ('project.json', '.singz-native-write.lock')}, 'the song files were changed by looking at the wizard and consent'
        (out / 'first-run.json').write_text(json.dumps({'rows': wizard['rows'], 'consent': side['details'], 'curlLaunches': 0,
            'note': 'Manual wizard origin; the Auto (first-launch) origin is suppressed in hidden mode and starts required downloads by design',
            'hidden': True, 'muted': True}, indent=2))
    finally:
        kill_children()
        shutil.copytree(root, out / 'fixtures', dirs_exist_ok=True, ignore=shutil.ignore_patterns('*.flac', '*.gguf'))
print('PASS hidden native wizard + consent: three artifacts listed, aligner not installed, Precise asks first, nothing fetched')
