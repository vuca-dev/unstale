//! The relevance funnel at the edge: availability, blocked, the ledger, applied, routing to the three outputs and
//! their order. Computed on every run, never stored.

use semver::Version;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::rc::Rc;
use unstale_schema::catalog::{Benefit, ChangeType, IndexRelease, Release, Surface};
use unstale_schema::ledger::Ledger;

use crate::cache::{Catalog, Rec, TechData};
use crate::ledgerops::{status_name, withholds};
use crate::lines::Lines;
use crate::stack::{Dep, Reading, Stack, place};
use crate::usage::{self, Hits, Repo, clean_lit};
use crate::util::{normalize_purl, parse_date, parse_version, purl_name};

/// How long before the installed version an opt-in from an older release line becomes part of that version's baseline
/// (`Route::Baseline`): a year. Majors come every few weeks for some technologies (electron) and every few years for
/// others (jsdom), so a count of lines cannot say what is still new; time can.
const BASELINE_DAYS: i64 = 365;

/// The share of its rarity weight a literal keeps when every file it matched is outside the technology's
/// application code (tests, tooling, docs, examples; roles per `usage::Repo::role_for`).
const NON_APP_WEIGHT: f64 = 0.5;

/// A literal's evidence for one technology, memoised (`evidence_of`, or `exact_of` for a deprecated literal).
type Cite<'a> = &'a dyn Fn(&str) -> Rc<usage::Evidence>;

/// Per view (`run`'s evidence views) and literal, memoised.
type Memo<T> = RefCell<HashMap<(usize, String), T>>;

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
    /// Opt-in and installed, but released on an older line than the installed one and at least `BASELINE_DAYS` before
    /// the installed version (jsdom 6.3.0's `window.atob` at 23.0.1): part of what the installed version is, which
    /// every user of it has, not something new to adopt (`baseline`).
    Baseline,
    /// Opt-in and installed, but its `requires` (a package, driver or setting the change applies to) is nowhere in the
    /// repository: nothing here to apply it to (knip's Stencil support without `@stencil/core`).
    RequiresAbsent,
    /// A deprecation released at or below the installed version whose deprecated API (`replaces`) the code still
    /// uses, by the usage rules: outstanding now, with no upgrade (`in_effect_evidence`).
    InEffect,
    /// Already in the installed version and nothing to adopt (fixes, behaviour changes, past obligations whose
    /// deprecated API the code does not show).
    AlreadyIncluded,
    /// Released after the review's target version.
    BeyondTarget,
    /// Released only on lines below the installed version (a backport to an older maintenance line, published after
    /// the installed version): the installed line never receives that release, so it is in no upgrade from here. When
    /// the change also shipped on a newer line, that release (merged into the record, or a record of its own) carries it.
    OlderLine,
    /// The project's version for the component cannot be read (a tag, a workspace link).
    VersionUnknown,
    /// About other packages published from the technology's repository (`TechIndex::components` names the
    /// technology's own), none of which the repository uses: React Server Components items for a client-only app.
    OtherPackage,
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
    /// Up to three matched files across all literals, for evidence lines: files about the technology first (importing
    /// or configuring it), then application files (`usage::Role`), as in `usage::Scope::evidence`.
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
    /// Manifests on another release line (`stack::Reading::fits`) whose code importing the technology matches the
    /// record's terms: those files run another version than `installed`, so they are left out of `matched` and
    /// `files`, and named here instead.
    pub elsewhere: Vec<String>,
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
    /// Deprecations in effect at the installed version and still used here (`Route::InEffect`), by usage, then id.
    pub in_effect: Vec<usize>,
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
    /// Why no technology is covered yet, when the client knows (a deferred registration); set by the caller.
    pub uncovered: Option<String>,
    /// Where the outputs' version follows the code rather than `Dep::headline`, and code left uncited because it runs
    /// another release line (`Choice`): for the report's version sources.
    pub version_notes: Vec<String>,
}

/// The version the outputs use for one package, and the manifests whose code they do not describe.
///
/// The headline (`Dep::headline`) stands unless files import the package and none of them runs the headline's version
/// (`Reading::runs`): then it is the headline among the manifests holding those files. A root
/// devDependency no file imports does not set the version for code that runs another major (udecode/plate: root zod
/// 4.1.12, every importer in apps/www on 3.25.76). Files whose manifest runs another line are not cited either way.
struct Choice<'d> {
    head: &'d Reading,
    /// The headline it replaced, when the code moved it.
    moved: Option<&'d Reading>,
    /// Readings that do not fit `head`: their files are left out of the evidence.
    off: Vec<&'d Reading>,
    /// Of `off`, those whose directory holds code importing the package.
    off_sites: Vec<&'d Reading>,
}

/// The reading whose manifest a file's import resolves to: the deepest one containing it.
fn owner<'d>(d: &'d Dep, path: &str) -> Option<&'d Reading> {
    d.readings.iter().filter(|r| r.contains(path)).max_by_key(|r| if r.dir == "." { 0 } else { r.dir.len() })
}

fn choose<'d>(d: &'d Dep, sites: impl FnOnce() -> Vec<String>) -> Option<Choice<'d>> {
    let h = d.headline()?;
    if d.readings.iter().all(|r| r.fits(&h.version)) {
        return Some(Choice { head: h, moved: None, off: vec![], off_sites: vec![] });
    }
    let held: Vec<&Reading> = {
        let mut v: Vec<&Reading> = sites().iter().filter_map(|p| owner(d, p)).collect();
        v.sort_by(|a, b| a.dir.cmp(&b.dir));
        v.dedup_by(|a, b| a.dir == b.dir);
        v
    };
    let (head, moved) = match held.iter().any(|r| r.runs(&h.version)) || held.is_empty() {
        true => (h, None),
        false => (d.headline_among(|r| held.iter().any(|x| x.dir == r.dir)).unwrap_or(h), Some(h)),
    };
    let off: Vec<&Reading> = d.readings.iter().filter(|r| !r.fits(&head.version)).collect();
    let off_sites = off.iter().copied().filter(|r| held.iter().any(|x| x.dir == r.dir)).collect();
    Some(Choice { head, moved, off, off_sites })
}

/// `hits` for `lits` without the files `off` marks (indices into `Repo::paths`).
fn hits_without<'l>(hits: &Hits, lits: impl IntoIterator<Item = &'l String>, off: &[bool], paths: &[String]) -> Hits {
    let skip: std::collections::HashSet<&str> = paths.iter().zip(off).filter(|(_, o)| **o).map(|(p, _)| p.as_str()).collect();
    let keep = |v: &Vec<String>| -> Vec<String> { v.iter().filter(|p| !skip.contains(p.as_str())).cloned().collect() };
    let mut h = Hits::default();
    for l in lits {
        if let Some(v) = hits.usage.get(l) {
            h.usage.insert(l.clone(), keep(v));
        }
        if let Some(v) = hits.whole.get(l) {
            h.whole.insert(l.clone(), keep(v));
        }
        if let Some(v) = hits.ix.get(l) {
            h.ix.insert(l.clone(), v.iter().copied().filter(|x| !off.get(*x as usize).copied().unwrap_or(false)).collect());
        }
        if let Some(v) = hits.tail_only.get(l) {
            h.tail_only.insert(l.clone(), v.clone());
        }
        if let Some(v) = hits.by_tail.get(l) {
            h.by_tail.insert(l.clone(), v.clone());
        }
    }
    h
}

/// `hits` for one technology when one of its CLI-flag literals (`usage::cli_flag`) occurs in a file only off a command
/// line that runs it (no word of `usage::command_words` on the flag's line, and not a CSS custom property): those files
/// are dropped from the flag's hits. `None` when every flag hit stands, so the shared hits serve as they are.
fn flag_filtered<'l>(hits: &Hits, comps: &BTreeSet<String>, lits: impl IntoIterator<Item = &'l String>, paths: &[String]) -> Option<Hits> {
    let words: BTreeSet<String> = comps.iter().flat_map(|c| usage::command_words(c)).collect();
    let lits: BTreeSet<&String> = lits.into_iter().collect();
    // `paths` is sorted (`Repo::collect`), so a whole-token hit's path finds its index.
    let runs = |l: &str, p: &str| {
        let Ok(x) = paths.binary_search_by(|q| q.as_str().cmp(p)) else { return true };
        hits.flag_lines.get(l).and_then(|f| f.get(&(x as u32))).is_none_or(|ws| ws.iter().any(|w| w == usage::CSS_PROPERTY || words.contains(w)))
    };
    let drop: BTreeMap<&String, std::collections::HashSet<&str>> = lits
        .iter()
        .copied()
        .filter(|l| usage::cli_flag(l))
        .filter_map(|l| {
            let files = hits.usage.get(l).into_iter().chain(hits.whole.get(l)).flatten();
            let bad: std::collections::HashSet<&str> = files.map(String::as_str).filter(|p| !runs(l, p)).collect();
            (!bad.is_empty()).then_some((l, bad))
        })
        .collect();
    if drop.is_empty() {
        return None;
    }
    // Every literal the technology reads, and the ones naming its packages, copied; the flags without the dropped files.
    let naming: BTreeSet<String> = comps.iter().flat_map(|c| usage::naming_lits(c)).collect();
    let mut out = hits_without(hits, lits.iter().copied().chain(&naming), &vec![false; paths.len()], paths);
    for (l, bad) in drop {
        if let Some(v) = out.usage.get_mut(l) {
            v.retain(|p| !bad.contains(p.as_str()));
        }
        if let Some(v) = out.whole.get_mut(l) {
            v.retain(|p| !bad.contains(p.as_str()));
        }
        if let Some(v) = out.ix.get_mut(l) {
            v.retain(|x| paths.get(*x as usize).is_none_or(|p| !bad.contains(p.as_str())));
        }
    }
    out.usage.retain(|_, v| !v.is_empty());
    out.whole.retain(|_, v| !v.is_empty());
    out.ix.retain(|_, v| !v.is_empty());
    Some(out)
}

/// Manifests on one version of a package other than the one the outputs use: a workspace with its own lockfile, an
/// unlocked manifest's declared floor. Only the bump digest and the upgrade review's count are computed for it.
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

/// The literals that name what a deprecation deprecates: its `replaces` among the record's literals (the
/// technology's own package names excluded, as in `record_lits`). `terms` cannot say this: they may name the
/// replacement (a record describing `toHaveBeenCalled` as the successor of `toBeCalled`) or a sibling that is not
/// deprecated (`vitest/node` beside deprecated entry points). Empty for any other record, and for a deprecation
/// without `replaces`.
pub fn deprecated_lits(r: &Rec, lits: &[String]) -> Vec<String> {
    if r.r.change_type != ChangeType::Deprecation {
        return vec![];
    }
    let replaces: BTreeSet<String> = r.r.replaces.iter().filter_map(|x| clean_lit(x)).collect();
    lits.iter().filter(|l| replaces.contains(*l)).cloned().collect()
}

