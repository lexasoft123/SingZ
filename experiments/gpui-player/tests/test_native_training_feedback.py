"""Hidden EN/RU result acknowledgements with real Identify and vocal replay.

Only private supported preferences and generated PCM replace external input.
Cues, scoring, receipt publication, language controls and rendering stay native.
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
    'actualLocaleControls', 'persistedLengthTwo', 'actualWrongAndCorrectKeys',
    'noPrematureReveal', 'wrongFeedbackReveal', 'acknowledgementPersists',
    'currentAnswerHiddenAfterAdvance', 'finalSummaryAcknowledgement',
    'localizedTaskCopy', 'exactIdentifyReceipts', 'nativeCueReceipts',
    'nativeVocalOnTarget', 'replayOnlyInput', 'endedOwnersReleased',
)
CAPTURES = ('before', 'wrong-feedback', 'next-cue', 'next-respond',
            'identify-summary', 'vocal-summary', 'vocal-respond')


def check_bounds(bounds, viewport):
    assert isinstance(bounds, list) and len(bounds) == 4, bounds
    assert all(isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) for n in bounds), bounds
    x, y, width, height = bounds
    assert width > 0 and height > 0 and x >= -1 and y >= 51, bounds
    assert x + width <= viewport[0] + 1 and y + height <= viewport[1] + 1, (bounds, viewport)


def check_state(row, locale):
    assert row['hidden'] is True and row['active'] is False and row['hardwareInput'] is False, row
    assert row['projectLoaded'] is False and row['playing'] is False, row
    assert row['locale']['locale'] == row['locale']['language'] == locale, row
    assert row['localePending'] is False and row['localeError'] is None, row
    presentation = row['presentation']
    ack = presentation['acknowledgement'] if presentation is not None else None
    if ack is not None:
        for name in ('heading', 'detail'):
            assert isinstance(ack[name], str) and ack[name] and not ack[name].startswith('training.'), row
        assert ack['mark'] in ('→', '✓', '↗'), row
        if row.get('acknowledgementBounds') is not None:
            check_bounds(row['acknowledgementBounds'], row['viewport'])
    if row['capture']['phase'] != 'Off':
        assert row['capture']['owner'] == 4 and row['capture']['fixture'] is True, row


def check_receipts(result, viewport, locale):
    states = {}
    for phase in ('identify-summary', 'vocal-summary', 'ended'):
        rows = [r for r in result['receipts'] if r['phase'] == phase and r['viewport'] == viewport and r['locale']['locale'] == locale]
        assert len(rows) == 1, (phase, viewport, locale)
        row = states[phase] = rows[0]
        check_state(row, locale)
        assert row['ownersReleased'] is True and row['capture']['phase'] == 'Off' and row['micIntent'] is False, row
    identify = states['identify-summary']
    practice = identify['practice']
    assert practice['phase'] == 'Summary' and practice['promptCount'] == practice['resultCount'] == 2 and practice['correct'] == 1, identify
    responses = practice['responses']
    assert [r['promptIndex'] for r in responses] == [1, 2] and all(r['kind'] == 'identify' for r in responses), identify
    assert [r['correct'] for r in responses] == [False, True], identify
    assert responses[0]['answer'] == 'Note(0)', identify
    ack = identify['presentation']['acknowledgement']
    assert ack['promptIndex'] == 2 and ack['good'] is True and ack['mark'] == '✓' and ack['announce'] is False and ack['answer'], identify
    assert identify['presentation']['summary']['averageSignedCents'] is None, identify
    assert ack['heading'] in identify['presentation']['summary']['heading'], identify
    assert ack['answer'] in identify['presentation']['summary']['description'], identify
    vocal = states['vocal-summary']
    practice = vocal['practice']
    assert practice['phase'] == 'Summary' and practice['promptCount'] == practice['resultCount'] == practice['correct'] == 2, vocal
    for response in practice['responses']:
        assert response['kind'] == 'vocal' and response['correct'] is None and len(response['targets']) == 1, vocal
        target = response['targets'][0]
        assert target['classification'] == 'OnTarget' and .85 < target['voicedCoverage'] <= 1, vocal
        assert math.isfinite(target['detectedMidi']) and abs(target['detectedMidi'] - 57) < .5, vocal
    ack = vocal['presentation']['acknowledgement']
    assert ack['promptIndex'] == 2 and ack['good'] is True and ack['mark'] == '✓' and ack['answer'] is None, vocal
    signed = vocal['presentation']['summary']['averageSignedCents']
    assert isinstance(signed, (int, float)) and math.isfinite(signed), vocal
    assert vocal['presentation']['summary']['pitchCopy'] != identify['presentation']['summary']['pitchCopy'], (vocal, identify)
    assert states['ended']['practice'] is None, states['ended']


def validate_output(out):
    """Validate immutable native artifacts without rerunning their producer."""
    result = json.loads((out / 'training-feedback.json').read_text())
    for flag in FLAGS:
        assert result[flag] is True, flag
    assert result['distinctIdentifyTargets'] is True and result['identifyRange'] == [57, 59] and result['vocalRange'] == [57, 58], result
    assert result['hardwareInput'] is False and result['pcmReplay'] is True and result['liveFps'] == 'unmeasured', result
    assert result['replayRespondPrompts'] == 8 and len(result['receipts']) == 12, result
    from PIL import Image
    for width, height in ((1280, 800), (1060, 640)):
        for locale in ('en', 'ru'):
            check_receipts(result, [width, height], locale)
            for phase in CAPTURES:
                name = f'training-feedback-{phase}-{locale}-{width}'
                row = json.loads((out / f'{name}.state.json').read_text())
                check_state(row, locale)
                assert row['viewport'] == [width, height], row
                if phase == 'before':
                    assert row['presentation']['acknowledgement'] is None and row['presentation']['currentTargetText'] == '?', row
                elif phase in ('wrong-feedback', 'next-cue', 'next-respond'):
                    ack = row['presentation']['acknowledgement']
                    assert ack['promptIndex'] == 1 and ack['good'] is False and ack['answer'], row
                    if phase != 'wrong-feedback':
                        assert row['presentation']['currentTargetText'] == '?' and row['presentation']['currentAnswerHidden'] is True and ack['announce'] is False, row
                elif phase == 'vocal-respond':
                    ack = row['presentation']['acknowledgement']
                    assert row['practice']['phase'] == 'Respond' and row['practice']['promptIndex'] == 2, row
                    assert ack['promptIndex'] == 1 and ack['good'] is True and ack['answer'] is None, row
                    for bounds_name in ('acknowledgementBounds', 'runwayBounds', 'guidanceBounds', 'dockBounds'):
                        check_bounds(row[bounds_name], row['viewport'])
                    a, r, g, d = (row[name] for name in ('acknowledgementBounds', 'runwayBounds', 'guidanceBounds', 'dockBounds'))
                    assert a[1] + a[3] <= r[1] + 1 and g[1] + g[3] <= d[1] + 1, row
                    if row['recordingBarBounds'] is not None:
                        check_bounds(row['recordingBarBounds'], row['viewport'])
                assert isinstance(row['scale'], (int, float)) and math.isfinite(row['scale']) and row['scale'] > 0, row
                with Image.open(out / f'{name}.png') as image:
                    assert list(image.size) == row['raster'] == [round(width * row['scale']), round(height * row['scale'])], row
    steps = json.loads((out / 'feedback-steps.json').read_text())
    assert steps, 'Missing native progression records'
    for row in steps:
        check_state(row, row['locale']['locale'])
    return result


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
    with tempfile.TemporaryDirectory(prefix='singz-training-feedback-') as temporary:
        root = Path(temporary).resolve()
        for name in ('prefs', 'library', 'cache', 'tmp'):
            (root / name).mkdir()
        pcm = root / 'a3.wav'
        with wave.open(str(pcm), 'wb') as audio:
            audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            audio.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(i * math.tau * 220 / 16000))) for i in range(16000)))
        pcm_hash = shared.sha(pcm)
        preferences = {'formatVersion': 1, 'preferences': {
            'formatVersion': 2, 'tonicPc': 0, 'keyMode': 'major', 'exercise': 'note',
            'length': 2, 'range': {'lowMidi': 48, 'highMidi': 72}, 'notation': 'note-names',
            'taskMode': 'imitate', 'direction': 'both', 'intervalSizes': [2, 3, 4, 5, 6, 7, 8],
            'chordDegrees': [1, 2, 3, 4, 5, 6, 7],
        }}
        (root / 'prefs/training-preferences.json').write_text(json.dumps(preferences))
        catalog = root / 'catalog.json'
        catalog.write_text(json.dumps({'flavor': 'linux', 'entries': []}))
        catalog_hash = shared.sha(catalog)
        (out / 'fixture-input').mkdir()
        shutil.copy2(pcm, out / 'fixture-input/a3.wav')
        (out / 'fixture-input/training-preferences.json').write_text(json.dumps(preferences, indent=2))
        env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_')}
        env.update(
            SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
            SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_CONFIG_DIR=str(root / 'prefs'),
            SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'), SINGZ_GPUI_MODEL_FIXTURE=str(catalog),
            SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
            SINGZ_LLAMA_SERVER=str(root / 'missing-llama'), SINGZ_CRISPASR=str(root / 'missing-crispasr'),
            SINGZ_GPUI_CAPTURE_FIXTURE=str(pcm), SINGZ_GPUI_TRAINING_FEEDBACK_TEST=str(out),
            TMPDIR=str(root / 'tmp'), XDG_CACHE_HOME=str(root / 'cache'),
            HF_HOME=str(root / 'cache/huggingface'), TORCH_HOME=str(root / 'cache/torch'),
            PYTHONDONTWRITEBYTECODE='1',
        )
        try:
            observation = shared.run_observed(app, out, env, args.timeout)
            validate_output(out)
            assert shared.sha(app) == app_hash and shared.sha(pcm) == pcm_hash and shared.sha(catalog) == catalog_hash, 'Immutable application or fixture changed'
            (out / 'fixture.json').write_text(json.dumps({
                'passed': True, 'applicationSha256': app_hash, 'pcmSha256': pcm_hash,
                'modelCatalogSha256': catalog_hash, 'resourceSampleCount': len(observation['samples']),
                'physicalInput': False, 'pcmReplay': True, 'liveFps': 'unmeasured',
                'scope': 'Actual EN/RU Identify acknowledgement and native vocal replay scoring; live accessibility announcements and production visual parity unqualified',
            }, indent=2))
        except BaseException:
            shutil.copytree(root / 'prefs', out / 'failure-preferences', dirs_exist_ok=True)
            raise
    print('PASS: hidden localized native feedback, answer reveal and vocal summary')


if __name__ == '__main__':
    main()
