//! Stack detection. npm here; PyPI in `pypi.rs`, merged into the same `Stack`. npm projects: every `package.json` outside `node_modules`, versions from the lockfile
//! (application) or the declared range's floor (library), and the supported Node range: available, needs upgrade, or blocked.

use anyhow::Result;
use semver::Version;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

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
}

#[derive(Debug, Clone)]
pub struct Dep {
    pub name: String,
    /// False for workspace/file/link/git dependencies; never submit these identities centrally.
    pub public_candidate: bool,
    /// The version the funnel compares against: the root manifest's, else the shallowest manifest's that declares
    /// it (the lowest on a tie); `Stack::settle`.
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
}

/// One manifest's version of a dependency.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    /// The manifest's directory relative to the repository root, `.` for the root.
    pub dir: String,
    pub version: Version,
    pub source: String,
}

impl Dep {
    pub fn new(name: &str, public_candidate: bool) -> Dep {
        Dep { name: name.to_string(), public_candidate, version: None, source: String::new(), readings: vec![], pins: vec![] }
    }

    /// One manifest's version (`None` when it cannot be read: a tag, a workspace link). The headline is set by
    /// `Stack::settle` once every manifest is read; until then `source` keeps the first unreadable one's reason.
    pub fn read(&mut self, dir: &str, version: Option<Version>, source: String) {
        let Some(version) = version else {
            if self.source.is_empty() {
                self.source = source;
            }
            return;
        };
        match self.readings.iter_mut().find(|r| r.dir == dir) {
            Some(r) if version < r.version => *r = Reading { dir: dir.to_string(), version, source },
            Some(_) => {}
            None => self.readings.push(Reading { dir: dir.to_string(), version, source }),
        }
    }

    /// The reading the outputs use: the root manifest's, else the shallowest manifest's, the lowest version on a
    /// tie. The root (or the top of a workspace tree) is what the application resolves; a nested manifest with its
    /// own lockfile (a CI tool) or a library's declared floor (a peer range) says what that one part runs or
    /// supports, and is named beside it instead of setting the version for the whole repository.
    pub fn headline(&self) -> Option<&Reading> {
        self.readings.iter().min_by(|a, b| depth(&a.dir).cmp(&depth(&b.dir)).then_with(|| a.version.cmp(&b.version)).then_with(|| a.dir.cmp(&b.dir)))
    }

