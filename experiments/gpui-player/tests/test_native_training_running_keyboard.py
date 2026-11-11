"""Hidden running/summary keyboard journey with native cues and private PCM replay.

Uses the same strict process/resource observer as the Home/setup keyboard check.
No physical microphone, foreground input, user profile or audible output is used.
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
    'actualHeaderTab', 'actualSetupKeys', 'identifyEnter', 'identifySpace',
    'singleAnswerReceipt', 'answerFocusRecovery', 'summaryRestart', 'summaryBack',
    'nativeReplayFreshGeneration', 'nativeSkipReceipt', 'replayCaptureFixture',
    'headerBoundary', 'headerPause', 'keyboardContinue', 'keyboardExit',
    'pointerAfterKeyboard', 'endedOwnersReleased', 'answerFamilies', 'historyAndSummaryScroll',
    'saveRetryKeyboard',
)
CAPTURES = ('answer', 'summary', 'replay', 'skip', 'paused', 'exit', 'interval-last')
PHASES = (
    'identify-enter-summary', 'identify-space-summary', 'replay-respond-before',
    'replay-fresh-cue', 'replay-respond-after', 'skipped-summary', 'header-paused',
    'continued-respond', 'ended',
)


def check_state(row):
    assert row['hidden'] is True and row['active'] is False, row
    assert row['hardwareInput'] is False and row['playing'] is False, row
    keyboard = row['keyboard']
    focused = keyboard['focusedControl']
    if focused is None:
        return
    assert keyboard['focusInside'] is True and focused in keyboard['focusOrder'], row
    bounds = keyboard['focusedBounds']
    assert isinstance(bounds, list) and len(bounds) == 4, row
    assert all(isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) for n in bounds), row
    x, y, width, height = bounds
    assert x >= -1 and y >= -1 and width > 0 and height > 0, row
    assert x + width <= row['viewport'][0] + 1 and y + height <= row['viewport'][1] + 1, row


def check_receipts(result):
    receipts = result['receipts']
    assert len(receipts) == len(PHASES) * 2, 'Missing native lifecycle receipts'
    for width, height in ((1280, 800), (1060, 640)):
        states = {}
        for phase in PHASES:
            matching = [r for r in receipts if r['phase'] == phase and r['viewport'] == [width, height]]
            assert len(matching) == 1, (phase, width, matching)
            states[phase] = matching[0]
            check_state(matching[0])
        for phase in ('identify-enter-summary', 'identify-space-summary'):
            row = states[phase]
            assert row['practice']['phase'] == 'Summary' and row['practice']['correct'] == 1, row
            assert row['practice']['promptCount'] == row['practice']['resultCount'] == 1, row
            assert row['practice']['responses'][0]['kind'] == 'identify' and row['practice']['responses'][0]['correct'] is True, row
            assert row['capture']['phase'] == 'Off' and row['micIntent'] is False and row['ownersReleased'] is True, row
        before, replay, after = (states[p] for p in ('replay-respond-before', 'replay-fresh-cue', 'replay-respond-after'))
        for row in (before, after):
            assert row['practice']['phase'] == 'Respond' and row['practice']['targetMidi'] == [57], row
            assert row['capture']['owner'] == 4 and row['capture']['fixture'] is True and row['capture']['generation'] > 0, row
            assert row['micIntent'] is True, row
        assert replay['cue']['generation'] > before['cue']['generation'] and replay['cue']['generation'] == replay['trainingGeneration'], replay
        assert replay['cue']['notes'] and replay['cue']['notes'][0]['midi'] == 57, replay
        assert int(replay['cue']['endHostNs']) - int(replay['cue']['startHostNs']) == 2_750_000_000, replay
        skip = states['skipped-summary']
        assert skip['practice']['phase'] == 'Summary' and skip['practice']['resultCount'] == 1 and skip['practice']['correct'] == 0, skip
        assert skip['practice']['responses'][0]['kind'] == 'skipped' and skip['ownersReleased'] is True, skip
        paused = states['header-paused']
        assert paused['practice']['phase'] == 'Paused' and paused['ownersReleased'] is True, paused
        continued = states['continued-respond']
        assert continued['practice']['phase'] == 'Respond' and continued['practice']['targetMidi'] == [57], continued
        assert continued['capture']['phase'] == 'Off' and continued['micIntent'] is False, continued
        assert continued['cue']['generation'] > paused['trainingSerial'], continued
        ended = states['ended']
        assert ended['practice'] is None and ended['ownersReleased'] is True and ended['capture']['phase'] == 'Off', ended


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--timeout', type=int, default=300)
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('Strict foreground and process observation currently requires macOS')
    if not 30 <= args.timeout <= 600:
        parser.error('--timeout must be between 30 and 600 seconds')
    app, out = args.app.resolve(strict=True), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    assert not any(out.iterdir()), 'Use a fresh OUT directory'
    app_hash = shared.sha(app)
    with tempfile.TemporaryDirectory(prefix='singz-training-running-keys-') as temporary:
        root = Path(temporary).resolve()
        for name in ('prefs', 'library', 'tmp', 'cache'):
            (root / name).mkdir()
        audio_file = root / 'a3.wav'
        with wave.open(str(audio_file), 'wb') as audio:
            audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            audio.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(index * math.tau * 220 / 16000))) for index in range(16000)))
        audio_hash = shared.sha(audio_file)
        preferences = {'formatVersion': 1, 'preferences': {
            'formatVersion': 2, 'tonicPc': 0, 'keyMode': 'major', 'exercise': 'note',
            'length': 1, 'range': {'lowMidi': 48, 'highMidi': 72}, 'notation': 'note-names',
            'taskMode': 'imitate', 'direction': 'both', 'intervalSizes': [2, 3, 4, 5, 6, 7, 8],
            'chordDegrees': [1, 2, 3, 4, 5, 6, 7],
        }}
        (root / 'prefs/training-preferences.json').write_text(json.dumps(preferences))
        catalog = root / 'catalog.json'
        catalog.write_text(json.dumps({'flavor': 'linux', 'entries': []}))
        catalog_hash = shared.sha(catalog)
        (out / 'fixture-input').mkdir()
        shutil.copy2(audio_file, out / 'fixture-input/a3.wav')
        (out / 'fixture-input/training-preferences.json').write_text(json.dumps(preferences, indent=2))
        env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_')}
        env.update(
            SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
            SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_CONFIG_DIR=str(root / 'prefs'),
            SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'), SINGZ_GPUI_MODEL_FIXTURE=str(catalog),
            SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
            SINGZ_LLAMA_SERVER=str(root / 'missing-llama'), SINGZ_CRISPASR=str(root / 'missing-crispasr'),
            SINGZ_GPUI_CAPTURE_FIXTURE=str(audio_file), SINGZ_GPUI_TRAINING_RUNNING_KEYBOARD_TEST=str(out),
            TMPDIR=str(root / 'tmp'), XDG_CACHE_HOME=str(root / 'cache'),
            HF_HOME=str(root / 'cache/huggingface'), TORCH_HOME=str(root / 'cache/torch'),
            PYTHONDONTWRITEBYTECODE='1',
        )
        try:
            observer = shared.run_observed(app, out, env, args.timeout)
            result = json.loads((out / 'training-running-keyboard.json').read_text())
            for flag in FLAGS:
                assert result[flag] is True, flag
            assert result['coveredKinds'] == ['Note', 'Degree', 'Interval', 'Chord', 'Arpeggio'], result
            assert result['hardwareInput'] is False and result['pcmReplay'] is True and result['liveFps'] == 'unmeasured', result
            check_receipts(result)
            from PIL import Image
            for width, height in ((1280, 800), (1060, 640)):
                for phase in CAPTURES:
                    name = f'training-running-{phase}-{width}'
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
                if 'context' in row:
                    assert row['context'] in ('summary-reading', 'progress-reading'), row
                    for phase in ('before', 'end', 'home'):
                        check_state(row[phase])
                    end = row['end']['keyboard']
                    maximum = end['scrollMaxOffset'][1]
                    assert abs(end['scrollOffset'][1] + maximum) < 1, row
                    assert abs(row['home']['keyboard']['scrollOffset'][1]) < 1, row
                    assert row['overflowObserved'] == (end['scrollOffset'][1] < -1), row
                else:
                    check_state(row)
                    if row['phase'] in ('save-retry-home-boundary', 'save-retry-running-boundary'):
                        assert row['trainingStore']['preferenceError'], row
                        assert row['keyboard']['focusOrder'][0] == 'training-save-retry', row
                        assert row['headerFocused'] is not None and row['keyboard']['focusInside'] is False, row
                    elif row['phase'] == 'save-retry-cleared-focus-recovery':
                        assert all(row['trainingStore'][name] is None for name in ('preferenceError', 'completionError', 'loadError')), row
                        assert 'training-save-retry' not in row['keyboard']['focusOrder'], row
                        assert row['keyboard']['focusedControl'] == row['keyboard']['focusOrder'][0], row
            for viewport in ([1280, 800], [1060, 640]):
                phases = {row['phase'] for row in steps if row.get('viewport') == viewport}
                assert {f'all-{kind}-answers-reachable' for kind in result['coveredKinds']} <= phases, (viewport, phases)
                assert {'run-tab-reversal', 'save-retry-home-boundary', 'save-retry-running-boundary', 'save-retry-cleared-focus-recovery'} <= phases, (viewport, phases)
                assert {'summary-reading', 'progress-reading'} <= {
                    row['context'] for row in steps if row.get('before', {}).get('viewport') == viewport
                }, viewport
            assert shared.sha(app) == app_hash and shared.sha(audio_file) == audio_hash and shared.sha(catalog) == catalog_hash, 'An immutable fixture changed'
            (out / 'fixture.json').write_text(json.dumps({
                'passed': True, 'applicationSha256': app_hash, 'inputSha256': audio_hash,
                'modelCatalogSha256': catalog_hash, 'hardwareInput': False, 'pcmReplay': True,
                'catalogPurpose': 'Empty model fixture suppresses installation UI; flavor is not a Linux qualification',
                'liveFps': 'unmeasured', 'resourceSampleCount': len(observer['samples']),
                'scope': 'Native running and summary keyboard flow, muted generated PCM replay; no physical or audible audio qualification',
            }, indent=2))
        except BaseException:
            shutil.copytree(root / 'prefs', out / 'failure-preferences', dirs_exist_ok=True)
            raise
    print('PASS: hidden native Training running/summary keyboard, replay/skip and owner retirement')


if __name__ == '__main__':
    main()
