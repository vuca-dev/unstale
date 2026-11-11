//! Same-or-new matching (central's step E, `central/src/pipeline/match.ts`) and record assembly (`store.ts`,
//! `lines.ts`): up to eight candidates of the same technology, one same-or-new question per candidate, the
//! deterministic guards, and the combine rule. A record id never changes on a match.

use super::extract::Incoming;
use super::js;
use super::labels::{Answers, Labels};
use crate::prompts::{JudgeRules, Prompts};
use regex::Regex;
use serde::Serialize;
use serde_json::value::RawValue;
use std::collections::BTreeSet;
use std::sync::OnceLock;
use unstale_schema::catalog::{
    CapabilityRecord, Evidence, EvidenceKind, Release, SubjectKind, Term,
};

/// Candidates per request (`K`).
pub const K: usize = 8;

/// A record matching can merge into: its fields, and (for one the client made) the extraction keys folded into it.
#[derive(Debug, Clone)]
pub struct Cand<'a> {
    pub rec: &'a CapabilityRecord,
    /// `None` for a catalog record: the catalog does not publish them.
    pub sources: Option<&'a [String]>,
}

const STOP: &str = "the a an and or of to in for on with by from is are be as at this that it its when now can new no not use uses used using support supports supported adds added add";

fn stop() -> &'static BTreeSet<&'static str> {
    static S: OnceLock<BTreeSet<&'static str>> = OnceLock::new();
    S.get_or_init(|| STOP.split(' ').collect())
}

fn regex(cell: &'static OnceLock<Regex>, p: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(p).unwrap())
}

/// `tokens`: lower-case words of two or more letters or digits, camelCase split, stop words out.
pub fn tokens(s: &str) -> BTreeSet<String> {
    static CAMEL: OnceLock<Regex> = OnceLock::new();
    let t = regex(&CAMEL, "([a-z])([A-Z])")
        .replace_all(s, "${1} ${2}")
        .to_lowercase();
    let mut out = BTreeSet::new();
    let mut cur = String::new();
    for c in t.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            cur.push(c);
        } else if !cur.is_empty() {
            if cur.len() > 1 && !stop().contains(cur.as_str()) {
                out.insert(std::mem::take(&mut cur));
            }
            cur.clear();
        }
    }
    out
}

fn jaccard(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let n = a.intersection(b).count();
    n as f64 / (a.len() + b.len() - n) as f64
}

/// `chunkOf`: the extraction call a key came from (`…#{chunk}` of `…#{chunk}.{index}`).
fn chunk_of(key: &str) -> Option<&str> {
    let (head, idx) = key.rsplit_once('.')?;
    if idx.is_empty() || !idx.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (_, chunk) = head.rsplit_once('#')?;
    (!chunk.is_empty() && chunk.bytes().all(|b| b.is_ascii_digit())).then_some(head)
}

fn other_chunk_same_subject(inc: &Incoming, c: &Cand) -> bool {
    let Some(ch) = chunk_of(&inc.key) else {
        return false;
    };
    // A catalog record's extraction keys are not published, so whether the extractor saw it beside the incoming item
    // is unknown: it is treated as seen (excluded, the conservative side; central would exclude it when one of its
    // keys is from the same chunk).
    let Some(sources) = c.sources else {
        return false;
    };
    if sources.iter().any(|k| chunk_of(k).is_none_or(|x| x == ch)) {
        return false;
    }
    c.rec.subject.to_lowercase() == inc.subject.to_lowercase()
        && c.rec.facet.as_deref().unwrap_or("").to_lowercase()
            == inc.facet.as_deref().unwrap_or("").to_lowercase()
}

