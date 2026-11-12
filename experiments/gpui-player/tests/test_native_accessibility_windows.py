#!/usr/bin/env python3
"""Windows accessibility, D-06 floor (C-61): the whole native app read through UI Automation.

The Windows counterpart of test_native_accessibility.py. The app is the real Player root, driven through every
route and dialog of the fixture at both record sizes by ui_accessibility_routes.rs, exactly as on macOS. What
differs is the readback: macOS reads its own AX tree in process; here an out-of-process UI Automation client
(this script, comtypes) reads the window through the same adapter Narrator uses, once per state, on a hand-
shake through the app's progress file. The judge is the macOS judge (named, role-bearing, modal dialogs; Tab
rings equal to the checked-in lists; Escape closes and focus returns; live regions; headings; named song rows)
applied to the UIA rows, plus the UIA-specific rules in judge_uia: control type, name, patterns and live setting.

    test_native_accessibility_windows.py APP OUT [--deadline S] [--step S]

Run it in the logged-in desktop session (a one-off interactive scheduled task), never session zero, with a
debug `ui-tests` build: a duplicate node id panics only there. Needs `comtypes` in the Python that runs it
(`python -m venv V && V\\Scripts\\pip install comtypes`; no admin). `--self-test` needs neither the app nor Windows."""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_native_accessibility as mac  # noqa: E402  (the judge and the checked-in Tab lists)

routes = mac.routes
# What differs on Windows by product design, not by accessibility: Settings has an update section there (a check
# button, then the beta row), and its beta row is a check row whose row, not its glyph, is the control.
mac.EXPECTED_TAB_ORDER['settings'] = ['settings-update-check', 'settings-update-beta-row'] + mac.EXPECTED_TAB_ORDER['settings']
mac.HIDDEN_FROM_AX = mac.HIDDEN_FROM_AX + ('settings-update-beta',)
# The app writes UTF-8; Windows Python would read it in the console code page and turn "…" into mojibake.
routes.load = lambda path: json.loads(path.read_text(encoding='utf-8')) if path.exists() else None

# UI Automation ids (UIAutomationClient.h): properties, patterns, control types.
P = dict(name=30005, control_type=30003, localized=30004, automation_id=30011, enabled=30010, focusable=30009,
         has_focus=30008, offscreen=30022, aria_role=30101, live=30135, is_dialog=30174, is_modal=30077)
PAT = dict(invoke=10000, range=10003, selection_item=10010, toggle=10015, value=10002, expand=10005, window=10009)
BUTTON, CHECKBOX, EDIT, HYPERLINK, LISTITEM, MENU, MENUITEM, RADIO, SLIDER, SPINNER, STATUSBAR, TABITEM, TEXT, WINDOW = (
    50000, 50002, 50004, 50005, 50007, 50009, 50011, 50013, 50015, 50016, 50017, 50019, 50020, 50032)
# AccessKit role (as the debug tree spells it) -> the UIA control type accesskit_windows gives it.
CONTROL_TYPE = {'Button': BUTTON, 'CheckBox': CHECKBOX, 'RadioButton': RADIO, 'MenuItemRadio': RADIO, 'Switch': BUTTON,
                'MenuItemCheckBox': CHECKBOX, 'Slider': SLIDER, 'SpinButton': SPINNER, 'Tab': TABITEM, 'Link': HYPERLINK,
                'MenuItem': MENUITEM, 'ListBoxOption': LISTITEM, 'TextInput': EDIT, 'MultilineTextInput': EDIT,
                'SearchInput': EDIT, 'Dialog': WINDOW, 'AlertDialog': WINDOW, 'Menu': MENU, 'Status': STATUSBAR,
                'Alert': TEXT, 'Label': TEXT, 'Heading': TEXT}
LIVE_OFF, LIVE_POLITE, LIVE_ASSERTIVE = 0, 1, 2
LIVE_REGIONS = {'live-notice': LIVE_ASSERTIVE, 'live-toast': LIVE_POLITE, 'live-status': LIVE_POLITE}


