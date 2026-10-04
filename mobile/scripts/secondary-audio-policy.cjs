/** SingZ's audio is primary; optional-secondary hints cannot revoke capture. */
function patchSecondaryAudioNotifications(source) {
  const start = source.indexOf('- (void)handleSecondaryAudio:(NSNotification *)notification\n{');
  const end = source.indexOf('- (void)handleRouteChange:', start);
  const handler = `- (void)handleSecondaryAudio:(NSNotification *)notification
{
  // SingZ patch 5: primary audio must not be stopped by a secondary-audio hint.
  // Real calls/Siri interruptions are handled by handleInterruption unchanged.
  NSLog(@"SingZ: secondary audio hint (primary audio continues)");
}

`;
  if (start < 0 || end < 0) throw new Error('audio-api patch 5: notification handler anchors changed');
  const previous = source.slice(start, end);
  if (previous === handler) return source;
  if (!previous.includes('AVAudioSessionSilenceSecondaryAudioHintTypeKey') || !previous.includes('onInterruptionBegin'))
    throw new Error('audio-api patch 5: upstream secondary-audio policy changed');
  return source.slice(0, start) + handler + source.slice(end);
}
module.exports = { patchSecondaryAudioNotifications };
