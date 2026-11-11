//! The scenario table: the dimensions, the critical paths, and their expansion to all pairs.

use super::*;

/// Which key variables are set, and where. Each key's value is a canary.
pub(crate) struct Keys {
    pub(crate) id: &'static str,
    /// Plain words, as a scenario's title uses them.
    pub(crate) title: &'static str,
    pub(crate) shell: &'static [&'static str],
    /// In this repository's `.env`.
    pub(crate) repo_env: &'static [&'static str],
    /// Only in another repository's `.env`, which the client must never open.
    pub(crate) other_env: &'static [&'static str],
    /// How the provider answers this key.
    pub(crate) answer: Answer,
}

#[rustfmt::skip]
pub(crate) const KEYS: &[Keys] = &[
    Keys { id: "no-key", title: "no key", shell: &[], repo_env: &[], other_env: &[], answer: Answer::Ok },
    Keys { id: "shell-key", title: "an OpenAI key in the shell", shell: &["OPENAI_API_KEY"], repo_env: &[], other_env: &[], answer: Answer::Ok },
    Keys { id: "dotenv-key", title: "an OpenAI key in this repo's .env", shell: &[], repo_env: &["OPENAI_API_KEY"], other_env: &[], answer: Answer::Ok },
    Keys { id: "other-repo-key", title: "a key only in another repo's .env", shell: &[], repo_env: &[], other_env: &["ANTHROPIC_API_KEY"], answer: Answer::Ok },
    Keys { id: "several-keys", title: "several keys in the shell", shell: &["AI_GATEWAY_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "JEV_API_KEY"], repo_env: &[], other_env: &[], answer: Answer::Ok },
    Keys { id: "revoked-key", title: "a revoked OpenAI key in the shell", shell: &["OPENAI_API_KEY"], repo_env: &[], other_env: &[], answer: Answer::Refused },
];

pub(crate) struct Codex {
    pub(crate) id: &'static str,
    pub(crate) title: &'static str,
    pub(crate) installed: bool,
    pub(crate) logged_in: bool,
}

#[rustfmt::skip]
pub(crate) const CODEX: &[Codex] = &[
    Codex { id: "no-codex", title: "no Codex", installed: false, logged_in: false },
    Codex { id: "codex", title: "Codex logged in", installed: true, logged_in: true },
    Codex { id: "codex-logged-out", title: "Codex logged out", installed: true, logged_in: false },
];

/// Who runs the client, and the commands they run.
pub(crate) struct Invocation {
    pub(crate) id: &'static str,
    /// The gallery's group: what the user did.
    pub(crate) group: &'static str,
    pub(crate) title: &'static str,
    pub(crate) terminal: bool,
    pub(crate) ci: bool,
    pub(crate) steps: &'static [Step],
}

#[rustfmt::skip]
pub(crate) const INVOCATIONS: &[Invocation] = &[
    Invocation { id: "terminal", group: "Installs it at a terminal", title: "first run in a terminal", terminal: true, ci: false, steps: &[Step::Init, Step::Sync, Step::Model, Step::Status] },
    Invocation { id: "agent", group: "Asks an agent to install it", title: "an agent installs it", terminal: false, ci: false, steps: &[Step::Init, Step::Status, Step::AgentSetup, Step::Sync, Step::Model] },
    Invocation { id: "ci", group: "Runs it in CI", title: "in CI", terminal: false, ci: true, steps: &[Step::InitYes, Step::Sync, Step::Model, Step::Status] },
    Invocation { id: "ci-flag", group: "Runs it in CI", title: "in CI, choosing OpenAI with --inference", terminal: false, ci: true, steps: &[Step::InitFlag("env:OPENAI_API_KEY"), Step::Sync, Step::Model, Step::Status] },
];

/// The repository's committed config (`.unstale/config.json`), as a teammate left it.
pub(crate) struct RepoConfig {
    pub(crate) id: &'static str,
    pub(crate) title: &'static str,
    /// The `--inference` value the config records.
    pub(crate) choice: Option<&'static str>,
}

#[rustfmt::skip]
pub(crate) const REPO_CONFIGS: &[RepoConfig] = &[
    RepoConfig { id: "no-config", title: "", choice: None },
    RepoConfig { id: "config-set", title: "the repo config names OpenAI", choice: Some("env:OPENAI_API_KEY") },
    RepoConfig { id: "config-missing", title: "the repo config names a key that is not here", choice: Some("env:OPENROUTER_API_KEY") },
];

pub(crate) struct Client {
    pub(crate) id: &'static str,
    pub(crate) title: &'static str,
}

/// The upgrade rows (during grace, after the `min_client` bump) are placeholders below until they can run.
#[rustfmt::skip]
pub(crate) const CLIENTS: &[Client] = &[
    Client { id: "fresh", title: "" },
];

/// How the mock provider (or the fake `codex`) answers a model call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Answer {
    Ok,
    /// 401: the key was refused.
    Refused,
    /// 429 on every try.
    RateLimited,
    /// 503 on every try.
    Down,
    /// Slower than the call's timeout.
    Slow,
    /// The model is not on this key or plan (404, or Codex's "not supported").
    NotOnPlan,
    /// This month's token budget is already spent.
    BudgetSpent,
}

impl Answer {
    pub(crate) fn id(self) -> &'static str {
        match self {
            Answer::Ok => "",
            Answer::Refused => "refused",
            Answer::RateLimited => "rate-limited",
            Answer::Down => "provider-down",
            Answer::Slow => "provider-slow",
            Answer::NotOnPlan => "model-not-on-plan",
            Answer::BudgetSpent => "budget-spent",
        }
    }
    pub(crate) fn failing(self) -> bool {
        self != Answer::Ok
    }
}

