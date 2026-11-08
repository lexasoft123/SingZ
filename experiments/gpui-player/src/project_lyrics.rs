//! Read-only saved lyrics and native glyph halos. No network, Node, or frame-time blur.
use crate::lyrics_edit::{js_whitespace, trim_text};
use anyhow::{Context, Result, bail};
use gpui_kit::{
    Font, RenderGlyphParams, RenderImage, TextRun, TextSystem, WindowTextSystem, point, px, white,
};
use image::{GrayImage, Luma};
use serde_json::Value;
use std::{collections::HashMap, fs, path::Path, sync::Arc};
#[derive(Clone, Debug)]
pub struct Word {
    pub text: String,
    pub start: f32,
    pub end: f32,
}
#[derive(Clone, Debug)]
pub struct Line {
    /// Preserve the editor's exact line spelling and spacing independently of
    /// tokenized words used by the player.
    pub text: String,
    pub start: f32,
    pub end: f32,
    pub words: Vec<Word>,
}
#[derive(Clone, Debug, Default)]
pub struct Document {
    pub lines: Vec<Line>,
    pub source: String,
    pub credit: String,
    pub masks: HashMap<String, GrayImage>,
}
impl Document {
    pub fn active(&self, position: f32) -> usize {
        self.lines
            .partition_point(|line| line.start <= position)
            .saturating_sub(1)
    }
    pub fn start(&self, index: usize) -> f32 {
        self.lines.get(index).map_or(0., |line| line.start)
    }
}
fn time(v: &Value) -> Result<f32> {
    let n = v.as_f64().context("Lyrics timing is missing")? as f32;
    if !n.is_finite() || !(0. ..=86400. * 365.).contains(&n) {
        bail!("Invalid lyrics timing")
    }
    Ok(n)
}
pub fn read(dir: &Path) -> Result<Option<Document>> {
    let dir = dir.canonicalize()?;
    let path = dir.join("lyrics.json");
    if !path.exists() {
        return Ok(None);
    }
    let path = path.canonicalize()?;
    if !path.starts_with(&dir) {
        bail!("Lyrics file leaves project folder")
    }
    let file = fs::File::open(path)?;
    if file.metadata()?.len() > 8 * 1024 * 1024 {
        bail!("Lyrics file is too large")
    }
    let raw: Value = serde_json::from_reader(file).context("Invalid lyrics.json")?;
    from_value(&raw)
}
/// Parse an in-memory saved document before publishing it or preparing glyphs.
pub fn from_value(raw: &Value) -> Result<Option<Document>> {
    let lines = raw["lines"]
        .as_array()
        .context("Lyrics lines are missing")?;
    if lines.len() > 10000 {
        bail!("Too many lyric lines")
    }
    let mut doc = Document {
        source: raw["source"].as_str().unwrap_or("whisper").into(),
        credit: raw["credit"].as_str().unwrap_or("").into(),
        ..Default::default()
    };
    let mut count = 0;
    for line in lines {
        let text = trim_text(line["text"].as_str().unwrap_or(""));
        if text.is_empty() {
            continue;
        }
        let start = time(&line["start"])?;
        let end = time(&line["end"])?;
        if end < start {
            bail!("Lyrics line ends before it starts")
        }
        let mut words = vec![];
        if let Some(values) = line["words"].as_array() {
            for value in values {
                let text = trim_text(value["w"].as_str().context("Invalid lyric word")?);
                if text.is_empty() {
                    continue;
                }
                if text.chars().count() > 1024 || text.contains(['\n', '\r']) {
                    bail!("Invalid lyric word length or newline")
                }
                let s = time(&value["s"])?;
                let e = time(&value["e"])?;
                if e < s {
                    bail!("Lyrics word ends before it starts")
                }
                words.push(Word {
                    text: text.into(),
                    start: s,
                    end: e,
                });
            }
        }
        if words.is_empty() {
            // Match the production editor's normalization of text-only saved lines.
            let total = text
                .split(js_whitespace)
                .filter(|part| !part.is_empty())
                .map(|p| p.encode_utf16().count() + 1)
                .sum::<usize>() as f32;
            let mut cursor = start;
            for part in text.split(js_whitespace).filter(|part| !part.is_empty()) {
                if part.chars().count() > 1024 {
                    bail!("Lyric word is too long")
                }
                let duration = (end - start) * (part.encode_utf16().count() + 1) as f32 / total;
                words.push(Word {
                    text: part.into(),
                    start: cursor,
                    end: cursor + duration,
                });
                cursor += duration;
            }
        }
        count += words.len();
        if count > 30000 {
            bail!("Too many lyric words")
        }
        doc.lines.push(Line {
            text: line["text"].as_str().unwrap_or("").into(),
            start,
            end,
            words,
        });
    }
    doc.lines.sort_by(|a, b| a.start.total_cmp(&b.start));
    Ok((!doc.lines.is_empty()).then_some(doc))
}