/// `retrieve`: candidates scored by subject (twice), summary and term overlap and a shared document.
pub fn retrieve<'a>(inc: &Incoming, records: &[Cand<'a>]) -> Vec<(Cand<'a>, f64)> {
    let st = tokens(&format!(
        "{} {}",
        inc.subject,
        inc.facet.as_deref().unwrap_or("")
    ));
    let su = tokens(&inc.summary);
    let terms: BTreeSet<String> = inc.terms.iter().cloned().collect();
    let mut out = vec![];
    for c in records {
        let r = c.rec;
        if r.technology != inc.technology {
            continue;
        }
        if r.evidence.iter().any(|e| e.snapshot == inc.snapshot)
            && !other_chunk_same_subject(inc, c)
        {
            continue;
        }
        let mut score =
            2.0 * jaccard(
                &st,
                &tokens(&format!(
                    "{} {}",
                    r.subject,
                    r.facet.as_deref().unwrap_or("")
                )),
            ) + jaccard(&su, &tokens(&r.summary));
        let rt: BTreeSet<String> = r.terms.iter().map(|t| t.0.clone()).collect();
        score += jaccard(&terms, &rt);
        if r.evidence.iter().any(|e| e.url == inc.url) {
            score += 1.0;
        }
        if score <= 0.0 {
            continue;
        }
        if r.releases.iter().any(|x| x.line == inc.line) {
            score += 0.05;
        }
        out.push((c.clone(), score));
    }
    out.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.rec.id.cmp(&b.0.rec.id))
    });
    out.truncate(K);
    out
}

pub fn kind_str(k: EvidenceKind) -> &'static str {
    match k {
        EvidenceKind::ReleaseNotes => "release_notes",
        EvidenceKind::Docs => "docs",
        EvidenceKind::UpgradeGuide => "upgrade_guide",
        EvidenceKind::Changelog => "changelog",
        EvidenceKind::Advisory => "advisory",
        EvidenceKind::Other => "other",
    }
}

fn kind_of(inc: &Incoming) -> &str {
    inc.kind.as_deref().unwrap_or("release_notes")
}

fn kinds_of(r: &CapabilityRecord) -> BTreeSet<&'static str> {
    r.evidence.iter().map(|e| kind_str(e.kind)).collect()
}

/// `shortRulesApply`.
pub fn short_rules(inc: &Incoming, cands: &[&CapabilityRecord]) -> bool {
    let ik = kind_of(inc);
    if ik != "release_notes" && ik != "upgrade_guide" {
        return false;
    }
    cands.iter().all(|c| {
        kinds_of(c)
            .iter()
            .all(|k| *k == "release_notes" || (*k == "upgrade_guide" && ik == "release_notes"))
    })
}

fn source_name<'a>(p: &'a Prompts, k: &str) -> &'a str {
    let s = &p.judge.sources;
    match k {
        "release_notes" => &s.release_notes,
        "upgrade_guide" => &s.upgrade_guide,
        "docs" => &s.docs,
        "changelog" => &s.changelog,
        "advisory" => &s.advisory,
        _ => &s.other,
    }
}

#[derive(Serialize)]
struct Brief<'a> {
    subject: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    facet: Option<&'a str>,
    breaking: bool,
    release: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    summary: &'a str,
}

#[derive(Serialize)]
struct JudgeState<'a> {
    technology: &'a str,
    incoming: Brief<'a>,
    candidates: Box<RawValue>,
}

/// `matchRequest`: the judge's state (JSON text in central's key order) and its questions; with `scores` and the
/// shorter rules, only candidates at or above the question floor are asked.
pub fn match_request(
    p: &Prompts,
    tech_name: &str,
    inc: &Incoming,
    breaking: bool,
    cands: &[&CapabilityRecord],
    scores: Option<&[f64]>,
) -> (
    Box<RawValue>,
    Vec<(String, crate::inference::ChoiceQuestion)>,
) {
    let ik = kind_of(inc);
    let mixed = ik != "release_notes"
        || cands
            .iter()
            .any(|c| kinds_of(c).iter().any(|k| *k != "release_notes"));
    let names = |r: &CapabilityRecord| {
        let mut v: Vec<&str> = kinds_of(r).iter().map(|k| source_name(p, k)).collect();
        v.sort();
        v.join(", ")
    };
    let mut parts = vec![];
    for (i, c) in cands.iter().enumerate() {
        let mut versions: Vec<&str> = vec![];
        for r in &c.releases {
            if !versions.contains(&r.version.as_str()) {
                versions.push(&r.version);
            }
        }
        let b = Brief {
            subject: &c.subject,
            facet: c.facet.as_deref(),
            breaking: c.breaking,
            release: versions.join(", "),
            source: mixed.then(|| names(c)),
            summary: &c.summary,
        };
        parts.push(format!(
            "\"c{}\":{}",
            i + 1,
            serde_json::to_string(&b).unwrap_or_default()
        ));
    }
    let candidates = RawValue::from_string(format!("{{{}}}", parts.join(","))).expect("JSON");
    let state = JudgeState {
        technology: tech_name,
        incoming: Brief {
            subject: &inc.subject,
            facet: inc.facet.as_deref(),
            breaking,
            release: inc.version.clone(),
            source: mixed.then(|| source_name(p, ik).to_string()),
            summary: &inc.summary,
        },
        candidates,
    };
    let short = short_rules(inc, cands);
    let rules = if short {
        JudgeRules::Short { mixed }
    } else {
        JudgeRules::Long {
            advisory: ik == "advisory",
            mixed,
        }
    };
    let floor = p.thresholds.question_floor;
    let questions = (0..cands.len())
        .filter(|i| !short || scores.is_none_or(|s| s[*i] >= floor))
        .map(|i| {
            let c = format!("c{}", i + 1);
            (format!("same_c{}", i + 1), p.judge.question(&c, rules))
        })
        .collect();
    (
        serde_json::value::to_raw_value(&state).expect("a state serializes"),
        questions,
    )
}

