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

use crate::{Ctx, cache, git, inference, notice, onboarding, stack, sync, util};

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
    /// The manifest directories the last sync read and a fingerprint of their files, so a changed dependency starts
    /// a sync even while the catalog is unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<StackPrint>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct StackPrint {
    pub dirs: Vec<String>,
    pub print: String,
}

/// A fingerprint of the files directly in each manifest directory (name, size, modification time): cheap enough for
/// session start, and it changes with any manifest or lockfile there. A new project directory elsewhere is seen at
/// the next catalog change.
fn stack_print(root: &Path, dirs: &[String]) -> String {
    let mut lines = vec![];
    for d in dirs {
        let Ok(rd) = std::fs::read_dir(root.join(d)) else {
            lines.push(format!("{d} -"));
            continue;
        };
        for e in rd.flatten() {
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
            lines.push(format!(
                "{d}/{} {} {modified}",
                e.file_name().to_string_lossy(),
                m.len()
            ));
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
        // The repository's own manifests changed: a sync is due whatever the catalog says (no request needed).
        let stack_changed = state
            .stack
            .as_ref()
            .is_none_or(|p| stack_print(&ctx.root, &p.dirs) != p.print);
        let due = if stack_changed {
            Ok(true)
        } else {
            match sync::quick_check(
                &ctx.config.catalog,
                &ctx.cache,
                &techs,
                util::edge_inference(),
                CATALOG_TIMEOUT,
            ) {
                Ok(sync::Quick::Changed) => Ok(true),
                Ok(sync::Quick::Unchanged) => Ok(inference::enabled() && model_work_pending(&ctx)),
                Err(e) => Err(e),
            }
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
            // Technologies that failed stay in the set: their cached index differs from the list, so the next quick
            // check retries them.
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
    let techs: BTreeSet<String> = state.technologies.iter().cloned().collect();
    state.deferred = model_stage(ctx, &techs).map(|d| d.line());
    let _ = write_state(&ctx.tool, &state);
    Ok(0)
}

/// The background stage's lock for this repository: `None` when another holds it (or it cannot be taken).
fn repo_lock(tool: &Path) -> Option<std::fs::File> {
    let p = tool.join("state/session-sync.lock");
    if !tool.join("config.json").is_file() {
        return None;
    }
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
    if util::edge_inference() {
        let techs: BTreeSet<String> = state.technologies.iter().cloned().collect();
        println!("{}", freshness_line(&ctx.cache, &techs, now_secs()));
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
/// machine first synced the event), then to records made here (not yet: the client's own model steps come later).
/// Local only; nothing is sent. Releases already published when this machine began following a technology, and those
/// central backfilled, are left out.
pub fn freshness_line(cache: &Path, techs: &BTreeSet<String>, now: u64) -> String {
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
        return "Freshness on this machine: no new release of this repository's technologies reached it in the last 30 days".into();
    }
    let n = releases.len();
    let mut central: Vec<i64> = releases
        .values()
        .filter_map(|(r, p, _)| r.map(|r| p - r))
        .collect();
    let mut local: Vec<i64> = releases.values().map(|(_, p, h)| h - p).collect();
    let central = if central.is_empty() {
        "registry to catalog unknown".to_string()
    } else {
        let (m, p) = median_p90(&mut central);
        format!(
            "registry to catalog {} median ({} at the 90th percentile)",
            span(m),
            span(p)
        )
    };
    let (m, p) = median_p90(&mut local);
    format!(
        "Freshness on this machine, last 30 days ({n} {}): {central} · catalog to here {} median ({} at the 90th percentile) · records made here: not yet",
        if n == 1 { "release" } else { "releases" },
        span(m),
        span(p)
    )
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

// ------------------------------------------------------------------------------------------------ installation

/// Codex's project hooks file. It names this machine's executable, so it is excluded from Git, and a copy Git tracks
/// is never written to (the skill still tells the agent to sync).
pub const CODEX_HOOKS_PATH: &str = ".codex/hooks.json";
pub const CODEX_HOOKS_EXCLUDE_LINE: &str = "/.codex/hooks.json";
/// opencode's plugin, loaded from `.opencode/plugins/` at startup.
pub const OPENCODE_PLUGIN_PATH: &str = ".opencode/plugins/unstale-session.js";
pub const OPENCODE_PLUGIN_EXCLUDE_LINE: &str = "/.opencode/plugins/unstale-session.js";
const MARKER: &str = "Managed by unstale; regenerated from .unstale.";

fn through_symlink(root: &Path, p: &Path) -> bool {
    p.ancestors()
        .take_while(|a| *a != root)
        .any(|a| std::fs::symlink_metadata(a).is_ok_and(|m| m.file_type().is_symlink()))
}

fn tracked(root: &Path, rel: &str) -> bool {
    git(root, &["ls-files", "--error-unmatch", "--", rel]).is_some()
}

fn exclude(root: &Path, line: &str) -> Result<()> {
    if let Some(p) = git(root, &["rev-parse", "--git-path", "info/exclude"]) {
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

/// Codex: a `SessionStart` command hook in `.codex/hooks.json`, beside the user's own entries (ours replaced, not
/// repeated). Codex runs a project hook only once the user trusts it (`/hooks`; it says so at startup), and again after
/// it changes. A file that does not parse, or one Git tracks, is left alone.
pub fn install_codex_hook(ctx: &Ctx) -> Result<()> {
    let path = ctx.root.join(CODEX_HOOKS_PATH);
    if through_symlink(&ctx.root, &path) || tracked(&ctx.root, CODEX_HOOKS_PATH) {
        return Ok(());
    }
    let mut hooks: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(v @ serde_json::Value::Object(_)) => v,
            _ => return Ok(()),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        // Unreadable: the user's file, never replaced.
        Err(_) => return Ok(()),
    };
    onboarding::remove_own_hooks(&mut hooks);
    let Some(events) = hooks
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
    else {
        return Ok(());
    };
    let Some(starts) = events
        .entry("SessionStart")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
    else {
        return Ok(());
    };
    let command = format!("{} notify", onboarding::invocation());
    starts.push(
        serde_json::json!({"hooks": [{"type": "command", "command": command, "timeout": 5}]}),
    );
    let text = format!("{}\n", serde_json::to_string_pretty(&hooks)?);
    if std::fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
        util::write_atomic(&path, text.as_bytes())?;
    }
    exclude(&ctx.root, CODEX_HOOKS_EXCLUDE_LINE)
}

/// The opencode plugin's source: on `session.created` it starts `unstale notify` and does not wait for it; nothing it
/// does can throw into opencode. opencode adds no hook output to the agent's context, so the line is not shown there;
/// the sync still runs.
pub fn opencode_plugin(argv: &[String]) -> String {
    let argv = serde_json::to_string(argv).unwrap_or_else(|_| "[]".into());
    format!(
        "// {MARKER}\n\
// At session start, runs the catalog sync in the background (`unstale notify`); never awaited, never throws.\n\
const UNSTALE = {argv};\n\
export const UnstaleSessionSync = async ({{ $, directory }}) => ({{\n\
  event: async ({{ event }}) => {{\n\
    if (event?.type !== \"session.created\") return;\n\
    try {{\n\
      $`${{UNSTALE}} -C ${{directory ?? \".\"}} notify`.quiet().nothrow().catch(() => {{}});\n\
    }} catch {{}}\n\
  }},\n\
}});\n"
    )
}

/// opencode: the plugin, written only where no file of the user's stands, and excluded from Git (it names this
/// machine's executable).
pub fn install_opencode_plugin(ctx: &Ctx) -> Result<()> {
    let path = ctx.root.join(OPENCODE_PLUGIN_PATH);
    if through_symlink(&ctx.root, &path) || tracked(&ctx.root, OPENCODE_PLUGIN_PATH) {
        return Ok(());
    }
    let old = std::fs::read_to_string(&path).ok();
    if old.as_deref().is_some_and(|t| !t.contains(MARKER)) {
        return Ok(());
    }
    let text = opencode_plugin(&onboarding::invocation_argv());
    if old.as_deref() != Some(text.as_str()) {
        util::write_atomic(&path, text.as_bytes())?;
    }
    exclude(&ctx.root, OPENCODE_PLUGIN_EXCLUDE_LINE)
}

/// Uninstall: our Codex hook entry and opencode plugin, each backed up first; the user's entries and files stay.
pub fn uninstall_hooks(root: &Path, backup: &Path) -> Result<()> {
    let codex = root.join(CODEX_HOOKS_PATH);
    if !through_symlink(root, &codex)
        && let Ok(text) = std::fs::read_to_string(&codex)
        && let Ok(mut hooks) = serde_json::from_str::<serde_json::Value>(&text)
        && onboarding::remove_own_hooks(&mut hooks)
    {
        let dest = backup.join(CODEX_HOOKS_PATH);
        std::fs::create_dir_all(dest.parent().unwrap())?;
        std::fs::write(&dest, &text)?;
        if hooks.as_object().is_some_and(|o| o.is_empty()) {
            std::fs::remove_file(&codex)?;
            let _ = std::fs::remove_dir(codex.parent().unwrap());
        } else {
            util::write_atomic(
                &codex,
                format!("{}\n", serde_json::to_string_pretty(&hooks)?).as_bytes(),
            )?;
        }
    }
    let plugin = root.join(OPENCODE_PLUGIN_PATH);
    if !through_symlink(root, &plugin)
        && let Ok(text) = std::fs::read_to_string(&plugin)
        && text.contains(MARKER)
    {
        let dest = backup.join(OPENCODE_PLUGIN_PATH);
        std::fs::create_dir_all(dest.parent().unwrap())?;
        std::fs::write(&dest, &text)?;
        std::fs::remove_file(&plugin)?;
        let _ = std::fs::remove_dir(plugin.parent().unwrap());
        let _ = std::fs::remove_dir(plugin.parent().unwrap().parent().unwrap());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
