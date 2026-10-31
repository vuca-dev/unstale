//! Cargo manifest and lockfile inventory. Cargo versions are resolved only from the lockfile associated with an
//! actual workspace member or standalone package; manifest requirements are metadata, never installed versions.

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use semver::{Version, VersionReq};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Component, Path, PathBuf};
use toml::Value;

use crate::stack::{self, Kind};

#[derive(Clone, PartialEq, Eq)]
pub enum CargoDependencySource {
    DefaultRegistry,
    NamedRegistry {
        name: String,
    },
    Git {
        url: String,
        rev: Option<String>,
        branch: Option<String>,
        tag: Option<String>,
    },
    Path {
        path: String,
    },
    Unknown {
        detail: Option<String>,
    },
}

// Registry URLs, local paths, and git revisions must never leak through inventory debug output.
impl fmt::Debug for CargoDependencySource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::DefaultRegistry => "DefaultRegistry",
            Self::NamedRegistry { .. } => "NamedRegistry(<redacted>)",
            Self::Git { .. } => "Git(<redacted>)",
            Self::Path { .. } => "Path(<redacted>)",
            Self::Unknown { .. } => "Unknown(<redacted>)",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CargoDependencyKind {
    Normal,
    Development,
    Build,
}

#[derive(Clone, PartialEq, Eq)]
pub struct CargoPackageId {
    pub name: String,
    pub version: Version,
    pub source: Option<String>,
}
impl fmt::Debug for CargoPackageId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CargoPackageId")
            .field("name", &self.name)
            .field("version", &self.version)
            .field("source", &self.source.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct CargoManifest {
    pub path: String,
    pub dir: String,
    pub package: Option<CargoPackage>,
    pub lockfile: Option<String>,
}
#[derive(Debug, Clone)]
pub struct CargoPackage {
    pub name: String,
    pub version: Option<Version>,
    pub kind: Kind,
}
#[derive(Debug, Clone)]
pub struct CargoWorkspace {
    pub root: String,
    pub members: BTreeSet<String>,
    pub excluded: BTreeSet<String>,
    pub lockfile: Option<String>,
}

#[derive(Clone)]
pub struct CargoDependency {
    pub manifest_dir: String,
    pub alias: String,
    pub package: Option<String>,
    pub kind: CargoDependencyKind,
    pub target: Option<String>,
    pub requirement: Option<String>,
    pub source: CargoDependencySource,
    pub optional: bool,
    pub features: Vec<String>,
    pub default_features: Option<bool>,
    pub resolved: Option<CargoPackageId>,
    /// Effective parsed manifest value for the shared privacy classifier; excluded from Debug and third-party flows.
    pub(crate) privacy_declaration: Option<Value>,
}
impl fmt::Debug for CargoDependency {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CargoDependency")
            .field("manifest_dir", &self.manifest_dir)
            .field("alias", &self.alias)
            .field("package", &self.package)
            .field("kind", &self.kind)
            .field("target", &self.target)
            .field(
                "requirement",
                &self.requirement.as_ref().map(|_| "<redacted>"),
            )
            .field("source", &self.source)
            .field("optional", &self.optional)
            .field("features", &self.features)
            .field("default_features", &self.default_features)
            .field("resolved", &self.resolved)
            .finish()
    }
}
#[derive(Debug, Clone)]
pub struct CargoLock {
    pub file: String,
    pub format_version: Option<u64>,
    pub packages: Vec<CargoLockPackage>,
}
#[derive(Clone)]
pub struct CargoLockPackage {
    pub id: CargoPackageId,
    pub checksum: Option<String>,
    pub dependencies: Vec<CargoLockDependency>,
}
impl fmt::Debug for CargoLockPackage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CargoLockPackage")
            .field("id", &self.id)
            .field("checksum", &self.checksum)
            .field("dependencies", &self.dependencies)
            .finish()
    }
}
#[derive(Clone)]
pub struct CargoLockDependency {
    pub name: String,
    pub version: Option<Version>,
    pub source: Option<String>,
}
impl fmt::Debug for CargoLockDependency {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CargoLockDependency")
            .field("name", &self.name)
            .field("version", &self.version)
            .field("source", &self.source.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[derive(Debug, Clone, Default)]
pub struct CargoInventory {
    pub manifests: BTreeMap<String, CargoManifest>,
    pub workspaces: Vec<CargoWorkspace>,
    pub lockfiles: BTreeMap<String, CargoLock>,
    pub declarations: Vec<CargoDependency>,
}

#[derive(Clone)]
struct Parsed {
    path: String,
    dir: String,
    doc: Value,
    package_name: Option<String>,
    raw_version: Option<Version>,
    has_package: bool,
    has_workspace: bool,
}

fn rel(root: &Path, path: &Path) -> String {
    let x = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    if x.is_empty() { ".".into() } else { x }
}
fn normalize_path(path: &Path) -> Option<String> {
    let mut parts: Vec<String> = vec![];
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    })
}
fn str_value(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}
fn simple_globs(patterns: impl Iterator<Item = String>) -> (Option<GlobSet>, bool) {
    let mut b = GlobSetBuilder::new();
    let mut any = false;
    let mut bad = false;
    for p in patterns {
        match GlobBuilder::new(&p).literal_separator(true).build() {
            Ok(g) => {
                b.add(g);
                any = true;
            }
            Err(_) => bad = true,
        }
    }
    (if any { b.build().ok() } else { None }, bad)
}
fn glob_match(patterns: Option<&GlobSet>, dir: &str) -> bool {
    patterns.is_some_and(|g| g.is_match(dir))
}
fn normalize_workspace_paths(
    root: &str,
    patterns: impl Iterator<Item = String>,
) -> (Vec<String>, bool) {
    let mut out = Vec::new();
    let mut invalid = false;
    for pattern in patterns {
        match normalize_path(&Path::new(root).join(pattern)) {
            Some(path) => out.push(path),
            None => invalid = true,
        }
    }
    (out, invalid)
}

