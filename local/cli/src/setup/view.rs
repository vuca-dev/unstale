//! What setup prints: the picker as a table, the prompt with nothing usable, the same for an agent to relay, the full
//! figures (`unstale setup --details`), and the lines of `unstale status`. Wording and layout only; every figure comes
//! from [`quote`], and what is offered from [`options`].
//!
//! The rules (docs/edge-inference/terminal-principles.md): a line is there because the reader does something with it;
//! a choice looks like a choice (question, blank line, aligned options, blank line, one short prompt); one cost and at
//! most one quality figure per option, the rest behind `--details`; nothing is accepted without its trade stated.

use super::*;

/// The width a listing is laid out for when nothing says how wide the reader's terminal is.
pub const WIDTH: usize = 100;

/// The terminal's width at a terminal, [`WIDTH`] anywhere else (a pipe, an agent, CI).
pub fn width() -> usize {
    use std::io::IsTerminal;
    if !std::io::stdout().is_terminal() {
        return WIDTH;
    }
    std::process::Command::new("stty")
        .arg("size")
        .stdin(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .nth(1)
                .and_then(|c| c.parse::<usize>().ok())
        })
        .filter(|c| *c >= 20)
        .unwrap_or(WIDTH)
}

// --------------------------------------------------------------------------------------------------------- figures

/// `$0.028`, `$1.05`, `$12`.
fn usd(x: f64) -> String {
    if x < 0.1 {
        format!("${x:.3}")
    } else if x < 10.0 {
        format!("${x:.2}")
    } else {
        format!("${x:.0}")
    }
}

/// Tokens to two significant figures: `110k`, `590k`, `4.2M`, `22M`.
fn tokens(n: f64) -> String {
    let n = n.max(0.0);
    let mag = if n >= 1.0 {
        10f64.powi(n.log10().floor() as i32 - 1)
    } else {
        1.0
    };
    let r = (n / mag).round() * mag;
    if r >= 1e6 {
        let m = r / 1e6;
        if m >= 10.0 {
            format!("{m:.0}M")
        } else {
            format!("{m:.1}M")
        }
    } else if r >= 1e3 {
        format!("{:.0}k", r / 1e3)
    } else {
        format!("{r:.0}")
    }
}

/// A cost: dollars, Codex tokens, agent tokens, or a sum of them. Empty when the option costs nothing.
fn cost(q: &Quote, years: f64) -> String {
    let mut parts = vec![];
    if q.usd > 0.0 {
        parts.push(usd(q.usd * years));
    }
    if q.codex_tokens > 0 {
        parts.push(format!(
            "{} Codex tokens",
            tokens(q.codex_tokens as f64 * years)
        ));
    }
    if q.agent_tokens > 0 {
        parts.push(format!(
            "{} more agent tokens",
            tokens(q.agent_tokens as f64 * years)
        ));
    }
    parts.join(" + ")
}

/// What is left without a provider, in the reader's words.
pub const WITHOUT: &str = "advisories and deprecations only";

/// `≈ 27% of what unstale finds with one`, when the share is measured.
fn without_share() -> Option<String> {
    NO_PROVIDER_SHARE.map(|n| format!("≈ {n}% of what unstale finds with one"))
}

// ----------------------------------------------------------------------------------------------------------- cells

/// The option's short name: `Jev + OpenAI`, `Codex plan`, `Not now`.
fn name(p: Pick, no_key: bool) -> String {
    match p {
        Pick::JevKey(r) => format!("Jev + {}", route_name(r)),
        Pick::JevCodex => "Jev + Codex plan".into(),
        Pick::Key(r) => route_name(r).into(),
        Pick::Codex => "Codex plan".into(),
        Pick::None if no_key => "No key".into(),
        Pick::None => "Not now".into(),
    }
}

/// The key variables an option reads, by name: `JEV_API_KEY, OPENAI_API_KEY (.env)`.
fn keys(d: &Detected, p: Pick) -> String {
    let var = |r: Route| {
        let v = d.var(r).unwrap_or(default_var(r));
        if d.keys.get(v) == Some(&Seen::DotEnv) {
            format!("{v} (.env)")
        } else {
            v.to_string()
        }
    };
    match p {
        Pick::JevKey(r) => format!("{}, {}", var(Route::Jev), var(r)),
        Pick::JevCodex => var(Route::Jev),
        Pick::Key(r) => var(r),
        Pick::Codex | Pick::None => String::new(),
    }
}

