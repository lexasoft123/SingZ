//! The one ZIP reader and extractor for update payloads, on every platform.
//!
//! It accepts only an unambiguous archive: one end record at the very end of
//! the file, a central directory that sits exactly where that record says,
//! local entries that tile the file from byte 0 to the directory with no gaps
//! or overlaps, and local headers that agree with the central directory
//! (flags, method, CRC, sizes, name, ZIP64 fields). Names are checked before
//! anything is written: no escapes, no duplicates, no case or Unicode aliases,
//! no file used as a directory, nothing under a link. Sizes are bounded before
//! and during decompression, and every file is written by this module with
//! `create_new`, so nothing existing is ever overwritten or followed.
use anyhow::{Context, Result, bail, ensure};
use std::{
    collections::{BTreeSet, HashMap},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;

/// Bounds a signed archive must stay within, whatever its manifest says.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_entries: u64,
    /// Total of all expanded entries.
    pub max_total: u64,
    pub max_entry: u64,
    /// Expanded / compressed, for entries larger than `ratio_floor`.
    pub max_ratio: u64,
    pub ratio_floor: u64,
}
pub const LIMITS: Limits = Limits {
    max_entries: 100_000,
    max_total: 4 << 30,
    max_entry: 2 << 30,
    max_ratio: 200,
    ratio_floor: 1 << 20,
};
/// The marker a Windows payload carries (written by the updater, never shipped).
pub const RESERVED_NAME: &str = ".singz-payload.json";
const MAX_NAME: usize = 1024;
const MAX_DEPTH: usize = 64;
const MAX_LINK: u64 = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Symlink,
}
#[derive(Clone, Debug)]
pub struct Entry {
    /// Path inside the archive, without a trailing `/`.
    pub name: String,
    pub kind: Kind,
    /// Unix permission bits, when the archive was made on Unix.
    pub mode: Option<u32>,
    pub size: u64,
    compressed: u64,
    method: u16,
    flags: u16,
    crc: u32,
    local: u64,
    zip64: bool,
    data: u64,
}
pub struct Archive {
    file: File,
    pub entries: Vec<Entry>,
    /// The single top-level directory every entry lives under.
    pub root: String,
}

fn le16(b: &[u8], at: usize) -> Result<u16> {
    let s = b.get(at..at + 2).context("truncated zip record")?;
    Ok(u16::from_le_bytes([s[0], s[1]]))
}
fn le32(b: &[u8], at: usize) -> Result<u32> {
    let s = b.get(at..at + 4).context("truncated zip record")?;
    Ok(u32::from_le_bytes(s.try_into().expect("four bytes")))
}
fn le64(b: &[u8], at: usize) -> Result<u64> {
    let s = b.get(at..at + 8).context("truncated zip record")?;
    Ok(u64::from_le_bytes(s.try_into().expect("eight bytes")))
}
fn read_at(file: &mut File, at: u64, buf: &mut [u8]) -> Result<()> {
    file.seek(SeekFrom::Start(at))?;
    file.read_exact(buf).context("truncated zip archive")
}
/// The extra-field block, which must tile exactly; returns the ZIP64 field.
fn zip64_field(extra: &[u8]) -> Result<Option<&[u8]>> {
    let (mut at, mut found) = (0, None);
    while at < extra.len() {
        let (id, len) = (le16(extra, at)?, le16(extra, at + 2)? as usize);
        let body = extra.get(at + 4..at + 4 + len).context("corrupt zip extra field")?;
        if id == 1 {
            ensure!(found.is_none(), "duplicate zip64 field");
            found = Some(body);
        }
        at += 4 + len;
    }
    Ok(found)
}
/// Replace each saturated 32-bit value, in order, from the ZIP64 field.
fn widen(fields: &mut [&mut u64], extra: Option<&[u8]>) -> Result<bool> {
    let mut at = 0;
    for field in fields.iter_mut() {
        if **field == 0xFFFF_FFFF {
            **field = le64(extra.context("zip64 value without a zip64 field")?, at)?;
            at += 8;
        }
    }
    ensure!(extra.is_none_or(|e| e.len() >= at), "corrupt zip64 field");
    Ok(at > 0)
}

