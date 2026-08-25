import {
  AndroidAudioInputSessionCoordinator,
  type AndroidAudioInputDevice,
  type AndroidAudioInputNative,
  type AndroidAudioInputState,
  type AndroidMicrophonePermission
} from '../src/android-audio-input-session'

const usb: AndroidAudioInputDevice = {
  uid: 'android:41',
  label: 'USB interface',
  channels: 16,
  channelLabels: Array.from({ length: 16 }, (_, index) => `Channel ${index + 1}`),
  sampleRate: 48000,
  isPreferred: true,
  transport: 'usb',
  highLatency: false
}

const harness = (granted = true) => {
  const calls: string[] = []
  let stateListener: ((state: AndroidAudioInputState) => void) | null = null
  const native: AndroidAudioInputNative = {
    listInputs: async () => {
      calls.push('list')
      return [usb]
    },
    start: async (owner, uid, channel) => {
      calls.push(`start:${owner}:${uid}:${channel}`)
      return {
        ok: true,
        generation: 7,
        deviceUid: uid,
        sampleRate: 48000,
        deviceChannels: 16,
        selectedChannel: channel,
        sampleFormat: 'float32',
        sharingMode: 'shared',
        performanceMode: 'low-latency',
        inputPreset: 'voice-performance-verified',
        timestampSource: 'aaudio-hardware-monotonic-anchor-with-callback-fallback'
      }
    },
    stop: async (owner, generation) => {
      calls.push(`stop:${owner}:${generation}`)
      return true
    }
  }
  let allowed = granted
  const permission: AndroidMicrophonePermission = {
    check: async () => {
      calls.push('permission:check')
      return allowed
    },
    request: async () => {
      calls.push('permission:request')
      allowed = true
      return true
    }
  }
  const coordinator = new AndroidAudioInputSessionCoordinator(
    native,
    permission,
    (listener) => {
      stateListener = listener
      return () => { stateListener = null }
    }
  )
  return { calls, native, permission, coordinator, state: (s: AndroidAudioInputState) => stateListener?.(s) }
}

describe('Android audio input session', () => {
  test('forwards policy-advertised USB channel 3 without mutating playback routing', async () => {
    const h = harness()
    const lease = await h.coordinator.acquire({ owner: 'training', channel: 2 })
    expect(lease.device).toBe(usb)
    expect(lease.channel).toBe(2)
    expect(lease.negotiated).toMatchObject({
      deviceUid: 'android:41',
      deviceChannels: 16,
      selectedChannel: 2,
      sampleFormat: 'float32'
    })
    expect(h.calls).toEqual([
      'permission:check',
      'list',
      'start:training:android:41:2'
    ])
    await lease.release()
    expect(h.calls.at(-1)).toBe('stop:training:7')
  })

  test('never prompts without an explicit user-initiated request', async () => {
    const h = harness(false)
    await expect(h.coordinator.acquire()).rejects.toThrow(
      'must be requested from the vocal-training screen'
    )
    expect(h.calls).toEqual(['permission:check'])
  })

  test('explicit request happens before device inventory and capture', async () => {
    const h = harness(false)
    const lease = await h.coordinator.acquire({ requestPermission: true })
    expect(h.calls.slice(0, 4)).toEqual([
      'permission:check',
      'permission:request',
      'list',
      'start:vocal-training:android:41:0'
    ])
    await lease.release()
  })

  test('serializes one capture owner and allows a new one after release', async () => {
    const h = harness()
    const first = await h.coordinator.acquire()
    await expect(h.coordinator.acquire()).rejects.toThrow('already active')
    await first.release()
    const second = await h.coordinator.acquire()
    await second.release()
  })

  test('disconnect state releases the coordinator generation boundary', async () => {
    const h = harness()
    const first = await h.coordinator.acquire()
    h.state({ generation: first.generation, state: 'error', error: 'unplugged' })
    const second = await h.coordinator.acquire()
    await first.release() // stale release cannot stop generation 2 in native
    await second.release()
  })

  test('rejects a lane beyond AudioManager’s conservative inventory', async () => {
    const h = harness()
    await expect(h.coordinator.acquire({ channel: 16 })).rejects.toThrow(
      'Channel 17 is unavailable'
    )
    expect(h.calls).not.toContain(expect.stringContaining('start:'))
  })

  test('failed stop retains the ownership latch until retry succeeds', async () => {
    const h = harness()
    let attempts = 0
    h.native.stop = async () => {
      h.calls.push(`stop-attempt:${++attempts}`)
      if (attempts === 1) throw new Error('bridge shutting down')
      return true
    }
    const lease = await h.coordinator.acquire()
    await expect(lease.release()).rejects.toThrow('bridge shutting down')
    await expect(h.coordinator.acquire()).rejects.toThrow('already active')
    await lease.retryRelease()
    const next = await h.coordinator.acquire()
    await next.release()
  })

  test('negative native stop acknowledgement remains recoverable', async () => {
    const h = harness()
    let stopped = false
    h.native.stop = async () => stopped
    const lease = await h.coordinator.acquire()
    await expect(lease.release()).rejects.toThrow('did not confirm')
    await expect(h.coordinator.acquire()).rejects.toThrow('already active')
    stopped = true
    await lease.retryRelease()
  })
})
