//! Windows ownership and DACL for the update coordination directory.
//!
//! Created with a protected DACL (the current user, SYSTEM and
//! Administrators; nothing inherited) and, on every open, required to be
//! owned by the current user with exactly such a DACL. Every security
//! descriptor and string the API allocates is freed on every path.
use anyhow::{Context, Result, ensure};
use std::{ffi::c_void, os::windows::ffi::OsStrExt, path::Path, ptr::null_mut};

#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(process: isize, access: u32, token: *mut isize) -> i32;
    fn GetTokenInformation(token: isize, class: u32, info: *mut c_void, len: u32, returned: *mut u32) -> i32;
    fn GetNamedSecurityInfoW(
        name: *const u16,
        object: u32,
        info: u32,
        owner: *mut *mut c_void,
        group: *mut *mut c_void,
        dacl: *mut *mut c_void,
        sacl: *mut *mut c_void,
        descriptor: *mut *mut c_void,
    ) -> u32;
    fn EqualSid(a: *mut c_void, b: *mut c_void) -> i32;
    fn IsValidSid(sid: *mut c_void) -> i32;
    fn ConvertStringSidToSidW(text: *const u16, sid: *mut *mut c_void) -> i32;
    fn CheckTokenMembership(token: isize, sid: *mut c_void, is_member: *mut i32) -> i32;
    fn ConvertSidToStringSidW(sid: *mut c_void, text: *mut *mut u16) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl: *const u16, revision: u32, descriptor: *mut *mut c_void, size: *mut u32) -> i32;
    fn ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor: *mut c_void, revision: u32, info: u32, text: *mut *mut u16, len: *mut u32) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> isize;
    fn CloseHandle(handle: isize) -> i32;
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
    fn CreateDirectoryW(path: *const u16, attributes: *const SecurityAttributes) -> i32;
}
#[repr(C)]
struct SecurityAttributes {
    length: u32,
    descriptor: *mut c_void,
    inherit: i32,
}
const TOKEN_QUERY: u32 = 0x0008;
const TOKEN_USER: u32 = 1;
const SE_FILE_OBJECT: u32 = 1;
const OWNER_SECURITY_INFORMATION: u32 = 0x1;
const DACL_SECURITY_INFORMATION: u32 = 0x4;
const SDDL_REVISION_1: u32 = 1;