/// Per package (index into `packages`), the packages of this repository that declare it as a dependency: their
/// manifests name its `name` (`Package::own`).
fn dependents(packages: &[crate::stack::Package]) -> Vec<Vec<usize>> {
    let by_own: HashMap<String, usize> = packages.iter().enumerate().filter_map(|(i, p)| p.own.as_deref().map(|o| (normalize_purl(o), i))).collect();
    let mut out = vec![vec![]; packages.len()];
    for (i, p) in packages.iter().enumerate() {
        for d in &p.declared {
            if let Some(&j) = by_own.get(&normalize_purl(d))
                && j != i
            {
                out[j].push(i);
            }
        }
    }
    out
}

/// Directories of the packages that declare one of `comps`, or depend (through the repository's own packages, at any
/// depth: `dependents`) on a package that does: n8n's `packages/cli` gets typescript-eslint from the workspace
/// `@n8n/eslint-config`.
fn reaching<'p>(packages: &'p [crate::stack::Package], dependents: &[Vec<usize>], comps: &BTreeSet<String>) -> Vec<&'p str> {
    let mut has = vec![false; packages.len()];
    let mut todo: Vec<usize> = (0..packages.len()).filter(|&i| packages[i].declared.iter().any(|d| comps.contains(&normalize_purl(d)))).collect();
    while let Some(i) = todo.pop() {
        if !std::mem::replace(&mut has[i], true) {
            todo.extend(dependents[i].iter().copied().filter(|&j| !has[j]));
        }
    }
    packages.iter().zip(has).filter(|(_, h)| *h).map(|(p, _)| p.dir.as_str()).collect()
}

/// The literals that name what replaces a deprecation's deprecated API (`deprecated`): its `introduces`, and its
/// other literals of the same shape as a deprecated one (a module path for a module path, a flag for a flag, a file
/// name for a file name, an identifier for an identifier), neither part of nor containing it, and not plain words or
/// phrases (`react-native/setup-env` for `react-native/Libraries/Core/InitializeCore`; not `InitializeCore`, not
/// `no-restricted-imports` inside `@typescript-eslint/no-restricted-imports`, not the command `turbo prune` beside
/// `--scope`). Terms often name the successor, which is why they are never evidence of the deprecated API; here that
/// is what is wanted. Empty when `deprecated` is.
pub fn replacement_lits(r: &Rec, lits: &[String], deprecated: &[String]) -> Vec<String> {
    if deprecated.is_empty() {
        return vec![];
    }
    let shape = |l: &str| -> u8 {
        if usage::cli_flag(l) {
            1
        } else if l.contains('/') {
            2
        } else if l.rsplit_once('.').is_some_and(|(_, x)| !x.is_empty() && x.chars().all(|c| c.is_ascii_lowercase())) && !l.starts_with('.') {
            3
        } else {
            4
        }
    };
    let shapes: BTreeSet<u8> = deprecated.iter().map(|d| shape(d)).collect();
    let intro: BTreeSet<String> = r.r.introduces.iter().filter_map(|x| clean_lit(x)).collect();
    let mut out: Vec<String> = vec![];
    for l in intro.iter().chain(lits) {
        let related = deprecated.iter().any(|d| d.contains(l.as_str()) || l.contains(d.as_str()));
        let fits = intro.contains(l) || shapes.contains(&shape(l));
        if fits && !related && !usage::plain_word(l) && !l.contains(char::is_whitespace) && !out.contains(l) {
            out.push(l.clone());
        }
    }
    out
}

/// Opt-in: an adoption step is needed. The adoption list also names `configuration` and `schema_or_migration`, which are
/// surfaces, not change types; they adopt anyway.
///
/// Not opt-in: a runtime-internal change, and the tool's own behaviour, a tooling change to its build or configuration
/// handling (knip detecting custom elements, a Vite 8 peer range, TypeScript 6 support) or a stability change to it:
/// every user of that version gets it, with nothing to write. Of 60 such records sampled from the catalog (17 October
/// 2026), 58 were support, compatibility or detection the tool applies itself.
pub fn is_opt_in(r: &Rec) -> bool {
    !is_obligation(r)
        && matches!(r.r.change_type, ChangeType::NewApi | ChangeType::NewOption | ChangeType::StabilityChange | ChangeType::Tooling | ChangeType::Other)
        && r.r.surface != Surface::RuntimeInternal
        && !tool_behaviour(r)
}

/// A tooling change to the tool's build or configuration handling, or a stability change to its build (`is_opt_in`).
fn tool_behaviour(r: &Rec) -> bool {
    matches!(
        (r.r.change_type, r.r.surface),
        (ChangeType::Tooling, Surface::BuildTooling | Surface::Configuration) | (ChangeType::StabilityChange, Surface::BuildTooling)
    )
}

/// A version's release line by SemVer: its major, or `0.minor` below 1.0.
pub(crate) fn line_of(v: &Version) -> String {
    if v.major > 0 { v.major.to_string() } else { format!("0.{}", v.minor) }
}

/// Whether `v` is on a release line older than `installed`'s (major, or minor on 0.x).
fn older_line(v: &Version, installed: &Version) -> bool {
    v.major < installed.major || (v.major == 0 && installed.major == 0 && v.minor < installed.minor)
}

/// An opt-in the installed version has had as a given (`Route::Baseline`): released on an older line, and at least
/// `BASELINE_DAYS` before the installed version. Dates come from the release, else the tech index; a date or version
/// that cannot be read keeps the record (fail open). The installed version's date is its own index entry's, else the
/// newest release at or below it (a floor between releases).
fn baseline(release: &Release, installed: &Version, index: &[IndexRelease]) -> bool {
    let Some(v) = parse_version(&release.version) else { return false };
    if !older_line(&v, installed) {
        return false;
    }
    // The newest index release at or below `want`, and whether it is `want` itself.
    let at_or_below = |want: &Version| {
        index.iter().filter_map(|r| parse_version(&r.version).map(|x| (x, r))).filter(|(x, _)| x <= want).max_by(|a, b| a.0.cmp(&b.0))
    };
    let released = parse_date(&release.date).or_else(|| at_or_below(&v).filter(|(x, _)| *x == v).and_then(|(_, r)| parse_date(&r.date)));
    let installed_on = at_or_below(installed).and_then(|(_, r)| parse_date(&r.date));
    match (released, installed_on) {
        (Some(r), Some(i)) => i - r >= BASELINE_DAYS,
        _ => false,
    }
}

/// Whether a record is in the installed version, in an upgrade from it, or in neither (`Avail`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Avail {
    Installed,
    /// In the window: installed < release <= target.
    Upgrade,
    BeyondTarget,
    /// Only in releases at or below the installed version on older lines, which the installed line does not get.
    OlderLine,
}

/// The release that decides availability at `installed`, and where that leaves the record: by release line from the
/// tech index (lines.rs), the old rule (`pick_release`) where that cannot decide. An upgrade picks up a change only
/// through a release above the installed version: a release semver-below it (a backport to an older line, whatever its
/// date) is never in the upgrade range, so the target is asked about the record's releases above `installed` only.
fn availability<'r>(lines: &Lines, candidates: &[&'r Release], installed: &Version, target: &Version, picked: (&'r Release, &Version)) -> (&'r Release, Avail) {
    let (picked, rv) = picked;
    match lines.has(candidates, &installed.to_string()) {
        Some(Some(r)) => (r, Avail::Installed),
        Some(None) => {
            let above: Vec<&'r Release> = candidates.iter().copied().filter(|r| parse_version(&r.version).is_none_or(|v| v > *installed)).collect();
            if above.is_empty() {
                return (picked, Avail::OlderLine);
            }
            let first = above.iter().copied().min_by_key(|r| parse_version(&r.version)).unwrap_or(picked);
            match lines.has(&above, &target.to_string()) {
                Some(Some(r)) => (r, Avail::Upgrade),
                Some(None) => (first, Avail::BeyondTarget),
                None => (first, if parse_version(&first.version).is_some_and(|v| v > *target) { Avail::BeyondTarget } else { Avail::Upgrade }),
            }
        }
        None if *rv <= *installed => (picked, Avail::Installed),
        None if rv > target => (picked, Avail::BeyondTarget),
        None => (picked, Avail::Upgrade),
    }
}

