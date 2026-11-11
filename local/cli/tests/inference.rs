#![cfg(unix)]
//! The provider layer end to end through the binary (`unstale infer`, internal): a local mock server stands in for
//! OpenAI-compatible and Anthropic endpoints and a fake `codex` sits on PATH. No request leaves the machine.

mod support;

use std::path::Path;
use std::process::Command;
use std::time::Duration;
use support::{CODEX_OK, fake_codex, mock};

const CANARY: &str = support::SHELL_CANARY;

const OPENAI_OK: &str = r#"{"model":"m","choices":[{"message":{"content":"{\"ok\":true}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}"#;
const ANTHROPIC_OK: &str = r#"{"model":"claude-haiku-5-5","stop_reason":"end_turn","content":[{"type":"text","text":"{\"ok\":true}"}],"usage":{"input_tokens":10,"output_tokens":2}}"#;

struct Run {
    code: i32,
    stdout: String,
    stderr: String,
}

/// `unstale infer` with a fresh cache, the canary in the key variable and (when given) `bin` first on PATH.
fn infer(cache: &Path, bin: Option<&Path>, args: &[&str]) -> Run {
    let path = match bin {
        Some(b) => format!(
            "{}:{}",
            b.display(),
            std::env::var("PATH").unwrap_or_default()
        ),
        None => std::env::var("PATH").unwrap_or_default(),
    };
    let out = Command::new(env!("CARGO_BIN_EXE_unstale"))
        .arg("infer")
        .args(["--timeout-secs", "1", "--backoff-ms", "0"])
        .args(args)
        .env("UNSTALE_CACHE_DIR", cache)
        .env("UNSTALE_EDGE_INFERENCE", "1")
        .env("CANARY_KEY", CANARY)
        .env("OPENAI_API_KEY", CANARY)
        .env("ANTHROPIC_API_KEY", CANARY)
        .env("PATH", path)
        .output()
        .unwrap();
    Run {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    }
}

