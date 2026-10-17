//! Availability by release line, from the tech index's release index (reference implementation
//! `eval/lines/contract.py`).
//!
//! Central publishes the technology's stable releases in the window, ascending by version, each with its derived
//! line (a set of versions inside which version order is publish order) and `line_start` on a line's first release
//! when the line began in the window. A version `v` has a record's change when:
//!   (a) a release of the record is on `v`'s line at or before `v` (by index position), or
//!   (b) `v`'s line's first release is marked `line_start` and was published on or after the day of a release of the
//!       record on an older line (the line branched after the fix shipped). Dates are days, so a same-day pair cannot
//!       be ordered by date; it reads in version order, as central's line derivation reads same-day releases (and as
//!       a catalog whose old releases all carry one import date needs: jsdom 3.0.0 is in 20.0.0).
//! A version the index does not hold is placed by its first `depth` numeric components (the depth of the index's
//! lines) and compared numerically; a version that is not numeric dotted, or a technology without an index (older
//! catalogs), is not decided here and the caller keeps the old rule (`funnel::pick_release`).

use std::collections::BTreeMap;

use unstale_schema::catalog::{IndexRelease, Release};

pub struct Lines<'a> {
    rel: &'a [IndexRelease],
    pos: BTreeMap<&'a str, usize>,
    first: BTreeMap<&'a str, usize>,
    depth: usize,
}

fn numeric(v: &str) -> Option<Vec<u64>> {
    if v.is_empty() {
        return None;
    }
    v.split('.').map(|x| if x.is_empty() || !x.bytes().all(|b| b.is_ascii_digit()) { None } else { x.parse().ok() }).collect()
}

fn prefix(v: &str, depth: usize) -> Option<String> {
    let n = numeric(v)?;
    Some((0..depth).map(|i| n.get(i).copied().unwrap_or(0).to_string()).collect::<Vec<_>>().join("."))
}

fn num_le(a: &str, b: &str) -> Option<bool> {
    let (x, y) = (numeric(a)?, numeric(b)?);
    let n = x.len().max(y.len());
    let pad = |v: &Vec<u64>| (0..n).map(|i| v.get(i).copied().unwrap_or(0)).collect::<Vec<_>>();
    Some(pad(&x) <= pad(&y))
}

impl<'a> Lines<'a> {
    pub fn new(rel: &'a [IndexRelease]) -> Self {
        let mut pos = BTreeMap::new();
        let mut first = BTreeMap::new();
        for (i, r) in rel.iter().enumerate() {
            pos.insert(r.version.as_str(), i);
            first.entry(r.line.as_str()).or_insert(i);
        }
        let depth = rel.first().map(|r| r.line.split('.').count()).unwrap_or(0);
        Lines { rel, pos, first, depth }
    }

    /// The line of a version: the index's, else its numeric prefix at the index's depth.
    fn line(&self, v: &str) -> Option<String> {
        match self.pos.get(v) {
            Some(&i) => Some(self.rel[i].line.clone()),
            None if self.depth > 0 => prefix(v, self.depth),
            None => None,
        }
    }

    /// `a` at or before `b`: by index position when both are in the index, else numerically.
    fn le(&self, a: &str, b: &str) -> Option<bool> {
        match (self.pos.get(a), self.pos.get(b)) {
            (Some(x), Some(y)) => Some(x <= y),
            _ => num_le(a, b),
        }
    }

