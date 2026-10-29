//! The relevance funnel at the edge: availability, blocked, the ledger, applied, routing to the three outputs and
//! their order. Computed on every run, never stored.

use semver::Version;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;
use unstale_schema::catalog::{Benefit, ChangeType, IndexRelease, Release, SubjectKind, Surface};
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
    /// Opt-in and installed on the installed line, released at least `BASELINE_DAYS` before the installed version, and
    /// this code shows no site for it: no `replaces` it uses, no specific term (not a plain word) in a file about the
    /// technology. What every user of the version has had for a year is part of it, not an opt-in left to apply
    /// (jsdom 16.0.0's working `Comment` constructor at 16.7.0, matched only by `Node`) (`settled`).
    NoSite,
    /// Opt-in and installed, but a later release at or below the installed version removed or deprecated every API it
    /// introduces (open 7.0.0's `url` option, removed in 8.0.0, at 9.1.0): nothing left to adopt (`retire_opt_ins`).
    Retired,
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
    /// The record's release is only bounded (`Release::no_later_than`) and the installed or target version lies inside
    /// the bound: whether that version has the change is not known.
    ReleaseUnknown,
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
    /// Per matched deprecated literal: how many more files use it than the three `matched` lists (none: all listed).
    pub more: BTreeMap<String, usize>,
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
    /// A deprecation about a part of a surviving name (`deprecated_part`): its sites match the name only.
    pub part: Option<Part>,
    /// A deprecation or removal cited at its `replaces` literals whose named replacement (an `introduces` literal, not
    /// a plain word) the repository
    /// already writes, whole and outside comments, in a file about the technology (not documentation, generated or
    /// vendored text): (replacement, file). The project has the new form; the old sites left are a kept path or the
    /// last of a migration, so the record never leads an upgrade (lower urgency), and stays in its review.
    pub adopted: Option<(String, String)>,
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
    /// Why nothing was checked, when no dependency was read at all (`stack::unread_note`); set by the caller.
    pub unread: Option<String>,
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
    /// When `moved` is another independent project's headline: the files importing the package in `head`'s project
    /// and in `moved`'s (`Dep::project_head`).
    used_most: Option<(usize, usize)>,
    /// Readings that do not fit `head`: their files are left out of the evidence.
    off: Vec<&'d Reading>,
    /// Of `off`, those whose directory holds code importing the package.
    off_sites: Vec<&'d Reading>,
}

/// Whether `path` is a dependency manifest (`package.json`, `pyproject.toml`, a requirements file, …): it declares the
/// package for its reading, which is no code using it. A tool run through its config files (`tsconfig.json`,
/// `vite.config.ts`: `usage::Scope::runs_from`) is used by the package holding them, as code importing it is (`choose`).
fn manifest_file(path: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path);
    matches!(base, "package.json" | "pyproject.toml" | "setup.py" | "setup.cfg" | "Pipfile") || (base.starts_with("requirements") && base.ends_with(".txt"))
}

/// Packages of one technology installed side by side (`run`): pairs of `present` that one manifest both installs, at
/// least one of them through an npm alias, with that manifest's directory; and every package in such a pair.
struct SideBySide<'p> {
    pairs: Vec<(String, &'p String, &'p String)>,
    members: BTreeSet<String>,
}

fn side_by_side<'p>(stack: &Stack, present: &[&'p String]) -> SideBySide<'p> {
    let mut out = SideBySide { pairs: vec![], members: BTreeSet::new() };
    for (i, a) in present.iter().enumerate() {
        for b in &present[i + 1..] {
            let (Some(da), Some(db)) = (stack.deps.get(*a), stack.deps.get(*b)) else { continue };
            let dir = da.readings.iter().map(|r| &r.dir).find(|d| {
                db.readings.iter().any(|r| r.dir == **d) && (da.alias_dirs.contains(*d) || db.alias_dirs.contains(*d))
            });
            if let Some(dir) = dir {
                out.pairs.push((dir.clone(), *a, *b));
                out.members.insert(normalize_purl(a));
                out.members.insert(normalize_purl(b));
            }
        }
    }
    out
}

fn choose<'d>(d: &'d Dep, sites: impl FnOnce() -> Vec<String>) -> Option<Choice<'d>> {
    let h = d.headline()?;
    if d.readings.iter().all(|r| r.fits(&h.version)) {
        return Some(Choice { head: h, moved: None, used_most: None, off: vec![], off_sites: vec![] });
    }
    let sites = sites();
    // Independent projects: the one whose code imports the package most sets the version (`Dep::project_head`).
    let (h, first, used_most) = match d.project_head(h, &sites) {
        Some((r, n, m)) => (r, Some(h), Some((n, m))),
        None => (h, None, None),
    };
    let held: Vec<&Reading> = {
        let mut v: Vec<&Reading> = sites.iter().filter_map(|p| d.owner(p)).collect();
        v.sort_by(|a, b| a.dir.cmp(&b.dir));
        v.dedup_by(|a, b| a.dir == b.dir);
        v
    };
    let (head, moved) = match held.iter().any(|r| r.runs(&h.version)) || held.is_empty() {
        true => (h, first),
        // An unlocked standalone manifest never sets the version while a covered one declares the package (`Reading::
        // standalone`): its code is left uncited instead (`off_sites`).
        false => match d.headline_among(|r| (h.standalone || !r.standalone) && held.iter().any(|x| x.dir == r.dir)) {
            Some(r) => (r, Some(h)),
            None => (h, None),
        },
    };
    let off: Vec<&Reading> = d.readings.iter().filter(|r| !r.fits(&head.version)).collect();
    let off_sites = off.iter().copied().filter(|r| held.iter().any(|x| x.dir == r.dir)).collect();
    let used_most = used_most.filter(|_| moved == first && first.is_some());
    Some(Choice { head, moved, used_most, off, off_sites })
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
    /// The lockfiles those manifests read (`Reading::lock`): a prerequisite is checked against each root's floor.
    pub locks: Vec<Option<String>>,
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
/// without `replaces`, except one whose summary says its subject is deprecated (`The headerIds option is
/// deprecated; use marked-gfm-heading-id instead`): that subject is what it deprecates.
pub fn deprecated_lits(r: &Rec, lits: &[String]) -> Vec<String> {
    if r.r.change_type != ChangeType::Deprecation {
        return vec![];
    }
    let mut replaces: BTreeSet<String> = r.r.replaces.iter().filter_map(|x| clean_lit(x)).collect();
    if replaces.is_empty()
        && let Some(subject) = clean_lit(&r.r.subject)
    {
        // `<subject> [option|method|…] is deprecated`: the subject, as a whole word, then only a kind noun and a form
        // of "to be" before the summary's first `deprecat…`. Anything else between (`X replaces the deprecated Y`)
        // makes the subject something other than the deprecated thing.
        const BETWEEN: &[&str] = &[
            "is", "are", "was", "were", "has", "have", "been", "now", "also", "option", "options", "flag", "method", "property",
            "function", "api", "setting", "parameter", "argument", "field", "export", "module", "hook", "prop", "component",
            "class", "type", "config", "configuration", "key", "attribute", "command", "rule",
        ];
        let head = r.r.summary.to_ascii_lowercase();
        let head = &head[..head.find("deprecat").unwrap_or(0)];
        let s = subject.to_ascii_lowercase();
        let whole = head.match_indices(s.as_str()).any(|(i, _)| {
            let ok = |c: Option<char>| c.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
            let rest = &head[i + s.len()..];
            ok(head[..i].chars().next_back())
                && ok(rest.chars().next())
                && rest.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).all(|w| BETWEEN.contains(&w))
        });
        if whole {
            replaces.insert(subject);
        }
    }
    lits.iter().filter(|l| replaces.contains(*l)).cloned().collect()
}

/// What part of a surviving API a deprecation is about (`deprecated_part`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    /// An argument or parameter of a call (commander's "callback parameter to outputHelp"): only calls passing one can
    /// use it.
    Argument,
    /// Another form of the same name (google-genai's "legacy response_format", whose new polymorphic form keeps the
    /// name): no site can tell the two apart lexically.
    Form,
}

/// A code deprecation about a part of its subject rather than the subject itself: an argument, or a legacy form whose
/// name the current form keeps. The record says so in its `facet`, or in words its summary writes before the subject
/// ("The callback parameter to outputHelp"), or a structural noun anywhere before "deprecat…" ("The old outputHelp
/// signature"); a kind noun after the subject ("The
/// `headerIds` option is deprecated") names what the subject is, not a part of it. An adjective alone ("The legacy
/// response_format", "The older prisma-client-js provider") may describe the deprecated thing itself, so it reads as a
/// form only where the name lives on: another record of the technology (`siblings`), at or after this one's release,
/// adds to the same subject (google-genai's "Added parameters to video response_format", 2.1.0, after the 2.0.0
/// deprecation). Only for a record that deprecates its subject by name (`replaces` empty or only the subject) and names
/// no successor of another name (`introduces`). Configuration records have their own facet reading (`option_of`,
/// `option_values`).
pub fn deprecated_part(r: &unstale_schema::catalog::CapabilityRecord, siblings: &[Rec]) -> Option<Part> {
    if r.change_type != ChangeType::Deprecation || r.surface == Surface::Configuration || r.subject_kind != SubjectKind::Literal {
        return None;
    }
    let subject = clean_lit(&r.subject)?;
    if r.replaces.iter().any(|x| clean_lit(x).as_deref() != Some(subject.as_str()) || usage::call_arity(x).is_some())
        || r.introduces.iter().any(|x| clean_lit(x).is_some_and(|x| x != subject))
    {
        return None;
    }
    const ARGUMENT: &[&str] = &["parameter", "parameters", "param", "params", "argument", "arguments", "arg", "args", "callback", "positional", "kwarg", "kwargs"];
    const FORM: &[&str] = &["form", "forms", "shape", "variant", "signature", "overload", "syntax"];
    const OLD: &[&str] = &["legacy", "old", "older", "previous"];
    let words = |s: &str| -> Vec<String> { s.to_ascii_lowercase().split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect() };
    let summary = r.summary.to_ascii_lowercase();
    let head = &summary[..summary.find("deprecat").unwrap_or(0)];
    let s = subject.to_ascii_lowercase();
    // The words before the subject's first whole-word occurrence in the summary's head.
    let at = head.match_indices(s.as_str()).find(|(i, _)| {
        let ok = |c: Option<char>| c.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
        ok(head[..*i].chars().next_back()) && ok(head[i + s.len()..].chars().next())
    });
    let mut said = r.facet.as_deref().map(words).unwrap_or_default();
    if let Some((i, _)) = at {
        said.extend(words(&head[..i]));
    }
    let own = words(&subject);
    let said: Vec<String> = said.into_iter().filter(|w| !own.contains(w)).collect();
    // A structural noun is a part wherever the head writes it ("The old outputHelp signature").
    let shaped = words(head).iter().chain(&said).any(|w| !own.contains(w) && FORM.contains(&w.as_str()));
    if said.iter().any(|w| ARGUMENT.contains(&w.as_str())) {
        Some(Part::Argument)
    } else if shaped || (said.iter().any(|w| OLD.contains(&w.as_str())) && lives_on(r, &subject, siblings)) {
        Some(Part::Form)
    } else {
        None
    }
}

/// Whether another record of the technology, released at or after `r`, adds to `subject` (a new API or option, or a
/// behaviour change of it): the name lives on past `r`'s deprecation.
fn lives_on(r: &unstale_schema::catalog::CapabilityRecord, subject: &str, siblings: &[Rec]) -> bool {
    let versions = |x: &unstale_schema::catalog::CapabilityRecord| x.releases.iter().filter_map(|v| parse_version(&v.version)).collect::<Vec<_>>();
    // The deprecation's earliest release; a sibling counts when any of its releases is at or after it.
    let Some(since) = versions(r).into_iter().min() else { return false };
    siblings.iter().map(|s| &s.r).any(|s| {
        s.id != r.id
            && matches!(s.change_type, ChangeType::NewApi | ChangeType::NewOption | ChangeType::BehaviorChange)
            && (clean_lit(&s.subject).as_deref() == Some(subject) || s.introduces.iter().any(|x| clean_lit(x).as_deref() == Some(subject)))
            && versions(s).iter().any(|v| *v >= since)
    })
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

/// Project boundaries, deepest first: every manifest's directory and every directory holding a `project.json` (an Nx
/// project, which a root manifest declaring every dependency does not tell apart).
fn boundaries<'p>(packages: &'p [crate::stack::Package], paths: &'p [String]) -> Vec<&'p str> {
    let projects = paths.iter().filter_map(|p| match p.rsplit_once('/') {
        Some((dir, "project.json")) => Some(dir),
        None if p == "project.json" => Some("."),
        _ => None,
    });
    let mut out: Vec<&str> = packages.iter().map(|p| p.dir.as_str()).chain(projects).collect();
    out.sort_unstable_by_key(|d| (std::cmp::Reverse(if *d == "." { 0 } else { d.len() }), *d));
    out.dedup();
    out
}

/// The tools the repository declares, by the name their config files take (`usage::config_tool`): a package's name, or
/// its scope (`@vitejs/plugin-react` → `vitejs`), lowercase.
fn tools(packages: &[crate::stack::Package]) -> std::collections::HashSet<String> {
    let names = packages.iter().flat_map(|p| &p.declared).filter_map(|d| purl_name(d));
    names.map(|n| n.to_ascii_lowercase()).map(|n| n.strip_prefix('@').map_or(n.clone(), |s| s.split('/').next().unwrap_or("").to_string())).collect()
}

/// Whether a record's deprecated identifier `lit` is an object property or option key: the record is about
/// configuration, or one of its literals is a qualified name ending in it (`meta.defaultOptions` for `defaultOptions`).
/// Its sites in code are then where it is written as a key or member (`usage::live_site_near`).
fn keyed_api(r: &unstale_schema::catalog::CapabilityRecord, lits: &[String], lit: &str) -> bool {
    usage::identifier(lit)
        && (r.surface == Surface::Configuration
            || lits.iter().chain(&r.introduces).any(|x| x != lit && usage::qualified_name(x) && x.rsplit('.').next() == Some(lit)))
}

/// The words of what replaces a deprecation (`introduces`: `proxy` for Next.js's `middleware`), lowercase: single
/// identifiers and file names' stems only (`proxy.ts` → `proxy`), split at case changes and `_`/`-` (`createProxy` →
/// `create`, `proxy`); words under three letters dropped. A file named for the deprecated convention that imports a name of these words from the technology already
/// uses the successor (`usage::imports_successor`).
fn successor_words(r: &unstale_schema::catalog::CapabilityRecord) -> Vec<String> {
    let stem = |x: String| -> Option<String> {
        if usage::file_name(&x) {
            x.trim_start_matches('.').split('.').next().map(str::to_string)
        } else {
            (!x.contains(['.', '/']) && !x.contains(char::is_whitespace)).then_some(x)
        }
    };
    let mut out: Vec<String> =
        r.introduces.iter().filter_map(|x| clean_lit(x)).filter_map(stem).flat_map(|x| usage::camel_words(&x)).filter(|w| w.len() >= 3).collect();
    out.sort();
    out.dedup();
    out
}

/// The lint tool and rule namespace a plugin package gives its rules, by the plugin naming convention every linter
/// shares (ESLint, Stylelint, oxlint): `eslint-plugin-jsdoc` → (`eslint`, `jsdoc`), `@scope/eslint-plugin` →
/// (`eslint`, `@scope`), `@scope/eslint-plugin-x` → (`eslint`, `@scope/x`).
fn lint_namespace(package: &str) -> Option<(String, String)> {
    let (scope, base) = match package.strip_prefix('@').and_then(|p| p.split_once('/')) {
        Some((s, b)) => (Some(s), b),
        None => (None, package),
    };
    let (tool, rest) = base.split_once("-plugin").filter(|(t, _)| !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric()))?;
    let ns = match (scope, rest.strip_prefix('-')) {
        (Some(s), None) if rest.is_empty() => format!("@{s}"),
        (Some(s), Some(x)) if !x.is_empty() => format!("@{s}/{x}"),
        (None, Some(x)) if !x.is_empty() => x.to_string(),
        _ => return None,
    };
    Some((tool.to_string(), ns))
}

/// A lint plugin among a technology's packages, with the tool config files that refer to it (`lint_plugins`).
struct LintPlugin<'r> {
    /// The rule namespace with its slash (`jsdoc/`).
    prefix: String,
    configs: Vec<&'r str>,
    /// A config uses one of the plugin's presets (`plugin:<ns>/…`, or `<binding>.configs` of the plugin's import).
    preset: bool,
}

/// The technology's lint plugins (`lint_namespace`), each with the texts that configure it: the tool's config files
/// (`usage::config_tool`) that refer to it, and other files writing its rules under `rules`.
fn lint_plugins<'r>(comps: &BTreeSet<String>, repo: &'r Repo) -> Vec<LintPlugin<'r>> {
    let mut out = vec![];
    for (tool, ns, pkg) in comps.iter().filter_map(|c| purl_name(c)).filter_map(|p| lint_namespace(&p).map(|(t, n)| (t, n, p))) {
        let prefix = format!("{ns}/");
        // The tool's own config files, and any other file (a shared config module, `eslint/base.mjs`) that writes
        // one of the plugin's rules as a quoted key or loads the plugin; documentation never configures it.
        let quoted = [format!("'{prefix}"), format!("\"{prefix}")];
        let configs: Vec<&str> = repo
            .paths
            .iter()
            .filter(|p| !matches!(repo.role(p), usage::Role::Docs | usage::Role::Generated | usage::Role::Vendored))
            .filter_map(|p| repo.text(p).map(|t| (p, t)))
            .filter(|(p, t)| {
                let tool_config = usage::config_tool(p).as_deref() == Some(tool.as_str());
                (tool_config && (t.contains(&prefix) || t.contains(pkg.as_str()))) || quoted.iter().any(|q| t.contains(q.as_str())) && (tool_config || t.contains(pkg.as_str()) || t.contains("rules"))
            })
            .map(|(_, t)| t)
            .collect();
        let preset = configs.iter().any(|t| t.contains(&format!("plugin:{prefix}")) || import_bindings(t, &pkg).iter().any(|b| t.contains(&format!("{b}.configs"))));
        out.push(LintPlugin { prefix, configs, preset });
    }
    out
}

/// Whether a lint plugin's record is about rules this repository's lint configuration never turns on, so it has no
/// site here (dolanmiu/docx: a `jsdoc/prefer-import-tag` change where `eslint.config.ts` enables only
/// `jsdoc/check-alignment`; its other terms, `@param` and `@property`, are in every documented file). A record is
/// rule-scoped when a term names a rule under the plugin's namespace. It is judged only where the tool's config files
/// refer to the plugin: a rule is on when written with a value other than `off` / `0`, and every rule counts as on once
/// a config uses one of the plugin's presets, whose rules are not visible here. A plugin loaded only through a shared
/// config package is not judged (false).
fn rule_not_enabled(r: &unstale_schema::catalog::CapabilityRecord, plugins: &[LintPlugin]) -> bool {
    let rule = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-';
    for pl in plugins {
        let ids: Vec<String> = r
            .terms
            .iter()
            .map(|t| &t.0)
            .chain(&r.replaces)
            .filter_map(|t| clean_lit(t))
            .filter(|l| l.strip_prefix(&pl.prefix).is_some_and(|x| !x.is_empty() && x.chars().all(rule)))
            .collect();
        if ids.is_empty() {
            continue;
        }
        return !(pl.configs.is_empty() || pl.preset || ids.iter().any(|id| pl.configs.iter().any(|t| rule_on(t, id))));
    }
    false
}

/// Whether a config text sets rule `id` (quoted, as a key) to a value other than `off` or `0`.
fn rule_on(text: &str, id: &str) -> bool {
    for q in ['"', '\'', '`'] {
        let key = format!("{q}{id}{q}");
        for (i, _) in text.match_indices(&key) {
            let rest = text[i + key.len()..].trim_start();
            let Some(rest) = rest.strip_prefix(':') else { continue };
            let v = rest.trim_start().trim_start_matches('[').trim_start().trim_start_matches(['"', '\'', '`']);
            let off = v.starts_with("off") || (v.starts_with('0') && !v[1..].starts_with(|c: char| c.is_ascii_digit()));
            if !off {
                return true;
            }
        }
    }
    false
}

/// The names a JavaScript config binds a package's import to (`import jsdoc from 'eslint-plugin-jsdoc'`,
/// `import * as jsdoc from …`, `const jsdoc = require('eslint-plugin-jsdoc')`).
fn import_bindings(text: &str, pkg: &str) -> Vec<String> {
    let mut out = vec![];
    for line in text.lines() {
        let t = line.trim();
        if ![format!("'{pkg}'"), format!("\"{pkg}\"")].iter().any(|q| t.contains(q.as_str())) {
            continue;
        }
        let head = if let Some(r) = t.strip_prefix("import ") {
            r.split(" from").next().unwrap_or("").trim_start_matches("* as ").trim()
        } else if let Some(r) = t.strip_prefix("const ").or_else(|| t.strip_prefix("let ")).or_else(|| t.strip_prefix("var ")) {
            r.split('=').next().unwrap_or("").trim()
        } else {
            continue;
        };
        let name: String = head.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$').collect();
        if !name.is_empty() {
            out.push(name);
        }
    }
    out
}

