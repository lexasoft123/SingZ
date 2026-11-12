//! Shaped-line and glow-band caches for the lyric canvas (C-72 a1).
//!
//! Lyric paint asks for the same (text, colour, scale) shapes every frame. The
//! old cache keyed a `HashMap` by an owned `String`, so every lookup, hit or
//! miss, allocated. Here the outer map is keyed by the word text and looked up
//! as `&str`, and the inner map by the plain (colour, scale) bits, so a hit
//! allocates nothing. Both caches are bounded and cleared on project change.
use crate::gpui::{Font, Hsla, RenderImage, ShapedLine, TextRun, Window, px};
use std::{
    collections::HashMap,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

/// Upper bound on cached shaped lines. A fully played 800-word song needs about
/// 15 per word (three inactive/measure shapes, the active amber layer and the
/// twelve feather slices); past the bound the cache starts over rather than
/// growing without limit.
const MAX_SHAPES: usize = 24_576;
/// Glow band sets held here are shared `Arc`s from `project_lyrics::GlowCache`,
/// which keeps at most 32 words and 32 MB. This memo only avoids cloning the
/// band vector every frame, so it holds fewer words than that cache does and
/// adds at most the images of those words when the cache has moved on.
const MAX_GLOW_WORDS: usize = 24;

static SHAPE_MISSES: AtomicU64 = AtomicU64::new(0);
static ADVANCING_WORDS: AtomicU64 = AtomicU64::new(0);
static GLOW_DRAWS: AtomicU64 = AtomicU64::new(0);
static COUNTDOWN_PAINTS: AtomicU64 = AtomicU64::new(0);
static COUNTDOWN_REQUESTS: AtomicU64 = AtomicU64::new(0);

/// One advancing (partially filled) word painted this frame.
pub(crate) fn note_advancing_word() {
    ADVANCING_WORDS.fetch_add(1, Ordering::Relaxed);
}
/// One successful advancing-halo image draw (12 per advancing word).
pub(crate) fn note_glow_draw() {
    GLOW_DRAWS.fetch_add(1, Ordering::Relaxed);
}
/// One countdown sprite painted.
pub(crate) fn note_countdown_paint() {
    COUNTDOWN_PAINTS.fetch_add(1, Ordering::Relaxed);
}
/// (advancing words, glow draws, countdown sprites painted, UIKit sprite requests) since launch.
#[cfg(feature = "ui-tests")]
pub(crate) fn paint_counts() -> (u64, u64, u64, u64) {
    (
        ADVANCING_WORDS.load(Ordering::Relaxed),
        GLOW_DRAWS.load(Ordering::Relaxed),
        COUNTDOWN_PAINTS.load(Ordering::Relaxed),
        COUNTDOWN_REQUESTS.load(Ordering::Relaxed),
    )
}

/// Lyric shape-cache misses since launch (test counter).
#[cfg(feature = "ui-tests")]
pub(crate) fn shape_misses() -> u64 {
    SHAPE_MISSES.load(Ordering::Relaxed)
}

type Variant = ([u32; 4], u32);

#[derive(Default)]
pub(crate) struct ShapeCache {
    words: HashMap<String, HashMap<Variant, ShapedLine>>,
    entries: usize,
    bands: HashMap<String, Rc<Vec<Arc<RenderImage>>>>,
    /// Countdown caption sprites already prepared, by caption then (tracking, scale).
    sprites: HashMap<String, Vec<(u32, u32, Arc<singz_uikit::LyricCountdownSprite>)>>,
}

/// UIKit keeps at most 16 caption sprites; so does this memo.
const MAX_SPRITES: usize = 16;

impl ShapeCache {
    pub fn clear(&mut self) {
        self.words.clear();
        self.entries = 0;
        self.bands.clear();
        self.sprites.clear();
    }

    /// The prepared sprite for a countdown caption. `request_lyric_countdown_sprite`
    /// builds an owned key on every call, so a prepared sprite is retained here and
    /// only a caption that is not ready yet goes back to UIKit.
    pub fn countdown_sprite(
        &mut self,
        text: &str,
        tracking: f32,
        window: &mut Window,
        cx: &mut crate::gpui::App,
    ) -> Option<Arc<singz_uikit::LyricCountdownSprite>> {
        let (tracking, scale) = (tracking.to_bits(), window.scale_factor().to_bits());
        if let Some(found) = self
            .sprites
            .get(text)
            .and_then(|list| list.iter().find(|entry| entry.0 == tracking && entry.1 == scale))
        {
            return Some(found.2.clone());
        }
        COUNTDOWN_REQUESTS.fetch_add(1, Ordering::Relaxed);
        let sprite = singz_uikit::request_lyric_countdown_sprite(text, f32::from_bits(tracking), window, cx)?;
        if self.sprites.values().map(Vec::len).sum::<usize>() >= MAX_SPRITES {
            self.sprites.clear();
        }
        self.sprites.entry(text.to_owned()).or_default().push((tracking, scale, sprite.clone()));
        Some(sprite)
    }

    #[cfg(any(test, feature = "ui-tests"))]
    pub fn len(&self) -> usize {
        self.entries
    }

    /// The shaped line for `text` in `color` at `scale`; shapes once per key.
    pub fn shape(&mut self, text: &str, color: Hsla, scale: f32, window: &Window) -> ShapedLine {
        let variant = (
            [color.h.to_bits(), color.s.to_bits(), color.l.to_bits(), color.a.to_bits()],
            scale.to_bits(),
        );
        if let Some(line) = self.words.get(text).and_then(|variants| variants.get(&variant)) {
            return line.clone();
        }
        SHAPE_MISSES.fetch_add(1, Ordering::Relaxed);
        if self.entries >= MAX_SHAPES {
            self.words.clear();
            self.entries = 0;
        }
        let line = window.text_system().shape_line(
            text.to_string().into(),
            px(17.5 * scale),
            &[TextRun {
                len: text.len(),
                font: Font { family: "SingZ Display 650".into(), ..Default::default() },
                color,
                background_color: None,
                underline: None,
                strikethrough: None,
            }],
            None,
        );
        self.entries += 1;
        self.words.entry(text.to_owned()).or_default().insert(variant, line.clone());
        line
    }

    /// The glow bands for `text`, baked by `bake` on first use. The baked
    /// vector is shared, so a hit clones one `Rc`, not the vector.
    pub fn glow_bands(
        &mut self,
        text: &str,
        bake: impl FnOnce() -> Vec<Arc<RenderImage>>,
    ) -> Rc<Vec<Arc<RenderImage>>> {
        if let Some(bands) = self.bands.get(text) {
            return bands.clone();
        }
        if self.bands.len() >= MAX_GLOW_WORDS {
            self.bands.clear();
        }
        let bands = Rc::new(bake());
        self.bands.insert(text.to_owned(), bands.clone());
        bands
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bands() -> Vec<Arc<RenderImage>> {
        vec![Arc::new(RenderImage::new(vec![image::Frame::new(image::RgbaImage::new(1, 1))]))]
    }

    #[test]
    fn glow_bands_are_baked_once_and_shared() {
        let mut cache = ShapeCache::default();
        let mut baked = 0;
        let first = cache.glow_bands("word", || { baked += 1; bands() });
        let second = cache.glow_bands("word", || { baked += 1; bands() });
        assert_eq!(baked, 1, "a hit must not bake again");
        assert!(Rc::ptr_eq(&first, &second), "a hit shares the baked vector instead of cloning it");
    }

    #[test]
    fn glow_bands_stay_bounded_and_clear_with_the_project() {
        let mut cache = ShapeCache::default();
        for word in 0..MAX_GLOW_WORDS * 4 {
            cache.glow_bands(&format!("word{word}"), bands);
            assert!(cache.bands.len() <= MAX_GLOW_WORDS);
        }
        cache.clear();
        assert!(cache.bands.is_empty() && cache.len() == 0);
    }
}
