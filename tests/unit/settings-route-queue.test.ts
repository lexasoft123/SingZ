import { describe, expect, it, vi } from 'vitest'
import {
  settingsInputChannelRoute,
  settingsInputDeviceRoute,
  settingsInputPropCommitDecision,
  settingsInputRouteSignature,
  settingsPreviewRestartDecision,
  SettingsRouteApplicationQueue,
  type RouteStopOutcome
} from '../../src/renderer/src/audio/settings-route-queue'

/** The mounted Settings preview's confirmed-stop boundary, which the queue
 * runs once before every drain of physical route edits. */
const stopOk = async (): Promise<RouteStopOutcome> => ({ ok: true, safeToRestartPreview: true })

describe('Settings route application queue', () => {
  it('does not restart an old preview before delayed input props commit', async () => {
    const queue = new SettingsRouteApplicationQueue()
    let renderedInput = 'old'
    const starts: string[] = []

    await expect(queue.schedule(
      stopOk,
      () => undefined,
      (restartPreview) => {
        if (restartPreview) starts.push(renderedInput)
      },
      'after-props-commit'
    )).resolves.toBe(true)

    expect(starts).toEqual([])
    expect(renderedInput).toBe('old')
    expect(settingsPreviewRestartDecision(false, 'new', renderedInput)).toBe('wait-for-props')
    // This represents the Settings prop/effect boundary, which is the first
    // owner allowed to create a capture for the new controlled route.
    renderedInput = 'new'
    expect(settingsPreviewRestartDecision(false, 'new', renderedInput)).toBe('restart')
    starts.push(renderedInput)
    expect(starts).toEqual(['new'])
  })

  it('preserves an acknowledged input marker until a later output edit drains', async () => {
    const queue = new SettingsRouteApplicationQueue()
    let renderedInput = 'old'
    let deferredInput: string | null = 'new'
    let restartHeld = true
    const starts: string[] = []
    let finishOutput!: () => void
    const outputGate = new Promise<void>((resolve) => { finishOutput = resolve })
    const commitInputProps = (): void => {
      renderedInput = 'new'
      const decision = settingsInputPropCommitDecision(
        deferredInput,
        renderedInput,
        queue.busy
      )
      if (decision === 'release') {
        deferredInput = null
        restartHeld = false
        starts.push(renderedInput)
      }
    }
    const afterDrain = (restartPreview: boolean): void => {
      if (settingsPreviewRestartDecision(
        restartPreview,
        deferredInput,
        renderedInput
      ) !== 'restart') return
      deferredInput = null
      restartHeld = false
      starts.push(renderedInput)
    }

    const input = queue.schedule(
      stopOk,
      commitInputProps,
      afterDrain,
      'after-props-commit'
    )
    const output = queue.schedule(
      stopOk,
      () => outputGate,
      afterDrain,
      'after-drain'
    )

    await vi.waitFor(() => expect(renderedInput).toBe('new'))
    expect(queue.busy).toBe(true)
    expect(deferredInput).toBe('new')
    expect(restartHeld).toBe(true)
    expect(starts).toEqual([])

    finishOutput()
    await expect(Promise.all([input, output])).resolves.toEqual([true, true])
    expect(queue.busy).toBe(false)
    expect(deferredInput).toBeNull()
    expect(restartHeld).toBe(false)
    expect(starts).toEqual(['new'])
  })

  it('keeps rapid device then channel edits on the invocation-order input draft', async () => {
    const queue = new SettingsRouteApplicationQueue()
    let draft = settingsInputDeviceRoute('native-a', 'chromium-a')
    let rendered = draft
    let deferredInput = settingsInputRouteSignature(draft)
    const events: string[] = []
    let finishStop!: () => void
    const stopGate = new Promise<void>((resolve) => { finishStop = resolve })
    const stop = vi.fn(async () => {
      await stopGate
      return stopOk()
    })
    const afterDrain = vi.fn((restartPreview: boolean) => {
      if (settingsPreviewRestartDecision(
        restartPreview,
        deferredInput,
        settingsInputRouteSignature(rendered)
      ) !== 'restart') return
      events.push(`preview:${settingsInputRouteSignature(rendered)}`)
    })

    const deviceRoute = settingsInputDeviceRoute('native-b', 'chromium-b')
    draft = deviceRoute
    deferredInput = settingsInputRouteSignature(deviceRoute)
    const deviceEdit = queue.schedule(
      stop,
      () => { events.push(`device:${settingsInputRouteSignature(deviceRoute)}`) },
      afterDrain,
      'after-props-commit'
    )

    // The parent still renders A/1 here. The immediate channel edit must be
    // derived from desired B/1, never from those stale controlled props.
    const channelRoute = settingsInputChannelRoute(draft, 2)
    draft = channelRoute
    deferredInput = settingsInputRouteSignature(channelRoute)
    const channelEdit = queue.schedule(
      stop,
      () => {
        events.push(`channel:${settingsInputRouteSignature(channelRoute)}`)
        rendered = channelRoute
        expect(settingsInputPropCommitDecision(
          deferredInput,
          settingsInputRouteSignature(rendered),
          queue.busy
        )).toBe('wait-for-drain')
      },
      afterDrain,
      'after-props-commit'
    )

    expect(rendered).toEqual(settingsInputDeviceRoute('native-a', 'chromium-a'))
    expect(channelRoute).toEqual({
      nativeInputUid: 'native-b',
      inputId: 'chromium-b',
      inputChannel: 2
    })
    expect(queue.busy).toBe(true)
    finishStop()

    await expect(Promise.all([deviceEdit, channelEdit])).resolves.toEqual([true, true])
    expect(stop).toHaveBeenCalledOnce()
    expect(afterDrain).toHaveBeenCalledOnce()
    expect(events).toEqual([
      `device:${settingsInputRouteSignature(deviceRoute)}`,
      `channel:${settingsInputRouteSignature(channelRoute)}`,
      `preview:${settingsInputRouteSignature(channelRoute)}`
    ])
  })

  it('releases the input hold at the prop boundary when the queue drained first', async () => {
    const queue = new SettingsRouteApplicationQueue()
    let renderedInput = 'old'
    let deferredInput: string | null = 'new'
    let restartHeld = true
    const starts: string[] = []
    const afterDrain = (restartPreview: boolean): void => {
      expect(settingsPreviewRestartDecision(
        restartPreview,
        deferredInput,
        renderedInput
      )).toBe('wait-for-props')
    }

    await expect(queue.schedule(
      stopOk,
      () => undefined,
      afterDrain,
      'after-props-commit'
    )).resolves.toBe(true)

    expect(queue.busy).toBe(false)
    expect(deferredInput).toBe('new')
    expect(restartHeld).toBe(true)
    expect(starts).toEqual([])

    // The delayed controlled prop commit replaces the preview effect. With no
    // app-lifetime route work left, that effect is the one restart boundary.
    renderedInput = 'new'
    expect(settingsInputPropCommitDecision(
      deferredInput,
      renderedInput,
      queue.busy
    )).toBe('release')
    deferredInput = null
    restartHeld = false
    starts.push(renderedInput)

    expect(deferredInput).toBeNull()
    expect(restartHeld).toBe(false)
    expect(starts).toEqual(['new'])
  })

  it('coalesces an overlapping mixed route batch onto the final input preview once', async () => {
    const queue = new SettingsRouteApplicationQueue()
    const events: string[] = []
    let renderedInput = 'old'
    const requestedInput = 'new'
    let finishOutput!: () => void
    const outputGate = new Promise<void>((resolve) => { finishOutput = resolve })
    const afterDrain = (restartPreview: boolean): void => {
      if (restartPreview || renderedInput === requestedInput) {
        events.push(`preview:${renderedInput}`)
      }
    }

    const output = queue.schedule(
      stopOk,
      async () => {
        events.push('output-start')
        await outputGate
        events.push('output-end')
      },
      afterDrain,
      'after-drain'
    )
    await vi.waitFor(() => expect(events).toEqual(['output-start']))
    const input = queue.schedule(
      stopOk,
      () => {
        renderedInput = requestedInput
        events.push('input-commit')
      },
      afterDrain,
      'after-props-commit'
    )
    const monitorOutput = queue.schedule(
      stopOk,
      () => { events.push('monitor-output') },
      afterDrain,
      'after-drain'
    )

    finishOutput()
    await expect(Promise.all([output, input, monitorOutput])).resolves.toEqual([true, true, true])
    expect(events).toEqual([
      'output-start',
      'output-end',
      'input-commit',
      'monitor-output',
      'preview:new'
    ])
  })

  it('serializes overlapping route edits in invocation order and restarts preview once', async () => {
    const queue = new SettingsRouteApplicationQueue()
    const events: string[] = []
    const committed: string[] = []
    let finishFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve })
    const stop = vi.fn(async () => {
      events.push('stop')
      return stopOk()
    })
    const restart = vi.fn(() => events.push('preview-restart'))

    const first = queue.schedule(stop, async () => {
      events.push('first-start')
      await firstGate
      committed.push('first')
      events.push('first-commit')
    }, restart)
    await vi.waitFor(() => expect(events).toEqual(['stop', 'first-start']))

    const second = queue.schedule(stop, () => {
      events.push('second-start')
      committed.push('second')
      events.push('second-commit')
    }, restart)
    await Promise.resolve()
    expect(events).toEqual(['stop', 'first-start'])

    finishFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(events).toEqual([
      'stop',
      'first-start',
      'first-commit',
      'second-start',
      'second-commit',
      'preview-restart'
    ])
    expect(committed.at(-1)).toBe('second')
    expect(stop).toHaveBeenCalledOnce()
    expect(restart).toHaveBeenCalledOnce()
  })

  it('restarts preview only after an asynchronous playback route apply settles', async () => {
    const queue = new SettingsRouteApplicationQueue()
    const events: string[] = []
    let finishApply!: () => void
    const applyGate = new Promise<void>((resolve) => { finishApply = resolve })
    const operation = queue.schedule(
      async () => {
        events.push('stop-preview')
        return { ok: true, safeToRestartPreview: true }
      },
      async () => {
        events.push('apply-start')
        await applyGate
        events.push('apply-complete')
      },
      () => events.push('preview-restart')
    )

    await vi.waitFor(() => expect(events).toEqual(['stop-preview', 'apply-start']))
    expect(queue.busy).toBe(true)
    finishApply()

    await expect(operation).resolves.toBe(true)
    expect(queue.busy).toBe(false)
    expect(events).toEqual([
      'stop-preview', 'apply-start', 'apply-complete', 'preview-restart'
    ])
  })

  it('waits for a failed playback route apply before safely reopening preview', async () => {
    const queue = new SettingsRouteApplicationQueue()
    const events: string[] = []
    let failApply!: () => void
    const applyGate = new Promise<void>((_resolve, reject) => {
      failApply = () => reject(new Error('sink switch failed'))
    })
    const operation = queue.schedule(
      async () => {
        events.push('stop-preview')
        return { ok: true, safeToRestartPreview: true }
      },
      async () => {
        events.push('apply-start')
        await applyGate
      },
      () => events.push('preview-restart')
    )

    await vi.waitFor(() => expect(events).toEqual(['stop-preview', 'apply-start']))
    failApply()

    await expect(operation).rejects.toThrow('sink switch failed')
    expect(events).toEqual(['stop-preview', 'apply-start', 'preview-restart'])
  })

  it('never applies a route edit or restarts the preview when the preview stop is unconfirmed', async () => {
    const queue = new SettingsRouteApplicationQueue()
    const apply = vi.fn()
    const restart = vi.fn()
    await expect(queue.schedule(
      async () => ({ ok: false, safeToRestartPreview: false, error: 'native child still alive' }),
      apply,
      restart
    )).resolves.toBe(false)
    expect(apply).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
    expect(queue.busy).toBe(false)
  })
})

