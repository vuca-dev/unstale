//! Session start (session.rs), driven through the binary: each agent's hook as installed, the hook's guarantees
//! (within 2 s, exit 0, at most one line, nothing on stderr) in every failure, and the requests it costs.

#[path = "../src/testcat.rs"]
mod testcat;

use serde_json::json;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use testcat::{FixtureCatalog, rec};

/// The guarantee every session start is held to.
const LIMIT: Duration = Duration::from_secs(2);

/// How the catalog server answers.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Serve,
    /// Accepts the connection and never answers.
    Hang,
    /// Answers the technologies list, hangs on everything else (the background stage is still running).
    HangAfterList,
}

/// A catalog over HTTP: serves `dir` with an ETag (a hash of the body), answers a matching If-None-Match with 304,
/// logs `"<path> <status>"`.
struct Server {
    base: String,
    log: Arc<Mutex<Vec<String>>>,
    mode: Arc<Mutex<Mode>>,
}

impl Server {
    fn start(dir: PathBuf) -> Server {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let log = Arc::new(Mutex::new(vec![]));
        let mode = Arc::new(Mutex::new(Mode::Serve));
        let (l, m) = (log.clone(), mode.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (dir, l, m) = (dir.clone(), l.clone(), m.clone());
                std::thread::spawn(move || serve(stream, &dir, &l, *m.lock().unwrap()));
            }
        });
        Server { base, log, mode }
    }
    fn take_log(&self) -> Vec<String> {
        std::mem::take(&mut *self.log.lock().unwrap())
    }
    fn set(&self, m: Mode) {
        *self.mode.lock().unwrap() = m;
    }
}

fn serve(mut stream: std::net::TcpStream, dir: &Path, log: &Mutex<Vec<String>>, mode: Mode) {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut got = vec![];
    let mut buf = [0u8; 4096];
    while !String::from_utf8_lossy(&got).contains("\r\n\r\n") {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => got.extend_from_slice(&buf[..n]),
        }
    }
    let req = String::from_utf8_lossy(&got).to_string();
    let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
    if mode == Mode::Hang || (mode == Mode::HangAfterList && path != "/v1/technologies.json") {
        log.lock().unwrap().push(format!("{path} hang"));
        std::thread::sleep(Duration::from_secs(20));
        return;
    }
    let inm = req.lines().find_map(|l| {
        l.to_ascii_lowercase()
            .strip_prefix("if-none-match:")
            .map(|v| v.trim().to_string())
    });
    let (status, head, body) = match std::fs::read(dir.join(path.trim_start_matches('/'))) {
        Ok(b) => {
            let etag = format!("\"{}\"", sha(&b));
            if inm.as_deref() == Some(etag.as_str()) {
                (304, format!("ETag: {etag}\r\n"), vec![])
            } else {
                (200, format!("ETag: {etag}\r\n"), b)
            }
        }
        Err(_) => (404, String::new(), vec![]),
    };
    log.lock().unwrap().push(format!("{path} {status}"));
    let _ = write!(
        stream,
        "HTTP/1.1 {status} X\r\n{head}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(&body);
}

