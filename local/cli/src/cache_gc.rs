//! Bounded disk use for the per-user cache: delete what is free to fetch again, keep what cost tokens.
//!
//! - **Superseded shards** are deleted by the sync that replaces their index (`sync::sync_tech`).
//! - **A technology's catalog files** (`v1/tech/<t>.json`, `v1/http/<t>.json`, `v1/shards/<t>/`, `v1/events/<t>/`): each
//!   sync records, per repository, the technologies it needed and when (`needed.json`). A technology is needed while
//!   some repository still set up on disk needed it in its last sync within 30 days; one with no record yet (synced
//!   before records were kept) starts its 30 days when first seen. Past that it is deleted, first when the cache is over
//!   its limit, else 30 days after it was last needed. The limit never takes a needed technology: when the cache cannot
//!   fit what is needed, `unstale status` says so. The index goes first, so a clean stopped partway leaves a technology
//!   that reads as never synced (the next sync fetches it again), never an index naming a missing shard.
//! - **Registry metadata** (`registry/`, `npm-releases/`, `pypi-releases/`, `pypi-requires/`), kept per package under
//!   hashed names: a file is rewritten whenever a repository needs it and it is past its refresh period (a day to 30
//!   days), and one only read (an advisory document) is marked when read ([`used`]), so a file untouched for 30 days is
//!   unused: deleted. Over the limit, oldest first.
//! - **Model results** (`inference/results/`, `inference/records/`) cost tokens: never deleted for the limit; a result
//!   once unread for a year (each read marks it), a technology's records once no repository has needed it for a year,
//!   or by `unstale cache clean --results`.
//! - Never touched: the usage ledger and the worker lock (`inference/`), uninstall backups (`uninstalled/`), anything
//!   reached through a symbolic link, anything outside the cache, and files written in the last few minutes (another
//!   process's sync may be between a shard and its index).
//!
//! Safety: a folder that does not look like unstale's cache (no marker file, and entries unstale does not write) is never
//! cleaned. An unreadable `needed.json` deletes nothing that run. Record and clean hold the cache's lock.
//!
//! Deletion runs at the end of a sync, at most once a day, within the sync's own time bound, never at session start's
//! quick stage, and never fails a command: it goes on past a file it cannot delete, keeps the first error in
//! `cache-clean.json`, and `unstale status` shows it with the cache's size.

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
/// A file written this recently is never deleted (seconds).
const FRESH: u64 = 600;
/// Directories of registry metadata, each file free to fetch again.
const REGISTRY: &[&str] = &["registry", "npm-releases", "pypi-releases", "pypi-requires"];
/// What unstale writes at the top of its cache; a folder holding anything else is not cleaned without the marker.
const KNOWN: &[&str] = &[
    "v1",
    "registry",
    "npm-releases",
    "pypi-releases",
    "pypi-requires",
    "inference",
    "uninstalled",
    "needed.json",
    "cache-clean.json",
    MARKER,
    LOCK,
];
const MARKER: &str = ".unstale-cache";
const LOCK: &str = ".clean.lock";

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Marks a cached file as used by a read (at most once a day), so the clean-up keeps what is read but not rewritten.
pub fn used(p: &Path) {
    let Ok(m) = std::fs::metadata(p) else { return };
    if now().saturating_sub(mtime(&m)) > DAY
        && let Ok(f) = std::fs::File::options().write(true).open(p)
    {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
}

/// The limit in bytes and, when `UNSTALE_CACHE_MAX_MB` cannot be read, the warning saying so (the default applies).
pub fn limit() -> (Option<u64>, Option<String>) {
    limit_from(std::env::var("UNSTALE_CACHE_MAX_MB").ok())
}

fn limit_from(v: Option<String>) -> (Option<u64>, Option<String>) {
    let (mb, warn) = match v {
        None => (DEFAULT_LIMIT_MB, None),
        Some(v) => match v.trim().parse::<u64>() {
            Ok(n) => (n, None),
            Err(_) => (
                DEFAULT_LIMIT_MB,
                Some(format!(
                    "warning: UNSTALE_CACHE_MAX_MB is not a whole number of MB, so the {DEFAULT_LIMIT_MB} MB default applies."
                )),
            ),
        },
    };
    ((mb > 0).then_some(mb * 1_000_000), warn)
}

/// What each repository's last sync needed, and when each technology was last needed or first seen
/// (`{cache}/needed.json`). Local only.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Needed {
    /// By a hash of the repository's root: its root, and its last sync.
    #[serde(default)]
    pub repos: BTreeMap<String, RepoNeed>,
    /// Technology → when a repository on this machine last needed it, or when the clean-up first saw it without a
    /// record (Unix seconds).
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
    /// The record: empty when there is none yet, an error when one is there but cannot be read.
    pub fn load(cache: &Path) -> anyhow::Result<Needed> {
        match std::fs::read(needed_path(cache)) {
            Ok(b) => serde_json::from_slice(&b)
                .map_err(|e| anyhow::anyhow!("needed.json cannot be read ({e})")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Needed::default()),
            Err(e) => Err(anyhow::anyhow!("needed.json cannot be read ({e})")),
        }
    }

    /// The technologies some repository still set up on disk needed in its last sync, within `days` of `at`.
    fn needed_within(&self, at: u64, days: u64) -> BTreeSet<String> {
        self.repos
            .values()
            .filter(|r| at.saturating_sub(r.at) <= days * DAY)
            .filter(|r| Path::new(&r.root).join(".unstale/config.json").is_file())
            .flat_map(|r| r.technologies.iter().cloned())
            .collect()
    }
}

