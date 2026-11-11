#![cfg(unix)]
//! The client's model steps through the binary (`unstale internal run-step`, hidden): a local mock server answers each
//! prompt with central's recorded answer. No request leaves the machine.

use serde_json::Value;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::{Arc, Mutex};

/// Answers chat completions by the prompt's sha256; counts requests.
fn router(answers: Vec<(String, String, String)>) -> (String, Arc<Mutex<usize>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let n = Arc::new(Mutex::new(0));
    let count = n.clone();
    std::thread::spawn(move || {
        for mut s in listener.incoming().flatten() {
            let (mut got, mut buf) = (Vec::new(), [0u8; 65536]);
            let body = loop {
                let k = s.read(&mut buf).unwrap_or(0);
                got.extend_from_slice(&buf[..k]);
                let Some(end) = got.windows(4).position(|w| w == b"\r\n\r\n") else {
                    if k == 0 {
                        break String::new();
                    }
                    continue;
                };
                let head = String::from_utf8_lossy(&got[..end]).to_ascii_lowercase();
                let len = head
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                    })
                    .unwrap_or(0);
                if k == 0 || got.len() >= end + 4 + len {
                    break String::from_utf8_lossy(&got[end + 4..]).to_string();
                }
            };
            *count.lock().unwrap() += 1;
            let prompt = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v["messages"][0]["content"].as_str().map(String::from))
                .unwrap_or_default();
            let sha = {
                use std::fmt::Write as _;
                let d = <sha2::Sha256 as sha2::Digest>::digest(prompt.as_bytes());
                d.iter().fold(String::new(), |mut s, b| {
                    let _ = write!(s, "{b:02x}");
                    s
                })
            };
            let reply = match answers.iter().find(|a| a.0 == sha) {
                Some((_, content, finish)) => serde_json::json!({"model": "gpt-6-luna", "choices": [{"message": {"content": content}, "finish_reason": finish}], "usage": {"prompt_tokens": 10, "completion_tokens": 2}}).to_string(),
                None => "{}".into(),
            };
            let _ = write!(
                s,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
        }
    });
    (url, n)
}

