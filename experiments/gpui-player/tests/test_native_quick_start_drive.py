#!/usr/bin/env python3
"""Hidden actual native Library tour geometry with isolated account snapshots."""
import argparse
import json
from pathlib import Path
from PIL import Image
from native_ui_observer import REPO, TESTS, run, sha

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('app', type=Path)
p.add_argument('out', type=Path)
a = p.parse_args()
result, observation = run(a.app, a.out, lambda out: {
    'SINGZ_GPUI_GUIDE_TEST': str(out), 'SINGZ_GPUI_GUIDE_NATIVE_DRIVE': '1'})
assert result['passed'] and result['nativeDriveStage'] and result['nativeDriveGuide']
assert result['hidden'] and result['muted'] and not result['backendStarted'] and not result['accountQualified']
assert all(result[k] for k in ('backToSync', 'removedRowExcluded', 'modeResetExcluded', 'cachedAnchorRetained'))
assert result['configuredTargets'] == ['browse', 'saved', 'training', 'sync', 'settings']
assert result['unconfiguredTargets'] == ['browse', 'saved', 'training', 'settings']
assert result['autoScrollMovement']
assert result['sizes'] == 2 and len(result['cases']) == 18 and len(result['reveals']) == 2
source = result['source']
for name, relative in [('mainSha256', 'src/main.rs'), ('librarySha256', 'src/library.rs'),
                       ('observerSha256', 'src/ui_quick_start.rs'), ('copySha256', 'src/quick_start_copy.json')]:
    assert source[name] == sha(TESTS.parent / relative), ('Stale compiled source', name)
for width, height in ((1280, 800), (1060, 640)):
    cases = {c['case']: c for c in result['cases'] if c['viewport'] == [width, height]}
    expected = {f'{name}-{width}' for name in ('unconfigured', 'removed', 'mode-reset', 'sync-back')}
    expected.update(f'configured-{i}-{width}' for i in range(5))
    assert cases.keys() == expected
    for name, case in cases.items():
        assert case['hidden'] and not case['active'] and case['scale'] == 2 and case['source'] == source
        image = a.out / 'journey' / (name + '.png')
        assert sha(image) == case['screenshotSha256']
        with Image.open(image) as img:
            assert img.size == (width * 2, height * 2)
        guide = case['guide']
        configured = name.startswith(('configured-', 'sync-back-'))
        assert guide['targets'] == result['configuredTargets' if configured else 'unconfiguredTargets']
        if guide['targets'][guide['index']] == 'sync':
            target, card = case['target'], case['card']
            assert target is not None
            tx, ty, tw, th = (target[k] for k in ('left', 'top', 'width', 'height'))
            cx, cy, cw, ch = (card[k] for k in ('left', 'top', 'width', 'height'))
            assert tx + tw <= cx or cx + cw <= tx or ty + th <= cy or cy + ch <= ty, 'Guide obscures Drive row'
            viewport = case['library']['viewport']
            assert ty >= viewport['top'] + 7.9 and ty + th <= viewport['bottom'] - 7.9
for reveal in result['reveals']:
    before, after = reveal['before'], reveal['after']
    assert before['page']['maxOffsetY'] > 0 and before['page']['offsetY'] < 0
    assert before['targetBottom'] < before['page']['viewport']['top']
    assert after['offsetY'] > before['page']['offsetY'] + .5
assert 'QUICK_START_NATIVE_DRIVE passed' in (a.out / 'app.log').read_text()
(a.out / 'validation.json').write_text(json.dumps({'passed': True, 'cases': 18, 'source': source,
    'appSha256': observation['appSha256'], 'accountQualified': False, 'liveFps': None}, indent=2) + '\n')
print('PASS: configured/unconfigured/removed native Drive tour, exact order, Back and reveal at both sizes')