/// The last clean-up: when, the cache's size on disk after it, what it removed, the first error, and the limit it
/// could not meet without deleting what is needed.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Cleaned {
    pub at: u64,
    pub bytes: u64,
    pub removed: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub over: Option<u64>,
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

/// The cache's lock, for recording and cleaning: `None` when another process holds it (or it cannot be taken).
fn lock(cache: &Path, wait: bool) -> Option<std::fs::File> {
    std::fs::create_dir_all(cache).ok()?;
    let f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(cache.join(LOCK))
        .ok()?;
    if wait {
        f.lock().ok()?
    } else {
        f.try_lock().ok()?
    }
    Some(f)
}

/// After a sync for the repository at `root`: records what it needed, then cleans up when a day has passed since the
/// last time, stopping when `stop` says the sync's time is up. Never fails and prints nothing; with the edge-inference
/// switch off, does nothing.
pub fn after_sync(cache: &Path, root: &Path, techs: &BTreeSet<String>, stop: &dyn Fn() -> bool) {
    if !crate::util::edge_inference() {
        return;
    }
    let at = now();
    let _ = record(cache, root, techs, at);
    if last(cache).is_some_and(|c| at.saturating_sub(c.at) < EVERY && c.error.is_none()) || stop() {
        return;
    }
    let Some(_l) = lock(cache, false) else { return };
    let plan = Plan {
        current: techs.clone(),
        at,
        limit: limit().0,
        results: false,
        all: false,
    };
    let outcome = clean(cache, &plan, stop);
    let _ = write_state(cache, &outcome);
}

fn write_state(cache: &Path, c: &Cleaned) -> anyhow::Result<()> {
    crate::util::write_atomic(&state_path(cache), &serde_json::to_vec(c)?)
}