# ---------------------------------------------------------------------------------------------- the UIA client
class Client:
    """One UIA connection to the window of one process. Reads only; sends no input."""

    def __init__(self):
        import comtypes.client
        comtypes.client.GetModule('UIAutomationCore.dll')
        from comtypes.gen import UIAutomationClient as U
        self.U = U
        self.auto = comtypes.client.CreateObject(U.CUIAutomation, interface=U.IUIAutomation)
        cache = self.auto.CreateCacheRequest()
        for pid in P.values():
            cache.AddProperty(pid)
        for pid in PAT.values():
            cache.AddPattern(pid)
        cache.TreeScope = U.TreeScope_Subtree
        cache.TreeFilter = self.auto.RawViewCondition
        self.cache = cache

    @staticmethod
    def window_handles(pid):
        import ctypes
        from ctypes import wintypes
        found = []
        proc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

        def each(hwnd, _):
            owner = wintypes.DWORD()
            ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value == pid:
                found.append(hwnd)
            return True
        ctypes.windll.user32.EnumWindows(proc(each), 0)
        return found

    def root(self, pid):
        """The app's main window element: the top-level window of the process with the largest subtree."""
        best, size = None, -1
        for hwnd in self.window_handles(pid):
            try:
                element = self.auto.ElementFromHandle(hwnd)
                count = len(self.walk(element.BuildUpdatedCache(self.cache)))
            except Exception:  # noqa: BLE001  (COM raises on windows that have no provider)
                continue
            if count > size:
                best, size = element, count
        return best

    def prop(self, element, key):
        value = element.GetCachedPropertyValue(P[key])
        return value if isinstance(value, (bool, int, float, str)) else None

    def pattern(self, element, key, interface):
        try:
            raw = element.GetCachedPattern(PAT[key])
            return raw.QueryInterface(interface) if raw else None
        except Exception:  # noqa: BLE001
            return None

    def walk(self, element, depth=0):
        rows = [(element, depth)]
        children = element.GetCachedChildren()
        for i in range(children.Length if children else 0):
            rows += self.walk(children.GetElement(i), depth + 1)
        return rows

    def row(self, element, depth):
        U = self.U
        row = {'depth': depth, 'id': self.prop(element, 'automation_id') or '', 'name': self.prop(element, 'name') or '',
               'controlType': self.prop(element, 'control_type'), 'localized': self.prop(element, 'localized') or '',
               'ariaRole': self.prop(element, 'aria_role') or '', 'enabled': self.prop(element, 'enabled'),
               'focusable': self.prop(element, 'focusable'), 'hasFocus': self.prop(element, 'has_focus'),
               'offscreen': self.prop(element, 'offscreen'), 'live': self.prop(element, 'live') or 0,
               'isDialog': bool(self.prop(element, 'is_dialog')), 'isModal': bool(self.prop(element, 'is_modal')),
               'patterns': []}
        for key, interface in (('invoke', U.IUIAutomationInvokePattern), ('toggle', U.IUIAutomationTogglePattern),
                               ('selection_item', U.IUIAutomationSelectionItemPattern),
                               ('range', U.IUIAutomationRangeValuePattern), ('value', U.IUIAutomationValuePattern),
                               ('expand', U.IUIAutomationExpandCollapsePattern)):
            found = self.pattern(element, key, interface)
            if not found:
                continue
            row['patterns'].append(key)
            if key == 'toggle':
                row['toggle'] = found.CurrentToggleState
            elif key == 'selection_item':
                row['selected'] = bool(found.CurrentIsSelected)
            elif key == 'range':
                row['range'] = [found.CurrentMinimum, found.CurrentValue, found.CurrentMaximum]
            elif key == 'value':
                row['value'] = found.CurrentValue
            elif key == 'expand':
                row['expand'] = found.CurrentExpandCollapseState
        return row

    def dump(self, pid):
        root = self.root(pid)
        if root is None:
            return None
        return [self.row(e, d) for e, d in self.walk(root.BuildUpdatedCache(self.cache))]


