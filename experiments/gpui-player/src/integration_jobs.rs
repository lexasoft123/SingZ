//! Disk preparation and job joins. This coordinator never owns the helper pipe.
use super::*;
pub(super) struct Open {
    pub admission: Option<Admission>,
    pub epoch: u64,
    pub path: PathBuf,
    pub confirmed: Option<crate::project_delete::Target>,
    pub project: Project,
    pub met_commands: Vec<String>,
    pub manifest: Option<Manifest>,
    pub pending: Option<provider_control::PendingWork>,
}
pub(super) struct Lanes {
    pub epoch: u64,
    pub serial: u64,
    pub candidate: Project,
    pub additions: Vec<PathBuf>,
    pub intent: Arc<AtomicU64>,
    pub previous: Vec<crate::tracks::Lane>,
    pub stamps: Vec<(u64, std::time::SystemTime)>,
    pub refused: Option<Project>,
}
// Both creating/fsyncing and removing graph launch manifests run on jobs.
// Stale adoptions can drop this token on transport without unlinking a file.
pub(super) struct Manifest {
    value: Option<crate::native_graph::Manifest>,
    cleanup: mpsc::Sender<Job>,
}
impl Manifest {
    fn prepare(project: &Project, cleanup: &mpsc::Sender<Job>) -> Result<Option<Self>> {
        project
            .graph
            .as_ref()
            .map(|graph| {
                Ok(Self {
                    value: Some(crate::native_graph::Manifest::new(graph)?),
                    cleanup: cleanup.clone(),
                })
            })
            .transpose()
    }
    pub fn path(&self) -> &Path {
        self.value.as_ref().unwrap().path()
    }
}
impl Drop for Manifest {
    fn drop(&mut self) {
        if let Some(value) = self.value.take() {
            let _ = self.cleanup.send(Job::DisposeManifest(value));
        }
    }
}
pub(super) enum Job {
    DisposeManifest(crate::native_graph::Manifest),
    Request(Request),
    Forward(Request, Option<provider_control::PendingWork>),
    FlushMetronome,
    Lanes(Lanes),
    Import(
        u64,
        crate::project_import::Input,
        Option<provider_control::PendingWork>,
    ),
    Rename(
        u64,
        PathBuf,
        String,
        String,
        Option<provider_control::PendingWork>,
    ),
    Delete(
        u64,
        u64,
        bool,
        crate::project_delete::Target,
        Option<provider_control::PendingWork>,
    ),
    Restart(Option<Project>, u64),
    Stop(u64),
    PersistOutput(u64, String, Option<Status>),
    PrepareRecovery(
        u64,
        u64,
        AudioRecovery,
        String,
        Option<provider_control::PendingWork>,
    ),
    VerifyRecovery(u64, u64, Project, String, RecoveredAudio),
    PersistRecovery(u64, u64, String, RecoveredAudio),
    ChooseProvider(
        u64,
        u64,
        u64,
        u64,
        crate::audio_devices::Provider,
        provider_control::ProviderState,
        bool,
        bool,
        bool,
    ),
    OutputProbe(String),
    Shutdown,
}
#[path = "integration_job_lanes.rs"]
mod lanes;
#[cfg(test)]
pub(super) use lanes::release_slot;
pub(super) use lanes::{mailboxes, Sender};
pub(super) fn run(
    queues: lanes::Mailboxes,
    transport: SyncSender<Request>,
    initialized: mpsc::SyncSender<(String, provider_control::ProviderState)>,
    events: mpsc::Sender<Event>,
    latest: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
    text: Arc<gpui_kit::TextSystem>,
    training_intent: Arc<AtomicU64>,
    beat_intent: Arc<AtomicU64>,
    lyrics_preview_intent: Arc<AtomicU64>,
    lyrics_align_intent: Arc<AtomicU64>,
    lyrics_search_intent: Arc<AtomicU64>,
    provider_args: (
        Arc<AtomicU64>,
        Arc<AtomicU64>,
        Arc<AtomicU64>,
        Arc<AtomicU64>,
        Arc<Mutex<()>>,
        Arc<AtomicBool>,
    ),
    owner_busy: Arc<AtomicBool>,
    slots: Arc<AtomicU64>,
    dispatcher: Sender,
) {
    let requests = queues.background;
    let _exit =
        ActorExit::new(events.clone(), latest.clone(), alive.clone()).with_wake(transport.clone());
    let _ = events.send(Event::LyricsCapabilities(crate::lyrics_align::capability()));
    let (audio_preferences, prefs_error) = match crate::audio_devices::load() {
        Ok(raw) => (raw, None),
        Err(error) => (
            serde_json::json!({}),
            Some(format!("Could not read audio preferences: {error}")),
        ),
    };
    let global_met = match crate::metronome_store::load(&crate::audio_devices::directory()) {
        Ok(met) => {
            let _ = events.send(Event::MetronomePrefs(Ok(met.clone())));
            met
        }
        Err(e) => {
            let _ = events.send(Event::MetronomePrefs(Err(format!(
                "Could not restore metronome preferences: {e:#}"
            ))));
            crate::beat::Metronome::default()
        }
    };
    let global_carry = match crate::carry_line::load(&crate::audio_devices::directory()) {
        Ok(config) => {
            let _ = events.send(Event::CarryPrefs(Ok(config.clone())));
            config
        }
        Err(e) => {
            let _ = events.send(Event::CarryPrefs(Err(format!(
                "Could not restore Carry the line preferences: {e:#}"
            ))));
            Default::default()
        }
    };
    let (
        provider_selected,
        provider_renderer,
        provider_pending,
        provider_retired,
        provider_gate,
        provider_reserved,
    ) = provider_args;
    let selected = crate::audio_devices::restored_provider(&audio_preferences);
    let selected_error = selected.as_ref().err().map(|e| format!("{e:#}"));
    let selected = selected.unwrap_or(crate::audio_devices::Provider::Unsupported);
    provider_selected.store(selected.code(), Ordering::Release);
    let availability = crate::audio_devices::providers(&alive);
    let unavailable_error = availability
        .as_ref()
        .ok()
        .and_then(|facts| facts.require_available(selected).err())
        .map(|e| format!("{e:#}"));
    let provider_state = provider_control::ProviderState {
        snapshot: ProviderSnapshot {
            selected,
            availability: availability.as_ref().ok().cloned(),
            error: selected_error
                .or(unavailable_error)
                .or_else(|| availability.err().map(|e| format!("{e:#}"))),
            ..Default::default()
        },
        renderer: provider_renderer,
        pending: provider_pending.clone(),
        retired: provider_retired.clone(),
        gate: provider_gate.clone(),
        reserved: provider_reserved,
    };
    let restored_output =
        crate::audio_devices::scoped_output_uid(&audio_preferences, selected, cfg!(windows));
    let output_uid = restored_output.as_ref().cloned().unwrap_or_else(|_| {
        crate::audio_devices::output_uid(&audio_preferences).unwrap_or_default()
    });
    let prefs_error = prefs_error.or_else(|| {
        restored_output
            .err()
            .map(|e| format!("Could not restore audio output: {e:#}"))
    });
    let _ = events.send(Event::KaraokePref(crate::audio_devices::karaoke(
        &audio_preferences,
    )));
    let _ = events.send(Event::AudioPrefs(output_uid.clone(), prefs_error));
    let _ = events.send(Event::InputPrefs(
        crate::microphone::Prefs::read(&audio_preferences).map_err(|e| e.to_string()),
    ));
    *dispatcher
        .metronome
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = global_met;
    *dispatcher.carry.lock().unwrap_or_else(|e| e.into_inner()) = global_carry;
    let context = lanes::Context {
        transport: transport.clone(),
        events: events.clone(),
        latest: latest.clone(),
        alive: alive.clone(),
        text: text.clone(),
        training_intent: training_intent.clone(),
        provider_selected: provider_selected.clone(),
        provider_gate: provider_gate.clone(),
        provider_pending: provider_pending.clone(),
        owner_busy,
    };
    let services = lanes::start(
        queues.preparation,
        queues.catalog,
        queues.inventory,
        queues.inspect,
        queues.met,
        queues.lane,
        dispatcher.clone(),
        context,
    );
    let _ = initialized.send((output_uid, provider_state));
    let mut analysis: Option<thread::JoinHandle<()>> = None;
    let mut analysis_cancel: Option<Arc<AtomicBool>> = None;
    let mut beat_analysis: Option<thread::JoinHandle<()>> = None;
    let mut lyrics_envelope: Option<thread::JoinHandle<()>> = None;
    let mut lyrics_alignment: Option<thread::JoinHandle<()>> = None;
    let mut lyrics_search: Option<thread::JoinHandle<()>> = None;
    let mut deletions: Vec<thread::JoinHandle<()>> = vec![];
    let client = Arc::new(lyrics_client());

    while let Ok(job) = requests.recv() {
        if !alive.load(Ordering::Acquire) && !job.retained() {
            dispatcher.discard(job);
            continue;
        }
        let mut index = 0;
        while index < deletions.len() {
            if deletions[index].is_finished() {
                let _ = deletions.swap_remove(index).join();
            } else {
                index += 1;
            }
        }
        let request = match job {
            Job::Shutdown => break,
            Job::DisposeManifest(manifest) => {
                drop(manifest);
                continue;
            }
            Job::Request(request) => {
                lanes::release_slot(&slots);
                request
            }
            Job::Forward(request, _) => request,
            Job::Restart(snapshot, epoch) => {
                stop_analysis(&mut analysis, &mut analysis_cancel);
                restart_analysis(
                    snapshot,
                    epoch,
                    &events,
                    &latest,
                    &alive,
                    &mut analysis,
                    &mut analysis_cancel,
                );
                continue;
            }
            Job::Stop(epoch) => {
                stop_analysis_for_epoch(&mut analysis, &mut analysis_cancel, &events, epoch);
                continue;
            }
            Job::Lanes(prepared) => {
                if let Some(cancel) = analysis_cancel.take() {
                    cancel.store(false, Ordering::Release);
                }
                beat_intent.store(0, Ordering::Release);
                lyrics_preview_intent.store(0, Ordering::Release);
                lyrics_align_intent.store(0, Ordering::Release);
                lyrics_search_intent.store(0, Ordering::Release);
                let tasks = [
                    analysis.take(),
                    beat_analysis.take(),
                    lyrics_envelope.take(),
                    lyrics_alignment.take(),
                    lyrics_search.take(),
                ]
                .into_iter()
                .flatten()
                .collect();
                let _ = dispatcher
                    .lane
                    .send(lanes::LaneWork::Prepare(prepared, tasks));
                continue;
            }
            Job::Import(epoch, input, pending) => {
                stop_analysis(&mut analysis, &mut analysis_cancel);
                if let Some(job) = beat_analysis.take() {
                    let _ = job.join();
                }
                if let Some(job) = lyrics_envelope.take() {
                    let _ = job.join();
                }
                if let Some(job) = lyrics_alignment.take() {
                    let _ = job.join();
                }
                let copying = input.mode == crate::project_import::Mode::Copy;
                let cancel =
                    || !alive.load(Ordering::Acquire) || latest.load(Ordering::Acquire) != epoch;
                if cancel() {
                    continue;
                }
                let mut outcome = crate::project_import::execute(&input, &cancel);
                if let Err(error) =
                    crate::project_import::test_gate("SINGZ_GPUI_IMPORT_RECEIPT_GATE", &cancel)
                {
                    if outcome.warning.is_none() {
                        outcome.warning = Some(format!("{error:#}"));
                    }
                }
                let _ = transport.send(Request::ImportCompleted(epoch, outcome, copying, pending));
                continue;
            }
            Job::Rename(epoch, dir, expected, name, _pending) => {
                stop_analysis(&mut analysis, &mut analysis_cancel);
                if !alive.load(Ordering::Acquire) || latest.load(Ordering::Acquire) != epoch {
                    continue;
                }
                let (dir, warning) = match crate::project_rename::rename(&dir, &expected, &name) {
                    Ok(result) => (result.dir, result.warning),
                    Err(error) => (dir, Some(format!("{error:#}"))),
                };
                let identity = crate::project_store::read(&dir, "project.json")
                    .ok()
                    .and_then(|(raw, hash)| {
                        raw["name"].as_str().map(|name| (name.to_owned(), hash))
                    });
                let _ = events.send(Event::Renamed(epoch, dir, warning, identity));
                continue;
            }
            Job::Delete(serial, epoch, was_loaded, target, _pending) => {
                if was_loaded {
                    stop_analysis(&mut analysis, &mut analysis_cancel);
                    if let Some(job) = beat_analysis.take() {
                        let _ = job.join();
                    }
                    if let Some(job) = lyrics_envelope.take() {
                        let _ = job.join();
                    }
                    if let Some(job) = lyrics_alignment.take() {
                        let _ = job.join();
                    }
                    if let Some(job) = lyrics_search.take() {
                        let _ = job.join();
                    }
                }
                if deletions.len() >= 4 {
                    let _ = events.send(Event::Deleted(
                        serial,
                        epoch,
                        was_loaded,
                        Err("Project deletion queue is full".into()),
                    ));
                    continue;
                }
                let alive = alive.clone();
                let latest = latest.clone();
                let events = events.clone();
                deletions.push(thread::spawn(move || {
                    let result = crate::project_delete::delete(
                        &target,
                        &crate::audio_devices::directory(),
                        &|| delete_cancelled(was_loaded, epoch, &latest, &alive),
                    )
                    .map_err(|e| format!("{e:#}"));
                    let _ = events.send(Event::Deleted(serial, epoch, was_loaded, result));
                }));
                continue;
            }
            _ => unreachable!("job routed to the wrong lane"),
        };
        // Shutdown retains preferences already displayed by Root, including
        // input selection; unapplied audio intent never gains disk authority.
        if !alive.load(Ordering::Acquire) && !request.is_preference() {
            continue;
        }
        match request {
            #[cfg(test)]
            Request::HoldJob(entered, release) => {
                let _ = entered.send(());
                let _ = release.recv_timeout(Duration::from_secs(2));
            }
            Request::RetryLrclib => {
                if let Err(error) = client.retry_now() { eprintln!("LRCLIB retry: {error}"); }
            }
            Request::ResolveLyrics(epoch, serial, project, mode) => {
                if latest.load(Ordering::Acquire) != epoch
                    || lyrics_align_intent.load(Ordering::Acquire) != serial
                {
                    let _ = events.send(Event::LyricsResolved(
                        epoch,
                        serial,
                        Err(crate::lyrics_align::Failure::Cancelled),
                    ));
                    #[cfg(feature = "ui-tests")]
                    let _ = events.send(Event::LyricsJobSettled(epoch, serial));
                    continue;
                }
                if let Some(job) = lyrics_alignment.take() {
                    let _ = job.join();
                }
                let latest = latest.clone();
                let alive = alive.clone();
                let intent = lyrics_align_intent.clone();
                let events = events.clone();
                let client = client.clone();
                let text = text.clone();
                lyrics_alignment = Some(thread::spawn(move || {
                    let cancel = || {
                        !alive.load(Ordering::Acquire)
                            || latest.load(Ordering::Acquire) != epoch
                            || intent.load(Ordering::Acquire) != serial
                    };
                    let result = crate::lyrics_resolution::run(
                        &project,
                        mode,
                        &client,
                        &cancel,
                        &|progress| {
                            let _ = events
                                .send(Event::LyricsAlignmentProgress(epoch, serial, progress));
                        },
                    )
                    .and_then(|p| publish_resolved_lyrics(&project, p, &text, &cancel));
                    let _ = events.send(Event::LyricsResolved(epoch, serial, result));
                    #[cfg(feature = "ui-tests")]
                    let _ = events.send(Event::LyricsJobSettled(epoch, serial));
                }));
            }
            Request::SearchLyrics(epoch, serial, query, duration) => {
                if latest.load(Ordering::Acquire) != epoch
                    || lyrics_search_intent.load(Ordering::Acquire) != serial
                {
                    continue;
                }
                if let Some(job) = lyrics_search.take() {
                    let _ = job.join();
                }
                let latest = latest.clone();
                let alive = alive.clone();
                let intent = lyrics_search_intent.clone();
                let events = events.clone();
                let client = client.clone();
                lyrics_search = Some(thread::spawn(move || {
                    let cancel = || {
                        !alive.load(Ordering::Acquire)
                            || latest.load(Ordering::Acquire) != epoch
                            || intent.load(Ordering::Acquire) != serial
                    };
                    let query = crate::lrclib::SearchQuery {
                        free: Some(query),
                        artist: None,
                        title: None,
                    };
                    let result = client
                        .search(&query, duration, &cancel)
                        .map_err(|e| format!("{e:#}"));
                    if !cancel() {
                        let _ = events.send(Event::LyricsSearch(epoch, serial, result));
                    }
                }));
            }
            Request::LyricsCapabilities => {
                let _ = events.send(Event::LyricsCapabilities(crate::lyrics_align::capability()));
            }
            Request::AlignLyrics(epoch, serial, project, draft, tier) => {
                if latest.load(Ordering::Acquire) != epoch
                    || lyrics_align_intent.load(Ordering::Acquire) != serial
                {
                    continue;
                }
                if let Some(job) = lyrics_alignment.take() {
                    let _ = job.join();
                }
                let latest = latest.clone();
                let alive = alive.clone();
                let intent = lyrics_align_intent.clone();
                let events = events.clone();
                lyrics_alignment = Some(thread::spawn(move || {
                    let cancel = || {
                        !alive.load(Ordering::Acquire)
                            || latest.load(Ordering::Acquire) != epoch
                            || intent.load(Ordering::Acquire) != serial
                    };
                    let result = crate::lyrics_align::capture(
                        &project,
                        draft,
                        project.pitch.duration as f64,
                        tier,
                    )
                    .map_err(|e| crate::lyrics_align::Failure::Error(format!("{e:#}")))
                    .and_then(|input| {
                        crate::lyrics_align::run(&input, &cancel, &|progress| {
                            let _ = events
                                .send(Event::LyricsAlignmentProgress(epoch, serial, progress));
                        })
                    });
                    if !cancel() {
                        let _ = events.send(Event::LyricsAligned(epoch, serial, result));
                    }
                }));
            }
            Request::LyricsEnvelope(epoch, serial, project) => {
                if latest.load(Ordering::Acquire) != epoch
                    || lyrics_preview_intent.load(Ordering::Acquire) != serial
                {
                    continue;
                }
                if let Some(job) = lyrics_envelope.take() {
                    let _ = job.join();
                }
                let latest = latest.clone();
                let alive = alive.clone();
                let intent = lyrics_preview_intent.clone();
                let events = events.clone();
                lyrics_envelope = Some(thread::spawn(move || {
                    let cancel = || {
                        !alive.load(Ordering::Acquire)
                            || latest.load(Ordering::Acquire) != epoch
                            || intent.load(Ordering::Acquire) != serial
                    };
                    let result = (|| -> Result<Arc<crate::lyrics_envelope::Envelopes>> {
                        let source = &project
                            .lanes
                            .iter()
                            .find(|(i, _)| *i == 0)
                            .context("No vocal source")?
                            .1;
                        crate::lyrics_envelope::run(
                            source,
                            project
                                .vocal_stamp
                                .context("Missing loaded vocal identity")?,
                            &cancel,
                        )
                    })()
                    .map_err(|e| format!("{e:#}"));
                    if !cancel() {
                        let _ = events.send(Event::LyricsEnvelope(epoch, serial, result));
                    }
                }));
            }
            Request::DetectBeats(epoch, serial, project) => {
                if latest.load(Ordering::Acquire) != epoch
                    || beat_intent.load(Ordering::Acquire) != serial
                {
                    continue;
                }
                if let Some(task) = beat_analysis.take() {
                    let _ = task.join();
                }
                let latest = latest.clone();
                let alive = alive.clone();
                let intent = beat_intent.clone();
                let events = events.clone();
                beat_analysis = Some(thread::spawn(move || {
                    let cancel = || {
                        !alive.load(Ordering::Acquire)
                            || latest.load(Ordering::Acquire) != epoch
                            || intent.load(Ordering::Acquire) != serial
                    };
                    let result = (|| -> Result<crate::beat_analysis::Output> {
                        anyhow::ensure!(
                            project.lanes.len() == project.lane_stamps.len(),
                            "Missing loaded beat source stamps"
                        );
                        for ((slot, path), stamp) in project
                            .lanes
                            .iter()
                            .zip(&project.lane_stamps)
                            .filter(|((slot, _), _)| *slot < crate::tracks::BUILTIN_SLOTS)
                        {
                            let _ = slot;
                            anyhow::ensure!(
                                crate::project_analysis::stamp(path)? == *stamp,
                                "Beat input changed after project loading"
                            );
                        }
                        let lines = project
                            .lyrics
                            .as_ref()
                            .map(|d| {
                                d.lines
                                    .iter()
                                    .map(|l| l.words.first().map_or(l.start, |w| w.start) as f64)
                                    .collect()
                            })
                            .unwrap_or_default();
                        let words = project
                            .lyrics
                            .as_ref()
                            .map(|d| {
                                d.lines
                                    .iter()
                                    .flat_map(|l| {
                                        l.words.iter().map(|w| (w.start as f64, w.end as f64))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let input = crate::beat_analysis::capture(
                            project
                                .lanes
                                .iter()
                                .filter(|(slot, _)| *slot < crate::tracks::BUILTIN_SLOTS)
                                .cloned()
                                .collect(),
                            project.pitch.duration as f64,
                            epoch,
                            serial,
                            lines,
                            words,
                        )?;
                        input.verify_loaded(&project.lanes, &project.lane_stamps)?;
                        let output =
                            crate::beat_analysis::run_with_progress(&input, &cancel, &|p| {
                                let _ = events.send(Event::BeatsProgress(epoch, serial, p));
                            })?;
                        input.verify_loaded(&project.lanes, &project.lane_stamps)?;
                        Ok(output)
                    })()
                    .map_err(|e| format!("{e:#}"));
                    if !cancel() {
                        let _ = events.send(Event::BeatsDetected(epoch, serial, result));
                    }
                }));
            }
            Request::SaveLyrics(epoch, serial, dir, expected, lines, credit) => {
                let result = (|| -> Result<ResolvedLyrics> {
                    anyhow::ensure!(latest.load(Ordering::Acquire)==epoch,"Lyrics Save superseded");
                    let (_,mut document)=crate::lyrics_store::edited_value(None,&lines,credit.as_deref())?;
                    crate::project_lyrics::prepare_masks(&mut document,&text,||!alive.load(Ordering::Acquire)||latest.load(Ordering::Acquire)!=epoch)?;
                    anyhow::ensure!(alive.load(Ordering::Acquire)&&latest.load(Ordering::Acquire)==epoch,"Lyrics Save superseded");
                    let saved=crate::lyrics_store::save(&dir,expected.as_deref(),&lines,credit.as_deref())?;
                    // The explicit editor snapshot owns source and credit;
                    // keep prepared masks while retaining its published metadata.
                    if let Some(persisted)=saved.document {
                        document.source=persisted.source;
                        document.credit=persisted.credit;
                    }
                    #[cfg(feature="ui-tests")]
                    if let Some(gate)=std::env::var_os("SINGZ_GPUI_LYRICS_TEST_RECEIPT_GATE").map(PathBuf::from).filter(|p|p.exists()) {
                        let _=std::fs::write(gate.with_extension("ready"),b"saved");
                        let deadline=Instant::now()+Duration::from_secs(5);
                        while gate.exists()&&alive.load(Ordering::Acquire)&&Instant::now()<deadline {thread::sleep(Duration::from_millis(10));}
                    }
                    let raw=saved.raw.context("Saved lyrics metadata is missing")?;
                    let mut warnings=vec![];
                    if let Err(e)=crate::sync_dirty::mark_file(&dir.join("lyrics.json"),"lyrics") {warnings.push(format!("Lyrics were saved, but the pending-sync record could not be written: {e:#}. Save again to retry."));}
                    Ok(ResolvedLyrics{document:Arc::new(document),fingerprint:saved.fingerprint,raw,check:None,written:true,cached:false,warnings})
                })().map_err(|e|format!("{e:#}"));
                let _ = events.send(Event::LyricsSaved(epoch, serial, result));
            }
            _ => unreachable!("helper request sent to jobs coordinator"),
        }
    }
    for service in services {
        let _ = service.join();
    }
    for task in deletions {
        let _ = task.join();
    }
    stop_analysis(&mut analysis, &mut analysis_cancel);
    if let Some(task) = beat_analysis {
        let _ = task.join();
    }
    if let Some(task) = lyrics_envelope {
        let _ = task.join();
    }
    if let Some(task) = lyrics_alignment {
        let _ = task.join();
    }
    if let Some(task) = lyrics_search {
        let _ = task.join();
    }
}

impl Job {
    fn retained(&self) -> bool {
        match self {
            Self::Shutdown
            | Self::DisposeManifest(..)
            | Self::FlushMetronome
            | Self::PersistOutput(..)
            | Self::PersistRecovery(..) => true,
            Self::Request(request) | Self::Forward(request, _) => request.is_preference(),
            _ => false,
        }
    }
}
