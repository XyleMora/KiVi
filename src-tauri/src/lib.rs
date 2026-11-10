//! KiVi desktop: the web viewer in a native window, plus what a browser can't do —
//! reading a local project folder, reloading when KiCad saves, opening it in KiCad,
//! and GitHub sign-in.

mod git;
mod git_http;
mod kicad;
mod picker;
mod terminal;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde_json::Value;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, State};

/// The local folder the window is showing; file reads are limited to it.
#[derive(Default)]
struct Workspace {
    root: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

const MAX_FILES: usize = 50_000;
/// Files whose change means the view should reload.
const WATCHED_EXT: &[&str] = &["kicad_pro", "kicad_sch", "kicad_pcb", "kicad_wks", "wrl", "step", "stp"];

fn skip_dir(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "target") || name.ends_with("-backups")
}

/// "a/b/c.kicad_pcb" relative to `root`, with forward slashes.
fn rel_path(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    if rel.components().any(|c| skip_dir(&c.as_os_str().to_string_lossy())) {
        return None;
    }
    Some(rel.to_string_lossy().replace('\\', "/"))
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>, depth: usize) {
    if depth > 16 || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if !skip_dir(&entry.file_name().to_string_lossy()) {
                walk(root, &path, out, depth + 1);
            }
        } else if let Some(rel) = rel_path(root, &path) {
            out.push(rel);
        }
    }
}

pub(crate) fn list(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    walk(root, root, &mut files, 0);
    files.sort();
    files
}

