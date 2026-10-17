//! Stack detection. npm here; PyPI in `pypi.rs`, merged into the same `Stack`. npm projects: every `package.json` outside `node_modules`, versions from the lockfile
//! (application) or the declared range's floor (library), and the supported Node range (vault: Data Model
//! Contract, "Local opportunity": available, needs upgrade, blocked).

use anyhow::Result;
use semver::Version;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::util::{npm_purl, npm_satisfies, parse_version, range_floor};

/// Directories never read, on top of `.gitignore` (vault: Relevance Engine; the Slice 0 harness skipped the same).
pub const SKIP_DIRS: &[&str] =
    &["node_modules", ".git", ".unstale", "dist", "build", "vendor", ".next", ".nuxt", ".output", ".venv", "venv", "coverage", ".turbo"];

pub fn walker(root: &Path) -> ignore::Walk {
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .git_global(false)
        .filter_entry(|e| !(e.file_type().is_some_and(|t| t.is_dir()) && e.depth() > 0 && SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref())))
        .sort_by_file_path(|a, b| a.cmp(b))
        .build()
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
    /// The version the funnel compares against: the lowest across the packages that declare it.
    pub version: Option<Version>,
    /// Where the version came from, for the report.
    pub source: String,
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
        // The nearest lockfile at or above the package, up to the repository root.
        let mut lock: Option<(PathBuf, Lock)> = None;
        let mut d = Some(dir.as_path());
        while let Some(cur) = d {
            if !locks.contains_key(cur) {
                locks.insert(cur.to_path_buf(), choose_lock(root, cur, Lock::read_all(cur), &mut notes));
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
                let range = range.as_str().unwrap_or("");
                // A library is read at its declared floor, since that is what its users get; a peer range is
                // the one that says so when it is declared.
                let (version, source) = if kind == Kind::Library {
                    let r = if *field != "peerDependencies" {
                        pj.get("peerDependencies").and_then(|p| p.get(name)).and_then(Value::as_str).unwrap_or(range)
                    } else {
                        range
                    };
                    (range_floor(r), format!("library floor of {r}"))
                } else if let Some((ld, l)) = &lock
                    && let Some(v) = l.version(&importer, name, range)
                {
                    // A locked version the manifest no longer admits means the lockfile is out of date: the
                    // declared range says more about what the project runs than the stale pin does.
                    if npm_satisfies(&v, range) == Some(false) {
                        let s = stale.entry(join(&rel_dir(root, ld), &l.file)).or_default();
                        s.0 += 1;
                        if s.1.len() < 3 {
                            s.1.push(format!("{name} {v} vs {range}"));
                        }
                        (range_floor(range), format!("floor of {range} ({} has {v}, outside the range)", l.file))
                    } else {
                        (Some(v), l.file.clone())
                    }
                } else {
                    (range_floor(range), format!("floor of {range} (not in a lockfile)"))
                };
                let public_name = range.strip_prefix("npm:").and_then(|r|r.rsplit_once('@').map(|(n,_)|n)).filter(|n|!n.is_empty()).unwrap_or(name);
                let public_candidate = !local_names.contains(name) && !["workspace:","file:","link:","git:","git+","github:","https:","http:","../","./"].iter().any(|prefix|range.starts_with(prefix));
                let purl = npm_purl(public_name);
                declared.insert(purl.clone());
                let entry = deps.entry(purl).or_insert_with(|| Dep { name: public_name.to_string(), public_candidate, version: None, source: String::new() });
                entry.public_candidate &= public_candidate;
                let lower = match (&entry.version, &version) {
                    (None, Some(_)) => true,
                    (Some(a), Some(b)) => b < a,
                    _ => false,
                };
                if lower || entry.source.is_empty() {
                    entry.version = version.or(entry.version.take());
                    entry.source = source;
                }
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
    Ok(Stack { packages, deps, node, notes })
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

/// Resolved versions from one lockfile: per importer directory (`.` for the lockfile's own directory) and name.
#[derive(Debug, Clone, Default)]
pub struct Lock {
    pub file: String,
    importers: BTreeMap<String, BTreeMap<String, Version>>,
    /// yarn: (name, range) → version, and every version per name.
    by_range: BTreeMap<(String, String), Version>,
    by_name: BTreeMap<String, Vec<Version>>,
}

/// npm lockfiles in the order used when nothing else decides between them, with the package manager that writes
/// each (the `packageManager` field names it).
const LOCKFILES: &[(&str, &str)] =
    &[("package-lock.json", "npm"), ("npm-shrinkwrap.json", "npm"), ("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn")];

/// One lockfile for a directory that holds several (a switch of package manager that left the old file behind):
/// the one whose versions the manifest beside it admits, then the one `packageManager` names, then the fixed
/// order. The choice is recorded in `notes` whenever there was one to make.
fn choose_lock(root: &Path, dir: &Path, mut cands: Vec<Lock>, notes: &mut Vec<String>) -> Option<Lock> {
    if cands.len() < 2 {
        return cands.pop();
    }
    let pj: Value = std::fs::read_to_string(dir.join("package.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let declared: Vec<(&str, &str)> = DEP_FIELDS[..3]
        .iter()
        .filter_map(|f| pj.get(*f).and_then(Value::as_object))
        .flatten()
        .filter_map(|(n, r)| r.as_str().map(|r| (n.as_str(), r)))
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
                l.importers.entry(importer.to_string()).or_default().insert(name.to_string(), ver);
            }
        }
    } else if let Some(deps) = v.get("dependencies").and_then(Value::as_object) {
        for (name, meta) in deps {
            if let Some(ver) = meta.get("version").and_then(Value::as_str).and_then(parse_version) {
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
    let v = v.rsplit('/').next().unwrap_or(v); // `/next/13.0.0` (old format)
    let v = v.split('(').next().unwrap_or(v); // `16.0.3(react@19.0.0)`
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
        let indent = trimmed.len() - trimmed.trim_start().len();
        let body = trimmed.trim_start();
        let Some((k, val)) = split_key(body) else { continue };
        while stack.last().is_some_and(|(i, _)| *i >= indent) {
            stack.pop();
        }
        let path: Vec<&str> = stack.iter().map(|(_, k)| k.as_str()).collect();
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
    for line in text.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') {
            specs.clear();
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
