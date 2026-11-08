"""No hardware: exercise the real buffer/ioctl wrapper with an injected kernel."""
import contextlib
import ctypes as C
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import signal
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('box_cec', ROOT / 'resources/linux/cec-input.py')
cec = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cec
spec.loader.exec_module(cec)
NEGATIVE = '--negative-control' in sys.argv
if NEGATIVE:
    sys.argv.remove('--negative-control')
    source = Path(spec.origin).read_text().replace(
        'if value.msg[0] >> 4 != 0:',
        'if False:')
    exec(compile(source, spec.origin, 'exec'), cec.__dict__)

if '--negative-telemetry' in sys.argv:
    sys.argv.remove('--negative-telemetry')
    cec.Follower.report_telemetry = lambda *args, **kwargs: None

if '--negative-power-status' in sys.argv:
    sys.argv.remove('--negative-power-status')
    cec.Follower.power_status_reply = lambda *args, **kwargs: None


def copy(value):
    return type(value).from_buffer_copy(bytes(value))


def caps(driver='tx', name='HDMI output', capabilities=cec.REQUIRED_CAPS):
    value = cec.Caps()
    value.driver, value.name = driver.encode(), name.encode()
    value.available_log_addrs, value.capabilities = 1, capabilities
    return value


def frame(data, **fields):
    value = cec.Message()
    value.len, value.rx_status = len(data), 1
    value.msg[:len(data)] = data
    for key, item in fields.items():
        setattr(value, key, item)
    return value


class FakeKernel(cec.Kernel):
    def __init__(self, devices=None):
        super().__init__(self.ioctl_fake)
        self.devices = devices or {'/dev/cec0': (caps(), 0x1000)}
        self.opened, self.closed, self.operations, self.configurations = [], [], [], []
        self.transmissions = []
        self.tx_error = None
        self.logs = cec.LogAddrs()
        self.events, self.messages = [], []
        self.claim = True
        self.clock = 0

    def open(self, path):
        self.opened.append(path)
        return list(self.devices).index(path) + 100

    def close(self, fd):
        self.closed.append(fd)

    def sleep(self, seconds):
        self.clock += seconds

    def ioctl_fake(self, fd, operation, buffer, mutate):
        self.operations.append(operation)
        device_caps, physical = list(self.devices.values())[fd - 100]
        if operation == cec.G_CAPS:
            result = device_caps
        elif operation == cec.G_PHYS:
            result = C.c_uint16(physical)
        elif operation == cec.G_LOG:
            result = self.logs
        elif operation == cec.S_MODE:
            assert C.c_uint32.from_buffer_copy(buffer).value == 0x22
            return 0
        elif operation == cec.S_LOG:
            result = cec.LogAddrs.from_buffer_copy(buffer)
            self.configurations.append(copy(result))
            if result.num_log_addrs and self.claim:
                result.log_addr[0], result.log_addr_mask = 4, 1 << 4
            self.logs = copy(result)
        elif operation == cec.DQEVENT:
            if not self.events:
                raise BlockingIOError(errno.EAGAIN, 'no events')
            result = self.events.pop(0)
        elif operation == cec.TRANSMIT:
            if self.tx_error:
                raise OSError(self.tx_error, 'transmit unavailable')
            result = cec.Message.from_buffer_copy(buffer)
            self.transmissions.append(copy(result))
            result.sequence = len(self.transmissions)
        elif operation == cec.RECEIVE:
            if not self.messages:
                raise BlockingIOError(errno.EAGAIN, 'no messages')
            result = self.messages.pop(0)
        else:
            raise AssertionError('Unexpected ioctl, including transmit or physical-address mutation')
        buffer[:] = bytes(result)
        return 0

    def follower(self, output=None):
        adapter = cec.choose_adapter(self, paths=list(self.devices))
        return cec.Follower(self, adapter, output.append if output is not None else lambda _: None,
                            clock=lambda: self.clock, sleep=self.sleep)


