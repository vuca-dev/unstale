use super::*;
use std::cell::RefCell;
use std::path::PathBuf;

const CANARY: &str = "canary-sk-5e2b8c71d9a4";

/// A probe over a fixed environment and Codex state that reads `.env` through [`System`] and records every root it
/// was asked about.
struct Recording {
    names: Vec<String>,
    codex: CodexState,
    roots: RefCell<Vec<PathBuf>>,
}

impl Recording {
    fn new(names: &[&str], codex: CodexState) -> Recording {
        Recording {
            names: names.iter().map(|s| s.to_string()).collect(),
            codex,
            roots: RefCell::new(vec![]),
        }
    }
}

impl Probe for Recording {
    fn env_names(&self) -> Vec<String> {
        self.names.clone()
    }
    fn repo_dotenv(&self, root: &Path) -> Option<String> {
        self.roots.borrow_mut().push(root.to_path_buf());
        System.repo_dotenv(root)
    }
    fn codex(&self) -> CodexState {
        self.codex.clone()
    }
}

#[test]
fn dotenv_names_keeps_known_names_and_never_a_value() {
    let text = format!(
        "# OPENAI_API_KEY=commented\nexport OPENAI_API_KEY={CANARY}\nJEV_API_KEY = \"{CANARY}\"\nDATABASE_URL={CANARY}\nnot a line\nANTHROPIC_API_KEY=\nOPENAI_API_KEY=again\n"
    );
    let names = dotenv_names(&text);
    assert_eq!(
        names,
        ["OPENAI_API_KEY", "JEV_API_KEY", "ANTHROPIC_API_KEY"]
    );
    assert!(!format!("{names:?}").contains(CANARY));
}

#[test]
fn detection_reads_names_from_the_shell_and_this_repos_env_only() {
    let base = tempfile::tempdir().unwrap();
    let repo = base.path().join("repo");
    let other = base.path().join("other");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(repo.join(".env"), format!("OPENAI_API_KEY={CANARY}-repo\n")).unwrap();
    std::fs::write(
        other.join(".env"),
        format!("ANTHROPIC_API_KEY={CANARY}-other\n"),
    )
    .unwrap();
    let p = Recording::new(&["PATH", "JEV_API_KEY", "HOME"], CodexState::Ready);
    let d = detect(&repo, &p);
    assert_eq!(
        *p.roots.borrow(),
        vec![repo.clone()],
        "only this repository's .env is asked for"
    );
    assert_eq!(d.keys.get("JEV_API_KEY"), Some(&Seen::Shell));
    assert_eq!(d.keys.get("OPENAI_API_KEY"), Some(&Seen::DotEnv));
    assert!(
        !d.keys.contains_key("ANTHROPIC_API_KEY"),
        "another repository's .env is never read"
    );
    assert!(!format!("{d:?}").contains(CANARY), "{d:?}");
}

#[cfg(unix)]
#[test]
fn a_dotenv_that_links_elsewhere_is_not_followed() {
    let base = tempfile::tempdir().unwrap();
    let repo = base.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::write(
        base.path().join("elsewhere.env"),
        format!("OPENAI_API_KEY={CANARY}\n"),
    )
    .unwrap();
    std::os::unix::fs::symlink(base.path().join("elsewhere.env"), repo.join(".env")).unwrap();
    assert_eq!(System.repo_dotenv(&repo), None);
    let d = detect(&repo, &Recording::new(&[], CodexState::Absent));
    assert!(d.keys.is_empty(), "{d:?}");
}

#[test]
fn several_compatible_keys_offer_the_cheapest_route() {
    let base = tempfile::tempdir().unwrap();
    let d = detect(
        base.path(),
        &Recording::new(
            &["OPENROUTER_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY"],
            CodexState::Absent,
        ),
    );
    assert_eq!(d.compatible(), Some(Route::Vercel));
    let d = detect(
        base.path(),
        &Recording::new(
            &["OPENROUTER_API_KEY", "OPENAI_API_KEY"],
            CodexState::Absent,
        ),
    );
    assert_eq!(d.compatible(), Some(Route::OpenAi));
}

// ---------------------------------------------------------------------------------------------------- picker goldens

