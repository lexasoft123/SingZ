use super::*;

struct Fixture {
    root: PathBuf,
    takes: PathBuf,
    take: PathBuf,
    dest: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "singz-training-wav-store-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let takes = root.join("training-recordings");
        fs::create_dir(&takes).unwrap();
        let take = takes.join("SingZ-microphone-20261107-test-take-1.wav");
        fs::write(&take, wav(48000, 4800)).unwrap();
        let dest = root.join("Мой голос 🎤.wav");
        Self {
            root,
            takes,
            take,
            dest,
        }
    }
    fn export(&self, overwrite: bool) -> Result<PathBuf> {
        export_with_hook(
            &self.takes,
            &self.take,
            &self.dest,
            overwrite,
            &|| false,
            |_| {},
        )
    }
    fn clean(&self) {
        assert!(!fs::read_dir(&self.root).unwrap().any(|f| {
            f.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".singz-training-wav-export-")
        }));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn wav(rate: u32, frames: usize) -> Vec<u8> {
    let mut bytes = vec![];
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + frames as u32 * 2).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&rate.to_le_bytes());
    bytes.extend_from_slice(&(rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(frames as u32 * 2).to_le_bytes());
    for i in 0..frames {
        bytes.extend_from_slice(&((i % 100) as i16 * 100 - 5000).to_le_bytes());
    }
    bytes
}
fn receipt(service: &Service, id: u64) -> Event {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        for e in service.drain() {
            if e.id == id {
                return e;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "WAV export worker did not respond"
        );
        thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn actual_worker_exports_exact_unicode_wav_and_retains_original() {
    let f = Fixture::new();
    let original = fs::read(&f.take).unwrap();
    let service = Service::new(f.takes.clone());
    let id = service
        .export(f.take.clone(), f.dest.clone(), false)
        .unwrap();
    assert_eq!(receipt(&service, id).result.unwrap(), f.dest);
    assert_eq!(fs::read(&f.dest).unwrap(), original);
    assert_eq!(fs::read(&f.take).unwrap(), original);
    f.clean();
}
#[test]
fn existing_destination_needs_approval_and_approved_replace_preserves_take() {
    let f = Fixture::new();
    fs::write(&f.dest, b"existing user data").unwrap();
    let original = fs::read(&f.take).unwrap();
    assert!(f.export(false).is_err());
    assert_eq!(fs::read(&f.dest).unwrap(), b"existing user data");
    f.export(true).unwrap();
    assert_eq!(fs::read(&f.dest).unwrap(), original);
    assert_eq!(fs::read(&f.take).unwrap(), original);
    f.clean();
}
#[test]
fn out_of_root_and_untrusted_names_are_refused() {
    let f = Fixture::new();
    let outside = f.root.join(f.take.file_name().unwrap());
    fs::copy(&f.take, &outside).unwrap();
    assert!(export_with_hook(&f.takes, &outside, &f.dest, false, &|| false, |_| {}).is_err());
    let wrong = f.takes.join("other.wav");
    fs::copy(&f.take, &wrong).unwrap();
    assert!(export_with_hook(&f.takes, &wrong, &f.dest, false, &|| false, |_| {}).is_err());
    assert!(!f.dest.exists());
    f.clean();
}
#[test]
fn retained_take_cannot_be_replaced_even_by_an_approved_export() {
    let f = Fixture::new();
    let before = fs::read(&f.take).unwrap();
    assert!(export_with_hook(&f.takes, &f.take, &f.take, true, &|| false, |_| {}).is_err());
    fs::hard_link(&f.take, &f.dest).unwrap();
    assert!(f.export(true).is_err());
    assert_eq!(fs::read(&f.take).unwrap(), before);
    f.clean();
}
#[test]
fn strict_pcm_validation_rejects_empty_truncated_stereo_float_and_overlong() {
    let mut invalid = vec![
        vec![],
        wav(48000, 0),
        wav(7999, 10),
        wav(192001, 10),
        wav(8000, 240001),
    ];
    let mut truncated = wav(48000, 100);
    truncated.pop();
    invalid.push(truncated);
    let mut stereo = wav(48000, 100);
    stereo[22..24].copy_from_slice(&2u16.to_le_bytes());
    invalid.push(stereo);
    let mut float = wav(48000, 100);
    float[20..22].copy_from_slice(&3u16.to_le_bytes());
    invalid.push(float);
    let mut alignment = wav(48000, 100);
    alignment[28..32].copy_from_slice(&1u32.to_le_bytes());
    invalid.push(alignment);
    let mut trailer = wav(48000, 100);
    trailer.push(0);
    invalid.push(trailer);
    for bytes in invalid {
        let f = Fixture::new();
        fs::write(&f.take, &bytes).unwrap();
        assert!(f.export(false).is_err());
        assert_eq!(fs::read(&f.take).unwrap(), bytes);
        assert!(!f.dest.exists());
        f.clean();
    }
    assert!(validate_wave(&wav(8000, 240000)).is_ok());
    assert!(validate_wave(&wav(192000, 1)).is_ok());
}
#[test]
fn oversized_sparse_source_is_refused_without_export_or_original_removal() {
    let f = Fixture::new();
    OpenOptions::new()
        .write(true)
        .open(&f.take)
        .unwrap()
        .set_len(MAX_BYTES + 1)
        .unwrap();
    assert!(f.export(false).is_err());
    assert_eq!(fs::metadata(&f.take).unwrap().len(), MAX_BYTES + 1);
    assert!(!f.dest.exists());
    f.clean();
}
#[test]
fn cancelled_staged_export_cleans_private_copy_and_retains_original() {
    let f = Fixture::new();
    let original = fs::read(&f.take).unwrap();
    let cancelled = AtomicBool::new(false);
    let result = export_with_hook(
        &f.takes,
        &f.take,
        &f.dest,
        false,
        &|| cancelled.load(Ordering::Acquire),
        |_| cancelled.store(true, Ordering::Release),
    );
    assert!(result.unwrap_err().to_string().contains("Cancelled"));
    assert!(!f.dest.exists());
    assert_eq!(fs::read(&f.take).unwrap(), original);
    f.clean();
}
#[test]
fn source_same_length_edit_during_export_is_refused() {
    let f = Fixture::new();
    let mut changed = fs::read(&f.take).unwrap();
    changed[44] ^= 1;
    let result = export_with_hook(&f.takes, &f.take, &f.dest, false, &|| false, |_| {
        fs::write(&f.take, &changed).unwrap()
    });
    assert!(result.is_err());
    assert!(!f.dest.exists());
    assert_eq!(fs::read(&f.take).unwrap(), changed);
    f.clean();
}
#[test]
fn newly_appearing_destination_is_never_overwritten() {
    let f = Fixture::new();
    let original = fs::read(&f.take).unwrap();
    let result = export_with_hook(&f.takes, &f.take, &f.dest, false, &|| false, |_| {
        fs::write(&f.dest, b"racing destination").unwrap()
    });
    assert!(result.is_err());
    assert_eq!(fs::read(&f.dest).unwrap(), b"racing destination");
    assert_eq!(fs::read(&f.take).unwrap(), original);
    f.clean();
}
#[test]
fn approved_destination_changed_during_staging_is_refused() {
    let f = Fixture::new();
    fs::write(&f.dest, b"approved old file").unwrap();
    let original = fs::read(&f.take).unwrap();
    let result = export_with_hook(&f.takes, &f.take, &f.dest, true, &|| false, |_| {
        fs::write(&f.dest, b"new unapproved user edit").unwrap()
    });
    assert!(result.is_err());
    assert_eq!(fs::read(&f.dest).unwrap(), b"new unapproved user edit");
    assert_eq!(fs::read(&f.take).unwrap(), original);
    f.clean();
}
#[test]
fn private_staged_content_tampering_is_refused() {
    let f = Fixture::new();
    let original = fs::read(&f.take).unwrap();
    let result = export_with_hook(&f.takes, &f.take, &f.dest, false, &|| false, |_| {
        let path = fs::read_dir(&f.root)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".singz-training-wav-export-")
            })
            .unwrap();
        let mut changed = original.clone();
        changed[44] ^= 1;
        fs::write(path, changed).unwrap();
    });
    assert!(result.is_err());
    assert!(!f.dest.exists());
    assert_eq!(fs::read(&f.take).unwrap(), original);
    f.clean();
}
#[test]
fn busy_take_or_destination_fails_without_replacing_files() {
    let f = Fixture::new();
    let lease = crate::file_lease::Lease::acquire(File::open(&f.take).unwrap()).unwrap();
    assert!(f.export(false).is_err());
    drop(lease);
    fs::write(&f.dest, b"existing").unwrap();
    let lease = crate::file_lease::Lease::acquire(File::open(&f.dest).unwrap()).unwrap();
    assert!(f.export(true).is_err());
    assert_eq!(fs::read(&f.dest).unwrap(), b"existing");
    drop(lease);
    f.clean();
}
#[test]
fn missing_destination_parent_preserves_original() {
    let f = Fixture::new();
    let original = fs::read(&f.take).unwrap();
    assert!(
        export_with_hook(
            &f.takes,
            &f.take,
            &f.root.join("missing/output.wav"),
            false,
            &|| false,
            |_| {}
        )
        .is_err()
    );
    assert_eq!(fs::read(&f.take).unwrap(), original);
    f.clean();
}
#[cfg(unix)]
#[test]
fn linked_source_root_or_destination_is_refused() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let linked = f.takes.join("SingZ-microphone-linked.wav");
    symlink(&f.take, &linked).unwrap();
    assert!(export_with_hook(&f.takes, &linked, &f.dest, false, &|| false, |_| {}).is_err());
    let root_alias = f.root.join("linked-root");
    symlink(&f.takes, &root_alias).unwrap();
    assert!(
        export_with_hook(
            &root_alias,
            &root_alias.join(f.take.file_name().unwrap()),
            &f.dest,
            false,
            &|| false,
            |_| {}
        )
        .is_err()
    );
    let external = f.root.join("external.wav");
    fs::write(&external, b"external sentinel").unwrap();
    symlink(&external, &f.dest).unwrap();
    assert!(f.export(true).is_err());
    assert_eq!(fs::read(&external).unwrap(), b"external sentinel");
    f.clean();
}
#[cfg(unix)]
#[test]
fn source_replacement_with_identical_bytes_is_refused_by_identity() {
    let f = Fixture::new();
    let bytes = fs::read(&f.take).unwrap();
    let result = export_with_hook(&f.takes, &f.take, &f.dest, false, &|| false, |_| {
        let replacement = f.takes.join("replacement");
        fs::write(&replacement, &bytes).unwrap();
        fs::rename(replacement, &f.take).unwrap();
    });
    assert!(result.is_err());
    assert!(!f.dest.exists());
    assert_eq!(fs::read(&f.take).unwrap(), bytes);
    f.clean();
}
#[test]
fn ordinary_optional_wav_chunks_are_preserved_byte_for_byte() {
    let f = Fixture::new();
    let normal = fs::read(&f.take).unwrap();
    let mut bytes = normal[..12].to_vec();
    bytes.extend_from_slice(b"JUNK");
    bytes.extend_from_slice(&3u32.to_le_bytes());
    bytes.extend_from_slice(b"abc\0");
    bytes.extend_from_slice(&normal[12..]);
    let len = (bytes.len() - 8) as u32;
    bytes[4..8].copy_from_slice(&len.to_le_bytes());
    fs::write(&f.take, &bytes).unwrap();
    f.export(false).unwrap();
    assert_eq!(fs::read(&f.dest).unwrap(), bytes);
    f.clean();
}

