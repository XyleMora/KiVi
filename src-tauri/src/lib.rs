//! KiVi desktop: the web viewer in a native window, plus what a browser can't do —
//! reading a local project folder, reloading when KiCad saves, and GitHub sign-in.

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

fn list(root: &Path) -> Vec<String> {
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

/// Folder given on the command line (`kivi-desktop ~/hw/board` or a file inside it).
#[tauri::command]
fn startup_folder() -> Option<String> {
    let arg = std::env::args().skip(1).find(|a| !a.starts_with('-'))?;
    Path::new(&arg).exists().then_some(arg)
}

// ---- GitHub sign-in (GitHub App, device flow) ----------------------------------
// github.com/login/* sends no CORS headers, so the web page can't call it itself.
// A GitHub App's user tokens expire after 8 h and come with a refresh token;
// device-flow tokens refresh without a client secret, so no server is needed.

/// GitHub App client ID baked in at build time (`KIVI_GITHUB_CLIENT_ID=Iv23… cargo tauri build`).
#[tauri::command]
fn github_client_id() -> Option<&'static str> {
    option_env!("KIVI_GITHUB_CLIENT_ID").filter(|s| !s.is_empty())
}

/// The App's URL name (github.com/apps/<slug>), for the "install on your repositories" link.
#[tauri::command]
fn github_app_slug() -> Option<&'static str> {
    option_env!("KIVI_GITHUB_APP_SLUG").filter(|s| !s.is_empty())
}

async fn github_form(url: &str, form: &[(&str, &str)]) -> Result<Value, String> {
    let res = reqwest::Client::new()
        .post(url)
        .header("Accept", "application/json")
        .header("User-Agent", "KiVi-desktop")
        .form(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body: Value = res.json().await.map_err(|e| format!("GitHub {status}: {e}"))?;
    Ok(body)
}

/// Step 1: a code for the user to enter at github.com/login/device.
#[tauri::command]
async fn github_device_start(client_id: String) -> Result<Value, String> {
    github_form("https://github.com/login/device/code", &[("client_id", &client_id)]).await
}

/// Step 2 (repeat every `interval` s): `access_token` (+ `expires_in`, `refresh_token`, `refresh_token_expires_in`), or `error` = authorization_pending / slow_down / expired_token / access_denied.
#[tauri::command]
async fn github_device_poll(client_id: String, device_code: String) -> Result<Value, String> {
    github_form(
        "https://github.com/login/oauth/access_token",
        &[("client_id", &client_id), ("device_code", &device_code), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")],
    )
    .await
}

/// A new token pair before the old one expires. The refresh token is single use.
#[tauri::command]
async fn github_device_refresh(client_id: String, refresh_token: String) -> Result<Value, String> {
    github_form(
        "https://github.com/login/oauth/access_token",
        &[("client_id", &client_id), ("refresh_token", &refresh_token), ("grant_type", "refresh_token")],
    )
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Workspace::default())
        .invoke_handler(tauri::generate_handler![
            open_folder,
            list_folder,
            read_file,
            startup_folder,
            github_client_id,
            github_app_slug,
            github_device_start,
            github_device_poll,
            github_device_refresh
        ])
        .run(tauri::generate_context!())
        .expect("error while running KiVi");
}
