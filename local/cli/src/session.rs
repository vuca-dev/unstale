//! Agent session start: the catalog sync moves to the agent's session-start hook, so changes reach the agent without
//! it having to ask. All of it is behind the edge-inference switch (`util::edge_inference`) until the release.
//!
//! The hook (`unstale notify`, [`hook`]) never slows or breaks a session, switch on or off: everything it does runs on a
//! worker thread under one deadline counted from the process's start ([`DEADLINE`]), and whatever has not finished by
//! then is dropped; it always exits 0, prints at most one line on stdout and nothing on stderr. With the switch off it
//! does what `notify` did before: the shared-coverage line or a catalog notice, no catalog request, no other process,
//! no file of its own.
//!
//! With the switch on, its only catalog request is the conditional request for the catalog's list of technologies
//! ([`sync::quick_check`], [`CATALOG_TIMEOUT`]): when the list and this repository's cached indexes agree, nothing else
//! is asked for. A changed list, or a changed manifest or lockfile ([`stack_print`]), starts the background stage
//! ([`background`], `unstale session-sync`) as a detached process with no inherited stdin, stdout or stderr; the hook
//! waits (within its deadline) only until that process holds the repository's lock, so one is never started twice.
//!
//! The background stage runs the same verified sync as `unstale status`, which contacts the same hosts: the catalog,
//! and, through the stack's detection, the public npm and PyPI registries for the newest release of a dependency
//! nothing pins (cached a day, off with `UNSTALE_NO_REGISTRY=1`). One per repository at a time (a second exits
//! quietly), bounded by [`BACKGROUND_BOUND`]. Then the model stage ([`model_stage`]), under the machine's worker lock
//! and the user's monthly token limit: with a provider chosen it contacts that provider (and only it), sending public
//! release-note text; `unstale status` does not. `"session_sync": false` in `.unstale/config.json` turns the sync off.
//!
//! What the agent sees: one line, the most important first. A warning when something the user chose stopped
//! happening (the sync failed, the provider cannot be used, the token limit is reached), said once when that state
//! begins ([`Warning`]); otherwise records new since the last report (or the shared-coverage line), or a catalog
//! notice; nothing otherwise. The line never carries a raw error or a path: `unstale status` shows the detail
//! ([`status_lines`]). What the agent does with the line is in the managed skill. The state
//! (`.unstale/state/session-sync.json`) is changed only under its lock.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::{Ctx, cache, inference, notice, onboarding, stack, sync, util};

/// Everything the hook does, counted from the start of the process: under the 2 s session start allows, with margin
/// for the process to start and exit.
pub const DEADLINE: Duration = Duration::from_millis(1_200);
/// The one catalog request at session start.
pub const CATALOG_TIMEOUT: Duration = Duration::from_millis(600);
/// How long the hook waits for the background stage it started to hold the repository's lock.
const SPAWN_WAIT: Duration = Duration::from_millis(300);
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
    /// Which warning session start last printed (its kind, never its text, so one that persists is said once however
    /// its wording or its age reads). `None` when nothing is wrong or nothing was said yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warned: Option<String>,
    /// The manifest and lock files the last sync's stack came from, fingerprinted, so a changed dependency starts a
    /// sync even while the catalog is unchanged. `None` until a sync has run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<StackPrint>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct StackPrint {
    pub dirs: Vec<String>,
    pub print: String,
}

/// A file the stack is read from: a manifest, a lockfile, a workspace or registry configuration, a runtime version.
fn stack_file(name: &str) -> bool {
    const NAMES: &[&str] = &[
        "package.json",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
        "Cargo.toml",
        "Cargo.lock",
        "pyproject.toml",
        "poetry.lock",
        "uv.lock",
        "pdm.lock",
        "Pipfile",
        "Pipfile.lock",
        "setup.cfg",
        ".nvmrc",
        ".node-version",
    ];
    NAMES.contains(&name)
        || crate::privacy::is_config(name)
        || (name.starts_with("requirements") && (name.ends_with(".txt") || name.ends_with(".in")))
}

/// A fingerprint of the stack files directly in each manifest directory (name, size, modification time): cheap
/// enough for session start, and unchanged by any other file. A new project directory elsewhere is seen at the next
/// catalog change.
fn stack_print(root: &Path, dirs: &[String]) -> String {
    let mut lines = vec![];
    for d in dirs {
        let Ok(rd) = std::fs::read_dir(root.join(d)) else {
            lines.push(format!("{d} -"));
            continue;
        };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !stack_file(&name) {
                continue;
            }
            let Ok(m) = e.metadata() else { continue };
            if !m.is_file() {
                continue;
            }
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|t| t.as_nanos())
                .unwrap_or(0);
            lines.push(format!("{d}/{name} {} {modified}", m.len()));
        }
    }
    lines.sort();
    util::sha256_hex(lines.join("\n").as_bytes())
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

