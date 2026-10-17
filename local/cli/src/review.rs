//! The generated skill files and their lossless batches (vault: Agent Adapter, "Upgrade review": contents,
//! batches of 16, `--next`, `bump <pkg>`, determinism), and the bump digest text.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use unstale_schema::catalog::ChangeType;

use crate::cache::Catalog;
use crate::funnel::{Opp, Outcome, Route, is_security, why};
use crate::util::{purl_name, write_atomic};

pub const BATCH: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Pass {
    UpgradeReview,
    ImprovementsPass,
}

impl Pass {
    pub const ALL: [Pass; 2] = [Pass::UpgradeReview, Pass::ImprovementsPass];
    pub fn name(self) -> &'static str {
        match self {
            Pass::UpgradeReview => "upgrade-review",
            Pass::ImprovementsPass => "improvements-pass",
        }
    }
    pub fn skill_path(self, tool_dir: &Path) -> PathBuf {
        tool_dir.join("skills").join(self.name()).join("SKILL.md")
    }
    fn queue(self, out: &Outcome) -> Vec<usize> {
        match self {
            Pass::UpgradeReview => out.upgrade.clone(),
            Pass::ImprovementsPass => out.improvements.clone(),
        }
    }
    fn route(self) -> Route {
        match self {
            Pass::UpgradeReview => Route::UpgradeReview,
            Pass::ImprovementsPass => Route::ImprovementsPass,
        }
    }
    fn route_label(self) -> &'static str {
        match self {
            Pass::UpgradeReview => "upgrade review",
            Pass::ImprovementsPass => "improvements pass",
        }
    }
}

impl std::str::FromStr for Pass {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "upgrade-review" => Ok(Pass::UpgradeReview),
            "improvements-pass" => Ok(Pass::ImprovementsPass),
            _ => Err(format!("unknown pass `{s}`: upgrade-review or improvements-pass")),
        }
    }
}

/// Review progress: the batch handed out per pass, its number, and records marked do-now (DECISIONS.md #3).
/// Kept in `.unstale/state/`, which is never committed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct State {
    #[serde(default)]
    pub batches: BTreeMap<String, Batch>,
    /// id → revision marked do-now.
    #[serde(default)]
    pub do_now: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Batch {
    pub number: u32,
    pub ids: Vec<String>,
}

