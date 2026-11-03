#!/usr/bin/env python3
"""Package the same static C++ core for iPhone and Apple Silicon Simulator."""
import argparse,hashlib,json,os,shutil,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def run(args):subprocess.run([str(x)for x in args],cwd=ROOT,check=True)
parser=argparse.ArgumentParser();parser.add_argument('--skip-build',action='store_true');args=parser.parse_args()
if not os.environ.get('SINGZ_NATIVE_BUILD_LOCK_HELD'):
 lock_command=['node',str(ROOT/'scripts/with-native-build-lock.mjs'),
  '--owner','torrent-ios','--',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:]]
 # Windows exec spawns and exits instead of replacing this process. Wait
 # for the real lock owner so callers cannot start the next build early.
 if sys.platform == 'win32':
  sys.exit(subprocess.run(lock_command,check=False).returncode)
 os.execvp(lock_command[0],lock_command)
# Bootstrap already holds the canonical lock; validate its actual token instead
# of acquiring it again. Nested SDK builds inherit and assert this same owner.
run(['node',ROOT/'scripts/assert-native-build-lock.cjs'])
parts=[]
for target in ['ios-arm64','ios-sim-arm64']:
 if not args.skip_build:run(['python3','scripts/vendor-torrent.py',target])
 prefix=ROOT/'vendor/torrent'/target
 manifest=json.loads((prefix/'manifest.json').read_text())
 if manifest.get('coreSourceStamp')!=hashlib.sha256((ROOT/'native/torrent/torrent_engine.cpp').read_bytes()).hexdigest():raise RuntimeError('Stale torrent SDK: rebuild '+target)
 package=prefix/'merged';package.mkdir(exist_ok=True)
 output=package/'libSingzTorrentCore.a'
 run(['libtool','-static','-o',output,prefix/'lib/libsingz_torrent.a',prefix/'lib/libtorrent-rasterbar.a',prefix/'lib/libssl.a',prefix/'lib/libcrypto.a'])
 headers=package/'Headers';headers.mkdir(exist_ok=True);shutil.copy2(ROOT/'native/torrent/torrent_engine.h',headers)
 parts+=['-library',output,'-headers',headers]
out=ROOT/'mobile/ios/SingzTorrent/SingzTorrentCore.xcframework'
if out.exists():shutil.rmtree(out)
run(['xcodebuild','-create-xcframework',*parts,'-output',out])
run(['node','scripts/sync-torrent-scripts.cjs'])

notices=ROOT/'mobile/ios/SingzTorrent/notices';notices.mkdir(exist_ok=True)
for source in (ROOT/'vendor/torrent/ios-arm64/notices').iterdir():shutil.copy2(source,notices/source.name)
