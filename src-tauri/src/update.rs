//! In-app updates: look for a newer GitHub release, download the file for this
//! OS, verify its minisign signature and replace the running copy.
//!
//! The feed is the static `latest.json` attached to the latest (non-pre-)release
//! (see `tools/update_manifest.py`); `tauri-plugin-updater` reads it, picks the
//! entry for this OS and checks the downloaded bytes against the public key baked
//! in at build time. No key at build time = updates are off in that build.
//!
//! Linux and macOS use the plugin's `install()` (AppImage swap, `.app` swap).
//! Windows ships a bare `.exe`, and the plugin's Windows `install()` would run it
//! as an NSIS installer, so there we only use the verified `download()` and
//! replace the exe ourselves (`replace_exe`).

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The repository whose releases are followed: `KIVI_UPDATE_REPO=owner/repo` at
/// build time (the fork's Actions sets it), `XyleMora/KiVi` otherwise.
const REPO: &str = match option_env!("KIVI_UPDATE_REPO") {
    Some(r) if !r.is_empty() => r,
    _ => "XyleMora/KiVi",
};

/// The minisign public key (the contents of the `.pub` file from
/// `cargo tauri signer generate`), `KIVI_UPDATER_PUBKEY` at build time.
fn pubkey() -> Option<&'static str> {
    option_env!("KIVI_UPDATER_PUBKEY")
        .map(str::trim)
        .filter(|k| !k.is_empty())
}

/// The updater plugin, or `None` in builds without a public key (the plugin
/// can't verify anything then, so it isn't registered and every command says
/// updates are off). `tauri.conf.json` carries an empty `plugins.updater`
/// section only because the plugin insists on one; the key comes from here.
pub fn plugin() -> Option<tauri::plugin::TauriPlugin<tauri::Wry, tauri_plugin_updater::Config>> {
    pubkey().map(|k| tauri_plugin_updater::Builder::new().pubkey(k).build())
}

/// The update found by the last `update_check`, waiting for `update_install`.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    enabled: bool,
    repo: &'static str,
    current: String,
    can_install: bool,
    reason: Option<String>,
}

#[derive(Serialize)]
pub struct Available {
    version: String,
    current: String,
    /// `YYYY-MM-DD`, when the feed has a publish date.
    date: Option<String>,
    /// The release's page on GitHub ("What's new", and the fallback download).
    url: String,
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Can the running copy be replaced by itself? `Err` carries the reason shown in
/// the dialog (where the primary button then opens the release page instead).
fn can_install() -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Development build".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if cfg!(target_os = "linux") {
        return linux_can_install(std::env::var_os("APPIMAGE").map(PathBuf::from).as_deref());
    }
    if cfg!(target_os = "macos") {
        return macos_can_install(&exe);
    }
    // Windows: the exe's folder must allow creating (and so renaming) files.
    writable_dir(exe.parent().unwrap_or(Path::new(".")))
        .map_err(|_| format!("No permission to replace {}", exe.display()))
}

/// Only an AppImage can swap itself: `$APPIMAGE` is the file being run (the
/// executable itself lives in the AppImage's temporary mount).
fn linux_can_install(appimage: Option<&Path>) -> Result<(), String> {
    let Some(file) = appimage else {
        return Err("This copy of KiVi isn't an AppImage".into());
    };
    writable_dir(file.parent().unwrap_or(Path::new(".")))
        .map_err(|_| format!("No permission to replace {}", file.display()))
}

/// The `.app` containing `exe` (`X.app/Contents/MacOS/<binary>`), if it is in one.
fn app_bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    let right = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && app.extension()? == "app";
    right.then(|| app.to_path_buf())
}

fn macos_can_install(exe: &Path) -> Result<(), String> {
    let Some(app) = app_bundle_of(exe) else {
        return Err("This copy of KiVi isn't an app bundle".into());
    };
    writable_dir(app.parent().unwrap_or(Path::new("/")))
        .map_err(|_| format!("No permission to replace {}", app.display()))
}

/// Writable in the way an update needs: a file can be created (and removed) there.
fn writable_dir(dir: &Path) -> io::Result<()> {
    let probe = dir.join(format!(".kivi-write-test-{}", std::process::id()));
    std::fs::write(&probe, b"")?;
    std::fs::remove_file(&probe)
}

