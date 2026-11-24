use serde::Serialize;
use tauri::{AppHandle, Manager};

#[cfg(any(target_os = "macos", windows))]
use {
    crate::{shutdown_native_services, Terminals},
    std::{sync::Arc, time::Duration},
    tauri::{async_runtime, App},
    tauri_plugin_updater::{Update, UpdaterExt},
};

#[derive(Serialize)]
pub struct AppUpdateInfo {
    version: String,
    enabled: bool,
}

#[tauri::command]
pub fn get_app_update_info(app: AppHandle) -> AppUpdateInfo {
    AppUpdateInfo {
        version: app.package_info().version.to_string(),
        enabled: cfg!(any(target_os = "macos", windows))
            && app.config().plugins.0.contains_key("updater"),
    }
}

#[cfg(any(target_os = "macos", windows))]
#[derive(Default)]
struct PendingUpdate(async_runtime::Mutex<Option<Arc<PreparedUpdate>>>);

#[cfg(any(target_os = "macos", windows))]
struct PreparedUpdate {
    update: Update,
    bytes: Vec<u8>,
}

#[cfg(any(target_os = "macos", windows))]
pub fn configure(app: &App) -> tauri::Result<()> {
    if app.config().plugins.0.contains_key("updater") {
        app.handle()
            .plugin(tauri_plugin_updater::Builder::new().build())?;
        app.manage(PendingUpdate::default());
    }
    Ok(())
}

#[cfg(any(target_os = "macos", windows))]
#[tauri::command]
pub async fn prepare_app_update(app: AppHandle) -> Result<Option<String>, String> {
    let Some(state) = app.try_state::<PendingUpdate>() else {
        return Ok(None);
    };
    let mut pending = state.0.lock().await;
    if let Some(ready) = pending.as_ref() {
        return Ok(Some(ready.update.version.clone()));
    }

    let builder = app.updater_builder().timeout(Duration::from_secs(15));
    #[cfg(windows)]
    let builder = {
        let app = app.clone();
        // The Windows updater exits directly and bypasses RunEvent::Exit.
        builder.on_before_exit(move || shutdown_native_services(&app))
    };
    let updater = builder
        .build()
        .map_err(|_| "Could not initialize the updater.".to_owned())?;
    let Some(mut update) = updater
        .check()
        .await
        .map_err(|_| "Could not check for updates.".to_owned())?
    else {
        return Ok(None);
    };

    if update.download_url.scheme() != "https" {
        return Err("The update download must use HTTPS.".into());
    }
    update.timeout = Some(Duration::from_secs(600));
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|_| "Could not download or verify the update.".to_owned())?;
    let version = update.version.clone();
    *pending = Some(Arc::new(PreparedUpdate { update, bytes }));
    Ok(Some(version))
}

#[cfg(any(target_os = "macos", windows))]
#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallStatus {
    TerminalsOpen,
}

#[cfg(any(target_os = "macos", windows))]
#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    version: String,
    allow_terminal_shutdown: bool,
) -> Result<Option<InstallStatus>, String> {
    let state = app
        .try_state::<PendingUpdate>()
        .ok_or("Updates are unavailable in this build.")?;
    let mut pending = state.0.lock().await;
    let ready = pending
        .as_ref()
        .filter(|ready| ready.update.version == version)
        .cloned()
        .ok_or("This update is no longer ready to install.")?;

    let app = app.clone();
    let status = async_runtime::spawn_blocking(move || {
        let terminals = app.state::<Arc<Terminals>>();
        if !terminals.block_for_update(allow_terminal_shutdown) {
            return Ok(Some(InstallStatus::TerminalsOpen));
        }
        if ready.update.install(&ready.bytes).is_err() {
            terminals.resume_after_update_failure();
            return Err("Could not install the update.".to_owned());
        }

        #[cfg(target_os = "macos")]
        {
            shutdown_native_services(&app);
            app.request_restart();
        }
        Ok(None)
    })
    .await
    .map_err(|_| "Could not finish installing the update.".to_owned())??;
    if status.is_none() {
        *pending = None;
    }
    Ok(status)
}
