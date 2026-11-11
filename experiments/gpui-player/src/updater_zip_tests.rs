//! The reader against hand-built archives (every field controllable), and
//! against real `ditto` and Python `zipfile` output.
use super::*;

#[derive(Clone)]
struct E {
    name: String,
    data: Vec<u8>,
    mode: u32,
    deflate: bool,
    descriptor: bool,
    zip64: bool,
    declared: Option<u64>,
    crc: Option<u32>,
    local_name: Option<String>,
}
impl E {
    fn file(name: &str, data: &[u8]) -> E {
        E { name: name.into(), data: data.into(), mode: 0o100644, deflate: false, descriptor: false, zip64: false, declared: None, crc: None, local_name: None }
    }
    fn exe(name: &str, data: &[u8]) -> E {
        E { mode: 0o100755, ..E::file(name, data) }
    }
    fn dir(name: &str) -> E {
        E { mode: 0o040755, ..E::file(&format!("{name}/"), b"") }
    }
    fn link(name: &str, target: &str) -> E {
        E { mode: 0o120777, ..E::file(name, target.as_bytes()) }
    }
    fn deflated(self) -> E {
        E { deflate: true, ..self }
    }
}
fn crc32(data: &[u8]) -> u32 {
    let mut crc = flate2::Crc::new();
    crc.update(data);
    crc.sum()
}
fn deflate(data: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}
/// Returns the archive bytes and each entry's local header offset.
fn zip(entries: &[E]) -> (Vec<u8>, Vec<usize>) {
    let (mut out, mut cd, mut offsets) = (Vec::new(), Vec::new(), Vec::new());
    for e in entries {
        let body = if e.deflate { deflate(&e.data) } else { e.data.clone() };
        let crc = e.crc.unwrap_or_else(|| crc32(&e.data));
        let size = e.declared.unwrap_or(e.data.len() as u64);
        let flags: u16 = 0x0800 | if e.descriptor { 0x0008 } else { 0 };
        let method: u16 = if e.deflate { 8 } else { 0 };
        let offset = out.len();
        offsets.push(offset);
        let local_name = e.local_name.clone().unwrap_or_else(|| e.name.clone());
        let z64 = |values: &[u64]| -> Vec<u8> {
            let mut x = vec![1, 0];
            x.extend(((values.len() * 8) as u16).to_le_bytes());
            for v in values {
                x.extend(v.to_le_bytes());
            }
            x
        };
        let (l_size, l_comp, l_extra) = if e.zip64 {
            (0xFFFF_FFFFu32, 0xFFFF_FFFFu32, z64(&[size, body.len() as u64]))
        } else {
            (size as u32, body.len() as u32, vec![])
        };
        out.extend(b"PK\x03\x04");
        out.extend(if e.zip64 { 45u16 } else { 20u16 }.to_le_bytes());
        out.extend(flags.to_le_bytes());
        out.extend(method.to_le_bytes());
        out.extend([0, 0, 0, 0]);
        if e.descriptor {
            out.extend([0u8; 12]);
        } else {
            out.extend(crc.to_le_bytes());
            out.extend(l_comp.to_le_bytes());
            out.extend(l_size.to_le_bytes());
        }
        out.extend((local_name.len() as u16).to_le_bytes());
        out.extend((l_extra.len() as u16).to_le_bytes());
        out.extend(local_name.as_bytes());
        out.extend(&l_extra);
        out.extend(&body);
        if e.descriptor {
            out.extend(b"PK\x07\x08");
            out.extend(crc.to_le_bytes());
            out.extend((body.len() as u32).to_le_bytes());
            out.extend((size as u32).to_le_bytes());
        }
        let c_extra = if e.zip64 { z64(&[size, body.len() as u64]) } else { vec![] };
        cd.extend(b"PK\x01\x02");
        cd.extend([20, 3]); // made by Unix
        cd.extend(if e.zip64 { 45u16 } else { 20u16 }.to_le_bytes());
        cd.extend(flags.to_le_bytes());
        cd.extend(method.to_le_bytes());
        cd.extend([0, 0, 0, 0]);
        cd.extend(crc.to_le_bytes());
        cd.extend(if e.zip64 { 0xFFFF_FFFF } else { body.len() as u32 }.to_le_bytes());
        cd.extend(if e.zip64 { 0xFFFF_FFFF } else { size as u32 }.to_le_bytes());
        cd.extend((e.name.len() as u16).to_le_bytes());
        cd.extend((c_extra.len() as u16).to_le_bytes());
        cd.extend([0, 0, 0, 0, 0, 0]);
        cd.extend((e.mode << 16).to_le_bytes());
        cd.extend((offset as u32).to_le_bytes());
        cd.extend(e.name.as_bytes());
        cd.extend(&c_extra);
    }
    let at = out.len() as u32;
    out.extend(&cd);
    out.extend(b"PK\x05\x06\0\0\0\0");
    out.extend((entries.len() as u16).to_le_bytes());
    out.extend((entries.len() as u16).to_le_bytes());
    out.extend((cd.len() as u32).to_le_bytes());
    out.extend(at.to_le_bytes());
    out.extend([0, 0]);
    (out, offsets)
}
fn scratch(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "singz-zip-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    fs::create_dir_all(&p).unwrap();
    p
}
fn write(dir: &Path, bytes: &[u8]) -> PathBuf {
    let path = dir.join("update.zip");
    fs::write(&path, bytes).unwrap();
    path
}
fn opened(bytes: &[u8]) -> Result<Archive> {
    let dir = scratch("open");
    let result = open(&write(&dir, bytes), &LIMITS, allow_links());
    let _ = fs::remove_dir_all(dir);
    result
}
fn extracted(bytes: &[u8], limits: &Limits) -> (PathBuf, Result<PathBuf>) {
    let dir = scratch("extract");
    let archive = write(&dir, bytes);
    let into = dir.join("out");
    fs::create_dir(&into).unwrap();
    let result = open(&archive, limits, allow_links()).and_then(|mut a| a.extract(&into, &|| false));
    (dir, result)
}
fn rejects(bytes: &[u8], needle: &str) {
    let (dir, result) = extracted(bytes, &LIMITS);
    let error = format!("{:#}", result.expect_err("the archive must be refused"));
    assert!(error.contains(needle), "expected {needle:?} in: {error}");
    // Nothing escapes: only the extraction directory may have been written.
    let names: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names.len(), 2, "{names:?}");
    fs::remove_dir_all(dir).unwrap();
}
fn payload() -> Vec<E> {
    vec![
        E::dir("App"),
        E::dir("App/Contents"),
        E::exe("App/Contents/app", b"#!/bin/sh\nexit 0\n").deflated(),
        E::file("App/Contents/Info.plist", &b"plist ".repeat(500)).deflated(),
        E::dir("App/Contents/Frameworks/A"),
    ]
    .into_iter()
    // Links exist only in macOS bundles; Windows payloads refuse them.
    .chain(cfg!(unix).then(|| E::link("App/Contents/Frameworks/Current", "A")))
    .collect()
}
fn allow_links() -> bool {
    cfg!(unix)
}