# ------------------------------------------------------------------------------------------ judging UIA rows
def as_native(rows):
    """The UIA rows in the shape the macOS judge reads: identified nodes only, role/subrole/modal/title/value."""
    native = []
    for r in rows:
        if not r['id']:
            continue
        native.append({'id': r['id'], 'role': 'AXTextField' if r['controlType'] == EDIT else r['localized'],
                       'subrole': 'AXDialog' if r['isDialog'] else None, 'modal': r['isModal'],
                       'title': r['name'], 'value': r.get('value') if r.get('value') not in (None, '') else r['name'],
                       'enabled': r['enabled']})
    return native


def judge_uia(entry, tree, rows):
    """UIA-specific findings, beyond the macOS judge: the platform tree says what the GPUI tree says.

    Per control with a plain id: it is there, with the control type, name, patterns and state that AccessKit's
    mapping owes its role. Per live region: the live setting. A dialog is a Window with IsDialog and IsModal."""
    where = f'{entry["state"]}@{entry["width"]}'
    fails, by_id = [], {}
    for r in rows:
        if r['id']:
            by_id.setdefault(r['id'], r)
    for key, node, aria, role, actions in routes.controls(tree):
        name = routes.element_name(node)
        if not name or not (node.get('element_id') or '').startswith('Name(') or name == 'input-state' or name in mac.HIDDEN_FROM_AX \
                or name.endswith('-check'):
            continue
        r = by_id.get(name)
        if r is None:
            continue  # absence is the macOS judge's rule 1
        want = CONTROL_TYPE.get(role)
        if want and r['controlType'] != want:
            fails.append(f'{where}: {name}: UIA control type {r["controlType"]}, a {role} is {want}')
        label = (aria.get('label') or '').strip()
        if label and r['name'].strip() != label:
            fails.append(f'{where}: {name}: UIA name {r["name"]!r} differs from the label {label!r}')
        if not r['name'].strip():
            fails.append(f'{where}: {name}: UIA name is empty')
        if 'Click' in actions and not {'invoke', 'toggle', 'selection_item', 'expand'} & set(r['patterns']):
            fails.append(f'{where}: {name}: has a Click action but no Invoke, Toggle, SelectionItem or ExpandCollapse pattern')
        if aria.get('toggled') is not None and role not in routes.SELECT_ROLES and 'toggle' not in r['patterns']:  # radios are SelectionItem
            fails.append(f'{where}: {name}: toggled but exposes no Toggle pattern')
        if (aria.get('selected') is not None or aria.get('toggled') is not None) and role in routes.SELECT_ROLES \
                and 'selection_item' not in r['patterns']:
            fails.append(f'{where}: {name}: selected but exposes no SelectionItem pattern')
        if role == 'Slider' and 'range' not in r['patterns']:
            fails.append(f'{where}: {name}: slider exposes no RangeValue pattern')
    # Whatever the tree says, an operable UIA element with no name is a gap: Narrator would say only "button".
    for i, r in enumerate(rows):
        if {'invoke', 'toggle', 'selection_item', 'range', 'expand'} & set(r['patterns']) and not r['name'].strip():
            fails.append(f'{where}: {r["id"] or "<no id, UIA row " + str(i) + ">"}: operable UIA element has no name')
    for ident, setting in ({} if entry['state'] == 'probe' else LIVE_REGIONS).items():  # the probe host has none
        row = by_id.get(ident)
        if row is None:
            fails.append(f'{where}: live region {ident} is not in the UIA tree')
        elif row['live'] != setting:
            fails.append(f'{where}: {ident}: UIA live setting {row["live"]}, expected {setting}')
    for r in rows:
        if r['isDialog'] and (r['controlType'] != WINDOW or not r['name'].strip()):
            fails.append(f'{where}: dialog {r["id"]!r} is not a named Window control')
    heads = [r for r in rows if r['ariaRole'] == 'heading']
    if entry['state'] in mac.HEADING_STATES and not any(h['name'].strip() for h in heads):
        fails.append(f'{where}: no UIA node with the heading role and a name')
    return fails


