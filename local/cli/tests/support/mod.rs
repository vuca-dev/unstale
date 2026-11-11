//! Shared test support for the tests that drive the binary: a recording HTTP mock, a fake `codex`, the canaries, a
//! pseudo-terminal runner and a FIFO sentinel that notices when a file is opened. Nothing here makes a request that
//! leaves the machine.
#![cfg(unix)]
#![allow(dead_code)]

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ------------------------------------------------------------------------------------------------------- canaries

/// A key value in the shell environment.
pub const SHELL_CANARY: &str = "canary-shell-key-77be42";
/// A key value in this repository's `.env`.
pub const REPO_CANARY: &str = "canary-repo-env-3f9a1c";
/// A key value in another repository's `.env`, which is never to be opened.
pub const OTHER_CANARY: &str = "canary-other-repo-8d2e7b";
/// A token in Codex's auth file, which is never to be opened.
pub const AUTH_CANARY: &str = "canary-codex-auth-51c0aa";

pub const CANARIES: [&str; 4] = [SHELL_CANARY, REPO_CANARY, OTHER_CANARY, AUTH_CANARY];

/// The canaries `text` carries.
pub fn canaries_in(text: &str) -> Vec<&'static str> {
    CANARIES.into_iter().filter(|c| text.contains(c)).collect()
}

// ----------------------------------------------------------------------------------------------------------- mock

/// One request as the mock read it.
#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    /// The request line and headers, `\r\n`-separated.
    pub head: String,
    pub body: String,
}

impl Request {
    pub fn raw(&self) -> String {
        format!("{}\r\n\r\n{}", self.head, self.body)
    }
    /// The header lines (not the request line).
    pub fn header_lines(&self) -> Vec<&str> {
        self.head.split("\r\n").skip(1).collect()
    }
    pub fn header(&self, name: &str) -> Option<String> {
        let want = format!("{}:", name.to_ascii_lowercase());
        self.header_lines()
            .into_iter()
            .find(|l| l.to_ascii_lowercase().starts_with(&want))
            .map(|l| l[want.len()..].trim().to_string())
    }
}

/// The mock's answer to one request.
#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub delay: Duration,
}

impl Response {
    pub fn json(status: u16, body: &str) -> Response {
        Response {
            status,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: body.as_bytes().to_vec(),
            delay: Duration::ZERO,
        }
    }
    pub fn bytes(status: u16, body: Vec<u8>) -> Response {
        Response {
            status,
            headers: vec![],
            body,
            delay: Duration::ZERO,
        }
    }
    pub fn after(mut self, delay: Duration) -> Response {
        self.delay = delay;
        self
    }
}

type Handler = dyn Fn(&Request) -> Response + Send + Sync;

/// A local HTTP server that records every request and answers each with its handler.
pub struct Mock {
    pub url: String,
    pub port: u16,
    seen: Arc<Mutex<Vec<Request>>>,
}

