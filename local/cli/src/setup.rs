//! Choosing where the model steps run: the user's own key or their Codex plan, with at most one question.
//!
//! Detection reads names only: the names of environment variables in the shell and in this repository's `.env`,
//! whether `codex` is on PATH and what `codex login status` says, and this repository's config. It never reads a value
//! before the user chooses, never another repository's `.env` and never another tool's files (Codex's auth file and
//! the like). The choice stores the variable's name; the key itself stays in each person's environment.
//!
//! Everything here is inert with the edge-inference switch off ([`crate::inference::enabled`]).
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::Path;

// ----------------------------------------------------------------------------------------------------- detection

/// Which route a key variable opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Route {
    /// Vercel AI Gateway, OpenAI-compatible, on its flex tier.
    Vercel,
    /// OpenAI's API.
    OpenAi,
    /// OpenRouter, OpenAI-compatible.
    OpenRouter,
    /// Anthropic's API.
    Anthropic,
    /// Jev, the labelling API; it labels and matches records but cannot write them, so it pairs with another route.
    Jev,
    /// SubQ Snap, a decision model; it matches records only, so it pairs with an OpenAI-compatible route.
    Subq,
}

/// The key variables looked for, by the route they open. OpenAI-compatible routes are listed cheapest first: when
/// several are set, the picker offers the first.
pub const KEY_VARS: &[(&str, Route)] = &[
    ("AI_GATEWAY_API_KEY", Route::Vercel),
    ("OPENAI_API_KEY", Route::OpenAi),
    ("OPENROUTER_API_KEY", Route::OpenRouter),
    ("ANTHROPIC_API_KEY", Route::Anthropic),
    ("JEV_API_KEY", Route::Jev),
    ("SUBQ_API_KEY", Route::Subq),
];

pub fn route_of(var: &str) -> Option<Route> {
    KEY_VARS.iter().find(|(n, _)| *n == var).map(|(_, r)| *r)
}

/// Where a key variable's name was seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seen {
    Shell,
    /// Only in this repository's `.env`.
    DotEnv,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexState {
    /// No `codex` on PATH.
    Absent,
    /// Installed but not usable: what is wrong and what to do, as two sentences (`Codex is not logged in. Run `codex
    /// login`.`).
    NotReady(String),
    Ready,
}

/// What this machine can use, by name only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    /// Known key variables that are set, by name.
    pub keys: BTreeMap<String, Seen>,
    pub codex: CodexState,
}

impl Detected {
    pub fn has(&self, r: Route) -> bool {
        self.var(r).is_some()
    }
    /// The first variable of a route that is set.
    pub fn var(&self, r: Route) -> Option<&'static str> {
        KEY_VARS
            .iter()
            .find(|(n, rr)| *rr == r && self.keys.contains_key(*n))
            .map(|(n, _)| *n)
    }
    /// The cheapest OpenAI-compatible route with a key.
    pub fn compatible(&self) -> Option<Route> {
        [Route::Vercel, Route::OpenAi, Route::OpenRouter]
            .into_iter()
            .find(|r| self.has(*r))
    }
}

/// The variables that say an agent is running the command (Claude Code, Codex, Cursor's agent, opencode, Gemini CLI,
/// and any harness that sets `AI_AGENT`); `UNSTALE_AGENT=1` says so explicitly. With one set, setup never asks: a
/// pseudo-terminal an agent drives is not a person, and a stray Enter would accept a paid option.
pub const AGENT_VARS: &[&str] = &[
    "CLAUDECODE",
    "AI_AGENT",
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "CURSOR_AGENT",
    "OPENCODE",
    "GEMINI_CLI",
    "UNSTALE_AGENT",
];

/// Everything detection may look at. The real one is [`System`]; tests record what is touched.
pub trait Probe {
    /// Whether a variable is set in this process's environment to something other than blanks. The value is looked at
    /// for that and dropped.
    fn set_in_shell(&self, name: &str) -> bool;
    /// The known key variables this repository's `.env` (`<root>/.env`, not followed through a link) sets to a
    /// non-blank value. The only file detection opens.
    fn repo_dotenv(&self, root: &Path) -> Vec<String>;
    /// Whether `codex` is on PATH, and if so whether it is usable (`codex --version`, `codex login status`).
    fn codex(&self) -> CodexState;
}

pub struct System;

impl Probe for System {
    fn set_in_shell(&self, name: &str) -> bool {
        std::env::var_os(name).is_some_and(|v| !v.to_string_lossy().trim().is_empty())
    }
    fn repo_dotenv(&self, root: &Path) -> Vec<String> {
        let p = root.join(".env");
        // A link could lead to another repository's file: only a regular file inside this one is read.
        if !std::fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_file()) {
            return vec![];
        }
        std::fs::File::open(p).map(dotenv_names).unwrap_or_default()
    }
    fn codex(&self) -> CodexState {
        if !codex_on_path() {
            return CodexState::Absent;
        }
        let inf = crate::inference::Inference::new(crate::inference::ProviderConfig::codex());
        match inf.codex_status() {
            Ok(()) => CodexState::Ready,
            Err(crate::inference::Deferred::CodexMissing) => CodexState::Absent,
            Err(d) => CodexState::NotReady(format!("{}. {}", d.what(), d.fix())),
        }
    }
}

/// Whether a `codex` executable is on PATH (nothing is run).
pub fn codex_on_path() -> bool {
    std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .any(|d| d.join("codex").is_file() || d.join("codex.exe").is_file())
        })
        .unwrap_or(false)
}

/// Whether an agent is running this command ([`AGENT_VARS`]).
pub fn agent_driving(probe: &dyn Probe) -> bool {
    AGENT_VARS.iter().any(|v| probe.set_in_shell(v))
}

/// The known key variables a `.env` sets to a non-blank value (`NAME=…` or `export NAME=…`; the last assignment of a
/// name wins). Read a byte at a time: a name is kept, and of its value only whether it has a character other than
/// blanks and quotes before a comment. No value byte is stored.
pub fn dotenv_names(r: impl std::io::Read) -> Vec<String> {
    use std::io::Read as _;
    #[derive(PartialEq)]
    enum At {
        Name,
        AfterName,
        Value,
        Skip,
    }
    let mut set: Vec<(String, bool)> = vec![];
    let mut note = |name: &str, filled: bool| {
        if route_of(name).is_none() {
            return;
        }
        match set.iter_mut().find(|(n, _)| n == name) {
            Some(e) => e.1 = filled,
            None => set.push((name.to_string(), filled)),
        }
    };
    let (mut at, mut name, mut filled) = (At::Name, String::new(), false);
    // The quote a value is inside, if any: a `#` there is part of the value, not a comment.
    let mut quote: Option<u8> = None;
    for b in std::io::BufReader::new(r).bytes() {
        let Ok(b) = b else { break };
        if b == b'\n' {
            if at == At::Value {
                note(&name, filled);
            }
            (at, filled, quote) = (At::Name, false, None);
            name.clear();
            continue;
        }
        match at {
            At::Name if b.is_ascii_alphanumeric() || b == b'_' => {
                if name.len() < 64 {
                    name.push(b as char);
                } else {
                    at = At::Skip;
                }
            }
            At::Name if b == b' ' || b == b'\t' => {
                if name == "export" {
                    name.clear();
                } else if !name.is_empty() {
                    at = At::AfterName;
                }
            }
            At::Name | At::AfterName if b == b'=' && !name.is_empty() => at = At::Value,
            At::AfterName if b == b' ' || b == b'\t' => {}
            At::Name | At::AfterName => at = At::Skip,
            // A comment where the value would start: a blank assignment, which still clears an earlier one.
            At::Value if b == b'#' && !filled && quote.is_none() => {
                note(&name, false);
                at = At::Skip;
            }
            At::Value if b == b'"' || b == b'\'' => match quote {
                Some(q) if q == b => quote = None,
                None => quote = Some(b),
                Some(_) => filled = true,
            },
            At::Value => filled |= !b.is_ascii_whitespace(),
            At::Skip => {}
        }
    }
    if at == At::Value {
        note(&name, filled);
    }
    set.into_iter()
        .filter(|(_, f)| *f)
        .map(|(n, _)| n)
        .collect()
}

/// What this machine can use: key variables set (to a non-blank value) in the shell and in this repository's `.env`,
/// and Codex.
pub fn detect(root: &Path, probe: &dyn Probe) -> Detected {
    let mut keys = BTreeMap::new();
    for (n, _) in KEY_VARS {
        if probe.set_in_shell(n) {
            keys.insert(n.to_string(), Seen::Shell);
        }
    }
    for n in probe.repo_dotenv(root) {
        keys.entry(n).or_insert(Seen::DotEnv);
    }
    Detected {
        keys,
        codex: probe.codex(),
    }
}

