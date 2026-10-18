//! Code that exists because of a dependency's limits, found without a model call: patched packages (`patches/`,
//! `pnpm.patchedDependencies`, patch-package, Yarn patches), aliased or forked packages (`alias@npm:other`, a Git
//! dependency), and comments that say a workaround waits on upstream ("remove when X lands", a monkeypatch, an
//! upstream issue or pull request). The report joins them to catalog records: an upgrade whose records cite the same
//! upstream issue or pull request, or that moves the patched, aliased or named package, may let the code drop it.

use std::collections::BTreeSet;

use crate::usage::{self, Role};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Patch,
    Alias,
    Fork,
    Comment,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Patch => "patched package",
            Kind::Alias => "aliased package",
            Kind::Fork => "forked package",
            Kind::Comment => "workaround comment",
        }
    }
}

/// An upstream issue or pull request a comment cites: `owner/repo` lowercased, and its number.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Ref {
    pub repo: String,
    pub number: u64,
}

#[derive(Debug, Clone)]
pub struct Workaround {
    pub kind: Kind,
    pub path: String,
    /// 1-based; 0 for a whole file (a patch).
    pub line: usize,
    /// The package it works around, when the manifest or file name says (patch, alias, fork).
    pub package: Option<String>,
    pub refs: Vec<Ref>,
    /// Lowercased words of a comment (split on everything but letters, digits, `@`, `/`, `-`, `_`; dotted paths
    /// split too, so `geventhttpclient.useragent` names `geventhttpclient`).
    pub words: BTreeSet<String>,
}

impl Workaround {
    pub fn place(&self) -> String {
        if self.line == 0 { self.path.clone() } else { format!("{}:{}", self.path, self.line) }
    }
}

fn base(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// The package a patch file is for, from the three naming schemes: pnpm (`@scope__name@1.2.3.patch`), patch-package
/// (`@scope+name+1.2.3.patch`, nested `a+1.0.0++b+2.0.0.patch` patches `a`) and Yarn (`name-npm-1.2.3-hash.patch`).
pub fn patch_package(file: &str) -> Option<String> {
    let stem = file.strip_suffix(".patch").or_else(|| file.strip_suffix(".diff"))?;
    let name = if let Some((n, _)) = stem.split_once("-npm-") {
        match n.strip_prefix('@') {
            Some(rest) => format!("@{}", rest.replacen('-', "/", 1)),
            None => n.to_string(),
        }
    } else if stem.contains('+') {
        let parts: Vec<&str> = stem.split('+').collect();
        if stem.starts_with('@') && parts.len() > 1 { format!("{}/{}", parts[0], parts[1]) } else { parts[0].to_string() }
    } else {
        let s = match stem.strip_prefix('@') {
            Some(rest) => format!("@{}", rest.replacen("__", "/", 1)),
            None => stem.to_string(),
        };
        strip_version(&s).to_string()
    };
    (!name.is_empty() && name != "@").then_some(name)
}

/// `name@1.2.3` → `name`, `@scope/name@^1` → `@scope/name`.
fn strip_version(s: &str) -> &str {
    match s[1.min(s.len())..].find('@') {
        Some(i) => &s[..i + 1],
        None => s,
    }
}

fn unquote(s: &str) -> &str {
    s.trim().trim_matches(|c| c == '\'' || c == '"')
}

/// `key: value` lines of a YAML block (`patchedDependencies:`, `overrides:`, `catalog:`), one level below it.
fn yaml_block<'a>(text: &'a str, key: &str) -> Vec<(usize, &'a str, &'a str)> {
    let mut out = vec![];
    let mut inside = false;
    for (n, line) in text.lines().enumerate() {
        if !line.starts_with(' ') && !line.trim().is_empty() {
            inside = line.trim_end() == format!("{key}:");
            continue;
        }
        if !inside || line.trim_start().starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.trim().split_once(": ") {
            out.push((n + 1, unquote(k), unquote(v)));
        }
    }
    out
}

fn is_git(spec: &str) -> bool {
    ["github:", "git+", "git://", "https://github.com/", "gitlab:", "bitbucket:"].iter().any(|p| spec.starts_with(p))
}

