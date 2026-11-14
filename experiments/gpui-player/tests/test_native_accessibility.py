#!/usr/bin/env python3
"""macOS accessibility, D-06 floor: real AX actions on shared UIKit in an isolated host, then the whole app.

The whole-app half drives the real Player root (no replace_root) through every route and dialog the fixture can
reach, at both record sizes, in a debug build with the AX adapter attached, and judges D-06 section 4.2 rules
1-6 and the live regions of rule 7 plus the L0 keyboard floor: named, role-bearing, modal dialogs; trapped Tab
rings equal to the checked-in lists; Escape closes; focus returns to the opener. A duplicate node id panics a
debug build and fails the run."""
import argparse
import json
import sys
from pathlib import Path
from native_ui_observer import REPO, TESTS, run, sha


def locked_uikit_source():
    for package in (TESTS.parent / 'Cargo.lock').read_text().split('[[package]]'):
        if '\nname = "singz-uikit"\n' in package:
            return next(line[len('source = "'):-1] for line in package.splitlines() if line.startswith('source = "'))
    raise AssertionError('Cargo.lock does not pin singz-uikit')


def isolated(app, out):
    from PIL import Image  # only the isolated probe reads screenshots
    iso = out
    result, observation = run(app, iso, lambda out: {'SINGZ_GPUI_ACCESSIBILITY_TEST': str(out)})
    assert result['passed'] and result['hidden'] and result['liveFPS'] == 'unmeasured'
    assert result['compiledUikitSource'] == locked_uikit_source()
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
            snapshot = json.loads((iso / 'journey' / f'{name}.json').read_text())
            assert snapshot['viewport'] == [width, height] and snapshot['scale'] == 2
            assert snapshot['hidden'] and snapshot['liveFPS'] == 'unmeasured'
            image = iso / 'journey' / f'{name}.png'
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
            tree = json.loads((iso / 'journey' / f'{name}.tree.json').read_text())
            assert tree, 'Actual activated GPUI accessibility tree missing'
    assert len(list((iso / 'journey').glob('*.png'))) == 4
    assert 'ACCESSIBILITY passed' in (iso / 'app.log').read_text()
    (iso / 'validation.json').write_text(json.dumps({'passed': True, 'cases': 2, 'captures': 4,
        'appSha256': observation['appSha256'], 'liveFps': None,
        'scope': 'Real native AX actions on shared UIKit in an isolated host; whole-app accessibility remains unqualified'}, indent=2) + '\n')
    return observation


# --- Whole-app audit (D-06 section 4.2, macOS) -------------------------------------------------
# Drives the REAL Player root through every route and dialog the fixture can reach, at both record
# sizes, in a debug build (so a duplicate node id panics) with the macOS AX adapter attached. The
# per-control auditor and the app driver are the C-60a ones; this adds what D-06 asks of the floor.
sys.path.insert(0, str(TESTS))
import test_native_accessibility_routes as routes  # noqa: E402  (auditor, app runner, negative control)

ROUTE_STATES = ('library', 'player', 'player-metronome', 'training', 'settings', 'log', 'models')
# Overlays that take the whole window: dialog role, modal flag, trapped focus, Escape, focus return.
MODAL_STATES = ('dialog-quick-start', 'dialog-whats-new', 'dialog-engine-setup', 'dialog-notice',
                'dialog-drive-projects', 'dialog-project-picker', 'dialog-stem-export', 'dialog-lyrics-editor',
                'dialog-library-import', 'dialog-project-delete', 'settings', 'log', 'models')
# The AI-model setup wizard is persistent by design (source SetupWizard): Escape never closes it; its Close button does.
ESCAPE_EXEMPT = ('models',)
# A popover is not modal: Escape closes it and Tab may leave. It must still be one named node of the given role.
POPOVER_ROLES = {'dialog-language-menu': 'Menu', 'popover-carry-line': 'Dialog'}
POPOVER_STATES = tuple(POPOVER_ROLES)
HEADING_STATES = ('library', 'player', 'training', 'settings', 'log', 'models')
# The fixture has no native audio backend, so the hook opens these dialogs by filling the dialog entity and setting
# the host's flag (see ui_accessibility_routes.rs); nothing is unreachable any more.
UNREACHED_ON_FIXTURE = ()
# Reviewed allow-list (D-06 rule 1): the settings checkbox glyph is hidden from assistive technology on purpose;
# its row (`<id>-row`) carries the name, state and action, and is in the native readback.
HIDDEN_FROM_AX = ('settings-native', 'settings-headphones')  # and every `export-track-N-check` glyph (its row is the control)
# D-06 rule 7: each state drives the real announcement code, then the live region must carry exactly this text.
ANNOUNCEMENTS = {'announce-recording-started': 'Recording started', 'announce-recording-stopped': 'Recording stopped',
                 'announce-recording-failed': 'Recording failed', 'announce-training-result': 'Session complete. 3 of 4 landed',
                 'announce-model-installing': 'Installing Fixture model', 'announce-model-installed': 'Fixture model installed',
                 'announce-model-failed': 'Model install failed'}