/// The critical paths, each run in full: (title, keys, Codex, invocation, repo config, how the provider answers).
#[rustfmt::skip]
pub(crate) const CRITICAL: &[(&str, &str, &str, &str, &str, Answer)] = &[
    ("Codex only, first run in a terminal", "no-key", "codex", "terminal", "no-config", Answer::Ok),
    ("An OpenAI key in the shell, first run in a terminal", "shell-key", "no-codex", "terminal", "no-config", Answer::Ok),
    ("An OpenAI key only in this repo's .env, first run in a terminal", "dotenv-key", "no-codex", "terminal", "no-config", Answer::Ok),
    ("Several keys and Codex, first run in a terminal", "several-keys", "codex", "terminal", "no-config", Answer::Ok),
    ("Nothing to use, first run in a terminal", "no-key", "no-codex", "terminal", "no-config", Answer::Ok),
    ("Only another repo has a key, first run in a terminal", "other-repo-key", "no-codex", "terminal", "no-config", Answer::Ok),
    ("Codex logged out, first run in a terminal", "no-key", "codex-logged-out", "terminal", "no-config", Answer::Ok),
    ("A revoked key, first run in a terminal", "revoked-key", "no-codex", "terminal", "no-config", Answer::Ok),
    ("A teammate's choice is already in the repo, first run in a terminal", "shell-key", "codex", "terminal", "config-set", Answer::Ok),
    ("The repo names a key this machine does not have, first run in a terminal", "shell-key", "no-codex", "terminal", "config-missing", Answer::Ok),
    ("An agent installs it with several keys and Codex", "several-keys", "codex", "agent", "no-config", Answer::Ok),
    ("An agent installs it with nothing to use", "no-key", "no-codex", "agent", "no-config", Answer::Ok),
    ("CI with the provider in the repo config", "shell-key", "no-codex", "ci", "config-set", Answer::Ok),
    ("CI with no provider chosen", "shell-key", "no-codex", "ci", "no-config", Answer::Ok),
    ("CI chooses the provider with a flag", "shell-key", "no-codex", "ci-flag", "no-config", Answer::Ok),
    ("The provider rate limits every call", "shell-key", "no-codex", "terminal", "no-config", Answer::RateLimited),
    ("The provider is down", "shell-key", "no-codex", "terminal", "no-config", Answer::Down),
    ("The provider is too slow to answer", "shell-key", "no-codex", "terminal", "no-config", Answer::Slow),
    ("The model is not on the Codex plan", "no-key", "codex", "terminal", "no-config", Answer::NotOnPlan),
    ("This month's token budget is spent", "shell-key", "no-codex", "terminal", "no-config", Answer::BudgetSpent),
];

