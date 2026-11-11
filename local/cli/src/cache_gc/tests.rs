use super::*;
use crate::testcat::{FixtureCatalog, rec};

static NOW: std::sync::LazyLock<u64> = std::sync::LazyLock::new(now);

fn set(xs: &[&str]) -> BTreeSet<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

/// Ages every file under `p` (no link followed) to `days` before now.
fn age(p: &Path, days: u64) {
    let mut v = vec![];
    if real_dir(p) {
        files(p, &mut v);
    } else if p.is_file() {
        v.push((p.to_path_buf(), 0, 0));
    }
    let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(*NOW - days * DAY);
    for (f, _, _) in v {
        std::fs::File::options()
            .write(true)
            .open(&f)
            .unwrap()
            .set_modified(t)
            .unwrap();
    }
}

fn plan(current: &[&str], limit: Option<u64>) -> Plan {
    Plan {
        current: set(current),
        at: *NOW,
        limit,
        results: false,
        all: false,
    }
}

/// A cache synced from a catalog of `n` technologies (`t0`, `t1`, …), with registry metadata and model results beside
/// them, every file a day old (past the few minutes a fresh file is kept for).
fn cache_with(n: usize) -> (tempfile::TempDir, FixtureCatalog) {
    let cat = FixtureCatalog::new();
    let mut purls = BTreeSet::new();
    for i in 0..n {
        let t = format!("t{i}");
        let p = format!("pkg:npm/{t}");
        let recs = (0..40)
            .map(|k| rec(&format!("{t}:r{k}"), &p, &format!("1.{k}.0")))
            .collect();
        cat.tech(&t, &[("1", recs)]);
        purls.insert(p);
    }
    let cache = tempfile::tempdir().unwrap();
    let techs: BTreeSet<String> = (0..n).map(|i| format!("t{i}")).collect();
    let rep = crate::sync::sync(cat.loc(), cache.path(), &techs, &BTreeSet::new(), &purls).unwrap();
    assert_eq!(rep.synced.len(), n);
    for i in 0..30 {
        let p = cache
            .path()
            .join(format!("registry/deprecated/{i:032}.json"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, vec![b'x'; 3000]).unwrap();
    }
    for i in 0..5 {
        let p = cache
            .path()
            .join(format!("inference/results/ab/ab{i}.json"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, vec![b'r'; 2000]).unwrap();
    }
    std::fs::write(cache.path().join("inference/ledger.jsonl"), "{}\n").unwrap();
    std::fs::write(cache.path().join("inference/worker.lock"), "").unwrap();
    let records = cache.path().join("inference/records/t1.json");
    std::fs::create_dir_all(records.parent().unwrap()).unwrap();
    std::fs::write(&records, "{}").unwrap();
    age(cache.path(), 1);
    (cache, cat)
}

/// A repository set up on disk.
fn repo() -> tempfile::TempDir {
    let r = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(r.path().join(".unstale")).unwrap();
    std::fs::write(r.path().join(".unstale/config.json"), "{}").unwrap();
    r
}

/// Every file the cached index of `t` names, and the index.
fn named(cache: &Path, t: &str) -> Vec<PathBuf> {
    let idx: unstale_schema::catalog::TechIndex =
        serde_json::from_slice(&std::fs::read(crate::cache::index_path(cache, t)).unwrap())
            .unwrap();
    let mut v: Vec<PathBuf> = idx
        .shards
        .iter()
        .map(|s| crate::cache::shard_path(cache, t, s))
        .collect();
    v.push(crate::cache::index_path(cache, t));
    v
}

fn kept(cache: &Path, t: &str) -> bool {
    crate::cache::index_path(cache, t).is_file() && named(cache, t).iter().all(|p| p.is_file())
}

fn model_results(cache: &Path) -> Vec<PathBuf> {
    let mut v = vec![];
    files(&cache.join("inference"), &mut v);
    v.into_iter().map(|f| f.0).collect()
}

#[test]
fn a_cache_past_its_limit_shrinks_below_it_keeping_what_the_current_indexes_name_and_every_model_result()
 {
    let (cache, _cat) = cache_with(12);
    let c = cache.path();
    // t2..t11 were needed five days ago by a repository since removed from disk: no longer needed, not yet 30 days.
    let gone = tempfile::tempdir().unwrap();
    let others: Vec<String> = (2..12).map(|i| format!("t{i}")).collect();
    record(
        c,
        &gone.path().join("removed"),
        &others.iter().cloned().collect(),
        *NOW - 5 * DAY,
    )
    .unwrap();
    let before = measure(c).0;
    let paid = model_results(c);
    let limit = before / 2;
    let out = clean(c, &plan(&["t0", "t1"], Some(limit)), &|| false);
    assert_eq!((out.error.clone(), out.over), (None, None));
    assert!(
        out.bytes <= limit,
        "{} of {limit} (from {before})",
        out.bytes
    );
    assert!(kept(c, "t0") && kept(c, "t1"));
    assert!(crate::cache::load_catalog_tech(c, "t0").unwrap().is_some());
    assert!(paid.iter().all(|p| p.is_file()), "every model result kept");
    eprintln!(
        "disk: {before} bytes before, {} after, limit {limit}",
        out.bytes
    );
}

#[test]
fn two_repositories_never_evict_each_others_files_even_when_both_do_not_fit_the_limit() {
    let (cache, _cat) = cache_with(3);
    let c = cache.path();
    let (a, b) = (repo(), repo());
    record(c, a.path(), &set(&["t0"]), *NOW).unwrap();
    record(c, b.path(), &set(&["t1"]), *NOW - 3 * DAY).unwrap();
    // A real limit far below what the two need: what is not needed goes (t2, registry), theirs stays, status says so.
    let out = clean(c, &plan(&["t0"], Some(1_000)), &|| false);
    assert_eq!(out.error, None);
    assert!(
        kept(c, "t0") && kept(c, "t1"),
        "neither repository loses its files"
    );
    assert!(!crate::cache::index_path(c, "t2").exists());
    assert_eq!(out.over, Some(1_000));
    write_state(c, &out).unwrap();
    // b's own sync, the other way round.
    let out = clean(c, &plan(&["t1"], Some(1_000)), &|| false);
    assert!(kept(c, "t0") && kept(c, "t1"));
    assert!(out.over.is_some());
    // Once b is gone from disk, what only it needed goes when the limit asks.
    drop(b);
    clean(c, &plan(&["t0"], Some(1_000)), &|| false);
    assert!(!crate::cache::index_path(c, "t1").exists());
    assert!(kept(c, "t0"));
}

#[test]
fn over_the_limit_is_said_in_status_with_how_to_raise_or_remove_it() {
    let c = Cleaned {
        at: 1,
        bytes: 140_000_000,
        removed: 0,
        error: None,
        over: Some(100_000_000),
    };
    let dir = tempfile::tempdir().unwrap();
    write_state(dir.path(), &c).unwrap();
    let l = lines(dir.path(), limit_from(None));
    assert_eq!(
        l,
        [
            "warning: the cache needs 140 MB, over its 100 MB limit; raise or remove it: UNSTALE_CACHE_MAX_MB"
        ]
    );
    assert!(l[0].len() <= 100);
    write_state(
        dir.path(),
        &Cleaned {
            over: None,
            bytes: 84_000_000,
            error: Some("x: denied".into()),
            ..c
        },
    )
    .unwrap();
    assert_eq!(
        lines(dir.path(), limit_from(Some("abc".into()))),
        [
            "warning: UNSTALE_CACHE_MAX_MB is not a whole number of MB, so the 100 MB default applies.",
            "Cache                 84 MB of 100 MB",
            "warning: the cache could not be fully cleaned up, so it may grow past its limit.",
            "  x: denied",
        ]
    );
    assert_eq!(
        limit_from(Some("abc".into())).0,
        Some(DEFAULT_LIMIT_MB * 1_000_000)
    );
    assert!(
        limit_from(Some("abc".into()))
            .1
            .is_some_and(|w| w.starts_with("warning: UNSTALE_CACHE_MAX_MB"))
    );
    assert_eq!(limit_from(Some("0".into())), (None, None));
    assert_eq!(limit_from(None), (Some(100_000_000), None));
}

#[test]
fn a_symbolic_link_is_never_followed_at_any_level() {
    let (cache, _cat) = cache_with(1);
    let c = cache.path();
    let outside = tempfile::tempdir().unwrap();
    for name in ["registry", "inference/results"] {
        let target = outside.path().join(name.replace('/', "-"));
        std::fs::create_dir_all(target.join("sub")).unwrap();
        std::fs::write(target.join("sub/keep.json"), "x").unwrap();
        age(&target, 900);
        let link = c.join(name);
        std::fs::remove_dir_all(&link).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
    }
    // A technology folder that is a link, and a link inside the shards.
    let elsewhere = outside.path().join("shards");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::write(elsewhere.join("x.jsonl.gz"), "x").unwrap();
    std::os::unix::fs::symlink(&elsewhere, c.join("v1/shards/linked")).unwrap();
    let all = Plan {
        current: BTreeSet::new(),
        at: *NOW,
        limit: Some(0),
        results: true,
        all: true,
    };
    let out = clean(c, &all, &|| false);
    assert_eq!(out.error, None, "{out:?}");
    assert!(outside.path().join("registry/sub/keep.json").is_file());
    assert!(
        outside
            .path()
            .join("inference-results/sub/keep.json")
            .is_file()
    );
    assert!(elsewhere.join("x.jsonl.gz").is_file());
}

#[test]
fn without_a_readable_record_nothing_needed_is_lost() {
    let (cache, _cat) = cache_with(2);
    let c = cache.path();
    for t in ["t0", "t1"] {
        for p in tech_paths(c, t) {
            age(&p, 60);
        }
    }
    // No needed.json (the first run after an upgrade): every technology's 30 days start now.
    let out = clean(c, &plan(&[], None), &|| false);
    assert_eq!(out.error, None);
    assert!(kept(c, "t0") && kept(c, "t1"));
    // An unreadable one: nothing is deleted this run, and status has why.
    std::fs::write(needed_path(c), "{not json").unwrap();
    age(&c.join("registry"), 60);
    let out = clean(c, &plan(&[], Some(0)), &|| false);
    assert!(
        out.error
            .as_deref()
            .is_some_and(|e| e.contains("needed.json")),
        "{out:?}"
    );
    assert_eq!(out.removed, 0);
    assert!(kept(c, "t0") && c.join("registry/deprecated").read_dir().unwrap().count() == 30);
}

#[test]
fn one_file_that_cannot_be_deleted_stops_nothing_else_and_the_first_error_is_kept() {
    use std::os::unix::fs::PermissionsExt;
    let (cache, _cat) = cache_with(1);
    let c = cache.path();
    let stuck = c.join("registry/identity");
    std::fs::create_dir_all(&stuck).unwrap();
    std::fs::write(stuck.join("a.json"), "x").unwrap();
    age(&c.join("registry"), 40);
    std::fs::set_permissions(&stuck, std::fs::Permissions::from_mode(0o555)).unwrap();
    let out = clean(c, &plan(&["t0"], None), &|| false);
    std::fs::set_permissions(&stuck, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        out.error.as_deref().is_some_and(|e| e.contains("a.json")),
        "{out:?}"
    );
    assert_eq!(
        c.join("registry/deprecated").read_dir().unwrap().count(),
        0,
        "the rest went"
    );
}

#[test]
fn a_file_written_in_the_last_minutes_is_never_deleted() {
    let (cache, _cat) = cache_with(2);
    let c = cache.path();
    let gone = tempfile::tempdir().unwrap();
    record(c, &gone.path().join("x"), &set(&["t1"]), *NOW - 60 * DAY).unwrap();
    for p in tech_paths(c, "t1") {
        age(&p, 60);
    }
    // Another process's sync has just written a shard of t1, before its index.
    let shard = c.join("v1/shards/t1/new.jsonl.gz");
    std::fs::write(&shard, "x").unwrap();
    clean(c, &plan(&["t0"], None), &|| false);
    assert!(shard.is_file() && c.join("v1/shards/t1").is_dir());
    assert!(
        !crate::cache::index_path(c, "t1").exists(),
        "its old index went: the technology reads as never synced"
    );
}

#[test]
fn a_folder_that_is_not_unstales_is_never_cleaned() {
    let (cache, _cat) = cache_with(1);
    let c = cache.path();
    std::fs::remove_file(c.join(MARKER)).ok();
    std::fs::write(c.join("notes.txt"), "the user's").unwrap();
    age(&c.join("registry"), 60);
    let out = clean(c, &plan(&[], Some(0)), &|| false);
    assert!(
        out.error
            .as_deref()
            .is_some_and(|e| e.contains("did not write"))
    );
    assert_eq!(out.removed, 0);
    assert_eq!(
        c.join("registry/deprecated").read_dir().unwrap().count(),
        30
    );
}

#[test]
fn a_read_keeps_model_results_and_advisory_documents_past_their_age() {
    let (cache, _cat) = cache_with(1);
    let c = cache.path();
    let r = crate::pipeline::results::Results::at(c);
    // A result read today, written 400 days ago, stays; one never read again goes.
    let key = "k1";
    let e: crate::pipeline::results::Entry = serde_json::from_value(serde_json::json!({
        "step": "extract", "model": "m", "prompt_version": 1, "chunk": "c", "provider": "p",
        "outcome": "truncated"
    }))
    .unwrap_or_else(|_| panic!("entry shape"));
    assert!(r.put(key, &e));
    let read = r.path(key);
    age(&read, 400);
    age(&c.join("inference/results/ab"), 400);
    assert!(r.get(key).is_some());
    let doc = c.join("registry/osv/vulns/GHSA-x.json");
    std::fs::create_dir_all(doc.parent().unwrap()).unwrap();
    std::fs::write(&doc, "{}").unwrap();
    age(&doc, 40);
    used(&doc);
    clean(c, &plan(&["t0"], None), &|| false);
    assert!(read.is_file(), "read within the year");
    assert!(!c.join("inference/results/ab/ab0.json").exists());
    assert!(doc.is_file(), "an advisory document read this sync");
    assert!(c.join("inference/ledger.jsonl").exists() && c.join("inference/worker.lock").exists());
}

#[test]
fn cache_clean_says_what_it_removes_asks_and_keeps_model_results_unless_asked() {
    let (cache, _cat) = cache_with(1);
    let c = cache.path();
    let (code, lines) = clean_command(c, false, false, &mut || None);
    assert_eq!(code, 1);
    assert!(
        lines[0].starts_with("This removes ") && lines.last().unwrap().contains("--yes"),
        "{lines:?}"
    );
    assert!(kept(c, "t0"), "nothing removed without an answer");
    let (_, lines) = clean_command(c, false, false, &mut || Some(false));
    assert_eq!(lines.last().unwrap(), "Nothing removed.");
    let (code, lines) = clean_command(c, false, true, &mut || None);
    assert_eq!(code, 0, "{lines:?}");
    assert!(!crate::cache::index_path(c, "t0").exists());
    assert_eq!(
        model_results(c)
            .iter()
            .filter(|p| p.starts_with(c.join("inference/results")))
            .count(),
        5
    );
    let (_, lines) = clean_command(c, true, true, &mut || None);
    assert!(
        lines
            .iter()
            .any(|l| l.contains("5 stored model results") && l.contains("paid for again")),
        "{lines:?}"
    );
    assert!(!c.join("inference/results/ab/ab0.json").exists());
    assert!(c.join("inference/ledger.jsonl").exists() && c.join("inference/worker.lock").exists());
}

#[test]
fn repositories_recording_at_once_lose_no_entry() {
    let cache = tempfile::tempdir().unwrap();
    let c = cache.path().to_path_buf();
    let hs: Vec<_> = (0..8)
        .map(|i| {
            let c = c.clone();
            std::thread::spawn(move || {
                for k in 0..10 {
                    record(&c, Path::new(&format!("/repo/{i}/{k}")), &set(&["t0"]), 1).unwrap();
                }
            })
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    assert_eq!(Needed::load(&c).unwrap().repos.len(), 80);
}

#[test]
fn a_clean_stopped_partway_leaves_a_usable_cache() {
    use std::os::unix::fs::PermissionsExt;
    let (cache, cat) = cache_with(3);
    let c = cache.path();
    let gone = tempfile::tempdir().unwrap();
    record(
        c,
        &gone.path().join("x"),
        &set(&["t1", "t2"]),
        *NOW - 40 * DAY,
    )
    .unwrap();
    // The shards directory cannot be changed: the clean removes t1's and t2's indexes, not their shards.
    let shards = c.join("v1/shards");
    std::fs::set_permissions(&shards, std::fs::Permissions::from_mode(0o555)).unwrap();
    let out = clean(c, &plan(&["t0"], None), &|| false);
    std::fs::set_permissions(&shards, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(out.error.is_some(), "{out:?}");
    assert!(crate::cache::load_catalog_tech(c, "t1").unwrap().is_none());
    assert!(crate::cache::load_catalog_tech(c, "t0").unwrap().is_some());
    // The next sync fetches t1 again; the next clean finishes.
    let rep = crate::sync::sync(
        cat.loc(),
        c,
        &set(&["t1"]),
        &BTreeSet::new(),
        &set(&["pkg:npm/t1"]),
    )
    .unwrap();
    assert_eq!(rep.synced.len(), 1);
    assert!(crate::cache::load_catalog_tech(c, "t1").unwrap().is_some());
    age(&c.join("v1"), 1);
    assert_eq!(clean(c, &plan(&["t0", "t1"], None), &|| false).error, None);
    assert!(!c.join("v1/shards/t2").exists());
}

#[test]
fn a_clean_stops_at_the_syncs_time_bound() {
    let (cache, _cat) = cache_with(1);
    let c = cache.path();
    age(&c.join("registry"), 40);
    let out = clean(c, &plan(&["t0"], None), &|| true);
    assert_eq!(out.removed, 0);
}
