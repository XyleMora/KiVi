//! The integrated terminal: the user's shell on a pseudo-terminal, shown by
//! src/desktop/terminal.js. Output goes to the page as `term-data` events
//! ({id, data, end}); the last part is also kept here (`backlog`), so a page
//! opened later (the viewer, the diff, the home page) reattaches to the same
//! shell with its recent output. Unix only (posix_openpt through libc, no
//! extra crate); on Windows the commands refuse.

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct TermData {
    id: u32,
    data: String,
    /// Bytes of output so far, this chunk included (to drop what a reattach already got).
    end: u64,
}

#[derive(Serialize)]
pub struct Backlog {
    data: String,
    end: u64,
}

#[cfg(unix)]
pub mod imp {
    use super::{Backlog, TermData};
    use std::collections::HashMap;
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::os::unix::io::FromRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::{Arc, Mutex};

    use tauri::{AppHandle, Emitter, Manager, State};

    /// Output kept for reattaching, in bytes.
    const BACKLOG: usize = 256 * 1024;

    struct Output {
        backlog: String,
        end: u64,
    }

    struct Session {
        master: File,
        pid: i32,
        out: Arc<Mutex<Output>>,
    }

    #[derive(Default)]
    pub struct Terminals {
        next: Mutex<u32>,
        sessions: Mutex<HashMap<u32, Session>>,
    }

    fn last_err(what: &str) -> String {
        format!("{what}: {}", io::Error::last_os_error())
    }