TOAST_TEXT, NOTICE_TEXT, STATUS_TEXT = 'Accessibility audit toast', 'Accessibility audit notice', 'Accessibility audit status'
# Checked-in expected Tab ring per state (D-06 rule 6): ids in order, from the first stop after reset.
EXPECTED_TAB_ORDER = {
    'announce-model-failed': [
        'header-version', 'header-songs', 'header-training', 'header-monitor', 'header-log', 'header-engine',
        'header-language', 'header-help', 'header-settings', 'input-state', 'library-song:"demo-0"',
        'library-delete:"demo-0"', 'library-song:"demo-1"', 'library-delete:"demo-1"', 'library-song:"demo-2"',
        'library-delete:"demo-2"', 'library-song:"demo-3"', 'library-delete:"demo-3"', 'library-song:"demo-4"',
        'library-delete:"demo-4"', 'library-song:"demo-5"', 'library-delete:"demo-5"', 'library-song:"demo-6"',
        'library-delete:"demo-6"', 'library-song:"demo-7"', 'library-delete:"demo-7"', 'library-song:"demo-8"',
        'library-delete:"demo-8"', 'library-song:"demo-9"', 'library-delete:"demo-9"',
        'library-song:"demo-10"', 'library-delete:"demo-10"', 'library-song:"demo-11"',
        'library-delete:"demo-11"',
    ],
    'announce-model-installed': [
        'header-version', 'header-songs', 'header-training', 'header-monitor', 'header-log', 'header-engine',
        'header-language', 'header-help', 'header-settings', 'input-state', 'library-song:"demo-0"',
        'library-delete:"demo-0"', 'library-song:"demo-1"', 'library-delete:"demo-1"', 'library-song:"demo-2"',
        'library-delete:"demo-2"', 'library-song:"demo-3"', 'library-delete:"demo-3"', 'library-song:"demo-4"',
        'library-delete:"demo-4"', 'library-song:"demo-5"', 'library-delete:"demo-5"', 'library-song:"demo-6"',
        'library-delete:"demo-6"', 'library-song:"demo-7"', 'library-delete:"demo-7"', 'library-song:"demo-8"',
        'library-delete:"demo-8"', 'library-song:"demo-9"', 'library-delete:"demo-9"',
        'library-song:"demo-10"', 'library-delete:"demo-10"', 'library-song:"demo-11"',
        'library-delete:"demo-11"',
    ],
    'announce-model-installing': [
        'header-version', 'header-songs', 'header-training', 'header-monitor', 'header-log', 'header-engine',
        'header-language', 'header-help', 'header-settings', 'input-state', 'library-song:"demo-0"',
        'library-delete:"demo-0"', 'library-song:"demo-1"', 'library-delete:"demo-1"', 'library-song:"demo-2"',
        'library-delete:"demo-2"', 'library-song:"demo-3"', 'library-delete:"demo-3"', 'library-song:"demo-4"',
        'library-delete:"demo-4"', 'library-song:"demo-5"', 'library-delete:"demo-5"', 'library-song:"demo-6"',
        'library-delete:"demo-6"', 'library-song:"demo-7"', 'library-delete:"demo-7"', 'library-song:"demo-8"',
        'library-delete:"demo-8"', 'library-song:"demo-9"', 'library-delete:"demo-9"',
        'library-song:"demo-10"', 'library-delete:"demo-10"', 'library-song:"demo-11"',
        'library-delete:"demo-11"',
    ],
    'announce-recording-failed': [
        'header-version', 'header-songs', 'header-training', 'header-monitor', 'header-log', 'header-engine',
        'header-language', 'header-help', 'header-settings', 'input-state', 'library-song:"demo-0"',
        'library-delete:"demo-0"', 'library-song:"demo-1"', 'library-delete:"demo-1"', 'library-song:"demo-2"',
        'library-delete:"demo-2"', 'library-song:"demo-3"', 'library-delete:"demo-3"', 'library-song:"demo-4"',
        'library-delete:"demo-4"', 'library-song:"demo-5"', 'library-delete:"demo-5"', 'library-song:"demo-6"',
        'library-delete:"demo-6"', 'library-song:"demo-7"', 'library-delete:"demo-7"', 'library-song:"demo-8"',
        'library-delete:"demo-8"', 'library-song:"demo-9"', 'library-delete:"demo-9"',
        'library-song:"demo-10"', 'library-delete:"demo-10"', 'library-song:"demo-11"',
        'library-delete:"demo-11"',
    ],
    'announce-recording-started': [
        'header-version', 'header-songs', 'header-training', 'header-monitor', 'header-log', 'header-engine',
        'header-language', 'header-help', 'header-settings', 'input-state', 'library-song:"demo-0"',
        'library-delete:"demo-0"', 'library-song:"demo-1"', 'library-delete:"demo-1"', 'library-song:"demo-2"',
        'library-delete:"demo-2"', 'library-song:"demo-3"', 'library-delete:"demo-3"', 'library-song:"demo-4"',
        'library-delete:"demo-4"', 'library-song:"demo-5"', 'library-delete:"demo-5"', 'library-song:"demo-6"',
        'library-delete:"demo-6"', 'library-song:"demo-7"', 'library-delete:"demo-7"', 'library-song:"demo-8"',
        'library-delete:"demo-8"', 'library-song:"demo-9"', 'library-delete:"demo-9"',
        'library-song:"demo-10"', 'library-delete:"demo-10"', 'library-song:"demo-11"',
        'library-delete:"demo-11"',
    ],
    'announce-recording-stopped': [
        'header-version', 'header-songs', 'header-training', 'header-monitor', 'header-log', 'header-engine',
        'header-language', 'header-help', 'header-settings', 'input-state', 'library-song:"demo-0"',
        'library-delete:"demo-0"', 'library-song:"demo-1"', 'library-delete:"demo-1"', 'library-song:"demo-2"',
        'library-delete:"demo-2"', 'library-song:"demo-3"', 'library-delete:"demo-3"', 'library-song:"demo-4"',
        'library-delete:"demo-4"', 'library-song:"demo-5"', 'library-delete:"demo-5"', 'library-song:"demo-6"',
        'library-delete:"demo-6"', 'library-song:"demo-7"', 'library-delete:"demo-7"', 'library-song:"demo-8"',
        'library-delete:"demo-8"', 'library-song:"demo-9"', 'library-delete:"demo-9"',
        'library-song:"demo-10"', 'library-delete:"demo-10"', 'library-song:"demo-11"',
        'library-delete:"demo-11"',
    ],
    'announce-training-result': [
        'header-version', 'header-songs', 'header-training', 'header-monitor', 'header-log', 'header-engine',
        'header-language', 'header-help', 'header-settings', 'input-state', 'library-song:"demo-0"',
        'library-delete:"demo-0"', 'library-song:"demo-1"', 'library-delete:"demo-1"', 'library-song:"demo-2"',
        'library-delete:"demo-2"', 'library-song:"demo-3"', 'library-delete:"demo-3"', 'library-song:"demo-4"',
        'library-delete:"demo-4"', 'library-song:"demo-5"', 'library-delete:"demo-5"', 'library-song:"demo-6"',
        'library-delete:"demo-6"', 'library-song:"demo-7"', 'library-delete:"demo-7"', 'library-song:"demo-8"',
        'library-delete:"demo-8"', 'library-song:"demo-9"', 'library-delete:"demo-9"',
        'library-song:"demo-10"', 'library-delete:"demo-10"', 'library-song:"demo-11"',
        'library-delete:"demo-11"',
    ],
    'dialog-drive-projects': [
        'input-state', 'drive-projects-close',
    ],
    'dialog-engine-setup': [
        'engine-setup-recheck', 'engine-setup-github', 'engine-setup-close', 'engine-setup-copy',
    ],
    'dialog-language-menu': [
        'header-help', 'header-settings', 'input-state', 'library-song:"demo-0"', 'library-delete:"demo-0"',
        'library-song:"demo-1"', 'library-delete:"demo-1"', 'library-song:"demo-2"', 'library-delete:"demo-2"',
        'library-song:"demo-3"', 'library-delete:"demo-3"', 'library-song:"demo-4"', 'library-delete:"demo-4"',
        'library-song:"demo-5"', 'library-delete:"demo-5"', 'library-song:"demo-6"', 'library-delete:"demo-6"',
        'library-song:"demo-7"', 'library-delete:"demo-7"', 'library-song:"demo-8"', 'library-delete:"demo-8"',
        'library-song:"demo-9"', 'library-delete:"demo-9"', 'library-song:"demo-10"',
        'library-delete:"demo-10"', 'library-song:"demo-11"', 'library-delete:"demo-11"', 'header-version',
        'header-songs', 'header-training', 'header-monitor', 'header-log', 'header-engine', 'header-language',
    ],
    'dialog-library-import': [
        'library-import-copy', 'library-import-move', 'library-import-close',
    ],
    'dialog-lyrics-editor': [
        'lyed-stamp-N', 'input-state', 'lyed-cancel', 'lyed-save', 'lyed-play', 'lyed-help', 'lyed-align',
        'lyed-replace', 'lyed-stamp-N', 'input-state',
    ],
    'dialog-notice': [
        'notice-close',
    ],
    'dialog-project-delete': [
        'project-delete-confirm', 'project-delete-keep',
    ],
    'dialog-project-picker': [
        'picker-close', 'picker-choose-root', 'picker-browse',
    ],
    'dialog-quick-start': [
        'guide-skip', 'guide-next',
    ],
    'dialog-stem-export': [
        'export-mode-karaoke', 'export-track-0', 'export-track-1', 'export-format-mp3', 'export-format-wav',
        'export-format-flac', 'export-run', 'export-cancel', 'export-mode-stems',
    ],
    'dialog-whats-new': [
        'whats-new-telegram', 'whats-new-full-notes', 'whats-new-done', 'whats-new-close',
    ],
    'library': [
        'header-version', 'header-songs', 'header-training', 'header-monitor', 'header-log', 'header-engine',
        'header-language', 'header-help', 'header-settings', 'input-state', 'library-song:"demo-0"',
        'library-delete:"demo-0"', 'library-song:"demo-1"', 'library-delete:"demo-1"', 'library-song:"demo-2"',
        'library-delete:"demo-2"', 'library-song:"demo-3"', 'library-delete:"demo-3"', 'library-song:"demo-4"',
        'library-delete:"demo-4"', 'library-song:"demo-5"', 'library-delete:"demo-5"', 'library-song:"demo-6"',
        'library-delete:"demo-6"', 'library-song:"demo-7"', 'library-delete:"demo-7"', 'library-song:"demo-8"',
        'library-delete:"demo-8"', 'library-song:"demo-9"', 'library-delete:"demo-9"',
        'library-song:"demo-10"', 'library-delete:"demo-10"', 'library-song:"demo-11"',
        'library-delete:"demo-11"',
    ],
    'log': [
        'log-save', 'log-close', 'log-copy',
    ],
    'models': [
        'model-close',
    ],
    'player': [
        'header-version', 'header-songs', 'header-training', 'header-monitor', 'header-log', 'header-engine',
        'header-language', 'header-help', 'header-settings', 'add-track', 'NamedInteger("all-track", 2)',
        'NamedInteger("m", 0)', 'NamedInteger("s", 0)', 'NamedInteger("gain", 0)', 'NamedInteger("m", 1)',
        'NamedInteger("s", 1)', 'NamedInteger("gain", 1)', 'NamedInteger("m", 2)', 'NamedInteger("s", 2)',
        'NamedInteger("gain", 2)', 'NamedInteger("m", 3)', 'NamedInteger("s", 3)', 'NamedInteger("gain", 3)',
        'NamedInteger("m", 4)', 'NamedInteger("s", 4)', 'NamedInteger("gain", 4)', 'NamedInteger("m", 5)',
        'NamedInteger("s", 5)', 'NamedInteger("gain", 5)', 'transport-restart', 'transport-play',
        'transport-loop', 'transport-output', 'transport-met', 'transport-carry', 'transport-transpose-down',
        'transport-transpose-reset', 'transport-transpose-up', 'transport-tempo-down', 'transport-tempo-reset',
        'transport-tempo-up', 'transport-karaoke', 'transport-split', 'transport-stem-files',
    ],
    'player-metronome': [
        'header-version', 'header-songs', 'header-training', 'header-monitor', 'header-log', 'header-engine',
        'header-language', 'header-help', 'header-settings', 'add-track', 'NamedInteger("all-track", 2)',
        'NamedInteger("m", 0)', 'NamedInteger("s", 0)', 'NamedInteger("gain", 0)', 'NamedInteger("m", 1)',
        'NamedInteger("s", 1)', 'NamedInteger("gain", 1)', 'NamedInteger("m", 2)', 'NamedInteger("s", 2)',
        'NamedInteger("gain", 2)', 'NamedInteger("m", 3)', 'NamedInteger("s", 3)', 'NamedInteger("gain", 3)',
        'NamedInteger("m", 4)', 'NamedInteger("s", 4)', 'NamedInteger("gain", 4)', 'NamedInteger("m", 5)',
        'NamedInteger("s", 5)', 'NamedInteger("gain", 5)', 'transport-restart', 'transport-play',
        'transport-loop', 'transport-output', 'transport-met', 'transport-carry', 'transport-transpose-down',
        'transport-transpose-reset', 'transport-transpose-up', 'transport-tempo-down', 'transport-tempo-reset',
        'transport-tempo-up', 'transport-karaoke', 'transport-split', 'transport-stem-files', 'met-click-0',
        'met-volume', 'met-accent-0', 'met-accent-1', 'met-grid-0', 'met-count-0', 'met-count-1',
        'met-count-2', 'input-state', 'met-tap',
    ],
    'popover-carry-line': [
        'carry-on', 'carry-time', 'carry-lines', 'carry-period-minus', 'carry-period-plus', 'carry-off',
    ],
    'settings': [
        'settings-quick-start', 'settings-tab-audio', 'settings-output', 'settings-native-row',
        'settings-input', 'settings-monitor-output', 'settings-monitor-gain', 'settings-headphones-row',
        'settings-close',
    ],
    'status': [
        'header-version', 'header-songs', 'header-training', 'header-monitor', 'header-log', 'header-engine',
        'header-language', 'header-help', 'header-settings', 'input-state', 'library-song:"demo-0"',
        'library-delete:"demo-0"', 'library-song:"demo-1"', 'library-delete:"demo-1"', 'library-song:"demo-2"',
        'library-delete:"demo-2"', 'library-song:"demo-3"', 'library-delete:"demo-3"', 'library-song:"demo-4"',
        'library-delete:"demo-4"', 'library-song:"demo-5"', 'library-delete:"demo-5"', 'library-song:"demo-6"',
        'library-delete:"demo-6"', 'library-song:"demo-7"', 'library-delete:"demo-7"', 'library-song:"demo-8"',
        'library-delete:"demo-8"', 'library-song:"demo-9"', 'library-delete:"demo-9"',
        'library-song:"demo-10"', 'library-delete:"demo-10"', 'library-song:"demo-11"',
        'library-delete:"demo-11"',
    ],
    'toast': [
        'header-version', 'header-songs', 'header-training', 'header-monitor', 'header-log', 'header-engine',
        'header-language', 'header-help', 'header-settings', 'input-state', 'library-song:"demo-0"',
        'library-delete:"demo-0"', 'library-song:"demo-1"', 'library-delete:"demo-1"', 'library-song:"demo-2"',
        'library-delete:"demo-2"', 'library-song:"demo-3"', 'library-delete:"demo-3"', 'library-song:"demo-4"',
        'library-delete:"demo-4"', 'library-song:"demo-5"', 'library-delete:"demo-5"', 'library-song:"demo-6"',
        'library-delete:"demo-6"', 'library-song:"demo-7"', 'library-delete:"demo-7"', 'library-song:"demo-8"',
        'library-delete:"demo-8"', 'library-song:"demo-9"', 'library-delete:"demo-9"',
        'library-song:"demo-10"', 'library-delete:"demo-10"', 'library-song:"demo-11"',
        'library-delete:"demo-11"',
    ],
    'training': [
        'header-version', 'header-songs', 'header-training', 'header-monitor', 'header-log', 'header-engine',
        'header-language', 'header-help', 'header-settings', 'NamedInteger("training-level", 0)',
        'NamedInteger("training-level", 1)', 'NamedInteger("training-level", 2)', 'training-progress',
        'NamedInteger("training-exercise", 0)', 'NamedInteger("training-exercise", 1)',
        'NamedInteger("training-exercise", 2)', 'NamedInteger("training-exercise", 3)',
        'NamedInteger("training-exercise", 4)', 'NamedInteger("training-exercise", 5)',
        'NamedInteger("training-exercise", 6)',
    ],
}


