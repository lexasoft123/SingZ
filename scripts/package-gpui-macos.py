#!/usr/bin/env python3
"""Assemble an already-built native runtime; never build, launch, or fetch anything.

The adjacent .manifest.json records final signed bytes (it is outside the bundle
so that recording hashes cannot invalidate the bundle signature).
"""
from __future__ import annotations
import argparse
import contextlib
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import posixpath
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]
EXECUTABLES = ('singz-gpui-player', 'singz-gpui-audio', 'singz-gpui-input', 'singz-analyze')
SAMPLES = tuple(f'{sound}-C{octave}.mp3' for sound in ('piano', 'electric', 'guitar') for octave in range(2, 7)) + ('LICENSE.md', 'loudness-calibration.json')
MAGICS = {bytes.fromhex(value) for value in ('feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca')}
BUNDLE_ID = 'com.lexasoft.singz.gpui.preview'
FONT_LICENSES = ('Bricolage-OFL.txt', 'MartianMono-OFL.txt')

class PackageError(RuntimeError):
    pass

UI_TESTS_MARKER = b'SINGZ_GPUI_UI_TESTS_BUILD_MARKER'

def require_fresh_vendor() -> None:
    """Refuse to package from a stale or hand-edited GPUI vendor tree (never downloads)."""
    check = subprocess.run([sys.executable, str(ROOT / 'scripts/gpui-vendor.py'), '--check'], capture_output=True, text=True)
    if check.returncode != 0:
        raise PackageError('GPUI vendor tree is missing, stale or edited; run scripts/gpui-vendor.py (or --update-patch): ' + check.stdout.strip())


def validate_runtime_profile(runtime: Path, allow_debug: bool) -> None:
    profile = runtime.resolve().name
    if profile == 'release' or (profile == 'debug' and allow_debug):
        return
    if profile == 'debug':
        raise PackageError('Refusing debug profile; pass --allow-debug only for local qualification')
    raise PackageError('Cannot determine build profile from runtime path; expected target/release or target/debug')

def reject_ui_tests_binary(path: Path) -> None:
    try:
        names = json.loads((ROOT / 'tests/shared/gpui-gated-env-names.json').read_text(encoding='utf-8'))
        if (not isinstance(names, list) or not names or
                any(not isinstance(name, str) or not name.startswith('SINGZ_') or
                    len(name) <= len('SINGZ_') or
                    any(c not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_' for c in name)
                    for name in names) or names != sorted(set(names))):
            raise ValueError('invalid gated environment name list')
    except (OSError, ValueError, TypeError) as error:
        raise PackageError(f'Cannot load gated environment name list: {error}') from error
    binary = path.read_bytes()
    if UI_TESTS_MARKER in binary:
        raise PackageError(f'Refusing ui-tests binary: {path}')
    for name in names:
        if name.encode('ascii') in binary:
            raise PackageError(f'Refusing binary containing gated environment name {name}: {path}')

def native_build_info(path: Path | None, executable: Path, platform: str, required: bool) -> dict | None:
    """Validate supplied CLI metadata against copied, unsigned UI bytes; never execute it.

    This binds a caller-supplied report, not an attestation of its provenance.
    Only the closed safe schema is retained in the package manifest.
    """
    if path is None:
        if required:
            raise PackageError('--require-drive-config requires --build-info-file')
        return None
    ordinary(path)
    try:
        if path.stat().st_size > 16384:
            raise ValueError('oversized')
        info = json.loads(path.read_text(encoding='utf-8'))
        expected = {'schema', 'runtime', 'nodeRuntime', 'applicationVersion', 'crateVersion', 'os', 'arch', 'executableSha256', 'drive'}
        if not isinstance(info, dict) or set(info) != expected:
            raise ValueError('schema')
        if type(info['schema']) is not int or info['schema'] != 1 or info['runtime'] != 'rust-gpui' or info['nodeRuntime'] is not False:
            raise ValueError('runtime')
        if info['os'] != platform or info['arch'] not in ('x86_64', 'aarch64'):
            raise ValueError('target')
        for field in ('applicationVersion', 'crateVersion'):
            value = info[field]
            if not isinstance(value, str) or not 0 < len(value) <= 64 or any(c not in '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.+-' for c in value):
                raise ValueError('version')
        digest = info['executableSha256']
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError('digest')
        drive = info['drive']
        if not isinstance(drive, dict) or set(drive) != {'configured', 'source', 'status'} or type(drive['configured']) is not bool:
            raise ValueError('drive')
        if drive['source'] not in ('canonical-json', 'legacy-typescript', 'none', 'unknown') or drive['status'] not in ('configured', 'missing', 'unreadable', 'malformed', 'invalid'):
            raise ValueError('labels')
        if drive['configured'] != (drive['status'] == 'configured') or (drive['configured'] and drive['source'] not in ('canonical-json', 'legacy-typescript')):
            raise ValueError('configuration')
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise PackageError('Invalid safe native build-info document') from None
    if hashlib.sha256(executable.read_bytes()).hexdigest() != digest:
        raise PackageError('Native build-info executable hash does not match copied UI executable')
    if required and not drive['configured']:
        raise PackageError('Required baked Drive application configuration is unavailable')
    return info


def reject_node_runtime_path(relative: Path) -> None:
    """Reject actual runtime/addon names, not arbitrary JS documentation/DLLs."""
    parts = [part.casefold() for part in relative.parts]
    name = parts[-1] if parts else ''
    runtime_directories = {'node_modules', 'electron.app', 'electron.framework', 'electron framework.framework'}
    runtimes = {'node', 'node.exe', 'nodejs', 'nodejs.exe', 'node.dll', 'libnode.dll',
                'electron', 'electron.exe', 'electron.dll', 'electron framework',
                'electron helper', 'electron helper (gpu)', 'electron helper (renderer)',
                'electron helper (plugin)', 'libnode.so', 'libnode.dylib'}
    versioned_so = name.startswith('libnode.so.') and all(part.isdigit() for part in name[len('libnode.so.'):].split('.'))
    versioned_dylib = name.startswith('libnode.') and name.endswith('.dylib') and all(part.isdigit() for part in name[len('libnode.'):-len('.dylib')].split('.'))
    if (any(part in runtime_directories for part in parts) or name.endswith('.node')
            or name in runtimes or versioned_so or versioned_dylib):
        raise PackageError(f'Node/Electron runtime or addon is not a native-only payload: {relative}; provide a pure-native engine payload')


def require_native_payload(directory: Path) -> None:
    for path in directory.rglob('*'):
        reject_node_runtime_path(path.relative_to(directory))


def ordinary(path: Path, directory: bool = False) -> None:
    try:
        mode = path.lstat().st_mode
    except OSError as error:
        raise PackageError(f'Missing required payload: {path}') from error
    if not (stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)):
        raise PackageError(f'Payload must be an ordinary {"directory" if directory else "file"}, without links: {path}')

