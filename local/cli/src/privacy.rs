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
//! Paid private packages live on `registry.npmjs.org` itself, under a public URL, and are always scoped. With
//! credentials for the public registry configured (`//registry.npmjs.org/:_authToken`, Yarn's `npmAuthToken`, Bun's
//! token), a scoped package is named to OSV or the catalog host only once an anonymous read of the public registry
//! confirms it (`needs_identity`, `confirm_public`, cached). That read goes to npm, which serves the package already,
//! so it tells npm nothing new; the deprecation and identity reads go to npm too. An unscoped package cannot be one.
//!
//! Public mirrors (`NPM_MIRRORS`, `PYPI_MIRRORS`) serve only public names and count as the public registry. A test,
//! example or fixture directory's configuration (`usage::path_role`) keeps private whatever only such directories
//! declare, and elsewhere only the scopes and names it lists: a test's local Verdaccio does not hide the application's
//! packages. A configuration file that does not parse may say anything, so its ecosystem is kept private; bytes that
//! are not UTF-8 are read as far as they are text.
//!
//! Configuration read, all of it (any source that applies makes a package private; a nested `.npmrc` is counted for
//! the whole repository rather than its own directory only):
//! - npm: `.npmrc` (the repository, its directories and their ancestors, `~/.npmrc`, `NPM_CONFIG_USERCONFIG`,
//!   `NPM_CONFIG_GLOBALCONFIG`, `$PREFIX/etc/npmrc` from `NPM_CONFIG_PREFIX` or the `node` on PATH, `/etc/npmrc`,
//!   `%APPDATA%\npm\etc\npmrc`), pnpm's global `rc`, `NPM_CONFIG_REGISTRY` and `NPM_CONFIG_@scope:registry` (any
//!   case), `.yarnrc.yml` (`npmRegistryServer`, `npmScopes`), `.yarnrc`, `YARN_NPM_REGISTRY_SERVER`, `YARN_REGISTRY`,
//!   `bunfig.toml` and `BUN_CONFIG_REGISTRY`. A scope Yarn or Bun configures with credentials is private.
//! - PyPI: `pip.conf`/`pip.ini` (user, site, Windows `%APPDATA%`, `%USERPROFILE%` and `%PROGRAMDATA%`,
//!   `PIP_CONFIG_FILE`, the virtualenv's), `PIP_INDEX_URL`, `PIP_EXTRA_INDEX_URL`, `PIP_FIND_LINKS` (any case),
//!   requirements files' `--index-url`, `--extra-index-url` and `--find-links`, uv (`[tool.uv]`, `uv.toml`, the user's
//!   and `%APPDATA%`'s, `UV_CONFIG_FILE` by any name, `UV_INDEX`, `UV_INDEX_URL`, `UV_DEFAULT_INDEX`,
//!   `UV_EXTRA_INDEX_URL`, `UV_FIND_LINKS`; an `explicit` index serves only the packages pinned to it), Poetry sources,
//!   PDM sources and Pipfile sources.

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

/// Public mirrors of the npm registry: read-only copies that serve no package the public registry does not, so a
/// name they serve is a public name. Only well-known mirrors whose operators publish nothing of anyone else's.
const NPM_MIRRORS: &[&str] = &["registry.npmmirror.com", "registry.npm.taobao.org", "mirrors.cloud.tencent.com"];
/// Public PyPI mirrors (same rule), and PyTorch's index, which serves only PyTorch's own published wheels.
const PYPI_MIRRORS: &[&str] = &["pypi.tuna.tsinghua.edu.cn", "mirrors.tuna.tsinghua.edu.cn", "mirrors.aliyun.com", "mirrors.cloud.tencent.com", "download.pytorch.org"];

/// The public npm registry (and Yarn's mirror of it), or a public mirror (`NPM_MIRRORS`).
pub fn public_npm(url: &str) -> bool {
    host(url).is_some_and(|h| h == "registry.npmjs.org" || h == "registry.yarnpkg.com" || NPM_MIRRORS.contains(&h.as_str()))
}

/// The public npm registry itself: where a paid private package can live beside public ones.
fn npmjs(url: &str) -> bool {
    host(url).is_some_and(|h| h == "registry.npmjs.org" || h == "registry.yarnpkg.com")
}

/// PyPI: its index and the host of its files, or a public mirror (`PYPI_MIRRORS`).
pub fn public_pypi(url: &str) -> bool {
    host(url).is_some_and(|h| h == "pypi.org" || h == "pypi.python.org" || h == "files.pythonhosted.org" || PYPI_MIRRORS.contains(&h.as_str()))
}

/// The environment the package managers read: the home directory and the variables. Passed in, so tests set their own.
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub home: Option<PathBuf>,
    pub vars: BTreeMap<String, String>,
}

