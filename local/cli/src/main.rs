//! `unstale`: the client. Stack detection, catalog sync, ranking, reports and the agent integration; the catalog
//! service is `central/`.

mod advisories;
mod cache;
mod cache_gc;
mod cargo;
mod deprecations;
mod onboarding;
mod onboarding_ui;
mod pipeline;
mod privacy;
mod prompts;
mod pypi;
mod uninstall;
mod funnel;
mod hooks;
mod inference;
mod lines;
mod maintenance;
mod notice;
mod ledgerops;
mod review;
mod setup;
mod session;
mod stack;
mod sync;
#[cfg(test)]
mod testcat;
mod usage;
mod workarounds;
mod util;
mod warn;

use anyhow::{Context, Result, anyhow, bail};
use clap::{Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::rc::Rc;

use crate::cache::{Catalog, Lookup};
use crate::funnel::{Input, Outcome};
use crate::ledgerops::{Disposition, LedgerFile};
use crate::review::{Pass, State};

const EXIT_ERROR: u8 = 1;
const EXIT_INCOMPLETE: u8 = 3;
const EXIT_INCOMPATIBLE: u8 = 4;
const EXIT_LEDGER: u8 = 5;

#[derive(Parser)]
#[command(
    name = "unstale",
    version,
    about = "Keeps a repository current with verified changes in the libraries and frameworks it uses.",
    after_help = "Exit codes: 0 ok; 1 error; 2 usage; 3 a review batch is incomplete (--next); 4 the catalog needs a newer unstale (cache kept); 5 the ledger has invalid lines.\n\nUNSTALE_NO_REGISTRY=1 turns off every third-party lookup (npm, PyPI, and Cargo/crates.io registries; OSV advisories), and with it new coverage registrations. Packages from a private registry are never named to anyone either way."
)]
struct Cli {
    /// Run as if started in this directory.
    #[arg(short = 'C', long = "dir", global = true)]
    dir: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Set up unstale in this repository: catalog location, mode, and the tool directory `.unstale/`.
    Init {
        /// Catalog location: a directory or file:// URL (default: $UNSTALE_CATALOG).
        #[arg(long)]
        catalog: Option<String>,
        /// Personal (decisions and generated review context stay out of Git; the default) or shared (ledger and generated review context committed).
        #[arg(long, value_enum)]
        mode: Option<Mode>,
        /// Accept defaults (setup is noninteractive by default).
        #[arg(long)]
        yes: bool,
        /// Shared public technology coverage service (or $UNSTALE_SERVICE).
        #[arg(long)]
        service: Option<String>,
        /// Seconds this run may take: setup and following coverage share them, and the report is written in the time left. 0 or no value follows no coverage, and setup is bounded at 300; setup always gets at least 60.
        #[arg(long)]
        wait: Option<u64>,
        /// Print stable stage lines without decorative motion.
        #[arg(long)]
        no_animation: bool,
        /// Where model steps run, without asking (CI): see `unstale setup --help`.
        #[arg(long, value_name = "CHOICE")]
        inference: Option<String>,
    },
    /// Choose how new release notes are read: your own key or your Codex plan. Asks once at a terminal; without one,
    /// prints the options and the command that records each.
    Setup {
        /// Record a choice without asking: vercel, openai, openrouter, anthropic, env:NAME (a key variable), codex or
        /// none; jev+ before a key or codex adds Jev for labels (for example jev+env:OPENAI_API_KEY); subq+ before a key
        /// adds Snap for matching (for example subq+env:OPENAI_API_KEY).
        #[arg(long, value_name = "CHOICE")]
        inference: Option<String>,
        /// Save in your user config instead of this repository's.
        #[arg(long)]
        user: bool,
        /// Print each option's full figures (unit cost, first sync, tokens, quality) and ask nothing.
        #[arg(long)]
        details: bool,
        /// The monthly token limit: a number of tokens (48M, 500k), none, or default. Past it, new release notes wait
        /// for next month.
        #[arg(long, value_name = "TOKENS")]
        limit: Option<String>,
    },
    /// Refresh public coverage and print a compact setup summary; full evidence stays in the report.
    Status {
        #[arg(long, default_value_t = 0)]
        wait: u64,
        #[arg(long)]
        no_animation: bool,
    },
    /// Remove this repository integration; keep a local backup of decisions and generated context.
    Uninstall,
    /// Agent session start: at most one line when something new is ready, silent otherwise; never fails. Starts the
    /// catalog sync in the background when the catalog may have changed.
    Notify,
    /// The session-start background stage, run now: the catalog sync, then reading new release notes with your
    /// provider (what an agent's session-start hook starts; for a repository without one).
    SessionSync,
    /// Show the saved detailed onboarding report without rerunning setup or coverage.
    Report,
    /// Fetch this stack's technology indexes and shards into the per-user cache (verified, swapped atomically).
    Sync,
    /// Print the bump digest: what each package bump picks up (deterministic; no model, no network).
    Digest,
    /// Prepare unstale-review and its current upgrade and opportunity batches.
    Review {
        /// Hand out the next batch (only when every record of the current one has a disposition).
        #[arg(long)]
        next: bool,
        /// Upgrade target, e.g. `next@16.1.0` (default: the newest release in the catalog). Repeatable.
        #[arg(long, value_name = "PKG@VERSION")]
        target: Vec<String>,
        /// Only this pass: upgrade-review or improvements-pass (default: both).
        #[arg(long)]
        pass: Option<Pass>,
    },
    /// Record a user's decision on a proposal: do-now, later (deferred 30 days) or decline.
    Decide {
        id: String,
        #[arg(value_enum)]
        decision: Decision,
        #[arg(long)]
        note: Option<String>,
    },
    /// Record a disposition: declined, done, deferred or no-site.
    Record {
        id: String,
        disposition: String,
        #[arg(long)]
        note: Option<String>,
    },
    /// Print the records behind one package's bump digest line.
    Bump { pkg: String },
    /// Print every lockfile advisory that calls for action, one line each (the digest shows the worst groups).
    Advisories,
    /// Ledger maintenance.
    Ledger {
        #[command(subcommand)]
        cmd: LedgerCmd,
    },
    /// Central use only: for each term in a JSON array on stdin, how many of these repositories contain it (the
    /// funnel's own matching rule), as a JSON object on stdout.
    #[command(hide = true)]
    CountTerms {
        #[arg(long = "repo", required = true)]
        repos: Vec<PathBuf>,
    },
    /// Internal: one model call on a provider (tests and evals). Prints the answer as JSON, or one `warning: ...`
    /// line; exits 0 either way, and quietly when another worker on this machine holds the lock.
    #[command(hide = true)]
    Infer {
        /// openai, vercel, openrouter, anthropic, codex, or custom (with --base-url and --key-env).
        #[arg(long)]
        provider: String,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        base_url: Option<String>,
        #[arg(long)]
        key_env: Option<String>,
        /// JSON Schema of the answer.
        #[arg(long)]
        schema: Option<String>,
        #[arg(long)]
        timeout_secs: Option<u64>,
        #[arg(long)]
        backoff_ms: Option<u64>,
        prompt: String,
    },
    /// The per-user cache.
    Cache {
        #[command(subcommand)]
        cmd: CacheCmd,
    },
    /// Internal: the client's model steps, for evals and tests.
    #[command(hide = true)]
    Internal {
        #[command(subcommand)]
        cmd: InternalCmd,
    },
    /// sync, then digest, then review.
    Run {
        #[arg(long, value_name = "PKG@VERSION")]
        target: Vec<String>,
    },
}

