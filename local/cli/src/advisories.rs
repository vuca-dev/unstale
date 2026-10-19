//! Lockfile advisories: every resolved package version in the project's lockfiles, transitive ones included, checked
//! against OSV (`api.osv.dev`, one batch request per 1,000 package versions, then one request per advisory not
//! cached at its current `modified` time). No model call and no unstale service: OSV sees public package names and
//! versions, as from `npm audit` or `pip-audit`, and no source.
//!
//! This is the one reading of transitive packages, and it never makes them technologies: it reports advisories,
//! grouped under the direct dependency that pulls each package in. Only what calls for action is shown (the rest is
//! counted): an advisory on an installed version is surfaced when at least one holds:
//! - (a) critical or high severity, and the package is in the runtime (non-dev) closure of a project manifest the lockfile installs (an application's, or a library's: its
//!   dependencies install and run with it), not a CI, test or example manifest's;
//! - (b) a fixed version exists but every one is refused by a range that requires the package (a parent's range, the
//!   manifest's exact pin) or by a root override or resolution, so an update PR cannot apply it alone;
//! - (c) no fixed version exists for the installed one (replace or mitigate);
//! - (d) published within `FRESH_DAYS`.
//!
//! A package only dev dependencies reach is never shown for a low, moderate or unrated advisory.
//!
//! A direct npm runtime dependency that nothing in the code or configuration names and no package requires reads as
//! unused (`removable`): its lines say removing it clears them, not "at runtime" or "fix blocked".
//!
//! Read at the network moments (`init`/`status`, `sync`/`run`), cached a day per package version and per advisory
//! revision; outputs read the cache only. `UNSTALE_NO_REGISTRY=1` turns it off.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::privacy::Seen;
use crate::stack::Stack;
use crate::util;

/// A batch answer per package version is asked again after this long.
const FRESH_SECS: u64 = 24 * 3600;
/// (d): an advisory published this recently is news whatever its other properties. 30 days: one monthly update
/// cycle. Past it, an admitted fix is what update PRs and audit alerts already carry, and a, b or c decides. On the
/// OpenHands lockfile 60 days showed 57 of 100 advisories (dev-tool denial of service, mostly); 30 days, see the vault.
pub const FRESH_DAYS: i64 = 30;
const BATCH: usize = 1000;
const OSV: &str = "https://api.osv.dev/v1";

// ------------------------------------------------------------------------------------------------- lockfile graphs

#[derive(Debug, Default)]
pub struct Graph {
    /// The lockfile, relative to the repository root.
    pub file: String,
    pub eco: &'static str,
    nodes: Vec<Node>,
    by_key: BTreeMap<String, usize>,
}

#[derive(Debug, Default)]
struct Node {
    name: String,
    version: String,
    /// A project of this repository (an importer, a workspace member): its directory relative to the repository
    /// root. Not queried; its edges are the direct dependencies.
    local: Option<String>,
    /// Installed from somewhere other than the public registry (a private registry, git, a tarball or a path): its
    /// name is never sent.
    private: bool,
    /// Where the lockfile says it came from (`privacy`).
    seen: Seen,
    edges: Vec<Edge>,
}

#[derive(Debug)]
struct Edge {
    to: usize,
    /// The range the parent requires, when the lockfile records it.
    range: Option<String>,
    dev: bool,
}

impl Graph {
    fn new(file: &str, eco: &'static str) -> Graph {
        Graph { file: file.into(), eco, ..Default::default() }
    }
    fn node(&mut self, key: &str, name: &str, version: &str) -> usize {
        if let Some(&i) = self.by_key.get(key) {
            if self.nodes[i].name.is_empty() {
                self.nodes[i].name = name.into();
                self.nodes[i].version = version.into();
            }
            return i;
        }
        self.nodes.push(Node { name: name.into(), version: version.into(), ..Default::default() });
        self.by_key.insert(key.into(), self.nodes.len() - 1);
        self.nodes.len() - 1
    }
    fn local(&mut self, dir: &str) -> usize {
        let i = self.node(&format!("local:{dir}"), "", "");
        self.nodes[i].local = Some(dir.into());
        i
    }
    fn edge(&mut self, from: usize, to: usize, range: Option<&str>, dev: bool) {
        if from != to {
            self.nodes[from].edges.push(Edge { to, range: range.map(String::from), dev });
        }
    }
    fn saw(&mut self, i: usize, seen: Seen) {
        let n = &mut self.nodes[i];
        n.seen = n.seen.and(seen);
        n.private |= seen == Seen::Elsewhere;
    }
    /// The package versions to query: every public package version (not a project of the repository, not one
    /// installed from elsewhere than the public registry, not a name a project of the repository has).
    pub fn packages(&self) -> BTreeSet<(String, String)> {
        self.nodes
            .iter()
            .filter(|n| n.local.is_none() && !n.private && !n.name.is_empty() && !n.version.is_empty()).map(|n| (n.name.clone(), n.version.clone())).collect()
    }
}

/// `a/b` joined with `../c` → `a/c`; `.` for the root.
fn join_dir(base: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = base.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    for p in rel.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    if parts.is_empty() { ".".into() } else { parts.join("/") }
}

/// `package-lock.json` / `npm-shrinkwrap.json` v2 and v3 (`packages`), resolved the way Node does: from the
/// requiring package's directory up through each enclosing `node_modules`.
pub fn npm_lock(text: &str, lock_dir: &str, file: &str) -> Graph {
    let mut g = Graph::new(file, "npm");
    let Ok(v) = serde_json::from_str::<Value>(text) else { return g };
    let Some(pk) = v.get("packages").and_then(Value::as_object) else { return g };
    let mut idx: BTreeMap<&str, usize> = BTreeMap::new();
    for (key, meta) in pk {
        let i = if !key.contains("node_modules/") {
            g.local(&join_dir(lock_dir, key))
        } else if meta.get("link").and_then(Value::as_bool) == Some(true) {
            g.local(&join_dir(lock_dir, meta.get("resolved").and_then(Value::as_str).unwrap_or("")))
        } else {
            let name = meta.get("name").and_then(Value::as_str).unwrap_or_else(|| key.rsplit_once("node_modules/").map(|(_, n)| n).unwrap_or(key));
            let ver = meta.get("version").and_then(Value::as_str).unwrap_or("");
            let i = g.node(&format!("npm:{key}"), name, ver);
            if let Some(u) = meta.get("resolved").and_then(Value::as_str) {
                g.saw(i, Seen::npm_url(u));
            }
            i
        };
        idx.insert(key.as_str(), i);
    }
    let resolve = |from: &str, dep: &str| -> Option<usize> {
        let mut base = from.to_string();
        loop {
            let cand = if base.is_empty() { format!("node_modules/{dep}") } else { format!("{base}/node_modules/{dep}") };
            if let Some(&i) = idx.get(cand.as_str()) {
                return Some(i);
            }
            if base.is_empty() {
                return None;
            }
            base = match base.rfind("/node_modules/") {
                Some(at) => base[..at].to_string(),
                None => String::new(),
            };
        }
    };
    let mut edges = vec![];
    for (key, meta) in pk {
        // A link's own entry carries no dependencies; the workspace directory's entry does.
        let from = idx[key.as_str()];
        let local = !key.contains("node_modules/");
        for (sec, dev) in [("dependencies", false), ("optionalDependencies", false), ("peerDependencies", false), ("devDependencies", true)] {
            if dev && !local {
                continue;
            }
            for (dep, range) in meta.get(sec).and_then(Value::as_object).into_iter().flatten() {
                if let Some(to) = resolve(key, dep) {
                    edges.push((from, to, range.as_str().map(String::from), dev));
                }
            }
        }
    }
    for (f, t, r, d) in edges {
        g.edge(f, t, r.as_deref(), d);
    }
    g
}

/// `pnpm-lock.yaml` v6 and v9 (the last YAML document: pnpm 11 writes its own lock first): importers with their
/// specifiers, and `snapshots` (v9) or `packages` (v6) for what each package version depends on.
pub fn pnpm_lock(text: &str, lock_dir: &str, file: &str) -> Graph {
    let doc = text.rsplit("\n---\n").next().unwrap_or(text);
    let mut g = Graph::new(file, "npm");
    let split = |key: &str| -> Option<(String, String)> {
        let key = key.trim_start_matches('/');
        let at = key.get(1..)?.find('@')? + 1;
        let ver = crate::stack::clean_pnpm_version(&key[at + 1..])?;
        Some((key[..at].to_string(), ver.to_string()))
    };
    let mut pkg = |g: &mut Graph, key: &str| -> Option<usize> {
        let key = key.trim_start_matches('/');
        let (name, ver) = split(key)?;
        Some(g.node(&format!("pnpm:{key}"), &name, &ver))
    };
    // A dependency's value: `1.2.3(peer@1)`, an alias `other@1.2.3`, or `link:../dir`.
    let target = |g: &mut Graph, pkg: &mut dyn FnMut(&mut Graph, &str) -> Option<usize>, from_dir: &str, name: &str, val: &str| -> Option<usize> {
        let val = val.trim().trim_matches(['\'', '"']);
        if let Some(rel) = val.strip_prefix("link:") {
            return Some(g.local(&join_dir(from_dir, rel)));
        }
        if val.starts_with(|c: char| c.is_ascii_digit()) { pkg(g, &format!("{name}@{val}")) } else { pkg(g, val) }
    };
    const SECTIONS: &[(&str, bool)] = &[("dependencies", false), ("optionalDependencies", false), ("devDependencies", true)];
    let mut stack: Vec<(usize, String)> = vec![];
    // Importer edges wait for their `version:` line; the `specifier:` line comes first.
    let mut spec: Option<String> = None;
    for raw in doc.lines() {
        let t = raw.trim_end();
        if t.trim().is_empty() || t.trim_start().starts_with('#') {
            continue;
        }
        let indent = t.len() - t.trim_start().len();
        let Some((k, val)) = crate::stack::split_key(t.trim_start()) else { continue };
        while stack.last().is_some_and(|(i, _)| *i >= indent) {
            stack.pop();
        }
        let path: Vec<String> = stack.iter().map(|(_, k)| k.clone()).collect();
        let p: Vec<&str> = path.iter().map(String::as_str).collect();
        match (p.as_slice(), val) {
            (["importers"], _) => {
                g.local(&join_dir(lock_dir, &k));
            }
            (["importers", imp, sec, name], Some(v)) if SECTIONS.iter().any(|s| s.0 == *sec) => {
                if k == "specifier" {
                    spec = Some(v.trim_matches(['\'', '"']).to_string());
                } else if k == "version" {
                    let dir = join_dir(lock_dir, imp);
                    let from = g.local(&dir);
                    if let Some(to) = target(&mut g, &mut pkg, &dir, name, v) {
                        let dev = SECTIONS.iter().any(|s| s.0 == *sec && s.1);
                        g.edge(from, to, spec.take().as_deref(), dev);
                    }
                }
            }
            (["snapshots" | "packages"], _) => {
                pkg(&mut g, &k);
            }
            // `resolution: {tarball: …}` (a registry other than the default one names its URL), `{type: git, …}` or
            // `{type: directory, …}`: not the default registry.
            (["packages", key], Some(v)) if k == "resolution" && (v.contains("tarball:") || v.contains("type:")) => {
                let tarball = v.split_once("tarball:").map(|(_, r)| r.trim().trim_end_matches('}').split(',').next().unwrap_or("").trim().trim_matches(['\'', '"']).to_string());
                if let Some(i) = pkg(&mut g, key) {
                    g.saw(i, tarball.map_or(Seen::Elsewhere, |u| Seen::npm_url(&u)));
                }
            }
            (["packages", key, "resolution"], Some(v)) if k == "tarball" || k == "type" => {
                if let Some(i) = pkg(&mut g, key) {
                    g.saw(i, if k == "tarball" { Seen::npm_url(v.trim_matches(['\'', '"'])) } else { Seen::Elsewhere });
                }
            }
            (["snapshots" | "packages", key, "dependencies" | "optionalDependencies"], Some(v)) => {
                if let (Some(from), dir) = (pkg(&mut g, key), lock_dir.to_string())
                    && let Some(to) = target(&mut g, &mut pkg, &dir, &k, v)
                {
                    g.edge(from, to, None, false);
                }
            }
            _ => {}
        }
        if val.is_none() {
            stack.push((indent, k));
        }
    }
    g
}