def tree_files(directory: Path) -> list[Path]:
    ordinary(directory, True)
    result = []
    for entry in sorted(directory.iterdir()):
        mode = entry.lstat().st_mode
        if stat.S_ISDIR(mode):
            result.extend(tree_files(entry))
        else:
            ordinary(entry)
            result.append(entry)
    return result

def payload_stamp(metadata: os.stat_result) -> tuple:
    return (metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_size,
            metadata.st_mtime_ns, metadata.st_ctime_ns)


def copy_payload_file(source: Path, destination: Path) -> None:
    """Create known payload bytes/mode without importing download metadata.

    copy2/copystat propagate foreign quarantine/provenance xattrs on macOS.
    Never modify those source attributes or change any system security policy.
    """
    ordinary(source)
    before = source.lstat()
    descriptor = os.open(source, os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as reader, destination.open('xb') as writer:
        if payload_stamp(os.fstat(reader.fileno())) != payload_stamp(before):
            raise PackageError(f'Payload changed while opening: {source}')
        for block in iter(lambda: reader.read(1024 * 1024), b''):
            writer.write(block)
        writer.flush()
        os.fsync(writer.fileno())
        ordinary(source)
        if (payload_stamp(os.fstat(reader.fileno())) != payload_stamp(before)
                or payload_stamp(source.lstat()) != payload_stamp(before)):
            raise PackageError(f'Payload changed while copying: {source}')
    destination.chmod(stat.S_IMODE(before.st_mode) & 0o777)


def copy_payload_tree(source: Path, destination: Path) -> None:
    # Fresh directories deliberately get no copystat/xattrs either. Apply the
    # source's ordinary permission bits after children have been populated.
    ordinary(source, True)
    before = source.lstat()
    destination.mkdir()
    for entry in sorted(source.iterdir()):
        mode = entry.lstat().st_mode
        if stat.S_ISDIR(mode):
            copy_payload_tree(entry, destination / entry.name)
        else:
            ordinary(entry)
            copy_payload_file(entry, destination / entry.name)
    ordinary(source, True)
    if payload_stamp(source.lstat()) != payload_stamp(before):
        raise PackageError(f'Payload directory changed while copying: {source}')
    destination.chmod(stat.S_IMODE(before.st_mode) & 0o777)


def macho(path: Path) -> bool:
    with path.open('rb') as stream:
        return stream.read(4) in MAGICS

def command(argv: list[str]) -> str:
    try:
        return subprocess.run(argv, check=True, capture_output=True, text=True).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        if any(tool in argv[0] for tool in ('xcrun', 'security', 'codesign')):
            raise PackageError(f'{Path(argv[0]).name} failed; sensitive command details suppressed') from None
        detail = getattr(error, 'stderr', '')
        raise PackageError(f'Command failed: {argv!r}\n{detail}') from error

ENTITLEMENTS = ROOT / 'experiments/gpui-player/packaging/macos/audio-input.plist'


DEVELOPER_ID = re.compile(r'\b([0-9A-Fa-f]{40})\s+"Developer ID Application: [^"\n]+"')


@contextlib.contextmanager
def temporary_p12_keychain(p12: str, password: str, run=command):
    """Import a Developer ID p12 into a throwaway keychain; yield its path.

    The keychain lives in a private temp directory under a random password and
    is searched by this process's signing commands only for as long as the
    context lasts. The user's login keychain and the wrapper keychain are never
    modified, apart from the user keychain search list, which is restored (the
    temporary entry removed) on every exit path. Nothing here prints a password
    or an identity name, and `command` suppresses argv/stderr for `security`.
    `security import` has no file/stdin form for its passphrase, so -P puts the
    p12 password in the argv of that one short-lived child.
    """
    directory = Path(tempfile.mkdtemp(prefix='singz-signing-'))
    keychain = str(directory / 'signing.keychain-db')
    local_password = secrets.token_urlsafe(32)
    original: list[str] | None = None
    created = False
    try:
        try:
            os.chmod(directory, 0o700)
            listing = run(['/usr/bin/security', 'list-keychains', '-d', 'user'])
            listed = re.findall(r'^\s*"([^"\n]+)"\s*$', listing, re.M)
            if not listed:
                raise PackageError('Cannot read the user keychain search list; refusing to change it')
            original = listed
            run(['/usr/bin/security', 'create-keychain', '-p', local_password, keychain])
            created = True
            run(['/usr/bin/security', 'set-keychain-settings', '-lut', '7200', keychain])
            run(['/usr/bin/security', 'unlock-keychain', '-p', local_password, keychain])
            run(['/usr/bin/security', 'import', p12, '-k', keychain, '-f', 'pkcs12', '-P', password,
                 '-T', '/usr/bin/codesign'])
            run(['/usr/bin/security', 'set-key-partition-list', '-S', 'apple-tool:,apple:',
                 '-s', '-k', local_password, keychain])
            run(['/usr/bin/security', 'list-keychains', '-d', 'user', '-s', keychain, *original])
        except PackageError:
            raise
        except Exception:
            raise PackageError('Temporary signing keychain setup failed; sensitive details suppressed') from None
        yield keychain
    finally:
        # Each cleanup step is independent so one failure cannot skip the rest,
        # and none may mask the original error.
        failed = False
        if original is not None:
            try:
                run(['/usr/bin/security', 'list-keychains', '-d', 'user', '-s', *original])
            except Exception:
                failed = True
        if created:
            try:
                run(['/usr/bin/security', 'delete-keychain', keychain])
            except Exception:
                failed = True
        shutil.rmtree(directory, ignore_errors=True)
        if failed:
            print('Warning: temporary signing keychain cleanup did not complete; check `security list-keychains -d user`.', file=sys.stderr)


def signing_configuration(env: dict, run=command, stack: contextlib.ExitStack | None = None) -> tuple[str, dict | None]:
    # The wrapper keychain is searched first and must already be unlocked. If it
    # holds no Developer ID Application identity but the wrapper provided the
    # p12 and its password, import them into a temporary keychain whose cleanup
    # is registered on `stack` (the caller keeps it open until signing is done).
    keychain = env.get('SINGZ_SIGNING_KEYCHAIN_PATH')
    names = ('SINGZ_ASC_KEY_PATH', 'APP_STORE_CONNECT_API_KEY_ID', 'APP_STORE_CONNECT_API_ISSUER_ID')
    if not all(env.get(name) for name in names):
        return '-', None
    credentials = {'key': env[names[0]], 'key_id': env[names[1]], 'issuer': env[names[2]]}
    if keychain:
        matches = DEVELOPER_ID.findall(run(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning', keychain]))
        if len(matches) > 1:
            raise PackageError('Expected exactly one Developer ID Application identity in the signing keychain')
        if matches:
            return matches[0], {**credentials, 'keychain': keychain}
    p12, password = env.get('SINGZ_MAC_P12'), env.get('SINGZ_MAC_P12_PASSWORD')
    if not (p12 and password and stack is not None):
        return '-', None
    temporary = stack.enter_context(temporary_p12_keychain(p12, password, run))
    matches = DEVELOPER_ID.findall(run(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning', temporary]))
    if len(matches) != 1:
        raise PackageError('Expected exactly one Developer ID Application identity in the p12')
    return matches[0], {**credentials, 'keychain': temporary}


def sign_bundle(bundle: Path, dependencies: list[dict], identity: str, run=command, keychain: str | None = None) -> None:
    paths = [record['path'] for record in dependencies if record['path'] != 'Contents/MacOS/singz-gpui-player']
    def stage(path):
        if path.startswith('Contents/MacOS/ffmpeg/'):
            return (0, path)
        if path.startswith('Contents/Resources/engines/'):
            return (1 if path.endswith('.dylib') else 2, path)
        if path.endswith('/singz-analyze'):
            return (3, path)
        if path.endswith('/singz-gpui-audio'):
            return (4, path)
        if path.endswith('/singz-gpui-input'):
            return (5, path)
        return (2, path)
    def sign(path: Path, identifier: str | None = None, entitlement: bool = False):
        args = ['/usr/bin/codesign', '--force', '--sign', identity]
        if identity != '-':
            # Hardened runtime only with a real identity: its library validation
            # rejects ad-hoc dylibs (no Team ID), so an ad-hoc app could not load
            # its own bundled FFmpeg libraries.
            args += ['--options', 'runtime', '--timestamp']
            if keychain:
                args += ['--keychain', keychain]
        if identifier:
            args += ['--identifier', identifier]
        if entitlement:
            args += ['--entitlements', str(ENTITLEMENTS)]
        run(args + [str(path)])
    ids = {'singz-analyze': 'analyze', 'singz-gpui-audio': 'audio', 'singz-gpui-input': 'input'}
    for relative in sorted(paths, key=stage):
        path = bundle / relative
        suffix = ids.get(path.name)
        sign(path, BUNDLE_ID + '.' + suffix if suffix else None, suffix == 'input')
    sign(bundle, entitlement=True)
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(bundle)])


def release_artifacts(bundle: Path, dmg: Path, identity: str, credentials: dict | None, run=command) -> None:
    def notarize(path: Path):
        response = run(['/usr/bin/xcrun', 'notarytool', 'submit', str(path), '--key', credentials['key'],
             '--key-id', credentials['key_id'], '--issuer', credentials['issuer'], '--wait', '--output-format', 'json'])
        try:
            status = json.loads(response)['status']
        except (ValueError, KeyError, TypeError):
            raise PackageError('Cannot parse notarization result') from None
        if status != 'Accepted':
            raise PackageError('Apple notarization did not accept the artifact')
    if credentials:
        archive = dmg.with_suffix('.zip')
        run(['/usr/bin/ditto', '-c', '-k', '--keepParent', str(bundle), str(archive)])
        notarize(archive)
        run(['/usr/bin/xcrun', 'stapler', 'staple', str(bundle)])
    run(['/usr/bin/hdiutil', 'create', '-format', 'UDZO', '-srcfolder', str(bundle), str(dmg)])
    if credentials:
        run(['/usr/bin/codesign', '--force', '--sign', identity, '--timestamp', '--keychain', credentials['keychain'], str(dmg)])
        notarize(dmg)
        run(['/usr/bin/xcrun', 'stapler', 'staple', str(dmg)])


def version_key(value: str) -> tuple[int, ...]:
    try:
        parts = tuple(int(part) for part in value.split('.'))
    except ValueError as error:
        raise PackageError(f'Invalid macOS version: {value}') from error
    if not parts or any(part < 0 for part in parts):
        raise PackageError(f'Invalid macOS version: {value}')
    return parts + (0,) * max(0, 3 - len(parts))

def inspect_slice(path: Path, architecture: str, run=command) -> tuple[list[str], list[str], dict]:
    dependencies = []
    def otool(flag):
        return run(['/usr/bin/otool', '-arch', architecture, flag, str(path)])
    identities = [line.strip() for line in otool('-D').splitlines()[1:]]
    for line in otool('-L').splitlines():
        if line[:1].isspace() and ' (compatibility version ' in line:
            dependency = line.strip().split(' (compatibility version ', 1)[0]
            if dependency not in identities:  # LC_ID_DYLIB is not a dependency.
                dependencies.append(dependency)
    lines = otool('-l').splitlines()
    rpaths = []
    minimums = []
    for index, line in enumerate(lines):
        if line.strip() == 'cmd LC_RPATH':
            for following in lines[index + 1:index + 4]:
                if following.strip().startswith('path '):
                    rpaths.append(following.strip()[5:].rsplit(' (offset ', 1)[0])
        if line.strip() in ('cmd LC_BUILD_VERSION', 'cmd LC_VERSION_MIN_MACOSX'):
            field = 'minos ' if line.strip() == 'cmd LC_BUILD_VERSION' else 'version '
            for following in lines[index + 1:index + 7]:
                if following.strip().startswith('platform ') and following.strip().split()[1].lower() not in ('1', 'macos'):
                    raise PackageError(f'Non-macOS Mach-O platform in {path}: {following.strip()}')
                if following.strip().startswith(field):
                    minimums.append(following.strip()[len(field):].split()[0])
                    break
    if not minimums:
        raise PackageError(f'No macOS deployment target found in {path}')
    headers = otool('-hv').splitlines()
    kinds = set()
    for index, line in enumerate(headers[:-1]):
        columns = line.split()
        if 'filetype' in columns:
            values = headers[index + 1].split()
            position = columns.index('filetype')
            if len(values) > position:
                raw = values[position]
                kinds.add({'2': 'EXECUTE', '6': 'DYLIB', '8': 'BUNDLE'}.get(raw, raw.removeprefix('MH_')))
    if len(kinds) != 1:
        raise PackageError(f'Unknown or inconsistent Mach-O filetype in {path}: {sorted(kinds)}')
    return dependencies, rpaths, {'minimumMacOS': max(minimums, key=version_key), 'filetype': kinds.pop()}

def inspect_dependencies(path: Path, run=command) -> tuple[list[str], list[str], dict]:
    architectures = run(['/usr/bin/lipo', '-archs', str(path)]).strip().split()
    if not architectures or len(set(architectures)) != len(architectures):
        raise PackageError(f'Invalid Mach-O architectures found in {path}')
    slices = {}
    for architecture in architectures:
        dependencies, rpaths, metadata = inspect_slice(path, architecture, run)
        slices[architecture] = {'dependencies': dependencies, 'rpaths': rpaths, **metadata}
    kinds = {image['filetype'] for image in slices.values()}
    if len(kinds) != 1:
        raise PackageError(f'Inconsistent Mach-O slice filetypes in {path}')
    return (list(dict.fromkeys(dep for image in slices.values() for dep in image['dependencies'])),
            list(dict.fromkeys(rpath for image in slices.values() for rpath in image['rpaths'])),
            {'architectures': architectures, 'slices': slices,
             'minimumMacOS': max((image['minimumMacOS'] for image in slices.values()), key=version_key),
             'filetype': kinds.pop()})

def dependency_inventory(bundle: Path, inspector=inspect_dependencies) -> list[dict]:
    records = []
    binaries = [path for path in tree_files(bundle) if macho(path)]
    binary_paths = {path.resolve(): path for path in binaries}
    def expand(value: str, binary: Path, executable: Path | None) -> Path | None:
        if value == '@executable_path' or value.startswith('@executable_path/'):
            if executable is None:
                raise PackageError(f'Ambiguous @executable_path in non-executable {binary}: {value}')
            return executable.parent / value[len('@executable_path'):].lstrip('/')
        for token, base in (('@loader_path', binary.parent),):
            if value == token or value.startswith(token + '/'):
                return base / value[len(token):].lstrip('/')
        return Path(value) if value.startswith('/') else None
    for binary in binaries:
        dependencies, rpaths, metadata = inspector(binary)
        if metadata['filetype'] == 'EXECUTE' and not binary.stat().st_mode & 0o111:
            raise PackageError(f'MH_EXECUTE payload lacks execute permission: {binary}')
        records.append({'path': binary.relative_to(bundle).as_posix(), 'dependencies': dependencies, 'rpaths': rpaths, 'contexts': [], **metadata})
    indexed = {record['path']: record for record in records}
    for name in EXECUTABLES:
        if f'Contents/MacOS/{name}' not in indexed:
            raise PackageError(f'Copied executable is no longer Mach-O: {name}')
        if indexed[f'Contents/MacOS/{name}']['filetype'] != 'EXECUTE':
            raise PackageError(f'Required binary must be MH_EXECUTE: {name}')
    app_architectures = set(indexed['Contents/MacOS/singz-gpui-player']['architectures'])
    for record in (indexed[f'Contents/MacOS/{name}'] for name in EXECUTABLES):
        if not app_architectures.issubset(record['architectures']):
            raise PackageError(f"Mach-O lacks application architectures {sorted(app_architectures)}: {record['path']}")
    reached, visited = set(), set()
    def system(path: str) -> bool:
        return posixpath.normpath(path).startswith(('/System/Library/', '/usr/lib/'))
    def walk(binary: Path, architecture: str, executable: Path | None, inherited: tuple[Path, ...], chain: tuple[Path, ...]) -> None:
        if binary in chain:
            return  # An already traversed edge closes this loader cycle.
        if len(chain) >= 128:
            raise PackageError('Mach-O loader chain exceeds the supported depth of 128')
        record = indexed[binary.relative_to(bundle).as_posix()]
        image = record['slices'].get(architecture)
        if image is None:
            raise PackageError(f'Referencing architecture {architecture} unavailable in {binary.name}')
        own = []
        for value in image['rpaths']:
            path = expand(value, binary, executable)
            if path is None:
                raise PackageError(f'Unsupported rpath in {binary.name}: {value}')
            path = path.resolve()
            if not path.is_relative_to(bundle.resolve()) and not system(str(path) + '/'):
                raise PackageError(f'External rpath in {binary.name}: {value}')
            own.append(path)
        search = tuple(dict.fromkeys((*own, *inherited)))
        key = (binary, architecture, executable, search)
        if key in visited:
            return
        visited.add(key)
        reached.add((binary, architecture))
        context = {'architecture': architecture, 'executable': executable.relative_to(bundle).as_posix() if executable else None,
                   'rpathSearch': [str(path.relative_to(bundle.resolve())) if path.is_relative_to(bundle.resolve()) else str(path) for path in search],
                   'resolvedDependencies': []}
        record['contexts'].append(context)
        for dependency in image['dependencies']:
            if system(dependency):
                context['resolvedDependencies'].append({'load': dependency, 'resolved': posixpath.normpath(dependency)})
                continue
            if dependency.startswith('/'):
                raise PackageError(f'Non-system absolute dependency in {binary.name}: {dependency}')
            if dependency.startswith('@rpath/'):
                candidates = [path / dependency[len('@rpath/'):] for path in search]
            else:
                candidate = expand(dependency, binary, executable)
                candidates = [candidate] if candidate is not None else []
            target = next((candidate.resolve() for candidate in candidates
                           if candidate.resolve() in binary_paths or system(str(candidate.resolve()))), None)
            if target is None:
                raise PackageError(f'Unresolved or external dependency in {binary.name}: {dependency}')
            resolved = target.relative_to(bundle.resolve()).as_posix() if target in binary_paths else str(target)
            context['resolvedDependencies'].append({'load': dependency, 'resolved': resolved})
            if target in binary_paths:
                target_image = indexed[binary_paths[target].relative_to(bundle).as_posix()]['slices'].get(architecture)
                if target_image is not None and target_image['filetype'] != 'DYLIB':
                    raise PackageError(f'Dependency is not MH_DYLIB for {architecture}: {target}')
                walk(binary_paths[target], architecture, executable, search, (*chain, binary))
    for binary in binaries:
        if indexed[binary.relative_to(bundle).as_posix()]['filetype'] == 'EXECUTE':
            for architecture in indexed[binary.relative_to(bundle).as_posix()]['architectures']:
                walk(binary, architecture, binary, (), ())
    for binary in binaries:
        for architecture in indexed[binary.relative_to(bundle).as_posix()]['architectures']:
            if (binary, architecture) not in reached:
                walk(binary, architecture, None, (), ())
    return records

def rename_exclusive(source: Path, destination: Path) -> None:
    """Atomic no-replace publication; never use an overwrite-capable rename."""
    library = ctypes.CDLL(None, use_errno=True)
    src, dst = os.fsencode(source), os.fsencode(destination)
    if sys.platform == 'darwin':
        fn = library.renamex_np
        fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        result = fn(src, dst, 4)  # RENAME_EXCL
    else:
        raise PackageError('macOS bundle publication requires macOS renamex_np(RENAME_EXCL)')
    if result:
        code = ctypes.get_errno()
        raise PackageError(f'Cannot exclusively publish {destination}: {os.strerror(code)}')

def copy_codec_runtime(runtime: Path, macos: Path, resources: Path) -> dict | None:
    if not os.path.lexists(runtime / 'ffmpeg'):
        return None
    # Share the bounded receipt/ordinary-file/source-pin checks with the desktop
    # packager. Importing this module only defines functions; it runs no tools.
    script = Path(__file__).with_name('package-gpui-desktop.py')
    spec = importlib.util.spec_from_file_location('_singz_codec_payload', script)
    if spec is None or spec.loader is None:
        raise PackageError('Cannot load native codec packaging validator')
    desktop = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(desktop)
    try:
        selected, summary, expected = desktop.codec_payload(runtime, 'macos')
        pins = []
        for source, relative, selection, _ in selected:
            # Contents/MacOS is a code location to codesign. Keep only the
            # four loader-relative dylibs there; receipts/notices are resources.
            library = selection == 'ffmpeg-library'
            destination = (macos if library else resources) / relative
            bundle_prefix = 'Contents/MacOS/' if library else 'Contents/Resources/'
            record = desktop.copy_selected(source, destination, selection)
            if record['sha256'] != expected[relative.as_posix()]['sha256'] or record['identity']['bytes'] != expected[relative.as_posix()]['bytes']:
                raise PackageError(f'Codec runtime changed after selection: {relative}')
            pins.append({'payloadPath': bundle_prefix + relative.as_posix(), **record})
        return {**summary, 'sourceFiles': pins, 'location': 'Contents/MacOS/ffmpeg',
                'metadataLocation': 'Contents/Resources/ffmpeg',
                'receiptPath': 'Contents/Resources/ffmpeg/codec-runtime-manifest.json',
                'receiptPathScope': 'original staged input paths; sourceFiles maps delivered bundle paths'}
    except desktop.PackageError as error:
        raise PackageError(str(error)) from error


def assemble(runtime: Path, output: Path, *, version: str | None = None, engines: Path | None = None,
             icon: Path | None = None, font_license_dir: Path | None = None,
             ad_hoc_sign: bool = False, inspector=inspect_dependencies,
             run=command, publisher=rename_exclusive, require_drive_config: bool = False,
             build_info_file: Path | None = None, release: bool = False, env=None) -> Path:
    runtime, output = Path(runtime).absolute(), Path(output).absolute()
    if publisher is rename_exclusive and sys.platform != 'darwin':
        raise PackageError('Actual macOS bundle publication requires macOS')
    ordinary(runtime, True)
    if output.suffix != '.app':
        raise PackageError('Output must end in .app')
    ordinary(output.parent, True)
    output = output.parent.resolve() / output.name
    manifest_path = output.with_name(output.name + '.manifest.json')
    dmg_path = output.with_suffix('.dmg')
    if os.path.lexists(output) or os.path.lexists(manifest_path) or (release and os.path.lexists(dmg_path)):
        raise PackageError(f'Output bundle or manifest already exists: {output}')
    if version is None:
        with (ROOT / 'experiments/gpui-player/Cargo.toml').open('rb') as stream:
            version = tomllib.load(stream)['package']['version']
    if not version or any(char not in '0123456789.' for char in version) or any(not part for part in version.split('.')):
        raise PackageError('Version must contain numeric components separated by dots')
    required = [Path(name) for name in EXECUTABLES] + [Path('pitch') / name for name in ('crepe-tiny.bin', 'torchcrepe-LICENSE.txt')] + [Path('training-sounds') / name for name in SAMPLES]
    # Validate every entry under copied trees, including otherwise unused extras.
    for directory in ('pitch', 'training-sounds'):
        tree_files(runtime / directory)
    for relative in required:
        source = runtime / relative
        ordinary(source)
        if source.stat().st_size == 0:
            raise PackageError(f'Empty required payload: {source}')
    for name in EXECUTABLES:
        source = runtime / name
        if not source.stat().st_mode & 0o111 or not macho(source):
            raise PackageError(f'Required executable must be executable Mach-O: {source}')
    # Every shipped executable, not only the player: a helper that ever reads a
    # gated name must be refused here too (the desktop packager does the same).
    for name in EXECUTABLES:
        reject_ui_tests_binary(runtime / name)
    font_license_dir = Path(font_license_dir) if font_license_dir is not None else ROOT.parent / 'singz-ui/gpui/assets/fonts'
    try:
        ordinary(font_license_dir, True)
        for name in FONT_LICENSES:
            notice = font_license_dir / name
            ordinary(notice)
            if not notice.stat().st_size:
                raise PackageError(f'Empty required font notice: {notice}')
    except PackageError as error:
        raise PackageError(f'Required embedded-font notices unavailable; provide --font-license-dir: {error}') from error
    if engines is not None:
        engines = Path(engines).absolute()
        if not tree_files(engines):
            raise PackageError('Engine payload is empty')
        require_native_payload(engines)
    copied_trees = [runtime / 'pitch', runtime / 'training-sounds']
    if engines is not None:
        copied_trees.append(engines)
    for source_tree in copied_trees:
        if output.parent.is_relative_to(source_tree.resolve()):
            raise PackageError(f'Output/staging parent is inside recursively copied payload: {source_tree}')
    if icon is not None:
        icon = Path(icon).absolute()
        ordinary(icon)
        if icon.suffix != '.icns' or icon.stat().st_size < 8 or icon.read_bytes()[:4] != b'icns':
            raise PackageError('Icon must be an ordinary .icns file')
    with tempfile.TemporaryDirectory(prefix='.singz-package-', dir=output.parent) as temporary:
        staging = Path(temporary)
        bundle = staging / output.name
        macos = bundle / 'Contents/MacOS'
        resources = bundle / 'Contents/Resources'
        macos.mkdir(parents=True)
        resources.mkdir()
        licenses = resources / 'licenses'
        licenses.mkdir()
        for name in FONT_LICENSES:
            copy_payload_file(font_license_dir / name, licenses / name)
        for name in EXECUTABLES:
            copy_payload_file(runtime / name, macos / name)
        for directory in ('pitch', 'training-sounds'):
            copy_payload_tree(runtime / directory, resources / directory)
        codec_runtime = copy_codec_runtime(runtime, macos, resources)
        if engines is not None:
            copy_payload_tree(engines, resources / 'engines')
        if icon is not None:
            copy_payload_file(icon, resources / 'SingZ.icns')
        info = {'CFBundleIdentifier': BUNDLE_ID, 'CFBundleName': 'SingZ Preview', 'CFBundleDisplayName': 'SingZ Preview',
                'CFBundleExecutable': EXECUTABLES[0], 'CFBundlePackageType': 'APPL', 'CFBundleVersion': version,
                'CFBundleShortVersionString': version, 'NSHighResolutionCapable': True,
                'NSMicrophoneUsageDescription': 'SingZ uses your selected microphone for live pitch matching, input meters and headphone monitoring.'}
        if icon is not None:
            info['CFBundleIconFile'] = 'SingZ.icns'
        require_native_payload(bundle)
        dependencies = dependency_inventory(bundle, inspector)
        indexed = {record['path']: record for record in dependencies}
        application_architectures = set(indexed['Contents/MacOS/singz-gpui-player']['architectures'])
        for name in ('llama-server', 'crispasr'):
            relative = 'Contents/Resources/engines/' + name
            if (resources / 'engines' / name).exists():
                record = indexed.get(relative)
                if record is None or record['filetype'] != 'EXECUTE' or not application_architectures.issubset(record['architectures']):
                    raise PackageError(f'Engine is missing application architecture or not MH_EXECUTE: {name}')
        if codec_runtime is not None:
            for name in codec_runtime['libraryNames']:
                record = indexed.get('Contents/MacOS/ffmpeg/' + name)
                if record is None or record['filetype'] != 'DYLIB' or not application_architectures.issubset(record['architectures']):
                    raise PackageError(f'Codec dylib is missing application architectures or not MH_DYLIB: {name}')
        info['LSMinimumSystemVersion'] = max((record['minimumMacOS'] for record in dependencies), key=version_key)
        with (bundle / 'Contents/Info.plist').open('wb') as stream:
            plistlib.dump(info, stream)
        build_info = native_build_info(build_info_file, macos / EXECUTABLES[0], 'macos', require_drive_config)
        if build_info is not None:
            app_image = next(record for record in dependencies if record['path'] == 'Contents/MacOS/singz-gpui-player')
            reported_arch = {'aarch64': 'arm64', 'x86_64': 'x86_64'}[build_info['arch']]
            if reported_arch not in app_image['architectures']:
                raise PackageError('Native build-info architecture does not match payload')
        if release:
            with contextlib.ExitStack() as signing_stack:
                identity, credentials = ('-', None) if ad_hoc_sign else signing_configuration(os.environ if env is None else env, run, signing_stack)
                if identity == '-':
                    print('Developer ID identity or notary credentials unavailable; using ad-hoc signing (not notarized).', file=sys.stderr)
                sign_bundle(bundle, dependencies, identity, run, credentials.get('keychain') if credentials else None)
                release_artifacts(bundle, staging / dmg_path.name, identity, credentials, run)
            ad_hoc_sign = identity == '-'
        elif ad_hoc_sign:
            sign_bundle(bundle, dependencies, '-', run)
        contents = [{'path': path.relative_to(bundle).as_posix(), 'bytes': path.stat().st_size,
                     'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in tree_files(bundle)]
        manifest = staging / 'manifest.json'
        manifest.write_text(json.dumps({'schema': 1, 'nativeBuildInfo': build_info, 'driveConfigRequired': require_drive_config, 'bundle': output.name, 'bundleIdentifier': BUNDLE_ID,
            'version': version, 'adHocSigned': ad_hoc_sign, 'machoDependencies': dependencies, 'files': contents, 'codecRuntime': codec_runtime}, indent=2) + '\n')
        # Reserve neither name by overwriting. Publish the manifest first, then
        # remove only our exact manifest if another process wins the bundle name.
        if release:
            dmg_identity = (staging / dmg_path.name).stat()
            publisher(staging / dmg_path.name, dmg_path)
        def remove_our_dmg():
            if release:
                try:
                    current = dmg_path.lstat()
                    if (current.st_dev, current.st_ino) == (dmg_identity.st_dev, dmg_identity.st_ino):
                        dmg_path.unlink()
                except OSError:
                    pass
        with manifest.open('rb') as reserved:
            identity = os.fstat(reserved.fileno())
            try:
                publisher(manifest, manifest_path)
            except BaseException:
                remove_our_dmg()
                raise
            try:
                publisher(bundle, output)
            except BaseException:
                try:
                    current = manifest_path.lstat()
                    if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                        manifest_path.unlink()
                except OSError:
                    pass  # Cleanup must not mask the original publication error.
                remove_our_dmg()
                raise
    return manifest_path

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--version')
    parser.add_argument('--engines-dir', type=Path, required=True)
    parser.add_argument('--icon', type=Path, help='Optional existing .icns; no image generation')
    parser.add_argument('--font-license-dir', type=Path, help='Directory containing required Bricolage-OFL.txt and MartianMono-OFL.txt notices')
    parser.add_argument('--ad-hoc-sign', action='store_true')
    parser.add_argument('--require-drive-config', action='store_true', help='Require configured baked Drive metadata bound to the unsigned source UI hash')
    parser.add_argument('--build-info-file', type=Path, help='Safe JSON previously emitted by the source UI --native-build-info; assembler never runs it')
    parser.add_argument('--allow-debug', action='store_true', help='Allow packaging a target/debug build for local qualification')
    args = parser.parse_args()
    try:
        require_fresh_vendor()
        validate_runtime_profile(args.runtime_dir, args.allow_debug)
        for name in ('llama-server', 'crispasr'):
            engine = args.engines_dir / name
            ordinary(engine)
            if not engine.stat().st_mode & 0o111 or not macho(engine):
                raise PackageError(f'Required engine must be executable Mach-O: {engine}')
        result = assemble(args.runtime_dir, args.output, version=args.version, engines=args.engines_dir, icon=args.icon, font_license_dir=args.font_license_dir, ad_hoc_sign=args.ad_hoc_sign, require_drive_config=args.require_drive_config, build_info_file=args.build_info_file, release=True)
    except (PackageError, OSError, ValueError) as error:
        parser.exit(1, f'Packaging failed: {error}\n')
    print(result)
    print('Gatekeeper check (run on the app inside a quarantined mounted dmg): spctl -a -vv -t open --context context:primary-signature <mounted-app-path>')

if __name__ == '__main__':
    main()