fn sha(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

/// The catalog's list of technologies, naming each index with the first 16 hex digits of its hash.
fn list(cat: &FixtureCatalog, techs: &[&str]) {
    let named: serde_json::Map<String, serde_json::Value> = techs
        .iter()
        .map(|t| {
            (
                t.to_string(),
                json!(
                    sha(&std::fs::read(cat.dir.path().join(format!("v1/tech/{t}.json"))).unwrap())
                        [..16]
                ),
            )
        })
        .collect();
    std::fs::write(
        cat.dir.path().join("v1/technologies.json"),
        json!({"schema": 1, "technologies": named}).to_string(),
    )
    .unwrap();
}

fn publish(cat: &FixtureCatalog, records: usize) {
    let recs = (0..records)
        .map(|i| rec(&format!("next:r{i}"), "pkg:npm/next", "16.0.1"))
        .collect();
    cat.tech("next", &[("16", recs)]);
    list(cat, &["next"]);
}

struct Env {
    repo: tempfile::TempDir,
    cache: tempfile::TempDir,
    home: tempfile::TempDir,
    extra: Vec<(String, String)>,
}

impl Env {
    fn new() -> Env {
        let repo = tempfile::tempdir().unwrap();
        let p = repo.path();
        std::fs::write(
            p.join("package.json"),
            r#"{"name":"app","private":true,"dependencies":{"next":"16.0.1"}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(p.join("node_modules/next")).unwrap();
        std::fs::write(
            p.join("node_modules/next/package.json"),
            r#"{"name":"next","version":"16.0.1"}"#,
        )
        .unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(p)
            .status()
            .unwrap();
        Env {
            repo,
            cache: tempfile::tempdir().unwrap(),
            home: tempfile::tempdir().unwrap(),
            extra: vec![],
        }
    }
    fn command(&self, program: &str) -> Command {
        let mut c = Command::new(program);
        c.current_dir(self.repo.path())
            .env("HOME", self.home.path())
            .env("UNSTALE_CACHE_DIR", self.cache.path())
            .env("UNSTALE_TODAY", "2026-11-10")
            .env("UNSTALE_NO_REGISTRY", "1")
            .env("UNSTALE_HTTP_TIMEOUT", "3")
            .env_remove("UNSTALE_CATALOG")
            .env_remove("UNSTALE_CATALOG_KEY")
            .env_remove("UNSTALE_EDGE_INFERENCE")
            .stdin(Stdio::null());
        for (k, v) in &self.extra {
            c.env(k, v);
        }
        c
    }
    fn run_in(&self, dir: &Path, args: &[&str]) -> (i32, String, String, Duration) {
        let started = Instant::now();
        let out = self
            .command(env!("CARGO_BIN_EXE_unstale"))
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into(),
            String::from_utf8_lossy(&out.stderr).into(),
            started.elapsed(),
        )
    }
    fn ok(&self, args: &[&str]) -> String {
        let (code, out, err, _) = self.run_in(self.repo.path(), args);
        assert_eq!(code, 0, "{args:?}\nstdout:\n{out}\nstderr:\n{err}");
        out
    }
    fn init(&self, catalog: &str) {
        // The coverage service is down: setup installs the integration and never waits on it.
        self.ok(&[
            "init",
            "--catalog",
            catalog,
            "--service",
            "http://127.0.0.1:9",
            "--mode",
            "local",
            "--yes",
            "--wait",
            "0",
            "--no-animation",
        ]);
    }
    fn state(&self) -> serde_json::Value {
        std::fs::read(self.repo.path().join(".unstale/state/session-sync.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(serde_json::Value::Null)
    }
    fn config(&self, edit: impl FnOnce(&mut serde_json::Value)) {
        let p = self.repo.path().join(".unstale/config.json");
        let mut c: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        edit(&mut c);
        std::fs::write(p, c.to_string()).unwrap();
    }
}

/// The hook as an agent runs it: stdout and stderr read to their end, so a process that kept either open would hold
/// the session; within 2 s, exit 0, at most one line, nothing on stderr.
fn session_start(env: &Env, dir: &Path, case: &str) -> String {
    let (code, out, err, took) = env.run_in(dir, &["notify"]);
    eprintln!("session start, {case}: {} ms", took.as_millis());
    assert_eq!(code, 0, "{case}: exit {code}\nstdout: {out}\nstderr: {err}");
    assert!(took < LIMIT, "{case}: took {took:?}");
    assert!(out.lines().count() <= 1, "{case}: {out}");
    assert_eq!(err, "", "{case}");
    out
}

/// Waits for the background stage to leave `want` in the state.
fn wait_for(env: &Env, want: impl Fn(&serde_json::Value) -> bool) -> serde_json::Value {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let s = env.state();
        if want(&s) {
            return s;
        }
        assert!(
            Instant::now() < until,
            "the background stage did not finish: {s}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn synced(s: &serde_json::Value) -> bool {
    s["technologies"] == json!(["next"])
}

#[test]
fn an_unchanged_catalog_costs_one_request_and_a_changed_one_syncs_in_the_background() {
    let cat = FixtureCatalog::new();
    publish(&cat, 2);
    let srv = Server::start(cat.dir.path().to_path_buf());
    let env = Env::new();
    env.init(&srv.base);
    srv.take_log();
    // A fresh install: nothing is known yet, so the hook asks for nothing and the background stage syncs.
    assert_eq!(session_start(&env, env.repo.path(), "fresh install"), "");
    let s = wait_for(&env, synced);
    assert!(s.get("failure").is_none(), "{s}");
    let first = srv.take_log();
    eprintln!("requests, first session start: {first:?}");
    assert_eq!(
        first,
        vec![
            "/v1/root.json 200",
            "/v1/technologies.json 200",
            "/v1/tech/next.json 200",
            &format!("/{} 200", shard_path(&cat))
        ]
    );
    // The first sync's records are new to this repository: one line at the next session start.
    // Unchanged: one conditional request, and no background stage.
    let line = session_start(&env, env.repo.path(), "unchanged catalog");
    assert!(line.starts_with("unstale: 2 new upstream records for 1 technology this repository uses since the last onboarding report."), "{line}");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(srv.take_log(), vec!["/v1/technologies.json 304"]);
    // `unstale status` refreshes the report: the line is no longer new.
    env.ok(&["status", "--wait", "0", "--no-animation"]);
    srv.take_log();
    assert_eq!(session_start(&env, env.repo.path(), "after status"), "");
    assert_eq!(srv.take_log(), vec!["/v1/technologies.json 304"]);
    // A new record: the list changed (200), the background stage fetches only what changed.
    publish(&cat, 3);
    assert_eq!(session_start(&env, env.repo.path(), "changed catalog"), "");
    wait_for(&env, |s| s["arrived"]["records"] == json!(1));
    let changed = srv.take_log();
    eprintln!("requests, changed catalog: {changed:?}");
    assert_eq!(changed.len(), 5, "{changed:?}");
    assert_eq!(
        &changed[..4],
        [
            "/v1/technologies.json 200",
            "/v1/root.json 200",
            "/v1/technologies.json 200",
            "/v1/tech/next.json 200"
        ]
    );
    let line = session_start(&env, env.repo.path(), "new record");
    assert!(
        line.starts_with("unstale: 1 new upstream records for 1 technology"),
        "{line}"
    );
}

fn shard_path(cat: &FixtureCatalog) -> String {
    let idx: serde_json::Value =
        serde_json::from_slice(&std::fs::read(cat.dir.path().join("v1/tech/next.json")).unwrap())
            .unwrap();
    idx["shards"][0]["path"].as_str().unwrap().to_string()
}

#[test]
fn session_start_is_quick_silent_and_exits_0_whatever_fails() {
    let cat = FixtureCatalog::new();
    publish(&cat, 2);
    let srv = Server::start(cat.dir.path().to_path_buf());
    let mut env = Env::new();
    env.init(&srv.base);
    env.ok(&["session-sync"]);
    assert!(synced(&env.state()), "{}", env.state());
    session_start(&env, env.repo.path(), "records arrived");
    env.ok(&["status", "--wait", "0", "--no-animation"]);

    // Not a repository, and a repository without unstale.
    let elsewhere = tempfile::tempdir().unwrap();
    assert_eq!(
        session_start(&env, elsewhere.path(), "not a repository"),
        ""
    );
    Command::new("git")
        .args(["init", "-q"])
        .current_dir(elsewhere.path())
        .status()
        .unwrap();
    assert_eq!(
        session_start(&env, elsewhere.path(), "no configuration"),
        ""
    );
    let gone = elsewhere.path().join("removed");
    assert_eq!(
        env.run_in(elsewhere.path(), &["-C", gone.to_str().unwrap(), "notify"])
            .0,
        0,
        "a directory that is not there"
    );

    // The catalog hanging: the request is bounded and nothing is waited for.
    srv.set(Mode::Hang);
    assert_eq!(session_start(&env, env.repo.path(), "catalog hanging"), "");
    let s = env.state();
    assert_eq!(
        s["failure"],
        json!("the catalog did not answer in time"),
        "kept for unstale status: {s}"
    );
    // ... and `unstale status` says so (the coverage service and the catalog are both down for it too).
    srv.set(Mode::Serve);
    let status = env.ok(&["status", "--wait", "0", "--no-animation"]);
    let line = status
        .lines()
        .find(|l| l.starts_with("Sync at agent session start: "))
        .unwrap_or_else(|| panic!("{status}"));
    assert!(line.ends_with(" did not finish: the catalog did not answer in time. The next session start tries again"), "{line}");

    // The catalog and the coverage service both hanging, with shared coverage still growing (so the hook asks it):
    // the worst case, bounded by the hook's deadline. The service accepts connections and never answers.
    srv.set(Mode::Hang);
    let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    env.config(|c| c["service"] = json!(format!("http://{}", silent.local_addr().unwrap())));
    let job = json!({"jobs": {"pkg:npm/next": {"purl": "pkg:npm/next", "technology": "next", "name": "next", "state": "queued", "stage": "", "records": 1, "updated": ""}}});
    std::fs::write(
        env.repo.path().join(".unstale/state/coverage.json"),
        job.to_string(),
    )
    .unwrap();
    let started = Instant::now();
    assert_eq!(
        session_start(
            &env,
            env.repo.path(),
            "catalog and coverage service hanging"
        ),
        ""
    );
    assert!(
        started.elapsed() > Duration::from_millis(1_200),
        "the coverage service was asked and waited for"
    );
    std::fs::remove_file(env.repo.path().join(".unstale/state/coverage.json")).unwrap();
    env.config(|c| c["service"] = json!("http://127.0.0.1:9"));
    srv.set(Mode::Serve);

    // The catalog unreachable.
    env.config(|c| c["catalog"] = json!("http://127.0.0.1:9"));
    assert_eq!(
        session_start(&env, env.repo.path(), "catalog unreachable"),
        ""
    );
    env.config(|c| c["catalog"] = json!(srv.base));

    // The cache corrupt: every file replaced with bytes that do not parse.
    for entry in walk(env.cache.path()) {
        std::fs::write(entry, b"\x00not json").unwrap();
    }
    assert_eq!(session_start(&env, env.repo.path(), "cache corrupt"), "");
    // The state corrupt.
    std::fs::write(
        env.repo.path().join(".unstale/state/session-sync.json"),
        b"{{{",
    )
    .unwrap();
    assert_eq!(session_start(&env, env.repo.path(), "state corrupt"), "");
    // The configuration corrupt.
    let config = std::fs::read(env.repo.path().join(".unstale/config.json")).unwrap();
    std::fs::write(env.repo.path().join(".unstale/config.json"), b"{").unwrap();
    assert_eq!(
        session_start(&env, env.repo.path(), "configuration corrupt"),
        ""
    );
    std::fs::write(env.repo.path().join(".unstale/config.json"), &config).unwrap();

    // The cache unwritable: its location is a file.
    let file = tempfile::NamedTempFile::new().unwrap();
    env.extra = vec![(
        "UNSTALE_CACHE_DIR".into(),
        file.path().display().to_string(),
    )];
    assert_eq!(session_start(&env, env.repo.path(), "cache unwritable"), "");
    env.extra.clear();

    // Model steps on, the provider down, the background stage still running (it hangs past the list): the hook does
    // not wait for it, and a second background stage exits at once.
    srv.set(Mode::HangAfterList);
    env.extra = vec![
        ("UNSTALE_EDGE_INFERENCE".into(), "1".into()),
        ("OPENAI_BASE_URL".into(), "http://127.0.0.1:9".into()),
    ];
    std::fs::remove_file(env.repo.path().join(".unstale/state/session-sync.json")).unwrap();
    assert_eq!(
        session_start(&env, env.repo.path(), "provider down, background running"),
        ""
    );
    std::thread::sleep(Duration::from_millis(300));
    let (code, out, err, took) = env.run_in(env.repo.path(), &["session-sync"]);
    eprintln!("background stage, lock held: {} ms", took.as_millis());
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
    assert!(
        took < Duration::from_secs(1),
        "the second background stage waited: {took:?}"
    );
    assert_eq!(session_start(&env, env.repo.path(), "lock held"), "");
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p))
        } else {
            out.push(p)
        }
    }
    out
}

