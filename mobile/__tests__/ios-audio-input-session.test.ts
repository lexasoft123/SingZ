import {
  IosAudioInputSessionCoordinator,
  type IosAudioInputLeaseNative,
  type IosAudioSessionOwner
} from '../src/ios-audio-input-session'

const harness = (permission: 'Undetermined' | 'Denied' | 'Granted' = 'Granted') => {
  const calls: string[] = []
  let currentPermission = permission
  let currentInput = 'built-in'
  let sessionCategory: 'playback' | 'playAndRecord' = 'playback'
  let availableInputs: Array<{ id: string }> | undefined = [
    { id: 'built-in' },
    { id: 'usb' },
    { id: 'usb-interface' }
  ]
  const owner: IosAudioSessionOwner = {
    checkRecordingPermissions: async () => currentPermission,
    requestRecordingPermissions: async () => {
      calls.push('permission:request')
      currentPermission = 'Granted'
      return currentPermission
    },
    setAudioSessionOptions: (options) => {
      calls.push(`options:${options.iosCategory}`)
      sessionCategory = options.iosCategory
    },
    setAudioSessionActivity: async (active) => {
      calls.push(`active:${active}`)
    },
    getDevicesInfo: async () =>
      sessionCategory === 'playback'
        ? { availableInputs: [], currentInputs: [] }
        : { availableInputs, currentInputs: [{ id: currentInput }] },
    setInputDevice: async (id) => {
      calls.push(`input:${id}`)
      if (sessionCategory === 'playback')
        throw new Error('input selection is unavailable in playback mode')
      currentInput = id
    }
  }
  const native: IosAudioInputLeaseNative = {
    prepareCapturePreferences: async (uid, channels, duration, timeout) => {
      calls.push(`preferences:${uid}:${channels}:${duration}:${timeout}`)
      return { ok: true, token: '11' }
    },
    restoreCapturePreferences: async (token) => {
      calls.push(`preferences:restore:${token}`)
    },
    abandonCapturePreferences: async (token) => {
      calls.push(`preferences:abandon:${token}`)
    },
    verifyCaptureSession: async (uid, channels) => {
      calls.push(`verify:capture:${uid}:${channels}`)
    },
    verifyPlaybackSession: async () => {
      calls.push('verify:playback')
    },
    acquireLease: async (uid, channels) => {
      calls.push(`lease:acquire:${uid}:${channels}`)
      return '7'
    },
    releaseLease: async (token) => {
      calls.push(`lease:release:${token}`)
    }
  }
  return {
    calls,
    owner,
    native,
    setAvailableInputs: (inputs: Array<{ id: string }> | undefined) => {
      availableInputs = inputs
    }
  }
}

