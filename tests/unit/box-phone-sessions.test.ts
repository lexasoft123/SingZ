import { describe, expect, it } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import { BoxPhoneSessions, cleanDisplayName } from '../../src/main/box/phone-sessions'
import { defaultRouteInterface, selectPhoneHost } from '../../src/main/box/phone'

function running(now = { value: 1_000_000 }) {
  const sessions = new BoxPhoneSessions({ now: () => now.value })
  sessions.start('http://192.168.1.10:8080')
  return { sessions, now, code: (): string => sessions.state().code as string }
}
function pairFrom(sessions: BoxPhoneSessions, code: string, address: string, name = 'Guest') {
  const nonce = sessions.issueNonce(address)
  return { nonce, result: sessions.pair(code, name, nonce, address) }
}
const nic = (address: string, internal = false): NetworkInterfaceInfo => ({
  address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24`
})

describe('Box phone sessions', () => {
  it('binds page nonces to their address so another host flooding page loads cannot evict them', () => {
    const { sessions, code } = running()
    const legitimate = sessions.issueNonce('192.168.1.20')
    for (let index = 0; index < 1000; index++) sessions.issueNonce('192.168.1.66')
    expect(sessions.validNonce(legitimate, '192.168.1.20')).toBe(true)
    expect(sessions.validNonce(legitimate, '192.168.1.66')).toBe(false)
    expect(sessions.pair(code(), 'Guest', legitimate, '192.168.1.20').ok).toBe(true)
  })

  it('never denies an authenticated command bucket because unauthenticated keys are exhausted', () => {
    const { sessions } = running()
    for (let index = 0; index < 600; index++) sessions.allow('pair', `10.0.${index >> 8}.${index & 255}`, 10, 60_000)
    for (let index = 0; index < 600; index++) sessions.allow('page', `10.1.${index >> 8}.${index & 255}`, 20, 60_000)
    expect(sessions.allow('command', 'session-1', 20, 10_000)).toBe(true)
    // Unauthenticated capacity is still bounded.
    expect(sessions.allow('pair', '10.9.9.9', 10, 60_000)).toBe(false)
  })

  it('counts only pending requests toward capacity, caps one address, and frees settled slots quickly', () => {
    const { sessions, code, now } = running()
    for (let round = 0; round < 5; round++) {
      for (let index = 0; index < 16; index++) {
        const { result } = pairFrom(sessions, code(), `10.0.${round}.${index}`)
        expect(result.ok).toBe(true)
        if (result.ok) expect(sessions.deny(result.value.requestId).ok).toBe(true)
      }
    }
    expect(pairFrom(sessions, code(), '10.0.9.1').result.ok).toBe(true)
    expect(pairFrom(sessions, code(), '10.0.9.1').result.ok).toBe(true)
    expect(pairFrom(sessions, code(), '10.0.9.1').result).toMatchObject({ ok: false, code: 'rate-limited' })
    expect(pairFrom(sessions, code(), '10.0.9.2').result.ok).toBe(true)
    now.value += 2 * 60_000 + 30_001
    sessions.state()
    expect(pairFrom(sessions, code(), '10.0.9.1').result.ok).toBe(true)
  })

  it('rotates the invitation after an approval while keeping already-submitted requests valid', () => {
    const { sessions, code } = running()
    const first = code()
    const a = pairFrom(sessions, first, '10.0.0.2').result
    const b = pairFrom(sessions, first, '10.0.0.3').result
    if (!a.ok || !b.ok) throw new Error('pairing failed')
    const approved = sessions.approve(a.value.requestId)
    expect(approved.ok && approved.value.code).not.toBe(first)
    expect(pairFrom(sessions, first, '10.0.0.4').result).toMatchObject({ ok: false, code: 'pairing-failed' })
    expect(pairFrom(sessions, code(), '10.0.0.4').result.ok).toBe(true)
    expect(sessions.approve(b.value.requestId).ok).toBe(true)
  })

  it('delivers the session token only to the pairing address, briefly re-delivers it for a lost response, and binds the session', () => {
    const { sessions, code, now } = running()
    const { result } = pairFrom(sessions, code(), '10.0.0.2')
    if (!result.ok) throw new Error('pairing failed')
    sessions.approve(result.value.requestId)
    const { requestId, pollSecret } = result.value
    expect(sessions.pairStatus(requestId, pollSecret, '10.0.0.3').ok).toBe(false)
    const status = sessions.pairStatus(requestId, pollSecret, '10.0.0.2')
    if (!status.ok || status.value.status !== 'approved') throw new Error('not approved')
    // A retry after a response lost on flaky Wi-Fi still gets the same token…
    now.value += 10_000
    expect(sessions.pairStatus(requestId, pollSecret, '10.0.0.2'))
      .toMatchObject({ ok: true, value: { status: 'approved', sessionToken: status.value.sessionToken } })
    // …but not after the settled window, when the record has retired.
    now.value += 25_000
    expect(sessions.pairStatus(requestId, pollSecret, '10.0.0.2').ok).toBe(false)
    expect(sessions.authenticate(status.value.sessionToken, '10.0.0.2')).not.toBeNull()
    expect(sessions.authenticate(status.value.sessionToken, '10.0.0.3')).toBeNull()
  })

  it('strips bidi and invisible format characters from display names', () => {
    expect(cleanDisplayName('\u202eGuest\u2066 One\u2069\u200b')).toBe('Guest One')
    expect(cleanDisplayName('\u202e\u200b')).toBeNull()
    expect(cleanDisplayName('Bad\u0085name')).toBeNull()
    const { sessions, code } = running()
    expect(pairFrom(sessions, code(), '10.0.0.2', '\u202etseuG').result.ok).toBe(true)
    expect(sessions.state().pending[0].name).toBe('tseuG')
  })
})

describe('Box phone host selection', () => {
  it('skips container, VM and VPN bridges and prefers the default-route interface', () => {
    const interfaces = {
      lo: [nic('127.0.0.1', true)],
      docker0: [nic('172.17.0.1')],
      'br-3f2a': [nic('172.18.0.1')],
      virbr0: [nic('192.168.122.1')],
      veth12ab: [nic('172.17.0.5')],
      vboxnet0: [nic('192.168.56.1')],
      tun0: [nic('10.8.0.2')],
      eth0: [nic('192.168.1.40')],
      wlan0: [nic('192.168.1.41')]
    }
    expect(selectPhoneHost(interfaces)).toBe('192.168.1.40')
    expect(selectPhoneHost(interfaces, 'wlan0')).toBe('192.168.1.41')
    expect(selectPhoneHost(interfaces, 'tun0')).toBe('192.168.1.40')
    expect(selectPhoneHost({ docker0: [nic('172.17.0.1')], virbr0: [nic('192.168.122.1')] })).toBeNull()
  })

  it('reads the lowest-metric up default route from /proc/net/route', () => {
    const table = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
      'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
      'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      'eth1\t00000000\t0101A8C0\t0002\t0\t0\t1\t00000000\t0\t0\t0'
    ].join('\n')
    expect(defaultRouteInterface(table)).toBe('eth0')
    expect(defaultRouteInterface('Iface\tDestination\n')).toBeNull()
  })
})
