#!/usr/bin/env python3
"""Build pinned static libtorrent + OpenSSL for desktop, iOS and Android.
Only this script downloads dependencies; normal application builds stay offline.
"""
import argparse,hashlib,json,os,platform,re,shutil,subprocess,sys,tarfile,tempfile,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCES={
 "libtorrent":("https://github.com/arvidn/libtorrent/releases/download/v2.1.2/libtorrent-rasterbar-2.1.2.tar.gz","3362546d9cd71b9e49ee6cac7d3f1f914ce9cdb217c86b63d5b22cbed0334dbc"),
 "boost":("https://archives.boost.io/release/1.89.0/source/boost_1_89_0.tar.bz2","85a33fa22621b4f314f8e85e1a5e2a9363d22e4f4992925d4bb3bc631b5a0c7a"),
 "openssl":("https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz","603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a")
}
def run(args,cwd=None,env=None):subprocess.run([str(a) for a in args],cwd=cwd,env=env,check=True)
def source(name):
 url,digest=SOURCES[name];base=ROOT/'.engines-src'/'torrent';base.mkdir(parents=True,exist_ok=True)
 archive=base/url.rsplit('/',1)[1]
 if not archive.exists():
  tmp=Path(str(archive)+'.part');print('Downloading',name,flush=True)
  with urllib.request.urlopen(url,timeout=120) as response,tmp.open('wb') as out:shutil.copyfileobj(response,out)
  tmp.rename(archive)
 if hashlib.sha256(archive.read_bytes()).hexdigest()!=digest:raise RuntimeError('Checksum mismatch: '+name)
 destination=base/(name+'-'+digest[:12])
 if not destination.exists():
  temporary=base/(name+'.extract')
  if temporary.exists():shutil.rmtree(temporary)
  temporary.mkdir()
  with tarfile.open(archive) as tar:tar.extractall(temporary,filter='data')
  children=list(temporary.iterdir())
  if len(children)!=1:raise RuntimeError('Unexpected source archive layout')
  children[0].rename(destination);temporary.rmdir()
 return destination

CA_SHA256="796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe"
def patch_certificates(lt):
 bundle=(ROOT/'third_party/torrent/cacert.pem').read_bytes()
 if hashlib.sha256(bundle).hexdigest()!=CA_SHA256:raise RuntimeError("Torrent CA bundle checksum mismatch")
 certificates=re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----",bundle.decode('utf-8'),re.S)
 if not certificates:raise RuntimeError("Torrent CA bundle is empty")
 include=lt/'src/singz_root_certificates.inc'
 content="// Generated from SingZ's pinned, MPL-2.0 Mozilla CA snapshot.\n"
 for cert in certificates:
  content+="m_ssl_ctx.add_certificate_authority(boost::asio::buffer("+json.dumps(cert+"\n")+"), ec);\n"
 if not include.exists() or include.read_text()!=content:
  fd,name=tempfile.mkstemp(dir=include.parent);os.close(fd);temporary=Path(name);temporary.write_text(content);temporary.replace(include)
 source=lt/'src/session_impl.cpp';text=source.read_text()
 anchor="m_ssl_ctx.set_default_verify_paths(ec);"
 injection='\n#if defined(TORRENT_USE_OPENSSL)\n#include "singz_root_certificates.inc"\n#endif'
 if injection not in text:
  if text.count(anchor)!=1:raise RuntimeError("libtorrent trust-store patch anchor changed")
  fd,name=tempfile.mkstemp(dir=source.parent);os.close(fd);temporary=Path(name);temporary.write_text(text.replace(anchor,anchor+injection));temporary.replace(source)

