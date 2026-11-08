//! Recoverable replacement of generated stems and metadata; unrelated files stay put.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
const JOURNAL: &str = ".singz-native-split.json";
const MAX_MEMBERS: usize = 128;
const MAX_TREE: usize = 512;
// Admission is deliberately filesystem-free: UI callers already hold canonical
// project paths. A capture that owns the disk lease yields to an accepted Save.
fn write_intents() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, usize>> {
    static INTENTS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<PathBuf, usize>>,
    > = std::sync::OnceLock::new();
    INTENTS.get_or_init(Default::default)
}
pub struct WriteIntentGuard(PathBuf);
pub fn write_intent(dir: &Path) -> Result<WriteIntentGuard> {
    ensure!(
        dir.is_absolute()
            && !dir.components().any(|c| matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )),
        "Project write intent requires an absolute canonical path"
    );
    let mut intents = write_intents().lock().unwrap_or_else(|e| e.into_inner());
    let count = intents.entry(dir.to_owned()).or_default();
    *count = count
        .checked_add(1)
        .context("Too many pending project writes")?;
    Ok(WriteIntentGuard(dir.to_owned()))
}
pub fn write_pending(dir: &Path) -> bool {
    write_intents()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(dir)
}
impl Drop for WriteIntentGuard {
    fn drop(&mut self) {
        let mut intents = write_intents().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = intents.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                intents.remove(&self.0);
            }
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    id: String,
    committed: bool,
    files: Vec<Change>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    file: String,
    old: bool,
    new: bool,
}
pub fn lock(dir: &Path) -> Result<crate::file_lease::Lease> {
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(".singz-native-write.lock"))?;
    crate::file_lease::Lease::movable(f).context("Project is already being saved or split")
}
fn exists(p: &Path) -> Result<bool> {
    match fs::symlink_metadata(p) {
        Ok(m) => {
            ensure!(
                !m.file_type().is_symlink(),
                "Linked project publication member"
            );
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
fn remove(p: &Path) -> Result<()> {
    if exists(p)? {
        fs::remove_file(p)?;
    }
    Ok(())
}
fn member(p: &Path) -> Result<bool> {
    let present = exists(p)?;
    if present {
        ensure!(
            p.is_file(),
            "Split publication member is not an ordinary file"
        );
    }
    Ok(present)
}
fn sync(p: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(p)?.sync_all()?;
    let _ = p;
    Ok(())
}
fn allowed(name: &str) -> bool {
    (name.starts_with("stems/custom-") && crate::tracks::normalize_custom_path(name).is_some())
        || name == "project.json"
        || name == "lyrics.json"
        || crate::integration::STEMS
            .iter()
            .any(|s| name == format!("stems/{s}.wav") || name == format!("stems/{s}.flac"))
}
fn stems_directory(dir: &Path) -> Result<()> {
    let p = dir.join("stems");
    if exists(&p)? {
        ensure!(p.is_dir(), "Project stems is not a directory");
    } else {
        fs::create_dir(p)?;
    }
    Ok(())
}
fn stage(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!(".native-split-{id}"))
}
fn ordinary_tree(root: &Path) -> Result<()> {
    let mut todo = vec![root.to_owned()];
    let mut count = 0;
    while let Some(p) = todo.pop() {
        let m = fs::symlink_metadata(&p)?;
        ensure!(!m.file_type().is_symlink(), "Linked split staging member");
        count += 1;
        ensure!(count <= MAX_TREE, "Unexpected split staging contents");
        if m.is_dir() {
            for e in fs::read_dir(p)? {
                todo.push(e?.path());
            }
        } else {
            ensure!(m.is_file(), "Unsupported split staging member");
        }
    }
    Ok(())
}
fn backup(dir: &Path, id: &str, name: &str) -> PathBuf {
    stage(dir, id).join("previous").join(name)
}
fn journal(dir: &Path, j: &Journal) -> Result<()> {
    let temp = stage(dir, &j.id).join("journal.tmp");
    let mut f = File::create(&temp)?;
    f.write_all(&serde_json::to_vec(j)?)?;
    f.sync_all()?;
    crate::project_store::replace(&temp, &dir.join(JOURNAL))?;
    sync(dir)
}
pub fn recover(dir: &Path) -> Result<()> {
    if dir.join(JOURNAL).exists() {
        let _lease = lock(dir)?;
        recover_locked(dir)?;
    }
    Ok(())
}
pub fn recover_locked(dir: &Path) -> Result<()> {
    let file = match File::open(dir.join(JOURNAL)) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let mut bytes = Vec::new();
    file.take(65537).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 65536, "Split journal too large");
    let j: Journal = serde_json::from_slice(&bytes)?;
    ensure!(
        j.version == 1
            && !j.id.is_empty()
            && j.id.len() < 80
            && j.id.bytes().all(|b| b.is_ascii_digit() || b == b'-')
            && !j.files.is_empty()
            && j.files.len() <= MAX_MEMBERS,
        "Invalid split journal"
    );
    let mut seen = std::collections::BTreeSet::new();
    for f in &j.files {
        ensure!(
            allowed(&f.file) && seen.insert(&f.file),
            "Invalid split journal path"
        );
    }
    stems_directory(dir)?;
    let root = stage(dir, &j.id);
    ensure!(
        !fs::symlink_metadata(&root)?.file_type().is_symlink(),
        "Linked split staging directory"
    );
    ordinary_tree(&root)?;
    for f in &j.files {
        for p in [
            dir.join(&f.file),
            backup(dir, &j.id, &f.file),
            root.join("next").join(&f.file),
        ] {
            member(&p)?;
        }
    }
    for f in &j.files {
        let dest = dir.join(&f.file);
        let prev = backup(dir, &j.id, &f.file);
        let incoming = root.join("next").join(&f.file);
        if !j.committed {
            if exists(&prev)? {
                remove(&dest)?;
                fs::rename(&prev, &dest)?;
            } else if !f.old && f.new && !exists(&incoming)? {
                remove(&dest)?;
            }
        }
    }
    remove(&dir.join(JOURNAL))?;
    sync(dir)?;
    fs::remove_dir_all(root)?;
    Ok(())
}
pub fn commit(dir: &Path, id: &str, files: Vec<(String, bool)>, expected: &str) -> Result<()> {
    ensure!(
        !files.is_empty() && files.len() <= MAX_MEMBERS,
        "Invalid split publication size"
    );
    stems_directory(dir)?;
    ensure!(
        crate::project_store::read(dir, "project.json")?.1 == expected,
        "Project changed during splitting; reopen it before retrying"
    );
    let mut j = Journal {
        version: 1,
        id: id.into(),
        committed: false,
        files: vec![],
    };
    let root = stage(dir, id);
    let mut seen = std::collections::BTreeSet::new();
    for (name, new) in files {
        ensure!(
            seen.insert(name.clone()),
            "Duplicate project publication member"
        );
        ensure!(allowed(&name), "Invalid split member");
        let dest = dir.join(&name);
        if new {
            ensure!(
                member(&root.join("next").join(&name))?,
                "Split staging file is missing"
            );
        }
        j.files.push(Change {
            file: name,
            old: member(&dest)?,
            new,
        });
    }
    for f in &j.files {
        if f.new {
            // Windows FlushFileBuffers requires GENERIC_WRITE even when the
            // complete staged bytes were written by an earlier handle. Opening
            // without create/truncate preserves the staged file on every OS.
            OpenOptions::new()
                .write(true)
                .open(root.join("next").join(&f.file))?
                .sync_all()
                .with_context(|| format!("Flush staged project member {}", f.file))?;
        }
    }
    journal(dir, &j)?;
    let result = (|| -> Result<()> {
        for f in &j.files {
            let dest = dir.join(&f.file);
            if f.old {
                let prev = backup(dir, id, &f.file);
                fs::create_dir_all(prev.parent().unwrap())?;
                fs::rename(&dest, prev)?;
            }
            if f.new {
                fs::create_dir_all(dest.parent().unwrap())?;
                fs::rename(root.join("next").join(&f.file), dest)?;
            }
        }
        sync(&dir.join("stems"))?;
        j.committed = true;
        journal(dir, &j)
    })();
    let recovery = recover_locked(dir);
    result.and(recovery)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
            let p = std::env::temp_dir().join(format!(
                "singz-publish-{}-{}-{}",
                std::process::id(),
                crate::training_store::now(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir(&p).unwrap();
            fs::create_dir(p.join("stems")).unwrap();
            fs::write(p.join("project.json"), b"{\"version\":2}").unwrap();
            fs::write(p.join("stems/vocals.wav"), b"old-vocal").unwrap();
            Self(p.canonicalize().unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn setup(root: &Path, committed: bool) -> Journal {
        let id = "123-456";
        let s = stage(root, id);
        fs::create_dir_all(s.join("next/stems")).unwrap();
        fs::create_dir_all(s.join("previous/stems")).unwrap();
        Journal {
            version: 1,
            id: id.into(),
            committed,
            files: vec![
                Change {
                    file: "stems/vocals.wav".into(),
                    old: true,
                    new: true,
                },
                Change {
                    file: "project.json".into(),
                    old: true,
                    new: true,
                },
            ],
        }
    }
    #[test]
    fn lyric_edits_publish_with_generated_audio_and_metadata_as_one_recoverable_set() {
        let f = Fixture::new();
        fs::write(f.0.join("lyrics.json"), b"old lyrics").unwrap();
        fs::write(f.0.join("notes.txt"), b"unrelated").unwrap();
        let expected = crate::project_store::read(&f.0, "project.json").unwrap().1;
        let id = "111-222";
        let next = stage(&f.0, id).join("next");
        fs::create_dir_all(next.join("stems")).unwrap();
        fs::write(next.join("lyrics.json"), b"edited lyrics").unwrap();
        fs::write(
            next.join("project.json"),
            b"{\"version\":2,\"updated\":true}",
        )
        .unwrap();
        fs::write(next.join("stems/vocals.wav"), b"new vocal").unwrap();
        commit(
            &f.0,
            id,
            vec![
                ("stems/vocals.wav".into(), true),
                ("lyrics.json".into(), true),
                ("project.json".into(), true),
            ],
            &expected,
        )
        .unwrap();
        assert_eq!(fs::read(f.0.join("lyrics.json")).unwrap(), b"edited lyrics");
        assert_eq!(
            fs::read(f.0.join("stems/vocals.wav")).unwrap(),
            b"new vocal"
        );
        assert_eq!(fs::read(f.0.join("notes.txt")).unwrap(), b"unrelated");
        assert!(!f.0.join(JOURNAL).exists());
    }
    #[test]
    fn interrupted_lyric_replacement_and_creation_restore_the_original_membership() {
        for had_lyrics in [false, true] {
            let f = Fixture::new();
            let mut j = setup(&f.0, false);
            j.files.push(Change {
                file: "lyrics.json".into(),
                old: had_lyrics,
                new: true,
            });
            if had_lyrics {
                fs::write(backup(&f.0, &j.id, "lyrics.json"), b"old lyrics").unwrap();
            }
            fs::write(f.0.join("lyrics.json"), b"new lyrics").unwrap();
            fs::rename(
                f.0.join("stems/vocals.wav"),
                backup(&f.0, &j.id, "stems/vocals.wav"),
            )
            .unwrap();
            fs::write(f.0.join("stems/vocals.wav"), b"new vocal").unwrap();
            journal(&f.0, &j).unwrap();
            recover(&f.0).unwrap();
            assert_eq!(
                fs::read(f.0.join("stems/vocals.wav")).unwrap(),
                b"old-vocal"
            );
            if had_lyrics {
                assert_eq!(fs::read(f.0.join("lyrics.json")).unwrap(), b"old lyrics");
            } else {
                assert!(!f.0.join("lyrics.json").exists());
            }
            assert!(!f.0.join(JOURNAL).exists());
        }
    }
    #[test]
    fn interrupted_split_save_restores_generated_audio_and_metadata_together() {
        let f = Fixture::new();
        let j = setup(&f.0, false);
        let original = fs::read(f.0.join("project.json")).unwrap();
        fs::rename(
            f.0.join("stems/vocals.wav"),
            backup(&f.0, &j.id, "stems/vocals.wav"),
        )
        .unwrap();
        fs::write(f.0.join("stems/vocals.wav"), b"new-vocal").unwrap();
        fs::write(
            stage(&f.0, &j.id).join("next/project.json"),
            b"new-metadata",
        )
        .unwrap();
        journal(&f.0, &j).unwrap();
        recover(&f.0).unwrap();
        assert_eq!(
            fs::read(f.0.join("stems/vocals.wav")).unwrap(),
            b"old-vocal"
        );
        assert_eq!(fs::read(f.0.join("project.json")).unwrap(), original);
        assert!(!stage(&f.0, &j.id).exists());
    }
    #[test]
    fn committed_recovery_keeps_new_audio_and_unrelated_files() {
        let f = Fixture::new();
        let j = setup(&f.0, true);
        fs::write(backup(&f.0, &j.id, "stems/vocals.wav"), b"backup").unwrap();
        fs::write(f.0.join("notes.txt"), b"private notes").unwrap();
        fs::write(f.0.join("stems/vocals.wav"), b"new").unwrap();
        journal(&f.0, &j).unwrap();
        recover(&f.0).unwrap();
        assert_eq!(fs::read(f.0.join("stems/vocals.wav")).unwrap(), b"new");
        assert_eq!(fs::read(f.0.join("notes.txt")).unwrap(), b"private notes");
        assert!(!f.0.join(JOURNAL).exists());
    }
    #[test]
    fn conflicting_metadata_refuses_publication_before_touching_audio() {
        let f = Fixture::new();
        let j = setup(&f.0, false);
        let expected = crate::project_store::read(&f.0, "project.json").unwrap().1;
        fs::write(
            f.0.join("project.json"),
            b"{\"version\":2,\"foreign\":true}",
        )
        .unwrap();
        assert!(
            commit(
                &f.0,
                &j.id,
                vec![("stems/vocals.wav".into(), true)],
                &expected
            )
            .is_err()
        );
        assert_eq!(
            fs::read(f.0.join("stems/vocals.wav")).unwrap(),
            b"old-vocal"
        );
        assert!(!f.0.join(JOURNAL).exists());
    }
    #[test]
    fn malformed_recovery_journal_is_preserved_without_audio_mutation() {
        let f = Fixture::new();
        let mut j = setup(&f.0, false);
        j.files[0].file = "../outside".into();
        journal(&f.0, &j).unwrap();
        let bytes = fs::read(f.0.join(JOURNAL)).unwrap();
        assert!(recover(&f.0).is_err());
        assert_eq!(fs::read(f.0.join(JOURNAL)).unwrap(), bytes);
        assert_eq!(
            fs::read(f.0.join("stems/vocals.wav")).unwrap(),
            b"old-vocal"
        );
    }
    #[cfg(unix)]
    #[test]
    fn linked_backup_is_refused_without_moving_a_foreign_file() {
        let f = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("vocals.wav"), b"foreign").unwrap();
        let j = setup(&f.0, false);
        let prior = stage(&f.0, &j.id).join("previous/stems");
        fs::remove_dir(&prior).unwrap();
        std::os::unix::fs::symlink(&outside.0, &prior).unwrap();
        journal(&f.0, &j).unwrap();
        assert!(recover(&f.0).is_err());
        assert_eq!(fs::read(outside.0.join("vocals.wav")).unwrap(), b"foreign");
        assert_eq!(
            fs::read(f.0.join("stems/vocals.wav")).unwrap(),
            b"old-vocal"
        );
        assert!(f.0.join(JOURNAL).is_file());
    }
    #[test]
    fn failed_rollback_retains_its_journal_and_backups_until_repair() {
        let f = Fixture::new();
        let j = setup(&f.0, false);
        let expected = crate::project_store::read(&f.0, "project.json").unwrap().1;
        let root = stage(&f.0, &j.id);
        fs::write(root.join("next/stems/vocals.wav"), b"new-vocal").unwrap();
        fs::write(
            root.join("next/project.json"),
            b"{\"version\":2,\"new\":true}",
        )
        .unwrap();
        fs::create_dir(root.join("previous/project.json")).unwrap();
        assert!(
            commit(
                &f.0,
                &j.id,
                vec![
                    ("stems/vocals.wav".into(), true),
                    ("project.json".into(), true)
                ],
                &expected
            )
            .is_err()
        );
        assert!(f.0.join(JOURNAL).is_file());
        assert_eq!(
            fs::read(backup(&f.0, &j.id, "stems/vocals.wav")).unwrap(),
            b"old-vocal"
        );
        assert!(f.0.join("project.json").is_file());
        fs::remove_dir(root.join("previous/project.json")).unwrap();
        recover(&f.0).unwrap();
        assert_eq!(
            fs::read(f.0.join("stems/vocals.wav")).unwrap(),
            b"old-vocal"
        );
        assert_eq!(
            crate::project_store::read(&f.0, "project.json").unwrap().1,
            expected
        );
    }
    #[test]
    fn encoded_custom_members_publish_and_rollback_with_metadata_as_one_transaction() {
        let f = Fixture::new();
        let id = "111-333";
        let root = stage(&f.0, id);
        fs::create_dir_all(root.join("next/stems")).unwrap();
        fs::create_dir_all(root.join("previous/stems")).unwrap();
        fs::write(f.0.join("stems/custom-harmony.mp3"), b"new encoded").unwrap();
        fs::write(
            root.join("previous/stems/custom-harmony.mp3"),
            b"old encoded",
        )
        .unwrap();
        fs::write(root.join("previous/project.json"), b"{\"version\":2}").unwrap();
        fs::write(
            f.0.join("project.json"),
            b"{\"version\":2,\"candidate\":true}",
        )
        .unwrap();
        let j = Journal {
            version: 1,
            id: id.into(),
            committed: false,
            files: vec![
                Change {
                    file: "stems/custom-harmony.mp3".into(),
                    old: true,
                    new: true,
                },
                Change {
                    file: "project.json".into(),
                    old: true,
                    new: true,
                },
            ],
        };
        journal(&f.0, &j).unwrap();
        recover_locked(&f.0).unwrap();
        assert_eq!(
            fs::read(f.0.join("stems/custom-harmony.mp3")).unwrap(),
            b"old encoded"
        );
        assert_eq!(
            fs::read(f.0.join("project.json")).unwrap(),
            b"{\"version\":2}"
        );
        assert!(!root.exists());
    }
    #[test]
    fn publication_allows_more_than_sixteen_safe_members_but_no_custom_traversal() {
        let f = Fixture::new();
        let id = "111-444";
        let root = stage(&f.0, id);
        fs::create_dir_all(root.join("next/stems")).unwrap();
        let mut files = vec![];
        for i in 0..20 {
            let name = format!("stems/custom-{i}.mp3");
            fs::write(root.join("next").join(&name), format!("encoded-{i}")).unwrap();
            files.push((name, true));
        }
        fs::write(
            root.join("next/project.json"),
            b"{\"version\":2,\"custom\":true}",
        )
        .unwrap();
        files.push(("project.json".into(), true));
        let hash = crate::project_store::read(&f.0, "project.json").unwrap().1;
        commit(&f.0, id, files, &hash).unwrap();
        for i in 0..20 {
            assert_eq!(
                fs::read(f.0.join(format!("stems/custom-{i}.mp3"))).unwrap(),
                format!("encoded-{i}").as_bytes()
            );
        }
        for name in [
            "../custom-stolen.mp3",
            "stems/custom-a/../../outside",
            "stems/custom-a:stream",
            "stems/custom-a\\..\\outside",
        ] {
            assert!(!allowed(name));
        }
    }
}