#[test]
fn actual_service_cancel_before_start_refuses_but_after_commit_keeps_success() {
    let f = Fixture::new();
    let original = fs::read(&f.take).unwrap();
    let service = Service::new(f.takes.clone());
    // Hold only receipt delivery: the first actual copy can commit, then the
    // single worker cannot start another request until this guard is released.
    let delivery = service.shared.events.lock().unwrap();
    let first = service
        .export(f.take.clone(), f.dest.clone(), false)
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !f.dest.exists() {
        assert!(std::time::Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    service.cancel(first);
    let cancelled_dest = f.root.join("cancelled.wav");
    let second = service
        .export(f.take.clone(), cancelled_dest.clone(), false)
        .unwrap();
    service.cancel(second);
    drop(delivery);
    let mut events = vec![];
    while events.len() < 2 {
        events.extend(service.drain());
        assert!(std::time::Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        events
            .iter()
            .find(|e| e.id == first)
            .unwrap()
            .result
            .is_ok()
    );
    assert!(
        events
            .iter()
            .find(|e| e.id == second)
            .unwrap()
            .result
            .as_ref()
            .unwrap_err()
            .contains("Cancelled")
    );
    assert!(!cancelled_dest.exists());
    assert_eq!(fs::read(&f.dest).unwrap(), original);
    assert_eq!(fs::read(&f.take).unwrap(), original);
    assert!(service.shared.cancelled.lock().unwrap().is_empty());
    f.clean();
}

#[cfg(unix)]
#[test]
fn approved_target_replacement_with_identical_bytes_is_refused() {
    let f = Fixture::new();
    fs::write(&f.dest, b"approved target").unwrap();
    let result = export_with_hook(&f.takes, &f.take, &f.dest, true, &|| false, |_| {
        let replacement = f.root.join("replacement-target");
        fs::write(&replacement, b"approved target").unwrap();
        fs::rename(replacement, &f.dest).unwrap();
    });
    assert!(result.is_err());
    assert_eq!(fs::read(&f.dest).unwrap(), b"approved target");
    f.clean();
}