// -------------------------------------------------------------------------------------------------------- picker

/// Whether "no key" mode is offered: the raw release notes for the user's agent to read, beside what needs no model.
/// Off until its evaluation shows the agent does better with it than without.
pub const NO_KEY_MODE: bool = false;

/// What a user still gets with no provider, as a share (percent) of a full report's real findings: the sections built
/// with no model at all (publisher deprecations, unmaintained packages, lockfile advisories) hold 42 of 154 real
/// findings on the evaluation pool, 27% (28% of the ones to act on now). Source: `eval/no-key/PREREGISTRATION.md` on
/// branch `ws9/no-key-mode`. `None` prints the trade in words, with no figure.
pub const NO_PROVIDER_SHARE: Option<u32> = Some(27);

/// One option of the picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pick {
    /// Jev labels and matches; an OpenAI-compatible key writes the records.
    JevKey(Route),
    /// Jev labels and matches; Codex writes the records.
    JevCodex,
    /// SubQ Snap matches; an OpenAI-compatible key writes and labels the records.
    SnapKey(Route),
    /// One key does every step (an OpenAI-compatible route, or Anthropic).
    Key(Route),
    /// Codex does every step.
    Codex,
    /// No model provider: deterministic signals only, or no-key mode when [`NO_KEY_MODE`] is on.
    None,
}

/// How an option's results compare with the best option's.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Quality {
    Best,
    /// The same model on every step that decides quality.
    Same,
    /// A share of the best option's results, in percent; what is counted (`its …`); and a qualifier only the full
    /// figures carry.
    Share {
        pct: u32,
        of: &'static str,
        detail: &'static str,
    },
    /// About as many of the best option's finds (`found`), with more of its flags wrong: `wrong` in 100 against
    /// `best_wrong` in 100 for the best option. The flags are named in full (`of`) and as the table's row has room
    /// for (`of_short`); `detail` is what only the full figures carry, a line each.
    MoreWrong {
        wrong: u32,
        best_wrong: u32,
        found: &'static str,
        of: &'static str,
        of_short: &'static str,
        detail: &'static [&'static str],
    },
    /// Not measured yet.
    Unmeasured,
}

/// What an option costs and gives, per mean technology-year (114.6 records from 17.5 release-note chunks). Estimates
/// from the evaluations until the client's own first sync is measured; every figure the picker quotes is here.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Quote {
    /// Dollars billed to the user's keys.
    pub usd: f64,
    /// Codex plan tokens, and what they would cost at API prices.
    pub codex_tokens: u64,
    pub codex_usd: f64,
    /// Tokens more for the user's agent to read (no-key mode).
    pub agent_tokens: u64,
    pub quality: Quality,
    /// More duplicate records than the best option's.
    pub more_duplicates: u32,
    /// Whether labels and matching were measured on the route this option runs them on. `quality` always is. While
    /// false (Codex alone), the line says the rest is not measured yet and no figure for it is shown;
    /// `more_duplicates` is then the API route's, kept for when it is.
    pub labels_and_matching_measured: bool,
}

/// The first sync, in technology-years per technology. Catalog records cover history, so the first sync reads only
/// what they do not; one year each is the ceiling the monthly budget assumes (`inference::ledger`).
pub const FIRST_SYNC_TECH_YEARS: f64 = 1.0;

const NO_QUOTE: Quote = Quote {
    usd: 0.0,
    codex_tokens: 0,
    codex_usd: 0.0,
    agent_tokens: 0,
    quality: Quality::Best,
    more_duplicates: 0,
    labels_and_matching_measured: true,
};

/// Labels without Jev, at the threshold the client reads Jev at (breaking probability 0.5): an OpenAI-compatible model
/// (gpt-6-luna read on its choices) finds 103% to 108% of the breaking changes Jev finds (both intervals include 0),
/// with more of its flags wrong. The two label sets disagree on how many, so the row gives both pooled, by count,
/// from the client's run: 31 of 270 flags wrong (26 of 42 right on short release notes, 213 of 228 on upgrade
/// guides) against Jev's 20 of 251 (24 of 32, 207 of 219); central's key-alone run pools to 30 of 268. The sets
/// apart are in the details: 38 in 100 wrong against 25 on 42 flags, 7 in 100 against 5 (12 of 219) on 228. Source:
/// `eval/edge-port/RESULTS.md`, "The ≈ 93% line" (the table at 0.5); Jev's side is version 1.13.0.
const LABELS_BELOW: Quality = Quality::MoreWrong {
    wrong: 11,
    best_wrong: 8,
    found: "breaking changes",
    of: "breaking-change flags",
    of_short: "breaking flags",
    detail: &[
        "on short release notes ≈ 62%, against 75% (42 flags)",
        "on upgrade guides ≈ 93%, against 95% (228 flags)",
    ],
};
/// Matching on the same model: about 4 more duplicate records per technology-year than Jev's (4.0 to 4.5), from the
/// re-measurement with text answers read as options; no false merge in 141 merges (`eval/edge-port/RESULTS.md`,
/// "After the fixes (addendum 1)"). It was about 6 before text answers were read.
const MATCHING_BELOW: u32 = 4;

/// Matching on SubQ Snap 1.2 (longer rules, four candidates, its own bars): about 1 more duplicate record per
/// technology-year than Jev's (3.1 against 2.5 duplicates per 100 records on the judge's held-out set, × 114.6
/// records), with 0.3 false merges per 100; gpt-6-luna leaves 4.5 per 100 on the same set. $0.0059 per technology-year
/// ($0.04 per M input, output free). Source: `eval/select/slice19/RESULTS.md`, part 2.
const SNAP_MATCHING_BELOW: u32 = 1;
const SNAP_MATCHING_USD: f64 = 0.0059;

/// Labels on an OpenAI-compatible key, four records to a call (`pipeline::labels::LABEL_BATCH`): 478 to 484 input and
/// 128 to 130 output tokens per record on the two label sets when every call is full. As records arrive in use, 57k
/// input tokens per technology-year (a whole year in one pass) to 72k (one release note a pass) and 15k output: $0.013
/// to $0.015 at list price; the quote is the middle. Source: `eval/edge-port/RESULTS.md`, "Labels, several records to
/// a call". What the labels find is [`LABELS_BELOW`], unchanged: every paired interval against one record a call
/// includes 0.
const KEY_LABELS_USD: f64 = 0.014;

/// Extraction through Codex, batched by length: 60.1% pooled recall on short release notes against 75.6% for the
/// client's direct run, which is what the best option runs (79% of it; about 90% of central's direct runs), and
/// precision level with it (77.3 against 78.8, the interval includes 0). Source: `eval/edge-port/RESULTS.md`, "After
/// the fixes (addendum 1)", Codex extraction.
const CODEX_EXTRACTION: Quality = Quality::Share {
    pct: 80,
    of: "changes",
    detail: "its changes are right as often as the best option's",
};

