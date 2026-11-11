//! Hash-bound saved graphs and private, immutable helper manifests.
use anyhow::{Context, Result, ensure};
use md5::{Digest, Md5};
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Clone, Debug)]
pub struct Prepared {
    wire: Arc<str>,
}
pub fn read(dir: &Path, metadata: &Value) -> Result<Option<Prepared>> {
    let Some(reference) = metadata.get("graphHash") else {
        return Ok(None);
    };
    // JSON numbers such as 1.0 have the same integer meaning as 1 in the
    // source contract. Bounds here are small enough to remain exact in f64.
    let format = reference["format"]
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0. && *n >= 1. && *n <= u32::MAX as f64)
        .context("Invalid saved graph reference")?;
    let format = format as u64;
    ensure!(
        format == 1,
        "Saved graph format {format} is not supported for playback"
    );
    let size = reference["size"]
        .as_f64()
        .filter(|n| {
            n.is_finite()
                && n.fract() == 0.
                && *n >= 0.
                && *n <= crate::drive_graph::MAX_GRAPH_DOCUMENT_TEXT_BYTES as f64
        })
        .context("Invalid saved graph byte count")?;
    let size = size as u64;
    ensure!(
        reference["mtimeMs"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= 0.),
        "Invalid saved graph timestamp"
    );
    let expected = reference["md5"]
        .as_str()
        .context("Invalid saved graph hash")?;
    ensure!(
        expected.len() == 32
            && expected
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid saved graph hash"
    );
    let path = dir.join("graph.json");
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    ensure!(
        !fs::symlink_metadata(&path)
            .context("Saved graph is missing")?
            .file_type()
            .is_symlink(),
        "Saved graph must be an ordinary file"
    );
    let file = options.open(&path).context("Could not open saved graph")?;
    let stat = file.metadata()?;
    ensure!(
        stat.is_file() && stat.len() == size,
        "Saved graph bytes do not match their project reference"
    );
    let mut bytes = Vec::new();
    file.take(size + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == size && format!("{:x}", Md5::digest(&bytes)) == expected,
        "Saved graph bytes do not match their project reference"
    );
    Ok(Some(Prepared {
        wire: crate::drive_graph::playback_projection(&bytes)?.into(),
    }))
}
pub struct Manifest {
    directory: PathBuf,
    path: PathBuf,
}
impl Manifest {
    pub fn new(graph: &Prepared) -> Result<Self> {
        let directory = std::env::temp_dir().join(format!(
            "singz-gpui-graph-{}",
            crate::drive_http::random_id()?
        ));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory)?;
        let manifest = Self {
            path: directory.join("projection"),
            directory,
        };
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&manifest.path)?;
        file.write_all(graph.wire.as_bytes())?;
        file.sync_all()?;
        Ok(manifest)
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
}
impl Drop for Manifest {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_dir(&self.directory);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, Vec<u8>, Value) {
        let dir = std::env::temp_dir().join(format!(
            "singz-native-graph-test-{}",
            crate::drive_http::random_id().unwrap()
        ));
        fs::create_dir(&dir).unwrap();
        let bytes = include_bytes!("../../../tests/shared/native-playback-graph.json").to_vec();
        fs::write(dir.join("graph.json"), &bytes).unwrap();
        let meta = serde_json::json!({"graphHash":{"format":1,"md5":format!("{:x}",Md5::digest(&bytes)),"size":bytes.len(),"mtimeMs":0}});
        (dir, bytes, meta)
    }
    #[test]
    fn verified_graph_projects_only_native_controls_and_manifest_is_temporary() {
        let (dir, bytes, meta) = fixture();
        let prepared = read(&dir, &meta).unwrap().unwrap();
        let mut floats = meta.clone();
        floats["graphHash"]["format"] = serde_json::json!(1.0);
        floats["graphHash"]["size"] = serde_json::json!(bytes.len() as f64);
        assert_eq!(read(&dir, &floats).unwrap().unwrap().wire, prepared.wire);
        floats["graphHash"]["size"] = serde_json::json!(bytes.len() as f64 + 0.5);
        assert!(read(&dir, &floats).is_err());
        assert!(prepared.wire.starts_with("SingZGraph1 14 13\n"));
        assert!(!prepared.wire.contains("opaque"));
        let path = {
            let manifest = Manifest::new(&prepared).unwrap();
            assert_eq!(
                fs::read_to_string(manifest.path()).unwrap(),
                &*prepared.wire
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(manifest.path()).unwrap().permissions().mode() & 0o077,
                    0
                );
            }
            manifest.path().to_owned()
        };
        assert!(!path.exists());
        assert!(!path.parent().unwrap().exists());
        assert_eq!(fs::read(dir.join("graph.json")).unwrap(), bytes);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn stray_missing_changed_future_and_unsafe_graphs_never_gain_prepare_authority() {
        let (dir, bytes, mut meta) = fixture();
        assert!(read(&dir, &serde_json::json!({})).unwrap().is_none());
        meta["graphHash"]["format"] = serde_json::json!(2);
        assert!(read(&dir, &meta).is_err());
        meta["graphHash"]["format"] = serde_json::json!(1);
        fs::write(dir.join("graph.json"), b"{}").unwrap();
        assert!(read(&dir, &meta).is_err());
        fs::remove_file(dir.join("graph.json")).unwrap();
        assert!(read(&dir, &meta).is_err());
        fs::create_dir(dir.join("graph.json")).unwrap();
        assert!(read(&dir, &meta).is_err());
        fs::remove_dir(dir.join("graph.json")).unwrap();
        #[cfg(unix)]
        {
            fs::write(dir.join("outside"), &bytes).unwrap();
            std::os::unix::fs::symlink(dir.join("outside"), dir.join("graph.json")).unwrap();
            assert!(read(&dir, &meta).is_err());
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn native_limits_and_unrepresentable_names_do_not_change_wire_validation() {
        let bytes = include_bytes!("../../../tests/shared/graph-document-utf16.json");
        crate::drive_graph::validate(bytes, 1).unwrap();
        assert!(crate::drive_graph::playback_projection(bytes).is_err());
        let mut graph: Value = serde_json::from_slice(include_bytes!(
            "../../../tests/shared/native-playback-graph.json"
        ))
        .unwrap();
        graph["nodes"][0]["id"] = serde_json::json!("0");
        assert!(
            crate::drive_graph::playback_projection(&serde_json::to_vec(&graph).unwrap()).is_err()
        );
    }
}
