#![cfg(unix)]
//! Provider setup through the binary: detection by name only, `--inference`, no question without a terminal, and
//! canaries that must never leave the files they were planted in.

mod support;

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use support::{AUTH_CANARY, OTHER_CANARY, REPO_CANARY, SHELL_CANARY};

/// A repository with a sibling repository, a home directory with a Codex auth file, a user config directory, a cache
/// and a `bin` directory with a fake `codex`, all under one temporary directory.
struct World {
    base: tempfile::TempDir,
}

impl World {
    fn new(codex_logged_in: Option<bool>) -> World {
        let w = World {
            base: tempfile::tempdir().unwrap(),
        };
        for d in ["repo", "other", "home/.codex", "config", "cache", "bin"] {
            std::fs::create_dir_all(w.path(d)).unwrap();
        }
        let repo = w.path("repo");
        std::fs::write(
            repo.join("package.json"),
            r#"{"name":"shop","dependencies":{"next":"^16.0.0"}}"#,
        )
        .unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&repo)
            .status()
            .unwrap();
        if let Some(logged_in) = codex_logged_in {
            // `codex` in `codex/bin`, which is on PATH; `exec` is never expected here, so it fails.
            support::fake_codex(&w.path("codex"), logged_in, "", 2);
        }
        w
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.base.path().join(rel)
    }

    /// Plants the canaries: this repository's `.env`, another repository's `.env`, and Codex's auth file.
    fn plant(&self) {
        std::fs::write(
            self.path("repo/.env"),
            format!("OPENAI_API_KEY={REPO_CANARY}\nDATABASE_URL={REPO_CANARY}\n"),
        )
        .unwrap();
        std::fs::write(
            self.path("other/.env"),
            format!("ANTHROPIC_API_KEY={OTHER_CANARY}\n"),
        )
        .unwrap();
        std::fs::write(
            self.path("home/.codex/auth.json"),
            format!("{{\"tokens\":{{\"access_token\":\"{AUTH_CANARY}\"}}}}"),
        )
        .unwrap();
    }

    fn command(&self, args: &[&str], switch: bool) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_unstale"));
        c.args(args)
            .current_dir(self.path("repo"))
            .env_clear()
            .env(
                "PATH",
                format!(
                    "{}:{}:/usr/bin:/bin",
                    self.path("codex/bin").display(),
                    self.path("bin").display()
                ),
            )
            .env("HOME", self.path("home"))
            .env("UNSTALE_CONFIG_DIR", self.path("config"))
            .env("UNSTALE_CACHE_DIR", self.path("cache"))
            .env("UNSTALE_DEV_UNSIGNED_CATALOG", "1")
            .env("UNSTALE_TODAY", "2026-11-10")
            .env("UNSTALE_NO_REGISTRY", "1")
            .env("JEV_API_KEY", SHELL_CANARY)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c.env("UNSTALE_EDGE_INFERENCE", if switch { "1" } else { "0" });
        c
    }

    /// Runs to completion, or fails the test after `limit` (a run blocked opening a file it must never open).
    fn run_within(&self, args: &[&str], switch: bool, limit: Duration) -> (i32, String) {
        let (code, out, err) = support::run_within(&mut self.command(args, switch), limit);
        (code, out + &err)
    }

    fn ok(&self, args: &[&str], switch: bool) -> String {
        let (code, text) = self.run_within(args, switch, Duration::from_secs(60));
        assert_eq!(code, 0, "unstale {args:?}:\n{text}");
        text
    }

    /// Runs with the switch on and extra environment variables: the exit code and the output.
    fn run_with(&self, args: &[&str], extra: &[(&str, &str)]) -> (i32, String) {
        let mut c = self.command(args, true);
        for (k, v) in extra {
            c.env(k, v);
        }
        let (code, out, err) = support::run_within(&mut c, Duration::from_secs(60));
        (code, out + &err)
    }

    fn init(&self, switch: bool, extra: &[&str]) -> String {
        let mut args = vec![
            "init",
            "--service",
            "http://127.0.0.1:9",
            "--mode",
            "local",
            "--yes",
            "--wait",
            "0",
            "--no-animation",
        ];
        args.extend_from_slice(extra);
        self.ok(&args, switch)
    }

    fn config(&self) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(self.path("repo/.unstale/config.json")).unwrap())
            .unwrap()
    }

    /// The user's answer for this repository, kept in their own config (null before they gave one). A personal-mode
    /// repository's config never holds it.
    fn chosen(&self) -> serde_json::Value {
        let root = self.path("repo").canonicalize().unwrap();
        self.user_config()["repositories"][&*root.to_string_lossy()]["inference"].clone()
    }

    /// The user's own config, or an empty object before anything was saved there.
    fn user_config(&self) -> serde_json::Value {
        std::fs::read(self.path("config/config.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    }

    /// Sets one key of this repository's config, as a teammate's commit would.
    fn set_config(&self, key: &str, value: serde_json::Value) {
        let mut c = self.config();
        c[key] = value;
        std::fs::write(self.path("repo/.unstale/config.json"), c.to_string()).unwrap();
    }

    /// Every file under the temporary directory but the three planted ones and the fake `codex`'s records, as text.
    fn written_files(&self) -> Vec<(PathBuf, String)> {
        let planted = [
            self.path("repo/.env"),
            self.path("other/.env"),
            self.path("home/.codex/auth.json"),
        ];
        let mut out = vec![];
        let mut stack = vec![self.base.path().to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                let t = e.file_type().unwrap();
                if t.is_dir() {
                    stack.push(p);
                } else if t.is_file() && !planted.contains(&p) && !p.starts_with(self.path("codex"))
                {
                    out.push((
                        p.clone(),
                        String::from_utf8_lossy(&std::fs::read(&p).unwrap()).to_string(),
                    ));
                }
            }
        }
        out
    }
}

fn assert_no_canary(what: &str, text: &str) {
    for c in [REPO_CANARY, OTHER_CANARY, AUTH_CANARY, SHELL_CANARY] {
        assert!(!text.contains(c), "canary {c} in {what}:\n{text}");
    }
}

#[test]
fn no_canary_reaches_output_config_cache_or_any_written_file() {
    let w = World::new(Some(true));
    w.plant();
    let mut out = w.init(true, &[]);
    // Without a terminal: no question, and nothing is chosen.
    assert!(!out.contains(QUESTION), "{out}");
    assert!((w.chosen().is_null() && w.config().get("inference").is_none()));
    let listed = w.ok(&["setup"], true);
    out += &listed;
    // Names from the shell (JEV_API_KEY) and from this repository's .env (OPENAI_API_KEY); nothing from the other
    // repository's .env (ANTHROPIC_API_KEY); Codex from PATH and its login status.
    assert!(
        listed.contains("  1  Jev + OpenAI ")
            && listed.contains("     Keys: JEV_API_KEY, OPENAI_API_KEY (.env)"),
        "{listed}"
    );
    assert!(listed.contains("Codex plan"), "{listed}");
    assert!(
        !listed.contains("ANTHROPIC_API_KEY"),
        "another repository's .env was read:\n{listed}"
    );
    out += &w.ok(&["setup", "--inference", "jev+env:OPENAI_API_KEY"], true);
    out += &w.ok(&["status", "--wait", "0", "--no-animation"], true);
    let user = w.ok(&["setup", "--user", "--inference", "codex"], true);
    assert!(
        user.contains(
            "This repo's own choice still applies: Jev + OpenAI (JEV_API_KEY, OPENAI_API_KEY)."
        ),
        "{user}"
    );
    out += &user;
    assert_eq!(
        w.chosen()["key_env"],
        "OPENAI_API_KEY",
        "the variable's name is stored"
    );
    assert_no_canary("output", &out);
    let files = w.written_files();
    assert!(
        files.iter().any(|(p, _)| p.ends_with("config/config.json")),
        "the user config was written"
    );
    assert!(
        files
            .iter()
            .any(|(p, _)| p.starts_with(w.path("repo/.unstale"))),
        "the repository's tool directory was written"
    );
    for (p, text) in files {
        assert_no_canary(&p.display().to_string(), &text);
    }
}

#[test]
fn another_repos_env_and_codex_auth_file_are_never_opened() {
    // Opening a FIFO for reading blocks until a writer comes, and none ever does: a run that opened either file would
    // never finish.
    let w = World::new(Some(true));
    std::fs::write(w.path("repo/.env"), "OPENAI_API_KEY=x\n").unwrap();
    for f in ["other/.env", "home/.codex/auth.json"] {
        assert!(
            Command::new("mkfifo")
                .arg(w.path(f))
                .status()
                .unwrap()
                .success()
        );
    }
    w.init(true, &[]);
    let listed = w.ok(&["setup"], true);
    assert!(
        listed.contains("Codex plan") && listed.contains("OPENAI_API_KEY (.env)"),
        "{listed}"
    );
    w.ok(&["setup", "--inference", "codex"], true);
    w.ok(&["status", "--wait", "0", "--no-animation"], true);
}

#[test]
fn with_the_switch_off_setup_is_inert() {
    let w = World::new(Some(true));
    w.plant();
    let out = w.init(false, &["--inference", "codex"]);
    assert!(
        (w.chosen().is_null() && w.config().get("inference").is_none()),
        "the flag is ignored with the switch off"
    );
    for line in SWITCH_ON_LINES {
        assert!(!out.contains(line), "{line:?} with the switch off:\n{out}");
    }
    // Without a terminal the stage lines print as they always did; only the switch quiets them.
    assert!(out.contains(" · step 1/5 · "), "{out}");
    assert_eq!(
        w.ok(&["setup"], false).trim(),
        "Reading new release notes is turned off by UNSTALE_EDGE_INFERENCE=0; unset it to turn it on, then run `unstale setup`."
    );
    let status = w.ok(&["status", "--wait", "0", "--no-animation"], false);
    for line in SWITCH_ON_LINES {
        assert!(
            !status.contains(line),
            "{line:?} with the switch off:\n{status}"
        );
    }
    let skill = std::fs::read_to_string(w.path("repo/.unstale/skills/review/SKILL.md")).unwrap();
    assert!(!skill.contains("unstale setup"), "{skill}");
}

/// What setup and status print only with the switch on.
const SWITCH_ON_LINES: [&str; 7] = [
    "release notes",
    "Release notes",
    "Tokens",
    "warning:",
    "Choice pending",
    "Registry to catalog",
    "Catalog to here",
];

/// The start of every question setup asks.
const QUESTION: &str = "Enter to choose";

impl World {
    /// Runs at a terminal (a pseudo-terminal from `script`), typing `input`.
    /// Waits until no process started from this world (its directory in the command line) is running: a detached
    /// background stage, however long the machine's load makes it.
    fn wait_idle(&self) {
        let tag = self.base.path().file_name().unwrap().to_string_lossy().to_string();
        let until = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            let ps = std::process::Command::new("ps")
                .args(["-A", "-ww", "-o", "command="])
                .output()
                .unwrap();
            if !String::from_utf8_lossy(&ps.stdout)
                .lines()
                .any(|l| l.contains(&tag) && l.contains("unstale"))
            {
                return;
            }
            assert!(std::time::Instant::now() < until, "a background stage is still running");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn at_terminal(&self, args: &[&str], input: &str) -> String {
        self.at_terminal_with(args, input, &[])
    }

    /// [`World::at_terminal`] with extra environment variables. `input` is typed at the question, if one is asked.
    fn at_terminal_with(&self, args: &[&str], input: &str, extra: &[(&str, &str)]) -> String {
        let mut c = self.command(args, true);
        for (k, v) in extra {
            c.env(k, v);
        }
        let prompt = "Enter for 1|Enter to use it|Enter to choose";
        let (_, out) = support::at_terminal(&c, &[(prompt, input)], Duration::from_secs(60));
        // As the terminal shows it: a menu redrawn as the mark moves leaves its last state.
        support::screen(&out)
    }
}

#[test]
fn init_asks_once_at_a_terminal_and_setup_reopens_the_picker() {
    let w = World::new(Some(true));
    std::fs::write(w.path("repo/.env"), "OPENAI_API_KEY=x\n").unwrap();
    let init = [
        "init",
        "--service",
        "http://127.0.0.1:9",
        "--mode",
        "local",
        "--wait",
        "0",
        "--no-animation",
    ];
    // `--yes` asks nothing, even at a terminal, and chooses nothing.
    let mut yes = init.to_vec();
    yes.push("--yes");
    let quiet = w.at_terminal(&yes, "\n");
    assert!(!quiet.contains(QUESTION), "{quiet}");
    // Nothing configured and nobody asked: said once, as a warning, not passed over.
    assert_eq!(
        quiet
            .matches("warning: no provider chosen, so new release notes are not read. `unstale setup` lists the options.")
            .count(),
        1,
        "{quiet}"
    );
    let quiet = w.at_terminal(&yes, "\n");
    assert!(
        !quiet.contains("warning:"),
        "unchanged, so not said again:\n{quiet}"
    );
    assert!((w.chosen().is_null() && w.config().get("inference").is_none()), "{quiet}");
    let first = w.at_terminal(&init, "\n");
    assert_eq!(first.matches(QUESTION).count(), 1, "one question:\n{first}");
    // The question on its own line, a blank line, the options with the first marked, a blank line, how to answer.
    assert!(
        first.contains("How should unstale read new release notes?\n\n  ● Jev + OpenAI key   ≈ $0.036 a year ")
            && first.contains("\n  ○ Not now  ")
            && first.contains("\n\n↑↓ to move · Enter to choose · d for details\n"),
        "{first}"
    );
    assert!(
        first.contains(
            "Saved for you: Jev + OpenAI (JEV_API_KEY, OPENAI_API_KEY) reads release notes."
        ),
        "{first}"
    );
    assert_eq!(
        w.chosen()["labels"]["key_env"],
        "JEV_API_KEY",
        "Enter accepted the first option"
    );

    // Never asked again unprompted: a second init at a terminal keeps the choice and asks nothing.
    let again = w.at_terminal(&init, "4\n");
    assert!(!again.contains(QUESTION), "{again}");
    assert_eq!(w.chosen()["provider"], "openai");

    // `unstale setup` reopens it.
    let changed = w.at_terminal(&["setup"], "4\n");
    assert_eq!(changed.matches(QUESTION).count(), 1, "{changed}");
    assert!(
        changed.contains("Saved for you: Codex plan reads release notes."),
        "{changed}"
    );
    // `unstale setup` also states the token limit, a setting of the user's, and how to change it.
    assert!(
        changed
            .contains("of 48M this month (the default limit; `unstale setup --limit` changes it)"),
        "{changed}"
    );
    // Reopened and dismissed (Ctrl-D, or `q`): the choice stays, and the line says so.
    for typed in ["\u{4}", "q"] {
        let kept = w.at_terminal(&["setup"], typed);
        assert!(
            kept.contains("Nothing changed: still reading with Codex plan."),
            "{typed:?}: {kept}"
        );
        assert!(!kept.contains("Nothing chosen"), "{typed:?}: {kept}");
        assert_eq!(
            w.chosen(),
            serde_json::json!({"provider": "codex"})
        );
        assert!(!w.path("repo/.unstale/state/setup-dismissed").exists());
    }

    assert_eq!(
        w.chosen(),
        serde_json::json!({"provider": "codex"})
    );

    // Without a terminal it prints the options with their flags instead, and a flag changes the choice.
    let listed = w.ok(&["setup"], true);
    assert!(
        listed.contains("Show them these options as printed and ask.")
            && listed.contains("\n  1  unstale setup --inference jev+env:OPENAI_API_KEY\n"),
        "{listed}"
    );
    assert!(!listed.contains(QUESTION), "{listed}");
    // The full figures on request, with no question.
    let details = w.ok(&["setup", "--details"], true);
    assert!(
        details.contains("per package, per year")
            && details.contains("first sync, once")
            && !details.contains(QUESTION),
        "{details}"
    );
    w.ok(&["setup", "--inference", "none"], true);
    assert_eq!(
        w.chosen(),
        serde_json::json!({"provider": "none"})
    );
}

#[test]
fn the_managed_skill_tells_the_agent_to_show_the_options_and_ask_never_to_choose() {
    let w = World::new(Some(true));
    w.init(true, &[]);
    for f in [
        ".unstale/skills/review/SKILL.md",
        ".claude/skills/unstale-review/SKILL.md",
        ".agents/skills/unstale-review/SKILL.md",
    ] {
        let skill = std::fs::read_to_string(w.path("repo").join(f)).unwrap();
        assert!(skill.contains("## Reading release notes"), "{f}:\n{skill}");
        assert!(
            skill.contains("run `unstale setup`. Show the user the options it prints"),
            "{f}"
        );
        assert!(
            skill.contains("and ask which one they want. Never choose for them"),
            "{f}"
        );
        assert!(skill.contains("never ask them to paste a key"), "{f}");
        // What to do with the session-start line lives here, so the line itself stays short.
        assert!(
            skill.contains("## At session start")
                && skill.contains("review it only if the user asks"),
            "{f}"
        );
        assert!(
            skill.starts_with("---\nname: "),
            "the frontmatter stays first: {f}"
        );
    }
}

#[test]
fn status_shows_the_provider_this_months_tokens_and_the_users_limit() {
    let w = World::new(None);
    w.init(true, &[]);
    let status = |w: &World| w.ok(&["status", "--wait", "0", "--no-animation"], true);
    let before = status(&w);
    // The phrase the managed skill keys on.
    assert!(
        before.contains(
            "Release notes         not read: no provider chosen · `unstale setup` shows the options"
        ),
        "{before}"
    );
    assert!(
        !before.contains("Tokens"),
        "nothing spends tokens yet:\n{before}"
    );
    let ledger = w.path("cache/inference/usage-2026-11.jsonl");
    std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();
    std::fs::write(&ledger, "{\"day\":\"2026-11-09\",\"provider\":\"vercel\",\"model\":\"m\",\"input\":1200000,\"cached\":0,\"output\":300000}\n").unwrap();
    // As a pipeline records it: CI's choice is not marked, so the whole limit applies.
    let (code, _) = w.run_with(&["setup", "--inference", "env:AI_GATEWAY_API_KEY"], &[("CI", "true")]);
    assert_eq!(code, 0);
    let after = status(&w);
    // What is wrong comes first, as a warning; then the state.
    let warning =
        "warning: AI_GATEWAY_API_KEY is not set here, so new release notes are not read. Set it.";
    let provider =
        "Release notes         Vercel AI Gateway (AI_GATEWAY_API_KEY), your user config";
    assert!(
        after
            .find(warning)
            .zip(after.find(provider))
            .is_some_and(|(w, p)| w < p),
        "{after}"
    );
    assert!(
        after.contains("Tokens                1.5M of 48M this month (the default limit; `unstale setup --limit` changes it)"),
        "{after}"
    );
    // The limit is the user's own: `--limit` saves it in their config, never in the repo's.
    let set = w.ok(&["setup", "--limit", "1M"], true);
    assert_eq!(set.trim(), "Your monthly token limit: 1M.");
    assert!(w.config().get("monthly_token_limit").is_none());
    assert_eq!(w.user_config()["monthly_token_limit"], 1_000_000);
    let reached = status(&w);
    assert!(
        reached.contains("warning: monthly token limit reached, so new release notes wait. Change it: `unstale setup --limit`.")
            && reached.contains("Tokens                1.5M of 1M this month (your limit, reached)"),
        "{reached}"
    );
    // A repo's config cannot raise or remove it ...
    for loosened in [serde_json::json!("none"), serde_json::json!(900_000_000u64)] {
        w.set_config("monthly_token_limit", loosened.clone());
        let still = status(&w);
        assert!(
            still.contains("1.5M of 1M this month (your limit, reached)"),
            "{loosened}: {still}"
        );
    }
    // ... only lower it, and status says whose limit applies and where it is set.
    w.set_config("monthly_token_limit", serde_json::json!(500_000));
    let lowered = status(&w);
    assert!(
        lowered.contains("warning: this repo's token limit is reached, so new release notes wait. See .unstale/config.json.")
            && lowered.contains("Tokens                1.5M of 500k this month (this repo's limit, reached, set in .unstale/config.json)"),
        "{lowered}"
    );
    // What `--limit` prints is what applies here, not only what was saved.
    assert_eq!(
        w.ok(&["setup", "--limit", "none"], true).trim(),
        "Your monthly token limit: none. Here this repo's lower limit applies: 500k (.unstale/config.json)."
    );
    assert_eq!(w.user_config()["monthly_token_limit"], "none");
    assert_eq!(
        w.ok(&["setup", "--limit", "default"], true).trim(),
        "Your monthly token limit: the default, 48M. Here this repo's lower limit applies: 500k (.unstale/config.json)."
    );
    assert!(w.user_config().get("monthly_token_limit").is_none());
    // An absurd or malformed value is refused in one line and changes nothing.
    for bad in ["1e30", "99999999999999999999", "lots"] {
        let (_, out) = w.run_within(&["setup", "--limit", bad], true, Duration::from_secs(60));
        assert!(
            out.contains(&format!("--limit {bad}: ")) && out.trim().lines().count() == 1,
            "{bad}: {out}"
        );
        assert!(
            w.user_config().get("monthly_token_limit").is_none(),
            "{bad}"
        );
    }
    assert_eq!(
        w.chosen()["provider"],
        "vercel",
        "the choice beside it is kept"
    );
    // A corrupt token count: the fix names the file, and matches the cause.
    std::fs::write(&ledger, "{not json\n").unwrap();
    let corrupt = status(&w);
    assert!(
        corrupt.contains(
            "warning: unstale's token count is corrupt, so new release notes are not read. Delete "
        ) && corrupt.contains("usage-2026-11.jsonl (the count restarts)."),
        "{corrupt}"
    );
}

const INIT_AT_TERMINAL: [&str; 8] = [
    "init",
    "--service",
    "http://127.0.0.1:9",
    "--mode",
    "shared",
    "--wait",
    "0",
    "--no-animation",
];

#[test]
fn a_dismissed_picker_writes_no_config_and_is_not_asked_again_on_this_machine() {
    let w = World::new(Some(true));
    std::fs::write(w.path("repo/.env"), "OPENAI_API_KEY=x\n").unwrap();
    // End of input (Ctrl-D) at the question.
    let out = w.at_terminal(&INIT_AT_TERMINAL, "\u{4}");
    assert_eq!(out.matches(QUESTION).count(), 1, "{out}");
    assert!(
        out.contains(
            "Nothing chosen: new releases get advisories and deprecations only. `unstale setup` asks again."
        ),
        "{out}"
    );
    assert!(
        (w.chosen().is_null() && w.config().get("inference").is_none()),
        "a dismissal writes nothing to the shared config"
    );
    assert!(
        !w.path("config/config.json").exists(),
        "nor to the user config"
    );
    assert!(
        w.path("repo/.unstale/state/setup-dismissed").exists(),
        "this machine remembers it was asked"
    );
    let ignored = std::fs::read_to_string(w.path("repo/.unstale/.gitignore")).unwrap();
    assert!(
        ignored.lines().any(|l| l == "state/"),
        "the state directory is never committed: {ignored}"
    );
    let status = w.ok(&["status", "--wait", "0", "--no-animation"], true);
    assert!(status.contains("not read: no provider chosen"), "{status}");
    // init does not ask again here; `unstale setup` does, and typing None's number records "none".
    let again = w.at_terminal(&INIT_AT_TERMINAL, "\n");
    assert!(!again.contains(QUESTION), "{again}");
    assert!((w.chosen().is_null() && w.config().get("inference").is_none()));
    let chosen = w.at_terminal(&["setup"], "5\n");
    assert!(
        chosen.contains(
            "Saved for you: release notes not read, so new releases get advisories and deprecations only."
        ),
        "{chosen}"
    );
    assert_eq!(
        w.chosen(),
        serde_json::json!({"provider": "none"})
    );
}

/// [`World::command`] for a shell script at a terminal, run in the repository with the same environment; the script
/// gets the client's path as `$1`.
fn shell_at_terminal(w: &World, script: &str, answers: &[(&str, &str)]) -> (i32, String) {
    let mut c = Command::new("/bin/sh");
    c.args(["-c", script, "sh", env!("CARGO_BIN_EXE_unstale")]).current_dir(w.path("repo")).env_clear();
    for (k, v) in w.command(&[], true).get_envs() {
        if let Some(v) = v {
            c.env(k, v);
        }
    }
    let (code, out) = support::at_terminal(&c, answers, Duration::from_secs(60));
    (code, support::screen(&out))
}

#[test]
fn what_was_typed_before_the_menu_drew_is_not_an_answer() {
    let w = World::new(Some(true));
    std::fs::write(w.path("repo/.env"), "OPENAI_API_KEY=x\n").unwrap();
    w.init(true, &[]);
    w.wait_idle();
    // Typed at once, before the menu is drawn (an empty prompt matches at the start), then Ctrl-D at the menu.
    let mut c = w.command(&["setup"], true);
    c.stdin(Stdio::null());
    let (_, out) = support::at_terminal(
        &c,
        &[("", "git status\n"), ("Enter to choose", "\u{4}")],
        Duration::from_secs(60),
    );
    let out = support::screen(&out);
    assert!(!out.contains("Saved for"), "{out}");
    assert!(out.contains("Nothing chosen"), "{out}");
    assert!(w.chosen().is_null(), "{out}");
}

#[test]
fn a_signal_at_the_menu_restores_the_terminal() {
    let w = World::new(Some(true));
    std::fs::write(w.path("repo/.env"), "OPENAI_API_KEY=x\n").unwrap();
    w.init(true, &[]);
    w.wait_idle();
    // Once the menu has the terminal in key-at-a-time mode, the signal; then the terminal's mode as the shell sees it.
    let script = r#"P=$$
for sig in TERM HUP INT; do
  ( until stty -a </dev/tty 2>/dev/null | grep -q -- '-icanon'; do sleep 0.05; done; pkill -$sig -P $P unstale ) &
  "$1" setup
  echo "after $sig: exit $? $(stty -a | grep -o -- '-*icanon' | head -1) $(stty -a | grep -o -- '-*echo ' | head -1)"
done"#;
    let (_, out) = shell_at_terminal(&w, script, &[]);
    for (sig, code) in [("TERM", 143), ("HUP", 129), ("INT", 130)] {
        assert!(out.contains(&format!("after {sig}: exit {code} icanon echo")), "{out}");
    }
    assert!(w.chosen().is_null(), "{out}");
}

#[test]
fn a_terminal_that_cannot_switch_mode_is_put_back_and_asked_by_typing() {
    let w = World::new(Some(true));
    std::fs::write(w.path("repo/.env"), "OPENAI_API_KEY=x\n").unwrap();
    w.init(true, &[]);
    w.wait_idle();
    // An `stty` that saves the settings but refuses to change them.
    let log = w.path("stty.log");
    std::fs::create_dir_all(w.path("bin")).unwrap();
    let fake = w.path("bin/stty");
    std::fs::write(
        &fake,
        format!(
            "#!/bin/sh\necho \"$*\" >> '{}'\ncase \"$1\" in -icanon) exit 1;; esac\nexec /bin/stty \"$@\"\n",
            log.display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let out = w.at_terminal(&["setup"], "\n");
    let calls = std::fs::read_to_string(&log).unwrap();
    let lines: Vec<&str> = calls.lines().collect();
    let at = lines.iter().position(|l| l.starts_with("-icanon")).unwrap_or_else(|| panic!("{calls}"));
    let saved = lines[..at].iter().rev().find(|l| **l == "-g").map(|_| ()).is_some();
    assert!(saved, "{calls}");
    // The call after the refused one puts back what `-g` printed: a single word of settings, not a change.
    let restore = lines.get(at + 1).unwrap_or_else(|| panic!("{calls}"));
    assert!(!restore.starts_with('-') && !restore.contains(' '), "{calls}");
    assert!(out.contains("Enter for 1, a number to choose, or d for details:"), "{out}");
    assert!(out.contains("Saved for you: Jev + OpenAI"), "{out}");
}

#[test]
fn ctrl_c_at_the_question_writes_nothing_anywhere() {
    let w = World::new(Some(true));
    std::fs::write(w.path("repo/.env"), "OPENAI_API_KEY=x\n").unwrap();
    w.init(true, &[]);
    // What init started in the background (it is detached) finishes first: its writes are not the question's.
    w.wait_idle();
    let before = w.written_files();
    let out = w.at_terminal(&["setup"], "\u{3}");
    assert!(out.contains(QUESTION), "{out}");
    assert!(!out.contains("Saved for"), "{out}");
    assert_eq!(
        w.written_files(),
        before,
        "Ctrl-C leaves every file as it was"
    );
    assert!(!w.path("config/config.json").exists());
    assert!(!w.path("repo/.unstale/state/setup-dismissed").exists());
}

#[test]
fn an_agent_in_a_pseudo_terminal_gets_the_listing_never_the_question() {
    let w = World::new(Some(true));
    std::fs::write(w.path("repo/.env"), "OPENAI_API_KEY=x\n").unwrap();
    for agent in [
        ("CLAUDECODE", "1"),
        ("CODEX_SANDBOX", "seatbelt"),
        ("UNSTALE_AGENT", "1"),
    ] {
        let init = w.at_terminal_with(&INIT_AT_TERMINAL, "\n", &[agent]);
        assert!(!init.contains(QUESTION), "{agent:?}: {init}");
        // The agent is told the choice is the user's, and how to put it to them.
        assert!(
            init.contains("Choice pending: how unstale reads new release notes. Run `unstale setup` and ask the user."),
            "{agent:?}: {init}"
        );
        assert!(
            (w.chosen().is_null() && w.config().get("inference").is_none()),
            "{agent:?}: a stray Enter chose nothing"
        );
        let setup = w.at_terminal_with(&["setup"], "\n", &[agent]);
        assert!(
            !setup.contains(QUESTION) && !setup.contains("Enter to use it"),
            "{agent:?}: {setup}"
        );
        assert!(
            setup.contains("  1  unstale setup --inference jev+env:OPENAI_API_KEY"),
            "{agent:?}: {setup}"
        );
        assert!((w.chosen().is_null() && w.config().get("inference").is_none()), "{agent:?}");
    }
}

#[test]
fn files_detection_must_never_open_stay_unopened() {
    // Each is a FIFO: opening one for reading blocks until a writer comes, and none ever does.
    let w = World::new(Some(true));
    std::fs::write(w.path("repo/.env"), "OPENAI_API_KEY=x\n").unwrap();
    std::fs::create_dir_all(w.path("home/.config/fish")).unwrap();
    let never = [
        ".env",
        "home/.env",
        "repo/.env.local",
        "home/.bashrc",
        "home/.bash_profile",
        "home/.profile",
        "home/.zshrc",
        "home/.zprofile",
        "home/.zshenv",
        "home/.config/fish/config.fish",
    ];
    for f in never {
        assert!(
            Command::new("mkfifo")
                .arg(w.path(f))
                .status()
                .unwrap()
                .success(),
            "{f}"
        );
    }
    w.init(true, &[]);
    let listed = w.ok(&["setup"], true);
    assert!(listed.contains("OPENAI_API_KEY (.env)"), "{listed}");
    w.ok(&["setup", "--inference", "openai"], true);
    w.ok(&["status", "--wait", "0", "--no-animation"], true);
}

#[test]
fn a_choice_an_agent_records_is_said_to_the_next_person_at_a_terminal_and_has_a_tenth_of_the_limit() {
    let w = World::new(None);
    w.init(true, &[]);
    let agent = [("CLAUDECODE", "1")];
    let (code, out) = w.run_with(&["setup", "--inference", "openai"], &agent);
    assert_eq!(code, 0, "{out}");
    let user = w.user_config();
    let entry = &user["repositories"][w.path("repo").canonicalize().unwrap().to_string_lossy().as_ref()];
    assert_eq!((entry["chosen_by"].as_str(), entry["chosen_on"].as_str()), (Some("agent"), Some("2026-11-10")), "{user}");
    // Until a person sees it, `unstale status` says it first, to every reader; and the limit is a tenth.
    let line = "unstale reads release notes on your OpenAI key (≈ $0.052 a year), chosen through your agent on 10 November. Undo: `unstale setup --inference none`";
    for extra in [&agent[..], &[("CI", "true")], &[]] {
        let (_, status) = w.run_with(&["status", "--wait", "0", "--no-animation"], extra);
        assert!(status.contains(line), "{extra:?}: {status}");
        assert!(status.contains("Tokens                0 of 4.8M this month (a tenth of the limit until you run unstale at a terminal)"), "{status}");
    }
    // At the limit, the warning says why and how to lift it.
    let ledger = w.path("cache/inference/usage-2026-11.jsonl");
    std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();
    std::fs::write(&ledger, "{\"day\":\"2026-11-09\",\"provider\":\"openai\",\"model\":\"m\",\"input\":4000000,\"cached\":0,\"output\":900000}\n").unwrap();
    let (_, reached) = w.run_with(&["status", "--wait", "0", "--no-animation"], &agent);
    assert!(reached.contains("warning: release notes wait: your agent's choice gets a tenth of the token limit until you run unstale at a terminal."), "{reached}");
    // Any command a person runs at a terminal says it once, at the top, and lifts the tenth.
    let first = w.at_terminal(&["report"], "");
    assert!(first.lines().any(|l| l.trim_end() == line), "{first}");
    let entry = &w.user_config()["repositories"][w.path("repo").canonicalize().unwrap().to_string_lossy().as_ref()];
    assert!(entry.get("chosen_by").is_none() && entry["inference"]["provider"] == "openai", "{entry}");
    let again = w.at_terminal(&["status", "--wait", "0", "--no-animation"], "");
    assert!(!again.contains("chosen through your agent") && again.contains("4.9M of 48M this month"), "{again}");
}

#[test]
fn a_choice_from_ci_or_of_none_is_not_marked_and_hooks_cannot_record_one_that_spends() {
    let w = World::new(None);
    w.init(true, &[]);
    let marked = |w: &World| w.user_config().to_string().contains("chosen_by");
    // CI: the pipeline author's choice, said nowhere and not cut.
    let (code, _) = w.run_with(&["setup", "--inference", "openai"], &[("CI", "true")]);
    assert_eq!(code, 0);
    assert!(!marked(&w));
    let (_, status) = w.run_with(&["status", "--wait", "0", "--no-animation"], &[("CI", "true")]);
    assert!(status.contains("0 of 48M this month") && !status.contains("chosen through"), "{status}");
    // "none" spends nothing: never marked, by an agent or a script.
    for extra in [&[("CLAUDECODE", "1")][..], &[]] {
        let (code, _) = w.run_with(&["setup", "--inference", "none"], extra);
        assert_eq!(code, 0);
        assert!(!marked(&w), "{extra:?}");
    }
    // An install script or a Git hook: refused in one line, a non-zero exit, nothing written.
    let before = std::fs::read(w.path("config/config.json")).unwrap();
    for (hook, why) in [
        (&[("npm_lifecycle_event", "postinstall"), ("CLAUDECODE", "1")][..], "a package install script"),
        (&[("GIT_EXEC_PATH", "/usr/libexec/git-core"), ("GIT_INDEX_FILE", ".git/index"), ("GIT_PREFIX", "")], "a Git hook"),
    ] {
        for args in [&["setup", "--inference", "openai"][..], &["init", "--yes", "--inference", "codex"]] {
            let (code, out) = w.run_with(args, hook);
            assert_ne!(code, 0, "{args:?}: {out}");
            assert_eq!(
                out.trim(),
                format!("error: not saved: a choice that spends is not taken from {why}. Run `unstale setup` yourself."),
                "{args:?}"
            );
            assert_eq!(std::fs::read(w.path("config/config.json")).unwrap(), before, "{args:?}");
        }
        let (code, _) = w.run_with(&["setup", "--inference", "none"], hook);
        assert_eq!(code, 0, "none is taken from anywhere");
    }
}

#[test]
fn raising_the_limit_does_not_lift_the_tenth_and_is_refused_from_hooks() {
    let w = World::new(None);
    w.init(true, &[]);
    let agent = [("CLAUDECODE", "1")];
    let status = |w: &World| w.run_with(&["status", "--wait", "0", "--no-animation"], &agent).1;
    let run = |w: &World, args: &[&str]| {
        let (code, out) = w.run_with(args, &agent);
        assert_eq!(code, 0, "{args:?}: {out}");
    };
    let person_sees = |w: &World| w.at_terminal(&["report"], "");
    // An agent chooses a provider and raises the limit in one command: a tenth of the default, not of the limit.
    run(&w, &["setup", "--inference", "openai", "--limit", "480M"]);
    let s = status(&w);
    assert!(s.contains("0 of 4.8M this month (a tenth of the limit"), "{s}");
    // Recording the choice again keeps the limit's mark; the line names the limit and how to restore it.
    run(&w, &["setup", "--inference", "openai"]);
    let line = "on your OpenAI key (≈ $0.052 a year) with a token limit of 480M, chosen through your agent on 10 November. Undo: `unstale setup --inference none --limit default`";
    assert!(status(&w).contains(line), "{}", status(&w));
    assert!(person_sees(&w).contains(line));
    assert!(status(&w).contains("0 of 480M this month"));

    // A limit raised first, a choice recorded after: the line still names the limit, until a person sees it.
    run(&w, &["setup", "--limit", "10M"]);
    run(&w, &["setup", "--inference", "none"]);
    run(&w, &["setup", "--limit", "480M"]);
    run(&w, &["setup", "--inference", "openai"]);
    let s = status(&w);
    assert!(s.contains("with a token limit of 480M, chosen through your agent") && s.contains("`unstale setup --inference none --limit 10M`") && s.contains("of 4.8M"), "{s}");
    person_sees(&w);
    assert!(status(&w).contains("0 of 480M this month"));

    // Raised from another repository with no choice of its own: the mark is the user's, so this one gets the tenth.
    let other = w.path("other");
    std::fs::write(other.join("package.json"), r#"{"name":"other","dependencies":{"zod":"^4.0.0"}}"#).unwrap();
    std::process::Command::new("git").args(["init", "-q"]).current_dir(&other).status().unwrap();
    for raise in ["none", "960M"] {
        let mut c = w.command(&["init", "--service", "http://127.0.0.1:9", "--mode", "local", "--yes", "--wait", "0", "--no-animation"], true);
        c.current_dir(&other);
        assert!(c.status().unwrap().success());
        let mut c = w.command(&["setup", "--limit", raise], true);
        c.current_dir(&other).env("CLAUDECODE", "1");
        assert!(c.status().unwrap().success());
        let s = status(&w);
        assert!(s.contains("set through your agent on 10 November. Undo: `unstale setup --limit 480M`") && s.contains("of 4.8M this month"), "{raise}: {s}");
        person_sees(&w);
        run(&w, &["setup", "--limit", "480M"]);
        person_sees(&w);
    }

    // An install script or a Git hook cannot raise or remove it; lowering is taken.
    for (hook, why) in [
        (&[("npm_lifecycle_event", "postinstall")][..], "a package install script"),
        (&[("GIT_EXEC_PATH", "/usr/libexec/git-core"), ("GIT_INDEX_FILE", ".git/index"), ("GIT_PREFIX", "")], "a Git hook"),
    ] {
        w.ok(&["setup", "--limit", "10M"], true);
        let before = std::fs::read(w.path("config/config.json")).unwrap();
        for raise in ["1000000M", "none", "default"] {
            let (code, out) = w.run_with(&["setup", "--limit", raise], hook);
            assert_ne!(code, 0, "{raise}: {out}");
            assert_eq!(out.trim(), format!("error: not saved: a higher token limit is not taken from {why}. Run `unstale setup --limit` yourself."));
            assert_eq!(std::fs::read(w.path("config/config.json")).unwrap(), before, "{raise}");
        }
        let (code, _) = w.run_with(&["setup", "--limit", "1M"], hook);
        assert_eq!(code, 0, "lowering is taken");
    }
}