impl Mock {
    pub fn start(handler: impl Fn(&Request) -> Response + Send + Sync + 'static) -> Mock {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let handler: Arc<Handler> = Arc::new(handler);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (log, handler) = (log.clone(), handler.clone());
                std::thread::spawn(move || serve(stream, &log, &*handler));
            }
        });
        Mock {
            url: format!("http://127.0.0.1:{port}"),
            port,
            seen,
        }
    }

    /// Every request so far, in arrival order.
    pub fn requests(&self) -> Vec<Request> {
        self.seen.lock().unwrap().clone()
    }

    /// The raw requests, shared: grows as requests arrive.
    pub fn log(&self) -> Arc<Mutex<Vec<Request>>> {
        self.seen.clone()
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> Option<Request> {
    let (mut got, mut buf) = (Vec::new(), [0u8; 16384]);
    loop {
        let n = stream.read(&mut buf).unwrap_or(0);
        got.extend_from_slice(&buf[..n]);
        let Some(end) = got.windows(4).position(|w| w == b"\r\n\r\n") else {
            if n == 0 {
                break;
            }
            continue;
        };
        let head = String::from_utf8_lossy(&got[..end]).to_string();
        let length = head
            .lines()
            .find_map(|l| {
                l.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
            })
            .unwrap_or(0);
        if n == 0 || got.len() >= end + 4 + length {
            let mut words = head.split_whitespace();
            let method = words.next().unwrap_or_default().to_string();
            let path = words.next().unwrap_or_default().to_string();
            let body = String::from_utf8_lossy(&got[end + 4..]).to_string();
            return Some(Request {
                method,
                path,
                head,
                body,
            });
        }
    }
    (!got.is_empty()).then(|| Request {
        method: String::new(),
        path: String::new(),
        head: String::from_utf8_lossy(&got).to_string(),
        body: String::new(),
    })
}

fn serve(mut stream: std::net::TcpStream, log: &Mutex<Vec<Request>>, handler: &Handler) {
    let Some(request) = read_request(&mut stream) else {
        return;
    };
    log.lock().unwrap().push(request.clone());
    let r = handler(&request);
    std::thread::sleep(r.delay);
    let mut head = format!("HTTP/1.1 {} X\r\n", r.status);
    for (k, v) in &r.headers {
        head += &format!("{k}: {v}\r\n");
    }
    head += &format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        r.body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&r.body);
}

/// A mock answering every request with `(status, body)` after `delay`, and the raw requests it records. A 3xx mock's
/// body is the Location it points to.
pub fn mock(status: u16, body: &str, delay: Duration) -> (String, Arc<Mutex<Vec<String>>>) {
    let raw = Arc::new(Mutex::new(Vec::new()));
    let log = raw.clone();
    let body = body.to_string();
    let m = Mock::start(move |req| {
        log.lock().unwrap().push(req.raw());
        let mut r = Response::json(status, &body).after(delay);
        if (300..400).contains(&status) {
            r.headers.push(("Location".into(), body.clone()));
        }
        r
    });
    (m.url.clone(), raw)
}

// ---------------------------------------------------------------------------------------------------------- codex

/// A successful `codex exec --json` answer of `{"ok":true}`.
pub const CODEX_OK: &str = concat!(
    r#"{"type":"item.completed","item":{"type":"agent_message","text":"{\"ok\":true}"}}"#,
    "\n",
    r#"{"type":"turn.completed","usage":{"input_tokens":4299,"cached_input_tokens":2944,"output_tokens":5,"reasoning_output_tokens":0}}"#,
    "\n",
);

/// A fake `codex` in `<dir>/bin`. `--version` answers a supported version; `login status` answers as `logged_in`
/// says; anything else (`exec`) writes its arguments to `<dir>/args` and its environment to `<dir>/env`, prints
/// `exec_out` and exits with `exec_code`. Every invocation's first two arguments are appended, one line
/// each, to `<dir>/invocations`. Returns the `bin` directory, for PATH.
pub fn fake_codex(dir: &Path, logged_in: bool, exec_out: &str, exec_code: i32) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(dir.join("exec-out.jsonl"), exec_out).unwrap();
    let login = if logged_in {
        "echo 'Logged in using ChatGPT'; exit 0"
    } else {
        "echo 'Not logged in'; exit 1"
    };
    let script = format!(
        "#!/bin/sh\nprintf '%s %s\\n' \"$1\" \"$2\" >> \"{d}/invocations\"\nif [ \"$1\" = \"--version\" ]; then echo 'codex-cli 0.166.0'; exit 0; fi\nif [ \"$1\" = \"login\" ]; then {login}; fi\nprintf '%s\\n' \"$@\" > \"{d}/args\"\nenv > \"{d}/env\"\ncat \"{d}/exec-out.jsonl\"\nexit {exec_code}\n",
        d = dir.display(),
    );
    std::fs::write(bin.join("codex"), script).unwrap();
    std::fs::set_permissions(bin.join("codex"), std::fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

/// The fake `codex`'s recorded invocations, one per line (`--version`, `login status`, `exec ...`).
pub fn codex_invocations(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("invocations"))
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect()
}

// ------------------------------------------------------------------------------------------------------ terminal

