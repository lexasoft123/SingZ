#!/usr/bin/env python3
"""Build/stage the three native GPUI helpers with the pinned desktop codecs.

No Node, downloads or machine installation. Provision a verified codec SDK first
with gpui-codec-runtime.py; --basic-only explicitly selects WAV/FLAC/MP3 only.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
HELPERS = ('singz-gpui-audio', 'singz-analyze', 'singz-gpui-input')
RECEIPT = 'codec-runtime-manifest.json'


def analyze_source_hash(root: Path = ROOT) -> str:
    """Use the established analyzer fingerprint, including in source archives."""
    if os.name == 'nt':
        # Only this child sees POSIX tools first. MSVC's link.exe must retain
        # priority in the parent environment used for CMake compilation.
        command = ['bash', '-c',
                   'export PATH="/usr/bin:$PATH"; '
                   'root=$(cygpath -u "$1") || exit; '
                   'exec bash "$root/scripts/analyze-source-hash.sh" "$root"',
                   'gpui-analyze-hash', str(root)]
    else:
        command = ['bash', str(root / 'scripts/analyze-source-hash.sh'), str(root)]
    result = subprocess.run(command, check=False, capture_output=True, text=True,
                            timeout=120)
    if result.returncode != 0:
        # The hash script's own message is the only clue on a CI runner.
        raise RuntimeError(
            f'Canonical analyzer source hash failed (exit {result.returncode}): '
            f'{result.stderr.strip() or "no stderr"}')
    value = result.stdout.strip()
    if not re.fullmatch('[0-9a-f]{40}', value):
        raise RuntimeError('Canonical analyzer source hash is not 40 lowercase hex characters')
    return value


def verify_analyzer_source_hash(binary: Path, expected: str) -> None:
    """Qualify the binary's embedded answer, never a neighboring sidecar."""
    result = subprocess.run([str(binary), 'build-info'], check=True,
                            capture_output=True, text=True, timeout=10)
    try:
        info = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f'Invalid analyzer build-info from {binary}') from error
    if not isinstance(info, dict) or info.get('version') != 1 or info.get('sourceHash') != expected:
        raise RuntimeError(f'Analyzer source provenance mismatch at {binary}; expected {expected}')


def load_script(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def native_target() -> str:
    system, machine = platform.system(), platform.machine().lower()
    if system == 'Darwin' and machine in ('arm64', 'aarch64'):
        return 'darwin-arm64'
    if system == 'Darwin' and machine in ('x86_64', 'amd64'):
        return 'darwin-x64'
    if system == 'Linux' and machine in ('x86_64', 'amd64'):
        return 'linux-x64'
    if system == 'Windows' and machine in ('x86_64', 'amd64'):
        return 'win32-x64'
    raise RuntimeError(f'Unsupported native GPUI helper host: {system}/{machine}')


def cmake_path() -> str:
    found = shutil.which('cmake')
    if found:
        return found
    if os.name == 'nt':
        candidate = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)')) / 'Microsoft Visual Studio/2022/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
        if candidate.is_file():
            return str(candidate)
    raise RuntimeError('CMake is unavailable; install the native C++ build tools')


