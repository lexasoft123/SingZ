//! Match the production `-webkit-font-smoothing: antialiased` text policy.
//! GPUI otherwise adds macOS foreground-dependent stroke dilation.

/// Install a process-local preference before GPUI's first text lookup.
/// NSArgumentDomain is a volatile dictionary, so this never changes the user's
/// defaults or global AppleFontSmoothing setting. Preserve all other arguments.
#[cfg(target_os = "macos")]
pub fn configure() {
    use objc2_foundation::{
        NSArgumentDomain, NSMutableCopying, NSNumber, NSUserDefaults, ns_string,
    };
    let defaults = NSUserDefaults::standardUserDefaults();
    // SAFETY: NSArgumentDomain is Foundation's immortal NSString constant.
    let name = unsafe { NSArgumentDomain };
    let arguments = defaults.volatileDomainForName(name).mutableCopy();
    let zero = NSNumber::new_i32(0);
    arguments.insert(ns_string!("AppleFontSmoothing"), &zero);
    // SAFETY: NSMutableDictionary retains the NSString keys and NSObject
    // values, preserving the exact generics returned by volatileDomainForName.
    unsafe { defaults.setVolatileDomain_forName(&arguments, name) };
    // Read through the exact CoreFoundation entry point used by GPUI, before
    // application construction can initialize its font-smoothing OnceLock.
    use core_foundation_sys::{
        base::CFGetTypeID,
        base::CFRelease,
        number::{CFNumberGetTypeID, CFNumberGetValue, kCFNumberSInt64Type},
        preferences::{CFPreferencesCopyAppValue, kCFPreferencesCurrentApplication},
    };
    let key = ns_string!("AppleFontSmoothing");
    let mut actual = -1_i64;
    // SAFETY: NSString/CFString are toll-free bridged; Copy returns an owned
    // CF object, checked as a number before conversion, and released below.
    unsafe {
        let value = CFPreferencesCopyAppValue(
            (key as *const objc2_foundation::NSString).cast(),
            kCFPreferencesCurrentApplication,
        );
        assert!(
            !value.is_null(),
            "process font-smoothing override is missing"
        );
        let valid = CFGetTypeID(value) == CFNumberGetTypeID()
            && CFNumberGetValue(
                value.cast(),
                kCFNumberSInt64Type,
                (&mut actual as *mut i64).cast(),
            );
        CFRelease(value);
        assert!(
            valid && actual == 0,
            "GPUI font-smoothing lookup did not resolve to zero"
        );
    }
    eprintln!(
        "TEXT_RENDERING AppleFontSmoothing={actual}; volatile process domain; before GPUI application"
    );
}

#[cfg(not(target_os = "macos"))]
pub fn configure() {}