/// `yarn.lock` (v1 and Berry). The lockfile states each entry's ranges and dependencies; the projects and their dev
/// dependencies come from the `package.json` files it covers (`manifests`: directory relative to the repository
/// root, parsed manifest).
pub fn yarn_lock(text: &str, file: &str, manifests: &[(String, Value)]) -> Graph {
    let mut g = Graph::new(file, "npm");
    let bare = |r: &str| r.trim().trim_matches('"').trim_start_matches("npm:").to_string();
    let mut by_spec: BTreeMap<(String, String), usize> = BTreeMap::new();
    let mut deps: Vec<(usize, String, String)> = vec![];
    let mut cur: Option<usize> = None;
    let mut specs: Vec<(String, String)> = vec![];
    let mut in_deps = false;
    for line in text.lines() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') {
            specs = line
                .trim_end_matches(':')
                .split(", ")
                .filter_map(|s| {
                    let s = s.trim().trim_matches('"');
                    let at = s.get(1..)?.find('@')? + 1;
                    Some((s[..at].to_string(), bare(&s[at + 1..])))
                })
                .collect();
            cur = None;
            in_deps = false;
            continue;
        }
        let t = line.trim();
        let indent = line.len() - line.trim_start().len();
        if indent <= 2 {
            in_deps = t == "dependencies:" || t == "optionalDependencies:";
            let v = t.strip_prefix("version ").or_else(|| t.strip_prefix("version: "));
            if let (Some(v), Some((name, _))) = (v, specs.first())
                && !specs.iter().any(|(_, r)| r.starts_with("workspace:"))
            {
                let v = v.trim_matches('"');
                let i = g.node(&format!("yarn:{name}@{v}"), name, v);
                for s in &specs {
                    by_spec.insert(s.clone(), i);
                }
                cur = Some(i);
            }
        } else if let (Some(u), Some(i)) = (t.strip_prefix("resolved "), cur) {
            g.saw(i, Seen::npm_url(u.trim_matches('"')));
        } else if in_deps && let Some(i) = cur {
            let (n, r) = t.split_once(": ").or_else(|| t.split_once(' ')).unwrap_or((t, ""));
            deps.push((i, n.trim_matches('"').to_string(), bare(r)));
        }
    }
    for (i, n, r) in deps {
        if let Some(&to) = by_spec.get(&(n, r.clone())) {
            g.edge(i, to, Some(&r), false);
        }
    }
    let local_by_name: BTreeMap<String, String> = manifests.iter().filter_map(|(d, m)| Some((m.get("name")?.as_str()?.to_string(), d.clone()))).collect();
    for (dir, m) in manifests {
        let from = g.local(dir);
        for (sec, dev) in [("dependencies", false), ("optionalDependencies", false), ("devDependencies", true)] {
            for (n, r) in m.get(sec).and_then(Value::as_object).into_iter().flatten() {
                let r = bare(r.as_str().unwrap_or(""));
                if let Some(&to) = by_spec.get(&(n.clone(), r.clone())) {
                    g.edge(from, to, Some(&r), dev);
                } else if let Some(d) = local_by_name.get(n) {
                    let to = g.local(d);
                    g.edge(from, to, None, dev);
                }
            }
        }
    }
    g
}

/// `uv.lock`: workspace members (`editable`, `virtual`, `directory` sources) are the projects; their
/// `dev-dependencies` are dev, and `package.metadata.requires-dist` gives the declared specifiers.
pub fn uv_lock(text: &str, lock_dir: &str, file: &str) -> Graph {
    let mut g = Graph::new(file, "PyPI");
    let Ok(doc) = text.parse::<toml::Table>() else { return g };
    let pkgs = doc.get("package").and_then(|p| p.as_array()).cloned().unwrap_or_default();
    let s = |v: &toml::Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mut by_name: BTreeMap<String, Vec<(String, usize)>> = BTreeMap::new();
    let mut ids = vec![];
    for p in &pkgs {
        let (name, ver) = (crate::pypi::normalize(&s(p, "name")), s(p, "version"));
        let src = p.get("source");
        let local = ["editable", "virtual", "directory"].iter().find_map(|k| src.and_then(|s| s.get(*k)).and_then(|d| d.as_str()));
        let i = match local {
            Some(d) => g.local(&join_dir(lock_dir, d)),
            None => {
                let i = g.node(&format!("uv:{name}@{ver}"), &name, &ver);
                // An index's URL, else git, a URL or a path.
                g.saw(i, src.and_then(|s| s.get("registry")).and_then(|r| r.as_str()).map_or(Seen::Elsewhere, Seen::pypi_url));
                i
            }
        };
        by_name.entry(name).or_default().push((ver, i));
        ids.push(i);
    }
    for (p, &from) in pkgs.iter().zip(&ids) {
        let mut specs: BTreeMap<String, String> = BTreeMap::new();
        let meta = p.get("metadata");
        for r in meta.and_then(|m| m.get("requires-dist")).and_then(|r| r.as_array()).into_iter().flatten().chain(
            meta.and_then(|m| m.get("requires-dev")).and_then(|r| r.as_table()).into_iter().flat_map(|t| t.values()).filter_map(|v| v.as_array()).flatten(),
        ) {
            if let Some(sp) = r.get("specifier").and_then(|x| x.as_str()) {
                specs.insert(crate::pypi::normalize(&s(r, "name")), sp.to_string());
            }
        }
        let lists: Vec<(&toml::Value, bool)> = p
            .get("dependencies")
            .into_iter()
            .map(|d| (d, false))
            .chain(p.get("optional-dependencies").and_then(|t| t.as_table()).into_iter().flat_map(|t| t.values()).map(|d| (d, false)))
            .chain(p.get("dev-dependencies").and_then(|t| t.as_table()).into_iter().flat_map(|t| t.values()).map(|d| (d, true)))
            .collect();
        for (list, dev) in lists {
            for d in list.as_array().into_iter().flatten() {
                let n = crate::pypi::normalize(&s(d, "name"));
                let want = s(d, "version");
                let Some(cands) = by_name.get(&n) else { continue };
                let to = cands.iter().find(|(v, _)| want.is_empty() || *v == want).map(|c| c.1);
                if let Some(to) = to {
                    g.edge(from, to, specs.get(&n).map(String::as_str), dev);
                }
            }
        }
    }
    g
}

/// The requirement name and specifier of a PEP 508 string (`requests[socks]>=2.31; python_version>"3.8"`).
fn pep508(req: &str) -> (String, String) {
    let req = req.split(';').next().unwrap_or("");
    let end = req.find(|c: char| !(c.is_ascii_alphanumeric() || "-_.".contains(c))).unwrap_or(req.len());
    let rest = req[end..].trim();
    let rest = if rest.starts_with('[') { rest.split_once(']').map(|(_, r)| r).unwrap_or("") } else { rest };
    (crate::pypi::normalize(&req[..end]), rest.trim().trim_matches(['(', ')']).to_string())
}

/// A `pyproject.toml`'s direct requirements, `(name, specifier, dev)`: PEP 621 dependencies and extras, PEP 735
/// groups (dev), Poetry's main dependencies and groups (dev).
fn pyproject_roots(doc: &toml::Table) -> Vec<(String, String, bool)> {
    let mut out = vec![];
    let project = doc.get("project");
    for r in project.and_then(|p| p.get("dependencies")).and_then(|d| d.as_array()).into_iter().flatten() {
        let (n, s) = pep508(r.as_str().unwrap_or(""));
        out.push((n, s, false));
    }
    for list in project.and_then(|p| p.get("optional-dependencies")).and_then(|d| d.as_table()).into_iter().flat_map(|t| t.values()) {
        for r in list.as_array().into_iter().flatten() {
            let (n, s) = pep508(r.as_str().unwrap_or(""));
            out.push((n, s, false));
        }
    }
    for list in doc.get("dependency-groups").and_then(|d| d.as_table()).into_iter().flat_map(|t| t.values()) {
        for r in list.as_array().into_iter().flatten().filter_map(|r| r.as_str()) {
            let (n, s) = pep508(r);
            out.push((n, s, true));
        }
    }
    let poetry = doc.get("tool").and_then(|t| t.get("poetry"));
    let mut table = |t: Option<&toml::Value>, dev: bool| {
        for (n, v) in t.and_then(|t| t.as_table()).into_iter().flatten() {
            if n != "python" {
                let s = v.as_str().map(String::from).or_else(|| v.get("version").and_then(|x| x.as_str()).map(String::from)).unwrap_or_default();
                out.push((crate::pypi::normalize(n), s, dev));
            }
        }
    };
    table(poetry.and_then(|p| p.get("dependencies")), false);
    table(poetry.and_then(|p| p.get("dev-dependencies")), true);
    for (gname, grp) in poetry.and_then(|p| p.get("group")).and_then(|g| g.as_table()).into_iter().flatten() {
        table(grp.get("dependencies"), gname != "main");
    }
    out
}

