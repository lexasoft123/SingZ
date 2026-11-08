//! Source registry from main/models.ts, expressed as native data. Model caches
//! are shared with the shipped app; no JS/Electron is loaded to inspect them.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Flavor {
    AppleSilicon,
    IntelMac,
    Windows,
    Linux,
}
impl Flavor {
    pub fn host() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") {
                Self::AppleSilicon
            } else {
                Self::IntelMac
            }
        } else {
            Self::Linux
        }
    }
    pub fn pack_format(self) -> u64 {
        if self == Self::Windows { 10 } else { 6 }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileKind {
    Gguf,
    Onnx,
    Torch,
    Archive,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Part {
    pub file: PathBuf,
    pub url: String,
    pub mb: u64,
    pub min_bytes: u64,
    pub kind: FileKind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub label: String,
    pub description: String,
    pub optional: bool,
    pub parts: Vec<Part>,
    pub archive: bool,
}
impl Entry {
    pub fn mb(&self) -> u64 {
        self.parts.iter().map(|p| p.mb).sum()
    }
    pub fn validate(&self, fixture: bool) -> Result<()> {
        ensure!(
            matches!(self.id.as_str(), "gpu-splitter" | "qwen-asr" | "aligner")
                && !self.parts.is_empty()
                && self.parts.len() <= 3,
            "Invalid model catalog identity"
        );
        ensure!(
            !self.archive || self.id == "gpu-splitter" && self.parts.len() == 1,
            "Invalid model archive"
        );
        for p in &self.parts {
            ensure!(
                !p.file.as_os_str().is_empty()
                    && p.file
                        .components()
                        .all(|c| matches!(c, std::path::Component::Normal(_))),
                "Invalid model destination"
            );
            ensure!(
                p.url.len() < 8192
                    && (p.url.starts_with("https://")
                        || (fixture && p.url.starts_with("http://127.0.0.1:"))),
                "Model URLs must use HTTPS"
            );
            ensure!(
                p.mb > 0 && p.mb < 20_000 && p.min_bytes > 0,
                "Invalid model size"
            );
        }
        Ok(())
    }
}
#[derive(Clone, Debug)]
pub struct Config {
    pub models: PathBuf,
    pub pack: PathBuf,
    pub flavor: Flavor,
    pub entries: Vec<Entry>,
    pub fixture: bool,
}
impl Config {
    pub fn source() -> Self {
        let home = PathBuf::from(
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .unwrap_or_default(),
        );
        let data = if cfg!(target_os = "macos") {
            home.join("Library/Application Support")
        } else if cfg!(windows) {
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or(home.join("AppData/Roaming"))
        } else {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or(home.join(".config"))
        };
        let root = std::env::var_os("SINGZ_GPUI_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| data.join("SingZ"));
        let flavor = Flavor::host();
        let version: serde_json::Value =
            serde_json::from_str(include_str!("../../../package.json"))
                .expect("packaged release metadata");
        Self {
            models: std::env::var_os("SINGZ_MODELS_DIR")
                .map(PathBuf::from)
                .unwrap_or(root.join("models")),
            pack: std::env::var_os("SINGZ_PACK_DIR")
                .map(PathBuf::from)
                .unwrap_or(root.join("gpu-splitter")),
            flavor,
            entries: registry(flavor, version["version"].as_str().unwrap()),
            fixture: false,
        }
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.models.is_absolute() && self.pack.is_absolute() && self.models != self.pack,
            "Invalid model cache location"
        );
        let mut ids = std::collections::BTreeSet::new();
        for e in &self.entries {
            e.validate(self.fixture)?;
            ensure!(ids.insert(&e.id), "Duplicate model id for platform");
        }
        Ok(())
    }
}
pub fn registry(flavor: Flavor, version: &str) -> Vec<Entry> {
    let part = |file: &str, url: String, mb, kind| Part {
        file: file.into(),
        url,
        mb,
        min_bytes: 1024 * 1024,
        kind,
    };
    let mut entries = vec![];
    if flavor != Flavor::Linux {
        let (platform, arch, mb, description) = match flavor {
            Flavor::AppleSilicon => (
                "darwin",
                "arm64",
                352,
                "Splits songs into seven tracks — lead and backing vocals, drums, bass, guitar, piano and the rest — in seconds on the Apple Silicon GPU.",
            ),
            Flavor::IntelMac => (
                "darwin",
                "x64",
                286,
                "Splits songs into seven tracks — lead and backing vocals, drums, bass, guitar, piano and the rest.",
            ),
            _ => (
                "win32",
                "x64",
                361,
                "Splits songs into seven tracks — lead and backing vocals, drums, bass, guitar, piano and the rest — on your GPU when it can (GeForce RTX 30xx or newer; CPU otherwise).",
            ),
        };
        entries.push(Entry{id:"gpu-splitter".into(),label:"Stem splitter · AI".into(),description:description.into(),optional:false,archive:true,parts:vec![part("gpu-splitter.tar.gz",std::env::var("SINGZ_GPU_PACK_URL").unwrap_or_else(|_|format!("https://github.com/lexasoft123/SingZ/releases/download/v{version}/gpu-splitter-{platform}-{arch}.tar.gz")),mb,FileKind::Archive)]});
    }
    entries.push(Entry{id:"qwen-asr".into(),label:"Speech model · lyrics".into(),description:"Hears the vocals: transcribes lyrics when none are online, and checks & aligns downloaded lyrics against what is actually sung. Trained on singing, in 30 languages, with its own word aligner.".into(),optional:true,archive:false,parts:vec![
        part("Qwen3-ASR-1.7B-Q8_0.gguf","https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/main/Qwen3-ASR-1.7B-Q8_0.gguf".into(),2165,FileKind::Gguf),
        part("mmproj-Qwen3-ASR-1.7B-Q8_0.gguf","https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/main/mmproj-Qwen3-ASR-1.7B-Q8_0.gguf".into(),356,FileKind::Gguf),
        part("qwen3-forced-aligner-0.6b-q8_0.gguf","https://huggingface.co/cstr/qwen3-forced-aligner-0.6b-GGUF/resolve/main/qwen3-forced-aligner-0.6b-q8_0.gguf".into(),990,FileKind::Gguf)]});
    if flavor != Flavor::Linux {
        let torch = flavor == Flavor::AppleSilicon;
        entries.push(Entry{id:"aligner".into(),label:"Precise word aligner".into(),description:"Snaps every lyric word to the exact moment it is sung — the sharpest karaoke timing, in 1,100+ languages. Runs through the stem splitter.".into(),optional:true,archive:false,parts:vec![if torch{part("torch-home/hub/checkpoints/model.pt","https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt".into(),1200,FileKind::Torch)}else{part("mms-fa.onnx","https://github.com/lexasoft123/SingZ/releases/download/models-1/mms-fa.onnx".into(),1263,FileKind::Onnx)}]});
    }
    entries
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_platform_filter_and_release_pin_select_only_one_aligner() {
        for flavor in [
            Flavor::AppleSilicon,
            Flavor::IntelMac,
            Flavor::Windows,
            Flavor::Linux,
        ] {
            let entries = registry(flavor, "0.26.5");
            assert_eq!(entries.len(), if flavor == Flavor::Linux { 1 } else { 3 });
            assert_eq!(
                entries.iter().filter(|e| e.id == "aligner").count(),
                usize::from(flavor != Flavor::Linux)
            );
            if let Some(pack) = entries.iter().find(|e| e.archive) {
                assert!(pack.parts[0].url.contains("/v0.26.5/"));
                assert!(!pack.parts[0].url.contains("latest"));
            }
            let speech = entries.iter().find(|e| e.id == "qwen-asr").unwrap();
            assert_eq!(speech.mb(), 3511);
            assert_eq!(speech.parts.len(), 3);
            for e in entries {
                e.validate(false).unwrap();
            }
        }
    }
    #[test]
    fn unsafe_catalog_destinations_and_plaintext_remote_urls_are_rejected() {
        let mut e = registry(Flavor::Linux, "1").remove(0);
        e.parts[0].file = "../escape".into();
        assert!(e.validate(false).is_err());
        e.parts[0].file = "safe".into();
        e.parts[0].url = "http://elsewhere/file".into();
        assert!(e.validate(true).is_err());
    }
}
