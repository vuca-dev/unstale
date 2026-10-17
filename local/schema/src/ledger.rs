//! The ledger: what is withheld from the agent. Local only; never read centrally.
//!
//! One JSON line per record, sorted by id, after a `{"schema":1}` line. Unlike the catalog, unknown
//! fields are rejected: a line that does not validate is treated as unreviewed (fail safe) and reported.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const LEDGER_SCHEMA: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub schema: u32,
}

/// A stored disposition. The status tag decides which fields exist, so a deferral without `until`
/// cannot be built and `until` cannot appear on any other status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Entry {
    /// Re-opens only when the record's revision changes.
    Declined {
        id: String,
        rev: u32,
        date: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    /// Applied where the code cannot show it. Re-opens only when the record's revision changes.
    Done {
        id: String,
        rev: u32,
        date: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    /// Re-opens on `until`; after three deferrals it becomes declined.
    Deferred {
        id: String,
        rev: u32,
        date: String,
        until: String,
        n: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    /// The agent found nothing to apply it to. Re-opens after a fixed interval, with the same cap.
    NoSite {
        id: String,
        rev: u32,
        date: String,
        n: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
}

impl Entry {
    pub fn id(&self) -> &str {
        match self {
            Entry::Declined { id, .. } | Entry::Done { id, .. } | Entry::Deferred { id, .. } | Entry::NoSite { id, .. } => id,
        }
    }

    /// Precedence when two lines name the same record (after a union merge): higher wins.
    pub fn precedence(&self) -> u8 {
        match self {
            Entry::Declined { .. } | Entry::Done { .. } => 3,
            Entry::Deferred { .. } => 2,
            Entry::NoSite { .. } => 1,
        }
    }
}

/// A line that did not validate: its 1-based line number and the reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid {
    pub line: usize,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Ledger {
    pub entries: Vec<Entry>,
}

impl Ledger {
    /// Parse a ledger file. Invalid lines are returned, not fatal: their records count as unreviewed.
    /// Lines naming the same record (a union merge) resolve by precedence, then by the later date.
    pub fn parse(text: &str) -> Result<(Ledger, Vec<Invalid>), String> {
        let mut lines = text.lines().enumerate().filter(|(_, l)| !l.trim().is_empty());
        let header: Header = match lines.next() {
            None => return Ok((Ledger::default(), vec![])),
            Some((_, l)) => serde_json::from_str(l).map_err(|e| format!("line 1: not a ledger header: {e}"))?,
        };
        if header.schema > LEDGER_SCHEMA {
            return Err(format!("ledger schema {} is newer than this tool ({LEDGER_SCHEMA})", header.schema));
        }
        let mut invalid = vec![];
        let mut by_id: std::collections::BTreeMap<String, Entry> = Default::default();
        for (n, l) in lines {
            match serde_json::from_str::<Entry>(l) {
                Ok(e) => {
                    let keep = match by_id.get(e.id()) {
                        None => true,
                        Some(old) => (e.precedence(), date(&e)) > (old.precedence(), date(old)),
                    };
                    if keep {
                        by_id.insert(e.id().to_string(), e);
                    }
                }
                Err(err) => invalid.push(Invalid { line: n + 1, reason: err.to_string() }),
            }
        }
        Ok((Ledger { entries: by_id.into_values().collect() }, invalid))
    }

    /// Serialise deterministically: header, then one line per record sorted by id.
    pub fn write(&self) -> String {
        let mut entries = self.entries.clone();
        entries.sort_by(|a, b| a.id().cmp(b.id()));
        let mut out = serde_json::to_string(&Header { schema: LEDGER_SCHEMA }).unwrap();
        out.push('\n');
        for e in &entries {
            out.push_str(&serde_json::to_string(e).unwrap());
            out.push('\n');
        }
        out
    }

    /// Write, then parse back and compare: a writer bug fails here, before the file is swapped in.
    pub fn write_checked(&self) -> Result<String, String> {
        let text = self.write();
        let (back, invalid) = Ledger::parse(&text)?;
        let mut want = self.entries.clone();
        want.sort_by(|a, b| a.id().cmp(b.id()));
        if !invalid.is_empty() || back.entries != want {
            return Err("ledger did not survive a write and read back".into());
        }
        Ok(text)
    }
}

fn date(e: &Entry) -> &str {
    match e {
        Entry::Declined { date, .. } | Entry::Done { date, .. } | Entry::Deferred { date, .. } | Entry::NoSite { date, .. } => date,
    }
}
