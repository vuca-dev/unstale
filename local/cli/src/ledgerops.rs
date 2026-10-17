//! Ledger rules at the edge. The types and the parse/write round trip live in `unstale_schema::ledger`; this module
//! adds the re-open rules, reconciliation against the catalog, dispositions, and the atomic file swap.

use anyhow::{Context, Result, bail};
use std::path::Path;
use unstale_schema::ledger::{Entry, Invalid, Ledger};

use crate::cache::Lookup;
use crate::util::{add_days, parse_date, write_atomic};

/// Days a deferral lasts.
pub const DEFER_DAYS: i64 = 30;
/// The fixed re-review interval for "no site".
pub const NO_SITE_DAYS: i64 = 14;
/// At most three deferrals (or no-site answers); the next one becomes declined.
pub const MAX_DEFERRALS: u8 = 3;

/// The ledger file as read: entries, invalid lines (their records count as unreviewed), or an unreadable header.
#[derive(Debug, Default, Clone)]
pub struct LedgerFile {
    pub ledger: Ledger,
    pub invalid: Vec<Invalid>,
    /// The whole file could not be used (newer schema, bad header): every record counts as unreviewed and the
    /// tool refuses to rewrite it.
    pub fatal: Option<String>,
}

impl LedgerFile {
    pub fn load(path: &Path) -> LedgerFile {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return LedgerFile::default(),
            Err(e) => return LedgerFile { fatal: Some(format!("cannot read {}: {e}", path.display())), ..Default::default() },
        };
        match Ledger::parse(&text) {
            Ok((ledger, invalid)) => LedgerFile { ledger, invalid, fatal: None },
            Err(e) => LedgerFile { fatal: Some(e), ..Default::default() },
        }
    }

    /// Warnings to print: each invalid line by number, or the fatal reason.
    pub fn warnings(&self, path: &Path) -> Vec<String> {
        let mut w = vec![];
        if let Some(f) = &self.fatal {
            w.push(format!("warning: ledger {} ignored ({f}); every record counts as unreviewed", path.display()));
        }
        for i in &self.invalid {
            w.push(format!(
                "warning: ledger {} line {} is invalid ({}); its record counts as unreviewed",
                path.display(),
                i.line,
                i.reason
            ));
        }
        w
    }

    pub fn writable(&self) -> Result<()> {
        if let Some(f) = &self.fatal {
            bail!("refusing to rewrite the ledger: {f}");
        }
        if !self.invalid.is_empty() {
            let lines: Vec<String> = self.invalid.iter().map(|i| i.line.to_string()).collect();
            bail!(
                "refusing to rewrite the ledger while line(s) {} are invalid (they would be lost); fix them, then retry (`unstale ledger check`)",
                lines.join(", ")
            );
        }
        Ok(())
    }
}

/// Write the ledger: serialise, parse back and compare (`write_checked`), then swap the file in atomically.
pub fn save(path: &Path, ledger: &Ledger) -> Result<()> {
    let text = ledger.write_checked().map_err(anyhow::Error::msg).context("ledger write check failed; file untouched")?;
    write_atomic(path, text.as_bytes())
}

pub fn entry_rev(e: &Entry) -> u32 {
    match e {
        Entry::Declined { rev, .. } | Entry::Done { rev, .. } | Entry::Deferred { rev, .. } | Entry::NoSite { rev, .. } => *rev,
    }
}

pub fn entry_date(e: &Entry) -> &str {
    match e {
        Entry::Declined { date, .. } | Entry::Done { date, .. } | Entry::Deferred { date, .. } | Entry::NoSite { date, .. } => date,
    }
}

pub fn status_name(e: &Entry) -> &'static str {
    match e {
        Entry::Declined { .. } => "declined",
        Entry::Done { .. } => "done",
        Entry::Deferred { .. } => "deferred",
        Entry::NoSite { .. } => "no site",
    }
}

fn with_id_rev(e: &Entry, new_id: &str, new_rev: u32) -> Entry {
    let mut e = e.clone();
    match &mut e {
        Entry::Declined { id, rev, .. } | Entry::Done { id, rev, .. } | Entry::Deferred { id, rev, .. } | Entry::NoSite { id, rev, .. } => {
            *id = new_id.to_string();
            *rev = new_rev;
        }
    }
    e
}

/// Does this entry withhold a record at `record_rev` today? False once it re-opens.
pub fn withholds(e: &Entry, record_rev: u32, today: &str) -> bool {
    if entry_rev(e) < record_rev {
        return false; // the revision rose: unreviewed again
    }
    let t = parse_date(today).unwrap_or(i64::MAX);
    match e {
        Entry::Declined { .. } | Entry::Done { .. } => true,
        Entry::Deferred { until, .. } => parse_date(until).is_some_and(|u| t < u),
        Entry::NoSite { date, .. } => parse_date(date).is_some_and(|d| t < d + NO_SITE_DAYS),
    }
}

