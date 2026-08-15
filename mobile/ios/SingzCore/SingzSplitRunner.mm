#import "SingzSplitRunner.h"

#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "progress.h"
#include "split_engine.h"

// Same six, same order, as kStemNames in split_engine.cpp (the caller owns
// the .part renames, per the engine contract).
static NSArray<NSString *> *const kStems =
    @[ @"drums", @"bass", @"other", @"vocals", @"guitar", @"piano" ];

static NSString *const kStateDecoding = @"decoding";
static NSString *const kStateSplitting = @"splitting";
static NSString *const kStateDone = @"done";
static NSString *const kStateCancelled = @"cancelled";
static NSString *const kStateFailed = @"failed";

// The engine's cancel flag, namespace-scope like Android's JNI gProgress —
// reset at every job start, safe to poke from any thread.
static singz::Progress gProgress;

#pragma mark - job.json (the Android JobStore contract, mirrored)

static NSString *JobDirPath(void) {
  NSString *base = NSSearchPathForDirectoriesInDomains(
                       NSApplicationSupportDirectory, NSUserDomainMask, YES)
                       .firstObject;
  return [base stringByAppendingPathComponent:@"split-job"];
}

static NSString *JobJsonPath(void) {
  return [JobDirPath() stringByAppendingPathComponent:@"job.json"];
}

/// All job.json access rides ONE serial queue: the worker's chunk updates,
/// the heartbeat, and the watchdog's verdict must never interleave a
/// read-copy-write (the lock-hold rule JobStore.touch learned on Android).
static dispatch_queue_t JobQueue(void) {
  static dispatch_queue_t q;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    q = dispatch_queue_create("singz.split.job", DISPATCH_QUEUE_SERIAL);
  });
  return q;
}

static NSDictionary *_Nullable ReadJobLocked(void) {
  NSData *data = [NSData dataWithContentsOfFile:JobJsonPath()];
  if (!data) return nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [parsed isKindOfClass:[NSDictionary class]] ? parsed : nil;
}

/// Atomic + durable: .part, F_FULLFSYNC (fsync alone lies on APFS), rename.
static void WriteJobLocked(NSDictionary *job) {
  NSString *dir = JobDirPath();
  [[NSFileManager defaultManager] createDirectoryAtPath:dir
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:nil];
  NSData *data = [NSJSONSerialization dataWithJSONObject:job options:0 error:nil];
  if (!data) return;
  NSString *part = [JobJsonPath() stringByAppendingString:@".part"];
  std::FILE *f = std::fopen(part.fileSystemRepresentation, "wb");
  if (!f) return;
  std::fwrite(data.bytes, 1, data.length, f);
  std::fflush(f);
  fcntl(fileno(f), F_FULLFSYNC);
  std::fclose(f);
  rename(part.fileSystemRepresentation, JobJsonPath().fileSystemRepresentation);
}

static void UpdateJobLocked(void (^mutate)(NSMutableDictionary *job)) {
  NSDictionary *cur = ReadJobLocked();
  if (!cur) return;
  NSMutableDictionary *next = [cur mutableCopy];
  mutate(next);
  next[@"updatedAtMs"] = @((int64_t)([NSDate date].timeIntervalSince1970 * 1000));
  WriteJobLocked(next);
}

#pragma mark - decode (AVAudioFile -> raw interleaved f32 at source rate)

