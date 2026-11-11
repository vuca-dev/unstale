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

#[cfg(test)]
mod tests;
