"""Actual hidden native locale menu, playback continuity and durable restart.

No Node/browser/global input. Raster outputs are unqualified native candidates.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import struct
import subprocess
import tempfile
import threading
import time
import wave

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
repository = Path(__file__).resolve().parents[3]
uikit = repository.parent/'singz-ui'
spec = importlib.util.spec_from_file_location('locale_perf', Path(__file__).with_name('interface-perf.py'))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)
def shipped_languages():
    # The menu rows are Language::ALL: System, then Locale::ALL in menu order,
    # labelled with Locale::endonym(); read them from the same Rust source.
    import re
    source = (Path(__file__).resolve().parents[1]/'src/i18n.rs').read_text()
    variants = dict(re.findall(r'Self::(\w+) => "([\w-]+)",', source[source.index('pub fn as_str(self)'):source.index('pub fn parse(value')]))
    order = re.search(r'pub const ALL: \[Self; (\d+)\] = \[(.*?)\];', source, re.S)
    names = re.findall(r'Self::(\w+)', order.group(2))
    assert len(names) == int(order.group(1))
    endonyms = dict(re.findall(r'Self::(\w+) => "([^"]+)",', source[source.index('pub fn endonym(self)'):source.index('pub fn code(self)')]))
    return [('system', None)] + [(variants[name], endonyms[name]) for name in names]
LANGUAGES = shipped_languages()


def foreground():
    if platform.system() == 'Darwin':
        return subprocess.run(['/usr/bin/lsappinfo', 'front'], capture_output=True, text=True, timeout=2).stdout.strip()
    return None


def audio(path, frequency):
    path.parent.mkdir(parents=True, exist_ok=True)
    rate = 16000
    pcm = b''.join(struct.pack('<h', round(1000*math.sin(i*math.tau*frequency/rate))) for i in range(rate))
    with wave.open(str(path), 'wb') as target:
        target.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        target.writeframes(pcm*120)


def inventory(path):
    return {str(item.relative_to(path)): {'bytes': item.stat().st_size, 'sha256': sha(item)}
            for item in path.rglob('*') if item.is_file()}


def helper_pids(parent):
    listed = subprocess.run(['pgrep', '-P', str(parent)], capture_output=True, text=True, timeout=2)
    result = []
    for value in listed.stdout.split():
        if value.isdecimal():
            name = subprocess.run(['ps', '-p', value, '-o', 'comm='], capture_output=True, text=True, timeout=2).stdout.strip()
            if Path(name).name == 'singz-gpui-audio':
                result.append(int(value))
    return result


def launch(environment, folder):
    folder.mkdir(parents=True, exist_ok=True)
    before, started, stop = foreground(), time.monotonic(), threading.Event()
    samples, errors, previous = [], [], {}
    with (folder/'locale.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=environment, stdout=log, stderr=subprocess.STDOUT)
        baseline = None
        if platform.system() == 'Darwin':
            try:
                cpu, memory = perf.process_usage(child.pid)
                now = time.monotonic()
                previous[child.pid] = cpu, now
                baseline = {'cpuNanoseconds': cpu, 'footprintBytes': memory, 'elapsedSeconds': now-started}
            except OSError as error:
                errors.append({'phase': 'baseline', 'error': str(error)})

        def sample():
            intervals = 0
            while not stop.wait(.1 if intervals < 2 else .5):
                if platform.system() != 'Darwin':
                    return
                try:
                    for pid in [child.pid, *helper_pids(child.pid)]:
                        try:
                            cpu, memory = perf.process_usage(pid)
                            now = time.monotonic()
                            old = previous.get(pid)
                            if old:
                                samples.append({'role': 'app' if pid == child.pid else 'native-helper',
                                    'pid': pid, 'elapsedSeconds': now-started, 'footprintBytes': memory,
                                    'cpuPercent': (cpu-old[0])/((now-old[1])*1e9)*100})
                            previous[pid] = cpu, now
                        except OSError as error:
                            errors.append({'phase': 'sample', 'role': 'app' if pid == child.pid else 'native-helper', 'error': str(error)})
                    samples.append({'role': 'system-gpu', 'elapsedSeconds': time.monotonic()-started, 'gpu': perf.gpu_usage()})
                    intervals += 1
                except (OSError, subprocess.TimeoutExpired) as error:
                    errors.append({'phase': 'inventory', 'error': str(error)})

        thread = threading.Thread(target=sample, daemon=True)
        thread.start()
        try:
            child.wait(timeout=110)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            stop.set()
            thread.join(timeout=5)
    lifetime, after = time.monotonic()-started, foreground()
    (folder/'foreground.json').write_text(json.dumps({'before': before, 'after': after,
        'unchanged': before == after, 'method': 'read-only; no activation/global input'}, indent=2))
    cpu = [row['cpuPercent'] for row in samples if row.get('role') == 'app']
    assert all(math.isfinite(row['cpuPercent']) and row['cpuPercent'] >= 0 and row['footprintBytes'] >= 0
        for row in samples if 'cpuPercent' in row), samples
    (folder/'performance.json').write_text(json.dumps({'samples': samples, 'baseline': baseline,
        'errors': errors, 'lifetimeSeconds': lifetime, 'appCpuAvailable': bool(cpu),
        'nativeHelperCpuAvailable': any(row.get('role') == 'native-helper' for row in samples),
        'scope': 'GPUI/helper CPU+memory observed separately; GPU system-wide',
        'liveFps': {'available': False, 'reason': 'Hidden macOS windows suspend display callbacks'},
        'visualParity': 'unqualified native candidates'}, indent=2))
    assert before == after, 'Foreground application changed'
    assert child.returncode == 0 and (folder/'result.json').exists(), (folder/'locale.log').read_text()
    assert not (folder/'failure.txt').exists(), (folder/'failure.txt').read_text() if (folder/'failure.txt').exists() else ''
    if platform.system() == 'Darwin':
        assert cpu or lifetime < .25, (lifetime, errors)


def capture(folder, name, viewport):
    from PIL import Image
    data = json.loads((folder/(name+'.json')).read_text())
    assert data['viewport'] == list(viewport) and data['scale'] == 2 and data['hidden'], name
    assert Image.open(folder/(name+'.png')).size == (viewport[0]*2, viewport[1]*2), name
    return data


with tempfile.TemporaryDirectory(prefix='singz-locale-ui-') as temporary:
    root = Path(temporary).resolve()
    project = root/'library'/'Locale song fixture'
    audio(project/'stems/vocals.wav', 220)
    audio(project/'stems/bass.wav', 110)
    original = {'version': 2, 'name': 'Locale song fixture', 'foreign': {'preserve': 17},
        'settings': {'tempo': 1, 'transpose': -2, 'masterVolume': .61, 'loop': False,
            'tracks': {'vocals': {'volume': .37, 'muted': False, 'solo': False},
                       'bass': {'volume': .7, 'muted': True, 'solo': False}},
            'beat': {'beats': [i*.5 for i in range(240)], 'bpm': 120, 'beatsPerBar': 4,
                'downbeat': 0, 'downbeats': list(range(0, 240, 4)), 'autoDownbeats': list(range(0, 240, 4)), 'source': 'auto', 'detVersion': 23},
            'melody': {'detVersion': 4, 'hopSec': .01, 'f0': ' '.join(['2400']*12000)},
            'metronome': {'click': False, 'countInBars': 0, 'volume': .3, 'accent': True, 'grid': False}}}
    (project/'project.json').write_text(json.dumps(original))
    (project/'foreign.txt').write_text('Locale selection must never rewrite project files.')
    initial = inventory(project)
    preferences = root/'prefs'
    preferences.mkdir()
    (preferences/'language.json').write_text(json.dumps({'version': 1, 'language': 'en', 'foreign': {'preserve': 23}}))
    environment = {key: value for key, value in os.environ.items()
        if not key.startswith('SINGZ_GPUI_') and key not in ('SINGZ_LANG', 'SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS')}
    environment.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
        SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
        SINGZ_GPUI_CONFIG_DIR=str(preferences), SINGZ_GPUI_PROJECTS_ROOT=str(root/'library'),
        SINGZ_GPUI_TEST_PROJECT=str(project), SINGZ_PACK_DIR=str(root/'missing-pack'), SINGZ_MODELS_DIR=str(root/'missing-models'))
    helper = app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')
    sources = [repository/'src/renderer/src/components/LanguageControl.tsx',
        repository/'src/renderer/src/components/Flags.tsx', repository/'src/shared/i18n/rules.ts',
        uikit/'src/primitives/LanguageSwitcher.tsx', uikit/'src/styles/primitives.css',
        uikit/'gpui/src/language_controls.rs', repository/'experiments/gpui-player/src/language_menu.rs',
        repository/'experiments/gpui-player/src/i18n.rs', repository/'experiments/gpui-player/src/locale_service.rs']
    font_root = uikit/'gpui/assets/fonts'
    (out/'fixture.json').write_text(json.dumps({'appSha256': sha(app), 'helperSha256': sha(helper),
        'sourceFiles': {str(path): sha(path) for path in sources},
        'fontFiles': {str(path.relative_to(font_root)): sha(path) for path in font_root.rglob('*') if path.is_file()},
        'languages': LANGUAGES, 'project': original, 'files': initial,
        'viewports': [[1280,800],[1060,640]], 'scale': 2, 'hidden': True, 'muted': True, 'noNode': True,
        'visualParity': 'unqualified native candidates; source menu cap adapted for short viewport'}, indent=2))
    for stage in ('exercise', 'restart'):
        launch({**environment, 'SINGZ_GPUI_LOCALE_TEST': str(out/stage), 'SINGZ_GPUI_LOCALE_STAGE': stage,
            **({'SINGZ_LANG': 'en'} if stage == 'exercise' else {'SINGZ_GPUI_LOCALE_TEST_PERSIST': '1'})}, out/stage)
        # The open's analysis auto-save is legitimate; the native stage copies the
        # project once that has settled, immediately before the first language choice.
        assert (out/stage/'settled-project'/'project.json').exists(), 'Native stage never recorded the settled project'
        settled = inventory(out/stage/'settled-project')
        now = inventory(project)
        assert now == settled, 'Locale selection rewrote the loaded project: ' + str(
            sorted(k for k in {*now, *settled} if now.get(k) != settled.get(k)))
        saved = json.loads((preferences/'language.json').read_text())
        assert saved['language'] == 'ja' and saved['foreign'] == {'preserve': 23}, saved
        (out/stage/'persisted-preference.json').write_text(json.dumps(saved, indent=2))
        if stage == 'exercise':
            # Strings on the minimum-width routes come from the dictionaries, translated in
            # every locale: no English literal left in the layout code, and no locale that
            # copies the English value.
            import re
            gpui = repository/'experiments/gpui-player'
            for source, literal in (('settings.rs', 'Quick start'), ('library.rs', 'Project folders · Saved in place')):
                assert f'"{literal}"' not in (gpui/'src'/source).read_text(), f'{source} hard-codes {literal!r}'
            def dictionary(locale):
                text = (repository/'src/shared/i18n'/locale/'native.ts').read_text()
                return {key: value for key, value in re.findall(r'^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)"', text, re.M)}
            english = dictionary('en')
            for key in ('quickStart.title', 'library.folders.savedInPlace'):
                assert english.get(key), key
                for language, _ in LANGUAGES[1:]:
                    value = dictionary(language).get(key)
                    assert value and (language == 'en' or value != english[key]), f'{key} untranslated in {language}'
            # This additional matrix records the actual window scale. The existing
            # 2x qualification assertions below remain unchanged.
            from PIL import Image
            for prefix, narrow in (('minimum', [940, 600]), ('narrow', [1060, 640])):
              for language, _ in LANGUAGES:
                for route in ('title', 'settings', 'library'):
                    name = f'{prefix}-{route}-{language}'
                    data = json.loads((out/stage/(name+'.json')).read_text())
                    assert data['viewport'] == narrow and data['hidden']
                    assert data['locale']['language'] == language
                    scale = data['scale']
                    assert Image.open(out/stage/(name+'.png')).size == (narrow[0]*scale, narrow[1]*scale)
                    # No clipped control at the minimum width: every header pill is at least
                    # as wide as its whole translated label (no ellipsis), in every locale.
                    pills = data['header']
                    assert {row['id'] for row in pills} >= {'header-log', 'header-help'}, (name, pills)
                    for row in pills:
                        assert row['actual'] is not None, (name, row)
                        assert not row['ellipsis'], f'Header pill ellipsizes at {narrow[0]}: {name} {row}'
                        # Layout quantizes box widths to 1/64 px, so allow a hair; a real clip is more.
                        assert row['actual'] >= row['needed'] - 0.5, f'Header pill narrower than its label at {narrow[0]}: {name} {row}'
                    if route == 'title':
                        assert data['titleEditor'] is not None and data['titleEditor'] >= 96, f'Title editor too small at {narrow[0]}: {name} {data["titleEditor"]}'
                    # Nothing is pushed out of the window or onto its neighbour.
                    placed = sorted(pills, key=lambda row: row['left'])
                    assert placed[-1]['right'] <= narrow[0] + 0.5, f'Header pill leaves the window at {narrow[0]}: {name} {placed[-1]}'
                    for before, after in zip(placed, placed[1:]):
                        assert after['left'] >= before['right'] - 0.5, f'Header pills overlap at {narrow[0]}: {name} {before} {after}'
        for width, height in ((1280,800),(1060,640)):
            if stage == 'restart':
                data = capture(out/stage, f'restored-ja-{width}', (width,height))
                assert data['locale']['language'] == data['locale']['locale'] == 'ja'
                assert data['menu']['focusedControl'] == 'language-option-ja'
                assert data['playing'] and data['native']['playing']
                continue
            for locale in ('en', 'ru'):
                carry = capture(out/stage, f'popover-carry-{locale}-{width}', (width,height))
                metro = capture(out/stage, f'popover-metronome-{locale}-{width}', (width,height))
                assert carry['locale']['locale'] == metro['locale']['locale'] == locale
                assert carry['carry']['caption'] == {
                    'en': 'Guide plays 10 s, then you take the next 10 s.',
                    'ru': 'Опора играет 10 с, потом 10 с ведёте вы.',
                }[locale]
                assert carry['playing'] and metro['playing']
                assert metro['metronomeCaption'] and 'player.metronome.' not in metro['metronomeCaption']
                if locale == 'ru':
                    assert any('а' <= c <= 'я' for c in metro['metronomeCaption'])
            base = None
            for index, (language, endonym) in enumerate(LANGUAGES):
                data = capture(out/stage, f'selected-{language}-{width}', (width,height))
                menu = data['menu']
                assert data['locale']['language'] == menu['language'] == language
                assert menu['selectedIndex'] == menu['focusedIndex'] == index and menu['focusInside']
                assert len(menu['rows']) == len(LANGUAGES)
                assert [row['value'] for row in menu['rows']] == [value for value, _ in LANGUAGES]
                assert [row['label'] for row in menu['rows'][1:]] == [value for _, value in LANGUAGES[1:]]
                assert sum(bool(row['selected']) for row in menu['rows']) == 1 and menu['rows'][index]['selected']
                assert menu['rows'][0]['hint'] and all(row['hint'] is None or isinstance(row['hint'], str) for row in menu['rows'])
                assert data['playing'] and data['native']['playing']
                if language == 'system':
                    assert data['locale']['locale'] == data['locale']['systemLocale']
                independent = {key: data[key] for key in ('epoch','gain','muted','solo','tempo','transpose','master')}
                independent['graph'] = data['native']['graph']
                if base is None:
                    base = independent
                assert independent == base, language
            search = capture(out/stage, f'search-preserved-ru-{width}', (width,height))
            # Opening the catalog pauses playback by design (App.tsx toggleCatalog), so the
            # transport must be paused in the app and in the native helper alike.
            assert search['search'] == 'locale' and search['locale']['locale'] == 'ru'
            assert not search['playing'] and not search['native']['playing'], search['native']
            alternate = (1060,640) if width == 1280 else (1280,800)
            capture(out/stage, f'resized-open-from-{width}', alternate)
            guide = json.loads((repository/'experiments/gpui-player/src/quick_start_copy.json').read_text())
            release = json.loads((repository/'src/shared/release-content.json').read_text())
            for locale in ('en','ru'):
                log = capture(out/stage, f'log-{locale}-{width}', (width,height))
                assert log['locale']['locale'] == locale and log['log']['open'] and log['log']['copied']
                assert log['log']['copyText'] == '\n'.join(
                    f"{row['time']} [{row['level']}] {row['source']}: {row['message']}" for row in log['log']['rows'])
                training = capture(out/stage, f'training-{locale}-{width}', (width,height))
                tour = capture(out/stage, f'tour-{locale}-{width}', (width,height))
                notes = capture(out/stage, f'release-{locale}-{width}', (width,height))
                assert training['locale']['locale'] == tour['locale']['locale'] == notes['locale']['locale'] == locale
                assert tour['quickStart']['copyLocale'] == locale
                assert tour['quickStart']['title'] == guide[locale]['steps']['training'][0]
                assert tour['quickStart']['body'] == guide[locale]['steps']['training'][1]
                actual = notes['release']['notes']['entries'][0]['highlights']
                first = release['releases'][0]['highlights'][0]
                assert actual[0]['id'] == first['id']
                assert actual[0]['title'] == first['text'][locale]['title']
                assert actual[0]['description'] == first['text'][locale]['description']
        if stage == 'exercise':
            held = json.loads((out/stage/'rapid-held.json').read_text())
            final = json.loads((out/stage/'rapid-final-ja.json').read_text())
            assert held['localePending'] and held['locale']['locale'] == 'en'
            assert not final['localePending'] and final['locale']['locale'] == 'ja'
            assert final['localeSequence'] == held['localeSequence']+3
    (out/'result.json').write_text(json.dumps({'stages': 2, 'sizes': 2, 'actualChoicesPerSize': len(LANGUAGES),
        'nativePlaybackContinuity': 'locale changes before intentional Training navigation',
        'searchDraftPreserved': True, 'tourAndReleaseCopy': ['en','ru'],
        'latestRapidPickDurableJa': True, 'persistedJaRestoredWhileHidden': True,
        'foregroundUnchanged': True, 'projectUnchanged': True,
        'liveFps': 'unmeasured', 'visualParity': 'unqualified native candidates'}, indent=2))