/// `<path>` with `suffix` appended to its file name (`KiVi.exe` + `.new`).
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Replace `target` (a running executable, which Windows lets you rename but not
/// overwrite) with `bytes`: write `<target>.new`, move `target` to `<target>.old`,
/// move the new file in; if that last step fails the old one goes back. The `.old`
/// can't be deleted while it runs, so `remove_old` clears it at the next start.
pub fn replace_exe(target: &Path, bytes: &[u8]) -> io::Result<()> {
    replace_exe_with(target, bytes, |from, to| std::fs::rename(from, to))
}

/// `replace_exe` with the rename step injectable, so the rollback can be tested.
fn replace_exe_with(
    target: &Path,
    bytes: &[u8],
    rename: impl Fn(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    let new = with_suffix(target, ".new");
    let old = with_suffix(target, ".old");
    std::fs::write(&new, bytes)?; // closed again when write returns
    let result = (|| {
        if old.exists() {
            std::fs::remove_file(&old)?;
        }
        rename(target, &old)?;
        if let Err(e) = rename(&new, target) {
            let _ = std::fs::rename(&old, target);
            return Err(e);
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&new);
    }
    result
}

/// Best-effort removal of the previous version left by `replace_exe`.
pub fn remove_old(target: &Path) {
    let _ = std::fs::remove_file(with_suffix(target, ".old"));
}

/// At start-up on Windows: clear the `.old` of an earlier update.
pub fn cleanup() {
    if cfg!(windows) {
        if let Ok(exe) = std::env::current_exe() {
            remove_old(&exe);
        }
    }
}

/// A Windows executable starts with "MZ"; anything else is a wrong file in the feed.
fn is_pe(bytes: &[u8]) -> bool {
    bytes.starts_with(b"MZ")
}

#[tauri::command]
pub async fn update_info(app: AppHandle) -> Info {
    let (can_install, reason) = match can_install() {
        Ok(()) => (true, None),
        Err(r) => (false, Some(r)),
    };
    Info {
        enabled: pubkey().is_some(),
        repo: REPO,
        current: app.package_info().version.to_string(),
        can_install,
        reason,
    }
}

/// Look for a newer release. `None` = up to date; an error (offline, no
/// `latest.json` yet, no entry for this OS) is the caller's to log and retry.
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>) -> Result<Option<Available>, String> {
    if pubkey().is_none() {
        return Err("Updates are off in this build".into());
    }
    let url = format!("https://github.com/{REPO}/releases/latest/download/latest.json");
    let mut builder = app
        .updater_builder()
        .endpoints(vec![url.parse().map_err(|e| format!("{e}"))?])
        .map_err(|e| e.to_string())?;
    // In an AppImage the running executable is inside its temporary mount, so
    // say which file to replace.
    if cfg!(target_os = "linux") {
        if let Some(file) = std::env::var_os("APPIMAGE") {
            builder = builder.executable_path(file);
        }
    }
    let found = builder
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let mut slot = pending.0.lock().map_err(|e| e.to_string())?;
    *slot = found.clone();
    Ok(found.map(|u| Available {
        url: format!("https://github.com/{REPO}/releases/tag/v{}", u.version),
        date: u.date.map(|d| d.date().to_string()),
        current: u.current_version,
        version: u.version,
    }))
}

/// Download the pending update (emitting `update-progress`), verify it, install
/// it and restart. Only returns on failure.
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    if let Err(reason) = can_install() {
        return Err(reason);
    }
    let update = pending
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("No update to install")?;

    let mut downloaded = 0u64;
    let mut last = Instant::now() - Duration::from_secs(1);
    let progress = app.clone();
    // `download` checks the signature against the public key before returning.
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                if last.elapsed() >= Duration::from_millis(100) {
                    last = Instant::now();
                    let _ = progress.emit("update-progress", Progress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("update-progress", Progress { downloaded: bytes.len() as u64, total: Some(bytes.len() as u64) });

    if cfg!(windows) {
        if !is_pe(&bytes) {
            return Err("The downloaded file isn't a Windows program".into());
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let target = exe.clone();
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        tauri::async_runtime::spawn_blocking(move || replace_exe(&target, &bytes))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Couldn't replace {}: {e}", exe.display()))?;
        // After the rename the running process's own path may read as `.old`, so
        // start the new file by its real path instead of `app.restart()`.
        std::process::Command::new(&exe).args(args).spawn().map_err(|e| e.to_string())?;
        app.exit(0);
        return Ok(());
    }

    tauri::async_runtime::spawn_blocking(move || update.install(&bytes))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kivi-update-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn replace_exe_swaps_and_keeps_the_old_one() {
        let d = dir("swap");
        let exe = d.join("KiVi.exe");
        std::fs::write(&exe, b"old").unwrap();
        replace_exe(&exe, b"new").unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"new");
        assert_eq!(std::fs::read(d.join("KiVi.exe.old")).unwrap(), b"old");
        assert!(!d.join("KiVi.exe.new").exists());
        remove_old(&exe);
        assert!(!d.join("KiVi.exe.old").exists());
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn replace_exe_overwrites_a_leftover_old() {
        let d = dir("leftover");
        let exe = d.join("KiVi.exe");
        std::fs::write(&exe, b"v2").unwrap();
        std::fs::write(d.join("KiVi.exe.old"), b"v1").unwrap();
        replace_exe(&exe, b"v3").unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"v3");
        assert_eq!(std::fs::read(d.join("KiVi.exe.old")).unwrap(), b"v2");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn replace_exe_changes_nothing_when_the_new_file_cannot_be_written() {
        let d = dir("nowrite");
        let exe = d.join("KiVi.exe");
        std::fs::write(&exe, b"old").unwrap();
        // A directory in the way of `.new` makes the write fail before anything moves.
        std::fs::create_dir(d.join("KiVi.exe.new")).unwrap();
        assert!(replace_exe(&exe, b"new").is_err());
        assert_eq!(std::fs::read(&exe).unwrap(), b"old");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn replace_exe_puts_the_old_one_back_when_the_last_rename_fails() {
        let d = dir("rollback");
        let exe = d.join("KiVi.exe");
        std::fs::write(&exe, b"old").unwrap();
        // Let `target → .old` through, fail `.new → target`.
        let result = replace_exe_with(&exe, b"new", |from, to| {
            if to == exe {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"))
            } else {
                std::fs::rename(from, to)
            }
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(&exe).unwrap(), b"old", "old version is back");
        assert!(!d.join("KiVi.exe.new").exists(), "half-written file removed");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn only_mz_files_count_as_windows_programs() {
        assert!(is_pe(b"MZ\x90\x00"));
        assert!(!is_pe(b"\x7fELF"));
        assert!(!is_pe(b"<html>"));
        assert!(!is_pe(b""));
    }

    #[test]
    fn finds_the_app_bundle_of_an_executable() {
        let exe = Path::new("/Applications/KiVi.app/Contents/MacOS/kivi-desktop");
        assert_eq!(app_bundle_of(exe), Some(PathBuf::from("/Applications/KiVi.app")));
        assert_eq!(app_bundle_of(Path::new("/x/target/release/kivi-desktop")), None);
        assert_eq!(app_bundle_of(Path::new("/x/Foo/Contents/MacOS/b")), None);
    }

    #[test]
    fn macos_reasons() {
        let d = dir("mac");
        let bundled = d.join("KiVi.app/Contents/MacOS");
        std::fs::create_dir_all(&bundled).unwrap();
        assert_eq!(macos_can_install(&bundled.join("kivi-desktop")), Ok(()));
        let err = macos_can_install(Path::new("/x/target/release/kivi-desktop")).unwrap_err();
        assert!(err.contains("app bundle"), "{err}");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn linux_reasons() {
        let err = linux_can_install(None).unwrap_err();
        assert!(err.contains("isn't an AppImage"), "{err}");
        let d = dir("linux");
        assert_eq!(linux_can_install(Some(&d.join("KiVi.AppImage"))), Ok(()));
        let err = linux_can_install(Some(Path::new("/nonexistent-kivi/KiVi.AppImage"))).unwrap_err();
        assert!(err.contains("No permission"), "{err}");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn writable_dir_leaves_nothing_behind() {
        let d = dir("probe");
        writable_dir(&d).unwrap();
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0);
        assert!(writable_dir(&d.join("missing")).is_err());
        std::fs::remove_dir_all(d).unwrap();
    }
}
