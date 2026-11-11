//! Agent session start: the catalog sync moves to the agent's session-start hook, so changes reach the agent without
//! it having to ask.
//!
//! Two stages. The hook (`unstale notify`, [`hook`]) is the quick one and never slows or breaks a session: everything
//! it does runs under one deadline ([`DEADLINE`]) on a worker thread, and whatever has not finished by then is dropped;
//! it always exits 0, prints at most one line on stdout and nothing on stderr. Its only catalog request is the
//! conditional request for the catalog's list of technologies ([`sync::quick_check`], [`CATALOG_TIMEOUT`]): when the
//! list and this repository's cached indexes agree, nothing else is asked for. Otherwise it starts the background
//! stage ([`background`], `unstale session-sync`) as a detached process with no inherited stdin, stdout or stderr, so
//! the agent never waits on it, and the process outlives the hook.
//!
//! The background stage runs the same verified sync as `unstale status` (one per repository at a time; a second one
//! exits quietly), bounded by [`BACKGROUND_BOUND`], then the model stage ([`model_stage`]), which with the
//! edge-inference switch on runs under the machine's worker lock and the monthly token budget.
//!
//! Records sync at session start with the switch off too: the catalog's files are static and no model is called. Change
//! events and the model stage follow the switch (as in `sync`). `"session_sync": false` in `.unstale/config.json`
//! turns the session-start sync off; the hook then says only what it said before (shared coverage, notices).
//!
//! What the agent sees: one line when records new to this repository arrived since the last report (or the shared
//! coverage line, or a catalog notice), nothing otherwise. A failure is never shown at session start; `unstale status`
//! shows the last one ([`after_status`]).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::{Ctx, cache, inference, notice, onboarding, stack, sync, util};

/// Everything the hook does, from the moment it starts: under the 2 s session start allows, with room for the
/// process to start and exit.
pub const DEADLINE: Duration = Duration::from_millis(1_500);
/// The one catalog request at session start.
pub const CATALOG_TIMEOUT: Duration = Duration::from_millis(800);
/// The background sync stops starting requests after this long (each request has its own timeout as well).
pub const BACKGROUND_BOUND: Duration = Duration::from_secs(120);

/// `.unstale/state/session-sync.json`: what the session-start sync knows about this repository.
#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct State {
    /// The technologies the last background sync kept for this repository (the quick check compares their indexes).
    #[serde(default)]
    pub technologies: Vec<String>,
    /// When the last attempt ended (Unix seconds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_attempt: Option<u64>,
    /// Why the last attempt failed; `None` when it worked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    /// Records new to this repository's technologies since the last report (`unstale status` clears them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrived: Option<Arrived>,
    /// Why the last model stage waited (the switch on only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct Arrived {
    pub technologies: BTreeSet<String>,
    pub records: usize,
}

fn state_path(tool: &Path) -> PathBuf {
    tool.join("state/session-sync.json")
}

/// The state, or the default when it is missing or unreadable (a corrupt file is replaced on the next write).
pub fn read_state(tool: &Path) -> State {
    std::fs::read(state_path(tool))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_state(tool: &Path, s: &State) -> Result<()> {
    util::write_atomic(&state_path(tool), &serde_json::to_vec_pretty(s)?)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Whether this repository's configuration leaves the session-start sync on (the default).
fn enabled(ctx: &Ctx) -> bool {
    ctx.config.session_sync != Some(false)
}

// ------------------------------------------------------------------------------------------------------ the hook

/// The session-start hook: always 0, at most one line on stdout, nothing on stderr, within [`DEADLINE`].
pub fn hook(dir: Option<&Path>) -> u8 {
    let started = Instant::now();
    // A panic anywhere is silent: the worker's ends its thread (the line is dropped), and none reaches stderr.
    std::panic::set_hook(Box::new(|_| {}));
    let dir = dir.map(Path::to_path_buf);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(foreground(dir, started).unwrap_or(None));
    });
    // Past the deadline the worker is abandoned: returning from main ends the process, and the thread with it.
    let line = rx
        .recv_timeout(DEADLINE.saturating_sub(started.elapsed()))
        .ok()
        .flatten();
    if let Some(line) = line
        .map(|l| util::one_line(&l, 600))
        .filter(|l| !l.is_empty())
    {
        let _ = writeln!(std::io::stdout(), "{line}");
    }
    0
}

