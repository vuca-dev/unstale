use super::*;
use crate::testcat::{FixtureCatalog, rec};

static NOW: std::sync::LazyLock<u64> = std::sync::LazyLock::new(now);

fn set(xs: &[&str]) -> BTreeSet<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

/// Ages every file under `p` to `days` before [`NOW`].
fn age(p: &Path, days: u64) {
    let mut v = vec![];
    if p.is_dir() {
        files(p, &mut v);
    } else {
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

/// A cache synced from a catalog of `n` technologies (`t0`, `t1`, …, each with a few records, all used by the stack),
/// with registry metadata and model results beside them.
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
    (cache, cat)
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
    let before = size(c);
    let paid = model_results(c);
    // Recently needed, so nothing goes for its age: only the limit makes room.
    let limit = before / 2;
    let out = clean(c, &set(&["t0", "t1"]), *NOW, Some(limit), false);
    assert_eq!(out.error, None);
    assert!(
        out.bytes <= limit,
        "{} of {limit} (from {before})",
        out.bytes
    );
    assert!(out.removed > 0);
    for t in ["t0", "t1"] {
        for p in named(c, t) {
            assert!(p.is_file(), "{} kept", p.display());
        }
        assert!(crate::cache::load_catalog_tech(c, t).unwrap().is_some());
    }
    for p in &paid {
        assert!(p.is_file(), "model result {} kept", p.display());
    }
    eprintln!(
        "disk: {before} bytes before, {} after, limit {limit}",
        out.bytes
    );
}

#[test]
fn two_repositories_with_different_stacks_never_evict_each_others_files() {
    let (cache, _cat) = cache_with(3);
    let c = cache.path();
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    for r in [&a, &b] {
        std::fs::create_dir_all(r.path().join(".unstale")).unwrap();
        std::fs::write(r.path().join(".unstale/config.json"), "{}").unwrap();
    }
    // Repository b last synced 40 days ago and needs t1; t2 was last needed 40 days ago by a repository that no longer
    // needs it.
    record(c, b.path(), &set(&["t1"]), *NOW - 40 * DAY).unwrap();
    let mut n = Needed::load(c);
    n.technologies.insert("t2".into(), *NOW - 40 * DAY);
    crate::util::write_atomic(&needed_path(c), &serde_json::to_vec(&n).unwrap()).unwrap();
    for t in ["t1", "t2"] {
        for p in tech_paths(c, t) {
            if p.exists() {
                age(&p, 40);
            }
        }
    }
    record(c, a.path(), &set(&["t0"]), *NOW).unwrap();
    let out = clean(c, &set(&["t0"]), *NOW, None, false);
    assert_eq!(out.error, None);
    for p in named(c, "t1") {
        assert!(p.is_file(), "b's {} kept", p.display());
    }
    assert!(named(c, "t0").iter().all(|p| p.is_file()));
    assert!(
        !crate::cache::index_path(c, "t2").exists(),
        "needed by no repository for 40 days"
    );
    assert!(!c.join("v1/shards/t2").exists());
    // Repository a's next sync, after b's: a's files stay as well.
    record(c, b.path(), &set(&["t1"]), *NOW).unwrap();
    clean(c, &set(&["t1"]), *NOW, None, false);
    assert!(named(c, "t0").iter().all(|p| p.is_file()));
    // Once b is gone from disk, what only it needed goes after its 30 days.
    drop(b);
    clean(c, &set(&["t0"]), *NOW + 31 * DAY, None, false);
    assert!(!crate::cache::index_path(c, "t1").exists());
    assert!(
        named(c, "t0").iter().all(|p| p.is_file()),
        "never what the running sync needs"
    );
}

#[test]
fn registry_metadata_and_model_results_go_by_their_age_the_ledger_and_lock_never() {
    let (cache, _cat) = cache_with(1);
    let c = cache.path();
    age(&c.join("registry"), 31);
    age(&c.join("inference/results/ab/ab0.json"), 366);
    age(&c.join("inference/results/ab/ab1.json"), 200);
    age(&c.join("inference/ledger.jsonl"), 900);
    age(&c.join("inference/worker.lock"), 900);
    clean(c, &set(&["t0"]), *NOW, None, false);
    assert!(
        !c.join("registry/deprecated")
            .read_dir()
            .unwrap()
            .any(|_| true)
    );
    assert!(!c.join("inference/results/ab/ab0.json").exists());
    assert!(c.join("inference/results/ab/ab1.json").exists());
    assert!(c.join("inference/ledger.jsonl").exists() && c.join("inference/worker.lock").exists());
    // `unstale cache clean`: every model result too; the ledger and lock stay.
    let out = clean(c, &BTreeSet::new(), *NOW, None, true);
    assert_eq!(out.error, None);
    assert!(
        !c.join("inference/results/ab/ab1.json").exists()
            && !c.join("inference/records/t1.json").exists()
    );
    assert!(!crate::cache::index_path(c, "t0").exists());
    assert!(c.join("inference/ledger.jsonl").exists() && c.join("inference/worker.lock").exists());
}

#[cfg(unix)]
#[test]
fn a_clean_stopped_partway_leaves_a_usable_cache() {
    use std::os::unix::fs::PermissionsExt;
    let (cache, cat) = cache_with(3);
    let c = cache.path();
    for t in ["t1", "t2"] {
        for p in tech_paths(c, t) {
            if p.exists() {
                age(&p, 40);
            }
        }
    }
    // The shards directory cannot be changed: the clean stops after removing t1's index, before its shards.
    let shards = c.join("v1/shards");
    std::fs::set_permissions(&shards, std::fs::Permissions::from_mode(0o555)).unwrap();
    let out = clean(c, &set(&["t0"]), *NOW, None, false);
    std::fs::set_permissions(&shards, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(out.error.is_some(), "{out:?}");
    // What is left reads: t1 as never synced, the others as they were.
    assert!(crate::cache::load_catalog_tech(c, "t1").unwrap().is_none());
    assert!(crate::cache::load_catalog_tech(c, "t0").unwrap().is_some());
    assert!(crate::cache::load_catalog_tech(c, "t2").unwrap().is_some());
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
    assert_eq!(clean(c, &set(&["t0", "t1"]), *NOW, None, false).error, None);
    assert!(!crate::cache::index_path(c, "t2").exists());
}

#[test]
fn over_the_limit_registry_metadata_goes_before_technologies_synced_before_records_were_kept() {
    let (cache, _cat) = cache_with(4);
    let c = cache.path();
    let registry = size(&c.join("registry"));
    // Room is made by registry metadata alone; t1..t3, synced before needed.json existed, stay.
    let limit = size(c) - registry / 2;
    let out = clean(c, &set(&["t0"]), *NOW, Some(limit), false);
    assert!(out.bytes <= limit);
    for t in ["t1", "t2", "t3"] {
        assert!(named(c, t).iter().all(|p| p.is_file()), "{t} kept");
    }
}