/// The engine resamples to the graph's 44.1 kHz itself; this only has to
/// hand it honest interleaved f32 stereo. Mono duplicates; extra channels
/// beyond the first two are ignored (the Android decoder's rule).
static BOOL DecodeToRawF32Stereo(NSString *srcPath, NSString *outPath,
                                 double *outSampleRate, NSString **outError,
                                 BOOL (^cancelled)(void),
                                 void (^progress)(double frac)) {
  NSError *err = nil;
  AVAudioFile *file =
      [[AVAudioFile alloc] initForReading:[NSURL fileURLWithPath:srcPath] error:&err];
  if (!file) {
    *outError = [NSString stringWithFormat:@"Could not open this file (%@)",
                                           err.localizedDescription ?: @"unreadable"];
    return NO;
  }
  AVAudioFormat *fmt = file.processingFormat; // deinterleaved float32
  const double rate = fmt.sampleRate;
  const AVAudioChannelCount srcCh = fmt.channelCount;
  if (rate <= 0 || srcCh < 1) {
    *outError = @"No audio in this file";
    return NO;
  }
  const AVAudioFrameCount block = 1 << 16;
  AVAudioPCMBuffer *buf = [[AVAudioPCMBuffer alloc] initWithPCMFormat:fmt
                                                        frameCapacity:block];
  std::FILE *out = std::fopen(outPath.fileSystemRepresentation, "wb");
  if (!out) {
    *outError = @"Could not write the decoded audio";
    return NO;
  }
  const int64_t totalFrames = (int64_t)file.length;
  int64_t doneFrames = 0;
  std::vector<float> inter;
  BOOL ok = YES;
  // Stop at file.length: AVAudioFile THROWS ("nilError") when read at EOF
  // rather than handing back an empty buffer — measured on a plain PCM16
  // WAV, 1,799,280 frames then a throw, never a zero-length read.
  while (file.framePosition < totalFrames) {
    if (cancelled()) {
      *outError = @"cancelled";
      ok = NO;
      break;
    }
    if (![file readIntoBuffer:buf error:&err]) {
      *outError = [NSString stringWithFormat:@"Decode failed (%@)",
                                             err.localizedDescription ?: @"unknown"];
      ok = NO;
      break;
    }
    const AVAudioFrameCount n = buf.frameLength;
    if (n == 0) break; // defensive: no progress means we are done
    float *const *ch = buf.floatChannelData;
    inter.resize((size_t)n * 2);
    const float *l = ch[0];
    const float *r = srcCh >= 2 ? ch[1] : ch[0];
    for (AVAudioFrameCount i = 0; i < n; i++) {
      inter[(size_t)i * 2] = l[i];
      inter[(size_t)i * 2 + 1] = r[i];
    }
    if (std::fwrite(inter.data(), sizeof(float), inter.size(), out) != inter.size()) {
      *outError = @"Ran out of space writing the decoded audio";
      ok = NO;
      break;
    }
    doneFrames += n;
    if (totalFrames > 0) progress(MIN(1.0, (double)doneFrames / (double)totalFrames));
  }
  if (ok && doneFrames == 0) {
    *outError = @"No audio in this file";
    ok = NO;
  }
  if (ok) {
    std::fflush(out);
    fcntl(fileno(out), F_FULLFSYNC); // "decoded" must mean bytes on disk
  }
  std::fclose(out);
  if (!ok) std::remove(outPath.fileSystemRepresentation);
  *outSampleRate = rate;
  return ok;
}

#pragma mark - runner

@implementation SingzSplitRunner {
  dispatch_queue_t _work;
  dispatch_source_t _heartbeat;
  dispatch_source_t _watchdog;
  std::atomic<bool> _active;
  std::atomic<bool> _cancelRequested;
  int64_t _firstCapMs;
  // Chunk-pace history for the 8x-median rule, worker-thread only.
  std::vector<int64_t> _chunkDurations;
  int64_t _lastChunkAtMs;
  SingzSplitProgressBlock _progress;
  SingzSplitStateBlock _state;
  id _becameActiveObserver;
  id _resignActiveObserver;
  // Suspension signal for the watchdog: resign ALWAYS precedes the freeze,
  // so "did a resign happen since this timer was armed" is order-independent
  // — unlike anything read on wake, where timer order is a coin toss.
  std::atomic<int64_t> _lastResignMs;
}

+ (instancetype)shared {
  static SingzSplitRunner *r;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ r = [[SingzSplitRunner alloc] init]; });
  return r;
}

+ (NSString *)jobDirPath {
  return JobDirPath();
}

+ (void)clearJobDir {
  dispatch_sync(JobQueue(), ^{
    [[NSFileManager defaultManager] removeItemAtPath:JobDirPath() error:nil];
  });
}

+ (NSDictionary *)jobStatus {
  __block NSDictionary *out = nil;
  dispatch_sync(JobQueue(), ^{
    NSDictionary *job = ReadJobLocked();
    if (job) {
      NSMutableDictionary *m = [job mutableCopy];
      m[@"jobDir"] = JobDirPath();
      out = m;
    }
  });
  return out;
}

