//! Stack detection. npm here; PyPI in `pypi.rs`, merged into the same `Stack`. npm projects: every `package.json` outside `node_modules`, versions from the lockfile
//! that covers the manifest, else the declared range's floor, and the supported Node range: available, needs upgrade, or blocked.

use anyhow::Result;
use semver::Version;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::privacy::{Registries, Seen};
use crate::util::{npm_purl, npm_satisfies, parse_version, range_floor};

/// Directories never read, on top of `.gitignore`.
pub const SKIP_DIRS: &[&str] =
    &["node_modules", ".git", ".unstale", "dist", "build", "vendor", ".next", ".nuxt", ".output", ".venv", "venv", "coverage", ".turbo"];

/// Every entry under `root` (`.gitignore` respected, `SKIP_DIRS` skipped), in path order. The directories are read on
/// every core and the result sorted: on a large repository the walk is seconds when sequential.
pub fn walker(root: &Path) -> std::vec::IntoIter<Result<ignore::DirEntry, ignore::Error>> {
    let found = std::sync::Mutex::new(vec![]);
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .git_global(false)
        .filter_entry(|e| !(e.file_type().is_some_and(|t| t.is_dir()) && e.depth() > 0 && SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref())))
        .build_parallel()
        .run(|| {
            Box::new(|e| {
                found.lock().unwrap_or_else(|e| e.into_inner()).push(e);
                ignore::WalkState::Continue
            })
        });
    let mut found = found.into_inner().unwrap_or_else(|e| e.into_inner());
    // Component-wise path order is the sequential walk's order (each directory's entries sorted, depth first).
    found.sort_unstable_by(|a, b| match (a, b) {
        (Ok(a), Ok(b)) => a.path().cmp(b.path()),
        (Ok(_), Err(_)) => std::cmp::Ordering::Less,
        (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
        (Err(_), Err(_)) => std::cmp::Ordering::Equal,
    });
    found.into_iter()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Application,
    Library,
}

#[derive(Debug, Clone)]
pub struct Package {
    /// Directory relative to the repository root, `.` for the root.
    pub dir: String,
    pub kind: Kind,
    pub lockfile: Option<String>,
    /// Package URLs this manifest declares directly: a file under this directory is the package's own code for
    /// those technologies (`usage::Repo::role_for`).
    pub declared: BTreeSet<String>,
    /// The manifest's own package URL (its `name`), which other manifests of the repository may declare: a workspace
    /// package reaches the technologies its workspace dependencies declare (`funnel`, record-named files).
    pub own: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Dep {
    pub name: String,
    /// False for workspace/file/link/git dependencies, and for any package the registry configuration or a lockfile
    /// places on a private registry (`privacy`): never named to a third party (registries, OSV, the coverage service).
    pub public_candidate: bool,
    /// The version the funnel compares against: the root manifest's, else the shallowest manifest's that a
    /// lockfile covers, else the shallowest standalone one's (on a tie, the version most of them run, then the lowest);
    /// `Stack::settle`.
    pub version: Option<Version>,
    /// Where the version came from, for the report.
    pub source: String,
    /// Every manifest's version of it, one per directory (that manifest's lowest when it declares it twice): a
    /// workspace on another version is named in the bump digest (`funnel::Workspace`).
    pub readings: Vec<Reading>,
    /// What the lockfiles installed, with content hashes: the public registry must serve the same bytes for this
    /// identity to be submitted (`onboarding::public_package`), so a private package whose name someone published
    /// publicly is not mistaken for the public one. Empty without a lockfile hash.
    pub pins: Vec<Pin>,
    /// Where the lockfiles say it came from (`privacy`): a package from anywhere but the public registry is never named
    /// to a third party.
    pub seen: Seen,
    /// The names an npm alias installs it under (`typescript6: npm:@typescript/typescript6@^6`, also through a
    /// `catalog:<name>` entry that is one), when no manifest declares it under its own name: a parallel copy kept
    /// beside another package (`Dep::parallel_copy`).
    pub aliases: BTreeSet<String>,
    /// Some manifest declares it under its own name.
    pub unaliased: bool,
    /// The manifests (directories) that install it through an npm alias (`@typescript/native: npm:typescript@7.0.2`).
    pub alias_dirs: BTreeSet<String>,
    /// The manifests (directories) that declare it under its own name. There an alias is a side-by-side copy (moment's
    /// `typescript1: npm:typescript@^1.8.10` beside `typescript: ^7.0.2`), never the manifest's version.
    pub own_dirs: BTreeSet<String>,
    /// PyPI: (directory, specifier) of each declaration no lockfile or pinned requirements file pins, which
    /// `pypi::assume_newest` reads at the newest release the specifier admits.
    pub unpinned: Vec<(String, String)>,
    /// PyPI: the directories where only an optional extra declares it (`pip install pkg[docs]`): what it requires
    /// does not bound the default install's versions there (`pypi::assume_newest_in`).
    pub optional_dirs: BTreeSet<String>,
}

/// One manifest's version of a dependency.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    /// The manifest's directory relative to the repository root, `.` for the root.
    pub dir: String,
    pub version: Version,
    pub source: String,
    /// No lockfile covers the manifest (not its own, not a workspace member or importer of one above it): a separate,
    /// unlocked project, named beside the headline but never setting it while a covered manifest declares the package.
    pub standalone: bool,
    /// The declared range the code there is written for, not for one version alone: the range of a floor reading (an
    /// unlocked manifest, a stale lockfile entry), and a library's range for what its users install, locked or not.
    /// `None` for an application's locked version.
    pub range: Option<Range>,
    /// The lockfile covering the manifest (path from the repository root), `None` when none does. Manifests under
    /// different lockfiles are independent projects: each installs its own copy (`Dep::project_head`).
    pub lock: Option<String>,
}

/// A declared range, in its ecosystem's grammar.
#[derive(Debug, Clone, PartialEq)]
pub enum Range {
    Npm(String),
    /// A PEP 440 (or Poetry) specifier.
    Pypi(String),
}

impl Range {
    /// Whether the range admits `v` (false when it cannot be read).
    pub fn admits(&self, v: &Version) -> bool {
        match self {
            Range::Npm(r) => npm_satisfies(v, r) == Some(true),
            Range::Pypi(s) => crate::pypi::spec_satisfies(v, s) == Some(true),
        }
    }
}

impl Dep {
    /// Installed only through npm aliases: a deliberate side-by-side copy (TypeScript 6 kept for its compiler API beside
    /// TypeScript 7), not the version of the technology the repository runs when it also installs a package of that
    /// technology under its own name (`funnel`).
    pub fn parallel_copy(&self) -> bool {
        !self.aliases.is_empty() && !self.unaliased
    }

    pub fn new(name: &str, public_candidate: bool) -> Dep {
        Dep { name: name.to_string(), public_candidate, version: None, source: String::new(), readings: vec![], pins: vec![], seen: Seen::Unknown, aliases: BTreeSet::new(), unaliased: false, alias_dirs: BTreeSet::new(), own_dirs: BTreeSet::new(), unpinned: vec![], optional_dirs: BTreeSet::new() }
    }

    /// One manifest's version (`None` when it cannot be read: a tag, a workspace link). The headline is set by
    /// `Stack::settle` once every manifest is read; until then `source` keeps the first unreadable one's reason.
    #[cfg(test)]
    pub fn read(&mut self, dir: &str, version: Option<Version>, source: String) {
        self.read_in(dir, version, source, false, None)
    }

    /// `read`, for a manifest that may be `standalone` (no lockfile covers it); `range` when `version` is its floor.
    #[cfg(test)]
    pub fn read_in(&mut self, dir: &str, version: Option<Version>, source: String, standalone: bool, range: Option<Range>) {
        self.read_under(dir, version, source, standalone, range, None)
    }

    /// `read_in`, for a manifest the lockfile `lock` covers.
    pub fn read_under(&mut self, dir: &str, version: Option<Version>, source: String, standalone: bool, range: Option<Range>, lock: Option<String>) {
        let Some(version) = version else {
            if self.source.is_empty() {
                self.source = source;
            }
            return;
        };
        let reading = Reading { dir: dir.to_string(), version, source, standalone, range, lock };
        match self.readings.iter_mut().find(|r| r.dir == dir) {
            Some(r) if reading.version < r.version => *r = reading,
            Some(_) => {}
            None => self.readings.push(reading),
        }
    }

    /// The reading the outputs use: the root manifest's, else the shallowest manifest's that a lockfile covers,
    /// else the shallowest standalone one's; on a tie, the version most of those manifests run, then the lowest. The root (or the top of a workspace tree)
    /// is what the application resolves; a nested manifest with its own lockfile (a CI tool) or a library's declared
    /// floor (a peer range) says what that one part runs or supports, and a manifest no lockfile covers (a sample
    /// app outside the workspace globs) is a separate project: each is named beside it instead of setting the
    /// version for the whole repository.
    pub fn headline(&self) -> Option<&Reading> {
        self.headline_among(|_| true)
    }

    /// `headline`, among the readings `keep` accepts (`funnel::run`: those whose code uses the package).
    ///
    /// Among equally shallow manifests, the version most of them run leads, then the lowest (supabase: next 16.3.6 in
    /// seven apps over 15.5.25 in `apps/docs` and `apps/www`): the lowest alone framed every review at the version
    /// two of nine workspaces run.
    pub fn headline_among(&self, keep: impl Fn(&Reading) -> bool) -> Option<&Reading> {
        let kept: Vec<&Reading> = self.readings.iter().filter(|r| keep(r)).collect();
        let tier = |r: &Reading| (r.dir != ".", r.standalone, depth(&r.dir));
        let top = kept.iter().map(|r| tier(r)).min()?;
        let peers: Vec<&Reading> = kept.into_iter().filter(|r| tier(r) == top).collect();
        let held = |v: &Version| peers.iter().filter(|r| r.version == *v).count();
        peers.iter().copied().min_by_key(|r| (std::cmp::Reverse(held(&r.version)), &r.version, &r.dir))
    }

    /// The reading whose manifest a file's import resolves to: the deepest one containing it (Node's lookup; a Python
    /// file runs the environment of the project holding it).
    pub fn owner(&self, path: &str) -> Option<&Reading> {
        self.readings.iter().filter(|r| r.contains(path)).max_by_key(|r| if r.dir == "." { 0 } else { r.dir.len() })
    }

    /// The headline of the independent project whose code imports the package most, when that is not `h`'s: with
    /// `sites` the files importing it, and the number of them in that project and in `h`'s. Manifests under different
    /// lockfiles are independent projects (a manifest no lockfile covers is one of its own), and depth says nothing
    /// between them: AutoGPT's legacy `classic/poetry.lock` (uvicorn 0.40.0, 2 importing files) is shallower than the
    /// active `autogpt_platform/backend/poetry.lock` (0.53.0, 4 files). `None` when that project runs `h`'s version, when `h` is the root's (the root is what
    /// the application resolves), when no file in `h`'s project imports it (the version then follows the code:
    /// `funnel::choose`), or when no other project has more importing files. Standalone manifests never weigh in.
    pub fn project_head(&self, h: &Reading, sites: &[String]) -> Option<(&Reading, usize, usize)> {
        if h.dir == "." || h.standalone {
            return None;
        }
        let project = |r: &Reading| r.lock.clone().unwrap_or_else(|| r.dir.clone());
        let mut weight: BTreeMap<String, usize> = BTreeMap::new();
        for r in sites.iter().filter_map(|p| self.owner(p)).filter(|r| !r.standalone) {
            *weight.entry(project(r)).or_default() += 1;
        }
        let own = weight.get(&project(h)).copied().unwrap_or(0);
        let (top, n) = weight.iter().max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0.cmp(a.0)))?;
        if own == 0 || *n <= own {
            return None;
        }
        self.headline_among(|r| !r.standalone && project(r) == *top).filter(|r| r.version != h.version).map(|r| (r, *n, own))
    }

    /// Readings on another version than the headline, grouped by version (ascending), each with its directories.
    pub fn others(&self) -> Vec<(Version, Vec<&Reading>)> {
        self.headline().map(|h| self.others_than(h)).unwrap_or_default()
    }

    /// Readings on another version than `h`, grouped by version (ascending), each with its directories.
    pub fn others_than(&self, h: &Reading) -> Vec<(Version, Vec<&Reading>)> {
        let mut by: BTreeMap<Version, Vec<&Reading>> = BTreeMap::new();
        for r in self.readings.iter().filter(|r| r.version != h.version) {
            by.entry(r.version.clone()).or_default().push(r);
        }
        by.into_iter().collect()
    }
}

impl Reading {
    /// Whether this manifest's code runs a version on `v`'s release line (major, or 0.minor), or is written for a range
    /// that admits `v` (a library's peer floor `>=18` admits 19): records judged at `v` describe that code.
    pub fn fits(&self, v: &Version) -> bool {
        let line = |v: &Version| if v.major > 0 { (v.major, 0) } else { (0, v.minor) };
        line(&self.version) == line(v) || self.range.as_ref().is_some_and(|r| r.admits(v))
    }

    /// Whether this manifest's code runs `v` itself: its locked version, or a range that admits it.
    pub fn runs(&self, v: &Version) -> bool {
        self.version == *v || self.range.as_ref().is_some_and(|r| r.admits(v))
    }

    /// Whether `path` (relative to the repository root) is inside this manifest's directory.
    pub fn contains(&self, path: &str) -> bool {
        self.dir == "." || path.strip_prefix(self.dir.as_str()).is_some_and(|rest| rest.starts_with('/'))
    }
}

fn depth(dir: &str) -> usize {
    if dir == "." { 0 } else { dir.split('/').count() }
}

/// "the root" or the directory, for the report.
pub fn place(dir: &str) -> String {
    if dir == "." { "the root".into() } else { dir.to_string() }
}

/// One locked version and its content hashes as the lockfile states them: npm `sha512-<base64>` integrity, PyPI
/// `sha256:<hex>` file hashes.
#[derive(Debug, Clone, PartialEq)]
pub struct Pin {
    pub version: String,
    pub hashes: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Stack {
    pub packages: Vec<Package>,
    pub deps: BTreeMap<String, Dep>,
    /// The lowest Node version the project supports, and where that came from: the lowest `engines.node` floor of
    /// the manifests a lockfile covers (standalone ones only when none is covered), else `.nvmrc`/`.node-version`.
    pub node: Option<(Version, String)>,
    /// The same per lockfile (path relative to the repository root): the lowest `engines.node` floor of the manifests
    /// that lockfile covers, else the nearest `.nvmrc`/`.node-version` from its directory up to the repository root.
    /// A lockfile root is its own install: another root's (a published library's) engines never set its floor.
    pub node_by_lock: BTreeMap<String, (Version, String)>,
    /// The lowest Python version the project supports, and where that came from: the lowest `requires-python` (or
    /// Poetry `python`) floor among the read `pyproject.toml` files (`pypi::detect`), else `.python-version`.
    /// With neither declaration, `node` and `python` fall back to the CI workflows' setup inputs (`ci_runtime`).
    pub python: Option<(Version, String)>,
    /// Per runtime (`runtime_name`), the version a toolchain file or CI setup input pins, as written (`20.x`,
    /// `3.12`), when `node`/`python` came from one: the version the code runs on, not a supported range's floor.
    pub runtime_pins: BTreeMap<&'static str, String>,
    /// Where versions came from when that needed a choice: competing lockfiles in one directory, or a lockfile
    /// that disagrees with the manifest beside it; and the packages on different versions across manifests. For the
    /// report.
    pub notes: Vec<String>,
    /// How many of `notes` say a lockfile could not be read in full (`Lock::unread`).
    pub unreadable: usize,
    /// The locked version of each runtime package that only its type stub names directly (`@types/express` with
    /// express from `@nestjs/platform-express`), by purl: that technology's installed version, never the stub's.
    pub stub_runtimes: BTreeMap<String, Version>,
    /// How many packages are on different versions across manifests (the last note when nonzero; `settle`).
    pub spread: usize,
    /// Per lockfile, the npm manifests below it that it does not cover (separate, unlocked projects), as a report
    /// note. Not a lockfile problem, so kept apart from `notes`.
    pub standalone: Vec<String>,
    /// The registry configuration that applies to the repository (`privacy`): which lockfile packages OSV may see.
    pub registries: Registries,
    /// The configuration of its test, example and fixture directories, for what only they install.
    pub fixture_registries: Registries,
    /// The peer ranges of the repository's published packages (`is_library`): what their users must install beside
    /// them. A range that leaves out the current release of its package fails their install (`onboarding`).
    pub peers: Vec<Peer>,
    /// Workspace files that install with no lockfile (pnpm `lockfile: false`), from the repository root: each
    /// install resolves its manifests' ranges afresh, so their versions are read, not installed (`Unlocked`).
    pub unlocked: Vec<String>,
}

/// A published package's peer range on another package.
#[derive(Debug, Clone, PartialEq)]
pub struct Peer {
    /// The manifest's directory, `.` for the root.
    pub dir: String,
    /// The published package's own name.
    pub package: String,
    /// The peer's npm name (an alias's target).
    pub name: String,
    pub range: String,
}

impl Stack {
    /// Sets each dependency's version from its readings (`settle`).
    pub fn settle(&mut self) {
        if let Some((n, note)) = settle(&mut self.deps) {
            self.spread = n;
            self.notes.push(note);
        }
    }

    pub fn purls(&self) -> BTreeSet<String> {
        self.deps.keys().cloned().collect()
    }

    /// Technology ids worth asking the catalog for: each package name, and a scope's name. Only a candidate;
    /// a technology is in the stack when its records name one of these package URLs.
    pub fn candidates(&self) -> BTreeSet<String> {
        self.deps.values().flat_map(dep_candidates).collect()
    }

    /// Candidates that only private dependencies give (`Dep::public_candidate`, and a scoped npm package the public
    /// registry has not confirmed while credentials for it are configured: `privacy::Registries::needs_identity`, read
    /// from `cache` only): a catalog without a list of its technologies is never asked for these by name (`sync`).
    pub fn withheld(&self, cache: &Path) -> BTreeSet<String> {
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let named = |(p, d): &(&String, &Dep)| d.public_candidate && (!self.registries.needs_identity(p) || crate::privacy::known_public(cache, p, at));
        let public: BTreeSet<String> = self.deps.iter().filter(named).flat_map(|(_, d)| dep_candidates(d)).collect();
        self.deps.iter().filter(|e| !named(e)).flat_map(|(_, d)| dep_candidates(d)).filter(|c| !public.contains(c)).collect()
    }

    /// The lowest version of a language runtime the project declares it supports, and where that came from: Node
    /// (`engines.node`, `.nvmrc`) or Python (`requires-python`), by the runtime's name in any ecosystem's spelling.
    pub fn runtime_floor(&self, name: &str) -> Option<&(Version, String)> {
        match runtime_name(name)? {
            "node" => self.node.as_ref(),
            _ => self.python.as_ref(),
        }
    }

    /// Whether the range the project declares for a language runtime (`engines.node 20.x || 22.x`,
    /// `requires-python >=3.10`) admits any version in `[lo, hi)`: a range with a gap (`20.x || 22.x`) excludes a
    /// version above its floor (21). `None` when the declaration is not a range this can read (a toolchain file's
    /// single version, `!=` exclusions): a caller keeps to the floor.
    pub fn runtime_admits(&self, name: &str, lo: &Version, hi: &Version) -> Option<bool> {
        let (_, source) = self.runtime_floor(name)?;
        // The declaration as `runtime_floor`'s source writes it: `<key> <range> in <file>`.
        let decl = source.split_once(" in ")?.0;
        let (npm, range) = [("engines.node ", true), ("requires-python ", false), ("Poetry python ", false)]
            .iter()
            .find_map(|(k, npm)| decl.strip_prefix(k).map(|r| (*npm, r.trim())))?;
        if range.contains("!=") {
            return None;
        }
        let mut any = false;
        for alt in range.split("||").map(str::trim) {
            let (floor, sat) = if npm {
                (range_floor(alt), Box::new(|v: &Version| npm_satisfies(v, alt)) as Box<dyn Fn(&Version) -> Option<bool>>)
            } else {
                (crate::pypi::spec_floor(alt).or(Some(Version::new(0, 0, 0))), Box::new(|v: &Version| crate::pypi::spec_satisfies(v, alt)) as Box<dyn Fn(&Version) -> Option<bool>>)
            };
            let floor = floor?;
            // Each alternative is one interval: one starting below `lo` reaches into `[lo, hi)` only through `lo`.
            any |= if floor < *lo { sat(lo)? } else { floor < *hi };
        }
        Some(any)
    }

    /// A version the project declares for a prerequisite name in the npm ecosystem: `node` from engines or
    /// `.nvmrc`, anything else from the dependency list.
    /// For a version read from `lock` (a lockfile path, `Reading::lock`), `node` is that lockfile root's own floor
    /// (`node_by_lock`); the repository's floor only for a version no lockfile holds.
    pub fn npm_version_in(&self, name: &str, lock: Option<&str>) -> Option<&Version> {
        if name.eq_ignore_ascii_case("node") {
            // A lockfile root with no floor of its own (no engines, no toolchain file) is not answered: fail open.
            return match lock {
                Some(l) => self.node_by_lock.get(l),
                None => self.node.as_ref(),
            }
            .map(|(v, _)| v);
        }
        self.deps.get(&npm_purl(&name.to_lowercase())).and_then(|d| d.version.as_ref())
    }
}

/// A language runtime the stack reads a declared range for, by its name in any ecosystem's spelling (`Node.js`,
/// `nodejs`, `CPython`): `node` or `python`.
pub fn runtime_name(name: &str) -> Option<&'static str> {
    match name.trim().trim_matches('`').to_ascii_lowercase().as_str() {
        "node" | "nodejs" | "node.js" => Some("node"),
        "python" | "cpython" => Some("python"),
        _ => None,
    }
}

/// The catalog technologies a dependency's name may be: the name, or a scoped name's scope and name.
pub fn dep_candidates(d: &Dep) -> Vec<String> {
    match d.name.strip_prefix('@').and_then(|s| s.split_once('/')) {
        Some((scope, name)) => vec![scope.to_lowercase(), name.to_lowercase()],
        None => vec![d.name.to_lowercase()],
    }
}

