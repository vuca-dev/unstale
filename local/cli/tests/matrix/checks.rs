//! The checks every scenario must pass, and the faults that show each check fails when its property breaks.

use super::*;

/// A deliberate violation, injected by the harness (never by the client), to show each check fails when its
/// property breaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fault {
    /// The key's value is sent in a request body.
    KeyInRequestBody,
    /// The key's value is written to the cache.
    KeyWrittenToCache,
    /// A file the client opens is planted as a sentinel: the open is noticed.
    OpenPlantedUserConfig,
    /// The provider address is off this machine.
    ProviderOffMachine,
    /// The repository's code is sent in a request body.
    RepoCodeInRequestBody,
    /// The model step exits with an error.
    ErrorExit,
    /// A second question is asked on the same path.
    SecondQuestion,
    /// CI's run is given a terminal, so it asks.
    QuestionWithoutTerminal,
    /// The record of the notice shown today is lost, so it shows twice.
    NoticeTwice,
    /// A release the catalog already covers is sent for extraction.
    ExtractsCoveredRelease,
    /// The session-start hook prints two lines and writes to stderr.
    NoisyHook,
}

/// Words of the implementation, never of the reader (docs/edge-inference/terminal-principles.md, "Plain words").
pub(crate) const INTERNAL_WORDS: [&str; 9] = [
    "deferred",
    "deterministic signals",
    "technology-year",
    "edge inference",
    "change events",
    "(shown once a day)",
    "candidate technolog",
    "no index for",
    "shard(s)",
];

/// What a command's output breaks of the plain-words rule.
pub(crate) fn wording(shown: &str, terminal: bool, output: &str) -> Vec<String> {
    let mut v = vec![];
    for word in INTERNAL_WORDS {
        if output.contains(word) {
            v.push(format!("wording: `{shown}` printed {word:?}"));
        }
    }
    if !terminal && output.contains(" · step ") {
        v.push(format!(
            "wording: `{shown}` printed step-by-step progress without a terminal"
        ));
    }
    v
}