/// One path rule for every host: what may appear inside a payload.
pub fn check_name(name: &str) -> Result<()> {
    ensure!(!name.is_empty() && name.len() <= MAX_NAME, "update archive entry name is empty or too long");
    let parts: Vec<&str> = name.split('/').collect();
    ensure!(parts.len() <= MAX_DEPTH, "update archive path is too deep");
    for part in &parts {
        let bad_char = |c: char| c.is_control() || matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
        ensure!(
            !part.is_empty()
                && *part != "."
                && *part != ".."
                && !part.chars().any(bad_char)
                && !part.ends_with('.')
                && !part.ends_with(' ')
                && !device
                && !part.eq_ignore_ascii_case(RESERVED_NAME),
            "update archive contains an unsafe path: {name:?}"
        );
    }
    Ok(())
}
/// The name two entries collide under on a case-insensitive or
/// normalisation-insensitive file system (APFS, NTFS).
fn fold(name: &str) -> String {
    name.nfc().collect::<String>().to_lowercase()
}

pub fn open(path: &Path, limits: &Limits, allow_links: bool) -> Result<Archive> {
    let mut file = File::open(path).context("open update archive")?;
    let len = file.metadata()?.len();
    ensure!(len >= 22, "update archive is not a zip file");
    let tail_len = len.min(22 + 0xFFFF);
    let mut tail = vec![0u8; tail_len as usize];
    read_at(&mut file, len - tail_len, &mut tail)?;
    // The end record (plus its comment) must end exactly at the end of the file.
    let mut ends = (0..=tail.len() - 22)
        .rev()
        .filter(|&i| tail[i..].starts_with(b"PK\x05\x06") && le16(&tail, i + 20).is_ok_and(|c| i + 22 + c as usize == tail.len()));
    let eocd = ends.next().context("update archive is not a zip file")?;
    ensure!(ends.next().is_none(), "update archive has more than one end record");
    let record = &tail[eocd..];
    let eocd_at = len - tail_len + eocd as u64;
    let (disk, cd_disk) = (le16(record, 4)?, le16(record, 6)?);
    let (on_disk, total) = (le16(record, 8)?, le16(record, 10)?);
    let (mut cd_size, mut cd_offset) = (le32(record, 12)? as u64, le32(record, 16)? as u64);
    let mut count = total as u64;
    let mut cd_end = eocd_at;
    if total == 0xFFFF || on_disk == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF {
        ensure!(eocd_at >= 20 + 56, "corrupt zip64 end record");
        let mut locator = [0u8; 20];
        read_at(&mut file, eocd_at - 20, &mut locator)?;
        ensure!(locator.starts_with(b"PK\x06\x07") && le32(&locator, 4)? == 0 && le32(&locator, 16)? == 1, "corrupt zip64 locator");
        let at = le64(&locator, 8)?;
        ensure!(at.checked_add(56) == Some(eocd_at - 20), "the zip64 end record must precede its locator");
        let mut r = [0u8; 56];
        read_at(&mut file, at, &mut r)?;
        ensure!(r.starts_with(b"PK\x06\x06") && le64(&r, 4)? == 44, "corrupt zip64 end record");
        ensure!(le32(&r, 16)? == 0 && le32(&r, 20)? == 0 && le64(&r, 24)? == le64(&r, 32)?, "multi-disk zip archives are not supported");
        count = le64(&r, 32)?;
        cd_size = le64(&r, 40)?;
        cd_offset = le64(&r, 48)?;
        cd_end = at;
    } else {
        ensure!(disk == 0 && cd_disk == 0 && on_disk == total, "multi-disk zip archives are not supported");
    }
    ensure!(count > 0, "empty update archive");
    ensure!(count <= limits.max_entries, "update archive has too many entries");
    ensure!(cd_offset.checked_add(cd_size) == Some(cd_end), "zip directory is not where the end record says");
    ensure!(cd_size <= 64 << 20, "zip directory is too large");
    let mut directory = vec![0u8; cd_size as usize];
    read_at(&mut file, cd_offset, &mut directory)?;

    let (mut at, mut entries, mut total_size) = (0usize, Vec::with_capacity(count as usize), 0u64);
    let mut seen: HashMap<String, Kind> = HashMap::new();
    for _ in 0..count {
        let d = &directory;
        ensure!(d.get(at..at + 4) == Some(b"PK\x01\x02"), "corrupt zip directory");
        let (made_by, flags, method) = (le16(d, at + 4)?, le16(d, at + 8)?, le16(d, at + 10)?);
        let crc = le32(d, at + 16)?;
        let (mut compressed, mut size) = (le32(d, at + 20)? as u64, le32(d, at + 24)? as u64);
        let (name_len, extra_len, comment_len) = (le16(d, at + 28)? as usize, le16(d, at + 30)? as usize, le16(d, at + 32)? as usize);
        let disk_start = le16(d, at + 34)?;
        let external = le32(d, at + 38)?;
        let mut local = le32(d, at + 42)? as u64;
        let raw = d.get(at + 46..at + 46 + name_len).context("corrupt zip directory")?;
        let extra = d.get(at + 46 + name_len..at + 46 + name_len + extra_len).context("corrupt zip directory")?;
        ensure!(d.len() >= at + 46 + name_len + extra_len + comment_len, "corrupt zip directory");
        at += 46 + name_len + extra_len + comment_len;

        ensure!(flags & !(0x0002 | 0x0004 | 0x0008 | 0x0800) == 0, "update archive uses an unsupported zip feature (flags {flags:#06x})");
        ensure!(method == 0 || method == 8, "update archive uses an unsupported compression method {method}");
        ensure!(disk_start == 0, "multi-disk zip archives are not supported");
        let zip64 = widen(&mut [&mut size, &mut compressed, &mut local], zip64_field(extra)?)?;
        ensure!(flags & 0x0800 != 0 || raw.is_ascii(), "update archive entry name is not marked UTF-8");
        let full = std::str::from_utf8(raw).context("update archive entry name is not UTF-8")?;
        let unix = matches!(made_by >> 8, 3 | 19);
        let file_type = if unix { (external >> 16) & 0o170000 } else { 0 };
        let (name, kind) = match full.strip_suffix('/') {
            Some(dir) => {
                ensure!(file_type == 0 || file_type == 0o040000, "update archive directory entry has a file type");
                (dir, Kind::Dir)
            }
            None => match file_type {
                0 | 0o100000 => (full, Kind::File),
                0o120000 => (full, Kind::Symlink),
                _ => bail!("update archive contains a special file: {full:?}"),
            },
        };
        check_name(name)?;
        ensure!(kind != Kind::Symlink || allow_links, "update archive contains a link");
        ensure!(kind != Kind::Dir || size == 0, "update archive directory entry has content");
        ensure!(kind != Kind::Symlink || size <= MAX_LINK, "update archive link target is too long");
        ensure!(method != 0 || compressed == size, "stored entry sizes disagree");
        ensure!(size <= limits.max_entry, "update archive entry is too large: {name}");
        ensure!(
            size <= limits.ratio_floor || size <= compressed.saturating_mul(limits.max_ratio),
            "update archive entry expands too far: {name}"
        );
        total_size = total_size.saturating_add(size);
        ensure!(total_size <= limits.max_total, "update archive expands beyond {} bytes", limits.max_total);
        ensure!(seen.insert(fold(name), kind).is_none(), "update archive has a duplicate or case-alias entry: {name:?}");
        let mode = unix.then_some((external >> 16) & 0o7777);
        entries.push(Entry { name: name.to_owned(), kind, mode, size, compressed, method, flags, crc, local, zip64, data: 0 });
    }
    ensure!(at == directory.len(), "zip directory has trailing bytes");

    // One payload root, and no entry below a file or a link.
    let roots: BTreeSet<&str> = entries.iter().map(|e| e.name.split('/').next().unwrap_or("")).collect();
    ensure!(roots.len() == 1, "update archive must contain one payload root");
    let root = roots.into_iter().next().expect("one root").to_owned();
    for entry in &entries {
        for (cut, _) in entry.name.match_indices('/') {
            ensure!(
                seen.get(&fold(&entry.name[..cut])).is_none_or(|k| *k == Kind::Dir),
                "update archive places {:?} below a file or link",
                entry.name
            );
        }
    }
    ensure!(seen.get(&fold(&root)).is_none_or(|k| *k == Kind::Dir), "update archive payload root is not a directory");

    // Local headers: agree with the directory and tile [0, directory) exactly.
    let mut order: Vec<usize> = (0..entries.len()).collect();
    order.sort_by_key(|&i| entries[i].local);
    let mut expected = 0u64;
    for i in order {
        let e = &mut entries[i];
        ensure!(e.local == expected, "update archive entries overlap or leave gaps");
        let mut h = [0u8; 30];
        read_at(&mut file, e.local, &mut h)?;
        ensure!(h.starts_with(b"PK\x03\x04"), "corrupt local header for {}", e.name);
        ensure!(le16(&h, 6)? == e.flags && le16(&h, 8)? == e.method, "local header disagrees with the directory for {}", e.name);
        let (name_len, extra_len) = (le16(&h, 26)? as usize, le16(&h, 28)? as usize);
        let mut tail = vec![0u8; name_len + extra_len];
        read_at(&mut file, e.local + 30, &mut tail)?;
        let stored = if e.kind == Kind::Dir { format!("{}/", e.name) } else { e.name.clone() };
        ensure!(&tail[..name_len] == stored.as_bytes(), "local name disagrees with the directory for {}", e.name);
        let local_zip64 = zip64_field(&tail[name_len..])?;
        let (mut size, mut compressed) = (le32(&h, 22)? as u64, le32(&h, 18)? as u64);
        if e.flags & 0x0008 == 0 {
            if size == 0xFFFF_FFFF || compressed == 0xFFFF_FFFF {
                let z = local_zip64.context("zip64 local header without a zip64 field")?;
                (size, compressed) = (le64(z, 0)?, le64(z, 8)?);
            }
            ensure!(
                le32(&h, 14)? == e.crc && size == e.size && compressed == e.compressed,
                "local header disagrees with the directory for {}",
                e.name
            );
        }
        e.data = e.local + 30 + (name_len + extra_len) as u64;
        let mut end = e.data.checked_add(e.compressed).context("corrupt entry size")?;
        if e.flags & 0x0008 != 0 {
            // Data descriptor: optional signature, CRC, then 4- or 8-byte sizes.
            let wide = e.zip64 || local_zip64.is_some();
            let mut dd = [0u8; 24];
            let available = (cd_offset.saturating_sub(end)).min(24) as usize;
            read_at(&mut file, end, &mut dd[..available])?;
            let skip = if dd.starts_with(b"PK\x07\x08") { 4 } else { 0 };
            let (crc, c, s, n) = if wide {
                (le32(&dd, skip)?, le64(&dd, skip + 4)?, le64(&dd, skip + 12)?, skip + 20)
            } else {
                (le32(&dd, skip)?, le32(&dd, skip + 4)? as u64, le32(&dd, skip + 8)? as u64, skip + 12)
            };
            ensure!(crc == e.crc && c == e.compressed && s == e.size, "data descriptor disagrees with the directory for {}", e.name);
            end += n as u64;
        }
        expected = end;
    }
    ensure!(expected == cd_offset, "update archive has bytes between its entries and its directory");
    Ok(Archive { file, entries, root })
}