#[derive(Subcommand)]
enum CacheCmd {
    /// Delete everything the cache can fetch again; the usage record, uninstall backups and (unless `--results`) the
    /// model results stay. Says what it removes and asks first.
    Clean {
        /// Also delete the stored model results: reading those release notes again is paid for again.
        #[arg(long)]
        results: bool,
        /// Do not ask (needed without a terminal).
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum InternalCmd {
    /// One model step over a JSON-lines file (`extract`: change events), one JSON line out per item; a provider or
    /// budget problem prints one `{"deferred": ...}` line. Exits 0 either way, and quietly when another worker on this
    /// machine holds the lock. The provider is the stored choice unless `--provider` names one.
    RunStep {
        #[arg(long)]
        step: String,
        #[arg(long = "in")]
        input: PathBuf,
        /// openai, vercel, openrouter, anthropic, codex, jev, or custom (with --base-url, --key-env and --model).
        #[arg(long)]
        provider: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        base_url: Option<String>,
        #[arg(long)]
        key_env: Option<String>,
        #[arg(long)]
        timeout_secs: Option<u64>,
        #[arg(long)]
        backoff_ms: Option<u64>,
    },
}

#[derive(Subcommand)]
enum LedgerCmd {
    /// Validate every line; exits 5 on any invalid line.
    Check,
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum, Serialize, Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
enum Mode {
    // Named personal and shared everywhere a user reads them (`--help`, `init`, the README); `local` and
    // `collaborative` stay accepted, and are what config.json stores.
    #[value(name = "personal", alias = "local")]
    Local,
    #[value(name = "shared", alias = "collaborative")]
    Collaborative,
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum Decision {
    DoNow,
    Later,
    Decline,
}

#[derive(Serialize, Deserialize, Debug)]
struct Config {
    schema: u32,
    catalog: String,
    mode: Mode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    service: Option<String>,
    /// Where model steps run (`unstale setup`): the provider and the key's variable name, never its value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    inference: Option<setup::Choice>,
    /// The monthly token limit for model steps (`unstale setup --limit`): a number of tokens, or `"none"`. Absent, the
    /// default applies.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "setup::lenient_limit")]
    monthly_token_limit: Option<setup::Limit>,
    /// `false` turns off the catalog sync at agent session start (`session.rs`); absent or `true` keeps it on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_sync: Option<bool>,
}

struct Ctx {
    root: PathBuf,
    tool: PathBuf,
    config: Config,
    /// What this repository's catalog source gives, and what the model steps make of it (`cache::cache_for`).
    cache: PathBuf,
    /// The per-user cache itself: public registry metadata, the same whichever catalog a repository reads.
    registry: PathBuf,
}

const TOOL_DIR: &str = ".unstale";
const LEDGER_FILE: &str = "ledger.jsonl";
const GITATTR_LINE: &str = ".unstale/ledger.jsonl merge=union";

/// The service `init` uses by default in release builds. A `#[used]` static keeps it whole in the binary, which
/// release.yml checks: read in place, an x86-64 build splits a short constant into instruction immediates.
#[used]
static DEFAULT_SERVICE: Option<&str> = option_env!("UNSTALE_DEFAULT_SERVICE");

fn main() -> ExitCode {
    // The session-start hook's deadline counts from here.
    let started = std::time::Instant::now();
    let cli = Cli::parse();
    match dispatch(cli, started) {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(if e.downcast_ref::<sync::Incompatible>().is_some() { EXIT_INCOMPATIBLE } else { EXIT_ERROR })
        }
    }
}

fn start_dir(dir: &Option<PathBuf>) -> Result<PathBuf> {
    let d = match dir {
        Some(d) => d.clone(),
        None => std::env::current_dir()?,
    };
    d.canonicalize().with_context(|| format!("directory {}", d.display()))
}

fn dispatch(cli: Cli, started: std::time::Instant) -> Result<u8> {
    if let Cmd::CountTerms { repos } = &cli.cmd {
        return count_terms(repos);
    }
    if let Cmd::Infer { provider, model, base_url, key_env, schema, timeout_secs, backoff_ms, prompt } = cli.cmd {
        return cmd_infer(&provider, model, base_url, key_env, schema, timeout_secs, backoff_ms, prompt);
    }
    // Session start is never blocked or broken: the hook guards everything itself, before any step that can fail.
    if matches!(cli.cmd, Cmd::Notify) {
        return Ok(session::hook(cli.dir.as_deref(), started));
    }
    if let Cmd::Cache { cmd: CacheCmd::Clean { results, yes } } = cli.cmd {
        if !inference::enabled() {
            bail!("`unstale cache clean` is turned off by UNSTALE_EDGE_INFERENCE=0; unset it to turn it on.");
        }
        let mut ask = || {
            use std::io::IsTerminal;
            if !std::io::stdin().is_terminal() {
                return None;
            }
            print!("Remove them? [y/N] ");
            let _ = std::io::Write::flush(&mut std::io::stdout());
            let mut a = String::new();
            std::io::stdin().read_line(&mut a).ok()?;
            Some(matches!(a.trim(), "y" | "Y" | "yes"))
        };
        return Ok(cache_gc::clean_all(&cache::cache_dir(), results, yes, &mut ask, &mut |l| println!("{l}")));
    }
    let start = start_dir(&cli.dir)?;
    if matches!(cli.cmd, Cmd::Uninstall) { return uninstall::run(&start); }
    if let Cmd::Internal { cmd } = cli.cmd {
        return cmd_internal(cli.dir.as_deref(), cmd);
    }
    if let Cmd::Init { catalog, mode, yes, service, wait, no_animation, inference } = cli.cmd {
        // Only `init` adds agent integrations a repository does not have yet.
        onboarding::allow_adding();
        // Read before anything is written, so a mistyped choice changes nothing. With the switch off it is ignored.
        let choice = match inference.filter(|_| inference::enabled()) {
            Some(s) => Some(setup::parse_flag(&s).map_err(|e| anyhow!(e))?),
            None => None,
        };
        // An install script or a Git hook never chooses to spend on the user's key or plan.
        setup::refuse_from_hooks(choice.as_ref(), &setup::process_env)?;
        let service = service.or_else(|| std::env::var("UNSTALE_SERVICE").ok())
            .or_else(|| DEFAULT_SERVICE.filter(|s| !s.is_empty()).map(String::from));
        let catalog = catalog.or_else(|| std::env::var("UNSTALE_CATALOG").ok()).or_else(|| service.clone());
        let code = init(&start, catalog, mode, yes, service.is_some())?;
        let mut ctx = context(&start)?;
        setup::say_unseen(&ctx);
        if let Some(service) = service {
            sync::resolve_source(&service)?;
            ctx.config.service = Some(service);
            util::write_atomic(&ctx.tool.join("config.json"), &serde_json::to_vec_pretty(&ctx.config)?)?;
        }
        if inference::enabled() {
            setup::run(&mut ctx, choice, false, false, yes)?;
        }
        return if ctx.config.service.is_some() {
            onboarding::run(&ctx, wait.unwrap_or(0), !no_animation, false)
        } else {
            // Without the service there is no report, so the integrations are added here, as only `init` adds them.
            review::write_entrypoint(&ctx.tool).and_then(|_| onboarding::integrate(&ctx)).map(|_| code)
        }
            .inspect(|_| {
                if let Some(line) = refused_line() { println!("{line}"); }
                notice::print(&ctx.cache, &ctx.tool);
                // The one step only the user can take, said once.
                if inference::enabled() && let Some(line) = session::codex_trust_line(&ctx) { println!("{line}"); }
            });
    }
    let mut ctx = context(&start)?;
    // A choice an agent or a script made, said once to the first person who runs unstale at a terminal.
    setup::say_unseen(&ctx);
    // What this version adds that only `init` installs, said once per repository.
    if matches!(cli.cmd, Cmd::Status { .. } | Cmd::Sync | Cmd::Run { .. })
        && let Some(line) = onboarding::new_integrations_line(&ctx)
    {
        println!("{line}");
    }
    match cli.cmd {
        Cmd::Init { .. } | Cmd::CountTerms { .. } | Cmd::Uninstall | Cmd::Infer { .. } | Cmd::Notify | Cmd::Internal { .. } | Cmd::Cache { .. } => unreachable!(),
        Cmd::Setup { inference, user, details, limit } => {
            if !inference::enabled() {
                println!("Reading new release notes is turned off by UNSTALE_EDGE_INFERENCE=0; unset it to turn it on, then run `unstale setup`.");
                return Ok(0);
            }
            // Read before anything is written, so a mistyped value changes nothing.
            let choice = inference.map(|s| setup::parse_flag(&s).map_err(|e| anyhow!(e))).transpose()?;
            setup::refuse_from_hooks(choice.as_ref(), &setup::process_env)?;
            let limit = limit.map(|s| setup::parse_limit(&s).map_err(|e| anyhow!(e))).transpose()?;
            if details {
                setup::details(&ctx);
                return Ok(0);
            }
            // The limit is the user's own: always saved in their config.
            if let Some(l) = limit { setup::set_limit(&ctx, l)?; }
            // `--limit` alone changes the limit and asks nothing.
            if limit.is_none() || choice.is_some() { setup::run(&mut ctx, choice, true, user, false)?; }
            Ok(0)
        }
        Cmd::Report => {
            let text = std::fs::read_to_string(ctx.tool.join("onboarding-report.md")).context("No saved report yet; run unstale status")?;
            for line in text.lines() { println!("{}", line.chars().filter(|c| !c.is_control() || *c == '\t').collect::<String>()); }
            let ours = stack::detect(&ctx.root).map(|st| onboarding::candidates(&ctx, &st)).unwrap_or_default();
            if let Some(line) = pipeline::unrun_line(&ctx, &ours) { println!("{line}"); }
            Ok(0)
        },
        Cmd::Status { wait, no_animation } => {
            // What is wrong first, above the summary; the state after it. `status` always shows both, whatever was
            // already said elsewhere. Gathered when the run ends, so they describe what it left.
            let state = std::cell::RefCell::new(vec![]);
            let lead = || {
                let (warnings, s) = status_lines(&ctx);
                *state.borrow_mut() = s;
                warnings
            };
            onboarding::run_led(&ctx, wait, !no_animation, false, &lead).inspect(|_| {
                notice::print(&ctx.cache, &ctx.tool);
                for line in state.borrow().iter() { println!("{line}"); }
            })
        }
        Cmd::SessionSync => cmd_session_sync(&ctx),
        Cmd::Sync => cmd_sync(&ctx),
        Cmd::Digest => cmd_digest(&ctx),
        Cmd::Review { next, target, pass } => cmd_review(&ctx, next, &target, pass),
        Cmd::Decide { id, decision, note } => cmd_decide(&ctx, &id, decision, note),
        Cmd::Record { id, disposition, note } => {
            let d: Disposition = disposition.parse().map_err(|e: String| anyhow!(e))?;
            cmd_record(&ctx, &id, d, note)
        }
        Cmd::Bump { pkg } => cmd_bump(&ctx, &pkg),
        Cmd::Advisories => cmd_advisories(&ctx),
        Cmd::Ledger { cmd: LedgerCmd::Check } => cmd_ledger_check(&ctx),
        Cmd::Run { target } => cmd_run(&ctx, &target),
    }
}

/// How each of `techs` is named to the user: by the plain name its coverage job gives it (the catalog id
/// `zod-6ac59393` is `zod`), else its id, which a technology with no job has from its package. A name two of `techs`
/// share keeps the id beside it, `zod (zod-6ac59393)`, so the lines stay apart.
fn tech_labels<'a>(pending: &onboarding::Pending, techs: impl IntoIterator<Item = &'a String>) -> BTreeMap<String, String> {
    let mut plain: BTreeMap<String, String> = BTreeMap::new();
    for t in techs {
        let job = pending.jobs.values().find(|j| &j.technology == t).map(|j| util::one_line(&j.name, 100)).filter(|n| !n.is_empty());
        plain.insert(t.clone(), job.unwrap_or_else(|| t.clone()));
    }
    let mut uses: BTreeMap<&str, usize> = BTreeMap::new();
    for n in plain.values() {
        *uses.entry(n.as_str()).or_default() += 1;
    }
    plain
        .iter()
        .map(|(t, n)| (t.clone(), if uses[n.as_str()] > 1 && n != t { format!("{n} ({t})") } else { n.clone() }))
        .collect()
}

/// The warning `status` gives for this repository's technologies whose change events the last sync refused.
/// `unstale status`'s warnings (what is wrong, each once) and state lines (the provider, tokens, freshness, cache).
fn status_lines(ctx: &Ctx) -> (Vec<String>, Vec<String>) {
    let (mut warnings, mut state) = if inference::enabled() { setup::status_lines(ctx) } else { (vec![], vec![]) };
    // A refusal stays until a sync verifies the release notes. Only this repository's technologies are named.
    let ours = stack::detect(&ctx.root).map(|st| onboarding::candidates(ctx, &st)).unwrap_or_default();
    warnings.extend(status_events_failed_line(ctx, &ours));
    warnings.extend(pipeline::unrun_line(ctx, &ours));
    // The session-start sync's last failure and how fresh this machine is (switch on only).
    let (wrong, fresh) = session::status_lines(ctx);
    // A catalog that no longer serves this client comes first, said once: not again as the session-start sync's
    // failure, which is the same refusal.
    let refused = sync::refused();
    warnings.splice(0..0, refused_line());
    warnings.extend(wrong.into_iter().filter(|w| !refused.as_ref().is_some_and(|(_, m)| w.contains(m.as_str()))));
    state.extend(fresh);
    // The cache's size (state); a warning and its detail line when it is over its limit or was not cleaned up.
    for line in cache_gc::status_lines(&ctx.cache) {
        if line.starts_with("warning") || line.starts_with("  ") { warnings.push(line) } else { state.push(line) }
    }
    // Each warning once: setup's and the session state's name the same stopped work in the same words.
    let mut seen = std::collections::BTreeSet::new();
    warnings.retain(|w| !w.starts_with("warning") || seen.insert(w.clone()));
    (warnings, state)
}

fn status_events_failed_line(ctx: &Ctx, ours: &std::collections::BTreeSet<String>) -> Option<String> {
    let failed: Vec<(String, String)> = cache::events_failed(&ctx.cache).into_iter().filter(|(t, _)| ours.contains(t)).collect();
    let labels = tech_labels(&onboarding::read(ctx), failed.iter().map(|(t, _)| t));
    events_failed_line(&failed.into_iter().map(|(t, why)| (labels[&t].clone(), why)).collect::<Vec<_>>())
}

/// When this run's catalog sync was refused (the catalog no longer serves this version): what happened and the one
/// command that upgrades. `init` and `status` keep going on the cached catalog (their report says so), so it is a
/// warning, not an exit code.
fn refused_line() -> Option<String> {
    let (refusal, _) = sync::refused()?;
    let exe = std::env::current_exe().and_then(|e| e.canonicalize()).unwrap_or_default();
    Some(refusal.line(notice::upgrade_command(&exe)))
}

/// One line naming the technologies whose change events the last sync refused; their records synced regardless.
fn events_failed_line(failed: &[(String, String)]) -> Option<String> {
    let names: Vec<&str> = failed.iter().map(|(t, _)| t.as_str()).collect();
    let names = match names.as_slice() {
        [] => return None,
        [a] => a.to_string(),
        [a, b] => format!("{a} and {b}"),
        [a, b, rest @ ..] => format!("{a}, {b} and {} more", rest.len()),
    };
    Some(format!("warning: release notes for {names} failed verification, so they are not read. The next sync retries."))
}

/// Set to `1` on a development machine to let `unstale infer` and `unstale internal run-step --provider` call a
/// provider the user never chose (tests and eval scripts). Read from the process environment only.
const DEV_INFER: &str = "UNSTALE_DEV_INFER";

/// Hidden commands that call a named provider skip the user's recorded choice, so they run only for a developer.
fn dev_only(command: &str) -> Result<()> {
    if std::env::var(DEV_INFER).is_ok_and(|v| v.trim() == "1") {
        return Ok(());
    }
    bail!("`unstale {command}` is for development only (set {DEV_INFER}=1); run `unstale setup` to choose a provider")
}

#[allow(clippy::too_many_arguments)]
fn cmd_infer(provider: &str, model: Option<String>, base_url: Option<String>, key_env: Option<String>, schema: Option<String>,
    timeout_secs: Option<u64>, backoff_ms: Option<u64>, prompt: String) -> Result<u8> {
    use inference::{Inference, Prompt, ProviderConfig};
    dev_only("infer")?;
    let mut cfg = match provider {
        "openai" => ProviderConfig::openai(),
        "vercel" => ProviderConfig::vercel(),
        "openrouter" => ProviderConfig::openrouter(),
        "anthropic" => ProviderConfig::anthropic(),
        "codex" => ProviderConfig::codex(),
        "custom" if base_url.is_none() || key_env.is_none() || model.is_none() => bail!("--provider custom needs --base-url, --key-env and --model"),
        "custom" => ProviderConfig::custom("custom", "", "", ""),
        other => bail!("unknown provider {other}"),
    };
    if let Some(m) = model { cfg.model = m; }
    if let Some(b) = base_url { cfg.base_url = b; }
    if key_env.is_some() { cfg.key_env = key_env; }
    // With model steps off (the default), no call is made.
    if !inference::enabled() {
        println!("deferred: model steps on this machine are turned off");
        return Ok(0);
    }
    let mut p = Prompt::new(prompt);
    if let Some(s) = schema { p = p.schema(serde_json::from_str(&s).context("--schema: JSON")?); }
    // Another worker on this machine is already running model work: leave it to that one.
    let _lock = match inference::lock::try_acquire_default() {
        Ok(Some(l)) => l,
        Ok(None) => return Ok(0),
        Err(d) => { println!("{}", d.line()); return Ok(0); }
    };
    let mut inf = Inference::new(cfg);
    // The limit in effect where this runs: the user's own, or a lower one the repository here sets.
    (inf.monthly_budget, inf.budget_unseen) = setup::monthly_tokens_at(std::env::current_dir().ok().and_then(|d| pipeline::repo_root(&d)).as_deref());
    if let Some(t) = timeout_secs { inf.limits.timeout = std::time::Duration::from_secs(t); }
    if let Some(b) = backoff_ms { inf.limits.backoff = std::time::Duration::from_millis(b); }
    match inf.complete(&p) {
        Ok(a) => println!("{}", a.value),
        Err(d) => println!("{}", d.line()),
    }
    Ok(0)
}

fn cmd_internal(dir: Option<&Path>, cmd: InternalCmd) -> Result<u8> {
    let InternalCmd::RunStep { step, input, provider, model, base_url, key_env, timeout_secs, backoff_ms } = cmd;
    // With model steps off (the default), no call is made.
    if !inference::enabled() {
        println!("{}", serde_json::json!({"deferred": "deferred: model steps on this machine are turned off"}));
        return Ok(0);
    }
    let start = match dir {
        Some(d) => d.to_path_buf(),
        None => std::env::current_dir()?,
    };
    let root = pipeline::repo_root(&start);
    let mut main = match provider {
        Some(p) => {
            dev_only("internal run-step --provider")?;
            let mut named = inference::Inference::new(pipeline::named_provider(&p, model, base_url, key_env).map_err(|e| anyhow!(e))?);
            (named.monthly_budget, named.budget_unseen) = setup::monthly_tokens_at(root.as_deref());
            named
        }
        None => match pipeline::stored_choice(root.as_deref()).and_then(|c| pipeline::routes(&c, root.as_deref())) {
            Some(r) => r.main,
            None => {
                println!("{}", serde_json::json!({"deferred": "deferred: no model provider is chosen; run `unstale setup`"}));
                return Ok(0);
            }
        },
    };
    if let Some(t) = timeout_secs { main.limits.timeout = std::time::Duration::from_secs(t); }
    if let Some(b) = backoff_ms { main.limits.backoff = std::time::Duration::from_millis(b); }
    // Another worker on this machine is already running model work: leave it to that one.
    let _lock = match inference::lock::try_acquire_default() {
        Ok(Some(l)) => l,
        Ok(None) => return Ok(0),
        Err(d) => {
            println!("{}", serde_json::json!({"deferred": d.line()}));
            return Ok(0);
        }
    };
    // Like every path, `--in` is read relative to `--dir` when one is given.
    let input = if input.is_absolute() { input } else { start.join(input) };
    pipeline::run_step(&step, &input, main, &mut std::io::stdout().lock())?;
    Ok(0)
}

fn count_terms(repos: &[PathBuf]) -> Result<u8> {
    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input)?;
    let terms: Vec<String> = serde_json::from_str(&input).context("stdin: a JSON array of terms")?;
    let mut collected = vec![];
    for r in repos {
        if !r.is_dir() {
            bail!("not a directory: {}", r.display());
        }
        collected.push(usage::Repo::collect(r));
    }
    println!("{}", serde_json::to_string(&usage::sample_counts(&collected, &terms))?);
    Ok(0)
}

fn context(start: &Path) -> Result<Ctx> {
    let mut d = Some(start);
    while let Some(cur) = d {
        let cfg = cur.join(TOOL_DIR).join("config.json");
        if cfg.is_file() {
            let config: Config = serde_json::from_slice(&std::fs::read(&cfg)?).with_context(|| format!("reading {}", cfg.display()))?;
            if config.schema > 1 {
                bail!("{} was written by a newer unstale (schema {}); upgrade unstale", cfg.display(), config.schema);
            }
            // A catalog directory is read only when this machine's user chose it, never on a repository's word.
            sync::check_directory(&config.catalog)?;
            let cache = cache::cache_for(&config.catalog);
            return Ok(Ctx { root: cur.to_path_buf(), tool: cur.join(TOOL_DIR), config, cache, registry: cache::cache_dir() });
        }
        d = cur.parent();
    }
    bail!("unstale is not set up in {} or above; run `unstale init --catalog <dir>`", start.display())
}

// ---------------------------------------------------------------------------------------------------------- init

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git").arg("-C").arg(root).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
}