/// Written only into a state directory that already exists, never creating one: a background stage still running
/// when the repository is uninstalled finds the directory gone and leaves nothing behind (the write fails instead).
fn write_state(tool: &Path, s: &State) -> Result<()> {
    let dir = tool.join("state");
    if !dir.is_dir() || !tool.join("config.json").is_file() {
        return Ok(());
    }
    let tmp = dir.join(format!(".session-sync.json.{}", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec_pretty(s)?)?;
    std::fs::rename(&tmp, state_path(tool)).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

/// The state directory, made if `.unstale` is there but it is not (never `.unstale` itself: after an uninstall
/// nothing is made again). False when it is not there afterwards.
fn state_dir(tool: &Path) -> bool {
    if !tool.join("config.json").is_file() {
        return false;
    }
    let _ = std::fs::create_dir(tool.join("state"));
    tool.join("state").is_dir()
}

/// Reads, changes and writes the state under its lock, so two writers never lose each other's result. `wait`: block
/// for the lock (the background stage, `unstale status`); otherwise give up when another holds it (the hook). Nothing
/// happens when the state directory is not there (never set up, or uninstalled).
fn update_state(tool: &Path, wait: bool, change: impl FnOnce(&mut State)) -> Result<()> {
    if !state_dir(tool) {
        return Ok(());
    }
    let dir = tool.join("state");
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("session-sync.state.lock"))?;
    if wait {
        lock.lock()?;
    } else if lock.try_lock().is_err() {
        return Ok(());
    }
    let mut s = read_state(tool);
    change(&mut s);
    write_state(tool, &s)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Whether session start syncs here: the switch on, and the repository's configuration not turning it off.
fn enabled(ctx: &Ctx) -> bool {
    util::edge_inference() && ctx.config.session_sync != Some(false)
}

// ------------------------------------------------------------------------------------------------------ the hook

/// The session-start hook: always 0, at most one line on stdout, nothing on stderr, within [`DEADLINE`] of `started`
/// (the process's start).
pub fn hook(dir: Option<&Path>, started: Instant) -> u8 {
    // A panic anywhere is silent: the worker's ends its thread (the line is dropped), and none reaches stderr.
    std::panic::set_hook(Box::new(|_| {}));
    let dir = dir.map(Path::to_path_buf);
    let (tx, rx) = std::sync::mpsc::channel();
    // Every blocking step (reading the configuration, the state and the cache, the requests, the start of the
    // background stage) runs on this thread; past the deadline it is abandoned: returning from main ends the process,
    // and the thread with it.
    std::thread::spawn(move || {
        let _ = tx.send(foreground(dir, started).unwrap_or_default());
    });
    let said = rx
        .recv_timeout(DEADLINE.saturating_sub(started.elapsed()))
        .unwrap_or_default();
    if let Some(line) = said
        .line
        .map(|l| util::one_line(&l, 600))
        .filter(|l| !l.is_empty())
    {
        let printed = writeln!(std::io::stdout(), "{line}").is_ok();
        // Recorded as said only once it is on the screen: a warning the deadline cut is still due next time.
        if printed && let Some((tool, kind)) = said.warned {
            let _ = update_state(&tool, false, |s| s.warned = Some(kind));
        }
    }
    0
}

/// What the hook prints, and, when that is a warning, where to record that it was said.
#[derive(Default)]
struct Said {
    line: Option<String>,
    warned: Option<(PathBuf, String)>,
}

/// What is wrong after the last attempt, for session start (once, when it begins) and `unstale status` (always).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Warning {
    /// What kind of trouble, stable while it lasts: `catalog-slow`, `catalog-unreachable`, `sync`, or the model
    /// stage's own warning.
    kind: String,
    /// One line for session start: no raw error, no path.
    short: String,
    /// The line `unstale status` shows, with the detail.
    full: String,
}

const SLOW: &str = "the catalog did not answer in time";
const UNREACHABLE: &str = "the catalog could not be reached";

impl Warning {
    /// From the state: a failed sync first, else why the model stage stopped. `now` gives the failure its age.
    fn of(state: &State, now: u64) -> Option<Warning> {
        let Some(why) = state.failure.as_deref() else {
            // The model stage's warning is already one plain line (`inference::Deferred::line`).
            let line = state.deferred.clone()?;
            return Some(Warning {
                kind: format!("model: {line}"),
                short: line.clone(),
                full: line,
            });
        };
        let (kind, short) = match why {
            SLOW => (
                "catalog-slow",
                "warning: catalog too slow at session start, so newer changes are missing. The next session retries.",
            ),
            UNREACHABLE => (
                "catalog-unreachable",
                "warning: catalog not reached at session start, so newer changes are missing. The next session retries.",
            ),
            _ => (
                "sync",
                "warning: the sync at session start failed, so newer changes are missing. `unstale status` says why.",
            ),
        };
        let when = state
            .last_attempt
            .map(|s| format!(" {}", ago(s, now)))
            .unwrap_or_default();
        Some(Warning {
            kind: kind.into(),
            short: short.into(),
            full: format!(
                "warning: the sync at session start failed{when}: {why}. The next session start tries again."
            ),
        })
    }
}

/// The time left before the deadline.
fn left(started: Instant) -> Duration {
    DEADLINE.saturating_sub(started.elapsed())
}

/// The hook's work: the quick check (starting the background stage when it is due), then the one line to print. An
/// error (no configuration, not a repository, a cache or state that cannot be read or written) prints nothing.
fn foreground(dir: Option<PathBuf>, started: Instant) -> Result<Said> {
    let start = match dir {
        Some(d) => d,
        None => std::env::current_dir()?,
    };
    let ctx = crate::context(&start.canonicalize()?)?;
    let mut state = if enabled(&ctx) {
        read_state(&ctx.tool)
    } else {
        State::default()
    };
    if enabled(&ctx) {
        let due = match &state.stack {
            // Never synced here, or the repository's own manifests changed: due whatever the catalog says.
            None => Ok(true),
            Some(p) if stack_print(&ctx.root, &p.dirs) != p.print => Ok(true),
            Some(_) => {
                let techs: BTreeSet<String> = state.technologies.iter().cloned().collect();
                let timeout =
                    CATALOG_TIMEOUT.min(left(started).saturating_sub(Duration::from_millis(100)));
                match sync::quick_check(
                    &ctx.config.catalog,
                    &ctx.cache,
                    &techs,
                    util::edge_inference(),
                    timeout,
                ) {
                    Ok(sync::Quick::Changed) => Ok(true),
                    Ok(sync::Quick::Unchanged) => {
                        Ok(inference::enabled() && model_work_pending(&ctx))
                    }
                    Err(e) => Err(e),
                }
            }
        };
        match due.and_then(|due| {
            if due {
                spawn_background(&ctx.tool, &ctx.root, started).map(|()| true)
            } else {
                Ok(false)
            }
        }) {
            // The background stage is running: it records how it went.
            Ok(true) => {}
            // The catalog answered and nothing is due: whatever failed before has passed.
            Ok(false) => {
                if state.failure.is_some() {
                    state.failure = None;
                    let _ = update_state(&ctx.tool, false, |s| s.failure = None);
                }
            }
            Err(e) => {
                let why = failure_text(&e);
                state.failure = Some(why.clone());
                state.last_attempt = Some(now_secs());
                let _ = update_state(&ctx.tool, false, |s| {
                    s.failure = Some(why);
                    s.last_attempt = Some(now_secs());
                });
            }
        }
    }
    // What is wrong comes first, said once when it begins; while it lasts, the other lines take their turn again.
    let warning = Warning::of(&state, now_secs()).filter(|_| enabled(&ctx));
    match &warning {
        Some(w) if state.warned.as_deref() != Some(w.kind.as_str()) => {
            return Ok(Said {
                line: Some(w.short.clone()),
                warned: Some((ctx.tool.clone(), w.kind.clone())),
            });
        }
        // All well again: the next trouble of the same kind is new.
        None if state.warned.is_some() => {
            let _ = update_state(&ctx.tool, false, |s| s.warned = None);
        }
        _ => {}
    }
    let left = left(started);
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
    Ok(Said {
        line: coverage
            .or(arrived)
            .or_else(|| notice::take_one(&ctx.cache, &ctx.tool)),
        warned: None,
    })
}

/// The line for records that arrived since the last report: what is new and the command. What the agent does with
/// it is in the managed skill.
pub fn arrived_line(a: &Arrived) -> String {
    new_changes_line(
        a.records,
        &a.technologies.iter().cloned().collect::<Vec<_>>(),
    )
}

/// `unstale: 3 new upstream changes for next and react. Run `unstale status --wait 0` to see them.` Past two
/// technologies the first is named and the rest counted, so the line stays short.
pub fn new_changes_line(records: usize, technologies: &[String]) -> String {
    let names = match technologies {
        [] => "this repository".to_string(),
        [a] => a.clone(),
        [a, b] => format!("{a} and {b}"),
        [a, rest @ ..] => format!("{a} and {} more", rest.len()),
    };
    format!(
        "unstale: {records} new upstream {} for {names}. Run `unstale status --wait 0` to see them.",
        if records == 1 { "change" } else { "changes" }
    )
}

/// A failure in plain words: the two a user meets most (the catalog slow, or not reachable) said as such, anything
/// else as the error reads.
fn failure_text(e: &anyhow::Error) -> String {
    let text = format!("{e:#}");
    let lower = text.to_lowercase();
    if lower.contains("timeout") || lower.contains("timed out") {
        SLOW.into()
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
        UNREACHABLE.into()
    } else {
        util::one_line(&text, 200)
    }
}

fn lock_path(tool: &Path) -> PathBuf {
    tool.join("state/session-sync.lock")
}

/// Whether a background stage holds this repository's lock now.
fn running(tool: &Path) -> bool {
    std::fs::OpenOptions::new()
        .write(true)
        .open(lock_path(tool))
        .is_ok_and(|f| f.try_lock().is_err())
}

/// Starts `unstale session-sync` for this repository, detached: no stdin, stdout or stderr is inherited (an agent
/// reading the hook's output would otherwise wait for it), and on Unix its own process group, so nothing sent to the
/// hook's group reaches it. Not when one is running already; and once started, waited for (within the deadline) until
/// it holds the lock or exits, so no second one starts beside it.
fn spawn_background(tool: &Path, root: &Path, started: Instant) -> Result<()> {
    if running(tool) {
        return Ok(());
    }
    let exe = std::env::current_exe().context("finding this executable")?;
    let mut c = std::process::Command::new(exe);
    c.arg("-C")
        .arg(root)
        .arg("session-sync")
        // Started by the hook: silent, as the stage always is (`unstale session-sync` by hand says what it did).
        .env(HOOK_STAGE, "1")
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
    let mut child = c.spawn().context("starting the background sync")?;
    let until =
        Instant::now() + SPAWN_WAIT.min(left(started).saturating_sub(Duration::from_millis(150)));
    while Instant::now() < until && !running(tool) && child.try_wait().ok().flatten().is_none() {
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

// ------------------------------------------------------------------------------------------- the background stage

/// Set in the environment of the background stage the hook starts.
pub const HOOK_STAGE: &str = "UNSTALE_HOOK_STAGE";

/// `unstale session-sync`: the verified sync, then the model stage. Always 0; what happened is kept in the state for
/// the next session start and `unstale status`. Nothing with the switch off.
pub fn background(ctx: &Ctx) -> Result<u8> {
    if !enabled(ctx) {
        return Ok(0);
    }
    // One per repository at a time: a second exits quietly, the first is doing the work.
    let Some(_lock) = repo_lock(&ctx.tool) else {
        return Ok(0);
    };
    let started = Instant::now();
    let outcome = sync_now(ctx, &|| started.elapsed() > BACKGROUND_BOUND);
    // A catalog that refuses this client (too old for it) is not a source to read from: nothing is read, nothing is
    // spent, and the release notes wait for the upgrade (`unstale session-sync` says how many).
    let refused = outcome
        .as_ref()
        .err()
        .is_some_and(|e| e.downcast_ref::<crate::sync::Incompatible>().is_some());
    let techs: BTreeSet<String> = match &outcome {
        Ok(done) => done.technologies.clone(),
        // The catalog did not answer, or not in time: the model stage still reads what the cached catalog holds for
        // this repository, as every other command keeps using it.
        Err(_) => read_state(&ctx.tool)
            .technologies
            .into_iter()
            .chain(cached_technologies(ctx))
            .collect(),
    };
    let deferred = (!refused).then(|| model_stage(ctx, &techs).map(|d| d.line()));
    update_state(&ctx.tool, true, |state| {
        state.last_attempt = Some(now_secs());
        match outcome {
            Ok(done) => {
                state.failure = done.failure;
                // Technologies that failed stay in the set: their cached index differs from the list, so the next
                // quick check retries them.
                state.technologies = done.technologies.into_iter().collect();
                state.stack = Some(done.stack);
                if done.arrived.records > 0 {
                    let a = state.arrived.get_or_insert_with(Arrived::default);
                    a.records += done.arrived.records;
                    a.technologies.extend(done.arrived.technologies);
                }
            }
            Err(e) => state.failure = Some(failure_text(&e)),
        }
        // A refusal ran no model stage: why the last one stopped, if it did, still stands.
        if let Some(d) = deferred {
            state.deferred = d;
        }
    })?;
    Ok(0)
}

/// The background stage's lock for this repository: `None` when another holds it (or it cannot be taken).
fn repo_lock(tool: &Path) -> Option<std::fs::File> {
    if !state_dir(tool) {
        return None;
    }
    let f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(lock_path(tool))
        .ok()?;
    f.try_lock().ok()?;
    Some(f)
}

/// This repository's technologies the cache already holds an index for.
pub fn cached_technologies(ctx: &Ctx) -> BTreeSet<String> {
    let Ok(st) = stack::detect(&ctx.root) else {
        return BTreeSet::new();
    };
    onboarding::candidates(ctx, &st)
        .into_iter()
        .filter(|t| cache::load_tech(&ctx.cache, t).ok().flatten().is_some())
        .collect()
}

struct Synced {
    technologies: BTreeSet<String>,
    stack: StackPrint,
    arrived: Arrived,
    failure: Option<String>,
}

fn sync_now(ctx: &Ctx, stop: &(dyn Fn() -> bool + Sync)) -> Result<Synced> {
    let st = stack::detect(&ctx.root)?;
    let dirs: Vec<String> = st
        .packages
        .iter()
        .map(|p| p.dir.clone())
        .chain(std::iter::once(".".into()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    // Taken before the sync: a manifest changed while it runs starts another.
    let stack = StackPrint {
        print: stack_print(&ctx.root, &dirs),
        dirs,
    };
    let cands = onboarding::candidates(ctx, &st);
    // Records already here. Only a technology this machine had before counts what it gained: one first synced here
    // (a first sync after setup, a cache emptied or rebuilt) is not news since the last report, which read the same.
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
        &st.withheld(&ctx.registry),
        &st.purls(),
        stop,
        |_| {},
    )?;
    crate::cache_gc::after_sync(&ctx.cache, &ctx.root, &crate::cache_gc::needs(&rep), stop);
    let mut arrived = Arrived::default();
    for t in rep.synced.iter().filter(|t| !t.unchanged) {
        let Some(had) = before.get(&t.technology) else {
            continue;
        };
        let gained = t.records.saturating_sub(*had);
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
        technologies: rep
            .synced
            .iter()
            .map(|t| t.technology.clone())
            .chain(rep.failed.iter().map(|(t, _)| t.clone()))
            .collect(),
        stack,
        arrived,
        failure,
    })
}

/// Whether model work is waiting without a catalog change: the last model stage stopped early (a budget that has room
/// again, a provider that answers again); its answers are cached, so the next stage resumes where it stopped.
fn model_work_pending(ctx: &Ctx) -> bool {
    read_state(&ctx.tool).deferred.is_some()
}

/// The model stage: nothing with the edge-inference switch off. With it on, only under the machine's worker lock
/// (another worker on this machine: quietly nothing) and only with budget left this month; `Some` says why it waited.
fn model_stage(ctx: &Ctx, techs: &BTreeSet<String>) -> Option<inference::Deferred> {
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
        Err(e) => return Some(inference::Deferred::storage(&e)),
    };
    // The limit in effect: the user's own (`unstale setup --limit`), or a lower one this repository sets.
    let (limit, unseen) = crate::setup::monthly_tokens(ctx);
    if used >= limit {
        return Some(match unseen {
            Some(agent) => inference::Deferred::BudgetUnseen { agent },
            None => inference::Deferred::Budget,
        });
    }
    // The client pipeline (change events → records) for the synced technologies, holding the lock, in demand order;
    // every call checks the budget again. `None` when no provider is chosen.
    let purls = stack::detect(&ctx.root)
        .map(|st| st.purls())
        .unwrap_or_default();
    crate::pipeline::run_locked(&ctx.cache, &ctx.root, techs, &purls)?.deferred
}

// --------------------------------------------------------------------------------------------------- unstale status

/// For `unstale status` (switch on only): what is wrong, then how fresh this machine is. The report is fresh, so
/// records that arrived are no longer new, and status has just synced, so a failed session-start sync is shown this
/// once and cleared; why the model stage stopped stays until it runs again; and why Codex's hook was not installed.
pub fn status_lines(ctx: &Ctx) -> (Vec<String>, Vec<String>) {
    if !util::edge_inference() {
        return (vec![], vec![]);
    }
    let mut warnings = vec![];
    let _ = update_state(&ctx.tool, true, |s| {
        s.arrived = None;
        if enabled(ctx) {
            warnings.extend(Warning::of(s, now_secs()).map(|w| w.full));
        }
        s.failure = None;
    });
    warnings.extend(codex_skipped_line(&ctx.root));
    // This repository's technologies, as the status run just synced them.
    let techs = stack::detect(&ctx.root)
        .map(|st| onboarding::candidates(ctx, &st))
        .unwrap_or_default();
    (warnings, freshness_lines(&ctx.cache, &techs, now_secs()))
}

/// How long ago, roughly: `5 min ago`, `3 h ago`, `2 days ago`.
fn ago(then: u64, now: u64) -> String {
    let m = now.saturating_sub(then) / 60;
    match m {
        0 => "just now".into(),
        1..60 => format!("{m} min ago"),
        60..2_880 => format!("{} h ago", m / 60),
        _ => format!("{} days ago", m / 1_440),
    }
}

/// Seconds since 1970 for an RFC 3339 UTC time (`2026-10-01T18:05:00.000Z`); fractions are dropped.
fn iso_secs(s: &str) -> Option<i64> {
    let days = util::parse_date(s.get(..10)?)?;
    let t = s.get(11..19)?;
    let mut parts = t.split(':').map(|p| p.parse::<i64>().ok());
    let (h, m, sec) = (parts.next()??, parts.next()??, parts.next()??);
    (s.as_bytes().get(10) == Some(&b'T')).then_some(days * 86_400 + h * 3_600 + m * 60 + sec)
}

/// `45m`, `3h 10m`, `2d 4h`.
fn span(secs: i64) -> String {
    let m = secs.max(0) / 60;
    match m {
        0..60 => format!("{m}m"),
        60..1_440 if m % 60 == 0 => format!("{}h", m / 60),
        60..1_440 => format!("{}h {}m", m / 60, m % 60),
        _ if m % 1_440 < 60 => format!("{}d", m / 1_440),
        _ => format!("{}d {}h", m / 1_440, m % 1_440 / 60),
    }
}

/// The median and 90th percentile (nearest rank) of `v`, which is not empty.
fn median_p90(v: &mut [i64]) -> (i64, i64) {
    v.sort_unstable();
    let at = |q: f64| v[((q * v.len() as f64).ceil() as usize).clamp(1, v.len()) - 1];
    (at(0.5), at(0.9))
}

/// How long the last 30 days' releases of this repository's technologies took to reach this machine: from the registry
/// to the catalog (central's timestamps on each change event), then from the catalog to this machine (when this
/// machine first synced the event). Two short lines, aligned with the rest of status's block; none when no release
/// arrived (nothing the reader would do with it). Local only; nothing is sent. Releases already published when this
/// machine began following a technology, and those central backfilled, are left out.
pub fn freshness_lines(cache: &Path, techs: &BTreeSet<String>, now: u64) -> Vec<String> {
    use crate::setup::view::labelled;
    // Per release, its earliest event: (registry publish, catalog publish, synced here).
    let mut releases: std::collections::BTreeMap<String, (Option<i64>, i64, i64)> =
        Default::default();
    for t in techs {
        let synced = cache::events_synced(cache, t);
        let Ok(Some(events)) = cache::load_events(cache, t) else {
            continue;
        };
        for e in events.events.iter().filter(|e| !e.freshness.backfilled) {
            let Some(&here) = synced
                .get(&e.id)
                .filter(|&&at| at > 0 && now.saturating_sub(at) <= 30 * 86_400)
            else {
                continue;
            };
            let Some(published) = iso_secs(&e.freshness.first_published) else {
                continue;
            };
            let registry = e.freshness.registry_published.as_deref().and_then(iso_secs);
            let r = releases
                .entry(format!("{}@{}", e.technology, e.version))
                .or_insert((registry, published, here as i64));
            r.0 = r.0.or(registry);
            r.1 = r.1.min(published);
            r.2 = r.2.min(here as i64);
        }
    }
    if releases.is_empty() {
        return vec![];
    }
    let n = releases.len();
    let mut central: Vec<i64> = releases
        .values()
        .filter_map(|(r, p, _)| r.map(|r| p - r))
        .collect();
    let mut local: Vec<i64> = releases.values().map(|(_, p, h)| h - p).collect();
    let scope = format!(
        " ({n} {}, last 30 days)",
        if n == 1 { "release" } else { "releases" }
    );
    let typical = |v: &mut [i64]| {
        let (m, p) = median_p90(v);
        format!("{} median, {} for the slowest tenth", span(m), span(p))
    };
    let central = if central.is_empty() {
        "unknown".to_string()
    } else {
        typical(&mut central)
    };
    vec![
        labelled("Registry to catalog", &format!("{central}{scope}")),
        labelled("Catalog to here", &typical(&mut local)),
    ]
}

// ------------------------------------------------------------------------------------------------ installation

/// Codex's project hooks file. It names this machine's executable, so it is excluded from Git, and a copy Git tracks
/// is never written to.
pub const CODEX_HOOKS_PATH: &str = ".codex/hooks.json";
pub const CODEX_HOOKS_EXCLUDE_LINE: &str = "/.codex/hooks.json";
/// The arguments of Codex's hook command, after the executable.
pub const CODEX_HOOK_ARGS: &str = "notify";
/// opencode's plugin, loaded from `.opencode/plugins/` at startup.
pub const OPENCODE_PLUGIN_PATH: &str = ".opencode/plugins/unstale-session.js";
pub const OPENCODE_PLUGIN_EXCLUDE_LINE: &str = "/.opencode/plugins/unstale-session.js";
const MARKER: &str = "Managed by unstale; regenerated from .unstale.";

fn exclude(root: &Path, line: &str) -> Result<()> {
    if let Some(p) = crate::git(root, &["rev-parse", "--git-path", "info/exclude"]) {
        let p = PathBuf::from(p.trim());
        let path = if p.is_absolute() { p } else { root.join(p) };
        let old = std::fs::read_to_string(&path).unwrap_or_default();
        if !old.lines().any(|l| l == line) {
            let sep = if old.is_empty() || old.ends_with('\n') {
                ""
            } else {
                "\n"
            };
            util::write_atomic(&path, format!("{old}{sep}{line}\n").as_bytes())?;
        }
    }
    Ok(())
}

/// Whether the repository's `.codex/config.toml` defines hooks inline: Codex warns when a layer has both forms, so
/// then no `hooks.json` is added.
fn codex_inline_hooks(root: &Path) -> bool {
    std::fs::read_to_string(root.join(".codex/config.toml"))
        .ok()
        .and_then(|t| t.parse::<toml::Table>().ok())
        .is_some_and(|t| t.contains_key("hooks"))
}

/// Why Codex's hook is not installed here, or `None` when it is (or may be).
fn codex_skipped(root: &Path) -> Option<&'static str> {
    if codex_inline_hooks(root) {
        return Some(".codex/config.toml defines hooks inline");
    }
    use crate::hooks::Skipped::*;
    let installed = std::fs::read_to_string(root.join(CODEX_HOOKS_PATH))
        .ok()
        .is_some_and(|t| crate::hooks::remove(&t, CODEX_HOOK_ARGS).is_some());
    if installed {
        return None;
    }
    match crate::hooks::unwritable(root, CODEX_HOOKS_PATH) {
        Some(Tracked) => Some(".codex/hooks.json is tracked by Git"),
        Some(ReadOnly) => Some(".codex/hooks.json is read-only"),
        Some(Symlink) => Some(".codex/hooks.json is a link to another file"),
        Some(Unreadable) => Some(".codex/hooks.json cannot be read"),
        Some(NotAnObject) => Some(CODEX_NOT_JSON),
        // Writable, and still without our hook: the installer could not read it as the JSON object Codex expects
        // (comments, a syntax error, another shape), so it left the user's bytes alone.
        None => root
            .join(CODEX_HOOKS_PATH)
            .is_file()
            .then_some(CODEX_NOT_JSON),
    }
}

const CODEX_NOT_JSON: &str = ".codex/hooks.json is not plain JSON with a \"hooks\" object (comments, a syntax error or another shape)";

/// The `unstale status` line when Codex's session start could not be installed.
fn codex_skipped_line(root: &Path) -> Option<String> {
    if !root.join(".agents/skills/unstale-review").is_dir() {
        return None;
    }
    codex_skipped(root).map(|why| format!("Codex session start not installed: {why}"))
}

/// Codex: a `SessionStart` command hook in `.codex/hooks.json`, added to the user's file without changing its other
/// bytes (`hooks`). Codex runs a project hook only once the user trusts it (`/hooks`; it says so at startup), and again
/// after it changes. Not when the repository's `.codex/config.toml` defines hooks inline, nor in a file Git tracks, a
/// read-only file, or one that does not parse.
pub fn install_codex_hook(ctx: &Ctx) -> Result<()> {
    if codex_inline_hooks(&ctx.root) {
        return Ok(());
    }
    let command = format!("{} {CODEX_HOOK_ARGS}", crate::hooks::invocation_word());
    if crate::hooks::install(&ctx.root, CODEX_HOOKS_PATH, &command, CODEX_HOOK_ARGS, 5)?.is_ok() {
        exclude(&ctx.root, CODEX_HOOKS_EXCLUDE_LINE)?;
    }
    Ok(())
}

/// The opencode plugin's source: at a session's start it starts `unstale notify` and does not wait for it; nothing it
/// does can throw into opencode. opencode adds no hook output to the agent's context, so the line is not shown there;
/// the sync still runs. The executable is passed as separate arguments, never through a shell.
///
/// One default export serves both plugin APIs, the shape opencode's V1 migration guide gives: opencode 2.x requires a
/// default export with an `id` and `setup` (it refuses the 1.x named-export function: "Plugin must export a default
/// definition"), and opencode 1.x from 1.18.29 runs its `server`. 2.x does not send `session.created` to a plugin
/// when `opencode run` creates the session in the request that starts the server, so a session's first
/// `session.execution.started` counts as its start too, once per session.
pub fn opencode_plugin(argv: &[String]) -> String {
    let argv = serde_json::to_string(argv).unwrap_or_else(|_| "[]".into());
    const SOURCE: &str = r#"// MARKER
// At session start, runs the catalog sync in the background (`unstale notify`); never awaited, never throws.
// opencode 2.x runs `setup`; opencode 1.x (1.18.29 and later) runs `server`.
import { spawn } from "node:child_process";
const UNSTALE = ARGV;
const sync = (directory) => {
  try {
    const child = spawn(UNSTALE[0], [...UNSTALE.slice(1), "-C", directory ?? ".", "notify"], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
};
export default {
  id: "unstale-session",
  async setup(ctx) {
    const directory = ctx?.location?.directory;
    const started = new Set();
    const controller = new AbortController();
    (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event?.type !== "session.created" && event?.type !== "session.execution.started") continue;
          const id = event.data?.sessionID ?? event.data?.info?.id ?? event.data?.id;
          if (started.has(id)) continue;
          started.add(id);
          sync(directory);
        }
      } catch {}
    })();
    return () => controller.abort();
  },
  async server(input) {
    return {
      event: async ({ event }) => {
        if (event?.type === "session.created") sync(input?.directory);
      },
    };
  },
};
"#;
    SOURCE.replacen("MARKER", MARKER, 1).replacen("ARGV", &argv, 1)
}

