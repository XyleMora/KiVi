//! The folder chooser. On Linux the dialog plugin's rfd is built for GTK's own
//! file dialog, which looks the same on every desktop. GTK's *native* chooser
//! goes through the XDG desktop portal instead, so the desktop's own dialog
//! appears (KDE Plasma: its Dolphin-style dialog; GNOME: Nautilus's), and
//! falls back to GTK's dialog by itself when no portal is running.
//! On Windows and macOS the dialog plugin already shows the system dialog:
//! this command refuses there and `pickFolder` (tauri.js) uses the plugin.

/// Make GTK 3 use the portal for native file choosers. GTK reads this once, on
/// the first chooser, and otherwise only uses the portal inside Flatpak or
/// Snap. Called at start-up, before any other thread exists (set_var isn't
/// thread-safe). Children don't inherit it: see `clean_child_env`.
#[cfg(target_os = "linux")]
pub fn use_portal() {
    if std::env::var_os("GTK_USE_PORTAL").is_none() {
        std::env::set_var("GTK_USE_PORTAL", "1");
        std::env::set_var("KIVI_SET_GTK_USE_PORTAL", "1");
    }
}

/// Undo `use_portal` for a program KiVi starts (KiCad).
pub fn clean_child_env(cmd: &mut std::process::Command) {
    if std::env::var_os("KIVI_SET_GTK_USE_PORTAL").is_some() {
        cmd.env_remove("GTK_USE_PORTAL").env_remove("KIVI_SET_GTK_USE_PORTAL");
    }
}

/// A folder picked by the user, or None when cancelled.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn pick_folder(window: tauri::WebviewWindow, title: String, default_path: Option<String>) -> Result<Option<String>, String> {
    // GTK only works on the main thread; the dialog runs its own loop there until closed.
    let (tx, rx) = std::sync::mpsc::channel();
    let w = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(run_dialog(&w, &title, default_path));
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "the folder chooser closed unexpectedly".to_string())
}

#[cfg(target_os = "linux")]
fn run_dialog(window: &tauri::WebviewWindow, title: &str, default_path: Option<String>) -> Option<String> {
    use gtk::prelude::*;
    let parent = window.gtk_window().ok();
    let dialog = gtk::FileChooserNative::new(Some(title), parent.as_ref(), gtk::FileChooserAction::SelectFolder, Some("Select"), Some("Cancel"));
    dialog.set_modal(true);
    if let Some(dir) = default_path.filter(|d| std::path::Path::new(d).is_dir()) {
        dialog.set_current_folder(&dir);
    }
    let picked = if dialog.run() == gtk::ResponseType::Accept { dialog.filename() } else { None };
    dialog.destroy();
    picked.map(|p| p.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub fn pick_folder(title: String, default_path: Option<String>) -> Result<Option<String>, String> {
    let _ = (title, default_path);
    Err("the dialog plugin shows the system's chooser here".into())
}