def element_of(raw):
    """Plain element id from its Debug form. Row numbers of the lyrics editor count up over the session, so they
    are folded to N: the ring is judged by shape, not by which line number the fixture happened to get."""
    found = routes.re.fullmatch(r'Name\("(.*)"\)', raw or '')
    name = found.group(1).replace('\\"', '"') if found else raw
    return routes.re.sub(r'^(lyed-[a-z]+-)\d+$', r'\1N', name) if name else name


def subtree(tree, root_key):
    seen, pending = set(), [root_key]
    while pending:
        key = pending.pop()
        if key in seen or key not in tree['nodes']:
            continue
        seen.add(key)
        pending += tree['nodes'][key].get('children', [])
    return seen


def judge_state(entry, tree, tab, back, native):
    """All findings for one reached state at one size. Pure: takes the loaded files."""
    state, fails = entry['state'], []
    where = f'{state}@{entry["width"]}'
    _, gaps, _ = routes.audit_tree(tree, tab, native, state)
    # Text inputs share the editor's element id, so the per-id duplicate and native-readback rules
    # cannot tell them apart. Judge them by their own author ids in the native readback instead.
    for g in gaps:
        if g['control'] == 'input-state' or ((g['control'] in HIDDEN_FROM_AX or g['control'].endswith('-check')) and 'native macOS AX readback' in g['text']):
            continue
        if g['rule'] == 5 and state in POPOVER_STATES:
            continue  # a popover is a menu, not a dialog; judged below
        control = g['control']
        if g['rule'] == 2 and control.startswith('tab-stop-'):
            # No node means no identity: name the neighbours so the source can be found.
            i, stops = int(control.rsplit('-', 1)[1]), tab['stops']
            before = next((element_of(stops[j]['id']) for j in range(i - 1, -1, -1) if stops[j].get('hasNode')), None)
            after = next((element_of(stops[j]['id']) for j in range(i + 1, len(stops)) if stops[j].get('hasNode')), None)
            control = f'{control} (after {before}, before {after}; control {stops[i].get("unnoded")})'
        fails.append(f'{where}: rule {g["rule"]} {control}: {g["text"]}')
    ids = [n['id'] for n in native]
    if len(ids) != len(set(ids)):
        fails.append(f'{where}: duplicate native AX identifiers {sorted({i for i in ids if ids.count(i) > 1})}')
    editors = [k for k, n in tree['nodes'].items() if element_of(n.get('element_id')) == 'input-state']
    for n in native:
        if n.get('role') in ('AXTextField', 'AXTextArea') and not (n.get('title') or '').strip():
            fails.append(f'{where}: native AX text input {n["id"]!r} has no title')
    for k in editors:
        if not (tree['nodes'][k]['aria'].get('label') or '').strip():
            fails.append(f'{where}: text input {k} has no accessible name')
    nodes = tree['nodes']
    dialogs = [k for k, n in nodes.items() if n['aria'].get('role') in routes.DIALOG_ROLES]
    if state in MODAL_STATES:
        if len(dialogs) != 1:
            fails.append(f'{where}: expected exactly one dialog node, found {len(dialogs)}')
        else:
            node = nodes[dialogs[0]]
            label = (node['aria'].get('label') or '').strip()
            if not label or routes.KEY_LIKE.match(label):
                fails.append(f'{where}: dialog has no usable name ({label!r})')
            if not any(n.get('subrole') == 'AXDialog' and n.get('modal') for n in native):
                fails.append(f'{where}: native AX shows no modal AXDialog')
            inside = {nodes[k].get('element_id') for k in subtree(tree, dialogs[0])}
            outside = [s for s in tab['stops'] if s.get('focused') and s.get('id') not in inside]
            if outside:
                fails.append(f'{where}: Tab leaves the dialog: {[s["id"] for s in outside][:5]}')
    elif dialogs and state in ROUTE_STATES and state not in ('settings', 'log', 'models'):
        fails.append(f'{where}: unexpected dialog node on a non-modal state')
    if state in POPOVER_STATES:
        role = POPOVER_ROLES[state]
        found = [n for n in nodes.values() if n['aria'].get('role') == role]
        if len(found) != 1 or not (found[0]['aria'].get('label') or '').strip():
            fails.append(f'{where}: popover is not one named {role} ({len(found)})')
        if any(n.get('modal') for n in native):
            fails.append(f'{where}: a popover must not set the modal flag')
    if state in HEADING_STATES:
        heads = [n for n in nodes.values() if n['aria'].get('role') == 'Heading' and (n['aria'].get('label') or '').strip()]
        if not heads:
            fails.append(f'{where}: screen has no named heading')
    if state == 'library':
        rows = [n for n in nodes.values() if routes.re.match(r'Name\("library-song:', n.get('element_id') or '')]
        if not rows or any(not (r['aria'].get('label') or '').strip() or r['aria'].get('role') != 'Button' for r in rows):
            fails.append(f'{where}: song rows are not named buttons ({len(rows)} rows)')
    # Rule 7: live regions carry notice and toast text.
    live = {'toast': ('Status', 'live-toast', TOAST_TEXT), 'status': ('Status', 'live-status', STATUS_TEXT),
            'dialog-notice': ('Alert', 'live-notice', NOTICE_TEXT), **{k: ('Status', 'live-status', v) for k, v in ANNOUNCEMENTS.items()}}.get(state)
    if live:
        role, ident, text = live
        found = [n for n in nodes.values() if n['aria'].get('role') == role and (n['aria'].get('value') or '').strip('​') == text]
        row = next((n for n in native if n['id'] == ident), None)
        if len(found) != 1 or not row or (row.get('value') or '').strip('​') != text:
            fails.append(f'{where}: no {role} live region carrying {text!r} (tree {len(found)}, native {row and row.get("value")!r})')
    # Rule 6: the ring is the checked-in list, and Shift+Tab walks it backwards.
    ring = [s.get('id') for s in tab['stops']]
    if [s.get('id') for s in back['stops']] != ring[::-1]:
        fails.append(f'{where}: Shift+Tab does not reverse the Tab ring')
    expected = EXPECTED_TAB_ORDER.get(state)
    if expected is None:
        fails.append(f'{where}: no checked-in Tab order')
    elif [element_of(i) for i in ring] != expected:
        fails.append(f'{where}: Tab order differs from the checked-in list: {[element_of(i) for i in ring]}')
    # L0: Escape closes every overlay and focus returns to the control that opened it.
    kb = entry.get('keyboard')
    if state in MODAL_STATES + POPOVER_STATES and state not in ESCAPE_EXEMPT:
        if not kb or not kb['escapeCloses']:
            fails.append(f'{where}: Escape does not close it ({kb})')
        elif kb['opener'] and (not kb['openedByKeyboard'] or element_of(kb['focusAfterClose']) != kb['opener']):
            fails.append(f'{where}: focus did not return to {kb["opener"]}: {kb}')
    return fails


