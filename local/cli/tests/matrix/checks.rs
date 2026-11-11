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
    /// A path under HOME is sent in a request body.
    HomePathInRequestBody,
    /// A repository file's name and contents are sent in a request body.
    RepoFileInRequestBody,
    /// The client opens files nobody planted, outside the places it may read.
    ReadsUnplantedSecret,
    /// The first 12 characters of a key are printed.
    KeyPrefixPrinted,
    /// `codex exec` is started with the client's whole environment.
    CodexEnvNotCleared,
    /// A provider's redirect is followed, with the key.
    RedirectFollowed,
    /// `init --yes` asks at a terminal.
    YesIgnored,
    /// The model step exits non-zero with Codex logged out.
    CodexLoggedOutExits,
    /// With registry lookups on, a host other than the registries is reached through the proxy.
    ElsewhereThroughProxy,
}

/// Variables `codex exec` may be started with: the client's own list (`src/inference/codex.rs`, `PASSED_ENV`), and
/// what the shell running the fake `codex` sets itself.
#[rustfmt::skip]
pub(crate) const CODEX_ENV: &[&str] = &[
    "PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "XDG_CONFIG_HOME", "SSL_CERT_FILE",
    "SSL_CERT_DIR", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "SYSTEMROOT",
    "PWD", "OLDPWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING",
];

/// The canaries `text` carries, whole or any 12 characters of one in a row (a key's prefix, a masked key).
pub(crate) fn canary_parts_in(text: &str) -> Vec<&'static str> {
    support::CANARIES
        .into_iter()
        .filter(|c| {
            (0..=c.len().saturating_sub(12)).any(|i| text.contains(&c[i..(i + 12).min(c.len())]))
        })
        .collect()
}

/// A request body as text to search: a JSON body's strings decoded (so an escaped path or file content is found too),
/// else the body as sent.
pub(crate) fn readable(body: &str) -> String {
    fn strings(v: &serde_json::Value, out: &mut String) {
        match v {
            serde_json::Value::String(s) => {
                out.push_str(s);
                out.push('\n');
            }
            serde_json::Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
            serde_json::Value::Object(o) => o.iter().for_each(|(k, x)| {
                out.push_str(k);
                out.push('\n');
                strings(x, out)
            }),
            _ => {}
        }
    }
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(v) => {
            let mut out = String::new();
            strings(&v, &mut out);
            out
        }
        Err(_) => body.to_string(),
    }
}

/// Text every request may carry: the published prompt templates (`schema/prompts/`) and the fixture's public release
/// notes. A repository file's bare name (`package.json`) found outside them is a leak.
pub(crate) fn public_text() -> &'static [String] {
    static LINES: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    LINES.get_or_init(|| {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../schema/prompts");
        let mut lines: Vec<String> = RELEASES.iter().map(|r| r.notes.to_string()).collect();
        fn walk(v: &serde_json::Value, out: &mut Vec<String>) {
            match v {
                serde_json::Value::String(s) => out.extend(s.lines().map(String::from)),
                serde_json::Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
                serde_json::Value::Object(o) => o.values().for_each(|x| walk(x, out)),
                _ => {}
            }
        }
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let v: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(e.path()).unwrap()).unwrap();
            walk(&v, &mut lines);
        }
        lines.retain(|l| l.trim().len() >= 8);
        lines.sort_by_key(|l| std::cmp::Reverse(l.len()));
        lines
    })
}