#[test]
fn the_hook_never_waits_for_the_background_stage() {
    let cat = FixtureCatalog::new();
    publish(&cat, 1);
    let srv = Server::start(cat.dir.path().to_path_buf());
    let env = Env::new();
    env.init(&srv.base);
    // The background stage hangs on its first request; the hook's output still ends at once.
    srv.set(Mode::HangAfterList);
    assert_eq!(
        session_start(&env, env.repo.path(), "background stage hanging"),
        ""
    );
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        srv.take_log().contains(&"/v1/root.json hang".to_string()),
        "the background stage is running"
    );
}

#[test]
fn one_config_line_turns_the_session_start_sync_off() {
    let cat = FixtureCatalog::new();
    publish(&cat, 1);
    let srv = Server::start(cat.dir.path().to_path_buf());
    let env = Env::new();
    env.init(&srv.base);
    env.config(|c| c["session_sync"] = json!(false));
    // Setup again keeps the line.
    env.init(&srv.base);
    assert!(
        std::fs::read_to_string(env.repo.path().join(".unstale/config.json"))
            .unwrap()
            .contains("\"session_sync\": false")
    );
    srv.take_log();
    assert_eq!(session_start(&env, env.repo.path(), "opted out"), "");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(srv.take_log(), Vec::<String>::new());
    assert_eq!(env.state(), serde_json::Value::Null);
}