/// The one cost: this repository's, per year; before a repository's technologies are known, one package's.
fn cost_cell(q: &Quote, techs: usize) -> String {
    let c = cost(q, techs.max(1) as f64);
    if c.is_empty() {
        "free".into()
    } else {
        format!("≈ {c}")
    }
}

/// The one quality figure, against the best option.
fn trade(p: Pick, q: &Quote, no_key: bool) -> String {
    if p == Pick::None && !no_key {
        return match NO_PROVIDER_SHARE {
            Some(n) => format!("≈ {n}%: {WITHOUT}"),
            None => WITHOUT.into(),
        };
    }
    if !q.quality_measured {
        return "not measured yet through Codex".into();
    }
    match q.quality {
        Quality::Best => "the best option".into(),
        Quality::Same => "about the same".into(),
        Quality::Unmeasured => "not measured yet".into(),
        Quality::Share { pct, of, .. } => format!("≈ {pct}% of its {of}"),
    }
}

fn len(s: &str) -> usize {
    s.chars().count()
}

fn pad(s: &str, w: usize) -> String {
    format!("{s}{}", " ".repeat(w.saturating_sub(len(s))))
}

/// Rows of cells as aligned columns, each row after `lead`; a column empty in every row is dropped. Trailing blanks
/// are trimmed.
fn columns(rows: &[(String, Vec<String>)], gutter: usize) -> Vec<String> {
    let n = rows.iter().map(|(_, r)| r.len()).max().unwrap_or(0);
    let widths: Vec<usize> = (0..n)
        .map(|i| {
            rows.iter()
                .filter_map(|(_, r)| r.get(i))
                .map(|c| len(c))
                .max()
                .unwrap_or(0)
        })
        .collect();
    let lead = rows.iter().map(|(l, _)| len(l)).max().unwrap_or(0);
    rows.iter()
        .map(|(l, r)| {
            let mut line = pad(l, lead);
            for (i, c) in r.iter().enumerate() {
                line += &" ".repeat(if i == 0 { 2 } else { gutter });
                line += &pad(c, widths[i]);
            }
            line.trim_end().to_string()
        })
        .collect()
}

/// The options as a table that fits `width`: provider, key, cost, what is traded. Too narrow for four columns, the key
/// column goes (the names are in `--details` and in the line that confirms a choice); narrower still, each option
/// takes two lines.
pub fn table(d: &Detected, techs: usize, no_key: bool, width: usize) -> Vec<String> {
    let opts = options(d, no_key);
    let cells: Vec<[String; 4]> = opts
        .iter()
        .map(|p| {
            let q = quote(*p, no_key);
            [
                name(*p, no_key),
                keys(d, *p),
                cost_cell(&q, techs),
                trade(*p, &q, no_key),
            ]
        })
        .collect();
    let per = if techs > 0 {
        "Cost a year, this repo"
    } else {
        "Cost a year, per package"
    };
    let head = ["Read with", "Key", per, "Compared with the best option"];
    let any_key = cells.iter().any(|c| !c[1].is_empty());
    let build = |with_keys: bool, gutter: usize| {
        let pick = |c: &[String; 4]| -> Vec<String> {
            c.iter()
                .enumerate()
                .filter(|(i, _)| with_keys || *i != 1)
                .map(|(_, s)| s.clone())
                .collect()
        };
        let mut rows = vec![("   ".to_string(), pick(&head.map(String::from)))];
        rows.extend(
            cells
                .iter()
                .enumerate()
                .map(|(i, c)| (format!("  {}", i + 1), pick(c))),
        );
        columns(&rows, gutter)
    };
    let fits = |t: &[String]| t.iter().all(|l| len(l) <= width);
    for (with_keys, gutter) in [(true, 3), (true, 2), (false, 3), (false, 2)] {
        if with_keys && !any_key {
            continue;
        }
        let mut t = build(with_keys, gutter);
        // Without the column, the keys the options read are named once, under the table.
        if !with_keys && let Some(k) = keys_line(d, &opts).filter(|k| len(k) <= width) {
            t.push(k);
        }
        if fits(&t) {
            return t;
        }
    }
    // Two lines an option: its name and key, then its cost and trade; narrower still, a line each.
    let mut out = vec![];
    for (i, c) in cells.iter().enumerate() {
        let first = format!("  {}  {}", i + 1, c[0]);
        if c[1].is_empty() {
            out.push(first);
        } else if len(&first) + len(&c[1]) + 3 <= width {
            out.push(format!("{first} ({})", c[1]));
        } else {
            out.push(first);
            out.push(format!("     {}", c[1]));
        }
        let cost = if c[2] == "free" {
            c[2].clone()
        } else if techs > 0 {
            format!("{} a year", c[2])
        } else {
            format!("{} a year per package", c[2])
        };
        if 5 + len(&cost) + 3 + len(&c[3]) <= width {
            out.push(format!("     {cost} · {}", c[3]));
        } else {
            out.push(format!("     {cost}"));
            out.push(format!("     {}", c[3]));
        }
    }
    out
}

