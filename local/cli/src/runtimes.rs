//! End of life of the language runtime the code runs on. A repository that pins its runtime (a toolchain file such as
//! `.nvmrc` or `.python-version`, or only a CI setup input such as `node-version: 20.x`; `Stack::runtime_pins`) runs
//! on that release line; when the line's maintainers have ended it, nothing in the registry or the catalog says so.
//!
//! The release lines and their end-of-life dates come from endoflife.date, one public document per runtime (only the
//! runtime's name is sent), cached a week. A declared range (`engines.node >=18`, `requires-python >=3.9`) is a
//! floor the project supports, not the version it runs on, and is never reported here. `UNSTALE_NO_REGISTRY=1` turns
//! the reads off; outputs read the cache only.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::stack::Stack;
use crate::util;

const FRESH_SECS: u64 = 7 * 24 * 3600;

/// A pinned runtime line past its end of life.
#[derive(Debug, Clone, PartialEq)]
pub struct Notice {
    /// The runtime as the report names it (`Node.js`, `Python`).
    pub name: String,
    /// The pin as written (`20.x`, `3.8`).
    pub pinned: String,
    /// The release line (`20`, `3.8`).
    pub cycle: String,
    /// Its end-of-life date, `YYYY-MM-DD`.
    pub eol: String,
    /// The oldest release line after it still supported on that day (`22`), when the document lists one.
    pub next: Option<String>,
    /// Where the pin is (`node-version 20.x in .github/workflows/ci.yml`, `.nvmrc`).
    pub source: String,
}

/// The endoflife.date product of a runtime (`stack::runtime_name`) and the name the report gives it.
fn product(runtime: &str) -> Option<(&'static str, &'static str)> {
    match crate::stack::runtime_name(runtime)? {
        "node" => Some(("nodejs", "Node.js")),
        "python" => Some(("python", "Python")),
        _ => None,
    }
}

fn path(cache: &Path, product: &str) -> PathBuf {
    cache.join("registry/runtimes").join(format!("{product}.json"))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Cached {
    checked: u64,
    doc: serde_json::Value,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Reads the release lines of each pinned runtime whose cached document is missing or older than a week.
pub fn refresh(cache: &Path, st: &Stack) {
    if crate::privacy::registry_off() {
        return;
    }
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(15))).build().into();
    let fetch = |url: &str| -> Option<serde_json::Value> {
        let mut r = agent.get(url).header("Accept", "application/json").call().ok().filter(|r| r.status().is_success())?;
        let bytes = r.body_mut().with_config().limit(4 * 1024 * 1024).read_to_vec().ok()?;
        serde_json::from_slice(&bytes).ok()
    };
    refresh_with(cache, st, now(), fetch);
}

/// `refresh` with the clock and the reader given (tests).
pub fn refresh_with(cache: &Path, st: &Stack, at: u64, fetch: impl Fn(&str) -> Option<serde_json::Value>) {
    for runtime in st.runtime_pins.keys() {
        let Some((p, _)) = product(runtime) else { continue };
        let fresh = std::fs::read(path(cache, p)).ok().and_then(|b| serde_json::from_slice::<Cached>(&b).ok()).is_some_and(|c| at.saturating_sub(c.checked) < FRESH_SECS);
        if fresh {
            continue;
        }
        if let Some(doc) = fetch(&format!("https://endoflife.date/api/{p}.json"))
            && let Ok(b) = serde_json::to_vec(&Cached { checked: at, doc })
        {
            let _ = util::write_atomic(&path(cache, p), &b);
        }
    }
}

/// The release line a pin names: the cycle the pin's stated parts fall in (`20.x` and `v20.19.0` are in `20`, `3.12`
/// in `3.12`). A pin too coarse for any line (`3.x` among Python's `3.12`, `3.13`) names none.
fn cycle_of<'d>(pinned: &str, doc: &'d serde_json::Value) -> Option<&'d serde_json::Value> {
    let stated: Vec<&str> = pinned.trim().trim_start_matches(['v', 'V']).split('.').take_while(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())).collect();
    doc.as_array()?.iter().filter(|c| {
        let cycle = c.get("cycle").and_then(|v| v.as_str().map(String::from).or_else(|| v.as_f64().map(|f| f.to_string()))).unwrap_or_default();
        let parts: Vec<&str> = cycle.split('.').collect();
        !parts.is_empty() && parts.len() <= stated.len() && parts.iter().zip(&stated).all(|(a, b)| a == b)
    }).max_by_key(|c| c.get("cycle").and_then(serde_json::Value::as_str).map(|s| s.split('.').count()).unwrap_or(0))
}