/// The pseudo-terminal's size.
pub const COLUMNS: u16 = 100;
pub const ROWS: u16 = 32;

/// Runs `cmd` at a pseudo-terminal (`script`), with `cmd`'s environment and directory. Each `(prompt, input)` pair is
/// typed once `prompt` (or any of its `|`-separated alternatives) has appeared in the output, so typed text lands
/// after the question that reads it. Returns the
/// exit code and the output with `\r` removed, or panics after `limit`.
pub fn at_terminal(cmd: &Command, answers: &[(&str, &str)], limit: Duration) -> (i32, String) {
    let program = cmd.get_program().to_string_lossy().to_string();
    let args: Vec<String> = cmd
        .get_args()
        .map(|a| a.to_string_lossy().to_string())
        .collect();
    // A terminal of a fixed size, so output that fits itself to the width is the same on every machine.
    let line = std::iter::once(program.as_str())
        .chain(args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    let line = format!("stty cols {COLUMNS} rows {ROWS}; exec {line}");
    let mut s = Command::new("script");
    if cfg!(target_os = "macos") {
        s.args(["-q", "/dev/null", "/bin/sh", "-c", &line]);
    } else {
        s.args(["-qec", &line, "/dev/null"]);
    }
    if let Some(d) = cmd.get_current_dir() {
        s.current_dir(d);
    }
    s.env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in cmd.get_envs() {
        if let Some(v) = v {
            s.env(k, v);
        }
    }
    let mut child = s.spawn().unwrap();
    // Kept open until the run ends: closing it would reach the program as end of input.
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let out = Arc::new(Mutex::new(Vec::<u8>::new()));
    let sink = out.clone();
    let reader = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => sink.lock().unwrap().extend_from_slice(&buf[..n]),
            }
        }
    });
    let start = Instant::now();
    let mut next = 0;
    let mut typed_at = 0;
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if start.elapsed() > limit {
            let _ = child.kill();
            panic!(
                "`{program} {}` did not finish at a terminal in {limit:?}",
                args.join(" ")
            );
        }
        if let Some((prompt, input)) = answers.get(next) {
            let text = String::from_utf8_lossy(&out.lock().unwrap()).to_string();
            let rest = &text[typed_at.min(text.len())..];
            if let Some((at, len)) = prompt
                .split('|')
                .filter_map(|p| rest.find(p).map(|at| (at, p.len())))
                .min()
            {
                typed_at += at + len;
                let _ = stdin.write_all(input.as_bytes());
                next += 1;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let status = child.wait().unwrap();
    reader.join().unwrap();
    drop(stdin);
    let text = String::from_utf8_lossy(&out.lock().unwrap()).to_string();
    (status.code().unwrap_or(-1), text)
}

/// What a terminal shows once `raw` has been written to it: carriage returns, cursor moves up and down and line
/// erases applied, colours and other escapes dropped. Progress lines a program redraws in place leave only their
/// last state, so the result does not depend on how fast the machine was.
pub fn screen(raw: &str) -> String {
    let mut rows: Vec<Vec<char>> = vec![vec![]];
    let (mut row, mut col) = (0usize, 0usize);
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\n' => {
                row += 1;
                col = 0;
                if rows.len() <= row {
                    rows.push(vec![]);
                }
            }
            '\r' => col = 0,
            '\x1b' if chars.peek() == Some(&'[') => {
                chars.next();
                let mut params = String::new();
                let mut fin = ' ';
                for d in chars.by_ref() {
                    if d.is_ascii_alphabetic() || d == '~' {
                        fin = d;
                        break;
                    }
                    params.push(d);
                }
                let n = params
                    .trim_start_matches('?')
                    .parse::<usize>()
                    .unwrap_or(1)
                    .max(1);
                match fin {
                    'A' => row = row.saturating_sub(n),
                    'B' => {
                        row += n;
                        while rows.len() <= row {
                            rows.push(vec![]);
                        }
                    }
                    'K' if params == "2" => rows[row].clear(),
                    'K' => rows[row].truncate(col),
                    'J' => {
                        rows[row].truncate(col);
                        rows.truncate(row + 1);
                    }
                    _ => {}
                }
            }
            '\x1b' => {}
            c => {
                let line = &mut rows[row];
                while line.len() < col {
                    line.push(' ');
                }
                if col < line.len() {
                    line[col] = c;
                } else {
                    line.push(c);
                }
                col += 1;
            }
        }
    }
    let mut text = rows
        .into_iter()
        .map(|r| r.into_iter().collect::<String>().trim_end().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    while text.ends_with('\n') {
        text.pop();
    }
    if !text.is_empty() {
        text.push('\n');
    }
    text
}