fn mode_name(m: Mode) -> &'static str {
    match m {
        Mode::Local => "personal",
        Mode::Collaborative => "shared",
    }
}

fn init(start: &Path, catalog: Option<String>, mode: Option<Mode>, _yes: bool, quiet: bool) -> Result<u8> {
    let mut root = start.to_path_buf();
    let mut d = Some(start);
    while let Some(cur) = d {
        if cur.join(".git").exists() {
            root = cur.to_path_buf();
            break;
        }
        d = cur.parent();
    }
    let tool = root.join(TOOL_DIR);
    let existing: Option<Config> = std::fs::read(tool.join("config.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
    let catalog = match catalog.or_else(|| std::env::var("UNSTALE_CATALOG").ok().filter(|s| !s.is_empty())) {
        // Named by the user, here: a directory is theirs to choose, and is remembered as chosen.
        Some(c) => {
            sync::resolve_source(&c)?;
            sync::approve_directory(&c)?;
            c
        }
        None => match &existing {
            // Named by the repository's config only: a directory there is read only if the user chose it before.
            Some(e) => {
                sync::check_directory(&e.catalog)?;
                e.catalog.clone()
            }
            None => bail!("no catalog location: pass `--catalog <dir>` or set UNSTALE_CATALOG"),
        },
    };
    let catalog = match sync::resolve_source(&catalog)? {
        sync::Source::Dir(base) if !catalog.starts_with("file://") => base.canonicalize().unwrap_or(base).to_string_lossy().to_string(),
        _ => catalog.trim().to_string(),
    };
    // Start privately; sharing decisions is reversible and never blocks seeing the first report.
    let mode = mode.or_else(|| existing.as_ref().map(|e| e.mode)).unwrap_or(Mode::Local);
    if !quiet && existing.is_none() { println!("Mode: {} (the default; no setup questions).", mode_name(mode)); }
    std::fs::create_dir_all(&tool)?;
    let config = Config {
        schema: 1,
        catalog,
        mode,
        service: existing.as_ref().and_then(|e| e.service.clone()),
        inference: existing.as_ref().and_then(|e| e.inference.clone()),
        monthly_token_limit: existing.as_ref().and_then(|e| e.monthly_token_limit),
        session_sync: existing.as_ref().and_then(|e| e.session_sync),
    };
    util::write_atomic(&tool.join("config.json"), format!("{}\n", serde_json::to_string_pretty(&config)?).as_bytes())?;
    // Local: the tool directory ignores itself, so nothing tracked changes. Collaborative: ledger and generated review context
    // are committed; review progress is personal.
    let ignore = match mode {
        Mode::Local => "*\n",
        Mode::Collaborative => "state/\n",
    };
    util::write_atomic(&tool.join(".gitignore"), ignore.as_bytes())?;
    let ga = root.join(".gitattributes");
    let attrs = std::fs::read_to_string(&ga).unwrap_or_default();
    let has = attrs.lines().any(|l| l.trim() == GITATTR_LINE);
    match (mode, has) {
        (Mode::Collaborative, false) => {
            let mut t = attrs.clone();
            if !t.is_empty() && !t.ends_with('\n') {
                t.push('\n');
            }
            t += GITATTR_LINE;
            t.push('\n');
            util::write_atomic(&ga, t.as_bytes())?;
        }
        (Mode::Local, true) => {
            let t: String = attrs.lines().filter(|l| l.trim() != GITATTR_LINE).map(|l| format!("{l}\n")).collect();
            if t.trim().is_empty() {
                std::fs::remove_file(&ga)?;
            } else {
                util::write_atomic(&ga, t.as_bytes())?;
            }
        }
        _ => {}
    }
    let ledger = tool.join(LEDGER_FILE);
    if !ledger.exists() {
        util::write_atomic(&ledger, b"{\"schema\":1}\n")?;
    }
    if !quiet {
    let st = stack::detect(&root)?;
    println!("Initialised unstale in {} ({} mode).", root.display(), mode_name(mode));
    println!("Catalog: {}", config.catalog);
    let apps = st.packages.iter().filter(|p| p.kind == stack::Kind::Application).count();
    println!(
        "Stack: {} manifests ({} application, {} library), {} packages{}.",
        st.packages.len(),
        apps,
        st.packages.len() - apps,
        st.deps.len(),
        match &st.node {
            Some((v, src)) => format!("; Node >= {v} ({src})"),
            None => "; no supported Node range declared".into(),
        }
    );
    let locks: std::collections::BTreeSet<&str> = st.packages.iter().filter_map(|p| p.lockfile.as_deref()).collect();
    if !locks.is_empty() {
        println!("Versions from: {} (applications); declared range floors for npm libraries; the newest release the range admits for Python requirements nothing pins.", locks.into_iter().collect::<Vec<_>>().join(", "));
    }
    for n in st.notes.iter().chain(&st.standalone) {
        println!("Note: {n}");
    }
    let other = if mode == Mode::Local { Mode::Collaborative } else { Mode::Local };
    println!("Switch with `unstale init --mode {}`.", mode_name(other));
    if mode == Mode::Local && git(&root, &["ls-files", TOOL_DIR]).is_some_and(|s| !s.trim().is_empty()) {
        println!("Note: files under {TOOL_DIR}/ are still tracked by Git; `git rm -r --cached {TOOL_DIR}` stops tracking them.");
    }
    println!("Next: `unstale run` (sync, digest, review).");
    }
    Ok(0)
}

// ------------------------------------------------------------------------------------------------------- shared

struct World {
    /// The stack and the code are shared with later Worlds of the same process (`world_reusing`).
    stack: Rc<stack::Stack>,
    catalog: Catalog,
    repo: Rc<usage::Repo>,
    ledger_file: LedgerFile,
    ledger: unstale_schema::ledger::Ledger,
    today: String,
    /// Why coverage has not arrived, when registration is deferred (`onboarding::deferral_note`).
    deferral: Option<String>,
}

fn load_catalog(ctx: &Ctx, st: &stack::Stack) -> Catalog {
    let mut c = Catalog::default();
    for t in onboarding::candidates(ctx, st) {
        match cache::load_tech(&ctx.cache, &t) {
            Ok(Some(td)) => {
                c.techs.insert(t, td);
            }
            Ok(None) => {}
            Err(e) => eprintln!("warning: {t}: {e:#}"),
        }
    }
    c
}

fn world(ctx: &Ctx) -> Result<World> {
    world_reusing(ctx, None)
}

/// A World that takes the stack and the repository's code from `prev` when given, reading only the catalog and the
/// ledger again: on a large repository reading the code is most of the time, and a process that reports more than
/// once (init following coverage) needs it once.
fn world_reusing(ctx: &Ctx, prev: Option<&World>) -> Result<World> {
    let st = match prev {
        Some(w) => w.stack.clone(),
        None => Rc::new(stack::detect(&ctx.root)?),
    };
    let catalog = load_catalog(ctx, &st);
    let lp = ctx.tool.join(LEDGER_FILE);
    let lf = LedgerFile::load(&lp);
    for w in lf.warnings(&lp) {
        eprintln!("{w}");
    }
    let (ledger, _) = ledgerops::reconcile(&lf.ledger, |id| catalog.lookup(id));
    let repo = match prev {
        Some(w) => w.repo.clone(),
        None => Rc::new(usage::Repo::collect(&ctx.root)),
    };
    Ok(World { stack: st, catalog, repo, ledger_file: lf, ledger, today: util::today(), deferral: onboarding::deferral_note(ctx) })
}

fn parse_targets(t: &[String]) -> Result<BTreeMap<String, semver::Version>> {
    let mut out = BTreeMap::new();
    for x in t {
        let (pkg, ver) = x.rsplit_once('@').filter(|(p, _)| !p.is_empty()).ok_or_else(|| anyhow!("--target {x}: expected <pkg>@<version>"))?;
        let v = util::parse_version(ver).ok_or_else(|| anyhow!("--target {x}: `{ver}` is not a version"))?;
        out.insert(util::npm_purl(pkg), v);
    }
    Ok(out)
}

fn outcome<'a>(ctx: &Ctx, w: &'a World, mut targets: BTreeMap<String, semver::Version>) -> Outcome<'a> {
    // An installed version its publisher retired moves to the registry's newest release, when that is newer and not
    // retired too: the target the report's deprecation line names (`deprecations::Notice::latest`), not the newest
    // release the catalog covers. A `--target` stands.
    for n in deprecations::notices(&ctx.registry, &w.stack) {
        if let Some((latest, false)) = &n.latest
            && let (Some(v), Some(have)) = (util::parse_version(latest), util::parse_version(&n.version))
            && v > have
        {
            targets.entry(util::normalize_purl(&n.purl)).or_insert(v);
        }
    }
    let mut out = funnel::run(&Input { catalog: &w.catalog, stack: &w.stack, repo: &w.repo, ledger: &w.ledger, today: &w.today, targets });
    out.uncovered = w.deferral.clone();
    out.unread = stack::unread_note(&w.repo, &w.stack);
    out
}

