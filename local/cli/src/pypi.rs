//! Stack detection for Python projects (PyPI), the second ecosystem adapter after npm (`stack.rs`). Declared in
//! `pyproject.toml` (PEP 621 `[project]`, PEP 735 `[dependency-groups]`, Poetry `[tool.poetry]`), `requirements*.txt`
//! and `Pipfile`; pinned by the nearest `uv.lock`, `poetry.lock`, `pdm.lock` or `Pipfile.lock`. A project with a
//! lockfile, or one declaring only requirements, is an application read at its locked or pinned versions; a
//! `pyproject.toml` that names a distribution and has no lockfile is a library read at its declared floor.

use semver::Version;
use serde_json::Value as Json;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use toml::Value;

use crate::privacy::Seen;
use crate::stack::{Dep, Kind, Package, Pin, walker};
use crate::usage::{Role, path_role};

/// PEP 503 name normalisation: lowercase, runs of `-`, `_` and `.` become one `-`.
pub fn normalize(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.trim().chars() {
        if matches!(c, '-' | '_' | '.') {
            if !out.ends_with('-') {
                out.push('-');
            }
        } else {
            out.push(c.to_ascii_lowercase());
        }
    }
    out
}

/// Canonical PyPI package URL: `pkg:pypi/<normalized name>`.
pub fn purl(name: &str) -> String {
    format!("pkg:pypi/{}", normalize(name))
}

/// A PEP 440 version in the client's (SemVer) order: epoch and local labels dropped, the first three release
/// numbers kept, `aN`/`bN`/`rcN` as prereleases `a.N`/`b.N`/`rc.N` and `.devN` as `dev.N` (sorted before them, as
/// PEP 440 sorts it), `.postN` as build metadata (equal precedence: a post-release fixes packaging, not code).
pub fn parse_version(s: &str) -> Option<Version> {
    let s = s.trim().trim_start_matches(['v', 'V']).to_ascii_lowercase();
    let s = s.split('+').next()?;
    let s = s.rsplit('!').next()?;
    let end = s.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(s.len());
    let (release, rest) = s.split_at(end);
    let nums: Vec<u64> = release.trim_end_matches('.').split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let n = |i: usize| nums.get(i).copied().unwrap_or(0);
    let mut v = Version::new(n(0), n(1), n(2));
    let rest = rest.trim_start_matches(['.', '-', '_']);
    if rest.is_empty() {
        return Some(v);
    }
    let (label, num) = rest.split_at(rest.find(|c: char| c.is_ascii_digit()).unwrap_or(rest.len()));
    let num: u64 = num.split(|c: char| !c.is_ascii_digit()).next().unwrap_or("").parse().unwrap_or(0);
    let pre = match label.trim_end_matches(['.', '-', '_']) {
        "a" | "alpha" => format!("a.{num}"),
        "b" | "beta" => format!("b.{num}"),
        "rc" | "c" | "pre" | "preview" => format!("rc.{num}"),
        // PEP 440 sorts a dev release before its pre-releases; SemVer compares `0dev` < `a` as identifiers.
        "dev" => format!("0dev.{num}"),
        "post" | "rev" | "r" => {
            v.build = semver::BuildMetadata::new(&format!("post.{num}")).ok()?;
            return Some(v);
        }
        _ => return None,
    };
    v.pre = semver::Prerelease::new(&pre).ok()?;
    Some(v)
}

/// The lowest version a PEP 440 specifier set (or a Poetry constraint) admits: `>=1.2,<2` → 1.2.0, `~=1.4.2` →
/// 1.4.2, `==2.31.*` → 2.31.0, `^1.2` → 1.2.0, `1.2.3` → 1.2.3. `None` with no lower bound (`*`, `<2`, `!=1.0`).
pub fn spec_floor(spec: &str) -> Option<Version> {
    let mut best: Option<Version> = None;
    for alt in spec.split("||") {
        let mut floor: Option<Version> = None;
        for part in alt.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let op_end = part.find(|c: char| c.is_ascii_alphanumeric()).unwrap_or(part.len());
            let (op, ver) = part.split_at(op_end);
            let ver = ver.trim().trim_end_matches(".*");
            let v = match op.trim() {
                ">=" | "==" | "===" | "~=" | ">" | "^" | "~" | "" => parse_version(ver),
                _ => None,
            };
            if let Some(v) = v
                && floor.as_ref().is_none_or(|f| v > *f)
            {
                floor = Some(v);
            }
        }
        if let Some(f) = floor
            && best.as_ref().is_none_or(|b| f < *b)
        {
            best = Some(f);
        }
    }
    best
}

/// A declared requirement: name, specifier, and whether it is a public PyPI identity (no URL or path reference).
type Req = (String, String, bool);

/// A PEP 508 requirement as a [`Req`].
fn requirement(line: &str) -> Option<Req> {
    let line = line.split(';').next()?.split(" #").next()?.trim();
    let end = line.find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))).unwrap_or(line.len());
    let name = &line[..end];
    if name.is_empty() || !name.as_bytes()[0].is_ascii_alphanumeric() {
        return None;
    }
    let mut rest = line[end..].trim_start();
    if rest.starts_with('[') {
        rest = rest.split_once(']').map(|(_, r)| r).unwrap_or("").trim_start();
    }
    let public = !rest.starts_with('@');
    let spec = rest.trim_start_matches('(').trim_end_matches(')').trim();
    Some((name.to_string(), if public { spec.to_string() } else { String::new() }, public))
}

/// One logical line of a requirements file.
#[derive(Debug, Clone, PartialEq)]
enum ReqLine {
    /// `-r <file>` (`constraint` false) or `-c <file>`: another requirements file, relative to this one.
    Include { file: String, constraint: bool },
    /// A requirement, its `==` pin (version as written) and `--hash` values, and whether it is declared here: false
    /// for a compiled entry whose `# via` annotation (pip-compile, `uv pip compile`) names only the packages that pull
    /// it in, and no `-r` input or `(<file>)` source declaring it.
    Req { req: Req, pin: Option<String>, hashes: Vec<String>, declared: bool },
}

/// A requirements file's lines: options other than `-r`/`-c` (`-e`, `--index-url`), URLs and local paths dropped.
fn requirement_lines(text: &str) -> Vec<ReqLine> {
    let mut out = vec![];
    let mut joined = String::new();
    // The entry a following `# via` annotation belongs to, and whether one is being read.
    let (mut last, mut via): (Option<usize>, bool) = (None, false);
    for raw in text.lines() {
        let l = raw.trim_end();
        if let Some(head) = l.strip_suffix('\\') {
            joined.push_str(head);
            joined.push(' ');
            continue;
        }
        joined.push_str(l);
        let line = std::mem::take(&mut joined);
        let line = line.trim();
        if let Some(c) = line.strip_prefix('#') {
            let c = c.trim();
            let item = match c.strip_prefix("via") {
                Some(rest) if rest.is_empty() || rest.starts_with(char::is_whitespace) => {
                    via = true;
                    if let Some(ReqLine::Req { declared, .. }) = last.and_then(|i| out.get_mut(i)) {
                        *declared = false;
                    }
                    rest.trim()
                }
                _ if via => c,
                _ => continue,
            };
            // `-r requirements/base.in` or `apache-superset (pyproject.toml)`: an input declares it.
            if (item.starts_with("-r ") || item.ends_with(')'))
                && let Some(ReqLine::Req { declared, .. }) = last.and_then(|i| out.get_mut(i))
            {
                *declared = true;
            }
            continue;
        }
        via = false;
        last = None;
        if line.is_empty() {
            continue;
        }
        let mut words = line.split_whitespace();
        let first = words.next().unwrap_or("");
        let include = |opt: &str| -> Option<String> {
            let rest = line.strip_prefix(opt)?;
            let arg = rest.strip_prefix('=').unwrap_or(rest).trim();
            (!arg.is_empty() && (rest.starts_with([' ', '\t', '=']) || opt.len() == 2)).then(|| arg.split_whitespace().next().unwrap_or("").to_string())
        };
        if let Some(file) = include("--requirement").or_else(|| include("-r")) {
            out.push(ReqLine::Include { file, constraint: false });
            continue;
        }
        if let Some(file) = include("--constraint").or_else(|| include("-c")) {
            out.push(ReqLine::Include { file, constraint: true });
            continue;
        }
        if line.starts_with('-') || first.contains("://") || line.starts_with('.') || line.starts_with('/') {
            continue;
        }
        let mut hashes = vec![];
        let mut it = line.split_whitespace().peekable();
        while let Some(w) = it.next() {
            if let Some(h) = w.strip_prefix("--hash=") {
                hashes.push(h.to_string());
            } else if w == "--hash"
                && let Some(h) = it.next()
            {
                hashes.push(h.to_string());
            }
        }
        let Some(req) = requirement(line.split(" --").next().unwrap_or("")) else { continue };
        let pin = req.1.strip_prefix("==").map(str::trim).filter(|v| !v.contains([',', '*', ' '])).filter(|v| parse_version(v).is_some()).map(String::from);
        last = Some(out.len());
        out.push(ReqLine::Req { req, pin, hashes, declared: true });
    }
    out
}

/// `requirements*.txt` lines: requirements only (no `-r`/`-e`/`-c` options, URLs or local paths).
#[cfg(test)]
fn requirements_txt(text: &str) -> Vec<Req> {
    requirement_lines(text).into_iter().filter_map(|l| if let ReqLine::Req { req, .. } = l { Some(req) } else { None }).collect()
}

