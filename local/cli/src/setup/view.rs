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

/// The terminal's width at a terminal, [`WIDTH`] anywhere else (a pipe, an agent, CI, and Windows, which has no
/// `stty`).
pub fn width() -> usize {
    use std::io::IsTerminal;
    if cfg!(not(unix)) || !std::io::stdout().is_terminal() {
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

/// What is left without a provider, in the reader's words: the report sections built with no model (publisher
/// deprecations, unmaintained packages, security advisories), short enough that a line stating it fits 100 columns.
pub const WITHOUT: &str = "deprecations, unmaintained packages and advisories";

/// The measured share: `≈ 25% of a full report's findings`.
fn without_cell(n: u32) -> String {
    format!("≈ {n}% of a full report's findings")
}

// ----------------------------------------------------------------------------------------------------------- cells

/// The option's short name: `Jev + OpenAI`, `Codex plan`, `Not now`.
fn name(p: Pick, no_key: bool) -> String {
    match p {
        Pick::JevKey(r) => format!("Jev + {}", route_name(r)),
        Pick::JevCodex => "Jev + Codex plan".into(),
        Pick::SnapKey(r) => format!("Snap + {}", route_name(r)),
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
        Pick::SnapKey(r) => format!("{}, {}", var(Route::Subq), var(r)),
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

/// The one quality figure, in terms that stand alone: the best option says so, an option below it gives its share of
/// the best option's results, and going without the share of a full report it keeps. Never a bare "less" that leaves
/// the reader asking "than what".
fn results(p: Pick, q: &Quote, no_key: bool) -> String {
    if p == Pick::None && !no_key {
        return match NO_PROVIDER_SHARE {
            Some(n) => without_cell(n),
            None => WITHOUT.into(),
        };
    }
    let figure = match q.quality {
        Quality::Best | Quality::Same => "best results".into(),
        Quality::Unmeasured => "not measured yet".into(),
        Quality::Share { pct, .. } => format!("≈ {pct}% of best results"),
        // The share of the best option's right breaking-change flags (89 against 92: ≈ 97%), the one step that differs
        // (as many changes found; change type level or better, benefits about level, `eval/provider-matrix/RESULTS.md`).
        // Framed as a share of the best, not "right"/"wrong": a flag that is off does not break anything. The details
        // name the flags.
        Quality::MoreWrong {
            wrong, best_wrong, ..
        } => format!(
            "≈ {}% of best results",
            ((100 - wrong) as f64 * 100.0 / (100 - best_wrong) as f64).round() as u32
        ),
    };
    if q.labels_and_matching_measured {
        figure
    } else {
        format!("{figure}; {REST_UNMEASURED}")
    }
}

/// After the one measured figure of an option whose other steps are not measured on its route.
const REST_UNMEASURED: &str = "rest not measured";

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

/// The options as a table that fits `width`: provider, key (or what it still needs), cost, results. Too narrow for
/// four columns, the key column goes (the names are in `--details` and in the line that confirms a choice);
/// narrower still, each option takes two lines.
pub fn table(d: &Detected, techs: usize, no_key: bool, width: usize) -> Vec<String> {
    let entries = catalog(d, no_key);
    let picks: Vec<Pick> = entries.iter().map(|e| e.pick).collect();
    let cells: Vec<[String; 4]> = entries
        .iter()
        .map(|e| {
            let q = quote(e.pick, no_key);
            [
                name(e.pick, no_key),
                key_cell(d, *e),
                cost_cell(&q, techs),
                results(e.pick, &q, no_key),
            ]
        })
        .collect();
    let per = if techs > 0 {
        "Cost a year, this repo"
    } else {
        "Cost a year, per package"
    };
    let head = ["Read with", "Key", per, "Results"];
    // Without the key column, what an option still needs is said in the command that records it.
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
        let mut t = build(with_keys, gutter);
        t.extend(notes(&picks));
        // Without the column, the keys the ready options read are named once, under the table.
        if !with_keys && let Some(k) = keys_line(d, &entries).filter(|k| len(k) <= width) {
            t.push(k);
        }
        if fits(&t) {
            return t;
        }
    }
    // Two lines an option: its name and key, then its cost and results; narrower still, a line each.
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
    for n in notes(&picks) {
        out.extend(wrap(n.trim_start(), width, 5));
    }
    out
}

/// The key column: the variables a ready option reads, or what an option still needs here.
fn key_cell(d: &Detected, e: Entry) -> String {
    if e.ready {
        keys(d, e.pick)
    } else {
        needs_cell(d, e.pick)
    }
}

/// `needs JEV_API_KEY and OPENAI_API_KEY`.
fn needs_cell(d: &Detected, p: Pick) -> String {
    format!("needs {}", needs(d, p).join(" and "))
}

/// What Jev and Snap are, said once under a table that offers them: the names alone tell the reader nothing.
fn notes(opts: &[Pick]) -> Vec<String> {
    let jev = opts.iter().any(|p| matches!(p, Pick::JevKey(_) | Pick::JevCodex));
    let snap = opts.iter().any(|p| matches!(p, Pick::SnapKey(_)));
    match (jev, snap) {
        (true, true) => vec!["     Jev labels changes and Snap matches them, beside the provider that reads the notes.".into()],
        (true, false) => vec!["     Jev: a labelling service, used beside the provider that reads the notes.".into()],
        (false, true) => vec!["     Snap: a matching service, used beside the provider that reads the notes.".into()],
        (false, false) => vec![],
    }
}

/// The key variables the options read, as one line under a table too narrow for a key column.
fn keys_line(d: &Detected, entries: &[Entry]) -> Option<String> {
    let mut names: Vec<String> = vec![];
    for e in entries.iter().filter(|e| e.ready) {
        for k in keys(d, e.pick).split(", ").filter(|k| !k.is_empty()) {
            if !names.iter().any(|n| n == k) {
                names.push(k.to_string());
            }
        }
    }
    (!names.is_empty()).then(|| format!("     Keys: {}", names.join(", ")))
}

// ---------------------------------------------------------------------------------------------------------- picker

pub const QUESTION: &str = "How should unstale read new release notes?";

/// The picker as printed, up to its prompt: for an agent the question, every option and the command that records
/// each answer; for a person the [`menu`].
pub fn picker_lines(
    d: &Detected,
    techs: usize,
    no_key: bool,
    reader: Reader,
    width: usize,
) -> Vec<String> {
    if reader == Reader::Person {
        let m = menu(d, techs, no_key, width, None);
        return m.lines(m.default);
    }
    let entries = catalog(d, no_key);
    let mut out: Vec<String> = vec![
        "The user chooses how unstale reads new release notes. Show them these options as printed and ask.".into(),
        "Never choose for them, and never ask them to paste a key.".into(),
    ];
    out.push(String::new());
    out.extend(table(d, techs, no_key, width));
    out.push(String::new());
    out.push("Record their answer with the matching command:".into());
    for (i, e) in entries.iter().enumerate() {
        let cmd = format!("unstale setup --inference {}", flag_value(d, e.pick));
        out.push(if e.ready {
            format!("  {}  {cmd}", i + 1)
        } else {
            format!("  {}  once the user has set up {}: {cmd}", i + 1, needs(d, e.pick).join(" and "))
        });
    }
    out.push("Full costs: unstale setup --details".into());
    out
}

/// The question under the picker. `d` prints the full figures and asks again.
pub fn prompt(n: usize) -> String {
    match n {
        1 => "Enter to use it, or d for details: ".into(),
        _ => "Enter for 1, a number to choose, or d for details: ".into(),
    }
}

/// [`prompt`] where Enter accepts another option than the first (the team's suggestion).
pub fn prompt_default(n: usize, default: usize) -> String {
    match (n, default) {
        (_, 0) | (1, _) => prompt(n),
        _ => format!(
            "Enter for {}, a number to choose, or d for details: ",
            default + 1
        ),
    }
}

// ------------------------------------------------------------------------------------------------------------ menu

/// A choice as a person sees it at a terminal: the question, one row an option with the marked one shown `●`, the
/// options this machine can use apart from those it cannot yet, notes under the rows, and the line that says how to
/// answer. At most [`VISIBLE`] rows show at once; the mark moving past them scrolls. The agent's listing
/// ([`picker_lines`] for [`Reader::Agent`]) stays a numbered table with the command for each answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Menu {
    /// The question and the blank line after it.
    pub head: Vec<String>,
    /// Each option's lines; the first starts with `  ○ `, where the mark goes.
    pub rows: Vec<Vec<String>>,
    /// A heading before the row at this index.
    pub groups: Vec<(usize, String)>,
    /// For each option not set up here, what it needs: said under the rows while it is marked.
    pub needs: Vec<Option<String>>,
    /// The width the menu is laid out for.
    pub width: usize,
    /// Under the rows: what Jev is, a suggestion this machine cannot take.
    pub notes: Vec<String>,
    /// The option marked first, which Enter accepts.
    pub default: usize,
    /// Whether `d` prints the full figures.
    pub details: bool,
}

/// How many options show at once; the rest are a key press away, counted on the line under them.
pub const VISIBLE: usize = 5;

/// How to answer a menu, where the keys can be read one at a time.
pub const HINT: &str = "↑↓ to move · Enter to choose · d for details";
/// [`HINT`] with no details to show.
pub const HINT_SHORT: &str = "↑↓ to move · Enter to choose";

impl Menu {
    /// The first row shown while the mark is at `sel`.
    fn top(&self, sel: usize) -> usize {
        let n = self.rows.len();
        if n <= VISIBLE {
            0
        } else {
            sel.saturating_sub(VISIBLE - 1).min(n - VISIBLE)
        }
    }

    /// The rows in `from..to` with their headings, each first line through `first`; with `needs`, what an option not
    /// set up here needs under it.
    fn body(&self, from: usize, to: usize, needs: bool, first: impl Fn(usize, &str) -> String) -> Vec<String> {
        let mut out = vec![];
        for i in from..to {
            if let Some((_, g)) = self.groups.iter().find(|(at, _)| *at == i) {
                if i != from {
                    out.push(String::new());
                }
                out.push(format!("  {g}"));
            }
            for (j, l) in self.rows[i].iter().enumerate() {
                out.push(if j == 0 { first(i, l) } else { l.clone() });
            }
            if let (true, Some(Some(need))) = (needs, self.needs.get(i)) {
                out.extend(wrap(&format!("needs {need}"), self.width, 6));
            }
        }
        out
    }

    /// Everything above the line that says how to answer, with the option at `sel` marked and the rows around it.
    pub fn lines(&self, sel: usize) -> Vec<String> {
        let n = self.rows.len();
        let top = self.top(sel);
        let end = (top + VISIBLE).min(n);
        let mut out = self.head.clone();
        if top > 0 {
            out.push(format!("    ↑ {top} more"));
        }
        out.extend(self.body(top, end, false, |i, l| {
            if i == sel { l.replacen('○', "●", 1) } else { l.to_string() }
        }));
        if end < n {
            out.push(format!("    ↓ {} more", n - end));
        }
        out.extend(self.notes.iter().cloned());
        if let Some(Some(need)) = self.needs.get(sel) {
            out.push(String::new());
            out.extend(wrap(&format!("Needs {need}. Enter shows how to set it up."), self.width, 2));
        }
        out.push(String::new());
        out
    }

    pub fn hint(&self) -> &'static str {
        match (self.rows.len(), self.details) {
            (1, true) => "Enter to choose · d for details",
            (1, false) => "Enter to choose",
            (_, true) => HINT,
            (_, false) => HINT_SHORT,
        }
    }

    /// [`Menu::lines`] for a typed answer: every option, numbered where the mark would go, as the prompt under it
    /// asks for a number (a `●` there would read as a mark the keys could move).
    pub fn typed_lines(&self) -> Vec<String> {
        let mut out = self.head.clone();
        out.extend(self.body(0, self.rows.len(), true, |i, l| {
            l.replacen('○', &(i + 1).to_string(), 1)
        }));
        out.extend(self.notes.iter().cloned());
        out.push(String::new());
        out
    }

    /// The typed answer's prompt, where keys cannot be read one at a time.
    pub fn typed_prompt(&self) -> String {
        prompt_default(self.rows.len(), self.default)
    }
}

/// An option's name for a person: `OpenAI key`, `Jev + OpenAI key`, `Codex plan`, `Not now`.
fn menu_name(p: Pick, no_key: bool) -> String {
    match p {
        Pick::JevKey(r) => format!("Jev + {} key", route_name(r)),
        Pick::SnapKey(r) => format!("Snap + {} key", route_name(r)),
        Pick::Key(r) => format!("{} key", route_name(r)),
        other => name(other, no_key),
    }
}

/// The one cost, with its unit: `≈ $2.43 a year`. Codex use is the user's plan, not a bill: its tokens are in the
/// details and in `unstale status`.
fn menu_cost(q: &Quote, techs: usize) -> String {
    let per = if techs > 0 { "a year" } else { "a year per package" };
    let years = techs.max(1) as f64;
    if q.usd > 0.0 {
        format!("≈ {} {per}", usd(q.usd * years))
    } else if q.codex_tokens > 0 {
        "your Codex plan".into()
    } else if q.agent_tokens > 0 {
        format!("≈ {} {per}", cost(q, years))
    } else {
        "free".into()
    }
}

/// Rows of cells after a mark, as aligned columns that fit `width`; too narrow, each row's first cell on its line
/// and the rest under it, wrapped.
fn menu_rows(cells: &[Vec<String>], width: usize) -> Vec<Vec<String>> {
    let rows: Vec<(String, Vec<String>)> = cells
        .iter()
        .map(|c| ("  ○".to_string(), c.clone()))
        .collect();
    for gutter in [3, 2] {
        // `columns` sets the first cell two blanks after the mark: one is enough.
        let lines: Vec<String> = columns(&rows, gutter)
            .into_iter()
            .map(|l| l.replacen("○  ", "○ ", 1))
            .collect();
        if lines.iter().all(|l| len(l) <= width) {
            return lines.into_iter().map(|l| vec![l]).collect();
        }
    }
    cells
        .iter()
        .map(|c| {
            let mut out = vec![format!("  ○ {}", c[0])];
            let rest: Vec<&str> = c[1..]
                .iter()
                .map(String::as_str)
                .filter(|s| !s.is_empty())
                .collect();
            out.extend(wrap(&rest.join(" · "), width, 4));
            out
        })
        .collect()
}

/// Heading over the options this machine can use.
pub const READY: &str = "Found installed locally";
/// Heading over the options it cannot use yet.
pub const SET_UP_FIRST: &str = "Not found locally";

/// The picker for a person: every option, those this machine can use first, the best of them marked; or
/// `suggested` (this repository's suggestion, where this machine can use it) marked and tagged. An option not set up
/// here says what it needs; choosing it shows how ([`set_up_for`]).
pub fn menu(d: &Detected, techs: usize, no_key: bool, width: usize, suggested: Option<usize>) -> Menu {
    let entries = catalog(d, no_key);
    let cells: Vec<Vec<String>> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let q = quote(e.pick, no_key);
            vec![
                menu_name(e.pick, no_key),
                menu_cost(&q, techs),
                results(e.pick, &q, no_key),
                if suggested == Some(i) {
                    "this repo's pick".into()
                } else {
                    String::new()
                },
            ]
        })
        .collect();
    let rows = menu_rows(&cells, width);
    let picks: Vec<Pick> = entries.iter().map(|e| e.pick).collect();
    let mut notes: Vec<String> = notes(&picks)
        .iter()
        .flat_map(|n| wrap(n.trim_start(), width, 4))
        .collect();
    // Under options of two lines each, a note set apart, so it is not read as the last option's.
    if !notes.is_empty() && rows.iter().any(|r| r.len() > 1) {
        notes.insert(0, String::new());
    }
    let ready = entries.iter().filter(|e| e.ready).count();
    let groups = if ready < entries.len() {
        vec![(0, READY.to_string()), (ready, SET_UP_FIRST.to_string())]
    } else {
        vec![]
    };
    Menu {
        head: wrap(QUESTION, width, 0).into_iter().chain([String::new()]).collect(),
        rows,
        groups,
        needs: entries
            .iter()
            .map(|e| (!e.ready).then(|| needs(d, e.pick).join(" and ")))
            .collect(),
        width,
        notes,
        default: suggested.unwrap_or_else(|| best_ready(&entries)),
        details: true,
    }
}