def stage_codecs(codecs, pack: Path, target: str, output: Path) -> None:
    """Stage only the four selected runtimes and their immutable provenance.

    An existing identical generated codec directory is reusable. A different or
    foreign directory is preserved; choose a fresh output to change codec SDKs.
    """
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    destination = output / 'ffmpeg'
    with tempfile.TemporaryDirectory(prefix='.gpui-codec-output-', dir=output) as temporary:
        staged = Path(temporary) / 'ffmpeg'
        receipt = codecs.stage_runtime(pack, target, staged)
        windows = target.startswith('win32-')
        receipt['fileBase'] = 'runtime-root' if windows else 'codec-directory'
        if windows:
            dlls = {library['runtimeName'] for library in receipt['libraries']}
            for row in receipt['files']:
                if row['path'] not in dlls:
                    row['path'] = 'ffmpeg/' + row['path']
        (staged / RECEIPT).write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
        if destination.exists() or destination.is_symlink():
            if destination.is_symlink() or not (destination / RECEIPT).is_file():
                raise RuntimeError(f'Preserving foreign codec directory: {destination}; use a fresh output')
            current = json.loads((destination / RECEIPT).read_text(encoding='utf-8'))
            if current != receipt:
                raise RuntimeError(f'Codec selection changed at {destination}; use a fresh output directory')
            expected = {RECEIPT}
            for row in current['files']:
                relative = codecs.relative(row['path'])
                path = (output if windows else destination) / relative
                if path.resolve(strict=True) != path.absolute():
                    raise RuntimeError(f'Linked existing codec file: {path}')
                codecs.regular(path)
                if path.stat().st_size != row['bytes'] or codecs.digest(path) != row['sha256']:
                    raise RuntimeError(f'Existing codec bytes changed: {path}')
                if not windows or row['path'].startswith('ffmpeg/'):
                    expected.add(path.relative_to(destination).as_posix())
            actual = {p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file() or p.is_symlink()}
            if actual != expected:
                raise RuntimeError(f'Preserving unselected files in {destination}; use a fresh output')
            return
        if windows:
            for library in receipt['libraries']:
                path = output / library['runtimeName']
                if path.exists() or path.is_symlink():
                    if path.is_symlink() or not path.is_file() or codecs.digest(path) != library['sha256']:
                        raise RuntimeError(f'Preserving foreign adjacent DLL: {path}')
            for library in receipt['libraries']:
                source = staged / library['runtimeName']
                path = output / library['runtimeName']
                if not path.exists():
                    shutil.copyfile(source, path)
                source.unlink()
        codecs.publish(staged, destination)