/// What a scenario breaks, one line each, prefixed with the property.
pub(crate) fn check(s: &Scenario, se: &Session) -> Vec<String> {
    let w = &se.world;
    let mut v = vec![];
    let catalog = w.catalog_host.requests();
    let provider = w.provider_host.requests();
    let trapped = w.trap.requests();
    let invocations = support::codex_invocations(&w.codex_dir());
    let exec_args = std::fs::read_to_string(w.codex_dir().join("args")).unwrap_or_default();
    let exec_env = std::fs::read_to_string(w.codex_dir().join("env")).unwrap_or_default();
    let chosen = se.chosen.clone().unwrap_or(serde_json::Value::Null);
    let provider_id = chosen["provider"].as_str().unwrap_or("none");
    let key_env = chosen["key_env"].as_str();
    let labels_service = chosen["labels"]["provider"].as_str() == Some("jev");
    // The paths of the chosen routes on the provider host.
    let mut routes: Vec<&str> = match provider_id {
        "anthropic" => vec!["/v1/messages"],
        "openai" | "vercel" | "openrouter" => vec!["/v1/chat/completions"],
        _ => vec![],
    };
    if labels_service {
        routes.push("/v1/systemone");
    }
    let codex_calls = w.codex_backend.requests();

    // Hold-the-line 1: no key or canary anywhere but the chosen provider's auth header; forbidden files never opened.
    for r in &se.ran {
        for c in support::canaries_in(&r.output) {
            v.push(format!(
                "hold-the-line 1: canary {c} in the output of `{}`",
                r.shown
            ));
        }
    }
    let planted = w.repo().join(".env");
    for (p, text) in support::files_under(w.base.path()) {
        if p == planted || p.starts_with(w.codex_dir()) {
            continue;
        }
        for c in support::canaries_in(&text) {
            v.push(format!(
                "hold-the-line 1: canary {c} written to {}",
                w.normalise(&p.display().to_string())
            ));
        }
    }
    for (host, reqs) in [("the catalog host", &catalog), ("the proxy", &trapped)] {
        for r in reqs.iter() {
            for c in support::canaries_in(&r.raw()) {
                v.push(format!(
                    "hold-the-line 1: canary {c} sent to {host} ({} {})",
                    r.method,
                    w.normalise(&r.path)
                ));
            }
        }
    }
    // A key's value as the client reads it: the environment first, else this repository's `.env`.
    let value_of = |var: &str| -> String {
        if s.keys.shell.contains(&var) {
            shell_value(var)
        } else {
            repo_value(var)
        }
    };
    for r in &provider {
        // The route a request is on, and the key that route was chosen with.
        let (header, var) = if r.path.ends_with("/v1/systemone") {
            ("authorization", chosen["labels"]["key_env"].as_str())
        } else if r.path.ends_with("/v1/messages") {
            ("x-api-key", key_env)
        } else {
            ("authorization", key_env)
        };
        let want = var.map(value_of);
        for c in support::canaries_in(&r.body) {
            v.push(format!(
                "hold-the-line 1: canary {c} in a request body to the provider ({})",
                r.path
            ));
        }
        for line in r.header_lines() {
            if support::canaries_in(line).is_empty() {
                continue;
            }
            let (name, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value
                .trim()
                .trim_start_matches("Bearer ")
                .trim_start_matches("bearer ");
            if !name.eq_ignore_ascii_case(header) || want.as_deref() != Some(value) {
                v.push(format!("hold-the-line 1: a canary in a header other than the chosen key's auth header ({})", name));
            }
        }
    }
    for c in support::canaries_in(&exec_env)
        .into_iter()
        .chain(support::canaries_in(&exec_args))
    {
        v.push(format!("hold-the-line 1: canary {c} reached codex"));
    }
    for sentinel in &w.sentinels {
        if sentinel.opened() {
            v.push(format!(
                "hold-the-line 1: {} was opened",
                w.normalise(&sentinel.path.display().to_string())
            ));
        }
    }

    // Hold-the-line 2: only the catalog host and the chosen provider; bodies carry no repo paths or code.
    for r in &trapped {
        v.push(format!(
            "hold-the-line 2: a request left this machine ({} {})",
            r.method, r.path
        ));
    }
    if !provider.is_empty() && routes.is_empty() {
        v.push(format!(
            "hold-the-line 2: the provider host was contacted with {provider_id} chosen"
        ));
    }
    for r in &provider {
        if !routes.is_empty() && !routes.contains(&r.path.as_str()) {
            v.push(format!(
                "hold-the-line 2: {} {} is not the API of the chosen {provider_id}",
                r.method, r.path
            ));
        }
    }
    let execs = invocations.iter().filter(|i| i.starts_with("exec")).count();
    if execs > 0 && provider_id != "codex" {
        v.push(format!(
            "hold-the-line 2: codex exec ran with {provider_id} chosen"
        ));
    }
    let repo = w.repo().display().to_string();
    let repo_canon = w
        .repo()
        .canonicalize()
        .map(|p| p.display().to_string())
        .unwrap_or(repo.clone());
    let mut bodies: Vec<(String, String)> = provider
        .iter()
        .map(|r| (format!("the provider ({})", r.path), r.body.clone()))
        .collect();
    bodies.extend(catalog.iter().map(|r| {
        (
            format!(
                "the catalog host ({} {})",
                r.method,
                r.path.split('?').next().unwrap_or("")
            ),
            r.raw(),
        )
    }));
    bodies.push(("codex exec".into(), exec_args.clone()));
    for (what, body) in bodies {
        for needle in [
            repo.as_str(),
            repo_canon.as_str(),
            CODE_MARKER,
            "middleware.ts\n",
            "src/middleware.ts",
        ] {
            if body.contains(needle) {
                v.push(format!(
                    "hold-the-line 2: {what} received {}",
                    if needle.starts_with('/') {
                        "a repository path"
                    } else {
                        "repository code"
                    }
                ));
            }
        }
    }

    // Hold-the-line 4: provider and budget failures defer with one line, exit 0. A command the person interrupted
    // with Ctrl-C may exit otherwise.
    for r in &se.ran {
        let pressed_ctrl_c = s.invocation.answer == "\u{3}" && questions(&r.output) > 0;
        if r.code != 0 && !pressed_ctrl_c {
            v.push(format!("hold-the-line 4: `{}` exited {}", r.shown, r.code));
        }
        if r.output.lines().any(|l| l.starts_with("error:")) {
            v.push(format!("hold-the-line 4: `{}` printed an error", r.shown));
        }
    }
    let fails = s.answer.failing() || (provider_id == "codex" && !s.codex.logged_in);
    for r in se.ran.iter().filter(|r| r.step == Step::SessionSync) {
        let lines: Vec<&str> = r.output.lines().collect();
        let last = lines.last().copied().unwrap_or("");
        if !r.terminal && lines.len() != 1 {
            v.push(format!(
                "hold-the-line 4: `{}` without a terminal printed {} lines, not one: {:?}",
                r.shown,
                lines.len(),
                r.output
            ));
        }
        if fails && routes_usable(&chosen) && !last.starts_with("warning: ") {
            v.push(format!(
                "hold-the-line 4: a provider or budget failure did not end `{}` with one warning line: {last:?}",
                r.shown
            ));
        }
    }
    // Hold-the-line 5: session start returns within 2 s, exits 0, prints at most one line and nothing on stderr.
    for r in se
        .ran
        .iter()
        .filter(|r| r.step == Step::SessionStart && !r.shown.is_empty())
    {
        if r.output.lines().count() > 1 {
            v.push(format!(
                "hold-the-line 5: session start printed more than one line: {:?}",
                r.output
            ));
        }
        if r.stderr.as_deref().is_some_and(|e| !e.is_empty()) {
            v.push(format!(
                "hold-the-line 5: session start wrote to stderr: {:?}",
                r.stderr
            ));
        }
        if r.took >= Duration::from_secs(2) {
            v.push(format!("hold-the-line 5: session start took {:?}", r.took));
        }
    }

    // The model steps run only for releases that have change events, no catalog records and no `extracted` mark;
    // with a working provider, every such release is read.
    let mut asked: BTreeSet<String> = BTreeSet::new();
    for prompt in provider
        .iter()
        .map(|r| model::prompt_of(&r.body))
        .chain(codex_calls.iter().map(|r| r.body.clone()))
    {
        asked.extend(model::releases_asked(&prompt));
    }
    let due = releases_to_read();
    for r in asked.difference(&due) {
        v.push(format!(
            "model steps: {r} was sent for extraction, though the catalog covers it or marks it processed"
        ));
    }
    if !asked.is_empty() && s.answer == Answer::Ok && s.fault.is_none() && asked != due {
        v.push(format!(
            "model steps: with the provider answering, only {asked:?} of {due:?} were read"
        ));
    }

    // At most one question per path, none without a terminal.
    let asked: usize = se.ran.iter().map(|r| questions(&r.output)).sum();
    if asked > 1 {
        v.push(format!("questions: {asked} questions on one path"));
    }
    for r in &se.ran {
        if !s.invocation.person && questions(&r.output) > 0 {
            v.push(format!(
                "questions: `{}` asked a question without a person at a terminal",
                r.shown
            ));
        }
    }
    // A dismissed question records only that it was dismissed; Ctrl-C records nothing.
    let dismissed = w.repo().join(".unstale/state/setup-dismissed").exists();
    let interrupted = s.invocation.answer == "\u{3}";
    if (s.invocation.answer == "\u{4}" || interrupted)
        && s.config.choice.is_none()
        && provider_id_after(w).is_some()
    {
        v.push("questions: a dismissed or interrupted question recorded a provider".into());
    }
    if interrupted && dismissed {
        v.push("questions: Ctrl-C at the question recorded a dismissal".into());
    }

    // Plain words: nothing printed uses vocabulary the reader was never taught, and without a terminal there is no
    // line per step of progress.
    for r in &se.ran {
        v.extend(wording(&r.shown, r.terminal, &r.output));
    }

    // The catalog's notice and update lines: once a day.
    let n: usize = se
        .ran
        .iter()
        .map(|r| r.output.matches(NOTICE_LINE).count())
        .sum();
    if n > 1 {
        v.push(format!("notice: shown {n} times in one day"));
    }
    let updates: usize = se
        .ran
        .iter()
        .map(|r| {
            r.output
                .lines()
                .filter(|l| l.contains(&newer_version()))
                .count()
        })
        .sum();
    if updates > 1 {
        v.push(format!(
            "notice: the update line shown {updates} times in one day"
        ));
    }
    v
}

// ------------------------------------------------------------------------------------------------- fault injection

/// Runs a scenario with a deliberate violation and returns what the checks reported, printed so the failing output
/// is visible with `--nocapture`.
fn with_fault(keys: &str, codex: &str, inv: &str, fault: Fault) -> Vec<String> {
    let mut s = Scenario::new(
        by_id(KEYS, keys, |v| v.id),
        by_id(CODEX, codex, |v| v.id),
        by_id(INVOCATIONS, inv, |v| v.id),
        &REPO_CONFIGS[0],
        &CLIENTS[0],
        Answer::Ok,
    );
    s.fault = Some(fault);
    let se = run_session(&s);
    let v = check(&s, &se);
    eprintln!("{fault:?} on {}:\n  {}", s.title, v.join("\n  "));
    v
}

fn caught(v: &[String], property: &str) -> bool {
    v.iter().any(|l| l.starts_with(property))
}

#[test]
fn the_checks_catch_a_key_in_a_request_body_or_a_written_file() {
    assert!(caught(
        &with_fault("shell-key", "no-codex", "terminal", Fault::KeyInRequestBody),
        "hold-the-line 1: canary"
    ));
    assert!(caught(
        &with_fault(
            "shell-key",
            "no-codex",
            "terminal",
            Fault::KeyWrittenToCache
        ),
        "hold-the-line 1: canary"
    ));
}

#[test]
fn the_checks_catch_a_file_that_must_not_be_opened_being_opened() {
    let v = with_fault(
        "shell-key",
        "no-codex",
        "terminal",
        Fault::OpenPlantedUserConfig,
    );
    assert!(
        v.iter()
            .any(|l| l.starts_with("hold-the-line 1") && l.ends_with("was opened")),
        "{v:?}"
    );
}

#[test]
fn the_checks_catch_a_request_off_the_machine_and_repository_code_in_a_body() {
    let v = with_fault(
        "shell-key",
        "no-codex",
        "terminal",
        Fault::ProviderOffMachine,
    );
    assert!(
        v.iter()
            .any(|l| l.starts_with("hold-the-line 2: a request left this machine")),
        "{v:?}"
    );
    let v = with_fault(
        "shell-key",
        "no-codex",
        "terminal",
        Fault::RepoCodeInRequestBody,
    );
    assert!(
        v.iter()
            .any(|l| l.starts_with("hold-the-line 2") && l.ends_with("repository code")),
        "{v:?}"
    );
}

#[test]
fn the_checks_catch_an_error_exit() {
    let v = with_fault("shell-key", "no-codex", "terminal", Fault::ErrorExit);
    assert!(caught(&v, "hold-the-line 4"), "{v:?}");
}

#[test]
fn the_checks_catch_a_second_question_and_a_question_without_a_terminal() {
    assert!(caught(
        &with_fault("shell-key", "no-codex", "terminal", Fault::SecondQuestion),
        "questions: 2 questions"
    ));
    assert!(caught(
        &with_fault(
            "shell-key",
            "no-codex",
            "ci",
            Fault::QuestionWithoutTerminal
        ),
        "questions:"
    ));
}

#[test]
fn the_checks_catch_a_notice_shown_twice_in_a_day() {
    assert!(caught(
        &with_fault("shell-key", "no-codex", "terminal", Fault::NoticeTwice),
        "notice:"
    ));
}

#[test]
fn the_checks_catch_internal_vocabulary_and_progress_lines_without_a_terminal() {
    let old = "deferred: the provider is not answering; it runs next time\n";
    assert!(caught(&wording("unstale infer", false, old), "wording:"));
    let progress = "  Mapping your stack · step 1/5 · shop · 2 direct packages\n";
    assert!(caught(
        &wording("unstale init", false, progress),
        "wording:"
    ));
    assert!(wording("unstale init", true, progress).is_empty());
    let now = "warning: the provider is not answering, so some new release notes are not read yet. The next sync tries again.\n";
    assert!(wording("unstale infer", false, now).is_empty());
}

#[test]
fn the_checks_catch_a_covered_release_sent_for_extraction() {
    let v = with_fault(
        "shell-key",
        "no-codex",
        "terminal",
        Fault::ExtractsCoveredRelease,
    );
    assert!(
        v.iter()
            .any(|l| l.starts_with("model steps: next@16.1.0 was sent")),
        "{v:?}"
    );
}

#[test]
fn the_checks_catch_a_noisy_session_start() {
    let v = with_fault("shell-key", "no-codex", "agent", Fault::NoisyHook);
    assert!(
        v.iter()
            .any(|l| l.starts_with("hold-the-line 5: session start printed more than one line")),
        "{v:?}"
    );
    assert!(
        v.iter()
            .any(|l| l.starts_with("hold-the-line 5: session start wrote to stderr")),
        "{v:?}"
    );
}

// ------------------------------------------------------------------------------------------- not runnable yet

/// Hold-the-line 5 on a set-up repository: session start returns within 2 s, exits 0 and prints at most one line, in
/// the worst cases (the catalog and the coverage service accepting connections and never answering, with coverage
/// still growing so the hook asks it; a state file that never finishes reading).
#[test]
fn session_start_returns_within_two_seconds_and_prints_at_most_one_line() {
    let s = Scenario::new(
        by_id(KEYS, "shell-key", |v| v.id),
        by_id(CODEX, "no-codex", |v| v.id),
        by_id(INVOCATIONS, "terminal", |v| v.id),
        &REPO_CONFIGS[0],
        &CLIENTS[0],
        Answer::Ok,
    );
    let se = run_session(&s);
    let w = &se.world;
    let repo = w.repo();
    let config_path = repo.join(".unstale/config.json");
    let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let hung = format!("http://{}", silent.local_addr().unwrap());
    let mut config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    config["catalog"] = json!(hung);
    config["service"] = json!(hung);
    write(&config_path, &config.to_string());
    let job = json!({"jobs": {"pkg:npm/next": {"purl": "pkg:npm/next", "technology": "next", "name": "next", "state": "queued", "stage": "", "records": 1, "updated": ""}}});
    write(&repo.join(".unstale/state/coverage.json"), &job.to_string());
    let notify = |case: &str| {
        let started = std::time::Instant::now();
        let r = exec(w, &s, vec!["notify".into()], false);
        let took = started.elapsed();
        eprintln!("session start, {case}: {} ms", took.as_millis());
        assert_eq!(r.code, 0, "{case}: {}", r.output);
        assert!(r.output.lines().count() <= 1, "{case}: {}", r.output);
        assert!(took < Duration::from_secs(2), "{case}: {took:?}");
    };
    notify("catalog and coverage service hanging");
    // A read that never finishes (a FIFO with no writer standing in for a hung disk): only the deadline bounds it.
    for (case, rel) in [
        ("session state read hanging", "session-sync.json"),
        ("coverage state read hanging", "coverage.json"),
    ] {
        let p = repo.join(".unstale/state").join(rel);
        let _ = std::fs::remove_file(&p);
        assert!(Command::new("mkfifo").arg(&p).status().unwrap().success());
        notify(case);
        std::fs::remove_file(&p).unwrap();
    }
    drop(silent);
}

#[test]
#[ignore = "needs the client's pipeline steps, the only spenders of the budget, which are not on main yet"]
fn the_budget_defers_work_in_demand_order() {}

#[test]
#[ignore = "needs the client's pipeline steps, whose results a second repository would reuse, which are not on main yet"]
fn a_second_repository_reuses_the_cached_results() {}

#[test]
#[ignore = "needs a published previous release that has the switch, to upgrade from"]
fn upgrading_from_the_previous_release_during_grace() {}

#[test]
#[ignore = "needs the min_client value the catalog raises to at cutover"]
fn running_after_the_min_client_bump() {}

/// Whether the chosen provider's routes are ones a pass can call: a provider is chosen and its key variables are its
/// routes' own.
fn routes_usable(chosen: &serde_json::Value) -> bool {
    serde_json::from_value::<serde_json::Value>(chosen.clone())
        .ok()
        .and_then(|c| c["provider"].as_str().map(|p| p != "none"))
        .unwrap_or(false)
}

/// The provider the session ended with, if any (including `none`).
fn provider_id_after(w: &World) -> Option<String> {
    chosen(w).and_then(|c| c["provider"].as_str().map(String::from))
}
