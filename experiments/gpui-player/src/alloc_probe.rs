//! Test-only heap-allocation probe for paint code that must not allocate per
//! frame. `scope` counts lane and playhead paint, `scope_text` lyric and pitch
//! paint, each against its own counter. Outside `ui-tests` builds both are
//! plain calls and no allocator is installed.

#[cfg(feature = "ui-tests")]
mod imp {
    use std::{
        alloc::{GlobalAlloc, Layout, System},
        cell::Cell,
        sync::atomic::{AtomicU64, Ordering},
    };

    thread_local! {
        static ACTIVE: Cell<u32> = const { Cell::new(0) };
        static ACTIVE_TEXT: Cell<u32> = const { Cell::new(0) };
        static ACTIVE_PITCH: Cell<u32> = const { Cell::new(0) };
        static ACTIVE_EXEMPT: Cell<u32> = const { Cell::new(0) };
        static ACTIVE_ANIMATION: Cell<u32> = const { Cell::new(0) };
    }
    static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
    static TEXT_ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
    static PITCH_ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
    static EXEMPT_ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
    static ANIMATION_ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
    static LYRIC_PAINTS: AtomicU64 = AtomicU64::new(0);
    static PITCH_PAINTS: AtomicU64 = AtomicU64::new(0);

    fn record() {
        if ACTIVE.try_with(|active| active.get() > 0).unwrap_or(false) {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        }
        if ACTIVE_ANIMATION.try_with(|active| active.get() > 0).unwrap_or(false) {
            ANIMATION_ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if ACTIVE_EXEMPT.try_with(|active| active.get() > 0).unwrap_or(false) {
            // Inside a call into GPUI that allocates by design; counted apart.
            EXEMPT_ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if ACTIVE_TEXT.try_with(|active| active.get() > 0).unwrap_or(false) {
            TEXT_ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        }
        if ACTIVE_PITCH.try_with(|active| active.get() > 0).unwrap_or(false) {
            PITCH_ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        }
    }

    struct Counting;

    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            record();
            unsafe { System.alloc(layout) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) }
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            record();
            unsafe { System.realloc(ptr, layout, new_size) }
        }
    }

    #[global_allocator]
    static ALLOCATOR: Counting = Counting;

    /// Restores the nesting depth even if the measured code panics.
    struct Guard(&'static std::thread::LocalKey<Cell<u32>>);
    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = self.0.try_with(|active| active.set(active.get().saturating_sub(1)));
        }
    }

    fn enter<R>(counter: &'static std::thread::LocalKey<Cell<u32>>, f: impl FnOnce() -> R) -> R {
        counter.with(|active| active.set(active.get() + 1));
        let _guard = Guard(counter);
        f()
    }

    pub fn scope<R>(f: impl FnOnce() -> R) -> R {
        enter(&ACTIVE, f)
    }

    /// Lyric canvas paint; each call is one counted paint.
    pub fn scope_text<R>(f: impl FnOnce() -> R) -> R {
        LYRIC_PAINTS.fetch_add(1, Ordering::Relaxed);
        enter(&ACTIVE_TEXT, f)
    }

    /// A GPUI animation-frame request (boxes a callback by design); counted apart.
    pub fn exempt_animation<R>(f: impl FnOnce() -> R) -> R {
        enter(&ACTIVE_ANIMATION, f)
    }

    pub fn animation_count() -> u64 {
        ANIMATION_ALLOCATIONS.load(Ordering::Relaxed)
    }

    pub fn lyric_paints() -> u64 {
        LYRIC_PAINTS.load(Ordering::Relaxed)
    }

    pub fn pitch_paints() -> u64 {
        PITCH_PAINTS.load(Ordering::Relaxed)
    }

    /// Pitch paint, which also counts toward `scope_text`; lets a report tell the two apart.
    pub fn scope_pitch<R>(f: impl FnOnce() -> R) -> R {
        PITCH_PAINTS.fetch_add(1, Ordering::Relaxed);
        enter(&ACTIVE_PITCH, || enter(&ACTIVE_TEXT, f))
    }

    /// A call into GPUI that allocates inside the engine (`Window::paint_path` clones
    /// and scales the path's vertices). Its allocations are counted by `exempt_count`
    /// instead of the surrounding text scope, so the report shows them rather than hides them.
    pub fn exempt<R>(f: impl FnOnce() -> R) -> R {
        enter(&ACTIVE_EXEMPT, f)
    }

    pub fn exempt_count() -> u64 {
        EXEMPT_ALLOCATIONS.load(Ordering::Relaxed)
    }

    pub fn pitch_count() -> u64 {
        PITCH_ALLOCATIONS.load(Ordering::Relaxed)
    }

    pub fn count() -> u64 {
        ALLOCATIONS.load(Ordering::Relaxed)
    }

    pub fn text_count() -> u64 {
        TEXT_ALLOCATIONS.load(Ordering::Relaxed)
    }
}

#[cfg(feature = "ui-tests")]
pub use imp::{
    animation_count, count, exempt, exempt_animation, exempt_count, lyric_paints, pitch_count, pitch_paints, scope,
    scope_pitch, scope_text, text_count,
};

#[cfg(not(feature = "ui-tests"))]
#[inline(always)]
pub fn scope<R>(f: impl FnOnce() -> R) -> R {
    f()
}

#[cfg(not(feature = "ui-tests"))]
#[inline(always)]
pub fn scope_text<R>(f: impl FnOnce() -> R) -> R {
    f()
}

#[cfg(not(feature = "ui-tests"))]
#[inline(always)]
pub fn scope_pitch<R>(f: impl FnOnce() -> R) -> R {
    f()
}

#[cfg(not(feature = "ui-tests"))]
#[inline(always)]
pub fn exempt<R>(f: impl FnOnce() -> R) -> R {
    f()
}

#[cfg(not(feature = "ui-tests"))]
#[inline(always)]
pub fn exempt_animation<R>(f: impl FnOnce() -> R) -> R {
    f()
}
