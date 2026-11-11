//! Bounded disk use for the per-user cache: delete what is free to fetch again, keep what cost tokens.
//!
//! - **Superseded shards** are deleted by the sync that replaces their index (`sync::sync_tech`).
//! - **A technology's catalog files** (`v1/tech/<t>.json`, `v1/http/<t>.json`, `v1/shards/<t>/`, `v1/events/<t>/`): each
//!   sync records, per technology, when a repository on this machine last needed it (`needed.json`, with the set each
//!   repository's last sync needed). A technology no repository's last sync needs is deleted 30 days after it was last
//!   needed, or first when the cache is over its limit. The index goes first, so a clean stopped partway leaves a
//!   technology that reads as never synced (the next sync fetches it again), never an index naming a missing shard.
//! - **Registry metadata** (`registry/`, `npm-releases/`, `pypi-releases/`, `pypi-requires/`), kept per package under
//!   hashed names: each file is rewritten whenever a repository needs it and it is older than its refresh period (a day
//!   to 30 days), so one not written for 30 days is unused, and stale anyway: deleted. Over the limit, oldest first.
//! - **Model results** (`inference/results/`, `inference/records/`) cost tokens: never deleted for the limit; only once
//!   unused for a year (a result that old is for a release outside the window the steps read, a technology's records
//!   once no repository has needed it for a year), or by `unstale cache clean`.
//! - Never touched: the usage ledger and the worker lock (`inference/`), uninstall backups (`uninstalled/`), and files
//!   this module does not know.
//!
//! Deletion runs at the end of a sync, at most once a day, never at session start's quick stage, and never fails a
//! command: an error is kept in `cache-clean.json` and shown by `unstale status` with the cache's size.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// A technology or registry file unused this long is deleted.
pub const UNUSED_DAYS: u64 = 30;
/// A model result unused this long is deleted.
pub const RESULTS_DAYS: u64 = 365;
/// The cache's size limit on disk, in MB, unless `UNSTALE_CACHE_MAX_MB` sets another (0: none).
pub const DEFAULT_LIMIT_MB: u64 = 100;
/// The clean-up runs at most this often (seconds).
const EVERY: u64 = 86_400;
const DAY: u64 = 86_400;
/// Directories of registry metadata, each file free to fetch again.
const REGISTRY: &[&str] = &["registry", "npm-releases", "pypi-releases", "pypi-requires"];

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The limit in bytes: `UNSTALE_CACHE_MAX_MB`, else [`DEFAULT_LIMIT_MB`]; `None` for no limit.
pub fn limit() -> Option<u64> {
    let mb = std::env::var("UNSTALE_CACHE_MAX_MB")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_LIMIT_MB);
    (mb > 0).then_some(mb * 1_000_000)
}

/// What each repository's last sync needed, and when each technology was last needed (`{cache}/needed.json`). Local
/// only.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Needed {
    /// By a hash of the repository's root: its root, and its last sync.
    #[serde(default)]
    pub repos: BTreeMap<String, RepoNeed>,
    /// Technology → when a repository on this machine last needed it (Unix seconds).
    #[serde(default)]
    pub technologies: BTreeMap<String, u64>,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RepoNeed {
    pub root: String,
    pub at: u64,
    pub technologies: BTreeSet<String>,
}

fn needed_path(cache: &Path) -> PathBuf {
    cache.join("needed.json")
}

fn state_path(cache: &Path) -> PathBuf {
    cache.join("cache-clean.json")
}