describe('iOS audio input session lease', () => {
  test('deactivates before configuration, exposes USB channel 3, and restores in order', async () => {
    const h = harness()
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    const lease = await coordinator.acquire({
      deviceUid: 'ios:usb-interface',
      channel: 2
    })
    await lease.release()
    expect(h.calls).toEqual([
      'active:false',
      'options:playAndRecord',
      'active:true',
      'input:usb-interface',
      'preferences:ios:usb-interface:3:0.005:1500',
      'verify:capture:ios:usb-interface:3',
      'lease:acquire:ios:usb-interface:3',
      'lease:release:7',
      'preferences:restore:11',
      'input:built-in',
      'active:false',
      'options:playback',
      'active:true',
      'verify:playback'
    ])
  })

  test('never prompts or mutates the session without an explicit permission request', async () => {
    const h = harness('Undetermined')
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    await expect(coordinator.acquire()).rejects.toThrow('must be requested')
    expect(h.calls).toEqual([])
  })

  test('explicit permission request precedes session deactivation', async () => {
    const h = harness('Undetermined')
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    const lease = await coordinator.acquire({ requestPermission: true })
    expect(h.calls.slice(0, 3)).toEqual([
      'permission:request',
      'active:false',
      'options:playAndRecord'
    ])
    await lease.release()
  })

  test('read-only verification catches a swallowed capture configuration error', async () => {
    const h = harness()
    h.native.verifyCaptureSession = async () => {
      h.calls.push('verify:capture:failed')
      throw new Error('play-and-record category was not applied')
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    await expect(coordinator.acquire()).rejects.toThrow('category was not applied')
    expect(h.calls).toContain('verify:capture:failed')
    expect(h.calls.slice(-4)).toEqual([
      'active:false',
      'options:playback',
      'active:true',
      'verify:playback'
    ])
  })

  test('native lease failure restores preferences, input, and playback', async () => {
    const h = harness()
    h.native.acquireLease = async () => {
      h.calls.push('lease:failed')
      throw new Error('route changed')
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    await expect(coordinator.acquire({ deviceUid: 'ios:usb' })).rejects.toThrow(
      'route changed'
    )
    expect(h.calls.slice(-6)).toEqual([
      'preferences:restore:11',
      'input:built-in',
      'active:false',
      'options:playback',
      'active:true',
      'verify:playback'
    ])
  })

  test('preserves acquisition and restoration failures and latches recovery until retry', async () => {
    const h = harness()
    let failAcquire = true
    let failPlaybackVerification = true
    h.native.acquireLease = async (uid, channels) => {
      h.calls.push(`lease:acquire:${uid}:${channels}`)
      if (failAcquire) throw new Error('capture route changed')
      return '8'
    }
    h.native.verifyPlaybackSession = async () => {
      h.calls.push('verify:playback')
      if (failPlaybackVerification) throw new Error('playback category mismatch')
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    await expect(coordinator.acquire()).rejects.toThrow(
      'capture route changed; cleaning up iOS audio input also failed: verify restored playback: playback category mismatch'
    )
    await expect(coordinator.acquire()).rejects.toThrow('must be retried')
    failPlaybackVerification = false
    await coordinator.retryRelease()
    failAcquire = false
    const lease = await coordinator.acquire()
    await lease.release()
  })

  test('unplugged route cleanup is aggregated but verified playback permits future capture', async () => {
    const h = harness()
    const originalSetInputDevice = h.owner.setInputDevice
    h.native.restoreCapturePreferences = async (token) => {
      h.calls.push(`preferences:restore:${token}`)
      throw new Error('interface unplugged')
    }
    h.owner.setInputDevice = async (id) => {
      if (id === 'built-in') {
        h.calls.push(`input:${id}`)
        throw new Error('previous route vanished')
      }
      await originalSetInputDevice(id)
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    const lease = await coordinator.acquire({ deviceUid: 'ios:usb' })
    h.setAvailableInputs([{ id: 'usb' }])
    await expect(lease.release()).rejects.toThrow(
      'restore capture preferences: interface unplugged; restore previous input: previous route vanished'
    )
    expect(h.calls).toContain('preferences:abandon:11')
    expect(h.calls.slice(-4)).toEqual([
      'active:false',
      'options:playback',
      'active:true',
      'verify:playback'
    ])

    h.native.restoreCapturePreferences = async (token) => {
      h.calls.push(`preferences:restore:${token}`)
    }
    h.owner.setInputDevice = originalSetInputDevice
    const next = await coordinator.acquire()
    await next.release()
  })

  test('present previous input failure stays latched and retry reattempts only pending work', async () => {
    const h = harness()
    const originalSetInputDevice = h.owner.setInputDevice
    let failPreviousInput = true
    h.owner.setInputDevice = async (id) => {
      if (id === 'built-in' && failPreviousInput) {
        h.calls.push(`input:${id}`)
        throw new Error('input switch temporarily busy')
      }
      await originalSetInputDevice(id)
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    const lease = await coordinator.acquire({ deviceUid: 'ios:usb' })
    await expect(lease.release()).rejects.toThrow(
      'restore previous input: input switch temporarily busy'
    )
    await expect(coordinator.acquire()).rejects.toThrow('must be retried')

    const restorePreferenceCalls = h.calls.filter(
      (call) => call === 'preferences:restore:11'
    ).length
    const releaseLeaseCalls = h.calls.filter(
      (call) => call === 'lease:release:7'
    ).length
    failPreviousInput = false
    await coordinator.retryRelease()
    expect(
      h.calls.filter((call) => call === 'preferences:restore:11')
    ).toHaveLength(restorePreferenceCalls)
    expect(h.calls.filter((call) => call === 'lease:release:7')).toHaveLength(
      releaseLeaseCalls
    )
    expect(h.calls.filter((call) => call === 'input:built-in')).toHaveLength(2)
    expect(
      h.calls.filter((call) => call === 'options:playAndRecord')
    ).toHaveLength(2)
    expect(h.calls).toContain('verify:capture:ios:usb:1')
    expect(
      h.calls.filter((call) => call === 'lease:acquire:ios:usb:1')
    ).toHaveLength(1)
    const next = await coordinator.acquire()
    await next.release()
  })

  test('known-gone previous input failure does not retain recovery', async () => {
    const h = harness()
    const originalSetInputDevice = h.owner.setInputDevice
    h.owner.setInputDevice = async (id) => {
      if (id === 'built-in') {
        h.calls.push(`input:${id}`)
        throw new Error('saved input was unplugged')
      }
      await originalSetInputDevice(id)
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    const lease = await coordinator.acquire({ deviceUid: 'ios:usb' })
    h.setAvailableInputs([{ id: 'usb' }])
    await expect(lease.release()).rejects.toThrow(
      'restore previous input: saved input was unplugged'
    )
    h.owner.setInputDevice = originalSetInputDevice
    const next = await coordinator.acquire()
    await next.release()
  })

  test('unknown previous input inventory keeps restoration latched', async () => {
    const h = harness()
    const originalSetInputDevice = h.owner.setInputDevice
    const originalGetDevicesInfo = h.owner.getDevicesInfo
    let failPreviousInput = true
    let failInventory = false
    h.owner.setInputDevice = async (id) => {
      if (id === 'built-in' && failPreviousInput) {
        h.calls.push(`input:${id}`)
        throw new Error('input switch unavailable')
      }
      await originalSetInputDevice(id)
    }
    h.owner.getDevicesInfo = async () => {
      if (failInventory) throw new Error('input inventory unavailable')
      return originalGetDevicesInfo()
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    const lease = await coordinator.acquire({ deviceUid: 'ios:usb' })
    failInventory = true
    await expect(lease.release()).rejects.toThrow(
      'restore previous input: input switch unavailable; classify previous input availability: input inventory unavailable'
    )
    await expect(coordinator.acquire()).rejects.toThrow('must be retried')
    failPreviousInput = false
    await expect(coordinator.retryRelease()).rejects.toThrow(
      're-enter capture session for cleanup: input inventory unavailable'
    )
    expect(h.calls.slice(-4)).toEqual([
      'active:false',
      'options:playback',
      'active:true',
      'verify:playback'
    ])
    await expect(coordinator.acquire()).rejects.toThrow('must be retried')
    failInventory = false
    await coordinator.retryRelease()
    expect(
      h.calls.filter((call) => call === 'options:playAndRecord')
    ).toHaveLength(3)
    const next = await coordinator.acquire()
    await next.release()
  })

  test('native lease release failure stays latched until retry clears the token', async () => {
    const h = harness()
    let failRelease = true
    h.native.releaseLease = async (token) => {
      h.calls.push(`lease:release:${token}`)
      if (failRelease) throw new Error('native registry busy')
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    const lease = await coordinator.acquire()
    await expect(lease.release()).rejects.toThrow(
      'release native lease: native registry busy'
    )
    expect(h.calls.slice(-4)).toEqual([
      'active:false',
      'options:playback',
      'active:true',
      'verify:playback'
    ])
    await expect(coordinator.acquire()).rejects.toThrow('must be retried')
    failRelease = false
    await coordinator.retryRelease()
    expect(
      h.calls.filter((call) => call === 'options:playAndRecord')
    ).toHaveLength(1)
    const next = await coordinator.acquire()
    await next.release()
  })

  test('present-route preference failure stays latched when safe abandon rejects', async () => {
    const h = harness()
    let transientFailure = true
    h.native.restoreCapturePreferences = async (token) => {
      h.calls.push(`preferences:restore:${token}`)
      if (transientFailure) throw new Error('buffer duration temporarily busy')
    }
    h.native.abandonCapturePreferences = async (token) => {
      h.calls.push(`preferences:abandon:${token}`)
      throw new Error('saved input route is still present')
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    const lease = await coordinator.acquire()
    await expect(lease.release()).rejects.toThrow(
      'restore capture preferences: buffer duration temporarily busy; abandon obsolete capture preferences: saved input route is still present'
    )
    await expect(coordinator.acquire()).rejects.toThrow('must be retried')
    transientFailure = false
    await coordinator.retryRelease()
    expect(
      h.calls.filter((call) => call === 'options:playAndRecord')
    ).toHaveLength(2)
    h.native.restoreCapturePreferences = async (token) => {
      h.calls.push(`preferences:restore:${token}`)
    }
    const next = await coordinator.acquire()
    await next.release()
  })

  test('cleanup reentry handles a gone capture route with the previous input present', async () => {
    const h = harness()
    const originalSetInputDevice = h.owner.setInputDevice
    let capturedRoutePresent = true
    let failPreviousInput = true
    h.native.restoreCapturePreferences = async (token) => {
      h.calls.push(`preferences:restore:${token}`)
      throw new Error('captured route preference unavailable')
    }
    h.native.abandonCapturePreferences = async (token) => {
      h.calls.push(`preferences:abandon:${token}`)
      if (capturedRoutePresent) throw new Error('captured route is still present')
    }
    h.owner.setInputDevice = async (id) => {
      if (id === 'built-in' && failPreviousInput) {
        h.calls.push(`input:${id}`)
        throw new Error('previous input temporarily busy')
      }
      await originalSetInputDevice(id)
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    const lease = await coordinator.acquire({ deviceUid: 'ios:usb' })
    await expect(lease.release()).rejects.toThrow(
      'captured route is still present'
    )
    await expect(coordinator.acquire()).rejects.toThrow('must be retried')

    capturedRoutePresent = false
    failPreviousInput = false
    h.setAvailableInputs([{ id: 'built-in' }])
    await expect(coordinator.retryRelease()).rejects.toThrow(
      'restore capture preferences: captured route preference unavailable'
    )
    expect(h.calls).toContain('verify:capture:ios:built-in:1')
    expect(
      h.calls.filter((call) => call === 'options:playAndRecord')
    ).toHaveLength(2)
    h.native.restoreCapturePreferences = async (token) => {
      h.calls.push(`preferences:restore:${token}`)
    }
    const next = await coordinator.acquire()
    await next.release()
  })

  test('pending cleanup reenters capture after playback activation rejected', async () => {
    const h = harness()
    const originalSetInputDevice = h.owner.setInputDevice
    const originalSetAudioSessionOptions = h.owner.setAudioSessionOptions
    const originalSetAudioSessionActivity = h.owner.setAudioSessionActivity
    let failPreviousInput = true
    let restoringPlayback = false
    let failPlaybackActivation = true
    h.owner.setInputDevice = async (id) => {
      if (id === 'built-in' && failPreviousInput) {
        h.calls.push(`input:${id}`)
        throw new Error('previous input cleanup pending')
      }
      await originalSetInputDevice(id)
    }
    h.owner.setAudioSessionOptions = (options) => {
      originalSetAudioSessionOptions(options)
      restoringPlayback = options.iosCategory === 'playback'
    }
    h.owner.setAudioSessionActivity = async (active) => {
      await originalSetAudioSessionActivity(active)
      if (active && restoringPlayback && failPlaybackActivation)
        throw new Error('playback activation rejected after options applied')
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    const lease = await coordinator.acquire({ deviceUid: 'ios:usb' })
    await expect(lease.release()).rejects.toThrow(
      'reactivate playback session: playback activation rejected after options applied'
    )
    await expect(coordinator.acquire()).rejects.toThrow('must be retried')

    failPreviousInput = false
    failPlaybackActivation = false
    await coordinator.retryRelease()
    expect(
      h.calls.filter((call) => call === 'options:playAndRecord')
    ).toHaveLength(2)
    expect(h.calls).toContain('verify:capture:ios:usb:1')
    const next = await coordinator.acquire()
    await next.release()
  })

  test('pending cleanup reenters capture after playback verification failed', async () => {
    const h = harness()
    const originalSetInputDevice = h.owner.setInputDevice
    let failPreviousInput = true
    let failPlaybackVerification = true
    h.owner.setInputDevice = async (id) => {
      if (id === 'built-in' && failPreviousInput) {
        h.calls.push(`input:${id}`)
        throw new Error('previous input cleanup pending')
      }
      await originalSetInputDevice(id)
    }
    h.native.verifyPlaybackSession = async () => {
      h.calls.push('verify:playback')
      if (failPlaybackVerification)
        throw new Error('playback verification failed after category switch')
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    const lease = await coordinator.acquire({ deviceUid: 'ios:usb' })
    await expect(lease.release()).rejects.toThrow(
      'verify restored playback: playback verification failed after category switch'
    )
    await expect(coordinator.acquire()).rejects.toThrow('must be retried')

    failPreviousInput = false
    failPlaybackVerification = false
    await coordinator.retryRelease()
    expect(
      h.calls.filter((call) => call === 'options:playAndRecord')
    ).toHaveLength(2)
    expect(h.calls).toContain('verify:capture:ios:usb:1')
    const next = await coordinator.acquire()
    await next.release()
  })

  test('playback re-restore failure after cleanup stays latched without another capture reentry', async () => {
    const h = harness()
    const originalSetInputDevice = h.owner.setInputDevice
    const originalSetAudioSessionOptions = h.owner.setAudioSessionOptions
    const originalSetAudioSessionActivity = h.owner.setAudioSessionActivity
    let failPreviousInput = true
    let restoringPlayback = false
    let failPlaybackActivation = false
    h.owner.setInputDevice = async (id) => {
      if (id === 'built-in' && failPreviousInput) {
        h.calls.push(`input:${id}`)
        throw new Error('previous input temporarily busy')
      }
      await originalSetInputDevice(id)
    }
    h.owner.setAudioSessionOptions = (options) => {
      originalSetAudioSessionOptions(options)
      restoringPlayback = options.iosCategory === 'playback'
    }
    h.owner.setAudioSessionActivity = async (active) => {
      await originalSetAudioSessionActivity(active)
      if (active && restoringPlayback && failPlaybackActivation)
        throw new Error('playback reactivation failed')
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    const lease = await coordinator.acquire({ deviceUid: 'ios:usb' })
    await expect(lease.release()).rejects.toThrow(
      'previous input temporarily busy'
    )

    failPreviousInput = false
    failPlaybackActivation = true
    await expect(coordinator.retryRelease()).rejects.toThrow(
      'reactivate playback session: playback reactivation failed'
    )
    await expect(coordinator.acquire()).rejects.toThrow('must be retried')
    const captureTransitions = h.calls.filter(
      (call) => call === 'options:playAndRecord'
    ).length
    expect(captureTransitions).toBe(2)

    failPlaybackActivation = false
    await coordinator.retryRelease()
    expect(
      h.calls.filter((call) => call === 'options:playAndRecord')
    ).toHaveLength(captureTransitions)
    const next = await coordinator.acquire()
    await next.release()
  })

  test('playback activation failure stays latched even when verification succeeds', async () => {
    const h = harness()
    let restoringPlayback = false
    let failPlaybackActivation = true
    const originalSetAudioSessionOptions = h.owner.setAudioSessionOptions
    h.owner.setAudioSessionOptions = (options) => {
      originalSetAudioSessionOptions(options)
      restoringPlayback = options.iosCategory === 'playback'
    }
    h.owner.setAudioSessionActivity = async (active) => {
      h.calls.push(`active:${active}`)
      if (active && restoringPlayback && failPlaybackActivation)
        throw new Error('playback activation rejected')
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    const lease = await coordinator.acquire()
    await expect(lease.release()).rejects.toThrow(
      'reactivate playback session: playback activation rejected'
    )
    expect(h.calls.at(-1)).toBe('verify:playback')
    await expect(coordinator.acquire()).rejects.toThrow('must be retried')
    failPlaybackActivation = false
    await coordinator.retryRelease()
    const next = await coordinator.acquire()
    await next.release()
  })

  test('concurrent release and acquire are serialized without overlapping leases', async () => {
    const h = harness()
    let finishRelease: (() => void) | undefined
    let releaseCalls = 0
    h.native.releaseLease = async (token) => {
      h.calls.push(`lease:release:start:${token}`)
      if (++releaseCalls === 1)
        await new Promise<void>((resolve) => {
          finishRelease = resolve
        })
      h.calls.push(`lease:release:end:${token}`)
    }
    const coordinator = new IosAudioInputSessionCoordinator(h.owner, h.native)
    const first = await coordinator.acquire()
    const releasing = first.release()
    const acquiring = coordinator.acquire()
    await Promise.resolve()
    expect(finishRelease).toBeDefined()
    finishRelease?.()
    await releasing
    const second = await acquiring
    expect(h.calls.indexOf('lease:release:end:7')).toBeLessThan(
      h.calls.lastIndexOf('lease:acquire:ios:built-in:1')
    )
    await second.release()
  })
})