/// What reconciliation changed, for the report.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Reconciled {
    pub rewritten: Vec<(String, String)>,
    pub deleted: Vec<String>,
}

impl Reconciled {
    pub fn is_empty(&self) -> bool {
        self.rewritten.is_empty() && self.deleted.is_empty()
    }
}

/// Apply the catalog's stubs to the ledger: a merged stub rewrites the line to its target at the target's current
/// revision (precedence decides when the target already has a line); a retracted stub deletes the line. A record
/// that is simply missing keeps its line (its shard may not be synced, or the stack changed). Revision and
/// label changes leave lines untouched: re-opening is decided when reading.
pub fn reconcile(ledger: &Ledger, lookup: impl Fn(&str) -> Lookup) -> (Ledger, Reconciled) {
    let mut out: std::collections::BTreeMap<String, Entry> = Default::default();
    let mut rep = Reconciled::default();
    let put = |e: Entry, out: &mut std::collections::BTreeMap<String, Entry>| {
        let keep = match out.get(e.id()) {
            None => true,
            Some(old) => (e.precedence(), entry_date(&e)) > (old.precedence(), entry_date(old)),
        };
        if keep {
            out.insert(e.id().to_string(), e);
        }
    };
    // Lines that are not rewritten go in first, so a rewritten line competes with the target's own line.
    let mut moved = vec![];
    for e in &ledger.entries {
        let mut id = e.id().to_string();
        let mut hops = 0;
        let outcome = loop {
            match lookup(&id) {
                Lookup::Merged(to) if hops < 32 && to != id => {
                    id = to;
                    hops += 1;
                }
                Lookup::Merged(_) => break None, // a cycle: leave the line alone
                Lookup::Retracted => break Some(None),
                Lookup::Active(rev) if hops > 0 => break Some(Some((id.clone(), rev))),
                Lookup::Active(_) => break None,
                // A merge target that is not loaded: keep the original line until it is.
                Lookup::Missing => break None,
            }
        };
        match outcome {
            None => put(e.clone(), &mut out),
            Some(None) => rep.deleted.push(e.id().to_string()),
            Some(Some((to, rev))) => {
                rep.rewritten.push((e.id().to_string(), to.clone()));
                moved.push(with_id_rev(e, &to, rev));
            }
        }
    }
    for e in moved {
        put(e, &mut out);
    }
    (Ledger { entries: out.into_values().collect() }, rep)
}

/// The closed set an agent or user records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    Declined,
    Done,
    Deferred,
    NoSite,
}

impl std::str::FromStr for Disposition {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "declined" => Ok(Self::Declined),
            "done" => Ok(Self::Done),
            "deferred" => Ok(Self::Deferred),
            "no-site" | "no_site" => Ok(Self::NoSite),
            _ => Err(format!("unknown disposition `{s}`: expected declined, done, deferred or no-site")),
        }
    }
}

