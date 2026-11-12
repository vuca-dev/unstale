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
                std::thread::spawn(move || {
                    // Read before serving: a guard held through `serve` would block every other connection.
                    let mode = *m.lock().unwrap();
                    serve(stream, &dir, &l, mode)
                });
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
            .env("UNSTALE_DEV_UNSIGNED_CATALOG", "1")
            .env_remove("UNSTALE_CATALOG")
            .env_remove("UNSTALE_CATALOG_KEY")
            // Session start is behind the switch until the release: on here unless a test turns it off.
            .env("UNSTALE_EDGE_INFERENCE", "1")
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
    // The first sync here is not news (the report after setup reads the same records): no line.
    // Unchanged: one conditional request, and no background stage.
    assert_eq!(
        session_start(&env, env.repo.path(), "unchanged catalog"),
        ""
    );
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
        line.starts_with(
            "unstale: 1 new upstream change for next. Run `unstale status --wait 0` to see it."
        ),
        "{line}"
    );
}

fn shard_path(cat: &FixtureCatalog) -> String {
    let idx: serde_json::Value =
        serde_json::from_slice(&std::fs::read(cat.dir.path().join("v1/tech/next.json")).unwrap())
            .unwrap();
    idx["shards"][0]["path"].as_str().unwrap().to_string()
}

const SLOW_LINE: &str = "warning: catalog too slow at session start, so newer changes are missing. The next session retries.\n";

#[test]
fn a_failed_sync_is_one_warning_when_it_starts_failing_not_again_while_it_lasts() {
    let cat = FixtureCatalog::new();
    publish(&cat, 2);
    let srv = Server::start(cat.dir.path().to_path_buf());
    let env = Env::new();
    env.init(&srv.base);
    env.ok(&["session-sync"]);
    env.ok(&["status", "--wait", "0", "--no-animation"]);
    assert_eq!(session_start(&env, env.repo.path(), "all well"), "");

    // The catalog stops answering: said once, in the user's words, with what it costs and what happens next. No
    // raw error, no path.
    srv.set(Mode::Hang);
    assert_eq!(
        session_start(&env, env.repo.path(), "catalog hanging"),
        SLOW_LINE
    );
    assert_eq!(env.state()["warned"], json!("catalog-slow"));
    // Still failing: nothing is said again.
    assert_eq!(session_start(&env, env.repo.path(), "still hanging"), "");
    // Nor days later: what is compared is the kind of trouble, not the wording or the age of the last attempt.
    let mut state = env.state();
    state["last_attempt"] = json!(state["last_attempt"].as_u64().unwrap() - 3 * 86_400);
    std::fs::write(
        env.repo.path().join(".unstale/state/session-sync.json"),
        state.to_string(),
    )
    .unwrap();
    assert_eq!(
        session_start(&env, env.repo.path(), "hanging, days later"),
        ""
    );

    // The catalog answers again and nothing changed there: the failure is over, and `unstale status` shows none.
    srv.set(Mode::Serve);
    assert_eq!(session_start(&env, env.repo.path(), "answering again"), "");
    let s = env.state();
    assert!(
        s.get("failure").is_none() && s.get("warned").is_none(),
        "{s}"
    );
    let status = env.ok(&["status", "--wait", "0", "--no-animation"]);
    assert!(!status.contains("the sync at session start"), "{status}");
    // Failing again later is new, so it is said again.
    srv.set(Mode::Hang);
    assert_eq!(
        session_start(&env, env.repo.path(), "hanging again"),
        SLOW_LINE
    );
}

#[test]
fn a_warning_the_hook_did_not_print_is_still_due() {
    let cat = FixtureCatalog::new();
    publish(&cat, 2);
    let srv = Server::start(cat.dir.path().to_path_buf());
    let env = Env::new();
    env.init(&srv.base);
    env.ok(&["session-sync"]);
    env.ok(&["status", "--wait", "0", "--no-animation"]);
    // A failure already on record that session start has not said yet (as when its deadline cut the line): the
    // record of what was said is written only after printing, so the next session start says it.
    let mut state = env.state();
    state["failure"] =
        json!("next could not be synced: reading /Users/someone/.cache/unstale/v1/x: denied");
    state["last_attempt"] = json!(1);
    std::fs::write(
        env.repo.path().join(".unstale/state/session-sync.json"),
        state.to_string(),
    )
    .unwrap();
    assert!(env.state().get("warned").is_none());
    srv.set(Mode::Hang);
    // The line cannot be delivered (nobody reads the hook's output any more): it is not recorded as said.
    let mut child = env
        .command(env!("CARGO_BIN_EXE_unstale"))
        .arg("notify")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    drop(child.stdout.take());
    assert_eq!(child.wait().unwrap().code(), Some(0));
    assert!(env.state().get("warned").is_none(), "{}", env.state());
    // An unusual failure: summarised, with no raw error and no path; `unstale status` has the detail.
    let line = session_start(&env, env.repo.path(), "a failure not yet said");
    assert!(line.starts_with("warning: "), "{line}");
    assert!(
        !line.contains('/') && !line.contains("denied") && line.trim_end().chars().count() <= 100,
        "{line}"
    );
}

