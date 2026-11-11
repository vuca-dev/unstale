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
pub mod labels;
pub mod matching;
pub mod results;
pub mod run;
pub mod store;

use crate::inference::{Inference, ProviderConfig};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use unstale_schema::catalog::EventLine;

/// A route that refuses this many requests in a row (each a 400) is refusing every request: the pass stops there with
/// one line, like any other provider problem, instead of one failed call per item.
pub const REJECTED_IN_A_ROW: usize = 3;

/// The requests a route refused in a row during one pass.
#[derive(Debug, Default)]
pub struct Streak(std::cell::Cell<usize>);

impl Streak {
    /// The provider's result for the caller to read, or the deferral that stops the pass when this refusal is the
    /// [`REJECTED_IN_A_ROW`]th in a row. An answer starts the count again.
    pub fn check<T>(
        &self,
        r: Result<T, crate::inference::Deferred>,
    ) -> Result<Result<T, crate::inference::Deferred>, crate::inference::Deferred> {
        match &r {
            Err(crate::inference::Deferred::Rejected) => {
                self.0.set(self.0.get() + 1);
                if self.0.get() >= REJECTED_IN_A_ROW {
                    return Err(crate::inference::Deferred::Rejected);
                }
            }
            Ok(_) => self.0.set(0),
            Err(_) => {}
        }
        Ok(r)
    }
}

/// Events older than this many days before today are not extracted on the client: the first sync of a technology
/// covers one year of its releases, as the setup quote states.
pub const BACKFILL_DAYS: i64 = 365;

