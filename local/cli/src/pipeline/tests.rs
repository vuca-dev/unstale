//! The client's extraction against central's own output: replayed answers through a local mock server and a fake
//! `codex`. No request leaves the machine.

use super::extract::{Extractor, STEP_EXTRACT};
use super::js;
use super::results::{Outcome, Results};
use crate::inference::{Inference, Ledger, Limits, ProviderConfig};
use crate::util::sha256_hex;
use serde_json::Value;
use serde_json::value::RawValue;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use unstale_schema::catalog::{EventChunk, EventLine, EvidenceKind, Freshness};

/// A chat-completions server that answers each prompt by its sha256 from a table; `(prefix, status)` overrides stand in
/// for a provider failing. Every raw request body is kept.
pub struct Router {
    pub url: String,
    pub bodies: Arc<Mutex<Vec<String>>>,
}

pub type Answers = BTreeMap<String, (String, String)>;
type Fail = Vec<(String, u16)>;

impl Router {
    pub fn new(answers: Answers, fail: Fail) -> Router {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let seen = bodies.clone();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let (mut got, mut buf) = (Vec::new(), [0u8; 65536]);
                let body = loop {
                    let k = stream.read(&mut buf).unwrap_or(0);
                    got.extend_from_slice(&buf[..k]);
                    let Some(end) = got.windows(4).position(|w| w == b"\r\n\r\n") else {
                        if k == 0 {
                            break String::new();
                        }
                        continue;
                    };
                    let head = String::from_utf8_lossy(&got[..end]).to_ascii_lowercase();
                    let length = head
                        .lines()
                        .find_map(|l| {
                            l.strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if k == 0 || got.len() >= end + 4 + length {
                        break String::from_utf8_lossy(&got[end + 4..]).to_string();
                    }
                };
                seen.lock().unwrap().push(body.clone());
                let prompt = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|v| v["messages"][0]["content"].as_str().map(String::from))
                    .unwrap_or_default();
                let (status, reply) = match fail.iter().find(|(p, _)| prompt.starts_with(p.as_str())) {
                    Some((_, s)) => (*s, "{}".to_string()),
                    None => match answers.get(&sha256_hex(prompt.as_bytes())) {
                        Some((content, finish)) => (
                            200,
                            serde_json::json!({"model": "gpt-6-luna-2026-10-01", "choices": [{"message": {"content": content}, "finish_reason": finish}], "usage": {"prompt_tokens": 100, "completion_tokens": 20}}).to_string(),
                        ),
                        None => (500, "{}".to_string()),
                    },
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
            }
        });
        Router { url, bodies }
    }

    pub fn count(&self) -> usize {
        self.bodies.lock().unwrap().len()
    }
}

pub fn inference(provider: ProviderConfig, base: &str, dir: &std::path::Path) -> Inference {
    let mut p = provider;
    p.base_url = base.into();
    p.key_env = Some("TEST_KEY".into());
    let mut i = Inference::new(p).with_env(|k| match k {
        "TEST_KEY" => Some("test-key-value".into()),
        "PATH" => std::env::var("PATH").ok(),
        _ => None,
    });
    i.ledger = Ledger::new(dir.join("inference"));
    i.limits = Limits {
        timeout: Duration::from_secs(10),
        retries: 0,
        backoff: Duration::ZERO,
    };
    i
}

/// `JSON.stringify(v, null, 1)` text made compact: the bytes central sent.
pub fn compact(pretty: &str) -> String {
    let (mut out, mut in_str, mut esc) = (String::with_capacity(pretty.len()), false, false);
    for ch in pretty.chars() {
        if in_str {
            out.push(ch);
            match (esc, ch) {
                (true, _) => esc = false,
                (false, '\\') => esc = true,
                (false, '"') => in_str = false,
                _ => {}
            }
        } else if ch == '"' {
            in_str = true;
            out.push(ch);
        } else if !ch.is_whitespace() {
            out.push(ch);
        }
    }
    out
}

#[derive(serde::Deserialize)]
struct Exchange {
    prompt_sha256: String,
    body: Box<RawValue>,
    content: String,
    finish: String,
}

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    event: EventLine,
    exchanges: Vec<Exchange>,
    incoming: Value,
    failed: usize,
}