impl Needed {
    pub fn load(cache: &Path) -> Needed {
        std::fs::read(needed_path(cache))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// The technologies some repository's last sync needs (a repository no longer set up on disk counts for nothing).
    fn in_use(&self) -> BTreeSet<String> {
        self.repos
            .values()
            .filter(|r| Path::new(&r.root).join(".unstale/config.json").is_file())
            .flat_map(|r| r.technologies.iter().cloned())
            .collect()
    }
}

/// The last clean-up: when, the cache's size on disk after it, and what went wrong, if anything.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Cleaned {
    pub at: u64,
    pub bytes: u64,
    pub removed: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn last(cache: &Path) -> Option<Cleaned> {
    serde_json::from_slice(&std::fs::read(state_path(cache)).ok()?).ok()
}

/// What a sync's repository needs: every technology it synced, and every one it tried to (a failure is still a need).
pub fn needs(rep: &crate::sync::Report) -> BTreeSet<String> {
    rep.synced
        .iter()
        .map(|t| t.technology.clone())
        .chain(rep.failed.iter().map(|(t, _)| t.clone()))
        .collect()
}

/// After a sync for the repository at `root`: records what it needed, then cleans up when a day has passed since the
/// last time. Never fails and prints nothing; with the edge-inference switch off, does nothing.
pub fn after_sync(cache: &Path, root: &Path, techs: &BTreeSet<String>) {
    if !crate::util::edge_inference() {
        return;
    }
    let at = now();
    let _ = record(cache, root, techs, at);
    if last(cache).is_some_and(|c| at.saturating_sub(c.at) < EVERY && c.error.is_none()) {
        return;
    }
    let outcome = clean(cache, techs, at, limit(), false);
    let _ = write_state(cache, &outcome);
}

fn write_state(cache: &Path, c: &Cleaned) -> anyhow::Result<()> {
    crate::util::write_atomic(&state_path(cache), &serde_json::to_vec(c)?)
}

/// Notes that the repository at `root` needed `techs` at `at`.
pub fn record(cache: &Path, root: &Path, techs: &BTreeSet<String>, at: u64) -> anyhow::Result<()> {
    let mut n = Needed::load(cache);
    let key = crate::util::sha256_hex(root.to_string_lossy().as_bytes())[..16].to_string();
    n.repos.insert(
        key,
        RepoNeed {
            root: root.to_string_lossy().to_string(),
            at,
            technologies: techs.clone(),
        },
    );
    for t in techs {
        n.technologies.insert(t.clone(), at);
    }
    crate::util::write_atomic(&needed_path(cache), &serde_json::to_vec(&n)?)
}

/// Size on disk: allocated blocks where the platform says, else the length.
fn disk(m: &std::fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        m.blocks() * 512
    }
    #[cfg(not(unix))]
    {
        m.len()
    }
}

fn mtime(m: &std::fs::Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Every file under `dir`, with its size on disk and time written.
fn files(dir: &Path, out: &mut Vec<(PathBuf, u64, u64)>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let Ok(m) = std::fs::symlink_metadata(e.path()) else {
            continue;
        };
        if m.is_dir() {
            files(&e.path(), out);
        } else if m.is_file() {
            out.push((e.path(), disk(&m), mtime(&m)));
        }
    }
}

/// One technology's catalog files, in the order they are deleted: the index first.
fn tech_paths(cache: &Path, t: &str) -> Vec<PathBuf> {
    vec![
        crate::cache::index_path(cache, t),
        cache.join("v1/http").join(format!("{t}.json")),
        cache.join("v1/shards").join(t),
        cache.join("v1/events").join(t),
    ]
}

fn size(p: &Path) -> u64 {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => {
            let mut v = vec![];
            files(p, &mut v);
            v.iter().map(|f| f.1).sum()
        }
        Ok(m) => disk(&m),
        Err(_) => 0,
    }
}

