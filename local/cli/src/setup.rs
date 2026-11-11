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
}

/// The key variables looked for, by the route they open. OpenAI-compatible routes are listed cheapest first: when
/// several are set, the picker offers the first.
pub const KEY_VARS: &[(&str, Route)] = &[
    ("AI_GATEWAY_API_KEY", Route::Vercel),
    ("OPENAI_API_KEY", Route::OpenAi),
    ("OPENROUTER_API_KEY", Route::OpenRouter),
    ("ANTHROPIC_API_KEY", Route::Anthropic),
    ("JEV_API_KEY", Route::Jev),
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
    /// Installed but not usable: the reason, as one line (logged out, too old).
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

/// Everything detection may look at. The real one is [`System`]; tests record what is touched.
pub trait Probe {
    /// The names of the variables in this process's environment.
    fn env_names(&self) -> Vec<String>;
    /// This repository's `.env` (`<root>/.env`, not followed through a link), or `None`. The only file detection opens.
    fn repo_dotenv(&self, root: &Path) -> Option<String>;
    /// Whether `codex` is on PATH, and if so whether it is usable (`codex --version`, `codex login status`).
    fn codex(&self) -> CodexState;
}

pub struct System;

impl Probe for System {
    fn env_names(&self) -> Vec<String> {
        // Names only: each value is dropped unread.
        std::env::vars_os()
            .filter_map(|(k, _)| k.into_string().ok())
            .collect()
    }
    fn repo_dotenv(&self, root: &Path) -> Option<String> {
        let p = root.join(".env");
        // A link could lead to another repository's file: only a regular file inside this one is read.
        if !std::fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_file()) {
            return None;
        }
        std::fs::read_to_string(p).ok()
    }
    fn codex(&self) -> CodexState {
        let on_path = std::env::var_os("PATH")
            .map(|p| {
                std::env::split_paths(&p)
                    .any(|d| d.join("codex").is_file() || d.join("codex.exe").is_file())
            })
            .unwrap_or(false);
        if !on_path {
            return CodexState::Absent;
        }
        let inf = crate::inference::Inference::new(crate::inference::ProviderConfig::codex());
        match inf.codex_status() {
            Ok(()) => CodexState::Ready,
            Err(crate::inference::Deferred::CodexMissing) => CodexState::Absent,
            Err(d) => CodexState::NotReady(d.line().trim_start_matches("deferred: ").to_string()),
        }
    }
}

/// The variable names a `.env` text defines (`NAME=…` or `export NAME=…`), known key variables only. Everything after
/// the `=` is skipped, never kept.
pub fn dotenv_names(text: &str) -> Vec<String> {
    let mut out = vec![];
    for line in text.lines() {
        let l = line.trim_start();
        let l = l.strip_prefix("export ").map(str::trim_start).unwrap_or(l);
        let Some((name, _)) = l.split_once('=') else {
            continue;
        };
        let name = name.trim_end();
        if route_of(name).is_some() && !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// What this machine can use: key variable names in the shell and in this repository's `.env`, and Codex.
pub fn detect(root: &Path, probe: &dyn Probe) -> Detected {
    let mut keys = BTreeMap::new();
    for n in probe.env_names() {
        if route_of(&n).is_some() {
            keys.insert(n, Seen::Shell);
        }
    }
    if let Some(text) = probe.repo_dotenv(root) {
        for n in dotenv_names(&text) {
            keys.entry(n).or_insert(Seen::DotEnv);
        }
    }
    Detected {
        keys,
        codex: probe.codex(),
    }
}

// -------------------------------------------------------------------------------------------------------- picker

/// Whether "no key" mode is offered: deterministic signals plus the raw change events for the user's agent to read.
/// Off until its evaluation shows the agent does better with it than without; while off, the last line says a key or
/// Codex is needed.
pub const NO_KEY_MODE: bool = false;

/// One option of the picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pick {
    /// Jev labels and matches; an OpenAI-compatible key writes the records.
    JevKey(Route),
    /// Jev labels and matches; Codex writes the records.
    JevCodex,
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
    /// A share of the best option's results, in percent, and what is counted.
    Share {
        pct: u32,
        of: &'static str,
    },
    /// Not measured yet.
    Unmeasured,
}

/// What an option costs and gives, per mean technology-year (114.6 records from 18.1 release-note chunks). Estimates
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
};