/// The data table. Sources, all $ per mean technology-year at list price, the upper end of each measured range (the
/// gateway's flex tier was requested on every call and billed list price):
/// - extraction: gpt-6-luna `low` $0.014 to $0.018 on every OpenAI-compatible route (`eval/edge-port/RESULTS.md`);
///   Haiku 5.5 $0.0189;
/// - labels: Jev $0.0101; gpt-6-luna read on its choices, four records to a call, $0.013 to $0.014 ([`KEY_LABELS_USD`];
///   it was $0.025 to $0.026 at one record a call); Haiku $0.0564;
/// - matching: Jev $0.0077; gpt-6-luna read on its choices $0.020 (`eval/edge-port/RESULTS.md`); Anthropic does not
///   match (never merge, $0);
/// - Codex: extraction 167k plan tokens (≈ $0.015 at API prices), measured with batching by length
///   (`eval/edge-port/RESULTS.md`, addendum 1); every step ≈ 750k ($0.057), measured on a sync of three axios
///   releases with the hint options off (163k tokens for 25 records, × 114.6; addendum 4);
/// - quality: Haiku finds 79.6% of required changes against 88.7% (upgrade guides 68.4% against 81.9%); never merge
///   leaves 22.7 duplicates per 100 records against Jev's 2.54.
pub fn quote(p: Pick, no_key: bool) -> Quote {
    let jev = 0.0101 + 0.0077;
    match p {
        Pick::JevKey(r) => Quote {
            usd: jev + extraction_usd(r),
            ..NO_QUOTE
        },
        Pick::JevCodex => Quote {
            usd: jev,
            codex_tokens: 167_000,
            codex_usd: 0.015,
            // Extraction is the only step on Codex here; labels and matching are Jev's, as in the best option.
            quality: CODEX_EXTRACTION,
            ..NO_QUOTE
        },
        Pick::SnapKey(r) => Quote {
            usd: extraction_usd(r) + KEY_LABELS_USD + SNAP_MATCHING_USD,
            quality: LABELS_BELOW,
            more_duplicates: SNAP_MATCHING_BELOW,
            ..NO_QUOTE
        },
        Pick::Key(Route::Anthropic) => Quote {
            usd: 0.0189 + 0.0564,
            quality: Quality::Share {
                pct: 90,
                of: "changes",
                detail: " (fewer from upgrade guides)",
            },
            more_duplicates: 23,
            ..NO_QUOTE
        },
        Pick::Key(r) => Quote {
            usd: extraction_usd(r) + KEY_LABELS_USD + 0.020,
            quality: LABELS_BELOW,
            more_duplicates: MATCHING_BELOW,
            ..NO_QUOTE
        },
        Pick::Codex => Quote {
            codex_tokens: 750_000,
            codex_usd: 0.057,
            quality: CODEX_EXTRACTION,
            // The API route's figure; labels and matching through `codex exec` are not measured yet.
            more_duplicates: MATCHING_BELOW,
            labels_and_matching_measured: false,
            ..NO_QUOTE
        },
        // About 8k tokens of release notes per technology-year, read raw by the agent.
        Pick::None if no_key => Quote {
            agent_tokens: 8_000,
            quality: Quality::Unmeasured,
            ..NO_QUOTE
        },
        Pick::None => NO_QUOTE,
    }
}

fn extraction_usd(r: Route) -> f64 {
    match r {
        Route::Vercel | Route::OpenAi | Route::OpenRouter => 0.018,
        Route::Anthropic => 0.0189,
        Route::Jev | Route::Subq => 0.0,
    }
}

/// The options this machine can use, best first. Empty when there is nothing to choose between.
pub fn options(d: &Detected, no_key: bool) -> Vec<Pick> {
    let mut v = vec![];
    let codex = d.codex == CodexState::Ready;
    if d.has(Route::Jev) {
        v.extend(d.compatible().map(Pick::JevKey));
        if codex {
            v.push(Pick::JevCodex);
        }
    }
    // Snap matches more duplicates than the key's own model, for less: ahead of the key alone.
    if d.has(Route::Subq) {
        v.extend(d.compatible().map(Pick::SnapKey));
    }
    v.extend(d.compatible().map(Pick::Key));
    if codex {
        v.push(Pick::Codex);
    }
    if d.has(Route::Anthropic) {
        v.push(Pick::Key(Route::Anthropic));
    }
    if !v.is_empty() || no_key {
        v.push(Pick::None);
    }
    v
}

fn route_name(r: Route) -> &'static str {
    match r {
        Route::Vercel => "Vercel AI Gateway",
        Route::OpenAi => "OpenAI",
        Route::OpenRouter => "OpenRouter",
        Route::Anthropic => "Anthropic",
        Route::Jev => "Jev labelling API",
        Route::Subq => "SubQ Snap",
    }
}

/// The value of `--inference` that picks an option.
pub fn flag_value(d: &Detected, p: Pick) -> String {
    let env = |r: Route| format!("env:{}", d.var(r).unwrap_or(""));
    match p {
        Pick::JevKey(r) => format!("jev+{}", env(r)),
        Pick::JevCodex => "jev+codex".into(),
        Pick::SnapKey(r) => format!("subq+{}", env(r)),
        Pick::Key(r) => env(r),
        Pick::Codex => "codex".into(),
        Pick::None => "none".into(),
    }
}

/// Who reads the picker: a person at a terminal (asked once, Enter accepts the first), or an agent relaying it (the
/// same options, with the command that records each).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reader {
    Person,
    Agent,
}

// -------------------------------------------------------------------------------------------------------- config

/// The stored choice: `"inference": {"provider": "...", "key_env": "..."}` in the repository's `.unstale/config.json`
/// (committed in shared mode, so a team shares it) or the user's config. It names the key's environment variable; the
/// key itself is never written anywhere.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Choice {
    /// `vercel`, `openai`, `openrouter`, `anthropic`, `codex`, or `none` (no model provider).
    pub provider: String,
    /// The variable the key is read from (key providers only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_env: Option<String>,
    /// Labels and matching on Jev, beside the provider that writes the records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Labels>,
    /// Matching only on SubQ Snap (`subq`), beside the provider that writes and labels the records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matching: Option<Labels>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Labels {
    /// `jev` (for `matching`, `subq`).
    pub provider: String,
    pub key_env: String,
}

fn provider_id(r: Route) -> &'static str {
    match r {
        Route::Vercel => "vercel",
        Route::OpenAi => "openai",
        Route::OpenRouter => "openrouter",
        Route::Anthropic => "anthropic",
        Route::Jev => "jev",
        Route::Subq => "subq",
    }
}

fn route_by_id(id: &str) -> Option<Route> {
    [
        Route::Vercel,
        Route::OpenAi,
        Route::OpenRouter,
        Route::Anthropic,
        Route::Jev,
        Route::Subq,
    ]
    .into_iter()
    .find(|r| provider_id(*r) == id)
}

/// The default key variable of a route.
fn default_var(r: Route) -> &'static str {
    KEY_VARS
        .iter()
        .find(|(_, rr)| *rr == r)
        .map(|(n, _)| *n)
        .unwrap_or("")
}

impl Choice {
    pub fn none() -> Choice {
        Choice {
            provider: "none".into(),
            key_env: None,
            labels: None,
            matching: None,
        }
    }

    fn key(r: Route, var: &str) -> Choice {
        Choice {
            provider: provider_id(r).into(),
            key_env: Some(var.into()),
            labels: None,
            matching: None,
        }
    }

    fn codex() -> Choice {
        Choice {
            provider: "codex".into(),
            key_env: None,
            labels: None,
            matching: None,
        }
    }

    fn with_snap(mut self, var: &str) -> Choice {
        self.matching = Some(Labels {
            provider: "subq".into(),
            key_env: var.into(),
        });
        self
    }

    fn with_jev(mut self, var: &str) -> Choice {
        self.labels = Some(Labels {
            provider: "jev".into(),
            key_env: var.into(),
        });
        self
    }

    /// The choice an option stands for, with the variable names this machine has.
    pub fn of(d: &Detected, p: Pick) -> Choice {
        let var = |r: Route| d.var(r).unwrap_or(default_var(r)).to_string();
        match p {
            Pick::JevKey(r) => Choice::key(r, &var(r)).with_jev(&var(Route::Jev)),
            Pick::JevCodex => Choice::codex().with_jev(&var(Route::Jev)),
            Pick::SnapKey(r) => Choice::key(r, &var(r)).with_snap(&var(Route::Subq)),
            Pick::Key(r) => Choice::key(r, &var(r)),
            Pick::Codex => Choice::codex(),
            Pick::None => Choice::none(),
        }
    }

    pub fn is_none(&self) -> bool {
        self.provider == "none"
    }

    /// The provider configurations to call: the one that writes records, Jev for labels and matching when chosen, and
    /// Snap for matching when chosen. `None` for no model provider, and for a choice naming a key variable that is not
    /// its route's own ([`Choice::foreign_key`]): a repository's config must not be able to send another variable (a
    /// token, a proxy setting) anywhere.
    pub fn providers(
        &self,
    ) -> Option<(
        ProviderConfig,
        Option<ProviderConfig>,
        Option<ProviderConfig>,
    )> {
        if self.foreign_key().is_some() {
            return None;
        }
        let mut main = match self.provider.as_str() {
            "openai" => ProviderConfig::openai(),
            "vercel" => ProviderConfig::vercel(),
            "openrouter" => ProviderConfig::openrouter(),
            "anthropic" => ProviderConfig::anthropic(),
            "codex" => ProviderConfig::codex(),
            _ => return None,
        };
        if main.key_env.is_some()
            && let Some(k) = &self.key_env
        {
            main.key_env = Some(k.clone());
        }
        let labels = self
            .labels
            .as_ref()
            .filter(|l| l.provider == "jev")
            .map(|l| {
                let mut j = ProviderConfig::jev();
                j.key_env = Some(l.key_env.clone());
                j
            });
        let matching = self
            .matching
            .as_ref()
            .filter(|m| m.provider == "subq")
            .map(|m| {
                let mut s = ProviderConfig::subq();
                s.key_env = Some(m.key_env.clone());
                s
            });
        Some((main, labels, matching))
    }