/// Memory from LocalAlloc, freed when dropped (on every path).
struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: allocated by the API with LocalAlloc and freed once.
            unsafe { LocalFree(self.0) };
        }
    }
}
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn wide_str(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
/// SAFETY: `text` must be a NUL-terminated UTF-16 string.
unsafe fn from_wide(text: *const u16) -> String {
    let mut len = 0;
    // SAFETY: the caller guarantees a terminator.
    while unsafe { *text.add(len) } != 0 {
        len += 1;
    }
    // SAFETY: `len` units were just read.
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) })
}
/// The process user's SID, kept alive in its TOKEN_USER buffer.
struct User {
    _buffer: Vec<u64>,
    sid: *mut c_void,
}
fn current_user() -> Result<User> {
    let mut token: isize = 0;
    // SAFETY: the pseudo-handle and out-pointer are valid; the token is closed below.
    ensure!(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } != 0, "open the process token");
    let mut buffer = vec![0u64; 64]; // 512 aligned bytes: TOKEN_USER and its SID
    let mut returned = 0u32;
    // SAFETY: the buffer is writable for the length given.
    let ok = unsafe { GetTokenInformation(token, TOKEN_USER, buffer.as_mut_ptr().cast(), 512, &mut returned) };
    // SAFETY: closing the token opened above, once.
    unsafe { CloseHandle(token) };
    ensure!(ok != 0, "read the process user");
    // SAFETY: on success the buffer starts with TOKEN_USER { User: { Sid, .. } }.
    let sid = unsafe { *(buffer.as_ptr() as *const *mut c_void) };
    // SAFETY: IsValidSid accepts any pointer the token reported.
    ensure!(!sid.is_null() && unsafe { IsValidSid(sid) } != 0, "the process user has no valid SID");
    Ok(User { _buffer: buffer, sid })
}
fn sid_string(sid: *mut c_void) -> Result<String> {
    let mut text: *mut u16 = null_mut();
    // SAFETY: a valid SID and out-pointer; the string is freed by the guard.
    let ok = unsafe { ConvertSidToStringSidW(sid, &mut text) };
    let _free = Local(text.cast());
    ensure!(ok != 0 && !text.is_null(), "format the user SID");
    // SAFETY: the API returns a NUL-terminated string.
    Ok(unsafe { from_wide(text) })
}
/// A well-known SID, freed when dropped.
fn well_known(text: &str) -> Result<Local> {
    let mut sid = null_mut();
    // SAFETY: a NUL-terminated SID string and a valid out-pointer; freed by the guard.
    let ok = unsafe { ConvertStringSidToSidW(wide_str(text).as_ptr(), &mut sid) };
    let sid = Local(sid);
    ensure!(ok != 0 && !sid.0.is_null(), "build the SID {text}");
    Ok(sid)
}
/// The owners the threat model trusts: the current user; BUILTIN\Administrators
/// when this process's token is an enabled member (an elevated administrator's
/// new objects are owned by that group); and LocalSystem. Any other owner,
/// including Administrators for a non-elevated token, is refused.
fn trusted_owner(owner: *mut c_void, user: &User) -> Result<bool> {
    // SAFETY: both SIDs are valid (checked by the caller and current_user).
    let is_user = unsafe { EqualSid(owner, user.sid) } != 0;
    let system = well_known("S-1-5-18")?;
    let admins = well_known("S-1-5-32-544")?;
    // SAFETY: valid SIDs.
    let is_system = unsafe { EqualSid(owner, system.0) } != 0;
    let is_admins = unsafe { EqualSid(owner, admins.0) } != 0;
    let mut member = 0i32;
    // SAFETY: a null token means this thread's effective token; valid SID and out-pointer.
    let admin_member = is_admins && unsafe { CheckTokenMembership(0, admins.0, &mut member) } != 0 && member != 0;
    Ok(crate::updater_state::owner_trusted(is_user, is_admins, admin_member, is_system))
}
/// Create `path` with a protected DACL: full control for the current user,
/// SYSTEM and Administrators; nothing inherited from the parent.
pub fn create_private_dir(path: &Path) -> Result<()> {
    let user = current_user()?;
    let me = sid_string(user.sid)?;
    let sddl = wide_str(&format!("O:{me}D:P(A;OICI;FA;;;{me})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"));
    let mut descriptor = null_mut();
    // SAFETY: a NUL-terminated SDDL string and a valid out-pointer.
    let ok = unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut()) };
    let descriptor = Local(descriptor);
    ensure!(ok != 0 && !descriptor.0.is_null(), "build the private security descriptor");
    let attributes = SecurityAttributes { length: std::mem::size_of::<SecurityAttributes>() as u32, descriptor: descriptor.0, inherit: 0 };
    // SAFETY: a NUL-terminated path and a live SECURITY_ATTRIBUTES.
    ensure!(
        unsafe { CreateDirectoryW(wide(path).as_ptr(), &attributes) } != 0,
        "create {}: {}",
        path.display(),
        std::io::Error::last_os_error()
    );
    Ok(())
}
/// The directory must be owned by the current user (a valid owner SID) and
/// carry a protected DACL that only lets the user, SYSTEM and Administrators in.
pub fn verify_private_dir(path: &Path) -> Result<()> {
    let user = current_user()?;
    let me = sid_string(user.sid)?;
    let (mut owner, mut dacl, mut descriptor) = (null_mut(), null_mut(), null_mut());
    // SAFETY: a NUL-terminated path and valid out-pointers; the descriptor is
    // freed by the guard on every path, and `owner`/`dacl` point into it.
    let rc = unsafe {
        GetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    let descriptor = Local(descriptor);
    ensure!(rc == 0, "read the security of {}: error {rc}", path.display());
    // SAFETY: IsValidSid accepts any pointer; EqualSid only runs on valid SIDs.
    ensure!(!owner.is_null() && unsafe { IsValidSid(owner) } != 0, "{} has no valid owner", path.display());
    ensure!(trusted_owner(owner, &user)?, "{} belongs to another user", path.display());
    ensure!(!dacl.is_null(), "{} has no DACL (open to everyone)", path.display());
    let mut text: *mut u16 = null_mut();
    // SAFETY: a live descriptor and out-pointer; the string is freed by the guard.
    let ok = unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor.0, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &mut text, null_mut())
    };
    let _text = Local(text.cast());
    ensure!(ok != 0 && !text.is_null(), "format the DACL of {}", path.display());
    // SAFETY: the API returns a NUL-terminated string.
    let sddl = unsafe { from_wide(text) };
    crate::updater_state::check_private_dacl(&sddl, &me).with_context(|| format!("{} is not private", path.display()))
}
