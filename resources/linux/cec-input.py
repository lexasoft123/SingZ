#!/usr/bin/env python3
"""Linux CEC input follower. stdout is JSONL; this helper never transmits commands.

UAPI layouts/ioctls: include/uapi/linux/cec.h in the Linux kernel.
https://docs.kernel.org/userspace-api/media/cec/cec-ioc-g-mode.html
https://docs.kernel.org/userspace-api/media/cec/cec-ioc-adap-g-log-addrs.html
"""
import argparse
import ctypes as C
from dataclasses import dataclass
import errno
import fcntl
import glob
import json
import os
import re
import select
import signal
import stat
import sys
import time


class Caps(C.Structure):
    _fields_ = [("driver", C.c_char * 32), ("name", C.c_char * 32),
                ("available_log_addrs", C.c_uint32), ("capabilities", C.c_uint32),
                ("version", C.c_uint32)]


class LogAddrs(C.Structure):
    _fields_ = [("log_addr", C.c_uint8 * 4), ("log_addr_mask", C.c_uint16),
                ("cec_version", C.c_uint8), ("num_log_addrs", C.c_uint8),
                ("vendor_id", C.c_uint32), ("flags", C.c_uint32),
                ("osd_name", C.c_char * 15), ("primary_device_type", C.c_uint8 * 4),
                ("log_addr_type", C.c_uint8 * 4), ("all_device_types", C.c_uint8 * 4),
                ("features", (C.c_uint8 * 12) * 4)]


class Message(C.Structure):
    _fields_ = [("tx_ts", C.c_uint64), ("rx_ts", C.c_uint64),
                ("len", C.c_uint32), ("timeout", C.c_uint32),
                ("sequence", C.c_uint32), ("flags", C.c_uint32),
                ("msg", C.c_uint8 * 16), ("reply", C.c_uint8),
                ("rx_status", C.c_uint8), ("tx_status", C.c_uint8),
                ("tx_arb_lost_cnt", C.c_uint8), ("tx_nack_cnt", C.c_uint8),
                ("tx_low_drive_cnt", C.c_uint8), ("tx_error_cnt", C.c_uint8)]


class StateChange(C.Structure):
    _fields_ = [("phys_addr", C.c_uint16), ("log_addr_mask", C.c_uint16),
                ("have_conn_info", C.c_uint16)]


class EventPayload(C.Union):
    _fields_ = [("state_change", StateChange), ("raw", C.c_uint32 * 16)]


class Event(C.Structure):
    _anonymous_ = ("payload",)
    _fields_ = [("ts", C.c_uint64), ("event", C.c_uint32), ("flags", C.c_uint32),
                ("payload", EventPayload)]


def ioctl_number(direction, number, structure):
    # asm-generic ioctl encoding used by Linux x86_64 and aarch64.
    return (direction << 30) | (C.sizeof(structure) << 16) | (ord("a") << 8) | number


G_CAPS = ioctl_number(3, 0, Caps)
G_PHYS = ioctl_number(2, 1, C.c_uint16)
G_LOG = ioctl_number(2, 3, LogAddrs)
S_LOG = ioctl_number(3, 4, LogAddrs)
RECEIVE = ioctl_number(3, 6, Message)
DQEVENT = ioctl_number(3, 7, Event)
S_MODE = ioctl_number(1, 9, C.c_uint32)
REQUIRED_CAPS = (1 << 1) | (1 << 2)  # LOG_ADDRS and TRANSMIT (required for follower)
FOLLOWER_MODE = 0x02 | 0x20  # exclusive initiator + exclusive follower, never passthrough
OSD_NAME = b"SingZ Box"
VENDOR_NONE = 0xffffffff


class Unavailable(Exception):
    pass


class Kernel:
    def __init__(self, ioctl=fcntl.ioctl):
        self.ioctl = ioctl

    def request(self, fd, operation, value):
        data = bytearray(bytes(value))
        self.ioctl(fd, operation, data, True)
        return type(value).from_buffer_copy(data)

    def open(self, path):
        fd = os.open(path, os.O_RDWR | os.O_NONBLOCK | os.O_CLOEXEC | os.O_NOFOLLOW)
        if not stat.S_ISCHR(os.fstat(fd).st_mode):
            os.close(fd)
            raise Unavailable("CEC adapter is not a character device.")
        return fd

    def close(self, fd):
        os.close(fd)


@dataclass
class Adapter:
    fd: int
    path: str
    caps: Caps
    physical: int


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def status(output, state, detail):
    output({"type": "status", "state": state, "detail": " ".join(detail.split())[:240]})


