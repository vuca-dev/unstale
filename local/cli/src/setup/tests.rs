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
