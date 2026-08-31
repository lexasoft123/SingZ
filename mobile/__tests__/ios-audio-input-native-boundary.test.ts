import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(
  join(__dirname, '..', 'ios', 'FolderAccess', 'AudioInputSessionBridge.mm'),
  'utf8'
)

const method = (start: string, end: string): string => {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

describe('iOS native audio-input ownership boundary', () => {
  test('delivery analysis stays native and every Foundation scalar event has a local pool', () => {
    const accept = method('void accept(', '\n};\n\n}  // namespace')
    expect(accept.indexOf('adapter.push(')).toBeLessThan(
      accept.indexOf('@autoreleasepool')
    )
    const pool = accept.slice(accept.indexOf('@autoreleasepool'))
    expect(pool).toContain('NSDictionary* payload')
    expect(pool).toContain('sendEventWithName:@"singzAudioInputFrame"')
    expect(pool).not.toMatch(/@"(?:pcm|samples|audio|buffer)"/i)
  })

  test('monitor failure suppresses events, detaches, joins, destroys, then reports', () => {
    const poll = method('- (void)pollCaptureState', '- (void)startCaptureMonitorLocked')
    const ordered = [
      'context->active.store(false',
      'owner->phase = CaptureOwnerPhase::Stopping',
      'input = std::move(_captureInput)',
      '_captureContext.reset()',
      'stopAndDestroyCaptureInput(input, stopError)',
      'context.reset()',
      'owner->phase = CaptureOwnerPhase::FullyStopped',
      '_captureCondition.notify_all()',
      'sendEventWithName:@"singzAudioInputState"'
    ].map((needle) => poll.indexOf(needle))
    expect(ordered.every((index) => index >= 0)).toBe(true)
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b))
    expect(poll).not.toContain('adapter.cancel')
  })

  test('explicit stop waits for the exact generation and publishes stopped only after join', () => {
    const stop = method('RCT_REMAP_METHOD(\n    stopCapture,', '\n@end')
    expect(stop).toContain('std::isfinite(requestedGeneration)')
    expect(stop).toContain('requestedGeneration < 1')
    expect(stop).toContain('owner = _captureOwner')
    expect(stop).toContain('owner->generation != generation')
    expect(stop).toContain('_captureCondition.wait(lock')
    expect(stop).toContain(
      'return owner->phase != CaptureOwnerPhase::Stopping'
    )
    expect(stop).not.toContain('if (!context) {\n      resolve(nil)')
    const ordered = [
      'context->active.store(false',
      'owner->phase = CaptureOwnerPhase::Stopping',
      'input = std::move(_captureInput)',
      'stopAndDestroyCaptureInput(input, stopError)',
      'context.reset()',
      'owner->phase = CaptureOwnerPhase::FullyStopped',
      '_captureCondition.notify_all()',
      'sendEventWithName:@"singzAudioInputState"'
    ].map((needle) => stop.indexOf(needle))
    expect(ordered.every((index) => index >= 0)).toBe(true)
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b))
    expect(stop).not.toContain('adapter.cancel')
  })

  test('new capture cannot replace an owner while monitor teardown is stopping', () => {
    const start = method(
      'RCT_REMAP_METHOD(\n    startCapture,',
      'RCT_REMAP_METHOD(\n    stopCapture,'
    )
    expect(start).toContain(
      '_captureOwner->phase != CaptureOwnerPhase::FullyStopped'
    )
    expect(start).toContain('!_captureOwner->stopSucceeded')
  })
})
