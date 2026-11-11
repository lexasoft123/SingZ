//! Pure native counterpart of `renderer/src/lyrics-edit.ts` and the editor's
//! row operations. Times stay f64 here; the playback bridge converts at its edge.
use anyhow::{Result, ensure};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Word {
    pub w: String,
    pub s: f64,
    pub e: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(default)]
    pub words: Vec<Word>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DraftRow {
    pub id: u64,
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub text: String,
    pub words: Option<Vec<Word>>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
pub fn fresh_row_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}
pub fn empty_row() -> DraftRow {
    DraftRow {
        id: fresh_row_id(),
        start: None,
        end: None,
        text: String::new(),
        words: None,
    }
}
pub fn rows_from_lines(lines: &[Line]) -> Vec<DraftRow> {
    lines
        .iter()
        .map(|line| DraftRow {
            id: fresh_row_id(),
            start: Some(line.start),
            end: Some(line.end),
            text: line.text.clone(),
            words: (!line.words.is_empty()).then(|| line.words.clone()),
        })
        .collect()
}

/// ECMAScript's WhiteSpace + LineTerminator set, including BOM but excluding
/// NEL. Rust's `is_whitespace` is deliberately not interchangeable with it.
pub fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub fn trim_text(s: &str) -> &str {
    s.trim_matches(js_whitespace)
}
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}
fn parts(text: &str) -> impl Iterator<Item = &str> {
    text.split(js_whitespace).filter(|s| !s.is_empty())
}