/// opencode: the plugin, written only where no file of the user's stands (nor a tracked, read-only or linked one),
/// and excluded from Git (it names this machine's executable).
pub fn install_opencode_plugin(ctx: &Ctx) -> Result<()> {
    if crate::hooks::unwritable(&ctx.root, OPENCODE_PLUGIN_PATH).is_some() {
        return Ok(());
    }
    let path = ctx.root.join(OPENCODE_PLUGIN_PATH);
    let old = match std::fs::read_to_string(&path) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Ok(()),
    };
    if old.as_deref().is_some_and(|t| !t.contains(MARKER)) {
        return Ok(());
    }
    let text = opencode_plugin(&onboarding::invocation_argv());
    if old.as_deref() != Some(text.as_str()) {
        util::write_atomic(&path, text.as_bytes())?;
    }
    exclude(&ctx.root, OPENCODE_PLUGIN_EXCLUDE_LINE)
}

/// opencode's `/unstale-review`. opencode 2.x offers only command files as slash commands, not skills, and hides a
/// skill marked `disable-model-invocation` from its agent, so without this file `/unstale-review` reaches the agent as
/// plain text (checked against opencode 2.2.7). Like the skills it is committed in shared mode and excluded from Git
/// in personal mode.
pub const OPENCODE_COMMAND_PATH: &str = ".opencode/commands/unstale-review.md";
pub const OPENCODE_COMMAND_EXCLUDE_LINE: &str = "/.opencode/commands/unstale-review.md";

