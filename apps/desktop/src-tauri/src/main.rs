#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;
mod terminal;
mod updater;
mod workspace;

use sidecar::{Connection, Sidecar};
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Command;
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

fn validate_external_url(raw: &str) -> Result<String, String> {
    if raw.is_empty() || raw.len() > 2048 || raw.bytes().any(|byte| byte.is_ascii_control()) {
        return Err("The URL is empty, too long, or contains control characters.".into());
    }
    let url = tauri::Url::parse(raw).map_err(|_| "Enter a valid HTTP or HTTPS URL.")?;
    if !matches!(url.scheme(), "http" | "https") || !url.has_host() {
        return Err("Only HTTP and HTTPS URLs with a host can be opened.".into());
    }
    Ok(url.into())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let validated = validate_external_url(&url)?;
    #[cfg(target_os = "macos")]
    let child = Command::new("open").arg("--").arg(&validated).spawn();
    #[cfg(windows)]
    let child = Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &validated])
        .spawn();
    #[cfg(not(any(target_os = "macos", windows)))]
    let child = Command::new("xdg-open").arg(&validated).spawn();

    let mut child = child.map_err(|_| "Could not open the URL in the default browser.")?;
    // Reap the launcher in the background.
    drop(tauri::async_runtime::spawn_blocking(move || child.wait()));
    Ok(())
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
            open_external_url,
            updater::get_app_update_info,
            #[cfg(any(target_os = "macos", windows))]
            updater::prepare_app_update,
            #[cfg(any(target_os = "macos", windows))]
            updater::install_app_update,
            workspace::select_workspace,
            workspace::list_recent_workspaces,
            workspace::prepare_recent_workspace,
            workspace::activate_workspace,
            terminal::pty_open,
            terminal::pty_write,
            terminal::pty_resize,
            terminal::pty_close
        ])
        .setup(|app| {
            #[cfg(any(target_os = "macos", windows))]
            updater::configure(app)?;
            let window_config = &app.config().app.windows[0];
            let window = WebviewWindowBuilder::from_config(app, window_config)?;
            #[cfg(target_os = "macos")]
            let window = window
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            window
                .on_navigation(|url| {
                    let scheme = url.scheme();
                    let host = url.host_str();
                    let bundled = (scheme == "tauri" && host == Some("localhost"))
                        || ((scheme == "http" || scheme == "https")
                            && host == Some("tauri.localhost"));
                    let dev = tauri::is_dev()
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
            shutdown_native_services(app);
        }
    });
}

fn shutdown_native_services(app: &tauri::AppHandle) {
    app.state::<Arc<Terminals>>().shutdown();
    app.state::<Arc<Sidecar>>().shutdown();
}

#[cfg(test)]
mod tests {
    use super::validate_external_url;

    #[test]
    fn external_urls_accept_http_and_https() {
        assert_eq!(
            validate_external_url("http://localhost:1420/").unwrap(),
            "http://localhost:1420/"
        );
        assert_eq!(
            validate_external_url("HTTPS://Example.com/a b").unwrap(),
            "https://example.com/a%20b"
        );
    }

    #[test]
    fn external_urls_reject_other_schemes_and_missing_or_invalid_hosts() {
        for url in [
            "",
            "file:///tmp/example",
            "javascript:alert(1)",
            "data:text/plain,example",
            "mailto:example@example.com",
            "https://",
            "http://?query",
            "https://bad host/",
            "example.com",
        ] {
            assert!(validate_external_url(url).is_err(), "accepted {url:?}");
        }
    }

    #[test]
    fn external_urls_reject_ascii_controls_and_enforce_the_length_limit() {
        for control in (0..=0x1f).chain([0x7f]) {
            let url = format!("https://example.com/{}", char::from(control));
            assert!(validate_external_url(&url).is_err(), "accepted {url:?}");
        }
        let base = "https://example.com/";
        let mut url = format!("{base}{}", "a".repeat(2048 - base.len()));
        assert!(validate_external_url(&url).is_ok());
        url.push('a');
        assert!(validate_external_url(&url).is_err());
    }
}
