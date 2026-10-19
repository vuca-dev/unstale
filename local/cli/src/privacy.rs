//! Which dependency names may be named to a third party (the npm and PyPI registries, OSV, the catalog host when it
//! publishes no list of technologies). The client runs in private repositories: a package installed from a private
//! registry has a name that is itself private, and asking a public service about it would tell that service (and its
//! logs) the name, the version and the developer's address.
//!
//! The rule, per package: it is private, and never named, when either holds:
//! - a lockfile says it came from anywhere but the public registry (another registry's URL, git, a tarball, a path);
//! - a registry configuration that applies to it points anywhere but the public registry: for npm its scope's registry
//!   (or credentials for its scope), and the default registry; for PyPI an index it is pinned to, and any index
//!   searched besides PyPI.
//!
//! A lockfile URL on the public registry does not outweigh a configuration: npm fetches `registry.npmjs.org` URLs
//! through the configured registry (`replace-registry-host`), and teams rewrite lockfile URLs to the public host to keep
//! them portable, so a private package can sit in a lockfile under a public URL. The rule fails closed: a whole-registry
//! proxy (Artifactory, Nexus, CodeArtifact, Verdaccio) can serve private packages under any name, scoped or not, so with
//! one as the default registry (in the repository, `~/.npmrc` or the environment) every package of that ecosystem is
//! kept private. Such a setup gets no registry, advisory or coverage requests from the client; the alternative would
//! send private names. A scoped private registry, the common setup, costs only that scope's packages.
//!
//! Configuration read, all of it (any source that applies makes a package private; a nested `.npmrc` is counted for
//! the whole repository rather than its own directory only):
//! - npm: `.npmrc` (the repository, its directories and their ancestors, `~/.npmrc`, `NPM_CONFIG_USERCONFIG` and
//!   `NPM_CONFIG_GLOBALCONFIG`), `NPM_CONFIG_REGISTRY` and `NPM_CONFIG_@scope:registry` (any case), `.yarnrc.yml`
//!   (`npmRegistryServer`, `npmScopes`), `.yarnrc`, `YARN_NPM_REGISTRY_SERVER`, `bunfig.toml` and `BUN_CONFIG_REGISTRY`.
//!   A scope Yarn or Bun configures with credentials is private even on the public registry (paid private packages).
//! - PyPI: `pip.conf` (user, site, `PIP_CONFIG_FILE`, the virtualenv's), `PIP_INDEX_URL`, `PIP_EXTRA_INDEX_URL`,
//!   `PIP_FIND_LINKS`, requirements files' `--index-url`, `--extra-index-url` and `--find-links`, uv (`[tool.uv]`,
//!   `uv.toml`, `~/.config/uv/uv.toml`, `UV_INDEX`, `UV_INDEX_URL`, `UV_DEFAULT_INDEX`, `UV_EXTRA_INDEX_URL`,
//!   `UV_FIND_LINKS`; an `explicit` index serves only the packages pinned to it), Poetry sources, PDM sources and
//!   Pipfile sources.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use toml::Value;

/// `UNSTALE_NO_REGISTRY=1`: no third-party lookup at all, public names included. No npm or PyPI identity, deprecation
/// or download read and no OSV query; with no identity verified, no package is submitted for coverage either.
pub fn registry_off() -> bool {
    std::env::var("UNSTALE_NO_REGISTRY").is_ok_and(|v| v == "1")
}

/// Where a lockfile says a package came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Seen {
    /// No lockfile says (pnpm and Yarn 2+ name no URL for the default registry, or nothing locks it).
    #[default]
    Unknown,
    /// The public registry.
    Public,
    /// Another registry, git, a tarball or a path.
    Elsewhere,
}

impl Seen {
    /// Both readings of one package: anywhere else wins over the public registry, which wins over nothing said.
    pub fn and(self, other: Seen) -> Seen {
        match (self, other) {
            (Seen::Elsewhere, _) | (_, Seen::Elsewhere) => Seen::Elsewhere,
            (Seen::Public, _) | (_, Seen::Public) => Seen::Public,
            _ => Seen::Unknown,
        }
    }
    /// An npm lockfile's `resolved` or `tarball` URL.
    pub fn npm_url(url: &str) -> Seen {
        if public_npm(url) { Seen::Public } else { Seen::Elsewhere }
    }
    /// A Python lockfile's index or file URL.
    pub fn pypi_url(url: &str) -> Seen {
        if public_pypi(url) { Seen::Public } else { Seen::Elsewhere }
    }
}

/// The host of a URL, lowercase, without credentials or port; None for anything that is not `http(s)://`.
fn host(url: &str) -> Option<String> {
    let url = url.trim().trim_matches(['"', '\'']);
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    let h = authority.split(':').next()?.trim_end_matches('.').to_ascii_lowercase();
    (!h.is_empty()).then_some(h)
}

/// The public npm registry (and Yarn's mirror of it).
pub fn public_npm(url: &str) -> bool {
    host(url).is_some_and(|h| h == "registry.npmjs.org" || h == "registry.yarnpkg.com")
}

/// PyPI: its index and the host of its files.
pub fn public_pypi(url: &str) -> bool {
    host(url).is_some_and(|h| h == "pypi.org" || h == "pypi.python.org" || h == "files.pythonhosted.org")
}

