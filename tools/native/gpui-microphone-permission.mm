#import <AVFoundation/AVFoundation.h>
#import <dispatch/dispatch.h>
// Passive probes never prompt. Requests are only made after a user action.
const char* gpuiMicrophonePermission(bool request) {
  @autoreleasepool {
    auto status=[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if(status==AVAuthorizationStatusNotDetermined && request){
      dispatch_semaphore_t ready=dispatch_semaphore_create(0);
      [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL){dispatch_semaphore_signal(ready);}];
      if(dispatch_semaphore_wait(ready,dispatch_time(DISPATCH_TIME_NOW,120LL*NSEC_PER_SEC))!=0)return "timeout";
      status=[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    }
    switch(status){case AVAuthorizationStatusAuthorized:return "granted";case AVAuthorizationStatusDenied:return "denied";case AVAuthorizationStatusRestricted:return "restricted";default:return "required";}
  }
}
