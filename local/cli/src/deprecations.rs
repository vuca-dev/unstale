//! Deprecated by the publisher: the registry's own flag on an installed version of a direct dependency. npm's
//! `deprecated` message on the version (`npm deprecate`, set on every version when a whole package is retired), and
//! PyPI's yank of the release (PEP 592, with its reason). An official signal that costs no model call and needs no
//! catalog coverage, so it is known for every direct dependency at once, covered or still queued. Transitive
//! dependencies are never read (a package the project does not declare is not part of its stack).
//!
//! The registry is read at the network moments (`init`/`status`, `sync`/`run`); every output reads the cache only. Per
//! package and version, one cached answer under the user cache (`registry/deprecated/`), asked again after a day. A
//! registry that cannot be read leaves the cached answer as it was (none: nothing is said). `UNSTALE_NO_REGISTRY=1`
//! turns the reads off.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::stack::Stack;
use crate::util;

/// A cached answer is asked again after this long.
const FRESH_SECS: u64 = 24 * 3600;

/// One installed version its publisher deprecated (npm) or yanked (PyPI).
#[derive(Debug, Clone, PartialEq)]
pub struct Notice {
    pub purl: String,
    pub name: String,
    pub version: String,
    /// The registry's words, untrusted (shown as data, never as instructions).
    pub message: String,
    pub yanked: bool,
    pub url: String,
    /// The registry's newest release (npm `latest`, PyPI `info.version`), and whether its publisher deprecated or
    /// yanked that too (a whole package retired or renamed), when read.
    pub latest: Option<(String, bool)>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Cached {
    checked: u64,
    /// The deprecation message (npm) or yank reason (PyPI); absent when the version is neither.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    yanked: bool,
    /// The source repository the version document names (`repository`, PyPI `project_urls`), as `https://host/owner/repo`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repo: Option<String>,
    /// The version document was read for its repository (answers cached before it was are asked again).
    #[serde(default)]
    repo_read: bool,
    /// For a deprecated or yanked version: the newest release and whether it is deprecated or yanked too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    latest: Option<(String, bool)>,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn path(cache: &Path, purl: &str, version: &str) -> PathBuf {
    let key = util::sha256_hex(format!("{purl}@{version}").as_bytes());
    cache.join("registry/deprecated").join(format!("{}.json", &key[..32]))
}

fn pypi_name(purl: &str) -> Option<&str> {
    purl.strip_prefix("pkg:pypi/")
}

/// The registry document of one version: npm `registry.npmjs.org/<name>/<version>`, PyPI
/// `pypi.org/pypi/<name>/<version>/json`.
pub fn version_url(purl: &str, version: &str) -> Option<String> {
    let enc = |s: &str| s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
    if let Some(name) = pypi_name(purl) {
        return Some(format!("https://pypi.org/pypi/{}/{}/json", enc(name), enc(version)));
    }
    let name = util::npm_name(purl)?;
    Some(format!("https://registry.npmjs.org/{}/{}", enc(&name), enc(version)))
}

/// Where a person reads it: the version's registry page.
fn page(purl: &str, name: &str, version: &str) -> String {
    if pypi_name(purl).is_some() { format!("https://pypi.org/project/{name}/{version}/") } else { format!("https://www.npmjs.com/package/{name}/v/{version}") }
}

/// The deprecation or yank a version document states: `(message, yanked)`, or None. npm: a non-empty `deprecated`
/// string (`true` reads as deprecated with no message). PyPI: `info.yanked` with `info.yanked_reason`.
pub fn read_doc(purl: &str, doc: &serde_json::Value) -> Option<(String, bool)> {
    if pypi_name(purl).is_some() {
        let info = doc.get("info")?;
        if info.get("yanked").and_then(|y| y.as_bool()) != Some(true) {
            return None;
        }
        let reason = info.get("yanked_reason").and_then(|r| r.as_str()).unwrap_or("").trim().to_string();
        return Some((reason, true));
    }
    match doc.get("deprecated")? {
        serde_json::Value::String(s) if !s.trim().is_empty() => Some((s.trim().to_string(), false)),
        serde_json::Value::Bool(true) => Some((String::new(), false)),
        _ => None,
    }
}

/// The source repository a version document names, as OSV names a `GIT` package (`https://github.com/owner/repo`):
/// npm's `repository` (a string or `{url}`), PyPI's `info.project_urls` (Source, Repository, Code or Homepage, the first
/// on a code host). None when it names none on a known code host.
pub fn repository(purl: &str, doc: &serde_json::Value) -> Option<String> {
    let norm = |u: &str| -> Option<String> {
        let u = u.trim().trim_start_matches("git+").replace("git://", "https://").replace("ssh://git@", "https://").replace("git@github.com:", "https://github.com/");
        let u = u.strip_prefix("github:").map(|r| format!("https://github.com/{r}")).unwrap_or(u);
        let rest = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://"))?;
        let mut parts = rest.split(['/', '#', '?']).filter(|p| !p.is_empty());
        let host = parts.next()?.trim_start_matches("www.").to_ascii_lowercase();
        if !matches!(host.as_str(), "github.com" | "gitlab.com" | "bitbucket.org") {
            return None;
        }
        let (owner, repo) = (parts.next()?, parts.next()?.trim_end_matches(".git"));
        Some(format!("https://{host}/{owner}/{repo}"))
    };
    if pypi_name(purl).is_some() {
        let urls = doc.pointer("/info/project_urls").and_then(|u| u.as_object())?;
        let keyed = |k: &str| urls.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).and_then(|(_, v)| v.as_str()).and_then(norm);
        return ["Source", "Source Code", "Repository", "Code", "Homepage"].iter().find_map(|k| keyed(k)).or_else(|| urls.values().filter_map(|v| v.as_str()).find_map(norm));
    }
    match doc.get("repository")? {
        serde_json::Value::String(s) => norm(s).or_else(|| (s.split('/').count() == 2 && !s.contains(':')).then(|| format!("https://github.com/{s}"))),
        v => v.get("url").and_then(|u| u.as_str()).and_then(norm),
    }
}

