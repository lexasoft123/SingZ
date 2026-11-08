//! Hidden native PCM replay -> CREPE -> capture gate -> continuity -> lock/score.
//! No hardware input or synthesized detector values are used by this adapter.
use super::*;
use std::{path::PathBuf, time::Duration};
pub fn run(out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
 let result:anyhow::Result<()>=async{
  std::fs::create_dir_all(&out)?;
  anyhow::ensure!(std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some(),"Native capture fixture required");
  let service=microphone::Service::new();
  service.start(microphone::Intent{prefs:Default::default(),request_permission:false,owner:training_capture::TRAINING_OWNER,serial:1,monitor:false})?;
  let deadline=Instant::now()+Duration::from_secs(15);
  let initial=loop{cx.background_executor().timer(Duration::from_millis(20)).await;let frame=service.snapshot();anyhow::ensure!(!matches!(frame.phase,microphone::Phase::Error|microphone::Phase::Permission),"{:?}",frame.error);if frame.phase==microphone::Phase::Live&&frame.sequence>0&&frame.capture_host_ns>0{break frame;}anyhow::ensure!(Instant::now()<deadline,"Native CREPE startup timed out");};
  anyhow::ensure!(initial.fixture,"Capture adapter must use native PCM replay");
  let mut gate=training_capture::Gate::new(initial.generation,initial.capture_host_ns);
  let mut continuity=training_lock::Continuity::default();let mut tracker=training_lock::Lock::new(10.);let mut observations=vec![];
  let deadline=Instant::now()+Duration::from_secs(10);
  let locked=loop{
   cx.background_executor().timer(Duration::from_millis(15)).await;
   let frame=service.snapshot();anyhow::ensure!(frame.phase==microphone::Phase::Live,"Native capture stopped: {:?}",frame.error);
   if let Some(frame)=gate.ingest(&frame){
    if frame.detector_reset{continuity.reset();tracker.reset();}
    let mut observation=frame.observation;
    if let Some(hz)=continuity.update(observation.at,observation.frequency,observation.confidence,training_lock::MIN_CONFIDENCE){observation.frequency=hz;observation.midi=training_scoring::fractional_midi(hz);}else{observation.frequency=0.;observation.midi=None;}
    let state=tracker.update(observation.at,observation.midi,observation.confidence,57.,training_lock::MIN_CONFIDENCE)?;
    observations.push(observation);if state.locked{break observation.at;}
   }
   anyhow::ensure!(Instant::now()<deadline,"Real CREPE A3 did not satisfy native 1500ms hold");
  };
  let prompt=training_domain::generate(&training_domain::Config{tonic:9,low:57,high:57,length:1,..Default::default()})?.remove(0);
  let result=training_scoring::completed_target(&prompt,&[training_scoring::Window{index:0,start:0.,end:locked}],&observations,None,Default::default(),Some(training_lock::HOLD_MS))?;
  anyhow::ensure!(result.classification==training_session::Classification::OnTarget&&result.metrics.voiced_coverage.unwrap_or(0.)>0.85,"Unexpected capture score");
  // Keep the actual 220Hz fixture while asking for A2. A real octave error
  // must neither earn a lock nor be folded down to the requested register.
  let mut wrong=training_lock::Lock::new(10.);let mut wrong_frames=vec![];let wrong_end=locked+1800.;let deadline=Instant::now()+Duration::from_secs(6);
  loop{
   cx.background_executor().timer(Duration::from_millis(15)).await;
   if let Some(frame)=gate.ingest(&service.snapshot()){
    let observation=frame.observation;let state=wrong.update(observation.at,observation.midi,observation.confidence,45.,training_lock::MIN_CONFIDENCE)?;
    anyhow::ensure!(!state.locked&&state.progress_ms==0.,"Real octave error was folded into target");wrong_frames.push(observation);if observation.at>=wrong_end{break;}
   }
   anyhow::ensure!(Instant::now()<deadline,"Wrong-octave capture timed out");
  }
  let prompt=training_domain::generate(&training_domain::Config{tonic:9,low:45,high:45,length:1,..Default::default()})?.remove(0);
  let wrong_score=training_scoring::score(&prompt,&[training_scoring::Window{index:0,start:wrong_frames[0].at,end:wrong_frames.last().unwrap().at}],&wrong_frames,None,Default::default())?;
  anyhow::ensure!(wrong_score[0].classification==training_session::Classification::WrongOctave,"Real octave error classified incorrectly");
  service.stop()?;let deadline=Instant::now()+Duration::from_secs(5);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;if service.snapshot().phase==microphone::Phase::Off{break;}anyhow::ensure!(Instant::now()<deadline,"Native training capture Stop not acknowledged");}
  std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"nativeCrepe":true,"fixtureInput":true,"hardwareInput":false,"captureOwner":training_capture::TRAINING_OWNER,"captureGeneration":initial.generation,"captureOriginNs":initial.capture_host_ns.to_string(),"uniqueFrames":observations.len(),"lockedAtMs":locked,"medianCents":result.metrics.median_cents_error,"voicedCoverage":result.metrics.voiced_coverage,"wrongOctaveLocked":false,"wrongOctaveClass":"wrong-octave","stopAcknowledged":true}))?)?;Ok(())
 }.await;
 match result{Ok(())=>{eprintln!("TRAINING_CAPTURE passed: real native CREPE fixture, capture-time gate, 1500ms lock, scoring, octave refusal and Stop");let _=cx.update(|cx|cx.quit());},Err(error)=>{eprintln!("TRAINING_CAPTURE failed: {error:#}");std::process::exit(1);}}
 }).detach();
}