describe('app-lifetime Settings input route intent', () => {
  const route = (
    nativeInputUid: string,
    inputId: string,
    inputChannel = 0
  ) => ({ nativeInputUid, inputId, inputChannel })

  it('keeps the desired device through a drained queue and stale rerender before a channel edit', async () => {
    const queue = new SettingsRouteApplicationQueue()
    const oldRoute = route('native-a', 'chromium-a')
    const deviceRoute = route('native-b', 'chromium-b')
    const restarts: string[] = []
    queue.acknowledgeRenderedInputRoute(oldRoute)
    queue.subscribePreviewRestart(() => restarts.push('restart'))

    const deviceSignature = queue.deferInputRoute(deviceRoute)
    await expect(queue.schedule(
      stopOk,
      () => undefined,
      vi.fn(),
      'after-props-commit',
      deviceSignature
    )).resolves.toBe(true)

    expect(queue.busy).toBe(false)
    expect(queue.hasDeferredInputIntent).toBe(true)
    expect(queue.acknowledgeRenderedInputRoute(oldRoute)).toBe('unrelated')
    expect(queue.inputRouteDraft(oldRoute)).toEqual(deviceRoute)

    const channelRoute = settingsInputChannelRoute(queue.inputRouteDraft(oldRoute), 2)
    const channelSignature = queue.deferInputRoute(channelRoute)
    await expect(queue.schedule(
      stopOk,
      () => {
        expect(queue.acknowledgeRenderedInputRoute(channelRoute)).toBe('wait-for-drain')
      },
      vi.fn(),
      'after-props-commit',
      channelSignature
    )).resolves.toBe(true)

    expect(channelRoute).toEqual(route('native-b', 'chromium-b', 2))
    expect(queue.hasDeferredInputIntent).toBe(false)
    expect(restarts).toEqual(['restart'])
  })

  it('survives a real modal-owner close/reopen before input props and derives the next edit from the shared draft', async () => {
    const queue = new SettingsRouteApplicationQueue()
    const oldRoute = route('native-a', 'chromium-a')
    const deviceRoute = route('native-b', 'chromium-b')
    const oldModalRestarts = vi.fn()
    const newModalRestarts: string[] = []
    queue.acknowledgeRenderedInputRoute(oldRoute)
    const unsubscribeOldModal = queue.subscribePreviewRestart(oldModalRestarts)
    let finishStop!: () => void
    const stopGate = new Promise<void>((resolve) => { finishStop = resolve })
    const stop = vi.fn(async () => {
      await stopGate
      return stopOk()
    })

    const deviceSignature = queue.deferInputRoute(deviceRoute)
    const deviceEdit = queue.schedule(
      stop,
      () => undefined,
      vi.fn(),
      'after-props-commit',
      deviceSignature
    )

    // Close the first Settings instance and mount a new one with the same old
    // controlled props while the app-shell queue is still draining.
    unsubscribeOldModal()
    queue.subscribePreviewRestart(() => {
      newModalRestarts.push('restart')
    })
    expect(queue.acknowledgeRenderedInputRoute(oldRoute)).toBe('unrelated')
    const channelRoute = settingsInputChannelRoute(queue.inputRouteDraft(oldRoute), 3)
    const channelSignature = queue.deferInputRoute(channelRoute)
    const channelEdit = queue.schedule(
      stop,
      () => {
        expect(queue.acknowledgeRenderedInputRoute(channelRoute)).toBe('wait-for-drain')
      },
      vi.fn(),
      'after-props-commit',
      channelSignature
    )

    finishStop()
    await expect(Promise.all([deviceEdit, channelEdit])).resolves.toEqual([true, true])
    expect(stop).toHaveBeenCalledOnce()
    expect(oldModalRestarts).not.toHaveBeenCalled()
    expect(newModalRestarts).toEqual(['restart'])
    expect(queue.inputRouteDraft(channelRoute)).toEqual(route('native-b', 'chromium-b', 3))
    expect(queue.hasDeferredInputIntent).toBe(false)
  })

  it('lets an unresolved input intent dominate a later output-only batch in either batch order', async () => {
    const oldRoute = route('native-a', 'chromium-a')
    const nextRoute = route('native-b', 'chromium-b')

    const inputThenOutput = new SettingsRouteApplicationQueue()
    inputThenOutput.acknowledgeRenderedInputRoute(oldRoute)
    const inputThenOutputRestarts = vi.fn()
    inputThenOutput.subscribePreviewRestart(inputThenOutputRestarts)
    const firstSignature = inputThenOutput.deferInputRoute(nextRoute)
    await inputThenOutput.schedule(
      stopOk, () => undefined, vi.fn(),
      'after-props-commit', firstSignature
    )
    await inputThenOutput.schedule(
      stopOk, () => undefined, vi.fn(), 'after-drain'
    )
    expect(inputThenOutput.hasDeferredInputIntent).toBe(true)
    expect(inputThenOutputRestarts).not.toHaveBeenCalled()
    expect(inputThenOutput.acknowledgeRenderedInputRoute(nextRoute)).toBe('release')
    expect(inputThenOutputRestarts).toHaveBeenCalledOnce()

    const outputThenInput = new SettingsRouteApplicationQueue()
    outputThenInput.acknowledgeRenderedInputRoute(oldRoute)
    const outputThenInputRestarts = vi.fn()
    outputThenInput.subscribePreviewRestart(outputThenInputRestarts)
    await outputThenInput.schedule(
      stopOk, () => undefined, vi.fn(), 'after-drain'
    )
    expect(outputThenInputRestarts).toHaveBeenCalledOnce()
    const secondSignature = outputThenInput.deferInputRoute(nextRoute)
    await outputThenInput.schedule(
      stopOk, () => undefined, vi.fn(),
      'after-props-commit', secondSignature
    )
    expect(outputThenInputRestarts).toHaveBeenCalledOnce()
    expect(outputThenInput.hasDeferredInputIntent).toBe(true)
    expect(outputThenInput.acknowledgeRenderedInputRoute(nextRoute)).toBe('release')
    expect(outputThenInputRestarts).toHaveBeenCalledTimes(2)
    expect(outputThenInput.hasDeferredInputIntent).toBe(false)
  })

  it.each(['props-first', 'drain-first'] as const)(
    'restarts exactly once with no permanent hold when acknowledgement is %s',
    async (order) => {
        const queue = new SettingsRouteApplicationQueue()
      const oldRoute = route('native-a', 'chromium-a')
      const nextRoute = route('native-b', 'chromium-b', 2)
      const restarts = vi.fn()
      queue.acknowledgeRenderedInputRoute(oldRoute)
      queue.subscribePreviewRestart(restarts)
      const signature = queue.deferInputRoute(nextRoute)
      const operation = queue.schedule(
        stopOk,
        () => {
          if (order === 'props-first') {
            expect(queue.acknowledgeRenderedInputRoute(nextRoute)).toBe('wait-for-drain')
          }
        },
        vi.fn(),
        'after-props-commit',
        signature
      )

      await expect(operation).resolves.toBe(true)
      if (order === 'drain-first') {
        expect(queue.hasDeferredInputIntent).toBe(true)
        expect(restarts).not.toHaveBeenCalled()
        expect(queue.acknowledgeRenderedInputRoute(nextRoute)).toBe('release')
      }
      expect(queue.hasDeferredInputIntent).toBe(false)
      expect(restarts).toHaveBeenCalledOnce()
      expect(queue.inputRouteDraft(nextRoute)).toEqual(nextRoute)
    }
  )

  it('repairs a rejected input apply to committed props and permits one safe restart', async () => {
    const queue = new SettingsRouteApplicationQueue()
    const oldRoute = route('native-a', 'chromium-a')
    const nextRoute = route('native-b', 'chromium-b')
    const restarts = vi.fn()
    queue.acknowledgeRenderedInputRoute(oldRoute)
    queue.subscribePreviewRestart(restarts)
    const signature = queue.deferInputRoute(nextRoute)

    await expect(queue.schedule(
      stopOk,
      () => { throw new Error('input apply failed') },
      vi.fn(),
      'after-props-commit',
      signature
    )).rejects.toThrow('input apply failed')

    expect(queue.hasDeferredInputIntent).toBe(false)
    expect(queue.inputRouteDraft(oldRoute)).toEqual(oldRoute)
    expect(restarts).toHaveBeenCalledOnce()
  })

  it('does not retire a later same-signature intent when the earlier apply fails', async () => {
    const queue = new SettingsRouteApplicationQueue()
    const oldRoute = route('native-a', 'chromium-a')
    const nextRoute = route('native-b', 'chromium-b')
    const restarts = vi.fn()
    queue.acknowledgeRenderedInputRoute(oldRoute)
    queue.subscribePreviewRestart(restarts)

    const firstSignature = queue.deferInputRoute(nextRoute)
    const first = queue.schedule(
      stopOk,
      () => { throw new Error('first duplicate failed') },
      vi.fn(),
      'after-props-commit',
      firstSignature
    )
    const secondSignature = queue.deferInputRoute(nextRoute)
    const second = queue.schedule(
      stopOk,
      () => {
        expect(queue.acknowledgeRenderedInputRoute(nextRoute)).toBe('wait-for-drain')
      },
      vi.fn(),
      'after-props-commit',
      secondSignature
    )

    const results = await Promise.allSettled([first, second])
    expect(results[0]).toMatchObject({ status: 'rejected' })
    expect(results[1]).toEqual({ status: 'fulfilled', value: true })
    expect(queue.hasDeferredInputIntent).toBe(false)
    expect(restarts).toHaveBeenCalledOnce()
  })
})