fn cases() -> Vec<Case> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/js-port/fixtures.json");
    let text = std::fs::read_to_string(p).unwrap();
    #[derive(serde::Deserialize)]
    struct F {
        extractions: Vec<Case>,
    }
    serde_json::from_str::<F>(&text).unwrap().extractions
}

fn answers_of(c: &Case) -> Answers {
    c.exchanges
        .iter()
        .map(|e| {
            (
                e.prompt_sha256.clone(),
                (e.content.clone(), e.finish.clone()),
            )
        })
        .collect()
}

/// The bodies sent, as a sorted multiset, byte for byte against central's.
fn same_requests(sent: &[String], central: &[Exchange], what: &str) {
    let mut got: Vec<String> = sent.to_vec();
    let mut want: Vec<String> = central.iter().map(|e| compact(e.body.get())).collect();
    got.sort();
    want.sort();
    assert_eq!(got.len(), want.len(), "{what}: request count");
    for (g, w) in got.iter().zip(&want) {
        assert_eq!(g, w, "{what}: request bytes");
    }
}

#[test]
fn extraction_sends_centrals_request_bytes_and_builds_centrals_records() {
    for c in cases() {
        let dir = tempfile::tempdir().unwrap();
        let m = Router::new(answers_of(&c), vec![]);
        let inf = inference(ProviderConfig::vercel(), &m.url, dir.path());
        let results = Results::at(dir.path());
        let x = Extractor::new(&inf, &results);
        let out = x
            .event(&c.event)
            .unwrap_or_else(|d| panic!("{}: {d}", c.name));
        same_requests(&m.bodies.lock().unwrap(), &c.exchanges, &c.name);
        assert_eq!(
            serde_json::to_value(&out.incoming).unwrap(),
            c.incoming,
            "{}: records",
            c.name
        );
        assert_eq!(out.failed, c.failed, "{}: failed calls", c.name);
        // Each answer is cached at once: the same event again makes no call.
        let before = m.count();
        let again = Extractor::new(&inf, &results).event(&c.event).unwrap();
        assert_eq!(m.count(), before, "{}: a second run asks nothing", c.name);
        assert_eq!(again.incoming, out.incoming);
    }
}

/// An event built here as central's `eventOf` builds one from a note.
pub fn event(
    id: &str,
    name: &str,
    version: &str,
    date: &str,
    notes: &str,
    kind: EvidenceKind,
) -> EventLine {
    let chunks = js::chunk(notes, js::MAX_CHUNK)
        .into_iter()
        .enumerate()
        .map(|(i, text)| EventChunk {
            id: format!("{id}#{i}"),
            sha256: sha256_hex(text.as_bytes()),
            content_free: js::js_trim(&text).is_empty() || js::content_free(&text),
            text,
        })
        .collect();
    EventLine {
        id: id.into(),
        technology: id.split('@').next().unwrap().into(),
        name: name.into(),
        kind,
        version: version.into(),
        line: js::release_line(version),
        date: date.into(),
        prompt_date: None,
        no_later_than: None,
        url: format!("https://github.com/vercel/next.js/releases/tag/v{version}"),
        snapshot: format!("sha256:{version}"),
        chunks,
        freshness: Freshness {
            registry_published: None,
            first_seen: "x".into(),
            first_published: "x".into(),
            backfilled: false,
        },
    }
}

#[derive(serde::Deserialize)]
pub struct Captured {
    pub body: Box<RawValue>,
}

/// Central's request snapshot (`central/test/fixtures/prompt-requests.json`), each body as the bytes central sent.
pub fn snapshot() -> BTreeMap<String, Vec<String>> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../central/test/fixtures/prompt-requests.json");
    let snap: BTreeMap<String, Vec<Captured>> =
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    snap.into_iter()
        .map(|(k, v)| (k, v.iter().map(|c| compact(c.body.get())).collect()))
        .collect()
}