/// An alias or fork declared for `name` with `spec`: `npm:other@1` names another package; a Git URL a fork.
fn declared(path: &str, line: usize, name: &str, spec: &str, out: &mut Vec<Workaround>) {
    let name = strip_version(name).to_string();
    if let Some(target) = spec.strip_prefix("npm:") {
        if strip_version(target) != name {
            out.push(Workaround { kind: Kind::Alias, path: path.into(), line, package: Some(name), refs: vec![], words: BTreeSet::new() });
        }
    } else if is_git(spec) {
        out.push(Workaround { kind: Kind::Fork, path: path.into(), line, package: Some(name), refs: vec![], words: BTreeSet::new() });
    }
}

fn line_of(text: &str, needle: &str) -> usize {
    text.lines().position(|l| l.contains(needle)).map_or(0, |i| i + 1)
}

/// Words that say a comment works around something: on their own, or a removal ("remove", "drop", "delete",
/// "revert") tied to a moment ("when", "once", "after", "until").
const MARKERS: &[&str] = &[
    "workaround", "work around", "monkey patch", "monkeypatch", "monkey-patch", "until upstream", "once upstream",
    "upstream fix", "upstream bug", "upstream issue", "fixed upstream", "temporary fix", "temporary patch", "hack",
];
const REMOVALS: &[&str] = &["remove", "drop", "delete", "revert"];
const MOMENTS: &[&str] = &[" when ", " once ", " after ", " until "];

/// Where `word` occurs in `text` as a whole word.
fn word_at(text: &str, word: &str) -> Vec<usize> {
    let alnum = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric());
    text.match_indices(word)
        .filter(|(i, _)| !alnum(text[..*i].chars().next_back()) && !alnum(text[i + word.len()..].chars().next()))
        .map(|(i, _)| i)
        .collect()
}

/// The first marker phrase in a lowercased comment block: a marker word, or a removal followed within a few words by
/// its moment ("remove the cast when bumping to v2", "drop this once upstream ships").
fn marker(lower: &str) -> Option<&'static str> {
    MARKERS.iter().copied().find(|m| !word_at(lower, m).is_empty()).or_else(|| {
        REMOVALS.iter().copied().find(|r| {
            word_at(lower, r).into_iter().any(|i| {
                let mut end = lower.len().min(i + 48);
                while !lower.is_char_boundary(end) {
                    end -= 1;
                }
                let window = &lower[i..end];
                let window = window.split(['.', ';', '!', '?', ',', '—', '(']).next().unwrap_or(window);
                MOMENTS.iter().any(|m| window.contains(m))
            })
        })
    })
}

/// `owner/repo#123` and `github.com/owner/repo/(issues|pull)/123` in a comment.
pub fn refs(text: &str) -> Vec<Ref> {
    let mut out = BTreeSet::new();
    let ok = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.');
    let mut rest = text;
    while let Some(i) = rest.find("github.com/") {
        let tail = &rest[i + 11..];
        let parts: Vec<&str> = tail.splitn(5, '/').collect();
        if parts.len() >= 4 && matches!(parts[2], "issues" | "pull" | "pulls") {
            let num: String = parts[3].chars().take_while(char::is_ascii_digit).collect();
            if let Ok(number) = num.parse() {
                out.insert(Ref { repo: format!("{}/{}", parts[0], parts[1]).to_ascii_lowercase(), number });
            }
        }
        rest = tail;
    }
    for (i, _) in text.match_indices('#') {
        let num: String = text[i + 1..].chars().take_while(char::is_ascii_digit).collect();
        let Ok(number) = num.parse() else { continue };
        let before: String = text[..i].chars().rev().take_while(|&c| ok(c) || c == '/').collect::<Vec<_>>().into_iter().rev().collect();
        if let Some((owner, repo)) = before.split_once('/')
            && !owner.is_empty() && !repo.is_empty() && !repo.contains('/')
        {
            out.insert(Ref { repo: before.to_ascii_lowercase(), number });
        }
    }
    out.into_iter().collect()
}

fn words(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for w in text.split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '@' | '/' | '-' | '_' | '.'))) {
        let w = w.trim_matches(|c: char| matches!(c, '.' | '/' | '-')).to_ascii_lowercase();
        if w.is_empty() {
            continue;
        }
        for part in w.split('.') {
            if !part.is_empty() {
                out.insert(part.to_string());
            }
        }
        out.insert(w);
    }
    out
}

