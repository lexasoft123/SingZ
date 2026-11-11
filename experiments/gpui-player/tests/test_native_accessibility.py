#!/usr/bin/env python3
"""Actual macOS AX actions on shared UIKit in a hidden isolated native host."""
import argparse
import json
from pathlib import Path
from PIL import Image
from native_ui_observer import REPO, TESTS, run, sha

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('app', type=Path)
p.add_argument('out', type=Path)
a = p.parse_args()
result, observation = run(a.app, a.out, lambda out: {'SINGZ_GPUI_ACCESSIBILITY_TEST': str(out)})
assert result['passed'] and result['hidden'] and result['liveFPS'] == 'unmeasured'
assert result['compiledControlsSha256'] == sha(REPO.parent / 'singz-ui/gpui/src/controls.rs')
assert result['compiledAdapterSha256'] == sha(TESTS.parent / 'src/ui_accessibility.rs')
assert {c['width'] for c in result['cases']} == {1060, 1280} and len(result['cases']) == 2
for case in result['cases']:
    assert all(case[key] for key in ('nativeAXPress', 'nativeAXToggle', 'nativeAXIncrementDecrementSetValue',
                                     'disabledRefused', 'modalBackgroundRefused', 'nativeAXSelect', 'nativeAXCheckboxTabLink'))
    native_mixed = case['nativeMixedKeyboardAX']
    assert len(native_mixed) == 3 and {m['control'] for m in native_mixed} == {'settings', 'training', 'output'}
    for row in native_mixed:
        assert row['nativeOSDelivery'] and row['beforePaintObserved'] == row['sameFrame']
        assert row['afterTreeFrame'] >= row['beforeTreeFrame']
    mixed = case['frameworkSameFrameMixed']
    assert len(mixed) == 3 and {m['control'] for m in mixed} == {'settings', 'training', 'output'}
    for row in mixed:
        assert not row['nativeOSDelivery']
        assert row['sameFrame'] and row['beforeTreeFrame'] == row['afterTreeFrame']
        assert row['step'] == {'settings': 1., 'training': .05, 'output': .5}[row['control']]
    assert case['selectorExpanded']['nativeExpandedQualified'] is False
for width, height in ((1280, 800), (1060, 640)):
    for prefix in ('controls', 'modal-blocked'):
        name = f'{prefix}-{width}'
        snapshot = json.loads((a.out / 'journey' / f'{name}.json').read_text())
        assert snapshot['viewport'] == [width, height] and snapshot['scale'] == 2
        assert snapshot['hidden'] and snapshot['liveFPS'] == 'unmeasured'
        image = a.out / 'journey' / f'{name}.png'
        assert sha(image) == snapshot['screenshotSha256']
        with Image.open(image) as img:
            assert img.size == (width * 2, height * 2)
        state = snapshot['state']
        assert state == dict(presses=1, switch=True, gain=-12., changes=3, modal=prefix == 'modal-blocked',
                             trainingGain=.5, trainingChanges=0, outputGain=-6., outputChanges=0,
                             checked=True, secondTab=True, links=1, selectOpen=False, secondInput=True)
        native = {row['id']: row for row in snapshot['nativeAX']}
        for control_id, role, title in (('a11y-press', 'AXButton', 'Add track'),
                                       ('a11y-switch', 'AXCheckBox', 'Monitoring'),
                                       ('a11y-gain', 'AXSlider', 'Monitoring gain'),
                                       ('a11y-select', 'AXPopUpButton', 'Input device'),
                                       ('a11y-check', 'AXCheckBox', 'Loop practice'),
                                       ('a11y-tab-second', 'AXRadioButton', 'Devices'),
                                       ('a11y-link', 'AXLink', 'Help'),
                                       ('a11y-training-gain', 'AXSlider', 'Training cue volume'),
                                       ('a11y-output-gain', 'AXSlider', 'Song output gain')):
            assert native[control_id]['role'] == role and native[control_id]['title'] == title
        assert native['a11y-gain']['value'] == -12 and native['a11y-gain']['min'] == -60 and native['a11y-gain']['max'] == 0
        assert native['a11y-select']['value'] == 'Input 2'
        assert native['a11y-check']['value'] == 1 and native['a11y-tab-second']['value'] == 1
        assert native['a11y-output-gain']['value'] == -6 and native['a11y-output-gain']['min'] == -60 and native['a11y-output-gain']['max'] == 12
        assert not native['a11y-disabled']['enabled'] and not native['a11y-disabled-gain']['enabled']
        tree = json.loads((a.out / 'journey' / f'{name}.tree.json').read_text())
        assert tree, 'Actual activated GPUI accessibility tree missing'
assert len(list((a.out / 'journey').glob('*.png'))) == 4
assert 'ACCESSIBILITY passed' in (a.out / 'app.log').read_text()
(a.out / 'validation.json').write_text(json.dumps({'passed': True, 'cases': 2, 'captures': 4,
    'appSha256': observation['appSha256'], 'liveFps': None,
    'scope': 'Real native AX actions on shared UIKit in an isolated host; whole-app accessibility remains unqualified'}, indent=2) + '\n')
print('PASS: native AX semantics/actions, disabled refusal and modal isolation at both sizes')
