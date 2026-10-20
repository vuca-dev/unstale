//! Unmaintained but not deprecated: a direct dependency whose upstream repository is archived, or whose newest release
//! is two or more years old, while its publisher never deprecated it. Nothing in the registry flags these, so update
//! PRs and audits stay silent about them.
//!
//! The coverage service already judged each registered package on its registry release dates and its GitHub
//! repository (`central/src/pipeline/admission.ts`): a package with no release within its freshness window, or with
//! an archived repository and no registry case, is not admitted, and its status says so. Only those packages are read
//! here, once a week: the registry's newest release date (npm's packument `time`, PyPI's simple index upload times)
//! decides the two years, and PyPI's project status (PEP 792) can say archived. Outputs read the cache only.
//! `UNSTALE_NO_REGISTRY=1` turns the reads off. A package marked deprecated or yanked is under "Deprecated by the
//! publisher", never here.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::onboarding::Job;
use crate::stack::Stack;
use crate::util;

/// No release in this many days is unmaintained.
pub const STALE_DAYS: i64 = 730;
/// A cached answer is asked again after this long.
const FRESH_SECS: u64 = 7 * 24 * 3600;

#[derive(Debug, Clone, PartialEq)]
pub struct Notice {
    pub name: String,
    pub version: String,
    /// Why: "upstream repository archived", "no release since 2020-06-10".
    pub why: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Cached {
    checked: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_release: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    archived: bool,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn path(cache: &Path, purl: &str) -> PathBuf {
    let key = util::sha256_hex(purl.as_bytes());
    cache.join("registry/maintained").join(format!("{}.json", &key[..32]))
}

fn cached(cache: &Path, purl: &str) -> Option<Cached> {
    serde_json::from_slice(&std::fs::read(path(cache, purl)).ok()?).ok()
}

/// What the coverage service's admission said about a package: its repository is archived, or it has no release in
/// its freshness window (`admission.ts` `admit`). The phrases are central's own fixed text.
fn verdict(job: &Job) -> Option<bool> {
    if job.state != "blocked" || !job.stage.starts_with("Not admitted for monitoring:") {
        return None;
    }
    if job.stage.contains(" is archived") {
        Some(true)
    } else if job.stage.contains(": no release") {
        Some(false)
    } else {
        None
    }
}

/// The public direct dependencies (as `deprecations::installed` reads them) the coverage service found stale or
/// archived: `(purl, name, installed version, archived)`, one per package (its lowest installed version).
fn candidates(st: &Stack, jobs: &BTreeMap<String, Job>) -> Vec<(String, String, String, bool)> {
    let mut seen = BTreeSet::new();
    let mut out = vec![];
    for (purl, name, version) in crate::deprecations::installed(st) {
        if util::stub_package(&purl) || !seen.insert(purl.clone()) {
            continue;
        }
        let Some(archived) = jobs.get(&purl).and_then(verdict) else { continue };
        out.push((purl, name, version, archived));
    }
    out
}

fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// Where the registry lists every release with its date.
fn url(purl: &str) -> Option<String> {
    if let Some(name) = purl.strip_prefix("pkg:pypi/") {
        return Some(format!("https://pypi.org/simple/{}/", enc(name)));
    }
    Some(format!("https://registry.npmjs.org/{}", enc(&util::npm_name(purl)?)))
}

/// The newest release date (`YYYY-MM-DD…`) and whether the registry says the project is archived. npm: the packument's
/// `time` of its published versions. PyPI (simple JSON API): the newest file's `upload-time`, and `project-status`.
pub fn read_doc(purl: &str, doc: &serde_json::Value) -> (Option<String>, bool) {
    if purl.starts_with("pkg:pypi/") {
        let newest = doc.get("files").and_then(|f| f.as_array()).into_iter().flatten().filter(|f| f.get("yanked").is_none_or(|y| y == false)).filter_map(|f| f.get("upload-time")?.as_str()).max();
        let archived = doc.pointer("/project-status/status").and_then(|s| s.as_str()) == Some("archived");
        return (newest.map(String::from), archived);
    }
    let versions = doc.get("versions").and_then(|v| v.as_object());
    let newest = doc
        .get("time")
        .and_then(|t| t.as_object())
        .into_iter()
        .flatten()
        .filter(|(k, _)| versions.is_some_and(|v| v.contains_key(*k)))
        .filter_map(|(_, d)| d.as_str())
        .max();
    (newest.map(String::from), false)
}

/// Reads the registry for each candidate whose cached answer is missing or older than a week. Returns how many were
/// asked.
pub fn refresh(cache: &Path, st: &Stack, jobs: &BTreeMap<String, Job>) -> usize {
    if crate::privacy::registry_off() {
        return 0;
    }
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(15))).build().into();
    let fetch = |url: &str| -> Option<serde_json::Value> {
        let mut r = agent.get(url).header("Accept", "application/vnd.pypi.simple.v1+json, application/json").call().ok().filter(|r| r.status().is_success())?;
        let bytes = r.body_mut().with_config().limit(16 * 1024 * 1024).read_to_vec().ok()?;
        serde_json::from_slice(&bytes).ok()
    };
    refresh_with(cache, st, jobs, now(), fetch)
}

/// `refresh` with the clock and the reader given (tests).
pub fn refresh_with(cache: &Path, st: &Stack, jobs: &BTreeMap<String, Job>, at: u64, fetch: impl Fn(&str) -> Option<serde_json::Value> + Sync) -> usize {
    let due: Vec<String> = candidates(st, jobs)
        .into_iter()
        .map(|c| c.0)
        .filter(|purl| cached(cache, purl).is_none_or(|c| at.saturating_sub(c.checked) >= FRESH_SECS))
        .collect();
    let mut asked = 0;
    util::concurrent(&due, util::REQUESTS_AT_ONCE, |purl| url(purl).and_then(|u| fetch(&u)), |i, doc| {
        asked += 1;
        if let Some(doc) = doc {
            let (last_release, archived) = read_doc(&due[i], &doc);
            if let Ok(b) = serde_json::to_vec(&Cached { checked: at, last_release, archived }) {
                let _ = util::write_atomic(&path(cache, &due[i]), &b);
            }
        }
        true
    });
    asked
}

