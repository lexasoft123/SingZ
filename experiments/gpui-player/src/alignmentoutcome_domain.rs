//! Text/word timing decisions from main/align.ts. No model or audio processing.
use crate::lyrics_edit::{Line, Word, js_whitespace, trim_text, utf16_len};
use anyhow::{Result, ensure};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::OnceLock,
};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub verdict: String,
    pub method: String,
    pub matched_pct: f64,
    pub median_shift: f64,
    pub bad_lines: Vec<usize>,
    #[serde(default)]
    pub extra_sung: bool,
}
impl Check {
    pub fn description(&self, can_precise: bool) -> crate::lyrics_edit::CheckDescription {
        crate::lyrics_edit::describe_check(
            &crate::lyrics_edit::AlignCheck {
                method: self.method.clone(),
                verdict: self.verdict.clone(),
                matched_pct: self.matched_pct,
                bad_lines: self.bad_lines.clone(),
                extra_sung: self.extra_sung,
            },
            can_precise,
        )
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Anchor {
    pub li: usize,
    pub wi: usize,
    pub s: f64,
    pub e: f64,
    pub sim: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CtcWord {
    pub li: usize,
    pub wi: usize,
    pub s: f64,
    pub e: f64,
    pub score: f64,
    pub voiced: Option<f64>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Outcome {
    pub lines: Vec<Line>,
    pub check: Check,
    pub slipped: Vec<usize>,
}
pub fn norm(word: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[^\p{L}\p{N}']").unwrap())
        .replace_all(&word.to_lowercase(), "")
        .into_owned()
}
fn round(value: f64) -> f64 {
    (value + 0.5).floor()
}
fn levenshtein(a: &str, b: &str, cancel: &impl Fn() -> bool) -> Result<usize> {
    if a == b {
        return Ok(0);
    }
    let a: Vec<_> = a.encode_utf16().collect();
    let b: Vec<_> = b.encode_utf16().collect();
    let mut prev: Vec<_> = (0..=b.len()).collect();
    for (i, ac) in a.iter().enumerate() {
        if i % 16 == 0 {
            ensure!(!cancel(), "Alignment cancelled");
        }
        let mut cur = vec![i + 1];
        for (j, bc) in b.iter().enumerate() {
            if j % 256 == 0 {
                ensure!(!cancel(), "Alignment cancelled");
            }
            cur.push(
                (prev[j + 1] + 1)
                    .min(cur[j] + 1)
                    .min(prev[j] + usize::from(ac != bc)),
            );
        }
        prev = cur;
    }
    Ok(prev[b.len()])
}
pub fn word_sim(a: &str, b: &str) -> f64 {
    word_sim_cancellable(a, b, &|| false).expect("non-cancellable text comparison")
}
fn word_sim_cancellable(a: &str, b: &str, cancel: &impl Fn() -> bool) -> Result<f64> {
    if a.is_empty() || b.is_empty() {
        return Ok(0.);
    }
    if a == b {
        return Ok(1.);
    }
    let lev = levenshtein(a, b, cancel)?;
    let min = utf16_len(a).min(utf16_len(b));
    if lev <= 1 && min >= 4 {
        return Ok(0.85);
    }
    if lev <= 2 && min >= 5 {
        return Ok(0.65);
    }
    if min >= 4 && (a.starts_with(b) || b.starts_with(a)) {
        return Ok(0.65);
    }
    Ok(0.)
}
pub fn sanitize_hyp(raw: &[Word]) -> Vec<Word> {
    let mut hyp = vec![];
    let mut last_s: f64 = 0.;
    for w in raw {
        let text = trim_text(&w.w);
        if text.is_empty() || text.starts_with(['[', '(', '♪']) {
            continue;
        }
        let e = if w.e > w.s { w.e } else { w.s + 0.15 };
        if w.s < last_s - 0.5 {
            continue;
        }
        last_s = last_s.max(w.s);
        hyp.push(Word {
            w: text.into(),
            s: w.s,
            e,
        });
    }
    let mut out = vec![];
    let mut i = 0;
    while i < hyp.len() {
        let mut j = i + 1;
        while j < hyp.len() && (hyp[j].s - hyp[i].s).abs() <= 0.01 {
            j += 1;
        }
        out.push(hyp[i].clone());
        if j - i < 3 {
            out.extend_from_slice(&hyp[i + 1..j]);
        }
        i = j;
    }
    out
}
pub fn global_anchors(reference: &[Line], hyp: &[Word]) -> Result<Vec<Anchor>> {
    global_anchors_cancellable(reference, hyp, &|| false)
}
pub fn global_anchors_cancellable(
    reference: &[Line],
    hyp: &[Word],
    cancel: &impl Fn() -> bool,
) -> Result<Vec<Anchor>> {
    let toks: Vec<_> = reference
        .iter()
        .enumerate()
        .flat_map(|(li, l)| {
            l.words
                .iter()
                .enumerate()
                .map(move |(wi, w)| (li, wi, norm(&w.w)))
        })
        .collect();
    let hn: Vec<_> = hyp.iter().map(|w| norm(&w.w)).collect();
    ensure!(
        toks.iter().all(|t| utf16_len(&t.2) <= 2048) && hn.iter().all(|w| utf16_len(w) <= 2048),
        "A word exceeds the alignment text budget"
    );
    let ref_units: u128 = toks.iter().map(|t| utf16_len(&t.2) as u128).sum();
    let hyp_units: u128 = hn.iter().map(|w| utf16_len(w) as u128).sum();
    ensure!(
        ref_units.saturating_mul(hyp_units).saturating_mul(5) <= 2_000_000_000,
        "Alignment text comparison exceeds its 2-billion-operation work budget"
    );
    let r = toks.len();
    let h = hyp.len();
    if r == 0 || h == 0 {
        return Ok(vec![]);
    }
    let width = h + 1;
    let cells = (r + 1)
        .checked_mul(width)
        .ok_or_else(|| anyhow::anyhow!("Alignment comparison is too large"))?;
    ensure!(
        cells <= 64 * 1024 * 1024 / 5,
        "Alignment comparison exceeds its 64 MiB budget"
    );
    let mut score = Vec::<f32>::new();
    score.try_reserve_exact(cells)?;
    score.resize(cells, 0.);
    let mut from = vec![0u8; cells];
    for j in 1..=h {
        score[j] = (j as f64 * -0.22) as f32;
        from[j] = 2;
    }
    for i in 1..=r {
        score[i * width] = (i as f64 * -0.45) as f32;
        from[i * width] = 1;
    }
    for i in 1..=r {
        for j in 1..=h {
            if j % 64 == 1 {
                ensure!(!cancel(), "Alignment cancelled");
            }
            let sim = word_sim_cancellable(&toks[i - 1].2, &hn[j - 1], cancel)?;
            let mut best =
                f64::from(score[(i - 1) * width + j - 1]) + if sim > 0. { sim * 2. } else { -0.6 };
            let mut dir = 0;
            let up = f64::from(score[(i - 1) * width + j]) - 0.45;
            let left = f64::from(score[i * width + j - 1]) - 0.22;
            if up > best {
                best = up;
                dir = 1;
            }
            if left > best {
                best = left;
                dir = 2;
            }
            if j >= 2 {
                let sim2 = word_sim_cancellable(
                    &toks[i - 1].2,
                    &format!("{}{}", hn[j - 2], hn[j - 1]),
                    cancel,
                )?;
                if sim2 > 0. {
                    let v = f64::from(score[(i - 1) * width + j - 2]) + sim2 * 2. - 0.15;
                    if v > best {
                        best = v;
                        dir = 3;
                    }
                }
            }
            if i >= 2 {
                let sim2 = word_sim_cancellable(
                    &format!("{}{}", toks[i - 2].2, toks[i - 1].2),
                    &hn[j - 1],
                    cancel,
                )?;
                if sim2 > 0. {
                    let v = f64::from(score[(i - 2) * width + j - 1]) + sim2 * 2. - 0.15;
                    if v > best {
                        best = v;
                        dir = 4;
                    }
                }
            }
            score[i * width + j] = best as f32;
            from[i * width + j] = dir;
        }
    }
    let (mut i, mut j) = (r, h);
    let mut anchors = vec![];
    while i > 0 && j > 0 {
        match from[i * width + j] {
            0 => {
                let sim = word_sim_cancellable(&toks[i - 1].2, &hn[j - 1], cancel)?;
                if sim >= 0.65 {
                    anchors.push(Anchor {
                        li: toks[i - 1].0,
                        wi: toks[i - 1].1,
                        s: hyp[j - 1].s,
                        e: hyp[j - 1].e,
                        sim,
                    });
                }
                i -= 1;
                j -= 1;
            }
            3 => {
                let sim = word_sim_cancellable(
                    &toks[i - 1].2,
                    &format!("{}{}", hn[j - 2], hn[j - 1]),
                    cancel,
                )?;
                anchors.push(Anchor {
                    li: toks[i - 1].0,
                    wi: toks[i - 1].1,
                    s: hyp[j - 2].s,
                    e: hyp[j - 1].e,
                    sim,
                });
                i -= 1;
                j -= 2;
            }
            4 => {
                let a = &toks[i - 2];
                let b = &toks[i - 1];
                let sim = word_sim_cancellable(&format!("{}{}", a.2, b.2), &hn[j - 1], cancel)?;
                let span = &hyp[j - 1];
                let cut = span.s
                    + (span.e - span.s)
                        * (utf16_len(&a.2) as f64
                            / (utf16_len(&a.2) + utf16_len(&b.2)).max(1) as f64);
                anchors.push(Anchor {
                    li: b.0,
                    wi: b.1,
                    s: cut,
                    e: span.e,
                    sim,
                });
                anchors.push(Anchor {
                    li: a.0,
                    wi: a.1,
                    s: span.s,
                    e: cut,
                    sim,
                });
                i -= 2;
                j -= 1;
            }
            1 => i -= 1,
            _ => j -= 1,
        }
    }
    anchors.reverse();
    let mut ordered: Vec<Anchor> = vec![];
    for a in anchors {
        if ordered.last().is_some_and(|p| a.s < p.s - 0.25) {
            continue;
        }
        ordered.push(a);
    }
    let mut by_line: HashMap<usize, Vec<f64>> = HashMap::new();
    for a in &ordered {
        by_line.entry(a.li).or_default().push(a.s);
    }
    for times in by_line.values_mut() {
        times.sort_by(f64::total_cmp);
    }
    ordered.retain(|a| {
        let times = &by_line[&a.li];
        times.len() < 2 || (a.s - times[times.len() / 2]).abs() <= 6.
    });
    Ok(ordered)
}
pub fn retime(reference: &[Line], anchors: &[Anchor], duration: f64) -> Vec<Line> {
    let mut lines = reference.to_vec();
    let mut flat: Vec<Word> = lines.iter().flat_map(|l| l.words.clone()).collect();
    let mut index = HashMap::new();
    let mut k = 0;
    for (li, l) in lines.iter().enumerate() {
        for wi in 0..l.words.len() {
            index.insert((li, wi), k);
            k += 1;
        }
    }
    let marks: Vec<_> = anchors
        .iter()
        .filter_map(|a| index.get(&(a.li, a.wi)).map(|k| (*k, a.s, a.e)))
        .collect();
    if marks.is_empty() {
        return lines;
    }
    let orig: Vec<_> = flat.iter().map(|w| (w.s, w.e)).collect();
    for &(k, s, e) in &marks {
        flat[k].s = s;
        flat[k].e = e;
    }
    let first = marks[0];
    let shift = first.1 - orig[first.0].0;
    for k in (0..first.0).rev() {
        flat[k].s = (orig[k].0 + shift).max(0.);
        flat[k].e = (orig[k].1 + shift).max(flat[k].s + 0.05);
    }
    for pair in marks.windows(2) {
        let l = pair[0];
        let r = pair[1];
        if r.0 <= l.0 + 1 {
            continue;
        }
        let span = (r.1 - l.2).max(0.);
        let prior = orig[r.0].0 - orig[l.0].1;
        if prior > 0.25 {
            let scale = span / prior;
            for k in l.0 + 1..r.0 {
                flat[k].s = l.2 + (orig[k].0 - orig[l.0].1) * scale;
                flat[k].e = l.2 + (orig[k].1 - orig[l.0].1) * scale;
            }
        } else {
            let total: usize = flat[l.0 + 1..r.0].iter().map(|w| utf16_len(&w.w) + 1).sum();
            let mut cur = l.2;
            for w in &mut flat[l.0 + 1..r.0] {
                let dur = if total > 0 {
                    span * (utf16_len(&w.w) + 1) as f64 / total as f64
                } else {
                    0.
                };
                w.s = cur;
                w.e = cur + dur;
                cur = w.e;
            }
        }
    }
    let last = marks[marks.len() - 1];
    let shift = last.2 - orig[last.0].1;
    let cap = if duration > 0. {
        duration
    } else {
        f64::INFINITY
    };
    for k in last.0 + 1..flat.len() {
        flat[k].s = (orig[k].0 + shift).min(cap);
        flat[k].e = (orig[k].1 + shift).max(flat[k].s + 0.05).min(cap + 0.5);
    }
    for k in 1..flat.len() {
        if flat[k].s < flat[k - 1].e - 0.01 {
            flat[k].s = flat[k - 1].e;
        }
        if flat[k].e < flat[k].s + 0.05 {
            flat[k].e = flat[k].s + 0.05;
        }
    }
    let mut k = 0;
    for line in &mut lines {
        for word in &mut line.words {
            *word = flat[k].clone();
            k += 1;
        }
        if let (Some(first), Some(last)) = (line.words.first(), line.words.last()) {
            line.start = first.s;
            line.end = last.e;
        }
    }
    lines
}
fn judgement(method: &str, matched: usize, total: usize, bad: Vec<usize>) -> Check {
    Check {
        method: method.into(),
        verdict: "mismatch".into(),
        matched_pct: if total > 0 {
            round(matched as f64 / total as f64 * 100.)
        } else {
            0.
        },
        median_shift: 0.,
        bad_lines: bad,
        extra_sung: false,
    }
}
fn finish(check: &mut Check, mut shifts: Vec<f64>) {
    shifts.sort_by(f64::total_cmp);
    let median = shifts.get(shifts.len() / 2).copied().unwrap_or(0.);
    check.median_shift = round(median * 100.) / 100.;
    check.verdict =
        if median.abs() <= 0.35 && check.bad_lines.is_empty() && check.matched_pct >= 70. {
            "match"
        } else {
            "retimed"
        }
        .into();
}
pub fn align_to_transcription(
    reference: &[Line],
    raw: &[Word],
    duration: f64,
    method: &str,
) -> Result<Outcome> {
    align_to_transcription_cancellable(reference, raw, duration, method, &|| false)
}
pub fn align_to_transcription_cancellable(
    reference: &[Line],
    raw: &[Word],
    duration: f64,
    method: &str,
    cancel: &impl Fn() -> bool,
) -> Result<Outcome> {
    let hyp = sanitize_hyp(raw);
    let anchors = global_anchors_cancellable(reference, &hyp, cancel)?;
    let got: Vec<_> = (0..reference.len())
        .map(|li| anchors.iter().filter(|a| a.li == li).count())
        .collect();
    let total = reference.iter().map(|l| l.words.len()).sum();
    let matched = got.iter().sum();
    let bad = reference
        .iter()
        .enumerate()
        .filter(|(li, l)| l.words.len() >= 3 && got[*li] as f64 / (l.words.len() as f64) < 0.4)
        .map(|(li, _)| li)
        .collect();
    let mut check = judgement(method, matched, total, bad);
    if check.matched_pct < 25. {
        return Ok(Outcome {
            lines: reference.to_vec(),
            check,
            slipped: vec![],
        });
    }
    let lines = retime(
        reference,
        &anchors
            .iter()
            .filter(|a| !check.bad_lines.contains(&a.li))
            .cloned()
            .collect::<Vec<_>>(),
        duration,
    );
    let times: HashSet<_> = anchors.iter().map(|a| a.s.to_bits()).collect();
    check.extra_sung = hyp.windows(10).any(|win| {
        win.iter()
            .filter(|w| times.contains(&w.s.to_bits()))
            .count()
            <= 2
            && win[9].e - win[0].s > 8.
    });
    finish(
        &mut check,
        lines
            .iter()
            .enumerate()
            .filter(|(i, _)| got[*i] > 0)
            .map(|(i, l)| l.start - reference[i].start)
            .collect(),
    );
    Ok(Outcome {
        lines,
        check,
        slipped: vec![],
    })
}
pub fn forced_lines(reference: &[Line], ctc: &[CtcWord], floor: f64) -> BTreeSet<usize> {
    forced_lines_cancellable(reference, ctc, floor, &|| false)
        .expect("non-cancellable CTC grouping")
}
fn grouped_ctc_scores(
    reference_len: usize,
    ctc: &[CtcWord],
    cancel: &impl Fn() -> bool,
) -> Result<(Vec<Vec<f64>>, HashSet<usize>)> {
    ensure!(!cancel(), "Alignment cancelled");
    let mut by_line = vec![Vec::new(); reference_len];
    let mut placed = HashSet::new();
    for (i, c) in ctc.iter().enumerate() {
        if i % 256 == 0 {
            ensure!(!cancel(), "Alignment cancelled");
        }
        placed.insert(c.li);
        if let Some(scores) = by_line.get_mut(c.li) {
            scores.push(c.score);
        }
    }
    for (i, scores) in by_line.iter_mut().enumerate() {
        if i % 64 == 0 {
            ensure!(!cancel(), "Alignment cancelled");
        }
        scores.sort_by(f64::total_cmp);
    }
    ensure!(!cancel(), "Alignment cancelled");
    Ok((by_line, placed))
}
fn forced_grouped(
    by_line: &[Vec<f64>],
    placed: &HashSet<usize>,
    floor: f64,
    cancel: &impl Fn() -> bool,
) -> Result<BTreeSet<usize>> {
    let mut forced = vec![];
    for (li, scores) in by_line.iter().enumerate() {
        if li % 64 == 0 {
            ensure!(!cancel(), "Alignment cancelled");
        }
        if !scores.is_empty() && scores[(scores.len() - 1) / 2] < floor {
            forced.push(li);
        }
    }
    let mut run = BTreeSet::new();
    let mut i = 0;
    while i < forced.len() {
        ensure!(!cancel(), "Alignment cancelled");
        let mut end = forced[i];
        let mut bridged = 0;
        let mut j = i + 1;
        while j < forced.len() {
            let gap = forced[j] - end - 1;
            if gap > 1 || bridged + gap > 1 {
                break;
            }
            bridged += gap;
            end = forced[j];
            j += 1;
        }
        for m in forced[i]..=end {
            if m % 128 == 0 {
                ensure!(!cancel(), "Alignment cancelled");
            }
            run.insert(m);
        }
        i = j;
    }
    let dropped = run.iter().filter(|li| placed.contains(li)).count();
    ensure!(!cancel(), "Alignment cancelled");
    Ok(
        if !placed.is_empty() && dropped as f64 > placed.len() as f64 * 0.5 {
            BTreeSet::new()
        } else {
            run
        },
    )
}
pub fn forced_lines_cancellable(
    reference: &[Line],
    ctc: &[CtcWord],
    floor: f64,
    cancel: &impl Fn() -> bool,
) -> Result<BTreeSet<usize>> {
    let (groups, placed) = grouped_ctc_scores(reference.len(), ctc, cancel)?;
    forced_grouped(&groups, &placed, floor, cancel)
}
pub fn ctc_outcome(reference: &[Line], ctc: &[CtcWord], duration: f64) -> Outcome {
    ctc_outcome_cancellable(reference, ctc, duration, &|| false)
        .expect("non-cancellable CTC outcome")
}
pub fn ctc_outcome_cancellable(
    reference: &[Line],
    ctc: &[CtcWord],
    duration: f64,
    cancel: &impl Fn() -> bool,
) -> Result<Outcome> {
    ensure!(!cancel(), "Alignment cancelled");
    let (groups, placed) = grouped_ctc_scores(reference.len(), ctc, cancel)?;
    let mut scores = Vec::with_capacity(ctc.len());
    for (i, c) in ctc.iter().enumerate() {
        if i % 256 == 0 {
            ensure!(!cancel(), "Alignment cancelled");
        }
        scores.push(c.score);
    }
    scores.sort_by(f64::total_cmp);
    ensure!(!cancel(), "Alignment cancelled");
    let median = scores.get(scores.len() / 2).copied().unwrap_or(0.);
    let floor = (median * 0.2).max(0.01);
    let mut heard = Vec::with_capacity(reference.len());
    for (i, group) in groups.iter().enumerate() {
        if i % 64 == 0 {
            ensure!(!cancel(), "Alignment cancelled");
        }
        heard.push(group.iter().filter(|s| **s >= floor).count());
    }
    let bad = reference
        .iter()
        .enumerate()
        .filter(|(li, l)| l.words.len() >= 3 && heard[*li] as f64 / (l.words.len() as f64) < 0.4)
        .map(|(li, _)| li)
        .collect();
    let mut check = judgement(
        "ctc",
        heard.iter().sum(),
        reference.iter().map(|l| l.words.len()).sum(),
        bad,
    );
    if check.matched_pct < 25. || median < 0.005 {
        return Ok(Outcome {
            lines: reference.to_vec(),
            check,
            slipped: vec![],
        });
    }
    let slipped = forced_grouped(&groups, &placed, floor, cancel)?;
    let mut anchors = vec![];
    for (i, c) in ctc.iter().enumerate() {
        if i % 256 == 0 {
            ensure!(!cancel(), "Alignment cancelled");
        }
        if c.voiced.is_none_or(|v| v >= 0.06) && !slipped.contains(&c.li) {
            anchors.push(Anchor {
                li: c.li,
                wi: c.wi,
                s: c.s,
                e: c.e,
                sim: c.score,
            });
        }
    }
    ensure!(!cancel(), "Alignment cancelled");
    let lines = retime(reference, &anchors, duration);
    ensure!(!cancel(), "Alignment cancelled");
    finish(
        &mut check,
        lines
            .iter()
            .enumerate()
            .filter(|(i, _)| heard[*i] > 0 && !slipped.contains(i))
            .map(|(i, l)| l.start - reference[i].start)
            .collect(),
    );
    Ok(Outcome {
        lines,
        check,
        slipped: slipped.into_iter().collect(),
    })
}
pub fn transcription_usable(raw: &[Word], ref_count: usize) -> bool {
    let words = sanitize_hyp(raw);
    if (words.len() as f64) < 12f64.max(ref_count as f64 * 0.2) {
        return false;
    }
    let toks: Vec<_> = words.iter().map(|w| norm(&w.w)).collect();
    for n in [1, 2] {
        let mut run = 1;
        for i in n..toks.len() {
            if toks[i] == toks[i - n] {
                run += 1;
                if run >= 12 {
                    return false;
                }
            } else {
                run = 1;
            }
        }
    }
    true
}
pub fn guess_language(reference: &[Line]) -> Option<&'static str> {
    let text = reference
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if text.chars().any(|c| ('\u{0400}'..='\u{04ff}').contains(&c)) {
        return Some("ru");
    }
    if text.chars().any(|c| ('\u{3040}'..='\u{30ff}').contains(&c)) {
        return Some("ja");
    }
    if text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)) {
        return Some("zh");
    }
    static SPLIT: OnceLock<Regex> = OnceLock::new();
    let words: HashSet<_> = SPLIT
        .get_or_init(|| Regex::new(r"[^\p{L}']+").unwrap())
        .split(&text)
        .filter(|s| !s.is_empty())
        .collect();
    let stop = [
        (
            "en",
            [
                "the", "and", "you", "your", "with", "was", "this", "that", "what", "all",
            ],
        ),
        (
            "de",
            [
                "der", "die", "und", "ich", "nicht", "ein", "mich", "ist", "du", "wenn",
            ],
        ),
        (
            "fr",
            [
                "le", "la", "les", "je", "tu", "dans", "pas", "que", "est", "mon",
            ],
        ),
        (
            "es",
            [
                "el", "la", "los", "que", "de", "por", "con", "para", "mi", "tu",
            ],
        ),
        (
            "it",
            [
                "il", "la", "che", "di", "non", "per", "con", "una", "mi", "sono",
            ],
        ),
    ];
    let (mut best, mut hits) = (None, 0);
    for (lang, stop) in stop {
        let h = stop.iter().filter(|w| words.contains(**w)).count();
        if h > hits {
            best = Some(lang);
            hits = h;
        }
    }
    if hits >= 3 { best } else { None }
}
pub fn romanize(word: &str) -> String {
    let mut out = String::new();
    for c in word.to_lowercase().chars() {
        let mapped = match c {
            'а' => Some("a"),
            'б' => Some("b"),
            'в' => Some("v"),
            'г' | 'ґ' => Some("g"),
            'д' => Some("d"),
            'е' => Some("e"),
            'ё' => Some("yo"),
            'ж' => Some("zh"),
            'з' => Some("z"),
            'и' | 'і' => Some("i"),
            'й' | 'ы' => Some("y"),
            'к' => Some("k"),
            'л' => Some("l"),
            'м' => Some("m"),
            'н' => Some("n"),
            'о' => Some("o"),
            'п' => Some("p"),
            'р' => Some("r"),
            'с' => Some("s"),
            'т' => Some("t"),
            'у' => Some("u"),
            'ф' => Some("f"),
            'х' => Some("h"),
            'ц' => Some("ts"),
            'ч' => Some("ch"),
            'ш' => Some("sh"),
            'щ' => Some("sch"),
            'ъ' | 'ь' => Some(""),
            'э' => Some("e"),
            'ю' => Some("yu"),
            'я' => Some("ya"),
            'є' => Some("ye"),
            'ї' => Some("yi"),
            _ => None,
        };
        if let Some(mapped) = mapped {
            out.push_str(mapped);
        } else {
            for p in c.to_string().nfkd().filter(|p| !is_combining_mark(*p)) {
                if p.is_ascii_lowercase() || p == '\'' {
                    out.push(p);
                }
            }
        }
    }
    out
}
pub fn assign_words_to_chunks(total: usize, anchors: &HashMap<usize, usize>) -> Vec<usize> {
    let mut out = vec![None; total];
    for (&i, &ci) in anchors {
        if i < total {
            out[i] = Some(ci);
        }
    }
    for i in 0..total {
        if out[i].is_some() {
            continue;
        }
        let before = out[..i].iter().rev().find_map(|v| *v);
        let after = out[i + 1..].iter().find_map(|v| *v);
        out[i] = Some(before.or(after).unwrap_or(0));
    }
    out.into_iter().map(Option::unwrap).collect()
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ChunkText {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub label: Option<String>,
}
pub fn lines_from_chunks(chunks: &[ChunkText]) -> Vec<Line> {
    let mut lines = vec![];
    for c in chunks {
        let words: Vec<_> = c
            .text
            .split(js_whitespace)
            .filter(|w| !w.is_empty())
            .collect();
        if words.is_empty() {
            continue;
        }
        let mut groups = vec![];
        let mut cur = vec![];
        for w in words {
            cur.push(w);
            if cur.len() >= 10 || w.ends_with(['.', '!', '?']) {
                groups.push(std::mem::take(&mut cur));
            }
        }
        if !cur.is_empty() {
            groups.push(cur);
        }
        let span = (c.end - c.start).max(0.1);
        let total: usize = groups.iter().map(Vec::len).sum();
        let mut at = c.start;
        for group in groups {
            let dur = span * group.len() as f64 / total as f64;
            let per = dur / group.len() as f64;
            let words = group
                .iter()
                .enumerate()
                .map(|(i, w)| Word {
                    w: (*w).into(),
                    s: at + i as f64 * per,
                    e: at + (i + 1) as f64 * per,
                })
                .collect();
            lines.push(Line {
                start: at,
                end: at + dur,
                text: group.join(" "),
                words,
            });
            at += dur;
        }
    }
    lines
}
pub fn looks_looped(text: &str, finish: Option<&str>) -> bool {
    if finish == Some("length") {
        return true;
    }
    let toks: Vec<_> = text
        .split(js_whitespace)
        .map(norm)
        .filter(|w| !w.is_empty())
        .collect();
    for n in [1, 2, 3] {
        let mut run = 0;
        for i in n..toks.len() {
            if toks[i] == toks[i - n] {
                run += 1;
                if run >= 8 * n {
                    return true;
                }
            } else {
                run = 0;
            }
        }
    }
    false
}
pub fn majority_language(chunks: &[ChunkText]) -> Option<String> {
    let mut weights: Vec<(String, f64)> = vec![];
    for c in chunks {
        let Some(label) = c
            .label
            .as_ref()
            .filter(|l| !l.is_empty() && l.as_str() != "None")
        else {
            continue;
        };
        if let Some(w) = weights.iter_mut().find(|w| w.0 == *label) {
            w.1 += c.end - c.start;
        } else {
            weights.push((label.clone(), c.end - c.start));
        }
    }
    let mut best = None;
    let mut weight = f64::NEG_INFINITY;
    for (l, w) in weights {
        if w > weight {
            best = Some(l);
            weight = w;
        }
    }
    best
}

#[cfg(test)]
#[path = "alignmentoutcome_tests.rs"]
mod tests;
