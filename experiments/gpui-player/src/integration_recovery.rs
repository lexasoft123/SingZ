//! Reprepare audio from an owned document snapshot; never reopen its editor.
use super::*;

pub struct AudioRecovery {
    pub replace: bool,
    pub project: Project,
    pub mix: crate::project_store::Mix,
    pub position: f32,
}
pub struct RecoveredMedia {
    pub peaks: Vec<Vec<f32>>,
    pub vocal_duration: Option<f32>,
}
pub struct RecoveredAudio {
    pub media: Option<RecoveredMedia>,
    pub status: Status,
    pub preference_error: Option<String>,
}
#[derive(Clone)]
pub struct Publication {
    pub path: PathBuf,
    pub metadata_hash: String,
}

pub(super) fn read_publication(publication: &Publication) -> Result<Project> {
    let project = read_project(&publication.path)?;
    anyhow::ensure!(
        project.metadata_hash == publication.metadata_hash,
        "Saved project changed before its publication could be adopted"
    );
    verify_media(&project)?;
    Ok(project)
}

fn verify_media(project: &Project) -> Result<()> {
    anyhow::ensure!(
        fs::symlink_metadata(&project.dir)?.file_type().is_dir()
            && project.dir.canonicalize()? == project.dir,
        "Loaded project folder changed"
    );
    let (_, hash) = crate::project_store::read(&project.dir, "project.json")?;
    anyhow::ensure!(
        hash == project.metadata_hash,
        "Project metadata changed since loading; retained edits have not been overwritten"
    );
    anyhow::ensure!(
        project.lanes.len() == project.lane_stamps.len(),
        "Missing loaded audio identities"
    );
    native_lane_sources(project)?;
    for ((_, path), expected) in project.lanes.iter().zip(&project.lane_stamps) {
        anyhow::ensure!(
            fs::symlink_metadata(path)?.file_type().is_file()
                && path.canonicalize()? == *path
                && crate::project_analysis::stamp(path)? == *expected,
            "Loaded audio changed before output recovery: {}",
            path.display()
        );
    }
    // Recheck the saved graph's original hash; use the owned prepared projection.
    crate::native_graph::read(&project.dir, &project.raw)?;
    Ok(())
}

fn captured_project(request: &AudioRecovery) -> Result<Project> {
    let mut project = request.project.clone();
    let mix = &request.mix;
    anyhow::ensure!(
        request.position.is_finite() && request.position >= 0.,
        "Invalid recovery position"
    );
    anyhow::ensure!(
        mix.original == project.original
            && mix.lanes
                == project
                    .lanes
                    .iter()
                    .map(|(slot, _)| *slot)
                    .collect::<Vec<_>>()
            && mix.custom == project.custom_tracks(),
        "Recovery track identity differs from the retained document"
    );
    crate::project_store::update_mix(project.raw.clone(), mix)?;
    project.gain = mix.gain;
    project.muted = mix.muted;
    project.solo = mix.solo;
    project.master = mix.master;
    project.tempo = mix.tempo;
    project.transpose = mix.transpose;
    project.looping = mix.looping;
    project.selection = mix.selection;
    project.view = Some(mix.view);
    project.metronome = mix.metronome.clone();
    project.beat = mix.beat.clone();
    project.carry = mix.carry.clone();
    verify_media(&project)?;
    Ok(project)
}

pub(super) fn prepare(
    request: &AudioRecovery,
    epoch: u64,
    latest: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
    handoff: Arc<AtomicU64>,
    uid: &str,
) -> Result<(Connection, Status, RecoveredMedia)> {
    anyhow::ensure!(
        uid.len() <= 2000 && !uid.contains('\0'),
        "Invalid output device"
    );
    let mut project = captured_project(request)?;
    let (mut child, receipt) = Connection::open(
        Some(&project),
        epoch,
        latest.clone(),
        alive.clone(),
        handoff,
        uid,
    )?;
    let initial = Status::parse(&receipt)?;
    let media = RecoveredMedia {
        peaks: peaks_from(&receipt),
        vocal_duration: vocal_lane_duration(&receipt)?,
    };
    child.command(&format!("master {}", project.master))?;
    for (lane, (slot, _)) in project.lanes.iter().enumerate() {
        child.command(&format!(
            "lane {lane} {} {} {}",
            project.gain[*slot],
            u8::from(project.muted[*slot]),
            u8::from(project.solo[*slot])
        ))?;
    }
    if project.has_audio() {
        child.metronome(&crate::beat::commands(
            &project.metronome,
            project.beat.as_ref(),
        )?)?;
        if project.looping {
            let (start, end) = project.selection.unwrap();
            child.command(&format!("loop {start} {end}"))?;
        }
        if let Some(plan) = open_carry_plan(&mut project, initial.duration as f64)? {
            child.carry_with_arming(&plan, false).map_err(|failure| {
                anyhow::anyhow!(
                    "{}",
                    match failure {
                        LaneReplaceFailure::Refused(e)
                        | LaneReplaceFailure::Committed(e)
                        | LaneReplaceFailure::Disconnected(e) => e,
                    }
                )
            })?;
        }
        let status = settled_seek(&mut child, request.position)?;
        verify_media(&project)?;
        anyhow::ensure!(
            alive.load(Ordering::Acquire) && latest.load(Ordering::Acquire) == epoch,
            "Output recovery superseded"
        );
        return Ok((child, status, media));
    }
    let status = child.command("status")?;
    anyhow::ensure!(
        status.empty_project
            && !status.playing
            && status.position == 0.
            && status.physical_output_released,
        "Empty project recovery opened song audio"
    );
    verify_media(&project)?;
    anyhow::ensure!(
        alive.load(Ordering::Acquire) && latest.load(Ordering::Acquire) == epoch,
        "Output recovery superseded"
    );
    Ok((child, status, media))
}