/// The repository the installed version's registry document named, from the cache alone.
pub fn cached_repository(cache: &Path, purl: &str, version: &str) -> Option<String> {
    cached(cache, purl, version)?.repo
}

/// The registry document of the newest release: npm `registry.npmjs.org/<name>/latest`, PyPI `pypi.org/pypi/<name>/json`.
fn latest_url(purl: &str) -> Option<String> {
    let enc = |s: &str| s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
    if let Some(name) = pypi_name(purl) {
        return Some(format!("https://pypi.org/pypi/{}/json", enc(name)));
    }
    Some(format!("https://registry.npmjs.org/{}/latest", enc(&util::npm_name(purl)?)))
}

/// The newest release a `latest_url` document names, and whether it is deprecated or yanked too.
fn read_latest(purl: &str, doc: &serde_json::Value) -> Option<(String, bool)> {
    let v = if pypi_name(purl).is_some() { doc.pointer("/info/version") } else { doc.get("version") }?.as_str()?.to_string();
    Some((v, read_doc(purl, doc).is_some()))
}

/// Keeps what a version document said (one already fetched, such as the public-identity check's), so the refresh
/// does not ask again.
pub fn note(cache: &Path, purl: &str, version: &str, doc: &serde_json::Value) {
    note_at(cache, purl, version, doc, now());
}

fn note_at(cache: &Path, purl: &str, version: &str, doc: &serde_json::Value, at: u64) {
    let found = read_doc(purl, doc);
    let latest = cached(cache, purl, version).and_then(|c| c.latest).filter(|_| found.is_some());
    let c = Cached { checked: at, yanked: found.as_ref().is_some_and(|f| f.1), message: found.map(|f| f.0), repo: repository(purl, doc), repo_read: true, latest };
    if let Ok(bytes) = serde_json::to_vec(&c) {
        let _ = util::write_atomic(&path(cache, purl, version), &bytes);
    }
}

