"""Hidden native song-preparation keyboard flow and paused-song return.

Identify uses real native cues and answers. Generated PCM is a safety fixture;
this journey requires that no input helper opens. No physical audio is tested.
"""
import argparse
import json
import math
import os
from pathlib import Path
import platform
import shutil
import struct
import sys
import tempfile
import wave

sys.dont_write_bytecode = True
import test_native_training_keyboard as shared


FLAGS = (
    'actualHeaderTab', 'recipeKeys', 'fourRecipes', 'setupFirst',
    'keyStampAndTranspose', 'chosenRangePreserved', 'taskPreserved', 'songBoundary',
    'sixPromptNativeIdentify', 'singleAnswerReceipts', 'summaryBackToPausedSong',
    'resumedNativePlayback', 'replacementInvalidatesContext', 'unknownKeyManualSetup',
    'pointerAfterKeyboard', 'endedOwnersReleased',
)
CAPTURES = ('home', 'recipe-chords', 'recipe-mixed', 'recipe-intervals',
            'recipe-notes', 'summary', 'unknown-home', 'unknown-setup')
PHASES = ('prepared-summary', 'returned-paused', 'returned-playing', 'returned-repaused', 'unknown-setup')


def tone(path, rate, seconds, amplitude=4000):
    with wave.open(str(path), 'wb') as audio:
        audio.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(amplitude * math.sin(i * math.tau * 220 / rate)))
                                  for i in range(round(rate * seconds))))


def check_state(row):
    assert row['hidden'] is True and row['active'] is False and row['hardwareInput'] is False, row
    assert row['capture']['phase'] == 'Off' and row['micIntent'] is False, row
    assert row['projectLoaded'] is True, row
    keyboard = row['keyboard']
    if keyboard['focusedControl'] is not None:
        assert keyboard['focusedControl'] in keyboard['focusOrder'] and keyboard['focusInside'] is True, row
        bounds = keyboard['focusedBounds']
        assert isinstance(bounds, list) and len(bounds) == 4, row
        assert all(isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) for n in bounds), row
        x, y, width, height = bounds
        assert width > 0 and height > 0 and x >= -1 and y >= -1, row
        assert x + width <= row['viewport'][0] + 1 and y + height <= row['viewport'][1] + 1, row