def judge_run(journey, entries, log):
    fails = []
    if 'Duplicate a11y node id' in log or 'panicked' in log:
        fails.append('the debug build panicked: ' + routes.re.search(r'panicked at [^\n]*\n[^\n]*', log).group(0))
    reached = {(e['state'], e['width']) for e in entries if e.get('reached')}
    for width in routes.SIZES:
        for state in ROUTE_STATES + MODAL_STATES + POPOVER_STATES + ('toast', 'status') + tuple(ANNOUNCEMENTS):
            if (state, width) not in reached:
                fails.append(f'{state}@{width} was not reached')
    for e in entries:
        if not e.get('reached') and e['state'] not in UNREACHED_ON_FIXTURE:
            fails.append(f'{e["state"]}@{e["width"]} unexpectedly not reached: {e.get("reason")}')
    for e in entries:
        if not e.get('reached'):
            continue
        tag = f'{e["state"]}-{e["width"]}'
        files = [routes.load(journey / f'{tag}.{kind}.json') for kind in ('tree', 'tab', 'shifttab', 'native')]
        if not all(f is not None for f in files):
            fails.append(f'{tag}: capture files missing')
            continue
        fails += judge_state(e, *files)
    return fails


def tab_order_of(journey, entries):
    return {e['state']: [element_of(s['id']) for s in routes.load(journey / f'{e["state"]}-{e["width"]}.tab.json')['stops']]
            for e in entries if e.get('reached') and e['width'] == routes.SIZES[0]}


