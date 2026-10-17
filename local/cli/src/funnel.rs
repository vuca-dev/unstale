//! The relevance funnel at the edge: availability, blocked, the ledger, applied, routing to the three outputs and
//! their order. Computed on every run, never stored.

use semver::Version;
use std::collections::{BTreeMap, BTreeSet};
use unstale_schema::catalog::{Benefit, ChangeType, Release, Surface};
use unstale_schema::ledger::Ledger;

use crate::cache::{Catalog, Rec, TechData};
use crate::ledgerops::{status_name, withholds};
use crate::lines::Lines;
use crate::stack::Stack;
use crate::usage::{self, Hits, Repo, clean_lit};
use crate::util::{normalize_purl, parse_version, purl_name};

/// The share of its rarity weight a literal keeps when every file it matched is outside the technology's
/// application code (tests, tooling, docs, examples; roles per `usage::Repo::role_for`).
const NON_APP_WEIGHT: f64 = 0.5;

/// Where a record ends up for this repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    UpgradeReview,
    ImprovementsPass,
    BumpDigest,
    /// Withheld by the ledger: the status.
    Withheld(&'static str),
    /// A structured prerequisite above the project's supported floor.
    Blocked(String),
    Applied,
    /// Opt-in and available, but no benefit counts here (`none`, or maintainability without its pattern).
    NoBenefit,
    /// Opt-in, arrives with an upgrade: the improvements pass sees it once the project is on that version.
    OptInAfterBump,
    /// Already in the installed version and nothing to adopt (fixes, behaviour changes, past obligations).
    AlreadyIncluded,
    /// Released after the review's target version.
    BeyondTarget,
    /// The project's version for the component cannot be read (a tag, a workspace link).
    VersionUnknown,
}

#[derive(Debug, Clone)]
pub struct Opp<'a> {
    pub rec: &'a Rec,
    pub release: Release,
    pub installed: Version,
    pub target: Version,
    pub route: Route,
    /// 1 breaking and removals, 2 deprecations, 3 behaviour and default changes, 4 everything else.
    pub tier: u8,
    pub score: f64,
    /// Matched literals with up to three files each, sorted.
    pub matched: Vec<(String, Vec<String>)>,
    /// Up to three matched files across all literals, application files first (`usage::Role`), for evidence lines.
    pub files: Vec<String>,
    /// `requires` names something and none of it is in the repository: ordered last.
    pub requires_miss: bool,
    /// Benefits that count here, best first.
    pub benefits: Vec<Benefit>,
    /// The classifier flagged a benefit-versus-none call as borderline on a record with no counting benefit.
    pub borderline_benefit: bool,
    /// For a record the ledger withholds: where it would have gone otherwise (a do-now mark can keep it in view).
    pub withheld_from: Option<Route>,
    /// An obligation whose structured prerequisite the project's supported range does not meet: shown anyway, with
    /// this note (raising the minimum is part of the upgrade, often the obligation itself).
    pub unmet: Option<String>,
}

impl Opp<'_> {
    pub fn id(&self) -> &str {
        &self.rec.r.id
    }
    pub fn component(&self) -> String {
        normalize_purl(&self.release.component)
    }
}

/// The three outputs, ordered, plus every record's route (for "why is this empty").
#[derive(Debug, Default)]
pub struct Outcome<'a> {
    pub opps: Vec<Opp<'a>>,
    pub upgrade: Vec<usize>,
    pub improvements: Vec<usize>,
    /// Per technology: indexes into `opps`, benefit order.
    pub digest: BTreeMap<String, Vec<usize>>,
    /// Technologies of the catalog in this stack.
    pub technologies: Vec<String>,
    /// Per technology: the packages of it this repository uses (npm or PyPI names).
    pub packages: BTreeMap<String, Vec<String>>,
    /// The repository's version of each package it declares, by package URL (advisory ranges are per package).
    pub versions: BTreeMap<String, Version>,
    /// Per technology: manifests on another version of one of its packages than the outputs use, with what a bump
    /// picks up there (`stack::Dep::headline`).
    pub workspaces: BTreeMap<String, Vec<Workspace<'a>>>,
    /// Package URLs whose version differs across manifests: where the outputs' version comes from (directory, source).
    pub headline: BTreeMap<String, (String, String)>,
}

/// Manifests on one version of a package other than the one the outputs use: a workspace with its own lockfile, a
/// library's declared floor. Only the bump digest and the upgrade review's count are computed for it.
#[derive(Debug, Clone)]
pub struct Workspace<'a> {
    pub component: String,
    pub version: Version,
    /// (directory, source), by directory.
    pub dirs: Vec<(String, String)>,
    pub target: Option<Version>,
    /// Records that reach the bump digest or the upgrade review at this version (after the same ledger, prerequisite
    /// and applied checks as the outputs).
    /// (record, route, the release that decides it at this version).
    pub records: Vec<(&'a Rec, Route, String)>,
}

pub fn benefit_rank(b: &Benefit) -> u8 {
    match b {
        Benefit::Security => 0,
        Benefit::Correctness => 1,
        Benefit::Performance => 2,
        Benefit::Cost => 3,
        Benefit::Maintainability => 4,
        Benefit::None => 5,
        Benefit::Other => 6,
    }
}

pub fn tier(r: &Rec) -> u8 {
    match r.r.change_type {
        _ if r.r.breaking => 1,
        ChangeType::Removal => 1,
        ChangeType::Deprecation => 2,
        ChangeType::BehaviorChange | ChangeType::DefaultChange => 3,
        _ => 4,
    }
}

/// Obligations: breaking changes, removals, deprecations, whatever their benefit.
pub fn is_obligation(r: &Rec) -> bool {
    r.r.breaking || matches!(r.r.change_type, ChangeType::Removal | ChangeType::Deprecation)
}

/// Opt-in: an adoption step is needed. The adoption list also names `configuration` and `schema_or_migration`, which are
/// surfaces, not change types; they adopt anyway.
pub fn is_opt_in(r: &Rec) -> bool {
    !is_obligation(r)
        && matches!(r.r.change_type, ChangeType::NewApi | ChangeType::NewOption | ChangeType::StabilityChange | ChangeType::Tooling | ChangeType::Other)
        && r.r.surface != Surface::RuntimeInternal
}

fn line_of(v: &Version) -> String {
    if v.major > 0 { v.major.to_string() } else { format!("0.{}", v.minor) }
}

