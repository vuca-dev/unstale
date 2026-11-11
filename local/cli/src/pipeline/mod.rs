//! The model steps on the client, behind the edge-inference switch: change events become the records the client
//! otherwise reads from the catalog. Only for releases that have change events and no catalog records ("catalog records
//! win": no model call for a release the catalog covers, so history is never re-derived on the user's tokens), in
//! demand order, inside a bounded backfill window, under the monthly token budget, holding the machine's worker lock.
//!
//! - [`extract`]: events to raw records (central's two calls per chunk).
//! - [`results`]: the user-level cache of every paid answer.
//! - [`keys`]: where a key is read (the environment, or this repository's `.env` for the variable the choice names).
//! - [`js`]: central's text functions, cutting text as JavaScript does.

// The planner and the routes are wired into the session sync with the labels and matching steps; until then only tests
// and `internal run-step` reach them.
#![cfg_attr(not(test), allow(dead_code))]

pub mod extract;
pub mod js;
pub mod keys;
pub mod results;

use crate::inference::{Inference, ProviderConfig};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use unstale_schema::catalog::EventLine;

/// Events older than this many days before today are not extracted on the client: the first sync of a technology
/// covers one year of its releases, as the setup quote states.
pub const BACKFILL_DAYS: i64 = 365;

/// One technology's events that need the client's own steps, newest first.
#[derive(Debug, Clone)]
pub struct Pending {
    pub technology: String,
    pub events: Vec<EventLine>,
}

/// The versions a technology's catalog records name: releases the catalog already covers.
fn covered(td: &crate::cache::TechData) -> BTreeSet<String> {
    td.records
        .iter()
        .flat_map(|r| r.r.releases.iter().map(|x| x.version.clone()))
        .collect()
}

/// How much this repository needs a technology: the stack's packages its index or records name.
fn demand(td: &crate::cache::TechData, purls: &BTreeSet<String>) -> usize {
    let mut named: BTreeSet<&str> = td.index.components.iter().map(String::as_str).collect();
    for r in &td.records {
        named.extend(r.r.releases.iter().map(|x| x.component.as_str()));
    }
    purls.iter().filter(|p| named.contains(p.as_str())).count()
}

/// The work for these technologies, in demand order (most of this stack's packages first, then by id); within a
/// technology, newest events first. An event is left out when the catalog has records for its version, or when it is
/// older than the backfill window. A technology never synced, or whose events cannot be read, is skipped.
pub fn plan(
    cache: &Path,
    techs: &BTreeSet<String>,
    purls: &BTreeSet<String>,
    today: &str,
) -> Vec<Pending> {
    let floor = crate::util::add_days(today, -BACKFILL_DAYS).unwrap_or_default();
    let mut out: Vec<(usize, Pending)> = vec![];
    for t in techs {
        let Ok(Some(td)) = crate::cache::load_tech(cache, t) else {
            continue;
        };
        let Ok(Some(ev)) = crate::cache::load_events(cache, t) else {
            continue;
        };
        let done = covered(&td);
        let mut events: Vec<EventLine> = ev
            .events
            .into_iter()
            .filter(|e| !done.contains(&e.version) && e.date.as_str() >= floor.as_str())
            .collect();
        events.sort_by(|a, b| {
            b.date
                .cmp(&a.date)
                .then_with(|| extract::numeric_cmp(&b.version, &a.version))
                .then_with(|| a.id.cmp(&b.id))
        });
        if !events.is_empty() {
            out.push((
                demand(&td, purls),
                Pending {
                    technology: t.clone(),
                    events,
                },
            ));
        }
    }
    out.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.technology.cmp(&b.1.technology))
    });
    out.into_iter().map(|(_, p)| p).collect()
}

/// The routes a stored choice runs on, each reading its key from the environment, else (for the variable the choice
/// names) from this repository's `.env`.
pub struct Routes {
    /// Writes the records: extraction, and labels and matching without Jev.
    pub main: Inference,
    /// Jev, for labels and matching, when the choice names it.
    pub labels: Option<Inference>,
}

pub fn routes(choice: &crate::setup::Choice, root: Option<&Path>) -> Option<Routes> {
    routes_with(choice, root, |k| std::env::var(k).ok())
}

