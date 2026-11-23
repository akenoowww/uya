use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

fn canonicalize_clean(path: &Path) -> std::io::Result<PathBuf> {
    let canonical = std::fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        if let Some(raw) = canonical.to_str() {
            if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
                return Ok(PathBuf::from(format!(r"\\{stripped}")));
            }
            if let Some(stripped) = raw.strip_prefix(r"\\?\") {
                return Ok(PathBuf::from(stripped));
            }
        }
    }
    Ok(canonical)
}

struct SelectedFolder {
    path: PathBuf,
    _watcher: Option<RecommendedWatcher>,
}

#[derive(Default)]
pub struct Workspace(Mutex<WorkspaceFolders>);

#[derive(Default)]
struct WorkspaceFolders {
    active: Option<SelectedFolder>,
    pending: Option<PathBuf>,
}

impl Workspace {
    fn activate(
        &self,
        requested: &Path,
        watch: impl FnOnce(&Path) -> Option<RecommendedWatcher>,
    ) -> Result<(), String> {
        let mut folders = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let path = folders
            .pending
            .take_if(|path| path.as_path() == requested)
            .ok_or("The selected project folder changed. Select it again.")?;
        let watcher = watch(&path);
        folders.active = Some(SelectedFolder {
            path,
            _watcher: watcher,
        });
        Ok(())
    }

    pub fn terminal_directory(
        &self,
        requested: Option<&Path>,
        home: impl FnOnce() -> Option<PathBuf>,
    ) -> Result<PathBuf, String> {
        let Some(requested) = requested else {
            return home()
                .filter(|path| path.is_absolute())
                .and_then(|path| canonicalize_clean(&path).ok())
                .filter(|path| path.is_dir())
                .ok_or_else(|| "The terminal needs an existing home folder.".into());
        };
        if !requested.is_absolute() {
            return Err("The terminal needs an absolute project folder path.".into());
        }
        let path = canonicalize_clean(requested)
            .map_err(|_| "The terminal needs an existing project folder.")?;
        let state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state
            .active
            .as_ref()
            .is_some_and(|selected| path.starts_with(&selected.path) && path.is_dir())
        {
            return Ok(path);
        }
        Err("Choose a terminal directory inside the open project folder.".into())
    }
}

#[tauri::command]
pub async fn select_workspace(
    window: WebviewWindow,
    state: State<'_, Workspace>,
) -> Result<Option<String>, String> {
    state
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .pending = None;
    let dialog_window = window.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        dialog_window
            .dialog()
            .file()
            .set_title("Open Project Folder")
            .set_parent(&dialog_window)
            .blocking_pick_folder()
    })
    .await
    .map_err(|_| "Could not open the native folder picker.")?;
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen.into_path().map_err(|_| "Choose a local folder.")?;
    let path = canonicalize_clean(&path).map_err(|_| "Could not open the selected folder.")?;
    let display_path = path
        .to_str()
        .ok_or("The selected folder path is not UTF-8.")?
        .to_owned();
    state
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .pending = Some(path);
    Ok(Some(display_path))
}

#[tauri::command]
pub async fn activate_workspace(
    window: WebviewWindow,
    state: State<'_, Workspace>,
    path: String,
) -> Result<(), String> {
    state.activate(Path::new(&path), |folder| {
        watch_folder(&window, folder).ok()
    })
}

fn watch_folder(window: &WebviewWindow, path: &Path) -> notify::Result<RecommendedWatcher> {
    let window = window.clone();
    let root = path.to_owned();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        let Ok(event) = event else { return };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        let has_source_change = event.paths.iter().any(|path| {
            path.strip_prefix(&root).is_ok_and(|relative| {
                !relative.components().any(|part| {
                    matches!(part, Component::Normal(name) if name == ".git" || name == "node_modules" || name == "target")
                })
            })
        });
        if has_source_change {
            let _ = window.emit("workspace-changed", &root);
        }
    })?;
    watcher.watch(path, RecursiveMode::Recursive)?;
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    #[test]
    fn terminal_uses_home_without_a_project_and_confines_explicit_paths() {
        let fixture =
            std::env::temp_dir().join(format!("uya-terminal-cwd-{}", std::process::id()));
        let _ = fs::remove_dir_all(&fixture);
        fs::create_dir(&fixture).unwrap();
        let home = fixture.join("home");
        let project = fixture.join("project");
        let subdirectory = project.join("src");
        fs::create_dir(&home).unwrap();
        fs::create_dir_all(&subdirectory).unwrap();
        let workspace = Workspace::default();

        assert_eq!(
            workspace
                .terminal_directory(None, || Some(home.clone()))
                .unwrap(),
            canonicalize_clean(&home).unwrap(),
        );
        assert!(workspace
            .terminal_directory(None, || Some(home.join("missing")))
            .is_err());
        assert!(workspace
            .terminal_directory(Some(&subdirectory), || Some(home.clone()))
            .is_err());

        let project = canonicalize_clean(&project).unwrap();
        workspace.0.lock().unwrap().pending = Some(project.clone());
        workspace.activate(&project, |_| None).unwrap();
        assert_eq!(
            workspace
                .terminal_directory(Some(&subdirectory), || panic!(
                    "explicit paths need no home lookup"
                ))
                .unwrap(),
            canonicalize_clean(&subdirectory).unwrap(),
        );
        #[cfg(unix)]
        {
            let escaped = project.join("outside");
            symlink(&home, &escaped).unwrap();
            workspace.0.lock().unwrap().pending = Some(canonicalize_clean(&home).unwrap());
            assert!(workspace.activate(&escaped, |_| None).is_err());
            assert!(workspace
                .terminal_directory(Some(&subdirectory), || panic!("project must remain active"))
                .is_ok());
            assert!(workspace
                .terminal_directory(Some(&escaped), || Some(home.clone()))
                .is_err());
        }
        assert!(workspace
            .terminal_directory(Some(Path::new("src")), || Some(home))
            .is_err());
        fs::remove_dir_all(fixture).unwrap();
    }
}
