#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;
mod terminal;
mod workspace;

use sidecar::{Connection, Sidecar};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, State, WebviewWindowBuilder};
use terminal::Terminals;
use workspace::Workspace;

#[tauri::command]
async fn get_core_connection(
    app: tauri::AppHandle,
    sidecar: State<'_, Arc<Sidecar>>,
) -> Result<Connection, String> {
    let sidecar = Arc::clone(&sidecar);
    tauri::async_runtime::spawn_blocking(move || sidecar.connect(&app))
        .await
        .map_err(|_| "Could not start the local orchestrator.".to_owned())?
}

// GUI apps on macOS and Windows often miss user-installed CLI folders from a login shell PATH.
fn local_path(app: &tauri::AppHandle) -> Option<OsString> {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .iter()
        .flat_map(std::env::split_paths)
        .filter(|path| path.is_absolute())
        .collect();
    if let Ok(home) = app.path().home_dir() {
        #[cfg(unix)]
        paths.extend(
            [".local/bin", ".bun/bin", ".cargo/bin", "bin"]
                .map(|relative| home.join(relative))
                .into_iter(),
        );
        #[cfg(windows)]
        paths.extend(
            [".bun\\bin", ".cargo\\bin", ".local\\bin"]
                .map(|relative| home.join(relative))
                .into_iter(),
        );
    }
    #[cfg(unix)]
    paths.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local_appdata) = std::env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(local_appdata);
            paths.push(base.join("Programs").join("Ollama"));
            paths.push(base.join("Microsoft").join("WindowsApps"));
        }
    }
    std::env::join_paths(paths).ok()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Sidecar::default()))
        .manage(Arc::new(Terminals::default()))
        .manage(Workspace::default())
        .invoke_handler(tauri::generate_handler![
            get_core_connection,
            workspace::select_workspace,
            workspace::activate_workspace,
            terminal::pty_open,
            terminal::pty_write,
            terminal::pty_resize,
            terminal::pty_close
        ])
        .setup(|app| {
            let window_config = &app.config().app.windows[0];
            WebviewWindowBuilder::from_config(app, window_config)?
                .on_navigation(|url| {
                    let scheme = url.scheme();
                    let host = url.host_str();
                    let bundled = (scheme == "tauri" && host == Some("localhost"))
                        || ((scheme == "http" || scheme == "https")
                            && host == Some("tauri.localhost"));
                    let dev = !cfg!(feature = "custom-protocol")
                        && scheme == "http"
                        && host == Some("127.0.0.1")
                        && url.port() == Some(1420);
                    bundled || dev
                })
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not initialize Uya.");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            app.state::<Arc<Terminals>>().shutdown();
            app.state::<Arc<Sidecar>>().shutdown();
        }
    });
}