- (instancetype)init {
  if ((self = [super init])) {
    _work = dispatch_queue_create("singz.split.work", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)cancel {
  _cancelRequested = true;
  gProgress.cancel.store(true);
}

- (BOOL)startWithSrc:(NSString *)srcPath
               model:(NSString *)modelPath
          projectDir:(NSString *)projectDir
              resume:(BOOL)resume
       watchdogCapMs:(int64_t)watchdogCapMs
            progress:(SingzSplitProgressBlock)progress
               state:(SingzSplitStateBlock)state {
  bool expected = false;
  if (!_active.compare_exchange_strong(expected, true)) return NO;
  _cancelRequested = false;
  _progress = [progress copy];
  _state = [state copy];
  _firstCapMs = watchdogCapMs > 0 ? watchdogCapMs : 5 * 60'000;
  // The screen stays up while the phone works for the singer (P3a is
  // foreground-only; BGContinuedProcessingTask is the next slice).
  dispatch_async(dispatch_get_main_queue(), ^{
    [UIApplication sharedApplication].idleTimerDisabled = YES;
  });
  // Push the watchdog deadline out on every return to foreground — timers
  // expire while the app is suspended, and an expired timer firing on
  // resume must not read as a stall.
  __weak SingzSplitRunner *weakSelf = self;
  _lastResignMs = 0;
  _becameActiveObserver = [[NSNotificationCenter defaultCenter]
      addObserverForName:UIApplicationDidBecomeActiveNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *note) {
                SingzSplitRunner *s = weakSelf;
                if (s && s->_active.load()) [s armWatchdog:s->_firstCapMs];
              }];
  _resignActiveObserver = [[NSNotificationCenter defaultCenter]
      addObserverForName:UIApplicationWillResignActiveNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *note) {
                SingzSplitRunner *s = weakSelf;
                if (s) {
                  s->_lastResignMs.store(
                      (int64_t)([NSDate date].timeIntervalSince1970 * 1000));
                }
              }];
  dispatch_async(_work, ^{ [self runJobSrc:srcPath model:modelPath projectDir:projectDir resume:resume]; });
  return YES;
}

