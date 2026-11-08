//! Independent, conflict-checked lyrics editing. No project mix write is needed
//! to make an explicit editor Save durable.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::path::Path;

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub raw: Option<Value>,
    pub fingerprint: Option<String>,
    pub document: Option<crate::project_lyrics::Document>,
}

/// Hash an existing ordinary file even when its JSON needs repair. Missing is
/// distinct from unreadable, malformed, linked or oversized metadata.
pub fn identity(dir: &Path) -> Result<Option<String>> {
    let dir = dir.canonicalize()?;
    Ok(crate::project_store::member_bytes(&dir, "lyrics.json")?
        .map(|bytes| crate::project_store::fingerprint(&bytes)))
}

pub fn read(dir: &Path) -> Result<Snapshot> {
    let dir = dir.canonicalize()?;
    crate::project_publish::recover(&dir)?;
    let Some(bytes) = crate::project_store::member_bytes(&dir, "lyrics.json")? else {
        return Ok(Snapshot::default());
    };
    let raw: Value = serde_json::from_slice(&bytes).context("Invalid lyrics.json")?;
    let document = crate::project_lyrics::from_value(&raw)?;
    Ok(Snapshot {
        raw: Some(raw),
        fingerprint: Some(crate::project_store::fingerprint(&bytes)),
        document,
    })
}

/// Build and validate the same document Save will publish. Glyph preparation can
/// use this before writing so a texture refusal does not report a saved draft as
/// an ordinary unsaved failure.
pub fn edited_value(
    previous: Option<&Value>,
    lines: &Value,
    credit: Option<&str>,
) -> Result<(Value, crate::project_lyrics::Document)> {
    let rows = lines
        .as_array()
        .context("Edited lyric lines must be an array")?;
    ensure!(!rows.is_empty(), "No lyric lines to save");
    ensure!(rows.len() <= 10_000, "Too many lyric lines");
    ensure!(
        rows.iter().all(|line| line["text"]
            .as_str()
            .is_some_and(|s| !crate::lyrics_edit::trim_text(s).is_empty())),
        "Edited lyric lines cannot be empty"
    );
    let mut raw = previous
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    raw["source"] = json!("edited");
    raw["lines"] = lines.clone();
    for derived in [
        "aligned",
        "check",
        "base",
        "engine",
        "lrclibPending",
        "lookup",
    ] {
        raw.as_object_mut().unwrap().remove(derived);
    }
    if let Some(credit) = credit {
        ensure!(credit.len() <= 8192, "Lyrics credit is too long");
        raw["credit"] = json!(credit);
    } else {
        raw.as_object_mut().unwrap().remove("credit");
    }
    let document = crate::project_lyrics::from_value(&raw)?.context("No lyric lines to save")?;
    ensure!(
        document.lines.len() == rows.len(),
        "Edited lyric lines could not be preserved"
    );
    ensure!(
        serde_json::to_vec(&raw)?.len() <= 8 * 1024 * 1024,
        "Lyrics file is too large"
    );
    Ok((raw, document))
}