/// Record a disposition for `id` at `rev`. A deferral or no-site answer counts up from the previous one at the
/// same revision; the fourth becomes declined.
pub fn dispose(ledger: &mut Ledger, id: &str, rev: u32, d: Disposition, today: &str, note: Option<String>) -> Entry {
    let prev = ledger.entries.iter().find(|e| e.id() == id).cloned();
    let prev_n = |want_deferred: bool| -> u8 {
        match &prev {
            Some(Entry::Deferred { rev: r, n, .. }) if want_deferred && *r == rev => *n,
            Some(Entry::NoSite { rev: r, n, .. }) if !want_deferred && *r == rev => *n,
            _ => 0,
        }
    };
    let date = today.to_string();
    let e = match d {
        Disposition::Declined => Entry::Declined { id: id.into(), rev, date, note },
        Disposition::Done => Entry::Done { id: id.into(), rev, date, note },
        Disposition::Deferred => {
            let n = prev_n(true) + 1;
            if n > MAX_DEFERRALS {
                Entry::Declined { id: id.into(), rev, date, note }
            } else {
                let until = add_days(today, DEFER_DAYS).unwrap_or_else(|| today.to_string());
                Entry::Deferred { id: id.into(), rev, date, until, n, note }
            }
        }
        Disposition::NoSite => {
            let n = prev_n(false) + 1;
            if n > MAX_DEFERRALS {
                Entry::Declined { id: id.into(), rev, date, note }
            } else {
                Entry::NoSite { id: id.into(), rev, date, n, note }
            }
        }
    };
    ledger.entries.retain(|x| x.id() != id);
    ledger.entries.push(e.clone());
    ledger.entries.sort_by(|a, b| a.id().cmp(b.id()));
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    fn led(lines: &[&str]) -> Ledger {
        let text = format!("{{\"schema\":1}}\n{}\n", lines.join("\n"));
        let (l, inv) = Ledger::parse(&text).unwrap();
        assert!(inv.is_empty());
        l
    }

    #[test]
    fn declined_withholds_until_revision_rises() {
        let l = led(&[r#"{"id":"next:a","rev":2,"status":"declined","date":"2026-10-01"}"#]);
        let e = &l.entries[0];
        assert!(withholds(e, 2, "2030-01-01"), "a decline holds forever at the same revision");
        assert!(withholds(e, 1, "2026-10-15"));
        assert!(!withholds(e, 3, "2026-10-15"), "a revision bump re-opens it");
    }

    #[test]
    fn deferral_reopens_on_date_and_fourth_becomes_declined() {
        let mut l = Ledger::default();
        let e = dispose(&mut l, "next:a", 1, Disposition::Deferred, "2026-10-15", None);
        assert_eq!(e, Entry::Deferred { id: "next:a".into(), rev: 1, date: "2026-10-15".into(), until: "2026-11-14".into(), n: 1, note: None });
        assert!(withholds(&e, 1, "2026-11-13"));
        assert!(!withholds(&e, 1, "2026-11-14"), "re-opens on its date");
        dispose(&mut l, "next:a", 1, Disposition::Deferred, "2026-11-14", None);
        let e3 = dispose(&mut l, "next:a", 1, Disposition::Deferred, "2026-12-14", None);
        assert!(matches!(e3, Entry::Deferred { n: 3, .. }));
        let e4 = dispose(&mut l, "next:a", 1, Disposition::Deferred, "2027-01-13", None);
        assert!(matches!(e4, Entry::Declined { .. }), "the fourth deferral becomes declined");
        assert_eq!(l.entries.len(), 1);
    }

    #[test]
    fn deferral_count_restarts_on_a_new_revision() {
        let mut l = led(&[r#"{"id":"next:a","rev":1,"status":"deferred","date":"2026-10-01","until":"2026-10-31","n":3}"#]);
        let e = dispose(&mut l, "next:a", 2, Disposition::Deferred, "2026-10-15", None);
        assert!(matches!(e, Entry::Deferred { n: 1, rev: 2, .. }));
    }

    #[test]
    fn no_site_reopens_after_interval_with_the_same_cap() {
        let mut l = Ledger::default();
        let e = dispose(&mut l, "next:a", 1, Disposition::NoSite, "2026-10-15", None);
        assert!(withholds(&e, 1, "2026-10-28"));
        assert!(!withholds(&e, 1, "2026-10-29"));
        dispose(&mut l, "next:a", 1, Disposition::NoSite, "2026-10-29", None);
        dispose(&mut l, "next:a", 1, Disposition::NoSite, "2026-11-12", None);
        let e4 = dispose(&mut l, "next:a", 1, Disposition::NoSite, "2026-11-26", None);
        assert!(matches!(e4, Entry::Declined { .. }));
    }

    fn lookup_from(pairs: &[(&str, Lookup)]) -> impl Fn(&str) -> Lookup + use<> {
        let m: std::collections::HashMap<String, Lookup> = pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
        move |id| m.get(id).cloned().unwrap_or(Lookup::Missing)
    }

    #[test]
    fn label_only_correction_keeps_the_decision() {
        // The record's label_version rose but its revision did not: nothing changes and it stays withheld.
        let l = led(&[r#"{"id":"next:a","rev":2,"status":"declined","date":"2026-10-01"}"#]);
        let (r, rep) = reconcile(&l, lookup_from(&[("next:a", Lookup::Active(2))]));
        assert_eq!(r, l);
        assert!(rep.is_empty());
        assert!(withholds(&r.entries[0], 2, "2026-10-15"));
    }

    #[test]
    fn revision_bump_reopens_but_keeps_the_line_until_next_write() {
        let l = led(&[r#"{"id":"next:a","rev":2,"status":"declined","date":"2026-10-01"}"#]);
        let (r, _) = reconcile(&l, lookup_from(&[("next:a", Lookup::Active(3))]));
        assert_eq!(r, l, "the old line stays");
        assert!(!withholds(&r.entries[0], 3, "2026-10-15"), "but it no longer withholds");
    }

    #[test]
    fn merge_stub_rewrites_to_target_at_its_revision() {
        let l = led(&[r#"{"id":"next:a","rev":1,"status":"declined","date":"2026-10-01"}"#]);
        let (r, rep) = reconcile(&l, lookup_from(&[("next:a", Lookup::Merged("next:b".into())), ("next:b", Lookup::Active(4))]));
        assert_eq!(r.entries, vec![Entry::Declined { id: "next:b".into(), rev: 4, date: "2026-10-01".into(), note: None }]);
        assert_eq!(rep.rewritten, vec![("next:a".to_string(), "next:b".to_string())]);
        assert!(withholds(&r.entries[0], 4, "2026-10-15"), "the merge alone does not re-open the decision");
    }

    #[test]
    fn merge_stub_with_existing_target_line_uses_precedence() {
        // B already deferred; A declined. Declined beats deferred.
        let l = led(&[
            r#"{"id":"next:a","rev":1,"status":"declined","date":"2026-09-01"}"#,
            r#"{"id":"next:b","rev":2,"status":"deferred","date":"2026-10-01","until":"2026-11-01","n":1}"#,
        ]);
        let lk = lookup_from(&[("next:a", Lookup::Merged("next:b".into())), ("next:b", Lookup::Active(2))]);
        let (r, _) = reconcile(&l, lk);
        assert_eq!(r.entries, vec![Entry::Declined { id: "next:b".into(), rev: 2, date: "2026-09-01".into(), note: None }]);
        // And the other way round: B declined, A no-site; B's line wins.
        let l = led(&[
            r#"{"id":"next:a","rev":1,"status":"no_site","date":"2026-10-10","n":1}"#,
            r#"{"id":"next:b","rev":2,"status":"declined","date":"2026-09-01"}"#,
        ]);
        let lk = lookup_from(&[("next:a", Lookup::Merged("next:b".into())), ("next:b", Lookup::Active(2))]);
        let (r, _) = reconcile(&l, lk);
        assert_eq!(r.entries, vec![Entry::Declined { id: "next:b".into(), rev: 2, date: "2026-09-01".into(), note: None }]);
    }

    #[test]
    fn retraction_deletes_and_missing_keeps() {
        let l = led(&[
            r#"{"id":"next:gone","rev":1,"status":"declined","date":"2026-10-01"}"#,
            r#"{"id":"next:unsynced","rev":1,"status":"done","date":"2026-10-01"}"#,
        ]);
        let (r, rep) = reconcile(&l, lookup_from(&[("next:gone", Lookup::Retracted)]));
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].id(), "next:unsynced", "a record missing from the shards keeps its line");
        assert_eq!(rep.deleted, vec!["next:gone".to_string()]);
    }

    #[test]
    fn merge_chain_and_unloaded_target() {
        let l = led(&[r#"{"id":"next:a","rev":1,"status":"declined","date":"2026-10-01"}"#]);
        let lk = lookup_from(&[("next:a", Lookup::Merged("next:b".into())), ("next:b", Lookup::Merged("next:c".into())), ("next:c", Lookup::Active(7))]);
        let (r, _) = reconcile(&l, lk);
        assert_eq!(r.entries[0].id(), "next:c");
        // Target not loaded: keep A's line.
        let (r, rep) = reconcile(&l, lookup_from(&[("next:a", Lookup::Merged("next:zz".into()))]));
        assert_eq!(r, l);
        assert!(rep.is_empty());
    }

    #[test]
    fn invalid_line_is_unreviewed_and_blocks_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ledger.jsonl");
        std::fs::write(
            &p,
            "{\"schema\":1}\n{\"id\":\"next:a\",\"rev\":1,\"status\":\"declined\",\"date\":\"2026-10-01\"}\n{\"id\":\"next:b\",\"rev\":1,\"status\":\"deferred\",\"date\":\"2026-10-01\"}\n",
        )
        .unwrap();
        let f = LedgerFile::load(&p);
        assert_eq!(f.ledger.entries.len(), 1, "the deferral without `until` is invalid and withholds nothing");
        assert_eq!(f.invalid.len(), 1);
        assert_eq!(f.invalid[0].line, 3);
        assert!(f.writable().is_err());
        assert!(f.warnings(&p)[0].contains("line 3"));
    }

    #[test]
    fn newer_ledger_schema_is_ignored_safely() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ledger.jsonl");
        std::fs::write(&p, "{\"schema\":2}\n").unwrap();
        let f = LedgerFile::load(&p);
        assert!(f.fatal.is_some());
        assert!(f.writable().is_err(), "an older install never rewrites a newer file");
    }

    #[test]
    fn save_is_checked_and_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ledger.jsonl");
        let mut l = Ledger::default();
        dispose(&mut l, "prisma:b", 1, Disposition::Done, "2026-10-15", Some("applied by hand".into()));
        dispose(&mut l, "next:a", 2, Disposition::Declined, "2026-10-15", None);
        save(&p, &l).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert_eq!(
            text,
            "{\"schema\":1}\n{\"status\":\"declined\",\"id\":\"next:a\",\"rev\":2,\"date\":\"2026-10-15\"}\n{\"status\":\"done\",\"id\":\"prisma:b\",\"rev\":1,\"date\":\"2026-10-15\",\"note\":\"applied by hand\"}\n"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "no temporary file left behind");
    }
}
