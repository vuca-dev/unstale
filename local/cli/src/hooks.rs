//! Session-start hook entries in agents' JSON settings (Claude Code's `.claude/settings.local.json`, Codex's
//! `.codex/hooks.json`), written so that the user's file keeps its bytes.
//!
//! Install inserts one group, `{"hooks": [{"command": …, "timeout": …, "type": "command"}]}`, into
//! `hooks.SessionStart` as text, creating the containers it needs, and changes nothing else in the file; uninstall
//! removes exactly that text (and the containers it left empty), so a file goes back to the bytes it had. A file this
//! machine did not have is written whole and removed whole. Our entry is recognised only by its exact shape: a
//! command that runs an `unstale` executable (or this package through npx) with exactly our arguments, alone in its
//! group, never by a substring.
//!
//! Never written: a file Git tracks (the command names this machine's executable), a symbolic link, a file that does
//! not parse as a JSON object, a file that cannot be read for another reason than being absent, and a read-only one
//! (`Skipped`, which `unstale status` reports with the switch on).

use anyhow::Result;
use serde_json::Value;
use std::path::Path;

use crate::util;

/// Why an installer left a file alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Skipped {
    Tracked,
    Symlink,
    Unreadable,
    ReadOnly,
    NotAnObject,
}

/// How an executable path is written in a command a shell runs: in double quotes, as before, when nothing in it is
/// special inside them; otherwise in single quotes, each `'` written as `'\''`. A path holding `$`, a backtick, `"` or
/// `\` is never expanded.
pub fn sh_quote(path: &str) -> String {
    if path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || " /._-+,:@%~=".contains(c))
    {
        format!("\"{path}\"")
    } else {
        format!("'{}'", path.replace('\'', r"'\''"))
    }
}

/// The executable as a shell command word: `sh_quote`d, or this version through npx.
pub fn invocation_word() -> String {
    match crate::onboarding::invocation_argv().as_slice() {
        [path] => sh_quote(path),
        argv => argv.join(" "),
    }
}

/// Undoes `sh_quote`: the path inside a double-quoted word without specials, or a single-quoted word.
fn unquote(word: &str) -> Option<String> {
    if let Some(inner) = word.strip_prefix('"').and_then(|w| w.strip_suffix('"')) {
        return (!inner.contains(['"', '$', '`', '\\'])).then(|| inner.to_string());
    }
    let inner = word.strip_prefix('\'')?.strip_suffix('\'')?;
    let parts: Vec<&str> = inner.split(r"'\''").collect();
    parts
        .iter()
        .all(|p| !p.contains('\''))
        .then(|| parts.join("'"))
}

/// Whether `command` is one we install: an `unstale` executable (any directory; `unstale`, `unstale.exe` or
/// `unstale.cmd`) or `npx --yes @unstale/cli@<version>`, followed by exactly `args`.
pub fn own_command(command: &str, args: &str) -> bool {
    let Some(word) = command.strip_suffix(args).and_then(|w| w.strip_suffix(' ')) else {
        return false;
    };
    if let Some(version) = word.strip_prefix("npx --yes @unstale/cli@") {
        return util::parse_version(version).is_some() && !version.contains(char::is_whitespace);
    }
    let Some(path) = unquote(word) else {
        return false;
    };
    let base = path.rsplit(['/', '\\']).next().unwrap_or("");
    matches!(base, "unstale" | "unstale.exe" | "unstale.cmd")
}

/// Our group, as written.
pub fn group(command: &str, timeout: u64) -> Value {
    serde_json::json!({"hooks": [{"type": "command", "command": command, "timeout": timeout}]})
}

/// Whether a group is one of ours: exactly one command hook, our command, nothing else.
fn own_group(g: &Value, args: &str) -> bool {
    let Some(obj) = g.as_object() else {
        return false;
    };
    let Some([h]) = obj
        .get("hooks")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
    else {
        return false;
    };
    let Some(h) = h.as_object() else { return false };
    obj.len() == 1
        && h.len() == 3
        && h.get("type").and_then(Value::as_str) == Some("command")
        && h.get("timeout").is_some_and(Value::is_u64)
        && h.get("command")
            .and_then(Value::as_str)
            .is_some_and(|c| own_command(c, args))
}