/// One technology's events that need the client's own steps, oldest first (central's order, so a pass that stops
/// partway leaves the same match targets central would have).
#[derive(Debug, Clone)]
pub struct Pending {
    pub technology: String,
    pub events: Vec<EventLine>,
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
/// technology, oldest events first, as central ingests. An event is left out when central processed it (`extracted`:
/// its records, if any, are in the catalog), when the catalog has records for its version, or when it is older than
/// the backfill window. A technology never synced, or whose events cannot be read, is skipped.
pub fn plan(
    cache: &Path,
    techs: &BTreeSet<String>,
    purls: &BTreeSet<String>,
    today: &str,
) -> Vec<Pending> {
    let floor = crate::util::add_days(today, -BACKFILL_DAYS).unwrap_or_default();
    let mut out: Vec<(usize, Pending)> = vec![];
    for t in techs {
        // The catalog's records only: a release counts as covered by what the catalog publishes, never by what this
        // machine made, so a pass stopped mid-release finishes it next time.
        let Ok(Some(td)) = crate::cache::load_catalog_tech(cache, t) else {
            continue;
        };
        let Ok(Some(ev)) = crate::cache::load_events(cache, t) else {
            continue;
        };
        let done = store::covered(&td);
        let mut events: Vec<EventLine> = ev
            .events
            .into_iter()
            .filter(|e| {
                !e.extracted && !done.contains(&e.version) && e.date.as_str() >= floor.as_str()
            })
            .collect();
        events.sort_by(|a, b| {
            a.date
                .cmp(&b.date)
                .then_with(|| extract::numeric_cmp(&a.version, &b.version))
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
    let make = |mut c: ProviderConfig, base: &str| {
        // A route's address may be moved to this machine only (a local proxy, the test servers).
        if let Ok(b) = std::env::var(base)
            && loopback(b.trim())
        {
            c.base_url = b.trim().to_string();
        }
        let mut inf = Inference::new(c).with_env(keys::reader_with(
            root.map(Path::to_path_buf),
            consented.clone(),
            env.clone(),
        ));
        // The user's own monthly token limit (`unstale setup --limit`), the default when they set none.
        inf.monthly_budget = crate::setup::monthly_tokens_at(root);
        inf
    };
    Some(Routes {
        main: make(main, "UNSTALE_INFERENCE_BASE_URL"),
        labels: labels.map(|l| make(l, "UNSTALE_LABELS_BASE_URL")),
    })
}

/// The steps for this stack's technologies with the stored choice, the worker lock already held by the caller. `None`
/// when no provider is chosen.
pub fn run_locked(
    cache: &Path,
    root: &Path,
    techs: &BTreeSet<String>,
    purls: &BTreeSet<String>,
) -> Option<run::Summary> {
    let routes = routes(&stored_choice(Some(root))?, Some(root))?;
    Some(run::run(
        cache,
        &routes,
        techs,
        purls,
        &crate::util::today(),
    ))
}

/// An http(s) address on this machine: `localhost` or a loopback IP, no userinfo.
fn loopback(url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return false;
    }
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => authority.split(':').next().unwrap_or(""),
    };
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
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
        "labels" | "match" => {
            #[derive(serde::Deserialize)]
            struct Item {
                /// The technology's name as prompts state it.
                name: String,
                incoming: extract::Incoming,
                /// `match`: whether the incoming record is labelled breaking.
                #[serde(default)]
                breaking: bool,
                /// `match`: the records it may be the same change as (retrieval picks up to eight).
                #[serde(default)]
                candidates: Vec<unstale_schema::catalog::CapabilityRecord>,
            }
            let p = crate::prompts::prompts();
            let ch = labels::Chooser::new(&main, &results);
            for (n, line) in text
                .lines()
                .enumerate()
                .filter(|(_, l)| !l.trim().is_empty())
            {
                let it: Item = serde_json::from_str(line)
                    .map_err(|e| anyhow::anyhow!("--in line {}: {e}", n + 1))?;
                let key = it.incoming.key.clone();
                let out_line = if step == "labels" {
                    let state = labels::record_state(p, &it.name, &it.incoming);
                    ch.ask(labels::STEP_LABELS, &state, &p.labels.questions()).map(|a| serde_json::json!({"key": key, "labels": a.as_ref().and_then(|a| labels::interpret(p, a)), "answers": a}))
                } else {
                    let cands: Vec<matching::Cand> = it
                        .candidates
                        .iter()
                        .map(|r| matching::Cand {
                            rec: r,
                            sources: None,
                        })
                        .collect();
                    let found = matching::retrieve(&it.incoming, &cands);
                    let recs: Vec<&unstale_schema::catalog::CapabilityRecord> =
                        found.iter().map(|(c, _)| c.rec).collect();
                    let scores: Vec<f64> = found.iter().map(|(_, s)| *s).collect();
                    let (state, qs) = matching::match_request(
                        p,
                        &it.name,
                        &it.incoming,
                        it.breaking,
                        &recs,
                        Some(&scores),
                    );
                    if qs.is_empty() {
                        Ok(serde_json::json!({"key": key, "match": null, "judged": []}))
                    } else {
                        ch.ask(labels::STEP_JUDGE, &state, &qs).map(|a| match a {
                            Some(a) => {
                                let (m, judged) = matching::pick(p, &it.incoming, it.breaking, &recs, &a);
                                serde_json::json!({"key": key, "match": m.map(|x| x.0), "judged": judged})
                            }
                            None => serde_json::json!({"key": key, "match": null, "judged": [], "failed": true}),
                        })
                    }
                };
                match out_line {
                    Ok(v) => writeln!(out, "{v}")?,
                    Err(d) => {
                        writeln!(
                            out,
                            "{}",
                            serde_json::json!({"key": key, "deferred": d.line()})
                        )?;
                        return Ok(());
                    }
                }
            }
            Ok(())
        }
        other => anyhow::bail!("unknown step {other}; known: extract, labels, match"),
    }
}

/// One warning when this repository has releases waiting for the model steps and nothing will run them: the steps run
/// only in the session-start background stage, and this repository has no agent session-start hook, or turns the
/// session-start sync off. `None` with the switch off, with no provider chosen, or with nothing waiting.
pub fn unrun_line(ctx: &crate::Ctx, techs: &BTreeSet<String>) -> Option<String> {
    if !crate::inference::enabled() {
        return None;
    }
    // The one thing to do: with the sync turned off, the stage does not run at all (not even by hand), so turning it
    // back on; without a hook, running the stage by hand.
    let (why, fix) = if ctx.config.session_sync == Some(false) {
        (
            "`session_sync` is off in .unstale/config.json",
            "Remove it.",
        )
    } else if !session_hook_installed(&ctx.root) {
        (
            "no session-start hook here",
            "Run `unstale session-sync`.",
        )
    } else {
        return None;
    };
    stored_choice(Some(&ctx.root))?.providers()?;
    let purls = crate::stack::detect(&ctx.root)
        .map(|st| st.purls())
        .unwrap_or_default();
    // What the catalog leaves to this machine, less what a pass here has already taken in.
    let releases: BTreeSet<(String, String)> = plan(&ctx.cache, techs, &purls, &crate::util::today())
        .into_iter()
        .flat_map(|p| {
            let done = store::LocalStore::load(&ctx.cache, &p.technology).done;
            p.events
                .into_iter()
                .filter(move |e| !done.contains(&e.id))
                .map(move |e| (p.technology.clone(), e.version))
        })
        .collect();
    let n = releases.len();
    (n > 0).then(|| {
        format!(
            "warning: {why}, so {n} new release note{} {} unread. {fix}",
            if n == 1 { "" } else { "s" },
            if n == 1 { "is" } else { "are" }
        )
    })
}

/// Whether an agent's session-start hook for this repository is installed (Claude Code, Codex or opencode): each runs
/// `unstale notify`, which starts the background stage.
fn session_hook_installed(root: &Path) -> bool {
    [
        crate::onboarding::SESSION_HOOK_SETTINGS_PATH,
        crate::session::CODEX_HOOKS_PATH,
        crate::session::OPENCODE_PLUGIN_PATH,
    ]
    .iter()
    .any(|rel| std::fs::read_to_string(root.join(rel)).is_ok_and(|t| t.contains("notify")))
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
#[cfg(test)]
mod tests_steps;