/// The release that decides availability for a project at `installed`: the one on the installed line; otherwise
/// the newest on an older line (it carried forward); otherwise the oldest on a newer line.
/// The release that decides availability at `installed` and whether it is in `installed` and beyond `target`: by
/// release line from the tech index (lines.rs), the old rule (`pick_release`) where that cannot decide.
fn availability<'r>(lines: &Lines, candidates: &[&'r Release], installed: &Version, target: &Version, picked: (&'r Release, &Version)) -> (&'r Release, bool, bool) {
    let (picked, rv) = picked;
    match lines.has(candidates, &installed.to_string()) {
        Some(Some(r)) => (r, true, false),
        Some(None) => match lines.has(candidates, &target.to_string()) {
            Some(Some(r)) => (r, false, false),
            Some(None) => (picked, false, true),
            None => (picked, false, rv > target),
        },
        None => (picked, rv <= installed, rv > target),
    }
}

/// Where a record goes from its availability alone, before the ledger, prerequisites, applied and benefit checks.
fn base_route(rec: &Rec, available: bool, beyond: bool) -> Route {
    if !available && beyond {
        Route::BeyondTarget
    } else if !available {
        if is_obligation(rec) {
            Route::UpgradeReview
        } else if is_opt_in(rec) {
            Route::OptInAfterBump
        } else {
            Route::BumpDigest
        }
    } else if is_opt_in(rec) {
        Route::ImprovementsPass
    } else {
        Route::AlreadyIncluded
    }
}

pub fn pick_release<'r>(releases: &[&'r Release], installed: &Version) -> Option<(&'r Release, Version)> {
    let mut parsed: Vec<(&Release, Version)> = releases.iter().filter_map(|r| parse_version(&r.version).map(|v| (*r, v))).collect();
    parsed.sort_by(|a, b| a.1.cmp(&b.1));
    let line = line_of(installed);
    let rel_line = |r: &Release, v: &Version| if r.line.is_empty() { line_of(v) } else { r.line.clone() };
    if let Some(x) = parsed.iter().find(|(r, v)| rel_line(r, v) == line) {
        return Some(x.clone());
    }
    if let Some(x) = parsed.iter().rev().find(|(_, v)| v <= installed) {
        return Some(x.clone());
    }
    parsed.into_iter().next()
}

pub struct Input<'a> {
    pub catalog: &'a Catalog,
    pub stack: &'a Stack,
    pub repo: &'a Repo,
    pub ledger: &'a Ledger,
    pub today: &'a str,
    /// `--target <pkg>@<version>`: component package URL → target version.
    pub targets: BTreeMap<String, Version>,
}

fn record_lits(r: &Rec, exclude: &BTreeSet<String>) -> Vec<String> {
    let mut out = vec![];
    for t in r.r.terms.iter().map(|t| &t.0).chain(r.r.replaces.iter()) {
        if let Some(l) = clean_lit(t)
            && !exclude.contains(&l) && !out.contains(&l) {
                out.push(l);
            }
    }
    out
}

/// The literals a technology's records are matched with: per record (`record_lits`, the technology's own package
/// names excluded: they say nothing about which part is used, `fw_spike._hit` refs), plus every `requires` value
/// (usage) and every `introduces` value of at least 6 characters (the applied check).
struct TechLits {
    comps: BTreeSet<String>,
    per_record: Vec<Vec<String>>,
    usage: BTreeSet<String>,
    whole: BTreeSet<String>,
}

fn tech_lits(tech: &str, td: &TechData) -> TechLits {
    let comps: BTreeSet<String> = td.records.iter().flat_map(|r| r.r.releases.iter().map(|x| normalize_purl(&x.component))).collect();
    let mut exclude: BTreeSet<String> = comps.iter().filter_map(|c| purl_name(c)).collect();
    exclude.insert(tech.to_string());
    let per_record: Vec<Vec<String>> = td.records.iter().map(|r| record_lits(r, &exclude)).collect();
    let mut usage: BTreeSet<String> = per_record.iter().flatten().cloned().collect();
    let mut whole = BTreeSet::new();
    for r in &td.records {
        usage.extend(r.r.requires.iter().filter_map(|x| clean_lit(x)));
        whole.extend(r.r.introduces.iter().filter_map(|x| clean_lit(x)).filter(|x| x.chars().count() >= 6));
    }
    TechLits { comps, per_record, usage, whole }
}