/// The hook's work: the quick check (starting the background stage when it is due), then the one line to print. An
/// error (no configuration, not a repository, a cache or state that cannot be read or written) prints nothing.
fn foreground(dir: Option<PathBuf>, started: Instant) -> Result<Option<String>> {
    let start = match dir {
        Some(d) => d,
        None => std::env::current_dir()?,
    };
    let ctx = crate::context(&start.canonicalize()?)?;
    let mut state = read_state(&ctx.tool);
    if enabled(&ctx) {
        let techs: BTreeSet<String> = state.technologies.iter().cloned().collect();
        let due = match sync::quick_check(
            &ctx.config.catalog,
            &ctx.cache,
            &techs,
            util::edge_inference(),
            CATALOG_TIMEOUT,
        ) {
            Ok(sync::Quick::Changed) => Ok(true),
            Ok(sync::Quick::Unchanged) => Ok(inference::enabled() && model_work_pending(&ctx)),
            Err(e) => Err(e),
        };
        match due.and_then(|due| {
            if due {
                spawn_background(&ctx.root)
            } else {
                Ok(())
            }
        }) {
            Ok(()) => {}
            Err(e) => {
                // Silent here; `unstale status` shows it.
                state.failure = Some(failure_text(&e));
                state.last_attempt = Some(now_secs());
                let _ = write_state(&ctx.tool, &state);
            }
        }
    }
    let left = DEADLINE.saturating_sub(started.elapsed());
    let coverage = if left > Duration::from_millis(200) {
        onboarding::session_coverage_line(&ctx, left - Duration::from_millis(100))
    } else {
        None
    };
    let arrived = state
        .arrived
        .as_ref()
        .filter(|a| a.records > 0)
        .map(arrived_line);
    Ok(coverage
        .or(arrived)
        .or_else(|| notice::take_one(&ctx.cache, &ctx.tool)))
}

/// The line for records that arrived since the last report.
pub fn arrived_line(a: &Arrived) -> String {
    let n = a.technologies.len();
    format!(
        "unstale: {} new upstream records for {n} {} this repository uses since the last onboarding report. Run `unstale status --wait 0` to refresh .unstale/onboarding-report.md; review it only if the user asks.",
        a.records,
        if n == 1 { "technology" } else { "technologies" }
    )
}

/// A failure in plain words: the two a user meets most (the catalog slow, or not reachable) said as such, anything
/// else as the error reads.
fn failure_text(e: &anyhow::Error) -> String {
    let text = format!("{e:#}");
    let lower = text.to_lowercase();
    if lower.contains("timeout") || lower.contains("timed out") {
        "the catalog did not answer in time".into()
    } else if [
        "connection refused",
        "connect",
        "dns",
        "resolve",
        "unreachable",
    ]
    .iter()
    .any(|w| lower.contains(w))
    {
        "the catalog could not be reached".into()
    } else {
        util::one_line(&text, 200)
    }
}

/// Starts `unstale session-sync` for this repository, detached: no stdin, stdout or stderr is inherited (an agent
/// reading the hook's output would otherwise wait for it), and on Unix its own process group, so nothing sent to the
/// hook's group reaches it.
fn spawn_background(root: &Path) -> Result<()> {
    let exe = std::env::current_exe().context("finding this executable")?;
    let mut c = std::process::Command::new(exe);
    c.arg("-C")
        .arg(root)
        .arg("session-sync")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        c.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    c.spawn().context("starting the background sync")?;
    Ok(())
}

// ------------------------------------------------------------------------------------------- the background stage

/// `unstale session-sync`: the verified sync, then the model stage. Always 0; what happened is kept in the state for
/// the next session start and `unstale status`.
pub fn background(ctx: &Ctx) -> Result<u8> {
    // One per repository at a time: a second exits quietly, the first is doing the work.
    let Some(_lock) = repo_lock(&ctx.tool) else {
        return Ok(0);
    };
    let started = Instant::now();
    let outcome = sync_now(ctx, &|| started.elapsed() > BACKGROUND_BOUND);
    let mut state = read_state(&ctx.tool);
    state.last_attempt = Some(now_secs());
    match outcome {
        Ok(done) => {
            state.failure = done.failure;
            state.technologies = done.technologies.into_iter().collect();
            if done.arrived.records > 0 {
                let a = state.arrived.get_or_insert_with(Arrived::default);
                a.records += done.arrived.records;
                a.technologies.extend(done.arrived.technologies);
            }
        }
        Err(e) => state.failure = Some(failure_text(&e)),
    }
    let techs: BTreeSet<String> = state.technologies.iter().cloned().collect();
    state.deferred = model_stage(ctx, &techs).map(|d| d.line());
    let _ = write_state(&ctx.tool, &state);
    Ok(0)
}