/// `poetry.lock` with the `pyproject.toml` beside it for the project's own requirements.
pub fn poetry_lock(text: &str, pyproject: &str, lock_dir: &str, file: &str) -> Graph {
    let mut g = Graph::new(file, "PyPI");
    let Ok(doc) = text.parse::<toml::Table>() else { return g };
    let pkgs = doc.get("package").and_then(|p| p.as_array()).cloned().unwrap_or_default();
    let mut by_name: BTreeMap<String, usize> = BTreeMap::new();
    let mut ids = vec![];
    for p in &pkgs {
        let name = crate::pypi::normalize(p.get("name").and_then(|x| x.as_str()).unwrap_or(""));
        let ver = p.get("version").and_then(|x| x.as_str()).unwrap_or("");
        let i = g.node(&format!("poetry:{name}@{ver}"), &name, ver);
        // No `[package.source]` is PyPI; one is git, a file, a directory or another index.
        g.saw(i, match p.get("source") {
            None => Seen::Public,
            Some(s) => s.get("url").and_then(|u| u.as_str()).filter(|_| s.get("type").and_then(|t| t.as_str()).is_none_or(|t| t == "legacy")).map_or(Seen::Elsewhere, Seen::pypi_url),
        });
        by_name.entry(name).or_insert(i);
        ids.push(i);
    }
    for (p, &from) in pkgs.iter().zip(&ids) {
        for (n, v) in p.get("dependencies").and_then(|d| d.as_table()).into_iter().flatten() {
            let spec = v.as_str().map(String::from).or_else(|| v.get("version").and_then(|x| x.as_str()).map(String::from));
            if let Some(&to) = by_name.get(&crate::pypi::normalize(n)) {
                g.edge(from, to, spec.as_deref(), false);
            }
        }
    }
    if let Ok(pp) = pyproject.parse::<toml::Table>() {
        let from = g.local(lock_dir);
        for (n, s, dev) in pyproject_roots(&pp) {
            if let Some(&to) = by_name.get(&n) {
                g.edge(from, to, Some(&s).filter(|s| !s.is_empty()).map(String::as_str), dev);
            }
        }
    }
    g
}

/// `Pipfile.lock`: no graph, every entry direct (`default` runtime, `develop` dev).
pub fn pipfile_lock(text: &str, lock_dir: &str, file: &str) -> Graph {
    let mut g = Graph::new(file, "PyPI");
    let Ok(v) = serde_json::from_str::<Value>(text) else { return g };
    let sources: BTreeMap<&str, &str> =
        v.pointer("/_meta/sources").and_then(Value::as_array).into_iter().flatten().filter_map(|s| Some((s.get("name")?.as_str()?, s.get("url")?.as_str()?))).collect();
    let from = g.local(lock_dir);
    for (sec, dev) in [("default", false), ("develop", true)] {
        for (n, m) in v.get(sec).and_then(Value::as_object).into_iter().flatten() {
            let Some(ver) = m.get("version").and_then(Value::as_str) else { continue };
            let (name, ver) = (crate::pypi::normalize(n), ver.trim_start_matches("==").to_string());
            let to = g.node(&format!("pipfile:{name}@{ver}"), &name, &ver);
            if let Some(i) = m.get("index").and_then(Value::as_str) {
                g.saw(to, sources.get(i).map_or(if i == "pypi" { Seen::Public } else { Seen::Elsewhere }, |u| Seen::pypi_url(u)));
            }
            g.edge(from, to, m.get("version").and_then(Value::as_str), dev);
        }
    }
    g
}

const PY_LOCKS: &[&str] = &["uv.lock", "poetry.lock", "Pipfile.lock"];

/// Every lockfile the stack's manifests read their versions from, as a graph.
pub fn graphs(root: &Path, st: &Stack) -> Vec<Graph> {
    let mut files: BTreeSet<String> = BTreeSet::new();
    for p in &st.packages {
        let Some(l) = &p.lockfile else { continue };
        if l.contains('/') || !PY_LOCKS.contains(&l.as_str()) {
            files.insert(l.trim_start_matches("./").to_string());
            continue;
        }
        // PyPI packages name the lockfile only: the nearest one at or above the manifest.
        let mut d = join_dir(&p.dir, "");
        loop {
            let rel = if d == "." { l.clone() } else { format!("{d}/{l}") };
            if root.join(&rel).is_file() {
                files.insert(rel);
                break;
            }
            if d == "." {
                break;
            }
            d = join_dir(&d, "..");
        }
    }
    let mut out = vec![];
    for f in files {
        let Ok(text) = std::fs::read_to_string(root.join(&f)) else { continue };
        let (dir, base) = match f.rsplit_once('/') {
            Some((d, b)) => (d.to_string(), b),
            None => (".".to_string(), f.as_str()),
        };
        let g = match base {
            "package-lock.json" | "npm-shrinkwrap.json" => npm_lock(&text, &dir, &f),
            "pnpm-lock.yaml" => pnpm_lock(&text, &dir, &f),
            "yarn.lock" => {
                let manifests: Vec<(String, Value)> = st
                    .packages
                    .iter()
                    .filter(|p| p.lockfile.as_deref() == Some(f.as_str()))
                    .filter_map(|p| Some((p.dir.clone(), serde_json::from_str(&std::fs::read_to_string(root.join(&p.dir).join("package.json")).ok()?).ok()?)))
                    .collect();
                yarn_lock(&text, &f, &manifests)
            }
            "uv.lock" => uv_lock(&text, &dir, &f),
            "poetry.lock" => poetry_lock(&text, &std::fs::read_to_string(root.join(&dir).join("pyproject.toml")).unwrap_or_default(), &dir, &f),
            "Pipfile.lock" => pipfile_lock(&text, &dir, &f),
            _ => continue,
        };
        out.push(g);
    }
    // Names of the repository's own packages, direct dependencies kept private, and packages a lockfile or the
    // registry configuration places on a private registry (`privacy`: a configuration wins over a public lockfile URL)
    // are never sent.
    let own: BTreeSet<String> = st.packages.iter().filter_map(|p| p.own.as_deref()).filter_map(util::purl_name).collect();
    for g in &mut out {
        // A test, example or fixture lockfile: its directory's own configuration applies too.
        let fixture = !matches!(crate::usage::path_role(&g.file), crate::usage::Role::App | crate::usage::Role::Tooling);
        for n in &mut g.nodes {
            let purl = if g.eco == "PyPI" { crate::pypi::purl(&n.name) } else { util::npm_purl(&n.name) };
            if own.contains(&n.name)
                || st.deps.get(&purl).is_some_and(|d| !d.public_candidate)
                || !st.registries.may_name(&purl, n.seen)
                || (fixture && !st.fixture_registries.may_name(&purl, n.seen))
            {
                n.private = true;
            }
        }
    }
    out
}

// ------------------------------------------------------------------------------------------------------ advisories

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Severity {
    Unrated,
    Low,
    Moderate,
    High,
    Critical,
}

impl Severity {
    fn parse(s: &str) -> Severity {
        match s.to_ascii_uppercase().as_str() {
            "CRITICAL" => Severity::Critical,
            "HIGH" => Severity::High,
            "MODERATE" | "MEDIUM" => Severity::Moderate,
            "LOW" => Severity::Low,
            _ => Severity::Unrated,
        }
    }
    fn word(self) -> &'static str {
        match self {
            Severity::Critical => "critical",
            Severity::High => "high",
            Severity::Moderate => "moderate",
            Severity::Low => "low",
            Severity::Unrated => "unrated",
        }
    }
}

/// What one OSV record says, kept per id at its `modified` time.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Doc {
    pub modified: String,
    #[serde(default)]
    pub published: String,
    #[serde(default)]
    pub summary: String,
    pub severity: Option<Severity>,
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Per affected package (ecosystem, name): the versions its ranges name as fixed.
    #[serde(default)]
    pub fixed: Vec<(String, String, Vec<String>)>,
    #[serde(default)]
    pub withdrawn: bool,
}

/// The parts of an OSV record used here.
pub fn read_osv(v: &Value) -> Doc {
    let s = |p: &str| v.pointer(p).and_then(Value::as_str).unwrap_or("").to_string();
    let id = s("/id");
    let mut sev = v.pointer("/database_specific/severity").and_then(Value::as_str).map(Severity::parse);
    if id.starts_with("MAL-") {
        sev = Some(Severity::Critical); // malicious code in the installed version
    }
    let fixed = v
        .get("affected")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|a| {
            let f: Vec<String> = a
                .get("ranges")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .flat_map(|r| r.get("events").and_then(Value::as_array).into_iter().flatten())
                .filter_map(|e| e.get("fixed").and_then(Value::as_str).map(String::from))
                .collect();
            let p = |k: &str| a.pointer(&format!("/package/{k}")).and_then(Value::as_str).unwrap_or("").to_string();
            (p("ecosystem"), p("name"), f)
        })
        .collect();
    Doc {
        modified: s("/modified"),
        published: s("/published"),
        summary: util::one_line(&s("/summary"), 160),
        severity: sev.filter(|s| *s != Severity::Unrated),
        aliases: v.get("aliases").and_then(Value::as_array).into_iter().flatten().filter_map(|a| a.as_str().map(String::from)).collect(),
        fixed,
        withdrawn: v.get("withdrawn").is_some(),
    }
}

fn parse_ver(eco: &str, v: &str) -> Option<Version> {
    if eco == "PyPI" { crate::pypi::parse_version(v) } else { util::parse_version(v) }
}

