//! `unstale sync`: root, then only the stack's technology indexes, then their shards, verified, then the index
//! swapped in.
//!
//! The catalog is a local directory (a path or `file://` URL) or an `http(s)://` base URL. Over HTTP the
//! per-technology indexes are polled with conditional requests (`If-None-Match` / `If-Modified-Since` from the
//! last 200), a 404 on an index means "not covered", and shards get the same size and sha256 checks as files.
//!
//! With a catalog key (compiled into release builds, or `UNSTALE_CATALOG_KEY`), an HTTP catalog's root and every
//! index it serves must carry a valid Ed25519 signature (`<file>.sig`, hex). The indexes name each shard's sha256, so
//! signed indexes cover the whole catalog: whoever controls the host but not the key cannot change what reaches an
//! agent. A local directory is the user's own and is not checked.
//!
//! The catalog's list of technologies (`v1/technologies.json`, signed like an index) names every index it has, with a
//! hash of its bytes: only candidates on it are asked for, and not those whose cached index has that hash, so neither
//! a candidate the catalog does not cover nor an unchanged index costs a request (on the hosted catalog a 404, or a
//! file the Worker serves, spends the Worker's daily allowance, the free plan's scarcest). Without the list (an older
//! export), or when it cannot be read or verified, every candidate's index is asked for, as before.

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use unstale_schema::catalog::{CATALOG_SCHEMA, Root, TechIndex, Technologies};

use crate::cache::{self, index_path, parse_shard, shard_path, verify_shard};
use crate::util::{normalize_purl, parse_version, sha256_hex, write_atomic};

/// The catalog refused as a whole: newer schema or a newer minimum client. The cache is left as it was.
#[derive(Debug)]
pub struct Incompatible(pub String);

impl std::fmt::Display for Incompatible {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Incompatible {}

/// Largest body read over HTTP (an index or a shard). Shards are at most a few hundred kilobytes; this only bounds a bad
/// server, across all the requests a sync has in flight at once.
const MAX_BODY: u64 = 8 * 1024 * 1024;

/// Where the catalog is read from.
pub enum Source {
    /// A directory holding `v1/root.json`.
    Dir(PathBuf),
    /// A base URL without a trailing slash; `{base}/v1/root.json` is the root.
    Http { base: String, agent: ureq::Agent },
}

/// The result of one fetch.
enum Got {
    Body(Vec<u8>, Validators),
    NotModified,
    NotFound,
}

/// What a conditional request sends back, kept from the last 200 of a technology's index. Used only when the
/// URL and the cached index bytes are the ones it was stored with.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
struct Validators {
    url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_modified: Option<String>,
    /// sha256 of the index bytes these validators describe.
    #[serde(default)]
    sha256: String,
    /// sha256 of the catalog key the bytes were verified with (the technologies list only), so a copy kept before
    /// signing was required or under another key is fetched and verified again rather than reused on a 304.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key: Option<String>,
}

/// Per-request timeout in seconds: `UNSTALE_HTTP_TIMEOUT`, default 30.
fn http_timeout() -> Duration {
    let secs = std::env::var("UNSTALE_HTTP_TIMEOUT").ok().and_then(|s| s.trim().parse::<u64>().ok()).filter(|&n| n > 0).unwrap_or(30);
    Duration::from_secs(secs)
}

/// Where the catalog is read from: a local directory (a path or `file://` URL) or an `http(s)://` base URL. A
/// location ending in `/v1` is taken as the catalog's `v1/` directory. Over HTTP nothing is fetched here.
pub fn resolve_source(loc: &str) -> Result<Source> {
    let loc = loc.trim();
    let lower = loc.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        let mut base = loc.trim_end_matches('/').to_string();
        if base.ends_with("/v1") {
            base.truncate(base.len() - 3);
        }
        let host = base.split_once("://").map(|(_, r)| r.split(['/', '?', '#']).next().unwrap_or("")).unwrap_or("");
        if host.is_empty() || base.contains(['?', '#']) {
            bail!("catalog location {loc}: not a base URL (expected http(s)://host/path, no query or fragment)");
        }
        return Ok(http_source(base, http_timeout()));
    }
    let p = match loc.strip_prefix("file://") {
        Some(rest) => PathBuf::from(rest.replace("%20", " ")),
        None => PathBuf::from(loc),
    };
    if p.join("v1/root.json").is_file() {
        return Ok(Source::Dir(p));
    }
    if p.file_name().is_some_and(|n| n == "v1") && p.join("root.json").is_file() {
        return Ok(Source::Dir(p.parent().unwrap_or(&p).to_path_buf()));
    }
    bail!("no catalog at {} (expected v1/root.json there)", p.display())
}

