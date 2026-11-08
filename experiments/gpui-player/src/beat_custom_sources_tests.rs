use super::*;
struct Fixture {
    root: PathBuf,
    lanes: Vec<(usize, PathBuf)>,
    stamps: Vec<(u64, SystemTime)>,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "singz-beat-custom-sources-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let lanes: Vec<_> = [0, 1, 3, 5, 6, 7, 21]
            .into_iter()
            .map(|slot| {
                let path = root.join(format!("lane-{slot}.wav"));
                fs::write(&path, format!("file stamp fixture for role {slot}")).unwrap();
                (slot, path)
            })
            .collect();
        let stamps = lanes.iter().map(|(_, path)| stamp(path).unwrap()).collect();
        Self {
            root,
            lanes,
            stamps,
        }
    }
    fn capture(&self) -> Inputs {
        capture(
            self.lanes
                .iter()
                .filter(|(slot, _)| *slot < crate::tracks::BUILTIN_SLOTS)
                .cloned()
                .collect(),
            120.,
            73,
            9,
            vec![0.],
            vec![(0., 1.)],
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn builtins_capture_verifies_with_backing_harmony_and_high_custom_slots_present() {
    let f = Fixture::new();
    let input = f.capture();
    assert_eq!(
        input.sources.iter().map(|s| s.lane).collect::<Vec<_>>(),
        [0, 1, 3, 5]
    );
    assert_eq!((input.epoch, input.revision, input.duration), (73, 9, 120.));
    input.verify_loaded(&f.lanes, &f.stamps).unwrap();
}
#[test]
fn custom_sources_never_enter_the_beat_detector_even_when_they_use_slot_six() {
    let f = Fixture::new();
    for custom in [6, 7, 21] {
        assert!(
            capture(
                vec![(1, f.lanes[1].1.clone()), (custom, f.lanes[4].1.clone())],
                120.,
                73,
                9,
                vec![],
                vec![]
            )
            .is_err()
        );
    }
    assert!(capture(f.lanes.clone(), 120., 73, 9, vec![], vec![]).is_err());
}
#[test]
fn custom_reorder_addition_removal_or_file_changes_do_not_change_captured_builtin_authority() {
    let f = Fixture::new();
    let input = f.capture();
    fs::write(
        &f.lanes[4].1,
        b"modified custom backing must not taint the stem mix",
    )
    .unwrap();
    fs::remove_file(&f.lanes[5].1).unwrap();
    input.verify_loaded(&f.lanes, &f.stamps).unwrap();
    let mut zipped: Vec<_> = f.lanes.clone().into_iter().zip(f.stamps.clone()).collect();
    zipped.reverse();
    let (lanes, stamps): (Vec<_>, Vec<_>) = zipped.into_iter().collect();
    input.verify_loaded(&lanes, &stamps).unwrap();
    let (mut lanes, mut stamps): (Vec<_>, Vec<_>) = lanes
        .into_iter()
        .zip(stamps)
        .filter(|((slot, _), _)| *slot < crate::tracks::BUILTIN_SLOTS)
        .collect();
    input.verify_loaded(&lanes, &stamps).unwrap();
    let path = f.root.join("new-custom.wav");
    fs::write(&path, b"custom sample").unwrap();
    lanes.insert(0, (9, path.clone()));
    stamps.insert(0, stamp(&path).unwrap());
    input.verify_loaded(&lanes, &stamps).unwrap();
}
#[test]
fn captured_role_file_replacement_and_loaded_stamp_drift_still_refuse_adoption() {
    let f = Fixture::new();
    let input = f.capture();
    let mut changed = f.lanes.clone();
    let other = f.root.join("foreign-drums.wav");
    fs::write(&other, b"different source").unwrap();
    changed[1].1 = other;
    assert!(input.verify_loaded(&changed, &f.stamps).is_err());
    let mut stamps = f.stamps.clone();
    stamps[1].0 += 1;
    assert!(input.verify_loaded(&f.lanes, &stamps).is_err());
    let changed = b"captured drums now have a demonstrably different byte length";
    // Do not depend on two tiny writes receiving distinct filesystem ticks.
    assert_ne!(changed.len() as u64, f.stamps[1].0);
    fs::write(&f.lanes[1].1, changed).unwrap();
    assert!(input.verify_loaded(&f.lanes, &f.stamps).is_err());
}
#[test]
fn captured_builtin_role_set_cannot_silently_grow_shrink_or_duplicate() {
    let f = Fixture::new();
    let input = f.capture();
    let (without, stamps): (Vec<_>, Vec<_>) = f
        .lanes
        .iter()
        .cloned()
        .zip(f.stamps.iter().copied())
        .filter(|((slot, _), _)| *slot != 3)
        .collect();
    assert!(input.verify_loaded(&without, &stamps).is_err());
    let mut extra = f.lanes.clone();
    let mut extra_stamps = f.stamps.clone();
    let piano = f.root.join("piano.wav");
    fs::write(&piano, b"new built-in piano").unwrap();
    extra.push((4, piano.clone()));
    extra_stamps.push(stamp(&piano).unwrap());
    assert!(input.verify_loaded(&extra, &extra_stamps).is_err());
    extra = f.lanes.clone();
    extra_stamps = f.stamps.clone();
    extra.push(f.lanes[1].clone());
    extra_stamps.push(f.stamps[1]);
    assert!(input.verify_loaded(&extra, &extra_stamps).is_err());
    assert!(
        input
            .verify_loaded(&f.lanes, &f.stamps[..f.stamps.len() - 1])
            .is_err()
    );
}
#[test]
fn original_or_custom_only_projects_still_require_an_actual_drums_role() {
    let f = Fixture::new();
    assert!(capture(vec![(5, f.lanes[3].1.clone())], 10., 73, 9, vec![], vec![]).is_err());
    assert!(capture(vec![(6, f.lanes[4].1.clone())], 10., 73, 9, vec![], vec![]).is_err());
}