/// The comment text of a line, if it is (or ends in) a comment.
fn comment(line: &str) -> Option<&str> {
    let t = line.trim_start();
    for p in ["//", "#", "/*", "*", "<!--", "--"] {
        if let Some(rest) = t.strip_prefix(p) {
            return Some(rest);
        }
    }
    line.find(" // ").or_else(|| line.find(" # ")).map(|i| &line[i + 3..])
}

/// Every workaround in the repository's read files and paths.
pub fn detect(repo: &usage::Repo) -> Vec<Workaround> {
    let mut out = vec![];
    let mut patched = BTreeSet::new();
    for path in &repo.paths {
        let in_patches = path.rsplit('/').nth(1).is_some_and(|d| d == "patches");
        if in_patches && let Some(pkg) = patch_package(base(path)) && patched.insert(pkg.clone()) {
            out.push(Workaround { kind: Kind::Patch, path: path.clone(), line: 0, package: Some(pkg), refs: vec![], words: BTreeSet::new() });
        }
    }
    for (path, text) in &repo.files {
        if matches!(repo.role(path), Role::Generated | Role::Vendored | Role::Docs) {
            continue;
        }
        match base(path) {
            "package.json" => {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { continue };
                if let Some(m) = v.pointer("/pnpm/patchedDependencies").and_then(|m| m.as_object()) {
                    for k in m.keys() {
                        let pkg = strip_version(k).to_string();
                        if patched.insert(pkg.clone()) {
                            out.push(Workaround { kind: Kind::Patch, path: path.clone(), line: line_of(text, k), package: Some(pkg), refs: vec![], words: BTreeSet::new() });
                        }
                    }
                }
                for field in ["/dependencies", "/devDependencies", "/optionalDependencies", "/peerDependencies", "/overrides", "/resolutions", "/pnpm/overrides"] {
                    let Some(m) = v.pointer(field).and_then(|m| m.as_object()) else { continue };
                    for (k, spec) in m {
                        if let Some(spec) = spec.as_str() {
                            let k = k.rsplit('>').next().unwrap_or(k);
                            if spec.starts_with("patch:") && patched.insert(strip_version(k).to_string()) {
                                out.push(Workaround { kind: Kind::Patch, path: path.clone(), line: line_of(text, spec), package: Some(strip_version(k).to_string()), refs: vec![], words: BTreeSet::new() });
                            }
                            declared(path, line_of(text, spec), k, spec, &mut out);
                        }
                    }
                }
            }
            "pnpm-workspace.yaml" => {
                for (n, k, _) in yaml_block(text, "patchedDependencies") {
                    let pkg = strip_version(k).to_string();
                    if patched.insert(pkg.clone()) {
                        out.push(Workaround { kind: Kind::Patch, path: path.clone(), line: n, package: Some(pkg), refs: vec![], words: BTreeSet::new() });
                    }
                }
                for block in ["overrides", "catalog"] {
                    for (n, k, spec) in yaml_block(text, block) {
                        declared(path, n, k.rsplit('>').next().unwrap_or(k), spec, &mut out);
                    }
                }
            }
            "pyproject.toml" | "requirements.txt" => {
                for (n, line) in text.lines().enumerate() {
                    let t = unquote(line.trim().trim_end_matches(','));
                    if let Some((name, spec)) = t.split_once(" @ ")
                        && is_git(spec.trim())
                        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '[' | ']'))
                    {
                        let name = name.split('[').next().unwrap_or(name).to_string();
                        out.push(Workaround { kind: Kind::Fork, path: path.clone(), line: n + 1, package: Some(name), refs: vec![], words: BTreeSet::new() });
                    }
                }
            }
            _ => {}
        }
        // Comments: a run of comment lines is one block, so a marker and the issue it cites may sit on different
        // lines. Data files have no comments.
        if path.ends_with(".json") {
            continue;
        }
        let lines: Vec<&str> = text.lines().collect();
        let mut i = 0;
        while i < lines.len() {
            if comment(lines[i]).is_none() {
                i += 1;
                continue;
            }
            let start = i;
            let mut block = String::new();
            while i < lines.len() && i - start < 12 && let Some(c) = comment(lines[i]) {
                block.push_str(c);
                block.push(' ');
                i += 1;
            }
            let lower = block.to_ascii_lowercase();
            if let Some(m) = marker(&lower) {
                let at = (start..i).find(|&j| lines[j].to_ascii_lowercase().contains(m)).unwrap_or(start) + 1;
                out.push(Workaround { kind: Kind::Comment, path: path.clone(), line: at, package: None, refs: refs(&block), words: words(&block) });
            }
        }
    }
    out
}