/// One command of a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Step {
    /// `unstale init`: at a terminal the person presses Enter at the question, if one is asked.
    Init,
    /// `unstale init --yes`, as CI runs it.
    InitYes,
    /// `unstale init --yes --inference <value>`: CI choosing the provider without a question.
    InitFlag(&'static str),
    Sync,
    Status,
    /// The agent runs `unstale setup`, relays the options, and records the user's answer (the first option) with
    /// `unstale setup --inference <value>`. Only when status says no provider is chosen.
    AgentSetup,
    /// A model call on the chosen provider. Until the client's own pipeline steps call the provider, this is the
    /// internal `unstale infer` with public release-note text, on the provider the session chose.
    Model,
}

// ------------------------------------------------------------------------------------------------------ scenarios

pub(crate) struct Scenario {
    pub(crate) title: String,
    pub(crate) slug: String,
    pub(crate) keys: &'static Keys,
    pub(crate) codex: &'static Codex,
    pub(crate) invocation: &'static Invocation,
    pub(crate) config: &'static RepoConfig,
    pub(crate) client: &'static Client,
    pub(crate) answer: Answer,
    pub(crate) critical: bool,
    /// Test-only: a deliberate violation, to show the checks catch it.
    pub(crate) fault: Option<Fault>,
}

pub(crate) fn by_id<T>(table: &'static [T], id: &str, of: impl Fn(&T) -> &str) -> &'static T {
    table
        .iter()
        .find(|t| of(t) == id)
        .unwrap_or_else(|| panic!("no dimension value {id}"))
}

impl Scenario {
    pub(crate) fn new(
        keys: &'static Keys,
        codex: &'static Codex,
        invocation: &'static Invocation,
        config: &'static RepoConfig,
        client: &'static Client,
        answer: Answer,
    ) -> Scenario {
        let answer = if answer == Answer::Ok {
            keys.answer
        } else {
            answer
        };
        let slug = [
            invocation.id,
            keys.id,
            codex.id,
            config.id,
            client.id,
            answer.id(),
        ]
        .into_iter()
        .filter(|s| !s.is_empty() && *s != "fresh")
        .collect::<Vec<_>>()
        .join("-");
        Scenario {
            title: generated_title(keys, codex, invocation, config, client),
            slug,
            keys,
            codex,
            invocation,
            config,
            client,
            answer,
            critical: false,
            fault: None,
        }
    }

    pub(crate) fn dims(&self) -> String {
        let c = match self.config.choice {
            None => "none".to_string(),
            Some(v) => format!("--inference {v}"),
        };
        format!(
            "keys: {} · Codex: {} · run: {} · repo config: {c} · client: {} · provider: {}",
            self.keys.id,
            self.codex.id,
            self.invocation.id,
            self.client.id,
            match self.answer {
                Answer::Ok => "answers".to_string(),
                a => a.id().replace('-', " "),
            }
        )
    }
}

pub(crate) fn generated_title(
    keys: &Keys,
    codex: &Codex,
    inv: &Invocation,
    config: &RepoConfig,
    client: &Client,
) -> String {
    let what = match (keys.id, codex.installed) {
        ("no-key", false) => "Nothing to use".to_string(),
        ("no-key", true) if codex.logged_in => "Codex only".to_string(),
        ("no-key", true) => format!("Only {}", codex.title.replacen("Codex", "Codex,", 1)),
        (_, false) => capitalised(keys.title),
        (_, true) => format!("{} and {}", capitalised(keys.title), codex.title),
    };
    let mut t = format!("{what}, {}", inv.title);
    for extra in [config.title, client.title] {
        if !extra.is_empty() {
            t += &format!("; {extra}");
        }
    }
    t
}

pub(crate) fn capitalised(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}

/// Every pair of values of any two dimensions in at least one scenario: a deterministic greedy cover (each new row
/// takes, dimension by dimension, the value that covers the most pairs not yet covered).
pub(crate) fn all_pairs(sizes: &[usize]) -> Vec<Vec<usize>> {
    let mut uncovered: BTreeSet<(usize, usize, usize, usize)> = BTreeSet::new();
    for a in 0..sizes.len() {
        for b in a + 1..sizes.len() {
            for x in 0..sizes[a] {
                for y in 0..sizes[b] {
                    uncovered.insert((a, x, b, y));
                }
            }
        }
    }
    let mut rows = vec![];
    while let Some(&(a, x, b, y)) = uncovered.iter().next() {
        let mut row: Vec<Option<usize>> = vec![None; sizes.len()];
        row[a] = Some(x);
        row[b] = Some(y);
        for d in 0..sizes.len() {
            if row[d].is_some() {
                continue;
            }
            let gain = |v: usize| {
                (0..sizes.len())
                    .filter_map(|e| row[e].map(|w| (e, w)))
                    .filter(|&(e, w)| {
                        let key = if e < d { (e, w, d, v) } else { (d, v, e, w) };
                        uncovered.contains(&key)
                    })
                    .count()
            };
            let best = (0..sizes[d])
                .max_by_key(|&v| (gain(v), std::cmp::Reverse(v)))
                .unwrap();
            row[d] = Some(best);
        }
        let row: Vec<usize> = row.into_iter().map(Option::unwrap).collect();
        for a in 0..sizes.len() {
            for b in a + 1..sizes.len() {
                uncovered.remove(&(a, row[a], b, row[b]));
            }
        }
        rows.push(row);
    }
    rows
}

/// The critical paths in full, then the pairs not already among them.
pub(crate) fn scenarios() -> Vec<Scenario> {
    let mut out: Vec<Scenario> = vec![];
    for &(title, k, c, i, r, answer) in CRITICAL {
        let mut s = Scenario::new(
            by_id(KEYS, k, |v| v.id),
            by_id(CODEX, c, |v| v.id),
            by_id(INVOCATIONS, i, |v| v.id),
            by_id(REPO_CONFIGS, r, |v| v.id),
            &CLIENTS[0],
            answer,
        );
        s.title = title.to_string();
        s.critical = true;
        out.push(s);
    }
    let sizes = [
        KEYS.len(),
        CODEX.len(),
        INVOCATIONS.len(),
        REPO_CONFIGS.len(),
        CLIENTS.len(),
    ];
    for row in all_pairs(&sizes) {
        let s = Scenario::new(
            &KEYS[row[0]],
            &CODEX[row[1]],
            &INVOCATIONS[row[2]],
            &REPO_CONFIGS[row[3]],
            &CLIENTS[row[4]],
            Answer::Ok,
        );
        if !out.iter().any(|o| o.slug == s.slug) {
            out.push(s);
        }
    }
    let mut seen = BTreeSet::new();
    for s in &out {
        assert!(
            seen.insert(s.title.clone()),
            "two scenarios are titled {:?}",
            s.title
        );
    }
    out
}

#[test]
fn the_pairs_cover_every_two_dimension_values_and_the_critical_paths_are_all_present() {
    let list = scenarios();
    let dims = |s: &Scenario| {
        [
            s.keys.id,
            s.codex.id,
            s.invocation.id,
            s.config.id,
            s.client.id,
        ]
    };
    let all: Vec<Vec<&str>> = vec![
        KEYS.iter().map(|v| v.id).collect(),
        CODEX.iter().map(|v| v.id).collect(),
        INVOCATIONS.iter().map(|v| v.id).collect(),
        REPO_CONFIGS.iter().map(|v| v.id).collect(),
        CLIENTS.iter().map(|v| v.id).collect(),
    ];
    for a in 0..all.len() {
        for b in a + 1..all.len() {
            for x in &all[a] {
                for y in &all[b] {
                    assert!(
                        list.iter().any(|s| dims(s)[a] == *x && dims(s)[b] == *y),
                        "no scenario has {x} with {y}"
                    );
                }
            }
        }
    }
    assert_eq!(list.iter().filter(|s| s.critical).count(), CRITICAL.len());
}
