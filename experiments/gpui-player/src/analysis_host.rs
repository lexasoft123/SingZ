//! Commit independently completed analysis parts through the current project.
use crate::{diagnostics, integration, project_analysis, project_key, project_pitch, Player};
use gpui_kit::Context;
use std::sync::Arc;

fn adopt(project: &mut integration::Project, output: &project_analysis::Output) -> bool {
    let mut changed = false;
    if project_analysis::melody_needed(project) {
        if let Some(melody) = &output.melody {
            project.raw["settings"]["melody"] = melody.clone();
            changed = true;
        }
    }
    if project_key::needed(project) {
        if let Some(key) = output.key.as_ref().and_then(project_key::Outcome::saved) {
            project.raw["settings"]["key"] = key;
            changed = true;
        }
    }
    changed
}

impl Player {
    pub(super) fn accept_project_analysis(
        &mut self,
        result: Result<project_analysis::Output, String>,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = &mut self.project else {
            return;
        };
        let (changed, warnings) = match result {
            Ok(output) => (adopt(project, &output), output.warnings),
            Err(error) => (false, vec![format!("Project analysis failed: {error}")]),
        };
        let mut pitch = project_pitch::Pitch::read(&project.raw["settings"]);
        pitch.bind_duration_for_lane(self.duration, project.vocal_duration);
        if !warnings.is_empty() {
            pitch.warning = Some(warnings.join("\n"));
            for warning in &warnings {
                diagnostics::event("analysis", warning, diagnostics::Level::Warn);
            }
        }
        project.pitch = Arc::new(pitch);
        self.pitch_strip
            .update(cx, |strip, cx| strip.set_native(project.pitch.clone(), cx));
        if changed {
            self.edit_seq += 1;
            // The existing automatic-analysis Save queue also serializes beat
            // corrections; raw imports stay private until explicit Save.
            self.beat_auto_save |= !self.source_working;
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn automatic_analysis_adoption_preserves_current_and_future_stamps_and_foreign_data() {
        let dir = std::env::temp_dir().join(format!(
            "singz-analysis-adopt-{}-{}",
            std::process::id(),
            crate::drive_http::random_id().unwrap()
        ));
        std::fs::create_dir_all(dir.join("stems")).unwrap();
        std::fs::write(dir.join("stems/vocals.wav"), b"fixture source").unwrap();
        std::fs::write(dir.join("stems/bass.wav"), b"fixture harmonic source").unwrap();
        let output = project_analysis::Output {
            melody: Some(serde_json::json!({"detVersion":4,"hopSec":0.025,"f0":"2700"})),
            key: Some(project_key::Outcome::Detected {
                pc: 0,
                minor: false,
            }),
            warnings: vec![],
        };
        for version in [1, 2, 99] {
            let raw = serde_json::json!({"name":"Song","foreign":{"keep":1},"settings":{
                "key":{"pc":8,"minor":true,"detVersion":version},
                "melody":{"detVersion":if version==99 {99}else{4},"hopSec":0.025,"f0":"2700"}}});
            std::fs::write(dir.join("project.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
            let mut project = integration::read_project(&dir).unwrap();
            assert_eq!(adopt(&mut project, &output), version == 1);
            assert_eq!(
                project.raw["settings"]["key"],
                if version == 1 {
                    serde_json::json!({"pc":0,"minor":false,"detVersion":2})
                } else {
                    raw["settings"]["key"].clone()
                }
            );
            assert_eq!(project.raw["settings"]["melody"], raw["settings"]["melody"]);
            assert_eq!(project.raw["foreign"], raw["foreign"]);
            assert_eq!(
                std::fs::read(dir.join("project.json")).unwrap(),
                serde_json::to_vec(&raw).unwrap()
            );
        }
        let mut project = integration::read_project(&dir).unwrap();
        project.raw["settings"]["key"] = serde_json::Value::Null;
        assert!(!adopt(
            &mut project,
            &project_analysis::Output {
                key: Some(project_key::Outcome::NoKey),
                ..Default::default()
            }
        ));
        assert!(project.raw["settings"]["key"].is_null());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