fn rel(ctx: &Ctx, p: &Path) -> String {
    p.strip_prefix(&ctx.root).unwrap_or(p).to_string_lossy().to_string()
}

// ------------------------------------------------------------------------------------------------------- sync

/// `unstale session-sync`: the session-start background stage. Started by the hook, detached, it prints nothing anyone
/// sees; run by hand it shows its progress at a terminal and ends with one line. Every answer is kept as it arrives, so
/// an interrupted run resumes where it stopped.
fn cmd_session_sync(ctx: &Ctx) -> Result<u8> {
    use std::io::IsTerminal;
    if std::env::var_os(session::HOOK_STAGE).is_some() {
        return session::background(ctx);
    }
    if !inference::enabled() || ctx.config.session_sync == Some(false) {
        println!("Session-start sync is off here, so nothing ran.");
        return Ok(0);
    }
    if std::io::stdout().is_terminal() {
        println!("Syncing the catalog, then reading new release notes with your provider. Ctrl-C stops it; the next run resumes.");
        pipeline::watch(Box::new(|l| println!("  {l}")));
    }
    let code = session::background(ctx)?;
    let state = session::read_state(&ctx.tool);
    let choice = pipeline::stored_choice(Some(&ctx.root));
    // No choice, or "Not now" (a choice of none): nothing was set to read them.
    let no_choice = match &choice {
        // A provider this repository's config names is a suggestion until the user makes it theirs.
        None if ctx.config.inference.as_ref().is_some_and(|c| !c.is_none()) => {
            Some("You have not chosen a provider, so no release notes were read. Choose one: `unstale setup`.")
        }
        None => Some("No provider is chosen, so no release notes were read. Choose one: `unstale setup`."),
        Some(c) if c.is_none() => Some("No release notes were read: this repo is set to Not now. To change it: `unstale setup`."),
        Some(_) => None,
    };
    // The catalog refused this client: nothing was read. Said once, with what waits for the upgrade.
    if let Some(line) = refused_line() {
        println!("{line}");
        if let Some(l) = no_choice {
            println!("{l}");
        } else {
            let n = pipeline::unread(ctx, &session::cached_technologies(ctx));
            if n > 0 {
                println!("No release notes were read: {n} wait until the catalog serves this unstale.");
            }
        }
        return Ok(code);
    }
    if let Some(f) = &state.failure {
        println!("warning: the catalog sync did not finish: {f}");
    }
    println!("{}", match pipeline::last_pass() {
        Some(s) => s.line().unwrap_or_else(|| "Nothing new to read: every release note here is read.".into()),
        None if state.deferred.is_some() => state.deferred.clone().unwrap_or_default(),
        None if no_choice.is_some() => no_choice.unwrap_or_default().into(),
        None => "No release notes were read: another unstale is reading them on this machine; it finishes them.".into(),
    });
    Ok(code)
}

