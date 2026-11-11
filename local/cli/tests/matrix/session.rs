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
}

pub(crate) struct Session {
    pub(crate) world: World,
    pub(crate) ran: Vec<Ran>,
    /// The provider the session chose, as recorded in the config, when the model step ran.
    pub(crate) chosen: Option<serde_json::Value>,
}

pub(crate) const PROMPTS: [&str; 2] = ["Choose 1–", "Press Enter to use it"];

pub(crate) fn questions(text: &str) -> usize {
    PROMPTS.iter().map(|p| text.matches(p).count()).sum()
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
        Step::InitYes => Some(exec(w, s, init(true), false)),
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
            if !status.output.contains("Model provider: not chosen") {
                return None;
            }
            let listed = exec(w, s, vec!["setup".into()], false);
            Some(listed)
        }
        Step::Model => model_step(w, s),
    }
}

/// The agent's follow-up to `unstale setup`: the user's answer, recorded with the flag printed beside it.
pub(crate) fn agent_answer(w: &World, s: &Scenario, listed: &Ran) -> Option<Ran> {
    let value = listed.output.lines().find_map(|l| {
        l.split_once("[--inference ")
            .map(|(_, v)| v.trim_end_matches(']').to_string())
    })?;
    let mut r = exec(
        w,
        s,
        vec!["setup".into(), "--inference".into(), value],
        false,
    );
    r.note = Some("the agent showed the options and asked; the user chose option 1".into());
    Some(r)
}

pub(crate) fn exec(w: &World, s: &Scenario, args: Vec<String>, terminal: bool) -> Ran {
    let cmd = w.command(s, &args);
    let (code, output) = if terminal {
        let answers: &[(&str, &str)] = &[(PROMPTS[0], "\n"), (PROMPTS[1], "\n")];
        // Only the first question is answered; a second would wait, and its prompt is counted.
        let (code, raw) = support::at_terminal(
            &cmd,
            &answers[..1.min(answers.len())],
            Duration::from_secs(60),
        );
        (code, support::screen(&raw))
    } else {
        // stderr into stdout, so the output keeps the order it was written in.
        let mut sh = Command::new("/bin/sh");
        sh.arg("-c")
            .arg("exec \"$0\" \"$@\" 2>&1")
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
    }
}

/// The provider the session ended up with: this repository's config, else the user's.
pub(crate) fn chosen(w: &World) -> Option<serde_json::Value> {
    let read = |p: PathBuf| -> Option<serde_json::Value> {
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(p).ok()?).ok()?;
        v.get("inference").cloned()
    };
    read(w.repo().join(".unstale/config.json"))
        .or_else(|| read(w.home().join(".config/unstale/config.json")))
}

pub(crate) fn model_step(w: &World, s: &Scenario) -> Option<Ran> {
    let choice = chosen(w);
    let provider = choice
        .as_ref()
        .and_then(|c| c["provider"].as_str())
        .unwrap_or("none")
        .to_string();
    let mut prompt =
        format!("Read this release note and answer {{\"ok\": true}}.\n\n{RELEASE_NOTE}");
    match s.fault {
        Some(Fault::KeyInRequestBody) => prompt += &format!("\n{}", shell_value("OPENAI_API_KEY")),
        Some(Fault::RepoCodeInRequestBody) => {
            prompt += &std::fs::read_to_string(w.repo().join("src/middleware.ts")).unwrap()
        }
        _ => {}
    }
    let mut args: Vec<String> = vec![
        "infer".into(),
        "--timeout-secs".into(),
        "1".into(),
        "--backoff-ms".into(),
        "0".into(),
    ];
    let base = if s.fault == Some(Fault::ProviderOffMachine) {
        "https://provider.example.invalid".to_string()
    } else {
        w.provider_host.url.clone()
    };
    match provider.as_str() {
        "openai" | "vercel" | "openrouter" => args.extend([
            "--provider".into(),
            provider.clone(),
            "--base-url".into(),
            format!("{base}/v1"),
        ]),
        "anthropic" => args.extend([
            "--provider".into(),
            provider.clone(),
            "--base-url".into(),
            base,
        ]),
        "codex" => args.extend(["--provider".into(), "codex".into()]),
        _ => {
            return Some(Ran {
                step: Step::Model,
                shown: String::new(),
                terminal: false,
                code: 0,
                output: String::new(),
                note: Some("no provider chosen, so no model step runs".into()),
            });
        }
    }
    if s.fault == Some(Fault::ErrorExit) {
        args = vec!["infer".into(), "--provider".into(), "custom".into()];
    }
    if let Some(k) = choice.as_ref().and_then(|c| c["key_env"].as_str()) {
        args.extend(["--key-env".into(), k.into()]);
    }
    args.push(prompt);
    let mut r = exec(w, s, args, false);
    r.step = Step::Model;
    r.shown = format!("unstale infer --provider {provider}");
    let mut note = "model step: the internal `unstale infer` on the chosen provider, standing in for the client's own pipeline steps".to_string();
    let var = choice
        .as_ref()
        .and_then(|c| c["key_env"].as_str())
        .unwrap_or("");
    if s.keys.repo_env.contains(&var) && !s.keys.shell.contains(&var) {
        note += &format!(
            "; {var} is only in this repo's .env, which `unstale infer` does not read (the pipeline steps read it once the user has chosen it)"
        );
    }
    r.note = Some(note);
    Some(r)
}

pub(crate) fn run_session(s: &Scenario) -> Session {
    let world = World::new(s);
    let mut ran: Vec<Ran> = vec![];
    let mut chosen_at_model = None;
    for &step in s.invocation.steps {
        if step == Step::Model {
            chosen_at_model = chosen(&world);
        }
        let Some(mut r) = run_step(&world, s, step, &ran) else {
            continue;
        };
        r.step = step;
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
    }
}