def self_test_judge():
    """The judge must reject each defect it exists to catch (no app needed)."""
    def node(eid, role, label=None, children=None, **aria):
        a = {'role': role, **aria}
        if label is not None:
            a['label'] = label
        n = {'accesskit_id': '1', 'element_id': f'Name("{eid}")', 'aria': a}
        if children:
            n['children'] = children
        return n
    def make(dialog_role='Dialog', stops=('close',), outside=None, label='Notice'):
        tree = {'nodes': {'d': node('dlg', dialog_role, label, children=['b']),
                          'b': node('close', 'Button', 'Close', on_action=['Click']),
                          'o': node('behind', 'Button', 'Behind', on_action=['Click']),
                          'h': node('head', 'Heading', 'Notice')}, 'frame': {}}
        ring = [{'index': i, 'focused': True, 'hasNode': True, 'id': f'Name("{s}")'} for i, s in enumerate(list(stops) + ([outside] if outside else []))]
        back = {'stops': ring[::-1]}
        native = [{'id': 'dlg', 'role': 'AXGroup', 'subrole': 'AXDialog', 'modal': True}, {'id': 'close'}, {'id': 'behind'}]
        return tree, {'stops': ring}, back, native
    global EXPECTED_TAB_ORDER
    saved, EXPECTED_TAB_ORDER = EXPECTED_TAB_ORDER, {'dialog-notice': ['close']}
    try:
        entry = {'state': 'dialog-notice', 'width': 1280, 'keyboard': {'opener': None, 'openedByKeyboard': False,
                                                                       'escapeCloses': True, 'focusAfterClose': None}}
        def live(tree):
            tree['nodes']['l'] = node('live-notice', 'Alert', NOTICE_TEXT, value=NOTICE_TEXT)
            return tree
        tree, tab, back, native = make()
        native.append({'id': 'live-notice', 'value': NOTICE_TEXT})
        assert not judge_state(entry, live(tree), tab, back, native), judge_state(entry, live(tree), tab, back, native)
        tree, tab, back, native = make(dialog_role='GenericContainer')
        assert any('dialog node' in f for f in judge_state(entry, live(tree), tab, back, native)), 'missing dialog role not rejected'
        tree, tab, back, native = make()
        native[0]['modal'] = False
        assert any('modal AXDialog' in f for f in judge_state(entry, live(tree), tab, back, native + [{'id': 'live-notice', 'value': NOTICE_TEXT}])), 'non-modal dialog not rejected'
        tree, tab, back, native = make(outside='behind')
        assert any('Tab leaves' in f for f in judge_state(entry, live(tree), tab, back, native + [{'id': 'live-notice', 'value': NOTICE_TEXT}])), 'untrapped Tab not rejected'
        tree, tab, back, native = make()
        bad = dict(entry, keyboard={'opener': 'header-help', 'openedByKeyboard': True, 'escapeCloses': True, 'focusAfterClose': 'Name("behind")'})
        assert any('focus did not return' in f for f in judge_state(bad, live(tree), tab, back, native + [{'id': 'live-notice', 'value': NOTICE_TEXT}])), 'lost focus return not rejected'
        stuck = dict(entry, keyboard={'opener': None, 'openedByKeyboard': False, 'escapeCloses': False, 'focusAfterClose': None})
        assert any('Escape' in f for f in judge_state(stuck, live(tree), tab, back, native + [{'id': 'live-notice', 'value': NOTICE_TEXT}])), 'Escape that does not close not rejected'
        assert any('live region' in f for f in judge_state(entry, tree, tab, back, native)), 'missing live region not rejected'
    finally:
        EXPECTED_TAB_ORDER = saved