/// What a set of requirements files says, `-r` and `-c` includes followed: the requirements they declare (an
/// included constraints file declares none), and their `==` pins, which install exactly that version: the
/// project's lock for the packages they pin (`pip install -r`, a `uv pip compile` output).
#[derive(Default)]
struct Requirements {
    reqs: Vec<Req>,
    /// Normalised name → (version as written, `sha256:` hashes, the pinning file relative to the project directory).
    pins: BTreeMap<String, (String, Vec<String>, String)>,
    /// The files read as a `-c` constraints file somewhere: they declare nothing, even where found on their own.
    constrained: BTreeSet<PathBuf>,
}

impl Requirements {
    fn read(&mut self, root: &Path, project: &Path, file: &Path, constraint: bool, seen: &mut BTreeSet<(PathBuf, bool)>) {
        let Ok(canon) = file.canonicalize() else { return };
        if !root.canonicalize().is_ok_and(|r| canon.starts_with(r)) || !seen.insert((canon.clone(), constraint)) {
            return;
        }
        if constraint {
            self.constrained.insert(canon.clone());
        }
        let Ok(text) = std::fs::read_to_string(&canon) else { return };
        let shown = file.strip_prefix(project).unwrap_or(file).to_string_lossy().replace('\\', "/");
        for l in requirement_lines(&text) {
            match l {
                ReqLine::Include { file: f, constraint: c } => self.read(root, project, &file.parent().unwrap_or(root).join(f), constraint || c, seen),
                ReqLine::Req { req, pin, hashes, declared } => {
                    if let Some(p) = pin {
                        // Two files pinning one package differently (a production and a development set): the newer, as
                        // for a lock forked by marker.
                        let n = normalize(&req.0);
                        let newer = |old: &(String, Vec<String>, String)| parse_version(&p).zip(parse_version(&old.0)).is_some_and(|(a, b)| a > b);
                        match self.pins.get(&n) {
                            Some(old) if !newer(old) => {}
                            _ => {
                                self.pins.insert(n, (p, hashes.into_iter().filter(|h| h.starts_with("sha256:")).collect(), shown.clone()));
                            }
                        }
                    }
                    if declared && !constraint {
                        self.reqs.push(req);
                    }
                }
            }
        }
    }

    /// The pins as a [`Lock`] named after the first pinning file.
    fn lock(&self) -> Option<Lock> {
        let file = self.pins.values().map(|p| p.2.clone()).min()?;
        let versions = self.pins.iter().filter_map(|(n, p)| Some((n.clone(), parse_version(&p.0)?))).collect();
        let pins = self.pins.iter().filter(|(_, p)| !p.1.is_empty()).map(|(n, p)| (n.clone(), Pin { version: p.0.clone(), hashes: p.1.clone() })).collect();
        let files = self.pins.iter().map(|(n, p)| (n.clone(), p.2.clone())).collect();
        Some(Lock { file, versions, pins, seen: BTreeMap::new(), files })
    }
}

/// Poetry and Pipfile tables: `name = "spec"` or `name = { version = "spec", ... }`; a `path`, `git`, `url` or
/// `file` source is not a public identity.
fn table_deps(t: Option<&Value>, out: &mut Vec<Req>) {
    let Some(t) = t.and_then(Value::as_table) else { return };
    for (name, v) in t {
        if name.eq_ignore_ascii_case("python") {
            continue;
        }
        match v {
            Value::String(s) => out.push((name.clone(), s.clone(), true)),
            Value::Table(x) => {
                let public = !["path", "git", "url", "file"].iter().any(|k| x.contains_key(*k));
                out.push((name.clone(), x.get("version").and_then(Value::as_str).unwrap_or("").to_string(), public));
            }
            // Poetry's multiple-constraints form: the lowest of the alternatives.
            Value::Array(a) => {
                let specs: Vec<&str> = a.iter().filter_map(|x| x.get("version").and_then(Value::as_str)).collect();
                out.push((name.clone(), specs.join(" || "), true));
            }
            _ => {}
        }
    }
}

fn pep508_list(v: Option<&Value>, out: &mut Vec<Req>) {
    for x in v.and_then(Value::as_array).into_iter().flatten() {
        // PEP 735 `{ include-group = "..." }` entries reference another group, which is read on its own.
        if let Some(s) = x.as_str() {
            out.extend(requirement(s));
        }
    }
}

/// Declared requirements of a `pyproject.toml`, and whether it names a distribution (a library candidate).
fn pyproject(text: &str) -> Option<(Vec<Req>, bool)> {
    let doc: Value = toml::from_str(text).ok()?;
    let mut out = vec![];
    let project = doc.get("project");
    pep508_list(project.and_then(|p| p.get("dependencies")), &mut out);
    for v in project.and_then(|p| p.get("optional-dependencies")).and_then(Value::as_table).into_iter().flat_map(|t| t.values()) {
        pep508_list(Some(v), &mut out);
    }
    for v in doc.get("dependency-groups").and_then(Value::as_table).into_iter().flat_map(|t| t.values()) {
        pep508_list(Some(v), &mut out);
    }
    let poetry = doc.get("tool").and_then(|t| t.get("poetry"));
    table_deps(poetry.and_then(|p| p.get("dependencies")), &mut out);
    table_deps(poetry.and_then(|p| p.get("dev-dependencies")), &mut out);
    for g in poetry.and_then(|p| p.get("group")).and_then(Value::as_table).into_iter().flat_map(|t| t.values()) {
        table_deps(g.get("dependencies"), &mut out);
    }
    let named = project.and_then(|p| p.get("name")).is_some() || poetry.and_then(|p| p.get("name")).is_some();
    Some((out, named))
}

/// A lockfile's pinned versions by normalised name.
#[derive(Debug, Clone)]
struct Lock {
    file: String,
    versions: BTreeMap<String, Version>,
    /// The pinned version as written and its `sha256:` file hashes, by normalised name.
    pins: BTreeMap<String, Pin>,
    /// Where it says each package came from, by normalised name (`privacy`), when it says.
    seen: BTreeMap<String, Seen>,
    /// For a set of pinned requirements files, the file pinning each package (relative to the project directory).
    files: BTreeMap<String, String>,
}

impl Lock {
    fn empty() -> Lock {
        Lock { file: String::new(), versions: BTreeMap::new(), pins: BTreeMap::new(), seen: BTreeMap::new(), files: BTreeMap::new() }
    }

    /// The file `n`'s version comes from, relative to the lock's directory.
    fn file_of(&self, n: &str) -> &str {
        self.files.get(n).unwrap_or(&self.file)
    }
}

/// A project directory as `detect` read it: its lockfile (empty unless it is a locked application) and what it declares.
struct Project {
    rel: String,
    lock: Lock,
    lock_file: String,
    declared: BTreeSet<String>,
}

/// Read `n` under `p` at its lockfile's version, which installs it without `p` declaring it (`why` says how).
fn attach(deps: &mut BTreeMap<String, Dep>, p: &Project, n: &str, why: &str) {
    let Some(v) = p.lock.versions.get(n) else { return };
    let entry = deps.entry(purl(n)).or_insert_with(|| Dep::new(n, true));
    if let Some(s) = p.lock.seen.get(n) {
        entry.seen = entry.seen.and(*s);
    }
    if let Some(pin) = p.lock.pins.get(n)
        && !entry.pins.contains(pin)
    {
        entry.pins.push(pin.clone());
    }
    entry.read_under(&p.rel, Some(v.clone()), format!("{} ({why})", p.lock.file_of(n)), false, None, Some(p.lock_file.clone()));
}

const LOCKFILES: &[&str] = &["uv.lock", "poetry.lock", "pdm.lock", "Pipfile.lock"];