/// Sets each dependency's version and source from its readings (`Dep::headline`); a note naming the packages whose
/// versions differ across manifests, with their count, when any do.
pub fn settle(deps: &mut BTreeMap<String, Dep>) -> Option<(usize, String)> {
    let mut differ = vec![];
    for d in deps.values_mut() {
        let Some(h) = d.headline().cloned() else { continue };
        d.version = Some(h.version.clone());
        d.source = if d.readings.len() > 1 { format!("{} in {}", h.source, place(&h.dir)) } else { h.source.clone() };
        let others = d.others();
        if let Some((v, rs)) = others.first() {
            let more = others.iter().map(|(_, rs)| rs.len()).sum::<usize>() - 1;
            differ.push(format!(
                "{} {} ({}) and {v} in {} ({}){}",
                d.name,
                h.version,
                d.source,
                rs[0].dir,
                rs[0].source,
                if more > 0 { format!(" and {more} more") } else { String::new() }
            ));
        }
    }
    if differ.is_empty() {
        return None;
    }
    let n = differ.len();
    differ.truncate(5);
    Some((n, format!(
        "{n} package{} on different versions across manifests: {}{}. The reviews use the root's version, else the one most of the shallowest manifests a lockfile covers run, unless no code importing the package runs that release line; the bump digest names the others.",
        if n == 1 { " is" } else { "s are" },
        differ.join("; "),
        if n > 5 { format!("; {} more", n - 5) } else { String::new() }
    )))
}

const DEP_FIELDS: &[&str] = &["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/// A package published for others: not `private`, a `name` and `version`, and a field that says what to publish
/// (`module`, `exports`, `types`, `typings`, `bin`, `files`, `publishConfig`), or `main` alone when the manifest has no
/// lockfile of its own beside it. `main` is what `npm init` writes for every package, so beside the manifest's own
/// lockfile (an install root: a deployed server, a CI script) it says nothing about publishing.
pub(crate) fn is_library(pj: &Value, own_lockfile: bool) -> bool {
    let private = pj.get("private").and_then(Value::as_bool).unwrap_or(false);
    let published = pj.get("name").is_some() && pj.get("version").is_some();
    let entry = ["module", "exports", "types", "typings", "bin", "files", "publishConfig"].iter().any(|k| pj.get(k).is_some())
        || (pj.get("main").is_some() && !own_lockfile);
    !private && published && entry
}

/// Dependency manifests of ecosystems this client does not read yet, by file name (or extension, `.csproj`). The
/// list is per ecosystem, not per technology; a new ecosystem adapter removes its line.
const OTHER_MANIFESTS: &[(&str, &str)] = &[
    // Python (PyPI) is read by `pypi.rs`; its unread manifests are `UNREAD_MANIFESTS`.
    ("go.mod", "Go modules"),
    ("pom.xml", "Java (Maven)"),
    ("build.gradle", "Java/Kotlin (Gradle)"),
    ("build.gradle.kts", "Java/Kotlin (Gradle)"),
    (".csproj", "C# (NuGet)"),
    ("composer.json", "PHP (Composer)"),
    ("Gemfile", "Ruby (RubyGems)"),
    ("Cargo.toml", "Rust (crates.io)"),
    ("mix.exs", "Elixir (Hex)"),
    ("Package.swift", "Swift (SwiftPM)"),
    ("pubspec.yaml", "Dart (pub)"),
];

/// Dependency manifests of a read ecosystem that this client does not read, with the package-URL prefix of that
/// ecosystem. `setup.py` is a program: its requirement lists are whatever it computes when run (variables, environment
/// switches, files it opens), so it is never parsed or executed. `setup.cfg` is not read either. They count as
/// uncovered only where no read manifest of the same directory declares a package of that ecosystem.
const UNREAD_MANIFESTS: &[(&str, &str, &str)] = &[
    ("setup.py", "Python (setuptools)", "pkg:pypi/"),
    ("setup.cfg", "Python (setuptools)", "pkg:pypi/"),
];

/// Manifests of uncovered ecosystems anywhere in the repository (`.gitignore` respected), per ecosystem with their
/// paths, and the unread manifests of read ecosystems where nothing beside them was read (`UNREAD_MANIFESTS`).
/// Manifests in examples, documentation, test fixtures, generated or vendored code are not the project's.
pub fn uncovered_manifests(repo: &crate::usage::Repo, stack: &Stack) -> BTreeMap<&'static str, Vec<String>> {
    use crate::usage::Role;
    let mut out: BTreeMap<&'static str, Vec<String>> = BTreeMap::new();
    for p in &repo.paths {
        let base = p.rsplit('/').next().unwrap_or(p);
        let other = OTHER_MANIFESTS.iter().find(|(m, _)| if m.starts_with('.') { base.ends_with(m) } else { base == *m }).map(|(_, eco)| *eco);
        let unread = || {
            let (_, eco, prefix) = UNREAD_MANIFESTS.iter().find(|(m, _, _)| base == *m)?;
            if base == "setup.py" && !setuptools_script(p, repo.text(p)) {
                return None;
            }
            let dir = p.rsplit_once('/').map_or(".", |(d, _)| d);
            let read = stack.packages.iter().any(|k| k.dir == dir && k.declared.iter().any(|u| u.starts_with(prefix)));
            (!read).then_some(*eco)
        };
        let Some(eco) = other.or_else(unread) else { continue };
        if matches!(repo.role(p), Role::App | Role::Tooling) {
            out.entry(eco).or_default().push(p.clone());
        }
    }
    out
}

/// Whether a `setup.py` (its text, when read) is a setuptools or distutils script: it names one of them or calls
/// `setup(` in code (not in a comment). A module of that name that does neither (a CLI's `setup` command) declares
/// nothing.
fn setuptools_script(path: &str, text: Option<&str>) -> bool {
    text.is_none_or(|t| ["setuptools", "distutils", "setup("].iter().any(|n| crate::usage::in_code(path, t, n, false)))
}

/// Why nothing was checked, when no dependency was read at all: the manifests that declare them are ones this client
/// does not read (`uncovered_manifests`), or no manifest it reads declares any.
pub fn unread_note(repo: &crate::usage::Repo, stack: &Stack) -> Option<String> {
    if !stack.deps.is_empty() {
        return None;
    }
    let m = uncovered_manifests(repo, stack);
    Some(if m.is_empty() {
        "no dependency manifest this client reads (package.json, pyproject.toml, requirements*.txt, Pipfile) declares any packages".into()
    } else {
        let list: Vec<String> = m.iter().map(|(eco, paths)| format!("{eco}: {}", paths[..paths.len().min(3)].join(", "))).collect();
        format!("this repository declares its dependencies in manifests this client does not read ({})", list.join("; "))
    })
}

pub fn detect(root: &Path) -> Result<Stack> {
    detect_in(root, &crate::privacy::Env::current())
}

/// `detect` with the environment the package managers' configuration is read from (tests set their own).
pub fn detect_in(root: &Path, env: &crate::privacy::Env) -> Result<Stack> {
    let mut local_names: BTreeSet<String> = BTreeSet::new();
    // Registry and index configuration files, and the directories of manifests (whose own `.npmrc` may be gitignored).
    let (mut configs, mut manifest_dirs) = (vec![], BTreeSet::new());
    for e in walker(root).flatten() {
        let name = e.file_name().to_string_lossy();
        if crate::privacy::is_config(&name) || crate::pypi::requirements_project(e.path()).is_some() {
            configs.push(e.path().to_path_buf());
        }
        if name == "package.json" || name == "pyproject.toml" || name == "Pipfile" {
            manifest_dirs.extend(e.path().parent().map(Path::to_path_buf));
        }
        if name == "package.json"
            && let Some(n) = std::fs::read(e.path()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v.get("name").and_then(Value::as_str).map(String::from))
        {
            local_names.insert(n);
        }
    }
    let mut packages = vec![];
    let mut deps: BTreeMap<String, Dep> = BTreeMap::new();
    // The lowest engines.node floor among manifests a lockfile covers, and among standalone ones (used only when no
    // manifest is covered: a standalone project's engines never set a locked project's range).
    let mut node: Option<(Version, String)> = None;
    let mut node_standalone: Option<(Version, String)> = None;
    let mut node_by_lock: BTreeMap<String, (Version, String)> = BTreeMap::new();
    // Directories of covered manifests (`.nvmrc` fallback), and per lockfile the standalone manifests below it.
    let mut covered: Vec<String> = vec![];
    let mut outside: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut locks: BTreeMap<PathBuf, Option<Lock>> = BTreeMap::new();
    let mut catalogs: BTreeMap<PathBuf, Catalogs> = BTreeMap::new();
    let mut notes = vec![];
    let mut unreadable = 0;
    let mut stub_runtimes: BTreeMap<String, Version> = BTreeMap::new();
    let mut peers: Vec<Peer> = vec![];
    // Per lockfile path: locked versions outside the declared range, with a few examples.
    let mut stale: BTreeMap<String, (usize, Vec<String>)> = BTreeMap::new();
    let mut unlocked_ws: BTreeMap<PathBuf, Option<Unlocked>> = BTreeMap::new();
    // The unlocked workspaces some manifest belongs to: only these are named.
    let mut unlocked_used: BTreeSet<String> = BTreeSet::new();
    for e in walker(root).flatten() {
        if e.file_name() != "package.json" || !e.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
        let Ok(pj) = serde_json::from_str::<Value>(&text) else { continue };
        let dir = e.path().parent().unwrap_or(root).to_path_buf();
        let rel = rel_dir(root, &dir);
        let mut declared = BTreeSet::new();
        let cat = Catalogs::nearest(root, &dir, &mut catalogs);
        // The nearest lockfile at or above the package that covers it, up to the repository root. One that does not
        // (a sample app outside the workspace globs) leaves the manifest a separate, unlocked project unless a
        // lockfile further up covers it.
        let mut lock: Option<(PathBuf, Lock)> = None;
        let mut passed: Option<String> = None;
        // A `bun.lockb` with no text `bun.lock` beside it, on the way up: what the floors below are for.
        let mut binary: Option<String> = None;
        let mut d = Some(dir.as_path());
        while let Some(cur) = d {
            if !locks.contains_key(cur) {
                let cur_cat = Catalogs::nearest(root, cur, &mut catalogs);
                let read = Lock::read_all(cur);
                for l in &read {
                    if let Some(why) = &l.unread {
                        notes.push(format!("{}: could not be read in full ({why}); versions or registry identities it holds may be missing from this report.", join(&rel_dir(root, cur), &l.file)));
                        unreadable += 1;
                    }
                }
                if cur.join(BINARY_LOCKFILE).is_file() && !read.iter().any(|l| l.file == "bun.lock") {
                    notes.push(format!(
                        "{}: Bun's binary lockfile is not read, so the manifests it installs show their range floors, not the versions it holds. Bun 1.2+ writes the text bun.lock (`bun install --save-text-lockfile`), which is read.",
                        join(&rel_dir(root, cur), BINARY_LOCKFILE)
                    ));
                    unreadable += 1;
                }
                locks.insert(cur.to_path_buf(), choose_lock(root, cur, read, &local_names, &cur_cat, &mut notes));
            }
            if binary.is_none() && cur.join(BINARY_LOCKFILE).is_file() && !cur.join("bun.lock").is_file() {
                binary = Some(join(&rel_dir(root, cur), BINARY_LOCKFILE));
            }
            if let Some(Some(l)) = locks.get(cur) {
                if l.covers(&rel_dir(cur, &dir)) {
                    lock = Some((cur.to_path_buf(), l.clone()));
                    break;
                }
                passed.get_or_insert_with(|| join(&rel_dir(root, cur), &l.file));
            }
            if cur == root {
                break;
            }
            d = cur.parent();
        }
        // No lockfile covers it, but a pnpm workspace that installs with none (`lockfile: false`) does: its ranges
        // resolve afresh on each install, and its overrides still set what they name.
        let unlocked = match &lock {
            Some(_) => None,
            None => {
                let mut found = None;
                let mut d = Some(dir.as_path());
                while let Some(cur) = d {
                    let u = unlocked_ws.entry(cur.to_path_buf()).or_insert_with(|| Unlocked::read(cur));
                    if let Some(u) = u.as_ref().filter(|u| u.covers(&rel_dir(cur, &dir))) {
                        found = Some((join(&rel_dir(root, cur), "pnpm-workspace.yaml"), u.clone()));
                        break;
                    }
                    if cur == root {
                        break;
                    }
                    d = cur.parent();
                }
                if let Some((file, _)) = &found {
                    unlocked_used.insert(file.clone());
                }
                found
            }
        };
        let importer = lock.as_ref().map(|(ld, _)| rel_dir(ld, &dir)).unwrap_or_else(|| ".".into());
        let kind = if is_library(&pj, lock.as_ref().is_some_and(|(ld, _)| *ld == dir)) { Kind::Library } else { Kind::Application };
        let standalone = lock.is_none() && unlocked.is_none();
        // A manifest that declares nothing (a directory's `main` entry) is no project of its own to name.
        let declares = DEP_FIELDS.iter().any(|f| pj.get(*f).and_then(Value::as_object).is_some_and(|m| !m.is_empty()));
        match (&passed, standalone) {
            (_, false) => covered.push(rel.clone()),
            (Some(file), true) if declares => outside.entry(file.clone()).or_default().push(rel.clone()),
            _ => {}
        }
        let dev = pj.get("devDependencies").and_then(Value::as_object);
        for field in DEP_FIELDS {
            let Some(map) = pj.get(*field).and_then(Value::as_object) else { continue };
            for (name, range) in map {
                if kind == Kind::Library
                    && *field == "peerDependencies"
                    && let (Some(r), Some(own)) = (range.as_str(), pj.get("name").and_then(Value::as_str))
                    && !is_local(&local_names, name, r)
                {
                    let r = cat.resolve(name, r).unwrap_or(r);
                    peers.push(Peer { dir: rel.clone(), package: own.to_string(), name: alias_target(r).unwrap_or(name).to_string(), range: r.to_string() });
                }
                // A library's peer range is what it supports; a devDependency on the same package is what the
                // repository itself installs, develops and tests against, so that one is its reading.
                if kind == Kind::Library && *field == "peerDependencies" && dev.is_some_and(|d| d.contains_key(name)) {
                    continue;
                }
                let declared_range = range.as_str().unwrap_or("");
                // A pnpm catalog reference (`catalog:`, `catalog:<name>`) stands for the range the catalog gives.
                let resolved = cat.resolve(name, declared_range);
                let range = resolved.unwrap_or(declared_range);
                let shown = match resolved {
                    Some(r) => format!("{r} from {declared_range}"),
                    None => range.to_string(),
                };
                // A package of this repository (a workspace, a path): never public, and its locked version is a
                // placeholder (Yarn 2+ `0.0.0-use.local`), not a pin the range could say is out of date.
                // A manifest of the same name in this repository (a stub or fixture named `electron`) does not make
                // a dependency local when its lockfile fetched it from a registry: that one is the public package.
                let local = is_local(&local_names, name, range) && (local_protocol(range) || !lock.as_ref().is_some_and(|(_, l)| l.fetched(name)));
                // What a library's users install (its dependencies and peers) may resolve anywhere in the declared
                // range, the peer range when it declares one: the reading keeps that range, so code written for
                // the range is cited for any version in it. Its version is still what this repository's own code
                // runs and tests against, the covering lockfile's, and the floor only when nothing locks it. Its
                // devDependencies reach no user: they are the repository's own tooling, read like an application's.
                let lib_range = (kind == Kind::Library && *field != "devDependencies").then(|| {
                    if *field != "peerDependencies" {
                        pj.get("peerDependencies").and_then(|p| p.get(name)).and_then(Value::as_str).unwrap_or(range)
                    } else {
                        range
                    }
                });
                let mut fresh: Option<String> = None;
                let (version, source, floor) = if let Some((ld, l)) = &lock
                    && let Some(v) = l.version(&importer, name, range)
                    // A locked copy outside a library's own range is some other workspace's (a peer the importer
                    // does not install), not what its code is written for: its floor is.
                    // A root override is a declaration: what it sets is the library's own install too (n8n: cli
                    // declares ws 8.20.1, the workspace overrides `ws: '>=8.21.1'`, the lockfile has 8.21.1).
                    && lib_range.is_none_or(|r| local || npm_satisfies(&v, r) != Some(false) || l.override_admitting(name, range, &v).is_some())
                {
                    let file = join(&rel_dir(root, ld), &l.file);
                    if let Some((other, set)) = l.replaced_by(name, range).filter(|_| !local) {
                        // Swapped for another package across the install: the locked version is the other's.
                        (None, format!("replaced by {other} ({set})"), None)
                    } else if local || npm_satisfies(&v, range) != Some(false) {
                        (Some(v), file, lib_range)
                    } else if let Some(set) = l.override_admitting(name, range, &v) {
                        // A root override is a declaration too: it sets the version for every workspace.
                        (Some(v), format!("{file} ({set})"), lib_range)
                    } else if *field == "peerDependencies" {
                        // A peer range says what this workspace supports; the install resolves the package for
                        // it elsewhere, so a pin outside it is what runs, not a sign of a stale lockfile.
                        (Some(v), file, lib_range)
                    } else {
                        // A locked version the manifest no longer admits means the lockfile is out of date: the
                        // declared range says more about what the project runs than the stale pin does.
                        let s = stale.entry(file.clone()).or_default();
                        s.0 += 1;
                        if s.1.len() < 3 {
                            s.1.push(format!("{name} {v} vs {range}"));
                        }
                        (range_floor(range), format!("floor of {shown} ({file} has {v}, outside the range)"), Some(range))
                    }
                } else if let Some((file, u)) = unlocked.as_ref().filter(|_| !local) {
                    // An override is a declaration: an exact version is what every install gets; a range is what
                    // it resolves in. Otherwise the declared range (a library's, for what its users install).
                    let set = u.overrides.get(name).and_then(|os| os.iter().find(|o| o.applies(range) && range_floor(&o.value).is_some()));
                    let spec = set.map_or(lib_range.unwrap_or(range), |o| o.value.as_str());
                    // Only a full version is exact: `5` or `1.x` is a range.
                    let exact = Version::parse(spec.trim().trim_start_matches(['=', 'v'])).ok();
                    match (set, exact) {
                        (Some(o), Some(v)) => (Some(v), format!("{} sets {spec}; {file} sets lockfile: false", o.set), lib_range),
                        _ => {
                            if u.newest {
                                fresh = Some(spec.to_string());
                            }
                            let how = if u.newest { "each install resolves the newest release it admits" } else { "resolutionMode lowest-direct installs it" };
                            let what = match set {
                                Some(o) => format!("{} sets {spec}", o.set),
                                None if spec == range => shown.clone(),
                                None => spec.to_string(),
                            };
                            (range_floor(spec), format!("floor of {what} ({file} sets lockfile: false; {how})"), Some(spec))
                        }
                    }
                } else if let Some(r) = lib_range {
                    let r_shown = if r == range { shown.clone() } else { r.to_string() };
                    (range_floor(r), format!("library floor of {r_shown}"), Some(r))
                } else if let Some(file) = passed.as_ref().filter(|_| standalone) {
                    (range_floor(range), format!("floor of {shown} (outside the {file} workspace)"), Some(range))
                } else if let Some(file) = &binary {
                    (range_floor(range), format!("floor of {shown} ({file} is not read)"), Some(range))
                } else {
                    (range_floor(range), format!("floor of {shown} (not in a lockfile)"), Some(range))
                };
                let public_name = alias_target(range).unwrap_or(name);
                let public_candidate = !local;
                let purl = npm_purl(public_name);
                declared.insert(purl.clone());
                if let Some((_, l)) = &lock
                    && let Some(runtime) = stub_runtime(public_name)
                    && let Some(v) = l.installed(&runtime)
                {
                    stub_runtimes.insert(npm_purl(&runtime), v);
                }
                let entry = deps.entry(purl).or_insert_with(|| Dep::new(public_name, public_candidate));
                entry.public_candidate &= public_candidate;
                if public_name == name {
                    entry.unaliased = true;
                } else {
                    entry.aliases.insert(name.clone());
                    entry.alias_dirs.insert(rel.clone());
                }
                if let Some((_, l)) = &lock
                    && let Some(seen) = l.seen.get(name).or_else(|| l.seen.get(public_name))
                {
                    entry.seen = entry.seen.and(*seen);
                }
                if let Some((_, l)) = &lock
                    && let Some(v) = l.version(&importer, name, range)
                    && let Some(pin) = l.pin(name, &v).or_else(|| l.pin(public_name, &v))
                    && !entry.pins.contains(&pin)
                {
                    entry.pins.push(pin);
                }
                // A manifest's version of a package is what it declares under the package's own name; an alias of it
                // there installs another copy beside it and never lowers that reading, read or resolved afresh.
                if public_name == name {
                    if entry.own_dirs.insert(rel.clone()) {
                        entry.readings.retain(|r| r.dir != rel);
                        entry.unpinned.retain(|(d, _)| *d != rel);
                    }
                } else if entry.own_dirs.contains(&rel) {
                    continue;
                }
                if let Some(spec) = fresh
                    && !entry.unpinned.contains(&(rel.clone(), spec.clone()))
                {
                    entry.unpinned.push((rel.clone(), spec));
                }
                let lock_file = lock.as_ref().map(|(ld, l)| join(&rel_dir(root, ld), &l.file));
                entry.read_under(&rel, version, source, standalone, floor.map(|r| Range::Npm(r.to_string())), lock_file);
            }
        }
        let floor = if standalone { &mut node_standalone } else { &mut node };
        if let Some(r) = pj.pointer("/engines/node").and_then(Value::as_str)
            && let Some(v) = range_floor(r)
        {
            let found = (v, format!("engines.node {r} in {}", join(&rel, "package.json")));
            if let Some((ld, l)) = &lock {
                let own = node_by_lock.entry(join(&rel_dir(root, ld), &l.file)).or_insert_with(|| found.clone());
                if found.0 < own.0 {
                    *own = found.clone();
                }
            }
            if floor.as_ref().is_none_or(|(n, _)| &found.0 < n) {
                *floor = Some(found);
            }
        }
        packages.push(Package {
            dir: rel,
            kind,
            lockfile: lock.map(|(ld, l)| join(&rel_dir(root, &ld), &l.file)),
            declared,
            own: pj.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).map(npm_purl),
        });
    }
    // Only a repository with no covered manifest at all (no lockfile, or none that installs anything here) takes its
    // Node range from standalone manifests.
    let any_covered = !covered.is_empty();
    if !any_covered {
        node = node_standalone;
    }
    let mut node_pin: Option<String> = None;
    if node.is_none() {
        for p in packages.iter().filter(|p| !any_covered || covered.contains(&p.dir)) {
            for f in [".nvmrc", ".node-version"] {
                let path = root.join(&p.dir).join(f);
                let Ok(t) = std::fs::read_to_string(&path) else { continue };
                if let Some(v) = parse_version(t.trim())
                    && node.as_ref().is_none_or(|(n, _)| &v < n) {
                        node = Some((v, join(&p.dir, f)));
                        node_pin = Some(t.trim().to_string());
                    }
            }
        }
    }
    // A lockfile root none of whose manifests declares engines takes the nearest toolchain file at or above it.
    for lf in packages.iter().filter_map(|p| p.lockfile.clone()).collect::<BTreeSet<String>>() {
        if node_by_lock.contains_key(&lf) {
            continue;
        }
        let mut d = Some(root.join(&lf).parent().map(Path::to_path_buf).unwrap_or_else(|| root.to_path_buf()));
        'up: while let Some(cur) = d {
            for f in [".nvmrc", ".node-version"] {
                if let Some(v) = std::fs::read_to_string(cur.join(f)).ok().and_then(|t| parse_version(t.trim())) {
                    node_by_lock.insert(lf.clone(), (v, join(&rel_dir(root, &cur), f)));
                    break 'up;
                }
            }
            if cur == root {
                break;
            }
            d = cur.parent().map(Path::to_path_buf);
        }
    }
    for (file, (n, examples)) in stale {
        notes.push(format!(
            "{file}: {n} locked version{} outside the ranges its package.json declares ({}); read at the declared floor instead. The lockfile looks out of date.",
            if n == 1 { " falls" } else { "s fall" },
            examples.join(", ")
        ));
    }
    // The sample apps and other separate projects below a lockfile that does not install them: read as their own,
    // unlocked projects (`Stack::standalone`).
    let mut standalone = vec![];
    for (file, dirs) in outside {
        let more = if dirs.len() > 3 { format!(" and {} more", dirs.len() - 3) } else { String::new() };
        let one = dirs.len() == 1;
        standalone.push(format!(
            "{} manifest{} outside the {file} workspace and {} no lockfile of {} own ({}{more}): read as {} at {} declared floors. The bump digest names {}; {} never set{} the reviewed version, the lockfile check or the Node range.",
            dirs.len(),
            if one { " is" } else { "s are" },
            if one { "has" } else { "have" },
            if one { "its" } else { "their" },
            dirs[..dirs.len().min(3)].join(", "),
            if one { "a separate project" } else { "separate projects" },
            if one { "its" } else { "their" },
            if one { "it" } else { "them" },
            if one { "it" } else { "they" },
            if one { "s" } else { "" },
        ));
    }
    let mut python = crate::pypi::detect(root, &mut packages, &mut deps, &mut notes);
    // No declared range: a toolchain file at the root, else the version CI sets the runtime up with.
    let mut runtime_pins = BTreeMap::new();
    if let Some(pin) = node_pin {
        runtime_pins.insert("node", pin);
    }
    if python.is_none()
        && let Some(t) = std::fs::read_to_string(root.join(".python-version")).ok()
        && let Some(line) = t.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#'))
        && let Some(v) = parse_version(line)
    {
        runtime_pins.insert("python", line.to_string());
        python = Some((v, ".python-version".to_string()));
    }
    for (runtime, slot) in [("node", &mut node), ("python", &mut python)] {
        if slot.is_none()
            && let Some((v, stated, source)) = ci_runtime(root, runtime)
        {
            runtime_pins.insert(runtime, stated);
            *slot = Some((v, source));
        }
    }
    // No name a private registry serves is ever named to a third party (`privacy`).
    // A test, example or fixture directory's configuration is its own (a local Verdaccio a test publishes to): it keeps
    // private the packages only such directories declare, and, for the rest, only the scopes and names it lists.
    // A project template's directory (`{{cookiecutter.slug}}`, copier) is not the repository's own project either.
    let local = |p: &Path| {
        let rel = rel_dir(root, p);
        !rel.contains("{{") && matches!(crate::usage::path_role(&rel), crate::usage::Role::App | crate::usage::Role::Tooling)
    };
    let (app_configs, other_configs): (Vec<PathBuf>, Vec<PathBuf>) = configs.into_iter().partition(|p| local(&p.parent().unwrap_or(root).join("x")));
    let (app_dirs, other_dirs): (BTreeSet<PathBuf>, BTreeSet<PathBuf>) = manifest_dirs.into_iter().partition(|d| local(&d.join("x")));
    let fixture_registries = Registries::read_local(&other_dirs, &other_configs);
    let registries = Registries::read(root, &app_dirs, &app_configs, env).union(&fixture_registries.narrow());
    for (purl, d) in deps.iter_mut() {
        let fixture_only = !d.readings.is_empty() && d.readings.iter().all(|r| !local(&root.join(&r.dir).join("x")));
        d.public_candidate &= registries.may_name(purl, d.seen) && (!fixture_only || fixture_registries.may_name(purl, d.seen));
    }
    // Aliases beside the package's own declaration: deliberate side-by-side installs, named once.
    let side: Vec<String> = deps
        .values()
        .filter(|d| d.alias_dirs.iter().any(|a| d.own_dirs.contains(a)))
        .map(|d| format!("{} ({})", d.name, d.aliases.iter().map(|a| format!("`{a}`")).collect::<Vec<_>>().join(", ")))
        .collect();
    if !side.is_empty() {
        notes.push(format!(
            "npm aliases installed side by side with the package of the same manifest: {}. The version is the one declared under the package's own name; the aliased copies are deliberate parallel installs, not the installed version.",
            side.join("; ")
        ));
    }
    // A Python requirement nothing pins is read at the newest release its range admits; public names only.
    crate::pypi::assume_newest(&mut deps, &mut notes, crate::pypi::registry_releases, crate::pypi::registry_requires);
    // So is an npm range a workspace with no lockfile resolves afresh on every install (`Unlocked`).
    crate::pypi::assume_newest_in(&NPM_FRESH, &mut deps, &mut notes, crate::pypi::npm_registry_releases, crate::pypi::no_requires);
    // Packages a lockfile installs from git, a URL, a path or another registry: not the public package of that name, so
    // they are not registered for coverage (a git-sourced `uWebSockets.js` is no `pkg:npm/uWebSockets.js`). Said once.
    let elsewhere: Vec<&str> = deps.values().filter(|d| d.seen == Seen::Elsewhere && !d.readings.is_empty()).map(|d| d.name.as_str()).collect();
    if !elsewhere.is_empty() {
        let more = if elsewhere.len() > 5 { format!(" and {} more", elsewhere.len() - 5) } else { String::new() };
        notes.push(format!(
            "{}{more}: installed from git, a URL, a path or a registry other than the public one (lockfile), not from the public registry; not covered.",
            elsewhere.iter().take(5).copied().collect::<Vec<_>>().join(", ")
        ));
    }
    let unlocked = unlocked_used.into_iter().collect();
    let mut st = Stack { packages, deps, node, node_by_lock, python, runtime_pins, notes, unreadable, stub_runtimes, spread: 0, standalone, registries, fixture_registries, peers, unlocked };
    st.settle();
    Ok(st)
}