    /// A key variable the choice names that is not the known key variable of its route (`KEY_VARS`), if any.
    pub fn foreign_key(&self) -> Option<&str> {
        let own = |provider: &str, var: &str| {
            route_by_id(provider).is_some_and(|r| route_of(var) == Some(r))
        };
        if let Some(k) = &self.key_env
            && !own(&self.provider, k)
        {
            return Some(k);
        }
        self.labels
            .as_ref()
            .map(|l| l.key_env.as_str())
            .filter(|k| !own("jev", k))
            .or_else(|| {
                self.matching
                    .as_ref()
                    .map(|m| m.key_env.as_str())
                    .filter(|k| !own("subq", k))
            })
    }

    /// The variables this choice reads keys from: only its routes' own key variables.
    pub fn key_vars(&self) -> Vec<&str> {
        if self.foreign_key().is_some() {
            return vec![];
        }
        self.labels
            .iter()
            .chain(self.matching.iter())
            .map(|l| l.key_env.as_str())
            .chain(self.key_env.as_deref())
            .collect()
    }

    /// What the choice uses, for status and confirmation lines: `Jev labelling API + OpenAI (JEV_API_KEY,
    /// OPENAI_API_KEY)`.
    pub fn describe(&self) -> String {
        let main = match self.provider.as_str() {
            "codex" => "Codex plan".to_string(),
            "none" => return "none".into(),
            p => route_by_id(p).map(route_name).unwrap_or(p).to_string(),
        };
        let name = match (&self.labels, &self.matching) {
            (Some(_), _) => format!("{} + {main}", route_name(Route::Jev)),
            (None, Some(_)) => format!("{} + {main}", route_name(Route::Subq)),
            (None, None) => main,
        };
        let vars = self.key_vars();
        if vars.is_empty() {
            name
        } else {
            format!("{name} ({})", vars.join(", "))
        }
    }
}

use crate::inference::ProviderConfig;

/// Where a choice was read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Repo,
    User,
}

/// The user's config: `$UNSTALE_CONFIG_DIR/config.json`, else `$XDG_CONFIG_HOME/unstale/config.json`, else
/// `~/.config/unstale/config.json`. A variable that is unset, empty or not an absolute path names nothing. With none
/// of them there is no user config: the path is empty, so nothing is read (nothing chosen, nothing approved) and a
/// write is refused ([`write_user_key`]). It is never a path relative to the working directory, which a repository's
/// files could stand in for.
pub fn user_config_path() -> std::path::PathBuf {
    user_config_path_from(|k| std::env::var_os(k))
}

fn user_config_path_from(
    env: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> std::path::PathBuf {
    let dir = |k: &str| {
        env(k)
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_absolute())
    };
    dir("UNSTALE_CONFIG_DIR")
        .or_else(|| dir("XDG_CONFIG_HOME").map(|d| d.join("unstale")))
        .or_else(|| dir("HOME").map(|h| h.join(".config/unstale")))
        .map(|d| d.join("config.json"))
        .unwrap_or_default()
}

fn user_doc(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub fn read_user(path: &Path) -> Option<Choice> {
    user_doc(path)
        .get("inference")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// Writes the choice into the user's config, keeping anything else there.
pub fn write_user(path: &Path, c: &Choice) -> anyhow::Result<()> {
    write_user_key(path, "inference", Some(serde_json::to_value(c)?))
}

/// Sets (or with `None` removes) one key of the user's config, keeping anything else there.
fn write_user_key(path: &Path, key: &str, value: Option<serde_json::Value>) -> anyhow::Result<()> {
    write_user_keys(path, vec![(key, value)])
}

/// Sets (or with `None` removes) keys of the user's config in one write, keeping anything else there.
fn write_user_keys(
    path: &Path,
    keys: Vec<(&str, Option<serde_json::Value>)>,
) -> anyhow::Result<()> {
    if path.as_os_str().is_empty() {
        anyhow::bail!(
            "there is nowhere to save this for you: HOME is not set. Set HOME or UNSTALE_CONFIG_DIR, then run it again"
        );
    }
    // A file that is there but cannot be read as a JSON object is left alone rather than replaced.
    if path.exists() {
        let ok = std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .is_some_and(|v| v.is_object());
        if !ok {
            anyhow::bail!(
                "{} is not a JSON object; fix or remove it, then run `unstale setup --user` again",
                path.display()
            );
        }
    }
    let mut doc = user_doc(path);
    for (key, value) in keys {
        match value {
            Some(v) => doc.insert(key.into(), v),
            None => doc.remove(key),
        };
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::util::write_atomic(
        path,
        format!("{}\n", serde_json::to_string_pretty(&doc)?).as_bytes(),
    )
}

/// The catalog directories this machine's user chose (`unstale init --catalog <dir>`), as canonical paths:
/// `"catalog_directories"` in the user's config.
pub fn approved_catalog_dirs(path: &Path) -> Vec<String> {
    user_doc(path)
        .get("catalog_directories")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// Adds a catalog directory to the user's approved ones, keeping anything else in their config.
pub fn approve_catalog_dir(path: &Path, dir: &str) -> anyhow::Result<()> {
    let mut dirs = approved_catalog_dirs(path);
    if dirs.iter().any(|d| d == dir) {
        return Ok(());
    }
    dirs.push(dir.to_string());
    write_user_key(path, "catalog_directories", Some(serde_json::json!(dirs)))
}

/// What is chosen for a repository, and by whom.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Stored {
    /// The choice in effect: one this machine's user made, or the repository's own "no provider" (which spends
    /// nothing, so needs nobody's consent).
    pub choice: Option<(Choice, Origin)>,
    /// A provider the repository's config names, where the user has chosen nothing: a suggestion. It is offered when
    /// the user is asked, and never used before they answer (it would spend on their key or plan unasked).
    pub suggested: Option<Choice>,
}

/// The user's answer for one repository: `"repositories": {"<root>": {"inference": …}}` in the user's config.
fn read_user_repo(path: &Path, root: &Path) -> Option<Choice> {
    let v = user_doc(path)
        .get("repositories")?
        .get(&*root.to_string_lossy())?
        .get("inference")?
        .clone();
    serde_json::from_value(v).ok()
}

/// Records (or with `None` forgets) the user's answer for one repository, keeping anything else in their config.
pub fn write_user_repo(path: &Path, root: &Path, c: Option<&Choice>) -> anyhow::Result<()> {
    write_user_repo_marked(path, root, c, None)
}

/// [`write_user_repo`], with how the answer was made when no person saw the question ([`Mark`]).
fn write_user_repo_marked(
    path: &Path,
    root: &Path,
    c: Option<&Choice>,
    mark: Option<&Mark>,
) -> anyhow::Result<()> {
    let mut repos = user_doc(path)
        .get("repositories")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let key = root.to_string_lossy().to_string();
    match c {
        Some(c) => {
            let mut entry = serde_json::json!({"inference": c});
            if let (Some(m), Some(o)) = (mark, entry.as_object_mut()) {
                m.put(o);
            }
            repos.insert(key, entry);
        }
        None if repos.remove(&key).is_none() => return Ok(()),
        None => {}
    }
    let value = (!repos.is_empty()).then_some(serde_json::Value::Object(repos));
    write_user_key(path, "repositories", value)
}

/// The choice for the repository at `root`, whose config holds `repo`. Consent to spend on the user's key or plan is
/// read from the user's own config only: their answer for this repository, else their choice for every repository,
/// "none" included. Nothing under the repository grants it, whoever wrote the file and whether or not it is committed:
/// a provider named there is a suggestion.
pub fn stored(repo: Option<&Choice>, root: &Path, user_path: &Path) -> Stored {
    if let Some(c) = read_user_repo(user_path, root).or_else(|| read_user(user_path)) {
        return Stored {
            choice: Some((c, Origin::User)),
            suggested: None,
        };
    }
    match repo {
        Some(c) if c.is_none() => Stored {
            choice: Some((c.clone(), Origin::Repo)),
            suggested: None,
        },
        _ => Stored {
            choice: None,
            suggested: repo.cloned(),
        },
    }
}

// ------------------------------------------------------------------------------------------------- who chose it

/// Who recorded a choice with `--inference`, from the environment. A person at a terminal is asked by the picker and
/// can type the flag; an agent or a script records an answer no person may have seen; CI runs a flag the pipeline's
/// author wrote into its file, which is that author's choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chooser {
    Person,
    /// One of [`AGENT_VARS`] is set, at a terminal or not.
    Agent,
    /// No agent variable, and `CI` is set (to anything but `false` or `0`), as GitHub Actions, GitLab, CircleCI,
    /// Buildkite, Travis, Azure Pipelines (through `TF_BUILD`, which it sets instead) and most others set it.
    Ci,
    /// No agent variable, no `CI`, and stdin or stdout is not a terminal: a script, a pipe, a scheduler.
    Script,
}

/// The process's environment as [`chooser`] and [`hook_context`] read it: a variable's value, `None` when unset.
pub fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// Who is recording a choice. An agent variable is read first, so an agent run inside CI is still an agent (its
/// choice is not the pipeline author's); then `CI`, before the terminal, since some CI services (Buildkite) run
/// commands in a pseudo-terminal.
pub fn chooser(env: &dyn Fn(&str) -> Option<String>, terminal: bool) -> Chooser {
    let set = |k: &str| env(k).is_some_and(|v| !v.trim().is_empty());
    if AGENT_VARS.iter().any(|v| set(v)) {
        return Chooser::Agent;
    }
    let ci = env("CI").is_some_and(|v| {
        let v = v.trim().to_ascii_lowercase();
        !v.is_empty() && v != "false" && v != "0"
    }) || set("TF_BUILD");
    match (ci, terminal) {
        (true, _) => Chooser::Ci,
        (false, true) => Chooser::Person,
        (false, false) => Chooser::Script,
    }
}

/// Whether stdin and stdout are both a terminal.
pub fn at_terminal() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// The package lifecycle events that run while packages are installed (npm, pnpm, Yarn and Bun all set
/// `npm_lifecycle_event` to the script's name). `npm run <name>` sets it too, to that name, so only these count.
const INSTALL_EVENTS: &[&str] = &[
    "preinstall",
    "install",
    "postinstall",
    "preprepare",
    "prepare",
    "postprepare",
    "prepublish",
];

/// What is running this command, when it is something that must not record a choice that spends: a package install
/// script (`npm_lifecycle_event` is one of [`INSTALL_EVENTS`]), or a Git hook (`GIT_EXEC_PATH`, which Git sets in
/// every process it starts, with one of `GIT_INDEX_FILE`, `GIT_DIR` or `GIT_PREFIX`, one of which Git 2.51 sets for
/// every hook: the commit hooks the index file, a bare repository's hooks the directory, the rest the prefix). A
/// Git alias (`!cmd`) looks the same and is refused too. Nothing an agent or CI sets on its own matches.
pub fn hook_context(env: &dyn Fn(&str) -> Option<String>) -> Option<&'static str> {
    if env("npm_lifecycle_event").is_some_and(|e| INSTALL_EVENTS.contains(&e.trim())) {
        return Some("a package install script");
    }
    let git = env("GIT_EXEC_PATH").is_some()
        && ["GIT_INDEX_FILE", "GIT_DIR", "GIT_PREFIX"]
            .iter()
            .any(|v| env(v).is_some());
    git.then_some("a Git hook")
}

/// Refuses a choice that spends when an install script or a Git hook runs the command: someone else's code would be
/// choosing to spend on the user's key or plan. "none" spends nothing and is always taken.
pub fn refuse_from_hooks(c: Option<&Choice>, env: &dyn Fn(&str) -> Option<String>) -> anyhow::Result<()> {
    match (c, hook_context(env)) {
        (Some(c), Some(what)) if !c.is_none() => anyhow::bail!(
            "not saved: a choice that spends is not taken from {what}. Run `unstale setup` yourself."
        ),
        _ => Ok(()),
    }
}

/// How a choice that spends was made when no person saw the question: `"chosen_by": "agent"` (or `"script"`) and
/// `"chosen_on": "2026-11-12"`, beside the `"inference"` they describe in the user's config (in this repository's
/// entry, or at the top for a choice for every repository). Until a person runs any unstale command at a terminal, the
/// choice is said at the top of that command and in `unstale status`, and the monthly token limit is a tenth. That run
/// removes both keys; a config without them (every one written before this) counts as seen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    /// `agent` or `script`.
    pub by: String,
    /// `YYYY-MM-DD`.
    pub on: String,
}

