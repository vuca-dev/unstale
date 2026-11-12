use super::*;
use std::cell::RefCell;
use std::path::PathBuf;

const CANARY: &str = "canary-sk-5e2b8c71d9a4";

/// A probe over a fixed environment (`NAME` set, `NAME=` blank) and Codex state that reads `.env` through
/// [`System`] and records every root it was asked about.
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
    fn set_in_shell(&self, name: &str) -> bool {
        self.names.iter().any(|n| n == name)
    }
    fn repo_dotenv(&self, root: &Path) -> Vec<String> {
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
    let names = dotenv_names(text.as_bytes());
    // ANTHROPIC_API_KEY is blank, so it is absent; OPENAI_API_KEY's last assignment is not.
    assert_eq!(names, ["OPENAI_API_KEY", "JEV_API_KEY"]);
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
    assert!(System.repo_dotenv(&repo).is_empty());
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
    let logged_out = CodexState::NotReady("Codex is not logged in. Run `codex login`.".into());
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
            "snap-and-openai",
            machine(
                &[("SUBQ_API_KEY", Shell), ("OPENAI_API_KEY", Shell)],
                CodexState::Absent,
            ),
            38,
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

/// The picker as a person or an agent sees it, with the prompt a person is left at.
fn rendered(d: &Detected, techs: usize, no_key: bool, reader: Reader, width: usize) -> String {
    let mut text = view::picker_lines(d, techs, no_key, reader, width).join("\n");
    if reader == Reader::Person {
        text += "\n";
        text += &match options(d, no_key).len() {
            0 => view::nothing_prompt(),
            n => view::prompt(n),
        };
    }
    format!("{text}\n")
}

#[test]
fn picker_renderings_match_their_goldens() {
    for (name, d, techs, no_key, reader) in scenarios() {
        golden(name, &rendered(&d, techs, no_key, reader, view::WIDTH));
    }
    // Narrower terminals: the key column goes first, then each option takes two lines.
    golden(
        "everything-80-columns",
        &rendered(&everything(), 38, false, Reader::Person, 80),
    );
    golden(
        "openai-only-60-columns",
        &rendered(
            &machine(&[("OPENAI_API_KEY", Seen::Shell)], CodexState::Absent),
            38,
            false,
            Reader::Person,
            60,
        ),
    );
    // The full figures, and what "set one up" shows.
    golden(
        "everything-details",
        &format!(
            "{}\n",
            view::details_lines(&everything(), 38, false).join("\n")
        ),
    );
    golden(
        "openai-only-details",
        &format!(
            "{}\n",
            view::details_lines(
                &machine(&[("OPENAI_API_KEY", Seen::Shell)], CodexState::Absent),
                38,
                false
            )
            .join("\n")
        ),
    );
    let logged_out = machine(
        &[("JEV_API_KEY", Seen::Shell)],
        CodexState::NotReady("Codex is not logged in. Run `codex login`.".into()),
    );
    golden(
        "set-one-up",
        &format!(
            "{}\n\n{}\n",
            view::set_up_lines(
                &machine(&[], CodexState::Absent),
                Reader::Person,
                view::WIDTH
            )
            .join("\n"),
            view::set_up_lines(&logged_out, Reader::Person, view::WIDTH).join("\n")
        ),
    );
    golden(
        "nothing-agent",
        &rendered(
            &machine(&[], CodexState::Absent),
            38,
            false,
            Reader::Agent,
            view::WIDTH,
        ),
    );
}

#[test]
fn the_prompt_with_nothing_usable_narrows_with_the_terminal() {
    let nothing = machine(
        &[],
        CodexState::NotReady("Codex is not logged in. Run `codex login`.".into()),
    );
    for width in [view::WIDTH, 60, 40] {
        let mut lines = view::nothing_lines(&nothing, Reader::Person, width);
        lines.extend(view::set_up_lines(&nothing, Reader::Person, width));
        for l in &lines {
            assert!(l.chars().count() <= width, "at {width}: {l}");
        }
    }
    golden(
        "nothing-40-columns",
        &format!(
            "{}\n",
            view::nothing_lines(&machine(&[], CodexState::Absent), Reader::Person, 40).join("\n")
        ),
    );
}

#[test]
fn nothing_setup_prints_is_much_wider_than_a_hundred_columns() {
    // Principle 12: a line that needs more than about 100 characters carries detail that belongs elsewhere.
    let mut lines = vec![
        view::pending_line(),
        view::unconfigured_line(),
        view::dismissed_line(),
        view::limit_reached_line(LimitOrigin::Repo),
        view::limit_reached_line(LimitOrigin::User),
    ];
    let pair = parse_flag("jev+env:AI_GATEWAY_API_KEY").unwrap();
    lines.extend(view::saved_lines(&pair, Origin::Repo, None));
    lines.extend(view::saved_lines(
        &Choice::codex(),
        Origin::User,
        Some(&pair),
    ));
    lines.push(view::kept_line(&pair));
    for origin in [Origin::Repo, Origin::User] {
        lines.push(view::provider_line(Some(&(pair.clone(), origin))));
        lines.push(view::provider_line(Some(&(Choice::none(), origin))));
    }
    lines.push(view::provider_line(None));
    lines.extend(view::missing_key_lines(
        Some(&(pair.clone(), Origin::Repo)),
        &|_| false,
    ));
    for (limit, origin) in [
        (Limit::Tokens(48_000_000), LimitOrigin::Default),
        (Limit::Tokens(1_000_000), LimitOrigin::Repo),
        (Limit::None, LimitOrigin::User),
    ] {
        lines.push(view::tokens_line(Ok(48_000_000), limit, origin));
    }
    for (name, d, techs, no_key, reader) in scenarios() {
        let _ = name;
        lines.extend(view::picker_lines(&d, techs, no_key, reader, view::WIDTH));
        lines.extend(view::details_lines(&d, techs, no_key));
    }
    for l in lines {
        assert!(
            l.chars().count() <= 100,
            "{} characters: {l}",
            l.chars().count()
        );
    }
}

#[test]
fn every_listing_fits_the_width_it_was_laid_out_for() {
    for (name, d, techs, no_key, reader) in scenarios() {
        for width in [view::WIDTH, 80, 60] {
            for l in view::table(&d, techs, no_key, width) {
                assert!(l.chars().count() <= width, "{name} at {width}: {l}");
                assert_eq!(l, l.trim_end(), "{name}: trailing blanks");
            }
        }
        // What is around the table, at the default width.
        for l in view::picker_lines(&d, techs, no_key, reader, view::WIDTH) {
            assert!(l.chars().count() <= 100, "{name}: {l}");
        }
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
    // Snap matches beside a key, ahead of the key alone; alone it writes no records.
    assert_eq!(
        options(
            &machine(
                &[
                    ("SUBQ_API_KEY", Seen::Shell),
                    ("OPENAI_API_KEY", Seen::Shell)
                ],
                CodexState::Absent
            ),
            false
        ),
        [
            Pick::SnapKey(Route::OpenAi),
            Pick::Key(Route::OpenAi),
            Pick::None
        ]
    );
    assert!(
        options(
            &machine(&[("SUBQ_API_KEY", Seen::Shell)], CodexState::Absent),
            false
        )
        .is_empty(),
        "Snap alone writes no records"
    );
    assert_eq!(
        options(&machine(&[], CodexState::Absent), true),
        [Pick::None],
        "no-key mode is the one option"
    );
}

#[test]
fn every_option_states_one_cost_and_its_trade_and_the_details_carry_units_and_scope() {
    let d = everything();
    let opts = options(&d, false);
    let table = view::table(&d, 38, false, view::WIDTH);
    assert_eq!(
        table.len(),
        opts.len() + 3,
        "a header, a row an option, what Jev is, and the keys they read"
    );
    // Jev is said once, in a few words, where it is offered; and not where it is not.
    assert_eq!(
        table[opts.len() + 1],
        "     Jev: a labelling service, used beside the provider that reads the notes."
    );
    assert_eq!(
        table[opts.len() + 2],
        "     Keys: JEV_API_KEY, AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY"
    );
    let no_jev = view::table(
        &machine(&[("OPENAI_API_KEY", Seen::Shell)], CodexState::Absent),
        38,
        false,
        view::WIDTH,
    );
    assert!(!no_jev.join("\n").contains("Jev"), "{no_jev:?}");
    let details = view::details_lines(&d, 38, false).join("\n");
    for (i, p) in opts.iter().enumerate() {
        let row = &table[i + 1];
        assert!(row.starts_with(&format!("  {}  ", i + 1)), "{row}");
        if *p == Pick::None {
            assert!(
                row.contains("free") && row.contains("≈ 27% of its changes in new releases"),
                "{row}"
            );
            continue;
        }
        // One cost, and one quality figure at most: no unit rate, first sync or second figure in the row.
        assert!(row.contains("≈ "), "{row}");
        assert!(row.matches('%').count() <= 1, "{row}");
        for detail in ["per package", "first sync", "listed twice", "at API prices"] {
            assert!(
                !row.contains(detail),
                "{detail:?} belongs in --details: {row}"
            );
        }
        // Below the best option, the row ends with exactly its one figure, the comparison in it.
        let want = match p {
            Pick::JevKey(_) => "the best option",
            Pick::JevCodex => "≈ 80% of its changes",
            Pick::Key(Route::Anthropic) => "≈ 90% of its changes",
            Pick::Key(_) | Pick::SnapKey(_) => "same finds, ≈ 3% more false alarms",
            Pick::Codex => "≈ 80% of its changes; rest not measured",
            Pick::None => unreachable!(),
        };
        assert_eq!(row.rsplit("   ").next(), Some(want), "{row}");
    }
    for want in [
        "per package, per year",
        "this repo, a year",
        "first sync, once",
        "at API prices",
        "more changes listed twice per package, per year",
        "fewer from upgrade guides",
    ] {
        assert!(
            details.contains(want),
            "{want:?} missing from the details:\n{details}"
        );
    }
    let everything_printed = format!("{}\n{details}", table.join("\n"));
    for internal in [
        "A+B",
        "H1",
        "H2",
        "step ",
        "slice",
        "duplicate records",
        "gpt-6",
        "flex",
        "technology-year",
        "deterministic",
        "deferred",
        "edge",
    ] {
        assert!(
            !everything_printed.contains(internal),
            "internal name {internal:?}"
        );
    }
}

#[test]
fn going_without_a_provider_states_what_is_left_with_the_measured_share() {
    // The figure is one constant; every place that states the trade reads it.
    assert_eq!(NO_PROVIDER_SHARE, Some(27));
    let nothing = machine(&[], CodexState::Absent);
    for reader in [Reader::Person, Reader::Agent] {
        let text = view::nothing_lines(&nothing, reader, view::WIDTH).join("\n");
        assert!(
            text.contains("advisories and deprecations only, ≈ 27% of the changes in new releases"),
            "{text}"
        );
    }
    assert!(view::dismissed_line().contains("advisories and deprecations only"));
}

#[test]
fn enter_accepts_the_first_option_a_number_picks_one_and_d_shows_the_details() {
    let opts = options(&everything(), false);
    let details = vec!["THE DETAILS".to_string()];
    let pick = |input: &str| {
        let mut out = vec![];
        let p = view::ask(
            opts.len(),
            &view::prompt(opts.len()),
            &details,
            &mut input.as_bytes(),
            &mut out,
        );
        let p = match p {
            view::Answered::Option(i) => Some(opts[i]),
            view::Answered::Nothing => None,
        };
        (p, String::from_utf8(out).unwrap())
    };
    assert_eq!(pick("\n").0, Some(Pick::JevKey(Route::Vercel)));
    assert_eq!(pick("4\n").0, Some(Pick::Codex));
    assert_eq!(
        pick("6\n").0,
        Some(Pick::None),
        "typing None's number chooses it"
    );
    let (p, out) = pick("9\nx\n2\n");
    assert_eq!(p, Some(Pick::JevCodex));
    assert_eq!(
        (
            out.matches("Enter for 1, a number to choose").count(),
            out.matches(view::CONTINUE).count()
        ),
        (1, 2),
        "the question is asked once and stays open, not asked again"
    );
    // `d` shows the details once and leaves the same question open, without printing it again.
    let (p, out) = pick("d\n3\n");
    assert_eq!(p, Some(Pick::Key(Route::Vercel)));
    assert_eq!(out.matches("THE DETAILS").count(), 1, "{out}");
    assert_eq!(
        out.matches("Enter for 1, a number to choose").count(),
        1,
        "{out}"
    );
    assert!(out.ends_with(view::CONTINUE), "{out}");
    // A second `d` is not a choice, and `d` counts as a try: the question never stays open without end.
    let (p, out) = pick("d\nd\nd\nd\n1\n");
    assert_eq!(p, None, "{out}");
    assert_eq!(out.matches("THE DETAILS").count(), 1, "{out}");
    assert_eq!(pick("").0, None, "end of input chooses nothing");
    assert_eq!(
        pick("x\nx\nx\n1\n").0,
        None,
        "three answers that are not choices choose nothing"
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
    let (main, labels, _) = c.providers().unwrap();
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
        matching: None,
    };
    // Only the route's own key variable is used: a repository's config cannot have another variable sent.
    assert!(
        team.providers().is_none(),
        "a variable that is not the route's key"
    );
    assert_eq!(team.foreign_key(), Some("TEAM_GATEWAY_KEY"));
    assert_eq!(
        serde_json::to_string(&Choice::of(&d, Pick::Codex)).unwrap(),
        r#"{"provider":"codex"}"#
    );
    assert!(Choice::none().providers().is_none());
    assert_eq!(
        view::saved_lines(&Choice::none(), Origin::Repo, None),
        ["Saved for this repo: release notes not read, so new releases get advisories and deprecations only."]
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
        ok("subq+env:OPENAI_API_KEY"),
        r#"{"provider":"openai","key_env":"OPENAI_API_KEY","matching":{"provider":"subq","key_env":"SUBQ_API_KEY"}}"#
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
        "env:SUBQ_API_KEY",
        "subq+codex",
        "subq+anthropic",
        "subq+subq",
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
fn status_names_the_provider_this_months_tokens_and_the_users_limit() {
    let set = |v: &str| v == "JEV_API_KEY";
    let default = Limit::Tokens(crate::inference::ledger::DEFAULT_MONTHLY_TOKENS);
    let block = |cur: Option<(Choice, Origin)>, used: u64, limit: Limit, origin: LimitOrigin| {
        let mut lines = view::missing_key_lines(cur.as_ref(), &set);
        lines.push(view::provider_line(cur.as_ref()));
        if cur.as_ref().is_some_and(|(c, _)| !c.is_none()) {
            lines.push(view::tokens_line(Ok(used), limit, origin));
        }
        lines.join("\n")
    };
    golden(
        "status",
        &format!(
            "{}\n\n{}\n\n{}\n\n{}\n\n{}\n",
            block(None, 0, default, LimitOrigin::Default),
            block(
                Some((parse_flag("jev+env:OPENAI_API_KEY").unwrap(), Origin::Repo)),
                1_234_567,
                default,
                LimitOrigin::Default
            ),
            block(
                Some((Choice::codex(), Origin::User)),
                1_234_567,
                Limit::None,
                LimitOrigin::User
            ),
            block(
                Some((Choice::none(), Origin::Repo)),
                0,
                Limit::Tokens(100_000_000),
                LimitOrigin::User
            ),
            block(
                Some((Choice::codex(), Origin::Repo)),
                5_000_000,
                Limit::Tokens(5_000_000),
                LimitOrigin::User
            ),
        ),
    );
    // A lower limit in this repo's config is said to be the repo's, with where to change it.
    assert_eq!(
        view::tokens_line(Ok(1_500), Limit::Tokens(1_000_000), LimitOrigin::Repo),
        "Tokens                1.5k of 1M this month (this repo's limit, set in .unstale/config.json)"
    );
    assert!(
        view::limit_reached_line(LimitOrigin::Repo).ends_with("See .unstale/config.json.")
            && view::limit_reached_line(LimitOrigin::User).ends_with("`unstale setup --limit`.")
    );
    // The token count unusable: the fix matches the cause.
    let file = Path::new("/c/inference/usage-2026-11.jsonl");
    let corrupt = std::io::Error::new(std::io::ErrorKind::InvalidData, "x");
    assert!(
        view::token_count_line(file, &corrupt)
            .ends_with("Delete /c/inference/usage-2026-11.jsonl (the count restarts)."),
    );
    let denied = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "x");
    assert!(
        view::token_count_line(file, &denied)
            .ends_with("Make /c/inference/usage-2026-11.jsonl writable."),
    );
    assert!(
        view::tokens_line(
            Err(std::io::Error::other("x")),
            default,
            LimitOrigin::Default
        )
        .contains("unknown"),
    );
}

#[test]
fn the_monthly_token_limit_is_a_number_none_or_the_default() {
    assert_eq!(parse_limit("48M"), Ok(Some(Limit::Tokens(48_000_000))));
    assert_eq!(parse_limit("1.5m"), Ok(Some(Limit::Tokens(1_500_000))));
    assert_eq!(parse_limit("500k"), Ok(Some(Limit::Tokens(500_000))));
    assert_eq!(
        parse_limit("12_000_000"),
        Ok(Some(Limit::Tokens(12_000_000)))
    );
    assert_eq!(parse_limit("0"), Ok(Some(Limit::Tokens(0))));
    assert_eq!(parse_limit("none"), Ok(Some(Limit::None)));
    assert_eq!(parse_limit("default"), Ok(None));
    for bad in [
        "", "lots", "-5", "5x", "nan", "inf", "1e30", "1e3", ".", "1.2.3", "k",
    ] {
        assert!(parse_limit(bad).is_err(), "{bad:?}");
    }
    // An absurd count is refused in one plain line, never stored as the largest number.
    assert_eq!(
        parse_limit("99999999999999999999"),
        Err(
            "--limit 99999999999999999999: more than 1000000M tokens; use `none` for no limit"
                .into()
        )
    );
    assert_eq!(parse_limit("1000000M"), Ok(Some(Limit::Tokens(MAX_LIMIT))));
    // What is printed is what was typed: 1.5k is not shown as 1k.
    assert_eq!(parse_limit("1.5k"), Ok(Some(Limit::Tokens(1_500))));
    use crate::inference::ledger::short_tokens;
    assert_eq!(
        [850, 1_500, 12_000, 12_345, 999_999, 1_234_567, 48_000_000].map(short_tokens),
        ["850", "1.5k", "12k", "12.3k", "999k", "1.2M", "48M"]
    );
    // Stored as a number, or "none"; anything else is refused rather than read as no limit.
    assert_eq!(serde_json::to_string(&Limit::Tokens(5)).unwrap(), "5");
    assert_eq!(serde_json::to_string(&Limit::None).unwrap(), "\"none\"");
    assert_eq!(
        serde_json::from_str::<Limit>("\"none\"").unwrap(),
        Limit::None
    );
    assert!(serde_json::from_str::<Limit>("\"unlimited\"").is_err());
    assert!(serde_json::from_str::<Limit>("-1").is_err());
    assert_eq!(Limit::None.tokens(), u64::MAX);

    // The user's own limit (the default when they set none) is the most this machine spends: a repository's config
    // can lower it, never raise or remove it.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("unstale/config.json");
    let default = Limit::Tokens(crate::inference::ledger::DEFAULT_MONTHLY_TOKENS);
    assert_eq!(limit(None, &path), (default, LimitOrigin::Default));
    assert_eq!(
        limit(Some(Limit::None), &path),
        (default, LimitOrigin::Default),
        "a repo cannot remove the default"
    );
    assert_eq!(
        limit(Some(Limit::Tokens(u64::MAX - 1)), &path),
        (default, LimitOrigin::Default)
    );
    assert_eq!(
        limit(Some(Limit::Tokens(7)), &path),
        (Limit::Tokens(7), LimitOrigin::Repo)
    );
    write_user(&path, &Choice::codex()).unwrap();
    write_user_key(
        &path,
        "monthly_token_limit",
        Some(serde_json::json!(1_000_000)),
    )
    .unwrap();
    let own = (Limit::Tokens(1_000_000), LimitOrigin::User);
    assert_eq!(limit(None, &path), own);
    assert_eq!(
        limit(Some(Limit::None), &path),
        own,
        "a repo cannot remove the user's limit"
    );
    assert_eq!(
        limit(Some(Limit::Tokens(2_000_000)), &path),
        own,
        "nor raise it"
    );
    assert_eq!(
        limit(Some(Limit::Tokens(500_000)), &path),
        (Limit::Tokens(500_000), LimitOrigin::Repo)
    );
    assert_eq!(
        read_user(&path),
        Some(Choice::codex()),
        "the choice beside it is kept"
    );
    write_user_key(
        &path,
        "monthly_token_limit",
        Some(serde_json::json!("none")),
    )
    .unwrap();
    assert_eq!(limit(None, &path), (Limit::None, LimitOrigin::User));
    assert_eq!(
        limit(Some(Limit::Tokens(7)), &path),
        (Limit::Tokens(7), LimitOrigin::Repo)
    );
    write_user_key(&path, "monthly_token_limit", None).unwrap();
    assert_eq!(limit(None, &path), (default, LimitOrigin::Default));
    // The line after `--limit` says what applies here, not only what was saved.
    assert_eq!(
        view::limit_saved_line(None, Limit::Tokens(1_000_000), LimitOrigin::Repo),
        "Your monthly token limit: the default, 48M. Here this repo's lower limit applies: 1M (.unstale/config.json)."
    );
    assert_eq!(
        view::limit_saved_line(Some(Limit::None), Limit::None, LimitOrigin::User),
        "Your monthly token limit: none."
    );

    // A limit that cannot be read counts as not set (the default applies); it is never an error, and never no limit.
    #[derive(serde::Deserialize)]
    struct Doc {
        #[serde(default, deserialize_with = "lenient_limit")]
        monthly_token_limit: Option<Limit>,
    }
    let read = |text: &str| {
        serde_json::from_str::<Doc>(text)
            .unwrap()
            .monthly_token_limit
    };
    assert_eq!(read(r#"{"monthly_token_limit": "lots"}"#), None);
    assert_eq!(read(r#"{"monthly_token_limit": -3}"#), None);
    assert_eq!(
        read(r#"{"monthly_token_limit": "none"}"#),
        Some(Limit::None)
    );
    assert_eq!(
        read(r#"{"monthly_token_limit": 9}"#),
        Some(Limit::Tokens(9))
    );
    assert_eq!(read("{}"), None);
}

#[test]
fn a_user_config_that_cannot_be_read_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    std::fs::write(&path, "{\"other\": 1,}").unwrap();
    let e = write_user(&path, &Choice::codex()).unwrap_err().to_string();
    assert!(e.contains("is not a JSON object"), "{e}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"other\": 1,}");
}

#[test]
fn a_blank_value_counts_as_unset_in_either_source() {
    let blanks = "OPENAI_API_KEY=\nAI_GATEWAY_API_KEY=   \nexport OPENROUTER_API_KEY=\"\"\nANTHROPIC_API_KEY=' '\nJEV_API_KEY= # later\n";
    assert!(
        dotenv_names(blanks.as_bytes()).is_empty(),
        "{:?}",
        dotenv_names(blanks.as_bytes())
    );
    assert_eq!(
        dotenv_names("OPENAI_API_KEY=x\nOPENAI_API_KEY=\n".as_bytes()),
        Vec::<String>::new(),
        "the last assignment wins"
    );
    assert_eq!(
        dotenv_names("OPENAI_API_KEY=x\nOPENAI_API_KEY= # note\n".as_bytes()),
        Vec::<String>::new(),
        "a blank assignment with a comment clears an earlier value"
    );
    assert_eq!(
        dotenv_names(
            "OPENAI_API_KEY=\"#new\"\nJEV_API_KEY='#x' # note\nANTHROPIC_API_KEY=\"'\"\n"
                .as_bytes()
        ),
        ["OPENAI_API_KEY", "JEV_API_KEY", "ANTHROPIC_API_KEY"],
        "a # inside quotes, or the other quote, is part of the value"
    );
    assert_eq!(
        dotenv_names("OPENAI_API_KEY=sk-1 # note".as_bytes()),
        ["OPENAI_API_KEY"],
        "no final newline"
    );
    // The shell: the real environment, read through System.
    let base = tempfile::tempdir().unwrap();
    // SAFETY: test-only variables no other test reads.
    unsafe {
        std::env::set_var("UNSTALE_TEST_BLANK_KEY", "  ");
        std::env::set_var("UNSTALE_TEST_SET_KEY", "x");
    }
    assert!(!System.set_in_shell("UNSTALE_TEST_BLANK_KEY"));
    assert!(System.set_in_shell("UNSTALE_TEST_SET_KEY"));
    assert!(!System.set_in_shell("UNSTALE_TEST_UNSET_KEY"));
    std::fs::write(base.path().join(".env"), "OPENAI_API_KEY=\n").unwrap();
    let d = detect(base.path(), &Recording::new(&[], CodexState::Absent));
    assert!(d.keys.is_empty() && options(&d, false).is_empty(), "{d:?}");
}

#[test]
fn an_agent_variable_means_an_agent_is_driving() {
    assert!(agent_driving(&Recording::new(
        &["CLAUDECODE"],
        CodexState::Absent
    )));
    assert!(agent_driving(&Recording::new(
        &["UNSTALE_AGENT"],
        CodexState::Absent
    )));
    assert!(!agent_driving(&Recording::new(
        &["PATH", "HOME"],
        CodexState::Absent
    )));
}

#[test]
fn through_codex_only_what_was_measured_is_claimed() {
    let d = everything();
    let table = view::table(&d, 38, false, view::WIDTH);
    let details = view::details_lines(&d, 38, false);
    for (i, p) in options(&d, false).iter().enumerate() {
        let q = quote(*p, false);
        // Labels and matching are unmeasured only where Codex runs them; extraction through Codex is measured.
        assert_eq!(!q.labels_and_matching_measured, *p == Pick::Codex, "{p:?}");
        assert_eq!(q.codex_tokens_estimated > 0, *p == Pick::Codex, "{p:?}");
        if !matches!(p, Pick::JevCodex | Pick::Codex) {
            continue;
        }
        let row = &table[i + 1];
        assert!(!row.contains("the same"), "{row}");
        let at = details
            .iter()
            .position(|l| l.starts_with(&format!("{}  ", i + 1)))
            .unwrap();
        let block: Vec<&String> = details[at + 1..]
            .iter()
            .take_while(|l| !l.is_empty())
            .collect();
        assert!(
            block
                .iter()
                .any(|l| l.ends_with("≈ 80% of the best option's changes")),
            "{block:?}"
        );
        let says = |text: &str| block.iter().any(|l| l.ends_with(text));
        if *p == Pick::JevCodex {
            assert!(row.ends_with("   ≈ 80% of its changes"), "{row}");
            assert!(!block.iter().any(|l| l.contains("estimate")), "{block:?}");
            continue;
        }
        // Codex alone: the row says the rest is not measured; the details claim no figure for it, and set the
        // estimated tokens apart from the measured ones.
        assert!(
            row.ends_with("   ≈ 80% of its changes; rest not measured"),
            "{row}"
        );
        assert!(
            says("breaking-change flags and repeats through Codex: not measured yet")
                && says("170k measured, for reading the notes; 480k for the rest, an estimate")
                && !block
                    .iter()
                    .any(|l| l.contains("listed twice") || l.contains(" wrong")),
            "{block:?}"
        );
    }
}

#[test]
fn the_packages_unstale_follows_are_the_direct_dependencies_a_user_counts() {
    // Two direct dependencies, one scoped: looked up in the catalog under three names, but two packages.
    let repo = tempfile::tempdir().unwrap();
    std::fs::write(
        repo.path().join("package.json"),
        r#"{"name":"app","private":true,"dependencies":{"@tanstack/react-query":"5.0.0","zod":"3.0.0"}}"#,
    )
    .unwrap();
    let st = crate::stack::detect(repo.path()).unwrap();
    assert_eq!(st.candidates().len(), 3);
    assert_eq!(followed(&st), 2);
    let lines = view::details_lines(&machine(&[], CodexState::Absent), followed(&st), false);
    assert!(lines.contains(&"This repo has 2 packages unstale follows.".to_string()), "{lines:?}");
}