/// Labels below the best option's: an OpenAI-compatible model flags 86.2% of breaking changes against Jev's 93.1%.
const LABELS_BELOW: Quality = Quality::Share {
    pct: 93,
    of: "the best option's breaking-change flags",
};
/// Matching on the same model: 2.2 more duplicate records per technology-year.
const MATCHING_BELOW: u32 = 2;

/// The data table. Sources, all $ per mean technology-year:
/// - extraction: gpt-6-luna `low`, $0.0096 on the gateway's flex tier, $0.0183 on OpenAI, $0.0192 at list price
///   (OpenRouter, measured as the gateway row); Haiku 5.5 $0.0189;
/// - labels: Jev $0.0100; gpt-6-luna read on its choices $0.0261 list, $0.0182 billed on the gateway; Haiku $0.0564;
/// - matching: Jev $0.0081; gpt-6-luna $0.0455 list, $0.0269 flex; Anthropic does not match (never merge, $0);
/// - Codex at 8 items per call with the lean flags: extraction ≈ 109k tokens ($0.0198 at API prices), every step
///   ≈ 591k ($0.0754);
/// - quality: Haiku finds 79.6% of required changes against 88.7% (upgrade guides 68.4% against 81.9%); never merge
///   leaves 22.7 duplicates per 100 records against Jev's 2.54.
pub fn quote(p: Pick, no_key: bool) -> Quote {
    let jev = 0.0100 + 0.0081;
    match p {
        Pick::JevKey(r) => Quote {
            usd: jev + extraction_usd(r),
            ..NO_QUOTE
        },
        Pick::JevCodex => Quote {
            usd: jev,
            codex_tokens: 109_000,
            codex_usd: 0.0198,
            quality: Quality::Same,
            ..NO_QUOTE
        },
        Pick::Key(Route::Anthropic) => Quote {
            usd: 0.0189 + 0.0564,
            quality: Quality::Share {
                pct: 90,
                of: "the best option's changes (fewer from upgrade guides)",
            },
            more_duplicates: 23,
            ..NO_QUOTE
        },
        Pick::Key(r) => Quote {
            usd: extraction_usd(r)
                + match r {
                    Route::Vercel => 0.0182 + 0.0269,
                    _ => 0.0261 + 0.0455,
                },
            quality: LABELS_BELOW,
            more_duplicates: MATCHING_BELOW,
            ..NO_QUOTE
        },
        Pick::Codex => Quote {
            codex_tokens: 591_000,
            codex_usd: 0.0754,
            quality: LABELS_BELOW,
            more_duplicates: MATCHING_BELOW,
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
        Route::Vercel => 0.0096,
        Route::OpenAi => 0.0183,
        Route::OpenRouter => 0.0192,
        Route::Anthropic => 0.0189,
        Route::Jev => 0.0,
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
    }
}

/// `OpenAI (OPENAI_API_KEY)`, or `(OPENAI_API_KEY in .env)` when only this repository's `.env` names it.
fn key_name(d: &Detected, r: Route) -> String {
    let var = d.var(r).unwrap_or("");
    let at = if d.keys.get(var) == Some(&Seen::DotEnv) {
        " in .env"
    } else {
        ""
    };
    format!("{} ({var}{at})", route_name(r))
}

/// `$0.028`, `$1.05`, `$12`.
fn usd(x: f64) -> String {
    if x < 0.1 {
        format!("${x:.3}")
    } else if x < 10.0 {
        format!("${x:.2}")
    } else {
        format!("${x:.0}")
    }
}

/// Tokens to two significant figures: `110k`, `590k`, `4.2M`, `22M`.
fn tokens(n: f64) -> String {
    let n = n.max(0.0);
    let mag = if n >= 1.0 {
        10f64.powi(n.log10().floor() as i32 - 1)
    } else {
        1.0
    };
    let r = (n / mag).round() * mag;
    if r >= 1e6 {
        let m = r / 1e6;
        if m >= 10.0 {
            format!("{m:.0}M")
        } else {
            format!("{m:.1}M")
        }
    } else if r >= 1e3 {
        format!("{:.0}k", r / 1e3)
    } else {
        format!("{r:.0}")
    }
}

/// A cost: dollars, Codex tokens, agent tokens, or a sum of them.
fn cost(q: &Quote, years: f64) -> String {
    let mut parts = vec![];
    if q.usd > 0.0 {
        parts.push(usd(q.usd * years));
    }
    if q.codex_tokens > 0 {
        parts.push(format!(
            "{} Codex tokens",
            tokens(q.codex_tokens as f64 * years)
        ));
    }
    if q.agent_tokens > 0 {
        parts.push(format!(
            "{} more agent tokens",
            tokens(q.agent_tokens as f64 * years)
        ));
    }
    parts.join(" + ")
}

/// `slightly less complete: ≈ 93% of the best option's breaking-change flags`.
fn quality(q: Quality) -> Option<String> {
    match q {
        Quality::Best => None,
        Quality::Same => Some("about the same results (same model)".into()),
        Quality::Unmeasured => Some("results not measured yet".into()),
        Quality::Share { pct, of } => {
            let band = match pct {
                98.. => "about the same",
                92.. => "slightly less complete",
                80.. => "somewhat less complete",
                _ => "much less complete",
            };
            Some(format!("{band}: ≈ {pct}% of {of}"))
        }
    }
}

fn option_name(d: &Detected, p: Pick, no_key: bool) -> String {
    let jev = || key_name(d, Route::Jev);
    match p {
        Pick::JevKey(r) => format!("{} + {}", jev(), key_name(d, r)),
        Pick::JevCodex => format!("{} + Codex plan", jev()),
        Pick::Key(r) => key_name(d, r),
        Pick::Codex => "Codex plan".into(),
        Pick::None if no_key => {
            "No key: your agent reads the raw change events (unparsed, sometimes repeated)".into()
        }
        Pick::None => {
            "None: deterministic signals only; new change details need a key or Codex".into()
        }
    }
}

/// One option's line, without its number: what it uses, then what it costs and, below the first, what it trades.
pub fn option_line(d: &Detected, p: Pick, techs: usize, no_key: bool) -> String {
    let q = quote(p, no_key);
    let mut s = option_name(d, p, no_key);
    let per = cost(&q, 1.0);
    if per.is_empty() {
        return s;
    }
    s += ": ";
    s += &per;
    if q.codex_tokens > 0 {
        s += &format!(" ({} at API prices)", usd(q.codex_usd));
    }
    s += " per technology-year";
    if techs > 0 {
        s += &format!(" · this repo ≈ {} a year", cost(&q, techs as f64));
        s += &format!(
            ", first sync ≈ {} once",
            cost(&q, techs as f64 * FIRST_SYNC_TECH_YEARS)
        );
    }
    if let Some(t) = quality(q.quality) {
        s += " · ";
        s += &t;
    }
    if q.more_duplicates > 0 {
        s += &format!(
            "; ≈ {} more duplicate records per technology-year",
            q.more_duplicates
        );
    }
    s
}

/// The one line shown when there is nothing to choose: what to set.
pub fn nothing_line(d: &Detected) -> String {
    let codex = match &d.codex {
        CodexState::NotReady(why) => format!("Codex ({why})"),
        _ => "log in to Codex".into(),
    };
    let jev = if d.has(Route::Jev) {
        " (JEV_API_KEY alone only labels)"
    } else {
        ""
    };
    format!(
        "Reading new release notes needs a key or Codex: set AI_GATEWAY_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY or ANTHROPIC_API_KEY{jev}, or {codex}, then run `unstale setup`. Until then: deterministic signals only."
    )
}

/// The value of `--inference` that picks an option.
pub fn flag_value(d: &Detected, p: Pick) -> String {
    let env = |r: Route| format!("env:{}", d.var(r).unwrap_or(""));
    match p {
        Pick::JevKey(r) => format!("jev+{}", env(r)),
        Pick::JevCodex => "jev+codex".into(),
        Pick::Key(r) => env(r),
        Pick::Codex => "codex".into(),
        Pick::None => "none".into(),
    }
}

/// Who reads the picker: a person at a terminal (asked once, Enter accepts the first), or an agent relaying it (each
/// option with the flag that picks it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reader {
    Person,
    Agent,
}