fn cached(cache: &Path, purl: &str, version: &str) -> Option<Cached> {
    serde_json::from_slice(&std::fs::read(path(cache, purl, version)).ok()?).ok()
}

/// The installed versions of each public direct dependency (never one `privacy` keeps private): the lockfile's pinned versions, else the locked headline
/// version. A declared range alone (no lockfile) installs no known version and is not asked.
pub fn installed(st: &Stack) -> Vec<(String, String, String)> {
    let mut out = vec![];
    for (purl, d) in &st.deps {
        if !d.public_candidate || !(purl.starts_with("pkg:npm/") || purl.starts_with("pkg:pypi/")) {
            continue;
        }
        let mut versions: BTreeSet<String> = d.pins.iter().map(|p| p.version.clone()).collect();
        if versions.is_empty()
            && let Some(v) = &d.version
            && d.readings.iter().any(|r| r.range.is_none() && !r.standalone)
        {
            versions.insert(v.to_string());
        }
        for v in versions {
            out.push((purl.clone(), d.name.clone(), v));
        }
    }
    out
}

/// Reads the registry for every installed version whose cached answer is missing or older than a day. Returns how
/// many were asked.
pub fn refresh(cache: &Path, st: &Stack) -> usize {
    if crate::privacy::registry_off() {
        return 0;
    }
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(8))).build().into();
    let fetch = |url: &str| -> Option<serde_json::Value> {
        let mut r = agent.get(url).call().ok().filter(|r| r.status().is_success())?;
        let bytes = r.body_mut().with_config().limit(4 * 1024 * 1024).read_to_vec().ok()?;
        serde_json::from_slice(&bytes).ok()
    };
    refresh_with(cache, st, now(), fetch)
}

/// `refresh` with the clock and the reader given (tests).
pub fn refresh_with(cache: &Path, st: &Stack, at: u64, fetch: impl Fn(&str) -> Option<serde_json::Value> + Sync) -> usize {
    let due: Vec<(String, String)> = installed(st)
        .into_iter()
        .filter(|(purl, _, v)| cached(cache, purl, v).is_none_or(|c| !c.repo_read || at.saturating_sub(c.checked) >= FRESH_SECS))
        .map(|(purl, _, v)| (purl, v))
        .collect();
    let mut asked = 0;
    util::concurrent(&due, util::REQUESTS_AT_ONCE, |(purl, v)| version_url(purl, v).and_then(|u| fetch(&u)), |i, doc| {
        asked += 1;
        if let Some(doc) = doc {
            let (purl, v) = &due[i];
            note_at(cache, purl, v, &doc, at);
        }
        true
    });
    // A deprecated or yanked version: the newest release, once per answer (a renamed or retired package's newest is
    // deprecated too; a retired major's is the line to move to).
    let retired: Vec<(String, String)> = installed(st)
        .into_iter()
        .filter(|(purl, _, v)| cached(cache, purl, v).is_some_and(|c| c.message.is_some() && c.latest.is_none()))
        .map(|(purl, _, v)| (purl, v))
        .collect();
    util::concurrent(&retired, util::REQUESTS_AT_ONCE, |(purl, _)| latest_url(purl).and_then(|u| fetch(&u)), |i, doc| {
        asked += 1;
        let (purl, v) = &retired[i];
        if let (Some(l), Some(mut c)) = (doc.and_then(|d| read_latest(purl, &d)), cached(cache, purl, v)) {
            c.latest = Some(l);
            if let Ok(bytes) = serde_json::to_vec(&c) {
                let _ = util::write_atomic(&path(cache, purl, v), &bytes);
            }
        }
        true
    });
    asked
}