// ------------------------------------------------------------------------------------------- JSON spans in text

fn ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// The end (exclusive) of the JSON value starting at `i`.
fn value_end(b: &[u8], i: usize) -> Option<usize> {
    match *b.get(i)? {
        b'"' => {
            let mut j = i + 1;
            while j < b.len() {
                match b[j] {
                    b'\\' => j += 2,
                    b'"' => return Some(j + 1),
                    _ => j += 1,
                }
            }
            None
        }
        b'{' | b'[' => {
            let close = if b[i] == b'{' { b'}' } else { b']' };
            let mut j = ws(b, i + 1);
            if b.get(j) == Some(&close) {
                return Some(j + 1);
            }
            loop {
                if b[i] == b'{' {
                    j = ws(b, value_end(b, j)?);
                    if b.get(j) != Some(&b':') {
                        return None;
                    }
                    j = ws(b, j + 1);
                }
                j = ws(b, value_end(b, j)?);
                match b.get(j)? {
                    b',' => j = ws(b, j + 1),
                    c if *c == close => return Some(j + 1),
                    _ => return None,
                }
            }
        }
        _ => {
            let mut j = i;
            while j < b.len() && !b",]} \t\r\n".contains(&b[j]) {
                j += 1;
            }
            (j > i).then_some(j)
        }
    }
}

/// An object member or array element: where it starts (the key, for a member), where its value starts and ends.
#[derive(Debug, Clone, Copy)]
struct Item {
    start: usize,
    value: usize,
    end: usize,
}

/// The members (with their keys) of the object, or the elements of the array, at `i`; and where its closing bracket is.
/// An object's members with their keys, or an array's elements (no key).
type Items = Vec<(Option<String>, Item)>;

fn items(b: &[u8], i: usize) -> Option<(Items, usize)> {
    let object = *b.get(i)? == b'{';
    let close = if object { b'}' } else { b']' };
    let mut out = vec![];
    let mut j = ws(b, i + 1);
    if b.get(j) == Some(&close) {
        return Some((out, j));
    }
    loop {
        let start = j;
        let mut key = None;
        if object {
            let k = value_end(b, j)?;
            key = Some(serde_json::from_slice::<String>(&b[j..k]).ok()?);
            j = ws(b, k);
            if b.get(j) != Some(&b':') {
                return None;
            }
            j = ws(b, j + 1);
        }
        let value = j;
        let end = value_end(b, j)?;
        out.push((key, Item { start, value, end }));
        j = ws(b, end);
        match b.get(j)? {
            b',' => j = ws(b, j + 1),
            c if *c == close => return Some((out, j)),
            _ => return None,
        }
    }
}

fn member(b: &[u8], obj: usize, name: &str) -> Option<Option<Item>> {
    let (ms, _) = items(b, obj)?;
    Some(
        ms.into_iter()
            .find(|(k, _)| k.as_deref() == Some(name))
            .map(|(_, it)| it),
    )
}

/// `text` with `insert` added as the last item of the container at `at`: after `, ` when it has items.
fn append(text: &str, at: usize, insert: &str) -> Option<String> {
    let b = text.as_bytes();
    let (its, close) = items(b, at)?;
    Some(match its.last() {
        Some((_, last)) => format!("{}, {insert}{}", &text[..last.end], &text[last.end..]),
        None => format!("{}{insert}{}", &text[..close], &text[close..]),
    })
}

