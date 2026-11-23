use base64::prelude::{Engine, BASE64_STANDARD};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{ErrorKind, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::io::RawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, Manager, State};

use crate::workspace::Workspace;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    closing: AtomicBool,
}

impl Session {
    fn terminate(&self) {
        self.closing.store(true, Ordering::Release);
        let mut child = self.child.lock().unwrap_or_else(|error| error.into_inner());
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        #[cfg(unix)]
        {
            let master = self
                .master
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(group) = master.process_group_leader().filter(|group| *group > 1) {
                // SAFETY: this is the foreground process group of the session's PTY.
                unsafe { libc::kill(-group, libc::SIGHUP) };
            }
        }
        let _ = child.kill();
    }

    fn exit_code(&self) -> Option<u32> {
        loop {
            let status = self
                .child
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .try_wait();
            match status {
                Ok(Some(status)) => return status.signal().is_none().then(|| status.exit_code()),
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(_) => return None,
            }
        }
    }
}

#[derive(Default)]
pub struct Terminals {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl Terminals {
    fn session(&self, id: &str) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| "This terminal session has ended.".to_owned())
    }

    fn remove(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id)
    }

    pub fn shutdown(&self) {
        let sessions = std::mem::take(
            &mut *self
                .sessions
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        for session in sessions.values() {
            session.terminate();
        }
    }

    fn open(
        self: &Arc<Self>,
        cwd: PathBuf,
        program: Option<String>,
        args: Vec<String>,
        paths: Option<OsString>,
        size: PtySize,
        events: Channel<PtyEvent>,
    ) -> Result<String, String> {
        let mut command = match program {
            Some(program) => {
                let executable = resolve_program(&program, paths.as_ref())
                    .ok_or("The selected terminal command is not executable.")?;
                let mut command = CommandBuilder::new(executable);
                command.args(args);
                command
            }
            None => CommandBuilder::new_default_prog(),
        };
        if let Some(paths) = paths {
            command.env("PATH", paths);
        }
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env_remove("IDE_SESSION_TOKEN");
        command.env_remove("IDE_MANAGED_SIDECAR");

        let pair = native_pty_system()
            .openpty(size)
            .map_err(|_| "Could not allocate a native terminal.")?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|_| "Could not read terminal output.")?;
        #[cfg(unix)]
        let fd = pair
            .master
            .as_raw_fd()
            .ok_or("Could not get the native terminal descriptor.")?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|_| "Could not open terminal input.")?;
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|_| "Could not start the terminal command.")?;
        drop(pair.slave);
        let session = Arc::new(Session {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            closing: AtomicBool::new(false),
        });
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        self.sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id.clone(), session.clone());

        let terminals = Arc::clone(self);
        let finished_id = id.clone();
        thread::spawn(move || {
            #[cfg(unix)]
            forward_output(reader, fd, &session, &events);
            #[cfg(not(unix))]
            forward_output(reader, &session, &events);
            let code = session.exit_code();
            terminals.remove(&finished_id);
            let _ = events.send(PtyEvent::Exit { code });
        });
        Ok(id)
    }
}