pub fn run<'a>(inp: &Input<'a>) -> Outcome<'a> {
    let purls = inp.stack.purls();
    let mut out = Outcome { versions: inp.stack.deps.iter().filter_map(|(p, d)| d.version.clone().map(|v| (normalize_purl(p), v))).collect(), ..Default::default() };
    // In the stack when a record names one of the repository's package URLs.
    let in_stack: Vec<(&String, &TechData, TechLits)> = inp
        .catalog
        .techs
        .iter()
        .map(|(tech, td)| (tech, td, tech_lits(tech, td)))
        .filter(|(_, _, tl)| tl.comps.iter().any(|c| purls.contains(c)))
        .collect();
    // One pass over the repository for every technology: a literal's hits do not depend on the other literals.
    let usage_lits: BTreeSet<String> = in_stack.iter().flat_map(|(_, _, tl)| tl.usage.iter().cloned()).collect();
    let whole_lits: BTreeSet<String> = in_stack.iter().flat_map(|(_, _, tl)| tl.whole.iter().cloned()).collect();
    let hits: Hits = usage::find(inp.repo, &usage_lits, &whole_lits);
    for (tech, td, tl) in &in_stack {
        let (tech, comps, lits) = (*tech, &tl.comps, &tl.per_record);
        let present: Vec<&String> = comps.iter().filter(|c| purls.contains(*c)).collect();
        // Packages that declare this technology: a file's role is judged inside the deepest one containing it.
        let owners: Vec<&str> = inp.stack.packages.iter().filter(|p| p.declared.iter().any(|d| comps.contains(&normalize_purl(d)))).map(|p| p.dir.as_str()).collect();
        let role = |p: &str| inp.repo.role_for(p, &owners);
        // Only this technology's language and shared config/data files evidence it.
        let ecosystem = comps.iter().find_map(|c| c.strip_prefix("pkg:").and_then(|r| r.split('/').next())).unwrap_or("npm").to_string();
        let in_language = |files: Option<&Vec<String>>| -> Vec<String> {
            files.into_iter().flatten().filter(|p| !usage::foreign_code(p, &ecosystem)).cloned().collect()
        };
        out.technologies.push(tech.clone());
        out.packages.insert(tech.clone(), present.iter().filter_map(|c| purl_name(c)).collect());
        let tech_version: Option<Version> = present.iter().filter_map(|c| inp.stack.deps.get(*c).and_then(|d| d.version.clone())).min();
        let mut workspaces: Vec<Workspace> = vec![];
        for c in &present {
            let Some(d) = inp.stack.deps.get(*c) else { continue };
            let others = d.others();
            if let (Some(h), false) = (d.headline(), others.is_empty()) {
                out.headline.insert((*c).clone(), (h.dir.clone(), h.source.clone()));
            }
            for (version, rs) in others {
                let dirs = rs.iter().map(|r| (r.dir.clone(), r.source.clone())).collect();
                workspaces.push(Workspace { component: (*c).clone(), version, dirs, target: None, records: vec![] });
            }
        }
        // Newest release per component: the default target.
        let mut newest: BTreeMap<String, Version> = BTreeMap::new();
        for r in &td.records {
            for rel in &r.r.releases {
                if let Some(v) = parse_version(&rel.version) {
                    let e = newest.entry(normalize_purl(&rel.component)).or_insert_with(|| v.clone());
                    if v > *e {
                        *e = v;
                    }
                }
            }
        }
        // Term weights: the central sample when there is one, else rarity among the catalog's own terms.
        let n_records = td.records.len() as f64;
        let mut df: BTreeMap<String, f64> = BTreeMap::new();
        let mut sample_count: BTreeMap<String, u32> = BTreeMap::new();
        for (r, ls) in td.records.iter().zip(lits) {
            for l in ls {
                *df.entry(l.clone()).or_default() += 1.0;
            }
            for t in &r.r.terms {
                if let Some(l) = clean_lit(&t.0) {
                    let c = sample_count.entry(l).or_insert(t.1);
                    *c = (*c).max(t.1);
                }
            }
        }
        let n = td.index.sample_n;
        let weight = |l: &str| -> f64 {
            if n > 0 {
                let c = sample_count.get(l).copied().unwrap_or(0).min(n) as f64;
                ((n as f64 + 1.0) / (c + 0.5)).ln()
            } else {
                ((n_records + 1.0) / (df.get(l).copied().unwrap_or(0.0) + 0.5)).ln()
            }
        };
        let lines = Lines::new(&td.index.releases);
        for (rec, ls) in td.records.iter().zip(lits) {
            let rels: Vec<&Release> = rec.r.releases.iter().filter(|x| comps.contains(&normalize_purl(&x.component))).collect();
            let own: Vec<&Release> = rels.iter().copied().filter(|x| purls.contains(&normalize_purl(&x.component))).collect();
            let candidates = if own.is_empty() { rels } else { own };
            let installed_for = |c: &str| inp.stack.deps.get(c).and_then(|d| d.version.clone()).or_else(|| tech_version.clone());
            let Some(installed) = candidates.first().and_then(|r| installed_for(&normalize_purl(&r.component))) else {
                let release = candidates.first().map(|r| (*r).clone());
                if let Some(release) = release {
                    out.opps.push(blank(rec, release, Route::VersionUnknown));
                }
                continue;
            };
            let Some((picked, rv)) = pick_release(&candidates, &installed) else { continue };
            let comp = normalize_purl(&picked.component);
            let target_for = |c: &str, installed: &Version| inp.targets.get(c).cloned().or_else(|| newest.get(c).cloned()).unwrap_or_else(|| installed.clone());
            let target = target_for(&comp, &installed);
            let (release, available, beyond) = availability(&lines, &candidates, &installed, &target, (picked, &rv));
            let matched: Vec<(String, Vec<String>)> = ls
                .iter()
                .filter_map(|l| Some(in_language(hits.usage.get(l))).filter(|f| !f.is_empty()).map(|f| (l.clone(), f.into_iter().take(3).collect())))
                .collect();
            let score = matched
                .iter()
                .map(|(l, _)| {
                    let app = in_language(hits.usage.get(l)).iter().any(|p| role(p) == usage::Role::App);
                    weight(l) * if app { 1.0 } else { NON_APP_WEIGHT }
                })
                .sum::<f64>();
            let mut files: Vec<String> = ls.iter().flat_map(|l| in_language(hits.usage.get(l))).collect();
            files.sort_by_cached_key(|p| (role(p), p.clone()));
            files.dedup();
            files.truncate(3);
            // A `requires` value the change itself introduces is something the upgrade has the project add, not a
            // precondition (absent until adopted), so it never demotes the record (eval/rank/RESULTS.md, follow-up).
            let intro: BTreeSet<String> = rec.r.introduces.iter().filter_map(|x| clean_lit(x)).collect();
            let req: Vec<String> = rec.r.requires.iter().filter_map(|x| clean_lit(x)).filter(|x| !intro.contains(x)).collect();
            let requires_miss = !req.is_empty() && !req.iter().any(|x| hits.used(x));
            let mut opp = Opp {
                rec,
                release: release.clone(),
                installed: installed.clone(),
                target: target.clone(),
                route: Route::AlreadyIncluded,
                tier: tier(rec),
                score,
                matched,
                files,
                requires_miss,
                benefits: vec![],
                borderline_benefit: false,
                withheld_from: None,
                unmet: None,
            };
            // The ledger, prerequisite and applied checks do not depend on the version: shared with `workspaces`.
            let ledger_status = || {
                inp.ledger.entries.iter().find(|e| e.id() == rec.r.id).filter(|e| withholds(e, rec.r.revision, inp.today)).map(status_name)
            };
            let applied = || {
                rec.r.introduces.iter().filter_map(|x| clean_lit(x)).any(|x| in_language(hits.whole.get(&x)).iter().any(|p| usage::counts_as_applied(role(p), p)))
            };
            opp.route = base_route(rec, available, beyond);
            let shown = matches!(opp.route, Route::UpgradeReview | Route::ImprovementsPass | Route::BumpDigest);
            if shown {
                // An obligation is never blocked: the upgrade brings it whatever the project's floor, and a record that
                // raises a minimum (Node, TypeScript) is exactly the one a floor below it must see.
                let b = blocked(rec, inp.stack, &comp);
                if let Some(b) = b.clone().filter(|_| !(opp.route == Route::UpgradeReview && is_obligation(rec))) {
                    opp.route = Route::Blocked(b);
                } else if let Some(s) = ledger_status() {
                    opp.withheld_from = Some(opp.route.clone());
                    opp.route = Route::Withheld(s);
                }
                if opp.route == Route::UpgradeReview {
                    opp.unmet = b;
                }
            }
            // Applied: an introduced literal as a whole token; never for a breaking change.
            if matches!(opp.route, Route::UpgradeReview | Route::ImprovementsPass) && !rec.r.breaking && applied() {
                opp.route = Route::Applied;
            }
            // The same record for each manifest on another version of its package: only what reaches the bump digest
            // or the upgrade review is kept, for the digest's per-workspace lines.
            let first_comp = candidates.first().map(|r| normalize_purl(&r.component));
            for w in workspaces.iter_mut().filter(|w| Some(&w.component) == first_comp.as_ref()) {
                let Some((picked, rv)) = pick_release(&candidates, &w.version) else { continue };
                let comp = normalize_purl(&picked.component);
                let target = target_for(&comp, &w.version);
                let (decides, available, beyond) = availability(&lines, &candidates, &w.version, &target, (picked, &rv));
                let route = base_route(rec, available, beyond);
                if !matches!(route, Route::UpgradeReview | Route::BumpDigest) {
                    continue;
                }
                let blocks = blocked(rec, inp.stack, &comp).is_some() && !(route == Route::UpgradeReview && is_obligation(rec));
                if blocks || ledger_status().is_some() || (route == Route::UpgradeReview && !rec.r.breaking && applied()) {
                    continue;
                }
                w.target.get_or_insert(target);
                w.records.push((rec, route, decides.version.clone()));
            }
            if opp.route == Route::ImprovementsPass {
                let replaces_here = rec.r.replaces.iter().filter_map(|x| clean_lit(x)).any(|x| !in_language(hits.usage.get(&x)).is_empty());
                let mut b: Vec<Benefit> = rec
                    .r
                    .benefit
                    .iter()
                    .copied()
                    .filter(|b| !matches!(b, Benefit::None | Benefit::Other))
                    .filter(|b| *b != Benefit::Maintainability || replaces_here)
                    .collect();
                b.sort_by_key(benefit_rank);
                b.dedup();
                if b.is_empty() {
                    if rec.borderline.iter().any(|x| x.starts_with("benefit")) {
                        opp.borderline_benefit = true;
                    } else {
                        opp.route = Route::NoBenefit;
                    }
                }
                opp.benefits = b;
            } else {
                let mut b = rec.r.benefit.clone();
                b.sort_by_key(benefit_rank);
                b.dedup();
                opp.benefits = b;
            }
            out.opps.push(opp);
        }
        workspaces.retain(|w| !w.records.is_empty());
        if !workspaces.is_empty() {
            out.workspaces.insert(tech.clone(), workspaces);
        }
    }
    order(&mut out);
    out
}

