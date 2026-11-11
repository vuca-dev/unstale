//! Tests against a local mock HTTP server and a fake `codex`. No request leaves the machine.

use super::*;
use serde_json::json;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

/// A mock provider: answers each request with the next scripted `(status, body)` (the last one repeats) and records
/// every raw request.
pub struct Mock {
    pub url: String,
    pub requests: Arc<Mutex<Vec<String>>>,
}

impl Mock {
    pub fn new(script: Vec<(u16, String)>) -> Mock {
        Self::with_delay(script, Duration::ZERO)
    }

    pub fn with_delay(script: Vec<(u16, String)>, delay: Duration) -> Mock {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        std::thread::spawn(move || {
            let mut n = 0;
            for mut stream in listener.incoming().flatten() {
                let (mut got, mut buf) = (Vec::new(), [0u8; 16384]);
                loop {
                    let k = stream.read(&mut buf).unwrap_or(0);
                    got.extend_from_slice(&buf[..k]);
                    let text = String::from_utf8_lossy(&got).to_string();
                    let Some(end) = text.find("\r\n\r\n") else {
                        if k == 0 {
                            break;
                        }
                        continue;
                    };
                    let length = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if k == 0 || got.len() >= end + 4 + length {
                        break;
                    }
                }
                seen.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&got).to_string());
                let (status, body) = script[n.min(script.len() - 1)].clone();
                n += 1;
                // Answered on its own thread, so a slow answer does not hold up the next request.
                std::thread::spawn(move || {
                    std::thread::sleep(delay);
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                });
            }
        });
        Mock { url, requests }
    }

    pub fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    /// The JSON body of the `i`th request.
    pub fn body(&self, i: usize) -> Value {
        let r = self.requests.lock().unwrap()[i].clone();
        serde_json::from_str(&r[r.find("\r\n\r\n").unwrap() + 4..]).unwrap()
    }

    pub fn head(&self, i: usize) -> String {
        let r = self.requests.lock().unwrap()[i].clone();
        r[..r.find("\r\n\r\n").unwrap()].to_string()
    }
}

fn openai_ok(content: &str) -> String {
    json!({
        "model": "gpt-6-luna-2026-10-01",
        "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": 120, "completion_tokens": 30,
            "prompt_tokens_details": {"cached_tokens": 100},
            "completion_tokens_details": {"reasoning_tokens": 12},
        },
    })
    .to_string()
}

pub struct Fixture {
    pub dir: tempfile::TempDir,
}

impl Fixture {
    pub fn new() -> Fixture {
        Fixture {
            dir: tempfile::tempdir().unwrap(),
        }
    }
    pub fn inference(&self, mut provider: ProviderConfig, base: &str) -> Inference {
        provider.base_url = base.into();
        let mut i = Inference::new(provider).with_env(|k| match k {
            "TEST_KEY" => Some("test-key-value".into()),
            "PATH" => std::env::var("PATH").ok(),
            _ => None,
        });
        i.provider.key_env = i.provider.key_env.as_ref().map(|_| "TEST_KEY".into());
        i.ledger = Ledger::new(self.dir.path().join("inference"));
        i.limits = Limits {
            timeout: Duration::from_secs(5),
            retries: 2,
            backoff: Duration::ZERO,
        };
        i
    }
}

fn schema() -> Value {
    json!({"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"], "additionalProperties": false})
}