fn cmd_sync(ctx: &Ctx) -> Result<u8> {
    let st = stack::detect(&ctx.root)?;
    let cands = onboarding::candidates(ctx, &st);
    let rep = match sync::sync(&ctx.config.catalog, &ctx.cache, &cands, &st.withheld(&ctx.registry), &st.purls()) {
        Ok(r) => r,
        Err(e) if e.downcast_ref::<sync::Incompatible>().is_some() => {
            eprintln!("sync refused: {e}");
            return Ok(EXIT_INCOMPATIBLE);
        }
        Err(e) => return Err(e),
    };
    cache_gc::after_sync(&ctx.cache, &ctx.root, &cache_gc::needs(&rep), &|| false);
    // With the edge-inference switch on, `sync` says what the reader can use, in their words: a line a technology, and
    // nothing about what the catalog does not cover (nothing to do about it) or how the files arrived. Release notes
    // that could not be verified are a warning below. With the switch off the lines are as they were.
    let plain = util::edge_inference();
    // Each technology by its plain name (`zod`), not the catalog's id (`zod-6ac59393`).
    let labels = tech_labels(&onboarding::read(ctx), rep.synced.iter().map(|t| &t.technology).chain(rep.failed.iter().map(|(t, _)| t)));
    let name = |t: &str| labels.get(t).cloned().unwrap_or_else(|| t.to_string());
    for t in &rep.synced {
        if plain {
            println!(
                "{}: {} upstream change{} on file, {}",
                name(&t.technology),
                t.records,
                if t.records == 1 { "" } else { "s" },
                if t.unchanged { "nothing new" } else { "updated" }
            );
            continue;
        }
        println!(
            "synced {}: {} records (sources checked {}); {}",
            name(&t.technology),
            t.records,
            t.checked,
            if t.unchanged { "unchanged".to_string() } else { format!("{} shard(s) downloaded, {} reused", t.downloaded, t.reused) }
        );
    }
    if rep.synced.is_empty() && plain {
        println!("The catalog has nothing yet for the {} packages this repository uses.", st.deps.len());
    } else if rep.synced.is_empty() {
        println!(
            "No technology in this repository's stack is covered by the catalog ({} candidates from {} packages checked).",
            cands.len(),
            st.deps.len()
        );
        if let Some(why) = st.deps.is_empty().then(|| stack::unread_note(&usage::Repo::collect(&ctx.root), &st)).flatten() {
            println!("Nothing was checked: {why}.");
        }
    }
    let uncovered = rep.not_covered.len() + rep.not_in_stack.len();
    if uncovered > 0 && !plain {
        println!(
            "Not covered by the catalog: {uncovered} other candidate {} (no index for {}, or no record names a package used here).",
            if uncovered == 1 { "technology" } else { "technologies" },
            if uncovered == 1 { "it" } else { "them" }
        );
    }
    if !rep.withheld.is_empty() && !plain {
        println!(
            "Not asked for: {} candidate {} only private packages name (the catalog published no list to check them against).",
            rep.withheld.len(),
            if rep.withheld.len() == 1 { "technology" } else { "technologies" }
        );
    }
    let unverified: Vec<(String, String)> = rep.synced.iter().filter(|t| t.events_failed.is_some()).map(|t| (name(&t.technology), String::new())).collect();
    if let Some(line) = events_failed_line(&unverified) { println!("{line}"); }
    let mut code = 0;
    for (t, e) in &rep.failed {
        eprintln!("error: {}: {e} (cached copy kept)", name(t));
        code = EXIT_ERROR;
    }
    // Registry deprecations of the installed versions (cached a day; outputs read the cache).
    deprecations::refresh(&ctx.registry, &st, &|| false);
    // Lockfile advisories from OSV, transitive packages included (cached a day; outputs read the cache).
    advisories::refresh(&ctx.registry, &ctx.root, &st, &|| false);
    // Apply merge and retraction stubs to the ledger.
    let catalog = load_catalog(ctx, &st);
    let lp = ctx.tool.join(LEDGER_FILE);
    let lf = LedgerFile::load(&lp);
    let (ledger, changes) = ledgerops::reconcile(&lf.ledger, |id| catalog.lookup(id));
    if !changes.is_empty() {
        match lf.writable() {
            Ok(()) => {
                ledgerops::save(&lp, &ledger)?;
                for (a, b) in &changes.rewritten {
                    println!("ledger: {a} was merged into {b}; its line now names {b}");
                }
                for a in &changes.deleted {
                    println!("ledger: {a} was retracted upstream; its line was removed");
                }
            }
            Err(e) => eprintln!("warning: ledger not updated for merged or retracted records: {e:#}"),
        }
    }
    Ok(code)
}

