use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::fs;
use std::io::ErrorKind;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const RECENT_WORKSPACE_LIMIT: usize = 10;
const PICK_FOLDER_FIRST: &str = "Choose this folder with the folder picker first.";

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

fn canonical_directory(path: &Path) -> Option<PathBuf> {
    canonicalize_clean(path).ok().filter(|path| path.is_dir())
}

fn recent_workspaces_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("recent_workspaces.json"))
        .map_err(|_| "Could not locate the application data folder.".into())
}

fn load_recent_workspaces(file: &Path) -> Result<Vec<String>, String> {
    let mut recent: Vec<String> = match fs::read(file) {
        // A damaged history grants no access. The next picker selection can rebuild it.
        Ok(contents) => serde_json::from_slice(&contents).unwrap_or_default(),
        Err(error) if error.kind() == ErrorKind::NotFound => Vec::new(),
        Err(_) => return Err("Could not read recent workspaces.".into()),
    };
    recent.truncate(RECENT_WORKSPACE_LIMIT);
    Ok(recent)
}

fn existing_recent_workspaces(file: &Path) -> Result<Vec<String>, String> {
    let mut recent = load_recent_workspaces(file)?;
    recent.retain(|path| {
        canonical_directory(Path::new(path))
            .is_some_and(|resolved| resolved.to_str() == Some(path.as_str()))
    });
    Ok(recent)
}

