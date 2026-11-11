//! Safe packaging metadata. This path does not initialize a UI or open accounts.
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read};

pub(super) fn print() -> anyhow::Result<()> {
    let mut file = File::open(std::env::current_exe()?)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    let info = serde_json::json!({
        "schema":1,"runtime":"rust-gpui","nodeRuntime":false,
        "applicationVersion":crate::release_highlights::CURRENT_VERSION,
        "crateVersion":env!("CARGO_PKG_VERSION"),"os":std::env::consts::OS,"arch":std::env::consts::ARCH,
        "executableSha256":hash.finalize().iter().map(|byte|format!("{byte:02x}")).collect::<String>(),
        "drive":crate::drive_auth::baked_metadata(),
    });
    println!("{}", serde_json::to_string(&info)?);
    Ok(())
}