#[test]
fn a_well_formed_payload_is_written_exactly() {
    let (bytes, _) = zip(&payload());
    let (dir, root) = extracted(&bytes, &LIMITS);
    let root = root.unwrap();
    assert_eq!(root, dir.join("out/App"));
    assert_eq!(fs::read(root.join("Contents/app")).unwrap(), b"#!/bin/sh\nexit 0\n");
    assert_eq!(fs::read(root.join("Contents/Info.plist")).unwrap(), b"plist ".repeat(500));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(root.join("Contents/app")).unwrap().permissions().mode() & 0o777, 0o755);
        assert_eq!(fs::metadata(root.join("Contents/Info.plist")).unwrap().permissions().mode() & 0o777, 0o644);
        assert_eq!(fs::read_link(root.join("Contents/Frameworks/Current")).unwrap(), Path::new("A"));
    }
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn a_zip_bomb_is_refused_before_anything_large_is_written() {
    // 64 MiB of zeros deflates to ~64 KiB: an honest header, an absurd ratio.
    let zeros = vec![0u8; 64 << 20];
    let mut entries = payload();
    entries.push(E::file("App/bomb", &zeros).deflated());
    rejects(&zip(&entries).0, "expands too far");
    // A header that lies small: refused while streaming, at the declared size.
    let mut liar = E::file("App/liar", &zeros[..8 << 20]).deflated();
    liar.declared = Some(1000);
    let mut entries = payload();
    entries.push(liar);
    let (dir, result) = extracted(&zip(&entries).0, &LIMITS);
    assert!(format!("{:#}", result.unwrap_err()).contains("larger than declared"));
    let written = fs::metadata(dir.join("out/App/liar")).map_or(0, |m| m.len());
    assert!(written <= 64 * 1024 + 1000, "only one chunk past the declared size may be read, not written whole: {written}");
    fs::remove_dir_all(dir).unwrap();
    // Many honest entries that add up past the total budget.
    let small = Limits { max_total: 10_000, ..LIMITS };
    let mut entries = payload();
    for i in 0..5 {
        entries.push(E::file(&format!("App/part{i}"), &[7u8; 3000]));
    }
    let (dir, result) = extracted(&zip(&entries).0, &small);
    assert!(format!("{:#}", result.unwrap_err()).contains("expands beyond"));
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn duplicate_and_alias_names_are_refused() {
    for (a, b) in [
        ("App/readme", "App/readme"),
        ("App/readme", "App/README"),
        ("App/caf\u{e9}", "App/cafe\u{301}"), // NFC vs NFD: one name on APFS
        ("App/x", "App/x/inner"),             // a file used as a directory
        ("App/X", "App/x/inner"),
    ] {
        let mut entries = payload();
        entries.push(E::file(a, b"one"));
        entries.push(E::file(b, b"two"));
        let (dir, result) = extracted(&zip(&entries).0, &LIMITS);
        let error = format!("{:#}", result.expect_err(&format!("{a} + {b}")));
        assert!(error.contains("duplicate or case-alias") || error.contains("below a file or link"), "{error}");
        fs::remove_dir_all(dir).unwrap();
    }
    let mut entries = payload();
    entries.push(E::dir("App/Contents")); // a directory listed twice
    rejects(&zip(&entries).0, "duplicate or case-alias");
}
#[test]
fn local_headers_must_agree_with_the_directory() {
    // A different name in the local header (what another parser would write).
    let mut entries = payload();
    entries[3].local_name = Some("App/Contents/Info.pliZ".into());
    rejects(&zip(&entries).0, "local name disagrees");
    // A different CRC: caught in the header, before any bytes are written.
    let (mut bytes, offsets) = zip(&payload());
    bytes[offsets[2] + 14] ^= 0xFF;
    rejects(&bytes, "local header disagrees");
    // A different method in the local header.
    let (mut bytes, offsets) = zip(&payload());
    bytes[offsets[2] + 8] = 0;
    rejects(&bytes, "local header disagrees");
    // A body that does not match the CRC both headers agree on.
    let mut entries = payload();
    entries[3].crc = Some(0x1234_5678);
    rejects(&zip(&entries).0, "fails its CRC");
}
#[test]
fn entries_must_tile_the_file_without_overlap_gaps_or_prefixes() {
    // Two directory entries pointing at the same local entry (overlap).
    let (bytes, offsets) = zip(&payload());
    let cd = u32::from_le_bytes(bytes[bytes.len() - 6..bytes.len() - 2].try_into().unwrap()) as usize;
    let mut overlapping = bytes.clone();
    // Point the second central entry's local offset at the first entry.
    let second = cd + 46 + "App/".len();
    overlapping[second + 42..second + 46].copy_from_slice(&(offsets[0] as u32).to_le_bytes());
    rejects(&overlapping, "");
    // Prepended bytes (a self-extractor stub) shift every offset.
    let mut prefixed = b"MZ-stub".to_vec();
    prefixed.extend(&bytes);
    rejects(&prefixed, "");
    // Junk between the last entry and the directory.
    let mut gap = bytes[..cd].to_vec();
    gap.extend(b"hidden");
    gap.extend(&bytes[cd..]);
    let end = gap.len();
    gap[end - 6..end - 2].copy_from_slice(&((cd + 6) as u32).to_le_bytes());
    rejects(&gap, "between its entries and its directory");
    // Two end records (an archive appended to another).
    let mut twice = bytes.clone();
    twice.extend(&bytes[bytes.len() - 22..]);
    assert!(opened(&twice).is_err());
}
#[test]
fn zip64_is_checked_entry_by_entry() {
    let mut entries = payload();
    let mut big = E::file("App/zip64", &[9u8; 5000]).deflated();
    big.zip64 = true;
    entries.push(big.clone());
    let (dir, result) = extracted(&zip(&entries).0, &LIMITS);
    assert_eq!(fs::read(result.unwrap().join("zip64")).unwrap(), vec![9u8; 5000]);
    fs::remove_dir_all(dir).unwrap();
    // The local ZIP64 sizes disagree with the central ones.
    let mut entries = payload();
    entries.push(big);
    let (mut bytes, offsets) = zip(&entries);
    let local_extra = *offsets.last().unwrap() + 30 + "App/zip64".len() + 4;
    bytes[local_extra] ^= 1;
    rejects(&bytes, "local header disagrees");
    // A saturated size with no ZIP64 field to widen it.
    let (mut bytes, _) = zip(&payload());
    let cd = u32::from_le_bytes(bytes[bytes.len() - 6..bytes.len() - 2].try_into().unwrap()) as usize;
    bytes[cd + 24..cd + 28].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
    rejects(&bytes, "zip64 value without a zip64 field");
}
#[test]
fn data_descriptors_must_match_the_directory() {
    let mut entries = payload();
    entries[2].descriptor = true;
    let (bytes, _) = zip(&entries);
    let (dir, result) = extracted(&bytes, &LIMITS);
    assert!(result.unwrap().join("Contents/app").is_file());
    fs::remove_dir_all(dir).unwrap();
    let mut entries = payload();
    entries[2].descriptor = true;
    let (mut bytes, offsets) = zip(&entries);
    // The descriptor follows the body; flip its CRC.
    let at = offsets[3] - 12;
    bytes[at] ^= 0xFF;
    rejects(&bytes, "data descriptor disagrees");
}
#[test]
fn paths_may_not_escape_or_alias_on_any_platform() {
    for bad in [
        "App/../evil",
        "App/./x",
        "App//x",
        "App/a\\..\\evil",
        "App/C:evil",
        "App/file.txt:stream",
        "App/CON",
        "App/nul.txt",
        "App/trailing.",
        "App/trailing ",
        "App/.singz-payload.json",
        "App/ctrl\u{7}",
    ] {
        let mut entries = payload();
        entries.push(E::file(bad, b"x"));
        rejects(&zip(&entries).0, "unsafe path");
    }
    let mut entries = payload();
    entries.push(E::file("/etc/passwd", b"x"));
    rejects(&zip(&entries).0, "");
    let mut entries = payload();
    entries.push(E::file("Other/x", b"x"));
    rejects(&zip(&entries).0, "one payload root");
}
#[test]
#[cfg(unix)]
fn links_stay_inside_the_payload_and_nothing_is_written_through_them() {
    for target in ["../../outside", "/etc", "A/../../.."] {
        let mut entries = payload();
        entries.push(E::link("App/Contents/escape", target));
        rejects(&zip(&entries).0, "");
    }
    // R5: links that each look contained but compose to leave the payload.
    let mut entries = payload();
    entries.push(E::link("App/Contents/a", "."));
    entries.push(E::link("App/Contents/escape", "a/../.."));
    rejects(&zip(&entries).0, "resolves outside");
    // A dangling link is not part of a payload either.
    let mut entries = payload();
    entries.push(E::link("App/Contents/nowhere", "missing"));
    rejects(&zip(&entries).0, "does not resolve");
    // A link followed by an entry beneath it (zip-slip through a link).
    let mut entries = payload();
    entries.push(E::link("App/Contents/hop", ".."));
    entries.push(E::file("App/Contents/hop/evil", b"x"));
    rejects(&zip(&entries).0, "below a file or link");
    // Special files are not payload.
    let mut entries = payload();
    entries.push(E { mode: 0o010644, ..E::file("App/fifo", b"") });
    rejects(&zip(&entries).0, "special file");
}
#[test]
fn windows_payloads_may_not_carry_links() {
    let mut entries = payload();
    entries.push(E::link("App/Contents/l", "app"));
    let dir = scratch("nolinks");
    assert!(format!("{:#}", open(&write(&dir, &zip(&entries).0), &LIMITS, false).err().unwrap()).contains("link"));
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn extraction_needs_an_empty_directory_and_stops_when_cancelled() {
    let dir = scratch("busy");
    let archive = write(&dir, &zip(&payload()).0);
    let into = dir.join("out");
    fs::create_dir_all(into.join("App")).unwrap();
    assert!(open(&archive, &LIMITS, allow_links()).unwrap().extract(&into, &|| false).is_err());
    fs::remove_dir_all(&into).unwrap();
    fs::create_dir(&into).unwrap();
    let error = open(&archive, &LIMITS, allow_links()).unwrap().extract(&into, &|| true).unwrap_err();
    assert!(format!("{error:#}").contains("cancelled"));
    fs::remove_dir_all(dir).unwrap();
}
#[test]
#[cfg(target_os = "macos")]
fn real_ditto_and_python_archives_are_read() {
    let dir = scratch("real");
    let app = dir.join("src/Test.app");
    fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    fs::create_dir_all(app.join("Contents/Frameworks/V")).unwrap();
    fs::write(app.join("Contents/MacOS/app"), b"#!/bin/sh\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(app.join("Contents/MacOS/app"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(app.join("Contents/Info.plist"), "x".repeat(10_000)).unwrap();
    std::os::unix::fs::symlink("V", app.join("Contents/Frameworks/Current")).unwrap();
    // Exactly the flags the feed signer uses.
    let ditto = dir.join("ditto.zip");
    let ok = std::process::Command::new("/usr/bin/ditto")
        .args(["-c", "-k", "--norsrc", "--noextattr", "--noqtn", "--noacl", "--keepParent"])
        .arg(&app)
        .arg(&ditto)
        .status()
        .unwrap();
    assert!(ok.success());
    let into = dir.join("from-ditto");
    fs::create_dir(&into).unwrap();
    let root = open(&ditto, &LIMITS, true).unwrap().extract(&into, &|| false).unwrap();
    assert_eq!(fs::read(root.join("Contents/Info.plist")).unwrap(), "x".repeat(10_000).as_bytes());
    assert_eq!(fs::metadata(root.join("Contents/MacOS/app")).unwrap().permissions().mode() & 0o111, 0o111);
    assert_eq!(fs::read_link(root.join("Contents/Frameworks/Current")).unwrap(), Path::new("V"));
    // The Windows feed is written by Python's zipfile (no links there).
    fs::remove_file(app.join("Contents/Frameworks/Current")).unwrap();
    let py = dir.join("py.zip");
    let script = "import sys,zipfile,pathlib\np=pathlib.Path(sys.argv[1]);z=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED)\nfor f in sorted(p.rglob('*')):\n n=p.name+'/'+f.relative_to(p).as_posix()\n z.writestr(zipfile.ZipInfo(n+'/'),b'') if f.is_dir() else z.write(f,n)\nz.close()\n";
    assert!(std::process::Command::new("python3").args(["-I", "-c", script]).arg(&app).arg(&py).status().unwrap().success());
    let into = dir.join("from-python");
    fs::create_dir(&into).unwrap();
    let root = open(&py, &LIMITS, false).unwrap().extract(&into, &|| false).unwrap();
    assert_eq!(fs::read(root.join("Contents/MacOS/app")).unwrap(), b"#!/bin/sh\n");
    fs::remove_dir_all(dir).unwrap();
}
