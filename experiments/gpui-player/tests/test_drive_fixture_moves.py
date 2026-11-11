"""Focused loopback REST fidelity tests; no Google account, Node or UI.

Run: python3 -m unittest discover -s experiments/gpui-player/tests -p test_drive_fixture_moves.py
These qualify fixture semantics, not production transaction or live Drive behavior.
"""
import base64
import hashlib
import http.client
import json
import threading
import time
import unittest
import urllib.parse

from drive_fixture import FOLDER, Server


class Moves(unittest.TestCase):
    def setUp(self):
        self.server = Server()
        self.server.state.access.add('focused-fixture-access')
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .01})
        self.thread.start()
        self.content = b'Last remote audio must remain recoverable.\x00\xff'
        self.control({'seed': [
            {'id': 'active', 'name': 'Song', 'mimeType': FOLDER},
            {'id': 'history', 'name': 'Private history', 'mimeType': FOLDER,
             'appProperties': {'singzTransaction': 'fixture-tx'}},
            {'id': 'stems', 'name': 'stems', 'mimeType': FOLDER, 'parents': ['active']},
            {'id': 'audio', 'name': 'vocals.wav', 'parents': ['stems'],
             'contentBase64': base64.b64encode(self.content).decode()},
            {'id': 'document', 'name': 'project.json', 'parents': ['active'],
             'contentBase64': base64.b64encode(b'{"old":true}').decode()},
            {'id': 'catalog', 'name': 'projects.json', 'contentBase64': base64.b64encode(b'{"format":2}').decode()},
        ]})

    def tearDown(self):
        self.server.stop()
        self.thread.join(timeout=5)
        self.server.server_close()
        self.assertFalse(self.thread.is_alive(), 'Fixture thread survived test')

    def request(self, method, path, body=None, raw=False):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=4)
        data = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
        try:
            connection.request(method, path, data, {'Authorization': 'Bearer focused-fixture-access',
                                                   'Content-Type': 'application/octet-stream' if raw else 'application/json'})
            response = connection.getresponse()
            payload = response.read()
            return response.status, dict(response.getheaders()), payload if raw else json.loads(payload or b'null')
        finally:
            connection.close()

    def control(self, body):
        self.assertEqual(self.request('POST', '/control', body)[0], 200)

    def observe(self, identity):
        status, _, value = self.request('GET', '/drive/v3/files/' + identity)
        self.assertEqual(status, 200)
        return value

    def move(self, identity, source='active', destination='history', body=None):
        query = urllib.parse.urlencode({'addParents': destination, 'removeParents': source})
        return self.request('PATCH', '/drive/v3/files/' + identity + '?' + query, body or {})

    def wait(self, condition):
        deadline = time.monotonic() + 3
        while not condition():
            self.assertLess(time.monotonic(), deadline, 'Fixture observation deadline')
            time.sleep(.01)

    def test_parent_move_preserves_ids_bytes_and_folder_descendants(self):
        audio = self.observe('audio')
        self.assertEqual(self.move('stems')[0], 200)
        self.assertEqual(self.observe('stems')['parents'], ['history'])
        self.assertEqual(self.observe('audio'), audio)
        self.assertEqual(self.request('GET', '/drive/v3/files/audio?alt=media', raw=True)[2], self.content)
        self.assertEqual(self.move('document', body={'name': 'retired-project.json'})[0], 200)
        retired = self.observe('document')
        self.assertEqual(retired['id'], 'document')
        self.assertEqual(retired['name'], 'retired-project.json')
        self.assertEqual(retired['parents'], ['history'])
        self.assertFalse(retired['trashed'])
        self.assertEqual(self.move('document', source='history', destination='active', body={'name': 'project.json'})[0], 200)
        self.assertEqual(self.observe('document')['parents'], ['active'])
        self.assertFalse(any(row['method'] == 'DELETE' for row in self.server.state.snapshot()['requests']))

    def test_rejects_body_parents_ambiguous_query_and_parent_conflicts(self):
        original = self.observe('document')
        self.assertEqual(self.request('PATCH', '/drive/v3/files/document', {'parents': ['history']})[0], 400)
        self.assertEqual(self.request('PATCH', '/drive/v3/files/document?addParents=history&addParents=active&removeParents=active', {})[0], 400)
        self.assertEqual(self.move('document', destination='history,active')[0], 400)
        self.assertEqual(self.move('document', source='history')[0], 400)  # same source/destination
        self.assertEqual(self.move('document', source='root')[0], 409)
        self.assertEqual(self.move('active', source='root', destination='stems')[0], 400)  # cycle
        self.assertEqual(self.observe('document'), original)

    def test_lost_and_truncated_move_ack_are_observable_by_exact_id(self):
        for identity, fault in [('document', {'disconnect': True}), ('stems', {'truncateBytes': 3})]:
            self.control({'failNext': [{'method': 'PATCH', 'path': '/drive/v3/files/' + identity,
                                       'afterApply': True, **fault}]})
            with self.assertRaises((http.client.RemoteDisconnected, http.client.IncompleteRead, ConnectionError)):
                self.move(identity)
            actual = self.observe(identity)
            self.assertEqual(actual['parents'], ['history'])
            self.assertEqual(actual['id'], identity)
            self.wait(lambda: any(row['path'] == '/drive/v3/files/' + identity and row['method'] == 'PATCH'
                                  and row['status'] is not None for row in self.server.state.snapshot()['requests']))
            row = next(row for row in self.server.state.snapshot()['requests'] if row['path'] == '/drive/v3/files/' + identity and row['method'] == 'PATCH')
            phases = [event['phase'] for event in row['events']]
            self.assertEqual(phases[:2], ['request-received', 'mutation-applied'])
            self.assertIn('response-lost' if 'disconnect' in fault else 'response-truncated', phases)
            self.assertTrue(row['mutationApplied'])
        self.assertEqual(self.observe('audio')['md5Checksum'], hashlib.md5(self.content).hexdigest())

    def test_before_apply_fault_does_not_record_a_mutation(self):
        self.control({'failNext': [{'method': 'PATCH', 'path': '/drive/v3/files/document', 'status': 503}]})
        self.assertEqual(self.move('document')[0], 503)
        self.assertEqual(self.observe('document')['parents'], ['active'])
        row = next(row for row in self.server.state.snapshot()['requests'] if row['method'] == 'PATCH')
        self.assertFalse(row['mutationApplied'])
        self.assertNotIn('mutation-applied', [event['phase'] for event in row['events']])

    def test_owned_folder_lost_creation_ack_searches_private_properties(self):
        self.control({'failNext': [{'method': 'POST', 'path': '/drive/v3/files', 'afterApply': True, 'disconnect': True}]})
        with self.assertRaises((http.client.RemoteDisconnected, ConnectionError)):
            self.request('POST', '/drive/v3/files', {'name': 'Transaction stage', 'mimeType': FOLDER,
                'parents': ['history'], 'appProperties': {'singzTransaction': "tx'\\x", 'singzRole': 'stage'}})
        query = "mimeType='" + FOLDER + "' and 'history' in parents and trashed=false and appProperties has { key='singzTransaction' and value='tx\\'\\\\x' } and appProperties has { key='singzRole' and value='stage' }"
        status, _, listing = self.request('GET', '/drive/v3/files?' + urllib.parse.urlencode({'q': query}))
        self.assertEqual(status, 200)
        self.assertEqual(len(listing['files']), 1)
        self.assertEqual(listing['files'][0]['appProperties']['singzTransaction'], "tx'\\x")
        wrong = query.replace("value='stage'", "value='foreign'")
        self.assertEqual(self.request('GET', '/drive/v3/files?' + urllib.parse.urlencode({'q': wrong}))[2]['files'], [])

    def test_upload_and_catalog_completion_lost_ack_preserve_applied_payload(self):
        for identity, payload, fault in [(None, b'{"nativeEmptyTracks":true}', {'disconnect': True}),
                                         ('catalog', b'{"format":2,"new":true}', {'truncateBytes': 2})]:
            path = '/upload/drive/v3/files' + ('/' + identity if identity else '') + '?uploadType=resumable'
            status, headers, _ = self.request('PATCH' if identity else 'POST', path,
                                             {} if identity else {'name': 'project.json', 'parents': ['history']})
            self.assertEqual(status, 200)
            target = urllib.parse.urlsplit(headers['Location']).path
            self.control({'failNext': [{'method': 'PUT', 'path': target, 'afterApply': True, **fault}]})
            with self.assertRaises((http.client.RemoteDisconnected, http.client.IncompleteRead, ConnectionError)):
                self.request('PUT', target, payload, raw=True)
            state = self.server.state.snapshot()
            matches = [file for file in state['files'] if file.get('md5Checksum') == hashlib.md5(payload).hexdigest()]
            self.assertEqual(len(matches), 1)
            self.assertEqual(matches[0]['size'], str(len(payload)))
            if identity:
                self.assertEqual(matches[0]['id'], identity)
            row = next(row for row in state['requests'] if row['method'] == 'PUT' and row['path'] == target)
            self.assertTrue(row['mutationApplied'])
            self.assertEqual(row['events'][1]['operation'], 'upload-complete')

    def test_account_identity_is_stable_and_explicitly_changeable(self):
        first = self.request('GET', '/drive/v3/about?fields=user(permissionId)')[2]
        self.assertEqual(self.request('GET', '/drive/v3/about?fields=user(permissionId)')[2], first)
        self.control({'permissionId': 'fixture-different-account'})
        second = self.request('GET', '/drive/v3/about?fields=user(permissionId)')[2]
        self.assertNotEqual(first, second)

    def generate_id(self):
        status, _, value = self.request('GET', '/drive/v3/files/generateIds?count=1&space=drive&type=files')
        self.assertEqual(status, 200)
        self.assertEqual(len(value['ids']), 1)
        return value['ids'][0]

    def test_reserved_folder_lost_ack_hidden_observations_retry_same_id_without_duplicate(self):
        identity = self.generate_id()
        document = {'id': identity, 'name': 'Durable transaction history', 'mimeType': FOLDER,
                    'parents': ['root'], 'appProperties': {'singzTransaction': 'reserved-history'}}
        self.control({'hideNext': {identity: {'metadata': 2, 'listing': 2}},
            'failNext': [{'method': 'POST', 'path': '/drive/v3/files', 'afterApply': True, 'disconnect': True}]})
        with self.assertRaises((http.client.RemoteDisconnected, ConnectionError)):
            self.request('POST', '/drive/v3/files', document)
        self.assertEqual(self.request('GET', '/drive/v3/files/' + identity)[0], 404)
        query = urllib.parse.urlencode({'q': "appProperties has { key='singzTransaction' and value='reserved-history' } and trashed=false"})
        self.assertEqual(self.request('GET', '/drive/v3/files?' + query)[2]['files'], [])
        self.assertEqual(self.request('GET', '/drive/v3/files/' + identity)[0], 404)
        self.assertEqual(self.request('POST', '/drive/v3/files', document)[0], 409)
        actual = self.observe(identity)
        self.assertEqual(actual['id'], identity)
        self.assertEqual(actual['appProperties'], document['appProperties'])
        self.assertEqual(actual['parents'], ['root'])
        self.assertEqual(self.request('GET', '/drive/v3/files?' + query)[2]['files'], [])
        self.assertEqual(len(self.request('GET', '/drive/v3/files?' + query)[2]['files']), 1)
        creations = [event for row in self.server.state.snapshot()['requests'] for event in row['events']
                     if event['phase'] == 'mutation-applied' and event['file']['id'] == identity]
        self.assertEqual(len(creations), 1)

    def test_reserved_upload_completion_lost_ack_hidden_get_retry_cannot_overwrite(self):
        identity = self.generate_id()
        metadata = {'id': identity, 'name': 'project.json', 'parents': ['history'], 'mimeType': 'application/json'}
        status, headers, _ = self.request('POST', '/upload/drive/v3/files?uploadType=resumable', metadata)
        self.assertEqual(status, 200)
        target = urllib.parse.urlsplit(headers['Location']).path
        payload = b'{"settings":{"nativeEmptyTracks":true}}'
        self.control({'hideNext': {identity: {'metadata': 2}},
            'failNext': [{'method': 'PUT', 'path': target, 'afterApply': True, 'disconnect': True}]})
        with self.assertRaises((http.client.RemoteDisconnected, ConnectionError)):
            self.request('PUT', target, payload)  # JSON MIME matches intended metadata.
        self.assertEqual(self.request('GET', '/drive/v3/files/' + identity)[0], 404)
        self.assertEqual(self.request('GET', '/drive/v3/files/' + identity)[0], 404)
        self.assertEqual(self.request('POST', '/upload/drive/v3/files?uploadType=resumable', metadata)[0], 409)
        # Retrying the old completed session cannot turn create into overwrite.
        self.assertEqual(self.request('PUT', target, b'foreign-overwrite')[0], 409)
        actual = self.observe(identity)
        self.assertEqual(actual['md5Checksum'], hashlib.md5(payload).hexdigest())
        self.assertEqual(actual['size'], str(len(payload)))
        self.assertEqual(self.request('GET', '/drive/v3/files/' + identity + '?alt=media', raw=True)[2], payload)
        self.assertEqual(sum(file['id'] == identity for file in self.server.state.snapshot()['files']), 1)

    def test_two_partial_sessions_for_same_reserved_id_only_one_can_create(self):
        identity = self.generate_id()
        metadata = {'id': identity, 'name': 'project.json', 'parents': ['history']}
        targets = []
        for _ in range(2):
            status, headers, _ = self.request('POST', '/upload/drive/v3/files?uploadType=resumable', metadata)
            self.assertEqual(status, 200)
            targets.append(urllib.parse.urlsplit(headers['Location']).path)
        self.assertEqual(self.request('PUT', targets[0], b'first-complete')[0], 200)
        self.assertEqual(self.request('PUT', targets[1], b'late-partial-overwrite')[0], 409)
        self.assertEqual(self.request('GET', '/drive/v3/files/' + identity + '?alt=media', raw=True)[2], b'first-complete')


if __name__ == '__main__':
    unittest.main()