/// The picker as printed: a header, one numbered line per option (the first is recommended), and for an agent the
/// command that records a choice.
/// Without options, the one line of what to set.
pub fn picker_lines(d: &Detected, techs: usize, no_key: bool, reader: Reader) -> Vec<String> {
    let opts = options(d, no_key);
    if opts.is_empty() {
        return vec![nothing_line(d)];
    }
    let scope = match techs {
        0 => String::new(),
        1 => "; this repo has 1 technology".into(),
        n => format!("; this repo has {n} technologies"),
    };
    let mut out = vec![format!(
        "Choose how unstale reads new release notes (costs are estimates{scope}):"
    )];
    for (i, p) in opts.iter().enumerate() {
        let mut l = format!("  {}) {}", i + 1, option_line(d, *p, techs, no_key));
        if reader == Reader::Agent {
            l += &format!(" [--inference {}]", flag_value(d, *p));
        }
        out.push(l);
    }
    if reader == Reader::Agent {
        out.push("Record the choice with `unstale setup --inference <value>`.".into());
    }
    out
}

/// The question under the picker.
pub fn prompt(n: usize) -> String {
    match n {
        1 => "Press Enter to use it: ".into(),
        n => format!("Choose 1–{n}, or press Enter for 1 (recommended): "),
    }
}

