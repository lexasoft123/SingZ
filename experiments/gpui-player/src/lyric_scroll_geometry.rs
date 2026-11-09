//! Horizontal overflow for the host's manually painted lyric paragraphs.
//!
//! Union the paragraph box and overflowing shaped words, then keep the body's
//! trailing padding. The active transform also scales the full paragraph box,
//! so short active lines can still overflow.

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Geometry {
    pub viewport_width: f32,
    pub content_width: f32,
}

impl Geometry {
    pub fn new(viewport_width: f32) -> Self {
        Self { viewport_width, content_width: viewport_width }
    }

    pub fn add_paragraph(&mut self, scale: f32, words: impl Iterator<Item = (f32, f32)>) {
        let paragraph_width = (self.viewport_width - 12.).max(0.);
        let mut right = 6. + paragraph_width * scale;
        for (x, width) in words {
            // Paragraph padding is already in its box above. An overflowing
            // inline word contributes its painted right, not another 14px pad.
            right = right.max(6. + (14. + x + width) * scale);
        }
        let content_width = right + 6.;
        // Avoid manufacturing overflow from rounding an untransformed box.
        if content_width > self.viewport_width + 0.001 {
            self.content_width = self.content_width.max(content_width.ceil());
        }
    }

    pub fn max_offset(self) -> f32 {
        (self.content_width - self.viewport_width).max(0.)
    }

    pub fn overflows(self) -> bool {
        self.max_offset() > 0.
    }

    pub fn clamp_offset(self, offset: f32) -> f32 {
        offset.clamp(-self.max_offset(), 0.)
    }
}

#[cfg(test)]
mod tests {
    use super::Geometry;

    #[test]
    fn active_paragraph_preserves_canonical_scroll_extent() {
        let mut geometry = Geometry::new(349.);
        geometry.add_paragraph(1.03, [(0., 20.)].into_iter());
        assert_eq!(geometry.content_width, 360.);
        assert_eq!(geometry.max_offset(), 11.);
        assert!(geometry.overflows());
    }

    #[test]
    fn inactive_short_line_keeps_fractional_viewport_without_gutter() {
        let mut geometry = Geometry::new(349.25);
        geometry.add_paragraph(1., [(0., 20.)].into_iter());
        assert_eq!(geometry.content_width, 349.25);
        assert!(!geometry.overflows());
        assert_eq!(geometry.clamp_offset(-11.), 0.);
    }

    #[test]
    fn unbreakable_word_unions_painted_right_with_paragraph_box_and_body_padding() {
        let mut geometry = Geometry::new(349.);
        geometry.add_paragraph(1., [(0., 1000.)].into_iter());
        assert_eq!(geometry.content_width, 1026.);
        assert_eq!(geometry.max_offset(), 677.);
        geometry.add_paragraph(1.03, [(0., 1000.)].into_iter());
        assert_eq!(geometry.content_width, 1057.);
        assert_eq!(geometry.max_offset(), 708.);
    }

    #[test]
    fn positioned_word_extent_and_shrinking_range_clamp_old_offset() {
        let mut geometry = Geometry::new(500.);
        geometry.add_paragraph(1., [(200., 1000.)].into_iter());
        assert_eq!(geometry.content_width, 1226.);
        assert_eq!(geometry.clamp_offset(-900.), -726.);
        assert_eq!(geometry.clamp_offset(10.), 0.);
        assert_eq!(Geometry::new(500.).clamp_offset(-726.), 0.);
    }
}