// ---- Guards

fn advisory_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    regex(
        &R,
        r"(?i)(?-u:\b)GHSA(?:-[a-z0-9]{4}){3}(?-u:\b)|(?-u:\b)CVE-[0-9]{4}-[0-9]{4,}(?-u:\b)",
    )
}

pub fn advisory_ids(text: &str) -> BTreeSet<String> {
    advisory_re()
        .find_iter(text)
        .map(|m| m.as_str().to_uppercase())
        .collect()
}

pub fn norm_quote(q: &str) -> String {
    static PR: OnceLock<Regex> = OnceLock::new();
    static HASH: OnceLock<Regex> = OnceLock::new();
    let s = advisory_re().replace_all(q, " ");
    let s = regex(&PR, r"\([\s]*#[0-9]+[\s]*\)").replace_all(&s, " ");
    let s = regex(&HASH, r"#[0-9]+(?-u:\b)").replace_all(&s, " ");
    let s: String = s
        .chars()
        .filter(|c| !matches!(c, '`' | '*' | '_' | '\\'))
        .collect();
    let s = s.to_lowercase();
    let mut out = String::new();
    let mut space = false;
    for c in s.chars() {
        if js::js_space(c) {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(c);
        }
    }
    out
}

/// Ratcliff/Obershelp on UTF-16 units, as central computes it.
pub fn similarity(a: &str, b: &str) -> f64 {
    let a: Vec<u16> = a.encode_utf16().collect();
    let b: Vec<u16> = b.encode_utf16().collect();
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    #[allow(clippy::needless_range_loop)] // the indices are the algorithm's
    fn matched(a: &[u16], b: &[u16], a0: usize, a1: usize, b0: usize, b1: usize) -> usize {
        let (mut best, mut bi, mut bj) = (0, 0, 0);
        let mut prev = vec![0usize; b1 - b0 + 1];
        for i in a0..a1 {
            let mut cur = vec![0usize; b1 - b0 + 1];
            for j in b0..b1 {
                if a[i] == b[j] {
                    let v = prev[j - b0] + 1;
                    cur[j - b0 + 1] = v;
                    if v > best {
                        best = v;
                        bi = i + 1 - v;
                        bj = j + 1 - v;
                    }
                }
            }
            prev = cur;
        }
        if best == 0 {
            return 0;
        }
        best + matched(a, b, a0, bi, b0, bj) + matched(a, b, bi + best, a1, bj + best, b1)
    }
    2.0 * matched(&a, &b, 0, a.len(), 0, b.len()) as f64 / (a.len() + b.len()) as f64
}

fn quote_words(q: &str) -> BTreeSet<String> {
    static R: OnceLock<Regex> = OnceLock::new();
    regex(&R, r"[a-z][a-z0-9_.@/-]*")
        .find_iter(q)
        .map(|m| m.as_str().trim_end_matches(['.', '-', '/']).to_string())
        .filter(|w| !w.is_empty())
        .collect()
}

pub fn near_identical_quote(p: &Prompts, incoming: &str, target: &str) -> bool {
    let (a, b) = (norm_quote(incoming), norm_quote(target));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if !(a.contains(&b) || b.contains(&a) || similarity(&a, &b) >= p.thresholds.quote_similarity) {
        return false;
    }
    let tw = quote_words(&b);
    quote_words(&a).iter().all(|w| tw.contains(w))
}