- (void)runJobSrc:(NSString *)src
            model:(NSString *)model
       projectDir:(NSString *)projectDir
           resume:(BOOL)resume {
  NSString *dir = JobDirPath();
  NSString *mixPath = [dir stringByAppendingPathComponent:@"mix.raw"];
  NSFileManager *fm = [NSFileManager defaultManager];
  @try {
    __block NSDictionary *prev = nil;
    dispatch_sync(JobQueue(), ^{ prev = ReadJobLocked(); });
    NSDictionary *attrs = [fm attributesOfItemAtPath:mixPath error:nil];
    const BOOL canResume = resume && prev != nil &&
        [prev[@"srcPath"] isEqual:src] && [prev[@"srcRate"] intValue] > 0 &&
        [attrs fileSize] > 0 &&
        ([prev[@"state"] isEqual:kStateSplitting] || [prev[@"state"] isEqual:kStateFailed]);

    int srcRate;
    int64_t resumeHint = 0;
    void (^removeJobDirLocked)(void) = ^{
      dispatch_sync(JobQueue(), ^{ [fm removeItemAtPath:dir error:nil]; });
    };
    if (canResume) {
      srcRate = [prev[@"srcRate"] intValue];
      resumeHint = [prev[@"chunksDone"] longLongValue];
      dispatch_sync(JobQueue(), ^{
        UpdateJobLocked(^(NSMutableDictionary *job) {
          job[@"state"] = kStateSplitting;
          [job removeObjectForKey:@"error"];
          // the intent of THIS run names what produces the stems
          job[@"modelPath"] = model;
          job[@"projectDir"] = projectDir;
        });
      });
    } else {
      removeJobDirLocked();
      dispatch_sync(JobQueue(), ^{
        WriteJobLocked(@{
          @"version" : @1,
          @"state" : kStateDecoding,
          @"srcPath" : src,
          @"projectDir" : projectDir,
          @"modelPath" : model,
          @"srcRate" : @0,
          @"chunksDone" : @0,
          @"totalChunks" : @0,
          @"updatedAtMs" : @((int64_t)([NSDate date].timeIntervalSince1970 * 1000)),
        });
      });
      [self armWatchdog:_firstCapMs];
      [self startHeartbeat];
      double rate = 0;
      NSString *decodeErr = nil;
      __block int64_t lastPumpMs = 0;
      const BOOL ok = DecodeToRawF32Stereo(
          src, mixPath, &rate, &decodeErr,
          ^BOOL { return self->_cancelRequested.load(); },
          ^(double frac) {
            // each tick re-arms: total decode time is uncapped, a hang is not
            [self armWatchdog:self->_firstCapMs];
            const int64_t now = (int64_t)([NSDate date].timeIntervalSince1970 * 1000);
            if (now - lastPumpMs > 250) {
              lastPumpMs = now;
              self->_progress(@"decode", frac, 0, 0);
            }
          });
      if (!ok) {
        if (self->_cancelRequested.load() || [decodeErr isEqualToString:@"cancelled"]) {
          removeJobDirLocked();
          [self finishWithState:kStateCancelled error:nil keepDoc:NO];
        } else {
          [self finishWithState:kStateFailed error:decodeErr keepDoc:YES];
        }
        return;
      }
      srcRate = (int)llround(rate);
      dispatch_sync(JobQueue(), ^{
        UpdateJobLocked(^(NSMutableDictionary *job) {
          job[@"state"] = kStateSplitting;
          job[@"srcRate"] = @(srcRate);
        });
      });
    }

    // A cancel that raced the setup set only our flag — honor it now
    // (runSplit resets the engine flag at entry).
    if (self->_cancelRequested.load()) {
      removeJobDirLocked();
      [self finishWithState:kStateCancelled error:nil keepDoc:NO];
      return;
    }

    [self armWatchdog:_firstCapMs];
    [self startHeartbeat];
    _chunkDurations.clear();
    _lastChunkAtMs = (int64_t)([NSDate date].timeIntervalSince1970 * 1000);

    __block SingzSplitRunner *runner = self;
    singz::SplitJobConfig config;
    config.modelPath = std::string(model.UTF8String);
    config.mixPcmPath = std::string(mixPath.UTF8String);
    config.jobDir = std::string(dir.UTF8String);
    config.srcRate = srcRate;
    config.resumeChunk = resumeHint;
    config.onChunkUser = (__bridge void *)runner;
    config.onChunkDone = [](void *user, int64_t done, int64_t total) {
      SingzSplitRunner *r = (__bridge SingzSplitRunner *)user;
      [r onChunk:done total:total];
    };

    gProgress.cancel.store(_cancelRequested.load());
    gProgress.cb = [](void *user, const char *stage, float frac) {
      SingzSplitRunner *r = (__bridge SingzSplitRunner *)user;
      [r onStage:[NSString stringWithUTF8String:stage] frac:frac];
    };
    gProgress.user = (__bridge void *)runner;

    std::string errorOut;
    const singz::SplitResult result =
        singz::runSplit(config, gProgress, errorOut);
    gProgress.cb = nullptr;
    gProgress.user = nullptr;
    [self disarmWatchdog];

    if (result == singz::SplitResult::ok) {
      for (NSString *stem in kStems) {
        NSString *part =
            [dir stringByAppendingPathComponent:[stem stringByAppendingString:@".wav.part"]];
        NSString *final =
            [dir stringByAppendingPathComponent:[stem stringByAppendingString:@".wav"]];
        [fm removeItemAtPath:final error:nil];
        NSError *err = nil;
        if (![fm moveItemAtPath:part toPath:final error:&err]) {
          [self finishWithState:kStateFailed
                          error:[NSString stringWithFormat:@"could not finalize %@.wav", stem]
                        keepDoc:YES];
          return;
        }
      }
      [self finishWithState:kStateDone error:nil keepDoc:YES];
    } else if (result == singz::SplitResult::cancelled) {
      removeJobDirLocked();
      [self finishWithState:kStateCancelled error:nil keepDoc:NO];
    } else {
      [self finishWithState:kStateFailed
                      error:[NSString stringWithUTF8String:errorOut.c_str()]
                    keepDoc:YES];
    }
  } @catch (NSException *e) {
    [self finishWithState:kStateFailed error:e.reason ?: @"split crashed" keepDoc:YES];
  }
}

- (void)onStage:(NSString *)stage frac:(float)frac {
  if (_cancelRequested.load()) gProgress.cancel.store(true);
  _progress(stage, frac, 0, 0);
}

