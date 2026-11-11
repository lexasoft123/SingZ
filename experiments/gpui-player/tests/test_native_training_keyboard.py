"""Hidden native Training keyboard journey with PCM replay, never physical input.

The short saved preference is an explicit private fixture; keyboard actions drive
production controls and real native cue/CREPE/scoring owners. This macOS observer
qualifies neither audible output, physical microphone hardware nor live FPS.
"""
import argparse
import errno
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import wave

sys.dont_write_bytecode = True


def sibling(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


perf = sibling('training_keyboard_perf', 'interface-perf.py')
processes = sibling('training_keyboard_processes', 'test_native_lyrics_live.py')
foreground = sibling('training_keyboard_foreground', 'test_native_lyrics_real.py').foreground


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def run_observed(app,folder,env,timeout,*,expect_input_helper=True,sample_interval=.5,poll_interval=.2):
    """Observe owned identities and resources; screenshots do not qualify live FPS."""
    mac=platform.system()=='Darwin'
    front=lambda:foreground() if mac else {'available':False,'reason':'Foreground observation unavailable on this platform'}
    before=front();fronts=[];owners={};samples=[];errors=[];rejected=[];terminal_discards=[]
    started=time.monotonic();previous=None;next_sample=started
    with (folder/'app.log').open('w') as log:
        child=subprocess.Popen([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            while child.poll() is None:
                assert time.monotonic()-started<timeout,'Native Training keyboard UI timeout'
                if mac:
                    table=processes.process_table();active={child.pid}|{row['pid'] for row in owners.values() if processes.same_process(row,table.get(row['pid']))}
                    changed=True
                    while changed:
                        changed=False
                        for row in table.values():
                            if row['pid'] in active or row['parent'] in active:
                                owners[(row['pid'],row['start'],row['command'])]=row
                                if row['pid'] not in active:active.add(row['pid']);changed=True
                    fronts.append(front())
                    def confirmed_terminal():
                        if child.poll() is not None:return True
                        try:child.wait(timeout=.1)
                        except subprocess.TimeoutExpired:return False
                        return True
                    if time.monotonic()>=next_sample:
                        next_sample=time.monotonic()+sample_interval
                        raw={'pid':child.pid,'previousCpuNanoseconds':previous[0] if previous else None,'previousSampleMonotonic':previous[1] if previous else None}
                        try:
                            cpu,memory=perf.process_usage(child.pid);now=time.monotonic()
                            raw.update(cpuNanoseconds=cpu,footprintBytes=memory,sampleMonotonic=now,elapsedSeconds=now-started)
                            percent=(cpu-previous[0])/(1e9*(now-previous[1]))*100 if previous is not None else None
                            raw['cpuPercent']=percent
                            valid=math.isfinite(cpu) and cpu>=0 and memory>0 and (percent is None or math.isfinite(percent) and percent>=0)
                            if not valid:
                                record={'reason':'Invalid CPU counter, CPU delta or footprint','rawReadback':raw,'processConfirmedTerminal':confirmed_terminal()};rejected.append(record)
                                if record['processConfirmedTerminal']:terminal_discards.append(record)
                                else:errors.append(record)
                                previous=None
                            else:
                                if percent is not None:samples.append({'elapsedSeconds':now-started,'cpuPercent':percent,'footprintBytes':memory,'gpuSystem':perf.gpu_usage()})
                                previous=(cpu,now)
                        except (OSError,RuntimeError) as error:
                            gone=isinstance(error,OSError) and error.errno in (errno.ESRCH,errno.ENOENT)
                            terminal=confirmed_terminal() if gone else False
                            record={'reason':str(error),'exceptionType':type(error).__name__,'errno':getattr(error,'errno',None),'rawReadback':raw,'processConfirmedTerminal':terminal};rejected.append(record)
                            if gone and terminal:terminal_discards.append(record)
                            else:errors.append(record)
                            previous=None
                time.sleep(poll_interval)
        finally:
            forced=child.poll() is None
            if forced:
                child.terminate()
                try:child.wait(timeout=5)
                except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
            remaining=[];survivors=[]
            if mac:
                deadline=time.monotonic()+8
                while True:
                    table=processes.process_table();remaining=[row for row in owners.values() if processes.same_process(row,table.get(row['pid']))]
                    if not remaining or time.monotonic()>=deadline:break
                    time.sleep(.2)
                survivors=list(remaining)
                for sig,delay in ((signal.SIGTERM,1),(signal.SIGKILL,0)):
                    table=processes.process_table()
                    for row in remaining:
                        if row['pid']!=child.pid and processes.same_process(row,table.get(row['pid'])):
                            try:os.kill(row['pid'],sig)
                            except ProcessLookupError:pass
                    if delay and remaining:time.sleep(delay)
                    table=processes.process_table();remaining=[row for row in remaining if processes.same_process(row,table.get(row['pid']))]
            after=front();observations=[before,*fronts,after]
            available=all(row.get('available') for row in observations)
            stable=available and all(row['identity']==before['identity'] for row in observations)
            helpers=[row for row in owners.values() if row['command'].endswith('singz-gpui-audio')]
            inputs=[row for row in owners.values() if row['command'].endswith('singz-gpui-input')]
            observation={'foregroundUnchanged':stable if mac else None,'foregroundScope':'continuous available macOS identity observations' if mac else 'unqualified',
                'samples':samples,'errors':errors,'rejectedSamples':rejected,'terminalDiscardCount':len(terminal_discards),'terminalDiscards':terminal_discards,
                'liveFps':'unmeasured','scope':'app CPU/footprint only; helper CPU excluded; GPU system-wide','observedHelpersRetired':[row['pid'] for row in helpers],'observedInputHelpersRetired':[row['pid'] for row in inputs],
                'summary':{'cpuPercent':perf.summarize([row['cpuPercent'] for row in samples]),'footprintBytes':perf.summarize([row['footprintBytes'] for row in samples]),
                    'systemGpuAvailableSamples':sum(row['gpuSystem'].get('available') is True for row in samples),'systemGpuUnavailableReasons':sorted({row['gpuSystem'].get('reason','unavailable') for row in samples if row['gpuSystem'].get('available') is not True}),'performanceVerdict':'Resource observations only; live display cadence unqualified'}}
            (folder/'observer.json').write_text(json.dumps(observation,indent=2))
            (folder/'foreground.json').write_text(json.dumps({'before':before,'after':after,'samples':fronts,'allAvailable':available,'unchanged':stable},indent=2))
            (folder/'process-exit.json').write_text(json.dumps({'pid':child.pid,'terminal':True,'returncode':child.returncode,'forcedStop':forced,'wallSeconds':time.monotonic()-started,'observed':list(owners.values()),'survivorsBeforeCleanup':survivors,'survivorsAfterCleanup':remaining,'scope':'recursive observed process identities' if mac else 'app process only; helper retirement unqualified'},indent=2))
    assert child.returncode==0 and not forced,(folder/'app.log').read_text()[-8000:]
    if mac:
        assert helpers,'No real native audio helper was observed'
        if expect_input_helper:
            assert inputs,'No real replay input/CREPE helper was observed'
        else:
            assert not inputs,'Identify-only journey unexpectedly opened an input helper'
        assert owners and not survivors and not remaining,'Observed native process failed natural retirement'
        assert stable,'Hidden test changed foreground or foreground identity was unavailable'
        assert samples and not errors,'Invalid live CPU/GPU resource observation'
    return observation



def check_focus(state):
    keyboard = state['keyboard']
    focused = keyboard['focusedControl']
    if focused is None:
        return
    assert keyboard['focusInside'] is True, state
    bounds = keyboard['focusedBounds']
    assert isinstance(bounds, list) and len(bounds) == 4, state
    assert all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in bounds), state
    left, top, width, height = bounds
    assert width > 0 and height > 0 and left >= -1 and top >= -1, state
    assert left + width <= state['viewport'][0] + 1 and top + height <= state['viewport'][1] + 1, state
    viewport = keyboard['stickyFooterBounds'] if focused in ('training-start', 'training-length') else keyboard['viewportBounds']
    if viewport is not None:
        assert top >= viewport[1] - 1 and top + height <= viewport[1] + viewport[3] + 1, state


def check_native_receipts(result):
    receipts = result['receipts']
    assert len(receipts) == 10, 'Expected five native lifecycle receipts per viewport'
    for width, height in ((1280, 800), (1060, 640)):
        phases = {}
        for phase in ('c4-completed', 'vocal-replay-respond', 'vocal-summary', 'identify-summary', 'ended'):
            matches = [row for row in receipts if row['phase'] == phase and row['viewport'] == [width, height]]
            assert len(matches) == 1, (phase, width, matches)
            row = phases[phase] = matches[0]
            assert row['hidden'] is True and row['active'] is False and row['screenTraining'] is True, row
            assert row['projectLoaded'] is False and row['playing'] is False and row['hardwareInput'] is False, row
            if phase != 'vocal-replay-respond':
                assert row['ownersReleased'] is True and row['capture']['phase'] == 'Off', row
                assert row['micIntent'] is False and row['trainingGeneration'] is None, row
                assert row['trainingStopped'] >= row['trainingSerial'], row
        c4 = phases['c4-completed']
        assert c4['practice'] is None and c4['cue']['generation'] > 0, c4
        assert len(c4['cue']['notes']) == 1 and c4['cue']['notes'][0]['midi'] == 60, c4
        assert int(c4['cue']['endHostNs']) - int(c4['cue']['startHostNs']) == 2_750_000_000, c4
        responding = phases['vocal-replay-respond']
        assert responding['practice']['phase'] == 'Respond' and responding['practice']['targetMidi'] == [57], responding
        assert responding['capture']['owner'] == 4 and responding['capture']['fixture'] is True, responding
        assert responding['capture']['generation'] > 0 and responding['capture']['phase'] != 'Off', responding
        assert responding['micIntent'] is True, responding
        for phase, kind in (('vocal-summary', 'vocal'), ('identify-summary', 'identify')):
            row = phases[phase]
            run = row['practice']
            assert run['phase'] == 'Summary' and run['targetMidi'] == [57], row
            assert run['promptCount'] == run['resultCount'] == run['correct'] == 1, row
            assert len(run['responses']) == 1 and run['responses'][0]['kind'] == kind, row
            if kind == 'vocal':
                # Vocal correctness comes from per-target classifications; the
                # optional binary receipt verdict belongs to Identify answers.
                assert run['responses'][0]['correct'] is None, row
                targets = run['responses'][0]['targets']
                assert len(targets) == 1 and targets[0]['classification'] == 'OnTarget', row
                voiced, midi = targets[0]['voicedCoverage'], targets[0]['detectedMidi']
                assert isinstance(voiced, (int, float)) and math.isfinite(voiced) and .85 < voiced <= 1, row
                assert isinstance(midi, (int, float)) and math.isfinite(midi) and abs(midi - 57) < .5, row
            else:
                assert run['responses'][0]['correct'] is True, row
        assert phases['ended']['practice'] is None, phases['ended']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--timeout', type=int, default=300)
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('Current strict process/foreground qualification requires macOS')
    if not 30 <= args.timeout <= 600:
        parser.error('--timeout must be between 30 and 600 seconds')
    app, out = args.app.resolve(strict=True), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    assert not any(out.iterdir()), 'Training keyboard tests require a fresh OUT'
    app_hash = sha(app)
    with tempfile.TemporaryDirectory(prefix='singz-training-keyboard-') as temporary:
        root = Path(temporary).resolve()
        for name in ('prefs', 'library', 'tmp', 'cache'):
            (root / name).mkdir()
        fixture = root / 'a3.wav'
        with wave.open(str(fixture), 'wb') as audio:
            audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            audio.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(index * math.tau * 220 / 16000)))
                                      for index in range(16000)))
        input_hash = sha(fixture)
        catalog = root / 'catalog.json'
        catalog.write_text(json.dumps({'flavor': 'linux', 'entries': []}))
        catalog_hash = sha(catalog)
        preferences = {
            'formatVersion': 1,
            'preferences': {
                'formatVersion': 2, 'tonicPc': 0, 'keyMode': 'major', 'exercise': 'note',
                'length': 1, 'range': {'lowMidi': 48, 'highMidi': 72},
                'notation': 'note-names', 'taskMode': 'imitate', 'direction': 'both',
                'intervalSizes': [2, 3, 4, 5, 6, 7, 8], 'chordDegrees': [1, 2, 3, 4, 5, 6, 7],
            },
        }
        preference_file = root / 'prefs/training-preferences.json'
        preference_file.write_text(json.dumps(preferences))
        (out / 'fixture-input').mkdir()
        shutil.copy2(fixture, out / 'fixture-input/a3.wav')
        (out / 'fixture-input/training-preferences.json').write_text(json.dumps(preferences, indent=2))
        env = {key: value for key, value in os.environ.items() if not key.startswith('SINGZ_')}
        env.update(
            SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
            SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_CONFIG_DIR=str(root / 'prefs'),
            SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'), SINGZ_GPUI_MODEL_FIXTURE=str(catalog),
            SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
            SINGZ_LLAMA_SERVER=str(root / 'missing-llama'), SINGZ_CRISPASR=str(root / 'missing-crispasr'),
            SINGZ_GPUI_CAPTURE_FIXTURE=str(fixture), SINGZ_GPUI_TRAINING_KEYBOARD_TEST=str(out),
            TMPDIR=str(root / 'tmp'), XDG_CACHE_HOME=str(root / 'cache'),
            HF_HOME=str(root / 'cache/huggingface'), TORCH_HOME=str(root / 'cache/torch'),
            PYTHONDONTWRITEBYTECODE='1',
        )
        fixture_record = {
            'applicationSha256': app_hash, 'inputSha256': input_hash,
            'modelCatalogSha256': catalog_hash, 'sampleRate': 16000, 'frames': 16000,
            'channels': 1, 'sampleWidthBytes': 2, 'frequencyHz': 220, 'seconds': 1,
            'hidden': True, 'muted': True, 'hardwareInput': False,
            'fixturePreparation': 'Private saved preferences select a one-prompt short exercise; production keyboard controls set C major and range A3–A#3 so A3 is the sole diatonic target. Only hardware input is replaced by looping PCM replay.',
            'seededPreferences': preferences, 'liveFps': 'unmeasured',
            'scope': 'Actual native owners with replay input; no physical microphone, audible output or platform parity qualification',
        }
        (out / 'fixture.json').write_text(json.dumps(fixture_record, indent=2))
        try:
            observation = run_observed(app, out, env, args.timeout)
            result = json.loads((out / 'training-keyboard.json').read_text())
            for flag in ('actualHeaderTab', 'exerciseCards', 'tabAndShiftTab',
                         'selectorsCommitCancel', 'typeahead', 'segmentsAndChips',
                         'rangeKeysAndLimits', 'focusedAutoscroll', 'setupKeysContained',
                         'testC4NativeCue', 'testC4WithoutCapture', 'actualStart',
                         'nativeCrepe', 'vocalOnTarget', 'summaryReleasesOwners',
                         'identifyWithoutCapture', 'identifyCorrect', 'endedOwnersReleased',
                         'selectorPopupAboveStickyFooter'):
                assert result.get(flag) is True, (flag, result)
            assert result['sizes'] == [[1280, 800], [1060, 640]]
            assert result['hardwareInput'] is False and result['pcmReplay'] is True
            assert result['liveFps'] == 'unmeasured'
            assert result['runningResponseControlsKeyboardTested'] is False
            assert isinstance(result['fixturePreparation'], str) and 'length1' in result['fixturePreparation']
            check_native_receipts(result)
            captures = list(out.glob('*.png'))
            assert len(captures) == 10, 'Expected exactly ten Training keyboard captures'
            from PIL import Image
            for width, height in ((1280, 800), (1060, 640)):
                for phase in ('home', 'setup', 'c4', 'summary', 'length-popup'):
                    name = f'training-keyboard-{phase}-{width}'
                    state = json.loads((out / f'{name}.state.json').read_text())
                    assert state['viewport'] == [width, height]
                    assert state['hidden'] is True and state['active'] is False
                    check_focus(state)
                    if phase == 'home':
                        assert state['keyboard']['focusedControl'] == 'training-exercise-0' and state['keyboard']['route'] == 'Home', state
                    elif phase == 'setup':
                        assert state['keyboard']['focusedControl'] == 'training-start' and state['keyboard']['route'] == 'Setup', state
                        config = state['keyboard']['config']
                        assert config['tonic'] == 0 and config['minor'] is False and config['task'] == 0, state
                        assert config['low'] == 57 and config['high'] == 58 and config['length'] == 1, state
                    elif phase == 'c4':
                        assert state['micIntent'] is False and state['capture']['phase'] == 'Off', state
                        assert state['cue']['generation'] == state['trainingGeneration'] > 0, state
                        assert len(state['cue']['notes']) == 1 and state['cue']['notes'][0]['midi'] == 60, state
                    elif phase == 'summary':
                        assert state['practice']['phase'] == 'Summary' and state['practice']['correct'] == 1 and state['ownersReleased'] is True, state
                    else:
                        keyboard = state['keyboard']
                        assert keyboard['focusedControl'] == keyboard['popup'] == 'training-length', state
                        popup, trigger = keyboard['popupBounds'], keyboard['focusedBounds']
                        assert isinstance(popup, list) and len(popup) == 4, state
                        assert all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in popup), state
                        x, y, popup_width, popup_height = popup
                        assert popup_width > 0 and popup_height > 0 and x >= -1 and y >= -1, state
                        assert x + popup_width <= width + 1 and y + popup_height <= height + 1, state
                        assert y + popup_height <= trigger[1] + 1, 'Length popup covers its sticky trigger'
                        options = keyboard['selectorOptions']['training-length']
                        assert options and keyboard['menuIndex'] == len(options) - 1, state
                    scale = state['scale']
                    assert isinstance(scale, (int, float)) and not isinstance(scale, bool) and math.isfinite(scale) and scale > 0
                    with Image.open(out / f'{name}.png') as image:
                        assert list(image.size) == state['raster'] == [round(width * scale), round(height * scale)]
            steps = json.loads((out / 'keyboard-steps.json').read_text())
            assert steps, 'No actual Training keyboard action records'
            for row in steps:
                assert row['hidden'] is True and row['active'] is False, row
                check_focus(row)
            for viewport in ([1280, 800], [1060, 640]):
                phases = {row['phase'] for row in steps if row['viewport'] == viewport}
                assert {'scale-disabled-task-recovery', 'actual-setup-controls', 'completed-viewport'} <= phases, (viewport, phases)
            assert sha(fixture) == input_hash, 'PCM replay fixture changed during qualification'
            assert sha(catalog) == catalog_hash, 'Private model catalog changed during qualification'
            assert sha(app) == app_hash, 'Application changed during qualification'
            fixture_record.update(observedProcesses=json.loads((out / 'process-exit.json').read_text())['observed'],
                                  resourceSampleCount=len(observation['samples']), passed=True)
            (out / 'fixture.json').write_text(json.dumps(fixture_record, indent=2))
        except BaseException:
            shutil.copytree(root / 'prefs', out / 'failure-preferences', dirs_exist_ok=True)
            raise
    print('PASS: hidden native Training keyboard controls, replay CREPE/scoring and owner release')


if __name__ == '__main__':
    main()
