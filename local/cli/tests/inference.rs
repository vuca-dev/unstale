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
        .env("UNSTALE_DEV_UNSIGNED_CATALOG", "1")
        .env("UNSTALE_DEV_INFER", "1")
        // The user's config: none of the machine's own, and where a test puts the user's token limit.
        .env("UNSTALE_CONFIG_DIR", cache.join("user-config"))
        .env("UNSTALE_EDGE_INFERENCE", "1")
        .env("CANARY_KEY", CANARY)
        .env("OPENAI_API_KEY", CANARY)
        .env("ANTHROPIC_API_KEY", CANARY)
        .env("PATH", path)
        .current_dir(cache)
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
        ("the provider rejected the key", 401, Duration::ZERO),
        ("the provider is rate limiting", 429, Duration::ZERO),
        ("the provider is not answering", 500, Duration::ZERO),
        ("the provider is not answering", 503, Duration::ZERO),
        ("the provider took too long", 200, Duration::from_secs(3)),
        ("this key or plan lacks ", 404, Duration::ZERO),
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
            r.stdout.starts_with("warning: ") && r.stdout.contains(want),
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
            "warning: the provider is not answering, so new release notes wait. The next sync tries again."
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
        (
            0,
            "warning: UNSET_VAR is not set here, so new release notes are not read. Set it."
        )
    );
    // Codex: logged out, and a model not on the plan.
    let not_supported = r#"{"type":"error","message":"The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."}"#;
    for (logged_in, out, code, want) in [
        (
            false,
            CODEX_OK,
            0,
            "warning: Codex is not logged in, so new release notes are not read. Run `codex login`.",
        ),
        (
            true,
            not_supported,
            1,
            "warning: this key or plan lacks gpt-5.4-mini, so new release notes are not read. Run `unstale setup`.",
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
                "warning: the provider address redirects, so new release notes are not read. Check the address."
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
        .env("UNSTALE_DEV_UNSIGNED_CATALOG", "1")
        .env("UNSTALE_DEV_INFER", "1")
        .env("CANARY_KEY", CANARY)
        .env("UNSTALE_EDGE_INFERENCE", "0")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "deferred: model steps on this machine are turned off"
    );
    assert_eq!(seen.lock().unwrap().len(), 0);
}

/// A named provider skips the user's recorded choice, so without the developer variable neither hidden command calls
/// it: one line, an error exit, no request.
#[test]
fn without_the_developer_variable_a_named_provider_is_refused() {
    let (url, seen) = mock(200, OPENAI_OK, Duration::ZERO);
    let cache = tempfile::tempdir().unwrap();
    let input = cache.path().join("in.jsonl");
    std::fs::write(&input, "{}\n").unwrap();
    let infer: Vec<String> = ["infer".to_string()].into_iter().chain(custom(&url)).collect();
    let mut step: Vec<String> = ["internal", "run-step", "--step", "extract", "--in"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    step.push(input.display().to_string());
    step.extend(custom(&url).into_iter().filter(|a| a != "Say ok."));
    for args in [infer, step] {
        for value in [None, Some("0")] {
            let mut c = Command::new(env!("CARGO_BIN_EXE_unstale"));
            c.args(&args)
                .env("UNSTALE_CACHE_DIR", cache.path())
                .env("UNSTALE_CONFIG_DIR", cache.path().join("user-config"))
                .env("UNSTALE_EDGE_INFERENCE", "1")
                .env("CANARY_KEY", CANARY)
                .env_remove("UNSTALE_DEV_INFER");
            if let Some(v) = value {
                c.env("UNSTALE_DEV_INFER", v);
            }
            let out = c.output().unwrap();
            assert_ne!(out.status.code(), Some(0), "{args:?}");
            assert!(out.stdout.is_empty(), "{args:?}");
            let err = String::from_utf8_lossy(&out.stderr);
            assert_eq!(err.trim().lines().count(), 1, "{args:?}: {err}");
            assert!(err.contains("UNSTALE_DEV_INFER=1"), "{args:?}: {err}");
        }
    }
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
            "warning: unstale's token count is corrupt, so new release notes are not read. See `unstale status`.",
            ""
        )
    );
    assert_eq!(seen.lock().unwrap().len(), 1, "no call on a corrupt ledger");
}

