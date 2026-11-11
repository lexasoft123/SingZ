#!/usr/bin/env python3
"""C-60a: whole-app macOS accessibility audit and baseline (D-06 section 7).

Drives the REAL native Player root (no replace_root) through every route it can
reach in fixture mode, at both record window sizes, hidden and muted, via
ui_accessibility_routes.rs. For each route it reads the GPUI accessibility tree,
the native macOS AX readback and the Tab order, then judges them against the L2
floor of D-06 section 4.2 and writes an inventory plus gap counts per route.

    test_native_accessibility_routes.py APP OUT [--deadline S] [--step S] [--report FILE] [--enforce-floor]

Budgets: every route step has its own budget (--step, enforced in the app and
again here from the app's progress file) and the whole run has a total deadline
(--deadline). On expiry, and on any exit, the app's whole process group is killed.
Baseline mode exits 0 when the audit completed, even with gaps; --enforce-floor
exits 1 when any gap is found. A negative control always runs first: an unlabeled
control injected into a probe host must be flagged, and its named sibling not.
"""
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
SIZES = (1280, 1060)
SCREENS = {0: 'training', 1: 'player', 2: 'library', 3: 'settings', 4: 'log', 5: 'models'}
# Roles that a user can operate or move focus to. Anything with one of these
# actions is also a control, whatever its role.
CONTROL_ROLES = {'Button', 'CheckBox', 'RadioButton', 'Switch', 'Slider', 'TextInput', 'MultilineTextInput',
                 'SearchInput', 'Link', 'Tab', 'ComboBox', 'MenuItem', 'MenuItemCheckBox', 'MenuItemRadio',
                 'ListBoxOption', 'SpinButton', 'PopUpButton', 'ToggleButton', 'DisclosureTriangle'}
CONTROL_ACTIONS = {'Click', 'Increment', 'Decrement', 'SetValue', 'Focus', 'Expand', 'Collapse'}
TOGGLE_ROLES = {'CheckBox', 'Switch', 'ToggleButton', 'MenuItemCheckBox'}
SELECT_ROLES = {'Tab', 'RadioButton', 'ListBoxOption', 'MenuItemRadio'}
DIALOG_ROLES = {'Dialog', 'AlertDialog'}
KEY_LIKE = re.compile(r'^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$')


def element_name(node):
    """ElementId's Debug form, e.g. Name("header-songs") -> header-songs."""
    raw = node.get('element_id') or ''
    found = re.fullmatch(r'Name\("(.*)"\)', raw)
    return found.group(1).replace('\\"', '"') if found else raw


def controls(tree):
    rows = []
    for key, node in tree.get('nodes', {}).items():
        aria = node.get('aria', {})
        role, actions = aria.get('role'), set(aria.get('on_action', []))
        if role in CONTROL_ROLES or actions & CONTROL_ACTIONS:
            rows.append((key, node, aria, role, actions))
    return rows