/// The installed versions of direct dependencies their publisher deprecated or yanked, from the cache alone, by
/// package name then version.
pub fn notices(cache: &Path, st: &Stack) -> Vec<Notice> {
    let mut out: Vec<Notice> = installed(st)
        .into_iter()
        .filter_map(|(purl, name, version)| {
            let c = cached(cache, &purl, &version)?;
            let message = c.message?;
            Some(Notice { url: page(&purl, &name, &version), purl, name, version, message, yanked: c.yanked, latest: c.latest })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.version.cmp(&b.version)));
    out
}

/// One line per notice, the registry's words quoted (control characters blanked, at most 300 characters).
pub fn line(n: &Notice) -> String {
    let words: String = n.message.chars().map(|c| if c.is_control() { ' ' } else { c }).take(300).collect();
    let what = match (n.yanked, words.is_empty()) {
        (true, true) => "yanked by its publisher".to_string(),
        (true, false) => format!("yanked by its publisher: \"{words}\""),
        (false, true) => "deprecated by its publisher".to_string(),
        (false, false) => format!("deprecated by its publisher: \"{words}\""),
    };
    format!("{} {} {what} ({})", n.name, n.version, n.url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stack::{Dep, Pin, Reading};

    fn stack(deps: &[(&str, &str, Option<&str>)]) -> Stack {
        let mut st = Stack { packages: vec![], deps: Default::default(), node: None, node_by_lock: Default::default(), python: None, notes: vec![], unreadable: 0, stub_runtimes: Default::default(), spread: 0, standalone: vec![], registries: Default::default(), fixture_registries: Default::default(), peers: vec![], unlocked: vec![] };
        for (purl, name, pin) in deps {
            let mut d = Dep::new(name, true);
            if let Some(v) = pin {
                d.pins.push(Pin { version: v.to_string(), hashes: vec!["sha512-x".into()] });
            }
            st.deps.insert(purl.to_string(), d);
        }
        st
    }

    #[test]
    fn npm_deprecated_and_pypi_yanked_versions_are_read_and_others_are_not() {
        assert_eq!(read_doc("pkg:npm/tslint", &serde_json::json!({"deprecated": "TSLint has been deprecated in favor of ESLint."})), Some(("TSLint has been deprecated in favor of ESLint.".into(), false)));
        assert_eq!(read_doc("pkg:npm/x", &serde_json::json!({"deprecated": ""})), None, "npm un-deprecates with an empty message");
        assert_eq!(read_doc("pkg:npm/x", &serde_json::json!({"deprecated": true})), Some((String::new(), false)));
        assert_eq!(read_doc("pkg:npm/x", &serde_json::json!({"name": "x"})), None);
        assert_eq!(read_doc("pkg:pypi/x", &serde_json::json!({"info": {"yanked": true, "yanked_reason": "broken wheel"}})), Some(("broken wheel".into(), true)));
        assert_eq!(read_doc("pkg:pypi/x", &serde_json::json!({"info": {"yanked": false, "yanked_reason": null}})), None);
        assert_eq!(version_url("pkg:npm/%40fastify/static", "9.1.3").unwrap(), "https://registry.npmjs.org/%40fastify%2Fstatic/9.1.3");
        assert_eq!(version_url("pkg:pypi/pydantic-ai-slim", "2.31.0").unwrap(), "https://pypi.org/pypi/pydantic-ai-slim/2.31.0/json");
    }

    #[test]
    fn the_source_repository_is_read_as_osv_names_it() {
        let npm = |r: serde_json::Value| repository("pkg:npm/x", &serde_json::json!({ "repository": r }));
        assert_eq!(npm(serde_json::json!({"type": "git", "url": "git+https://github.com/pillarjs/multiparty.git"})).as_deref(), Some("https://github.com/pillarjs/multiparty"));
        assert_eq!(npm(serde_json::json!({"url": "git+ssh://git@github.com/nodejs/undici.git", "directory": "packages/x"})).as_deref(), Some("https://github.com/nodejs/undici"));
        assert_eq!(npm(serde_json::json!("isomorphic-git/isomorphic-git")).as_deref(), Some("https://github.com/isomorphic-git/isomorphic-git"));
        assert_eq!(npm(serde_json::json!("https://example.com/x.git")), None, "no known code host");
        let py = serde_json::json!({"info": {"project_urls": {"Documentation": "https://docs.x.io", "Source": "https://github.com/encode/starlette/tree/main"}}});
        assert_eq!(repository("pkg:pypi/starlette", &py).as_deref(), Some("https://github.com/encode/starlette"));
    }

    #[test]
    fn installed_versions_are_asked_once_a_day_and_only_the_cache_is_read_for_output() {
        let cache = tempfile::tempdir().unwrap();
        let mut st = stack(&[("pkg:npm/lodash.isequal", "lodash.isequal", Some("4.5.0")), ("pkg:npm/react", "react", Some("19.2.0")), ("pkg:pypi/requests", "requests", Some("2.32.0")), ("pkg:npm/unpinned", "unpinned", None)]);
        // A manifest range alone installs no known version: not asked.
        st.deps.get_mut("pkg:npm/unpinned").unwrap().readings.push(Reading { dir: ".".into(), version: semver::Version::new(1, 0, 0), source: "package.json".into(), standalone: false, range: Some(crate::stack::Range::Npm("^1".into())), lock: None });
        let asked = std::sync::Mutex::new(vec![]);
        let fetch = |url: &str| {
            asked.lock().unwrap().push(url.to_string());
            Some(if url.ends_with("/latest") {
                serde_json::json!({"version": "4.5.0", "deprecated": "This package is deprecated."})
            } else if url.ends_with("/pypi/requests/json") {
                serde_json::json!({"info": {"version": "2.32.3", "yanked": false}})
            } else if url.contains("lodash.isequal") { serde_json::json!({"deprecated": "This package is deprecated. Use require('node:util').isDeepStrictEqual instead."}) } else if url.contains("requests") { serde_json::json!({"info": {"yanked": true, "yanked_reason": "CVE fix regressed"}}) } else { serde_json::json!({}) })
        };
        assert_eq!(notices(cache.path(), &st), vec![], "nothing cached: nothing said");
        // Three versions, then the newest release of each of the two retired ones.
        assert_eq!(refresh_with(cache.path(), &st, 1_000_000, fetch), 5);
        let n = notices(cache.path(), &st);
        assert_eq!(n.iter().map(|n| n.latest.clone()).collect::<Vec<_>>(), vec![Some(("4.5.0".into(), true)), Some(("2.32.3".into(), false))], "a whole package retired; a yanked release with a newer one");
        assert_eq!(n.iter().map(line).collect::<Vec<_>>(), vec![
            "lodash.isequal 4.5.0 deprecated by its publisher: \"This package is deprecated. Use require('node:util').isDeepStrictEqual instead.\" (https://www.npmjs.com/package/lodash.isequal/v/4.5.0)".to_string(),
            "requests 2.32.0 yanked by its publisher: \"CVE fix regressed\" (https://pypi.org/project/requests/2.32.0/)".to_string(),
        ]);
        // Fresh: not asked again within the day; asked again after it.
        assert_eq!(refresh_with(cache.path(), &st, 1_000_000 + 3600, fetch), 0);
        assert_eq!(refresh_with(cache.path(), &st, 1_000_000 + FRESH_SECS, fetch), 3);
        // A registry that cannot be read keeps the answer it had.
        assert_eq!(refresh_with(cache.path(), &st, 1_000_000 + 3 * FRESH_SECS, |_| None), 3);
        assert_eq!(notices(cache.path(), &st).len(), 2);
        assert!(asked.lock().unwrap().iter().all(|u| !u.contains("unpinned")));
    }
}