#[test]
fn session_start_is_quick_at_most_one_line_and_exits_0_whatever_fails() {
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
    assert_eq!(
        session_start(&env, env.repo.path(), "catalog hanging"),
        SLOW_LINE
    );
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
        .find(|l| l.starts_with("warning: the sync at session start failed "))
        .unwrap_or_else(|| panic!("{status}"));
    assert!(
        line.ends_with(": the catalog did not answer in time. The next session start tries again."),
        "{line}"
    );

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
        started.elapsed() > Duration::from_millis(1_000),
        "the coverage service was asked and waited for"
    );
    std::fs::remove_file(env.repo.path().join(".unstale/state/coverage.json")).unwrap();
    env.config(|c| c["service"] = json!("http://127.0.0.1:9"));
    srv.set(Mode::Serve);

    // The catalog unreachable.
    env.config(|c| c["catalog"] = json!("http://127.0.0.1:9"));
    // Said once, as its own kind of trouble; still one line, still exit 0.
    assert_eq!(
        session_start(&env, env.repo.path(), "catalog unreachable"),
        "warning: catalog not reached at session start, so newer changes are missing. The next session retries.\n"
    );
    assert_eq!(
        session_start(&env, env.repo.path(), "catalog still unreachable"),
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
    // Earlier background stages have finished (each holds the lock from the moment the hook returns).
    wait_idle(&env);
    std::fs::remove_file(env.repo.path().join(".unstale/state/session-sync.json")).unwrap();
    assert_eq!(
        session_start(&env, env.repo.path(), "provider down, background running"),
        ""
    );
    std::thread::sleep(Duration::from_millis(300));
    // As the hook starts it.
    env.extra.push(("UNSTALE_HOOK_STAGE".into(), "1".into()));
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
    // The hook has returned; the stage it started reaches the hanging catalog whenever the machine gets to it.
    let until = Instant::now() + Duration::from_secs(20);
    let mut log = vec![];
    while !log.contains(&"/v1/root.json hang".to_string()) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
        log.extend(srv.take_log());
    }
    assert!(
        log.contains(&"/v1/root.json hang".to_string()),
        "the background stage is running: {log:?}"
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

/// Each agent's session start, as the agent runs the installed hook, syncs on a fresh install.
#[test]
fn each_agents_session_start_syncs_on_a_fresh_install() {
    let cat = FixtureCatalog::new();
    publish(&cat, 1);
    let srv = Server::start(cat.dir.path().to_path_buf());
    let env = Env::new();
    env.init(&srv.base);
    let repo = env.repo.path();
    let exclude = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
    for line in [
        "/.claude/settings.local.json",
        "/.codex/hooks.json",
        "/.opencode/plugins/unstale-session.js",
    ] {
        assert!(
            exclude.lines().any(|l| l == line),
            "{line} is excluded from Git: {exclude}"
        );
    }
    let fresh = |agent: &str| {
        let _ = std::fs::remove_file(repo.join(".unstale/state/session-sync.json"));
        let _ = std::fs::remove_dir_all(env.cache.path().join("v1"));
        srv.take_log();
        eprintln!("fresh install: {agent}");
    };
    let hook_command = |file: &str| -> String {
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(repo.join(file)).unwrap()).unwrap();
        let starts = v["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(starts.len(), 1, "{v}");
        starts[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let sub = repo.join("src");
    std::fs::create_dir_all(&sub).unwrap();

    // Claude Code runs the command with a shell, in the session's directory, with CLAUDE_PROJECT_DIR set.
    fresh("Claude Code");
    let out = env
        .command("sh")
        .args(["-c", &hook_command(".claude/settings.local.json")])
        .current_dir(&sub)
        .env("CLAUDE_PROJECT_DIR", repo)
        .output()
        .unwrap();
    assert_eq!((out.status.code(), out.stderr.len()), (Some(0), 0));
    wait_for(&env, synced);

    // Codex runs it with a shell in the session's working directory; a project hook runs once the user trusts it.
    fresh("Codex");
    let command = hook_command(".codex/hooks.json");
    assert!(command.ends_with(" notify"), "{command}");
    let out = env
        .command("sh")
        .args(["-c", &command])
        .current_dir(&sub)
        .output()
        .unwrap();
    assert_eq!((out.status.code(), out.stderr.len()), (Some(0), 0));
    wait_for(&env, synced);

    // opencode loads the plugin and sends it a session's start, as 2.x and as 1.x do, played here by a stand-in.
    fresh("opencode");
    let plugin =
        std::fs::read_to_string(repo.join(".opencode/plugins/unstale-session.js")).unwrap();
    assert!(plugin.contains("Managed by unstale"));
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("plugin.mjs"), &plugin).unwrap();
    std::fs::write(dir.path().join("session.mjs"), OPENCODE_SESSION).unwrap();
    let out = env
        .command("node")
        .arg(dir.path().join("session.mjs"))
        .arg(repo)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    wait_for(&env, synced);
    // Any other event does nothing, and a failure never reaches opencode.
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("other events: ignored; failure: contained"),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );

    // Uninstall removes all three, and their Git exclusions.
    env.ok(&["uninstall"]);
    assert!(
        !repo.join(".codex/hooks.json").exists()
            && !repo.join(".opencode/plugins/unstale-session.js").exists()
    );
    let exclude = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap_or_default();
    assert!(
        !exclude.contains("hooks.json") && !exclude.contains("unstale-session.js"),
        "{exclude}"
    );
}

/// A stand-in for opencode: loads the plugin as opencode 2.x does (its default export's `setup`, given the location
/// and the server's event stream) and as opencode 1.x does (its `server` hooks), and sends events. Every process the
/// plugin starts is recorded, and still runs.
const OPENCODE_SESSION: &str = r#"
import { createRequire, syncBuiltinESMExports } from "node:module";
const cp = createRequire(import.meta.url)("node:child_process");
const real = cp.spawn;
const calls = [];
const patch = (f) => { cp.spawn = f; syncBuiltinESMExports(); };
patch((cmd, args, opts) => { calls.push([cmd, ...args]); return real(cmd, args, opts); });
const repo = process.argv[2];
const settle = () => new Promise((r) => setTimeout(r, 200));
const stream = (events) => ({ subscribe: async function* () { for (const e of events) yield e; } });
const { default: plugin } = await import(new URL("./plugin.mjs", import.meta.url));
if (!plugin?.id || typeof plugin.setup !== "function" || typeof plugin.server !== "function") throw new Error("not a 2.x and 1.x plugin");
const expect = (n, what) => {
  if (calls.length !== n) throw new Error(`${what}: ${JSON.stringify(calls)}`);
  const last = calls[n - 1];
  if (n && last.slice(-3).join(" ") !== `-C ${repo} notify`) throw new Error(`${what}: ${JSON.stringify(last)}`);
};
// The server's sessions, as `ctx.session.get` returns them: this repository's, another's, a child of ours.
const other = repo + "-elsewhere";
const sessions = {
  ses_1: { id: "ses_1", location: { directory: repo } },
  ses_2: { id: "ses_2", location: { directory: repo } },
  ses_b: { id: "ses_b", location: { directory: other } },
  ses_c: { id: "ses_c", parentID: "ses_1", location: { directory: repo } },
};
const ctx = (events) => ({
  location: { directory: repo },
  event: stream(events),
  session: { get: async ({ sessionID }) => sessions[sessionID] },
});
// opencode 2.x, a session started in the interface: created, then its executions; one sync.
await plugin.setup(ctx([
  { type: "message.updated", data: {} },
  { type: "session.created", location: { directory: repo }, data: { sessionID: "ses_1", location: { directory: repo } } },
  { type: "session.execution.started", data: { sessionID: "ses_1" } },
  { type: "session.execution.started", data: { sessionID: "ses_1" } },
]));
await settle();
const ignored = calls.length === 1;
expect(1, "2.x session.created");
// The stream is the whole server's: another repository's session, created or only executing, and a child session of
// ours start nothing.
await plugin.setup(ctx([
  { type: "session.created", location: { directory: other }, data: { sessionID: "ses_b", location: { directory: other } } },
  { type: "session.execution.started", data: { sessionID: "ses_b" } },
  { type: "session.created", location: { directory: repo }, data: { sessionID: "ses_c", parentID: "ses_1", location: { directory: repo } } },
  { type: "session.execution.started", data: { sessionID: "ses_c" } },
]));
await settle();
expect(1, "2.x another location, a child session");
await plugin.setup(ctx([{ type: "session.execution.started", data: { sessionID: "ses_b" } }]));
await settle();
expect(1, "2.x another location's run");
// opencode 2.x, `opencode run`: the session is not announced as created; its first execution counts, once, its
// location read from the server.
await plugin.setup(ctx([
  { type: "session.execution.started", data: { sessionID: "ses_2" } },
  { type: "session.execution.started", data: { sessionID: "ses_2" } },
]));
await settle();
expect(2, "2.x opencode run");
// opencode 1.x: the `server` hooks get `session.created`.
const hooks = await plugin.server({ directory: repo });
await hooks.event({ event: { type: "message.updated" } });
await hooks.event({ event: { type: "session.created" } });
expect(3, "1.x session.created");
// Nothing reaches opencode: no event stream, a stream that fails, a process that cannot start.
await plugin.setup({ location: { directory: repo } });
await plugin.setup({ location: { directory: repo }, event: { subscribe: () => { throw new Error("no stream"); } } });
patch(() => { throw new Error("no spawn"); });
sessions.ses_3 = { id: "ses_3", location: { directory: repo } };
await plugin.setup(ctx([{ type: "session.execution.started", data: { sessionID: "ses_3" } }]));
await (await plugin.server({ directory: repo })).event({ event: { type: "session.created" } });
await settle();
console.log(`other events: ${ignored ? "ignored" : "ran"}; failure: contained`);
await new Promise((r) => setTimeout(r, 1500));
"#;

#[test]
fn the_codex_hook_keeps_the_users_entries_and_never_writes_a_file_git_tracks() {
    let env = Env::new();
    let repo = env.repo.path();
    let mine = r#"{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"echo mine"}]}],"Stop":[{"hooks":[{"type":"command","command":"echo stop"}]}]}}"#;
    std::fs::create_dir_all(repo.join(".codex")).unwrap();
    std::fs::write(repo.join(".codex/hooks.json"), mine).unwrap();
    env.init("http://127.0.0.1:9");
    env.init("http://127.0.0.1:9");
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(repo.join(".codex/hooks.json")).unwrap())
            .unwrap();
    let starts = v["hooks"]["SessionStart"].as_array().unwrap();
    assert_eq!(
        starts.len(),
        2,
        "the user's entry plus ours, not repeated: {v}"
    );
    assert_eq!(starts[0]["hooks"][0]["command"], "echo mine");
    assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], "echo stop");
    env.ok(&["uninstall"]);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            &std::fs::read_to_string(repo.join(".codex/hooks.json")).unwrap()
        )
        .unwrap(),
        serde_json::from_str::<serde_json::Value>(mine).unwrap()
    );

    // A hooks file the repository shares (tracked by Git) never gets this machine's executable.
    let env = Env::new();
    let repo = env.repo.path();
    std::fs::create_dir_all(repo.join(".codex")).unwrap();
    std::fs::write(repo.join(".codex/hooks.json"), mine).unwrap();
    Command::new("git")
        .args(["add", "-f", ".codex/hooks.json"])
        .current_dir(repo)
        .status()
        .unwrap();
    env.init("http://127.0.0.1:9");
    assert_eq!(
        std::fs::read_to_string(repo.join(".codex/hooks.json")).unwrap(),
        mine
    );
    // The other agents' session starts are installed as usual.
    assert!(repo.join(".opencode/plugins/unstale-session.js").is_file());
    assert!(
        std::fs::read_to_string(repo.join(".claude/settings.local.json"))
            .unwrap()
            .contains(" notify")
    );
}

