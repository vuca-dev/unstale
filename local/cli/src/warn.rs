//! Warnings print when the state changes, not on every run: the warning last shown for each slot is kept in
//! `.unstale/state/warnings.json`, and the same warning is not shown again until the slot clears or its text changes.
//! `unstale status` does not go through here: it always shows the current state.

use std::collections::BTreeMap;
use std::path::Path;

fn path(tool: &Path) -> std::path::PathBuf {
    tool.join("state/warnings.json")
}

/// `now` is the slot's current warning, or `None` when all is well. Returns it when it differs from the one last
/// shown, and records it as shown; clears the slot when all is well. Best effort: when the record cannot be saved the
/// warning is still returned (said again rather than never).
pub fn changed(tool: &Path, slot: &str, now: Option<&str>) -> Option<String> {
    let p = path(tool);
    let mut shown: BTreeMap<String, String> = std::fs::read(&p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let before = shown.get(slot).cloned();
    if before.as_deref() == now {
        return None;
    }
    match now {
        Some(l) => shown.insert(slot.to_string(), l.to_string()),
        None => shown.remove(slot),
    };
    // Only inside a set-up repository: a state directory is never created for a warning.
    if tool.join("config.json").is_file()
        && let Ok(b) = serde_json::to_vec_pretty(&shown)
    {
        let _ = crate::util::write_atomic(&p, &b);
    }
    now.map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_warning_shows_when_it_changes_and_again_after_it_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path();
        std::fs::write(tool.join("config.json"), "{}").unwrap();
        assert_eq!(
            changed(tool, "a", Some("warning: x")),
            Some("warning: x".into())
        );
        assert_eq!(
            changed(tool, "a", Some("warning: x")),
            None,
            "unchanged: not again"
        );
        assert_eq!(
            changed(tool, "b", Some("warning: x")),
            Some("warning: x".into()),
            "slots are separate"
        );
        assert_eq!(
            changed(tool, "a", Some("warning: y")),
            Some("warning: y".into())
        );
        assert_eq!(changed(tool, "a", None), None);
        assert_eq!(
            changed(tool, "a", Some("warning: y")),
            Some("warning: y".into()),
            "after it cleared"
        );
    }
}
