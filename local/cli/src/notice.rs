//! Catalog notices and the update line: what the last synced root (`v1/root.json` in the cache, signed with the rest of
//! the catalog) says to every client, printed on the lines agents already read (`unstale status`, the session-start
//! hook). A notice is there only when every user must do something by a date: its text says what, its `until` is the
//! date. It prints at most once a day per id, while today is on or before `until`. With the edge-inference switch on
//! the line leads with the date, however the text is phrased (`unstale notice, act by 30 November: <text>`), and a
//! notice whose text or date changed prints again the same day; with the switch off it reads as it always did
//! (`unstale notice: <text>`). The update line prints at most once a day while the root's `latest_client` is newer
//! than this client. No network: only the cached root.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use unstale_schema::catalog::Root;

use crate::util;

/// The day each line was last printed, in `.unstale/state/notices.json`.
#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Shown {
    /// Notice id to the day it was last printed.
    #[serde(default)]
    pub notices: BTreeMap<String, String>,
    /// Notice id to a fingerprint of the line last printed, so one whose text or date changed prints again. Absent in
    /// a state written before fingerprints: then the day alone decides, so nothing repeats after an upgrade.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub printed: BTreeMap<String, String>,
    /// The day the update line was last printed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<String>,
}

/// The command that upgrades this client: Homebrew's when the running binary (symlinks resolved) is in a keg, which
/// is always under `Cellar`; npm's otherwise, including an npm install under a Homebrew Node (`/opt/homebrew/lib`).
pub fn upgrade_command(exe: &Path) -> &'static str {
    let homebrew = exe.components().any(|c| c.as_os_str() == "Cellar");
    if homebrew { "brew upgrade unstale" } else { "npm install -g @unstale/cli@latest" }
}

/// One printable line (`util::one_line`: control, separator and bidirectional characters blanked), bounded.
fn one_line(s: &str) -> String {
    util::one_line(s, 400)
}

/// The lines due today, recording each in `shown`. `ours` is this client's version; `dated` is the edge-inference
/// switch (`notice_line`).
pub fn due(root: &Root, ours: &str, today: &str, upgrade: &str, dated: bool, shown: &mut Shown) -> Vec<String> {
    let mut out = vec![];
    let day = util::parse_date(today);
    if let Some(n) = &root.notice
        && let (Some(d), Some(until)) = (day, util::parse_date(&n.until))
        && d <= until
        && !one_line(&n.text).is_empty()
    {
        let line = notice_line(&n.until, &n.text, dated);
        let mark = util::sha256_hex(line.as_bytes())[..8].to_string();
        let today_already = shown.notices.get(&n.id).map(String::as_str) == Some(today);
        let changed = shown.printed.get(&n.id).is_some_and(|m| *m != mark);
        if !today_already || changed {
            out.push(line);
            shown.notices.insert(n.id.clone(), today.to_string());
            shown.printed.insert(n.id.clone(), mark);
        }
    }
    shown.printed.retain(|id, _| root.notice.as_ref().is_some_and(|n| &n.id == id));
    // Ids whose last day is behind today will not print again unless the root names them; keep only the current one.
    shown.notices.retain(|id, _| root.notice.as_ref().is_some_and(|n| &n.id == id));
    if let Some(latest) = root.latest_client.as_deref()
        && let (Some(l), Some(o)) = (util::parse_version(latest), util::parse_version(ours))
        && l > o
        && shown.update.as_deref() != Some(today)
    {
        out.push(format!("unstale {} available: {upgrade}", one_line(latest)));
        shown.update = Some(today.to_string());
    }
    out
}

/// The notice as printed. `dated` (the edge-inference switch on) leads with the day to act by, in a form that reads
/// right whether the text is an instruction or a statement; otherwise the line is as it was before the switch.
pub fn notice_line(until: &str, text: &str, dated: bool) -> String {
    if dated {
        format!("unstale notice, act by {}: {}", day_month(until), one_line(text))
    } else {
        format!("unstale notice: {}", one_line(text))
    }
}

/// `2026-11-30` as `30 November`.
fn day_month(date: &str) -> String {
    const MONTHS: [&str; 12] =
        ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    let part = |i: usize| date.split('-').nth(i).and_then(|p| p.parse::<usize>().ok());
    match (part(1), part(2)) {
        (Some(m @ 1..=12), Some(d)) => format!("{d} {}", MONTHS[m - 1]),
        _ => date.to_string(),
    }
}

fn shown_path(tool: &Path) -> PathBuf {
    tool.join("state/notices.json")
}