/// For the same notes, the client sends central's bytes for both extraction calls, the chat body's key order included.
#[test]
fn extraction_requests_equal_centrals_snapshot_bytes() {
    let snap = snapshot();
    let records = r#"[{"subject":"after","subject_kind":"literal","facet":null,"change_type":"new_api","surface":"code_api","summary":"after() runs work once a response finishes.","audience":"application","introduces":["after"],"evidence":"Adds `after`"},{"subject":"images.minimumCacheTTL","subject_kind":"literal","facet":null,"change_type":"default_change","surface":"configuration","summary":"The default minimum cache TTL is now four hours.","audience":"application","introduces":[],"evidence":"minimumCacheTTL default is now 4 hours"}]"#;
    let labels = r#"{"r1":{"terms":["after"],"replaces":[],"requires":[],"prerequisites":[],"conditions":[]}}"#;
    let notes = "## Features\n\n- Adds `after` to run work once a response finishes.\n- `images.minimumCacheTTL` default is now 4 hours.\n\n## Breaking\n\n- Node.js 18 is no longer supported; Node.js 20.9 is required.";
    let long: String = (0..470)
        .map(|i| format!("- Fix `route{i}` handling of trailing slashes in nested segments."))
        .collect::<Vec<_>>()
        .join("\n");
    for (case, ev) in [
        (
            "extract.two-call.release-notes",
            event(
                "next@16.3.2",
                "Next.js",
                "16.3.2",
                "2026-08-21",
                notes,
                EvidenceKind::ReleaseNotes,
            ),
        ),
        (
            "extract.two-call.multi-part",
            event(
                "next@16.4.0",
                "Next.js",
                "16.4.0",
                "2026-08-21",
                &long,
                EvidenceKind::ReleaseNotes,
            ),
        ),
        (
            "extract.two-call.upgrade-guide",
            event(
                "next@16.0.0+guide.0123abcd",
                "Next.js",
                "16.0.0",
                "2026-08-21",
                notes,
                EvidenceKind::UpgradeGuide,
            ),
        ),
    ] {
        // Answered as the snapshot's stub answered: records to an extract call, labels to a label call.
        let want = snap[case].clone();
        let answers: Answers = want
            .iter()
            .map(|b| {
                let v: Value = serde_json::from_str(b).unwrap();
                let prompt = v["messages"][0]["content"].as_str().unwrap().to_string();
                let a = if prompt.starts_with("You write search terms") {
                    labels
                } else {
                    records
                };
                (
                    sha256_hex(prompt.as_bytes()),
                    (a.to_string(), "stop".to_string()),
                )
            })
            .collect();
        let dir = tempfile::tempdir().unwrap();
        let m = Router::new(answers, vec![]);
        let inf = inference(ProviderConfig::vercel(), &m.url, dir.path());
        let results = Results::at(dir.path());
        Extractor::new(&inf, &results).event(&ev).unwrap();
        let mut got = m.bodies.lock().unwrap().clone();
        let mut want = want;
        got.sort();
        want.sort();
        assert_eq!(got, want, "{case}");
    }
}

#[test]
fn an_interrupted_run_resumes_without_paying_twice_and_another_repo_asks_nothing() {
    let c = cases()
        .into_iter()
        .find(|c| c.name == "release-notes")
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let results = Results::at(dir.path());
    // The label call is refused: the step defers, the extract answer it paid for stays.
    let down = Router::new(answers_of(&c), vec![("You write search terms".into(), 401)]);
    let inf = inference(ProviderConfig::vercel(), &down.url, dir.path());
    let d = Extractor::new(&inf, &results).event(&c.event).unwrap_err();
    assert_eq!(d, crate::inference::Deferred::Auth);
    assert_eq!(down.count(), 2);
    // The next run makes only the call that was missing.
    let up = Router::new(answers_of(&c), vec![]);
    let inf = inference(ProviderConfig::vercel(), &up.url, dir.path());
    let out = Extractor::new(&inf, &results).event(&c.event).unwrap();
    assert_eq!(up.count(), 1);
    assert_eq!(serde_json::to_value(&out.incoming).unwrap(), c.incoming);
    let prov = out.provenance.unwrap();
    assert_eq!(
        (
            prov.provider.as_str(),
            prov.model.as_str(),
            prov.prompt_version
        ),
        (
            "vercel",
            "gpt-6-luna@low",
            crate::prompts::prompts().extract.version
        )
    );
    assert_eq!(prov.model_version.as_deref(), Some("gpt-6-luna-2026-10-01"));
    // Another repository on the machine, another route to the same model: the shared cache answers everything.
    let other = Router::new(answers_of(&c), vec![]);
    let inf = inference(ProviderConfig::openai(), &other.url, dir.path());
    Extractor::new(&inf, &results).event(&c.event).unwrap();
    assert_eq!(other.count(), 0);
}