    /// Whether `v` has the change shipped in `releases`: `Some(Some(r))` yes (by release `r`), `Some(None)` no, `None`
    /// when this cannot decide (no index, or a version it cannot place).
    pub fn has<'r>(&self, releases: &[&'r Release], v: &str) -> Option<Option<&'r Release>> {
        if self.rel.is_empty() {
            return None;
        }
        let line = self.line(v)?;
        // (a) a release on v's line at or before v (the earliest such).
        let own = releases
            .iter()
            .copied()
            .filter(|r| self.line(&r.version).as_deref() == Some(line.as_str()) && self.le(&r.version, v) == Some(true))
            .reduce(|a, b| if self.le(&b.version, &a.version) == Some(true) { b } else { a });
        if let Some(r) = own {
            return Some(Some(r));
        }
        // (b) v's line began in the window after a release of the record on an older line (the latest such).
        if let Some(&f) = self.first.get(line.as_str())
            && self.rel[f].line_start
        {
            let start = &self.rel[f].date;
            let mut best: Option<(&'r Release, usize)> = None;
            for r in releases {
                let Some(&i) = self.pos.get(r.version.as_str()) else { continue };
                let rl = &self.rel[i].line;
                let older = self.first.get(rl.as_str()).is_some_and(|&g| g < f);
                if older && self.rel[i].date <= *start && best.is_none_or(|(_, j)| i > j) {
                    best = Some((*r, i));
                }
            }
            if let Some((r, _)) = best {
                return Some(Some(r));
            }
        }
        Some(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx(rows: &[(&str, &str, &str, bool)]) -> Vec<IndexRelease> {
        rows.iter().map(|(v, d, l, s)| IndexRelease { version: v.to_string(), date: d.to_string(), line: l.to_string(), line_start: *s }).collect()
    }
    fn rel(v: &str) -> Release {
        Release { component: "pkg:npm/next".into(), version: v.into(), date: String::new(), line: v.split('.').next().unwrap().into() }
    }

    /// next-like: 15.0 gets a backport after 15.1 shipped; 15.2 began in the window.
    fn next_like() -> Vec<IndexRelease> {
        idx(&[
            ("15.0.4", "2025-11-01", "15.0", false),
            ("15.0.5", "2025-12-11", "15.0", false),
            ("15.1.8", "2025-11-01", "15.1", false),
            ("15.1.9", "2025-12-11", "15.1", false),
            ("15.2.0", "2025-11-20", "15.2", true),
            ("15.2.1", "2025-12-11", "15.2", false),
            ("16.0.0", "2026-01-10", "16.0", true),
        ])
    }

    #[test]
    fn interleaved_lines_need_a_release_on_their_own_line() {
        let i = next_like();
        let l = Lines::new(&i);
        let (a, b) = (rel("15.0.5"), rel("15.2.1"));
        let rs = [&a, &b];
        // 15.0.5 is on 15.0 only: 15.1.8 and 15.1.9 do not have it (the old rule said they did).
        assert_eq!(l.has(&rs, "15.0.5").map(|x| x.map(|r| r.version.as_str())), Some(Some("15.0.5")));
        assert_eq!(l.has(&rs, "15.0.4").map(|x| x.is_some()), Some(false));
        assert_eq!(l.has(&rs, "15.1.9").map(|x| x.is_some()), Some(false));
        // 15.2 began before the fix (2025-11-20 < 2025-12-11): it needs 15.2.1.
        assert_eq!(l.has(&rs, "15.2.0").map(|x| x.is_some()), Some(false));
        assert_eq!(l.has(&rs, "15.2.1").map(|x| x.map(|r| r.version.as_str())), Some(Some("15.2.1")));
    }

    #[test]
    fn a_line_that_began_after_the_fix_inherits_it_by_date() {
        let i = next_like();
        let l = Lines::new(&i);
        let a = rel("15.1.9");
        // 16.0 began on 2026-01-10, after 15.1.9 (2025-12-11): it has the change from its first release.
        assert_eq!(l.has(&[&a], "16.0.0").map(|x| x.map(|r| r.version.as_str())), Some(Some("15.1.9")));
        // 15.2 began before it: no.
        assert_eq!(l.has(&[&a], "15.2.1").map(|x| x.is_some()), Some(false));
        // A line whose start is unknown (began before the window) inherits nothing.
        let b = rel("15.0.4");
        assert_eq!(l.has(&[&b], "15.1.9").map(|x| x.is_some()), Some(false));
    }

    #[test]
    fn a_same_day_line_start_reads_in_version_order() {
        // An import that dated every old release on one day (jsdom's index): 3.0.0 and 20.0.0 share a date, so the
        // date cannot order them and version order does; 20 has what 3 shipped. A later-dated release still does not.
        let i = idx(&[
            ("3.0.0", "2026-03-15", "3", true),
            ("3.1.2", "2026-03-15", "3", false),
            ("20.0.0", "2026-03-15", "20", true),
            ("20.0.1", "2026-03-15", "20", false),
            ("3.1.3", "2026-04-01", "3", false),
        ]);
        let l = Lines::new(&i);
        let (a, b) = (rel("3.0.0"), rel("3.1.3"));
        assert_eq!(l.has(&[&a], "20.0.1").map(|x| x.map(|r| r.version.as_str())), Some(Some("3.0.0")));
        assert_eq!(l.has(&[&b], "20.0.1").map(|x| x.is_some()), Some(false));
    }

    #[test]
    fn versions_outside_the_index_are_placed_by_prefix_or_left_to_the_old_rule() {
        let i = next_like();
        let l = Lines::new(&i);
        let a = rel("15.0.5");
        // 15.0.2 (before the window): line 15.0, numerically below the release.
        assert_eq!(l.has(&[&a], "15.0.2").map(|x| x.is_some()), Some(false));
        assert_eq!(l.has(&[&a], "15.0.9").map(|x| x.is_some()), Some(true));
        // 15.4.7 (a line the window does not hold): no release there, start unknown.
        assert_eq!(l.has(&[&a], "15.4.7").map(|x| x.is_some()), Some(false));
        // Not numeric dotted, or no index (an older catalog): not decided here.
        assert!(l.has(&[&a], "15.0.5-canary.3").is_none());
        let empty: Vec<IndexRelease> = vec![];
        assert!(Lines::new(&empty).has(&[&a], "15.0.5").is_none());
    }

    #[test]
    fn major_depth_index_behaves_like_the_old_rule_where_it_was_right() {
        let i = idx(&[("6.19.0", "2025-11-01", "6", false), ("7.0.0", "2025-11-19", "7", true), ("7.1.0", "2025-12-01", "7", false), ("6.19.1", "2025-12-05", "6", false)]);
        let l = Lines::new(&i);
        let (a, b) = (rel("6.19.0"), rel("6.19.1"));
        assert_eq!(l.has(&[&a], "7.1.0").map(|x| x.is_some()), Some(true));
        // A 6.x patch published after 7.0.0 is not in 7 (the old rule carried it forward).
        assert_eq!(l.has(&[&b], "7.1.0").map(|x| x.is_some()), Some(false));
        assert_eq!(l.has(&[&b], "6.19.1").map(|x| x.is_some()), Some(true));
    }
}