/// `text` without the item `k` of the container at `at`, and the separator `append` added with it.
fn cut(text: &str, at: usize, k: usize) -> Option<String> {
    let b = text.as_bytes();
    let (its, _) = items(b, at)?;
    let (from, to) = match (k.checked_sub(1).map(|p| its[p].1), its.get(k + 1)) {
        (Some(prev), _) => (prev.end, its[k].1.end),
        (None, Some(next)) => (its[k].1.start, next.1.start),
        (None, None) => (its[k].1.start, its[k].1.end),
    };
    Some(format!("{}{}", &text[..from], &text[to..]))
}

/// The text of a file that holds only our group: what install writes when there was no file.
pub fn whole_file(group: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(&serde_json::json!({"hooks": {"SessionStart": [group]}}))
            .unwrap_or_default()
    )
}

/// `text` with our group in `hooks.SessionStart`, or `None` when its shape leaves no place for one (a `hooks` that is
/// not an object, a `SessionStart` that is not a list). `Some(text)` unchanged when our exact group is there already.
pub fn insert(text: &str, group: &Value, args: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    parsed.as_object()?;
    let entry = serde_json::to_string(group).ok()?;
    let b = text.as_bytes();
    let top = ws(b, 0);
    let Some(hooks) = member(b, top, "hooks")? else {
        return append(
            text,
            top,
            &format!("\"hooks\": {{\"SessionStart\": [{entry}]}}"),
        );
    };
    if b[hooks.value] != b'{' {
        return None;
    }
    let Some(starts) = member(b, hooks.value, "SessionStart")? else {
        return append(text, hooks.value, &format!("\"SessionStart\": [{entry}]"));
    };
    if b[starts.value] != b'[' {
        return None;
    }
    let groups = parsed
        .pointer("/hooks/SessionStart")
        .and_then(Value::as_array)?;
    if groups.iter().any(|g| g == group) {
        return Some(text.to_string());
    }
    // An older entry of ours (the executable moved): replaced, so there is one.
    match groups.iter().position(|g| own_group(g, args)) {
        Some(k) => insert(&remove_at(text, k)?, group, args),
        None => append(text, starts.value, &entry),
    }
}

/// `text` without the `k`th group of `hooks.SessionStart`, and without the containers that leaves empty.
fn remove_at(text: &str, k: usize) -> Option<String> {
    let b = text.as_bytes();
    let top = ws(b, 0);
    let hooks = member(b, top, "hooks")??;
    let starts = member(b, hooks.value, "SessionStart")??;
    let text = cut(text, starts.value, k)?;
    let b = text.as_bytes();
    let hooks = member(b, top, "hooks")??;
    let starts = member(b, hooks.value, "SessionStart")??;
    if !items(b, starts.value)?.0.is_empty() {
        return Some(text);
    }
    let (hs, _) = items(b, hooks.value)?;
    let i = hs
        .iter()
        .position(|(k, _)| k.as_deref() == Some("SessionStart"))?;
    let text = cut(&text, hooks.value, i)?;
    let b = text.as_bytes();
    let hooks = member(b, top, "hooks")??;
    if !items(b, hooks.value)?.0.is_empty() {
        return Some(text);
    }
    let (ts, _) = items(b, top)?;
    let i = ts.iter().position(|(k, _)| k.as_deref() == Some("hooks"))?;
    cut(&text, top, i)
}

/// `text` without our groups, or `None` when it has none.
pub fn remove(text: &str, args: &str) -> Option<String> {
    let mut text = text.to_string();
    let mut removed = false;
    loop {
        let parsed: Value = serde_json::from_str(&text).ok()?;
        let Some(k) = parsed
            .pointer("/hooks/SessionStart")
            .and_then(Value::as_array)
            .and_then(|gs| gs.iter().position(|g| own_group(g, args)))
        else {
            return removed.then_some(text);
        };
        text = remove_at(&text, k)?;
        removed = true;
    }
}

// ------------------------------------------------------------------------------------------------ the files

fn tracked(root: &Path, rel: &str) -> bool {
    crate::git(root, &["ls-files", "--error-unmatch", "--", rel]).is_some()
}

