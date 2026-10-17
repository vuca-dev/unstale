//! Remove repository integration, preserving a local backup and unrelated agent files.
use super::*;

fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(source)?;
    if meta.file_type().is_symlink() {
        #[cfg(unix)]
        std::os::unix::fs::symlink(std::fs::read_link(source)?, target)?;
        #[cfg(not(unix))]
        bail!(
            "cannot back up a symbolic link on this platform: {}",
            source.display()
        );
    } else if meta.is_dir() {
        std::fs::create_dir_all(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else if meta.is_file() {
        std::fs::copy(source, target)?;
    } else {
        bail!("cannot back up special file {}", source.display());
    }
    Ok(())
}

pub fn run(start: &Path) -> Result<u8> {
    // Stop at the nearest Git root: a nested repo must never uninstall its parent's integration.
    let mut root = None;
    for candidate in start.ancestors() {
        if candidate.join(TOOL_DIR).join("config.json").is_file() {
            root = Some(candidate.to_path_buf());
            break;
        }
        if candidate.join(".git").exists() {
            break;
        }
    }
    let Some(root) = root else {
        println!("No unstale repository installation found. The CLI remains available.");
        return Ok(0);
    };
    let tool = root.join(TOOL_DIR);
    if std::fs::symlink_metadata(&tool)?.file_type().is_symlink() {
        bail!("{} is a symbolic link; kept intact", tool.display());
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let identity = util::sha256_hex(root.to_string_lossy().as_bytes());
    let cache_root = cache::cache_dir();
    std::fs::create_dir_all(&cache_root)?;
    let backup = cache_root
        .canonicalize()?
        .join("uninstalled")
        .join(format!("{}-{timestamp}", &identity[..12]));
    if backup.starts_with(&tool) {
        bail!(
            "backup directory must be outside .unstale; set UNSTALE_CACHE_DIR to a separate directory"
        );
    }
    std::fs::create_dir_all(&backup)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&backup, std::fs::Permissions::from_mode(0o700))?;
    }
    // Everything is backed up before the first removal. A failed copy leaves the installation usable.
    copy_tree(&tool, &backup.join(TOOL_DIR))?;
    let mut owned = vec![];
    let dirs = [".agents/skills", ".claude/skills", ".cursor/skills"];
    for dir in dirs {
        if root
            .join(dir)
            .ancestors()
            .take_while(|p| *p != root)
            .any(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()))
        {
            continue;
        }
        for skill in ["upgrade-review", "improvements-pass", "onboarding"] {
            let parent = root.join(dir).join(format!("unstale-{skill}"));
            if std::fs::symlink_metadata(&parent).is_ok_and(|m| m.file_type().is_symlink()) {
                continue;
            }
            let path = parent.join("SKILL.md");
            if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            if !text.contains("<!-- Managed by unstale; regenerated from .unstale. -->") {
                continue;
            }
            let dest = backup.join(dir).join(format!("unstale-{skill}"));
            std::fs::create_dir_all(&dest)?;
            copy_tree(&path, &dest.join("SKILL.md"))?;
            owned.push(path);
            let policy = parent.join("agents/openai.yaml");
            if std::fs::read_to_string(&policy).is_ok_and(|s| {
                s == "# Managed by unstale\npolicy:\n  allow_implicit_invocation: false\n"
            }) {
                let policy_backup = dest.join("agents/openai.yaml");
                std::fs::create_dir_all(policy_backup.parent().unwrap())?;
                copy_tree(&policy, &policy_backup)?;
                owned.push(policy);
            }
        }
    }
    for path in &owned {
        std::fs::remove_file(path)?;
        // Remove only empty generated directories; preserve user-added files and runtime roots.
        let parent = path.parent().unwrap();
        let _ = std::fs::remove_dir(parent);
        if parent.file_name().is_some_and(|p| p == "agents") {
            let _ = std::fs::remove_dir(parent.parent().unwrap());
        }
    }
    // Our SessionStart hook: removed from the per-user Claude Code settings; the file goes only if nothing else is left.
    let settings_path = root.join(onboarding::SESSION_HOOK_SETTINGS_PATH);
    if !std::fs::symlink_metadata(&settings_path).is_ok_and(|m| m.file_type().is_symlink())
        && let Ok(text) = std::fs::read_to_string(&settings_path)
        && let Ok(mut settings) = serde_json::from_str::<serde_json::Value>(&text)
        && onboarding::remove_own_hooks(&mut settings)
    {
        let dest = backup.join(onboarding::SESSION_HOOK_SETTINGS_PATH);
        std::fs::create_dir_all(dest.parent().unwrap())?;
        std::fs::write(&dest, &text)?;
        if settings.as_object().is_some_and(|o| o.is_empty()) {
            std::fs::remove_file(&settings_path)?;
        } else {
            util::write_atomic(&settings_path, format!("{}\n", serde_json::to_string_pretty(&settings)?).as_bytes())?;
        }
    }
    let attrs = root.join(".gitattributes");
    remove_lines(&attrs, |line| line.trim() == GITATTR_LINE)?;
    if let Some(path) = git(&root, &["rev-parse", "--git-path", "info/exclude"]) {
        let path = PathBuf::from(path.trim());
        let path = if path.is_absolute() {
            path
        } else {
            root.join(path)
        };
        remove_lines(&path, |line| {
            line == onboarding::SESSION_HOOK_EXCLUDE_LINE || dirs.iter().any(|dir| {
                ["upgrade-review", "improvements-pass", "onboarding"]
                    .iter()
                    .any(|skill| line == format!("/{dir}/unstale-{skill}/"))
            })
        })?;
    }
    std::fs::remove_dir_all(&tool)?;
    println!(
        "Removed unstale from this repository. The CLI and shared catalog cache remain.\nLocal backup: {}\nRun unstale init to start fresh.",
        backup.display()
    );
    Ok(0)
}

fn remove_lines(path: &Path, own: impl Fn(&str) -> bool) -> Result<()> {
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Ok(());
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(());
    };
    if !text.lines().any(&own) {
        return Ok(());
    }
    let kept: String = text
        .split_inclusive('\n')
        .filter(|line| !own(line.trim_end_matches(['\r', '\n'])))
        .collect();
    if kept.is_empty() {
        std::fs::remove_file(path)?;
    } else {
        util::write_atomic(path, kept.as_bytes())?;
    }
    Ok(())
}