/// The key variables the options read, as one line under a table too narrow for a key column.
fn keys_line(d: &Detected, opts: &[Pick]) -> Option<String> {
    let mut names: Vec<String> = vec![];
    for p in opts {
        for k in keys(d, *p).split(", ").filter(|k| !k.is_empty()) {
            if !names.iter().any(|n| n == k) {
                names.push(k.to_string());
            }
        }
    }
    (!names.is_empty()).then(|| format!("     Keys: {}", names.join(", ")))
}

// ---------------------------------------------------------------------------------------------------------- picker

pub const QUESTION: &str = "How should unstale read new release notes?";

/// The picker as printed, up to its prompt: the question, the table, and for an agent the command that records each
/// answer. Without a usable provider, the prompt that says so ([`nothing_lines`]).
pub fn picker_lines(
    d: &Detected,
    techs: usize,
    no_key: bool,
    reader: Reader,
    width: usize,
) -> Vec<String> {
    let opts = options(d, no_key);
    if opts.is_empty() {
        return nothing_lines(d, reader);
    }
    let mut out = match reader {
        Reader::Person => vec![QUESTION.to_string()],
        Reader::Agent => vec![
            "The user chooses how unstale reads new release notes. Show them these options as printed and ask.".into(),
            "Never choose for them.".into(),
        ],
    };
    out.push(String::new());
    out.extend(table(d, techs, no_key, width));
    out.push(String::new());
    if reader == Reader::Agent {
        out.push("Record their answer with the matching command:".into());
        for (i, p) in opts.iter().enumerate() {
            out.push(format!(
                "  {}  unstale setup --inference {}",
                i + 1,
                flag_value(d, *p)
            ));
        }
        out.push("Full costs: unstale setup --details".into());
    }
    out
}

/// The question under the picker. `d` prints the full figures and asks again.
pub fn prompt(n: usize) -> String {
    match n {
        1 => "Enter to use it, or d for details: ".into(),
        _ => "Enter for 1, a number to choose, or d for details: ".into(),
    }
}

/// What the person answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answered {
    /// The option at this index.
    Option(usize),
    /// Nothing: end of input, or three answers that are not choices.
    Nothing,
}

/// Asks once: Enter accepts the first option, a number picks one, `d` prints `details` and asks again. Input that is
/// not a choice is asked for again, at most twice more; then, as at end of input, nothing is chosen.
pub fn ask(
    n: usize,
    prompt: &str,
    details: &[String],
    input: &mut dyn std::io::BufRead,
    out: &mut dyn std::io::Write,
) -> Answered {
    let mut tries = 0;
    while tries < 3 {
        let _ = write!(out, "{prompt}");
        let _ = out.flush();
        let mut line = String::new();
        match input.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let t = line.trim();
        if t.is_empty() {
            return Answered::Option(0);
        }
        if !details.is_empty() && matches!(t, "d" | "D") {
            let _ = writeln!(out);
            for l in details {
                let _ = writeln!(out, "{l}");
            }
            let _ = writeln!(out);
            continue;
        }
        if let Some(p) = t.parse::<usize>().ok().filter(|p| (1..=n).contains(p)) {
            return Answered::Option(p - 1);
        }
        tries += 1;
    }
    let _ = writeln!(out);
    Answered::Nothing
}