/// A source handoff must finish the callback-applied paused seek before a
/// queued Loop/Play can be mistaken for its acknowledgement.
pub(super) fn settled_seek(child: &mut Connection, position: f32) -> Result<Status> {
    anyhow::ensure!(
        position.is_finite() && position >= 0.,
        "Invalid restored position"
    );
    let before = child.command("status")?;
    anyhow::ensure!(
        !before.playing && !before.training_only && !before.empty_project,
        "Restoration requires a paused song graph"
    );
    let target = position.min(before.duration);
    child.command(&format!("seek {target}"))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status = child.command("status")?;
        if !status.playing
            && !status.counting_in
            && status.seek_count > before.seek_count
            && (status.position - target).abs() <= 0.025
        {
            return Ok(status);
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "Restored native seek did not settle paused"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "singz-audio-recovery-{}",
                crate::drive_http::random_id().unwrap()
            ));
            fs::create_dir_all(dir.join("stems")).unwrap();
            fs::write(
                dir.join("stems/vocals.wav"),
                b"captured native media identity",
            )
            .unwrap();
            fs::write(
                dir.join("project.json"),
                br#"{"version":2,"name":"Recovery","settings":{},"foreign":{"keep":true}}"#,
            )
            .unwrap();
            Self(dir.canonicalize().unwrap())
        }
        fn request(&self) -> AudioRecovery {
            let project = read_project(&self.0).unwrap();
            let mix = crate::project_store::Mix {
                carry: project.carry.clone(),
                metronome: project.metronome.clone(),
                beat: project.beat.clone(),
                original: project.original,
                lanes: project.lanes.iter().map(|(slot, _)| *slot).collect(),
                custom: project.custom_tracks(),
                gain: project.gain,
                muted: project.muted,
                solo: project.solo,
                master: project.master,
                transpose: project.transpose,
                tempo: project.tempo,
                looping: false,
                selection: Some((0., 10.)),
                view: (0., 10.),
            };
            AudioRecovery {
                replace: true,
                project,
                mix,
                position: 2.,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn recovery_uses_unsaved_accepted_mix_without_readopting_disk_settings() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        let before = fs::read(fixture.0.join("project.json")).unwrap();
        request.mix.master = 0.31;
        request.mix.gain[0] = 0.47;
        request.mix.muted[0] = true;
        request.mix.tempo = 0.8;
        request.mix.transpose = 2;
        request.mix.looping = true;
        request.mix.selection = Some((1., 4.));
        let captured = captured_project(&request).unwrap();
        assert_eq!(captured.master, 0.31);
        assert_eq!(captured.gain[0], 0.47);
        assert!(captured.muted[0]);
        assert_eq!(captured.tempo, 0.8);
        assert_eq!(captured.transpose, 2);
        assert_eq!(captured.selection, Some((1., 4.)));
        assert_eq!(captured.metadata_hash, request.project.metadata_hash);
        assert_eq!(captured.raw, request.project.raw);
        assert_eq!(fs::read(fixture.0.join("project.json")).unwrap(), before);
    }
    #[test]
    fn recovery_refuses_missing_or_changed_media_metadata_and_track_inventory() {
        let fixture = Fixture::new();
        let mut request = fixture.request();
        request.mix.lanes.clear();
        assert!(captured_project(&request).is_err());
        let mut request = fixture.request();
        request.position = f32::NAN;
        assert!(captured_project(&request).is_err());
        let mut request = fixture.request();
        request.project.lane_stamps.clear();
        assert!(captured_project(&request).is_err());
        let request = fixture.request();
        // Both old fixture strings were accidentally 30 bytes; a filesystem
        // can give two immediate writes the same timestamp. Exercise the
        // size-and-mtime identity contract with a guaranteed size change.
        let replacement = b"changed retained audio with a distinct length";
        assert_ne!(replacement.len() as u64, request.project.lane_stamps[0].0);
        fs::write(fixture.0.join("stems/vocals.wav"), replacement).unwrap();
        assert!(
            captured_project(&request)
                .unwrap_err()
                .to_string()
                .contains("Loaded audio changed")
        );
        let request = fixture.request();
        fs::write(
            fixture.0.join("project.json"),
            br#"{"version":2,"settings":{},"name":"Foreign replacement"}"#,
        )
        .unwrap();
        assert!(
            captured_project(&request)
                .unwrap_err()
                .to_string()
                .contains("metadata changed")
        );
    }
    #[test]
    fn publication_adoption_is_bound_to_the_writers_exact_metadata_hash() {
        let fixture = Fixture::new();
        let request = fixture.request();
        let publication = Publication {
            path: fixture.0.clone(),
            metadata_hash: request.project.metadata_hash.clone(),
        };
        assert_eq!(
            read_publication(&publication).unwrap().metadata_hash,
            publication.metadata_hash
        );
        fs::write(
            fixture.0.join("project.json"),
            br#"{"version":2,"settings":{},"name":"Replaced after Save"}"#,
        )
        .unwrap();
        assert!(
            read_publication(&publication)
                .unwrap_err()
                .to_string()
                .contains("publication could be adopted")
        );
    }
    #[cfg(unix)]
    #[test]
    fn recovery_refuses_linked_media_even_when_its_stamp_is_preserved() {
        let fixture = Fixture::new();
        let request = fixture.request();
        let source = fixture.0.join("stems/vocals.wav");
        let moved = fixture.0.join("original.wav");
        fs::rename(&source, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &source).unwrap();
        assert!(captured_project(&request).is_err());
    }
}