fn blank<'a>(rec: &'a Rec, release: Release, route: Route) -> Opp<'a> {
    Opp {
        rec,
        release,
        installed: Version::new(0, 0, 0),
        target: Version::new(0, 0, 0),
        route,
        tier: tier(rec),
        score: 0.0,
        matched: vec![],
        files: vec![],
        requires_miss: false,
        benefits: vec![],
        borderline_benefit: false,
        withheld_from: None,
        unmet: None,
    }
}

/// A structured npm prerequisite above the project's floor, or below a declared maximum. Names the project cannot
/// answer (another ecosystem, a package it does not declare) fail open: never block the record.
pub(crate) fn blocked(rec: &Rec, stack: &Stack, component: &str) -> Option<String> {
    for p in &rec.r.prerequisites {
        if !p.ecosystem.eq_ignore_ascii_case("npm") {
            continue;
        }
        if normalize_purl(&crate::util::npm_purl(&p.name.to_lowercase())) == component {
            continue; // the upgrade itself satisfies it
        }
        let Some(have) = stack.npm_version(&p.name) else { continue };
        if let Some(min) = p.min.as_deref().and_then(parse_version)
            && *have < min {
                return Some(format!("needs {} >= {}, project supports {}", p.name, p.min.as_deref().unwrap_or(""), have));
            }
        if let Some(max) = p.max.as_deref().and_then(parse_version)
            && *have > max {
                return Some(format!("needs {} <= {}, project uses {}", p.name, p.max.as_deref().unwrap_or(""), have));
            }
    }
    None
}

fn cmp_score(a: f64, b: f64) -> std::cmp::Ordering {
    b.total_cmp(&a)
}

fn order(out: &mut Outcome) {
    let opps = &out.opps;
    // Upgrade review: records whose `requires` match nothing last, then type tier, then rarity-weighted usage.
    // Applicability variants inside tier 1 were measured and not adopted (eval/rank/RESULTS.md); `requires` values
    // the record introduces are not preconditions (set in `run`).
    let mut up: Vec<usize> = (0..opps.len()).filter(|&i| opps[i].route == Route::UpgradeReview).collect();
    up.sort_by(|&a, &b| {
        let (x, y) = (&opps[a], &opps[b]);
        (x.requires_miss, x.tier)
            .cmp(&(y.requires_miss, y.tier))
            .then(cmp_score(x.score, y.score))
            .then_with(|| x.id().cmp(y.id()))
    });
    out.upgrade = siblings_together(opps, up);
    // Improvements pass: borderline last, then best benefit, then usage.
    let mut imp: Vec<usize> = (0..opps.len()).filter(|&i| opps[i].route == Route::ImprovementsPass).collect();
    let best = |o: &Opp| o.benefits.first().map(benefit_rank).unwrap_or(9);
    imp.sort_by(|&a, &b| {
        let (x, y) = (&opps[a], &opps[b]);
        (x.borderline_benefit, best(x))
            .cmp(&(y.borderline_benefit, best(y)))
            .then(cmp_score(x.score, y.score))
            .then_with(|| x.id().cmp(y.id()))
    });
    out.improvements = imp;
    // Bump digest: per technology, security first, then by benefit, then version.
    let mut dg: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, o) in opps.iter().enumerate() {
        if o.route == Route::BumpDigest {
            dg.entry(o.rec.r.technology.clone()).or_default().push(i);
        }
    }
    for v in dg.values_mut() {
        v.sort_by(|&a, &b| {
            let (x, y) = (&opps[a], &opps[b]);
            let k = |o: &Opp| (!is_security(o), o.benefits.first().map(benefit_rank).unwrap_or(9));
            k(x).cmp(&k(y))
                .then_with(|| parse_version(&x.release.version).cmp(&parse_version(&y.release.version)))
                .then_with(|| x.id().cmp(y.id()))
        });
    }
    out.digest = dg;
}

pub fn is_security(o: &Opp) -> bool {
    is_security_rec(o.rec)
}

pub fn is_security_rec(r: &Rec) -> bool {
    r.r.change_type == ChangeType::Security || r.r.benefit.contains(&Benefit::Security)
}