fn remove(p: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(p),
        Ok(_) => std::fs::remove_file(p),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// What can be deleted, with when it was last used and its size.
enum Unit {
    Tech(String),
    File(PathBuf),
}

/// Cleans up the cache. `current`: the technologies the sync that runs it needs (never deleted here). `all`
/// (`unstale cache clean`): everything free to fetch again and every model result, whatever its age. Returns the size
/// on disk after it and what was removed; an error stops it where it is (what is left is a usable cache).
pub fn clean(
    cache: &Path,
    current: &BTreeSet<String>,
    at: u64,
    limit: Option<u64>,
    all: bool,
) -> Cleaned {
    let mut out = Cleaned {
        at,
        ..Default::default()
    };
    if let Err(e) = clean_inner(cache, current, at, limit, all, &mut out) {
        out.error = Some(crate::util::one_line(&format!("{e:#}"), 200));
    }
    out.bytes = size(cache);
    out
}

fn clean_inner(
    cache: &Path,
    current: &BTreeSet<String>,
    at: u64,
    limit: Option<u64>,
    all: bool,
    out: &mut Cleaned,
) -> anyhow::Result<()> {
    let needed = Needed::load(cache);
    let in_use = needed.in_use();
    // When a technology was last needed: the record, else when its index was last written (every sync writes it).
    let mut techs: BTreeMap<String, u64> = BTreeMap::new();
    for dir in ["v1/tech", "v1/http"] {
        if let Ok(rd) = std::fs::read_dir(cache.join(dir)) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if let Some(t) = name.strip_suffix(".json") {
                    techs.entry(t.to_string()).or_insert(0);
                }
            }
        }
    }
    for dir in ["v1/shards", "v1/events"] {
        if let Ok(rd) = std::fs::read_dir(cache.join(dir)) {
            for e in rd.flatten().filter(|e| e.path().is_dir()) {
                techs
                    .entry(e.file_name().to_string_lossy().to_string())
                    .or_insert(0);
            }
        }
    }
    for (t, last) in techs.iter_mut() {
        let written = std::fs::metadata(crate::cache::index_path(cache, t))
            .map(|m| mtime(&m))
            .unwrap_or(0);
        *last = needed
            .technologies
            .get(t)
            .copied()
            .unwrap_or(0)
            .max(written);
    }
    let take = |p: &Path, out: &mut Cleaned| -> anyhow::Result<()> {
        let s = size(p);
        remove(p).map_err(|e| anyhow::anyhow!("{}: {e}", p.display()))?;
        out.removed += s;
        Ok(())
    };
    let old = |last: u64, days: u64| at.saturating_sub(last) > days * DAY;
    // Model results: a year unused, or asked for.
    let mut results = vec![];
    files(&cache.join("inference/results"), &mut results);
    for (p, _, m) in &results {
        if all || old(*m, RESULTS_DAYS) {
            take(p, out)?;
        }
    }
    if let Ok(rd) = std::fs::read_dir(cache.join("inference/records")) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let t = name.strip_suffix(".json").unwrap_or(&name);
            let last = needed.technologies.get(t).copied().unwrap_or(0);
            let written = e.metadata().map(|m| mtime(&m)).unwrap_or(0);
            if all
                || (old(last, RESULTS_DAYS) && old(written, RESULTS_DAYS) && !current.contains(t))
            {
                take(&e.path(), out)?;
            }
        }
    }
    // Free to fetch again: unused for 30 days (a technology no repository's last sync needs; a registry file not written).
    let mut registry = vec![];
    for d in REGISTRY {
        files(&cache.join(d), &mut registry);
    }
    let mut kept: Vec<(u64, u64, Unit)> = vec![];
    for (t, last) in &techs {
        let free = all || (!in_use.contains(t) && !current.contains(t) && old(*last, UNUSED_DAYS));
        if free {
            for p in tech_paths(cache, t) {
                take(&p, out)?;
            }
        } else if !current.contains(t) {
            // Over the limit, technologies known to be needed by no repository go first; one this machine has no record
            // of (synced before records were kept) counts as needed, by when its index was last written.
            let known_left = needed.technologies.contains_key(t) && !in_use.contains(t);
            let rank = if known_left { 0 } else { 2 };
            kept.push((rank, *last, Unit::Tech(t.clone())));
        }
    }
    for (p, _, m) in registry {
        if all || old(m, UNUSED_DAYS) {
            take(&p, out)?;
        } else {
            kept.push((1, m, Unit::File(p)));
        }
    }
    let Some(limit) = limit else { return Ok(()) };
    let mut total = size(cache);
    if total <= limit {
        return Ok(());
    }
    kept.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    for (_, _, u) in kept {
        if total <= limit {
            break;
        }
        let paths = match &u {
            Unit::Tech(t) => tech_paths(cache, t),
            Unit::File(p) => vec![p.clone()],
        };
        for p in paths {
            let s = size(&p);
            take(&p, out)?;
            total = total.saturating_sub(s);
        }
    }
    Ok(())
}

/// `under 1 MB`, `1.2 MB`, `84 MB`.
fn mb(bytes: u64) -> String {
    let m = bytes as f64 / 1_000_000.0;
    if m < 1.0 {
        "under 1 MB".into()
    } else if m < 10.0 {
        format!("{m:.1} MB")
    } else {
        format!("{m:.0} MB")
    }
}

/// `unstale status`: the cache's size as of the last clean-up, against the limit; a warning when the clean-up failed.
/// Nothing with the switch off or before the first clean-up.
pub fn status_line(cache: &Path) -> Option<String> {
    if !crate::util::edge_inference() {
        return None;
    }
    let c = last(cache)?;
    if let Some(e) = &c.error {
        return Some(format!(
            "warning: the cache could not be cleaned up ({e}), so it may grow past its limit. Check the folder's permissions: {}",
            cache.display()
        ));
    }
    Some(match limit() {
        Some(l) => format!(
            "Cache: {} of {} (UNSTALE_CACHE_MAX_MB sets the limit)",
            mb(c.bytes),
            mb(l)
        ),
        None => format!("Cache: {} (no limit set)", mb(c.bytes)),
    })
}

/// `unstale cache clean`: everything free to fetch again and every model result; the usage ledger, the worker lock and
/// uninstall backups stay. One line.
pub fn clean_all(cache: &Path) -> String {
    let c = clean(cache, &BTreeSet::new(), now(), None, true);
    let _ = write_state(cache, &c);
    match &c.error {
        Some(e) => format!(
            "Removed {} from the cache, then stopped: {e}",
            mb(c.removed)
        ),
        None => format!(
            "Removed {} from the cache; the next sync fetches what this repository needs, and release notes are read again with your provider",
            mb(c.removed)
        ),
    }
}

#[cfg(test)]
mod tests;
