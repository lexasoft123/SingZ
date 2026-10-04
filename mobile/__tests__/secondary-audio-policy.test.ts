const { patchSecondaryAudioNotifications } = require('../scripts/secondary-audio-policy.cjs')

const interruption = `- (void)handleInterruption:(NSNotification *)notification
{
  [audioEngine onInterruptionBegin];
  [sessionManager markInactive];
  emitInterruptionBegan();
}
`
const route = '- (void)handleRouteChange:(NSNotification *)notification\n{ handleRoute(); }'
const source = interruption + `- (void)handleSecondaryAudio:(NSNotification *)notification
{
  NSInteger type = [notification.userInfo[AVAudioSessionSilenceSecondaryAudioHintTypeKey] integerValue];
  [audioEngine onInterruptionBegin];
  [sessionManager markInactive];
  emitInterruptionBegan();
}

` + route

test('optional-secondary hints cannot revoke capture; actual interruptions and routes remain intact', () => {
  const patched = patchSecondaryAudioNotifications(source)
  expect(patched.startsWith(interruption)).toBe(true)
  expect(patched.endsWith(route)).toBe(true)
  const secondary = patched.slice(interruption.length, patched.indexOf('- (void)handleRouteChange:'))
  expect(secondary).not.toMatch(/onInterruptionBegin|markInactive|emitInterruptionBegan/)
  expect(patchSecondaryAudioNotifications(patched)).toBe(patched)
})
test('fails closed when upstream changes notification handling', () => {
  expect(() => patchSecondaryAudioNotifications(source.replace('handleSecondaryAudio:', 'changedHandler:'))).toThrow()
  expect(() => patchSecondaryAudioNotifications(source.replace('AVAudioSessionSilenceSecondaryAudioHintTypeKey', 'changedKey'))).toThrow()
})
