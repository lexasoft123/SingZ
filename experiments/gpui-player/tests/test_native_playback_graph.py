"""Hidden actual native runtime graph presentation; no hardware or Node.

Generated project audio is decoded/rendered by the production C++ helper. The
saved custom graph is the repository fixture, not a reconstructed display model.
"""
import argparse
import hashlib
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

SIZES = ((1280, 800), (1060, 640))
PHASES = ('paused', 'running', 'replaced', 'last', 'connections')


def decimal(value):
    assert isinstance(value, str) and value.isascii() and value.isdecimal(), value
    assert value == str(int(value)) and 0 <= int(value) <= (1 << 64) - 1, value
    return int(value)


def check_graph(row):
    graph, actual = row['graph'], row['nativeGraph']
    assert graph['mode'] == 'playback' and graph['available'] is True, row
    assert graph['error'] is None and graph['graph'] == actual, row
    assert decimal(actual['generation']) == decimal(row['nativeGeneration']) > 0, row
    nodes, edges = actual['nodes'], actual['connections']
    assert 1 <= len(nodes) <= 128 and len(edges) <= 256, row
    assert len(graph['renderedNodes']) == len(nodes) and len(graph['renderedConnections']) == len(edges), row
    assert len({node['id'] for node in nodes}) == len(nodes), row
    displayed = {node['id']: node for node in graph['renderedNodes']}
    for node in nodes:
        decimal(node['id'])
        painted = displayed[node['id']]
        assert painted['kind'] == node['kind'] and painted['label'] == node['label'], (node, painted)
        assert isinstance(painted['value'], str) and painted['value'], painted
        assert isinstance(painted['detail'], str) and painted['detail'], painted
        assert node['arrivalLatencyFrames'] + node['intrinsicLatencyFrames'] == node['outputLatencyFrames'], node
    supplied = {(edge['sourceNodeId'], edge['sourceBus'], edge['destinationNodeId'], edge['destinationBus']) for edge in edges}
    rendered = {(edge['sourceNodeId'], edge['sourceBus'], edge['destinationNodeId'], edge['destinationBus']) for edge in graph['renderedConnections']}
    assert supplied == rendered and len(supplied) == len(edges), row
    for edge in graph['renderedConnections']:
        assert edge['route'] and edge['latency'], edge
    return actual


def check_state(row, viewport):
    assert row['viewport'] == list(viewport) and row['hidden'] is True and row['active'] is False, row
    assert row['monitorRequested'] is False and row['micRequested'] is False, row
    assert row['liveFps'] == 'unmeasured' and row['productionParity'] == 'unqualified', row
    assert isinstance(row['scale'], (int, float)) and math.isfinite(row['scale']) and row['scale'] > 0, row