/// `documentKey`: a document's identity across versions and representations (the last two path segments).
pub fn document_key(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    if scheme.is_empty() || rest.is_empty() {
        return url.to_string();
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let host = rest[..end]
        .rsplit('@')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_lowercase();
    let after = &rest[end..];
    let mut path = if after.starts_with('/') {
        after[..after.find(['?', '#']).unwrap_or(after.len())].to_string()
    } else {
        "/".to_string()
    };
    if host == "github.com" {
        let segs: Vec<&str> = path.splitn(6, '/').collect();
        if segs.len() == 6
            && segs[3] == "blob"
            && !segs[1].is_empty()
            && !segs[2].is_empty()
            && !segs[4].is_empty()
            && !segs[5].is_empty()
        {
            path = format!("/{}", segs[5]);
        }
    }
    static EXT: OnceLock<Regex> = OnceLock::new();
    static ORD: OnceLock<Regex> = OnceLock::new();
    let lower = path.to_lowercase();
    let p = regex(&EXT, r"\.(mdx?|markdown|rst|html?)$").replace(&lower, "");
    let segs: Vec<String> = p
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|x| {
            // `^\d+[-_.](?=\D)`: an ordering prefix followed by a non-digit.
            match regex(&ORD, r"^[0-9]+[-_.]").find(x) {
                Some(m)
                    if x[m.end()..]
                        .chars()
                        .next()
                        .is_some_and(|c| !c.is_ascii_digit()) =>
                {
                    x[m.end()..].to_string()
                }
                _ => x.to_string(),
            }
        })
        .filter(|x| x != "index" && x != "readme")
        .collect();
    segs[segs.len().saturating_sub(2)..].join("/")
}

fn doc_kind(k: &str) -> bool {
    k == "upgrade_guide" || k == "docs"
}

/// `sameLineage`: a later version of a document the candidate cites, for the same release.
pub fn same_lineage(inc: &Incoming, c: &CapabilityRecord) -> bool {
    let kind = kind_of(inc);
    if !doc_kind(kind) || !c.releases.iter().any(|r| r.version == inc.version) {
        return false;
    }
    let key = document_key(&inc.url);
    c.evidence.iter().any(|e| {
        let ek = kind_str(e.kind);
        doc_kind(ek)
            && e.snapshot != inc.snapshot
            && (document_key(&e.url) == key || (kind == "upgrade_guide" && ek == "upgrade_guide"))
    })
}

/// The bars a pick uses.
#[derive(Debug, Clone, Copy)]
pub struct Bars {
    pub same: f64,
    pub cross: f64,
    pub quote_below: f64,
    pub lineage: f64,
}

/// The bars for a request (`thresholds.json`): the shorter rules' or the longer rules'.
pub fn bars(p: &Prompts, short: bool) -> Bars {
    let t = &p.thresholds;
    if short {
        Bars {
            same: t.same_p_short,
            cross: t.cross_same_p_short,
            quote_below: t.quote_guard_below_short,
            lineage: t.lineage_same_p,
        }
    } else {
        Bars {
            same: t.same_p,
            cross: t.cross_same_p,
            quote_below: t.quote_guard_below,
            lineage: t.lineage_same_p,
        }
    }
}

/// `guard`: which deterministic guard blocks a merge judged "same" at `p`.
pub fn guard(
    p: &Prompts,
    inc: &Incoming,
    breaking: bool,
    c: &CapabilityRecord,
    pr: f64,
    b: Bars,
) -> Option<&'static str> {
    if breaking && !c.breaking {
        return Some("guard:breaking");
    }
    let ia = advisory_ids(&format!("{} {}", inc.quote, inc.summary));
    let quotes: Vec<&str> = c.evidence.iter().map(|e| e.quote.as_str()).collect();
    let ca = advisory_ids(&format!("{} {}", quotes.join(" "), c.summary));
    if !ia.is_empty() && !ca.is_empty() && ia.is_disjoint(&ca) {
        return Some("guard:advisory");
    }
    if same_lineage(inc, c) {
        return (pr < b.lineage).then_some("guard:lineage");
    }
    if c.evidence.iter().any(|e| e.snapshot == inc.snapshot) {
        return (pr < b.cross).then_some("guard:cross");
    }
    let kind = kind_of(inc);
    let same: Vec<&Evidence> = c
        .evidence
        .iter()
        .filter(|e| kind_str(e.kind) == kind)
        .collect();
    if same.is_empty() {
        return (pr < b.cross).then_some("guard:cross");
    }
    if pr < b.quote_below
        && !same
            .iter()
            .any(|e| near_identical_quote(p, &inc.quote, &e.quote))
    {
        return Some("guard:quote");
    }
    None
}