/// A fake `codex` that logs each call's arguments and prints `out`.
#[cfg(unix)]
pub fn fake_codex(dir: &std::path::Path, out: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(dir.join("out.jsonl"), out).unwrap();
    let log = dir.join("calls");
    std::fs::create_dir_all(&log).unwrap();
    let script = format!(
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex-cli 0.170.0'; exit 0; fi\nif [ \"$1\" = \"login\" ]; then echo 'Logged in using ChatGPT'; exit 0; fi\nn=$(ls '{log}' | wc -l | tr -d ' ')\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > \"{log}/$n.args\"\ncat '{out}'\n",
        log = log.display(),
        out = dir.join("out.jsonl").display()
    );
    let codex = dir.join("codex");
    std::fs::write(&codex, script).unwrap();
    std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
    codex
}

#[cfg(unix)]
#[test]
fn through_codex_extract_calls_go_eight_chunks_at_a_time_answered_by_chunk_id() {
    let dir = tempfile::tempdir().unwrap();
    let all = cases();
    let evs: Vec<&EventLine> = all
        .iter()
        .filter(|c| ["release-notes", "upgrade-guide", "empty-answer"].contains(&c.name.as_str()))
        .map(|c| &c.event)
        .collect();
    let answer = serde_json::json!({"c1": [{"subject": "defineConfig", "summary": "Adds defineConfig.", "evidence": "Adds `defineConfig()`"}], "c2": [], "c3": []});
    let msg = serde_json::json!({"type": "item.completed", "item": {"type": "agent_message", "text": answer.to_string()}});
    let out = format!(
        "{msg}\n{}\n",
        r#"{"type":"turn.completed","usage":{"input_tokens":4299,"cached_input_tokens":2944,"output_tokens":50}}"#
    );
    let codex = fake_codex(dir.path(), &out);
    let mut inf = inference(
        ProviderConfig::codex(),
        &codex.to_string_lossy(),
        dir.path(),
    );
    inf.provider.key_env = None;
    let results = Results::at(dir.path());
    let x = Extractor::new(&inf, &results);
    x.prefetch(&evs).unwrap();
    assert_eq!(x.calls.get(), 1, "three chunks, one call");
    let args = std::fs::read_to_string(dir.path().join("calls/0.args")).unwrap();
    for id in ["c1", "c2", "c3"] {
        assert!(
            args.contains(&format!("<chunk id=\"{id}\" technology=\"Example.js\"")),
            "{id}"
        );
    }
    assert!(args.contains(
        "Output only a JSON object mapping each chunk id to that chunk's JSON array of records"
    ));
    // Each chunk's answer is cached under its own single-call key, so extraction asks no extract call again.
    let ev = evs[0];
    let prompt = x.extract_prompt(ev, &ev.chunks[0].text, "");
    let key = Results::key(
        STEP_EXTRACT,
        "gpt-6-luna@low",
        crate::prompts::prompts().extract.version,
        &ev.chunks[0].sha256,
        &prompt,
    );
    assert!(matches!(
        results.get(&key).unwrap().outcome,
        Outcome::Answer { .. }
    ));
    let r = x.event(ev).unwrap();
    assert_eq!(r.incoming.len(), 1);
    assert_eq!(x.calls.get(), 2, "only the label call is made");
}