/// Every lockfile in `dir` that parses.
fn read_locks(dir: &Path) -> Vec<Lock> {
    let mut out = vec![];
    for f in LOCKFILES {
        let Ok(text) = std::fs::read_to_string(dir.join(f)) else { continue };
        let mut versions = BTreeMap::new();
        let mut pins = BTreeMap::new();
        let mut seen: BTreeMap<String, Seen> = BTreeMap::new();
        let mut saw = |name: &str, s: Seen| {
            let e = seen.entry(normalize(name)).or_default();
            *e = e.and(s);
        };
        let mut pin = |name: &str, version: &str, hashes: Vec<String>| {
            let hashes: Vec<String> = hashes.into_iter().filter(|h| h.starts_with("sha256:")).collect();
            if !hashes.is_empty() {
                // The newest copy's, as for `versions`.
                let newer = |p: &Pin| parse_version(version).zip(parse_version(&p.version)).is_some_and(|(a, b)| a > b);
                let e = pins.entry(normalize(name)).or_insert_with(|| Pin { version: version.to_string(), hashes: hashes.clone() });
                if newer(e) {
                    *e = Pin { version: version.to_string(), hashes };
                }
            }
        };
        if *f == "Pipfile.lock" {
            let Ok(j) = serde_json::from_str::<Json>(&text) else { continue };
            // `_meta.sources` names each index; an entry's `index` says which one it came from.
            let sources: BTreeMap<&str, &str> = j
                .pointer("/_meta/sources")
                .and_then(Json::as_array)
                .into_iter()
                .flatten()
                .filter_map(|s| Some((s.get("name")?.as_str()?, s.get("url")?.as_str()?)))
                .collect();
            for section in ["default", "develop"] {
                for (name, v) in j.get(section).and_then(Json::as_object).into_iter().flatten() {
                    if let Some(i) = v.get("index").and_then(Json::as_str) {
                        saw(name, sources.get(i).map_or(Seen::Elsewhere, |u| Seen::pypi_url(u)));
                    } else if ["git", "path", "file", "editable"].iter().any(|k| v.get(*k).is_some()) {
                        saw(name, Seen::Elsewhere);
                    }
                    let Some(raw) = v.get("version").and_then(Json::as_str).map(|s| s.trim_start_matches("==")) else { continue };
                    if let Some(ver) = parse_version(raw) {
                        versions.entry(normalize(name)).or_insert(ver);
                    }
                    let hashes = v.get("hashes").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str).map(String::from).collect();
                    pin(name, raw, hashes);
                }
            }
        } else {
            let Ok(doc) = toml::from_str::<Value>(&text) else { continue };
            for p in doc.get("package").and_then(Value::as_array).into_iter().flatten() {
                let (Some(name), Some(ver)) = (p.get("name").and_then(Value::as_str), p.get("version").and_then(Value::as_str)) else { continue };
                // uv: `source = { registry = "<index>" }` (or git, a URL, a path). Poetry: no `[package.source]` for
                // PyPI, its URL for any other source. PDM says nothing here.
                match (*f, p.get("source")) {
                    ("uv.lock", Some(src)) => saw(name, src.get("registry").and_then(Value::as_str).map_or(Seen::Elsewhere, Seen::pypi_url)),
                    ("poetry.lock", Some(src)) => saw(name, src.get("url").and_then(Value::as_str).filter(|_| src.get("type").and_then(Value::as_str).is_none_or(|t| t == "legacy")).map_or(Seen::Elsewhere, Seen::pypi_url)),
                    ("poetry.lock", None) => saw(name, Seen::Public),
                    _ => {}
                }
                // A lock that holds several versions of one package forked it by environment marker (uv: an older
                // release kept for an interpreter the newer one dropped). The newest is the one the project is on
                // wherever it can be, so the funnel compares against it: the older copy cannot be upgraded where it
                // runs, and records up to the newest are already in the lock (Sphinx 9.1 dropping Python 3.11 in a
                // lock holding 9.0.4 for 3.11 and 9.1.0 for the rest).
                if let Some(v) = parse_version(ver) {
                    let e = versions.entry(normalize(name)).or_insert_with(|| v.clone());
                    if v > *e {
                        *e = v;
                    }
                }
                // uv: `sdist` and `wheels`; Poetry and PDM: `files`. Each entry's `hash` is `sha256:<hex>`.
                let files = p.get("sdist").into_iter().chain(["wheels", "files"].iter().filter_map(|k| p.get(*k)).filter_map(Value::as_array).flatten());
                let hashes = files.filter_map(|x| x.get("hash").and_then(Value::as_str)).map(String::from).collect();
                pin(name, ver, hashes);
            }
        }
        out.push(Lock { file: f.to_string(), versions, pins, seen, files: BTreeMap::new() });
    }
    out
}

/// The top-level modules each project's own Python code imports (application, tooling and test files), keyed by the
/// deepest project directory holding the file; and the repository's own module names (every `.py` stem and package
/// directory), which no import of a distribution is taken for.
fn imported_modules(root: &Path, projects: &BTreeSet<PathBuf>) -> (BTreeMap<PathBuf, BTreeSet<String>>, BTreeSet<String>) {
    let (mut out, mut own): (BTreeMap<PathBuf, BTreeSet<String>>, BTreeSet<String>) = (BTreeMap::new(), BTreeSet::new());
    for e in walker(root).flatten() {
        let path = e.path();
        if !e.file_type().is_some_and(|t| t.is_file()) || path.extension().is_none_or(|x| x != "py") {
            continue;
        }
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        if stem == "__init__" {
            own.extend(path.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().to_string()));
        } else {
            own.insert(stem);
        }
        let rel = path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/");
        if !matches!(path_role(&rel), Role::App | Role::Tooling | Role::Test) {
            continue;
        }
        let Some(project) = path.ancestors().skip(1).find(|a| projects.contains(*a)) else { continue };
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        out.entry(project.to_path_buf()).or_default().extend(import_roots(&text));
    }
    (out, own)
}

/// The top-level module of each absolute `import a.b, c as d` and `from a.b import x` statement at a line start.
fn import_roots(text: &str) -> Vec<String> {
    let mut out = vec![];
    let ident = |s: &str| s.split('.').next().map(str::trim).filter(|m| !m.is_empty() && m.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !m.starts_with(|c: char| c.is_ascii_digit())).map(String::from);
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("from ") {
            if let Some((m, _)) = rest.split_once(" import") {
                out.extend(ident(m.trim()));
            }
        } else if let Some(rest) = t.strip_prefix("import ") {
            let rest = rest.split('#').next().unwrap_or("");
            for part in rest.split(',') {
                out.extend(ident(part.split_whitespace().next().unwrap_or("")));
            }
        }
    }
    out
}

/// Whether `v` meets a requirement specifier: PEP 440 (`>=1.2,<2`, `~=1.4`, `==1.*`, `!=1.3`) or Poetry's npm-like
/// `^` / `~`. `None` when a part can't be read, so a caller keeps what it had.
pub fn spec_satisfies(v: &Version, spec: &str) -> Option<bool> {
    let mut all = true;
    for part in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let op_end = part.find(|c: char| c.is_ascii_alphanumeric() || c == '*').unwrap_or(part.len());
        let (op, ver) = part.split_at(op_end);
        let ver = ver.trim();
        all &= match op.trim() {
            "===" | "==" if ver.ends_with(".*") => crate::util::npm_satisfies(v, ver.trim_end_matches(".*"))?,
            "!=" if ver.ends_with(".*") => !crate::util::npm_satisfies(v, ver.trim_end_matches(".*"))?,
            "===" | "==" => crate::util::npm_satisfies(v, &format!("={}", parse_version(ver)?))?,
            "!=" => !crate::util::npm_satisfies(v, &format!("={}", parse_version(ver)?))?,
            "~=" => {
                // `~=1.4` admits 1.x from 1.4; `~=1.4.2` admits 1.4.x from 1.4.2.
                let n = ver.split('.').count();
                let base = parse_version(ver)?;
                let tilde = if n <= 2 { format!("^{}.{}", base.major, base.minor) } else { format!("~{base}") };
                crate::util::npm_satisfies(v, &format!(">={base} {tilde}"))?
            }
            ">=" | "<=" | ">" | "<" | "^" | "~" | "" => crate::util::npm_satisfies(v, part)?,
            _ => return None,
        };
    }
    Some(all)
}

/// Of several lockfiles beside a project (a switch of tool that left the old file behind), the one whose pins
/// the declared requirements admit, then the fixed order. A choice is recorded in `notes` once per directory.
fn choose_lock(rel: &str, mut cands: Vec<Lock>, reqs: &[Req], noted: &mut BTreeSet<String>, notes: &mut Vec<String>) -> Option<Lock> {
    if cands.len() < 2 {
        return cands.pop();
    }
    let score = |l: &Lock| {
        reqs.iter().fold((0usize, 0usize), |(out, ins), (n, spec, _)| match l.versions.get(&normalize(n)).and_then(|v| spec_satisfies(v, spec)) {
            Some(false) => (out + 1, ins),
            Some(true) => (out, ins + 1),
            None => (out, ins),
        })
    };
    let scores: Vec<(usize, usize)> = cands.iter().map(score).collect();
    let best = (0..cands.len()).min_by_key(|&i| (scores[i].0, std::cmp::Reverse(scores[i].1), i)).unwrap_or(0);
    if noted.insert(rel.to_string()) {
        let others: Vec<String> = (0..cands.len())
            .filter(|&i| i != best)
            .map(|i| format!("{} has {} of {} declared requirements outside their specifiers", cands[i].file, scores[i].0, reqs.len()))
            .collect();
        let file = if rel == "." { cands[best].file.clone() } else { format!("{rel}/{}", cands[best].file) };
        notes.push(format!("{rel}: {} lockfiles present; versions from {file} ({} of {} outside their specifiers); {}.", cands.len(), scores[best].0, reqs.len(), others.join("; ")));
    }
    Some(cands.swap_remove(best))
}

/// A requirements file: `requirements*.txt` or `.in`, or any `.txt` or `.in` in a `requirements*` directory
/// (`requirements/base.txt`, pontoon's `requirements/1-prod.txt`). Returns the project directory it belongs to: its
/// own, or for one in a `requirements*` directory, that directory's parent.
pub(crate) fn requirements_project(path: &Path) -> Option<&Path> {
    let base = path.file_name()?.to_string_lossy();
    if !(base.ends_with(".txt") || base.ends_with(".in")) {
        return None;
    }
    let dir = path.parent()?;
    if base.starts_with("requirements") {
        return Some(dir);
    }
    dir.file_name().is_some_and(|d| d.to_string_lossy().starts_with("requirements")).then(|| dir.parent()).flatten()
}

