//! `unstale`: the client. Stack detection, catalog sync, ranking, reports and the agent integration; the catalog
//! service is `central/`.

mod cache;
mod onboarding;
mod onboarding_ui;
mod pypi;
mod uninstall;
mod funnel;
mod lines;
mod ledgerops;
mod review;
mod stack;
mod sync;
#[cfg(test)]
mod testcat;
mod usage;
mod util;

use anyhow::{Context, Result, anyhow, bail};
use clap::{Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

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
    after_help = "Exit codes: 0 ok; 1 error; 2 usage; 3 a review batch is incomplete (--next); 4 the catalog needs a newer unstale (cache kept); 5 the ledger has invalid lines."
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
        /// Local (decisions stay out of Git) or collaborative (ledger and skill files committed).
        #[arg(long, value_enum)]
        mode: Option<Mode>,
        /// Accept defaults (setup is noninteractive by default).
        #[arg(long)]
        yes: bool,
        /// Shared public technology coverage service (or $UNSTALE_SERVICE).
        #[arg(long)]
        service: Option<String>,
        /// Seconds to follow initial coverage before returning to the shell.
        #[arg(long)]
        wait: Option<u64>,
        /// Print stable stage lines without decorative motion.
        #[arg(long)]
        no_animation: bool,
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
    /// One line when shared coverage published records since the last report; silent otherwise (agent session start).
    Notify,
    /// Show the saved detailed onboarding report without rerunning setup or coverage.
    Report,
    /// Fetch this stack's technology indexes and shards into the per-user cache (verified, swapped atomically).
    Sync,
    /// Print the bump digest: what each package bump picks up (deterministic; no model, no network).
    Digest,
    /// Write the upgrade-review and improvements-pass skill files for the current batch.
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
    /// sync, then digest, then review.
    Run {
        #[arg(long, value_name = "PKG@VERSION")]
        target: Vec<String>,
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
    #[value(alias = "personal")]
    Local,
    #[value(alias = "shared")]
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
}

struct Ctx {
    root: PathBuf,
    tool: PathBuf,
    config: Config,
    cache: PathBuf,
}

const TOOL_DIR: &str = ".unstale";
const LEDGER_FILE: &str = "ledger.jsonl";
const GITATTR_LINE: &str = ".unstale/ledger.jsonl merge=union";

fn main() -> ExitCode {
    let cli = Cli::parse();
    match dispatch(cli) {
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

fn dispatch(cli: Cli) -> Result<u8> {
    if let Cmd::CountTerms { repos } = &cli.cmd {
        return count_terms(repos);
    }
    let start = start_dir(&cli.dir)?;
    if matches!(cli.cmd, Cmd::Uninstall) { return uninstall::run(&start); }
    if let Cmd::Init { catalog, mode, yes, service, wait, no_animation } = cli.cmd {
        let service = service.or_else(|| std::env::var("UNSTALE_SERVICE").ok())
            .or_else(|| option_env!("UNSTALE_DEFAULT_SERVICE").filter(|s| !s.is_empty()).map(String::from));
        let catalog = catalog.or_else(|| std::env::var("UNSTALE_CATALOG").ok()).or_else(|| service.clone());
        let code = init(&start, catalog, mode, yes, service.is_some())?;
        let mut ctx = context(&start)?;
        if let Some(service) = service {
            sync::resolve_source(&service)?;
            ctx.config.service = Some(service);
            util::write_atomic(&ctx.tool.join("config.json"), &serde_json::to_vec_pretty(&ctx.config)?)?;
        }
        return if ctx.config.service.is_some() { onboarding::run(&ctx, wait.unwrap_or(if std::io::stdin().is_terminal() {30} else {0}), !no_animation, wait.is_none()) } else { Ok(code) };
    }
    let ctx = context(&start)?;
    match cli.cmd {
        Cmd::Init { .. } | Cmd::CountTerms { .. } | Cmd::Uninstall => unreachable!(),
        Cmd::Report => {
            let text = std::fs::read_to_string(ctx.tool.join("onboarding-report.md")).context("No saved report yet; run unstale status")?;
            for line in text.lines() { println!("{}", line.chars().filter(|c| !c.is_control() || *c == '\t').collect::<String>()); }
            Ok(0)
        },
        Cmd::Status { wait, no_animation } => onboarding::run(&ctx, wait, !no_animation, false),
        Cmd::Notify => onboarding::notify(&ctx),
        Cmd::Sync => cmd_sync(&ctx),
        Cmd::Digest => cmd_digest(&ctx),
        Cmd::Review { next, target, pass } => cmd_review(&ctx, next, &target, pass),
        Cmd::Decide { id, decision, note } => cmd_decide(&ctx, &id, decision, note),
        Cmd::Record { id, disposition, note } => {
            let d: Disposition = disposition.parse().map_err(|e: String| anyhow!(e))?;
            cmd_record(&ctx, &id, d, note)
        }
        Cmd::Bump { pkg } => cmd_bump(&ctx, &pkg),
        Cmd::Ledger { cmd: LedgerCmd::Check } => cmd_ledger_check(&ctx),
        Cmd::Run { target } => cmd_run(&ctx, &target),
    }
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
            return Ok(Ctx { root: cur.to_path_buf(), tool: cur.join(TOOL_DIR), config, cache: cache::cache_dir() });
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
        Mode::Local => "local",
        Mode::Collaborative => "collaborative",
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
        Some(c) => c,
        None => match &existing {
            Some(e) => e.catalog.clone(),
            None => bail!("no catalog location: pass `--catalog <dir>` or set UNSTALE_CATALOG"),
        },
    };
    let catalog = match sync::resolve_source(&catalog)? {
        sync::Source::Dir(base) if !catalog.starts_with("file://") => base.canonicalize().unwrap_or(base).to_string_lossy().to_string(),
        _ => catalog.trim().to_string(),
    };
    // Start privately; sharing decisions is reversible and never blocks seeing the first report.
    let mode = mode.or_else(|| existing.as_ref().map(|e| e.mode)).unwrap_or(Mode::Local);
    if !quiet && existing.is_none() { println!("Mode: {} (personal by default; no setup questions).", mode_name(mode)); }
    std::fs::create_dir_all(&tool)?;
    let config = Config { schema: 1, catalog, mode, service: existing.as_ref().and_then(|e| e.service.clone()) };
    util::write_atomic(&tool.join("config.json"), format!("{}\n", serde_json::to_string_pretty(&config)?).as_bytes())?;
    // Local: the tool directory ignores itself, so nothing tracked changes. Collaborative: ledger and skill files
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
        println!("Versions from: {} (applications); declared range floors for libraries.", locks.into_iter().collect::<Vec<_>>().join(", "));
    }
    for n in &st.notes {
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
    stack: stack::Stack,
    catalog: Catalog,
    repo: usage::Repo,
    ledger_file: LedgerFile,
    ledger: unstale_schema::ledger::Ledger,
    today: String,
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
    let st = stack::detect(&ctx.root)?;
    let catalog = load_catalog(ctx, &st);
    let lp = ctx.tool.join(LEDGER_FILE);
    let lf = LedgerFile::load(&lp);
    for w in lf.warnings(&lp) {
        eprintln!("{w}");
    }
    let (ledger, _) = ledgerops::reconcile(&lf.ledger, |id| catalog.lookup(id));
    let repo = usage::Repo::collect(&ctx.root);
    Ok(World { stack: st, catalog, repo, ledger_file: lf, ledger, today: util::today() })
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

fn outcome<'a>(w: &'a World, targets: BTreeMap<String, semver::Version>) -> Outcome<'a> {
    funnel::run(&Input { catalog: &w.catalog, stack: &w.stack, repo: &w.repo, ledger: &w.ledger, today: &w.today, targets })
}

fn rel(ctx: &Ctx, p: &Path) -> String {
    p.strip_prefix(&ctx.root).unwrap_or(p).to_string_lossy().to_string()
}

// ------------------------------------------------------------------------------------------------------- sync

fn cmd_sync(ctx: &Ctx) -> Result<u8> {
    let st = stack::detect(&ctx.root)?;
    let cands = onboarding::candidates(ctx, &st);
    let rep = match sync::sync(&ctx.config.catalog, &ctx.cache, &cands, &st.purls()) {
        Ok(r) => r,
        Err(e) if e.downcast_ref::<sync::Incompatible>().is_some() => {
            eprintln!("sync refused: {e}");
            return Ok(EXIT_INCOMPATIBLE);
        }
        Err(e) => return Err(e),
    };
    for t in &rep.synced {
        println!(
            "synced {}: {} records (sources checked {}); {}",
            t.technology,
            t.records,
            t.checked,
            if t.unchanged { "unchanged".to_string() } else { format!("{} shard(s) downloaded, {} reused", t.downloaded, t.reused) }
        );
    }
    if rep.synced.is_empty() {
        println!(
            "No technology in this repository's stack is covered by the catalog ({} candidates from {} packages checked).",
            cands.len(),
            st.deps.len()
        );
    }
    let uncovered = rep.not_covered.len() + rep.not_in_stack.len();
    if uncovered > 0 {
        println!("Not covered by the catalog: {uncovered} other candidate technologies (no index for them, or no record names a package used here).");
    }
    let mut code = 0;
    for (t, e) in &rep.failed {
        eprintln!("error: {t}: {e} (cached copy kept)");
        code = EXIT_ERROR;
    }
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
    let out = outcome(&w, BTreeMap::new());
    let lines = review::digest_lines(&out);
    if lines.is_empty() {
        println!("Bump digest: nothing arrives with a bump. {}.", funnel::why(&out, &["bump digest"]));
    } else {
        println!("Bump digest (catalog: {}):", w.catalog.snapshot_line());
        for l in lines {
            println!("{l}");
        }
    }
    Ok(0)
}

fn cmd_bump(ctx: &Ctx, pkg: &str) -> Result<u8> {
    let w = world(ctx)?;
    let out = outcome(&w, BTreeMap::new());
    match review::bump_lines(&out, pkg) {
        Some(lines) => {
            for l in lines {
                println!("{l}");
            }
            Ok(0)
        }
        None if w.stack.deps.contains_key(&util::npm_purl(pkg)) || out.technologies.iter().any(|t| t == pkg) => {
            println!("Bumping {pkg} picks up nothing in the catalog: {}.", funnel::why(&out, &["bump digest"]));
            Ok(0)
        }
        None => bail!("{pkg} is not a package this repository uses"),
    }
}

// ----------------------------------------------------------------------------------------------------- review

fn regenerate(ctx: &Ctx, w: &World, out: &Outcome, state: &mut State, passes: &[Pass], next: bool, only_existing: bool) -> Result<u8> {
    let mut code = 0;
    for &p in passes {
        let path = p.skill_path(&ctx.tool);
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
        let text = review::render(&view, out, &w.catalog);
        let written = review::write_skill(&path, &text)?;
        let what = if view.batch.is_empty() {
            if view.complete {
                format!("batch {} complete; run `unstale review --next --pass {}`", view.number, p.name())
            } else {
                format!("nothing to review: {}", funnel::why(out, &[if p == Pass::UpgradeReview { "upgrade review" } else { "improvements pass" }]))
            }
        } else {
            format!("batch {} with {} of {} open records", view.number, view.batch.len(), view.open)
        };
        if !only_existing {
            println!("{}: {what} → {} ({})", p.name(), rel(ctx, &path), if written { "written" } else { "unchanged" });
        }
    }
    state.save(&ctx.tool)?;
    if ctx.config.service.is_some() { onboarding::integrate(ctx)?; }
    Ok(code)
}

fn cmd_review(ctx: &Ctx, next: bool, target: &[String], pass: Option<Pass>) -> Result<u8> {
    let targets = parse_targets(target)?;
    let w = world(ctx)?;
    let out = outcome(&w, targets);
    let mut state = State::load(&ctx.tool);
    let passes: Vec<Pass> = match pass {
        Some(p) => vec![p],
        None => Pass::ALL.to_vec(),
    };
    regenerate(ctx, &w, &out, &mut state, &passes, next, false)
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
    // The skill files are regenerated when the ledger changes, without advancing a batch.
    let w = world(ctx)?;
    let out = outcome(&w, BTreeMap::new());
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
    let d = cmd_digest(ctx)?;
    let r = cmd_review(ctx, false, target, None)?;
    Ok([s, d, r].into_iter().find(|c| *c != 0).unwrap_or(0))
}
