#!/usr/bin/env python3
"""Build pinned static libtorrent + OpenSSL for desktop, iOS and Android.
Only this script downloads dependencies; normal application builds stay offline.
"""
import argparse,hashlib,json,ntpath,os,platform,re,shutil,subprocess,sys,tarfile,tempfile,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCES={
 "libtorrent":("https://github.com/arvidn/libtorrent/releases/download/v2.1.2/libtorrent-rasterbar-2.1.2.tar.gz","3362546d9cd71b9e49ee6cac7d3f1f914ce9cdb217c86b63d5b22cbed0334dbc"),
 "boost":("https://archives.boost.io/release/1.89.0/source/boost_1_89_0.tar.bz2","85a33fa22621b4f314f8e85e1a5e2a9363d22e4f4992925d4bb3bc631b5a0c7a"),
 "openssl":("https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz","603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a")
}
def run(args,cwd=None,env=None):
 command=[str(a) for a in args]
 if sys.platform=='win32' and env is not None and not ntpath.isabs(command[0]):
  # CreateProcess ignores the supplied child PATH when locating a bare exe.
  # Resolve against the prepared toolchain, not the caller's unconfigured PATH.
  executable=shutil.which(command[0],path=env.get('PATH',env.get('Path','')))
  if not executable:raise RuntimeError('Build tool is missing from the prepared Windows environment: '+command[0])
  command[0]=executable
 subprocess.run(command,cwd=cwd,env=env,check=True)
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

def msvc_environment(environment):
 # Windows environment names are case-insensitive. Normalize before merging so
 # a captured Path never coexists with the caller's PATH in CreateProcess.
 env={key.upper():value for key,value in environment.items()}
 def ready(candidate):
  arch=candidate.get('VSCMD_ARG_TGT_ARCH','').lower()
  return (arch in ('','x64','amd64') and candidate.get('INCLUDE') and candidate.get('LIB')
   and shutil.which('cl.exe',path=candidate.get('PATH',''))
   and shutil.which('nmake.exe',path=candidate.get('PATH','')))
 if ready(env):return env
 vswhere=shutil.which('vswhere.exe',path=env.get('PATH',''))
 if not vswhere:
  vswhere=ntpath.join(env.get('PROGRAMFILES(X86)',r'C:\Program Files (x86)'),
   'Microsoft Visual Studio','Installer','vswhere.exe')
 if not Path(vswhere).is_file():
  raise RuntimeError('Visual Studio C++ Build Tools are required for the Windows torrent SDK; use an x64 Developer Command Prompt or install the C++ workload.')
 try:
  installation=subprocess.check_output([vswhere,'-latest','-products','*','-requires',
   'Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath','-utf8'],
   env=env,encoding='utf-8',timeout=30).strip().lstrip('\ufeff')
  vcvars=ntpath.join(installation,'VC','Auxiliary','Build','vcvars64.bat')
  if not installation or not Path(vcvars).is_file():
   raise RuntimeError('No Visual Studio x64 C++ toolchain was found for the torrent SDK.')
  # Keep the command itself quote-free: list2cmdline must not turn the batch
  # path's quotes into literal backslashes. cmd expands this quoted value.
  previous_command=env.get('SINGZ_TORRENT_VCVARS_COMMAND')
  command_env={**env,'SINGZ_TORRENT_VCVARS_COMMAND':'"'+vcvars+'"'}
  output=subprocess.check_output([env.get('COMSPEC','cmd.exe'),'/d','/u','/v:off','/s','/c',
   'call %SINGZ_TORRENT_VCVARS_COMMAND% >nul && set'],env=command_env,
   stderr=subprocess.PIPE,timeout=60).decode('utf-16le').lstrip('\ufeff')
 except (subprocess.SubprocessError,UnicodeError,OSError):
  # Never print the captured `set` output: it includes inherited secrets.
  raise RuntimeError('Could not initialize the Visual Studio x64 environment for the torrent SDK.') from None
 for line in output.splitlines():
  key,separator,value=line.partition('=')
  if separator and key:env[key.upper()]=value
 if previous_command is None:env.pop('SINGZ_TORRENT_VCVARS_COMMAND',None)
 else:env['SINGZ_TORRENT_VCVARS_COMMAND']=previous_command
 if not ready(env):
  raise RuntimeError('Visual Studio did not provide cl, nmake, INCLUDE and LIB for the Windows torrent SDK.')
 return env

def windows_perl_environment(environment):
 # Git Bash puts MSYS Perl first, but VC-WIN64A needs a native Windows Perl.
 # Probe the interpreter rather than inferring its runtime from a directory.
 env={key.upper():value for key,value in environment.items()}
 candidates=[]
 explicit=env.get('PERL','').strip().strip('"')
 if explicit:
  candidates.append(explicit)
  resolved=shutil.which(explicit,path=env.get('PATH',''))
  if resolved:candidates.append(resolved)
 for directory in env.get('PATH','').split(';'):
  directory=directory.strip().strip('"')
  if directory:candidates.append(ntpath.join(directory,'perl.exe'))
 candidates.append(ntpath.join(env.get('SYSTEMDRIVE','C:')+'\\',
  'Strawberry','perl','bin','perl.exe'))
 seen=set()
 for candidate in candidates:
  candidate=ntpath.abspath(candidate)
  key=ntpath.normcase(ntpath.normpath(candidate))
  if key in seen or not Path(candidate).is_file():continue
  seen.add(key)
  try:
   runtime=subprocess.check_output([candidate,'-e','print $^O'],env=env,
    encoding='ascii',stderr=subprocess.PIPE,timeout=10).strip()
  except (subprocess.SubprocessError,UnicodeError,OSError):
   continue
  if runtime!='MSWin32':continue
  env['PERL']=candidate
  directory=ntpath.dirname(candidate)
  env['PATH']=directory+(';' + env['PATH'] if env.get('PATH') else '')
  return env
 raise RuntimeError('Native Windows Perl is required for the torrent SDK. Install Strawberry Perl or set PERL to a native Windows perl.exe; Git/MSYS and Cygwin Perl are not supported for VC-WIN64A.')

def build(target,jobs):
 # Programmatic callers must hold the same real repository lock as the CLI.
 run(['node',ROOT/'scripts/assert-native-build-lock.cjs'],cwd=ROOT)
 host=platform.system()
 env=windows_perl_environment(msvc_environment(os.environ)) if host=='Windows' and target=='win32-x64' else os.environ.copy()
 lt=source('libtorrent');boost=source('boost');ssl=source('openssl');patch_certificates(lt)
 prefix=ROOT/'vendor'/'torrent'/target;prefix.mkdir(parents=True,exist_ok=True)
 builddir=ROOT/'.engines-src'/'torrent'/'build'/target;builddir.mkdir(parents=True,exist_ok=True)
 cmake=[];flags=[]
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
  perl=env.get('PERL','perl') if host=='Windows' else 'perl'
  run([perl,ssl/'Configure',ssl_target,'no-shared','no-tests','no-module',*(['no-asm'] if host=='Windows' else []),'--prefix='+str(prefix),'--libdir=lib'],sslbuild,env)
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
  lock_command=['node',str(ROOT/'scripts/with-native-build-lock.mjs'),
   '--owner','torrent-sdk:'+args.target,'--',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:]]
  # Windows exec spawns and exits instead of replacing this process. Wait
  # for the real lock owner so callers cannot start the next build early.
  if sys.platform == 'win32':
   sys.exit(subprocess.run(lock_command,check=False).returncode)
  os.execvp(lock_command[0],lock_command)
 build(args.target,max(1,min(4,args.jobs)))