/// What of this repository's files `body` carries: a path under HOME, a file's name, or a line of its contents.
pub(crate) fn repo_leaks(w: &World, body: &str) -> Vec<String> {
    let text = format!("{body}\n{}", readable(body));
    let mut out = vec![];
    let home = w.home();
    for h in [home.clone(), home.canonicalize().unwrap_or(home.clone())] {
        if text.contains(&h.display().to_string()) {
            out.push("a path under HOME".to_string());
        }
    }
    let mut stripped = readable(body);
    for l in public_text() {
        stripped = stripped.replace(l.as_str(), "");
    }
    let repo = w.repo();
    for (p, content) in support::files_under(&repo) {
        let rel = p.strip_prefix(&repo).unwrap().display().to_string();
        // What the client itself writes in the repository is not the repository's own.
        if [
            ".git/",
            ".unstale/",
            ".claude/",
            ".codex/",
            ".agents/",
            ".opencode/",
            ".cursor/",
        ]
        .iter()
        .any(|d| rel.starts_with(d))
        {
            continue;
        }
        let named = if rel.contains('/') {
            text.contains(&rel)
        } else {
            stripped.contains(&rel)
        };
        if named {
            out.push(format!("the file name {rel}"));
        }
        if content
            .lines()
            .map(str::trim)
            .filter(|l| l.len() >= 16)
            .any(|l| text.contains(l))
        {
            out.push(format!("the contents of {rel}"));
        }
    }
    out.sort();
    out.dedup();
    out
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

/// Product bugs the matrix found and the harness may not fix: each a violation's start and where it comes from. A
/// scenario that shows one passes with it listed in its transcript; a listed bug no scenario shows any more fails the
/// run, so the list is kept true.
pub(crate) struct KnownBug {
    /// Whether a violation, in a scenario, is this bug: its exact symptom, in the scenarios where it shows.
    pub(crate) is: fn(&Scenario, &str) -> bool,
    pub(crate) why: &'static str,
}

/// The status warning printed twice for this bug: a chosen key variable this scenario's shell does not set, or the
/// monthly token limit in a scenario that reaches it.
fn doubled_status_warning(s: &Scenario, v: &str) -> bool {
    let Some(line) = v
        .strip_prefix(
            "wording: `unstale status --wait 0 --no-animation` printed the same warning twice: \"",
        )
        .and_then(|l| l.strip_suffix('"'))
    else {
        return false;
    };
    if line
        == "warning: monthly token limit reached, so new release notes wait. Change it: `unstale setup --limit`."
    {
        return matches!(s.answer, Answer::BudgetSpent | Answer::LimitPartway)
            || s.limits.is_some();
    }
    line.strip_prefix("warning: ")
        .and_then(|l| {
            l.strip_suffix(" is not set here, so new release notes are not read. Set it.")
        })
        .is_some_and(|var| {
            setup_key_vars().contains(&var)
                && (!s.keys.shell.contains(&var) || s.keys.blank.contains(&var))
        })
}

/// The key variables a stored choice may name.
fn setup_key_vars() -> [&'static str; 5] {
    [
        "OPENAI_API_KEY",
        "AI_GATEWAY_API_KEY",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "JEV_API_KEY",
    ]
}

pub(crate) const KNOWN_BUGS: &[KnownBug] = &[
    KnownBug {
        is: doubled_status_warning,
        why: "a model stage stopped for a key not set here or the monthly token limit: setup's own warning for it (src/setup.rs, status warnings) and the session state's stored deferral (src/session.rs, status_lines) are the same line, printed twice",
    },
    KnownBug {
        is: |s, v| {
            s.client.id == "below-min"
                && v == "min_client: no command said the catalog no longer serves this client"
        },
        why: "after the catalog raises min_client above this client, `unstale init` and `unstale status` sync silently and print no refusal; only `sync` and the session-start sync say it",
    },
    KnownBug {
        is: |s, v| {
            s.client.id == "below-min"
                && v.starts_with(
                    "model steps: `unstale session-sync` said every release note is read, with ",
                )
        },
        why: "after a refused catalog sync (min_client), session-sync's model stage gets the technologies of the failed sync (none) instead of the cached ones, then ends with \"every release note here is read\" while releases wait (src/session.rs, background)",
    },
];

/// The known bug a violation in this scenario is, if any.
pub(crate) fn known_bug(s: &Scenario, violation: &str) -> Option<&'static str> {
    KNOWN_BUGS
        .iter()
        .find(|b| (b.is)(s, violation))
        .map(|b| b.why)
}

#[test]
fn a_known_bug_exempts_only_its_own_symptom_in_its_own_scenarios() {
    let mk = |client: &str, answer: Answer| {
        Scenario::new(
            by_id(KEYS, "shell-key", |v| v.id),
            by_id(CODEX, "no-codex", |v| v.id),
            by_id(INVOCATIONS, "terminal", |v| v.id),
            by_id(REPO_CONFIGS, "config-set", |v| v.id),
            by_id(CLIENTS, client, |v| v.id),
            answer,
        )
    };
    let twice = |l: &str| {
        format!(
            "wording: `unstale status --wait 0 --no-animation` printed the same warning twice: {l:?}"
        )
    };
    let fresh = mk("fresh", Answer::Ok);
    // The key is set in this scenario's shell, so its doubled warning is not this bug; another warning never is.
    assert!(known_bug(&fresh, &twice("warning: OPENAI_API_KEY is not set here, so new release notes are not read. Set it.")).is_none());
    assert!(known_bug(&fresh, &twice("warning: the provider is not answering, so new release notes wait. The next sync tries again.")).is_none());
    assert!(known_bug(&fresh, &twice("warning: ANTHROPIC_API_KEY is not set here, so new release notes are not read. Set it.")).is_some());
    assert!(known_bug(&fresh, &twice("warning: monthly token limit reached, so new release notes wait. Change it: `unstale setup --limit`.")).is_none());
    assert!(known_bug(&mk("fresh", Answer::BudgetSpent), &twice("warning: monthly token limit reached, so new release notes wait. Change it: `unstale setup --limit`.")).is_some());
    // The min_client entries only below min_client.
    let read = "model steps: `unstale session-sync` said every release note is read, with [\"next@16.3.0\"] unread";
    assert!(known_bug(&fresh, read).is_none());
    assert!(known_bug(&mk("below-min", Answer::Ok), read).is_some());
    assert!(
        known_bug(
            &fresh,
            "min_client: no command said the catalog no longer serves this client"
        )
        .is_none()
    );
}

