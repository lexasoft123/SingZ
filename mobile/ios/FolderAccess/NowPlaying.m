#import <MediaPlayer/MediaPlayer.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <UIKit/UIKit.h>

/**
 * The song on the Lock Screen and in Control Center, and the play, pause and
 * scrub that come back from there (mobile/src/playback/now-playing.ts owns
 * WHAT is shown and when; this only puts it in front of the OS).
 *
 * App Review rejected the first iPhone submission under guideline 2.5.4: the
 * app declares the `audio` background mode, and nothing outside the app showed
 * a song still playing. This is that something.
 *
 * Method names and arity match Android's NowPlayingModule exactly:
 * update(info) · clear() · debugCommand(command, value) · debugState().
 * The session itself is not touched here — both playback paths set
 * AVAudioSessionCategoryPlayback with NO options, which is what lets iOS show
 * Now Playing at all (a mixable session never gets a card), and the native
 * path's verifier refuses any other options.
 */
@interface NowPlaying : RCTEventEmitter <RCTBridgeModule>
@end

static NSString *const kCommandEvent = @"singzNowPlayingCommand";

@implementation NowPlaying {
  BOOL _hasListeners;
  BOOL _commandsAttached;
  MPMediaItemArtwork *_artwork;
}

RCT_EXPORT_MODULE(NowPlaying)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

// MPNowPlayingInfoCenter and MPRemoteCommandCenter are main-thread objects.
- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[ kCommandEvent ];
}

- (void)startObserving
{
  _hasListeners = YES;
}

- (void)stopObserving
{
  _hasListeners = NO;
}

#pragma mark - Commands

/// Where every command lands, from the OS and from debugCommand alike.
- (MPRemoteCommandHandlerStatus)emit:(NSString *)command value:(double)value
{
  if (!_hasListeners) {
    // No player is listening (the JS side detached between the tap and now):
    // say so, rather than claim a pause that never happened.
    return MPRemoteCommandHandlerStatusNoActionableNowPlayingItem;
  }
  [self sendEventWithName:kCommandEvent body:@{@"command" : command, @"value" : @(value)}];
  return MPRemoteCommandHandlerStatusSuccess;
}

- (MPRemoteCommandHandlerStatus)onPlay:(MPRemoteCommandEvent *)event
{
  return [self emit:@"play" value:0];
}

- (MPRemoteCommandHandlerStatus)onPause:(MPRemoteCommandEvent *)event
{
  return [self emit:@"pause" value:0];
}

- (MPRemoteCommandHandlerStatus)onToggle:(MPRemoteCommandEvent *)event
{
  return [self emit:@"toggle" value:0];
}

- (MPRemoteCommandHandlerStatus)onSeek:(MPChangePlaybackPositionCommandEvent *)event
{
  return [self emit:@"seek" value:event.positionTime];
}

- (MPRemoteCommandHandlerStatus)onSkipForward:(MPSkipIntervalCommandEvent *)event
{
  return [self emit:@"skip" value:event.interval];
}

- (MPRemoteCommandHandlerStatus)onSkipBackward:(MPSkipIntervalCommandEvent *)event
{
  return [self emit:@"skip" value:-event.interval];
}

- (void)attachCommands
{
  if (_commandsAttached) {
    return;
  }
  MPRemoteCommandCenter *center = [MPRemoteCommandCenter sharedCommandCenter];
  [center.playCommand addTarget:self action:@selector(onPlay:)];
  [center.pauseCommand addTarget:self action:@selector(onPause:)];
  [center.togglePlayPauseCommand addTarget:self action:@selector(onToggle:)];
  [center.changePlaybackPositionCommand addTarget:self action:@selector(onSeek:)];
  [center.skipForwardCommand addTarget:self action:@selector(onSkipForward:)];
  [center.skipBackwardCommand addTarget:self action:@selector(onSkipBackward:)];
  // One song at a time: there is no next or previous track to go to, and a
  // button that does nothing on the Lock Screen is worse than no button.
  center.nextTrackCommand.enabled = NO;
  center.previousTrackCommand.enabled = NO;
  center.seekForwardCommand.enabled = NO;
  center.seekBackwardCommand.enabled = NO;
  [[UIApplication sharedApplication] beginReceivingRemoteControlEvents];
  _commandsAttached = YES;
}