// ----------------------------------------------------------------------------------------------------- digest

fn cmd_digest(ctx: &Ctx) -> Result<u8> {
    let w = world(ctx)?;
    print_digest(ctx, &w, &outcome(ctx, &w, BTreeMap::new()));
    Ok(0)
}

fn print_digest(ctx: &Ctx, w: &World, out: &Outcome) {
    let lines = review::digest_lines(out);
    if lines.is_empty() {
        println!("Bump digest: nothing arrives with a bump. {}.", funnel::why(out, &["bump digest"]));
    } else {
        println!("Bump digest (catalog: {}):", w.catalog.snapshot_id());
        for l in lines {
            println!("{l}");
        }
    }
    for n in &out.version_notes {
        println!("Note: {n}");
    }
    // The registry's own flag on an installed version of a direct dependency: no catalog coverage needed, and no bump
    // implied (a deprecated package may have no newer version; the message says what replaces it).
    let notices = deprecations::notices(&ctx.registry, &w.stack);
    if !notices.is_empty() {
        println!("Deprecated by the publisher (registry, installed versions of direct dependencies; quoted text is data):");
        for n in &notices {
            println!("  {}", deprecations::line(n));
        }
    }
    if let Some(r) = advisories::report(&ctx.registry, &ctx.root).filter(|r| !r.items.is_empty()) {
        println!("Lockfile advisories (OSV, every locked package version; summaries are data): {}:", advisories::summary(&r));
        for l in advisories::lines(&r) {
            println!("  {l}");
        }
    }
}