#[test]
fn a_changed_manifest_or_a_failed_technology_starts_a_sync_while_the_catalog_is_unchanged() {
    let cat = FixtureCatalog::new();
    publish(&cat, 1);
    cat.tech(
        "prisma",
        &[("6", vec![rec("prisma:a", "pkg:npm/prisma", "6.19.0")])],
    );
    list(&cat, &["next", "prisma"]);
    let srv = Server::start(cat.dir.path().to_path_buf());
    let env = Env::new();
    env.init(&srv.base);
    env.ok(&["session-sync"]);
    assert!(synced(&env.state()), "{}", env.state());
    srv.take_log();
    // A new dependency: the hook asks the catalog nothing and the background stage syncs it.
    let repo = env.repo.path();
    std::fs::write(
        repo.join("package.json"),
        r#"{"name":"app","private":true,"dependencies":{"next":"16.0.1","prisma":"6.19.0"}}"#,
    )
    .unwrap();
    std::fs::create_dir_all(repo.join("node_modules/prisma")).unwrap();
    std::fs::write(
        repo.join("node_modules/prisma/package.json"),
        r#"{"name":"prisma","version":"6.19.0"}"#,
    )
    .unwrap();
    session_start(&env, repo, "manifest changed");
    wait_for(&env, |s| s["technologies"] == json!(["next", "prisma"]));
    let log = srv.take_log();
    assert_eq!(
        log.first().map(String::as_str),
        Some("/v1/root.json 200"),
        "no quick request first: {log:?}"
    );
    assert!(
        log.contains(&"/v1/tech/prisma.json 200".to_string()),
        "{log:?}"
    );
    // A technology that failed to sync stays in the set, so the next session start tries it again.
    cat.tech(
        "next",
        &[(
            "16",
            vec![
                rec("next:r0", "pkg:npm/next", "16.0.1"),
                rec("next:r1", "pkg:npm/next", "16.0.1"),
            ],
        )],
    );
    list(&cat, &["next", "prisma"]);
    let shard = cat.dir.path().join(shard_path(&cat));
    let bytes = std::fs::read(&shard).unwrap();
    std::fs::remove_file(&shard).unwrap();
    env.ok(&["session-sync"]);
    let s = env.state();
    assert!(
        s["failure"]
            .as_str()
            .is_some_and(|f| f.starts_with("next could not be synced")),
        "{s}"
    );
    assert_eq!(s["technologies"], json!(["next", "prisma"]));
    std::fs::write(&shard, bytes).unwrap();
    srv.take_log();
    session_start(&env, repo, "after a failed technology");
    wait_for(&env, |s| s.get("failure").is_none());
    assert_eq!(
        srv.take_log()[0],
        "/v1/technologies.json 304",
        "the list was unchanged; the cached index was not"
    );
}