pub fn save(
    dir: &Path,
    expected: Option<&str>,
    lines: &Value,
    credit: Option<&str>,
) -> Result<Snapshot> {
    let dir = dir.canonicalize()?;
    let _lease = crate::project_publish::lock(&dir)?;
    crate::project_publish::recover_locked(&dir)?;
    let previous = crate::project_store::member_bytes(&dir, "lyrics.json")?;
    let identity = previous
        .as_ref()
        .map(|bytes| crate::project_store::fingerprint(bytes));
    ensure!(
        identity.as_deref() == expected,
        "Lyrics changed outside this app. Reopen the editor before saving."
    );
    // A malformed document is repairable only against its captured bytes; it
    // must never be mistaken for the expected-absent create path.
    let old: Option<Value> = previous
        .as_deref()
        .and_then(|bytes| serde_json::from_slice(bytes).ok());
    let (raw, document) = edited_value(old.as_ref(), lines, credit)?;
    let fingerprint =
        crate::project_store::commit_expected_locked(&dir, "lyrics.json", expected, &raw)?;
    Ok(Snapshot {
        raw: Some(raw),
        fingerprint: Some(fingerprint),
        document: Some(document),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(1);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "singz-lyrics-store-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&p).unwrap();
            Self(p.canonicalize().unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn lines(text: &str) -> Value {
        json!([{"start":0.25,"end":2.5,"text":text,"words":[{"w":"Hello,","s":0.25,"e":1.1},{"w":"世界!","s":1.1,"e":2.5}]}])
    }
    #[test]
    fn editor_save_clears_old_alignment_and_lookup_derivatives_but_preserves_foreign_fields() {
        let f = Fixture::new();
        let raw = json!({"source":"whisper","credit":"Singer","lines":[],"aligned":true,"check":{"verdict":"match"},"base":[{"text":"stale words"}],"engine":"old","lrclibPending":true,"lookup":2,"future":{"keep":true}});
        fs::write(f.0.join("lyrics.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
        let expected = identity(&f.0).unwrap().unwrap();
        let saved = save(
            &f.0,
            Some(&expected),
            &lines("New corrected words"),
            Some("Singer"),
        )
        .unwrap();
        let saved = saved.raw.unwrap();
        for field in [
            "aligned",
            "check",
            "base",
            "engine",
            "lrclibPending",
            "lookup",
        ] {
            assert!(saved.get(field).is_none(), "stale {field}");
        }
        assert_eq!(saved["source"], "edited");
        assert_eq!(saved["credit"], "Singer");
        assert_eq!(saved["future"], raw["future"]);
        assert_eq!(saved["lines"][0]["text"], "New corrected words");
    }

    #[test]
    fn independent_create_then_edit_preserves_exact_text_credit_and_foreign_metadata() {
        let f = Fixture::new();
        assert!(read(&f.0).unwrap().fingerprint.is_none());
        let original = "  Hello,   世界!  ";
        let first = save(&f.0, None, &lines(original), Some("Singer")).unwrap();
        assert_eq!(first.document.as_ref().unwrap().lines[0].text, original);
        assert_eq!(first.raw.as_ref().unwrap()["source"], "edited");
        let mut raw = first.raw.unwrap();
        raw["future"] = json!({"large":1234567890123456789u64});
        let hash = crate::project_store::commit(
            &f.0,
            "lyrics.json",
            first.fingerprint.as_deref().unwrap(),
            &raw,
        )
        .unwrap();
        let second = save(&f.0, Some(&hash), &lines("Hello, 世界!"), Some("Singer")).unwrap();
        assert_eq!(second.raw.as_ref().unwrap()["credit"], "Singer");
        assert_eq!(second.raw.as_ref().unwrap()["future"], raw["future"]);
        assert_eq!(read(&f.0).unwrap().fingerprint, second.fingerprint);
        assert!(!f.0.join("project.json").exists());
    }
    #[test]
    fn stale_present_or_absent_identity_never_overwrites_external_lyrics() {
        let f = Fixture::new();
        let first = save(&f.0, None, &lines("Hello, 世界!"), None).unwrap();
        assert!(save(&f.0, None, &lines("New text"), None).is_err());
        fs::write(f.0.join("lyrics.json"), b"{\"external\":true}").unwrap();
        let external = fs::read(f.0.join("lyrics.json")).unwrap();
        assert!(save(&f.0, first.fingerprint.as_deref(), &lines("New text"), None).is_err());
        assert_eq!(fs::read(f.0.join("lyrics.json")).unwrap(), external);
    }
    #[test]
    fn validation_and_busy_lease_refuse_before_publication_then_retry_succeeds() {
        let f = Fixture::new();
        assert!(save(&f.0, None, &json!([]), None).is_err());
        assert!(save(&f.0, None, &lines(" \n "), None).is_err());
        let mut bad = lines("Hello");
        bad[0]["end"] = json!(-1);
        assert!(save(&f.0, None, &bad, None).is_err());
        assert!(!f.0.join("lyrics.json").exists());
        let lease = crate::project_publish::lock(&f.0).unwrap();
        assert!(save(&f.0, None, &lines("Hello"), None).is_err());
        drop(lease);
        save(&f.0, None, &lines("Hello"), None).unwrap();
        assert!(
            fs::read_dir(&f.0).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".part"))
        );
    }
    #[test]
    fn save_uses_javascript_whitespace_without_changing_saved_text() {
        let f = Fixture::new();
        for text in ["\u{feff}", " \u{feff}\t"] {
            assert!(save(&f.0, None, &lines(text), None).is_err());
            assert!(!f.0.join("lyrics.json").exists());
        }
        let text = "\u{feff}\u{0085}\u{feff}";
        let rows = json!([{"start":0,"end":1,"text":text}]);
        let saved = save(&f.0, None, &rows, None).unwrap();
        assert_eq!(saved.raw.as_ref().unwrap()["lines"][0]["text"], text);
        let reread = read(&f.0).unwrap().document.unwrap();
        assert_eq!(reread.lines[0].text, text);
        assert_eq!(reread.lines[0].words[0].text, "\u{0085}");
    }
    #[test]
    fn malformed_existing_file_has_an_identity_and_requires_explicit_repair_cas() {
        let f = Fixture::new();
        fs::write(f.0.join("lyrics.json"), b"{broken").unwrap();
        assert!(read(&f.0).is_err());
        let before = identity(&f.0).unwrap().unwrap();
        assert!(save(&f.0, None, &lines("Hello"), None).is_err());
        save(&f.0, Some(&before), &lines("Hello"), None).unwrap();
        assert_eq!(read(&f.0).unwrap().document.unwrap().source, "edited");
    }
    #[test]
    fn repairing_invalid_timings_clears_omitted_credit_and_preserves_foreign_metadata() {
        let f = Fixture::new();
        fs::write(
            f.0.join("lyrics.json"),
            serde_json::to_vec(&json!({
                "source":"lrclib", "credit":"Original singer", "future":{"keep":true},
                "lines":[{"start":2,"end":1,"text":"Invalid timings"}]
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(read(&f.0).is_err());
        let expected = identity(&f.0).unwrap().unwrap();
        let saved = save(&f.0, Some(&expected), &lines("Repaired"), None).unwrap();
        let document = saved.document.unwrap();
        assert!(document.credit.is_empty());
        assert!(saved.raw.as_ref().unwrap().get("credit").is_none());
        assert_eq!(document.source, "edited");
        let reread = read(&f.0).unwrap();
        assert_eq!(reread.document.unwrap().credit, document.credit);
        assert_eq!(reread.raw.unwrap()["future"], json!({"keep":true}));
    }
    #[test]
    fn credit_is_owned_save_input_and_never_inherited_when_omitted() {
        let previous = json!({"source":"lrclib","credit":"Original singer","future":{"keep":true}});
        let (without, document) = edited_value(Some(&previous), &lines("Edited"), None).unwrap();
        assert!(without.get("credit").is_none());
        assert!(document.credit.is_empty());
        assert_eq!(without["future"], previous["future"]);
        let (explicit, document) =
            edited_value(Some(&previous), &lines("Edited"), Some("Original singer")).unwrap();
        assert_eq!(explicit["credit"], "Original singer");
        assert_eq!(document.credit, "Original singer");
        assert_eq!(explicit["future"], previous["future"]);
        let (replacement, document) =
            edited_value(Some(&previous), &lines("Edited"), Some("New singer")).unwrap();
        assert_eq!(replacement["credit"], "New singer");
        assert_eq!(document.credit, "New singer");
        let (empty, document) = edited_value(Some(&previous), &lines("Edited"), Some("")).unwrap();
        assert_eq!(empty["credit"], "");
        assert!(document.credit.is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn linked_member_is_not_absent_or_writable_even_when_target_is_inside_project() {
        let f = Fixture::new();
        fs::write(f.0.join("original.json"), b"{}").unwrap();
        std::os::unix::fs::symlink(f.0.join("original.json"), f.0.join("lyrics.json")).unwrap();
        assert!(identity(&f.0).is_err());
        assert!(read(&f.0).is_err());
        assert!(save(&f.0, None, &lines("Hello"), None).is_err());
        assert_eq!(fs::read(f.0.join("original.json")).unwrap(), b"{}");
    }
    #[test]
    fn cooperating_concurrent_expected_absent_writers_publish_one_complete_document() {
        let f = Fixture::new();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let threads: Vec<_> = (0..2)
            .map(|i| {
                let dir = f.0.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    save(&dir, None, &lines(&format!("Draft {i}")), None)
                })
            })
            .collect();
        barrier.wait();
        let successes = threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .filter(|r| r.is_ok())
            .count();
        assert_eq!(successes, 1);
        let saved = read(&f.0).unwrap();
        assert_eq!(saved.raw.unwrap()["source"], "edited");
        assert!(saved.document.is_some());
    }
}