/// Asks once: Enter accepts the first option, a number picks one. Input that is not a choice is asked for again, at
/// most twice more; then, as at end of input, nothing is used ([`Pick::None`]).
pub fn ask(opts: &[Pick], input: &mut dyn std::io::BufRead, out: &mut dyn std::io::Write) -> Pick {
    for _ in 0..3 {
        let _ = write!(out, "{}", prompt(opts.len()));
        let _ = out.flush();
        let mut line = String::new();
        match input.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let t = line.trim();
        if t.is_empty() {
            return opts[0];
        }
        if let Some(p) = t
            .parse::<usize>()
            .ok()
            .filter(|n| (1..=opts.len()).contains(n))
        {
            return opts[p - 1];
        }
    }
    let _ = writeln!(out);
    Pick::None
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
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Labels {
    /// `jev`.
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
    }
}

fn route_by_id(id: &str) -> Option<Route> {
    [
        Route::Vercel,
        Route::OpenAi,
        Route::OpenRouter,
        Route::Anthropic,
        Route::Jev,
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
        }
    }

    fn key(r: Route, var: &str) -> Choice {
        Choice {
            provider: provider_id(r).into(),
            key_env: Some(var.into()),
            labels: None,
        }
    }

    fn codex() -> Choice {
        Choice {
            provider: "codex".into(),
            key_env: None,
            labels: None,
        }
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
            Pick::Key(r) => Choice::key(r, &var(r)),
            Pick::Codex => Choice::codex(),
            Pick::None => Choice::none(),
        }
    }

    pub fn is_none(&self) -> bool {
        self.provider == "none"
    }

    /// The provider configurations to call: the one that writes records, and Jev for labels when chosen. `None` for no
    /// model provider.
    pub fn providers(&self) -> Option<(ProviderConfig, Option<ProviderConfig>)> {
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
        Some((main, labels))
    }

    /// The variables this choice reads keys from.
    pub fn key_vars(&self) -> Vec<&str> {
        self.labels
            .iter()
            .map(|l| l.key_env.as_str())
            .chain(self.key_env.as_deref())
            .collect()
    }

    /// What the choice uses, for status and confirmation lines: `Jev labelling API + OpenAI (JEV_API_KEY,
    /// OPENAI_API_KEY)`.
    pub fn describe(&self) -> String {
        let main = match self.provider.as_str() {
            "codex" => "Codex plan".to_string(),
            "none" => return "none (deterministic signals only)".into(),
            p => route_by_id(p).map(route_name).unwrap_or(p).to_string(),
        };
        let name = match &self.labels {
            Some(_) => format!("{} + {main}", route_name(Route::Jev)),
            None => main,
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
/// `~/.config/unstale/config.json`.
pub fn user_config_path() -> std::path::PathBuf {
    let dir = std::env::var_os("UNSTALE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(std::path::PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config"))
                })
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("unstale")
        });
    dir.join("config.json")
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
    let mut doc = user_doc(path);
    doc.insert("inference".into(), serde_json::to_value(c)?);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::util::write_atomic(
        path,
        format!("{}\n", serde_json::to_string_pretty(&doc)?).as_bytes(),
    )
}

/// The choice in effect: this repository's, else the user's.
pub fn current(repo: Option<&Choice>, user_path: &Path) -> Option<(Choice, Origin)> {
    match repo {
        Some(c) => Some((c.clone(), Origin::Repo)),
        None => read_user(user_path).map(|c| (c, Origin::User)),
    }
}

#[cfg(test)]
mod tests;