impl Mark {
    /// The mark for a choice recorded by `who`; `None` for a person, CI, or a choice that spends nothing.
    pub fn of(who: Chooser, c: &Choice) -> Option<Mark> {
        let by = match who {
            Chooser::Agent => "agent",
            Chooser::Script => "script",
            Chooser::Person | Chooser::Ci => return None,
        };
        (!c.is_none()).then(|| Mark {
            by: by.into(),
            on: crate::util::today(),
        })
    }

    pub fn agent(&self) -> bool {
        self.by == "agent"
    }

    fn put(&self, o: &mut serde_json::Map<String, serde_json::Value>) {
        o.insert("chosen_by".into(), self.by.clone().into());
        o.insert("chosen_on".into(), self.on.clone().into());
    }

    fn read(o: &serde_json::Map<String, serde_json::Value>) -> Option<Mark> {
        Mark::read_as(o, "chosen_by", "chosen_on")
    }

    fn read_as(o: &serde_json::Map<String, serde_json::Value>, by: &str, on: &str) -> Option<Mark> {
        let s = |k: &str| o.get(k).and_then(|v| v.as_str()).map(String::from);
        Some(Mark {
            by: s(by)?,
            on: s(on).unwrap_or_default(),
        })
    }
}

/// A limit an agent or a script raised or removed: `"monthly_token_limit_set": {"by": "agent", "on": "2026-11-12",
/// "previous": "10M"}` at the top of the user's config, beside the `"monthly_token_limit"` it describes (the limit is
/// the user's, for every repository). `previous` is the `--limit` value that restores what the user last saw
/// (`default` when they had set none). While it is there, every repository with a choice that spends is unseen.
const LIMIT_MARK: &str = "monthly_token_limit_set";

/// The limit mark ([`LIMIT_MARK`]): who, when, and the `--limit` value that restores the limit before it.
fn read_limit_mark(doc: &serde_json::Map<String, serde_json::Value>) -> Option<(Mark, String)> {
    let o = doc.get(LIMIT_MARK)?.as_object()?;
    let m = Mark::read_as(o, "by", "on")?;
    let previous = o.get("previous").and_then(|v| v.as_str()).unwrap_or("default");
    Some((m, previous.to_string()))
}

/// The `--limit` value that sets `l` again (`None`: the default), as short as reads back exactly.
fn limit_arg(l: Option<Limit>) -> String {
    match l {
        None => "default".into(),
        Some(Limit::None) => "none".into(),
        Some(Limit::Tokens(n)) => {
            let short = crate::inference::ledger::short_tokens(n);
            if parse_limit(&short) == Ok(Some(Limit::Tokens(n))) {
                short
            } else {
                n.to_string()
            }
        }
    }
}

/// A choice in effect that no person has seen yet: the choice, its mark, and whether it is the one for every
/// repository (else this repository's).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unseen {
    pub choice: Choice,
    /// Who made what no person has seen, and when: the choice's own mark, else the limit's.
    pub mark: Mark,
    /// Whether the choice itself is unseen (else only a limit raised or removed beside it).
    pub chosen: bool,
    /// When an agent or a script raised or removed the user's limit: the limit now, and the `--limit` value that
    /// restores the one before.
    pub limit: Option<(Limit, String)>,
    pub every_repo: bool,
}

/// The unseen choice in effect for the repository at `root` (with no repository, the one for every repository), read
/// from the user's config as [`stored`] reads the choice itself.
pub fn unseen(user_path: &Path, root: Option<&Path>) -> Option<Unseen> {
    let doc = user_doc(user_path);
    let entry = root.and_then(|r| {
        doc.get("repositories")?
            .get(&*r.to_string_lossy())?
            .as_object()
            .filter(|o| o.contains_key("inference"))
    });
    let (o, every_repo) = match entry {
        Some(o) => (o, false),
        None if doc.contains_key("inference") => (&doc, true),
        None => return None,
    };
    let choice: Choice = serde_json::from_value(o.get("inference")?.clone()).ok()?;
    let chosen = Mark::read(o);
    let limit_mark = read_limit_mark(&doc);
    let limit = limit_mark.as_ref().map(|(_, previous)| {
        let now = read_user_limit(user_path)
            .unwrap_or(Limit::Tokens(crate::inference::ledger::DEFAULT_MONTHLY_TOKENS));
        (now, previous.clone())
    });
    let mark = chosen.clone().or(limit_mark.map(|(m, _)| m))?;
    (!choice.is_none()).then_some(Unseen {
        choice,
        mark,
        chosen: chosen.is_some(),
        limit,
        every_repo,
    })
}