/// Seed the editor from the project's accepted in-memory JSON, retaining its
/// f64 timestamps. `Document` intentionally narrows times for player rendering;
/// widening those f32 values again would change saved word timings on reopen.
pub fn editor_lines(raw: &Value) -> Result<Vec<crate::lyrics_edit::Line>> {
    // Keep the existing document parser authoritative for limits, malformed
    // words, skipped empty text and all other saved-document admission rules.
    if from_value(raw)?.is_none() {
        return Ok(vec![]);
    }
    let mut lines = vec![];
    for line in raw["lines"].as_array().context("Lyrics lines are missing")? {
        let text = line["text"].as_str().unwrap_or("");
        if trim_text(text).is_empty() {
            continue;
        }
        let start = line["start"].as_f64().context("Lyrics timing is missing")?;
        let end = line["end"].as_f64().context("Lyrics timing is missing")?;
        let mut words = vec![];
        if let Some(values) = line["words"].as_array() {
            for value in values {
                let word = trim_text(value["w"].as_str().context("Invalid lyric word")?);
                if word.is_empty() {
                    continue;
                }
                words.push(crate::lyrics_edit::Word {
                    w: word.into(),
                    s: value["s"].as_f64().context("Lyrics timing is missing")?,
                    e: value["e"].as_f64().context("Lyrics timing is missing")?,
                });
            }
        }
        if words.is_empty() {
            words = crate::lyrics_edit::distribute_row_words(trim_text(text), start, end);
        }
        lines.push(crate::lyrics_edit::Line { start, end, text: text.into(), words });
    }
    // Match Document's stable ordering, including ties at its playback precision,
    // while retaining every original f64 time in the editor-owned values.
    lines.sort_by(|a, b| (a.start as f32).total_cmp(&(b.start as f32)));
    Ok(lines)
}
pub fn fixture() -> Document {
    let mut doc = Document::default();
    for i in 0..24 {
        let text = crate::LYRICS[i % 6];
        let total = text
            .split_whitespace()
            .map(|w| w.chars().count())
            .sum::<usize>() as f32;
        let mut before = 0.;
        let mut words = vec![];
        for text in text.split_whitespace() {
            let start = i as f32 * 8. + before / total * 6.5;
            let end = start + text.chars().count() as f32 / total * 6.5;
            before += text.chars().count() as f32;
            words.push(Word {
                text: text.into(),
                start,
                end,
            });
        }
        doc.lines.push(Line {
            text: text.into(),
            start: i as f32 * 8.,
            end: i as f32 * 8. + 6.5,
            words,
        });
    }
    doc
}
/// Prepare once on the backend worker. Keep only one blurred alpha mask per
/// distinct word; the UI's small opacity-level cache is separately bounded.
pub fn prepare_masks(
    doc: &mut Document,
    text_system: &Arc<TextSystem>,
    cancelled: impl Fn() -> bool,
) -> Result<()> {
    let text = WindowTextSystem::new(text_system.clone());
    let font = Font {
        family: "SingZ Display 650".into(),
        ..Default::default()
    };
    let mut retained = 0usize;
    for word in doc.lines.iter().flat_map(|l| &l.words) {
        if cancelled() {
            bail!("Lyrics load superseded")
        }
        if doc.masks.contains_key(&word.text) {
            continue;
        }
        let line = text.shape_line(
            word.text.clone().into(),
            px(18.025),
            &[TextRun {
                len: word.text.len(),
                font: font.clone(),
                color: white(),
                background_color: None,
                underline: None,
                strikethrough: None,
            }],
            None,
        );
        let width = ((f32::from(line.width) + 42.) * 2.).ceil() as u32;
        if width > 4096 {
            bail!("Lyric word exceeds native texture width limit")
        }
        let height = (26.13625_f32 + 42.) * 2.;
        retained += width as usize * height.ceil() as usize;
        if retained > 64 * 1024 * 1024 {
            bail!("Lyrics glow cache exceeds its memory limit")
        }
        let mut alpha = GrayImage::new(width, height.ceil() as u32);
        let baseline = ((26.13625 - f32::from(line.ascent) - f32::from(line.descent)) / 2.
            + f32::from(line.ascent))
            * 2.
            + 42.;
        for run in &line.runs {
            for glyph in &run.glyphs {
                let params = RenderGlyphParams {
                    font_id: run.font_id,
                    glyph_id: glyph.id,
                    font_size: px(18.025),
                    subpixel_variant: point(0, 0),
                    scale_factor: 2.,
                    is_emoji: glyph.is_emoji,
                    css_rasterization: true,
                    subpixel_rendering: false,
                    dilation: 0,
                };
                let (bounds, bytes) = text.glyph_image_mask(&params)?;
                let w = bounds.size.width.0.max(0) as u32;
                let h = bounds.size.height.0.max(0) as u32;
                let left =
                    (42. + f32::from(glyph.position.x) * 2.).round() as i32 + bounds.origin.x.0;
                let top = (baseline + f32::from(glyph.position.y) * 2.).round() as i32
                    + bounds.origin.y.0;
                for y in 0..h {
                    for x in 0..w {
                        let (dx, dy) = (left + x as i32, top + y as i32);
                        if dx < 0
                            || dy < 0
                            || dx >= alpha.width() as i32
                            || dy >= alpha.height() as i32
                        {
                            continue;
                        }
                        let index = (y * w + x) as usize;
                        let a = if glyph.is_emoji {
                            bytes.get(index * 4 + 3)
                        } else {
                            bytes.get(index)
                        }
                        .copied()
                        .unwrap_or(0);
                        let old = alpha.get_pixel(dx as u32, dy as u32)[0];
                        alpha.put_pixel(dx as u32, dy as u32, Luma([old.saturating_add(a)]));
                    }
                }
            }
        }
        let mut blur = image::imageops::blur(&alpha, 14.);
        for p in blur.pixels_mut() {
            p[0] = (p[0] as f32 * 0.75).round() as u8;
        }
        doc.masks.insert(word.text.clone(), blur);
    }
    Ok(())
}