#[test]
fn openai_compatible_sends_a_strict_schema_and_reads_the_answer_and_usage() {
    let m = Mock::new(vec![(200, openai_ok(r#"{"ok": true}"#))]);
    let f = Fixture::new();
    for provider in [
        ProviderConfig::openai(),
        ProviderConfig::vercel(),
        ProviderConfig::openrouter(),
        ProviderConfig::custom("mine", "", "some/model", "X"),
    ] {
        let name = provider.name.clone();
        let inf = f.inference(provider, &format!("{}/v1/", m.url));
        let a = inf
            .complete(&Prompt::new("Is it?").schema(schema()))
            .unwrap();
        assert_eq!(a.value, json!({"ok": true}), "{name}");
        assert_eq!(a.model, "gpt-6-luna-2026-10-01");
        assert_eq!(
            a.usage,
            Usage {
                input: 120,
                cached: 100,
                output: 30,
                reasoning: Some(12)
            }
        );
    }
    let head = m.head(0);
    assert!(head.starts_with("POST /v1/chat/completions "), "{head}");
    assert!(
        head.contains("authorization: Bearer test-key-value")
            || head.contains("Authorization: Bearer test-key-value"),
        "{head}"
    );
    let b = m.body(0);
    assert_eq!(b["model"], "gpt-6-luna");
    assert_eq!(b["reasoning_effort"], "low");
    assert_eq!(
        b["messages"][0],
        json!({"role": "user", "content": "Is it?"})
    );
    assert_eq!(b["response_format"]["type"], "json_schema");
    assert_eq!(b["response_format"]["json_schema"]["strict"], true);
    assert_eq!(b["response_format"]["json_schema"]["schema"], schema());
    // The gateway preset asks for its flex tier.
    assert_eq!(
        m.body(1)["providerOptions"]["gateway"]["serviceTier"],
        "flex"
    );
    assert_eq!(m.body(1)["model"], "openai/gpt-6-luna");
    assert_eq!(m.body(3)["model"], "some/model");
}

#[test]
fn anthropic_messages_uses_output_config_format_and_counts_cache_reads_as_input() {
    let ok = json!({
        "model": "claude-haiku-5-5",
        "stop_reason": "end_turn",
        "content": [{"type": "text", "text": "{\"ok\": false}"}],
        "usage": {"input_tokens": 40, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 10, "output_tokens": 7},
    });
    let m = Mock::new(vec![(200, ok.to_string())]);
    let f = Fixture::new();
    let inf = f.inference(ProviderConfig::anthropic(), &m.url);
    let a = inf
        .complete(&Prompt::new("Is it?").schema(schema()))
        .unwrap();
    assert_eq!(a.value, json!({"ok": false}));
    assert_eq!(
        a.usage,
        Usage {
            input: 100,
            cached: 50,
            output: 7,
            reasoning: None
        }
    );
    let head = m.head(0).to_ascii_lowercase();
    assert!(head.starts_with("post /v1/messages "), "{head}");
    assert!(head.contains("x-api-key: test-key-value"), "{head}");
    assert!(head.contains("anthropic-version: 2026-10-21"), "{head}");
    assert!(!head.contains("authorization:"), "{head}");
    let b = m.body(0);
    assert_eq!(b["model"], "claude-haiku-5-5");
    assert_eq!(b["thinking"], json!({"type": "disabled"}));
    assert_eq!(
        b["output_config"]["format"],
        json!({"type": "json_schema", "schema": schema()})
    );
}

fn question(options: &[&str]) -> ChoiceQuestion {
    ChoiceQuestion {
        instructions: "Pick one.".into(),
        options: options
            .iter()
            .map(|o| (o.to_string(), format!("means {o}")))
            .collect(),
    }
}

#[test]
fn jev_sends_choice_questions_and_checks_each_answer() {
    let answer = |ids: &[&str]| {
        let answers: serde_json::Map<String, Value> = ids
            .iter()
            .map(|id| (id.to_string(), json!({"choice": "yes", "confidence": 0.9, "probabilities": {"yes": 0.9, "no": 0.1}})))
            .collect();
        json!({"model": "jev-7", "answers": answers, "usage": {"input_tokens": 300, "output_tokens": 20}}).to_string()
    };
    let ids: Vec<String> = (0..10).map(|i| format!("q{i:02}")).collect();
    let first: Vec<&str> = ids[..8].iter().map(String::as_str).collect();
    let rest: Vec<&str> = ids[8..].iter().map(String::as_str).collect();
    let m = Mock::new(vec![(200, answer(&first)), (200, answer(&rest))]);
    let f = Fixture::new();
    let inf = f.inference(ProviderConfig::jev(), &m.url);
    let qs: BTreeMap<String, ChoiceQuestion> = ids
        .iter()
        .map(|id| (id.clone(), question(&["yes", "no"])))
        .collect();
    let c = inf.classify(&json!({"subject": "x"}), &qs).unwrap();
    assert_eq!(c.answers.len(), 10);
    assert_eq!(c.model, "jev-7");
    assert_eq!(c.answers["q00"].choice, "yes");
    assert_eq!(
        c.usage,
        Usage {
            input: 600,
            cached: 0,
            output: 40,
            reasoning: None
        }
    );
    // Eight questions per request, as Jev's batching rule says.
    assert_eq!(m.count(), 2);
    assert!(m.head(0).starts_with("POST /v1/systemone "));
    let b = m.body(0);
    assert_eq!(b["model"], "jev-latest");
    assert_eq!(b["state"], json!({"subject": "x"}));
    assert_eq!(b["questions"].as_object().unwrap().len(), 8);
    assert_eq!(
        b["questions"]["q00"],
        json!({"type": "choice", "instructions": "Pick one.", "criteria": {"no": "means no", "yes": "means yes"}})
    );

    // A choice outside the options is not an answer.
    let bad = json!({"answers": {"a": {"choice": "maybe", "confidence": 1.0, "probabilities": {"yes": 0.5, "no": 0.5}}}}).to_string();
    let m = Mock::new(vec![(200, bad)]);
    let inf = f.inference(ProviderConfig::jev(), &m.url);
    let qs = BTreeMap::from([("a".to_string(), question(&["yes", "no"]))]);
    assert_eq!(
        inf.classify(&json!({}), &qs).unwrap_err(),
        Deferred::Malformed
    );
}

/// A fake `codex` script in `dir`: `--version` and `login status` answer as given, `exec` records its arguments,
/// environment and working directory, then prints `exec_out` and exits with `exec_code`.
#[cfg(unix)]
pub fn fake_codex(
    dir: &std::path::Path,
    version: &str,
    logged_in: bool,
    exec_out: &str,
    exec_code: i32,
) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let log = dir.join("codex-calls");
    std::fs::create_dir_all(&log).unwrap();
    std::fs::write(dir.join("exec-out.jsonl"), exec_out).unwrap();
    let script = format!(
        r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli {version}"; exit 0; fi
if [ "$1" = "login" ]; then {login}; fi
n=$(ls "{log}" | wc -l | tr -d ' ')
for a in "$@"; do printf '%s\n' "$a"; done > "{log}/$n.args"
env > "{log}/$n.env"
pwd > "{log}/$n.pwd"
ls -A . > "{log}/$n.ls"
cat "{dir}/exec-out.jsonl"
exit {exec_code}
"#,
        login = if logged_in {
            "echo 'Logged in using ChatGPT'; exit 0"
        } else {
            "echo 'Not logged in'; exit 1"
        },
        log = log.display(),
        dir = dir.display(),
    );
    let path = dir.join("codex");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

pub const CODEX_OK: &str = concat!(
    r#"{"type":"thread.started","thread_id":"t"}"#,
    "\n",
    r#"{"type":"item.completed","item":{"type":"error","message":"Code Mode is unavailable because code-mode host is disabled"}}"#,
    "\n",
    r#"{"type":"item.completed","item":{"type":"agent_message","text":"```json\n{\"ok\": true}\n```"}}"#,
    "\n",
    r#"{"type":"turn.completed","usage":{"input_tokens":4299,"cached_input_tokens":2944,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":2}}"#,
    "\n",
);

#[cfg(unix)]
#[test]
fn codex_runs_the_lean_flag_set_in_an_empty_directory_and_reads_turn_usage() {
    let f = Fixture::new();
    let bin = fake_codex(f.dir.path(), "0.166.0", true, CODEX_OK, 0);
    let inf = f.inference(ProviderConfig::codex(), &bin.to_string_lossy());
    let a = inf.complete(&Prompt::new("Reply.")).unwrap();
    assert_eq!(a.value, json!({"ok": true}));
    assert_eq!(
        a.usage,
        Usage {
            input: 4299,
            cached: 2944,
            output: 5,
            reasoning: Some(2)
        }
    );
    let log = f.dir.path().join("codex-calls");
    let args: Vec<String> = std::fs::read_to_string(log.join("0.args"))
        .unwrap()
        .lines()
        .map(String::from)
        .collect();
    let has = |pair: &[&str]| args.windows(pair.len()).any(|w| w == pair);
    for flag in [
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
    ] {
        assert!(args.iter().any(|a| a == flag), "{flag}: {args:?}");
    }
    assert!(
        has(&["-s", "read-only"])
            && has(&["-m", "gpt-6-luna"])
            && has(&["-c", "model_reasoning_effort=low"])
    );
    for c in [
        "web_search=disabled",
        "skills.include_instructions=false",
        "include_collaboration_mode_instructions=false",
        "include_environment_context=false",
    ] {
        assert!(has(&["-c", c]), "{c}");
    }
    assert!(
        args.iter()
            .any(|a| a.starts_with("model_instructions_file="))
    );
    for d in codex::tests_disabled() {
        assert!(has(&["--disable", d]), "{d}");
    }
    assert_eq!(args.last().unwrap(), "Reply.");
    // The working directory is the empty temporary one named by -C, and it is gone afterwards.
    let work = &args[args.iter().position(|a| a == "-C").unwrap() + 1];
    let pwd = std::fs::read_to_string(log.join("0.pwd")).unwrap();
    assert!(
        pwd.trim().ends_with(work.rsplit('/').next().unwrap()),
        "{pwd} {work}"
    );
    assert_eq!(
        std::fs::read_to_string(log.join("0.ls")).unwrap().trim(),
        ""
    );
    assert!(!std::path::Path::new(work).exists());
}

#[test]
fn a_batch_asks_for_every_item_by_id_and_returns_the_answers_it_got() {
    let m = Mock::new(vec![(
        200,
        openai_ok(r#"{"a": {"ok": true}, "c": {"ok": false}}"#),
    )]);
    let f = Fixture::new();
    let inf = f.inference(ProviderConfig::openai(), &m.url);
    let items: Vec<(String, Value)> = ["a", "b", "c"]
        .iter()
        .map(|id| (id.to_string(), json!({"text": format!("item {id}")})))
        .collect();
    let b = Batch {
        instructions: "Is each one ok?".into(),
        items,
        answer_schema: schema(),
        max_tokens: 4000,
    };
    let r = inf.complete_batch(&b).unwrap();
    assert_eq!(r.answers.len(), 2);
    assert_eq!(r.answers["a"], json!({"ok": true}));
    assert!(!r.answers.contains_key("b"));
    let body = m.body(0);
    let prompt = body["messages"][0]["content"].as_str().unwrap();
    assert!(
        prompt.starts_with("Is each one ok?") && prompt.contains("\"item b\""),
        "{prompt}"
    );
    let s = &body["response_format"]["json_schema"]["schema"];
    assert_eq!(s["required"], json!(["a", "b", "c"]));
    assert_eq!(s["properties"]["b"], schema());
    assert_eq!(s["additionalProperties"], false);
    // Splitting a step's items: eight to a call.
    let n: Vec<usize> = batches(&(0..19).collect::<Vec<_>>())
        .map(<[i32]>::len)
        .collect();
    assert_eq!(n, vec![8, 8, 3]);
}

#[test]
fn the_ledger_keeps_every_call_per_provider_per_day() {
    let m = Mock::new(vec![(200, openai_ok(r#"{"ok": true}"#))]);
    let f = Fixture::new();
    let inf = f.inference(ProviderConfig::openai(), &m.url);
    inf.complete(&Prompt::new("one")).unwrap();
    inf.complete(&Prompt::new("two")).unwrap();
    inf.ledger.record(
        "codex",
        "gpt-6-luna",
        &Usage {
            input: 1000,
            cached: 900,
            output: 10,
            reasoning: None,
        },
    );
    let month = ledger::this_month();
    let by_day = inf.ledger.by_day(&month);
    let today = crate::util::today();
    assert_eq!(
        by_day[&(today.clone(), "openai".to_string())],
        Usage {
            input: 240,
            cached: 200,
            output: 60,
            reasoning: Some(24)
        }
    );
    assert_eq!(by_day[&(today, "codex".to_string())].input, 1000);
    assert_eq!(inf.ledger.month_tokens(&month), 240 + 60 + 1010);
    // Counts only: no prompt or answer text in the ledger.
    let text = std::fs::read_to_string(f.dir.path().join(format!("inference/usage-{month}.jsonl")))
        .unwrap();
    assert_eq!(text.lines().count(), 3);
    assert!(!text.contains("one") && !text.contains("ok"), "{text}");
    // Tokens a call spent count even when its answer is unusable.
    let m = Mock::new(vec![(200, openai_ok("not json"))]);
    let inf = f.inference(ProviderConfig::openai(), &m.url);
    assert_eq!(
        inf.complete(&Prompt::new("x")).unwrap_err(),
        Deferred::Malformed
    );
    assert_eq!(inf.ledger.month_tokens(&month), 240 + 60 + 1010 + 150);
}

#[test]
fn past_the_monthly_budget_work_is_deferred_without_a_call() {
    let m = Mock::new(vec![(200, openai_ok(r#"{"ok": true}"#))]);
    let f = Fixture::new();
    let mut inf = f.inference(ProviderConfig::openai(), &m.url);
    inf.monthly_budget = 200;
    inf.complete(&Prompt::new("one")).unwrap();
    // 150 tokens used: under the budget, so one more call runs and takes it past.
    inf.complete(&Prompt::new("two")).unwrap();
    assert_eq!(
        inf.complete(&Prompt::new("three")).unwrap_err(),
        Deferred::Budget
    );
    assert_eq!(m.count(), 2);
    assert_eq!(
        Deferred::Budget.line(),
        "deferred: this month's token budget is used up; the rest runs next month"
    );
    assert_eq!(ledger::DEFAULT_MONTHLY_TOKENS, 48_000_000);
    assert_eq!(
        ledger::budget_line(1_234_567, ledger::DEFAULT_MONTHLY_TOKENS),
        "Model tokens this month: 1.2M of 48M (monthly budget; past it, work waits for next month)"
    );
}

#[test]
fn one_worker_per_machine() {
    let f = Fixture::new();
    let dir = f.dir.path().join("inference");
    let held = lock::try_acquire(&dir).expect("the first worker takes the lock");
    assert!(
        lock::try_acquire(&dir).is_none(),
        "a second worker must not run"
    );
    drop(held);
    assert!(
        lock::try_acquire(&dir).is_some(),
        "the lock is free once the first worker is done"
    );
}

#[test]
fn provider_errors_are_typed_deferrals_and_only_transient_ones_retry() {
    let f = Fixture::new();
    let p = Prompt::new("x");
    // (status, deferral, requests made with 2 retries)
    for (status, want, calls) in [
        (401, Deferred::Auth, 1),
        (403, Deferred::Auth, 1),
        (402, Deferred::Billing, 1),
        (404, Deferred::ModelNotOnPlan("gpt-6-luna".into()), 1),
        (400, Deferred::Rejected, 1),
        (429, Deferred::RateLimited, 3),
        (500, Deferred::Unavailable, 3),
        (503, Deferred::Unavailable, 3),
        (529, Deferred::Unavailable, 3),
    ] {
        let m = Mock::new(vec![(
            status,
            r#"{"error":{"message":"Incorrect API key provided: test-key-value"}}"#.into(),
        )]);
        let inf = f.inference(ProviderConfig::openai(), &m.url);
        let got = inf.complete(&p).unwrap_err();
        assert_eq!(got, want, "HTTP {status}");
        assert_eq!(m.count(), calls, "HTTP {status}");
        // The line is fixed text: nothing the provider sent back (which can echo the key) reaches the user.
        assert!(
            got.line().starts_with("deferred: ") && !got.line().contains("test-key-value"),
            "{}",
            got.line()
        );
    }
    // A transient failure that clears is retried to an answer.
    let m = Mock::new(vec![
        (429, "{}".into()),
        (502, "{}".into()),
        (200, openai_ok(r#"{"ok": true}"#)),
    ]);
    let inf = f.inference(ProviderConfig::openai(), &m.url);
    assert_eq!(inf.complete(&p).unwrap().value, json!({"ok": true}));
    assert_eq!(m.count(), 3);
    // No answer in time.
    let m = Mock::with_delay(vec![(200, openai_ok("{}"))], Duration::from_millis(800));
    let mut inf = f.inference(ProviderConfig::openai(), &m.url);
    inf.limits.timeout = Duration::from_millis(200);
    inf.limits.retries = 1;
    assert_eq!(inf.complete(&p).unwrap_err(), Deferred::Timeout);
    assert_eq!(m.count(), 2);
    // Nothing listening.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    assert_eq!(
        f.inference(ProviderConfig::openai(), &url)
            .complete(&p)
            .unwrap_err(),
        Deferred::Unavailable
    );
    // A truncated answer, and an unset key (no request sent).
    let long = json!({"choices": [{"message": {"content": "{\"ok\""}, "finish_reason": "length"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1}});
    let m = Mock::new(vec![(200, long.to_string())]);
    assert_eq!(
        f.inference(ProviderConfig::openai(), &m.url)
            .complete(&p)
            .unwrap_err(),
        Deferred::TooLong
    );
    let m = Mock::new(vec![(200, openai_ok("{}"))]);
    let mut inf = f.inference(ProviderConfig::openai(), &m.url);
    inf.provider.key_env = Some("UNSET_KEY".into());
    assert_eq!(
        inf.complete(&p).unwrap_err(),
        Deferred::NoKey("UNSET_KEY".into())
    );
    assert_eq!(m.count(), 0);
}

#[cfg(unix)]
#[test]
fn codex_problems_are_typed_deferrals() {
    let p = Prompt::new("x");
    let not_supported = concat!(
        r#"{"type":"error","message":"The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."}"#,
        "\n",
        r#"{"type":"turn.failed","error":{"message":"The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."}}"#,
        "\n",
    );
    let lapsed = r#"{"type":"error","message":"Reconnecting... 5/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)"}"#;
    let limited = r#"{"type":"turn.failed","error":{"message":"You've hit your usage limit."}}"#;
    for (version, logged_in, out, code, want, calls) in [
        ("0.166.0", false, CODEX_OK, 0, Deferred::CodexLoggedOut, 0),
        ("0.120.3", true, CODEX_OK, 0, Deferred::CodexTooOld, 0),
        (
            "0.166.0",
            true,
            not_supported,
            1,
            Deferred::ModelNotOnPlan("gpt-6-luna".into()),
            1,
        ),
        ("0.166.0", true, lapsed, 1, Deferred::CodexLoggedOut, 1),
        ("0.166.0", true, limited, 1, Deferred::RateLimited, 3),
        ("0.166.0", true, "", 1, Deferred::Unavailable, 3),
        (
            "0.166.0",
            true,
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"no json here"}}"#,
            0,
            Deferred::Malformed,
            1,
        ),
    ] {
        let f = Fixture::new();
        let bin = fake_codex(f.dir.path(), version, logged_in, out, code);
        let inf = f.inference(ProviderConfig::codex(), &bin.to_string_lossy());
        assert_eq!(inf.complete(&p).unwrap_err(), want, "{out}");
        let n = std::fs::read_dir(f.dir.path().join("codex-calls"))
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|x| x == "args")
            })
            .count();
        assert_eq!(n, calls, "exec calls for {want:?}");
    }
    let f = Fixture::new();
    let inf = f.inference(
        ProviderConfig::codex(),
        &f.dir.path().join("no-codex-here").to_string_lossy(),
    );
    assert_eq!(inf.complete(&p).unwrap_err(), Deferred::CodexMissing);
}

#[test]
fn every_deferral_is_one_plain_line() {
    let all = [
        Deferred::Budget,
        Deferred::NoKey("OPENAI_API_KEY".into()),
        Deferred::Auth,
        Deferred::Billing,
        Deferred::RateLimited,
        Deferred::Unavailable,
        Deferred::Timeout,
        Deferred::ModelNotOnPlan("gpt-6-luna".into()),
        Deferred::Rejected,
        Deferred::TooLong,
        Deferred::Malformed,
        Deferred::CodexMissing,
        Deferred::CodexTooOld,
        Deferred::CodexLoggedOut,
    ];
    for d in all {
        let l = d.line();
        assert!(
            l.starts_with("deferred: ") && !l.contains('\n') && l.chars().count() <= 80,
            "{l}"
        );
    }
}