def choose_adapter(kernel, device=None, paths=None):
    if device == 'auto':
        device = None
    if device is not None and not re.fullmatch(r"/dev/cec[0-9]+", device):
        raise Unavailable("Choose a CEC adapter named /dev/cecN.")
    candidates = []
    opened = []
    try:
        for path in ([device] if device is not None else sorted(paths if paths is not None else glob.glob('/dev/cec[0-9]*'))):
            if not re.fullmatch(r"/dev/cec[0-9]+", path):
                continue
            fd = kernel.open(path)
            opened.append(fd)
            caps = kernel.request(fd, G_CAPS, Caps())
            identity = (bytes(caps.driver) + b" " + bytes(caps.name)).decode('ascii', 'replace').lower()
            receiver = any(token in identity for token in ('hdmirx', 'hdmi-rx', 'hdmi_rx', 'hdmi rx', 'receiver'))
            if receiver:
                if device is not None:
                    raise Unavailable("Selected CEC adapter is an HDMI receiver.")
                continue
            if caps.available_log_addrs < 1 or caps.capabilities & REQUIRED_CAPS != REQUIRED_CAPS:
                if device is not None:
                    raise Unavailable("Selected CEC adapter cannot register a playback follower.")
                continue
            physical = kernel.request(fd, G_PHYS, C.c_uint16()).value
            if physical in (0, 0xffff):
                if device is not None:
                    raise Unavailable("Selected HDMI output is disconnected or is not a transmitter.")
                continue
            candidates.append(Adapter(fd, path, caps, physical))
        if not candidates:
            raise Unavailable("No connected HDMI CEC transmitter is available.")
        if len(candidates) != 1:
            raise Unavailable("Multiple HDMI CEC outputs are connected; choose one adapter.")
        selected = candidates[0]
        opened.remove(selected.fd)
        return selected
    finally:
        for fd in opened:
            kernel.close(fd)


