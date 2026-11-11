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
