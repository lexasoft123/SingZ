use super::*;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "singz-stem-export-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(p.join("stems")).unwrap();
        Self(p.canonicalize().unwrap())
    }
    fn lane(&self, id: &str, label: &str) -> crate::tracks::Lane {
        let p = self.0.join("stems").join(format!("{id}.wav"));
        fs::write(&p, b"encoded source fixture").unwrap();
        crate::tracks::Lane {
            slot: 7,
            id: id.into(),
            label: label.into(),
            color: "#abcdef".into(),
            file: p,
            custom: true,
        }
    }
    fn plan(&self) -> Plan {
        let lanes = vec![
            self.lane("custom-a", "Голос 🎤"),
            self.lane("custom-b", "Bass"),
        ];
        Plan::capture(
            &lanes,
            &["custom-a".into(), "custom-b".into()],
            Mode::Stems,
            Format::Wav,
        )
        .unwrap()
    }
    fn destination(&self) -> PathBuf {
        let p = self.0.join("Вывод 🎵");
        fs::create_dir(&p).unwrap();
        p
    }
    fn assert_no_stage(&self, dest: &Path) {
        assert!(!fs::read_dir(dest).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".singz-export-")
        }));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn fake(path: &Path, _: Format, _: &[PathBuf], _: &dyn Fn() -> bool) -> Result<()> {
    fs::write(path, b"finished encoded output")?;
    Ok(())
}
#[test]
fn plans_preserve_track_order_not_selection_order() {
    let f = Fixture::new();
    let lanes = vec![f.lane("custom-a", "One"), f.lane("custom-b", "Two")];
    let p = Plan::capture(
        &lanes,
        &["custom-b".into(), "custom-a".into()],
        Mode::Stems,
        Format::default(),
    )
    .unwrap();
    assert_eq!(p.format, Format::Mp3);
    assert_eq!(
        p.items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(),
        ["01-One.mp3", "02-Two.mp3"]
    );
}
#[test]
fn karaoke_exact_roles_and_generated_backing_only() {
    for id in [
        "drums",
        "bass",
        "other",
        "guitar",
        "piano",
        "custom-backing-vocals",
        "custom-backing-vocals-2",
        "custom-backing-vocals-00",
    ] {
        assert!(karaoke_lane(id));
    }
    for id in [
        "vocals",
        "original",
        "custom-other",
        "custom-backing-vocals-",
        "custom-backing-vocals-x",
        "custom-backing-vocals-٢",
    ] {
        assert!(!karaoke_lane(id));
    }
    let f = Fixture::new();
    let lanes = vec![
        f.lane("vocals", "Voice"),
        f.lane("drums", "Drums"),
        f.lane("custom-backing-vocals-2", "Backing"),
        f.lane("custom-guitar", "My guitar"),
    ];
    let p = Plan::capture_with_karaoke_label(&lanes, &[], Mode::Karaoke, Format::Flac, "Караоке")
        .unwrap();
    assert_eq!(p.items.len(), 1);
    assert_eq!(
        p.items[0].sources,
        vec![lanes[1].file.clone(), lanes[2].file.clone()]
    );
    assert_eq!(p.items[0].name, "01-Караоке.flac");
}
#[test]
fn no_selection_or_ineligible_karaoke_refuses() {
    let f = Fixture::new();
    let lanes = vec![f.lane("custom-a", "A")];
    assert!(Plan::capture(&lanes, &[], Mode::Stems, Format::Wav).is_err());
    assert!(Plan::capture(&lanes, &[], Mode::Karaoke, Format::Wav).is_err());
}
#[test]
fn filename_matches_javascript_replacement_trim_and_utf16_slice() {
    assert_eq!(safe_name("a<>:\"/\\|?*\0\n. "), "a___________");
    assert_eq!(safe_name(" ..."), "track");
    let name = format!("{}🎤end", "x".repeat(119));
    assert_eq!(safe_name(&name), format!("{}�", "x".repeat(119)));
    assert_eq!(safe_name(&format!("{}.", "x".repeat(119))), "x".repeat(119));
}
#[test]
fn snapshot_does_not_touch_or_require_source_files() {
    let f = Fixture::new();
    let lane = f.lane("custom-a", "A");
    fs::remove_file(&lane.file).unwrap();
    let plan = Plan::capture(&[lane], &["custom-a".into()], Mode::Stems, Format::Wav).unwrap();
    assert_eq!(plan.items.len(), 1);
}
#[test]
fn sequential_unicode_export_reports_progress_and_cleans_staging() {
    let f = Fixture::new();
    let p = f.plan();
    let dest = f.destination();
    let mut progress = vec![];
    let result = run(&p, &dest, &|| false, fake, |i, t, l| {
        progress.push((i, t, l))
    });
    match result {
        EventKind::Finished {
            files,
            cancelled,
            error,
        } => {
            assert_eq!(files.len(), 2);
            assert!(!cancelled);
            assert!(error.is_none());
            assert_eq!(files[0].file_name().unwrap(), "01-Голос 🎤.wav");
        }
        _ => panic!(),
    };
    assert_eq!(progress.len(), 2);
    assert_eq!(progress[1].0, 2);
    f.assert_no_stage(&dest);
}
#[test]
fn existing_destination_is_never_overwritten_and_prior_outputs_remain() {
    let f = Fixture::new();
    let p = f.plan();
    let dest = f.destination();
    fs::write(dest.join(&p.items[1].name), b"sentinel").unwrap();
    let result = run(&p, &dest, &|| false, fake, |_, _, _| {});
    assert!(
        matches!(result,EventKind::Finished{files,error:Some(_),cancelled:false}if files.len()==1)
    );
    assert_eq!(fs::read(dest.join(&p.items[1].name)).unwrap(), b"sentinel");
    assert!(dest.join(&p.items[0].name).exists());
    f.assert_no_stage(&dest);
}
#[test]
fn later_encoding_failure_keeps_completed_outputs() {
    let f = Fixture::new();
    let p = f.plan();
    let dest = f.destination();
    let mut count = 0;
    let result = run(
        &p,
        &dest,
        &|| false,
        |stage, format, sources, cancel| {
            count += 1;
            if count == 2 {
                fs::write(stage, b"partial")?;
                bail!("native decoder refused");
            }
            fake(stage, format, sources, cancel)
        },
        |_, _, _| {},
    );
    assert!(
        matches!(result,EventKind::Finished{files,error:Some(message),..}if files.len()==1&&message.contains("native decoder refused"))
    );
    f.assert_no_stage(&dest);
}
#[test]
fn cancellation_after_first_publish_keeps_first_and_removes_partial() {
    let f = Fixture::new();
    let p = f.plan();
    let dest = f.destination();
    let cancelled = AtomicBool::new(false);
    let mut count = 0;
    let result = run(
        &p,
        &dest,
        &|| cancelled.load(Ordering::Acquire),
        |stage, format, sources, cancel| {
            count += 1;
            if count == 2 {
                cancelled.store(true, Ordering::Release);
            }
            fake(stage, format, sources, cancel)
        },
        |_, _, _| {},
    );
    assert!(matches!(result,EventKind::Finished{files,cancelled:true,error:None}if files.len()==1));
    f.assert_no_stage(&dest);
}
#[test]
fn source_change_during_native_encoding_refuses_publication() {
    let f = Fixture::new();
    let p = f.plan();
    let dest = f.destination();
    let result = run(
        &p,
        &dest,
        &|| false,
        |stage, format, sources, cancel| {
            fake(stage, format, sources, cancel)?;
            fs::write(&sources[0], b"changed original")?;
            Ok(())
        },
        |_, _, _| {},
    );
    assert!(
        matches!(result,EventKind::Finished{files,error:Some(message),..}if files.is_empty()&&message.contains("changed"))
    );
    f.assert_no_stage(&dest);
}
#[test]
fn missing_builtin_wav_can_resolve_compacted_flac_but_custom_cannot() {
    let f = Fixture::new();
    let builtin = f.0.join("stems/vocals.wav");
    let flac = builtin.with_extension("flac");
    fs::write(&flac, b"flac").unwrap();
    assert_eq!(source_path(&builtin).unwrap(), flac);
    assert!(source_path(&f.0.join("stems/custom-a.wav")).is_err());
    assert!(source_path(&f.0.join("vocals.wav")).is_err());
}
#[test]
fn invalid_plan_filename_cannot_escape_destination() {
    let f = Fixture::new();
    let mut p = f.plan();
    p.items[0].name = "../escape.wav".into();
    let dest = f.destination();
    let result = run(&p, &dest, &|| false, fake, |_, _, _| {});
    assert!(matches!(result,EventKind::Finished{files,error:Some(_),..}if files.is_empty()));
    assert!(!f.0.join("escape.wav").exists());
    f.assert_no_stage(&dest);
}
#[cfg(unix)]
#[test]
fn linked_source_or_native_output_refuses() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let mut p = f.plan();
    let dest = f.destination();
    let original = p.items[0].sources[0].clone();
    let link = f.0.join("linked.wav");
    symlink(&original, &link).unwrap();
    p.items[0].sources[0] = link;
    assert!(
        matches!(run(&p,&dest,&||false,fake,|_,_,_|{}),EventKind::Finished{files,error:Some(_),..}if files.is_empty())
    );
    p.items[0].sources[0] = original.clone();
    assert!(
        matches!(run(&p,&dest,&||false,|stage,_,_,_|{symlink(&original,stage)?;Ok(())},|_,_,_|{}),EventKind::Finished{files,error:Some(_),..}if files.is_empty())
    );
    f.assert_no_stage(&dest);
}
#[cfg(unix)]
fn script(f: &Fixture, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let p = f.0.join("helper.py");
    fs::write(&p, format!("#!/usr/bin/python3\n{body}\n")).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
    p
}
#[cfg(unix)]
#[test]
fn native_bridge_runs_actual_subprocess_and_validates_receipt() {
    let f = Fixture::new();
    let helper = script(
        &f,
        "import sys,json\nassert sys.argv[1]=='--export-audio'\nassert sys.argv[2]=='wav'\nwith open(sys.argv[3],'xb') as out: out.write(b'encoded')\nprint(json.dumps(dict(protocol=1,ok=True,error='',bytes=7,sampleRate=44100,channels=2,frames=441,duration=.01)))",
    );
    let source = f.lane("custom-a", "A").file;
    let output = f.0.join("stage.wav");
    encode(&helper, &output, Format::Wav, &[source], &|| false).unwrap();
    assert_eq!(fs::read(output).unwrap(), b"encoded");
}
#[cfg(unix)]
#[test]
fn native_bridge_cancellation_is_cooperative_and_reaped() {
    let f = Fixture::new();
    let helper = script(
        &f,
        "import sys,time\nassert sys.stdin.readline().strip()=='cancel'\nprint('{\"protocol\":1,\"ok\":false,\"cancelled\":true,\"error\":\"Export cancelled\"}')",
    );
    let started = Instant::now();
    assert!(
        encode(
            &helper,
            &f.0.join("cancel.wav"),
            Format::Wav,
            &[],
            &|| started.elapsed() > Duration::from_millis(50)
        )
        .is_err()
    );
    assert!(started.elapsed() < Duration::from_secs(3));
}
#[cfg(unix)]
#[test]
fn malformed_or_oversized_native_receipt_cannot_publish() {
    let f = Fixture::new();
    for body in ["print('not json')", "print('x'*70000)"] {
        let helper = script(&f, body);
        assert!(encode(&helper, &f.0.join("stage.wav"), Format::Wav, &[], &|| false).is_err());
    }
}
#[cfg(unix)]
#[test]
fn service_emits_terminal_receipt_for_cancelled_queued_work() {
    let f = Fixture::new();
    let helper = script(
        &f,
        "import sys\nassert sys.stdin.readline().strip()=='cancel'\nprint('{\"protocol\":1,\"ok\":false,\"cancelled\":true,\"error\":\"cancelled\"}')",
    );
    let service = Service::new(helper);
    let id = service.start(f.plan(), f.destination()).unwrap();
    service.cancel(id);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(event) = service
            .drain()
            .into_iter()
            .find(|e| e.id == id && matches!(e.kind, EventKind::Finished { .. }))
        {
            assert!(
                matches!(event.kind,EventKind::Finished{files,cancelled:true,..}if files.is_empty())
            );
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn truncation_order_keeps_source_generated_trailing_dot_at_boundary() {
    let f = Fixture::new();
    let label = format!("{}.tail", "x".repeat(116));
    let lane = f.lane("custom-a", &label);
    let plan = Plan::capture(&[lane], &["custom-a".into()], Mode::Stems, Format::Wav).unwrap();
    assert_eq!(plan.items[0].name, format!("01-{}..wav", "x".repeat(116)));
    let dest = f.destination();
    assert!(matches!(
        run(&plan, &dest, &|| false, fake, |_, _, _| {}),
        EventKind::Finished { error: None, .. }
    ));
}
#[cfg(unix)]
#[test]
fn replaced_source_identity_is_refused_even_when_size_and_mtime_match() {
    use std::fs::FileTimes;
    let f = Fixture::new();
    let p = f.plan();
    let dest = f.destination();
    let result = run(
        &p,
        &dest,
        &|| false,
        |stage, format, sources, cancel| {
            fake(stage, format, sources, cancel)?;
            let path = &sources[0];
            let old = fs::metadata(path)?;
            fs::rename(path, path.with_extension("old"))?;
            fs::write(path, vec![b'x'; old.len() as usize])?;
            fs::File::options()
                .write(true)
                .open(path)?
                .set_times(FileTimes::new().set_modified(old.modified()?))?;
            Ok(())
        },
        |_, _, _| {},
    );
    assert!(
        matches!(result,EventKind::Finished{files,error:Some(message),..}if files.is_empty()&&message.contains("changed"))
    );
    f.assert_no_stage(&dest);
}
#[test]
fn cancellation_at_final_publication_decision_does_not_publish_encoded_output() {
    let f = Fixture::new();
    let plan = f.plan();
    let dest = f.destination();
    let cancelled = AtomicBool::new(false);
    let result = run_with_publication_hook(
        &plan,
        &dest,
        &|| cancelled.load(Ordering::Acquire),
        fake,
        |_, _, _| {},
        |target| {
            assert!(!target.exists());
            assert!(fs::read_dir(&dest).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".singz-export-")
            }));
            cancelled.store(true, Ordering::Release);
        },
    );
    assert!(
        matches!(result,EventKind::Finished{files,cancelled:true,error:None}if files.is_empty())
    );
    assert!(!dest.join(&plan.items[0].name).exists());
    assert!(!dest.join(&plan.items[1].name).exists());
    f.assert_no_stage(&dest);
}