fn fixture() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/js-port/fixtures.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn run_step(cache: &std::path::Path, events: &std::path::Path, url: &str, switch: bool) -> String {
    let mut c = Command::new(env!("CARGO_BIN_EXE_unstale"));
    c.args(["internal", "run-step", "--step", "extract", "--in"])
        .arg(events)
        .args([
            "--provider",
            "custom",
            "--model",
            "gpt-6-luna",
            "--key-env",
            "UNSTALE_TEST_STEP_KEY",
            "--base-url",
            url,
        ]);
    c.env("UNSTALE_CACHE_DIR", cache)
        // The user's own config: none of this machine's, and where the test sets the user's token limit.
        .env("UNSTALE_CONFIG_DIR", cache.join("user-config"))
        .env("UNSTALE_TEST_STEP_KEY", "k")
        .env_remove("UNSTALE_EDGE_INFERENCE");
    if switch {
        c.env("UNSTALE_EDGE_INFERENCE", "1");
    }
    let out = c.output().unwrap();
    assert!(
        out.status.success(),
        "exit 0 always: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

#[test]
fn run_step_extract_prints_centrals_records_and_a_second_run_asks_nothing() {
    let f = fixture();
    let case = f["extractions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "release-notes")
        .unwrap()
        .clone();
    let answers = case["exchanges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["prompt_sha256"].as_str().unwrap().to_string(),
                e["content"].as_str().unwrap().to_string(),
                e["finish"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let (url, n) = router(answers);
    let dir = tempfile::tempdir().unwrap();
    let events = dir.path().join("events.jsonl");
    std::fs::write(&events, format!("{}\n", case["event"])).unwrap();
    let cache = dir.path().join("cache");

    // With the switch off: one deferral line, no call.
    let off = run_step(&cache, &events, &url, false);
    assert!(off.contains("turned off"), "{off}");
    assert_eq!(*n.lock().unwrap(), 0);

    // The user's monthly token limit holds for a named provider too: at the limit, one line and no call.
    std::fs::create_dir_all(cache.join("user-config")).unwrap();
    std::fs::write(cache.join("user-config/config.json"), r#"{"monthly_token_limit": 0}"#).unwrap();
    let limited = run_step(&cache, &events, &url, true);
    assert!(limited.contains("warning: monthly token limit reached, so new release notes wait."), "{limited}");
    assert_eq!(*n.lock().unwrap(), 0);
    std::fs::remove_file(cache.join("user-config/config.json")).unwrap();

    let out = run_step(&cache, &events, &url, true);
    let line: Value = serde_json::from_str(out.lines().next().unwrap()).unwrap();
    assert_eq!(line["event"], case["event"]["id"]);
    assert_eq!(line["incoming"], case["incoming"]);
    assert_eq!(line["provenance"]["prompt_version"], 2);
    assert_eq!(*n.lock().unwrap(), 2);
    let again = run_step(&cache, &events, &url, true);
    assert_eq!(again, out);
    assert_eq!(
        *n.lock().unwrap(),
        2,
        "every answer came from the user-level cache"
    );
}

#[path = "../src/testcat.rs"]
mod testcat;

/// A labelling-service mock: `no` wherever it is an option, else the first option; counts requests.
fn jev(allow: Arc<Mutex<usize>>) -> (String, Arc<Mutex<usize>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let n = Arc::new(Mutex::new(0));
    let count = n.clone();
    std::thread::spawn(move || {
        for mut s in listener.incoming().flatten() {
            let (mut got, mut buf) = (Vec::new(), [0u8; 65536]);
            let body = loop {
                let k = s.read(&mut buf).unwrap_or(0);
                got.extend_from_slice(&buf[..k]);
                let Some(end) = got.windows(4).position(|w| w == b"\r\n\r\n") else {
                    if k == 0 {
                        break String::new();
                    }
                    continue;
                };
                let head = String::from_utf8_lossy(&got[..end]).to_ascii_lowercase();
                let len = head
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                    })
                    .unwrap_or(0);
                if k == 0 || got.len() >= end + 4 + len {
                    break String::from_utf8_lossy(&got[end + 4..]).to_string();
                }
            };
            *count.lock().unwrap() += 1;
            // Past the allowance the key is refused: the pass stops there.
            if *count.lock().unwrap() > *allow.lock().unwrap() {
                let _ = write!(
                    s,
                    "HTTP/1.1 401 X\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                );
                continue;
            }
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let mut answers = serde_json::Map::new();
            for (id, q) in v["questions"].as_object().into_iter().flatten() {
                let opts: Vec<String> =
                    q["criteria"].as_object().unwrap().keys().cloned().collect();
                let choice = if opts.iter().any(|o| o == "no") {
                    "no".to_string()
                } else {
                    opts[0].clone()
                };
                let probs: serde_json::Map<String, Value> = opts
                    .iter()
                    .map(|o| {
                        (
                            o.clone(),
                            serde_json::json!(if *o == choice { 0.9 } else { 0.1 }),
                        )
                    })
                    .collect();
                answers.insert(id.clone(), serde_json::json!({"choice": choice, "confidence": 0.9, "probabilities": probs}));
            }
            let reply = serde_json::json!({"model": "jev-1.14.0", "answers": answers, "usage": {"input_tokens": 10, "output_tokens": 1}}).to_string();
            let _ = write!(
                s,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
        }
    });
    (url, n)
}

struct Repo {
    repo: tempfile::TempDir,
    cache: tempfile::TempDir,
    _cat: testcat::FixtureCatalog,
    main: String,
    jev: String,
}

impl Repo {
    fn run(&self, args: &[&str], switch: bool) -> String {
        let mut c = Command::new(env!("CARGO_BIN_EXE_unstale"));
        c.args(args)
            .current_dir(self.repo.path())
            .env("UNSTALE_CACHE_DIR", self.cache.path())
            .env("UNSTALE_CONFIG_DIR", self.cache.path().join("user-config"))
            .env("UNSTALE_TODAY", "2026-11-10")
            .env("UNSTALE_NO_REGISTRY", "1")
            .env("AI_GATEWAY_API_KEY", "k1")
            .env("JEV_API_KEY", "k2")
            .env("UNSTALE_INFERENCE_BASE_URL", &self.main)
            .env("UNSTALE_LABELS_BASE_URL", &self.jev)
            .env_remove("UNSTALE_CATALOG")
            .env_remove("UNSTALE_EDGE_INFERENCE")
            .stdin(std::process::Stdio::null());
        if switch {
            c.env("UNSTALE_EDGE_INFERENCE", "1");
        }
        let out = c.output().unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap()
    }
}

/// A repository using `example` 2.0.0, a catalog whose records cover 2.0.0 and whose change events reach 2.1.0, and a
/// stored choice (gateway route for extraction, the labelling service for labels and matching).
fn repo(allow: Arc<Mutex<usize>>) -> (Repo, Arc<Mutex<usize>>, Arc<Mutex<usize>>) {
    use testcat::{FixtureCatalog, rec, with};
    let f = fixture();
    let case = f["extractions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "release-notes")
        .unwrap()
        .clone();
    let mut ev = case["event"].clone();
    ev["date"] = serde_json::json!("2026-10-01");
    // An exact release (the fixture's is bounded, as a moving page's), so the report can place it.
    ev.as_object_mut().unwrap().remove("no_later_than");
    let cat = FixtureCatalog::new();
    let old = with(
        rec("example:server.port", "pkg:npm/example", "2.0.0"),
        serde_json::json!({"subject": "server.port", "summary": "The default port is now 4000."}),
    );
    cat.tech_events("example", 0, &[("2", vec![old])], &[("2", vec![ev])]);
    let answers = case["exchanges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["prompt_sha256"].as_str().unwrap().to_string(),
                e["content"].as_str().unwrap().to_string(),
                e["finish"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let (main, mn) = router(answers);
    let (jev, jn) = jev(allow);
    let repo = tempfile::tempdir().unwrap();
    std::fs::write(
        repo.path().join("package.json"),
        r#"{"name":"app","private":true,"dependencies":{"example":"2.0.0"}}"#,
    )
    .unwrap();
    std::fs::create_dir(repo.path().join(".git")).unwrap();
    let r = Repo {
        repo,
        cache: tempfile::tempdir().unwrap(),
        _cat: cat,
        main,
        jev,
    };
    r.run(&["init", "--catalog", r._cat.loc()], false);
    let cfg = r.repo.path().join(".unstale/config.json");
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
    v["inference"] = serde_json::json!({"provider": "vercel", "key_env": "AI_GATEWAY_API_KEY", "labels": {"provider": "jev", "key_env": "JEV_API_KEY"}});
    std::fs::write(&cfg, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    (r, mn, jn)
}

/// The client's records for `example` on disk.
fn local_records(r: &Repo) -> usize {
    std::fs::read(r.cache.path().join("inference/records/example.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["records"].as_object().map(|o| o.len()))
        .unwrap_or(0)
}

#[test]
fn with_the_switch_on_the_report_reads_records_the_client_made_and_off_nothing_changes() {
    let (r, main, jev) = repo(Arc::new(Mutex::new(usize::MAX)));
    r.run(&["sync"], false);
    // A second sync: the cache settled (the first one downloads).
    let off_sync = r.run(&["sync"], false);
    let off_bump = r.run(&["bump", "example"], false);
    assert_eq!(
        (*main.lock().unwrap(), *jev.lock().unwrap()),
        (0, 0),
        "off: no model call"
    );
    assert!(!off_bump.contains("defineConfig"));

    // `unstale sync` itself makes no model call even with the switch on: the backlog is the background stage's.
    r.run(&["sync"], true);
    assert_eq!(*main.lock().unwrap(), 0);
    // The session-start stage (`unstale session-sync`) runs the steps.
    r.run(&["session-sync"], true);
    assert_eq!(*main.lock().unwrap(), 2);
    assert_eq!(local_records(&r), 4);
    let on_bump = r.run(&["bump", "example"], true);
    assert!(on_bump.contains("defineConfig"), "{on_bump}");

    // Off again, with the client's records on disk: the same output as before they existed, and no call.
    let calls = (*main.lock().unwrap(), *jev.lock().unwrap());
    assert_eq!(r.run(&["sync"], false), off_sync);
    assert_eq!(r.run(&["bump", "example"], false), off_bump);
    assert_eq!((*main.lock().unwrap(), *jev.lock().unwrap()), calls);
    // On again: nothing new to ask.
    r.run(&["session-sync"], true);
    assert_eq!((*main.lock().unwrap(), *jev.lock().unwrap()), calls);
}

/// A pass the labelling service stops partway (its key refused after three requests) resumes on the next session
/// start with the switch on and finishes the release: a release is never counted done by the client's own records.
#[test]
fn a_pass_stopped_mid_release_finishes_it_on_the_next_one() {
    let allow = Arc::new(Mutex::new(3));
    let (r, main, jev) = repo(allow.clone());
    r.run(&["sync"], false);
    r.run(&["session-sync"], true);
    let first = local_records(&r);
    assert!(first > 0 && first < 4, "stopped partway: {first} of 4");
    // What `unstale status` shows: the stage did not finish, and why.
    let state = std::fs::read_to_string(r.repo.path().join(".unstale/state/session-sync.json"))
        .unwrap_or_default();
    assert!(state.contains("warning: the provider rejected the key"), "{state}");
    *allow.lock().unwrap() = usize::MAX;
    let extracted = *main.lock().unwrap();
    r.run(&["session-sync"], true);
    assert_eq!(local_records(&r), 4, "the rest of the release");
    assert_eq!(
        *main.lock().unwrap(),
        extracted,
        "extraction answers came from the cache"
    );
    assert!(*jev.lock().unwrap() > 3);
}

/// The model steps run only in the session-start background stage. A repository whose agent has no session-start hook,
/// or that turns the session-start sync off, is told so by `status` and `report` while releases wait, with the command
/// that runs the stage; once it has run, the line is gone.
#[test]
fn work_nothing_will_run_is_said_once_with_the_command_that_runs_it() {
    let (r, main, _) = repo(Arc::new(Mutex::new(usize::MAX)));
    for hook in [
        ".claude/settings.local.json",
        ".codex/hooks.json",
        ".opencode/plugins/unstale-session.js",
    ] {
        let _ = std::fs::remove_file(r.repo.path().join(hook));
    }
    r.run(&["sync"], true);
    std::fs::write(
        r.repo.path().join(".unstale/onboarding-report.md"),
        "# Report\n",
    )
    .unwrap();
    let line = "warning: no session-start hook here, so 1 new release note is unread. Run `unstale session-sync`.";
    let report = r.run(&["report"], true);
    assert_eq!(report.lines().filter(|l| *l == line).count(), 1, "{report}");
    assert!(
        !r.run(&["report"], false).contains("warning:"),
        "switch off: nothing"
    );
    // A hook is installed: it runs the stage, nothing to say.
    std::fs::create_dir_all(r.repo.path().join(".claude")).unwrap();
    std::fs::write(
        r.repo.path().join(".claude/settings.local.json"),
        r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"unstale notify"}]}]}}"#,
    )
    .unwrap();
    assert!(!r.run(&["report"], true).contains("warning:"));
    // The session-start sync turned off: said too.
    let cfg = r.repo.path().join(".unstale/config.json");
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
    v["session_sync"] = serde_json::json!(false);
    std::fs::write(&cfg, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    assert!(r.run(&["report"], true).contains(
        "warning: `session_sync` is off in .unstale/config.json, so 1 new release note is unread. Remove it."
    ));
    // Without a hook, the manual way: the stage runs, the release is read, the line goes.
    std::fs::remove_file(r.repo.path().join(".claude/settings.local.json")).unwrap();
    v["session_sync"] = serde_json::Value::Null;
    std::fs::write(&cfg, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    assert!(r.run(&["report"], true).contains(line));
    r.run(&["session-sync"], true);
    assert_eq!(*main.lock().unwrap(), 2);
    assert!(!r.run(&["report"], true).contains("warning:"));
}

/// `unstale session-sync` by hand ends with one line saying what it read; stopped partway (Ctrl-C), the next run
/// finishes without paying again for what was answered.
#[test]
fn session_sync_by_hand_says_what_it_read_and_resumes_after_an_interrupt() {
    let (r, main, _) = repo(Arc::new(Mutex::new(usize::MAX)));
    r.run(&["sync"], true);
    // Interrupted as soon as the first answer has come back.
    let mut c = Command::new(env!("CARGO_BIN_EXE_unstale"));
    c.arg("session-sync")
        .current_dir(r.repo.path())
        .env("UNSTALE_CACHE_DIR", r.cache.path())
        .env("UNSTALE_CONFIG_DIR", r.cache.path().join("user-config"))
        .env("UNSTALE_TODAY", "2026-11-10")
        .env("UNSTALE_NO_REGISTRY", "1")
        .env("AI_GATEWAY_API_KEY", "k1")
        .env("JEV_API_KEY", "k2")
        .env("UNSTALE_INFERENCE_BASE_URL", &r.main)
        .env("UNSTALE_LABELS_BASE_URL", &r.jev)
        .env("UNSTALE_EDGE_INFERENCE", "1")
        .env_remove("UNSTALE_CATALOG")
        .stdout(std::process::Stdio::null());
    let mut child = c.spawn().unwrap();
    let t0 = std::time::Instant::now();
    while *main.lock().unwrap() < 1 && t0.elapsed() < std::time::Duration::from_secs(20) {
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let _ = Command::new("kill").args(["-INT", &child.id().to_string()]).status();
    let _ = child.wait();
    let paid = *main.lock().unwrap();
    let out = r.run(&["session-sync"], true);
    assert_eq!(local_records(&r), 4, "{out}");
    assert!(
        *main.lock().unwrap() <= paid + 2,
        "the second run pays at most for what the first did not keep"
    );
    let last = out.lines().last().unwrap_or_default();
    assert!(last.starts_with("New release notes read: 4 new changes") || last.starts_with("Nothing new to read"), "{out}");
    // Nothing left: said in one line.
    let again = r.run(&["session-sync"], true);
    assert_eq!(again.trim(), "Nothing new to read: every release note here is read.");
}

/// `unstale session-sync` with "Not now" recorded (a choice of none) says no provider is chosen, not that another
/// unstale is reading: nothing else runs, and nothing is read.
#[test]
fn session_sync_with_not_now_recorded_says_no_provider_is_chosen() {
    let (r, main, _) = repo(Arc::new(Mutex::new(usize::MAX)));
    let cfg = r.repo.path().join(".unstale/config.json");
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
    v["inference"] = serde_json::json!({"provider": "none"});
    std::fs::write(&cfg, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    let out = r.run(&["session-sync"], true);
    assert_eq!(
        out.lines().last().unwrap_or_default(),
        "No provider is chosen, so no release notes were read. Choose one: `unstale setup`.",
        "{out}"
    );
    assert_eq!(*main.lock().unwrap(), 0, "no model call");
}
