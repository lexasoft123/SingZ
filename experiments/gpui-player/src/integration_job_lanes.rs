//! Blocking discovery, preparation, lane-join and preference workers.
//! None owns or receives a Connection; helper adoption stays on transport.
use super::*;
pub(in crate::integration) struct Mailboxes {
    pub background: Receiver<Job>,
    pub preparation: Receiver<Job>,
    pub catalog: Receiver<Job>,
    pub inventory: Receiver<Job>,
    pub inspect: Receiver<Job>,
    pub met: Receiver<Job>,
    pub lane: Receiver<LaneWork>,
}
pub(in crate::integration) enum LaneWork {
    Prepare(Lanes, Vec<thread::JoinHandle<()>>),
    Shutdown,
}
struct MetWrite {
    met: crate::beat::Metronome,
    receipts: Vec<(u64, u64)>,
}
#[derive(Clone)]
pub(in crate::integration) struct Sender {
    pub tx: mpsc::Sender<Job>,
    pub transport: SyncSender<Request>,
    preparation: mpsc::Sender<Job>,
    catalog: mpsc::Sender<Job>,
    inventory: mpsc::Sender<Job>,
    inspect: mpsc::Sender<Job>,
    met: mpsc::Sender<Job>,
    pub lane: mpsc::Sender<LaneWork>,
    pending: Arc<AtomicU64>,
    pub slots: Arc<AtomicU64>,
    pub metronome: Arc<Mutex<crate::beat::Metronome>>,
    pub carry: Arc<Mutex<crate::carry_line::Config>>,
    pending_met: Arc<Mutex<Option<MetWrite>>>,
    #[cfg(test)]
    pub hooks: Arc<actor_tests::Hooks>,
}
pub(in crate::integration) fn mailboxes(
    pending: Arc<AtomicU64>,
    transport: SyncSender<Request>,
) -> (Sender, Mailboxes) {
    let (tx, background) = mpsc::channel();
    let (pt, preparation) = mpsc::channel();
    let (ct, catalog) = mpsc::channel();
    let (it, inventory) = mpsc::channel();
    let (dt, inspect) = mpsc::channel();
    let (mt, met) = mpsc::channel();
    let (lt, lane) = mpsc::channel();
    (
        Sender {
            tx,
            transport,
            preparation: pt,
            catalog: ct,
            inventory: it,
            inspect: dt,
            met: mt,
            lane: lt,
            pending,
            slots: Arc::new(AtomicU64::new(0)),
            metronome: Arc::new(Mutex::new(Default::default())),
            carry: Arc::new(Mutex::new(Default::default())),
            pending_met: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            hooks: Arc::new(Default::default()),
        },
        Mailboxes {
            background,
            preparation,
            catalog,
            inventory,
            inspect,
            met,
            lane,
        },
    )
}
pub(in crate::integration) fn release_slot(slots: &AtomicU64) {
    let _ = slots.fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
        Some(n.saturating_sub(1))
    });
}
impl Sender {
    pub fn record_metronome(&self, epoch: u64, serial: u64, met: crate::beat::Metronome) {
        *self.metronome.lock().unwrap_or_else(|e| e.into_inner()) = met.clone();
        let mut pending = self.pending_met.lock().unwrap_or_else(|e| e.into_inner());
        let wake = pending.is_none();
        if let Some(batch) = pending.as_mut() {
            batch.met = met;
            batch.receipts.push((epoch, serial));
        } else {
            *pending = Some(MetWrite {
                met,
                receipts: vec![(epoch, serial)],
            });
        }
        drop(pending);
        if wake {
            let _ = self.met.send(Job::FlushMetronome);
        }
    }
    pub fn discard(&self, job: Job) {
        match job {
            Job::Request(request) => {
                release_slot(&self.slots);
                if provider_control::ownership_request(&request) {
                    drop(provider_control::PendingWork(
                        self.pending.clone(),
                        self.transport.clone(),
                    ));
                }
            }
            _ => {}
        }
    }
    pub fn send(&self, job: Job) -> std::result::Result<(), mpsc::SendError<Job>> {
        if let Job::Forward(Request::AdoptMetronomePreferences(epoch, met), _) = job {
            self.record_metronome(epoch, 0, met);
            return Ok(());
        }
        if matches!(&job, Job::Shutdown) {
            for queue in [
                &self.preparation,
                &self.catalog,
                &self.inventory,
                &self.inspect,
                &self.met,
            ] {
                let _ = queue.send(Job::Shutdown);
            }
            let _ = self.lane.send(LaneWork::Shutdown);
            return self.tx.send(job);
        }
        let target = match &job {
            Job::Request(Request::Catalog(..)) => &self.catalog,
            Job::Request(Request::Inventory) => &self.inventory,
            Job::Request(Request::InspectDelete(..)) => &self.inspect,
            Job::Request(
                Request::Open(..)
                | Request::RecoverOutput(..)
                | Request::ReadPublication(..)
                | Request::AdoptCarryPreferences(..)
                | Request::KaraokePref(..)
                | Request::InputPrefs(..),
            )
            | Job::Forward(..)
            | Job::PersistOutput(..)
            | Job::PrepareRecovery(..)
            | Job::VerifyRecovery(..)
            | Job::PersistRecovery(..)
            | Job::ChooseProvider(..)
            | Job::OutputProbe(..) => &self.preparation,
            _ => &self.tx,
        };
        target.send(job)
    }
}
#[derive(Clone)]
pub(in crate::integration) struct Context {
    pub transport: SyncSender<Request>,
    pub events: mpsc::Sender<Event>,
    pub latest: Arc<AtomicU64>,
    pub alive: Arc<AtomicBool>,
    pub text: Arc<gpui_kit::TextSystem>,
    pub training_intent: Arc<AtomicU64>,
    pub provider_selected: Arc<AtomicU64>,
    pub provider_gate: Arc<Mutex<()>>,
    pub provider_pending: Arc<AtomicU64>,
    pub owner_busy: Arc<AtomicBool>,
}
pub(in crate::integration) fn start(
    preparation: Receiver<Job>,
    catalog: Receiver<Job>,
    inventory: Receiver<Job>,
    inspect: Receiver<Job>,
    met: Receiver<Job>,
    lane: Receiver<LaneWork>,
    dispatcher: Sender,
    context: Context,
) -> Vec<thread::JoinHandle<()>> {
    let mut services = vec![];
    for (name, rx) in [
        ("native-prepare", preparation),
        ("native-catalog", catalog),
        ("native-inventory", inventory),
        ("native-delete-inspect", inspect),
        ("native-met-prefs", met),
    ] {
        let dispatcher = dispatcher.clone();
        let context = context.clone();
        services.push(
            thread::Builder::new()
                .name(name.into())
                .spawn(move || run(rx, dispatcher, context))
                .expect("spawn native jobs lane"),
        );
    }
    services.push(
        thread::Builder::new()
            .name("native-track-joins".into())
            .spawn(move || run_lanes(lane, dispatcher, context))
            .expect("spawn native track join lane"),
    );
    services
}
fn run(requests: Receiver<Job>, dispatcher: Sender, context: Context) {
    let Context {
        transport,
        events,
        latest,
        alive,
        text,
        training_intent,
        provider_selected,
        provider_gate,
        provider_pending,
        owner_busy,
    } = context;
    let _exit =
        ActorExit::new(events.clone(), latest.clone(), alive.clone()).with_wake(transport.clone());
    let cleanup = dispatcher.tx.clone();
    #[cfg(test)]
    let hooks = dispatcher.hooks.clone();
    while let Ok(job) = requests.recv() {
        if !alive.load(Ordering::Acquire) && !job.retained() {
            dispatcher.discard(job);
            continue;
        }
        let (request, mut pending) = match job {
            Job::Shutdown => break,
            Job::Request(request) => {
                release_slot(&dispatcher.slots);
                let pending = provider_control::ownership_request(&request).then(|| {
                    provider_control::PendingWork(provider_pending.clone(), transport.clone())
                });
                (request, pending)
            }
            Job::Forward(request, pending) => (request, pending),
            Job::FlushMetronome => {
                #[cfg(test)]
                hooks.enter("met-write", &alive);
                let batch = dispatcher
                    .pending_met
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take();
                if let Some(batch) = batch {
                    #[cfg(test)]
                    hooks.met_writes.fetch_add(1, Ordering::Relaxed);
                    let error = crate::metronome_store::retain(
                        &crate::audio_devices::directory(),
                        &batch.met,
                    )
                    .err()
                    .map(|e| format!("Could not save metronome preferences: {e:#}"));
                    for (epoch, serial) in batch.receipts {
                        let _ =
                            events.send(Event::MetronomePrefsSaved(epoch, serial, error.clone()));
                    }
                }
                continue;
            }

            Job::PersistOutput(epoch, uid, status) => {
                let error = crate::audio_devices::save(&uid)
                    .err()
                    .map(|e| format!("Output applied, but preferences could not be saved: {e}"));
                let _ = events.send(Event::OutputChanged(epoch, uid, status, error));
                continue;
            }
            Job::PrepareRecovery(epoch, serial, mut request, uid, pending) => {
                if !adopt_current(epoch, None, &latest, &alive) {
                    continue;
                }
                match recovery::captured_project(&request) {
                    Ok(project) => {
                        request.project = project;
                        if adopt_current(epoch, None, &latest, &alive) {
                            let manifest = Manifest::prepare(&request.project, &cleanup);
                            match manifest {
                                Ok(manifest) => {
                                    let _ = transport.send(Request::AdoptRecovery(
                                        epoch, serial, request, uid, pending, true, manifest,
                                    ));
                                }
                                Err(e) => {
                                    let _ = events.send(Event::OutputRecovered(
                                        epoch,
                                        serial,
                                        uid,
                                        Err(format!("{e:#}")),
                                    ));
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = events.send(Event::OutputRecovered(
                            epoch,
                            serial,
                            uid,
                            Err(format!("{e:#}")),
                        ));
                    }
                }
                continue;
            }
            Job::VerifyRecovery(epoch, serial, project, uid, recovered) => {
                #[cfg(test)]
                hooks.enter("verify", &alive);
                if !adopt_current(epoch, None, &latest, &alive) {
                    continue;
                }
                let result = recovery::verify_media(&project)
                    .map(|_| recovered)
                    .map_err(|e| format!("{e:#}"));
                if adopt_current(epoch, None, &latest, &alive) {
                    let _ = transport.send(Request::RecoveryVerified(epoch, serial, uid, result));
                }
                continue;
            }
            Job::PersistRecovery(epoch, serial, uid, mut recovered) => {
                recovered.preference_error = crate::audio_devices::save(&uid)
                    .err()
                    .map(|e| format!("Output applied, but preferences could not be saved: {e:#}"));
                let _ = events.send(Event::OutputRecovered(epoch, serial, uid, Ok(recovered)));
                continue;
            }
            Job::ChooseProvider(
                serial,
                revision,
                epoch,
                renderer,
                provider,
                mut state,
                connection,
                monitor,
                training,
            ) => {
                let mut uid = String::new();
                let quarantined = state.choose(
                    &events,
                    &latest,
                    &alive,
                    &provider_selected,
                    serial,
                    revision,
                    epoch,
                    renderer,
                    provider,
                    connection,
                    monitor,
                    training,
                    &training_intent,
                    &mut uid,
                    &owner_busy,
                );
                let _ = transport.send(Request::ProviderChosen(state, uid, quarantined));
                continue;
            }
            Job::OutputProbe(uid) => {
                #[cfg(test)]
                hooks.enter("output-probe", &alive);
                let result = crate::audio_devices::inventory_with_provider(
                    &alive,
                    crate::audio_devices::Provider::from_code(
                        provider_selected.load(Ordering::Acquire),
                    ),
                )
                .and_then(|inventory| inventory.output(&uid).map(|_| ()));
                let _ = transport.send(Request::OutputProbed(
                    uid,
                    result.map_err(|e| format!("{e:#}")),
                ));
                continue;
            }
            _ => unreachable!("job routed to the wrong preparation lane"),
        };
        let (request, mut admission) = match request {
            Request::Admitted(request, permit) => (*request, Some(permit)),
            request => (request, None),
        };
        match request {
            Request::KaraokePref(sequence, enabled) => {
                let error = crate::audio_devices::save_karaoke(enabled)
                    .err()
                    .map(|error| {
                        format!(
                            "Karaoke mode changed, but its preference could not be saved: {error:#}"
                        )
                    });
                let _ = events.send(Event::KaraokePrefSaved(sequence, error));
            }
            Request::InputPrefs(sequence, prefs) => {
                let error = crate::audio_devices::save_input(&prefs).err().map(|e| {
                    format!(
                        "Microphone choice was applied, but preferences could not be saved: {e:#}"
                    )
                });
                let _ = events.send(Event::InputPrefsSaved(sequence, error));
            }

            Request::ReadPublication(epoch, serial, publication) => {
                #[cfg(test)]
                hooks.enter("preparation", &alive);
                let result = (|| -> Result<Project> {
                    anyhow::ensure!(
                        alive.load(Ordering::Acquire) && latest.load(Ordering::Acquire) == epoch,
                        "Publication adoption superseded"
                    );
                    let project = recovery::read_publication(&publication)?;
                    anyhow::ensure!(
                        alive.load(Ordering::Acquire) && latest.load(Ordering::Acquire) == epoch,
                        "Publication adoption superseded"
                    );
                    Ok(project)
                })()
                .map_err(|e| format!("{e:#}"));
                let _ = events.send(Event::PublicationRead(epoch, serial, result));
            }
            Request::Catalog(serial, catalog_intent) => {
                #[cfg(test)]
                hooks.enter("catalog", &alive);
                // Library/cloud filesystem access must not queue ahead of Pause/Stop.
                let events = events.clone();
                let alive = alive.clone();
                (move || {
                    let root = library_root();
                    // Local crash recovery must also work while Drive is signed
                    // out. It finishes before enumerating restored/moved rows.
                    if root.is_dir() {
                        let config = crate::audio_devices::directory();
                        let recovery = crate::drive_local_ops::Store::new(config.clone())
                            .recover_prepared(
                                &root,
                                &crate::sync_dirty::Store::new(config),
                                |from, to| {
                                    crate::project_delete::exclusive_move(from, to)
                                        .map_err(anyhow::Error::from)
                                },
                            );
                        match recovery {
                            Ok(report) => {
                                for warning in report.warnings.iter().chain(report.blocked.iter()) {
                                    crate::diagnostics::event(
                                        "projects",
                                        warning.clone(),
                                        crate::diagnostics::Level::Warn,
                                    );
                                }
                            }
                            Err(error) => crate::diagnostics::event(
                                "projects",
                                format!("Local project recovery remains unresolved: {error:#}"),
                                crate::diagnostics::Level::Warn,
                            ),
                        }
                    }
                    let mut projects = vec![];
                    if let Ok(entries) = fs::read_dir(&root) {
                        for entry in entries.flatten() {
                            if [
                                ".native-import-",
                                ".native-split-",
                                ".singz-adopting-",
                                ".singz-library-",
                                ".singz-native-",
                            ]
                            .iter()
                            .any(|prefix| entry.file_name().to_string_lossy().starts_with(prefix))
                            {
                                continue;
                            }
                            if !alive.load(Ordering::Acquire)
                                || catalog_intent.load(Ordering::Acquire) != serial
                            {
                                return;
                            }
                            if entry.path().is_dir() {
                                if let Ok(project) = read_project_mode(&entry.path(), false) {
                                    projects.push(project)
                                }
                            }
                        }
                    }
                    projects
                        .sort_by(|a, b| b.saved.cmp(&a.saved).then_with(|| a.name.cmp(&b.name)));
                    if alive.load(Ordering::Acquire)
                        && catalog_intent.load(Ordering::Acquire) == serial
                    {
                        let _ = events.send(Event::Catalog(serial, root, projects));
                    }
                })();
            }
            Request::AdoptCarryPreferences(epoch, config) => {
                *dispatcher.carry.lock().unwrap_or_else(|e| e.into_inner()) = config.clone();
                let error = crate::carry_line::retain(&crate::audio_devices::directory(), &config)
                    .err()
                    .map(|e| format!("Could not retain Carry the line preferences: {e:#}"));
                let _ = events.send(Event::CarryPrefsSaved(epoch, 0, error));
            }
            Request::Inventory => {
                #[cfg(test)]
                hooks.enter("inventory", &alive);
                let token = provider_selected.load(Ordering::Acquire);
                let selected = crate::audio_devices::Provider::from_code(token);
                let result = crate::audio_devices::inventory_with_provider(&alive, selected)
                    .map_err(|e| format!("{e:#}"));
                let _gate = provider_gate.lock().unwrap_or_else(|e| e.into_inner());
                if provider_selected.load(Ordering::Acquire) == token {
                    let _ = events.send(Event::Inventory(result));
                }
            }
            Request::InspectDelete(root, dir, serial) => {
                #[cfg(test)]
                hooks.enter("inspect", &alive);
                let result = crate::project_delete::inspect_cancel(&root, &dir, &|| {
                    !alive.load(Ordering::Acquire)
                })
                .map_err(|e| format!("{e:#}"));
                if alive.load(Ordering::Acquire) {
                    let _ = events.send(Event::DeleteInspected(serial, result));
                }
            }
            Request::RecoverOutput(epoch, serial, mut request, uid) => {
                if !adopt_current(epoch, None, &latest, &alive) {
                    continue;
                }
                if request.replace {
                    match recovery::captured_project(&request) {
                        Ok(project) => {
                            request.project = project;
                            if adopt_current(epoch, None, &latest, &alive) {
                                let manifest = Manifest::prepare(&request.project, &cleanup);
                                match manifest {
                                    Ok(manifest) => {
                                        let _ = transport.send(Request::AdoptRecovery(
                                            epoch,
                                            serial,
                                            request,
                                            uid,
                                            pending.take(),
                                            true,
                                            manifest,
                                        ));
                                    }
                                    Err(e) => {
                                        let _ = events.send(Event::OutputRecovered(
                                            epoch,
                                            serial,
                                            uid,
                                            Err(format!("{e:#}")),
                                        ));
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            let _ = events.send(Event::OutputRecovered(
                                epoch,
                                serial,
                                uid,
                                Err(format!("{e:#}")),
                            ));
                        }
                    }
                } else {
                    let _ = transport.send(Request::AdoptRecovery(
                        epoch,
                        serial,
                        request,
                        uid,
                        pending.take(),
                        false,
                        None,
                    ));
                }
            }
            Request::Open(epoch, path, fallback, confirmed, overlay) => {
                if epoch != latest.load(Ordering::Acquire) {
                    continue;
                }
                let _ = dispatcher.send(Job::Stop(epoch));
                let result = (|| -> Result<Open> {
                    let mut project =
                        read_open_project_overlay(&path, confirmed.as_ref(), overlay.as_ref())?;
                    if !project.raw["settings"]["training"].is_object() {
                        project.carry.config = dispatcher
                            .carry
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .clone();
                    }
                    if let Some(overlay) = &overlay {
                        project.carry = overlay.mix.carry.clone();
                    }
                    if project.empty_tracks {
                        project.carry.enabled = false;
                    }
                    if !project.raw["settings"]["metronome"].is_object() {
                        project.metronome = fallback.unwrap_or_else(|| {
                            dispatcher
                                .metronome
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .clone()
                        });
                    }
                    let met_commands =
                        crate::beat::commands(&project.metronome, project.beat.as_ref())?;
                    // Mask shaping and lyric-store reads depend only on the
                    // prepared document/text system, never on the new helper.
                    match crate::lyrics_store::identity(&project.dir) {
                        Ok(identity) => project.lyrics_fingerprint = identity,
                        Err(error) => project.lyrics_error = Some(error.to_string()),
                    }
                    match crate::lyrics_store::read(&project.dir) {
                        Ok(snapshot) if snapshot.document.is_some() => {
                            project.lyrics_raw = snapshot.raw;
                            project.lyrics_fingerprint = snapshot.fingerprint;
                            let mut lyrics = snapshot.document.unwrap();
                            match crate::project_lyrics::prepare_masks(&mut lyrics, &text, || {
                                !alive.load(Ordering::Acquire)
                                    || latest.load(Ordering::Acquire) != epoch
                            }) {
                                Ok(()) => project.lyrics = Some(Arc::new(lyrics)),
                                Err(error) => project.lyrics_error = Some(error.to_string()),
                            }
                        }
                        Ok(_) => {}
                        Err(error) => project.lyrics_error = Some(error.to_string()),
                    }

                    #[cfg(feature = "ui-tests")]
                    if overlay
                        .as_ref()
                        .is_some_and(|overlay| overlay.preserve_generated)
                    {
                        crate::project_import::test_gate("SINGZ_GPUI_SPLIT_LOAD_GATE", &|| {
                            !alive.load(Ordering::Acquire)
                                || latest.load(Ordering::Acquire) != epoch
                        })?;
                    }
                    anyhow::ensure!(
                        alive.load(Ordering::Acquire) && latest.load(Ordering::Acquire) == epoch,
                        "Project load superseded"
                    );
                    let manifest = Manifest::prepare(&project, &cleanup)?;
                    Ok(Open {
                        admission: admission.take(),
                        epoch,
                        path,
                        confirmed,
                        project,
                        met_commands,
                        manifest,
                        pending: pending.take(),
                    })
                })();
                match result {
                    Ok(prepared) => {
                        #[cfg(test)]
                        hooks.enter("open-adopt", &alive);
                        let _ = transport.send(Request::AdoptOpen(prepared));
                    }
                    Err(e) => {
                        if alive.load(Ordering::Acquire) && latest.load(Ordering::Acquire) == epoch
                        {
                            let _ = transport
                                .send(Request::OpenPreparationFailed(epoch, format!("{e:#}")));
                        }
                    }
                }
            }
            _ => unreachable!("request routed to the wrong preparation lane"),
        }
    }
}
fn run_lanes(requests: Receiver<LaneWork>, dispatcher: Sender, context: Context) {
    let Context {
        transport,
        events,
        latest,
        alive,
        ..
    } = context;
    let _exit =
        ActorExit::new(events.clone(), latest.clone(), alive.clone()).with_wake(transport.clone());
    #[cfg(test)]
    let hooks = dispatcher.hooks.clone();
    while let Ok(work) = requests.recv() {
        if !alive.load(Ordering::Acquire) {
            match work {
                LaneWork::Prepare(_, tasks) => {
                    for task in tasks {
                        let _ = task.join();
                    }
                }
                LaneWork::Shutdown => break,
            }
            continue;
        }
        match work {
            LaneWork::Prepare(mut prepared, tasks) => {
                #[cfg(test)]
                hooks.enter("lanes", &alive);
                for task in tasks {
                    let _ = task.join();
                }
                let _ = events.send(Event::AnalysisStopped(prepared.epoch));
                let Lanes {
                    epoch,
                    serial,
                    ref mut candidate,
                    ref additions,
                    ref intent,
                    ref previous,
                    ref stamps,
                    ref refused,
                } = prepared;
                if latest.load(Ordering::Acquire) != epoch
                    || intent.load(Ordering::Acquire) != serial
                {
                    let _ = transport.send(Request::LanePreparationFailed(
                        epoch,
                        serial,
                        "Track edit superseded".into(),
                        refused.clone(),
                    ));
                    continue;
                }
                let cancel = || {
                    !alive.load(Ordering::Acquire)
                        || latest.load(Ordering::Acquire) != epoch
                        || intent.load(Ordering::Acquire) != serial
                };
                let result = prevalidate_new_tracks(candidate, previous, additions, &cancel)
                    .and_then(|_| prepare_lane_candidate(candidate, previous, stamps, &cancel));
                if let Err(error) = result {
                    let _ = transport.send(Request::LanePreparationFailed(
                        epoch,
                        serial,
                        format!("{error:#}"),
                        refused.clone(),
                    ));
                    continue;
                }
                let _ = transport.send(Request::AdoptLanes(prepared));
                continue;
            }
            LaneWork::Shutdown => break,
        }
    }
}
