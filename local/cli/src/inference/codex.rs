//! Codex as a provider: `codex exec` headless on the user's Codex login, with the lean flag set measured in
//! `eval/edge-cli/RESULTS.md`. The sandbox is read-only, the session ephemeral, the working directory an empty
//! temporary one, and no tool beyond answering is enabled. The child gets a minimal environment, so no key variable
//! of the user's shell reaches it. Usage comes from `turn.completed.usage`.
//!
//! Codex adds its own fixed input to every call; [`HINTS`] turns off its multi-agent tools and hint texts, 4,299 to
//! 2,735 input tokens on a trivial call on Codex 0.166.0 (`eval/edge-port/RESULTS.md`, addendum 4). A Codex that
//! refuses one of them at start-up gets the calls without them for the rest of the run, so it never fails a sync.

use super::{Answer, Deferred, Inference, Prompt, TempDir, Usage, parse_answer};
use serde_json::Value;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// The oldest Codex the flag set was measured on.
pub const MIN_VERSION: &str = "0.166.0";

/// Codex's multi-agent tools off and its three hint texts empty.
const HINTS: &[&str] = &[
    "features.multi_agent_v2.disable_native_tools=true",
    "features.multi_agent_v2.usage_hint_enabled=false",
    "features.multi_agent_v2.root_agent_usage_hint_text=\"\"",
    "features.multi_agent_v2.usage_hint_text=\"\"",
    "features.multi_agent_v2.multi_agent_mode_hint_text=\"\"",
];

/// Codex's state for one [`super::Inference`].
#[derive(Default)]
pub(crate) struct State {
    ready: OnceLock<Result<(), Deferred>>,
    /// Set once Codex refused to start with [`HINTS`]: later calls leave them out.
    no_hints: AtomicBool,
}

/// The instructions that replace Codex's own (`model_instructions_file`).
const INSTRUCTIONS: &str =
    "You answer the user's request directly with text only. Never call tools.\n";

/// Codex features turned off: none is needed to answer, and each costs prompt tokens.
const DISABLED: &[&str] = &[
    "multi_agent",
    "plugins",
    "apps",
    "skill_search",
    "shell_tool",
    "unified_exec",
    "image_generation",
    "browser_use",
    "computer_use",
    "goals",
    "sleep_tool",
    "tool_suggest",
    "view_image",
    "hooks",
    "code_mode_host",
    "in_app_browser",
    "workspace_dependencies",
];

/// Variables passed through to Codex; everything else in the environment is withheld.
const PASSED_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "CODEX_HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
    "XDG_CONFIG_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "SYSTEMROOT",
];

/// A finished child: exit success, stdout, stderr. `None` when it ran past the deadline (killed).
type Ran = Option<(bool, String, String)>;

fn command(inf: &Inference, args: &[&str]) -> Command {
    let mut c = Command::new(&inf.provider.base_url);
    c.args(args)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for k in PASSED_ENV {
        if let Some(v) = (inf.env)(k) {
            c.env(k, v);
        }
    }
    c
}

/// Runs a command to completion or the deadline. `Err` when it could not start.
fn run(mut c: Command, timeout: Duration) -> std::io::Result<Ran> {
    let mut child = c.spawn()?;
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let o = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(r) = out.as_mut() {
            let _ = r.read_to_string(&mut s);
        }
        s
    });
    let e = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(r) = err.as_mut() {
            let _ = r.read_to_string(&mut s);
        }
        s
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait()? {
            Some(s) => break Some(s),
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    let (stdout, stderr) = (o.join().unwrap_or_default(), e.join().unwrap_or_default());
    Ok(status.map(|s| (s.success(), stdout, stderr)))
}