/// One candidate's judgement.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
pub struct Judged {
    pub id: String,
    pub p: f64,
    pub outcome: String,
}

/// `pick`: the candidate with the highest p(same) at or above the bar that no guard blocks.
pub fn pick(
    p: &Prompts,
    inc: &Incoming,
    breaking: bool,
    cands: &[&CapabilityRecord],
    a: &Answers,
) -> (Option<(String, f64)>, Vec<Judged>) {
    let b = bars(p, short_rules(inc, cands));
    let mut judged: Vec<Judged> = cands
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let Some(ans) = a.answers.get(&format!("same_c{}", i + 1)) else {
                return Judged {
                    id: c.id.clone(),
                    p: 0.0,
                    outcome: "unasked".into(),
                };
            };
            let pr = ans.probabilities.get("yes").copied().unwrap_or(0.0);
            if pr < b.same {
                return Judged {
                    id: c.id.clone(),
                    p: pr,
                    outcome: "below".into(),
                };
            }
            Judged {
                id: c.id.clone(),
                p: pr,
                // An uncalibrated "yes" (a text model's choice) says nothing of how sure the judge is: every
                // probability-gated guard reads it as 0, so it merges only on a near-identical quote of the same
                // kind, never across kinds or by lineage (central's `pick`).
                outcome: guard(p, inc, breaking, c, if a.calibrated { pr } else { 0.0 }, b)
                    .unwrap_or("same")
                    .into(),
            }
        })
        .collect();
    let mut best: Option<usize> = None;
    for (i, j) in judged.iter().enumerate() {
        if j.outcome == "same" && best.is_none_or(|b| j.p > judged[b].p) {
            best = Some(i);
        }
    }
    for (i, j) in judged.iter_mut().enumerate() {
        if j.outcome == "same" && Some(i) != best {
            j.outcome = "not-best".into();
        }
    }
    (best.map(|i| (judged[i].id.clone(), judged[i].p)), judged)
}

// ---- Releases and record assembly

/// `compareVersions`: numeric parts; a part that is not a number makes the comparison undefined (NaN).
fn cmp_versions(a: &str, b: &str) -> f64 {
    let num = |s: &str| -> Vec<f64> {
        s.split('.')
            .map(|x| {
                if x.is_empty() {
                    0.0
                } else {
                    x.parse::<f64>().unwrap_or(f64::NAN)
                }
            })
            .collect()
    };
    let (pa, pb) = (num(a), num(b));
    for i in 0..pa.len().max(pb.len()) {
        let d = pa.get(i).copied().unwrap_or(0.0) - pb.get(i).copied().unwrap_or(0.0);
        if d != 0.0 {
            return d;
        }
    }
    0.0
}

fn order(d: f64) -> std::cmp::Ordering {
    d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
}

fn earlier(x: &Release, y: &Release) -> bool {
    let c = cmp_versions(&x.version, &y.version);
    c < 0.0 || (c == 0.0 && x.date < y.date)
}

fn upper(r: &Release) -> &str {
    r.no_later_than.as_deref().unwrap_or(&r.version)
}

/// `combineRelease`.
fn combine_release(a: &Release, b: &Release) -> Release {
    if a.no_later_than.is_none() && b.no_later_than.is_none() {
        return if earlier(b, a) { b.clone() } else { a.clone() };
    }
    let exact: Vec<&Release> = [a, b]
        .into_iter()
        .filter(|r| r.no_later_than.is_none())
        .collect();
    let bounded: Vec<&Release> = [a, b]
        .into_iter()
        .filter(|r| r.no_later_than.is_some())
        .collect();
    let mut ups = [upper(a), upper(b)];
    ups.sort_by(|x, y| order(cmp_versions(x, y)));
    let hi = ups[0];
    if let Some(e) = exact.iter().find(|e| {
        bounded
            .iter()
            .all(|x| cmp_versions(&e.version, upper(x)) <= 0.0)
    }) {
        return (*e).clone();
    }
    let lo = if earlier(b, a) { b } else { a };
    let mut base = lo.clone();
    base.no_later_than = (cmp_versions(hi, &lo.version) > 0.0).then(|| hi.to_string());
    base
}

