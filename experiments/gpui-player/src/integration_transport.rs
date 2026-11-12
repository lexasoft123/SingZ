//! The helper's single owner. Helper messages and continuations share one FIFO.
use super::*;
#[derive(Clone, Copy, PartialEq, Eq)]
enum PendingAdoption {
    Open(u64),
    Lanes(u64, u64),
    Recovery(u64, u64),
}
impl PendingAdoption {
    fn epoch(self) -> u64 {
        match self {
            Self::Open(e) | Self::Lanes(e, _) | Self::Recovery(e, _) => e,
        }
    }
    fn holds(self, request: &Request) -> bool {
        if matches!(request, Request::Output(..)) {
            return true;
        }
        if request.helper_epoch() != Some(self.epoch()) {
            return false;
        }
        match self {
            Self::Open(_) | Self::Recovery(..) => true,
            Self::Lanes(..) => match request {
                // These operate on the adopted graph while joins prepare its
                // successor. Future-graph mix edits wait for that transaction.
                Request::Playback(..)
                | Request::Rate(..)
                | Request::Metronome(..)
                | Request::RestoreSeek(..) => false,
                Request::Control(_, command) => {
                    !matches!(command.as_str(), "play" | "pause" | "stop" | "status")
                        && !command.starts_with("seek ")
                }
                _ => true,
            },
        }
    }
}

