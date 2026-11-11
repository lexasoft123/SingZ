"""Native-build lease compatible with the repository's existing lock protocol."""
from contextlib import contextmanager
from pathlib import Path
import hashlib,json,os,secrets,subprocess,tempfile,time

def repository_identity(root):
    root=Path(root).resolve()
    for arguments in (['--path-format=absolute','--git-common-dir'],['--git-common-dir']):
        try:
            result=subprocess.run(['git','-C',str(root),'rev-parse',*arguments],capture_output=True,text=True)
        except FileNotFoundError:
            return str(root)
        if result.returncode==0:
            value=Path(result.stdout.strip());return str((value if value.is_absolute() else root/value).resolve())
        if result.returncode!=128 and arguments==['--git-common-dir']:
            raise RuntimeError('Cannot resolve native-build repository identity')
    return str(root)

def lock_path(root):
    identity=repository_identity(root)
    normalized=identity.lower() if os.name=='nt' else identity
    return Path(tempfile.gettempdir())/('singz-native-build-'+hashlib.sha256(normalized.encode()).hexdigest()[:24]+'.lock')

@contextmanager
def native_build_lock(root,owner):
    identity=repository_identity(root);path=lock_path(root)
    token=f'{os.getpid()}-{int(time.time()*1000)}-{secrets.token_hex(8)}'
    try:path.mkdir()
    except FileExistsError as error:
        raise RuntimeError(f'Another or interrupted native build owns {path}; inspect its owner before continuing') from error
    directory=path.stat();record=path/'owner.json'
    try:
        record.write_text(json.dumps({'format':1,'token':token,'pid':os.getpid(),'owner':owner,'repoIdentity':identity,'checkout':str(Path(root).resolve()),'startedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())},indent=2)+'\n')
        yield token
    finally:
        current=path.stat()
        if (current.st_dev,current.st_ino)!=(directory.st_dev,directory.st_ino) or json.loads(record.read_text()).get('token')!=token:
            raise RuntimeError('Native build lock ownership changed; leaving the foreign lock untouched')
        record.unlink();path.rmdir()