/// The pinned runtimes past their end of life on `today` (`YYYY-MM-DD`), from the cache alone.
pub fn notices(cache: &Path, st: &Stack, today: &str) -> Vec<Notice> {
    let mut out = vec![];
    for (runtime, (pinned, source)) in &st.runtime_pins {
        let Some((p, name)) = product(runtime) else { continue };
        let Some(c) = std::fs::read(path(cache, p)).ok().and_then(|b| serde_json::from_slice::<Cached>(&b).ok()) else { continue };
        let Some(line) = cycle_of(pinned, &c.doc) else { continue };
        // `eol` is a date, or `true` with no date known (then not reported: the report names the date).
        let Some(eol) = line.get("eol").and_then(serde_json::Value::as_str).filter(|d| d.len() >= 10 && &d[..10] <= today) else { continue };
        let key = |c: &serde_json::Value| -> Vec<u64> { c.get("cycle").and_then(serde_json::Value::as_str).unwrap_or_default().split('.').map(|p| p.parse().unwrap_or(0)).collect() };
        let next = c.doc.as_array().into_iter().flatten()
            .filter(|n| key(n) > key(line))
            .filter(|n| match n.get("eol") { Some(serde_json::Value::String(d)) => d.as_str() > today, Some(serde_json::Value::Bool(b)) => !b, _ => false })
            .min_by_key(|n| key(n))
            .and_then(|n| n.get("cycle").and_then(serde_json::Value::as_str).map(String::from));
        out.push(Notice {
            name: name.to_string(),
            pinned: pinned.clone(),
            cycle: line.get("cycle").and_then(serde_json::Value::as_str).unwrap_or_default().to_string(),
            eol: eol[..10].to_string(),
            next,
            source: source.clone(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_runtime_pinned_only_in_ci_past_its_end_of_life_is_a_notice_and_a_coarse_pin_names_no_line() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("repo");
        std::fs::create_dir_all(root.join(".github/workflows")).unwrap();
        std::fs::write(root.join("package.json"), r#"{"name":"docs","private":true,"devDependencies":{"markdownlint-cli":"0.49.1"}}"#).unwrap();
        std::fs::write(
            root.join(".github/workflows/lint.yml"),
            "jobs:\n  lint:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20.x\n      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.x'\n",
        )
        .unwrap();
        let st = crate::stack::detect(&root).unwrap();
        // A CI pin is no support floor.
        assert_eq!(st.node, None);
        assert_eq!(st.runtime_pins.get("node"), Some(&("20.x".to_string(), "node-version 20.x in .github/workflows/lint.yml".to_string())));
        assert_eq!(st.runtime_pins.get("python").map(|p| p.0.as_str()), Some("3.x"));
        let cache = d.path().join("cache");
        let docs = |url: &str| -> Option<serde_json::Value> {
            match url {
                "https://endoflife.date/api/nodejs.json" => Some(serde_json::json!([{"cycle": "22", "eol": "2027-04-30"}, {"cycle": "20", "eol": "2026-04-30"}])),
                "https://endoflife.date/api/python.json" => Some(serde_json::json!([{"cycle": "3.13", "eol": "2029-10-31"}, {"cycle": "3.0", "eol": "2009-06-27"}])),
                _ => None,
            }
        };
        refresh_with(&cache, &st, 1, docs);
        let n = notices(&cache, &st, "2026-10-29");
        assert_eq!(n.len(), 1, "{n:?}");
        assert_eq!((n[0].name.as_str(), n[0].cycle.as_str(), n[0].eol.as_str(), n[0].next.as_deref()), ("Node.js", "20", "2026-04-30", Some("22")));
        assert!(notices(&cache, &st, "2026-04-29").is_empty());
    }

    #[test]
    fn a_declared_range_is_no_pin() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".github/workflows")).unwrap();
        std::fs::write(d.path().join("package.json"), r#"{"name":"lib","engines":{"node":">=18"}}"#).unwrap();
        std::fs::write(d.path().join(".github/workflows/ci.yml"), "    node-version: [18, 20]\n").unwrap();
        let st = crate::stack::detect(d.path()).unwrap();
        assert!(st.runtime_pins.is_empty());
        assert_eq!(st.node.unwrap().0, semver::Version::new(18, 0, 0));
    }
}