fn through_symlink(root: &Path, p: &Path) -> bool {
    p.ancestors()
        .take_while(|a| *a != root)
        .any(|a| std::fs::symlink_metadata(a).is_ok_and(|m| m.file_type().is_symlink()))
}

/// Why `rel` under `root` may not be written, if it may not. A missing file may be.
pub fn unwritable(root: &Path, rel: &str) -> Option<Skipped> {
    let path = root.join(rel);
    if through_symlink(root, &path) {
        return Some(Skipped::Symlink);
    }
    if tracked(root, rel) {
        return Some(Skipped::Tracked);
    }
    match std::fs::metadata(&path) {
        Ok(m) if m.permissions().readonly() => Some(Skipped::ReadOnly),
        Ok(_) => None,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => Some(Skipped::Unreadable),
    }
}

/// Writes `text` to an existing file keeping its permissions, or creates it.
fn write_keeping(path: &Path, text: &str) -> Result<()> {
    let perms = std::fs::metadata(path).ok().map(|m| m.permissions());
    util::write_atomic(path, text.as_bytes())?;
    if let Some(p) = perms {
        std::fs::set_permissions(path, p)?;
    }
    Ok(())
}

/// Installs our group in the JSON file `rel`. `Ok(Err(why))` when the file is left alone.
pub fn install(
    root: &Path,
    rel: &str,
    command: &str,
    args: &str,
    timeout: u64,
) -> Result<std::result::Result<(), Skipped>> {
    if let Some(why) = unwritable(root, rel) {
        return Ok(Err(why));
    }
    let path = root.join(rel);
    let g = group(command, timeout);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            util::write_atomic(&path, whole_file(&g).as_bytes())?;
            return Ok(Ok(()));
        }
        Err(_) => return Ok(Err(Skipped::Unreadable)),
    };
    let Some(new) = insert(&text, &g, args) else {
        return Ok(Err(Skipped::NotAnObject));
    };
    if new != text {
        write_keeping(&path, &new)?;
    }
    Ok(Ok(()))
}