/// Records sharing a release and a matched or listed term follow each other within their tier.
fn siblings_together(opps: &[Opp], order: Vec<usize>) -> Vec<usize> {
    let terms = |o: &Opp| -> BTreeSet<String> { o.rec.r.terms.iter().filter_map(|t| clean_lit(&t.0)).collect() };
    let mut placed = vec![false; order.len()];
    let mut out = Vec::with_capacity(order.len());
    for i in 0..order.len() {
        if placed[i] {
            continue;
        }
        placed[i] = true;
        let a = &opps[order[i]];
        out.push(order[i]);
        let ta = terms(a);
        for j in i + 1..order.len() {
            let b = &opps[order[j]];
            if placed[j] || (b.requires_miss, b.tier) != (a.requires_miss, a.tier) {
                continue;
            }
            let same_release = a.component() == b.component() && a.release.version == b.release.version;
            if same_release && !ta.is_disjoint(&terms(b)) {
                placed[j] = true;
                out.push(order[j]);
            }
        }
    }
    out
}

/// Plain-language counts of where records went, for an empty or short output.
pub fn why(out: &Outcome, routes: &[&str]) -> String {
    let mut c: BTreeMap<String, usize> = BTreeMap::new();
    let mut withheld: BTreeMap<&str, usize> = BTreeMap::new();
    for o in &out.opps {
        let k = match &o.route {
            Route::UpgradeReview => "upgrade review",
            Route::ImprovementsPass => "improvements pass",
            Route::BumpDigest => "bump digest",
            Route::Withheld(s) => {
                *withheld.entry(s).or_default() += 1;
                continue;
            }
            Route::Blocked(_) => "blocked by a prerequisite the project's supported range does not meet",
            Route::Applied => "already applied in the code",
            Route::NoBenefit => "opt-in with no benefit that counts here (benefit `none`; available on request)",
            Route::OptInAfterBump => "opt-in, available after an upgrade",
            Route::AlreadyIncluded => "already in the installed version with nothing to adopt",
            Route::BeyondTarget => "released after the target version",
            Route::VersionUnknown => "not applicable: the installed version could not be read",
        };
        *c.entry(k.to_string()).or_default() += 1;
    }
    let mut parts = vec![];
    if !withheld.is_empty() {
        let n: usize = withheld.values().sum();
        let detail: Vec<String> = withheld.iter().map(|(s, n)| format!("{n} {s}")).collect();
        parts.push(format!("{n} withheld by the ledger ({})", detail.join(", ")));
    }
    for (k, n) in &c {
        if !routes.contains(&k.as_str()) {
            parts.push(format!("{n} {k}"));
        }
    }
    if out.technologies.is_empty() {
        return "no catalog technology matches this repository's packages (run `unstale sync`)".into();
    }
    if parts.is_empty() {
        return format!("{} records for {} in the catalog", out.opps.len(), out.technologies.join(", "));
    }
    parts.join("; ")
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use crate::cache::TechData;
    use crate::stack::{Dep, Stack};
    use serde_json::{Value, json};
    use unstale_schema::catalog::{ShardLine, TechIndex};

    pub fn catalog(tech: &str, sample_n: u32, recs: Vec<Value>) -> Catalog {
        let records = recs
            .into_iter()
            .map(|v| {
                let borderline = v
                    .pointer("/classifier/borderline")
                    .and_then(|b| b.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                match serde_json::from_value::<ShardLine>(v).unwrap() {
                    ShardLine::Active(r) => Rec { r, borderline },
                    _ => panic!("not active"),
                }
            })
            .collect();
        let index: TechIndex =
            serde_json::from_value(json!({"schema":1,"technology":tech,"sample_n":sample_n,"checked":"2026-10-15T00:00:00Z","shards":[]})).unwrap();
        let mut c = Catalog::default();
        c.techs.insert(
            tech.into(),
            TechData { index, index_sha: "00".into(), records, merged: Default::default(), retracted: vec![], skipped: 0 },
        );
        c
    }

    pub fn stack(deps: &[(&str, &str)], node: Option<&str>) -> Stack {
        Stack {
            packages: vec![],
            deps: deps
                .iter()
                .map(|(n, v)| {
                    let p = crate::util::npm_purl(n);
                    (p, Dep { version: parse_version(v), source: "test".into(), ..Dep::new(n, true) })
                })
                .collect(),
            node: node.map(|v| (parse_version(v).unwrap(), "engines".into())),
            notes: vec![],
        }
    }

    pub fn repo(files: &[(&str, &str)]) -> Repo {
        let mut r = Repo::default();
        for (p, t) in files {
            r.files.push((p.to_string(), t.to_string()));
            r.names.insert(p.to_string());
            r.names.insert(p.rsplit('/').next().unwrap().to_string());
            r.paths.push(p.to_string());
        }
        r
    }

}

#[cfg(test)]
mod tests {
    use super::fixtures::{catalog, repo, stack};
    use super::*;
    use crate::testcat::{rec, with};
    use serde_json::json;

    fn run_with<'a>(c: &'a Catalog, s: &'a Stack, r: &'a Repo, l: &'a Ledger) -> Outcome<'a> {
        run(&Input { catalog: c, stack: s, repo: r, ledger: l, today: "2026-10-15", targets: BTreeMap::new() })
    }

    fn ids(out: &Outcome, idx: &[usize]) -> Vec<String> {
        idx.iter().map(|&i| out.opps[i].id().to_string()).collect()
    }

    fn route_of<'a>(out: &'a Outcome, id: &str) -> &'a Route {
        &out.opps.iter().find(|o| o.id() == id).unwrap().route
    }

    #[test]
    fn three_outputs_by_what_a_record_asks() {
        let c = catalog(
            "next",
            0,
            vec![
                with(rec("next:fix", "pkg:npm/next", "16.1.0"), json!({"change_type":"fix","benefit":["correctness"]})),
                with(rec("next:sec", "pkg:npm/next", "16.1.0"), json!({"change_type":"security","benefit":["security"]})),
                with(rec("next:beh", "pkg:npm/next", "16.1.0"), json!({"change_type":"behavior_change","benefit":["none"]})),
                with(rec("next:brk", "pkg:npm/next", "16.1.0"), json!({"change_type":"behavior_change","breaking":true,"benefit":["none"]})),
                with(rec("next:dep", "pkg:npm/next", "16.1.0"), json!({"change_type":"deprecation","benefit":["none"]})),
                with(rec("next:new-later", "pkg:npm/next", "16.1.0"), json!({"change_type":"new_api"})),
                with(rec("next:new-now", "pkg:npm/next", "16.0.0"), json!({"change_type":"new_api","benefit":["performance"]})),
                with(rec("next:none-now", "pkg:npm/next", "16.0.0"), json!({"change_type":"new_option","benefit":["none"]})),
                with(rec("next:internal-now", "pkg:npm/next", "16.0.0"), json!({"change_type":"new_api","surface":"runtime_internal"})),
                with(rec("next:old-dep", "pkg:npm/next", "15.0.0"), json!({"change_type":"deprecation"})),
            ],
        );
        let s = stack(&[("next", "16.0.5")], None);
        let r = repo(&[]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        let mut up = ids(&out, &out.upgrade);
        up.sort();
        assert_eq!(up, vec!["next:brk", "next:dep"], "obligations between installed and target, whatever their benefit");
        assert_eq!(ids(&out, &out.improvements), vec!["next:new-now"], "opt-in, available, with a benefit");
        assert_eq!(ids(&out, &out.digest["next"]), vec!["next:sec", "next:fix", "next:beh"], "security first");
        assert_eq!(route_of(&out, "next:none-now"), &Route::NoBenefit, "`none` is left out of the improvements pass");
        assert_eq!(route_of(&out, "next:new-later"), &Route::OptInAfterBump);
        assert_eq!(route_of(&out, "next:internal-now"), &Route::AlreadyIncluded, "runtime_internal arrives with the bump");
        assert_eq!(route_of(&out, "next:old-dep"), &Route::AlreadyIncluded);
    }

    #[test]
    fn upgrade_review_orders_by_tier_then_rarity_weighted_usage_and_requires_last() {
        let c = catalog(
            "prisma",
            0,
            vec![
                with(rec("prisma:beh-used", "pkg:npm/prisma", "7.0.0"), json!({"change_type":"behavior_change","breaking":false,"terms":[["rareTermOne",0]]})),
                with(rec("prisma:dep-unused", "pkg:npm/prisma", "7.0.0"), json!({"change_type":"deprecation"})),
                with(rec("prisma:brk-common", "pkg:npm/prisma", "7.0.0"), json!({"change_type":"removal","terms":[["schema.prisma",0]]})),
                with(rec("prisma:brk-rare", "pkg:npm/prisma", "7.0.0"), json!({"change_type":"removal","terms":[["datasourceUrl",0]]})),
                with(rec("prisma:brk-other", "pkg:npm/prisma", "7.0.0"), json!({"change_type":"other","breaking":true,"terms":[["schema.prisma",0]]})),
                with(rec("prisma:brk-oracle", "pkg:npm/prisma", "7.0.0"), json!({"change_type":"removal","requires":["oracledb"],"terms":[["datasourceUrl",0]]})),
                with(rec("prisma:dep-used", "pkg:npm/prisma", "7.0.0"), json!({"change_type":"deprecation","terms":[["schema.prisma",0]]})),
            ],
        );
        let s = stack(&[("prisma", "6.19.0")], None);
        let r = repo(&[("prisma/schema.prisma", "datasource db {}"), ("src/db.ts", "new PrismaClient({ datasourceUrl })")]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        // behaviour change is not an obligation unless breaking: digest.
        assert_eq!(route_of(&out, "prisma:beh-used"), &Route::BumpDigest);
        assert_eq!(
            ids(&out, &out.upgrade),
            vec!["prisma:brk-rare", "prisma:brk-common", "prisma:brk-other", "prisma:dep-used", "prisma:dep-unused", "prisma:brk-oracle"],
            "tier 1 by rarity (datasourceUrl in 2 records beats schema.prisma in 3), tier 2, `requires` matching nothing last"
        );
        let rare = out.opps.iter().find(|o| o.id() == "prisma:brk-rare").unwrap();
        assert_eq!(rare.matched, vec![("datasourceUrl".to_string(), vec!["src/db.ts".to_string()])]);
    }

    #[test]
    fn requires_that_the_change_introduces_does_not_demote() {
        let c = catalog(
            "nestjs",
            0,
            vec![
                // The upgrade has the project switch to graphql-ws: not a precondition.
                with(rec("nestjs:ws", "pkg:npm/@nestjs/core", "12.0.0"), json!({"change_type":"removal","requires":["graphql-ws"],"introduces":["graphql-ws"]})),
                // Only for NATS users; this project has none: last.
                with(rec("nestjs:nats", "pkg:npm/@nestjs/core", "12.0.0"), json!({"change_type":"removal","requires":["natsClient"]})),
                with(rec("nestjs:dep", "pkg:npm/@nestjs/core", "12.0.0"), json!({"change_type":"deprecation"})),
            ],
        );
        let s = stack(&[("@nestjs/core", "11.1.0")], None);
        let r = repo(&[("src/app.ts", "GraphQLModule.forRoot({ subscriptions: {} })")]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(ids(&out, &out.upgrade), vec!["nestjs:ws", "nestjs:dep", "nestjs:nats"]);
        assert!(!out.opps.iter().find(|o| o.id() == "nestjs:ws").unwrap().requires_miss);
    }

    #[test]
    fn central_sample_weights_are_used_when_present() {
        let c = catalog(
            "next",
            5,
            vec![
                with(rec("next:a", "pkg:npm/next", "16.1.0"), json!({"change_type":"deprecation","terms":[["useCommon",5]]})),
                with(rec("next:b", "pkg:npm/next", "16.1.0"), json!({"change_type":"deprecation","terms":[["useRare",0]]})),
            ],
        );
        let s = stack(&[("next", "16.0.0")], None);
        let r = repo(&[("a.ts", "useCommon(); useRare();")]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(ids(&out, &out.upgrade), vec!["next:b", "next:a"]);
        let a = out.opps.iter().find(|o| o.id() == "next:a").unwrap();
        assert!((a.score - (6.0f64 / 5.5).ln()).abs() < 1e-9);
    }

    #[test]
    fn usage_text_includes_package_json_scripts() {
        let c = catalog(
            "next",
            0,
            vec![
                with(rec("next:lint", "pkg:npm/next", "16.0.0"), json!({"change_type":"removal","terms":[["next lint",0]]})),
                with(rec("next:other", "pkg:npm/next", "16.0.0"), json!({"change_type":"removal","terms":[["somethingElse",0]]})),
            ],
        );
        let s = stack(&[("next", "15.5.0")], None);
        let r = repo(&[("package.json", "{\"scripts\":{\"lint\":\"next lint --fix\"}}")]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(ids(&out, &out.upgrade), vec!["next:lint", "next:other"]);
    }

    #[test]
    fn applied_check_whole_tokens_and_never_drops_breaking() {
        let c = catalog(
            "next",
            0,
            vec![
                with(rec("next:applied", "pkg:npm/next", "16.0.0"), json!({"introduces":["updateTag"]})),
                with(rec("next:prefix-only", "pkg:npm/next", "16.0.0"), json!({"introduces":["cacheLife"]})),
                with(rec("next:short", "pkg:npm/next", "16.0.0"), json!({"introduces":["after"]})),
                with(rec("next:brk-new", "pkg:npm/next", "16.0.0"), json!({"change_type":"new_option","breaking":true,"introduces":["proxyConfig"],"replaces":["oldConfig"]})),
            ],
        );
        let s = stack(&[("next", "16.0.0")], None);
        let r = repo(&[("a.ts", "updateTag('x'); cacheLifeProfile(); after(); proxyConfig")]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "next:applied"), &Route::Applied);
        assert_eq!(route_of(&out, "next:prefix-only"), &Route::ImprovementsPass, "cacheLifeProfile is not cacheLife");
        assert_eq!(route_of(&out, "next:short"), &Route::ImprovementsPass, "literals under 6 characters are not used");
        // A breaking record at the installed version is an obligation already passed; and at a newer version it
        // stays in the upgrade review even when its introduced literal is present.
        let s2 = stack(&[("next", "15.0.0")], None);
        let out2 = run_with(&c, &s2, &r, &l);
        assert_eq!(route_of(&out2, "next:brk-new"), &Route::UpgradeReview);
    }

    #[test]
    fn improvements_order_benefit_then_usage_and_maintainability_gate() {
        let c = catalog(
            "next",
            0,
            vec![
                with(rec("next:perf-used", "pkg:npm/next", "16.0.0"), json!({"benefit":["performance"],"terms":[["useThing",0]]})),
                with(rec("next:perf-unused", "pkg:npm/next", "16.0.0"), json!({"benefit":["performance"]})),
                with(rec("next:sec", "pkg:npm/next", "16.0.0"), json!({"benefit":["security","performance"]})),
                with(rec("next:corr", "pkg:npm/next", "16.0.0"), json!({"benefit":["correctness"]})),
                with(rec("next:maint-here", "pkg:npm/next", "16.0.0"), json!({"benefit":["maintainability"],"replaces":["legacyHelper"]})),
                with(rec("next:maint-absent", "pkg:npm/next", "16.0.0"), json!({"benefit":["maintainability"],"replaces":["notHereAtAll"]})),
                with(
                    rec("next:borderline", "pkg:npm/next", "16.0.0"),
                    json!({"benefit":["none"],"classifier":{"classifier":"jev","model":"m","change_type":0.9,"surface":0.9,"breaking":0.1,"benefit":[],"borderline":["benefit:performance"]}}),
                ),
            ],
        );
        let s = stack(&[("next", "16.0.1")], None);
        let r = repo(&[("a.ts", "useThing(); legacyHelper();")]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(
            ids(&out, &out.improvements),
            vec!["next:sec", "next:corr", "next:perf-used", "next:perf-unused", "next:maint-here", "next:borderline"]
        );
        assert_eq!(route_of(&out, "next:maint-absent"), &Route::NoBenefit);
        assert!(out.opps.iter().find(|o| o.id() == "next:borderline").unwrap().borderline_benefit);
    }

    #[test]
    fn availability_uses_the_installed_line_and_library_floor() {
        // Backported fix: 15.5.3 on line 15 and 16.0.2 on line 16.
        let r1 = with(
            rec("next:backport", "pkg:npm/next", "16.0.2"),
            json!({"change_type":"fix","releases":[
                {"component":"pkg:npm/next","version":"15.5.3","date":"2026-01-01","line":"15"},
                {"component":"pkg:npm/next","version":"16.0.2","date":"2026-01-01","line":"16"}]}),
        );
        let c = catalog("next", 0, vec![r1, rec("next:newest", "pkg:npm/next", "16.2.0")]);
        let r = repo(&[]);
        let l = Ledger::default();
        let s = stack(&[("next", "15.5.4")], None);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "next:backport"), &Route::AlreadyIncluded, "on 15.5.4 the line-15 release applies");
        let s = stack(&[("next", "16.0.1")], None);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "next:backport"), &Route::BumpDigest, "on 16.0.1 it arrives with 16.0.2");
        assert_eq!(out.opps.iter().find(|o| o.id() == "next:backport").unwrap().target, Version::new(16, 2, 0), "default target: newest release");
    }

    #[test]
    fn a_workspace_on_another_version_gets_its_own_bump_records() {
        // The root is on 16.1.0; a CI workspace locks 16.0.0 itself. The outputs use the root; the workspace's
        // digest and obligation counts are computed at its own version.
        let c = catalog(
            "next",
            0,
            vec![
                with(rec("next:fix", "pkg:npm/next", "16.0.5"), json!({"change_type":"fix"})),
                with(rec("next:dep", "pkg:npm/next", "16.0.5"), json!({"change_type":"deprecation"})),
                with(rec("next:new", "pkg:npm/next", "16.2.0"), json!({"change_type":"fix"})),
            ],
        );
        let mut s = stack(&[], None);
        let mut d = crate::stack::Dep::new("next", true);
        d.read(".", parse_version("16.1.0"), "pnpm-lock.yaml".into());
        d.read(".buildkite", parse_version("16.0.0"), ".buildkite/package-lock.json".into());
        s.deps.insert(crate::util::npm_purl("next"), d);
        s.settle();
        let (r, l) = (repo(&[]), Ledger::default());
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "next:fix"), &Route::AlreadyIncluded, "the root has it");
        assert_eq!(route_of(&out, "next:new"), &Route::BumpDigest);
        assert_eq!(out.headline["pkg:npm/next"], (".".to_string(), "pnpm-lock.yaml".to_string()));
        let w = &out.workspaces["next"][0];
        assert_eq!((w.version.to_string(), w.dirs[0].0.as_str(), w.target.as_ref().map(|t| t.to_string())), ("16.0.0".into(), ".buildkite", Some("16.2.0".into())));
        let mut got: Vec<(&str, &Route)> = w.records.iter().map(|(r, route, _)| (r.r.id.as_str(), route)).collect();
        got.sort_by_key(|(id, _)| *id);
        assert_eq!(got, vec![("next:dep", &Route::UpgradeReview), ("next:fix", &Route::BumpDigest), ("next:new", &Route::BumpDigest)]);
        let lines = crate::review::digest_lines(&out);
        assert!(lines[0].starts_with("bumping next 16.1.0 → 16.2.0 in the root (pnpm-lock.yaml) picks up 1 fix"), "{lines:?}");
        assert!(lines.contains(&"  16.0.0 in .buildkite (.buildkite/package-lock.json): bumping to 16.2.0 picks up 2 fixes; 1 obligation".to_string()), "{lines:?}");
    }

    #[test]
    fn explicit_target_limits_the_window() {
        let c = catalog(
            "next",
            0,
            vec![
                with(rec("next:a", "pkg:npm/next", "16.1.0"), json!({"change_type":"deprecation"})),
                with(rec("next:b", "pkg:npm/next", "16.2.0"), json!({"change_type":"deprecation"})),
            ],
        );
        let s = stack(&[("next", "16.0.0")], None);
        let (r, l) = (repo(&[]), Ledger::default());
        let mut targets = BTreeMap::new();
        targets.insert("pkg:npm/next".to_string(), Version::new(16, 1, 0));
        let out = run(&Input { catalog: &c, stack: &s, repo: &r, ledger: &l, today: "2026-10-15", targets });
        assert_eq!(ids(&out, &out.upgrade), vec!["next:a"]);
        assert_eq!(route_of(&out, "next:b"), &Route::BeyondTarget);
    }

    #[test]
    fn prerequisites_block_against_supported_floor_and_fail_open() {
        let c = catalog(
            "next",
            0,
            vec![
                with(rec("next:node24", "pkg:npm/next", "16.0.0"), json!({"prerequisites":[{"ecosystem":"npm","name":"node","min":"24.0"}]})),
                with(rec("next:node20", "pkg:npm/next", "16.0.0"), json!({"prerequisites":[{"ecosystem":"npm","name":"node","min":"20.0"}]})),
                with(rec("next:ts", "pkg:npm/next", "16.0.0"), json!({"prerequisites":[{"ecosystem":"npm","name":"typescript","min":"5.1"}]})),
                with(rec("next:pg", "pkg:npm/next", "16.0.0"), json!({"prerequisites":[{"ecosystem":"npm","name":"pg","min":"9"}]})),
                with(rec("next:php", "pkg:npm/next", "16.0.0"), json!({"prerequisites":[{"ecosystem":"composer","name":"php","min":"9"}]})),
            ],
        );
        let s = stack(&[("next", "16.0.0"), ("typescript", "5.0.4")], Some("20.9.0"));
        let (r, l) = (repo(&[]), Ledger::default());
        let out = run_with(&c, &s, &r, &l);
        assert!(matches!(route_of(&out, "next:node24"), Route::Blocked(m) if m.contains("node >= 24.0")));
        assert_eq!(route_of(&out, "next:node20"), &Route::ImprovementsPass);
        assert!(matches!(route_of(&out, "next:ts"), Route::Blocked(_)));
        assert_eq!(route_of(&out, "next:pg"), &Route::ImprovementsPass, "a package the project does not declare fails open");
        assert_eq!(route_of(&out, "next:php"), &Route::ImprovementsPass, "another ecosystem fails open");
    }

    #[test]
    fn an_obligation_that_raises_the_node_minimum_is_never_blocked() {
        let c = catalog(
            "prisma",
            0,
            vec![
                with(rec("prisma:node.js", "pkg:npm/prisma", "7.0.0"), json!({"change_type":"removal","breaking":true,"prerequisites":[{"ecosystem":"npm","name":"node","min":"20.19.0"}]})),
                with(rec("prisma:opt-in", "pkg:npm/prisma", "6.19.0"), json!({"benefit":["performance"],"prerequisites":[{"ecosystem":"npm","name":"node","min":"20.19.0"}]})),
                with(rec("prisma:fix", "pkg:npm/prisma", "7.0.0"), json!({"change_type":"fix","benefit":["correctness"],"prerequisites":[{"ecosystem":"npm","name":"node","min":"20.19.0"}]})),
            ],
        );
        let s = stack(&[("prisma", "6.19.0")], Some("18.18.0"));
        let (r, l) = (repo(&[]), Ledger::default());
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(ids(&out, &out.upgrade), vec!["prisma:node.js"], "the floor raise is the obligation");
        let o = out.opps.iter().find(|o| o.id() == "prisma:node.js").unwrap();
        assert!(o.unmet.as_deref().is_some_and(|m| m.contains("node >= 20.19.0") && m.contains("18.18.0")), "{:?}", o.unmet);
        assert!(matches!(route_of(&out, "prisma:opt-in"), Route::Blocked(_)), "an opt-in record still needs the floor");
        assert!(matches!(route_of(&out, "prisma:fix"), Route::Blocked(_)), "the bump digest is unchanged");
        // On a supported floor there is nothing to note.
        let s = stack(&[("prisma", "6.19.0")], Some("22.0.0"));
        let out = run_with(&c, &s, &r, &l);
        assert!(out.opps.iter().find(|o| o.id() == "prisma:node.js").unwrap().unmet.is_none());
    }

    #[test]
    fn ledger_withholds_until_revision_rises() {
        let c = catalog(
            "next",
            0,
            vec![
                with(rec("next:declined", "pkg:npm/next", "16.1.0"), json!({"change_type":"deprecation","revision":2,"label_version":5})),
                with(rec("next:revised", "pkg:npm/next", "16.1.0"), json!({"change_type":"deprecation","revision":3})),
            ],
        );
        let s = stack(&[("next", "16.0.0")], None);
        let r = repo(&[]);
        let (l, _) = Ledger::parse(
            "{\"schema\":1}\n{\"id\":\"next:declined\",\"rev\":2,\"status\":\"declined\",\"date\":\"2026-10-01\"}\n{\"id\":\"next:revised\",\"rev\":2,\"status\":\"declined\",\"date\":\"2026-10-01\"}\n",
        )
        .unwrap();
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "next:declined"), &Route::Withheld("declined"), "a label_version bump does not re-open");
        assert_eq!(route_of(&out, "next:revised"), &Route::UpgradeReview, "a revision bump re-opens");
        assert!(why(&out, &["upgrade review"]).contains("1 withheld by the ledger (1 declined)"));
    }

    #[test]
    fn siblings_sharing_a_release_and_terms_are_adjacent() {
        let c = catalog(
            "next",
            0,
            vec![
                with(rec("next:mw-a", "pkg:npm/next", "16.0.0"), json!({"change_type":"deprecation","terms":[["middleware.ts",0],["rareOne",0]]})),
                with(rec("next:other", "pkg:npm/next", "16.0.0"), json!({"change_type":"deprecation","terms":[["rareTwo",0]]})),
                with(rec("next:mw-b", "pkg:npm/next", "16.0.0"), json!({"change_type":"deprecation","terms":[["middleware.ts",0]]})),
            ],
        );
        let s = stack(&[("next", "15.0.0")], None);
        let r = repo(&[("a.ts", "rareOne rareTwo")]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        // Scores: mw-a and other tie on one rare match (id order puts mw-a first); mw-b has none, but follows its sibling.
        assert_eq!(ids(&out, &out.upgrade), vec!["next:mw-a", "next:mw-b", "next:other"]);
    }
}