fn machine(keys: &[(&str, Seen)], codex: CodexState) -> Detected {
    Detected {
        keys: keys.iter().map(|(k, s)| (k.to_string(), *s)).collect(),
        codex,
    }
}

fn everything() -> Detected {
    machine(
        &[
            ("AI_GATEWAY_API_KEY", Seen::Shell),
            ("OPENAI_API_KEY", Seen::Shell),
            ("OPENROUTER_API_KEY", Seen::Shell),
            ("ANTHROPIC_API_KEY", Seen::Shell),
            ("JEV_API_KEY", Seen::Shell),
        ],
        CodexState::Ready,
    )
}

/// The scenarios a later harness replays: name → (machine, technologies, no-key mode, reader).
pub(super) fn scenarios() -> Vec<(&'static str, Detected, usize, bool, Reader)> {
    use Seen::*;
    let logged_out = CodexState::NotReady("Codex is not logged in; run `codex login`".into());
    vec![
        ("everything", everything(), 38, false, Reader::Person),
        ("everything-agent", everything(), 38, false, Reader::Agent),
        (
            "codex-only",
            machine(&[], CodexState::Ready),
            38,
            false,
            Reader::Person,
        ),
        (
            "anthropic-only",
            machine(&[("ANTHROPIC_API_KEY", Shell)], CodexState::Absent),
            38,
            false,
            Reader::Person,
        ),
        (
            "nothing",
            machine(&[], CodexState::Absent),
            38,
            false,
            Reader::Person,
        ),
        (
            "nothing-codex-logged-out",
            machine(&[], logged_out),
            38,
            false,
            Reader::Person,
        ),
        (
            "jev-only",
            machine(&[("JEV_API_KEY", Shell)], CodexState::Absent),
            38,
            false,
            Reader::Person,
        ),
        (
            "openai-only",
            machine(&[("OPENAI_API_KEY", Shell)], CodexState::Absent),
            38,
            false,
            Reader::Person,
        ),
        (
            "jev-and-openai-in-dotenv",
            machine(
                &[("JEV_API_KEY", DotEnv), ("OPENAI_API_KEY", DotEnv)],
                CodexState::Absent,
            ),
            12,
            false,
            Reader::Person,
        ),
        (
            "openrouter-and-codex",
            machine(&[("OPENROUTER_API_KEY", Shell)], CodexState::Ready),
            1,
            false,
            Reader::Person,
        ),
        (
            "everything-no-repo-yet",
            everything(),
            0,
            false,
            Reader::Person,
        ),
        (
            "nothing-no-key-mode",
            machine(&[], CodexState::Absent),
            38,
            true,
            Reader::Person,
        ),
    ]
}

fn golden(name: &str, text: &str) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/setup/golden")
        .join(format!("{name}.txt"));
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("{} is missing; UPDATE_GOLDEN=1 writes it", path.display()));
    assert_eq!(
        text,
        want,
        "{name}: the rendering changed; review it, then UPDATE_GOLDEN=1 rewrites {}",
        path.display()
    );
}

#[test]
fn picker_renderings_match_their_goldens() {
    for (name, d, techs, no_key, reader) in scenarios() {
        let mut text = picker_lines(&d, techs, no_key, reader).join("\n");
        let n = options(&d, no_key).len();
        if reader == Reader::Person && n > 0 {
            text += &format!("\n{}", prompt(n));
        }
        golden(name, &format!("{text}\n"));
    }
}

#[test]
fn options_follow_the_fixed_order_and_list_only_what_this_machine_can_use() {
    let all = options(&everything(), false);
    assert_eq!(
        all,
        [
            Pick::JevKey(Route::Vercel),
            Pick::JevCodex,
            Pick::Key(Route::Vercel),
            Pick::Codex,
            Pick::Key(Route::Anthropic),
            Pick::None
        ]
    );
    assert_eq!(
        options(&machine(&[], CodexState::Ready), false),
        [Pick::Codex, Pick::None]
    );
    assert!(
        options(
            &machine(&[("JEV_API_KEY", Seen::Shell)], CodexState::Absent),
            false
        )
        .is_empty(),
        "Jev alone writes no records"
    );
    assert!(options(&machine(&[], CodexState::NotReady("x".into())), false).is_empty());
    assert_eq!(
        options(&machine(&[], CodexState::Absent), true),
        [Pick::None],
        "no-key mode is the one option"
    );
}