/// A package name as a comment would write it: the full name and its pnpm patch spelling (`@scope__name`). A scoped
/// package's bare name (`whatsapp` of `@chat-adapter/whatsapp`) is the platform as often as the package.
fn spellings(pkg: &str) -> Vec<String> {
    let p = pkg.to_ascii_lowercase();
    let mut out = vec![p.clone()];
    if let Some(rest) = p.strip_prefix('@') {
        out.push(format!("@{}", rest.replacen('/', "__", 1)));
    }
    out.retain(|s| s.contains(['-', '/', '_', '@']) || s.len() >= 6);
    out
}

/// A record's upstream: the `owner/repo` of its GitHub evidence, with the issue and pull request numbers it cites
/// (`/pull/123` in the URL, `#123` in the quote).
pub fn evidence_refs(urls_quotes: &[(&str, &str)]) -> (BTreeSet<String>, BTreeSet<Ref>) {
    let mut repos = BTreeSet::new();
    let mut cited = BTreeSet::new();
    for (url, quote) in urls_quotes {
        let Some(tail) = url.split("github.com/").nth(1) else { continue };
        let parts: Vec<&str> = tail.split('/').collect();
        if parts.len() < 2 {
            continue;
        }
        let repo = format!("{}/{}", parts[0], parts[1]).to_ascii_lowercase();
        for r in refs(url) {
            cited.insert(r);
        }
        for (i, _) in quote.match_indices('#') {
            let num: String = quote[i + 1..].chars().take_while(char::is_ascii_digit).collect();
            if let Ok(number) = num.parse() {
                cited.insert(Ref { repo: repo.clone(), number });
            }
        }
        repos.insert(repo);
    }
    (repos, cited)
}

/// How strongly a workaround joins a technology: 3 when one of its records cites the same upstream issue or pull
/// request; 2 when the manifest patches, aliases or forks its package, or a comment names the package (or its
/// distinctive upstream repository) in a file that imports it; 1 when such a comment cites an issue in its upstream
/// repository; `None` otherwise.
pub fn joins(
    w: &Workaround,
    packages: &[String],
    repos: &BTreeSet<String>,
    cited: &BTreeSet<Ref>,
    imports: impl Fn(&str) -> bool,
) -> Option<u8> {
    if w.refs.iter().any(|r| cited.contains(r)) {
        return Some(3);
    }
    if let Some(p) = &w.package {
        return packages.iter().any(|q| q.eq_ignore_ascii_case(p)).then_some(2);
    }
    let named = packages.iter().flat_map(|p| spellings(p)).any(|s| w.words.contains(&s))
        || repos.iter().filter_map(|r| r.split('/').nth(1)).any(|r| (r.contains('-') || r.len() >= 8) && !r.contains('.') && w.words.contains(r));
    let strength = if named { 2 } else if w.refs.iter().any(|r| repos.contains(&r.repo)) { 1 } else { return None };
    imports(&w.path).then_some(strength)
}

/// What the manifests say about a technology's packages: whether application manifests declare one for runtime (not
/// only `devDependencies` or a dev group), and what keeps automated update PRs (Dependabot, Renovate) from moving it
/// to a fixed version on their own: an exact pin, or an override or resolution that sets its version.
#[derive(Debug, Default, PartialEq)]
pub struct Facts {
    pub runtime: bool,
    /// Every manifest that declares it does so for development only (`devDependencies`, a dependency group, an
    /// optional extra, the build system): no code that ships runs it.
    pub dev_only: bool,
    pub blocker: Option<String>,
}

fn exact(spec: &str) -> bool {
    let s = spec.strip_prefix('=').unwrap_or(spec).trim();
    s.starts_with(|c: char| c.is_ascii_digit()) && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')) && !s.contains(['x', 'X'])
}

fn pep_name(s: &str) -> String {
    s.to_ascii_lowercase().replace(['_', '.'], "-")
}

