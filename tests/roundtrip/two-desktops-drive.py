"""Reuse the native Drive fixture with Google's upload-session URL authority.

The authenticated initiation creates a secret, expiring session URL. Electron
uses that URL without repeating Authorization; native repeats the header. Both
are valid Drive clients. All storage, requests, OAuth and faults stay shared.
"""
import importlib.util
import re
import time
from pathlib import Path

source = Path(__file__).resolve().parents[2] / 'experiments/gpui-player/tests/drive_fixture.py'
spec = importlib.util.spec_from_file_location('drive_fixture', source)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
original = fixture.Handler.run_request


def run_request(self):
    match = re.fullmatch(r'/upload-session/([A-Za-z0-9_-]+)', self.path)
    if self.command == 'PUT' and match and not self.headers.get('Authorization'):
        with self.server.state.cv:
            session = self.server.state.sessions.get(match[1])
            if session and session['expires'] >= time.monotonic() and self.server.state.access:
                self.headers['Authorization'] = 'Bearer ' + next(iter(self.server.state.access))
    return original(self)


fixture.Handler.do_PUT = run_request
fixture.main()