/// The lowest version a CI workflow sets a runtime up with: the `<runtime>-version` input of its setup action
/// (`actions/setup-node`'s `node-version: 20.x`, `actions/setup-python`'s `python-version: '3.12'`, or a matrix list
/// of them), across `.github/workflows`. Expressions (`${{ matrix.node }}`), aliases (`lts/*`) and files
/// (`node-version-file`) are not versions and are skipped. Returns the version, the value as written, and the source.
pub fn ci_runtime(root: &Path, runtime: &str) -> Option<(Version, String, String)> {
    let key = format!("{runtime}-version:");
    let dir = root.join(".github/workflows");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "yml" || e == "yaml")).collect();
    files.sort();
    let mut best: Option<(Version, String, String)> = None;
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        for line in text.lines() {
            let line = line.split(" #").next().unwrap_or(line).trim().trim_start_matches("- ").trim();
            let Some(value) = line.strip_prefix(&key) else { continue };
            let value = value.trim().trim_start_matches('[').trim_end_matches(']');
            for one in value.split(',') {
                let one = one.trim().trim_matches(['"', '\'']).trim();
                if one.contains("${{") {
                    continue;
                }
                let Some(v) = parse_version(one) else { continue };
                if best.as_ref().is_none_or(|(b, _, _)| &v < b) {
                    let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    best = Some((v, one.to_string(), format!("{key} {one} in .github/workflows/{name}").replacen(": ", " ", 1)));
                }
            }
        }
    }
    best
}

/// The package an npm alias installs (`npm:@corp/bar@^1`, `npm:bar`, `npm:@corp/bar`): the name before the version's
/// `@`, never the alias key.
fn alias_target(range: &str) -> Option<&str> {
    let r = range.trim().strip_prefix("npm:")?;
    let end = r.get(1..).and_then(|t| t.find('@')).map_or(r.len(), |i| i + 1);
    Some(&r[..end]).filter(|n| !n.is_empty())
}

/// A dependency on a package of this repository (by name or by a local protocol): never public, and never compared
/// with what a lockfile records for it.
fn is_local(local_names: &BTreeSet<String>, name: &str, range: &str) -> bool {
    local_names.contains(name) || local_protocol(range)
}

/// A range naming a workspace, a path, git, a URL or another registry rather than a version of the public registry's
/// package. A registry range or tag never holds a `/` (npm-package-arg), so one that does is a path or a git shorthand
/// (`owner/repo#ref`), unless it is an alias or a catalog reference. A leading `.` or drive letter (`C:foo`) is a path
/// too. A patch is local when the descriptor it wraps is.
fn local_protocol(range: &str) -> bool {
    const SOURCES: [&str; 16] =
        ["workspace:", "file:", "link:", "portal:", "exec:", "git:", "git+", "git@", "ssh:", "github:", "gitlab:", "bitbucket:", "gist:", "jsr:", "https:", "http:"];
    let r = range.trim();
    if let Some(p) = r.strip_prefix("patch:") {
        return local_protocol(&patched_range(p));
    }
    let tarball = [".tgz", ".tar.gz", ".tar"].iter().any(|e| r.to_ascii_lowercase().ends_with(e));
    let b = r.as_bytes();
    let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
    SOURCES.iter().any(|p| r.starts_with(p))
        || r.starts_with('.')
        || drive
        || (!["npm:", "catalog:"].iter().any(|p| r.starts_with(p)) && (r.contains('/') || r.contains('\\') || tarball))
}