/// The lines due from the cached root, recorded as printed. Best effort: no cached root, or a state that cannot be
/// saved (which would repeat the line on every command), gives none.
fn take(cache: &Path, tool: &Path, ours: &str, today: &str, upgrade: &str, dated: bool) -> Vec<String> {
    let Some(root) = std::fs::read(cache.join("v1/root.json")).ok().and_then(|b| serde_json::from_slice::<Root>(&b).ok()) else { return vec![] };
    let path = shown_path(tool);
    let mut shown: Shown = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let lines = due(&root, ours, today, upgrade, dated, &mut shown);
    if lines.is_empty() || serde_json::to_vec_pretty(&shown).ok().and_then(|b| util::write_atomic(&path, &b).ok()).is_none() {
        return vec![];
    }
    lines
}

/// The first line due today (the notice before the update line), recorded as printed; the other stays due. The
/// session-start hook prints at most one line.
pub fn take_one(cache: &Path, tool: &Path) -> Option<String> {
    let root = std::fs::read(cache.join("v1/root.json")).ok().and_then(|b| serde_json::from_slice::<Root>(&b).ok())?;
    let exe = std::env::current_exe().and_then(|e| e.canonicalize()).unwrap_or_default();
    let path = shown_path(tool);
    let mut shown: Shown = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let before = shown.update.clone();
    let lines = due(&root, env!("CARGO_PKG_VERSION"), &util::today(), upgrade_command(&exe), util::edge_inference(), &mut shown);
    if lines.len() > 1 {
        // Only the notice is printed: the update line is still due.
        shown.update = before;
    }
    let first = lines.into_iter().next()?;
    serde_json::to_vec_pretty(&shown).ok().and_then(|b| util::write_atomic(&path, &b).ok())?;
    Some(first)
}