def judge_state(entry, tree, tab, back, rows):
    return mac.judge_state(entry, tree, tab, back, as_native(rows)) + judge_uia(entry, tree, rows)


def judge_run(journey, entries, log):
    fails = []
    if 'Duplicate a11y node id' in log or 'panicked' in log:
        fails.append('the debug build panicked: ' + routes.re.search(r'panicked at [^\n]*\n[^\n]*', log).group(0))
    reached = {(e['state'], e['width']) for e in entries if e.get('reached')}
    for width in routes.SIZES:
        for state in mac.ROUTE_STATES + mac.MODAL_STATES + mac.POPOVER_STATES + ('toast', 'status') + tuple(mac.ANNOUNCEMENTS):
            if (state, width) not in reached:
                fails.append(f'{state}@{width} was not reached')
    for e in entries:
        if not e.get('reached') and e['state'] not in mac.UNREACHED_ON_FIXTURE:
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


# --------------------------------------------------------------------------------------------- running the app
def kill_tree(child):
    """Kill the app and anything it started; never leave a child behind."""
    subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], capture_output=True, timeout=30)
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def run_app(app, out, env_extra, deadline, step, client, log_name='app.log'):
    """Run the hidden muted app under a total deadline and a per-step budget, serving its UIA readbacks.

    Every loop turn the client touches the window, which is what activates AccessKit's adapter, and when the app
    announces phase "uia" for a state the client writes that state's rows to `<state>-<width>.native.json`."""
    out.mkdir(parents=True, exist_ok=False)
    private = out / 'private'
    for name in ('prefs', 'library', 'cache', 'tmp', 'pack', 'models'):
        (private / name).mkdir(parents=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_')}
    env.update(SINGZ_GPUI_DEMO='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_MUTE='1', SINGZ_NO_SYNC='1',
               SINGZ_NO_SYSTEM_ENGINES='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
               SINGZ_GPUI_CONFIG_DIR=str(private / 'prefs'), SINGZ_GPUI_PROJECTS_ROOT=str(private / 'library'),
               SINGZ_PACK_DIR=str(private / 'pack'), SINGZ_MODELS_DIR=str(private / 'models'),
               TEMP=str(private / 'tmp'), TMP=str(private / 'tmp'), XDG_CACHE_HOME=str(private / 'cache'),
               PYTHONDONTWRITEBYTECODE='1', SINGZ_A11Y_STEP_SECONDS=str(step), RUST_BACKTRACE='0', RUST_LOG='gpui=info')
    env.update(env_extra)
    journey = out / 'journey'
    started, failure, served = time.monotonic(), None, set()
    with (out / log_name).open('w') as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT,
                                 creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        try:
            while child.poll() is None:
                if time.monotonic() - started > deadline:
                    failure = f'total deadline of {deadline:.0f}s expired'
                    break
                try:
                    seen = json.loads((journey / 'progress.json').read_text())
                except (OSError, ValueError):
                    seen = None
                if seen:
                    age = time.time() - seen['epochMs'] / 1000
                    if seen['phase'] == 'open' and age > step + 2:
                        failure = f'step {seen["state"]}@{seen["width"]} exceeded its {step:.0f}s budget'
                        break
                    if seen['phase'] == 'capture' and age > step + 30:
                        failure = f'capture of {seen["state"]}@{seen["width"]} exceeded its budget'
                        break
                tag = f'{seen["state"]}-{seen["width"]}' if seen else None
                if seen and seen['phase'] == 'uia' and tag not in served:
                    rows = client.dump(child.pid)
                    if rows:
                        target = journey / f'{tag}.uia.json'
                        target.write_text(json.dumps(rows, indent=1))
                        os.replace(target, journey / f'{tag}.native.json')
                        served.add(tag)
                        continue
                else:
                    client.root(child.pid)  # touching the window is what activates the adapter
                time.sleep(.05)
        finally:
            if child.poll() is None:
                kill_tree(child)
    return child.returncode, failure, (out / log_name).read_text(errors='replace')


def negative_control(app, out, deadline, step, client):
    """A probe host with one named and one unnamed control: the UIA readback must name the first, flag the second."""
    code, failure, log = run_app(app, out, {'SINGZ_GPUI_ACCESSIBILITY_ROUTES_TEST': str(out / 'journey'),
                                            'SINGZ_GPUI_ACCESSIBILITY_ROUTES_INJECT': '1'}, deadline, step, client)
    assert failure is None and code == 0, f'negative-control probe did not exit cleanly: {failure} code={code}\n{log[-3000:]}'
    result = routes.load(out / 'journey' / 'result.json')
    assert result and result['passed'] and result['inject'], 'negative-control probe produced no result'
    entry = {'state': 'probe', 'width': result['states'][0]['width']}
    tag = f'probe-{entry["width"]}'
    tree, rows = routes.load(out / 'journey' / f'{tag}.tree.json'), routes.load(out / 'journey' / f'{tag}.native.json')
    by_id = {r['id']: r for r in rows if r['id']}
    assert by_id.get('probe-named', {}).get('name') == 'Named control', f'named control not read through UIA: {by_id.get("probe-named")}'
    fails = judge_uia(entry, tree, rows)
    assert any('no id' in f and 'has no name' in f for f in fails), f'unlabeled control NOT flagged through UIA: {fails}'
    assert not any('probe-named' in f for f in fails), f'named control wrongly flagged: {fails}'
    return [f for f in fails if 'has no name' in f]


def whole_app(app, out, deadline=900., step=20.):
    if 'debug' not in app.parts:
        raise SystemExit('The whole-app audit needs a debug build: a duplicate node id panics only there')
    self_test()
    client = Client()
    flagged = negative_control(app, out / 'negative-control', deadline, step, client)
    code, failure, log = run_app(app, out / 'app', {'SINGZ_GPUI_ACCESSIBILITY_ROUTES_TEST': str(out / 'app' / 'journey')},
                                 deadline, step, client)
    journey = out / 'app' / 'journey'
    result = routes.load(journey / 'result.json')
    assert not failure and code == 0 and result, f'whole-app run incomplete: {failure} exit={code}\n{log[-3000:]}'
    entries = result['states']
    observed = mac.tab_order_of(journey, entries)
    (out / 'tab-order.observed.json').write_text(json.dumps(observed, indent=1, sort_keys=True) + '\n')
    fails = judge_run(journey, entries, log)
    for e in entries:  # sizes must agree on the Tab ring
        if e.get('reached') and e['width'] != routes.SIZES[0]:
            other = routes.load(journey / f'{e["state"]}-{e["width"]}.tab.json')
            if [mac.element_of(s['id']) for s in other['stops']] != observed.get(e['state']):
                fails.append(f'{e["state"]}: Tab ring differs between window sizes')
    return flagged, entries, fails


# ------------------------------------------------------------------------------------------------- self test
def self_test():
    """The UIA rules must reject each defect they exist to catch (no app, no Windows)."""
    def uia(id_, ctype, name, **extra):
        return {'depth': 1, 'id': id_, 'name': name, 'controlType': ctype, 'localized': '', 'ariaRole': '', 'enabled': True,
                'focusable': True, 'hasFocus': False, 'offscreen': False, 'live': 0, 'isDialog': False, 'isModal': False,
                'patterns': ['invoke'], **extra}
    def tree(role='Button', **aria):
        return {'nodes': {'a': {'element_id': 'Name("ok")', 'aria': {'role': role, 'label': 'Add track', 'on_action': ['Click'], **aria}}}, 'frame': {}}
    entry = {'state': 'library', 'width': 1280}
    live = [uia(i, STATUSBAR, '', live=s, patterns=[]) for i, s in LIVE_REGIONS.items()]
    heading = [uia('route-heading', TEXT, 'Songs', ariaRole='heading', patterns=[])]
    good = [uia('ok', BUTTON, 'Add track')] + live + heading
    assert not judge_uia(entry, tree(), good), judge_uia(entry, tree(), good)
    cases = {
        'control type': ([uia('ok', TEXT, 'Add track')] + live + heading, tree()),
        'name': ([uia('ok', BUTTON, 'Other')] + live + heading, tree()),
        'empty name': ([uia('ok', BUTTON, '')] + live + heading, tree()),
        'no Invoke': ([uia('ok', BUTTON, 'Add track', patterns=[])] + live + heading, tree()),
        'no Toggle': ([uia('ok', CHECKBOX, 'Add track')] + live + heading, tree('CheckBox', toggled=False)),
        'radio without selection': ([uia('ok', RADIO, 'Add track', patterns=[])] + live + heading, tree('RadioButton', selected=True)),
        'no RangeValue': ([uia('ok', SLIDER, 'Add track')] + live + heading, tree('Slider')),
        'live setting': ([uia('ok', BUTTON, 'Add track')] + [uia(i, STATUSBAR, '', live=LIVE_OFF, patterns=[]) for i in LIVE_REGIONS] + heading, tree()),
        'missing live region': ([uia('ok', BUTTON, 'Add track')] + heading, tree()),
        'anonymous unnamed button': ([uia('ok', BUTTON, 'Add track'), uia('', BUTTON, '')] + live + heading, tree()),
        'no heading': ([uia('ok', BUTTON, 'Add track')] + live, tree()),
        'dialog not a window': ([uia('ok', BUTTON, 'Add track'), uia('dlg', BUTTON, 'Notice', isDialog=True)] + live + heading, tree()),
    }
    for what, (rows, tr) in cases.items():
        assert judge_uia(entry, tr, rows), f'UIA judge accepted a defect: {what}'
    native = as_native([uia('dlg', WINDOW, 'Notice', isDialog=True, isModal=True), uia('', BUTTON, 'anonymous')])
    assert native == [{'id': 'dlg', 'role': '', 'subrole': 'AXDialog', 'modal': True, 'title': 'Notice', 'value': 'Notice', 'enabled': True}]
    mac.self_test_judge()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('app', type=Path, nargs='?')
    p.add_argument('out', type=Path, nargs='?')
    p.add_argument('--deadline', type=float, default=900., help='total deadline in seconds, per app run')
    p.add_argument('--step', type=float, default=20., help='per-state step budget in seconds')
    p.add_argument('--rejudge', type=Path, metavar='RUN_DIR', help='judge a finished run directory again (no app, any OS)')
    p.add_argument('--self-test', action='store_true', help='check the judge on fixtures and exit')
    a = p.parse_args()
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # findings carry names the console code page cannot encode
    if a.self_test:
        self_test()
        print('PASS: Windows UIA judge self-test')
        return 0
    if a.rejudge:
        journey = a.rejudge / 'app' / 'journey'
        fails = judge_run(journey, routes.load(journey / 'result.json')['states'], (a.rejudge / 'app' / 'app.log').read_text(errors='replace'))
        print(f'{len(fails)} findings' + ''.join('\n  ' + f for f in fails))
        return 1 if fails else 0
    if sys.platform != 'win32' or not a.app or not a.out:
        raise SystemExit('Requires Windows, an app and an output directory')
    app, out = a.app.resolve(strict=True), a.out.absolute()
    flagged, entries, fails = whole_app(app, out, a.deadline, a.step)
    reached = sorted({e['state'] for e in entries if e.get('reached')})
    (out / 'validation.json').write_text(json.dumps({'passed': not fails, 'findings': fails, 'negativeControl': flagged,
        'statesReached': reached, 'sizes': list(routes.SIZES),
        'scope': 'Real UIA on the production Player root, D-06 floor rules 1-6 and live regions; Narrator walk is human'}, indent=2) + '\n')
    if fails:
        print(f'FAIL: {len(fails)} accessibility findings:\n  ' + '\n  '.join(fails))
        return 1
    print('PASS: whole-app Windows UIA audit on', len(reached), 'states at both sizes; negative control:', flagged)
    return 0


if __name__ == '__main__':
    sys.exit(main())