/// One manifest's declaration of a package, read once per report (`declarations`) and filtered per technology.
#[derive(Debug, Clone)]
pub struct Decl {
    /// npm name as written; PyPI names normalized (`pep_name`).
    name: String,
    path: String,
    /// The manifest is application code (`Role::App`), not an example, CI script or fixture.
    app: bool,
    /// Declared for development only (`devDependencies`, a dev requirements file, a dependency group, an extra, the
    /// build system); `None` for an override, which neither ships nor develops it.
    dev: Option<bool>,
    /// What holds its version: "an exact pin" or "an override".
    holds: Option<&'static str>,
}

fn req_name(r: &str) -> String {
    pep_name(&r.chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect::<String>())
}

/// Every package declaration in the read manifests (package.json, pnpm-workspace.yaml, pyproject.toml,
/// requirements files).
pub fn declarations(repo: &usage::Repo) -> Vec<Decl> {
    let mut out = vec![];
    for (path, text) in &repo.files {
        let app = repo.role(path) == Role::App;
        let mut push = |name: String, dev: Option<bool>, holds: Option<&'static str>| out.push(Decl { name, path: path.clone(), app, dev, holds });
        let key = |k: &str| strip_version(k.rsplit('>').next().unwrap_or(k)).to_string();
        match base(path) {
            "package.json" => {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { continue };
                for field in ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] {
                    let Some(m) = v.get(field).and_then(|m| m.as_object()) else { continue };
                    for (k, spec) in m {
                        push(k.clone(), Some(field == "devDependencies"), spec.as_str().is_some_and(exact).then_some("an exact pin"));
                    }
                }
                for field in ["/overrides", "/resolutions", "/pnpm/overrides"] {
                    for k in v.pointer(field).and_then(|m| m.as_object()).into_iter().flat_map(|m| m.keys()) {
                        push(key(k), None, Some("an override"));
                    }
                }
            }
            "pnpm-workspace.yaml" => {
                for (_, k, _) in yaml_block(text, "overrides") {
                    push(key(k), None, Some("an override"));
                }
                for (_, k, v) in yaml_block(text, "catalog") {
                    if exact(v) {
                        push(k.to_string(), None, Some("an exact pin"));
                    }
                }
            }
            "pyproject.toml" => {
                let Ok(t) = text.parse::<toml::Table>() else { continue };
                let reqs = |v: Option<&toml::Value>| v.and_then(|d| d.as_array()).into_iter().flatten().filter_map(|r| r.as_str()).map(String::from).collect::<Vec<_>>();
                for r in reqs(t.get("project").and_then(|p| p.get("dependencies"))) {
                    push(req_name(&r), Some(false), r.contains("==").then_some("an exact pin"));
                }
                let groups = [t.get("dependency-groups"), t.get("project").and_then(|p| p.get("optional-dependencies"))];
                let mut dev: Vec<String> = groups.iter().flatten().filter_map(|g| g.as_table()).flat_map(|g| g.values()).flat_map(|v| reqs(Some(v))).collect();
                dev.extend(reqs(t.get("build-system").and_then(|b| b.get("requires"))));
                for r in dev {
                    push(req_name(&r), Some(true), None);
                }
            }
            name if name.starts_with("requirements") && name.ends_with(".txt") => {
                let dev = ["dev", "test", "lint", "doc"].iter().any(|d| name.contains(d));
                for line in text.lines().map(str::trim) {
                    let n = req_name(line);
                    if !n.is_empty() {
                        push(n, Some(dev), line.contains("==").then_some("an exact pin"));
                    }
                }
            }
            _ => {}
        }
    }
    out
}