pub fn normalized_line(text: &str) -> String {
    static NON_TEXT: OnceLock<Regex> = OnceLock::new();
    let re =
        NON_TEXT.get_or_init(|| Regex::new(r"[^\p{L}\p{N}' ]").expect("source line normalization"));
    let lower = text.to_lowercase();
    re.replace_all(&lower, "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
pub fn estimate_line_end(text: &str, start: f64) -> f64 {
    start + (utf16_len(text) as f64 / 12.).clamp(1.2, 9.)
}
pub fn distribute_row_words(text: &str, start: f64, end: f64) -> Vec<Word> {
    let parts: Vec<_> = parts(text).collect();
    let total: usize = parts.iter().map(|p| utf16_len(p) + 1).sum();
    let mut cur = start;
    parts
        .into_iter()
        .map(|p| {
            let dur = if total > 0 {
                (end - start) * (utf16_len(p) + 1) as f64 / total as f64
            } else {
                0.
            };
            let word = Word {
                w: p.to_owned(),
                s: cur,
                e: cur + dur,
            };
            cur += dur;
            word
        })
        .collect()
}
pub fn words_match_text(row: &DraftRow) -> bool {
    let Some(words) = &row.words else {
        return false;
    };
    let parts: Vec<_> = parts(&row.text).collect();
    parts.len() == words.len() && words.iter().zip(parts).all(|(w, p)| w.w == p)
}

pub fn lines_from_rows(rows: &[DraftRow], duration: f64) -> Vec<Line> {
    let rows: Vec<_> = rows
        .iter()
        .filter(|r| !trim_text(&r.text).is_empty())
        .collect();
    let mut starts = vec![0.; rows.len()];
    let mut ends = vec![0.; rows.len()];
    for (i, row) in rows.iter().enumerate() {
        if let Some(start) = row.start {
            starts[i] = start;
            ends[i] = row
                .end
                .unwrap_or_else(|| estimate_line_end(&row.text, start));
        }
    }
    let mut i = 0;
    while i < rows.len() {
        if rows[i].start.is_some() {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < rows.len() && rows[j].start.is_none() {
            j += 1;
        }
        let prev_end = if i > 0 { ends[i - 1] } else { 0. };
        let next_start = if j < rows.len() {
            starts[j]
        } else if duration > 0. {
            duration
        } else {
            prev_end + (j - i) as f64 * 4.
        };
        let gap = (next_start - prev_end).max(0.);
        let wants: Vec<_> = rows[i..j]
            .iter()
            .map(|r| (utf16_len(&r.text) as f64 / 12.).clamp(1.2, 9.))
            .collect();
        let total: f64 = wants.iter().sum();
        let scale = if total > 0. {
            (gap / total).min(1.)
        } else {
            0.
        };
        let mut cur = prev_end + (gap - total * scale).max(0.) / 2.;
        for k in i..j {
            starts[k] = cur;
            ends[k] = cur + wants[k - i] * scale;
            cur = ends[k];
        }
        i = j;
    }
    for k in 0..rows.len() {
        if k > 0 && starts[k] < ends[k - 1] {
            starts[k] = ends[k - 1];
        }
        if ends[k] < starts[k] {
            ends[k] = starts[k];
        }
        if duration > 0. {
            starts[k] = starts[k].min(duration);
            ends[k] = ends[k].min(duration);
        }
    }
    rows.iter()
        .enumerate()
        .map(|(i, row)| {
            let start = starts[i];
            let end = ends[i].max(start);
            let words = if words_match_text(row) && row.start.is_some() {
                row.words.clone().unwrap()
            } else {
                distribute_row_words(&row.text, start, end)
            };
            Line {
                start,
                end,
                text: row.text.clone(),
                words,
            }
        })
        .collect()
}

/// Same normalized-line LCS and tie order as production. Admit the DP table
/// before allocating; oversized replacement is refused, never truncated.
pub fn replace_all_text(rows: &[DraftRow], text: &str) -> Result<Vec<DraftRow>> {
    let news: Vec<_> = text
        .split('\n')
        .map(|s| trim_text(s.strip_suffix('\r').unwrap_or(s)))
        .filter(|s| !s.is_empty())
        .collect();
    let old_n: Vec<_> = rows.iter().map(|r| normalized_line(&r.text)).collect();
    let new_n: Vec<_> = news.iter().map(|r| normalized_line(r)).collect();
    let m = rows.len();
    let n = news.len();
    let width = n
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("Too many replacement lines"))?;
    let cells = m
        .checked_add(1)
        .and_then(|m| m.checked_mul(width))
        .ok_or_else(|| anyhow::anyhow!("Replacement comparison is too large"))?;
    ensure!(
        cells <= 64 * 1024 * 1024 / std::mem::size_of::<u32>(),
        "Replacement comparison exceeds its 64 MiB budget"
    );
    let mut dp = Vec::<u32>::new();
    dp.try_reserve_exact(cells)?;
    dp.resize(cells, 0);
    for a in (0..m).rev() {
        for b in (0..n).rev() {
            dp[a * width + b] = if old_n[a] == new_n[b] && !old_n[a].is_empty() {
                dp[(a + 1) * width + b + 1] + 1
            } else {
                dp[(a + 1) * width + b].max(dp[a * width + b + 1])
            };
        }
    }
    let mut matched = vec![None; n];
    let (mut a, mut b) = (0, 0);
    while a < m && b < n {
        if old_n[a] == new_n[b] && !old_n[a].is_empty() {
            matched[b] = Some(&rows[a]);
            a += 1;
            b += 1;
        } else if dp[(a + 1) * width + b] >= dp[a * width + b + 1] {
            a += 1;
        } else {
            b += 1;
        }
    }
    Ok(news
        .into_iter()
        .zip(matched)
        .map(|(text, keep)| DraftRow {
            id: fresh_row_id(),
            start: keep.and_then(|r| r.start),
            end: keep.and_then(|r| r.end),
            text: text.to_owned(),
            words: keep
                .filter(|r| r.text == text)
                .and_then(|r| r.words.clone()),
        })
        .collect())
}

#[derive(Clone, Debug, PartialEq)]
pub struct FocusTarget {
    pub id: u64,
    pub caret_utf16: Option<usize>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct RowEdit {
    pub rows: Vec<DraftRow>,
    pub focus: Option<FocusTarget>,
}
fn edit(rows: Vec<DraftRow>, focus: Option<FocusTarget>) -> RowEdit {
    RowEdit { rows, focus }
}
fn position(rows: &[DraftRow], id: u64) -> Option<usize> {
    rows.iter().position(|r| r.id == id)
}

/// Convert a valid native caret to the source's UTF-16 offset. A hypothetical
/// offset inside a surrogate pair is kept before its scalar, preserving UTF-8.
pub fn byte_at_utf16(text: &str, units: usize) -> usize {
    let mut at = 0;
    for (byte, ch) in text.char_indices() {
        if at + ch.len_utf16() > units {
            return byte;
        }
        at += ch.len_utf16();
    }
    text.len()
}
pub fn utf16_at_byte(text: &str, byte: usize) -> usize {
    text.char_indices()
        .take_while(|(i, _)| *i < byte)
        .map(|(_, c)| c.len_utf16())
        .sum()
}
pub fn set_text(rows: &[DraftRow], id: u64, text: String) -> Option<RowEdit> {
    let i = position(rows, id)?;
    let mut next = rows.to_vec();
    next[i].text = text;
    next[i].words = None;
    Some(edit(next, None))
}
pub fn split_row(rows: &[DraftRow], id: u64, caret_utf16: usize) -> Option<RowEdit> {
    let i = position(rows, id)?;
    let byte = byte_at_utf16(&rows[i].text, caret_utf16);
    let left = rows[i].text[..byte]
        .trim_end_matches(js_whitespace)
        .to_owned();
    let right = rows[i].text[byte..]
        .trim_start_matches(js_whitespace)
        .to_owned();
    let mut next = rows.to_vec();
    next[i].text = left;
    next[i].words = None;
    next[i].end = None;
    let mut fresh = empty_row();
    fresh.text = right;
    let focus = FocusTarget {
        id: fresh.id,
        caret_utf16: Some(0),
    };
    next.insert(i + 1, fresh);
    Some(edit(next, Some(focus)))
}
pub fn merge_up(rows: &[DraftRow], id: u64) -> Option<RowEdit> {
    let i = position(rows, id)?;
    if i == 0 {
        return None;
    }
    let prev = &rows[i - 1];
    let caret = utf16_len(&prev.text);
    let mut merged = prev.clone();
    merged.text = trim_text(&format!("{} {}", prev.text, rows[i].text)).to_owned();
    merged.words = None;
    merged.end = rows[i].end.or(prev.end);
    let focus = FocusTarget {
        id: merged.id,
        caret_utf16: Some(if caret == 0 { 0 } else { caret + 1 }),
    };
    let mut next = rows.to_vec();
    next.splice(i - 1..=i, [merged]);
    Some(edit(next, Some(focus)))
}
pub fn delete_row(rows: &[DraftRow], id: u64) -> Option<RowEdit> {
    position(rows, id)?;
    let mut next: Vec<_> = rows.iter().filter(|r| r.id != id).cloned().collect();
    if next.is_empty() {
        next.push(empty_row());
    }
    Some(edit(next, None))
}
pub fn add_row_after(rows: &[DraftRow], id: u64) -> Option<RowEdit> {
    let i = position(rows, id)?;
    let fresh = empty_row();
    let focus = FocusTarget {
        id: fresh.id,
        caret_utf16: None,
    };
    let mut next = rows.to_vec();
    next.insert(i + 1, fresh);
    Some(edit(next, Some(focus)))
}
pub fn insert_pasted(rows: &[DraftRow], id: u64, text: &str) -> Option<RowEdit> {
    let i = position(rows, id)?;
    let mut fresh: Vec<_> = text
        .split('\n')
        .map(|s| trim_text(s.strip_suffix('\r').unwrap_or(s)))
        .filter(|s| !s.is_empty())
        .map(|s| {
            let mut r = empty_row();
            r.text = s.to_owned();
            r
        })
        .collect();
    if fresh.is_empty() {
        return None;
    }
    let mut next = rows.to_vec();
    if trim_text(&next[i].text).is_empty() {
        fresh[0].start = next[i].start;
        fresh[0].end = next[i].end;
        next.splice(i..=i, fresh);
    } else {
        next.splice(i + 1..i + 1, fresh);
    }
    Some(edit(next, None))
}
fn round_js(value: f64) -> f64 {
    if value < 0. && value >= -0.5 {
        -0.
    } else {
        (value + 0.5).floor()
    }
}
pub fn stamp_row(rows: &[DraftRow], id: u64, position_sec: f64) -> Option<RowEdit> {
    let i = position(rows, id)?;
    if !position_sec.is_finite() {
        return None;
    }
    let mut next = rows.to_vec();
    next[i].start = Some(round_js(position_sec * 100.).max(0.) / 100.);
    next[i].end = None;
    next[i].words = None;
    Some(edit(
        next,
        rows.get(i + 1).map(|r| FocusTarget {
            id: r.id,
            caret_utf16: None,
        }),
    ))
}
pub fn drop_silent(rows: &[DraftRow], silent: &HashSet<u64>) -> Option<RowEdit> {
    let mut next: Vec<_> = rows
        .iter()
        .filter(|r| !silent.contains(&r.id))
        .cloned()
        .collect();
    if next.len() == rows.len() {
        return None;
    }
    if next.is_empty() {
        next.push(empty_row());
    }
    Some(edit(next, None))
}

/// Text keystrokes use `set_text` directly; snapshot explicit editor actions,
/// matching production's history policy rather than adding per-key snapshots.
#[derive(Default)]
pub struct History {
    undo: VecDeque<Vec<DraftRow>>,
    redo: Vec<Vec<DraftRow>>,
}
impl History {
    pub fn snapshot(&mut self, rows: &[DraftRow]) {
        self.undo.push_back(rows.to_vec());
        if self.undo.len() > 100 {
            self.undo.pop_front();
        }
        self.redo.clear();
    }
    pub fn undo(&mut self, current: &[DraftRow]) -> Option<Vec<DraftRow>> {
        let previous = self.undo.pop_back()?;
        self.redo.push(current.to_vec());
        Some(previous)
    }
    pub fn redo(&mut self, current: &[DraftRow]) -> Option<Vec<DraftRow>> {
        let next = self.redo.pop()?;
        self.undo.push_back(current.to_vec());
        Some(next)
    }
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct VocalEnvelope {
    pub hop: f64,
    pub env: Vec<f32>,
}
pub const ROW_VOICED_MIN: f64 = 0.06;
pub fn compute_envelope(data: &[f32], sample_rate: f64) -> VocalEnvelope {
    compute_envelope_with_hop(data, sample_rate, 0.05)
}
pub fn compute_envelope_with_hop(data: &[f32], sample_rate: f64, hop_sec: f64) -> VocalEnvelope {
    let hop = (round_js(sample_rate * hop_sec) as usize).max(1);
    let frames = data.len().div_ceil(hop).max(1);
    let mut env = Vec::with_capacity(frames);
    for f in 0..frames {
        let a = f * hop;
        let b = data.len().min(a + hop);
        let sum: f64 = data[a..b].iter().map(|v| f64::from(v.abs())).sum();
        env.push(if b > a {
            (sum / (b - a) as f64) as f32
        } else {
            0.
        });
    }
    let mut sorted = env.clone();
    sorted.sort_by(f32::total_cmp);
    let p90 = sorted[((sorted.len() as f64 * 0.9).floor() as usize).min(sorted.len() - 1)];
    if p90 > 0. {
        for value in &mut env {
            *value = (f64::from(*value) / f64::from(p90)) as f32;
        }
    }
    VocalEnvelope { hop: hop_sec, env }
}
pub fn span_level(envelope: &VocalEnvelope, start: f64, end: f64) -> f64 {
    if envelope.hop <= 0. || !envelope.hop.is_finite() || !start.is_finite() || !end.is_finite() {
        return 0.;
    }
    let a = (start / envelope.hop).floor().max(0.) as usize;
    let b = envelope
        .env
        .len()
        .min(((end / envelope.hop).ceil() as usize).max(a.saturating_add(1)));
    if b <= a {
        return 0.;
    }
    envelope.env[a..b]
        .iter()
        .map(|v| f64::from(*v))
        .sum::<f64>()
        / (b - a) as f64
}
pub fn silent_row_ids(rows: &[DraftRow], envelope: Option<&VocalEnvelope>) -> HashSet<u64> {
    let Some(envelope) = envelope else {
        return HashSet::new();
    };
    rows.iter()
        .filter_map(|r| {
            let start = r.start?;
            if trim_text(&r.text).is_empty() {
                return None;
            }
            (span_level(
                envelope,
                start,
                r.end.unwrap_or_else(|| estimate_line_end(&r.text, start)),
            ) < ROW_VOICED_MIN)
                .then_some(r.id)
        })
        .collect()
}

pub const WORD_MIN_S: f64 = 0.05;
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WordBounds {
    pub lo: f64,
    pub hi: f64,
}
pub fn word_drag_bounds(words: &[Word], i: usize, lo: f64, hi: f64) -> WordBounds {
    let lo2 = lo.max(if i > 0 {
        words.get(i - 1).map_or(lo, |w| w.s + WORD_MIN_S)
    } else {
        lo
    });
    let hi_edge = words
        .get(i + 1)
        .map_or(hi - WORD_MIN_S, |w| w.s - WORD_MIN_S);
    WordBounds {
        lo: lo2,
        hi: hi.min(hi_edge).max(lo2),
    }
}
pub fn move_word_start(words: &[Word], i: usize, t: f64, lo: f64, hi: f64) -> Vec<Word> {
    if i >= words.len() {
        return words.to_vec();
    }
    let b = word_drag_bounds(words, i, lo, hi);
    let s = round_js(t.max(b.lo).min(b.hi) * 100.) / 100.;
    let mut out = words.to_vec();
    let dur = (out[i].e - out[i].s).max(WORD_MIN_S);
    let mut e = s + dur;
    if i + 1 < out.len() {
        e = e.min(out[i + 1].s);
    } else {
        e = e.min(hi.max(s + WORD_MIN_S));
    }
    out[i].s = s;
    out[i].e = e.max(s + WORD_MIN_S);
    if i > 0 && out[i - 1].e > s {
        out[i - 1].e = (out[i - 1].s + WORD_MIN_S).max(s);
    }
    out
}
pub fn with_words(row: &DraftRow, words: Vec<Word>) -> DraftRow {
    let mut out = row.clone();
    if words.is_empty() {
        out.words = None;
    } else {
        out.start = Some(words[0].s);
        out.end = Some(words[words.len() - 1].e);
        out.words = Some(words);
    }
    out
}
pub fn commit_word_drag(words: &[Word], i: usize, t: f64, lo: f64, hi: f64) -> Option<Vec<Word>> {
    let word = words.get(i)?;
    if (t - word.s).abs() < 0.005 {
        return None;
    }
    let moved = move_word_start(words, i, t, lo, hi);
    (moved[i].s != word.s).then_some(moved)
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct StripWindow {
    pub id: u64,
    pub t0: f64,
    pub t1: f64,
    pub lo: f64,
    pub hi: f64,
}
pub fn strip_window(rows: &[DraftRow], id: u64, duration: f64) -> Option<StripWindow> {
    let i = position(rows, id)?;
    let row = &rows[i];
    let start = row.start?;
    let end = row
        .end
        .unwrap_or_else(|| estimate_line_end(&row.text, start));
    let prev_end = rows[..i]
        .iter()
        .rev()
        .find_map(|p| {
            p.start
                .map(|s| p.end.unwrap_or_else(|| estimate_line_end(&p.text, s)))
        })
        .unwrap_or(0.);
    let next_start = rows[i + 1..]
        .iter()
        .find_map(|r| r.start)
        .unwrap_or(f64::INFINITY);
    let t0 = (start - 1.5).max(0.);
    let t1 = (if duration > 0. { duration } else { end + 1.5 }).min(end + 1.5);
    let lo = t0.max(prev_end);
    let hi = (lo + 0.1).max(t1.min(next_start));
    Some(StripWindow {
        id,
        t0,
        t1: t1.max(t0 + 0.5),
        lo,
        hi,
    })
}
pub fn active_row(rows: &[DraftRow], position: f64) -> Option<usize> {
    let mut active = None;
    for (i, row) in rows.iter().enumerate() {
        if let Some(s) = row.start {
            if position >= s {
                active = Some(i);
            } else {
                break;
            }
        }
    }
    active
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignCheck {
    pub method: String,
    pub verdict: String,
    pub matched_pct: f64,
    #[serde(default)]
    pub bad_lines: Vec<usize>,
    #[serde(default)]
    pub extra_sung: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CheckDescription {
    pub text: String,
    pub warn: bool,
}
pub fn describe_check(check: &AlignCheck, can_precise: bool) -> CheckDescription {
    describe_check_in(check, can_precise, crate::i18n::Locale::En)
}
/// Presentation is resolved from semantic verdict fields. Explicit locale keeps
/// domain consumers and parallel tests independent of the UI's current locale.
pub fn describe_check_in(check: &AlignCheck, can_precise: bool, locale: crate::i18n::Locale) -> CheckDescription {
    let text = |key| crate::i18n::lookup(locale,key,&[]);
    let pct = [("pct",check.matched_pct.to_string())];
    if check.verdict == "mismatch" {
        return CheckDescription {warn:true,text:crate::i18n::lookup(locale,if can_precise {"lyrics.check.mismatchPrecise"} else {"lyrics.check.mismatchNoPrecise"},&pct)};
    }
    let heard=crate::i18n::lookup(locale,"lyrics.check.wordsHeard",&pct);
    let detail=if !check.bad_lines.is_empty() {
        crate::i18n::lookup_plural(locale,"lyrics.check.badLines",check.bad_lines.len() as f64,&[])
    } else {text(if check.extra_sung {"lyrics.check.extraSungNote"} else {"lyrics.check.everySnapped"})};
    let suffix=if check.method=="ctc" {text("lyrics.check.preciseSuffix")}else{String::new()};
    CheckDescription {text:format!("{heard} · {detail}{suffix}"),warn:false}
}
pub fn fmt_stamp(sec: Option<f64>) -> String {
    let Some(sec) = sec.filter(|s| s.is_finite()) else {
        return "—".into();
    };
    let neg = if sec < 0. { "-" } else { "" };
    let t = sec.abs();
    let m = (t / 60.).floor();
    let s = t - m * 60.;
    let whole = s.floor();
    let tenth = ((s - whole) * 10.).floor();
    format!("{neg}{m:.0}:{whole:02.0}.{tenth:.0}")
}

#[cfg(test)]
#[path = "lyrics_edit_tests.rs"]
mod tests;