/// Show `path`: list its files and start watching it (replacing the previous folder).
#[tauri::command]
fn open_folder(path: String, ws: State<Workspace>, app: AppHandle) -> Result<Vec<String>, String> {
    let mut root = std::fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    if root.is_file() {
        root.pop(); // a .kicad_pro / .kicad_pcb: its folder
    }
    let files = list(&root);

    let watch_root = root.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(500), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut changed: Vec<String> = events
            .iter()
            .filter(|e| e.path.extension().is_some_and(|x| WATCHED_EXT.contains(&x.to_string_lossy().to_lowercase().as_str())))
            .filter_map(|e| rel_path(&watch_root, &e.path))
            .collect();
        changed.sort();
        changed.dedup();
        if !changed.is_empty() {
            let _ = app.emit("folder-changed", changed);
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer.watcher().watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;

    *ws.watcher.lock().unwrap() = Some(debouncer);
    *ws.root.lock().unwrap() = Some(root);
    Ok(files)
}

/// Files of the open folder (after a change).
#[tauri::command]
fn list_folder(ws: State<Workspace>) -> Result<Vec<String>, String> {
    let root = ws.root.lock().unwrap().clone().ok_or("no folder open")?;
    Ok(list(&root))
}

/// A file of the open folder, as raw bytes.
#[tauri::command]
fn read_file(path: String, ws: State<Workspace>) -> Result<Response, String> {
    let root = ws.root.lock().unwrap().clone().ok_or("no folder open")?;
    let full = std::fs::canonicalize(root.join(&path)).map_err(|e| format!("{path}: {e}"))?;
    if !full.starts_with(&root) {
        return Err(format!("{path}: outside the open folder"));
    }
    std::fs::read(&full).map(Response::new).map_err(|e| format!("{path}: {e}"))
}

// ---- 3D model folders ------------------------------------------------------------
// Folders from the model sources in Settings, such as KiCad's own library
// (/usr/share/kicad/3dmodels). They aren't the open folder, so reads are checked
// separately: only model files, and only inside the folder asked for.

const MODEL_EXT: &[&str] = &["wrl", "step", "stp"];

fn is_model(path: &Path) -> bool {
    path.extension().is_some_and(|x| MODEL_EXT.contains(&x.to_string_lossy().to_lowercase().as_str()))
}

/// The folder a model source names, with a leading `~` for the home folder.
fn model_dir(dir: &str) -> Result<PathBuf, String> {
    let home = || std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let path = match dir.strip_prefix("~") {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            home().ok_or("no home folder")?.join(rest.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(dir),
    };
    let root = std::fs::canonicalize(&path).map_err(|e| format!("{dir}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("{dir}: not a folder"));
    }
    Ok(root)
}

/// The model files in a model folder, relative with forward slashes.
#[tauri::command]
fn list_model_dir(dir: String) -> Result<Vec<String>, String> {
    let root = model_dir(&dir)?;
    Ok(list(&root).into_iter().filter(|p| is_model(Path::new(p))).collect())
}

/// One model file from a model folder (raw bytes).
#[tauri::command]
fn read_model_file(dir: String, path: String) -> Result<Response, String> {
    let root = model_dir(&dir)?;
    let full = std::fs::canonicalize(root.join(&path)).map_err(|e| format!("{path}: {e}"))?;
    if !full.starts_with(&root) || !is_model(&full) {
        return Err(format!("{path}: not a 3D model in {dir}"));
    }
    std::fs::read(&full).map(Response::new).map_err(|e| format!("{path}: {e}"))
}

// ---- local projects (the gallery's own folders) -----------------------------------
// Folders the user added to the project gallery with "+". Like model folders,
// they aren't the open folder: listing and reads are limited to KiCad files.

const KICAD_EXT: &[&str] = &["kicad_pro", "kicad_sch", "kicad_pcb"];

fn is_kicad(path: &Path) -> bool {
    path.extension().is_some_and(|x| KICAD_EXT.contains(&x.to_string_lossy().to_lowercase().as_str()))
}

#[derive(serde::Serialize)]
struct KicadFile {
    path: String,
    size: u64,
    /// Last change, in seconds since 1970.
    modified: u64,
}

/// The KiCad design files in a project folder, with size and change time.
#[tauri::command]
fn scan_kicad_folder(dir: String) -> Result<Vec<KicadFile>, String> {
    let root = model_dir(&dir)?;
    Ok(list(&root)
        .into_iter()
        .filter(|p| is_kicad(Path::new(p)))
        .filter_map(|p| {
            let meta = std::fs::metadata(root.join(&p)).ok()?;
            let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
            Some(KicadFile { path: p, size: meta.len(), modified })
        })
        .collect())
}

/// One KiCad design file from a project folder (raw bytes), for its thumbnail.
#[tauri::command]
fn read_kicad_file(dir: String, path: String) -> Result<Response, String> {
    let root = model_dir(&dir)?;
    let full = std::fs::canonicalize(root.join(&path)).map_err(|e| format!("{path}: {e}"))?;
    if !full.starts_with(&root) || !is_kicad(&full) {
        return Err(format!("{path}: not a KiCad file in {dir}"));
    }
    std::fs::read(&full).map(Response::new).map_err(|e| format!("{path}: {e}"))
}

/// Folder given on the command line (`kivi-desktop ~/hw/board` or a file inside it).
#[tauri::command]
fn startup_folder() -> Option<String> {
    let arg = std::env::args().skip(1).find(|a| !a.starts_with('-'))?;
    Path::new(&arg).exists().then_some(arg)
}

// ---- forge sign-in (OAuth device flow) ------------------------------------------
// github.com/login/* sends no CORS headers, so the web page can't call it itself;
// gitlab.com's /oauth does, but one path for every forge is simpler. Device-flow
// tokens refresh without a client secret, so no server is needed. Each forge's
// steps (which URL, which fields) live in its adapter (src/forge/*.js).

/// The only addresses `oauth_post` sends to: each forge's device-code and token endpoints.
const OAUTH_URLS: &[&str] = &[
    "https://github.com/login/device/code",
    "https://github.com/login/oauth/access_token",
    "https://gitlab.com/oauth/authorize_device",
    "https://gitlab.com/oauth/token",
];

/// Sign-in settings baked in at build time, per forge id:
/// `KIVI_GITHUB_CLIENT_ID=Iv23… KIVI_GITHUB_APP_SLUG=… KIVI_GITLAB_CLIENT_ID=… cargo tauri build`.
#[tauri::command]
fn forge_build_config() -> Value {
    let env = |v: Option<&'static str>| v.filter(|s| !s.is_empty());
    serde_json::json!({
        "github": { "clientId": env(option_env!("KIVI_GITHUB_CLIENT_ID")), "appSlug": env(option_env!("KIVI_GITHUB_APP_SLUG")) },
        "gitlab": { "clientId": env(option_env!("KIVI_GITLAB_CLIENT_ID")) },
    })
}

/// POST a form to a forge's OAuth endpoint and return its JSON reply, errors included
/// (`{"error": "authorization_pending"}` comes with HTTP 400 on some forges).
#[tauri::command]
async fn oauth_post(url: String, form: std::collections::HashMap<String, String>) -> Result<Value, String> {
    if !OAUTH_URLS.contains(&url.as_str()) {
        return Err(format!("not a sign-in address: {url}"));
    }
    let res = reqwest::Client::new()
        .post(&url)
        .header("Accept", "application/json")
        .header("User-Agent", "KiVi-desktop")
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    res.json().await.map_err(|e| format!("HTTP {status}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    picker::use_portal(); // before any other thread starts
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Workspace::default())
        .manage(terminal::imp::Terminals::default())
        .invoke_handler(tauri::generate_handler![
            picker::pick_folder,
            terminal::imp::term_open,
            terminal::imp::term_write,
            terminal::imp::term_resize,
            terminal::imp::term_attach,
            terminal::imp::term_close,
            open_folder,
            list_folder,
            read_file,
            list_model_dir,
            read_model_file,
            scan_kicad_folder,
            read_kicad_file,
            kicad::kicad_inspect,
            kicad::kicad_open,
            git::git_info,
            git::git_status,
            git::git_clone,
            git::git_create_branch,
            git::git_local_changes,
            git::git_read,
            git::git_list,
            git::git_fetch,
            git::git_commit,
            git::git_push,
            git::git_pull,
            git::git_move_commits,
            git::git_remote_state,
            git::git_branches,
            git::git_switch_branch,
            git::git_link_remote,
            git::git_init,
            git::git_log,
            startup_folder,
            forge_build_config,
            oauth_post
        ])
        .run(tauri::generate_context!())
        .expect("error while running KiVi");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A model folder with a model, a non-model file and a model outside it.
    fn fixture() -> PathBuf {
        let base = std::env::temp_dir().join(format!("kivi-model-dir-{}", std::process::id()));
        let lib = base.join("lib").join("Resistor_SMD.3dshapes");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("R_0402.step"), b"step").unwrap();
        std::fs::write(lib.join("notes.txt"), b"text").unwrap();
        std::fs::write(base.join("outside.step"), b"outside").unwrap();
        base
    }

    #[test]
    fn model_folders_hand_out_only_their_model_files() {
        let base = fixture();
        let dir = base.join("lib").to_string_lossy().into_owned();
        assert_eq!(list_model_dir(dir.clone()).unwrap(), vec!["Resistor_SMD.3dshapes/R_0402.step"]);
        assert!(read_model_file(dir.clone(), "Resistor_SMD.3dshapes/R_0402.step".into()).is_ok());
        assert!(read_model_file(dir.clone(), "Resistor_SMD.3dshapes/notes.txt".into()).is_err());
        assert!(read_model_file(dir.clone(), "../outside.step".into()).is_err());
        assert!(list_model_dir(base.join("missing").to_string_lossy().into_owned()).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn project_folders_hand_out_only_kicad_files() {
        let base = std::env::temp_dir().join(format!("kivi-project-dir-{}", std::process::id()));
        let dir = base.join("board");
        std::fs::create_dir_all(dir.join("board-backups")).unwrap();
        std::fs::write(dir.join("board.kicad_pro"), "{}").unwrap();
        std::fs::write(dir.join("board.kicad_pcb"), "(kicad_pcb)").unwrap();
        std::fs::write(dir.join("notes.txt"), "text").unwrap();
        std::fs::write(dir.join("board-backups/old.kicad_pcb"), "old").unwrap();
        std::fs::write(base.join("outside.kicad_pcb"), "outside").unwrap();
        let d = dir.to_string_lossy().into_owned();
        let files = scan_kicad_folder(d.clone()).unwrap();
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["board.kicad_pcb", "board.kicad_pro"]);
        assert_eq!(files[0].size, 11);
        assert!(read_kicad_file(d.clone(), "board.kicad_pcb".into()).is_ok());
        assert!(read_kicad_file(d.clone(), "notes.txt".into()).is_err());
        assert!(read_kicad_file(d.clone(), "../outside.kicad_pcb".into()).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
}