/// Python packages and their direct dependencies, merged into `deps` (keyed by package URL; the lowest version
/// wins, as for npm). Manifests in tests, examples, documentation, generated or vendored code are not the project's.
/// Reads the Python manifests below `root` into `packages` and `deps`. Returns the lowest Python version the
/// project supports and where that came from: the lowest floor among the `requires-python` (PEP 621) or Poetry
/// `python` ranges of the read `pyproject.toml` files a lockfile covers, else of all of them (as for Node's
/// `engines.node`: a standalone script project's range never sets a locked project's).
pub fn detect(root: &Path, packages: &mut Vec<Package>, deps: &mut BTreeMap<String, Dep>, notes: &mut Vec<String>) -> Option<(Version, String)> {
    // The lowest floor among locked projects, and among the others.
    let mut python: Option<(Version, String)> = None;
    let mut python_standalone: Option<(Version, String)> = None;
    // Per project directory: its manifests (file name, text), and its requirements files.
    let mut by_dir: BTreeMap<PathBuf, Vec<(String, String)>> = BTreeMap::new();
    let mut req_files: BTreeMap<PathBuf, Vec<PathBuf>> = BTreeMap::new();
    for e in walker(root).flatten() {
        if !e.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let base = e.file_name().to_string_lossy().to_string();
        let req_project = requirements_project(e.path());
        if !(base == "pyproject.toml" || base == "Pipfile" || req_project.is_some()) {
            continue;
        }
        let rel = e.path().strip_prefix(root).unwrap_or(e.path()).to_string_lossy().replace('\\', "/");
        if rel.contains("{{") || !matches!(path_role(&rel), Role::App | Role::Tooling) {
            continue;
        }
        if let Some(project) = req_project {
            req_files.entry(project.to_path_buf()).or_default().push(e.path().to_path_buf());
            by_dir.entry(project.to_path_buf()).or_default();
            continue;
        }
        let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
        by_dir.entry(e.path().parent().unwrap_or(root).to_path_buf()).or_default().push((base, text));
    }
    let mut locks: BTreeMap<PathBuf, Vec<Lock>> = BTreeMap::new();
    let mut seen_dirs = BTreeSet::new();
    let mut noted = BTreeSet::new();
    let mut stale: BTreeMap<String, (usize, Vec<String>)> = BTreeMap::new();
    let mut projects: BTreeMap<PathBuf, Project> = BTreeMap::new();
    let (imported, own_modules) = imported_modules(root, &by_dir.keys().cloned().collect());
    for (dir, files) in by_dir {
        let mut reqs = vec![];
        let mut named = false;
        let mut declared_python: Option<(Version, String)> = None;
        for (base, text) in &files {
            if base == "pyproject.toml" {
                if let Some((r, n)) = pyproject(text) {
                    reqs.extend(r);
                    named |= n;
                }
                if let Some((key, floor)) = requires_python(text) {
                    let rel = dir.strip_prefix(root).ok().map(|p| p.to_string_lossy().replace('\\', "/")).filter(|p| !p.is_empty());
                    declared_python = Some((floor, format!("{key} in {}", rel.map_or("pyproject.toml".into(), |r| format!("{r}/pyproject.toml")))));
                }
            } else if base == "Pipfile"
                && let Ok(doc) = toml::from_str::<Value>(text)
            {
                table_deps(doc.get("packages"), &mut reqs);
                table_deps(doc.get("dev-packages"), &mut reqs);
            }
        }
        // Requirements files, includes followed: their requirements are declared here, and their `==` pins are the
        // lock of the packages they pin, beside a lockfile in this directory or in place of one above it.
        let mut requirements = Requirements::default();
        let mut read = BTreeSet::new();
        let mut spans = vec![];
        for f in req_files.get(&dir).into_iter().flatten() {
            let start = requirements.reqs.len();
            requirements.read(root, &dir, f, false, &mut read);
            spans.push((f.canonicalize().ok(), start..requirements.reqs.len()));
        }
        // A file another one includes with `-c` constrains versions only, though found on its own too.
        for (f, span) in spans {
            if !f.is_some_and(|f| requirements.constrained.contains(&f)) {
                reqs.extend(requirements.reqs[span].iter().cloned());
            }
        }
        let pinned = requirements.lock();
        let has_requirements = req_files.contains_key(&dir);
        // A lockfile belongs to the project beside it; only a `pyproject.toml` member looks further up (a uv or
        // Poetry workspace keeps one lock at its root). Requirements alone use their own pins.
        let member = files.iter().any(|(b, _)| b == "pyproject.toml" || b == "Pipfile");
        let mut lock: Option<Lock> = None;
        let mut lock_dir = String::new();
        let mut d = Some(dir.as_path());
        while let Some(cur) = d {
            if !member && cur != dir {
                break;
            }
            let mut cands = locks.entry(cur.to_path_buf()).or_insert_with(|| read_locks(cur)).clone();
            if cur == dir {
                cands.extend(pinned.clone());
            }
            if !cands.is_empty() {
                let lrel = cur.strip_prefix(root).ok().map(|p| p.to_string_lossy().replace('\\', "/")).filter(|p| !p.is_empty()).unwrap_or_else(|| ".".into());
                lock_dir = lrel.clone();
                lock = choose_lock(&lrel, cands, &reqs, &mut noted, notes);
                break;
            }
            if cur == root {
                break;
            }
            d = cur.parent();
        }
        if let Some((floor, source)) = declared_python {
            let slot = if lock.is_some() { &mut python } else { &mut python_standalone };
            if slot.as_ref().is_none_or(|(p, _)| floor < *p) {
                *slot = Some((floor, source));
            }
        }
        // A distribution without a lockfile is published for others: read at its floor, like an npm library.
        let kind = if named && lock.is_none() && !has_requirements { Kind::Library } else { Kind::Application };
        let rel = dir.strip_prefix(root).ok().map(|p| p.to_string_lossy().replace('\\', "/")).filter(|p| !p.is_empty()).unwrap_or_else(|| ".".into());
        let declared: BTreeSet<String> = reqs.iter().map(|(n, _, _)| purl(n)).collect();
        if seen_dirs.insert(rel.clone()) {
            packages.push(Package { dir: rel.clone(), kind, lockfile: lock.as_ref().map(|l| l.file.clone()), declared: declared.clone(), own: None });
        }
        for (name, spec, public) in reqs {
            let n = normalize(&name);
            let (version, source, floor) = match (&lock, kind) {
                (Some(l), Kind::Application) if l.versions.contains_key(&n) => {
                    let v = &l.versions[&n];
                    // A pin the declared specifier no longer admits: the lockfile is out of date for this one.
                    if spec_satisfies(v, &spec) == Some(false) {
                        let s = stale.entry(if lock_dir == "." { l.file.clone() } else { format!("{lock_dir}/{}", l.file) }).or_default();
                        s.0 += 1;
                        if s.1.len() < 3 {
                            s.1.push(format!("{n} {v} vs {spec}"));
                        }
                        (spec_floor(&spec), format!("floor of {spec} ({} has {v}, outside the specifier)", l.file), true)
                    } else {
                        (Some(v.clone()), l.file_of(&n).to_string(), false)
                    }
                }
                (_, Kind::Library) => (spec_floor(&spec), format!("library floor of {spec}"), true),
                _ => (spec_floor(&spec), format!("floor of {spec} (not in a lockfile)"), true),
            };
            let entry = deps.entry(purl(&n)).or_insert_with(|| Dep::new(&n, public));
            // Nothing pins it here: `assume_newest` reads it at the newest release the range admits.
            let unpinned = public && !(lock.is_some() && kind == Kind::Application && lock.as_ref().is_some_and(|l| l.versions.contains_key(&n)));
            if unpinned && !entry.unpinned.contains(&(rel.clone(), spec.clone())) {
                entry.unpinned.push((rel.clone(), spec.clone()));
            }
            entry.public_candidate &= public;
            if let Some(s) = lock.as_ref().and_then(|l| l.seen.get(&n)) {
                entry.seen = entry.seen.and(*s);
            }
            if let Some(pin) = lock.as_ref().and_then(|l| l.pins.get(&n))
                && !entry.pins.contains(pin)
            {
                entry.pins.push(pin.clone());
            }
            let lock_file = lock.as_ref().map(|l| if lock_dir == "." { l.file.clone() } else { format!("{lock_dir}/{}", l.file) });
            entry.read_under(&rel, version, source, false, floor.then(|| crate::stack::Range::Pypi(spec.clone())), lock_file);
        }
        if let (Some(l), Kind::Application) = (lock, kind) {
            let lock_file = if lock_dir == "." { l.file.clone() } else { format!("{lock_dir}/{}", l.file) };
            projects.insert(dir.clone(), Project { rel: rel.clone(), lock: l, lock_file, declared: declared.clone() });
        } else {
            projects.insert(dir.clone(), Project { rel: rel.clone(), lock: Lock::empty(), lock_file: String::new(), declared: declared.clone() });
        }
    }
    // A package a project's own code imports that only a lockfile installs (through another dependency: `starlette`
    // under `fastapi`) is a dependency in practice: what changes in it reaches this code. Matched by the import's
    // top-level name as a distribution name, never a module of the repository's own. The file's deepest project
    // decides when it declares or locks the name; otherwise the enclosing project whose lockfile installs it does
    // (open-webui: `import certifi` under `backend/`, whose requirements files pin no certifi, while the root
    // `uv.lock` installs it for the same code).
    for (dir, mods) in &imported {
        for m in mods {
            let n = normalize(m);
            if own_modules.contains(m) {
                continue;
            }
            for p in dir.ancestors().filter_map(|a| projects.get(a)) {
                if p.declared.contains(&purl(&n)) {
                    break;
                }
                if p.lock.versions.contains_key(&n) {
                    attach(deps, p, &n, "imported here, installed through another dependency");
                    break;
                }
            }
        }
    }
    // A package a nested manifest declares that an enclosing project's lockfile installs only through another
    // dependency runs in that project at the lockfile's version: read there too, so the enclosing project (the root)
    // keeps its own version and the nested manifest is named beside it, as when both declare it (VoiceStudio: an
    // engine's `requirements.txt` pins rich 13.7.1, the root `uv.lock` installs rich 15.0.0 under another package).
    let names: Vec<(String, Vec<String>)> = deps
        .iter()
        .filter(|(k, _)| k.starts_with("pkg:pypi/"))
        .map(|(_, d)| (normalize(&d.name), d.readings.iter().map(|r| r.dir.clone()).collect()))
        .collect();
    for (n, dirs) in names {
        for p in projects.values() {
            let encloses = |d: &String| p.rel == "." || d.strip_prefix(p.rel.as_str()).is_some_and(|rest| rest.starts_with('/'));
            if dirs.contains(&p.rel) || !dirs.iter().any(encloses) || !p.lock.versions.contains_key(&n) {
                continue;
            }
            attach(deps, p, &n, "installed through another dependency");
        }
    }
    for (file, (n, examples)) in stale {
        notes.push(format!(
            "{file}: {n} pinned version{} outside the declared requirements ({}); read at the declared floor instead. The lockfile looks out of date.",
            if n == 1 { " falls" } else { "s fall" },
            examples.join(", ")
        ));
    }
    python.or(python_standalone)
}