/// Where a record goes from its availability alone, before the ledger, prerequisites, applied and benefit checks.
fn base_route(rec: &Rec, avail: Avail) -> Route {
    if avail == Avail::OlderLine {
        Route::OlderLine
    } else if avail == Avail::BeyondTarget {
        Route::BeyondTarget
    } else if avail == Avail::Upgrade {
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

/// The release that decides availability for a project at `installed`: the one on the installed line; otherwise
/// the newest on an older line (it carried forward); otherwise the oldest on a newer line.
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
    /// Relative literals that name a subpath of the technology's own package (`./src/*` in a record about vitest's
    /// `exports`) → the literals naming `<package>/<subpath>` (`usage::subpath_lits`) that stand in for its hits.
    subpaths: BTreeMap<String, Vec<String>>,
    /// Every literal any record names (`terms`, `replaces`, `introduces`, `requires`; a leading `@` dropped) → the
    /// records (indices into `per_record`) naming it, for `namespace_of`.
    named: BTreeMap<String, BTreeSet<usize>>,
}

/// Whether record `i`'s literal `lit` is a namespace of the technology's API rather than one API: a qualified name
/// (`usage::qualified_name`) under which another of the technology's records names a member (`pytest.mark` when
/// others are about `pytest.mark.parametrize` and `pytest.mark.xfail`). Every user writes it for whichever member
/// they need, so on its own it does not show the deprecated use (`usage::live_site_near`). From the catalog, not
/// from the repository: an options object written with its keys (`webpack.treeshake.removeDebugLogging`) is a use of
/// a deprecated `webpack.treeshake`.
fn namespace_of(tl: &TechLits, i: usize, lit: &str) -> bool {
    if !usage::qualified_name(lit) {
        return false;
    }
    let head = format!("{lit}.");
    tl.named.range(head.clone()..).take_while(|(k, _)| k.starts_with(&head)).any(|(k, rs)| usage::member_of(k, lit) && rs.iter().any(|&j| j != i))
}

fn tech_lits(tech: &str, td: &TechData) -> TechLits {
    // The technology's own packages: the index's, else every package its records name (older catalogs). A technology
    // with no records is not in the stack either way.
    let comps: BTreeSet<String> = if td.index.components.is_empty() || td.records.is_empty() {
        td.records.iter().flat_map(|r| r.r.releases.iter().map(|x| normalize_purl(&x.component))).collect()
    } else {
        td.index.components.iter().map(|c| normalize_purl(c)).collect()
    };
    let mut exclude: BTreeSet<String> = comps.iter().filter_map(|c| purl_name(c)).collect();
    exclude.insert(tech.to_string());
    let per_record: Vec<Vec<String>> = td.records.iter().map(|r| record_lits(r, &exclude)).collect();
    let mut named: BTreeMap<String, BTreeSet<usize>> = BTreeMap::new();
    for (i, r) in td.records.iter().enumerate() {
        for x in r.r.terms.iter().map(|t| &t.0).chain(&r.r.replaces).chain(&r.r.introduces).chain(&r.r.requires) {
            if let Some(l) = clean_lit(x) {
                named.entry(l.strip_prefix('@').unwrap_or(&l).to_string()).or_default().insert(i);
            }
        }
    }
    let mut usage: BTreeSet<String> = per_record.iter().flatten().cloned().collect();
    let mut whole = BTreeSet::new();
    for r in &td.records {
        usage.extend(r.r.requires.iter().filter_map(|x| clean_lit(x)));
        whole.extend(r.r.introduces.iter().filter_map(|x| clean_lit(x)).filter(|x| x.chars().count() >= 6));
    }
    // A relative literal is the technology's package subpath when its record says so: it also names the manifest's
    // `exports` field, or `<package>/<subpath>` itself (knip's `./config` next to `knip/config`). Otherwise it is a
    // path of the repository (webpack's default `./src` entry, SvelteKit's `./$types`) and is matched as it is.
    let names: Vec<String> = comps.iter().filter_map(|c| purl_name(c)).collect();
    let mut subpaths: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (r, lits) in td.records.iter().zip(&per_record) {
        let mut all: Vec<String> = lits.clone();
        all.extend(r.r.introduces.iter().chain(&r.r.requires).filter_map(|x| clean_lit(x)));
        for l in &all {
            let Some(x) = usage::subpath(l) else { continue };
            let x_bare = x.trim_end_matches('/');
            let names_it = all.iter().any(|o| o == "exports" || names.iter().any(|n| o.strip_prefix(n.as_str()).and_then(|t| t.strip_prefix('/')).is_some_and(|t| t.trim_end_matches(['*', '/']) == x_bare)));
            if names_it {
                // `<package>/<x>` of the packages that shipped this record (all of the technology's when it names none).
                let own: Vec<String> = r.r.releases.iter().map(|x| normalize_purl(&x.component)).filter(|c| comps.contains(c)).collect();
                let pkgs: Vec<&String> = if own.is_empty() { comps.iter().collect() } else { own.iter().collect() };
                let v = subpaths.entry(l.clone()).or_default();
                for spec in pkgs.into_iter().flat_map(|c| usage::subpath_lits(c, x)) {
                    if !v.contains(&spec) {
                        v.push(spec);
                    }
                }
            }
        }
    }
    subpaths.retain(|_, v| !v.is_empty());
    TechLits { comps, per_record, usage, whole, subpaths, named }
}

/// `hits` for one technology with each package-subpath literal (`TechLits::subpaths`) matched as `<package>/<subpath>`
/// only: a file that names it at a module position (an import or require of `vitest/src/…`), a data or config file
/// that quotes it, or code about the technology that quotes it as a value. A bare `./src/*` is the repository's own
/// path (its `exports` map, a `tsconfig` alias), never the dependency's subpath. `None` when there are none.
fn subpath_filtered(
    hits: &Hits,
    tl: &TechLits,
    ecosystem: &str,
    owners: &[&str],
    repo: &usage::Repo,
) -> Option<Hits> {
    if tl.subpaths.is_empty() {
        return None;
    }
    let paths = &repo.paths;
    let naming: BTreeSet<String> = tl.comps.iter().flat_map(|c| usage::naming_lits(c)).collect();
    let lits: BTreeSet<&String> = tl.usage.iter().chain(&tl.whole).chain(&naming).collect();
    let mut out = hits_without(hits, lits.iter().copied(), &vec![false; paths.len()], paths);
    let scope = usage::Scope::new(ecosystem, owners, &tl.comps, tl.usage.iter().chain(&tl.whole), hits, paths);
    for (lit, specs) in &tl.subpaths {
        let mut files: BTreeSet<u32> = BTreeSet::new();
        for spec in specs {
            let module = usage::module_naming(spec);
            for x in hits.ix.get(spec).into_iter().flatten() {
                let Some(p) = paths.get(*x as usize) else { continue };
                if module || !usage::own_code(p, ecosystem) || scope.file(p) == Some(true) {
                    files.insert(*x);
                }
            }
        }
        let mut ranked: Vec<(usage::Role, u32)> = files.into_iter().map(|x| (repo.role(&paths[x as usize]), x)).collect();
        ranked.sort_unstable();
        let named: Vec<String> = ranked.iter().map(|(_, x)| paths[*x as usize].clone()).collect();
        out.tail_only.remove(lit);
        out.by_tail.remove(lit);
        if named.is_empty() {
            out.usage.remove(lit);
            out.ix.remove(lit);
            out.whole.remove(lit);
            continue;
        }
        if tl.whole.contains(lit) {
            out.whole.insert(lit.clone(), named.clone());
        }
        out.ix.insert(lit.clone(), ranked.iter().map(|(_, x)| *x).collect());
        out.usage.insert(lit.clone(), named);
    }
    Some(out)
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
    // The literals that find the files naming each technology's packages (`usage::Scope`) ride along.
    let usage_lits: BTreeSet<String> = in_stack
        .iter()
        .flat_map(|(_, _, tl)| {
            tl.usage.iter().cloned().chain(tl.comps.iter().flat_map(|c| usage::naming_lits(c))).chain(tl.subpaths.values().flatten().cloned())
        })
        .collect();
    let whole_lits: BTreeSet<String> = in_stack.iter().flat_map(|(_, _, tl)| tl.whole.iter().cloned()).collect();
    // The words that run each technology from a command line, for its CLI-flag literals (`usage::cli_flag`).
    let commands: BTreeSet<String> = in_stack.iter().flat_map(|(_, _, tl)| tl.comps.iter().flat_map(|c| usage::command_words(c))).collect();
    let all_hits: Hits = usage::find_with_commands(inp.repo, &usage_lits, &whole_lits, &commands);
    let dependents = dependents(&inp.stack.packages);
    for (tech, td, tl) in &in_stack {
        let (tech, comps, lits) = (*tech, &tl.comps, &tl.per_record);
        // A CLI flag counts only on a command line that runs this technology: `--scope` in another CLI's help text or
        // a `claude mcp add --scope` string is not turbo's flag.
        let flagged = flag_filtered(&all_hits, comps, tl.usage.iter().chain(&tl.whole), &inp.repo.paths);
        let hits: &Hits = flagged.as_ref().unwrap_or(&all_hits);
        let present: Vec<&String> = comps.iter().filter(|c| purls.contains(*c)).collect();
        // Packages that declare this technology: a file's role is judged inside the deepest one containing it.
        let owners: Vec<&str> = inp.stack.packages.iter().filter(|p| p.declared.iter().any(|d| comps.contains(&normalize_purl(d)))).map(|p| p.dir.as_str()).collect();
        let reach = reaching(&inp.stack.packages, &dependents, comps);
        // A deprecated literal that only loads one of the technology's packages (`from 'chat'`) is in every file using
        // it: no sign of the deprecated re-export or entry point.
        let own_names: Vec<String> = comps.iter().filter_map(|c| purl_name(c)).collect();
        let ecosystem = comps.iter().find_map(|c| c.strip_prefix("pkg:").and_then(|r| r.split('/').next())).unwrap_or("npm").to_string();
        // A subpath of the technology's own package (`./src/*`) counts only where `<package>/<subpath>` is named.
        let subpathed = subpath_filtered(hits, tl, &ecosystem, &owners, inp.repo);
        let hits: &Hits = subpathed.as_ref().unwrap_or(hits);
        // A file's role once per technology: a large repository has tens of thousands of hit files, and the same
        // files come up for every record sharing a literal.
        let roles: RefCell<HashMap<String, usage::Role>> = RefCell::default();
        let role = |p: &str| -> usage::Role {
            if let Some(r) = roles.borrow().get(p) {
                return *r;
            }
            let r = inp.repo.role_for(p, &owners);
            roles.borrow_mut().insert(p.to_string(), r);
            r
        };
        // Only files that can use this technology evidence it, and a plain word only where it is named (`usage::Scope`).
        let scope_lits = || tl.usage.iter().chain(&tl.whole);
        let all = usage::Scope::new(&ecosystem, &owners, comps, scope_lits(), hits, &inp.repo.paths).with_reach(&reach);
        // Per package: the version the outputs use, from the code that imports it (`Choice`).
        let choices: BTreeMap<&String, Choice> = present
            .iter()
            .filter_map(|c| {
                let d = inp.stack.deps.get(*c)?;
                let sites = || {
                    let mut v: Vec<String> = usage::naming_lits(c)
                        .iter()
                        .flat_map(|l| hits.usage.get(l).into_iter().flatten())
                        .filter(|p| all.file(p) == Some(true))
                        .cloned()
                        .collect();
                    v.sort();
                    v.dedup();
                    v
                };
                choose(d, sites).map(|ch| (*c, ch))
            })
            .collect();
        // Per package with code on another release line than the outputs' version: a view of the repository without
        // those files (a mask by path index naming which of `off_labels` each belongs to: the manifest, the package and
        // its version). View 0 is the whole repository; a record reads the view of its package.
        let mut off_labels: Vec<String> = vec![];
        let mut masks: Vec<Vec<Option<u16>>> = vec![];
        let mut view_of: BTreeMap<&String, usize> = BTreeMap::new();
        for (c, ch) in choices.iter().filter(|(_, ch)| !ch.off.is_empty()) {
            let d = &inp.stack.deps[*c];
            let mut mask = vec![None; inp.repo.paths.len()];
            for (i, p) in inp.repo.paths.iter().enumerate() {
                let Some(r) = owner(d, p).filter(|r| ch.off.iter().any(|o| o.dir == r.dir)) else { continue };
                let label = format!("{} ({} {})", place(&r.dir), d.name, r.version);
                let k = off_labels.iter().position(|l| *l == label).unwrap_or_else(|| {
                    off_labels.push(label);
                    off_labels.len() - 1
                });
                mask[i] = Some(k as u16);
            }
            if mask.iter().any(Option::is_some) {
                masks.push(mask);
                view_of.insert(*c, masks.len());
            }
        }
        let filtered: Vec<Hits> = if masks.is_empty() {
            vec![]
        } else {
            let naming: BTreeSet<String> = comps.iter().flat_map(|c| usage::naming_lits(c)).collect();
            let lits: BTreeSet<&String> = scope_lits().chain(&naming).collect();
            masks.iter().map(|m| hits_without(hits, lits.iter().copied(), &m.iter().map(Option::is_some).collect::<Vec<_>>(), &inp.repo.paths)).collect()
        };
        let mut scopes = vec![all];
        scopes.extend(filtered.iter().map(|f| usage::Scope::new(&ecosystem, &owners, comps, scope_lits(), f, &inp.repo.paths).with_reach(&reach)));
        let hits_of = |v: usize| if v == 0 { hits } else { &filtered[v - 1] };
        // Per view and literal, the manifests left out whose code importing the technology it matches (`Opp::elsewhere`).
        let elsewhere: Memo<Rc<BTreeSet<u16>>> = RefCell::default();
        let elsewhere_of = |v: usize, l: &str| -> Rc<BTreeSet<u16>> {
            let key = (v, l.to_string());
            if let Some(e) = elsewhere.borrow().get(&key) {
                return e.clone();
            }
            let e: BTreeSet<u16> = if v == 0 {
                BTreeSet::new()
            } else {
                hits.ix
                    .get(l)
                    .into_iter()
                    .flatten()
                    .filter_map(|x| {
                        let k = masks[v - 1][*x as usize]?;
                        scopes[0].file(&inp.repo.paths[*x as usize]).filter(|about| *about).map(|_| k)
                    })
                    .collect()
            };
            let e = Rc::new(e);
            elsewhere.borrow_mut().insert(key, e.clone());
            e
        };
        let nested = owners.iter().any(|o| *o != ".");
        // Each literal's evidence once per technology and view, however many records share it.
        let evidence: Memo<Rc<usage::Evidence>> = RefCell::default();
        let evidence_of = |v: usize, l: &str| -> Rc<usage::Evidence> {
            let key = (v, l.to_string());
            if let Some(e) = evidence.borrow().get(&key) {
                return e.clone();
            }
            let e = Rc::new(scopes[v].evidence(l, role, !nested));
            evidence.borrow_mut().insert(key, e.clone());
            e
        };
        // A deprecated literal's evidence: whole-literal hits only (`usage::Scope::exact_evidence`), at a live site
        // (`usage::live_site`: not in a comment, not a fallback beside the record's replacement). Per view, literal and
        // replacements.
        let exact: Memo<Rc<usage::Evidence>> = RefCell::default();
        let exact_of = |v: usize, l: &str, repl: &[String], context: Option<&[String]>| -> Rc<usage::Evidence> {
            let ctx = context.map_or("-".to_string(), |c| c.join("\0"));
            let key = (v, format!("{l}\0{}\u{1}{ctx}", repl.join("\0")));
            if let Some(e) = exact.borrow().get(&key) {
                return e.clone();
            }
            let live = |p: &str| inp.repo.text(p).is_none_or(|t| usage::live_site_near(p, t, l, repl, context));
            let e = Rc::new(scopes[v].exact_evidence_where(l, role, !nested, live));
            exact.borrow_mut().insert(key, e.clone());
            e
        };
        // The first three of the union are among the first three of each literal.
        let files_of = |ls: &[String], cite: Cite| -> Vec<String> {
            let mut files: Vec<(bool, usage::Role, String)> = ls
                .iter()
                .flat_map(|l| {
                    let e = cite(l);
                    e.files.iter().map(|(p, about)| (!about, role(p), p.clone())).collect::<Vec<_>>()
                })
                .collect();
            files.sort();
            files.dedup();
            files.into_iter().take(3).map(|(_, _, p)| p).collect()
        };
        let applied: Memo<bool> = RefCell::default();
        let applied_of = |v: usize, x: &str| -> bool {
            let key = (v, x.to_string());
            if let Some(a) = applied.borrow().get(&key) {
                return *a;
            }
            let a = hits_of(v).whole.get(x).into_iter().flatten().any(|p| scopes[v].counts(x, p) && usage::counts_as_applied(role(p), p));
            applied.borrow_mut().insert(key, a);
            a
        };
        out.technologies.push(tech.clone());
        out.packages.insert(tech.clone(), present.iter().filter_map(|c| purl_name(c)).collect());
        let version_of = |c: &str| -> Option<Version> {
            choices.get(&c.to_string()).map(|ch| ch.head.version.clone()).or_else(|| inp.stack.deps.get(c).and_then(|d| d.version.clone()))
        };
        let tech_version: Option<Version> = present.iter().filter_map(|c| version_of(c)).min();
        let mut workspaces: Vec<Workspace> = vec![];
        for c in &present {
            let (Some(d), Some(ch)) = (inp.stack.deps.get(*c), choices.get(*c)) else { continue };
            let h = ch.head;
            let others = d.others_than(h);
            if !others.is_empty() {
                out.headline.insert((*c).clone(), (h.dir.clone(), h.source.clone()));
            }
            if let Some(m) = ch.moved {
                out.versions.insert(normalize_purl(c), h.version.clone());
                out.version_notes.push(format!(
                    "{}: the reviews use {} in {} ({}), where the code that imports it is; no file importing it runs {} ({} in {}).",
                    d.name, h.version, place(&h.dir), h.source, m.version, m.source, place(&m.dir)
                ));
            }
            if !ch.off_sites.is_empty() {
                let dirs: Vec<String> = ch.off_sites.iter().take(5).map(|r| format!("{} ({})", place(&r.dir), r.version)).collect();
                let more = if ch.off_sites.len() > 5 { format!(" and {} more manifests", ch.off_sites.len() - 5) } else { String::new() };
                out.version_notes.push(format!(
                    "{}: code importing it under {}{more} runs another release line than the reviews' {}; it is not cited in them.",
                    d.name,
                    dirs.join(", "),
                    h.version
                ));
            }
            for (version, rs) in others {
                let dirs = rs.iter().map(|r| (r.dir.clone(), r.source.clone())).collect();
                workspaces.push(Workspace { component: (*c).clone(), version, dirs, target: None, records: vec![] });
            }
        }
        // Newest release per component: the default target. The technology's own packages take the newest release any
        // of its records names, also one central gave to another package of the repository (they share the release).
        let mut newest: BTreeMap<String, Version> = BTreeMap::new();
        if let Some(v) = td.records.iter().flat_map(|r| r.r.releases.iter()).filter_map(|x| parse_version(&x.version)).max() {
            for c in comps.iter() {
                newest.insert(c.clone(), v.clone());
            }
        }
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
        for (ri, (rec, ls)) in td.records.iter().zip(lits).enumerate() {
            // The releases of the packages this repository uses; else of the technology's own packages (a record names
            // every component, and the repository uses at least one). A record about other packages of the technology's
            // repository only (a release-notes section central attributed to them) applies only where one is used.
            let own: Vec<&Release> = rec.r.releases.iter().filter(|x| purls.contains(&normalize_purl(&x.component))).collect();
            let rels: Vec<&Release> = rec.r.releases.iter().filter(|x| comps.contains(&normalize_purl(&x.component))).collect();
            if own.is_empty() && rels.is_empty() {
                if let Some(release) = rec.r.releases.first() {
                    out.opps.push(blank(rec, release.clone(), Route::OtherPackage));
                }
                continue;
            }
            let candidates = if own.is_empty() { rels } else { own };
            let installed_for = |c: &str| version_of(c).or_else(|| tech_version.clone());
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
            let (release, avail) = availability(&lines, &candidates, &installed, &target, (picked, &rv));
            // A deprecation that names what it deprecates cites only that, as whole literals: a match on its other
            // terms is not usage of the deprecated API. The score (the queue's order) still counts every literal.
            let mut deprecated = deprecated_lits(rec, ls);
            deprecated.retain(|l| !usage::loads_only(l, &own_names));
            let replacement = replacement_lits(rec, ls, &deprecated);
            // A deprecated namespace (`pytest.mark`, for markers on hook implementations) counts only beside a specific
            // literal of the record: not the namespace or a part of it, not the replacement, not a plain word.
            let broad: Vec<&String> = deprecated.iter().filter(|l| namespace_of(tl, ri, l)).collect();
            let context: Vec<String> = if broad.is_empty() {
                vec![]
            } else {
                ls.iter()
                    .filter(|l| {
                        !broad.iter().any(|b| b.contains(l.as_str()))
                            && !replacement.contains(l)
                            && !usage::plain_word(l)
                            && !namespace_of(tl, ri, l)
                    })
                    .cloned()
                    .collect()
            };
            // The record reads the view of its package (code on the outputs' release line only).
            let view = candidates.first().and_then(|r| view_of.get(&normalize_purl(&r.component))).copied().unwrap_or(0);
            let ev = |l: &str| evidence_of(view, l);
            let ex = |l: &str| exact_of(view, l, &replacement, broad.iter().any(|b| *b == l).then_some(&context[..]));
            let (cited, cite): (&[String], Cite) = if deprecated.is_empty() { (ls, &ev) } else { (&deprecated, &ex) };
            let matched: Vec<(String, Vec<String>)> = cited
                .iter()
                .filter_map(|l| Some(cite(l)).filter(|e| !e.files.is_empty()).map(|e| (l.clone(), e.files.iter().map(|(p, _)| p.clone()).collect())))
                .collect();
            let score = ls
                .iter()
                .filter_map(|l| Some(ev(l)).filter(|e| e.used).map(|e| weight(l) * if e.app { 1.0 } else { NON_APP_WEIGHT }))
                .sum::<f64>();
            let files = files_of(cited, cite);
            let elsewhere: Vec<String> = {
                let ks: BTreeSet<u16> = cited.iter().flat_map(|l| elsewhere_of(view, l).iter().copied().collect::<Vec<_>>()).collect();
                ks.into_iter().map(|k| off_labels[k as usize].clone()).collect()
            };
            // A `requires` value the change itself introduces is something the upgrade has the project add, not a
            // precondition (absent until adopted), so it never demotes the record (eval/rank/RESULTS.md, follow-up).
            let intro: BTreeSet<String> = rec.r.introduces.iter().filter_map(|x| clean_lit(x)).collect();
            let req: Vec<String> = rec.r.requires.iter().filter_map(|x| clean_lit(x)).filter(|x| !intro.contains(x)).collect();
            // A condition may be met in any config or data file (`postgresql` in a compose file), but never in another
            // ecosystem's code.
            let requires_miss = !req.is_empty()
                && !req.iter().any(|x| hits.usage.get(x).into_iter().flatten().any(|p| !usage::foreign_code(p, &ecosystem)));
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
                elsewhere,
            };
            // The ledger, prerequisite and applied checks do not depend on the version: shared with `workspaces`.
            let ledger_status = || {
                inp.ledger.entries.iter().find(|e| e.id() == rec.r.id).filter(|e| withholds(e, rec.r.revision, inp.today)).map(status_name)
            };
            // Applied in the code the record describes; a workspace on another version is judged on the whole repository.
            let applied_in = |v: usize| rec.r.introduces.iter().filter_map(|x| clean_lit(x)).any(|x| applied_of(v, &x));
            let applied = || applied_in(view);
            opp.route = base_route(rec, avail);
            // A deprecation already in the installed version is still owed while the code uses what it deprecates: its
            // `replaces` literals, whole, under the shown evidence rule (files that can use the technology). A plain word
            // (`message`) is too common to show that, so it takes a specific literal (`toBeCalledWith`, `terserOptions`)
            // and cites only those. Nothing to block (it is installed) and no applied check (the old API is the signal:
            // once it is gone the record is already included).
            if opp.route == Route::AlreadyIncluded && !deprecated.is_empty() && opp.matched.iter().any(|(l, _)| !usage::plain_word(l)) {
                opp.matched.retain(|(l, _)| !usage::plain_word(l));
                opp.files = files_of(&opp.matched.iter().map(|(l, _)| l.clone()).collect::<Vec<_>>(), cite);
                opp.route = Route::InEffect;
                // A known prerequisite of acting on it (the replacement needs a newer peer: ESLint's core rule handles
                // TypeScript imports from 9.37) that the project's version does not meet: the deprecated API is still
                // the right one here, so it is not owed now.
                if let Some(b) = blocked(rec, inp.stack, &comp) {
                    opp.route = Route::Blocked(b);
                } else if let Some(s) = ledger_status() {
                    opp.withheld_from = Some(Route::InEffect);
                    opp.route = Route::Withheld(s);
                }
            }
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
                let (decides, avail) = availability(&lines, &candidates, &w.version, &target, (picked, &rv));
                let route = base_route(rec, avail);
                if !matches!(route, Route::UpgradeReview | Route::BumpDigest) {
                    continue;
                }
                let blocks = blocked(rec, inp.stack, &comp).is_some() && !(route == Route::UpgradeReview && is_obligation(rec));
                if blocks || ledger_status().is_some() || (route == Route::UpgradeReview && !rec.r.breaking && applied_in(0)) {
                    continue;
                }
                w.target.get_or_insert(target);
                w.records.push((rec, route, decides.version.clone()));
            }
            if opp.route == Route::ImprovementsPass {
                let replaces_here = rec.r.replaces.iter().filter_map(|x| clean_lit(x)).any(|x| ev(&x).used);
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
                // The improvements pass offers what the code could newly adopt: not an older line's long-standing API,
                // nor a change for a package or setting the repository does not have. Asked last, so the ledger,
                // applied and benefit routes stay as they were.
                if opp.route == Route::ImprovementsPass {
                    if baseline(release, &installed, &td.index.releases) {
                        opp.route = Route::Baseline;
                    } else if requires_miss {
                        opp.route = Route::RequiresAbsent;
                    }
                }
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
        elsewhere: vec![],
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
    let mut now: Vec<usize> = (0..opps.len()).filter(|&i| opps[i].route == Route::InEffect).collect();
    now.sort_by(|&a, &b| cmp_score(opps[a].score, opps[b].score).then_with(|| opps[a].id().cmp(opps[b].id())));
    out.in_effect = now;
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

/// `why`'s label for `Route::InEffect`.
pub const IN_EFFECT: &str = "in effect now (deprecated at the installed version, still used here)";

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
            Route::Baseline => "opt-in from an older release line, a year or more before the installed version (part of it, nothing new to adopt)",
            Route::RequiresAbsent => "opt-in for a package or setting this repository does not have (its `requires` is not found)",
            Route::InEffect => IN_EFFECT,
            Route::AlreadyIncluded => "already in the installed version with nothing to adopt",
            Route::BeyondTarget => "released after the target version",
            Route::OlderLine => "released only on older release lines than the installed version",
            Route::OtherPackage => "about another package of the technology's repository that this repository does not use",
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
        return match &out.uncovered {
            Some(why) => format!("no catalog technology covers this repository yet: {why}"),
            None => "no catalog technology matches this repository's packages (run `unstale sync`)".into(),
        };
    }
    if parts.is_empty() {
        // Every record went to one of `routes`, which the caller lists itself.
        if !c.is_empty() {
            return format!("no other records for {} in the catalog", out.technologies.join(", "));
        }
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
            spread: 0,
            standalone: vec![],
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
        r.files.sort_by(|a, b| a.0.cmp(&b.0));
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
                with(rec("next:old-dep", "pkg:npm/next", "15.0.0"), json!({"change_type":"deprecation","replaces":["unstable_oldCache"]})),
                with(rec("next:old-dep-used", "pkg:npm/next", "15.0.0"), json!({"change_type":"deprecation","replaces":["unstable_noStore"]})),
            ],
        );
        let s = stack(&[("next", "16.0.5")], None);
        let r = repo(&[("app/page.tsx", "import { unstable_noStore } from 'next/cache';\nunstable_noStore();")]);
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
        // A deprecation at or below the installed version: owed now while the code uses what it deprecates, and
        // listed apart from the obligations a bump brings; already included once the code shows none of it.
        assert_eq!(route_of(&out, "next:old-dep"), &Route::AlreadyIncluded, "deprecated API not used here");
        assert_eq!(ids(&out, &out.in_effect), vec!["next:old-dep-used"], "deprecated API still used: in effect now");
    }

    #[test]
    fn a_package_reaches_a_technology_through_workspace_packages() {
        let pkg = |dir: &str, own: Option<&str>, declared: &[&str]| crate::stack::Package {
            dir: dir.into(),
            kind: crate::stack::Kind::Application,
            lockfile: None,
            declared: declared.iter().map(|d| crate::util::npm_purl(d)).collect(),
            own: own.map(crate::util::npm_purl),
        };
        let ps = vec![
            pkg(".", Some("root"), &["turbo"]),
            pkg("packages/eslint-config", Some("@n8n/eslint-config"), &["typescript-eslint"]),
            pkg("packages/cli", Some("n8n"), &["@n8n/eslint-config"]),
            pkg("packages/editor", Some("editor"), &["n8n"]),
            pkg("packages/other", Some("other"), &["lodash"]),
        ];
        let comps: BTreeSet<String> = [crate::util::npm_purl("typescript-eslint")].into();
        assert_eq!(reaching(&ps, &dependents(&ps), &comps), vec!["packages/eslint-config", "packages/cli", "packages/editor"]);
    }

    #[test]
    fn in_effect_leaves_out_fallbacks_beside_the_replacement_and_comments() {
        // expo/expo: `react-native/setup-env` is loaded first and the deprecated path kept in a `catch`; tests assert
        // that both are handled. A comment naming the old path is not a use.
        let dep = |id: &str, extra: serde_json::Value| with(with(rec(id, "pkg:npm/react-native", "0.88.0"), json!({"change_type":"deprecation"})), extra);
        let old = "react-native/Libraries/Core/InitializeCore";
        let c = catalog(
            "react-native",
            0,
            vec![
                dep("react-native:initializecore", json!({"replaces":[old],"terms":[[old,0],["InitializeCore",0],["react-native/setup-env",0]]})),
                dep("react-native:other", json!({"replaces":["react-native/Libraries/Old"],"terms":[["react-native/New",0]]})),
                // A re-export deprecated in favour of a subpath: `from 'react-native'` is in every file that uses it.
                dep("react-native:reexport", json!({"replaces":["from 'react-native'", "\"react-native\""]})),
            ],
        );
        let s = stack(&[("react-native", "0.88.0")], None);
        let fallback = "try {\n  require('react-native/setup-env');\n} catch {\n  require('react-native/Libraries/Core/InitializeCore');\n}\n";
        let r = repo(&[
            ("src/setup.ts", fallback),
            ("src/__tests__/warn.test.ts", "transform(`\n  require('react-native/Libraries/Core/InitializeCore');\n  require('react-native/setup-env');\n`);"),
            ("src/doc.ts", "/** Replaces react-native/Libraries/Core/InitializeCore */\nexport {};"),
            ("src/live.ts", "import 'react-native/Libraries/Old';\nimport { View } from 'react-native';"),
        ]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(ids(&out, &out.in_effect), vec!["react-native:other"]);
        assert_eq!(route_of(&out, "react-native:initializecore"), &Route::AlreadyIncluded, "already moved; the old path is a fallback");
        let r = repo(&[("src/setup.ts", fallback), ("src/app.ts", "import 'react-native/Libraries/Core/InitializeCore';")]);
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "react-native:initializecore").unwrap();
        assert_eq!((&o.route, &o.matched), (&Route::InEffect, &vec![(old.to_string(), vec!["src/app.ts".to_string()])]), "cites the live site only");
    }

    #[test]
    fn a_deprecated_namespace_counts_only_beside_a_specific_literal_of_its_record() {
        // locustio/locust: pytest 9.1 schedules hook markers (`@pytest.mark.tryfirst` on a `pytest_*` hook) for removal;
        // the record `replaces` `pytest.mark`, the namespace every marker lives under, and other pytest records are
        // about `pytest.mark.parametrize` and `pytest.mark.xfail`. Test markers are not the deprecated use.
        let purl = "pkg:pypi/pytest";
        let dep = |id: &str, extra: serde_json::Value| with(with(rec(id, purl, "9.1.0"), json!({"change_type":"deprecation"})), extra);
        let markers = json!({"replaces":["pytest.mark"],"terms":[["pytest.mark",0],["pytest.hookimpl",0],["pytest_plugins",0],["pytest_addoption",0]]});
        let records = |others: bool| {
            let mut v = vec![dep("pytest:hook-markers", markers.clone())];
            if others {
                v.push(with(rec("pytest:parametrize", purl, "9.0.0"), json!({"terms":[["pytest.mark.parametrize",0]]})));
                v.push(with(rec("pytest:xfail", purl, "9.0.0"), json!({"change_type":"new_option","terms":[["@pytest.mark.xfail",0]]})));
            }
            v
        };
        let mut s = stack(&[], None);
        s.deps.insert(purl.into(), crate::stack::Dep { version: parse_version("9.1.1"), source: "test".into(), ..crate::stack::Dep::new("pytest", true) });
        let tests = "import pytest\n\n@pytest.mark.parametrize('x', [1])\ndef test_a(x):\n    pass\n\n@pytest.mark.skip\ndef test_b():\n    pass\n";
        let plugin = "import pytest\n\ndef pytest_addoption(parser):\n    pass\n";
        let l = Ledger::default();
        let r = repo(&[("tests/test_a.py", tests), ("plugin/plugin.py", plugin)]);
        let c = catalog("pytest", 0, records(true));
        let out = run_with(&c, &s, &r, &l);
        assert!(out.in_effect.is_empty(), "markers on tests are not hook markers");
        // Nothing else of the technology lives under it: `pytest.mark` reads as one API, as before.
        let c = catalog("pytest", 0, records(false));
        assert_eq!(ids(&run_with(&c, &s, &r, &l), &run_with(&c, &s, &r, &l).in_effect), vec!["pytest:hook-markers"]);
        // A marker on a hook the record names is the deprecated use.
        let hooked = "import pytest\n\n@pytest.mark.tryfirst\ndef pytest_addoption(parser):\n    pass\n";
        let r = repo(&[("tests/test_a.py", tests), ("plugin/plugin.py", hooked)]);
        let c = catalog("pytest", 0, records(true));
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "pytest:hook-markers").unwrap();
        assert_eq!((&o.route, &o.matched), (&Route::InEffect, &vec![("pytest.mark".to_string(), vec!["plugin/plugin.py".to_string()])]));
    }

    #[test]
    fn in_effect_respects_a_known_prerequisite_of_the_replacement() {
        // typescript-eslint deprecated its `no-restricted-imports` extension rule because ESLint's core rule handles
        // TypeScript imports from 9.37; at ESLint 9.29 the extension rule is still the right one.
        let rec = |pre: serde_json::Value| {
            with(
                rec("typescript-eslint:no-restricted-imports", "pkg:npm/typescript-eslint", "8.65.0"),
                json!({"change_type":"deprecation","replaces":["@typescript-eslint/no-restricted-imports"],"prerequisites":pre}),
            )
        };
        let r = repo(&[("eslint.config.mjs", "import tseslint from 'typescript-eslint';\nexport default { rules: { '@typescript-eslint/no-restricted-imports': 'error' } };")]);
        let pre = json!([{"ecosystem":"npm","name":"eslint","min":"9.37.0"}]);
        let (l, c) = (Ledger::default(), catalog("typescript-eslint", 0, vec![rec(pre)]));
        let old = stack(&[("typescript-eslint", "8.70.0"), ("eslint", "9.29.0")], None);
        let out = run_with(&c, &old, &r, &l);
        assert!(out.in_effect.is_empty());
        assert!(matches!(route_of(&out, "typescript-eslint:no-restricted-imports"), Route::Blocked(b) if b.contains("eslint >= 9.37.0") && b.contains("9.29.0")));
        let new = stack(&[("typescript-eslint", "8.70.0"), ("eslint", "9.39.1")], None);
        let out = run_with(&c, &new, &r, &l);
        assert_eq!(ids(&out, &out.in_effect), vec!["typescript-eslint:no-restricted-imports"], "met: in effect now");
    }

    #[test]
    fn in_effect_needs_the_deprecated_api_itself_in_code_that_can_use_the_technology() {
        let dep = |id: &str, extra: serde_json::Value| with(with(rec(id, "pkg:npm/vitest", "4.1.0"), json!({"change_type":"deprecation"})), extra);
        let c = catalog(
            "vitest",
            0,
            vec![
                // `replaces` names the deprecated matchers; `spy` and a made-up name are only terms.
                dep("vitest:tobe", json!({"replaces":["toBeCalled","toBeCalledWith"],"terms":[["toBeCalled",0],["toBeInvoked",0],["spy",0]]})),
                // The duplicate describing the replacement: terms match correct code, nothing in `replaces`.
                dep("vitest:tohavebeen", json!({"terms":[["toHaveBeenCalled",0],["spy",0]]})),
                // A plain word cannot show the deprecated API is used.
                dep("vitest:message", json!({"replaces":["message"],"terms":[["message",0]]})),
                // A dotted key matched only by its last word, which is the successor's name.
                dep("vitest:browser-isolate", json!({"replaces":["browser.isolate"],"terms":[["browser.isolate",0]]})),
                // The same with a tail that is not a plain word.
                dep("vitest:test-before-all", json!({"replaces":["test.beforeAll"]})),
                // The deprecated API only in a file that cannot use the technology (data, another ecosystem).
                dep("vitest:old-flag", json!({"replaces":["oldFlagName"]})),
                // Not a deprecation: a removal at or below the installed version is gone, not owed.
                with(rec("vitest:gone", "pkg:npm/vitest", "4.1.0"), json!({"change_type":"removal","replaces":["toBeCalledWith"]})),
                // Withheld by the ledger like any other record.
                dep("vitest:declined", json!({"replaces":["toThrowError"]})),
            ],
        );
        let s = stack(&[("vitest", "4.1.11")], None);
        let r = repo(&[
            ("test/a.spec.ts", "import { expect, vi } from 'vitest';\nconst spy = vi.fn();\nexpect(spy).toBeCalledWith(1);\nexpect(spy).toHaveBeenCalled();\nexpect(e.message).toThrowError();"),
            ("vitest.config.ts", "export default { test: { isolate: false } }"),
            ("test/b.spec.ts", "import { beforeAll } from 'vitest';\nbeforeAll(() => {});"),
            ("fixtures/data.json", "{\"oldFlagName\": true}"),
            ("scripts/x.py", "oldFlagName = 1"),
        ]);
        let (l, _) = Ledger::parse("{\"schema\":1}\n{\"id\":\"vitest:declined\",\"rev\":1,\"status\":\"declined\",\"date\":\"2026-10-01\"}\n").unwrap();
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(ids(&out, &out.in_effect), vec!["vitest:tobe"]);
        let o = out.opps.iter().find(|o| o.id() == "vitest:tobe").unwrap();
        assert_eq!(o.matched, vec![("toBeCalledWith".to_string(), vec!["test/a.spec.ts".to_string()])], "cites `replaces` only, not `spy`");
        for id in ["vitest:tohavebeen", "vitest:message", "vitest:browser-isolate", "vitest:test-before-all", "vitest:old-flag", "vitest:gone"] {
            assert_eq!(route_of(&out, id), &Route::AlreadyIncluded, "{id}");
        }
        assert_eq!(route_of(&out, "vitest:declined"), &Route::Withheld("declined"));
        assert!(out.upgrade.is_empty(), "the upgrade review's queue is unchanged");
        assert!(why(&out, &[]).contains("1 in effect now (deprecated at the installed version, still used here)"), "{}", why(&out, &[]));
        let only = catalog("vitest", 0, vec![dep("vitest:tobe", json!({"replaces":["toBeCalledWith"]}))]);
        let out = run_with(&only, &s, &r, &l);
        assert_eq!(why(&out, &["upgrade review", IN_EFFECT]), "no other records for vitest in the catalog");
    }

    #[test]
    fn a_deprecation_in_the_upgrade_window_cites_what_it_deprecates() {
        let c = catalog(
            "vitest",
            0,
            vec![with(
                rec("vitest:tobe", "pkg:npm/vitest", "4.1.0"),
                json!({"change_type":"deprecation","replaces":["toBeCalled"],"terms":[["toBeCalled",0],["toHaveBeenCalled",0]]}),
            )],
        );
        let s = stack(&[("vitest", "4.0.0")], None);
        let r = repo(&[("test/a.spec.ts", "import { expect } from 'vitest';\nexpect(spy).toHaveBeenCalled();")]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(ids(&out, &out.upgrade), vec!["vitest:tobe"]);
        let o = &out.opps[out.upgrade[0]];
        assert!(o.matched.is_empty() && o.files.is_empty(), "the replacement's name is not evidence: {:?}", o.matched);
        assert!(o.score > 0.0, "the queue's order still counts every literal");
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
        let r = repo(&[("prisma/schema.prisma", "datasource db {}"), ("src/db.ts", "import { PrismaClient } from 'prisma/client'; new PrismaClient({ datasourceUrl })")]);
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
    fn evidence_comes_from_files_that_can_use_the_technology() {
        let c = catalog(
            "zod",
            0,
            vec![
                with(rec("zod:data-only", "pkg:npm/zod", "4.1.0"), json!({"change_type":"new_api","benefit":["correctness"],"terms":[["currencyCode",0]]})),
                with(rec("zod:plain", "pkg:npm/zod", "4.1.0"), json!({"change_type":"new_api","benefit":["correctness"],"terms":[["shape",0],["z.object",0]]})),
            ],
        );
        let s = stack(&[("zod", "4.1.0")], None);
        let r = repo(&[
            ("devenv/dashboards/a.json", "{\"currencyCode\": \"EUR\", \"shape\": 1}"),
            ("src/theme.ts", "export const shape = { radius: 2 }"),
            ("src/schema.ts", "import * as z from 'zod'; export const S = z.object({ shape: z.string() })"),
        ]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        let data = out.opps.iter().find(|o| o.id() == "zod:data-only").unwrap();
        assert!(data.matched.is_empty() && data.files.is_empty() && data.score == 0.0, "dashboard JSON cannot use zod");
        let plain = out.opps.iter().find(|o| o.id() == "zod:plain").unwrap();
        assert_eq!(
            plain.matched,
            vec![("shape".to_string(), vec!["src/schema.ts".to_string()]), ("z.object".to_string(), vec!["src/schema.ts".to_string()])],
            "`shape` is shown only where zod is imported"
        );
        assert!(plain.score > 0.0);
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
    fn a_backport_to_a_line_below_the_installed_version_is_in_no_upgrade() {
        // DavidHDev/react-bits: react 19.1.1 installed, 19.3.1 the target. 19.0.4 shipped after 19.1.1 and before 19.3
        // began, so by date 19.3 has it, but a 19.1.x install never gets a 19.0.x release: the change arrives through
        // 19.1.5 (its own record, or a release of the same record), never through 19.0.4.
        let mut c = catalog(
            "react",
            0,
            vec![
                with(rec("react:only-old", "pkg:npm/react", "19.0.4"), json!({"change_type":"security","benefit":["security"]})),
                with(
                    rec("react:merged", "pkg:npm/react", "19.0.4"),
                    json!({"change_type":"security","benefit":["security"],"releases":[
                        {"component":"pkg:npm/react","version":"19.0.4","date":"2026-01-26","line":"19"},
                        {"component":"pkg:npm/react","version":"19.1.5","date":"2026-01-26","line":"19"},
                        {"component":"pkg:npm/react","version":"19.2.4","date":"2026-01-26","line":"19"}]}),
                ),
                rec("react:new", "pkg:npm/react", "19.3.1"),
            ],
        );
        let idx = |v: &str, d: &str, l: &str, s: bool| unstale_schema::catalog::IndexRelease { version: v.into(), date: d.into(), line: l.into(), line_start: s };
        c.techs.get_mut("react").unwrap().index.releases = vec![
            idx("19.0.4", "2026-01-26", "19.0", false),
            idx("19.1.1", "2025-07-28", "19.1", false),
            idx("19.1.5", "2026-01-26", "19.1", false),
            idx("19.2.4", "2026-01-26", "19.2", false),
            idx("19.3.0", "2026-09-09", "19.3", true),
            idx("19.3.1", "2026-10-14", "19.3", false),
        ];
        let (r, l) = (repo(&[]), Ledger::default());
        let s = stack(&[("react", "19.1.1")], None);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "react:only-old"), &Route::OlderLine, "19.0.4 is below 19.1.1, whatever its date");
        assert_eq!(route_of(&out, "react:merged"), &Route::BumpDigest);
        let o = out.opps.iter().find(|o| o.id() == "react:merged").unwrap();
        assert_ne!(o.release.version, "19.0.4", "cited by a release above the installed version");
        assert!(why(&out, &[]).contains("1 released only on older release lines than the installed version"), "{}", why(&out, &[]));
        // On the 19.0 line itself the backport is the upgrade.
        let s = stack(&[("react", "19.0.1")], None);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "react:only-old"), &Route::BumpDigest);
    }

    #[test]
    fn a_record_about_another_package_of_the_repository_applies_only_where_it_is_used() {
        // React's "React Server Components" section: central gives those records react-server-dom-* releases. A
        // client-only app (react, react-dom) gets none of them; an app on react-server-dom-webpack does.
        let rsc = |id: &str| {
            with(
                rec(id, "pkg:npm/react-server-dom-webpack", "19.1.5"),
                json!({"change_type":"security","benefit":["security"],"releases":[
                    {"component":"pkg:npm/react-server-dom-parcel","version":"19.1.5","date":"2026-01-26","line":"19"},
                    {"component":"pkg:npm/react-server-dom-webpack","version":"19.1.5","date":"2026-01-26","line":"19"}]}),
            )
        };
        let mut c = catalog("react", 0, vec![
                rsc("react:server-actions"),
                with(rec("react:fix", "pkg:npm/react", "19.1.5"), json!({"change_type":"fix"})),
                with(rec("react:dom", "pkg:npm/react-dom", "19.1.5"), json!({"change_type":"fix"})),
            ]);
        c.techs.get_mut("react").unwrap().index.components = vec!["pkg:npm/react".into()];
        let (r, l) = (repo(&[]), Ledger::default());
        let s = stack(&[("react", "19.1.1"), ("react-dom", "19.1.1")], None);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "react:server-actions"), &Route::OtherPackage);
        assert_eq!(route_of(&out, "react:fix"), &Route::BumpDigest);
        assert_eq!(route_of(&out, "react:dom"), &Route::BumpDigest, "a package of the repository that is used here");
        assert_eq!(out.packages["react"], vec!["react".to_string()], "the technology's packages are the index's");
        let s = stack(&[("react", "19.1.1"), ("react-server-dom-webpack", "19.1.1")], None);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "react:server-actions"), &Route::BumpDigest);
        assert_eq!(out.opps.iter().find(|o| o.id() == "react:server-actions").unwrap().component(), "pkg:npm/react-server-dom-webpack");
        // Without index components (an older catalog), every package a record names is the technology's: as before.
        c.techs.get_mut("react").unwrap().index.components = vec![];
        let s = stack(&[("react", "19.1.1")], None);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "react:server-actions"), &Route::BumpDigest);
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

    fn zod_removal() -> Catalog {
        catalog(
            "zod",
            0,
            vec![with(
                rec("zod:properties", "pkg:npm/zod", "4.6.3"),
                json!({"change_type":"removal","breaking":true,"terms":[["z.properties",0]]}),
            )],
        )
    }

    #[test]
    fn the_version_follows_the_code_when_no_importer_runs_the_headline() {
        // udecode/plate: the root's devDependency zod 4.1.12 is imported nowhere; apps/www locks 3.25.76 and a
        // library pins 3.25.61, and they hold every importer. The reviews use apps/www's version, and a file under the
        // root (on 4.x) that matches the term is not cited.
        let c = zod_removal();
        let mut s = stack(&[], None);
        let mut d = crate::stack::Dep::new("zod", true);
        d.read(".", parse_version("4.1.12"), "pnpm-lock.yaml".into());
        d.read("apps/www", parse_version("3.25.76"), "pnpm-lock.yaml".into());
        d.read_in("packages/udecode/lib", parse_version("3.25.61"), "library floor of 3.25.61".into(), false, Some(crate::stack::Range::Npm("3.25.61".into())));
        s.deps.insert(crate::util::npm_purl("zod"), d);
        s.settle();
        let r = repo(&[
            ("apps/www/src/a.ts", "import { z } from 'zod'; export const A = z.properties({})"),
            ("packages/udecode/lib/src/b.ts", "import { z } from 'zod'; export const B = z.properties({})"),
            ("scripts/c.ts", "export const C = z.properties({})"),
        ]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "zod:properties").unwrap();
        assert_eq!((o.installed.to_string(), &o.route), ("3.25.76".into(), &Route::UpgradeReview));
        assert_eq!(o.files, vec!["apps/www/src/a.ts".to_string(), "packages/udecode/lib/src/b.ts".to_string()], "scripts/ resolves the root's 4.1.12");
        assert!(o.elsewhere.is_empty(), "no file under the root imports zod: {:?}", o.elsewhere);
        assert_eq!(out.headline["pkg:npm/zod"], ("apps/www".to_string(), "pnpm-lock.yaml".to_string()));
        assert_eq!(out.versions["pkg:npm/zod"], Version::new(3, 25, 76));
        assert!(out.version_notes.iter().any(|n| n.starts_with("zod: the reviews use 3.25.76 in apps/www (pnpm-lock.yaml)")), "{:?}", out.version_notes);
        let lines = crate::review::digest_lines(&out);
        assert!(lines.iter().any(|l| l.starts_with("  4.1.12 in the root (pnpm-lock.yaml): bumping to 4.6.3")), "{lines:?}");
        assert!(lines.iter().any(|l| l.starts_with("  3.25.61 in packages/udecode/lib")), "{lines:?}");
        assert!(!lines.iter().any(|l| l.starts_with("  3.25.76")), "the headline is not also a workspace line: {lines:?}");
    }

    #[test]
    fn code_on_another_release_line_is_not_cited() {
        // The root imports zod 4 itself, so it keeps the headline; apps/old locks 3.x and its importer is left out
        // and named. A library whose peer range admits the root's version is written for it, so it is cited.
        let c = zod_removal();
        let mut s = stack(&[], None);
        let mut d = crate::stack::Dep::new("zod", true);
        d.read(".", parse_version("4.1.12"), "pnpm-lock.yaml".into());
        d.read("apps/old", parse_version("3.25.76"), "pnpm-lock.yaml".into());
        d.read_in("packages/peer", parse_version("3.0.0"), "library floor of >=3.0.0".into(), false, Some(crate::stack::Range::Npm(">=3.0.0".into())));
        s.deps.insert(crate::util::npm_purl("zod"), d);
        s.settle();
        let r = repo(&[
            ("src/x.ts", "import { z } from 'zod'; export const X = z.properties({})"),
            ("apps/old/src/y.ts", "import { z } from 'zod'; export const Y = z.properties({})"),
            ("packages/peer/src/z.ts", "import { z } from 'zod'; export const Z = z.properties({})"),
        ]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "zod:properties").unwrap();
        assert_eq!(o.installed, Version::new(4, 1, 12));
        assert_eq!(o.files, vec!["packages/peer/src/z.ts".to_string(), "src/x.ts".to_string()]);
        assert_eq!(o.elsewhere, vec!["apps/old (zod 3.25.76)".to_string()]);
        assert!(!out.headline.is_empty() && out.headline["pkg:npm/zod"].0 == ".");
        assert!(out.version_notes.iter().any(|n| n.contains("under apps/old (3.25.76) runs another release line than the reviews' 4.1.12")), "{:?}", out.version_notes);
        let skill = crate::review::render_record_for_test(&out, "zod:properties");
        assert!(skill.contains("- Not cited: code importing it under apps/old (zod 3.25.76), which runs another release line than installed 4.1.12"), "{skill}");
    }

    #[test]
    fn a_package_left_out_elsewhere_does_not_hide_evidence_for_its_sibling() {
        // One technology, two packages: apps/old runs ui-dom on another line, ui on the headline's. A ui record
        // still cites apps/old; a ui-dom record does not.
        let c = catalog(
            "ui",
            0,
            vec![
                with(rec("ui:a", "pkg:npm/ui", "2.5.0"), json!({"change_type":"removal","breaking":true,"terms":[["useThing",0]]})),
                with(rec("ui:b", "pkg:npm/ui-dom", "2.5.0"), json!({"change_type":"removal","breaking":true,"terms":[["useThing",0]]})),
            ],
        );
        let mut s = stack(&[], None);
        let mut ui = crate::stack::Dep::new("ui", true);
        ui.read(".", parse_version("2.1.0"), "package-lock.json".into());
        ui.read("apps/old", parse_version("2.0.0"), "package-lock.json".into());
        let mut dom = crate::stack::Dep::new("ui-dom", true);
        dom.read(".", parse_version("2.1.0"), "package-lock.json".into());
        dom.read("apps/old", parse_version("1.9.0"), "package-lock.json".into());
        s.deps.insert(crate::util::npm_purl("ui"), ui);
        s.deps.insert(crate::util::npm_purl("ui-dom"), dom);
        s.settle();
        let r = repo(&[
            ("src/x.ts", "import { useThing } from 'ui'; import 'ui-dom'; useThing()"),
            ("apps/old/src/y.ts", "import { useThing } from 'ui'; import 'ui-dom'; useThing()"),
        ]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        let files = |id: &str| out.opps.iter().find(|o| o.id() == id).unwrap().files.clone();
        assert_eq!(files("ui:a"), vec!["apps/old/src/y.ts".to_string(), "src/x.ts".to_string()]);
        assert_eq!(files("ui:b"), vec!["src/x.ts".to_string()]);
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
    fn no_technology_names_a_deferred_registration_instead_of_sync() {
        let (c, s, r, l) = (Catalog::default(), stack(&[("next", "16.0.0")], None), repo(&[]), Ledger::default());
        let mut out = run_with(&c, &s, &r, &l);
        assert!(why(&out, &["bump digest"]).contains("run `unstale sync`"));
        out.uncovered = Some("coverage is deferred because the coverage service is temporarily unavailable until 00:00 UTC".into());
        let w = why(&out, &["bump digest"]);
        assert!(w.starts_with("no catalog technology covers this repository yet: coverage is deferred because") && !w.contains("sync"), "{w}");
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

    #[test]
    fn the_improvements_pass_leaves_out_an_older_lines_long_standing_api() {
        // n8n-io/n8n: jsdom 23.0.1 was offered jsdom 6.3.0's `window.atob` and 16.0.0's `Comment` constructor.
        let mut c = catalog(
            "jsdom",
            0,
            vec![
                with(rec("jsdom:atob", "pkg:npm/jsdom", "6.3.0"), json!({"benefit":["correctness"],"releases":[{"component":"pkg:npm/jsdom","version":"6.3.0","date":"2015-08-30","line":"6"}]})),
                // An older line, but within a year of the installed version: still new to adopt (electron, vitest majors).
                with(rec("jsdom:recent", "pkg:npm/jsdom", "22.1.0"), json!({"releases":[{"component":"pkg:npm/jsdom","version":"22.1.0","date":"2023-06-01","line":"22"}]})),
                // The installed line, however old.
                with(rec("jsdom:same", "pkg:npm/jsdom", "23.0.0"), json!({"releases":[{"component":"pkg:npm/jsdom","version":"23.0.0","date":"2023-11-01","line":"23"}]})),
                rec("jsdom:newest", "pkg:npm/jsdom", "24.0.0"),
            ],
        );
        let idx = |v: &str, d: &str, l: &str, s: bool| unstale_schema::catalog::IndexRelease { version: v.into(), date: d.into(), line: l.into(), line_start: s };
        c.techs.get_mut("jsdom").unwrap().index.releases = vec![
            idx("6.3.0", "2015-08-30", "6", true),
            idx("22.1.0", "2023-06-01", "22", true),
            idx("23.0.0", "2023-11-01", "23", true),
            idx("23.0.1", "2023-11-30", "23", false),
            idx("24.0.0", "2024-02-01", "24", true),
        ];
        let (r, l) = (repo(&[]), Ledger::default());
        let s = stack(&[("jsdom", "23.0.1")], None);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "jsdom:atob"), &Route::Baseline);
        assert_eq!(ids(&out, &out.improvements), vec!["jsdom:recent", "jsdom:same"]);
        assert!(why(&out, &[]).contains("1 opt-in from an older release line"), "{}", why(&out, &[]));
        // Without a date for the installed version the record stays (fail open).
        for x in c.techs.get_mut("jsdom").unwrap().index.releases.iter_mut().filter(|x| x.version == "23.0.1") {
            x.date = String::new();
        }
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "jsdom:atob"), &Route::ImprovementsPass);
    }

    #[test]
    fn the_improvements_pass_leaves_out_an_opt_in_whose_requires_is_absent() {
        // n8n-io/n8n: knip's Stencil support took a batch slot with "Requires `@stencil/core` (not found)".
        let c = catalog(
            "knip",
            0,
            vec![
                with(rec("knip:stencil", "pkg:npm/knip", "6.16.0"), json!({"change_type":"new_option","requires":["@stencil/core"],"terms":[["knip.ts",0]]})),
                rec("knip:newest", "pkg:npm/knip", "6.40.0"),
            ],
        );
        let (s, l) = (stack(&[("knip", "6.35.1")], None), Ledger::default());
        let r = repo(&[("knip.ts", "export default {}")]);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "knip:stencil"), &Route::RequiresAbsent);
        assert!(out.improvements.is_empty());
        let r = repo(&[("package.json", r#"{"dependencies":{"@stencil/core":"4.0.0"}}"#)]);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "knip:stencil"), &Route::ImprovementsPass);
    }

    #[test]
    fn the_tools_own_build_and_configuration_handling_is_not_opt_in() {
        let t = |id: &str, ct: &str, surface: &str, v: &str| with(rec(id, "pkg:npm/knip", v), json!({"change_type": ct, "surface": surface}));
        let c = catalog(
            "knip",
            0,
            vec![
                t("knip:custom-elements", "tooling", "build_tooling", "6.16.0"),
                t("knip:orval", "tooling", "configuration", "6.15.0"),
                t("knip:rust-builds", "stability_change", "build_tooling", "6.15.0"),
                t("knip:vite8", "tooling", "build_tooling", "6.40.0"),
                // A new command or flag is still adopted by whoever runs it.
                t("knip:new-command", "tooling", "command_line", "6.16.0"),
                rec("knip:newest", "pkg:npm/knip", "6.40.0"),
            ],
        );
        let (s, r, l) = (stack(&[("knip", "6.35.1")], None), repo(&[]), Ledger::default());
        let out = run_with(&c, &s, &r, &l);
        for id in ["knip:custom-elements", "knip:orval", "knip:rust-builds"] {
            assert_eq!(route_of(&out, id), &Route::AlreadyIncluded, "{id}");
        }
        assert_eq!(route_of(&out, "knip:vite8"), &Route::BumpDigest, "arrives with the bump, nothing to adopt");
        assert_eq!(route_of(&out, "knip:new-command"), &Route::ImprovementsPass);
    }

    #[test]
    fn a_cli_flag_counts_only_on_a_command_line_that_runs_the_technology() {
        // n8n-io/n8n: turbo's deprecated `--scope` matched n8n's own CLI help and `claude mcp add --scope` strings.
        let c = catalog(
            "turbo",
            0,
            vec![
                with(rec("turbo:prune-scope", "pkg:npm/turbo", "2.8.17"), json!({"change_type":"deprecation","replaces":["--scope"],"terms":[["--scope",0],["turbo prune",0]]})),
                with(rec("turbo:json", "pkg:npm/turbo", "2.9.0"), json!({"change_type":"new_option","introduces":["--json-logs"]})),
                rec("turbo:newest", "pkg:npm/turbo", "2.12.0"),
            ],
        );
        let (s, l) = (stack(&[("turbo", "2.11.4")], None), Ledger::default());
        let other = repo(&[
            ("src/cli/list.ts", "const usage = 'promotion-connection list --scope=instance';"),
            ("src/setup.test.ts", "expect(cmd).toBe('claude mcp add --scope user');\nconst x = 'tool --json-logs';"),
            ("src/style.css", ":root { --scope: 1px; }"),
        ]);
        let out = run_with(&c, &s, &other, &l);
        assert_eq!(route_of(&out, "turbo:prune-scope"), &Route::AlreadyIncluded, "no turbo command line uses it");
        assert_eq!(route_of(&out, "turbo:json"), &Route::ImprovementsPass, "another tool's flag does not apply it");
        let runs = repo(&[(
            "package.json",
            "{\"devDependencies\": {\"turbo\": \"2.11.4\"},\n\"scripts\": {\"prune\": \"pnpm turbo prune --scope=api --docker\", \"build\": \"turbo run build \\\\\n --json-logs\"}}",
        )]);
        let out = run_with(&c, &s, &runs, &l);
        assert_eq!(ids(&out, &out.in_effect), vec!["turbo:prune-scope"]);
        let o = out.opps.iter().find(|o| o.id() == "turbo:prune-scope").unwrap();
        assert_eq!(o.matched, vec![("--scope".to_string(), vec!["package.json".to_string()])]);
        assert_eq!(route_of(&out, "turbo:json"), &Route::Applied, "a continued command line counts");
    }

    #[test]
    fn a_package_subpath_matches_only_where_the_package_subpath_is_named() {
        let c = catalog(
            "vitest",
            0,
            vec![
                // A subpath of vitest's own exports: the record names the `exports` field.
                with(rec("vitest:src", "pkg:npm/vitest", "5.0.0"), json!({"change_type":"removal","breaking":true,"replaces":["./src/*"],"terms":[["./src/*",0],["exports",0],["package.json",0]]})),
                // Named next to `vitest/config` itself.
                with(rec("vitest:config", "pkg:npm/vitest", "5.0.0"), json!({"change_type":"new_api","benefit":["correctness"],"terms":[["./config",0],["vitest/config",0]]})),
                // A path of the repository: matched as it is, but never in the manifest's own layout.
                with(rec("vitest:dir", "pkg:npm/vitest", "5.0.0"), json!({"change_type":"behavior_change","terms":[["./tests",0]]})),
                // Nor by its tail (`client`) there.
                with(rec("vitest:tail", "pkg:npm/vitest", "5.0.0"), json!({"change_type":"behavior_change","terms":[["./tests/setup.client",0]]})),
            ],
        );
        let s = stack(&[("vitest", "4.1.0")], None);
        let manifest = r#"{"name":"lib","main":"./tests/x.js","exports":{".":"./dist/x.js","./src/*":"./src/*"},"files":["./tests","./tests/setup.client"],"devDependencies":{"vitest":"^4.1.0"}}"#;
        let r = repo(&[
            ("package.json", manifest),
            ("tsconfig.json", r#"{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}"#),
            ("src/a.test.ts", "import { test } from 'vitest';\nimport cfg from './config';\n"),
        ]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        let m = |id: &str| out.opps.iter().find(|o| o.id() == id).unwrap().matched.clone();
        assert!(m("vitest:src").iter().all(|(t, _)| t != "./src/*"), "{:?}", m("vitest:src"));
        assert!(m("vitest:config").iter().all(|(t, _)| t != "./config"), "a relative import is the repository's module: {:?}", m("vitest:config"));
        assert!(m("vitest:dir").is_empty(), "main and files are the package's own layout: {:?}", m("vitest:dir"));
        let tail = out.opps.iter().find(|o| o.id() == "vitest:tail").unwrap();
        assert!(tail.matched.is_empty() && tail.score == 0.0, "its tail does not count for the order either: {}", tail.score);
        // An import of the subpath, or a config value quoting it, is the dependency's subpath.
        // A relative path outside the manifest's own layout (a script's argument) still counts.
        let scripted = manifest.replace(r#""devDependencies""#, r#""scripts":{"t":"vitest ./tests"},"devDependencies""#);
        let r = repo(&[
            ("package.json", scripted.as_str()),
            ("src/b.test.ts", "import { x } from 'vitest/src/runtime';\n"),
            ("vitest.config.ts", "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ setupFiles: ['vitest/src/setup'] })\n"),
        ]);
        let out = run_with(&c, &s, &r, &l);
        let m = |id: &str| out.opps.iter().find(|o| o.id() == id).unwrap().matched.clone();
        let mut src = m("vitest:src").into_iter().find(|(t, _)| t == "./src/*").map(|(_, f)| f).unwrap_or_default();
        src.sort();
        assert_eq!(src, vec!["src/b.test.ts".to_string(), "vitest.config.ts".to_string()]);
        let cfg = m("vitest:config").into_iter().find(|(t, _)| t == "./config").map(|(_, f)| f).unwrap_or_default();
        assert_eq!(cfg, vec!["vitest.config.ts".to_string()]);
        assert_eq!(m("vitest:dir"), vec![("./tests".to_string(), vec!["package.json".to_string()])]);
    }
}