class CecTests(unittest.TestCase):
    def test_uapi_layout_and_ioctl_constants(self):
        self.assertEqual([C.sizeof(t) for t in (cec.Caps, cec.LogAddrs, cec.Message, cec.Event)], [76, 92, 56, 80])
        self.assertEqual((cec.G_CAPS, cec.G_PHYS, cec.G_LOG, cec.S_LOG, cec.RECEIVE, cec.DQEVENT, cec.S_MODE),
                         (0xc04c6100, 0x80026101, 0x805c6103, 0xc05c6104, 0xc0386106, 0xc0506107, 0x40046109))
        self.assertEqual(cec.LogAddrs.osd_name.offset, 16)
        self.assertEqual(cec.Message.msg.offset, 32)

    def test_auto_rejects_receiver_and_selects_only_connected_tx(self):
        kernel = FakeKernel({'/dev/cec0': (caps('snps_hdmirx'), 0x1000), '/dev/cec1': (caps(), 0x2000)})
        selected = cec.choose_adapter(kernel, paths=list(kernel.devices))
        self.assertEqual(selected.path, '/dev/cec1')
        self.assertEqual(kernel.closed, [100])
        self.assertEqual(kernel.configurations, [])
        kernel.close(selected.fd)

    def test_explicit_receiver_is_rejected_without_mutation(self):
        for driver, name in [('snps_hdmirx', 'HDMI'), ('test', 'HDMI receiver')]:
            kernel = FakeKernel({'/dev/cec0': (caps(driver, name), 0x1000)})
            with self.assertRaisesRegex(cec.Unavailable, 'receiver'):
                cec.choose_adapter(kernel, '/dev/cec0')
            self.assertEqual(kernel.closed, [100])
            self.assertEqual(kernel.configurations, [])

    def test_multiple_connected_outputs_fail_closed(self):
        kernel = FakeKernel({'/dev/cec0': (caps(), 0x1000), '/dev/cec1': (caps(), 0x2000)})
        with self.assertRaisesRegex(cec.Unavailable, 'Multiple'):
            cec.choose_adapter(kernel, paths=list(kernel.devices))
        self.assertEqual(kernel.closed, [100, 101])
        self.assertEqual(kernel.configurations, [])

    def test_disconnected_root_and_incapable_are_not_tx_candidates(self):
        for physical, capability in [(0xffff, cec.REQUIRED_CAPS), (0, cec.REQUIRED_CAPS), (0x1000, 0)]:
            kernel = FakeKernel({'/dev/cec0': (caps(capabilities=capability), physical)})
            with self.assertRaises(cec.Unavailable):
                cec.choose_adapter(kernel, paths=list(kernel.devices))
            self.assertEqual(kernel.closed, [100])

    def test_explicit_auto_uses_same_unique_tx_selection(self):
        kernel = FakeKernel()
        selected = cec.choose_adapter(kernel, 'auto', paths=list(kernel.devices))
        self.assertEqual(selected.path, '/dev/cec0')
        kernel.close(selected.fd)

    def test_changed_physical_address_during_claim_never_becomes_ready(self):
        kernel = FakeKernel()
        follower = kernel.follower()
        original = kernel.ioctl
        def disconnect(fd, operation, buffer, mutate):
            result = original(fd, operation, buffer, mutate)
            if operation == cec.S_LOG:
                kernel.devices['/dev/cec0'] = (caps(), 0xffff)
            return result
        kernel.ioctl = disconnect
        with self.assertRaisesRegex(cec.Unavailable, 'connection changed'):
            follower.register()
        follower.close()
        self.assertEqual(kernel.configurations[-1].num_log_addrs, 0)

    def test_rc_passthrough_readback_is_rejected(self):
        kernel = FakeKernel()
        follower = kernel.follower()
        original = kernel.ioctl
        def force_passthrough(fd, operation, buffer, mutate):
            result = original(fd, operation, buffer, mutate)
            if operation == cec.S_LOG and kernel.logs.num_log_addrs:
                kernel.logs.flags = 2
            return result
        kernel.ioctl = force_passthrough
        with self.assertRaisesRegex(cec.Unavailable, 'passthrough'):
            follower.register()
        follower.close()

    def test_invalid_explicit_path_never_opens_anything(self):
        kernel = FakeKernel()
        for value in ['/tmp/cec0', '/dev/cec0/../secret', '/dev/cec0\n', '/dev/cecX']:
            with self.assertRaises(cec.Unavailable):
                cec.choose_adapter(kernel, value)
        self.assertEqual(kernel.opened, [])

    def test_claim_is_exclusive_playback_without_rc_passthrough(self):
        kernel = FakeKernel()
        follower = kernel.follower()
        follower.register()
        wanted = kernel.configurations[0]
        self.assertEqual((wanted.cec_version, wanted.num_log_addrs, wanted.vendor_id, wanted.flags), (5, 1, 0xffffffff, 0))
        self.assertEqual(wanted.osd_name, b'SingZ Box')
        self.assertEqual((wanted.primary_device_type[0], wanted.log_addr_type[0]), (4, 3))
        self.assertEqual(follower.mask, 1 << 4)
        follower.close()
        self.assertEqual(kernel.configurations[-1].num_log_addrs, 0)
        self.assertEqual(kernel.closed, [100])

    def test_existing_registration_is_never_cleared(self):
        kernel = FakeKernel()
        kernel.logs.num_log_addrs, kernel.logs.log_addr_mask = 1, 1 << 8
        kernel.logs.osd_name = b'Other player'
        follower = kernel.follower()
        with self.assertRaisesRegex(cec.Unavailable, 'another application'):
            follower.register()
        follower.close()
        self.assertEqual(kernel.configurations, [])
        self.assertEqual(kernel.logs.osd_name, b'Other player')

    def test_orphaned_own_registration_is_reclaimed_after_exclusive_lock(self):
        kernel = FakeKernel()
        old = kernel.follower()
        old.register()
        # SIGKILL closes the descriptor without running Follower.close(). The
        # adapter's address registration is global and survives that close.
        kernel.close(old.adapter.fd)
        replacement = kernel.follower()
        replacement.register()
        self.assertEqual([v.num_log_addrs for v in kernel.configurations], [1, 0, 1])
        self.assertEqual(replacement.mask, 1 << 4)
        replacement.close()
        self.assertEqual(kernel.configurations[-1].num_log_addrs, 0)

    def test_similar_foreign_registrations_are_not_reclaimed(self):
        mutations = [lambda v: setattr(v, 'vendor_id', 123),
                     lambda v: setattr(v, 'cec_version', 6),
                     lambda v: setattr(v, 'flags', 2),
                     lambda v: setattr(v, 'num_log_addrs', 2),
                     lambda v: v.primary_device_type.__setitem__(0, 3),
                     lambda v: v.log_addr_type.__setitem__(0, 4),
                     lambda v: setattr(v, 'log_addr_mask', 1 << 8),
                     lambda v: setattr(v, 'osd_name', b'Other player')]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                kernel = FakeKernel()
                old = kernel.follower()
                old.register()
                kernel.close(old.adapter.fd)
                mutate(kernel.logs)
                original = bytes(kernel.logs)
                kernel.configurations.clear()
                replacement = kernel.follower()
                with self.assertRaisesRegex(cec.Unavailable, 'another application'):
                    replacement.register()
                replacement.close()
                self.assertEqual(kernel.configurations, [])
                self.assertEqual(bytes(kernel.logs), original)

    def test_active_exclusive_owner_is_not_reclaimed(self):
        kernel = FakeKernel()
        old = kernel.follower()
        old.register()
        replacement = kernel.follower()
        ioctl = kernel.ioctl
        def busy(fd, operation, buffer, mutate):
            if operation == cec.S_MODE:
                raise OSError(errno.EBUSY, 'exclusive owner is still alive')
            return ioctl(fd, operation, buffer, mutate)
        kernel.ioctl = busy
        before = bytes(kernel.logs)
        with self.assertRaises(OSError) as caught:
            replacement.register()
        self.assertEqual(caught.exception.errno, errno.EBUSY)
        replacement.close()
        self.assertEqual(bytes(kernel.logs), before)
        self.assertEqual(len(kernel.configurations), 1)
        kernel.ioctl = ioctl
        old.close()

    def test_claim_timeout_is_bounded_and_clears_only_owned_pending_claim(self):
        kernel = FakeKernel()
        kernel.claim = False
        follower = kernel.follower()
        with self.assertRaisesRegex(cec.Unavailable, 'Timed out'):
            follower.register()
        self.assertLess(kernel.clock, 5.1)
        follower.close()
        self.assertEqual(kernel.configurations[-1].num_log_addrs, 0)

    def test_power_status_reply_is_solicited_exact_and_completion_is_authoritative(self):
        kernel, output = FakeKernel(), []
        follower = kernel.follower(output)
        follower.register()
        self.assertEqual(kernel.transmissions, [])
        self.assertEqual(cec.TRANSMIT, cec.ioctl_number(3, 5, cec.Message))
        follower.message(frame([0x04, 0x8f]))
        self.assertEqual(len(kernel.transmissions), 1)
        reply = kernel.transmissions[0]
        self.assertEqual(list(reply.msg[:reply.len]), [0x40, 0x90, 0])
        self.assertEqual((reply.timeout, reply.reply, reply.flags), (0, 0, 0))
        self.assertEqual(follower.telemetry['powerReplyQueued'], 1)
        self.assertEqual(follower.telemetry['powerReplyCompleted'], 0)
        follower.message(frame([0x40, 0x90, 0], sequence=999, tx_status=1, rx_status=0))
        self.assertEqual(follower.telemetry['powerReplyCompleted'], 0)
        follower.message(frame([0x40, 0x90, 0], sequence=1, tx_status=1, rx_status=0))
        self.assertEqual(follower.telemetry['powerReplyCompleted'], 1)
        self.assertEqual(follower.telemetry['lastPowerReplyTxStatus'], 1)
        follower.message(frame([0x04, 0x8f]))
        self.assertEqual(len(kernel.transmissions), 1)  # one/sec, even after completion
        kernel.clock = 1
        follower.message(frame([0x04, 0x8f]))
        follower.message(frame([0x40, 0x90, 0], sequence=2, tx_status=4, rx_status=0))
        self.assertEqual(follower.telemetry['powerReplyFailed'], 1)
        self.assertEqual(follower.telemetry['lastPowerReplyTxStatus'], 4)
        follower.close()

    def test_power_status_rejects_foreign_wrong_address_and_malformed_queries(self):
        kernel = FakeKernel()
        follower = kernel.follower()
        follower.register()
        invalid = [frame([0x54, 0x8f]), frame([0x08, 0x8f]), frame([0x0f, 0x8f]),
                   frame([0x04, 0x8e]), frame([0x04, 0x8f, 0]), frame([0x04]),
                   frame([0x04, 0x8f], rx_status=0), frame([0x04, 0x8f], flags=1),
                   frame([0x04, 0x8f], sequence=1), frame([0x04, 0x8f], tx_status=1)]
        for message in invalid:
            follower.message(message)
        self.assertEqual(kernel.transmissions, [])
        follower.close()

    def test_busy_power_reply_never_breaks_remote_input_and_pending_is_bounded(self):
        kernel, output = FakeKernel(), []
        follower = kernel.follower(output)
        follower.register()
        for error in (errno.EBUSY, errno.EAGAIN, getattr(errno, 'ENONET', 64)):
            kernel.tx_error = error
            follower.message(frame([0x04, 0x8f]))
            follower.message(frame([0x04, 0x44, 1]))
            follower.message(frame([0x04, 0x45]))
            kernel.clock += 1
        self.assertEqual(follower.telemetry['powerReplyErrors'], 3)
        self.assertEqual(len(output), 6)
        kernel.tx_error = None
        follower.message(frame([0x04, 0x8f]))
        kernel.clock += 1
        follower.message(frame([0x04, 0x8f]))
        self.assertEqual(len(kernel.transmissions), 1)  # outstanding reply not stacked
        kernel.clock += 1
        follower.message(frame([0x04, 0x8f]))
        self.assertEqual(len(kernel.transmissions), 2)
        self.assertEqual(follower.telemetry['powerReplyExpired'], 1)
        follower.close()

    def test_bounded_prefilter_telemetry_and_topology(self):
        kernel, output = FakeKernel(), []
        follower = kernel.follower(output)
        follower.register()
        follower.report_telemetry(force=True)
        follower.message(frame([0x54, 0x44, 1]))
        follower.message(frame([0x08, 0x44, 1]))
        follower.message(frame([0x04, 0x44, 1]))
        follower.message(frame([0x04, 0x45]))
        follower.message(frame([0x04, 0x44], rx_status=0))
        event = cec.Event()
        event.event, event.state_change.phys_addr, event.state_change.log_addr_mask = 1, 0x1000, 1 << 4
        kernel.events.append(event)
        follower.drain_events()
        follower.report_telemetry()
        self.assertEqual(len([v for v in output if v['type'] == 'telemetry']), 1)
        kernel.clock = 5
        follower.report_telemetry()
        report = output[-1]
        self.assertEqual(report['received'], 5)
        self.assertEqual((report['acceptedPress'], report['acceptedRelease']), (1, 1))
        self.assertEqual((report['rejectedInitiator'], report['rejectedDestination'], report['rejectedFormat']), (1, 1, 1))
        self.assertEqual(report['lastRx'], dict(initiator=0, destination=4, opcode=0x44, length=2, rxStatus=0))
        self.assertEqual(report['lastStateChange'], dict(physicalAddress=0x1000, logicalAddressMask=1 << 4))
        self.assertEqual(len(kernel.configurations), 1)  # unchanged topology never reclaims
        event.state_change.log_addr_mask = 1 << 8
        kernel.events.append(event)
        with self.assertRaises(cec.Unavailable):
            follower.drain_events()
        follower.close()

    def test_frames_filter_foreign_and_malformed(self):
        kernel, output = FakeKernel(), []
        follower = kernel.follower(output)
        follower.mask = 1 << 4
        invalid = [frame([0x14, 0x44, 1]), frame([0x08, 0x44, 1]), frame([0x0f, 0x44, 1]),
                   frame([0x04, 0x44]), frame([0x04, 0x45, 1]), frame([0x04, 0x36]),
                   frame([0x04, 0x44, 1], sequence=1), frame([0x04, 0x44, 1], tx_status=1),
                   frame([0x04, 0x44, 1], rx_status=0), frame([0x04, 0x44, 1], flags=1)]
        for message in invalid:
            follower.message(message)
        self.assertEqual(output, [])
        follower.close()

    def test_kernel_receive_timestamp_is_preserved_without_float_rounding(self):
        kernel, output = FakeKernel(), []
        follower = kernel.follower(output)
        follower.mask = 1 << 4
        follower.message(frame([0x04, 0x44, 1], rx_ts=1234567890123456789))
        self.assertEqual(output[0]['receivedAtNs'], '1234567890123456789')
        follower.close()

    def test_repeat_change_and_release_preserve_real_key_sequence(self):
        kernel, output = FakeKernel(), []
        follower = kernel.follower(output)
        follower.mask = 1 << 4
        for message in ([0x04, 0x44, 1], [0x04, 0x44, 1], [0x04, 0x44, 255], [0x04, 0x45], [0x04, 0x45]):
            follower.message(frame(message))
        self.assertEqual([(v['code'], v['pressed']) for v in output], [(1, True), (1, True), (1, False), (255, True), (255, False)])
        follower.close()

    def test_disconnect_and_lost_events_release_held_key_on_cleanup(self):
        for changed in (True, False):
            kernel, output = FakeKernel(), []
            follower = kernel.follower(output)
            follower.register()
            follower.message(frame([0x04, 0x44, 2]))
            event = cec.Event()
            if changed:
                event.event, event.state_change.phys_addr = 1, 0xffff
                kernel.logs.log_addr_mask = 0  # Kernel drops the mask on HDMI disconnect.
            else:
                event.event = 2
            kernel.events.append(event)
            with self.assertRaises(cec.Unavailable):
                follower.drain_events()
            follower.close()
            self.assertEqual(output[-1], {'type': 'key', 'code': 2, 'pressed': False})
            self.assertEqual(kernel.configurations[-1].num_log_addrs, 0)

    def test_cleanup_does_not_clear_replacement_configuration(self):
        kernel = FakeKernel()
        follower = kernel.follower()
        follower.register()
        kernel.logs.osd_name = b'Other owner'
        follower.close()
        self.assertEqual(len(kernel.configurations), 1)

    def test_main_sigterm_releases_and_deregisters_without_hardware(self):
        kernel = FakeKernel()
        kernel.messages = [frame([0x04, 0x44, 1])]
        class Poll:
            rounds = 0
            def register(self, fd, flags):
                self.fd = fd
            def poll(self, timeout):
                assert timeout <= 200
                self.rounds += 1
                if self.rounds == 2:
                    os.kill(os.getpid(), signal.SIGTERM)
                return [(self.fd, select.POLLIN)]
        output = io.StringIO()
        old_term, old_int = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)
        try:
            with patch.object(cec.sys, 'platform', 'linux'), patch.object(cec, 'Kernel', return_value=kernel), patch.object(cec.glob, 'glob', return_value=['/dev/cec0']), patch.object(cec.select, 'poll', Poll), contextlib.redirect_stdout(output):
                self.assertEqual(cec.main([]), 0)
        finally:
            signal.signal(signal.SIGTERM, old_term)
            signal.signal(signal.SIGINT, old_int)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len([v for v in events if v['type'] == 'telemetry']), 1)
        self.assertEqual([v for v in events if v['type'] != 'telemetry'], [{'type': 'status', 'state': 'ready', 'detail': 'TV remote connected.'}, {'type': 'key', 'code': 1, 'pressed': True}, {'type': 'key', 'code': 1, 'pressed': False}])
        self.assertEqual(kernel.configurations[-1].num_log_addrs, 0)
        self.assertEqual(kernel.closed, [100])

    def test_status_json_detail_bound(self):
        output = []
        cec.status(output.append, 'error', 'x' * 300 + '\nmore')
        self.assertEqual(len(output[0]['detail']), 240)
        self.assertNotIn('\n', output[0]['detail'])


if __name__ == '__main__':
    unittest.main()