/// `combineByLine`: one release per component and line, the earliest.
pub fn combine_by_line(
    a: &[Release],
    b: &[Release],
    line_of: &dyn Fn(&str) -> String,
) -> Vec<Release> {
    let mut by: Vec<(String, Release)> = vec![];
    for r in a.iter().chain(b) {
        let k = format!("{}\u{0}{}", r.component, line_of(&r.version));
        match by.iter_mut().find(|(x, _)| *x == k) {
            Some((_, prev)) => *prev = combine_release(prev, r),
            None => by.push((k, r.clone())),
        }
    }
    let mut out: Vec<Release> = by.into_iter().map(|(_, r)| r).collect();
    out.sort_by(|x, y| {
        x.component
            .cmp(&y.component)
            .then_with(|| order(cmp_versions(&x.version, &y.version)))
    });
    out
}

/// `lineFn`: the derived line at the index's depth, else the old rule.
pub fn line_fn(index: &unstale_schema::catalog::TechIndex) -> impl Fn(&str) -> String + '_ {
    let depth = index.releases.first().map(|r| r.line.split('.').count());
    move |v: &str| {
        let stable = !v.is_empty()
            && v.split('.')
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
        match depth {
            Some(d) if stable => {
                let parts: Vec<&str> = v.split('.').collect();
                (0..d)
                    .map(|i| {
                        parts
                            .get(i)
                            .map(|p| p.parse::<u64>().unwrap_or(0).to_string())
                            .unwrap_or_else(|| "0".into())
                    })
                    .collect::<Vec<_>>()
                    .join(".")
            }
            _ => js::release_line(v),
        }
    }
}

pub fn releases_of(inc: &Incoming, components: &[String]) -> Vec<Release> {
    components
        .iter()
        .map(|c| Release {
            component: c.clone(),
            version: inc.version.clone(),
            date: inc.date.clone(),
            line: inc.line.clone(),
            no_later_than: inc.no_later_than.clone(),
        })
        .collect()
}

fn evidence_kind(k: &str) -> EvidenceKind {
    serde_json::from_value(serde_json::Value::String(k.into())).unwrap_or(EvidenceKind::Other)
}

pub fn evidence_of(inc: &Incoming) -> Evidence {
    Evidence {
        kind: evidence_kind(kind_of(inc)),
        url: inc.url.clone(),
        section: inc.section.clone(),
        quote: inc.quote.clone(),
        snapshot: inc.snapshot.clone(),
    }
}

fn union(a: &[String], b: &[String]) -> Vec<String> {
    let mut out = a.to_vec();
    for x in b {
        if !out.contains(x) {
            out.push(x.clone());
        }
    }
    out
}

/// `mintId`: `{technology}:{slug}` of the subject and facet; a taken id gets `~2`, `~3`, …
pub fn mint_id(
    technology: &str,
    subject: &str,
    facet: Option<&str>,
    taken: &dyn Fn(&str) -> bool,
) -> String {
    let raw = format!("{subject} {}", facet.unwrap_or("")).to_lowercase();
    let mut slug = String::new();
    for c in raw.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches(|c| c == '-' || c == '.');
    let slug = if slug.is_empty() { "change" } else { slug };
    let base = format!("{technology}:{slug}");
    if !taken(&base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}~{n}"))
        .find(|id| !taken(id))
        .unwrap()
}