/// Removes our groups from `rel`, first copying the file to `backup` (same relative path); the file goes when it is
/// exactly what install would have written there alone. True when anything was removed.
pub fn uninstall(root: &Path, rel: &str, args: &str, backup: &Path) -> Result<bool> {
    let path = root.join(rel);
    if through_symlink(root, &path) {
        return Ok(false);
    }
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(false);
    };
    let Some(new) = remove(&text, args) else {
        return Ok(false);
    };
    let dest = backup.join(rel);
    std::fs::create_dir_all(dest.parent().unwrap())?;
    std::fs::write(&dest, &text)?;
    let parsed: Value = serde_json::from_str(&text)?;
    let alone = parsed
        .pointer("/hooks/SessionStart")
        .and_then(Value::as_array)
        .is_some_and(|gs| gs.len() == 1)
        && whole_file(&parsed["hooks"]["SessionStart"][0]) == text;
    if alone {
        std::fs::remove_file(&path)?;
        let _ = std::fs::remove_dir(path.parent().unwrap());
    } else {
        write_keeping(&path, &new)?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE: &str = r#"-C "$CLAUDE_PROJECT_DIR" notify"#;

    fn ours(path: &str) -> String {
        format!("{} {CLAUDE}", sh_quote(path))
    }

    #[test]
    fn a_path_is_quoted_so_a_shell_never_expands_it() {
        assert_eq!(
            sh_quote("/usr/local/bin/unstale"),
            "\"/usr/local/bin/unstale\""
        );
        assert_eq!(sh_quote("/Users/a b/unstale"), "\"/Users/a b/unstale\"");
        for p in [
            "/tmp/$(touch pwned)/unstale",
            "/tmp/`id`/unstale",
            "/tmp/it's \"x\"/unstale",
            r"C:\bin\unstale.exe",
        ] {
            let q = sh_quote(p);
            assert!(q.starts_with('\''), "{q}");
            assert_eq!(unquote(&q).as_deref(), Some(p));
            // The shell reads it back as the same single word, unexpanded.
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(format!("printf %s {q}"))
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), p);
        }
    }

    #[test]
    fn our_entry_is_recognised_exactly_never_by_a_substring() {
        assert!(own_command(&ours("/usr/local/bin/unstale"), CLAUDE));
        assert!(own_command(&ours("/tmp/$x/unstale"), CLAUDE));
        assert!(own_command(
            &format!("npx --yes @unstale/cli@0.2.12 {CLAUDE}"),
            CLAUDE
        ));
        for user in [
            "my-unstale-wrapper notify",
            "\"/opt/unstale-tools/run\" notify",
            "unstale notify",
            "echo unstale && \"/bin/unstale\" notify",
            "\"/bin/unstale\" status; \"/bin/unstale\" notify",
            "npx --yes @unstale/cli@latest; rm -rf x notify",
        ] {
            assert!(!own_command(user, "notify"), "{user}");
        }
        // A group with something besides our hook is the user's.
        let mut g = group(&ours("/bin/unstale"), 10);
        assert!(own_group(&g, CLAUDE));
        g["hooks"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"type": "command", "command": "echo"}));
        assert!(!own_group(&g, CLAUDE));
    }

    #[test]
    fn install_adds_only_our_text_and_uninstall_takes_exactly_it_away() {
        let g = group(&ours("/bin/unstale"), 10);
        for user in [
            "{}",
            "{\n    \"zeta\": 1,\n    \"alpha\": [1, 2]\n}\n",
            "{\"permissions\":{\"allow\":[\"Bash(ls)\"]},\"hooks\":{\"Stop\":[]}}",
            "{ \"hooks\" : { \"SessionStart\" : [ { \"hooks\": [ { \"type\": \"command\", \"command\": \"echo mine\" } ] } ] } }\n",
            "{\"hooks\":{\"SessionStart\":[]}}",
        ] {
            let installed = insert(user, &g, CLAUDE).unwrap();
            // Every byte of the user's file is still there, in order.
            let mut rest = installed.as_str();
            for c in user.chars() {
                let at = rest
                    .find(c)
                    .unwrap_or_else(|| panic!("{user:?} -> {installed:?}"));
                rest = &rest[at + c.len_utf8()..];
            }
            let v: Value = serde_json::from_str(&installed).unwrap();
            assert!(
                v["hooks"]["SessionStart"].as_array().unwrap().contains(&g),
                "{installed}"
            );
            // Again: unchanged.
            assert_eq!(insert(&installed, &g, CLAUDE).unwrap(), installed);
            // Removed: the user's bytes exactly (an empty `SessionStart` they had goes with ours, as before).
            let back = remove(&installed, CLAUDE).unwrap();
            if user.contains("\"SessionStart\":[]") {
                assert_eq!(back, "{}", "{back}");
            } else {
                assert_eq!(back, user);
            }
        }
        // An older entry of ours (another path) is replaced, not repeated; a user's similar one is kept.
        let user = format!(
            "{{\"hooks\":{{\"SessionStart\":[{},{}]}}}}",
            serde_json::to_string(&group("my-unstale-wrapper notify", 5)).unwrap(),
            serde_json::to_string(&group(&ours("/old/unstale"), 10)).unwrap()
        );
        let installed = insert(&user, &g, CLAUDE).unwrap();
        let v: Value = serde_json::from_str(&installed).unwrap();
        assert_eq!(v["hooks"]["SessionStart"].as_array().unwrap().len(), 2);
        assert_eq!(
            v["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "my-unstale-wrapper notify"
        );
        // Shapes with no place for an entry are left alone.
        assert!(insert("[]", &g, CLAUDE).is_none());
        assert!(insert("{\"hooks\": 1}", &g, CLAUDE).is_none());
        assert!(insert("{\"hooks\": {\"SessionStart\": {}}}", &g, CLAUDE).is_none());
    }
}