impl Env {
    /// This process's environment; an empty one in unit tests, which never read a developer's own configuration
    /// (`~/.npmrc`, `PIP_INDEX_URL`) and give theirs explicitly.
    pub fn current() -> Env {
        if cfg!(test) { Env::default() } else { Env::process() }
    }
    pub fn process() -> Env {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).filter(|h| !h.is_empty()).map(PathBuf::from);
        Env { home, vars: std::env::vars().collect() }
    }
    /// A variable by name, in any case when the exact one is not set (Windows names are case-insensitive).
    fn var(&self, k: &str) -> Option<&str> {
        self.vars.get(k).or_else(|| self.vars.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v)).map(String::as_str).filter(|v| !v.trim().is_empty())
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
    /// Files in the user's and the system's configuration, with how each is read: the home directory's, the XDG,
    /// macOS and Windows configuration directories', npm's global `npmrc`, and those the environment names.
    fn user_files(&self) -> Vec<(PathBuf, Kind)> {
        let mut out = vec![];
        if let Some(h) = &self.home {
            for (f, k) in [
                (".npmrc", Kind::Npmrc),
                (".yarnrc.yml", Kind::YarnrcYml),
                (".yarnrc", Kind::Yarnrc),
                (".bunfig.toml", Kind::Bunfig),
                (".pip/pip.conf", Kind::Pip),
                ("pip/pip.ini", Kind::Pip),
                ("Library/Application Support/pip/pip.conf", Kind::Pip),
                ("Library/Preferences/pnpm/rc", Kind::Npmrc),
            ] {
                out.push((h.join(f), k));
            }
        }
        let xdg = self.var("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| self.home.as_ref().map(|h| h.join(".config")));
        if let Some(x) = xdg {
            for (f, k) in [("pip/pip.conf", Kind::Pip), ("uv/uv.toml", Kind::Uv), (".bunfig.toml", Kind::Bunfig), ("pnpm/rc", Kind::Npmrc)] {
                out.push((x.join(f), k));
            }
        }
        // Windows: %APPDATA%, %LOCALAPPDATA%, %USERPROFILE% and %PROGRAMDATA%.
        for (var, f, k) in [
            ("APPDATA", "pip/pip.ini", Kind::Pip),
            ("APPDATA", "uv/uv.toml", Kind::Uv),
            ("APPDATA", "npm/etc/npmrc", Kind::Npmrc),
            ("LOCALAPPDATA", "pnpm/config/rc", Kind::Npmrc),
            ("USERPROFILE", "pip/pip.ini", Kind::Pip),
            ("USERPROFILE", ".npmrc", Kind::Npmrc),
            ("PROGRAMDATA", "pip/pip.ini", Kind::Pip),
            ("PROGRAMDATA", "uv/uv.toml", Kind::Uv),
        ] {
            if let Some(v) = self.var(var) {
                out.push((Path::new(v).join(f), k));
            }
        }
        if let Some(v) = self.var("VIRTUAL_ENV") {
            out.push((Path::new(v).join("pip.conf"), Kind::Pip));
            out.push((Path::new(v).join("pip.ini"), Kind::Pip));
        }
        // npm's global configuration: `$PREFIX/etc/npmrc`, the prefix named, else the one beside the `node` on PATH
        // (`<prefix>/bin/node`; on Windows `node.exe` sits in the prefix itself).
        let mut prefixes: Vec<PathBuf> = ["NPM_CONFIG_PREFIX", "PREFIX"].iter().filter_map(|k| self.var(k)).map(PathBuf::from).collect();
        for dir in self.var("PATH").map(std::env::split_paths).into_iter().flatten() {
            if dir.join("node").is_file() {
                prefixes.extend(dir.parent().map(Path::to_path_buf));
            }
            if dir.join("node.exe").is_file() {
                prefixes.push(dir);
            }
        }
        for p in prefixes {
            out.push((p.join("etc/npmrc"), Kind::Npmrc));
        }
        for (k, kind) in [
            ("NPM_CONFIG_USERCONFIG", Kind::Npmrc),
            ("NPM_CONFIG_GLOBALCONFIG", Kind::Npmrc),
            ("PIP_CONFIG_FILE", Kind::Pip),
            ("UV_CONFIG_FILE", Kind::Uv),
        ] {
            if let Some(v) = self.var(k) {
                out.push((PathBuf::from(v), kind));
            }
        }
        for (f, k) in [("/etc/pip.conf", Kind::Pip), ("/etc/xdg/pip/pip.conf", Kind::Pip), ("/etc/uv/uv.toml", Kind::Uv), ("/etc/npmrc", Kind::Npmrc)] {
            out.push((PathBuf::from(f), k));
        }
        out
    }
}

/// How a configuration file is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    Npmrc,
    YarnrcYml,
    Yarnrc,
    Bunfig,
    Pip,
    Uv,
    Pyproject,
    Pipfile,
    Requirements,
}