/// `create`: a new record from an incoming one and its labels.
pub fn create(
    inc: &Incoming,
    labels: &Labels,
    components: &[String],
    line_of: &dyn Fn(&str) -> String,
    taken: &dyn Fn(&str) -> bool,
) -> CapabilityRecord {
    CapabilityRecord {
        id: mint_id(&inc.technology, &inc.subject, inc.facet.as_deref(), taken),
        technology: inc.technology.clone(),
        revision: 1,
        label_version: 1,
        change_type: labels.change_type,
        breaking: labels.breaking,
        surface: labels.surface,
        subject: inc.subject.clone(),
        subject_kind: if inc.subject_kind == "literal" {
            SubjectKind::Literal
        } else {
            SubjectKind::Concept
        },
        facet: inc.facet.clone(),
        summary: inc.summary.clone(),
        benefit: labels.benefit.clone(),
        releases: combine_by_line(&[], &releases_of(inc, components), line_of),
        prerequisites: inc
            .prerequisites
            .iter()
            .map(|p| unstale_schema::catalog::Prerequisite {
                ecosystem: p.ecosystem.clone(),
                name: p.name.clone(),
                min: p.min.clone(),
                max: p.max.clone(),
            })
            .collect(),
        conditions: inc.conditions.clone(),
        requires: inc.requires.clone(),
        introduces: inc.introduces.clone(),
        terms: inc.terms.iter().map(|t| Term(t.clone(), 0)).collect(),
        replaces: inc.replaces.clone(),
        evidence: vec![evidence_of(inc)],
        related: vec![],
        supersedes: None,
        classifier: Some(labels.classifier.clone()),
        advisories: vec![],
    }
}

/// `combine` with `applyChange`'s counters: evidence and releases added, `breaking` if either, the incoming subject and
/// facet joining the terms; `revision` bumps when a decision field changed, `label_version` when a label field did.
pub fn combine(
    r: &mut CapabilityRecord,
    inc: &Incoming,
    labels: &Labels,
    components: &[String],
    line_of: &dyn Fn(&str) -> String,
) {
    let restated = same_lineage(inc, r) && more_specific(&inc.summary, &r.summary);
    if !r
        .evidence
        .iter()
        .any(|e| e.url == inc.url && e.quote == inc.quote)
    {
        r.evidence.push(evidence_of(inc));
    }
    let mut literal: Vec<String> = vec![];
    if inc.subject_kind == "literal" {
        literal.push(inc.subject.clone());
    }
    if let Some(f) = &inc.facet {
        literal.push(f.clone());
    }
    let old_terms: Vec<String> = r.terms.iter().map(|t| t.0.clone()).collect();
    let terms = union(
        &old_terms,
        &literal
            .into_iter()
            .filter(|t| *t != r.subject)
            .collect::<Vec<_>>(),
    );
    let extra: Vec<String> = inc
        .terms
        .iter()
        .filter(|t| !terms.contains(t))
        .cloned()
        .collect();
    let room = 12usize.saturating_sub(terms.len());
    let new_terms = union(&terms, &extra[..extra.len().min(room)]);
    let benefit = if labels
        .benefit
        .contains(&unstale_schema::catalog::Benefit::None)
    {
        r.benefit.clone()
    } else {
        let mut b: Vec<_> = r
            .benefit
            .iter()
            .copied()
            .filter(|x| *x != unstale_schema::catalog::Benefit::None)
            .collect();
        for x in &labels.benefit {
            if !b.contains(x) {
                b.push(*x);
            }
        }
        b
    };
    let releases = combine_by_line(&r.releases, &releases_of(inc, components), line_of);
    let mut prereqs = r.prerequisites.clone();
    for p in &inc.prerequisites {
        if !prereqs
            .iter()
            .any(|q| q.ecosystem == p.ecosystem && q.name == p.name)
        {
            prereqs.push(unstale_schema::catalog::Prerequisite {
                ecosystem: p.ecosystem.clone(),
                name: p.name.clone(),
                min: p.min.clone(),
                max: p.max.clone(),
            });
        }
    }
    let (replaces, requires) = (
        union(&r.replaces, &inc.replaces),
        union(&r.requires, &inc.requires),
    );
    let revision = releases != r.releases
        || (r.breaking || labels.breaking) != r.breaking
        || prereqs != r.prerequisites
        || requires != r.requires
        || replaces != r.replaces;
    let introduces = union(&r.introduces, &inc.introduces);
    let conditions = union(&r.conditions, &inc.conditions);
    let label = new_terms != old_terms
        || introduces != r.introduces
        || conditions != r.conditions
        || benefit != r.benefit
        || (restated && inc.summary != r.summary);
    r.releases = releases;
    r.breaking = r.breaking || labels.breaking;
    r.terms = new_terms
        .into_iter()
        .map(|t| {
            let n = r.terms.iter().find(|x| x.0 == t).map_or(0, |x| x.1);
            Term(t, n)
        })
        .collect();
    r.replaces = replaces;
    r.requires = requires;
    r.introduces = introduces;
    r.prerequisites = prereqs;
    r.conditions = conditions;
    r.benefit = benefit;
    if restated {
        r.summary = inc.summary.clone();
    }
    if revision {
        r.revision += 1;
    }
    if label {
        r.label_version += 1;
    }
}