/// The unmaintained direct dependencies, from the statuses and the cache alone, by name. `today` is `YYYY-MM-DD`.
pub fn notices(cache: &Path, st: &Stack, jobs: &BTreeMap<String, Job>, today: &str) -> Vec<Notice> {
    let Some(cutoff) = days_before(today, STALE_DAYS) else { return vec![] };
    let mut out: Vec<Notice> = candidates(st, jobs)
        .into_iter()
        .filter_map(|(purl, name, version, archived)| {
            let c = cached(cache, &purl);
            let last = c.as_ref().and_then(|c| c.last_release.clone());
            let since = last.as_deref().map(|d| d.get(..10).unwrap_or(d).to_string());
            let old = since.as_deref().is_some_and(|d| d < cutoff.as_str());
            let why = match (archived || c.as_ref().is_some_and(|c| c.archived), old) {
                (true, true) => format!("upstream repository archived; no release since {}", since.unwrap_or_default()),
                (true, false) => "upstream repository archived".to_string(),
                (false, true) => format!("no release since {}", since.unwrap_or_default()),
                (false, false) => return None,
            };
            Some(Notice { name, version, why })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// `YYYY-MM-DD`, `days` before `today`.
fn days_before(today: &str, days: i64) -> Option<String> {
    let d = chrono_like(today)? - days;
    Some(civil(d))
}

/// Days since 1970-01-01 of a `YYYY-MM-DD` date.
fn chrono_like(s: &str) -> Option<i64> {
    let mut it = s.get(..10)?.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (it.next()??, it.next()??, it.next()??);
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

fn civil(z: i64) -> String {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stack::{Dep, Pin};

    fn job(purl: &str, state: &str, stage: &str) -> Job {
        Job { purl: purl.into(), technology: "t".into(), name: "n".into(), state: state.into(), stage: stage.into(), ..Default::default() }
    }

    #[test]
    fn dates_round_trip() {
        assert_eq!(days_before("2026-10-19", STALE_DAYS).as_deref(), Some("2024-10-19"));
        assert_eq!(days_before("2024-03-01", 1).as_deref(), Some("2024-02-29"));
    }

    #[test]
    fn stale_or_archived_direct_dependencies_the_service_declined_are_named_after_the_registry_dates() {
        let mut st = Stack::default();
        for (purl, name, v) in [("pkg:npm/extract-zip", "extract-zip", "2.0.1"), ("pkg:npm/fresh", "fresh", "1.0.0"), ("pkg:npm/gone", "gone", "3.0.0"), ("pkg:pypi/pysher", "pysher", "1.0.8"), ("pkg:npm/watched", "watched", "1.0.0")] {
            let mut d = Dep::new(name, true);
            d.pins.push(Pin { version: v.into(), hashes: vec!["sha512-x".into()] });
            st.deps.insert(purl.into(), d);
        }
        let jobs: BTreeMap<String, Job> = [
            job("pkg:npm/extract-zip", "blocked", "Not admitted for monitoring: no release in 365 days"),
            job("pkg:npm/fresh", "blocked", "Not admitted for monitoring: no release in 365 days"),
            job("pkg:npm/gone", "blocked", "Not admitted for monitoring: repository a/gone is archived and the package does not qualify on its registry: under 1000 downloads and 100 stars"),
            job("pkg:pypi/pysher", "blocked", "Not admitted for monitoring: no release in 365 days"),
            job("pkg:npm/watched", "monitoring", "3 verified records"),
        ]
        .into_iter()
        .map(|j| (j.purl.clone(), j))
        .collect();
        let dir = tempfile::tempdir().unwrap();
        let asked = std::sync::Mutex::new(vec![]);
        let n = refresh_with(dir.path(), &st, &jobs, 1_000, |u| {
            asked.lock().unwrap().push(u.to_string());
            Some(match u {
                "https://registry.npmjs.org/extract-zip" => serde_json::json!({"versions": {"2.0.1": {}}, "time": {"created": "2014-01-01T00:00:00Z", "modified": "2026-01-01T00:00:00Z", "2.0.1": "2020-06-10T07:10:04.849Z"}}),
                "https://registry.npmjs.org/fresh" => serde_json::json!({"versions": {"1.0.0": {}}, "time": {"1.0.0": "2025-06-01T00:00:00Z"}}),
                "https://pypi.org/simple/pysher/" => serde_json::json!({"files": [{"upload-time": "2021-03-01T00:00:00Z"}], "project-status": {"status": "archived"}}),
                _ => serde_json::json!({}),
            })
        });
        assert_eq!(n, 4, "only what the service declined as stale or archived is read: {:?}", asked.lock().unwrap());
        let got = notices(dir.path(), &st, &jobs, "2026-10-19");
        let lines: Vec<String> = got.iter().map(|n| format!("{} {}: {}", n.name, n.version, n.why)).collect();
        assert_eq!(lines, vec![
            "extract-zip 2.0.1: no release since 2020-06-10",
            "gone 3.0.0: upstream repository archived",
            "pysher 1.0.8: upstream repository archived; no release since 2021-03-01",
        ], "a release within two years is not unmaintained (`modified` is no release)");
        assert_eq!(refresh_with(dir.path(), &st, &jobs, 2_000, |_| None), 0, "cached a week");
    }
}
