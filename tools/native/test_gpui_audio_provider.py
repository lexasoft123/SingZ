"""Standalone native provider protocol regression; no Node, UI or microphone.

Usage: python3 tools/native/test_gpui_audio_provider.py <audio-helper> <output>
Only --providers uses the actual platform probe. All host/session cases explicitly
select the fake backend and mandatory mute; they do not qualify hardware output.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import wave


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('helper', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    helper = args.helper.resolve(strict=True)
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    before = hashlib.sha256(helper.read_bytes()).hexdigest()
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_')}
    env['SINGZ_MUTE'] = '1'
    records = []

    def run(argv, commands=None, ok=True):
        result = subprocess.run([str(helper), *argv], input=commands, text=True,
                                encoding='utf-8', capture_output=True, timeout=30, env=env,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        rows = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        assert rows and all(row['protocol'] == 1 for row in rows), result
        if ok:
            assert result.returncode == 0 and all(row['ok'] is True for row in rows), result
        else:
            assert result.returncode != 0 and rows[0]['ok'] is False, result
        records.append({'argv': argv, 'commands': commands, 'exitCode': result.returncode,
                        'rows': rows, 'stderr': result.stderr})
        return rows

    providers = run(['--providers'])[0]
    assert providers['platform'] in ('win32', 'darwin', 'linux', 'other'), providers
    rows = providers['providers']
    assert len({row['id'] for row in rows}) == len(rows), providers
    by_id = {row['id']: row for row in rows}
    for row in rows:
        assert isinstance(row['compiled'], bool) and isinstance(row['available'], bool), row
        assert isinstance(row['detail'], str) and row['detail'], row
        assert not row['available'] or row['compiled'], row
    default = providers['defaultProvider']
    assert default in by_id and by_id[default]['available'], providers
    windows = providers['platform'] == 'win32'
    explicit = ['--provider', 'wasapi'] if windows else []

    for provider in ('wasapi', 'asio'):
        if not by_id[provider]['available']:
            for mode in ('--devices', '--training-only', '--empty-project'):
                denied = run(['--test-fake-host', '--provider', provider, mode], ok=False)[0]
                assert denied['provider'] == provider and denied['backendProvider'] is None, denied
                assert denied['fixture'] is True and denied['errorCode'] == by_id[provider]['errorCode'], denied
                assert denied['detail'] == by_id[provider]['detail'], denied
    unknown = run(['--provider', 'invented', '--devices'], ok=False)[0]
    assert unknown['errorCode'] == 'invalid-provider', unknown

    inventory = run(['--test-fake-host', *explicit, '--devices'])[0]
    assert inventory['provider'] == default and inventory['backendProvider'] == 'fake', inventory
    assert inventory['fixture'] is True, inventory
    assert any(row['inputChannels'] > 0 for row in inventory['devices']), inventory
    assert any(row['outputChannels'] > 0 for row in inventory['devices']), inventory
    if windows:
        assert inventory['defaultOutputUid'].startswith('wasapi:'), inventory
        assert not inventory['defaultInputUid'].startswith(('wasapi:', 'asio:')), inventory
        for row in inventory['devices']:
            if row['outputChannels']:
                assert row['uid'].startswith('wasapi:') and row['inputChannels'] == 0, row
            if row['inputChannels']:
                assert not row['uid'].startswith(('wasapi:', 'asio:')) and row['outputChannels'] == 0, row
    else:
        assert not inventory['defaultOutputUid'].startswith(default + ':'), inventory

    with tempfile.TemporaryDirectory(prefix='singz-provider-cli-') as folder:
        root = Path(folder).resolve()
        pcm = root / 'tone.wav'
        with wave.open(str(pcm), 'wb') as audio:
            audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            audio.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(i * math.tau * 220 / 16000)))
                                       for i in range(16000)))
        invalid = root / 'invalid.wav'
        invalid.write_bytes(b'Not a WAV or any supported audio container')
        # Startup errors must preserve provider attribution, so a real source
        # failure is never hidden by Rust's mandatory provenance validation.
        for source, code, message in [(root / 'missing.wav', 'source-unavailable', 'Cannot open audio source'),
                                      (invalid, 'invalid-source-duration', 'Cannot determine native lane duration')]:
            denied = run(['--test-fake-host', *explicit, '--output', inventory['defaultOutputUid'],
                          'vocals', str(source)], ok=False)[0]
            assert denied['provider'] == default and denied['fixture'] is True, denied
            assert denied['backendProvider'] is None and denied['errorCode'] == code and denied['error'] == message, denied
        denied = run(['--test-fake-host', *explicit, '--tempo', 'invalid', 'vocals', str(pcm)], ok=False)[0]
        assert denied['provider'] == default and denied['fixture'] is True and denied['errorCode'] == 'invalid-arguments', denied
        denied = run(['--test-fake-host', *explicit, '--graph-manifest', str(root / 'missing.graph'),
                      'vocals', str(pcm)], ok=False)[0]
        assert denied['provider'] == default and denied['fixture'] is True and denied['errorCode'] == 'invalid-graph', denied
        for mode in ('ordinary', '--training-only', '--empty-project'):
            argv = ['--test-fake-host', *explicit]
            if mode != 'ordinary':
                argv.append(mode)
            argv += ['--output', inventory['defaultOutputUid']]
            if mode == 'ordinary':
                argv += ['vocals', str(pcm)]
            session = run(argv, 'status\nquit\n')
            for row in session:
                assert row['provider'] == default and row['backendProvider'] == 'fake' and row['fixture'] is True, row
                assert row['outputUid'] == inventory['defaultOutputUid'], row
                if 'deviceInventory' in row:
                    nested = row['deviceInventory']
                    assert nested['provider'] == default and nested['backendProvider'] == 'fake' and nested['fixture'] is True, nested
                    assert nested['defaultOutputUid'] == inventory['defaultOutputUid'], nested

        if windows:
            for uid in ('asio:foreign-output', 'unscoped-output', 'wasapi:'):
                denied = run(['--test-fake-host', '--provider', 'wasapi', '--empty-project', '--output', uid], ok=False)[0]
                assert denied['errorCode'] == 'provider-device-mismatch', denied
            wrong = 'asio:foreign-output'.encode().hex()
            argv = ['--test-fake-host', '--provider', 'wasapi', '--empty-project', '--output', inventory['defaultOutputUid']]
            # Rejected route commands keep their accepted provider, old route
            # and generation. The helper exits successfully after explicit Quit.
            result = subprocess.run([str(helper), *argv], input=f'output {wrong}\nstatus\nquit\n',
                                    text=True, encoding='utf-8', capture_output=True, timeout=30, env=env,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            session = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
            assert result.returncode == 0 and len(session) >= 3, result
            assert session[0]['ok'] is True and session[1]['ok'] is False and session[2]['ok'] is True, session
            for row in session:
                assert row['provider'] == 'wasapi' and row['backendProvider'] == 'fake', row
                assert row['outputUid'] == inventory['defaultOutputUid'] and row['graphGeneration'] == session[0]['graphGeneration'], row
            records.append({'argv': argv, 'commands': f'output {wrong}\nstatus\nquit\n',
                            'exitCode': result.returncode, 'rows': session, 'stderr': result.stderr})

    assert hashlib.sha256(helper.read_bytes()).hexdigest() == before, 'Helper changed during qualification'
    result = {'passed': True, 'helperSha256': before, 'platform': providers['platform'],
              'defaultProvider': default, 'cases': records, 'hardwareInput': False,
              'hardwareOutput': False, 'noNode': True,
              'scope': 'Actual platform provider probe, fake-only native playback/inventory identity and refusal contracts; no hardware qualification'}
    (out / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print('PASS: native provider probe, scoped output identities and explicit no-fallback refusal')


if __name__ == '__main__':
    main()
