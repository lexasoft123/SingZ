"""Stateful, loopback-only OAuth/Drive fixture; no Google account or Node.

Run: python3 drive_fixture.py OUTDIR
Stdout contains exactly one flushed JSON object: {"base": "http://127.0.0.1:PORT"}.
Use clientId="fixture-client", clientSecret="fixture-secret" and point authBase,
apiBase and uploadBase at that base. Sign-in uses the real PKCE callback flow.

POST /control accepts reset, resetAuth, resetLedger, files (or seed), pageSize,
repeatPageToken, failNext [{method,path,status,count?,truncateBytes?,corruptBytes?,delayMs?}],
gates {upload|download|list|token|download-first|download-second: bool},
release [gate names], chunkDelayMs, chunkGates [{fileId,gate,afterBytes}].
Seed files contain id/name/mimeType/parents/appProperties/trashed/contentBase64.
/state exposes files, counts, ordered requests, gate handshakes and OAuth counts.
It never exposes credentials, OAuth codes, state nonces or PKCE verifiers.
SIGTERM/SIGINT releases gates, joins bounded workers and writes OUTDIR/state.json.
"""
import base64
import hashlib
import hmac
import http.server
import json
import re
import secrets
import select
import signal
import socket
import threading
import time
import urllib.parse
from pathlib import Path

CLIENT_ID = 'fixture-client'
CLIENT_SECRET = 'fixture-secret'
FOLDER = 'application/vnd.google-apps.folder'
MAX_BODY = 32 * 1024 * 1024
MAX_FILES = 2048
MAX_TOTAL = 256 * 1024 * 1024
ID = re.compile(r'^[A-Za-z0-9_-]{1,1024}$')
QUOTED = r"'(?:\\.|[^'\\])*'"


class FixtureError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class Disconnected(Exception):
    pass


def one(query, name, default=None):
    values = query.get(name)
    if values is None:
        return default
    if len(values) != 1:
        raise FixtureError(400, 'Duplicate request parameter')
    return values[0]


def decode_literal(value):
    return re.sub(r'\\(.)', r'\1', value[1:-1])


def metadata(entry, content=False):
    result = {key: value for key, value in entry.items() if key != '_content'}
    if content:
        result['contentBase64'] = base64.b64encode(entry['_content']).decode('ascii')
    return result


