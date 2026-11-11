use std::ffi::OsString;

pub fn get(name: &str) -> Option<OsString> {
    #[cfg(feature = "ui-tests")]
    {
        std::env::var_os(name)
    }
    #[cfg(not(feature = "ui-tests"))]
    {
        let _ = name;
        None
    }
}

#[cfg(all(test, not(feature = "ui-tests")))]
mod tests {
    #[test]
    fn release_ignores_set_gate() {
        const KEY: &str = "SINGZ_GDRIVE_CONFIG";
        if std::env::var_os("SINGZ_C23_TEST_CHILD").is_some() {
            assert_eq!(
                std::env::var_os(KEY).as_deref(),
                Some(std::ffi::OsStr::new("set"))
            );
            assert_eq!(super::get(KEY), None);
        } else {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("release_ignores_set_gate")
                .env("SINGZ_C23_TEST_CHILD", "1")
                .env(KEY, "set")
                .status()
                .unwrap();
            assert!(status.success(), "isolated gated environment test failed");
        }
    }
}