fn custom(url: &str) -> Vec<String> {
    [
        "--provider",
        "custom",
        "--base-url",
        url,
        "--key-env",
        "CANARY_KEY",
        "--model",
        "m",
        "Say ok.",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn strs(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

/// Every file under `dir`, read as text.
fn all_text(dir: &Path) -> String {
    let mut out = String::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            out += &all_text(&p);
        } else {
            out += &String::from_utf8_lossy(&std::fs::read(&p).unwrap_or_default());
        }
    }
    out
}

/// The header lines of a raw request that carry `needle`.
fn lines_with(request: &str, needle: &str) -> Vec<String> {
    request
        .split("\r\n")
        .filter(|l| l.contains(needle))
        .map(String::from)
        .collect()
}

#[test]
fn the_key_appears_only_in_the_auth_header() {
    for (provider, ok, header) in [
        ("custom", OPENAI_OK, "authorization: bearer "),
        ("anthropic", ANTHROPIC_OK, "x-api-key: "),
    ] {
        let (url, seen) = mock(200, ok, Duration::ZERO);
        let cache = tempfile::tempdir().unwrap();
        let mut args = custom(&url);
        if provider == "anthropic" {
            args = ["--provider", "anthropic", "--base-url", &url, "Say ok."]
                .iter()
                .map(|s| s.to_string())
                .collect();
        }
        let r = infer(cache.path(), None, &strs(&args));
        assert_eq!(
            (r.code, r.stdout.trim()),
            (0, r#"{"ok":true}"#),
            "{provider}: {}",
            r.stderr
        );
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        let carrying = lines_with(&requests[0], CANARY);
        assert_eq!(
            carrying.len(),
            1,
            "{provider}: the key must be on exactly one line: {carrying:?}"
        );
        assert!(
            carrying[0].to_ascii_lowercase().starts_with(header),
            "{provider}: the key may appear only in the auth header: {carrying:?}"
        );
        assert_eq!(
            carrying[0].len(),
            header.len() + CANARY.len(),
            "{carrying:?}"
        );
        assert!(!r.stdout.contains(CANARY) && !r.stderr.contains(CANARY));
        assert!(
            !all_text(cache.path()).contains(CANARY),
            "{provider}: the key reached the cache or ledger"
        );
        assert!(
            all_text(cache.path()).contains("\"provider\""),
            "the call is in the ledger"
        );
    }
    // An error body that echoes the key does not reach the terminal.
    let (url, _) = mock(
        401,
        &format!(r#"{{"error":{{"message":"Incorrect API key provided: {CANARY}"}}}}"#),
        Duration::ZERO,
    );
    let cache = tempfile::tempdir().unwrap();
    let r = infer(cache.path(), None, &strs(&custom(&url)));
    assert!(
        !r.stdout.contains(CANARY) && !r.stderr.contains(CANARY),
        "{}{}",
        r.stdout,
        r.stderr
    );
}

#[test]
fn codex_on_path_answers_and_never_sees_a_key_from_the_shell() {
    let dir = tempfile::tempdir().unwrap();
    let bin = fake_codex(dir.path(), true, CODEX_OK, 0);
    let cache = tempfile::tempdir().unwrap();
    let r = infer(
        cache.path(),
        Some(&bin),
        &["--provider", "codex", "Say ok."],
    );
    assert_eq!(
        (r.code, r.stdout.trim()),
        (0, r#"{"ok":true}"#),
        "{}",
        r.stderr
    );
    let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
    assert!(
        args.contains("read-only") && args.contains("--ephemeral") && args.contains("gpt-6-luna"),
        "{args}"
    );
    let env = std::fs::read_to_string(dir.path().join("env")).unwrap();
    assert!(!env.contains(CANARY), "a key variable reached Codex: {env}");
    assert!(
        !env.contains("OPENAI_API_KEY") && !env.contains("CANARY_KEY"),
        "{env}"
    );
    let ledger = all_text(cache.path());
    assert!(
        ledger.contains("\"provider\":\"codex\"") && ledger.contains("\"input\":4299"),
        "{ledger}"
    );
}

#[test]
fn every_provider_error_defers_with_one_line_and_exit_0() {
    let cases: Vec<(&str, u16, Duration)> = vec![
        ("the provider did not accept the key", 401, Duration::ZERO),
        ("the provider is rate limiting", 429, Duration::ZERO),
        ("the provider is not answering", 500, Duration::ZERO),
        ("the provider is not answering", 503, Duration::ZERO),
        ("the provider took too long", 200, Duration::from_secs(3)),
        ("is not available on this key or plan", 404, Duration::ZERO),
    ];
    for (want, status, delay) in cases {
        let (url, _) = mock(status, OPENAI_OK, delay);
        let cache = tempfile::tempdir().unwrap();
        let r = infer(cache.path(), None, &strs(&custom(&url)));
        assert_eq!(
            r.code,
            0,
            "HTTP {status}: {r:?}",
            r = (&r.stdout, &r.stderr)
        );
        assert_eq!(r.stdout.lines().count(), 1, "HTTP {status}: {}", r.stdout);
        assert!(
            r.stdout.starts_with("deferred: ") && r.stdout.contains(want),
            "HTTP {status}: {}",
            r.stdout
        );
        assert_eq!(r.stderr, "", "HTTP {status}");
    }
    // Nothing listening, and no key set.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    let cache = tempfile::tempdir().unwrap();
    let r = infer(cache.path(), None, &strs(&custom(&url)));
    assert_eq!(
        (r.code, r.stdout.trim()),
        (
            0,
            "deferred: the provider is not answering; it runs next time"
        )
    );
    let r = infer(
        cache.path(),
        None,
        &[
            "--provider",
            "custom",
            "--base-url",
            &url,
            "--key-env",
            "UNSET_VAR",
            "--model",
            "m",
            "x",
        ],
    );
    assert_eq!(
        (r.code, r.stdout.trim()),
        (0, "deferred: UNSET_VAR is not set")
    );
    // Codex: logged out, and a model not on the plan.
    let not_supported = r#"{"type":"error","message":"The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."}"#;
    for (logged_in, out, code, want) in [
        (
            false,
            CODEX_OK,
            0,
            "deferred: Codex is not logged in; run `codex login`",
        ),
        (
            true,
            not_supported,
            1,
            "deferred: gpt-5.4-mini is not available on this key or plan",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_codex(dir.path(), logged_in, out, code);
        let r = infer(
            cache.path(),
            Some(&bin),
            &["--provider", "codex", "--model", "gpt-5.4-mini", "x"],
        );
        assert_eq!((r.code, r.stdout.trim(), r.stderr.as_str()), (0, want, ""));
    }
}

#[test]
fn a_second_worker_exits_quietly_without_calling_the_provider() {
    let (url, seen) = mock(200, OPENAI_OK, Duration::ZERO);
    let cache = tempfile::tempdir().unwrap();
    let dir = cache.path().join("inference");
    std::fs::create_dir_all(&dir).unwrap();
    let held = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("worker.lock"))
        .unwrap();
    held.try_lock().unwrap();
    let r = infer(cache.path(), None, &strs(&custom(&url)));
    assert_eq!((r.code, r.stdout.as_str(), r.stderr.as_str()), (0, "", ""));
    assert_eq!(seen.lock().unwrap().len(), 0);
    drop(held);
    let r = infer(cache.path(), None, &strs(&custom(&url)));
    assert_eq!((r.code, r.stdout.trim()), (0, r#"{"ok":true}"#));
}

#[test]
fn a_redirect_to_another_host_receives_nothing_and_the_call_defers() {
    for provider in ["custom", "anthropic"] {
        let (elsewhere, reached) = mock(
            200,
            if provider == "custom" {
                OPENAI_OK
            } else {
                ANTHROPIC_OK
            },
            Duration::ZERO,
        );
        let target = elsewhere.replace("127.0.0.1", "localhost");
        let (url, first) = mock(302, &format!("{target}/v1/messages"), Duration::ZERO);
        let cache = tempfile::tempdir().unwrap();
        let args: Vec<String> = if provider == "custom" {
            custom(&url)
        } else {
            ["--provider", "anthropic", "--base-url", &url, "Say ok."]
                .iter()
                .map(|s| s.to_string())
                .collect()
        };
        let r = infer(cache.path(), None, &strs(&args));
        assert_eq!(
            (r.code, r.stdout.trim()),
            (
                0,
                "deferred: the provider address redirects elsewhere; check it"
            ),
            "{provider}: {}",
            r.stderr
        );
        assert_eq!(first.lock().unwrap().len(), 1);
        assert_eq!(
            reached.lock().unwrap().len(),
            0,
            "{provider}: the redirect target received a request (and the key)"
        );
    }
}

#[test]
fn with_model_steps_off_infer_makes_no_call() {
    let (url, seen) = mock(200, OPENAI_OK, Duration::ZERO);
    let cache = tempfile::tempdir().unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_unstale"))
        .arg("infer")
        .args(strs(&custom(&url)))
        .env("UNSTALE_CACHE_DIR", cache.path())
        .env("CANARY_KEY", CANARY)
        .env_remove("UNSTALE_EDGE_INFERENCE")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "deferred: model steps on this machine are turned off"
    );
    assert_eq!(seen.lock().unwrap().len(), 0);
}

#[test]
fn a_corrupt_or_unwritable_ledger_defers_with_one_line() {
    let (url, seen) = mock(200, OPENAI_OK, Duration::ZERO);
    let cache = tempfile::tempdir().unwrap();
    let dir = cache.path().join("inference");
    std::fs::create_dir_all(&dir).unwrap();
    let month = {
        // The client's month: run once to create this month's file, then corrupt it.
        let r = infer(cache.path(), None, &strs(&custom(&url)));
        assert_eq!(r.code, 0);
        std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|p| p.to_string_lossy().contains("usage-"))
            .unwrap()
    };
    let text = std::fs::read_to_string(&month).unwrap();
    std::fs::write(&month, text.replace("\"input\":10", "\"input\":1O")).unwrap();
    let r = infer(cache.path(), None, &strs(&custom(&url)));
    assert_eq!(
        (r.code, r.stdout.trim(), r.stderr.as_str()),
        (
            0,
            "deferred: unstale's usage record cannot be read or written",
            ""
        )
    );
    assert_eq!(seen.lock().unwrap().len(), 1, "no call on a corrupt ledger");
}

#[test]
fn both_spellings_of_the_switch_turn_model_steps_on() {
    for (value, calls) in [("1", 1), ("true", 1), ("0", 0), ("yes", 0)] {
        let (url, seen) = mock(200, OPENAI_OK, Duration::ZERO);
        let cache = tempfile::tempdir().unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_unstale"))
            .arg("infer")
            .args(strs(&custom(&url)))
            .env("UNSTALE_CACHE_DIR", cache.path())
            .env("CANARY_KEY", CANARY)
            .env("UNSTALE_EDGE_INFERENCE", value)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(0));
        assert_eq!(
            seen.lock().unwrap().len(),
            calls,
            "UNSTALE_EDGE_INFERENCE={value}"
        );
    }
}