def validate_output(out):
    result = json.loads((out / 'result.json').read_text())
    for flag in ('passed', 'actualHeaderSettingsKeys', 'ordinaryAndCustomNativeSnapshots',
                 'actualGenerationReplacements', 'allSuppliedNodesAndConnections',
                 'keyboardHorizontalEnd', 'keyboardConnectionPageDown', 'customGraphSaveAndReopen', 'unloadedMonitorFallback',
                 'hidden', 'muted'):
        assert result[flag] is True, (flag, result)
    assert result['physicalInput'] is False and result['captureCount'] == 23, result
    assert len(result['receipts']) == 4, result
    captures = []
    for width, height in SIZES:
        captures.append((f'graph-monitor-{width}', (width, height), False))
        for kind in ('ordinary', 'custom'):
            for phase in PHASES:
                captures.append((f'graph-{kind}-{phase}-{width}', (width, height), True))
    captures.append(('graph-custom-reopened-1060', (1060, 640), True))
    from PIL import Image
    cases = {}
    for name, viewport, playback in captures:
        row = json.loads((out / f'{name}.state.json').read_text())
        check_state(row, viewport)
        cases[name] = row
        if playback:
            check_graph(row)
            assert row['explicitGraph'] == ('custom' in name), row
            if '-paused-' in name or '-reopened-' in name:
                assert row['playing'] is False, row
            else:
                assert row['playing'] is True, row
        else:
            assert row['graph']['mode'] == 'monitor' and row['nativeGraph'] is None, row
        with Image.open(out / f'{name}.png') as image:
            assert image.size == tuple(round(n * row['scale']) for n in viewport), row
    for receipt in result['receipts']:
        row = receipt['accepted']
        assert decimal(row['nativeGeneration']) > decimal(receipt['previousGeneration']), receipt
        width, kind = int(receipt['width']), receipt['kind']
        replaced = cases[f'graph-{kind}-replaced-{width}']
        assert row == replaced and replaced['transpose'] == (1 if width == 1280 else 2), receipt
        assert abs(replaced['rate'] - (1.1 if width == 1280 else 1.2)) < .001, receipt
        first = cases[f'graph-{kind}-paused-{width}']['nativeGraph']
        last = cases[f'graph-{kind}-last-{width}']
        assert decimal(first['generation']) < decimal(replaced['nativeGraph']['generation']), receipt
        assert last['nativeGraph'] == replaced['nativeGraph'], receipt
        node, viewport = last['graph']['lastNodeBounds'], last['graph']['viewportBounds']
        assert node[2] > 0 and node[3] > 0 and node[0] >= viewport[0] - 1 and node[0] + node[2] <= viewport[0] + viewport[2] + 1, last
        assert node[1] >= 52 and node[1] + node[3] <= last['viewport'][1], last
        modal = last['graph']['settingsModalViewportBounds']
        assert node[1] >= modal[1] - 1 and node[1] + node[3] <= modal[1] + modal[3] + 1, last
        connections = cases[f'graph-{kind}-connections-{width}']
        assert connections['nativeGraph'] == replaced['nativeGraph'], receipt
        row, modal = connections['graph']['lastConnectionBounds'], connections['graph']['settingsModalViewportBounds']
        assert row[2] > 0 and row[3] > 0 and row[1] >= modal[1] - 1 and row[1] + row[3] <= modal[1] + modal[3] + 1, connections
        assert row[0] + row[2] > modal[0] and row[0] < modal[0] + modal[2], connections
    before = cases['graph-custom-paused-1280']['nativeGraph']
    reopened = cases['graph-custom-reopened-1060']['nativeGraph']
    assert [n['id'] for n in before['nodes']] == [n['id'] for n in reopened['nodes']], result
    assert len(list(out.glob('graph-*.png'))) == 23, 'Unexpected or missing captures'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--timeout', type=int, default=240)
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('Strict foreground and process observation currently requires macOS')
    assert 30 <= args.timeout <= 600, '--timeout must be between 30 and 600 seconds'
    app, out = args.app.resolve(strict=True), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    assert not any(out.iterdir()), 'Use a fresh OUT directory'
    app_hash = shared.sha(app)
    helper = app.with_name('singz-gpui-audio')
    helper_hash = shared.sha(helper)
    source_graph = Path(__file__).resolve().parents[3] / 'tests/shared/native-playback-graph.json'
    graph_bytes, graph_hash = source_graph.read_bytes(), shared.sha(source_graph)
    with tempfile.TemporaryDirectory(prefix='singz-playback-graph-ui-') as temporary:
        root = Path(temporary).resolve()
        for name in ('prefs', 'library', 'cache', 'tmp'):
            (root / name).mkdir()
        wave_path = root / 'vocal.wav'
        rate, seconds = 48000, 30
        with wave.open(str(wave_path), 'wb') as audio:
            audio.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
            period = b''.join(struct.pack('<h', int(8000 * math.sin(i * math.tau * 220 / rate))) for i in range(rate))
            audio.writeframes(period * seconds)
        audio_hash = shared.sha(wave_path)
        projects = {}
        for kind in ('ordinary', 'custom'):
            project = root / 'library' / f'Native {kind} graph'
            (project / 'stems').mkdir(parents=True)
            shutil.copy2(wave_path, project / 'stems/vocals.wav')
            metadata = {'version': 2, 'name': project.name, 'foreign': {'retain': kind},
                        'settings': {'tracks': {'vocals': {'volume': .7, 'muted': False}},
                                     'masterVolume': .6, 'tempo': 1, 'transpose': 0,
                                     'metronome': {'click': False, 'countInBars': 0, 'volume': .7, 'accent': True},
                                     'melody': {'detVersion': 4, 'hopSec': .025, 'f0': ' '.join(['5700'] * (seconds * 40))}}}
            if kind == 'custom':
                (project / 'graph.json').write_bytes(graph_bytes)
                metadata['graphHash'] = {'format': 1, 'size': len(graph_bytes), 'md5': hashlib.md5(graph_bytes).hexdigest(), 'mtimeMs': 0}
            (project / 'project.json').write_text(json.dumps(metadata))
            (project / 'lyrics.json').write_text(json.dumps({'source': 'edited', 'lines': [
                {'start': 0, 'end': seconds, 'text': 'Local native graph fixture'}]}))
            projects[kind] = project
        catalog = root / 'catalog.json'
        catalog.write_text(json.dumps({'flavor': 'linux', 'entries': []}))
        catalog_hash = shared.sha(catalog)
        (out / 'fixture-input').mkdir()
        shutil.copy2(source_graph, out / 'fixture-input/custom-graph.json')
        env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_')}
        env.update(
            SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
            SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
            SINGZ_GPUI_CONFIG_DIR=str(root / 'prefs'), SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'),
            SINGZ_GPUI_TEST_PROJECT=str(projects['ordinary']), SINGZ_GPUI_TEST_CUSTOM_PROJECT=str(projects['custom']),
            SINGZ_GPUI_PLAYBACK_GRAPH_TEST=str(out), SINGZ_GPUI_MODEL_FIXTURE=str(catalog),
            SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
            SINGZ_LLAMA_SERVER=str(root / 'missing-llama'), SINGZ_CRISPASR=str(root / 'missing-crispasr'),
            TMPDIR=str(root / 'tmp'), XDG_CACHE_HOME=str(root / 'cache'),
            HF_HOME=str(root / 'cache/huggingface'), TORCH_HOME=str(root / 'cache/torch'),
            PYTHONDONTWRITEBYTECODE='1',
        )
        try:
            observation = shared.run_observed(app, out, env, args.timeout, expect_input_helper=False)
            validate_output(out)
            custom = projects['custom']
            assert (custom / 'graph.json').read_bytes() == graph_bytes, 'Save changed graph document'
            saved = json.loads((custom / 'project.json').read_text())
            assert saved['foreign'] == {'retain': 'custom'} and abs(saved['settings']['tempo'] - 1.2) < .001 and saved['settings']['transpose'] == 2, saved
            assert saved['graphHash'] == {'format': 1, 'size': len(graph_bytes), 'md5': hashlib.md5(graph_bytes).hexdigest(), 'mtimeMs': 0}, saved
            for project in projects.values():
                assert shared.sha(project / 'stems/vocals.wav') == audio_hash, 'Source audio changed'
            assert shared.sha(app) == app_hash and shared.sha(helper) == helper_hash and shared.sha(source_graph) == graph_hash and shared.sha(catalog) == catalog_hash, 'Immutable binary or fixture changed'
            shutil.copytree(custom, out / 'saved-custom-project')
            (out / 'fixture.json').write_text(json.dumps({
                'passed': True, 'applicationSha256': app_hash, 'helperSha256': helper_hash,
                'sourceAudioSha256': audio_hash, 'customGraphSha256': graph_hash,
                'modelCatalogSha256': catalog_hash, 'resourceSampleCount': len(observation['samples']),
                'physicalInput': False, 'liveFps': 'unmeasured', 'noNode': True,
                'scope': 'Actual native ordinary/custom runtime graph and generation replacement; full production visual parity and invalid-snapshot renderer qualification excluded',
            }, indent=2))
        except BaseException:
            shutil.copytree(root / 'prefs', out / 'failure-preferences', dirs_exist_ok=True)
            raise
    print('PASS: actual native playback graph modules, connections, generation replacement and custom Save/reopen')


if __name__ == '__main__':
    main()