fn http_source(base: String, t: Duration) -> Source {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(t.min(Duration::from_secs(10))))
        .timeout_global(Some(t))
        .user_agent(concat!("unstale/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    Source::Http { base, agent }
}

impl Source {
    fn describe(&self, rel: &str) -> String {
        match self {
            Source::Dir(base) => base.join(rel).display().to_string(),
            Source::Http { base, .. } => format!("{base}/{rel}"),
        }
    }

    /// Fetch `rel` (relative to the catalog base, e.g. `v1/tech/next.json`). `cond` makes an HTTP request
    /// conditional; a directory ignores it.
    fn get(&self, rel: &str, cond: Option<&Validators>) -> Result<Got> {
        match self {
            Source::Dir(base) => {
                let p = base.join(rel);
                match std::fs::read(&p) {
                    Ok(b) => Ok(Got::Body(b, Validators::default())),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Got::NotFound),
                    Err(e) => Err(anyhow!("reading {}: {e}", p.display())),
                }
            }
            Source::Http { agent, .. } => {
                let url = self.describe(rel);
                let mut req = agent.get(&url);
                if let Some(v) = cond.filter(|v| v.url == url) {
                    if let Some(e) = &v.etag {
                        req = req.header("If-None-Match", e);
                    }
                    if let Some(m) = &v.last_modified {
                        req = req.header("If-Modified-Since", m);
                    }
                }
                let mut resp = req.call().map_err(|e| anyhow!("GET {url}: {e}"))?;
                let status = resp.status().as_u16();
                match status {
                    200 => {
                        let header = |n: &str| resp.headers().get(n).and_then(|v| v.to_str().ok()).map(String::from);
                        let (etag, last_modified) = (header("etag"), header("last-modified"));
                        let bytes = resp
                            .body_mut()
                            .with_config()
                            .limit(MAX_BODY)
                            .read_to_vec()
                            .map_err(|e| anyhow!("GET {url}: reading the body: {e}"))?;
                        Ok(Got::Body(bytes, Validators { url, etag, last_modified, sha256: String::new(), key: None }))
                    }
                    304 if cond.is_some() => Ok(Got::NotModified),
                    404 | 410 => Ok(Got::NotFound),
                    _ => bail!("GET {url}: HTTP {status}"),
                }
            }
        }
    }
}

fn validators_path(cache_dir: &Path, tech: &str) -> PathBuf {
    cache_dir.join("v1/http").join(format!("{tech}.json"))
}

const TECHNOLOGIES: &str = "v1/technologies.json";
/// The list's validators: outside `v1/http/`, whose names are technology ids.
fn technologies_validators_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join("v1/technologies.http.json")
}

/// The technologies the catalog has an index for, each with the first 16 hex digits of its index's sha256, or None when
/// it publishes no list (or it cannot be read or does not verify): then every candidate is asked for. Conditional over
/// HTTP, the cached copy reused on a 304.
fn listed_technologies(src: &Source, cache_dir: &Path, key: Option<&[u8; 32]>) -> Option<BTreeMap<String, String>> {
    let cached_path = cache_dir.join(TECHNOLOGIES);
    let cached = std::fs::read(&cached_path).ok();
    let key_id = key.map(|k| sha256_hex(k));
    let cond: Option<Validators> = std::fs::read(technologies_validators_path(cache_dir))
        .ok()
        .and_then(|b| serde_json::from_slice::<Validators>(&b).ok())
        .filter(|v| cached.as_deref().is_some_and(|c| sha256_hex(c) == v.sha256) && (key_id.is_none() || v.key == key_id));
    let (bytes, fresh) = match src.get(TECHNOLOGIES, cond.as_ref()).ok()? {
        Got::Body(b, v) => {
            if let Some(key) = key {
                verify_signed(src, TECHNOLOGIES, &b, key).ok()?;
            }
            (b, Some(v))
        }
        Got::NotModified => (cached?, None),
        Got::NotFound => {
            let _ = std::fs::remove_file(&cached_path);
            return None;
        }
    };
    let list: Technologies = serde_json::from_slice(&bytes).ok()?;
    if list.schema > CATALOG_SCHEMA {
        return None;
    }
    if let Some(mut v) = fresh.filter(|v| v.etag.is_some() || v.last_modified.is_some()) {
        v.sha256 = sha256_hex(&bytes);
        v.key = key_id;
        if write_atomic(&cached_path, &bytes).is_ok() {
            let _ = serde_json::to_vec(&v).map_err(anyhow::Error::from).and_then(|b| write_atomic(&technologies_validators_path(cache_dir), &b));
        }
    }
    Some(list.technologies)
}

/// Check a root against this client. The message names what to do.
pub fn check_root(root: &Root) -> std::result::Result<(), Incompatible> {
    let ours = env!("CARGO_PKG_VERSION");
    if root.schema > CATALOG_SCHEMA {
        return Err(Incompatible(format!(
            "the catalog uses schema {} and this unstale ({ours}) reads schema {CATALOG_SCHEMA}: upgrade unstale (cargo install --path local/cli, or your package manager); the cached catalog is kept and still used",
            root.schema
        )));
    }
    match (parse_version(&root.min_client), parse_version(ours)) {
        (Some(min), Some(me)) if min > me => Err(Incompatible(format!(
            "the catalog needs unstale {} or newer and this is {ours}: upgrade unstale; the cached catalog is kept and still used",
            root.min_client
        ))),
        (None, _) => Err(Incompatible(format!("the catalog's min_client `{}` is not a version; the cached catalog is kept", root.min_client))),
        _ => Ok(()),
    }
}

/// A published shard path as a path relative to the catalog base: `v1/shards/…` as is, `shards/…` under `v1/`.
fn published(path: &str) -> Result<String> {
    let rel = Path::new(path.trim_start_matches('/'));
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        bail!("shard path {path} is not a plain relative path");
    }
    let rel = rel.to_string_lossy().replace('\\', "/");
    Ok(if rel.starts_with("v1/") { rel } else { format!("v1/{rel}") })
}

#[derive(Debug, Default)]
pub struct TechSync {
    pub technology: String,
    pub records: usize,
    pub checked: String,
    pub downloaded: usize,
    pub reused: usize,
    pub unchanged: bool,
}

#[derive(Debug, Default)]
pub struct Report {
    pub synced: Vec<TechSync>,
    /// No index for this candidate: the technology is not covered.
    pub not_covered: Vec<String>,
    /// An index exists but none of its records names a package this repository uses.
    pub not_in_stack: Vec<String>,
    pub failed: Vec<(String, String)>,
}