#[test]
fn every_option_below_the_first_states_its_trade_with_units_and_scope() {
    let d = everything();
    let opts = options(&d, false);
    for (i, p) in opts.iter().enumerate() {
        let l = option_line(&d, *p, 38, false);
        if *p == Pick::None {
            assert!(l.contains("need a key or Codex"), "{l}");
            continue;
        }
        assert!(
            l.contains(" per technology-year")
                && l.contains("this repo ≈ ")
                && l.contains("first sync ≈ "),
            "{l}"
        );
        if l.contains("Codex tokens") {
            assert!(l.contains("at API prices"), "{l}");
        }
        if i > 0 {
            assert!(
                l.contains("about the same") || l.contains("less complete: ≈ "),
                "{l}"
            );
        }
        for internal in ["A+B", "H1", "H2", "step ", "slice", "gpt-6", "flex"] {
            assert!(!l.contains(internal), "internal name {internal:?} in {l}");
        }
    }
}

#[test]
fn enter_accepts_the_first_option_and_a_number_picks_one() {
    let opts = options(&everything(), false);
    let pick = |input: &str| {
        let mut out = vec![];
        let p = ask(&opts, &mut input.as_bytes(), &mut out);
        (p, String::from_utf8(out).unwrap())
    };
    assert_eq!(pick("\n").0, Pick::JevKey(Route::Vercel));
    assert_eq!(pick("4\n").0, Pick::Codex);
    let (p, out) = pick("9\nx\n2\n");
    assert_eq!(p, Pick::JevCodex);
    assert_eq!(
        out.matches("Choose 1–6").count(),
        3,
        "the same question again, not a new one"
    );
    assert_eq!(pick("").0, Pick::None, "end of input uses nothing");
    assert_eq!(
        pick("x\nx\nx\n1\n").0,
        Pick::None,
        "three answers that are not choices use nothing"
    );
}

// ------------------------------------------------------------------------------------------------------------ config

#[test]
fn a_choice_stores_the_variable_name_and_maps_to_provider_configs() {
    let d = machine(
        &[
            ("JEV_API_KEY", Seen::Shell),
            ("OPENAI_API_KEY", Seen::DotEnv),
        ],
        CodexState::Absent,
    );
    let c = Choice::of(&d, Pick::JevKey(Route::OpenAi));
    let json = serde_json::to_string(&c).unwrap();
    assert_eq!(
        json,
        r#"{"provider":"openai","key_env":"OPENAI_API_KEY","labels":{"provider":"jev","key_env":"JEV_API_KEY"}}"#
    );
    assert_eq!(serde_json::from_str::<Choice>(&json).unwrap(), c);
    let (main, labels) = c.providers().unwrap();
    assert_eq!(
        (main.name.as_str(), main.key_env.as_deref()),
        ("openai", Some("OPENAI_API_KEY"))
    );
    assert_eq!(labels.map(|j| j.name), Some("jev".into()));
    assert_eq!(
        c.describe(),
        "Jev labelling API + OpenAI (JEV_API_KEY, OPENAI_API_KEY)"
    );

    let team = Choice {
        provider: "vercel".into(),
        key_env: Some("TEAM_GATEWAY_KEY".into()),
        labels: None,
    };
    assert_eq!(
        team.providers().unwrap().0.key_env.as_deref(),
        Some("TEAM_GATEWAY_KEY"),
        "a team's own variable name"
    );
    assert_eq!(
        serde_json::to_string(&Choice::of(&d, Pick::Codex)).unwrap(),
        r#"{"provider":"codex"}"#
    );
    assert!(Choice::none().providers().is_none());
    assert_eq!(
        Choice::none().describe(),
        "none (deterministic signals only)"
    );
}