class State:
    def __init__(self):
        self.cv = threading.Condition(threading.RLock())
        self.stopping = threading.Event()
        self.files, self.sessions, self.codes = {}, {}, {}
        self.access, self.refresh = set(), {}
        self.requests, self.counts, self.failures = [], {}, []
        self.sequence, self.next_id = 0, 1
        self.page_size, self.repeat_page_token, self.chunk_delay_ms = 1000, False, 0
        self.oauth = {'authorizations': 0, 'codeExchanges': 0, 'refreshes': 0}
        self.gates = {name: {'blocked': False, 'waiting': 0, 'entered': 0}
                      for name in ('upload', 'download', 'list', 'token', 'download-first', 'download-second')}
        self.chunk_gates = []

    def begin(self, method, path, query, body_size):
        if path in ('/state', '/control'):
            return None
        with self.cv:
            self.sequence += 1
            safe_query = ({'flow': ['oauth']} if path in ('/o/oauth2/v2/auth', '/token')
                          else {key: value for key, value in query.items()
                                if key.lower() not in ('access_token', 'refresh_token', 'id_token',
                                                       'code', 'state', 'client_secret',
                                                       'code_verifier', 'code_challenge')})
            row = {'sequence': self.sequence, 'method': method, 'path': path,
                   'query': safe_query, 'status': None, 'requestBytes': body_size,
                   'responseBytes': 0, 'operation': None, 'cancelled': False}
            self.requests.append(row)
            self.requests = self.requests[-10000:]
            key = method + ' ' + path
            self.counts[key] = self.counts.get(key, 0) + 1
            return row

    def finish(self, row, status, count=0, cancelled=False):
        if row is not None:
            with self.cv:
                row.update(status=status, responseBytes=count, cancelled=cancelled)

    def gate(self, name, handler, row):
        with self.cv:
            gate = self.gates[name]
            gate['entered'] += 1
            if row is not None:
                row['operation'] = name
            if not gate['blocked']:
                return
            gate['waiting'] += 1
            try:
                while gate['blocked']:
                    if self.stopping.is_set() or handler.disconnected():
                        raise Disconnected()
                    self.cv.wait(.05)
            finally:
                gate['waiting'] -= 1
            if self.stopping.is_set() or handler.disconnected():
                raise Disconnected()

    def new_id(self):
        while True:
            value = 'file-' + str(self.next_id)
            self.next_id += 1
            if value not in self.files:
                return value

    def put_file(self, value, content=None):
        if not isinstance(value, dict):
            raise FixtureError(400, 'File metadata must be an object')
        file_id = value.get('id') or self.new_id()
        if not isinstance(file_id, str) or not ID.fullmatch(file_id):
            raise FixtureError(400, 'Invalid fixture file identity')
        name = value.get('name', file_id)
        parents = value.get('parents', ['root'])
        properties = value.get('appProperties', {})
        if (not isinstance(name, str) or len(name) > 16384 or not isinstance(parents, list)
                or not all(isinstance(p, str) and ID.fullmatch(p) for p in parents)
                or not isinstance(properties, dict)):
            raise FixtureError(400, 'Invalid fixture file metadata')
        if content is None:
            try:
                content = base64.b64decode(value.get('contentBase64', ''), validate=True)
            except (ValueError, TypeError):
                raise FixtureError(400, 'Invalid fixture file content') from None
        if len(content) > MAX_BODY:
            raise FixtureError(413, 'Fixture file exceeds limit')
        previous = self.files.get(file_id, {}).get('_content', b'')
        if ((file_id not in self.files and len(self.files) >= MAX_FILES)
                or sum(len(f['_content']) for f in self.files.values()) - len(previous) + len(content) > MAX_TOTAL):
            raise FixtureError(413, 'Fixture storage exceeds limit')
        mime = value.get('mimeType', 'application/octet-stream')
        entry = {'id': file_id, 'name': name, 'mimeType': mime, 'parents': list(parents),
                 'appProperties': dict(properties), 'trashed': bool(value.get('trashed', False)),
                 '_content': content}
        if mime != FOLDER:
            entry.update(size=str(len(content)), md5Checksum=hashlib.md5(content).hexdigest())
        self.files[file_id] = entry
        return entry

    def snapshot(self):
        with self.cv:
            # Copy under the lock; callbacks may update their ledger row later.
            return json.loads(json.dumps({'files': [metadata(f, True) for f in self.files.values()],
                'requests': self.requests, 'counts': self.counts, 'gates': self.gates,
                'oauth': self.oauth, 'pageSize': self.page_size,
                'repeatPageToken': self.repeat_page_token}))

    def control(self, value):
        if not isinstance(value, dict):
            raise FixtureError(400, 'Control requires an object')
        with self.cv:
            if value.get('reset'):
                self.files.clear()
                self.sessions.clear()
                self.failures.clear()
                self.next_id = 1
                self.page_size, self.repeat_page_token, self.chunk_delay_ms = 1000, False, 0
                self.chunk_gates = []
                for gate in self.gates.values():
                    gate['blocked'] = False
            if value.get('resetAuth'):
                self.codes.clear()
                self.access.clear()
                self.refresh.clear()
            if value.get('resetLedger'):
                self.requests.clear()
                self.counts.clear()
            for entry in value.get('files', value.get('seed', [])):
                self.put_file(entry)
            if 'pageSize' in value:
                size = value['pageSize']
                if not isinstance(size, int) or not 1 <= size <= 1000:
                    raise FixtureError(400, 'Invalid fixture page size')
                self.page_size = size
            if 'repeatPageToken' in value:
                self.repeat_page_token = bool(value['repeatPageToken'])
            if 'chunkDelayMs' in value:
                self.chunk_delay_ms = min(1000, max(0, int(value['chunkDelayMs'])))
            if 'chunkGates' in value:
                gates = value['chunkGates']
                if (not isinstance(gates, list) or len(gates) > 2 or any(
                        not isinstance(g, dict) or not ID.fullmatch(str(g.get('fileId', '')))
                        or g.get('gate') not in ('download-first', 'download-second')
                        or not isinstance(g.get('afterBytes'), int) or not 0 < g['afterBytes'] <= MAX_TOTAL
                        for g in gates)):
                    raise FixtureError(400, 'Invalid fixture chunk gate')
                self.chunk_gates = sorted(gates, key=lambda g: g['afterBytes'])
            failures = value.get('failNext', [])
            if isinstance(failures, dict):
                failures = [failures]
            for failure in failures:
                if len(self.failures) >= 1024:
                    raise FixtureError(413, 'Fixture fault queue exceeds limit')
                if (not isinstance(failure, dict) or not isinstance(failure.get('path'), str)
                        or not failure['path'].startswith('/') or failure.get('method', 'GET')
                        not in ('GET', 'POST', 'PATCH', 'PUT', 'DELETE')
                        or not 100 <= int(failure.get('status', 503)) <= 599):
                    raise FixtureError(400, 'Invalid fixture fault')
                self.failures.append(dict(failure, count=min(100, max(1, int(failure.get('count', 1))))))
            for name, blocked in value.get('gates', {}).items():
                if name not in self.gates:
                    raise FixtureError(400, 'Invalid fixture gate')
                self.gates[name]['blocked'] = bool(blocked)
            for name in value.get('release', []):
                if name not in self.gates:
                    raise FixtureError(400, 'Invalid fixture gate')
                self.gates[name]['blocked'] = False
            self.cv.notify_all()

    def fault(self, method, path):
        with self.cv:
            for fault in self.failures:
                prefix = fault['path'].rstrip('/')
                if (fault['count'] and fault.get('method', 'GET') == method
                        and (path == prefix or path.startswith(prefix + '/'))):
                    fault['count'] -= 1
                    return dict(fault)
        return None


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True
    request_queue_size = 32

    def __init__(self):
        self.state = State()
        self.slots = threading.BoundedSemaphore(32)
        super().__init__(('127.0.0.1', 0), Handler)
        self.base = 'http://127.0.0.1:' + str(self.server_port)

    def process_request(self, request, address):
        if not self.slots.acquire(False):
            try:
                request.settimeout(1)
                request.sendall(b'HTTP/1.1 503 Busy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # Never dump a request, credential-bearing body, or authorization header.
        pass

    def stop(self):
        self.state.stopping.set()
        with self.state.cv:
            for gate in self.state.gates.values():
                gate['blocked'] = False
            self.state.cv.notify_all()
        self.shutdown()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'SingZFixture/1'
    sys_version = ''

    def setup(self):
        super().setup()
        self.connection.settimeout(3)

    def log_message(self, *_args):
        pass

    def disconnected(self):
        try:
            ready, _, _ = select.select([self.connection], [], [], 0)
            return bool(ready) and self.connection.recv(1, socket.MSG_PEEK) == b''
        except OSError:
            return True

    def body(self):
        if self.headers.get('Transfer-Encoding'):
            raise FixtureError(400, 'Fixture requires Content-Length')
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) > 1:
            raise FixtureError(400, 'Duplicate Content-Length')
        try:
            length = int(lengths[0]) if lengths else 0
        except ValueError:
            raise FixtureError(400, 'Invalid Content-Length') from None
        if not 0 <= length <= MAX_BODY:
            raise FixtureError(413, 'Fixture request exceeds limit')
        data = self.rfile.read(length)
        if len(data) != length:
            raise Disconnected()
        return data

    def send(self, status, body=b'', headers=None, truncate=None, chunk_delay=0, chunk_gates=()):
        self.send_response(status)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.send_header('Cache-Control', 'no-store')
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.close_connection = True
        data = body if truncate is None else body[:max(0, truncate)]
        gate_index = 0
        for offset in range(0, len(data), 16384):
            if self.server.state.stopping.is_set():
                raise Disconnected()
            self.wfile.write(data[offset:offset + 16384])
            self.wfile.flush()
            sent = min(offset + 16384, len(data))
            if chunk_gates and self.row is not None:
                with self.server.state.cv:
                    self.row['streamedBytes'] = sent
            while gate_index < len(chunk_gates) and sent >= chunk_gates[gate_index]['afterBytes']:
                self.server.state.gate(chunk_gates[gate_index]['gate'], self, None)
                gate_index += 1
            if chunk_delay:
                self.server.state.stopping.wait(chunk_delay / 1000)
        self.server.state.finish(self.row, status, len(data))

    def json(self, status, value, headers=None):
        self.send(status, json.dumps(value, separators=(',', ':')).encode(),
                  {'Content-Type': 'application/json', **(headers or {})})

    def run_request(self):
        self.row = None
        try:
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.scheme or parsed.netloc or parsed.fragment or len(self.path) > 65536:
                raise FixtureError(400, 'Invalid fixture request target')
            path = parsed.path
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True, max_num_fields=100)
            data = self.body()
            self.row = self.server.state.begin(self.command, path, query, len(data))
            if path == '/state' and self.command == 'GET':
                return self.json(200, self.server.state.snapshot())
            if path == '/control' and self.command == 'POST':
                self.server.state.control(json.loads(data))
                return self.json(200, {'ok': True})
            if path == '/o/oauth2/v2/auth' and self.command == 'GET':
                return self.authorize(query)
            if path == '/token' and self.command == 'POST':
                self.server.state.gate('token', self, self.row)
                fault = self.server.state.fault(self.command, path)
                if fault:
                    return self.json(int(fault.get('status', 503)), {'error': 'fixture_token_fault'})
                return self.token(urllib.parse.parse_qs(data.decode(), keep_blank_values=True, max_num_fields=20))
            with self.server.state.cv:
                authorized = self.headers.get('Authorization', '') in {
                    'Bearer ' + token for token in self.server.state.access}
            if not authorized:
                return self.json(401, {'error': 'fixture_unauthorized'})
            fault = self.server.state.fault(self.command, path)
            if fault and 'truncateBytes' not in fault and 'corruptBytes' not in fault:
                if fault.get('delayMs'):
                    self.server.state.stopping.wait(min(30000, int(fault['delayMs'])) / 1000)
                return self.json(int(fault.get('status', 503)), {'error': 'fixture_fault'})
            if path == '/drive/v3/files' and self.command == 'GET':
                self.server.state.gate('list', self, self.row)
                return self.list_files(query)
            if path == '/drive/v3/files' and self.command == 'POST':
                with self.server.state.cv:
                    entry = self.server.state.put_file(json.loads(data))
                    return self.json(200, metadata(entry))
            match = re.fullmatch(r'/drive/v3/files/([A-Za-z0-9_-]+)', path)
            if match:
                return self.file(match[1], query, data, fault)
            match = re.fullmatch(r'/upload/drive/v3/files(?:/([A-Za-z0-9_-]+))?', path)
            if match and self.command in ('POST', 'PATCH'):
                return self.upload_start(match[1], query, data)
            match = re.fullmatch(r'/upload-session/([A-Za-z0-9_-]+)', path)
            if match and self.command == 'PUT':
                return self.upload_finish(match[1], data)
            raise FixtureError(404, 'Unknown fixture route')
        except Disconnected:
            self.server.state.finish(self.row, 499, cancelled=True)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            self.server.state.finish(self.row, 499, cancelled=True)
        except FixtureError as error:
            try:
                self.json(error.status, {'error': error.message})
            except OSError:
                self.server.state.finish(self.row, 499, cancelled=True)
        except (ValueError, TypeError, KeyError, UnicodeError):
            try:
                self.json(400, {'error': 'Invalid fixture request'})
            except OSError:
                self.server.state.finish(self.row, 499, cancelled=True)

    do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = run_request

    def authorize(self, query):
        redirect = one(query, 'redirect_uri', '')
        target = urllib.parse.urlsplit(redirect)
        state, challenge = one(query, 'state', ''), one(query, 'code_challenge', '')
        if (one(query, 'client_id') != CLIENT_ID or one(query, 'response_type') != 'code'
                or one(query, 'scope') != 'https://www.googleapis.com/auth/drive.file'
                or one(query, 'code_challenge_method') != 'S256'
                or not re.fullmatch(r'[A-Za-z0-9_-]{43}', challenge)
                or not state or len(state) > 256 or any(ord(c) < 32 for c in state)
                or target.scheme != 'http' or target.hostname != '127.0.0.1'
                or not target.port or target.username or target.password or target.fragment
                or target.query or target.path != '/oauth2/callback'):
            raise FixtureError(400, 'Invalid fixture OAuth authorization')
        code = 'fixture-code-' + secrets.token_urlsafe(24)
        with self.server.state.cv:
            self.server.state.codes = {key: value for key, value in self.server.state.codes.items()
                                       if value['expires'] >= time.monotonic()}
            if len(self.server.state.codes) >= 4096:
                raise FixtureError(429, 'Fixture authorization queue exceeds limit')
            self.server.state.codes[code] = {'redirect': redirect, 'challenge': challenge,
                                            'state': state,
                                            'expires': time.monotonic() + 300}
            self.server.state.oauth['authorizations'] += 1
        location = redirect + '?' + urllib.parse.urlencode({'code': code, 'state': state})
        self.send(302, headers={'Location': location})

    def token(self, form):
        if one(form, 'client_id') != CLIENT_ID or one(form, 'client_secret', '') != CLIENT_SECRET:
            return self.json(400, {'error': 'invalid_client'})
        with self.server.state.cv:
            grant = one(form, 'grant_type')
            if grant == 'authorization_code':
                code = self.server.state.codes.pop(one(form, 'code', ''), None)
                verifier = one(form, 'code_verifier', '')
                challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
                if (not code or code['expires'] < time.monotonic()
                        or one(form, 'redirect_uri') != code['redirect']
                        or not re.fullmatch(r'[A-Za-z0-9._~-]{43,128}', verifier)
                        or not hmac.compare_digest(challenge, code['challenge'])):
                    return self.json(400, {'error': 'invalid_grant'})
                refresh = 'fixture-refresh-' + secrets.token_urlsafe(24)
                self.server.state.refresh[refresh] = CLIENT_ID
                self.server.state.oauth['codeExchanges'] += 1
            elif grant == 'refresh_token':
                refresh = one(form, 'refresh_token', '')
                if refresh not in self.server.state.refresh:
                    return self.json(400, {'error': 'invalid_grant'})
                self.server.state.oauth['refreshes'] += 1
            else:
                return self.json(400, {'error': 'unsupported_grant_type'})
            access = 'fixture-access-' + secrets.token_urlsafe(24)
            if len(self.server.state.access) >= 4096:
                self.server.state.access.pop()
            self.server.state.access.add(access)
        self.json(200, {'access_token': access, 'refresh_token': refresh, 'expires_in': 3600})

    def list_files(self, query):
        expression = one(query, 'q', '')
        filters = {}
        for key in ('name', 'mimeType'):
            match = re.search(r'\b' + key + r'\s*=\s*(' + QUOTED + ')', expression)
            if match:
                filters[key] = decode_literal(match[1])
        parents = [decode_literal(match[1]) for match in re.finditer('(' + QUOTED + r')\s+in\s+parents', expression)]
        trashed = re.search(r'\btrashed\s*=\s*(true|false)\b', expression)
        with self.server.state.cv:
            files = [f for f in self.server.state.files.values()
                     if all(f.get(k) == v for k, v in filters.items())
                     and (not parents or any(parent in f['parents'] for parent in parents))
                     and (not trashed or f['trashed'] == (trashed[1] == 'true'))]
            files.sort(key=lambda f: f['id'])
            token = one(query, 'pageToken', '')
            if token == 'fixture-repeat' and self.server.state.repeat_page_token:
                offset = 0
            elif token and (not token.isdigit() or len(token) > 10):
                raise FixtureError(400, 'Invalid fixture page token')
            else:
                offset = int(token or '0')
            size = min(self.server.state.page_size, max(1, min(1000, int(one(query, 'pageSize', '1000')))))
            result = {'files': [metadata(f) for f in files[offset:offset + size]]}
            if self.server.state.repeat_page_token:
                result['nextPageToken'] = 'fixture-repeat'
            elif offset + size < len(files):
                result['nextPageToken'] = str(offset + size)
        self.json(200, result)

    def file(self, file_id, query, data, fault):
        if self.command == 'GET' and one(query, 'alt') == 'media':
            self.server.state.gate('download', self, self.row)
            with self.server.state.cv:
                entry = self.server.state.files.get(file_id)
                if not entry or entry['trashed']:
                    raise FixtureError(404, 'Fixture file not found')
                content, mime = entry['_content'], entry['mimeType']
                delay = self.server.state.chunk_delay_ms
                gates = [g for g in self.server.state.chunk_gates if g['fileId'] == file_id]
            if fault and fault.get('corruptBytes') and content:
                # Integrity failure with a complete HTTP response: preserve
                # listing size/checksum and body length while changing one byte.
                # The stored remote payload is never changed by this fault.
                content = bytes([content[0] ^ 1]) + content[1:]
            return self.send(200, content, {'Content-Type': mime},
                             truncate=int(fault['truncateBytes']) if fault and 'truncateBytes' in fault else None, chunk_delay=delay,
                             chunk_gates=gates)
        with self.server.state.cv:
            entry = self.server.state.files.get(file_id)
            if not entry:
                raise FixtureError(404, 'Fixture file not found')
            if self.command == 'GET':
                return self.json(200, metadata(entry))
            if self.command == 'PATCH':
                patch = json.loads(data)
                if not isinstance(patch, dict):
                    raise FixtureError(400, 'Invalid fixture patch')
                update = metadata(entry)
                for key in ('name', 'trashed', 'mimeType', 'parents'):
                    if key in patch:
                        update[key] = patch[key]
                if 'appProperties' in patch:
                    update['appProperties'] = dict(entry['appProperties'])
                    update['appProperties'].update(patch['appProperties'])
                    update['appProperties'] = {k: v for k, v in update['appProperties'].items() if v is not None}
                return self.json(200, metadata(self.server.state.put_file(update, entry['_content'])))
            if self.command == 'DELETE':
                del self.server.state.files[file_id]
                return self.send(204)
        raise FixtureError(405, 'Unsupported fixture file method')

    def upload_start(self, file_id, query, data):
        if one(query, 'uploadType') != 'resumable' or (file_id is None) != (self.command == 'POST'):
            raise FixtureError(400, 'Invalid fixture upload initiation')
        document = json.loads(data)
        if not isinstance(document, dict):
            raise FixtureError(400, 'Upload metadata must be an object')
        with self.server.state.cv:
            if file_id is not None and file_id not in self.server.state.files:
                raise FixtureError(404, 'Fixture upload target missing')
            session = 'session-' + secrets.token_urlsafe(16)
            self.server.state.sessions[session] = {'id': file_id, 'metadata': document,
                                                  'expires': time.monotonic() + 300}
        self.send(200, headers={'Location': self.server.base + '/upload-session/' + session})

    def upload_finish(self, session, data):
        self.server.state.gate('upload', self, self.row)
        with self.server.state.cv:
            pending = self.server.state.sessions.get(session)
            if not pending or pending['expires'] < time.monotonic():
                raise FixtureError(404, 'Fixture upload session expired')
            document = (metadata(self.server.state.files[pending['id']]) if pending['id'] else {})
            document.update(pending['metadata'])
            document['mimeType'] = self.headers.get('Content-Type', 'application/octet-stream')
            entry = self.server.state.put_file(document, data)
            pending['id'] = entry['id']
            self.json(200, metadata(entry))


def main():
    import sys
    if len(sys.argv) != 2:
        raise SystemExit('Usage: drive_fixture.py OUTDIR')
    output = Path(sys.argv[1]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    server = Server()
    terminating = threading.Event()

    def stop(_signal, _frame):
        if not terminating.is_set():
            terminating.set()
            threading.Thread(target=server.stop, name='fixture-shutdown').start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(json.dumps({'base': server.base}), flush=True)
    try:
        server.serve_forever(poll_interval=.05)
    finally:
        server.state.stopping.set()
        with server.state.cv:
            for gate in server.state.gates.values():
                gate['blocked'] = False
            server.state.cv.notify_all()
        server.server_close()
        temporary = output / '.state.json.tmp'
        temporary.write_text(json.dumps(server.state.snapshot(), indent=2))
        temporary.replace(output / 'state.json')


if __name__ == '__main__':
    main()
