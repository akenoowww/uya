use base64::prelude::{Engine, BASE64_URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use std::fs::{DirBuilder, File, OpenOptions, TryLockError};
use std::io::{self, BufRead, BufReader, Read};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Serialize)]
pub struct Connection {
    port: u16,
    token: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StartupReport {
    Ready { port: u16 },
    Failed { error: StartupError },
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum StartupError {
    HistorySchemaNewer,
    HistorySchemaUnsupported,
    HistorySchemaMigrationFailed,
}

impl StartupError {
    fn message(&self) -> &'static str {
        match self {
            Self::HistorySchemaNewer => {
                "The local run history was created by a newer Uya. Update Uya to open it."
            }
            Self::HistorySchemaUnsupported => {
                "This Uya version does not support the local run history schema."
            }
            Self::HistorySchemaMigrationFailed => {
                "Uya could not upgrade the local run history database."
            }
        }
    }
}

struct Process {
    child: Child,
    connection: Connection,
    _data_lock: File,
}

impl Drop for Process {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(None)) {
            return;
        }
        // Closing stdin also shuts down a managed sidecar.
        drop(self.child.stdin.take());
        #[cfg(unix)]
        let pid = self.child.id() as libc::pid_t;
        #[cfg(unix)]
        // SAFETY: the unreaped Child still owns this PID.
        unsafe {
            libc::kill(pid, libc::SIGTERM)
        };
        let deadline = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < deadline {
            if !matches!(self.child.try_wait(), Ok(None)) {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        #[cfg(unix)]
        // SAFETY: this child was started as the leader of its own process group.
        unsafe {
            libc::kill(-pid, libc::SIGKILL)
        };
        #[cfg(not(unix))]
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct Sidecar(Mutex<Option<Process>>);

impl Sidecar {
    pub fn connect(&self, app: &tauri::AppHandle) -> Result<Connection, String> {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(process) = &mut *state {
            if matches!(process.child.try_wait(), Ok(None)) {
                return Ok(process.connection.clone());
            }
        }
        drop(state.take());

        let mut random = [0_u8; 32];
        getrandom::fill(&mut random).map_err(|_| "Could not secure the local connection.")?;
        let token = BASE64_URL_SAFE_NO_PAD.encode(random);
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|_| "Could not locate the local application data directory.")?;
        let data_lock = lock_data_directory(&directory)?;

        let mut command = sidecar_command()?;
        if let Some(paths) = crate::local_path(app) {
            command.env("PATH", paths);
        }
        command
            .env_remove("BUN_OPTIONS")
            .env("IDE_MANAGED_SIDECAR", "1")
            .env("IDE_SESSION_TOKEN", &token)
            .env("IDE_DATA_DIR", &directory)
            .current_dir(&directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = command
            .spawn()
            .map_err(|_| "Could not launch the local orchestrator. Check the IDE installation.")?;

        let stdout = child.stdout.take().expect("sidecar stdout was piped");
        let mut process = Process {
            child,
            connection: Connection { port: 0, token },
            _data_lock: data_lock,
        };
        let (ready, startup) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            let handshake = reader.by_ref().take(512).read_until(b'\n', &mut line);
            let info = handshake
                .ok()
                .filter(|_| line.last() == Some(&b'\n'))
                .and_then(|_| serde_json::from_slice::<StartupReport>(&line).ok());
            let _ = ready.send(info);
            let _ = io::copy(&mut reader, &mut io::sink());
        });
        process.connection.port = match startup.recv_timeout(Duration::from_secs(10)).ok().flatten()
        {
            Some(StartupReport::Ready { port }) if port > 0 => port,
            Some(StartupReport::Failed { error }) => return Err(error.message().into()),
            _ => {
                return Err("The local orchestrator did not report a valid listening port.".into())
            }
        };
        let connection = process.connection.clone();
        *state = Some(process);
        Ok(connection)
    }

    pub fn shutdown(&self) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
    }
}

fn lock_data_directory(directory: &Path) -> Result<File, String> {
    let mut dir_builder = DirBuilder::new();
    dir_builder.recursive(true);
    #[cfg(unix)]
    dir_builder.mode(0o700);
    dir_builder
        .create(directory)
        .map_err(|_| "Could not create the local application data directory.")?;

    let mut open_options = OpenOptions::new();
    open_options
        .read(true)
        .write(true)
        .create(true)
        .truncate(false);
    #[cfg(unix)]
    open_options.mode(0o600);
    let lock = open_options
        .open(directory.join("uya.lock"))
        .map_err(|_| "Could not access the local application data lock.")?;
    match lock.try_lock() {
        Ok(()) => Ok(lock),
        Err(TryLockError::WouldBlock) => {
            Err("Another Uya window is already using the local application data.".into())
        }
        Err(TryLockError::Error(_)) => Err("Could not lock the local application data.".into()),
    }
}

fn sidecar_command() -> Result<Command, String> {
    if !cfg!(feature = "custom-protocol") {
        let entry =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/core/src/index.ts");
        let mut command = Command::new("bun");
        command.arg("run").arg("--no-env-file").arg(entry);
        return Ok(command);
    }

    let sidecar_name = if cfg!(windows) {
        "uya-core.exe"
    } else {
        "uya-core"
    };
    let binary = std::env::current_exe()
        .map_err(|_| "Could not locate the IDE executable.")?
        .with_file_name(sidecar_name);
    Ok(Command::new(binary))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn startup_report_accepts_known_schema_failures_only() {
        let report =
            serde_json::from_str::<StartupReport>(r#"{"error":"history_schema_newer"}"#).unwrap();
        let StartupReport::Failed { error } = report else {
            panic!("Expected the schema failure report");
        };
        assert!(error.message().contains("Update Uya"));
        assert!(serde_json::from_str::<StartupReport>(r#"{"error":"raw SQLite error"}"#).is_err());
    }

    #[test]
    fn data_lock_excludes_other_instances_and_uses_private_permissions() {
        let directory =
            std::env::temp_dir().join(format!("uya-lock-test-{}", std::process::id()));
        let first = lock_data_directory(&directory).unwrap();
        let error = lock_data_directory(&directory).unwrap_err();
        assert!(error.contains("already using"));
        #[cfg(unix)]
        {
            let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&directory), 0o700);
            assert_eq!(mode(&directory.join("uya.lock")), 0o600);
        }
        drop(first);
        let next = lock_data_directory(&directory).unwrap();
        drop(next);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