/// The environment the package managers read: the home directory and the variables. Passed in, so tests set their own.
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub home: Option<PathBuf>,
    pub vars: BTreeMap<String, String>,
}

impl Env {
    pub fn process() -> Env {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).filter(|h| !h.is_empty()).map(PathBuf::from);
        Env { home, vars: std::env::vars().collect() }
    }
    fn var(&self, k: &str) -> Option<&str> {
        self.vars.get(k).map(String::as_str).filter(|v| !v.trim().is_empty())
    }
    /// `${NAME}` references expanded (npm and Yarn allow them in values); None when one is not set.
    fn expand(&self, v: &str) -> Option<String> {
        let mut out = String::new();
        let mut rest = v;
        while let Some(at) = rest.find("${") {
            out.push_str(&rest[..at]);
            let end = rest[at..].find('}')? + at;
            let name = rest[at + 2..end].split([':', '-']).next().unwrap_or("");
            out.push_str(self.var(name)?);
            rest = &rest[end + 1..];
        }
        out.push_str(rest);
        Some(out)
    }
    /// Files in the user's configuration: the home directory's, and the XDG and macOS configuration directories'.
    fn user_files(&self) -> Vec<PathBuf> {
        let mut out = vec![];
        if let Some(h) = &self.home {
            for f in [".npmrc", ".yarnrc.yml", ".yarnrc", ".bunfig.toml", ".pip/pip.conf", "Library/Application Support/pip/pip.conf"] {
                out.push(h.join(f));
            }
        }
        let xdg = self.var("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| self.home.as_ref().map(|h| h.join(".config")));
        if let Some(x) = xdg {
            for f in ["pip/pip.conf", "uv/uv.toml", ".bunfig.toml"] {
                out.push(x.join(f));
            }
        }
        if let Some(v) = self.var("VIRTUAL_ENV") {
            out.push(Path::new(v).join("pip.conf"));
        }
        for k in ["NPM_CONFIG_USERCONFIG", "npm_config_userconfig", "NPM_CONFIG_GLOBALCONFIG", "npm_config_globalconfig", "PIP_CONFIG_FILE", "UV_CONFIG_FILE"] {
            if let Some(v) = self.var(k) {
                out.push(PathBuf::from(v));
            }
        }
        for f in ["/etc/pip.conf", "/etc/xdg/pip/pip.conf", "/etc/uv/uv.toml"] {
            out.push(PathBuf::from(f));
        }
        out
    }
}

/// The configuration files read in a project directory (`is_config` for the names the repository walk collects).
const DIR_FILES: &[&str] = &[".npmrc", ".yarnrc.yml", ".yarnrc", "bunfig.toml", "uv.toml", "pip.conf", "pyproject.toml", "Pipfile"];

/// A file whose registry or index settings count (`Registries::read`).
pub fn is_config(name: &str) -> bool {
    DIR_FILES.contains(&name) || ((name.starts_with("requirements") || name.starts_with("constraints")) && name.ends_with(".txt"))
}

/// The registry and index configuration that applies to this repository: what points anywhere but the public
/// registries.
#[derive(Debug, Clone, Default)]
pub struct Registries {
    /// npm: a default registry other than the public one is configured somewhere.
    npm_default: bool,
    /// npm scopes (`@acme`, lowercase) configured for another registry, or with credentials.
    npm_scopes: BTreeSet<String>,
    /// PyPI: an index or file location other than PyPI is searched for every package.
    pypi_any: bool,
    /// PyPI names (normalised) pinned to another index or source.
    pypi_pinned: BTreeSet<String>,
}