- (void)onChunk:(int64_t)done total:(int64_t)total {
  if (_cancelRequested.load()) gProgress.cancel.store(true);
  const int64_t now = (int64_t)([NSDate date].timeIntervalSince1970 * 1000);
  _chunkDurations.push_back(now - _lastChunkAtMs);
  _lastChunkAtMs = now;
  if (_chunkDurations.size() > 5) _chunkDurations.erase(_chunkDurations.begin());
  std::vector<int64_t> sorted = _chunkDurations;
  std::sort(sorted.begin(), sorted.end());
  const int64_t median = sorted[sorted.size() / 2];
  [self armWatchdog:MAX((int64_t)30'000, median * 8)];
  dispatch_sync(JobQueue(), ^{
    UpdateJobLocked(^(NSMutableDictionary *job) {
      job[@"chunksDone"] = @(done);
      job[@"totalChunks"] = @(total);
    });
  });
  _progress(@"chunk", total > 0 ? (double)done / (double)total : 0, done, total);
}

- (void)finishWithState:(NSString *)state error:(NSString *_Nullable)error keepDoc:(BOOL)keepDoc {
  [self disarmWatchdog];
  [self stopHeartbeat];
  if (keepDoc) {
    dispatch_sync(JobQueue(), ^{
      UpdateJobLocked(^(NSMutableDictionary *job) {
        job[@"state"] = state;
        if (error) job[@"error"] = error;
        else [job removeObjectForKey:@"error"];
      });
    });
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    [UIApplication sharedApplication].idleTimerDisabled = NO;
  });
  if (_becameActiveObserver) {
    [[NSNotificationCenter defaultCenter] removeObserver:_becameActiveObserver];
    _becameActiveObserver = nil;
  }
  if (_resignActiveObserver) {
    [[NSNotificationCenter defaultCenter] removeObserver:_resignActiveObserver];
    _resignActiveObserver = nil;
  }
  _active = false;
  SingzSplitStateBlock cb = _state;
  if (cb) cb(state, error);
}

#pragma mark - heartbeat + watchdog

/// The file's pulse is the cross-process… here, cross-LAUNCH truth: a 5 s
/// clock tick bumping updatedAtMs while the job is genuinely active, so a
/// relaunch after a jetsam kill reads a frozen file and says "interrupted"
/// instead of showing progress forever (the Android lesson, kept).
- (void)startHeartbeat {
  if (_heartbeat) return;
  _heartbeat = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, JobQueue());
  dispatch_source_set_timer(_heartbeat, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC),
                            5 * NSEC_PER_SEC, NSEC_PER_SEC / 2);
  dispatch_source_set_event_handler(_heartbeat, ^{
    NSDictionary *cur = ReadJobLocked();
    NSString *s = cur[@"state"];
    if ([s isEqual:kStateDecoding] || [s isEqual:kStateSplitting]) {
      UpdateJobLocked(^(NSMutableDictionary *job){ /* updatedAtMs bump */ });
    }
  });
  dispatch_resume(_heartbeat);
}

- (void)stopHeartbeat {
  if (_heartbeat) {
    dispatch_source_cancel(_heartbeat);
    _heartbeat = nil;
  }
}

/// ORT's Run() cannot be interrupted, and unlike Android there is no :split
/// process to shoot — a stall persists an honest verdict and the wedged
/// thread stays wedged (the app survives; a restart clears it, and the tail
/// makes the next start a resume).
- (void)armWatchdog:(int64_t)ms {
  dispatch_async(JobQueue(), ^{
    if (self->_watchdog) {
      dispatch_source_cancel(self->_watchdog);
      self->_watchdog = nil;
    }
    dispatch_source_t t = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, JobQueue());
    dispatch_source_set_timer(t, dispatch_time(DISPATCH_TIME_NOW, ms * NSEC_PER_MSEC),
                              DISPATCH_TIME_FOREVER, NSEC_PER_SEC / 2);
    const int64_t armedAtMs = (int64_t)([NSDate date].timeIntervalSince1970 * 1000);
    dispatch_source_set_event_handler(t, ^{
      // Suspension guard: with no background task (P3a), timers expire while
      // the app is frozen and GCD fires them on resume — a >30 s app switch
      // must not read as a stall. The signal is a RESIGN since this timer
      // was armed (resign always precedes the freeze); refuse once and
      // re-arm — a genuinely wedged worker then fires on the NEXT expiry,
      // one cap later, with no further resigns to excuse it. The heartbeat
      // is deliberately NOT consulted: it is a clock proving process
      // liveness and stamps straight through a wedged ORT thread.
      if (self->_lastResignMs.load() >= armedAtMs) {
        [self armWatchdog:self->_firstCapMs];
        return;
      }
      UpdateJobLocked(^(NSMutableDictionary *job) {
        job[@"state"] = kStateFailed;
        job[@"error"] = @"Splitting stalled — resume to try again";
      });
      [self stopHeartbeat];
      // _active stays TRUE on purpose: the wedged ORT thread still owns the
      // serial work queue, so a mid-session Resume could only queue a second
      // job behind it — worst case wiping six finished stems if the "stall"
      // was merely slow. Busy until restart is the honest answer, and the
      // restart resumes from the tail.
      SingzSplitStateBlock cb = self->_state;
      if (cb) cb(kStateFailed, @"stalled");
    });
    dispatch_resume(t);
    self->_watchdog = t;
  });
}

- (void)disarmWatchdog {
  dispatch_async(JobQueue(), ^{
    if (self->_watchdog) {
      dispatch_source_cancel(self->_watchdog);
      self->_watchdog = nil;
    }
  });
}

@end