#[test]
fn a_key_named_by_the_choice_is_read_from_this_repos_env_file_and_nothing_else_is() {
    // The variable is not in this process's environment, so only the file can have supplied it.
    assert!(std::env::var_os("UNSTALE_TEST_WS4_KEY").is_none());
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(".env"),
        "UNSTALE_TEST_WS4_KEY=dotenv-secret-1\nUNSTALE_TEST_WS4_OTHER=canary-not-consented\n",
    )
    .unwrap();
    let choice = crate::setup::Choice {
        provider: "openai".into(),
        key_env: Some("UNSTALE_TEST_WS4_KEY".into()),
        labels: None,
    };
    let mut r = super::routes(&choice, Some(dir.path())).unwrap();
    assert!(r.labels.is_none(), "no labelling service in this choice");
    let m = Router::new(Default::default(), vec![]);
    r.main.provider.base_url = m.url.clone();
    r.main.ledger = Ledger::new(dir.path().join("inference"));
    r.main.limits = Limits {
        timeout: Duration::from_secs(5),
        retries: 0,
        backoff: Duration::ZERO,
    };
    let _ = r.main.complete(&crate::inference::Prompt::new("hi"));
    assert_eq!(m.count(), 1, "the key was found, so the call was made");
    // Neither value reached a request body, the ledger or any cache file.
    for p in walk(dir.path()) {
        if p.file_name().is_some_and(|n| n == ".env") {
            continue;
        }
        let t = std::fs::read_to_string(&p).unwrap_or_default();
        assert!(
            !t.contains("dotenv-secret-1") && !t.contains("canary-not-consented"),
            "{}",
            p.display()
        );
    }
    assert!(
        !m.bodies
            .lock()
            .unwrap()
            .iter()
            .any(|b| b.contains("dotenv-secret-1") || b.contains("canary"))
    );
}

fn walk(d: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = vec![];
    for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p))
        } else {
            out.push(p)
        }
    }
    out
}

/// A cache as a sync with the switch on leaves it, from a fixture catalog: indexes and record shards, change events
/// beside them.
fn cache_from(cat: &crate::testcat::FixtureCatalog) -> tempfile::TempDir {
    let cache = tempfile::tempdir().unwrap();
    for f in walk(cat.dir.path()) {
        let rel = f
            .strip_prefix(cat.dir.path())
            .unwrap()
            .to_string_lossy()
            .to_string();
        let to = if rel.contains(".events.") {
            rel.replace("v1/shards/", "v1/events/")
        } else {
            rel
        };
        let to = cache.path().join(to);
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::copy(&f, &to).unwrap();
    }
    cache
}

#[test]
fn work_is_only_releases_the_catalog_has_no_records_for_in_demand_order_inside_the_window() {
    use crate::testcat::{FixtureCatalog, event, rec, with};
    let cat = FixtureCatalog::new();
    let dated = |e: Value, d: &str| with(e, serde_json::json!({"date": d}));
    // next: 16.0.1 has catalog records (no call), 16.0.2 and 16.0.3 do not; 15.0.0 is older than the window.
    cat.tech_events(
        "next",
        0,
        &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1")])],
        &[(
            "16",
            vec![
                dated(event("next", "16.0.1", "- a"), "2026-10-01"),
                dated(event("next", "16.0.2", "- b"), "2026-10-05"),
                dated(event("next", "16.0.3", "- c"), "2026-10-09"),
                dated(event("next", "15.0.0", "- d"), "2025-01-01"),
            ],
        )],
    );
    // react names two of this stack's packages, next one: react comes first.
    cat.tech_events(
        "react",
        0,
        &[(
            "19",
            vec![
                rec("react:a", "pkg:npm/react", "19.0.0"),
                rec("react:b", "pkg:npm/react-dom", "19.0.0"),
            ],
        )],
        &[(
            "19",
            vec![dated(event("react", "19.1.0", "- e"), "2026-09-01")],
        )],
    );
    let cache = cache_from(&cat);
    let techs: std::collections::BTreeSet<String> = ["next", "react", "never-synced"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let purls = ["pkg:npm/next", "pkg:npm/react", "pkg:npm/react-dom"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let plan = super::plan(cache.path(), &techs, &purls, "2026-11-10");
    let got: Vec<(String, Vec<String>)> = plan
        .iter()
        .map(|p| {
            (
                p.technology.clone(),
                p.events.iter().map(|e| e.version.clone()).collect(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("react".into(), vec!["19.1.0".into()]),
            ("next".into(), vec!["16.0.3".into(), "16.0.2".into()])
        ]
    );
}