/// What a command's output breaks of the plain-words rule.
pub(crate) fn wording(shown: &str, terminal: bool, output: &str) -> Vec<String> {
    let mut v = vec![];
    // A warning is said once.
    let mut seen = BTreeSet::new();
    for l in output.lines().filter(|l| l.starts_with("warning: ")) {
        if !seen.insert(l) {
            v.push(format!(
                "wording: `{shown}` printed the same warning twice: {l:?}"
            ));
        }
    }
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
        for c in canary_parts_in(&r.output) {
            v.push(format!(
                "hold-the-line 1: canary {c} in the output of `{}`",
                r.shown
            ));
        }
    }
    let planted = [w.repo().join(".env"), w.home().join(".npmrc")];
    for (p, text) in support::files_under(w.base.path()) {
        if planted.contains(&p) || p.starts_with(w.codex_dir()) {
            continue;
        }
        for c in canary_parts_in(&text) {
            v.push(format!(
                "hold-the-line 1: canary {c} written to {}",
                w.normalise(&p.display().to_string())
            ));
        }
    }
    for (host, reqs) in [("the catalog host", &catalog), ("the proxy", &trapped)] {
        for r in reqs.iter() {
            for c in canary_parts_in(&r.raw()) {
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
        for c in canary_parts_in(&r.body) {
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
    for c in canary_parts_in(&exec_env)
        .into_iter()
        .chain(canary_parts_in(&exec_args))
        .chain(
            codex_calls
                .iter()
                .flat_map(|r| canary_parts_in(&r.body))
                .collect::<Vec<_>>(),
        )
    {
        v.push(format!("hold-the-line 1: canary {c} reached codex"));
    }
    // Codex is started with a cleared environment: only the variables it needs.
    let mut extra: BTreeSet<String> = BTreeSet::new();
    for line in exec_env.lines().filter(|l| *l != "---") {
        if let Some((k, _)) = line.split_once('=')
            && !k.is_empty()
            && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            && !CODEX_ENV.contains(&k)
        {
            extra.insert(k.to_string());
        }
    }
    if !extra.is_empty() {
        v.push(format!(
            "hold-the-line 1: codex was started with {} in its environment",
            extra.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
    for p in opened_outside(w) {
        v.push(format!("hold-the-line 1: the client opened {p}"));
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
        // With registry lookups on, the public registries are reached through the proxy: a `CONNECT` to their host,
        // nothing else. (What is asked inside the TLS tunnel cannot be read here: the client trusts only its own
        // bundled roots.)
        if s.registry && r.method == "CONNECT" && REGISTRY_HOSTS.contains(&r.path.as_str()) {
            continue;
        }
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
    bodies.extend(
        codex_calls
            .iter()
            .map(|r| ("codex exec".to_string(), r.body.clone())),
    );
    bodies.push(("codex exec".into(), exec_args.clone()));
    bodies.extend(trapped.iter().map(|r| ("the proxy".to_string(), r.raw())));
    for (what, body) in bodies {
        for needle in [CODE_MARKER, "middleware.ts\n", "src/middleware.ts"] {
            if body.contains(needle) {
                v.push(format!("hold-the-line 2: {what} received repository code"));
            }
        }
        for leak in repo_leaks(w, &body) {
            v.push(format!("hold-the-line 2: {what} received {leak}"));
        }
    }
    // A redirect is never followed: the key would go wherever it points.
    let followed = w.redirect_target.requests().len();
    if followed > 0 {
        v.push(format!(
            "hold-the-line 2: a redirect was followed ({followed} requests to where the provider pointed)"
        ));
    }

    // Hold-the-line 4: provider and budget failures defer with one line, exit 0. A command the person interrupted
    // with Ctrl-C may exit otherwise.
    for r in &se.ran {
        let pressed_ctrl_c = s.invocation.answer == "\u{3}" && questions(&r.output) > 0;
        // Below the catalog's min_client, `sync` refuses with its message and its own exit code (4).
        let refused = s.client.id == "below-min"
            && r.code == 4
            && r.output.contains("sync refused: the catalog needs unstale");
        if r.code != 0 && !pressed_ctrl_c && !refused {
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
        let results = lines.iter().filter(|l| !l.starts_with("warning: ")).count();
        if !r.terminal && (results > 1 || lines.is_empty()) {
            v.push(format!(
                "hold-the-line 4: `{}` without a terminal printed {} result lines, not at most one with its warnings: {:?}",
                r.shown,
                results,
                r.output
            ));
        }
        // Below min_client nothing new arrives, so a failing provider may never be asked.
        if fails
            && routes_usable(&chosen)
            && s.client.id != "below-min"
            && !last.starts_with("warning: ")
        {
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

    // Below min_client the client says so: the catalog no longer serves it.
    if s.client.id == "below-min" && !se.ran.iter().any(|r| r.output.contains("needs unstale")) {
        v.push("min_client: no command said the catalog no longer serves this client".into());
    }
    // Below min_client the cached catalog is kept.
    if s.client.id == "below-min" && !w.cache().join("v1/tech/next.json").exists() {
        v.push("min_client: the cached catalog was not kept after the refusal".into());
    }

    // With the switch off, session start does only what it did before: no background stage, no state of its own, no
    // other agent's hook installed, no model work.
    let off = s
        .invocation
        .env
        .iter()
        .any(|(k, v)| *k == "UNSTALE_EDGE_INFERENCE" && *v != "1");
    if off {
        for rel in [
            ".unstale/state/session-sync.json",
            ".unstale/state/session-sync.lock",
            ".codex/hooks.json",
            ".opencode/plugins/unstale-session.js",
        ] {
            if w.repo().join(rel).exists() {
                v.push(format!(
                    "switch off: {rel} was written, which only the switch's features write"
                ));
            }
        }
        if w.cache().join("inference").exists() || !provider.is_empty() || !codex_calls.is_empty() {
            v.push("switch off: model work ran".into());
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
    // "Every release note here is read" only when none waits.
    for r in se.ran.iter().filter(|r| r.step == Step::SessionSync) {
        if r.output
            .contains("Nothing new to read: every release note here is read.")
            && asked != due
        {
            v.push(format!(
                "model steps: `{}` said every release note is read, with {:?} unread",
                r.shown,
                due.difference(&asked).collect::<Vec<_>>()
            ));
        }
    }
    // A limit of one token is spent by the first call: only the most needed technology's release is asked about.
    if s.answer == Answer::LimitPartway && asked != BTreeSet::from(["react@19.2.0".to_string()]) {
        v.push(format!(
            "monthly token limit: the work did not stop after the most needed technology's first call: {asked:?}"
        ));
    }
    // A pass that stopped says why in the state (a key not set here, Codex logged out): then some may wait.
    let stopped = std::fs::read_to_string(w.repo().join(".unstale/state/session-sync.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|st| st.get("deferred").is_some());
    if !asked.is_empty() && s.answer == Answer::Ok && s.fault.is_none() && !stopped && asked != due
    {
        v.push(format!(
            "model steps: with the provider answering, only {asked:?} of {due:?} were read"
        ));
    }
    // Matching asks whether a new change is one the catalog knows: never with an Anthropic key alone (matching is off
    // there), and on every other route once the releases were read (one of them repeats a catalog record's subject).
    let judged = provider
        .iter()
        .map(|r| r.body.clone())
        .chain(codex_calls.iter().map(|r| r.body.clone()))
        .filter(|b| b.contains("same change as candidate"))
        .count();
    if provider_id == "anthropic" && !labels_service && judged > 0 {
        v.push(format!(
            "model steps: matching asked {judged} questions with an Anthropic key alone"
        ));
    }
    if (provider_id != "anthropic" || labels_service)
        && asked == due
        && s.answer == Answer::Ok
        && judged == 0
    {
        v.push("model steps: the releases were read but matching never asked".into());
    }

    // At most one question per path, none without a terminal.
    let asked: usize = se.ran.iter().map(|r| questions(&r.output)).sum();
    if asked > 1 {
        v.push(format!("questions: {asked} questions on one path"));
    }
    for r in &se.ran {
        if r.shown.contains("--yes") && questions(&r.output) > 0 {
            v.push(format!("questions: `{}` asked a question", r.shown));
        }
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
    // With the switch off the output is the one from before the switch's features, by design (nothing of them shows
    // until they ship whole), so the new wording rules do not apply there.
    let switch_off = s
        .invocation
        .env
        .iter()
        .any(|(k, v)| *k == "UNSTALE_EDGE_INFERENCE" && *v != "1");
    for r in se.ran.iter().filter(|_| !switch_off) {
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
                // Every line naming the newer version, except a refusal below min_client, which names it too.
                .filter(|l| l.contains(&newer_version()) && !l.contains(" or newer and this is "))
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
    with_fault_in(keys, codex, inv, "no-config", Answer::Ok, fault)
}

/// [`with_fault`] with a repository config and a provider answer.
fn with_fault_in(
    keys: &str,
    codex: &str,
    inv: &str,
    config: &str,
    answer: Answer,
    fault: Fault,
) -> Vec<String> {
    let mut s = Scenario::new(
        by_id(KEYS, keys, |v| v.id),
        by_id(CODEX, codex, |v| v.id),
        by_id(INVOCATIONS, inv, |v| v.id),
        by_id(REPO_CONFIGS, config, |v| v.id),
        &CLIENTS[0],
        answer,
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

/// A command that asks twice ends (the second question dismissed) and both are counted: reported as two questions,
/// never as a run that waited a minute for an answer.
#[test]
fn a_second_question_is_counted_not_waited_on() {
    let mut c = Command::new("/bin/sh");
    c.args([
        "-c",
        "printf 'Enter for 1, a number: '; read a; printf 'Enter for 1, again: '; read b; echo done",
    ]);
    let started = std::time::Instant::now();
    let (code, out) = support::at_terminal(&c, &terminal_answers("\n"), Duration::from_secs(60));
    assert!(started.elapsed() < Duration::from_secs(10), "{out}");
    assert_eq!((code, questions(&out)), (0, 2), "{out}");
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

#[test]
fn the_checks_catch_a_home_path_or_a_repository_file_in_a_request_body() {
    let v = with_fault(
        "shell-key",
        "no-codex",
        "terminal",
        Fault::HomePathInRequestBody,
    );
    assert!(
        v.iter()
            .any(|l| l.starts_with("hold-the-line 2") && l.ends_with("a path under HOME")),
        "{v:?}"
    );
    let v = with_fault(
        "shell-key",
        "no-codex",
        "terminal",
        Fault::RepoFileInRequestBody,
    );
    for leak in ["the file name package.json", "the contents of package.json"] {
        assert!(
            v.iter()
                .any(|l| l.starts_with("hold-the-line 2") && l.ends_with(leak)),
            "{leak}: {v:?}"
        );
    }
}

#[test]
fn the_checks_catch_a_file_opened_that_nobody_planted() {
    let v = with_fault(
        "shell-key",
        "no-codex",
        "terminal",
        Fault::ReadsUnplantedSecret,
    );
    assert!(
        v.iter()
            .any(|l| l.starts_with("hold-the-line 1: the client opened ~/.config/gcloud/")),
        "{v:?}"
    );
}

#[test]
fn the_checks_catch_a_key_prefix_printed_and_a_key_in_an_anthropic_request() {
    let v = with_fault("shell-key", "no-codex", "terminal", Fault::KeyPrefixPrinted);
    assert!(
        v.iter()
            .any(|l| l.starts_with("hold-the-line 1: canary canary-shell-key")),
        "{v:?}"
    );
    let v = with_fault_in(
        "anthropic-key",
        "no-codex",
        "terminal",
        "config-anthropic",
        Answer::Ok,
        Fault::KeyInRequestBody,
    );
    assert!(
        v.iter().any(|l| l.starts_with("hold-the-line 1: canary")
            && l.ends_with("in a request body to the provider (/v1/messages)")),
        "{v:?}"
    );
}

#[test]
fn the_checks_catch_codex_started_with_the_whole_environment() {
    let v = with_fault("shell-key", "codex", "terminal", Fault::CodexEnvNotCleared);
    assert!(
        v.iter()
            .any(|l| l.starts_with("hold-the-line 1: codex was started with")
                && l.contains("OPENAI_API_KEY")),
        "{v:?}"
    );
}

#[test]
fn the_checks_catch_a_redirect_followed() {
    let v = with_fault_in(
        "shell-key",
        "no-codex",
        "terminal",
        "no-config",
        Answer::Redirect,
        Fault::RedirectFollowed,
    );
    assert!(
        v.iter()
            .any(|l| l.starts_with("hold-the-line 2: a redirect was followed")),
        "{v:?}"
    );
}

#[test]
fn the_checks_catch_init_yes_asking_at_a_terminal() {
    let v = with_fault("shell-key", "codex", "terminal-yes", Fault::YesIgnored);
    assert!(
        v.iter()
            .any(|l| l.starts_with("questions: `unstale init --wait 0 --no-animation --yes` asked")),
        "{v:?}"
    );
}

#[test]
fn the_checks_catch_codex_logged_out_exiting_non_zero() {
    let v = with_fault_in(
        "no-key",
        "codex-logged-out",
        "terminal",
        "config-codex",
        Answer::Ok,
        Fault::CodexLoggedOutExits,
    );
    assert!(
        v.iter()
            .any(|l| l.starts_with("hold-the-line 4: `unstale session-sync` exited 1")),
        "{v:?}"
    );
}

#[test]
fn with_registry_lookups_on_the_checks_catch_another_host_through_the_proxy() {
    let mut s = Scenario::new(
        by_id(KEYS, "shell-key", |v| v.id),
        by_id(CODEX, "no-codex", |v| v.id),
        by_id(REGISTRY_INVOCATIONS, "ci", |v| v.id),
        &REPO_CONFIGS[0],
        &CLIENTS[0],
        Answer::Ok,
    );
    s.registry = true;
    s.fault = Some(Fault::ElsewhereThroughProxy);
    let se = run_session(&s);
    let v = check(&s, &se);
    eprintln!("{v:?}");
    assert!(
        v.iter()
            .any(|l| l
                == "hold-the-line 2: a request left this machine (CONNECT telemetry.example:443)"),
        "{v:?}"
    );
    assert!(!v.iter().any(|l| l.contains("registry.npmjs.org")), "{v:?}");
}

/// What in the client's source could open a connection that ignores the proxy variables: an HTTP agent configured with
/// no proxy or its own, or a raw socket. Every request the client makes goes through `ureq` agents that read the proxy
/// variables, which every scenario points at the trap. (No scenario can take the network away: an unprivileged
/// network namespace is not available on every CI runner, and macOS has no supported way to do it.)
/// A line without its `//` comment: a `//` inside a string literal (`"http://..."`) is code.
pub(crate) fn code_of(line: &str) -> &str {
    let b = line.as_bytes();
    let (mut in_str, mut i) = (false, 0);
    while i < b.len() {
        match b[i] {
            b'\\' if in_str => i += 1,
            b'"' => in_str = !in_str,
            b'/' if !in_str && b.get(i + 1) == Some(&b'/') => return &line[..i],
            _ => {}
        }
        i += 1;
    }
    line
}

pub(crate) fn proxy_bypasses(file: &str, text: &str) -> Vec<String> {
    let mut out = vec![];
    for (n, line) in text.lines().enumerate() {
        let code = code_of(line);
        for pattern in [
            ".proxy(",
            "Proxy::new",
            "no_proxy(",
            "TcpStream::connect",
            "UdpSocket::bind",
            "TcpStream",
        ] {
            if code.contains(pattern) {
                out.push(format!("{file}:{}: {pattern}", n + 1));
                break;
            }
        }
    }
    out
}

#[test]
fn no_client_connection_ignores_the_proxy_variables() {
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut found = vec![];
    for (p, text) in support::files_under(&src) {
        let rel = p.strip_prefix(&src).unwrap().display().to_string();
        // Tests may start their own local servers.
        if !rel.ends_with(".rs") || rel.contains("tests") || rel == "testcat.rs" {
            continue;
        }
        // A file's own test module.
        let text = text.split("\n#[cfg(test)]").next().unwrap_or(&text);
        found.extend(proxy_bypasses(&rel, text));
    }
    assert!(found.is_empty(), "{found:#?}");
    // The check fails when the property breaks.
    let injected =
        "let agent: ureq::Agent = ureq::Agent::config_builder().proxy(None).build().into();";
    assert_eq!(
        proxy_bypasses("injected.rs", injected),
        ["injected.rs:1: .proxy("]
    );
    // A `//` in a string before it does not hide it; a real comment does.
    let behind_url = r#"let a = agent("http://x").proxy(None);"#;
    assert_eq!(
        proxy_bypasses("injected.rs", behind_url),
        ["injected.rs:1: .proxy("]
    );
    assert!(proxy_bypasses("ok.rs", "let a = 1; // .proxy(None) is never used").is_empty());
}

// ------------------------------------------------------------------------------------------- not runnable yet

/// A stand-in for opencode: loads the installed plugin with a `$` like Bun's shell (each interpolated value one
/// argument), sends it `session.created` and waits for the handler, as opencode does. Prints nothing itself.
const OPENCODE_SESSION: &str = r#"
import { spawn } from "node:child_process";
const repo = process.argv[2];
const $ = (strings, ...values) => {
  const argv = [];
  strings.forEach((s, i) => {
    argv.push(...s.split(/\s+/).filter(Boolean));
    if (i < values.length) argv.push(...[values[i]].flat().map(String));
  });
  const run = new Promise((resolve) => {
    const p = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "inherit", "inherit"] });
    p.on("exit", resolve);
    p.on("error", resolve);
  });
  const shell = { quiet: () => shell, nothrow: () => shell, catch: (f) => run.catch(f), then: (a, b) => run.then(a, b) };
  return shell;
};
const { UnstaleSessionSync } = await import(new URL("./plugin.mjs", import.meta.url));
const hooks = await UnstaleSessionSync({ $, directory: repo });
await hooks.event({ event: { type: "session.created" } });
"#;

/// Each agent's installed session-start hook, run as that agent runs it: (agent, exit code, stdout, stderr, time).
fn every_hook(
    w: &World,
    s: &Scenario,
    extra: &[(String, String)],
) -> Vec<(&'static str, i32, String, String, Duration)> {
    let mut out = vec![];
    for (agent, file) in [
        ("Claude Code", ".claude/settings.local.json"),
        ("Codex", ".codex/hooks.json"),
    ] {
        let command =
            hook_command(&w.repo(), file).unwrap_or_else(|| panic!("{agent}'s hook is installed"));
        let mut sh = Command::new("/bin/sh");
        sh.arg("-c")
            .arg(format!("{}{command}", reload_logger()))
            .current_dir(w.repo())
            .env_clear();
        for (k, v) in w.env(s).into_iter().chain(extra.iter().cloned()) {
            sh.env(k, v);
        }
        sh.env("CLAUDE_PROJECT_DIR", w.repo());
        let t = std::time::Instant::now();
        let (code, o, e) = support::run_within(&mut sh, Duration::from_secs(30));
        out.push((agent, code, o, e, t.elapsed()));
    }
    let plugin = std::fs::read_to_string(w.repo().join(".opencode/plugins/unstale-session.js"))
        .expect("opencode's plugin is installed");
    let dir = w.base.path().join("opencode");
    write(&dir.join("plugin.mjs"), &plugin);
    write(&dir.join("session.mjs"), OPENCODE_SESSION);
    let mut node = Command::new("node");
    node.arg(dir.join("session.mjs"))
        .arg(w.repo())
        .current_dir(w.repo())
        .env_clear();
    for (k, v) in w.env(s).into_iter().chain(extra.iter().cloned()) {
        node.env(k, v);
    }
    // node is found on the machine's own PATH.
    node.env(
        "PATH",
        format!(
            "{}:{}",
            w.base.path().join("bin").display(),
            std::env::var("PATH").unwrap_or_default()
        ),
    );
    let t = std::time::Instant::now();
    let (code, o, e) = support::run_within(&mut node, Duration::from_secs(30));
    out.push(("opencode", code, o, e, t.elapsed()));
    out
}

/// Ends the background stages this world's hooks started: what they do is not what this test is about, and one waiting
/// on a hung host would run for minutes.
fn stop_background(w: &World) {
    let tag = w
        .base
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let _ = Command::new("pkill")
        .args(["-f", &format!("{tag}.*session-sync")])
        .status();
    wait_for_background(w);
}

/// Hold-the-line 5: every agent's installed session-start hook (Claude Code, Codex, opencode), run as that agent runs
/// it, returns within 2 s, exits 0, prints at most one line and nothing on stderr, in the worst cases: the catalog and
/// the coverage service accepting connections and never answering (with coverage still growing, so the hook asks it);
/// a state file that never finishes reading; the provider hanging with model work pending; the cache corrupt.
#[test]
fn session_start_returns_within_two_seconds_and_prints_at_most_one_line() {
    let s = Scenario::new(
        by_id(KEYS, "shell-key", |v| v.id),
        by_id(CODEX, "no-codex", |v| v.id),
        by_id(INVOCATIONS, "agent", |v| v.id),
        by_id(REPO_CONFIGS, "config-set", |v| v.id),
        &CLIENTS[0],
        Answer::Ok,
    );
    let se = run_session(&s);
    let w = &se.world;
    let repo = w.repo();
    let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let hung = format!("http://{}", silent.local_addr().unwrap());
    // The background stages these start give up on a hung request after 3 s, so the test does not wait on them.
    let mut extra = vec![("UNSTALE_HTTP_TIMEOUT".to_string(), "3".to_string())];
    let hold = |case: &str, extra: &[(String, String)]| {
        for (agent, code, out, err, took) in every_hook(w, &s, extra) {
            eprintln!("session start, {agent}, {case}: {} ms", took.as_millis());
            assert_eq!(code, 0, "{agent}, {case}: {out}{err}");
            assert!(out.lines().count() <= 1, "{agent}, {case}: {out}");
            assert_eq!(err, "", "{agent}, {case}");
            assert!(took < Duration::from_secs(2), "{agent}, {case}: {took:?}");
        }
    };
    hold("set up, nothing wrong", &extra);

    let config_path = repo.join(".unstale/config.json");
    let original = std::fs::read_to_string(&config_path).unwrap();
    let mut config: serde_json::Value = serde_json::from_str(&original).unwrap();
    config["catalog"] = json!(hung);
    config["service"] = json!(hung);
    write(&config_path, &config.to_string());
    let job = json!({"jobs": {"pkg:npm/next": {"purl": "pkg:npm/next", "technology": "next", "name": "next", "state": "queued", "stage": "", "records": 1, "updated": ""}}});
    write(&repo.join(".unstale/state/coverage.json"), &job.to_string());
    hold("catalog and coverage service hanging", &extra);
    // A read that never finishes (a FIFO with no writer standing in for a hung disk): only the deadline bounds it.
    for (case, rel) in [
        ("session state read hanging", "session-sync.json"),
        ("coverage state read hanging", "coverage.json"),
    ] {
        let p = repo.join(".unstale/state").join(rel);
        let saved = std::fs::read(&p).ok();
        let _ = std::fs::remove_file(&p);
        assert!(Command::new("mkfifo").arg(&p).status().unwrap().success());
        hold(case, &extra);
        std::fs::remove_file(&p).unwrap();
        if let Some(b) = saved {
            std::fs::write(&p, b).unwrap();
        }
    }
    write(&config_path, &original);

    // The cache corrupt: every file replaced with bytes that do not parse.
    stop_background(w);
    let state_saved = std::fs::read(repo.join(".unstale/state/session-sync.json")).unwrap();
    for (p, _) in support::files_under(&w.cache()) {
        std::fs::write(p, b"\x00not json").unwrap();
    }
    hold("cache corrupt", &extra);
    std::fs::write(repo.join(".unstale/state/session-sync.json"), state_saved).unwrap();
    stop_background(w);

    // Model work pending (the last stage stopped) and the provider accepting connections and never answering: the
    // hook starts the stage and does not wait for it.
    let state_path = repo.join(".unstale/state/session-sync.json");
    let mut state: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&state_path).unwrap()).unwrap();
    state["deferred"] = json!(
        "warning: the provider is not answering, so new release notes wait. The next sync tries again."
    );
    write(&state_path, &state.to_string());
    let _ = std::fs::remove_dir_all(w.cache().join("inference"));
    extra.push(("UNSTALE_INFERENCE_BASE_URL".into(), format!("{hung}/v1")));
    hold("provider hanging, model work pending", &extra);

    stop_background(w);
    drop(silent);
}

/// The releases a session sent for extraction, and how many provider calls it made.
fn extraction_calls(se: &Session) -> (BTreeSet<String>, usize) {
    let reqs = se.world.provider_host.requests();
    let asked = reqs
        .iter()
        .flat_map(|r| model::releases_asked(&model::prompt_of(&r.body)))
        .collect();
    (asked, reqs.len())
}

/// The monthly token limit stops the work in demand order (react's record names two of this stack's packages, next's
/// one, so react's release is read first though `next` sorts first), and a repository's limit can only lower the
/// user's: a repository saying `none` does not lift a user's limit of 1 token; a repository's 1 lowers the user's
/// `none`. (The user's limit of 1 alone is the `limit-partway` scenario.)
#[test]
fn the_budget_defers_work_in_demand_order() {
    for limits in [("1", "none"), ("none", "1")] {
        let mut s = Scenario::new(
            by_id(KEYS, "shell-key", |v| v.id),
            by_id(CODEX, "no-codex", |v| v.id),
            by_id(INVOCATIONS, "ci", |v| v.id),
            by_id(REPO_CONFIGS, "config-set", |v| v.id),
            &CLIENTS[0],
            Answer::Ok,
        );
        s.limits = Some(limits);
        let se = run_session(&s);
        let (asked, calls) = extraction_calls(&se);
        let sync = se.ran.iter().find(|r| r.step == Step::SessionSync).unwrap();
        eprintln!(
            "limits {limits:?}: {calls} calls, {asked:?}: {}",
            sync.output
        );
        assert_eq!(calls, 1, "{limits:?}");
        assert_eq!(
            asked,
            BTreeSet::from(["react@19.2.0".to_string()]),
            "{limits:?}"
        );
        assert!(
            sync.output.contains("warning: monthly token limit reached"),
            "{limits:?}: {}",
            sync.output
        );
        let broken: Vec<String> = check(&s, &se)
            .into_iter()
            .filter(|l| known_bug(&s, l).is_none())
            .collect();
        assert!(broken.is_empty(), "{broken:?}");
    }
}

/// A second repository with the same stack, on the same machine, makes no model call: what the first paid for is in
/// the user-level caches. Its report reads the records all the same.
#[test]
fn a_second_repository_reuses_the_cached_results() {
    let s = Scenario::new(
        by_id(KEYS, "shell-key", |v| v.id),
        by_id(CODEX, "no-codex", |v| v.id),
        by_id(INVOCATIONS, "ci", |v| v.id),
        by_id(REPO_CONFIGS, "config-set", |v| v.id),
        &CLIENTS[0],
        Answer::Ok,
    );
    let se = run_session(&s);
    let w = &se.world;
    let (asked, first) = extraction_calls(&se);
    assert_eq!(asked, releases_to_read());
    let second = w.home().join("code/shop2");
    for rel in [
        "package.json",
        "node_modules/next/package.json",
        ".unstale/config.json",
    ] {
        write(
            &second.join(rel),
            &std::fs::read_to_string(w.repo().join(rel)).unwrap(),
        );
    }
    Command::new("git")
        .args(["init", "-q"])
        .current_dir(&second)
        .status()
        .unwrap();
    let mut outputs = vec![];
    for args in [
        vec!["init", "--yes", "--wait", "0", "--no-animation"],
        vec!["session-sync"],
        vec!["status", "--wait", "0", "--no-animation"],
    ] {
        let mut c = w.command(&s, &args.iter().map(|a| a.to_string()).collect::<Vec<_>>());
        c.current_dir(&second);
        let (code, out, err) = support::run_within(&mut c, Duration::from_secs(60));
        assert_eq!(code, 0, "{args:?}: {out}{err}");
        outputs.push(out);
    }
    eprintln!("{}", outputs.join("\n---\n"));
    assert_eq!(
        w.provider_host.requests().len(),
        first,
        "the second repository made model calls"
    );
    assert!(
        outputs[2].contains("next 16.0.0 → 16.3.0"),
        "the second repository's report reads the records: {}",
        outputs[2]
    );
}

/// Whether the chosen provider's routes are ones a pass can call: a provider is chosen and its key variables are its
/// routes' own.
fn routes_usable(chosen: &serde_json::Value) -> bool {
    serde_json::from_value::<serde_json::Value>(chosen.clone())
        .ok()
        .and_then(|c| c["provider"].as_str().map(|p| p != "none"))
        .unwrap_or(false)
}

/// Every path the client tried to open in HOME (the sibling repository included) outside the places it may read: this
/// repository, its own cache and its own user config. Normalised to `~/...`.
pub(crate) fn opened_outside(w: &World) -> BTreeSet<String> {
    let log = std::fs::read_to_string(w.open_log()).unwrap_or_default();
    let mut out = BTreeSet::new();
    for line in log.lines() {
        let p = w.normalise(&lexical(line));
        let Some(rel) = p.strip_prefix("~/") else {
            continue;
        };
        if !may_open(rel) {
            out.insert(format!("~/{rel}"));
        }
    }
    out
}

/// `path` with `.` and `..` resolved lexically, so `~/code/shop/../other/.env` is checked as `~/code/other/.env`.
pub(crate) fn lexical(path: &str) -> String {
    let mut parts: Vec<&str> = vec![];
    for c in path.split('/') {
        match c {
            "." => {}
            ".." => {
                if parts.last().is_some_and(|p| !p.is_empty()) {
                    parts.pop();
                }
            }
            "" if !parts.is_empty() => {}
            c => parts.push(c),
        }
    }
    let out = parts.join("/");
    if path.starts_with('/') && !out.starts_with('/') {
        format!("/{out}")
    } else {
        out
    }
}

/// An open the logger records as `~/code/shop/../other/config/master.key` is reported where it lands (the sibling),
/// not passed as a file of this repository. Fails without [`lexical`].
#[test]
fn the_checks_catch_a_read_that_climbs_out_of_the_repository() {
    let s = Scenario::new(
        by_id(KEYS, "no-key", |v| v.id),
        by_id(CODEX, "no-codex", |v| v.id),
        by_id(INVOCATIONS, "ci", |v| v.id),
        &REPO_CONFIGS[0],
        &CLIENTS[0],
        Answer::Ok,
    );
    let w = World::new(&s);
    write(
        &w.open_log(),
        &format!("{}/../other/config/master.key\n", w.repo().display()),
    );
    assert_eq!(
        opened_outside(&w),
        BTreeSet::from(["~/code/other/config/master.key".to_string()])
    );
}

#[test]
fn a_path_that_climbs_out_of_the_repository_is_checked_where_it_lands() {
    let climb = "/tmp/x/home/code/shop/../other/config/master.key";
    // Unresolved, it reads as a file of this repository.
    assert!(may_open("code/shop/../other/config/master.key"));
    assert_eq!(lexical(climb), "/tmp/x/home/code/other/config/master.key");
    assert!(!may_open("code/other/config/master.key"));
    assert_eq!(lexical("/a/./b//c/../d"), "/a/b/d");
    assert_eq!(lexical("~/code/shop/./.env"), "~/code/shop/.env");
}

/// The provider the session ended with, if any (including `none`).
fn provider_id_after(w: &World) -> Option<String> {
    chosen(w).and_then(|c| c["provider"].as_str().map(String::from))
}