/// The key a configuration record's deprecated option value `lit` belongs to: the record's subject, when the record is
/// about one facet of it (ESLint's `radix` rule, facet `as-needed`) and `lit` is not the subject itself. Such a value
/// counts only where written under that key (`usage::under_key`): `as-needed` is an option of many rules.
fn option_of<'r>(r: &'r unstale_schema::catalog::CapabilityRecord, lit: &str) -> Option<&'r str> {
    // A dotted option path (`compilerOptions.moduleResolution`) is written nested: its value sits under the leaf key.
    let s = r.subject.as_str();
    let leaf = s.rsplit('.').next().unwrap_or(s);
    let keylike = !leaf.is_empty() && !s.contains(|c: char| c.is_whitespace() || matches!(c, '(' | ')' | '\'' | '"' | ':' | '='));
    (r.surface == Surface::Configuration && r.subject_kind == SubjectKind::Literal && r.facet.is_some() && keylike && !lit.contains(s) && !s.contains(lit)).then_some(leaf)
}

/// The option key and values of a configuration record about some values of one option (TypeScript 7's
/// `compilerOptions.moduleResolution`, facet `node/node10`, replacing `node` and `node10`): the key is the subject's
/// leaf, one of the record's literals; the values are what it replaces other than the key. Such a change applies only
/// where a file sets that key to one of the values (`option_set`): the key set to another value, the values as words
/// elsewhere (`node`, `false`) and the config file's name are not sites.
fn option_values(r: &unstale_schema::catalog::CapabilityRecord, lits: &[String]) -> Option<(String, Vec<String>)> {
    if r.surface != Surface::Configuration || r.subject_kind != SubjectKind::Literal || r.facet.is_none() {
        return None;
    }
    let subject = clean_lit(&r.subject)?;
    let key = subject.rsplit('.').next().unwrap_or(&subject).to_string();
    let keylike = !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
    if !keylike || !lits.contains(&key) {
        return None;
    }
    let values: Vec<String> = r
        .replaces
        .iter()
        // Values may be short (`es5`), under `clean_lit`'s four characters.
        .map(|x| x.replace('`', "").trim().trim_matches(['\'', '"']).to_string())
        .filter(|v| !v.is_empty() && !v.contains(&key) && !subject.contains(v.as_str()) && !v.contains(char::is_whitespace))
        .collect();
    (!values.is_empty()).then_some((key, values))
}

/// The option key of a configuration record about one option that is removed, deprecated or otherwise changed in a
/// way its presence decides (TypeScript 7's `compilerOptions.baseUrl`; not a changed default, which bites where the key
/// is absent, nor a record about some of its values, `option_values`): the subject's leaf, one of the record's literals.
/// Such a record cites only its literals that name the key, where a file writes it as a key (`key_written`): the
/// config file's name and the record's other words (`false`, `module`, `target` in a source file) are not sites.
fn option_key(r: &unstale_schema::catalog::CapabilityRecord, lits: &[String]) -> Option<String> {
    if r.surface != Surface::Configuration || r.subject_kind != SubjectKind::Literal || r.facet.is_some() || r.change_type == ChangeType::DefaultChange {
        return None;
    }
    let subject = clean_lit(&r.subject)?;
    let key = subject.rsplit('.').next().unwrap_or(&subject).to_string();
    let keylike = key.chars().count() >= 4
        && key.starts_with(|c: char| c.is_ascii_alphabetic())
        && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
    // A record replacing something other than the key (a value of `ESLINT_FLAGS`, `v10_config_lookup_from_file`, also
    // passed as `--flag`) is about that value wherever it is written, not about the key.
    let other = !r.replaces.is_empty() && r.replaces.iter().all(|x| !x.to_ascii_lowercase().contains(&key.to_ascii_lowercase()));
    (keylike && !other && lits.contains(&key)).then_some(key)
}

/// Whether `text` writes `key` as a key: followed, past a closing quote and spaces, by `:` (JSON, YAML, an object
/// literal) or `=` (TOML, INI), with no identifier character before it.
fn key_written(text: &str, key: &str) -> bool {
    let b = text.as_bytes();
    let ident = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'$' | b'-');
    text.match_indices(key).any(|(at, _)| {
        if at > 0 && ident(b[at - 1]) {
            return false;
        }
        let mut j = at + key.len();
        if b.get(j).is_some_and(|c| ident(*c)) {
            return false;
        }
        if matches!(b.get(j), Some(b'"' | b'\'')) {
            j += 1;
        }
        while b.get(j).is_some_and(|c| *c == b' ' || *c == b'\t') {
            j += 1;
        }
        matches!(b.get(j), Some(b':' | b'=')) && b.get(j + 1) != Some(&b':')
    })
}

/// Whether `text` sets the option `key` to one of `values` (`option_values`), case-insensitively: config formats
/// spell values in either case (`"moduleResolution": "Node"`).
fn option_set(path: &str, text: &str, key: &str, values: &[String]) -> bool {
    let (t, k) = (text.to_ascii_lowercase(), key.to_ascii_lowercase());
    values.iter().any(|v| usage::live_site_under(path, &t, &v.to_ascii_lowercase(), &[], None, false, Some(&k)))
}

/// The key a configuration record's dotted option path `lit` ends in (`fsModuleCache` of `experimental.fsModuleCache`),
/// for the applied check: a config file writes the path nested (`experimental: { fsModuleCache: true }`), and an option
/// promoted or moved between releases keeps that key under another parent (Vitest 5's top-level `fsModuleCache`, set in
/// faker's `vitest.config.ts`). Only a specific key: not a plain word, 6 characters or more.
fn option_leaf(r: &unstale_schema::catalog::CapabilityRecord, lit: &str) -> Option<String> {
    if r.surface != Surface::Configuration {
        return None;
    }
    let l = clean_lit(lit)?;
    let (_, leaf) = l.rsplit_once('.')?;
    let keylike = leaf.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')) && !l.contains(|c: char| c.is_whitespace() || matches!(c, '\'' | '"' | ':' | '=' | '/'));
    (keylike && leaf.chars().count() >= 6 && !usage::plain_word(leaf)).then(|| leaf.to_string())
}

/// The option key a configuration record about a changed default names as its subject (`baseBranch`; the leaf of a
/// dotted path): a specific key, not a plain word.
fn default_option(r: &unstale_schema::catalog::CapabilityRecord) -> Option<String> {
    if r.change_type != ChangeType::DefaultChange || r.surface != Surface::Configuration || r.subject_kind != unstale_schema::catalog::SubjectKind::Literal {
        return None;
    }
    let l = clean_lit(&r.subject)?;
    let leaf = l.rsplit('.').next().unwrap_or(&l);
    let keylike = !leaf.is_empty() && leaf.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
    (keylike && !usage::plain_word(leaf)).then(|| leaf.to_string())
}

/// The nearest project boundary containing `path` (`.` when none does).
fn boundary_of<'b>(bounds: &[&'b str], path: &str) -> &'b str {
    bounds.iter().copied().find(|d| *d == "." || path.strip_prefix(*d).is_some_and(|r| r.starts_with('/'))).unwrap_or(".")
}

/// The project boundaries where a technology's file conventions apply (`middleware.ts` is Next.js's file only in a
/// Next.js project): a package that has the technology (`reaching`), or a project whose own code imports it. A file a
/// record names counts only in one of these, at its nearest boundary: a NestJS generator's `middleware.ts` in a
/// monorepo whose root manifest declares `next` is not Next.js's.
fn conventions<'b>(bounds: &[&'b str], reach: &[&str], importers: impl Iterator<Item = impl AsRef<str>>) -> std::collections::HashSet<&'b str> {
    let mut out: std::collections::HashSet<&'b str> = bounds.iter().copied().filter(|b| reach.contains(b)).collect();
    if reach.contains(&".") {
        out.insert(".");
    }
    out.extend(importers.map(|p| boundary_of(bounds, p.as_ref())));
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