/// Print the lines due today from the cached root.
pub fn print(cache: &Path, tool: &Path) {
    let exe = std::env::current_exe().and_then(|e| e.canonicalize()).unwrap_or_default();
    for line in take(cache, tool, env!("CARGO_PKG_VERSION"), &util::today(), upgrade_command(&exe), util::edge_inference()) {
        println!("{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use unstale_schema::catalog::Notice;

    fn root(latest: Option<&str>, notice: Option<(&str, &str)>) -> Root {
        Root {
            schema: 1,
            min_client: "0.1.0".into(),
            latest_client: latest.map(String::from),
            notice: notice.map(|(id, until)| Notice { id: id.into(), until: until.into(), text: "Hosted labelling ends 30 Nov.\nRun `unstale setup`.".into() }),
        }
    }

    #[test]
    fn a_notice_prints_once_a_day_until_its_last_day() {
        let r = root(None, Some(("keys", "2026-11-30")));
        let mut shown = Shown::default();
        assert_eq!(due(&r, "0.3.0", "2026-11-10", "x", false, &mut shown), vec!["unstale notice: Hosted labelling ends 30 Nov. Run `unstale setup`."]);
        assert!(due(&r, "0.3.0", "2026-11-10", "x", false, &mut shown).is_empty(), "once a day");
        assert_eq!(due(&r, "0.3.0", "2026-11-30", "x", false, &mut shown).len(), 1, "the until day itself still prints");
        assert!(due(&r, "0.3.0", "2026-12-01", "x", false, &mut shown).is_empty(), "past until");
        // A new id prints the same day another one did; the old id is forgotten.
        let mut shown = Shown { notices: BTreeMap::from([("old".into(), "2026-11-10".into())]), ..Default::default() };
        assert_eq!(due(&r, "0.3.0", "2026-11-10", "x", false, &mut shown).len(), 1);
        assert_eq!(shown.notices.keys().collect::<Vec<_>>(), vec!["keys"]);
        // The same id with another text prints again the same day; unchanged, it does not.
        let mut shown = Shown::default();
        assert_eq!(due(&r, "0.3.0", "2026-11-10", "x", false, &mut shown).len(), 1);
        let mut later = root(None, Some(("keys", "2026-11-30")));
        later.notice.as_mut().unwrap().text = "Upgrade unstale.".into();
        assert_eq!(due(&later, "0.3.0", "2026-11-10", "x", false, &mut shown), vec!["unstale notice: Upgrade unstale."]);
        assert!(due(&later, "0.3.0", "2026-11-10", "x", false, &mut shown).is_empty());
        // A state written before fingerprints (the day alone): nothing repeats on the day of an upgrade.
        let mut old: Shown = serde_json::from_str(r#"{"notices":{"keys":"2026-11-10"}}"#).unwrap();
        assert!(due(&r, "0.3.0", "2026-11-10", "x", false, &mut old).is_empty());
        assert_eq!(due(&r, "0.3.0", "2026-11-11", "x", false, &mut old).len(), 1);
        // With the switch on the line leads with the date, whether the text instructs or states.
        assert_eq!(
            notice_line("2026-11-30", "Upgrade unstale; this version stops receiving new changes then.", true),
            "unstale notice, act by 30 November: Upgrade unstale; this version stops receiving new changes then."
        );
        assert_eq!(notice_line("2026-11-30", "Hosted labelling ends.", true), "unstale notice, act by 30 November: Hosted labelling ends.");
        // An unreadable until prints nothing.
        assert!(due(&root(None, Some(("bad", "soon"))), "0.3.0", "2026-11-10", "x", false, &mut Shown::default()).is_empty());
    }

    #[test]
    fn the_update_line_prints_once_a_day_only_for_a_newer_release() {
        let mut shown = Shown::default();
        let r = root(Some("0.3.2"), None);
        assert_eq!(due(&r, "0.3.1", "2026-11-10", "npm install -g @unstale/cli@latest", false, &mut shown), vec!["unstale 0.3.2 available: npm install -g @unstale/cli@latest"]);
        assert!(due(&r, "0.3.1", "2026-11-10", "x", false, &mut shown).is_empty(), "once a day");
        assert_eq!(due(&r, "0.3.1", "2026-11-11", "x", false, &mut shown).len(), 1, "again the next day");
        for ours in ["0.3.2", "0.3.10", "1.0.0"] {
            assert!(due(&r, ours, "2026-11-12", "x", false, &mut Shown::default()).is_empty(), "{ours} is not older than 0.3.2");
        }
        assert_eq!(due(&root(Some("0.10.0"), None), "0.9.9", "2026-11-12", "x", false, &mut Shown::default()).len(), 1, "numeric, not lexical");
        assert!(due(&root(Some("next"), None), "0.3.1", "2026-11-12", "x", false, &mut Shown::default()).is_empty(), "not a version");
        assert!(due(&root(None, None), "0.3.1", "2026-11-12", "x", false, &mut Shown::default()).is_empty());
    }

    #[test]
    fn the_cached_root_and_the_state_decide() {
        let dir = tempfile::tempdir().unwrap();
        let (cache, tool) = (dir.path().join("cache"), dir.path().join("tool"));
        assert!(take(&cache, &tool, "0.3.0", "2026-11-10", "x", false).is_empty(), "no cached root");
        assert!(!shown_path(&tool).exists());
        let text = r#"{"schema":1,"min_client":"0.1.0","latest_client":"0.3.2","notice":{"id":"keys","until":"2026-11-30","text":"Run `unstale setup`."}}"#;
        util::write_atomic(&cache.join("v1/root.json"), text.as_bytes()).unwrap();
        assert_eq!(take(&cache, &tool, "0.3.0", "2026-11-10", "x", false), vec!["unstale notice: Run `unstale setup`.", "unstale 0.3.2 available: x"]);
        assert!(take(&cache, &tool, "0.3.0", "2026-11-10", "x", false).is_empty(), "the saved state holds both for the day");
        assert_eq!(take(&cache, &tool, "0.3.0", "2026-11-11", "x", false).len(), 2);
        // A root without the fields (an older catalog) prints nothing.
        util::write_atomic(&cache.join("v1/root.json"), br#"{"schema":1,"min_client":"0.1.0"}"#).unwrap();
        assert!(take(&cache, &tool, "0.3.0", "2026-11-12", "x", false).is_empty());
    }

    #[test]
    fn the_upgrade_command_follows_the_install() {
        assert_eq!(upgrade_command(Path::new("/opt/homebrew/Cellar/unstale/0.3.1/bin/unstale")), "brew upgrade unstale");
        assert_eq!(upgrade_command(Path::new("/home/linuxbrew/.linuxbrew/Cellar/unstale/0.3.1/bin/unstale")), "brew upgrade unstale");
        assert_eq!(upgrade_command(Path::new("/usr/local/lib/node_modules/@unstale/cli-darwin-arm64/bin/unstale")), "npm install -g @unstale/cli@latest");
        assert_eq!(upgrade_command(Path::new("/opt/homebrew/lib/node_modules/@unstale/cli-darwin-arm64/bin/unstale")), "npm install -g @unstale/cli@latest");
    }
}
