//! Durable first-run dismissal, independent of the UI toolkit.
use std::{
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};
pub(crate) fn seen(dir: &Path) -> bool {
    let path = dir.join("quick-start.json");
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return false;
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 1024 {
        return false;
    }
    std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|v| v["version"] == 1 && v["seen"] == true)
}
pub(crate) fn retain_seen(dir: &Path) -> anyhow::Result<()> {
    use std::io::Write;
    static SERIAL: AtomicU64 = AtomicU64::new(1);
    std::fs::create_dir_all(dir)?;
    let file = dir.join("quick-start.json");
    let part = dir.join(format!(
        ".quick-start-{}-{}.part",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)?;
        f.write_all(b"{\"version\":1,\"seen\":true}\n")?;
        f.sync_all()?;
        drop(f);
        crate::project_store::replace(&part, &file)?;
        Ok(())
    })();
    let _ = std::fs::remove_file(part);
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dismissal_is_durable_and_invalid_metadata_does_not_skip_welcome() {
        let dir = std::env::temp_dir().join(format!("singz-quick-start-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!seen(&dir));
        retain_seen(&dir).unwrap();
        assert!(seen(&dir));
        std::fs::write(
            dir.join("quick-start.json"),
            b"{\"seen\":true,\"version\":2}",
        )
        .unwrap();
        assert!(!seen(&dir));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
