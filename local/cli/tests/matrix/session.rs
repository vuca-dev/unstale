//! A scenario's session: the commands a person, an agent or CI runs, as they ran.

use super::*;

/// One command of a session, as it ran.
pub(crate) struct Ran {
    pub(crate) step: Step,
    /// The command line as the person or agent typed it, or a note for a step that did not run.
    pub(crate) shown: String,
    /// Whether it ran at a terminal.
    pub(crate) terminal: bool,
    pub(crate) code: i32,
    /// stdout and stderr in the order written.
    pub(crate) output: String,
    /// A line that explains a step the user would not see, shown in the transcript as a comment.
    pub(crate) note: Option<String>,
    /// stderr on its own, for a session-start hook (whose stderr an agent shows the user); else in `output`.
    pub(crate) stderr: Option<String>,
    /// How long it took (a session-start hook must return within 2 s).
    pub(crate) took: Duration,
}

pub(crate) struct Session {
    pub(crate) world: World,
    pub(crate) ran: Vec<Ran>,
    /// The provider the session chose, as recorded in the config, when the model step ran.
    pub(crate) chosen: Option<serde_json::Value>,
    /// Upgraded only: each command other than `init` that added a session-start integration the earlier setup did not
    /// have, with what it added.
    pub(crate) added: Vec<String>,
}

/// The session-start integrations the release that turned the switch on by default adds: `init` writes them, no
/// other command does.
pub(crate) const NEW_INTEGRATIONS: [&str; 2] = [".codex/hooks.json", ".opencode/plugins/unstale-session.js"];

/// What every question opens with: the picker's prompt, its one-option form, and the prompt with nothing usable.
/// After the details (`d`) the same question stays open at `Your choice (Enter for <n>): `, which is not another
/// question.
/// A question: `Enter for <n>,` (the first option, or the one this repository's committed config suggests) or
/// `Enter to use it`, where the answer is typed; `Enter to choose` where it is a menu.
pub(crate) fn questions(text: &str) -> usize {
    let numbered = text
        .match_indices("Enter for ")
        .filter(|(i, m)| {
            let rest = &text[i + m.len()..];
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            digits > 0 && rest[digits..].starts_with(',')
        })
        .count();
    // The menu's line that says how to answer; redrawn in place as the mark moves, so once on the screen.
    numbered + text.matches("Enter to use it").count() + text.matches("Enter to choose").count()
}

