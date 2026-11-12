"""C-72 a1: lyric and pitch-strip paint does no per-frame work; requires a ui-tests build (macOS).

Usage: python3 test_native_lyric_pitch_paint.py APP OUTPUT [--negative-control]
Opens a fixture with a long intro, an inter-line gap, word-timed lyrics and a pitch
track, then sweeps the timeline at 120 Hz steps (paused, so every frame moves the
position) over three windows, each warmed first and then measured over 600 frames:
the intro (countdown captions before the first line), the sung words (active word,
feathered band, glow) and the gap between lines. A real-time playing window over the
intro adds the countdown cue itself. For every measured window it asserts, from the
app's own counters:
  * the lyric canvas and the pitch canvas each painted exactly once per frame, and
    the f0 trace was painted (and so its GPUI path allocations incurred) every frame;
  * 0 lyric shape-cache misses, 0 pitch label misses, 0 trace rebuilds;
  * 0 heap allocations inside lyric and pitch paint (counting allocator scoped to
    those two paints; GPUI's own `paint_path` and animation-frame requests are
    counted apart, `paint_path` at exactly 3 per trace paint);
  * advancing words and advancing-glow draws equal what the fixture timings predict
    for those positions (12 glow draws per advancing frame; none in the intro or gap);
  * the caches stay within bounds and a project change clears them.
`--negative-control` injects one allocation per lyric paint (SINGZ_C72_INJECT_ALLOC) and
requires the run to fail on the allocation assertion and on nothing else.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_native_idle_redraw import make_action, write_project  # noqa: E402

FRAMES = 600
# Half a frame off the word edges, so no sampled position sits on a boundary.
INTRO_SWEEP, WORD_SWEEP, GAP_SWEEP = 5.004, 13.004, 20.004
LINE_STARTS = (12.0, 27.5)  # a 12 s intro, then a gap of 8 s between the lines
WORDS_PER_LINE, WORD_STEP, WORD_LENGTH = 24, 0.3, 0.28
ANTICIPATION = 0.15  # the lyric panel paints this far ahead of the playhead
GLOW_DRAWS_PER_ADVANCING_FRAME = 12
TRACE_ALLOCATIONS_PER_PAINT = 3  # GPUI's paint_path: clone, scale, scene copy
LYRIC_CACHE_BOUND = 24576
PITCH_LABEL_BOUND = 512
ALLOCATION_FAILURE = 'heap allocations in lyric and pitch paint'
ROOT = Path(__file__).resolve().parents[3]


def expected_advancing_frames(start):
    """Frames of a sweep in which a word is partly sung, from the fixture's own timings."""
    words = [(line + WORD_STEP * k, line + WORD_STEP * k + WORD_LENGTH) for line in LINE_STARTS for k in range(WORDS_PER_LINE)]
    positions = [start + i / 120 + ANTICIPATION for i in range(FRAMES)]
    margin = min(abs(p - edge) for p in positions for word in words for edge in word)
    assert margin > 5e-4, f'sweep from {start} samples a word edge ({margin:.6f} s): f32 rounding could flip a count'
    return sum(any(s <= p < e for s, e in words) for p in positions)


def detector_version(header, name):
    text = (ROOT / 'zcore/include/zcore/legacy' / header).read_text()
    return int(re.search(rf'constexpr int {name}\s*=\s*(\d+)\s*;', text).group(1))


def write_fixture(root):
    """The idle-redraw fixture plus lyrics.json, a melody and a stored key."""
    project = write_project(root, 'Gate')
    lines = []
    for i, start in enumerate(LINE_STARTS):
        words = [{'w': f'word{i}x{k}', 's': round(start + WORD_STEP * k, 3), 'e': round(start + WORD_STEP * k + WORD_LENGTH, 3)} for k in range(WORDS_PER_LINE)]
        lines.append({'start': start, 'end': start + 7.5, 'text': ' '.join(w['w'] for w in words), 'words': words})
    (project / 'lyrics.json').write_text(json.dumps({'source': 'edited', 'lines': lines}))
    cents = []
    for note in range(80):  # 40 s at a 0.02 s hop: 20 voiced frames, 5 silent
        cents += [str(2400 + 100 * (0, 2, 4, 5, 7, 5, 4, 2)[note % 8])] * 20 + ['x5']
    settings = json.loads((project / 'project.json').read_text())
    settings['settings'].update({
        'melody': {'hopSec': 0.02, 'f0': ' '.join(cents), 'detVersion': detector_version('melody.h', 'kPitchDetectVersion')},
        'key': {'pc': 9, 'minor': True, 'detVersion': detector_version('analysis.h', 'kKeyDetectVersion')},
    })
    (project / 'project.json').write_text(json.dumps(settings))
    return project