pub fn detect(root: &Path, notes: &mut Vec<String>, unreadable: &mut usize) -> CargoInventory {
    let mut paths: Vec<PathBuf> = stack::walker(root)
        .flatten()
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()) && e.file_name() == "Cargo.toml")
        .filter_map(|e| {
            let p = e.path();
            let dir = rel(root, p.parent().unwrap_or(root));
            (!dir.contains("{{")
                && matches!(
                    crate::usage::path_role(&dir),
                    crate::usage::Role::App | crate::usage::Role::Tooling
                ))
            .then(|| p.to_path_buf())
        })
        .collect();
    paths.sort();
    let mut parsed: BTreeMap<String, Parsed> = BTreeMap::new();
    for path in paths {
        let dir = rel(root, path.parent().unwrap_or(root));
        let file = rel(root, &path);
        let doc = match std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| toml::from_str::<Value>(&s).ok())
        {
            Some(doc) => doc,
            None => {
                note(
                    notes,
                    format!(
                        "{file}: Cargo manifest could not be read; its package and dependencies may be missing."
                    ),
                );
                *unreadable += 1;
                continue;
            }
        };
        let package = doc.get("package");
        let package_name = str_value(package.and_then(|p| p.get("name")))
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let raw_version =
            str_value(package.and_then(|p| p.get("version"))).and_then(|s| Version::parse(s).ok());
        parsed.insert(
            dir.clone(),
            Parsed {
                path: file,
                dir,
                doc: doc.clone(),
                package_name,
                raw_version,
                has_package: package.is_some(),
                has_workspace: doc.get("workspace").is_some(),
            },
        );
    }

    let roots: BTreeSet<String> = parsed
        .values()
        .filter(|p| p.has_workspace)
        .map(|p| p.dir.clone())
        .collect();
    let package_dirs: BTreeSet<String> = parsed
        .values()
        .filter(|p| p.has_package)
        .map(|p| p.dir.clone())
        .collect();
    let mut workspaces = Vec::new();
    let mut member_owner: BTreeMap<String, String> = BTreeMap::new();
    let mut excluded_owner: BTreeMap<String, String> = BTreeMap::new();
    for root_dir in &roots {
        let p = &parsed[root_dir];
        let ws = p.doc.get("workspace");
        let members = ws
            .and_then(|w| w.get("members"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string);
        let excludes = ws
            .and_then(|w| w.get("exclude"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string);
        let (members, invalid_member_paths) = normalize_workspace_paths(root_dir, members);
        let (excludes, invalid_exclude_paths) = normalize_workspace_paths(root_dir, excludes);
        let (member_globs, bad_members) = simple_globs(members.into_iter());
        let (exclude_globs, bad_excludes) = simple_globs(excludes.into_iter());
        if bad_members || bad_excludes || invalid_member_paths || invalid_exclude_paths {
            note(
                notes,
                format!(
                    "{}: invalid Cargo workspace pattern ignored; membership may be incomplete.",
                    p.path
                ),
            );
        }
        let nested_roots: Vec<&str> = roots
            .iter()
            .filter(|r| *r != root_dir && under(r, root_dir))
            .map(String::as_str)
            .collect();
        let pattern_members: BTreeSet<String> = package_dirs
            .iter()
            .filter(|d| {
                if *d == root_dir || nested_roots.iter().any(|n| under(d, n)) {
                    return false;
                }
                glob_match(member_globs.as_ref(), d)
            })
            .cloned()
            .collect();
        let excluded: BTreeSet<String> = package_dirs
            .iter()
            .filter(|d| {
                if *d == root_dir || nested_roots.iter().any(|n| under(d, n)) {
                    return false;
                }
                glob_match(exclude_globs.as_ref(), d)
            })
            .cloned()
            .collect();
        let mut members = pattern_members
            .difference(&excluded)
            .cloned()
            .collect::<BTreeSet<_>>();
        if p.has_package && !excluded.contains(root_dir) {
            members.insert(root_dir.clone());
        }
        // Cargo includes path dependencies beneath the workspace root unless excluded. Follow only package manifests
        // already discovered, and never cross a nested workspace boundary.
        loop {
            let old = members.len();
            let current: Vec<String> = members.iter().cloned().collect();
            for md in current {
                let Some(mp) = parsed.get(&md) else { continue };
                for (path_dep, inherited) in dependency_path_values(&mp.doc, Some(&p.doc)) {
                    let base_dir = if inherited {
                        root_dir.as_str()
                    } else {
                        md.as_str()
                    };
                    let Some(joined) = normalize_path(&Path::new(base_dir).join(path_dep)) else {
                        continue;
                    };
                    if package_dirs.contains(&joined)
                        && under(&joined, root_dir)
                        && !excluded.contains(&joined)
                        && !nested_roots.iter().any(|n| under(&joined, n))
                    {
                        members.insert(joined);
                    }
                }
            }
            if members.len() == old {
                break;
            }
        }
        for m in &members {
            member_owner
                .entry(m.clone())
                .or_insert_with(|| root_dir.clone());
        }
        for e in &excluded {
            excluded_owner
                .entry(e.clone())
                .or_insert_with(|| root_dir.clone());
        }
        let lock = root
            .join(root_dir)
            .join("Cargo.lock")
            .is_file()
            .then(|| rel(root, &root.join(root_dir).join("Cargo.lock")));
        workspaces.push(CargoWorkspace {
            root: root_dir.clone(),
            members,
            excluded,
            lockfile: lock,
        });
    }
    // `[package].workspace` explicitly names the workspace root and can associate a package outside
    // the root's directory tree. It takes precedence over inferred ancestor membership.
    for (dir, package) in parsed.iter().filter(|(_, p)| p.has_package) {
        let workspace_path = package
            .doc
            .get("package")
            .and_then(|p| p.get("workspace"))
            .and_then(Value::as_str);
        let Some(workspace_path) = workspace_path else {
            continue;
        };
        let Some(workspace_dir) = normalize_path(&Path::new(dir).join(workspace_path)) else {
            note(
                notes,
                format!(
                    "{}: invalid package workspace path; workspace association may be incomplete.",
                    package.path
                ),
            );
            continue;
        };
        let Some(workspace) = workspaces.iter().find(|w| w.root == workspace_dir) else {
            member_owner.remove(dir);
            excluded_owner.remove(dir);
            note(
                notes,
                format!(
                    "{}: package workspace root was not discovered; workspace association may be incomplete.",
                    package.path
                ),
            );
            continue;
        };
        if workspace.members.contains(dir) && !workspace.excluded.contains(dir) {
            member_owner.insert(dir.clone(), workspace_dir.clone());
            excluded_owner.remove(dir);
        } else {
            member_owner.remove(dir);
            excluded_owner.remove(dir);
            note(
                notes,
                format!(
                    "{}: package workspace root does not list this package; it was not associated with that workspace.",
                    package.path
                ),
            );
        }
    }
    workspaces.sort_by(|a, b| a.root.cmp(&b.root));

    let mut inventory = CargoInventory {
        workspaces,
        ..Default::default()
    };
    let ws_roots: BTreeMap<String, usize> = inventory
        .workspaces
        .iter()
        .enumerate()
        .map(|(i, w)| (w.root.clone(), i))
        .collect();
    let mut association: BTreeMap<String, Option<String>> = BTreeMap::new();
    let mut standalone_dirs: BTreeSet<String> = BTreeSet::new();
    for dir in parsed.keys() {
        if let Some(owner) = member_owner.get(dir) {
            association.insert(dir.clone(), Some(owner.clone()));
        } else if roots.contains(dir) {
            association.insert(dir.clone(), Some(dir.clone()));
        } else if excluded_owner.contains_key(dir)
            || !roots.iter().any(|r| dir != r && under(dir, r))
        {
            association.insert(dir.clone(), None); // standalone project
            standalone_dirs.insert(dir.clone());
        } else {
            association.insert(dir.clone(), None); // omitted by an enclosing workspace; not an independent project
        }
    }

    // Lockfiles are associated only through the membership computation above.
    let mut lock_paths: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (dir, owner) in &association {
        let lock = if let Some(ws) = owner {
            inventory.workspaces[ws_roots[ws]].lockfile.clone()
        } else if standalone_dirs.contains(dir) {
            let path = root.join(dir).join("Cargo.lock");
            path.is_file().then(|| rel(root, &path))
        } else {
            None
        };
        if let Some(l) = &lock {
            lock_paths.entry(l.clone()).or_default().insert(dir.clone());
        }
        if let Some(p) = parsed.get(dir) {
            let inherited_version = owner.as_ref().and_then(|w| parsed.get(w)).and_then(|w| {
                str_value(
                    w.doc
                        .get("workspace")
                        .and_then(|x| x.get("package"))
                        .and_then(|x| x.get("version")),
                )
                .and_then(|s| Version::parse(s).ok())
            });
            let version = p.raw_version.clone().or_else(|| {
                (p.doc
                    .get("package")
                    .and_then(|x| x.get("version"))
                    .and_then(|x| x.get("workspace"))
                    .and_then(Value::as_bool)
                    == Some(true))
                .then_some(inherited_version)
                .flatten()
            });
            let cargo_package = p.package_name.as_ref().map(|name| CargoPackage {
                name: name.clone(),
                version,
                kind: if p.doc.get("lib").is_some() || root.join(dir).join("src/lib.rs").is_file() {
                    Kind::Library
                } else {
                    Kind::Application
                },
            });
            inventory.manifests.insert(
                dir.clone(),
                CargoManifest {
                    path: p.path.clone(),
                    dir: dir.clone(),
                    package: cargo_package,
                    lockfile: lock,
                },
            );
        }
    }
    for (file, _) in lock_paths {
        let path = root.join(&file);
        match read_lock(&path, &file, notes, unreadable) {
            Some(lock) => {
                inventory.lockfiles.insert(file, lock);
            }
            None => {}
        }
    }

    // Parse declarations after workspace ownership is known so `workspace = true` inherits only from its real root.
    for (dir, p) in &parsed {
        if !p.has_package {
            continue;
        }
        let ws_root = association.get(dir).and_then(Clone::clone);
        let ws_doc = ws_root.as_ref().and_then(|r| parsed.get(r)).map(|p| &p.doc);
        for (kind, target, alias, raw) in dependency_values(&p.doc) {
            let mut effective = raw.clone();
            let inherited = raw
                .as_table()
                .and_then(|t| t.get("workspace"))
                .and_then(Value::as_bool)
                == Some(true);
            if inherited {
                let base = ws_doc
                    .and_then(|d| d.get("workspace"))
                    .and_then(|w| w.get("dependencies"))
                    .and_then(|d| d.get(&alias));
                if let Some(base) = base.filter(|v| v.is_str() || v.is_table()) {
                    effective = merge_inherited(base, &raw);
                } else {
                    note(
                        notes,
                        format!(
                            "{}: workspace dependency inheritance could not be resolved for one declaration.",
                            p.path
                        ),
                    );
                    let mut unresolved = parse_dependency(dir, alias, kind, target, &raw);
                    unresolved.package = None;
                    inventory.declarations.push(unresolved);
                    continue;
                }
            }
            inventory
                .declarations
                .push(parse_dependency(dir, alias, kind, target, &effective));
        }
    }
    resolve_declarations(&mut inventory);
    inventory
}

fn note(notes: &mut Vec<String>, text: String) {
    if notes.len() < 100 {
        notes.push(text);
    }
}
fn under(path: &str, root: &str) -> bool {
    root == "." || path == root || path.strip_prefix(root).is_some_and(|r| r.starts_with('/'))
}
fn dependency_values(doc: &Value) -> Vec<(CargoDependencyKind, Option<String>, String, Value)> {
    fn sections(
        t: &Value,
        target: Option<String>,
        out: &mut Vec<(CargoDependencyKind, Option<String>, String, Value)>,
    ) {
        for (field, kind) in [
            ("dependencies", CargoDependencyKind::Normal),
            ("dev-dependencies", CargoDependencyKind::Development),
            ("build-dependencies", CargoDependencyKind::Build),
        ] {
            if let Some(map) = t.get(field).and_then(Value::as_table) {
                out.extend(
                    map.iter()
                        .map(|(alias, value)| (kind, target.clone(), alias.clone(), value.clone())),
                );
            }
        }
    }
    let mut out = vec![];
    sections(doc, None, &mut out);
    if let Some(targets) = doc.get("target").and_then(Value::as_table) {
        for (selector, t) in targets {
            sections(t, Some(selector.clone()), &mut out);
        }
    }
    out
}
fn dependency_path_values(doc: &Value, workspace: Option<&Value>) -> Vec<(String, bool)> {
    dependency_values(doc)
        .into_iter()
        .filter_map(|(_, _, alias, v)| {
            let inherited = v
                .as_table()
                .and_then(|t| t.get("workspace"))
                .and_then(Value::as_bool)
                == Some(true);
            let effective = if inherited {
                workspace
                    .and_then(|w| w.get("workspace"))
                    .and_then(|w| w.get("dependencies"))
                    .and_then(|d| d.get(&alias))?
            } else {
                &v
            };
            effective
                .get("path")
                .and_then(Value::as_str)
                .map(|p| (p.to_string(), inherited))
        })
        .collect()
}

fn merge_inherited(base: &Value, member: &Value) -> Value {
    let mut merged = if let Some(version) = base.as_str() {
        let mut inherited = toml::map::Map::new();
        inherited.insert("version".into(), Value::String(version.to_string()));
        inherited
    } else if let Some(table) = base.as_table() {
        table.clone()
    } else {
        return member.clone();
    };
    let Some(local) = member.as_table() else {
        return member.clone();
    };
    for (k, v) in local {
        if k == "workspace" {
            continue;
        }
        if k == "features" {
            let mut features: Vec<Value> = merged
                .get(k)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for f in v.as_array().into_iter().flatten() {
                if !features.contains(f) {
                    features.push(f.clone());
                }
            }
            merged.insert(k.clone(), Value::Array(features));
        } else if matches!(k.as_str(), "optional" | "default-features" | "package") {
            merged.insert(k.clone(), v.clone());
        }
    }
    Value::Table(merged)
}

fn parse_dependency(
    dir: &str,
    alias: String,
    kind: CargoDependencyKind,
    target: Option<String>,
    raw: &Value,
) -> CargoDependency {
    let table = raw.as_table();
    let package = match table {
        Some(t) => match t.get("package") {
            Some(Value::String(name)) if !name.is_empty() => Some(name.clone()),
            Some(_) => None,
            None => Some(alias.clone()),
        },
        None => raw.as_str().map(|_| alias.clone()),
    };
    let requirement = raw.as_str().map(str::to_string).or_else(|| {
        table
            .and_then(|t| t.get("version"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let source = match table {
        None if raw.as_str().is_some_and(|r| VersionReq::parse(r).is_ok()) => {
            CargoDependencySource::DefaultRegistry
        }
        None => CargoDependencySource::Unknown {
            detail: raw.as_str().map(str::to_string),
        },
        Some(t) => {
            let path = t.get("path");
            let git = t.get("git");
            let registry = t.get("registry");
            let selectors = usize::from(path.is_some())
                + usize::from(git.is_some())
                + usize::from(registry.is_some());
            let known = [
                "version",
                "package",
                "optional",
                "default-features",
                "features",
                "workspace",
                "public",
                "artifact",
                "lib",
                "rename",
                "target",
                "path",
                "git",
                "registry",
                "rev",
                "branch",
                "tag",
            ];
            let invalid = t.keys().any(|k| !known.contains(&k.as_str()))
                || t.get("version")
                    .is_some_and(|v| v.as_str().is_none_or(|r| VersionReq::parse(r).is_err()))
                || t.get("package")
                    .is_some_and(|v| v.as_str().is_none_or(str::is_empty))
                || t.get("features")
                    .is_some_and(|v| !v.as_array().is_some_and(|a| a.iter().all(Value::is_str)))
                || ["optional", "default-features"]
                    .iter()
                    .any(|k| t.get(*k).is_some_and(|v| !v.is_bool()))
                || ["path", "git", "registry", "rev", "branch", "tag"]
                    .iter()
                    .any(|k| {
                        t.get(*k)
                            .is_some_and(|v| v.as_str().is_none_or(str::is_empty))
                    })
                || (t.get("version").is_none()
                    && t.get("workspace").and_then(Value::as_bool) != Some(true)
                    && path.is_none()
                    && git.is_none())
                || (registry.is_some() && t.get("version").is_none())
                || (git.is_none() && ["rev", "branch", "tag"].iter().any(|k| t.contains_key(*k)));
            if selectors > 1 || invalid {
                CargoDependencySource::Unknown {
                    detail: Some(format!("{t:?}")),
                }
            } else if let Some(v) = path {
                CargoDependencySource::Path {
                    path: v.as_str().unwrap_or_default().to_string(),
                }
            } else if let Some(v) = git {
                CargoDependencySource::Git {
                    url: v.as_str().unwrap_or_default().to_string(),
                    rev: t.get("rev").and_then(Value::as_str).map(str::to_string),
                    branch: t.get("branch").and_then(Value::as_str).map(str::to_string),
                    tag: t.get("tag").and_then(Value::as_str).map(str::to_string),
                }
            } else if let Some(v) = registry {
                CargoDependencySource::NamedRegistry {
                    name: v.as_str().unwrap_or_default().to_string(),
                }
            } else if t.keys().any(|k| !known.contains(&k.as_str())) {
                CargoDependencySource::Unknown {
                    detail: Some(format!("{t:?}")),
                }
            } else {
                CargoDependencySource::DefaultRegistry
            }
        }
    };
    CargoDependency {
        manifest_dir: dir.to_string(),
        alias,
        package,
        kind,
        target,
        requirement,
        source,
        optional: table
            .and_then(|t| t.get("optional"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        features: table
            .and_then(|t| t.get("features"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        default_features: table
            .and_then(|t| t.get("default-features"))
            .and_then(Value::as_bool),
        resolved: None,
        privacy_declaration: Some(raw.clone()),
    }
}

fn parse_lock_reference(value: &Value) -> Option<CargoLockDependency> {
    if let Some(t) = value.as_table() {
        let name = t.get("name")?.as_str()?.to_string();
        let version = t
            .get("version")
            .and_then(Value::as_str)
            .and_then(|s| Version::parse(s).ok());
        let source = t.get("source").and_then(Value::as_str).map(str::to_string);
        return Some(CargoLockDependency {
            name,
            version,
            source,
        });
    }
    let s = value.as_str()?;
    let (base, source) = if s.ends_with(')') {
        match s.rfind(" (") {
            Some(i) => (&s[..i], Some(s[i + 2..s.len() - 1].to_string())),
            None => (s, None),
        }
    } else {
        (s, None)
    };
    let mut parts = base.split_whitespace();
    let name = parts.next()?.to_string();
    let version = parts.next().and_then(|v| Version::parse(v).ok());
    if parts.next().is_some() {
        return None;
    }
    Some(CargoLockDependency {
        name,
        version,
        source,
    })
}
fn read_lock(
    path: &Path,
    file: &str,
    notes: &mut Vec<String>,
    unreadable: &mut usize,
) -> Option<CargoLock> {
    let parsed = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| toml::from_str::<Value>(&s).ok());
    let Some(doc) = parsed else {
        note(
            notes,
            format!(
                "{file}: Cargo lockfile could not be read; no resolved package versions are available from it."
            ),
        );
        *unreadable += 1;
        return None;
    };
    let format_version = doc
        .get("version")
        .and_then(Value::as_integer)
        .and_then(|n| u64::try_from(n).ok());
    let mut packages = vec![];
    let mut bad = false;
    for p in doc
        .get("package")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(name) = p
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            bad = true;
            continue;
        };
        let Some(version) = p
            .get("version")
            .and_then(Value::as_str)
            .and_then(|s| Version::parse(s).ok())
        else {
            bad = true;
            continue;
        };
        let dependencies: Vec<CargoLockDependency> = p
            .get("dependencies")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|d| match parse_lock_reference(d) {
                Some(r) => Some(r),
                None => {
                    bad = true;
                    None
                }
            })
            .collect();
        if p.get("source").is_some_and(|s| !s.is_str()) {
            bad = true;
            continue;
        }
        packages.push(CargoLockPackage {
            id: CargoPackageId {
                name: name.to_string(),
                version,
                source: p.get("source").and_then(Value::as_str).map(str::to_string),
            },
            checksum: p
                .get("checksum")
                .and_then(Value::as_str)
                .map(str::to_string),
            dependencies,
        });
    }
    if bad {
        note(
            notes,
            format!("{file}: some Cargo lockfile records were unusable and were omitted."),
        );
    }
    let lock = CargoLock {
        file: file.to_string(),
        format_version,
        packages,
    };
    if lock.format_version.is_some_and(|v| !matches!(v, 1..=4)) {
        note(
            notes,
            format!(
                "{}: unsupported Cargo lockfile format; records were read defensively.",
                lock.file
            ),
        );
    }
    Some(lock)
}

fn resolve_declarations(inv: &mut CargoInventory) {
    for dep in &mut inv.declarations {
        let Some(manifest) = inv.manifests.get(&dep.manifest_dir) else {
            continue;
        };
        let Some(lock_file) = manifest.lockfile.as_ref() else {
            continue;
        };
        let Some(lock) = inv.lockfiles.get(lock_file) else {
            continue;
        };
        let Some(name) = dep.package.as_deref() else {
            continue;
        };
        let Some(member) = manifest.package.as_ref() else {
            continue;
        };
        let mut roots: Vec<&CargoLockPackage> = lock
            .packages
            .iter()
            .filter(|p| {
                p.id.name == member.name
                    && p.id.source.is_none()
                    && member.version.as_ref().is_none_or(|v| &p.id.version == v)
            })
            .collect();
        if member.version.is_none() && roots.len() > 1 {
            continue;
        }
        if roots.len() > 1 {
            continue;
        }
        let Some(root_record) = roots.pop() else {
            continue;
        };
        let mut edge_candidates: Vec<&CargoLockPackage> = vec![];
        for edge in root_record.dependencies.iter().filter(|e| e.name == name) {
            let recs = lock
                .packages
                .iter()
                .filter(|p| {
                    p.id.name == name
                        && edge.version.as_ref().is_none_or(|v| p.id.version == *v)
                        && edge
                            .source
                            .as_ref()
                            .is_none_or(|s| p.id.source.as_ref() == Some(s))
                })
                .collect::<Vec<_>>();
            edge_candidates.extend(recs);
        }
        edge_candidates
            .sort_by(|a, b| (&a.id.version, &a.id.source).cmp(&(&b.id.version, &b.id.source)));
        edge_candidates.dedup_by(|a, b| {
            a.id.name == b.id.name && a.id.version == b.id.version && a.id.source == b.id.source
        });
        let selected = match edge_candidates.as_slice() {
            [candidate] => Some(*candidate),
            _ => None,
        };
        if let Some(candidate) = selected {
            dep.resolved = Some(candidate.id.clone());
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, path: &str, text: &str) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    fn detect_at(root: &Path) -> (CargoInventory, Vec<String>, usize) {
        let mut notes = vec![];
        let mut unreadable = 0;
        let inv = detect(root, &mut notes, &mut unreadable);
        (inv, notes, unreadable)
    }
    const CRATES: &str = "registry+https://github.com/rust-lang/crates.io-index";

    #[test]
    fn virtual_workspace_globs_exclusions_and_workspace_lock_edges() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(
            root,
            "Cargo.toml",
            "[workspace]\nmembers = [\"crates/*\"]\nexclude = [\"crates/skip\"]\n[workspace.dependencies]\nserde_alias = { package = \"serde\", version = \"^1\", features = [\"derive\"] }\n[workspace.package]\nversion = \"1.2.0\"\n",
        );
        write(
            root,
            "crates/app/Cargo.toml",
            "[package]\nname = \"app\"\nversion.workspace = true\n[dependencies]\nserde_alias = { workspace = true, features = [\"rc\"], optional = true }\n[dev-dependencies]\npretty = \"^0.1\"\n[target.'cfg(unix)'.build-dependencies]\ncc = { version = \"1\", default-features = false }\n",
        );
        write(
            root,
            "crates/skip/Cargo.toml",
            "[package]\nname=\"skip\"\nversion=\"0.1.0\"\n",
        );
        write(root, "crates/app/src/lib.rs", "");
        write(
            root,
            "Cargo.lock",
            &format!(
                "version = 4\n[[package]]\nname=\"app\"\nversion=\"1.2.0\"\ndependencies=[\"serde 1.0.200 ({CRATES})\"]\n[[package]]\nname=\"serde\"\nversion=\"1.0.200\"\nsource=\"{CRATES}\"\nchecksum=\"abc\"\n"
            ),
        );
        write(
            root,
            "crates/skip/Cargo.lock",
            "[[package]]\nname=\"skip\"\nversion=\"0.1.0\"\n",
        );
        let (inv, notes, unreadable) = detect_at(root);
        assert_eq!(unreadable, 0, "{notes:?}");
        assert!(inv.manifests["."].package.is_none(), "the root is virtual");
        let ws = inv.workspaces.iter().find(|w| w.root == ".").unwrap();
        assert_eq!(ws.members, BTreeSet::from(["crates/app".to_string()]));
        assert_eq!(ws.excluded, BTreeSet::from(["crates/skip".to_string()]));
        assert_eq!(
            inv.manifests["crates/app"].lockfile.as_deref(),
            Some("Cargo.lock")
        );
        assert_eq!(
            inv.manifests["crates/app"]
                .package
                .as_ref()
                .unwrap()
                .version
                .as_ref()
                .unwrap()
                .to_string(),
            "1.2.0"
        );
        assert_eq!(
            inv.manifests["crates/app"].package.as_ref().unwrap().kind,
            Kind::Library
        );
        assert_eq!(
            inv.manifests["crates/skip"].lockfile.as_deref(),
            Some("crates/skip/Cargo.lock")
        );
        let serde = inv
            .declarations
            .iter()
            .find(|d| d.alias == "serde_alias")
            .unwrap();
        assert_eq!(serde.package.as_deref(), Some("serde"));
        assert_eq!(serde.features, ["derive", "rc"]);
        assert!(serde.optional);
        assert_eq!(
            serde.resolved.as_ref().unwrap().version.to_string(),
            "1.0.200"
        );
        assert!(
            inv.declarations
                .iter()
                .any(|d| d.kind == CargoDependencyKind::Development && d.alias == "pretty")
        );
        let cc = inv.declarations.iter().find(|d| d.alias == "cc").unwrap();
        assert_eq!(cc.kind, CargoDependencyKind::Build);
        assert_eq!(cc.target.as_deref(), Some("cfg(unix)"));
        assert_eq!(cc.default_features, Some(false));
    }

    #[test]
    fn package_workspace_path_associates_non_ancestor_package_and_inherits_workspace_data() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(
            root,
            "shared/Cargo.toml",
            "[workspace]\nmembers=[\"../detached/app\"]\n[workspace.dependencies]\nserde={version=\"^1\", package=\"serde\"}\n",
        );
        write(
            root,
            "detached/app/Cargo.toml",
            "[package]\nname=\"app\"\nversion=\"1.0.0\"\nworkspace=\"../../shared\"\n[dependencies]\nserde={workspace=true}\n",
        );
        write(
            root,
            "detached/not-member/Cargo.toml",
            "[package]\nname=\"not-member\"\nversion=\"1.0.0\"\nworkspace=\"../../shared\"\n",
        );
        write(
            root,
            "shared/Cargo.lock",
            &format!(
                "version=4\n[[package]]\nname=\"app\"\nversion=\"1.0.0\"\ndependencies=[\"serde 1.2.0 ({CRATES})\"]\n[[package]]\nname=\"serde\"\nversion=\"1.2.0\"\nsource=\"{CRATES}\"\n"
            ),
        );
        let (inventory, notes, unreadable) = detect_at(root);
        assert_eq!(unreadable, 0, "{notes:?}");
        let app = &inventory.manifests["detached/app"];
        assert_eq!(app.lockfile.as_deref(), Some("shared/Cargo.lock"));
        assert!(
            inventory
                .workspaces
                .iter()
                .find(|w| w.root == "shared")
                .unwrap()
                .members
                .contains("detached/app")
        );
        assert_eq!(
            inventory.declarations[0]
                .resolved
                .as_ref()
                .unwrap()
                .version
                .to_string(),
            "1.2.0"
        );
        assert_eq!(inventory.manifests["detached/not-member"].lockfile, None);
    }

    #[test]
    fn a_manifest_requirement_does_not_resolve_without_a_matching_lock_edge() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "Cargo.toml",
            "[package]\nname=\"app\"\nversion=\"1.0.0\"\n[dependencies]\nserde=\"^1\"\n",
        );
        write(
            root.path(),
            "Cargo.lock",
            &format!(
                "[[package]]\nname=\"app\"\nversion=\"1.0.0\"\ndependencies=[]\n[[package]]\nname=\"serde\"\nversion=\"1.2.3\"\nsource=\"{CRATES}\"\n"
            ),
        );
        let (inventory, _, _) = detect_at(root.path());
        assert!(
            inventory.declarations[0].resolved.is_none(),
            "a satisfying lockfile package without a root dependency edge is not a resolution"
        );
    }

    #[test]
    fn package_workspace_path_membership_nested_workspaces_and_nonmembers_do_not_borrow_locks() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(
            root,
            "Cargo.toml",
            "[package]\nname=\"root-app\"\nversion=\"1.0.0\"\n[workspace]\nmembers=[\"members/ordinary\"]\nexclude=[\"members/excluded\"]\n[workspace.dependencies]\nlocal={path=\"members/path-only\"}\n",
        );
        write(
            root,
            "members/ordinary/Cargo.toml",
            "[package]\nname=\"ordinary\"\nversion=\"1.0.0\"\n[dependencies]\nlocal={workspace=true}\n",
        );
        write(
            root,
            "members/path-only/Cargo.toml",
            "[package]\nname=\"path-only\"\nversion=\"0.1.0\"\n",
        );
        write(
            root,
            "members/excluded/Cargo.toml",
            "[package]\nname=\"excluded\"\nversion=\"0.1.0\"\n",
        );
        write(
            root,
            "members/excluded/Cargo.lock",
            "[[package]]\nname=\"excluded\"\nversion=\"0.1.0\"\n",
        );
        write(
            root,
            "members/omitted/Cargo.toml",
            "[package]\nname=\"omitted\"\nversion=\"0.1.0\"\n",
        );
        write(
            root,
            "members/omitted/Cargo.lock",
            "[[package]]\nname=\"omitted\"\nversion=\"0.1.0\"\n",
        );
        write(
            root,
            "nested/Cargo.toml",
            "[workspace]\nmembers=[\"app\"]\n",
        );
        write(
            root,
            "nested/app/Cargo.toml",
            "[package]\nname=\"nested-app\"\nversion=\"1.0.0\"\n",
        );
        write(
            root,
            "nested/Cargo.lock",
            "[[package]]\nname=\"nested-app\"\nversion=\"1.0.0\"\n",
        );
        write(
            root,
            "independent/Cargo.toml",
            "[workspace]\nmembers=[\"app\"]\n",
        );
        write(
            root,
            "independent/app/Cargo.toml",
            "[package]\nname=\"independent-app\"\nversion=\"1.0.0\"\n",
        );
        write(
            root,
            "Cargo.lock",
            "[[package]]\nname=\"root-app\"\nversion=\"1.0.0\"\n",
        );
        let (inv, _, _) = detect_at(root);
        assert!(
            inv.manifests["."].package.is_some(),
            "the workspace root is a package"
        );
        let ws = inv.workspaces.iter().find(|w| w.root == ".").unwrap();
        assert!(ws.members.contains("."));
        assert!(ws.members.contains("members/ordinary"));
        assert!(ws.members.contains("members/path-only"));
        assert!(!ws.members.contains("members/excluded"));
        assert_eq!(
            inv.manifests["members/ordinary"].lockfile.as_deref(),
            Some("Cargo.lock")
        );
        assert_eq!(
            inv.manifests["members/omitted"].lockfile, None,
            "nonmember is not standalone or a lockfile member"
        );
        assert_eq!(
            inv.manifests["members/excluded"].lockfile.as_deref(),
            Some("members/excluded/Cargo.lock"),
            "an excluded package may use only its own standalone lockfile"
        );
        assert!(
            inv.workspaces
                .iter()
                .find(|w| w.root == "nested")
                .unwrap()
                .members
                .contains("nested/app"),
            "nested workspace members: {:?}",
            inv.workspaces
        );
        assert_eq!(
            inv.workspaces
                .iter()
                .find(|w| w.root == "nested")
                .unwrap()
                .lockfile
                .as_deref(),
            Some("nested/Cargo.lock")
        );
        assert_eq!(
            inv.manifests["nested/app"].lockfile.as_deref(),
            Some("nested/Cargo.lock")
        );
        assert_eq!(
            inv.manifests["nested"].lockfile.as_deref(),
            Some("nested/Cargo.lock")
        );
        assert_eq!(
            inv.manifests["independent/app"].lockfile, None,
            "workspace member without a root lock stays unlocked"
        );
    }

    #[test]
    fn source_identity_debug_is_redacted_and_lock_records_keep_distinct_sources() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(
            root,
            "Cargo.toml",
            "[package]\nname=\"app\"\nversion=\"1.0.0\"\n[dependencies]\ngitpkg={git=\"https://secret.example/repo\", rev=\"deadbeef\"}\npathpkg={path=\"../secret/path\"}\nreg={version=\"1\", registry=\"corp\"}\n",
        );
        write(
            root,
            "Cargo.lock",
            "[[package]]\nname=\"app\"\nversion=\"1.0.0\"\ndependencies=[\"same 1.0.0 (registry+https://secret.example/index)\"]\n[[package]]\nname=\"same\"\nversion=\"1.0.0\"\nsource=\"registry+https://secret.example/index\"\n[[package]]\nname=\"same\"\nversion=\"1.0.0\"\nsource=\"registry+https://github.com/rust-lang/crates.io-index\"\n",
        );
        let (inv, _, _) = detect_at(root);
        let lock = &inv.lockfiles["Cargo.lock"];
        assert_eq!(
            lock.packages.iter().filter(|p| p.id.name == "same").count(),
            2
        );
        let debug = format!("{inv:?}");
        for secret in ["secret.example", "deadbeef", "secret/path"] {
            assert!(!debug.contains(secret), "debug leaked {secret}: {debug}");
        }
        assert!(matches!(
            inv.declarations
                .iter()
                .find(|d| d.alias == "gitpkg")
                .unwrap()
                .source
                .clone(),
            CargoDependencySource::Git { .. }
        ));
        assert!(matches!(
            inv.declarations
                .iter()
                .find(|d| d.alias == "pathpkg")
                .unwrap()
                .source
                .clone(),
            CargoDependencySource::Path { .. }
        ));
        assert!(matches!(
            inv.declarations
                .iter()
                .find(|d| d.alias == "reg")
                .unwrap()
                .source
                .clone(),
            CargoDependencySource::NamedRegistry { .. }
        ));
    }

    #[test]
    fn malformed_files_are_bounded_and_do_not_echo_contents() {
        let temp = tempfile::tempdir().unwrap();
        write(
            temp.path(),
            "Cargo.toml",
            "PRIVATE-URL = \"https://secret.invalid/path\"\ninvalid = [\n",
        );
        let (inv, notes, unreadable) = detect_at(temp.path());
        assert!(inv.manifests.is_empty());
        assert_eq!(unreadable, 1);
        let output = format!("{notes:?} {inv:?}");
        assert!(!output.contains("secret.invalid") && !output.contains("PRIVATE-URL"));
    }
}
