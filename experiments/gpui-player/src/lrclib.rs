//! Native LRCLIB core and sequential, cancellable bounded curl transport.
use crate::lyrics_edit::{Line, Word, js_whitespace, trim_text, utf16_len};
use anyhow::{Context, Result, bail, ensure};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

const API: &str = "https://lrclib.net/api";
const BODY_LIMIT: u64 = 8 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Candidate {
    pub id: u64,
    pub track: String,
    pub artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    pub duration: f64,
    pub synced: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMeta {
    pub artist: Option<String>,
    pub title: String,
    pub album: Option<String>,
    pub duration_sec: f64,
    pub alt_title: Option<String>,
}
#[derive(Clone, Debug, Default)]
pub struct SearchQuery {
    pub artist: Option<String>,
    pub title: Option<String>,
    pub free: Option<String>,
}
#[derive(Clone, Debug)]
pub struct Hit {
    pub lines: Vec<Line>,
    pub credit: String,
}
#[derive(Clone, Debug)]
pub enum Lookup {
    Hit { lines: Vec<Line>, credit: String },
    Miss,
    Down,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    #[serde(default)]
    id: Option<u64>,
    track_name: Option<String>,
    artist_name: Option<String>,
    album_name: Option<String>,
    duration: Option<f64>,
    #[serde(default)]
    instrumental: Option<bool>,
    synced_lyrics: Option<String>,
}
enum Answer {
    Json(Value),
    Miss,
    Down,
}
struct State {
    failures: HashMap<String, Instant>,
    server_until: Option<Instant>,
    last_finished: Option<Instant>,
}
pub struct Client {
    base: String,
    state: Mutex<State>,
}
impl Default for Client {
    fn default() -> Self {
        Self::at(API.into())
    }
}
impl Client {
    fn at(base: String) -> Self {
        Self {
            base,
            state: Mutex::new(State {
                failures: HashMap::new(),
                server_until: None,
                last_finished: None,
            }),
        }
    }
    #[cfg(any(test, feature = "ui-tests"))]
    pub fn with_base_url(base: &str) -> Result<Self> {
        ensure!(
            base.starts_with("http://"),
            "LRCLIB test URL must use local HTTP"
        );
        let authority = base[7..].split('/').next().unwrap_or("");
        let host = authority.split(':').next().unwrap_or("");
        ensure!(
            host == "127.0.0.1" || host == "localhost",
            "LRCLIB test URL must be loopback"
        );
        ensure!(
            !authority.contains('@') && !base.contains(['\r', '\n', '?', '#']),
            "Invalid LRCLIB test URL"
        );
        Ok(Self::at(base.trim_end_matches('/').into()))
    }
    pub fn retry_now(&self) -> Result<()> {
        self.state
            .lock()
            .map_err(|_| anyhow::anyhow!("LRCLIB transport state failed"))?
            .failures
            .clear();
        Ok(())
    }
    fn request(&self, path: &str, cancel: &impl Fn() -> bool) -> Result<Answer> {
        ensure!(
            path.starts_with('/') && path.len() <= 16384,
            "LRCLIB request is too large"
        );
        let mut state = loop {
            check(cancel)?;
            match self.state.try_lock() {
                Ok(state) => break state,
                Err(std::sync::TryLockError::WouldBlock) => thread::sleep(Duration::from_millis(5)),
                Err(_) => bail!("LRCLIB transport state failed"),
            }
        };
        let family = if path.starts_with("/get/") {
            "/get/:id"
        } else {
            path.split('?').next().unwrap_or(path)
        }
        .to_owned();
        if state
            .failures
            .get(&family)
            .is_some_and(|until| Instant::now() < *until)
        {
            return Ok(Answer::Down);
        }
        state.failures.remove(&family);
        for attempt in 1..=3 {
            let now = Instant::now();
            let next = state
                .server_until
                .into_iter()
                .chain(state.last_finished.map(|t| t + Duration::from_millis(250)))
                .max();
            if let Some(next) = next {
                let delay = next.saturating_duration_since(now);
                if delay > Duration::from_secs(2) {
                    return Ok(Answer::Down);
                }
                wait(delay, cancel)?;
            }
            let response = fetch(&format!("{}{}", self.base, path), cancel);
            state.last_finished = Some(Instant::now());
            check(cancel)?;
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    eprintln!("LRCLIB: {error:#}");
                    state
                        .failures
                        .insert(family.clone(), Instant::now() + Duration::from_secs(300));
                    return Ok(Answer::Down);
                }
            };
            if matches!(response.status, 429 | 503) {
                let retry = response
                    .headers
                    .get("retry-after")
                    .and_then(|value| retry_after(value, SystemTime::now()));
                let minimum = retry.unwrap_or(Duration::from_secs(if response.status == 429 {
                    60
                } else {
                    1
                }));
                let pause = jitter(minimum);
                let until = Instant::now()
                    .checked_add(pause)
                    .unwrap_or_else(|| Instant::now() + Duration::from_secs(86400 * 365));
                state.server_until = Some(state.server_until.map_or(until, |old| old.max(until)));
                if response.status == 503
                    && retry.is_some()
                    && pause <= Duration::from_secs(2)
                    && attempt < 3
                {
                    continue;
                }
                if response.status == 503 {
                    state
                        .failures
                        .insert(family.clone(), Instant::now() + Duration::from_secs(30));
                }
                return Ok(Answer::Down);
            }
            if response.status == 404 {
                return Ok(Answer::Miss);
            }
            if !(200..300).contains(&response.status) {
                state.failures.insert(
                    family.clone(),
                    Instant::now()
                        + Duration::from_secs(if response.status == 400 { 0 } else { 300 }),
                );
                return Ok(Answer::Down);
            }
            let decoded = serde_json::from_slice(&response.body);
            state.last_finished = Some(Instant::now());
            match decoded {
                Ok(value) => return Ok(Answer::Json(value)),
                Err(_) => {
                    state
                        .failures
                        .insert(family.clone(), Instant::now() + Duration::from_secs(300));
                    return Ok(Answer::Down);
                }
            }
        }
        Ok(Answer::Down)
    }
    pub fn search(
        &self,
        query: &SearchQuery,
        duration: f64,
        cancel: &impl Fn() -> bool,
    ) -> Result<Vec<Candidate>> {
        valid_duration(duration)?;
        let mut params = vec![];
        if let Some(free) = query.free.as_deref().filter(|s| !s.is_empty()) {
            params.push(("q", free.to_owned()));
        } else {
            if let Some(title) = query.title.as_deref().filter(|s| !s.is_empty()) {
                params.push(("track_name", title.into()));
            }
            if let Some(artist) = query.artist.as_deref().filter(|s| !s.is_empty()) {
                params.push(("artist_name", artist.into()));
            }
        }
        let Answer::Json(Value::Array(records)) =
            self.request(&format!("/search?{}", query_string(&params)?), cancel)?
        else {
            return Ok(vec![]);
        };
        ensure!(records.len() <= 10000, "Too many LRCLIB candidates");
        let mut candidates = vec![];
        for record in records {
            check(cancel)?;
            let Ok(record) = serde_json::from_value::<Record>(record) else {
                continue;
            };
            let Some(id) = record.id else {
                continue;
            };
            candidates.push(Candidate {
                id,
                artist: record.artist_name.unwrap_or_default(),
                track: record.track_name.unwrap_or_default(),
                album: record.album_name,
                duration: record.duration.unwrap_or(0.),
                synced: record.synced_lyrics.as_ref().is_some_and(|s| !s.is_empty())
                    && !record.instrumental.unwrap_or(false),
            });
        }
        candidates.sort_by(|a, b| {
            b.synced.cmp(&a.synced).then_with(|| {
                (a.duration - duration)
                    .abs()
                    .total_cmp(&(b.duration - duration).abs())
            })
        });
        candidates.truncate(15);
        Ok(candidates)
    }
    pub fn by_id(&self, id: u64, duration: f64, cancel: &impl Fn() -> bool) -> Result<Option<Hit>> {
        valid_duration(duration)?;
        let Answer::Json(value) = self.request(&format!("/get/{id}"), cancel)? else {
            return Ok(None);
        };
        let Ok(record) = serde_json::from_value::<Record>(value) else {
            return Ok(None);
        };
        record_hit(&record, duration)
    }
    pub fn lookup(&self, meta: &TrackMeta, cancel: &impl Fn() -> bool) -> Result<Lookup> {
        valid_duration(meta.duration_sec)?;
        let mut saw_down = false;
        let mut titles = vec![meta.title.as_str()];
        if let Some(alt) = meta.alt_title.as_deref().filter(|s| *s != meta.title) {
            titles.push(alt);
        }
        for (index, title) in titles.into_iter().enumerate() {
            let mut rung_down = false;
            let mut artists = vec![meta.artist.clone()];
            artists.extend(
                artist_fallbacks(meta.artist.as_deref())
                    .into_iter()
                    .map(Some),
            );
            for artist in artists {
                check(cancel)?;
                let record = self.probe(meta, title, artist.as_deref(), &mut rung_down, cancel)?;
                if let Some(record) = record {
                    // An answered record with unusable LRC is a final miss,
                    // even when an earlier request went unanswered.
                    return Ok(match record_hit(&record, meta.duration_sec)? {
                        Some(hit) => Lookup::Hit {
                            lines: hit.lines,
                            credit: hit.credit,
                        },
                        None => {
                            if index > 0 && saw_down {
                                Lookup::Down
                            } else {
                                Lookup::Miss
                            }
                        }
                    });
                }
            }
            // The source recursively retries altTitle: a down verdict from
            // that last spelling supersedes an earlier rung's miss verdict.
            if index > 0 && rung_down {
                return Ok(Lookup::Down);
            }
            saw_down |= rung_down;
        }
        Ok(if saw_down { Lookup::Down } else { Lookup::Miss })
    }
    fn probe(
        &self,
        meta: &TrackMeta,
        title: &str,
        artist: Option<&str>,
        down: &mut bool,
        cancel: &impl Fn() -> bool,
    ) -> Result<Option<Record>> {
        if let Some(artist) = artist.filter(|s| !s.is_empty()) {
            let mut params = vec![
                ("artist_name", artist.into()),
                ("track_name", title.into()),
                ("duration", format!("{:.0}", meta.duration_sec.round())),
            ];
            if let Some(album) = meta.album.as_deref().filter(|s| !s.is_empty()) {
                params.push(("album_name", album.into()));
            }
            match self.request(&format!("/get?{}", query_string(&params)?), cancel)? {
                Answer::Down => *down = true,
                Answer::Json(value) => {
                    if let Ok(record) = serde_json::from_value::<Record>(value) {
                        if usable(&record) {
                            return Ok(Some(record));
                        }
                    }
                }
                Answer::Miss => {}
            }
        }
        let mut params = vec![("track_name", title.into())];
        if let Some(artist) = artist.filter(|s| !s.is_empty()) {
            params.push(("artist_name", artist.into()));
        }
        match self.request(&format!("/search?{}", query_string(&params)?), cancel)? {
            Answer::Down => *down = true,
            Answer::Json(Value::Array(values)) => {
                ensure!(values.len() <= 10000, "Too many LRCLIB records");
                let mut best = None;
                let mut distance = f64::INFINITY;
                for value in values {
                    check(cancel)?;
                    if let Ok(record) = serde_json::from_value::<Record>(value) {
                        let d = (record.duration.unwrap_or(0.) - meta.duration_sec).abs();
                        if usable(&record) && d < distance {
                            distance = d;
                            best = Some(record);
                        }
                    }
                }
                if distance <= 5. {
                    return Ok(best);
                }
            }
            _ => {}
        }
        Ok(None)
    }
}
fn usable(record: &Record) -> bool {
    !record.instrumental.unwrap_or(false)
        && record.synced_lyrics.as_ref().is_some_and(|s| !s.is_empty())
}
fn record_hit(record: &Record, duration: f64) -> Result<Option<Hit>> {
    let Some(lrc) = record.synced_lyrics.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let lines = parse_lrc(lrc, duration)?;
    Ok((!lines.is_empty()).then(|| Hit {
        lines,
        credit: [record.artist_name.as_deref(), record.track_name.as_deref()]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" — "),
    }))
}
fn valid_duration(duration: f64) -> Result<()> {
    ensure!(
        duration.is_finite() && (0. ..=86400. * 365.).contains(&duration),
        "Invalid lyrics duration"
    );
    Ok(())
}
fn check(cancel: &impl Fn() -> bool) -> Result<()> {
    ensure!(!cancel(), "LRCLIB request cancelled");
    Ok(())
}
fn wait(duration: Duration, cancel: &impl Fn() -> bool) -> Result<()> {
    let until = Instant::now() + duration;
    while Instant::now() < until {
        check(cancel)?;
        thread::sleep(
            until
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(5)),
        );
    }
    check(cancel)
}
fn jitter(duration: Duration) -> Duration {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    Duration::from_millis(
        (duration.as_secs_f64() * 1000. * (1. + (nanos % 10000) as f64 / 10000. * 0.3))
            .ceil()
            .min(u64::MAX as f64) as u64,
    )
}
pub fn retry_after(value: &str, now: SystemTime) -> Option<Duration> {
    let text = trim_text(value);
    if text.is_empty() {
        return None;
    }
    static NUMBER: OnceLock<Regex> = OnceLock::new();
    let numeric = NUMBER.get_or_init(|| Regex::new(r"^[0-9]+(?:\.[0-9]+)?$").unwrap());
    if numeric.is_match(text) {
        let seconds = text.parse::<f64>().ok()?;
        if !(seconds * 1000.).is_finite() {
            return None;
        }
        return Some(Duration::try_from_secs_f64(seconds).unwrap_or(Duration::MAX));
    }
    let start = text.trim_start_matches(['+', '-']).chars().next();
    if start.is_some_and(|c| c.is_ascii_digit()) {
        return None;
    }
    let parsed = chrono::DateTime::parse_from_rfc2822(text).ok()?;
    let timestamp = parsed.timestamp_millis() as f64;
    let now = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?
        .as_secs_f64()
        * 1000.;
    Some(Duration::from_millis((timestamp - now).max(0.) as u64))
}
fn query_string(params: &[(&str, String)]) -> Result<String> {
    let text = params
        .iter()
        .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    ensure!(text.len() <= 16000, "LRCLIB query is too large");
    Ok(text)
}
fn encode(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
fn js_regex(pattern: &str) -> Regex {
    const SPACE: &str = r"[\x{0009}-\x{000d}\x{0020}\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";
    const NON_SPACE: &str = r"[^\x{0009}-\x{000d}\x{0020}\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";
    Regex::new(&pattern.replace(r"\s", SPACE).replace(r"\S", NON_SPACE))
        .expect("Source LRCLIB regular expression")
}

pub fn cp1251_from_latin1(value: &str) -> String {
    const HIGH: &str = "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u{0098}™љ›њќћџ\u{00a0}ЎўЈ¤Ґ¦§Ё©Є«¬\u{00ad}®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя";
    let table: Vec<_> = HIGH.chars().collect();
    value
        .chars()
        .map(|c| {
            if (0x80..=0xff).contains(&(c as u32)) {
                table[c as usize - 0x80]
            } else {
                c
            }
        })
        .collect()
}
pub fn fix_tag_encoding(value: &str) -> String {
    if value
        .chars()
        .any(|c| ('\u{0400}'..='\u{04ff}').contains(&c) || c as u32 > 255)
    {
        return value.into();
    }
    let suspicious = value.chars().filter(|c| *c as u32 >= 128).count();
    let ascii = value.chars().filter(|c| c.is_ascii_alphabetic()).count();
    if suspicious < 3 || suspicious < ascii {
        return value.into();
    }
    let fixed = cp1251_from_latin1(value);
    if fixed
        .chars()
        .any(|c| ('\u{0400}'..='\u{04ff}').contains(&c))
    {
        fixed
    } else {
        value.into()
    }
}
pub fn real_artist(value: Option<&str>) -> Option<String> {
    let value = value.filter(|s| !s.is_empty())?;
    if [
        "artist",
        "unknown",
        "unknown artist",
        "va",
        "various",
        "various artists",
        "артист",
        "исполнитель",
        "неизвестен",
        "неизвестный",
        "неизвестный исполнитель",
    ]
    .contains(&value.to_lowercase().as_str())
    {
        None
    } else {
        Some(value.into())
    }
}
pub fn primary_artist(value: Option<&str>) -> Option<String> {
    let value = value?;
    static COLLAB: OnceLock<Regex> = OnceLock::new();
    let pattern=COLLAB.get_or_init(||Regex::new(r"[,&/]|(?:[\t-\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+)(?:(?i-u:feat|ft|featuring|with|vs|x)|[иИ])\.?(?:[\t-\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]|$)").unwrap());
    let end = pattern.find(value)?.start();
    let lead = trim_text(&value[..end]);
    (utf16_len(lead) >= 2 && lead != trim_text(value)).then(|| lead.into())
}
pub fn strip_site_prefix(value: Option<&str>) -> Option<String> {
    let value = value?;
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns=PATTERNS.get_or_init(||{
        let tld="(?i-u:ru|su|ua|by|kz|net|com|org|pro|info|biz|cc|top|club|online|site|xyz|mobi|fm|tv|ws)";
        [format!(r"^[\[(][^\])]*\.{tld}[^\])]*[\])][\s|_-]*"),format!(r"^(?:(?i-u:www)\.)?[a-zA-Z0-9_-]+\.{tld}[\s|_-]+"),r"^\S*?[_-](?i-u:download|mp3)[_-]+".into()].iter().map(|pattern|js_regex(pattern)).collect()
    });
    for pattern in patterns {
        let rest = pattern.replace(value, "");
        let rest = trim_text(&rest);
        if rest != trim_text(value)
            && utf16_len(rest) >= 2
            && rest
                .chars()
                .any(|c| !js_whitespace(c) && !c.is_ascii_digit() && !"_.,|/\\()[]-".contains(c))
        {
            return Some(rest.into());
        }
    }
    None
}
fn artist_fallbacks(value: Option<&str>) -> Vec<String> {
    let no_site = strip_site_prefix(value);
    let mut result = vec![];
    for value2 in [
        primary_artist(value),
        no_site.clone(),
        primary_artist(no_site.as_deref()),
    ]
    .into_iter()
    .flatten()
    {
        if Some(value2.as_str()) != value && !result.contains(&value2) {
            result.push(value2);
        }
    }
    result
}
pub fn meta_from_filename(filename: &str, duration_sec: f64) -> TrackMeta {
    fn clean(input: &str, strip: bool) -> (Option<String>, String) {
        static EXT: OnceLock<Regex> = OnceLock::new();
        static TRACK: OnceLock<Regex> = OnceLock::new();
        static BRACKETS: OnceLock<Regex> = OnceLock::new();
        static SPACES: OnceLock<Regex> = OnceLock::new();
        static SPLIT: OnceLock<Regex> = OnceLock::new();
        let ext = EXT.get_or_init(|| {
            Regex::new(r"\.(?i-u:mp3|wav|flac|m4a|aac|ogg|oga|opus|aif|aiff)$").unwrap()
        });
        let mut text = ext.replace(input, "").into_owned();
        if strip {
            text = TRACK
                .get_or_init(|| js_regex(r"^\s*[0-9]{1,3}[\s.\-_]+"))
                .replace(&text, "")
                .into_owned();
        }
        text = BRACKETS
            .get_or_init(|| Regex::new(r"[\[(][^\])]*[\])]").unwrap())
            .replace_all(&text, " ")
            .into_owned();
        text = SPACES
            .get_or_init(|| js_regex(r"\s{2,}"))
            .replace_all(&text, " ")
            .into_owned();
        let parts: Vec<_> = SPLIT
            .get_or_init(|| js_regex(r"\s+-\s+"))
            .split(trim_text(&text))
            .collect();
        if parts.len() >= 2 {
            (Some(parts[0].into()), parts[1..].join(" - "))
        } else {
            (None, trim_text(&text).into())
        }
    }
    let (artist, title) = clean(filename, true);
    let (_, unstripped) = clean(filename, false);
    let alt_title = (unstripped != title).then_some(unstripped);
    TrackMeta {
        artist,
        title,
        alt_title,
        album: None,
        duration_sec,
    }
}
pub fn metadata(
    filename: &str,
    artist: Option<&str>,
    title: Option<&str>,
    album: Option<&str>,
    duration_sec: f64,
) -> (TrackMeta, TrackMeta) {
    let from_file = meta_from_filename(filename, duration_sec);
    let artist = artist.map(trim_text).map(fix_tag_encoding);
    let artist = real_artist(artist.as_deref());
    let title = title
        .map(trim_text)
        .map(fix_tag_encoding)
        .filter(|s| !s.is_empty())
        .map(|s| meta_from_filename(&s, duration_sec));
    let meta = TrackMeta {
        artist: artist
            .or_else(|| title.as_ref().and_then(|t| t.artist.clone()))
            .or_else(|| from_file.artist.clone()),
        title: title
            .as_ref()
            .map(|t| t.title.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| from_file.title.clone()),
        alt_title: title
            .as_ref()
            .filter(|t| !t.title.is_empty())
            .map(|t| t.alt_title.clone())
            .unwrap_or_else(|| from_file.alt_title.clone()),
        album: album.map(trim_text).map(fix_tag_encoding),
        duration_sec,
    };
    (meta, from_file)
}
pub fn parse_lrc(lrc: &str, duration: f64) -> Result<Vec<Line>> {
    valid_duration(duration)?;
    ensure!(
        lrc.len() as u64 <= BODY_LIMIT,
        "LRCLIB lyrics are too large"
    );
    static STAMP: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    let stamp = STAMP
        .get_or_init(|| Regex::new(r"\[([0-9]{1,2}):([0-9]{2})(?:[.:]([0-9]{1,3}))?\]").unwrap());
    let tag = TAG.get_or_init(|| Regex::new(r"\[[^\]]*\]").unwrap());
    let mut stamped = vec![];
    for raw in lrc.split('\n') {
        let text = std::sync::Arc::new(trim_text(&tag.replace_all(raw, "")).to_owned());
        for capture in stamp.captures_iter(raw) {
            ensure!(stamped.len() < 30000, "Too many LRC timestamps");
            let start = capture[1].parse::<f64>()? * 60.
                + capture[2].parse::<f64>()?
                + capture
                    .get(3)
                    .map(|fraction| format!("0.{}", fraction.as_str()).parse::<f64>().unwrap())
                    .unwrap_or(0.);
            stamped.push((start, text.clone()));
        }
    }
    stamped.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut result = vec![];
    let mut count = 0;
    let mut text_bytes = 0u64;
    for (index, (start, text)) in stamped.iter().enumerate() {
        if text.is_empty() {
            continue;
        }
        ensure!(result.len() < 10000, "Too many LRC lines");
        let next = stamped
            .get(index + 1)
            .map(|line| line.0)
            .unwrap_or((start + 1.).max(duration));
        let sung = (utf16_len(text) as f64 / 12.).clamp(1.2, 9.);
        let end = (next - 0.05).max(start + 0.8).min(start + sung);
        text_bytes += text.len() as u64 * 2;
        ensure!(
            text_bytes <= BODY_LIMIT,
            "Expanded LRC lyrics are too large"
        );
        let parts: Vec<_> = text
            .split(js_whitespace)
            .filter(|part| !part.is_empty())
            .collect();
        count += parts.len();
        ensure!(count <= 30000, "Too many LRC words");
        let total = parts.iter().map(|part| utf16_len(part) + 1).sum::<usize>() as f64;
        let mut cursor = *start;
        let mut words = vec![];
        for part in parts {
            ensure!(part.chars().count() <= 1024, "LRC word is too long");
            let before = cursor;
            cursor = end.min(cursor + (end - start) * (utf16_len(part) + 1) as f64 / total);
            words.push(Word {
                w: part.into(),
                s: fixed3(before),
                e: fixed3(cursor),
            });
        }
        result.push(Line {
            start: *start,
            end,
            text: text.as_str().to_owned(),
            words,
        });
    }
    Ok(result)
}
fn fixed3(value: f64) -> f64 {
    if value == 0. {
        return 0.;
    }
    let bits = value.to_bits();
    let significand = (bits & ((1u64 << 52) - 1)) | (1u64 << 52);
    let exponent = ((bits >> 52) & 0x7ff) as i32 - 1023 - 52;
    let scaled = significand as u128 * 1000;
    let rounded = if exponent >= 0 {
        scaled.checked_shl(exponent as u32).unwrap_or(u128::MAX)
    } else {
        let shift = (-exponent) as u32;
        if shift >= 128 {
            0
        } else {
            let unit = 1u128 << shift;
            scaled / unit + u128::from((scaled % unit) * 2 >= unit)
        }
    };
    rounded as f64 / 1000.
}

struct Response {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(Some(_)) | Err(_)) {
            return;
        }
        #[cfg(unix)]
        {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            unsafe {
                kill(-(self.0.id() as i32), 9);
            }
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn fetch(url: &str, cancel: &impl Fn() -> bool) -> Result<Response> {
    check(cancel)?;
    let path = std::env::temp_dir().join(format!(
        "singz-lrclib-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700).create(&path)?;
    }
    #[cfg(not(unix))]
    fs::create_dir(&path)?;
    let scratch = Scratch(path);
    let body = scratch.0.join("body");
    let headers = scratch.0.join("headers");
    let status = scratch.0.join("status");
    let errors = scratch.0.join("errors");
    let stdout = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&status)?;
    let stderr = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&errors)?;
    let mut command = Command::new(if cfg!(windows) { "curl.exe" } else { "curl" });
    let client = format!(
        "SingZ/{} (https://github.com/lexasoft123/SingZ)",
        crate::release_highlights::CURRENT_VERSION
    );
    command
        .args([
            "--disable",
            "--silent",
            "--show-error",
            "--max-time",
            "10",
            "--connect-timeout",
            "10",
            "--max-filesize",
            "8388608",
            "--compressed",
            "--header",
            "Accept: application/json",
            "--user-agent",
        ])
        .arg(&client)
        .arg("--header")
        .arg(format!("Lrclib-Client: {client}"))
        .arg("--dump-header")
        .arg(&headers)
        .arg("--output")
        .arg(&body)
        .args([
            "--write-out",
            "%{http_code}",
            "--proto",
            if url.starts_with("http://") {
                "=http"
            } else {
                "=https"
            },
        ]);
    if !url.starts_with("http://") {
        command.args(["--location", "--max-redirs", "5", "--proto-redir", "=https"]);
    }
    command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut process = Running(command.spawn().context("Could not start native curl")?);
    let deadline = Instant::now() + Duration::from_secs(11);
    let code = loop {
        check(cancel)?;
        for (file, limit) in [
            (&body, BODY_LIMIT),
            (&headers, 65536),
            (&status, 32),
            (&errors, 65536),
        ] {
            if let Ok(meta) = fs::metadata(file) {
                ensure!(meta.len() <= limit, "LRCLIB response exceeds its bound");
            }
        }
        if let Some(code) = process.0.try_wait()? {
            break code;
        }
        ensure!(Instant::now() < deadline, "LRCLIB request timed out");
        thread::sleep(Duration::from_millis(5));
    };
    let bounded = |path: &PathBuf, limit: u64| -> Result<Vec<u8>> {
        let mut value = vec![];
        File::open(path)?.take(limit + 1).read_to_end(&mut value)?;
        ensure!(
            value.len() as u64 <= limit,
            "LRCLIB response exceeds its bound"
        );
        Ok(value)
    };
    if !code.success() {
        let bytes = bounded(&errors, 65536)?;
        let detail: String = String::from_utf8_lossy(&bytes)
            .chars()
            .take(300)
            .map(|c| {
                if matches!(c, '\n' | '\r' | '\t') {
                    ' '
                } else {
                    c
                }
            })
            .collect();
        bail!("Native LRCLIB request failed: {detail}");
    }
    let status = String::from_utf8(bounded(&status, 32)?)?.parse::<u16>()?;
    let raw = String::from_utf8_lossy(&bounded(&headers, 65536)?).into_owned();
    let mut fields = HashMap::new();
    for line in raw.lines() {
        if line.starts_with("HTTP/") {
            fields.clear();
        } else if let Some((name, value)) = line.split_once(':') {
            fields.insert(name.to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    Ok(Response {
        status,
        headers: fields,
        body: bounded(&body, BODY_LIMIT)?,
    })
}

#[cfg(test)]
#[path = "lrclib_tests.rs"]
mod tests;
