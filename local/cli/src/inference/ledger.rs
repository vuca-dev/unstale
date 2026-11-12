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

/// The default monthly token budget, across every provider: about one and a half times the first sync of a
/// 40-technology repo on the costliest supported route.
///
/// First sync: one mean technology-year per technology. On Codex alone that measures about 0.75M tokens
/// (`eval/edge-port/RESULTS.md`, addendum 4), 30M for 40 technologies. It was set at twice an estimate of 0.6M; the
/// measurement puts it 20% under twice the measured figure (60M), within the 25% that would change it.
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
    /// Tokens counted against the budget: everything in and out. Saturates: an absurd count reads as the budget used
    /// up, never as a panic or a wrap to zero.
    pub fn tokens(&self) -> u64 {
        self.input.saturating_add(self.output)
    }
    /// When a provider reports no usage: about four bytes of JSON per token each way, so the budget still counts the
    /// call.
    pub fn estimate(request: &impl Serialize, response: &impl Serialize) -> Usage {
        let tokens = |v: Vec<u8>| (v.len() as u64).div_ceil(4);
        Usage {
            input: tokens(serde_json::to_vec(request).unwrap_or_default()),
            cached: 0,
            output: tokens(serde_json::to_vec(response).unwrap_or_default()),
            reasoning: None,
        }
    }

    pub fn add(&mut self, o: &Usage) {
        self.input = self.input.saturating_add(o.input);
        self.cached = self.cached.saturating_add(o.cached);
        self.output = self.output.saturating_add(o.output);
        self.reasoning = match (self.reasoning, o.reasoning) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0).saturating_add(b.unwrap_or(0))),
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
    /// Every write fails (tests: a ledger that turns unwritable after the budget check).
    #[cfg(test)]
    pub fail_writes: bool,
}

/// This month as `YYYY-MM` (UTC; `UNSTALE_TODAY` overrides the date).
pub fn this_month() -> String {
    crate::util::today()[..7].to_string()
}

impl Ledger {
    pub fn new(dir: PathBuf) -> Ledger {
        Ledger {
            dir,
            #[cfg(test)]
            fail_writes: false,
        }
    }

    /// `{cache}/inference/`, beside the catalog cache.
    pub fn default_location() -> Ledger {
        Ledger::new(crate::cache::cache_dir().join("inference"))
    }

    fn file(&self, month: &str) -> PathBuf {
        self.dir.join(format!("usage-{month}.jsonl"))
    }

    /// Where a month's usage is kept, to name in a message.
    pub fn path(&self, month: &str) -> PathBuf {
        self.file(month)
    }

    /// Appends one call. An error means the spend went unrecorded; the caller stops making calls.
    pub fn record(&self, provider: &str, model: &str, usage: &Usage) -> std::io::Result<()> {
        let day = crate::util::today();
        let line = Line {
            day: day.clone(),
            provider: provider.into(),
            model: model.into(),
            usage: *usage,
        };
        let mut text = serde_json::to_string(&line)?;
        text.push('\n');
        self.open_for_append(&day[..7])?.write_all(text.as_bytes())
    }

    fn open_for_append(&self, month: &str) -> std::io::Result<std::fs::File> {
        #[cfg(test)]
        if self.fail_writes {
            return Err(std::io::Error::other("writes fail (test)"));
        }
        std::fs::create_dir_all(&self.dir)?;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.file(month))
    }

    /// Whether this month's file can be appended to, checked before a call so spend is never left unrecorded.
    pub fn writable(&self, month: &str) -> std::io::Result<()> {
        // Opening for append writes nothing; the check itself cannot fail on a test hook.
        std::fs::create_dir_all(&self.dir)?;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.file(month))
            .map(|_| ())
    }

    /// A month's lines; a month with no file is empty. Any other read error, or a line that does not parse, is an
    /// error, so the budget check fails closed rather than seeing less spend than there was.
    fn lines(&self, month: &str) -> std::io::Result<Vec<Line>> {
        let text = match std::fs::read_to_string(self.file(month)) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e),
        };
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| {
                serde_json::from_str(l)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
            })
            .collect()
    }

    /// Usage per (day, provider) in a month (`YYYY-MM`).
    pub fn by_day(&self, month: &str) -> BTreeMap<(String, String), Usage> {
        let mut out: BTreeMap<(String, String), Usage> = BTreeMap::new();
        for l in self.lines(month).unwrap_or_default() {
            out.entry((l.day, l.provider)).or_default().add(&l.usage);
        }
        out
    }

    /// Tokens counted against the budget in a month.
    /// (0 when the ledger cannot be read; [`Ledger::spent`] reports that.)
    pub fn month_tokens(&self, month: &str) -> u64 {
        self.spent(month).unwrap_or(0)
    }

    /// Tokens counted against the budget in a month, or the error that kept the ledger from being read. Saturates, so
    /// a line with an absurd count reads as the budget used up.
    pub fn spent(&self, month: &str) -> std::io::Result<u64> {
        Ok(self
            .lines(month)?
            .iter()
            .fold(0u64, |n, l| n.saturating_add(l.usage.tokens())))
    }
}

/// Tokens as a short figure: `850`, `1.5k`, `12k`, `1.2M`, `48M`. Rounded down to one decimal, never up past a
/// limit.
pub fn short_tokens(n: u64) -> String {
    let scaled = |unit: u64, letter: char| {
        let tenths = n / (unit / 10);
        if tenths.is_multiple_of(10) || tenths >= 1_000 {
            format!("{}{letter}", tenths / 10)
        } else {
            format!("{}.{}{letter}", tenths / 10, tenths % 10)
        }
    };
    match n {
        0..=999 => n.to_string(),
        1_000..=999_999 => scaled(1_000, 'k'),
        _ => scaled(1_000_000, 'M'),
    }
}