/// The background stage's lock for this repository: `None` when another holds it (or it cannot be taken).
fn repo_lock(tool: &Path) -> Option<std::fs::File> {
    let p = tool.join("state/session-sync.lock");
    std::fs::create_dir_all(p.parent()?).ok()?;
    let f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(p)
        .ok()?;
    f.try_lock().ok()?;
    Some(f)
}

struct Synced {
    technologies: BTreeSet<String>,
    arrived: Arrived,
    failure: Option<String>,
}

fn sync_now(ctx: &Ctx, stop: &(dyn Fn() -> bool + Sync)) -> Result<Synced> {
    let st = stack::detect(&ctx.root)?;
    let cands = onboarding::candidates(ctx, &st);
    // Records already here, so only what is new is counted (a technology never synced counts in full).
    let before: std::collections::BTreeMap<String, usize> = cands
        .iter()
        .filter_map(|t| {
            cache::load_tech(&ctx.cache, t)
                .ok()
                .flatten()
                .map(|d| (t.clone(), d.records.len()))
        })
        .collect();
    let rep = sync::sync_reporting(
        &ctx.config.catalog,
        &ctx.cache,
        &cands,
        &st.withheld(&ctx.cache),
        &st.purls(),
        stop,
        |_| {},
    )?;
    let mut arrived = Arrived::default();
    for t in rep.synced.iter().filter(|t| !t.unchanged) {
        let gained = t
            .records
            .saturating_sub(before.get(&t.technology).copied().unwrap_or(0));
        if gained > 0 {
            arrived.records += gained;
            arrived.technologies.insert(t.technology.clone());
        }
    }
    let failure = rep.failed.first().map(|(t, why)| {
        let others = rep.failed.len() - 1;
        let more = if others > 0 {
            format!(" and {others} more")
        } else {
            String::new()
        };
        util::one_line(&format!("{t}{more} could not be synced: {why}"), 200)
    });
    Ok(Synced {
        technologies: rep.synced.iter().map(|t| t.technology.clone()).collect(),
        arrived,
        failure,
    })
}

/// Whether model work is waiting without a catalog change (a budget that has room again, work a run left). Always
/// false until the client pipeline exists: WS4 answers it from its own state.
fn model_work_pending(_ctx: &Ctx) -> bool {
    false
}

/// The model stage: nothing with the edge-inference switch off. With it on, only under the machine's worker lock
/// (another worker on this machine: quietly nothing) and only with budget left this month; `Some` says why it waited.
fn model_stage(_ctx: &Ctx, _techs: &BTreeSet<String>) -> Option<inference::Deferred> {
    if !inference::enabled() {
        return None;
    }
    let _lock = match inference::lock::try_acquire_default() {
        Ok(Some(l)) => l,
        Ok(None) => return None,
        Err(d) => return Some(d),
    };
    let used = match inference::Ledger::default_location().spent(&inference::ledger::this_month()) {
        Ok(n) => n,
        Err(_) => return Some(inference::Deferred::Storage),
    };
    if used >= inference::ledger::DEFAULT_MONTHLY_TOKENS {
        return Some(inference::Deferred::Budget);
    }
    // ─── WS4 PLUGS IN HERE ───────────────────────────────────────────────────────────────────────────────────────
    // The client pipeline (change events → records) runs here, for `_techs` (`cache::load_events`), holding `_lock`,
    // with `DEFAULT_MONTHLY_TOKENS - used` tokens left, in demand order, returning its `Deferred` when it stops early.
    // It also records when each release's records became ready, for `unstale status`'s freshness line.
    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    None
}

// --------------------------------------------------------------------------------------------------- unstale status

/// After `unstale status`: the report is fresh, so records that arrived are no longer new; and the last session-start
/// failure, which session start never shows, is shown here.
pub fn after_status(ctx: &Ctx) {
    let mut state = read_state(&ctx.tool);
    if state.arrived.take().is_some() {
        let _ = write_state(&ctx.tool, &state);
    }
    if let Some(line) = status_line(ctx, &state) {
        println!("{line}");
    }
}

fn status_line(ctx: &Ctx, state: &State) -> Option<String> {
    if !enabled(ctx) {
        return None;
    }
    let why = state.failure.as_deref().or(state.deferred.as_deref())?;
    let when = state
        .last_attempt
        .map(|s| format!(" ({})", util::format_days((s / 86_400) as i64)))
        .unwrap_or_default();
    Some(format!(
        "Sync at agent session start: the last attempt{when} did not finish: {why}. The next session start tries again"
    ))
}