/// Sync the candidates' indexes and shards into `cache`. `purls` are the repository's package URLs; a
/// technology is kept only when one of its records' release components is among them (no alias table).
pub fn sync(loc: &str, cache_dir: &Path, candidates: &BTreeSet<String>, purls: &BTreeSet<String>) -> Result<Report> {
    sync_reporting(loc, cache_dir, candidates, purls, |_| {})
}

/// `sync`, calling `progress` with each candidate once it is settled (synced, not covered or failed).
pub fn sync_reporting(loc: &str, cache_dir: &Path, candidates: &BTreeSet<String>, purls: &BTreeSet<String>, progress: impl FnMut(&str)) -> Result<Report> {
    let src = resolve_source(loc)?;
    let key = match src {
        Source::Http { .. } => catalog_key()?,
        Source::Dir(_) => None,
    };
    sync_with(&src, cache_dir, candidates, purls, key.as_ref(), progress)
}

/// The catalog key compiled into release builds. A `#[used]` static keeps it whole in the binary, which release.yml
/// checks: read in place, an x86-64 build splits a short constant into instruction immediates.
#[used]
static CATALOG_KEY: Option<&str> = option_env!("UNSTALE_CATALOG_KEY");

/// The catalog's Ed25519 public key (hex): `UNSTALE_CATALOG_KEY`, else the one compiled into release builds.
fn catalog_key() -> Result<Option<[u8; 32]>> {
    let Some(hex) = std::env::var("UNSTALE_CATALOG_KEY")
        .ok()
        .or_else(|| CATALOG_KEY.map(String::from))
        .filter(|s| !s.trim().is_empty())
    else {
        return Ok(None);
    };
    let bytes = from_hex(hex.trim()).filter(|b| b.len() == 32).ok_or_else(|| anyhow!("UNSTALE_CATALOG_KEY is not a 32-byte hex Ed25519 public key"))?;
    Ok(Some(bytes.try_into().unwrap()))
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

/// `rel`'s bytes against the signature published beside it (`<rel>.sig`, hex).
fn verify_signed(src: &Source, rel: &str, bytes: &[u8], key: &[u8; 32]) -> Result<()> {
    let sig_rel = format!("{rel}.sig");
    let sig = match src.get(&sig_rel, None)? {
        Got::Body(b, _) => b,
        _ => bail!("{} is not signed ({} not found)", src.describe(rel), src.describe(&sig_rel)),
    };
    let sig = std::str::from_utf8(&sig).ok().and_then(|s| from_hex(s.trim())).ok_or_else(|| anyhow!("{}: not a hex signature", src.describe(&sig_rel)))?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(bytes, &sig)
        .map_err(|_| anyhow!("{}: the signature does not verify against the catalog key; nothing from it was used", src.describe(rel)))
}

fn sync_with(src: &Source, cache_dir: &Path, candidates: &BTreeSet<String>, purls: &BTreeSet<String>, key: Option<&[u8; 32]>, mut progress: impl FnMut(&str)) -> Result<Report> {
    let root_bytes = match src.get("v1/root.json", None)? {
        Got::Body(b, _) => b,
        _ => bail!("no catalog at {} (v1/root.json not found)", src.describe("v1/root.json")),
    };
    if let Some(key) = key {
        verify_signed(src, "v1/root.json", &root_bytes, key)?;
    }
    let root: Root = serde_json::from_slice(&root_bytes).context("root.json does not parse")?;
    check_root(&root)?;
    write_atomic(&cache_dir.join("v1/root.json"), &root_bytes)?;

    let techs: Vec<&String> = candidates.iter().filter(|t| !t.is_empty() && !t.contains(['/', '\\', '?', '#', '%']) && !t.starts_with('.')).collect();
    // A name that cannot be a technology id is settled at once: no request, nothing covered.
    for t in candidates.iter().filter(|t| !techs.contains(t)) {
        progress(t);
    }
    // Candidates the catalog's list does not name are not covered: settled without a request.
    let listed = match src {
        Source::Http { .. } => listed_technologies(src, cache_dir, key),
        Source::Dir(_) => None,
    };
    // Each technology's files are its own, so indexes are fetched at once; the report keeps candidate order.
    let mut outcomes: Vec<Option<Outcome>> = techs.iter().map(|_| None).collect();
    crate::util::concurrent(&techs, crate::util::REQUESTS_AT_ONCE, |tech| {
        let hash = match &listed {
            Some(l) => match l.get(*tech) {
                Some(h) => Some(h.as_str()),
                None => return Outcome::NotCovered,
            },
            None => None,
        };
        sync_one(src, cache_dir, tech, purls, key, hash)
    }, |i, outcome| {
        outcomes[i] = Some(outcome);
        progress(techs[i]);
        true
    });
    let mut rep = Report::default();
    for (tech, outcome) in techs.into_iter().zip(outcomes) {
        match outcome {
            Some(Outcome::Synced(t)) => rep.synced.push(t),
            Some(Outcome::NotCovered) => rep.not_covered.push(tech.clone()),
            Some(Outcome::NotInStack) => rep.not_in_stack.push(tech.clone()),
            Some(Outcome::Failed(e)) => rep.failed.push((tech.clone(), e)),
            None => rep.failed.push((tech.clone(), "not checked".into())),
        }
    }
    Ok(rep)
}

enum Outcome {
    Synced(TechSync),
    NotCovered,
    NotInStack,
    Failed(String),
}

/// One technology: its index (conditionally; not at all when `listed`, the hash the catalog's list gives it, is the
/// cached index's), then its shards, swapped into the cache.
fn sync_one(src: &Source, cache_dir: &Path, tech: &str, purls: &BTreeSet<String>, key: Option<&[u8; 32]>, listed: Option<&str>) -> Outcome {
    let rel = format!("v1/tech/{tech}.json");
    // A conditional request only when the cached index is the one the validators were stored with.
    let cached = std::fs::read(index_path(cache_dir, tech)).ok();
    // The cached index is the listed one: as a 304, without asking (it was verified when it arrived).
    if let (Some(c), Some(h)) = (&cached, listed)
        && h.len() == 16
        && sha256_hex(c).starts_with(h)
    {
        return match sync_tech(src, cache_dir, tech, c, purls) {
            Ok(Some(t)) => Outcome::Synced(t),
            Ok(None) => Outcome::NotInStack,
            Err(e) => Outcome::Failed(format!("{e:#}")),
        };
    }
    let cond: Option<Validators> = std::fs::read(validators_path(cache_dir, tech))
        .ok()
        .and_then(|b| serde_json::from_slice::<Validators>(&b).ok())
        .filter(|v| cached.as_deref().is_some_and(|c| sha256_hex(c) == v.sha256));
    let (bytes, fresh_validators) = match src.get(&rel, cond.as_ref()) {
        Ok(Got::Body(b, v)) => {
            // A 304 reuses the cached index, verified when it arrived.
            if let Some(key) = key
                && let Err(e) = verify_signed(src, &rel, &b, key)
            {
                return Outcome::Failed(format!("{e:#}"));
            }
            (b, Some(v))
        }
        Ok(Got::NotModified) => match cached {
            Some(c) => (c, None),
            None => return Outcome::Failed(format!("{}: not modified, but no cached copy", src.describe(&rel))),
        },
        Ok(Got::NotFound) => return Outcome::NotCovered,
        Err(e) => return Outcome::Failed(format!("{e:#}")),
    };
    match sync_tech(src, cache_dir, tech, &bytes, purls) {
        Ok(Some(t)) => {
            // Validators are stored after the swap, describing the index now in the cache.
            if let Some(mut v) = fresh_validators {
                let vp = validators_path(cache_dir, tech);
                if v.etag.is_some() || v.last_modified.is_some() {
                    v.sha256 = sha256_hex(&bytes);
                    let stored = serde_json::to_vec(&v).map_err(anyhow::Error::from).and_then(|b| write_atomic(&vp, &b));
                    if let Err(e) = stored {
                        return Outcome::Failed(format!("{e:#}"));
                    }
                } else {
                    let _ = std::fs::remove_file(vp);
                }
            }
            Outcome::Synced(t)
        }
        Ok(None) => Outcome::NotInStack,
        Err(e) => Outcome::Failed(format!("{e:#}")),
    }
}

fn sync_tech(src: &Source, cache_dir: &Path, tech: &str, index_bytes: &[u8], purls: &BTreeSet<String>) -> Result<Option<TechSync>> {
    let index: TechIndex = serde_json::from_slice(index_bytes).context("index does not parse")?;
    if index.schema > CATALOG_SCHEMA {
        bail!("index schema {} is newer than this unstale reads ({CATALOG_SCHEMA}); upgrade unstale; cached copy kept", index.schema);
    }
    if index.technology != tech {
        bail!("index names technology `{}`", index.technology);
    }
    let unchanged = std::fs::read(index_path(cache_dir, tech)).is_ok_and(|old| old == index_bytes);
    // Download and verify every shard before anything is written.
    let mut fresh = vec![];
    let (mut reused, mut records, mut components) = (0, 0, BTreeSet::new());
    for s in &index.shards {
        let dest = shard_path(cache_dir, tech, s);
        let bytes = match std::fs::read(&dest) {
            Ok(b) if verify_shard(s, &b).is_ok() => {
                reused += 1;
                b
            }
            _ => {
                let rel = published(&s.path)?;
                let b = match src.get(&rel, None).with_context(|| format!("shard {}", s.path))? {
                    Got::Body(b, _) => b,
                    _ => bail!("shard {} missing ({} not found)", s.path, src.describe(&rel)),
                };
                verify_shard(s, &b)?;
                fresh.push((dest, b.clone()));
                b
            }
        };
        let (recs, _, _, _) = parse_shard(&bytes).with_context(|| format!("shard {}", s.path))?;
        records += recs.len();
        for r in &recs {
            for rel in &r.r.releases {
                components.insert(normalize_purl(&rel.component));
            }
        }
    }
    // Public registry-derived index identity also recognizes a valid empty catalog.
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(index_bytes)
        && let Some(names) = value.get("components").and_then(|v| v.as_array()) {
        for name in names.iter().filter_map(|v| v.as_str()) { components.insert(normalize_purl(name)); }
    }
    if !components.iter().any(|c| purls.contains(c)) {
        return Ok(None);
    }
    for (dest, b) in &fresh {
        write_atomic(dest, b)?;
    }
    // The swap: the index is replaced only after every shard it names is in place.
    write_atomic(&index_path(cache_dir, tech), index_bytes)?;
    // Shards no longer named by the index are removed (they are immutable and content-named).
    let keep: BTreeSet<String> = index.shards.iter().map(|s| cache::shard_file_name(&s.path)).collect();
    if let Ok(rd) = std::fs::read_dir(cache_dir.join("v1/shards").join(tech)) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !keep.contains(&name) && !name.starts_with('.') {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(Some(TechSync { technology: tech.into(), records, checked: index.checked.clone(), downloaded: fresh.len(), reused, unchanged }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testcat::{FixtureCatalog, rec};

    fn purls(p: &[&str]) -> BTreeSet<String> {
        p.iter().map(|s| s.to_string()).collect()
    }
    fn cands(p: &[&str]) -> BTreeSet<String> {
        p.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn public_identity_metadata_recognizes_a_valid_empty_catalog() {
        let cat = FixtureCatalog::new();
        cat.tech("example", &[]);
        let path = std::path::Path::new(cat.loc()).join("v1/tech/example.json");
        let mut index: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        index["components"] = serde_json::json!(["pkg:npm/example"]);
        std::fs::write(&path, index.to_string()).unwrap();
        let cache = tempfile::tempdir().unwrap();
        let result = sync(cat.loc(),cache.path(),&cands(&["example"]),&purls(&["pkg:npm/example"])).unwrap();
        assert_eq!(result.synced.len(),1);
        assert_eq!(result.synced[0].records,0);
        assert!(cache::load_tech(cache.path(),"example").unwrap().is_some());
    }

    #[test]
    fn syncs_only_stack_technologies_and_reports_uncovered() {
        let cat = FixtureCatalog::new();
        cat.tech("next", &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1")])]);
        cat.tech("prisma", &[("7", vec![rec("prisma:a", "pkg:npm/prisma", "7.0.0")])]);
        let cache = tempfile::tempdir().unwrap();
        let rep = sync(cat.loc(), cache.path(), &cands(&["next", "react"]), &purls(&["pkg:npm/next"])).unwrap();
        assert_eq!(rep.synced.len(), 1);
        assert_eq!(rep.synced[0].technology, "next");
        assert_eq!(rep.not_covered, vec!["react".to_string()]);
        assert!(index_path(cache.path(), "next").is_file());
        assert!(!index_path(cache.path(), "prisma").exists(), "prisma was not asked for");
        let loaded = cache::load_tech(cache.path(), "next").unwrap().unwrap();
        assert_eq!(loaded.records.len(), 1);
        // file:// URLs work too, and a second sync reuses the shard.
        let rep = sync(&format!("file://{}", cat.loc()), cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap();
        assert_eq!((rep.synced[0].downloaded, rep.synced[0].reused, rep.synced[0].unchanged), (0, 1, true));
    }

    #[test]
    fn index_not_naming_a_stack_package_is_not_in_stack() {
        let cat = FixtureCatalog::new();
        cat.tech("core", &[("1", vec![rec("core:a", "pkg:npm/core-js", "1.0.0")])]);
        let cache = tempfile::tempdir().unwrap();
        let rep = sync(cat.loc(), cache.path(), &cands(&["core"]), &purls(&["pkg:npm/%40nestjs/core"])).unwrap();
        assert_eq!(rep.not_in_stack, vec!["core".to_string()]);
        assert!(!index_path(cache.path(), "core").exists());
    }

    #[test]
    fn corrupted_or_resized_shard_is_refused_and_cache_kept() {
        let cat = FixtureCatalog::new();
        cat.tech("next", &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1")])]);
        let cache = tempfile::tempdir().unwrap();
        sync(cat.loc(), cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap();
        let before = std::fs::read(index_path(cache.path(), "next")).unwrap();
        // Publish a new version, then corrupt its shard after the index was written.
        let shard = cat.tech("next", &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1"), rec("next:b", "pkg:npm/next", "16.0.2")])]);
        let mut bytes = std::fs::read(&shard[0]).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(&shard[0], &bytes).unwrap();
        let rep = sync(cat.loc(), cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap();
        assert_eq!(rep.failed.len(), 1);
        assert!(rep.failed[0].1.contains("sha256"), "{}", rep.failed[0].1);
        assert_eq!(std::fs::read(index_path(cache.path(), "next")).unwrap(), before, "old index kept");
        assert_eq!(cache::load_tech(cache.path(), "next").unwrap().unwrap().records.len(), 1);
        // A size mismatch is caught by the byte count.
        bytes.push(0);
        std::fs::write(&shard[0], &bytes).unwrap();
        let rep = sync(cat.loc(), cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap();
        assert!(rep.failed[0].1.contains("bytes"), "{}", rep.failed[0].1);
    }

    #[test]
    fn incompatible_root_fails_safely() {
        let cat = FixtureCatalog::new();
        cat.tech("next", &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1")])]);
        let cache = tempfile::tempdir().unwrap();
        sync(cat.loc(), cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap();
        let idx = std::fs::read(index_path(cache.path(), "next")).unwrap();
        for root in [r#"{"schema":2,"min_client":"0.0.1"}"#, r#"{"schema":1,"min_client":"99.0.0"}"#] {
            cat.root(root);
            let err = sync(cat.loc(), cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap_err();
            assert!(err.downcast_ref::<Incompatible>().is_some(), "{err:#}");
            assert!(format!("{err}").contains("upgrade unstale"));
            assert_eq!(std::fs::read(index_path(cache.path(), "next")).unwrap(), idx, "cache untouched");
            let cached_root = std::fs::read_to_string(cache.path().join("v1/root.json")).unwrap();
            assert!(cached_root.contains("\"schema\":1") && !cached_root.contains("99.0.0"));
        }
    }

    #[test]
    fn newer_index_schema_is_refused_for_that_technology() {
        let cat = FixtureCatalog::new();
        cat.tech("next", &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1")])]);
        let p = cat.dir.path().join("v1/tech/next.json");
        let text = std::fs::read_to_string(&p).unwrap().replace("\"schema\":1", "\"schema\":2");
        std::fs::write(&p, text).unwrap();
        let cache = tempfile::tempdir().unwrap();
        let rep = sync(cat.loc(), cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap();
        assert!(rep.failed[0].1.contains("newer"));
        assert!(!index_path(cache.path(), "next").exists());
    }

    /// A minimal HTTP/1.1 file server for the tests: serves `dir` on 127.0.0.1, sends an ETag (sha256 of the
    /// body) or a fixed Last-Modified, answers conditional requests with 304, a missing file with 404, and
    /// `/500/…` paths with 500. Every request is logged as "path status".
    struct TestServer {
        base: String,
        log: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl TestServer {
        fn start(dir: PathBuf, last_modified_only: bool) -> TestServer {
            use std::io::{BufRead, BufReader, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let log = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
            let log2 = log.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() {
                        continue;
                    }
                    let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let (mut inm, mut ims) = (None, None);
                    loop {
                        let mut h = String::new();
                        if reader.read_line(&mut h).unwrap_or(0) == 0 || h.trim().is_empty() {
                            break;
                        }
                        let (k, v) = h.split_once(':').unwrap_or((&h, ""));
                        match k.trim().to_ascii_lowercase().as_str() {
                            "if-none-match" => inm = Some(v.trim().to_string()),
                            "if-modified-since" => ims = Some(v.trim().to_string()),
                            _ => {}
                        }
                    }
                    const LM: &str = "Wed, 15 Oct 2026 00:00:00 GMT";
                    let file = dir.join(path.trim_start_matches('/'));
                    let (status, headers, body) = if path.starts_with("/500/") {
                        (500, String::new(), vec![])
                    } else {
                        match std::fs::read(&file) {
                            Err(_) => (404, String::new(), vec![]),
                            Ok(b) => {
                                let etag = format!("\"{}\"", &sha256_hex(&b)[..16]);
                                if last_modified_only {
                                    if ims.as_deref() == Some(LM) { (304, String::new(), vec![]) } else { (200, format!("Last-Modified: {LM}\r\n"), b) }
                                } else if inm.as_deref() == Some(etag.as_str()) {
                                    (304, format!("ETag: {etag}\r\n"), vec![])
                                } else {
                                    (200, format!("ETag: {etag}\r\n"), b)
                                }
                            }
                        }
                    };
                    log2.lock().unwrap().push(format!("{path} {status}"));
                    let head = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n", body.len());
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&body);
                }
            });
            TestServer { base, log }
        }

        fn take_log(&self) -> Vec<String> {
            std::mem::take(&mut *self.log.lock().unwrap())
        }
    }

    #[test]
    fn http_catalog_syncs_with_conditional_requests_and_404_is_not_covered() {
        let cat = FixtureCatalog::new();
        cat.tech("next", &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1")])]);
        let srv = TestServer::start(cat.dir.path().to_path_buf(), false);
        let cache = tempfile::tempdir().unwrap();
        let rep = sync(&format!("{}/v1/", srv.base), cache.path(), &cands(&["next", "react"]), &purls(&["pkg:npm/next"])).unwrap();
        assert_eq!((rep.synced.len(), rep.synced[0].downloaded), (1, 1));
        assert_eq!(rep.not_covered, vec!["react".to_string()]);
        assert_eq!(cache::load_tech(cache.path(), "next").unwrap().unwrap().records.len(), 1);
        let log = srv.take_log();
        assert!(log.contains(&"/v1/tech/next.json 200".to_string()) && log.contains(&"/v1/tech/react.json 404".to_string()), "{log:?}");
        // Second sync: the index is not modified (304 on If-None-Match) and no shard is requested.
        let rep = sync(&srv.base, cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap();
        assert_eq!((rep.synced[0].downloaded, rep.synced[0].reused, rep.synced[0].unchanged), (0, 1, true));
        assert_eq!(srv.take_log(), vec!["/v1/root.json 200".to_string(), "/v1/technologies.json 404".to_string(), "/v1/tech/next.json 304".to_string()]);
        // A new version is fetched in full (200) and only its new shard is downloaded.
        cat.tech("next", &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1")]), ("15", vec![rec("next:b", "pkg:npm/next", "15.0.1")])]);
        let rep = sync(&srv.base, cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap();
        assert_eq!((rep.synced[0].downloaded, rep.synced[0].reused, rep.synced[0].unchanged), (1, 1, false));
        assert!(srv.take_log().contains(&"/v1/tech/next.json 200".to_string()));
    }

    #[test]
    fn a_catalogs_list_of_technologies_spares_the_request_for_every_candidate_it_does_not_name() {
        use ring::signature::{Ed25519KeyPair, KeyPair};
        let cat = FixtureCatalog::new();
        cat.tech("next", &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1")])]);
        let list = cat.dir.path().join("v1/technologies.json");
        let listing = |techs: &[&str]| {
            let entries: Vec<String> = techs.iter().map(|t| format!("\"{t}\":\"{}\"", &sha256_hex(&std::fs::read(cat.dir.path().join(format!("v1/tech/{t}.json"))).unwrap())[..16])).collect();
            std::fs::write(&list, format!("{{\"schema\":1,\"technologies\":{{{}}}}}", entries.join(","))).unwrap();
        };
        listing(&["next"]);
        let srv = TestServer::start(cat.dir.path().to_path_buf(), false);
        let cache = tempfile::tempdir().unwrap();
        let all = cands(&["next", "react", "types", "vite"]);
        let rep = sync_with(&resolve_source(&srv.base).unwrap(), cache.path(), &all, &purls(&["pkg:npm/next"]), None, |_| {}).unwrap();
        assert_eq!((rep.synced.len(), rep.not_covered.len()), (1, 3));
        let log = srv.take_log();
        let asked: Vec<&str> = log.iter().map(String::as_str).filter(|l| !l.starts_with("/v1/shards/")).collect();
        assert_eq!(asked, vec!["/v1/root.json 200", "/v1/technologies.json 200", "/v1/tech/next.json 200"]);
        // Again: the list is not modified and names the cached index's hash, so neither it nor any uncovered
        // candidate is asked for.
        let rep = sync_with(&resolve_source(&srv.base).unwrap(), cache.path(), &all, &purls(&["pkg:npm/next"]), None, |_| {}).unwrap();
        assert_eq!((rep.synced.len(), rep.synced[0].unchanged), (1, true));
        assert_eq!(srv.take_log(), vec!["/v1/root.json 200", "/v1/technologies.json 304"]);
        // A technology the list starts to name, and an index whose hash changed, are asked for at the next sync.
        cat.tech("react", &[("19", vec![rec("react:a", "pkg:npm/react", "19.0.0")])]);
        cat.tech("next", &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1")]), ("15", vec![rec("next:b", "pkg:npm/next", "15.0.1")])]);
        listing(&["next", "react"]);
        let rep = sync_with(&resolve_source(&srv.base).unwrap(), cache.path(), &all, &purls(&["pkg:npm/next", "pkg:npm/react"]), None, |_| {}).unwrap();
        assert_eq!((rep.synced.len(), rep.not_covered), (2, vec!["types".to_string(), "vite".to_string()]));
        let log = srv.take_log();
        assert!(log.contains(&"/v1/tech/react.json 200".to_string()) && log.contains(&"/v1/tech/next.json 200".to_string()), "{log:?}");
        // With a catalog key, a list that is not signed is not trusted: every candidate is asked for, as without one.
        let pair = Ed25519KeyPair::from_seed_unchecked(&[7u8; 32]).unwrap();
        let key: [u8; 32] = pair.public_key().as_ref().try_into().unwrap();
        for rel in ["v1/root.json", "v1/tech/next.json", "v1/tech/react.json"] {
            let sig: String = pair.sign(&std::fs::read(cat.dir.path().join(rel)).unwrap()).as_ref().iter().map(|x| format!("{x:02x}")).collect();
            std::fs::write(cat.dir.path().join(format!("{rel}.sig")), sig).unwrap();
        }
        let other = tempfile::tempdir().unwrap();
        let _ = sync_with(&resolve_source(&srv.base).unwrap(), other.path(), &all, &purls(&["pkg:npm/next"]), Some(&key), |_| {});
        let log = srv.take_log();
        assert!(log.contains(&"/v1/technologies.json.sig 404".to_string()) && log.contains(&"/v1/tech/vite.json 404".to_string()), "{log:?}");
        // A list cached without a key is fetched and verified again once a key is required, not reused on a 304;
        // after that, the verified copy is.
        let sig: String = pair.sign(&std::fs::read(&list).unwrap()).as_ref().iter().map(|x| format!("{x:02x}")).collect();
        std::fs::write(cat.dir.path().join("v1/technologies.json.sig"), sig).unwrap();
        let _ = sync_with(&resolve_source(&srv.base).unwrap(), cache.path(), &all, &purls(&["pkg:npm/next"]), Some(&key), |_| {});
        let log = srv.take_log();
        assert!(log.contains(&"/v1/technologies.json 200".to_string()) && log.contains(&"/v1/technologies.json.sig 200".to_string()), "{log:?}");
        let _ = sync_with(&resolve_source(&srv.base).unwrap(), cache.path(), &all, &purls(&["pkg:npm/next"]), Some(&key), |_| {});
        assert!(srv.take_log().contains(&"/v1/technologies.json 304".to_string()));
    }

    #[test]
    fn with_a_catalog_key_only_signed_files_are_used() {
        use ring::signature::{Ed25519KeyPair, KeyPair};
        let pair = Ed25519KeyPair::from_seed_unchecked(&[7u8; 32]).unwrap();
        let key: [u8; 32] = pair.public_key().as_ref().try_into().unwrap();
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        let cat = FixtureCatalog::new();
        cat.tech("next", &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1")])]);
        cat.tech("prisma", &[("7", vec![rec("prisma:a", "pkg:npm/prisma", "7.0.0")])]);
        let sign = |rel: &str| {
            let p = cat.dir.path().join(rel);
            std::fs::write(p.with_extension("json.sig"), hex(pair.sign(&std::fs::read(&p).unwrap()).as_ref())).unwrap();
        };
        let srv = TestServer::start(cat.dir.path().to_path_buf(), false);
        let src = resolve_source(&srv.base).unwrap();
        let cache = tempfile::tempdir().unwrap();
        let all = purls(&["pkg:npm/next", "pkg:npm/prisma"]);
        // An unsigned root stops the sync before anything is cached.
        let err = sync_with(&src, cache.path(), &cands(&["next"]), &all, Some(&key), |_| {}).err().unwrap();
        assert!(format!("{err:#}").contains("is not signed"), "{err:#}");
        assert!(!cache.path().join("v1/root.json").exists());
        // Signed root and next; prisma's index altered after signing.
        sign("v1/root.json");
        sign("v1/tech/next.json");
        sign("v1/tech/prisma.json");
        let p = cat.dir.path().join("v1/tech/prisma.json");
        let mut forged = std::fs::read(&p).unwrap();
        forged.push(b'\n');
        std::fs::write(&p, forged).unwrap();
        let rep = sync_with(&src, cache.path(), &cands(&["next", "prisma"]), &all, Some(&key), |_| {}).unwrap();
        assert_eq!(rep.synced.iter().map(|t| t.technology.as_str()).collect::<Vec<_>>(), vec!["next"]);
        assert!(rep.failed.len() == 1 && rep.failed[0].1.contains("does not verify"), "{:?}", rep.failed);
        assert!(!index_path(cache.path(), "prisma").exists());
    }

    #[test]
    fn http_last_modified_alone_is_used_for_conditional_requests() {
        let cat = FixtureCatalog::new();
        cat.tech("next", &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1")])]);
        let srv = TestServer::start(cat.dir.path().to_path_buf(), true);
        let cache = tempfile::tempdir().unwrap();
        sync(&srv.base, cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap();
        srv.take_log();
        let rep = sync(&srv.base, cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap();
        assert!(rep.synced[0].unchanged);
        assert!(srv.take_log().contains(&"/v1/tech/next.json 304".to_string()));
        // Validators describe the cached index: replace it (another catalog synced into the cache) and the request
        // is unconditional again.
        std::fs::write(index_path(cache.path(), "next"), b"{}").unwrap();
        sync(&srv.base, cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap();
        assert!(srv.take_log().contains(&"/v1/tech/next.json 200".to_string()));
    }

    #[test]
    fn http_corrupted_shard_is_refused_and_cache_kept() {
        let cat = FixtureCatalog::new();
        cat.tech("next", &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1")])]);
        let srv = TestServer::start(cat.dir.path().to_path_buf(), false);
        let cache = tempfile::tempdir().unwrap();
        sync(&srv.base, cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap();
        let before = std::fs::read(index_path(cache.path(), "next")).unwrap();
        let shard = cat.tech("next", &[("16", vec![rec("next:a", "pkg:npm/next", "16.0.1"), rec("next:b", "pkg:npm/next", "16.0.2")])]);
        let mut bytes = std::fs::read(&shard[0]).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(&shard[0], &bytes).unwrap();
        let rep = sync(&srv.base, cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap();
        assert!(rep.failed[0].1.contains("sha256"), "{:?}", rep.failed);
        assert_eq!(std::fs::read(index_path(cache.path(), "next")).unwrap(), before, "old index kept");
        // A shard named by the index but missing on the server (404).
        std::fs::remove_file(&shard[0]).unwrap();
        let rep = sync(&srv.base, cache.path(), &cands(&["next"]), &purls(&["pkg:npm/next"])).unwrap();
        assert!(rep.failed[0].1.contains("missing"), "{:?}", rep.failed);
        assert_eq!(std::fs::read(index_path(cache.path(), "next")).unwrap(), before, "old index kept");
    }

    #[test]
    fn http_errors_are_clear() {
        let cat = FixtureCatalog::new();
        let srv = TestServer::start(cat.dir.path().to_path_buf(), false);
        let cache = tempfile::tempdir().unwrap();
        // No root at the base: a 404 on root.json.
        let err = sync(&format!("{}/nothing", srv.base), cache.path(), &cands(&["next"]), &purls(&[])).unwrap_err();
        assert!(format!("{err:#}").contains("no catalog at") && format!("{err:#}").contains("/nothing/v1/root.json"), "{err:#}");
        // A server error is an error, not "not covered".
        let err = sync(&format!("{}/500", srv.base), cache.path(), &cands(&["next"]), &purls(&[])).unwrap_err();
        assert!(format!("{err:#}").contains("HTTP 500"), "{err:#}");
        // Nothing listening: a connection error names the URL.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let err = sync(&format!("http://127.0.0.1:{port}"), cache.path(), &cands(&["next"]), &purls(&[])).unwrap_err();
        assert!(format!("{err:#}").contains(&format!("GET http://127.0.0.1:{port}/v1/root.json")), "{err:#}");
    }

    #[test]
    fn http_timeout_is_an_error() {
        // Accepts connections and never answers.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let _held: Vec<_> = listener.incoming().take(4).collect();
            std::thread::sleep(Duration::from_secs(30));
        });
        let cache = tempfile::tempdir().unwrap();
        let t0 = std::time::Instant::now();
        let src = http_source(base, Duration::from_millis(500));
        let err = sync_with(&src, cache.path(), &cands(&["next"]), &purls(&[]), None, |_| {}).err().unwrap();
        assert!(t0.elapsed() < Duration::from_secs(10));
        assert!(format!("{err:#}").to_lowercase().contains("timeout") || format!("{err:#}").to_lowercase().contains("timed out"), "{err:#}");
    }

    #[test]
    fn http_newer_root_is_incompatible() {
        let cat = FixtureCatalog::new();
        cat.root(r#"{"schema":2,"min_client":"0.0.1"}"#);
        let srv = TestServer::start(cat.dir.path().to_path_buf(), false);
        let cache = tempfile::tempdir().unwrap();
        let err = sync(&srv.base, cache.path(), &cands(&["next"]), &purls(&[])).unwrap_err();
        assert!(err.downcast_ref::<Incompatible>().is_some(), "{err:#}");
    }

    #[test]
    fn http_locations_parse() {
        assert!(matches!(resolve_source("https://example.org/catalog/v1/").unwrap(), Source::Http { base, .. } if base == "https://example.org/catalog"));
        assert!(matches!(resolve_source(" HTTP://h:8080 ").unwrap(), Source::Http { base, .. } if base == "HTTP://h:8080"));
        assert!(resolve_source("https:///x").is_err());
        assert!(resolve_source("https://h/x?y=1").is_err());
    }
}
