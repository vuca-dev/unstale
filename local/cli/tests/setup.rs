#![cfg(unix)]
//! Provider setup through the binary: detection by name only, `--inference`, no question without a terminal, and
//! canaries that must never leave the files they were planted in.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const REPO_CANARY: &str = "canary-repo-env-3f9a1c";
const OTHER_CANARY: &str = "canary-other-repo-8d2e7b";
const AUTH_CANARY: &str = "canary-codex-auth-51c0aa";
const SHELL_CANARY: &str = "canary-shell-key-77be42";

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
            let login = if logged_in {
                "echo 'Logged in using ChatGPT'; exit 0"
            } else {
                "echo 'Not logged in'; exit 1"
            };
            let script = format!(
                "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex-cli 0.166.0'; exit 0; fi\nif [ \"$1\" = \"login\" ]; then {login}; fi\nexit 2\n"
            );
            let p = w.path("bin/codex");
            std::fs::write(&p, script).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
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
                format!("{}:/usr/bin:/bin", self.path("bin").display()),
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
        let mut child = self.command(args, switch).spawn().unwrap();
        let start = Instant::now();
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if start.elapsed() > limit {
                let _ = child.kill();
                panic!(
                    "`unstale {}` did not finish in {limit:?}: it is blocked opening a file it must never open",
                    args.join(" ")
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let out = child.wait_with_output().unwrap();
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        (out.status.code().unwrap_or(-1), text)
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

    /// Every file under the temporary directory but the three planted ones, as text.
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
                } else if t.is_file() && !planted.contains(&p) {
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
    assert!(!out.contains("Choose"), "{out}");
    assert!(w.config().get("inference").is_none());
    let listed = w.ok(&["setup"], true);
    out += &listed;
    // Names from the shell (JEV_API_KEY) and from this repository's .env (OPENAI_API_KEY); nothing from the other
    // repository's .env (ANTHROPIC_API_KEY); Codex from PATH and its login status.
    assert!(
        listed.contains("Jev labelling API (JEV_API_KEY) + OpenAI (OPENAI_API_KEY in .env)"),
        "{listed}"
    );
    assert!(listed.contains("Codex plan"), "{listed}");
    assert!(
        !listed.contains("ANTHROPIC_API_KEY"),
        "another repository's .env was read:\n{listed}"
    );
    out += &w.ok(&["setup", "--inference", "jev+env:OPENAI_API_KEY"], true);
    out += &w.ok(&["status", "--wait", "0", "--no-animation"], true);
    out += &w.ok(&["setup", "--user", "--inference", "codex"], true);
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
        listed.contains("Codex plan") && listed.contains("OPENAI_API_KEY in .env"),
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
    assert!(!out.contains("Model provider"), "{out}");
    assert_eq!(
        w.ok(&["setup"], false).trim(),
        "Model steps are off in this version; there is nothing to set up."
    );
    let status = w.ok(&["status", "--wait", "0", "--no-animation"], false);
    assert!(
        !status.contains("Model provider") && !status.contains("Model tokens"),
        "{status}"
    );
    let skill = std::fs::read_to_string(w.path("repo/.unstale/skills/review/SKILL.md")).unwrap();
    assert!(!skill.contains("unstale setup"), "{skill}");
}

impl World {
    /// Runs at a terminal (a pseudo-terminal from `script`), typing `input`.
    fn at_terminal(&self, args: &[&str], input: &str) -> String {
        use std::io::Write;
        let bin = env!("CARGO_BIN_EXE_unstale");
        let c = self.command(args, true);
        let mut s = if cfg!(target_os = "macos") {
            let mut s = Command::new("script");
            s.arg("-q").arg("/dev/null").arg(bin).args(args);
            s
        } else {
            let mut s = Command::new("script");
            s.args(["-qec", &format!("{bin} {}", args.join(" ")), "/dev/null"]);
            s
        };
        s.current_dir(self.path("repo"))
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in c.get_envs() {
            if let Some(v) = v {
                s.env(k, v);
            }
        }
        let mut child = s.spawn().unwrap();
        // Kept open until the run ends: closing it would reach the program as end of input.
        let mut stdin = child.stdin.take().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let _ = stdin.write_all(input.as_bytes());
        let out = child.wait_with_output().unwrap();
        drop(stdin);
        String::from_utf8_lossy(&out.stdout).replace('\r', "")
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
        "--yes",
        "--wait",
        "0",
        "--no-animation",
    ];
    let first = w.at_terminal(&init, "\n");
    assert_eq!(
        first.matches("Choose 1–").count(),
        1,
        "one question:\n{first}"
    );
    assert!(
        first.contains("  1) Jev labelling API (JEV_API_KEY) + OpenAI (OPENAI_API_KEY in .env)"),
        "{first}"
    );
    assert!(first.contains("Model provider: Jev labelling API + OpenAI (JEV_API_KEY, OPENAI_API_KEY) · saved in .unstale/config.json"), "{first}");
    assert_eq!(
        w.config()["inference"]["labels"]["key_env"],
        "JEV_API_KEY",
        "Enter accepted the first option"
    );

    // Never asked again unprompted: a second init at a terminal keeps the choice and asks nothing.
    let again = w.at_terminal(&init, "4\n");
    assert!(!again.contains("Choose"), "{again}");
    assert_eq!(w.config()["inference"]["provider"], "openai");

    // `unstale setup` reopens it.
    let changed = w.at_terminal(&["setup"], "4\n");
    assert_eq!(changed.matches("Choose 1–").count(), 1, "{changed}");
    assert!(
        changed.contains("Model provider: Codex plan · saved in .unstale/config.json"),
        "{changed}"
    );
    assert_eq!(
        w.config()["inference"],
        serde_json::json!({"provider": "codex"})
    );

    // Without a terminal it prints the options with their flags instead, and a flag changes the choice.
    let listed = w.ok(&["setup"], true);
    assert!(
        listed.contains("[--inference jev+env:OPENAI_API_KEY]")
            && listed.contains("`unstale setup --inference <value>`"),
        "{listed}"
    );
    w.ok(&["setup", "--inference", "none"], true);
    assert_eq!(
        w.config()["inference"],
        serde_json::json!({"provider": "none"})
    );
}