// --------------------------------------------------------------------------------------------------- nothing usable

/// The prompt's question when nothing can read release notes.
pub fn nothing_prompt() -> String {
    "Enter for 1, or 2: ".into()
}

/// Why Codex, though installed, cannot be used, as a clause: ` (Codex is not logged in)`.
fn codex_aside(d: &Detected) -> String {
    match &d.codex {
        CodexState::NotReady(why) => {
            format!(" ({})", why.split(". ").next().unwrap_or(why))
        }
        _ => String::new(),
    }
}

/// With no key and no Codex: a choice between setting one up and going without, with what going without leaves.
pub fn nothing_lines(d: &Detected, reader: Reader) -> Vec<String> {
    let left = match without_share() {
        Some(share) => format!("free · {WITHOUT}, {share}"),
        None => format!("free · {WITHOUT}"),
    };
    let aside = codex_aside(d);
    let mut out = match reader {
        Reader::Person => vec![
            "unstale reads new release notes with a model, on your own key or your Codex plan."
                .to_string(),
            format!("None is set up here{aside}."),
        ],
        Reader::Agent => vec![
            "unstale reads new release notes with a model, on the user's own key or Codex plan."
                .to_string(),
            format!(
                "None is set up here{aside}. Tell the user and ask which they want. Never ask them to paste a key."
            ),
        ],
    };
    out.push(String::new());
    out.extend(columns(
        &[
            (
                "  1".into(),
                vec![
                    "Set one up".into(),
                    match reader {
                        Reader::Person => "shows the one line to add".into(),
                        Reader::Agent => "one line to add, listed below".into(),
                    },
                ],
            ),
            ("  2".into(), vec!["Not now".into(), left]),
        ],
        3,
    ));
    out.push(String::new());
    if reader == Reader::Agent {
        out.extend(set_up_lines(d, reader));
        out.push(String::new());
        out.push("If they choose 2: unstale setup --inference none".into());
    }
    out
}

/// How to set a provider up: the one line to add for each, and the command to run after.
pub fn set_up_lines(d: &Detected, reader: Reader) -> Vec<String> {
    let whose = match reader {
        Reader::Person => {
            "Add one of these lines to your shell profile or this repo's .env, then run `unstale setup`:"
        }
        Reader::Agent => {
            "If they choose 1, they add one of these lines to their shell profile or this repo's .env; then run `unstale setup`:"
        }
    };
    let whose_plan = match reader {
        Reader::Person => "your",
        Reader::Agent => "their",
    };
    let mut out = vec![whose.to_string(), String::new()];
    let rows: Vec<(String, Vec<String>)> = [
        Route::OpenAi,
        Route::Vercel,
        Route::OpenRouter,
        Route::Anthropic,
    ]
    .into_iter()
    .map(|r| {
        (
            format!("  {}=<key>", default_var(r)),
            vec![route_name(r).to_string()],
        )
    })
    .collect();
    out.extend(columns(&rows, 3));
    out.push(String::new());
    out.push(match &d.codex {
        CodexState::Ready => format!("Or use {whose_plan} Codex plan: run `unstale setup`."),
        CodexState::NotReady(why) => format!("Or use {whose_plan} Codex plan: {why}"),
        CodexState::Absent => {
            format!("Or use {whose_plan} Codex plan: install Codex and run `codex login`.")
        }
    });
    if d.has(Route::Jev) {
        out.push(format!(
            "{} is set, but it only labels changes: reading release notes needs one of the above as well.",
            d.var(Route::Jev).unwrap_or("JEV_API_KEY")
        ));
    }
    out
}

// --------------------------------------------------------------------------------------------------------- details