/// Whether `spec` admits `v` (any alternative of Poetry's `||` form).
fn admits(v: &Version, spec: &str) -> bool {
    spec.split("||").any(|alt| spec_satisfies(v, alt.trim()) == Some(true))
}

/// The newest of `releases` that `spec` admits: what `pip install`, `uv pip install` or a fresh pnpm install resolves
/// for it today. A pre-release only when no final release is admitted (PEP 440: a package published only as `0.60b0`).
fn newest_by(releases: &[Version], spec: &str, admits: fn(&Version, &str) -> bool) -> Option<Version> {
    let ok: Vec<&Version> = releases.iter().filter(|v| admits(v, spec)).collect();
    ok.iter().filter(|v| v.pre.is_empty()).max().or_else(|| ok.iter().max()).map(|v| (*v).clone())
}

/// One registry `assume_newest_in` reads releases from: the package URLs it serves, how its ranges admit a version,
/// and how a note names what nothing pins.
pub struct Fresh {
    pub prefix: &'static str,
    pub registry: &'static str,
    /// A declaration nothing pins, singular and plural (`Python requirement`), and what does not pin it.
    pub what: (&'static str, &'static str),
    pub unpinned_by: &'static str,
    pub admits: fn(&Version, &str) -> bool,
    pub range: fn(String) -> crate::stack::Range,
}

pub const PYPI_FRESH: Fresh = Fresh {
    prefix: "pkg:pypi/",
    registry: "PyPI",
    what: ("Python requirement", "Python requirements"),
    unpinned_by: "no lockfile or pinned requirements file pins",
    admits,
    range: crate::stack::Range::Pypi,
};

/// Reads each declaration no lockfile or pinned requirements file pins (`Dep::unpinned`) at the newest release on
/// PyPI its specifier admits (`assume_newest_in`).
pub fn assume_newest(deps: &mut BTreeMap<String, Dep>, notes: &mut Vec<String>, releases: impl FnOnce(&[String]) -> BTreeMap<String, Vec<Version>>) {
    assume_newest_in(&PYPI_FRESH, deps, notes, releases)
}

/// Reads each declaration nothing pins (`Dep::unpinned`) at the newest release on its registry its range admits,
/// the version a fresh install gets (CI's `pip install -e .`, a pnpm workspace with `lockfile: false`), in place of
/// its declared floor, which is only the oldest version allowed: a floor is not what anyone installs, and an
/// unpinned requirement has no floor at all. The declared range stays on the reading (`Reading::range`), so what a
/// published library's users may install is still judged at its floor (`funnel::published_floor`). `releases` gives
/// the public releases of the asked package URLs; a package it has none for keeps its floor (unpinned: no version).
/// Said once in `notes`, with the floors kept.
pub fn assume_newest_in(eco: &Fresh, deps: &mut BTreeMap<String, Dep>, notes: &mut Vec<String>, releases: impl FnOnce(&[String]) -> BTreeMap<String, Vec<Version>>) {
    let want: Vec<String> = deps.iter().filter(|(p, d)| p.starts_with(eco.prefix) && d.public_candidate && !d.unpinned.is_empty()).map(|(p, _)| p.clone()).collect();
    if want.is_empty() {
        return;
    }
    let got = releases(&want);
    let (mut newest, mut floors) = (vec![], vec![]);
    for p in &want {
        let Some(d) = deps.get_mut(p) else { continue };
        // Per directory, the lowest of its declarations' newest admitted releases (as `read_under` keeps the lowest).
        let mut by_dir: BTreeMap<String, (Version, String)> = BTreeMap::new();
        for (dir, spec) in &d.unpinned {
            let Some(v) = got.get(p).and_then(|r| newest_by(r, spec, eco.admits)) else { continue };
            match by_dir.get(dir) {
                Some((old, _)) if *old <= v => {}
                _ => {
                    by_dir.insert(dir.clone(), (v, spec.clone()));
                }
            }
        }
        if by_dir.is_empty() {
            if d.readings.iter().any(|r| r.range.is_some() && r.lock.is_none()) {
                floors.push(d.name.clone());
            }
            continue;
        }
        let reg = eco.registry;
        for (dir, (v, spec)) in by_dir {
            let source = if spec.trim().is_empty() {
                format!("newest release {v} on {reg} (unpinned, nothing pins it: what a fresh install resolves)")
            } else {
                format!("newest release {v} on {reg} that {spec} admits (nothing pins it: what a fresh install resolves)")
            };
            match d.readings.iter_mut().find(|r| r.dir == dir) {
                // A floor reading; a pinned reading of the same directory stays.
                Some(r) if r.range.is_some() && r.lock.is_none() => {
                    r.version = v;
                    r.source = source;
                }
                Some(_) => {}
                None => d.readings.push(crate::stack::Reading { dir, version: v, source, standalone: false, range: Some((eco.range)(spec)), lock: None }),
            }
        }
        // Named when no manifest pins it: a workspace member's unpinned declaration beside a pinned one sets nothing.
        if !d.readings.iter().any(|r| r.range.is_none()) {
            newest.push(d.name.clone());
        }
    }
    let list = |names: &[String]| {
        let more = if names.len() > 8 { format!(" and {} more", names.len() - 8) } else { String::new() };
        format!("{}{more}", names.iter().take(8).cloned().collect::<Vec<_>>().join(", "))
    };
    let what = |n: usize| if n == 1 { eco.what.0 } else { eco.what.1 };
    if !newest.is_empty() {
        notes.push(format!(
            "{} {} {} ({}): read at the newest release on {} {} declared range admits, what a fresh install resolves, not an installed version. A published library's floor is still checked for what its users may install.",
            newest.len(),
            what(newest.len()),
            eco.unpinned_by,
            list(&newest),
            eco.registry,
            if newest.len() == 1 { "its" } else { "each one's" },
        ));
    }
    if !floors.is_empty() {
        notes.push(format!(
            "{} {} {} and whose releases were not read ({}): read at {} declared floor, the oldest version allowed, not an installed version.",
            floors.len(),
            what(floors.len()),
            eco.unpinned_by,
            list(&floors),
            if floors.len() == 1 { "its" } else { "their" },
        ));
    }
}

/// How long a package's release list is reused (`assume_newest`).
const RELEASES_FRESH_SECS: u64 = 24 * 3600;

/// The public releases of PyPI packages (versions with at least one file not yanked), from `pypi.org/pypi/<name>/json`,
/// cached for a day under the cache directory. None with `UNSTALE_NO_REGISTRY=1`, and none in tests.
pub fn registry_releases(purls: &[String]) -> BTreeMap<String, Vec<Version>> {
    cached_releases(purls, "pypi-releases", parse_version, |agent, purl| {
        let name = purl.trim_start_matches("pkg:pypi/");
        let mut r = agent.get(format!("https://pypi.org/pypi/{name}/json")).call().ok().filter(|r| r.status().is_success())?;
        let bytes = r.body_mut().with_config().limit(64 * 1024 * 1024).read_to_vec().ok()?;
        let doc: Json = serde_json::from_slice(&bytes).ok()?;
        let releases = doc.get("releases")?.as_object()?;
        Some(
            releases
                .iter()
                .filter(|(_, files)| files.as_array().is_some_and(|f| f.iter().any(|x| x.get("yanked") != Some(&Json::Bool(true)))))
                .map(|(v, _)| v.clone())
                .collect(),
        )
    })
}

/// The published versions of public npm packages, from the registry's abbreviated document
/// (`application/vnd.npm.install-v1+json`, what package managers resolve from), cached for a day like
/// `registry_releases`. None with `UNSTALE_NO_REGISTRY=1`, and none in tests.
pub fn npm_registry_releases(purls: &[String]) -> BTreeMap<String, Vec<Version>> {
    cached_releases(purls, "npm-releases", crate::util::parse_version, |agent, purl| {
        let name = crate::util::npm_name(purl)?;
        let enc: String = name.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~@".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
        let mut r = agent
            .get(format!("https://registry.npmjs.org/{enc}"))
            .header("Accept", "application/vnd.npm.install-v1+json")
            .call()
            .ok()
            .filter(|r| r.status().is_success())?;
        let bytes = r.body_mut().with_config().limit(64 * 1024 * 1024).read_to_vec().ok()?;
        let doc: Json = serde_json::from_slice(&bytes).ok()?;
        Some(doc.get("versions")?.as_object()?.keys().cloned().collect())
    })
}