#[test]
fn a_codex_hooks_file_that_cannot_be_read_is_left_alone() {
    let env = Env::new();
    // Not a file at all: setup still succeeds and leaves it as it was.
    std::fs::create_dir_all(env.repo.path().join(".codex/hooks.json")).unwrap();
    env.init("http://127.0.0.1:9");
    assert!(env.repo.path().join(".codex/hooks.json").is_dir());
}

#[test]
fn a_background_stage_running_at_uninstall_leaves_nothing_behind() {
    let cat = FixtureCatalog::new();
    publish(&cat, 1);
    let srv = Server::start(cat.dir.path().to_path_buf());
    let env = Env::new();
    env.init(&srv.base);
    // The background stage hangs on the catalog until its request times out (3 s), then writes its state.
    srv.set(Mode::HangAfterList);
    session_start(&env, env.repo.path(), "background stage hanging");
    std::thread::sleep(Duration::from_millis(300));
    env.ok(&["uninstall"]);
    std::thread::sleep(Duration::from_secs(4));
    assert!(
        !env.repo.path().join(".unstale").exists(),
        "the background stage recreated .unstale"
    );
}

/// `unstale status` with model steps on: how long this repository's releases took to reach this machine.
#[test]
fn status_shows_how_long_releases_took_to_reach_this_machine() {
    let cat = FixtureCatalog::new();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let at = |secs_ago: i64| {
        let t = now - secs_ago;
        let (days, rest) = (t.div_euclid(86_400), t.rem_euclid(86_400));
        // Civil date from days (Howard Hinnant), enough for a test.
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = yoe + era * 400 + i64::from(m <= 2);
        format!(
            "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
            rest / 3600,
            rest % 3600 / 60,
            rest % 60
        )
    };
    let event = |version: &str, registry_ago: i64, published_ago: i64| {
        let mut e = testcat::event("next", version, &format!("- Changes in {version}"));
        e["freshness"] = json!({"registry_published": at(registry_ago), "first_seen": at(published_ago + 600), "first_published": at(published_ago)});
        e
    };
    let publish = |events: Vec<serde_json::Value>| {
        cat.tech_events(
            "next",
            0,
            &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1")])],
            &[("16", events)],
        );
        list(&cat, &["next"]);
    };
    publish(vec![event("16.0.1", 90 * 86_400, 89 * 86_400)]);
    let srv = Server::start(cat.dir.path().to_path_buf());
    let mut env = Env::new();
    env.extra = vec![("UNSTALE_EDGE_INFERENCE".into(), "1".into())];
    env.init(&srv.base);
    // The first sync here: what it finds was published before this machine followed the technology.
    env.ok(&["session-sync"]);
    let status = env.ok(&["status", "--wait", "0", "--no-animation"]);
    assert!(
        !status.contains("Registry to catalog"),
        "nothing to report, so no line: {status}"
    );
    // A release published 2 h ago, 5 h after the registry had it, synced now.
    publish(vec![
        event("16.0.1", 90 * 86_400, 89 * 86_400),
        event("16.0.2", 7 * 3600, 2 * 3600),
    ]);
    env.ok(&["session-sync"]);
    let status = env.ok(&["status", "--wait", "0", "--no-animation"]);
    // Two short lines, aligned with the rest of the status block.
    assert!(
        status.contains(
            "Registry to catalog   5h median, 5h for the slowest tenth (1 release, last 30 days)\nCatalog to here       2h median, 2h for the slowest tenth\n"
        ),
        "{status}"
    );
    // With model steps off, events are not synced and the line is not shown.
    env.extra = vec![("UNSTALE_EDGE_INFERENCE".into(), "0".into())];
    assert!(
        !env.ok(&["status", "--wait", "0", "--no-animation"])
            .contains("Registry to catalog")
    );
}