fn admits(eco: &str, v: &Version, range: &str) -> Option<bool> {
    let r = range.trim();
    if r.is_empty() || r == "*" {
        return Some(true);
    }
    if eco == "PyPI" { crate::pypi::spec_satisfies(v, r) } else { util::npm_satisfies(v, r) }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub name: String,
    pub version: String,
    pub severity: Severity,
    pub summary: String,
    pub fix: Option<String>,
    /// Why it is shown: one phrase per condition that holds.
    pub why: Vec<String>,
    /// The direct dependencies that pull it in (`name version`, runtime ones first), or empty when it is one.
    pub via: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Report {
    pub checked: u64,
    /// Package versions queried, and (package version, advisory) matches before and after the filter.
    pub queried: usize,
    pub raw: usize,
    pub items: Vec<Item>,
    /// Direct dependencies (`name version`) nothing in the code or configuration names and no package requires
    /// (`removable`): removing one clears every advisory listed under it alone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unused: Vec<String>,
}

/// Applies the conditions to the matches: `matches` per (ecosystem, name, version) the advisory ids OSV returned,
/// `docs` per id. `overrides` gives the root override
/// values a lockfile applies to a package name. `today` in days since the epoch.
pub fn evaluate(
    gs: &[Graph],
    matches: &BTreeMap<(String, String, String), Vec<String>>,
    docs: &BTreeMap<String, Doc>,
    overrides: impl Fn(&Graph, &str) -> Vec<(String, &'static str)>,
    today: i64,
) -> (usize, Vec<Item>) {
    let mut raw = 0;
    let mut items: BTreeMap<(String, String, String), Item> = BTreeMap::new();
    for g in gs {
        let n = g.nodes.len();
        let mut parents: Vec<Vec<(usize, Option<&str>)>> = vec![vec![]; n];
        let mut direct = vec![false; n];
        for (i, nd) in g.nodes.iter().enumerate() {
            for e in &nd.edges {
                parents[e.to].push((i, e.range.as_deref()));
                if nd.local.is_some() && g.nodes[e.to].local.is_none() {
                    direct[e.to] = true;
                }
            }
        }
        // The runtime closure: from every project of the application's own code (not a CI, test or example
        // manifest: `usage::path_role`), along non-dev edges.
        let runtime = {
            let mut seen = vec![false; n];
            let app = |d: &str| crate::usage::path_role(&if d == "." { "package.json".to_string() } else { format!("{d}/package.json") }) == crate::usage::Role::App;
            let mut q: VecDeque<usize> = (0..n).filter(|&i| g.nodes[i].local.as_deref().is_some_and(app)).collect();
            for &i in &q {
                seen[i] = true;
            }
            while let Some(i) = q.pop_front() {
                for e in g.nodes[i].edges.iter().filter(|e| !e.dev) {
                    if !seen[e.to] {
                        seen[e.to] = true;
                        q.push_back(e.to);
                    }
                }
            }
            seen
        };
        for (i, nd) in g.nodes.iter().enumerate() {
            if nd.local.is_some() {
                continue;
            }
            let Some(ids) = matches.get(&(g.eco.to_string(), nd.name.clone(), nd.version.clone())) else { continue };
            let Some(installed) = parse_ver(g.eco, &nd.version) else { continue };
            // Aliases of one another (a PYSEC record and its GHSA) count once: the GHSA id, the highest severity.
            let mut groups: Vec<(String, Doc)> = vec![];
            for id in ids {
                let Some(d) = docs.get(id).filter(|d| !d.withdrawn) else { continue };
                let same = |gid: &str, gd: &Doc| gd.aliases.iter().any(|a| a == id || d.aliases.contains(a)) || d.aliases.iter().any(|a| a == gid);
                if let Some(k) = groups.iter().position(|(gid, gd)| same(gid, gd)) {
                    let (gid, gd) = &mut groups[k];
                    gd.severity = gd.severity.max(d.severity);
                    if id.starts_with("GHSA-") && !gid.starts_with("GHSA-") {
                        let sev = gd.severity;
                        *gid = id.clone();
                        *gd = Doc { severity: sev, ..d.clone() };
                    }
                } else {
                    groups.push((id.clone(), d.clone()));
                }
            }
            for (id, d) in groups {
                raw += 1;
                let sev = d.severity.unwrap_or(Severity::Unrated);
                let high = sev >= Severity::High;
                // Low and unrated never call for action; dev-only below critical never does either.
                if sev < Severity::Moderate || (!runtime[i] && sev < Severity::Critical) {
                    continue;
                }
                let mut fixes: Vec<Version> = d
                    .fixed
                    .iter()
                    .filter(|(e, name, _)| e == g.eco && (if g.eco == "PyPI" { crate::pypi::normalize(name) } else { name.clone() }) == nd.name)
                    .flat_map(|(_, _, f)| f.iter().filter_map(|v| parse_ver(g.eco, v)))
                    .filter(|v| *v > installed)
                    .collect();
                fixes.sort();
                fixes.dedup();
                let mut why = vec![];
                if high && runtime[i] {
                    why.push(format!("{} at runtime", sev.word()));
                }
                let mut blocked = false;
                if fixes.is_empty() {
                    blocked = true;
                    why.push("no fixed version: replace or mitigate".into());
                } else {
                    // The first range or override refusing the lowest fix, when every fix is refused.
                    let ovs = overrides(g, &nd.name);
                    let refuses = |f: &Version| -> Option<String> {
                        for (p, r) in &parents[i] {
                            // A range the installed version is outside of is superseded (an override set it).
                            if let Some(r) = r
                                && ovs.is_empty()
                                && admits(g.eco, &installed, r) != Some(false)
                                && admits(g.eco, f, r) == Some(false)
                            {
                                let who = &g.nodes[*p];
                                return Some(match &who.local {
                                    Some(dir) => format!("{dir} declares {r}"),
                                    None => format!("{} {} requires {r}", who.name, who.version),
                                });
                            }
                        }
                        ovs.iter().find(|(v, _)| admits(g.eco, f, v) == Some(false)).map(|(v, set)| format!("{set} sets {v}"))
                    };
                    if fixes.iter().all(|f| refuses(f).is_some())
                        && let Some(by) = refuses(&fixes[0])
                    {
                        blocked = true;
                        why.push(format!("fix blocked: {by}"));
                    }
                }
                let fresh = d.published.get(..10).and_then(util::parse_date).is_some_and(|days| today - days <= FRESH_DAYS);
                // What calls for action: critical or high at runtime; critical dev-only with no fix the ranges admit;
                // moderate at runtime when its fix is refused by a range, pin or override, or when it is new on a
                // direct dependency. A moderate with no fixed version anywhere, or new on a transitive package, is
                // a nit: nothing to bump.
                let shown = if !runtime[i] {
                    blocked
                } else if high {
                    true
                } else {
                    (blocked && !fixes.is_empty()) || (direct[i] && fresh)
                };
                if !shown {
                    continue;
                }
                if fresh {
                    why.push(format!("published {}", &d.published[..10]));
                }
                // The nearest direct dependencies above it.
                let mut via = BTreeSet::new();
                if !direct[i] {
                    let mut seen = vec![false; n];
                    let mut q = VecDeque::from([i]);
                    seen[i] = true;
                    while let Some(c) = q.pop_front() {
                        for &(p, _) in &parents[c] {
                            if seen[p] || g.nodes[p].local.is_some() {
                                continue;
                            }
                            seen[p] = true;
                            if direct[p] {
                                via.insert((!runtime[p], format!("{} {}", g.nodes[p].name, g.nodes[p].version)));
                            } else {
                                q.push_back(p);
                            }
                        }
                    }
                }
                let key = (nd.name.clone(), nd.version.clone(), id.clone());
                let it = items.entry(key).or_insert_with(|| Item {
                    id: id.clone(),
                    name: nd.name.clone(),
                    version: nd.version.clone(),
                    severity: sev,
                    summary: d.summary.clone(),
                    fix: fixes.first().map(|f| f.to_string()),
                    why: vec![],
                    via: vec![],
                });
                for w in why {
                    if !it.why.contains(&w) {
                        it.why.push(w);
                    }
                }
                for (_, v) in via {
                    if !it.via.contains(&v) {
                        it.via.push(v);
                    }
                }
            }
        }
    }
    let mut out: Vec<Item> = items.into_values().collect();
    out.sort_by(|a, b| b.severity.cmp(&a.severity).then(a.name.cmp(&b.name)).then(a.id.cmp(&b.id)));
    (raw, out)
}

/// The direct dependencies an advisory is listed under (`Item::via`, or the package itself) that the code does not
/// use: an npm runtime dependency of a project (dev tools load by convention, `eslint-plugin-x` as `x`) that no package
/// of any lockfile requires (a peer or a parent keeps it installed: `react-dom` under `next`) and whose name `named`
/// finds nowhere. Removing it removes everything only it pulls in. PyPI is never judged: an import name need not be
/// the distribution's (`yaml` for `pyyaml`).
pub fn removable(gs: &[Graph], items: &[Item], named: impl Fn(&[&str]) -> BTreeSet<String>) -> Vec<String> {
    let mut cands: BTreeSet<String> = items.iter().flat_map(|i| if i.via.is_empty() { vec![format!("{} {}", i.name, i.version)] } else { i.via.clone() }).collect();
    for g in gs {
        let mut kept: BTreeSet<String> = BTreeSet::new();
        for nd in &g.nodes {
            for e in &nd.edges {
                let to = &g.nodes[e.to];
                let key = format!("{} {}", to.name, to.version);
                if !cands.contains(&key) {
                    continue;
                }
                if g.eco != "npm" || to.local.is_some() || nd.local.is_none() || e.dev {
                    kept.insert(key);
                }
            }
        }
        cands.retain(|c| !kept.contains(c));
    }
    // Only names some graph declares as a runtime direct dependency of a project.
    cands.retain(|c| gs.iter().any(|g| g.eco == "npm" && g.nodes.iter().any(|nd| nd.local.is_some() && nd.edges.iter().any(|e| !e.dev && format!("{} {}", g.nodes[e.to].name, g.nodes[e.to].version) == *c))));
    let names: BTreeSet<&str> = cands.iter().filter_map(|c| c.rsplit_once(' ').map(|(n, _)| n)).collect();
    let names: Vec<&str> = names.into_iter().collect();
    let found = if names.is_empty() { BTreeSet::new() } else { named(&names) };
    cands.retain(|c| c.rsplit_once(' ').is_some_and(|(n, _)| !found.contains(n)));
    cands.into_iter().collect()
}

/// Dependency maps of a manifest: declaring a package there is not using it.
const DECLARES: &[&str] = &["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "peerDependenciesMeta", "bundleDependencies", "bundledDependencies", "overrides", "resolutions", "pnpm"];

/// Which of `names` any file of the repository names, as written anywhere in its text: code and configuration
/// (`usage::Repo`, lockfiles left out), scripts, container and make files, and a `package.json` outside its dependency
/// maps (its scripts and config count). A substring, so a longer name containing it counts too (fail safe).
fn named_in(root: &Path, names: &[&str]) -> BTreeSet<String> {
    let repo = crate::usage::Repo::collect(root);
    let mut texts: Vec<String> = vec![];
    for (path, text) in &repo.files {
        if path == "package.json" || path.ends_with("/package.json") {
            match serde_json::from_str::<Value>(text) {
                Ok(Value::Object(mut m)) => {
                    for k in DECLARES {
                        m.remove(*k);
                    }
                    texts.push(Value::Object(m).to_string());
                }
                _ => texts.push(text.clone()),
            }
        } else {
            texts.push(text.clone());
        }
    }
    // Files `Repo` does not read: shell scripts, Dockerfiles, Makefiles, Procfiles.
    for path in &repo.paths {
        let base = path.rsplit('/').next().unwrap_or(path);
        let other = base.starts_with("Dockerfile") || base.ends_with(".dockerfile") || base.ends_with(".sh") || matches!(base, "Makefile" | "makefile" | "GNUmakefile" | "Procfile" | "Justfile" | "justfile");
        if other && let Ok(t) = std::fs::read_to_string(root.join(path)) {
            texts.push(t);
        }
    }
    names.iter().filter(|n| texts.iter().any(|t| t.contains(**n))).map(|n| n.to_string()).collect()
}

// ----------------------------------------------------------------------------------------------------------- cache

#[derive(Default, Serialize, Deserialize)]
struct Batch {
    /// Per `ecosystem\tname\tversion`: when it was asked, and the (id, modified) pairs OSV returned.
    #[serde(default)]
    results: BTreeMap<String, (u64, Vec<(String, String)>)>,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn dir(cache: &Path) -> PathBuf {
    cache.join("registry/osv")
}

fn report_path(cache: &Path, root: &Path) -> PathBuf {
    let r = root.canonicalize().unwrap_or(root.to_path_buf());
    dir(cache).join(format!("report-{}.json", &util::sha256_hex(r.to_string_lossy().as_bytes())[..32]))
}

fn doc_path(cache: &Path, id: &str) -> PathBuf {
    dir(cache).join("vulns").join(format!("{}.json", id.replace(['/', '\\'], "_")))
}

fn read_json<T: for<'de> Deserialize<'de>>(p: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

/// Checks the lockfiles against OSV and keeps the report for the outputs. Returns the requests made.
pub fn refresh(cache: &Path, root: &Path, st: &Stack) -> usize {
    if crate::privacy::registry_off() {
        return 0;
    }
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(20))).build().into();
    let read = |r: Result<ureq::http::Response<ureq::Body>, ureq::Error>| -> Option<Value> {
        let mut r = r.ok().filter(|r| r.status().is_success())?;
        serde_json::from_slice(&r.body_mut().with_config().limit(64 * 1024 * 1024).read_to_vec().ok()?).ok()
    };
    let post = |body: &Value| read(agent.post(format!("{OSV}/querybatch")).header("Content-Type", "application/json").send(serde_json::to_vec(body).unwrap_or_default().as_slice()));
    let get = |id: &str| read(agent.get(format!("{OSV}/vulns/{id}")).call());
    let npm: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(8))).build().into();
    refresh_with(cache, root, st, now(), post, get, |purl| crate::privacy::npm_identity(&npm, purl))
}

/// `refresh` with the clock and the readers given (tests): `identity` is the public npm registry's anonymous answer
/// for a scoped package that needs one (`privacy::Registries::needs_identity`).
pub fn refresh_with(
    cache: &Path,
    root: &Path,
    st: &Stack,
    at: u64,
    post: impl Fn(&Value) -> Option<Value>,
    get: impl Fn(&str) -> Option<Value> + Sync,
    identity: impl Fn(&str) -> Option<bool> + Sync,
) -> usize {
    let gs = graphs(root, st);
    let mut wanted: BTreeSet<(String, String, String)> = gs.iter().flat_map(|g| g.packages().into_iter().map(|(n, v)| (g.eco.to_string(), n, v))).collect();
    // A scoped package from the public registry while credentials for it are configured may be a paid private one:
    // sent only once npm confirms it public (`privacy`).
    let unconfirmed: Vec<String> =
        wanted.iter().filter(|(e, _, _)| e == "npm").map(|(_, n, _)| util::npm_purl(n)).filter(|p| st.registries.needs_identity(p)).collect::<BTreeSet<_>>().into_iter().collect();
    if !unconfirmed.is_empty() {
        let public = crate::privacy::confirm_public(cache, at, &unconfirmed, identity);
        wanted.retain(|(e, n, _)| e != "npm" || !st.registries.needs_identity(&util::npm_purl(n)) || public.contains(&util::npm_purl(n)));
    }
    if wanted.is_empty() {
        let _ = std::fs::remove_file(report_path(cache, root));
        return 0;
    }
    let bp = dir(cache).join("batch.json");
    let mut batch: Batch = read_json(&bp).unwrap_or_default();
    let key = |(e, n, v): &(String, String, String)| format!("{e}\t{n}\t{v}");
    let due: Vec<&(String, String, String)> = wanted.iter().filter(|w| batch.results.get(&key(w)).is_none_or(|(t, _)| at.saturating_sub(*t) >= FRESH_SECS)).collect();
    let mut asked = 0;
    for chunk in due.chunks(BATCH) {
        let queries: Vec<Value> = chunk.iter().map(|(e, n, v)| serde_json::json!({"package": {"name": n, "ecosystem": e}, "version": v})).collect();
        asked += 1;
        let Some(res) = post(&serde_json::json!({ "queries": queries })) else { continue };
        let Some(results) = res.get("results").and_then(Value::as_array).filter(|r| r.len() == chunk.len()) else { continue };
        for (w, r) in chunk.iter().zip(results) {
            let vulns = r.get("vulns").and_then(Value::as_array).into_iter().flatten().filter_map(|v| Some((v.get("id")?.as_str()?.to_string(), v.get("modified").and_then(Value::as_str).unwrap_or("").to_string()))).collect();
            batch.results.insert(key(w), (at, vulns));
        }
    }
    // Answers not asked for in 30 days go (lockfiles moved on).
    batch.results.retain(|_, (t, _)| at.saturating_sub(*t) < 30 * 86400);
    if let Ok(b) = serde_json::to_vec(&batch) {
        let _ = util::write_atomic(&bp, &b);
    }
    // Advisory records not cached at the revision the batch named.
    let mut need: BTreeMap<String, String> = BTreeMap::new();
    for w in &wanted {
        for (id, m) in batch.results.get(&key(w)).map(|r| &r.1).into_iter().flatten() {
            need.insert(id.clone(), m.clone());
        }
    }
    let mut docs: BTreeMap<String, Doc> = BTreeMap::new();
    let mut fetch = vec![];
    for (id, m) in &need {
        match read_json::<Doc>(&doc_path(cache, id)) {
            // The batch states `modified` to the microsecond, the record to the nanosecond.
            Some(d) if d.modified.trim_end_matches('Z').starts_with(m.trim_end_matches('Z')) => {
                docs.insert(id.clone(), d);
            }
            _ => fetch.push(id.clone()),
        }
    }
    util::concurrent(&fetch, util::REQUESTS_AT_ONCE, |id| get(id).map(|v| read_osv(&v)), |i, d| {
        asked += 1;
        if let Some(d) = d {
            if let Ok(b) = serde_json::to_vec(&d) {
                let _ = util::write_atomic(&doc_path(cache, &fetch[i]), &b);
            }
            docs.insert(fetch[i].clone(), d);
        }
        true
    });
    let matches: BTreeMap<(String, String, String), Vec<String>> =
        wanted.iter().filter_map(|w| Some((w.clone(), batch.results.get(&key(w))?.1.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>()))).filter(|(_, v)| !v.is_empty()).collect();
    let locks: BTreeMap<String, Vec<crate::stack::Lock>> = gs
        .iter()
        .filter(|g| g.eco == "npm")
        .map(|g| (g.file.clone(), crate::stack::Lock::read_all(&root.join(g.file.rsplit_once('/').map(|(d, _)| d).unwrap_or(".")))))
        .collect();
    let overrides = |g: &Graph, name: &str| -> Vec<(String, &'static str)> {
        let base = g.file.rsplit('/').next().unwrap_or("");
        locks.get(&g.file).into_iter().flatten().filter(|l| l.file == base).flat_map(|l| l.override_values(name)).collect()
    };
    let today = (at / 86400) as i64;
    let (raw, items) = evaluate(&gs, &matches, &docs, overrides, today);
    let unused = removable(&gs, &items, |names| named_in(root, names));
    let rep = Report { checked: at, queried: wanted.len(), raw, items, unused };
    if let Ok(b) = serde_json::to_vec(&rep) {
        let _ = util::write_atomic(&report_path(cache, root), &b);
    }
    asked
}

/// The last check's report, from the cache alone.
pub fn report(cache: &Path, root: &Path) -> Option<Report> {
    read_json(&report_path(cache, root))
}

/// The shown groups at most: the rest are counted on one line that names `unstale advisories`.
pub const SHOWN_GROUPS: usize = 10;

/// The items under one heading per direct dependency (or set of them) that pulls packages in.
fn groups(r: &Report) -> BTreeMap<String, Vec<&Item>> {
    let mut groups: BTreeMap<String, Vec<&Item>> = BTreeMap::new();
    for it in &r.items {
        let head = if it.via.is_empty() {
            format!("{} {} (direct)", it.name, it.version)
        } else {
            // Runtime dependencies first (`evaluate`).
            let mut via = it.via.clone();
            let more = via.len().saturating_sub(3);
            via.truncate(3);
            format!("via {}{}", via.join(", "), if more > 0 { format!(" and {more} more") } else { String::new() })
        };
        groups.entry(head).or_default().push(it);
    }
    groups
}

/// When every item of a group is listed under unused direct dependencies only (`Report::unused`): the phrase that
/// replaces the conditions (an unused package is not at runtime, and its blocked fix is no route), e.g.
/// "unused: removing nuxt-og-image clears 6 advisories".
fn clears(r: &Report, its: &[&Item]) -> Option<String> {
    let mut deps: Vec<String> = vec![];
    for it in its {
        let own = if it.via.is_empty() { vec![format!("{} {}", it.name, it.version)] } else { it.via.clone() };
        for d in own {
            if !r.unused.contains(&d) {
                return None;
            }
            let name = d.rsplit_once(' ').map_or(d.clone(), |(n, _)| n.to_string());
            if !deps.contains(&name) {
                deps.push(name);
            }
        }
    }
    let n = its.len();
    Some(format!("unused: removing {} clears {n} advisor{}", deps.join(" and "), if n == 1 { "y" } else { "ies" }))
}

/// `clears` for a group, counting every item listed under the same unused dependencies only: removal clears the
/// advisories of all their groups (deer-flow: 6 via nuxt-og-image and 3 on it, 9).
fn clear_phrase(r: &Report, its: &[&Item]) -> Option<String> {
    clears(r, its)?;
    let mine = |i: &Item| if i.via.is_empty() { vec![format!("{} {}", i.name, i.version)] } else { i.via.clone() };
    let deps: BTreeSet<String> = its.iter().flat_map(|i| mine(i)).collect();
    let with: Vec<&Item> = r.items.iter().filter(|i| mine(i).iter().any(|d| deps.contains(d)) && mine(i).iter().all(|d| r.unused.contains(d))).collect();
    clears(r, &with)
}

/// An item's conditions, or the removal phrase in place of the runtime and fix conditions (its date stays).
fn why(it: &Item, clear: Option<&String>) -> String {
    match clear {
        None => it.why.join("; "),
        Some(c) => std::iter::once(c.clone()).chain(it.why.iter().filter(|w| w.starts_with("published ")).cloned()).collect::<Vec<_>>().join("; "),
    }
}

fn clean(t: &str) -> String {
    t.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

/// The report in short: one line per direct dependency (or set of them), with the count by severity and the worst
/// advisory; the worst groups first, at most `SHOWN_GROUPS`. Summaries are OSV's text, shown as data.
pub fn lines(r: &Report) -> Vec<String> {
    let mut gs: Vec<(String, Vec<&Item>)> = groups(r).into_iter().collect();
    // Items are sorted worst first (`evaluate`), so each group's first item is its worst.
    gs.sort_by(|(ha, a), (hb, b)| b[0].severity.cmp(&a[0].severity).then(b.len().cmp(&a.len())).then(ha.cmp(hb)));
    let mut out = vec![];
    for (head, its) in gs.iter().take(SHOWN_GROUPS) {
        let w = its[0];
        // The version that fixes every advisory on the worst package version, when each has one.
        let same: Vec<&&Item> = its.iter().filter(|i| i.name == w.name && i.version == w.version).collect();
        let fix = if same.iter().all(|i| i.fix.is_some()) {
            same.iter().filter_map(|i| i.fix.as_deref()).max_by_key(|f| util::parse_version(f).or_else(|| crate::pypi::parse_version(f))).map(|f| format!(" → {f}")).unwrap_or_default()
        } else {
            String::new()
        };
        let clear = clear_phrase(r, its);
        let worst = format!("{} {} {}{fix} · {} · {} (https://osv.dev/vulnerability/{})", w.severity.word(), w.name, w.version, why(w, clear.as_ref()), clean(&w.summary), w.id);
        if its.len() == 1 {
            out.push(format!("{head}: {worst}"));
            continue;
        }
        let mut counts: BTreeMap<Severity, usize> = BTreeMap::new();
        let mut others: Vec<String> = vec![];
        for it in its {
            *counts.entry(it.severity).or_default() += 1;
            let p = format!("{} {}", it.name, it.version);
            if p != format!("{} {}", w.name, w.version) && !others.contains(&p) {
                others.push(p);
            }
        }
        let counts: Vec<String> = counts.iter().rev().map(|(s, n)| format!("{n} {}", s.word())).collect();
        let also = if others.is_empty() { String::new() } else { format!(" · also {}", others.join(", ")) };
        out.push(format!("{head}: {} advisories ({}), worst {worst}{also}", its.len(), counts.join(", ")));
    }
    if gs.len() > SHOWN_GROUPS {
        let rest = &gs[SHOWN_GROUPS..];
        let n: usize = rest.iter().map(|(_, its)| its.len()).sum();
        out.push(format!("and {} more dependenc{} with {n} advisor{} (`unstale advisories` lists every one)", rest.len(), if rest.len() == 1 { "y" } else { "ies" }, if n == 1 { "y" } else { "ies" }));
    }
    out
}

/// The report in full (`unstale advisories`): one heading per direct dependency (or set of them), the advisories
/// under it. Summaries are OSV's text, shown as data.
pub fn detail_lines(r: &Report) -> Vec<String> {
    let mut out = vec![];
    for (head, its) in groups(r) {
        let clear = clear_phrase(r, &its);
        out.push(format!("{head}:"));
        // Several advisories on one package version read as one line: the version that fixes them all, the count by
        // severity, the worst one's summary, then the ids.
        let mut by_pkg: BTreeMap<(&str, &str), Vec<&Item>> = BTreeMap::new();
        for it in &its {
            by_pkg.entry((it.name.as_str(), it.version.as_str())).or_default().push(it);
        }
        for ((name, version), its) in by_pkg {
            if its.len() < 3 {
                for it in its {
                    let fix = it.fix.as_ref().map(|f| format!(" → {f}")).unwrap_or_default();
                    out.push(format!("  {} {} · {name} {version}{fix} · {} · {} (https://osv.dev/vulnerability/{})", it.id, it.severity.word(), why(it, clear.as_ref()), clean(&it.summary), it.id));
                }
                continue;
            }
            let fix = if its.iter().all(|i| i.fix.is_some()) {
                its.iter().filter_map(|i| i.fix.as_deref()).max_by_key(|f| util::parse_version(f).or_else(|| crate::pypi::parse_version(f))).map(|f| format!(" → {f}")).unwrap_or_default()
            } else {
                String::new()
            };
            let mut counts: BTreeMap<Severity, usize> = BTreeMap::new();
            let mut why: Vec<&str> = vec![];
            if let Some(c) = &clear {
                why.push(c);
            }
            for it in &its {
                *counts.entry(it.severity).or_default() += 1;
                for w in it.why.iter().filter(|w| clear.is_none() || w.starts_with("published ")) {
                    // "published 2026-09-30" once per date, the rest once.
                    if !why.contains(&w.as_str()) {
                        why.push(w);
                    }
                }
            }
            let counts: Vec<String> = counts.iter().rev().map(|(s, n)| format!("{n} {}", s.word())).collect();
            let ids: Vec<&str> = its.iter().map(|i| i.id.as_str()).collect();
            out.push(format!("  {} advisories ({}) · {name} {version}{fix} · {} · worst: {}", its.len(), counts.join(", "), why.join("; "), clean(&its[0].summary)));
            out.push(format!("    {}", ids.join(", ")));
        }
    }
    out
}

/// One summary line: shown against matched.
pub fn summary(r: &Report) -> String {
    format!(
        "{} of {} advisor{} on {} locked package versions call for action (critical or high at runtime, moderate at runtime with a blocked fix or new on a direct dependency, critical in development with no fix the ranges admit); the rest are counted, not shown",
        r.items.len(),
        r.raw,
        if r.raw == 1 { "y" } else { "ies" },
        r.queried
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(sev: Option<Severity>, published: &str, fixed: &[(&str, &str, &[&str])], aliases: &[&str]) -> Doc {
        Doc {
            modified: "m".into(),
            published: published.into(),
            summary: "s".into(),
            severity: sev,
            aliases: aliases.iter().map(|a| a.to_string()).collect(),
            fixed: fixed.iter().map(|(e, n, f)| (e.to_string(), n.to_string(), f.iter().map(|x| x.to_string()).collect())).collect(),
            withdrawn: false,
        }
    }

    const NPM_LOCK: &str = r#"{"lockfileVersion": 3, "packages": {
        "": {"name": "app", "dependencies": {"@react-router/serve": "7.18.2", "markdown-it": "^14.1.0", "pinned": "1.0.0"}, "devDependencies": {"jest": "^29"}},
        "node_modules/@react-router/serve": {"version": "7.18.2", "dependencies": {"express": "^4.21.0"}},
        "node_modules/express": {"version": "4.21.2", "dependencies": {"proxy-addr": "~2.0.7"}},
        "node_modules/proxy-addr": {"version": "2.0.7"},
        "node_modules/markdown-it": {"version": "14.1.0"},
        "node_modules/pinned": {"version": "1.0.0"},
        "node_modules/@acme/secret": {"version": "1.0.0", "resolved": "https://npm.acme.internal/@acme/secret/-/secret-1.0.0.tgz"},
        "node_modules/@corp/tool": {"version": "2.0.0", "resolved": "https://registry.npmjs.org/@corp/tool/-/tool-2.0.0.tgz"},
        "node_modules/jest": {"version": "29.0.0", "dev": true, "dependencies": {"braces": "^3.0.2"}},
        "node_modules/braces": {"version": "3.0.2", "dev": true},
        "node_modules/jest/node_modules/braces": {"version": "2.0.0", "dev": true}
    }}"#;

    fn run(g: Graph, docs: &[(&str, Doc)], m: &[(&str, &str, &[&str])], today: &str) -> (usize, Vec<Item>) {
        let matches = m.iter().map(|(n, v, ids)| ((g.eco.to_string(), n.to_string(), v.to_string()), ids.iter().map(|i| i.to_string()).collect())).collect();
        let docs = docs.iter().map(|(i, d)| (i.to_string(), d.clone())).collect();
        evaluate(&[g], &matches, &docs, |_, _| vec![], util::parse_date(today).unwrap())
    }

    #[test]
    fn npm_lock_resolves_like_node_and_marks_the_conditions() {
        let g = npm_lock(NPM_LOCK, ".", "package-lock.json");
        assert!(g.packages().contains(&("braces".into(), "2.0.0".into())), "a nested copy is its own package version");
        assert!(!g.packages().iter().any(|(n, _)| n == "@acme/secret"), "a private registry's package is never sent");
        let docs = [
            // (a) high, runtime, through an unused direct dependency: grouped under it.
            ("GHSA-proxy", doc(Some(Severity::High), "2025-01-01T00:00:00Z", &[("npm", "proxy-addr", &["2.0.8"])], &[])),
            // A moderate runtime advisory with a fix the ranges admit, old: a nit, dropped.
            ("GHSA-md", doc(Some(Severity::Moderate), "2025-01-01T00:00:00Z", &[("npm", "markdown-it", &["14.1.1"])], &[])),
            // (b) the manifest's exact pin refuses the fix.
            ("GHSA-pin", doc(Some(Severity::Moderate), "2025-01-01T00:00:00Z", &[("npm", "pinned", &["1.0.1"])], &[])),
            // Dev-only and moderate: dropped even with no fix and fresh.
            ("GHSA-braces", doc(Some(Severity::Moderate), "2026-10-01T00:00:00Z", &[], &[])),
            // Dev-only and high, no fix, fresh: dropped (a development tool's DoS is not worth acting on).
            ("GHSA-braces2", doc(Some(Severity::High), "2026-10-01T00:00:00Z", &[], &[])),
            // Dev-only and critical, no fix: shown (c).
            ("MAL-braces", doc(None, "2024-01-01T00:00:00Z", &[], &[])),
            // Dev-only and critical with a fix the ranges admit: dropped.
            ("GHSA-braces3", doc(Some(Severity::Critical), "2024-01-01T00:00:00Z", &[("npm", "braces", &["3.0.3"])], &[])),
        ];
        let mut docs = docs.to_vec();
        docs[5].1.severity = Some(Severity::Critical); // `read_osv` rates MAL- records critical
        let (raw, items) = run(
            g,
            &docs,
            &[("proxy-addr", "2.0.7", &["GHSA-proxy"]), ("markdown-it", "14.1.0", &["GHSA-md"]), ("pinned", "1.0.0", &["GHSA-pin"]), ("braces", "2.0.0", &["GHSA-braces", "GHSA-braces2", "MAL-braces"]), ("braces", "3.0.2", &["GHSA-braces3"])],
            "2026-10-18",
        );
        assert_eq!(raw, 7);
        let got: Vec<(&str, &[String], &[String])> = items.iter().map(|i| (i.id.as_str(), i.why.as_slice(), i.via.as_slice())).collect();
        assert_eq!(got.len(), 3, "{got:?}");
        assert_eq!(items[0].id, "MAL-braces");
        assert_eq!(items[0].why, vec!["no fixed version: replace or mitigate"]);
        assert_eq!(items[0].via, vec!["jest 29.0.0"]);
        assert_eq!(items[1].id, "GHSA-proxy");
        assert_eq!(items[1].why, vec!["high at runtime"]);
        assert_eq!(items[1].via, vec!["@react-router/serve 7.18.2"]);
        assert_eq!(items[2].id, "GHSA-pin");
        assert_eq!(items[2].why, vec!["fix blocked: . declares 1.0.0"]);
        assert!(items[2].via.is_empty());
        let r = Report { checked: 0, queried: 7, raw, items, unused: vec![] };
        let l = lines(&r);
        assert!(l.iter().any(|x| x.starts_with("via @react-router/serve 7.18.2: high proxy-addr 2.0.7 → 2.0.8 · high at runtime")), "{l:?}");
        assert!(l.iter().any(|x| x.starts_with("pinned 1.0.0 (direct): moderate pinned 1.0.0 → 1.0.1")), "{l:?}");
        assert!(detail_lines(&r).contains(&"pinned 1.0.0 (direct):".to_string()));
    }

    #[test]
    fn a_moderate_shows_only_at_runtime_when_blocked_or_new_on_a_direct_dependency() {
        let docs = [("GHSA-new", doc(Some(Severity::Moderate), "2026-10-01T00:00:00Z", &[("npm", "proxy-addr", &["2.0.8"]), ("npm", "markdown-it", &["14.1.1"])], &[]))];
        // New on a transitive package, with an admitted fix: nothing to act on.
        let g = npm_lock(NPM_LOCK, ".", "package-lock.json");
        assert_eq!(run(g, &docs, &[("proxy-addr", "2.0.7", &["GHSA-new"])], "2026-10-18").1, vec![]);
        // New on a direct dependency: shown.
        let g = npm_lock(NPM_LOCK, ".", "package-lock.json");
        let items = run(g, &docs, &[("markdown-it", "14.1.0", &["GHSA-new"])], "2026-10-18").1;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].why, vec!["published 2026-10-01"]);
        // No fixed version anywhere: a moderate nit.
        let docs = [("GHSA-nofix", doc(Some(Severity::Moderate), "2024-01-01T00:00:00Z", &[], &[]))];
        let g = npm_lock(NPM_LOCK, ".", "package-lock.json");
        assert_eq!(run(g, &docs, &[("proxy-addr", "2.0.7", &["GHSA-nofix"])], "2026-10-18").1, vec![]);
    }

    #[test]
    fn one_line_per_dependency_worst_first_and_capped() {
        let item = |id: &str, name: &str, sev: Severity, fix: &str, via: &str| Item {
            id: id.into(),
            name: name.into(),
            version: "1.0.0".into(),
            severity: sev,
            summary: format!("{id} summary"),
            fix: Some(fix.into()),
            why: vec!["high at runtime".into()],
            via: if via.is_empty() { vec![] } else { vec![via.into()] },
        };
        let mut items = vec![item("A-1", "a", Severity::Critical, "1.0.1", "top 1.0.0"), item("A-2", "a", Severity::High, "1.0.3", "top 1.0.0"), item("B-1", "b", Severity::Moderate, "1.1.0", "top 1.0.0")];
        for k in 0..12 {
            items.push(item(&format!("C-{k:02}"), &format!("c{k:02}"), Severity::High, "2.0.0", ""));
        }
        items.sort_by(|a, b| b.severity.cmp(&a.severity).then(a.name.cmp(&b.name)).then(a.id.cmp(&b.id)));
        let l = lines(&Report { checked: 0, queried: 20, raw: 20, items, unused: vec![] });
        assert_eq!(l.len(), SHOWN_GROUPS + 1, "{l:?}");
        assert_eq!(l[0], "via top 1.0.0: 3 advisories (1 critical, 1 high, 1 moderate), worst critical a 1.0.0 → 1.0.3 · high at runtime · A-1 summary (https://osv.dev/vulnerability/A-1) · also b 1.0.0");
        assert!(l[1].starts_with("c00 1.0.0 (direct): high c00 1.0.0 → 2.0.0"), "{}", l[1]);
        assert_eq!(l[SHOWN_GROUPS], "and 3 more dependencies with 3 advisories (`unstale advisories` lists every one)");
    }

    #[test]
    fn an_unused_direct_dependency_reads_as_removable() {
        // bytedance/deer-flow: nuxt-og-image in a Next.js app's dependencies, named nowhere else, read as "high at
        // runtime" (its Vue subtree) and "fix blocked" (a major away); removing it clears all nine.
        let lock = r#"{"lockfileVersion": 3, "packages": {
            "": {"name": "app", "dependencies": {"og": "^5.1.0", "used": "1.0.0", "peer": "1.0.0", "next": "1.0.0"}, "devDependencies": {"eslint-plugin-x": "1.0.0"}},
            "node_modules/og": {"version": "5.1.0", "dependencies": {"vue": "^3.0.0"}},
            "node_modules/vue": {"version": "3.5.0"},
            "node_modules/used": {"version": "1.0.0"},
            "node_modules/peer": {"version": "1.0.0"},
            "node_modules/next": {"version": "1.0.0", "peerDependencies": {"peer": "1.0.0"}},
            "node_modules/eslint-plugin-x": {"version": "1.0.0", "dev": true}}}"#;
        let g = npm_lock(lock, ".", "package-lock.json");
        let it = |id: &str, name: &str, version: &str, via: &[&str], why: &[&str]| Item {
            id: id.into(),
            name: name.into(),
            version: version.into(),
            severity: Severity::High,
            summary: "s".into(),
            fix: Some("9.0.0".into()),
            why: why.iter().map(|w| w.to_string()).collect(),
            via: via.iter().map(|v| v.to_string()).collect(),
        };
        let items = vec![
            it("V-1", "vue", "3.5.0", &["og 5.1.0"], &["high at runtime", "published 2026-10-05"]),
            it("O-1", "og", "5.1.0", &[], &["high at runtime", "fix blocked: . declares ^5.1.0"]),
            it("U-1", "used", "1.0.0", &[], &["high at runtime"]),
            it("P-1", "peer", "1.0.0", &[], &["high at runtime"]),
            it("E-1", "eslint-plugin-x", "1.0.0", &[], &["no fixed version: replace or mitigate"]),
        ];
        // `named` sees every candidate but the ones a package requires (peer) or only development declares.
        let asked = std::cell::RefCell::new(vec![]);
        let unused = removable(&[g], &items, |names| {
            asked.borrow_mut().extend(names.iter().map(|n| n.to_string()));
            names.iter().filter(|n| **n == "used").map(|n| n.to_string()).collect()
        });
        assert_eq!(asked.into_inner(), vec!["og", "used"]);
        assert_eq!(unused, vec!["og 5.1.0"]);
        let l = lines(&Report { checked: 0, queried: 7, raw: 5, items, unused });
        assert!(l.contains(&"via og 5.1.0: high vue 3.5.0 → 9.0.0 · unused: removing og clears 2 advisories; published 2026-10-05 · s (https://osv.dev/vulnerability/V-1)".to_string()), "{l:?}");
        assert!(l.contains(&"og 5.1.0 (direct): high og 5.1.0 → 9.0.0 · unused: removing og clears 2 advisories · s (https://osv.dev/vulnerability/O-1)".to_string()), "{l:?}");
        assert!(l.iter().any(|x| x.starts_with("used 1.0.0 (direct): high used 1.0.0 → 9.0.0 · high at runtime")), "{l:?}");
    }

    #[test]
    fn a_package_json_names_a_package_outside_its_dependency_maps() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("package.json"), r#"{"scripts": {"serve": "sirv build"}, "dependencies": {"og": "1", "sirv": "1", "cmd": "1", "lib": "1"}}"#).unwrap();
        std::fs::write(d.path().join("Dockerfile"), "RUN npx cmd --port 3000\n").unwrap();
        std::fs::create_dir(d.path().join("src")).unwrap();
        std::fs::write(d.path().join("src/a.ts"), "import x from 'lib/sub';\n").unwrap();
        let got = named_in(d.path(), &["og", "sirv", "cmd", "lib"]);
        assert_eq!(got, ["cmd", "lib", "sirv"].iter().map(|s| s.to_string()).collect());
    }

    #[test]
    fn fresh_advisories_show_and_aliases_count_once() {
        let g = npm_lock(NPM_LOCK, ".", "package-lock.json");
        let docs = [
            ("GHSA-md", doc(Some(Severity::Low), "2026-10-01T00:00:00Z", &[("npm", "markdown-it", &["14.1.1"])], &["CVE-1"])),
            ("OTHER-md", doc(Some(Severity::Moderate), "2026-10-01T00:00:00Z", &[("npm", "markdown-it", &["14.1.1"])], &["CVE-1"])),
        ];
        let (raw, items) = run(g, &docs, &[("markdown-it", "14.1.0", &["OTHER-md", "GHSA-md"])], "2026-10-18");
        assert_eq!(raw, 1);
        assert_eq!(items.len(), 1);
        assert_eq!((items[0].id.as_str(), items[0].severity), ("GHSA-md", Severity::Moderate));
        assert_eq!(items[0].why, vec!["published 2026-10-01"]);
        // Past the window, the same moderate runtime advisory with an admitted fix is a nit.
        let g = npm_lock(NPM_LOCK, ".", "package-lock.json");
        assert_eq!(run(g, &docs, &[("markdown-it", "14.1.0", &["GHSA-md"])], "2027-01-18").1, vec![]);
    }

    #[test]
    fn pnpm_v9_graph_with_importers_snapshots_and_links() {
        let text = "---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      pnpm:\n        specifier: 11.0.0\n        version: 11.0.0\n---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      markdown-it:\n        specifier: ^14.1.0\n        version: 14.2.0\n      '@kbn/ui':\n        specifier: link:packages/ui\n        version: link:packages/ui\n    devDependencies:\n      jest:\n        specifier: ^29\n        version: 29.0.0(@types/node@20.0.0)\n\n  packages/ui:\n    dependencies:\n      maplibre-gl:\n        specifier: 5.0.0\n        version: 5.0.0\n\npackages:\n\n  markdown-it@14.2.0:\n    resolution: {integrity: sha512-x}\n\n  braces@3.0.2:\n    resolution: {integrity: sha512-y, tarball: https://npm.acme.internal/braces-3.0.2.tgz}\n\nsnapshots:\n\n  markdown-it@14.2.0:\n    dependencies:\n      linkify-it: 5.0.2\n      string-width-cjs: string-width@4.2.3\n\n  linkify-it@5.0.2: {}\n\n  jest@29.0.0(@types/node@20.0.0):\n    dependencies:\n      braces: 3.0.2\n\n  braces@3.0.2: {}\n\n  maplibre-gl@5.0.0: {}\n";
        let g = pnpm_lock(text, ".", "pnpm-lock.yaml");
        let p = g.packages();
        assert!(!p.contains(&("pnpm".into(), "11.0.0".into())), "the package manager's own lock is not the project's");
        assert!(!p.contains(&("braces".into(), "3.0.2".into())), "a tarball outside the registry is never sent");
        for (n, v) in [("markdown-it", "14.2.0"), ("linkify-it", "5.0.2"), ("string-width", "4.2.3"), ("jest", "29.0.0"), ("maplibre-gl", "5.0.0")] {
            assert!(p.contains(&(n.into(), v.into())), "{n} {p:?}");
        }
        let docs = [
            ("GHSA-ml", doc(Some(Severity::Critical), "2025-01-01T00:00:00Z", &[("npm", "maplibre-gl", &["5.0.1"])], &[])),
            ("GHSA-li", doc(Some(Severity::High), "2025-01-01T00:00:00Z", &[("npm", "linkify-it", &["5.0.3"])], &[])),
            ("GHSA-br", doc(Some(Severity::Low), "2026-10-10T00:00:00Z", &[], &[])),
        ];
        let (raw, items) = run(g, &docs, &[("maplibre-gl", "5.0.0", &["GHSA-ml"]), ("linkify-it", "5.0.2", &["GHSA-li"]), ("braces", "3.0.2", &["GHSA-br"])], "2026-10-18");
        assert_eq!(raw, 3);
        let ids: Vec<(&str, Vec<String>, Vec<String>)> = items.iter().map(|i| (i.id.as_str(), i.why.clone(), i.via.clone())).collect();
        assert_eq!(
            ids,
            vec![
                ("GHSA-ml", vec!["critical at runtime".into(), "fix blocked: packages/ui declares 5.0.0".into()], vec![]),
                ("GHSA-li", vec!["high at runtime".into()], vec!["markdown-it 14.2.0".into()]),
            ],
            "a workspace member's dependency is direct and runtime through the link; dev-only low is dropped"
        );
    }

    #[test]
    fn uv_and_yarn_graphs() {
        let uv = "version = 1\n\n[[package]]\nname = \"locust\"\nversion = \"2.0\"\nsource = { editable = \".\" }\ndependencies = [{ name = \"requests\" }]\n\n[package.dev-dependencies]\ndev = [{ name = \"pytest\" }]\n\n[package.metadata]\nrequires-dist = [{ name = \"requests\", specifier = \">=2.32\" }]\n\n[[package]]\nname = \"requests\"\nversion = \"2.32.0\"\nsource = { registry = \"https://pypi.org/simple\" }\ndependencies = [{ name = \"urllib3\" }]\n\n[[package]]\nname = \"urllib3\"\nversion = \"2.2.1\"\nsource = { registry = \"https://pypi.org/simple\" }\n\n[[package]]\nname = \"pytest\"\nversion = \"8.0.0\"\nsource = { registry = \"https://pypi.org/simple\" }\n";
        let g = uv_lock(uv, ".", "uv.lock");
        let docs = [("GHSA-u3", doc(Some(Severity::High), "2025-06-01T00:00:00Z", &[("PyPI", "urllib3", &["2.5.0"])], &["PYSEC-1"])), ("PYSEC-1", doc(None, "2025-06-01T00:00:00Z", &[("PyPI", "urllib3", &["2.5.0"])], &["GHSA-u3"]))];
        let (raw, items) = run(g, &docs, &[("urllib3", "2.2.1", &["PYSEC-1", "GHSA-u3"])], "2026-10-18");
        assert_eq!(raw, 1);
        assert_eq!((items[0].id.as_str(), items[0].via.clone(), items[0].why.clone()), ("GHSA-u3", vec!["requests 2.32.0".to_string()], vec!["high at runtime".to_string()]));

        let yarn = "# yarn lockfile v1\n\n\"left-pad@^1.0.0\", left-pad@^1.1.0:\n  version \"1.1.0\"\n  dependencies:\n    tiny \"~1.0.0\"\n\ntiny@~1.0.0:\n  version \"1.0.0\"\n";
        let m = vec![(".".to_string(), serde_json::json!({"name": "app", "dependencies": {"left-pad": "^1.0.0"}}))];
        let g = yarn_lock(yarn, "yarn.lock", &m);
        // tiny's parent range ~1.0.0 refuses the only fix, 1.1.0.
        let docs = [("GHSA-t", doc(Some(Severity::Moderate), "2024-01-01T00:00:00Z", &[("npm", "tiny", &["1.1.0"])], &[]))];
        let (_, items) = run(g, &docs, &[("tiny", "1.0.0", &["GHSA-t"])], "2026-10-18");
        assert_eq!(items[0].why, vec!["fix blocked: left-pad 1.1.0 requires ~1.0.0"]);
        assert_eq!(items[0].via, vec!["left-pad 1.1.0"]);
    }

    #[test]
    fn a_ci_manifests_dependencies_are_not_runtime() {
        let g = npm_lock(NPM_LOCK, ".buildkite", ".buildkite/package-lock.json");
        let docs = [("GHSA-proxy", doc(Some(Severity::High), "2025-01-01T00:00:00Z", &[("npm", "proxy-addr", &["2.0.8"])], &[]))];
        assert_eq!(run(g, &docs, &[("proxy-addr", "2.0.7", &["GHSA-proxy"])], "2026-10-18").1, vec![], "high, fix admitted, old, and only a CI script runs it");
    }

    #[test]
    fn osv_records_are_read() {
        let v = serde_json::json!({"id": "GHSA-x", "modified": "2026-01-02T00:00:00Z", "published": "2026-01-01T00:00:00Z", "summary": "Bad\nthing", "aliases": ["CVE-1"],
            "database_specific": {"severity": "HIGH"},
            "affected": [{"package": {"ecosystem": "npm", "name": "a"}, "ranges": [{"type": "SEMVER", "events": [{"introduced": "0"}, {"fixed": "1.2.3"}]}]}]});
        let d = read_osv(&v);
        assert_eq!(d.severity, Some(Severity::High));
        assert_eq!(d.fixed, vec![("npm".into(), "a".into(), vec!["1.2.3".into()])]);
        assert_eq!(read_osv(&serde_json::json!({"id": "MAL-2026-1", "modified": "m"})).severity, Some(Severity::Critical));
    }

    #[test]
    fn requests_are_batched_cached_and_outputs_read_the_cache() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("package.json"), r#"{"name": "app", "dependencies": {"@react-router/serve": "7.18.2"}}"#).unwrap();
        std::fs::write(d.path().join("package-lock.json"), NPM_LOCK).unwrap();
        std::fs::write(d.path().join(".npmrc"), "@corp:registry=https://npm.corp.example/\n").unwrap();
        let st = crate::stack::detect(d.path()).unwrap();
        let names: BTreeSet<String> = graphs(d.path(), &st).iter().flat_map(|g| g.packages()).map(|p| p.0).collect();
        assert!(!names.contains("@corp/tool") && !names.contains("@acme/secret") && names.contains("proxy-addr"), "{names:?}");
        let cache = tempfile::tempdir().unwrap();
        let posts = std::sync::Mutex::new(0);
        let post = |b: &Value| {
            *posts.lock().unwrap() += 1;
            let qs = b["queries"].as_array().unwrap();
            Some(serde_json::json!({"results": qs.iter().map(|q| if q["package"]["name"] == "proxy-addr" { serde_json::json!({"vulns": [{"id": "GHSA-p", "modified": "m1"}]}) } else { serde_json::json!({}) }).collect::<Vec<_>>()}))
        };
        let get = |id: &str| Some(serde_json::json!({"id": id, "modified": "m1", "published": "2020-01-01T00:00:00Z", "summary": "proxy", "database_specific": {"severity": "HIGH"}, "affected": [{"package": {"ecosystem": "npm", "name": "proxy-addr"}, "ranges": [{"events": [{"introduced": "0"}, {"fixed": "2.0.8"}]}]}]}));
        assert_eq!(report(cache.path(), d.path()), None);
        assert_eq!(refresh_with(cache.path(), d.path(), &st, 1_000_000, post, get, |_| None), 2, "one batch, one record");
        let r = report(cache.path(), d.path()).unwrap();
        assert_eq!((r.queried, r.raw, r.items.len()), (8, 1, 1), "the private and the .npmrc-scoped packages are not queried");
        assert_eq!(refresh_with(cache.path(), d.path(), &st, 1_000_000 + 3600, post, get, |_| None), 0, "fresh: nothing asked");
        assert_eq!(refresh_with(cache.path(), d.path(), &st, 1_000_000 + FRESH_SECS, post, |_| None, |_| None), 1, "the batch again; the record is cached at its revision");
        assert_eq!(*posts.lock().unwrap(), 2);
        assert_eq!(report(cache.path(), d.path()).unwrap().items.len(), 1);
    }
}

/// A live measurement against OSV: `UNSTALE_OSV_LIVE=<repo> UNSTALE_OSV_CACHE=<dir> cargo test live_osv -- --ignored --nocapture`.
#[cfg(test)]
#[test]
#[ignore]
fn live_osv() {
    let root = PathBuf::from(std::env::var("UNSTALE_OSV_LIVE").unwrap());
    let cache = PathBuf::from(std::env::var("UNSTALE_OSV_CACHE").unwrap());
    let st = crate::stack::detect(&root).unwrap();
    let asked = refresh(&cache, &root, &st);
    let r = report(&cache, &root).unwrap();
    println!("requests {asked}\n{}", summary(&r));
    for l in lines(&r) {
        println!("{l}");
    }
    println!("--- detail");
    for l in detail_lines(&r) {
        println!("{l}");
    }
}