/// The command points at the review skill rather than copying it: opencode expands `$`, `!` and `@` in a command's
/// body, and the skill's text is not written for that.
pub fn opencode_command() -> String {
    format!(
        "---\ndescription: Review upstream dependency changes against this repository and recommend what to act on\n---\n\n\
Read `.unstale/skills/review/SKILL.md` and follow it. $ARGUMENTS\n\n<!-- {MARKER} -->\n"
    )
}

/// Writes the command unless a file of the user's stands there, or the path runs through a link: `false` then.
pub fn install_opencode_command(ctx: &Ctx) -> Result<bool> {
    let path = ctx.root.join(OPENCODE_COMMAND_PATH);
    let linked = path
        .ancestors()
        .take_while(|p| *p != ctx.root)
        .any(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()));
    let old = std::fs::read_to_string(&path).ok();
    if linked || (path.exists() && !old.as_deref().is_some_and(|t| t.contains(MARKER))) {
        return Ok(false);
    }
    let text = opencode_command();
    // Where it cannot be written (`.opencode` a file, a directory that cannot be written): a conflict, as for a file
    // of the user's, and the rest of the integration goes on.
    if old.as_deref() != Some(text.as_str()) && util::write_atomic(&path, text.as_bytes()).is_err() {
        return Ok(false);
    }
    if ctx.config.mode == crate::Mode::Local {
        exclude(&ctx.root, OPENCODE_COMMAND_EXCLUDE_LINE)?;
    } else if let Some(p) = crate::git(&ctx.root, &["rev-parse", "--git-path", "info/exclude"]) {
        let p = PathBuf::from(p.trim());
        let p = if p.is_absolute() { p } else { ctx.root.join(p) };
        let old = std::fs::read_to_string(&p).unwrap_or_default();
        if old.lines().any(|l| l == OPENCODE_COMMAND_EXCLUDE_LINE) {
            let text: String = old
                .lines()
                .filter(|l| *l != OPENCODE_COMMAND_EXCLUDE_LINE)
                .map(|l| format!("{l}\n"))
                .collect();
            util::write_atomic(&p, text.as_bytes())?;
        }
    }
    Ok(true)
}