def delta(before, after):
    return {key: after[key] - before[key] for key in after}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--negative-control', action='store_true', help='inject one allocation per lyric paint; the run must fail on that assertion alone')
    args = parser.parse_args()
    app, out = args.app.resolve(), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    assert platform.system() == 'Darwin', 'Windows field-laptop qualification is a human run'
    helper = app.with_name('singz-gpui-audio')
    assert app.is_file() and helper.is_file()
    failures, report, child = [], {}, None
    try:
        with tempfile.TemporaryDirectory(prefix='singz-c72-paint-') as temporary:
            root = Path(temporary)
            project, second = write_fixture(root), write_project(root, 'Gate Two')  # the second has no lyrics or pitch
            scenario, config = root / 'scenario', root / 'config'
            scenario.mkdir()
            config.mkdir()
            environment = {key: value for key, value in os.environ.items() if not key.startswith('SINGZ_')}
            environment.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_GPUI_BACKGROUND='1',
                SINGZ_GPUI_TEST_NO_CAPTURE='1', SINGZ_GPUI_CONFIG_DIR=str(config),
                SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'), SINGZ_GPUI_TEST_PROJECT=str(project),
                SINGZ_GPUI_PERF_SECOND_PROJECT=str(second), SINGZ_GPUI_PERF_SCENARIO=str(scenario),
                SINGZ_GPUI_AUDIO_HELPER=str(helper), SINGZ_PERF_STEP_TIMEOUT='30',
                SINGZ_PERF_CYCLES='1', SINGZ_PERF_CYCLE_DELAY='0.2')
            if args.negative_control:
                environment['SINGZ_C72_INJECT_ALLOC'] = '1'
            with (out / 'app.log').open('w') as log:
                child = subprocess.Popen([str(app)], env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                action = make_action(scenario, child, out)

                def check(condition, message):
                    if not condition:
                        failures.append(message)

                def check_paint(name, d, frames, advancing, cue_painted):
                    """The assertions every measured window shares."""
                    check(d['lyricPaints'] == frames, f'{name}: the lyric canvas painted {d["lyricPaints"]} times in {frames} frames')
                    check(d['pitchPaints'] == frames, f'{name}: the pitch canvas painted {d["pitchPaints"]} times in {frames} frames')
                    check(d['pitchTracePaints'] == frames, f'{name}: the f0 trace was painted {d["pitchTracePaints"]} times in {frames} frames')
                    check(d['lyricShapeMisses'] == 0, f'{name}: {d["lyricShapeMisses"]} lyric shape-cache misses (want 0)')
                    check(d['pitchLabelMisses'] == 0, f'{name}: {d["pitchLabelMisses"]} pitch label shape misses (want 0)')
                    check(d['pitchTraceMisses'] == 0, f'{name}: {d["pitchTraceMisses"]} pitch trace path rebuilds (want 0)')
                    check(d['lyricPitchPaintAllocations'] == 0, f'{name}: {d["lyricPitchPaintAllocations"]} {ALLOCATION_FAILURE} over {frames} frames (want 0)')
                    check(d['pitchTracePathEngineAllocations'] == TRACE_ALLOCATIONS_PER_PAINT * d['pitchTracePaints'],
                          f'{name}: GPUI paint_path made {d["pitchTracePathEngineAllocations"]} allocations for {d["pitchTracePaints"]} trace paints (want exactly {TRACE_ALLOCATIONS_PER_PAINT} each)')
                    check(d['countdownSpriteRequests'] == 0, f'{name}: {d["countdownSpriteRequests"]} UIKit countdown sprite requests (a retained sprite needs none)')
                    check(d['advancingWords'] == advancing, f'{name}: {d["advancingWords"]} advancing-word paints, the fixture timings predict {advancing}')
                    check(d['advancingGlowDraws'] == GLOW_DRAWS_PER_ADVANCING_FRAME * advancing,
                          f'{name}: {d["advancingGlowDraws"]} advancing glow draws, want {GLOW_DRAWS_PER_ADVANCING_FRAME} for each of {advancing} advancing frames')
                    check(d['countdownSpritePaints'] == (frames if cue_painted else 0),
                          f'{name}: {d["countdownSpritePaints"]} countdown sprites painted in {frames} frames')

                def paused_window(name, start, advancing):
                    # Two warm passes, a pause between them: countdown captions are prepared off-thread.
                    for _ in range(2):
                        action('lyric-pitch-sweep', budget=120, start=start, frames=FRAMES)
                        time.sleep(1)
                    before = action('render-metrics')
                    action('lyric-pitch-sweep', budget=120, start=start, frames=FRAMES)
                    after = action('render-metrics')
                    report[name] = {'before': before, 'after': after, 'delta': delta(before, after), 'expectedAdvancingFrames': advancing}
                    check_paint(name, delta(before, after), FRAMES, advancing, False)
                    return after

                action('launch')
                action('open')
                action('karaoke')  # the mode that shows the lyric canvas and the pitch strip
                action('seek', to=INTRO_SWEEP)
                words_expected = expected_advancing_frames(WORD_SWEEP)
                check(words_expected > 400, f'fixture precondition: only {words_expected} advancing frames expected')
                paused_window('intro', INTRO_SWEEP, expected_advancing_frames(INTRO_SWEEP))
                after = paused_window('words', WORD_SWEEP, words_expected)
                paused_window('gap', GAP_SWEEP, expected_advancing_frames(GAP_SWEEP))
                check(after['lyricShapeEntries'] > 50, f'precondition: lyrics never painted ({after["lyricShapeEntries"]} cached shapes)')
                check(after['pitchLabelEntries'] >= 4, f'precondition: pitch labels never painted ({after["pitchLabelEntries"]} cached labels)')
                check(after['lyricShapeEntries'] <= LYRIC_CACHE_BOUND, f'lyric shape cache {after["lyricShapeEntries"]} over its bound {LYRIC_CACHE_BOUND}')
                check(after['pitchLabelEntries'] <= PITCH_LABEL_BOUND, f'pitch label cache {after["pitchLabelEntries"]} over its bound {PITCH_LABEL_BOUND}')

                # Real playback through the intro: the countdown cue itself is painted every frame.
                # Each caption has nine pulse-level images that reach the GPU atlas the first time
                # they are painted, and UIKit prepares each caption off-thread, so the cue is warmed
                # by two full passes (each reaches further into the intro than the measured window).
                def play_intro(seconds, settle=0):
                    action('seek', to=5.0, native=True)
                    time.sleep(1)
                    action('play')
                    return action('steady-playback', settleSeconds=settle, seconds=seconds)

                for _ in range(2):
                    play_intro(5)
                    action('pause')
                    time.sleep(1)
                play_intro(0.5, settle=0.5)
                before = action('render-metrics')
                window = action('steady-playback', seconds=2.5)
                after = action('render-metrics')
                action('pause')
                d = delta(before, after)
                frames = d['lyricPaints']
                report['playingIntro'] = {'before': before, 'after': after, 'delta': d, 'window': window}
                check(frames >= 100, f'playingIntro: only {frames} lyric paints in 2.5 s of playback')
                check_paint('playingIntro', d, frames, 0, True)
                # d['countdownAnimationAllocations'] is reported, not asserted: GPUI boxes one callback per animation frame.

                action('cycles', budget=60)  # opens the second project, which has no lyrics
                switched = action('render-metrics')
                report['afterProjectChange'] = switched
                check(switched['lyricShapeEntries'] == 0, f'{switched["lyricShapeEntries"]} lyric shapes survived a project change (want 0)')
                check(switched['pitchLabelEntries'] < after['pitchLabelEntries'], f'pitch labels survived a project change: {after["pitchLabelEntries"]} -> {switched["pitchLabelEntries"]}')
                action('quit')
                child.wait(timeout=30)
                child = None
    finally:
        if child is not None and child.poll() is None:
            os.killpg(child.pid, 9)
    report['failures'] = failures
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    if args.negative_control:
        allocation = [f for f in failures if ALLOCATION_FAILURE in f]
        other = [f for f in failures if ALLOCATION_FAILURE not in f]
        assert allocation, 'negative control: the injected allocation was not detected'
        assert not other, 'negative control failed on something other than the allocation assertion: ' + '; '.join(other)
        print('NEGATIVE CONTROL OK: failed on the allocation assertion alone:', '; '.join(allocation))
        return
    assert not failures, '; '.join(failures)
    print('OK', out / 'report.json')


if __name__ == '__main__':
    main()