/// Under the options, when this repository's config names a provider and the user has chosen nothing: which option
/// that is (`at`, where this machine offers it) and that the choice is the user's; with nothing usable here
/// (`usable` false), what to set for it.
pub fn suggested_line(team: &Choice, at: Option<usize>, usable: bool, reader: Reader) -> String {
    let who = match reader {
        Reader::Person => "you choose",
        Reader::Agent => "the user chooses",
    };
    match at {
        Some(i) => format!(
            "This repo's config suggests option {}. Nothing is spent until {who}.",
            i + 1
        ),
        None if usable => format!(
            "This repo's config suggests {}, which is not one of the options here.",
            suggestion(team)
        ),
        None => {
            // Its name without the variables, which the instruction names.
            let name = suggestion(team);
            let name = name.split(" (").next().unwrap_or(&name);
            let mut steps: Vec<String> = vec![];
            let vars = team.key_vars();
            if !vars.is_empty() {
                let set = match reader {
                    Reader::Person => "set",
                    Reader::Agent => "the user sets",
                };
                steps.push(format!("{set} {}", vars.join(" and ")));
            }
            if team.provider == "codex" {
                steps.push(match reader {
                    Reader::Person => "install Codex and run `codex login`".into(),
                    Reader::Agent => "the user installs Codex and runs `codex login`".into(),
                });
            }
            let run = match reader {
                Reader::Person => "then run",
                Reader::Agent => "then you run",
            };
            format!(
                "This repo's config suggests {name}: {}, {run} `unstale setup`.",
                steps.join(", ")
            )
        }
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

/// Where an answer is awaited again after one that was not a choice (`d` for the details included): the same
/// question, still open, not asked a second time.
pub const CONTINUE: &str = "Your choice (Enter for 1): ";

/// Asks once: Enter accepts the first option, a number picks one, and `d` prints `details` (once). Any other answer,
/// like `d`, is a try: the question stays open at [`CONTINUE`], and after three tries, as at end of input, nothing is
/// chosen.
pub fn ask(
    n: usize,
    prompt: &str,
    details: &[String],
    input: &mut dyn std::io::BufRead,
    out: &mut dyn std::io::Write,
) -> Answered {
    ask_default(n, 0, prompt, details, input, out)
}

/// [`ask`] where Enter accepts the option at `default`.
pub fn ask_default(
    n: usize,
    default: usize,
    prompt: &str,
    details: &[String],
    input: &mut dyn std::io::BufRead,
    out: &mut dyn std::io::Write,
) -> Answered {
    let again = format!("Your choice (Enter for {}): ", default + 1);
    let mut shown = false;
    let mut next = prompt;
    for _ in 0..3 {
        let _ = write!(out, "{next}");
        let _ = out.flush();
        let mut line = String::new();
        match input.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let t = line.trim();
        if t.is_empty() {
            return Answered::Option(default);
        }
        if let Some(p) = t.parse::<usize>().ok().filter(|p| (1..=n).contains(p)) {
            return Answered::Option(p - 1);
        }
        if !details.is_empty() && !shown && matches!(t, "d" | "D") {
            shown = true;
            let _ = writeln!(out);
            for l in details {
                let _ = writeln!(out, "{l}");
            }
            let _ = writeln!(out);
        }
        next = if default == 0 { CONTINUE } else { &again };
    }
    let _ = writeln!(out);
    Answered::Nothing
}

/// `text` in lines of at most `width`, each after `indent` blanks; a word longer than a line stays whole.
pub fn wrap(text: &str, width: usize, indent: usize) -> Vec<String> {
    let room = width.saturating_sub(indent).max(1);
    let mut lines: Vec<String> = vec![];
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && len(&line) + 1 + len(word) > room {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line += word;
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
        .into_iter()
        .map(|l| format!("{}{l}", " ".repeat(indent)))
        .collect()
}

// ------------------------------------------------------------------------------------------------------- set up

/// After an option this machine cannot use yet is chosen: what to set up for it, a step a line, and the command that
/// asks again. A key goes in the shell profile or this repository's `.env`; an OpenAI-compatible key may be any of
/// the three.
pub fn set_up_for(d: &Detected, p: Pick, width: usize) -> Vec<String> {
    let mut out = wrap(
        &format!("To read with {}, set it up, then run `unstale setup`:", menu_name(p, false)),
        width,
        0,
    );
    out.push(String::new());
    for need in needs(d, p) {
        let line = match need.as_str() {
            "Codex" => "install Codex and run `codex login`".to_string(),
            "`codex login`" => match &d.codex {
                CodexState::NotReady(why) => why.clone(),
                _ => "run `codex login`".to_string(),
            },
            var if route_of(var).is_some_and(|r| matches!(r, Route::Vercel | Route::OpenAi | Route::OpenRouter)) => {
                let others: Vec<&str> = [Route::OpenAi, Route::Vercel, Route::OpenRouter]
                    .into_iter()
                    .map(default_var)
                    .filter(|v| *v != var)
                    .collect();
                format!("add {var}=<key> to your shell profile or this repo's .env (or {})", others.join(" or "))
            }
            var => format!("add {var}=<key> to your shell profile or this repo's .env"),
        };
        out.extend(wrap(&line, width, 2));
    }
    out
}

// --------------------------------------------------------------------------------------------------------- details

/// `unstale setup --details`: every figure behind the table, an option at a time.
pub fn details_lines(d: &Detected, techs: usize, no_key: bool) -> Vec<String> {
    let entries = catalog(d, no_key);
    let mut out = vec![
        "Costs are estimates from evaluation runs, billed by the provider to your key or plan."
            .to_string(),
    ];
    match techs {
        0 => {}
        1 => out.push("This repo has 1 package unstale follows.".into()),
        n => out.push(format!("This repo has {n} packages unstale follows.")),
    }
    for (i, e) in entries.iter().enumerate() {
        let p = &e.pick;
        let q = quote(*p, no_key);
        out.push(String::new());
        let k = key_cell(d, *e);
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
        for part in quality_detail(*p, &q, no_key) {
            row(part.0, part.1);
        }
        out.extend(columns(&rows, 3));
    }
    out
}

/// Both quality figures of an option, in full, each under its label: how complete its results are, a qualifier, and
/// how many more changes it lists twice.
fn quality_detail(p: Pick, q: &Quote, no_key: bool) -> Vec<(&'static str, String)> {
    if p == Pick::None && !no_key {
        return vec![(
            "results",
            match NO_PROVIDER_SHARE {
                Some(n) => format!("{WITHOUT}: {}", without_cell(n)),
                None => WITHOUT.into(),
            },
        )];
    }
    let mut out = vec![];
    match q.quality {
        Quality::Best => out.push(("results", "the best option: the most complete".to_string())),
        Quality::Same => out.push((
            "results",
            "about the same as the best option (same model)".into(),
        )),
        Quality::Unmeasured => out.push(("results", "not measured yet".into())),
        Quality::Share { pct, of, detail } => {
            let band = match pct {
                98.. => "about the same",
                92.. => "slightly less complete",
                80.. => "somewhat less complete",
                _ => "much less complete",
            };
            out.push((
                "results",
                format!("{band}: ≈ {pct}% of the best option's {of}"),
            ));
            if !detail.is_empty() {
                out.push(("", detail.trim().trim_matches(['(', ')']).to_string()));
            }
        }
        Quality::MoreWrong {
            wrong,
            best_wrong,
            found,
            of,
            detail,
            ..
        } => {
            out.push((
                "results",
                format!("as many {found} found as the best option"),
            ));
            out.push((
                "",
                format!(
                    "≈ {}% of {of} right, against {}% for the best option",
                    100 - wrong,
                    100 - best_wrong
                ),
            ));
            out.extend(detail.iter().map(|l| ("", l.to_string())));
        }
    }
    if !q.labels_and_matching_measured {
        out.push((
            "",
            "breaking-change flags and repeats through Codex: not measured yet".into(),
        ));
        return out;
    }
    if q.more_duplicates > 0 {
        out.push((
            "repeats",
            format!(
                "≈ {} more {} listed twice per package, per year than the best option",
                q.more_duplicates,
                if q.more_duplicates == 1 { "change" } else { "changes" }
            ),
        ));
    }
    out
}

// ------------------------------------------------------------------------------------------- confirmation and init

/// What a choice uses, with the short names the picker shows: `Jev + OpenAI (JEV_API_KEY, OPENAI_API_KEY)`.
fn short(c: &Choice) -> String {
    c.describe().replace(route_name(Route::Jev), "Jev")
}

/// The lines after a choice is recorded: what reads release notes now and whose config holds it; and, for a choice
/// saved for the user where this repository has its own, that the repository's still applies here.
pub fn saved_lines(c: &Choice, place: Origin, repo_choice: Option<&Choice>) -> Vec<String> {
    let whom = match place {
        Origin::Repo => "Saved for this repo",
        Origin::User => "Saved for you",
    };
    let mut out = vec![if c.is_none() {
        format!("{whom}: no release notes read; {WITHOUT} only.")
    } else {
        format!("{whom}: {} reads release notes.", short(c))
    }];
    if let Some(r) = repo_choice {
        out.push(format!(
            "This repo's own choice still applies: {}.",
            if r.is_none() {
                "none".to_string()
            } else {
                short(r)
            }
        ));
    }
    out
}

/// The line after the picker is dismissed without a choice.
pub fn dismissed_line() -> String {
    format!("Nothing chosen: {WITHOUT} only. `unstale setup` asks again.")
}

/// The line after a reopened picker is dismissed: the choice made before stays.
pub fn kept_line(c: &Choice) -> String {
    if c.is_none() {
        "Nothing changed: release notes are still not read.".into()
    } else {
        format!("Nothing changed: still reading with {}.", short(c))
    }
}

/// For an agent running `init` with nothing chosen yet: the choice is the user's, and this is how to put it to them.
pub fn pending_line() -> String {
    "Choice pending: how unstale reads new release notes. Run `unstale setup` and ask the user."
        .into()
}

/// Without a person or an agent (CI, a pipe, `--yes`) and with nothing chosen: the one line.
pub fn unconfigured_line() -> String {
    "warning: no provider chosen, so new release notes are not read. `unstale setup` lists the options.".into()
}

/// [`unconfigured_line`] where this repository's committed config names a choice: it is not the user's until they
/// make it, and saying only "no provider chosen" would contradict the file they can see.
pub fn suggested_unchosen_line() -> String {
    "warning: you have not chosen a provider, so new release notes are not read. Run `unstale setup`.".into()
}

fn suggestion(team: &Choice) -> String {
    if team.is_none() {
        "not reading release notes".to_string()
    } else {
        short(team)
    }
}

/// `12 November`, and the year when it is not this one: `12 November 2025`. The date as stored when it cannot be read.
fn day(date: &str, today: &str) -> String {
    const MONTHS: [&str; 12] = [
        "January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
        "November", "December",
    ];
    let parts: Vec<&str> = date.get(..10).unwrap_or("").split('-').collect();
    let [y, m, d] = parts.as_slice() else {
        return date.to_string();
    };
    let (Some(m), Ok(d)) = (
        m.parse::<usize>().ok().and_then(|m| MONTHS.get(m.wrapping_sub(1))),
        d.parse::<u32>(),
    ) else {
        return date.to_string();
    };
    if today.get(..4) == Some(*y) {
        format!("{d} {m}")
    } else {
        format!("{d} {m} {y}")
    }
}

/// The option a stored choice stands for, for its cost.
fn pick_of(c: &Choice) -> Option<Pick> {
    let jev = c.labels.as_ref().is_some_and(|l| l.provider == "jev");
    let snap = c.matching.as_ref().is_some_and(|m| m.provider == "subq");
    if c.provider == "codex" {
        return Some(if jev { Pick::JevCodex } else { Pick::Codex });
    }
    let r = route_by_id(&c.provider)?;
    Some(match (jev, snap) {
        (true, _) => Pick::JevKey(r),
        (false, true) => Pick::SnapKey(r),
        (false, false) => Pick::Key(r),
    })
}

/// A choice made by an agent or a script that no person has seen, said once at a terminal and in `unstale status`:
/// what spends, this repository's cost a year, who chose it and when, and the command that undoes it.
pub fn unseen_line(u: &Unseen, techs: usize, today: &str) -> String {
    let c = &u.choice;
    let routes = |extra: &str| {
        let main = route_by_id(&c.provider).map(route_name).unwrap_or(&c.provider);
        format!("{extra} and {main} keys")
    };
    let on = match (c.provider.as_str(), &c.labels, &c.matching) {
        ("codex", Some(_), _) => "Jev key and Codex plan".to_string(),
        ("codex", None, _) => "Codex plan".to_string(),
        (_, Some(_), _) => routes("Jev"),
        (_, None, Some(_)) => routes("SubQ Snap"),
        (p, None, None) => format!("{} key", route_by_id(p).map(route_name).unwrap_or(p)),
    };
    let usd_a_year = pick_of(c).map(|p| quote(p, false).usd * techs.max(1) as f64).unwrap_or(0.0);
    let cost = if usd_a_year > 0.0 {
        format!("≈ {} a year", usd(usd_a_year))
    } else {
        "no extra cost".to_string()
    };
    let by = if u.mark.agent() {
        "through your agent"
    } else {
        "through a script"
    };
    // Undo names what restores both: no provider, and the limit before an agent or a script changed it.
    let mut undo = match (u.chosen, u.every_repo) {
        (false, _) => "unstale setup".to_string(),
        (true, true) => "unstale setup --user --inference none".to_string(),
        (true, false) => "unstale setup --inference none".to_string(),
    };
    if let Some((_, previous)) = &u.limit {
        undo.push_str(&format!(" --limit {previous}"));
    }
    // A limit raised or removed with it, named with what it was set to.
    let limit = match &u.limit {
        Some((Limit::Tokens(n), _)) => format!(
            " with a token limit of {}",
            crate::inference::ledger::short_tokens(*n)
        ),
        Some((Limit::None, _)) => " with no token limit".to_string(),
        None => String::new(),
    };
    let verb = if u.chosen { "chosen" } else { "set" };
    format!(
        "unstale reads release notes on your {on} ({cost}){limit}, {verb} {by} on {}. Undo: `{undo}`",
        day(&u.mark.on, today)
    )
}

// ---------------------------------------------------------------------------------------------------------- status

/// A line of `unstale status`'s short block: a label, then what it is, aligned with the others.
pub fn labelled(label: &str, text: &str) -> String {
    format!("{}{text}", pad(label, 22))
}

/// The provider line of `unstale status`: what reads release notes, and where that was chosen.
pub fn provider_line(cur: Option<&(Choice, Origin)>, suggested: Option<&Choice>) -> String {
    let text = match cur {
        None => match suggested {
            Some(_) => "not read: you have not chosen · `unstale setup` shows this repo's suggestion".to_string(),
            None => "not read: no provider chosen · `unstale setup` shows the options".to_string(),
        },
        Some((c, origin)) => {
            let from = match origin {
                Origin::Repo => "this repo's config",
                Origin::User => "your user config",
            };
            if c.is_none() {
                format!("not read, by {from} · `unstale setup` changes it")
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
            "warning: {v} is not this provider's key, so new release notes are not read. Run `unstale setup`."
        )];
    }
    c.key_vars()
        .into_iter()
        .filter(|v| !set(v))
        .map(|v| crate::inference::Deferred::NoKey(v.to_string()).line())
        .collect()
}

/// The token line of `unstale status`: this month's use against the limit in effect, whose it is, and how to change
/// it.
pub fn tokens_line(used: std::io::Result<u64>, limit: Limit, origin: LimitOrigin) -> String {
    use crate::inference::ledger::short_tokens;
    let how = "`unstale setup --limit`";
    let text = match (used, limit) {
        (Err(_), _) => "unknown: the count cannot be read".to_string(),
        (Ok(n), Limit::None) => {
            format!("{} this month, no limit ({how} sets one)", short_tokens(n))
        }
        (Ok(n), Limit::Tokens(max)) => {
            let reached = if n >= max { ", reached" } else { "" };
            let whose = match origin {
                // Reached: the warning above the block carries the fix.
                LimitOrigin::Default if n >= max => "the default limit, reached".to_string(),
                LimitOrigin::User if n >= max => "your limit, reached".to_string(),
                LimitOrigin::Default => format!("the default limit; {how} changes it"),
                LimitOrigin::User => format!("your limit; {how} changes it"),
                // Lower than the user's own, so only the repository's config can change it.
                LimitOrigin::Repo => {
                    format!("this repo's limit{reached}, set in .unstale/config.json")
                }
                // The line above the block says whose choice it is and how to lift it.
                LimitOrigin::Unseen { .. } if n >= max => "a tenth of the limit, reached".to_string(),
                LimitOrigin::Unseen { .. } => {
                    "a tenth of the limit until you run unstale at a terminal".to_string()
                }
            };
            format!(
                "{} of {} this month ({whose})",
                short_tokens(n),
                short_tokens(max)
            )
        }
    };
    labelled("Tokens", &text)
}

/// The warning in `unstale status` when the limit in effect is reached, with the fix that works for whose it is.
pub fn limit_reached_line(origin: LimitOrigin) -> String {
    match origin {
        LimitOrigin::Repo => "warning: this repo's token limit is reached, so new release notes wait. See .unstale/config.json.".into(),
        LimitOrigin::Unseen { agent } => crate::inference::Deferred::BudgetUnseen { agent }.line(),
        _ => crate::inference::Deferred::Budget.line(),
    }
}

/// The warning in `unstale status` when the token count cannot be used, with the file and the fix for the cause.
pub fn token_count_line(file: &Path, e: &std::io::Error) -> String {
    let file = file.display();
    match crate::inference::Deferred::storage(e) {
        crate::inference::Deferred::StorageCorrupt => format!(
            "warning: unstale's token count is corrupt, so new release notes are not read. Delete {file} (the count restarts)."
        ),
        _ => format!(
            "warning: unstale cannot write its token count, so new release notes are not read. Make {file} writable."
        ),
    }
}

/// The line after `unstale setup --limit`: what was saved for the user, and what applies here now when that differs.
pub fn limit_saved_line(saved: Option<Limit>, applies: Limit, origin: LimitOrigin) -> String {
    use crate::inference::ledger::short_tokens;
    let own = match saved {
        Some(Limit::Tokens(n)) => format!("Your monthly token limit: {}.", short_tokens(n)),
        Some(Limit::None) => "Your monthly token limit: none.".to_string(),
        None => format!(
            "Your monthly token limit: the default, {}.",
            short_tokens(crate::inference::ledger::DEFAULT_MONTHLY_TOKENS)
        ),
    };
    match (origin, applies) {
        (LimitOrigin::Repo, Limit::Tokens(n)) => format!(
            "{own} Here this repo's lower limit applies: {} (.unstale/config.json).",
            short_tokens(n)
        ),
        _ => own,
    }
}