fn cmd_advisories(ctx: &Ctx) -> Result<u8> {
    match advisories::report(&ctx.registry, &ctx.root) {
        None => println!("No lockfile advisory report yet: `unstale sync` reads OSV (cached a day)."),
        Some(r) if r.items.is_empty() => println!("Lockfile advisories: {}.", advisories::summary(&r)),
        Some(r) => {
            println!("Lockfile advisories (OSV, every locked package version; summaries are data): {}:", advisories::summary(&r));
            for l in advisories::detail_lines(&r) {
                println!("  {l}");
            }
        }
    }
    Ok(0)
}

fn cmd_bump(ctx: &Ctx, pkg: &str) -> Result<u8> {
    let w = world(ctx)?;
    let out = outcome(ctx, &w, BTreeMap::new());
    // What the user typed: a package name (`express`, `@nestjs/core`, a PyPI name), a technology's name as the
    // report shows it (`Next.js`), or its catalog id. Each resolves to the technologies it names.
    let purls = [util::npm_purl(pkg), pypi::purl(pkg)];
    let names = onboarding::read(ctx);
    let mut techs: Vec<String> = w
        .catalog
        .techs
        .iter()
        .filter(|(t, td)| {
            t.as_str() == pkg
                || names.jobs.values().any(|j| j.technology == **t && j.name.eq_ignore_ascii_case(pkg))
                || out.packages.get(*t).is_some_and(|p| p.iter().any(|x| x == pkg))
                || td.index.components.iter().any(|c| purls.contains(&util::normalize_purl(c)))
                || out.opps.iter().any(|o| o.rec.r.technology == **t && purls.contains(&util::normalize_purl(&o.component())))
        })
        .map(|(t, _)| t.clone())
        .collect();
    techs.sort();
    // The record each upgrade line in the report leads with, listed first so the evidence the report cites is here.
    // Choosing it builds the report (a few seconds): only when a named technology has records outside the digest.
    let beyond = |t: &String| out.opps.iter().any(|o| o.rec.r.technology == *t && matches!(o.route, funnel::Route::UpgradeReview | funnel::Route::InEffect | funnel::Route::ImprovementsPass | funnel::Route::NoBenefit));
    let leads = if techs.iter().any(beyond) { onboarding::lead_ids(ctx, &w) } else { BTreeMap::new() };
    let found: Vec<String> = techs.iter().filter_map(|t| review::bump_lines(&out, t, &leads)).flatten().collect();
    match (!found.is_empty()).then_some(found) {
        Some(lines) => {
            for l in lines {
                println!("{l}");
            }
            Ok(0)
        }
        None => {
            // The technologies `pkg` names (one with no records is still synced for this stack): the counts are
            // theirs, not the whole catalog's.
            if techs.is_empty() && !purls.iter().any(|p| w.stack.deps.contains_key(p)) {
                bail!("{pkg} is not a package or technology this repository uses");
            }
            // Lockfile (OSV) advisories on the package itself need no catalog record: the report names them on its
            // upgrade line and points here, so this shows them rather than "picks up nothing".
            let norm = |s: &str| s.to_ascii_lowercase().replace(['_', '.'], "-");
            let lock_report = advisories::report(&ctx.registry, &ctx.root).unwrap_or_default();
            let lock: Vec<&advisories::Item> = lock_report.items.iter().filter(|it| it.via.is_empty() && norm(&it.name) == norm(pkg)).collect();
            if !lock.is_empty() {
                let target = match lock.iter().map(|it| it.fix.as_deref()).collect::<Option<Vec<_>>>().and_then(|f| f.into_iter().max_by(|a, b| util::parse_version(a).cmp(&util::parse_version(b)))) {
                    Some(f) => format!(" → {f}"),
                    None => " (no fixed release)".to_string(),
                };
                let k = lock.len();
                println!("Bumping {pkg} {}{target} fixes {k} lockfile advisor{} (no catalog record needed):", lock[0].version, if k == 1 { "y" } else { "ies" });
                for it in &lock {
                    let fix = it.fix.as_deref().map(|f| format!(" → {f}")).unwrap_or_else(|| ", no fixed version: replace or mitigate".to_string());
                    println!("  security: {} ({}): {} [lockfile {} {}{fix}] (https://osv.dev/vulnerability/{})", it.id, it.severity.word(), util::one_line(&it.summary, 160), it.name, it.version, it.id);
                }
                return Ok(0);
            }
            if techs.is_empty() {
                println!("Bumping {pkg} picks up nothing in the catalog: no catalog technology covers {pkg}.");
            } else {
                println!("Bumping {pkg} picks up nothing in the catalog: {}.", funnel::why_for(&out, &techs, &["bump digest"]));
            }
            Ok(0)
        }
    }
}

// ----------------------------------------------------------------------------------------------------- review

fn regenerate(ctx: &Ctx, w: &World, out: &Outcome, state: &mut State, passes: &[Pass], next: bool, only_existing: bool) -> Result<u8> {
    let mut code = 0;
    let deprecated = if passes.contains(&Pass::UpgradeReview) { deprecations::notices(&ctx.registry, &w.stack) } else { vec![] };
    for &p in passes {
        let path = p.context_path(&ctx.tool);
        if only_existing && !path.exists() {
            continue;
        }
        let view = match review::batch_for(p, out, state, next) {
            Ok(v) => v,
            Err(missing) => {
                eprintln!("{}: batch not complete; {} without a disposition: {}", p.name(), missing.len(), missing.join(", "));
                code = EXIT_INCOMPLETE;
                review::batch_for(p, out, state, false).map_err(|_| anyhow!("internal: batch view"))?
            }
        };
        let text = review::render(&view, out, &w.catalog, &deprecated);
        let written = review::write_context(&path, &text)?;
        let mut what = if view.batch.is_empty() {
            if view.complete {
                format!("batch {} complete; run `unstale review --next --pass {}`", view.number, p.name())
            } else {
                format!(
                    "nothing {}to review: {}",
                    if view.in_effect.is_empty() { "" } else { "else " },
                    funnel::why(out, &[if p == Pass::UpgradeReview { "upgrade review" } else { "improvements pass" }, funnel::IN_EFFECT])
                )
            }
        } else {
            format!("batch {} with {} of {} open records", view.number, view.batch.len(), view.open)
        };
        if !view.in_effect.is_empty() {
            let n = view.in_effect.len();
            what = format!("{n} {} in effect now (at the installed version); {what}", if n == 1 { "deprecation" } else { "deprecations" });
        }
        if !only_existing {
            println!("{}: {what} → {} ({})", p.name(), rel(ctx, &path), if written { "written" } else { "unchanged" });
        }
    }
    state.save(&ctx.tool)?;
    review::write_entrypoint(&ctx.tool)?;
    onboarding::integrate(ctx)?;
    Ok(code)
}

fn cmd_review(ctx: &Ctx, next: bool, target: &[String], pass: Option<Pass>) -> Result<u8> {
    let targets = parse_targets(target)?;
    let w = world(ctx)?;
    review_with(ctx, &w, &outcome(ctx, &w, targets), next, pass)
}

fn review_with(ctx: &Ctx, w: &World, out: &Outcome, next: bool, pass: Option<Pass>) -> Result<u8> {
    let mut state = State::load(&ctx.tool);
    let passes: Vec<Pass> = match pass {
        Some(p) => vec![p],
        None => Pass::ALL.to_vec(),
    };
    regenerate(ctx, w, out, &mut state, &passes, next, false)
}

// ---------------------------------------------------------------------------------------------- decide / record

/// The record a disposition is for: an active record of this stack's catalog, following merges.
fn resolve_id(c: &Catalog, id: &str) -> Result<(String, u32)> {
    let mut cur = id.to_string();
    for _ in 0..32 {
        match c.lookup(&cur) {
            Lookup::Active(rev) => {
                if cur != id {
                    println!("{id} was merged into {cur}; recording for {cur}.");
                }
                return Ok((cur, rev));
            }
            Lookup::Merged(to) => cur = to,
            Lookup::Retracted => bail!("{cur} was retracted upstream; nothing to record"),
            Lookup::Missing => bail!("unknown record id `{cur}` for this repository's synced catalog (run `unstale sync`?)"),
        }
    }
    bail!("merge chain from {id} does not end")
}