class Follower:
    def __init__(self, kernel, adapter, output=emit, clock=time.monotonic, sleep=time.sleep):
        self.kernel, self.adapter, self.output = kernel, adapter, output
        self.clock, self.sleep = clock, sleep
        self.owned = False
        self.mask = 0
        self.held = None

    def release(self):
        if self.held is not None:
            code, self.held = self.held, None
            self.output({"type": "key", "code": code, "pressed": False})

    def register(self, stopping=lambda: False):
        self.kernel.request(self.adapter.fd, S_MODE, C.c_uint32(FOLLOWER_MODE))
        prior = self.kernel.request(self.adapter.fd, G_LOG, LogAddrs())
        if prior.num_log_addrs or prior.log_addr_mask:
            # Address registrations outlive their fd after an interrupted exit.
            # Only recover our exact registration after acquiring BOTH exclusive
            # roles above. A live owner fails S_MODE before any address mutation.
            ours = (prior.num_log_addrs == 1 and prior.osd_name == OSD_NAME and
                    prior.vendor_id == VENDOR_NONE and prior.cec_version == 5 and
                    prior.flags == 0 and prior.primary_device_type[0] == 4 and
                    prior.log_addr_type[0] == 3 and
                    (prior.log_addr_mask == 0 or
                     (prior.log_addr[0] in (4, 8, 11) and
                      prior.log_addr_mask == 1 << prior.log_addr[0])))
            if not ours:
                raise Unavailable("CEC adapter is already configured by another application.")
            self.owned = True
            self.kernel.request(self.adapter.fd, S_LOG, LogAddrs())
        # Discard the initial unconfigured event before our asynchronous address claim.
        self.drain_events(initial=True)
        wanted = LogAddrs()
        wanted.cec_version, wanted.num_log_addrs = 5, 1  # CEC 1.4; one playback address
        wanted.vendor_id, wanted.osd_name = VENDOR_NONE, OSD_NAME
        wanted.primary_device_type[0], wanted.log_addr_type[0] = 4, 3
        # flags=0 deliberately disables global RC passthrough and unregistered fallback.
        self.kernel.request(self.adapter.fd, S_LOG, wanted)
        self.owned = True
        deadline = self.clock() + 5
        while not stopping() and self.clock() < deadline:
            current = self.kernel.request(self.adapter.fd, G_LOG, LogAddrs())
            if current.log_addr_mask:
                if current.num_log_addrs != 1 or current.log_addr[0] not in (4, 8, 11) or current.log_addr_mask != 1 << current.log_addr[0]:
                    raise Unavailable("No playback logical address could be claimed.")
                if current.flags & 2:
                    raise Unavailable("CEC remote-control passthrough could not be disabled.")
                self.mask = current.log_addr_mask
                if self.kernel.request(self.adapter.fd, G_PHYS, C.c_uint16()).value != self.adapter.physical:
                    raise Unavailable("HDMI CEC connection changed while claiming an address.")
                return
            self.sleep(0.05)
        if not stopping():
            raise Unavailable("Timed out claiming a playback logical address.")

    def message(self, value):
        if value.sequence or value.tx_status or value.rx_status != 1 or value.flags:
            return
        if value.len not in (2, 3) or value.msg[0] >> 4 != 0:
            return
        destination = value.msg[0] & 15
        if not self.mask & (1 << destination):
            return
        if value.msg[1] == 0x44 and value.len == 3:
            code = int(value.msg[2])
            if self.held is not None and self.held != code:
                self.release()
            self.held = code
            output = {"type": "key", "code": code, "pressed": True}
            # Linux CLOCK_MONOTONIC timestamp, kept as a string to preserve ns.
            if value.rx_ts:
                output["receivedAtNs"] = str(value.rx_ts)
            self.output(output)
        elif value.msg[1] == 0x45 and value.len == 2:
            self.release()

    def drain_events(self, initial=False):
        for _ in range(32):
            try:
                event = self.kernel.request(self.adapter.fd, DQEVENT, Event())
            except OSError as error:
                if error.errno == errno.EAGAIN:
                    return
                raise
            if event.flags & 2 or event.event == 2:
                raise Unavailable("CEC input events were lost; reconnect the remote.")
            if event.event == 1:
                changed = event.state_change
                if changed.phys_addr != self.adapter.physical or (not initial and changed.log_addr_mask != self.mask):
                    raise Unavailable("HDMI CEC connection changed.")
            elif event.event == 5:
                raise Unavailable("HDMI CEC output disconnected.")

    def close(self):
        try:
            self.release()
        finally:
            try:
                if self.owned:
                    current = self.kernel.request(self.adapter.fd, G_LOG, LogAddrs())
                    # Our exclusive initiator lock prevents another userspace claim.
                    # Hotplug may clear/reassign the mask while retaining our request.
                    if (current.num_log_addrs == 1 and current.osd_name == OSD_NAME and
                            current.vendor_id == VENDOR_NONE and current.log_addr_type[0] == 3 and
                            current.primary_device_type[0] == 4):
                        self.kernel.request(self.adapter.fd, S_LOG, LogAddrs())
            finally:
                self.kernel.close(self.adapter.fd)

    def run(self, stopping, poll_factory=None):
        self.register(stopping)
        if stopping():
            return
        status(self.output, 'ready', 'TV remote connected.')
        poll = (poll_factory or select.poll)()
        poll.register(self.adapter.fd, select.POLLIN | select.POLLPRI | select.POLLERR | select.POLLHUP)
        while not stopping():
            events = poll.poll(200)
            if stopping():
                break
            for _, flags in events:
                if flags & (select.POLLERR | select.POLLHUP | select.POLLNVAL):
                    raise Unavailable("HDMI CEC adapter disconnected.")
            self.drain_events()
            # Recheck even if a driver misses its hotplug event.
            if self.kernel.request(self.adapter.fd, G_PHYS, C.c_uint16()).value != self.adapter.physical:
                raise Unavailable("HDMI CEC connection changed.")
            for _ in range(32):
                try:
                    value = self.kernel.request(self.adapter.fd, RECEIVE, Message())
                except OSError as error:
                    if error.errno == errno.EAGAIN:
                        break
                    if error.errno == errno.EINTR:
                        continue
                    raise
                self.message(value)


def main(argv=None):
    parser = argparse.ArgumentParser(description='SingZ Box kernel CEC input follower')
    parser.add_argument('--device')
    options = parser.parse_args(argv)
    stopped = False

    def stop(_signal, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    follower = None
    code = 0
    try:
        if sys.platform != 'linux' or C.sizeof(C.c_void_p) != 8:
            raise Unavailable("CEC input requires 64-bit Linux.")
        kernel = Kernel()
        follower = Follower(kernel, choose_adapter(kernel, options.device))
        follower.run(lambda: stopped)
    except Unavailable as error:
        if not stopped:
            status(emit, 'unavailable', str(error))
            code = 2
    except OSError as error:
        if not stopped:
            state = 'unavailable' if error.errno in (errno.EACCES, errno.EPERM, errno.EBUSY, errno.ENODEV, errno.ENXIO) else 'error'
            status(emit, state, 'CEC adapter access failed (errno %s).' % error.errno)
            code = 2 if state == 'unavailable' else 1
    finally:
        if follower is not None:
            try:
                follower.close()
            except OSError as error:
                if error.errno not in (errno.ENODEV, errno.ENXIO):
                    status(emit, 'error', 'Could not release the owned CEC registration.')
                    code = 1
    return code


if __name__ == '__main__':
    try:
        sys.exit(main())
    except BrokenPipeError:
        sys.exit(0)