def audit_tree(tree, tab=None, native=None, state=''):
    """Pure judgment of one captured state. Returns (inventory rows, gaps, notes).

    Rule numbers are D-06 section 4.2. Rule 6 (checked-in tab-order lists), 7
    (announcements) and 8 (locale resolution) are not measured here.
    """
    rows, gaps = [], []
    native_by_id = {n['id']: n for n in native or []}
    ids = {}
    for key, node, aria, role, actions in controls(tree):
        name = element_name(node)
        label = (aria.get('label') or '').strip()
        row = {'id': name or f'<anonymous:{key}>', 'plainId': (node.get('element_id') or '').startswith('Name('), 'role': role, 'label': label, 'value': aria.get('value'),
               'actions': sorted(actions), 'gaps': []}
        nat = native_by_id.get(name)
        if nat:
            row['native'] = {k: nat.get(k) for k in ('role', 'title', 'value', 'min', 'max', 'enabled')}
        def gap(rule, text):
            row['gaps'].append({'rule': rule, 'text': text})
        if role in (None, 'Unknown', 'GenericContainer'):
            gap(1, f'actionable node has no control role ({role})')
        if not label:
            gap(1, 'no accessible name')
        elif KEY_LIKE.match(label) or label == name:
            gap(1, f'name looks like an i18n key or element id: {label!r}')
        if role == 'Slider':
            for field, what in (('numeric_value', 'value'), ('min_numeric_value', 'minimum'),
                                ('max_numeric_value', 'maximum'), ('numeric_value_step', 'step')):
                if aria.get(field) is None:
                    gap(4, f'slider exposes no {what}')
        if role in TOGGLE_ROLES and aria.get('toggled') is None:
            gap(4, 'toggle exposes no state')
        if role in SELECT_ROLES and aria.get('selected') is None:
            gap(4, 'tab/option exposes no selection')
        if not name:
            gap(3, 'node has no element id, so duplicates cannot be ruled out')
        else:
            ids.setdefault(name, []).append(row)
        rows.append(row)
    for name, same in ids.items():
        if len(same) > 1:
            for row in same:
                row['gaps'].append({'rule': 3, 'text': f'duplicate element id {name!r} x{len(same)}'})
    for row in rows:
        gaps += [{'control': row['id'], **g} for g in row['gaps']]
    # Rule 2: every tab stop has a node.
    stops = (tab or {}).get('stops', [])
    unnoded = [s for s in stops if s.get('focused') and not s.get('hasNode')]
    for s in unnoded:
        gaps.append({'control': f'tab-stop-{s["index"]}', 'rule': 2, 'text': 'focus landed on an element with no accessibility node'})
    notes = {'tabStops': len(stops), 'tabStopCountFrame': tree.get('frame', {}).get('tab_stop_count'),
             'nodeCount': tree.get('frame', {}).get('node_count'), 'nativeRows': len(native or [])}
    # Rule 5 (open dialog is exposed as a modal dialog). The debug tree has no
    # modal flag, so only the dialog role is checked; background refusal is not.
    if state.startswith('dialog-') and not any(r['role'] in DIALOG_ROLES for r in rows) and not any(
            n.get('aria', {}).get('role') in DIALOG_ROLES for n in tree.get('nodes', {}).values()):
        gaps.append({'control': state, 'rule': 5, 'text': 'open dialog has no dialog-role node'})
    # Native readback: a tree control the macOS adapter never surfaced.
    if native:
        for row in rows:
            # Composite ids (NamedInteger and the like) have no stable native spelling; not compared.
            if row['id'] in native_by_id or row['id'].startswith('<') or not row['plainId']:
                continue
            row['gaps'].append({'rule': 1, 'text': 'control absent from the native macOS AX readback'})
            gaps.append({'control': row['id'], 'rule': 1, 'text': 'control absent from the native macOS AX readback'})
    return rows, gaps, notes