/// `finerOrBroader`: same subject with a facet on one side only, or a dotted prefix.
pub fn finer_or_broader(inc: &Incoming, c: &CapabilityRecord) -> bool {
    let (sa, sb) = (inc.subject.to_lowercase(), c.subject.to_lowercase());
    if sa == sb {
        return inc.facet.is_some() != c.facet.is_some();
    }
    (sa.starts_with(&format!("{sb}.")) || sb.starts_with(&format!("{sa}.")))
        && inc.facet.is_none()
        && c.facet.is_none()
}

// ---- moreSpecific (lineage restatements)

const FLIPS: &str = "not no never now longer default defaults enabled disabled enable disable required requires require optional deprecated removed remove must should only always instead unless except cannot can't won't will breaking renamed replaced minimum maximum supported unsupported before after earlier later stable experimental current latest candidate beta alpha preview canary nightly legacy recommended discouraged retired sunset";

fn flips() -> &'static BTreeSet<&'static str> {
    static S: OnceLock<BTreeSet<&'static str>> = OnceLock::new();
    S.get_or_init(|| FLIPS.split(' ').collect())
}

/// `technical`: inline code, flags, calls, dotted, camel or snake identifiers, versions.
fn technical(s: &str) -> BTreeSet<String> {
    static CODE: OnceLock<Regex> = OnceLock::new();
    static TOK: OnceLock<Regex> = OnceLock::new();
    static LINK: OnceLock<Regex> = OnceLock::new();
    let mut out = BTreeSet::new();
    for m in regex(&CODE, "`([^`]+)`").captures_iter(s) {
        out.insert(js::js_trim(&m[1]).to_string());
    }
    let bare = regex(&CODE, "`([^`]+)`").replace_all(s, " ");
    let bare = regex(&LINK, r"\]\([^)]*\)").replace_all(&bare, "]");
    let w = "A-Za-z0-9_";
    let tok = regex(
        &TOK,
        &format!(
            r"--?[a-z][{w}-]+|(?-u:\b)[{w}]+\(\)|(?-u:\b)[a-z]+[A-Z][{w}]*|(?-u:\b)[A-Za-z]+_[{w}]+|(?-u:\b)[A-Za-z_][{w}]*\.[A-Za-z_][{w}.]*(?-u:\b)|(?-u:\b)v?[0-9]+\.[0-9]+(?:\.[0-9]+)?(?-u:\b)"
        ),
    );
    for m in tok.find_iter(&bare) {
        // `(?<![\w-])` before a flag.
        if m.as_str().starts_with('-')
            && bare[..m.start()]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            continue;
        }
        out.insert(m.as_str().to_string());
    }
    out
}

fn specifics(s: &str) -> BTreeSet<String> {
    static NUM: OnceLock<Regex> = OnceLock::new();
    let mut out: BTreeSet<String> = technical(s).into_iter().map(|x| x.to_lowercase()).collect();
    for m in regex(&NUM, r"(?-u:\b)[0-9]+(?:\.[0-9]+)*(?-u:\b)").find_iter(s) {
        out.insert(m.as_str().to_string());
    }
    out
}

fn words_of(s: &str) -> BTreeSet<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

/// `moreSpecific(a, b)`: `a` keeps every specific of `b` and adds one, keeps its meaning-flipping words and half its
/// other words.
pub fn more_specific(a: &str, b: &str) -> bool {
    let (sa, sb) = (specifics(a), specifics(b));
    if !(sa.len() > sb.len() && sb.iter().all(|x| sa.contains(x))) {
        return false;
    }
    let (wa, wb) = (words_of(a), words_of(b));
    if wb
        .iter()
        .any(|w| flips().contains(w.as_str()) && !wa.contains(w))
    {
        return false;
    }
    let content: Vec<&String> = wb
        .iter()
        .filter(|w| w.chars().count() >= 4 && !flips().contains(w.as_str()))
        .collect();
    content.iter().filter(|w| wa.contains(**w)).count() * 2 >= content.len()
}