fn shell_quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=+@,".contains(c))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Runs `cmd` without a terminal (stdin closed), or panics after `limit`: a run blocked opening a FIFO it must never
/// open would otherwise hang. Returns the exit code, stdout and stderr.
pub fn run_within(cmd: &mut Command, limit: Duration) -> (i32, String, String) {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let start = Instant::now();
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if start.elapsed() > limit {
            let _ = child.kill();
            panic!(
                "`{}` did not finish in {limit:?}: it may be blocked opening a file it must never open",
                cmd.get_args()
                    .map(|a| a.to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join(" ")
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    )
}

// ------------------------------------------------------------------------------------------------------ sentinel

/// A file that must never be opened, planted as a FIFO with a writer waiting on it: whoever opens it for reading
/// receives `content` (a canary) and is recorded. Unlike a FIFO alone, a reader does not hang, so a run that opened it
/// finishes and its output can be checked for the canary as well.
pub struct Sentinel {
    pub path: PathBuf,
    opened: Arc<AtomicBool>,
    closing: Arc<AtomicBool>,
    writer: Option<std::thread::JoinHandle<()>>,
}

impl Sentinel {
    pub fn plant(path: &Path, content: &str) -> Sentinel {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let _ = std::fs::remove_file(path);
        assert!(
            Command::new("mkfifo").arg(path).status().unwrap().success(),
            "mkfifo {}",
            path.display()
        );
        let (opened, closing) = (
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
        );
        let (o, c, p, text) = (
            opened.clone(),
            closing.clone(),
            path.to_path_buf(),
            content.to_string(),
        );
        let writer = std::thread::spawn(move || {
            loop {
                // Blocks until a reader opens the FIFO.
                let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(&p) else {
                    return;
                };
                if c.load(Ordering::SeqCst) {
                    return;
                }
                o.store(true, Ordering::SeqCst);
                let _ = f.write_all(text.as_bytes());
                drop(f);
                // Closing is the reader's end of file; give it time to close before waiting for the next reader.
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        Sentinel {
            path: path.to_path_buf(),
            opened,
            closing,
            writer: Some(writer),
        }
    }

    /// Whether anything opened the file so far.
    pub fn opened(&self) -> bool {
        self.opened.load(Ordering::SeqCst)
    }
}

impl Drop for Sentinel {
    fn drop(&mut self) {
        use std::os::unix::fs::OpenOptionsExt;
        self.closing.store(true, Ordering::SeqCst);
        // Release the waiting writer: open for reading without blocking.
        const O_NONBLOCK: i32 = if cfg!(target_os = "linux") {
            0o4000
        } else {
            0x0004
        };
        let release = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(O_NONBLOCK)
            .open(&self.path);
        // Without the FIFO (its directory already removed) the writer cannot be released: leave it.
        if let (Ok(_), Some(w)) = (&release, self.writer.take()) {
            let _ = w.join();
        }
        drop(release);
    }
}

// ---------------------------------------------------------------------------------------------------------- files

/// Every regular file under `dir` (FIFOs and links are skipped), with its text.
pub fn files_under(dir: &Path) -> Vec<(PathBuf, String)> {
    let mut out = vec![];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                stack.push(p);
            } else if t.is_file() {
                let text =
                    String::from_utf8_lossy(&std::fs::read(&p).unwrap_or_default()).to_string();
                out.push((p, text));
            }
        }
    }
    out.sort();
    out
}