def kill_group(child):
    """Kill the app's whole process group; never leave a child behind."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            return
        try:
            child.wait(timeout=5)
            return
        except subprocess.TimeoutExpired:
            continue


def run_app(app, out, env_extra, deadline, step, log_name='app.log'):
    """Run the hidden muted app under a total deadline and a per-step budget."""
    out.mkdir(parents=True, exist_ok=False)
    private = out / 'private'
    for name in ('prefs', 'library', 'cache', 'tmp', 'pack', 'models'):
        (private / name).mkdir(parents=True, mode=0o700)
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_')}
    env.update(SINGZ_GPUI_DEMO='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_MUTE='1', SINGZ_NO_SYNC='1',
               SINGZ_NO_SYSTEM_ENGINES='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
               SINGZ_GPUI_CONFIG_DIR=str(private / 'prefs'), SINGZ_GPUI_PROJECTS_ROOT=str(private / 'library'),
               SINGZ_PACK_DIR=str(private / 'pack'), SINGZ_MODELS_DIR=str(private / 'models'),
               TMPDIR=str(private / 'tmp'), XDG_CACHE_HOME=str(private / 'cache'),
               PYTHONDONTWRITEBYTECODE='1', SINGZ_A11Y_STEP_SECONDS=str(step), RUST_BACKTRACE='0',
               RUST_LOG='gpui=info')
    env.update(env_extra)
    started, failure = time.monotonic(), None
    with (out / log_name).open('w') as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            while child.poll() is None:
                now = time.monotonic()
                if now - started > deadline:
                    failure = f'total deadline of {deadline:.0f}s expired'
                    break
                progress = out / 'journey' / 'progress.json'
                try:
                    seen = json.loads(progress.read_text())
                    age = time.time() - seen['epochMs'] / 1000
                    # The app's own budget is `step`; allow two seconds of capture slack.
                    if seen['phase'] == 'open' and age > step + 2:
                        failure = f'step {seen["state"]}@{seen["width"]} exceeded its {step:.0f}s budget'
                        break
                    if seen['phase'] == 'capture' and age > step + 30:
                        failure = f'capture of {seen["state"]}@{seen["width"]} exceeded its budget'
                        break
                except (OSError, ValueError, KeyError):
                    pass
                time.sleep(.25)
        finally:
            if child.poll() is None:
                kill_group(child)
            else:
                try:  # reap stragglers left in the group after a natural exit
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
    return child.returncode, failure, (out / log_name).read_text(errors='replace')


def load(path):
    return json.loads(path.read_text()) if path.exists() else None


def audit_run(journey, states):
    results = []
    for entry in states:
        row = dict(entry, width=int(entry['width']))
        if entry.get('reached'):
            tag = f'{entry["state"]}-{row["width"]}'
            tree = load(journey / f'{tag}.tree.json')
            assert tree, f'missing tree for {tag}'
            inv, gaps, notes = audit_tree(tree, load(journey / f'{tag}.tab.json'), load(journey / f'{tag}.native.json'), entry['state'])
            row.update(controls=inv, gaps=gaps, notes=notes)
        results.append(row)
    return results


def negative_control(app, out, deadline, step):
    code, failure, log = run_app(app, out, {'SINGZ_GPUI_ACCESSIBILITY_ROUTES_TEST': str(out / 'journey'),
                                            'SINGZ_GPUI_ACCESSIBILITY_ROUTES_INJECT': '1'}, deadline, step)
    assert failure is None and code == 0, f'negative-control probe did not exit cleanly: {failure} code={code}\n{log[-3000:]}'
    result = load(out / 'journey' / 'result.json')
    assert result and result['passed'] and result['inject'], 'negative-control probe produced no result'
    flagged = {}
    for row in audit_run(out / 'journey', result['states']):
        for control in row.get('controls', []):
            flagged.setdefault(control['id'], []).extend(g['text'] for g in control['gaps'])
    assert any('no accessible name' in t for t in flagged.get('probe-unlabeled', [])), \
        f'unlabeled control NOT flagged: {flagged}'
    assert 'probe-named' in flagged, f'named probe control missing from the inventory: {flagged}'
    assert not any('no accessible name' in t for t in flagged['probe-named']), \
        f'named control wrongly flagged as unnamed: {flagged}'
    return flagged


def self_test():
    """Pure checks of the auditor on fixture trees; no app needed."""
    def node(eid, role, label=None, **aria):
        a = {'role': role, **aria}
        if label is not None:
            a['label'] = label
        return {'accesskit_id': '1', 'element_id': f'Name("{eid}")', 'aria': a}
    good = {'nodes': {'a': node('ok', 'Button', 'Add track', on_action=['Click'])}, 'frame': {}}
    assert not audit_tree(good)[1], 'named button must not be flagged'
    bad = {'nodes': {'a': node('x', 'Button', None, on_action=['Click'])}, 'frame': {}}
    assert any('no accessible name' in g['text'] for g in audit_tree(bad)[1]), 'unnamed button not flagged'
    key = {'nodes': {'a': node('x', 'Button', 'settings.title', on_action=['Click'])}, 'frame': {}}
    assert any('i18n key' in g['text'] for g in audit_tree(key)[1]), 'key-as-name not flagged'
    dup = {'nodes': {'a': node('same', 'Button', 'A', on_action=['Click']), 'b': node('same', 'Button', 'B', on_action=['Click'])}, 'frame': {}}
    assert sum(g['rule'] == 3 for g in audit_tree(dup)[1]) == 2, 'duplicate id not flagged'
    slider = {'nodes': {'a': node('s', 'Slider', 'Gain', numeric_value=1.0, on_action=['Increment'])}, 'frame': {}}
    assert sum(g['rule'] == 4 for g in audit_tree(slider)[1]) == 3, 'slider range gaps not flagged'
    nodialog = {'nodes': {'a': node('ok', 'Button', 'Close', on_action=['Click'])}, 'frame': {}}
    assert any(g['rule'] == 5 for g in audit_tree(nodialog, state='dialog-x')[1]), 'missing dialog role not flagged'
    untabbed = audit_tree(good, {'stops': [{'index': 0, 'focused': True, 'hasNode': False}]})[1]
    assert any(g['rule'] == 2 for g in untabbed), 'tab stop without node not flagged'


def report_markdown(results, meta):
    lines = ['## Gaps per route against the L2 floor', '',
             '| Route | Size | Controls | Gaps | Rule 1 | Rule 2 | Rule 3 | Rule 4 | Rule 5 | Tab stops |', '|---|---|---|---|---|---|---|---|---|---|']
    total = {}
    for entry in results:
        if not entry.get('reached'):
            lines.append(f'| {entry["state"]} | {entry["width"]} | - | not reached: {entry["reason"]} | | | | | | |')
            continue
        by = {r: sum(g['rule'] == r for g in entry['gaps']) for r in (1, 2, 3, 4, 5)}
        for r, n in by.items():
            total[r] = total.get(r, 0) + n
        lines.append(f'| {entry["state"]} | {entry["width"]} | {len(entry["controls"])} | {len(entry["gaps"])} | '
                     + ' | '.join(str(by[r]) for r in (1, 2, 3, 4, 5)) + f' | {entry["notes"]["tabStops"]} |')
    lines += ['', f'Total gaps across both sizes: {sum(total.values())} ' + str({f"rule {k}": v for k, v in sorted(total.items())}), '']
    return '\n'.join(lines)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('app', type=Path)
    p.add_argument('out', type=Path)
    p.add_argument('--deadline', type=float, default=600., help='total deadline in seconds, per app run')
    p.add_argument('--step', type=float, default=20., help='per-route step budget in seconds')
    p.add_argument('--report', type=Path, help='write the per-route gap table here')
    p.add_argument('--enforce-floor', action='store_true', help='exit 1 when any gap is found')
    p.add_argument('--self-test', action='store_true', help='check the auditor on fixture trees and exit')
    a = p.parse_args()
    if a.self_test:
        self_test(); print('PASS: auditor self-test'); return 0
    if sys.platform != 'darwin':
        raise SystemExit('Requires macOS')
    self_test()
    app, out = a.app.resolve(strict=True), a.out.absolute()
    flagged = negative_control(app, out / 'negative-control', a.deadline, a.step)
    print('PASS negative control: unlabeled probe flagged:', flagged['probe-unlabeled'])
    code, failure, log = run_app(app, out / 'app', {'SINGZ_GPUI_ACCESSIBILITY_ROUTES_TEST': str(out / 'app' / 'journey')},
                                 a.deadline, a.step)
    panic = re.search(r'panicked at [^\n]*\n[^\n]*', log)
    result = load(out / 'app' / 'journey' / 'result.json')
    last = load(out / 'app' / 'journey' / 'progress.json')
    duplicate_panic = bool(panic and re.search(r'duplicate|already (exists|registered)', panic.group(0), re.I))
    if failure or code != 0 or not result:
        print(f'FAIL: whole-app audit incomplete: {failure or ""} exit={code} last step={last}')
        if panic:
            print('PANIC:', panic.group(0), '(duplicate-id panic)' if duplicate_panic else '')
        print(log[-2000:])
        return 1
    results = audit_run(out / 'app' / 'journey', result['states'])
    inventory = {'backend': result['backend'], 'hidden': result['hidden'], 'muted': True, 'states': results,
                 'unreachable': [r for r in results if not r.get('reached')]}
    (out / 'inventory.json').write_text(json.dumps(inventory, indent=2) + '\n')
    table = report_markdown(results, {})
    (out / 'gaps.md').write_text(table)
    if a.report:
        a.report.write_text(table)
    print(table)
    gap_total = sum(len(r.get('gaps', [])) for r in results)
    print(f'DONE: {len(results)} route states, {gap_total} gaps; inventory at {out / "inventory.json"}')
    return 1 if (a.enforce_floor and gap_total) else 0


if __name__ == '__main__':
    sys.exit(main())