#[cfg(unix)]
fn forward_output(
    mut reader: Box<dyn Read + Send>,
    fd: RawFd,
    session: &Session,
    events: &Channel<PtyEvent>,
) {
    let mut buffer = [0_u8; 4096];
    let mut descriptor = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    while !session.closing.load(Ordering::Acquire) {
        // SAFETY: the Session holds the native master for the duration of this loop.
        let ready = unsafe { libc::poll(&mut descriptor, 1, 100) };
        if ready == 0 {
            continue;
        }
        if ready < 0 {
            if std::io::Error::last_os_error().kind() == ErrorKind::Interrupted {
                continue;
            }
            session.terminate();
            break;
        }
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                let data = BASE64_STANDARD.encode(&buffer[..count]);
                if events.send(PtyEvent::Data { data }).is_err() {
                    session.terminate();
                    break;
                }
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

#[cfg(not(unix))]
fn forward_output(
    mut reader: Box<dyn Read + Send>,
    session: &Session,
    events: &Channel<PtyEvent>,
) {
    let mut buffer = [0_u8; 4096];
    while !session.closing.load(Ordering::Acquire) {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                let data = BASE64_STANDARD.encode(&buffer[..count]);
                if events.send(PtyEvent::Data { data }).is_err() {
                    session.terminate();
                    break;
                }
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

fn resolve_program(program: &str, paths: Option<&OsString>) -> Option<PathBuf> {
    #[cfg(unix)]
    fn executable(path: &Path) -> bool {
        std::fs::metadata(path)
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
    }

    #[cfg(windows)]
    fn executable(path: &Path) -> bool {
        std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
    }

    let path = Path::new(program);
    if path.is_absolute() {
        return executable(path).then(|| path.to_owned());
    }
    if program.is_empty()
        || program.contains('/')
        || program.contains('\\')
        || program == "."
        || program == ".."
    {
        return None;
    }

    #[cfg(windows)]
    let extensions: Vec<String> = {
        let mut exts = vec![String::new()];
        if path.extension().is_none() {
            let pathext = std::env::var("PATHEXT")
                .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned());
            for ext in pathext.split(';').filter(|ext| !ext.is_empty()) {
                exts.push(ext.to_ascii_lowercase());
            }
        }
        exts
    };

    for directory in std::env::split_paths(paths?) {
        #[cfg(unix)]
        {
            let candidate = directory.join(path);
            if executable(&candidate) {
                return Some(candidate);
            }
        }
        #[cfg(windows)]
        {
            for ext in &extensions {
                let candidate = if ext.is_empty() {
                    directory.join(program)
                } else {
                    directory.join(format!("{program}{ext}"))
                };
                if executable(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn terminal_size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if cols == 0 || rows == 0 {
        return Err("Terminal rows and columns must be positive.".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

#[tauri::command]
pub async fn pty_open(
    app: AppHandle,
    workspace: State<'_, Workspace>,
    terminals: State<'_, Arc<Terminals>>,
    cwd: Option<String>,
    program: Option<String>,
    args: Option<Vec<String>>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
    let directory = workspace
        .terminal_directory(cwd.as_deref().map(Path::new), || app.path().home_dir().ok())?;
    let size = terminal_size(cols, rows)?;
    let paths = crate::local_path(&app);
    let terminals = Arc::clone(&terminals);
    tauri::async_runtime::spawn_blocking(move || {
        terminals.open(
            directory,
            program,
            args.unwrap_or_default(),
            paths,
            size,
            on_event,
        )
    })
    .await
    .map_err(|_| "Could not start the native terminal.")?
}

#[tauri::command]
pub async fn pty_write(
    terminals: State<'_, Arc<Terminals>>,
    id: String,
    data: String,
) -> Result<(), String> {
    let session = terminals.session(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut writer = session
            .writer
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|_| "Could not send input to the terminal.".to_owned())
    })
    .await
    .map_err(|_| "Could not send input to the terminal.")?
}

#[tauri::command]
pub fn pty_resize(
    terminals: State<'_, Arc<Terminals>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = terminals.session(&id)?;
    let size = terminal_size(cols, rows)?;
    let master = session
        .master
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    master
        .resize(size)
        .map_err(|_| "Could not resize the terminal.".into())
}

#[tauri::command]
pub async fn pty_close(terminals: State<'_, Arc<Terminals>>, id: String) -> Result<(), String> {
    let session = terminals.remove(&id);
    if let Some(session) = session {
        tauri::async_runtime::spawn_blocking(move || session.terminate())
            .await
            .map_err(|_| "Could not close the terminal.")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::sync::mpsc;
    #[cfg(unix)]
    use tauri::ipc::InvokeResponseBody;

    #[test]
    fn terminal_size_rejects_zero_dimensions() {
        assert!(terminal_size(0, 24).is_err());
        assert!(terminal_size(80, 0).is_err());
        let size = terminal_size(80, 24).unwrap();
        assert_eq!((size.cols, size.rows), (80, 24));
    }

    #[test]
    fn resolve_program_rejects_relative_subpaths() {
        assert!(resolve_program("", None).is_none());
        assert!(resolve_program("./tool", None).is_none());
        assert!(resolve_program("sub\\tool", None).is_none());
        assert!(resolve_program("..", None).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn native_terminal_resizes_and_preserves_utf8_and_argument_boundaries() {
        let terminals = Arc::new(Terminals::default());
        let (sender, receiver) = mpsc::channel();
        let channel = Channel::new(move |event| {
            let _ = sender.send(event);
            Ok(())
        });
        let id = terminals
            .open(
                std::env::temp_dir(),
                Some("/bin/sh".into()),
                vec![
                    "-c".into(),
                    "read line; stty size; printf '%s %s\\n' \"$line\" \"$1\"".into(),
                    "uya-fixture".into(),
                    "қазақша $(must-not-run)".into(),
                ],
                Some("/usr/bin:/bin".into()),
                terminal_size(80, 24).unwrap(),
                channel,
            )
            .unwrap();
        let session = terminals.session(&id).unwrap();
        session
            .master
            .lock()
            .unwrap()
            .resize(terminal_size(92, 39).unwrap())
            .unwrap();
        session
            .writer
            .lock()
            .unwrap()
            .write_all(b"verified\n")
            .unwrap();
        let mut bytes = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let message = receiver
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .expect("PTY fixture timed out");
            let InvokeResponseBody::Json(body) = message else {
                panic!("Unexpected PTY fixture response");
            };
            let event: serde_json::Value = serde_json::from_str(&body).unwrap();
            if event["type"] == "exit" {
                assert_eq!(event["code"], 0);
                break;
            }
            bytes.extend(
                BASE64_STANDARD
                    .decode(event["data"].as_str().unwrap())
                    .unwrap(),
            );
        }
        let output = String::from_utf8(bytes).unwrap();
        assert!(output.contains("39 92"));
        assert!(output.contains("verified қазақша $(must-not-run)"));
        assert!(terminals.session(&id).is_err());
    }
}