/// The range a Yarn patch wraps (`lodash@npm%3A4.17.21#./x.patch` → `npm:4.17.21`): the percent-decoded descriptor
/// before the patch's `#`, without its name.
fn patched_range(p: &str) -> String {
    let desc = p.split('#').next().unwrap_or("");
    let mut out = Vec::with_capacity(desc.len());
    let b = desc.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match (b[i], desc.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(c)) => {
                out.push(c);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    let d = String::from_utf8_lossy(&out).into_owned();
    d.get(1..).and_then(|t| t.find('@')).map_or(String::new(), |i| d[i + 2..].to_string())
}

fn rel_dir(base: &Path, dir: &Path) -> String {
    match dir.strip_prefix(base) {
        Ok(p) if p.as_os_str().is_empty() => ".".into(),
        Ok(p) => p.to_string_lossy().replace('\\', "/"),
        Err(_) => dir.to_string_lossy().to_string(),
    }
}

fn join(dir: &str, f: &str) -> String {
    if dir == "." { f.to_string() } else { format!("{dir}/{f}") }
}

/// Catalogs: catalog name → package → range, from `pnpm-workspace.yaml` or, without one, the workspace root's
/// `package.json` (Bun, Yarn 4.10+). `catalog` is the `default` catalog, `catalogs.<name>` the named ones. A manifest
/// uses the nearest workspace file at or above it.
#[derive(Debug, Clone, Default)]
pub struct Catalogs(BTreeMap<String, BTreeMap<String, String>>);

impl Catalogs {
    /// The catalogs of the nearest `pnpm-workspace.yaml` at or above `dir`, up to `root` (read once per directory).
    fn nearest(root: &Path, dir: &Path, cache: &mut BTreeMap<PathBuf, Catalogs>) -> Catalogs {
        let mut d = Some(dir);
        while let Some(cur) = d {
            if let Some(c) = cache.get(cur) {
                return c.clone();
            }
            let pnpm = std::fs::read_to_string(cur.join("pnpm-workspace.yaml")).ok().map(|t| parse_pnpm_workspace(&t));
            // Bun and Yarn 4.10+: the workspace root's `package.json` holds them (`workspaces.catalog`,
            // `workspaces.catalogs`; Bun also reads a top-level `catalog` / `catalogs`). A manifest that declares
            // `workspaces` or catalogs is a workspace root: the search stops there, as at a `pnpm-workspace.yaml`.
            let manifest = || {
                let pj = std::fs::read_to_string(cur.join("package.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())?;
                let root = pj.get("workspaces").is_some() || pj.get("catalog").is_some() || pj.get("catalogs").is_some();
                root.then(|| {
                    let mut c = Catalogs::from_json(&pj);
                    for (name, m) in Catalogs::from_json(pj.get("workspaces").unwrap_or(&Value::Null)).0 {
                        c.0.entry(name).or_default().extend(m);
                    }
                    c
                })
            };
            // A `pnpm-workspace.yaml` with no catalogs leaves them to the manifest beside it.
            let found = match pnpm {
                Some(c) if !c.0.is_empty() => Some(c),
                Some(c) => Some(manifest().unwrap_or(c)),
                None => manifest(),
            };
            if let Some(c) = found {
                cache.insert(cur.to_path_buf(), c.clone());
                return c;
            }
            if cur == root {
                break;
            }
            d = cur.parent();
        }
        Catalogs::default()
    }

    /// `catalog` (the default catalog) and `catalogs.<name>` of a JSON object: a `package.json` `workspaces` field,
    /// or the copy Bun writes at the top of `bun.lock`.
    pub fn from_json(v: &Value) -> Catalogs {
        let mut c = Catalogs::default();
        let entries = |m: &Value| -> BTreeMap<String, String> {
            m.as_object().into_iter().flatten().filter_map(|(n, r)| Some((n.clone(), r.as_str()?.to_string()))).collect()
        };
        if let Some(m) = v.get("catalog").filter(|m| m.is_object()) {
            c.0.entry("default".into()).or_default().extend(entries(m));
        }
        for (name, m) in v.get("catalogs").and_then(Value::as_object).into_iter().flatten() {
            c.0.entry(name.clone()).or_default().extend(entries(m));
        }
        c
    }

    /// The range a `catalog:` / `catalog:<name>` specifier stands for; `None` for any other range, or a catalog
    /// that does not list the package.
    pub fn resolve(&self, name: &str, range: &str) -> Option<&str> {
        let which = range.trim().strip_prefix("catalog:")?.trim();
        let which = if which.is_empty() { "default" } else { which };
        self.0.get(which)?.get(name).map(String::as_str)
    }
}

/// The entries of a one-line flow mapping (`{ next: 16.4.1, react: ^19 }`).
fn flow(v: &str) -> Option<Vec<(String, Option<&str>)>> {
    let inner = v.strip_prefix('{')?.strip_suffix('}')?;
    // Commas inside a quoted scalar (`">=1.0.0, <2.0.0"`) belong to it.
    let (mut entries, mut start, mut quote) = (vec![], 0, None);
    for (i, ch) in inner.char_indices() {
        match (quote, ch) {
            (None, '\'' | '"') => quote = Some(ch),
            (Some(q), _) if ch == q => quote = None,
            (None, ',') => {
                entries.push(&inner[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    entries.push(&inner[start..]);
    Some(entries.into_iter().filter_map(|e| split_key(e.trim())).collect())
}

/// The `catalog` and `catalogs` sections of `pnpm-workspace.yaml` (line-based, as `parse_pnpm`).
pub fn parse_pnpm_workspace(text: &str) -> Catalogs {
    let mut c = Catalogs::default();
    let mut stack: Vec<(usize, String)> = vec![];
    for raw in text.lines() {
        // A comment, whole-line or after a value (`next: 16.4.1 # pinned`).
        let line = match raw.find(" #") {
            Some(i) => &raw[..i],
            None => raw,
        };
        let trimmed = line.trim_end();
        if trimmed.trim().is_empty() || trimmed.trim_start().starts_with('#') {
            continue;
        }
        if trimmed.starts_with("---") || trimmed == "..." {
            stack.clear();
            continue;
        }
        let indent = trimmed.len() - trimmed.trim_start().len();
        let Some((k, val)) = split_key(trimmed.trim_start()) else { continue };
        while stack.last().is_some_and(|(i, _)| *i >= indent) {
            stack.pop();
        }
        let path: Vec<&str> = stack.iter().map(|(_, k)| k.as_str()).collect();
        let catalog = match path.as_slice() {
            ["catalog"] => Some("default"),
            ["catalogs", name] => Some(*name),
            _ => None,
        };
        // A flow mapping (`catalog: { next: 16.4.1, react: ^19 }`) holds the entries of the catalog it names.
        let (catalog, entries) = match (catalog, val.and_then(flow)) {
            (None, Some(e)) if path.as_slice() == ["catalogs"] => (Some(k.as_str()), e),
            (None, Some(e)) if path.is_empty() && k == "catalog" => (Some("default"), e),
            (Some(cat), _) => (Some(cat), val.map(|v| vec![(k.clone(), Some(v))]).unwrap_or_default()),
            _ => (None, vec![]),
        };
        if let Some(catalog) = catalog {
            for (name, v) in entries {
                if let Some(v) = v {
                    c.0.entry(catalog.to_string()).or_default().insert(name, v.trim_matches(['\'', '"']).to_string());
                }
            }
        }
        if val.is_none() {
            stack.push((indent, k));
        }
    }
    c
}

/// Resolved versions from one lockfile: per importer directory (`.` for the lockfile's own directory) and name.
#[derive(Debug, Clone, Default)]
pub struct Lock {
    pub file: String,
    importers: BTreeMap<String, BTreeMap<String, Version>>,
    /// yarn: (name, range) → version, and every version per name.
    by_range: BTreeMap<(String, String), Version>,
    by_name: BTreeMap<String, Vec<Version>>,
    /// (name, version) → the lockfile's `sha512-` integrity values (npm, pnpm, yarn v1).
    integrity: BTreeMap<(String, String), Vec<String>>,
    /// Root overrides its package manager applies to every workspace (`read_overrides`), by package name.
    overrides: BTreeMap<String, Vec<Override>>,
    /// Directories the lockfile lists as installed projects (pnpm importers, npm workspace entries, Yarn 2+
    /// `@workspace:` resolutions), relative to its own directory.
    listed: BTreeSet<String>,
    /// The workspace globs its package manager reads (`Members::read`).
    members: Members,
    /// Where it says each package came from, by name (`resolved`, a pnpm `tarball`), when it says.
    seen: BTreeMap<String, Seen>,
    /// What the reader could not make out (unparsable JSON, package entries with no readable resolution), for a
    /// visible warning: a lockfile is never dropped silently.
    pub unread: Option<String>,
}

/// Workspace members by the package manager's own globs: `pnpm-workspace.yaml` `packages` for pnpm, the
/// `package.json` `workspaces` field (an array, or Yarn's `{"packages": [...]}`) for npm and Yarn. A `!` pattern
/// excludes what it matches.
#[derive(Debug, Clone, Default)]
struct Members {
    /// Each include pattern with its matcher: a wildcard never matches a dot-prefixed name (pnpm, npm and Yarn glob
    /// with `dot: false`), so a `.name` segment must be spelled out in the pattern.
    include: Vec<(globset::GlobMatcher, String)>,
    exclude: globset::GlobSet,
}

impl Members {
    fn read(dir: &Path, lockfile: &str) -> Members {
        let patterns: Vec<String> = if lockfile == "pnpm-lock.yaml" {
            std::fs::read_to_string(dir.join("pnpm-workspace.yaml")).map(|t| pnpm_workspace_packages(&t)).unwrap_or_default()
        } else {
            let pj: Value = std::fs::read_to_string(dir.join("package.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
            let ws = pj.get("workspaces");
            ws.and_then(|w| w.get("packages")).or(ws).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect()
        };
        let (mut include, mut exclude) = (vec![], globset::GlobSetBuilder::new());
        for p in &patterns {
            let (negated, p) = match p.trim().strip_prefix('!') {
                Some(rest) => (true, rest),
                None => (false, p.trim()),
            };
            let p = p.trim_start_matches("./").trim_end_matches('/');
            let Ok(g) = globset::GlobBuilder::new(p).literal_separator(true).build() else { continue };
            if negated {
                exclude.add(g);
            } else {
                include.push((g.compile_matcher(), p.to_string()));
            }
        }
        Members { include, exclude: exclude.build().unwrap_or_default() }
    }

    fn contains(&self, rel: &str) -> bool {
        let dotted: Vec<&str> = rel.split('/').filter(|s| s.starts_with('.')).collect();
        self.include.iter().any(|(g, p)| g.is_match(rel) && dotted.iter().all(|d| p.split('/').any(|s| s == *d)))
            && !self.exclude.is_match(rel)
    }
}

/// The `packages` globs of `pnpm-workspace.yaml`, block (`- apps/*`) or flow (`[apps/*, packages/*]`, on one line
/// or several) form.
fn pnpm_workspace_packages(text: &str) -> Vec<String> {
    let unquote = |v: &str| v.trim().trim_matches(['\'', '"']).to_string();
    let (mut out, mut inside) = (vec![], false);
    // An open flow sequence, collected until its `]`.
    let mut flow: Option<String> = None;
    for raw in text.lines() {
        let line = raw.find(" #").map_or(raw, |i| &raw[..i]).trim_end();
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if let Some(acc) = flow.as_mut() {
            acc.push_str(line.trim());
            acc.push(' ');
        }
        if let Some(acc) = flow.take() {
            match acc.split_once(']') {
                Some((items, _)) => out.extend(items.trim_start_matches('[').split(',').map(unquote).filter(|p| !p.is_empty())),
                None => flow = Some(acc),
            }
            continue;
        }
        if line.starts_with("---") {
            inside = false;
            continue;
        }
        if !line.starts_with([' ', '\t', '-']) {
            let Some((k, val)) = split_key(line) else {
                inside = false;
                continue;
            };
            inside = k == "packages" && val.is_none();
            if k == "packages"
                && let Some(v) = val.map(str::trim).filter(|v| v.starts_with('['))
            {
                match v.split_once(']') {
                    Some((items, _)) => out.extend(items.trim_start_matches('[').split(',').map(unquote).filter(|p| !p.is_empty())),
                    None => flow = Some(format!("{v} ")),
                }
            }
        } else if inside && let Some(item) = line.trim_start().strip_prefix('-') {
            out.push(unquote(item));
        }
    }
    out
}

/// One root override of a package.
#[derive(Debug, Clone)]
struct Override {
    /// The selector's version (`react@^18` → `^18`): the override sets only dependencies declared in it.
    when: Option<String>,
    value: String,
    /// Where it is declared (`resolutions`, `pnpm.overrides`, …).
    set: &'static str,
}

impl Override {
    /// Whether it sets a dependency declared with `range`: no selector version, the same one, or a range whose floor
    /// the selector admits.
    fn applies(&self, range: &str) -> bool {
        let bare = |r: &str| r.trim().strip_prefix("npm:").unwrap_or(r.trim()).to_string();
        self.when.as_deref().is_none_or(|w| bare(w) == bare(range) || range_floor(range).is_some_and(|f| npm_satisfies(&f, &bare(w)) == Some(true)))
    }

    /// Whether it sets an installed `v`: no selector version, or one that admits `v` (one it cannot read, too).
    fn covers(&self, v: &Version) -> bool {
        self.when.as_deref().is_none_or(|w| npm_satisfies(v, w.trim().strip_prefix("npm:").unwrap_or(w.trim())) != Some(false))
    }
}

/// A pnpm workspace that installs with no lockfile (`lockfile: false` in `pnpm-workspace.yaml`, no `pnpm-lock.yaml`
/// beside it): every install resolves its manifests' ranges afresh, the newest release each admits unless
/// `resolutionMode: lowest-direct` takes direct dependencies at their floor. Its root overrides still set the
/// versions they name.
#[derive(Debug, Clone)]
struct Unlocked {
    overrides: BTreeMap<String, Vec<Override>>,
    members: Members,
    newest: bool,
}

impl Unlocked {
    fn read(dir: &Path) -> Option<Unlocked> {
        if dir.join("pnpm-lock.yaml").is_file() {
            return None;
        }
        let text = std::fs::read_to_string(dir.join("pnpm-workspace.yaml")).ok()?;
        let top = |key: &str| {
            text.lines()
                .filter(|l| !l.starts_with([' ', '\t', '#']))
                .find_map(|l| split_key(l.find(" #").map_or(l, |i| &l[..i]).trim_end()).filter(|(k, _)| k == key).and_then(|(_, v)| v.map(|v| v.trim_matches(['\'', '"']).to_string())))
        };
        (top("lockfile").as_deref() == Some("false")).then(|| Unlocked {
            overrides: read_overrides(dir, "pnpm-lock.yaml"),
            members: Members::read(dir, "pnpm-lock.yaml"),
            newest: top("resolutionMode").as_deref() != Some("lowest-direct"),
        })
    }

    fn covers(&self, rel: &str) -> bool {
        rel == "." || self.members.contains(rel)
    }
}

/// What the notes on an unlocked workspace's npm ranges say of them.
pub const UNLOCKED_NPM: &str = "in a pnpm workspace with lockfile: false";

/// The npm registry, for ranges an unlocked workspace resolves afresh (`pypi::assume_newest_in`).
const NPM_FRESH: crate::pypi::Fresh = crate::pypi::Fresh {
    prefix: "pkg:npm/",
    registry: "npm",
    what: ("npm dependency", "npm dependencies"),
    unpinned_by: UNLOCKED_NPM,
    admits: |v, r| npm_satisfies(v, r) == Some(true),
    range: Range::Npm,
};

/// npm lockfiles in the order used when nothing else decides between them, with the package manager that writes
/// each (the `packageManager` field names it).
const LOCKFILES: &[(&str, &str)] =
    &[("package-lock.json", "npm"), ("npm-shrinkwrap.json", "npm"), ("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lock", "bun")];

/// Bun's binary lockfile (before Bun 1.2's text `bun.lock`): its format is Bun's internal one and is not read.
pub const BINARY_LOCKFILE: &str = "bun.lockb";

/// One lockfile for a directory that holds several (a switch of package manager that left the old file behind):
/// the one whose versions the manifest beside it admits, then the one `packageManager` names, then the fixed
/// order. The choice is recorded in `notes` whenever there was one to make.
fn choose_lock(root: &Path, dir: &Path, mut cands: Vec<Lock>, local_names: &BTreeSet<String>, cat: &Catalogs, notes: &mut Vec<String>) -> Option<Lock> {
    if cands.len() < 2 {
        return cands.pop();
    }
    let pj: Value = std::fs::read_to_string(dir.join("package.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let declared: Vec<(&str, &str)> = DEP_FIELDS[..3]
        .iter()
        .filter_map(|f| pj.get(*f).and_then(Value::as_object))
        .flatten()
        .filter_map(|(n, r)| r.as_str().map(|r| (n.as_str(), cat.resolve(n, r).unwrap_or(r))))
        .filter(|(n, r)| !is_local(local_names, n, r))
        .collect();
    let manager = pj.get("packageManager").and_then(Value::as_str).and_then(|m| m.split('@').next()).unwrap_or("");
    // (outside the range, inside it) per candidate.
    let score = |l: &Lock| {
        declared.iter().fold((0usize, 0usize), |(out, ins), (n, r)| match l.version(".", n, r).and_then(|v| l.admits(n, &v, r)) {
            Some(false) => (out + 1, ins),
            Some(true) => (out, ins + 1),
            None => (out, ins),
        })
    };
    let rank = |l: &Lock| LOCKFILES.iter().position(|(f, _)| *f == l.file).unwrap_or(usize::MAX);
    let named = |l: &Lock| LOCKFILES.iter().any(|(f, m)| *f == l.file && *m == manager);
    let scores: Vec<(usize, usize)> = cands.iter().map(score).collect();
    let best = (0..cands.len())
        .min_by_key(|&i| (scores[i].0, std::cmp::Reverse(scores[i].1), !named(&cands[i]), rank(&cands[i])))
        .unwrap_or(0);
    let rel = rel_dir(root, dir);
    let others: Vec<String> = (0..cands.len())
        .filter(|&i| i != best)
        .map(|i| format!("{} has {} of {} declared versions outside their ranges", cands[i].file, scores[i].0, declared.len()))
        .collect();
    let why = if scores.iter().enumerate().any(|(i, s)| i != best && s.0 > scores[best].0) {
        format!("{} of {} declared versions outside their ranges", scores[best].0, declared.len())
    } else if named(&cands[best]) {
        format!("packageManager names {manager}")
    } else {
        "no lockfile agrees better with package.json; default order".into()
    };
    notes.push(format!(
        "{rel}: {} lockfiles present; versions from {} ({why}); {}.",
        cands.len(),
        join(&rel, &cands[best].file),
        others.join("; ")
    ));
    Some(cands.swap_remove(best))
}

impl Lock {
    /// Every npm lockfile in `dir`, parsed.
    pub fn read_all(dir: &Path) -> Vec<Lock> {
        let mut out = vec![];
        for (f, _) in LOCKFILES {
            let Ok(text) = std::fs::read_to_string(dir.join(f)) else { continue };
            let mut l = match *f {
                "pnpm-lock.yaml" => parse_pnpm(&text),
                "yarn.lock" => parse_yarn(&text),
                "bun.lock" => parse_bun(&text),
                _ => parse_npm(&text),
            };
            l.file = f.to_string();
            l.overrides = read_overrides(dir, f);
            l.members = Members::read(dir, f);
            out.push(l);
        }
        out
    }

    /// Whether the locked `v` is one the manifest declares: inside `range`, or set by a root override (`None`
    /// when the range cannot be read).
    pub fn admits(&self, name: &str, v: &Version, range: &str) -> Option<bool> {
        match npm_satisfies(v, range) {
            Some(false) if self.override_admitting(name, range, v).is_some() || self.replaced_by(name, range).is_some() => Some(true),
            r => r,
        }
    }

    /// Where an override that sets `name` and admits `v` is declared. One the range grammar cannot read (`patch:`,
    /// npm's `$react`, `link:`) admits whatever the lockfile resolved for it.
    fn override_admitting(&self, name: &str, range: &str, v: &Version) -> Option<&'static str> {
        self.overrides.get(name)?.iter().find(|o| o.applies(range) && npm_satisfies(v, &o.value) != Some(false)).map(|o| o.set)
    }

    /// The package an override swaps `name` for (`npm:noop-package@1.0.0`), and where that is declared.
    fn replaced_by(&self, name: &str, range: &str) -> Option<(&str, &'static str)> {
        self.overrides.get(name)?.iter().filter(|o| o.applies(range)).find_map(|o| {
            let alias = o.value.trim().strip_prefix("npm:")?;
            let other = alias.get(1..).and_then(|r| r.find('@')).map_or(alias, |i| &alias[..i + 1]);
            (!other.is_empty() && other != name).then_some((other, o.set))
        })
    }

    /// Whether the lockfile installs the manifest in `rel` (relative to the lockfile's directory): its own
    /// directory's, a workspace member by the package manager's globs, or an importer it lists. Any other manifest
    /// below it is a separate project the install never touches.
    pub fn covers(&self, rel: &str) -> bool {
        rel == "." || self.listed.contains(rel) || self.members.contains(rel)
    }

    pub fn version(&self, importer: &str, name: &str, range: &str) -> Option<Version> {
        if let Some(v) = self.importers.get(importer).and_then(|m| m.get(name)) {
            return Some(v.clone());
        }
        if let Some(v) = self.by_range.get(&(name.to_string(), range.to_string())) {
            return Some(v.clone());
        }
        if let Some(v) = self.by_range.get(&(name.to_string(), format!("npm:{range}"))) {
            return Some(v.clone());
        }
        // Hoisted at the lockfile root (npm workspaces), or the lowest version yarn resolved for that name.
        if let Some(v) = self.importers.get(".").and_then(|m| m.get(name)) {
            return Some(v.clone());
        }
        self.by_name.get(name).and_then(|vs| vs.iter().min().cloned())
    }

    /// The one version of `name` the install runs where no manifest declares it: the copy at the lockfile root
    /// (npm hoists it there), else the only version the lockfile holds. Several and none hoisted: unknown.
    pub fn installed(&self, name: &str) -> Option<Version> {
        if let Some(v) = self.importers.get(".").and_then(|m| m.get(name)) {
            return Some(v.clone());
        }
        let mut all: BTreeSet<Version> = self.integrity.keys().filter(|(n, _)| n == name).filter_map(|(_, v)| parse_version(v)).collect();
        all.extend(self.by_name.get(name).into_iter().flatten().cloned());
        if all.len() == 1 { all.pop_first() } else { None }
    }

    /// The locked version of `name` with its sha512 integrity, when the lockfile states one.
    pub fn pin(&self, name: &str, v: &Version) -> Option<Pin> {
        let hashes = self.integrity.get(&(name.to_string(), v.to_string()))?;
        Some(Pin { version: v.to_string(), hashes: hashes.clone() })
    }

    /// The values root overrides set `name` at `installed` to (`overrides`, `resolutions`, `pnpm.overrides`), with
    /// where each is set. A range-scoped selector (`zod@^4`) sets only the versions its range admits: it says
    /// nothing about a zod 3 the install also holds.
    pub fn override_values(&self, name: &str, installed: &Version) -> Vec<(String, &'static str)> {
        self.overrides.get(name).into_iter().flatten().filter(|o| o.covers(installed)).map(|o| (o.value.clone(), o.set)).collect()
    }

    fn saw(&mut self, name: &str, seen: Seen) {
        let e = self.seen.entry(name.to_string()).or_default();
        *e = e.and(seen);
    }

    /// Whether the lockfile installs `name` from a registry (a public `resolved` URL, or a tarball's integrity hash),
    /// not as a link to a directory of this repository.
    pub fn fetched(&self, name: &str) -> bool {
        self.seen.get(name) == Some(&Seen::Public) || self.integrity.keys().any(|(n, _)| n == name)
    }

    fn add_integrity(&mut self, name: &str, version: &Version, integrity: &str) {
        // Only sha512: what the public registry states as `dist.integrity` for every current package.
        let hashes: Vec<String> = integrity.split_whitespace().filter(|h| h.starts_with("sha512-")).map(String::from).collect();
        if !hashes.is_empty() {
            self.integrity.insert((name.to_string(), version.to_string()), hashes);
        }
    }
}

/// Root overrides the package manager that writes `lockfile` applies across the install, read from the
/// `package.json` (and `pnpm-workspace.yaml`) beside it: Yarn `resolutions`; npm `overrides`; pnpm `pnpm.overrides`,
/// `resolutions` and the workspace file's `overrides`. Only selectors that apply everywhere count (`react`,
/// `react@^18`, `**/react`, npm's `{"react": {".": "19"}}`); one under a parent (`a/react`, `a>react`, npm's nested
/// keys) does not set a workspace's own dependency.
fn read_overrides(dir: &Path, lockfile: &str) -> BTreeMap<String, Vec<Override>> {
    let pj: Value = std::fs::read_to_string(dir.join("package.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let fields: &[(&str, &str)] = match lockfile {
        "yarn.lock" => &[("/resolutions", "resolutions")],
        "bun.lock" => &[("/overrides", "overrides"), ("/resolutions", "resolutions")],
        "pnpm-lock.yaml" => &[("/pnpm/overrides", "pnpm.overrides"), ("/resolutions", "resolutions")],
        _ => &[("/overrides", "overrides")],
    };
    let mut out: BTreeMap<String, Vec<Override>> = BTreeMap::new();
    let mut add = |sel: &str, val: &str, set: &'static str| {
        if let Some((name, when)) = override_target(sel) {
            out.entry(name.to_string()).or_default().push(Override { when: when.map(String::from), value: val.to_string(), set });
        }
    };
    for (ptr, set) in fields {
        for (sel, val) in pj.pointer(ptr).and_then(Value::as_object).into_iter().flatten() {
            match val {
                Value::String(v) => add(sel, v, set),
                // npm: `{"react": {".": "19.2.7", "child": "1"}}` sets react itself with `.`.
                Value::Object(o) => {
                    if let Some(v) = o.get(".").and_then(Value::as_str) {
                        add(sel, v, set)
                    }
                }
                _ => {}
            }
        }
    }
    if lockfile == "pnpm-lock.yaml"
        && let Ok(text) = std::fs::read_to_string(dir.join("pnpm-workspace.yaml"))
    {
        for (sel, val) in pnpm_workspace_overrides(&text) {
            add(&sel, &val, "pnpm-workspace.yaml overrides");
        }
    }
    out
}

/// The package an override selector sets everywhere: `name`, `@scope/name`, either with a version (`name@^1`,
/// `name@npm:1.0.0`), or behind Yarn's `**/`, with that version. `None` for one that applies only under a parent.
fn override_target(sel: &str) -> Option<(&str, Option<&str>)> {
    let s = sel.trim();
    let s = s.strip_prefix("**/").unwrap_or(s);
    if s.contains('>') {
        return None; // pnpm `parent>child`
    }
    let name_end = match s.strip_prefix('@') {
        Some(r) => {
            let slash = r.find('/')? + 2;
            slash + s[slash..].find(['@', '/']).unwrap_or(s.len() - slash)
        }
        None => s.find(['@', '/']).unwrap_or(s.len()),
    };
    let (name, rest) = s.split_at(name_end);
    // Anything after the name and its version is a path below it (`parent/child`, `parent@1/child`).
    let when = rest.strip_prefix('@').filter(|w| !w.is_empty());
    (!name.is_empty() && !name.ends_with('/') && !rest.contains('/')).then_some((name, when))
}

/// The top-level `overrides` of `pnpm-workspace.yaml` (pnpm 10+), block or flow form.
fn pnpm_workspace_overrides(text: &str) -> Vec<(String, String)> {
    let (mut out, mut inside) = (vec![], false);
    for raw in text.lines() {
        let line = raw.find(" #").map_or(raw, |i| &raw[..i]).trim_end();
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if line.starts_with("---") {
            inside = false;
            continue;
        }
        let top = !line.starts_with([' ', '\t']);
        let Some((k, val)) = split_key(line.trim_start()) else { continue };
        if top {
            inside = k == "overrides" && val.is_none();
            if k == "overrides" {
                out.extend(val.and_then(flow).into_iter().flatten().filter_map(|(k, v)| Some((k, v?.trim_matches(['\'', '"']).to_string()))));
            }
        } else if inside && let Some(v) = val {
            out.push((k, v.trim_matches(['\'', '"']).to_string()));
        }
    }
    out
}

pub fn parse_npm(text: &str) -> Lock {
    let mut l = Lock::default();
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        l.unread = Some("not valid JSON".into());
        return l;
    };
    if let Some(pk) = v.get("packages").and_then(Value::as_object) {
        for (key, meta) in pk {
            if !key.is_empty() && !key.contains("node_modules/") {
                l.listed.insert(key.trim_start_matches("./").to_string()); // a workspace member (`packages/ui`)
            }
            let Some((prefix, name)) = key.rsplit_once("node_modules/") else { continue };
            if name.is_empty() || prefix.contains("node_modules/") {
                continue; // nested dependencies of dependencies
            }
            let importer = prefix.trim_end_matches('/');
            let importer = if importer.is_empty() { "." } else { importer };
            if let Some(u) = meta.get("resolved").and_then(Value::as_str) {
                l.saw(name, Seen::npm_url(u));
            }
            if let Some(ver) = meta.get("version").and_then(Value::as_str).and_then(parse_version) {
                if let Some(i) = meta.get("integrity").and_then(Value::as_str) {
                    l.add_integrity(name, &ver, i);
                }
                l.importers.entry(importer.to_string()).or_default().insert(name.to_string(), ver);
            }
        }
    } else if let Some(deps) = v.get("dependencies").and_then(Value::as_object) {
        for (name, meta) in deps {
            if let Some(u) = meta.get("resolved").and_then(Value::as_str) {
                l.saw(name, Seen::npm_url(u));
            }
            if let Some(ver) = meta.get("version").and_then(Value::as_str).and_then(parse_version) {
                if let Some(i) = meta.get("integrity").and_then(Value::as_str) {
                    l.add_integrity(name, &ver, i);
                }
                l.importers.entry(".".into()).or_default().insert(name.clone(), ver);
            }
        }
    }
    l
}

pub(crate) fn clean_pnpm_version(v: &str) -> Option<Version> {
    let v = v.trim().trim_matches(['\'', '"']);
    if v.starts_with("link:") || v.starts_with("file:") || v.starts_with("workspace:") {
        return None;
    }
    // The peer suffix first: it can name scoped packages (`16.4.1(@babel/core@7.29.7)`), whose `/` is not the
    // old format's.
    let v = v.split('(').next().unwrap_or(v); // `16.0.3(react@19.0.0)`
    // An npm alias's entry names the package it installs (`typescript@7.0.2`, `'@typescript/typescript6@6.0.2'`).
    let v = match v.starts_with(|c: char| c.is_ascii_alphabetic() || c == '@') {
        true => v.get(1..).and_then(|r| r.find('@')).map_or(v, |i| &v[i + 2..]),
        false => v,
    };
    let v = v.rsplit('/').next().unwrap_or(v); // `/next/13.0.0` (old format)
    let v = v.split('_').next().unwrap_or(v); // `13.0.0_react@18.2.0` (lockfile v5)
    parse_version(v)
}

/// The runtime package a type stub describes: npm `@types/express` → `express`, `@types/babel__core` →
/// `@babel/core`.
pub(crate) fn stub_runtime(name: &str) -> Option<String> {
    let n = name.strip_prefix("@types/")?;
    Some(match n.split_once("__") {
        Some((scope, rest)) => format!("@{scope}/{rest}"),
        None => n.to_string(),
    })
}

/// YAML lines with each flow collection (`{ … }`, `[ … ]`) that spans several lines joined onto the line that opens
/// its key, as Prettier and other formatters write them (`resolution:\n  {\n    integrity: sha512-…,\n  }`); the
/// line-based readers then see the one-line form pnpm itself writes. Brackets inside quotes and comments do not count.
pub(crate) fn yaml_flow_lines(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut depth = 0i32;
    for line in text.lines() {
        let mut quote: Option<char> = None;
        let mut d = depth;
        let mut prev = ' ';
        for c in line.chars() {
            let after_space = prev.is_whitespace();
            prev = c;
            match (quote, c) {
                (Some(q), c) if c == q => quote = None,
                (Some(_), _) => {}
                (None, '\'' | '"') => quote = Some(c),
                // A comment starts at a `#` after whitespace (a URL fragment's does not).
                (None, '#') if after_space => break,
                (None, '{' | '[') => d += 1,
                (None, '}' | ']') => d -= 1,
                _ => {}
            }
        }
        // A collection opened on the line after its key (`resolution:` then `{`) belongs to that key.
        let opens_value = depth == 0 && line.trim_start().starts_with(['{', '[']) && out.last().is_some_and(|p| p.trim_end().ends_with(':'));
        match out.last_mut() {
            Some(prev) if depth > 0 || opens_value => {
                prev.push(' ');
                prev.push_str(line.trim());
            }
            _ => out.push(line.to_string()),
        }
        depth = d.max(0);
    }
    out
}

/// A line-based reader for the parts of `pnpm-lock.yaml` needed here (importers, or top-level dependencies in
/// single-project lockfiles); no YAML dependency. Formatter output (double quotes, multi-line flow mappings with
/// trailing commas) reads as pnpm's own.
pub fn parse_pnpm(text: &str) -> Lock {
    let mut l = Lock::default();
    let mut stack: Vec<(usize, String)> = vec![];
    const SECTIONS: &[&str] = &["dependencies", "devDependencies", "optionalDependencies"];
    // `packages:` entries, and those whose resolution said where they came from or what they hash to.
    let (mut entries, mut resolved) = (BTreeSet::<String>::new(), BTreeSet::<String>::new());
    for raw in yaml_flow_lines(text) {
        let raw = raw.as_str();
        let trimmed = raw.trim_end();
        if trimmed.trim().is_empty() || trimmed.trim_start().starts_with('#') {
            continue;
        }
        // A new YAML document (pnpm 11+ writes the package manager's own lock as a first document): nothing
        // nests across it.
        if trimmed.starts_with("---") || trimmed == "..." {
            stack.clear();
            continue;
        }
        let indent = trimmed.len() - trimmed.trim_start().len();
        let body = trimmed.trim_start();
        let Some((k, val)) = split_key(body) else { continue };
        while stack.last().is_some_and(|(i, _)| *i >= indent) {
            stack.pop();
        }
        let path: Vec<&str> = stack.iter().map(|(_, k)| k.as_str()).collect();
        if path.as_slice() == ["packages"] {
            entries.insert(k.clone());
        }
        // `packages:` entries: `name@1.2.3(peer@x)` (v6+) or `/name/1.2.3` (v5), with `resolution: {integrity: ...}`
        // inline or as a nested key.
        let integrity = match (path.as_slice(), val) {
            (["packages", key], Some(v)) if k == "resolution" => {
                v.split_once("integrity:").map(|(_, r)| (*key, r.trim().trim_end_matches('}').split(',').next().unwrap_or("").trim().to_string()))
            }
            (["packages", key, "resolution"], Some(v)) if k == "integrity" => Some((*key, v.to_string())),
            _ => None,
        };
        // `resolution: {integrity: …, tarball: …}` (a registry other than the default one names its URL), or
        // `{type: git, …}` / `{type: directory, …}`: where the package came from.
        let source = match (path.as_slice(), val) {
            (["packages", key], Some(v)) if k == "resolution" => {
                let url = v.split_once("tarball:").map(|(_, r)| r.trim().trim_end_matches('}').split(',').next().unwrap_or("").trim().trim_matches(['\'', '"']).to_string());
                match url {
                    Some(u) => Some((*key, Seen::npm_url(&u))),
                    None => v.contains("type:").then_some((*key, Seen::Elsewhere)),
                }
            }
            (["packages", key, "resolution"], Some(v)) if k == "tarball" => Some((*key, Seen::npm_url(v.trim_matches(['\'', '"'])))),
            (["packages", key, "resolution"], Some(_)) if k == "type" => Some((*key, Seen::Elsewhere)),
            _ => None,
        };
        if let Some(key) = integrity.as_ref().filter(|(_, i)| !i.is_empty()).map(|(k, _)| *k).or(source.as_ref().map(|(k, _)| *k)) {
            resolved.insert(key.to_string());
        }
        if let Some((key, seen)) = source {
            let key = key.trim_start_matches('/');
            let key = key.split('(').next().unwrap_or(key);
            if let Some((name, _)) = key.get(1..).and_then(|r| r.rfind('@')).map(|at| (&key[..at + 1], ())).or_else(|| key.rsplit_once('/').map(|(n, _)| (n, ()))) {
                l.saw(name, seen);
            }
        }
        if let Some((key, i)) = integrity {
            let key = key.trim_start_matches('/');
            let key = key.split('(').next().unwrap_or(key);
            let split = key.get(1..).and_then(|r| r.rfind('@')).map(|at| (&key[..at + 1], &key[at + 2..])).or_else(|| key.rsplit_once('/'));
            if let Some((name, ver)) = split
                && let Some(v) = clean_pnpm_version(ver)
            {
                l.add_integrity(name, &v, i.trim_matches(['\'', '"']));
            }
        }
        let mut add = |importer: &str, name: &str, v: &str| {
            if let Some(ver) = clean_pnpm_version(v) {
                l.importers.entry(importer.to_string()).or_default().insert(name.to_string(), ver);
            }
        };
        if path.as_slice() == ["importers"] {
            l.listed.insert(k.clone()); // `apps/web:`, or `packages/tsconfig: {}` with no dependencies
        }
        match (path.as_slice(), val) {
            (["importers", imp, sec], Some(v)) if SECTIONS.contains(sec) => add(imp, &k, v),
            (["importers", imp, sec, name], Some(v)) if SECTIONS.contains(sec) && k == "version" => add(imp, name, v),
            ([sec], Some(v)) if SECTIONS.contains(sec) => add(".", &k, v),
            ([sec, name], Some(v)) if SECTIONS.contains(sec) && k == "version" => add(".", name, v),
            _ => {}
        }
        if val.is_none() {
            stack.push((indent, k));
        }
    }
    let missed = entries.difference(&resolved).count();
    if missed > 0 {
        let first = entries.difference(&resolved).next().map(String::as_str).unwrap_or("");
        l.unread = Some(format!("{missed} of {} package entries with no readable resolution, first {first}", entries.len()));
    } else if l.importers.is_empty() && l.listed.is_empty() && text.lines().any(|t| SECTIONS.iter().any(|s| t.trim_start().strip_prefix(s).is_some_and(|r| r.starts_with(':')))) {
        l.unread = Some("no importers or dependencies found".into());
    }
    l
}

/// `key: value` → (key, Some(value)); `key:` → (key, None). Quotes around the key are removed.
pub(crate) fn split_key(body: &str) -> Option<(String, Option<&str>)> {
    let (k, rest) = if let Some(q) = body.strip_prefix('\'').or_else(|| body.strip_prefix('"')) {
        let end = q.find(['\'', '"'])?;
        (&q[..end], q[end + 1..].strip_prefix(':')?)
    } else {
        let i = body.find(": ").or_else(|| body.strip_suffix(':').map(|_| body.len() - 1))?;
        (&body[..i], &body[i + 1..])
    };
    let v = rest.trim();
    Some((k.to_string(), if v.is_empty() { None } else { Some(v) }))
}

/// JSON with comments and trailing commas (JSONC, as Bun writes `bun.lock`), read as JSON: both are dropped outside
/// strings before parsing.
pub(crate) fn jsonc(text: &str) -> Option<Value> {
    let (b, mut out) = (text.as_bytes(), Vec::with_capacity(text.len()));
    let (mut i, mut in_str) = (0, false);
    while i < b.len() {
        let c = b[i];
        if in_str {
            out.push(c);
            if c == b'\\' && i + 1 < b.len() {
                out.push(b[i + 1]);
                i += 1;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
            out.push(c);
        } else if c == b'/' && b.get(i + 1) == Some(&b'/') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
            continue;
        } else if c == b',' && b[i + 1..].iter().find(|x| !x.is_ascii_whitespace()).is_some_and(|x| *x == b'}' || *x == b']') {
            // A trailing comma (comments between it and the bracket are not expected in a lockfile).
        } else {
            out.push(c);
        }
        i += 1;
    }
    serde_json::from_slice(&out).ok()
}

/// A `bun.lock` package identity (`name@1.2.3`, `name@workspace:packages/a`, `name@github:o/r#sha`) split into the
/// package name and what follows the `@`. An npm alias's entry names the package it installs.
pub(crate) fn bun_ident(ident: &str) -> Option<(&str, &str)> {
    let at = ident.get(1..)?.find('@')? + 1;
    Some((&ident[..at], &ident[at + 1..]))
}

/// The package names along a `bun.lock` `packages` key: `a/@s/b/c` → `[a, @s/b, c]` (the package at `c` is
/// installed under `a/@s/b`; a key with one name is hoisted to the root, under a workspace's name it is that
/// workspace's own copy).
pub(crate) fn bun_path(key: &str) -> Vec<&str> {
    let (mut out, mut start, mut scoped) = (vec![], 0, false);
    for (i, c) in key.char_indices() {
        if c == '/' {
            if scoped {
                scoped = false;
                continue;
            }
            out.push(&key[start..i]);
            start = i + 1;
        } else if i == start && c == '@' {
            scoped = true;
        }
    }
    out.push(&key[start..]);
    out
}

/// Bun's text lockfile (`bun.lock`, Bun 1.2+): `workspaces` lists each project by directory with its declared
/// ranges, `packages` maps an install path (`bun_path`) to `[identity, registry URL, metadata, integrity]`. A
/// package installed directly under a workspace's name is that workspace's version; one at the root is hoisted.
pub fn parse_bun(text: &str) -> Lock {
    let mut l = Lock::default();
    let Some(v) = jsonc(text) else {
        l.unread = Some("not valid JSON".into());
        return l;
    };
    for dir in v.get("workspaces").and_then(Value::as_object).into_iter().flatten().map(|(d, _)| d) {
        if !dir.is_empty() {
            l.listed.insert(dir.trim_start_matches("./").to_string());
        }
    }
    let Some(pk) = v.get("packages").and_then(Value::as_object) else { return l };
    // Workspace members by package name: a key under one (`@acme/app/vite`) is that workspace's own copy.
    let mut ws: BTreeMap<&str, String> = BTreeMap::new();
    for (key, e) in pk {
        if let Some(path) = e.get(0).and_then(Value::as_str).and_then(bun_ident).and_then(|(_, s)| s.strip_prefix("workspace:")) {
            let path = path.trim_start_matches("./").to_string();
            l.listed.insert(path.clone());
            ws.insert(key.as_str(), path);
        }
    }
    let mut unreadable = 0;
    for (key, e) in pk {
        let path = bun_path(key);
        let Some(name) = path.last().copied() else { continue };
        let Some((_, spec)) = e.get(0).and_then(Value::as_str).and_then(bun_ident) else {
            unreadable += 1;
            continue;
        };
        if spec.starts_with("workspace:") {
            continue;
        }
        let Some(ver) = parse_version(spec) else {
            // A git, tarball or path source: not the registry's package of that name.
            l.saw(name, Seen::Elsewhere);
            continue;
        };
        if let Some(u) = e.get(1).and_then(Value::as_str).filter(|u| !u.is_empty()) {
            l.saw(name, Seen::npm_url(u));
        }
        if let Some(i) = e.get(3).and_then(Value::as_str) {
            l.add_integrity(name, &ver, i);
        }
        let importer = match path.as_slice() {
            [_] => Some(".".to_string()),
            [parent, _] => ws.get(parent).cloned(),
            _ => None,
        };
        if let Some(imp) = importer {
            l.importers.entry(imp).or_default().insert(name.to_string(), ver);
        }
    }
    if unreadable > 0 {
        l.unread = Some(format!("{unreadable} package entries with no readable identity"));
    }
    l
}

pub fn parse_yarn(text: &str) -> Lock {
    let mut l = Lock::default();
    let mut specs: Vec<(String, String)> = vec![];
    let mut version: Option<Version> = None;
    for line in text.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') {
            specs.clear();
            version = None;
            for s in line.trim_end_matches(':').split(", ") {
                let s = s.trim().trim_matches('"');
                let at = s[1..].find('@').map(|i| i + 1);
                if let Some(i) = at {
                    if let Some(path) = s[i + 1..].strip_prefix("workspace:") {
                        l.listed.insert(path.to_string()); // Yarn 2+: `@grafana/data@workspace:packages/data`
                    }
                    specs.push((s[..i].to_string(), s[i + 1..].to_string()));
                }
            }
            continue;
        }
        let t = line.trim();
        let v = t.strip_prefix("version ").or_else(|| t.strip_prefix("version: "));
        if let Some(v) = v.and_then(|v| parse_version(v.trim_matches('"'))) {
            for (name, range) in &specs {
                l.by_range.insert((name.clone(), range.clone()), v.clone());
                l.by_name.entry(name.clone()).or_default().push(v.clone());
            }
            version = Some(v);
        }
        // yarn v1 `resolved "<url>"` (Berry names no URL for the default registry).
        if let Some(u) = t.strip_prefix("resolved ") {
            let names: BTreeSet<String> = specs.iter().map(|(n, _)| n.clone()).collect();
            for name in names {
                l.saw(&name, Seen::npm_url(u.trim_matches('"')));
            }
        }
        // Yarn 2+ `resolution: "<name>@<source>"`: a git, URL or path source is not the registry's package of that
        // name (`uWebSockets.js@https://github.com/uNetworking/uWebSockets.js.git#commit=…`).
        if let Some(r) = t.strip_prefix("resolution: ").or_else(|| t.strip_prefix("resolution ")) {
            let r = r.trim_matches('"');
            let source = r.get(1..).and_then(|x| x.find('@')).map(|i| &r[i + 2..]).unwrap_or("");
            if source.contains("://") || ["git", "github:", "file:", "link:", "portal:"].iter().any(|p| source.starts_with(p)) {
                let names: BTreeSet<String> = specs.iter().map(|(n, _)| n.clone()).collect();
                for name in names {
                    l.saw(&name, Seen::Elsewhere);
                }
            }
        }
        // yarn v1 `integrity sha512-...` (berry's `checksum` is its own format: no pin, the name check applies).
        if let (Some(i), Some(v)) = (t.strip_prefix("integrity "), &version) {
            let names: BTreeSet<&String> = specs.iter().map(|(n, _)| n).collect();
            for name in names {
                l.add_integrity(name, v, i.trim_matches('"'));
            }
        }
    }
    l
}

#[cfg(test)]
mod tests {
    #[test]
    fn uncovered_manifests_anywhere_except_examples_and_fixtures() {
        let mut r = crate::usage::Repo::default();
        for p in [
            "pyproject.toml",
            "requirements-dev.txt",
            "sandbox/artifact-runtime/requirements.txt",
            "native/agentive_nif/Cargo.toml",
            "mix.exs",
            "src/App/App.csproj",
            "examples/py/pyproject.toml",
            "tests/fixtures/go.mod",
            "package.json",
        ] {
            r.paths.push(p.to_string());
        }
        let m = uncovered_manifests(&r, &Stack::default());
        assert!(!m.contains_key("Python (PyPI)"), "read by the PyPI adapter");
        assert_eq!(m["Rust (crates.io)"], vec!["native/agentive_nif/Cargo.toml"]);
        assert_eq!(m["Elixir (Hex)"], vec!["mix.exs"]);
        assert_eq!(m["C# (NuGet)"], vec!["src/App/App.csproj"]);
        assert!(!m.contains_key("Go modules"), "a fixture's manifest is not the project's");
        assert_eq!(m.len(), 3);
    }

    #[test]
    fn setup_py_is_uncovered_only_where_nothing_beside_it_was_read() {
        let mut r = crate::usage::Repo::default();
        for p in ["setup.py", "pyproject.toml", "svc/setup.cfg", "svc/requirements.txt", "examples/demo/setup.py"] {
            r.paths.push(p.to_string());
        }
        let pkg = |dir: &str, declared: &[&str]| Package {
            dir: dir.into(),
            kind: Kind::Application,
            lockfile: None,
            declared: declared.iter().map(|s| s.to_string()).collect(),
            own: None,
        };
        // txtai: a `pyproject.toml` holding only tool settings, every requirement in `setup.py`.
        let mut st = Stack { packages: vec![pkg(".", &[]), pkg("svc", &["pkg:pypi/httpx"])], ..Default::default() };
        let m = uncovered_manifests(&r, &st);
        assert_eq!(m["Python (setuptools)"], vec!["setup.py"], "svc/ read its requirements; examples are not the project's");
        let why = unread_note(&r, &st).unwrap();
        assert!(why.contains("does not read") && why.contains("setup.py"), "{why}");
        st.packages[0].declared.insert("pkg:pypi/numpy".into());
        assert!(uncovered_manifests(&r, &st).is_empty(), "a read pyproject.toml beside it declares the packages");
        assert!(unread_note(&crate::usage::Repo::default(), &Stack::default()).unwrap().contains("declares any packages"));
    }

    #[test]
    fn a_setup_py_module_that_is_no_setuptools_script_is_not_a_manifest() {
        // fast-agent: `src/fast_agent/cli/commands/setup.py` is the Typer `setup` command, beside a read root pyproject.toml.
        let mut r = crate::usage::Repo::default();
        for (p, t) in [
            ("src/app/cli/setup.py", "import typer\napp = typer.Typer()\n"),
            ("src/app/cmd/setup.py", "# like setuptools' setup(), but for config\nimport typer\n"),
            ("svc/setup.py", "from setuptools import setup\nsetup(name=\"svc\")\n"),
        ] {
            r.paths.push(p.to_string());
            r.files.push((p.to_string(), t.to_string()));
        }
        let m = uncovered_manifests(&r, &Stack::default());
        assert_eq!(m["Python (setuptools)"], vec!["svc/setup.py"], "{m:?}");
    }

    use super::*;

    #[test]
    fn pnpm_lock_formatted_by_prettier_reads_as_pnpms_own() {
        // vercel/commerce: double quotes, and each resolution a multi-line flow mapping with a trailing comma.
        let text = "lockfileVersion: \"9.0\"\n\nimporters:\n  .:\n    dependencies:\n      \"@headlessui/react\":\n        specifier: ^2.2.0\n        version: 2.2.0(react@19.0.0)\n      react:\n        specifier: 19.0.0\n        version: 19.0.0\n\npackages:\n  \"@headlessui/react@2.2.0\":\n    resolution:\n      {\n        integrity: sha512-aa==,\n      }\n    engines: { node: \">=10\" }\n    cpu: [arm64]\n\n  react@19.0.0:\n    resolution:\n      {\n        integrity: sha512-bb==,\n        tarball: \"https://registry.npmjs.org/react/-/react-19.0.0.tgz\",\n      }\n";
        let l = parse_pnpm(text);
        assert_eq!(l.unread, None);
        let v = l.version(".", "@headlessui/react", "^2.2.0").unwrap();
        assert_eq!(l.pin("@headlessui/react", &v).unwrap().hashes, vec!["sha512-aa=="]);
        let r = l.version(".", "react", "19.0.0").unwrap();
        assert_eq!(l.pin("react", &r).unwrap().hashes, vec!["sha512-bb=="]);
        let g = crate::advisories::pnpm_lock(text, ".", "pnpm-lock.yaml");
        assert!(format!("{g:?}").contains("react@19.0.0"));
    }

    #[test]
    fn a_type_stub_records_its_runtime_packages_locked_version() {
        assert_eq!(stub_runtime("@types/babel__core").as_deref(), Some("@babel/core"));
        assert_eq!(stub_runtime("express"), None);
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"dependencies": {"@nestjs/platform-express": "^12.0.1"}, "devDependencies": {"@types/express": "^5.0.0"}}"#);
        write(d.path(), "package-lock.json", r#"{"lockfileVersion": 3, "packages": {"": {}, "node_modules/@nestjs/platform-express": {"version": "12.0.1"}, "node_modules/@types/express": {"version": "5.0.6"}, "node_modules/express": {"version": "5.2.1"}}}"#);
        let s = detect(d.path()).unwrap();
        assert_eq!(s.deps["pkg:npm/%40types/express"].version, Some(Version::new(5, 0, 6)));
        assert!(!s.deps.contains_key("pkg:npm/express"));
        assert_eq!(s.stub_runtimes["pkg:npm/express"], Version::new(5, 2, 1));
    }

    #[test]
    fn unreadable_lockfiles_say_so() {
        assert!(parse_npm("{\"packages\": {").unread.is_some());
        assert_eq!(parse_pnpm("lockfileVersion: '9.0'\n").unread, None, "an empty project");
        assert!(parse_pnpm("lockfileVersion: '9.0'\ndependencies:\n  a: ~\n").unread.is_some());
        assert_eq!(yaml_flow_lines("a:\n  {\n    t: https://x/y.tgz#h,\n  } # done\nb: 1\n"), vec!["a: { t: https://x/y.tgz#h, } # done", "b: 1"]);
        let l = parse_pnpm("lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      a:\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  a@1.0.0:\n    resolution: <<unknown>>\n");
        assert!(l.unread.as_deref().is_some_and(|u| u.starts_with("1 of 1 package entries")), "{:?}", l.unread);
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"dependencies": {"a": "1.0.0"}}"#);
        write(d.path(), "package-lock.json", "{ not json");
        let s = detect(d.path()).unwrap();
        assert_eq!(s.unreadable, 1);
        assert!(s.notes.iter().any(|n| n.starts_with("package-lock.json: could not be read in full (not valid JSON)")), "{:?}", s.notes);
    }

    fn write(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn a_registry_package_is_public_beside_a_local_manifest_of_the_same_name() {
        // Kong/insomnia: `send-request/electron/package.json` is a local stub named `electron`; the app declares
        // `electron: 43.2.0`, which package-lock.json fetches from the registry.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true,"workspaces":["packages/*"]}"#);
        write(d.path(), "packages/app/package.json", r#"{"name":"app","private":true,"devDependencies":{"electron":"43.2.0","shared":"1.0.0"}}"#);
        write(d.path(), "packages/app/stub/electron/package.json", r#"{"name":"electron","main":"index.js"}"#);
        write(d.path(), "packages/shared/package.json", r#"{"name":"shared","version":"1.0.0"}"#);
        write(d.path(), "package-lock.json", r#"{"lockfileVersion":3,"packages":{"":{"name":"root"},
            "packages/app":{"name":"app"},"packages/shared":{"name":"shared","version":"1.0.0"},
            "node_modules/shared":{"resolved":"packages/shared","link":true},
            "node_modules/electron":{"version":"43.2.0","resolved":"https://registry.npmjs.org/electron/-/electron-43.2.0.tgz","integrity":"sha512-abc"}}}"#);
        let s = detect(d.path()).unwrap();
        let e = &s.deps["pkg:npm/electron"];
        assert!(e.public_candidate, "fetched from the registry");
        assert_eq!(e.version.as_ref().map(ToString::to_string).as_deref(), Some("43.2.0"));
        assert!(!s.deps["pkg:npm/shared"].public_candidate, "a workspace link stays local");
    }

    #[test]
    fn git_path_and_other_registry_ranges_are_never_public() {
        // No lockfile to say where each came from: the range alone must keep these private names from being named.
        let d = tempfile::tempdir().unwrap();
        let sources = [
            "corp/billing#v2", "corp/billing", "git@git.corp.example:team/a.git", "ssh://git@git.corp.example/team/b.git",
            "gitlab:corp/c", "bitbucket:corp/d", "gist:11081aaa", "portal:../e", "exec:./gen.js", "/srv/pkgs/f",
            "~/pkgs/g", "vendor\\h", "corp-i-1.0.0.tgz", "jsr:^1.0.0", "file:../j", "github:corp/k#main", ".", "..",
            "C:pkgs", "patch:corp-l@git+ssh%3A//git.corp.example/l.git#./l.patch", "patch:corp-m@file%3A../m#./m.patch",
            "patch:@corp/n@https%3A//pkgs.corp.example/n.tgz%23sha#~/.yarn/patches/n.patch",
        ];
        let deps: Vec<String> = sources.iter().enumerate().map(|(i, s)| format!("\"corp-{i}\":{}", serde_json::to_string(s).unwrap())).collect();
        write(d.path(), "package.json", &format!(r#"{{"name":"lib","version":"1.0.0","dependencies":{{"left-pad":"^1.3.0","bar":"npm:@scope/bar@^2","next":"canary","react":"latest","qux":"npm:qux@1","lodash":"patch:lodash@npm%3A4.17.21#./x.patch",{}}}}}"#, deps.join(",")));
        let s = detect(d.path()).unwrap();
        for (i, src) in sources.iter().enumerate() {
            assert!(!s.deps[&format!("pkg:npm/corp-{i}")].public_candidate, "{src}");
        }
        assert!(s.deps["pkg:npm/left-pad"].public_candidate);
        assert!(s.deps["pkg:npm/%40scope/bar"].public_candidate, "an alias names a registry package");
        assert!(s.deps["pkg:npm/next"].public_candidate, "a dist-tag is a registry version");
        assert!(s.deps["pkg:npm/react"].public_candidate);
        assert!(s.deps["pkg:npm/qux"].public_candidate);
        assert!(s.deps["pkg:npm/lodash"].public_candidate, "a patch of a registry version names the public package");
    }

    #[test]
    fn application_reads_pnpm_lock_and_engines() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"app","private":true,"engines":{"node":">=20.9"},
            "dependencies":{"next":"^16.0.0","@prisma/client":"^6.19.0"},"devDependencies":{"prisma":"^6.19.0"}}"#);
        write(d.path(), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '@prisma/client':\n        specifier: ^6.19.0\n        version: 6.19.3(prisma@6.19.3)(typescript@5.9.2)\n      next:\n        specifier: ^16.0.0\n        version: 16.0.7(react-dom@19.2.0)(react@19.2.0)\n    devDependencies:\n      prisma:\n        specifier: ^6.19.0\n        version: 6.19.3(typescript@5.9.2)\n\npackages:\n\n  next@16.0.7:\n    resolution: {integrity: x}\n");
        write(d.path(), "node_modules/next/package.json", r#"{"name":"next","version":"16.0.7","dependencies":{"react":"^19"}}"#);
        let s = detect(d.path()).unwrap();
        assert_eq!(s.packages.len(), 1, "node_modules is skipped");
        assert_eq!(s.packages[0].kind, Kind::Application);
        assert_eq!(s.deps["pkg:npm/next"].version, Some(Version::new(16, 0, 7)));
        assert_eq!(s.deps["pkg:npm/%40prisma/client"].version, Some(Version::new(6, 19, 3)));
        assert_eq!(s.deps["pkg:npm/prisma"].source, "pnpm-lock.yaml");
        assert_eq!(s.node.as_ref().unwrap().0, Version::new(20, 9, 0));
        assert!(s.candidates().contains("prisma") && s.candidates().contains("next") && s.candidates().contains("client"));
    }

    /// react/react: `compiler/apps/playground` (its own yarn.lock, no engines) was checked against the root's floor,
    /// `packages/react`'s published `engines >=0.10.0`, though `.nvmrc` says v20.19.0. Each lockfile root has its
    /// own floor: its manifests' engines, else the nearest toolchain file.
    #[test]
    fn a_lockfile_root_has_its_own_node_floor() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), ".nvmrc", "v20.19.0\n");
        write(d.path(), "package.json", r#"{"name":"root","private":true,"workspaces":["packages/*"],"devDependencies":{"left-pad":"^1.0.0"}}"#);
        write(d.path(), "packages/react/package.json", r#"{"name":"react","version":"19.0.0","engines":{"node":">=0.10.0"},"dependencies":{"left-pad":"^1.0.0"}}"#);
        write(d.path(), "yarn.lock", "# yarn lockfile v1\n\nleft-pad@^1.0.0:\n  version \"1.3.0\"\n");
        write(d.path(), "apps/play/package.json", r#"{"name":"play","private":true,"dependencies":{"next":"^15.0.0"}}"#);
        write(d.path(), "apps/play/yarn.lock", "# yarn lockfile v1\n\nnext@^15.0.0:\n  version \"15.5.9\"\n");
        let s = detect(d.path()).unwrap();
        assert_eq!(s.node.as_ref().unwrap().0, Version::new(0, 10, 0));
        assert_eq!(s.node_by_lock["yarn.lock"].0, Version::new(0, 10, 0));
        assert_eq!(s.node_by_lock["apps/play/yarn.lock"], (Version::new(20, 19, 0), ".nvmrc".to_string()));
        let lock = s.deps["pkg:npm/next"].headline().and_then(|r| r.lock.clone());
        assert_eq!(lock.as_deref(), Some("apps/play/yarn.lock"));
        assert_eq!(s.npm_version_in("node", lock.as_deref()), Some(&Version::new(20, 19, 0)));
    }

    #[test]
    fn the_root_resolution_wins_over_a_nested_library_floor_and_a_side_lockfile() {
        // Kibana's shape: the root locks react 18.2.0 and axios 1.20.0; a nested published package declares a peer
        // range `^17`; a CI workspace keeps its own lockfile with axios 1.18.0.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"kibana","version":"9.0.0","private":true,"dependencies":{"react":"18.2.0","axios":"1.20.0"}}"#);
        write(d.path(), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      axios:\n        specifier: 1.20.0\n        version: 1.20.0\n      react:\n        specifier: 18.2.0\n        version: 18.2.0\n");
        write(d.path(), "src/plugins/console/packaging/package.json", r#"{"name":"@kbn/console","version":"1.0.0","main":"index.js","peerDependencies":{"react":"^17"}}"#);
        write(d.path(), ".buildkite/package.json", r#"{"name":"ci","private":true,"dependencies":{"axios":"^1.18.0"}}"#);
        write(d.path(), ".buildkite/package-lock.json", r#"{"lockfileVersion":3,"packages":{"node_modules/axios":{"version":"1.18.0"}}}"#);
        let s = detect(d.path()).unwrap();
        let (react, axios) = (&s.deps["pkg:npm/react"], &s.deps["pkg:npm/axios"]);
        assert_eq!(react.version, Some(Version::new(18, 2, 0)));
        assert_eq!(react.source, "pnpm-lock.yaml in the root");
        assert_eq!(axios.version, Some(Version::new(1, 20, 0)));
        let others: Vec<(String, Vec<(&str, &str)>)> =
            axios.others().into_iter().map(|(v, rs)| (v.to_string(), rs.iter().map(|r| (r.dir.as_str(), r.source.as_str())).collect())).collect();
        assert_eq!(others, vec![("1.18.0".to_string(), vec![(".buildkite", ".buildkite/package-lock.json")])]);
        assert_eq!(react.others()[0].1[0].source, "library floor of ^17");
        let note = s.notes.iter().find(|n| n.contains("different versions across manifests")).expect("a note");
        assert!(note.starts_with("2 packages are") && note.contains("axios 1.20.0 (pnpm-lock.yaml in the root) and 1.18.0 in .buildkite"), "{note}");
    }

    #[test]
    fn manifests_outside_the_workspace_are_separate_unlocked_projects() {
        // supabase's shape: pnpm workspace `apps/*`, root engines >=22.13, sample apps under `examples/` with no
        // lockfile; one declares an older next, a newer eslint and a lower Node floor.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true,"engines":{"node":">=22.13"},"devDependencies":{"eslint":"^9.0.0"}}"#);
        write(d.path(), "pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - \"!apps/legacy\" # retired\n\ncatalog:\n  next: ^16.3.6\n");
        write(d.path(), "apps/www/package.json", r#"{"name":"www","private":true,"dependencies":{"next":"catalog:"}}"#);
        write(d.path(), "apps/docs/package.json", r#"{"name":"docs","private":true,"dependencies":{"next":"^15.5.0"}}"#);
        write(d.path(), "apps/legacy/package.json", r#"{"name":"legacy","private":true,"dependencies":{"next":"^14.0.0"}}"#);
        write(d.path(), "examples/clerk/package.json", r#"{"name":"clerk","private":true,"engines":{"node":">=20.0.0"},"dependencies":{"next":"15.3.1","eslint":"^10.0.0"}}"#);
        write(d.path(), "examples/index-only/package.json", r#"{"main":"index.js"}"#);
        write(d.path(), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      eslint:\n        specifier: ^9.0.0\n        version: 9.37.0\n\n  apps/docs:\n    dependencies:\n      next:\n        specifier: ^15.5.0\n        version: 15.5.25(react@19.0.0)\n\n  apps/www:\n    dependencies:\n      next:\n        specifier: 'catalog:'\n        version: 16.3.6(react@19.0.0)\n");
        let s = detect(d.path()).unwrap();
        let next = &s.deps["pkg:npm/next"];
        assert_eq!(next.version, Some(Version::new(15, 5, 25)), "a locked member beats an unlocked floor at the same depth");
        assert_eq!(next.source, "pnpm-lock.yaml in apps/docs");
        let clerk = next.readings.iter().find(|r| r.dir == "examples/clerk").unwrap();
        assert!(clerk.standalone);
        assert_eq!(clerk.source, "floor of 15.3.1 (outside the pnpm-lock.yaml workspace)");
        let legacy = next.readings.iter().find(|r| r.dir == "apps/legacy").unwrap();
        assert!(legacy.standalone, "a negated glob excludes the member");
        assert!(!s.notes.iter().any(|n| n.contains("out of date")), "{:?}", s.notes);
        assert_eq!(s.deps["pkg:npm/eslint"].version, Some(Version::new(9, 37, 0)));
        assert_eq!(s.node, Some((Version::new(22, 13, 0), "engines.node >=22.13 in package.json".into())));
        assert_eq!(s.packages.iter().find(|p| p.dir == "examples/clerk").unwrap().lockfile, None);
        assert_eq!(s.standalone.len(), 1, "{:?}", s.standalone);
        assert!(s.standalone[0].starts_with("2 manifests are outside the pnpm-lock.yaml workspace and have no lockfile of their own (apps/legacy, examples/clerk)"), "{}", s.standalone[0]);
    }

    #[test]
    fn standalone_manifests_set_versions_and_node_only_when_nothing_is_locked() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "examples/a/package.json", r#"{"name":"a","private":true,"engines":{"node":">=20"},"dependencies":{"next":"^15.0.0"}}"#);
        write(d.path(), "examples/b/package.json", r#"{"name":"b","private":true,"engines":{"node":">=18"},"dependencies":{"next":"^16.0.0"}}"#);
        let s = detect(d.path()).unwrap();
        assert_eq!(s.deps["pkg:npm/next"].version, Some(Version::new(15, 0, 0)));
        assert_eq!(s.deps["pkg:npm/next"].source, "floor of ^15.0.0 (not in a lockfile) in examples/a");
        assert_eq!(s.node.as_ref().unwrap().0, Version::new(18, 0, 0));
        assert!(s.standalone.is_empty(), "no lockfile to be outside of");
    }

    #[test]
    fn workspace_members_by_package_json_globs_and_lockfile_importers() {
        // npm: `workspaces` with a negation; the lockfile also lists a member the globs miss.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true,"workspaces":["./packages/**","!**/fixtures/**"]}"#);
        write(d.path(), "packages/ui/package.json", r#"{"name":"ui","private":true,"dependencies":{"react":"^18.0.0"}}"#);
        write(d.path(), "packages/ui/test/fixtures/app/package.json", r#"{"name":"fx","private":true,"dependencies":{"react":"^17.0.0"}}"#);
        write(d.path(), "tools/scripts/gen/package.json", r#"{"name":"gen","private":true,"dependencies":{"react":"^16.0.0"}}"#);
        write(d.path(), "package-lock.json", r#"{"lockfileVersion":3,"packages":{"":{"name":"root"},"packages/ui":{"name":"ui"},"tools/scripts/gen":{"name":"gen"},
            "node_modules/react":{"version":"18.3.1"},"tools/scripts/gen/node_modules/react":{"version":"16.14.0"}}}"#);
        let s = detect(d.path()).unwrap();
        let react = &s.deps["pkg:npm/react"];
        let by_dir = |dir: &str| react.readings.iter().find(|r| r.dir == dir).unwrap();
        assert_eq!((by_dir("packages/ui").version.to_string(), by_dir("packages/ui").standalone), ("18.3.1".into(), false));
        assert_eq!((by_dir("tools/scripts/gen").version.to_string(), by_dir("tools/scripts/gen").standalone), ("16.14.0".into(), false), "listed by the lockfile");
        let fx = by_dir("packages/ui/test/fixtures/app");
        assert!(fx.standalone && fx.version == Version::new(17, 0, 0), "{fx:?}");
        assert_eq!(react.version, Some(Version::new(18, 3, 1)));
        assert!(!s.notes.iter().any(|n| n.contains("out of date")), "{:?}", s.notes);
        // Yarn's `{"packages": [...]}` form and pnpm's flow list.
        assert!(pnpm_workspace_packages("packages: ['apps/*', \"e2e/*\"]\nonlyBuilt: x\n") == vec!["apps/*", "e2e/*"]);
        assert!(pnpm_workspace_packages("packages: [\n  'apps/*', # web\n  packages/*\n]\ncatalog:\n  a: 1\n") == vec!["apps/*", "packages/*"]);
        assert!(pnpm_workspace_packages("packages:\n  - apps/*\n  - '.config/*'\n") == vec!["apps/*", ".config/*"]);
        let dots = tempfile::tempdir().unwrap();
        write(dots.path(), "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n  - .config/*\n");
        let m = Members::read(dots.path(), "pnpm-lock.yaml");
        assert!(m.contains("packages/ui") && !m.contains("packages/.hidden") && m.contains(".config/lint"), "a wildcard skips dot names");
        let y = tempfile::tempdir().unwrap();
        write(y.path(), "package.json", r#"{"workspaces":{"packages":["libs/*"],"nohoist":["**/x"]}}"#);
        let m = Members::read(y.path(), "yarn.lock");
        assert!(m.contains("libs/a") && !m.contains("libs/a/b") && !m.contains("examples/a"));
    }

    #[test]
    fn manifests_at_the_same_depth_keep_the_lowest() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "apps/web/package.json", r#"{"name":"web","private":true,"dependencies":{"react":"^19.1.0"}}"#);
        write(d.path(), "packages/ui/package.json", r#"{"name":"ui","version":"1.0.0","main":"x.js","peerDependencies":{"react":"^18.3.0"}}"#);
        let s = detect(d.path()).unwrap();
        assert_eq!(s.deps["pkg:npm/react"].version, Some(Version::new(18, 3, 0)));
    }

    #[test]
    fn yarn_workspace_entries_are_not_a_stale_lockfile() {
        // Yarn 2+ records each workspace as `0.0.0-use.local`; a workspace depending on another by range is not stale.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"grafana","private":true,"workspaces":["packages/*"],"dependencies":{"lodash":"^4.17.23"}}"#);
        write(d.path(), "packages/data/package.json", r#"{"name":"@grafana/data","private":true,"version":"13.3.0-pre"}"#);
        write(d.path(), "packages/compat/package.json", r#"{"name":"compat","private":true,"dependencies":{"@grafana/data":">=12.0.0"}}"#);
        write(d.path(), "yarn.lock", "__metadata:\n  version: 8\n\n\"@grafana/data@npm:>=12.0.0, @grafana/data@workspace:packages/data\":\n  version: 0.0.0-use.local\n  resolution: \"@grafana/data@workspace:packages/data\"\n\n\"lodash@npm:^4.17.23\":\n  version: 4.18.1\n  resolution: \"lodash@npm:4.18.1\"\n");
        let s = detect(d.path()).unwrap();
        assert!(!s.notes.iter().any(|n| n.contains("out of date")), "{:?}", s.notes);
        assert_eq!(s.deps["pkg:npm/lodash"].version, Some(Version::new(4, 18, 1)));
        assert!(!s.deps["pkg:npm/%40grafana/data"].public_candidate);
    }

    #[test]
    fn root_resolutions_are_not_a_stale_lockfile() {
        // wp-calypso's shape: root `resolutions` force react 19.2.7 and @wordpress/components ^37 everywhere; a
        // workspace still declares ^28 and a peer range ^18.2.0, and yarn.lock has only the forced entries.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"calypso","private":true,"workspaces":["apps/*","packages/*"],
            "dependencies":{"react":"19.2.7","@types/wordpress__block-editor":"^11.5.16"},
            "resolutions":{"react":"19.2.7","**/react-dom":"19.2.7","@wordpress/components@npm:^28.0.0":"^37.0.0",
                "@types/wordpress__block-editor":"npm:noop-package@1.0.0","jest-environment-jsdom/jsdom":"^20.0.3",
                "@wordpress/element":"patch:@wordpress/element@npm%3A8.0.0#~/.yarn/patches/x.patch"}}"#);
        write(d.path(), "apps/agents/package.json", r#"{"name":"agents","private":true,
            "dependencies":{"@wordpress/components":"^28.23.0","@wordpress/element":"^7.0.0","jsdom":"^16.0.0"},
            "peerDependencies":{"react":"^18.2.0","react-dom":"^18.2.0"}}"#);
        write(d.path(), "packages/ui/package.json", r#"{"name":"ui","private":true,"devDependencies":{"react":"^18.3.1","react-dom":"^18.3.1"}}"#);
        write(d.path(), "yarn.lock", "__metadata:\n  version: 8\n\n\"react@npm:19.2.7\":\n  version: 19.2.7\n  resolution: \"react@npm:19.2.7\"\n\n\"react-dom@npm:19.2.7\":\n  version: 19.2.7\n  resolution: \"react-dom@npm:19.2.7\"\n\n\"@wordpress/components@npm:^37.0.0\":\n  version: 37.0.0\n  resolution: \"@wordpress/components@npm:37.0.0\"\n\n\"@wordpress/element@patch:@wordpress/element@npm%3A8.0.0#~/.yarn/patches/x.patch\":\n  version: 8.0.0\n  resolution: \"@wordpress/element@patch:x\"\n\n\"@types/wordpress__block-editor@npm:noop-package@1.0.0\":\n  version: 1.0.0\n  resolution: \"noop-package@npm:1.0.0\"\n\n\"jsdom@npm:^20.0.3\":\n  version: 20.0.3\n  resolution: \"jsdom@npm:20.0.3\"\n");
        let s = detect(d.path()).unwrap();
        let react = &s.deps["pkg:npm/react"];
        assert_eq!(react.version, Some(Version::new(19, 2, 7)));
        assert!(react.readings.iter().all(|r| r.version == Version::new(19, 2, 7)), "{react:?}");
        assert_eq!(react.readings.iter().find(|r| r.dir == "packages/ui").unwrap().source, "yarn.lock (resolutions)");
        assert!(s.deps["pkg:npm/react-dom"].readings.iter().all(|r| r.version == Version::new(19, 2, 7)), "`**/` applies everywhere");
        let components = &s.deps["pkg:npm/%40wordpress/components"];
        assert_eq!((components.version.clone(), components.source.as_str()), (Some(Version::new(37, 0, 0)), "yarn.lock (resolutions)"));
        assert_eq!(s.deps["pkg:npm/%40wordpress/element"].version, Some(Version::new(8, 0, 0)), "a patch override admits the pin");
        let replaced = &s.deps["pkg:npm/%40types/wordpress__block-editor"];
        assert_eq!((replaced.version.clone(), replaced.source.as_str()), (None, "replaced by noop-package (resolutions)"));
        // A resolution under a parent (`jest-environment-jsdom/jsdom`) does not set a workspace's own jsdom.
        assert_eq!(s.notes.len(), 1, "{:?}", s.notes);
        assert!(s.notes[0].starts_with("yarn.lock: 1 locked version falls outside") && s.notes[0].contains("jsdom 20.0.3 vs ^16.0.0"), "{}", s.notes[0]);
        assert_eq!(s.spread, 0);
    }

    #[test]
    fn equally_shallow_manifests_take_the_version_most_of_them_run() {
        // supabase's shape: seven apps lock next 16.3.6 through the catalog, two lock 15.5.25; nothing at the root.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true}"#);
        write(d.path(), "pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n");
        let mut lock = String::from("lockfileVersion: '9.0'\n\nimporters:\n\n");
        for (app, v) in [("docs", "15.5.25"), ("www", "15.5.25"), ("studio", "16.3.6"), ("learn", "16.3.6"), ("ui", "16.3.6")] {
            write(d.path(), &format!("apps/{app}/package.json"), &format!(r#"{{"name":"{app}","private":true,"dependencies":{{"next":"^{v}"}}}}"#));
            lock += &format!("  apps/{app}:\n    dependencies:\n      next:\n        specifier: ^{v}\n        version: {v}\n\n");
        }
        write(d.path(), "pnpm-lock.yaml", &lock);
        let s = detect(d.path()).unwrap();
        let next = &s.deps["pkg:npm/next"];
        assert_eq!(next.version, Some(Version::new(16, 3, 6)), "{next:?}");
        assert_eq!(next.source, "pnpm-lock.yaml in apps/learn");
        assert_eq!(next.others()[0].1.iter().map(|r| r.dir.as_str()).collect::<Vec<_>>(), ["apps/docs", "apps/www"]);
        // Even split: the lowest, as before.
        let one = |dirs: &[(&str, &str)]| {
            let mut d = Dep::new("x", true);
            for (dir, v) in dirs { d.read(dir, Some(Version::parse(v).unwrap()), "lock".into()); }
            d.headline().unwrap().version.to_string()
        };
        assert_eq!(one(&[("a", "2.0.0"), ("b", "1.0.0")]), "1.0.0");
        assert_eq!(one(&[("a", "2.0.0"), ("b", "1.0.0"), ("c", "2.0.0"), ("x/deep", "1.0.0"), ("x/deeper", "1.0.0")]), "2.0.0", "depth first, then the majority");
        assert_eq!(one(&[(".", "1.0.0"), ("a", "2.0.0"), ("b", "2.0.0")]), "1.0.0", "the root still leads");
    }

    #[test]
    fn a_root_override_sets_a_library_dependency_too() {
        // n8n's shape: the published cli package pins ws 8.20.1; the workspace overrides `ws: '>=8.21.1'` and the
        // lockfile installs 8.21.1 for it. The floor 8.20.1 would report an advisory the install no longer has.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true}"#);
        write(d.path(), "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n\noverrides:\n  ws: '>=8.21.1'\n");
        write(d.path(), "packages/cli/package.json", r#"{"name":"n8n","version":"2.0.0","bin":{"n8n":"bin/n8n"},"dependencies":{"ws":"8.20.1"}}"#);
        write(d.path(), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n\noverrides:\n  ws: '>=8.21.1'\n\nimporters:\n\n  packages/cli:\n    dependencies:\n      ws:\n        specifier: '>=8.21.1'\n        version: 8.21.1(bufferutil@4.0.9)\n");
        let s = detect(d.path()).unwrap();
        let ws = &s.deps["pkg:npm/ws"];
        assert_eq!(ws.version, Some(Version::new(8, 21, 1)), "{ws:?}");
        assert!(ws.source.contains("overrides"), "{}", ws.source);
        assert!(s.notes.is_empty(), "{:?}", s.notes);
    }

    #[test]
    fn a_peer_range_alone_never_makes_a_lockfile_stale() {
        // An application workspace's peer range says what it supports; the root's install is what runs.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true,"workspaces":["apps/*"],"dependencies":{"react":"^19.2.0"}}"#);
        write(d.path(), "apps/help/package.json", r#"{"name":"help","private":true,"peerDependencies":{"react":"^18.2.0"}}"#);
        write(d.path(), "yarn.lock", "__metadata:\n  version: 8\n\n\"react@npm:^19.2.0\":\n  version: 19.2.7\n  resolution: \"react@npm:19.2.7\"\n");
        let s = detect(d.path()).unwrap();
        let react = &s.deps["pkg:npm/react"];
        assert!(react.readings.iter().all(|r| r.version == Version::new(19, 2, 7) && r.source == "yarn.lock"), "{react:?}");
        assert!(s.notes.is_empty(), "{:?}", s.notes);
    }

    #[test]
    fn npm_and_pnpm_overrides_count_as_declared() {
        // npm `overrides`: plain, `name@range` and the `.` of a nested object set a package everywhere; a nested
        // child does not.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true,"workspaces":["web"],"dependencies":{"foo":"^2.0.0"},
            "overrides":{"foo":"$foo","bar@^1":"2.1.0","baz":{".":"3.0.0","qux":"1.0.0"}},"resolutions":{"qux":"9.9.9"}}"#);
        write(d.path(), "web/package.json", r#"{"name":"web","private":true,"dependencies":{"foo":"^1.0.0","bar":"^1.0.0","baz":"^2.0.0","qux":"^0.5.0"}}"#);
        write(d.path(), "package-lock.json", r#"{"lockfileVersion":3,"packages":{"node_modules/foo":{"version":"2.0.1"},"node_modules/bar":{"version":"2.1.0"},"node_modules/baz":{"version":"3.0.0"},"node_modules/qux":{"version":"1.0.0"}}}"#);
        let s = detect(d.path()).unwrap();
        for (n, v) in [("foo", Version::new(2, 0, 1)), ("bar", Version::new(2, 1, 0)), ("baz", Version::new(3, 0, 0))] {
            assert_eq!(s.deps[&format!("pkg:npm/{n}")].version, Some(v), "{n}");
        }
        assert_eq!(s.notes.len(), 1, "npm ignores Yarn's `resolutions`: {:?}", s.notes);
        assert!(s.notes[0].contains("qux 1.0.0 vs ^0.5.0"), "{}", s.notes[0]);
        // pnpm: `pnpm.overrides` and the workspace file's `overrides`; `parent>child` applies under a parent only.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true,"pnpm":{"overrides":{"next":"16.4.1","a>zod":"4.0.0"}}}"#);
        write(d.path(), "pnpm-workspace.yaml", "packages:\n  - web\noverrides:\n  '@types/react': ^19.0.0 # all workspaces\n");
        write(d.path(), "web/package.json", r#"{"name":"web","private":true,"dependencies":{"next":"^15.0.0","@types/react":"^18.3.0","zod":"^3.0.0"}}"#);
        write(d.path(), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n\noverrides:\n  next: 16.4.1\n\nimporters:\n\n  web:\n    dependencies:\n      '@types/react':\n        specifier: ^19.0.0\n        version: 19.2.3\n      next:\n        specifier: 16.4.1\n        version: 16.4.1(react@19.2.0)\n      zod:\n        specifier: ^3.0.0\n        version: 4.0.0\n");
        let s = detect(d.path()).unwrap();
        assert_eq!(s.deps["pkg:npm/next"].version, Some(Version::new(16, 4, 1)));
        assert_eq!(s.deps["pkg:npm/next"].source, "pnpm-lock.yaml (pnpm.overrides)");
        assert_eq!(s.deps["pkg:npm/%40types/react"].source, "pnpm-lock.yaml (pnpm-workspace.yaml overrides)");
        assert_eq!(s.notes.len(), 1, "{:?}", s.notes);
        assert!(s.notes[0].contains("zod 4.0.0 vs ^3.0.0"), "{}", s.notes[0]);
    }

    #[test]
    fn a_selector_version_limits_the_override_and_an_alias_replaces_even_in_range() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true,"workspaces":["a","b"],
            "resolutions":{"react@^18":"19.2.7","foo":"npm:bar@1.2.0"}}"#);
        write(d.path(), "a/package.json", r#"{"name":"a","private":true,"dependencies":{"react":"^18.2.0","foo":"^1.0.0"}}"#);
        write(d.path(), "b/package.json", r#"{"name":"b","private":true,"dependencies":{"react":"^16.0.0"}}"#);
        write(d.path(), "yarn.lock", "__metadata:\n  version: 8\n\n\"react@npm:19.2.7\":\n  version: 19.2.7\n  resolution: \"react@npm:19.2.7\"\n\n\"foo@npm:bar@1.2.0\":\n  version: 1.2.0\n  resolution: \"bar@npm:1.2.0\"\n");
        let s = detect(d.path()).unwrap();
        let react = &s.deps["pkg:npm/react"];
        assert_eq!(react.readings.iter().find(|r| r.dir == "a").unwrap().version, Version::new(19, 2, 7));
        assert_eq!(react.readings.iter().find(|r| r.dir == "b").unwrap().version, Version::new(16, 0, 0), "`react@^18` does not set ^16");
        assert!(s.notes.iter().any(|n| n.contains("react 19.2.7 vs ^16.0.0")), "{:?}", s.notes);
        assert_eq!(s.deps["pkg:npm/foo"].source, "replaced by bar (resolutions)", "an in-range pin of another package");
    }

    #[test]
    fn a_pnpm_workspace_with_no_lockfile_reads_overrides_and_fresh_ranges_not_installed_floors() {
        // lobehub: `lockfile: false`, `resolutionMode: highest`, `'zod@^4': 4.6.5`; the root looks published.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "pnpm-workspace.yaml", "lockfile: false\nresolutionMode: highest\npackages:\n  - packages/*\noverrides:\n  'zod@^4': 4.6.5\n  drizzle-orm: ^0.45.2\n");
        write(d.path(), "package.json", r#"{"name":"@acme/app","version":"2.2.20","publishConfig":{"access":"public"},
            "dependencies":{"zod":"^4.4.3","next":"~16.3.8","drizzle-orm":"^0.45.0","@acme/a":"workspace:*"}}"#);
        write(d.path(), "packages/a/package.json", r#"{"name":"@acme/a","private":true,"dependencies":{"zod":"^3.25.0"}}"#);
        // An unlocked workspace no manifest belongs to is not named.
        write(d.path(), "tools/x/pnpm-workspace.yaml", "lockfile: false\npackages:\n  - pkgs/*\n");
        write(d.path(), "tools/x/other/package.json", r#"{"name":"other","private":true,"dependencies":{"left-pad":"^1.0.0"}}"#);
        let mut s = detect(d.path()).unwrap();
        assert_eq!(s.unlocked, vec!["pnpm-workspace.yaml".to_string()]);
        let zod = &s.deps["pkg:npm/zod"];
        let root = zod.readings.iter().find(|r| r.dir == ".").unwrap();
        assert_eq!(root.version, Version::new(4, 6, 5), "the override sets every zod 4: {zod:?}");
        assert!(root.source.starts_with("pnpm-workspace.yaml overrides sets 4.6.5"), "{}", root.source);
        let a = zod.readings.iter().find(|r| r.dir == "packages/a").unwrap();
        assert_eq!(a.version, Version::new(3, 25, 0), "`zod@^4` does not set zod 3");
        assert!(!root.standalone && !a.standalone, "a workspace member, not a separate project");
        assert!(s.deps.values().flat_map(|d| &d.readings).all(|r| !r.source.contains("library floor")), "{:?}", s.deps);
        assert!(s.deps["pkg:npm/next"].unpinned.contains(&(".".into(), "~16.3.8".into())));
        assert!(s.deps["pkg:npm/drizzle-orm"].unpinned.contains(&(".".into(), "^0.45.2".into())), "a range override is what it resolves in");
        assert!(!s.deps["pkg:npm/zod"].unpinned.contains(&(".".into(), "4.6.5".into())), "an exact override is no fresh range");
        // `detect` reads no registry in tests; the releases a fresh install chooses from:
        let releases = |purls: &[String]| {
            let vs = |p: &str| -> Vec<Version> {
                let l: &[&str] = match p {
                    "pkg:npm/next" => &["16.3.8", "16.3.12", "16.4.3"],
                    "pkg:npm/drizzle-orm" => &["0.45.0", "0.45.2", "0.45.9"],
                    "pkg:npm/zod" => &["3.25.0", "3.25.76", "4.6.5", "4.6.6"],
                    _ => &[],
                };
                l.iter().filter_map(|v| parse_version(v)).collect()
            };
            purls.iter().map(|p| (p.clone(), vs(p))).collect()
        };
        crate::pypi::assume_newest_in(&NPM_FRESH, &mut s.deps, &mut s.notes, releases, crate::pypi::no_requires);
        let at = |purl: &str, dir: &str| s.deps[purl].readings.iter().find(|r| r.dir == dir).unwrap().version.clone();
        assert_eq!(at("pkg:npm/next", "."), Version::new(16, 3, 12), "the newest release `~16.3.8` admits");
        assert_eq!(at("pkg:npm/drizzle-orm", "."), Version::new(0, 45, 9));
        assert_eq!(at("pkg:npm/zod", "."), Version::new(4, 6, 5), "the override stays");
        assert_eq!(at("pkg:npm/zod", "packages/a"), Version::new(3, 25, 76));
        assert!(s.notes.iter().any(|n| n.contains(UNLOCKED_NPM) && n.contains("newest release on npm")), "{:?}", s.notes);
    }

    #[test]
    fn a_range_scoped_override_sets_only_the_versions_its_range_admits() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "pnpm-workspace.yaml", "overrides:\n  'zod@^4': 4.6.5\n  vitest: 5.0.0\n");
        write(d.path(), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
        let l = Lock::read_all(d.path()).pop().unwrap();
        assert!(l.override_values("zod", &Version::new(3, 25, 76)).is_empty(), "zod 3 is not what `zod@^4` sets");
        assert_eq!(l.override_values("zod", &Version::new(4, 4, 3)), vec![("4.6.5".into(), "pnpm-workspace.yaml overrides")]);
        assert_eq!(l.override_values("vitest", &Version::new(4, 0, 0)).len(), 1, "an unscoped override sets every version");
    }

    #[test]
    fn override_selectors_name_the_package_they_set_everywhere() {
        for (sel, want) in [
            ("react", Some(("react", None))),
            ("**/react", Some(("react", None))),
            ("react@^18", Some(("react", Some("^18")))),
            ("@babel/core@npm:7.25.7", Some(("@babel/core", Some("npm:7.25.7")))),
            ("@types/react", Some(("@types/react", None))),
            ("jest-environment-jsdom/jsdom", None),
            ("keytar@npm:7.7.0/node-addon-api", None),
            ("@scope/parent/child", None),
            ("a>b", None),
            ("@scope", None),
            ("", None),
        ] {
            assert_eq!(override_target(sel), want, "{sel}");
        }
    }

    #[test]
    fn lockfiles_pin_versions_with_their_sha512_integrity() {
        let pin = |v: &str, h: &str| Pin { version: v.into(), hashes: vec![h.into()] };
        let npm = parse_npm(r#"{"lockfileVersion":3,"packages":{"node_modules/next":{"version":"16.0.7","integrity":"sha512-AAA"},"node_modules/old":{"version":"1.0.0","integrity":"sha1-BBB"}}}"#);
        assert_eq!(npm.pin("next", &Version::new(16, 0, 7)), Some(pin("16.0.7", "sha512-AAA")));
        assert_eq!(npm.pin("old", &Version::new(1, 0, 0)), None, "sha1 only: no pin, the name check applies");
        let pnpm = parse_pnpm("lockfileVersion: '9.0'\n\npackages:\n\n  '@prisma/client@6.19.3':\n    resolution: {integrity: sha512-CCC}\n\n  next@16.0.7(react@19.2.0):\n    resolution:\n      integrity: sha512-DDD\n");
        assert_eq!(pnpm.pin("@prisma/client", &Version::new(6, 19, 3)), Some(pin("6.19.3", "sha512-CCC")));
        assert_eq!(pnpm.pin("next", &Version::new(16, 0, 7)), Some(pin("16.0.7", "sha512-DDD")));
        let v5 = parse_pnpm("lockfileVersion: 5.4\n\npackages:\n\n  /@scope/pkg/2.1.0:\n    resolution: {integrity: sha512-EEE}\n");
        assert_eq!(v5.pin("@scope/pkg", &Version::new(2, 1, 0)), Some(pin("2.1.0", "sha512-EEE")));
        let yarn = parse_yarn("acme-utils@^1.2.0:\n  version \"1.2.0\"\n  resolved \"https://npm.acme.internal/acme-utils/-/acme-utils-1.2.0.tgz\"\n  integrity sha512-FFF\n");
        assert_eq!(yarn.pin("acme-utils", &Version::new(1, 2, 0)), Some(pin("1.2.0", "sha512-FFF")));
    }

    #[test]
    fn a_dependency_carries_the_pins_of_its_lockfile() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"app","private":true,"dependencies":{"acme-utils":"^1.2.0","next":"^16.0.0"}}"#);
        write(d.path(), "package-lock.json", r#"{"lockfileVersion":3,"packages":{"node_modules/acme-utils":{"version":"1.2.0","integrity":"sha512-internal"},"node_modules/next":{"version":"16.0.7"}}}"#);
        let s = detect(d.path()).unwrap();
        assert_eq!(s.deps["pkg:npm/acme-utils"].pins, vec![Pin { version: "1.2.0".into(), hashes: vec!["sha512-internal".into()] }]);
        assert!(s.deps["pkg:npm/next"].pins.is_empty(), "no integrity in the lockfile");
    }

    #[test]
    fn a_named_catalog_npm_alias_is_its_own_package_and_a_parallel_copy() {
        // ComposioHQ/composio: the root runs typescript 7.0.2 and keeps TypeScript 6 as `typescript6` from the `ts6`
        // catalog; core installs that alias under `typescript` itself.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true,"devDependencies":{"typescript":"catalog:","typescript6":"catalog:ts6"}}"#);
        write(d.path(), "core/package.json", r#"{"name":"core","devDependencies":{"typescript":"catalog:ts6"}}"#);
        write(d.path(), "pnpm-workspace.yaml", "packages:\n  - core\ncatalog:\n  typescript: ^7.0.2\ncatalogs:\n  ts6:\n    typescript: npm:@typescript/typescript6@^6.0.2\n    typescript6: npm:@typescript/typescript6@^6.0.2\n");
        write(d.path(), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      typescript:\n        specifier: 'catalog:'\n        version: 7.0.2\n      typescript6:\n        specifier: catalog:ts6\n        version: '@typescript/typescript6@6.0.2'\n\n  core:\n    devDependencies:\n      typescript:\n        specifier: catalog:ts6\n        version: '@typescript/typescript6@6.0.2'\n");
        let s = detect(d.path()).unwrap();
        let ts = &s.deps["pkg:npm/typescript"];
        assert_eq!((ts.version.clone(), ts.readings.len(), ts.parallel_copy()), (Some(Version::new(7, 0, 2)), 1, false), "{ts:?}");
        let six = &s.deps[&npm_purl("@typescript/typescript6")];
        assert_eq!(six.version, Some(Version::new(6, 0, 2)), "{six:?}");
        assert_eq!(six.aliases, ["typescript".to_string(), "typescript6".to_string()].into());
        assert!(six.parallel_copy());
    }

    #[test]
    fn a_pnpm_alias_entry_is_read_from_the_lockfile() {
        // mui: `@typescript/native: npm:typescript@7.0.2` beside `typescript: npm:@typescript/typescript6@6.0.2`; the
        // importer's `version: typescript@7.0.2` is the locked version, not a floor of an unlocked range.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true,"devDependencies":{"@typescript/native":"npm:typescript@7.0.2","typescript":"npm:@typescript/typescript6@6.0.2"}}"#);
        write(d.path(), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      '@typescript/native':\n        specifier: npm:typescript@7.0.2\n        version: typescript@7.0.2\n      typescript:\n        specifier: npm:@typescript/typescript6@6.0.2\n        version: '@typescript/typescript6@6.0.2'\n");
        let s = detect(d.path()).unwrap();
        let ts = &s.deps["pkg:npm/typescript"];
        assert_eq!((ts.version.clone(), ts.source.as_str()), (Some(Version::new(7, 0, 2)), "pnpm-lock.yaml"), "{ts:?}");
        assert_eq!(ts.alias_dirs, [".".to_string()].into());
        let six = &s.deps[&npm_purl("@typescript/typescript6")];
        assert_eq!((six.version.clone(), six.source.as_str()), (Some(Version::new(6, 0, 2)), "pnpm-lock.yaml"), "{six:?}");
        assert_eq!(clean_pnpm_version("13.0.0_react@18.2.0"), parse_version("13.0.0"));
        assert_eq!(clean_pnpm_version("/next/13.0.0"), parse_version("13.0.0"));
    }

    #[test]
    fn an_alias_beside_the_package_s_own_declaration_never_sets_its_version() {
        // moment: `typescript: ^7.0.2` and `typescript1: npm:typescript@^1.8.10`; the lowest alias was the baseline.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true,"devDependencies":{"typescript1":"npm:typescript@^1.8.10","typescript":"^7.0.2"}}"#);
        write(d.path(), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      typescript:\n        specifier: ^7.0.2\n        version: 7.0.2\n      typescript1:\n        specifier: npm:typescript@^1.8.10\n        version: typescript@1.8.10\n");
        let s = detect(d.path()).unwrap();
        let ts = &s.deps["pkg:npm/typescript"];
        assert_eq!((ts.version.clone(), ts.readings.len(), ts.parallel_copy()), (Some(Version::new(7, 0, 2)), 1, false), "{ts:?}");
        assert!(s.notes.iter().any(|n| n.contains("side by side") && n.contains("`typescript1`")), "{:?}", s.notes);
        assert!(ts.unpinned.is_empty());
    }

    #[test]
    fn bun_lock_versions_aliases_and_package_json_catalogs() {
        // anomalyco/opencode: a Bun workspace, catalogs in the root package.json, bun.lock (JSONC) resolving a
        // caret range above its floor, a workspace's own nested copy and an npm alias from the catalog.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true,"packageManager":"bun@1.4.4","workspaces":{"packages":["packages/*"],"catalog":{"hono":"4.10.7","typescript":"npm:@typescript/typescript6@6.0.2"},"catalogs":{"ui":{"vite":"^7.3.0"}}},"devDependencies":{"semver":"^7.6.0","typescript":"catalog:"}}"#);
        write(d.path(), "packages/app/package.json", r#"{"name":"@acme/app","private":true,"dependencies":{"hono":"catalog:","vite":"catalog:ui"}}"#);
        write(d.path(), "packages/web/package.json", r#"{"name":"@acme/web","private":true,"dependencies":{"vite":"^8.0.0"}}"#);
        write(
            d.path(),
            "bun.lock",
            r#"{
  "lockfileVersion": 1,
  // comments are JSONC too
  "workspaces": {
    "": { "name": "root", "devDependencies": { "semver": "^7.6.0", "typescript": "catalog:", }, },
    "packages/app": { "name": "@acme/app", "dependencies": { "hono": "catalog:", "vite": "catalog:ui", }, },
    "packages/web": { "name": "@acme/web", "dependencies": { "vite": "^8.0.0", }, },
  },
  "packages": {
    "@acme/app": ["@acme/app@workspace:packages/app"],
    "@acme/web": ["@acme/web@workspace:packages/web"],
    "hono": ["hono@4.10.7", "", {}, "sha512-H"],
    "semver": ["semver@7.8.5", "", {}, "sha512-S"],
    "typescript": ["@typescript/typescript6@6.0.2", "", {}, "sha512-T"],
    "vite": ["vite@8.2.2", "", {}, "sha512-V8"],
    "@acme/app/vite": ["vite@7.3.6", "", {}, "sha512-V7"],
  },
}
"#,
        );
        let s = detect(d.path()).unwrap();
        assert!(s.unreadable == 0 && s.notes.iter().all(|n| n.contains("different versions across manifests")), "{:?}", s.notes);
        let semver = &s.deps["pkg:npm/semver"];
        assert_eq!((semver.version.clone(), semver.source.as_str()), (Some(Version::new(7, 8, 5)), "bun.lock"), "{semver:?}");
        assert_eq!(semver.pins, vec![Pin { version: "7.8.5".into(), hashes: vec!["sha512-S".into()] }]);
        let hono = &s.deps["pkg:npm/hono"];
        assert_eq!(hono.version, Some(Version::new(4, 10, 7)), "a package.json catalog entry is read: {hono:?}");
        let vite = &s.deps["pkg:npm/vite"];
        let by_dir: BTreeMap<&str, String> = vite.readings.iter().map(|r| (r.dir.as_str(), r.version.to_string())).collect();
        assert_eq!(by_dir, BTreeMap::from([("packages/app", "7.3.6".to_string()), ("packages/web", "8.2.2".to_string())]), "{vite:?}");
        let six = &s.deps[&npm_purl("@typescript/typescript6")];
        assert_eq!(six.version, Some(Version::new(6, 0, 2)), "an alias from the catalog counts as its target: {six:?}");
        assert!(s.packages.iter().all(|p| p.lockfile.as_deref() == Some("bun.lock")), "{:?}", s.packages);

        // Without the lockfile, the catalogs still give the ranges.
        std::fs::remove_file(d.path().join("bun.lock")).unwrap();
        let s = detect(d.path()).unwrap();
        assert_eq!(s.deps["pkg:npm/hono"].source, "floor of 4.10.7 from catalog: (not in a lockfile)");
        assert_eq!(s.deps["pkg:npm/vite"].readings.iter().find(|r| r.dir == "packages/app").map(|r| r.version.to_string()), Some("7.3.0".into()));

        // Bun's top-level `catalog`, beside a `pnpm-workspace.yaml` that lists packages but no catalogs.
        write(d.path(), "package.json", r#"{"name":"root","private":true,"workspaces":["packages/*"],"catalog":{"hono":"4.11.0"},"devDependencies":{"semver":"^7.6.0"}}"#);
        write(d.path(), "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
        let s = detect(d.path()).unwrap();
        assert_eq!(s.deps["pkg:npm/hono"].version, Some(Version::new(4, 11, 0)));
        std::fs::remove_file(d.path().join("pnpm-workspace.yaml")).unwrap();

        // Bun's binary lockfile is named, not passed over in silence.
        write(d.path(), "bun.lockb", "\u{0}bun-lockfile-format-v0\n");
        let s = detect(d.path()).unwrap();
        assert_eq!(s.unreadable, 1);
        assert!(s.notes[0].starts_with("bun.lockb: Bun's binary lockfile is not read"), "{:?}", s.notes);
        assert_eq!(s.deps["pkg:npm/semver"].source, "floor of ^7.6.0 (bun.lockb is not read)");
    }

    #[test]
    fn pnpm_multi_document_lockfile_with_catalogs_and_scoped_peers() {
        // pnpm 11+ with `packageManager`: a first document for pnpm itself, then the project's. Versions with a peer
        // suffix that names a scoped package, and `catalog:` specifiers (default and named) in a workspace package.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true,"packageManager":"pnpm@12.10.1","devDependencies":{"typescript":"catalog:"}}"#);
        write(d.path(), "web/package.json", r#"{"name":"web","private":true,"dependencies":{"next":"catalog:","react":"catalog:react19","zod":"catalog:default"}}"#);
        write(d.path(), "pnpm-workspace.yaml", "packages:\n  - web\ncatalog:\n  next: 16.4.1\n  typescript: ^6.0.2 # pinned for the build\n  zod: '^4.1.0'\ncatalogs:\n  react19:\n    react: ^19.3.0\n");
        write(d.path(), "pnpm-lock.yaml", "---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies: {}\n    packageManagerDependencies:\n      pnpm:\n        specifier: 12.10.1\n        version: 12.10.1\n\npackages:\n\n  pnpm@12.10.1:\n    resolution: {integrity: sha512-PPP}\n\n---\nlockfileVersion: '9.0'\n\ncatalogs:\n  default:\n    next:\n      specifier: 16.4.1\n      version: 16.4.1\n\nimporters:\n\n  .:\n    devDependencies:\n      typescript:\n        specifier: 'catalog:'\n        version: 6.0.2\n\n  web:\n    dependencies:\n      next:\n        specifier: 'catalog:'\n        version: 16.4.1(@babel/core@7.29.7(supports-color@11.0.0))(@playwright/test@1.64.0)(react@19.3.0)\n      react:\n        specifier: catalog:react19\n        version: 19.3.0\n      zod:\n        specifier: 'catalog:'\n        version: 4.1.5\n\npackages:\n\n  next@16.4.1:\n    resolution: {integrity: sha512-NNN}\n");
        let s = detect(d.path()).unwrap();
        assert_eq!(s.deps["pkg:npm/next"].version, Some(Version::new(16, 4, 1)), "{:?}", s.deps["pkg:npm/next"]);
        assert_eq!(s.deps["pkg:npm/next"].source, "pnpm-lock.yaml");
        assert_eq!(s.deps["pkg:npm/next"].pins, vec![Pin { version: "16.4.1".into(), hashes: vec!["sha512-NNN".into()] }]);
        assert_eq!(s.deps["pkg:npm/react"].version, Some(Version::new(19, 3, 0)));
        assert_eq!(s.deps["pkg:npm/zod"].version, Some(Version::new(4, 1, 5)));
        assert_eq!(s.deps["pkg:npm/typescript"].version, Some(Version::new(6, 0, 2)));
        assert!(!s.deps.contains_key("pkg:npm/pnpm"), "the package manager's own lock is not a dependency");
        assert!(s.notes.is_empty(), "{:?}", s.notes);
    }

    #[test]
    fn pnpm_catalog_ranges_without_a_lockfile_and_against_a_stale_one() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - 'libs/*'\ncatalog:\n  next: ^16.1.0\ncatalogs:\n  legacy:\n    react: ~18.2.0\n");
        write(d.path(), "apps/web/package.json", r#"{"name":"web","private":true,"dependencies":{"next":"catalog:","react":"catalog:legacy","left-pad":"catalog:missing"}}"#);
        write(d.path(), "libs/ui/package.json", r#"{"name":"ui","version":"1.0.0","main":"index.js","peerDependencies":{"react":"catalog:legacy"}}"#);
        let s = detect(d.path()).unwrap();
        let next = &s.deps["pkg:npm/next"];
        assert_eq!(next.version, Some(Version::new(16, 1, 0)));
        assert_eq!(next.source, "floor of ^16.1.0 from catalog: (not in a lockfile)");
        let react = &s.deps["pkg:npm/react"];
        assert!(react.readings.iter().all(|r| r.version == Version::new(18, 2, 0)), "{react:?}");
        assert!(react.readings.iter().any(|r| r.source == "library floor of ~18.2.0 from catalog:legacy"), "{react:?}");
        assert_eq!(s.deps["pkg:npm/left-pad"].version, None, "a catalog that does not list the package has no version");
        let flow = parse_pnpm_workspace("catalog: { next: ^16.1.0, '@types/react': \"^19.0.0\" }\ncatalogs:\n  legacy: {react: ~18.2.0}\n");
        assert_eq!(flow.resolve("next", "catalog:"), Some("^16.1.0"));
        assert_eq!(flow.resolve("@types/react", "catalog:default"), Some("^19.0.0"));
        assert_eq!(flow.resolve("react", "catalog:legacy"), Some("~18.2.0"));
        assert_eq!(parse_pnpm_workspace("catalog: { a: \">=1.0.0, <2.0.0\", b: ^3 }\n").resolve("a", "catalog:"), Some(">=1.0.0, <2.0.0"));
        // A lockfile that resolved a catalog entry outside the catalog's range is out of date like any other.
        write(d.path(), "apps/web/pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      next:\n        specifier: 'catalog:'\n        version: 15.5.0\n");
        let s = detect(d.path()).unwrap();
        assert_eq!(s.deps["pkg:npm/next"].version, Some(Version::new(16, 1, 0)));
        assert!(s.notes.iter().any(|n| n.contains("next 15.5.0 vs ^16.1.0")), "{:?}", s.notes);
    }

    #[test]
    fn a_library_reads_its_lockfile_and_keeps_the_range_its_users_get() {
        // recharts' shape: one published package, a root package-lock.json, no workspaces.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"lib","version":"1.0.0","main":"lib/index.js","files":["lib"],
            "dependencies":{"immer":"^11.1.8","rxjs":"^7.8.0"},
            "peerDependencies":{"@nestjs/core":"^10.0.0 || ^11.0.0","react":"^16.8.0 || ^17 || ^18 || ^19"},
            "devDependencies":{"@nestjs/core":"^11.1.0","vite":"^6.4.0","react":"^18.3.1"}}"#);
        write(d.path(), "package-lock.json", r#"{"lockfileVersion":3,"packages":{"":{"name":"lib"},"node_modules/@nestjs/core":{"version":"11.1.6"},
            "node_modules/immer":{"version":"11.1.18"},"node_modules/vite":{"version":"6.4.3"},"node_modules/react":{"version":"18.3.1"}}}"#);
        write(d.path(), ".nvmrc", "v18.19.0\n");
        let s = detect(d.path()).unwrap();
        assert_eq!(s.packages[0].kind, Kind::Library);
        let v = |p: &str| s.deps[p].version.clone();
        // A dependency is what the repository's code runs and tests against, its lockfile's; users get any version
        // in the range, which the reading keeps (code written for ^11.1.8 is cited at 11.1.21).
        assert_eq!(v("pkg:npm/immer"), Some(Version::new(11, 1, 18)));
        assert_eq!(s.deps["pkg:npm/immer"].source, "package-lock.json");
        let immer = &s.deps["pkg:npm/immer"].readings[0];
        assert_eq!(immer.range, Some(Range::Npm("^11.1.8".into())));
        assert!(immer.runs(&Version::new(11, 1, 21)) && !immer.runs(&Version::new(12, 0, 0)));
        // Nothing locks rxjs: the floor of its range.
        assert_eq!(v("pkg:npm/rxjs"), Some(Version::new(7, 8, 0)));
        assert_eq!(s.deps["pkg:npm/rxjs"].source, "library floor of ^7.8.0");
        assert_eq!(v("pkg:npm/vite"), Some(Version::new(6, 4, 3)), "a devDependency is the repository's own, locked");
        assert_eq!(s.deps["pkg:npm/vite"].source, "package-lock.json");
        assert_eq!(v("pkg:npm/react"), Some(Version::new(18, 3, 1)), "the devDependency, not the peer floor");
        assert_eq!(v("pkg:npm/%40nestjs/core"), Some(Version::new(11, 1, 6)));
        assert_eq!(s.deps["pkg:npm/react"].readings.len(), 1);
        assert!(s.notes.is_empty(), "{:?}", s.notes);
        assert_eq!(s.node.as_ref().unwrap().0, Version::new(18, 19, 0));
        assert_eq!(s.node.as_ref().unwrap().1, ".nvmrc");
    }

    #[test]
    fn main_beside_its_own_lockfile_is_an_install_root_not_a_published_library() {
        // Infisical's shape: `backend/` is a deployed server with `npm init`'s `main` and its own package-lock.json;
        // no root lockfile. A workspace member with `main` only and no lockfile of its own is still published.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "backend/package.json", r#"{"name":"backend","version":"1.0.0","main":"./dist/main.mjs","license":"ISC",
            "dependencies":{"zod":"^3.22.4","ioredis":"^5.3.2"},"peerDependencies":{"pg":"^8.0.0"}}"#);
        write(d.path(), "backend/package-lock.json", r#"{"lockfileVersion":3,"packages":{"":{"name":"backend"},"node_modules/zod":{"version":"3.25.76"},
            "node_modules/ioredis":{"version":"5.10.1"},"node_modules/pg":{"version":"8.16.3"}}}"#);
        write(d.path(), "libs/package.json", r#"{"name":"libs","private":true,"workspaces":["pkg-*"]}"#);
        write(d.path(), "libs/package-lock.json", r#"{"lockfileVersion":3,"packages":{"node_modules/react":{"version":"17.0.2"}}}"#);
        write(d.path(), "libs/pkg-a/package.json", r#"{"name":"pkg-a","version":"58.0.1","main":"index.js","peerDependencies":{"react":">=18"}}"#);
        let s = detect(d.path()).unwrap();
        let kind = |dir: &str| s.packages.iter().find(|p| p.dir == dir).unwrap().kind;
        assert_eq!((kind("backend"), kind("libs/pkg-a")), (Kind::Application, Kind::Library));
        let one = |p: &str| s.deps[p].readings.iter().map(|r| (r.version.to_string(), r.source.clone(), r.range.clone())).collect::<Vec<_>>();
        assert_eq!(one("pkg:npm/zod"), vec![("3.25.76".into(), "backend/package-lock.json".into(), None)]);
        assert_eq!(one("pkg:npm/ioredis")[0].0, "5.10.1");
        assert_eq!(one("pkg:npm/pg")[0].0, "8.16.3");
        // The only react the workspace locks is outside the library's peer range: another copy, not what its code is
        // written for, so the floor of the range.
        assert_eq!(one("pkg:npm/react"), vec![("18.0.0".into(), "library floor of >=18".into(), Some(Range::Npm(">=18".into())))]);
        assert!(s.notes.is_empty(), "{:?}", s.notes);
    }

    #[test]
    fn workspaces_npm_lock_and_lowest_version_wins() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true,"workspaces":["apps/*"]}"#);
        write(d.path(), "apps/web/package.json", r#"{"name":"web","private":true,"dependencies":{"next":"^16.0.0"}}"#);
        write(d.path(), "apps/docs/package.json", r#"{"name":"docs","private":true,"dependencies":{"next":"^15.0.0"}}"#);
        write(
            d.path(),
            "package-lock.json",
            r#"{"lockfileVersion":3,"packages":{"node_modules/next":{"version":"16.1.0"},"apps/docs/node_modules/next":{"version":"15.5.2"}}}"#,
        );
        let s = detect(d.path()).unwrap();
        assert_eq!(s.packages.len(), 3);
        assert_eq!(s.deps["pkg:npm/next"].version, Some(Version::new(15, 5, 2)));
    }

    #[test]
    fn a_floor_reading_keeps_its_range_and_fits_the_versions_it_admits() {
        // A library's peer range is what its code is written for: `>=18.0.0` describes code run on 19; a locked
        // version describes only its own release line. The library's reading is the version the workspace installs
        // for it (19.2.4), with its range kept.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"root","private":true,"workspaces":["packages/*"],"devDependencies":{"react":"^19.2.0"}}"#);
        write(d.path(), "packages/ui/package.json", r#"{"name":"ui","version":"1.0.0","main":"i.js","peerDependencies":{"react":">=18.0.0"}}"#);
        write(d.path(), "package-lock.json", r#"{"lockfileVersion":3,"packages":{"node_modules/react":{"version":"19.2.4"}}}"#);
        let s = detect(d.path()).unwrap();
        let rs = &s.deps["pkg:npm/react"].readings;
        let root = rs.iter().find(|r| r.dir == ".").unwrap();
        let ui = rs.iter().find(|r| r.dir == "packages/ui").unwrap();
        assert_eq!((root.range.clone(), ui.range.clone(), ui.version.to_string()), (None, Some(Range::Npm(">=18.0.0".into())), "19.2.4".into()));
        let v19 = Version::new(19, 2, 4);
        assert!(ui.fits(&v19) && ui.runs(&v19), "the peer range admits 19.2.4");
        assert!(root.fits(&Version::new(19, 0, 0)) && !root.runs(&Version::new(19, 0, 0)), "same line, another version");
        assert!(!root.fits(&Version::new(18, 3, 1)));
        assert!(ui.contains("packages/ui/src/a.ts") && !ui.contains("packages/uikit/a.ts") && root.contains("anything.ts"));
        // A PyPI floor reads its specifier with PEP 440 rules.
        let py = Reading { dir: "lib".into(), version: Version::new(1, 0, 0), source: "library floor of >=1".into(), standalone: false, range: Some(Range::Pypi(">=1".into())), lock: None };
        assert!(py.runs(&Version::new(2, 3, 0)) && py.fits(&Version::new(2, 3, 0)));
    }

    #[test]
    fn yarn_lock_classic_and_berry() {
        let classic = "# yarn lockfile v1\n\n\"next@^16.0.0\", next@^16.0.1:\n  version \"16.0.3\"\n  resolved \"x\"\n\n\"@prisma/client@^6.1.0\":\n  version \"6.19.0\"\n";
        let l = parse_yarn(classic);
        assert_eq!(l.version(".", "next", "^16.0.1"), Some(Version::new(16, 0, 3)));
        assert_eq!(l.version(".", "@prisma/client", "^6.1.0"), Some(Version::new(6, 19, 0)));
        let berry = "__metadata:\n  version: 8\n\n\"next@npm:^16.0.0\":\n  version: 16.1.2\n  resolution: \"next@npm:16.1.2\"\n";
        assert_eq!(parse_yarn(berry).version(".", "next", "^16.0.0"), Some(Version::new(16, 1, 2)));
    }

    #[test]
    fn a_yarn_berry_git_resolution_is_not_the_registrys_package() {
        let berry = "__metadata:\n  version: 8\n\n\"uWebSockets.js@uNetworking/uWebSockets.js#semver:^20.68.0\":\n  version: 20.68.0\n  resolution: \"uWebSockets.js@https://github.com/uNetworking/uWebSockets.js.git#commit=6249877\"\n\n\"next@npm:^16.0.0\":\n  version: 16.1.2\n  resolution: \"next@npm:16.1.2\"\n";
        let l = parse_yarn(berry);
        assert_eq!(l.seen.get("uWebSockets.js"), Some(&Seen::Elsewhere));
        assert_ne!(l.seen.get("next"), Some(&Seen::Elsewhere));
    }

    #[test]
    fn pnpm_v5_and_v6_top_level() {
        let v5 = "lockfileVersion: 5.4\n\nspecifiers:\n  next: ^13.0.0\n\ndependencies:\n  next: 13.0.0_react@18.2.0\n";
        assert_eq!(parse_pnpm(v5).version(".", "next", "^13.0.0"), Some(Version::new(13, 0, 0)));
        let v6 = "lockfileVersion: '6.0'\n\ndependencies:\n  next:\n    specifier: ^14.0.0\n    version: 14.2.1(react@18.2.0)\n";
        assert_eq!(parse_pnpm(v6).version(".", "next", "^14.0.0"), Some(Version::new(14, 2, 1)));
    }

    #[test]
    fn stale_lockfile_beside_the_real_one_is_not_read() {
        // AuditAI's ui/: a package-lock.json left behind by a switch to pnpm sorts first but no longer matches.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "ui/package.json", r#"{"private":true,"dependencies":{"next":"16.3.1","@auth0/nextjs-auth0":"^4.14.1"}}"#);
        write(
            d.path(),
            "ui/package-lock.json",
            r#"{"lockfileVersion":3,"packages":{"node_modules/next":{"version":"15.2.4"},"node_modules/@auth0/nextjs-auth0":{"version":"3.8.0"}}}"#,
        );
        write(d.path(), "ui/pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '@auth0/nextjs-auth0':\n        specifier: ^4.14.1\n        version: 4.14.1(next@16.3.1)\n      next:\n        specifier: 16.3.1\n        version: 16.3.1(react@19.2.8)\n");
        let s = detect(d.path()).unwrap();
        assert_eq!(s.deps["pkg:npm/next"].version, Some(Version::new(16, 3, 1)));
        assert_eq!(s.deps["pkg:npm/%40auth0/nextjs-auth0"].version, Some(Version::new(4, 14, 1)));
        assert_eq!(s.packages[0].lockfile.as_deref(), Some("ui/pnpm-lock.yaml"));
        assert_eq!(s.notes.len(), 1, "{:?}", s.notes);
        assert!(s.notes[0].contains("versions from ui/pnpm-lock.yaml") && s.notes[0].contains("package-lock.json has 2 of 2"), "{}", s.notes[0]);
    }

    #[test]
    fn lone_stale_lockfile_falls_back_to_the_declared_floor() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"private":true,"dependencies":{"next":"^16.1.0","react":"^19.0.0"}}"#);
        write(d.path(), "package-lock.json", r#"{"lockfileVersion":3,"packages":{"node_modules/next":{"version":"15.5.0"},"node_modules/react":{"version":"19.2.0"}}}"#);
        let s = detect(d.path()).unwrap();
        assert_eq!(s.deps["pkg:npm/next"].version, Some(Version::new(16, 1, 0)));
        assert!(s.deps["pkg:npm/next"].source.contains("outside the range"));
        assert_eq!(s.deps["pkg:npm/react"].version, Some(Version::new(19, 2, 0)), "pins the range admits are still read");
        assert_eq!(s.notes.len(), 1);
        assert!(s.notes[0].starts_with("package-lock.json: 1 locked version falls outside") && s.notes[0].contains("next 15.5.0 vs ^16.1.0"), "{}", s.notes[0]);
    }

    #[test]
    fn agreeing_lockfiles_are_decided_by_package_manager() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"private":true,"packageManager":"pnpm@9.12.0","dependencies":{"next":"^16.0.0"}}"#);
        write(d.path(), "package-lock.json", r#"{"lockfileVersion":3,"packages":{"node_modules/next":{"version":"16.0.1"}}}"#);
        write(d.path(), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      next:\n        specifier: ^16.0.0\n        version: 16.0.7\n");
        let s = detect(d.path()).unwrap();
        assert_eq!(s.deps["pkg:npm/next"].version, Some(Version::new(16, 0, 7)));
        assert!(s.notes[0].contains("packageManager names pnpm"), "{}", s.notes[0]);
    }

    #[test]
    fn gitignored_package_json_is_skipped() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), ".gitignore", "generated/\n");
        write(d.path(), "package.json", r#"{"private":true,"dependencies":{"next":"16.0.0"}}"#);
        write(d.path(), "generated/package.json", r#"{"private":true,"dependencies":{"next":"12.0.0"}}"#);
        let s = detect(d.path()).unwrap();
        assert_eq!(s.packages.len(), 1);
        assert_eq!(s.deps["pkg:npm/next"].version, Some(Version::new(16, 0, 0)));
    }
}