/// Codex runs a project hook only once the user trusts it, which only they can do: the one line that names the step,
/// said once per repository, after the hook is installed. `None` when there is no hook of ours, it was said, or Codex
/// is not on this machine.
pub fn codex_trust_line(ctx: &Ctx) -> Option<String> {
    let said = ctx.tool.join("state/codex-hook-trust-said");
    let ours = std::fs::read_to_string(ctx.root.join(CODEX_HOOKS_PATH))
        .is_ok_and(|t| crate::hooks::remove(&t, CODEX_HOOK_ARGS).is_some());
    if !ours || said.exists() || !crate::setup::codex_on_path() {
        return None;
    }
    util::write_atomic(&said, b"said\n").ok()?;
    Some(
        "Codex: to let unstale sync at session start, trust its hook once: run /hooks in Codex."
            .into(),
    )
}

/// Uninstall: our Codex hook entry (the user's bytes kept), opencode plugin and opencode command, each backed up
/// first.
pub fn uninstall_hooks(root: &Path, backup: &Path) -> Result<()> {
    crate::hooks::uninstall(root, CODEX_HOOKS_PATH, CODEX_HOOK_ARGS, backup)?;
    for rel in [OPENCODE_PLUGIN_PATH, OPENCODE_COMMAND_PATH] {
        let file = root.join(rel);
        if !std::fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_symlink())
            && let Ok(text) = std::fs::read_to_string(&file)
            && text.contains(MARKER)
        {
            let dest = backup.join(rel);
            std::fs::create_dir_all(dest.parent().unwrap())?;
            std::fs::write(&dest, &text)?;
            std::fs::remove_file(&file)?;
            let _ = std::fs::remove_dir(file.parent().unwrap());
            let _ = std::fs::remove_dir(file.parent().unwrap().parent().unwrap());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_start_line_says_what_is_new_and_the_command() {
        let names = |n: usize| -> Vec<String> {
            ["next", "react", "vite", "zod"][..n]
                .iter()
                .map(|s| s.to_string())
                .collect()
        };
        assert_eq!(
            new_changes_line(1, &names(1)),
            "unstale: 1 new upstream change for next. Run `unstale status --wait 0` to see them."
        );
        assert_eq!(
            new_changes_line(3, &names(2)),
            "unstale: 3 new upstream changes for next and react. Run `unstale status --wait 0` to see them."
        );
        let most = new_changes_line(120, &names(4));
        assert_eq!(
            most,
            "unstale: 120 new upstream changes for next and 3 more. Run `unstale status --wait 0` to see them."
        );
        // Short: what the agent does with it is in the managed skill.
        assert!(most.chars().count() <= 100, "{most}");
    }

    #[test]
    fn a_warning_is_compared_by_kind_and_its_session_start_line_carries_no_raw_error_or_path() {
        let failed = |why: &str, at: u64| State {
            failure: Some(why.into()),
            last_attempt: Some(at),
            ..State::default()
        };
        // An unusual failure: the detail (a raw error, a path) is for `unstale status` only.
        let raw = "next could not be synced: reading /Users/someone/.cache/unstale/v1/tech/next.json: Permission denied (os error 13)";
        let w = Warning::of(&failed(raw, 1_000), 1_000 + 7_200).unwrap();
        assert_eq!(
            w.short,
            "warning: the sync at session start failed, so newer changes are missing. `unstale status` says why."
        );
        assert_eq!(
            w.full,
            format!(
                "warning: the sync at session start failed 2 h ago: {raw}. The next session start tries again."
            )
        );
        // The same trouble a day later, with another wording of the error, is the same kind: not said again.
        let later = Warning::of(
            &failed("react could not be synced: timeout x", 90_000),
            200_000,
        )
        .unwrap();
        assert_eq!((w.kind.as_str(), later.kind.as_str()), ("sync", "sync"));
        assert_ne!(w.full, later.full);
        for why in [SLOW, UNREACHABLE] {
            let w = Warning::of(&failed(why, 5), 10).unwrap();
            assert!(
                w.short.chars().count() <= 102 && !w.short.contains('/'),
                "{}",
                w.short
            );
            assert_ne!(w.kind, "sync");
        }
        // Why the model stage stopped is already one plain line; a failed sync comes first.
        let line = crate::inference::Deferred::CodexLoggedOut.line();
        let stopped = State {
            deferred: Some(line.clone()),
            ..State::default()
        };
        assert_eq!(Warning::of(&stopped, 0).unwrap().short, line);
        assert_eq!(Warning::of(&State::default(), 0), None);
    }

    #[test]
    fn times_and_spans_read_plainly() {
        assert_eq!(iso_secs("1970-01-02T01:02:03.456Z"), Some(86_400 + 3_723));
        assert_eq!(iso_secs("2026-10-01"), None);
        assert_eq!(iso_secs("2026-10-01 18:05:00Z"), None);
        assert_eq!(
            [0, 59 * 60, 3_600, 3_660 + 59, 86_400, 86_400 + 4 * 3_600].map(span),
            ["0m", "59m", "1h", "1h 1m", "1d", "1d 4h"]
        );
        assert_eq!(span(-5), "0m");
        assert_eq!(median_p90(&mut [5, 1, 4, 2, 3, 6, 7, 8, 9, 10]), (5, 9));
        assert_eq!(median_p90(&mut [7]), (7, 7));
        assert_eq!(
            [ago(0, 30), ago(0, 7_200), ago(0, 3 * 86_400)],
            ["just now", "2 h ago", "3 days ago"]
        );
    }

    #[test]
    fn concurrent_state_changes_are_never_lost() {
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path().join(".unstale");
        std::fs::create_dir_all(tool.join("state")).unwrap();
        std::fs::write(tool.join("config.json"), "{}").unwrap();
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let tool = tool.clone();
                std::thread::spawn(move || {
                    for _ in 0..10 {
                        update_state(&tool, true, |s| {
                            let a = s.arrived.get_or_insert_with(Arrived::default);
                            a.records += 1;
                            a.technologies.insert(format!("t{i}"));
                            std::thread::yield_now();
                        })
                        .unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let a = read_state(&tool).arrived.unwrap();
        assert_eq!((a.records, a.technologies.len()), (80, 8));
    }

    #[test]
    fn only_manifests_and_lockfiles_count_for_the_stack() {
        for f in [
            "package.json",
            "pnpm-lock.yaml",
            "Cargo.lock",
            "pyproject.toml",
            "requirements-dev.txt",
            ".npmrc",
        ] {
            assert!(stack_file(f), "{f}");
        }
        for f in ["README.md", "src.rs", "notes.txt", "tsconfig.json"] {
            assert!(!stack_file(f), "{f}");
        }
    }
}
