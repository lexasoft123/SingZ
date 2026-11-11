"""Native playback parking and monitor lifetime. No Node; hardware mode stays muted.
Usage: test_native_monitor.py <audio-helper> <input-helper> <output> [--hardware] [--hardware-monitor]
"""
import json,math,os,selectors,struct,subprocess,sys,tempfile,time,wave
from pathlib import Path
audio=Path(sys.argv[1]).resolve();capture=Path(sys.argv[2]).resolve();out=Path(sys.argv[3]).resolve();out.mkdir(parents=True,exist_ok=True)
hardware='--hardware' in sys.argv[4:]
hardware_monitor='--hardware-monitor' in sys.argv[4:]
assert not hardware_monitor or hardware,'Real monitoring requires real playback parking'
class Session:
    def __init__(self,args):
        self.child=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env={**os.environ,'SINGZ_MUTE':'1'})
        self.selector=selectors.DefaultSelector();self.selector.register(self.child.stdout,selectors.EVENT_READ)
    def read(self):
        assert self.selector.select(15),'Native receipt timed out'
        value=json.loads(self.child.stdout.readline());assert value['protocol']==1;return value
    def command(self,command,ok=True):
        self.child.stdin.write(command+'\n');self.child.stdin.flush();value=self.read();assert value['ok']==ok,(command,value);return value
    def close(self):
        if self.child.poll() is None:self.child.stdin.write('quit\n');self.child.stdin.flush()
        try:self.child.wait(timeout=5)
        except subprocess.TimeoutExpired:self.child.kill();self.child.wait(timeout=10);raise
        finally:self.selector.close();self.child.stdin.close();self.child.stdout.close()
with tempfile.TemporaryDirectory(prefix='singz-monitor-') as folder:
    source=Path(folder)/'voice.wav'
    with wave.open(str(source),'wb') as stream:
        stream.setparams((1,2,48000,0,'NONE','not compressed'));stream.writeframes(b''.join(struct.pack('<h',int(4000*math.sin(i*math.tau*220/48000))) for i in range(48000*8)))
    playback=Session([str(audio),*([] if hardware else ['--test-fake-host']),'vocals',str(source)])
    try:
        assert playback.read()['ok'];playback.command('lane 0 0.37 0 1');playback.command('rate 0.8 -2')
        playback.command('loop 1 7');playback.command('seek 2');playback.command('play')
        if hardware:time.sleep(.2)
        parked=playback.command('park');assert parked['parked'] and parked['physicalOutputReleased'] and not parked['playing'];assert parked['parkedLaneBytes']>0
        assert parked['looping'] and parked['transpose']==-2 and parked['playbackRate']==.8
        for _ in range(3):
            repeated=playback.command('park');assert repeated['position']==parked['position'] and repeated['parkedLaneBytes']==parked['parkedLaneBytes']
        # Rejected output-opening controls must leave retained audio and proof intact.
        for cmd in ['play','seek 3','rate 1 0','output default','master 1','loop 2 5']:
            rejected=playback.command(cmd,False);assert rejected['parked'] and rejected['physicalOutputReleased']
        monitor_uid='singz:fake-duplex'
        if hardware_monitor:
            permission=json.loads(subprocess.check_output([str(capture),'--permission'],text=True,timeout=30));assert permission['permission']=='granted','Do not request permission in a test'
            inventory=json.loads(subprocess.check_output([str(audio),'--devices'],text=True,timeout=30));monitor_uid=parked['outputUid']
            assert any(d['uid']==monitor_uid and d['inputChannels']>0 and d['outputChannels']>=2 for d in inventory['devices']),'Playback output is not a duplex monitoring endpoint'
        monitor=Session([str(capture),*([] if hardware_monitor else ['--test-fake-host']),'--monitor','--device',monitor_uid,'--output',monitor_uid])
        try:
            initial=monitor.read();assert initial['ok'] and initial['active'] and initial['monitoring'] and initial['fixture']==(not hardware_monitor);assert not initial['monitorEnabled']
            gain=monitor.command('gain -24');assert gain['gainDb']==-24 and not gain['monitorEnabled'],'Mute invariant failed'
            monitor.command('gain 1',False)
            if hardware_monitor:
                begin=time.monotonic()
                while time.monotonic()-begin<2:
                    time.sleep(.05);frame=monitor.command('status');assert frame['active'] and not frame['monitorEnabled'] and frame['postPeak']==0
                assert frame['sequence']>initial['sequence']+10
                (out/'duplex-status.json').write_text(json.dumps(frame,indent=2))
            stopped=monitor.command('stop');assert not stopped['active'];assert monitor.child.wait(timeout=5)==0
        finally:monitor.close()
        restored=playback.command('unpark');assert not restored['parked'] and not restored['playing'];assert restored['graphGeneration']>parked['graphGeneration']
        assert abs(restored['position']-parked['position'])<.03,(parked,restored)
        assert restored['looping'] and restored['transpose']==-2 and restored['playbackRate']==.8
        assert restored['lanes'][0]['solo'] and abs(restored['lanes'][0]['gain']-.37)<.001
        playback.command('play')
        if hardware:
            deadline=time.monotonic()+3
            while True:
                resumed=playback.command('status')
                if resumed['playing'] and resumed['looping'] and resumed['position']>restored['position']+.1:break
                assert time.monotonic()<deadline,(parked,restored,resumed)
                time.sleep(.025)
        (out/'result.json').write_text(json.dumps({'hardwarePlayback':hardware,'hardwareMonitoring':hardware_monitor,'parked':parked,'restored':restored,'monitorStopped':True},indent=2))
    finally:playback.close()
print('PASS: physical output park, retained PCM/config/position, no controls while parked, muted monitor lifetime, paused restore and explicit Play')