- (void)detachCommands
{
  if (!_commandsAttached) {
    return;
  }
  MPRemoteCommandCenter *center = [MPRemoteCommandCenter sharedCommandCenter];
  for (MPRemoteCommand *command in @[
         center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
         center.changePlaybackPositionCommand, center.skipForwardCommand,
         center.skipBackwardCommand
       ]) {
    [command removeTarget:self];
    command.enabled = NO;
  }
  [[UIApplication sharedApplication] endReceivingRemoteControlEvents];
  _commandsAttached = NO;
}

- (MPMediaItemArtwork *)artwork
{
  if (_artwork == nil) {
    UIImage *image = [UIImage imageNamed:@"NowPlayingArtwork"];
    if (image != nil) {
      _artwork = [[MPMediaItemArtwork alloc] initWithBoundsSize:image.size
                                                 requestHandler:^UIImage *(CGSize size) {
                                                   return image;
                                                 }];
    }
  }
  return _artwork;
}

static double finiteOr(id value, double fallback)
{
  if (![value isKindOfClass:[NSNumber class]]) {
    return fallback;
  }
  double number = [value doubleValue];
  return isfinite(number) ? number : fallback;
}

#pragma mark - API

RCT_EXPORT_METHOD(update:(NSDictionary *)info
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSString *title = [info[@"title"] isKindOfClass:[NSString class]] ? info[@"title"] : @"";
  NSString *artist = [info[@"artist"] isKindOfClass:[NSString class]] ? info[@"artist"] : @"";
  double duration = MAX(0, finiteOr(info[@"duration"], 0));
  double elapsed = MIN(MAX(0, finiteOr(info[@"elapsed"], 0)), duration);
  double rate = MAX(0, finiteOr(info[@"rate"], 0));
  BOOL playing = [info[@"playing"] boolValue];
  BOOL canSeek = [info[@"canSeek"] boolValue];
  double skip = finiteOr(info[@"skipSeconds"], 10);
  if (skip <= 0) {
    skip = 10;
  }

  [self attachCommands];
  MPRemoteCommandCenter *commands = [MPRemoteCommandCenter sharedCommandCenter];
  commands.playCommand.enabled = YES;
  commands.pauseCommand.enabled = YES;
  commands.togglePlayPauseCommand.enabled = YES;
  commands.changePlaybackPositionCommand.enabled = canSeek;
  commands.skipForwardCommand.preferredIntervals = @[ @(skip) ];
  commands.skipBackwardCommand.preferredIntervals = @[ @(skip) ];
  commands.skipForwardCommand.enabled = canSeek;
  commands.skipBackwardCommand.enabled = canSeek;

  NSMutableDictionary *nowPlaying = [NSMutableDictionary dictionary];
  nowPlaying[MPMediaItemPropertyTitle] = title;
  if (artist.length > 0) {
    nowPlaying[MPMediaItemPropertyArtist] = artist;
  }
  nowPlaying[MPMediaItemPropertyPlaybackDuration] = @(duration);
  nowPlaying[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(elapsed);
  nowPlaying[MPNowPlayingInfoPropertyPlaybackRate] = @(rate);
  nowPlaying[MPNowPlayingInfoPropertyDefaultPlaybackRate] = @(1.0);
  nowPlaying[MPNowPlayingInfoPropertyMediaType] = @(MPNowPlayingInfoMediaTypeAudio);
  MPMediaItemArtwork *artwork = [self artwork];
  if (artwork != nil) {
    nowPlaying[MPMediaItemPropertyArtwork] = artwork;
  }

  MPNowPlayingInfoCenter *center = [MPNowPlayingInfoCenter defaultCenter];
  center.nowPlayingInfo = nowPlaying;
  center.playbackState = playing ? MPNowPlayingPlaybackStatePlaying : MPNowPlayingPlaybackStatePaused;
  // The `audio` background mode keeps a playing song rendering behind the
  // Home Screen, so on iOS the answer does not depend on anything else.
  resolve(@{@"backgroundPlayback" : @YES});
}

RCT_EXPORT_METHOD(clear:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  MPNowPlayingInfoCenter *center = [MPNowPlayingInfoCenter defaultCenter];
  center.nowPlayingInfo = nil;
  center.playbackState = MPNowPlayingPlaybackStateStopped;
  [self detachCommands];
  resolve([NSNull null]);
}

/**
 * DEBUG only: run a command through the same `emit:value:` the Lock Screen's
 * targets call. The Simulator has no way to press a Lock Screen button, so
 * without this the only proof of the command path would be a human with a
 * phone. Resolves whether a listener took it.
 */
RCT_EXPORT_METHOD(debugCommand:(NSString *)command
                  value:(double)value
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
#if DEBUG
  NSSet *known = [NSSet setWithArray:@[ @"play", @"pause", @"toggle", @"seek", @"skip" ]];
  if (![known containsObject:command]) {
    reject(@"E_NOW_PLAYING_COMMAND", [NSString stringWithFormat:@"unknown command %@", command], nil);
    return;
  }
  resolve(@([self emit:command value:value] == MPRemoteCommandHandlerStatusSuccess));
#else
  reject(@"E_NOW_PLAYING_DEBUG_ONLY", @"debugCommand exists only in debug builds", nil);
#endif
}

/** DEBUG only: what the OS was actually handed, read back from the OS. */
RCT_EXPORT_METHOD(debugState:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
#if DEBUG
  MPNowPlayingInfoCenter *center = [MPNowPlayingInfoCenter defaultCenter];
  NSDictionary *info = center.nowPlayingInfo;
  MPRemoteCommandCenter *commands = [MPRemoteCommandCenter sharedCommandCenter];
  NSString *state = @"unknown";
  switch (center.playbackState) {
    case MPNowPlayingPlaybackStatePlaying: state = @"playing"; break;
    case MPNowPlayingPlaybackStatePaused: state = @"paused"; break;
    case MPNowPlayingPlaybackStateStopped: state = @"stopped"; break;
    case MPNowPlayingPlaybackStateInterrupted: state = @"interrupted"; break;
    default: break;
  }
  // @(a != b) boxes a C int and crosses the bridge as 1, not true: every
  // flag below is an explicit @YES/@NO so a driver can compare with ===.
  resolve(@{
    @"active" : info != nil ? @YES : @NO,
    @"title" : info[MPMediaItemPropertyTitle] ?: [NSNull null],
    @"artist" : info[MPMediaItemPropertyArtist] ?: [NSNull null],
    @"duration" : info[MPMediaItemPropertyPlaybackDuration] ?: [NSNull null],
    @"elapsed" : info[MPNowPlayingInfoPropertyElapsedPlaybackTime] ?: [NSNull null],
    @"rate" : info[MPNowPlayingInfoPropertyPlaybackRate] ?: [NSNull null],
    @"artwork" : info[MPMediaItemPropertyArtwork] != nil ? @YES : @NO,
    @"state" : state,
    @"listening" : _hasListeners ? @YES : @NO,
    @"backgroundPlayback" : @YES,
    @"commands" : @{
      @"play" : @(commands.playCommand.enabled),
      @"pause" : @(commands.pauseCommand.enabled),
      @"toggle" : @(commands.togglePlayPauseCommand.enabled),
      @"seek" : @(commands.changePlaybackPositionCommand.enabled),
      @"skipForward" : @(commands.skipForwardCommand.enabled),
      @"skipBackward" : @(commands.skipBackwardCommand.enabled),
      @"nextTrack" : @(commands.nextTrackCommand.enabled),
      @"previousTrack" : @(commands.previousTrackCommand.enabled),
    },
  });
#else
  reject(@"E_NOW_PLAYING_DEBUG_ONLY", @"debugState exists only in debug builds", nil);
#endif
}

// A JS reload builds a new module; the old one must not leave its targets on
// the shared command center, or a Lock Screen tap would reach a dead bridge.
// invalidate may arrive off the main thread, and the command center may not.
- (void)invalidate
{
  [super invalidate];
  dispatch_async(dispatch_get_main_queue(), ^{
    [self detachCommands];
    [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo = nil;
  });
}

@end
