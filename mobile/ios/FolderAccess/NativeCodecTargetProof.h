#import <React/RCTBridgeModule.h>

// Test-build-only codec execution evidence. Normal Pod installs do not
// compile the runner or package its fixture corpus.
void SingzRunCodecTargetProof(RCTPromiseResolveBlock resolve,
                              RCTPromiseRejectBlock reject);