fn save_recent_workspaces(file: &Path, recent: &[String]) -> Result<(), String> {
    let error = "Could not save recent workspaces.";
    let mut directory = fs::DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    directory.mode(0o700);
    directory
        .create(file.parent().ok_or(error)?)
        .map_err(|_| error)?;

    let nonce = getrandom::u64().map_err(|_| error)?;
    let temporary = file.with_extension(format!("{nonce:016x}.tmp"));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let output = options.open(&temporary).map_err(|_| error)?;
    let result = (|| {
        #[cfg(unix)]
        output.set_permissions(fs::Permissions::from_mode(0o600))?;
        serde_json::to_writer(&output, recent)?;
        output.sync_all()?;
        drop(output);
        fs::rename(&temporary, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_| error.into())
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
    fn record_picker_selection(&self, file: &Path, chosen: &Path) -> Result<String, String> {
        let path = canonical_directory(chosen).ok_or("Could not open the selected folder.")?;
        let display_path = path
            .to_str()
            .ok_or("The selected folder path is not UTF-8.")?
            .to_owned();
        let mut folders = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let mut recent = load_recent_workspaces(file)?;
        recent.retain(|entry| entry != &display_path);
        recent.insert(0, display_path.clone());
        recent.truncate(RECENT_WORKSPACE_LIMIT);
        save_recent_workspaces(file, &recent)?;
        folders.pending = Some(path);
        Ok(display_path)
    }

    fn prepare_recent(&self, file: &Path, requested: &Path) -> Result<String, String> {
        let path = canonical_directory(requested).ok_or(PICK_FOLDER_FIRST)?;
        let display_path = path.to_str().ok_or(PICK_FOLDER_FIRST)?.to_owned();
        let mut folders = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let mut recent = load_recent_workspaces(file)?;
        // Compare with the stored canonical path so a replaced symlink cannot grant access.
        let index = recent
            .iter()
            .position(|entry| entry == &display_path)
            .ok_or(PICK_FOLDER_FIRST)?;
        recent[..=index].rotate_right(1);
        save_recent_workspaces(file, &recent)?;
        folders.pending = Some(path);
        Ok(display_path)
    }

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
    let file = recent_workspaces_file(window.app_handle())?;
    state.record_picker_selection(&file, &path).map(Some)
}

#[tauri::command]
pub async fn list_recent_workspaces(app: AppHandle) -> Result<Vec<String>, String> {
    existing_recent_workspaces(&recent_workspaces_file(&app)?)
}

#[tauri::command]
pub async fn prepare_recent_workspace(
    app: AppHandle,
    state: State<'_, Workspace>,
    path: String,
) -> Result<String, String> {
    state.prepare_recent(&recent_workspaces_file(&app)?, Path::new(&path))
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
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    struct RecentFixture {
        root: PathBuf,
        file: PathBuf,
    }

    impl RecentFixture {
        fn new() -> Self {
            let nonce = getrandom::u64().unwrap();
            let root = std::env::temp_dir().join(format!("uya-recent-{nonce:016x}"));
            fs::create_dir(&root).unwrap();
            Self {
                file: root.join("app-data/recent_workspaces.json"),
                root,
            }
        }

        fn folder(&self, name: &str) -> PathBuf {
            let path = self.root.join(name);
            fs::create_dir(&path).unwrap();
            path
        }

        fn saved_paths(&self) -> Vec<String> {
            serde_json::from_slice(&fs::read(&self.file).unwrap()).unwrap()
        }
    }

    impl Drop for RecentFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn recent_workspaces_persist_canonical_paths_without_duplicates() {
        let fixture = RecentFixture::new();
        let first = fixture.folder("first");
        let second = fixture.folder("second");
        let workspace = Workspace::default();
        assert!(existing_recent_workspaces(&fixture.file)
            .unwrap()
            .is_empty());

        let first_display = workspace
            .record_picker_selection(&fixture.file, &first)
            .unwrap();
        let second_display = workspace
            .record_picker_selection(&fixture.file, &second)
            .unwrap();
        let alias = second.join("..").join("first");
        assert_eq!(
            workspace
                .record_picker_selection(&fixture.file, &alias)
                .unwrap(),
            first_display
        );
        assert_eq!(
            Path::new(&first_display),
            canonicalize_clean(&first).unwrap()
        );
        let saved = fixture.saved_paths();
        assert_eq!(saved, [first_display, second_display]);
        assert_eq!(existing_recent_workspaces(&fixture.file).unwrap(), saved);
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&fixture.file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn recent_workspaces_keep_only_the_ten_latest_selections() {
        let fixture = RecentFixture::new();
        let workspace = Workspace::default();
        let mut selected = Vec::new();
        for index in 0..12 {
            let path = fixture.folder(&format!("project-{index}"));
            selected.push(
                workspace
                    .record_picker_selection(&fixture.file, &path)
                    .unwrap(),
            );
        }
        selected.reverse();
        assert_eq!(fixture.saved_paths(), selected[..10]);
    }

    #[test]
    fn prepare_recent_requires_a_picker_selection_and_updates_recency() {
        let fixture = RecentFixture::new();
        let approved = fixture.folder("approved");
        let newer = fixture.folder("newer");
        let arbitrary = fixture.folder("arbitrary");
        let workspace = Workspace::default();
        assert_eq!(
            workspace.prepare_recent(&fixture.file, &arbitrary),
            Err(PICK_FOLDER_FIRST.into())
        );
        assert!(!fixture.file.exists());

        let approved_display = workspace
            .record_picker_selection(&fixture.file, &approved)
            .unwrap();
        let newer_display = workspace
            .record_picker_selection(&fixture.file, &newer)
            .unwrap();
        let reopened = Workspace::default();
        assert_eq!(
            reopened.prepare_recent(&fixture.file, &approved).unwrap(),
            approved_display
        );
        assert_eq!(
            reopened.prepare_recent(&fixture.file, &arbitrary),
            Err(PICK_FOLDER_FIRST.into())
        );
        assert_eq!(
            fixture.saved_paths(),
            [approved_display.clone(), newer_display]
        );
        assert!(reopened
            .activate(&canonicalize_clean(&arbitrary).unwrap(), |_| None)
            .is_err());
        assert!(reopened
            .activate(Path::new(&approved_display), |_| None)
            .is_ok());
    }

    #[test]
    fn recent_workspaces_skip_missing_or_replaced_directories() {
        let fixture = RecentFixture::new();
        let workspace = Workspace::default();
        let folder = fixture.folder("approved");
        workspace
            .record_picker_selection(&fixture.file, &folder)
            .unwrap();
        let reopened = Workspace::default();
        fs::remove_dir(&folder).unwrap();
        assert!(existing_recent_workspaces(&fixture.file)
            .unwrap()
            .is_empty());
        assert_eq!(
            reopened.prepare_recent(&fixture.file, &folder),
            Err(PICK_FOLDER_FIRST.into())
        );

        #[cfg(unix)]
        symlink(fixture.folder("replacement"), &folder).unwrap();
        #[cfg(not(unix))]
        fs::write(&folder, b"").unwrap();
        assert!(existing_recent_workspaces(&fixture.file)
            .unwrap()
            .is_empty());
        assert_eq!(
            reopened.prepare_recent(&fixture.file, &folder),
            Err(PICK_FOLDER_FIRST.into())
        );
    }

    #[test]
    fn terminal_uses_home_without_a_project_and_confines_explicit_paths() {
        let fixture = std::env::temp_dir().join(format!("uya-terminal-cwd-{}", std::process::id()));
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