impl Kind {
    /// By file name, for the files of the repository.
    fn of(name: &str) -> Option<Kind> {
        Some(match name {
            ".npmrc" => Kind::Npmrc,
            ".yarnrc.yml" => Kind::YarnrcYml,
            ".yarnrc" => Kind::Yarnrc,
            "bunfig.toml" => Kind::Bunfig,
            "pip.conf" => Kind::Pip,
            "uv.toml" => Kind::Uv,
            "pyproject.toml" => Kind::Pyproject,
            "Pipfile" => Kind::Pipfile,
            n if (n.starts_with("requirements") || n.starts_with("constraints")) && n.ends_with(".txt") => Kind::Requirements,
            _ => return None,
        })
    }
}

/// The configuration files read in a project directory (`is_config` for the names the repository walk collects).
const DIR_FILES: &[&str] = &[".npmrc", ".yarnrc.yml", ".yarnrc", "bunfig.toml", "uv.toml", "pip.conf", "pyproject.toml", "Pipfile"];

/// The configuration files of these directories (fixed names, and the requirements files among their entries,
/// gitignored or not) and `files`, with how each is read.
fn project_files(dirs: &BTreeSet<PathBuf>, files: &[PathBuf]) -> BTreeSet<(PathBuf, Kind)> {
    let mut all: BTreeSet<(PathBuf, Kind)> = files.iter().filter_map(|f| Some((f.clone(), Kind::of(&f.file_name()?.to_string_lossy())?))).collect();
    for d in dirs {
        for f in DIR_FILES {
            all.extend(Kind::of(f).map(|k| (d.join(f), k)));
        }
        for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
            all.extend(Kind::of(&e.file_name().to_string_lossy()).map(|k| (e.path(), k)));
        }
    }
    all
}

/// A file whose registry or index settings count (`Registries::read`).
pub fn is_config(name: &str) -> bool {
    Kind::of(name).is_some()
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
    /// npm: credentials for the public registry itself are configured, so paid private packages (always scoped) can
    /// be installed from it under a public URL (`needs_identity`).
    npm_token: bool,
}

impl Registries {
    /// The configuration in the repository's `files` (those the walk found), in `root`, its ancestors and every
    /// directory in `dirs` (a gitignored `.npmrc` beside a manifest is still the package manager's), in the user's
    /// configuration and in the environment.
    pub fn read(root: &Path, dirs: &BTreeSet<PathBuf>, files: &[PathBuf], env: &Env) -> Registries {
        let mut all = project_files(dirs, files);
        for d in root.ancestors() {
            for f in DIR_FILES {
                all.extend(Kind::of(f).map(|k| (d.join(f), k)));
            }
        }
        all.extend(project_files(&BTreeSet::from([root.to_path_buf()]), &[]));
        all.extend(env.user_files());
        let mut r = Registries::from_files(all, env);
        r.env(env);
        r
    }

    /// Only the settings in these directories and files: no ancestor's, the user's or the environment's. For the test,
    /// example and fixture directories of a repository (`stack::detect_in`), whose settings are their own.
    pub fn read_local(dirs: &BTreeSet<PathBuf>, files: &[PathBuf]) -> Registries {
        Registries::from_files(project_files(dirs, files), &Env::default())
    }

    /// What names packages one by one (scopes and pins), without the settings that keep a whole ecosystem private.
    /// Credentials for the public npm registry are kept: they only make a scoped package wait for npm to confirm it
    /// (`needs_identity`), which fails closed.
    pub fn narrow(&self) -> Registries {
        Registries { npm_scopes: self.npm_scopes.clone(), pypi_pinned: self.pypi_pinned.clone(), npm_token: self.npm_token, ..Registries::default() }
    }

    /// Both configurations: a package either keeps private is private.
    pub fn union(mut self, other: &Registries) -> Registries {
        self.npm_default |= other.npm_default;
        self.pypi_any |= other.pypi_any;
        self.npm_token |= other.npm_token;
        self.npm_scopes.extend(other.npm_scopes.iter().cloned());
        self.pypi_pinned.extend(other.pypi_pinned.iter().cloned());
        self
    }