/// The decompressed bytes of one entry, bounded by its declared size and
/// checked against its CRC. `sink` gets each chunk; `cancelled` is polled.
fn stream(file: &mut File, e: &Entry, cancelled: &dyn Fn() -> bool, sink: &mut dyn FnMut(&[u8]) -> Result<()>) -> Result<()> {
    file.seek(SeekFrom::Start(e.data))?;
    let raw = BufReader::new((&mut *file).take(e.compressed));
    let mut crc = flate2::Crc::new();
    let mut written = 0u64;
    let mut buf = vec![0u8; 64 * 1024];
    let mut pump = |reader: &mut dyn Read| -> Result<()> {
        loop {
            ensure!(!cancelled(), "update cancelled");
            let n = reader.read(&mut buf)?;
            if n == 0 {
                return Ok(());
            }
            written += n as u64;
            ensure!(written <= e.size, "update archive entry is larger than declared: {}", e.name);
            crc.update(&buf[..n]);
            sink(&buf[..n])?;
        }
    };
    if e.method == 8 {
        let mut decoder = flate2::bufread::DeflateDecoder::new(raw);
        pump(&mut decoder)?;
        // Every compressed byte must belong to the stream: no hidden slack.
        ensure!(decoder.get_mut().fill_buf()?.is_empty(), "update archive entry has trailing data: {}", e.name);
    } else {
        let mut raw = raw;
        pump(&mut raw)?;
    }
    ensure!(written == e.size, "update archive entry is shorter than declared: {}", e.name);
    ensure!(crc.sum() == e.crc, "update archive entry fails its CRC: {}", e.name);
    Ok(())
}
/// A link target must stay inside the payload root.
fn check_link(name: &str, target: &str) -> Result<()> {
    ensure!(!target.is_empty() && !target.contains('\0') && !target.starts_with('/') && !target.contains('\\'), "payload link {name:?} is unsafe");
    let mut depth = name.split('/').count() as i64 - 2; // the link's own directory, below the root
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => depth -= 1,
            _ => depth += 1,
        }
        ensure!(depth >= 0, "payload link {name:?} points outside the payload");
    }
    Ok(())
}
#[cfg(unix)]
fn file_mode(mode: Option<u32>) -> u32 {
    // Owner read/write always; execute as archived; never setuid, setgid,
    // sticky or group/other write.
    (mode.unwrap_or(0o644) & 0o755) | 0o600
}