/// Release lists per package URL, each fetched by `fetch` at most once a day (cached under `sub` in the cache
/// directory).
fn cached_releases(
    purls: &[String],
    sub: &str,
    parse_one: fn(&str) -> Option<Version>,
    fetch: impl Fn(&ureq::Agent, &str) -> Option<Vec<String>> + Sync,
) -> BTreeMap<String, Vec<Version>> {
    let mut out = BTreeMap::new();
    if cfg!(test) || crate::privacy::registry_off() {
        return out;
    }
    let dir = crate::cache::cache_dir().join(sub);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let path = |purl: &str| {
        let key: String = purl.split_once('/').map_or(purl, |(_, n)| n).bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
        dir.join(format!("{}.json", key.to_lowercase()))
    };
    let parse = |vs: &[String]| vs.iter().filter_map(|v| parse_one(v)).collect::<Vec<_>>();
    let mut due = vec![];
    for p in purls {
        let cached = std::fs::read(path(p)).ok().and_then(|b| serde_json::from_slice::<Json>(&b).ok());
        match cached {
            Some(c) if now.saturating_sub(c.get("checked").and_then(Json::as_u64).unwrap_or(0)) < RELEASES_FRESH_SECS => {
                let vs: Vec<String> = c.get("versions").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str).map(String::from).collect();
                out.insert(p.clone(), parse(&vs));
            }
            _ => due.push(p.clone()),
        }
    }
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(std::time::Duration::from_secs(15))).build().into();
    crate::util::concurrent(&due, crate::util::REQUESTS_AT_ONCE, |p: &String| fetch(&agent, p), |i, got| {
        if let Some(vs) = got {
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(b) = serde_json::to_vec(&serde_json::json!({ "checked": now, "versions": vs })) {
                let _ = crate::util::write_atomic(&path(&due[i]), &b);
            }
            out.insert(due[i].clone(), parse(&vs));
        }
        true
    });
    out
}