impl Registries {
    /// The configuration in the repository's `files` (those the walk found), in `root`, its ancestors and every
    /// directory in `dirs` (a gitignored `.npmrc` beside a manifest is still the package manager's), in the user's
    /// configuration and in the environment.
    pub fn read(root: &Path, dirs: &BTreeSet<PathBuf>, files: &[PathBuf], env: &Env) -> Registries {
        let mut r = Registries::default();
        let mut all: BTreeSet<PathBuf> = files.iter().cloned().collect();
        for d in root.ancestors().chain(dirs.iter().map(PathBuf::as_path)) {
            for f in DIR_FILES {
                all.insert(d.join(f));
            }
        }
        // Requirements files beside the root and the manifests, gitignored or not.
        for d in std::iter::once(root).chain(dirs.iter().map(PathBuf::as_path)) {
            for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
                if is_config(&e.file_name().to_string_lossy()) {
                    all.insert(e.path());
                }
            }
        }
        all.extend(env.user_files());
        for p in all {
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            match name.as_str() {
                ".npmrc" | "npmrc" => r.npmrc(&text, env),
                ".yarnrc.yml" => r.yarnrc_yml(&text, env),
                ".yarnrc" => r.yarnrc(&text),
                "bunfig.toml" | ".bunfig.toml" => r.bunfig(&text),
                "pip.conf" | "pip.ini" => r.pip_conf(&text),
                "uv.toml" => {
                    if let Ok(t) = toml::from_str::<Value>(&text) {
                        r.uv(&t);
                    }
                }
                "pyproject.toml" => r.pyproject(&text),
                "Pipfile" => r.pipfile(&text),
                n if is_config(n) => r.requirements(&text),
                // A configuration file named by the environment (NPM_CONFIG_USERCONFIG, PIP_CONFIG_FILE): by content.
                _ if text.lines().any(|l| l.trim_start().starts_with('[')) => r.pip_conf(&text),
                _ => r.npmrc(&text, env),
            }
        }
        r.env(env);
        r
    }

    fn npm_registry(&mut self, scope: Option<&str>, url: Option<&str>) {
        if url.is_some_and(public_npm) {
            return;
        }
        match scope {
            Some(s) => {
                let s = s.trim().trim_matches(['"', '\'']).to_ascii_lowercase();
                self.npm_scopes.insert(if s.starts_with('@') { s } else { format!("@{s}") });
            }
            None => self.npm_default = true,
        }
    }

    /// `.npmrc`: `registry=` and `@scope:registry=` (an unset `${VAR}` in the value is not the public registry).
    fn npmrc(&mut self, text: &str, env: &Env) {
        for line in text.lines() {
            let l = line.trim();
            if l.starts_with(['#', ';']) {
                continue;
            }
            let Some((k, v)) = l.split_once('=') else { continue };
            let (k, v) = (k.trim(), env.expand(v.trim().trim_matches(['"', '\''])));
            if k == "registry" {
                self.npm_registry(None, v.as_deref());
            } else if let Some(scope) = k.strip_suffix(":registry").filter(|s| s.starts_with('@')) {
                self.npm_registry(Some(scope), v.as_deref());
            }
        }
    }

    /// `.yarnrc.yml` (Yarn 2+): `npmRegistryServer`, and every `npmScopes` entry, private unless all it sets is the
    /// public registry.
    fn yarnrc_yml(&mut self, text: &str, env: &Env) {
        let mut stack: Vec<(usize, String)> = vec![];
        let mut scopes: BTreeMap<String, (Option<String>, bool)> = BTreeMap::new();
        for raw in text.lines() {
            let t = raw.trim_end();
            if t.trim().is_empty() || t.trim_start().starts_with('#') {
                continue;
            }
            let indent = t.len() - t.trim_start().len();
            let Some((k, val)) = crate::stack::split_key(t.trim_start()) else { continue };
            while stack.last().is_some_and(|(i, _)| *i >= indent) {
                stack.pop();
            }
            let path: Vec<&str> = stack.iter().map(|(_, k)| k.as_str()).collect();
            let v = val.map(|v| v.trim().trim_matches(['"', '\'']));
            match path.as_slice() {
                [] if k == "npmRegistryServer" => self.npm_registry(None, v.and_then(|v| env.expand(v)).as_deref()),
                ["npmScopes"] => {
                    scopes.entry(k.clone()).or_default();
                }
                ["npmScopes", scope] => {
                    let e = scopes.entry(scope.to_string()).or_default();
                    if k == "npmRegistryServer" {
                        e.0 = v.and_then(|v| env.expand(v));
                    } else if k != "npmPublishRegistry" {
                        e.1 = true;
                    }
                }
                _ => {}
            }
            if val.is_none() {
                stack.push((indent, k));
            }
        }
        for (scope, (server, other)) in scopes {
            if other || server.as_deref().is_none_or(|s| !public_npm(s)) {
                self.npm_registry(Some(&scope), None);
            }
        }
    }

    /// `.yarnrc` (Yarn 1): `registry "url"` and `"@scope:registry" "url"`.
    fn yarnrc(&mut self, text: &str) {
        for line in text.lines() {
            let l = line.trim();
            let Some((k, v)) = l.split_once(char::is_whitespace) else { continue };
            let (k, v) = (k.trim_matches(['"', '\'']), v.trim().trim_matches(['"', '\'']));
            if k == "registry" {
                self.npm_registry(None, Some(v));
            } else if let Some(scope) = k.strip_suffix(":registry").filter(|s| s.starts_with('@')) {
                self.npm_registry(Some(scope), Some(v));
            }
        }
    }

    /// `bunfig.toml`: `[install] registry` and `[install.scopes]`, a string or `{ url, token, ... }`.
    fn bunfig(&mut self, text: &str) {
        let Ok(doc) = toml::from_str::<Value>(text) else { return };
        let Some(install) = doc.get("install") else { return };
        let url = |v: &Value| v.as_str().map(String::from).or_else(|| v.get("url").and_then(Value::as_str).map(String::from));
        if let Some(reg) = install.get("registry") {
            self.npm_registry(None, url(reg).as_deref());
        }
        for (scope, v) in install.get("scopes").and_then(Value::as_table).into_iter().flatten() {
            let credentials = v.as_table().is_some_and(|t| t.keys().any(|k| k != "url"));
            self.npm_registry(Some(scope), url(v).as_deref().filter(|_| !credentials));
        }
    }

    fn pypi_index(&mut self, url: &str) {
        let url = url.trim().trim_matches(['"', '\'']);
        // uv's `UV_INDEX` takes `name=url`.
        let url = url.split_once('=').filter(|(n, _)| !n.contains('/')).map_or(url, |(_, u)| u);
        if !url.is_empty() && !public_pypi(url) {
            self.pypi_any = true;
        }
    }

    /// `pip.conf`: `index-url`, `extra-index-url` and `find-links` in any section, values continued on indented lines.
    fn pip_conf(&mut self, text: &str) {
        let mut cur: Option<bool> = None;
        for line in text.lines() {
            let l = line.trim();
            if l.is_empty() || l.starts_with(['#', ';']) {
                continue;
            }
            if line.starts_with(char::is_whitespace) && cur == Some(true) {
                l.split_whitespace().for_each(|u| self.pypi_index(u));
                continue;
            }
            cur = None;
            let Some((k, v)) = l.split_once('=').or_else(|| l.split_once(':')) else { continue };
            let k = k.trim().replace('_', "-");
            if matches!(k.as_str(), "index-url" | "extra-index-url" | "find-links") {
                cur = Some(true);
                v.split_whitespace().for_each(|u| self.pypi_index(u));
            }
        }
    }

    /// Requirements files: `-i`, `--index-url`, `--extra-index-url`, `-f`, `--find-links`.
    fn requirements(&mut self, text: &str) {
        for line in text.lines() {
            let mut words = line.split('#').next().unwrap_or("").split_whitespace();
            while let Some(w) = words.next() {
                let (opt, inline) = match w.split_once('=') {
                    Some((o, v)) => (o, Some(v)),
                    None => (w, None),
                };
                if matches!(opt, "-i" | "--index-url" | "--extra-index-url" | "-f" | "--find-links")
                    && let Some(v) = inline.map(String::from).or_else(|| words.next().map(String::from))
                {
                    self.pypi_index(&v);
                }
            }
        }
    }

    /// uv's settings (`[tool.uv]` or `uv.toml`): indexes, the legacy index options, and `sources` pins.
    fn uv(&mut self, t: &Value) {
        let (mut public_named, mut private_named): (BTreeSet<String>, BTreeSet<String>) = Default::default();
        for i in t.get("index").and_then(Value::as_array).into_iter().flatten() {
            let url = i.get("url").and_then(Value::as_str).unwrap_or("");
            if public_pypi(url) {
                public_named.extend(i.get("name").and_then(Value::as_str).map(String::from));
                continue;
            }
            if let Some(n) = i.get("name").and_then(Value::as_str) {
                private_named.insert(n.to_string());
            }
            // An explicit index serves only the packages pinned to it.
            if i.get("explicit").and_then(Value::as_bool) != Some(true) {
                self.pypi_index(if url.is_empty() { "unnamed" } else { url });
            }
        }
        for k in ["index-url", "extra-index-url", "find-links"] {
            match t.get(k) {
                Some(Value::String(s)) => self.pypi_index(s),
                Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).for_each(|s| self.pypi_index(s)),
                _ => {}
            }
        }
        // `name = { index = "x" }`, `{ git = ... }`, `{ path = ... }`, `{ url = ... }`, or a list of them: anything
        // but an index that is PyPI is not the public package.
        for (name, src) in t.get("sources").and_then(Value::as_table).into_iter().flatten() {
            let entries: Vec<&Value> = match src {
                Value::Array(a) => a.iter().collect(),
                v => vec![v],
            };
            let public = entries.iter().all(|e| {
                e.get("index").and_then(Value::as_str).is_some_and(|i| public_named.contains(i) || (i.eq_ignore_ascii_case("pypi") && !private_named.contains(i)))
            });
            if !public {
                self.pypi_pinned.insert(crate::pypi::normalize(name));
            }
        }
    }

    /// `pyproject.toml`: uv's settings, Poetry's sources and per-dependency `source`, PDM's sources.
    fn pyproject(&mut self, text: &str) {
        let Ok(doc) = toml::from_str::<Value>(text) else { return };
        let tool = doc.get("tool");
        if let Some(uv) = tool.and_then(|t| t.get("uv")) {
            self.uv(uv);
        }
        let poetry = tool.and_then(|t| t.get("poetry"));
        for s in poetry.and_then(|p| p.get("source")).and_then(Value::as_array).into_iter().flatten() {
            let url = s.get("url").and_then(Value::as_str).unwrap_or("");
            if public_pypi(url) {
                continue;
            }
            // An explicit source serves only the dependencies pinned to it (below).
            if s.get("priority").and_then(Value::as_str) != Some("explicit") {
                self.pypi_index(if url.is_empty() { "unnamed" } else { url });
            }
        }
        // A dependency pinned to a source (`{ version = "1", source = "corp" }`) other than PyPI.
        let mut tables: Vec<&Value> = vec![];
        tables.extend(poetry.and_then(|p| p.get("dependencies")));
        tables.extend(poetry.and_then(|p| p.get("dev-dependencies")));
        for g in poetry.and_then(|p| p.get("group")).and_then(Value::as_table).into_iter().flat_map(|t| t.values()) {
            tables.extend(g.get("dependencies"));
        }
        for (name, v) in tables.into_iter().filter_map(Value::as_table).flatten() {
            let pinned = |v: &Value| v.get("source").and_then(Value::as_str).is_some_and(|s| !s.eq_ignore_ascii_case("pypi"));
            if pinned(v) || v.as_array().is_some_and(|a| a.iter().any(pinned)) {
                self.pypi_pinned.insert(crate::pypi::normalize(name));
            }
        }
        for s in tool.and_then(|t| t.get("pdm")).and_then(|p| p.get("source")).and_then(Value::as_array).into_iter().flatten() {
            self.pypi_index(s.get("url").and_then(Value::as_str).unwrap_or("unnamed"));
        }
    }

    /// `Pipfile`: `[[source]]` URLs, and packages pinned to an `index` other than PyPI.
    fn pipfile(&mut self, text: &str) {
        let Ok(doc) = toml::from_str::<Value>(text) else { return };
        let mut names: BTreeMap<String, String> = BTreeMap::new();
        for s in doc.get("source").and_then(Value::as_array).into_iter().flatten() {
            let url = s.get("url").and_then(Value::as_str).unwrap_or("unnamed");
            names.extend(s.get("name").and_then(Value::as_str).map(|n| (n.to_string(), url.to_string())));
            self.pypi_index(url);
        }
        for sec in ["packages", "dev-packages"] {
            for (name, v) in doc.get(sec).and_then(Value::as_table).into_iter().flatten() {
                if let Some(i) = v.get("index").and_then(Value::as_str)
                    && names.get(i).is_none_or(|u| !public_pypi(u))
                {
                    self.pypi_pinned.insert(crate::pypi::normalize(name));
                }
            }
        }
    }

    /// The environment's registry and index settings (npm's are case-insensitive).
    fn env(&mut self, env: &Env) {
        for (k, v) in &env.vars {
            if v.trim().is_empty() {
                continue;
            }
            let kl = k.to_ascii_lowercase();
            if let Some(rest) = kl.strip_prefix("npm_config_") {
                if rest == "registry" {
                    self.npm_registry(None, Some(v));
                } else if let Some(scope) = rest.strip_suffix(":registry").filter(|s| s.starts_with('@')) {
                    self.npm_registry(Some(scope), Some(v));
                }
            }
        }
        for k in ["YARN_NPM_REGISTRY_SERVER", "BUN_CONFIG_REGISTRY"] {
            if let Some(v) = env.var(k) {
                self.npm_registry(None, Some(v));
            }
        }
        for k in ["PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "PIP_FIND_LINKS", "UV_INDEX", "UV_INDEX_URL", "UV_DEFAULT_INDEX", "UV_EXTRA_INDEX_URL", "UV_FIND_LINKS", "PDM_PYPI_URL", "PIPENV_PYPI_MIRROR"] {
            if let Some(v) = env.var(k) {
                v.split_whitespace().for_each(|u| self.pypi_index(u));
            }
        }
    }

    /// Whether a configuration points this package anywhere but the public registry.
    fn configured_private(&self, purl: &str) -> bool {
        if let Some(name) = purl.strip_prefix("pkg:pypi/") {
            return self.pypi_any || self.pypi_pinned.contains(&crate::pypi::normalize(name));
        }
        let Some(name) = crate::util::npm_name(purl) else { return true };
        if self.npm_default {
            return true;
        }
        let scope = name.split_once('/').map(|(s, _)| s.to_ascii_lowercase()).filter(|s| s.starts_with('@'));
        scope.is_some_and(|s| self.npm_scopes.contains(&s))
    }

    /// Whether this package (a purl) may be named to a third party, given where its lockfiles say it came from.
    pub fn may_name(&self, purl: &str, seen: Seen) -> bool {
        // A Python package pinned to another index is that index's, whatever else a lockfile says of the name.
        if purl.starts_with("pkg:pypi/") && self.pypi_pinned.contains(&crate::pypi::normalize(&purl["pkg:pypi/".len()..])) {
            return false;
        }
        match seen {
            Seen::Elsewhere => false,
            Seen::Public | Seen::Unknown => !self.configured_private(purl),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(home: Option<&Path>, vars: &[(&str, &str)]) -> Env {
        Env { home: home.map(Path::to_path_buf), vars: vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
    }
    fn read(root: &Path, e: &Env) -> Registries {
        Registries::read(root, &BTreeSet::new(), &[], e)
    }
    fn write(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    const U: Seen = Seen::Unknown;

    #[test]
    fn urls_are_public_only_on_the_public_registries() {
        assert!(public_npm("https://registry.npmjs.org/"));
        assert!(public_npm("https://registry.yarnpkg.com/react/-/react-18.0.0.tgz"));
        assert!(public_npm("https://REGISTRY.npmjs.org:443/x"));
        assert!(!public_npm("https://registry.npmjs.org.evil.example/"));
        assert!(!public_npm("https://npm.corp.example/registry.npmjs.org/"));
        assert!(!public_npm("https://user:pw@artifactory.corp/api/npm/npm/"));
        assert!(!public_npm("git+ssh://git@github.com/acme/x.git"));
        assert!(public_pypi("https://pypi.org/simple"));
        assert!(public_pypi("https://files.pythonhosted.org/packages/x.whl"));
        assert!(!public_pypi("https://pypi.corp.example/simple"));
        assert!(!public_pypi("./wheels"));
        assert_eq!(Seen::Public.and(Seen::Elsewhere), Seen::Elsewhere);
        assert_eq!(Seen::Unknown.and(Seen::Public), Seen::Public);
    }

    #[test]
    fn nothing_configured_names_every_package_a_lockfile_does_not_place_elsewhere() {
        let d = tempfile::tempdir().unwrap();
        let r = read(d.path(), &env(None, &[]));
        assert!(r.may_name("pkg:npm/%40acme/ui", U));
        assert!(r.may_name("pkg:pypi/requests", U));
        assert!(!r.may_name("pkg:npm/left-pad", Seen::Elsewhere));
    }

    #[test]
    fn repository_npmrc_root_and_nested() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), ".npmrc", "# comment\n@acme:registry=https://npm.acme.example/\n@pub:registry=https://registry.npmjs.org/\n//npm.acme.example/:_authToken=${TOKEN}\n");
        write(d.path(), "packages/app/.npmrc", "@other:registry = \"https://npm.other.example\"\n");
        let dirs: BTreeSet<PathBuf> = [d.path().join("packages/app")].into();
        let r = Registries::read(d.path(), &dirs, &[], &env(None, &[]));
        assert!(!r.may_name("pkg:npm/%40acme/secret", U));
        assert!(!r.may_name("pkg:npm/%40other/thing", U));
        assert!(r.may_name("pkg:npm/%40pub/x", U));
        assert!(r.may_name("pkg:npm/react", U));
        // A public URL in a lockfile does not outweigh the scope's registry (rewritten lockfiles, replace-registry-host).
        assert!(!r.may_name("pkg:npm/%40acme/secret", Seen::Public));
        assert!(!r.may_name("pkg:npm/react", Seen::Elsewhere));
    }

    #[test]
    fn user_npmrc_under_home_and_its_default_registry() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        write(home.path(), ".npmrc", "@corp:registry=https://corp.jfrog.io/api/npm/npm/\n");
        let r = read(repo.path(), &env(Some(home.path()), &[]));
        assert!(!r.may_name("pkg:npm/%40corp/auth", U));
        assert!(r.may_name("pkg:npm/react", U));
        // A whole-registry proxy: every package without a public resolved URL is kept.
        write(home.path(), ".npmrc", "registry=https://nexus.corp/repository/npm-all/\n");
        let r = read(repo.path(), &env(Some(home.path()), &[]));
        assert!(!r.may_name("pkg:npm/react", U));
        assert!(!r.may_name("pkg:npm/%40corp/auth", U));
        assert!(!r.may_name("pkg:npm/react", Seen::Public));
        // A value naming an unset variable is not the public registry.
        write(home.path(), ".npmrc", "registry=${REGISTRY}\n");
        assert!(!read(repo.path(), &env(Some(home.path()), &[])).may_name("pkg:npm/react", U));
        assert!(read(repo.path(), &env(Some(home.path()), &[("REGISTRY", "https://registry.npmjs.org/")])).may_name("pkg:npm/react", U));
    }

    #[test]
    fn npm_environment_variables_in_any_case() {
        let d = tempfile::tempdir().unwrap();
        let r = read(d.path(), &env(None, &[("NPM_CONFIG_@ACME:REGISTRY", "https://npm.acme.example/")]));
        assert!(!r.may_name("pkg:npm/%40acme/x", U));
        assert!(r.may_name("pkg:npm/x", U));
        let r = read(d.path(), &env(None, &[("npm_config_registry", "https://verdaccio.local/")]));
        assert!(!r.may_name("pkg:npm/x", U));
        let r = read(d.path(), &env(None, &[("NPM_CONFIG_REGISTRY", "https://registry.npmjs.org/")]));
        assert!(r.may_name("pkg:npm/x", U));
        let r = read(d.path(), &env(None, &[("YARN_NPM_REGISTRY_SERVER", "https://npm.corp/")]));
        assert!(!r.may_name("pkg:npm/x", U));
    }

    #[test]
    fn userconfig_named_by_the_environment() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "cfg/custom-rc", "@acme:registry=https://npm.acme.example/\n");
        let p = d.path().join("cfg/custom-rc");
        let r = read(d.path(), &env(None, &[("NPM_CONFIG_USERCONFIG", p.to_str().unwrap())]));
        assert!(!r.may_name("pkg:npm/%40acme/x", U));
    }

    #[test]
    fn yarnrc_yml_scopes_and_default_server() {
        let d = tempfile::tempdir().unwrap();
        write(
            d.path(),
            ".yarnrc.yml",
            "nodeLinker: node-modules\nnpmScopes:\n  acme:\n    npmRegistryServer: \"https://npm.acme.example\"\n  paid:\n    npmAuthToken: \"${NPM_TOKEN}\"\n  open:\n    npmRegistryServer: https://registry.yarnpkg.com\n",
        );
        let r = read(d.path(), &env(None, &[]));
        assert!(!r.may_name("pkg:npm/%40acme/x", U));
        // Credentials for a scope on the public registry: its private packages.
        assert!(!r.may_name("pkg:npm/%40paid/x", U));
        assert!(r.may_name("pkg:npm/%40open/x", U));
        assert!(r.may_name("pkg:npm/react", U));
        write(d.path(), ".yarnrc.yml", "npmRegistryServer: \"https://npm.corp.example\"\n");
        assert!(!read(d.path(), &env(None, &[])).may_name("pkg:npm/react", U));
    }

    #[test]
    fn yarnrc_and_bunfig() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), ".yarnrc", "\"@acme:registry\" \"https://npm.acme.example\"\n");
        write(d.path(), "bunfig.toml", "[install.scopes]\nbig = { token = \"x\", url = \"https://registry.npmjs.org/\" }\nopen = \"https://registry.npmjs.org/\"\n");
        let r = read(d.path(), &env(None, &[]));
        assert!(!r.may_name("pkg:npm/%40acme/x", U));
        assert!(!r.may_name("pkg:npm/%40big/x", U));
        assert!(r.may_name("pkg:npm/%40open/x", U));
    }

    #[test]
    fn pip_conf_and_pip_environment() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        assert!(read(repo.path(), &env(Some(home.path()), &[])).may_name("pkg:pypi/requests", U));
        write(home.path(), ".config/pip/pip.conf", "[global]\nindex-url = https://pypi.org/simple\nextra-index-url =\n    https://pypi.org/simple\n    https://pypi.corp.example/simple\n");
        let r = read(repo.path(), &env(Some(home.path()), &[]));
        assert!(!r.may_name("pkg:pypi/requests", U));
        assert!(!r.may_name("pkg:pypi/requests", Seen::Public));
        assert!(!read(repo.path(), &env(None, &[("PIP_EXTRA_INDEX_URL", "https://pypi.org/simple https://corp/simple")])).may_name("pkg:pypi/x", U));
        assert!(!read(repo.path(), &env(None, &[("UV_INDEX", "corp=https://corp/simple")])).may_name("pkg:pypi/x", U));
        assert!(read(repo.path(), &env(None, &[("PIP_INDEX_URL", "https://pypi.org/simple")])).may_name("pkg:pypi/x", U));
    }

    #[test]
    fn requirements_index_options() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "requirements.txt", "requests==2.32.0\n");
        assert!(read(d.path(), &env(None, &[])).may_name("pkg:pypi/requests", U));
        write(d.path(), "requirements.txt", "--extra-index-url=https://pypi.corp.example/simple\nrequests==2.32.0\n");
        assert!(!read(d.path(), &env(None, &[])).may_name("pkg:pypi/requests", U));
        write(d.path(), "requirements.txt", "-i https://pypi.corp.example/simple\nrequests==2.32.0\n");
        assert!(!read(d.path(), &env(None, &[])).may_name("pkg:pypi/requests", U));
    }

    #[test]
    fn uv_indexes_and_sources() {
        let d = tempfile::tempdir().unwrap();
        write(
            d.path(),
            "pyproject.toml",
            "[project]\nname = \"x\"\n\n[tool.uv.sources]\nacme-tools = { index = \"corp\" }\nlocal-lib = { git = \"https://git.corp/lib\" }\n\n[[tool.uv.index]]\nname = \"corp\"\nurl = \"https://pypi.corp.example/simple\"\nexplicit = true\n",
        );
        let r = read(d.path(), &env(None, &[]));
        assert!(!r.may_name("pkg:pypi/acme-tools", U));
        assert!(!r.may_name("pkg:pypi/acme_tools", Seen::Public), "pinned to the index, whatever else is said of the name");
        assert!(!r.may_name("pkg:pypi/local-lib", U));
        // An explicit index serves only what is pinned to it.
        assert!(r.may_name("pkg:pypi/requests", U));
        write(d.path(), "uv.toml", "[[index]]\nurl = \"https://pypi.corp.example/simple\"\n");
        assert!(!read(d.path(), &env(None, &[])).may_name("pkg:pypi/requests", U));
    }

    #[test]
    fn poetry_and_pipfile_sources() {
        let d = tempfile::tempdir().unwrap();
        write(
            d.path(),
            "pyproject.toml",
            "[tool.poetry.dependencies]\npython = \"^3.11\"\nrequests = \"^2\"\ncorp-sdk = { version = \"^1\", source = \"corp\" }\n\n[[tool.poetry.source]]\nname = \"corp\"\nurl = \"https://pypi.corp.example/simple\"\npriority = \"explicit\"\n",
        );
        let r = read(d.path(), &env(None, &[]));
        assert!(!r.may_name("pkg:pypi/corp-sdk", U));
        assert!(r.may_name("pkg:pypi/requests", U));
        write(d.path(), "pyproject.toml", "[[tool.poetry.source]]\nname = \"corp\"\nurl = \"https://pypi.corp.example/simple\"\npriority = \"supplemental\"\n");
        assert!(!read(d.path(), &env(None, &[])).may_name("pkg:pypi/requests", U));
        std::fs::remove_file(d.path().join("pyproject.toml")).unwrap();
        write(d.path(), "Pipfile", "[[source]]\nname = \"pypi\"\nurl = \"https://pypi.org/simple\"\n\n[packages]\nrequests = \"*\"\n");
        assert!(read(d.path(), &env(None, &[])).may_name("pkg:pypi/requests", U));
        write(d.path(), "Pipfile", "[[source]]\nname = \"corp\"\nurl = \"https://pypi.corp.example/simple\"\n");
        assert!(!read(d.path(), &env(None, &[])).may_name("pkg:pypi/requests", U));
    }

    /// Every request the client would build for a stack: npm/PyPI version documents (deprecations, which the identity
    /// check shares the filter of), OSV queries, and catalog candidates asked for without a list.
    fn requests(root: &Path, e: &Env) -> (crate::stack::Stack, Vec<String>, Vec<String>) {
        let st = crate::stack::detect_in(root, e).unwrap();
        let cache = tempfile::tempdir().unwrap();
        let urls = std::sync::Mutex::new(vec![]);
        crate::deprecations::refresh_with(cache.path(), &st, 1, |u| {
            urls.lock().unwrap().push(u.to_string());
            None
        });
        let osv = std::sync::Mutex::new(vec![]);
        crate::advisories::refresh_with(cache.path(), root, &st, 1, |b| {
            osv.lock().unwrap().extend(b["queries"].as_array().unwrap().iter().map(|q| q["package"]["name"].as_str().unwrap().to_string()));
            None
        }, |_| None);
        (st, urls.into_inner().unwrap(), osv.into_inner().unwrap())
    }

    const APP: &str = r#"{"name": "app", "dependencies": {"react": "18.2.0", "@corp/auth": "1.0.0", "@acme/ui": "2.0.0"}}"#;
    /// Every URL on the public registry, as a rewritten lockfile has them.
    const LOCK: &str = r#"{"lockfileVersion": 3, "packages": {
        "": {"name": "app", "dependencies": {"react": "18.2.0", "@corp/auth": "1.0.0", "@acme/ui": "2.0.0"}},
        "node_modules/react": {"version": "18.2.0", "resolved": "https://registry.npmjs.org/react/-/react-18.2.0.tgz", "integrity": "sha512-aa"},
        "node_modules/@corp/auth": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/@corp/auth/-/auth-1.0.0.tgz", "integrity": "sha512-bb", "dependencies": {"@corp/crypto": "^3"}},
        "node_modules/@corp/crypto": {"version": "3.1.0", "resolved": "https://registry.npmjs.org/@corp/crypto/-/crypto-3.1.0.tgz", "integrity": "sha512-cc"},
        "node_modules/@acme/ui": {"version": "2.0.0", "resolved": "https://registry.npmjs.org/@acme/ui/-/ui-2.0.0.tgz", "integrity": "sha512-dd"}
    }}"#;

    #[test]
    fn a_home_npmrc_scope_and_a_yarnrc_yml_scope_are_never_queried() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        write(repo.path(), "package.json", APP);
        write(repo.path(), "package-lock.json", LOCK);
        // Before any configuration: every package is public and asked about.
        let (st, urls, osv) = requests(repo.path(), &env(Some(home.path()), &[]));
        assert!(st.deps.values().all(|d| d.public_candidate));
        assert_eq!(urls.len(), 3, "{urls:?}");
        assert_eq!(osv.len(), 4, "{osv:?}");
        write(home.path(), ".npmrc", "@corp:registry=https://corp.jfrog.io/artifactory/api/npm/npm-private/\n");
        write(repo.path(), ".yarnrc.yml", "npmScopes:\n  acme:\n    npmRegistryServer: \"https://npm.acme.example\"\n    npmAlwaysAuth: true\n");
        let (st, urls, osv) = requests(repo.path(), &env(Some(home.path()), &[]));
        for private in ["pkg:npm/%40corp/auth", "pkg:npm/%40acme/ui"] {
            assert!(!st.deps[private].public_candidate, "{private}");
        }
        assert!(st.deps["pkg:npm/react"].public_candidate);
        assert_eq!(urls, ["https://registry.npmjs.org/react/18.2.0"]);
        assert_eq!(osv, ["react"], "the transitive @corp/crypto is not sent either");
        // The catalog is not asked for a private package's name without its list; the public ones' still are.
        assert_eq!(st.withheld(), ["acme", "auth", "corp", "ui"].map(String::from).into());
        assert!(st.candidates().contains("react"));
    }

    #[test]
    fn a_pip_index_keeps_python_packages_from_pypi_and_osv() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        write(repo.path(), "requirements.txt", "corp-sdk==1.0.0 --hash=sha256:aa\nrequests==2.32.0 --hash=sha256:bb\n");
        write(repo.path(), "uv.lock", "version = 1\n\n[[package]]\nname = \"requests\"\nversion = \"2.32.0\"\nsource = { registry = \"https://pypi.org/simple\" }\n");
        let (st, _, _) = requests(repo.path(), &env(Some(home.path()), &[]));
        assert!(st.deps["pkg:pypi/corp-sdk"].public_candidate);
        let (st, urls, osv) = requests(repo.path(), &env(Some(home.path()), &[("PIP_EXTRA_INDEX_URL", "https://pypi.corp.example/simple")]));
        assert!(st.deps.values().all(|d| !d.public_candidate));
        assert!(urls.is_empty() && osv.is_empty(), "{urls:?} {osv:?}");
    }
}