/// `unstale setup --details`: every figure behind the table, an option at a time.
pub fn details_lines(d: &Detected, techs: usize, no_key: bool) -> Vec<String> {
    let opts = options(d, no_key);
    let mut out = vec![
        "Costs are estimates from evaluation runs, billed by the provider to your key or plan."
            .to_string(),
    ];
    match techs {
        0 => {}
        1 => out.push("This repo has 1 package unstale follows.".into()),
        n => out.push(format!("This repo has {n} packages unstale follows.")),
    }
    if opts.is_empty() {
        out.push(String::new());
        out.extend(nothing_lines(d, Reader::Person));
        out.extend(set_up_lines(d, Reader::Person));
        return out;
    }
    if !opts.iter().any(|p| matches!(p, Pick::JevKey(_))) {
        out.push(
            "The best option, which the others are compared with: the Jev labelling API (JEV_API_KEY) beside an"
                .into(),
        );
        out.push("OpenAI-compatible key.".into());
    }
    for (i, p) in opts.iter().enumerate() {
        let q = quote(*p, no_key);
        out.push(String::new());
        let k = keys(d, *p);
        let full = match p {
            Pick::JevKey(r) => format!("{} + {}", route_name(Route::Jev), route_name(*r)),
            Pick::JevCodex => format!("{} + Codex plan", route_name(Route::Jev)),
            other => name(*other, no_key),
        };
        out.push(if k.is_empty() {
            format!("{}  {full}", i + 1)
        } else {
            format!("{}  {full} ({k})", i + 1)
        });
        let mut rows: Vec<(String, Vec<String>)> = vec![];
        let mut row = |label: &str, text: String| rows.push((format!("   {label}"), vec![text]));
        let per = cost(&q, 1.0);
        if per.is_empty() {
            row("cost", "free: no model is called".into());
        } else {
            let at_api = if q.codex_tokens > 0 {
                format!(" ({} at API prices)", usd(q.codex_usd))
            } else {
                String::new()
            };
            row("per package, per year", format!("{per}{at_api}"));
            if techs > 0 {
                row("this repo, a year", format!("≈ {}", cost(&q, techs as f64)));
                row(
                    "first sync, once",
                    format!("≈ {}", cost(&q, techs as f64 * FIRST_SYNC_TECH_YEARS)),
                );
            }
        }
        for (j, part) in quality_detail(*p, &q, no_key).into_iter().enumerate() {
            row(if j == 0 { "results" } else { "duplicates" }, part);
        }
        out.extend(columns(&rows, 3));
    }
    out
}

/// Both quality figures of an option, in full: how complete its results are, then how many more duplicates.
fn quality_detail(p: Pick, q: &Quote, no_key: bool) -> Vec<String> {
    if p == Pick::None && !no_key {
        return vec![match without_share() {
            Some(share) => format!("{WITHOUT}: {share}"),
            None => WITHOUT.into(),
        }];
    }
    if !q.quality_measured {
        return vec!["not measured yet through Codex".into()];
    }
    let mut out = vec![match q.quality {
        Quality::Best => "the best option: the most complete".to_string(),
        Quality::Same => "about the same as the best option (same model)".into(),
        Quality::Unmeasured => "not measured yet".into(),
        Quality::Share { pct, of, detail } => {
            let band = match pct {
                98.. => "about the same",
                92.. => "slightly less complete",
                80.. => "somewhat less complete",
                _ => "much less complete",
            };
            format!("{band}: ≈ {pct}% of the best option's {of}{detail}")
        }
    }];
    if q.more_duplicates > 0 {
        out.push(format!(
            "≈ {} more duplicate records per package, per year",
            q.more_duplicates
        ));
    }
    out
}

// ------------------------------------------------------------------------------------------- confirmation and init

/// What a choice uses, with the short names the picker shows: `Jev + OpenAI (JEV_API_KEY, OPENAI_API_KEY)`.
fn short(c: &Choice) -> String {
    c.describe().replace(route_name(Route::Jev), "Jev")
}

/// The line after a choice is recorded.
pub fn saved_line(c: &Choice, place: &str) -> String {
    if c.is_none() {
        return format!(
            "Not reading release notes: {WITHOUT}. Saved in {place}; `unstale setup` changes it."
        );
    }
    format!(
        "Reading release notes with {}. Saved in {place}; `unstale setup` changes it.",
        short(c)
    )
}