#[test]
fn the_users_token_limit_holds_for_infer_and_a_repo_config_cannot_loosen_it() {
    let reached = "warning: monthly token limit reached, so new release notes wait. Change it: `unstale setup --limit`.";
    let (url, seen) = mock(200, OPENAI_OK, Duration::ZERO);
    let cache = tempfile::tempdir().unwrap();
    let spend = |tokens: u64| {
        // This month's file, as the client names it: one call creates it, then it is replaced.
        std::fs::create_dir_all(cache.path().join("inference")).unwrap();
        let month = &chrono_month();
        std::fs::write(
            cache.path().join(format!("inference/usage-{month}.jsonl")),
            format!("{{\"day\":\"{month}-01\",\"provider\":\"openai\",\"model\":\"m\",\"input\":{tokens},\"cached\":0,\"output\":0}}\n"),
        )
        .unwrap();
    };
    let user = |text: &str| {
        std::fs::create_dir_all(cache.path().join("user-config")).unwrap();
        std::fs::write(cache.path().join("user-config/config.json"), text).unwrap();
    };
    // 2M spent: under the default limit, a call is made.
    spend(2_000_000);
    assert_eq!(
        infer(cache.path(), None, &strs(&custom(&url)))
            .stdout
            .trim(),
        r#"{"ok":true}"#
    );
    assert_eq!(seen.lock().unwrap().len(), 1);
    // The user's own limit of 1M is reached: no call.
    user(r#"{"monthly_token_limit": 1000000}"#);
    assert_eq!(
        infer(cache.path(), None, &strs(&custom(&url)))
            .stdout
            .trim(),
        reached
    );
    // A repository's config saying "none" (or a higher number) does not lift the user's limit.
    for loosened in [r#""none""#, "900000000"] {
        std::fs::create_dir_all(cache.path().join(".unstale")).unwrap();
        std::fs::write(
            cache.path().join(".unstale/config.json"),
            format!(
                r#"{{"schema":1,"catalog":"x","mode":"local","monthly_token_limit":{loosened}}}"#
            ),
        )
        .unwrap();
        assert_eq!(
            infer(cache.path(), None, &strs(&custom(&url)))
                .stdout
                .trim(),
            reached,
            "{loosened}"
        );
    }
    assert_eq!(
        seen.lock().unwrap().len(),
        1,
        "no call past the user's limit"
    );
    // A repository may lower it: the user allows 900M, the repo 1M.
    user(r#"{"monthly_token_limit": 900000000}"#);
    std::fs::write(
        cache.path().join(".unstale/config.json"),
        r#"{"schema":1,"catalog":"x","mode":"local","monthly_token_limit":1000000}"#,
    )
    .unwrap();
    assert_eq!(
        infer(cache.path(), None, &strs(&custom(&url)))
            .stdout
            .trim(),
        reached
    );
    std::fs::remove_file(cache.path().join(".unstale/config.json")).unwrap();
    assert_eq!(
        infer(cache.path(), None, &strs(&custom(&url)))
            .stdout
            .trim(),
        r#"{"ok":true}"#
    );
    assert_eq!(seen.lock().unwrap().len(), 2);
}

/// This month as the client's ledger names it (UTC).
fn chrono_month() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
        / 86_400;
    // Civil date from days since 1970 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}")
}

#[test]
fn both_spellings_of_the_switch_turn_model_steps_on_and_off() {
    // Other values are the default, as unset is (`util::edge_inference_from`'s test).
    for (value, calls) in [("1", 1), ("true", 1), ("0", 0), ("false", 0)] {
        let (url, seen) = mock(200, OPENAI_OK, Duration::ZERO);
        let cache = tempfile::tempdir().unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_unstale"))
            .arg("infer")
            .args(strs(&custom(&url)))
            .env("UNSTALE_CACHE_DIR", cache.path())
            .env("UNSTALE_DEV_UNSIGNED_CATALOG", "1")
            .env("UNSTALE_DEV_INFER", "1")
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
