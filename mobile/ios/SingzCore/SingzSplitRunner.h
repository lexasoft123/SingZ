// The iOS split-job runner (docs/PHONE-STANDALONE.md, Phase 3). iOS has no
// multi-process apps, so the job runs IN the app process on a background
// queue — the engine's streaming design keeps everything outside the ORT
// session small, and job.json carries the same contract as Android's
// JobStore: atomic + durable writes, chunksDone as the resume HINT (the
// engine's tail is the authority), a 5 s clock heartbeat while active (the
// catalog's liveness poll is platform-neutral), and DONE left behind as the
// durable handoff for the next launch's adoption.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^SingzSplitProgressBlock)(NSString *stage, double frac, int64_t done, int64_t total);
typedef void (^SingzSplitStateBlock)(NSString *state, NSString *_Nullable error);

@interface SingzSplitRunner : NSObject

+ (instancetype)shared;

/// Application Support/split-job — created on demand.
+ (NSString *)jobDirPath;

/// Parsed job.json (+ jobDir), or nil when there is none.
+ (nullable NSDictionary *)jobStatus;

/// Delete the job dir under the same lock every writer holds.
+ (void)clearJobDir;

/// Start (or resume) the one split job. Returns NO when one is already
/// running. Progress/state blocks fire on an arbitrary queue.
- (BOOL)startWithSrc:(NSString *)srcPath
               model:(NSString *)modelPath
          projectDir:(NSString *)projectDir
              resume:(BOOL)resume
       watchdogCapMs:(int64_t)watchdogCapMs
            progress:(SingzSplitProgressBlock)progress
               state:(SingzSplitStateBlock)state;

/// Flip the engine's cancel flag; the chunk in flight finishes first.
- (void)cancel;

@end

NS_ASSUME_NONNULL_END