/// Files under the repository and the cache, relative, without Git's own.
fn tree(env: &Env) -> Vec<String> {
    let mut out = vec![];
    for (base, name) in [(env.repo.path(), "repo"), (env.cache.path(), "cache")] {
        for p in walk(base) {
            let rel = p.strip_prefix(base).unwrap().display().to_string();
            if !rel.starts_with(".git/") {
                out.push(format!("{name}/{rel}"));
            }
        }
    }
    out.sort();
    out
}

/// With the switch off, setup and session start are what they were before session-start sync: the same files (as
/// a build of the commit before it writes, checked by hand against that build), no catalog request at session start,
/// no other process, no new line.
#[test]
fn with_the_switch_off_setup_and_session_start_are_as_before() {
    let cat = FixtureCatalog::new();
    publish(&cat, 1);
    let srv = Server::start(cat.dir.path().to_path_buf());
    let mut env = Env::new();
    env.extra = vec![("UNSTALE_EDGE_INFERENCE".into(), "0".into())];
    env.init(&srv.base);
    srv.take_log();
    assert_eq!(session_start(&env, env.repo.path(), "switch off"), "");
    let status = env.ok(&["status", "--wait", "0", "--no-animation"]);
    assert_eq!(
        session_start(&env, env.repo.path(), "switch off, after status"),
        ""
    );
    std::thread::sleep(Duration::from_millis(300));
    // Only status asked the catalog (its own sync); session start asked nothing.
    assert!(srv.take_log().iter().all(|l| !l.contains("hang")));
    assert!(
        !status.contains("Sync at agent session start")
            && !status.contains("Freshness on this machine")
            && !status.contains("Codex session start"),
        "{status}"
    );
    let want = [
        "repo/.agents/skills/unstale-review/SKILL.md",
        "repo/.agents/skills/unstale-review/agents/openai.yaml",
        "repo/.claude/settings.local.json",
        "repo/.claude/skills/unstale-review/SKILL.md",
        "repo/.claude/skills/unstale-review/agents/openai.yaml",
        // opencode's `/unstale-review`, the review's own command: not session start, so with the switch off too.
        "repo/.opencode/commands/unstale-review.md",
        "repo/.unstale/.gitignore",
        "repo/.unstale/config.json",
        "repo/.unstale/coverage.md",
        "repo/.unstale/ledger.jsonl",
        "repo/.unstale/onboarding-report.md",
        "repo/.unstale/review/opportunities.md",
        "repo/.unstale/review/upgrades.md",
        "repo/.unstale/skills/review/SKILL.md",
        "repo/.unstale/state/coverage.json",
        "repo/.unstale/state/integration-conflicts.json",
        "repo/.unstale/state/onboarding-log.txt",
        "repo/.unstale/state/review.json",
        "repo/node_modules/next/package.json",
        "repo/package.json",
    ];
    let got: Vec<String> = tree(&env)
        .into_iter()
        .filter(|f| f.starts_with("repo/"))
        .collect();
    assert_eq!(got, want);
    let exclude = std::fs::read_to_string(env.repo.path().join(".git/info/exclude")).unwrap();
    assert!(
        !exclude.contains("hooks.json") && !exclude.contains("unstale-session.js"),
        "{exclude}"
    );
    // The hook written is the one written before, byte for byte.
    let exe = std::fs::canonicalize(env!("CARGO_BIN_EXE_unstale")).unwrap();
    let before = format!(
        "{}\n",
        serde_json::to_string_pretty(&json!({"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": format!("\"{}\" -C \"$CLAUDE_PROJECT_DIR\" notify", exe.display()), "timeout": 10}]}]}}))
            .unwrap()
    );
    if !exe
        .display()
        .to_string()
        .contains(['$', '`', '"', '\\', '\''])
    {
        assert_eq!(
            std::fs::read_to_string(env.repo.path().join(".claude/settings.local.json")).unwrap(),
            before
        );
    }
}