impl Archive {
    /// Write every entry below `into`, which must be an empty directory, and
    /// return the payload root. Files are flushed; the caller syncs directories.
    pub fn extract(&mut self, into: &Path, cancelled: &dyn Fn() -> bool) -> Result<PathBuf> {
        ensure!(fs::read_dir(into)?.next().is_none(), "extraction directory is not empty");
        let root = into.join(&self.root);
        fs::create_dir(&root)?;
        let mut links = Vec::new();
        let entries = self.entries.clone();
        for e in &entries {
            let path = into.join(&e.name);
            match e.kind {
                Kind::Dir => {
                    // Parents may already exist implicitly; names are unique.
                    ensure_parents(into, &path.join("x"))?;
                }
                Kind::Symlink => links.push(e.clone()),
                Kind::File => {
                    ensure_parents(into, &path)?;
                    let mut options = OpenOptions::new();
                    options.write(true).create_new(true);
                    #[cfg(unix)]
                    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
                    let mut out = options.open(&path).with_context(|| format!("create {}", e.name))?;
                    stream(&mut self.file, e, cancelled, &mut |chunk| Ok(out.write_all(chunk)?))?;
                    out.sync_all().with_context(|| format!("flush {}", e.name))?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        out.set_permissions(fs::Permissions::from_mode(file_mode(e.mode)))?;
                    }
                }
            }
        }
        // Links last, so nothing is ever written through one.
        #[cfg(not(unix))]
        if let Some(e) = links.first() {
            bail!("payload links are not supported here: {}", e.name);
        }
        for e in &links {
            let mut target = Vec::new();
            stream(&mut self.file, e, cancelled, &mut |chunk| {
                target.extend_from_slice(chunk);
                Ok(())
            })?;
            let target = String::from_utf8(target).context("payload link target is not UTF-8")?;
            check_link(&e.name, &target)?;
            let path = into.join(&e.name);
            ensure_parents(into, &path)?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &path).with_context(|| format!("link {}", e.name))?;
        }
        // The lexical rule cannot see composed links (`a -> .` then
        // `b -> a/../..`): resolve every link now and require its target to
        // exist inside the payload.
        for e in &links {
            check_resolved(&root, &into.join(&e.name))?;
        }
        Ok(root)
    }
}
/// A link, resolved through every link it passes (the OS bounds the hops and
/// fails on loops), must land on something that exists inside `root`.
pub fn check_resolved(root: &Path, link: &Path) -> Result<()> {
    let root = fs::canonicalize(root).context("resolve payload root")?;
    let target = fs::canonicalize(link).with_context(|| format!("payload link {} does not resolve", link.display()))?;
    ensure!(target.starts_with(&root), "payload link {} resolves outside the payload", link.display());
    Ok(())
}
/// Create missing parents, refusing to pass through anything but a real directory.
fn ensure_parents(into: &Path, path: &Path) -> Result<()> {
    let parent = path.parent().context("entry has no parent")?;
    let relative = parent.strip_prefix(into)?;
    let mut current = into.to_path_buf();
    for part in relative.components() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) => ensure!(meta.is_dir(), "update archive path passes through a non-directory"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&current)?,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "updater_zip_tests.rs"]
mod tests;
