"""C-70/C-71 a1: hidden redraw-gating and lane-render counters; requires a ui-tests build (macOS).

Usage: python3 test_native_idle_redraw.py APP OUTPUT
Drives the hidden perf scenario (request/receipt files) with a simulated ~120 Hz
display link and asserts, from the app's own counters:
  * an idle library, a paused player and an open modal each demand 0 frames (2 s
    quick check and 60 s N5 runs), counted from the window's own dirty state and
    pending next-frame callbacks, so nested entities are included;
  * the output meter decays to rest after Pause and then demands nothing;
  * a pan/zoom/resize sweep during playback causes 0 main-thread waveform rebuilds;
  * replaced and evicted waveform textures are released and the live count stays bounded;
  * steady playback allocates nothing inside lane and playhead paint.
"""
import argparse
import json
import math
import os
from pathlib import Path
import platform
import struct
import subprocess
import tempfile
import time
import wave

LANE_SLOTS = 6
LIVE_TEXTURE_BOUND = 3 * LANE_SLOTS  # base + two progress layers per lane slot


def write_project(root, name, seconds=40):
    project = root / 'library' / name
    (project / 'stems').mkdir(parents=True)
    for stem, hz in (('vocals', 220), ('bass', 110), ('drums', 330)):
        with wave.open(str(project / 'stems' / f'{stem}.wav'), 'wb') as audio:
            audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            second = b''.join(struct.pack('<h', round(9000 * math.sin(i * math.tau * hz / 16000) * (0.3 + 0.7 * abs(math.sin(i / 4000))))) for i in range(16000))
            audio.writeframes(second * seconds)
    (project / 'project.json').write_text(json.dumps({'version': 2, 'name': name, 'settings': {}}))
    return project


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    app, out = args.app.resolve(), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    assert platform.system() == 'Darwin', 'Windows field-laptop qualification is a human run'
    helper = app.with_name('singz-gpui-audio')
    assert app.is_file() and helper.is_file()
    child = None
    failures = []
    report = {}
    try:
        with tempfile.TemporaryDirectory(prefix='singz-c70-idle-') as temporary:
            root = Path(temporary)
            project, second = write_project(root, 'Gate'), write_project(root, 'Gate Two')
            scenario, config = root / 'scenario', root / 'config'
            scenario.mkdir()
            config.mkdir()
            environment = {key: value for key, value in os.environ.items() if not key.startswith('SINGZ_')}
            environment.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_GPUI_BACKGROUND='1',
                SINGZ_GPUI_TEST_NO_CAPTURE='1', SINGZ_GPUI_CONFIG_DIR=str(config),
                SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'), SINGZ_GPUI_TEST_PROJECT=str(project),
                SINGZ_GPUI_PERF_SECOND_PROJECT=str(second), SINGZ_GPUI_PERF_SCENARIO=str(scenario),
                SINGZ_GPUI_AUDIO_HELPER=str(helper), SINGZ_PERF_STEP_TIMEOUT='30',
                SINGZ_PERF_BURST_SECONDS='3', SINGZ_PERF_CYCLES='4', SINGZ_PERF_CYCLE_DELAY='0.2')
            with (out / 'app.log').open('w') as log:
                child = subprocess.Popen([str(app)], env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)

                def action(name, budget=40, **arguments):
                    receipt = scenario / 'receipt.json'
                    receipt.unlink(missing_ok=True)
                    temporary_request = scenario / 'request.tmp'
                    temporary_request.write_text(json.dumps({'action': name, **arguments}))
                    temporary_request.rename(scenario / 'request.json')
                    deadline = time.monotonic() + budget
                    while not receipt.exists():
                        assert child.poll() is None, f'app exited during {name}; see {out}/app.log'
                        assert time.monotonic() < deadline, f'{name} step deadline exceeded'
                        time.sleep(.005)
                    value = json.loads(receipt.read_text())
                    assert value['action'] == name and value['completed'], value
                    return value['detail']

                def check(condition, message):
                    if not condition:
                        failures.append(message)

                def delta(before, after, key):
                    return after[key] - before[key]

                action('launch')
                library = action('idle-window', settleSeconds=2, seconds=2)
                report['idleLibrary'] = library
                check(library['demandedFrames'] == 0, f'idle library demanded {library["demandedFrames"]} frames in 2 s (want 0)')

                library60 = action('idle-window', budget=120, settleSeconds=2, seconds=60)
                report['idleLibrary60s'] = library60
                check(library60['demandedFrames'] == 0, f'idle library demanded {library60["demandedFrames"]} frames in 60 s (want 0)')

                action('open')
                paused = action('idle-window', settleSeconds=3, seconds=2)
                report['pausedPlayer'] = paused
                check(paused['demandedFrames'] == 0, f'paused player demanded {paused["demandedFrames"]} frames in 2 s (want 0)')

                paused60 = action('idle-window', budget=120, settleSeconds=2, seconds=60)
                report['pausedPlayer60s'] = paused60
                check(paused60['demandedFrames'] == 0, f'paused player demanded {paused60["demandedFrames"]} frames in 60 s (want 0)')

                action('open-modal')
                modal60 = action('idle-window', budget=120, settleSeconds=2, seconds=60)
                report['modalOpen60s'] = modal60
                check(modal60['demandedFrames'] == 0, f'modal open demanded {modal60["demandedFrames"]} frames in 60 s (want 0)')
                action('close-modal')

                warm = action('render-metrics')
                action('play')
                action('steady-playback', settleSeconds=1, seconds=1)  # warm-up: scene and queue capacities
                before = action('render-metrics')
                steady = action('steady-playback', seconds=2)
                after = action('render-metrics')
                report['steadyPlayback'] = {'window': steady, 'before': before, 'after': after}
                check(steady['demandedFrames'] > 100, f'playback demanded only {steady["demandedFrames"]} frames in 2 s')
                check(delta(before, after, 'lanePlayheadPaintAllocations') == 0,
                      f'steady playback allocated {delta(before, after, "lanePlayheadPaintAllocations")} times inside lane/playhead paint (want 0)')
                check(delta(before, after, 'mainThreadRasterizations') == 0 and delta(before, after, 'waveformCacheMisses') == 0,
                      f'steady playback rebuilt waveform layers: {before} -> {after}')

                action('burst', budget=60)  # warm-up sweep
                before = action('render-metrics')
                burst = action('burst', budget=60)
                after = action('render-metrics')
                report['sweep'] = {'burst': burst, 'before': before, 'after': after}
                check(burst['iterations'] > 3, f'sweep ran only {burst["iterations"]} iterations')
                check(delta(before, after, 'mainThreadRasterizations') == 0,
                      f'pan/zoom/resize sweep rebuilt waveforms on the main thread {delta(before, after, "mainThreadRasterizations")} times (want 0)')
                check(after['liveTextures'] <= LIVE_TEXTURE_BOUND,
                      f'{after["liveTextures"]} live waveform textures after the sweep (bound {LIVE_TEXTURE_BOUND})')
                check(delta(before, after, 'textureReleases') > 0 or delta(before, after, 'textureAllocations') == 0,
                      'replacement rasters were allocated during the sweep but no texture was released')
                action('pause')
                # The muted fixture reports no output level, so leave the meter loud
                # as it would be after real playback and require it to settle on its own.
                action('seed-meter', held=1.0)
                loud = action('output-meter')
                report['meterSeeded'] = loud
                check(loud['heldNativePeak'] > 0, f'precondition: meter was not seeded: {loud}')
                pause_before = action('render-metrics')
                after_pause = action('idle-window', settleSeconds=3, seconds=2)
                report['afterPauseMetrics'] = {'before': pause_before, 'after': action('render-metrics')}
                resting = action('output-meter')
                report['afterPause'] = {'window': after_pause, 'meter': resting}
                check(resting['heldNativePeak'] == 0, f'output meter stuck at {resting["heldNativePeak"]} after Pause (want 0)')
                check(after_pause['demandedFrames'] == 0, f'{after_pause["demandedFrames"]} frames demanded 3-5 s after Pause (want 0)')

                before = action('render-metrics')
                action('cycles', budget=120)
                action('draw')
                action('idle-window', settleSeconds=2, seconds=1)
                after = action('render-metrics')
                report['eviction'] = {'before': before, 'after': after}
                check(delta(before, after, 'textureReleases') > 0, 'project switches released no waveform textures')
                check(after['liveTextures'] <= LIVE_TEXTURE_BOUND,
                      f'{after["liveTextures"]} live waveform textures after project switches (bound {LIVE_TEXTURE_BOUND})')
                action('quit')
                child.wait(timeout=30)
                child = None
    finally:
        if child is not None and child.poll() is None:
            os.killpg(child.pid, 9)
    report['failures'] = failures
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    assert not failures, '; '.join(failures)
    print('OK', out / 'report.json')


if __name__ == '__main__':
    main()
