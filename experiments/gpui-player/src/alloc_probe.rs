//! Test-only heap-allocation probe for paint code that must not allocate per
//! frame (lane and playhead paint). Outside `ui-tests` builds `scope` is a
//! plain call and no allocator is installed.

#[cfg(feature = "ui-tests")]
mod imp {
    use std::{
        alloc::{GlobalAlloc, Layout, System},
        cell::Cell,
        sync::atomic::{AtomicU64, Ordering},
    };

    thread_local! { static ACTIVE: Cell<u32> = const { Cell::new(0) }; }
    static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);

    struct Counting;

    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            if ACTIVE.try_with(|active| active.get() > 0).unwrap_or(false) {
                ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            }
            unsafe { System.alloc(layout) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) }
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            if ACTIVE.try_with(|active| active.get() > 0).unwrap_or(false) {
                ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            }
            unsafe { System.realloc(ptr, layout, new_size) }
        }
    }

    #[global_allocator]
    static ALLOCATOR: Counting = Counting;

    pub fn scope<R>(f: impl FnOnce() -> R) -> R {
        ACTIVE.with(|active| active.set(active.get() + 1));
        let result = f();
        ACTIVE.with(|active| active.set(active.get() - 1));
        result
    }

    pub fn count() -> u64 {
        ALLOCATIONS.load(Ordering::Relaxed)
    }
}

#[cfg(feature = "ui-tests")]
pub use imp::{count, scope};

#[cfg(not(feature = "ui-tests"))]
#[inline(always)]
pub fn scope<R>(f: impl FnOnce() -> R) -> R {
    f()
}