    fn from_files(all: BTreeSet<(PathBuf, Kind)>, env: &Env) -> Registries {
        let mut r = Registries::default();
        for (p, kind) in all {
            // Bytes that are not UTF-8 are read as far as they are text, never skipped: a setting must not be lost.
            let Ok(bytes) = std::fs::read(&p) else { continue };
            let text = String::from_utf8_lossy(&bytes);
            match kind {
                Kind::Npmrc => r.npmrc(&text, env),
                Kind::YarnrcYml => r.yarnrc_yml(&text, env),
                Kind::Yarnrc => r.yarnrc(&text),
                Kind::Bunfig => r.bunfig(&text),
                Kind::Pip => r.pip_conf(&text),
                Kind::Uv => match toml::from_str::<Value>(&text) {
                    Ok(t) => r.uv(&t),
                    Err(_) => r.pypi_any = true,
                },
                Kind::Pyproject => r.pyproject(&text),
                Kind::Pipfile => r.pipfile(&text),
                Kind::Requirements => r.requirements(&text),
            }
        }
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

    /// A credential setting (`_authToken`, `_auth`, `_password`, `username`) for `//host/...:` or for the default
    /// registry: one for the public registry itself means paid private packages may be installed from it.
    fn npm_credential(&mut self, key: &str) {
        let (target, setting) = key.rsplit_once(':').unwrap_or(("", key));
        let setting = setting.to_ascii_lowercase();
        if !matches!(setting.as_str(), "_authtoken" | "_auth" | "_password" | "username" | "certfile" | "keyfile") {
            return;
        }
        if target.is_empty() || target.strip_prefix("//").is_some_and(|t| npmjs(&format!("https://{t}"))) {
            self.npm_token = true;
        }
    }

    /// `.npmrc`: `registry=` and `@scope:registry=` (an unset `${VAR}` in the value is not the public registry), and
    /// credentials for the public registry.
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
            } else {
                self.npm_credential(k);
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
                // Credentials for the default registry, or under `npmRegistries` for the public one.
                [] if k == "npmAuthToken" || k == "npmAuthIdent" => self.npm_token = true,
                ["npmRegistries", reg] if (k == "npmAuthToken" || k == "npmAuthIdent") && npmjs(&format!("https:{}", reg.trim_start_matches("https:"))) => {
                    self.npm_token = true
                }
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

    /// `bunfig.toml`: `[install] registry` and `[install.scopes]`, a string or `{ url, token, ... }`. One that does not
    /// parse may say anything: every npm package is kept private.
    fn bunfig(&mut self, text: &str) {
        let Ok(doc) = toml::from_str::<Value>(text) else {
            self.npm_default = true;
            return;
        };
        let Some(install) = doc.get("install") else { return };
        let url = |v: &Value| v.as_str().map(String::from).or_else(|| v.get("url").and_then(Value::as_str).map(String::from));
        if let Some(reg) = install.get("registry") {
            self.npm_registry(None, url(reg).as_deref());
            if reg.as_table().is_some_and(|t| t.keys().any(|k| k != "url")) && url(reg).is_none_or(|u| npmjs(&u)) {
                self.npm_token = true;
            }
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
        // One that does not parse may name any index: every Python package is kept private.
        let Ok(doc) = toml::from_str::<Value>(text) else {
            self.pypi_any = true;
            return;
        };
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
        let Ok(doc) = toml::from_str::<Value>(text) else {
            self.pypi_any = true;
            return;
        };
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
                } else {
                    self.npm_credential(rest);
                }
            }
        }
        if ["YARN_NPM_AUTH_TOKEN", "YARN_NPM_AUTH_IDENT", "BUN_CONFIG_TOKEN"].iter().any(|k| env.var(k).is_some()) {
            self.npm_token = true;
        }
        for k in ["YARN_NPM_REGISTRY_SERVER", "YARN_REGISTRY", "BUN_CONFIG_REGISTRY"] {
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

    /// Whether this package, though `may_name` allows it, needs the public registry to confirm it first: a scoped npm
    /// package while credentials for the public registry are configured. npm's paid private packages are always scoped
    /// and installed from `registry.npmjs.org` itself, so neither a lockfile URL nor a configuration tells them apart.
    pub fn needs_identity(&self, purl: &str) -> bool {
        self.npm_token && crate::util::npm_name(purl).is_some_and(|n| n.starts_with('@'))
    }
}

/// A confirmed public identity is asked again after this long; a refusal (a private or missing package) after a day.
const IDENTITY_PUBLIC_SECS: u64 = 30 * 86400;
const IDENTITY_PRIVATE_SECS: u64 = 86400;

#[derive(serde::Serialize, serde::Deserialize)]
struct Identity {
    checked: u64,
    public: bool,
}

fn identity_path(cache: &Path, purl: &str) -> PathBuf {
    cache.join("registry/identity").join(format!("{}.json", &crate::util::sha256_hex(purl.as_bytes())[..32]))
}

/// What the cache says of a package's public identity, while fresh.
fn identity_cached(cache: &Path, purl: &str, at: u64) -> Option<bool> {
    let c: Identity = serde_json::from_slice(&std::fs::read(identity_path(cache, purl)).ok()?).ok()?;
    let fresh = if c.public { IDENTITY_PUBLIC_SECS } else { IDENTITY_PRIVATE_SECS };
    (at.saturating_sub(c.checked) < fresh).then_some(c.public)
}

/// Keeps a public identity confirmed elsewhere (`onboarding::public_package` reads the same documents).
pub fn note_public(cache: &Path, purl: &str, at: u64) {
    if let Ok(b) = serde_json::to_vec(&Identity { checked: at, public: true }) {
        let _ = crate::util::write_atomic(&identity_path(cache, purl), &b);
    }
}

/// Whether the cache holds a fresh confirmation that this package is public (no request).
pub fn known_public(cache: &Path, purl: &str, at: u64) -> bool {
    identity_cached(cache, purl, at) == Some(true)
}

/// The packages among `purls` the public npm registry confirms, reading the cache first. `ask` reads the registry
/// anonymously: `Some(true)` public, `Some(false)` refused or missing, `None` not answered (asked again next time).
/// Asking npm about a package npm itself serves tells it nothing it does not know; asking anyone else would.
pub fn confirm_public(cache: &Path, at: u64, purls: &[String], ask: impl Fn(&str) -> Option<bool> + Sync) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    let mut due = vec![];
    for p in purls {
        match identity_cached(cache, p, at) {
            Some(true) => {
                out.insert(p.clone());
            }
            Some(false) => {}
            None => due.push(p.clone()),
        }
    }
    crate::util::concurrent(&due, crate::util::REQUESTS_AT_ONCE, |p| ask(p), |i, got| {
        if let Some(public) = got {
            if let Ok(b) = serde_json::to_vec(&Identity { checked: at, public }) {
                let _ = crate::util::write_atomic(&identity_path(cache, &due[i]), &b);
            }
            if public {
                out.insert(due[i].clone());
            }
        }
        true
    });
    out
}