def build(output_dir: Path, *, codec_pack: Path | None = None, basic_only: bool = False,
          jobs: int = 2, build_dir: Path | None = None, audio_output: Path | None = None,
          print_plan: bool = False) -> dict:
    if not 1 <= jobs <= 4:
        raise RuntimeError('Native build jobs must be between 1 and 4')
    target = native_target()
    codecs = load_script('singz_gpui_codecs', 'gpui-codec-runtime.py')
    locks = load_script('singz_gpui_build_lease', 'gpui_native_build_lock.py')
    output = Path(output_dir).resolve()
    audio = Path(audio_output).resolve() if audio_output else output / ('singz-gpui-audio.exe' if target.startswith('win32-') else 'singz-gpui-audio')
    if audio_output:
        output = audio.parent
    pack = Path(codec_pack or os.environ.get('SINGZ_GPUI_CODEC_PACK') or ROOT / 'vendor/ffmpeg-codec' / target)
    if basic_only and codec_pack:
        raise RuntimeError('--basic-only and --codec-pack are mutually exclusive')
    if basic_only:
        info = None
        codec_args = ['-DSINGZ_ENABLE_FFMPEG_CODECS=OFF']
        if (output / 'ffmpeg').exists():
            raise RuntimeError('Basic-only output already contains codecs; choose a fresh output directory')
    else:
        if not pack.is_dir():
            raise RuntimeError(f'Missing pinned codec SDK: {pack}. Provision it with gpui-codec-runtime.py build, pass --codec-pack, or explicitly request --basic-only')
        info = codecs.inspect_pack(pack, target)
        codec_args = info['cmakeArgs']
    checkout = hashlib.sha256(str(ROOT).encode()).hexdigest()[:12]
    directory = Path(build_dir).resolve() if build_dir else ROOT / f'experiments/gpui-player/target/native-{checkout}-{target}-{"basic" if basic_only else "codecs"}'
    configure = [cmake_path(), '-S', str(ROOT), '-B', str(directory),
                 '-DSINGZ_BUILD_HOST_TOOLS=ON', '-DSINGZ_BUILD_ELECTRON_CAPTURE=OFF',
                 '-DSINGZ_CORE_TESTS=OFF', '-DCMAKE_BUILD_TYPE=Release',
                 '-DSINGZ_SOURCE_HASH=<computed-under-build-lease>', *codec_args]
    if target.startswith('win32-'):
        # Static CRT: the helpers must not import vcruntime140*/msvcp140.dll, which a
        # clean machine may lack. The FFmpeg DLLs are C and import only system DLLs.
        configure += ['-G', 'Visual Studio 17 2022', '-A', 'x64',
                      '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded']
    compile_command = [configure[0], '--build', str(directory), '--config', 'Release',
                       '--target', *HELPERS, '--parallel', str(jobs)]
    plan = {'target': target, 'buildDir': str(directory), 'outputDir': str(output),
            'codecPack': None if basic_only else str(pack.resolve()),
            'basicOnly': basic_only, 'configure': configure, 'build': compile_command,
            'audioHelper': str(audio), 'node': False, 'sourceHash': None}
    if print_plan:
        return plan
    with locks.native_build_lock(ROOT, 'gpui-native-helpers:' + target):
        source_hash = analyze_source_hash(ROOT)
        configure[configure.index('-DSINGZ_SOURCE_HASH=<computed-under-build-lease>')] = '-DSINGZ_SOURCE_HASH=' + source_hash
        plan['sourceHash'] = source_hash
        directory.mkdir(parents=True, exist_ok=True)
        output.mkdir(parents=True, exist_ok=True)
        if info:
            # The built helper and the final copied helper share identical
            # relative search paths; both must be usable without environment hacks.
            stage_codecs(codecs, pack, target, directory / 'Release' if target.startswith('win32-') else directory)
            if output.resolve() != (directory / 'Release' if target.startswith('win32-') else directory).resolve():
                stage_codecs(codecs, pack, target, output)
        subprocess.run(configure, check=True, stdout=sys.stderr)
        subprocess.run(compile_command, check=True, stdout=sys.stderr)
        suffix = '.exe' if target.startswith('win32-') else ''
        binaries = directory / 'Release' if target.startswith('win32-') else directory
        if analyze_source_hash(ROOT) != source_hash:
            raise RuntimeError('Analyzer build inputs changed during compilation; helpers were not staged')
        verify_analyzer_source_hash(binaries / ('singz-analyze' + suffix), source_hash)
        for name in HELPERS:
            source = binaries / (name + suffix)
            destination = audio if name == 'singz-gpui-audio' else output / source.name
            if source.resolve() != destination.resolve():
                # Preserve a running Unix helper's old inode during rebuilds.
                with tempfile.NamedTemporaryFile(prefix='.' + source.name + '-', suffix=suffix,
                                                 dir=destination.parent, delete=False) as pending:
                    temporary = Path(pending.name)
                try:
                    shutil.copy2(source, temporary)
                    if name == 'singz-analyze':
                        verify_analyzer_source_hash(temporary, source_hash)
                    os.replace(temporary, destination)
                finally:
                    temporary.unlink(missing_ok=True)
        pitch = output / 'pitch'
        sounds = output / 'training-sounds'
        pitch.mkdir(exist_ok=True)
        sounds.mkdir(exist_ok=True)
        for name in ('crepe-tiny.bin', 'torchcrepe-LICENSE.txt'):
            shutil.copy2(ROOT / 'assets/pitch' / name, pitch / name)
        for source in (ROOT / 'mobile/assets/training-sounds').iterdir():
            if source.is_file():
                shutil.copy2(source, sounds / source.name)
    return plan


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'experiments/gpui-player/target/release')
    parser.add_argument('--audio-output', type=Path, help='Preserve the shell wrapper\'s optional audio-helper filename')
    parser.add_argument('--codec-pack', type=Path)
    parser.add_argument('--basic-only', action='store_true', help='Explicit WAV/FLAC/MP3-only development build')
    parser.add_argument('--jobs', type=int, default=2)
    parser.add_argument('--build-dir', type=Path)
    parser.add_argument('--print-plan', action='store_true')
    args = parser.parse_args()
    try:
        result = build(args.output_dir, codec_pack=args.codec_pack, basic_only=args.basic_only,
                       jobs=args.jobs, build_dir=args.build_dir, audio_output=args.audio_output,
                       print_plan=args.print_plan)
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, f'Native GPUI helper build failed: {error}\n')
    print(json.dumps(result, indent=2) if args.print_plan else result['audioHelper'])


if __name__ == '__main__':
    main()
