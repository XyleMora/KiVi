//! Linking KiCad (Settings → KiCad): where its program is, which version it is,
//! and the path variables its 3D model paths use (${KICAD10_3DMODEL_DIR},
//! ${KICAD10_3RD_PARTY}, the user's own), so KiVi finds models where KiCad does;
//! and opening a project in it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Debug)]
pub struct KicadInfo {
    /// The `kicad` program (the project manager).
    program: String,
    /// "10.0.6", from `kicad-cli version`.
    version: String,
    /// Path variables → existing folders, as KiCad would expand them.
    vars: BTreeMap<String, String>,
}

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

/// The `kicad` program for what the user picked: the program itself, an
/// installation folder (`/usr`, `C:\Program Files\KiCad\10.0`, `KiCad.app`,
/// `/Applications/KiCad`) or its `bin` folder.
fn find_program(path: &Path) -> Option<PathBuf> {
    let is_kicad = |p: &Path| p.is_file() && p.file_stem().is_some_and(|s| s.eq_ignore_ascii_case("kicad"));
    if is_kicad(path) {
        return Some(path.to_path_buf());
    }
    let exe = format!("kicad{EXE}");
    [
        path.join(&exe),
        path.join("bin").join(&exe),
        path.join("Contents/MacOS/kicad"),
        path.join("KiCad.app/Contents/MacOS/kicad"),
    ]
    .into_iter()
    .find(|p| is_kicad(p))
}

/// KiCad's version from the `kicad-cli` next to the program (KiCad 7 and later).
fn version(program: &Path) -> Result<String, String> {
    let cli = program.with_file_name(format!("kicad-cli{EXE}"));
    let mut cmd = Command::new(&cli);
    cmd.arg("version").stdin(Stdio::null());
    outside_appimage(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
    }
    let out = cmd.output().map_err(|e| format!("{}: {e} (KiCad 7 or later is needed)", cli.display()))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let v = text.trim();
    if !out.status.success() || !v.starts_with(|c: char| c.is_ascii_digit()) {
        return Err(format!("{} didn't give a version", cli.display()));
    }
    Ok(v.to_string())
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// KiCad's per-version user folders: (settings, documents), e.g.
/// (~/.config/kicad/10.0, ~/.local/share/kicad/10.0) on Linux.
fn user_dirs(series: &str) -> Option<(PathBuf, PathBuf)> {
    let home = home()?;
    let config = if let Some(dir) = env_dir("KICAD_CONFIG_HOME") {
        dir
    } else if cfg!(windows) {
        env_dir("APPDATA").unwrap_or_else(|| home.join("AppData/Roaming")).join("kicad")
    } else if cfg!(target_os = "macos") {
        home.join("Library/Preferences/kicad")
    } else {
        env_dir("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config")).join("kicad")
    };
    let docs = if let Some(dir) = env_dir("KICAD_DOCUMENTS_HOME") {
        dir
    } else if cfg!(windows) || cfg!(target_os = "macos") {
        home.join("Documents/KiCad")
    } else {
        env_dir("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local/share")).join("kicad")
    };
    Some((config.join(series), docs.join(series)))
}

/// The library folder an installation ships its models in.
fn installed_models(program: &Path) -> Option<PathBuf> {
    let bin = program.parent()?; // …/bin, or KiCad.app/Contents/MacOS
    let prefix = bin.parent()?;
    [prefix.join("share/kicad/3dmodels"), prefix.join("SharedSupport/3dmodels"), PathBuf::from("/usr/share/kicad/3dmodels")]
        .into_iter()
        .find(|p| p.is_dir())
}