/// A `pyproject.toml`'s declared Python range, as `<key> <range>`, and its floor: PEP 621 `requires-python`, else
/// Poetry's `python` dependency (`^3.11`).
fn requires_python(text: &str) -> Option<(String, Version)> {
    let doc: Value = toml::from_str(text).ok()?;
    let pep621 = doc.get("project").and_then(|p| p.get("requires-python")).and_then(Value::as_str).map(|s| ("requires-python", s));
    let poetry = || doc.get("tool").and_then(|t| t.get("poetry")).and_then(|p| p.get("dependencies")).and_then(|d| d.get("python")).and_then(Value::as_str).map(|s| ("Poetry python", s));
    let (key, spec) = pep621.or_else(poetry)?;
    let floor = spec_floor(spec.trim())?;
    Some((format!("{key} {}", spec.trim()), floor))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn the_declared_python_floor_is_read() {
        assert_eq!(requires_python("[project]\nname = \"a\"\nrequires-python = \">=3.12\"\n"), Some(("requires-python >=3.12".into(), v("3.12.0"))));
        assert_eq!(requires_python("[tool.poetry.dependencies]\npython = \"^3.11\"\n"), Some(("Poetry python ^3.11".into(), v("3.11.0"))));
        assert!(requires_python("[project]\nname = \"a\"\n").is_none());
        // A locked project's range wins over a standalone script project's lower one.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "app/pyproject.toml", "[project]\nname = \"app\"\nrequires-python = \">=3.12\"\ndependencies = [\"httpx\"]\n");
        write(d.path(), "app/uv.lock", "version = 1\n\n[[package]]\nname = \"httpx\"\nversion = \"0.28.1\"\nsource = { registry = \"https://pypi.org/simple\" }\n");
        write(d.path(), "scripts/tool/pyproject.toml", "[project]\nname = \"tool\"\nrequires-python = \">=3.9\"\ndependencies = [\"rich\"]\n");
        let (mut pk, mut deps) = (vec![], BTreeMap::new());
        assert_eq!(detect(d.path(), &mut pk, &mut deps, &mut vec![]), Some((v("3.12.0"), "requires-python >=3.12 in app/pyproject.toml".into())));
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "pyproject.toml", "[project]\nname = \"a\"\nrequires-python = \">=3.12\"\n");
        write(d.path(), "tools/pyproject.toml", "[project]\nname = \"b\"\nrequires-python = \">=3.10\"\n");
        let (mut pk, mut deps) = (vec![], BTreeMap::new());
        assert_eq!(detect(d.path(), &mut pk, &mut deps, &mut vec![]), Some((v("3.10.0"), "requires-python >=3.10 in tools/pyproject.toml".into())), "no lock: the lowest");
    }

    #[test]
    fn names_and_purls_are_pep503() {
        assert_eq!(normalize("Typing_Extensions"), "typing-extensions");
        assert_eq!(normalize("zope.interface"), "zope-interface");
        assert_eq!(purl("SQLAlchemy"), "pkg:pypi/sqlalchemy");
    }

    #[test]
    fn pep440_versions_keep_their_order() {
        assert_eq!(parse_version("0.27.10"), Some(v("0.27.10")));
        assert_eq!(parse_version("2.0"), Some(v("2.0.0")));
        assert_eq!(parse_version("1!2.3.4+local"), Some(v("2.3.4")));
        let order = ["1.0.0.dev1", "1.0.0a1", "1.0.0b2", "1.0.0rc1", "1.0.0", "1.0.1"];
        let parsed: Vec<Version> = order.iter().map(|s| parse_version(s).unwrap()).collect();
        assert!(parsed.windows(2).all(|w| w[0] < w[1]), "{parsed:?}");
        assert_eq!(parse_version("1.0.post2").unwrap().cmp_precedence(&v("1.0.0")), std::cmp::Ordering::Equal);
        assert_eq!(parse_version("2024.10.1.3"), Some(v("2024.10.1")));
        assert_eq!(parse_version("latest"), None);
    }

    #[test]
    fn specifier_floors() {
        assert_eq!(spec_floor(">=1.2,<2"), Some(v("1.2.0")));
        assert_eq!(spec_floor("~=1.4.2"), Some(v("1.4.2")));
        assert_eq!(spec_floor("==2.31.*"), Some(v("2.31.0")));
        assert_eq!(spec_floor("^0.27.6"), Some(v("0.27.6")));
        assert_eq!(spec_floor("1.2.3"), Some(v("1.2.3")));
        assert_eq!(spec_floor(">=3.8 || ^2.7"), Some(v("2.7.0")));
        assert_eq!(spec_floor("*"), None);
        assert_eq!(spec_floor("<2"), None);
    }

    #[test]
    fn requirements_lines() {
        let r = requirements_txt(
            "# pinned\nopenai==0.27.10\nrequests[socks] >= 2.31 ; python_version >= '3.8'\n-r base.txt\n-e .\nmypkg @ git+https://x/y.git\n./local\nflask \\\n  >=3.0\nnumpy==1.26.4 --hash=sha256:abc\n",
        );
        let names: Vec<(&str, &str, bool)> = r.iter().map(|(n, s, p)| (n.as_str(), s.as_str(), *p)).collect();
        assert_eq!(
            names,
            vec![("openai", "==0.27.10", true), ("requests", ">= 2.31", true), ("mypkg", "", false), ("flask", ">=3.0", true), ("numpy", "==1.26.4", true)]
        );
    }

    fn write(d: &Path, p: &str, t: &str) {
        let p = d.join(p);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, t).unwrap();
    }

    #[test]
    fn lockfiles_pin_versions_with_their_file_hashes() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "pyproject.toml", "[project]\nname = \"app\"\ndependencies = [\"acme-tools>=2\", \"httpx>=0.27\"]\n");
        write(d.path(), "uv.lock", "version = 1\n\n[[package]]\nname = \"acme-tools\"\nversion = \"2.0\"\nsource = { registry = \"https://pypi.acme.internal/simple\" }\nsdist = { url = \"https://x/acme-tools-2.0.tar.gz\", hash = \"sha256:aa\", size = 1 }\nwheels = [{ url = \"https://x/acme_tools-2.0-py3-none-any.whl\", hash = \"sha256:bb\", size = 1 }]\n\n[[package]]\nname = \"httpx\"\nversion = \"0.27.0\"\nsource = { registry = \"https://pypi.org/simple\" }\n");
        let (mut packages, mut deps, mut notes) = (vec![], BTreeMap::new(), vec![]);
        detect(d.path(), &mut packages, &mut deps, &mut notes);
        crate::stack::settle(&mut deps);
        assert_eq!(deps["pkg:pypi/acme-tools"].pins, vec![Pin { version: "2.0".into(), hashes: vec!["sha256:aa".into(), "sha256:bb".into()] }]);
        assert!(deps["pkg:pypi/httpx"].pins.is_empty(), "no hashes in the lockfile");
    }

    #[test]
    fn a_locked_package_the_code_imports_is_a_dependency_even_when_only_another_installs_it() {
        // Significant-Gravitas/AutoGPT: `from starlette.types import ASGIApp` with only `fastapi` declared; poetry.lock
        // installs starlette through it.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "backend/pyproject.toml", "[tool.poetry]\nname = \"app\"\n[tool.poetry.dependencies]\nfastapi = \"^0.115\"\n");
        let lock = ["fastapi", "starlette", "anyio", "helpers"].map(|n| format!("[[package]]\nname = \"{n}\"\nversion = \"1.0.0\"\n")).concat();
        write(d.path(), "backend/poetry.lock", &lock);
        write(d.path(), "backend/app/main.py", "import os, json\nfrom starlette.types import ASGIApp\nfrom . import helpers\nimport helpers\n");
        write(d.path(), "backend/helpers.py", "x = 1\n");
        write(d.path(), "tools/other.py", "import anyio\n");
        let (mut pk, mut deps) = (vec![], BTreeMap::new());
        detect(d.path(), &mut pk, &mut deps, &mut vec![]);
        crate::stack::settle(&mut deps);
        assert_eq!(deps["pkg:pypi/starlette"].version, Some(v("1.0.0")));
        assert!(deps["pkg:pypi/starlette"].public_candidate);
        assert!(!pk[0].declared.contains("pkg:pypi/starlette"), "used, not declared");
        assert!(!deps.contains_key("pkg:pypi/helpers"), "a module of the repository's own");
        assert!(!deps.contains_key("pkg:pypi/anyio"), "imported outside the project the lockfile installs");
    }

    #[test]
    fn an_import_falls_back_to_the_enclosing_lockfile_when_its_own_project_pins_nothing_for_it() {
        // open-webui: `backend/requirements.txt` pins no certifi; the root `uv.lock` installs it and the code under
        // `backend/` imports it.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "pyproject.toml", "[project]\nname = \"app\"\ndependencies = [\"requests\"]\n");
        write(d.path(), "uv.lock", "version = 1\n\n[[package]]\nname = \"requests\"\nversion = \"2.32.0\"\n\n[[package]]\nname = \"certifi\"\nversion = \"2026.6.17\"\n");
        write(d.path(), "backend/requirements.txt", "requests==2.32.0\n");
        write(d.path(), "backend/app/tls.py", "import certifi\n");
        let (mut pk, mut deps) = (vec![], BTreeMap::new());
        detect(d.path(), &mut pk, &mut deps, &mut vec![]);
        crate::stack::settle(&mut deps);
        let c = &deps["pkg:pypi/certifi"];
        assert_eq!(c.version, Some(v("2026.6.17")));
        assert_eq!(c.readings.iter().map(|r| r.dir.as_str()).collect::<Vec<_>>(), vec!["."]);
    }

    #[test]
    fn a_nested_pin_of_a_package_the_root_lockfile_installs_transitively_keeps_the_root_version() {
        // VoiceStudio: an engine's `requirements.txt` pins rich 13.7.1; the root `uv.lock` installs rich 15.0.0 under
        // another package. The root reads its own version and the engine is named beside it.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "pyproject.toml", "[project]\nname = \"app\"\ndependencies = [\"typer\"]\n");
        write(d.path(), "uv.lock", "version = 1\n\n[[package]]\nname = \"typer\"\nversion = \"0.12.0\"\n\n[[package]]\nname = \"rich\"\nversion = \"15.0.0\"\n");
        write(d.path(), "engines/x/requirements.txt", "rich==13.7.1\nonly-here==1.0\n");
        write(d.path(), "tools/y/requirements.txt", "rich==12.0.0\n");
        let (mut pk, mut deps) = (vec![], BTreeMap::new());
        detect(d.path(), &mut pk, &mut deps, &mut vec![]);
        crate::stack::settle(&mut deps);
        let r = &deps["pkg:pypi/rich"];
        assert_eq!(r.version, Some(v("15.0.0")), "the root's lockfile");
        let mut dirs: Vec<(&str, String)> = r.readings.iter().map(|x| (x.dir.as_str(), x.version.to_string())).collect();
        dirs.sort();
        assert_eq!(dirs, vec![(".", "15.0.0".into()), ("engines/x", "13.7.1".into()), ("tools/y", "12.0.0".into())]);
        assert_eq!(deps["pkg:pypi/only-here"].readings.len(), 1, "the root lockfile does not install it");
        assert!(!pk.iter().find(|p| p.dir == ".").unwrap().declared.contains("pkg:pypi/rich"), "installed, not declared");
    }

    #[test]
    fn import_roots_are_top_level_absolute_modules() {
        assert_eq!(import_roots("import a.b, c as d\nfrom e.f import g\nfrom . import h\nfrom .i import j\n  import k  # x\nimportant = 1\n"), vec!["a", "c", "e", "k"]);
    }

    #[test]
    fn poetry_application_reads_the_lockfile() {
        let d = tempfile::tempdir().unwrap();
        write(
            d.path(),
            "pyproject.toml",
            "[tool.poetry]\nname = \"app\"\n[tool.poetry.dependencies]\npython = \"^3.11\"\nopenai = \"^0.27.6\"\nlocal = { path = \"../local\" }\n[tool.poetry.group.dev.dependencies]\npytest = \">=7\"\n",
        );
        write(d.path(), "poetry.lock", "[[package]]\nname = \"openai\"\nversion = \"0.27.10\"\n[[package]]\nname = \"pytest\"\nversion = \"8.3.2\"\n");
        write(d.path(), "examples/demo/requirements.txt", "django==5.0\n");
        let (mut pk, mut deps) = (vec![], BTreeMap::new());
        detect(d.path(), &mut pk, &mut deps, &mut vec![]);
        crate::stack::settle(&mut deps);
        assert_eq!(pk.len(), 1);
        assert_eq!(pk[0].kind, Kind::Application);
        assert_eq!(deps["pkg:pypi/openai"].version, Some(v("0.27.10")));
        assert_eq!(deps["pkg:pypi/openai"].source, "poetry.lock");
        assert_eq!(deps["pkg:pypi/pytest"].version, Some(v("8.3.2")));
        assert!(!deps["pkg:pypi/local"].public_candidate);
        assert!(!deps.contains_key("pkg:pypi/python"));
        assert!(!deps.contains_key("pkg:pypi/django"), "an example's requirements are not the project's");
    }

    #[test]
    fn stale_lockfile_beside_the_real_one_is_not_read() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "pyproject.toml", "[project]\nname = \"app\"\ndependencies = [\"fastapi>=0.115,<1\", \"openai~=1.40\"]\n");
        // uv.lock sorts first but predates the bump; poetry.lock matches.
        write(d.path(), "uv.lock", "[[package]]\nname = \"fastapi\"\nversion = \"0.110.0\"\n[[package]]\nname = \"openai\"\nversion = \"0.27.6\"\n");
        write(d.path(), "poetry.lock", "[[package]]\nname = \"fastapi\"\nversion = \"0.115.4\"\n[[package]]\nname = \"openai\"\nversion = \"1.52.0\"\n");
        let (mut pk, mut deps, mut notes) = (vec![], BTreeMap::new(), vec![]);
        detect(d.path(), &mut pk, &mut deps, &mut notes);
        crate::stack::settle(&mut deps);
        assert_eq!(deps["pkg:pypi/openai"].version, Some(v("1.52.0")));
        assert_eq!(pk[0].lockfile.as_deref(), Some("poetry.lock"));
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(notes[0].contains("versions from poetry.lock") && notes[0].contains("uv.lock has 2 of 2"), "{}", notes[0]);
    }

    #[test]
    fn pin_outside_the_specifier_falls_back_to_the_floor() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "pyproject.toml", "[tool.poetry]\nname = \"app\"\n[tool.poetry.dependencies]\nopenai = \"^1.40\"\nboto3 = \"^1.34\"\n");
        write(d.path(), "poetry.lock", "[[package]]\nname = \"openai\"\nversion = \"0.27.10\"\n[[package]]\nname = \"boto3\"\nversion = \"1.34.117\"\n");
        let (mut pk, mut deps, mut notes) = (vec![], BTreeMap::new(), vec![]);
        detect(d.path(), &mut pk, &mut deps, &mut notes);
        crate::stack::settle(&mut deps);
        assert_eq!(deps["pkg:pypi/openai"].version, Some(v("1.40.0")));
        assert_eq!(deps["pkg:pypi/boto3"].version, Some(v("1.34.117")));
        assert!(notes[0].starts_with("poetry.lock: 1 pinned version falls outside"), "{}", notes[0]);
    }

    #[test]
    fn spec_satisfies_pep440_and_poetry() {
        let ok = |a: &str, s: &str| spec_satisfies(&v(a), s);
        assert_eq!(ok("1.5.0", ">=1.2,<2"), Some(true));
        assert_eq!(ok("2.0.0", ">=1.2,<2"), Some(false));
        assert_eq!(ok("1.9.0", "~=1.4"), Some(true));
        assert_eq!(ok("2.0.0", "~=1.4"), Some(false));
        assert_eq!(ok("1.4.9", "~=1.4.2"), Some(true));
        assert_eq!(ok("1.5.0", "~=1.4.2"), Some(false));
        assert_eq!(ok("1.3.7", "==1.3.*"), Some(true));
        assert_eq!(ok("1.3.0", "!=1.3.0"), Some(false));
        assert_eq!(ok("3.9.5", "==3.9.5"), Some(true));
        assert_eq!(ok("0.27.10", "^1.40"), Some(false));
        assert_eq!(ok("1.0.0", ""), Some(true));
        assert_eq!(ok("1.0.0", "@ https://x"), None);
    }

    #[test]
    fn requirements_alone_use_their_own_pins_not_a_parent_lock() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "pyproject.toml", "[tool.poetry]\nname = \"app\"\n[tool.poetry.dependencies]\nopenai = \"^0.27\"\n");
        write(d.path(), "poetry.lock", "[[package]]\nname = \"openai\"\nversion = \"0.27.10\"\n[[package]]\nname = \"httpx\"\nversion = \"0.24.0\"\n");
        write(d.path(), "sandbox/runtime/requirements.txt", "httpx==0.28.1\n");
        let (mut pk, mut deps) = (vec![], BTreeMap::new());
        detect(d.path(), &mut pk, &mut deps, &mut vec![]);
        crate::stack::settle(&mut deps);
        // The sandbox reads its own pin; the root's poetry.lock installs httpx too (through openai), so the root keeps
        // its version and the sandbox is named beside it.
        let h = &deps["pkg:pypi/httpx"];
        assert_eq!(h.version, Some(v("0.24.0")));
        assert!(h.readings.iter().any(|r| r.dir == "sandbox/runtime" && r.version == v("0.28.1")));
        assert_eq!(pk.iter().find(|p| p.dir == "sandbox/runtime").unwrap().lockfile.as_deref(), Some("requirements.txt"), "its own pins, not the parent poetry.lock");
    }

    #[test]
    fn a_lock_forked_by_marker_is_read_at_its_newest_copy() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "pyproject.toml", "[project]\nname = \"app\"\nrequires-python = \">=3.11\"\ndependencies = [\"sphinx>=7.4.7,<10\"]\n");
        write(
            d.path(),
            "uv.lock",
            "version = 1\n[[package]]\nname = \"sphinx\"\nversion = \"9.0.4\"\nsource = { registry = \"https://pypi.org/simple\" }\nresolution-markers = [\"python_full_version < '3.12'\"]\n[[package]]\nname = \"sphinx\"\nversion = \"9.1.0\"\nsource = { registry = \"https://pypi.org/simple\" }\nresolution-markers = [\"python_full_version >= '3.12'\"]\n",
        );
        let (mut pk, mut deps) = (vec![], BTreeMap::new());
        detect(d.path(), &mut pk, &mut deps, &mut vec![]);
        crate::stack::settle(&mut deps);
        assert_eq!(deps["pkg:pypi/sphinx"].version, Some(v("9.1.0")), "9.0.4 is kept only for the interpreter 9.1 dropped");
    }

    #[test]
    fn pep621_library_without_lock_reads_floors_and_uv_lock_pins() {
        let d = tempfile::tempdir().unwrap();
        write(
            d.path(),
            "lib/pyproject.toml",
            "[project]\nname = \"lib\"\nversion = \"1.0\"\ndependencies = [\"httpx>=0.27,<1\", \"pydantic[email]~=2.7\"]\n[project.optional-dependencies]\ncli = [\"rich>=13\"]\n[dependency-groups]\ndev = [\"ruff==0.6.0\", { include-group = \"x\" }]\n",
        );
        write(d.path(), "svc/pyproject.toml", "[project]\nname = \"svc\"\ndependencies = [\"httpx>=0.25\"]\n");
        write(d.path(), "svc/uv.lock", "version = 1\n[[package]]\nname = \"httpx\"\nversion = \"0.28.1\"\n");
        let (mut pk, mut deps) = (vec![], BTreeMap::new());
        detect(d.path(), &mut pk, &mut deps, &mut vec![]);
        crate::stack::settle(&mut deps);
        let kinds: Vec<(&str, Kind)> = pk.iter().map(|p| (p.dir.as_str(), p.kind)).collect();
        assert_eq!(kinds, vec![("lib", Kind::Library), ("svc", Kind::Application)]);
        assert_eq!(deps["pkg:pypi/httpx"].version, Some(v("0.27.0")), "the lowest across packages: the library's floor");
        assert_eq!(deps["pkg:pypi/pydantic"].version, Some(v("2.7.0")));
        assert_eq!(deps["pkg:pypi/rich"].version, Some(v("13.0.0")));
        assert_eq!(deps["pkg:pypi/ruff"].version, Some(v("0.6.0")));
    }

    #[test]
    fn compiled_requirements_under_a_requirements_dir_pin_the_pyproject() {
        // apache/superset: pyproject ranges, `uv pip compile` output under requirements/ (what CI installs).
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "pyproject.toml", "[project]\nname = \"app\"\ndependencies = [\"flask>=2.2.5,<4\", \"mcp>=1.29\", \"fastapi\"]\n");
        write(d.path(), "requirements/base.in", "-e .\n");
        write(
            d.path(),
            "requirements/base.txt",
            "# autogenerated by uv via: uv pip compile requirements/base.in\n-e .\n    # via -r requirements/base.in\nflask==3.1.3 \\\n    --hash=sha256:aa\n    # via\n    #   app (pyproject.toml)\nwerkzeug==3.1.0\n    # via flask\n",
        );
        write(d.path(), "requirements/development.txt", "-c base.txt\nmcp==2.3.0\n    # via\n    #   -c requirements/base.txt\n    #   app (pyproject.toml)\n");
        let (mut pk, mut deps) = (vec![], BTreeMap::new());
        let mut notes = vec![];
        detect(d.path(), &mut pk, &mut deps, &mut notes);
        crate::stack::settle(&mut deps);
        assert_eq!(pk.iter().map(|p| (p.dir.as_str(), p.kind)).collect::<Vec<_>>(), vec![(".", Kind::Application)]);
        assert_eq!(deps["pkg:pypi/flask"].version, Some(v("3.1.3")), "the pin, not the 2.2.5 floor");
        assert_eq!(deps["pkg:pypi/flask"].source, "requirements/base.txt");
        assert_eq!(deps["pkg:pypi/flask"].pins[0].hashes, vec!["sha256:aa".to_string()]);
        assert_eq!(deps["pkg:pypi/mcp"].version, Some(v("2.3.0")));
        assert!(!deps.contains_key("pkg:pypi/werkzeug"), "a compiled entry another package pulls in is not declared");
        assert!(deps["pkg:pypi/fastapi"].unpinned == vec![(".".to_string(), String::new())] && deps["pkg:pypi/fastapi"].version.is_none());
        assert!(deps["pkg:pypi/flask"].unpinned.is_empty());
    }

    #[test]
    fn requirements_includes_are_followed() {
        // mozilla/pontoon: requirements.txt is `-r requirements/1-prod.txt`; the inputs are `.in` files.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "requirements.txt", "# Heroku\n-r requirements/1-prod.txt\n");
        write(d.path(), "requirements/0-base.in", "Django==5.2.18\n");
        write(d.path(), "requirements/1-prod.in", "-r 0-base.in\ngunicorn==23.0.0\n");
        write(d.path(), "requirements/1-prod.txt", "django==5.2.18 \\\n    --hash=sha256:bb\n    # via -r requirements/0-base.in\ngunicorn==23.0.0\n    # via -r requirements/1-prod.in\nasgiref==3.11.1\n    # via django\n");
        let (mut pk, mut deps) = (vec![], BTreeMap::new());
        detect(d.path(), &mut pk, &mut deps, &mut vec![]);
        crate::stack::settle(&mut deps);
        assert_eq!(deps["pkg:pypi/django"].version, Some(v("5.2.18")));
        assert_eq!(deps["pkg:pypi/gunicorn"].version, Some(v("23.0.0")));
        assert!(deps["pkg:pypi/django"].readings.iter().all(|r| r.range.is_none()), "a pin is installed, not a floor");
        assert!(!deps.contains_key("pkg:pypi/asgiref"));
        assert_eq!(pk[0].lockfile.as_deref(), Some("requirements/0-base.in"));
    }

    #[test]
    fn unpinned_requirements_read_at_the_newest_release_their_range_admits() {
        // agentscope: a pyproject-only library. Floors and unpinned names read as a fresh install resolves them.
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "pyproject.toml", "[project]\nname = \"lib\"\ndependencies = [\"mcp>=2.0.0\", \"fastapi\", \"textual>=8.2,<9\", \"gone>=1\", \"semconv\"]\n");
        let (mut pk, mut deps) = (vec![], BTreeMap::new());
        let mut notes = vec![];
        detect(d.path(), &mut pk, &mut deps, &mut notes);
        assert_eq!(pk[0].kind, Kind::Library);
        let releases = |purls: &[String]| {
            let mut m = BTreeMap::new();
            for p in purls {
                let vs: &[&str] = match p.as_str() {
                    "pkg:pypi/mcp" => &["1.9.0", "2.0.0", "2.3.0", "3.0.0rc1"],
                    "pkg:pypi/fastapi" => &["0.110.0", "0.162.0"],
                    "pkg:pypi/textual" => &["8.2.0", "8.9.1", "9.0.0"],
                    "pkg:pypi/semconv" => &["0.59b0", "0.60b0"],
                    _ => continue,
                };
                m.insert(p.clone(), vs.iter().filter_map(|s| parse_version(s)).collect());
            }
            m
        };
        assume_newest(&mut deps, &mut notes, releases);
        crate::stack::settle(&mut deps);
        assert_eq!(deps["pkg:pypi/mcp"].version, Some(v("2.3.0")), "not the 2.0.0 floor, and no pre-release");
        assert_eq!(deps["pkg:pypi/fastapi"].version, Some(v("0.162.0")), "an unpinned requirement still gets a version");
        assert_eq!(deps["pkg:pypi/textual"].version, Some(v("8.9.1")));
        assert!(deps["pkg:pypi/fastapi"].source.contains("what a fresh install resolves"), "{}", deps["pkg:pypi/fastapi"].source);
        assert_eq!(deps["pkg:pypi/mcp"].readings[0].range, Some(crate::stack::Range::Pypi(">=2.0.0".into())), "the range stays for the library's users");
        assert_eq!(deps["pkg:pypi/gone"].version, Some(v("1.0.0")), "no releases read: the floor, labelled");
        assert_eq!(deps["pkg:pypi/semconv"].version, parse_version("0.60b0"), "only pre-releases: the newest of them");
        assert!(notes.iter().any(|n| n.starts_with("4 Python requirements no lockfile")), "{notes:?}");
        assert!(notes.iter().any(|n| n.contains("(gone)") && n.contains("declared floor")), "{notes:?}");
    }

    #[test]
    fn a_constraints_file_found_on_its_own_declares_nothing() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "requirements/dev.txt", "-c base-constraint.txt\npytest==8.0.0\n");
        write(d.path(), "requirements/base-constraint.txt", "urllib3==2.2.0\n");
        let (mut pk, mut deps) = (vec![], BTreeMap::new());
        detect(d.path(), &mut pk, &mut deps, &mut vec![]);
        assert!(deps.contains_key("pkg:pypi/pytest"));
        assert!(!deps.contains_key("pkg:pypi/urllib3"), "constrained, not declared");
    }

    #[test]
    fn a_private_index_in_a_nested_requirements_file_keeps_names_private() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "pyproject.toml", "[project]\nname = \"app\"\ndependencies = [\"corp-sdk>=1\"]\n");
        write(d.path(), "requirements/base.txt", "--index-url https://pypi.corp.example/simple\ncorp-sdk==1.0.0\n");
        let st = crate::stack::detect_in(d.path(), &crate::privacy::Env::default()).unwrap();
        assert!(!st.deps["pkg:pypi/corp-sdk"].public_candidate);
    }
}