/// Notes that the repository at `root` needed `techs` at `at`, under the cache's lock; marks a new cache folder as
/// unstale's. A record that cannot be read is started again: every technology's 30 days then run from now.
pub fn record(cache: &Path, root: &Path, techs: &BTreeSet<String>, at: u64) -> anyhow::Result<()> {
    let _l = lock(cache, true);
    let _ = owned(cache);
    let mut n = Needed::load(cache).unwrap_or_default();
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

/// Whether `cache` is unstale's: its marker, else only entries unstale writes (then the marker is written).
fn owned(cache: &Path) -> bool {
    if cache.join(MARKER).is_file() {
        return true;
    }
    let Ok(rd) = std::fs::read_dir(cache) else {
        return false;
    };
    let ours = rd
        .flatten()
        .all(|e| KNOWN.contains(&e.file_name().to_string_lossy().as_ref()));
    ours && std::fs::write(
        cache.join(MARKER),
        "unstale's cache: its clean-up deletes only files unstale wrote here\n",
    )
    .is_ok()
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

/// A real directory (not a symbolic link to one).
fn real_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
}

/// Every regular file under `dir`, with its size on disk and time written; symbolic links are never followed, at any
/// level, `dir` included.
fn files(dir: &Path, out: &mut Vec<(PathBuf, u64, u64)>) {
    if !real_dir(dir) {
        return;
    }
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

/// The names under a real directory (none through a symbolic link).
fn names(dir: &Path) -> Vec<String> {
    if !real_dir(dir) {
        return vec![];
    }
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default()
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

/// Size on disk and the newest write under `p` (nothing through a symbolic link).
fn measure(p: &Path) -> (u64, u64) {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => {
            let mut v = vec![];
            files(p, &mut v);
            (
                v.iter().map(|f| f.1).sum(),
                v.iter().map(|f| f.2).max().unwrap_or(0),
            )
        }
        Ok(m) if m.is_file() => (disk(&m), mtime(&m)),
        _ => (0, 0),
    }
}

/// A path the clean-up may delete: under the cache's real location, reached through no symbolic link, and not one
/// itself.
fn inside(root: &Path, p: &Path) -> bool {
    let Ok(rel) = p.strip_prefix(root) else {
        return false;
    };
    let mut at = root.to_path_buf();
    for c in rel.components() {
        if !matches!(c, std::path::Component::Normal(_)) {
            return false;
        }
        at.push(c);
        if std::fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink()) {
            return false;
        }
    }
    true
}

/// What a clean-up is asked to do.
pub struct Plan {
    /// The technologies the sync that runs it needs: never deleted here.
    pub current: BTreeSet<String>,
    pub at: u64,
    pub limit: Option<u64>,
    /// `unstale cache clean --results`: every model result too.
    pub results: bool,
    /// `unstale cache clean`: everything free to fetch again, whatever its age.
    pub all: bool,
}

/// A file or directory to delete, its size, and whether it holds model results.
#[derive(Debug, Clone)]
pub struct Victim {
    pub path: PathBuf,
    pub bytes: u64,
    pub paid: bool,
}

/// What a clean-up would delete, in order, and the limit it could not meet without deleting what is needed. An error,
/// and nothing to delete, when the folder is not unstale's or its record cannot be read.
pub fn victims(
    cache: &Path,
    plan: &Plan,
    stop: &dyn Fn() -> bool,
) -> anyhow::Result<(Vec<Victim>, Option<u64>)> {
    if !owned(cache) {
        anyhow::bail!(
            "{} holds files unstale did not write, so nothing in it is deleted",
            cache.display()
        );
    }
    let root = cache.canonicalize()?;
    let mut needed = Needed::load(&root)?;
    let at = plan.at;
    let old = |last: u64, days: u64| at.saturating_sub(last) > days * DAY;
    let push = |out: &mut Vec<Victim>, p: PathBuf, paid: bool| {
        let (bytes, written) = measure(&p);
        let present = std::fs::symlink_metadata(&p).is_ok();
        if present && at.saturating_sub(written) >= FRESH && inside(&root, &p) {
            out.push(Victim {
                path: p,
                bytes,
                paid,
            });
        }
    };
    let mut out: Vec<Victim> = vec![];
    // Model results: a year unread, or asked for.
    let mut results = vec![];
    files(&root.join("inference/results"), &mut results);
    for (p, _, m) in results {
        if plan.results || old(m, RESULTS_DAYS) {
            push(&mut out, p, true);
        }
    }
    for name in names(&root.join("inference/records")) {
        let t = name.strip_suffix(".json").unwrap_or(&name).to_string();
        let last = needed.technologies.get(&t).copied().unwrap_or(at);
        if plan.results || (old(last, RESULTS_DAYS) && !plan.current.contains(&t)) {
            push(&mut out, root.join("inference/records").join(&name), true);
        }
    }
    if stop() {
        return Ok((out, None));
    }
    // A technology's catalog files; one never recorded starts its clock now.
    let mut techs: BTreeSet<String> = BTreeSet::new();
    for dir in ["v1/tech", "v1/http"] {
        techs.extend(
            names(&root.join(dir))
                .into_iter()
                .filter_map(|n| n.strip_suffix(".json").map(String::from)),
        );
    }
    for dir in ["v1/shards", "v1/events"] {
        techs.extend(
            names(&root.join(dir))
                .into_iter()
                .filter(|n| real_dir(&root.join(dir).join(n))),
        );
    }
    let unseen: Vec<String> = techs
        .iter()
        .filter(|t| !needed.technologies.contains_key(*t))
        .cloned()
        .collect();
    if !unseen.is_empty() {
        for t in unseen {
            needed.technologies.insert(t, at);
        }
        crate::util::write_atomic(&needed_path(&root), &serde_json::to_vec(&needed)?)?;
    }
    let keep = needed.needed_within(at, UNUSED_DAYS);
    let mut later: Vec<(u8, u64, Vec<PathBuf>)> = vec![];
    for t in &techs {
        if plan.current.contains(t) || (!plan.all && keep.contains(t)) {
            continue;
        }
        let last = needed.technologies.get(t).copied().unwrap_or(at);
        if plan.all || old(last, UNUSED_DAYS) {
            for p in tech_paths(&root, t) {
                push(&mut out, p, false);
            }
        } else {
            later.push((0, last, tech_paths(&root, t)));
        }
    }
    let mut registry = vec![];
    for d in REGISTRY {
        files(&root.join(d), &mut registry);
    }
    for (p, _, m) in registry {
        if plan.all || old(m, UNUSED_DAYS) {
            push(&mut out, p, false);
        } else {
            later.push((1, m, vec![p]));
        }
    }
    let Some(limit) = plan.limit else {
        return Ok((out, None));
    };
    if stop() {
        return Ok((out, None));
    }
    // Over the limit: technologies no repository here needs first, then registry metadata, oldest first.
    let mut total = measure(&root)
        .0
        .saturating_sub(out.iter().map(|v| v.bytes).sum());
    later.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    for (_, _, paths) in later {
        if total <= limit {
            break;
        }
        for p in paths {
            let before = out.len();
            push(&mut out, p, false);
            if out.len() > before {
                total = total.saturating_sub(out[before].bytes);
            }
        }
    }
    Ok((out, (total > limit).then_some(limit)))
}

/// Deletes the victims in order, going on past one it cannot delete; the bytes removed and the first error.
fn delete(cache: &Path, victims: &[Victim], stop: &dyn Fn() -> bool) -> (u64, Option<String>) {
    let Ok(root) = cache.canonicalize() else {
        return (0, Some("the cache folder cannot be read".into()));
    };
    let (mut removed, mut first) = (0, None);
    for v in victims {
        if stop() {
            break;
        }
        // Checked again just before: nothing outside the cache, nothing through a link.
        if !inside(&root, &v.path) {
            continue;
        }
        let r = match std::fs::symlink_metadata(&v.path) {
            Ok(m) if m.is_dir() => std::fs::remove_dir_all(&v.path),
            Ok(_) => std::fs::remove_file(&v.path),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        };
        match r {
            Ok(()) => removed += v.bytes,
            Err(e) => {
                first.get_or_insert_with(|| {
                    crate::util::one_line(&format!("{}: {e}", v.path.display()), 200)
                });
            }
        }
    }
    (removed, first)
}

/// Plans and runs a clean-up; never fails (the first error is kept in the outcome).
pub fn clean(cache: &Path, plan: &Plan, stop: &dyn Fn() -> bool) -> Cleaned {
    let mut out = Cleaned {
        at: plan.at,
        ..Default::default()
    };
    match victims(cache, plan, stop) {
        Ok((v, over)) => {
            let (removed, error) = delete(cache, &v, stop);
            out.removed = removed;
            out.error = error;
            out.over = over;
        }
        Err(e) => out.error = Some(crate::util::one_line(&format!("{e:#}"), 200)),
    }
    out.bytes = measure(cache).0;
    out
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

/// `unstale status`: the cache's size as of the last clean-up against its limit, or a warning (its detail on the next
/// line) when the limit cannot be read, cannot be met without deleting what is needed, or the clean-up failed. Nothing
/// with the switch off or before the first clean-up.
pub fn status_lines(cache: &Path) -> Vec<String> {
    if !crate::util::edge_inference() {
        return vec![];
    }
    lines(cache, limit())
}

fn lines(cache: &Path, (l, bad): (Option<u64>, Option<String>)) -> Vec<String> {
    let mut out: Vec<String> = bad.into_iter().collect();
    let Some(c) = last(cache) else { return out };
    if let Some(over) = c.over {
        out.push(format!(
            "warning: the cache needs {}, over its {} limit; raise or remove it: UNSTALE_CACHE_MAX_MB",
            mb(c.bytes),
            mb(over)
        ));
    } else {
        out.push(match l {
            Some(l) => format!("Cache: {} of {}", mb(c.bytes), mb(l)),
            None => format!("Cache: {}", mb(c.bytes)),
        });
    }
    if let Some(e) = &c.error {
        out.push(
            "warning: the cache could not be fully cleaned up, so it may grow past its limit."
                .into(),
        );
        out.push(format!("  {e}"));
    }
    out
}

/// `unstale cache clean`: says what it will delete (and that model results are paid for again), asks (`ask`: `None`
/// without a terminal) unless `yes`, then deletes. Model results only with `results`. The exit code and the lines.
pub fn clean_command(
    cache: &Path,
    results: bool,
    yes: bool,
    ask: &mut dyn FnMut() -> Option<bool>,
) -> (u8, Vec<String>) {
    let plan = Plan {
        current: BTreeSet::new(),
        at: now(),
        limit: None,
        results,
        all: true,
    };
    let Some(_l) = lock(cache, true) else {
        return (
            1,
            vec!["Nothing removed: the cache's lock cannot be taken.".into()],
        );
    };
    let (v, _) = match victims(cache, &plan, &|| false) {
        Ok(v) => v,
        Err(e) => return (1, vec![format!("Nothing removed: {e:#}")]),
    };
    let free: u64 = v.iter().filter(|x| !x.paid).map(|x| x.bytes).sum();
    let paid: Vec<&Victim> = v.iter().filter(|x| x.paid).collect();
    let results_dir = cache
        .canonicalize()
        .unwrap_or_else(|_| cache.to_path_buf())
        .join("inference/results");
    let mut stored = vec![];
    files(&results_dir, &mut stored);
    let mut lines = vec![format!(
        "This removes {} the cache can fetch again.",
        mb(free)
    )];
    if results {
        lines.push(format!(
            "It also removes {} stored model results ({}): reading those release notes again is paid for again.",
            paid.iter().filter(|x| x.path.starts_with(&results_dir)).count(),
            mb(paid.iter().map(|x| x.bytes).sum())
        ));
    } else if !stored.is_empty() {
        lines.push(format!(
            "The {} stored model results stay (`--results` removes them too).",
            stored.len()
        ));
    }
    let go = if yes {
        true
    } else {
        match ask() {
            Some(answer) => answer,
            None => {
                lines.push("Run it again with --yes to remove them.".into());
                return (1, lines);
            }
        }
    };
    if !go {
        lines.push("Nothing removed.".into());
        return (0, lines);
    }
    let (removed, error) = delete(cache, &v, &|| false);
    let c = Cleaned {
        at: plan.at,
        bytes: measure(cache).0,
        removed,
        error: error.clone(),
        over: None,
    };
    let _ = write_state(cache, &c);
    lines.push(match error {
        Some(e) => format!(
            "Removed {}; some files could not be removed: {e}",
            mb(removed)
        ),
        None => format!("Removed {}.", mb(removed)),
    });
    (0, lines)
}

#[cfg(test)]
mod tests;