def build(target,jobs):
 # Programmatic callers must hold the same real repository lock as the CLI.
 run(['node',ROOT/'scripts/assert-native-build-lock.cjs'],cwd=ROOT)
 lt=source('libtorrent');boost=source('boost');ssl=source('openssl');patch_certificates(lt)
 prefix=ROOT/'vendor'/'torrent'/target;prefix.mkdir(parents=True,exist_ok=True)
 builddir=ROOT/'.engines-src'/'torrent'/'build'/target;builddir.mkdir(parents=True,exist_ok=True)
 env=os.environ.copy();cmake=[];flags=[];host=platform.system()
 if target.startswith('ios-'):
  sim='sim' in target;arch='x86_64' if target.endswith('x64') else 'arm64';sdk='iphonesimulator' if sim else 'iphoneos'
  sdkpath=subprocess.check_output(['xcrun','--sdk',sdk,'--show-sdk-path'],text=True).strip()
  ssl_target='iossimulator-xcrun' if sim else 'ios64-xcrun'
  flags=['-arch',arch,'-isysroot',sdkpath,'-mios-simulator-version-min=15.1' if sim else '-miphoneos-version-min=15.1']
  env.update(CC='clang',CXX='clang++',SDKROOT=sdkpath)
  cmake+=['-DCMAKE_SYSTEM_NAME=iOS','-DCMAKE_OSX_SYSROOT='+sdkpath,'-DCMAKE_OSX_ARCHITECTURES='+arch,'-DCMAKE_OSX_DEPLOYMENT_TARGET=15.1']
 elif target.startswith('android-'):
  abi=target.removeprefix('android-');ndk=Path(env.get('ANDROID_NDK_HOME',str(Path(env.get('ANDROID_HOME',str(Path.home()/'Library/Android/sdk')))/'ndk/27.1.12297006')))
  tools=ndk/'toolchains/llvm/prebuilt'/('darwin-x86_64' if host=='Darwin' else 'linux-x86_64')/'bin'
  env['PATH']=str(tools)+os.pathsep+env['PATH']
  names={'arm64-v8a':('android-arm64','aarch64-linux-android'),'armeabi-v7a':('android-arm','armv7a-linux-androideabi'),'x86_64':('android-x86_64','x86_64-linux-android'),'x86':('android-x86','i686-linux-android')}
  ssl_target,triple=names[abi];env.update(ANDROID_NDK_ROOT=str(ndk),CC=triple+'24-clang',CXX=triple+'24-clang++')
  cmake+=['-DCMAKE_TOOLCHAIN_FILE='+str(ndk/'build/cmake/android.toolchain.cmake'),'-DANDROID_ABI='+abi,'-DANDROID_PLATFORM=24']
 elif target.startswith('darwin-'):
  arch='arm64' if target.endswith('arm64') else 'x86_64'
  ssl_target='darwin64-arm64-cc' if arch=='arm64' else 'darwin64-x86_64-cc'
  flags=['-arch',arch,'-mmacosx-version-min=12.0'];cmake+=['-DCMAKE_OSX_ARCHITECTURES='+arch,'-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0']
 elif target=='win32-x64':ssl_target='VC-WIN64A'
 elif target=='linux-x64':ssl_target='linux-x86_64'
 elif target=='linux-arm64':ssl_target='linux-aarch64'
 else:raise RuntimeError('Unsupported target: '+target)
 sslbuild=builddir/'openssl';sslbuild.mkdir(exist_ok=True)
 if flags: env.update(CFLAGS=' '.join(flags),CXXFLAGS=' '.join(flags))
 if not (prefix/'lib/libcrypto.a').exists() and not (prefix/'lib/libcrypto.lib').exists():
  run(['perl',ssl/'Configure',ssl_target,'no-shared','no-tests','no-module',*(['no-asm'] if host=='Windows' else []),'--prefix='+str(prefix),'--libdir=lib'],sslbuild,env)
  maker='nmake' if host=='Windows' else 'make'
  run([maker,*([] if host=='Windows' else ['-j'+str(jobs)])],sslbuild,env);run([maker,'install_sw'],sslbuild,env)
 # Libtorrent uses Boost headers only. No system Boost or Boost binaries.
 config=prefix/'lib/cmake/Boost-1.89.0';config.mkdir(parents=True,exist_ok=True)
 (config/'BoostConfig.cmake').write_text(
  'set(Boost_FOUND TRUE)\nset(Boost_VERSION 108900)\nset(Boost_MAJOR_VERSION 1)\nset(Boost_MINOR_VERSION 89)\n'
  'if(NOT TARGET Boost::headers)\nadd_library(Boost::headers INTERFACE IMPORTED)\n'
  'set_target_properties(Boost::headers PROPERTIES INTERFACE_INCLUDE_DIRECTORIES "'+boost.as_posix()+'" INTERFACE_COMPILE_DEFINITIONS "BOOST_ALL_NO_LIB")\nendif()\n')
 (config/'BoostConfigVersion.cmake').write_text('set(PACKAGE_VERSION "1.89.0")\nif(PACKAGE_FIND_VERSION VERSION_GREATER PACKAGE_VERSION)\nset(PACKAGE_VERSION_COMPATIBLE FALSE)\nelse()\nset(PACKAGE_VERSION_COMPATIBLE TRUE)\nendif()\n')
 cmake += ['-DBoost_DIR='+str(config),'-DOPENSSL_INCLUDE_DIR='+str(prefix/'include'),'-DOPENSSL_SSL_LIBRARY='+str(prefix/'lib/libssl.a'),'-DOPENSSL_CRYPTO_LIBRARY='+str(prefix/'lib/libcrypto.a')] if host!='Windows' else ['-DBoost_DIR='+str(config)]
 ltdir=builddir/'libtorrent'
 run(['cmake','-S',lt,'-B',ltdir,'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_INSTALL_PREFIX='+str(prefix),
  '-DCMAKE_PREFIX_PATH='+str(prefix),'-DOPENSSL_ROOT_DIR='+str(prefix),'-DOPENSSL_USE_STATIC_LIBS=ON',
  '-DCMAKE_POSITION_INDEPENDENT_CODE=ON','-DBUILD_SHARED_LIBS=OFF','-Dbuild_tests=OFF','-Dbuild_examples=OFF',
  '-Dbuild_tools=OFF','-Dpython-bindings=OFF','-Dwebtorrent=OFF','-Dlogging=OFF','-Di2p=OFF',*cmake],env=env)
 run(['cmake','--build',ltdir,'--config','Release','--parallel',str(jobs)],env=env);run(['cmake','--install',ltdir,'--config','Release'],env=env)
 cmake += ['-DLibtorrentRasterbar_DIR='+str(prefix/'lib/cmake/LibtorrentRasterbar')]
 built_stamp=hashlib.sha256((ROOT/'native/torrent/torrent_engine.cpp').read_bytes()).hexdigest()
 core=builddir/'core'
 run(['cmake','-S',ROOT/'native/torrent','-B',core,'-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_INSTALL_PREFIX='+str(prefix),'-DCMAKE_PREFIX_PATH='+str(prefix),'-DOPENSSL_ROOT_DIR='+str(prefix),'-DOPENSSL_USE_STATIC_LIBS=ON',*cmake],env=env)
 run(['cmake','--build',core,'--config','Release','--parallel',str(jobs)],env=env);run(['cmake','--install',core,'--config','Release'],env=env)
 if hashlib.sha256((ROOT/'native/torrent/torrent_engine.cpp').read_bytes()).hexdigest()!=built_stamp:raise RuntimeError('Torrent source changed during build; rebuild before packaging')
 notices=prefix/'notices';notices.mkdir(exist_ok=True)
 for name,src in [('libtorrent',lt/'LICENSE'),('boost',boost/'LICENSE_1_0.txt'),('openssl',ssl/'LICENSE.txt')]:shutil.copy2(src,notices/(name+'.txt'))
 shutil.copy2(ROOT/'third_party/torrent/README.md',notices/'mozilla-ca.txt')
 (prefix/'manifest.json').write_text(json.dumps({'target':target,'sources':SOURCES,'core':'C++ libtorrent 2.1.2','caSha256':CA_SHA256,'coreSourceStamp':built_stamp},indent=2)+'\n')
 print('Torrent SDK ready:',prefix,flush=True)
if __name__=='__main__':
 parser=argparse.ArgumentParser()
 parser.add_argument('target',nargs='?',default=('darwin-' if sys.platform=='darwin' else 'win32-' if sys.platform=='win32' else 'linux-')+('arm64' if platform.machine() in ('arm64','aarch64') else 'x64'))
 parser.add_argument('--jobs',type=int,default=4);args=parser.parse_args()
 if not os.environ.get('SINGZ_NATIVE_BUILD_LOCK_HELD'):
  # Re-enter through the canonical owner before downloading or modifying SDKs.
  os.execvp('node',['node',str(ROOT/'scripts/with-native-build-lock.mjs'),
   '--owner','torrent-sdk:'+args.target,'--',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:]])
 build(args.target,max(1,min(4,args.jobs)))