/// The record's literals that its summary names as what to use instead of the API it is about ("Removed; use `np.inf`
/// instead" for `np.infty`, written after "use", "in favor of", "replaced by", "migrate to" or "switch to"), when the
/// record names that API in `replaces` and the literal is not one of them: a site of the replacement is code already on
/// it, not a use of what was removed or deprecated.
pub fn successor_lits(r: &Rec, lits: &[String]) -> Vec<String> {
    // A deprecation's score counts every literal (its sites are its deprecated ones, `deprecated_lits`).
    if r.r.change_type == ChangeType::Deprecation {
        return vec![];
    }
    let replaces: BTreeSet<String> = r.r.replaces.iter().filter_map(|x| clean_lit(x)).collect();
    if replaces.is_empty() {
        return vec![];
    }
    let summary = &r.r.summary;
    let lower = summary.to_ascii_lowercase();
    let word = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    let mut named: BTreeSet<String> = BTreeSet::new();
    for m in [
        "use ",
        "in favor of ",
        "in favour of ",
        "replaced by ",
        "replaced with ",
        "migrate to ",
        "switch to ",
    ] {
        for (i, _) in lower
            .match_indices(m)
            .filter(|(i, _)| !word(lower[..*i].chars().next_back()))
        {
            let rest = &summary[i + m.len()..];
            // "Use of `x` is deprecated" names the old API, not a successor.
            if m == "use " && rest.to_ascii_lowercase().starts_with("of ") {
                continue;
            }
            // The clause ends at a sentence end: a `;`, a line break, or a dot not inside a qualified name (`np.inf`).
            let end = rest
                .char_indices()
                .find(|&(k, c)| {
                    c == ';'
                        || c == '\n'
                        || (c == '.'
                            && !rest[k + 1..]
                                .starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))
                })
                .map_or(rest.len(), |(k, _)| k);
            let clause = &rest[..end];
            let clause = clause.split(" instead of ").next().unwrap_or(clause);
            // Package paths, scoped and hyphenated names and flags too (`next/image`, `graphql-ws`, `--flag`).
            for w in clause.split(|c: char| !(c.is_ascii_alphanumeric() || "_$./-@:".contains(c))) {
                let w = w.trim_end_matches(['.', '/', ':', '-']);
                if w.chars().any(|c| c.is_ascii_alphanumeric()) {
                    named.insert(w.to_string());
                }
            }
        }
    }
    lits.iter()
        .filter(|l| !replaces.contains(*l) && named.contains(l.trim_end_matches(['(', ')'])))
        .cloned()
        .collect()
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
    // A summary that names its successor in code (`use encode_basic_auth` for aiohttp's `BasicAuth`) says which literal
    // replaces the deprecated one: another term it does not write is an API used with it (`ClientSession`), not the
    // successor, so a site beside it is no fallback.
    let summary = &r.r.summary;
    let code_words: Vec<&str> = summary
        .split(|c: char| !(c.is_ascii_alphanumeric() || "_$./-".contains(c)))
        .map(|w| w.trim_end_matches(['.', '-']))
        .filter(|w| (usage::identifier(w) || usage::qualified_name(w)) && !deprecated.iter().any(|d| d == w))
        .collect();
    let id_char = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
    let writes = |l: &str| summary.match_indices(l).any(|(i, _)| !id_char(summary[..i].chars().next_back()) && !id_char(summary[i + l.len()..].chars().next()));
    // Written in another case or separator style counts (`encodeAuth` in the summary for an `encode_auth` term).
    let norm = |x: &str| x.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
    let unwritten = |l: &str| !code_words.is_empty() && !writes(l) && !code_words.iter().any(|w| norm(w) == norm(l));
    let mut out: Vec<String> = vec![];
    for l in intro.iter().chain(lits) {
        let related = deprecated.iter().any(|d| d.contains(l.as_str()) || l.contains(d.as_str()));
        let fits = intro.contains(l) || (shapes.contains(&shape(l)) && !unwritten(l));
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
/// The same holds for a tooling change to its type checking or editor support (`types_only`) or with no surface
/// (`other`): of 50 sampled (19 October 2026), 48 were checks, hints, typings or language-server features the tool
/// applies itself.
pub fn is_opt_in(r: &Rec) -> bool {
    !is_obligation(r)
        && matches!(r.r.change_type, ChangeType::NewApi | ChangeType::NewOption | ChangeType::StabilityChange | ChangeType::Tooling | ChangeType::Other)
        && r.r.surface != Surface::RuntimeInternal
        && !tool_behaviour(r)
}

/// A tooling change to the tool's build or configuration handling, its type checking or editor support (`types_only`:
/// vue-tsc's destructured-props hints, typed `definePage` params), or with no surface (`other`: language-server features,
/// provenance republishes); or a stability change to its build (`is_opt_in`).
fn tool_behaviour(r: &Rec) -> bool {
    matches!(
        (r.r.change_type, r.r.surface),
        (ChangeType::Tooling, Surface::BuildTooling | Surface::Configuration | Surface::TypesOnly | Surface::Other)
            | (ChangeType::StabilityChange, Surface::BuildTooling)
    )
}

/// A version's release line by SemVer: its major, or `0.minor` below 1.0.
pub(crate) fn line_of(v: &Version) -> String {
    if v.major > 0 { v.major.to_string() } else { format!("0.{}", v.minor) }
}

/// Whether a record's `candidates` number the upstream repository's releases rather than its packages: two or more
/// of them share one version, the repository installs those packages on two or more release lines, and none of
/// them on the shared version's line. A fixed-version monorepo (`@sentry/*`, `@angular/*`) installs its packages on
/// the release's line, so it never reads as one.
fn repository_numbered(candidates: &[&Release], version_of: impl Fn(&str) -> Option<Version>) -> bool {
    let [first, rest @ ..] = candidates else { return false };
    if rest.is_empty() || rest.iter().any(|r| r.version != first.version) {
        return false;
    }
    let Some(shared) = parse_version(&first.version) else { return false };
    let lines: BTreeSet<String> = candidates.iter().filter_map(|r| version_of(&normalize_purl(&r.component))).map(|v| line_of(&v)).collect();
    lines.len() >= 2 && !lines.contains(&line_of(&shared))
}

/// Keep, of a record's `candidates`, the releases on the line their package is installed on, dropping one that shares
/// its version with such a release while its own package is installed on another line: the version numbers the release
/// line of the packages installed on it, not theirs. A record whose candidates all sit off their packages' lines (a
/// genuine upgrade, or a repository-numbered tag) is left as it is.
fn own_line(candidates: &mut Vec<&Release>, version_of: impl Fn(&str) -> Option<Version>) {
    if candidates.len() < 2 {
        return;
    }
    let on_line = |r: &Release| {
        let (Some(v), Some(i)) = (parse_version(&r.version), version_of(&normalize_purl(&r.component))) else { return false };
        line_of(&v) == line_of(&i)
    };
    let on: BTreeSet<String> = candidates.iter().filter(|r| on_line(r)).map(|r| r.version.clone()).collect();
    candidates.retain(|r| on_line(r) || !on.contains(&r.version));
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
    parse_version(&release.version).is_some_and(|v| older_line(&v, installed)) && long_before(release, installed, index)
}

/// An opt-in on the installed line that the code shows no site for (`Route::NoSite`), released `BASELINE_DAYS` or more
/// before the installed version.
fn settled(release: &Release, installed: &Version, index: &[IndexRelease], site: bool) -> bool {
    !site && parse_version(&release.version).is_some_and(|v| line_of(&v) == line_of(installed) && v <= *installed) && long_before(release, installed, index)
}

/// Whether `release` came at least `BASELINE_DAYS` before the installed version (`baseline`'s dates; unreadable: no).
fn long_before(release: &Release, installed: &Version, index: &[IndexRelease]) -> bool {
    let Some(v) = parse_version(&release.version) else { return false };
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

/// Whether `rec`, released only under packages of its technology this repository does not use (`rels`; the repository
/// is covered through a sibling package of the same release stream), is about the surface of a package other than the
/// ones used here (`purls`): a command-line change is the command of the package it was released under, and a summary or
/// subject naming an unused component by its unscoped name (`The CLI no longer …` for `@babel/cli`) and no used one is
/// about that package. Such a record is not something bumping the sibling picks up (`Route::OtherPackage`).
fn about_releaser(rec: &Rec, rels: &[&Release], purls: &BTreeSet<String>) -> bool {
    if rels.is_empty() {
        return false;
    }
    if rec.r.surface == unstale_schema::catalog::Surface::CommandLine {
        return true;
    }
    let text = format!("{} {}", rec.r.subject, rec.r.summary).to_ascii_lowercase();
    let names = |c: &str| -> bool {
        let Some(n) = purl_name(c) else { return false };
        let n = n.rsplit('/').next().unwrap_or(&n).to_ascii_lowercase();
        n.len() >= 3
            && text.match_indices(&n).any(|(at, _)| {
                let b = text.as_bytes();
                let word = |c: Option<&u8>| c.is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'-' || *c == b'_');
                !word(at.checked_sub(1).and_then(|i| b.get(i))) && !word(b.get(at + n.len()))
            })
    };
    let used = purls.iter().any(|c| names(c));
    !used && rels.iter().any(|r| names(&normalize_purl(&r.component)))
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

/// A stable version newer than every release of the technology's index (the releases it published in the window):
/// one it never published. False without an index (older catalogs) and for a prerelease (the index lists none).
fn beyond_index(v: &Version, index: &[IndexRelease]) -> bool {
    v.pre.is_empty() && index.iter().filter_map(|x| parse_version(&x.version)).max().is_some_and(|top| *v > top)
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
        whole.extend(r.r.introduces.iter().filter_map(|x| option_leaf(&r.r, x)));
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
    // The packages the project installs, by squashed name: a module the code imports from one of them is an installed
    // library's (`usage::scoped_site`).
    let squash = |s: &str| s.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_ascii_lowercase();
    let dep_names: HashSet<String> = inp.stack.deps.values().map(|d| squash(&d.name)).collect();
    let installed_module = |m: &str| {
        let root = if m.starts_with('@') { m.splitn(3, '/').take(2).collect::<Vec<_>>().join("/") } else { m.split(['/', '.']).next().unwrap_or(m).to_string() };
        !root.is_empty() && dep_names.contains(&squash(&root))
    };
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
    let bounds = boundaries(&inp.stack.packages, &inp.repo.paths);
    let tools = tools(&inp.stack.packages);
    // Published libraries: a framework resolves its file conventions in the application that runs it, never inside a
    // package others install.
    let libraries: std::collections::HashSet<&str> = inp.stack.packages.iter().filter(|p| p.kind == crate::stack::Kind::Library).map(|p| p.dir.as_str()).collect();
    for (tech, td, tl) in &in_stack {
        let (tech, comps, lits) = (*tech, &tl.comps, &tl.per_record);
        let first = out.opps.len();
        // A CLI flag counts only on a command line that runs this technology: `--scope` in another CLI's help text or
        // a `claude mcp add --scope` string is not turbo's flag.
        let flagged = flag_filtered(&all_hits, comps, tl.usage.iter().chain(&tl.whole), &inp.repo.paths);
        let hits: &Hits = flagged.as_ref().unwrap_or(&all_hits);
        let present: Vec<&String> = comps.iter().filter(|c| purls.contains(*c)).collect();
        // A package installed only through npm aliases beside one of the technology's packages installed under its own
        // name is a deliberate parallel copy (ComposioHQ/composio: `typescript6: npm:@typescript/typescript6@^6` and
        // `catalog:ts6` for the compiler API beside TypeScript 7): it sets neither the technology's version nor a
        // workspace line, and no record is read against it.
        let parallel_copy = |c: &String| inp.stack.deps.get(c).is_some_and(|d| d.parallel_copy());
        let parallel: BTreeSet<&String> =
            if present.iter().any(|c| !parallel_copy(c)) { present.iter().copied().filter(|c| parallel_copy(c)).collect() } else { BTreeSet::new() };
        for c in &parallel {
            let d = &inp.stack.deps[*c];
            let mut dirs: Vec<String> = d.readings.iter().map(|r| format!("{} ({})", place(&r.dir), r.version)).collect();
            dirs.dedup();
            let names: Vec<String> = d.aliases.iter().map(|a| format!("`{a}`")).collect();
            out.version_notes.push(format!(
                "{}: installed through the npm {} {} in {}, a side-by-side copy beside {}; its version is not the technology's and no bump is proposed for it.",
                d.name,
                if names.len() == 1 { "alias" } else { "aliases" },
                names.join(", "),
                dirs.join(", "),
                present.iter().filter(|p| !parallel.contains(*p)).filter_map(|p| purl_name(p)).collect::<Vec<_>>().join(", ")
            ));
        }
        let present: Vec<&String> = present.into_iter().filter(|c| !parallel.contains(c)).collect();
        // Copies of the technology installed side by side: one manifest installs two of its packages, at least one through
        // an npm alias (mui: `typescript: npm:@typescript/typescript6@6.0.2` beside `@typescript/native:
        // npm:typescript@7.0.2`). Both run there, so a record released for both is read against the newer copy
        // (`side_by_side`), which the repository already runs.
        let side = side_by_side(inp.stack, &present);
        for (dir, a, b) in &side.pairs {
            let (da, db) = (&inp.stack.deps[*a], &inp.stack.deps[*b]);
            let (Some(ra), Some(rb)) = (da.readings.iter().find(|r| r.dir == *dir), db.readings.iter().find(|r| r.dir == *dir)) else { continue };
            let ((new, rn), (old, ro)) = if ra.version >= rb.version { ((da, ra), (db, rb)) } else { ((db, rb), (da, ra)) };
            out.version_notes.push(format!(
                "{}: {} ({}) is installed beside {} {} ({}) in {}, through npm aliases; records released for both are read against {}, which the repository already runs, not as a bump to it.",
                new.name, rn.version, rn.source, old.name, ro.version, ro.source, place(dir), rn.version
            ));
        }
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
        let all = usage::Scope::new(&ecosystem, &owners, comps, scope_lits(), hits, &inp.repo.paths).with_reach(&reach).with_repo(inp.repo);
        // Per package: the version the outputs use, from the code that imports it (`Choice`).
        let choices: BTreeMap<&String, Choice> = present
            .iter()
            .filter_map(|c| {
                let d = inp.stack.deps.get(*c)?;
                let sites = || {
                    let mut v: Vec<String> = usage::naming_lits(c)
                        .iter()
                        .flat_map(|l| hits.usage.get(l).into_iter().flatten())
                        .filter(|p| all.file(p) == Some(true) && !manifest_file(p))
                        .cloned()
                        .collect();
                    // A compiler or build tool is used where its config files are, not only where its API is imported
                    // (mikro-orm: the root compiles with typescript 7.0.2 through its tsconfigs; only docs/ imports it).
                    v.extend(inp.repo.paths.iter().filter(|p| !manifest_file(p) && all.file(p).is_some() && all.runs_from(p)).cloned());
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
                let Some(r) = d.owner(p).filter(|r| ch.off.iter().any(|o| o.dir == r.dir)) else { continue };
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
        scopes.extend(filtered.iter().map(|f| usage::Scope::new(&ecosystem, &owners, comps, scope_lits(), f, &inp.repo.paths).with_reach(&reach).with_repo(inp.repo)));
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
            // Cited only where written outside comments: `with:` in a JSDoc sentence is not a workflow step's key.
            let e = Rc::new(scopes[v].evidence_where(l, role, !nested, |p| inp.repo.text(p).is_none_or(|t| usage::written_outside_comments(p, t, l))));
            evidence.borrow_mut().insert(key, e.clone());
            e
        };
        // A literal's evidence where the record names one signature of it (`usage::call_arity`): only files calling it
        // with that many arguments are sites. Files left out still order the queue (`Evidence::used`).
        let shaped: Memo<Rc<usage::Evidence>> = RefCell::default();
        let shaped_of = |v: usize, l: &str, a: (usize, Option<usize>)| -> Rc<usage::Evidence> {
            let key = (v, format!("{l}\0{a:?}"));
            if let Some(e) = shaped.borrow().get(&key) {
                return e.clone();
            }
            let keep = |p: &str| inp.repo.text(p).is_some_and(|t| usage::written_outside_comments(p, t, l) && usage::called_with(t, l, a));
            let e = Rc::new(scopes[v].evidence_where(l, role, !nested, keep));
            shaped.borrow_mut().insert(key, e.clone());
            e
        };
        // Where the technology's file conventions apply (`conventions`); no manifest declaring it: everywhere, as before.
        let convention = conventions(&bounds, &reach, scopes[0].importers().filter(|p| usage::own_code(p, &ecosystem)));
        // A deprecated literal's evidence: whole-literal hits only (`usage::Scope::exact_evidence`), at a live site
        // (`usage::live_site`: not in a comment, not a fallback beside the record's replacement). Per view, literal and
        // replacements.
        let exact: Memo<Rc<usage::Evidence>> = RefCell::default();
        let modules: Vec<String> = comps.iter().filter_map(|c| purl_name(c)).collect();
        // Node resolves a package from the importing file's directory upward, so npm code in no directory an installed
        // copy of the technology was read from (projen's root `src/web/react.ts`, beside `docusaurus/` with its own
        // lockfile and react; the root declares none) runs none of it: no site of the installed version.
        let copies: Vec<&Reading> = if ecosystem == "npm" {
            inp.stack.deps.iter().filter(|(k, _)| comps.contains(&normalize_purl(k))).flat_map(|(_, d)| d.readings.iter()).collect()
        } else {
            vec![]
        };
        let runs_a_copy = |p: &str| copies.is_empty() || !usage::own_code(p, &ecosystem) || copies.iter().any(|r| r.contains(p));
        let exact_of = |v: usize, l: &str, repl: &[String], context: Option<&[String]>, keyed: bool, config: bool, succ: &[String], call: bool, parent: Option<&str>, invoked: bool, shape: Option<(usize, Option<usize>)>, named: &[String], subject: &str, ns_context: Option<&[String]>, facet: Option<&str>| -> Rc<usage::Evidence> {
            let ctx = context.map_or("-".to_string(), |c| c.join("\0"));
            let ns_ctx = ns_context.map_or("-".to_string(), |c| c.join("\0"));
            let key = (v, format!("{l}\0{}\u{1}{ctx}\u{2}{keyed}\u{3}{config}\u{4}{}\u{5}{call}\u{6}{parent:?}\u{7}{invoked}\u{8}{}\u{9}{shape:?}\u{a}{subject}\u{b}{ns_ctx}\u{c}{facet:?}", repl.join("\0"), succ.join("\0"), named.join("\0")));
            if let Some(e) = exact.borrow().get(&key) {
                return e.clone();
            }
            let named_file = usage::file_name(l);
            let option = usage::identifier(l) || usage::qualified_name(l);
            let live = |p: &str| {
                if named_file {
                    // A file named for the technology (`.eslintrc.json`) is its file wherever it is cited, as root-
                    // declared tooling configures every package; a generic name (`middleware.ts`) only in its projects,
                    // never in a published library (the application installing it resolves the convention: fumadocs'
                    // `packages/core/src/i18n/middleware.ts` is a helper users call from their own `proxy.ts`), and not
                    // where the file already imports the successor from the technology (`NextProxy` for `proxy`).
                    if !usage::is_file(p, l) {
                        return false;
                    }
                    if reach.is_empty() || scopes[v].names_path(p) {
                        return true;
                    }
                    let at = boundary_of(&bounds, p);
                    return convention.contains(at)
                        && !libraries.contains(at)
                        && inp.repo.text(p).is_none_or(|t| !usage::imports_successor(t, &modules, succ));
                }
                if !runs_a_copy(p) {
                    return false;
                }
                // An option or API name other tools share (`noExternal`: Vite's `ssr.noExternal`) counts in a file
                // that neither imports the technology nor is named for it only when that file is not another
                // declared tool's config (`vite.config.ts` in a package declaring `vite`).
                if option && scopes[v].file(p) == Some(false) && usage::config_tool(p).is_some_and(|t| tools.contains(&t)) {
                    return false;
                }
                // A configuration option counts in code only where that code configures the technology: its own config
                // file or code importing it (`Scope::file` about). A record-named generic file (`index.ts`) returning
                // another tool's options (`@fumadocs/vite`'s `ssr: { noExternal }`) is not. Data files are unchanged.
                // Only that code: a path naming the technology in a directory (`src/types/` for TypeScript) is not
                // its config (composio's zod schema key `baseUrl` in `types/toolkit.types.ts`).
                if option && config && usage::own_code(p, &ecosystem) && !scopes[v].configures(p) {
                    return false;
                }
                // A plain word in effect (`call`): only as a key of an object passed to a function the file imports from
                // the technology (`streamText({ system })`, `usage::call_key`).
                // A deprecated API the record writes as a call (`json_schema()`) counts where the code calls it, not
                // where the same word names a parameter, keyword argument or module of its own (composio's
                // `json_schema=…` and `composio.utils.json_schema` for pydantic's `json_schema()`).
                if invoked && usage::identifier(l) && !inp.repo.text(p).is_some_and(|t| usage::called(t, l)) {
                    return false;
                }
                // A record naming one signature (`cy.stub(object, name, fn)`) is about calls of that arity only.
                if let Some(a) = shape
                    && !inp.repo.text(p).is_some_and(|t| usage::called_with(t, l, a))
                {
                    return false;
                }
                // An API name the file defines itself (`def from_orm`) is the file's own; where the record names the
                // classes or calls it applies to, a site owned by another class the file imports from an installed
                // package (`new Chat({ onFinish })`, `TypeAdapter(X).json_schema()`) is not the record's API.
                if (usage::identifier(l) || invoked)
                    && usage::own_code(p, &ecosystem)
                    && inp.repo.text(p).is_some_and(|t| usage::defines(t, l) || (!named.is_empty() && !usage::scoped_site(t, l, named, &installed_module)))
                {
                    return false;
                }
                if call && !(usage::own_code(p, &ecosystem) && scopes[v].file(p) == Some(true) && inp.repo.text(p).is_some_and(|t| usage::call_key(t, l, &modules))) {
                    return false;
                }
                // A bare keyword or parameter name of the subject API (`model_name` of `list_models`) in Python code:
                // only where the file uses that API, and not as a parameter the file declares (`usage::py_keyword_site`).
                if inp.repo.text(p).is_some_and(|t| !usage::py_keyword_site(p, t, l, subject, facet)) {
                    return false;
                }
                // A namespace the record's subject is narrower than (`pytest.mark` for hook markers), written only as
                // the qualifier of another member (`@pytest.mark.asyncio`), takes the record's specific literals beside
                // it, as a namespace other records name members of does.
                // Beside them means on the definition a decorator applies to (`usage::namespace_beside`), for a namespace
                // other records name members of too.
                if let Some(c) = context.or(ns_context)
                    && inp.repo.text(p).is_some_and(|t| usage::only_as_namespace(p, t, l) && !usage::namespace_beside(p, t, l, c))
                {
                    return false;
                }
                inp.repo.text(p).is_none_or(|t| usage::live_site_under(p, t, l, repl, context, keyed, parent))
            };
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
        // The lockfile each package's headline version is read from: a prerequisite is checked against its root.
        let head_lock = |c: &str| choices.get(&c.to_string()).and_then(|ch| ch.head.lock.clone());
        let version_of = |c: &str| -> Option<Version> {
            choices.get(&c.to_string()).map(|ch| ch.head.version.clone()).or_else(|| inp.stack.deps.get(c).and_then(|d| d.version.clone()))
                .or_else(|| inp.stack.stub_runtimes.get(c).cloned())
        };
        // A type stub's version is never its technology's (`@types/express` 5.0.6 beside express 5.2.1).
        let tech_version: Option<Version> = present.iter().filter(|c| !crate::util::stub_package(c)).filter_map(|c| version_of(c)).min();
        let mut workspaces: Vec<Workspace> = vec![];
        for c in &present {
            let (Some(d), Some(ch)) = (inp.stack.deps.get(*c), choices.get(*c)) else { continue };
            let h = ch.head;
            let others = d.others_than(h);
            if !others.is_empty() {
                out.headline.insert((*c).clone(), (h.dir.clone(), h.source.clone()));
            }
            if let (Some(m), Some((n, k))) = (ch.moved, ch.used_most) {
                out.versions.insert(normalize_purl(c), h.version.clone());
                out.version_notes.push(format!(
                    "{}: the reviews use {} in {} ({}), the independent project whose code imports it most ({n} file{}); {} in {} ({}) is another project's ({k} file{}).",
                    d.name, h.version, place(&h.dir), h.source, if n == 1 { "" } else { "s" }, m.version, place(&m.dir), m.source, if k == 1 { "" } else { "s" }
                ));
            } else if let Some(m) = ch.moved {
                out.versions.insert(normalize_purl(c), h.version.clone());
                out.version_notes.push(format!(
                    "{}: the reviews use {} in {} ({}), where the code that imports it or runs it from its config files is; no such file runs {} ({} in {}).",
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
                let mut locks: Vec<Option<String>> = rs.iter().map(|r| r.lock.clone()).collect();
                locks.sort();
                locks.dedup();
                workspaces.push(Workspace { component: (*c).clone(), version, dirs, locks, target: None, records: vec![] });
            }
        }
        // Newest release per component: the default target. The technology's own packages take the newest release any
        // of its records names, also one central gave to another package of the repository (they share the release).
        // A stable version past the newest release of the technology's index was never published by it (a sibling's
        // version line in a monorepo: electron-updater records at electron-builder's 27.0.0): never a default target.
        let published = |v: &Version| !beyond_index(v, &td.index.releases);
        let mut newest: BTreeMap<String, Version> = BTreeMap::new();
        if let Some(v) = td.records.iter().flat_map(|r| r.r.releases.iter()).filter_map(|x| parse_version(&x.version)).filter(published).max() {
            for c in comps.iter() {
                newest.insert(c.clone(), v.clone());
            }
        }
        for r in &td.records {
            for rel in &r.r.releases {
                if let Some(v) = parse_version(&rel.version).filter(|v| !comps.contains(&normalize_purl(&rel.component)) || published(v)) {
                    let e = newest.entry(normalize_purl(&rel.component)).or_insert_with(|| v.clone());
                    if v > *e {
                        *e = v;
                    }
                }
            }
        }
        // A package installed on another release line than the newest release, beside a package of the technology
        // installed on that release's line, is on its own version line (`own_line`): its target is the newest release
        // on its own line, the installed version when none is known.
        for c in &present {
            let (Some(iv), Some(n)) = (version_of(c), newest.get(*c).cloned()) else { continue };
            if line_of(&iv) == line_of(&n) || !present.iter().any(|o| o != c && version_of(o).is_some_and(|v| line_of(&v) == line_of(&n))) {
                continue;
            }
            let own = td
                .records
                .iter()
                .flat_map(|r| r.r.releases.iter())
                .filter(|x| normalize_purl(&x.component) == **c)
                .filter_map(|x| parse_version(&x.version))
                .filter(|v| line_of(v) == line_of(&iv))
                .max();
            newest.insert((*c).clone(), own.map_or(iv.clone(), |v| v.max(iv)));
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
        // Read only once a record names one of a lint plugin's rules (`rule_not_enabled`).
        let plugins: std::cell::OnceCell<Vec<LintPlugin>> = std::cell::OnceCell::new();
        let cmd_words: Vec<String> = comps.iter().flat_map(|c| usage::command_words(c)).collect();
        let lint_ns: Vec<String> = comps.iter().filter_map(|c| purl_name(c)).filter_map(|p| lint_namespace(&p)).map(|(_, n)| format!("{n}/")).collect();
        for (ri, (rec, ls)) in td.records.iter().zip(lits).enumerate() {
            // The releases of the packages this repository uses; else of the technology's own packages (a record names
            // every component, and the repository uses at least one). A record about other packages of the technology's
            // repository only (a release-notes section central attributed to them) applies only where one is used.
            let own: Vec<&Release> = rec
                .r
                .releases
                .iter()
                .filter(|x| {
                    let c = normalize_purl(&x.component);
                    purls.contains(&c) && !parallel.contains(&c)
                })
                .collect();
            let rels: Vec<&Release> = rec
                .r
                .releases
                .iter()
                .filter(|x| {
                    let c = normalize_purl(&x.component);
                    comps.contains(&c) && !parallel.contains(&c)
                })
                .collect();
            // Covered through a sibling package's index (no release of a package used here): a record about the surface
            // of the package it was released under is that package's, not value for the one installed (`about_releaser`).
            if own.is_empty() && rels.is_empty() || own.is_empty() && about_releaser(rec, &rels, &purls) {
                if let Some(release) = rec.r.releases.first() {
                    out.opps.push(blank(rec, release.clone(), Route::OtherPackage));
                }
                continue;
            }
            let mut candidates = if own.is_empty() { rels } else { own };
            // A type-stubs member never names the release while a runtime package of the technology is a candidate
            // (`types-requests` beside `requests`): the change ships in the runtime package.
            if candidates.iter().any(|x| !crate::util::stub_package(&x.component)) {
                candidates.retain(|x| !crate::util::stub_package(&x.component));
            }
            // A release that gives one version to several packages this repository installs on different release lines,
            // none of them that one, numbers the upstream repository's releases (a monorepo tag `v100.0.0`), not the
            // packages: MetaMask's `@metamask/account-api` 2.1.0 and `keyring-utils` 5.0.0 are not on "100.0.0". Their
            // versions cannot be placed against what is installed.
            // Released for several copies installed side by side: read against the newest of them (`side_by_side`).
            let copies: BTreeSet<String> = candidates.iter().map(|x| normalize_purl(&x.component)).filter(|c| side.members.contains(c)).collect();
            if copies.len() > 1
                && let Some(newest_copy) = copies.iter().max_by_key(|c| version_of(c))
            {
                let keep = newest_copy.clone();
                candidates.retain(|x| normalize_purl(&x.component) == keep);
            }
            // A release central gave to every package of the repository while they are installed on separate release
            // lines (opentelemetry-js: api 1.9.1, semantic-conventions 1.43.0, the SDK 2.12.0) is the release of the
            // packages on its line: an SDK 2.10.0 change is not one semantic-conventions 1.43.0 lacks (`own_line`).
            own_line(&mut candidates, |c| version_of(c));
            if repository_numbered(&candidates, |c| version_of(c)) {
                out.opps.push(blank(rec, candidates[0].clone(), Route::VersionUnknown));
                continue;
            }
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
            // A release central could only bound (`no_later_than`: read from a moving page) is placed only when the
            // installed version, and for an upgrade the target, lie outside the bound: inside it the change may or may
            // not be there, so it is neither in effect, nor available, nor what the upgrade brings.
            if let Some(hi) = release.no_later_than.as_deref().and_then(parse_version)
                && let Some(lo) = parse_version(&release.version)
            {
                let inside = |v: &Version| *v >= lo && *v < hi;
                if inside(&installed) || (avail == Avail::Upgrade && inside(&target)) {
                    out.opps.push(blank(rec, release.clone(), Route::ReleaseUnknown));
                    continue;
                }
            }
            // A deprecation that names what it deprecates cites only that, as whole literals: a match on its other
            // terms is not usage of the deprecated API. The score (the queue's order) still counts every literal.
            let mut deprecated = deprecated_lits(rec, ls);
            deprecated.retain(|l| !usage::loads_only(l, &own_names));
            let replacement = replacement_lits(rec, ls, &deprecated);
            // Without the replacement its summary names (`np.inf` for a removed `np.infty`): code on it is no site.
            let successors = successor_lits(rec, ls);
            let own: Vec<String> = ls.iter().filter(|l| !successors.contains(l)).cloned().collect();
            // A deprecated namespace (`pytest.mark`, for markers on hook implementations) counts only beside a specific
            // literal of the record: not the namespace or a part of it, not a member other records are about (another
            // API: `pytest.mark.parametrize`), not the replacement, not a plain word.
            // So does an entry point of the technology's own package (`next/server`) when the record names a specific
            // API beside it (subject `ImageResponse`, "its export from next/server is deprecated"): every file using
            // the entry point's other exports names it too.
            let entry = |l: &str| own_names.iter().any(|n| l.strip_prefix(n.as_str()).is_some_and(|r| r.starts_with('/') && r.len() > 1));
            let names_api = ls.iter().any(|l| !entry(l) && !deprecated.contains(l) && usage::identifier(l) && !usage::plain_word(l) && !replacement.contains(l) && rec.r.subject.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$')).any(|w| w == l.as_str()));
            let broad: Vec<&String> = deprecated.iter().filter(|l| namespace_of(tl, ri, l) || (names_api && entry(l))).collect();
            // A deprecated namespace the record's subject does not write (`pytest.mark` for "hook markers": a narrower
            // use of it) is read as one only in a file that writes it as the qualifier of another member (`exact_of`).
            let subject_lc = rec.r.subject.to_ascii_lowercase();
            let narrow: Vec<&String> = deprecated.iter().filter(|l| !broad.contains(l) && usage::qualified_name(l) && !subject_lc.contains(&l.to_ascii_lowercase())).collect();
            let sibling = |l: &str| tl.named.get(l.strip_prefix('@').unwrap_or(l)).is_some_and(|rs| rs.iter().any(|&j| j != ri));
            let context: Vec<String> = if broad.is_empty() && narrow.is_empty() {
                vec![]
            } else {
                ls.iter()
                    .filter(|l| {
                        !broad.iter().chain(&narrow).any(|b| b.contains(l.as_str()) || (usage::member_of(l, b) && sibling(l)))
                            && !replacement.contains(l)
                            && !usage::plain_word(l)
                            && !namespace_of(tl, ri, l)
                    })
                    .cloned()
                    .collect()
            };
            // The record reads the view of its package (code on the outputs' release line only).
            let view = candidates.first().and_then(|r| view_of.get(&normalize_purl(&r.component))).copied().unwrap_or(0);
            // An identifier of several words that no file citable by the rules above writes, used on a command line that
            // runs the technology (a flag's value in a `package.json` script), is cited there.
            let ev = |l: &str| -> Rc<usage::Evidence> {
                let e = evidence_of(view, l);
                if !e.files.is_empty() || !e.used || !usage::identifier(l) || !l.contains(|c: char| c == '_' || c.is_ascii_uppercase()) {
                    return e;
                }
                let files: Vec<(String, bool)> = hits_of(view)
                    .ix
                    .get(l)
                    .into_iter()
                    .flatten()
                    .map(|x| &inp.repo.paths[*x as usize])
                    .filter(|p| scopes[view].file(p).is_some() && inp.repo.text(p).is_some_and(|t| usage::on_command_line(t, l, &cmd_words)))
                    .take(3)
                    .map(|p| (p.clone(), true))
                    .collect();
                if files.is_empty() { e } else { Rc::new(usage::Evidence { files, ..(*e).clone() }) }
            };
            let succ = successor_words(&rec.r);
            let config = rec.r.surface == Surface::Configuration;
            // The classes and calls the record names beside what it deprecates (`BaseModel`; `generateText`, `Agent`):
            // the API its deprecated names belong to.
            let named: Vec<String> = if deprecated.is_empty() {
                vec![]
            } else {
                let mut n: Vec<String> = rec
                    .r
                    .terms
                    .iter()
                    .map(|t| &t.0)
                    .chain(std::iter::once(&rec.r.subject))
                    .flat_map(|t| t.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$')).map(str::to_string).collect::<Vec<_>>())
                    .filter(|w| usage::identifier(w) || w.starts_with(|c: char| c.is_ascii_uppercase()))
                    .filter(|w| !deprecated.iter().any(|d| d.trim_start_matches('.') == w) && !rec.r.introduces.iter().any(|x| x.contains(w.as_str())))
                    .collect();
                n.sort();
                n.dedup();
                n
            };
            let invoked = |l: &str| rec.r.replaces.iter().any(|x| x.replace('`', "").trim().ends_with("()") && clean_lit(x).as_deref() == Some(l));
            // The signature the record replaces, when every `replaces` entry for the literal writes one with parameters
            // (`cy.stub(object, name, fn)`): its calls of another arity (`cy.stub()`) are not sites.
            // A deprecated argument of a surviving call (`deprecated_part`): only calls passing at least one argument
            // can use it (`runCmd.outputHelp()` cannot pass outputHelp's deprecated callback).
            let part = deprecated_part(&rec.r, &td.records);
            let shape = |l: &str| -> Option<(usize, Option<usize>)> {
                if part == Some(Part::Argument) && deprecated.iter().any(|d| d == l) && usage::identifier(l) {
                    return Some((1, None));
                }
                let mut of = rec.r.replaces.iter().filter(|x| clean_lit(x).as_deref() == Some(l)).map(|x| usage::call_arity(x)).peekable();
                of.peek()?;
                of.try_fold((usize::MAX, Some(0usize)), |(lo, hi), a| a.map(|(m, x)| (lo.min(m), hi.zip(x).map(|(h, x)| h.max(x)))))
            };
            let ev_cite = |l: &str| -> Rc<usage::Evidence> { if let Some(a) = shape(l) { shaped_of(view, l, a) } else { ev(l) } };
            let ex_with = |l: &str, call: bool| exact_of(view, l, &replacement, broad.iter().any(|b| *b == l).then_some(&context[..]), keyed_api(&rec.r, ls, l), config, &succ, call, option_of(&rec.r, l), invoked(l), shape(l), &named, &rec.r.subject, narrow.iter().any(|b| *b == l).then_some(&context[..]), rec.r.facet.as_deref());
            let ex = |l: &str| ex_with(l, false);
            // A record about some values of one option cites the option's key only, where a file sets it to one of them.
            // A deprecation citing its replaced literals keeps that path (`option_of` puts a value under its key).
            let valued = if deprecated.is_empty() { option_values(&rec.r, ls) } else { None };
            let valued_key: Vec<String> = valued.iter().map(|(k, _)| k.clone()).collect();
            let set_ev = |l: &str| -> Rc<usage::Evidence> {
                let (k, vs) = valued.as_ref().expect("option_values");
                Rc::new(scopes[view].evidence_where(l, role, !nested, |p| inp.repo.text(p).is_some_and(|t| option_set(p, t, k, vs))))
            };
            let keyed = if valued.is_none() && deprecated.is_empty() { option_key(&rec.r, ls) } else { None };
            let key_lits: Vec<String> = keyed.iter().flat_map(|k| ls.iter().filter(move |l| l.contains(k.as_str())).cloned()).collect();
            let key_ev = |l: &str| -> Rc<usage::Evidence> {
                let k = keyed.as_deref().expect("option_key");
                Rc::new(scopes[view].evidence_where(l, role, !nested, |p| inp.repo.text(p).is_some_and(|t| key_written(t, k))))
            };
            let (cited, cite): (&[String], Cite) = if valued.is_some() {
                (&valued_key, &set_ev)
            } else if !deprecated.is_empty() {
                (&deprecated, &ex)
            } else if keyed.is_some() {
                (&key_lits, &key_ev)
            } else {
                (&own[..], &ev_cite)
            };
            // A lint rule this repository never turns on: none of the record's terms is a site (`rule_not_enabled`).
            let rule_off = !lint_ns.is_empty()
                && rec.r.terms.iter().map(|t| &t.0).chain(&rec.r.replaces).any(|t| lint_ns.iter().any(|n| t.contains(n.as_str())))
                && rule_not_enabled(&rec.r, plugins.get_or_init(|| lint_plugins(comps, inp.repo)));
            let cited: &[String] = if rule_off { &[] } else { cited };
            let found: Vec<(String, Rc<usage::Evidence>)> = cited.iter().map(|l| (l.clone(), cite(l))).filter(|(_, e)| !e.files.is_empty()).collect();
            let more: BTreeMap<String, usize> = found.iter().filter(|(_, e)| e.more > 0).map(|(l, e)| (l.clone(), e.more)).collect();
            let matched: Vec<(String, Vec<String>)> = found.into_iter().map(|(l, e)| (l, e.files.iter().map(|(p, _)| p.clone()).collect())).collect();
            // A record about option values or one option's key scores by the files citing it (its evidence's `used` counts
            // the literal anywhere).
            let narrowed = valued.is_some() || keyed.is_some();
            let score = (if narrowed { cited } else { &own[..] })
                .iter()
                .filter(|_| !rule_off)
                .filter_map(|l| {
                    let e = if narrowed { Some(cite(l)).filter(|e| !e.files.is_empty()) } else { Some(ev(l)).filter(|e| e.used) };
                    e.map(|e| weight(l) * if e.app { 1.0 } else { NON_APP_WEIGHT })
                })
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
                more,
                files,
                requires_miss,
                benefits: vec![],
                borderline_benefit: false,
                withheld_from: None,
                unmet: None,
                elsewhere,
                adopted: None,
                part,
            };
            // The ledger, prerequisite and applied checks do not depend on the version: shared with `workspaces`.
            let ledger_status = || {
                inp.ledger.entries.iter().find(|e| e.id() == rec.r.id).filter(|e| withholds(e, rec.r.revision, inp.today)).map(status_name)
            };
            // Applied in the code the record describes; a workspace on another version is judged on the whole repository.
            // A configuration option's own key (`option_leaf`) also counts, in code that configures the technology only.
            let leaf_applied = |v: usize, f: &str| {
                hits_of(v).whole.get(f).into_iter().flatten().any(|p| {
                    scopes[v].counts(f, p) && usage::counts_as_applied(role(p), p) && (!usage::own_code(p, &ecosystem) || scopes[v].configures(p))
                })
            };
            let applied_in = |v: usize| {
                rec.r.introduces.iter().filter_map(|x| clean_lit(x)).any(|x| applied_of(v, &x))
                    || rec.r.introduces.iter().filter_map(|x| option_leaf(&rec.r, x)).any(|f| leaf_applied(v, &f))
            };
            let applied = || applied_in(view);
            // The option a configuration default-change record is about, written as a key outside comments in a file
            // that can configure the technology (not documentation, examples, generated or vendored text).
            let option_set = |v: usize| {
                let Some(key) = default_option(&rec.r) else { return false };
                hits_of(v).usage.get(&key).into_iter().flatten().any(|p| {
                    !matches!(role(p), usage::Role::Docs | usage::Role::Example | usage::Role::Generated | usage::Role::Vendored)
                        && scopes[v].counts(&key, p)
                        && (!usage::own_code(p, &ecosystem) || scopes[v].configures(p))
                        && inp.repo.text(p).is_some_and(|t| usage::written_outside_comments(p, t, &key))
                })
            };
            opp.route = base_route(rec, avail);
            // A deprecation already in the installed version is still owed while the code uses what it deprecates: its
            // `replaces` literals, whole, under the shown evidence rule (files that can use the technology). A plain word
            // (`message`) is too common to show that, so it takes a specific literal (`toBeCalledWith`, `terserOptions`)
            // and cites only those. Nothing to block (it is installed) and no applied check (the old API is the signal:
            // once it is gone the record is already included).
            // A plain word counts too where written as a key of an object passed to a function imported from the
            // technology (`streamText({ system })` for the AI SDK's `system`, `usage::call_key`), cited at those sites.
            let calls: Vec<(String, Vec<String>)> = if opp.route == Route::AlreadyIncluded && !deprecated.is_empty() {
                deprecated
                    .iter()
                    .filter(|l| usage::plain_word(l))
                    .map(|l| (l.clone(), ex_with(l, true).files.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>()))
                    .filter(|(_, f)| !f.is_empty())
                    .collect()
            } else {
                vec![]
            };
            // Only a package the project installs has a deprecation in effect: a registry package of the technology that
            // no manifest or lockfile names reads no version of its own here (`version_of`), whatever its siblings run.
            let registry = comp.starts_with("pkg:npm/") || comp.starts_with("pkg:pypi/");
            let installed_here = !registry || version_of(&comp).is_some();
            if opp.route == Route::AlreadyIncluded && installed_here && !deprecated.is_empty() && (opp.matched.iter().any(|(l, _)| !usage::plain_word(l)) || !calls.is_empty()) {
                opp.matched.retain(|(l, _)| !usage::plain_word(l));
                opp.matched.extend(calls.iter().cloned());
                opp.matched.sort();
                for (l, _) in &calls {
                    let n = ex_with(l, true).more;
                    if n > 0 {
                        opp.more.insert(l.clone(), n);
                    } else {
                        opp.more.remove(l);
                    }
                }
                let strict = |l: &str| if usage::plain_word(l) { ex_with(l, true) } else { ex(l) };
                opp.files = files_of(&opp.matched.iter().map(|(l, _)| l.clone()).collect::<Vec<_>>(), &strict);
                opp.route = Route::InEffect;
                // A known prerequisite of acting on it (the replacement needs a newer peer: ESLint's core rule handles
                // TypeScript imports from 9.37) that the project's version does not meet: the deprecated API is still
                // the right one here, so it is not owed now.
                if let Some(b) = blocked(rec, inp.stack, &comp, head_lock(&comp).as_deref()) {
                    opp.route = Route::Blocked(b);
                } else if let Some(s) = ledger_status() {
                    opp.withheld_from = Some(Route::InEffect);
                    opp.route = Route::Withheld(s);
                }
                opp.unmet = parse_version(&opp.release.version).and_then(|v| published_floor(inp.stack, &comp, &v, &opp.files));
            }
            let shown = matches!(opp.route, Route::UpgradeReview | Route::ImprovementsPass | Route::BumpDigest);
            if shown {
                // An obligation is never blocked: the upgrade brings it whatever the project's floor, and a record that
                // raises a minimum (Node, TypeScript) is exactly the one a floor below it must see.
                let b = blocked(rec, inp.stack, &comp, head_lock(&comp).as_deref());
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
            // A record that drops a language runtime version (Python 3.8, Node 18) the project's own declared range
            // already excludes (`requires-python = ">=3.12"`, `engines.node`): the repository has made that move.
            if matches!(opp.route, Route::UpgradeReview | Route::ImprovementsPass | Route::BumpDigest | Route::InEffect) && runtime_drop_met(rec, inp.stack).is_some() {
                opp.route = Route::Applied;
            }
            // Applied: an introduced literal as a whole token; never for a breaking change.
            if matches!(opp.route, Route::UpgradeReview | Route::ImprovementsPass) && !rec.r.breaking && applied() {
                opp.route = Route::Applied;
            }
            // A changed default does not reach a project that sets the option itself (Changesets 3's `baseBranch`
            // default, with `"baseBranch": "master"` in `.changeset/config.json`): the explicit setting already handles
            // it, breaking or not.
            if matches!(opp.route, Route::UpgradeReview | Route::ImprovementsPass) && rec.r.change_type == ChangeType::DefaultChange && option_set(view) {
                opp.route = Route::Applied;
            }
            // Already handled: the code writes what the record names as the replacement (`model_json_schema` beside a
            // remaining `json_schema()`), in a file about the technology. Lead order only (`adopted`).
            if matches!(opp.route, Route::UpgradeReview | Route::InEffect) && opp.matched.iter().any(|(l, _)| deprecated.contains(l)) {
                // Only what the record introduces, matched whole (`model_json_schema` contains `json_schema` and still
                // counts): other literals of the replacement's shape (`BaseModel` beside `json_schema()`) name the
                // general API, which every user writes.
                let intro: Vec<String> = rec.r.introduces.iter().filter_map(|x| clean_lit(x)).filter(|l| !deprecated.contains(l) && !usage::plain_word(l) && !l.contains(char::is_whitespace)).collect();
                opp.adopted = intro.iter().find_map(|l| {
                    hits_of(view).whole.get(l.as_str()).into_iter().flatten().find(|p| {
                        !matches!(role(p), usage::Role::Docs | usage::Role::Generated | usage::Role::Vendored)
                            && scopes[view].counts(l, p)
                            && scopes[view].file(p) == Some(true)
                            && inp.repo.text(p).is_some_and(|t| usage::written_outside_comments(p, t, l) && !usage::defines(t, l))
                    }).map(|p| (l.clone(), p.to_string()))
                });
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
                // Blocked only where every lockfile root holding this version fails the prerequisite.
                let blocks = w.locks.iter().all(|l| blocked(rec, inp.stack, &comp, l.as_deref()).is_some()) && !(route == Route::UpgradeReview && is_obligation(rec));
                if blocks || ledger_status().is_some() || (route == Route::UpgradeReview && !rec.r.breaking && applied_in(0)) {
                    continue;
                }
                w.target.get_or_insert(target);
                w.records.push((rec, route, decides.version.clone()));
            }
            // An opt-in that is its advisories' fix (each one patched at the record's release) and that the installed
            // version has: the fix is what installing that release does, so the option's protective default is already
            // in force (js-yaml 4.3.0's `maxTotalMergeKeys`, default 10000, for GHSA-52CP-R559-CP3M at 4.3.1). Nothing
            // is left to adopt, whatever else it is labelled with.
            if opp.route == Route::ImprovementsPass && fixed_by_install(rec, installed_for) && is_the_fix(rec, &opp.release) {
                opp.route = Route::AlreadyIncluded;
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
                    .filter(|b| *b != Benefit::Security || !fixed_by_install(rec, installed_for))
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
                    // A site: a `replaces` the code uses, or a specific term (a plain word such as `Node` is every
                    // codebase's own) in a file about the technology.
                    let site = replaces_here || ls.iter().any(|l| !usage::plain_word(l) && ev(l).files.iter().any(|(_, about)| *about));
                    if baseline(release, &installed, &td.index.releases) {
                        opp.route = Route::Baseline;
                    } else if requires_miss {
                        opp.route = Route::RequiresAbsent;
                    } else if settled(release, &installed, &td.index.releases, site) {
                        opp.route = Route::NoSite;
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
        supersede_by_removal(&mut out.opps[first..], inp);
        retire_opt_ins(&mut out.opps[first..]);
        workspaces.retain(|w| !w.records.is_empty());
        if !workspaces.is_empty() {
            out.workspaces.insert(tech.clone(), workspaces);
        }
    }
    order(&mut out);
    out
}

/// Whether an opt-in's security benefit is already in the installed version, so it needs no adoption (#55): the
/// record joins advisories, and the installed version of each one's packages is outside its affected ranges. The
/// advisory's fix shipped as the release's default (an advisory's patched version is one that installing fixes), and
/// the option is tuning on top of it (next's `images.maximumDiskCacheSize` beside GHSA-3X4C-7XQ6-9PQ8's default LRU
/// bound). No advisory, or one the resolved index cannot decide: the benefit stands (fail open).
fn fixed_by_install(rec: &Rec, installed_for: impl Fn(&str) -> Option<Version>) -> bool {
    !rec.r.advisories.is_empty()
        && rec.r.advisories.iter().all(|a| {
            let comps: BTreeSet<String> = a.affected.iter().map(|r| normalize_purl(&r.component)).collect();
            !comps.is_empty() && comps.iter().all(|c| installed_for(c).is_some_and(|v| crate::review::advisory_affects(a, c, &v) == Some(false)))
        })
}

/// Whether the record is its advisories' fix: every advisory has a range of the shown release's package whose patched
/// version is that release (an option added as the fix, not tuning beside a fix shipped elsewhere).
fn is_the_fix(rec: &Rec, release: &Release) -> bool {
    let comp = normalize_purl(&release.component);
    !rec.r.advisories.is_empty()
        && rec.r.advisories.iter().all(|a| a.affected.iter().any(|r| normalize_purl(&r.component) == comp && r.patched.as_deref() == Some(release.version.as_str())))
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
        more: BTreeMap::new(),
        files: vec![],
        requires_miss: false,
        benefits: vec![],
        borderline_benefit: false,
        withheld_from: None,
        unmet: None,
        elsewhere: vec![],
        adopted: None,
        part: None,
    }
}

/// The records of `comp` of the given kinds released after `since` and at or below `installed` (exact releases only),
/// that the installed version therefore has: a later removal or deprecation that retires an earlier record's API.
fn later_records<'o>(opps: &'o [Opp], comp: &'o str, since: &'o Version, installed: &'o Version, kinds: &'o [ChangeType]) -> impl Iterator<Item = usize> + 'o {
    (0..opps.len()).filter(move |&j| {
        let r = &opps[j];
        kinds.contains(&r.rec.r.change_type)
            && matches!(r.route, Route::AlreadyIncluded | Route::InEffect)
            && r.component() == comp
            && r.release.no_later_than.is_none()
            && parse_version(&r.release.version).is_some_and(|v| v > *since && v <= *installed)
    })
}

/// An opt-in in the improvements pass whose every introduced API (`introduces`) a later removal or deprecation of the
/// same package, at or below the installed version, names in its `replaces` (open 7.0.0's `url` option, removed in
/// 8.0.0; installed 9.1.0): at the installed version the API is gone or on its way out, so there is nothing to adopt.
fn retire_opt_ins(opps: &mut [Opp]) {
    for i in 0..opps.len() {
        if opps[i].route != Route::ImprovementsPass {
            continue;
        }
        let intro: BTreeSet<String> = opps[i].rec.r.introduces.iter().filter_map(|x| usage::api_name(x)).collect();
        let Some(since) = parse_version(&opps[i].release.version) else { continue };
        if intro.is_empty() {
            continue;
        }
        let comp = opps[i].component();
        let installed = opps[i].installed.clone();
        let gone: BTreeSet<String> = later_records(opps, &comp, &since, &installed, &[ChangeType::Removal, ChangeType::Deprecation])
            .flat_map(|j| opps[j].rec.r.replaces.iter().filter_map(|x| usage::api_name(x)))
            .collect();
        if intro.is_subset(&gone) {
            opps[i].route = Route::Retired;
        }
    }
}

/// A deprecation in effect whose API a removal record of the same package has since removed, at or below the installed
/// version and after the deprecation's release (React 18.0.0 deprecates `ReactDOM.render`, 19.0.0 removes it; installed
/// 19.2.3): at the installed version
/// the API is gone, so the site breaks rather than warns. The removal takes the deprecation's place in effect, citing
/// the sites the deprecation's usage rules found for the literals both name (the removal's own `replaces`; the
/// manifests on another release line it names, `Opp::elsewhere`, stay the removal's own, which are per record), and the
/// deprecation counts as already included. Code using an API that no longer exists fails, so the removal carries a
/// correctness benefit whatever its record says. Among several removals naming the literal, the one about it (its
/// subject is the literal) and naming the most of the cited literals wins, then the earliest release, then the id.
/// A removal the ledger withholds stays withheld, and the deprecation stays in effect.
fn supersede_by_removal(opps: &mut [Opp], inp: &Input) {
    let lits = |o: &Opp| -> BTreeSet<String> { o.rec.r.replaces.iter().filter_map(|x| clean_lit(x)).collect() };
    for i in 0..opps.len() {
        if opps[i].route != Route::InEffect || opps[i].rec.r.change_type != ChangeType::Deprecation {
            continue;
        }
        let comp = opps[i].component();
        let installed = opps[i].installed.clone();
        let Some(since) = parse_version(&opps[i].release.version) else { continue };
        let cited: BTreeSet<&str> = opps[i].matched.iter().map(|(l, _)| l.as_str()).collect();
        let best = later_records(opps, &comp, &since, &installed, &[ChangeType::Removal])
            .filter_map(|j| {
                let shared: Vec<String> = lits(&opps[j]).into_iter().filter(|l| cited.contains(l.as_str())).collect();
                (!shared.is_empty()).then_some((j, shared))
            })
            .min_by(|(a, x), (b, y)| {
                let about = |j: usize, s: &[String]| clean_lit(&opps[j].rec.r.subject).is_some_and(|t| s.contains(&t));
                (!about(*a, x), std::cmp::Reverse(x.len()), parse_version(&opps[*a].release.version), opps[*a].id())
                    .cmp(&(!about(*b, y), std::cmp::Reverse(y.len()), parse_version(&opps[*b].release.version), opps[*b].id()))
            });
        let Some((j, shared)) = best else { continue };
        let rid = &opps[j].rec.r;
        if inp.ledger.entries.iter().any(|e| e.id() == rid.id && withholds(e, rid.revision, inp.today)) {
            continue;
        }
        let dep = opps[i].clone();
        let r = &mut opps[j];
        if r.route != Route::InEffect {
            r.matched.clear();
            r.more.clear();
            r.files.clear();
            r.score = 0.0;
        }
        r.route = Route::InEffect;
        for (l, f) in dep.matched.iter().filter(|(l, _)| shared.contains(l)) {
            if !r.matched.iter().any(|(m, _)| m == l) {
                r.matched.push((l.clone(), f.clone()));
            }
            if let Some(n) = dep.more.get(l) {
                r.more.insert(l.clone(), *n);
            }
        }
        r.matched.sort();
        let files: BTreeSet<&String> = r.matched.iter().flat_map(|(_, f)| f.iter()).collect();
        for f in dep.files.iter().filter(|f| files.contains(f)) {
            if !r.files.contains(f) && r.files.len() < 3 {
                r.files.push(f.clone());
            }
        }
        r.score = r.score.max(dep.score);
        r.unmet = r.unmet.take().or(dep.unmet);
        r.benefits.retain(|b| !matches!(b, Benefit::None | Benefit::Other));
        if !r.benefits.contains(&Benefit::Correctness) {
            r.benefits.push(Benefit::Correctness);
            r.benefits.sort_by_key(benefit_rank);
        }
        opps[i].route = Route::AlreadyIncluded;
    }
}

/// For an in-effect deprecation cited in a published package: the replacement arrived in `introduced`, and the
/// package's declared range lets its users install an older version, which lacks it. Moving off the deprecated API
/// there takes raising the range first (`@nx/webpack` declares `terser-webpack-plugin` `^5.3.3`; `minimizerOptions`
/// arrived in 5.6.0). The installed version says nothing about what the package's users get. A library's reading keeps
/// its declared range (`stack::Reading::range`); an application's locked reading has none.
fn published_floor(stack: &Stack, comp: &str, introduced: &Version, files: &[String]) -> Option<String> {
    let (_, d) = stack.deps.iter().find(|(p, _)| normalize_purl(p) == comp)?;
    let lib = |dir: &str| stack.packages.iter().any(|p| p.dir == dir && p.kind == crate::stack::Kind::Library);
    let mut low: Vec<String> = files
        .iter()
        .filter_map(|f| d.owner(f))
        .filter(|r| lib(&r.dir))
        .filter_map(|r| {
            let (shown, floor) = match r.range.as_ref()? {
                crate::stack::Range::Npm(x) => (x, crate::util::range_floor(x)),
                crate::stack::Range::Pypi(x) => (x, crate::pypi::spec_floor(x)),
            };
            floor.filter(|f| f < introduced).map(|_| format!("{} declares {} {shown}", place(&r.dir), d.name))
        })
        .collect();
    low.sort();
    low.dedup();
    (!low.is_empty()).then(|| format!("{}, which admits versions before {introduced}, where the replacement is missing: raise the declared range to >={introduced}", low.join("; ")))
}

/// Whether a removal drops support for language runtime versions the project's declared range already excludes:
/// the record is about the runtime (its subject starts with a runtime name the stack reads a floor for: `Python 3.9`,
/// `Python version support`), and either its prerequisite on that runtime is at or below the project's floor, or,
/// with none, the version its subject (else its summary) names ends at or below it (`Python 3.9` ends at 3.10; a
/// stated minimum, `Python 3.10+`, at 3.10: `runtime_bounds`). Returns the project's
/// declaration.
pub(crate) fn runtime_drop_met(rec: &Rec, stack: &Stack) -> Option<String> {
    if rec.r.change_type != ChangeType::Removal {
        return None;
    }
    let mut words = rec.r.subject.split_whitespace();
    let runtime = words.next()?.trim_matches('`');
    let found = stack.runtime_floor(runtime)?;
    let (floor, source) = found;
    // A prerequisite on the same runtime, however spelled (`node` for a `Node.js 18` subject), is the record's own
    // statement of the new minimum and decides alone: a `Python 3.9` subject with `python >= 3.11` also drops 3.10.
    let same = |name: &str| stack.runtime_floor(name).is_some_and(|f| std::ptr::eq(f, found));
    let prereqs: Vec<&str> = rec.r.prerequisites.iter().filter(|p| same(&p.name)).filter_map(|p| p.min.as_deref()).collect();
    let met = if !prereqs.is_empty() {
        prereqs.iter().all(|m| parse_version(m).is_some_and(|m| *floor >= m))
    } else {
        // The versions the subject names, else the summary's (`Python support`: "Support for Python 3.9 was removed").
        let bounds = runtime_bounds(&rec.r.subject, runtime);
        let bounds = if bounds.is_empty() { runtime_bounds(&rec.r.summary, runtime) } else { bounds };
        !bounds.is_empty() && bounds.iter().all(|b| *floor >= *b)
    };
    met.then(|| source.clone())
}

/// The lowest runtime version `text` leaves the project needing, per mention of `runtime` followed by a version: the
/// version itself when it is stated as the new minimum (`Python 3.10+`, `Python >= 3.10`, `Python 3.10 or newer is
/// required`), else the first version after the one named, which the record drops (`Python 3.9` ends at 3.10).
fn runtime_bounds(text: &str, runtime: &str) -> Vec<Version> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let bare = |w: &str| w.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.').trim_end_matches('.').to_string();
    let mut out = vec![];
    for i in 0..words.len() {
        if !bare(words[i]).eq_ignore_ascii_case(runtime) {
            continue;
        }
        let mut j = i + 1;
        let mut min = false;
        if words.get(j).is_some_and(|w| matches!(w.trim_matches('`'), ">=" | "≥")) {
            min = true;
            j += 1;
        }
        let Some(w) = words.get(j).map(|w| w.trim_matches('`').trim_start_matches(">=").trim_start_matches('≥')) else { continue };
        if !w.starts_with(|c: char| c.is_ascii_digit()) {
            continue;
        }
        let digits = w.trim_end_matches(|c: char| !c.is_ascii_digit());
        min |= w[digits.len()..].starts_with('+') || words[i + 1].starts_with(">=") || words[i + 1].starts_with('≥');
        let next: Vec<String> = words.iter().skip(j + 1).take(3).map(|w| w.trim_matches(|c: char| !c.is_ascii_alphanumeric()).to_ascii_lowercase()).collect();
        let next: Vec<&str> = next.iter().map(String::as_str).collect();
        min |= matches!(next.as_slice(), ["or", "newer" | "later" | "higher" | "above" | "greater", ..] | ["is", "required", ..] | ["required", ..] | ["is", "now", "required", ..] | ["minimum", ..]);
        let nums: Vec<u64> = digits.split('.').map_while(|p| p.parse().ok()).collect();
        let v = match nums.as_slice() {
            [major] => if min { Version::new(*major, 0, 0) } else { Version::new(major + 1, 0, 0) },
            [major, minor] => Version::new(*major, if min { *minor } else { minor + 1 }, 0),
            [major, minor, patch, ..] => Version::new(*major, *minor, if min { *patch } else { patch + 1 }),
            [] => continue,
        };
        out.push(v);
    }
    out
}

/// The lockfile a package's headline version is read from (`Outcome::headline`, else `Dep::headline`).
pub(crate) fn headline_lock<'s>(stack: &'s Stack, out: &Outcome, component: &str) -> Option<&'s str> {
    let d = stack.deps.get(component)?;
    let here = out.headline.get(component).and_then(|(dir, _)| d.readings.iter().find(|r| r.dir == *dir));
    here.or_else(|| d.headline())?.lock.as_deref()
}

/// A structured npm prerequisite above the project's floor, or below a declared maximum. Names the project cannot
/// answer (another ecosystem, a package it does not declare) fail open: never block the record. `lock` is the
/// lockfile the upgrade's version is read from: a Node prerequisite is checked against that root's own floor.
pub(crate) fn blocked(rec: &Rec, stack: &Stack, component: &str, lock: Option<&str>) -> Option<String> {
    for p in &rec.r.prerequisites {
        if !p.ecosystem.eq_ignore_ascii_case("npm") {
            continue;
        }
        if normalize_purl(&crate::util::npm_purl(&p.name.to_lowercase())) == component {
            continue; // the upgrade itself satisfies it
        }
        let Some(have) = stack.npm_version_in(&p.name, lock) else { continue };
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
    // Upgrade review: records whose `requires` match nothing last, then records citing no site ("Matched terms:
    // none": their score may come from words they do not cite), then type tier, then rarity-weighted usage.
    // Applicability variants inside tier 1 were measured and not adopted (eval/rank/RESULTS.md); `requires` values
    // the record introduces are not preconditions (set in `run`).
    let mut up: Vec<usize> = (0..opps.len()).filter(|&i| opps[i].route == Route::UpgradeReview).collect();
    up.sort_by(|&a, &b| {
        let (x, y) = (&opps[a], &opps[b]);
        (x.requires_miss, x.matched.is_empty(), x.tier)
            .cmp(&(y.requires_miss, y.matched.is_empty(), y.tier))
            .then(cmp_score(x.score, y.score))
            .then_with(|| x.id().cmp(y.id()))
    });
    out.upgrade = siblings_together(opps, up);
    let mut now: Vec<usize> = (0..opps.len()).filter(|&i| opps[i].route == Route::InEffect).collect();
    now.sort_by(|&a, &b| cmp_score(opps[a].score, opps[b].score).then_with(|| opps[a].id().cmp(opps[b].id())));
    out.in_effect = now;
    // Improvements pass: borderline last, then records citing no site ("Matched terms: none"), then best benefit, then
    // usage. Among the borderline and the unmatched, technologies take turns (each one's best first, then each one's
    // second, ...): one package's many unmatched options do not fill a batch.
    let mut imp: Vec<usize> = (0..opps.len()).filter(|&i| opps[i].route == Route::ImprovementsPass).collect();
    let best = |o: &Opp| o.benefits.first().map(benefit_rank).unwrap_or(9);
    let group = |o: &Opp| (o.borderline_benefit, o.matched.is_empty());
    imp.sort_by(|&a, &b| {
        let (x, y) = (&opps[a], &opps[b]);
        (group(x), best(x))
            .cmp(&(group(y), best(y)))
            .then(cmp_score(x.score, y.score))
            .then_with(|| x.id().cmp(y.id()))
    });
    let mut turn: BTreeMap<(bool, bool, &str), usize> = BTreeMap::new();
    let mut keyed: Vec<((bool, bool), usize, usize, usize)> = imp
        .iter()
        .enumerate()
        .map(|(pos, &i)| {
            let o = &opps[i];
            let (borderline, unmatched) = group(o);
            let n = turn.entry((borderline, unmatched, o.rec.r.technology.as_str())).or_insert(0);
            *n += 1;
            ((borderline, unmatched), if borderline || unmatched { *n } else { 0 }, pos, i)
        })
        .collect();
    keyed.sort();
    out.improvements = keyed.into_iter().map(|k| k.3).collect();
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
            if placed[j] || (b.requires_miss, b.matched.is_empty(), b.tier) != (a.requires_miss, a.matched.is_empty(), a.tier) {
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
    why_scoped(out, None, routes)
}

/// `why` over the records of `techs` only: what one technology's bump picks up is not the whole catalog's funnel.
pub fn why_for(out: &Outcome, techs: &[String], routes: &[&str]) -> String {
    why_scoped(out, Some(techs), routes)
}

fn why_scoped(out: &Outcome, techs: Option<&[String]>, routes: &[&str]) -> String {
    let mut c: BTreeMap<String, usize> = BTreeMap::new();
    let mut withheld: BTreeMap<&str, usize> = BTreeMap::new();
    let mut n_opps = 0;
    for o in out.opps.iter().filter(|o| techs.is_none_or(|t| t.contains(&o.rec.r.technology))) {
        n_opps += 1;
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
            Route::NoSite => "opt-in on the installed line for a year or more with no site in this code (part of the installed version)",
            Route::Retired => "opt-in whose API a later release at or below the installed version removed or deprecated",
            Route::InEffect => IN_EFFECT,
            Route::AlreadyIncluded => "already in the installed version with nothing to adopt",
            Route::BeyondTarget => "released after the target version",
            Route::OlderLine => "released only on older release lines than the installed version",
            Route::OtherPackage => "about another package of the technology's repository that this repository does not use",
            Route::VersionUnknown => "not applicable: the installed version could not be read",
            Route::ReleaseUnknown => "not placed: read from a page that changes, so the exact release is not known (the installed or target version is inside its range)",
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
    let named = match techs {
        Some(t) => t.join(", "),
        None => out.technologies.join(", "),
    };
    if techs.is_some_and(|t| !t.is_empty()) && n_opps == 0 {
        return format!("no records for {named} in the catalog");
    }
    if out.technologies.is_empty() {
        if let Some(why) = &out.unread {
            return format!("nothing was checked: {why}");
        }
        return match &out.uncovered {
            Some(why) => format!("no catalog technology covers this repository yet: {why}"),
            None => "no catalog technology matches this repository's packages (run `unstale sync`)".into(),
        };
    }
    if parts.is_empty() {
        // Every record went to one of `routes`, which the caller lists itself.
        if !c.is_empty() {
            return format!("no other records for {named} in the catalog");
        }
        return format!("{n_opps} records for {named} in the catalog");
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
            node_by_lock: Default::default(),
            python: None,
            notes: vec![],
            unreadable: 0, stub_runtimes: Default::default(), spread: 0, peers: vec![], unlocked: vec![],
            standalone: vec![],
            registries: Default::default(),
            fixture_registries: Default::default(),
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

    #[test]
    fn one_version_for_packages_installed_on_other_lines_numbers_the_repository() {
        let rel = |c: &str, v: &str| Release { component: c.into(), version: v.into(), date: "2026-04-13".into(), line: String::new(), no_later_than: None };
        let installed = |c: &str| match c {
            "pkg:npm/%40metamask/account-api" => parse_version("2.1.0"),
            "pkg:npm/%40metamask/keyring-utils" => parse_version("5.0.0"),
            "pkg:npm/%40sentry/browser" | "pkg:npm/%40sentry/core" => parse_version("10.38.0"),
            _ => None,
        };
        let (a, k) = (rel("pkg:npm/%40metamask/account-api", "100.0.0"), rel("pkg:npm/%40metamask/keyring-utils", "100.0.0"));
        assert!(repository_numbered(&[&a, &k], installed), "MetaMask's accounts monorepo tag v100.0.0");
        let (b, c) = (rel("pkg:npm/%40sentry/browser", "11.0.0"), rel("pkg:npm/%40sentry/core", "11.0.0"));
        assert!(!repository_numbered(&[&b, &c], installed), "a fixed-version monorepo installed on one line");
        assert!(!repository_numbered(&[&a], installed), "one package says nothing");
        let a2 = rel("pkg:npm/%40metamask/account-api", "5.0.0");
        let k2 = rel("pkg:npm/%40metamask/keyring-utils", "5.0.0");
        assert!(!repository_numbered(&[&a2, &k2], installed), "a package installed on the shared version's line");
    }
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
    fn a_removal_at_or_below_the_installed_version_supersedes_the_deprecation_in_effect() {
        // React 18.0.0 deprecates `ReactDOM.render`, 19.0.0 removes it; at 19.2.3 the call breaks, not warns.
        let dep = with(rec("react:render", "pkg:npm/react", "18.0.0"), json!({"change_type":"deprecation","replaces":["ReactDOM.render"]}));
        let gone = |id: &str, subject: &str, replaces: serde_json::Value| {
            with(rec(id, "pkg:npm/react", "19.0.0"), json!({"change_type":"removal","breaking":true,"benefit":["none"],"subject":subject,"replaces":replaces}))
        };
        let c = catalog(
            "react",
            0,
            vec![
                dep.clone(),
                gone("react:render~2", "ReactDOM.render", json!(["ReactDOM.render"])),
                gone("react:legacy-mode", "legacy mode", json!(["ReactDOM.render", "ReactDOM.hydrate"])),
                gone("react:other", "findDOMNode", json!(["findDOMNode"])),
            ],
        );
        let r = repo(&[("src/main.tsx", "import ReactDOM from 'react-dom';\nimport App from './App';\nReactDOM.render(<App />, root);\n")]);
        let l = Ledger::default();
        let s19 = stack(&[("react", "19.2.3")], None);
        let out = run_with(&c, &s19, &r, &l);
        assert_eq!(ids(&out, &out.in_effect), vec!["react:render~2"], "the removal about the API, not the deprecation or a broader removal");
        let o = out.opps.iter().find(|o| o.id() == "react:render~2").unwrap();
        assert_eq!(o.matched, vec![("ReactDOM.render".to_string(), vec!["src/main.tsx".to_string()])]);
        assert_eq!(o.benefits, vec![Benefit::Correctness], "code using a removed API fails");
        assert_eq!(route_of(&out, "react:render"), &Route::AlreadyIncluded);
        assert_eq!(route_of(&out, "react:legacy-mode"), &Route::AlreadyIncluded);
        // Between the deprecation and the removal, the deprecation is what is in effect.
        let s18 = stack(&[("react", "18.3.1")], None);
        let out = run_with(&c, &s18, &r, &l);
        assert_eq!(ids(&out, &out.in_effect), vec!["react:render"]);
    }

    #[test]
    fn in_effect_npm_sites_need_a_directory_an_installed_copy_was_read_from() {
        // projen: react 19.2.3 is read from `docusaurus/`'s own lockfile; the root declares no react, so the root's
        // `src/web/react.ts` (named for react, writing `ReactDOM.render` into generated code) runs no copy of it.
        let c = catalog("react", 0, vec![with(rec("react:render", "pkg:npm/react", "18.0.0"), json!({"change_type":"deprecation","replaces":["ReactDOM.render"]}))]);
        let mut s = stack(&[("react", "19.2.3")], None);
        s.packages = vec![package(".", crate::stack::Kind::Library, &[]), package("docusaurus", crate::stack::Kind::Application, &["react"])];
        s.deps.get_mut(&crate::util::npm_purl("react")).unwrap().readings = vec![Reading {
            dir: "docusaurus".into(),
            version: parse_version("19.2.3").unwrap(),
            source: "docusaurus/package-lock.json".into(),
            standalone: false,
            range: None,
            lock: Some("docusaurus/package-lock.json".into()),
        }];
        let l = Ledger::default();
        let root = repo(&[("src/web/react.ts", "export const index = `import ReactDOM from 'react-dom';\nReactDOM.render(<App />, root);`;\n")]);
        assert!(run_with(&c, &s, &root, &l).in_effect.is_empty(), "no installed copy at the root");
        let site = repo(&[("docusaurus/src/main.tsx", "import ReactDOM from 'react-dom';\nReactDOM.render(<App />, root);\n")]);
        assert_eq!(ids(&run_with(&c, &s, &site, &l), &run_with(&c, &s, &site, &l).in_effect), vec!["react:render"]);
    }

    #[test]
    fn a_deprecation_without_replaces_deprecates_its_subject_when_the_summary_says_so() {
        // marked 5: `replaces` was not extracted, the subject and summary name the deprecated option.
        let c = catalog(
            "marked",
            0,
            vec![
                with(rec("marked:headerids", "pkg:npm/marked", "5.0.0"), json!({"change_type":"deprecation","subject":"headerIds","terms":[["headerIds",0],["marked.use",0]],"summary":"The headerIds option is deprecated; use marked-gfm-heading-id instead."})),
                // The subject is the successor here, not what is deprecated: not in effect.
                with(rec("marked:use", "pkg:npm/marked", "5.0.0"), json!({"change_type":"deprecation","subject":"marked.use","terms":[["marked.use",0],["setOptions",0]],"summary":"marked.use replaces the deprecated setOptions."})),
            ],
        );
        let s = stack(&[("marked", "5.1.2")], None);
        let r = repo(&[("src/md.ts", "import { marked } from 'marked';\nmarked.setOptions({ headerIds: false });\nmarked.use({});")]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(ids(&out, &out.in_effect), vec!["marked:headerids"]);
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
    fn a_deprecation_whose_replacement_the_code_already_writes_is_adopted() {
        // pydantic/logfire (attempt 40): `json_schema()` remains at one site while the code already calls the record's
        // replacement, `model_json_schema`, in a file importing pydantic. Still in effect, but already handled: it no
        // longer leads (`Opp::adopted`). Docs and comments naming the replacement are not adoption.
        let dep = with(
            rec("pydantic:model-json-schema", "pkg:pypi/pydantic", "2.0.0"),
            json!({"change_type":"deprecation","replaces":["json_schema()"],"introduces":["model_json_schema"],"terms":[["json_schema()",0],["BaseModel",0]]}),
        );
        let c = catalog("pydantic", 0, vec![dep]);
        let mut s = stack(&[], None);
        s.deps.insert("pkg:pypi/pydantic".into(), crate::stack::Dep { version: parse_version("2.14.0"), source: "test".into(), ..crate::stack::Dep::new("pydantic", true) });
        let old = ("src/vars.py", "import pydantic\nfrom .models import M\n\nschema = M.json_schema()\n");
        let l = Ledger::default();
        let r = repo(&[old, ("docs/guide.py", "from pydantic import BaseModel\nM.model_json_schema()\n"), ("src/note.py", "from pydantic import BaseModel\n# use model_json_schema\n")]);
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "pydantic:model-json-schema").unwrap();
        assert_eq!((&o.route, &o.adopted), (&Route::InEffect, &None), "only documentation and a comment name the replacement");
        let r = repo(&[old, ("src/models.py", "from pydantic import BaseModel\n\nschema = Inputs.model_json_schema()\n")]);
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "pydantic:model-json-schema").unwrap();
        assert_eq!(o.route, Route::InEffect, "still cited in its review");
        assert_eq!(o.adopted, Some(("model_json_schema".to_string(), "src/models.py".to_string())));
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
        // Nothing else of the technology lives under it, but the record's subject ("hook markers") is narrower than the
        // namespace: test markers are still not hook markers (NousResearch/hermes-agent's `@pytest.mark.asyncio`).
        let c = catalog("pytest", 0, records(false));
        assert!(run_with(&c, &s, &r, &l).in_effect.is_empty(), "a namespace narrower than its record's subject");
        // A record about the namespace itself reads it as one API, as before.
        let whole = with(dep("pytest:hook-markers", markers.clone()), json!({"subject":"pytest.mark"}));
        let c = catalog("pytest", 0, vec![whole]);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(ids(&out, &out.in_effect), vec!["pytest:hook-markers"]);
        // A specific literal of the record within a few lines of a test marker, but not on the definition it decorates
        // (`pytest_plugins = [...]` above `@pytest.mark.asyncio`), is not beside it.
        let plugins = "import pytest\n\npytest_plugins = ['tests.x']\n\n\n@pytest.mark.asyncio\nasync def test_a():\n    pass\n";
        for others in [false, true] {
            let r = repo(&[("tests/test_a.py", plugins)]);
            let c = catalog("pytest", 0, records(others));
            assert!(run_with(&c, &s, &r, &l).in_effect.is_empty(), "others: {others}");
        }
        // A member another record is about is another API, not context: `pytest.mark.parametrize` named by this record
        // too does not make test markers count.
        let mut v = records(true);
        v[0] = dep("pytest:hook-markers", json!({"replaces":["pytest.mark"],"terms":[["pytest.mark",0],["pytest.mark.parametrize",0],["pytest_addoption",0]]}));
        let c = catalog("pytest", 0, v);
        assert!(run_with(&c, &s, &r, &l).in_effect.is_empty());
        // A marker on a hook the record names is the deprecated use.
        let hooked = "import pytest\n\n@pytest.mark.tryfirst\ndef pytest_addoption(parser):\n    pass\n";
        let r = repo(&[("tests/test_a.py", tests), ("plugin/plugin.py", hooked)]);
        let c = catalog("pytest", 0, records(true));
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "pytest:hook-markers").unwrap();
        assert_eq!((&o.route, &o.matched), (&Route::InEffect, &vec![("pytest.mark".to_string(), vec!["plugin/plugin.py".to_string()])]));
    }

    #[test]
    fn a_python_keyword_deprecation_is_in_effect_only_where_its_api_is_called() {
        // NousResearch/hermes-agent: `list_models(model_name=…)` is deprecated; a file that imports huggingface_hub for an
        // error class and has its own `model_name` parameter does not use it.
        let purl = "pkg:pypi/huggingface-hub";
        let r0 = with(rec("hf:model-name", purl, "1.11.0"), json!({"change_type":"deprecation","subject":"list_models","replaces":["model_name"],"terms":[["model_name",0]]}));
        let mut s = stack(&[], None);
        s.deps.insert(purl.into(), crate::stack::Dep { version: parse_version("1.33.0"), source: "test".into(), ..crate::stack::Dep::new("huggingface-hub", true) });
        let local = "def _norm(model_name):\n    return model_name\n\ndef _load(model_name):\n    from huggingface_hub.errors import LocalEntryNotFoundError\n    return WhisperModel(model_name)\n";
        let call = "from huggingface_hub import list_models\n\nmodels = list_models(model_name='bert')\n";
        let l = Ledger::default();
        let c = catalog("hf", 0, vec![r0]);
        assert!(run_with(&c, &s, &repo(&[("tools/transcription_local.py", local)]), &l).in_effect.is_empty());
        let r = repo(&[("tools/transcription_local.py", local), ("app/hub.py", call)]);
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "hf:model-name").unwrap();
        assert_eq!((&o.route, &o.matched), (&Route::InEffect, &vec![("model_name".to_string(), vec!["app/hub.py".to_string()])]));
    }

    #[test]
    fn a_removal_does_not_match_the_replacement_its_summary_names() {
        // microsoft/qlib: numpy 2.0 removes `np.infty` ("Removed; use `np.inf` instead") and the record's terms include
        // `np.inf`; code writing `np.inf` is already on the replacement.
        let r = |id: &str,
                 subject: &str,
                 summary: &str,
                 terms: serde_json::Value|
         -> crate::cache::Rec {
            let v = with(
                rec(id, "pkg:pypi/numpy", "2.0.0"),
                json!({"change_type":"removal","subject":subject,"summary":summary,"replaces":[subject],"terms":terms}),
            );
            crate::cache::Rec {
                r: serde_json::from_value(v).unwrap(),
                borderline: vec![],
            }
        };
        let lits = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let infty = r(
            "numpy:np.infty",
            "np.infty",
            "Removed; use `np.inf` instead.",
            json!([["np.infty", 0], ["numpy.infty", 0], ["np.inf", 0]]),
        );
        assert_eq!(
            successor_lits(&infty, &lits(&["np.infty", "numpy.infty", "np.inf"])),
            lits(&["np.inf"])
        );
        // The removed name itself stays even where it differs from the replacement only in case.
        let inf = r(
            "numpy:np.inf",
            "np.Inf",
            "Removed; use `np.inf` instead.",
            json!([["np.Inf", 0], ["np.inf", 0]]),
        );
        assert_eq!(
            successor_lits(&inf, &lits(&["np.Inf", "np.inf"])),
            lits(&["np.inf"])
        );
        // "Use of X" names the old API; a summary naming no successor drops nothing; nor does a record without `replaces`.
        let of = r(
            "x:a",
            "foo",
            "Use of `bar` with foo is deprecated.",
            json!([["foo", 0], ["bar", 0]]),
        );
        assert!(successor_lits(&of, &lits(&["foo", "bar"])).is_empty());
        let none = r(
            "x:b",
            "foo",
            "Removed without a replacement.",
            json!([["foo", 0]]),
        );
        assert!(successor_lits(&none, &lits(&["foo"])).is_empty());
        let mut bare = r(
            "x:c",
            "foo",
            "Removed; use bar instead.",
            json!([["foo", 0], ["bar", 0]]),
        );
        bare.r.replaces.clear();
        assert!(successor_lits(&bare, &lits(&["foo", "bar"])).is_empty());
        let multi = r(
            "x:d",
            "old_fn",
            "old_fn is removed; it was replaced by new_fn. Calls of helper keep working.",
            json!([["old_fn", 0], ["new_fn", 0], ["helper", 0]]),
        );
        assert_eq!(
            successor_lits(&multi, &lits(&["old_fn", "new_fn", "helper"])),
            lits(&["new_fn"])
        );
        let path = r("x:e", "subscriptions-transport-ws", "Removed; migrate to `graphql-ws` or `@apollo/client/link/subscriptions`.", json!([["subscriptions-transport-ws",0],["graphql-ws",0],["@apollo/client/link/subscriptions",0]]));
        assert_eq!(successor_lits(&path, &lits(&["subscriptions-transport-ws", "graphql-ws", "@apollo/client/link/subscriptions"])), lits(&["graphql-ws", "@apollo/client/link/subscriptions"]));
        // A deprecation keeps every literal for its score.
        let mut dep = r("x:f", "np.infty", "Deprecated; use `np.inf` instead.", json!([["np.infty",0],["np.inf",0]]));
        dep.r.change_type = ChangeType::Deprecation;
        assert!(successor_lits(&dep, &lits(&["np.infty", "np.inf"])).is_empty());
    }

    #[test]
    fn a_term_the_summary_does_not_name_as_successor_is_no_fallback() {
        // open-webui/open-webui: aiohttp deprecates `BasicAuth` ("use encode_basic_auth with an Authorization header");
        // its terms also name `ClientSession`, which the deprecated call is written inside. `from aiohttp import
        // BasicAuth, ClientSession` and `auth=BasicAuth(...)` under `async with ClientSession()` are a live site.
        let purl = "pkg:pypi/aiohttp";
        let summary = "BasicAuth is deprecated; use encode_basic_auth with an Authorization header.";
        let r0 = with(
            rec("aiohttp:basicauth", purl, "3.14.0"),
            json!({"change_type":"deprecation","subject":"BasicAuth","summary":summary,"replaces":["BasicAuth"],"terms":[["BasicAuth",0],["auth",0],["Authorization",0],["headers",0],["ClientSession",0]]}),
        );
        let mut s = stack(&[], None);
        s.deps.insert(purl.into(), crate::stack::Dep { version: parse_version("3.14.5"), source: "test".into(), ..crate::stack::Dep::new("aiohttp", true) });
        let bare = "from aiohttp import BasicAuth, ClientSession\n\nasync def f(c):\n    async with ClientSession() as s:\n        await s.post('x', auth=BasicAuth(c.id, c.secret or ''))\n";
        let (l, r) = (Ledger::default(), repo(&[("app/auths.py", bare)]));
        let c = c_of(r0.clone());
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "aiohttp:basicauth").unwrap();
        assert_eq!((&o.route, &o.matched), (&Route::InEffect, &vec![("BasicAuth".to_string(), vec!["app/auths.py".to_string()])]));
        // A summary naming the term as what to use keeps it the successor: beside it, the old name is a fallback.
        let r1 = with(r0.clone(), json!({"summary":"BasicAuth is deprecated; use ClientSession(auth_header=...) instead."}));
        let c = c_of(r1);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "aiohttp:basicauth"), &Route::AlreadyIncluded);
        // So does one naming it in another case style (`clientSession` for the `ClientSession` term).
        let r2 = with(r0, json!({"summary":"BasicAuth is deprecated; use clientSession instead."}));
        let c = c_of(r2);
        assert_eq!(route_of(&run_with(&c, &s, &r, &l), "aiohttp:basicauth"), &Route::AlreadyIncluded);
        fn c_of(r: serde_json::Value) -> Catalog {
            catalog("aiohttp", 0, vec![r])
        }
    }

    #[test]
    fn a_lint_rule_record_has_no_site_where_the_config_never_turns_the_rule_on() {
        // dolanmiu/docx: `jsdoc/prefer-import-tag` changed; eslint.config.ts turns on only `jsdoc/check-alignment`, and
        // `@param` is in every documented file.
        let r = with(
            rec("jsdoc:prefer-import-tag", "pkg:npm/eslint-plugin-jsdoc", "65.3.15"),
            json!({"change_type":"fix","breaking":true,"surface":"configuration","terms":[["jsdoc/prefer-import-tag",0],["prefer-import-tag",0],["@param",0]]}),
        );
        let (l, c) = (Ledger::default(), catalog("eslint-plugin-jsdoc", 0, vec![r]));
        let s = stack(&[("eslint-plugin-jsdoc", "65.3.8")], None);
        let code = ("src/a.ts", "/**\n * @param x the value\n */\nexport const f = (x: number) => x;\n");
        let matched = |config: &str| {
            let r = repo(&[("eslint.config.ts", config), code]);
            let out = run_with(&c, &s, &r, &l);
            out.opps.iter().find(|o| o.id() == "jsdoc:prefer-import-tag").map(|o| o.matched.clone()).unwrap_or_default()
        };
        let head = "import jsdoc from 'eslint-plugin-jsdoc';\nexport default [{ plugins: { jsdoc }, rules: { ";
        assert!(matched(&format!("{head}'jsdoc/check-alignment': 'error', 'jsdoc/check-indentation': 'off' }} }}];")).is_empty(), "rule never on: no site");
        assert!(matched(&format!("{head}'jsdoc/prefer-import-tag': 'off' }} }}];")).is_empty(), "turned off: no site");
        assert!(!matched(&format!("{head}'jsdoc/prefer-import-tag': ['error', {{}}] }} }}];")).is_empty(), "turned on: sites");
        // A preset may turn it on: judged as usual, not ruled out.
        let comps: BTreeSet<String> = ["pkg:npm/eslint-plugin-jsdoc".to_string()].into();
        let off = |config: &str| {
            let r = repo(&[("eslint.config.ts", config), code]);
            rule_not_enabled(&c.techs["eslint-plugin-jsdoc"].records[0].r, &lint_plugins(&comps, &r))
        };
        assert!(!off("import jsdoc from 'eslint-plugin-jsdoc';\nexport default [jsdoc.configs['flat/recommended']];"));
        assert!(!off("module.exports = { extends: ['plugin:jsdoc/recommended'] };"));
        assert!(off(&format!("{head}'jsdoc/check-alignment': 'error' }} }}];")));
        assert!(!off("export default [];"), "a plugin the config never names (a shared config's) is not judged");
        let shared = repo(&[("eslint.config.ts", "import jsdoc from 'eslint-plugin-jsdoc';\nimport base from './eslint/base.mjs';\nexport default [base];"), ("eslint/base.mjs", "export default { rules: { 'jsdoc/prefer-import-tag': 'warn' } };"), code]);
        assert!(!rule_not_enabled(&c.techs["eslint-plugin-jsdoc"].records[0].r, &lint_plugins(&comps, &shared)), "turned on in a config module the config imports");
    }

    #[test]
    fn lint_namespaces_follow_the_plugin_naming_convention() {
        assert_eq!(lint_namespace("eslint-plugin-jsdoc"), Some(("eslint".into(), "jsdoc".into())));
        assert_eq!(lint_namespace("@typescript-eslint/eslint-plugin"), Some(("eslint".into(), "@typescript-eslint".into())));
        assert_eq!(lint_namespace("@scope/eslint-plugin-x"), Some(("eslint".into(), "@scope/x".into())));
        assert_eq!(lint_namespace("stylelint-plugin-foo"), Some(("stylelint".into(), "foo".into())));
        assert_eq!(lint_namespace("eslint"), None);
        assert_eq!(lint_namespace("@vitejs/plugin-react"), None);
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
    fn a_type_stubs_deprecation_is_in_effect_at_the_installed_stub_version() {
        // mui/material-ui (QA 2026-10-19): central reads `@deprecated` tags from the stub's declarations
        // (type-stubs.ts) into records of the typed technology, released in the stub package. The edge places them by
        // the stub's installed version, not the runtime package's.
        let dep = json!({"change_type":"deprecation","replaces":["FormEvent"],"terms":[["FormEvent",0]],
            "releases":[{"component":"pkg:npm/%40types/react","version":"19.2.10","date":"2026-08-01","line":"19"}]});
        let mut c = catalog("react", 0, vec![with(rec("react:formevent", "pkg:npm/%40types/react", "19.2.10"), dep), rec("react:other", "pkg:npm/react", "19.1.0")]);
        c.techs.get_mut("react").unwrap().index.releases =
            serde_json::from_value(json!([{"version":"19.1.0","date":"2025-06-01","line":"19"},{"version":"19.2.3","date":"2025-12-01","line":"19"}])).unwrap();
        let r = repo(&[("src/a.tsx", "import * as React from 'react';\nexport const f = (e: React.FormEvent<HTMLFormElement>) => e.preventDefault();\n")]);
        let l = Ledger::default();
        let s = stack(&[("react", "19.2.3"), ("@types/react", "19.3.0")], None);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(ids(&out, &out.in_effect), vec!["react:formevent"]);
        let o = out.opps.iter().find(|o| o.id() == "react:formevent").unwrap();
        assert_eq!((o.installed.to_string(), o.matched.clone()), ("19.3.0".to_string(), vec![("FormEvent".to_string(), vec!["src/a.tsx".to_string()])]));
        // Below the stub release that deprecates it: not in effect yet.
        let s = stack(&[("react", "19.2.3"), ("@types/react", "19.2.2")], None);
        let out = run_with(&c, &s, &r, &l);
        assert!(out.in_effect.is_empty(), "{:?}", ids(&out, &out.in_effect));
    }

    #[test]
    fn in_effect_needs_an_installed_package_and_the_records_own_api() {
        let dep = |id: &str, comp: &str, extra: serde_json::Value| with(with(rec(id, comp, "2.0.0"), json!({"change_type":"deprecation"})), extra);
        let c = catalog(
            "pydantic",
            0,
            vec![
                dep("pydantic:json-schema", "pkg:pypi/pydantic", json!({"replaces":["json_schema()"],"terms":[["json_schema()",0],["BaseModel",0]]})),
                dep("pydantic:from-orm", "pkg:pypi/pydantic", json!({"replaces":["from_orm()"],"terms":[["from_orm()",0],["BaseModel",0]]})),
                // A package of the technology that the project does not install.
                dep("pydantic:extra", "pkg:pypi/pydantic-extra", json!({"replaces":["parse_raw_as"]})),
            ],
        );
        let mut s = stack(&[], None);
        s.deps.insert("pkg:pypi/pydantic".into(), crate::stack::Dep { version: parse_version("2.14.1"), source: "test".into(), ..crate::stack::Dep::new("pydantic", true) });
        let r = repo(&[
            ("app/tools.py", "from pydantic import TypeAdapter\nfrom pydantic_extra import parse_raw_as\nschema = TypeAdapter(list[int]).json_schema()\nx = parse_raw_as(int, b)\n"),
            ("app/types.py", "from pydantic import ValidationError\nclass P:\n    @classmethod\n    def from_orm(cls, x):\n        return cls()\n\ny = P.from_orm(z)\n"),
        ]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        assert!(out.in_effect.is_empty(), "{:?}", ids(&out, &out.in_effect));
        // A model the code cannot place (the repository's own, imported relatively) keeps its sites.
        let r = repo(&[("app/tools.py", "import pydantic\nfrom .models import M\nM.json_schema()\nM(a=1).from_orm(row)\n")]);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(ids(&out, &out.in_effect), vec!["pydantic:from-orm", "pydantic:json-schema"]);
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

    fn package(dir: &str, kind: crate::stack::Kind, declared: &[&str]) -> crate::stack::Package {
        crate::stack::Package { dir: dir.into(), kind, lockfile: None, declared: declared.iter().map(|d| crate::util::npm_purl(d)).collect(), own: None }
    }

    #[test]
    fn a_file_name_counts_only_as_the_file_in_a_project_of_the_technology() {
        use crate::stack::Kind::Application;
        let l = Ledger::default();
        let c = catalog("next", 0, vec![with(rec("next:middleware", "pkg:npm/next", "16.0.0"), json!({"change_type":"deprecation","replaces":["middleware.ts"],"introduces":["proxy.ts"]}))]);
        let mut s = stack(&[("next", "16.0.5")], None);
        // A monorepo whose root manifest declares everything; projects are told apart by their own manifest or project.json.
        s.packages = vec![package(".", Application, &["next"]), package("packages/nest", Application, &["@nestjs/core"])];
        let files = [
            ("docs/astro.config.mjs", "export default { middleware: ['./src/plugins/og.middleware.ts'] }"),
            ("packages/nest/src/generators/middleware/middleware.ts", "export function middlewareGenerator() {}"),
            ("tools/gen/project.json", "{}"),
            ("tools/gen/middleware.ts", "export {}"),
            ("apps/site/project.json", "{}"),
            ("apps/site/page.tsx", "import Link from 'next/link';"),
            ("apps/site/middleware.ts", "export function middleware() {}"),
        ];
        let r = repo(&files);
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "next:middleware").unwrap();
        assert_eq!((&o.route, &o.files), (&Route::InEffect, &vec!["apps/site/middleware.ts".to_string()]), "only the file, in a project importing next");
        let r = repo(&files[..4]);
        assert!(run_with(&c, &s, &r, &l).in_effect.is_empty(), "a path string or another framework's file is not next's");
        // A file named for the technology is its file under a root that has it, whatever the nearer project.
        let c2 = catalog("next", 0, vec![with(rec("next:cfg", "pkg:npm/next", "16.0.0"), json!({"change_type":"deprecation","replaces":["next.config.js"]}))]);
        let r = repo(&[("tools/gen/project.json", "{}"), ("tools/gen/next.config.js", "module.exports = {}")]);
        let out = run_with(&c2, &s, &r, &l);
        assert_eq!(ids(&out, &out.in_effect), vec!["next:cfg"]);
        // A single-app repository: the root has the technology, so its file is next's.
        let mut s1 = stack(&[("next", "16.0.5")], None);
        s1.packages = vec![package(".", Application, &["next"])];
        let r = repo(&[("middleware.ts", "export function middleware() {}")]);
        let out = run_with(&c, &s1, &r, &l);
        assert_eq!(ids(&out, &out.in_effect), vec!["next:middleware"]);
    }

    #[test]
    fn a_bounded_release_is_not_placed_inside_its_bound() {
        // Read from a moving upgrade guide: shipped somewhere from 5.0.0 to 5.104.5. At 5.90.6 the deprecation is not
        // known to be in effect (its replacement may not exist yet); at 5.104.5 it is.
        let l = Ledger::default();
        let rel = json!([{"component":"pkg:npm/q","version":"5.0.0","date":"2026-10-19","line":"5","no_later_than":"5.104.5"}]);
        let c = catalog("q", 0, vec![with(rec("q:query", "pkg:npm/q", "5.0.0"), json!({"change_type":"deprecation","replaces":["fetchQuery"],"releases":rel}))]);
        let r = repo(&[("src/a.ts", "import { QueryClient } from 'q';\nnew QueryClient().fetchQuery({});")]);
        let at = |v: &str| {
            let mut s = stack(&[("q", v)], None);
            s.packages = vec![package(".", crate::stack::Kind::Application, &["q"])];
            s
        };
        let s = at("5.90.6");
        let out = run_with(&c, &s, &r, &l);
        assert!(out.in_effect.is_empty());
        assert_eq!(out.opps.iter().find(|o| o.id() == "q:query").unwrap().route, Route::ReleaseUnknown);
        let s = at("5.104.5");
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(ids(&out, &out.in_effect), vec!["q:query"], "at or above the bound it is in effect");
    }

    #[test]
    fn in_effect_in_a_published_package_names_a_range_floor_below_the_replacement() {
        use crate::stack::{Kind, Range, Reading};
        let l = Ledger::default();
        let c = catalog(
            "terser-webpack-plugin",
            0,
            vec![with(rec("twp:minimizeroptions", "pkg:npm/terser-webpack-plugin", "5.6.0"), json!({"change_type":"deprecation","replaces":["terserOptions"],"introduces":["minimizerOptions"]}))],
        );
        let r = repo(&[
            ("packages/webpack/src/config.ts", "import TerserPlugin from 'terser-webpack-plugin';\nnew TerserPlugin({ terserOptions: {} });"),
            ("apps/web/webpack.config.ts", "import TerserPlugin from 'terser-webpack-plugin';\nnew TerserPlugin({ terserOptions: {} });"),
        ]);
        let reading = |dir: &str, range: Option<&str>| Reading { dir: dir.into(), version: parse_version("5.6.1").unwrap(), source: "lock".into(), standalone: false, range: range.map(|x| Range::Npm(x.into())), lock: None };
        let at = |lib_range: &str| {
            let mut s = stack(&[("terser-webpack-plugin", "5.6.1")], None);
            s.packages = vec![
                package(".", Kind::Application, &[]),
                package("packages/webpack", Kind::Library, &["terser-webpack-plugin"]),
                package("apps/web", Kind::Application, &["terser-webpack-plugin"]),
            ];
            s.deps.get_mut(&crate::util::npm_purl("terser-webpack-plugin")).unwrap().readings =
                vec![reading("packages/webpack", Some(lib_range)), reading("apps/web", None)];
            s
        };
        let s = at("^5.3.3");
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "twp:minimizeroptions").unwrap();
        assert_eq!(o.route, Route::InEffect);
        let m = o.unmet.as_deref().unwrap_or_default();
        assert!(m.contains("packages/webpack declares terser-webpack-plugin ^5.3.3") && m.contains("raise the declared range to >=5.6.0"), "{m}");
        assert!(!m.contains("apps/web"), "an application's users get its locked version: {m}");
        let s = at("^5.6.0");
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(out.opps.iter().find(|o| o.id() == "twp:minimizeroptions").unwrap().unmet, None, "the range's floor has the replacement");
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
    fn improvements_cite_a_site_first_and_unmatched_technologies_take_turns() {
        // hls.js attempt 47: one package's unmatched options filled batch 1.
        let sec = |id: &str, term: &str| with(rec(id, &format!("pkg:npm/{}", id.split(':').next().unwrap()), "16.0.0"), json!({"benefit":["security"],"terms":[[term,0]]}));
        let mut c = catalog("n", 0, vec![with(rec("n:hit", "pkg:npm/n", "16.0.0"), json!({"terms":[["useThing",0]]})), sec("n:x1", "absentOne"), sec("n:x2", "absentTwo")]);
        c.techs.extend(catalog("w", 0, vec![sec("w:a", "absentThree"), sec("w:b", "absentFour")]).techs);
        let s = stack(&[("n", "16.0.1"), ("w", "16.0.1")], None);
        let (r, l) = (repo(&[("a.ts", "import 'n'; import 'w'; useThing();")]), Ledger::default());
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(ids(&out, &out.improvements), vec!["n:hit", "n:x1", "w:a", "n:x2", "w:b"]);
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
    fn a_version_past_the_release_index_is_never_the_default_target() {
        // NousResearch/hermes-agent: electron-updater records at electron-builder's 27.0.0 ("What's new in v27") were
        // offered as "electron-updater 6.8.10 → 27.0.0"; electron-updater's newest release is 6.8.11.
        let mut c = catalog(
            "electron-updater",
            0,
            vec![rec("electron-updater:fix", "pkg:npm/electron-updater", "6.8.11"), rec("electron-updater:sibling", "pkg:npm/electron-updater", "27.0.0")],
        );
        let idx = |v: &str, d: &str| unstale_schema::catalog::IndexRelease { version: v.into(), date: d.into(), line: "6".into(), line_start: false };
        c.techs.get_mut("electron-updater").unwrap().index.releases = vec![idx("6.8.10", "2026-09-01"), idx("6.8.11", "2026-10-01")];
        let (r, l) = (repo(&[]), Ledger::default());
        let s = stack(&[("electron-updater", "6.8.10")], None);
        let out = run_with(&c, &s, &r, &l);
        assert!(out.opps.iter().all(|o| o.target == Version::new(6, 8, 11)), "target: the newest published release");
        assert!(!out.upgrade.iter().chain(&out.improvements).any(|&i| out.opps[i].id() == "electron-updater:sibling"));
        // Without an index (older catalogs) the newest record release stays the target.
        c.techs.get_mut("electron-updater").unwrap().index.releases = vec![];
        let out = run_with(&c, &s, &r, &l);
        assert!(out.opps.iter().any(|o| o.target == Version::new(27, 0, 0)));
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

    #[test]
    fn a_package_installed_only_through_an_npm_alias_is_a_parallel_copy() {
        // ComposioHQ/composio: the root runs typescript 7.0.2 and keeps `typescript6: npm:@typescript/typescript6@^6`
        // beside it; core and cli install the alias as `typescript`. The records name both packages.
        let both = |id: &str, v: &str| {
            with(
                rec(id, "pkg:npm/typescript", v),
                json!({"change_type":"fix","releases":[
                    {"component":"pkg:npm/@typescript/typescript6","version":v,"date":"2026-01-01","line":v.split('.').next().unwrap()},
                    {"component":"pkg:npm/typescript","version":v,"date":"2026-01-01","line":v.split('.').next().unwrap()}]}),
            )
        };
        let c = catalog("typescript", 0, vec![both("typescript:six", "6.0.1"), both("typescript:seven", "7.0.2")]);
        let mut s = stack(&[], None);
        let mut ts = crate::stack::Dep::new("typescript", true);
        ts.unaliased = true;
        ts.read(".", parse_version("7.0.2"), "pnpm-lock.yaml".into());
        let mut six = crate::stack::Dep::new("@typescript/typescript6", true);
        six.aliases = ["typescript".to_string(), "typescript6".to_string()].into();
        six.read(".", parse_version("6.0.2"), "pnpm-lock.yaml".into());
        six.read("ts/packages/core", parse_version("6.0.2"), "pnpm-lock.yaml".into());
        s.deps.insert(crate::util::npm_purl("typescript"), ts);
        s.deps.insert(crate::util::npm_purl("@typescript/typescript6"), six);
        s.settle();
        let (r, l) = (repo(&[]), Ledger::default());
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(out.packages["typescript"], vec!["typescript".to_string()]);
        assert!(out.digest.get("typescript").is_none_or(|d| d.is_empty()), "the root already runs 7.0.2");
        assert!(out.opps.iter().all(|o| o.installed.to_string() == "7.0.2"));
        assert!(out.workspaces.get("typescript").is_none_or(|w| w.is_empty()), "the alias is no outdated workspace");
        assert!(out.version_notes.iter().any(|n| n.starts_with("@typescript/typescript6: installed through the npm aliases `typescript`, `typescript6`")), "{:?}", out.version_notes);
        // `unstale bump` counts one technology's records, not the catalog's.
        assert_eq!(why_for(&out, &["sinon".into()], &["bump digest"]), "no records for sinon in the catalog");
        assert!(why_for(&out, &["typescript".into()], &["bump digest"]).starts_with("2 already in the installed version"), "{}", why_for(&out, &["typescript".into()], &[]));
        // Only the alias installs the technology: it is what runs.
        s.deps.remove(&crate::util::npm_purl("typescript"));
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "typescript:seven"), &Route::BumpDigest);
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
    fn a_tool_run_from_its_config_files_keeps_the_headline_where_they_are() {
        // mikro-orm: the root compiles everything with typescript 7.0.2 through its tsconfigs; docs pins 6.0.3 and holds
        // the only `require('typescript')`. The reviews stay on 7.0.2 and the docs code is the one left out.
        let c = catalog(
            "typescript",
            0,
            vec![with(
                rec("typescript:baseurl", "pkg:npm/typescript", "7.0.2"),
                json!({"change_type":"removal","breaking":true,"terms":[["baseUrl",0],["tsconfig.json",0]]}),
            )],
        );
        let mut s = stack(&[], None);
        let mut d = crate::stack::Dep::new("typescript", true);
        d.read(".", parse_version("7.0.2"), "yarn.lock".into());
        d.read("docs", parse_version("6.0.3"), "docs/yarn.lock".into());
        s.deps.insert(crate::util::npm_purl("typescript"), d);
        s.settle();
        let r = repo(&[
            ("packages/core/tsconfig.json", r#"{"compilerOptions": {"strict": true}}"#),
            ("docs/plugins/types/index.js", "const ts = require('typescript'); module.exports = { baseUrl: ts.version }"),
        ]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(out.headline["pkg:npm/typescript"], (".".to_string(), "yarn.lock".to_string()));
        let o = out.opps.iter().find(|o| o.id() == "typescript:baseurl").unwrap();
        assert_eq!(o.installed.to_string(), "7.0.2");
        assert_eq!(o.files, vec!["packages/core/tsconfig.json".to_string()], "docs runs 6.0.3");
        assert!(!out.version_notes.iter().any(|n| n.contains("the reviews use 6.0.3")), "{:?}", out.version_notes);
        assert!(out.version_notes.iter().any(|n| n.contains("under docs (6.0.3) runs another release line than the reviews' 7.0.2")), "{:?}", out.version_notes);
    }

    #[test]
    fn copies_installed_side_by_side_read_a_record_against_the_newer() {
        // mui: the root installs `typescript: npm:@typescript/typescript6@6.0.2` and `@typescript/native:
        // npm:typescript@7.0.2`; packages-internal declares the 6.x package by its own name. A TS7 record released for
        // both packages is no pending bump: the root already runs 7.0.2.
        let both = |id: &str, v: &str| {
            with(
                rec(id, "pkg:npm/typescript", v),
                json!({"change_type":"removal","breaking":true,"releases":[
                    {"component":"pkg:npm/@typescript/typescript6","version":v,"date":"2026-01-01","line":v.split('.').next().unwrap()},
                    {"component":"pkg:npm/typescript","version":v,"date":"2026-01-01","line":v.split('.').next().unwrap()}]}),
            )
        };
        let c = catalog("typescript", 0, vec![both("typescript:seven", "7.0.2")]);
        let mut s = stack(&[], None);
        let mut ts = crate::stack::Dep::new("typescript", true);
        ts.aliases = ["@typescript/native".to_string()].into();
        ts.alias_dirs = [".".to_string()].into();
        ts.unaliased = true;
        ts.read(".", parse_version("7.0.2"), "pnpm-lock.yaml".into());
        let mut six = crate::stack::Dep::new("@typescript/typescript6", true);
        six.aliases = ["typescript".to_string()].into();
        six.alias_dirs = [".".to_string()].into();
        six.unaliased = true;
        six.read(".", parse_version("6.0.2"), "pnpm-lock.yaml".into());
        six.read("packages-internal/scripts", parse_version("6.0.2"), "pnpm-lock.yaml".into());
        s.deps.insert(crate::util::npm_purl("typescript"), ts);
        s.deps.insert(crate::util::npm_purl("@typescript/typescript6"), six);
        s.settle();
        let (r, l) = (repo(&[]), Ledger::default());
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "typescript:seven").unwrap();
        assert_eq!(o.installed.to_string(), "7.0.2");
        assert!(out.upgrade.is_empty(), "no TS7 obligation for a repository on 7.0.2");
        assert!(
            out.version_notes.iter().any(|n| n.starts_with("typescript: 7.0.2 (pnpm-lock.yaml) is installed beside @typescript/typescript6 6.0.2 (pnpm-lock.yaml) in the root")),
            "{:?}",
            out.version_notes
        );
    }

    #[test]
    fn independent_projects_take_the_version_of_the_one_whose_code_uses_it_most() {
        // AutoGPT: the legacy classic/ project (its own lockfile, depth 1) runs an older line than the active
        // platform/backend (its own lockfile, depth 2), and both import the package. Depth says nothing between
        // independent projects; the one with more importing files sets the version, and the other's files are not
        // cited.
        let c = zod_removal();
        let mut s = stack(&[], None);
        let mut d = crate::stack::Dep::new("zod", true);
        d.read_under("classic", parse_version("3.25.76"), "classic/package-lock.json".into(), false, None, Some("classic/package-lock.json".into()));
        d.read_under("platform/backend", parse_version("4.1.12"), "platform/backend/package-lock.json".into(), false, None, Some("platform/backend/package-lock.json".into()));
        let indep = d.clone();
        s.deps.insert(crate::util::npm_purl("zod"), d);
        s.settle();
        let r = repo(&[
            ("classic/src/a.ts", "import { z } from 'zod'; export const A = z.properties({})"),
            ("platform/backend/src/b.ts", "import { z } from 'zod'; export const B = z.properties({})"),
            ("platform/backend/src/c.ts", "import { z } from 'zod'; export const C = z.properties({})"),
        ]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "zod:properties").unwrap();
        assert_eq!(o.installed.to_string(), "4.1.12");
        assert_eq!(o.files, vec!["platform/backend/src/b.ts".to_string(), "platform/backend/src/c.ts".to_string()], "classic runs 3.x");
        assert_eq!(out.headline["pkg:npm/zod"].0, "platform/backend");
        assert!(out.version_notes.iter().any(|n| n.starts_with("zod: the reviews use 4.1.12 in platform/backend") && n.contains("imports it most (2 files); 3.25.76 in classic")), "{:?}", out.version_notes);

        // One workspace (a single lockfile): the headline rule stands, whichever workspace imports it more.
        let mut s = stack(&[], None);
        let mut d = crate::stack::Dep::new("zod", true);
        d.read_under("classic", parse_version("4.1.12"), "pnpm-lock.yaml".into(), false, None, Some("pnpm-lock.yaml".into()));
        d.read_under("platform/backend", parse_version("4.6.0"), "pnpm-lock.yaml".into(), false, None, Some("pnpm-lock.yaml".into()));
        s.deps.insert(crate::util::npm_purl("zod"), d);
        s.settle();
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(out.opps.iter().find(|o| o.id() == "zod:properties").unwrap().installed.to_string(), "4.1.12");

        // The root declares it: the root's version stands.
        let mut s = stack(&[], None);
        let mut d2 = indep;
        d2.read_under(".", parse_version("3.25.76"), "package-lock.json".into(), false, None, Some("package-lock.json".into()));
        s.deps.insert(crate::util::npm_purl("zod"), d2);
        s.settle();
        let r = repo(&[("src/a.ts", "import { z } from 'zod'; export const A = z.properties({})"), ("platform/backend/src/b.ts", "import { z } from 'zod'; export const B = z.properties({})"), ("platform/backend/src/c.ts", "import { z } from 'zod'; export const C = z.properties({})")]);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(out.opps.iter().find(|o| o.id() == "zod:properties").unwrap().installed.to_string(), "3.25.76");
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
    fn an_unlocked_standalone_manifest_never_moves_the_version() {
        // i18next: the root locks 6.x and runs it through scripts and config only (no file imports it); an example
        // outside the workspace, with no lockfile, declares and imports an older release. The root's version heads.
        let c = zod_removal();
        let mut s = stack(&[], None);
        let mut d = crate::stack::Dep::new("zod", true);
        d.read(".", parse_version("4.1.12"), "package-lock.json".into());
        d.read_in("examples/ts", parse_version("3.25.76"), "floor of 3.25.76".into(), true, Some(crate::stack::Range::Npm("^3.25.76".into())));
        s.deps.insert(crate::util::npm_purl("zod"), d);
        s.settle();
        let r = repo(&[
            ("package.json", "{\"devDependencies\": {\"zod\": \"^4.1.12\"}}"),
            ("examples/ts/package.json", "{\"dependencies\": {\"zod\": \"^3.25.76\"}}"),
            ("examples/ts/index.ts", "import { z } from 'zod'; export const A = z.properties({})"),
        ]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        assert!(out.version_notes.iter().all(|n| !n.starts_with("zod: the reviews use")), "{:?}", out.version_notes);
        assert_eq!(out.headline["pkg:npm/zod"], (".".to_string(), "package-lock.json".to_string()));
    }

    #[test]
    fn a_release_shared_by_packages_on_separate_lines_is_read_against_its_own_line() {
        // opentelemetry-js: central gives an SDK 2.10.0 release to every package; semantic-conventions is on 1.x and
        // the SDK on 2.12.0, so the change is already installed and semantic-conventions is not bumped to 2.11.0.
        let rels = |v: &str| json!({"releases": [
            {"component": crate::util::npm_purl("@o/semconv"), "version": v, "date": "2026-04-01", "line": "2"},
            {"component": crate::util::npm_purl("@o/sdk"), "version": v, "date": "2026-04-01", "line": "2"}]});
        let ob = |id: &str, v: &str| with(with(rec(id, "pkg:npm/%40o/semconv", v), json!({"change_type": "behavior_change", "breaking": true, "benefit": ["correctness"]})), rels(v));
        let mut c = catalog("otel", 0, vec![ob("otel:flush", "2.10.0"), ob("otel:newest", "2.11.0")]);
        c.techs.get_mut("otel").unwrap().index.components = vec![crate::util::npm_purl("@o/semconv"), crate::util::npm_purl("@o/sdk")];
        let s = stack(&[("@o/semconv", "1.43.0"), ("@o/sdk", "2.12.0")], None);
        let (r, l) = (repo(&[]), Ledger::default());
        let out = run_with(&c, &s, &r, &l);
        for o in out.opps.iter() {
            assert_ne!(o.route, Route::UpgradeReview, "{}", o.id());
            assert_eq!(o.component(), crate::util::npm_purl("@o/sdk"), "{}", o.id());
        }
        let line = |c: &str, v: &str| Release { component: crate::util::npm_purl(c), version: v.into(), date: String::new(), line: String::new(), no_later_than: None };
        let (a, b) = (line("@o/semconv", "2.10.0"), line("@o/sdk", "2.10.0"));
        let installed = |c: &str| if c.contains("semconv") { parse_version("1.43.0") } else { parse_version("2.9.0") };
        let mut cands = vec![&a, &b];
        own_line(&mut cands, installed);
        assert_eq!(cands.len(), 1, "the release is the SDK's");
        let mut cands = vec![&a, &b];
        own_line(&mut cands, |_| parse_version("1.0.0"));
        assert_eq!(cands.len(), 2, "a genuine upgrade of both is left as it is");
    }

    #[test]
    fn a_record_about_the_releasing_package_is_not_value_for_a_sibling() {
        // i18next: `@babel/register` is covered through `@babel/cli`'s index; records released under `@babel/cli` about
        // its command line, or naming it, are not what bumping `@babel/register` picks up. A stream-wide change is.
        let fix = |id: &str, surface: &str, summary: &str| {
            with(rec(id, "pkg:npm/zod-cli", "4.6.3"), json!({"change_type": "fix", "benefit": ["correctness"], "surface": surface, "subject": "s", "summary": summary}))
        };
        let mut c = catalog(
            "zod",
            0,
            vec![
                fix("zod:cli-flag", "command_line", "A flag now parses."),
                fix("zod:cli-named", "runtime_internal", "The zod-cli watcher no longer leaks."),
                fix("zod:shared", "runtime_internal", "Parsing is faster."),
            ],
        );
        c.techs.get_mut("zod").unwrap().index.components = vec![crate::util::npm_purl("zod-cli"), crate::util::npm_purl("zod")];
        let mut s = stack(&[], None);
        let mut d = crate::stack::Dep::new("zod", true);
        d.read(".", parse_version("3.0.0"), "package-lock.json".into());
        s.deps.insert(crate::util::npm_purl("zod"), d);
        s.settle();
        let (r, l) = (repo(&[]), Ledger::default());
        let out = run_with(&c, &s, &r, &l);
        let route = |id: &str| out.opps.iter().find(|o| o.id() == id).map(|o| o.route.clone());
        assert_eq!(route("zod:cli-flag"), Some(Route::OtherPackage));
        assert_eq!(route("zod:cli-named"), Some(Route::OtherPackage));
        assert_ne!(route("zod:shared"), Some(Route::OtherPackage), "a stream-wide change still counts");
    }

    #[test]
    fn a_removed_signature_is_not_cited_at_calls_of_another_arity() {
        // cypress 16 removes `cy.stub(object, name, fn)`; wavesurfer.js only calls `cy.stub()` with no arguments.
        let c = catalog(
            "cypress",
            0,
            vec![
                with(
                    rec("cypress:cy.stub", "pkg:npm/cypress", "16.0.0"),
                    json!({"change_type":"removal","breaking":true,"replaces":["cy.stub(object, name, fn)"],
                           "terms":[["cy.stub(object, name, fn)",0],["cy.stub(",0],[".callsFake(",0]]}),
                ),
                // A deprecation written the same way takes the exact-literal path.
                with(
                    rec("cypress:cy.spy", "pkg:npm/cypress", "12.0.0"),
                    json!({"change_type":"deprecation","replaces":["cy.spy(object, name, fn)"],"terms":[["cy.spy(object, name, fn)",0]]}),
                ),
            ],
        );
        let s = stack(&[("cypress", "13.17.0")], None);
        let l = Ledger::default();
        let files = |out: &Outcome, id: &str| out.opps.iter().find(|o| o.id() == id).unwrap().files.clone();
        let r = repo(&[("cypress/e2e/webaudio.cy.js", "describe('a', () => {\n  const ctx = { connect: cy.stub(), gain: cy.stub().returns(g), s: cy.spy(win, 'x') };\n});\n")]);
        let out = run_with(&c, &s, &r, &l);
        assert!(files(&out, "cypress:cy.stub").is_empty());
        assert!(files(&out, "cypress:cy.spy").is_empty());
        assert!(out.in_effect.is_empty());
        let r = repo(&[
            ("cypress/e2e/a.cy.js", "cy.stub()\n"),
            ("cypress/e2e/b.cy.js", "cy.stub(win, 'open', () => null)\ncy.spy(win, 'x', f)\n"),
        ]);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(files(&out, "cypress:cy.stub"), vec!["cypress/e2e/b.cy.js".to_string()]);
        assert_eq!(files(&out, "cypress:cy.spy"), vec!["cypress/e2e/b.cy.js".to_string()]);
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
    fn a_dropped_runtime_version_the_declared_range_excludes_is_already_handled() {
        let c = catalog(
            "lib",
            0,
            vec![
                with(rec("lib:py38", "pkg:npm/lib", "2.0.0"), json!({"change_type":"removal","breaking":true,"subject":"Python","prerequisites":[{"ecosystem":"pypi","name":"python","min":"3.9"}]})),
                with(rec("lib:py39", "pkg:npm/lib", "2.0.0"), json!({"change_type":"removal","breaking":true,"subject":"Python 3.9"})),
                with(rec("lib:py311", "pkg:npm/lib", "2.0.0"), json!({"change_type":"removal","breaking":true,"subject":"Python runtime requirement","prerequisites":[{"ecosystem":"pypi","name":"python","min":"3.13"}]})),
                with(rec("lib:node18", "pkg:npm/lib", "2.0.0"), json!({"change_type":"removal","breaking":true,"subject":"Node.js 18"})),
                // mem0: the new minimum as the subject, and a versionless subject whose summary names the dropped one.
                with(rec("lib:py310plus", "pkg:npm/lib", "2.0.0"), json!({"change_type":"removal","breaking":true,"subject":"Python 3.10+","summary":"Python 3.10 or newer is required; Python 3.9 is no longer supported."})),
                with(rec("lib:py-support", "pkg:npm/lib", "2.0.0"), json!({"change_type":"removal","breaking":true,"subject":"Python support","summary":"Support for Python 3.9 was removed."})),
                with(rec("lib:py313plus", "pkg:npm/lib", "2.0.0"), json!({"change_type":"removal","breaking":true,"subject":"Python support","summary":"Python 3.13 or newer is required."})),
                with(rec("lib:py312-drop", "pkg:npm/lib", "2.0.0"), json!({"change_type":"removal","breaking":true,"subject":"Python support","summary":"Drops support for Python 3.12."})),
                with(rec("lib:node-min", "pkg:npm/lib", "2.0.0"), json!({"change_type":"removal","breaking":true,"subject":"Node.js support","prerequisites":[{"ecosystem":"npm","name":"node","min":"18.0.0"}]})),
            ],
        );
        let mut s = stack(&[("lib", "1.0.0")], Some("18.0.0"));
        s.python = Some((Version::new(3, 12, 0), "requires-python >=3.12 in pyproject.toml".into()));
        let (r, l) = (repo(&[]), Ledger::default());
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "lib:py38"), &Route::Applied);
        assert_eq!(route_of(&out, "lib:py39"), &Route::Applied);
        assert_ne!(route_of(&out, "lib:py311"), &Route::Applied, "3.12 does not meet a 3.13 floor");
        assert_ne!(route_of(&out, "lib:node18"), &Route::Applied, "a range that admits 18 still runs it");
        assert_eq!(route_of(&out, "lib:node-min"), &Route::Applied, "`node` is the `Node.js` runtime");
        assert_eq!(route_of(&out, "lib:py310plus"), &Route::Applied, "a 3.10 minimum is met at >=3.12");
        assert_eq!(route_of(&out, "lib:py-support"), &Route::Applied, "the summary names the dropped version");
        assert_ne!(route_of(&out, "lib:py313plus"), &Route::Applied, "3.12 does not meet a stated 3.13 minimum");
        assert_ne!(route_of(&out, "lib:py312-drop"), &Route::Applied, ">=3.12 still admits the dropped 3.12");
        // At exactly the stated minimum: met, where reading `3.10` as a dropped version (ends at 3.11) was not.
        s.python = Some((Version::new(3, 10, 0), "requires-python >=3.10 in pyproject.toml".into()));
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "lib:py310plus"), &Route::Applied, "a 3.10 minimum is met at >=3.10");
        assert_eq!(route_of(&out, "lib:py-support"), &Route::Applied, "3.9 is dropped, >=3.10 excludes it");
        s.python = None;
        let out = run_with(&c, &s, &r, &l);
        assert_ne!(route_of(&out, "lib:py39"), &Route::Applied, "no declared range: nothing is known");
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
        out.unread = Some("this repository declares its dependencies in manifests this client does not read (Python (setuptools): setup.py)".into());
        let w = why(&out, &["bump digest"]);
        assert!(w.starts_with("nothing was checked: ") && w.contains("setup.py") && !w.contains("sync"), "{w}");
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
    fn a_stubs_member_never_names_the_release_beside_its_runtime_package() {
        // ultralytics: `types-requests` in the requests technology took requests' records and their advisory.
        let rels = json!({"releases":[
            {"component":"pkg:npm/%40types/axios","version":"1.2.0","date":"2026-01-01","line":"1"},
            {"component":"pkg:npm/axios","version":"1.2.0","date":"2026-01-01","line":"1"}]});
        let c = catalog("axios", 0, vec![with(rec("axios:fix", "pkg:npm/axios", "1.2.0"), rels)]);
        let (r, l) = (repo(&[]), Ledger::default());
        let s = stack(&[("axios", "1.0.0"), ("@types/axios", "1.0.0")], None);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(out.opps.iter().find(|o| o.id() == "axios:fix").unwrap().component(), "pkg:npm/axios");
        // The stubs alone installed: they still name it (nothing else could).
        let s = stack(&[("@types/axios", "1.0.0")], None);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(out.opps.iter().find(|o| o.id() == "axios:fix").unwrap().component(), "pkg:npm/%40types/axios");
        assert!(crate::util::stub_package("pkg:pypi/types-requests") && crate::util::stub_package("pkg:pypi/boto3-stubs") && !crate::util::stub_package("pkg:pypi/requests"));
    }

    #[test]
    fn a_stubs_version_never_stands_for_its_runtime_package() {
        // A NestJS starter: `@types/express` 5.0.6 is direct, express 5.2.1 comes with @nestjs/platform-express.
        let rels = json!({"releases":[{"component":"pkg:npm/express","version":"5.1.0","date":"2026-01-01","line":"5"}]});
        let mut c = catalog("express", 0, vec![with(rec("express:fix", "pkg:npm/express", "5.1.0"), rels)]);
        c.techs.get_mut("express").unwrap().index.components = vec!["pkg:npm/express".into(), "pkg:npm/%40types/express".into()];
        let (r, l) = (repo(&[]), Ledger::default());
        let mut s = stack(&[("@types/express", "5.0.6")], None);
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "express:fix").unwrap();
        assert_eq!(o.route, Route::VersionUnknown, "never the stub's 5.0.6: {}", o.installed);
        s.stub_runtimes.insert("pkg:npm/express".into(), parse_version("5.2.1").unwrap());
        let out = run_with(&c, &s, &r, &l);
        let o = out.opps.iter().find(|o| o.id() == "express:fix").unwrap();
        assert_eq!(o.installed.to_string(), "5.2.1");
        assert!(!out.digest.values().flatten().any(|&i| out.opps[i].id() == "express:fix"), "5.1.0 is already installed");
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
    fn a_security_benefit_the_installed_version_already_has_needs_no_adoption() {
        // bytedance/deer-flow: next 16.3.8 was offered `images.maximumDiskCacheSize` as a security improvement for
        // GHSA-3X4C-7XQ6-9PQ8, which 16.1.7 fixed by default (the LRU disk cache bounds itself with no config).
        let index = json!(["16.0.0", "16.1.6", "16.1.7", "16.2.0", "16.3.8"]);
        let adv = |id: &str, versions: serde_json::Value| json!({"id": id, "aliases": [], "severity": "medium", "summary": "s", "url": "u", "index": index,
            "affected": [{"component": "pkg:npm/next", "range": "< 16.1.7", "patched": "16.1.7", "versions": versions}]});
        let opt = |id: &str, benefit: serde_json::Value, advisories: serde_json::Value| with(rec(id, "pkg:npm/next", "16.1.7"), json!({"change_type": "new_option", "benefit": benefit, "advisories": advisories}));
        let rel = |v: &str| json!({"component": "pkg:npm/next", "version": v, "date": "2026-01-01", "line": "16"});
        let c = catalog(
            "next",
            0,
            vec![
                // An option released beside the fix (here a release later): tuning, so its security benefit is in force.
                with(opt("next:fixed-by-install", json!(["security"]), json!([adv("GHSA-a", json!(["16.0.0", "16.1.6"]))])), json!({"releases": [rel("16.2.0")]})),
                // Its other benefit stays, and leads the batch by it.
                with(opt("next:also-perf", json!(["security", "performance"]), json!([adv("GHSA-b", json!(["16.0.0", "16.1.6"]))])), json!({"releases": [rel("16.2.0")]})),
                // The option is the fix itself (added in the patched release, js-yaml 4.3.0's `maxTotalMergeKeys`, default
                // 10000): its default is what installing that release does, so nothing is left to adopt, whatever else
                // it is labelled with.
                opt("next:the-fix", json!(["security", "correctness"]), json!([adv("GHSA-e", json!(["16.0.0", "16.1.6"]))])),
                // The installed version is still affected: adopting the option is the mitigation.
                opt("next:still-affected", json!(["security"]), json!([adv("GHSA-c", json!(["16.0.0", "16.1.6", "16.3.8"]))])),
                // No advisory, or one the index cannot decide: the benefit stands (fail open).
                opt("next:no-advisory", json!(["security"]), json!([])),
                opt("next:undecided", json!(["security"]), json!([{"id": "GHSA-d", "aliases": [], "summary": "s", "url": "u", "affected": [{"component": "pkg:npm/next", "range": "< 16.1.7"}]}])),
            ],
        );
        let (s, l) = (stack(&[("next", "16.3.8")], None), Ledger::default());
        let r = repo(&[]);
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "next:fixed-by-install"), &Route::NoBenefit);
        assert_eq!(route_of(&out, "next:the-fix"), &Route::AlreadyIncluded);
        let benefits = |id: &str| out.opps.iter().find(|o| o.rec.r.id == id).unwrap().benefits.clone();
        assert_eq!(benefits("next:also-perf"), vec![Benefit::Performance]);
        assert_eq!(benefits("next:still-affected"), vec![Benefit::Security]);
        assert_eq!(ids(&out, &out.improvements), vec!["next:no-advisory", "next:still-affected", "next:undecided", "next:also-perf"]);
    }

    #[test]
    fn the_improvements_pass_leaves_out_an_opt_in_whose_api_a_later_release_at_or_below_the_installed_version_retired() {
        // stenciljs/core: open 9.1.0 was offered 7.0.0's `url` option, which 8.0.0 removed.
        let opt = |id: &str, intro: serde_json::Value| {
            with(rec(id, "pkg:npm/open", "7.0.0"), json!({"change_type":"new_option","benefit":["correctness"],"introduces":intro,"terms":[["from 'open", 0]]}))
        };
        let later = |id: &str, kind: &str, v: &str, replaces: serde_json::Value| {
            with(rec(id, "pkg:npm/open", v), json!({"change_type":kind,"breaking":kind == "removal","benefit":["none"],"replaces":replaces}))
        };
        let c = catalog(
            "open",
            0,
            vec![
                opt("open:url", json!(["url"])),
                opt("open:wait", json!(["wait"])),
                // Only one of its APIs retired: the other is still there to adopt.
                opt("open:both", json!(["app", "newWindow"])),
                later("open:url-removed", "removal", "8.0.0", json!(["url"])),
                later("open:wait-deprecated", "deprecation", "8.1.0", json!(["wait"])),
                later("open:app-removed", "removal", "8.0.0", json!(["app"])),
            ],
        );
        let r = repo(&[("src/open-in-browser.ts", "import open from 'open';\nawait open(url);\n")]);
        let l = Ledger::default();
        let s9 = stack(&[("open", "9.1.0")], None);
        let out = run_with(&c, &s9, &r, &l);
        assert_eq!(route_of(&out, "open:url"), &Route::Retired, "removed at 8.0.0");
        assert_eq!(route_of(&out, "open:wait"), &Route::Retired, "deprecated at 8.1.0");
        assert_eq!(route_of(&out, "open:both"), &Route::ImprovementsPass);
        // Before the removal, the option is still there to adopt.
        let s7 = stack(&[("open", "7.4.2")], None);
        let out = run_with(&c, &s7, &r, &l);
        assert_eq!(route_of(&out, "open:url"), &Route::ImprovementsPass);
        assert_eq!(route_of(&out, "open:wait"), &Route::ImprovementsPass);
    }

    #[test]
    fn the_improvements_pass_leaves_out_a_year_old_opt_in_on_the_installed_line_with_no_site() {
        // MetaMask/metamask-extension: jsdom 16.7.0 was offered 16.0.0's working `Comment` constructor, matched only by
        // `Node` in a test helper, and `DocumentFragment` by `document.createDocumentFragment` in extension code.
        let r16 = |id: &str, v: &str, d: &str, terms: serde_json::Value| with(rec(id, "pkg:npm/jsdom", v), json!({"benefit":["correctness"],"terms":terms,"releases":[{"component":"pkg:npm/jsdom","version":v,"date":d,"line":"16"}]}));
        let mut c = catalog(
            "jsdom",
            0,
            vec![
                r16("jsdom:comment", "16.0.0", "2020-01-13", json!([["Node", 0]])),
                r16("jsdom:fragment", "16.0.0", "2020-01-13", json!([["document.createDocumentFragment", 0], ["Node", 0]])),
                // A specific term in a file that imports jsdom is a site, however old.
                r16("jsdom:sited", "16.0.0", "2020-01-13", json!([["pretendToBeVisual", 0]])),
                // Under a year before the installed version: still new to adopt, site or none.
                r16("jsdom:recent", "16.6.0", "2021-06-01", json!([["Node", 0]])),
            ],
        );
        let idx = |v: &str, d: &str, s: bool| unstale_schema::catalog::IndexRelease { version: v.into(), date: d.into(), line: "16".into(), line_start: s };
        c.techs.get_mut("jsdom").unwrap().index.releases = vec![idx("16.0.0", "2020-01-13", true), idx("16.6.0", "2021-06-01", false), idx("16.7.0", "2021-08-01", false)];
        let r = repo(&[
            ("test/setup-helper.js", "import { JSDOM } from 'jsdom';\nconst dom = new JSDOM('', { pretendToBeVisual: true });\nglobal.Node = dom.window.Node;\n"),
            ("app/inject.ts", "const f = document.createDocumentFragment();\n"),
        ]);
        let (s, l) = (stack(&[("jsdom", "16.7.0")], None), Ledger::default());
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "jsdom:comment"), &Route::NoSite, "a plain word is no site");
        assert_eq!(route_of(&out, "jsdom:fragment"), &Route::NoSite, "a file that does not use jsdom is no site");
        assert_eq!(ids(&out, &out.improvements), vec!["jsdom:sited", "jsdom:recent"]);
        assert!(why(&out, &[]).contains("2 opt-in on the installed line for a year or more with no site"), "{}", why(&out, &[]));
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
                // Type-checker and editor fixes (vue-tsc's destructured-props hints), language-server features.
                t("knip:hints", "tooling", "types_only", "6.16.0"),
                t("knip:lsp", "tooling", "other", "6.16.0"),
                // A new command or flag is still adopted by whoever runs it.
                t("knip:new-command", "tooling", "command_line", "6.16.0"),
                rec("knip:newest", "pkg:npm/knip", "6.40.0"),
            ],
        );
        let (s, r, l) = (stack(&[("knip", "6.35.1")], None), repo(&[]), Ledger::default());
        let out = run_with(&c, &s, &r, &l);
        for id in ["knip:custom-elements", "knip:orval", "knip:rust-builds", "knip:hints", "knip:lsp"] {
            assert_eq!(route_of(&out, id), &Route::AlreadyIncluded, "{id}");
        }
        assert_eq!(route_of(&out, "knip:vite8"), &Route::BumpDigest, "arrives with the bump, nothing to adopt");
        assert_eq!(route_of(&out, "knip:new-command"), &Route::ImprovementsPass);
    }

    #[test]
    fn a_changed_default_is_handled_where_the_option_is_set() {
        // enisdenjo/graphql-ws: Changesets 3 defaults `baseBranch` to main; `.changeset/config.json` sets "master".
        let def = |id: &str, key: &str| {
            with(rec(id, "pkg:npm/@changesets/cli", "3.0.0"), json!({"change_type":"default_change","surface":"configuration","breaking":true,"subject":key,"subject_kind":"literal","terms":[[key,0]]}))
        };
        let c = catalog("changesets", 0, vec![def("cs:base", "baseBranch"), def("cs:other", "privatePackages")]);
        let s = stack(&[("@changesets/cli", "2.27.11")], None);
        let r = repo(&[(".changeset/config.json", "{\n  \"baseBranch\": \"master\"\n}\n"), ("docs/guide.md", "Set privatePackages in config.")]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "cs:base"), &Route::Applied, "set explicitly: the new default does not apply");
        assert_ne!(route_of(&out, "cs:other"), &Route::Applied, "named only in documentation");
    }

    #[test]
    fn a_moved_option_is_applied_by_its_own_key_in_the_technologys_config() {
        // faker-js/faker: Vitest 4.0.11's `experimental.fsModuleCache`, promoted in 5.0 to a top-level `fsModuleCache`
        // that faker's vitest.config.ts already sets.
        let opt = |id: &str, lit: &str| with(rec(id, "pkg:npm/vitest", "4.0.11"), json!({"change_type":"new_option","surface":"configuration","introduces":[lit]}));
        let c = catalog(
            "vitest",
            0,
            vec![
                opt("vitest:cache", "experimental.fsModuleCache"),
                opt("vitest:elsewhere", "experimental.printImportBreakdown"),
                opt("vitest:plain", "experimental.openTelemetry.enabled"),
                rec("vitest:newest", "pkg:npm/vitest", "4.1.0"),
            ],
        );
        let s = stack(&[("vitest", "4.0.12")], None);
        let r = repo(&[
            ("vitest.config.ts", "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { fsModuleCache: true, enabled: true } });"),
            ("src/report.ts", "export const printImportBreakdown = true;"),
        ]);
        let l = Ledger::default();
        let out = run_with(&c, &s, &r, &l);
        assert_eq!(route_of(&out, "vitest:cache"), &Route::Applied);
        assert_eq!(route_of(&out, "vitest:elsewhere"), &Route::ImprovementsPass, "the key outside the technology's config");
        assert_eq!(route_of(&out, "vitest:plain"), &Route::ImprovementsPass, "a plain-word key is not specific");
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