pub(crate) fn run_step(w: &World, s: &Scenario, step: Step, ran: &[Ran]) -> Option<Ran> {
    let init = |yes: bool| {
        let mut a: Vec<String> = ["init", "--wait", "0", "--no-animation"]
            .iter()
            .map(|x| x.to_string())
            .collect();
        if yes {
            a.push("--yes".into());
        }
        a
    };
    let terminal = s.invocation.terminal;
    match step {
        Step::Init => Some(exec(w, s, init(false), terminal)),
        // The fault runs CI's init at a terminal without `--yes`, so it asks.
        Step::InitYes if s.fault == Some(Fault::QuestionWithoutTerminal) => {
            Some(exec(w, s, init(false), true))
        }
        // `--yes` at a terminal too: it never asks.
        Step::InitYes if s.fault == Some(Fault::YesIgnored) => {
            let mut r = exec(w, s, init(false), terminal);
            r.shown = format!("unstale {}", init(true).join(" "));
            Some(r)
        }
        Step::InitYes => Some(exec(w, s, init(true), terminal)),
        Step::InitFlag(value) => {
            let mut a = init(true);
            a.extend(["--inference".to_string(), value.to_string()]);
            Some(exec(w, s, a, false))
        }
        Step::Sync => Some(exec(w, s, vec!["sync".into()], s.invocation.terminal)),
        Step::Status => Some(exec(
            w,
            s,
            ["status", "--wait", "0", "--no-animation"]
                .iter()
                .map(|x| x.to_string())
                .collect(),
            s.invocation.terminal,
        )),
        Step::AgentSetup => {
            let status = ran.iter().rev().find(|r| r.step == Step::Status)?;
            // Nothing chosen, with or without a suggestion in this repository's committed config.
            if !status.output.contains("not read: no provider chosen")
                && !status.output.contains("you have not chosen")
            {
                return None;
            }
            let listed = exec(w, s, vec!["setup".into()], s.invocation.terminal);
            Some(listed)
        }
        Step::SessionSync if s.answer == Answer::Slow => Some(slow_step(w, s)),
        Step::SessionSync => Some(exec(
            w,
            s,
            vec!["session-sync".into()],
            s.invocation.terminal,
        )),
        Step::SessionStart => Some(session_start(w, s)),
        Step::RemoveHooks => {
            // The repository commits its own agent settings without unstale's hook: an installer never writes a file
            // Git tracks, so no session-start hook is installed here.
            for (rel, text) in [
                (
                    ".claude/settings.local.json",
                    r#"{"permissions":{"allow":[]}}"#,
                ),
                (".codex/hooks.json", r#"{"hooks":{}}"#),
                (
                    ".opencode/plugins/unstale-session.js",
                    "export const Mine = async () => ({});\n",
                ),
            ] {
                write(&w.repo().join(rel), text);
                let _ = Command::new("git")
                    .args(["add", "-f", rel])
                    .current_dir(w.repo())
                    .status();
            }
            Some(Ran {
                step: Step::RemoveHooks,
                shown: String::new(),
                terminal: false,
                code: 0,
                output: String::new(),
                note: Some("the repository commits its own agent settings, so no session-start hook of unstale's is installed".into()),
                stderr: None,
                took: Duration::ZERO,
            })
        }
        Step::Injected => None,
    }
}

/// The agent's follow-up to `unstale setup`: the user's answer, recorded with the flag printed beside it.
pub(crate) fn agent_answer(w: &World, s: &Scenario, listed: &Ran) -> Option<Ran> {
    // The command printed for option 1.
    let value = listed.output.lines().find_map(|l| {
        l.strip_prefix("  1  unstale setup --inference ")
            .map(|v| v.trim().to_string())
    })?;
    let mut r = exec(
        w,
        s,
        vec!["setup".into(), "--inference".into(), value],
        s.invocation.terminal,
    );
    r.note = Some("the agent showed the options and asked; the user chose option 1".into());
    Some(r)
}

/// What the person types at a terminal: `answer` at the question; after the details (`d`), Enter where the question
/// stays open; and at any further question, Ctrl-D, so a second question ends the run and is counted rather than
/// waiting for an answer that never comes.
pub(crate) fn terminal_answers(answer: &str) -> Vec<(&'static str, &str)> {
    // Enter accepts the first option, or the one this repository's committed config suggests.
    const PROMPT: &str = "Enter for |Enter to use it|Enter to choose";
    let mut a = vec![(PROMPT, answer)];
    // Where the answer is typed. At a menu, `d` draws it again under the details and the Enter after it chooses.
    if answer.starts_with('d') {
        a.push(("Your choice (Enter for ", "\n"));
    }
    a.push((PROMPT, "\u{4}"));
    a
}

pub(crate) fn exec(w: &World, s: &Scenario, args: Vec<String>, terminal: bool) -> Ran {
    let started = std::time::Instant::now();
    let cmd = w.command(s, &args);
    let (code, output) = if terminal {
        let answer = if s.invocation.answer.is_empty() {
            "\n"
        } else {
            s.invocation.answer
        };
        // Having asked for the details, the person accepts the first option where the question stays open.
        let (code, raw) =
            support::at_terminal(&cmd, &terminal_answers(answer), Duration::from_secs(60));
        // A terminal's echo of Ctrl-D and Ctrl-C differs by system (macOS prints `^D` and backs over it, Linux
        // prints nothing): the screen shows neither.
        let raw = raw
            .replace("^D\u{8}\u{8}", "")
            .replace("^D", "")
            .replace("^C", "");
        (code, support::screen(&raw))
    } else {
        // stderr into stdout, so the output keeps the order it was written in.
        let mut sh = Command::new("/bin/sh");
        sh.arg("-c")
            .arg(format!("{}exec \"$0\" \"$@\" 2>&1", reload_logger()))
            .arg(cmd.get_program())
            .args(cmd.get_args());
        sh.current_dir(w.repo()).env_clear();
        for (k, v) in w.env(s) {
            sh.env(k, v);
        }
        let (code, out, err) = support::run_within(&mut sh, Duration::from_secs(60));
        (code, out + &err)
    };
    Ran {
        step: Step::Init,
        shown: format!("unstale {}", args.join(" ")),
        terminal,
        code,
        output,
        note: None,
        stderr: None,
        took: started.elapsed(),
    }
}

/// The provider the session ended up with: the user's own choice, read from the user's config and nowhere else (their
/// answer for this repository, else their choice for every repository). A provider named in the repository's config
/// is nobody's choice; its "none" stands, since it spends nothing.
pub(crate) fn chosen(w: &World) -> Option<serde_json::Value> {
    let read = |p: PathBuf| -> Option<serde_json::Value> {
        serde_json::from_slice(&std::fs::read(p).ok()?).ok()
    };
    let user = read(w.home().join(".config/unstale/config.json")).unwrap_or_default();
    let root = w.repo().canonicalize().ok()?;
    user.get("repositories")
        .and_then(|r| r.get(&*root.to_string_lossy()))
        .and_then(|r| r.get("inference"))
        .or_else(|| user.get("inference"))
        .cloned()
        .or_else(|| {
            read(w.repo().join(".unstale/config.json"))
                .and_then(|v| v.get("inference").cloned())
                .filter(|c| c["provider"] == "none")
        })
}

/// The agent whose session starts, by the variable it sets: its name and the hook file it installs.
pub(crate) fn agent_hook(s: &Scenario) -> (&'static str, &'static str) {
    if s.invocation.env.iter().any(|(k, _)| *k == "CODEX_SANDBOX") {
        ("Codex", ".codex/hooks.json")
    } else {
        ("Claude Code", ".claude/settings.local.json")
    }
}

/// The session-start command an agent's installed hook file runs, if one is installed.
pub(crate) fn hook_command(repo: &Path, file: &str) -> Option<String> {
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(repo.join(file)).ok()?).ok()?;
    v["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        .as_str()
        .map(String::from)
}

/// A session of the agent starts: the hook it installed runs as that agent runs it (a shell, in the repository, with
/// the agent's variables; Claude Code also sets `CLAUDE_PROJECT_DIR`), stdout and stderr read to their end, and the
/// background stage it starts runs to its end before the next step.
pub(crate) fn session_start(w: &World, s: &Scenario) -> Ran {
    let (agent, file) = agent_hook(s);
    let Some(command) = hook_command(&w.repo(), file) else {
        return Ran {
            step: Step::SessionStart,
            shown: String::new(),
            terminal: false,
            code: 0,
            output: String::new(),
            note: Some(format!(
                "{agent} starts a session: no session-start hook of its is installed here, so nothing runs"
            )),
            stderr: None,
            took: Duration::ZERO,
        };
    };
    let mut sh = Command::new("/bin/sh");
    sh.arg("-c")
        .arg(format!("{}{command}", reload_logger()))
        .current_dir(w.repo())
        .env_clear();
    for (k, v) in w.env(s) {
        sh.env(k, v);
    }
    if agent == "Claude Code" {
        sh.env("CLAUDE_PROJECT_DIR", w.repo());
    }
    let started = std::time::Instant::now();
    let (code, out, err) = support::run_within(&mut sh, Duration::from_secs(60));
    let took = started.elapsed();
    wait_for_background(w);
    Ran {
        step: Step::SessionStart,
        shown: w.normalise(&command),
        terminal: false,
        code,
        output: out,
        note: Some(format!(
            "{agent} starts a session and runs its session-start hook; the background stage it starts runs to its end"
        )),
        stderr: Some(err),
        took,
    }
}

/// Waits until no background stage of this scenario's repository is running. The hook starts it before it returns, so
/// a process list taken after the hook has returned shows it until it ends: no fixed sleep, whatever the machine's
/// load.
pub(crate) fn wait_for_background(w: &World) {
    let tag = w
        .base
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let until = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let ps = Command::new("ps")
            .args(["-A", "-ww", "-o", "command="])
            .output()
            .unwrap();
        let running = String::from_utf8_lossy(&ps.stdout)
            .lines()
            .any(|l| l.contains(&tag) && l.contains("session-sync"));
        if !running {
            return;
        }
        assert!(
            std::time::Instant::now() < until,
            "the background stage did not end within a minute"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// `unstale infer` on the chosen provider, as the fault steps and the slow provider's row run it: the internal command
/// whose call timeout a test can set.
pub(crate) fn infer(w: &World, s: &Scenario, base: &str, prompt: &str) -> Ran {
    let choice = chosen(w);
    let provider = choice
        .as_ref()
        .and_then(|c| c["provider"].as_str())
        .unwrap_or("openai")
        .to_string();
    let mut args: Vec<String> = vec![
        "infer".into(),
        "--timeout-secs".into(),
        "1".into(),
        "--backoff-ms".into(),
        "0".into(),
        "--provider".into(),
        provider.clone(),
    ];
    match provider.as_str() {
        "anthropic" => args.extend(["--base-url".into(), base.to_string()]),
        "codex" => {}
        _ => args.extend(["--base-url".into(), format!("{base}/v1")]),
    }
    if let Some(k) = choice.as_ref().and_then(|c| c["key_env"].as_str()) {
        args.extend(["--key-env".into(), k.into()]);
    }
    args.push(prompt.to_string());
    let mut r = exec(w, s, args, false);
    r.shown = format!("unstale infer --provider {provider}");
    r
}

/// The provider is slower than a call's timeout. The pipeline's own timeout (5 minutes) cannot be shortened from
/// outside, so the internal `unstale infer`, with a 1 s timeout, stands in for the pipeline's call.
pub(crate) fn slow_step(w: &World, s: &Scenario) -> Ran {
    let mut r = infer(
        w,
        s,
        &w.provider_host.url.clone(),
        &format!("Read this release note and answer {{\"ok\": true}}.\n\n{RELEASE_NOTE}"),
    );
    r.note = Some("one model call with a 1 s timeout (the internal `unstale infer`): the pipeline's own timeout is 5 minutes and cannot be shortened from outside".into());
    r
}

/// The deliberate violation a fault test injects after the session, as one more command.
pub(crate) fn inject(w: &World, s: &Scenario) -> Option<Ran> {
    let note = format!("{RELEASE_NOTE}\n");
    let r = match s.fault? {
        Fault::KeyInRequestBody => infer(
            w,
            s,
            &w.provider_host.url,
            &(note + &shell_value("OPENAI_API_KEY")),
        ),
        Fault::RepoCodeInRequestBody => infer(
            w,
            s,
            &w.provider_host.url,
            &(note + &std::fs::read_to_string(w.repo().join("src/middleware.ts")).unwrap()),
        ),
        Fault::ProviderOffMachine => infer(w, s, "https://provider.example.invalid", &note),
        Fault::ExtractsCoveredRelease => infer(
            w,
            s,
            &w.provider_host.url,
            &format!(
                "You extract change records from official release notes.\n\nTechnology: next\nRelease: 16.1.0 (2026-10-01)\n\n{note}"
            ),
        ),
        Fault::HomePathInRequestBody => infer(
            w,
            s,
            &w.provider_host.url,
            &format!("{note}{}", w.home().join(".config/unstale").display()),
        ),
        Fault::RepoFileInRequestBody => infer(
            w,
            s,
            &w.provider_host.url,
            &format!(
                "{note}package.json: {}",
                std::fs::read_to_string(w.repo().join("package.json")).unwrap()
            ),
        ),
        Fault::KeyPrefixPrinted => {
            let key = shell_value("OPENAI_API_KEY");
            Ran {
                step: Step::Injected,
                shown: "unstale status".into(),
                terminal: false,
                code: 0,
                output: format!("Release notes   OpenAI (key {}…)\n", &key[..12]),
                note: None,
                stderr: None,
                took: Duration::ZERO,
            }
        }
        Fault::CodexEnvNotCleared => {
            // `codex exec` started with the client's own environment, as a client that did not clear it would.
            let mut c = Command::new(w.base.path().join("bin/codex"));
            c.args(["exec", "--json", "--", "answer {}"])
                .current_dir(w.base.path())
                .env_clear();
            for (k, v) in w.env(s) {
                c.env(k, v);
            }
            let (code, out, err) = support::run_within(&mut c, Duration::from_secs(30));
            Ran {
                step: Step::Injected,
                shown: "codex exec --json".into(),
                terminal: false,
                code,
                output: out + &err,
                note: None,
                stderr: None,
                took: Duration::ZERO,
            }
        }
        Fault::RedirectFollowed => {
            // The redirect followed with the key, as a client that follows redirects would.
            let to = format!("{}/v1/chat/completions", w.redirect_target.url);
            let out = Command::new("/usr/bin/curl")
                .args(["-s", "--noproxy", "*", "-H"])
                .arg(format!(
                    "Authorization: Bearer {}",
                    shell_value("OPENAI_API_KEY")
                ))
                .args(["-d", "{}", &to])
                .output()
                .unwrap();
            Ran {
                step: Step::Injected,
                shown: "unstale session-sync".into(),
                terminal: false,
                code: 0,
                output: String::from_utf8_lossy(&out.stdout).to_string(),
                note: None,
                stderr: None,
                took: Duration::ZERO,
            }
        }
        Fault::ReadsUnplantedSecret => {
            // The real client, through the open logger, looking for files in a directory of secrets nobody planted
            // (`-C` points it there): every path it tries is recorded, though none exists.
            let dir = w.home().join(".config/gcloud");
            std::fs::create_dir_all(&dir).unwrap();
            exec(
                w,
                s,
                vec![
                    "-C".into(),
                    dir.display().to_string(),
                    "init".into(),
                    "--yes".into(),
                    "--wait".into(),
                    "0".into(),
                ],
                false,
            )
        }
        Fault::ElsewhereThroughProxy => {
            let out = Command::new("/usr/bin/curl")
                .args([
                    "-s",
                    "-m",
                    "5",
                    "-x",
                    &w.trap.url,
                    "https://telemetry.example/",
                ])
                .output()
                .unwrap();
            Ran {
                step: Step::Injected,
                shown: "unstale sync".into(),
                terminal: false,
                code: 0,
                output: String::from_utf8_lossy(&out.stdout).to_string(),
                note: None,
                stderr: None,
                took: Duration::ZERO,
            }
        }
        Fault::ErrorExit => {
            let mut r = exec(
                w,
                s,
                vec!["infer".into(), "--provider".into(), "custom".into()],
                false,
            );
            r.shown = "unstale infer --provider custom".into();
            r
        }
        _ => return None,
    };
    Some(Ran {
        step: Step::Injected,
        note: Some("injected by the harness: a deliberate violation".into()),
        ..r
    })
}

pub(crate) fn run_session(s: &Scenario) -> Session {
    let world = World::new(s);
    let mut ran: Vec<Ran> = vec![];
    let mut chosen_at_model = None;
    let mut added = vec![];
    // An earlier client set the repository up; then the catalog moves as it does at a release.
    if s.client.id != "fresh" {
        for args in [
            vec!["init", "--yes", "--wait", "0", "--no-animation"],
            vec!["sync"],
        ] {
            let mut r = exec(
                &world,
                s,
                args.iter().map(|a| a.to_string()).collect(),
                false,
            );
            r.step = Step::Injected;
            r.note = Some("earlier: set up by the client then installed (this build; the previous release's binary is not built here)".into());
            ran.push(r);
        }
        let root = if s.client.id == "upgraded" {
            json!({"schema": 1, "min_client": this_version(), "latest_client": this_version()})
        } else {
            json!({"schema": 1, "min_client": newer_version(), "latest_client": newer_version(),
                "notice": {"id": "matrix", "until": "2026-11-30", "text": NOTICE}})
        };
        world._catalog.root(&root.to_string());
        if s.client.id == "upgraded" {
            // The previous release, with the switch off by default, wrote neither.
            for rel in NEW_INTEGRATIONS {
                let _ = std::fs::remove_file(world.repo().join(rel));
            }
        }
        ran.push(Ran {
            step: Step::Injected,
            shown: String::new(),
            terminal: false,
            code: 0,
            output: String::new(),
            note: Some(if s.client.id == "upgraded" {
                "the user upgrades the client; the catalog now names this version the newest and the oldest it serves".into()
            } else {
                "the catalog raises its oldest served version (min_client) above this client's".into()
            }),
            stderr: None,
            took: Duration::ZERO,
        });
    }
    for &step in s.invocation.steps {
        if matches!(step, Step::SessionSync | Step::SessionStart) && chosen_at_model.is_none() {
            chosen_at_model = chosen(&world);
        }
        let had: Vec<bool> = NEW_INTEGRATIONS.iter().map(|rel| world.repo().join(rel).exists()).collect();
        let Some(mut r) = run_step(&world, s, step, &ran) else {
            continue;
        };
        if s.client.id == "upgraded" && !matches!(step, Step::Init | Step::InitYes | Step::InitFlag(_)) {
            for (rel, had) in NEW_INTEGRATIONS.iter().zip(had) {
                if !had && world.repo().join(rel).exists() {
                    added.push(format!("`{}` added {rel}", r.shown));
                }
            }
        }
        r.step = step;
        if s.fault == Some(Fault::CodexLoggedOutExits) && step == Step::SessionSync {
            r.code = 1;
        }
        if s.fault == Some(Fault::NoisyHook) && step == Step::SessionStart {
            r.output += "unstale: one line\nand another\n";
            r.stderr = Some("a hook error\n".into());
        }
        let answer = (step == Step::AgentSetup)
            .then(|| agent_answer(&world, s, &r))
            .flatten();
        ran.push(r);
        if let Some(mut a) = answer {
            a.step = Step::AgentSetup;
            ran.push(a);
        }
        if s.fault == Some(Fault::SecondQuestion) && step == Step::Init {
            let mut again = exec(&world, s, vec!["setup".into()], true);
            again.step = Step::Status;
            ran.push(again);
        }
        if s.fault == Some(Fault::NoticeTwice) && step == Step::Sync {
            let _ = std::fs::remove_file(world.repo().join(".unstale/state/notices.json"));
            let _ = std::fs::remove_file(world.repo().join(".unstale/notices.json"));
            for (p, _) in support::files_under(&world.repo().join(".unstale")) {
                if p.file_name()
                    .is_some_and(|n| n.to_string_lossy().contains("notice"))
                {
                    let _ = std::fs::remove_file(p);
                }
            }
        }
    }
    if let Some(r) = inject(&world, s) {
        ran.push(r);
    }
    if s.fault == Some(Fault::KeyWrittenToCache) {
        write(
            &world.cache().join("inference/leaked.json"),
            &shell_value("OPENAI_API_KEY"),
        );
    }
    Session {
        world,
        ran,
        chosen: chosen_at_model,
        added,
    }
}