    fn set_size(fd: i32, cols: u16, rows: u16) {
        let ws = libc::winsize { ws_row: rows.max(1), ws_col: cols.max(1), ws_xpixel: 0, ws_ypixel: 0 };
        unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &ws as *const libc::winsize) };
    }

    /// A new pseudo-terminal: (master, slave), both close-on-exec.
    fn open_pty(cols: u16, rows: u16) -> Result<(File, File), String> {
        static PTSNAME: Mutex<()> = Mutex::new(()); // ptsname uses a static buffer
        unsafe {
            let m = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY);
            if m < 0 {
                return Err(last_err("posix_openpt"));
            }
            let master = File::from_raw_fd(m);
            libc::fcntl(m, libc::F_SETFD, libc::FD_CLOEXEC);
            if libc::grantpt(m) != 0 || libc::unlockpt(m) != 0 {
                return Err(last_err("grantpt"));
            }
            let s = {
                let _guard = PTSNAME.lock().unwrap();
                let name = libc::ptsname(m);
                if name.is_null() {
                    return Err(last_err("ptsname"));
                }
                libc::open(name, libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC)
            };
            if s < 0 {
                return Err(last_err("open pty"));
            }
            set_size(m, cols, rows);
            Ok((master, File::from_raw_fd(s)))
        }
    }

    /// Text from the front of `buf`, leaving an incomplete UTF-8 sequence at its end for the next read.
    fn take_text(buf: &mut Vec<u8>) -> String {
        let end = match std::str::from_utf8(buf) {
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            _ => buf.len(),
        };
        let rest = buf.split_off(end);
        let text = String::from_utf8_lossy(buf).into_owned();
        *buf = rest;
        text
    }

    fn user_shell() -> String {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into())
    }

    fn spawn_shell(shell: &str, cwd: &str, slave: File) -> Result<Child, String> {
        let mut cmd = Command::new(shell);
        let dir = std::path::Path::new(cwd);
        if dir.is_dir() {
            cmd.current_dir(dir);
        } else if let Some(home) = std::env::var_os("HOME") {
            cmd.current_dir(home);
        }
        crate::kicad::outside_appimage(&mut cmd);
        cmd.env("TERM", "xterm-256color").env("COLORTERM", "truecolor").env("TERM_PROGRAM", "KiVi");
        let out = slave.try_clone().map_err(|e| e.to_string())?;
        let err = slave.try_clone().map_err(|e| e.to_string())?;
        cmd.stdin(Stdio::from(slave)).stdout(Stdio::from(out)).stderr(Stdio::from(err));
        // Its own session, with the pty as controlling terminal, so Ctrl+C and job control work.
        unsafe {
            cmd.pre_exec(|| {
                // Ignored signals are inherited, and a shell can't un-ignore them: if KiVi was
                // started with SIGHUP ignored (nohup, some launchers), closing the terminal
                // would never end the shell. Give it the defaults a terminal would.
                for sig in [libc::SIGHUP, libc::SIGINT, libc::SIGQUIT, libc::SIGTERM, libc::SIGTSTP, libc::SIGTTIN, libc::SIGTTOU, libc::SIGCHLD, libc::SIGPIPE] {
                    libc::signal(sig, libc::SIG_DFL);
                }
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        cmd.spawn().map_err(|e| format!("Couldn't start {shell}: {e}"))
        // `cmd` (and with it our copies of the slave) is dropped here, so the
        // master reads EIO once the shell and its children are gone.
    }

    /// Start the user's shell in `cwd` (the home folder if it isn't a folder); returns its id.
    #[tauri::command]
    pub fn term_open(cwd: Option<String>, cols: u16, rows: u16, app: AppHandle, terms: State<Terminals>) -> Result<u32, String> {
        let (master, slave) = open_pty(cols, rows)?;
        let mut child = spawn_shell(&user_shell(), cwd.as_deref().unwrap_or(""), slave)?;
        let pid = child.id() as i32;
        let id = {
            let mut next = terms.next.lock().unwrap();
            *next += 1;
            *next
        };
        let out = Arc::new(Mutex::new(Output { backlog: String::new(), end: 0 }));
        let mut reader = master.try_clone().map_err(|e| e.to_string())?;
        terms.sessions.lock().unwrap().insert(id, Session { master, pid, out: out.clone() });

        let exit_app = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let data = take_text(&mut pending);
                        if data.is_empty() {
                            continue;
                        }
                        // Under the lock, so a reattach sees either all of a chunk or none of it.
                        let mut o = out.lock().unwrap();
                        o.end += data.len() as u64;
                        o.backlog.push_str(&data);
                        if o.backlog.len() > BACKLOG {
                            let mut cut = o.backlog.len() - BACKLOG;
                            while !o.backlog.is_char_boundary(cut) {
                                cut += 1;
                            }
                            o.backlog.drain(..cut);
                        }
                        let _ = app.emit("term-data", TermData { id, data, end: o.end });
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break, // EIO: nothing has the pty open any more
                }
            }
        });
        // The shell's exit ends the terminal, even when something it started
        // (an agent, a background job) still holds the pty open, so the read
        // above would never see EIO.
        std::thread::spawn(move || {
            let _ = child.wait();
            std::thread::sleep(std::time::Duration::from_millis(150)); // let its last output through
            exit_app.state::<Terminals>().sessions.lock().unwrap().remove(&id);
            let _ = exit_app.emit("term-exit", id);
        });
        Ok(id)
    }

    /// Keyboard input (and pastes) for the shell.
    #[tauri::command]
    pub fn term_write(id: u32, data: String, terms: State<Terminals>) -> Result<(), String> {
        let mut sessions = terms.sessions.lock().unwrap();
        let s = sessions.get_mut(&id).ok_or("the terminal has closed")?;
        s.master.write_all(data.as_bytes()).map_err(|e| e.to_string())
    }

    /// The panel's new size in character cells.
    #[tauri::command]
    pub fn term_resize(id: u32, cols: u16, rows: u16, terms: State<Terminals>) -> Result<(), String> {
        use std::os::unix::io::AsRawFd;
        let sessions = terms.sessions.lock().unwrap();
        let s = sessions.get(&id).ok_or("the terminal has closed")?;
        set_size(s.master.as_raw_fd(), cols, rows);
        Ok(())
    }

    /// The recent output of a running terminal (a page reattaching), or None if it has exited.
    #[tauri::command]
    pub fn term_attach(id: u32, terms: State<Terminals>) -> Option<Backlog> {
        let sessions = terms.sessions.lock().unwrap();
        let o = sessions.get(&id)?.out.lock().unwrap();
        Some(Backlog { data: o.backlog.clone(), end: o.end })
    }

    /// Close a terminal: hang up its shell (and what runs in its session).
    #[tauri::command]
    pub fn term_close(id: u32, terms: State<Terminals>) {
        if let Some(s) = terms.sessions.lock().unwrap().remove(&id) {
            end_session(s.pid);
            // Dropping the master hangs up the pty for everything else in the session.
        }
    }

    /// Hang up the shell's process group, and kill it if it's still there 2 s later
    /// (a shell busy with a command can outlive the hang-up).
    fn end_session(pid: i32) {
        unsafe { libc::kill(-pid, libc::SIGHUP) };
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(2));
            unsafe { libc::kill(-pid, libc::SIGKILL) }; // ESRCH when already gone
        });
    }

    #[cfg(test)]
    mod tests {
        use super::{end_session, open_pty, set_size, spawn_shell, take_text};
        use std::io::{Read, Write};
        use std::os::unix::io::AsRawFd;

        #[test]
        fn shell_runs_on_the_pty_with_its_size_and_folder() {
            let dir = std::env::temp_dir();
            let (mut master, slave) = open_pty(100, 30).unwrap();
            let mut child = spawn_shell("/bin/sh", &dir.to_string_lossy(), slave).unwrap();
            set_size(master.as_raw_fd(), 120, 40); // what the panel does on resize
            master.write_all(b"stty size; pwd; tty; echo DONE-$((40+2))\n").unwrap();
            // Read on a thread until the marker shows, with a time limit instead of waiting for EOF.
            let mut reader = master.try_clone().unwrap();
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            });
            let mut out = Vec::new();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !String::from_utf8_lossy(&out).contains("DONE-42") {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                match rx.recv_timeout(left) {
                    Ok(chunk) => out.extend(chunk),
                    Err(_) => break,
                }
            }
            // End it as term_close does (hang-up, then a kill after 2 s); never wait unbounded.
            end_session(child.id() as i32);
            let gone = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let ended = loop {
                if child.try_wait().unwrap().is_some() {
                    break true;
                }
                if std::time::Instant::now() > gone {
                    break false;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            };
            let text = String::from_utf8_lossy(&out);
            assert!(ended, "the shell outlived term_close:\n{text}");
            assert!(text.contains("DONE-42"), "{text}");
            assert!(text.contains("40 120"), "{text}");
            assert!(text.contains(&*std::fs::canonicalize(&dir).unwrap().to_string_lossy()), "{text}");
            assert!(text.contains("/dev/pts/"), "{text}");
        }

        #[test]
        fn split_utf8_waits_for_the_rest() {
            let mut buf = "aé".as_bytes().to_vec();
            buf.pop(); // half of "é"
            assert_eq!(take_text(&mut buf), "a");
            assert_eq!(buf.len(), 1);
            buf.push(0xA9);
            assert_eq!(take_text(&mut buf), "é");
            assert!(buf.is_empty());
        }
    }
}

#[cfg(not(unix))]
pub mod imp {
    use super::Backlog;

    const NO: &str = "The terminal isn't available on this system yet";

    #[derive(Default)]
    pub struct Terminals;

    #[tauri::command]
    pub fn term_open(cwd: Option<String>, cols: u16, rows: u16) -> Result<u32, String> {
        let _ = (cwd, cols, rows);
        Err(NO.into())
    }
    #[tauri::command]
    pub fn term_write(id: u32, data: String) -> Result<(), String> {
        let _ = (id, data);
        Err(NO.into())
    }
    #[tauri::command]
    pub fn term_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let _ = (id, cols, rows);
        Err(NO.into())
    }
    #[tauri::command]
    pub fn term_attach(id: u32) -> Option<Backlog> {
        let _ = id;
        None
    }
    #[tauri::command]
    pub fn term_close(id: u32) {
        let _ = id;
    }
}