    /// Readings on another version than the headline, grouped by version (ascending), each with its directories.
    pub fn others(&self) -> Vec<(Version, Vec<&Reading>)> {
        let Some(h) = self.headline() else { return vec![] };
        let mut by: BTreeMap<Version, Vec<&Reading>> = BTreeMap::new();
        for r in self.readings.iter().filter(|r| r.version != h.version) {
            by.entry(r.version.clone()).or_default().push(r);
        }
        by.into_iter().collect()
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

#[derive(Debug, Clone)]
pub struct Stack {
    pub packages: Vec<Package>,
    pub deps: BTreeMap<String, Dep>,
    /// The lowest Node version the project supports, and where that came from.
    pub node: Option<(Version, String)>,
    /// Where versions came from when that needed a choice: competing lockfiles in one directory, or a lockfile
    /// that disagrees with the manifest beside it. For the report.
    pub notes: Vec<String>,
}

impl Stack {
    /// Sets each dependency's version from its readings (`settle`).
    pub fn settle(&mut self) {
        if let Some(n) = settle(&mut self.deps) {
            self.notes.push(n);
        }
    }

    pub fn purls(&self) -> BTreeSet<String> {
        self.deps.keys().cloned().collect()
    }

    /// Technology ids worth asking the catalog for: each package name, and a scope's name. Only a candidate;
    /// a technology is in the stack when its records name one of these package URLs.
    pub fn candidates(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        for d in self.deps.values() {
            match d.name.strip_prefix('@').and_then(|s| s.split_once('/')) {
                Some((scope, name)) => {
                    out.insert(scope.to_lowercase());
                    out.insert(name.to_lowercase());
                }
                None => {
                    out.insert(d.name.to_lowercase());
                }
            }
        }
        out
    }

    /// A version the project declares for a prerequisite name in the npm ecosystem: `node` from engines or
    /// `.nvmrc`, anything else from the dependency list.
    pub fn npm_version(&self, name: &str) -> Option<&Version> {
        if name.eq_ignore_ascii_case("node") {
            return self.node.as_ref().map(|(v, _)| v);
        }
        self.deps.get(&npm_purl(&name.to_lowercase())).and_then(|d| d.version.as_ref())
    }
}

/// Sets each dependency's version and source from its readings (`Dep::headline`); a note naming the packages whose
/// versions differ across manifests, when any do.
pub fn settle(deps: &mut BTreeMap<String, Dep>) -> Option<String> {
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
    Some(format!(
        "{n} package{} on different versions across manifests: {}{}. The reviews use the root's version (else the shallowest manifest's); the bump digest names the others.",
        if n == 1 { " is" } else { "s are" },
        differ.join("; "),
        if n > 5 { format!("; {} more", n - 5) } else { String::new() }
    ))
}

const DEP_FIELDS: &[&str] = &["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

fn is_library(pj: &Value) -> bool {
    let private = pj.get("private").and_then(Value::as_bool).unwrap_or(false);
    let published = pj.get("name").is_some() && pj.get("version").is_some();
    let entry = ["main", "module", "exports", "types", "typings", "bin", "files"].iter().any(|k| pj.get(k).is_some());
    !private && published && entry
}

/// Dependency manifests of ecosystems this client does not read yet, by file name (or extension, `.csproj`). The
/// list is per ecosystem, not per technology; a new ecosystem adapter removes its line.
const OTHER_MANIFESTS: &[(&str, &str)] = &[
    // Python (PyPI) is read by `pypi.rs`; a `setup.py`-only project declares nothing statically readable.
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

/// Manifests of uncovered ecosystems anywhere in the repository (`.gitignore` respected), per ecosystem with their
/// paths. Manifests in examples, documentation, test fixtures, generated or vendored code are not the project's.
pub fn uncovered_manifests(repo: &crate::usage::Repo) -> BTreeMap<&'static str, Vec<String>> {
    use crate::usage::Role;
    let mut out: BTreeMap<&'static str, Vec<String>> = BTreeMap::new();
    for p in &repo.paths {
        let base = p.rsplit('/').next().unwrap_or(p);
        let Some((_, eco)) = OTHER_MANIFESTS
            .iter()
            .find(|(m, _)| if m.starts_with('.') { base.ends_with(m) } else { base == *m })
        else {
            continue;
        };
        if matches!(repo.role(p), Role::App | Role::Tooling) {
            out.entry(eco).or_default().push(p.clone());
        }
    }
    out
}

pub fn detect(root: &Path) -> Result<Stack> {
    let local_names: BTreeSet<String> = walker(root).flatten().filter(|e|e.file_name()=="package.json")
        .filter_map(|e| std::fs::read(e.path()).ok()).filter_map(|b|serde_json::from_slice::<Value>(&b).ok())
        .filter_map(|v|v.get("name").and_then(Value::as_str).map(String::from)).collect();
    let mut packages = vec![];
    let mut deps: BTreeMap<String, Dep> = BTreeMap::new();
    let mut node: Option<(Version, String)> = None;
    let mut locks: BTreeMap<PathBuf, Option<Lock>> = BTreeMap::new();
    let mut catalogs: BTreeMap<PathBuf, Catalogs> = BTreeMap::new();
    let mut notes = vec![];
    // Per lockfile path: locked versions outside the declared range, with a few examples.
    let mut stale: BTreeMap<String, (usize, Vec<String>)> = BTreeMap::new();
    for e in walker(root).flatten() {
        if e.file_name() != "package.json" || !e.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
        let Ok(pj) = serde_json::from_str::<Value>(&text) else { continue };
        let dir = e.path().parent().unwrap_or(root).to_path_buf();
        let rel = rel_dir(root, &dir);
        let kind = if is_library(&pj) { Kind::Library } else { Kind::Application };
        let mut declared = BTreeSet::new();
        let cat = Catalogs::nearest(root, &dir, &mut catalogs);
        // The nearest lockfile at or above the package, up to the repository root.
        let mut lock: Option<(PathBuf, Lock)> = None;
        let mut d = Some(dir.as_path());
        while let Some(cur) = d {
            if !locks.contains_key(cur) {
                let cur_cat = Catalogs::nearest(root, cur, &mut catalogs);
                locks.insert(cur.to_path_buf(), choose_lock(root, cur, Lock::read_all(cur), &local_names, &cur_cat, &mut notes));
            }
            if let Some(Some(l)) = locks.get(cur) {
                lock = Some((cur.to_path_buf(), l.clone()));
                break;
            }
            if cur == root {
                break;
            }
            d = cur.parent();
        }
        let importer = lock.as_ref().map(|(ld, _)| rel_dir(ld, &dir)).unwrap_or_else(|| ".".into());
        for field in DEP_FIELDS {
            let Some(map) = pj.get(*field).and_then(Value::as_object) else { continue };
            for (name, range) in map {
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
                let local = is_local(&local_names, name, range);
                // A library is read at its declared floor, since that is what its users get; a peer range is
                // the one that says so when it is declared.
                let (version, source) = if kind == Kind::Library {
                    let r = if *field != "peerDependencies" {
                        pj.get("peerDependencies").and_then(|p| p.get(name)).and_then(Value::as_str).unwrap_or(range)
                    } else {
                        range
                    };
                    let r_shown = if r == range { shown.clone() } else { r.to_string() };
                    (range_floor(r), format!("library floor of {r_shown}"))
                } else if let Some((ld, l)) = &lock
                    && let Some(v) = l.version(&importer, name, range)
                {
                    // A locked version the manifest no longer admits means the lockfile is out of date: the
                    // declared range says more about what the project runs than the stale pin does.
                    if !local && npm_satisfies(&v, range) == Some(false) {
                        let s = stale.entry(join(&rel_dir(root, ld), &l.file)).or_default();
                        s.0 += 1;
                        if s.1.len() < 3 {
                            s.1.push(format!("{name} {v} vs {range}"));
                        }
                        (range_floor(range), format!("floor of {shown} ({} has {v}, outside the range)", join(&rel_dir(root, ld), &l.file)))
                    } else {
                        (Some(v), join(&rel_dir(root, ld), &l.file))
                    }
                } else {
                    (range_floor(range), format!("floor of {shown} (not in a lockfile)"))
                };
                let public_name = range.strip_prefix("npm:").and_then(|r|r.rsplit_once('@').map(|(n,_)|n)).filter(|n|!n.is_empty()).unwrap_or(name);
                let public_candidate = !local;
                let purl = npm_purl(public_name);
                declared.insert(purl.clone());
                let entry = deps.entry(purl).or_insert_with(|| Dep::new(public_name, public_candidate));
                entry.public_candidate &= public_candidate;
                if let Some((_, l)) = &lock
                    && let Some(v) = l.version(&importer, name, range)
                    && let Some(pin) = l.pin(name, &v).or_else(|| l.pin(public_name, &v))
                    && !entry.pins.contains(&pin)
                {
                    entry.pins.push(pin);
                }
                entry.read(&rel, version, source);
            }
        }
        if let Some(r) = pj.pointer("/engines/node").and_then(Value::as_str)
            && let Some(v) = range_floor(r)
                && node.as_ref().is_none_or(|(n, _)| &v < n) {
                    node = Some((v, format!("engines.node {r} in {}", join(&rel, "package.json"))));
                }
        packages.push(Package {
            dir: rel,
            kind,
            lockfile: lock.map(|(ld, l)| join(&rel_dir(root, &ld), &l.file)),
            declared,
        });
    }
    if node.is_none() {
        for p in &packages {
            for f in [".nvmrc", ".node-version"] {
                let path = root.join(&p.dir).join(f);
                let Ok(t) = std::fs::read_to_string(&path) else { continue };
                if let Some(v) = parse_version(t.trim())
                    && node.as_ref().is_none_or(|(n, _)| &v < n) {
                        node = Some((v, join(&p.dir, f)));
                    }
            }
        }
    }
    for (file, (n, examples)) in stale {
        notes.push(format!(
            "{file}: {n} locked version{} outside the ranges its package.json declares ({}); read at the declared floor instead. The lockfile looks out of date.",
            if n == 1 { " falls" } else { "s fall" },
            examples.join(", ")
        ));
    }
    crate::pypi::detect(root, &mut packages, &mut deps, &mut notes);
    let mut st = Stack { packages, deps, node, notes };
    st.settle();
    Ok(st)
}

/// A dependency on a package of this repository (by name or by a local protocol): never public, and never compared
/// with what a lockfile records for it.
fn is_local(local_names: &BTreeSet<String>, name: &str, range: &str) -> bool {
    local_names.contains(name)
        || ["workspace:", "file:", "link:", "git:", "git+", "github:", "https:", "http:", "../", "./"].iter().any(|p| range.starts_with(p))
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

/// pnpm catalogs from `pnpm-workspace.yaml`: catalog name → package → range. `catalog:` at the top level is the
/// `default` catalog, `catalogs: <name>:` the named ones. A manifest uses the nearest workspace file at or above it.
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
            if let Ok(text) = std::fs::read_to_string(cur.join("pnpm-workspace.yaml")) {
                let c = parse_pnpm_workspace(&text);
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
}

/// npm lockfiles in the order used when nothing else decides between them, with the package manager that writes
/// each (the `packageManager` field names it).
const LOCKFILES: &[(&str, &str)] =
    &[("package-lock.json", "npm"), ("npm-shrinkwrap.json", "npm"), ("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn")];

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
        declared.iter().fold((0usize, 0usize), |(out, ins), (n, r)| match l.version(".", n, r).and_then(|v| npm_satisfies(&v, r)) {
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
                _ => parse_npm(&text),
            };
            l.file = f.to_string();
            out.push(l);
        }
        out
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

    /// The locked version of `name` with its sha512 integrity, when the lockfile states one.
    pub fn pin(&self, name: &str, v: &Version) -> Option<Pin> {
        let hashes = self.integrity.get(&(name.to_string(), v.to_string()))?;
        Some(Pin { version: v.to_string(), hashes: hashes.clone() })
    }

    fn add_integrity(&mut self, name: &str, version: &Version, integrity: &str) {
        // Only sha512: what the public registry states as `dist.integrity` for every current package.
        let hashes: Vec<String> = integrity.split_whitespace().filter(|h| h.starts_with("sha512-")).map(String::from).collect();
        if !hashes.is_empty() {
            self.integrity.insert((name.to_string(), version.to_string()), hashes);
        }
    }
}

pub fn parse_npm(text: &str) -> Lock {
    let mut l = Lock::default();
    let Ok(v) = serde_json::from_str::<Value>(text) else { return l };
    if let Some(pk) = v.get("packages").and_then(Value::as_object) {
        for (key, meta) in pk {
            let Some((prefix, name)) = key.rsplit_once("node_modules/") else { continue };
            if name.is_empty() || prefix.contains("node_modules/") {
                continue; // nested dependencies of dependencies
            }
            let importer = prefix.trim_end_matches('/');
            let importer = if importer.is_empty() { "." } else { importer };
            if let Some(ver) = meta.get("version").and_then(Value::as_str).and_then(parse_version) {
                if let Some(i) = meta.get("integrity").and_then(Value::as_str) {
                    l.add_integrity(name, &ver, i);
                }
                l.importers.entry(importer.to_string()).or_default().insert(name.to_string(), ver);
            }
        }
    } else if let Some(deps) = v.get("dependencies").and_then(Value::as_object) {
        for (name, meta) in deps {
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

fn clean_pnpm_version(v: &str) -> Option<Version> {
    let v = v.trim().trim_matches(['\'', '"']);
    if v.starts_with("link:") || v.starts_with("file:") || v.starts_with("workspace:") {
        return None;
    }
    // The peer suffix first: it can name scoped packages (`16.4.1(@babel/core@7.29.7)`), whose `/` is not the
    // old format's.
    let v = v.split('(').next().unwrap_or(v); // `16.0.3(react@19.0.0)`
    let v = v.rsplit('/').next().unwrap_or(v); // `/next/13.0.0` (old format)
    let v = v.split('_').next().unwrap_or(v); // `13.0.0_react@18.2.0` (lockfile v5)
    parse_version(v)
}

/// A line-based reader for the parts of `pnpm-lock.yaml` needed here (importers, or top-level dependencies in
/// single-project lockfiles); no YAML dependency.
pub fn parse_pnpm(text: &str) -> Lock {
    let mut l = Lock::default();
    let mut stack: Vec<(usize, String)> = vec![];
    const SECTIONS: &[&str] = &["dependencies", "devDependencies", "optionalDependencies"];
    for raw in text.lines() {
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
        // `packages:` entries: `name@1.2.3(peer@x)` (v6+) or `/name/1.2.3` (v5), with `resolution: {integrity: ...}`
        // inline or as a nested key.
        let integrity = match (path.as_slice(), val) {
            (["packages", key], Some(v)) if k == "resolution" => {
                v.split_once("integrity:").map(|(_, r)| (*key, r.trim().trim_end_matches('}').split(',').next().unwrap_or("").trim().to_string()))
            }
            (["packages", key, "resolution"], Some(v)) if k == "integrity" => Some((*key, v.to_string())),
            _ => None,
        };
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
    l
}

/// `key: value` → (key, Some(value)); `key:` → (key, None). Quotes around the key are removed.
fn split_key(body: &str) -> Option<(String, Option<&str>)> {
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
        let m = uncovered_manifests(&r);
        assert!(!m.contains_key("Python (PyPI)"), "read by the PyPI adapter");
        assert_eq!(m["Rust (crates.io)"], vec!["native/agentive_nif/Cargo.toml"]);
        assert_eq!(m["Elixir (Hex)"], vec!["mix.exs"]);
        assert_eq!(m["C# (NuGet)"], vec!["src/App/App.csproj"]);
        assert!(!m.contains_key("Go modules"), "a fixture's manifest is not the project's");
        assert_eq!(m.len(), 3);
    }

    use super::*;

    fn write(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
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
    fn library_uses_range_floor_and_peer_range() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "package.json", r#"{"name":"lib","version":"1.0.0","main":"index.js",
            "peerDependencies":{"@nestjs/core":"^10.0.0 || ^11.0.0"},"devDependencies":{"@nestjs/core":"^11.1.0"}}"#);
        write(d.path(), "package-lock.json", r#"{"lockfileVersion":3,"packages":{"node_modules/@nestjs/core":{"version":"11.1.6"}}}"#);
        write(d.path(), ".nvmrc", "v18.19.0\n");
        let s = detect(d.path()).unwrap();
        assert_eq!(s.packages[0].kind, Kind::Library);
        assert_eq!(s.deps["pkg:npm/%40nestjs/core"].version, Some(Version::new(10, 0, 0)), "a library is read at its floor");
        assert_eq!(s.node.as_ref().unwrap().0, Version::new(18, 19, 0));
        assert_eq!(s.node.as_ref().unwrap().1, ".nvmrc");
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
    fn yarn_lock_classic_and_berry() {
        let classic = "# yarn lockfile v1\n\n\"next@^16.0.0\", next@^16.0.1:\n  version \"16.0.3\"\n  resolved \"x\"\n\n\"@prisma/client@^6.1.0\":\n  version \"6.19.0\"\n";
        let l = parse_yarn(classic);
        assert_eq!(l.version(".", "next", "^16.0.1"), Some(Version::new(16, 0, 3)));
        assert_eq!(l.version(".", "@prisma/client", "^6.1.0"), Some(Version::new(6, 19, 0)));
        let berry = "__metadata:\n  version: 8\n\n\"next@npm:^16.0.0\":\n  version: 16.1.2\n  resolution: \"next@npm:16.1.2\"\n";
        assert_eq!(parse_yarn(berry).version(".", "next", "^16.0.0"), Some(Version::new(16, 1, 2)));
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