def whole_app(app, out, deadline=900., step=20.):
    if 'debug' not in app.parts:
        raise SystemExit('The whole-app audit needs a debug build: a duplicate node id panics only there')
    routes.self_test()
    self_test_judge()
    flagged = routes.negative_control(app, out / 'negative-control', deadline, step)
    code, failure, log = routes.run_app(app, out / 'app', {'SINGZ_GPUI_ACCESSIBILITY_ROUTES_TEST': str(out / 'app' / 'journey')},
                                        deadline, step)
    journey = out / 'app' / 'journey'
    result = routes.load(journey / 'result.json')
    assert not failure and code == 0 and result, f'whole-app run incomplete: {failure} exit={code}\n{log[-3000:]}'
    entries = result['states']
    observed = tab_order_of(journey, entries)
    (out / 'tab-order.observed.json').write_text(json.dumps(observed, indent=1, sort_keys=True) + '\n')
    fails = judge_run(journey, entries, log)
    # Sizes must agree on the Tab ring: no node may appear or vanish with the window.
    for e in entries:
        if e.get('reached') and e['width'] != routes.SIZES[0]:
            other = routes.load(journey / f'{e["state"]}-{e["width"]}.tab.json')
            if [element_of(s['id']) for s in other['stops']] != observed.get(e['state']):
                fails.append(f'{e["state"]}: Tab ring differs between window sizes')
    assert not fails, f'{len(fails)} accessibility findings:\n  ' + '\n  '.join(fails)
    return flagged, entries


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('app', type=Path)
    p.add_argument('out', type=Path)
    p.add_argument('--whole-app-only', action='store_true', help='skip the isolated UIKit probe')
    p.add_argument('--self-test', action='store_true', help='check the judge on fixtures and exit')
    a = p.parse_args()
    if a.self_test:
        routes.self_test()
        self_test_judge()
        print('PASS: judge self-test')
        return 0
    app, out = a.app.resolve(strict=True), a.out.absolute()
    observation = None if a.whole_app_only else isolated(app, out / 'isolated')
    flagged, entries = whole_app(app, out / 'whole-app')
    reached = sorted({e['state'] for e in entries if e.get('reached')})
    (out / 'validation.json').write_text(json.dumps({'passed': True, 'wholeApp': {'statesReached': reached,
        'unreachedOnFixture': sorted({e['state'] for e in entries if not e.get('reached')}), 'sizes': list(routes.SIZES)},
        'isolatedProbe': observation is not None,
        'scope': 'Real native AX on the production Player root, D-06 floor rules 1-6 and live regions; VoiceOver walk is human'}, indent=2) + '\n')
    print('PASS: whole-app macOS AX audit on', len(reached), 'states at both sizes' + ('' if observation is None else '; isolated UIKit probe passed'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