/// Installed, recent enough and logged in; checked once per [`Inference`].
pub(super) fn ready(inf: &Inference) -> Result<(), Deferred> {
    inf.codex
        .ready
        .get_or_init(|| {
            let quick = Duration::from_secs(20);
            let version = match run(command(inf, &["--version"]), quick) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(Deferred::CodexMissing);
                }
                Err(_) => return Err(Deferred::Unavailable),
                Ok(None) => return Err(Deferred::Timeout),
                Ok(Some((_, out, _))) => out,
            };
            let v = version
                .split_whitespace()
                .last()
                .and_then(|v| semver::Version::parse(v.trim_start_matches('v')).ok());
            let min = semver::Version::parse(MIN_VERSION).expect("MIN_VERSION parses");
            if v.is_none_or(|v| v < min) {
                return Err(Deferred::CodexTooOld);
            }
            match run(command(inf, &["login", "status"]), quick) {
                Ok(Some((true, _, _))) => Ok(()),
                Ok(None) => Err(Deferred::Timeout),
                _ => Err(Deferred::CodexLoggedOut),
            }
        })
        .clone()
}

/// The arguments for one call.
fn args(inf: &Inference, hints: bool, work: &str, instructions: &str, prompt: &str) -> Vec<String> {
    let c = &inf.provider;
    let mut a: Vec<String> = [
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "-m",
        &c.model,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(e) = &c.effort {
        a.extend(["-c".into(), format!("model_reasoning_effort={e}")]);
    }
    for kv in [
        format!("model_instructions_file={instructions}"),
        "web_search=disabled".into(),
        "skills.include_instructions=false".into(),
        "include_collaboration_mode_instructions=false".into(),
        "include_environment_context=false".into(),
    ] {
        a.extend(["-c".into(), kv]);
    }
    for f in DISABLED {
        a.extend(["--disable".into(), f.to_string()]);
    }
    if hints {
        for kv in HINTS {
            a.extend(["-c".into(), kv.to_string()]);
        }
    }
    // `--` so a prompt that starts with `-` is never read as a flag.
    a.extend(["-C".into(), work.into(), "--".into(), prompt.into()]);
    a
}

/// What a failed call's output says went wrong.
fn failure(model: &str, text: &str) -> Deferred {
    let t = text.to_ascii_lowercase();
    if t.contains("model") && t.contains("not supported") {
        Deferred::ModelNotOnPlan(model.into())
    } else if t.contains("status 401")
        || t.contains("401 unauthorized")
        || t.contains("not logged in")
    {
        // "Reconnecting… n/5 (unexpected status 401 Unauthorized: …)" (eval/edge-cli).
        Deferred::CodexLoggedOut
    } else if t.contains("status 429")
        || t.contains("429 too many requests")
        || t.contains("rate limit")
        || t.contains("usage limit")
    {
        Deferred::RateLimited
    } else {
        Deferred::Unavailable
    }
}

/// One `codex exec` attempt. `Err(None)` when Codex stopped before starting a thread with [`HINTS`]: they are left
/// out from then on and the caller asks again.
fn attempt(inf: &Inference, p: &Prompt) -> Result<Answer, Option<Deferred>> {
    let hints = !inf.codex.no_hints.load(Ordering::SeqCst);
    match attempt_with(inf, p, hints) {
        // Only an attempt with the hint options returns this.
        Err(Refused::Options) => {
            inf.codex.no_hints.store(true, Ordering::SeqCst);
            // Once per process, in the progress a person running `unstale session-sync` by hand sees; nowhere else.
            static SAID: AtomicBool = AtomicBool::new(false);
            if !SAID.swap(true, Ordering::SeqCst) {
                crate::pipeline::progress(
                    "Codex would not start with its multi-agent hint options off; calls run without them.",
                );
            }
            Err(None)
        }
        Err(Refused::Deferred(d)) => Err(Some(d)),
        Ok(a) => Ok(a),
    }
}

/// Why an attempt gave no answer.
enum Refused {
    /// Codex exited with an error before it started a thread: at start-up, most likely an option it does not take.
    Options,
    Deferred(Deferred),
}

impl From<Deferred> for Refused {
    fn from(d: Deferred) -> Refused {
        Refused::Deferred(d)
    }
}

fn attempt_with(inf: &Inference, p: &Prompt, hints: bool) -> Result<Answer, Refused> {
    let work = TempDir::new("codex-work").map_err(|_| Deferred::Unavailable)?;
    let side = TempDir::new("codex-instructions").map_err(|_| Deferred::Unavailable)?;
    let instructions = side.0.join("instructions.md");
    std::fs::write(&instructions, INSTRUCTIONS).map_err(|_| Deferred::Unavailable)?;
    // The measured flag set has no response-format option, so the schema goes in the prompt and the answer's
    // top-level shape is checked.
    let text = match &p.schema {
        Some(s) => format!(
            "{}\n\nAnswer with JSON only, following this JSON Schema:\n{s}\n",
            p.text.trim_end()
        ),
        None => p.text.clone(),
    };
    let mut c = command(inf, &[]);
    c.args(args(
        inf,
        hints,
        &work.0.to_string_lossy(),
        &instructions.to_string_lossy(),
        &text,
    ))
    .current_dir(&work.0);
    let (ok, stdout, stderr) = match run(c, inf.limits.timeout) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(Deferred::CodexMissing.into());
        }
        // Installed but would not start with this request (an oversized prompt, for one): not retried.
        Err(_) => return Err(Deferred::Rejected.into()),
        Ok(None) => return Err(Deferred::Timeout.into()),
        Ok(Some(r)) => r,
    };
    let prompt_text = text;
    let mut text = None;
    let mut usage: Option<Usage> = None;
    let mut errors = String::new();
    let mut started = false;
    for line in stdout.lines() {
        let Ok(e) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        started = true;
        match e.get("type").and_then(Value::as_str) {
            Some("turn.completed") => {
                let u = e.get("usage").cloned().unwrap_or(Value::Null);
                let n = |k: &str| u.get(k).and_then(Value::as_u64);
                usage.get_or_insert_with(Usage::default).add(&Usage {
                    input: n("input_tokens").unwrap_or(0),
                    cached: n("cached_input_tokens").unwrap_or(0),
                    output: n("output_tokens").unwrap_or(0),
                    reasoning: n("reasoning_output_tokens"),
                });
            }
            Some("item.completed") => {
                let item = e.get("item").cloned().unwrap_or(Value::Null);
                if item.get("type").and_then(Value::as_str) == Some("agent_message") {
                    text = item.get("text").and_then(Value::as_str).map(String::from);
                }
            }
            Some("error") | Some("turn.failed") => {
                errors.push_str(&e.to_string());
                errors.push('\n');
            }
            _ => {}
        }
    }
    let model = inf.provider.model.clone();
    // An answer that came without usage is still counted, from the bytes each way.
    let usage = usage.or_else(|| text.as_ref().map(|t| Usage::estimate(&prompt_text, t)));
    if let Some(u) = &usage {
        inf.record(&model, u);
    }
    match text {
        Some(t) if ok => {
            let value = if p.raw {
                Some(Value::String(t))
            } else {
                parse_answer(&t, p.schema.as_ref())
            }
            .filter(|v| super::fits(v, p.schema.as_ref()))
            .ok_or(Deferred::Malformed)?;
            Ok(Answer {
                value,
                model,
                usage: usage.unwrap_or_default(),
            })
        }
        // No event at all: Codex stopped at start-up ("Error loading config.toml: …" for an option it rejects). Any
        // failure with no event drops the hint options, whatever its cause, not only a refused option: a network
        // failure before the thread starts does too, and later calls in the run then go without them.
        None if !ok && !started && hints => Err(Refused::Options),
        _ => Err(failure(&model, &format!("{errors}\n{stderr}")).into()),
    }
}

pub(super) fn exec(inf: &Inference, p: &Prompt) -> Result<Answer, Deferred> {
    ready(inf)?;
    let mut n = 0;
    loop {
        // A call whose usage could not be recorded stops every later one, retries included.
        if inf.ledger_failed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Deferred::Storage);
        }
        match attempt(inf, p) {
            // Asked again at once without the hint options; this happens at most once per run.
            Err(None) => {}
            Err(Some(d)) if d.transient() && n < inf.limits.retries => {
                std::thread::sleep(inf.limits.backoff * 2u32.pow(n));
                n += 1;
            }
            Err(Some(d)) => return Err(d),
            Ok(a) => return Ok(a),
        }
    }
}

#[cfg(test)]
pub(super) fn tests_disabled() -> &'static [&'static str] {
    DISABLED
}

#[cfg(test)]
pub(super) fn tests_hints() -> &'static [&'static str] {
    HINTS
}
