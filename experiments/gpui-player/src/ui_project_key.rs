//! Hidden real harmonic analysis and automatic saved-project persistence.
use super::*;
use std::{path::PathBuf, time::Duration};
pub(super) fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx| {
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(&out)?;
            let path=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").unwrap()).canonicalize()?;
            handle.update(cx,|_,w,cx|{w.resize(size(px(1240.),px(820.)));view.update(cx,|p,cx|p.open_project(path.clone(),cx));})?;
            let deadline=Instant::now()+Duration::from_secs(45);
            loop {
                cx.background_executor().timer(Duration::from_millis(50)).await;
                let ready=handle.update(cx,|_,_,cx| {
                    let p=view.read(cx);
                    !p.loading&&p.analysis_job.is_none()&&!p.saving&&!p.beat_auto_save&&p.project.as_ref().is_some_and(|project| project.raw["settings"]["key"]["detVersion"]==2&&project.pitch.key=="C")
                })?;
                if ready {break;}
                anyhow::ensure!(Instant::now()<deadline,"Native key analysis/autosave did not complete");
            }
            handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                let p=view.read(cx);
                anyhow::ensure!(!p.source_working&&p.edit_seq==p.saved_seq&&p.notice.is_none(),"Automatic analysis was not saved cleanly: {:?}",p.notice);
                let raw:serde_json::Value=serde_json::from_slice(&std::fs::read(path.join("project.json"))?)?;
                anyhow::ensure!(raw["settings"]["key"]==serde_json::json!({"pc":0,"minor":false,"detVersion":2}),"Detected harmonic key did not reach disk: {}",raw["settings"]["key"]);
                super::ui_training_run::draw(w,cx);
                w.render_to_image()?.save(out.join("detected-and-saved.png"))?;
                Ok(())
            })??;
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"nativeHarmonicDetection":true,"automaticSavedProjectPersistence":true,"keyReadout":"C","hidden":true,"muted":true,"productionVisualParityClaimed":false}))?)?;
            Ok(())
        }.await;
        match result {Ok(())=>{let _=cx.update(|cx|cx.quit());},Err(error)=>{eprintln!("PROJECT_KEY failed: {error:#}");std::process::exit(1);}}
    }).detach();
}