pub fn facts(decls: &[Decl], packages: &[String]) -> Facts {
    let names: BTreeSet<String> = packages.iter().flat_map(|p| [p.clone(), pep_name(p)]).collect();
    let mine: Vec<&Decl> = decls.iter().filter(|d| names.contains(&d.name)).collect();
    let shipped = mine.iter().any(|d| d.dev == Some(false));
    Facts {
        runtime: mine.iter().any(|d| d.app && d.dev == Some(false)),
        dev_only: !shipped && mine.iter().any(|d| d.dev == Some(true)),
        // Only application manifests hold back what ships: a pin in an example, a CI script or a test fixture does not.
        blocker: mine.iter().find(|d| d.app && d.holds.is_some()).map(|d| format!("{} in {}", d.holds.unwrap_or_default(), d.path)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_file_names_give_the_package() {
        assert_eq!(patch_package("@chat-adapter__teams@4.37.0.patch").as_deref(), Some("@chat-adapter/teams"));
        assert_eq!(patch_package("bull@4.16.4.patch").as_deref(), Some("bull"));
        assert_eq!(patch_package("ics.patch").as_deref(), Some("ics"));
        assert_eq!(patch_package("@scope+name+1.2.3.patch").as_deref(), Some("@scope/name"));
        assert_eq!(patch_package("react-native+0.72.0++metro+0.76.patch").as_deref(), Some("react-native"));
        assert_eq!(patch_package("@scope-name-npm-1.2.3-abcdef.patch").as_deref(), Some("@scope/name"));
        assert_eq!(patch_package("notes.txt"), None);
    }

    #[test]
    fn comments_cite_upstream_issues() {
        let r = refs("Drop the patch once upstream sends the flag (vercel/chat#950). See https://github.com/a/b/pull/12.");
        assert_eq!(r, vec![Ref { repo: "a/b".into(), number: 12 }, Ref { repo: "vercel/chat".into(), number: 950 }]);
        assert!(refs("color #fff and issue #12").is_empty());
        assert!(marker("remove the `as any` when bumping to v2").is_some());
        assert!(marker("re-check them when upgrading playwright").is_none());
        assert!(marker("copying files we immediately delete, but the result is small when built").is_none());
        assert!(marker("ts-ics < 2.4.5 does not parse it. remove this after upgrading.").is_some());
        assert!(marker("a hacky shack").is_none());
        assert_eq!(marker(" eslint deep-merges settings, so we can't drop  the key — instead empty its extension list so import-x matches nothing here"), None);
    }

    #[test]
    fn a_comment_joins_by_cited_issue_or_by_name_in_an_importing_file() {
        let w = Workaround {
            kind: Kind::Comment, path: "src/a.ts".into(), line: 3, package: None,
            refs: refs("until vercel/chat#950 lands"), words: words("Remove when bumping redux-toolkit to v2"),
        };
        let (repos, cited) = evidence_refs(&[("https://github.com/vercel/chat/releases/tag/x", "Send the flag (#950)")]);
        assert_eq!(joins(&w, &["@chat-adapter/teams".into()], &repos, &cited, |_| false), Some(3));
        let (repos, cited) = evidence_refs(&[("https://github.com/reduxjs/redux-toolkit/releases/tag/v2.12.0", "fix")]);
        assert_eq!(joins(&w, &["@reduxjs/toolkit".into()], &repos, &cited, |_| true), Some(2));
        assert_eq!(joins(&w, &["@reduxjs/toolkit".into()], &repos, &cited, |_| false), None, "the file must import it");
        let short = Workaround { words: words("workaround: the next line needs this"), refs: vec![], ..w.clone() };
        assert_eq!(joins(&short, &["next".into()], &BTreeSet::new(), &BTreeSet::new(), |_| true), None, "a plain short word is not a name");
        let monkey = Workaround { words: words("Monkey patch geventhttpclient.useragent.CompatRequest so that Cookiejar works"), refs: vec![], ..w };
        assert_eq!(joins(&monkey, &["geventhttpclient".into()], &BTreeSet::new(), &BTreeSet::new(), |_| true), Some(2));
    }

    #[test]
    fn manifests_declare_aliases_forks_and_patches() {
        let mut out = vec![];
        declared("pnpm-workspace.yaml", 46, "@lexical/code", "npm:lexical-code-no-prism@0.41.0", &mut out);
        declared("package.json", 3, "lodash", "npm:lodash@4.17.21", &mut out);
        declared("package.json", 4, "slate", "github:me/slate#fix", &mut out);
        assert_eq!(out.iter().map(|w| (w.kind, w.package.clone().unwrap())).collect::<Vec<_>>(), vec![(Kind::Alias, "@lexical/code".into()), (Kind::Fork, "slate".into())]);
        let yaml = "packages:\n  - a\npatchedDependencies:\n  '@chat-adapter/teams@4.37.0': patches/x.patch\n  ics: patches/ics.patch\noverrides:\n  foo: 1.0.0\n";
        assert!(exact("4.37.0") && exact("=1.2.3") && !exact("^1.2.3") && !exact("1.x") && !exact("workspace:*"));
        assert_eq!(yaml_block(yaml, "patchedDependencies").iter().map(|x| x.1).collect::<Vec<_>>(), vec!["@chat-adapter/teams@4.37.0", "ics"]);
    }
}