/// [`routes`] over another environment (tests).
pub fn routes_with(
    choice: &crate::setup::Choice,
    root: Option<&Path>,
    env: impl Fn(&str) -> Option<String> + Send + Sync + Clone + 'static,
) -> Option<Routes> {
    let (main, labels) = choice.providers()?;
    let consented: Vec<String> = choice.key_vars().into_iter().map(String::from).collect();
    let make = |c: ProviderConfig| {
        Inference::new(c).with_env(keys::reader_with(
            root.map(Path::to_path_buf),
            consented.clone(),
            env.clone(),
        ))
    };
    Some(Routes {
        main: make(main),
        labels: labels.map(make),
    })
}

/// A provider named on the command line (evals): the same names `unstale infer` takes; keys from the environment only.
pub fn named_provider(
    provider: &str,
    model: Option<String>,
    base_url: Option<String>,
    key_env: Option<String>,
) -> Result<ProviderConfig, String> {
    let mut cfg = match provider {
        "openai" => ProviderConfig::openai(),
        "vercel" => ProviderConfig::vercel(),
        "openrouter" => ProviderConfig::openrouter(),
        "anthropic" => ProviderConfig::anthropic(),
        "codex" => ProviderConfig::codex(),
        "jev" => ProviderConfig::jev(),
        "custom" if base_url.is_none() || key_env.is_none() || model.is_none() => {
            return Err("--provider custom needs --base-url, --key-env and --model".into());
        }
        "custom" => {
            let mut c = ProviderConfig::custom("custom", "", "", "");
            c.effort = Some("low".into());
            c
        }
        other => return Err(format!("unknown provider {other}")),
    };
    if let Some(m) = model {
        cfg.model = m;
    }
    if let Some(b) = base_url {
        cfg.base_url = b;
    }
    if key_env.is_some() {
        cfg.key_env = key_env;
    }
    Ok(cfg)
}

/// `unstale internal run-step`: one step over a JSON-lines input, one JSON line out per item. Never an error exit:
/// a provider or budget problem prints one `{"deferred": …}` line and stops; what was answered stays cached.
pub fn run_step(
    step: &str,
    input: &Path,
    main: Inference,
    out: &mut dyn std::io::Write,
) -> anyhow::Result<()> {
    let results = results::Results::at(&crate::cache::cache_dir());
    let text = std::fs::read_to_string(input)
        .map_err(|e| anyhow::anyhow!("--in {}: {e}", input.display()))?;
    match step {
        "extract" if main.provider.kind == crate::inference::Kind::Jev => {
            anyhow::bail!(
                "the labelling service labels and matches records but cannot extract them; pick a route that writes text"
            )
        }
        "extract" => {
            let mut events = vec![];
            for (n, line) in text
                .lines()
                .enumerate()
                .filter(|(_, l)| !l.trim().is_empty())
            {
                events.push(serde_json::from_str::<EventLine>(line).map_err(|e| {
                    anyhow::anyhow!("--in line {}: not a change event: {e}", n + 1)
                })?);
            }
            let x = extract::Extractor::new(&main, &results);
            let all: Vec<&EventLine> = events.iter().collect();
            if let Err(d) = x.prefetch(&all) {
                writeln!(out, "{}", serde_json::json!({"deferred": d.line()}))?;
                return Ok(());
            }
            for ev in &events {
                match x.event(ev) {
                    Ok(r) => writeln!(out, "{}", serde_json::to_string(&r)?)?,
                    Err(d) => {
                        writeln!(
                            out,
                            "{}",
                            serde_json::json!({"event": ev.id, "deferred": d.line()})
                        )?;
                        return Ok(());
                    }
                }
            }
            Ok(())
        }
        other => anyhow::bail!("unknown step {other}; known: extract"),
    }
}

/// The stored choice for a directory: its repository's config, else the user's.
pub fn stored_choice(root: Option<&Path>) -> Option<crate::setup::Choice> {
    let repo = root.and_then(|r| {
        let b = std::fs::read(r.join(".unstale/config.json")).ok()?;
        let v: serde_json::Value = serde_json::from_slice(&b).ok()?;
        serde_json::from_value(v.get("inference")?.clone()).ok()
    });
    crate::setup::current(repo.as_ref(), &crate::setup::user_config_path()).map(|(c, _)| c)
}

/// The repository root above `start` (the directory holding `.unstale/config.json`), if any.
pub fn repo_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|d| d.join(".unstale/config.json").is_file())
        .map(Path::to_path_buf)
}

#[cfg(test)]
mod tests;