pub(super) fn run(
    requests: Receiver<Request>,
    jobs: jobs::Sender,
    events: mpsc::Sender<Event>,
    latest: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
    telemetry: Arc<Mutex<Option<(u64, Status)>>>,
    training_intent: Arc<AtomicU64>,
    copy_handoff: Arc<AtomicU64>,
    save_reanchors: save_worker::Reanchors,
    playback_intent: Arc<AtomicU64>,
    provider_selected: Arc<AtomicU64>,
    provider_pending: Arc<AtomicU64>,
    provider_retired: Arc<AtomicU64>,
    mut output_uid: String,
    mut provider_state: provider_control::ProviderState,
    owner_busy: Arc<AtomicBool>,
) {
    let _exit = ActorExit::new(events.clone(), latest.clone(), alive.clone());
    let mut connection: Option<Connection> = None;
    let mut active_training: Option<(u64, u64)> = None;
    let mut monitor_lease = false;
    let mut poll = Instant::now();
    let mut recovery_inflight = None;
    let mut provider_inflight = false;
    let mut pending_adoption: Option<PendingAdoption> = None;
    let mut pending_lane_met: Option<PendingLaneMet> = None;
    let mut pending_recovery: Option<(
        u64,
        u64,
        Connection,
        Option<provider_control::PendingWork>,
    )> = None;
    let mut deferred = std::collections::VecDeque::<Request>::new();
    let mut ready = std::collections::VecDeque::<Request>::new();
    while alive.load(Ordering::Acquire) {
        let current_epoch = latest.load(Ordering::Acquire);
        if pending_adoption.is_some_and(|pending| pending.epoch() != current_epoch) {
            reject_deferred(
                &mut deferred,
                retire_adoption(&mut pending_adoption, &mut pending_lane_met),
                &events,
            );
            pending_lane_met = None;
        }
        if pending_recovery
            .as_ref()
            .is_some_and(|(epoch, ..)| *epoch != current_epoch)
        {
            if let Some((_,_,child,_))=pending_recovery.take() {child.retire();}
            recovery_inflight = None;
        }
        owner_busy.store(
            connection.is_some()
                || pending_recovery.is_some()
                || monitor_lease
                || active_training.is_some(),
            Ordering::Release,
        );
        provider_state.publish(
            &events,
            latest.load(Ordering::Acquire),
            connection.is_some() || pending_recovery.is_some(),
            monitor_lease,
            active_training.is_some(),
            training_intent.load(Ordering::Acquire),
        );
        // Cancellation intent bypasses the bounded command queue. Navigation
        // must still retire a live cue if that queue is full.
        if let Some((epoch, generation)) = active_training {
            if training_intent.load(Ordering::Acquire) != generation
                || latest.load(Ordering::Acquire) != epoch
            {
                if let Some(child) = connection.as_mut().filter(|c| c.epoch == epoch) {
                    match child.command(&format!("cue-cancel {generation}")) {
                        Ok(status)
                            if status.training_only
                                && (training_intent.load(Ordering::Acquire) == 0
                                    || latest.load(Ordering::Acquire) != epoch) =>
                        {
                            retire_connection(&mut connection)
                        }
                        Err(error) => retire_failed_connection(&mut connection,&error),
                        _ => {}
                    }
                }
                active_training = None;
            }
        }
        let request = if let Some(request) = ready.pop_front() {
            Ok(request)
        } else if connection.is_none() && active_training.is_none() {
            #[cfg(test)]
            jobs.hooks.idle_recv.store(true, Ordering::Release);
            let received = requests
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected);
            #[cfg(test)]
            jobs.hooks.idle_recv.store(false, Ordering::Release);
            received
        } else {
            requests.recv_timeout(Duration::from_millis(33).saturating_sub(poll.elapsed()))
        };
        let (request, mut admission) = match request {
            Ok(Request::Admitted(request, permit)) => (Ok(*request), Some(permit)),
            request => (request, None),
        };
        if alive.load(Ordering::Acquire)
            && request
                .as_ref()
                .is_ok_and(|request| pending_adoption.is_some_and(|pending| pending.holds(request)))
        {
            deferred.push_back(request.unwrap().admitted(admission.take()));
            continue;
        }
        #[cfg(test)]
        jobs.hooks.wakes.fetch_add(1, Ordering::Relaxed);
        // Save completion is memory-only here. Do this after waiting, so a
        // command sent in response to Saved cannot overtake its cache update.
        let reanchors =
            std::mem::take(&mut *save_reanchors.lock().unwrap_or_else(|e| e.into_inner()));
        for saved in reanchors {
            if let Some(child) = connection.as_mut().filter(|child| {
                child.epoch == saved.epoch && child.project_dir.as_ref() == Some(&saved.dir)
            }) {
                for (index, lane) in child.loaded_lanes.iter_mut().enumerate() {
                    if let Some(source) = saved.custom.iter().find(|source| source.id == lane.id) {
                        lane.file = source.file.clone();
                        if let Some((_, stamp)) = saved.stamps.iter().find(|(id, _)| id == &lane.id)
                        {
                            if let Some(target) = child.loaded_stamps.get_mut(index) {
                                *target = *stamp;
                            }
                        }
                    }
                }
            }
        }
        if request.as_ref().is_ok_and(|r| {
            provider_control::ownership_request(r)
                || matches!(r, Request::AdoptOpen(..) | Request::AdoptRecovery(..))
        }) {
            owner_busy.store(true, Ordering::Release);
        }
        let mut _provider_work = request
            .as_ref()
            .ok()
            .filter(|r| provider_control::ownership_request(r))
            .map(|_| {
                provider_control::PendingWork(provider_pending.clone(), jobs.transport.clone())
            });
        match request {
            Ok(request) if !alive.load(Ordering::Acquire) => {
                if request.is_preference() {
                    let _ = jobs.send(jobs::Job::Forward(request, None));
                }
                break;
            }
            Ok(Request::Wake) => {}
            Ok(Request::OpenPreparationFailed(epoch, error)) => {
                if pending_adoption == Some(PendingAdoption::Open(epoch)) {
                    reject_deferred_with_error(
                        &mut deferred,
                        retire_adoption(&mut pending_adoption, &mut pending_lane_met),
                        &events,
                        &error,
                        true,
                    );
                    let _ = events.send(Event::Error(epoch, error, Severity::Fatal));
                }
            }
            Ok(Request::LanePreparationFailed(epoch, serial, error, refused)) => {
                if pending_adoption == Some(PendingAdoption::Lanes(epoch, serial)) {
                    let _ = events.send(Event::LanesReplaced(epoch, serial, Err(error.clone())));
                    reject_deferred_with_error(
                        &mut deferred,
                        retire_adoption(&mut pending_adoption, &mut pending_lane_met),
                        &events,
                        &error,
                        true,
                    );
                    let _ = jobs.send(jobs::Job::Restart(refused, epoch));
                }
            }
            Ok(Request::AdoptMetronomePreferences(epoch, met)) => {
                jobs.record_metronome(epoch, 0, met);
            }
            Ok(Request::Open(epoch, path, fallback, confirmed, overlay)) => {
                if !adopt_current(epoch, None, &latest, &alive) {
                    continue;
                }
                if let Some((_,_,child,_))=pending_recovery.take() {child.retire();}
                recovery_inflight = None;
                if pending_adoption.is_none_or(|pending| pending.epoch() != epoch) {
                    reject_deferred(
                        &mut deferred,
                        retire_adoption(&mut pending_adoption, &mut pending_lane_met),
                        &events,
                    );
                }
                pending_lane_met = None;
                pending_adoption = Some(PendingAdoption::Open(epoch));
                let fallback = fallback.or_else(|| {
                    Some(
                        jobs.metronome
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .clone(),
                    )
                });
                let request = Request::Open(epoch, path, fallback, confirmed, overlay)
                    .admitted(admission.take());
                let _ = jobs.send(jobs::Job::Forward(request, _provider_work.take()));
            }
            #[cfg(test)]
            Ok(Request::ActorBarrier(ack)) => {
                let _ = ack.send(());
            }
            #[cfg(test)]
            Ok(Request::SetTestMonitor(leased, ack)) => {
                monitor_lease = leased;
                let _ = ack.send(());
            }
            #[cfg(test)]
            Ok(Request::InstallTestConnection(child, ack)) => {
                connection = Some(child);
                let _ = ack.send(());
            }
            #[cfg(test)]
            Ok(Request::ReceiptFence(epoch, serial, reply)) => {
                if let Some((e, status)) = &*telemetry.lock().unwrap() {
                    if *e == epoch {
                        let _ = reply.send((epoch, serial, status.clone()));
                    }
                }
            }
            Ok(Request::Training(epoch, phrase)) => {
                let generation = phrase.generation;
                if epoch != latest.load(Ordering::Acquire)
                    || training_intent.load(Ordering::Acquire) != generation
                {
                    continue;
                }
                let mut refused=false;
                let result = (|| -> Result<Option<Status>> {
                    anyhow::ensure!(
                        !monitor_lease,
                        "Stop microphone monitoring before playing training audio"
                    );
                    if connection.is_none() {
                        let (child, _) = Connection::open(
                            None,
                            epoch,
                            latest.clone(),
                            alive.clone(),
                            copy_handoff.clone(),
                            &output_uid,
                            crate::audio_devices::Provider::from_code(
                                provider_selected.load(Ordering::Acquire),
                            ),
                            provider_retired.clone(),
                            None,
                        )?;
                        connection = Some(child);
                    }
                    let child = connection
                        .as_mut()
                        .filter(|c| c.epoch == epoch)
                        .context("Training audio project changed")?;
                    let status = match child.classified_command(&phrase.command()?) {
                        CommandOutcome::Applied(status)=>status,
                        CommandOutcome::Refused {error,retained}=>{
                            refused=true;
                            *telemetry.lock().unwrap_or_else(|e|e.into_inner())=Some((epoch,retained));
                            bail!("{error}");
                        },
                        CommandOutcome::Fault(error)=>return Err(error),
                    };
                    if training_intent.load(Ordering::Acquire) != generation
                        || epoch != latest.load(Ordering::Acquire)
                    {
                        let stopped = child.command(&format!("cue-cancel {generation}"))?;
                        if stopped.training_only
                            && (training_intent.load(Ordering::Acquire) == 0
                                || latest.load(Ordering::Acquire) != epoch)
                        {
                            retire_connection(&mut connection);
                        }
                        return Ok(None);
                    }
                    Ok(Some(status))
                })();
                if let Err(error) = &result && !refused {
                    retire_failed_connection(&mut connection,error);
                    *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    let _ = events.send(Event::TransportFailed(epoch, format!("{error:#}")));
                }
                if matches!(&result, Ok(Some(_))) {
                    active_training = Some((epoch, generation));
                }
                let _ = events.send(Event::Training(
                    epoch,
                    generation,
                    result.map_err(|e| format!("{e:#}")),
                ));
            }
            Ok(Request::CancelTraining(epoch, generation)) => {
                if active_training == Some((epoch, generation)) {
                    active_training = None;
                }
                let result = (|| -> Result<Option<Status>> {
                    if let Some(child) = connection.as_mut().filter(|c| c.epoch == epoch) {
                        let status = child.command(&format!("cue-cancel {generation}"))?;
                        if status.training_only
                            && training_intent.load(Ordering::Acquire) == 0
                            && status.cue.generation == generation
                            && !status.cue.active
                            && status.cue.start_host_ns == 0
                        {
                            retire_connection(&mut connection);
                            return Ok(None);
                        }
                        return Ok(Some(status));
                    }
                    Ok(None)
                })();
                if let Err(error) = &result {
                    retire_failed_connection(&mut connection,error);
                    *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    let _ = events.send(Event::TransportFailed(epoch, format!("{error:#}")));
                }
                *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                let _ = events.send(Event::Training(
                    epoch,
                    generation,
                    result.map_err(|e| format!("{e:#}")),
                ));
            }
            Ok(Request::Park(epoch, serial, parked)) => {
                let result = (|| -> Result<Option<Status>> {
                    anyhow::ensure!(
                        epoch == latest.load(Ordering::Acquire),
                        "Playback project changed during monitoring handoff"
                    );
                    if let Some(child) = connection.as_mut().filter(|c| c.epoch == epoch) {
                        let status = child.command(if parked { "park" } else { "unpark" })?;
                        anyhow::ensure!(
                            status.parked == parked && (!parked || status.physical_output_released),
                            "Playback output release was not confirmed"
                        );
                        Ok(Some(status))
                    } else {
                        Ok(None)
                    }
                })();
                if result.is_ok() {
                    monitor_lease = parked;
                }
                if result.is_err() {
                    monitor_lease = false;
                    // Never leave an uncertain live output behind a failed handoff.
                    // Connection Drop kills/waits before the failure is published.
                    drop(connection.take());
                    let _ = events.send(Event::TransportFailed(
                        epoch,
                        "Native playback handoff failed; retry the output route in Settings".into(),
                    ));
                }
                *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                let _ = events.send(Event::Parked(
                    epoch,
                    serial,
                    parked,
                    result.map_err(|e| format!("{e:#}")),
                ));
            }
            #[cfg(feature = "ui-tests")]
            Ok(Request::FailOwnedAudio(epoch)) => {
                if epoch == latest.load(Ordering::Acquire)
                    && std::env::var("SINGZ_MUTE").as_deref() == Ok("1")
                {
                    if let Some(child) = connection.as_mut().filter(|c| c.epoch == epoch) {
                        // Fault only this backend's child, and reap/publish before
                        // a queued command can misclassify its resulting broken pipe.
                        let _ = child.helper.kill();
                        drop(connection.take());
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        training_intent.store(0, Ordering::Release);
                        active_training = None;
                        let _ = events.send(Event::TransportFailed(epoch, "Native audio process exited".into()));
                    }
                }
            }
            #[cfg(feature = "ui-tests")]
            Ok(Request::ProbeOwnedAudio(epoch, reply)) => {
                let result = (|| -> Result<OwnedAudioProbe> {
                    anyhow::ensure!(
                        alive.load(Ordering::Acquire) && latest.load(Ordering::Acquire) == epoch,
                        "Native probe superseded"
                    );
                    let child = connection
                        .as_mut()
                        .filter(|c| c.epoch == epoch)
                        .context("No matching owned helper for native probe")?;
                    let helper_pid = child.helper.id()?;
                    let status = child.command("status")?;
                    anyhow::ensure!(
                        alive.load(Ordering::Acquire) && latest.load(Ordering::Acquire) == epoch,
                        "Native probe superseded"
                    );
                    Ok(OwnedAudioProbe {
                        epoch,
                        helper_pid,
                        monitor_leased: monitor_lease,
                        active_training,
                        status,
                    })
                })()
                .map_err(|error| format!("{error:#}"));
                let _ = reply.send(result);
            }
            Ok(Request::Rate(epoch, serial, rate, transpose)) => {
                if epoch != latest.load(Ordering::Acquire) {
                    let _ = events.send(Event::Rate(
                        epoch,
                        serial,
                        Err("Tempo request superseded".into()),
                    ));
                    continue;
                }
                let result = if monitor_lease || active_training.is_some() {
                    Err(RateFailure::Refused(
                        "Release microphone monitoring/training before changing tempo".into(),
                    ))
                } else {
                    match connection.as_mut().filter(|c| c.epoch == epoch) {
                        Some(child) => child.rate(rate, transpose),
                        None => Err(RateFailure::Refused("Native project is unavailable".into())),
                    }
                };
                #[cfg(feature = "ui-tests")]
                if result.is_ok() && std::env::var_os("SINGZ_GPUI_TRANSPORT_TIMING_TEST").is_some()
                {
                    if let Some(gate) = std::env::var_os("SINGZ_GPUI_RATE_RECEIPT_GATE")
                        .map(PathBuf::from)
                        .filter(|p| p.exists())
                    {
                        let _ = fs::write(gate.with_extension("ready"), b"native-rate-applied");
                        let deadline = Instant::now() + Duration::from_secs(5);
                        while gate.exists()
                            && alive.load(Ordering::Acquire)
                            && latest.load(Ordering::Acquire) == epoch
                            && Instant::now() < deadline
                        {
                            thread::sleep(Duration::from_millis(5));
                        }
                    }
                }
                match result {
                    Ok(status) => {
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some((epoch, status.clone()));
                        let _ = events.send(Event::Rate(epoch, serial, Ok(status)));
                    }
                    Err(RateFailure::Refused(error)) => {
                        let _ = events.send(Event::Rate(epoch, serial, Err(error)));
                    }
                    Err(RateFailure::Transport(error)) => {
                        drop(connection.take());
                        let _ = jobs.send(jobs::Job::Stop(epoch));
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        let _ = events.send(Event::RateTransportFailed(epoch, serial, error));
                    }
                }
            }
            Ok(Request::Carry(epoch, serial, plan, intent)) => {
                if epoch != latest.load(Ordering::Acquire)
                    || intent.load(Ordering::Acquire) != serial
                {
                    let _ = events.send(Event::Carry(
                        epoch,
                        serial,
                        Err("Carry the line request superseded".into()),
                    ));
                    continue;
                }
                let result = if monitor_lease || active_training.is_some() {
                    Err(LaneReplaceFailure::Refused(
                        "Release microphone monitoring/training before changing Carry the line"
                            .into(),
                    ))
                } else {
                    match connection.as_mut().filter(|c| c.epoch == epoch) {
                        Some(child) => child.carry(&plan),
                        None => Err(LaneReplaceFailure::Refused(
                            "Native project is unavailable".into(),
                        )),
                    }
                };
                #[cfg(feature = "ui-tests")]
                if result.is_ok() && std::env::var_os("SINGZ_GPUI_CARRY_TEST").is_some() {
                    if let Some(gate) = std::env::var_os("SINGZ_GPUI_CARRY_GATE")
                        .map(PathBuf::from)
                        .filter(|path| path.exists())
                    {
                        // The real native transaction has finished. Hold only
                        // delivery, retaining its actual outcome on timeout or
                        // navigation rather than fabricating a failed apply.
                        let _ = fs::write(gate.with_extension("ready"), b"native-carry-applied");
                        let deadline = Instant::now() + Duration::from_secs(5);
                        while gate.exists()
                            && alive.load(Ordering::Acquire)
                            && latest.load(Ordering::Acquire) == epoch
                            && intent.load(Ordering::Acquire) == serial
                            && Instant::now() < deadline
                        {
                            thread::sleep(Duration::from_millis(5));
                        }
                    }
                }
                match result {
                    Ok(status) => {
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some((epoch, status.clone()));
                        let _ =
                            events.send(Event::Carry(epoch, serial, Ok((plan.desired, status))));
                    }
                    Err(LaneReplaceFailure::Refused(error)) => {
                        let _ = events.send(Event::Carry(epoch, serial, Err(error)));
                    }
                    Err(LaneReplaceFailure::Disconnected(error)) => {
                        drop(connection.take());
                        let _ = jobs.send(jobs::Job::Stop(epoch));
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        let _ = events.send(Event::CarryTransportFailed(epoch, serial, error));
                    }
                    Err(LaneReplaceFailure::Committed(error)) => {
                        drop(connection.take());
                        let _ = jobs.send(jobs::Job::Stop(epoch));
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        let _ = events.send(Event::CarryCommittedFailed(
                            epoch,
                            serial,
                            plan.desired,
                            error,
                        ));
                    }
                }
            }
            Ok(Request::Metronome(epoch, serial, met, beat)) => {
                if epoch != latest.load(Ordering::Acquire) {
                    continue;
                }
                let commands = match crate::beat::commands(&met, beat.as_ref()) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = events.send(Event::Metronome(
                            epoch,
                            serial,
                            met.clone(),
                            beat,
                            Err(e.to_string()),
                        ));
                        continue;
                    }
                };
                let mut refused=false;
                let result = (|| -> Result<Status> {
                    anyhow::ensure!(
                        !monitor_lease,
                        "Stop microphone monitoring before changing metronome audio"
                    );
                    let child = connection
                        .as_mut()
                        .filter(|c| c.epoch == epoch)
                        .context("Metronome project changed")?;
                    match child.classified_metronome(&commands) {
                        CommandOutcome::Applied(status)=>Ok(status),
                        CommandOutcome::Refused {error,retained}=>{
                            refused=true;
                            *telemetry.lock().unwrap_or_else(|e|e.into_inner())=Some((epoch,retained));
                            bail!("{error}");
                        },
                        CommandOutcome::Fault(error)=>Err(error),
                    }
                })();
                if result.is_err() && !monitor_lease && !refused {
                    retire_failed_connection(&mut connection,result.as_ref().unwrap_err());
                    *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    let _ = events.send(Event::TransportFailed(
                        epoch,
                        "Native metronome update failed; retry the output route in Settings".into(),
                    ));
                }
                if let Ok(status) = &result {
                    *telemetry.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some((epoch, status.clone()));
                }
                if result.is_ok() {
                    if let Some(PendingAdoption::Lanes(e, lane_serial)) =
                        pending_adoption.filter(|pending| pending.epoch() == epoch)
                    {
                        pending_lane_met = Some((e, lane_serial, met.clone(), beat.clone()));
                    }
                    jobs.record_metronome(epoch, serial, met.clone());
                }
                let _ = events.send(Event::Metronome(
                    epoch,
                    serial,
                    met.clone(),
                    beat,
                    result.map_err(|e| format!("{e:#}")),
                ));
            }
            Ok(Request::Playback(epoch, serial, command, armed)) => {
                while !armed.load(Ordering::Acquire) && alive.load(Ordering::Acquire) {
                    thread::yield_now();
                }
                let current = || {
                    alive.load(Ordering::Acquire)
                        && latest.load(Ordering::Acquire) == epoch
                        && playback_intent.load(Ordering::Acquire) == serial
                };
                if !current() {
                    continue;
                }
                let result = (|| -> Result<PlaybackReceipt> {
                    validate_playback_command(&command)?;
                    let child = connection
                        .as_mut()
                        .filter(|child| child.epoch == epoch)
                        .context("Native playback project is unavailable")?;
                    match child.classified_command(&command) {
                        CommandOutcome::Applied(_)=>{},
                        CommandOutcome::Refused {error,retained}=>return Ok(PlaybackReceipt::Refused {error,retained}),
                        CommandOutcome::Fault(error)=>return Err(error),
                    }
                    let reply=child.ownership.clone();
                    let receipt =
                        settle_playback_receipt(reply, Duration::from_secs(2), current, || {
                            child.raw_command_for("status", Duration::from_secs(10))
                        })?;
                    if let PlaybackReceipt::Applied(status) = &receipt {
                        admit_lane_revision(&mut child.lane_revision, status)?;
                        admit_carry_revision(&mut child.carry_revision, status)?;
                    }
                    Ok(receipt)
                })();
                match result {
                    Ok(PlaybackReceipt::Applied(status)) if current() => {
                        publish_playback_receipt(&events, &telemetry, epoch, serial, status)
                    }
                    Ok(PlaybackReceipt::Refused {error,retained})=>{
                        if current() {
                            publish_playback_receipt(&events,&telemetry,epoch,serial,retained);
                            let _=events.send(Event::Error(epoch,error,Severity::Refused(RefusedCommand::Other)));
                        }
                    }
                    Ok(_) => {} // Fully drained clean cancellation; keep the helper for Pause.
                    Err(error) => {
                        // A failed read may leave a late reply in the stream.
                        // Supersession cannot make a faulted connection safe to reuse.
                        retire_failed_connection(&mut connection,&error);
                        training_intent.store(0, Ordering::Release);
                        active_training = None;
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        if alive.load(Ordering::Acquire) && epoch == latest.load(Ordering::Acquire)
                        {
                            let _ = events.send(Event::TransportFailed(epoch, error.to_string()));
                        }
                    }
                }
            }
            Ok(Request::RestoreSeek(epoch, position)) => {
                if epoch != latest.load(Ordering::Acquire) {
                    continue;
                }
                let result = connection
                    .as_mut()
                    .filter(|c| c.epoch == epoch)
                    .context("Native restoration project is unavailable")
                    .and_then(|child| recovery::settled_seek(child, position));
                match result {
                    Ok(status) => {
                        #[cfg(feature = "ui-tests")]
                        let _ = events.send(Event::SourceSeekRestored(epoch, status.clone()));
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some((epoch, status));
                    }
                    Err(error) => {
                        drop(connection.take());
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        training_intent.store(0, Ordering::Release);
                        active_training = None;
                        let _ = events.send(Event::TransportFailed(
                            epoch,
                            format!("Native source restoration failed: {error:#}"),
                        ));
                    }
                }
            }
            Ok(Request::Region(epoch, serial, target, duration)) => {
                if epoch != latest.load(Ordering::Acquire) {
                    continue;
                }
                let result = if monitor_lease || active_training.is_some() {
                    Err(RateFailure::Refused("Release microphone monitoring/training before changing the playback region".into()))
                } else {
                    match connection.as_mut().filter(|c| c.epoch == epoch) {
                        Some(child) => child.region(target, duration),
                        None => Err(RateFailure::Refused("Native project is unavailable".into())),
                    }
                };
                match result {
                    Ok(status) => {
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some((epoch, status.clone()));
                        let _ = events.send(Event::Region(epoch, serial, Ok(status)));
                    }
                    Err(RateFailure::Refused(error)) => {
                        let _ = events.send(Event::Region(epoch, serial, Err(error)));
                    }
                    Err(RateFailure::Transport(error)) => {
                        drop(connection.take());
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        let _ = events.send(Event::TransportFailed(epoch, error));
                    }
                }
            }
            Ok(Request::Control(epoch, command)) => {
                if epoch != latest.load(Ordering::Acquire) {
                    continue;
                }
                if let Some(child) = connection.as_mut().filter(|c| c.epoch == epoch) {
                    match child.classified_command(&command) {
                        CommandOutcome::Applied(s) => {
                            *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = Some((epoch, s));
                        }
                        CommandOutcome::Refused {error,retained}=>{
                            *telemetry.lock().unwrap_or_else(|e|e.into_inner())=Some((epoch,retained));
                            let mut words=command.split_whitespace();
                            let refused=match (words.next(),words.next(),words.next()) {
                                (Some("seek"),Some(target),None)=>target.parse::<f64>().ok()
                                    .filter(|target|target.is_finite())
                                    .map(|target|RefusedCommand::Seek {target})
                                    .unwrap_or(RefusedCommand::Other),
                                _=>RefusedCommand::Other,
                            };
                            let _=events.send(Event::Error(epoch,error,Severity::Refused(refused)));
                        }
                        CommandOutcome::Fault(e) => {
                            retire_failed_connection(&mut connection,&e);
                            *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                            training_intent.store(0, Ordering::Release);
                            active_training = None;
                            let _ = events.send(Event::TransportFailed(epoch, e.to_string()));
                        }
                    }
                }
            }
            Ok(Request::AdoptOpen(prepared)) => {
                let jobs::Open {
                    admission: _open_admission,
                    epoch,
                    path,
                    confirmed,
                    mut project,
                    met_commands,
                    manifest,
                    pending: _pending,
                } = prepared;
                if monitor_lease {
                    let _ = events.send(Event::Error(
                        epoch,
                        "Stop microphone monitoring before opening a project".into(),
                        Severity::Fatal,
                    ));
                    if pending_adoption == Some(PendingAdoption::Open(epoch)) {
                        reject_deferred_with_error(
                            &mut deferred,
                            retire_adoption(&mut pending_adoption, &mut pending_lane_met),
                            &events,
                            "Stop microphone monitoring before opening a project",
                            true,
                        );
                    }
                    continue;
                }

                if !adopt_current(epoch, None, &latest, &alive) {
                    continue;
                }
                let result = (|| -> Result<(Connection, Project, Status, Vec<Vec<f32>>)> {
                    // Validate before retiring the previous output. Reaping proves it no longer owns a device.
                    if let Some(target) = confirmed.as_ref() {
                        verify_delete_recovery_path(&path, target)?;
                    }
                    retire_connection(&mut connection);
                    let prepared = Connection::open(
                        Some(&project),
                        epoch,
                        latest.clone(),
                        alive.clone(),
                        copy_handoff.clone(),
                        &output_uid,
                        crate::audio_devices::Provider::from_code(
                            provider_selected.load(Ordering::Acquire),
                        ),
                        provider_retired.clone(),
                        manifest,
                    )?;
                    let (mut child, value) =
                        checked_delete_recovery(&path, confirmed.as_ref(), prepared)?;
                    child.command(&format!("master {}", project.master))?;
                    // Prepare even gridless intent: previews and the global
                    // count-in preference must survive songs without settings.
                    if project.has_audio() {
                        child.metronome(&met_commands)?;
                    }
                    for (lane, (i, _)) in project.lanes.iter().enumerate() {
                        child.command(&format!(
                            "lane {lane} {} {} {}",
                            project.gain[*i],
                            u8::from(project.muted[*i]),
                            u8::from(project.solo[*i])
                        ))?;
                    }
                    if epoch != latest.load(Ordering::Acquire) {
                        bail!("Project load superseded")
                    }
                    let status = Status::parse_prepare(&value)?;
                    let expected_lane_ids: Vec<String> = project.lanes.iter()
                        .filter_map(|(slot, _)| project.lane_id(*slot).map(str::to_owned))
                        .collect();
                    anyhow::ensure!(
                        crate::integration::lane_ids_match(&expected_lane_ids, &status.lane_ids),
                        "Native prepared lane IDs differ from the requested project"
                    );
                    project.vocal_duration = vocal_lane_duration(&value)?;
                    Arc::make_mut(&mut project.pitch)
                        .bind_duration_for_lane(status.duration, project.vocal_duration);
                    if project.has_audio() && (project.looping || project.selection.is_some()) {
                        let target = crate::region_gesture::Target {
                            selection: project.selection,
                            looping: project.looping,
                        };
                        child.command(&target.command(status.duration))?;
                    }
                    let peaks = peaks_from(&value, true)?;
                    let status = if let Some(carry) =
                        open_carry_plan(&mut project, status.duration as f64)?
                    {
                        child.carry_with_arming(&carry, false).map_err(|failure| {
                            anyhow::anyhow!(
                                "{}",
                                match failure {
                                    LaneReplaceFailure::Refused(e)
                                    | LaneReplaceFailure::Disconnected(e)
                                    | LaneReplaceFailure::Committed(e) => e,
                                }
                            )
                        })?
                    } else {
                        // A genuine empty document has no training-duck graph.
                        // Retain disabled preferences, and confirm its actual
                        // released native state instead of issuing graph IPC.
                        child.command("status")?
                    };
                    checked_delete_recovery(
                        &path,
                        confirmed.as_ref(),
                        (child, project, status, peaks),
                    )
                })();
                match result {
                    Ok((child, mut project, status, peaks)) => {
                        connection = Some(child);
                        if pending_adoption == Some(PendingAdoption::Open(epoch)) {
                            retire_adoption(&mut pending_adoption, &mut pending_lane_met);
                            ready.append(&mut deferred);
                        }
                        if crate::project_analysis::needed(&project) {
                            let snapshot = project.clone();
                            Arc::make_mut(&mut project.pitch).warning =
                                Some("Analyzing song…".into());
                            // Start after Opened is published so the result cannot overtake its project.
                            let _ = events.send(Event::Opened(epoch, project, status, peaks));
                            let _ = jobs.send(jobs::Job::Restart(Some(snapshot), epoch));
                            continue;
                        }
                        let _ = events.send(Event::Opened(epoch, project, status, peaks));
                    }
                    Err(e) => {
                        let error = format!("{e:#}");
                        if pending_adoption == Some(PendingAdoption::Open(epoch)) {
                            reject_deferred_with_error(
                                &mut deferred,
                                retire_adoption(&mut pending_adoption, &mut pending_lane_met),
                                &events,
                                &error,
                                true,
                            );
                        }
                        // A remaining connection is the previous healthy owner:
                        // a failed prepared child was local to the closure and
                        // has already taken the fault Drop path.
                        retire_connection(&mut connection);
                        let _ = events.send(Event::Error(epoch, error, Severity::Fatal));
                    }
                }
            }
            Ok(Request::ReplaceLanes(epoch, serial, candidate, additions, intent)) => {
                if latest.load(Ordering::Acquire) != epoch
                    || intent.load(Ordering::Acquire) != serial
                {
                    let _ = events.send(Event::LanesReplaced(
                        epoch,
                        serial,
                        Err("Track edit superseded".into()),
                    ));
                    continue;
                }
                let refused_analysis = connection
                    .as_ref()
                    .filter(|c| c.epoch == epoch && c.project_dir.as_ref() == Some(&candidate.dir))
                    .and_then(|c| {
                        accepted_analysis_snapshot(&candidate, &c.loaded_lanes, &c.loaded_stamps)
                    });
                let Some(child) = connection
                    .as_ref()
                    .filter(|c| c.epoch == epoch && c.project_dir.as_ref() == Some(&candidate.dir))
                else {
                    let _ = events.send(Event::LanesReplaced(
                        epoch,
                        serial,
                        Err("Native project is unavailable".into()),
                    ));
                    continue;
                };
                if monitor_lease || active_training.is_some() {
                    let _ = events.send(Event::LanesReplaced(
                        epoch,
                        serial,
                        Err("Release microphone monitoring/training before editing tracks".into()),
                    ));
                    continue;
                }
                let live_met = pending_lane_met.take().filter(|(e, s, ..)| {
                    *e == epoch && pending_adoption == Some(PendingAdoption::Lanes(*e, *s))
                });
                if pending_adoption != Some(PendingAdoption::Lanes(epoch, serial)) {
                    reject_deferred(
                        &mut deferred,
                        retire_adoption(&mut pending_adoption, &mut pending_lane_met),
                        &events,
                    );
                }
                pending_adoption = Some(PendingAdoption::Lanes(epoch, serial));
                pending_lane_met = live_met.map(|(_, _, met, beat)| (epoch, serial, met, beat));
                let _ = jobs.send(jobs::Job::Lanes(jobs::Lanes {
                    epoch,
                    serial,
                    candidate,
                    additions,
                    intent,
                    previous: child.loaded_lanes.clone(),
                    stamps: child.loaded_stamps.clone(),
                    refused: refused_analysis,
                }));
            }
            Ok(Request::AdoptLanes(prepared)) => {
                let jobs::Lanes {
                    epoch,
                    serial,
                    mut candidate,
                    intent,
                    previous,
                    stamps,
                    refused: refused_analysis,
                    ..
                } = prepared;
                if !adopt_current(epoch, Some((serial, &intent)), &latest, &alive) {
                    if pending_adoption == Some(PendingAdoption::Lanes(epoch, serial)) {
                        reject_deferred(
                            &mut deferred,
                            retire_adoption(&mut pending_adoption, &mut pending_lane_met),
                            &events,
                        );
                    }
                    continue;
                }
                let Some(child) = connection
                    .as_ref()
                    .filter(|c| c.epoch == epoch && c.project_dir.as_ref() == Some(&candidate.dir))
                else {
                    if pending_adoption == Some(PendingAdoption::Lanes(epoch, serial)) {
                        reject_deferred(
                            &mut deferred,
                            retire_adoption(&mut pending_adoption, &mut pending_lane_met),
                            &events,
                        );
                    }
                    continue;
                };
                if monitor_lease
                    || active_training.is_some()
                    || child.loaded_lanes != previous
                    || child.loaded_stamps != stamps
                {
                    let _ = events.send(Event::LanesReplaced(
                        epoch,
                        serial,
                        Err("Track edit superseded".into()),
                    ));
                    if pending_adoption == Some(PendingAdoption::Lanes(epoch, serial)) {
                        reject_deferred_with_error(
                            &mut deferred,
                            retire_adoption(&mut pending_adoption, &mut pending_lane_met),
                            &events,
                            "Track edit superseded",
                            true,
                        );
                    }
                    continue;
                }
                if let Some((_, _, met, beat)) = pending_lane_met
                    .as_ref()
                    .filter(|(e, s, ..)| (*e, *s) == (epoch, serial))
                {
                    candidate.metronome = met.clone();
                    candidate.beat = beat.clone();
                }
                let child = connection.as_mut().unwrap();
                let was_empty = child.loaded_lanes.is_empty();
                let result =
                    child
                        .replace_lanes(&candidate)
                        .and_then(|(status, peaks, vocal_duration)| {
                            let configured =
                                configure_fresh_graph(was_empty, &candidate, |commands| {
                                    child.metronome(commands)
                                })?;
                            Ok((configured.unwrap_or(status), peaks, vocal_duration))
                        });
                let adopted = result.is_ok();
                let adoption_error = result.as_ref().err().map(|failure| match failure {
                    LaneReplaceFailure::Refused(error)
                    | LaneReplaceFailure::Disconnected(error)
                    | LaneReplaceFailure::Committed(error) => error.clone(),
                });
                match result {
                    Ok((status, peaks, vocal_duration)) => {
                        candidate.tempo = status.rate;
                        candidate.transpose = status.transpose;
                        candidate.vocal_duration = if candidate.empty_tracks {
                            None
                        } else {
                            vocal_duration.or(candidate.vocal_duration)
                        };
                        let child = connection.as_mut().unwrap();
                        child.loaded_lanes = candidate.lane_specs.clone();
                        child.loaded_stamps = candidate.lane_stamps.clone();
                        Arc::make_mut(&mut candidate.pitch)
                            .bind_duration_for_lane(status.duration, candidate.vocal_duration);
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some((epoch, status.clone()));
                        let snapshot =
                            crate::project_analysis::needed(&candidate).then(|| candidate.clone());
                        let _ = events.send(Event::LanesReplaced(
                            epoch,
                            serial,
                            Ok((candidate, status, peaks)),
                        ));
                        let _ = jobs.send(jobs::Job::Restart(snapshot, epoch));
                    }
                    Err(LaneReplaceFailure::Refused(error)) => {
                        let _ = events.send(Event::LanesReplaced(epoch, serial, Err(error)));
                        let _ = jobs.send(jobs::Job::Restart(refused_analysis, epoch));
                    }
                    Err(LaneReplaceFailure::Disconnected(error)) => {
                        drop(connection.take());
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        let _ = events.send(Event::LanesTransportFailed(epoch, serial, error));
                    }
                    Err(LaneReplaceFailure::Committed(error)) => {
                        drop(connection.take());
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        let _ = events
                            .send(Event::LanesCommittedFailed(epoch, serial, candidate, error));
                    }
                }
                if pending_adoption == Some(PendingAdoption::Lanes(epoch, serial)) {
                    if adopted {
                        retire_adoption(&mut pending_adoption, &mut pending_lane_met);
                        ready.append(&mut deferred);
                    } else {
                        reject_deferred_with_error(
                            &mut deferred,
                            retire_adoption(&mut pending_adoption, &mut pending_lane_met),
                            &events,
                            adoption_error.as_deref().unwrap(),
                            true,
                        );
                    }
                }
            }
            Ok(Request::ImportLibrary(epoch, input)) => {
                if !adopt_current(epoch, None, &latest, &alive) {
                    let _ = copy_handoff.compare_exchange(
                        epoch,
                        0,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    );
                    continue;
                }
                if input.mode == crate::project_import::Mode::Copy {
                    if let Some(child) = &mut connection {
                        child.epoch = epoch;
                    }
                } else {
                    retire_connection(&mut connection);
                }
                let _ =
                    copy_handoff.compare_exchange(epoch, 0, Ordering::AcqRel, Ordering::Acquire);
                *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                let _ = jobs.send(jobs::Job::Import(epoch, input, _provider_work.take()));
            }
            Ok(Request::ImportCompleted(epoch, mut outcome, copying, _pending)) => {
                if !adopt_current(epoch, None, &latest, &alive) {
                    continue;
                }
                let status = if copying {
                    connection.as_mut().filter(|c|c.epoch==epoch).and_then(|child|match child.command("status"){Ok(status)=>Some(status),Err(error)=>{if outcome.warning.is_none(){outcome.warning=Some(format!("Could not refresh playback after adding the project: {error:#}"));}None}})
                } else {
                    None
                };
                let _ = events.send(Event::ImportedLibrary(epoch, outcome, status));
            }
            Ok(Request::Rename(epoch, dir, expected, name)) => {
                if !adopt_current(epoch, None, &latest, &alive) {
                    continue;
                }
                retire_connection(&mut connection);
                *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                let _ = jobs.send(jobs::Job::Rename(
                    epoch,
                    dir,
                    expected,
                    name,
                    _provider_work.take(),
                ));
            }
            Ok(Request::Delete(serial, epoch, was_loaded, target, armed)) => {
                while armed.load(Ordering::Acquire) == 0 && alive.load(Ordering::Acquire) {
                    thread::yield_now();
                }
                let result = (|| -> Result<()> {
                    anyhow::ensure!(
                        alive.load(Ordering::Acquire) && armed.load(Ordering::Acquire) == 1,
                        "Project deletion was not accepted"
                    );
                    if was_loaded {
                        anyhow::ensure!(
                            latest.load(Ordering::Acquire) == epoch,
                            "Project changed before deletion could start"
                        );
                        active_training = None;
                        retire_connection(&mut connection);
                        copy_handoff.store(0, Ordering::Release);
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    } else {
                        anyhow::ensure!(
                            !connection
                                .as_ref()
                                .is_some_and(|c| c.project_dir.as_ref() == Some(&target.dir)),
                            "Project became active before deletion; reopen its confirmation"
                        );
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    let _ = events.send(Event::Deleted(
                        serial,
                        epoch,
                        was_loaded,
                        Err(format!("{error:#}")),
                    ));
                    continue;
                }
                let _ = jobs.send(jobs::Job::Delete(
                    serial,
                    epoch,
                    was_loaded,
                    target,
                    _provider_work.take(),
                ));
            }
            Ok(Request::Provider(serial, revision, epoch, renderer, provider)) => {
                // Keep admission reserved across the complete jobs round trip;
                // new owners must never see a new provider with the old UID.
                if provider_inflight || provider_state.reserved.load(Ordering::Acquire) {
                    let mut refused = provider_state.snapshot.clone();
                    provider_state.snapshot.revision += 1;
                    refused.revision = provider_state.snapshot.revision;
                    refused.request = serial;
                    refused.error =
                        Some("Audio provider eligibility changed; refresh Settings".into());
                    let _ = events.send(Event::Provider(refused));
                    continue;
                }
                let state = provider_state.clone();
                {
                    let _gate = provider_state
                        .gate
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    provider_state.reserved.store(true, Ordering::Release);
                }
                provider_inflight = true;
                let _ = jobs.send(jobs::Job::ChooseProvider(
                    serial,
                    revision,
                    epoch,
                    renderer,
                    provider,
                    state,
                    connection.is_some(),
                    monitor_lease,
                    active_training.is_some(),
                ));
            }
            Ok(Request::ProviderChosen(state, uid, quarantined)) => {
                if state.snapshot.selected != provider_state.snapshot.selected {
                    output_uid = uid;
                }
                let revision = provider_state
                    .snapshot
                    .revision
                    .max(state.snapshot.revision);
                provider_state = state;
                provider_state.snapshot.revision = revision;
                provider_state
                    .reserved
                    .store(quarantined, Ordering::Release);
                provider_inflight = false;
                provider_state.publish(
                    &events,
                    latest.load(Ordering::Acquire),
                    connection.is_some(),
                    monitor_lease,
                    active_training.is_some(),
                    training_intent.load(Ordering::Acquire),
                );
                if provider_state.snapshot.revision == revision {
                    provider_state.snapshot.revision += 1;
                    let _ = events.send(Event::Provider(provider_state.snapshot.clone()));
                }
            }
            Ok(Request::Output(uid)) => {
                let epoch = connection.as_ref().map_or(0, |c| c.epoch);
                let result = (|| -> Result<Option<Status>> {
                    anyhow::ensure!(
                        !monitor_lease,
                        "Stop microphone monitoring before changing playback output"
                    );
                    anyhow::ensure!(
                        uid.len() <= 2000 && !uid.contains('\0'),
                        "Invalid output device"
                    );
                    if let Some(child) = connection
                        .as_mut()
                        .filter(|c| c.epoch == latest.load(Ordering::Acquire))
                    {
                        let routed = child.output_route(&uid);
                        let status = match routed {
                            Ok(status) => status,
                            Err(LaneReplaceFailure::Refused(error)) => bail!("{error}"),
                            Err(
                                LaneReplaceFailure::Disconnected(error)
                                | LaneReplaceFailure::Committed(error),
                            ) => {
                                drop(connection.take());
                                *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                                let _ = events.send(Event::TransportFailed(epoch, error.clone()));
                                bail!("{error}");
                            }
                        };
                        anyhow::ensure!(
                            uid.is_empty() || status.output_uid == uid,
                            "Native output differs from the selected device"
                        );
                        Ok(Some(status))
                    } else {
                        let _ = jobs.send(jobs::Job::OutputProbe(uid.clone()));
                        return Ok(None);
                    }
                })();
                match result {
                    Ok(status) => {
                        if let Some(status) = status {
                            output_uid = uid.clone();
                            let _ = jobs.send(jobs::Job::PersistOutput(epoch, uid, Some(status)));
                        }
                    }
                    Err(error) => {
                        let _ = events.send(Event::OutputChanged(
                            epoch,
                            output_uid.clone(),
                            None,
                            Some(format!("{error:#}")),
                        ));
                    }
                }
            }
            Ok(Request::OutputProbed(uid, result)) => {
                if connection.is_some() || monitor_lease {
                    let _ = events.send(Event::OutputChanged(
                        0,
                        output_uid.clone(),
                        None,
                        Some("Playback project changed during monitoring handoff".into()),
                    ));
                    continue;
                }
                match result {
                    Ok(()) => {
                        output_uid = uid.clone();
                        let _ = jobs.send(jobs::Job::PersistOutput(0, uid, None));
                    }
                    Err(error) => {
                        let _ = events.send(Event::OutputChanged(
                            0,
                            output_uid.clone(),
                            None,
                            Some(error),
                        ));
                    }
                }
            }
            Ok(Request::AdoptRecovery(
                epoch,
                serial,
                request,
                uid,
                pending,
                prepared,
                manifest,
            )) => {
                if !adopt_current(epoch, None, &latest, &alive) {
                    continue;
                }
                if !prepared
                    && !(!request.replace && connection.as_ref().is_some_and(|c| c.epoch == epoch))
                {
                    let _ = jobs.send(jobs::Job::PrepareRecovery(
                        epoch, serial, request, uid, pending,
                    ));
                    continue;
                }
                let _pending = pending;
                recovery_inflight = Some((epoch, serial));
                let result = (|| -> Result<(RecoveredAudio, Option<Connection>)> {
                    anyhow::ensure!(
                        alive.load(Ordering::Acquire) && latest.load(Ordering::Acquire) == epoch,
                        "Output recovery superseded"
                    );
                    anyhow::ensure!(
                        !monitor_lease,
                        "Stop microphone monitoring before recovering playback output"
                    );
                    anyhow::ensure!(
                        uid.len() <= 2000 && !uid.contains('\0'),
                        "Invalid output device"
                    );
                    let (status, media, prepared_child) = if !request.replace
                        && connection.as_ref().is_some_and(|c| c.epoch == epoch)
                    {
                        let routed = connection.as_mut().unwrap().output_route(&uid);
                        let status = match routed {
                            Ok(status) => status,
                            Err(LaneReplaceFailure::Refused(error)) => bail!("{error}"),
                            Err(
                                LaneReplaceFailure::Disconnected(error)
                                | LaneReplaceFailure::Committed(error),
                            ) => {
                                drop(connection.take());
                                *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                                bail!("{error}");
                            }
                        };
                        (status, None, None)
                    } else {
                        retire_connection(&mut connection);
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        active_training = None;
                        training_intent.store(0, Ordering::Release);
                        let (child, status, media) = recovery::prepare(
                            &request,
                            epoch,
                            latest.clone(),
                            alive.clone(),
                            copy_handoff.clone(),
                            &uid,
                            crate::audio_devices::Provider::from_code(
                                provider_selected.load(Ordering::Acquire),
                            ),
                            provider_retired.clone(),
                            manifest,
                        )?;
                        (status, Some(media), Some(child))
                    };
                    anyhow::ensure!(
                        uid.is_empty() || status.output_uid == uid,
                        "Native output differs from the selected device"
                    );
                    anyhow::ensure!(
                        alive.load(Ordering::Acquire) && latest.load(Ordering::Acquire) == epoch,
                        "Output recovery superseded"
                    );
                    let preference_error = None;
                    Ok((
                        RecoveredAudio {
                            status,
                            preference_error,
                            media,
                        },
                        prepared_child,
                    ))
                })()
                .map_err(|e| format!("{e:#}"));
                if result.is_err()
                    && connection.is_none()
                    && epoch == latest.load(Ordering::Acquire)
                {
                    let _ = events.send(Event::TransportFailed(
                        epoch,
                        "Native output is unavailable".into(),
                    ));
                }
                match result {
                    Ok((recovered, prepared_child)) => {
                        if let Some(child) = prepared_child {
                            pending_recovery = Some((epoch, serial, child, _pending));
                            reject_deferred(
                                &mut deferred,
                                retire_adoption(&mut pending_adoption, &mut pending_lane_met),
                                &events,
                            );
                            pending_adoption = Some(PendingAdoption::Recovery(epoch, serial));
                            let _ = jobs.send(jobs::Job::VerifyRecovery(
                                epoch,
                                serial,
                                request.project,
                                uid.clone(),
                                recovered,
                            ));
                        } else {
                            output_uid = uid.clone();
                            recovery_inflight = None;
                            let _ = jobs.send(jobs::Job::PersistRecovery(
                                epoch,
                                serial,
                                output_uid.clone(),
                                recovered,
                            ));
                        }
                    }
                    Err(error) => {
                        let _ = events.send(Event::OutputRecovered(
                            epoch,
                            serial,
                            output_uid.clone(),
                            Err(error),
                        ));
                    }
                }
            }
            Ok(Request::RecoveryVerified(epoch, serial, uid, result)) => {
                if !adopt_current(epoch, None, &latest, &alive)
                    || recovery_inflight != Some((epoch, serial))
                {
                    continue;
                }
                recovery_inflight = None;
                match result {
                    Ok(recovered) => {
                        let Some((owned_epoch, owned_serial, child, _pending)) =
                            pending_recovery.take()
                        else {
                            continue;
                        };
                        if (owned_epoch, owned_serial) != (epoch, serial) {
                            continue;
                        }
                        let expected_lane_ids: Vec<String> = child.loaded_lanes.iter().map(|lane| lane.id.clone()).collect();
                        if !lane_ids_match(&expected_lane_ids, &recovered.status.lane_ids) {
                            child.retire();
                            if pending_adoption == Some(PendingAdoption::Recovery(epoch, serial)) {
                                reject_deferred(
                                    &mut deferred,
                                    retire_adoption(&mut pending_adoption, &mut pending_lane_met),
                                    &events,
                                );
                            }
                            drop(connection.take());
                            *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                            let error = format!("Recovered playback lane IDs differed from the loaded project (expected {}, received {})", expected_lane_ids.len(), recovered.status.lane_ids.len());
                            let _ = events.send(Event::OutputRecovered(epoch, serial, uid, Err(error)));
                            continue;
                        }
                        connection = Some(child);
                        output_uid = uid.clone();
                        if pending_adoption == Some(PendingAdoption::Recovery(epoch, serial)) {
                            retire_adoption(&mut pending_adoption, &mut pending_lane_met);
                            ready.append(&mut deferred);
                        }
                        let _ =
                            jobs.send(jobs::Job::PersistRecovery(epoch, serial, uid, recovered));
                    }
                    Err(error) => {
                        pending_recovery.take();
                        if pending_adoption == Some(PendingAdoption::Recovery(epoch, serial)) {
                            reject_deferred(
                                &mut deferred,
                                retire_adoption(&mut pending_adoption, &mut pending_lane_met),
                                &events,
                            );
                        }
                        drop(connection.take());
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        let _ = events.send(Event::OutputRecovered(epoch, serial, uid, Err(error)));
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Ok(_) => unreachable!("jobs request sent to transport actor"),
        }
        if !alive.load(Ordering::Acquire) {
            break;
        }
        if poll.elapsed() >= Duration::from_millis(33) {
            poll = Instant::now();
            if let Some(child) = connection
                .as_mut()
                .filter(|c| c.epoch == latest.load(Ordering::Acquire))
            {
                let epoch = child.epoch;
                match child.command("status") {
                    Ok(s) => {
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = Some((epoch, s));
                    }
                    Err(e) => {
                        retire_failed_connection(&mut connection,&e);
                        *telemetry.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        training_intent.store(0, Ordering::Release);
                        active_training = None;
                        // Navigation can cancel an old status read while the
                        // next Open is preparing. That is retirement, not a
                        // transport failure for either adopted epoch.
                        if alive.load(Ordering::Acquire) && epoch == latest.load(Ordering::Acquire)
                        {
                            let _ = events.send(Event::TransportFailed(epoch, e.to_string()));
                        }
                    }
                }
            }
        }
    }
    retire_connection(&mut connection);
    if let Some((_,_,child,_))=pending_recovery.take() {child.retire();}
    // Preserve all admitted visible preferences when Drop races recv_timeout.
    for request in requests.try_iter() {
        let request = match request {
            Request::Admitted(request, _) => *request,
            request => request,
        };
        if request.is_preference() {
            let _ = jobs.send(jobs::Job::Forward(request, None));
        }
    }
}

// The host already consumes these operation-specific failure events. Control
// has no separate receipt: pending mix edits belong to the lane transaction's
// (epoch, serial), while a new-song Control belongs to that Open's epoch.
fn reject_deferred(
    deferred: &mut std::collections::VecDeque<Request>,
    pending: Option<PendingAdoption>,
    events: &mpsc::Sender<Event>,
) {
    let message = match pending {
        Some(PendingAdoption::Open(_)) => "Project load superseded",
        Some(PendingAdoption::Lanes(..)) => "Track edit superseded",
        _ => "Output recovery superseded",
    };
    reject_deferred_with_error(deferred, pending, events, message, false);
}
fn reject_deferred_with_error(
    deferred: &mut std::collections::VecDeque<Request>,
    pending: Option<PendingAdoption>,
    events: &mpsc::Sender<Event>,
    message: &str,
    mut transaction_reported: bool,
) {
    while let Some(request) = deferred.pop_front() {
        let (request, _permit) = match request {
            Request::Admitted(request, permit) => (*request, Some(permit)),
            request => (request, None),
        };
        let error = message.to_owned();
        let event = match request {
            Request::Rate(e, s, ..) => Event::Rate(e, s, Err(error)),
            Request::Metronome(e, s, met, beat) => Event::Metronome(e, s, met, beat, Err(error)),
            Request::Carry(e, s, _, _) => Event::Carry(e, s, Err(error)),
            Request::Region(e, s, ..) => Event::Region(e, s, Err(error)),
            Request::Training(e, phrase) => Event::Training(e, phrase.generation, Err(error)),
            Request::Park(e, s, parked) => Event::Parked(e, s, parked, Err(error)),
            Request::Output(uid) => Event::OutputChanged(
                pending.map_or(0, PendingAdoption::epoch),
                uid,
                None,
                Some(error),
            ),
            Request::Control(e, _) | Request::RestoreSeek(e, _) | Request::Playback(e, ..) => {
                // These operations have no independent host error handler.
                // Their transaction owns one notice, including supersession.
                if transaction_reported {
                    continue;
                }
                transaction_reported = true;
                match pending {
                    Some(PendingAdoption::Lanes(_, serial)) => {
                        Event::LanesReplaced(e, serial, Err(error))
                    }
                    _ => Event::Error(e, error, Severity::Fatal),
                }
            }
            _ => unreachable!("only helper-affecting requests are held for adoption"),
        };
        let _ = events.send(event);
    }
}

type PendingLaneMet = (u64, u64, crate::beat::Metronome, Option<crate::beat::Beats>);

// All completion and rejection paths retire the transaction and its overlay
// together. A later edit must never inherit intent from an already failed edit.
fn retire_adoption(
    pending: &mut Option<PendingAdoption>,
    met: &mut Option<PendingLaneMet>,
) -> Option<PendingAdoption> {
    *met = None;
    pending.take()
}
