import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  PlaybackOutputArbiter,
  PlaybackOutputRouteSafety,
  PlaybackOutputSelectionError
} from '../../src/renderer/src/audio/output-routing'

const outputDevice = (deviceId: string): MediaDeviceInfo => ({
  deviceId,
  groupId: 'outputs',
  kind: 'audiooutput',
  label: deviceId,
  toJSON: () => ({})
})

describe('playback output latest-intent arbitration', () => {
  it.each([
    ['a concrete output', 'B'],
    ['the system default', undefined]
  ] as const)(
    'invalidates a reconcile paused in inventory before selecting %s',
    async (_name, selected) => {
      let finishInventory!: (devices: readonly MediaDeviceInfo[]) => void
      const inventory = new Promise<readonly MediaDeviceInfo[]>((resolve) => {
        finishInventory = resolve
      })
      const setOutput = vi.fn(async () => undefined)
      const commit = vi.fn()
      const arbiter = new PlaybackOutputArbiter('A', {
        setOutput,
        enumerateOutputs: vi.fn(() => inventory),
        commit
      })

      const reconcile = arbiter.reconcile()
      await Promise.resolve()
      const direct = arbiter.select(selected)
      await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith(selected ?? ''))
      finishInventory([outputDevice('A'), outputDevice('B')])

      await expect(reconcile).resolves.toEqual({ kind: 'stale' })
      await expect(direct).resolves.toBe(true)
      expect(setOutput).toHaveBeenCalledTimes(1)
      expect(setOutput).toHaveBeenCalledWith(selected ?? '')
      expect(commit).toHaveBeenCalledOnce()
      expect(commit).toHaveBeenCalledWith(selected)
    }
  )

  it.each([
    ['a concrete output', 'B'],
    ['the system default', undefined]
  ] as const)(
    'reconciles current desired intent when devicechange arrives during %s apply',
    async (_name, selected) => {
      let finishDirect!: () => void
      const directGate = new Promise<void>((resolve) => { finishDirect = resolve })
      const setOutput = vi.fn(async (sinkId: string) => {
        if (setOutput.mock.calls.length === 1) await directGate
        expect(sinkId).toBe(selected ?? '')
      })
      const commit = vi.fn()
      const enumerateOutputs = vi.fn(async () => [outputDevice('A'), outputDevice('B')])
      const arbiter = new PlaybackOutputArbiter('A', {
        setOutput,
        enumerateOutputs,
        commit
      })

      const direct = arbiter.select(selected)
      await vi.waitFor(() => expect(setOutput).toHaveBeenCalledTimes(1))
      const deviceChange = arbiter.reconcile()
      finishDirect()

      await expect(direct).resolves.toBe(true)
      await expect(deviceChange).resolves.toEqual({ kind: 'applied', outputId: selected })
      expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual([
        selected ?? '', selected ?? ''
      ])
      expect(enumerateOutputs).toHaveBeenCalledTimes(selected ? 1 : 0)
      expect(commit).toHaveBeenCalledOnce()
      expect(commit).toHaveBeenCalledWith(selected)
    }
  )

  it('prevents a pending B selection from committing after a quick C selection', async () => {
    let finishB!: () => void
    const bGate = new Promise<void>((resolve) => { finishB = resolve })
    const setOutput = vi.fn(async (sinkId: string) => {
      if (sinkId === 'B') await bGate
    })
    const commit = vi.fn()
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs: vi.fn(async () => [outputDevice('A'), outputDevice('B'), outputDevice('C')]),
      commit
    })

    const selectB = arbiter.select('B')
    await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith('B'))
    const selectC = arbiter.select('C')
    finishB()

    await expect(selectB).resolves.toBe(false)
    await expect(selectC).resolves.toBe(true)
    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith('C')
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['B', 'C'])
  })

  it('physically restores committed A when superseded B succeeded but current C fails', async () => {
    let finishB!: () => void
    const bGate = new Promise<void>((resolve) => { finishB = resolve })
    const setOutput = vi.fn(async (sinkId: string) => {
      if (sinkId === 'B') await bGate
      if (sinkId === 'C') throw new Error('C handoff failed')
    })
    const commit = vi.fn()
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs: vi.fn(async () => [
        outputDevice('A'), outputDevice('B'), outputDevice('C')
      ]),
      commit
    })

    const selectB = arbiter.select('B')
    await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith('B'))
    const selectC = arbiter.select('C')
    finishB()

    await expect(selectB).resolves.toBe(false)
    await expect(selectC).rejects.toMatchObject({
      name: 'PlaybackOutputSelectionError',
      current: true,
      repairRequired: false
    } satisfies Partial<PlaybackOutputSelectionError>)
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['B', 'C', 'A'])
    expect(commit).not.toHaveBeenCalled()

    await expect(arbiter.reconcile()).resolves.toEqual({ kind: 'applied', outputId: 'A' })
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['B', 'C', 'A', 'A'])
  })

  it('lets quick newer D win when C rollback is still settling', async () => {
    let finishB!: () => void
    let failRollback!: () => void
    const bGate = new Promise<void>((resolve) => { finishB = resolve })
    const rollbackGate = new Promise<void>((_resolve, reject) => {
      failRollback = () => reject(new Error('A rollback failed'))
    })
    let aCalls = 0
    const setOutput = vi.fn(async (sinkId: string) => {
      if (sinkId === 'B') await bGate
      if (sinkId === 'C') throw new Error('C handoff failed')
      if (sinkId === 'A' && ++aCalls === 1) await rollbackGate
    })
    const commit = vi.fn()
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs: vi.fn(async () => [
        outputDevice('A'), outputDevice('B'), outputDevice('C'), outputDevice('D')
      ]),
      commit
    })

    const selectB = arbiter.select('B')
    await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith('B'))
    const selectC = arbiter.select('C')
    finishB()
    await vi.waitFor(() => expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['B', 'C', 'A']))
    const selectD = arbiter.select('D')
    failRollback()

    await expect(selectB).resolves.toBe(false)
    await expect(selectC).rejects.toMatchObject({
      name: 'PlaybackOutputSelectionError',
      current: false,
      repairRequired: false
    } satisfies Partial<PlaybackOutputSelectionError>)
    await expect(selectD).resolves.toBe(true)
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['B', 'C', 'A', 'D'])
    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith('D')
  })

  it('leaves double-failure repair to an awaited caller after rollback fails', async () => {
    let aCalls = 0
    const setOutput = vi.fn(async (sinkId: string) => {
      if (sinkId === 'C') throw new Error('C handoff failed')
      if (sinkId === 'A' && ++aCalls === 1) throw new Error('A rollback failed')
    })
    const enumerateOutputs = vi.fn(async () => [outputDevice('A'), outputDevice('C')])
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs,
      commit: vi.fn()
    })

    let failure: PlaybackOutputSelectionError | null = null
    try {
      await arbiter.select('C')
    } catch (error) {
      failure = error as PlaybackOutputSelectionError
    }
    expect(failure).toMatchObject({
      name: 'PlaybackOutputSelectionError',
      current: true,
      repairRequired: true
    } satisfies Partial<PlaybackOutputSelectionError>)

    await Promise.resolve()
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['C', 'A'])
    await expect(arbiter.repairSelectionFailure(failure!)).resolves.toEqual({
      kind: 'applied', outputId: 'A'
    })
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['C', 'A', 'A'])
    expect(enumerateOutputs).toHaveBeenCalledOnce()
  })

  it('claims a missing saved device uses default only after the default sink settles', async () => {
    let finishDefault!: () => void
    const defaultGate = new Promise<void>((resolve) => { finishDefault = resolve })
    const setOutput = vi.fn(async (sinkId: string) => {
      expect(sinkId).toBe('')
      await defaultGate
    })
    const arbiter = new PlaybackOutputArbiter('missing-output', {
      setOutput,
      enumerateOutputs: vi.fn(async () => []),
      commit: vi.fn()
    })
    let settled = false
    const repair = arbiter.reconcile().finally(() => { settled = true })

    await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith(''))
    expect(settled).toBe(false)
    finishDefault()

    await expect(repair).resolves.toEqual({
      kind: 'missing', outputId: 'missing-output'
    })
    expect(settled).toBe(true)
  })

  it('does not let an awaited repair overwrite a newer direct intent', async () => {
    let aCalls = 0
    const setOutput = vi.fn(async (sinkId: string) => {
      if (sinkId === 'C') throw new Error('C handoff failed')
      if (sinkId === 'A' && ++aCalls === 1) throw new Error('A rollback failed')
    })
    let finishInventory!: (devices: readonly MediaDeviceInfo[]) => void
    const inventory = new Promise<readonly MediaDeviceInfo[]>((resolve) => {
      finishInventory = resolve
    })
    const commit = vi.fn()
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs: vi.fn(() => inventory),
      commit
    })
    let failure!: PlaybackOutputSelectionError
    try {
      await arbiter.select('C')
    } catch (error) {
      failure = error as PlaybackOutputSelectionError
    }

    const repair = arbiter.repairSelectionFailure(failure)
    await Promise.resolve()
    const newer = arbiter.select('D')
    finishInventory([outputDevice('A'), outputDevice('C'), outputDevice('D')])

    await expect(repair).resolves.toEqual({ kind: 'stale' })
    await expect(newer).resolves.toBe(true)
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['C', 'A', 'D'])
    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith('D')
  })

  it('treats a superseded inventory rejection as stale but surfaces the current one', async () => {
    let rejectOldInventory!: (error: Error) => void
    const oldInventory = new Promise<readonly MediaDeviceInfo[]>((_resolve, reject) => {
      rejectOldInventory = reject
    })
    const enumerateOutputs = vi.fn()
      .mockReturnValueOnce(oldInventory)
      .mockRejectedValueOnce(new Error('current inventory failed'))
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput: vi.fn(async () => undefined),
      enumerateOutputs,
      commit: vi.fn()
    })

    const stale = arbiter.reconcile()
    await Promise.resolve()
    const current = arbiter.reconcile()
    rejectOldInventory(new Error('old inventory failed'))

    await expect(stale).resolves.toEqual({ kind: 'stale' })
    await expect(current).rejects.toThrow('current inventory failed')
  })

  it.each([
    ['a concrete output', 'B'],
    ['the system default', undefined]
  ] as const)(
    'restores the committed intent when selecting %s fails before queued repair',
    async (_name, selected) => {
      let failDirect!: () => void
      const directGate = new Promise<void>((_resolve, reject) => {
        failDirect = () => reject(new Error('direct handoff failed'))
      })
      const targetSink = selected ?? ''
      const setOutput = vi.fn(async (sinkId: string) => {
        if (sinkId === targetSink && setOutput.mock.calls.length === 1) await directGate
      })
      const commit = vi.fn()
      const arbiter = new PlaybackOutputArbiter('A', {
        setOutput,
        enumerateOutputs: vi.fn(async () => [outputDevice('A'), outputDevice('B')]),
        commit
      })

      const direct = arbiter.select(selected)
      await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith(targetSink))
      const deviceChange = arbiter.reconcile()
      failDirect()

      await expect(direct).rejects.toMatchObject({
        name: 'PlaybackOutputSelectionError',
        current: true
      } satisfies Partial<PlaybackOutputSelectionError>)
      await expect(deviceChange).resolves.toEqual({ kind: 'applied', outputId: 'A' })
      expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual([targetSink, 'A', 'A'])
      expect(commit).not.toHaveBeenCalled()
    }
  )

  it('tracks an unconfirmed playback route until a current operation confirms a sink', async () => {
    const changes: boolean[] = []
    const routeSafety = new PlaybackOutputRouteSafety((unconfirmed) => changes.push(unconfirmed))
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput: vi.fn(async () => undefined),
      enumerateOutputs: vi.fn(async () => [outputDevice('A')]),
      commit: vi.fn()
    })
    expect(routeSafety.unconfirmed).toBe(false)
    routeSafety.retainUnconfirmed()
    routeSafety.retainUnconfirmed()
    expect(routeSafety.unconfirmed).toBe(true)

    const result = await arbiter.reconcile()
    expect(result).toEqual({ kind: 'applied', outputId: 'A' })
    if (result.kind !== 'stale') routeSafety.confirmCurrentRoute()
    routeSafety.confirmCurrentRoute()

    expect(routeSafety.unconfirmed).toBe(false)
    expect(changes).toEqual([true, false])
  })

  it('does not notify when a route that was never unconfirmed is confirmed', () => {
    const changes: boolean[] = []
    const routeSafety = new PlaybackOutputRouteSafety((unconfirmed) => changes.push(unconfirmed))
    routeSafety.confirmCurrentRoute()
    expect(routeSafety.unconfirmed).toBe(false)
    expect(changes).toEqual([])
  })

  it('wires the app shell to refuse song starts while the route is unconfirmed', () => {
    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(appSource).toMatch(
      /if \(result\.kind === 'stale'\) \{[\s\S]*if \(retry\) throw[\s\S]*return[\s\S]*\}\s+outputRouteSafety\.confirmCurrentRoute\(\)/
    )
    expect(appSource).toMatch(
      /!engine\.playing && \(trainingCleanupBlocked \|\| outputRouteSafety\.unconfirmed\)/
    )
    expect(appSource).toContain('new PlaybackOutputRouteSafety(\n    setOutputRouteUnconfirmed\n  )')
  })
})