def check_receipts(result, viewport):
    states = {}
    for phase in PHASES:
        rows = [r for r in result['receipts'] if r['phase'] == phase and r['viewport'] == viewport]
        assert len(rows) == 1, (viewport, phase, rows)
        states[phase] = rows[0]
        check_state(rows[0])
        assert rows[0]['ownersReleased'] is True, rows[0]
    summary = states['prepared-summary']
    practice = summary['practice']
    assert practice['phase'] == 'Summary' and practice['kind'] == 'Degree' and practice['task'] == 'Identify', summary
    assert practice['promptCount'] == practice['resultCount'] == practice['correct'] == 6, summary
    assert [r['promptIndex'] for r in practice['responses']] == list(range(1, 7)), summary
    assert all(r['kind'] == 'identify' and r['correct'] is True for r in practice['responses']), summary
    assert summary['preparationMatchesCurrent'] is True and summary['keyboard']['song']['effectiveKey'] == {'tonic': 1, 'minor': True}, summary
    assert summary['keyboard']['config']['low'] == 49 and summary['keyboard']['config']['high'] == 73, summary
    paused, playing, repaused = (states[p] for p in ('returned-paused', 'returned-playing', 'returned-repaused'))
    for row in (paused, playing, repaused):
        assert row['epoch'] == summary['epoch'] and row['projectPath'] == summary['projectPath'], row
        assert row['screenPlayer'] is True and row['practice'] is None and row['transpose'] == 2, row
        native = row['native']
        assert native is not None and native['trainingOnly'] is False and native['transpose'] == 2 and abs(native['rate'] - 1) < .0001, row
        assert abs(native['duration'] - 12) < .03 and native['masterGain'] == 0, row
        assert all(math.isfinite(native[name]) for name in ('position', 'duration', 'rate')), row
    assert paused['playing'] is paused['native']['playing'] is False, paused
    assert playing['playing'] is playing['native']['playing'] is True, playing
    assert playing['native']['position'] > paused['native']['position'] + .15, (paused, playing)
    assert repaused['playing'] is repaused['native']['playing'] is False, repaused
    unknown = states['unknown-setup']
    assert unknown['epoch'] != summary['epoch'] and unknown['projectPath'] != summary['projectPath'], unknown
    assert unknown['practice'] is None and unknown['playing'] is False and unknown['trainingGeneration'] is None, unknown
    assert unknown['keyboard']['route'] == 'Setup' and unknown['keyboard']['song']['effectiveKey'] is None, unknown
    assert unknown['keyboard']['preparation']['source'] == unknown['epoch'], unknown
    assert unknown['keyboard']['preparationNotice'] == 'training.session.error.confirmKeyThenReview', unknown


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--timeout', type=int, default=300)
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('Strict process and foreground observation currently requires macOS')
    if not 30 <= args.timeout <= 600:
        parser.error('--timeout must be between 30 and 600 seconds')
    app, out = args.app.resolve(strict=True), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    assert not any(out.iterdir()), 'Use a fresh OUT directory'
    app_hash = shared.sha(app)
    with tempfile.TemporaryDirectory(prefix='singz-training-song-keys-') as temporary:
        root = Path(temporary).resolve()
        for name in ('prefs', 'library', 'cache', 'tmp'):
            (root / name).mkdir()
        immutable = {}
        projects = []
        for name, key in (('known', {'pc': 11, 'minor': True, 'detVersion': 2}),
                          ('unknown', {'pc': 4, 'minor': False, 'detVersion': 1})):
            project = root / 'library' / name
            (project / 'stems').mkdir(parents=True)
            tone(project / 'stems/vocals.wav', 48000, 12)
            (project / 'project.json').write_text(json.dumps({
                'version': 2, 'name': f'{name.title()} key fixture',
                'settings': {'transpose': 2, 'tempo': 1, 'masterVolume': 1, 'loop': False,
                    'tracks': {'vocals': {'volume': 1, 'muted': False, 'solo': False}},
                    'key': key, 'melody': {'detVersion': 4, 'hopSec': .025, 'f0': ' '.join(['2400'] * 480)}},
            }))
            (project / 'lyrics.json').write_text(json.dumps({'source': 'edited', 'lines': [
                {'start': 0, 'end': 4, 'text': 'Prepare for this song'},
                {'start': 4, 'end': 8, 'text': 'Return with the song paused'},
                {'start': 8, 'end': 12, 'text': 'Play only after an explicit action'},
            ]}))
            for path in project.rglob('*'):
                if path.is_file():
                    immutable[str(path.relative_to(root))] = shared.sha(path)
            projects.append(project)
        safety_pcm = root / 'a3.wav'
        tone(safety_pcm, 16000, 1, 8000)
        immutable['a3.wav'] = shared.sha(safety_pcm)
        preferences = {'formatVersion': 1, 'preferences': {
            'formatVersion': 2, 'tonicPc': 0, 'keyMode': 'major', 'exercise': 'note',
            'length': 1, 'range': {'lowMidi': 48, 'highMidi': 72}, 'notation': 'note-names',
            'taskMode': 'imitate', 'direction': 'both', 'intervalSizes': [2, 3, 4, 5, 6, 7, 8],
            'chordDegrees': [1, 2, 3, 4, 5, 6, 7],
        }}
        (root / 'prefs/training-preferences.json').write_text(json.dumps(preferences))
        catalog = root / 'catalog.json'
        catalog.write_text(json.dumps({'flavor': 'linux', 'entries': []}))
        immutable['catalog.json'] = shared.sha(catalog)
        inputs = out / 'fixture-input'
        inputs.mkdir()
        shutil.copytree(root / 'library', inputs / 'library')
        shutil.copy2(safety_pcm, inputs / 'a3.wav')
        (inputs / 'training-preferences.json').write_text(json.dumps(preferences, indent=2))
        env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_')}
        env.update(
            SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
            SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_CONFIG_DIR=str(root / 'prefs'),
            SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'), SINGZ_GPUI_MODEL_FIXTURE=str(catalog),
            SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
            SINGZ_LLAMA_SERVER=str(root / 'missing-llama'), SINGZ_CRISPASR=str(root / 'missing-crispasr'),
            SINGZ_GPUI_CAPTURE_FIXTURE=str(safety_pcm), SINGZ_GPUI_TEST_PROJECT=str(projects[0]),
            SINGZ_GPUI_UNKNOWN_PROJECT=str(projects[1]), SINGZ_GPUI_TRAINING_SONG_KEYBOARD_TEST=str(out),
            TMPDIR=str(root / 'tmp'), XDG_CACHE_HOME=str(root / 'cache'),
            HF_HOME=str(root / 'cache/huggingface'), TORCH_HOME=str(root / 'cache/torch'),
            PYTHONDONTWRITEBYTECODE='1',
        )
        try:
            observation = shared.run_observed(app, out, env, args.timeout, expect_input_helper=False)
            result = json.loads((out / 'training-song-keyboard.json').read_text())
            for flag in FLAGS:
                assert result[flag] is True, flag
            assert result['hardwareInput'] is False and result['liveFps'] == 'unmeasured', result
            assert result['pcmReplayUsed'] is False and result['chosenRange'] == [49, 73] and result['task'] == 'Identify', result
            assert result['recipeLengths'] == {'Chords': 6, 'Mixed': 8, 'Intervals': 6, 'Notes': 6}, result
            assert len(result['receipts']) == 10, 'Five native lifecycle receipts required per viewport'
            for width, height in ((1280, 800), (1060, 640)):
                check_receipts(result, [width, height])
                from PIL import Image
                for phase in CAPTURES:
                    name = f'training-song-{phase}-{width}'
                    row = json.loads((out / f'{name}.state.json').read_text())
                    check_state(row)
                    assert row['viewport'] == [width, height], row
                    scale = row['scale']
                    assert isinstance(scale, (int, float)) and not isinstance(scale, bool) and math.isfinite(scale) and scale > 0, row
                    with Image.open(out / f'{name}.png') as image:
                        assert list(image.size) == row['raster'] == [round(width * scale), round(height * scale)], row
            steps = json.loads((out / 'keyboard-steps.json').read_text())
            assert steps, 'Actual keyboard actions were not recorded'
            for row in steps:
                check_state(row)
            assert shared.sha(app) == app_hash, 'Application changed during qualification'
            for name, digest in immutable.items():
                assert shared.sha(root / name) == digest, f'Immutable fixture changed: {name}'
            (out / 'fixture.json').write_text(json.dumps({
                'passed': True, 'applicationSha256': app_hash, 'inputs': immutable,
                'resourceSampleCount': len(observation['samples']), 'hardwareInput': False,
                'pcmPurpose': 'Safety replay only; no input helper may open in this Identify journey',
                'catalogPurpose': 'Empty model catalog suppresses installation UI, not Linux qualification',
                'liveFps': 'unmeasured', 'scope': 'Loaded-song native preparation and explicit paused playback return',
            }, indent=2))
        except BaseException:
            shutil.copytree(root / 'prefs', out / 'failure-preferences', dirs_exist_ok=True)
            raise
    print('PASS: hidden native song recipe keys, six-prompt Identify and paused song return')


if __name__ == '__main__':
    main()