/// Removes the mark of the choice in effect at `root`: a person has now seen it.
pub fn mark_seen(user_path: &Path, root: Option<&Path>) -> anyhow::Result<()> {
    let Some(u) = unseen(user_path, root) else {
        return Ok(());
    };
    if u.limit.is_some() {
        write_user_key(user_path, LIMIT_MARK, None)?;
    }
    if !u.chosen {
        return Ok(());
    }
    if u.every_repo {
        return write_user_keys(user_path, vec![("chosen_by", None), ("chosen_on", None)]);
    }
    let root = root.unwrap_or(Path::new(""));
    write_user_repo_marked(user_path, root, Some(&u.choice), None)
}

/// At the top of any command a person runs at a terminal (switch on): an unseen choice in effect here is said once,
/// and from then on counts as seen. Nothing for an agent, CI or a script.
pub fn say_unseen(ctx: &crate::Ctx) {
    if !crate::inference::enabled() || chooser(&process_env, at_terminal()) != Chooser::Person {
        return;
    }
    let path = user_config_path();
    if let Some(u) = unseen(&path, Some(&ctx.root)) {
        println!("{}", view::unseen_line(&u, technologies(ctx), &crate::util::today()));
        let _ = mark_seen(&path, Some(&ctx.root));
    }
}

// --------------------------------------------------------------------------------------------------------- agent

/// Appended to the managed review skill with the switch on: the agent relays the picker and asks, never chooses; and
/// what to do with the one line unstale prints at session start (the line itself stays short).
pub const SKILL_SECTION: &str = "## Reading release notes\n\nunstale reads new release notes with a model, on the user's own key or Codex plan, and the user chooses which. If `unstale init` or `unstale status` says that choice is pending or that no provider is chosen, or the user asks to change it, run `unstale setup`. Show the user the options it prints, as printed, and ask which one they want. Never choose for them, not even the first option; never record a choice they have not given; never ask them to paste a key. When they answer, run the command printed for their choice.\n\n## At session start\n\nA line from unstale at session start says new upstream changes arrived for this repository: run `unstale status --wait 0` to refresh `.unstale/onboarding-report.md`, and review it only if the user asks. A line that starts with `warning:` says something the user chose is not happening: tell them what it says and the fix it names.\n";

// --------------------------------------------------------------------------------------------------- token limit

/// The monthly token limit: the user's setting, not a fixed one. `"monthly_token_limit"` in the repository's
/// `.unstale/config.json` or the user's config holds a number of tokens, or `"none"` for no limit; absent, the default
/// applies ([`crate::inference::ledger::DEFAULT_MONTHLY_TOKENS`]). Past it, model work waits for next month.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limit {
    Tokens(u64),
    None,
}

impl Limit {
    /// The limit as a count; no limit is the largest count.
    pub fn tokens(self) -> u64 {
        match self {
            Limit::Tokens(n) => n,
            Limit::None => u64::MAX,
        }
    }
}

impl serde::Serialize for Limit {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Limit::Tokens(n) => s.serialize_u64(*n),
            Limit::None => s.serialize_str("none"),
        }
    }
}

impl<'de> serde::Deserialize<'de> for Limit {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Limit, D::Error> {
        match serde_json::Value::deserialize(d)? {
            serde_json::Value::Number(n) if n.as_u64().is_some() => {
                Ok(Limit::Tokens(n.as_u64().unwrap_or(0)))
            }
            serde_json::Value::String(s) if s == "none" => Ok(Limit::None),
            other => Err(serde::de::Error::custom(format!(
                "monthly_token_limit: expected a number of tokens or \"none\", found {other}"
            ))),
        }
    }
}

/// Whose limit is the one in effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitOrigin {
    Default,
    /// The user's own, from their config.
    User,
    /// This repository's config sets a lower one than the user's (or the default).
    Repo,
    /// A tenth of the one that would apply, while the choice in effect was made by an agent (`agent`) or a script
    /// and no person has seen it ([`Mark`]).
    Unseen { agent: bool },
}

/// More than this is not a limit anyone means (a million million tokens); `none` says no limit.
pub const MAX_LIMIT: u64 = 1_000_000_000_000;

/// Reads `--limit`: a number of tokens (`48000000`, `48M`, `500k`), `none` for no limit, or `default` to go back to
/// the default (`Ok(None)`). Digits with at most one decimal point; nothing above [`MAX_LIMIT`].
pub fn parse_limit(s: &str) -> Result<Option<Limit>, String> {
    let t = s.trim().to_ascii_lowercase().replace(['_', ','], "");
    let bad = || {
        format!("--limit {s}: expected a number of tokens (48000000, 48M, 500k), none or default")
    };
    match t.as_str() {
        "none" => return Ok(Some(Limit::None)),
        "default" => return Ok(None),
        _ => {}
    }
    let (digits, scale) = match t.strip_suffix('m') {
        Some(d) => (d, 1_000_000.0),
        None => match t.strip_suffix('k') {
            Some(d) => (d, 1_000.0),
            None => (t.as_str(), 1.0),
        },
    };
    let plain = !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && digits.bytes().filter(|b| *b == b'.').count() <= 1
        && digits.bytes().any(|b| b.is_ascii_digit());
    if !plain {
        return Err(bad());
    }
    let n: f64 = digits.parse().map_err(|_| bad())?;
    let tokens = n * scale;
    if !tokens.is_finite() || tokens > MAX_LIMIT as f64 {
        return Err(format!(
            "--limit {s}: more than {} tokens; use `none` for no limit",
            crate::inference::ledger::short_tokens(MAX_LIMIT)
        ));
    }
    Ok(Some(Limit::Tokens(tokens.round() as u64)))
}