/// An anonymous read of a package's latest version on the public npm registry: public when it is served under its
/// own name and not marked private.
pub fn npm_identity(agent: &ureq::Agent, purl: &str) -> Option<bool> {
    let name = crate::util::npm_name(purl)?;
    let enc: String = name.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    let mut r = agent.get(format!("https://registry.npmjs.org/{enc}/latest")).call().ok()?;
    match r.status().as_u16() {
        200 => {
            let v: serde_json::Value = serde_json::from_slice(&r.body_mut().with_config().limit(4 * 1024 * 1024).read_to_vec().ok()?).ok()?;
            Some(v.get("name").and_then(|n| n.as_str()) == Some(name.as_str()) && v.get("private").and_then(|p| p.as_bool()) != Some(true))
        }
        401 | 403 | 404 => Some(false),
        _ => None,
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
    /// check shares the filter of), OSV queries, and the anonymous npm identity reads (`identity` answers them).
    fn requests_with(root: &Path, e: &Env, cache: &Path, identity: impl Fn(&str) -> Option<bool> + Sync) -> (crate::stack::Stack, Vec<String>, Vec<String>, Vec<String>) {
        let st = crate::stack::detect_in(root, e).unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let urls = std::sync::Mutex::new(vec![]);
        crate::deprecations::refresh_with(cache, &st, now, |u| {
            urls.lock().unwrap().push(u.to_string());
            None
        });
        let (osv, asked) = (std::sync::Mutex::new(vec![]), std::sync::Mutex::new(vec![]));
        let post = |b: &serde_json::Value| {
            osv.lock().unwrap().extend(b["queries"].as_array().unwrap().iter().map(|q| q["package"]["name"].as_str().unwrap().to_string()));
            None
        };
        let ask = |p: &str| {
            asked.lock().unwrap().push(p.to_string());
            identity(p)
        };
        crate::advisories::refresh_with(cache, root, &st, now, post, |_| None, ask, |_, _, _| None);
        let mut osv = osv.into_inner().unwrap();
        osv.sort();
        let mut asked = asked.into_inner().unwrap();
        asked.sort();
        (st, urls.into_inner().unwrap(), osv, asked)
    }
    fn requests(root: &Path, e: &Env) -> (crate::stack::Stack, Vec<String>, Vec<String>) {
        let cache = tempfile::tempdir().unwrap();
        let (st, urls, osv, _) = requests_with(root, e, cache.path(), |_| None);
        (st, urls, osv)
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
        assert_eq!(st.withheld(tempfile::tempdir().unwrap().path()), ["acme", "auth", "corp", "ui"].map(String::from).into());
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

    #[test]
    fn windows_locations_and_case_insensitive_variables() {
        let d = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let at = |var: &str, rel: &str, text: &str| {
            let dir = d.path().join(var);
            write(&dir, rel, text);
            env(None, &[(var, dir.to_str().unwrap())])
        };
        for (var, rel) in [("APPDATA", "pip/pip.ini"), ("USERPROFILE", "pip/pip.ini"), ("PROGRAMDATA", "pip/pip.ini")] {
            let e = at(var, rel, "[global]\nindex-url = https://pypi.corp.example/simple\n");
            assert!(!read(repo.path(), &e).may_name("pkg:pypi/requests", U), "{var}");
        }
        let e = at("APPDATA", "uv/uv.toml", "[[index]]\nurl = \"https://pypi.corp.example/simple\"\n");
        assert!(!read(repo.path(), &e).may_name("pkg:pypi/requests", U));
        let e = at("APPDATA", "npm/etc/npmrc", "@corp:registry=https://npm.corp.example/\n");
        assert!(!read(repo.path(), &e).may_name("pkg:npm/%40corp/x", U));
        let e = at("LOCALAPPDATA", "pnpm/config/rc", "registry=https://npm.corp.example/\n");
        assert!(!read(repo.path(), &e).may_name("pkg:npm/react", U));
        // Windows keeps a variable's case as set; pip reads it in any.
        assert!(!read(repo.path(), &env(None, &[("Pip_Index_Url", "https://pypi.corp.example/simple")])).may_name("pkg:pypi/requests", U));
        assert!(!read(repo.path(), &env(None, &[("pip_extra_index_url", "https://pypi.corp.example/simple")])).may_name("pkg:pypi/requests", U));
    }

    #[test]
    fn global_npmrc_pnpm_rc_yarn_registry_and_a_custom_uv_config_file() {
        let d = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        // `$PREFIX/etc/npmrc`, named or found beside the `node` on PATH.
        write(d.path(), "prefix/etc/npmrc", "@corp:registry=https://npm.corp.example/\n");
        let prefix = d.path().join("prefix");
        assert!(!read(repo.path(), &env(None, &[("NPM_CONFIG_PREFIX", prefix.to_str().unwrap())])).may_name("pkg:npm/%40corp/x", U));
        write(d.path(), "prefix/bin/node", "");
        let bin = prefix.join("bin");
        assert!(!read(repo.path(), &env(None, &[("PATH", bin.to_str().unwrap())])).may_name("pkg:npm/%40corp/x", U));
        let home = tempfile::tempdir().unwrap();
        write(home.path(), ".config/pnpm/rc", "@acme:registry=https://npm.acme.example/\n");
        assert!(!read(repo.path(), &env(Some(home.path()), &[])).may_name("pkg:npm/%40acme/x", U));
        write(home.path(), "Library/Preferences/pnpm/rc", "registry=https://npm.acme.example/\n");
        assert!(!read(repo.path(), &env(Some(home.path()), &[])).may_name("pkg:npm/react", U));
        assert!(!read(repo.path(), &env(None, &[("YARN_REGISTRY", "https://npm.corp.example/")])).may_name("pkg:npm/react", U));
        // UV_CONFIG_FILE by any name is uv's TOML; `UV_INDEX` with a query string is still that index.
        write(d.path(), "ci/uv-ci.toml", "[[index]]\nurl = \"https://pypi.corp.example/simple\"\n");
        let f = d.path().join("ci/uv-ci.toml");
        assert!(!read(repo.path(), &env(None, &[("UV_CONFIG_FILE", f.to_str().unwrap())])).may_name("pkg:pypi/requests", U));
        assert!(!read(repo.path(), &env(None, &[("UV_INDEX", "https://pypi.corp.example/simple?x=1")])).may_name("pkg:pypi/requests", U));
    }

    #[test]
    fn unreadable_or_unparsable_configuration_fails_closed() {
        let d = tempfile::tempdir().unwrap();
        // Not UTF-8 before the setting: read anyway.
        let p = d.path().join(".npmrc");
        std::fs::write(&p, [b"# caf\xe9\n".as_slice(), b"@corp:registry=https://npm.corp.example/\n"].concat()).unwrap();
        assert!(!read(d.path(), &env(None, &[])).may_name("pkg:npm/%40corp/x", U));
        std::fs::remove_file(&p).unwrap();
        write(d.path(), "bunfig.toml", "[install\nregistry = ");
        assert!(!read(d.path(), &env(None, &[])).may_name("pkg:npm/react", U));
        std::fs::remove_file(d.path().join("bunfig.toml")).unwrap();
        write(d.path(), "pyproject.toml", "[tool.uv\nindex = ");
        let r = read(d.path(), &env(None, &[]));
        assert!(!r.may_name("pkg:pypi/requests", U));
        assert!(r.may_name("pkg:npm/react", U), "only that ecosystem");
        std::fs::remove_file(d.path().join("pyproject.toml")).unwrap();
        write(d.path(), "uv.toml", "index = [");
        assert!(!read(d.path(), &env(None, &[])).may_name("pkg:pypi/requests", U));
    }

    #[test]
    fn public_mirrors_are_public() {
        let d = tempfile::tempdir().unwrap();
        for (url, purl) in [
            ("https://registry.npmmirror.com/", "pkg:npm/react"),
            ("https://mirrors.cloud.tencent.com/npm/", "pkg:npm/react"),
            ("https://pypi.tuna.tsinghua.edu.cn/simple", "pkg:pypi/requests"),
            ("https://mirrors.aliyun.com/pypi/simple/", "pkg:pypi/requests"),
            ("https://download.pytorch.org/whl/cpu", "pkg:pypi/requests"),
        ] {
            let var = if purl.starts_with("pkg:npm/") { "NPM_CONFIG_REGISTRY" } else { "PIP_EXTRA_INDEX_URL" };
            assert!(read(d.path(), &env(None, &[(var, url)])).may_name(purl, U), "{url}");
        }
        assert!(!public_npm("https://npmmirror.com.corp.example/"));
    }

    #[test]
    fn fixture_and_example_configuration_keeps_only_what_those_directories_declare() {
        let repo = tempfile::tempdir().unwrap();
        write(repo.path(), "package.json", r#"{"name": "app", "dependencies": {"react": "18.2.0"}}"#);
        // A test's local Verdaccio, and the package only that test installs from it.
        write(repo.path(), "test/fixtures/proj/.npmrc", "registry=http://localhost:4873/\n@fx:registry=http://localhost:4873/\n");
        write(repo.path(), "test/fixtures/proj/package.json", r#"{"name": "proj", "dependencies": {"fixture-only-lib": "1.0.0", "@fx/a": "1.0.0"}}"#);
        write(repo.path(), "packages/web/package.json", r#"{"name": "web", "dependencies": {"@fx/b": "1.0.0"}}"#);
        write(repo.path(), "requirements.txt", "--extra-index-url https://download.pytorch.org/whl/cpu\ntorch==2.3.0\nrequests==2.32.0\n");
        let st = crate::stack::detect_in(repo.path(), &env(None, &[])).unwrap();
        let public = |p: &str| st.deps[p].public_candidate;
        assert!(public("pkg:npm/react") && public("pkg:pypi/torch") && public("pkg:pypi/requests"));
        assert!(!public("pkg:npm/fixture-only-lib"), "the fixture's blanket registry covers what only it declares");
        // A scope a fixture lists stays private everywhere.
        assert!(!public("pkg:npm/%40fx/a") && !public("pkg:npm/%40fx/b"));
    }

    #[test]
    fn an_alias_without_a_version_is_named_by_its_target() {
        let repo = tempfile::tempdir().unwrap();
        write(repo.path(), "package.json", r#"{"name": "app", "dependencies": {"foo": "npm:@corp/bar", "baz": "npm:qux@^2"}}"#);
        write(repo.path(), ".npmrc", "@corp:registry=https://npm.corp.example/\n");
        let st = crate::stack::detect_in(repo.path(), &env(None, &[])).unwrap();
        assert!(!st.deps.contains_key("pkg:npm/foo") && !st.deps.contains_key("pkg:npm/baz"), "{:?}", st.deps.keys());
        assert!(!st.deps["pkg:npm/%40corp/bar"].public_candidate);
        assert!(st.deps["pkg:npm/qux"].public_candidate);
    }

    #[test]
    fn credentials_for_the_public_registry_need_npm_to_confirm_a_scoped_package() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        write(repo.path(), "package.json", r#"{"name": "app", "dependencies": {"react": "18.2.0", "@myorg/secret": "1.0.0", "@types/node": "22.0.0"}}"#);
        write(
            repo.path(),
            "package-lock.json",
            r#"{"lockfileVersion": 3, "packages": {
            "": {"name": "app", "dependencies": {"react": "18.2.0", "@myorg/secret": "1.0.0", "@types/node": "22.0.0"}},
            "node_modules/react": {"version": "18.2.0", "resolved": "https://registry.npmjs.org/react/-/react-18.2.0.tgz", "integrity": "sha512-aa"},
            "node_modules/@myorg/secret": {"version": "1.0.0", "resolved": "https://registry.npmjs.org/@myorg/secret/-/secret-1.0.0.tgz", "integrity": "sha512-bb"},
            "node_modules/@types/node": {"version": "22.0.0", "resolved": "https://registry.npmjs.org/@types/node/-/node-22.0.0.tgz", "integrity": "sha512-cc"}
        }}"#,
        );
        let identity = |p: &str| Some(p == "pkg:npm/%40types/node");
        // No credentials: nothing to confirm.
        let cache = tempfile::tempdir().unwrap();
        let (_, _, osv, asked) = requests_with(repo.path(), &env(Some(home.path()), &[]), cache.path(), identity);
        assert_eq!((osv.len(), asked.len()), (3, 0));
        // Logged in to the public registry (paid private packages): a scoped package goes to OSV only once an anonymous
        // read of npm confirms it; an unscoped one cannot be private there.
        write(home.path(), ".npmrc", "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n");
        let e = env(Some(home.path()), &[]);
        let cache = tempfile::tempdir().unwrap();
        let (st, _, osv, asked) = requests_with(repo.path(), &e, cache.path(), identity);
        assert_eq!(osv, ["@types/node", "react"]);
        assert_eq!(asked, ["pkg:npm/%40myorg/secret", "pkg:npm/%40types/node"]);
        // The answers are cached: the next run asks nobody.
        let (_, _, osv, asked) = requests_with(repo.path(), &e, cache.path(), |_| panic!("asked again"));
        assert_eq!((osv, asked.len()), (vec!["@types/node".to_string(), "react".to_string()], 0));
        // The catalog without its list is not asked for an unconfirmed scoped package's names.
        let withheld = st.withheld(cache.path());
        assert!(withheld.contains("myorg") && withheld.contains("secret") && !withheld.contains("types"), "{withheld:?}");
        // The same credentials from Yarn or the environment.
        for (rc, var) in [(Some("npmAuthToken: \"${NPM_TOKEN}\"\n"), None), (None, Some(("NPM_CONFIG_//registry.npmjs.org/:_authToken", "x")))] {
            let repo2 = tempfile::tempdir().unwrap();
            if let Some(rc) = rc {
                write(repo2.path(), ".yarnrc.yml", rc);
            }
            let r = read(repo2.path(), &env(None, var.as_slice()));
            assert!(r.needs_identity("pkg:npm/%40myorg/secret") && !r.needs_identity("pkg:npm/react"));
        }
        // Credentials for another registry say nothing about the public one.
        let repo3 = tempfile::tempdir().unwrap();
        write(repo3.path(), ".npmrc", "//npm.corp.example/:_authToken=x\n");
        assert!(!read(repo3.path(), &env(None, &[])).needs_identity("pkg:npm/%40myorg/secret"));
    }

    #[test]
    fn an_examples_npm_credentials_still_need_npm_to_confirm_its_scoped_packages() {
        let repo = tempfile::tempdir().unwrap();
        write(repo.path(), "package.json", r#"{"name": "app", "dependencies": {"react": "18.2.0"}}"#);
        // The only npmjs credentials are an example's; that example installs a vendor's scoped package from npmjs.
        write(repo.path(), "examples/enterprise/.npmrc", "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n");
        write(repo.path(), "examples/enterprise/package.json", r#"{"name": "enterprise-example", "dependencies": {"@vendor/enterprise-sdk": "3.0.0"}}"#);
        write(
            repo.path(),
            "examples/enterprise/package-lock.json",
            r#"{"lockfileVersion": 3, "packages": {
            "": {"name": "enterprise-example", "dependencies": {"@vendor/enterprise-sdk": "3.0.0"}},
            "node_modules/@vendor/enterprise-sdk": {"version": "3.0.0", "resolved": "https://registry.npmjs.org/@vendor/enterprise-sdk/-/enterprise-sdk-3.0.0.tgz", "integrity": "sha512-ee"}
        }}"#,
        );
        let cache = tempfile::tempdir().unwrap();
        let (st, _, osv, asked) = requests_with(repo.path(), &env(None, &[]), cache.path(), |_| Some(false));
        assert!(!osv.iter().any(|n| n.contains("vendor")), "{osv:?}");
        assert_eq!(asked, ["pkg:npm/%40vendor/enterprise-sdk"], "npm, which serves it, is asked first");
        let withheld = st.withheld(cache.path());
        assert!(withheld.contains("vendor") && withheld.contains("enterprise-sdk"), "{withheld:?}");
        // Confirmed public by npm: sent as any other.
        let cache = tempfile::tempdir().unwrap();
        let (_, _, osv, _) = requests_with(repo.path(), &env(None, &[]), cache.path(), |_| Some(true));
        assert!(osv.contains(&"@vendor/enterprise-sdk".to_string()), "{osv:?}");
    }

    #[test]
    fn a_project_templates_files_are_not_the_repositorys_configuration() {
        let repo = tempfile::tempdir().unwrap();
        write(repo.path(), "requirements.txt", "requests==2.32.0\n");
        // A cookiecutter template: not valid TOML until rendered, and not this repository's project.
        write(repo.path(), "{{cookiecutter.slug}}/pyproject.toml", "[project]\nname = \"{{cookiecutter.slug}}\"\ndependencies = [{% for d in deps %}\"{{ d }}\",{% endfor %}]\n");
        write(repo.path(), "{{cookiecutter.slug}}/.npmrc", "registry={{cookiecutter.registry}}\n");
        write(repo.path(), "package.json", r#"{"name": "app", "dependencies": {"react": "18.2.0"}}"#);
        let st = crate::stack::detect_in(repo.path(), &env(None, &[])).unwrap();
        assert!(st.deps["pkg:pypi/requests"].public_candidate && st.deps["pkg:npm/react"].public_candidate);
    }
}
