const { MultitrackEngine } = jest.requireActual('../src/engine') as typeof import('../src/engine')

test('confirmation tone finishes while reference cancellation and pitch transitions leave it playing', async () => {
  jest.useFakeTimers()
  const oscillator = { frequency: { value: 0 }, connect: jest.fn(), disconnect: jest.fn(), start: jest.fn(), stop: jest.fn() }
  const gain = { gain: { setValueAtTime: jest.fn(), linearRampToValueAtTime: jest.fn() }, connect: jest.fn(), disconnect: jest.fn() }
  const engine = Object.assign(Object.create(MultitrackEngine.prototype), {
    ctx: { currentTime: 10, state: 'running', createOscillator: () => oscillator, createGain: () => gain },
    trainingGain: {}, trainingNodes: [], trainingLatchNodes: [], trainingCueGeneration: 0,
    backgrounded: false, nativeOutputHandoff: false
  }) as import('../src/engine').MultitrackEngine
  const result = await engine.playTrainingLatch()
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error)
  expect(result.endsAt - result.startsAt).toBeCloseTo(.45)
  engine.cancelTrainingCues(true)
  expect(oscillator.stop).toHaveBeenCalledTimes(1)
  expect(oscillator.stop).toHaveBeenCalledWith(result.endsAt)
  expect(oscillator.disconnect).not.toHaveBeenCalled()
  jest.advanceTimersByTime(600)
  expect(oscillator.disconnect).toHaveBeenCalledTimes(1)
  expect(gain.disconnect).toHaveBeenCalledTimes(1)
  jest.useRealTimers()
})

test('leaving training explicitly cancels even a confirmation tone', async () => {
  jest.useFakeTimers()
  const oscillator = { frequency: { value: 0 }, connect: jest.fn(), disconnect: jest.fn(), start: jest.fn(), stop: jest.fn() }
  const gain = { gain: { setValueAtTime: jest.fn(), linearRampToValueAtTime: jest.fn() }, connect: jest.fn(), disconnect: jest.fn() }
  const engine = Object.assign(Object.create(MultitrackEngine.prototype), {
    ctx: { currentTime: 10, state: 'running', createOscillator: () => oscillator, createGain: () => gain },
    trainingGain: {}, trainingNodes: [], trainingLatchNodes: [], trainingCueGeneration: 0,
    backgrounded: false, nativeOutputHandoff: false
  }) as import('../src/engine').MultitrackEngine
  await engine.playTrainingLatch(); engine.cancelTrainingCues()
  expect(oscillator.stop).toHaveBeenLastCalledWith(10)
  expect(oscillator.disconnect).toHaveBeenCalledTimes(1)
  jest.advanceTimersByTime(600)
  expect(oscillator.disconnect).toHaveBeenCalledTimes(1)
  jest.useRealTimers()
})
