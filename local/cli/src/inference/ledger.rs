//! The local usage ledger and the monthly token budget.
//!
//! One JSON line per model call in `{cache}/inference/usage-YYYY-MM.jsonl`: the UTC day, the provider, the model, and
//! tokens in (cached included), cached, out and reasoning (included in out; absent when the provider does not report
//! it). Lines are appended with one write each, so concurrent writers do not interleave within a line. Nothing but
//! counts is written: no prompt, no answer, no key.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;

/// The default monthly token budget, across every provider: twice the estimated first sync of a 40-technology repo.
///
/// Estimate (until the client's own first-sync measurement replaces it): one mean technology-year per technology on
/// the costliest supported route, Codex with the lean flags at 8 items per call, about 0.6M tokens (0.14M harness
/// overhead, 0.39M payload in, 61k out; `eval/edge-cli/RESULTS.md`). 40 × 0.6M = 24M; twice that is 48M.
pub const DEFAULT_MONTHLY_TOKENS: u64 = 48_000_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    /// Input tokens, cached ones included.
    pub input: u64,
    pub cached: u64,
    /// Output tokens, reasoning included.
    pub output: u64,
    pub reasoning: Option<u64>,
}

impl Usage {
    /// Tokens counted against the budget: everything in and out.
    pub fn tokens(&self) -> u64 {
        self.input + self.output
    }
    pub fn add(&mut self, o: &Usage) {
        self.input += o.input;
        self.cached += o.cached;
        self.output += o.output;
        self.reasoning = match (self.reasoning, o.reasoning) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
        };
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Line {
    day: String,
    provider: String,
    model: String,
    #[serde(flatten)]
    usage: Usage,
}

#[derive(Debug, Clone)]
pub struct Ledger {
    dir: PathBuf,
}

/// This month as `YYYY-MM` (UTC; `UNSTALE_TODAY` overrides the date).
pub fn this_month() -> String {
    crate::util::today()[..7].to_string()
}

impl Ledger {
    pub fn new(dir: PathBuf) -> Ledger {
        Ledger { dir }
    }

    /// `{cache}/inference/`, beside the catalog cache.
    pub fn default_location() -> Ledger {
        Ledger::new(crate::cache::cache_dir().join("inference"))
    }

    fn file(&self, month: &str) -> PathBuf {
        self.dir.join(format!("usage-{month}.jsonl"))
    }

    /// Appends one call. A ledger that cannot be written never stops the call it records.
    pub fn record(&self, provider: &str, model: &str, usage: &Usage) {
        let day = crate::util::today();
        let line = Line {
            day: day.clone(),
            provider: provider.into(),
            model: model.into(),
            usage: *usage,
        };
        let Ok(mut text) = serde_json::to_string(&line) else {
            return;
        };
        text.push('\n');
        let _ = std::fs::create_dir_all(&self.dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.file(&day[..7]))
        {
            let _ = f.write_all(text.as_bytes());
        }
    }

    fn lines(&self, month: &str) -> Vec<Line> {
        std::fs::read_to_string(self.file(month))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    /// Usage per (day, provider) in a month (`YYYY-MM`).
    pub fn by_day(&self, month: &str) -> BTreeMap<(String, String), Usage> {
        let mut out: BTreeMap<(String, String), Usage> = BTreeMap::new();
        for l in self.lines(month) {
            out.entry((l.day, l.provider)).or_default().add(&l.usage);
        }
        out
    }

    /// Tokens counted against the budget in a month.
    pub fn month_tokens(&self, month: &str) -> u64 {
        self.lines(month).iter().map(|l| l.usage.tokens()).sum()
    }
}

/// Tokens as a short figure: `850`, `12k`, `1.2M`, `48M`.
pub fn short_tokens(n: u64) -> String {
    match n {
        0..=999 => n.to_string(),
        1_000..=999_999 => format!("{}k", n / 1_000),
        _ if n.is_multiple_of(1_000_000) || n >= 100_000_000 => format!("{}M", n / 1_000_000),
        _ => format!("{:.1}M", n as f64 / 1_000_000.0),
    }
}

/// The budget line for `unstale status` and the picker.
pub fn budget_line(used: u64, budget: u64) -> String {
    format!(
        "Model tokens this month: {} of {} (monthly budget; past it, work waits for next month)",
        short_tokens(used),
        short_tokens(budget)
    )
}