#[test]
fn the_repo_choice_wins_over_the_users_and_the_user_config_keeps_its_other_keys() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("unstale/config.json");
    assert_eq!(current(None, &path), None);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, r#"{"other": 1}"#).unwrap();
    let mine = Choice::codex();
    write_user(&path, &mine).unwrap();
    let doc: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(doc["other"], 1);
    assert_eq!(current(None, &path), Some((mine, Origin::User)));
    let team = Choice::key(Route::Vercel, "AI_GATEWAY_API_KEY");
    assert_eq!(current(Some(&team), &path), Some((team, Origin::Repo)));
}

// -------------------------------------------------------------------------------------------------------------- flow

#[test]
fn the_inference_flag_reads_a_provider_a_variable_codex_or_none() {
    let ok = |s: &str| serde_json::to_string(&parse_flag(s).unwrap()).unwrap();
    assert_eq!(
        ok("openai"),
        r#"{"provider":"openai","key_env":"OPENAI_API_KEY"}"#
    );
    assert_eq!(
        ok("env:AI_GATEWAY_API_KEY"),
        r#"{"provider":"vercel","key_env":"AI_GATEWAY_API_KEY"}"#
    );
    assert_eq!(
        ok("anthropic"),
        r#"{"provider":"anthropic","key_env":"ANTHROPIC_API_KEY"}"#
    );
    assert_eq!(ok("codex"), r#"{"provider":"codex"}"#);
    assert_eq!(ok("none"), r#"{"provider":"none"}"#);
    assert_eq!(
        ok("jev+env:OPENAI_API_KEY"),
        r#"{"provider":"openai","key_env":"OPENAI_API_KEY","labels":{"provider":"jev","key_env":"JEV_API_KEY"}}"#
    );
    assert_eq!(
        ok("jev+codex"),
        r#"{"provider":"codex","labels":{"provider":"jev","key_env":"JEV_API_KEY"}}"#
    );
    for bad in [
        "jev",
        "env:JEV_API_KEY",
        "jev+anthropic",
        "jev+none",
        "openai+codex",
        "env:MY_KEY",
        "gpt",
        "",
        "jev+jev",
    ] {
        let e = parse_flag(bad).unwrap_err();
        assert!(e.contains("expected a provider"), "{bad}: {e}");
    }
    // Every option's flag value reads back as the same choice.
    let d = everything();
    for p in options(&d, false) {
        assert_eq!(
            parse_flag(&flag_value(&d, p)).unwrap(),
            Choice::of(&d, p),
            "{p:?}"
        );
    }
}

#[test]
fn a_question_is_asked_only_at_a_terminal_and_only_once_unprompted() {
    let c = Choice::codex();
    // A flag records without asking, anywhere.
    for (configured, terminal, reopen) in [
        (false, false, false),
        (true, true, true),
        (false, true, false),
    ] {
        assert_eq!(
            plan(Some(c.clone()), configured, terminal, reopen),
            Plan::Save(c.clone())
        );
    }
    // init: asks once, at a terminal, only while nothing is chosen.
    assert_eq!(plan(None, false, true, false), Plan::Ask);
    assert_eq!(
        plan(None, true, true, false),
        Plan::Nothing,
        "never asked again unprompted"
    );
    assert_eq!(
        plan(None, false, false, false),
        Plan::Nothing,
        "no terminal: no prompt"
    );
    // `unstale setup` reopens the picker; without a terminal it prints the options instead of waiting.
    assert_eq!(plan(None, true, true, true), Plan::Ask);
    assert_eq!(plan(None, true, false, true), Plan::Print);
    assert_eq!(plan(None, false, false, true), Plan::Print);
}

// ------------------------------------------------------------------------------------------------------------ status

#[test]
fn status_names_the_provider_this_months_tokens_and_the_budget() {
    let set = |v: &str| v == "JEV_API_KEY";
    let budget = crate::inference::ledger::budget_line(1_234_567, 48_000_000);
    let lines =
        |cur: Option<(Choice, Origin)>| format!("{}\n{budget}", provider_line(cur.as_ref(), &set));
    golden(
        "status",
        &format!(
            "{}\n{}\n{}\n{}\n",
            lines(None),
            lines(Some((
                parse_flag("jev+env:OPENAI_API_KEY").unwrap(),
                Origin::Repo
            ))),
            lines(Some((Choice::codex(), Origin::User))),
            lines(Some((Choice::none(), Origin::Repo))),
        ),
    );
}