impl State {
    pub fn path(tool_dir: &Path) -> PathBuf {
        tool_dir.join("state/review.json")
    }
    pub fn load(tool_dir: &Path) -> State {
        std::fs::read(Self::path(tool_dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    pub fn save(&self, tool_dir: &Path) -> Result<()> {
        let mut text = serde_json::to_string_pretty(self)?;
        text.push('\n');
        write_atomic(&Self::path(tool_dir), text.as_bytes())
    }
}

/// What one pass shows now.
#[derive(Debug, Clone)]
pub struct View {
    pub pass: Pass,
    pub number: u32,
    /// Indexes into `opps`, in queue order.
    pub batch: Vec<usize>,
    /// Open records in the queue, this batch included.
    pub open: usize,
    /// do-now records still in the queue (not yet applied or recorded done), then do-now records a ledger line
    /// would withhold (a line rewritten onto them by a merge, or from another clone): the mark keeps them in view.
    pub do_now: Vec<usize>,
    /// The handed-out batch is complete and `--next` was not asked for.
    pub complete: bool,
}

/// The batch for a pass. Without `advance`, the current batch is shown (its records still without a
/// disposition); a first batch is handed out when there is none. With `advance`, the next batch is handed out
/// only when every record of the current one has a disposition; otherwise `Err` names the ones missing.
pub fn batch_for(pass: Pass, out: &Outcome, state: &mut State, advance: bool) -> std::result::Result<View, Vec<String>> {
    let queue = pass.queue(out);
    let is_do_now = |i: &usize| {
        let o = &out.opps[*i];
        state.do_now.get(o.id()).is_some_and(|rev| *rev >= o.rec.r.revision)
    };
    let open: Vec<usize> = queue.iter().copied().filter(|i| !is_do_now(i)).collect();
    let mut do_now: Vec<usize> = queue.iter().copied().filter(is_do_now).collect();
    // A do-now mark is the user's latest decision on this record at this revision on this clone (`decide` and
    // `record` on it clear the mark), so a withholding line for it was not written over the mark here: it never hides
    // the record (DECISIONS.md, "A do-now mark wins over a withholding ledger line").
    do_now.extend((0..out.opps.len()).filter(|&i| out.opps[i].withheld_from.as_ref() == Some(&pass.route()) && is_do_now(&i)));
    let cur = state.batches.get(pass.name()).cloned().unwrap_or_default();
    let pending: Vec<usize> = open.iter().copied().filter(|i| cur.ids.iter().any(|x| x == out.opps[*i].id())).collect();
    let fresh = |n: u32| -> (Batch, Vec<usize>) {
        let b: Vec<usize> = open.iter().copied().take(BATCH).collect();
        (Batch { number: n, ids: b.iter().map(|&i| out.opps[i].id().to_string()).collect() }, b)
    };
    let (batch, shown, complete) = if advance {
        if !pending.is_empty() {
            return Err(pending.iter().map(|&i| out.opps[i].id().to_string()).collect());
        }
        let (b, s) = fresh(cur.number + 1);
        (b, s, false)
    } else if cur.ids.is_empty() {
        let (b, s) = fresh(cur.number.max(1));
        (b, s, false)
    } else {
        let complete = pending.is_empty();
        (cur, pending, complete)
    };
    let number = batch.number.max(1);
    state.batches.insert(pass.name().into(), Batch { number, ids: batch.ids });
    Ok(View { pass, number, batch: shown, open: open.len(), do_now, complete })
}

fn md_list<T: AsRef<str>>(xs: &[T]) -> String {
    xs.iter().map(|x| format!("`{}`", x.as_ref())).collect::<Vec<_>>().join(", ")
}

fn change_type(t: ChangeType) -> &'static str {
    match t {
        ChangeType::NewApi => "new API",
        ChangeType::NewOption => "new option",
        ChangeType::BehaviorChange => "behaviour change",
        ChangeType::DefaultChange => "default change",
        ChangeType::Fix => "fix",
        ChangeType::Deprecation => "deprecation",
        ChangeType::Removal => "removal",
        ChangeType::StabilityChange => "stability change",
        ChangeType::Performance => "performance",
        ChangeType::Security => "security",
        ChangeType::Tooling => "tooling",
        ChangeType::Other => "other",
    }
}

fn benefit(b: &unstale_schema::catalog::Benefit) -> &'static str {
    use unstale_schema::catalog::Benefit::*;
    match b {
        Security => "security",
        Correctness => "correctness",
        Performance => "performance",
        Cost => "cost",
        Maintainability => "maintainability",
        None => "none",
        Other => "other",
    }
}

fn pkg_name(o: &Opp) -> String {
    purl_name(&o.release.component).unwrap_or_else(|| o.release.component.clone())
}

fn render_record(pass: Pass, o: &Opp) -> String {
    let r = &o.rec.r;
    let mut s = format!("### [{}] rev {}\n\n", r.id, r.revision);
    s += &format!("{}\n\n", r.summary.trim());
    let pkg = pkg_name(o);
    match pass {
        Pass::UpgradeReview => {
            s += &format!("- Release: {pkg} {} (installed {}, target {})\n", o.release.version, o.installed, o.target)
        }
        Pass::ImprovementsPass => s += &format!("- Release: {pkg} {} (installed {})\n", o.release.version, o.installed),
    }
    s += &format!("- Change: {}; breaking: {}\n", change_type(r.change_type), if r.breaking { "yes" } else { "no" });
    if !o.benefits.is_empty() || pass == Pass::ImprovementsPass {
        let b: Vec<&str> = if o.benefits.is_empty() { r.benefit.iter().map(benefit).collect() } else { o.benefits.iter().map(benefit).collect() };
        s += &format!("- Benefit: {}\n", b.join(", "));
    }
    let pre: Vec<String> = r
        .prerequisites
        .iter()
        .map(|p| {
            let mut x = format!("{} {}", p.ecosystem, p.name);
            if let Some(m) = &p.min {
                x += &format!(" >= {m}");
            }
            if let Some(m) = &p.max {
                x += &format!(" <= {m}");
            }
            x
        })
        .collect();
    s += &format!("- Prerequisites: {}\n", if pre.is_empty() { "none".to_string() } else { pre.join("; ") });
    if !r.conditions.is_empty() {
        s += &format!("- Conditions (not checked by the tool): {}\n", r.conditions.join("; "));
    }
    if let Some(e) = r.evidence.first() {
        s += &format!("- Evidence: {}\n", e.url);
    }
    if o.matched.is_empty() {
        s += "- Matched terms: none\n";
    } else {
        let m: Vec<String> = o.matched.iter().map(|(t, f)| format!("`{t}` ({})", f.join(", "))).collect();
        s += &format!("- Matched terms: {}\n", m.join("; "));
    }
    if let Some(m) = &o.unmet {
        s += &format!("- Prerequisite not met here: {m} (the upgrade raises it; part of this obligation)\n");
    }
    if !r.requires.is_empty() && o.requires_miss {
        s += &format!("- Requires {} (not found in this repository)\n", md_list(&r.requires));
    }
    let mut flags: Vec<String> = o.rec.borderline.clone();
    flags.sort();
    if o.borderline_benefit {
        s += "- Flag: the classifier's call between a benefit and `none` was borderline\n";
    } else if !flags.is_empty() {
        s += &format!("- Borderline labels: {}\n", flags.join(", "));
    }
    s
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// One line per package: "bumping next 16.0.3 → 16.1.2 picks up 4 fixes, 1 security (`unstale bump next`)",
/// then security records inline.
pub fn digest_lines(out: &Outcome) -> Vec<String> {
    let mut lines = vec![];
    // Security records that carry advisories are listed per advisory (`advisory_fixes`), not per record.
    let fixes = advisory_fixes(out);
    let empty = vec![];
    let techs: std::collections::BTreeSet<&String> = out.digest.keys().chain(fixes.keys()).collect();
    for tech in techs {
        let idx = out.digest.get(tech).unwrap_or(&empty);
        let adv = fixes.get(tech).map(Vec::as_slice).unwrap_or(&[]);
        let first = idx.first().map(|&i| &out.opps[i]).unwrap_or_else(|| &out.opps[adv[0].opp]);
        let pkgs = out.packages.get(tech).cloned().unwrap_or_default();
        let name = tech.clone();
        let label = if pkgs.len() == 1 && pkgs[0] == *tech || pkgs.is_empty() { tech.clone() } else { format!("{tech} ({})", pkgs.join(", ")) };
        let mut kinds: BTreeMap<u8, (usize, &str, &str)> = BTreeMap::new();
        for &i in idx {
            let o = &out.opps[i];
            let k = if is_security(o) && !o.rec.r.advisories.is_empty() && !listed_as_record(out, o) {
                continue;
            } else if is_security(o) {
                (0, "security", "security")
            } else {
                match o.rec.r.change_type {
                    ChangeType::Fix => (1, "fix", "fixes"),
                    ChangeType::Performance => (2, "performance change", "performance changes"),
                    ChangeType::BehaviorChange => (3, "behaviour change", "behaviour changes"),
                    ChangeType::DefaultChange => (4, "default change", "default changes"),
                    _ => (5, "other change", "other changes"),
                }
            };
            let e = kinds.entry(k.0).or_insert((0, k.1, k.2));
            e.0 += 1;
        }
        if !adv.is_empty() {
            kinds.entry(0).or_insert((0, "security", "security")).0 += adv.len();
        }
        let parts: Vec<String> = kinds.values().map(|(n, one, many)| plural(*n, one, many)).collect();
        let obligations = out.upgrade.iter().filter(|&&i| out.opps[i].rec.r.technology == *tech).count();
        let extra = if obligations > 0 { format!("; {} in the upgrade review", plural(obligations, "obligation", "obligations")) } else { String::new() };
        lines.push(format!(
            "bumping {label} {} → {} picks up {} (`unstale bump {name}`){extra}",
            first.installed,
            first.target,
            parts.join(", ")
        ));
        for f in adv {
            lines.push(f.line(out));
        }
        for &i in idx {
            let o = &out.opps[i];
            if is_security(o) && (o.rec.r.advisories.is_empty() || listed_as_record(out, o)) {
                lines.push(format!("  security: {} [{}, {}]", o.rec.r.summary.trim(), o.id(), o.release.version));
            }
        }
    }
    lines
}

/// One advisory a bump fixes: the record that describes the fix and the range the installed version is in.
pub struct AdvisoryFix {
    pub opp: usize,
    pub advisory: usize,
    pub patched: Option<String>,
}

impl AdvisoryFix {
    fn line(&self, out: &Outcome) -> String {
        let o = &out.opps[self.opp];
        let a = &o.rec.r.advisories[self.advisory];
        let mut tags = a.aliases.clone();
        tags.extend(a.severity.clone());
        let tags = if tags.is_empty() { String::new() } else { format!(" ({})", tags.join(", ")) };
        let at = self.patched.clone().unwrap_or_else(|| o.release.version.clone());
        let what = if a.summary.trim().is_empty() { o.rec.r.summary.trim() } else { a.summary.trim() };
        format!("  security: {}{tags}: {what} [{}, {at}]", a.id, o.id())
    }
}

/// Whether an advisory affects version `v` of `component`, from the versions central resolved (`Advisory::index`,
/// `AffectedRange::versions`): the edge compares version strings and parses no ranges. `None` (unknown) when the
/// catalog predates resolution, central could not resolve one of the component's ranges, or `v` is not in the release
/// index the ranges were resolved against; the caller then says nothing about the advisory (fail open, never guess).
pub fn advisory_affects(a: &unstale_schema::catalog::Advisory, component: &str, v: &semver::Version) -> Option<bool> {
    let v = v.to_string();
    if !a.index.as_ref()?.contains(&v) {
        return None;
    }
    let mut hit = false;
    for r in a.affected.iter().filter(|r| crate::util::normalize_purl(&r.component) == component) {
        hit |= r.versions.as_ref()?.contains(&v);
    }
    Some(hit)
}

/// What a bump does to one advisory of a record, for the repository's installed versions and the record's target.
enum AdvisoryStatus {
    /// An installed version of an affected package is affected and the target is not; the range's patched version.
    Fixed(Option<String>),
    /// Decided otherwise: not affected, still affected at the target, or no affected package declared.
    NotFixed,
    /// Some declared package's installed or target version is unknown to the resolved index.
    Unknown,
}

fn advisory_status(out: &Outcome, o: &Opp, a: &unstale_schema::catalog::Advisory) -> AdvisoryStatus {
    let mut unknown = false;
    let mut comps: Vec<String> = a.affected.iter().map(|r| crate::util::normalize_purl(&r.component)).collect();
    comps.dedup();
    for c in comps {
        let Some(installed) = out.versions.get(&c) else { continue };
        match (advisory_affects(a, &c, installed), advisory_affects(a, &c, &o.target)) {
            (Some(true), Some(false)) => {
                let iv = installed.to_string();
                let patched = a
                    .affected
                    .iter()
                    .find(|r| crate::util::normalize_purl(&r.component) == c && r.versions.as_ref().is_some_and(|vs| vs.contains(&iv)))
                    .and_then(|r| r.patched.clone());
                return AdvisoryStatus::Fixed(patched);
            }
            (Some(_), Some(_)) => {}
            _ => unknown = true,
        }
    }
    if unknown { AdvisoryStatus::Unknown } else { AdvisoryStatus::NotFixed }
}

/// Whether a security record with advisories is still listed as a record: none of its advisories is listed and at
/// least one is unknown for this repository (an older catalog, an installed version outside the index), so the
/// digest falls back to the record rather than say nothing.
fn listed_as_record(out: &Outcome, o: &Opp) -> bool {
    let st: Vec<AdvisoryStatus> = o.rec.r.advisories.iter().map(|a| advisory_status(out, o, a)).collect();
    !st.iter().any(|s| matches!(s, AdvisoryStatus::Fixed(_))) && st.iter().any(|s| matches!(s, AdvisoryStatus::Unknown))
}

/// Per technology, the advisories that moving each package from its installed to its target version fixes:
/// the installed version is affected and the target is not, from the versions central resolved for the advisory's
/// own ranges (backports included), not from the record's release; packages the repository does not declare are not
/// affected; an unknown version leaves the advisory out. Records the ledger withholds or a prerequisite blocks are
/// left out, as elsewhere.
pub fn advisory_fixes(out: &Outcome) -> BTreeMap<String, Vec<AdvisoryFix>> {
    let mut by: BTreeMap<String, Vec<AdvisoryFix>> = BTreeMap::new();
    let mut seen = std::collections::BTreeSet::new();
    for (oi, o) in out.opps.iter().enumerate() {
        if matches!(o.route, Route::Withheld(_) | Route::Blocked(_) | Route::VersionUnknown) {
            continue;
        }
        for (ai, a) in o.rec.r.advisories.iter().enumerate() {
            if let AdvisoryStatus::Fixed(patched) = advisory_status(out, o, a)
                && seen.insert((o.rec.r.technology.clone(), a.id.clone())) {
                    by.entry(o.rec.r.technology.clone()).or_default().push(AdvisoryFix { opp: oi, advisory: ai, patched });
                }
        }
    }
    for v in by.values_mut() {
        v.sort_by(|x, y| {
            // By the patched version's place in the release index (no version parsing), then id.
            let key = |f: &AdvisoryFix| {
                let a = &out.opps[f.opp].rec.r.advisories[f.advisory];
                let pos = f.patched.as_ref().and_then(|p| a.index.as_ref()?.iter().position(|x| x == p));
                (pos, a.id.clone())
            };
            key(x).cmp(&key(y))
        });
    }
    by
}

/// The records behind one package's digest line, for `unstale bump <pkg>`.
pub fn bump_lines(out: &Outcome, pkg: &str) -> Option<Vec<String>> {
    let comps: Vec<&String> =
        out.digest.keys().filter(|t| *t == pkg || out.packages.get(*t).is_some_and(|p| p.iter().any(|x| x == pkg))).collect();
    if comps.is_empty() {
        return None;
    }
    let mut lines = vec![];
    for c in comps {
        for &i in &out.digest[c] {
            let o = &out.opps[i];
            let b: Vec<&str> = o.benefits.iter().map(benefit).collect();
            lines.push(format!("[{}] {} {} · {} · benefit: {}", o.id(), pkg_name(o), o.release.version, change_type(o.rec.r.change_type), b.join(", ")));
            lines.push(format!("  {}", o.rec.r.summary.trim()));
            if let Some(e) = o.rec.r.evidence.first() {
                lines.push(format!("  {}", e.url));
            }
        }
    }
    Some(lines)
}

const UPGRADE_INSTRUCTIONS: &str = "Each entry below is a verified change from official sources between the version of a dependency this repository has installed and the target version: breaking changes, removals and deprecations, ordered by type, then by how much of this repository they touch. Most may not apply. Do not change any code during the review.

For each entry, look for the code, configuration or files it would affect (start from the matched terms), and check its prerequisites against the versions this project supports.

Report in two sections:

## Proposals
One item per entry that applies: the entry id in square brackets, the files it would touch, what would change, and your own judgement of the benefit, risk and timing. Suggest uses beyond the obvious one where you see them.

## Not applicable
One line per remaining entry: the entry id in square brackets and the reason.

Then give every entry a disposition, so the next batch can follow (the tool validates each one):
- nothing here to apply it to: `unstale record <id> no-site`
- already applied in a way the code cannot show: `unstale record <id> done`
- a proposal: the user decides, then `unstale decide <id> do-now`, `unstale decide <id> later` or `unstale decide <id> decline`";

const IMPROVEMENTS_INSTRUCTIONS: &str = "Each entry below is a verified, opt-in improvement from official sources that is available at the versions this repository already has installed and is not yet applied. Each needs a code or configuration change to take effect and states the benefit its source claims, ordered by benefit (security, correctness, performance, cost, maintainability), then by how much of this repository it touches. Most may not apply. Do not change any code during the review.

For each entry, decide whether this repository would get the stated benefit: look for the code or configuration it would change, check that the situation it improves occurs here, and check its prerequisites against the versions this project supports.

Report in two sections:

## Proposals
One item per entry worth considering: the entry id in square brackets, the files it would touch, what would change, and your own judgement of the benefit, risk and timing. Suggest uses beyond the obvious one where you see them.

## Not applicable
One line per remaining entry: the entry id in square brackets and the reason.

Then give every entry a disposition, so the next batch can follow (the tool validates each one):
- nothing here to apply it to: `unstale record <id> no-site`
- already applied in a way the code cannot show: `unstale record <id> done`
- a proposal: the user decides, then `unstale decide <id> do-now`, `unstale decide <id> later` or `unstale decide <id> decline`";

/// The skill file for one pass. Deterministic: sorted input, no timestamps; the header names the technology
/// index hashes it was built from.
pub fn render(view: &View, out: &Outcome, catalog: &Catalog) -> String {
    let pass = view.pass;
    let mut s = String::new();
    s += "---\n";
    s += &format!("name: {}\n", pass.name());
    s += match pass {
        Pass::UpgradeReview => "description: Reviews this repository against verified breaking changes, removals and deprecations between its installed dependency versions and the upgrade target. Use when the user asks for an upgrade review, before or during a dependency upgrade, or when unstale reports new records for this repository; not on ordinary code changes.\n",
        Pass::ImprovementsPass => "description: Reviews opt-in improvements with a stated benefit (security, correctness, performance, cost, maintainability) that this repository's installed dependency versions already offer. Use when the user asks for an improvements pass or after a dependency upgrade lands; not on ordinary code changes.\n",
    };
    s += "---\n\n";
    s += &format!(
        "<!-- Generated by unstale {}; do not edit (regenerate with `unstale review`). Catalog: {} -->\n\n",
        env!("CARGO_PKG_VERSION"),
        catalog.snapshot_line()
    );
    s += match pass {
        Pass::UpgradeReview => "# Upgrade review\n\n",
        Pass::ImprovementsPass => "# Improvements pass\n\n",
    };
    s += match pass {
        Pass::UpgradeReview => UPGRADE_INSTRUCTIONS,
        Pass::ImprovementsPass => IMPROVEMENTS_INSTRUCTIONS,
    };
    s += "\n\n";
    let total_batches = view.number as usize - 1 + view.open.div_ceil(BATCH).max(1);
    if view.batch.is_empty() {
        if view.complete {
            s += &format!("## Batch {} is complete\n\nEvery record in this batch has a disposition. Run `unstale review --next --pass {}` for the next one.\n", view.number, pass.name());
        } else {
            s += &format!("## Nothing to review\n\nNo records for the {}: {}.\n", pass.route_label(), why(out, &[pass.route_label()]));
        }
    } else {
        s += &format!(
            "## Batch {} of {} ({} open records, {} in this batch)\n\n",
            view.number,
            total_batches,
            view.open,
            view.batch.len()
        );
        for &i in &view.batch {
            s += &render_record(pass, &out.opps[i]);
            s += "\n";
        }
        let after = view.open.saturating_sub(view.batch.len());
        s += "## Next\n\n";
        s += &format!(
            "{} remain after this batch. When every record above has a disposition, run `unstale review --next --pass {}`.\n",
            plural(after, "record", "records"),
            pass.name()
        );
    }
    if !view.do_now.is_empty() {
        s += "\n## Marked do now\n\nApply these, then run `unstale record <id> done` (or the tool sees them applied in the code):\n";
        for &i in &view.do_now {
            let o = &out.opps[i];
            s += &format!("- [{}] {}\n", o.id(), o.rec.r.summary.trim());
            if let Route::Withheld(status) = &o.route {
                s += &format!(
                    "  - The ledger also has a `{status}` line for this record (carried over by a merge, or from another clone). Your do-now mark keeps it here; `unstale decide {} decline` withholds it instead.\n",
                    o.id()
                );
            }
        }
    }
    if pass == Pass::UpgradeReview {
        s += "\n## Bump digest\n\n";
        let d = digest_lines(out);
        if d.is_empty() {
            s += "No fixes, security, performance, behaviour or default changes arrive with a bump.\n";
        } else {
            s += "Changes that arrive with a version bump and ask for no code decision. `unstale bump <pkg>` prints the records behind a line.\n\n";
            for l in d {
                match l.strip_prefix("  ") {
                    Some(x) => s += &format!("  - {x}\n"),
                    None => s += &format!("- {l}\n"),
                }
            }
        }
    }
    s
}

/// Write a skill file if its bytes changed. Returns whether it was written.
pub fn write_skill(path: &Path, text: &str) -> Result<bool> {
    if std::fs::read(path).is_ok_and(|b| b == text.as_bytes()) {
        return Ok(false);
    }
    write_atomic(path, text.as_bytes()).with_context(|| format!("writing {}", path.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::funnel::fixtures::{catalog, repo, stack};
    use crate::funnel::{Input, run};
    use crate::testcat::{rec, with};
    use serde_json::json;
    use unstale_schema::ledger::Ledger;

    fn deprecations(n: usize) -> crate::cache::Catalog {
        let recs = (0..n)
            .map(|i| with(rec(&format!("next:d{i:02}"), "pkg:npm/next", "16.1.0"), json!({"change_type":"deprecation"})))
            .chain([with(rec("next:sec", "pkg:npm/next", "16.1.0"), json!({"change_type":"security","benefit":["security"],"summary":"Fixes a cache poisoning issue."}))])
            .collect();
        catalog("next", 0, recs)
    }

    #[test]
    fn batches_are_lossless_and_advance_only_when_complete() {
        let c = deprecations(20);
        let s = stack(&[("next", "16.0.0")], None);
        let r = repo(&[]);
        let mut ledger = Ledger::default();
        let mut state = State::default();
        let out = run(&Input { catalog: &c, stack: &s, repo: &r, ledger: &ledger, today: "2026-10-15", targets: Default::default() });
        let v = batch_for(Pass::UpgradeReview, &out, &mut state, false).unwrap();
        assert_eq!((v.number, v.batch.len(), v.open), (1, 16, 20));
        // Nothing recorded: --next refuses and names all 16.
        let missing = batch_for(Pass::UpgradeReview, &out, &mut state, true).unwrap_err();
        assert_eq!(missing.len(), 16);
        // Record 15 of them (one declined, one do-now, the rest no-site); one is still missing.
        let ids: Vec<String> = v.batch.iter().map(|&i| out.opps[i].id().to_string()).collect();
        for id in &ids[..14] {
            crate::ledgerops::dispose(&mut ledger, id, 1, crate::ledgerops::Disposition::NoSite, "2026-10-15", None);
        }
        state.do_now.insert(ids[14].clone(), 1);
        let out = run(&Input { catalog: &c, stack: &s, repo: &r, ledger: &ledger, today: "2026-10-15", targets: Default::default() });
        assert_eq!(batch_for(Pass::UpgradeReview, &out, &mut state, true).unwrap_err(), vec![ids[15].clone()]);
        // Without --next the same batch shows only its open record, at the front.
        let v = batch_for(Pass::UpgradeReview, &out, &mut state, false).unwrap();
        assert_eq!(v.batch.iter().map(|&i| out.opps[i].id().to_string()).collect::<Vec<_>>(), vec![ids[15].clone()]);
        assert_eq!(v.do_now.len(), 1);
        crate::ledgerops::dispose(&mut ledger, &ids[15], 1, crate::ledgerops::Disposition::Declined, "2026-10-15", None);
        let out = run(&Input { catalog: &c, stack: &s, repo: &r, ledger: &ledger, today: "2026-10-15", targets: Default::default() });
        let v = batch_for(Pass::UpgradeReview, &out, &mut state, false).unwrap();
        assert!(v.complete && v.batch.is_empty(), "complete, and not advanced without --next");
        let v = batch_for(Pass::UpgradeReview, &out, &mut state, true).unwrap();
        assert_eq!((v.number, v.batch.len(), v.open), (2, 4, 4));
        let text = render(&v, &out, &c);
        assert!(text.contains("## Batch 2 of 2 (4 open records, 4 in this batch)"), "{text}");
        assert!(text.contains("## Marked do now"));
    }

    #[test]
    fn do_now_mark_wins_over_a_decline_rewritten_onto_it_by_a_merge() {
        // `next:a` was declined; the catalog then merged it into `next:b`, which the user had marked do now.
        let mut c = deprecations(2);
        let td = c.techs.get_mut("next").unwrap();
        td.records.retain(|r| r.r.id != "next:d00");
        td.merged.insert("next:d00".into(), "next:d01".into());
        let s = stack(&[("next", "16.0.0")], None);
        let r = repo(&[]);
        let (old, _) = Ledger::parse("{\"schema\":1}\n{\"id\":\"next:d00\",\"rev\":1,\"status\":\"declined\",\"date\":\"2026-10-01\"}\n").unwrap();
        let (ledger, rep) = crate::ledgerops::reconcile(&old, |id| c.lookup(id));
        assert_eq!(rep.rewritten, vec![("next:d00".to_string(), "next:d01".to_string())], "the merge rewrites the line (vault rule)");
        let mut state = State::default();
        state.do_now.insert("next:d01".into(), 1);
        let out = run(&Input { catalog: &c, stack: &s, repo: &r, ledger: &ledger, today: "2026-10-15", targets: Default::default() });
        let b = out.opps.iter().position(|o| o.id() == "next:d01").unwrap();
        assert_eq!(out.opps[b].route, Route::Withheld("declined"));
        let v = batch_for(Pass::UpgradeReview, &out, &mut state, false).unwrap();
        assert_eq!(v.do_now, vec![b], "still shown under 'Marked do now', not silently withheld");
        let text = render(&v, &out, &c);
        assert!(text.contains("## Marked do now"), "{text}");
        assert!(text.contains("- [next:d01] "), "{text}");
        assert!(text.contains("The ledger also has a `declined` line for this record"), "{text}");
        // Without the mark (or once `decide` clears it), the rewritten decline withholds the record as before.
        let mut plain = State::default();
        let v = batch_for(Pass::UpgradeReview, &out, &mut plain, false).unwrap();
        assert!(v.do_now.is_empty() && !render(&v, &out, &c).contains("next:d01"));
        // A mark at an older revision than the record does not count.
        let mut stale = State::default();
        stale.do_now.insert("next:d01".into(), 0);
        assert!(batch_for(Pass::UpgradeReview, &out, &mut stale, false).unwrap().do_now.is_empty());
    }

    #[test]
    fn skill_file_is_deterministic_and_carries_contents() {
        let c = deprecations(2);
        let s = stack(&[("next", "16.0.0")], None);
        let r = repo(&[]);
        let l = Ledger::default();
        let render_once = || {
            let out = run(&Input { catalog: &c, stack: &s, repo: &r, ledger: &l, today: "2026-10-15", targets: Default::default() });
            let mut st = State::default();
            let v = batch_for(Pass::UpgradeReview, &out, &mut st, false).unwrap();
            render(&v, &out, &c)
        };
        let a = render_once();
        assert_eq!(a, render_once(), "byte-identical on rerun");
        assert!(a.starts_with("---\nname: upgrade-review\ndescription: "));
        assert!(a.contains("Catalog: next sha256:00"), "header names the index hashes");
        assert!(a.contains("### [next:d00] rev 1"));
        assert!(a.contains("- Release: next 16.1.0 (installed 16.0.0, target 16.1.0)"));
        assert!(a.contains("- Evidence: https://example.org/next:d00"));
        assert!(a.contains("`unstale record <id> no-site`"));
        assert!(a.contains("0 records remain after this batch. When every record above has a disposition, run `unstale review --next --pass upgrade-review`."));
        assert!(a.contains("- bumping next 16.0.0 → 16.1.0 picks up 1 security (`unstale bump next`); 2 obligations in the upgrade review"));
        assert!(a.contains("  - security: Fixes a cache poisoning issue. [next:sec, 16.1.0]"));
        assert!(!a.contains("2026-10-15"), "no timestamps");
    }

    #[test]
    fn empty_pass_says_why() {
        let c = catalog("next", 0, vec![with(rec("next:a", "pkg:npm/next", "16.0.0"), json!({"benefit":["none"]}))]);
        let s = stack(&[("next", "16.0.0")], None);
        let r = repo(&[]);
        let l = Ledger::default();
        let out = run(&Input { catalog: &c, stack: &s, repo: &r, ledger: &l, today: "2026-10-15", targets: Default::default() });
        let mut st = State::default();
        let v = batch_for(Pass::ImprovementsPass, &out, &mut st, false).unwrap();
        let text = render(&v, &out, &c);
        assert!(text.contains("## Nothing to review\n\nNo records for the improvements pass: 1 opt-in with no benefit that counts here"), "{text}");
    }

    #[test]
    fn bump_lists_records_behind_a_digest_line() {
        let c = deprecations(0);
        let s = stack(&[("next", "16.0.0")], None);
        let r = repo(&[]);
        let l = Ledger::default();
        let out = run(&Input { catalog: &c, stack: &s, repo: &r, ledger: &l, today: "2026-10-15", targets: Default::default() });
        let lines = bump_lines(&out, "next").unwrap();
        assert_eq!(lines[0], "[next:sec] next 16.1.0 · security · benefit: security");
        assert!(bump_lines(&out, "react").is_none());
    }

    #[test]
    fn digest_lists_the_advisories_a_bump_fixes_from_their_resolved_versions() {
        // The release index central resolved the ranges against; `versions` = the index versions each range affects.
        let index = ["15.5.18", "16.1.7", "16.2.1", "16.2.5", "16.2.6", "16.3.0", "16.4.1"];
        let upto = |v: &str| index.iter().filter(|x| x.starts_with("16.")).take_while(|x| **x != v).cloned().collect::<Vec<_>>();
        let adv = |id: &str, comp: &str, range: &str, patched: &str, versions: Vec<&str>| {
            json!({"id": id, "aliases": [], "severity": "high", "summary": format!("Advisory {id}."), "url": "u", "index": index,
                "affected": [{"component": comp, "range": range, "patched": patched, "versions": versions}]})
        };
        let sec = json!({"change_type": "security", "benefit": ["security"]});
        // Fixed on line 16 at 16.2.5: listed for 16.2.1 → 16.4.1.
        let a = with(with(rec("next:a", "pkg:npm/next", "16.2.5"), sec.clone()), json!({"advisories": [adv("GHSA-aaaa-aaaa-aaaa", "pkg:npm/next", ">= 16.0.0, < 16.2.5", "16.2.5", upto("16.2.5"))]}));
        // The record names only the 15.x backport (the funnel takes it as already installed), but the advisory says
        // 16.2.1 is affected: listed.
        let b = with(with(rec("next:b", "pkg:npm/next", "15.5.18"), sec.clone()), json!({"advisories": [
            adv("GHSA-bbbb-bbbb-bbbb", "pkg:npm/next", ">= 16.0.0, < 16.2.6", "16.2.6", upto("16.2.6")),
            // Fixed before the installed version: not listed.
            adv("GHSA-cccc-cccc-cccc", "pkg:npm/next", ">= 16.0.0, < 16.1.7", "16.1.7", vec![]),
            // A package the repository does not declare: not listed.
            adv("GHSA-dddd-dddd-dddd", "pkg:npm/%40next/other", "< 16.3.0", "16.3.0", upto("16.3.0"))]}));
        // Still affected at the target (no fix yet): not listed.
        let c = with(with(rec("next:c", "pkg:npm/next", "16.4.1"), sec.clone()), json!({"advisories": [adv("GHSA-eeee-eeee-eeee", "pkg:npm/next", ">= 16.0.0", "", upto("none"))]}));
        // Unknown, so the record is listed as before (fail open): a catalog before resolution (no index) ...
        let d = with(with(rec("next:d", "pkg:npm/next", "16.3.0"), sec.clone()), json!({"summary": "Old-catalog fix.", "advisories": [
            {"id": "GHSA-ffff-ffff-ffff", "aliases": [], "summary": "s", "url": "u", "affected": [{"component": "pkg:npm/next", "range": ">= 16.0.0, < 16.3.0", "patched": "16.3.0"}]}]}));
        // ... and a range central could not resolve (no `versions`).
        let mut unresolved = adv("GHSA-gggg-gggg-gggg", "pkg:npm/next", "", "", vec![]);
        unresolved["affected"][0].as_object_mut().unwrap().remove("versions");
        let e = with(with(rec("next:e", "pkg:npm/next", "16.3.0"), sec), json!({"summary": "Unresolved fix.", "advisories": [unresolved]}));
        let cat = catalog("next", 0, vec![a, b, c, d, e, rec("next:f", "pkg:npm/next", "16.3.0")]);
        let s = stack(&[("next", "16.2.1")], None);
        let r = repo(&[]);
        let l = Ledger::default();
        let out = run(&Input { catalog: &cat, stack: &s, repo: &r, ledger: &l, today: "2026-10-15", targets: Default::default() });
        let lines = digest_lines(&out);
        let text = lines.join("\n");
        assert!(lines[0].starts_with("bumping next 16.2.1 → 16.4.1 picks up 4 security"), "{text}");
        assert!(text.contains("  security: GHSA-aaaa-aaaa-aaaa (high): Advisory GHSA-aaaa-aaaa-aaaa. [next:a, 16.2.5]"), "{text}");
        assert!(text.contains("  security: GHSA-bbbb-bbbb-bbbb (high): Advisory GHSA-bbbb-bbbb-bbbb. [next:b, 16.2.6]"), "{text}");
        assert!(text.contains("  security: Old-catalog fix. [next:d, 16.3.0]") && text.contains("  security: Unresolved fix. [next:e, 16.3.0]"), "{text}");
        for absent in ["GHSA-cccc", "GHSA-dddd", "GHSA-eeee", "GHSA-ffff", "GHSA-gggg", "Summary of next:a"] {
            assert!(!text.contains(absent), "{absent}: {text}");
        }
        // An installed version outside the index is unknown: nothing said about the advisory.
        let adv_a = &out.opps.iter().find(|o| o.id() == "next:a").unwrap().rec.r.advisories[0];
        assert_eq!(advisory_affects(adv_a, "pkg:npm/next", &semver::Version::parse("16.2.1").unwrap()), Some(true));
        assert_eq!(advisory_affects(adv_a, "pkg:npm/next", &semver::Version::parse("16.2.5").unwrap()), Some(false));
        assert_eq!(advisory_affects(adv_a, "pkg:npm/next", &semver::Version::parse("16.2.2").unwrap()), None);
    }
}