/// Waits until no background stage holds the repository's lock.
fn wait_idle(env: &Env) {
    let lock = env.repo.path().join(".unstale/state/session-sync.lock");
    let until = Instant::now() + Duration::from_secs(10);
    while let Ok(f) = std::fs::OpenOptions::new().write(true).open(&lock) {
        if f.try_lock().is_ok() {
            return;
        }
        assert!(
            Instant::now() < until,
            "a background stage is still running"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn installers_never_write_a_tracked_read_only_or_inline_configured_file() {
    // Claude Code's settings tracked by Git: left exactly as they are.
    let env = Env::new();
    let repo = env.repo.path();
    let mine = "{ \"model\": \"x\" }\n";
    std::fs::create_dir_all(repo.join(".claude")).unwrap();
    std::fs::write(repo.join(".claude/settings.local.json"), mine).unwrap();
    Command::new("git")
        .args(["add", "-f", ".claude/settings.local.json"])
        .current_dir(repo)
        .status()
        .unwrap();
    env.init("http://127.0.0.1:9");
    assert_eq!(
        std::fs::read_to_string(repo.join(".claude/settings.local.json")).unwrap(),
        mine
    );

    // Read-only hooks files: left alone, still read-only; `unstale status` says why Codex's was not installed.
    let env = Env::new();
    let repo = env.repo.path();
    for f in [".claude/settings.local.json", ".codex/hooks.json"] {
        std::fs::create_dir_all(repo.join(f).parent().unwrap()).unwrap();
        std::fs::write(repo.join(f), mine).unwrap();
        let mut p = std::fs::metadata(repo.join(f)).unwrap().permissions();
        p.set_readonly(true);
        std::fs::set_permissions(repo.join(f), p).unwrap();
    }
    env.init("http://127.0.0.1:9");
    for f in [".claude/settings.local.json", ".codex/hooks.json"] {
        assert_eq!(std::fs::read_to_string(repo.join(f)).unwrap(), mine, "{f}");
        assert!(
            std::fs::metadata(repo.join(f))
                .unwrap()
                .permissions()
                .readonly(),
            "{f} stayed read-only"
        );
    }
    let status = env.ok(&["status", "--wait", "0", "--no-animation"]);
    assert!(
        status.contains("Codex session start not installed: .codex/hooks.json is read-only"),
        "{status}"
    );

    // Hooks defined inline in .codex/config.toml: no second form is added, and status says so.
    let env = Env::new();
    let repo = env.repo.path();
    std::fs::create_dir_all(repo.join(".codex")).unwrap();
    std::fs::write(
        repo.join(".codex/config.toml"),
        "[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = \"command\"\ncommand = \"echo\"\n",
    )
    .unwrap();
    env.init("http://127.0.0.1:9");
    assert!(!repo.join(".codex/hooks.json").exists());
    let status = env.ok(&["status", "--wait", "0", "--no-animation"]);
    assert!(
        status
            .contains("Codex session start not installed: .codex/config.toml defines hooks inline"),
        "{status}"
    );

    // A hooks.json the installer cannot read as the JSON object Codex expects (comments, a syntax error, another
    // shape): left as it is, and status gives the reason.
    for mine in [
        "{\n  // my hooks\n  \"hooks\": {}\n}\n",
        "{ \"hooks\": ",
        "[]\n",
        "{\"hooks\": []}\n",
    ] {
        let env = Env::new();
        let repo = env.repo.path();
        std::fs::create_dir_all(repo.join(".codex")).unwrap();
        std::fs::write(repo.join(".codex/hooks.json"), mine).unwrap();
        env.init("http://127.0.0.1:9");
        assert_eq!(
            std::fs::read_to_string(repo.join(".codex/hooks.json")).unwrap(),
            mine
        );
        let status = env.ok(&["status", "--wait", "0", "--no-animation"]);
        assert!(
            status.contains("Codex session start not installed: .codex/hooks.json is not plain JSON with a \"hooks\" object (comments, a syntax error or another shape)"),
            "{mine:?}:\n{status}"
        );
    }
}

#[test]
fn an_executable_path_a_shell_would_expand_is_never_run_as_code() {
    let dir = tempfile::tempdir().unwrap();
    let odd = dir
        .path()
        .join("a b 'q' \"d\" $(touch pwned) `touch pwned2`");
    std::fs::create_dir_all(&odd).unwrap();
    let exe = odd.join("unstale");
    std::fs::copy(env!("CARGO_BIN_EXE_unstale"), &exe).unwrap();
    let env = Env::new();
    let run = |args: &[&str]| {
        env.command(exe.to_str().unwrap())
            .args(args)
            .output()
            .unwrap()
    };
    let out = run(&[
        "init",
        "--catalog",
        "http://127.0.0.1:9",
        "--service",
        "http://127.0.0.1:9",
        "--mode",
        "local",
        "--yes",
        "--wait",
        "0",
        "--no-animation",
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let repo = env.repo.path();
    for (file, extra) in [
        (
            ".claude/settings.local.json",
            vec![("CLAUDE_PROJECT_DIR", repo.to_str().unwrap())],
        ),
        (".codex/hooks.json", vec![]),
    ] {
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(repo.join(file)).unwrap()).unwrap();
        let command = v["hooks"]["SessionStart"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string();
        let mut c = env.command("sh");
        c.args(["-c", &command]).current_dir(dir.path());
        for (k, val) in extra {
            c.env(k, val);
        }
        let out = c.output().unwrap();
        assert_eq!(
            (
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).to_string()
            ),
            (Some(0), String::new()),
            "{file}: {command}"
        );
    }
    wait_idle(&env);
    assert!(
        !dir.path().join("pwned").exists()
            && !dir.path().join("pwned2").exists()
            && !repo.join("pwned").exists(),
        "the path was run as code"
    );
    assert!(
        repo.join(".unstale/state/session-sync.json").is_file(),
        "the hook ran the executable at that path"
    );
}

#[test]
fn only_manifests_start_a_sync_and_a_repository_with_nothing_covered_asks_once_and_stops() {
    let cat = FixtureCatalog::new();
    publish(&cat, 1);
    let srv = Server::start(cat.dir.path().to_path_buf());
    let env = Env::new();
    // Nothing this repository uses is in the catalog.
    std::fs::write(
        env.repo.path().join("package.json"),
        r#"{"name":"app","private":true,"dependencies":{"left-pad":"1.3.0"}}"#,
    )
    .unwrap();
    env.init(&srv.base);
    env.ok(&["session-sync"]);
    assert_eq!(env.state()["technologies"], json!([]));
    srv.take_log();
    // Editing a README is not a reason to sync.
    std::fs::write(env.repo.path().join("README.md"), "# notes\n").unwrap();
    for case in ["nothing covered", "README edited"] {
        session_start(&env, env.repo.path(), case);
        wait_idle(&env);
        assert_eq!(srv.take_log(), vec!["/v1/technologies.json 304"], "{case}");
    }
}

#[test]
fn a_rebuilt_cache_is_not_reported_as_new_records() {
    let cat = FixtureCatalog::new();
    publish(&cat, 3);
    let srv = Server::start(cat.dir.path().to_path_buf());
    let env = Env::new();
    env.init(&srv.base);
    env.ok(&["session-sync"]);
    std::fs::remove_dir_all(env.cache.path().join("v1")).unwrap();
    env.ok(&["session-sync"]);
    assert!(env.state().get("arrived").is_none(), "{}", env.state());
    assert_eq!(
        session_start(&env, env.repo.path(), "after a rebuilt cache"),
        ""
    );
}

#[test]
fn the_last_failure_shows_once_in_status_with_its_age() {
    let cat = FixtureCatalog::new();
    publish(&cat, 1);
    let srv = Server::start(cat.dir.path().to_path_buf());
    let env = Env::new();
    env.init(&srv.base);
    env.ok(&["session-sync"]);
    srv.set(Mode::Hang);
    session_start(&env, env.repo.path(), "catalog hanging");
    srv.set(Mode::Serve);
    let status = env.ok(&["status", "--wait", "0", "--no-animation"]);
    assert!(status.contains("warning: the sync at session start failed just now: the catalog did not answer in time. The next session start tries again."), "{status}");
    let again = env.ok(&["status", "--wait", "0", "--no-animation"]);
    assert!(!again.contains("the sync at session start"), "{again}");
}