/// The variables in KiCad's own settings (Preferences → Configure Paths):
/// `environment.vars` in kicad_common.json, null when none were changed.
fn configured_vars(config: &Path) -> BTreeMap<String, String> {
    let Ok(text) = std::fs::read_to_string(config.join("kicad_common.json")) else { return BTreeMap::new() };
    let Ok(json) = serde_json::from_str::<Value>(&text) else { return BTreeMap::new() };
    json.pointer("/environment/vars")
        .and_then(Value::as_object)
        .map(|vars| vars.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
        .unwrap_or_default()
}

/// What KiCad expands its path variables to: the defaults for this installation,
/// then its settings, then the environment (which KiCad lets win too). Only
/// existing folders are kept; KIPRJMOD is the project's own and isn't one of them.
fn path_vars(program: &Path, version: &str, dirs: Option<(PathBuf, PathBuf)>) -> BTreeMap<String, String> {
    let major = version.split('.').next().unwrap_or("");
    let mut vars = BTreeMap::new();
    if let Some(models) = installed_models(program) {
        vars.insert(format!("KICAD{major}_3DMODEL_DIR"), models.to_string_lossy().into_owned());
    }
    if let Some((config, docs)) = dirs {
        vars.insert(format!("KICAD{major}_3RD_PARTY"), docs.join("3rdparty").to_string_lossy().into_owned());
        vars.extend(configured_vars(&config));
    }
    for (k, v) in vars.iter_mut() {
        if let Ok(env) = std::env::var(k) {
            *v = env;
        }
    }
    vars.retain(|k, v| k != "KIPRJMOD" && !v.contains("${") && Path::new(v).is_absolute() && Path::new(v).is_dir());
    vars
}

/// Check what the user picked in Settings and describe that KiCad.
#[tauri::command]
pub async fn kicad_inspect(path: String) -> Result<KicadInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let program = find_program(Path::new(path.trim())).ok_or_else(|| format!("No KiCad program in {path}"))?;
        let version = version(&program)?;
        let series = version.split('.').take(2).collect::<Vec<_>>().join(".");
        let vars = path_vars(&program, &version, user_dirs(&series));
        Ok(KicadInfo { program: program.to_string_lossy().into_owned(), version, vars })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a project (`.kicad_pro`) in the linked KiCad, without waiting for it.
#[tauri::command]
pub fn kicad_open(program: String, project: String) -> Result<(), String> {
    let program = find_program(Path::new(&program)).ok_or("KiCad isn't there any more: link it again in Settings")?;
    let project = PathBuf::from(&project);
    if !project.is_file() || !project.extension().is_some_and(|x| x.eq_ignore_ascii_case("kicad_pro")) {
        return Err(format!("{}: not a KiCad project file", project.display()));
    }
    // macOS: through Launch Services, so a running KiCad is reused as the Dock would.
    let app = program.ancestors().find(|p| p.extension().is_some_and(|x| x == "app"));
    let mut cmd = match app {
        Some(app) if cfg!(target_os = "macos") => {
            let mut c = Command::new("open");
            c.arg("-a").arg(app).arg(&project);
            c
        }
        _ => {
            let mut c = Command::new(&program);
            c.arg(&project);
            c
        }
    };
    if let Some(dir) = project.parent() {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    outside_appimage(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start KiCad: {e}"))?;
    std::thread::spawn(move || child.wait()); // reaped when it exits, so no zombie is left
    Ok(())
}

/// The AppImage's launcher points GTK, GIO and XDG_DATA_DIRS into the image
/// (`$APPDIR/usr/…`). KiCad must start with the system's own, so those entries
/// are dropped from what the child inherits (and KiVi's own GTK_USE_PORTAL, picker.rs).
/// Also used for the terminal's shell (terminal.rs).
pub(crate) fn outside_appimage(cmd: &mut Command) {
    crate::picker::clean_child_env(cmd);
    let Some(appdir) = std::env::var("APPDIR").ok().filter(|d| !d.is_empty()) else { return };
    for (k, v) in appimage_env_fixes(&appdir, std::env::vars()) {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
}

/// Variables to change (Some) or remove (None) so nothing points into `appdir`.
fn appimage_env_fixes(appdir: &str, env: impl Iterator<Item = (String, String)>) -> Vec<(String, Option<String>)> {
    let mut fixes = Vec::new();
    for (k, v) in env {
        // The launcher always sets GTK_THEME to Adwaita:dark or :light (the desktop's colour
        // scheme); KiCad should get the desktop's own theme instead.
        let launcher_theme = k == "GTK_THEME" && matches!(v.as_str(), "" | "Adwaita:dark" | "Adwaita:light");
        if matches!(k.as_str(), "APPDIR" | "APPIMAGE" | "ARGV0" | "OWD") || launcher_theme {
            fixes.push((k, None));
        } else if v.contains(appdir) {
            let kept: Vec<&str> = v.split(':').filter(|p| !p.is_empty() && !p.contains(appdir)).collect();
            fixes.push((k, (!kept.is_empty()).then(|| kept.join(":"))));
        }
    }
    fixes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kivi-kicad-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// An installation like Linux's /usr: bin/kicad, bin/kicad-cli, share/kicad/3dmodels.
    #[cfg(unix)]
    fn fake_install(name: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let prefix = temp(name);
        std::fs::create_dir_all(prefix.join("bin")).unwrap();
        std::fs::create_dir_all(prefix.join("share/kicad/3dmodels")).unwrap();
        std::fs::write(prefix.join("bin/kicad"), "#!/bin/sh\n").unwrap();
        std::fs::write(prefix.join("bin/kicad-cli"), "#!/bin/sh\necho 10.0.6\n").unwrap();
        for f in ["bin/kicad", "bin/kicad-cli"] {
            std::fs::set_permissions(prefix.join(f), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        prefix
    }

    #[cfg(unix)]
    #[test]
    fn finds_the_program_version_and_model_folders() {
        let prefix = fake_install("install");
        let program = prefix.join("bin/kicad");
        assert_eq!(find_program(&prefix), Some(program.clone()));
        assert_eq!(find_program(&prefix.join("bin")), Some(program.clone()));
        assert_eq!(find_program(&program), Some(program.clone()));
        assert_eq!(find_program(&prefix.join("share")), None);
        assert_eq!(version(&program).unwrap(), "10.0.6");

        // KiCad's settings: one changed library path, one variable of the user's own,
        // and one that doesn't exist (dropped).
        let config = temp("config");
        let docs = temp("docs");
        std::fs::create_dir_all(docs.join("3rdparty")).unwrap();
        let mine = temp("mine");
        let json = serde_json::json!({ "environment": { "vars": {
            "MY_MODELS": mine.to_string_lossy(), "GONE": "/nonexistent/kivi", "REL": "${KIPRJMOD}/x" } } });
        std::fs::write(config.join("kicad_common.json"), json.to_string()).unwrap();
        let vars = path_vars(&program, "10.0.6", Some((config.clone(), docs.clone())));
        let s = |p: PathBuf| p.to_string_lossy().into_owned();
        assert_eq!(
            vars.into_iter().collect::<Vec<_>>(),
            vec![
                ("KICAD10_3DMODEL_DIR".into(), s(prefix.join("share/kicad/3dmodels"))),
                ("KICAD10_3RD_PARTY".into(), s(docs.join("3rdparty"))),
                ("MY_MODELS".into(), s(mine.clone())),
            ]
        );
        // Unchanged settings ("vars": null) leave the defaults.
        std::fs::write(config.join("kicad_common.json"), r#"{"environment":{"vars":null}}"#).unwrap();
        assert_eq!(path_vars(&program, "10.0.6", Some((config.clone(), docs.clone()))).len(), 2);
        for d in [prefix, config, docs, mine] {
            std::fs::remove_dir_all(d).unwrap();
        }
    }

    #[test]
    fn open_refuses_anything_but_a_project_file() {
        let dir = temp("open");
        std::fs::write(dir.join("board.kicad_pcb"), "").unwrap();
        assert!(kicad_open(dir.join("missing/kicad").to_string_lossy().into(), dir.join("board.kicad_pcb").to_string_lossy().into()).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn open_refuses_a_board_file_with_a_real_program() {
        let prefix = fake_install("open-board");
        std::fs::write(prefix.join("board.kicad_pcb"), "").unwrap();
        let err = kicad_open(prefix.join("bin/kicad").to_string_lossy().into(), prefix.join("board.kicad_pcb").to_string_lossy().into()).unwrap_err();
        assert!(err.contains("not a KiCad project file"), "{err}");
        std::fs::remove_dir_all(prefix).unwrap();
    }

    #[test]
    fn appimage_entries_are_dropped_from_the_childs_environment() {
        let app = "/tmp/.mount_KiViXYZ";
        let env = [
            ("XDG_DATA_DIRS", "/tmp/.mount_KiViXYZ/usr/share:/usr/share:/usr/local/share"),
            ("GTK_PATH", "/tmp/.mount_KiViXYZ//usr/lib/gtk-3.0"),
            ("GTK_THEME", "Adwaita:dark"),
            ("APPDIR", app),
            ("HOME", "/home/me"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string()));
        assert_eq!(
            appimage_env_fixes(app, env.into_iter()),
            vec![
                ("XDG_DATA_DIRS".to_string(), Some("/usr/share:/usr/local/share".to_string())),
                ("GTK_PATH".to_string(), None),
                ("GTK_THEME".to_string(), None),
                ("APPDIR".to_string(), None),
            ]
        );
    }

    /// The KiCad installed on this machine, if any: `cargo test -- --ignored installed_kicad --nocapture`.
    #[test]
    #[ignore]
    fn installed_kicad() {
        let prefix = if cfg!(windows) { r"C:\Program Files\KiCad\10.0" } else { "/usr" };
        let info = tauri::async_runtime::block_on(kicad_inspect(prefix.into())).unwrap();
        println!("{info:#?}");
        assert!(info.vars.keys().any(|k| k.ends_with("_3DMODEL_DIR")));
    }

    /// Starts the installed KiCad on $KIVI_TEST_PROJECT and leaves it running, for a
    /// script to check (run it in the AppImage's environment to test outside_appimage).
    #[test]
    #[ignore]
    fn opens_installed_kicad() {
        let project = std::env::var("KIVI_TEST_PROJECT").expect("KIVI_TEST_PROJECT");
        kicad_open("/usr/bin/kicad".into(), project).unwrap();
    }
}
