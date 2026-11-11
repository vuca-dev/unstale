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
            .env("UNSTALE_TODAY", "2026-11-10")
            .env("UNSTALE_NO_REGISTRY", "1")
            .env("JEV_API_KEY", SHELL_CANARY)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if switch {
            c.env("UNSTALE_EDGE_INFERENCE", "1");
        }
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
    assert!(w.config().get("inference").is_none());
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
    assert!(user.contains("this repo's own choice (Jev labelling API + OpenAI (JEV_API_KEY, OPENAI_API_KEY)) still applies here"), "{user}");
    out += &user;
    assert_eq!(
        w.config()["inference"]["key_env"],
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
        w.config().get("inference").is_none(),
        "the flag is ignored with the switch off"
    );
    for line in SWITCH_ON_LINES {
        assert!(!out.contains(line), "{line:?} with the switch off:\n{out}");
    }
    assert_eq!(
        w.ok(&["setup"], false).trim(),
        "Model steps are off in this version; there is nothing to set up."
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
const QUESTION: &str = "Enter for 1";

impl World {
    /// Runs at a terminal (a pseudo-terminal from `script`), typing `input`.
    fn at_terminal(&self, args: &[&str], input: &str) -> String {
        self.at_terminal_with(args, input, &[])
    }

    /// [`World::at_terminal`] with extra environment variables. `input` is typed at the question, if one is asked.
    fn at_terminal_with(&self, args: &[&str], input: &str, extra: &[(&str, &str)]) -> String {
        let mut c = self.command(args, true);
        for (k, v) in extra {
            c.env(k, v);
        }
        let prompt = "Enter for 1|Enter to use it";
        let (_, out) = support::at_terminal(&c, &[(prompt, input)], Duration::from_secs(60));
        out.replace('\r', "")
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
            .matches("warning: no model provider is configured, so new release notes are not read.")
            .count(),
        1,
        "{quiet}"
    );
    let quiet = w.at_terminal(&yes, "\n");
    assert!(
        !quiet.contains("warning:"),
        "unchanged, so not said again:\n{quiet}"
    );
    assert!(w.config().get("inference").is_none(), "{quiet}");
    let first = w.at_terminal(&init, "\n");
    assert_eq!(first.matches(QUESTION).count(), 1, "one question:\n{first}");
    // The question on its own line, a blank line, the table.
    assert!(
        first.contains("How should unstale read new release notes?\n\n     Read with"),
        "{first}"
    );
    assert!(
        first.contains("\n  1  Jev + OpenAI       ≈ $0.036 ")
            && first.contains("\n     Keys: JEV_API_KEY, OPENAI_API_KEY (.env)\n"),
        "{first}"
    );
    assert!(first.contains("Reading release notes with Jev + OpenAI (JEV_API_KEY, OPENAI_API_KEY). Saved in .unstale/config.json"), "{first}");
    assert_eq!(
        w.config()["inference"]["labels"]["key_env"],
        "JEV_API_KEY",
        "Enter accepted the first option"
    );

    // Never asked again unprompted: a second init at a terminal keeps the choice and asks nothing.
    let again = w.at_terminal(&init, "4\n");
    assert!(!again.contains(QUESTION), "{again}");
    assert_eq!(w.config()["inference"]["provider"], "openai");

    // `unstale setup` reopens it.
    let changed = w.at_terminal(&["setup"], "4\n");
    assert_eq!(changed.matches(QUESTION).count(), 1, "{changed}");
    assert!(
        changed.contains("Reading release notes with Codex plan. Saved in .unstale/config.json"),
        "{changed}"
    );
    // `unstale setup` also states the token limit, a setting of the user's, and how to change it.
    assert!(
        changed
            .contains("of 48M this month (the default limit; `unstale setup --limit` changes it)"),
        "{changed}"
    );
    assert_eq!(
        w.config()["inference"],
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
        w.config()["inference"],
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
    w.ok(&["setup", "--inference", "env:AI_GATEWAY_API_KEY"], true);
    let after = status(&w);
    // What is wrong comes first, as a warning; then the state.
    let warning = "warning: AI_GATEWAY_API_KEY is not set here, so new release notes are not read. Set it, or run `unstale setup`.";
    let provider =
        "Release notes         Vercel AI Gateway (AI_GATEWAY_API_KEY), this repo's config";
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
    // The limit is the user's: a number, or none, in this repo's config or theirs.
    let set = w.ok(&["setup", "--limit", "1M"], true);
    assert_eq!(
        set.trim(),
        "Monthly token limit: 1M. Saved in .unstale/config.json; past it, new release notes wait for next month."
    );
    assert_eq!(w.config()["monthly_token_limit"], 1_000_000);
    let reached = status(&w);
    assert!(
        reached.contains("warning: monthly token limit reached, so new release notes wait for next month. Raise or remove it: `unstale setup --limit`.")
            && reached.contains("Tokens                1.5M of 1M this month (this repo's limit, reached; `unstale setup --limit` changes it)"),
        "{reached}"
    );
    w.ok(&["setup", "--limit", "none"], true);
    assert_eq!(w.config()["monthly_token_limit"], "none");
    assert!(status(&w).contains("Tokens                1.5M this month, no limit"));
    w.ok(&["setup", "--limit", "default"], true);
    assert!(w.config().get("monthly_token_limit").is_none());
    assert_eq!(
        w.config()["inference"]["provider"],
        "vercel",
        "the choice beside it is kept"
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
            "Nothing chosen: unstale reads no release notes, advisories and deprecations only. `unstale setup` asks again."
        ),
        "{out}"
    );
    assert!(
        w.config().get("inference").is_none(),
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
    assert!(w.config().get("inference").is_none());
    let chosen = w.at_terminal(&["setup"], "5\n");
    assert!(
        chosen.contains(
            "Not reading release notes: advisories and deprecations only. Saved in .unstale/config.json"
        ),
        "{chosen}"
    );
    assert_eq!(
        w.config()["inference"],
        serde_json::json!({"provider": "none"})
    );
}

#[test]
fn ctrl_c_at_the_question_writes_nothing_anywhere() {
    let w = World::new(Some(true));
    std::fs::write(w.path("repo/.env"), "OPENAI_API_KEY=x\n").unwrap();
    w.init(true, &[]);
    let before = w.written_files();
    let out = w.at_terminal(&["setup"], "\u{3}");
    assert!(out.contains(QUESTION), "{out}");
    assert!(!out.contains("Saved in"), "{out}");
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
            init.contains("Choice pending: how unstale reads new release notes. Run `unstale setup`, show the user its options and ask."),
            "{agent:?}: {init}"
        );
        assert!(
            w.config().get("inference").is_none(),
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
        assert!(w.config().get("inference").is_none(), "{agent:?}");
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