/// The line after the picker is dismissed without a choice.
pub fn dismissed_line() -> String {
    format!(
        "Nothing chosen: unstale reads no release notes, {WITHOUT}. `unstale setup` asks again."
    )
}

/// For an agent running `init` with nothing chosen yet: the choice is the user's, and this is how to put it to them.
pub fn pending_line() -> String {
    "Choice pending: how unstale reads new release notes. Run `unstale setup`, show the user its options and ask.".into()
}

/// Without a person or an agent (CI, a pipe, `--yes`) and with nothing chosen: the one line.
pub fn unconfigured_line() -> String {
    "warning: no model provider is configured, so new release notes are not read. Choose one: `unstale setup --inference <choice>`.".into()
}

// ---------------------------------------------------------------------------------------------------------- status

/// A line of `unstale status`'s short block: a label, then what it is, aligned with the others.
pub fn labelled(label: &str, text: &str) -> String {
    format!("{}{text}", pad(label, 22))
}

/// The provider line of `unstale status`: what reads release notes, and where that was chosen.
pub fn provider_line(cur: Option<&(Choice, Origin)>) -> String {
    let text = match cur {
        None => "not read: no provider chosen · `unstale setup` shows the options".to_string(),
        Some((c, origin)) => {
            let from = match origin {
                Origin::Repo => "this repo's config",
                Origin::User => "your user config",
            };
            if c.is_none() {
                format!("not read ({from}): {WITHOUT} · `unstale setup` changes it")
            } else {
                format!("{}, {from}", short(c))
            }
        }
    };
    labelled("Release notes", &text)
}

/// Why the chosen provider cannot be used here, as warnings: a key variable that is not set, or a choice naming a
/// variable that is not its provider's key (never read, so nothing can have another variable sent anywhere).
pub fn missing_key_lines(
    cur: Option<&(Choice, Origin)>,
    set: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let Some((c, _)) = cur else { return vec![] };
    if let Some(v) = c.foreign_key() {
        return vec![format!(
            "warning: {v} is not a key variable for the chosen provider, so new release notes are not read. Run `unstale setup`."
        )];
    }
    c.key_vars()
        .into_iter()
        .filter(|v| !set(v))
        .map(|v| crate::inference::Deferred::NoKey(v.to_string()).line())
        .collect()
}

/// The token line of `unstale status`: this month's use against the user's limit, and how to change it.
pub fn tokens_line(used: std::io::Result<u64>, limit: Limit, origin: LimitOrigin) -> String {
    use crate::inference::ledger::short_tokens;
    let how = "`unstale setup --limit`";
    let text = match (used, limit) {
        (Err(_), _) => "unknown: unstale cannot read its token count".to_string(),
        (Ok(n), Limit::None) => {
            format!("{} this month, no limit ({how} sets one)", short_tokens(n))
        }
        (Ok(n), Limit::Tokens(max)) => {
            let whose = match origin {
                LimitOrigin::Default => "the default limit",
                LimitOrigin::Repo => "this repo's limit",
                LimitOrigin::User => "your limit",
            };
            let reached = if n >= max { ", reached" } else { "" };
            format!(
                "{} of {} this month ({whose}{reached}; {how} changes it)",
                short_tokens(n),
                short_tokens(max)
            )
        }
    };
    labelled("Tokens", &text)
}

/// The line after `unstale setup --limit`.
pub fn limit_saved_line(limit: Option<Limit>, place: &str) -> String {
    use crate::inference::ledger::short_tokens;
    match limit {
        Some(Limit::Tokens(n)) => format!(
            "Monthly token limit: {}. Saved in {place}; past it, new release notes wait for next month.",
            short_tokens(n)
        ),
        Some(Limit::None) => format!("Monthly token limit: none. Saved in {place}."),
        None => format!(
            "Monthly token limit: back to the default, {}. Saved in {place}.",
            short_tokens(crate::inference::ledger::DEFAULT_MONTHLY_TOKENS)
        ),
    }
}