fn read_user_limit(path: &Path) -> Option<Limit> {
    user_doc(path)
        .get("monthly_token_limit")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// The limit in effect. The user's own (their config; the default when they set none) is the most this machine
/// spends: a repository's config can only lower it, never raise or remove it, since that file may be committed and
/// shared. So the lower of the two applies.
pub fn limit(repo: Option<Limit>, user_path: &Path) -> (Limit, LimitOrigin) {
    let own = match read_user_limit(user_path) {
        Some(l) => (l, LimitOrigin::User),
        None => (
            Limit::Tokens(crate::inference::ledger::DEFAULT_MONTHLY_TOKENS),
            LimitOrigin::Default,
        ),
    };
    match repo {
        Some(r) if r.tokens() < own.0.tokens() => (r, LimitOrigin::Repo),
        _ => own,
    }
}

/// What applies while the choice in effect is unseen: a tenth of the limit, or of the default when that is lower (so
/// raising or removing the limit does not lift it).
pub fn tenth(l: Limit) -> u64 {
    match l.tokens().min(crate::inference::ledger::DEFAULT_MONTHLY_TOKENS) {
        0 => 0,
        n => (n / 10).max(1),
    }
}

/// The limit in effect for the repository at `root` ([`limit`]), a tenth of it while the choice in effect there is
/// unseen ([`unseen`]).
pub fn limit_here(repo: Option<Limit>, user_path: &Path, root: Option<&Path>) -> (Limit, LimitOrigin) {
    let (l, origin) = limit(repo, user_path);
    match unseen(user_path, root) {
        Some(u) => (
            Limit::Tokens(tenth(l)),
            LimitOrigin::Unseen {
                agent: u.mark.agent(),
            },
        ),
        None => (l, origin),
    }
}

/// A stored limit that cannot be read (`"lots"`, a negative number) counts as not set, so the default applies: a
/// mistyped limit never makes a command fail, and never reads as no limit.
pub fn lenient_limit<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Limit>, D::Error> {
    use serde::Deserialize;
    Ok(serde_json::from_value(serde_json::Value::deserialize(d)?).ok())
}

/// The limit in effect for the repository at `root` ([`limit_here`]), as a count and whether it is the tenth for an
/// unseen choice (`Some(agent)`): for a caller that has only the directory, or none (then the user's own).
pub fn monthly_tokens_at(root: Option<&Path>) -> (u64, Option<bool>) {
    let repo = root.and_then(|r| {
        let b = std::fs::read(r.join(".unstale/config.json")).ok()?;
        let v: serde_json::Value = serde_json::from_slice(&b).ok()?;
        serde_json::from_value::<Limit>(v.get("monthly_token_limit")?.clone()).ok()
    });
    count(limit_here(repo, &user_config_path(), root))
}

/// The monthly token limit in effect for this repository, as [`monthly_tokens_at`]: what a model stage checks its
/// spend against.
pub fn monthly_tokens(ctx: &crate::Ctx) -> (u64, Option<bool>) {
    count(limit_here(
        ctx.config.monthly_token_limit,
        &user_config_path(),
        Some(&ctx.root),
    ))
}

fn count((l, origin): (Limit, LimitOrigin)) -> (u64, Option<bool>) {
    let unseen = match origin {
        LimitOrigin::Unseen { agent } => Some(agent),
        _ => None,
    };
    (l.tokens(), unseen)
}

/// `unstale setup --limit`: records the user's own limit, always in their config (a repository's config can only
/// lower it, by hand), and says what applies here now.
pub fn set_limit(ctx: &crate::Ctx, new: Option<Limit>) -> anyhow::Result<()> {
    let path = user_config_path();
    let raised = raises(&path, new);
    // An install script or a Git hook never raises what may be spent; lowering is always taken.
    if raised && let Some(what) = hook_context(&process_env) {
        anyhow::bail!(
            "not saved: a higher token limit is not taken from {what}. Run `unstale setup --limit` yourself."
        );
    }
    // Raised or removed by an agent or a script: marked for every repository until a person sees it. A mark already
    // there keeps the limit before it, the one the person last saw.
    let by = match chooser(&process_env, at_terminal()) {
        Chooser::Agent => Some("agent"),
        Chooser::Script => Some("script"),
        Chooser::Person | Chooser::Ci => None,
    };
    let doc = user_doc(&path);
    let mark = match (raised, by) {
        (true, Some(by)) => {
            let previous = read_limit_mark(&doc)
                .map(|(_, p)| p)
                .unwrap_or_else(|| limit_arg(read_user_limit(&path)));
            Some(serde_json::json!({"by": by, "on": crate::util::today(), "previous": previous}))
        }
        _ => doc.get(LIMIT_MARK).cloned(),
    };
    write_user_keys(
        &path,
        vec![
            ("monthly_token_limit", new.map(serde_json::to_value).transpose()?),
            (LIMIT_MARK, mark),
        ],
    )?;
    let (applies, origin) = limit(ctx.config.monthly_token_limit, &path);
    println!("{}", view::limit_saved_line(new, applies, origin));
    Ok(())
}

/// Whether `new` (`None`: back to the default) raises or removes the user's own limit.
pub fn raises(user_path: &Path, new: Option<Limit>) -> bool {
    let default = Limit::Tokens(crate::inference::ledger::DEFAULT_MONTHLY_TOKENS);
    new.unwrap_or(default).tokens() > read_user_limit(user_path).unwrap_or(default).tokens()
}

// ---------------------------------------------------------------------------------------------------------- flow

/// Reads `--inference`: a provider (`vercel`, `openai`, `openrouter`, `anthropic`), `env:NAME` for a key variable
/// unstale knows, `codex`, or `none`; `jev+` before a key or `codex` adds Jev for labels.
pub fn parse_flag(s: &str) -> Result<Choice, String> {
    let bad = || {
        format!(
            "--inference {s}: expected a provider (vercel, openai, openrouter, anthropic), env:NAME ({}), codex or none, optionally after jev+ or subq+ (for example jev+env:OPENAI_API_KEY)",
            KEY_VARS
                .iter()
                .filter(|(_, r)| !matches!(r, Route::Jev | Route::Subq))
                .map(|(n, _)| *n)
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let one = |t: &str| -> Option<Choice> {
        match t {
            "codex" => Some(Choice::codex()),
            "none" => Some(Choice::none()),
            _ => {
                let (r, var) = match t.strip_prefix("env:") {
                    Some(var) => (route_of(var)?, var),
                    None => {
                        let r = route_by_id(t)?;
                        (r, default_var(r))
                    }
                };
                Some(Choice::key(r, var))
            }
        }
    };
    let s = s.trim();
    // `subq+<key>`: Snap matches beside an OpenAI-compatible key.
    if let Some(rest) = s.strip_prefix("subq+") {
        let main = one(rest).ok_or_else(bad)?;
        return if matches!(
            route_by_id(&main.provider),
            Some(Route::Vercel | Route::OpenAi | Route::OpenRouter)
        ) {
            Ok(main.with_snap(default_var(Route::Subq)))
        } else {
            Err(bad())
        };
    }
    let (jev, rest) = match s.split_once('+') {
        Some((j, rest)) => (Some(j), rest),
        None => (None, s),
    };
    let main = one(rest).ok_or_else(bad)?;
    let main_route = route_by_id(&main.provider);
    let Some(j) = jev else {
        // Jev and Snap write no records: each needs a partner.
        return if matches!(main_route, Some(Route::Jev | Route::Subq)) {
            Err(bad())
        } else {
            Ok(main)
        };
    };
    let jev = one(j)
        .filter(|c| route_by_id(&c.provider) == Some(Route::Jev))
        .ok_or_else(bad)?;
    let pairs = main.provider == "codex"
        || matches!(
            main_route,
            Some(Route::Vercel | Route::OpenAi | Route::OpenRouter)
        );
    if !pairs {
        return Err(bad());
    }
    Ok(main.with_jev(jev.key_env.as_deref().unwrap_or(default_var(Route::Jev))))
}

/// What setup does on a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Record this choice (`--inference`); no question.
    Save(Choice),
    /// Ask the one question at the terminal.
    Ask,
    /// Print the options for an agent to relay; no question (no terminal).
    Print,
    /// Nothing to do.
    Nothing,
}

/// `reopen` is `unstale setup`; otherwise this is `init`, which asks only when nothing is chosen yet and the picker was
/// not dismissed on this machine (`settled`), and only with a person at the terminal, so it is never asked again
/// unprompted. Without a terminal, or with an agent driving, nothing waits for an answer.
pub fn plan(flag: Option<Choice>, settled: bool, terminal: bool, reopen: bool) -> Plan {
    match (flag, reopen, terminal) {
        (Some(c), _, _) => Plan::Save(c),
        (None, true, true) => Plan::Ask,
        (None, true, false) => Plan::Print,
        (None, false, true) if !settled => Plan::Ask,
        (None, false, _) => Plan::Nothing,
    }
}

/// The packages unstale follows here, for the cost quotes and `--details`: the public direct dependencies, as the user
/// counts them. Not the names looked up in the catalog, which count a scoped package twice (`@scope/name` is looked up
/// as `scope` and `name`) and a package with a coverage job twice (its name and its job's technology).
fn technologies(ctx: &crate::Ctx) -> usize {
    crate::stack::detect(&ctx.root)
        .map(|st| followed(&st))
        .unwrap_or(0)
}

fn followed(st: &crate::stack::Stack) -> usize {
    st.deps.values().filter(|d| d.public_candidate).count()
}

fn save_repo(ctx: &crate::Ctx) -> anyhow::Result<()> {
    crate::util::write_atomic(
        &ctx.tool.join("config.json"),
        format!("{}\n", serde_json::to_string_pretty(&ctx.config)?).as_bytes(),
    )
}

/// Records the choice and returns the lines that confirm it. `own_only` answers the repository's suggestion: the
/// answer is the user's, and the repository's config is left as it is.
fn save(
    ctx: &mut crate::Ctx,
    c: &Choice,
    user: bool,
    own_only: bool,
    mark: Option<&Mark>,
) -> anyhow::Result<Vec<String>> {
    if user {
        let mut keys = vec![("inference", Some(serde_json::to_value(c)?))];
        let mut o = serde_json::Map::new();
        if let Some(m) = mark {
            m.put(&mut o);
        }
        keys.push(("chosen_by", o.remove("chosen_by")));
        keys.push(("chosen_on", o.remove("chosen_on")));
        write_user_keys(&user_config_path(), keys)?;
        // A choice the user made for this repository still applies here.
        let here = stored(ctx.config.inference.as_ref(), &ctx.root, &user_config_path());
        let kept = here.choice.filter(|(k, _)| k != c).map(|(k, _)| k);
        return Ok(view::saved_lines(c, Origin::User, kept.as_ref()));
    }
    // The user's own answer for this repository, kept where no repository can write: it alone lets anything be spent.
    write_user_repo_marked(&user_config_path(), &ctx.root, Some(c), mark)?;
    // In shared mode the repository's config also carries it, as the team's suggestion to whoever clones it; not
    // when this answers such a suggestion (the committed file stays as it was).
    if !own_only && ctx.config.mode == crate::Mode::Collaborative {
        ctx.config.inference = Some(c.clone());
        save_repo(ctx)?;
    }
    Ok(view::saved_lines(c, Origin::User, None))
}

/// Where this machine remembers the picker was dismissed: under `.unstale/state/`, which is never committed.
fn dismissed_path(ctx: &crate::Ctx) -> std::path::PathBuf {
    ctx.tool.join("state/setup-dismissed")
}

/// Whether a key variable is set (by name) in the shell or this repository's `.env`.
fn key_set(ctx: &crate::Ctx) -> impl Fn(&str) -> bool {
    let dotenv = System.repo_dotenv(&ctx.root);
    move |v: &str| System.set_in_shell(v) || dotenv.iter().any(|n| n == v)
}

/// What `unstale status` shows of setup, with the switch on: warnings for a chosen key that is not set here, then the
/// provider and this month's tokens against the limit.
pub fn status_lines(ctx: &crate::Ctx) -> (Vec<String>, Vec<String>) {
    let Stored {
        choice: cur,
        suggested,
    } = stored(ctx.config.inference.as_ref(), &ctx.root, &user_config_path());
    let mut warnings = view::missing_key_lines(cur.as_ref(), &key_set(ctx));
    // A choice no person has seen, first: for every reader, until a person runs unstale at a terminal.
    if let Some(u) = unseen(&user_config_path(), Some(&ctx.root)) {
        warnings.insert(0, view::unseen_line(&u, technologies(ctx), &crate::util::today()));
    }
    let (lim, origin) = limit_here(
        ctx.config.monthly_token_limit,
        &user_config_path(),
        Some(&ctx.root),
    );
    let ledger = crate::inference::Ledger::default_location();
    let month = crate::inference::ledger::this_month();
    let used = ledger.spent(&month);
    let mut state = vec![view::provider_line(cur.as_ref(), suggested.as_ref())];
    // Only where a provider is chosen: with none, nothing spends tokens or waits on the limit.
    if cur.as_ref().is_some_and(|(c, _)| !c.is_none()) {
        match &used {
            Ok(n) if *n >= lim.tokens() => warnings.push(view::limit_reached_line(origin)),
            // Here, unlike in the one line elsewhere, there is room for which file and what to do with it.
            Err(e) => warnings.push(view::token_count_line(&ledger.path(&month), e)),
            Ok(_) => {}
        }
        state.push(view::tokens_line(used, lim, origin));
    }
    (warnings, state)
}

/// `unstale setup --details`: the full figures behind the picker. No question.
pub fn details(ctx: &crate::Ctx) {
    for l in view::details_lines(&detect(&ctx.root, &System), technologies(ctx), NO_KEY_MODE) {
        println!("{l}");
    }
}

/// When nothing is asked (no terminal, an agent, `--yes`, or already settled): what is pending or wrong, if anything.
/// An agent is told the choice is the user's and how to put it; without one, a warning that no provider is
/// configured; with a provider chosen whose key is not set here, a warning naming the variable. The warnings print
/// when the state changes, not on every run ([`crate::warn`]); `unstale status` always shows the current state.
fn unattended(
    ctx: &crate::Ctx,
    cur: Option<&(Choice, Origin)>,
    suggested: Option<&Choice>,
    dismissed: bool,
    agent: bool,
) {
    let warning = match cur {
        None if dismissed => None,
        None if agent => {
            println!("{}", view::pending_line());
            None
        }
        None if suggested.is_some() => Some(view::suggested_unchosen_line()),
        None => Some(view::unconfigured_line()),
        Some(_) => view::missing_key_lines(cur, &key_set(ctx))
            .into_iter()
            .next(),
    };
    if let Some(l) = crate::warn::changed(&ctx.tool, "setup", warning.as_deref()) {
        println!("{l}");
    }
}

/// Setup on `init` (`reopen` false) or `unstale setup` (`reopen` true), with the switch on. `user` saves to the user's
/// config instead of the repository's; `yes` (`init --yes`) asks nothing, as without a terminal.
pub fn run(
    ctx: &mut crate::Ctx,
    flag: Option<Choice>,
    reopen: bool,
    user: bool,
    yes: bool,
) -> anyhow::Result<()> {
    use std::io::IsTerminal;
    let Stored {
        choice: cur,
        suggested,
    } = stored(ctx.config.inference.as_ref(), &ctx.root, &user_config_path());
    // Answering a committed suggestion records the user's answer and leaves the team's config as it was committed.
    // With a choice of their own already made, `unstale setup` sets this repository's choice, as before.
    let own_only = suggested.is_some();
    let dismissed = dismissed_path(ctx).exists();
    let settled = cur.is_some() || dismissed;
    // `init --yes` asks nothing; accepting the recommended option would spend on the user's key unasked, so nothing is
    // chosen. An agent's pseudo-terminal is not a person: it gets the listing instead.
    let agent = agent_driving(&System);
    let terminal =
        !yes && !agent && std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    let (d, techs) = match plan(flag, settled, terminal, reopen) {
        Plan::Nothing => {
            unattended(ctx, cur.as_ref(), suggested.as_ref(), dismissed, agent);
            return Ok(());
        }
        Plan::Save(c) => {
            // Recorded with no person at the question (an agent or a script): marked until a person sees it.
            let mark = Mark::of(chooser(&process_env, at_terminal()), &c);
            for l in save(ctx, &c, user, own_only, mark.as_ref())? {
                println!("{l}");
            }
            // Recorded, but not usable here yet: said now rather than found out at the first sync.
            let chosen = (c, Origin::Repo);
            let missing = view::missing_key_lines(Some(&chosen), &key_set(ctx));
            if let Some(l) =
                crate::warn::changed(&ctx.tool, "setup", missing.first().map(String::as_str))
            {
                println!("{l}");
            }
            return Ok(());
        }
        Plan::Print => {
            let d = detect(&ctx.root, &System);
            for l in view::picker_lines(
                &d,
                technologies(ctx),
                NO_KEY_MODE,
                Reader::Agent,
                view::WIDTH,
            ) {
                println!("{l}");
            }
            let opts = options(&d, NO_KEY_MODE);
            if let Some(t) = &suggested {
                let at = opts.iter().position(|p| Choice::of(&d, *p) == *t);
                println!(
                    "{}",
                    view::suggested_line(t, at, !opts.is_empty(), Reader::Agent)
                );
            }
            return Ok(());
        }
        Plan::Ask => (detect(&ctx.root, &System), technologies(ctx)),
    };
    let opts = options(&d, NO_KEY_MODE);
    let width = view::width();
    // The team's suggestion, where this machine can use it: marked first and tagged.
    let at = suggested
        .as_ref()
        .and_then(|t| opts.iter().position(|p| Choice::of(&d, *p) == *t));
    let mut menu = view::menu(&d, techs, NO_KEY_MODE, width, at);
    // A suggestion this machine cannot take: said under the options.
    if let Some(t) = suggested.as_ref().filter(|_| at.is_none()) {
        menu.notes.push(String::new());
        menu.notes
            .push(view::suggested_line(t, None, !opts.is_empty(), Reader::Person));
    }
    // Dismissed, or "not now" with nothing to use: no config is written, so a team's shared choice is never set by a
    // slip or by one machine's lack of a key. With a choice already made (`unstale setup` reopened), it stays, and
    // the line says so. Otherwise this machine remembers it was asked, so `init` does not ask again; `unstale setup`
    // does.
    let dismiss = |ctx: &crate::Ctx| -> anyhow::Result<()> {
        if let Some((kept, _)) = &cur {
            println!("{}", view::kept_line(kept));
            return Ok(());
        }
        crate::util::write_atomic(&dismissed_path(ctx), b"asked, not chosen\n")?;
        println!("{}", view::dismissed_line());
        Ok(())
    };
    if opts.is_empty() {
        return match select::ask(&menu, &[]) {
            view::Answered::Option(0) => {
                println!();
                for l in view::set_up_lines(&d, Reader::Person, width) {
                    println!("{l}");
                }
                println!();
                if cur.is_none() {
                    crate::util::write_atomic(&dismissed_path(ctx), b"asked, setting one up\n")?;
                }
                Ok(())
            }
            _ => dismiss(ctx),
        };
    }
    let details = view::details_lines(&d, techs, NO_KEY_MODE);
    let pick = match select::ask(&menu, &details) {
        view::Answered::Option(i) => opts[i],
        view::Answered::Nothing => return dismiss(ctx),
    };
    let c = Choice::of(&d, pick);
    for l in save(ctx, &c, user, own_only, None)? {
        println!("{l}");
    }
    let _ = crate::warn::changed(&ctx.tool, "setup", None);
    if reopen && !c.is_none() {
        let (lim, origin) = limit_here(
            ctx.config.monthly_token_limit,
            &user_config_path(),
            Some(&ctx.root),
        );
        println!(
            "{}",
            view::tokens_line(
                crate::inference::Ledger::default_location()
                    .spent(&crate::inference::ledger::this_month()),
                lim,
                origin
            )
        );
    }
    Ok(())
}

pub mod select;
pub mod view;

#[cfg(test)]
mod tests;