fn write_disposition(ctx: &Ctx, w: &World, id: &str, rev: u32, d: Disposition, note: Option<String>) -> Result<Option<u8>> {
    let lp = ctx.tool.join(LEDGER_FILE);
    if let Err(e) = w.ledger_file.writable() {
        eprintln!("error: {e:#}");
        return Ok(Some(EXIT_LEDGER));
    }
    let mut ledger = w.ledger.clone();
    let e = ledgerops::dispose(&mut ledger, id, rev, d, &w.today, note);
    ledgerops::save(&lp, &ledger)?;
    match &e {
        unstale_schema::ledger::Entry::Deferred { until, n, .. } => {
            println!("recorded {id} deferred until {until} (deferral {n} of {})", ledgerops::MAX_DEFERRALS)
        }
        unstale_schema::ledger::Entry::NoSite { n, .. } => println!(
            "recorded {id} no site (re-reviewed after {} days; {n} of {})",
            ledgerops::NO_SITE_DAYS,
            ledgerops::MAX_DEFERRALS
        ),
        unstale_schema::ledger::Entry::Declined { .. } if !matches!(d, Disposition::Declined) => {
            println!("recorded {id} declined: it was deferred {} times already", ledgerops::MAX_DEFERRALS)
        }
        other => println!("recorded {id} {} (rev {rev})", ledgerops::status_name(other)),
    }
    Ok(None)
}

fn after_disposition(ctx: &Ctx, id: &str, clear_do_now: bool) -> Result<()> {
    // The review contexts are regenerated when the ledger changes, without advancing a batch.
    let w = world(ctx)?;
    let out = outcome(ctx, &w, BTreeMap::new());
    let mut state = State::load(&ctx.tool);
    if clear_do_now {
        state.do_now.remove(id);
    }
    regenerate(ctx, &w, &out, &mut state, &Pass::ALL, false, true)?;
    Ok(())
}

fn cmd_record(ctx: &Ctx, id: &str, d: Disposition, note: Option<String>) -> Result<u8> {
    let w = world(ctx)?;
    let (id, rev) = resolve_id(&w.catalog, id)?;
    if let Some(code) = write_disposition(ctx, &w, &id, rev, d, note)? {
        return Ok(code);
    }
    after_disposition(ctx, &id, true)?;
    Ok(0)
}

fn cmd_decide(ctx: &Ctx, id: &str, decision: Decision, note: Option<String>) -> Result<u8> {
    let w = world(ctx)?;
    let (id, rev) = resolve_id(&w.catalog, id)?;
    match decision {
        Decision::DoNow => {
            let mut state = State::load(&ctx.tool);
            state.do_now.insert(id.clone(), rev);
            state.save(&ctx.tool)?;
            println!("marked {id} do now; apply it, then `unstale record {id} done` (or the code will show it applied)");
            after_disposition(ctx, &id, false)?;
        }
        Decision::Later | Decision::Decline => {
            let d = if decision == Decision::Later { Disposition::Deferred } else { Disposition::Declined };
            if let Some(code) = write_disposition(ctx, &w, &id, rev, d, note)? {
                return Ok(code);
            }
            after_disposition(ctx, &id, true)?;
        }
    }
    Ok(0)
}

// ----------------------------------------------------------------------------------------------- ledger, run

fn cmd_ledger_check(ctx: &Ctx) -> Result<u8> {
    let lp = ctx.tool.join(LEDGER_FILE);
    let lf = LedgerFile::load(&lp);
    let warnings = lf.warnings(&lp);
    if warnings.is_empty() {
        println!("ledger ok: {} entries ({})", lf.ledger.entries.len(), rel(ctx, &lp));
        return Ok(0);
    }
    for w in warnings {
        eprintln!("{w}");
    }
    Ok(EXIT_LEDGER)
}

fn cmd_run(ctx: &Ctx, target: &[String]) -> Result<u8> {
    let s = match cmd_sync(ctx) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("sync failed: {e:#}; continuing with the cached catalog");
            EXIT_ERROR
        }
    };
    // One reading of the repository for both: digest and review see the same code, stack and catalog.
    let w = world(ctx)?;
    let out = outcome(ctx, &w, BTreeMap::new());
    print_digest(ctx, &w, &out);
    let targets = parse_targets(target)?;
    let r = if targets.is_empty() { review_with(ctx, &w, &out, false, None)? } else { review_with(ctx, &w, &outcome(ctx, &w, targets), false, None)? };
    Ok([s, r].into_iter().find(|c| *c != 0).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(purl: &str, technology: &str, name: &str) -> onboarding::Job {
        onboarding::Job { purl: purl.into(), technology: technology.into(), name: name.into(), ..Default::default() }
    }

    #[test]
    fn a_technology_is_named_by_its_plain_name_and_a_shared_name_keeps_its_id() {
        let mut p = onboarding::Pending::default();
        p.jobs.insert("pkg:npm/zod".into(), job("pkg:npm/zod", "zod-6ac59393", "zod"));
        p.jobs.insert("pkg:npm/odd".into(), job("pkg:npm/odd", "odd-00000000", "\u{1b}\t"));
        let techs: Vec<String> = ["zod-6ac59393", "react", "odd-00000000"].map(String::from).into();
        let l = tech_labels(&p, &techs);
        assert_eq!(l["zod-6ac59393"], "zod");
        // No job names it: its id is its package's name already.
        assert_eq!(l["react"], "react");
        // A name that is only control characters is no name.
        assert_eq!(l["odd-00000000"], "odd-00000000");
        // Two technologies named alike in one run: each keeps its id; one named by its own id stays as it is.
        p.jobs.insert("pkg:npm/zod-mini".into(), job("pkg:npm/zod-mini", "zod-11111111", "zod"));
        let techs: Vec<String> = ["zod-6ac59393", "zod-11111111", "zod"].map(String::from).into();
        let l = tech_labels(&p, &techs);
        assert_eq!((l["zod-6ac59393"].as_str(), l["zod-11111111"].as_str(), l["zod"].as_str()), ("zod (zod-6ac59393)", "zod (zod-11111111)", "zod"));
    }

    /// `status`'s warning for refused change events names the technologies as `sync` does.
    #[test]
    fn status_names_refused_release_notes_by_plain_name() {
        let dir = tempfile::tempdir().unwrap();
        let (root, cache) = (dir.path().join("repo"), dir.path().join("cache"));
        let config: Config = serde_json::from_value(serde_json::json!({"schema": 1, "catalog": "", "mode": "collaborative"})).unwrap();
        let ctx = Ctx { tool: root.join(TOOL_DIR), root, config, registry: cache.clone(), cache };
        let mut p = onboarding::Pending::default();
        p.jobs.insert("pkg:npm/zod".into(), job("pkg:npm/zod", "zod-6ac59393", "zod"));
        p.jobs.insert("pkg:npm/zod-mini".into(), job("pkg:npm/zod-mini", "zod-11111111", "zod"));
        p.jobs.insert("pkg:npm/react".into(), job("pkg:npm/react", "react-0a0a0a0a", "react"));
        util::write_atomic(&ctx.tool.join("state/coverage.json"), &serde_json::to_vec(&p).unwrap()).unwrap();
        let ours: std::collections::BTreeSet<String> = ["zod-6ac59393", "zod-11111111", "react-0a0a0a0a"].map(String::from).into();
        for t in &ours {
            cache::set_events_failed(&ctx.cache, t, Some("signature"));
        }
        assert_eq!(
            status_events_failed_line(&ctx, &ours).unwrap(),
            "warning: release notes for react, zod (zod-11111111) and 1 more failed verification, so they are not read. The next sync retries."
        );
    }
}