#[derive(Default)]
pub struct GlowCache {
    words: HashMap<String, Vec<Arc<RenderImage>>>,
    bytes: usize,
}
impl GlowCache {
    pub fn clear(&mut self) {
        self.words.clear();
        self.bytes = 0;
    }
    pub fn get(&mut self, word: &str, mask: &GrayImage) -> Vec<Arc<RenderImage>> {
        if let Some(images) = self.words.get(word) {
            return images.clone();
        }
        let bytes = mask.width() as usize * mask.height() as usize * 4 * 8;
        if self.words.len() >= 32 || self.bytes + bytes > 32 * 1024 * 1024 {
            self.clear();
        }
        self.bytes += bytes;
        let images = (1..=8)
            .map(|level| {
                // GPUI RenderImage stores BGRA, as do the approved baked textures.
                let pixels = image::RgbaImage::from_fn(mask.width(), mask.height(), |x, y| {
                    image::Rgba([
                        40,
                        160,
                        255,
                        (mask.get_pixel(x, y)[0] as u16 * level / 8) as u8,
                    ])
                });
                Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
            })
            .collect::<Vec<_>>();
        self.words.insert(word.into(), images.clone());
        images
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn read_value(name: &str, value: &str) -> Result<Option<Document>> {
        let root = std::env::temp_dir().join(format!("singz-lyrics-{}-{name}", std::process::id()));
        fs::create_dir_all(&root)?;
        fs::write(root.join("lyrics.json"), value)?;
        let result = read(&root);
        fs::remove_dir_all(root)?;
        result
    }
    #[test]
    fn saved_words_keep_precise_timing_unicode_and_line_gaps() {
        let doc=read_value("timed",r#"{"source":"edited","credit":"A singer","lines":[{"start":12,"end":13,"text":"Привет world","words":[{"w":"Привет","s":12.123,"e":12.7},{"w":"world","s":12.8,"e":13}]}]}"#).unwrap().unwrap();
        assert_eq!(doc.lines[0].words[0].text, "Привет");
        assert_eq!(doc.lines[0].words[0].start, 12.123);
        assert_eq!(doc.lines[0].words[1].start, 12.8);
        assert_eq!(doc.lines[0].end, 13.);
        assert_eq!(doc.credit, "A singer");
    }
    #[test]
    fn text_only_saved_lines_use_the_editors_span_normalization() {
        let doc = read_value(
            "plain",
            r#"{"lines":[{"start":2,"end":6,"text":"One two"}]}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(doc.lines[0].words.len(), 2);
        assert_eq!(doc.lines[0].words[0].end, 4.);
        assert_eq!(doc.lines[0].words[1].end, 6.);
    }
    #[test]
    fn saved_line_and_word_trimming_matches_javascript_bom_and_nel() {
        let raw = serde_json::json!({"lines":[
            {"text":" \u{feff}\t"},
            {"start":0,"end":1,"text":"\u{0085}","words":[
                {"w":"\u{feff}"},
                {"w":"\u{feff}\u{0085}\u{feff}","s":0,"e":1}
            ]}
        ]});
        let doc = from_value(&raw).unwrap().unwrap();
        assert_eq!(doc.lines.len(), 1);
        assert_eq!(doc.lines[0].text, "\u{0085}");
        assert_eq!(doc.lines[0].words.len(), 1);
        assert_eq!(doc.lines[0].words[0].text, "\u{0085}");
    }
    #[test]
    fn text_only_spans_split_bom_but_keep_nel_and_original_line_text() {
        let original = "\u{feff}One\u{0085}two\u{feff}\u{feff}界\u{feff}";
        let raw = serde_json::json!({"lines":[{"start":0,"end":10,"text":original}]});
        let doc = from_value(&raw).unwrap().unwrap();
        let line = &doc.lines[0];
        assert_eq!(line.text, original);
        assert_eq!(line.words.len(), 2);
        assert_eq!(line.words[0].text, "One\u{0085}two");
        assert_eq!(line.words[0].end, 8.);
        assert_eq!(line.words[1].text, "界");
        assert_eq!(line.words[1].start, 8.);
        assert_eq!(line.words[1].end, 10.);
    }
    #[test]
    fn invalid_timing_and_control_characters_are_rejected() {
        for value in [
            r#"{"lines":[{"start":2,"end":1,"text":"No"}]}"#,
            r#"{"lines":[{"start":0,"end":2,"text":"No","words":[{"w":"No","s":1,"e":0}]}]}"#,
            r#"{"lines":[{"start":0,"end":2,"text":"No","words":[{"w":"bad\nword","s":0,"e":1}]}]}"#,
        ] {
            assert!(read_value("invalid", value).is_err());
        }
    }
    #[test]
    fn editor_reopen_retains_raw_f64_line_and_word_times_after_two_minutes() {
        let raw = serde_json::json!({"source":"edited","lines":[{
            "start":128.123456789123,"end":141.546123456789,"text":"  Held  words ",
            "words":[{"w":" Held ","s":128.234567891234,"e":134.345678912345},
                     {"w":"words","s":135.456789123456,"e":141.345678912345}]
        }]});
        let lines = editor_lines(&raw).unwrap();
        let line = &lines[0];
        assert_eq!(line.text, "  Held  words ");
        assert_eq!(line.words[0].w, "Held");
        assert_eq!(line.start, raw["lines"][0]["start"].as_f64().unwrap());
        assert_eq!(line.end, raw["lines"][0]["end"].as_f64().unwrap());
        for (word, original) in line.words.iter().zip(raw["lines"][0]["words"].as_array().unwrap()) {
            assert_eq!(word.s, original["s"].as_f64().unwrap());
            assert_eq!(word.e, original["e"].as_f64().unwrap());
        }
        let painted = from_value(&raw).unwrap().unwrap();
        assert!((painted.lines[0].words[0].start as f64 - line.words[0].s).abs() > 0.000001,
            "Regression fixture must expose the f32 widening loss");
        let saved = serde_json::json!({"source":"edited","lines":lines});
        assert_eq!(editor_lines(&saved).unwrap(), editor_lines(&raw).unwrap());
    }
    #[test]
    fn editor_seed_matches_legacy_empty_word_generation_and_exact_line_spelling() {
        let text = " \u{feff}A😀  界\u{0085}B\u{feff} ";
        for words in [Value::Null, serde_json::json!([]), serde_json::json!([{"w":" \u{feff}"}])] {
            let raw = serde_json::json!({"lines":[
                {"text":" \u{feff}\t"},
                {"start":128.123456789,"end":140.987654321,"text":text,"words":words}
            ]});
            let line = editor_lines(&raw).unwrap().remove(0);
            assert_eq!(line.text, text);
            assert_eq!(line.words.iter().map(|w|w.w.as_str()).collect::<Vec<_>>(), vec!["A😀", "界\u{0085}B"]);
            assert_eq!(line.words[0].s, line.start);
            assert_eq!(line.words[0].e, line.start + (line.end - line.start) / 2.);
            assert_eq!(line.words[1].s, line.words[0].e);
            assert!((line.words[1].e - line.end).abs() < 1e-12);
            let doc = from_value(&raw).unwrap().unwrap();
            assert_eq!(doc.lines[0].words.iter().map(|w|w.text.as_str()).collect::<Vec<_>>(), vec!["A😀", "界\u{0085}B"]);
        }
        assert!(editor_lines(&serde_json::json!({"lines":[{"text":" \u{feff}"}]})).unwrap().is_empty());
    }
    #[test]
    fn editor_seed_preserves_accepted_sort_order_and_word_order() {
        let raw = serde_json::json!({"lines":[
            {"start":130.0000002,"end":132.,"text":"later input first","words":[
                {"w":"first","s":131.,"e":131.5},{"w":"second","s":130.,"e":130.5}]},
            {"start":2.,"end":3.,"text":"early"},
            {"start":130.0000001,"end":132.,"text":"same playback key"}
        ]});
        let lines = editor_lines(&raw).unwrap();
        let doc = from_value(&raw).unwrap().unwrap();
        assert_eq!(lines.iter().map(|l|l.text.as_str()).collect::<Vec<_>>(),
            doc.lines.iter().map(|l|l.text.as_str()).collect::<Vec<_>>());
        assert_eq!(lines[0].text, "early");
        assert_eq!(lines[1].start, 130.0000002);
        assert_eq!(lines[2].start, 130.0000001);
        assert_eq!(lines[1].words.iter().map(|w|w.w.as_str()).collect::<Vec<_>>(), vec!["first", "second"]);
    }
    #[test]
    fn editor_seed_cannot_bypass_saved_document_admission() {
        for raw in [
            serde_json::json!({}),
            serde_json::json!({"lines":[{"start":2.,"end":1.,"text":"No"}]}),
            serde_json::json!({"lines":[{"start":0.,"end":1.,"text":"No","words":[{"w":7,"s":0.,"e":1.}]}]}),
            serde_json::json!({"lines":[{"start":0.,"end":2.,"text":"No","words":[{"w":"No","s":1.,"e":0.}]}]}),
            serde_json::json!({"lines":[{"start":0.,"end":2.,"text":"No","words":[{"w":"bad\nword","s":0.,"e":1.}]}]}),
            serde_json::json!({"lines":[{"start":-1.,"end":2.,"text":"No"}]}),
        ] {
            assert!(from_value(&raw).is_err());
            assert!(editor_lines(&raw).is_err());
        }
    }
    #[test]
    fn fixture_timing_matches_the_approved_demo() {
        let doc = fixture();
        assert_eq!(doc.lines.len(), 24);
        assert_eq!(doc.start(8), 64.);
        assert_eq!(doc.active(71.99), 8);
        assert_eq!(doc.active(72.), 9);
        assert_eq!(
            doc.lines[8]
                .words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Every", "note", "will", "light", "the", "way"]
        );
    }
}
